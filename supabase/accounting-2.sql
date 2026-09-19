-- =====================================================================
--  HORSE CARGO — Accounting module A1 · step 2 of 2
--  Run after schema.sql, seed.sql and accounting-1-roles.sql.
--  Safe to re-run (idempotent).
--
--  Design
--   • Two companies: AE (Dubai, UAE) and TZ (Dar es Salaam + Mwanza).
--     Every branch belongs to one company.
--   • Double-entry general ledger per company, book currency USD.
--     Each line also keeps the original currency, amount and rate.
--   • Shipping events post automatically (triggers), so staff never
--     re-key anything:
--       receipt ............ Dr Cash/Bank/Mobile   Cr Customer deposits | AR
--       invoice line (GRN) . Dr AR                 Cr Freight revenue (sea/air)
--       extra charge ....... Dr AR                 Cr Handling & other revenue
--       duty line .......... Dr AR                 Cr Duty clearing (liability — not revenue)
--       discount ........... Dr Sales discounts    Cr AR          (contra-revenue)
--       deposits applied ... Dr Customer deposits  Cr AR          (when the invoice is issued)
--       void / remove ...... reversal entry — the original is never deleted
--   • The booking's ORIGIN branch decides the owning company. Cash taken
--     or costs paid by the other company post intercompany on both sides.
--   • Supplier bills and expenses can be linked to a container or booking;
--     the cost lands in the owning company and feeds the container P&L.
-- =====================================================================

-- ---------------------------------------------------------------------
-- COMPANIES & BRANCHES
-- ---------------------------------------------------------------------
create table if not exists public.companies (
  code               text primary key,          -- AE, TZ
  name               text not null,
  country            text not null,
  statutory_currency text not null,
  tax_number         text,
  address            text,
  phone              text,
  email              text,
  active             boolean not null default true
);
insert into public.companies(code, name, country, statutory_currency, address, phone, email) values
 ('AE', 'Horse Cargo — UAE', 'UAE', 'AED', 'Al Badri Building, Floor 2, Office S201, Baniyas Square, Deira, Dubai', '+971 50 608 3531', 'info@horsecargoltd.com'),
 ('TZ', 'Horse Cargo Company Ltd — Tanzania', 'Tanzania', 'TZS', 'Rufiji St & Swahili St, Dar es Salaam', '+255 778 222 251', 'info@horsecargoltd.com')
on conflict (code) do nothing;

alter table public.branches add column if not exists company_code text references public.companies(code);
update public.branches set company_code = 'AE' where code = 'DXB' and company_code is null;
update public.branches set company_code = 'TZ' where code in ('DAR','MWZ') and company_code is null;
update public.branches set company_code = case when country ilike 'tanzania%' then 'TZ' else 'AE' end where company_code is null;

create or replace function public.branch_company(p_branch text) returns text
language sql stable security definer set search_path = public as $$
  select company_code from public.branches where code = p_branch
$$;

-- ---------------------------------------------------------------------
-- CHART OF ACCOUNTS
-- ---------------------------------------------------------------------
create table if not exists public.accounts (
  id           uuid primary key default gen_random_uuid(),
  company_code text not null references public.companies(code),
  code         text not null,
  name         text not null,
  name_sw      text,
  type         text not null check (type in ('asset','liability','equity','revenue','contra_revenue','cost_of_sales','expense')),
  system_key   text,
  is_money     boolean not null default false,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (company_code, code)
);
create unique index if not exists accounts_system_key_idx on public.accounts(company_code, system_key) where system_key is not null;

