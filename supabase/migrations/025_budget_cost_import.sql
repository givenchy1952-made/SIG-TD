-- Apply after 024. Upload rows are linked to existing cost records; no order,
-- payment, finalized settlement or manually-entered cost is reset.
begin;

-- Q (unit price, two decimals) × S (consumption, four decimals) has up to six
-- fractional digits. Only the cost amount gains this precision; limits and
-- payment-source amounts retain their existing validation rules.
create or replace function public.budget_amount(d jsonb,k text,maxvalue numeric default 1000000000000,precision_digits integer default 2) returns void language plpgsql immutable set search_path='' as $$
declare n numeric;digits integer:=precision_digits;
begin
 if d->k='null'::jsonb then return;end if;
 if jsonb_typeof(d->k) is distinct from 'number' then raise exception 'INVALID_BUDGET: numeric amount required for %',k;end if;
 if k='amount' and d ? 'projectId' and d ? 'budgetCode' and d->>'stage' in ('pre','post') then digits:=6;end if;
 n:=(d->>k)::numeric;
 if n<0 or n>maxvalue or n<>round(n,digits) then raise exception 'INVALID_BUDGET: amount range or precision for %',k;end if;
end $$;

create table if not exists public.budget_cost_import_rows (
 record_id uuid primary key references public.budget_records(id) on delete restrict,
 project_id uuid not null references public.projects(id) on delete restrict,
 style_code text not null, file_name text not null, sheet_name text not null,
 row_number integer not null check(row_number between 16 and 10015),
 source_key text not null, row_fingerprint text not null check(row_fingerprint ~ '^[0-9a-f]{64}$'),
 content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),
 updated_at timestamptz not null default clock_timestamp(),updated_by uuid not null references public.profiles(id) on delete restrict
);
create unique index if not exists budget_cost_import_origin on public.budget_cost_import_rows((source_key::jsonb));
create table if not exists public.budget_cost_import_seen_rows (
 content_hash text not null,sheet_name text not null,row_number integer not null,
 project_id uuid not null,style_code text not null,
 record_id uuid not null references public.budget_cost_import_rows(record_id) on delete restrict,
 primary key(content_hash,sheet_name,row_number,project_id,style_code)
);
create table if not exists public.budget_cost_import_requests (
 import_id uuid primary key, actor_id uuid not null references public.profiles(id) on delete restrict,
 request jsonb not null,result jsonb not null,created_at timestamptz not null default clock_timestamp()
);
drop trigger if exists budget_cost_import_request_history on public.budget_cost_import_requests;
create trigger budget_cost_import_request_history before update or delete on public.budget_cost_import_requests for each row execute function public.protect_budget_history();
drop trigger if exists budget_cost_import_seen_history on public.budget_cost_import_seen_rows;
create trigger budget_cost_import_seen_history before update or delete on public.budget_cost_import_seen_rows for each row execute function public.protect_budget_history();

-- Once a cost originated in this workbook, later Q/S edits continue to obey
-- its amount formula. Ordinary manually-entered cost totals stay independent.
create or replace function public.protect_imported_budget_cost_amount() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.kind='cost' and new.kind='cost' and exists(select 1 from public.budget_cost_import_rows where record_id=old.id)
  and (new.data->>'amount')::numeric is distinct from ((new.data->>'unitCost')::numeric*(new.data->>'consumption')::numeric)
 then raise exception 'INVALID_COST_IMPORT: imported amount must equal Q times S';end if;
 return new;
end $$;
drop trigger if exists budget_cost_import_amount_guard on public.budget_records;
create trigger budget_cost_import_amount_guard before update on public.budget_records for each row execute function public.protect_imported_budget_cost_amount();

create or replace function public.get_budget_cost_import_capability() returns boolean language sql stable security definer set search_path='' as $$select public.budget_reader()$$;

