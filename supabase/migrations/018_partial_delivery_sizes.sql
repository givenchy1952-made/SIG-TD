-- Size allocations extend 016's existing JSON without changing any stored plan,
-- project/style ID, production run, order, actual receipt, approval or PO record.
-- Requires 016; 017's material reviews are independent. Apply manually and
-- never rewrite or rerun initial/seed SQL in production.
begin;

create or replace function public.get_partial_delivery_sizes_capability()
returns boolean language sql stable security definer set search_path = '' as $$
 select public.get_partial_delivery_plan_capability()
$$;
revoke execute on function public.get_partial_delivery_sizes_capability() from public, anon, service_role;
grant execute on function public.get_partial_delivery_sizes_capability() to authenticated;

create or replace function public.save_partial_delivery_plan(
  p_run_id uuid, p_expected_version integer, p_items jsonb, p_reason text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  actor public.profiles;
  run public.production_runs;
  style public.styles;
  oldplan public.production_partial_delivery_plans;
  item jsonb;
  idx integer;
  count_items integer;
  qty bigint := 0;
  previous_date text := '';
  seen_ids text[] := array[]::text[];
  before_value jsonb;
  updated_value jsonb;
  stamp timestamptz := clock_timestamp();
  has_sizes boolean;
  size_key text;
  size_totals jsonb := '{"XXS":0,"XS":0,"S":0,"M":0,"L":0,"XL":0}'::jsonb;
begin
 select * into actor from public.profiles where id=auth.uid() and approved and active;
 if actor.id is null or actor.role not in ('admin','internal') then
  raise exception 'FORBIDDEN: approved HQ account required' using errcode='42501';
 end if;
 if p_run_id is null or p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_VERSION';end if;
 if p_reason is null or char_length(btrim(p_reason))<2 or char_length(btrim(p_reason))>1000 then raise exception 'INVALID_REASON';end if;
 select * into run from public.production_runs where id=p_run_id;
 if run.id is null then raise exception 'INVALID_RUN';end if;
 -- Styles are locked before runs, matching existing production ledger lock order.
 select * into style from public.styles where id=run.style_id and deleted_at is null for update;
 select * into run from public.production_runs where id=p_run_id for update;
 if style.id is null or run.id is null or not public.can_access_style(run.style_id) then
  raise exception 'FORBIDDEN: inaccessible production run' using errcode='42501';
 end if;
 if run.closed_at is not null or exists(select 1 from public.production_receipts where run_id=p_run_id)
    or exists(select 1 from public.production_condition_proposals where run_id=p_run_id)
    or exists(select 1 from public.production_condition_approvals where run_id=p_run_id)
    or exists(select 1 from public.production_order_starts where run_id=p_run_id)
    or exists(select 1 from public.production_conditions where run_id=p_run_id and status='rejected')
 then raise exception 'HISTORY_PROTECTED: supplier replied or production started'; end if;
 select * into oldplan from public.production_partial_delivery_plans where run_id=p_run_id for update;
 if coalesce(oldplan.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if p_items is null or jsonb_typeof(p_items)<>'array' then raise exception 'INVALID_DELIVERY_PLAN';end if;
 has_sizes:=exists(select 1 from jsonb_array_elements(p_items) entry where entry ? 'quantities');
 count_items:=jsonb_array_length(p_items);
 if count_items<1 or count_items>24 then raise exception 'INVALID_DELIVERY_COUNT';end if;
 for idx in 0..count_items-1 loop
  item := p_items->idx;
  -- Sized plans are complete allocations. Do not guess sizes for legacy totals.
  perform public.operations_shape(item-'quantities',array['id','dueDate','quantity','note']);
  if jsonb_typeof(item) <> 'object'
    or item->>'id' is null or (item->>'id') !~ '^[0-9a-fA-F-]{36}$'
    or item->>'id'=any(seen_ids)
    or jsonb_typeof(item->'quantity') is distinct from 'number'
    or coalesce(item->>'quantity','') !~ '^[1-9][0-9]{0,7}$'
    or (item->>'quantity')::numeric>10000000
    or coalesce(item->>'dueDate','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or jsonb_typeof(item->'note') is distinct from 'string'
    or char_length(item->>'note')>500
  then raise exception 'INVALID_DELIVERY_ITEM';end if;
  perform public.operations_uuid(item->>'id');
  perform public.validate_sig_date(item->>'dueDate');
  if has_sizes then
   perform public.operations_quantities(item->'quantities');
   if public.production_quantity_total(item->'quantities')<>(item->>'quantity')::bigint then
    raise exception 'DELIVERY_SIZE_ROW_MISMATCH: installment total must equal its size quantities';end if;
   foreach size_key in array array['XXS','XS','S','M','L','XL'] loop
    size_totals:=jsonb_set(size_totals,array[size_key],to_jsonb((size_totals->>size_key)::bigint+(item->'quantities'->>size_key)::bigint));
   end loop;
  end if;
  if previous_date<>'' and (item->>'dueDate') < previous_date then raise exception 'INVALID_DELIVERY_ORDER';end if;
  previous_date:=item->>'dueDate';
  seen_ids:=array_append(seen_ids,item->>'id');
  qty:=qty+(item->>'quantity')::bigint;
 end loop;
 if qty<>public.production_quantity_total(run.order_quantities) then
  raise exception 'DELIVERY_TOTAL_MISMATCH: schedule quantity must equal order total';end if;
 if has_sizes then
  foreach size_key in array array['XXS','XS','S','M','L','XL'] loop
   if (size_totals->>size_key)::bigint<>(run.order_quantities->>size_key)::bigint then
    raise exception 'DELIVERY_SIZE_TOTAL_MISMATCH: % installment total must equal its order quantity',size_key;end if;
  end loop;
 end if;
 before_value:=case when oldplan.run_id is null then null else jsonb_build_object('items',oldplan.items,'version',oldplan.version) end;
 insert into public.production_partial_delivery_plans(run_id,version,items,updated_at,updated_by)
 values(p_run_id,p_expected_version+1,p_items,stamp,actor.id)
 on conflict (run_id) do update set version=excluded.version, items=excluded.items, updated_at=excluded.updated_at, updated_by=excluded.updated_by;
 updated_value:=jsonb_build_object('items',p_items,'version',p_expected_version+1);
 insert into public.production_partial_delivery_plan_events(run_id,actor_id,actor_name,reason,before,after,created_at)
 values(p_run_id,actor.id,actor.name,btrim(p_reason),before_value,updated_value,stamp);
end $$;
revoke execute on function public.save_partial_delivery_plan(uuid,integer,jsonb,text) from public, anon, service_role;
grant execute on function public.save_partial_delivery_plan(uuid,integer,jsonb,text) to authenticated;
notify pgrst,'reload schema';
commit;