create or replace function public.acc_seed_coa(p_company text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.accounts(company_code, code, name, name_sw, type, system_key) values
   (p_company,'1190','Undeposited funds / cash in transit','Fedha zisizowekwa benki','asset','UNDEPOSITED'),
   (p_company,'1300','Accounts receivable — customers','Wadaiwa — wateja','asset','AR'),
   (p_company,'1350','Intercompany receivable','Deni kutoka kampuni dada','asset','IC_DUE_FROM'),
   (p_company,'1400','Prepayments & deposits paid','Malipo ya awali','asset',null),
   (p_company,'1500','Equipment & vehicles','Vifaa na magari','asset',null),
   (p_company,'1590','Accumulated depreciation','Uchakavu uliolimbikizwa','asset',null),
   (p_company,'2100','Accounts payable — suppliers','Wadai — wasambazaji','liability','AP'),
   (p_company,'2150','Intercompany payable','Deni kwa kampuni dada','liability','IC_DUE_TO'),
   (p_company,'2200','Customer deposits (advances)','Amana za wateja','liability','CUST_DEP'),
   (p_company,'2300','Duty & taxes collected for customers','Ushuru uliokusanywa kwa wateja','liability','DUTY_CLEAR'),
   (p_company,'2400','VAT payable','VAT inayolipwa','liability','VAT'),
   (p_company,'2500','Accrued expenses','Gharama zilizolimbikizwa','liability',null),
   (p_company,'2600','Loans & owner advances','Mikopo','liability',null),
   (p_company,'3100','Share capital','Mtaji','equity','CAPITAL'),
   (p_company,'3200','Retained earnings','Faida iliyobaki','equity','RETAINED'),
   (p_company,'3300','Owner drawings','Matumizi ya mmiliki','equity',null),
   (p_company,'3900','Opening balance equity','Salio la kuanzia','equity','OPENING'),
   (p_company,'4100','Sea freight revenue','Mapato — usafiri wa bahari','revenue','REV_SEA'),
   (p_company,'4200','Air freight revenue','Mapato — usafiri wa anga','revenue','REV_AIR'),
   (p_company,'4300','Handling & other charges','Mapato — gharama za ziada','revenue','REV_OTHER'),
   (p_company,'4400','Storage revenue','Mapato — uhifadhi','revenue',null),
   (p_company,'4800','Other income','Mapato mengine','revenue',null),
   (p_company,'4900','Sales discounts','Punguzo la mauzo','contra_revenue','SALES_DISC'),
   (p_company,'5100','Ocean freight — shipping line','Nauli ya meli','cost_of_sales',null),
   (p_company,'5150','Air freight — airline','Nauli ya ndege','cost_of_sales',null),
   (p_company,'5200','Port, THC & wharfage','Bandari, THC na wharfage','cost_of_sales',null),
   (p_company,'5300','Clearing & forwarding agent','Wakala wa forodha','cost_of_sales',null),
   (p_company,'5400','Local transport & delivery','Usafiri wa ndani','cost_of_sales',null),
   (p_company,'5500','Warehouse handling & labour','Kazi za ghala','cost_of_sales',null),
   (p_company,'5600','Cargo insurance','Bima ya mizigo','cost_of_sales',null),
   (p_company,'5700','Consolidation & de-consolidation fees','Ada za consolidation','cost_of_sales',null),
   (p_company,'5900','Other direct costs','Gharama nyingine za moja kwa moja','cost_of_sales',null),
   (p_company,'6100','Salaries & wages','Mishahara','expense',null),
   (p_company,'6200','Rent','Kodi ya pango','expense',null),
   (p_company,'6300','Utilities','Umeme na maji','expense',null),
   (p_company,'6400','Telephone & internet','Simu na intaneti','expense',null),
   (p_company,'6500','Fuel & vehicle running','Mafuta na magari','expense',null),
   (p_company,'6600','Office supplies','Vifaa vya ofisi','expense',null),
   (p_company,'6700','Bank & mobile money charges','Makato ya benki','expense',null),
   (p_company,'6800','Licences, permits & government fees','Leseni na ada za serikali','expense',null),
   (p_company,'6850','Marketing & advertising','Matangazo','expense',null),
   (p_company,'6870','Travel','Safari','expense',null),
   (p_company,'6900','Other operating expenses','Matumizi mengine','expense',null),
   (p_company,'7100','Foreign exchange gain / loss','Faida/hasara ya fedha za kigeni','expense','FX')
  on conflict (company_code, code) do nothing;
end $$;
select public.acc_seed_coa('AE');
select public.acc_seed_coa('TZ');

-- cash, bank and mobile-money accounts (each has its own GL account)
create table if not exists public.money_accounts (
  id             uuid primary key default gen_random_uuid(),
  company_code   text not null references public.companies(code),
  branch_code    text references public.branches(code),
  name           text not null,
  kind           text not null check (kind in ('cash','bank','mobile_money')),
  currency       text not null check (currency in ('USD','AED','TZS')),
  account_id     uuid not null unique references public.accounts(id),
  bank_name      text,
  account_number text,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

create or replace function public.acc_add_money_account(p_company text, p_branch text, p_name text, p_kind text,
                                                        p_currency text, p_bank text default null, p_number text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare lo int; hi int; n int; acc uuid; v_id uuid;
begin
  lo := case p_kind when 'cash' then 1100 when 'mobile_money' then 1150 else 1200 end;
  hi := lo + 49 + case when p_kind = 'bank' then 50 else 0 end;
  select coalesce(max(code::int), lo - 1) + 1 into n from public.accounts
   where company_code = p_company and is_money and code ~ '^\d+$' and code::int between lo and hi;
  if n > hi then raise exception 'REFUSED: no free account codes for %', p_kind; end if;
  if n = 1190 then n := 1191; end if;
  insert into public.accounts(company_code, code, name, type, is_money)
  values (p_company, n::text, p_name, 'asset', true) returning id into acc;
  insert into public.money_accounts(company_code, branch_code, name, kind, currency, account_id, bank_name, account_number)
  values (p_company, p_branch, p_name, p_kind, p_currency, acc, p_bank, p_number) returning id into v_id;
  return v_id;
end $$;

do $$ begin
  if not exists (select 1 from public.money_accounts) then
    perform public.acc_add_money_account('AE','DXB','Cash — Dubai (AED)','cash','AED');
    perform public.acc_add_money_account('AE','DXB','Cash — Dubai (USD)','cash','USD');
    perform public.acc_add_money_account('AE','DXB','Bank — AED','bank','AED');
    perform public.acc_add_money_account('AE','DXB','Bank — USD','bank','USD');
    perform public.acc_add_money_account('TZ','DAR','Cash — Dar es Salaam (TZS)','cash','TZS');
    perform public.acc_add_money_account('TZ','DAR','Cash — Dar es Salaam (USD)','cash','USD');
    perform public.acc_add_money_account('TZ','MWZ','Cash — Mwanza (TZS)','cash','TZS');
    perform public.acc_add_money_account('TZ','DAR','Mobile money — Dar es Salaam','mobile_money','TZS');
    perform public.acc_add_money_account('TZ','MWZ','Mobile money — Mwanza','mobile_money','TZS');
    perform public.acc_add_money_account('TZ','DAR','Bank — TZS','bank','TZS');
    perform public.acc_add_money_account('TZ','DAR','Bank — USD','bank','USD');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- GENERAL LEDGER
-- ---------------------------------------------------------------------
create table if not exists public.journals (
  id           uuid primary key default gen_random_uuid(),
  ref          text unique,
  company_code text not null references public.companies(code),
  entry_date   date not null,
  source       text not null,     -- receipt, invoice_line, deposit_apply, bill, bill_payment, expense, manual, reversal, adjustment
  source_id    text,
  group_id     uuid,              -- links the two halves of an intercompany posting
  booking_id   uuid references public.bookings(id),
  shipment_id  uuid references public.shipments(id),
  memo         text,
  status       text not null default 'posted' check (status in ('draft','posted','rejected')),
  reversal_of  uuid references public.journals(id),
  reversed     boolean not null default false,
  total_usd    numeric not null default 0,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  approved_by  uuid,
  approved_at  timestamptz
);
create index if not exists journals_source_idx on public.journals(source, source_id);
create index if not exists journals_company_date_idx on public.journals(company_code, entry_date);

create table if not exists public.journal_lines (
  id                   bigserial primary key,
  journal_id           uuid not null references public.journals(id) on delete cascade,
  account_id           uuid not null references public.accounts(id),
  debit                numeric not null default 0 check (debit >= 0),
  credit               numeric not null default 0 check (credit >= 0),
  currency             text,
  amount_txn           numeric,
  fx_rate              numeric,
  branch_code          text,
  booking_id           uuid,
  shipment_id          uuid,
  customer_id          uuid,
  supplier_id          uuid,
  counterparty_company text,
  description          text,
  check (debit = 0 or credit = 0)
);
create index if not exists jl_journal_idx  on public.journal_lines(journal_id);
create index if not exists jl_account_idx  on public.journal_lines(account_id);
create index if not exists jl_booking_idx  on public.journal_lines(booking_id);
create index if not exists jl_shipment_idx on public.journal_lines(shipment_id);

-- every journal must balance (checked at commit)
create or replace function public.trg_acc_balanced() returns trigger
language plpgsql security definer set search_path = public as $$
declare jid uuid := coalesce(new.journal_id, old.journal_id); d numeric; c numeric;
begin
  select coalesce(sum(debit),0), coalesce(sum(credit),0) into d, c from public.journal_lines where journal_id = jid;
  if round(d, 2) <> round(c, 2) then
    raise exception 'UNBALANCED: journal debits % <> credits %', d, c;
  end if;
  return null;
end $$;
drop trigger if exists journal_lines_balanced on public.journal_lines;
create constraint trigger journal_lines_balanced after insert or update or delete on public.journal_lines
  deferrable initially deferred for each row execute function public.trg_acc_balanced();

-- a line's account must belong to the journal's company
create or replace function public.trg_acc_line_company() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select company_code from public.accounts where id = new.account_id) <>
     (select company_code from public.journals where id = new.journal_id) then
    raise exception 'REFUSED: account belongs to a different company';
  end if;
  return new;
end $$;
drop trigger if exists journal_lines_company on public.journal_lines;
create trigger journal_lines_company before insert on public.journal_lines
  for each row execute function public.trg_acc_line_company();

create or replace function public.acc_account(p_company text, p_key text, p_code text default null) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  if p_key is not null then
    select id into v from public.accounts where company_code = p_company and system_key = p_key;
  else
    select id into v from public.accounts where company_code = p_company and code = p_code;
  end if;
  if v is null then raise exception 'ACCOUNT_MISSING: % % in company %', coalesce(p_key,''), coalesce(p_code,''), p_company; end if;
  return v;
end $$;

create or replace function public.acc_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Dubai')::date $$;

-- Core posting function. p_lines: [{account_id|key|code, debit, credit, currency, amount_txn, fx_rate,
--   branch, booking, shipment, customer, supplier, counterparty, description}]
create or replace function public.acc_post(p_company text, p_date date, p_source text, p_source_id text, p_memo text,
  p_lines jsonb, p_booking uuid default null, p_shipment uuid default null, p_group uuid default null,
  p_status text default 'posted')
returns uuid language plpgsql security definer set search_path = public as $$
declare j_id uuid; ln jsonb; acc uuid; d numeric; c numeric; td numeric := 0; tc numeric := 0; v_ref text;
begin
  -- negative amounts flip to the other side
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
  insert into public.journals(ref, company_code, entry_date, source, source_id, group_id, booking_id, shipment_id,
                              memo, status, total_usd, created_by)
  values (v_ref, p_company, coalesce(p_date, public.acc_today()), p_source, p_source_id, p_group, p_booking, p_shipment,
          p_memo, p_status, td, auth.uid())
  returning id into j_id;

  for ln in select * from jsonb_array_elements(p_lines) loop
    d := round(coalesce((ln->>'debit')::numeric, 0), 2); c := round(coalesce((ln->>'credit')::numeric, 0), 2);
    if d < 0 then c := c - d; d := 0; end if;
    if c < 0 then d := d - c; c := 0; end if;
    if d = 0 and c = 0 then continue; end if;
    acc := coalesce(nullif(ln->>'account_id','')::uuid, public.acc_account(p_company, ln->>'key', ln->>'code'));
    insert into public.journal_lines(journal_id, account_id, debit, credit, currency, amount_txn, fx_rate, branch_code,
                                     booking_id, shipment_id, customer_id, supplier_id, counterparty_company, description)
    values (j_id, acc, d, c, ln->>'currency', nullif(ln->>'amount_txn','')::numeric, nullif(ln->>'fx_rate','')::numeric,
            ln->>'branch', nullif(ln->>'booking','')::uuid, nullif(ln->>'shipment','')::uuid,
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
  insert into public.journals(ref, company_code, entry_date, source, source_id, group_id, booking_id, shipment_id,
                              memo, status, reversal_of, total_usd, created_by)
  values (v_ref, j.company_code, coalesce(p_date, public.acc_today()), 'reversal', j.source_id, j.group_id, j.booking_id, j.shipment_id,
          coalesce(p_memo, 'Reversal of ' || j.ref), 'posted', j.id, j.total_usd, auth.uid())
  returning id into v_id;
  insert into public.journal_lines(journal_id, account_id, debit, credit, currency, amount_txn, fx_rate, branch_code,
                                   booking_id, shipment_id, customer_id, supplier_id, counterparty_company, description)
  select v_id, account_id, credit, debit, currency, amount_txn, fx_rate, branch_code,
         booking_id, shipment_id, customer_id, supplier_id, counterparty_company, 'Reversal: ' || coalesce(description, '')
  from public.journal_lines where journal_id = j.id;
  update public.journals set reversed = true where id = j.id;
  return v_id;
end $$;

create or replace function public.acc_reverse_source(p_source text, p_source_id text, p_memo text default null)
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select id from public.journals
            where source = p_source and source_id = p_source_id and status = 'posted' and not reversed and reversal_of is null
            order by created_at loop
    perform public.acc_reverse(r.id, p_memo);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- SHIPPING → LEDGER (automatic postings)
-- ---------------------------------------------------------------------
alter table public.receipts add column if not exists money_account_id uuid references public.money_accounts(id);

create or replace function public.acc_default_money_account(p_branch text, p_method text, p_currency text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from (
    select id, 1 as pri, (currency = p_currency) as cur, created_at from public.money_accounts
     where active and branch_code = p_branch
       and kind = case p_method when 'cash' then 'cash' when 'mobile_money' then 'mobile_money' else 'bank' end
    union all
    select id, 2, (currency = p_currency), created_at from public.money_accounts
     where active and company_code = public.branch_company(p_branch)
       and kind = case p_method when 'cash' then 'cash' when 'mobile_money' then 'mobile_money' else 'bank' end
    union all
    select id, 3, (currency = p_currency), created_at from public.money_accounts
     where active and company_code = public.branch_company(p_branch)
  ) x order by pri, cur desc, created_at limit 1
$$;

create or replace function public.acc_deposit_applied(p_booking uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.journals where source = 'deposit_apply' and booking_id = p_booking
                  and status = 'posted' and not reversed and reversal_of is null)
$$;

create or replace function public.acc_post_receipt(p_receipt uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.receipts; b public.bookings; ma public.money_accounts; oc text; rc text; cr_key text; g uuid;
        memo text; dt date;
begin
  select * into r from public.receipts where id = p_receipt;
  select * into b from public.bookings where id = r.booking_id;
  if exists (select 1 from public.journals where source = 'receipt' and source_id = r.id::text) then return; end if;
  if r.money_account_id is null then
    update public.receipts set money_account_id = public.acc_default_money_account(coalesce(r.branch_code, b.origin_branch), r.method, r.currency)
     where id = r.id returning * into r;
  end if;
  select * into ma from public.money_accounts where id = r.money_account_id;
  oc := public.branch_company(b.origin_branch);
  rc := ma.company_code;
  cr_key := case when r.kind = 'deposit' and not public.acc_deposit_applied(b.id) then 'CUST_DEP' else 'AR' end;
  memo := case r.kind when 'deposit' then 'Deposit ' else 'Payment ' end || r.ref || ' · ' || b.ref;
  dt := (r.received_at at time zone 'Asia/Dubai')::date;
  if rc = oc then
    perform public.acc_post(oc, dt, 'receipt', r.id::text, memo, jsonb_build_array(
      jsonb_build_object('account_id', ma.account_id, 'debit', r.amount_usd, 'currency', r.currency, 'amount_txn', r.amount,
                         'fx_rate', r.fx_rate, 'branch', ma.branch_code, 'booking', b.id, 'customer', b.customer_id, 'description', memo),
      jsonb_build_object('key', cr_key, 'credit', r.amount_usd, 'branch', b.origin_branch, 'booking', b.id, 'customer', b.customer_id, 'description', memo)
    ), b.id);
  else
    g := gen_random_uuid();
    perform public.acc_post(rc, dt, 'receipt', r.id::text, memo || ' (collected for ' || oc || ')', jsonb_build_array(
      jsonb_build_object('account_id', ma.account_id, 'debit', r.amount_usd, 'currency', r.currency, 'amount_txn', r.amount,
                         'fx_rate', r.fx_rate, 'branch', ma.branch_code, 'booking', b.id, 'customer', b.customer_id, 'description', memo),
      jsonb_build_object('key', 'IC_DUE_TO', 'credit', r.amount_usd, 'counterparty', oc, 'booking', b.id, 'description', memo)
    ), b.id, null, g);
    perform public.acc_post(oc, dt, 'receipt', r.id::text, memo || ' (collected by ' || rc || ')', jsonb_build_array(
      jsonb_build_object('key', 'IC_DUE_FROM', 'debit', r.amount_usd, 'counterparty', rc, 'booking', b.id, 'description', memo),
      jsonb_build_object('key', cr_key, 'credit', r.amount_usd, 'branch', b.origin_branch, 'booking', b.id, 'customer', b.customer_id, 'description', memo)
    ), b.id, null, g);
  end if;
end $$;

create or replace function public.acc_void_receipt(p_receipt uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.receipts; b public.bookings; oc text;
begin
  select * into r from public.receipts where id = p_receipt;
  select * into b from public.bookings where id = r.booking_id;
  oc := public.branch_company(b.origin_branch);
  -- was the receipt credited to customer deposits, and have deposits since been applied to the invoice?
  if public.acc_deposit_applied(b.id) and exists (
      select 1 from public.journal_lines l join public.journals j on j.id = l.journal_id
       join public.accounts a on a.id = l.account_id
      where j.source = 'receipt' and j.source_id = r.id::text and j.reversal_of is null and a.system_key = 'CUST_DEP') then
    perform public.acc_reverse_source('receipt', r.id::text, 'Void receipt ' || r.ref);
    perform public.acc_post(oc, public.acc_today(), 'adjustment', r.id::text, 'Void deposit ' || r.ref || ' after invoice — reinstate receivable',
      jsonb_build_array(
        jsonb_build_object('key', 'AR', 'debit', r.amount_usd, 'booking', b.id, 'customer', b.customer_id, 'branch', b.origin_branch),
        jsonb_build_object('key', 'CUST_DEP', 'credit', r.amount_usd, 'booking', b.id, 'customer', b.customer_id, 'branch', b.origin_branch)
      ), b.id);
  else
    perform public.acc_reverse_source('receipt', r.id::text, 'Void receipt ' || r.ref);
  end if;
end $$;

create or replace function public.acc_apply_deposits(p_booking uuid, p_invoice uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b public.bookings; oc text; dep numeric;
begin
  if public.acc_deposit_applied(p_booking) then return; end if;
  select * into b from public.bookings where id = p_booking;
  oc := public.branch_company(b.origin_branch);
  select coalesce(sum(amount_usd), 0) into dep from public.receipts
   where booking_id = p_booking and not void and kind = 'deposit';
  if dep <= 0 then return; end if;
  perform public.acc_post(oc, public.acc_today(), 'deposit_apply', p_invoice::text, 'Deposits applied to invoice · ' || b.ref,
    jsonb_build_array(
      jsonb_build_object('key', 'CUST_DEP', 'debit', dep, 'booking', b.id, 'customer', b.customer_id, 'branch', b.origin_branch),
      jsonb_build_object('key', 'AR', 'credit', dep, 'booking', b.id, 'customer', b.customer_id, 'branch', b.origin_branch)
    ), b.id);
end $$;

create or replace function public.acc_post_invoice_line(p_line bigint) returns void
language plpgsql security definer set search_path = public as $$
declare l public.invoice_lines; inv public.invoices; b public.bookings; oc text; k text; amt numeric; memo text; dt date;
begin
  select * into l from public.invoice_lines where id = p_line;
  if exists (select 1 from public.journals where source = 'invoice_line' and source_id = l.id::text) then return; end if;
  select * into inv from public.invoices where id = l.invoice_id;
  select * into b from public.bookings where id = inv.booking_id;
  oc := public.branch_company(b.origin_branch);
  perform public.acc_apply_deposits(b.id, inv.id);
  memo := inv.ref || ' · ' || b.ref || ' · ' || l.description;
  dt := (l.created_at at time zone 'Asia/Dubai')::date;
  if l.kind = 'discount' or l.amount < 0 then
    amt := abs(l.amount);
    perform public.acc_post(oc, dt, 'invoice_line', l.id::text, memo, jsonb_build_array(
      jsonb_build_object('key', 'SALES_DISC', 'debit', amt, 'booking', b.id, 'customer', b.customer_id, 'branch', b.origin_branch, 'description', l.description),
      jsonb_build_object('key', 'AR', 'credit', amt, 'booking', b.id, 'customer', b.customer_id, 'branch', b.origin_branch, 'description', l.description)
    ), b.id);
  else
    k := case l.kind when 'freight' then (case b.mode when 'air' then 'REV_AIR' else 'REV_SEA' end)
                     when 'duty' then 'DUTY_CLEAR' else 'REV_OTHER' end;
    perform public.acc_post(oc, dt, 'invoice_line', l.id::text, memo, jsonb_build_array(
      jsonb_build_object('key', 'AR', 'debit', l.amount, 'booking', b.id, 'customer', b.customer_id, 'branch', b.origin_branch, 'description', l.description),
      jsonb_build_object('key', k, 'credit', l.amount, 'booking', b.id, 'customer', b.customer_id, 'branch', b.origin_branch, 'description', l.description)
    ), b.id);
  end if;
end $$;

-- triggers
create or replace function public.trg_acc_receipts() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.acc_post_receipt(new.id);
  elsif tg_op = 'UPDATE' and new.void and not old.void then
    perform public.acc_void_receipt(new.id);
  end if;
  return null;
end $$;
drop trigger if exists acc_receipts on public.receipts;
create trigger acc_receipts after insert or update of void on public.receipts
  for each row execute function public.trg_acc_receipts();

create or replace function public.trg_acc_invoice_lines() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.acc_post_invoice_line(new.id);
  elsif tg_op = 'DELETE' then
    perform public.acc_reverse_source('invoice_line', old.id::text, 'Charge removed: ' || old.description);
  end if;
  return null;
end $$;
drop trigger if exists acc_invoice_lines on public.invoice_lines;
create trigger acc_invoice_lines after insert or delete on public.invoice_lines
  for each row execute function public.trg_acc_invoice_lines();

create or replace function public.trg_acc_invoices() returns trigger
language plpgsql security definer set search_path = public as $$
declare l record;
begin
  if new.status = 'void' and old.status <> 'void' then
    for l in select id from public.invoice_lines where invoice_id = new.id loop
      perform public.acc_reverse_source('invoice_line', l.id::text, 'Invoice ' || new.ref || ' void');
    end loop;
    perform public.acc_reverse_source('deposit_apply', new.id::text, 'Invoice ' || new.ref || ' void');
  end if;
  return null;
end $$;
drop trigger if exists acc_invoices on public.invoices;
create trigger acc_invoices after update of status on public.invoices
  for each row execute function public.trg_acc_invoices();

-- record_payment gains an optional "paid into" money account
drop function if exists public.record_payment(uuid, numeric, text, text, text, numeric);
create or replace function public.record_payment(
  p_booking uuid, p_amount numeric, p_currency text, p_method text,
  p_reference text default null, p_fx_rate numeric default null, p_account uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b public.bookings; s public.settings; me public.profiles; rate numeric; usd numeric;
        v_kind text; v_ref text; v_id uuid; deposits numeric; ma public.money_accounts;
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
  if me.role <> 'admin' and exists (select 1 from public.grns g where g.booking_id = b.id and g.received_by = auth.uid()) then
    raise exception 'SEGREGATION: you measured this cargo (GRN) — another person must collect the payment';
  end if;
  if p_account is not null then
    select * into ma from public.money_accounts where id = p_account and active;
    if ma.id is null then raise exception 'NOT_FOUND: money account'; end if;
  else
    select * into ma from public.money_accounts
     where id = public.acc_default_money_account(coalesce(me.branch_code, b.origin_branch), p_method, p_currency);
  end if;

  rate := case p_currency when 'USD' then 1
                          when 'AED' then coalesce(nullif(p_fx_rate,0), s.fx_aed)
                          else coalesce(nullif(p_fx_rate,0), s.fx_tzs) end;
  usd := round(p_amount / rate, 2);
  v_kind := case when b.status = 'pending_deposit' then 'deposit' else 'payment' end;
  v_ref := 'HC-RCT-' || public.yymm() || '-' || lpad(public.next_counter('RCT-' || public.yymm())::text, 4, '0');

  insert into public.receipts(ref, booking_id, customer_id, kind, currency, amount, fx_rate, amount_usd,
                              method, reference, branch_code, received_by, money_account_id)
  values (v_ref, b.id, b.customer_id, v_kind, p_currency, p_amount, rate, usd,
          p_method, p_reference, coalesce(ma.branch_code, me.branch_code), auth.uid(), ma.id)
  returning id into v_id;

  perform public.log_audit('receipt.create', 'receipt', v_id::text,
          jsonb_build_object('ref', v_ref, 'booking', b.ref, 'usd', usd, 'kind', v_kind, 'account', ma.name));

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

-- ---------------------------------------------------------------------
-- SUPPLIERS, BILLS (accounts payable) & EXPENSES
-- ---------------------------------------------------------------------
create table if not exists public.suppliers (
  id           uuid primary key default gen_random_uuid(),
  code         text unique,
  name         text not null,
  kind         text not null default 'other' check (kind in ('shipping_line','airline','clearing_agent','transport','port','government','landlord','utility','staff','other')),
  phone        text,
  email        text,
  tin          text,
  address      text,
  default_account_code text,
  notes        text,
  active       boolean not null default true,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);
create or replace function public.trg_supplier_code() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then new.code := 'HC-S-' || lpad(public.next_counter('S')::text, 4, '0'); else new.code := old.code; end if;
  return new;
end $$;
drop trigger if exists supplier_code on public.suppliers;
create trigger supplier_code before insert or update on public.suppliers for each row execute function public.trg_supplier_code();

insert into public.suppliers(name, kind, default_account_code)
select * from (values ('TRA — Tanzania Revenue Authority','government','2300'), ('TPA — Tanzania Ports Authority','port','5200'),
                      ('TASAC','government','5300')) v(name, kind, code)
where not exists (select 1 from public.suppliers);

create table if not exists public.bills (
  id                  uuid primary key default gen_random_uuid(),
  ref                 text unique,
  company_code        text not null references public.companies(code),
  branch_code         text not null references public.branches(code),
  supplier_id         uuid not null references public.suppliers(id),
  supplier_invoice_no text,
  bill_date           date not null,
  due_date            date,
  currency            text not null check (currency in ('USD','AED','TZS')),
  fx_rate             numeric not null check (fx_rate > 0),
  total_txn           numeric not null default 0,
  total_usd           numeric not null default 0,
  paid_usd            numeric not null default 0,
  status              text not null default 'open' check (status in ('open','part_paid','paid','void')),
  notes               text,
  void_reason         text,
  created_by          uuid,
  created_at          timestamptz not null default now()
);
create table if not exists public.bill_lines (
  id           bigserial primary key,
  bill_id      uuid not null references public.bills(id) on delete cascade,
  account_code text not null,
  description  text not null,
  amount_txn   numeric not null check (amount_txn > 0),
  amount_usd   numeric not null,
  shipment_id  uuid references public.shipments(id),
  booking_id   uuid references public.bookings(id)
);
create table if not exists public.bill_payments (
  id               uuid primary key default gen_random_uuid(),
  ref              text unique,
  bill_id          uuid not null references public.bills(id),
  money_account_id uuid not null references public.money_accounts(id),
  amount_txn       numeric not null check (amount_txn > 0),
  amount_usd       numeric not null,
  paid_on          date not null,
  reference        text,
  void             boolean not null default false,
  created_by       uuid,
  created_at       timestamptz not null default now()
);
create table if not exists public.expenses (
  id               uuid primary key default gen_random_uuid(),
  ref              text unique,
  company_code     text not null references public.companies(code),
  branch_code      text references public.branches(code),
  expense_date     date not null,
  account_code     text not null,
  description      text not null,
  currency         text not null check (currency in ('USD','AED','TZS')),
  fx_rate          numeric not null check (fx_rate > 0),
  amount_txn       numeric not null check (amount_txn > 0),
  amount_usd       numeric not null,
  money_account_id uuid not null references public.money_accounts(id),
  supplier_id      uuid references public.suppliers(id),
  shipment_id      uuid references public.shipments(id),
  booking_id       uuid references public.bookings(id),
  reference        text,
  void             boolean not null default false,
  void_reason      text,
  created_by       uuid,
  created_at       timestamptz not null default now()
);

create or replace function public.acc_fx(p_currency text, p_rate numeric) returns numeric
language sql stable security definer set search_path = public as $$
  select case p_currency when 'USD' then 1
              when 'AED' then coalesce(nullif(p_rate, 0), (select fx_aed from public.settings where id = 1))
              else coalesce(nullif(p_rate, 0), (select fx_tzs from public.settings where id = 1)) end
$$;

-- company that owns the P&L of a cost line (container / booking origin); falls back to the paying company
create or replace function public.acc_owner_company(p_shipment uuid, p_booking uuid, p_default text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select public.branch_company(origin_branch) from public.shipments where id = p_shipment),
    (select public.branch_company(origin_branch) from public.bookings where id = p_booking),
    p_default)
$$;

create or replace function public.acc_check_cost_account(p_company text, p_code text) returns void
language plpgsql stable security definer set search_path = public as $$
declare a public.accounts;
begin
  select * into a from public.accounts where company_code = p_company and code = p_code and active;
  if a.id is null then raise exception 'ACCOUNT_MISSING: % in company %', p_code, p_company; end if;
  if a.is_money or a.system_key in ('AR','AP','IC_DUE_FROM','IC_DUE_TO','CUST_DEP','RETAINED','OPENING')
     or a.type in ('revenue','contra_revenue') then
    raise exception 'REFUSED: account % cannot be used on a bill or expense', p_code;
  end if;
end $$;

-- Posts a set of cost lines paid/owed by company pc; lines owned by another company go through intercompany.
-- p_lines: [{code, usd, txn, description, shipment, booking}]  · p_credit: {key|account_id, ...}
create or replace function public.acc_post_costs(p_pc text, p_date date, p_source text, p_source_id text, p_memo text,
  p_lines jsonb, p_credit jsonb, p_supplier uuid, p_currency text, p_fx numeric, p_branch text)
returns void language plpgsql security definer set search_path = public as $$
declare ln jsonb; oc text; g uuid := gen_random_uuid(); pc_lines jsonb := '[]'; others jsonb := '{}'; total numeric := 0;
        k text; arr jsonb; osum numeric;
begin
  for ln in select * from jsonb_array_elements(p_lines) loop
    oc := public.acc_owner_company(nullif(ln->>'shipment','')::uuid, nullif(ln->>'booking','')::uuid, p_pc);
    total := total + (ln->>'usd')::numeric;
    if oc = p_pc then
      pc_lines := pc_lines || jsonb_build_object('code', ln->>'code', 'debit', ln->>'usd', 'currency', p_currency, 'amount_txn', ln->>'txn',
                    'fx_rate', p_fx, 'branch', p_branch, 'shipment', ln->>'shipment', 'booking', ln->>'booking', 'supplier', p_supplier,
                    'description', ln->>'description');
    else
      pc_lines := pc_lines || jsonb_build_object('key', 'IC_DUE_FROM', 'debit', ln->>'usd', 'counterparty', oc,
                    'shipment', ln->>'shipment', 'booking', ln->>'booking', 'description', ln->>'description');
      others := jsonb_set(others, array[oc], coalesce(others->oc, '[]'::jsonb) || jsonb_build_object('code', ln->>'code', 'debit', ln->>'usd',
                    'currency', p_currency, 'amount_txn', ln->>'txn', 'fx_rate', p_fx, 'shipment', ln->>'shipment', 'booking', ln->>'booking',
                    'supplier', p_supplier, 'description', ln->>'description'));
    end if;
  end loop;
  pc_lines := pc_lines || (p_credit || jsonb_build_object('credit', total));
  perform public.acc_post(p_pc, p_date, p_source, p_source_id, p_memo, pc_lines, null, null, g);
  for k, arr in select * from jsonb_each(others) loop
    select coalesce(sum((x->>'debit')::numeric), 0) into osum from jsonb_array_elements(arr) x;
    perform public.acc_post(k, p_date, p_source, p_source_id, p_memo || ' (paid by ' || p_pc || ')',
      arr || jsonb_build_object('key', 'IC_DUE_TO', 'credit', osum, 'counterparty', p_pc), null, null, g);
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
  fx := public.acc_fx(cur, nullif(p->>'fx_rate','')::numeric);
  dt := coalesce(nullif(p->>'bill_date','')::date, public.acc_today());
  v_ref := 'HC-BILL-' || public.yymm() || '-' || lpad(public.next_counter('BILL-' || public.yymm())::text, 4, '0');
  insert into public.bills(ref, company_code, branch_code, supplier_id, supplier_invoice_no, bill_date, due_date, currency, fx_rate, notes, created_by)
  values (v_ref, bc, p->>'branch_code', sup.id, p->>'supplier_invoice_no', dt, nullif(p->>'due_date','')::date, cur, fx, p->>'notes', auth.uid())
  returning id into v_id;
  for ln in select * from jsonb_array_elements(p->'lines') loop
    if coalesce((ln->>'amount')::numeric, 0) <= 0 then raise exception 'REFUSED: line amounts must be greater than zero'; end if;
    perform public.acc_check_cost_account(bc, ln->>'account_code');
    usd := round((ln->>'amount')::numeric / fx, 2);
    insert into public.bill_lines(bill_id, account_code, description, amount_txn, amount_usd, shipment_id, booking_id)
    values (v_id, ln->>'account_code', coalesce(nullif(ln->>'description',''), sup.name), (ln->>'amount')::numeric, usd,
            nullif(ln->>'shipment_id','')::uuid, nullif(ln->>'booking_id','')::uuid);
    tot_txn := tot_txn + (ln->>'amount')::numeric; tot_usd := tot_usd + usd;
    post_lines := post_lines || jsonb_build_object('code', ln->>'account_code', 'usd', usd, 'txn', ln->>'amount',
                    'description', coalesce(nullif(ln->>'description',''), sup.name), 'shipment', ln->>'shipment_id', 'booking', ln->>'booking_id');
  end loop;
  update public.bills set total_txn = tot_txn, total_usd = tot_usd where id = v_id;
  perform public.acc_post_costs(bc, dt, 'bill', v_id::text, 'Bill ' || v_ref || ' · ' || sup.name || coalesce(' #' || nullif(p->>'supplier_invoice_no',''), ''),
    post_lines, jsonb_build_object('key', 'AP', 'supplier', sup.id, 'branch', p->>'branch_code', 'description', sup.name),
    sup.id, cur, fx, p->>'branch_code');
  perform public.log_audit('bill.create', 'bill', v_id::text, jsonb_build_object('ref', v_ref, 'supplier', sup.name, 'usd', tot_usd));
  return jsonb_build_object('id', v_id, 'ref', v_ref, 'total_usd', tot_usd);
end $$;

create or replace function public.acc_pay_bill(p_bill uuid, p_account uuid, p_amount numeric, p_date date default null, p_reference text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare bl public.bills; ma public.money_accounts; usd numeric; v_id uuid; v_ref text; sup public.suppliers;
begin
  perform public.require_role('accountant','finance_manager');
  select * into bl from public.bills where id = p_bill for update;
  if bl.id is null or bl.status in ('paid','void') then raise exception 'REFUSED: bill is not open'; end if;
  select * into ma from public.money_accounts where id = p_account and active;
  if ma.id is null then raise exception 'NOT_FOUND: money account'; end if;
  if ma.company_code <> bl.company_code then raise exception 'REFUSED: pay from an account of the same company (%)', bl.company_code; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'REFUSED: amount must be greater than zero'; end if;
  usd := round(p_amount / bl.fx_rate, 2);
  if usd > bl.total_usd - bl.paid_usd + 0.01 then raise exception 'REFUSED: payment is more than the bill balance'; end if;
  select * into sup from public.suppliers where id = bl.supplier_id;
  v_ref := 'HC-PAY-' || public.yymm() || '-' || lpad(public.next_counter('PAY-' || public.yymm())::text, 4, '0');
  insert into public.bill_payments(ref, bill_id, money_account_id, amount_txn, amount_usd, paid_on, reference, created_by)
  values (v_ref, bl.id, ma.id, p_amount, usd, coalesce(p_date, public.acc_today()), p_reference, auth.uid()) returning id into v_id;
  update public.bills set paid_usd = paid_usd + usd,
         status = case when paid_usd + usd >= total_usd - 0.01 then 'paid' else 'part_paid' end where id = bl.id;
  perform public.acc_post(bl.company_code, coalesce(p_date, public.acc_today()), 'bill_payment', v_id::text,
    'Payment ' || v_ref || ' · ' || bl.ref || ' · ' || sup.name, jsonb_build_array(
      jsonb_build_object('key', 'AP', 'debit', usd, 'supplier', sup.id, 'branch', bl.branch_code, 'description', sup.name),
      jsonb_build_object('account_id', ma.account_id, 'credit', usd, 'currency', bl.currency, 'amount_txn', p_amount, 'fx_rate', bl.fx_rate,
                         'branch', ma.branch_code, 'supplier', sup.id, 'description', sup.name)
    ));
  perform public.log_audit('bill.pay', 'bill', bl.id::text, jsonb_build_object('ref', bl.ref, 'payment', v_ref, 'usd', usd));
  return jsonb_build_object('id', v_id, 'ref', v_ref, 'amount_usd', usd);
end $$;

create or replace function public.acc_void_bill_payment(p_payment uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare bp public.bill_payments;
begin
  perform public.require_role('finance_manager');
  if coalesce(trim(p_reason),'') = '' then raise exception 'REFUSED: a reason is required'; end if;
  select * into bp from public.bill_payments where id = p_payment for update;
  if bp.id is null or bp.void then raise exception 'REFUSED: payment not found or already void'; end if;
  update public.bill_payments set void = true where id = bp.id;
  update public.bills set paid_usd = greatest(paid_usd - bp.amount_usd, 0),
         status = case when paid_usd - bp.amount_usd <= 0.01 then 'open' else 'part_paid' end where id = bp.bill_id;
  perform public.acc_reverse_source('bill_payment', bp.id::text, 'Void payment ' || bp.ref || ': ' || p_reason);
  perform public.log_audit('bill.payment_void', 'bill', bp.bill_id::text, jsonb_build_object('payment', bp.ref, 'reason', p_reason));
end $$;

create or replace function public.acc_void_bill(p_bill uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare bl public.bills;
begin
  perform public.require_role('finance_manager');
  if coalesce(trim(p_reason),'') = '' then raise exception 'REFUSED: a reason is required'; end if;
  select * into bl from public.bills where id = p_bill for update;
  if bl.id is null or bl.status = 'void' then raise exception 'REFUSED: bill not found or already void'; end if;
  if exists (select 1 from public.bill_payments where bill_id = bl.id and not void) then
    raise exception 'REFUSED: void the payments on this bill first';
  end if;
  update public.bills set status = 'void', void_reason = p_reason where id = bl.id;
  perform public.acc_reverse_source('bill', bl.id::text, 'Void bill ' || bl.ref || ': ' || p_reason);
  perform public.log_audit('bill.void', 'bill', bl.id::text, jsonb_build_object('ref', bl.ref, 'reason', p_reason));
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
  fx := public.acc_fx(cur, nullif(p->>'fx_rate','')::numeric);
  usd := round(amt / fx, 2);
  dt := coalesce(nullif(p->>'expense_date','')::date, public.acc_today());
  v_ref := 'HC-EXP-' || public.yymm() || '-' || lpad(public.next_counter('EXP-' || public.yymm())::text, 4, '0');
  insert into public.expenses(ref, company_code, branch_code, expense_date, account_code, description, currency, fx_rate, amount_txn, amount_usd,
                              money_account_id, supplier_id, shipment_id, booking_id, reference, created_by)
  values (v_ref, ma.company_code, coalesce(ma.branch_code, nullif(p->>'branch_code','')), dt, p->>'account_code', p->>'description', cur, fx, amt, usd,
          ma.id, nullif(p->>'supplier_id','')::uuid, nullif(p->>'shipment_id','')::uuid, nullif(p->>'booking_id','')::uuid, p->>'reference', auth.uid())
  returning id into v_id;
  perform public.acc_post_costs(ma.company_code, dt, 'expense', v_id::text, 'Expense ' || v_ref || ' · ' || (p->>'description'),
    jsonb_build_array(jsonb_build_object('code', p->>'account_code', 'usd', usd, 'txn', amt, 'description', p->>'description',
                                         'shipment', p->>'shipment_id', 'booking', p->>'booking_id')),
    jsonb_build_object('account_id', ma.account_id, 'currency', cur, 'amount_txn', amt, 'fx_rate', fx, 'branch', ma.branch_code, 'description', p->>'description'),
    nullif(p->>'supplier_id','')::uuid, cur, fx, ma.branch_code);
  perform public.log_audit('expense.create', 'expense', v_id::text, jsonb_build_object('ref', v_ref, 'usd', usd, 'account', p->>'account_code'));
  return jsonb_build_object('id', v_id, 'ref', v_ref, 'amount_usd', usd);
end $$;

create or replace function public.acc_void_expense(p_expense uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare e public.expenses;
begin
  perform public.require_role('finance_manager');
  if coalesce(trim(p_reason),'') = '' then raise exception 'REFUSED: a reason is required'; end if;
  select * into e from public.expenses where id = p_expense for update;
  if e.id is null or e.void then raise exception 'REFUSED: expense not found or already void'; end if;
  update public.expenses set void = true, void_reason = p_reason where id = e.id;
  perform public.acc_reverse_source('expense', e.id::text, 'Void expense ' || e.ref || ': ' || p_reason);
  perform public.log_audit('expense.void', 'expense', e.id::text, jsonb_build_object('ref', e.ref, 'reason', p_reason));
end $$;

-- ---------------------------------------------------------------------
-- MANUAL JOURNALS (maker–checker) & ACCOUNT MAINTENANCE
-- ---------------------------------------------------------------------
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
               'branch', ln->>'branch_code', 'booking', ln->>'booking_id', 'shipment', ln->>'shipment_id', 'description', ln->>'description', 'currency', 'USD');
    n := n + 1;
  end loop;
  if n < 2 then raise exception 'REFUSED: a journal needs at least two lines'; end if;
  v_id := public.acc_post(co, coalesce(nullif(p->>'entry_date','')::date, public.acc_today()), 'manual', null, p->>'memo', lines,
                          null, null, null, 'draft');
  perform public.log_audit('journal.draft', 'journal', v_id::text, jsonb_build_object('memo', p->>'memo'));
  return jsonb_build_object('id', v_id, 'ref', (select ref from public.journals where id = v_id));
end $$;

create or replace function public.acc_approve_journal(p_journal uuid, p_approve boolean default true, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare j public.journals; me public.profiles;
begin
  perform public.require_role('finance_manager');
  select * into me from public.profiles where id = auth.uid();
  select * into j from public.journals where id = p_journal for update;
  if j.id is null or j.status <> 'draft' then raise exception 'REFUSED: journal is not a draft'; end if;
  if p_approve then
    if j.created_by = auth.uid() and me.role <> 'admin' then
      raise exception 'SEGREGATION: you prepared this journal — another person must approve it';
    end if;
    update public.journals set status = 'posted', approved_by = auth.uid(), approved_at = now() where id = j.id;
  else
    update public.journals set status = 'rejected', approved_by = auth.uid(), approved_at = now(),
           memo = memo || ' — rejected: ' || coalesce(p_reason, '') where id = j.id;
  end if;
  perform public.log_audit(case when p_approve then 'journal.approve' else 'journal.reject' end, 'journal', j.id::text,
          jsonb_build_object('ref', j.ref, 'reason', p_reason));
end $$;

create or replace function public.acc_reverse_journal(p_journal uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare j public.journals; v uuid;
begin
  perform public.require_role('finance_manager');
  if coalesce(trim(p_reason),'') = '' then raise exception 'REFUSED: a reason is required'; end if;
  select * into j from public.journals where id = p_journal;
  if j.source <> 'manual' then raise exception 'REFUSED: only manual journals can be reversed here — void the source document instead'; end if;
  v := public.acc_reverse(p_journal, 'Reversal of ' || j.ref || ': ' || p_reason);
  if v is null then raise exception 'REFUSED: journal cannot be reversed'; end if;
  perform public.log_audit('journal.reverse', 'journal', j.id::text, jsonb_build_object('ref', j.ref, 'reason', p_reason));
  return v;
end $$;

create or replace function public.acc_save_account(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare co record;
begin
  perform public.require_role('finance_manager');
  if nullif(p->>'id','') is not null then
    update public.accounts set name = p->>'name', name_sw = nullif(p->>'name_sw',''), active = coalesce((p->>'active')::boolean, true)
     where id = (p->>'id')::uuid and system_key is null;
    return;
  end if;
  if coalesce(p->>'code','') !~ '^\d{4}$' then raise exception 'REFUSED: account code must be 4 digits'; end if;
  if (p->>'type') not in ('asset','liability','equity','revenue','contra_revenue','cost_of_sales','expense') then
    raise exception 'REFUSED: invalid account type';
  end if;
  -- create the same code in every company so both ledgers stay aligned
  for co in select code from public.companies loop
    insert into public.accounts(company_code, code, name, name_sw, type)
    values (co.code, p->>'code', p->>'name', nullif(p->>'name_sw',''), p->>'type')
    on conflict (company_code, code) do nothing;
  end loop;
end $$;

create or replace function public.acc_create_money_account(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role('finance_manager');
  return public.acc_add_money_account(public.branch_company(p->>'branch_code'), p->>'branch_code', p->>'name', p->>'kind',
                                      p->>'currency', nullif(p->>'bank_name',''), nullif(p->>'account_number',''));
end $$;

-- ---------------------------------------------------------------------
-- REPORTS (return jsonb)
-- ---------------------------------------------------------------------
create or replace function public.acc_can_read() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_role('accountant','finance_manager','manager')
$$;

-- Trial balance per account code. p_company null = both companies (consolidated).
create or replace function public.acc_trial_balance(p_company text, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not public.acc_can_read() then raise exception 'NOT_ALLOWED: your role cannot perform this action'; end if;
  select coalesce(jsonb_agg(x order by x.code, x.company), '[]') into res from (
    select a.code,
           max(case when p_company is null and a.is_money then a.company_code || ' · ' || a.name else a.name end) as name,
           max(case when p_company is null and a.is_money then a.company_code || ' · ' || a.name_sw else a.name_sw end) as name_sw,
           max(a.type) as type, max(a.system_key) as system_key,
           bool_or(a.is_money) as is_money,
           case when bool_or(a.is_money) then max(a.company_code) end as company,
           round(coalesce(sum(case when j.entry_date < p_from then l.debit - l.credit end), 0), 2) as opening,
           round(coalesce(sum(case when j.entry_date >= p_from then l.debit end), 0), 2) as debit,
           round(coalesce(sum(case when j.entry_date >= p_from then l.credit end), 0), 2) as credit
    from public.accounts a
    left join public.journal_lines l on l.account_id = a.id
      and exists (select 1 from public.journals jj where jj.id = l.journal_id and jj.status = 'posted' and jj.entry_date <= p_to)
    left join public.journals j on j.id = l.journal_id
    where (p_company is null or a.company_code = p_company)
    group by a.code, case when a.is_money then a.company_code end   -- money accounts are company-specific (same code ≠ same till)
  ) x;
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

-- P&L of one container: revenue of its bookings, direct booking costs, container costs allocated by CBM (sea) / chargeable kg (air)
create or replace function public.acc_shipment_pnl(p_shipment uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare sh public.shipments; basis numeric; shared numeric; res jsonb;
begin
  if not public.acc_can_read() then raise exception 'NOT_ALLOWED: your role cannot perform this action'; end if;
  select * into sh from public.shipments where id = p_shipment;
  if sh.id is null then raise exception 'NOT_FOUND: shipment'; end if;
  select coalesce(sum(case when sh.mode = 'air' then chargeable_kg else cbm end), 0) into basis
    from public.bookings where shipment_id = sh.id;
  select coalesce(sum(l.debit - l.credit), 0) into shared
    from public.journal_lines l join public.journals j on j.id = l.journal_id and j.status = 'posted'
    join public.accounts a on a.id = l.account_id and a.type = 'cost_of_sales'
   where l.shipment_id = sh.id;
  with bk as (
    select b.id, b.ref, c.name as customer, b.cbm, b.chargeable_kg,
      coalesce((select sum(l.credit - l.debit) from public.journal_lines l join public.journals j on j.id = l.journal_id and j.status = 'posted'
                join public.accounts a on a.id = l.account_id and a.type in ('revenue','contra_revenue') where l.booking_id = b.id), 0) as revenue,
      coalesce((select sum(l.debit - l.credit) from public.journal_lines l join public.journals j on j.id = l.journal_id and j.status = 'posted'
                join public.accounts a on a.id = l.account_id and a.type = 'cost_of_sales' where l.booking_id = b.id and l.shipment_id is null), 0) as direct_cost,
      case when basis > 0 then round(shared * (case when sh.mode = 'air' then b.chargeable_kg else b.cbm end) / basis, 2) else 0 end as allocated_cost
    from public.bookings b join public.customers c on c.id = b.customer_id
    where b.shipment_id = sh.id
  )
  select jsonb_build_object(
    'shipment', jsonb_build_object('id', sh.id, 'ref', sh.ref, 'container_no', sh.container_no, 'mode', sh.mode, 'status', sh.status),
    'basis', basis, 'shared_cost', round(shared, 2),
    'revenue', coalesce((select round(sum(revenue), 2) from bk), 0),
    'direct_cost', coalesce((select round(sum(direct_cost), 2) from bk), 0),
    'unallocated_cost', case when basis > 0 then 0 else round(shared, 2) end,
    'bookings', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'ref', ref, 'customer', customer, 'cbm', cbm, 'chargeable_kg', chargeable_kg,
                    'revenue', round(revenue, 2), 'direct_cost', round(direct_cost, 2), 'allocated_cost', allocated_cost,
                    'profit', round(revenue - direct_cost - allocated_cost, 2)) order by ref) from bk), '[]'),
    'cost_lines', coalesce((select jsonb_agg(jsonb_build_object('date', j.entry_date, 'journal', j.ref, 'source', j.source, 'code', a.code, 'account', a.name,
                    'description', l.description, 'amount', l.debit - l.credit, 'booking_ref', b2.ref, 'company', j.company_code) order by j.entry_date, j.ref)
                   from public.journal_lines l join public.journals j on j.id = l.journal_id and j.status = 'posted'
                   join public.accounts a on a.id = l.account_id and a.type = 'cost_of_sales'
                   left join public.bookings b2 on b2.id = l.booking_id
                   where l.shipment_id = sh.id or l.booking_id in (select id from public.bookings where shipment_id = sh.id)), '[]')
  ) into res;
  return res;
end $$;

create or replace function public.acc_shipments_pnl(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not public.acc_can_read() then raise exception 'NOT_ALLOWED: your role cannot perform this action'; end if;
  with sh as (
    select s.*, public.branch_company(s.origin_branch) as company,
      coalesce((select sum(b.cbm) from public.bookings b where b.shipment_id = s.id), 0) as cbm,
      (select count(*) from public.bookings b where b.shipment_id = s.id) as bookings
    from public.shipments s
    where coalesce(s.departed_at, s.created_at)::date between p_from and p_to
  ), m as (
    select sh.*,
      coalesce((select sum(l.credit - l.debit) from public.journal_lines l join public.journals j on j.id = l.journal_id and j.status = 'posted'
               join public.accounts a on a.id = l.account_id and a.type in ('revenue','contra_revenue')
               where l.booking_id in (select id from public.bookings where shipment_id = sh.id)), 0) as revenue,
      coalesce((select sum(l.debit - l.credit) from public.journal_lines l join public.journals j on j.id = l.journal_id and j.status = 'posted'
               join public.accounts a on a.id = l.account_id and a.type = 'cost_of_sales'
               where l.shipment_id = sh.id or l.booking_id in (select id from public.bookings where shipment_id = sh.id)), 0) as cost
    from sh
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'ref', ref, 'container_no', container_no, 'mode', mode, 'company', company,
           'origin', origin_branch, 'destination', destination_branch, 'status', status, 'departed_at', departed_at, 'bookings', bookings,
           'cbm', cbm, 'revenue', round(revenue, 2), 'cost', round(cost, 2), 'profit', round(revenue - cost, 2),
           'margin_pct', case when revenue <> 0 then round((revenue - cost) / revenue * 100, 1) end,
           'profit_per_cbm', case when cbm > 0 then round((revenue - cost) / cbm, 2) end) order by coalesce(departed_at, created_at) desc), '[]')
    into res from m;
  return res;
end $$;

-- One-time: post any shipping documents created before the accounting module was installed
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
  for r in select id, ref from public.invoices where status = 'void' loop
    perform public.acc_reverse_source('deposit_apply', r.id::text, 'Invoice ' || r.ref || ' void');
    perform public.acc_reverse_source('invoice_line', l.id::text, 'Invoice ' || r.ref || ' void')
      from public.invoice_lines l where l.invoice_id = r.id;
  end loop;
  return jsonb_build_object('receipts', nr, 'invoice_lines', nl, 'voids', nv);
end $$;

-- ---------------------------------------------------------------------
-- VIEWS
-- ---------------------------------------------------------------------
create or replace view public.v_journals with (security_invoker = true) as
select j.*, b.ref as booking_ref, s.ref as shipment_ref, s.container_no,
       pc.full_name as created_by_name, pa.full_name as approved_by_name,
       o.ref as reversal_of_ref
from public.journals j
left join public.bookings b on b.id = j.booking_id
left join public.shipments s on s.id = j.shipment_id
left join public.profiles pc on pc.id = j.created_by
left join public.profiles pa on pa.id = j.approved_by
left join public.journals o on o.id = j.reversal_of;

create or replace view public.v_journal_lines with (security_invoker = true) as
select l.*, a.code as account_code, a.name as account_name, a.name_sw as account_name_sw, a.type as account_type,
       j.ref as journal_ref, j.entry_date, j.status as journal_status, j.company_code, j.source, j.memo,
       b.ref as booking_ref, s.ref as shipment_ref, s.container_no, sp.name as supplier_name, c.name as customer_name,
       j.source_id
from public.journal_lines l
join public.accounts a on a.id = l.account_id
join public.journals j on j.id = l.journal_id
left join public.bookings b on b.id = l.booking_id
left join public.shipments s on s.id = l.shipment_id
left join public.suppliers sp on sp.id = l.supplier_id
left join public.customers c on c.id = l.customer_id;

create or replace view public.v_bills with (security_invoker = true) as
select bl.*, sp.name as supplier_name, sp.code as supplier_code, round(bl.total_usd - bl.paid_usd, 2) as balance_usd,
       p.full_name as created_by_name,
       (select string_agg(distinct coalesce(s.container_no, s.ref), ', ') from public.bill_lines l join public.shipments s on s.id = l.shipment_id where l.bill_id = bl.id) as containers
from public.bills bl
join public.suppliers sp on sp.id = bl.supplier_id
left join public.profiles p on p.id = bl.created_by;

create or replace view public.v_bill_lines with (security_invoker = true) as
select l.*, s.ref as shipment_ref, s.container_no, b.ref as booking_ref
from public.bill_lines l
left join public.shipments s on s.id = l.shipment_id
left join public.bookings b on b.id = l.booking_id;

create or replace view public.v_bill_payments with (security_invoker = true) as
select bp.*, m.name as money_account_name, p.full_name as created_by_name
from public.bill_payments bp
join public.money_accounts m on m.id = bp.money_account_id
left join public.profiles p on p.id = bp.created_by;

create or replace view public.v_expenses with (security_invoker = true) as
select e.*, m.name as money_account_name, sp.name as supplier_name, s.ref as shipment_ref, s.container_no, b.ref as booking_ref,
       a.name as account_name, p.full_name as created_by_name
from public.expenses e
join public.money_accounts m on m.id = e.money_account_id
left join public.suppliers sp on sp.id = e.supplier_id
left join public.shipments s on s.id = e.shipment_id
left join public.bookings b on b.id = e.booking_id
left join public.accounts a on a.company_code = e.company_code and a.code = e.account_code
left join public.profiles p on p.id = e.created_by;

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY & GRANTS
-- ---------------------------------------------------------------------
alter table public.companies      enable row level security;
alter table public.accounts       enable row level security;
alter table public.money_accounts enable row level security;
alter table public.journals       enable row level security;
alter table public.journal_lines  enable row level security;
alter table public.suppliers      enable row level security;
alter table public.bills          enable row level security;
alter table public.bill_lines     enable row level security;
alter table public.bill_payments  enable row level security;
alter table public.expenses       enable row level security;

drop policy if exists staff_read on public.companies;
create policy staff_read on public.companies for select to authenticated using (public.is_staff());
drop policy if exists admin_update on public.companies;
create policy admin_update on public.companies for update to authenticated using (public.has_role('admin')) with check (public.has_role('admin'));
drop policy if exists staff_read on public.money_accounts;
create policy staff_read on public.money_accounts for select to authenticated using (public.is_staff());

do $$
declare t text;
begin
  foreach t in array array['accounts','journals','journal_lines','suppliers','bills','bill_lines','bill_payments','expenses'] loop
    execute format('drop policy if exists finance_read on public.%I', t);
    execute format('create policy finance_read on public.%I for select to authenticated using (public.acc_can_read())', t);
  end loop;
end $$;

drop policy if exists suppliers_write on public.suppliers;
create policy suppliers_write on public.suppliers for insert to authenticated with check (public.has_role('accountant','finance_manager'));
drop policy if exists suppliers_update on public.suppliers;
create policy suppliers_update on public.suppliers for update to authenticated
  using (public.has_role('accountant','finance_manager')) with check (public.has_role('accountant','finance_manager'));

grant select, insert, update on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke delete on all tables in schema public from authenticated;
revoke all on all tables in schema public from anon;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.track_shipment(text) to anon;

-- internal helpers are never callable from the API
do $$
declare f text;
begin
  foreach f in array array[
    'next_counter(text)', 'log_audit(text,text,text,jsonb)', 'add_event(uuid,booking_status,text,text,text,boolean)', 'rpc_mode()',
    'recalc_invoice(uuid)', 'handle_new_user()', 'trg_customer_before()', 'trg_booking_before()', 'trg_booking_after_insert()',
    'trg_shipment_before()', 'trg_profile_guard()',
    'acc_seed_coa(text)', 'acc_add_money_account(text,text,text,text,text,text,text)', 'trg_acc_balanced()', 'trg_acc_line_company()',
    'acc_post(text,date,text,text,text,jsonb,uuid,uuid,uuid,text)', 'acc_reverse(uuid,text,date)', 'acc_reverse_source(text,text,text)',
    'acc_post_receipt(uuid)', 'acc_void_receipt(uuid)', 'acc_apply_deposits(uuid,uuid)', 'acc_post_invoice_line(bigint)',
    'trg_acc_receipts()', 'trg_acc_invoice_lines()', 'trg_acc_invoices()', 'trg_supplier_code()',
    'acc_post_costs(text,date,text,text,text,jsonb,jsonb,uuid,text,numeric,text)'
  ] loop
    execute 'revoke execute on function public.' || f || ' from authenticated';
  end loop;
end $$;

-- post anything that already exists (safe to run again)
select public.acc_backfill();
