-- =====================================================================
--  HORSE CARGO — v4: staff administration, role permissions,
--  temporary special access, and the STORAGE / packing module.
--  Run AFTER documents-v3.sql. Idempotent.
-- =====================================================================
set client_min_messages = warning;

-- ---------------------------------------------------------------------
-- 1. PERMISSIONS BY ROLE (data, not code — the admin screen reads this)
-- ---------------------------------------------------------------------
create table if not exists public.role_permissions (
  role       public.app_role not null,
  permission text not null,
  primary key (role, permission)
);

-- roles that can still be handed out (Finance manager and Viewer are retired)
create or replace function public.assignable_roles() returns text[]
language sql immutable as $$
  select array['admin','manager','counter','warehouse','cashier','operations','release_officer','accountant']::text[]
$$;

-- permissions an admin may lend to another member of staff for a while
create or replace function public.grantable_permissions() returns text[]
language sql immutable as $$
  select array['payment.record','payment.void','currency.set','charge.add','acc.read','acc.write']::text[]
$$;

truncate table public.role_permissions;
insert into public.role_permissions(role, permission) values
 -- manager: everything operational
 ('manager','customer.write'),('manager','shipment.create'),('manager','shipment.edit'),('manager','shipment.cancel'),
 ('manager','shipment.status'),('manager','payment.record'),('manager','payment.void'),('manager','grn.record'),
 ('manager','charge.add'),('manager','charge.discount'),('manager','charge.remove'),('manager','rate.override'),
 ('manager','currency.set'),('manager','tracking.note'),('manager','deliver'),('manager','rates.write'),
 ('manager','settings.write'),('manager','audit.read'),('manager','reports.read'),('manager','doc.approve'),
 ('manager','acc.read'),('manager','acc.approve'),('manager','storage.read'),('manager','storage.pack'),('manager','storage.correct'),
 -- counter / sales
 ('counter','customer.write'),('counter','shipment.create'),('counter','shipment.edit'),('counter','shipment.status'),
 ('counter','payment.record'),('counter','charge.add'),('counter','currency.set'),('counter','tracking.note'),
 ('counter','deliver'),('counter','storage.read'),('counter','storage.pack'),
 -- warehouse
 ('warehouse','shipment.create'),('warehouse','shipment.status'),('warehouse','grn.record'),('warehouse','tracking.note'),
 ('warehouse','storage.read'),('warehouse','storage.pack'),
 -- operations / logistics officer
 ('operations','shipment.create'),('operations','shipment.edit'),('operations','shipment.status'),('operations','grn.record'),
 ('operations','charge.add'),('operations','tracking.note'),('operations','deliver'),('operations','reports.read'),
 ('operations','storage.read'),('operations','storage.pack'),
 -- cashier
 ('cashier','customer.write'),('cashier','payment.record'),('cashier','currency.set'),('cashier','reports.read'),
 ('cashier','storage.read'),
 -- release officer
 ('release_officer','shipment.status'),('release_officer','deliver'),('release_officer','tracking.note'),('release_officer','storage.read'),
 -- accountant (now also collects customer payments)
 ('accountant','acc.read'),('accountant','acc.write'),('accountant','payment.record'),('accountant','currency.set'),
 ('accountant','reports.read'),('accountant','storage.read'),
 -- finance manager (retired role, kept working for anyone who still has it)
 ('finance_manager','acc.read'),('finance_manager','acc.write'),('finance_manager','acc.approve'),
 ('finance_manager','doc.approve'),('finance_manager','payment.record'),('finance_manager','reports.read'),('finance_manager','storage.read'),
 -- viewer (retired role)
 ('viewer','storage.read');

-- ---------------------------------------------------------------------
-- 2. TEMPORARY SPECIAL ACCESS
-- ---------------------------------------------------------------------
create table if not exists public.permission_grants (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  permission  text not null,
  reason      text,
  granted_by  uuid,
  granted_at  timestamptz not null default now(),
  expires_at  timestamptz,
  revoked_by  uuid,
  revoked_at  timestamptz,
  revoke_reason text
);
create index if not exists perm_grants_user_idx on public.permission_grants(user_id) where revoked_at is null;

create or replace function public.has_perm(p_perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role = 'admin')
      or exists (select 1 from public.profiles p join public.role_permissions rp on rp.role = p.role
                  where p.id = auth.uid() and p.active and rp.permission = p_perm)
      or exists (select 1 from public.permission_grants g join public.profiles p on p.id = g.user_id and p.active
                  where g.user_id = auth.uid() and g.permission = p_perm
                    and g.revoked_at is null and (g.expires_at is null or g.expires_at > now()))
