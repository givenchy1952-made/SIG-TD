-- Apply after 023. Preserve optional financial columns on future order imports.
-- Existing sixteen-column originals and all order/production data are unchanged.
begin;

create or replace function public.get_budget_order_metadata_capability() returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce(public.current_app_role() in ('admin','internal'),false)
$$;
revoke execute on function public.get_budget_order_metadata_capability() from public,anon,service_role;
grant execute on function public.get_budget_order_metadata_capability() to authenticated;

create or replace function public.validate_order_source_data(d jsonb) returns void
language plpgsql immutable set search_path=public,pg_temp as $$
declare
 columns text[]:=array['A','F','L','M','S','V','W','X','Y','AQ','AR','AS','AT','AU','AV','AY'];
 optional_columns text[]:=array['K','BH','BZ']; item jsonb; cell jsonb; key text;
 seen integer[]:='{}'; row_number integer;
begin
 perform public.operations_shape(d,array['fileName','sheetName','headers','rows']);
 if octet_length(d::text)>1048576 then raise exception 'INVALID_ORDER_SOURCE: source payload exceeds 1MB';end if;
 perform public.operations_text(d,'fileName',255,true);perform public.operations_text(d,'sheetName',100,true);
 -- An optional column is accepted only as a matched header/cell key. The
 -- original required columns and strict primitive-value validation stay intact.
 foreach key in array optional_columns loop
  if d->'headers' ? key then columns:=array_append(columns,key);end if;
 end loop;
 perform public.operations_shape(d->'headers',columns);
 foreach key in array columns loop perform public.operations_text(d->'headers',key,4000);end loop;
 if jsonb_typeof(d->'rows') is distinct from 'array' or jsonb_array_length(d->'rows') not between 1 and 100 then raise exception 'INVALID_ORDER_SOURCE: 1 to 100 original rows required';end if;
 for item in select * from jsonb_array_elements(d->'rows') loop
  perform public.operations_shape(item,array['rowNumber','columns']);
  if jsonb_typeof(item->'rowNumber') is distinct from 'number' or item->>'rowNumber' !~ '^[0-9]+$' or (item->>'rowNumber')::numeric not between 1 and 10000 then raise exception 'INVALID_ORDER_SOURCE: invalid row number';end if;
  row_number:=(item->>'rowNumber')::integer;
  if row_number=any(seen) then raise exception 'INVALID_ORDER_SOURCE: duplicate row number';end if;
  seen:=array_append(seen,row_number);
  perform public.operations_shape(item->'columns',columns);
  foreach key in array columns loop
   cell:=item->'columns'->key;
   if jsonb_typeof(cell) not in ('string','number','boolean','null') then raise exception 'INVALID_ORDER_SOURCE: primitive cell values only';end if;
   if jsonb_typeof(cell)='string' and length(item->'columns'->>key)>4000 then raise exception 'INVALID_ORDER_SOURCE: cell text exceeds 4000 characters';end if;
   if jsonb_typeof(cell)='number' and abs((item->'columns'->>key)::numeric)>1000000000000000 then raise exception 'INVALID_ORDER_SOURCE: cell numeric magnitude exceeded';end if;
  end loop;
 end loop;
end $$;
revoke execute on function public.validate_order_source_data(jsonb) from public,anon,authenticated,service_role;

commit;
