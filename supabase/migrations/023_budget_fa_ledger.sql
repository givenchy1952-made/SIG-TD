-- Apply after 022. Financial annotations are separate from production history.
-- No existing orders, quotes, finalized snapshots or payment statuses are rewritten.
begin;

create table if not exists public.budget_records (
 id uuid primary key,kind text not null check(kind in ('cost','limit','payment','note')),
 data jsonb not null check(jsonb_typeof(data)='object'),version integer not null check(version>0),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 updated_by uuid not null references public.profiles(id) on delete restrict
);
create unique index if not exists budget_limit_identity on public.budget_records((data->>'season')) where kind='limit';
create unique index if not exists budget_payment_identity on public.budget_records((data->>'sourceKey')) where kind='payment';
create unique index if not exists budget_note_identity on public.budget_records((data->>'kind'),(data->>'key')) where kind='note';
create table if not exists public.budget_record_audits (
 id uuid primary key default gen_random_uuid(),record_id uuid not null references public.budget_records(id) on delete restrict,
 kind text not null,actor_id uuid not null references public.profiles(id) on delete restrict,actor_name text not null,
 reason text not null,before jsonb,after jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create index if not exists budget_audit_record_idx on public.budget_record_audits(record_id,created_at);

create or replace function public.budget_reader() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles where id=auth.uid() and approved and active and role in ('admin','internal','finance'))
$$;
create or replace function public.get_budget_capability() returns boolean language sql stable security definer set search_path='' as $$select public.budget_reader()$$;

create or replace function public.budget_record_json(r public.budget_records) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',r.id,'kind',r.kind,'data',r.data,'version',r.version,'createdAt',r.created_at,'updatedAt',r.updated_at,'updatedBy',r.updated_by)
$$;

create or replace function public.protect_budget_history() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'HISTORY_PROTECTED: budget audit history cannot be rewritten or deleted';end $$;
drop trigger if exists budget_audit_history on public.budget_record_audits;
create trigger budget_audit_history before update or delete on public.budget_record_audits for each row execute function public.protect_budget_history();

