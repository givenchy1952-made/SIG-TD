-- Apply once after 001_initial.sql, 002_style_images.sql and 003_operations.sql.
-- Price terms remain separate from the protected Style JSON and factory-visible data.
begin;
create table public.settlement_terms (
  style_id uuid not null references public.styles(id) on delete restrict,
  line_id uuid not null,
  project_code text not null default '' check(length(project_code)<=120 and project_code !~ '[[:cntrl:]]'),
  unit_cost numeric check(unit_cost is null or (unit_cost>=0 and unit_cost<=1000000000 and unit_cost=round(unit_cost,2))),
  item_type text not null check(item_type in ('product','fabric','label')),
  version integer not null check(version>0),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id),primary key(style_id,line_id)
);
create table public.settlement_terms_audits (
  id uuid primary key default gen_random_uuid(),style_id uuid not null,line_id uuid not null,
  actor_id uuid not null references public.profiles(id),actor_name text not null,reason text not null,
  before jsonb,after jsonb not null,created_at timestamptz not null default now(),
  foreign key(style_id,line_id) references public.settlement_terms(style_id,line_id) on delete restrict
);
create index settlement_terms_audits_parent_idx on public.settlement_terms_audits(style_id,line_id,created_at);

create function public.save_settlement_terms(p_style_id uuid,p_line_id uuid,p_expected_version integer,p_data jsonb,p_reason text)
returns public.settlement_terms language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;s public.styles;oldrow public.settlement_terms;result public.settlement_terms;cost numeric;stamp timestamptz:=clock_timestamp();
begin
  actor:=public.operations_actor();
  if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN: settlement terms are headquarters-only' using errcode='42501'; end if;
  perform public.operations_reason(p_reason);
  if p_style_id is null or p_line_id is null or p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_VERSION'; end if;
  select * into s from public.styles where id=p_style_id and deleted_at is null for update;
  if not found or not public.can_access_style(p_style_id) then raise exception 'FORBIDDEN: inaccessible style' using errcode='42501'; end if;
  if not exists(select 1 from jsonb_array_elements(s.data->'production') line where line->>'id'=p_line_id::text) then raise exception 'INVALID_SETTLEMENT: registered production line required'; end if;
  perform public.operations_shape(p_data,array['projectCode','unitCost','itemType']);
  perform public.operations_text(p_data,'projectCode',120,false);
  if p_data->>'projectCode' ~ '[[:cntrl:]]' then raise exception 'INVALID_SETTLEMENT: project code contains control characters'; end if;
  if jsonb_typeof(p_data->'itemType') is distinct from 'string' or p_data->>'itemType' not in ('product','fabric','label') then raise exception 'INVALID_SETTLEMENT: item type'; end if;
  if p_data->'unitCost'<>'null'::jsonb then
    if jsonb_typeof(p_data->'unitCost') is distinct from 'number' then raise exception 'INVALID_SETTLEMENT: numeric unit cost or null required'; end if;
    cost:=(p_data->>'unitCost')::numeric;
    if cost<0 or cost>1000000000 or cost<>round(cost,2) then raise exception 'INVALID_SETTLEMENT: unit cost range or precision'; end if;
  end if;
  select * into oldrow from public.settlement_terms where style_id=p_style_id and line_id=p_line_id for update;
  if coalesce(oldrow.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  if oldrow.style_id is null then
    insert into public.settlement_terms(style_id,line_id,project_code,unit_cost,item_type,version,created_at,updated_at,updated_by)
    values(p_style_id,p_line_id,trim(p_data->>'projectCode'),cost,p_data->>'itemType',1,stamp,stamp,actor.id) returning * into result;
  else
    update public.settlement_terms set project_code=trim(p_data->>'projectCode'),unit_cost=cost,item_type=p_data->>'itemType',version=version+1,updated_at=stamp,updated_by=actor.id
    where style_id=p_style_id and line_id=p_line_id returning * into result;
  end if;
  insert into public.settlement_terms_audits(style_id,line_id,actor_id,actor_name,reason,before,after,created_at)
  values(p_style_id,p_line_id,actor.id,actor.name,trim(p_reason),case when oldrow.style_id is null then null else to_jsonb(oldrow) end,to_jsonb(result),stamp);
  -- Factory-visible public audits contain no project codes, cost, or private snapshots.
  insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after)
  values(p_style_id,actor.id,actor.name,'을지 정산 정보 저장','본사 전용 정산 정보 변경',case when oldrow.style_id is null then null else jsonb_build_object('styleId',oldrow.style_id,'lineId',oldrow.line_id,'version',oldrow.version) end,jsonb_build_object('styleId',result.style_id,'lineId',result.line_id,'version',result.version));
  return result;
end $$;

alter table public.settlement_terms enable row level security;
alter table public.settlement_terms_audits enable row level security;
create policy settlement_terms_read on public.settlement_terms for select to authenticated using(public.current_app_role() in ('admin','internal') and public.can_access_style(style_id) and exists(select 1 from public.styles s where s.id=style_id and s.deleted_at is null));
create policy settlement_terms_audits_read on public.settlement_terms_audits for select to authenticated using(public.current_app_role() in ('admin','internal') and public.can_access_style(style_id) and exists(select 1 from public.styles s where s.id=style_id and s.deleted_at is null));
revoke all on public.settlement_terms,public.settlement_terms_audits from public,anon,authenticated;
grant select on public.settlement_terms,public.settlement_terms_audits to authenticated;
revoke execute on function public.save_settlement_terms(uuid,uuid,integer,jsonb,text) from public,anon;
grant execute on function public.save_settlement_terms(uuid,uuid,integer,jsonb,text) to authenticated;
do $$
declare t text;
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    foreach t in array array['settlement_terms','settlement_terms_audits'] loop
      if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then execute format('alter publication supabase_realtime add table public.%I',t);end if;
    end loop;
  end if;
end $$;
commit;
