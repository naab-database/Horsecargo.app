-- =====================================================================
--  HORSE CARGO — SHIPMENTS MODULE v2
--  Run AFTER schema.sql, seed.sql, accounting-1-roles.sql, accounting-2.sql.
--  Idempotent: safe to run more than once.
--
--  What it does
--   1. Removes the container / consolidation module (no more loading cargo
--      into containers). Costs and profit now belong to the shipment itself.
--   2. Renames "bookings" to "shipments": one shipment = one customer's cargo.
--   3. Removes the deposit gate and the settlement gate.
--   4. New shipment numbers  HC-YYYYMMDD_NNN  (resets daily, Dubai time).
--      Existing records keep their old HC-BK-... numbers.
--   5. Sender + receiver, cargo items, weight/CBM at intake, rate override,
--      additional charges, invoice currency, and the new status flow:
--      received_dubai → packed → dispatched → in_transit → in_customs
--                     → arrived → delivered
-- =====================================================================
set client_min_messages = warning;

-- ---------------------------------------------------------------------
-- 0. DROP EVERYTHING THAT DEPENDS ON THE OLD SHAPE
-- ---------------------------------------------------------------------
drop view if exists public.v_bookings        cascade;
drop view if exists public.v_booking_money   cascade;
drop view if exists public.v_shipments       cascade;
drop view if exists public.v_receipts        cascade;
drop view if exists public.v_customers       cascade;
drop view if exists public.v_events          cascade;
drop view if exists public.v_invoice_lines   cascade;
drop view if exists public.v_releases        cascade;
drop view if exists public.v_journals        cascade;
drop view if exists public.v_journal_lines   cascade;
drop view if exists public.v_bills           cascade;
drop view if exists public.v_bill_lines      cascade;
drop view if exists public.v_bill_payments   cascade;
drop view if exists public.v_expenses        cascade;

-- container RPCs
drop function if exists public.load_booking(uuid, uuid)            cascade;
drop function if exists public.unload_booking(uuid)                cascade;
drop function if exists public.update_shipment_status(uuid, shipment_status, text) cascade;
drop function if exists public.trg_shipment_before()               cascade;

-- shipping RPCs that are rebuilt below
drop function if exists public.record_payment(uuid, numeric, text, text, text, numeric)        cascade;
drop function if exists public.record_payment(uuid, numeric, text, text, text, numeric, uuid)  cascade;
drop function if exists public.void_receipt(uuid, text)            cascade;
drop function if exists public.record_grn(uuid, jsonb, text, text, text[]) cascade;
drop function if exists public.add_invoice_line(uuid, text, text, numeric, numeric) cascade;
drop function if exists public.remove_invoice_line(bigint)         cascade;
drop function if exists public.set_booking_status(uuid, booking_status, text) cascade;
drop function if exists public.add_tracking_note(uuid, text, text, boolean) cascade;
drop function if exists public.release_booking(uuid, text, text, text, text, text, text) cascade;
drop function if exists public.cancel_booking(uuid, text)          cascade;
drop function if exists public.dashboard_stats()                   cascade;
drop function if exists public.track_shipment(text)                cascade;
drop function if exists public.add_event(uuid, booking_status, text, text, text, boolean) cascade;
drop function if exists public.trg_booking_before()                cascade;
drop function if exists public.trg_booking_after_insert()          cascade;
drop function if exists public.quote_for(text, int, numeric, numeric) cascade;

-- accounting functions that referenced containers
drop function if exists public.acc_post(text, date, text, text, text, jsonb, uuid, uuid, uuid, text) cascade;
drop function if exists public.acc_post_costs(text, date, text, text, text, jsonb, jsonb, uuid, text, numeric, text) cascade;
drop function if exists public.acc_owner_company(uuid, uuid, text) cascade;
drop function if exists public.acc_shipment_pnl(uuid)              cascade;
drop function if exists public.acc_shipments_pnl(date, date)       cascade;
drop function if exists public.acc_post_receipt(uuid)              cascade;
drop function if exists public.acc_void_receipt(uuid)              cascade;
drop function if exists public.acc_apply_deposits(uuid, uuid)      cascade;
drop function if exists public.acc_deposit_applied(uuid)           cascade;
drop function if exists public.acc_reverse(uuid, text, date)       cascade;
drop function if exists public.acc_owner_company(uuid, uuid, text)  cascade;
drop function if exists public.acc_post_invoice_line(bigint)       cascade;
drop function if exists public.acc_deposit_applied(uuid)           cascade;
drop function if exists public.acc_create_bill(jsonb)              cascade;
drop function if exists public.acc_record_expense(jsonb)           cascade;
drop function if exists public.acc_create_journal(jsonb)           cascade;
drop function if exists public.acc_dashboard(text)                 cascade;
drop function if exists public.acc_backfill()                      cascade;

-- ---------------------------------------------------------------------
-- 1. DROP THE CONTAINER TABLE, KEEPING EVERY OTHER RELATIONSHIP
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='journals' and column_name='shipment_id')
     and exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='journals' and column_name='booking_id') then
    -- container links disappear; the booking link becomes the shipment link
    alter table public.journals      drop column shipment_id;
    alter table public.journal_lines drop column shipment_id;
    alter table public.bill_lines    drop column shipment_id;
    alter table public.expenses      drop column shipment_id;
    alter table public.journals      rename column booking_id to shipment_id;
    alter table public.journal_lines rename column booking_id to shipment_id;
    alter table public.bill_lines    rename column booking_id to shipment_id;
    alter table public.expenses      rename column booking_id to shipment_id;
  end if;
end $$;

do $$
begin
  if to_regclass('public.bookings') is not null then
    alter table public.bookings drop column if exists shipment_id;
    drop table if exists public.shipments cascade;
  end if;
end $$;
drop type if exists public.shipment_status cascade;

-- ---------------------------------------------------------------------
-- 2. RENAME bookings → shipments (and every foreign key that points at it)
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.bookings') is not null then
    alter table public.bookings rename to shipments;
    alter table public.grns            rename column booking_id to shipment_id;
    alter table public.invoices        rename column booking_id to shipment_id;
    alter table public.receipts        rename column booking_id to shipment_id;
    alter table public.tracking_events rename column booking_id to shipment_id;
    alter table public.releases        rename column booking_id to shipment_id;
    alter table public.shipments rename column consignee_name    to receiver_name;
    alter table public.shipments rename column consignee_phone   to receiver_phone;
    alter table public.shipments rename column consignee_address to receiver_address;
    alter table public.shipments rename column consignee_tin     to receiver_tin;
  end if;
end $$;

-- old policies reference the status column and block the type change
drop policy if exists bookings_insert  on public.shipments;
drop policy if exists bookings_update  on public.shipments;
drop policy if exists shipments_insert on public.shipments;
drop policy if exists shipments_update on public.shipments;

-- ---------------------------------------------------------------------
-- 3. NEW STATUS FLOW
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'ship_status') then
    create type public.ship_status as enum
      ('received_dubai','packed','dispatched','in_transit','in_customs','arrived','delivered','cancelled');
  end if;
end $$;

do $$
begin
  if (select atttypid::regtype::text from pg_attribute
      where attrelid = 'public.shipments'::regclass and attname = 'status') = 'booking_status' then
    alter table public.shipments alter column status drop default;
    alter table public.tracking_events alter column status drop default;
    alter table public.tracking_events alter column status type public.ship_status using
      (case status::text
         when 'pending_deposit' then 'received_dubai' when 'booked'   then 'received_dubai'
         when 'received'        then 'received_dubai' when 'loaded'   then 'packed'
         when 'in_transit'      then 'in_transit'     when 'arrived'  then 'arrived'
         when 'clearing'        then 'in_customs'     when 'ready'    then 'arrived'
         when 'released'        then 'delivered'      when 'cancelled' then 'cancelled'
       end)::public.ship_status;
    alter table public.shipments alter column status type public.ship_status using
      (case status::text
         when 'pending_deposit' then 'received_dubai' when 'booked'   then 'received_dubai'
         when 'received'        then 'received_dubai' when 'loaded'   then 'packed'
         when 'in_transit'      then 'in_transit'     when 'arrived'  then 'arrived'
         when 'clearing'        then 'in_customs'     when 'ready'    then 'arrived'
         when 'released'        then 'delivered'      when 'cancelled' then 'cancelled'
       end)::public.ship_status;
    alter table public.shipments alter column status set default 'received_dubai';
    drop type if exists public.booking_status cascade;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. NEW COLUMNS & TABLES
-- ---------------------------------------------------------------------
alter table public.settings   add column if not exists timezone text not null default 'Asia/Dubai';
alter table public.settings   add column if not exists company_prefix text not null default 'HC';

alter table public.shipments  add column if not exists receiver_customer_id uuid references public.customers(id);
alter table public.shipments  add column if not exists receiver_email text;
alter table public.shipments  add column if not exists sender_name    text;
alter table public.shipments  add column if not exists sender_phone   text;
alter table public.shipments  add column if not exists sender_email   text;
alter table public.shipments  add column if not exists sender_address text;
alter table public.shipments  add column if not exists weight_kg      numeric;      -- air: declared total weight
alter table public.shipments  add column if not exists rate_used      numeric;      -- USD per kg / per CBM actually charged
alter table public.shipments  add column if not exists rate_source    text;         -- category | override
alter table public.shipments  add column if not exists rate_note      text;
alter table public.shipments  add column if not exists delivered_at   timestamptz;

update public.shipments s set sender_name = c.name, sender_phone = c.phone,
       sender_email = c.email, sender_address = c.address
  from public.customers c where c.id = s.customer_id and s.sender_name is null;

alter table public.invoices   add column if not exists fx_rate  numeric not null default 1;
alter table public.invoices   add column if not exists fx_date  date;
alter table public.invoice_lines add column if not exists charge_type text;
update public.invoice_lines set charge_type = kind where charge_type is null;

alter table public.tracking_events add column if not exists prev_status public.ship_status;

create table if not exists public.shipment_items (
  id          bigserial primary key,
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  description text not null,
  category_id int references public.cargo_categories(id),
  qty         numeric not null default 1 check (qty > 0),
  unit        text not null default 'PCS',
  created_at  timestamptz not null default now()
);
create index if not exists shipment_items_idx on public.shipment_items(shipment_id);

-- one item row for every legacy record, so old shipments show cargo too
insert into public.shipment_items(shipment_id, description, category_id, qty, unit)
select s.id, s.description, s.category_id, greatest(coalesce(s.pieces, s.est_pieces, 1), 1), 'PCS'
from public.shipments s
where not exists (select 1 from public.shipment_items i where i.shipment_id = s.id);

create index if not exists shipments_status_idx2 on public.shipments(status);
create index if not exists shipments_created_idx on public.shipments(created_at desc);

-- ---------------------------------------------------------------------
-- 5. HELPERS: date, numbering, events, phone normalisation, customers
-- ---------------------------------------------------------------------
create or replace function public.hc_tz() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select timezone from public.settings where id = 1), 'Asia/Dubai')
$$;

create or replace function public.hc_today() returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone public.hc_tz())::date
$$;

-- HC-YYYYMMDD_NNN — NNN restarts every day, never reuses a number
create or replace function public.next_shipment_ref() returns text
language plpgsql security definer set search_path = public as $$
declare d text; pfx text;
begin
  d   := to_char(public.hc_today(), 'YYYYMMDD');
  pfx := coalesce((select company_prefix from public.settings where id = 1), 'HC');
  return pfx || '-' || d || '_' || lpad(public.next_counter('SHP-' || d)::text, 3, '0');
