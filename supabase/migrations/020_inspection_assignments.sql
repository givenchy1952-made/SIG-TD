-- Quality inspectors receive only explicitly assigned, minimal inspection orders.
-- Apply after 019. No factory is inferred from its name, reclassified, or created.
begin;

alter table public.factories add column if not exists active boolean not null default true;
alter table public.factories add column if not exists service_type text not null default 'production';
alter table public.factories add column if not exists inspection_provider text;
alter table public.factories add column if not exists service_settings_version integer not null default 0;
do $$begin
 if not exists(select 1 from pg_constraint where conrelid='public.factories'::regclass and conname='factories_service_type_check') then
  alter table public.factories add constraint factories_service_type_check check(service_type in ('production','label','embroidery','inspection'));
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.factories'::regclass and conname='factories_inspection_provider_check') then
  alter table public.factories add constraint factories_inspection_provider_check check((inspection_provider is null or inspection_provider in ('able','kotiti')) and (service_type='inspection' or inspection_provider is null));
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.factories'::regclass and conname='factories_service_settings_version_check') then
  alter table public.factories add constraint factories_service_settings_version_check check(service_settings_version>=0);
 end if;
end $$;
create unique index if not exists factories_inspection_provider_unique on public.factories(inspection_provider) where service_type='inspection' and inspection_provider is not null;

create table if not exists public.inspection_assignments (
 style_id uuid not null references public.styles(id) on delete restrict,line_id uuid not null,
 provider text check(provider in ('able','kotiti')),version integer not null check(version>0),
 updated_at timestamptz not null default clock_timestamp(),updated_by uuid not null references public.profiles(id),
 primary key(style_id,line_id)
);
create table if not exists public.inspection_assignment_events (
 id uuid primary key default gen_random_uuid(),style_id uuid not null references public.styles(id) on delete restrict,
 line_id uuid not null,actor_id uuid not null references public.profiles(id),actor_name text not null,
 reason text not null,before jsonb,after jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create index if not exists inspection_assignment_events_style_idx on public.inspection_assignment_events(style_id,line_id,created_at);
create table if not exists public.factory_service_settings_events (
 id uuid primary key default gen_random_uuid(),factory_id uuid not null references public.factories(id) on delete restrict,
 actor_id uuid not null references public.profiles(id),actor_name text not null,reason text not null,
 before jsonb not null,after jsonb not null,created_at timestamptz not null default clock_timestamp()
);

-- A configured inspector remains an inspector even while inactive or awaiting
-- provider configuration; it must never fall through to production access.
create or replace function public.is_inspection_actor() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p join public.factories f on f.id=p.factory_id where p.id=auth.uid() and p.role='factory' and f.service_type='inspection')
$$;
revoke execute on function public.is_inspection_actor() from public,anon,service_role;
grant execute on function public.is_inspection_actor() to authenticated;
create or replace function public.current_app_role() returns text language sql stable security definer set search_path='' as $$
 select p.role from public.profiles p where p.id=auth.uid() and p.approved and p.active and not public.is_inspection_actor()
$$;
create or replace function public.can_access_style(p_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.styles s join public.profiles p on p.id=auth.uid()
  where s.id=p_id and p.approved and p.active and (s.deleted_at is null or p.role='admin')
  and (p.role in ('admin','internal') or p.role='factory' and s.data->>'factoryId'=p.factory_id::text
    and exists(select 1 from public.factories f where f.id=p.factory_id and f.active and f.service_type<>'inspection')))
$$;
create or replace function public.operations_actor() returns public.profiles language plpgsql stable security definer set search_path='' as $$
declare actor public.profiles;
begin
 select * into actor from public.profiles where id=auth.uid() and approved and active;
 if not found or public.is_inspection_actor() then raise exception 'FORBIDDEN: approved production or HQ account required' using errcode='42501';end if;
 return actor;
end $$;

