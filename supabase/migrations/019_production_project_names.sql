-- Read-only production-name projection. Requires 003 operations and 005 project
-- metadata. No projects, styles, source rows, financial records or IDs are changed.
-- M = production name, L = season. A and the original source are never returned.
begin;

drop function if exists public.get_production_project_names();
create or replace function public.get_production_project_names(p_project_id uuid default null)
returns setof jsonb language sql stable security definer set search_path = '' as $$
 with actor as (
  select id,role,factory_id from public.profiles
  where id=auth.uid() and approved and active
 ), allowed as (
  select p.id,btrim(coalesce(p.name,'')) name,btrim(coalesce(p.code,'')) code,
   btrim(coalesce(p.season,'')) season
  from public.projects p cross join actor a
  where (p_project_id is null or p.id=p_project_id) and (a.role in ('admin','internal')
   or (a.role='factory' and a.factory_id is not null and exists (
    select 1 from public.styles s where s.deleted_at is null
     and s.data->>'projectId'=p.id::text and s.data->>'factoryId'=a.factory_id::text
     and public.can_access_style(s.id)
   )))
 ), source_rows as (
  select p.id,row.value->'columns' columns
  from allowed p join public.styles s on s.data->>'projectId'=p.id::text and s.deleted_at is null
  join public.order_source_records r on r.style_id=s.id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(r.rows_data)='array' then r.rows_data else '[]'::jsonb end) row
  where exists(select 1 from jsonb_array_elements(case when jsonb_typeof(s.data->'production')='array' then s.data->'production' else '[]'::jsonb end) line where line->>'id'=r.line_id::text)
 ), source_values as (
  select id,columns,btrim(coalesce(columns->>'A','')) code,
   btrim(coalesce(columns->>'M','')) name,btrim(coalesce(columns->>'L','')) season
  from source_rows
 ), meaningful as (
  select *, (
   jsonb_typeof(columns->'A')='string' and jsonb_typeof(columns->'M')='string' and jsonb_typeof(columns->'L')='string'
   and length(code) between 1 and 120 and length(name) between 1 and 160 and length(season) between 1 and 30
   and code !~ '[[:cntrl:]]' and name !~ '[[:cntrl:]]' and season !~ '[[:cntrl:]]'
   and code !~* '^#(REF!|NAME\?|VALUE!|DIV/0!|N/A|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$'
   and name !~* '^#(REF!|NAME\?|VALUE!|DIV/0!|N/A|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$'
   and season !~* '^#(REF!|NAME\?|VALUE!|DIV/0!|N/A|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$'
   and upper(name)<>upper(code) and name<>'프로젝트 명칭 미등록'
   and name !~* '^SIGNIFICANT-[0-9]{4}[A-Z]*-(MPQ|RPQ|MOQ|OPQ)-[0-9]+$'
  ) valid
  from source_values where code<>'' or name<>'' or season<>''
 ), sources as (
  select id,min(code) code,min(name) name,min(season) season,
   bool_and(coalesce(valid,false)) valid,count(distinct jsonb_build_array(upper(code),name,season)) variants
  from meaningful group by id
 ), identified as (
  select p.*,s.name source_name,s.season source_season,
   (p.name<>'' and length(p.name)<=160 and p.name !~ '[[:cntrl:]]'
    and p.name<>'프로젝트 명칭 미등록' and (p.code='' or upper(p.name)<>upper(p.code))
    and p.name !~* '^#(REF!|NAME\?|VALUE!|DIV/0!|N/A|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$'
    and p.name !~* '^SIGNIFICANT-[0-9]{4}[A-Z]*-(MPQ|RPQ|MOQ|OPQ)-[0-9]+$'
    and not (p.code='' and exists(select 1 from meaningful m where m.id=p.id and upper(m.code)=upper(p.name)))) canonical,
   (s.valid and s.variants=1 and (p.code='' or upper(p.code)=upper(s.code))
    and (p.season='' or p.season=s.season)
    and (p.name='' or upper(p.name)=upper(coalesce(nullif(p.code,''),s.code)))
    and not exists(select 1 from public.projects other where other.id<>p.id and btrim(coalesce(other.code,''))<>'' and upper(btrim(other.code))=upper(s.code))) repaired
  from allowed p left join sources s on s.id=p.id
 )
 select jsonb_build_object('projectId',id,
  'name',case when canonical then name when repaired then source_name else '' end,
  'season',case when canonical then season when repaired then coalesce(nullif(season,''),source_season) else season end)
 from identified order by id;
$$;

revoke execute on function public.get_production_project_names(uuid) from public,anon,service_role;
grant execute on function public.get_production_project_names(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