-- This is an explicit financial projection. It deliberately contains no PO,
-- attachments, comments, original filenames, email addresses, private notes,
-- measurements, production approval replies or general audit snapshots.
create or replace function public.budget_source_input() returns jsonb language sql stable security definer set search_path='' as $$
select jsonb_build_object(
 'styles',coalesce((select jsonb_agg(jsonb_build_object(
   'id',s.id,'code',s.data->'code','name',s.data->'name','category',s.data->'category',
   'season',s.data->'season','projectId',s.data->'projectId','factoryId',s.data->'factoryId','ownerId',s.data->'ownerId',
   'colors',s.data->'colors','stage',s.data->'stage','dueDate',s.data->'dueDate','version',s.version,'deletedAt',s.deleted_at,
   'production',coalesce((select jsonb_agg(jsonb_build_object(
     'id',l->'id','color',l->'color','ownerId',l->'ownerId','order',l->'order','shipped',l->'shipped','received',l->'received',
     'receivedAt',l->'receivedAt','shippedAt',l->'shippedAt','checks',jsonb_build_object('main',l#>'{checks,main}')
   ) order by l->>'id') from jsonb_array_elements(coalesce(s.data->'production','[]')) l),'[]'::jsonb)
 ) order by s.id) from public.styles s where s.deleted_at is null or exists(select 1 from public.production_runs r where r.style_id=s.id and r.closed_at is not null)),'[]'::jsonb),
 'projects',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'season',p.season,'code',p.code) order by p.id) from public.projects p),'[]'::jsonb),
 'factories',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'country',f.country,'active',f.active,'serviceType',f.service_type,'inspectionProvider',f.inspection_provider) order by f.id) from public.factories f),'[]'::jsonb),
 'profiles',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name) order by p.id) from public.profiles p where p.role in ('admin','internal') and exists(select 1 from public.styles s where s.data->>'ownerId'=p.id::text or exists(select 1 from jsonb_array_elements(coalesce(s.data->'production','[]'::jsonb)) l where l->>'ownerId'=p.id::text))),'[]'::jsonb),
 'productionRuns',coalesce((select jsonb_agg(jsonb_build_object(
   'id',r.id,'styleId',r.style_id,'lineId',r.line_id,'projectId',r.project_id,'projectCode',r.project_code,'name',r.name,
   'order',r.order_quantities,'round',r.round,'version',r.version,'closedAt',r.closed_at,'unitCost',r.unit_cost,
   'expectedDue',coalesce(r.expected_due::text,''),'itemType',r.item_type,'createdAt',r.created_at,'updatedAt',r.updated_at,
   'factoryIdSnapshot',r.factory_id_snapshot,'factoryNameSnapshot',r.factory_name_snapshot,'ownerIdSnapshot',r.owner_id_snapshot,
   'ownerNameSnapshot',r.owner_name_snapshot,'styleCodeSnapshot',r.style_code_snapshot,
   'snapshot',case when r.snapshot is null then null else jsonb_build_object(
     'projectId',r.snapshot->'projectId','projectCode',r.snapshot->'projectCode','styleCode',r.snapshot->'styleCode',
     'factory',r.snapshot->'factory','owner',r.snapshot->'owner','name',r.snapshot->'name','round',r.snapshot->'round',
     'itemType',r.snapshot->'itemType','unitCost',r.snapshot->'unitCost','orderQuantity',r.snapshot->'orderQuantity',
     'receivedQuantity',r.snapshot->'receivedQuantity','netAmount',r.snapshot->'netAmount','vatAmount',r.snapshot->'vatAmount',
     'grossAmount',r.snapshot->'grossAmount','lastReceivedAt',r.snapshot->'lastReceivedAt','finalizedAt',r.snapshot->'finalizedAt',
     'factoryIdSnapshot',r.snapshot->'factoryIdSnapshot','factoryNameSnapshot',r.snapshot->'factoryNameSnapshot',
     'ownerIdSnapshot',r.snapshot->'ownerIdSnapshot','ownerNameSnapshot',r.snapshot->'ownerNameSnapshot','styleCodeSnapshot',r.snapshot->'styleCodeSnapshot'
   ) end
 ) order by r.id) from public.production_runs r),'[]'::jsonb),
 'productionReceipts',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'runId',r.run_id,'styleId',r.style_id,'lineId',r.line_id,'receivedAt',r.received_at,'quantities',r.quantities,'unitCost',r.unit_cost,'netAmount',r.net_amount,'voided',r.voided,'version',r.version) order by r.id) from public.production_receipts r),'[]'::jsonb),
 'processingUnitPrices',coalesce((select jsonb_agg(jsonb_build_object('styleId',q.style_id,'lineId',q.line_id,'kind',q.kind,'itemKey',q.item_key,'unitCost',q.unit_cost,'version',q.version,'supplierFactoryId',q.supplier_factory_id,'supplierNameSnapshot',q.supplier_name_snapshot,'supplierCatalogId',q.supplier_catalog_id) order by q.style_id,q.line_id,q.kind,q.item_key) from public.processing_unit_prices q),'[]'::jsonb),
 'productionDetails',coalesce((select jsonb_agg(jsonb_build_object('styleId',d.style_id,'lineId',d.line_id,'version',d.version,'quality',jsonb_build_object('category',d.data#>'{quality,category}','quantity',d.data#>'{quality,quantity}','status',d.data#>'{quality,status}','requestedAt',d.data#>'{quality,requestedAt}','completedAt',d.data#>'{quality,completedAt}','note','')) order by d.style_id,d.line_id) from public.production_details d),'[]'::jsonb),
 'inspectionAssignments',coalesce((select jsonb_agg(jsonb_build_object('styleId',a.style_id,'lineId',a.line_id,'provider',a.provider,'version',a.version) order by a.style_id,a.line_id) from public.inspection_assignments a),'[]'::jsonb),
 'operations',jsonb_build_object(
  'styleOperations',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'styleId',o.style_id,'kind',o.kind,'version',o.version,'voided',o.voided,'supplierFactoryId',o.supplier_factory_id,'supplierNameSnapshot',o.supplier_name_snapshot,'note','',
    'rows',coalesce((select jsonb_agg(jsonb_build_object('id',i->'id','catalogId',i->'catalogId','name',i->'name','specification',i->'specification','quantity',i->'quantity','lossQuantity',i->'lossQuantity','completedQuantity',i->'completedQuantity','status',i->'status','orderedAt',i->'orderedAt','requestedAt',i->'requestedAt','completedAt',i->'completedAt','dueDate',i->'dueDate','note','') order by i->>'id') from jsonb_array_elements(o.rows_data) i),'[]'::jsonb)
  ) order by o.id) from public.style_operations o),'[]'::jsonb),
  'orderSourceRecords',coalesce((select jsonb_agg(jsonb_build_object('styleId',o.style_id,'lineId',o.line_id,'version',o.version,'headers',o.headers-'Y',
    'rows',coalesce((select jsonb_agg(jsonb_build_object('columns',(r->'columns')-'Y') order by (r->>'rowNumber')::integer) from jsonb_array_elements(o.rows_data) r),'[]'::jsonb)
  ) order by o.style_id,o.line_id) from public.order_source_records o),'[]'::jsonb)
 )
)
$$;

create or replace function public.get_budget_workspace() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.budget_reader() then raise exception 'FORBIDDEN: approved headquarters or finance account required' using errcode='42501';end if;
 return jsonb_build_object(
  'records',coalesce((select jsonb_agg(public.budget_record_json(r) order by r.kind,r.id) from public.budget_records r),'[]'::jsonb),
  'audits',case when exists(select 1 from public.profiles where id=auth.uid() and approved and active and role in ('admin','internal')) then coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'recordId',a.record_id,'kind',a.kind,'actorId',a.actor_id,'actorName',a.actor_name,'reason',a.reason,'before',a.before,'after',a.after,'createdAt',a.created_at) order by a.created_at,a.id) from public.budget_record_audits a),'[]'::jsonb) else '[]'::jsonb end,
  'sourceInput',public.budget_source_input()
 );