end $$;

create or replace function public.add_event(p_shipment uuid, p_status public.ship_status, p_title text,
                                            p_note text default null, p_location text default null,
                                            p_public boolean default true, p_prev public.ship_status default null)
returns void language sql security definer set search_path = public as $$
  insert into public.tracking_events(shipment_id, status, prev_status, title, note, location, is_public, created_by)
  values (p_shipment, p_status, p_prev, p_title, p_note, p_location, p_public, auth.uid())
$$;

-- +255 / +971 aware; keeps anything already in international form
create or replace function public.norm_phone(p_phone text, p_country text default null) returns text
language plpgsql immutable as $$
declare d text; cc text;
begin
  if coalesce(trim(p_phone), '') = '' then return null; end if;
  d := regexp_replace(p_phone, '[^0-9+]', '', 'g');
  if left(d, 2) = '00' then d := '+' || substr(d, 3); end if;
  if left(d, 1) = '+' then return d; end if;
  cc := case when upper(coalesce(p_country, '')) in ('AE','UAE','DUBAI') then '971'
             when upper(coalesce(p_country, '')) in ('TZ','TANZANIA')    then '255' else null end;
  if left(d, 3) = '255' and length(d) >= 12 then return '+' || d; end if;
  if left(d, 3) = '971' and length(d) >= 12 then return '+' || d; end if;
  if left(d, 1) = '0' then
    -- decide by the national prefix first: TZ mobiles are 06x/07x, UAE mobiles 05x
    if substr(d, 2, 1) in ('6','7') then return '+255' || substr(d, 2); end if;
    if substr(d, 2, 1) = '5'         then return '+971' || substr(d, 2); end if;
    if substr(d, 2, 2) = '22' or substr(d, 2, 2) = '24' or substr(d, 2, 2) = '25'
       or substr(d, 2, 2) = '26' or substr(d, 2, 2) = '27' or substr(d, 2, 2) = '28' then return '+255' || substr(d, 2); end if;
    if cc is not null then return '+' || cc || substr(d, 2); end if;
    return '+971' || substr(d, 2);
  end if;
  if cc is not null then return '+' || cc || d; end if;
  return d;
end $$;

create or replace function public.trg_customer_norm() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.phone := coalesce(public.norm_phone(new.phone, new.country), new.phone);
  return new;
end $$;
drop trigger if exists customer_norm on public.customers;
create trigger customer_norm before insert or update on public.customers
for each row execute function public.trg_customer_norm();