-- Inspectors can read their own vendor identity without opening production
-- projects, orders, raw styles, files, prices, PO or original spreadsheets.
drop policy if exists factories_inspection_self_read on public.factories;
create policy factories_inspection_self_read on public.factories for select to authenticated using(exists(select 1 from public.profiles p where p.id=auth.uid() and p.approved and p.active and p.role='factory' and p.factory_id=factories.id and factories.service_type='inspection'));

create or replace function public.protect_inspection_history() returns trigger language plpgsql set search_path='' as $$begin raise exception 'HISTORY_PROTECTED: inspection history cannot be rewritten or deleted';end $$;
create or replace function public.protect_inspection_assignment_identity() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' or new.style_id is distinct from old.style_id or new.line_id is distinct from old.line_id then raise exception 'HISTORY_PROTECTED: clear the provider instead of deleting assignment history';end if;
 if new.version<>old.version+1 then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if not exists(select 1 from public.profiles where id=auth.uid() and active and approved and role in ('admin','internal') and id=new.updated_by) then raise exception 'FORBIDDEN: HQ assignment required' using errcode='42501';end if;
 return new;
end $$;
drop trigger if exists inspection_assignment_identity on public.inspection_assignments;
create trigger inspection_assignment_identity before update or delete on public.inspection_assignments for each row execute function public.protect_inspection_assignment_identity();
drop trigger if exists inspection_assignment_event_history on public.inspection_assignment_events;
create trigger inspection_assignment_event_history before update or delete on public.inspection_assignment_events for each row execute function public.protect_inspection_history();
drop trigger if exists factory_service_event_history on public.factory_service_settings_events;
create trigger factory_service_event_history before update or delete on public.factory_service_settings_events for each row execute function public.protect_inspection_history();
create or replace function public.protect_factory_service_settings() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.service_type is distinct from old.service_type or new.inspection_provider is distinct from old.inspection_provider or new.service_settings_version is distinct from old.service_settings_version then
  if not exists(select 1 from public.profiles where id=auth.uid() and approved and active and role='admin') then raise exception 'FORBIDDEN: vendor service settings require administrator' using errcode='42501';end if;
  if new.service_settings_version<>old.service_settings_version+1 then raise exception 'VERSION_CONFLICT: service settings version must advance once' using errcode='40001';end if;
 end if;
 return new;
end $$;
drop trigger if exists factory_service_settings_guard on public.factories;
create trigger factory_service_settings_guard before update on public.factories for each row execute function public.protect_factory_service_settings();

create or replace function public.save_factory_service_settings(p_id uuid,p_service_type text,p_inspection_provider text,p_expected_version integer,p_reason text)
returns public.factories language plpgsql security definer set search_path='' as $$
declare actor public.profiles;prior public.factories;result public.factories;
begin
 select * into actor from public.profiles where id=auth.uid() and approved and active and role='admin';
 if actor.id is null then raise exception 'FORBIDDEN: approved administrator required' using errcode='42501';end if;
 perform public.operations_reason(p_reason);
 if p_service_type is null or p_service_type not in ('production','label','embroidery','inspection') or p_inspection_provider is not null and (p_inspection_provider not in ('able','kotiti') or p_service_type<>'inspection') then raise exception 'INVALID_VENDOR_SERVICE';end if;
 select * into prior from public.factories where id=p_id for update;
 if prior.id is null then raise exception 'NOT_FOUND: registered vendor required';end if;
 if p_expected_version is null or prior.service_settings_version<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 update public.factories set service_type=p_service_type,inspection_provider=p_inspection_provider,service_settings_version=service_settings_version+1 where id=p_id returning * into result;
 insert into public.factory_service_settings_events(factory_id,actor_id,actor_name,reason,before,after) values(p_id,actor.id,actor.name,btrim(p_reason),to_jsonb(prior),to_jsonb(result));
 return result;
end $$;