end $$;

-- Helpers reject unknown fields, invalid numeric types, negative amounts and
-- invalid calendar dates before casting. A blank amount is null, never zero.
create or replace function public.budget_text(d jsonb,k text,n integer,required boolean default false) returns void language plpgsql immutable set search_path='' as $$
begin
 perform public.operations_text(d,k,n,required);
 if d->>k ~ '[[:cntrl:]]' then raise exception 'INVALID_BUDGET: control characters in %',k;end if;
end $$;
create or replace function public.budget_amount(d jsonb,k text,maxvalue numeric default 1000000000000,precision_digits integer default 2) returns void language plpgsql immutable set search_path='' as $$
declare n numeric;
begin
 if d->k='null'::jsonb then return;end if;
 if jsonb_typeof(d->k) is distinct from 'number' then raise exception 'INVALID_BUDGET: numeric amount required for %',k;end if;
 n:=(d->>k)::numeric;
 if n<0 or n>maxvalue or n<>round(n,precision_digits) then raise exception 'INVALID_BUDGET: amount range or precision for %',k;end if;
end $$;

-- Convert invalid calendar dates into the same actionable budget validation
-- error as invalid amounts, rather than exposing a raw PostgreSQL cast failure.
create or replace function public.budget_date(d text) returns void language plpgsql immutable set search_path='' as $$
begin
 perform public.validate_sig_date(d);
exception when datetime_field_overflow or invalid_datetime_format then
 raise exception 'INVALID_BUDGET: use a valid calendar date';
end $$;

