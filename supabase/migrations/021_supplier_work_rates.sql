-- Supplier-owned reusable work definitions and default quotations. Existing
-- style quotations are snapshots: editing a master never updates them.
-- Apply manually after 020_inspection_assignments.sql. No data is seeded here.
begin;

alter table public.operation_catalogs add column if not exists supplier_factory_id uuid references public.factories(id) on delete restrict;
alter table public.operation_catalogs add column if not exists specification text not null default '';
alter table public.style_operations add column if not exists supplier_factory_id uuid references public.factories(id) on delete restrict;
alter table public.style_operations add column if not exists supplier_name_snapshot text;
alter table public.processing_unit_prices add column if not exists supplier_factory_id uuid references public.factories(id) on delete restrict;
alter table public.processing_unit_prices add column if not exists supplier_name_snapshot text;
alter table public.processing_unit_prices add column if not exists master_rate_version integer;
alter table public.processing_unit_prices add column if not exists supplier_catalog_id uuid references public.operation_catalogs(id) on delete restrict;
drop index if exists public.operation_catalog_name_idx;
create unique index if not exists operation_catalog_global_name_idx on public.operation_catalogs(kind,lower(name)) where supplier_factory_id is null;
create unique index if not exists operation_catalog_supplier_name_idx on public.operation_catalogs(supplier_factory_id,kind,lower(name)) where supplier_factory_id is not null;

create table if not exists public.supplier_work_rates (
 factory_id uuid not null references public.factories(id) on delete restrict,
 kind text not null check(kind in ('label','embroidery','quality')),
 item_key text not null check(length(item_key) between 1 and 120 and item_key !~ '[[:cntrl:]]'),
 unit_cost numeric check(unit_cost is null or (unit_cost>=0 and unit_cost<=1000000000 and unit_cost=round(unit_cost,2))),
 version integer not null check(version>0),created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),updated_by uuid not null references public.profiles(id),
 primary key(factory_id,kind,item_key)
);
create table if not exists public.supplier_work_rate_audits (
 id uuid primary key default gen_random_uuid(),factory_id uuid not null,kind text not null,item_key text not null,
 actor_id uuid not null references public.profiles(id),actor_name text not null,reason text not null,before jsonb,after jsonb not null,
 created_at timestamptz not null default now(),foreign key(factory_id,kind,item_key) references public.supplier_work_rates(factory_id,kind,item_key) on delete restrict
);
create table if not exists public.supplier_work_item_audits (
 id uuid primary key default gen_random_uuid(),catalog_id uuid not null references public.operation_catalogs(id) on delete restrict,
 factory_id uuid not null references public.factories(id) on delete restrict,actor_id uuid not null references public.profiles(id),
 actor_name text not null,reason text not null,before jsonb,after jsonb not null,created_at timestamptz not null default now()
);

create or replace function public.can_access_supplier_work(p_factory_id uuid,p_kind text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.profiles p join public.factories f on f.id=p_factory_id
  where p.id=auth.uid() and p.approved and p.active and f.active
   and ((p_kind in ('label','embroidery') and f.service_type=p_kind) or (p_kind='quality' and f.service_type='inspection' and f.inspection_provider in ('able','kotiti')))
   and (p.role in ('admin','internal') or p.role='factory' and p.factory_id=f.id))
$$;
create or replace function public.supplier_work_actor(p_factory_id uuid,p_kind text)
returns public.profiles language plpgsql stable security definer set search_path=public,pg_temp as $$
declare actor public.profiles;
begin
 select * into actor from public.profiles where id=auth.uid() and approved and active;
 if actor.id is null or not public.can_access_supplier_work(p_factory_id,p_kind) then raise exception 'FORBIDDEN: supplier master access denied' using errcode='42501';end if;
 return actor;
end $$;
create or replace function public.get_supplier_work_rates_capability() returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.profiles p where p.id=auth.uid() and p.approved and p.active and
  (p.role in ('admin','internal') or p.role='factory' and exists(select 1 from public.factories f where f.id=p.factory_id and f.active and f.service_type in ('label','embroidery','inspection'))))
