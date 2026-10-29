-- Persistent color/work prices, editable by HQ and the assigned active supplier.
-- Product settlement prices and work instructions keep their existing ACLs.
begin;
create table if not exists public.processing_unit_prices (
  style_id uuid not null references public.styles(id) on delete restrict,
  line_id uuid not null,
  kind text not null check(kind in ('label','embroidery','quality')),
  item_key text not null check(length(item_key) between 1 and 120 and item_key !~ '[[:cntrl:]]'),
  unit_cost numeric check(unit_cost is null or (unit_cost>=0 and unit_cost<=1000000000 and unit_cost=round(unit_cost,2))),
  version integer not null check(version>0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id),
  primary key(style_id,line_id,kind,item_key)
);
create table if not exists public.processing_unit_price_audits (
  id uuid primary key default gen_random_uuid(), style_id uuid not null, line_id uuid not null,
  kind text not null, item_key text not null, actor_id uuid not null references public.profiles(id),
  actor_name text not null, reason text not null, before jsonb, after jsonb not null,
  created_at timestamptz not null default now(),
  foreign key(style_id,line_id,kind,item_key) references public.processing_unit_prices(style_id,line_id,kind,item_key) on delete restrict
);
create index if not exists processing_unit_price_audits_parent_idx on public.processing_unit_price_audits(style_id,line_id,kind,item_key,created_at);

create or replace function public.get_processing_prices_capability() returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(public.current_app_role() in ('admin','internal','factory'),false)
$$;

create or replace function public.save_processing_unit_price(p_style_id uuid,p_line_id uuid,p_kind text,p_item_key text,p_unit_cost jsonb,p_expected_version integer,p_reason text)
returns public.processing_unit_prices language plpgsql security definer set search_path=public,pg_temp as $$
declare
  actor public.profiles; s public.styles; oldrow public.processing_unit_prices;
  result public.processing_unit_prices; cost numeric; stamp timestamptz:=clock_timestamp();
begin
  actor:=public.operations_actor();
  if p_style_id is null or p_line_id is null then raise exception 'INVALID_PROCESSING_PRICE: style and color required'; end if;
  -- Parent row lock serializes initial inserts, work-item edits, and reassignments.
  select * into s from public.styles where id=p_style_id and deleted_at is null for update;
  if not found or not public.can_access_style(p_style_id) then raise exception 'FORBIDDEN: inaccessible style' using errcode='42501'; end if;
  if not exists(select 1 from jsonb_array_elements(s.data->'production') line where line->>'id'=p_line_id::text) then raise exception 'INVALID_PROCESSING_PRICE: registered production color required'; end if;
  perform public.operations_reason(p_reason);
  if p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_VERSION'; end if;
  if p_kind is null or p_kind not in ('label','embroidery','quality') or p_item_key is null or length(p_item_key) not between 1 and 120 or p_item_key ~ '[[:cntrl:]]' then raise exception 'INVALID_PROCESSING_PRICE: work kind and item required'; end if;
  if p_kind='quality' then
    if not exists(select 1 from public.production_details d where d.style_id=p_style_id and d.line_id=p_line_id and d.data->'quality'->>'category'=p_item_key) then raise exception 'INVALID_PROCESSING_PRICE: stored quality category required'; end if;
  elsif not exists(select 1 from public.style_operations o cross join lateral jsonb_array_elements(o.rows_data) item where o.style_id=p_style_id and o.kind=p_kind and not o.voided and item->>'id'=p_item_key) then
    raise exception 'INVALID_PROCESSING_PRICE: stored active processing work required';
  end if;
  if p_unit_cost is not null and p_unit_cost<>'null'::jsonb then
    if jsonb_typeof(p_unit_cost) is distinct from 'number' then raise exception 'INVALID_PROCESSING_PRICE: numeric unit cost or null required'; end if;
    cost:=(p_unit_cost#>>'{}')::numeric;
    if cost<0 or cost>1000000000 or cost<>round(cost,2) then raise exception 'INVALID_PROCESSING_PRICE: unit cost range or precision'; end if;
  end if;
  select * into oldrow from public.processing_unit_prices where style_id=p_style_id and line_id=p_line_id and kind=p_kind and item_key=p_item_key for update;
  if coalesce(oldrow.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  if oldrow.style_id is null then
    insert into public.processing_unit_prices(style_id,line_id,kind,item_key,unit_cost,version,created_at,updated_at,updated_by)
      values(p_style_id,p_line_id,p_kind,p_item_key,cost,1,stamp,stamp,actor.id) returning * into result;
  else
    update public.processing_unit_prices set unit_cost=cost,version=version+1,updated_at=stamp,updated_by=actor.id
      where style_id=p_style_id and line_id=p_line_id and kind=p_kind and item_key=p_item_key returning * into result;
  end if;
  insert into public.processing_unit_price_audits(style_id,line_id,kind,item_key,actor_id,actor_name,reason,before,after,created_at)
    values(p_style_id,p_line_id,p_kind,p_item_key,actor.id,actor.name,trim(p_reason),case when oldrow.style_id is null then null else to_jsonb(oldrow) end,to_jsonb(result),stamp);
  -- Full historical prices are HQ-only: reassignment never exposes former quotes
  -- through the factory-readable generic style audit trail.
  insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after,created_at)
    values(p_style_id,actor.id,actor.name,'가공·품질 단가 저장','가공·품질 단가 변경',
      case when oldrow.style_id is null then null else jsonb_build_object('styleId',p_style_id,'lineId',p_line_id,'kind',p_kind,'itemKey',p_item_key,'version',oldrow.version) end,
      jsonb_build_object('styleId',p_style_id,'lineId',p_line_id,'kind',p_kind,'itemKey',p_item_key,'version',result.version),stamp);
  return result;
end $$;

alter table public.processing_unit_prices enable row level security;
alter table public.processing_unit_price_audits enable row level security;
drop policy if exists processing_unit_prices_read on public.processing_unit_prices;
create policy processing_unit_prices_read on public.processing_unit_prices for select to authenticated
  using(public.can_access_style(style_id) and exists(select 1 from public.styles s where s.id=style_id and s.deleted_at is null));
drop policy if exists processing_unit_price_audits_read on public.processing_unit_price_audits;
create policy processing_unit_price_audits_read on public.processing_unit_price_audits for select to authenticated
  using(public.current_app_role() in ('admin','internal') and public.can_access_style(style_id) and exists(select 1 from public.styles s where s.id=style_id and s.deleted_at is null));
revoke all on public.processing_unit_prices,public.processing_unit_price_audits from public,anon,authenticated,service_role;
grant select on public.processing_unit_prices,public.processing_unit_price_audits to authenticated;
revoke execute on function public.get_processing_prices_capability(),public.save_processing_unit_price(uuid,uuid,text,text,jsonb,integer,text) from public,anon,service_role;
grant execute on function public.get_processing_prices_capability(),public.save_processing_unit_price(uuid,uuid,text,text,jsonb,integer,text) to authenticated;
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='processing_unit_prices') then
    alter publication supabase_realtime add table public.processing_unit_prices;
  end if;
end $$;
notify pgrst,'reload schema';
commit;
