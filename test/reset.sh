#!/bin/bash
# Recreate local test DB with schema, seed and test users (password: Pass1234!)
cd "$(dirname "$0")/.."
# close any pooled connections first, otherwise DROP DATABASE silently fails and the old data survives
su postgres -c "psql -q -c \"select pg_terminate_backend(pid) from pg_stat_activity where datname = 'hc' and pid <> pg_backend_pid()\"" >/dev/null 2>&1
su postgres -c "psql -q -c 'drop database if exists hc' -c 'create database hc'" >/dev/null
su postgres -c "psql -d hc -v ON_ERROR_STOP=1 -q -f test/supabase_shim.sql -f supabase/schema.sql -f supabase/seed.sql" 2>&1 | grep -v NOTICE
su postgres -c "psql -d hc -v ON_ERROR_STOP=1 -q -f supabase/accounting-1-roles.sql"
su postgres -c "psql -d hc -v ON_ERROR_STOP=1 -q -f supabase/accounting-2.sql -f supabase/shipments-v2.sql -f supabase/documents-v3.sql" 2>&1 | grep -v NOTICE
su postgres -c "psql -d hc -q" <<'SQL'
insert into auth.users(id,email,encrypted_password,raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000001','admin@hc.test',crypt('Pass1234!',gen_salt('bf')),'{"full_name":"Abdul Admin"}');
insert into auth.users(id,email,encrypted_password,raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000002','counter@hc.test',crypt('Pass1234!',gen_salt('bf')),'{"full_name":"Fatma Counter"}'),
 ('00000000-0000-0000-0000-000000000003','cashier@hc.test',crypt('Pass1234!',gen_salt('bf')),'{"full_name":"Salim Cashier"}'),
 ('00000000-0000-0000-0000-000000000004','warehouse@hc.test',crypt('Pass1234!',gen_salt('bf')),'{"full_name":"Rashid Warehouse"}'),
 ('00000000-0000-0000-0000-000000000005','ops@hc.test',crypt('Pass1234!',gen_salt('bf')),'{"full_name":"Neema Operations"}'),
 ('00000000-0000-0000-0000-000000000006','release@hc.test',crypt('Pass1234!',gen_salt('bf')),'{"full_name":"Baraka Release"}'),
 ('00000000-0000-0000-0000-000000000007','accountant@hc.test',crypt('Pass1234!',gen_salt('bf')),'{"full_name":"Zawadi Accountant"}'),
 ('00000000-0000-0000-0000-000000000008','finance@hc.test',crypt('Pass1234!',gen_salt('bf')),'{"full_name":"Omari Finance"}');
update profiles set branch_code='DXB' where email='admin@hc.test';
SQL
echo reset-done