$$;
create or replace function public.supplier_work_cost(p_value jsonb) returns numeric
language plpgsql immutable set search_path=public,pg_temp as $$
declare cost numeric;
begin
 if p_value is null or p_value='null'::jsonb then return null;end if;
 if jsonb_typeof(p_value) is distinct from 'number' then raise exception 'INVALID_PROCESSING_PRICE';end if;
 cost:=(p_value#>>'{}')::numeric;
 if cost<0 or cost>1000000000 or cost<>round(cost,2) then raise exception 'INVALID_PROCESSING_PRICE';end if;
 return cost;
end $$;
create or replace function public.protect_supplier_work_history() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin raise exception 'HISTORY_PROTECTED: supplier master audit is immutable';end $$;
drop trigger if exists supplier_work_rate_history on public.supplier_work_rate_audits;
create trigger supplier_work_rate_history before update or delete on public.supplier_work_rate_audits for each row execute function public.protect_supplier_work_history();
drop trigger if exists supplier_work_item_history on public.supplier_work_item_audits;
create trigger supplier_work_item_history before update or delete on public.supplier_work_item_audits for each row execute function public.protect_supplier_work_history();

create or replace function public.save_supplier_work_rate(p_factory_id uuid,p_kind text,p_item_key text,p_unit_cost jsonb,p_expected_version integer,p_reason text)
returns public.supplier_work_rates language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;prior public.supplier_work_rates;result public.supplier_work_rates;cost numeric;stamp timestamptz:=clock_timestamp();
begin
 actor:=public.supplier_work_actor(p_factory_id,p_kind);perform public.operations_reason(p_reason);
 if p_expected_version is null or p_expected_version<0 or p_item_key is null then raise exception 'INVALID_VERSION';end if;
 perform 1 from public.factories where id=p_factory_id for update;
 actor:=public.supplier_work_actor(p_factory_id,p_kind);
 if p_kind='quality' then
  if p_item_key not in ('아우터','니트','티셔츠','바지','가방','악세사리','모자') then raise exception 'INVALID_SUPPLIER_WORK_ITEM';end if;
 elsif not exists(select 1 from public.operation_catalogs where id=public.operations_uuid(p_item_key) and supplier_factory_id=p_factory_id and kind=p_kind) then raise exception 'INVALID_SUPPLIER_WORK_ITEM';end if;
 cost:=public.supplier_work_cost(p_unit_cost);
 select * into prior from public.supplier_work_rates where factory_id=p_factory_id and kind=p_kind and item_key=p_item_key for update;
 if coalesce(prior.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 insert into public.supplier_work_rates(factory_id,kind,item_key,unit_cost,version,created_at,updated_at,updated_by)
 values(p_factory_id,p_kind,p_item_key,cost,p_expected_version+1,coalesce(prior.created_at,stamp),stamp,actor.id)
 on conflict(factory_id,kind,item_key) do update set unit_cost=excluded.unit_cost,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by returning * into result;
 insert into public.supplier_work_rate_audits(factory_id,kind,item_key,actor_id,actor_name,reason,before,after,created_at)
 values(p_factory_id,p_kind,p_item_key,actor.id,actor.name,btrim(p_reason),case when prior.factory_id is null then null else to_jsonb(prior) end,to_jsonb(result),stamp);
 return result;
end $$;

create or replace function public.save_supplier_work_item(p_id uuid,p_factory_id uuid,p_kind text,p_name text,p_specification text,p_active boolean,p_unit_cost jsonb,p_expected_catalog_version integer,p_expected_rate_version integer,p_reason text)
returns public.operation_catalogs language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;prior public.operation_catalogs;result public.operation_catalogs;stamp timestamptz:=clock_timestamp();
begin
 actor:=public.supplier_work_actor(p_factory_id,p_kind);perform public.operations_reason(p_reason);
 if p_kind not in ('label','embroidery') or p_id is null or p_expected_catalog_version is null or p_expected_catalog_version<0 or p_active is null
  or length(btrim(coalesce(p_name,''))) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or p_specification is null or length(p_specification)>1000 or p_specification ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
 then raise exception 'INVALID_SUPPLIER_WORK_ITEM';end if;
 perform 1 from public.factories where id=p_factory_id for update;
 actor:=public.supplier_work_actor(p_factory_id,p_kind);
 select * into prior from public.operation_catalogs where id=p_id for update;
 if prior.id is not null and (prior.supplier_factory_id is distinct from p_factory_id or prior.kind<>p_kind) then raise exception 'HISTORY_PROTECTED: supplier work identity cannot change';end if;
 if coalesce(prior.version,0)<>p_expected_catalog_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 insert into public.operation_catalogs(id,kind,name,active,supplier_factory_id,specification,version,created_at,updated_at,updated_by)
 values(p_id,p_kind,btrim(p_name),p_active,p_factory_id,p_specification,p_expected_catalog_version+1,coalesce(prior.created_at,stamp),stamp,actor.id)
 on conflict(id) do update set name=excluded.name,active=excluded.active,specification=excluded.specification,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by returning * into result;
 perform public.save_supplier_work_rate(p_factory_id,p_kind,p_id::text,p_unit_cost,p_expected_rate_version,p_reason);
 insert into public.supplier_work_item_audits(catalog_id,factory_id,actor_id,actor_name,reason,before,after,created_at)
 values(p_id,p_factory_id,actor.id,actor.name,btrim(p_reason),case when prior.id is null then null else to_jsonb(prior) end,to_jsonb(result),stamp);
 return result;
end $$;

create or replace function public.save_style_operation_with_supplier(p_id uuid,p_style_id uuid,p_kind text,p_supplier_factory_id uuid,p_expected_version integer,p_data jsonb,p_reason text,p_catalog_versions jsonb default '{}'::jsonb)
returns public.style_operations language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;s public.styles;prior public.style_operations;result public.style_operations;cat public.operation_catalogs;supplier public.factories;
 item jsonb;previous jsonb;rows jsonb:='[]';seen uuid[]:='{}';fresh_rows uuid[]:='{}';row_id uuid;k text;is_new boolean;
 line jsonb;rate public.supplier_work_rates;price public.processing_unit_prices;stamp timestamptz:=clock_timestamp();
begin
 actor:=public.operations_actor();if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN: work instructions require HQ' using errcode='42501';end if;
 perform public.operations_reason(p_reason);
 if p_id is null or p_expected_version is null or p_expected_version<0 or p_kind is null or p_kind not in ('label','embroidery') then raise exception 'INVALID_VERSION';end if;
 select * into s from public.styles where id=p_style_id and deleted_at is null for update;
 if s.id is null or not public.can_access_style(s.id) then raise exception 'FORBIDDEN' using errcode='42501';end if;
 if p_supplier_factory_id is not null then perform public.supplier_work_actor(p_supplier_factory_id,p_kind);select * into supplier from public.factories where id=p_supplier_factory_id for share;perform public.supplier_work_actor(p_supplier_factory_id,p_kind);end if;
 select * into prior from public.style_operations where style_id=p_style_id and kind=p_kind for update;
 if prior.id is not null and prior.id<>p_id or coalesce(prior.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if exists(select 1 from public.style_operations where id=p_id and (style_id<>p_style_id or kind<>p_kind)) then raise exception 'HISTORY_PROTECTED: work identity cannot change';end if;
 perform public.operations_shape(p_data,array['rows','note','voided']);perform public.operations_text(p_data,'note',10000);
 if jsonb_typeof(p_data->'rows') is distinct from 'array' or jsonb_array_length(p_data->'rows') not between 1 and 200 or jsonb_typeof(p_data->'voided') is distinct from 'boolean' or jsonb_typeof(p_catalog_versions) is distinct from 'object' then raise exception 'INVALID_OPERATION';end if;
 for item in select value from jsonb_array_elements(p_data->'rows') loop
  perform public.operations_shape(item,array['id','catalogId','name','specification','quantity','lossQuantity','completedQuantity','status','orderedAt','requestedAt','completedAt','dueDate','note']);
  row_id:=public.operations_uuid(item->>'id');if row_id=any(seen) then raise exception 'INVALID_OPERATION: duplicate row';end if;seen:=array_append(seen,row_id);
  select * into cat from public.operation_catalogs where id=public.operations_uuid(item->>'catalogId') and kind=p_kind for share;
  if cat.id is null or cat.supplier_factory_id is distinct from p_supplier_factory_id then raise exception 'INVALID_SUPPLIER_WORK_ITEM';end if;
  select value into previous from jsonb_array_elements(coalesce(prior.rows_data,'[]')) where value->>'id'=row_id::text;
  is_new:=previous is null or previous->>'catalogId'<>cat.id::text or prior.supplier_factory_id is distinct from p_supplier_factory_id;
  if is_new then fresh_rows:=array_append(fresh_rows,row_id);end if;
  if not cat.active and is_new then raise exception 'INVALID_OPERATION: inactive work kind';end if;
  if p_supplier_factory_id is not null and is_new then
   if coalesce(p_catalog_versions->>cat.id::text,'') !~ '^[1-9][0-9]*$' or (p_catalog_versions->>cat.id::text)::numeric<>cat.version then raise exception 'VERSION_CONFLICT: supplier work changed' using errcode='40001';end if;
   if item->>'name' is distinct from cat.name then raise exception 'VERSION_CONFLICT: supplier work name changed' using errcode='40001';end if;
  end if;
  item:=jsonb_set(item,'{name}',case when not is_new then previous->'name' else to_jsonb(cat.name) end);
  perform public.operations_text(item,'name',150,true);perform public.operations_text(item,'specification',1000);perform public.operations_text(item,'note',5000);
  foreach k in array array['quantity','lossQuantity','completedQuantity'] loop
   if jsonb_typeof(item->k) is distinct from 'number' or item->>k !~ '^[0-9]+$' or (item->>k)::numeric>10000000 then raise exception 'INVALID_QUANTITIES';end if;
  end loop;
  if (item->>'completedQuantity')::numeric>(item->>'quantity')::numeric+(item->>'lossQuantity')::numeric then raise exception 'INVALID_QUANTITIES';end if;
  if item->>'status' not in ('unset','todo','progress','done','approved','delayed') or jsonb_typeof(item->'status') is distinct from 'string' then raise exception 'INVALID_OPERATION';end if;
  foreach k in array array['orderedAt','requestedAt','completedAt','dueDate'] loop perform public.operations_text(item,k,10);perform public.validate_sig_date(item->>k);end loop;
  if (p_supplier_factory_id is not null or prior.supplier_factory_id is not null) and is_new and exists(select 1 from public.processing_unit_prices p where p.style_id=s.id and p.kind=p_kind and p.item_key=row_id::text) then raise exception 'SUPPLIER_PRICE_SCOPE_CHANGED: create a new work row';end if;
  rows:=rows||jsonb_build_array(item);
 end loop;
 insert into public.style_operations(id,style_id,kind,rows_data,note,voided,supplier_factory_id,supplier_name_snapshot,version,created_at,updated_at,updated_by)
 values(p_id,s.id,p_kind,rows,p_data->>'note',(p_data->>'voided')::boolean,p_supplier_factory_id,
  case when p_supplier_factory_id is null then null when prior.supplier_factory_id=p_supplier_factory_id then coalesce(prior.supplier_name_snapshot,supplier.name) else supplier.name end,
  p_expected_version+1,coalesce(prior.created_at,stamp),stamp,actor.id)
 on conflict(id) do update set rows_data=excluded.rows_data,note=excluded.note,voided=excluded.voided,supplier_factory_id=excluded.supplier_factory_id,supplier_name_snapshot=excluded.supplier_name_snapshot,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by returning * into result;
 if p_supplier_factory_id is not null and not result.voided then
  for item in select value from jsonb_array_elements(rows) loop
   -- Defaults belong to newly selected work only. Saving an existing work
   -- record must not silently backfill a newer master rate into its history.
   if not (item->>'id')::uuid=any(fresh_rows) then continue;end if;
   select * into rate from public.supplier_work_rates where factory_id=p_supplier_factory_id and kind=p_kind and item_key=item->>'catalogId' for share;
   if rate.factory_id is null then continue;end if;
   for line in select value from jsonb_array_elements(s.data->'production') loop
    if line->>'paymentStatus' in ('done','approved') then continue;end if;
    insert into public.processing_unit_prices(style_id,line_id,kind,item_key,unit_cost,supplier_factory_id,supplier_name_snapshot,master_rate_version,supplier_catalog_id,version,created_at,updated_at,updated_by)
     values(s.id,(line->>'id')::uuid,p_kind,item->>'id',rate.unit_cost,p_supplier_factory_id,result.supplier_name_snapshot,rate.version,(item->>'catalogId')::uuid,1,stamp,stamp,actor.id)
     on conflict(style_id,line_id,kind,item_key) do nothing returning * into price;
    if found then insert into public.processing_unit_price_audits(style_id,line_id,kind,item_key,actor_id,actor_name,reason,before,after,created_at)
     values(price.style_id,price.line_id,price.kind,price.item_key,actor.id,actor.name,btrim(p_reason),null,to_jsonb(price),stamp);end if;
   end loop;
  end loop;
 end if;
 insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after,created_at)
 values(s.id,actor.id,actor.name,'업체별 가공 작업 저장',btrim(p_reason),case when prior.id is null then null else to_jsonb(prior) end,to_jsonb(result),stamp);
 return result;
end $$;

-- Legacy callers keep the global fixed catalog path. They cannot accidentally
-- drop a selected supplier or select another supplier's work through old RPCs.
create or replace function public.save_style_operation(p_id uuid,p_style_id uuid,p_kind text,p_expected_version integer,p_data jsonb,p_reason text)
returns public.style_operations language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform public.operations_actor();
 if not public.can_access_style(p_style_id) then raise exception 'FORBIDDEN' using errcode='42501';end if;
 if exists(select 1 from public.style_operations where style_id=p_style_id and kind=p_kind and supplier_factory_id is not null) then raise exception 'SUPPLIER_REQUIRED: use supplier-aware operation save';end if;
 return public.save_style_operation_with_supplier(p_id,p_style_id,p_kind,null,p_expected_version,p_data,p_reason,'{}');
end $$;

create or replace function public.apply_supplier_quality_rate(p_style_id uuid,p_line_id uuid,p_factory_id uuid,p_category text,p_expected_assignment_version integer,p_expected_price_version integer,p_reason text)
returns public.processing_unit_prices language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;s public.styles;line jsonb;assignment public.inspection_assignments;factory public.factories;rate public.supplier_work_rates;
 prior public.processing_unit_prices;result public.processing_unit_prices;stamp timestamptz:=clock_timestamp();
begin
 actor:=public.operations_actor();if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN' using errcode='42501';end if;perform public.operations_reason(p_reason);
 select * into s from public.styles where id=p_style_id and deleted_at is null for update;
 if s.id is null or not public.can_access_style(s.id) then raise exception 'FORBIDDEN' using errcode='42501';end if;
 select value into line from jsonb_array_elements(s.data->'production') where value->>'id'=p_line_id::text;
 if line is null then raise exception 'INVALID_PROCESSING_PRICE';end if;
 select * into factory from public.factories where id=p_factory_id and active and service_type='inspection' and inspection_provider in ('able','kotiti') for share;
 select * into assignment from public.inspection_assignments where style_id=s.id and line_id=p_line_id for update;
 if factory.id is null or assignment.provider is distinct from factory.inspection_provider or assignment.provider is null then raise exception 'FORBIDDEN: inspection supplier assignment differs' using errcode='42501';end if;
 if p_expected_assignment_version is null or assignment.version<>p_expected_assignment_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if not exists(select 1 from public.production_details d where d.style_id=s.id and d.line_id=p_line_id and d.data->'quality'->>'category'=p_category) then raise exception 'INVALID_PROCESSING_PRICE: stored quality category required';end if;
 select * into prior from public.processing_unit_prices where style_id=s.id and line_id=p_line_id and kind='quality' and item_key=p_category for update;
 if p_expected_price_version is null or p_expected_price_version<0 or coalesce(prior.version,0)<>p_expected_price_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 -- An unknown legacy supplier is not an agreed quote for this assignee.
 -- Explicit HQ application can replace it, preserving its old value in the
 -- private quotation audit. Only an exact same-supplier quote stays unchanged.
 if prior.style_id is not null and prior.supplier_factory_id=factory.id then return prior;end if;
 if line->>'paymentStatus' in ('done','approved') then raise exception 'HISTORY_PROTECTED: settled processing quote cannot change';end if;
 select * into rate from public.supplier_work_rates where factory_id=factory.id and kind='quality' and item_key=p_category for share;
 if rate.factory_id is null then raise exception 'SUPPLIER_RATE_REQUIRED';end if;
 insert into public.processing_unit_prices(style_id,line_id,kind,item_key,unit_cost,supplier_factory_id,supplier_name_snapshot,master_rate_version,version,created_at,updated_at,updated_by)
 values(s.id,p_line_id,'quality',p_category,rate.unit_cost,factory.id,factory.name,rate.version,p_expected_price_version+1,coalesce(prior.created_at,stamp),stamp,actor.id)
 on conflict(style_id,line_id,kind,item_key) do update set unit_cost=excluded.unit_cost,supplier_factory_id=excluded.supplier_factory_id,supplier_name_snapshot=excluded.supplier_name_snapshot,master_rate_version=excluded.master_rate_version,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by returning * into result;
 insert into public.processing_unit_price_audits(style_id,line_id,kind,item_key,actor_id,actor_name,reason,before,after,created_at)
 values(s.id,p_line_id,'quality',p_category,actor.id,actor.name,btrim(p_reason),case when prior.style_id is null then null else to_jsonb(prior) end,to_jsonb(result),stamp);
 return result;
end $$;

-- Preserve the existing manual quote API, but supplier-bound quotations can no
-- longer be edited by a different production factory merely sharing a style.
do $$begin
 if to_regprocedure('public.save_processing_unit_price_before_supplier_021(uuid,uuid,text,text,jsonb,integer,text)') is null then
  alter function public.save_processing_unit_price(uuid,uuid,text,text,jsonb,integer,text) rename to save_processing_unit_price_before_supplier_021;
 end if;
end $$;
create or replace function public.save_processing_unit_price(p_style_id uuid,p_line_id uuid,p_kind text,p_item_key text,p_unit_cost jsonb,p_expected_version integer,p_reason text)
returns public.processing_unit_prices language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;prior public.processing_unit_prices;result public.processing_unit_prices;s public.styles;line jsonb;
 supplier_id uuid;supplier_name text;catalog_id uuid;cost numeric;stamp timestamptz:=clock_timestamp();
begin
 actor:=public.operations_actor();perform public.operations_reason(p_reason);
 select * into s from public.styles where id=p_style_id and deleted_at is null for update;
 if s.id is null or not public.can_access_style(s.id) then raise exception 'FORBIDDEN' using errcode='42501';end if;
 select value into line from jsonb_array_elements(s.data->'production') where value->>'id'=p_line_id::text;
 if line is null then raise exception 'INVALID_PROCESSING_PRICE: registered production color required';end if;
 if p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_VERSION';end if;
 if p_kind is null or p_kind not in ('label','embroidery','quality') or p_item_key is null or length(p_item_key) not between 1 and 120 or p_item_key ~ '[[:cntrl:]]' then raise exception 'INVALID_PROCESSING_PRICE';end if;
 if p_kind='quality' then
  if not exists(select 1 from public.production_details d where d.style_id=s.id and d.line_id=p_line_id and d.data->'quality'->>'category'=p_item_key) then raise exception 'INVALID_PROCESSING_PRICE: stored quality category required';end if;
  select f.id,f.name into supplier_id,supplier_name from public.inspection_assignments a join public.factories f on f.service_type='inspection' and f.inspection_provider=a.provider where a.style_id=s.id and a.line_id=p_line_id;
 else
  select o.supplier_factory_id,o.supplier_name_snapshot,(item->>'catalogId')::uuid into supplier_id,supplier_name,catalog_id
   from public.style_operations o cross join lateral jsonb_array_elements(o.rows_data) item
   where o.style_id=s.id and o.kind=p_kind and not o.voided and item->>'id'=p_item_key;
  if not found then raise exception 'INVALID_PROCESSING_PRICE: stored active processing work required';end if;
 end if;
 select * into prior from public.processing_unit_prices where style_id=s.id and line_id=p_line_id and kind=p_kind and item_key=p_item_key for update;
 if coalesce(prior.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if (prior.supplier_factory_id is not null or supplier_id is not null) and actor.role not in ('admin','internal') then raise exception 'FORBIDDEN: supplier quote requires HQ' using errcode='42501';end if;
 if (prior.supplier_factory_id is not null or supplier_id is not null) and line->>'paymentStatus' in ('done','approved') then raise exception 'HISTORY_PROTECTED: settled processing quote cannot change';end if;
 -- A manual edit changes only this quotation. Preserve its existing supplier
 -- identity even if an assignment has since changed; applying a different
 -- supplier's master is a separate, explicit, versioned action.
 if prior.style_id is not null then supplier_id:=prior.supplier_factory_id;supplier_name:=prior.supplier_name_snapshot;catalog_id:=prior.supplier_catalog_id;end if;
 cost:=public.supplier_work_cost(p_unit_cost);
 insert into public.processing_unit_prices(style_id,line_id,kind,item_key,unit_cost,supplier_factory_id,supplier_name_snapshot,supplier_catalog_id,master_rate_version,version,created_at,updated_at,updated_by)
 values(s.id,p_line_id,p_kind,p_item_key,cost,supplier_id,supplier_name,catalog_id,null,p_expected_version+1,coalesce(prior.created_at,stamp),stamp,actor.id)
 on conflict(style_id,line_id,kind,item_key) do update set unit_cost=excluded.unit_cost,master_rate_version=null,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by returning * into result;
 insert into public.processing_unit_price_audits(style_id,line_id,kind,item_key,actor_id,actor_name,reason,before,after,created_at)
 values(s.id,p_line_id,p_kind,p_item_key,actor.id,actor.name,btrim(p_reason),case when prior.style_id is null then null else to_jsonb(prior) end,to_jsonb(result),stamp);
 insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after,created_at)
 values(s.id,actor.id,actor.name,'가공·품질 단가 저장','가공·품질 단가 변경',
  case when prior.style_id is null then null else jsonb_build_object('styleId',s.id,'lineId',p_line_id,'kind',p_kind,'itemKey',p_item_key,'version',prior.version) end,
  jsonb_build_object('styleId',s.id,'lineId',p_line_id,'kind',p_kind,'itemKey',p_item_key,'version',result.version),stamp);
 return result;
end $$;

alter table public.supplier_work_rates enable row level security;
alter table public.supplier_work_rate_audits enable row level security;
alter table public.supplier_work_item_audits enable row level security;
drop policy if exists supplier_work_rates_read on public.supplier_work_rates;
create policy supplier_work_rates_read on public.supplier_work_rates for select to authenticated using(public.can_access_supplier_work(factory_id,kind));
drop policy if exists supplier_work_rate_audits_read on public.supplier_work_rate_audits;
create policy supplier_work_rate_audits_read on public.supplier_work_rate_audits for select to authenticated using(public.can_access_supplier_work(factory_id,kind));
drop policy if exists supplier_work_item_audits_read on public.supplier_work_item_audits;
create policy supplier_work_item_audits_read on public.supplier_work_item_audits for select to authenticated using(exists(select 1 from public.operation_catalogs c where c.id=catalog_id and public.can_access_supplier_work(factory_id,c.kind)));
drop policy if exists operation_catalogs_read on public.operation_catalogs;
create policy operation_catalogs_read on public.operation_catalogs for select to authenticated using((supplier_factory_id is null and public.current_app_role() in ('admin','internal')) or supplier_factory_id is not null and public.can_access_supplier_work(supplier_factory_id,kind));
revoke all on public.supplier_work_rates,public.supplier_work_rate_audits,public.supplier_work_item_audits from public,anon,authenticated,service_role;
grant select on public.supplier_work_rates,public.supplier_work_rate_audits,public.supplier_work_item_audits to authenticated;
revoke execute on function public.supplier_work_actor(uuid,text),public.supplier_work_cost(jsonb),public.protect_supplier_work_history(),public.save_processing_unit_price_before_supplier_021(uuid,uuid,text,text,jsonb,integer,text) from public,anon,authenticated,service_role;
revoke execute on function public.can_access_supplier_work(uuid,text),public.get_supplier_work_rates_capability(),public.save_supplier_work_item(uuid,uuid,text,text,text,boolean,jsonb,integer,integer,text),public.save_supplier_work_rate(uuid,text,text,jsonb,integer,text),public.save_style_operation_with_supplier(uuid,uuid,text,uuid,integer,jsonb,text,jsonb),public.apply_supplier_quality_rate(uuid,uuid,uuid,text,integer,integer,text),public.save_processing_unit_price(uuid,uuid,text,text,jsonb,integer,text),public.save_style_operation(uuid,uuid,text,integer,jsonb,text) from public,anon,service_role;
grant execute on function public.can_access_supplier_work(uuid,text),public.get_supplier_work_rates_capability(),public.save_supplier_work_item(uuid,uuid,text,text,text,boolean,jsonb,integer,integer,text),public.save_supplier_work_rate(uuid,text,text,jsonb,integer,text),public.save_style_operation_with_supplier(uuid,uuid,text,uuid,integer,jsonb,text,jsonb),public.apply_supplier_quality_rate(uuid,uuid,uuid,text,integer,integer,text),public.save_processing_unit_price(uuid,uuid,text,text,jsonb,integer,text),public.save_style_operation(uuid,uuid,text,integer,jsonb,text) to authenticated;
do $$begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='supplier_work_rates') then alter publication supabase_realtime add table public.supplier_work_rates;end if;
end $$;
notify pgrst,'reload schema';
commit;
