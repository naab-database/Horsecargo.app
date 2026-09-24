-- helpers used only by the local test suite
create or replace function public.test_clear_storage(p_shipment uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.packing_lines l using public.packing_entries e
   where l.entry_id = e.id and e.shipment_id = p_shipment;
  delete from public.packing_entries where shipment_id = p_shipment;
  delete from public.storage_stock  where shipment_id = p_shipment;
end $$;
grant execute on function public.test_clear_storage(uuid) to authenticated;
