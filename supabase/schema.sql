-- =====================================================================
--  HORSE CARGO — Cargo Operating System  ·  Supabase schema v1.0
--  Run once in Supabase → SQL Editor (as a single script), then seed.sql
--
--  Design rules (from the Horse Cargo Operating Blueprint):
--   1. Two hard gates:  no cargo received without a deposit,
--                       no release without full settlement.
--   2. Price locks at measurement (GRN), not at quotation.
--   3. Duty is a receivable line, never revenue.
--   4. Segregation: whoever measures ≠ whoever collects cash
--                   ≠ whoever releases.
--   5. Controlled fields change ONLY through the RPC functions below
--      ("build the refusals first").
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------
do $$ begin
  create type app_role as enum ('admin','manager','counter','warehouse','cashier','operations','release_officer','viewer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type booking_status as enum ('pending_deposit','booked','received','loaded','in_transit','arrived','clearing','ready','released','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type shipment_status as enum ('open','departed','arrived','completed');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- CORE TABLES
-- ---------------------------------------------------------------------
create table if not exists public.branches (
  code        text primary key,               -- DXB, DAR, MWZ
  name        text not null,
  country     text not null,
  currency    text not null,
  phone       text,
  address     text,
  active      boolean not null default true
);

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  email       text,
  phone       text,
  role        app_role not null default 'viewer',
  branch_code text references public.branches(code),
  active      boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.settings (
  id                     int primary key default 1 check (id = 1),
  company_name           text not null default 'Horse Cargo Company Ltd',
  company_phone          text default '+971 50 608 3531',
  company_email          text default 'info@horsecargoltd.com',
  company_address        text default 'Al Badri Building, Floor 2, Office S201, Baniyas Square, Deira, Dubai',
  deposit_pct_sea        numeric not null default 30 check (deposit_pct_sea between 0 and 100),
  deposit_pct_air        numeric not null default 50 check (deposit_pct_air between 0 and 100),
  min_cbm_sea            numeric not null default 0.1,
  air_volumetric_divisor numeric not null default 6000,
  fx_aed                 numeric not null default 3.6725,   -- AED per 1 USD
  fx_tzs                 numeric not null default 2600,     -- TZS per 1 USD
  free_storage_days      int     not null default 7,
  storage_rate_per_day   numeric not null default 0,
  invoice_terms          text default 'Cargo is released only after full settlement. Duty and taxes are charged at cost.',
  updated_at             timestamptz not null default now()
);

create table if not exists public.counters (
  key   text primary key,
  value int  not null default 0
);

create table if not exists public.customers (
  id           uuid primary key default gen_random_uuid(),
  code         text unique,
  name         text not null,
  company      text,
  phone        text not null,
  phone2       text,
  email        text,
  tin          text,
  id_type      text,
  id_number    text,
  address      text,
  city         text,
  country      text,
  branch_code  text references public.branches(code),
  credit_limit numeric not null default 0,
  notes        text,
  active       boolean not null default true,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.cargo_categories (
  id              serial primary key,
  name            text not null unique,
  name_sw         text,
  description     text,
  sea_rate_cbm    numeric not null default 0,   -- USD per CBM
  air_rate_kg     numeric not null default 0,   -- USD per chargeable kg
  min_charge_sea  numeric not null default 0,   -- USD
  min_charge_air  numeric not null default 0,   -- USD
  permit_note     text,                         -- e.g. TBS / TMDA required
  restricted      boolean not null default false, -- GN 184/2025 reserved items (TASAC)
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create table if not exists public.shipments (
  id                 uuid primary key default gen_random_uuid(),
  ref                text unique,
  mode               text not null check (mode in ('sea','air')),
  origin_branch      text not null references public.branches(code),
  destination_branch text not null references public.branches(code),
  container_type     text,            -- 20GP / 40GP / 40HC / LCL / AIR
  container_no       text,
  seal_no            text,
  carrier            text,
  vessel_or_flight   text,
  bl_awb_no          text,
  capacity_cbm       numeric,
  etd                date,
  eta                date,
  status             shipment_status not null default 'open',
  departed_at        timestamptz,
  arrived_at         timestamptz,
  notes              text,
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  check (origin_branch <> destination_branch)
);

create table if not exists public.bookings (
  id                 uuid primary key default gen_random_uuid(),
  ref                text unique,
  customer_id        uuid not null references public.customers(id),
  mode               text not null check (mode in ('sea','air')),
  origin_branch      text not null references public.branches(code),
  destination_branch text not null references public.branches(code),
  category_id        int references public.cargo_categories(id),
  description        text not null,
  est_pieces         int     not null default 1 check (est_pieces > 0),
  est_cbm            numeric not null default 0 check (est_cbm >= 0),
  est_kg             numeric not null default 0 check (est_kg >= 0),
  quoted_amount      numeric not null default 0,
  deposit_required   numeric not null default 0,
  consignee_name     text not null,
  consignee_phone    text not null,
  consignee_address  text,
  consignee_tin      text,
  status             booking_status not null default 'pending_deposit',
  shipment_id        uuid references public.shipments(id),
  -- locked at GRN
  pieces             int,
  cbm                numeric,
  actual_kg          numeric,
  volumetric_kg      numeric,
  chargeable_kg      numeric,
  cancelled_reason   text,
  notes              text,
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (origin_branch <> destination_branch)
);
create index if not exists bookings_customer_idx on public.bookings(customer_id);
create index if not exists bookings_status_idx   on public.bookings(status);
create index if not exists bookings_shipment_idx on public.bookings(shipment_id);

create table if not exists public.grns (
  id              uuid primary key default gen_random_uuid(),
  ref             text unique,
  booking_id      uuid not null unique references public.bookings(id),
  branch_code     text not null references public.branches(code),
  pieces          int     not null,
  total_cbm       numeric not null,
  total_kg        numeric not null,
  volumetric_kg   numeric not null,
  chargeable_kg   numeric not null,
  condition       text not null default 'good' check (condition in ('good','damaged','partial')),
  condition_notes text,
  photos          text[] not null default '{}',
  received_by     uuid not null,
  received_at     timestamptz not null default now()
);

create table if not exists public.grn_lines (
  id         bigserial primary key,
  grn_id     uuid not null references public.grns(id) on delete cascade,
  pieces     int     not null check (pieces > 0),
  length_cm  numeric not null check (length_cm > 0),
  width_cm   numeric not null check (width_cm > 0),
  height_cm  numeric not null check (height_cm > 0),
  weight_kg  numeric not null check (weight_kg >= 0),   -- total weight of this line
  cbm        numeric not null,
  packaging  text
);

create table if not exists public.invoices (
  id           uuid primary key default gen_random_uuid(),
  ref          text unique,
  booking_id   uuid not null references public.bookings(id),
  customer_id  uuid not null references public.customers(id),
  currency     text not null default 'USD',
  total        numeric not null default 0,
  status       text not null default 'issued' check (status in ('issued','void')),
  issued_at    timestamptz not null default now(),
  void_reason  text,
  created_by   uuid
);
create unique index if not exists invoices_one_active on public.invoices(booking_id) where status = 'issued';

create table if not exists public.invoice_lines (
  id          bigserial primary key,
  invoice_id  uuid not null references public.invoices(id) on delete cascade,
  kind        text not null check (kind in ('freight','extra','duty','discount')),
  description text not null,
  qty         numeric not null default 1,
  unit_price  numeric not null default 0,
  amount      numeric not null,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

create table if not exists public.receipts (
  id           uuid primary key default gen_random_uuid(),
  ref          text unique,
  booking_id   uuid not null references public.bookings(id),
  customer_id  uuid not null references public.customers(id),
  kind         text not null check (kind in ('deposit','payment','refund')),
  currency     text not null check (currency in ('USD','AED','TZS')),
  amount       numeric not null check (amount > 0),
  fx_rate      numeric not null check (fx_rate > 0),     -- units of currency per 1 USD
  amount_usd   numeric not null,
  method       text not null check (method in ('cash','bank','mobile_money','card')),
  reference    text,
  branch_code  text references public.branches(code),
  received_by  uuid not null,
  received_at  timestamptz not null default now(),
  void         boolean not null default false,
  void_reason  text,
  voided_by    uuid
);
create index if not exists receipts_booking_idx on public.receipts(booking_id);

create table if not exists public.tracking_events (
  id          bigserial primary key,
  booking_id  uuid not null references public.bookings(id) on delete cascade,
  status      booking_status,
  title       text not null,
  note        text,
  location    text,
  is_public   boolean not null default true,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists tracking_booking_idx on public.tracking_events(booking_id, created_at desc);

create table if not exists public.releases (
  id                 uuid primary key default gen_random_uuid(),
  ref                text unique,
  booking_id         uuid not null unique references public.bookings(id),
  released_to_name   text not null,
  released_to_phone  text not null,
  id_type            text,
  id_number          text,
  balance_at_release numeric not null,
  override_reason    text,
  notes              text,
  released_by        uuid not null,
  released_at        timestamptz not null default now()
);

create table if not exists public.audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  user_id    uuid,
  action     text not null,
  entity     text not null,
  entity_id  text,
  details    jsonb
);

-- ---------------------------------------------------------------------
-- HELPERS
-- ---------------------------------------------------------------------
create or replace function public.my_role() returns app_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active)
$$;

create or replace function public.has_role(variadic roles app_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and active and (role = 'admin' or role = any(roles)))
$$;

create or replace function public.require_role(variadic roles app_role[]) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_role(variadic roles) then
    raise exception 'NOT_ALLOWED: your role cannot perform this action' using errcode = '42501';
  end if;
end $$;

create or replace function public.next_counter(p_key text) returns int
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  insert into public.counters(key, value) values (p_key, 1)
  on conflict (key) do update set value = public.counters.value + 1
  returning value into v;
  return v;
end $$;

create or replace function public.yymm() returns text
language sql stable as $$ select to_char(now() at time zone 'Asia/Dubai', 'YYMM') $$;

create or replace function public.log_audit(p_action text, p_entity text, p_id text, p_details jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into public.audit_log(user_id, action, entity, entity_id, details)
  values (auth.uid(), p_action, p_entity, p_id, p_details)
$$;

create or replace function public.add_event(p_booking uuid, p_status booking_status, p_title text,
                                            p_note text default null, p_location text default null,
                                            p_public boolean default true)
returns void language sql security definer set search_path = public as $$
  insert into public.tracking_events(booking_id, status, title, note, location, is_public, created_by)
  values (p_booking, p_status, p_title, p_note, p_location, p_public, auth.uid())
$$;

-- Marks the current transaction as "inside a trusted RPC", so guard triggers let controlled columns change.
create or replace function public.rpc_mode() returns void
language sql as $$ select set_config('hc.rpc', 'on', true) $$;

create or replace function public.in_rpc() returns boolean
language sql stable as $$ select coalesce(current_setting('hc.rpc', true), '') = 'on' $$;

-- ---------------------------------------------------------------------
-- NUMBERING & GUARD TRIGGERS
-- ---------------------------------------------------------------------
create or replace function public.trg_customer_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.code := 'HC-C-' || lpad(public.next_counter('C')::text, 5, '0');
  else
    new.code := old.code;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists customer_before on public.customers;
create trigger customer_before before insert or update on public.customers
for each row execute function public.trg_customer_before();

create or replace function public.quote_for(p_mode text, p_category int, p_cbm numeric, p_kg numeric)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare c public.cargo_categories; s public.settings; vol_kg numeric; charge numeric;
begin
  select * into c from public.cargo_categories where id = p_category;
  select * into s from public.settings where id = 1;
  if c.id is null then return 0; end if;
  if p_mode = 'sea' then
    charge := greatest(coalesce(p_cbm,0), s.min_cbm_sea) * c.sea_rate_cbm;
    charge := greatest(charge, c.min_charge_sea);
  else
    vol_kg := coalesce(p_cbm,0) * 1000000 / s.air_volumetric_divisor;
    charge := greatest(coalesce(p_kg,0), vol_kg) * c.air_rate_kg;
    charge := greatest(charge, c.min_charge_air);
  end if;
  return round(charge, 2);
end $$;

create or replace function public.trg_booking_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare s public.settings; pct numeric;
begin
  select * into s from public.settings where id = 1;
  if tg_op = 'INSERT' then
    if not public.in_rpc() then
      new.status := 'pending_deposit';
      new.shipment_id := null;
      new.pieces := null; new.cbm := null; new.actual_kg := null;
      new.volumetric_kg := null; new.chargeable_kg := null;
    end if;
    new.ref := 'HC-BK-' || public.yymm() || '-' || lpad(public.next_counter('BK-' || public.yymm())::text, 4, '0');
    new.created_by := coalesce(new.created_by, auth.uid());
  else
    if not public.in_rpc() then
      -- controlled columns cannot be edited directly
      new.ref := old.ref; new.status := old.status; new.shipment_id := old.shipment_id;
      new.pieces := old.pieces; new.cbm := old.cbm; new.actual_kg := old.actual_kg;
      new.volumetric_kg := old.volumetric_kg; new.chargeable_kg := old.chargeable_kg;
      new.cancelled_reason := old.cancelled_reason; new.created_by := old.created_by;
      if old.status <> 'pending_deposit' then
        -- after deposit, commercial terms and route are frozen
        new.customer_id := old.customer_id; new.mode := old.mode;
        new.origin_branch := old.origin_branch; new.destination_branch := old.destination_branch;
        new.category_id := old.category_id; new.est_pieces := old.est_pieces;
        new.est_cbm := old.est_cbm; new.est_kg := old.est_kg;
        new.quoted_amount := old.quoted_amount; new.deposit_required := old.deposit_required;
      end if;
    end if;
  end if;
  if new.status = 'pending_deposit' then
    new.quoted_amount := public.quote_for(new.mode, new.category_id, new.est_cbm, new.est_kg);
    pct := case when new.mode = 'sea' then s.deposit_pct_sea else s.deposit_pct_air end;
    new.deposit_required := round(new.quoted_amount * pct / 100, 2);
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists booking_before on public.bookings;
create trigger booking_before before insert or update on public.bookings
for each row execute function public.trg_booking_before();

create or replace function public.trg_booking_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.add_event(new.id, 'pending_deposit', 'Booking created', 'Awaiting deposit', new.origin_branch);
  perform public.log_audit('booking.create', 'booking', new.id::text, jsonb_build_object('ref', new.ref));
  return new;
end $$;
drop trigger if exists booking_after_insert on public.bookings;
create trigger booking_after_insert after insert on public.bookings
for each row execute function public.trg_booking_after_insert();

create or replace function public.trg_shipment_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not public.in_rpc() then
      new.status := 'open'; new.departed_at := null; new.arrived_at := null;
    end if;
    new.ref := 'HC-' || upper(new.mode) || '-' || new.origin_branch || '-' || new.destination_branch || '-' ||
               lpad(public.next_counter('SH-' || new.mode || '-' || new.origin_branch || '-' || new.destination_branch)::text, 4, '0');
    new.created_by := coalesce(new.created_by, auth.uid());
  elsif not public.in_rpc() then
    new.ref := old.ref; new.status := old.status;
    new.departed_at := old.departed_at; new.arrived_at := old.arrived_at;
    new.mode := old.mode; new.origin_branch := old.origin_branch;
    new.destination_branch := old.destination_branch; new.created_by := old.created_by;
  end if;
  return new;
end $$;
drop trigger if exists shipment_before on public.shipments;
create trigger shipment_before before insert or update on public.shipments
for each row execute function public.trg_shipment_before();

create or replace function public.trg_profile_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- API users who are not admin cannot change role/active/branch.
  -- (auth.uid() is null only for trusted server-side SQL, e.g. the Supabase SQL editor.)
  if auth.uid() is not null and not public.has_role('admin') then
    new.role := old.role; new.active := old.active; new.branch_code := old.branch_code;
  end if;
  new.id := old.id; new.email := old.email;
  return new;
end $$;
drop trigger if exists profile_guard on public.profiles;
create trigger profile_guard before update on public.profiles
for each row execute function public.trg_profile_guard();

-- New auth user → profile. The very first user becomes an active admin.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare first_user boolean;
begin
  select not exists (select 1 from public.profiles) into first_user;
  insert into public.profiles(id, email, full_name, role, active)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
          case when first_user then 'admin'::app_role else 'viewer'::app_role end,
          first_user)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- VIEWS (security_invoker → RLS of the caller applies)
-- ---------------------------------------------------------------------
create or replace view public.v_booking_money with (security_invoker = true) as
select b.id as booking_id,
       coalesce((select i.total from public.invoices i where i.booking_id = b.id and i.status = 'issued'), 0) as invoice_total,
       coalesce((select sum(case when r.kind = 'refund' then -r.amount_usd else r.amount_usd end)
                 from public.receipts r where r.booking_id = b.id and not r.void), 0) as paid_usd,
       coalesce((select sum(r.amount_usd) from public.receipts r
                 where r.booking_id = b.id and not r.void and r.kind = 'deposit'), 0) as deposit_paid
from public.bookings b;

create or replace view public.v_bookings with (security_invoker = true) as
select b.*,
       c.code  as customer_code, c.name as customer_name, c.phone as customer_phone, c.company as customer_company,
       cat.name as category_name, cat.name_sw as category_name_sw,
       s.ref   as shipment_ref, s.container_no, s.eta as shipment_eta,
       m.invoice_total, m.paid_usd, m.deposit_paid,
       round(case when m.invoice_total > 0 then m.invoice_total - m.paid_usd
                  else greatest(b.deposit_required - m.paid_usd, 0) end, 2) as balance_usd
from public.bookings b
join public.customers c on c.id = b.customer_id
left join public.cargo_categories cat on cat.id = b.category_id
left join public.shipments s on s.id = b.shipment_id
join public.v_booking_money m on m.booking_id = b.id;

create or replace view public.v_shipments with (security_invoker = true) as
select s.*,
       (select count(*) from public.bookings b where b.shipment_id = s.id)                      as booking_count,
       (select coalesce(sum(b.pieces),0) from public.bookings b where b.shipment_id = s.id)     as total_pieces,
       (select coalesce(sum(b.cbm),0) from public.bookings b where b.shipment_id = s.id)        as total_cbm,
       (select coalesce(sum(b.actual_kg),0) from public.bookings b where b.shipment_id = s.id)  as total_kg
from public.shipments s;

create or replace view public.v_receipts with (security_invoker = true) as
select r.*, b.ref as booking_ref, c.name as customer_name, c.code as customer_code,
       p.full_name as received_by_name
from public.receipts r
join public.bookings b on b.id = r.booking_id
join public.customers c on c.id = r.customer_id
left join public.profiles p on p.id = r.received_by;

create or replace view public.v_customers with (security_invoker = true) as
select c.*,
       (select count(*) from public.bookings b where b.customer_id = c.id) as booking_count,
       (select coalesce(sum(vb.balance_usd),0) from public.v_bookings vb
         where vb.customer_id = c.id and vb.status not in ('cancelled')) as balance_usd
from public.customers c;

create or replace view public.v_events with (security_invoker = true) as
select e.*, b.ref as booking_ref, p.full_name as created_by_name
from public.tracking_events e
join public.bookings b on b.id = e.booking_id
left join public.profiles p on p.id = e.created_by;

create or replace view public.v_invoice_lines with (security_invoker = true) as
select l.*, i.ref as invoice_ref, i.issued_at, i.status as invoice_status, i.booking_id,
       b.ref as booking_ref, b.mode, b.origin_branch, b.destination_branch, c.name as customer_name
from public.invoice_lines l
join public.invoices i on i.id = l.invoice_id
join public.bookings b on b.id = i.booking_id
join public.customers c on c.id = i.customer_id;

create or replace view public.v_audit with (security_invoker = true) as
select a.*, p.full_name as user_name from public.audit_log a left join public.profiles p on p.id = a.user_id;

create or replace view public.v_releases with (security_invoker = true) as
select r.*, p.full_name as released_by_name from public.releases r left join public.profiles p on p.id = r.released_by;

-- ---------------------------------------------------------------------
-- BUSINESS RPCs
-- ---------------------------------------------------------------------

-- Stage 01 · Payment / deposit. Deposit gate lifts automatically once the deposit is covered.
create or replace function public.record_payment(
  p_booking uuid, p_amount numeric, p_currency text, p_method text,
  p_reference text default null, p_fx_rate numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b public.bookings; s public.settings; me public.profiles; rate numeric; usd numeric;
        v_kind text; v_ref text; v_id uuid; deposits numeric;
begin
  perform public.require_role('cashier','manager');
  perform public.rpc_mode();
  select * into me from public.profiles where id = auth.uid();
  select * into s  from public.settings where id = 1;
  select * into b  from public.bookings where id = p_booking for update;
  if b.id is null then raise exception 'NOT_FOUND: booking'; end if;
  if b.status in ('cancelled','released') then
    raise exception 'REFUSED: booking is %', b.status;
  end if;
  if coalesce(p_amount,0) <= 0 then raise exception 'REFUSED: amount must be greater than zero'; end if;
  if p_currency not in ('USD','AED','TZS') then raise exception 'REFUSED: unsupported currency'; end if;

  -- Segregation: whoever measured the cargo cannot collect cash for it
  if me.role <> 'admin' and exists (select 1 from public.grns g where g.booking_id = b.id and g.received_by = auth.uid()) then
    raise exception 'SEGREGATION: you measured this cargo (GRN) — another person must collect the payment';
  end if;

  rate := case p_currency when 'USD' then 1
                          when 'AED' then coalesce(nullif(p_fx_rate,0), s.fx_aed)
                          else coalesce(nullif(p_fx_rate,0), s.fx_tzs) end;
  usd := round(p_amount / rate, 2);
  v_kind := case when b.status = 'pending_deposit' then 'deposit' else 'payment' end;
  v_ref := 'HC-RCT-' || public.yymm() || '-' || lpad(public.next_counter('RCT-' || public.yymm())::text, 4, '0');

  insert into public.receipts(ref, booking_id, customer_id, kind, currency, amount, fx_rate, amount_usd,
                              method, reference, branch_code, received_by)
  values (v_ref, b.id, b.customer_id, v_kind, p_currency, p_amount, rate, usd,
          p_method, p_reference, me.branch_code, auth.uid())
  returning id into v_id;

  perform public.log_audit('receipt.create', 'receipt', v_id::text,
          jsonb_build_object('ref', v_ref, 'booking', b.ref, 'usd', usd, 'kind', v_kind));

  if b.status = 'pending_deposit' then
    select coalesce(sum(amount_usd),0) into deposits from public.receipts
     where booking_id = b.id and not void and kind = 'deposit';
    if deposits + 0.005 >= b.deposit_required then
      update public.bookings set status = 'booked' where id = b.id;
      perform public.add_event(b.id, 'booked', 'Booking confirmed', 'Deposit received — deliver cargo to the warehouse', b.origin_branch);
    end if;
  end if;

  return jsonb_build_object('id', v_id, 'ref', v_ref, 'amount_usd', usd, 'kind', v_kind);
end $$;

create or replace function public.void_receipt(p_receipt uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.receipts; b public.bookings;
begin
  perform public.require_role('manager');
  perform public.rpc_mode();
  if coalesce(trim(p_reason),'') = '' then raise exception 'REFUSED: a reason is required'; end if;
  select * into r from public.receipts where id = p_receipt for update;
  if r.id is null or r.void then raise exception 'REFUSED: receipt not found or already void'; end if;
  select * into b from public.bookings where id = r.booking_id;
  if b.status = 'released' then raise exception 'REFUSED: cargo already released'; end if;
  update public.receipts set void = true, void_reason = p_reason, voided_by = auth.uid() where id = r.id;
  perform public.log_audit('receipt.void', 'receipt', r.id::text, jsonb_build_object('ref', r.ref, 'reason', p_reason));
end $$;

-- Stage 02 · Warehouse receipt (GRN). Deposit gate + price lock + invoice.
create or replace function public.record_grn(
  p_booking uuid, p_lines jsonb, p_condition text default 'good',
  p_notes text default null, p_photos text[] default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare b public.bookings; s public.settings; me public.profiles; c public.cargo_categories;
        g_id uuid; g_ref text; ln jsonb; t_pieces int := 0; t_cbm numeric := 0; t_kg numeric := 0;
        l_cbm numeric; vol_kg numeric; charge_kg numeric; freight numeric; qty numeric; price numeric;
        inv_id uuid; inv_ref text; desc_txt text;
begin
  perform public.require_role('warehouse','manager');
  perform public.rpc_mode();
  select * into me from public.profiles where id = auth.uid();
  select * into s  from public.settings where id = 1;
  select * into b  from public.bookings where id = p_booking for update;
  if b.id is null then raise exception 'NOT_FOUND: booking'; end if;
  if b.status = 'pending_deposit' then
    raise exception 'DEPOSIT_GATE: no deposit on this booking — cargo cannot be received';
  end if;
  if b.status <> 'booked' then raise exception 'REFUSED: booking is already %', b.status; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'REFUSED: add at least one measurement line'; end if;

  -- Segregation: whoever collected cash cannot measure the cargo
  if me.role <> 'admin' and exists (select 1 from public.receipts r where r.booking_id = b.id and not r.void and r.received_by = auth.uid()) then
    raise exception 'SEGREGATION: you collected payment on this booking — another person must measure the cargo';
  end if;

  g_ref := 'HC-GRN-' || b.origin_branch || '-' || public.yymm() || '-' ||
           lpad(public.next_counter('GRN-' || b.origin_branch || '-' || public.yymm())::text, 4, '0');

  insert into public.grns(ref, booking_id, branch_code, pieces, total_cbm, total_kg, volumetric_kg, chargeable_kg,
                          condition, condition_notes, photos, received_by)
  values (g_ref, b.id, b.origin_branch, 0, 0, 0, 0, 0, coalesce(p_condition,'good'), p_notes, coalesce(p_photos,'{}'), auth.uid())
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

  t_cbm := round(t_cbm, 3);
  vol_kg := round(t_cbm * 1000000 / s.air_volumetric_divisor, 1);
  charge_kg := greatest(t_kg, vol_kg);

  update public.grns set pieces = t_pieces, total_cbm = t_cbm, total_kg = t_kg,
         volumetric_kg = vol_kg, chargeable_kg = charge_kg where id = g_id;

  update public.bookings set status = 'received', pieces = t_pieces, cbm = t_cbm, actual_kg = t_kg,
         volumetric_kg = vol_kg, chargeable_kg = charge_kg where id = b.id;

  -- Price locks here: invoice from measured figures
  select * into c from public.cargo_categories where id = b.category_id;
  if b.mode = 'sea' then
    qty := greatest(t_cbm, s.min_cbm_sea);
    price := coalesce(c.sea_rate_cbm, 0);
    freight := greatest(round(qty * price, 2), coalesce(c.min_charge_sea, 0));
    desc_txt := 'Sea freight ' || b.origin_branch || '→' || b.destination_branch || ' · ' || qty || ' CBM';
  else
    qty := charge_kg;
    price := coalesce(c.air_rate_kg, 0);
    freight := greatest(round(qty * price, 2), coalesce(c.min_charge_air, 0));
    desc_txt := 'Air freight ' || b.origin_branch || '→' || b.destination_branch || ' · ' || qty || ' kg chargeable';
  end if;
  if freight > round(qty * price, 2) then
    desc_txt := desc_txt || ' (minimum charge)'; qty := 1; price := freight;
  end if;

  inv_ref := 'HC-INV-' || public.yymm() || '-' || lpad(public.next_counter('INV-' || public.yymm())::text, 4, '0');
  insert into public.invoices(ref, booking_id, customer_id, total, created_by)
  values (inv_ref, b.id, b.customer_id, freight, auth.uid()) returning id into inv_id;
  insert into public.invoice_lines(invoice_id, kind, description, qty, unit_price, amount, created_by)
  values (inv_id, 'freight', desc_txt, qty, price, freight, auth.uid());

  perform public.add_event(b.id, 'received', 'Cargo received at warehouse',
          t_pieces || ' pcs · ' || t_cbm || ' CBM · ' || t_kg || ' kg', b.origin_branch);
  perform public.log_audit('grn.create', 'grn', g_id::text,
          jsonb_build_object('ref', g_ref, 'booking', b.ref, 'cbm', t_cbm, 'kg', t_kg, 'invoice', inv_ref, 'freight', freight));

  return jsonb_build_object('grn_id', g_id, 'grn_ref', g_ref, 'invoice_id', inv_id, 'invoice_ref', inv_ref,
                            'pieces', t_pieces, 'cbm', t_cbm, 'kg', t_kg, 'freight', freight);
end $$;

create or replace function public.recalc_invoice(p_invoice uuid) returns void
language sql security definer set search_path = public as $$
  update public.invoices set total = coalesce((select round(sum(amount),2) from public.invoice_lines where invoice_id = p_invoice), 0)
  where id = p_invoice
$$;

-- Extras, duty (receivable) and discounts on the active invoice
create or replace function public.add_invoice_line(p_booking uuid, p_kind text, p_description text,
                                                   p_qty numeric, p_unit_price numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b public.bookings; inv public.invoices; amt numeric; v_id bigint;
begin
  perform public.require_role('manager','counter','operations');
  perform public.rpc_mode();
  if p_kind not in ('extra','duty','discount') then raise exception 'REFUSED: invalid line type'; end if;
  if p_kind = 'discount' and not public.has_role('manager') then
    raise exception 'NOT_ALLOWED: only a manager can give a discount';
  end if;
  select * into b from public.bookings where id = p_booking;
  if b.status in ('released','cancelled') then raise exception 'REFUSED: booking is %', b.status; end if;
  select * into inv from public.invoices where booking_id = p_booking and status = 'issued';
  if inv.id is null then raise exception 'REFUSED: no invoice yet — record the GRN first'; end if;
  amt := round(coalesce(p_qty,1) * coalesce(p_unit_price,0), 2);
  if p_kind = 'discount' then amt := -abs(amt); end if;
  insert into public.invoice_lines(invoice_id, kind, description, qty, unit_price, amount, created_by)
  values (inv.id, p_kind, p_description, coalesce(p_qty,1), p_unit_price, amt, auth.uid()) returning id into v_id;
  perform public.recalc_invoice(inv.id);
  perform public.log_audit('invoice.line_add', 'invoice', inv.id::text,
          jsonb_build_object('ref', inv.ref, 'kind', p_kind, 'amount', amt, 'description', p_description));
  return jsonb_build_object('line_id', v_id, 'amount', amt);
end $$;

create or replace function public.remove_invoice_line(p_line bigint)
returns void language plpgsql security definer set search_path = public as $$
declare l public.invoice_lines; inv public.invoices; b public.bookings;
begin
  perform public.require_role('manager');
  perform public.rpc_mode();
  select * into l from public.invoice_lines where id = p_line;
  if l.id is null then raise exception 'NOT_FOUND: line'; end if;
  if l.kind = 'freight' then raise exception 'REFUSED: freight line is locked at GRN'; end if;
  select * into inv from public.invoices where id = l.invoice_id;
  select * into b from public.bookings where id = inv.booking_id;
  if b.status = 'released' then raise exception 'REFUSED: cargo already released'; end if;
  delete from public.invoice_lines where id = p_line;
  perform public.recalc_invoice(inv.id);
  perform public.log_audit('invoice.line_remove', 'invoice', inv.id::text, to_jsonb(l));
end $$;

-- Stage 04 · Consolidation / loading
create or replace function public.load_booking(p_shipment uuid, p_booking uuid)
returns void language plpgsql security definer set search_path = public as $$
declare sh public.shipments; b public.bookings;
begin
  perform public.require_role('operations','warehouse','manager');
  perform public.rpc_mode();
  select * into sh from public.shipments where id = p_shipment for update;
  select * into b  from public.bookings  where id = p_booking  for update;
  if sh.id is null or b.id is null then raise exception 'NOT_FOUND'; end if;
  if sh.status <> 'open' then raise exception 'REFUSED: container % is already %', sh.ref, sh.status; end if;
  if b.status <> 'received' then raise exception 'REFUSED: booking % is % (must be received at warehouse)', b.ref, b.status; end if;
  if b.mode <> sh.mode or b.origin_branch <> sh.origin_branch or b.destination_branch <> sh.destination_branch then
    raise exception 'REFUSED: booking % route/mode does not match container %', b.ref, sh.ref;
  end if;
  update public.bookings set shipment_id = sh.id, status = 'loaded' where id = b.id;
  perform public.add_event(b.id, 'loaded', 'Loaded for shipment',
          coalesce('Container ' || sh.container_no, sh.ref), sh.origin_branch);
  perform public.log_audit('shipment.load', 'shipment', sh.id::text, jsonb_build_object('ref', sh.ref, 'booking', b.ref));
end $$;

create or replace function public.unload_booking(p_booking uuid)
returns void language plpgsql security definer set search_path = public as $$
declare sh public.shipments; b public.bookings;
begin
  perform public.require_role('operations','warehouse','manager');
  perform public.rpc_mode();
  select * into b from public.bookings where id = p_booking for update;
  select * into sh from public.shipments where id = b.shipment_id;
  if b.status <> 'loaded' or sh.status <> 'open' then raise exception 'REFUSED: can only unload from an open container'; end if;
  update public.bookings set shipment_id = null, status = 'received' where id = b.id;
  perform public.add_event(b.id, 'received', 'Removed from container', sh.ref, sh.origin_branch, false);
  perform public.log_audit('shipment.unload', 'shipment', sh.id::text, jsonb_build_object('ref', sh.ref, 'booking', b.ref));
end $$;

-- Stages 05–06 · Departure / arrival (cascades to every booking in the container)
create or replace function public.update_shipment_status(p_shipment uuid, p_status shipment_status, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare sh public.shipments; r record; n int;
begin
  perform public.require_role('operations','manager');
  perform public.rpc_mode();
  select * into sh from public.shipments where id = p_shipment for update;
  if sh.id is null then raise exception 'NOT_FOUND: shipment'; end if;

  if p_status = 'departed' then
    if sh.status <> 'open' then raise exception 'REFUSED: container is %', sh.status; end if;
    select count(*) into n from public.bookings where shipment_id = sh.id;
    if n = 0 then raise exception 'REFUSED: container is empty'; end if;
    update public.shipments set status = 'departed', departed_at = now() where id = sh.id;
    for r in select id from public.bookings where shipment_id = sh.id and status = 'loaded' loop
      update public.bookings set status = 'in_transit' where id = r.id;
      perform public.add_event(r.id, 'in_transit', 'Departed ' || sh.origin_branch,
              coalesce(p_note, coalesce(sh.vessel_or_flight, '') || case when sh.eta is not null then ' · ETA ' || to_char(sh.eta, 'DD Mon YYYY') else '' end),
              sh.origin_branch);
    end loop;
  elsif p_status = 'arrived' then
    if sh.status <> 'departed' then raise exception 'REFUSED: container must be departed first'; end if;
    update public.shipments set status = 'arrived', arrived_at = now() where id = sh.id;
    for r in select id from public.bookings where shipment_id = sh.id and status = 'in_transit' loop
      update public.bookings set status = 'arrived' where id = r.id;
      perform public.add_event(r.id, 'arrived', 'Arrived at ' || sh.destination_branch, p_note, sh.destination_branch);
    end loop;
  elsif p_status = 'completed' then
    if sh.status <> 'arrived' then raise exception 'REFUSED: container must arrive first'; end if;
    update public.shipments set status = 'completed' where id = sh.id;
  else
    raise exception 'REFUSED: invalid status change';
  end if;
  perform public.log_audit('shipment.status', 'shipment', sh.id::text, jsonb_build_object('ref', sh.ref, 'to', p_status));
end $$;

-- Stage 07 · Clearance / ready for collection
create or replace function public.set_booking_status(p_booking uuid, p_status booking_status, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  perform public.require_role('operations','manager');
  perform public.rpc_mode();
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null then raise exception 'NOT_FOUND: booking'; end if;
  if not ((b.status = 'arrived'  and p_status in ('clearing','ready')) or
          (b.status = 'clearing' and p_status = 'ready')) then
    raise exception 'REFUSED: cannot move from % to %', b.status, p_status;
  end if;
  update public.bookings set status = p_status where id = b.id;
  perform public.add_event(b.id, p_status,
          case p_status when 'clearing' then 'Customs clearance in progress' else 'Ready for collection' end,
          p_note, b.destination_branch);
  perform public.log_audit('booking.status', 'booking', b.id::text, jsonb_build_object('ref', b.ref, 'to', p_status));
end $$;

create or replace function public.add_tracking_note(p_booking uuid, p_title text, p_note text, p_public boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  perform public.require_role('operations','manager','counter','warehouse');
  select * into b from public.bookings where id = p_booking;
  if b.id is null then raise exception 'NOT_FOUND: booking'; end if;
  perform public.add_event(b.id, null, p_title, p_note, null, coalesce(p_public, true));
end $$;

-- Stage 08 · Release. Settlement gate + segregation.
create or replace function public.release_booking(
  p_booking uuid, p_name text, p_phone text, p_id_type text default null, p_id_number text default null,
  p_notes text default null, p_override_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b public.bookings; me public.profiles; bal numeric; v_ref text; v_id uuid;
begin
  perform public.require_role('release_officer','manager');
  perform public.rpc_mode();
  select * into me from public.profiles where id = auth.uid();
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null then raise exception 'NOT_FOUND: booking'; end if;
  if b.status <> 'ready' then raise exception 'REFUSED: booking is % — mark it Ready for collection first', b.status; end if;
  if coalesce(trim(p_name),'') = '' or coalesce(trim(p_phone),'') = '' then
    raise exception 'REFUSED: collector name and phone are required';
  end if;

  select balance_usd into bal from public.v_bookings where id = b.id;
  if bal > 0.009 then
    if me.role = 'admin' and coalesce(trim(p_override_reason),'') <> '' then
      perform public.log_audit('release.override', 'booking', b.id::text,
              jsonb_build_object('ref', b.ref, 'balance', bal, 'reason', p_override_reason));
    else
      raise exception 'SETTLEMENT_GATE: balance of USD % is outstanding — cargo cannot be released', bal;
    end if;
  end if;

  if me.role <> 'admin' and exists (select 1 from public.receipts r where r.booking_id = b.id and not r.void and r.received_by = auth.uid()) then
    raise exception 'SEGREGATION: you collected cash on this booking — another person must authorise release';
  end if;

  v_ref := 'HC-REL-' || public.yymm() || '-' || lpad(public.next_counter('REL-' || public.yymm())::text, 4, '0');
  insert into public.releases(ref, booking_id, released_to_name, released_to_phone, id_type, id_number,
                              balance_at_release, override_reason, notes, released_by)
  values (v_ref, b.id, p_name, p_phone, p_id_type, p_id_number, bal, nullif(trim(p_override_reason),''), p_notes, auth.uid())
  returning id into v_id;
  update public.bookings set status = 'released' where id = b.id;
  perform public.add_event(b.id, 'released', 'Cargo collected', 'Released to ' || p_name, b.destination_branch);
  perform public.log_audit('release.create', 'booking', b.id::text, jsonb_build_object('ref', b.ref, 'release', v_ref));
  return jsonb_build_object('id', v_id, 'ref', v_ref);
end $$;

create or replace function public.cancel_booking(p_booking uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  perform public.require_role('manager');
  perform public.rpc_mode();
  if coalesce(trim(p_reason),'') = '' then raise exception 'REFUSED: a reason is required'; end if;
  select * into b from public.bookings where id = p_booking for update;
  if b.status not in ('pending_deposit','booked','received') then
    raise exception 'REFUSED: booking is % and can no longer be cancelled', b.status;
  end if;
  update public.bookings set status = 'cancelled', cancelled_reason = p_reason where id = b.id;
  update public.invoices set status = 'void', void_reason = 'Booking cancelled: ' || p_reason where booking_id = b.id and status = 'issued';
  perform public.add_event(b.id, 'cancelled', 'Booking cancelled', p_reason, null, false);
  perform public.log_audit('booking.cancel', 'booking', b.id::text, jsonb_build_object('ref', b.ref, 'reason', p_reason));
end $$;

-- Dashboard
create or replace function public.dashboard_stats()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not public.is_staff() then raise exception 'NOT_ALLOWED'; end if;
  select jsonb_build_object(
    'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.bookings group by status) x), '{}'::jsonb),
    'collected_today_usd', coalesce((select sum(case when kind='refund' then -amount_usd else amount_usd end) from public.receipts
                                      where not void and received_at >= date_trunc('day', now() at time zone 'Asia/Dubai') at time zone 'Asia/Dubai'), 0),
    'collected_month_usd', coalesce((select sum(case when kind='refund' then -amount_usd else amount_usd end) from public.receipts
                                      where not void and received_at >= date_trunc('month', now() at time zone 'Asia/Dubai') at time zone 'Asia/Dubai'), 0),
    'outstanding_usd', coalesce((select sum(balance_usd) from public.v_bookings where status not in ('cancelled','pending_deposit') and balance_usd > 0), 0),
    'shipments', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.shipments group by status) y), '{}'::jsonb),
    'cbm_in_warehouse', coalesce((select sum(cbm) from public.bookings where status = 'received'), 0),
    'recent_events', coalesce((select jsonb_agg(e) from (select booking_ref, title, note, location, created_at
                               from public.v_events order by created_at desc limit 8) e), '[]'::jsonb)
  ) into res;
  return res;
end $$;

-- Public tracking (anon allowed) — returns no customer money or contact details
create or replace function public.track_shipment(p_ref text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare b public.bookings; sh public.shipments; res jsonb;
begin
  select * into b from public.bookings where upper(ref) = upper(trim(p_ref)) and status <> 'cancelled';
  if b.id is null then return null; end if;
  select * into sh from public.shipments where id = b.shipment_id;
  select jsonb_build_object(
    'ref', b.ref, 'mode', b.mode, 'origin', b.origin_branch, 'destination', b.destination_branch,
    'status', b.status, 'pieces', coalesce(b.pieces, b.est_pieces), 'cbm', b.cbm,
    'consignee', left(b.consignee_name, 1) || '***',
    'eta', sh.eta, 'container_no', sh.container_no,
    'events', coalesce((select jsonb_agg(jsonb_build_object('title', title, 'note', note, 'location', location,
                                                             'status', status, 'at', created_at) order by created_at desc)
                        from public.tracking_events where booking_id = b.id and is_public), '[]'::jsonb)
  ) into res;
  return res;
end $$;

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.branches         enable row level security;
alter table public.profiles         enable row level security;
alter table public.settings         enable row level security;
alter table public.counters         enable row level security;
alter table public.customers        enable row level security;
alter table public.cargo_categories enable row level security;
alter table public.shipments        enable row level security;
alter table public.bookings         enable row level security;
alter table public.grns             enable row level security;
alter table public.grn_lines        enable row level security;
alter table public.invoices         enable row level security;
alter table public.invoice_lines    enable row level security;
alter table public.receipts         enable row level security;
alter table public.tracking_events  enable row level security;
alter table public.releases         enable row level security;
alter table public.audit_log        enable row level security;

do $$
declare t text;
begin
  -- read access for all active staff
  foreach t in array array['branches','settings','customers','cargo_categories','shipments','bookings','grns',
                           'grn_lines','invoices','invoice_lines','receipts','tracking_events','releases'] loop
    execute format('drop policy if exists staff_read on public.%I', t);
    execute format('create policy staff_read on public.%I for select to authenticated using (public.is_staff())', t);
  end loop;
end $$;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.has_role('admin')) with check (id = auth.uid() or public.has_role('admin'));

drop policy if exists audit_read on public.audit_log;
create policy audit_read on public.audit_log for select to authenticated using (public.has_role('manager'));

drop policy if exists branches_admin on public.branches;
create policy branches_admin on public.branches for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

drop policy if exists settings_update on public.settings;
create policy settings_update on public.settings for update to authenticated
  using (public.has_role('manager')) with check (public.has_role('manager'));

drop policy if exists customers_insert on public.customers;
create policy customers_insert on public.customers for insert to authenticated
  with check (public.has_role('manager','counter','cashier'));
drop policy if exists customers_update on public.customers;
create policy customers_update on public.customers for update to authenticated
  using (public.has_role('manager','counter','cashier')) with check (public.has_role('manager','counter','cashier'));

drop policy if exists categories_write on public.cargo_categories;
create policy categories_write on public.cargo_categories for all to authenticated
  using (public.has_role('manager')) with check (public.has_role('manager'));

drop policy if exists bookings_insert on public.bookings;
create policy bookings_insert on public.bookings for insert to authenticated
  with check (public.has_role('manager','counter'));
drop policy if exists bookings_update on public.bookings;
create policy bookings_update on public.bookings for update to authenticated
  using (public.has_role('manager','counter') and status not in ('released','cancelled'))
  with check (public.has_role('manager','counter'));

drop policy if exists shipments_insert on public.shipments;
create policy shipments_insert on public.shipments for insert to authenticated
  with check (public.has_role('manager','operations'));
drop policy if exists shipments_update on public.shipments;
create policy shipments_update on public.shipments for update to authenticated
  using (public.has_role('manager','operations')) with check (public.has_role('manager','operations'));

-- grns, grn_lines, invoices, invoice_lines, receipts, tracking_events, releases, counters:
-- no insert/update/delete policies → writable only through the RPCs above.

-- ---------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;
grant select, insert, update on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke delete on all tables in schema public from authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.track_shipment(text) to anon;

-- internal helpers must never be callable from the API
revoke execute on function public.next_counter(text)            from authenticated;
revoke execute on function public.log_audit(text,text,text,jsonb) from authenticated;
revoke execute on function public.add_event(uuid,booking_status,text,text,text,boolean) from authenticated;
revoke execute on function public.rpc_mode()                     from authenticated;
revoke execute on function public.recalc_invoice(uuid)           from authenticated;
revoke execute on function public.handle_new_user()              from authenticated;
revoke execute on function public.trg_customer_before()          from authenticated;
revoke execute on function public.trg_booking_before()           from authenticated;
revoke execute on function public.trg_booking_after_insert()     from authenticated;
revoke execute on function public.trg_shipment_before()          from authenticated;
revoke execute on function public.trg_profile_guard()            from authenticated;