-- find an existing customer, or create one. Never creates a duplicate on the same phone.
create or replace function public.resolve_customer(p jsonb, p_branch text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; ph text; nm text; ctry text;
begin
  v_id := nullif(p->>'customer_id','')::uuid;
  if v_id is not null then return v_id; end if;
  nm   := nullif(trim(p->>'name'), '');
  ctry := case when p_branch = 'DXB' then 'AE' else 'TZ' end;
  ph   := public.norm_phone(p->>'phone', ctry);
  if nm is null then raise exception 'REFUSED: name is required'; end if;
  if ph is null then raise exception 'REFUSED: phone number is required for %', nm; end if;
  select id into v_id from public.customers where phone = ph order by created_at limit 1;
  if v_id is not null then
    update public.customers
       set email   = coalesce(nullif(p->>'email',''), email),
           address = coalesce(nullif(p->>'address',''), address),
           tin     = coalesce(nullif(p->>'tin',''), tin)
     where id = v_id;
    return v_id;
  end if;
  insert into public.customers(name, phone, email, address, tin, country, branch_code, created_by)
  values (nm, ph, nullif(p->>'email',''), nullif(p->>'address',''), nullif(p->>'tin',''),
          case when ctry = 'AE' then 'UAE' else 'Tanzania' end, p_branch, auth.uid())
  returning id into v_id;
  perform public.log_audit('customer.auto_create', 'customer', v_id::text, jsonb_build_object('name', nm, 'phone', ph));
  return v_id;
end $$;

-- customer picker for the shipment wizard
create or replace function public.search_customers(p_q text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare res jsonb; q text;
begin
  if not public.is_staff() then raise exception 'NOT_ALLOWED: your role cannot perform this action'; end if;
  q := '%' || lower(trim(coalesce(p_q, ''))) || '%';
  select coalesce(jsonb_agg(x order by x.name), '[]') into res from (
    select c.id, c.code, c.name, c.phone, c.email, c.address, c.company, c.tin
    from public.customers c
    where c.active and (lower(c.name) like q or lower(coalesce(c.company,'')) like q
                        or lower(coalesce(c.email,'')) like q or lower(c.code) like q
                        or (regexp_replace(coalesce(p_q,''), '[^0-9]', '', 'g') <> ''
                            and regexp_replace(c.phone, '[^0-9]', '', 'g')
                                like '%' || regexp_replace(coalesce(p_q,''), '[^0-9]', '', 'g') || '%'))
    limit 20) x;
  return res;
end $$;

-- ---------------------------------------------------------------------
-- 6. PRICING
-- ---------------------------------------------------------------------
-- company rate for a cargo category, in USD per CBM (sea) or per kg (air)
create or replace function public.rate_for(p_mode text, p_category int) returns numeric
language sql stable security definer set search_path = public as $$
  select case when p_mode = 'sea' then c.sea_rate_cbm else c.air_rate_kg end
  from public.cargo_categories c where c.id = p_category
$$;

-- chargeable quantity: CBM for sea, chargeable kg for air (volumetric aware)
create or replace function public.charge_qty(p_mode text, p_cbm numeric, p_kg numeric) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare s public.settings; vol numeric;
begin
  select * into s from public.settings where id = 1;
  if p_mode = 'sea' then
    return round(greatest(coalesce(p_cbm, 0), s.min_cbm_sea), 3);
  end if;
  vol := round(coalesce(p_cbm, 0) * 1000000 / s.air_volumetric_divisor, 1);
  return round(greatest(coalesce(p_kg, 0), vol), 1);
end $$;

create or replace function public.freight_for(p_mode text, p_category int, p_qty numeric, p_rate numeric)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare c public.cargo_categories; amt numeric;
begin
  select * into c from public.cargo_categories where id = p_category;
  amt := round(coalesce(p_qty, 0) * coalesce(p_rate, 0), 2);
  if p_mode = 'sea' then return greatest(amt, coalesce(c.min_charge_sea, 0));
  else return greatest(amt, coalesce(c.min_charge_air, 0)); end if;
end $$;

-- ---------------------------------------------------------------------
-- 7. SHIPMENT NUMBER & GUARD TRIGGER
-- ---------------------------------------------------------------------
create or replace function public.trg_shipment_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not public.in_rpc() then
      new.status := 'received_dubai';
      new.pieces := null; new.cbm := null; new.actual_kg := null;
      new.volumetric_kg := null; new.chargeable_kg := null;
    end if;
    new.ref := public.next_shipment_ref();          -- always server-side, never from the client
    new.created_by := coalesce(new.created_by, auth.uid());
  else
    if not public.in_rpc() then
      new.ref := old.ref; new.status := old.status; new.created_by := old.created_by;
      new.cancelled_reason := old.cancelled_reason;
      new.quoted_amount := old.quoted_amount; new.rate_used := old.rate_used;
      new.pieces := old.pieces; new.cbm := old.cbm; new.actual_kg := old.actual_kg;
      new.volumetric_kg := old.volumetric_kg; new.chargeable_kg := old.chargeable_kg;
    end if;
    new.ref := old.ref;                              -- the number never changes, not even inside an RPC
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists booking_before on public.shipments;
drop trigger if exists shipment_before on public.shipments;
create trigger shipment_before before insert or update on public.shipments
for each row execute function public.trg_shipment_before();
drop trigger if exists booking_after_insert on public.shipments;

-- ---------------------------------------------------------------------
-- 8. VIEWS
-- ---------------------------------------------------------------------
create or replace view public.v_shipment_money with (security_invoker = true) as
select s.id as shipment_id,
       coalesce((select i.total from public.invoices i where i.shipment_id = s.id and i.status = 'issued'), 0) as invoice_total,
       coalesce((select sum(case when r.kind = 'refund' then -r.amount_usd else r.amount_usd end)
                 from public.receipts r where r.shipment_id = s.id and not r.void), 0) as paid_usd
from public.shipments s;

create or replace view public.v_shipments with (security_invoker = true) as
select s.*,
       c.code as customer_code, c.name as customer_name, c.phone as customer_phone, c.company as customer_company,
       rc.name as receiver_customer_name,
       cat.name as category_name, cat.name_sw as category_name_sw,
       i.ref as invoice_ref, i.id as invoice_id, i.currency as invoice_currency, i.fx_rate as invoice_fx,
       m.invoice_total, m.paid_usd,
       round(m.invoice_total - m.paid_usd, 2) as balance_usd,
       case when m.invoice_total <= 0 then 'none'
            when m.paid_usd + 0.009 >= m.invoice_total then 'paid'
            when m.paid_usd > 0 then 'part_paid' else 'unpaid' end as payment_status,
       (select count(*) from public.shipment_items it where it.shipment_id = s.id) as item_count,
       (select coalesce(sum(it.qty), 0) from public.shipment_items it where it.shipment_id = s.id) as item_qty,
       (select g.ref from public.grns g where g.shipment_id = s.id) as grn_ref,
       (select g.id  from public.grns g where g.shipment_id = s.id) as grn_id
from public.shipments s
join public.customers c on c.id = s.customer_id
left join public.customers rc on rc.id = s.receiver_customer_id
left join public.cargo_categories cat on cat.id = s.category_id
left join public.invoices i on i.shipment_id = s.id and i.status = 'issued'
join public.v_shipment_money m on m.shipment_id = s.id;

create or replace view public.v_shipment_items with (security_invoker = true) as
select it.*, cat.name as category_name, cat.name_sw as category_name_sw
from public.shipment_items it left join public.cargo_categories cat on cat.id = it.category_id;

create or replace view public.v_receipts with (security_invoker = true) as
select r.*, s.ref as shipment_ref, c.name as customer_name, c.code as customer_code,
       p.full_name as received_by_name
from public.receipts r
join public.shipments s on s.id = r.shipment_id
join public.customers c on c.id = r.customer_id
left join public.profiles p on p.id = r.received_by;

create or replace view public.v_customers with (security_invoker = true) as
select c.*,
       (select count(*) from public.shipments s where s.customer_id = c.id or s.receiver_customer_id = c.id) as shipment_count,
       (select coalesce(sum(vs.balance_usd),0) from public.v_shipments vs
         where vs.customer_id = c.id and vs.status <> 'cancelled') as balance_usd
from public.customers c;

create or replace view public.v_events with (security_invoker = true) as
select e.*, s.ref as shipment_ref, p.full_name as created_by_name
from public.tracking_events e
join public.shipments s on s.id = e.shipment_id
left join public.profiles p on p.id = e.created_by;

create or replace view public.v_invoice_lines with (security_invoker = true) as
select l.*, i.ref as invoice_ref, i.issued_at, i.status as invoice_status, i.shipment_id, i.currency, i.fx_rate,
       s.ref as shipment_ref, s.mode, s.origin_branch, s.destination_branch, c.name as customer_name,
       p.full_name as created_by_name
from public.invoice_lines l
join public.invoices i on i.id = l.invoice_id
join public.shipments s on s.id = i.shipment_id
join public.customers c on c.id = i.customer_id
left join public.profiles p on p.id = l.created_by;

create or replace view public.v_releases with (security_invoker = true) as
select r.*, p.full_name as released_by_name, s.ref as shipment_ref
from public.releases r
left join public.profiles p on p.id = r.released_by
join public.shipments s on s.id = r.shipment_id;

-- ---------------------------------------------------------------------
-- 9. CREATE / EDIT SHIPMENT
-- ---------------------------------------------------------------------
create or replace function public.shipment_invoice(p_shipment uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.invoices where shipment_id = p_shipment and status = 'issued'
$$;

create or replace function public.fx_for(p_currency text, p_rate numeric default null) returns numeric
language sql stable security definer set search_path = public as $$
  select case p_currency when 'USD' then 1
                         when 'AED' then coalesce(nullif(p_rate, 0), (select fx_aed from public.settings where id = 1))
                         when 'TZS' then coalesce(nullif(p_rate, 0), (select fx_tzs from public.settings where id = 1))
                         else 1 end
$$;

-- writes the freight line of a shipment: removes the old one (reversing its
-- ledger posting) and writes a fresh one, so revisions stay auditable
create or replace function public.write_freight_line(p_shipment uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare s public.shipments; inv uuid; qty numeric; amt numeric; txt text; unit text;
begin
  select * into s from public.shipments where id = p_shipment;
  inv := public.shipment_invoice(p_shipment);
  if inv is null then return 0; end if;
  qty  := public.charge_qty(s.mode, s.cbm, coalesce(s.weight_kg, s.actual_kg));
  amt  := public.freight_for(s.mode, s.category_id, qty, s.rate_used);
  unit := case when s.mode = 'sea' then 'CBM' else 'kg' end;
  txt  := initcap(s.mode) || ' freight ' || s.origin_branch || '→' || s.destination_branch ||
          ' · ' || qty || ' ' || unit || ' × USD ' || coalesce(s.rate_used, 0);
  if amt > round(qty * coalesce(s.rate_used,0), 2) then txt := txt || ' (minimum charge)'; end if;
  delete from public.invoice_lines where invoice_id = inv and kind = 'freight';
  insert into public.invoice_lines(invoice_id, kind, charge_type, description, qty, unit_price, amount, created_by)
  values (inv, 'freight', 'freight', txt, qty, coalesce(s.rate_used, 0), amt, auth.uid());
  update public.shipments set quoted_amount = amt, chargeable_kg = case when s.mode = 'air' then qty else s.chargeable_kg end
   where id = p_shipment;
  perform public.recalc_invoice(inv);
  return amt;
end $$;

create or replace function public.create_shipment(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s_id uuid; v_ref text; inv_id uuid; inv_ref text; it jsonb; ch jsonb;
        v_mode text; orig text; dest text; cat int; v_cbm numeric; v_kg numeric;
        base numeric; rate numeric; src text; qty numeric; freight numeric;
        sender uuid; receiver uuid; cur text; fx numeric; n int := 0; desc_txt text;
begin
  perform public.require_role('manager','counter','operations','warehouse');
  perform public.rpc_mode();

  v_mode := lower(coalesce(p->>'mode',''));
  if v_mode not in ('sea','air') then raise exception 'REFUSED: choose Sea or Air cargo'; end if;
  orig := coalesce(nullif(p->>'origin_branch',''), 'DXB');
  dest := nullif(p->>'destination_branch','');
  if dest is null then raise exception 'REFUSED: choose the destination'; end if;
  if orig = dest then raise exception 'REFUSED: origin and destination must differ'; end if;
  if not exists (select 1 from public.branches where code = orig and active) or
     not exists (select 1 from public.branches where code = dest and active) then
    raise exception 'REFUSED: unknown branch';
  end if;
  if p->'items' is null or jsonb_array_length(p->'items') = 0 then
    raise exception 'REFUSED: add at least one cargo item';
  end if;

  cat   := coalesce(nullif(p->>'category_id','')::int, (p->'items'->0->>'category_id')::int);
  v_cbm := nullif(p->>'cbm','')::numeric;
  v_kg  := nullif(p->>'weight_kg','')::numeric;
  if v_mode = 'sea' and coalesce(v_cbm, 0) <= 0 then raise exception 'REFUSED: enter the volume in CBM'; end if;
  if v_mode = 'air' and coalesce(v_kg, 0) <= 0 then raise exception 'REFUSED: enter the weight in kg'; end if;

  base := public.rate_for(v_mode, cat);
  rate := nullif(p->>'rate','')::numeric;
  if rate is null or rate = base then
    rate := base; src := 'category';
  else
    if not public.has_role('manager') then raise exception 'NOT_ALLOWED: only a manager can change the rate'; end if;
    src := 'override';
  end if;
  qty     := public.charge_qty(v_mode, v_cbm, v_kg);
  freight := public.freight_for(v_mode, cat, qty, rate);

  sender   := public.resolve_customer(coalesce(p->'sender',   '{}'::jsonb), orig);
  receiver := public.resolve_customer(coalesce(p->'receiver', '{}'::jsonb), dest);

  select string_agg(x.d, ', ') into desc_txt from (
    select coalesce(nullif(trim(e->>'description'),''), 'Cargo') as d
    from jsonb_array_elements(p->'items') e limit 4) x;

  insert into public.shipments(customer_id, receiver_customer_id, mode, origin_branch, destination_branch,
        category_id, description, est_pieces, est_cbm, est_kg, quoted_amount, deposit_required,
        sender_name, sender_phone, sender_email, sender_address,
        receiver_name, receiver_phone, receiver_email, receiver_address, receiver_tin,
        status, cbm, weight_kg, actual_kg, chargeable_kg, pieces, rate_used, rate_source, rate_note, notes, created_by)
  values (sender, receiver, v_mode, orig, dest,
        cat, coalesce(desc_txt, 'Cargo'),
        greatest(coalesce((select sum(coalesce((e->>'qty')::numeric,1))::int from jsonb_array_elements(p->'items') e), 1), 1),
        coalesce(v_cbm, 0), coalesce(v_kg, 0), freight, 0,
        (select name from public.customers where id = sender), (select phone from public.customers where id = sender),
        (select email from public.customers where id = sender), (select address from public.customers where id = sender),
        (select name from public.customers where id = receiver), (select phone from public.customers where id = receiver),
        (select email from public.customers where id = receiver), (select address from public.customers where id = receiver),
        nullif(p->'receiver'->>'tin',''),
        'received_dubai', v_cbm, v_kg, v_kg,
        case when v_mode = 'air' then qty else null end,
        (select coalesce(sum(coalesce((e->>'qty')::numeric,1))::int,1) from jsonb_array_elements(p->'items') e),
        rate, src, nullif(p->>'rate_note',''), nullif(p->>'notes',''), auth.uid())
  returning id, ref into s_id, v_ref;

  for it in select * from jsonb_array_elements(p->'items') loop
    insert into public.shipment_items(shipment_id, description, category_id, qty, unit)
    values (s_id, coalesce(nullif(trim(it->>'description'),''), 'Cargo'), nullif(it->>'category_id','')::int,
            greatest(coalesce((it->>'qty')::numeric, 1), 0.001), coalesce(nullif(it->>'unit',''), 'PCS'));
    n := n + 1;
  end loop;

  cur := coalesce(nullif(p->>'currency',''), 'USD');
  if cur not in ('USD','AED','TZS') then raise exception 'REFUSED: unsupported currency'; end if;
  fx  := public.fx_for(cur, nullif(p->>'fx_rate','')::numeric);

  inv_ref := 'HC-INV-' || public.yymm() || '-' || lpad(public.next_counter('INV-' || public.yymm())::text, 4, '0');
  insert into public.invoices(ref, shipment_id, customer_id, currency, fx_rate, fx_date, total, created_by)
  values (inv_ref, s_id, sender, cur, fx, public.hc_today(), freight, auth.uid()) returning id into inv_id;

  perform public.write_freight_line(s_id);

  for ch in select * from jsonb_array_elements(coalesce(p->'charges', '[]'::jsonb)) loop
    if coalesce((ch->>'amount')::numeric, 0) <> 0 then
      insert into public.invoice_lines(invoice_id, kind, charge_type, description, qty, unit_price, amount, created_by)
      values (inv_id, case when (ch->>'charge_type') = 'duty' then 'duty' else 'extra' end,
              coalesce(nullif(ch->>'charge_type',''), 'other'),
              coalesce(nullif(ch->>'description',''), initcap(coalesce(ch->>'charge_type','charge'))),
              1, (ch->>'amount')::numeric, round((ch->>'amount')::numeric, 2), auth.uid());
    end if;
  end loop;
  perform public.recalc_invoice(inv_id);

  perform public.add_event(s_id, 'received_dubai', 'Received at Dubai office',
          n || ' item(s) · ' || case when v_mode = 'sea' then coalesce(v_cbm,0) || ' CBM' else coalesce(v_kg,0) || ' kg' end, orig);
  perform public.log_audit('shipment.create', 'shipment', s_id::text,
          jsonb_build_object('ref', v_ref, 'mode', v_mode, 'freight', freight, 'invoice', inv_ref));

  return jsonb_build_object('id', s_id, 'ref', v_ref, 'invoice_id', inv_id, 'invoice_ref', inv_ref,
                            'freight', freight, 'qty', qty, 'rate', rate,
                            'total', (select total from public.invoices where id = inv_id));
end $$;

create or replace function public.update_shipment(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.shipments; s_id uuid; it jsonb; v_mode text; cat int; v_cbm numeric; v_kg numeric;
        base numeric; rate numeric; src text; inv uuid; dest text; sender uuid; receiver uuid; changed jsonb;
begin
  perform public.require_role('manager','counter','operations');
  perform public.rpc_mode();
  s_id := (p->>'id')::uuid;
  select * into s from public.shipments where id = s_id for update;
  if s.id is null then raise exception 'NOT_FOUND: shipment'; end if;
  if s.status = 'cancelled' then raise exception 'REFUSED: shipment is cancelled'; end if;

  v_mode := lower(coalesce(nullif(p->>'mode',''), s.mode));
  dest   := coalesce(nullif(p->>'destination_branch',''), s.destination_branch);
  cat    := coalesce(nullif(p->>'category_id','')::int, s.category_id);
  v_cbm  := coalesce(nullif(p->>'cbm','')::numeric, s.cbm);
  v_kg   := coalesce(nullif(p->>'weight_kg','')::numeric, s.weight_kg);
  if v_mode = 'sea' and coalesce(v_cbm,0) <= 0 then raise exception 'REFUSED: enter the volume in CBM'; end if;
  if v_mode = 'air' and coalesce(v_kg,0)  <= 0 then raise exception 'REFUSED: enter the weight in kg'; end if;

  base := public.rate_for(v_mode, cat);
  rate := coalesce(nullif(p->>'rate','')::numeric, s.rate_used, base);
  if rate <> base then
    if not public.has_role('manager') then raise exception 'NOT_ALLOWED: only a manager can change the rate'; end if;
    src := 'override';
  else src := 'category'; end if;

  sender   := case when p->'sender'   is null then s.customer_id
                   else public.resolve_customer(p->'sender', s.origin_branch) end;
  receiver := case when p->'receiver' is null then s.receiver_customer_id
                   else public.resolve_customer(p->'receiver', dest) end;

  update public.shipments set
    mode = v_mode, destination_branch = dest, category_id = cat,
    cbm = v_cbm, weight_kg = v_kg, actual_kg = coalesce(v_kg, actual_kg),
    rate_used = rate, rate_source = src, rate_note = coalesce(nullif(p->>'rate_note',''), rate_note),
    customer_id = sender, receiver_customer_id = receiver,
    sender_name    = coalesce(nullif(p->'sender'->>'name',''),      sender_name),
    sender_phone   = coalesce(nullif(p->'sender'->>'phone',''),     sender_phone),
    sender_email   = coalesce(nullif(p->'sender'->>'email',''),     sender_email),
    sender_address = coalesce(nullif(p->'sender'->>'address',''),   sender_address),
    receiver_name    = coalesce(nullif(p->'receiver'->>'name',''),    receiver_name),
    receiver_phone   = coalesce(nullif(p->'receiver'->>'phone',''),   receiver_phone),
    receiver_email   = coalesce(nullif(p->'receiver'->>'email',''),   receiver_email),
    receiver_address = coalesce(nullif(p->'receiver'->>'address',''), receiver_address),
    receiver_tin     = coalesce(nullif(p->'receiver'->>'tin',''),     receiver_tin),
    notes = coalesce(nullif(p->>'notes',''), notes)
  where id = s_id;

  if p->'items' is not null and jsonb_array_length(p->'items') > 0 then
    delete from public.shipment_items where shipment_id = s_id;
    for it in select * from jsonb_array_elements(p->'items') loop
      insert into public.shipment_items(shipment_id, description, category_id, qty, unit)
      values (s_id, coalesce(nullif(trim(it->>'description'),''), 'Cargo'), nullif(it->>'category_id','')::int,
              greatest(coalesce((it->>'qty')::numeric, 1), 0.001), coalesce(nullif(it->>'unit',''), 'PCS'));
    end loop;
    update public.shipments set
      pieces = (select coalesce(sum(qty)::int, 1) from public.shipment_items where shipment_id = s_id),
      description = coalesce((select string_agg(description, ', ') from
                    (select description from public.shipment_items where shipment_id = s_id limit 4) q), description)
    where id = s_id;
  end if;

  inv := public.shipment_invoice(s_id);
  if inv is not null then perform public.write_freight_line(s_id); end if;

  changed := jsonb_build_object('mode', v_mode, 'destination', dest, 'cbm', v_cbm, 'kg', v_kg, 'rate', rate);
  perform public.log_audit('shipment.update', 'shipment', s_id::text, changed);
  perform public.add_event(s_id, null, 'Shipment updated',
          nullif(p->>'edit_reason',''), null, false);
  return jsonb_build_object('id', s_id, 'ref', s.ref, 'total', (select total from public.invoices where id = inv));
end $$;

-- ---------------------------------------------------------------------
-- 10. STATUS, CHARGES, CURRENCY
-- ---------------------------------------------------------------------
create or replace function public.status_label(p_status public.ship_status, p_dest text default null) returns text
language sql immutable as $$
  select case p_status
    when 'received_dubai' then 'Received at Dubai office'
    when 'packed'         then 'Packed for dispatch'
    when 'dispatched'     then 'Dispatched from Dubai'
    when 'in_transit'     then 'On transit to Tanzania'
    when 'in_customs'     then 'In customs'
    when 'arrived'        then 'Arrived at ' || coalesce(case p_dest when 'DAR' then 'Dar es Salaam' when 'MWZ' then 'Mwanza' else p_dest end, 'Tanzania') || ' office'
    when 'delivered'      then 'Delivered'
    when 'cancelled'      then 'Cancelled'
  end
$$;

create or replace function public.set_shipment_status(p_shipment uuid, p_status public.ship_status,
                                                      p_note text default null, p_public boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare s public.shipments;
begin
  perform public.require_role('operations','manager','warehouse','counter','release_officer');
  perform public.rpc_mode();
  select * into s from public.shipments where id = p_shipment for update;
  if s.id is null then raise exception 'NOT_FOUND: shipment'; end if;
  if s.status = 'cancelled' then raise exception 'REFUSED: shipment is cancelled'; end if;
  if p_status = 'cancelled' then raise exception 'REFUSED: use cancel_shipment'; end if;
  if s.status = p_status then raise exception 'REFUSED: the shipment is already %', public.status_label(p_status, s.destination_branch); end if;
  if p_status = 'delivered' and s.status <> 'delivered' and not exists (select 1 from public.releases r where r.shipment_id = s.id) then
    raise exception 'REFUSED: record the handover (Deliver cargo) instead';
  end if;

  update public.shipments set status = p_status,
         delivered_at = case when p_status = 'delivered' then now() else delivered_at end
   where id = s.id;
  perform public.add_event(s.id, p_status, public.status_label(p_status, s.destination_branch), p_note,
          case when p_status in ('received_dubai','packed','dispatched') then s.origin_branch else s.destination_branch end,
          coalesce(p_public, true), s.status);
  perform public.log_audit('shipment.status', 'shipment', s.id::text,
          jsonb_build_object('ref', s.ref, 'from', s.status, 'to', p_status, 'note', p_note));
end $$;

create or replace function public.add_charge(p_shipment uuid, p_charge_type text, p_description text,
                                             p_qty numeric default 1, p_unit_price numeric default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.shipments; inv public.invoices; amt numeric; v_id bigint; v_kind text;
begin
  perform public.require_role('manager','counter','operations');
  perform public.rpc_mode();
  if coalesce(p_charge_type,'') not in ('packing','handling','storage','delivery','duty','discount','other') then
    raise exception 'REFUSED: unknown charge type';
  end if;
  if p_charge_type = 'discount' and not public.has_role('manager') then
    raise exception 'NOT_ALLOWED: only a manager can give a discount';
  end if;
  select * into s from public.shipments where id = p_shipment;
  if s.id is null then raise exception 'NOT_FOUND: shipment'; end if;
  if s.status = 'cancelled' then raise exception 'REFUSED: shipment is cancelled'; end if;
  select * into inv from public.invoices where shipment_id = p_shipment and status = 'issued';
  if inv.id is null then raise exception 'REFUSED: this shipment has no invoice'; end if;
  v_kind := case p_charge_type when 'duty' then 'duty' when 'discount' then 'discount' else 'extra' end;
  amt := round(coalesce(p_qty,1) * coalesce(p_unit_price,0), 2);
  if v_kind = 'discount' then amt := -abs(amt); end if;
  insert into public.invoice_lines(invoice_id, kind, charge_type, description, qty, unit_price, amount, created_by)
  values (inv.id, v_kind, p_charge_type, coalesce(nullif(trim(p_description),''), initcap(p_charge_type)),
          coalesce(p_qty,1), coalesce(p_unit_price,0), amt, auth.uid())
  returning id into v_id;
  perform public.recalc_invoice(inv.id);
  perform public.log_audit('charge.add', 'shipment', s.id::text,
          jsonb_build_object('ref', s.ref, 'type', p_charge_type, 'amount', amt, 'description', p_description));
  return jsonb_build_object('line_id', v_id, 'amount', amt,
                            'total', (select total from public.invoices where id = inv.id));
end $$;

create or replace function public.remove_charge(p_line bigint, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare l public.invoice_lines; inv public.invoices; s public.shipments;
begin
  perform public.require_role('manager');
  perform public.rpc_mode();
  select * into l from public.invoice_lines where id = p_line;
  if l.id is null then raise exception 'NOT_FOUND: charge'; end if;
  if l.kind = 'freight' then raise exception 'REFUSED: the freight line follows the shipment — edit the shipment instead'; end if;
  select * into inv from public.invoices where id = l.invoice_id;
  select * into s   from public.shipments where id = inv.shipment_id;
  delete from public.invoice_lines where id = p_line;
  perform public.recalc_invoice(inv.id);
  perform public.log_audit('charge.remove', 'shipment', s.id::text,
          jsonb_build_object('ref', s.ref, 'line', to_jsonb(l), 'reason', p_reason));
end $$;

-- keep add_invoice_line as a thin alias so older screens keep working
create or replace function public.add_invoice_line(p_booking uuid, p_kind text, p_description text,
                                                   p_qty numeric, p_unit_price numeric)
returns jsonb language sql security definer set search_path = public as $$
  select public.add_charge(p_booking, case p_kind when 'extra' then 'other' else p_kind end,
                           p_description, p_qty, p_unit_price)
$$;

create or replace function public.set_invoice_currency(p_shipment uuid, p_currency text, p_fx_rate numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invoices; fx numeric;
begin
  perform public.require_role('manager','cashier','counter');
  perform public.rpc_mode();
  if p_currency not in ('USD','AED','TZS') then raise exception 'REFUSED: unsupported currency'; end if;
  select * into inv from public.invoices where shipment_id = p_shipment and status = 'issued';
  if inv.id is null then raise exception 'NOT_FOUND: invoice'; end if;
  fx := public.fx_for(p_currency, p_fx_rate);
  update public.invoices set currency = p_currency, fx_rate = fx, fx_date = public.hc_today() where id = inv.id;
  perform public.log_audit('invoice.currency', 'invoice', inv.id::text,
          jsonb_build_object('ref', inv.ref, 'currency', p_currency, 'fx', fx));
  return jsonb_build_object('currency', p_currency, 'fx_rate', fx, 'total_txn', round(inv.total * fx, 2));
end $$;

-- ---------------------------------------------------------------------
-- 11. PAYMENTS, GRN, DELIVERY, CANCELLATION
-- ---------------------------------------------------------------------
create or replace function public.record_payment(
  p_shipment uuid, p_amount numeric, p_currency text, p_method text,
  p_reference text default null, p_fx_rate numeric default null, p_account uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.shipments; me public.profiles; rate numeric; usd numeric; v_ref text; v_id uuid; v_kind text;
begin
  perform public.require_role('cashier','manager','counter');
  perform public.rpc_mode();
  select * into me from public.profiles where id = auth.uid();
  select * into s  from public.shipments where id = p_shipment for update;
  if s.id is null then raise exception 'NOT_FOUND: shipment'; end if;
  if s.status = 'cancelled' then raise exception 'REFUSED: shipment is cancelled'; end if;
  if coalesce(p_amount,0) <= 0 then raise exception 'REFUSED: amount must be greater than zero'; end if;
  if p_currency not in ('USD','AED','TZS') then raise exception 'REFUSED: unsupported currency'; end if;

  rate   := public.fx_for(p_currency, p_fx_rate);
  usd    := round(p_amount / rate, 2);
  v_kind := case when public.shipment_invoice(s.id) is null then 'deposit' else 'payment' end;
  v_ref  := 'HC-RCT-' || public.yymm() || '-' || lpad(public.next_counter('RCT-' || public.yymm())::text, 4, '0');

  insert into public.receipts(ref, shipment_id, customer_id, kind, currency, amount, fx_rate, amount_usd,
                              method, reference, branch_code, received_by)
  values (v_ref, s.id, s.customer_id, v_kind, p_currency, p_amount, rate, usd,
          p_method, p_reference, me.branch_code, auth.uid())
  returning id into v_id;

  if p_account is not null then update public.receipts set money_account_id = p_account where id = v_id; end if;

  perform public.log_audit('receipt.create', 'receipt', v_id::text,
          jsonb_build_object('ref', v_ref, 'shipment', s.ref, 'usd', usd, 'kind', v_kind));
  return jsonb_build_object('id', v_id, 'ref', v_ref, 'amount_usd', usd, 'kind', v_kind);
end $$;

create or replace function public.void_receipt(p_receipt uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.receipts;
begin
  perform public.require_role('manager');
  perform public.rpc_mode();
  if coalesce(trim(p_reason),'') = '' then raise exception 'REFUSED: a reason is required'; end if;
  select * into r from public.receipts where id = p_receipt for update;
  if r.id is null or r.void then raise exception 'REFUSED: receipt not found or already void'; end if;
  update public.receipts set void = true, void_reason = p_reason, voided_by = auth.uid() where id = r.id;
  perform public.log_audit('receipt.void', 'receipt', r.id::text, jsonb_build_object('ref', r.ref, 'reason', p_reason));
end $$;

-- Goods Received Note: the measured record of what actually arrived
create or replace function public.record_grn(
  p_shipment uuid, p_lines jsonb, p_condition text default 'good',
  p_notes text default null, p_photos text[] default '{}', p_reprice boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.shipments; st public.settings; g_id uuid; g_ref text; ln jsonb;
        t_pieces int := 0; t_cbm numeric := 0; t_kg numeric := 0; l_cbm numeric; vol_kg numeric; charge_kg numeric;
        freight numeric;
begin
  perform public.require_role('warehouse','manager','operations');
  perform public.rpc_mode();
  select * into st from public.settings where id = 1;
  select * into s  from public.shipments where id = p_shipment for update;
  if s.id is null then raise exception 'NOT_FOUND: shipment'; end if;
  if s.status = 'cancelled' then raise exception 'REFUSED: shipment is cancelled'; end if;
  if exists (select 1 from public.grns g where g.shipment_id = s.id) then
    raise exception 'REFUSED: this shipment already has a GRN';
  end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'REFUSED: add at least one measurement line'; end if;

  g_ref := 'HC-GRN-' || s.origin_branch || '-' || public.yymm() || '-' ||
           lpad(public.next_counter('GRN-' || s.origin_branch || '-' || public.yymm())::text, 4, '0');
  insert into public.grns(ref, shipment_id, branch_code, pieces, total_cbm, total_kg, volumetric_kg, chargeable_kg,
                          condition, condition_notes, photos, received_by)
  values (g_ref, s.id, s.origin_branch, 0, 0, 0, 0, 0, coalesce(p_condition,'good'), p_notes, coalesce(p_photos,'{}'), auth.uid())
  returning id into g_id;

  for ln in select * from jsonb_array_elements(p_lines) loop
    l_cbm := round((ln->>'pieces')::int * (ln->>'length_cm')::numeric * (ln->>'width_cm')::numeric
                   * (ln->>'height_cm')::numeric / 1000000, 4);
    insert into public.grn_lines(grn_id, pieces, length_cm, width_cm, height_cm, weight_kg, cbm, packaging)
    values (g_id, (ln->>'pieces')::int, (ln->>'length_cm')::numeric, (ln->>'width_cm')::numeric,
            (ln->>'height_cm')::numeric, coalesce((ln->>'weight_kg')::numeric, 0), l_cbm, ln->>'packaging');
    t_pieces := t_pieces + (ln->>'pieces')::int;
    t_cbm    := t_cbm + l_cbm;
    t_kg     := t_kg + coalesce((ln->>'weight_kg')::numeric, 0);
  end loop;

  t_cbm     := round(t_cbm, 3);
  vol_kg    := round(t_cbm * 1000000 / st.air_volumetric_divisor, 1);
  charge_kg := greatest(t_kg, vol_kg);
  update public.grns set pieces = t_pieces, total_cbm = t_cbm, total_kg = t_kg,
         volumetric_kg = vol_kg, chargeable_kg = charge_kg where id = g_id;
  update public.shipments set pieces = t_pieces, cbm = t_cbm, actual_kg = t_kg,
         volumetric_kg = vol_kg, chargeable_kg = charge_kg,
         weight_kg = case when mode = 'air' then t_kg else weight_kg end
   where id = s.id;

  if p_reprice then
    if not public.has_role('manager') then raise exception 'NOT_ALLOWED: only a manager can re-price from the GRN'; end if;
    freight := public.write_freight_line(s.id);
  end if;

  perform public.add_event(s.id, null, 'Cargo measured (GRN ' || g_ref || ')',
          t_pieces || ' pcs · ' || t_cbm || ' CBM · ' || t_kg || ' kg', s.origin_branch);
  perform public.log_audit('grn.create', 'grn', g_id::text,
          jsonb_build_object('ref', g_ref, 'shipment', s.ref, 'cbm', t_cbm, 'kg', t_kg, 'repriced', p_reprice));
  return jsonb_build_object('grn_id', g_id, 'grn_ref', g_ref, 'pieces', t_pieces, 'cbm', t_cbm, 'kg', t_kg,
                            'chargeable_kg', charge_kg, 'freight', freight);
end $$;

-- Handover to the receiver. No settlement gate: any balance is recorded, not blocked.
create or replace function public.deliver_shipment(
  p_shipment uuid, p_name text, p_phone text, p_id_type text default null, p_id_number text default null,
  p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.shipments; bal numeric; v_ref text; v_id uuid;
begin
  perform public.require_role('release_officer','manager','operations','counter');
  perform public.rpc_mode();
  select * into s from public.shipments where id = p_shipment for update;
  if s.id is null then raise exception 'NOT_FOUND: shipment'; end if;
  if s.status = 'cancelled' then raise exception 'REFUSED: shipment is cancelled'; end if;
  if exists (select 1 from public.releases r where r.shipment_id = s.id) then
    raise exception 'REFUSED: this shipment was already handed over';
  end if;
  if coalesce(trim(p_name),'') = '' or coalesce(trim(p_phone),'') = '' then
    raise exception 'REFUSED: collector name and phone are required';
  end if;
  select balance_usd into bal from public.v_shipments where id = s.id;

  v_ref := 'HC-REL-' || public.yymm() || '-' || lpad(public.next_counter('REL-' || public.yymm())::text, 4, '0');
  insert into public.releases(ref, shipment_id, released_to_name, released_to_phone, id_type, id_number,
                              balance_at_release, notes, released_by)
  values (v_ref, s.id, p_name, public.norm_phone(p_phone, 'TZ'), p_id_type, p_id_number, bal, p_notes, auth.uid())
  returning id into v_id;
  update public.shipments set status = 'delivered', delivered_at = now() where id = s.id;
  perform public.add_event(s.id, 'delivered', 'Delivered', 'Collected by ' || p_name, s.destination_branch, true, s.status);
  perform public.log_audit('shipment.deliver', 'shipment', s.id::text,
          jsonb_build_object('ref', s.ref, 'release', v_ref, 'balance', bal));
  return jsonb_build_object('id', v_id, 'ref', v_ref, 'balance_usd', bal);
end $$;

create or replace function public.cancel_shipment(p_shipment uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare s public.shipments;
begin
  perform public.require_role('manager');
  perform public.rpc_mode();
  if coalesce(trim(p_reason),'') = '' then raise exception 'REFUSED: a reason is required'; end if;
  select * into s from public.shipments where id = p_shipment for update;
  if s.id is null then raise exception 'NOT_FOUND: shipment'; end if;
  if s.status = 'delivered' then raise exception 'REFUSED: the cargo was already delivered'; end if;
  update public.shipments set status = 'cancelled', cancelled_reason = p_reason where id = s.id;
  update public.invoices set status = 'void', void_reason = 'Shipment cancelled: ' || p_reason
   where shipment_id = s.id and status = 'issued';
  perform public.add_event(s.id, 'cancelled', 'Shipment cancelled', p_reason, null, false, s.status);
  perform public.log_audit('shipment.cancel', 'shipment', s.id::text, jsonb_build_object('ref', s.ref, 'reason', p_reason));
end $$;

create or replace function public.add_tracking_note(p_shipment uuid, p_title text, p_note text, p_public boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role('operations','manager','counter','warehouse');
  if not exists (select 1 from public.shipments where id = p_shipment) then raise exception 'NOT_FOUND: shipment'; end if;
  perform public.add_event(p_shipment, null, p_title, p_note, null, coalesce(p_public, true));
end $$;

-- ---------------------------------------------------------------------
-- 12. DASHBOARD & PUBLIC TRACKING
-- ---------------------------------------------------------------------
create or replace function public.dashboard_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not public.is_staff() then raise exception 'NOT_ALLOWED'; end if;
  select jsonb_build_object(
    'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.shipments group by status) x), '{}'::jsonb),
    'collected_today_usd', coalesce((select sum(case when kind='refund' then -amount_usd else amount_usd end) from public.receipts
                                      where not void and received_at >= date_trunc('day', now() at time zone public.hc_tz()) at time zone public.hc_tz()), 0),
    'collected_month_usd', coalesce((select sum(case when kind='refund' then -amount_usd else amount_usd end) from public.receipts
                                      where not void and received_at >= date_trunc('month', now() at time zone public.hc_tz()) at time zone public.hc_tz()), 0),
    'outstanding_usd', coalesce((select sum(balance_usd) from public.v_shipments where status <> 'cancelled' and balance_usd > 0), 0),
    'shipments_today', (select count(*) from public.shipments where created_at >= date_trunc('day', now() at time zone public.hc_tz()) at time zone public.hc_tz()),
    'cbm_in_dubai', coalesce((select sum(coalesce(cbm,0)) from public.shipments where status in ('received_dubai','packed')), 0),
    'kg_in_dubai', coalesce((select sum(coalesce(weight_kg, actual_kg, 0)) from public.shipments where status in ('received_dubai','packed') and mode = 'air'), 0),
    'recent_events', coalesce((select jsonb_agg(e) from (select shipment_ref, title, note, location, created_at
                               from public.v_events order by created_at desc limit 8) e), '[]'::jsonb)
  ) into res;
  return res;
end $$;

create or replace function public.track_shipment(p_ref text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.shipments; res jsonb;
begin
  select * into s from public.shipments where upper(ref) = upper(trim(p_ref)) and status <> 'cancelled';
  if s.id is null then return null; end if;
  select jsonb_build_object(
    'ref', s.ref, 'mode', s.mode, 'origin', s.origin_branch, 'destination', s.destination_branch,
    'status', s.status, 'status_label', public.status_label(s.status, s.destination_branch),
    'pieces', coalesce(s.pieces, s.est_pieces), 'cbm', s.cbm, 'weight_kg', coalesce(s.weight_kg, s.actual_kg),
    'receiver', left(s.receiver_name, 1) || '***',
    'events', coalesce((select jsonb_agg(jsonb_build_object('title', title, 'note', note, 'location', location,
                                                            'status', status, 'at', created_at) order by created_at desc)
                        from public.tracking_events where shipment_id = s.id and is_public), '[]'::jsonb)
  ) into res;
  return res;
end $$;

-- ---------------------------------------------------------------------
-- 13. RLS & GRANTS
-- ---------------------------------------------------------------------
alter table public.shipments      enable row level security;
alter table public.shipment_items enable row level security;

drop policy if exists staff_read on public.shipments;
create policy staff_read on public.shipments for select to authenticated using (public.is_staff());
drop policy if exists staff_read on public.shipment_items;
create policy staff_read on public.shipment_items for select to authenticated using (public.is_staff());

-- shipments and their items are written only through the RPCs above
drop policy if exists shipments_insert on public.shipments;
drop policy if exists shipments_update on public.shipments;
drop policy if exists bookings_insert  on public.shipments;
drop policy if exists bookings_update  on public.shipments;

grant select, insert, update on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke delete on all tables in schema public from authenticated;
revoke all on all tables in schema public from anon;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.track_shipment(text) to anon;

revoke execute on function public.next_counter(text)             from authenticated;
revoke execute on function public.next_shipment_ref()            from authenticated;
revoke execute on function public.log_audit(text,text,text,jsonb) from authenticated;
revoke execute on function public.add_event(uuid,public.ship_status,text,text,text,boolean,public.ship_status) from authenticated;
revoke execute on function public.rpc_mode()                     from authenticated;
revoke execute on function public.recalc_invoice(uuid)           from authenticated;
revoke execute on function public.write_freight_line(uuid)       from authenticated;
revoke execute on function public.resolve_customer(jsonb, text)  from authenticated;
revoke execute on function public.handle_new_user()              from authenticated;
revoke execute on function public.trg_customer_before()          from authenticated;
revoke execute on function public.trg_customer_norm()            from authenticated;
revoke execute on function public.trg_shipment_before()          from authenticated;
revoke execute on function public.trg_profile_guard()            from authenticated;

-- ---------------------------------------------------------------------
-- 14. ACCOUNTING — rewired to shipments (no containers)
-- ---------------------------------------------------------------------
create or replace function public.acc_post(p_company text, p_date date, p_source text, p_source_id text, p_memo text,
  p_lines jsonb, p_shipment uuid default null, p_group uuid default null, p_status text default 'posted')
returns uuid language plpgsql security definer set search_path = public as $$
declare j_id uuid; ln jsonb; acc uuid; d numeric; c numeric; td numeric := 0; tc numeric := 0; v_ref text;
begin
  for ln in select * from jsonb_array_elements(p_lines) loop
    d := round(coalesce((ln->>'debit')::numeric, 0), 2); c := round(coalesce((ln->>'credit')::numeric, 0), 2);
    if d < 0 then c := c - d; d := 0; end if;
    if c < 0 then d := d - c; c := 0; end if;
    td := td + d; tc := tc + c;
  end loop;
  if td = 0 and tc = 0 then return null; end if;
  if td <> tc then raise exception 'UNBALANCED: debits % <> credits %', td, tc; end if;

  v_ref := 'HC-JV-' || p_company || '-' || public.yymm() || '-' ||
           lpad(public.next_counter('JV-' || p_company || '-' || public.yymm())::text, 5, '0');
  insert into public.journals(ref, company_code, entry_date, source, source_id, group_id, shipment_id,
                              memo, status, total_usd, created_by)
  values (v_ref, p_company, coalesce(p_date, public.acc_today()), p_source, p_source_id, p_group, p_shipment,
          p_memo, p_status, td, auth.uid())
  returning id into j_id;

  for ln in select * from jsonb_array_elements(p_lines) loop
    d := round(coalesce((ln->>'debit')::numeric, 0), 2); c := round(coalesce((ln->>'credit')::numeric, 0), 2);
    if d < 0 then c := c - d; d := 0; end if;
    if c < 0 then d := d - c; c := 0; end if;
    if d = 0 and c = 0 then continue; end if;
    acc := coalesce(nullif(ln->>'account_id','')::uuid, public.acc_account(p_company, ln->>'key', ln->>'code'));
    insert into public.journal_lines(journal_id, account_id, debit, credit, currency, amount_txn, fx_rate, branch_code,
                                     shipment_id, customer_id, supplier_id, counterparty_company, description)
    values (j_id, acc, d, c, ln->>'currency', nullif(ln->>'amount_txn','')::numeric, nullif(ln->>'fx_rate','')::numeric,
            ln->>'branch', nullif(ln->>'shipment','')::uuid,
            nullif(ln->>'customer','')::uuid, nullif(ln->>'supplier','')::uuid, ln->>'counterparty', ln->>'description');
  end loop;
  return j_id;
end $$;

create or replace function public.acc_reverse(p_journal uuid, p_memo text default null, p_date date default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare j public.journals; v_id uuid; v_ref text;
begin
  select * into j from public.journals where id = p_journal for update;
  if j.id is null or j.status <> 'posted' or j.reversed or j.reversal_of is not null then return null; end if;
  v_ref := 'HC-JV-' || j.company_code || '-' || public.yymm() || '-' ||
           lpad(public.next_counter('JV-' || j.company_code || '-' || public.yymm())::text, 5, '0');
  insert into public.journals(ref, company_code, entry_date, source, source_id, group_id, shipment_id,
                              memo, status, reversal_of, total_usd, created_by)
  values (v_ref, j.company_code, coalesce(p_date, public.acc_today()), 'reversal', j.source_id, j.group_id, j.shipment_id,
          coalesce(p_memo, 'Reversal of ' || j.ref), 'posted', j.id, j.total_usd, auth.uid())
  returning id into v_id;
  insert into public.journal_lines(journal_id, account_id, debit, credit, currency, amount_txn, fx_rate, branch_code,
                                   shipment_id, customer_id, supplier_id, counterparty_company, description)
  select v_id, account_id, credit, debit, currency, amount_txn, fx_rate, branch_code,
         shipment_id, customer_id, supplier_id, counterparty_company, 'Reversal: ' || coalesce(description, '')
  from public.journal_lines where journal_id = j.id;
  update public.journals set reversed = true where id = j.id;
  return v_id;
end $$;

create or replace function public.acc_owner_company(p_shipment uuid, p_default text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select public.branch_company(s.origin_branch) from public.shipments s where s.id = p_shipment), p_default)
$$;

create or replace function public.acc_deposit_applied(p_shipment uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.journals where source = 'deposit_apply' and shipment_id = p_shipment
                  and status = 'posted' and not reversed and reversal_of is null)
$$;

create or replace function public.acc_apply_deposits(p_shipment uuid, p_invoice uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.shipments; oc text; dep numeric;
begin
  if public.acc_deposit_applied(p_shipment) then return; end if;
  select * into s from public.shipments where id = p_shipment;
  oc := public.branch_company(s.origin_branch);
  select coalesce(sum(amount_usd), 0) into dep from public.receipts
   where shipment_id = p_shipment and not void and kind = 'deposit';
  if dep <= 0 then return; end if;
  perform public.acc_post(oc, public.acc_today(), 'deposit_apply', p_invoice::text, 'Deposits applied to invoice · ' || s.ref,
    jsonb_build_array(
      jsonb_build_object('key', 'CUST_DEP', 'debit', dep, 'shipment', s.id, 'customer', s.customer_id, 'branch', s.origin_branch),
      jsonb_build_object('key', 'AR', 'credit', dep, 'shipment', s.id, 'customer', s.customer_id, 'branch', s.origin_branch)
    ), s.id);
end $$;

create or replace function public.acc_post_receipt(p_receipt uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.receipts; s public.shipments; ma public.money_accounts; oc text; rc text; cr_key text; g uuid;
        memo text; dt date;
begin
  select * into r from public.receipts where id = p_receipt;
  select * into s from public.shipments where id = r.shipment_id;
  if exists (select 1 from public.journals where source = 'receipt' and source_id = r.id::text) then return; end if;
  if r.money_account_id is null then
    update public.receipts set money_account_id = public.acc_default_money_account(coalesce(r.branch_code, s.origin_branch), r.method, r.currency)
     where id = r.id returning * into r;
  end if;
  select * into ma from public.money_accounts where id = r.money_account_id;
  oc := public.branch_company(s.origin_branch);
  rc := ma.company_code;
  cr_key := case when r.kind = 'deposit' and not public.acc_deposit_applied(s.id) then 'CUST_DEP' else 'AR' end;
  memo := case r.kind when 'deposit' then 'Deposit ' else 'Payment ' end || r.ref || ' · ' || s.ref;
  dt := (r.received_at at time zone public.hc_tz())::date;
  if rc = oc then
    perform public.acc_post(oc, dt, 'receipt', r.id::text, memo, jsonb_build_array(
      jsonb_build_object('account_id', ma.account_id, 'debit', r.amount_usd, 'currency', r.currency, 'amount_txn', r.amount,
                         'fx_rate', r.fx_rate, 'branch', ma.branch_code, 'shipment', s.id, 'customer', s.customer_id, 'description', memo),
      jsonb_build_object('key', cr_key, 'credit', r.amount_usd, 'branch', s.origin_branch, 'shipment', s.id, 'customer', s.customer_id, 'description', memo)
    ), s.id);
  else
    g := gen_random_uuid();
    perform public.acc_post(rc, dt, 'receipt', r.id::text, memo || ' (collected for ' || oc || ')', jsonb_build_array(
      jsonb_build_object('account_id', ma.account_id, 'debit', r.amount_usd, 'currency', r.currency, 'amount_txn', r.amount,
                         'fx_rate', r.fx_rate, 'branch', ma.branch_code, 'shipment', s.id, 'customer', s.customer_id, 'description', memo),
      jsonb_build_object('key', 'IC_DUE_TO', 'credit', r.amount_usd, 'counterparty', oc, 'shipment', s.id, 'description', memo)
    ), s.id, g);
    perform public.acc_post(oc, dt, 'receipt', r.id::text, memo || ' (collected by ' || rc || ')', jsonb_build_array(
      jsonb_build_object('key', 'IC_DUE_FROM', 'debit', r.amount_usd, 'counterparty', rc, 'shipment', s.id, 'description', memo),
      jsonb_build_object('key', cr_key, 'credit', r.amount_usd, 'branch', s.origin_branch, 'shipment', s.id, 'customer', s.customer_id, 'description', memo)
    ), s.id, g);
  end if;
end $$;

create or replace function public.acc_void_receipt(p_receipt uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.receipts; s public.shipments; oc text;
begin
  select * into r from public.receipts where id = p_receipt;
  select * into s from public.shipments where id = r.shipment_id;
  oc := public.branch_company(s.origin_branch);
  if public.acc_deposit_applied(s.id) and exists (
      select 1 from public.journal_lines l join public.journals j on j.id = l.journal_id
       join public.accounts a on a.id = l.account_id
      where j.source = 'receipt' and j.source_id = r.id::text and j.reversal_of is null and a.system_key = 'CUST_DEP') then
    perform public.acc_reverse_source('receipt', r.id::text, 'Void receipt ' || r.ref);
    perform public.acc_post(oc, public.acc_today(), 'adjustment', r.id::text,
      'Void deposit ' || r.ref || ' after invoice — reinstate receivable', jsonb_build_array(
        jsonb_build_object('key', 'AR', 'debit', r.amount_usd, 'shipment', s.id, 'customer', s.customer_id, 'branch', s.origin_branch),
        jsonb_build_object('key', 'CUST_DEP', 'credit', r.amount_usd, 'shipment', s.id, 'customer', s.customer_id, 'branch', s.origin_branch)
      ), s.id);
  else
    perform public.acc_reverse_source('receipt', r.id::text, 'Void receipt ' || r.ref);
  end if;
end $$;

create or replace function public.acc_post_invoice_line(p_line bigint) returns void
language plpgsql security definer set search_path = public as $$
declare l public.invoice_lines; inv public.invoices; s public.shipments; oc text; k text; amt numeric; memo text; dt date;
begin
  select * into l from public.invoice_lines where id = p_line;
  if exists (select 1 from public.journals where source = 'invoice_line' and source_id = l.id::text) then return; end if;
  select * into inv from public.invoices where id = l.invoice_id;
  select * into s from public.shipments where id = inv.shipment_id;
  oc := public.branch_company(s.origin_branch);
  perform public.acc_apply_deposits(s.id, inv.id);
  memo := inv.ref || ' · ' || s.ref || ' · ' || l.description;
  dt := (l.created_at at time zone public.hc_tz())::date;
  if l.kind = 'discount' or l.amount < 0 then
    amt := abs(l.amount);
    perform public.acc_post(oc, dt, 'invoice_line', l.id::text, memo, jsonb_build_array(
      jsonb_build_object('key', 'SALES_DISC', 'debit', amt, 'shipment', s.id, 'customer', s.customer_id, 'branch', s.origin_branch, 'description', l.description),
      jsonb_build_object('key', 'AR', 'credit', amt, 'shipment', s.id, 'customer', s.customer_id, 'branch', s.origin_branch, 'description', l.description)
    ), s.id);
  else
    k := case l.kind when 'freight' then (case s.mode when 'air' then 'REV_AIR' else 'REV_SEA' end)
                     when 'duty' then 'DUTY_CLEAR' else 'REV_OTHER' end;
    perform public.acc_post(oc, dt, 'invoice_line', l.id::text, memo, jsonb_build_array(
      jsonb_build_object('key', 'AR', 'debit', l.amount, 'shipment', s.id, 'customer', s.customer_id, 'branch', s.origin_branch, 'description', l.description),
      jsonb_build_object('key', k, 'credit', l.amount, 'shipment', s.id, 'customer', s.customer_id, 'branch', s.origin_branch, 'description', l.description)
    ), s.id);
  end if;
end $$;

create or replace function public.acc_post_costs(p_pc text, p_date date, p_source text, p_source_id text, p_memo text,
  p_lines jsonb, p_credit jsonb, p_supplier uuid, p_currency text, p_fx numeric, p_branch text)
returns void language plpgsql security definer set search_path = public as $$
declare ln jsonb; oc text; g uuid := gen_random_uuid(); pc_lines jsonb := '[]'; others jsonb := '{}'; total numeric := 0;
        k text; arr jsonb; osum numeric;
begin
  for ln in select * from jsonb_array_elements(p_lines) loop
    oc := public.acc_owner_company(nullif(ln->>'shipment','')::uuid, p_pc);
    total := total + (ln->>'usd')::numeric;
    if oc = p_pc then
      pc_lines := pc_lines || jsonb_build_object('code', ln->>'code', 'debit', ln->>'usd', 'currency', p_currency, 'amount_txn', ln->>'txn',
                    'fx_rate', p_fx, 'branch', p_branch, 'shipment', ln->>'shipment', 'supplier', p_supplier,
                    'description', ln->>'description');
    else
      pc_lines := pc_lines || jsonb_build_object('key', 'IC_DUE_FROM', 'debit', ln->>'usd', 'counterparty', oc,
                    'shipment', ln->>'shipment', 'description', ln->>'description');
      others := jsonb_set(others, array[oc], coalesce(others->oc, '[]'::jsonb) || jsonb_build_object('code', ln->>'code', 'debit', ln->>'usd',
                    'currency', p_currency, 'amount_txn', ln->>'txn', 'fx_rate', p_fx, 'shipment', ln->>'shipment',
                    'supplier', p_supplier, 'description', ln->>'description'));
    end if;
  end loop;
  pc_lines := pc_lines || (p_credit || jsonb_build_object('credit', total));
  perform public.acc_post(p_pc, p_date, p_source, p_source_id, p_memo, pc_lines, null, g);
  for k, arr in select * from jsonb_each(others) loop
    select coalesce(sum((x->>'debit')::numeric), 0) into osum from jsonb_array_elements(arr) x;
    perform public.acc_post(k, p_date, p_source, p_source_id, p_memo || ' (paid by ' || p_pc || ')',
      arr || jsonb_build_object('key', 'IC_DUE_TO', 'credit', osum, 'counterparty', p_pc), null, g);
  end loop;
end $$;

create or replace function public.acc_create_bill(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare bc text; cur text; fx numeric; v_id uuid; v_ref text; ln jsonb; usd numeric; tot_txn numeric := 0; tot_usd numeric := 0;
        post_lines jsonb := '[]'; sup public.suppliers; dt date;
begin
  perform public.require_role('accountant','finance_manager');
  bc := public.branch_company(p->>'branch_code');
  if bc is null then raise exception 'REFUSED: choose a branch'; end if;
  select * into sup from public.suppliers where id = (p->>'supplier_id')::uuid;
  if sup.id is null then raise exception 'NOT_FOUND: supplier'; end if;
  if p->'lines' is null or jsonb_array_length(p->'lines') = 0 then raise exception 'REFUSED: add at least one line'; end if;
  cur := coalesce(nullif(p->>'currency',''), 'USD');
  fx  := public.acc_fx(cur, nullif(p->>'fx_rate','')::numeric);
  dt  := coalesce(nullif(p->>'bill_date','')::date, public.acc_today());
  v_ref := 'HC-BILL-' || public.yymm() || '-' || lpad(public.next_counter('BILL-' || public.yymm())::text, 4, '0');
  insert into public.bills(ref, company_code, branch_code, supplier_id, supplier_invoice_no, bill_date, due_date, currency, fx_rate, notes, created_by)
  values (v_ref, bc, p->>'branch_code', sup.id, p->>'supplier_invoice_no', dt, nullif(p->>'due_date','')::date, cur, fx, p->>'notes', auth.uid())
  returning id into v_id;
  for ln in select * from jsonb_array_elements(p->'lines') loop
    if coalesce((ln->>'amount')::numeric, 0) <= 0 then raise exception 'REFUSED: line amounts must be greater than zero'; end if;
    perform public.acc_check_cost_account(bc, ln->>'account_code');
    usd := round((ln->>'amount')::numeric / fx, 2);
    insert into public.bill_lines(bill_id, account_code, description, amount_txn, amount_usd, shipment_id)
    values (v_id, ln->>'account_code', coalesce(nullif(ln->>'description',''), sup.name), (ln->>'amount')::numeric, usd,
            nullif(ln->>'shipment_id','')::uuid);
    tot_txn := tot_txn + (ln->>'amount')::numeric; tot_usd := tot_usd + usd;
    post_lines := post_lines || jsonb_build_object('code', ln->>'account_code', 'usd', usd, 'txn', ln->>'amount',
                    'description', coalesce(nullif(ln->>'description',''), sup.name), 'shipment', ln->>'shipment_id');
  end loop;
  update public.bills set total_txn = tot_txn, total_usd = tot_usd where id = v_id;
  perform public.acc_post_costs(bc, dt, 'bill', v_id::text, 'Bill ' || v_ref || ' · ' || sup.name || coalesce(' #' || nullif(p->>'supplier_invoice_no',''), ''),
    post_lines, jsonb_build_object('key', 'AP', 'supplier', sup.id, 'branch', p->>'branch_code', 'description', sup.name),
    sup.id, cur, fx, p->>'branch_code');
  perform public.log_audit('bill.create', 'bill', v_id::text, jsonb_build_object('ref', v_ref, 'supplier', sup.name, 'usd', tot_usd));
  return jsonb_build_object('id', v_id, 'ref', v_ref, 'total_usd', tot_usd);
end $$;

create or replace function public.acc_record_expense(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ma public.money_accounts; cur text; fx numeric; usd numeric; v_id uuid; v_ref text; dt date; amt numeric;
begin
  perform public.require_role('accountant','finance_manager');
  select * into ma from public.money_accounts where id = (p->>'money_account_id')::uuid and active;
  if ma.id is null then raise exception 'REFUSED: choose the cash/bank account it was paid from'; end if;
  perform public.acc_check_cost_account(ma.company_code, p->>'account_code');
  amt := (p->>'amount')::numeric;
  if coalesce(amt, 0) <= 0 then raise exception 'REFUSED: amount must be greater than zero'; end if;
  if coalesce(trim(p->>'description'),'') = '' then raise exception 'REFUSED: description is required'; end if;
  cur := coalesce(nullif(p->>'currency',''), ma.currency);
  fx  := public.acc_fx(cur, nullif(p->>'fx_rate','')::numeric);
  usd := round(amt / fx, 2);
  dt  := coalesce(nullif(p->>'expense_date','')::date, public.acc_today());
  v_ref := 'HC-EXP-' || public.yymm() || '-' || lpad(public.next_counter('EXP-' || public.yymm())::text, 4, '0');
  insert into public.expenses(ref, company_code, branch_code, expense_date, account_code, description, currency, fx_rate,
                              amount_txn, amount_usd, money_account_id, supplier_id, shipment_id, reference, created_by)
  values (v_ref, ma.company_code, coalesce(ma.branch_code, nullif(p->>'branch_code','')), dt, p->>'account_code', p->>'description',
          cur, fx, amt, usd, ma.id, nullif(p->>'supplier_id','')::uuid, nullif(p->>'shipment_id','')::uuid, p->>'reference', auth.uid())
  returning id into v_id;
  perform public.acc_post_costs(ma.company_code, dt, 'expense', v_id::text, 'Expense ' || v_ref || ' · ' || (p->>'description'),
    jsonb_build_array(jsonb_build_object('code', p->>'account_code', 'usd', usd, 'txn', amt, 'description', p->>'description',
                                         'shipment', p->>'shipment_id')),
    jsonb_build_object('account_id', ma.account_id, 'currency', cur, 'amount_txn', amt, 'fx_rate', fx, 'branch', ma.branch_code,
                       'description', p->>'description'),
    nullif(p->>'supplier_id','')::uuid, cur, fx, ma.branch_code);
  perform public.log_audit('expense.create', 'expense', v_id::text, jsonb_build_object('ref', v_ref, 'usd', usd, 'account', p->>'account_code'));
  return jsonb_build_object('id', v_id, 'ref', v_ref, 'amount_usd', usd);
end $$;

create or replace function public.acc_create_journal(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare co text; ln jsonb; lines jsonb := '[]'; v_id uuid; a public.accounts; n int := 0;
begin
  perform public.require_role('accountant','finance_manager');
  co := p->>'company_code';
  if not exists (select 1 from public.companies where code = co) then raise exception 'REFUSED: choose a company'; end if;
  if coalesce(trim(p->>'memo'),'') = '' then raise exception 'REFUSED: a narration is required'; end if;
  for ln in select * from jsonb_array_elements(coalesce(p->'lines','[]')) loop
    if coalesce((ln->>'debit')::numeric,0) = 0 and coalesce((ln->>'credit')::numeric,0) = 0 then continue; end if;
    select * into a from public.accounts where id = (ln->>'account_id')::uuid and company_code = co and active;
    if a.id is null then raise exception 'REFUSED: every line needs an account of company %', co; end if;
    lines := lines || jsonb_build_object('account_id', a.id, 'debit', ln->>'debit', 'credit', ln->>'credit',
               'branch', ln->>'branch_code', 'shipment', ln->>'shipment_id', 'description', ln->>'description', 'currency', 'USD');
    n := n + 1;
  end loop;
  if n < 2 then raise exception 'REFUSED: a journal needs at least two lines'; end if;
  v_id := public.acc_post(co, coalesce(nullif(p->>'entry_date','')::date, public.acc_today()), 'manual', null, p->>'memo', lines,
                          null, null, 'draft');
  perform public.log_audit('journal.draft', 'journal', v_id::text, jsonb_build_object('memo', p->>'memo'));
  return jsonb_build_object('id', v_id, 'ref', (select ref from public.journals where id = v_id));
end $$;

-- ---- reports ---------------------------------------------------------
create or replace function public.acc_shipment_pnl(p_shipment uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.shipments; rev numeric; cost numeric; res jsonb;
begin
  if not public.acc_can_read() then raise exception 'NOT_ALLOWED: your role cannot perform this action'; end if;
  select * into s from public.shipments where id = p_shipment;
  if s.id is null then raise exception 'NOT_FOUND: shipment'; end if;
  select coalesce(sum(l.credit - l.debit), 0) into rev
    from public.journal_lines l join public.journals j on j.id = l.journal_id and j.status = 'posted'
    join public.accounts a on a.id = l.account_id and a.type in ('revenue','contra_revenue')
   where l.shipment_id = s.id;
  select coalesce(sum(l.debit - l.credit), 0) into cost
    from public.journal_lines l join public.journals j on j.id = l.journal_id and j.status = 'posted'
    join public.accounts a on a.id = l.account_id and a.type = 'cost_of_sales'
   where l.shipment_id = s.id;
  select jsonb_build_object(
    'shipment', jsonb_build_object('id', s.id, 'ref', s.ref, 'mode', s.mode, 'status', s.status,
                                   'origin', s.origin_branch, 'destination', s.destination_branch,
                                   'cbm', s.cbm, 'weight_kg', coalesce(s.weight_kg, s.actual_kg)),
    'revenue', round(rev, 2), 'cost', round(cost, 2), 'profit', round(rev - cost, 2),
    'margin_pct', case when rev <> 0 then round((rev - cost) / rev * 100, 1) end,
    'cost_lines', coalesce((select jsonb_agg(jsonb_build_object('date', j.entry_date, 'journal', j.ref, 'source', j.source,
                    'code', a.code, 'account', a.name, 'description', l.description, 'amount', l.debit - l.credit,
                    'company', j.company_code) order by j.entry_date, j.ref)
                   from public.journal_lines l join public.journals j on j.id = l.journal_id and j.status = 'posted'
                   join public.accounts a on a.id = l.account_id and a.type = 'cost_of_sales'
                   where l.shipment_id = s.id), '[]'),
    'revenue_lines', coalesce((select jsonb_agg(jsonb_build_object('date', j.entry_date, 'journal', j.ref,
                    'code', a.code, 'account', a.name, 'description', l.description, 'amount', l.credit - l.debit)
                    order by j.entry_date, j.ref)
                   from public.journal_lines l join public.journals j on j.id = l.journal_id and j.status = 'posted'
                   join public.accounts a on a.id = l.account_id and a.type in ('revenue','contra_revenue')
                   where l.shipment_id = s.id), '[]')
  ) into res;
  return res;
end $$;

create or replace function public.acc_shipments_pnl(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not public.acc_can_read() then raise exception 'NOT_ALLOWED: your role cannot perform this action'; end if;
  with m as (
    select s.id, s.ref, s.mode, s.status, s.origin_branch, s.destination_branch, s.created_at, s.cbm,
           coalesce(s.weight_kg, s.actual_kg) as kg, public.branch_company(s.origin_branch) as company,
           c.name as customer_name,
           coalesce((select sum(l.credit - l.debit) from public.journal_lines l
                     join public.journals j on j.id = l.journal_id and j.status = 'posted'
                     join public.accounts a on a.id = l.account_id and a.type in ('revenue','contra_revenue')
                     where l.shipment_id = s.id), 0) as revenue,
           coalesce((select sum(l.debit - l.credit) from public.journal_lines l
                     join public.journals j on j.id = l.journal_id and j.status = 'posted'
                     join public.accounts a on a.id = l.account_id and a.type = 'cost_of_sales'
                     where l.shipment_id = s.id), 0) as cost
    from public.shipments s join public.customers c on c.id = s.customer_id
    where s.created_at::date between p_from and p_to
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'ref', ref, 'mode', mode, 'status', status, 'company', company,
           'customer', customer_name, 'origin', origin_branch, 'destination', destination_branch, 'created_at', created_at,
           'cbm', cbm, 'kg', kg, 'revenue', round(revenue, 2), 'cost', round(cost, 2), 'profit', round(revenue - cost, 2),
           'margin_pct', case when revenue <> 0 then round((revenue - cost) / revenue * 100, 1) end)
           order by created_at desc), '[]') into res from m;
  return res;
end $$;

create or replace function public.acc_dashboard(p_company text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m0 date := date_trunc('month', public.acc_today())::date; res jsonb;
begin
  if not public.acc_can_read() then raise exception 'NOT_ALLOWED: your role cannot perform this action'; end if;
  with pl as (
    select a.type, a.system_key, a.is_money, a.company_code, l.debit, l.credit, j.entry_date
    from public.journal_lines l join public.journals j on j.id = l.journal_id and j.status = 'posted'
    join public.accounts a on a.id = l.account_id
    where p_company is null or a.company_code = p_company
  )
  select jsonb_build_object(
    'cash', coalesce((select sum(debit - credit) from pl where is_money), 0),
    'ar', coalesce((select sum(debit - credit) from pl where system_key = 'AR'), 0),
    'ap', coalesce((select sum(credit - debit) from pl where system_key = 'AP'), 0),
    'deposits', coalesce((select sum(credit - debit) from pl where system_key = 'CUST_DEP'), 0),
    'duty', coalesce((select sum(credit - debit) from pl where system_key = 'DUTY_CLEAR'), 0),
    'ic_net', coalesce((select sum(debit - credit) from pl where system_key in ('IC_DUE_FROM','IC_DUE_TO')), 0),
    'revenue_month', coalesce((select sum(credit - debit) from pl where type in ('revenue','contra_revenue') and entry_date >= m0), 0),
    'cos_month', coalesce((select sum(debit - credit) from pl where type = 'cost_of_sales' and entry_date >= m0), 0),
    'expense_month', coalesce((select sum(debit - credit) from pl where type = 'expense' and entry_date >= m0), 0),
    'open_bills', (select count(*) from public.bills where status in ('open','part_paid') and (p_company is null or company_code = p_company)),
    'open_bills_usd', coalesce((select sum(total_usd - paid_usd) from public.bills where status in ('open','part_paid') and (p_company is null or company_code = p_company)), 0),
    'draft_journals', (select count(*) from public.journals where status = 'draft' and (p_company is null or company_code = p_company)),
    'money', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'company', m.company_code, 'branch', m.branch_code,
                        'kind', m.kind, 'currency', m.currency,
                        'balance_usd', coalesce((select sum(l.debit - l.credit) from public.journal_lines l
                                                 join public.journals j on j.id = l.journal_id and j.status = 'posted'
                                                 where l.account_id = m.account_id), 0)) order by m.company_code, m.name)
                       from public.money_accounts m where m.active and (p_company is null or m.company_code = p_company)), '[]')
  ) into res;
  return res;
end $$;

create or replace function public.acc_backfill() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; nr int := 0; nl int := 0; nv int := 0;
begin
  if auth.uid() is not null then perform public.require_role('finance_manager'); end if;
  for r in
    select 'receipt' as k, id::text as id, received_at as ts from public.receipts
      where not exists (select 1 from public.journals j where j.source = 'receipt' and j.source_id = receipts.id::text)
    union all
    select 'line', l.id::text, l.created_at from public.invoice_lines l
      where not exists (select 1 from public.journals j where j.source = 'invoice_line' and j.source_id = l.id::text)
    order by ts
  loop
    if r.k = 'receipt' then perform public.acc_post_receipt(r.id::uuid); nr := nr + 1;
    else perform public.acc_post_invoice_line(r.id::bigint); nl := nl + 1; end if;
  end loop;
  for r in select id from public.receipts where void loop
    if exists (select 1 from public.journals where source = 'receipt' and source_id = r.id::text and not reversed and reversal_of is null) then
      perform public.acc_void_receipt(r.id); nv := nv + 1;
    end if;
  end loop;
  return jsonb_build_object('receipts', nr, 'invoice_lines', nl, 'voids', nv);
end $$;

-- ---- accounting views ------------------------------------------------
create or replace view public.v_journals with (security_invoker = true) as
select j.*, s.ref as shipment_ref, pc.full_name as created_by_name, pa.full_name as approved_by_name,
       o.ref as reversal_of_ref
from public.journals j
left join public.shipments s on s.id = j.shipment_id
left join public.profiles pc on pc.id = j.created_by
left join public.profiles pa on pa.id = j.approved_by
left join public.journals o on o.id = j.reversal_of;

create or replace view public.v_journal_lines with (security_invoker = true) as
select l.*, a.code as account_code, a.name as account_name, a.name_sw as account_name_sw, a.type as account_type,
       j.ref as journal_ref, j.entry_date, j.status as journal_status, j.company_code, j.source, j.memo, j.source_id,
       s.ref as shipment_ref, sp.name as supplier_name, c.name as customer_name
from public.journal_lines l
join public.accounts a on a.id = l.account_id
join public.journals j on j.id = l.journal_id
left join public.shipments s on s.id = l.shipment_id
left join public.suppliers sp on sp.id = l.supplier_id
left join public.customers c on c.id = l.customer_id;

create or replace view public.v_bills with (security_invoker = true) as
select bl.*, sp.name as supplier_name, sp.code as supplier_code, round(bl.total_usd - bl.paid_usd, 2) as balance_usd,
       p.full_name as created_by_name,
       (select string_agg(distinct s.ref, ', ') from public.bill_lines l join public.shipments s on s.id = l.shipment_id
         where l.bill_id = bl.id) as shipments
from public.bills bl
join public.suppliers sp on sp.id = bl.supplier_id
left join public.profiles p on p.id = bl.created_by;

create or replace view public.v_bill_lines with (security_invoker = true) as
select l.*, s.ref as shipment_ref from public.bill_lines l left join public.shipments s on s.id = l.shipment_id;

create or replace view public.v_bill_payments with (security_invoker = true) as
select bp.*, m.name as money_account_name, p.full_name as paid_by_name
from public.bill_payments bp
left join public.money_accounts m on m.id = bp.money_account_id
left join public.profiles p on p.id = bp.created_by;

create or replace view public.v_expenses with (security_invoker = true) as
select e.*, m.name as money_account_name, sp.name as supplier_name, s.ref as shipment_ref,
       a.name as account_name, p.full_name as created_by_name
from public.expenses e
join public.money_accounts m on m.id = e.money_account_id
left join public.suppliers sp on sp.id = e.supplier_id
left join public.shipments s on s.id = e.shipment_id
left join public.accounts a on a.company_code = e.company_code and a.code = e.account_code
left join public.profiles p on p.id = e.created_by;

-- ---- grants (re-applied after every rebuild) -------------------------
grant select, insert, update on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke delete on all tables in schema public from authenticated;
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.track_shipment(text) to anon;

do $$
declare f text;
begin
  foreach f in array array[
    'next_counter(text)', 'next_shipment_ref()', 'log_audit(text,text,text,jsonb)', 'rpc_mode()',
    'recalc_invoice(uuid)', 'write_freight_line(uuid)', 'resolve_customer(jsonb,text)', 'handle_new_user()',
    'add_event(uuid,public.ship_status,text,text,text,boolean,public.ship_status)',
    'trg_customer_before()', 'trg_customer_norm()', 'trg_shipment_before()', 'trg_profile_guard()',
    'acc_post(text,date,text,text,text,jsonb,uuid,uuid,text)', 'acc_reverse(uuid,text,date)',
    'acc_reverse_source(text,text,text)', 'acc_post_receipt(uuid)', 'acc_void_receipt(uuid)',
    'acc_post_invoice_line(bigint)', 'acc_apply_deposits(uuid,uuid)', 'acc_seed_coa(text)',
    'acc_add_money_account(text,text,text,text,text,text,text)', 'acc_check_cost_account(text,text)',
    'trg_acc_receipts()', 'trg_acc_invoice_lines()', 'trg_acc_invoices()', 'trg_supplier_code()',
    'acc_post_costs(text,date,text,text,text,jsonb,jsonb,uuid,text,numeric,text)'
  ] loop
    begin
      execute 'revoke execute on function public.' || f || ' from authenticated';
    exception when undefined_function then null; end;
  end loop;
end $$;

select public.acc_backfill();
