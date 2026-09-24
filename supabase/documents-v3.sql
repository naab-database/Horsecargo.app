-- =====================================================================
--  HORSE CARGO — v3: GRN without dimensions · TZS billing · document QR
--  verification & approval
--  Run AFTER schema.sql, seed.sql, accounting-1-roles.sql, accounting-2.sql,
--  shipments-v2.sql.  Idempotent — safe to run again.
-- =====================================================================
set client_min_messages = warning;

-- ---------------------------------------------------------------------
-- 1. GRN: length / width / height are optional, CBM can be typed directly
-- ---------------------------------------------------------------------
alter table public.grn_lines alter column length_cm drop not null;
alter table public.grn_lines alter column width_cm  drop not null;
alter table public.grn_lines alter column height_cm drop not null;
alter table public.grn_lines alter column pieces    set default 1;
alter table public.grn_lines add column if not exists cbm_source text;   -- dimensions | manual
do $$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.grn_lines'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ~ '(length_cm|width_cm|height_cm) > ' loop
    execute format('alter table public.grn_lines drop constraint %I', c);
  end loop;
end $$;
alter table public.grn_lines drop constraint if exists grn_lines_dims_positive;
alter table public.grn_lines add constraint grn_lines_dims_positive check (
  (length_cm is null or length_cm > 0) and (width_cm is null or width_cm > 0) and (height_cm is null or height_cm > 0));

-- ---------------------------------------------------------------------
-- 2. MONEY: USD rates → the customer is billed in one currency (TZS by default)
-- ---------------------------------------------------------------------
alter table public.settings add column if not exists default_billing_currency text not null default 'TZS'
  check (default_billing_currency in ('USD','AED','TZS'));
alter table public.invoices      add column if not exists total_txn numeric not null default 0;
alter table public.invoice_lines add column if not exists currency   text;
alter table public.invoice_lines add column if not exists amount_txn numeric;
alter table public.invoice_lines add column if not exists fx_rate    numeric;

-- rounding policy: whole shillings for TZS, 2 decimals for USD / AED — used everywhere
create or replace function public.money_round(p_amount numeric, p_currency text) returns numeric
language sql immutable as $$
  select round(coalesce(p_amount, 0), case when p_currency = 'TZS' then 0 else 2 end)
$$;

create or replace function public.require_fx(p_currency text, p_fx numeric) returns numeric
language plpgsql immutable as $$
begin
  if p_currency = 'USD' then return 1; end if;
  if p_fx is null or p_fx <= 0 then
    raise exception 'REFUSED: a valid exchange rate (1 USD = X %) is required', p_currency;
  end if;
  return p_fx;
end $$;

-- back-fill the billing amounts of invoices issued before this migration
update public.invoice_lines l set currency = i.currency, fx_rate = i.fx_rate,
       amount_txn = public.money_round(l.amount * i.fx_rate, i.currency)
  from public.invoices i where i.id = l.invoice_id and l.amount_txn is null;
update public.invoices i set total_txn = coalesce((select sum(amount_txn) from public.invoice_lines l where l.invoice_id = i.id), 0)
 where i.total_txn = 0;

create or replace function public.recalc_invoice(p_invoice uuid) returns void
language sql security definer set search_path = public as $$
  update public.invoices i set
    total     = coalesce((select round(sum(l.amount), 2)     from public.invoice_lines l where l.invoice_id = i.id), 0),
    total_txn = coalesce((select sum(l.amount_txn)           from public.invoice_lines l where l.invoice_id = i.id), 0)
  where i.id = p_invoice
$$;