create or replace function public.get_inspection_assignments_capability() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p left join public.factories f on f.id=p.factory_id
  where p.id=auth.uid() and p.approved and p.active and (p.role in ('admin','internal') or p.role='factory' and f.active and f.service_type='inspection'))
$$;
create or replace function public.save_inspection_assignment(p_style_id uuid,p_line_id uuid,p_provider text,p_expected_version integer,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare actor public.profiles;s public.styles;prior public.inspection_assignments;result public.inspection_assignments;vendor public.factories;
begin
 select * into actor from public.profiles where id=auth.uid() and approved and active and role in ('admin','internal');
 if actor.id is null then raise exception 'FORBIDDEN: approved HQ account required' using errcode='42501';end if;
 perform public.operations_reason(p_reason);
 if p_provider is not null and p_provider not in ('able','kotiti') then raise exception 'INVALID_INSPECTION_PROVIDER';end if;
 select * into s from public.styles where id=p_style_id and deleted_at is null for update;
 if s.id is null or not public.can_access_style(s.id) or not exists(select 1 from jsonb_array_elements(s.data->'production') line where line->>'id'=p_line_id::text) then raise exception 'FORBIDDEN: stored style and color required' using errcode='42501';end if;
 select * into prior from public.inspection_assignments where style_id=s.id and line_id=p_line_id for update;
 if p_expected_version is null or p_expected_version<0 or coalesce(prior.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if p_provider is not null then
  select * into vendor from public.factories where active and service_type='inspection' and inspection_provider=p_provider for share;
  if vendor.id is null then raise exception 'INSPECTION_VENDOR_REQUIRED: configure an active inspection vendor first';end if;
 end if;
 insert into public.inspection_assignments(style_id,line_id,provider,version,updated_at,updated_by) values(s.id,p_line_id,p_provider,p_expected_version+1,clock_timestamp(),actor.id)
 on conflict(style_id,line_id) do update set provider=excluded.provider,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by returning * into result;
 insert into public.inspection_assignment_events(style_id,line_id,actor_id,actor_name,reason,before,after) values(s.id,p_line_id,actor.id,actor.name,btrim(p_reason),case when prior.style_id is null then null else to_jsonb(prior) end,to_jsonb(result));
end $$;

-- Private, single-project M/L lookup. It deliberately does not grant access to
-- the original orders. Only get_inspection_orders calls it after assignment.
create or replace function public.inspection_project_identity(p_project_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 with p as (select id,btrim(name) name,btrim(code) code,btrim(season) season from public.projects where id=p_project_id),
 raw as (
  select row.value->'columns' c from p join public.styles s on s.data->>'projectId'=p.id::text and s.deleted_at is null
  join public.order_source_records r on r.style_id=s.id cross join lateral jsonb_array_elements(case when jsonb_typeof(r.rows_data)='array' then r.rows_data else '[]'::jsonb end) row
  where exists(select 1 from jsonb_array_elements(s.data->'production') line where line->>'id'=r.line_id::text)
 ), cells as (select c,btrim(coalesce(c->>'A','')) a,btrim(coalesce(c->>'M','')) m,btrim(coalesce(c->>'L','')) l from raw),
 meaningful as (select * from cells where a<>'' or m<>'' or l<>''),
 source as (select min(a) a,min(m) m,min(l) l,count(distinct jsonb_build_array(upper(a),m,l)) variants,
  bool_and(coalesce(jsonb_typeof(c->'A')='string' and jsonb_typeof(c->'M')='string' and jsonb_typeof(c->'L')='string'
   and length(a) between 1 and 120 and length(m) between 1 and 160 and length(l) between 1 and 30
   and a !~ '[[:cntrl:]]' and m !~ '[[:cntrl:]]' and l !~ '[[:cntrl:]]'
   and m<> '프로젝트 명칭 미등록' and upper(m)<>upper(a)
   and m !~* '^#(REF!|NAME\?|VALUE!|DIV/0!|N/A|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$'
   and m !~* '^SIGNIFICANT-[0-9]{4}[A-Z]*-(MPQ|RPQ|MOQ|OPQ)-[0-9]+$',false)) valid from meaningful),
 resolved as (select p.*,source.m,source.l,
  (p.name<>'' and length(p.name)<=160 and p.name !~ '[[:cntrl:]]' and p.name<>'프로젝트 명칭 미등록'
   and p.name !~* '^#(REF!|NAME\?|VALUE!|DIV/0!|N/A|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$'
   and (p.code='' or upper(p.name)<>upper(p.code)) and p.name !~* '^SIGNIFICANT-[0-9]{4}[A-Z]*-(MPQ|RPQ|MOQ|OPQ)-[0-9]+$'
   and not(p.code='' and exists(select 1 from meaningful c where upper(c.a)=upper(p.name)))) canonical,
  (source.valid and source.variants=1 and (p.code='' or upper(p.code)=upper(source.a)) and (p.season='' or p.season=source.l)
   and (p.name='' or upper(p.name)=upper(coalesce(nullif(p.code,''),source.a)))
   and not exists(select 1 from public.projects other where other.id<>p.id and btrim(other.code)<>'' and upper(btrim(other.code))=upper(source.a))) repaired from p cross join source)
 select jsonb_build_object('name',case when canonical then name when repaired then m else '프로젝트 명칭 미등록' end,'season',case when repaired then coalesce(nullif(season,''),l) else season end) from resolved
$$;

create or replace function public.get_inspection_orders() returns setof jsonb language plpgsql stable security definer set search_path='' as $$
declare actor public.profiles;vendor public.factories;row record;identity jsonb;identities jsonb:='{}';pid text;qty jsonb;quality jsonb;
begin
 select * into actor from public.profiles where id=auth.uid() and approved and active;
 if actor.id is null then return;end if;
 if actor.role='factory' then
  select * into vendor from public.factories where id=actor.factory_id and active and service_type='inspection' and inspection_provider is not null;
  if vendor.id is null then return;end if;
 elsif actor.role not in ('admin','internal') then return;end if;
 for row in select s.id,s.data,line.value line,a.provider,d.data details from public.styles s
  cross join lateral jsonb_array_elements(s.data->'production') line
  left join public.inspection_assignments a on a.style_id=s.id and a.line_id::text=line.value->>'id'
  left join public.production_details d on d.style_id=s.id and d.line_id::text=line.value->>'id'
  where s.deleted_at is null and (actor.role in ('admin','internal') and public.can_access_style(s.id) or actor.role='factory' and a.provider=vendor.inspection_provider)
  order by s.id,line.value->>'id'
 loop
  pid:=row.data->>'projectId';identity:=identities->pid;
  if identity is null then identity:=coalesce(public.inspection_project_identity(pid::uuid),jsonb_build_object('name','프로젝트 명칭 미등록','season',''));identities:=jsonb_set(identities,array[pid],identity,true);end if;
  -- Enumerate size cells rather than returning a raw legacy JSON object.
  -- This keeps the projection minimal even if old data contain extra keys.
  select jsonb_object_agg(size,coalesce(row.line->'order'->size,'0'::jsonb)) into qty
   from unnest(array['XXS','XS','S','M','L','XL']) size;
  quality:=row.details->'quality';
  return next jsonb_build_object('styleId',row.id,'lineId',row.line->>'id','projectId',pid,'projectName',identity->>'name','season',coalesce(nullif(identity->>'season',''),row.data->>'season',''),
   'styleCode',row.data->>'code','color',row.line->>'color','order',qty,'orderQuantity',public.production_quantity_total(qty),'dueDate',coalesce(row.data->>'dueDate',''),'provider',row.provider,
   'quality',jsonb_build_object('category',coalesce(quality->>'category',''),'status',coalesce(quality->>'status','unset'),'quantity',coalesce((quality->>'quantity')::bigint,0),'note',coalesce(quality->>'note','')));
 end loop;
end $$;

-- Existing production RPCs include direct factory predicates. Keep their exact
-- previous behavior for production accounts, and close them for inspectors.
do $$begin
 if to_regprocedure('public.inspection_legacy_supplier_orders()') is null then alter function public.get_supplier_production_orders() rename to inspection_legacy_supplier_orders;end if;
 if to_regprocedure('public.inspection_legacy_production_conditions()') is null then alter function public.get_production_conditions() rename to inspection_legacy_production_conditions;end if;
 if to_regprocedure('public.inspection_legacy_partial_deliveries()') is null then alter function public.get_partial_delivery_plans() rename to inspection_legacy_partial_deliveries;end if;
end $$;
create or replace function public.get_supplier_production_orders() returns setof jsonb language plpgsql stable security definer set search_path='' as $$begin if public.is_inspection_actor() then return;end if;return query select * from public.inspection_legacy_supplier_orders();end $$;
create or replace function public.get_production_conditions() returns setof jsonb language plpgsql stable security definer set search_path='' as $$begin if public.is_inspection_actor() then return;end if;return query select * from public.inspection_legacy_production_conditions();end $$;
create or replace function public.get_partial_delivery_plans() returns setof jsonb language plpgsql stable security definer set search_path='' as $$begin if public.is_inspection_actor() then return;end if;return query select * from public.inspection_legacy_partial_deliveries();end $$;
revoke execute on function public.inspection_legacy_supplier_orders(),public.inspection_legacy_production_conditions(),public.inspection_legacy_partial_deliveries(),public.inspection_project_identity(uuid),public.protect_inspection_history(),public.protect_inspection_assignment_identity(),public.protect_factory_service_settings() from public,anon,authenticated,service_role;
revoke execute on function public.get_supplier_production_orders(),public.get_production_conditions(),public.get_partial_delivery_plans() from public,anon,service_role;
grant execute on function public.get_supplier_production_orders(),public.get_production_conditions(),public.get_partial_delivery_plans() to authenticated;

alter table public.inspection_assignments enable row level security;
alter table public.inspection_assignment_events enable row level security;
alter table public.factory_service_settings_events enable row level security;
drop policy if exists inspection_assignments_hq_read on public.inspection_assignments;
create policy inspection_assignments_hq_read on public.inspection_assignments for select to authenticated using(public.current_app_role() in ('admin','internal') and public.can_access_style(style_id));
drop policy if exists inspection_assignment_events_hq_read on public.inspection_assignment_events;
create policy inspection_assignment_events_hq_read on public.inspection_assignment_events for select to authenticated using(public.current_app_role() in ('admin','internal') and public.can_access_style(style_id));
drop policy if exists factory_service_events_admin_read on public.factory_service_settings_events;
create policy factory_service_events_admin_read on public.factory_service_settings_events for select to authenticated using(public.current_app_role()='admin');
revoke all on public.inspection_assignments,public.inspection_assignment_events,public.factory_service_settings_events from public,anon,authenticated,service_role;
grant select on public.inspection_assignments,public.inspection_assignment_events,public.factory_service_settings_events to authenticated;
revoke execute on function public.get_inspection_assignments_capability(),public.get_inspection_orders(),public.save_inspection_assignment(uuid,uuid,text,integer,text),public.save_factory_service_settings(uuid,text,text,integer,text) from public,anon,service_role;
grant execute on function public.get_inspection_assignments_capability(),public.get_inspection_orders(),public.save_inspection_assignment(uuid,uuid,text,integer,text),public.save_factory_service_settings(uuid,text,text,integer,text) to authenticated;
do $$begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='inspection_assignments') then alter publication supabase_realtime add table public.inspection_assignments;end if;
end $$;
notify pgrst,'reload schema';
commit;
