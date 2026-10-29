-- Manual delivery installments belong to one production run; never create reorder runs.
-- Apply once after 014_production_conditions.sql and 015_production_po_link.sql.
begin;

create table if not exists public.production_partial_delivery_plans (
  run_id uuid primary key references public.production_runs(id) on delete restrict,
  version integer not null check(version > 0),
  items jsonb not null check(jsonb_typeof(items) = 'array'),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid not null references public.profiles(id)
);
create table if not exists public.production_partial_delivery_plan_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.production_runs(id) on delete restrict,
  actor_id uuid not null references public.profiles(id),
  actor_name text not null,
  reason text not null,
  before jsonb,
  after jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists production_partial_delivery_plan_events_run_idx
  on public.production_partial_delivery_plan_events(run_id,created_at);
alter table public.production_partial_delivery_plans enable row level security;
alter table public.production_partial_delivery_plan_events enable row level security;
revoke all on public.production_partial_delivery_plans, public.production_partial_delivery_plan_events from public, anon, authenticated;

create or replace function public.get_partial_delivery_plan_capability()
returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.profiles
   where id=auth.uid() and approved and active and (role in ('admin','internal') or role='factory' and factory_id is not null))
$$;
revoke execute on function public.get_partial_delivery_plan_capability() from public, anon;
grant execute on function public.get_partial_delivery_plan_capability() to authenticated;

create or replace function public.get_partial_delivery_plans()
returns setof jsonb language plpgsql stable security definer set search_path = '' as $$
declare actor public.profiles;
begin
 select * into actor from public.profiles where id=auth.uid() and approved and active;
 if actor.id is null then return; end if;
 return query
  select jsonb_build_object('runId',p.run_id,'version',p.version,
    'items',p.items,'updatedAt',p.updated_at,'updatedBy',p.updated_by)
  from public.production_partial_delivery_plans p
  join public.production_runs r on r.id=p.run_id
  join public.styles s on s.id=r.style_id and s.deleted_at is null
  where (actor.role in ('admin','internal') and public.can_access_style(r.style_id))
    or (actor.role='factory' and actor.factory_id=r.factory_id_snapshot
      and s.data->>'factoryId'=actor.factory_id::text)
  order by p.run_id;
end $$;
revoke execute on function public.get_partial_delivery_plans() from public, anon;
grant execute on function public.get_partial_delivery_plans() to authenticated;

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
 count_items:=jsonb_array_length(p_items);
 if count_items<1 or count_items>24 then raise exception 'INVALID_DELIVERY_COUNT';end if;
 for idx in 0..count_items-1 loop
  item := p_items->idx;
  if jsonb_typeof(item) <> 'object'
    or item->>'id' is null or (item->>'id') !~ '^[0-9a-fA-F-]{36}$'
    or item->>'id'=any(seen_ids)
    or coalesce(item->>'quantity','') !~ '^[1-9][0-9]{0,7}$'
    or coalesce(item->>'dueDate','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or jsonb_typeof(item->'note') is distinct from 'string'
    or char_length(item->>'note')>500
  then raise exception 'INVALID_DELIVERY_ITEM';end if;
  perform public.validate_sig_date(item->>'dueDate');
  if previous_date<>'' and (item->>'dueDate') < previous_date then raise exception 'INVALID_DELIVERY_ORDER';end if;
  previous_date:=item->>'dueDate';
  seen_ids:=array_append(seen_ids,item->>'id');
  qty:=qty+(item->>'quantity')::bigint;
 end loop;
 if qty<>public.production_quantity_total(run.order_quantities) then
  raise exception 'DELIVERY_TOTAL_MISMATCH: schedule quantity must equal order total';end if;
 before_value:=case when oldplan.run_id is null then null else jsonb_build_object('items',oldplan.items,'version',oldplan.version) end;
 insert into public.production_partial_delivery_plans(run_id,version,items,updated_at,updated_by)
 values(p_run_id,p_expected_version+1,p_items,stamp,actor.id)
 on conflict (run_id) do update set version=excluded.version, items=excluded.items, updated_at=excluded.updated_at, updated_by=excluded.updated_by;
 updated_value:=jsonb_build_object('items',p_items,'version',p_expected_version+1);
 insert into public.production_partial_delivery_plan_events(run_id,actor_id,actor_name,reason,before,after,created_at)
 values(p_run_id,actor.id,actor.name,btrim(p_reason),before_value,updated_value,stamp);
end $$;
revoke execute on function public.save_partial_delivery_plan(uuid,integer,jsonb,text) from public, anon;
grant execute on function public.save_partial_delivery_plan(uuid,integer,jsonb,text) to authenticated;
commit;

    or jsonb_typeof(item->'note') is distinct from 'string'
    or char_length(item->>'note')>500
  then raise exception 'INVALID_DELIVERY_ITEM';end if;
  perform public.validate_sig_date(item->>'dueDate');
  if previous_date<>'' and (item->>'dueDate') < previous_date then raise exception 'INVALID_DELIVERY_ORDER';end if;
  previous_date:=item->>'dueDate';
  seen_ids:=array_append(seen_ids,item->>'id');
  qty:=qty+(item->>'quantity')::bigint;
 end loop;
 if qty<>public.production_quantity_total(run.order_quantities) then
  raise exception 'DELIVERY_TOTAL_MISMATCH: schedule quantity must equal order total';end if;
 before_value:=case when oldplan.run_id is null then null else jsonb_build_object('items',oldplan.items,'version',oldplan.version) end;
 insert into public.production_partial_delivery_plans(run_id,version,items,updated_at,updated_by)
 values(p_run_id,p_expected_version+1,p_items,stamp,actor.id)
 on conflict (run_id) do update set version=excluded.version, items=excluded.items, updated_at=excluded.updated_at, updated_by=excluded.updated_by;
 updated_value:=jsonb_build_object('items',p_items,'version',p_expected_version+1);
 insert into public.production_partial_delivery_plan_events(run_id,actor_id,actor_name,reason,before,after,created_at)
 values(p_run_id,actor.id,actor.name,btrim(p_reason),before_value,updated_value,stamp);
end $$;
revoke execute on function public.save_partial_delivery_plan(uuid,integer,jsonb,text) from public, anon;
grant execute on function public.save_partial_delivery_plan(uuid,integer,jsonb,text) to authenticated;
commit;