$$;

create or replace function public.require_perm(p_perm text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_perm(p_perm) then
    raise exception 'NOT_ALLOWED: your role cannot perform this action' using errcode = '42501';
  end if;
end $$;

-- what the signed-in user may do (role + live grants) — the app reads this at login
create or replace function public.my_permissions() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(distinct x.permission), '[]'::jsonb) from (
    select rp.permission from public.profiles p join public.role_permissions rp on rp.role = p.role
     where p.id = auth.uid() and p.active
    union
    select g.permission from public.permission_grants g join public.profiles p on p.id = g.user_id and p.active
     where g.user_id = auth.uid() and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())
  ) x
$$;

create or replace function public.grant_permission(p_user uuid, p_permission text, p_expires timestamptz default null,
                                                   p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; pr public.profiles;
begin
  perform public.require_role('admin');
  if not (p_permission = any (public.grantable_permissions())) then
    raise exception 'REFUSED: % cannot be granted as special access', p_permission;
  end if;
  select * into pr from public.profiles where id = p_user;
  if pr.id is null then raise exception 'NOT_FOUND: user'; end if;
  if pr.role = 'admin' then raise exception 'REFUSED: administrators already have every permission'; end if;
  if p_expires is not null and p_expires <= now() then raise exception 'REFUSED: the expiry must be in the future'; end if;
  update public.permission_grants set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'replaced'
   where user_id = p_user and permission = p_permission and revoked_at is null;
  insert into public.permission_grants(user_id, permission, reason, granted_by, expires_at)
  values (p_user, p_permission, p_reason, auth.uid(), p_expires) returning id into v_id;
  perform public.log_audit('access.grant', 'profile', p_user::text,
          jsonb_build_object('permission', p_permission, 'expires', p_expires, 'reason', p_reason, 'user', pr.full_name));
  return jsonb_build_object('id', v_id, 'permission', p_permission, 'expires_at', p_expires);
end $$;

create or replace function public.revoke_permission(p_grant uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare g public.permission_grants;
begin
  perform public.require_role('admin');
  select * into g from public.permission_grants where id = p_grant for update;
  if g.id is null or g.revoked_at is not null then raise exception 'REFUSED: grant not found or already revoked'; end if;
  update public.permission_grants set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = p_reason where id = g.id;
  perform public.log_audit('access.revoke', 'profile', g.user_id::text,
          jsonb_build_object('permission', g.permission, 'reason', p_reason));
end $$;

create or replace view public.v_permission_grants with (security_invoker = true) as
select g.*, p.full_name as user_name, p.email as user_email, p.role as user_role,
       gb.full_name as granted_by_name, rb.full_name as revoked_by_name,
       (g.revoked_at is null and (g.expires_at is null or g.expires_at > now())) as is_active
from public.permission_grants g
join public.profiles p on p.id = g.user_id
left join public.profiles gb on gb.id = g.granted_by
left join public.profiles rb on rb.id = g.revoked_by;

-- ---------------------------------------------------------------------
-- 3. STAFF ADMINISTRATION (invite · role · deactivate)
-- ---------------------------------------------------------------------
create table if not exists public.staff_invites (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  full_name   text,
  role        public.app_role not null default 'counter',
  branch_code text references public.branches(code),
  invited_by  uuid,
  invited_at  timestamptz not null default now(),
  accepted_at timestamptz,
  cancelled_at timestamptz
);

create or replace function public.admin_invite_staff(p_email text, p_full_name text, p_role text, p_branch text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_email text;
begin
  perform public.require_role('admin');
  v_email := lower(trim(p_email));
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'REFUSED: enter a valid email address'; end if;
  if not (p_role = any (public.assignable_roles())) then raise exception 'REFUSED: % cannot be assigned', p_role; end if;
  if exists (select 1 from public.profiles where lower(email) = v_email) then
    raise exception 'REFUSED: that email already has an account — change their role instead';
  end if;
  insert into public.staff_invites(email, full_name, role, branch_code, invited_by)
  values (v_email, nullif(trim(p_full_name),''), p_role::public.app_role, nullif(p_branch,''), auth.uid())
  on conflict (email) do update set full_name = excluded.full_name, role = excluded.role,
       branch_code = excluded.branch_code, invited_by = excluded.invited_by, invited_at = now(),
       accepted_at = null, cancelled_at = null
  returning id into v_id;
  perform public.log_audit('staff.invite', 'staff_invite', v_id::text,
          jsonb_build_object('email', v_email, 'role', p_role, 'branch', p_branch));
  return jsonb_build_object('id', v_id, 'email', v_email, 'role', p_role);
end $$;

create or replace function public.admin_cancel_invite(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role('admin');
  update public.staff_invites set cancelled_at = now() where id = p_id and accepted_at is null;
  perform public.log_audit('staff.invite_cancel', 'staff_invite', p_id::text, null);
end $$;

-- the invite is applied the moment that person signs up
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare first_user boolean; inv public.staff_invites;
begin
  select not exists (select 1 from public.profiles) into first_user;
  select * into inv from public.staff_invites
   where lower(email) = lower(new.email) and accepted_at is null and cancelled_at is null;
  insert into public.profiles(id, email, full_name, role, active, branch_code)
  values (new.id, new.email,
          coalesce(inv.full_name, new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
          case when first_user then 'admin'::public.app_role
               when inv.id is not null then inv.role else 'counter'::public.app_role end,
          first_user or inv.id is not null,
          inv.branch_code)
  on conflict (id) do nothing;
  if inv.id is not null then update public.staff_invites set accepted_at = now() where id = inv.id; end if;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.admin_save_staff(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare u public.profiles; v_role text; v_active boolean;
begin
  perform public.require_role('admin');
  select * into u from public.profiles where id = (p->>'id')::uuid;
  if u.id is null then raise exception 'NOT_FOUND: user'; end if;
  v_role   := coalesce(nullif(p->>'role',''), u.role::text);
  v_active := coalesce((p->>'active')::boolean, u.active);
  if u.id = auth.uid() and (v_role <> u.role::text or v_active <> u.active) then
    raise exception 'REFUSED: you cannot change your own role or access';
  end if;
  if v_role <> u.role::text and not (v_role = any (public.assignable_roles())) then
    raise exception 'REFUSED: % is no longer assignable', v_role;
  end if;
  update public.profiles set
    full_name   = coalesce(nullif(p->>'full_name',''), full_name),
    phone       = coalesce(nullif(p->>'phone',''), phone),
    role        = v_role::public.app_role,
    branch_code = case when p ? 'branch_code' then nullif(p->>'branch_code','') else branch_code end,
    active      = v_active
  where id = u.id;
  if not v_active and u.active then
    update public.permission_grants set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = 'staff deactivated'
     where user_id = u.id and revoked_at is null;
  end if;
  perform public.log_audit('staff.save', 'profile', u.id::text,
          jsonb_build_object('role', v_role, 'active', v_active, 'branch', p->>'branch_code',
                             'was_role', u.role, 'was_active', u.active));
end $$;

-- the profile guard must let admin_save_staff through
create or replace function public.trg_profile_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.has_role('admin') then
    new.role := old.role; new.active := old.active; new.branch_code := old.branch_code;
  end if;
  new.id := old.id; new.email := old.email;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 4. EVERY GUARDED RPC NOW CHECKS A PERMISSION, NOT A ROLE
--    (so special access granted by the admin works on the server too)
-- ---------------------------------------------------------------------
do $$
declare m record; src text; okline text;
begin
  for m in select * from (values
    ('record_payment(uuid,numeric,text,text,text,numeric,uuid)', $o$perform public.require_role('cashier','manager','counter');$o$, 'payment.record'),
    ('void_receipt(uuid,text)',                                   $o$perform public.require_role('manager');$o$, 'payment.void'),
    ('record_grn(uuid,jsonb,text,text,text[],boolean)',           $o$perform public.require_role('warehouse','manager','operations');$o$, 'grn.record'),
    ('add_charge(uuid,text,text,numeric,numeric,text)',           $o$perform public.require_role('manager','counter','operations');$o$, 'charge.add'),
    ('remove_charge(bigint,text)',                                $o$perform public.require_role('manager');$o$, 'charge.remove'),
    ('set_invoice_currency(uuid,text,numeric)',                   $o$perform public.require_role('manager','cashier','counter');$o$, 'currency.set'),
    ('create_shipment(jsonb)',                                    $o$perform public.require_role('manager','counter','operations','warehouse');$o$, 'shipment.create'),
    ('update_shipment(jsonb)',                                    $o$perform public.require_role('manager','counter','operations');$o$, 'shipment.edit'),
    ('set_shipment_status(uuid,public.ship_status,text,boolean)', $o$perform public.require_role('operations','manager','warehouse','counter','release_officer');$o$, 'shipment.status'),
    ('deliver_shipment(uuid,text,text,text,text,text)',           $o$perform public.require_role('release_officer','manager','operations','counter');$o$, 'deliver'),
    ('cancel_shipment(uuid,text)',                                $o$perform public.require_role('manager');$o$, 'shipment.cancel'),
    ('add_tracking_note(uuid,text,text,boolean)',                 $o$perform public.require_role('operations','manager','counter','warehouse');$o$, 'tracking.note'),
    ('approve_document(text,boolean,text)',                       $o$perform public.require_role('manager','finance_manager');$o$, 'doc.approve'),
    ('acc_create_bill(jsonb)',                                    $o$perform public.require_role('accountant','finance_manager');$o$, 'acc.write'),
    ('acc_record_expense(jsonb)',                                 $o$perform public.require_role('accountant','finance_manager');$o$, 'acc.write'),
    ('acc_create_journal(jsonb)',                                 $o$perform public.require_role('accountant','finance_manager');$o$, 'acc.write'),
    ('acc_pay_bill(uuid,uuid,numeric,date,text)',                 $o$perform public.require_role('accountant','finance_manager');$o$, 'acc.write'),
    ('acc_approve_journal(uuid,boolean,text)',                    $o$perform public.require_role('finance_manager');$o$, 'acc.approve'),
    ('acc_reverse_journal(uuid,text)',                            $o$perform public.require_role('finance_manager');$o$, 'acc.approve'),
    ('acc_void_bill(uuid,text)',                                  $o$perform public.require_role('finance_manager');$o$, 'acc.approve'),
    ('acc_void_bill_payment(uuid,text)',                          $o$perform public.require_role('finance_manager');$o$, 'acc.approve'),
    ('acc_void_expense(uuid,text)',                               $o$perform public.require_role('finance_manager');$o$, 'acc.approve'),
    ('acc_save_account(jsonb)',                                   $o$perform public.require_role('finance_manager');$o$, 'acc.approve'),
    ('acc_create_money_account(jsonb)',                           $o$perform public.require_role('finance_manager');$o$, 'acc.approve'),
    ('acc_backfill()',                                            $o$perform public.require_role('finance_manager');$o$, 'acc.approve')
  ) as t(sig, old_line, perm) loop
    src := pg_get_functiondef(('public.' || m.sig)::regprocedure);
    okline := 'perform public.require_perm(''' || m.perm || ''');';
    if position(okline in src) > 0 then continue; end if;                 -- already migrated
    if position(m.old_line in src) = 0 then
      raise exception 'v4: could not find the role check in %', m.sig;
    end if;
    execute replace(src, m.old_line, okline);
  end loop;
end $$;

-- discounts and rate overrides keep their own permission
do $$
declare src text;
begin
  src := pg_get_functiondef('public.add_charge(uuid,text,text,numeric,numeric,text)'::regprocedure);
  if position('has_perm(''charge.discount'')' in src) = 0 then
    execute replace(src, $o$not public.has_role('manager')$o$, $o$not public.has_perm('charge.discount')$o$);
  end if;
  for src in select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('create_shipment','update_shipment','record_grn') and p.prokind = 'f' loop
    if position('has_perm(''rate.override'')' in src) = 0 and position($o$not public.has_role('manager')$o$ in src) > 0 then
      execute replace(src, $o$not public.has_role('manager')$o$, $o$not public.has_perm('rate.override')$o$);
    end if;
  end loop;
end $$;

create or replace function public.acc_can_read() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_perm('acc.read')
$$;

-- ---------------------------------------------------------------------
-- 5. STORAGE — what is physically in the warehouse, item by item
-- ---------------------------------------------------------------------
create table if not exists public.storage_stock (
  id                uuid primary key default gen_random_uuid(),
  shipment_id       uuid not null references public.shipments(id) on delete cascade,
  item_id           bigint not null references public.shipment_items(id) on delete cascade,
  received_qty      numeric not null default 0 check (received_qty >= 0),
  packed_qty        numeric not null default 0 check (packed_qty >= 0),
  unit              text not null default 'PCS',
  location          text,
  first_received_at timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (shipment_id, item_id),
  check (packed_qty <= received_qty)
);
create index if not exists storage_shipment_idx on public.storage_stock(shipment_id);

create table if not exists public.packing_entries (
  id           uuid primary key default gen_random_uuid(),
  ref          text unique,
  shipment_id  uuid not null references public.shipments(id) on delete cascade,
  notes        text,
  client_token text unique,                    -- stops a double click / retry creating two entries
  packed_by    uuid,
  packed_at    timestamptz not null default now(),
  void         boolean not null default false,
  void_reason  text,
  voided_by    uuid,
  voided_at    timestamptz
);
create index if not exists packing_shipment_idx on public.packing_entries(shipment_id, packed_at desc);

create table if not exists public.packing_lines (
  id       bigserial primary key,
  entry_id uuid not null references public.packing_entries(id) on delete cascade,
  item_id  bigint not null references public.shipment_items(id) on delete cascade,
  qty      numeric not null check (qty > 0)
);
create index if not exists packing_lines_entry_idx on public.packing_lines(entry_id);

-- units counted in whole pieces
create or replace function public.unit_is_whole(p_unit text) returns boolean
language sql immutable as $$
  select upper(coalesce(p_unit, 'PCS')) in ('PCS','CTN','BOX','BAG','PALLET','ROLL','SET','DRUM')
$$;

create or replace function public.storage_state(p_received numeric, p_packed numeric) returns text
language sql immutable as $$
  select case when coalesce(p_received, 0) = 0 then 'empty'
              when coalesce(p_packed, 0) <= 0 then 'unpacked'
              when p_packed >= p_received then 'fully_packed'
              else 'partially_packed' end
$$;

-- goods arrive in storage: called automatically when the GRN is recorded, and
-- available for extra deliveries that arrive later for the same shipment
create or replace function public.storage_receive(p_shipment uuid, p_items jsonb default null,
                                                  p_location text default null, p_source text default 'manual')
returns jsonb language plpgsql security definer set search_path = public as $$
declare it record; ln jsonb; q numeric; n int := 0; total numeric := 0;
begin
  if p_source <> 'grn' then perform public.require_perm('grn.record'); end if;
  if not exists (select 1 from public.shipments where id = p_shipment) then raise exception 'NOT_FOUND: shipment'; end if;

  if p_items is null then                      -- everything the shipment declares
    for it in select id, qty, unit from public.shipment_items where shipment_id = p_shipment loop
      insert into public.storage_stock(shipment_id, item_id, received_qty, unit, location)
      values (p_shipment, it.id, it.qty, coalesce(it.unit, 'PCS'), p_location)
      on conflict (shipment_id, item_id) do nothing;         -- received once, never doubled
      n := n + 1; total := total + it.qty;
    end loop;
  else
    for ln in select * from jsonb_array_elements(p_items) loop
      q := coalesce((ln->>'qty')::numeric, 0);
      if q <= 0 then continue; end if;
      select id, qty, unit into it from public.shipment_items
       where id = (ln->>'item_id')::bigint and shipment_id = p_shipment;
      if it.id is null then raise exception 'REFUSED: item does not belong to this shipment'; end if;
      if public.unit_is_whole(it.unit) and q <> round(q) then
        raise exception 'REFUSED: % is counted in whole pieces', coalesce(it.unit, 'PCS');
      end if;
      insert into public.storage_stock(shipment_id, item_id, received_qty, unit, location)
      values (p_shipment, it.id, q, coalesce(it.unit, 'PCS'), p_location)
      on conflict (shipment_id, item_id) do update
        set received_qty = public.storage_stock.received_qty + excluded.received_qty,   -- adds, never resets
            location = coalesce(excluded.location, public.storage_stock.location),
            updated_at = now();
      n := n + 1; total := total + q;
    end loop;
  end if;

  perform public.log_audit('storage.receive', 'shipment', p_shipment::text,
          jsonb_build_object('lines', n, 'qty', total, 'source', p_source, 'location', p_location));
  return jsonb_build_object('lines', n, 'qty', total);
end $$;

-- the GRN is the moment goods are physically received
create or replace function public.trg_storage_on_grn() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.storage_receive(new.shipment_id, null, null, 'grn');
  return null;
end $$;
drop trigger if exists storage_on_grn on public.grns;
create trigger storage_on_grn after insert on public.grns
for each row execute function public.trg_storage_on_grn();

-- ---------------------------------------------------------------------
-- 6. PACKING (partial, repeatable, safe under concurrency)
-- ---------------------------------------------------------------------
create or replace function public.record_packing(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.shipments; ln jsonb; st public.storage_stock; q numeric;
        v_id uuid; v_ref text; n int := 0; total numeric := 0; token text; dup uuid;
begin
  perform public.require_perm('storage.pack');
  s := null;
  select * into s from public.shipments where id = (p->>'shipment_id')::uuid;
  if s.id is null then raise exception 'NOT_FOUND: shipment'; end if;
  if s.status = 'cancelled' then raise exception 'REFUSED: shipment is cancelled'; end if;
  if p->'lines' is null or jsonb_array_length(p->'lines') = 0 then raise exception 'REFUSED: nothing to pack'; end if;

  token := nullif(p->>'client_token','');
  if token is not null then
    select id into dup from public.packing_entries where client_token = token;
    if dup is not null then                                   -- the same submission arrived twice
      return jsonb_build_object('id', dup, 'ref', (select ref from public.packing_entries where id = dup), 'duplicate', true);
    end if;
  end if;

  v_ref := 'HC-PK-' || public.yymm() || '-' || lpad(public.next_counter('PK-' || public.yymm())::text, 4, '0');
  insert into public.packing_entries(ref, shipment_id, notes, client_token, packed_by)
  values (v_ref, s.id, nullif(p->>'notes',''), token, auth.uid()) returning id into v_id;

  for ln in select * from jsonb_array_elements(p->'lines') loop
    q := coalesce((ln->>'qty')::numeric, 0);
    if q = 0 then continue; end if;
    if q < 0 then raise exception 'REFUSED: quantities cannot be negative'; end if;
    -- lock the stock row: two officers cannot pack the same pieces twice
    select * into st from public.storage_stock
     where shipment_id = s.id and item_id = (ln->>'item_id')::bigint for update;
    if st.id is null then raise exception 'REFUSED: that item is not in storage for this shipment'; end if;
    if public.unit_is_whole(st.unit) and q <> round(q) then
      raise exception 'REFUSED: % is counted in whole pieces', st.unit;
    end if;
    if st.packed_qty + q > st.received_qty then
      raise exception 'REFUSED: only % of % left unpacked', st.received_qty - st.packed_qty, st.unit;
    end if;
    update public.storage_stock set packed_qty = packed_qty + q, updated_at = now() where id = st.id;
    insert into public.packing_lines(entry_id, item_id, qty) values (v_id, st.item_id, q);
    n := n + 1; total := total + q;
  end loop;

  if n = 0 then raise exception 'REFUSED: nothing to pack'; end if;
  perform public.log_audit('storage.pack', 'shipment', s.id::text,
          jsonb_build_object('ref', v_ref, 'lines', n, 'qty', total));
  return jsonb_build_object('id', v_id, 'ref', v_ref, 'lines', n, 'qty', total,
                            'state', (select state from public.v_storage where shipment_id = s.id));
end $$;

create or replace function public.void_packing_entry(p_entry uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare e public.packing_entries; l record;
begin
  perform public.require_perm('storage.correct');
  if coalesce(trim(p_reason),'') = '' then raise exception 'REFUSED: a reason is required'; end if;
  select * into e from public.packing_entries where id = p_entry for update;
  if e.id is null or e.void then raise exception 'REFUSED: entry not found or already reversed'; end if;
  for l in select * from public.packing_lines where entry_id = e.id loop
    update public.storage_stock set packed_qty = greatest(packed_qty - l.qty, 0), updated_at = now()
     where shipment_id = e.shipment_id and item_id = l.item_id;
  end loop;
  update public.packing_entries set void = true, void_reason = p_reason, voided_by = auth.uid(), voided_at = now()
   where id = e.id;
  perform public.log_audit('storage.pack_void', 'shipment', e.shipment_id::text,
          jsonb_build_object('ref', e.ref, 'reason', p_reason));
end $$;

-- ---------------------------------------------------------------------
-- 7. STORAGE VIEWS
-- ---------------------------------------------------------------------
create or replace view public.v_storage_items with (security_invoker = true) as
select st.*, i.description, i.category_id, s.ref as shipment_ref, s.status as shipment_status,
       c.name as customer_name, c.phone as customer_phone,
       (st.received_qty - st.packed_qty) as remaining_qty,
       public.storage_state(st.received_qty, st.packed_qty) as state
from public.storage_stock st
join public.shipment_items i on i.id = st.item_id
join public.shipments s on s.id = st.shipment_id
join public.customers c on c.id = s.customer_id;

create or replace view public.v_storage with (security_invoker = true) as
select s.id as shipment_id, s.ref as shipment_ref, s.status as shipment_status, s.mode,
       s.origin_branch, s.destination_branch, s.created_at,
       c.name as customer_name, c.phone as customer_phone, c.code as customer_code,
       x.received_qty, x.packed_qty, x.remaining_qty, x.item_lines, x.units, x.unit_count,
       case when x.unit_count = 1 then x.single_unit end as unit,
       public.storage_state(x.received_qty, x.packed_qty) as state,
       x.first_received_at, x.last_movement
from public.shipments s
join public.customers c on c.id = s.customer_id
join lateral (
  select coalesce(sum(st.received_qty), 0) as received_qty,
         coalesce(sum(st.packed_qty), 0)   as packed_qty,
         coalesce(sum(st.received_qty - st.packed_qty), 0) as remaining_qty,
         count(*)                          as item_lines,
         count(distinct st.unit)           as unit_count,
         min(st.unit)                      as single_unit,
         min(st.first_received_at)         as first_received_at,
         max(st.updated_at)                as last_movement,
         -- a per-unit breakdown, so a shipment holding cartons and bags reads correctly
         (select coalesce(jsonb_object_agg(u.unit, jsonb_build_object(
                    'received', u.received, 'packed', u.packed, 'remaining', u.received - u.packed)), '{}'::jsonb)
            from (select st2.unit, sum(st2.received_qty) as received, sum(st2.packed_qty) as packed
                    from public.storage_stock st2 where st2.shipment_id = s.id group by st2.unit) u) as units
    from public.storage_stock st
   where st.shipment_id = s.id
) x on true
where x.item_lines > 0;   -- only shipments whose goods are actually in the warehouse

create or replace view public.v_packing_entries with (security_invoker = true) as
select e.*, s.ref as shipment_ref, c.name as customer_name, p.full_name as packed_by_name,
       v.full_name as voided_by_name,
       (select coalesce(sum(l.qty), 0) from public.packing_lines l where l.entry_id = e.id) as total_qty,
       (select count(*) from public.packing_lines l where l.entry_id = e.id) as line_count
from public.packing_entries e
join public.shipments s on s.id = e.shipment_id
join public.customers c on c.id = s.customer_id
left join public.profiles p on p.id = e.packed_by
left join public.profiles v on v.id = e.voided_by;

create or replace view public.v_packing_lines with (security_invoker = true) as
select l.*, e.ref as entry_ref, e.shipment_id, e.packed_at, e.void, e.packed_by,
       i.description, i.unit, p.full_name as packed_by_name
from public.packing_lines l
join public.packing_entries e on e.id = l.entry_id
join public.shipment_items i on i.id = l.item_id
left join public.profiles p on p.id = e.packed_by;

-- ---------------------------------------------------------------------
-- 8. HISTORICAL RECONCILIATION
--
-- Storage did not exist before this migration, so there is no packing
-- history to import. The only trustworthy evidence of what was physically
-- received is the GRN, and the only trustworthy evidence that goods have
-- left the warehouse is the shipment status. So:
--   * a shipment with no GRN gets no stock at all (nothing was ever
--     confirmed as physically received);
--   * a cancelled shipment gets no stock;
--   * a shipment still sitting in Dubai (received_dubai) becomes
--     received / unpacked;
--   * a shipment that is packed or already gone (dispatched, in transit,
--     in customs, arrived, delivered) is recorded as received AND fully
--     packed, so goods that left long ago never reappear as loose stock.
-- Every migrated "fully packed" shipment gets one packing entry carrying
-- the reason, so the packing history still adds up to the packed figure
-- and nothing looks like it was packed by a person.
-- Re-running is safe: stock rows are inserted only where none exist and
-- the migration entries carry a fixed client_token.
-- ---------------------------------------------------------------------
create or replace function public.storage_migrate_v4() returns jsonb
language plpgsql security definer set search_path = public as $$
declare s record; v_id uuid; v_ref text; n_ship int := 0; n_pack int := 0; already boolean;
begin
  -- from the app this is an administrator action; run straight from psql it is the migration itself
  if auth.uid() is not null then perform public.require_role('admin'); end if;
  for s in
    select sh.id, sh.ref, sh.status,
           (sh.status in ('packed','dispatched','in_transit','in_customs','arrived','delivered')) as gone
      from public.shipments sh
     where sh.status <> 'cancelled'
       and exists (select 1 from public.grns g where g.shipment_id = sh.id)
       and exists (select 1 from public.shipment_items i where i.shipment_id = sh.id)
       and not exists (select 1 from public.storage_stock st where st.shipment_id = sh.id)
  loop
    insert into public.storage_stock(shipment_id, item_id, received_qty, packed_qty, unit)
    select s.id, i.id, i.qty, case when s.gone then i.qty else 0 end, coalesce(i.unit, 'PCS')
      from public.shipment_items i
     where i.shipment_id = s.id and coalesce(i.qty, 0) > 0
    on conflict (shipment_id, item_id) do nothing;

    n_ship := n_ship + 1;

    if s.gone then
      already := exists (select 1 from public.packing_entries where client_token = 'migrate:' || s.id::text);
      if not already then
        v_ref := 'HC-PK-MIG-' || right(s.id::text, 8);
        insert into public.packing_entries(ref, shipment_id, notes, client_token, packed_by, packed_at)
        values (v_ref, s.id,
                'Opening balance: recorded as fully packed when the Storage module was introduced, '
                || 'because this shipment had already reached status "' || s.status || '".',
                'migrate:' || s.id::text, null,
                coalesce((select g.received_at from public.grns g where g.shipment_id = s.id), now()))
        returning id into v_id;
        insert into public.packing_lines(entry_id, item_id, qty)
        select v_id, i.id, i.qty from public.shipment_items i
         where i.shipment_id = s.id and coalesce(i.qty, 0) > 0;
        n_pack := n_pack + 1;
      end if;
    end if;
  end loop;

  if n_ship > 0 then
    perform public.log_audit('storage.migrate', 'system', 'v4',
            jsonb_build_object('shipments', n_ship, 'opening_packed_entries', n_pack));
  end if;
  return jsonb_build_object('shipments', n_ship, 'opening_packed_entries', n_pack);
end $$;

-- run it once now, as part of the migration itself
do $$
declare r jsonb;
begin
  select public.storage_migrate_v4() into r;
  raise notice 'storage migration: %', r;
end $$;

-- ---------------------------------------------------------------------
-- 9. ROW LEVEL SECURITY AND GRANTS
--
-- Staff read; every write goes through an RPC that checks a permission,
-- so the tables themselves are read-only to logged-in users and invisible
-- to anonymous visitors. This is what stops a direct API call from
-- recording a payment or packing goods without the right permission.
-- ---------------------------------------------------------------------
alter table public.role_permissions enable row level security;
alter table public.permission_grants enable row level security;
alter table public.staff_invites     enable row level security;
alter table public.storage_stock     enable row level security;
alter table public.packing_entries   enable row level security;
alter table public.packing_lines     enable row level security;

drop policy if exists staff_read on public.role_permissions;
create policy staff_read on public.role_permissions for select to authenticated using (public.is_staff());

drop policy if exists staff_read on public.permission_grants;
create policy staff_read on public.permission_grants for select to authenticated
  using (user_id = auth.uid() or public.has_role('manager'));

drop policy if exists admin_read on public.staff_invites;
create policy admin_read on public.staff_invites for select to authenticated using (public.has_role('admin'));

drop policy if exists staff_read on public.storage_stock;
create policy staff_read on public.storage_stock for select to authenticated using (public.is_staff());

drop policy if exists staff_read on public.packing_entries;
create policy staff_read on public.packing_entries for select to authenticated using (public.is_staff());

drop policy if exists staff_read on public.packing_lines;
create policy staff_read on public.packing_lines for select to authenticated using (public.is_staff());

-- tables: read only; all changes travel through the RPCs above
grant select on public.role_permissions, public.permission_grants, public.staff_invites,
                public.storage_stock, public.packing_entries, public.packing_lines to authenticated;
revoke insert, update, delete on public.role_permissions, public.permission_grants, public.staff_invites,
                public.storage_stock, public.packing_entries, public.packing_lines from authenticated;
revoke all on public.role_permissions, public.permission_grants, public.staff_invites,
               public.storage_stock, public.packing_entries, public.packing_lines from anon;

-- keep the new views readable and the baseline grants intact
grant usage, select on all sequences in schema public to authenticated;
revoke delete on all tables in schema public from authenticated;
revoke all on all tables in schema public from anon;

revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated;
grant  execute on function public.track_shipment(text)  to anon;
grant  execute on function public.verify_document(text) to anon;

-- internal helpers: reachable only from inside the security-definer RPCs
revoke execute on function public.next_counter(text)                         from authenticated;
revoke execute on function public.log_audit(text,text,text,jsonb)            from authenticated;
revoke execute on function public.rpc_mode()                                 from authenticated;
revoke execute on function public.handle_new_user()                          from authenticated;
revoke execute on function public.trg_profile_guard()                        from authenticated;
revoke execute on function public.trg_storage_on_grn()                       from authenticated;
revoke execute on function public.storage_receive(uuid,jsonb,text,text)      from authenticated;
do $$
begin
  if to_regprocedure('public.recalc_invoice(uuid)') is not null then
    execute 'revoke execute on function public.recalc_invoice(uuid) from authenticated';
  end if;
  if to_regprocedure('public.add_event(uuid,public.ship_status,text,text,text,boolean,public.ship_status)') is not null then
    execute 'revoke execute on function public.add_event(uuid,public.ship_status,text,text,text,boolean,public.ship_status) from authenticated';
  end if;
  if to_regprocedure('public.doc_touch(text,text,text)') is not null then
    execute 'revoke execute on function public.doc_touch(text,text,text) from authenticated';
  end if;
end $$;

select 'V4-PART9' as done;

