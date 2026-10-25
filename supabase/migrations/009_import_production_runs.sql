-- Apply once after 008_supplier_acceptance.sql. Each file application creates
-- independent project/production rounds. No emails are sent by this SQL.
begin;

create table public.production_order_imports (
 id uuid primary key, actor_id uuid not null references public.profiles(id),
 payload_hash text not null, result jsonb, created_at timestamptz not null default now()
);
alter table public.production_order_imports enable row level security;
revoke all on public.production_order_imports from public,anon,authenticated;

create function public.bulk_import_production_orders(p_import_id uuid,p_changes jsonb,p_mode text,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;request_hash text;prior public.production_order_imports;change jsonb;detail jsonb;source_row jsonb;
 s public.styles;project public.projects;v_project_code text;v_project_name text;v_season text;source_codes text[];project_count integer;
 plan jsonb:='[]';entry jsonb;legacy_result jsonb;run public.production_runs;run_ids jsonb:='[]';v_result jsonb;
begin
 actor:=public.production_ledger_actor();perform public.operations_reason(p_reason);
 if p_import_id is null then raise exception 'INVALID_IMPORT: import id required';end if;
 if p_mode is null or p_mode not in ('replace','add') or jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) not between 1 and 500 then raise exception 'INVALID_IMPORT: mode or style count';end if;
 request_hash:=encode(sha256(convert_to(jsonb_build_object('changes',p_changes,'mode',p_mode,'reason',p_reason)::text,'UTF8')),'hex');
 -- Insert-or-lock serializes concurrent retries of one request. A later failure
 -- rolls this row back with all order quantities and newly created rounds.
 insert into public.production_order_imports(id,actor_id,payload_hash) values(p_import_id,actor.id,request_hash) on conflict(id) do nothing;
 select * into prior from public.production_order_imports where id=p_import_id for update;
 if prior.actor_id<>actor.id or prior.payload_hash<>request_hash then raise exception 'IMPORT_ID_REUSED: request id already belongs to other content';end if;
 if prior.result is not null then return prior.result;end if;
 -- Validate source project identity before running the existing CAS importer.
 for change in select * from jsonb_array_elements(p_changes) loop
  select * into s from public.styles where id=public.operations_uuid(change->>'styleId') and deleted_at is null;
  if s.id is null or not public.can_access_style(s.id) then raise exception 'FORBIDDEN: inaccessible import style' using errcode='42501';end if;
  if jsonb_typeof(change->'lines') is distinct from 'array' then raise exception 'INVALID_IMPORT: lines required';end if;
  for detail in select * from jsonb_array_elements(change->'lines') loop
   project:=null;source_codes:='{}';
   if detail ? 'source' then
    perform public.validate_order_source_data((detail->'source')-'expectedVersion');
    select coalesce(array_agg(distinct upper(trim(row->'columns'->>'A'))) filter(where trim(coalesce(row->'columns'->>'A',''))<>''),'{}') into source_codes
     from jsonb_array_elements(detail->'source'->'rows') row;
   end if;
   if cardinality(source_codes)>1 then raise exception 'IMPORT_MIXED_PROJECTS: split this style/color by source A project';end if;
   if cardinality(source_codes)=1 then
    v_project_code:=source_codes[1];
    select count(*) into project_count from public.projects where upper(trim(code))=v_project_code and trim(code)<>'';
    if project_count<>1 then raise exception 'IMPORT_PROJECT_REQUIRED: register source A project code first';end if;
    select * into project from public.projects where upper(trim(code))=v_project_code and trim(code)<>'' for share;
   else
    select * into project from public.projects where id=(s.data->>'projectId')::uuid for share;
    if project.id is null then raise exception 'IMPORT_PROJECT_REQUIRED: registered project required';end if;
   end if;
   if detail ? 'source' then
    for source_row in select * from jsonb_array_elements(detail->'source'->'rows') loop
     v_project_name:=trim(coalesce(source_row->'columns'->>'M',''));v_season:=trim(coalesce(source_row->'columns'->>'L',''));
     if (v_project_name<>'' and v_project_name<>trim(project.name)) or (v_season<>'' and v_season<>trim(project.season)) then raise exception 'IMPORT_PROJECT_MISMATCH: source M/L differs from registered project';end if;
    end loop;
   end if;
   plan:=plan||jsonb_build_array(jsonb_build_object('styleId',s.id,'lineId',detail->>'lineId','projectId',project.id,'projectCode',coalesce(trim(project.code),''),'order',detail->'quantities'));
  end loop;
 end loop;
 legacy_result:=public.bulk_import_order_quantities(p_changes,p_mode,p_reason);
 for entry in select * from jsonb_array_elements(plan) loop
  run:=public.save_production_run(gen_random_uuid(),(entry->>'styleId')::uuid,(entry->>'lineId')::uuid,
    jsonb_build_object('name','오더 업로드','projectId',entry->>'projectId','projectCode',entry->>'projectCode','expectedDue','','poId',null,'unitCost',null,'itemType','product','order',entry->'order','correctsRunId',null),0,p_reason);
  run_ids:=run_ids||to_jsonb(run.id);
 end loop;
 v_result:=jsonb_build_object('styles',legacy_result,'runIds',run_ids);
 update public.production_order_imports set result=v_result where id=p_import_id;
 return v_result;
end $$;
revoke all on function public.bulk_import_production_orders(uuid,jsonb,text,text) from public,anon;
grant execute on function public.bulk_import_production_orders(uuid,jsonb,text,text) to authenticated;

commit;