create or replace function public.get_budget_cost_imports() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.budget_reader() then raise exception 'FORBIDDEN: approved financial reader required' using errcode='42501';end if;
 return jsonb_build_object('imports',coalesce((select jsonb_agg(jsonb_build_object('recordId',r.record_id,'projectId',r.project_id,'styleCode',r.style_code,
  'fileName',r.file_name,'sheetName',r.sheet_name,'rowNumber',r.row_number,'sourceKey',r.source_key,
  'rowFingerprint',r.row_fingerprint,'contentHash',r.content_hash,'updatedAt',r.updated_at,'updatedBy',r.updated_by)
  order by r.updated_at desc,r.record_id) from public.budget_cost_import_rows r),'[]'::jsonb),
  'aliases',coalesce((select jsonb_agg(jsonb_build_object('contentHash',s.content_hash,'sheetName',s.sheet_name,'rowNumber',s.row_number,'projectId',s.project_id,'styleCode',s.style_code,'recordId',s.record_id) order by s.content_hash,s.sheet_name,s.row_number,s.project_id,s.style_code) from public.budget_cost_import_seen_rows s),'[]'::jsonb));
end $$;

create or replace function public.import_budget_cost_rows(p_request jsonb,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 actor public.profiles;item jsonb;d jsonb;src jsonb;prior public.budget_records;origin public.budget_cost_import_rows;
 matched_id uuid;record_uuid uuid;project_uuid uuid;request_uuid uuid;expected integer;rowno integer;
 filename text;sheetname text;normalized_file text;token text;action text;fingerprint text;projectcode text;sku text;
 previous public.budget_cost_import_requests;result jsonb;inserted integer:=0;updated integer:=0;skipped integer:=0;
 stamp timestamptz:=clock_timestamp();seen_ids uuid[]:='{}';seen_sources jsonb[]:='{}';source_identity jsonb;
begin
 select * into actor from public.profiles where id=auth.uid() and approved and active and role in ('admin','internal');
 if actor.id is null then raise exception 'FORBIDDEN: cost imports require headquarters' using errcode='42501';end if;
 perform public.operations_reason(p_reason);
 perform public.operations_shape(p_request,array['importId','fileName','contentHash','rows']);
 request_uuid:=public.operations_uuid(p_request->>'importId');
 perform public.budget_text(p_request,'fileName',255,true);perform public.budget_text(p_request,'contentHash',64,true);
 filename:=p_request->>'fileName';token:=p_request->>'contentHash';
 if filename !~* '\.xlsx$' or token !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_COST_IMPORT: workbook name or content hash';end if;
 if jsonb_typeof(p_request->'rows') is distinct from 'array' or jsonb_array_length(p_request->'rows') not between 1 and 10000 or octet_length(p_request::text)>10485760 then raise exception 'INVALID_COST_IMPORT: 1 to 10000 rows within 10MB required';end if;
 -- Import batches serialize their logical origins, including renamed copies;
 -- individual cost records also use the existing budget-record lock order.
 perform pg_advisory_xact_lock(hashtextextended('sig:budget-cost-import',0));
 select * into previous from public.budget_cost_import_requests where import_id=request_uuid;
 if previous.import_id is not null then
  if previous.actor_id<>actor.id or previous.request is distinct from (p_request||jsonb_build_object('_reason',btrim(p_reason))) then raise exception 'VERSION_CONFLICT: import request ID was reused with different contents' using errcode='40001';end if;
  return previous.result;
 end if;
 normalized_file:=regexp_replace(lower(normalize(btrim(filename),NFKC)),'\.xlsx$','','i');
 for item in select value from jsonb_array_elements(p_request->'rows') loop
  perform public.operations_shape(item,array['recordId','expectedVersion','projectCode','styleCode','data','source','action']);
  record_uuid:=public.operations_uuid(item->>'recordId');
  if record_uuid=any(seen_ids) then raise exception 'INVALID_COST_IMPORT: duplicate cost record in one batch';end if;
  seen_ids:=array_append(seen_ids,record_uuid);
  if jsonb_typeof(item->'expectedVersion') is distinct from 'number' or item->>'expectedVersion' !~ '^[0-9]+$' or (item->>'expectedVersion')::numeric>2147483646 then raise exception 'INVALID_COST_IMPORT: expected record version';end if;
  expected:=(item->>'expectedVersion')::integer;
  perform public.budget_text(item,'projectCode',160,true);perform public.budget_text(item,'styleCode',80,true);perform public.budget_text(item,'action',10,true);
  projectcode:=btrim(item->>'projectCode');sku:=btrim(item->>'styleCode');action:=item->>'action';
  if action not in ('insert','update','skip') then raise exception 'INVALID_COST_IMPORT: row action';end if;
  d:=item->'data';src:=item->'source';
  perform public.operations_shape(src,array['fileName','sheetName','rowNumber','sourceKey','rowFingerprint','contentHash']);
  perform public.budget_text(src,'fileName',255,true);perform public.budget_text(src,'sheetName',100,true);perform public.budget_text(src,'sourceKey',1200,true);perform public.budget_text(src,'rowFingerprint',64,true);perform public.budget_text(src,'contentHash',64,true);
  if src->>'fileName'<>filename or src->>'contentHash'<>token or src->>'rowFingerprint' !~ '^[0-9a-f]{64}$' or jsonb_typeof(src->'rowNumber') is distinct from 'number' or src->>'rowNumber' !~ '^[0-9]+$' or (src->>'rowNumber')::numeric not between 16 and 10015 then raise exception 'INVALID_COST_IMPORT: source location or fingerprint';end if;
  sheetname:=btrim(src->>'sheetName');rowno:=(src->>'rowNumber')::integer;fingerprint:=src->>'rowFingerprint';
  perform public.operations_shape(d,array['projectId','budgetCode','styleCode','supplierId','supplierName','stage','category','description','position','specification','itemName','composition','color','unitCost','variableUnitCost','consumption','unit','amount','voided']);
  project_uuid:=public.operations_uuid(d->>'projectId');
  if d->>'stage'<>'pre' or d->'voided' is distinct from 'false'::jsonb or d->>'styleCode'<>sku or d->>'budgetCode'<>regexp_replace(projectcode||sku,'[[:space:]]','','g') then raise exception 'INVALID_COST_IMPORT: project, SKU or cost phase differs from source';end if;
  if d->'unitCost'='null'::jsonb or d->'consumption'='null'::jsonb or d->'amount'='null'::jsonb then raise exception 'INVALID_COST_IMPORT: unit price and consumption are required';end if;
  perform public.budget_amount(d,'unitCost',1000000000000,2);perform public.budget_amount(d,'consumption',1000000000000,4);perform public.budget_amount(d,'amount',1000000000000,6);
  if (d->>'amount')::numeric<>(d->>'unitCost')::numeric*(d->>'consumption')::numeric then raise exception 'INVALID_COST_IMPORT: amount must equal Q times S';end if;
  source_identity:=jsonb_build_array(normalized_file,sheetname,rowno,project_uuid,sku);
  begin if (src->>'sourceKey')::jsonb is distinct from source_identity then raise exception 'INVALID_COST_IMPORT: source identity differs from workbook location';end if;
  exception when invalid_text_representation then raise exception 'INVALID_COST_IMPORT: invalid source identity';end;
  if source_identity=any(seen_sources) then raise exception 'INVALID_COST_IMPORT: duplicate source row';end if;
  seen_sources:=array_append(seen_sources,source_identity);
  -- Both the source's B/C and its selected existing project ID must match.
  if not exists(
   select 1 from public.production_runs r join public.styles s on s.id=r.style_id join public.projects p on p.id=r.project_id
   where r.project_id=project_uuid and (s.deleted_at is null or r.closed_at is not null)
    and btrim(coalesce(nullif(r.snapshot->>'projectCode',''),nullif(r.project_code,''),p.code))=projectcode
    and coalesce(nullif(r.snapshot->>'styleCode',''),nullif(r.style_code_snapshot,''))=sku
   union all
   select 1 from public.styles s join public.projects p on p.id::text=s.data->>'projectId',jsonb_array_elements(s.data->'production') l
   where s.deleted_at is null and p.id=project_uuid and btrim(p.code)=projectcode
    and not exists(select 1 from public.production_runs r where r.style_id=s.id and r.line_id::text=l->>'id')
    and (case when upper(s.data->>'code') ~ '[0-9][A-Z]{2}$' and right(upper(s.data->>'code'),2)=upper(l->>'color') then s.data->>'code' else (s.data->>'code')||(l->>'color') end)=sku
  ) then raise exception 'INVALID_COST_IMPORT: B project code and C SKU must match an existing order';end if;
  perform pg_advisory_xact_lock(hashtextextended('sig:budget-record:'||record_uuid::text,0));
  select * into prior from public.budget_records where id=record_uuid for update;
  select * into origin from public.budget_cost_import_rows where record_id=record_uuid for update;
  matched_id:=null;
  select record_id into matched_id from public.budget_cost_import_rows where source_key::jsonb=source_identity;
  if matched_id is null then select record_id into matched_id from public.budget_cost_import_seen_rows where content_hash=token and sheet_name=sheetname and row_number=rowno and project_id=project_uuid and style_code=sku;end if;
  if matched_id is not null and matched_id<>record_uuid then raise exception 'VERSION_CONFLICT: this workbook row is already linked to another cost record' using errcode='40001';end if;
  if prior.id is null and matched_id is null and exists(select 1 from public.budget_cost_import_rows x where x.sheet_name=sheetname and x.row_number=rowno and x.project_id=project_uuid and x.style_code=sku) then raise exception 'BUDGET_IMPORT_ORIGIN_REQUIRED: 기존 원본 파일명으로 저장 후 다시 업로드해 주세요.';end if;
  if coalesce(prior.version,0)<>expected then raise exception 'VERSION_CONFLICT: imported cost changed after preview' using errcode='40001';end if;
  if prior.id is not null and (prior.kind<>'cost' or origin.record_id is null) then raise exception 'HISTORY_PROTECTED: an upload cannot overwrite a manually registered cost';end if;
  if origin.record_id is not null and (origin.project_id<>project_uuid or origin.style_code<>sku or not (origin.source_key::jsonb=source_identity or exists(select 1 from public.budget_cost_import_seen_rows x where x.record_id=record_uuid and x.content_hash=token and x.sheet_name=sheetname and x.row_number=rowno and x.project_id=project_uuid and x.style_code=sku))) then raise exception 'HISTORY_PROTECTED: an upload cannot overwrite a different source row';end if;
  if action='skip' then
   if prior.id is null or prior.data is distinct from d then raise exception 'VERSION_CONFLICT: skipped cost is no longer unchanged' using errcode='40001';end if;
   skipped:=skipped+1;
  else
   if action='insert' and prior.id is not null or action='update' and prior.id is null then raise exception 'VERSION_CONFLICT: cost row action is stale' using errcode='40001';end if;
   perform public.save_budget_record('cost',record_uuid,d,expected,p_reason);
   if prior.id is null then inserted:=inserted+1;else updated:=updated+1;end if;
  end if;
  insert into public.budget_cost_import_rows(record_id,project_id,style_code,file_name,sheet_name,row_number,source_key,row_fingerprint,content_hash,updated_at,updated_by)
   values(record_uuid,project_uuid,sku,filename,sheetname,rowno,src->>'sourceKey',fingerprint,token,stamp,actor.id)
   on conflict(record_id) do update set row_fingerprint=excluded.row_fingerprint,content_hash=excluded.content_hash,updated_at=excluded.updated_at,updated_by=excluded.updated_by;
  insert into public.budget_cost_import_seen_rows(content_hash,sheet_name,row_number,project_id,style_code,record_id)
   values(token,sheetname,rowno,project_uuid,sku,record_uuid) on conflict do nothing;
 end loop;
 result:=jsonb_build_object('inserted',inserted,'updated',updated,'skipped',skipped);
 insert into public.budget_cost_import_requests(import_id,actor_id,request,result,created_at) values(request_uuid,actor.id,p_request||jsonb_build_object('_reason',btrim(p_reason)),result,stamp);
 return result;
exception when unique_violation then raise exception 'VERSION_CONFLICT: workbook row already imported; refresh the preview' using errcode='40001';
end $$;

alter table public.budget_cost_import_rows enable row level security;
alter table public.budget_cost_import_seen_rows enable row level security;
alter table public.budget_cost_import_requests enable row level security;
drop policy if exists budget_cost_import_read on public.budget_cost_import_rows;
create policy budget_cost_import_read on public.budget_cost_import_rows for select to authenticated using(public.budget_reader());
revoke all on public.budget_cost_import_rows,public.budget_cost_import_seen_rows,public.budget_cost_import_requests from public,anon,authenticated;
grant select on public.budget_cost_import_rows to authenticated;
revoke execute on function public.budget_amount(jsonb,text,numeric,integer),public.protect_imported_budget_cost_amount(),public.get_budget_cost_import_capability(),public.get_budget_cost_imports(),public.import_budget_cost_rows(jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.get_budget_cost_import_capability(),public.get_budget_cost_imports(),public.import_budget_cost_rows(jsonb,text) to authenticated;
do $$begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='budget_cost_import_rows') then alter publication supabase_realtime add table public.budget_cost_import_rows;end if;
end $$;
commit;
