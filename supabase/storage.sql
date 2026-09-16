-- Optional: GRN photo storage. Run in Supabase SQL editor after schema.sql.
insert into storage.buckets (id, name, public) values ('cargo-photos', 'cargo-photos', false)
on conflict (id) do nothing;

drop policy if exists "staff read cargo photos" on storage.objects;
create policy "staff read cargo photos" on storage.objects for select to authenticated
  using (bucket_id = 'cargo-photos' and public.is_staff());

drop policy if exists "warehouse upload cargo photos" on storage.objects;
create policy "warehouse upload cargo photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'cargo-photos' and public.has_role('warehouse','manager'));