-- the freight line: USD rate × chargeable quantity, converted once at the invoice rate
create or replace function public.write_freight_line(p_shipment uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare s public.shipments; inv public.invoices; qty numeric; amt numeric; txt text; unit text;
begin
  select * into s from public.shipments where id = p_shipment;
  select * into inv from public.invoices where shipment_id = p_shipment and status = 'issued';
  if inv.id is null then return 0; end if;
  perform public.require_fx(inv.currency, inv.fx_rate);
  qty  := public.charge_qty(s.mode, s.cbm, coalesce(s.weight_kg, s.actual_kg));
  amt  := public.freight_for(s.mode, s.category_id, qty, s.rate_used);
  unit := case when s.mode = 'sea' then 'CBM' else 'kg' end;
  txt  := initcap(s.mode) || ' freight ' || s.origin_branch || '→' || s.destination_branch ||
          ' · ' || qty || ' ' || unit || ' × USD ' || coalesce(s.rate_used, 0);
  if amt > round(qty * coalesce(s.rate_used,0), 2) then txt := txt || ' (minimum charge)'; end if;
  delete from public.invoice_lines where invoice_id = inv.id and kind = 'freight';
  insert into public.invoice_lines(invoice_id, kind, charge_type, description, qty, unit_price, amount,
                                   currency, fx_rate, amount_txn, created_by)
  values (inv.id, 'freight', 'freight', txt, qty, coalesce(s.rate_used, 0), amt,
          inv.currency, inv.fx_rate, public.money_round(amt * inv.fx_rate, inv.currency), auth.uid());
  update public.shipments set quoted_amount = amt,
         chargeable_kg = case when s.mode = 'air' then qty else s.chargeable_kg end
   where id = p_shipment;
  perform public.recalc_invoice(inv.id);
  return amt;
end $$;

-- a charge is entered in a currency of its own and converted once
create or replace function public.add_charge(p_shipment uuid, p_charge_type text, p_description text,
                                             p_qty numeric default 1, p_unit_price numeric default 0,
                                             p_currency text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.shipments; inv public.invoices; cur text; amt_in numeric; usd numeric; txn numeric;
        v_id bigint; v_kind text;
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

  cur := coalesce(nullif(p_currency,''), inv.currency);
  if cur not in ('USD','AED','TZS') then raise exception 'REFUSED: unsupported currency'; end if;
  if cur <> inv.currency and cur <> 'USD' then
    raise exception 'REFUSED: enter the charge in % or in USD', inv.currency;
  end if;
  perform public.require_fx(inv.currency, inv.fx_rate);

  v_kind := case p_charge_type when 'duty' then 'duty' when 'discount' then 'discount' else 'extra' end;
  amt_in := round(coalesce(p_qty,1) * coalesce(p_unit_price,0), 4);
  if cur = 'USD' then                          -- quoted in USD → convert once
    usd := round(amt_in, 2);
    txn := public.money_round(usd * inv.fx_rate, inv.currency);
  else                                          -- already in the billing currency → never converted again
    txn := public.money_round(amt_in, cur);
    usd := round(txn / inv.fx_rate, 2);
  end if;
  if v_kind = 'discount' then usd := -abs(usd); txn := -abs(txn); end if;

  insert into public.invoice_lines(invoice_id, kind, charge_type, description, qty, unit_price, amount,
                                   currency, fx_rate, amount_txn, created_by)
  values (inv.id, v_kind, p_charge_type, coalesce(nullif(trim(p_description),''), initcap(p_charge_type)),
          coalesce(p_qty,1), coalesce(p_unit_price,0), usd, inv.currency, inv.fx_rate, txn, auth.uid())
  returning id into v_id;
  perform public.recalc_invoice(inv.id);
  perform public.log_audit('charge.add', 'shipment', s.id::text,
          jsonb_build_object('ref', s.ref, 'type', p_charge_type, 'entered', amt_in || ' ' || cur,
                             'usd', usd, 'billed', txn || ' ' || inv.currency));
  return jsonb_build_object('line_id', v_id, 'amount_usd', usd, 'amount_txn', txn, 'currency', inv.currency,
                            'total_txn', (select total_txn from public.invoices where id = inv.id));
end $$;

create or replace function public.add_invoice_line(p_booking uuid, p_kind text, p_description text,
                                                   p_qty numeric, p_unit_price numeric)
returns jsonb language sql security definer set search_path = public as $$
  select public.add_charge(p_booking, case p_kind when 'extra' then 'other' else p_kind end,
                           p_description, p_qty, p_unit_price, 'USD')
$$;

-- changing the currency of THIS invoice re-converts its own lines; other invoices are untouched
create or replace function public.set_invoice_currency(p_shipment uuid, p_currency text, p_fx_rate numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv public.invoices; fx numeric;
begin
  perform public.require_role('manager','cashier','counter');
  perform public.rpc_mode();
  if p_currency not in ('USD','AED','TZS') then raise exception 'REFUSED: unsupported currency'; end if;
  select * into inv from public.invoices where shipment_id = p_shipment and status = 'issued';
  if inv.id is null then raise exception 'NOT_FOUND: invoice'; end if;
  fx := public.require_fx(p_currency, coalesce(nullif(p_fx_rate, 0), public.fx_for(p_currency, null)));
  update public.invoices set currency = p_currency, fx_rate = fx, fx_date = public.hc_today() where id = inv.id;
  update public.invoice_lines set currency = p_currency, fx_rate = fx,
         amount_txn = public.money_round(amount * fx, p_currency)
   where invoice_id = inv.id;
  perform public.recalc_invoice(inv.id);
  perform public.log_audit('invoice.currency', 'invoice', inv.id::text,
          jsonb_build_object('ref', inv.ref, 'currency', p_currency, 'fx', fx));
  return jsonb_build_object('currency', p_currency, 'fx_rate', fx,
                            'total_txn', (select total_txn from public.invoices where id = inv.id));
end $$;

-- money view in the billing currency of each invoice
drop view if exists public.v_shipments cascade;
drop view if exists public.v_shipment_money cascade;
create or replace view public.v_shipment_money with (security_invoker = true) as
select s.id as shipment_id,
       coalesce(i.currency, (select default_billing_currency from public.settings where id = 1), 'TZS') as bill_currency,
       coalesce(i.fx_rate, 1) as bill_fx,
       coalesce(i.total, 0)     as invoice_total,
       coalesce(i.total_txn, 0) as invoice_total_txn,
       coalesce(p.paid_usd, 0)  as paid_usd,
       public.money_round(coalesce(p.paid_txn, 0), coalesce(i.currency,'USD')) as paid_txn
from public.shipments s
left join public.invoices i on i.shipment_id = s.id and i.status = 'issued'
left join lateral (
  select coalesce(sum(case when r.kind = 'refund' then -r.amount_usd else r.amount_usd end), 0) as paid_usd,
         -- a payment made in the billing currency counts at its face value: no round-trip through USD
         coalesce(sum((case when r.kind = 'refund' then -1 else 1 end) *
                      (case when r.currency = coalesce(i.currency, 'USD') then r.amount
                            else public.money_round(r.amount_usd * coalesce(i.fx_rate, 1), coalesce(i.currency, 'USD')) end)), 0) as paid_txn
  from public.receipts r where r.shipment_id = s.id and not r.void) p on true;

create or replace view public.v_shipments with (security_invoker = true) as
select s.*,
       c.code as customer_code, c.name as customer_name, c.phone as customer_phone, c.company as customer_company,
       rc.name as receiver_customer_name,
       cat.name as category_name, cat.name_sw as category_name_sw,
       i.ref as invoice_ref, i.id as invoice_id,
       m.bill_currency as invoice_currency, m.bill_fx as invoice_fx,
       m.invoice_total, m.invoice_total_txn, m.paid_usd, m.paid_txn,
       round(m.invoice_total - m.paid_usd, 2) as balance_usd,
       public.money_round(m.invoice_total_txn - m.paid_txn, m.bill_currency) as balance_txn,
       case when m.invoice_total_txn <= 0 then 'none'
            when m.paid_txn >= m.invoice_total_txn then 'paid'
            when m.paid_txn > 0 then 'part_paid' else 'unpaid' end as payment_status,
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

drop view if exists public.v_invoice_lines cascade;
create or replace view public.v_invoice_lines with (security_invoker = true) as
select l.*, i.ref as invoice_ref, i.issued_at, i.status as invoice_status, i.shipment_id,
       i.currency as invoice_currency, i.fx_rate as invoice_fx, i.total_txn as invoice_total_txn,
       s.ref as shipment_ref, s.mode, s.origin_branch, s.destination_branch, c.name as customer_name,
       p.full_name as created_by_name
from public.invoice_lines l
join public.invoices i on i.id = l.invoice_id
join public.shipments s on s.id = i.shipment_id
join public.customers c on c.id = i.customer_id
left join public.profiles p on p.id = l.created_by;

-- ---------------------------------------------------------------------
-- 3. CREATE SHIPMENT · default billing currency, mandatory exchange rate
-- ---------------------------------------------------------------------
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
  if rate is null or rate = base then rate := base; src := 'category';
  else
    if not public.has_role('manager') then raise exception 'NOT_ALLOWED: only a manager can change the rate'; end if;
    src := 'override';
  end if;
  qty     := public.charge_qty(v_mode, v_cbm, v_kg);
  freight := public.freight_for(v_mode, cat, qty, rate);

  cur := coalesce(nullif(p->>'currency',''), (select default_billing_currency from public.settings where id = 1), 'TZS');
  if cur not in ('USD','AED','TZS') then raise exception 'REFUSED: unsupported currency'; end if;
  fx  := public.require_fx(cur, public.fx_for(cur, nullif(p->>'fx_rate','')::numeric));

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

  inv_ref := 'HC-INV-' || public.yymm() || '-' || lpad(public.next_counter('INV-' || public.yymm())::text, 4, '0');
  insert into public.invoices(ref, shipment_id, customer_id, currency, fx_rate, fx_date, total, created_by)
  values (inv_ref, s_id, sender, cur, fx, public.hc_today(), freight, auth.uid()) returning id into inv_id;

  perform public.write_freight_line(s_id);

  for ch in select * from jsonb_array_elements(coalesce(p->'charges', '[]'::jsonb)) loop
    if coalesce((ch->>'amount')::numeric, 0) <> 0 then
      perform public.add_charge(s_id, coalesce(nullif(ch->>'charge_type',''), 'other'),
              nullif(ch->>'description',''), 1, (ch->>'amount')::numeric,
              coalesce(nullif(ch->>'currency',''), 'USD'));
    end if;
  end loop;

  perform public.add_event(s_id, 'received_dubai', 'Received at Dubai office',
          n || ' item(s) · ' || case when v_mode = 'sea' then coalesce(v_cbm,0) || ' CBM' else coalesce(v_kg,0) || ' kg' end, orig);
  perform public.log_audit('shipment.create', 'shipment', s_id::text,
          jsonb_build_object('ref', v_ref, 'mode', v_mode, 'freight_usd', freight, 'invoice', inv_ref,
                             'currency', cur, 'fx', fx));

  return jsonb_build_object('id', s_id, 'ref', v_ref, 'invoice_id', inv_id, 'invoice_ref', inv_ref,
                            'freight', freight, 'qty', qty, 'rate', rate, 'currency', cur, 'fx_rate', fx,
                            'total', (select total from public.invoices where id = inv_id),
                            'total_txn', (select total_txn from public.invoices where id = inv_id));
end $$;

-- ---------------------------------------------------------------------
-- 4. PAYMENTS · no double conversion, no duplicate submissions
-- ---------------------------------------------------------------------
create or replace function public.record_payment(
  p_shipment uuid, p_amount numeric, p_currency text, p_method text,
  p_reference text default null, p_fx_rate numeric default null, p_account uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.shipments; me public.profiles; inv public.invoices; rate numeric; usd numeric;
        v_ref text; v_id uuid; v_kind text; dup uuid;
begin
  perform public.require_role('cashier','manager','counter');
  perform public.rpc_mode();
  select * into me from public.profiles where id = auth.uid();
  select * into s  from public.shipments where id = p_shipment for update;
  if s.id is null then raise exception 'NOT_FOUND: shipment'; end if;
  if s.status = 'cancelled' then raise exception 'REFUSED: shipment is cancelled'; end if;
  if coalesce(p_amount,0) <= 0 then raise exception 'REFUSED: amount must be greater than zero'; end if;
  if p_currency not in ('USD','AED','TZS') then raise exception 'REFUSED: unsupported currency'; end if;

  select * into inv from public.invoices where shipment_id = p_shipment and status = 'issued';
  -- the invoice rate is the default so a payment in the billing currency is never re-converted
  rate := case when p_fx_rate is not null and p_fx_rate > 0 then p_fx_rate
               when inv.id is not null and inv.currency = p_currency then inv.fx_rate
               else public.fx_for(p_currency, null) end;
  rate := public.require_fx(p_currency, rate);
  usd  := round(p_amount / rate, 2);

  -- duplicate guard: same shipment, amount, currency and method within two minutes
  select id into dup from public.receipts
   where shipment_id = p_shipment and not void and currency = p_currency and amount = p_amount
     and method = p_method and coalesce(reference,'') = coalesce(p_reference,'')
     and received_at > now() - interval '2 minutes' limit 1;
  if dup is not null then
    raise exception 'DUPLICATE: the same payment was just recorded (receipt %)',
      (select ref from public.receipts where id = dup);
  end if;

  v_kind := case when inv.id is null then 'deposit' else 'payment' end;
  v_ref  := 'HC-RCT-' || public.yymm() || '-' || lpad(public.next_counter('RCT-' || public.yymm())::text, 4, '0');
  insert into public.receipts(ref, shipment_id, customer_id, kind, currency, amount, fx_rate, amount_usd,
                              method, reference, branch_code, received_by)
  values (v_ref, s.id, s.customer_id, v_kind, p_currency, p_amount, rate, usd,
          p_method, p_reference, me.branch_code, auth.uid())
  returning id into v_id;
  if p_account is not null then update public.receipts set money_account_id = p_account where id = v_id; end if;

  perform public.log_audit('receipt.create', 'receipt', v_id::text,
          jsonb_build_object('ref', v_ref, 'shipment', s.ref, 'amount', p_amount || ' ' || p_currency, 'usd', usd));
  return jsonb_build_object('id', v_id, 'ref', v_ref, 'amount', p_amount, 'currency', p_currency,
                            'fx_rate', rate, 'amount_usd', usd, 'kind', v_kind,
                            'balance_txn', (select balance_txn from public.v_shipments where id = s.id));
end $$;

-- ---------------------------------------------------------------------
-- 5. GRN · dimensions optional, CBM may be typed directly
-- ---------------------------------------------------------------------
create or replace function public.record_grn(
  p_shipment uuid, p_lines jsonb, p_condition text default 'good',
  p_notes text default null, p_photos text[] default '{}', p_reprice boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.shipments; st public.settings; g_id uuid; g_ref text; ln jsonb;
        t_pieces int := 0; t_cbm numeric := 0; t_kg numeric := 0; l_cbm numeric; l_src text;
        vol_kg numeric; charge_kg numeric; freight numeric; pcs int; dims boolean;
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
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'REFUSED: add at least one line'; end if;

  g_ref := 'HC-GRN-' || s.origin_branch || '-' || public.yymm() || '-' ||
           lpad(public.next_counter('GRN-' || s.origin_branch || '-' || public.yymm())::text, 4, '0');
  insert into public.grns(ref, shipment_id, branch_code, pieces, total_cbm, total_kg, volumetric_kg, chargeable_kg,
                          condition, condition_notes, photos, received_by)
  values (g_ref, s.id, s.origin_branch, 0, 0, 0, 0, 0, coalesce(p_condition,'good'), p_notes, coalesce(p_photos,'{}'), auth.uid())
  returning id into g_id;

  for ln in select * from jsonb_array_elements(p_lines) loop
    pcs  := greatest(coalesce(nullif(ln->>'pieces','')::int, 1), 1);
    dims := (nullif(ln->>'length_cm','') is not null and nullif(ln->>'width_cm','') is not null
             and nullif(ln->>'height_cm','') is not null);
    if nullif(ln->>'cbm','') is not null then                 -- typed by hand: never overwritten
      l_cbm := round((ln->>'cbm')::numeric, 4); l_src := 'manual';
    elsif dims then                                            -- calculated from the measurements
      l_cbm := round(pcs * (ln->>'length_cm')::numeric * (ln->>'width_cm')::numeric
                     * (ln->>'height_cm')::numeric / 1000000, 4); l_src := 'dimensions';
    else
      l_cbm := 0; l_src := null;                               -- goods acknowledged without measurements
    end if;
    insert into public.grn_lines(grn_id, pieces, length_cm, width_cm, height_cm, weight_kg, cbm, cbm_source, packaging)
    values (g_id, pcs, nullif(ln->>'length_cm','')::numeric, nullif(ln->>'width_cm','')::numeric,
            nullif(ln->>'height_cm','')::numeric, coalesce(nullif(ln->>'weight_kg','')::numeric, 0), l_cbm, l_src, ln->>'packaging');
    t_pieces := t_pieces + pcs;
    t_cbm    := t_cbm + l_cbm;
    t_kg     := t_kg + coalesce(nullif(ln->>'weight_kg','')::numeric, 0);
  end loop;

  t_cbm := round(t_cbm, 3);
  if nullif(p_notes,'') is null then null; end if;
  vol_kg    := round(t_cbm * 1000000 / st.air_volumetric_divisor, 1);
  charge_kg := greatest(t_kg, vol_kg);
  update public.grns set pieces = t_pieces, total_cbm = t_cbm, total_kg = t_kg,
         volumetric_kg = vol_kg, chargeable_kg = charge_kg where id = g_id;
  update public.shipments set pieces = t_pieces,
         cbm = case when t_cbm > 0 then t_cbm else cbm end,        -- no measurements → keep what was declared
         actual_kg = case when t_kg > 0 then t_kg else actual_kg end,
         volumetric_kg = vol_kg, chargeable_kg = charge_kg,
         weight_kg = case when mode = 'air' and t_kg > 0 then t_kg else weight_kg end
   where id = s.id;

  if p_reprice then
    if not public.has_role('manager') then raise exception 'NOT_ALLOWED: only a manager can re-price from the GRN'; end if;
    freight := public.write_freight_line(s.id);
  end if;

  perform public.add_event(s.id, null, 'Cargo measured (GRN ' || g_ref || ')',
          t_pieces || ' pcs' || case when t_cbm > 0 then ' · ' || t_cbm || ' CBM' else '' end
          || case when t_kg > 0 then ' · ' || t_kg || ' kg' else '' end, s.origin_branch);
  perform public.log_audit('grn.create', 'grn', g_id::text,
          jsonb_build_object('ref', g_ref, 'shipment', s.ref, 'cbm', t_cbm, 'kg', t_kg, 'repriced', p_reprice));
  return jsonb_build_object('grn_id', g_id, 'grn_ref', g_ref, 'pieces', t_pieces, 'cbm', t_cbm, 'kg', t_kg,
                            'chargeable_kg', charge_kg, 'freight', freight);
end $$;

-- ---------------------------------------------------------------------
-- 6. DOCUMENT REGISTRY · QR verification & approval
--    Approval is separate from shipment status and from payment status.
-- ---------------------------------------------------------------------
create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  token        text unique not null default encode(gen_random_bytes(18), 'hex'),  -- opaque, unguessable
  doc_type     text not null check (doc_type in ('invoice','receipt','grn','release','waybill')),
  doc_id       text not null,
  shipment_id  uuid references public.shipments(id) on delete cascade,
  doc_ref      text,
  issued_at    timestamptz,
  version      int  not null default 1,
  status       text not null default 'pending' check (status in ('pending','approved','rejected')),
  approved_version int,
  approved_by  uuid,
  approved_at  timestamptz,
  decision_note text,
  created_at   timestamptz not null default now(),
  unique (doc_type, doc_id)
);
create index if not exists documents_shipment_idx on public.documents(shipment_id);

create table if not exists public.document_approvals (
  id          bigserial primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  version     int  not null,
  action      text not null check (action in ('approved','rejected','superseded')),
  note        text,
  acted_by    uuid,
  acted_at    timestamptz not null default now()
);
create index if not exists doc_appr_idx on public.document_approvals(document_id, acted_at desc);

-- resolve the reference / date / shipment of any supported document
create or replace function public.doc_meta(p_type text, p_doc_id text)
returns table(doc_ref text, issued_at timestamptz, shipment_id uuid)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_type = 'invoice' then
    return query select i.ref, i.issued_at, i.shipment_id from public.invoices i where i.id = p_doc_id::uuid;
  elsif p_type = 'receipt' then
    return query select r.ref, r.received_at, r.shipment_id from public.receipts r where r.id = p_doc_id::uuid;
  elsif p_type = 'grn' then
    return query select g.ref, g.received_at, g.shipment_id from public.grns g where g.id = p_doc_id::uuid;
  elsif p_type = 'release' then
    return query select r.ref, r.released_at, r.shipment_id from public.releases r where r.id = p_doc_id::uuid;
  elsif p_type = 'waybill' then
    return query select s.ref, s.created_at, s.id from public.shipments s where s.id = p_doc_id::uuid;
  end if;
end $$;

-- called by the app when a document is opened or printed
create or replace function public.doc_register(p_type text, p_doc_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.documents; m record;
begin
  if not public.is_staff() then raise exception 'NOT_ALLOWED: your role cannot perform this action'; end if;
  if p_type not in ('invoice','receipt','grn','release','waybill') then raise exception 'REFUSED: unknown document type'; end if;
  select * into d from public.documents where doc_type = p_type and doc_id = p_doc_id;
  if d.id is null then
    select * into m from public.doc_meta(p_type, p_doc_id);
    if m.doc_ref is null then raise exception 'NOT_FOUND: document'; end if;
    insert into public.documents(doc_type, doc_id, shipment_id, doc_ref, issued_at)
    values (p_type, p_doc_id, m.shipment_id, m.doc_ref, m.issued_at)
    on conflict (doc_type, doc_id) do update set doc_ref = excluded.doc_ref
    returning * into d;
  end if;
  return jsonb_build_object('token', d.token, 'status', d.status, 'version', d.version,
                            'ref', d.doc_ref, 'type', d.doc_type,
                            'approved_by', (select full_name from public.profiles where id = d.approved_by),
                            'approved_at', d.approved_at);
end $$;

-- a material change invalidates an approval and asks for a new one
create or replace function public.doc_touch(p_type text, p_doc_id text, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d public.documents;
begin
  select * into d from public.documents where doc_type = p_type and doc_id = p_doc_id for update;
  if d.id is null then return; end if;
  if d.status = 'pending' then return; end if;                    -- already waiting for approval
  insert into public.document_approvals(document_id, version, action, note, acted_by)
  values (d.id, d.version, 'superseded', coalesce(p_reason, 'document changed after approval'), auth.uid());
  -- approved_version is kept so the verification page can say "this printed copy is out of date"
  update public.documents set version = version + 1, status = 'pending', decision_note = null
   where id = d.id;
  perform public.log_audit('document.superseded', 'document', d.id::text,
          jsonb_build_object('ref', d.doc_ref, 'type', d.doc_type, 'version', d.version + 1));
end $$;

create or replace function public.approve_document(p_token text, p_approve boolean default true, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.documents;
begin
  perform public.require_role('manager','finance_manager');
  select * into d from public.documents where token = p_token for update;
  if d.id is null then raise exception 'NOT_FOUND: document'; end if;
  if not p_approve and coalesce(trim(p_note),'') = '' then raise exception 'REFUSED: a reason is required'; end if;
  if d.status = (case when p_approve then 'approved' else 'rejected' end) and d.approved_version = d.version then
    raise exception 'REFUSED: this version was already %', d.status;
  end if;
  update public.documents set status = (case when p_approve then 'approved' else 'rejected' end),
         approved_by = auth.uid(), approved_at = now(), approved_version = d.version, decision_note = p_note
   where id = d.id;
  insert into public.document_approvals(document_id, version, action, note, acted_by)
  values (d.id, d.version, (case when p_approve then 'approved' else 'rejected' end), p_note, auth.uid());
  perform public.log_audit(case when p_approve then 'document.approve' else 'document.reject' end,
          'document', d.id::text, jsonb_build_object('ref', d.doc_ref, 'type', d.doc_type, 'version', d.version, 'note', p_note));
  return jsonb_build_object('status', (case when p_approve then 'approved' else 'rejected' end), 'version', d.version);
end $$;

-- public verification (anon): minimal facts only, never money or contact details
create or replace function public.verify_document(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d public.documents; s public.shipments; res jsonb;
begin
  select * into d from public.documents where token = trim(p_token);
  if d.id is null then return jsonb_build_object('found', false); end if;
  select * into s from public.shipments where id = d.shipment_id;
  select jsonb_build_object(
    'found', true,
    'company', (select company_name from public.settings where id = 1),
    'document_type', d.doc_type,
    'document_no', d.doc_ref,
    'shipment_ref', s.ref,
    'issued_at', d.issued_at,
    'version', d.version,
    'status', case when s.status = 'cancelled' then 'void' else d.status end,
    'approved_by', (select full_name from public.profiles where id = d.approved_by),
    'approved_at', d.approved_at,
    'superseded', (d.approved_version is not null and d.approved_version <> d.version),
    'shipment_status', s.status,
    'checked_at', now()
  ) into res;
  return res;
end $$;

-- v_customers depends on v_shipments and is rebuilt here
create or replace view public.v_customers with (security_invoker = true) as
select c.*,
       (select count(*) from public.shipments s where s.customer_id = c.id or s.receiver_customer_id = c.id) as shipment_count,
       (select coalesce(sum(vs.balance_usd),0) from public.v_shipments vs
         where vs.customer_id = c.id and vs.status <> 'cancelled') as balance_usd,
       (select coalesce(sum(vs.balance_txn),0) from public.v_shipments vs
         where vs.customer_id = c.id and vs.status <> 'cancelled'
           and vs.invoice_currency = (select default_billing_currency from public.settings where id = 1)) as balance_txn
from public.customers c;

create or replace view public.v_documents with (security_invoker = true) as
select d.*, s.ref as shipment_ref, p.full_name as approved_by_name
from public.documents d
left join public.shipments s on s.id = d.shipment_id
left join public.profiles p on p.id = d.approved_by;

create or replace view public.v_document_approvals with (security_invoker = true) as
select a.*, d.doc_type, d.doc_ref, p.full_name as acted_by_name
from public.document_approvals a
join public.documents d on d.id = a.document_id
left join public.profiles p on p.id = a.acted_by;

-- material edits → the approval no longer applies
create or replace function public.trg_doc_invoice_lines() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.doc_touch('invoice', coalesce(new.invoice_id, old.invoice_id)::text, 'invoice line changed');
  return null;
end $$;
drop trigger if exists doc_invoice_lines on public.invoice_lines;
create trigger doc_invoice_lines after insert or update or delete on public.invoice_lines
  for each row execute function public.trg_doc_invoice_lines();

create or replace function public.trg_doc_invoices() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.currency is distinct from old.currency or new.fx_rate is distinct from old.fx_rate
     or new.total_txn is distinct from old.total_txn or new.status is distinct from old.status then
    perform public.doc_touch('invoice', new.id::text, 'invoice totals or currency changed');
  end if;
  return null;
end $$;
drop trigger if exists doc_invoices on public.invoices;
create trigger doc_invoices after update on public.invoices
  for each row execute function public.trg_doc_invoices();

create or replace function public.trg_doc_receipts() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.void and not old.void then perform public.doc_touch('receipt', new.id::text, 'receipt voided'); end if;
  return null;
end $$;
drop trigger if exists doc_receipts on public.receipts;
create trigger doc_receipts after update of void on public.receipts
  for each row execute function public.trg_doc_receipts();

create or replace function public.trg_doc_shipments() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.cbm is distinct from old.cbm or new.weight_kg is distinct from old.weight_kg
     or new.rate_used is distinct from old.rate_used or new.mode is distinct from old.mode
     or new.destination_branch is distinct from old.destination_branch
     or new.receiver_name is distinct from old.receiver_name then
    perform public.doc_touch('waybill', new.id::text, 'shipment details changed');
    perform public.doc_touch('grn', (select id::text from public.grns where shipment_id = new.id), 'shipment details changed');
  end if;
  return null;
end $$;
drop trigger if exists doc_shipments on public.shipments;
create trigger doc_shipments after update on public.shipments
  for each row execute function public.trg_doc_shipments();

-- ---------------------------------------------------------------------
-- 7. RLS & GRANTS
-- ---------------------------------------------------------------------
alter table public.documents          enable row level security;
alter table public.document_approvals enable row level security;
drop policy if exists staff_read on public.documents;
create policy staff_read on public.documents for select to authenticated using (public.is_staff());
drop policy if exists staff_read on public.document_approvals;
create policy staff_read on public.document_approvals for select to authenticated using (public.is_staff());

grant select, insert, update on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke delete on all tables in schema public from authenticated;
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.track_shipment(text)  to anon;
grant execute on function public.verify_document(text) to anon;

do $$
declare f text;
begin
  foreach f in array array[
    'next_counter(text)', 'next_shipment_ref()', 'log_audit(text,text,text,jsonb)', 'rpc_mode()',
    'recalc_invoice(uuid)', 'write_freight_line(uuid)', 'resolve_customer(jsonb,text)', 'handle_new_user()',
    'add_event(uuid,public.ship_status,text,text,text,boolean,public.ship_status)',
    'trg_customer_before()', 'trg_customer_norm()', 'trg_shipment_before()', 'trg_profile_guard()',
    'doc_touch(text,text,text)', 'doc_meta(text,text)',
    'trg_doc_invoice_lines()', 'trg_doc_invoices()', 'trg_doc_receipts()', 'trg_doc_shipments()',
    'acc_post(text,date,text,text,text,jsonb,uuid,uuid,text)', 'acc_reverse(uuid,text,date)',
    'acc_reverse_source(text,text,text)', 'acc_post_receipt(uuid)', 'acc_void_receipt(uuid)',
    'acc_post_invoice_line(bigint)', 'acc_apply_deposits(uuid,uuid)', 'acc_seed_coa(text)',
    'acc_add_money_account(text,text,text,text,text,text,text)', 'acc_check_cost_account(text,text)',
    'trg_acc_receipts()', 'trg_acc_invoice_lines()', 'trg_acc_invoices()', 'trg_supplier_code()',
    'acc_post_costs(text,date,text,text,text,jsonb,jsonb,uuid,text,numeric,text)'
  ] loop
    begin execute 'revoke execute on function public.' || f || ' from authenticated';
    exception when undefined_function then null; end;
  end loop;
end $$;