create or replace function public.budget_order_date(p_style uuid,p_line uuid,p_code text) returns text language plpgsql stable security definer set search_path='' as $$
declare values_found text[];value text;
begin
 select array_agg(distinct trim(r->'columns'->>h.key)) into values_found
 from public.order_source_records o,jsonb_array_elements(o.rows_data) r,jsonb_each_text(o.headers) h
 where o.style_id=p_style and o.line_id=p_line and trim(r#>>'{columns,A}')=p_code
  and regexp_replace(h.value,'[[:space:]]','','g') ~* '(발주요청일|발주날짜|발주일자|오더요청일|ORDERDATE)'
  and coalesce(trim(r->'columns'->>h.key),'')<>'' and coalesce(r->'columns'->>h.key,'') !~ '[[:cntrl:]]'
  and coalesce(trim(r->'columns'->>h.key),'') !~* '^#(REF!|NAME\?|VALUE!|DIV/0!|N/A|NUM!|NULL!|SPILL!|CALC!)$';
 if array_length(values_found,1)<>1 or values_found is null then return '';end if;
 value:=values_found[1];
 begin
  perform public.budget_date(value);
 exception when others then return '';end;
 return value;
end $$;

-- Legacy code-as-name projects may still have their official M-column name in
-- a unanimous, linked order source. Keep that display repair read-only.
create or replace function public.budget_project_name(p_id uuid) returns text language plpgsql stable security definer set search_path='' as $$
declare p public.projects;name text;code text;names text[];valid boolean;
begin
 select * into p from public.projects where id=p_id;
 if p.id is null then return '프로젝트 명칭 미등록';end if;
 name:=trim(p.name);code:=trim(coalesce(p.code,''));
 if name<>'' and length(name)<=160 and name !~ '[[:cntrl:]]' and name !~* '^#(REF!|NAME\?|VALUE!|DIV/0!|N/A|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$'
  and name<>'프로젝트 명칭 미등록' and upper(name)<>upper(code) and name !~* '^SIGNIFICANT-[0-9]{4}[A-Z]*-(MPQ|RPQ|MOQ|OPQ)-[0-9]+$'
  and not(code='' and exists(select 1 from public.order_source_records o,jsonb_array_elements(o.rows_data) r where upper(trim(r#>>'{columns,A}'))=upper(name))) then return name;end if;
 select array_agg(distinct trim(r#>>'{columns,M}')),bool_and(coalesce(trim(r#>>'{columns,M}'),'')<>'' and length(trim(r#>>'{columns,M}'))<=160 and coalesce(r#>>'{columns,M}','') !~ '[[:cntrl:]]' and (coalesce(trim(r#>>'{columns,L}'),'')='' or trim(coalesce(p.season,''))='' or trim(r#>>'{columns,L}')=trim(p.season))) into names,valid
 from public.order_source_records o join public.styles s on s.id=o.style_id,jsonb_array_elements(o.rows_data) r
 where s.data->>'projectId'=p.id::text and upper(trim(r#>>'{columns,A}'))=upper(case when code<>'' then code else name end);
 if valid and array_length(names,1)=1 and names[1] !~* '^(#(REF!|NAME\?|VALUE!|DIV/0!|N/A|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)|SIGNIFICANT-[0-9]{4}[A-Z]*-(MPQ|RPQ|MOQ|OPQ)-[0-9]+)$' and names[1]<>'프로젝트 명칭 미등록' and upper(names[1])<>upper(code) then return names[1];end if;
 return '프로젝트 명칭 미등록';
end $$;

create or replace function public.budget_payment_fingerprint(p_key text) returns text language plpgsql volatile security definer set search_path='' as $$
declare r public.production_runs;s public.styles;l jsonb;o public.style_operations;d public.production_details;q public.processing_unit_prices;a public.inspection_assignments;
 supplier uuid;work jsonb;k text;parts text[];actual bigint;styleuuid uuid;lineuuid uuid;
begin
 parts:=string_to_array(p_key,':');
 if array_length(parts,1)=2 and parts[1]='production' then
  select * into r from public.production_runs where id=public.operations_uuid(parts[2]) for share;
  if r.id is null or r.closed_at is null or r.snapshot is null then raise exception 'BUDGET_SOURCE_CHANGED: finalized production source required';end if;
  return p_key||'@'||r.version::text;
 end if;
 if array_length(parts,1)<>5 or parts[1]<>'processing' or parts[2] not in ('label','embroidery','quality') then raise exception 'INVALID_BUDGET: unknown financial source';end if;
 k:=parts[2];styleuuid:=public.operations_uuid(parts[3]);lineuuid:=public.operations_uuid(parts[4]);
 select * into s from public.styles where id=styleuuid and deleted_at is null for share;
 if s.id is null then raise exception 'BUDGET_SOURCE_CHANGED: inaccessible production source';end if;
 select x into l from jsonb_array_elements(s.data->'production') x where x->>'id'=lineuuid::text;
 if l is null or public.production_quantity_total(l->'order')<=0 then raise exception 'BUDGET_SOURCE_CHANGED: incomplete production source';end if;
 if exists(select 1 from jsonb_each_text(l->'order') ord where (l#>>array['received',ord.key])::numeric<ord.value::numeric) then
  -- A short final receipt is usable only when the complete closed-run ledger
  -- reconciles with this exact parent color, size by size. Otherwise a latest
  -- parent line could accidentally re-use historical quantities for services.
  if public.production_quantity_total(l->'received')<=0
   or not exists(select 1 from public.production_runs ledger_run where ledger_run.style_id=s.id and ledger_run.line_id=lineuuid)
   or exists(select 1 from public.production_runs ledger_run where ledger_run.style_id=s.id and ledger_run.line_id=lineuuid and (ledger_run.project_id::text<>s.data->>'projectId' or ledger_run.closed_at is null or ledger_run.snapshot is null or (ledger_run.snapshot->>'orderQuantity')::numeric is distinct from public.production_quantity_total(ledger_run.order_quantities)))
   or coalesce((select sum((ledger_run.snapshot->>'receivedQuantity')::numeric) from public.production_runs ledger_run where ledger_run.style_id=s.id and ledger_run.line_id=lineuuid),0)<>public.production_quantity_total(l->'received')
   or exists(select 1 from jsonb_each_text(l->'order') ord where
    coalesce((select sum((ledger_run.order_quantities->>ord.key)::numeric) from public.production_runs ledger_run where ledger_run.style_id=s.id and ledger_run.line_id=lineuuid),0)<>ord.value::numeric
    or coalesce((select sum((receipt.quantities->>ord.key)::numeric) from public.production_receipts receipt join public.production_runs ledger_run on ledger_run.id=receipt.run_id where ledger_run.style_id=s.id and ledger_run.line_id=lineuuid and not receipt.voided),0)<>(l#>>array['received',ord.key])::numeric)
  then raise exception 'BUDGET_SOURCE_CHANGED: short final receipt must reconcile with closed production runs';end if;
 end if;
 if exists(select 1 from public.production_runs where style_id=s.id and line_id=lineuuid and project_id::text<>s.data->>'projectId') then raise exception 'BUDGET_SOURCE_CHANGED: service spans project budgets';end if;
 perform public.budget_date(l->>'receivedAt');
 if coalesce(l->>'receivedAt','')='' then raise exception 'BUDGET_SOURCE_CHANGED: actual receipt date required';end if;
 select * into q from public.processing_unit_prices where style_id=s.id and line_id=lineuuid and kind=k and item_key=parts[5] for share;
 if q.style_id is null or q.unit_cost is null then raise exception 'BUDGET_SOURCE_CHANGED: saved service unit price required';end if;
 select * into a from public.inspection_assignments where style_id=s.id and line_id=lineuuid for share;
 if k='quality' then
  select * into d from public.production_details where style_id=s.id and line_id=lineuuid for share;
  select id into supplier from public.factories where active and service_type='inspection' and inspection_provider=a.provider;
  if supplier is null or q.supplier_factory_id is distinct from supplier or d.style_id is null or d.data#>>'{quality,category}' is distinct from parts[5] or coalesce(d.data#>>'{quality,status}','') not in ('done','approved') then raise exception 'BUDGET_SOURCE_CHANGED: assigned inspection completion required';end if;
  return p_key||'@'||s.version||':'||d.version||':'||q.version||':'||coalesce(a.version,0)||':'||supplier::text;
 else
  select * into o from public.style_operations where style_id=s.id and kind=k and not voided for share;
  select x into work from jsonb_array_elements(o.rows_data) x where x->>'id'=parts[5];
  if o.id is null or work is null or coalesce(work->>'status','') not in ('done','approved') or o.supplier_factory_id is null or q.supplier_factory_id is distinct from o.supplier_factory_id or q.supplier_catalog_id is not null and q.supplier_catalog_id::text<>work->>'catalogId' then raise exception 'BUDGET_SOURCE_CHANGED: completed supplier work required';end if;
  if not exists(select 1 from public.factories where id=o.supplier_factory_id and active) then raise exception 'BUDGET_SOURCE_CHANGED: inactive work supplier';end if;
  return p_key||'@'||s.version||':'||o.version||':'||q.version||':0:'||o.supplier_factory_id::text;
 end if;
end $$;

-- A payment stores its financial source at the time money was marked paid.
-- Subsequent service quantity/price changes cannot silently erase that expense.
create or replace function public.validate_budget_payment_snapshot(p_key text,p_snapshot jsonb) returns void language plpgsql stable security definer set search_path='' as $$
declare r public.production_runs;s public.styles;p public.projects;l jsonb;q public.processing_unit_prices;f uuid;code text;sku text;parts text[];expected jsonb;field text;qty numeric;net numeric;vat numeric;gross numeric;color text;season text;owner_name text;vendor_name text;source_item text;source_evidence text;source_received text;operation public.style_operations;detail public.production_details;work jsonb;
begin
 perform public.operations_shape(p_snapshot,array['projectId','projectCode','projectName','budgetCode','styleId','lineId','styleCode','color','season','factoryId','factoryName','sourceKey','sourceVersion','sourceFingerprint','orderDate','receivedAt','unitCost','consumption','orderQuantity','receivedQuantity','unit','netAmount','vatAmount','grossAmount','owner','item','evidence']);
 foreach field in array array['projectId','projectCode','projectName','budgetCode','styleId','lineId','styleCode','color','season','factoryId','factoryName','sourceKey','sourceFingerprint','orderDate','receivedAt','unit','owner','item','evidence'] loop
  perform public.budget_text(p_snapshot,field,case when field='evidence' then 5000 when field='sourceFingerprint' then 600 else 400 end);
 end loop;
 foreach field in array array['unitCost','netAmount','vatAmount','grossAmount','orderQuantity','receivedQuantity','sourceVersion'] loop
  if p_snapshot->field='null'::jsonb then raise exception 'INVALID_BUDGET: captured financial values cannot be blank';end if;
  perform public.budget_amount(p_snapshot,field,1000000000000,case when field in ('netAmount','vatAmount','grossAmount') then 3 when field='unitCost' then 2 else 0 end);
 end loop;
 if p_snapshot->'consumption'<>'null'::jsonb or p_snapshot->>'sourceKey'<>p_key then raise exception 'INVALID_BUDGET: captured source identity';end if;
 perform public.budget_date(p_snapshot->>'orderDate');perform public.budget_date(p_snapshot->>'receivedAt');
 parts:=string_to_array(p_key,':');
 if parts[1]='production' then
  select * into r from public.production_runs where id=public.operations_uuid(parts[2]);
  select * into s from public.styles where id=r.style_id;
  select x into l from jsonb_array_elements(s.data->'production') x where x->>'id'=r.line_id::text;
  select * into p from public.projects where id=r.project_id;
  code:=coalesce(nullif(r.snapshot->>'projectCode',''),nullif(r.project_code,''),p.code);
  sku:=coalesce(nullif(r.snapshot->>'styleCode',''),nullif(r.style_code_snapshot,''),s.data->>'code');
  expected:=jsonb_build_object('projectId',r.project_id,'projectCode',code,'styleId',r.style_id,'lineId',r.line_id,'styleCode',sku,'color',l->>'color',
   'season',coalesce(nullif(p.season,''),s.data->>'season'),'factoryId',coalesce(r.snapshot->>'factoryIdSnapshot',r.factory_id_snapshot::text),
   'sourceVersion',r.version,'unitCost',r.snapshot->'unitCost','orderQuantity',r.snapshot->'orderQuantity','receivedQuantity',r.snapshot->'receivedQuantity',
   'unit',case when r.snapshot->>'itemType'='fabric' then 'YDS' else 'EA' end,'netAmount',r.snapshot->'netAmount','vatAmount',r.snapshot->'vatAmount','grossAmount',r.snapshot->'grossAmount',
   'projectName',public.budget_project_name(r.project_id),'orderDate',public.budget_order_date(r.style_id,r.line_id,code),'factoryName',coalesce(nullif(r.snapshot->>'factory',''),nullif(r.snapshot->>'factoryNameSnapshot',''),nullif(r.factory_name_snapshot,''),(select name from public.factories where id=(s.data->>'factoryId')::uuid),''),
   'owner',coalesce(nullif(r.snapshot->>'owner',''),r.snapshot->>'ownerNameSnapshot',''),'receivedAt',coalesce(r.snapshot->>'lastReceivedAt',''),
   'item',case when r.snapshot->>'itemType'='fabric' then '원단' when r.snapshot->>'itemType'='label' then '라벨' else '제품' end,
   'evidence','생산 '||(r.snapshot->>'round')||'차 마감 확정 '||left(r.snapshot->>'finalizedAt',10));
 else
  select * into s from public.styles where id=public.operations_uuid(parts[3]);
  select x into l from jsonb_array_elements(s.data->'production') x where x->>'id'=parts[4];
  select * into p from public.projects where id=(s.data->>'projectId')::uuid;
  select * into q from public.processing_unit_prices where style_id=s.id and line_id=parts[4]::uuid and kind=parts[2] and item_key=parts[5];
  color:=l->>'color';sku:=s.data->>'code';
  if not(upper(sku) ~ '[0-9][A-Z]{2}$' and right(upper(sku),2)=upper(color)) then sku:=sku||color;end if;
  code:=p.code;qty:=public.production_quantity_total(l->case when parts[2]='label' then 'shipped' else 'received' end);
  net:=q.unit_cost*qty;vat:=round(net/10,3);gross:=round(net+vat,3);
  select name into owner_name from public.profiles where id=nullif(coalesce(l->>'ownerId',s.data->>'ownerId'),'')::uuid and role in ('admin','internal');
  if parts[2]='quality' then
   select * into detail from public.production_details where style_id=s.id and line_id=parts[4]::uuid;
   source_item:='품질검사 · '||(detail.data#>>'{quality,category}');source_evidence:='';
   vendor_name:=coalesce(nullif(q.supplier_name_snapshot,''),(select name from public.factories where id=q.supplier_factory_id),'');
  else
   select * into operation from public.style_operations where style_id=s.id and kind=parts[2] and not voided;
   select x into work from jsonb_array_elements(operation.rows_data) x where x->>'id'=parts[5];
   source_item:=work->>'name';source_evidence:=coalesce(work->>'specification','');
   vendor_name:=coalesce(nullif(q.supplier_name_snapshot,''),nullif(operation.supplier_name_snapshot,''),(select name from public.factories where id=q.supplier_factory_id),'');
  end if;
  expected:=jsonb_build_object('projectId',p.id,'projectCode',code,'styleId',s.id,'lineId',parts[4],'styleCode',sku,'color',color,
   'season',coalesce(nullif(p.season,''),s.data->>'season'),'factoryId',q.supplier_factory_id,
   'sourceVersion',q.version,'unitCost',q.unit_cost,'orderQuantity',public.production_quantity_total(l->'order'),'receivedQuantity',qty,
   'unit','EA','netAmount',net,'vatAmount',vat,'grossAmount',gross,
   'projectName',public.budget_project_name(p.id),'orderDate',public.budget_order_date(s.id,parts[4]::uuid,code),'factoryName',vendor_name,'receivedAt',coalesce(l->>'receivedAt',''),
   'owner',coalesce(owner_name,''),'item',coalesce(source_item,''),'evidence',coalesce(source_evidence,''));
 end if;
 expected:=expected||jsonb_build_object('budgetCode',regexp_replace(code||sku,'[[:space:]]','','g'));
 if exists(select 1 from jsonb_each(expected) e where p_snapshot->e.key is distinct from e.value) then raise exception 'BUDGET_SOURCE_CHANGED: captured amount or budget identity differs from current source' using errcode='40001';end if;
end $$;

create or replace function public.save_budget_record(p_kind text,p_id uuid,p_data jsonb,p_expected_version integer,p_reason text)
returns public.budget_records language plpgsql security definer set search_path='' as $$
declare actor public.profiles;prior public.budget_records;result public.budget_records;field text;stamp timestamptz:=clock_timestamp();token text;reversal boolean:=false;
begin
 select * into actor from public.profiles where id=auth.uid() and approved and active and role in ('admin','internal');
 if actor.id is null then raise exception 'FORBIDDEN: budget changes require headquarters' using errcode='42501';end if;
 perform public.operations_reason(p_reason);
 if p_id is null or p_kind is null or p_kind not in ('cost','limit','payment','note') or p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_BUDGET: kind, identity or version';end if;
 -- Lock the identity even before its first INSERT. SELECT FOR UPDATE alone
 -- cannot serialize two simultaneous creates of an absent UUID.
 perform pg_advisory_xact_lock(hashtextextended('sig:budget-record:'||p_id::text,0));
 select * into prior from public.budget_records where id=p_id for update;
 if coalesce(prior.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if prior.id is not null and prior.kind<>p_kind then raise exception 'HISTORY_PROTECTED: financial record kind cannot change';end if;
 if p_kind='cost' then
  perform public.operations_shape(p_data,array['projectId','budgetCode','styleCode','supplierId','supplierName','stage','category','description','position','specification','itemName','composition','color','unitCost','variableUnitCost','consumption','unit','amount','voided']);
  foreach field in array array['projectId','budgetCode','styleCode','supplierId','supplierName','stage','category','description','position','specification','itemName','composition','color','unit'] loop perform public.budget_text(p_data,field,case when field='budgetCode' then 240 when field='styleCode' then 80 when field='supplierName' then 160 else 1000 end,field in ('projectId','budgetCode','styleCode','stage'));end loop;
  if p_data->>'stage' not in ('pre','post') or jsonb_typeof(p_data->'voided') is distinct from 'boolean' then raise exception 'INVALID_BUDGET: cost phase or void flag';end if;
  perform public.operations_uuid(p_data->>'projectId');
  if not exists(select 1 from public.projects where id=(p_data->>'projectId')::uuid) then raise exception 'INVALID_BUDGET: unknown project';end if;
  if p_data->>'budgetCode'<>regexp_replace(p_data->>'budgetCode','[[:space:]]','','g') then raise exception 'INVALID_BUDGET: budget code must not contain whitespace';end if;
  if not exists(
   select 1 from public.production_runs r join public.styles s on s.id=r.style_id join public.projects p on p.id=r.project_id
   where r.project_id=(p_data->>'projectId')::uuid and (s.deleted_at is null or r.closed_at is not null)
    and coalesce(nullif(r.snapshot->>'styleCode',''),nullif(r.style_code_snapshot,''))=p_data->>'styleCode'
    and regexp_replace(coalesce(nullif(r.snapshot->>'projectCode',''),nullif(r.project_code,''),p.code)||coalesce(nullif(r.snapshot->>'styleCode',''),nullif(r.style_code_snapshot,'')),'[[:space:]]','','g')=p_data->>'budgetCode'
   union all
   select 1 from public.styles s join public.projects p on p.id::text=s.data->>'projectId',jsonb_array_elements(s.data->'production') l
   where s.deleted_at is null and p.id=(p_data->>'projectId')::uuid
    and not exists(select 1 from public.production_runs r where r.style_id=s.id and r.line_id::text=l->>'id')
    and (case when upper(s.data->>'code') ~ '[0-9][A-Z]{2}$' and right(upper(s.data->>'code'),2)=upper(l->>'color') then s.data->>'code' else (s.data->>'code')||(l->>'color') end)=p_data->>'styleCode'
    and regexp_replace(p.code||(p_data->>'styleCode'),'[[:space:]]','','g')=p_data->>'budgetCode'
  ) then raise exception 'INVALID_BUDGET: cost must match a current order budget identity';end if;
  if p_data->>'supplierId'<>'' and not exists(select 1 from public.factories where id=public.operations_uuid(p_data->>'supplierId')) then raise exception 'INVALID_BUDGET: unknown supplier';end if;
  foreach field in array array['unitCost','variableUnitCost','consumption','amount'] loop perform public.budget_amount(p_data,field,1000000000000,case when field='consumption' then 4 else 2 end);end loop;
  if prior.id is not null and (prior.data->>'projectId',prior.data->>'budgetCode',prior.data->>'styleCode') is distinct from (p_data->>'projectId',p_data->>'budgetCode',p_data->>'styleCode') then raise exception 'HISTORY_PROTECTED: create a new cost for a different budget';end if;
 elsif p_kind='limit' then
  perform public.operations_shape(p_data,array['season','amount']);perform public.budget_text(p_data,'season',40,true);perform public.budget_amount(p_data,'amount');
  if prior.id is not null and prior.data->>'season'<>p_data->>'season' then raise exception 'HISTORY_PROTECTED: season identity';end if;
 elsif p_kind='payment' then
  perform public.operations_shape(p_data,array['sourceKey','sourceFingerprint','status','paidAt','voucherNo','account','description','splitPayment','sourceSnapshot']);
  foreach field in array array['sourceKey','sourceFingerprint','status','paidAt','voucherNo','account','description','splitPayment'] loop perform public.budget_text(p_data,field,case when field='sourceKey' then 300 when field='sourceFingerprint' then 600 else 1000 end,field in ('sourceKey','sourceFingerprint','status'));end loop;
  if p_data->>'status' not in ('paid','unpaid') then raise exception 'INVALID_BUDGET: payment status';end if;
  perform public.budget_date(p_data->>'paidAt');
  if p_data->>'status'='paid' and (p_data->>'paidAt'='' or (p_data->>'paidAt')::date>(clock_timestamp() at time zone 'Asia/Seoul')::date) or p_data->>'status'='unpaid' and p_data->>'paidAt'<>'' then raise exception 'INVALID_BUDGET: actual payment date';end if;
  if prior.id is not null and prior.data->>'sourceKey'<>p_data->>'sourceKey' then raise exception 'HISTORY_PROTECTED: payment source identity';end if;
  if prior.data->>'status'='paid' and p_data->>'status'='paid' and (prior.data->>'sourceFingerprint',prior.data->'sourceSnapshot') is distinct from (p_data->>'sourceFingerprint',p_data->'sourceSnapshot') then raise exception 'HISTORY_PROTECTED: explicitly reverse the previous payment before replacing its financial source';end if;
  begin
   token:=public.budget_payment_fingerprint(p_data->>'sourceKey');
  exception when others then
   if prior.id is not null and prior.data->>'status'='paid' and p_data->>'status'='unpaid' and prior.data->>'sourceFingerprint'=p_data->>'sourceFingerprint' and prior.data->'sourceSnapshot'=p_data->'sourceSnapshot' then reversal:=true;else raise;end if;
  end;
  if not reversal then
   if token<>p_data->>'sourceFingerprint' then raise exception 'BUDGET_SOURCE_CHANGED: financial source changed before payment save' using errcode='40001';end if;
   if p_data->'sourceSnapshot'='null'::jsonb then raise exception 'INVALID_BUDGET: captured source required';end if;
   if p_data#>>'{sourceSnapshot,sourceFingerprint}'<>token then raise exception 'BUDGET_SOURCE_CHANGED: captured source version';end if;
   perform public.validate_budget_payment_snapshot(p_data->>'sourceKey',p_data->'sourceSnapshot');
  end if;
 elsif p_kind='note' then
  perform public.operations_shape(p_data,array['key','kind','reason']);perform public.budget_text(p_data,'key',500,true);perform public.budget_text(p_data,'kind',20,true);perform public.budget_text(p_data,'reason',2000,true);
  if p_data->>'kind' not in ('excess','unclosed') then raise exception 'INVALID_BUDGET: exception kind';end if;
  if prior.id is not null and (prior.data->>'key',prior.data->>'kind') is distinct from (p_data->>'key',p_data->>'kind') then raise exception 'HISTORY_PROTECTED: exception identity';end if;
 end if;
 insert into public.budget_records(id,kind,data,version,created_at,updated_at,updated_by) values(p_id,p_kind,p_data,p_expected_version+1,coalesce(prior.created_at,stamp),stamp,actor.id)
 on conflict(id) do update set data=excluded.data,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by where public.budget_records.version=p_expected_version returning * into result;
 if result.id is null then raise exception 'VERSION_CONFLICT: financial record changed before save' using errcode='40001';end if;
 insert into public.budget_record_audits(record_id,kind,actor_id,actor_name,reason,before,after,created_at) values(p_id,p_kind,actor.id,actor.name,trim(p_reason),case when prior.id is null then null else public.budget_record_json(prior) end,public.budget_record_json(result),stamp);
 return result;
exception when unique_violation then raise exception 'VERSION_CONFLICT: financial identity already registered' using errcode='40001';
end $$;

alter table public.budget_records enable row level security;
alter table public.budget_record_audits enable row level security;
drop policy if exists budget_read on public.budget_records;
create policy budget_read on public.budget_records for select to authenticated using(public.budget_reader());
drop policy if exists budget_audit_hq_read on public.budget_record_audits;
create policy budget_audit_hq_read on public.budget_record_audits for select to authenticated using(exists(select 1 from public.profiles where id=auth.uid() and approved and active and role in ('admin','internal')));
revoke all on public.budget_records,public.budget_record_audits from public,anon,authenticated;
grant select on public.budget_records,public.budget_record_audits to authenticated;
revoke execute on function public.budget_reader(),public.budget_record_json(public.budget_records),public.protect_budget_history(),public.budget_source_input(),public.budget_text(jsonb,text,integer,boolean),public.budget_amount(jsonb,text,numeric,integer),public.budget_date(text),public.budget_order_date(uuid,uuid,text),public.budget_project_name(uuid),public.budget_payment_fingerprint(text),public.validate_budget_payment_snapshot(text,jsonb),public.get_budget_capability(),public.get_budget_workspace(),public.save_budget_record(text,uuid,jsonb,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.budget_reader(),public.get_budget_capability(),public.get_budget_workspace(),public.save_budget_record(text,uuid,jsonb,integer,text) to authenticated;

-- Realtime is optional in local PostgreSQL, and is configured additively when
-- the Supabase publication exists. The application also refreshes on focus.
do $$declare table_name text;begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  foreach table_name in array array['budget_records','budget_record_audits'] loop
   if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=table_name) then execute format('alter publication supabase_realtime add table public.%I',table_name);end if;
  end loop;
 end if;
end $$;
commit;
