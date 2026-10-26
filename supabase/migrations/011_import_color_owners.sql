-- Apply after 010_member_withdrawal.sql. Preserve historical production identity;
-- CSV column Y may leave a style/color unassigned until headquarters selects it.
-- No existing style, quantity, receipt, closed amount, or owner snapshot is rewritten.
begin;

alter table public.production_runs alter column owner_id_snapshot drop not null;
do $$begin
 if not exists(select 1 from pg_constraint where conname='production_runs_owner_snapshot_shape' and conrelid='public.production_runs'::regclass) then
  alter table public.production_runs add constraint production_runs_owner_snapshot_shape
   check ((owner_id_snapshot is null and owner_name_snapshot='') or
          (owner_id_snapshot is not null and length(trim(owner_name_snapshot))>0));
 end if;
end $$;

create or replace function public.validate_style(p_id uuid, d jsonb) returns void language plpgsql
set search_path = public, pg_temp as $$
declare item jsonb; q jsonb; field text; value text; known text[]; color text; seen_ids text[] := '{}'; seen_rounds text[] := '{}';
begin
  if jsonb_typeof(d) is distinct from 'object' then raise exception 'INVALID_STYLE: object required'; end if;
  known := array['id','code','name','category','season','projectId','factoryId','ownerId','colors','dueDate','stage','ppApproved','notes','samples','production','version','updatedAt','updatedBy','deletedAt'];
  if exists(select 1 from jsonb_object_keys(d) k where not(k=any(known))) then raise exception 'INVALID_STYLE: unknown field'; end if;
  if not(d ?& known) then raise exception 'INVALID_STYLE: missing field'; end if;
  if d->>'id' is distinct from p_id::text then raise exception 'INVALID_STYLE: id mismatch'; end if;
  foreach field in array array['code','name','category','season','projectId','factoryId','ownerId','dueDate','stage','notes'] loop
    if jsonb_typeof(d->field) is distinct from 'string' then raise exception 'INVALID_STYLE: % must be text',field; end if;
    if length(d->>field)>10000 then raise exception 'INVALID_STYLE: value too long'; end if;
  end loop;
  if length(trim(d->>'code')) not between 1 and 80 or length(trim(d->>'name')) not between 1 and 200 then raise exception 'INVALID_STYLE: code/name required'; end if;
  if d->>'stage' not in ('registered','pattern','sample1','sampleN','review','revision','approved','production') then raise exception 'INVALID_STYLE: stage'; end if;
  if jsonb_typeof(d->'ppApproved') is distinct from 'boolean' then raise exception 'INVALID_STYLE: PP approval'; end if;
  foreach field in array array['factoryId','projectId'] loop
    if d->>field !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_STYLE: canonical UUID required'; end if;
  end loop;
  if not exists(select 1 from public.factories where id=(d->>'factoryId')::uuid) then raise exception 'INVALID_STYLE: unknown factory'; end if;
  if not exists(select 1 from public.projects where id=(d->>'projectId')::uuid) then raise exception 'INVALID_STYLE: unknown project'; end if;
  if d->>'ownerId'<>'' then
    if d->>'ownerId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_STYLE: owner UUID required'; end if;
    -- Withdrawal must block that account's access, without blocking everybody
    -- else's unrelated edits to an existing production record. An inactive HQ
    -- reference is retained only at its unchanged historical position.
    if not exists(select 1 from public.profiles p where p.id=(d->>'ownerId')::uuid and p.role in ('admin','internal') and (
      (p.approved and p.active) or exists(select 1 from public.styles oldstyle where oldstyle.id=p_id and oldstyle.data->>'ownerId'=d->>'ownerId')
    )) then raise exception 'INVALID_STYLE: owner must be an active approved employee or unchanged historical owner'; end if;
  end if;
  perform public.validate_sig_date(d->>'dueDate');
  if jsonb_typeof(d->'colors') is distinct from 'array' or jsonb_array_length(d->'colors') not between 1 and 40 then raise exception 'INVALID_STYLE: colors'; end if;
  if (select count(*) from jsonb_array_elements(d->'colors')) <> (select count(distinct e.value) from jsonb_array_elements(d->'colors') e) then raise exception 'INVALID_STYLE: duplicate color'; end if;
  for item in select * from jsonb_array_elements(d->'colors') loop
    if jsonb_typeof(item) is distinct from 'string' or (item#>>'{}') !~ '^[A-Z]{2}$' then raise exception 'INVALID_STYLE: color must be two uppercase letters'; end if;
  end loop;
  if jsonb_typeof(d->'samples') is distinct from 'array' or jsonb_array_length(d->'samples')>100 then raise exception 'INVALID_STYLE: samples'; end if;
  for item in select * from jsonb_array_elements(d->'samples') loop
    known := array['id','round','isPP','status','factoryId','ownerId','requestedAt','plannedAt','completedAt','shippedAt','receivedAt','reviewedAt','tracking','request','factoryComment','updatedAt'];
    if jsonb_typeof(item) is distinct from 'object' or not(item ?& known) or exists(select 1 from jsonb_object_keys(item) k where not(k=any(known))) then raise exception 'INVALID_STYLE: sample fields'; end if;
    if jsonb_typeof(item->'id') is distinct from 'string' or item->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_STYLE: sample UUID'; end if;
    if (item->>'id')=any(seen_ids) then raise exception 'INVALID_STYLE: duplicate sample id'; end if;
    perform (item->>'id')::uuid;
    seen_ids := array_append(seen_ids,item->>'id');
    if jsonb_typeof(item->'round') is distinct from 'number' or item->>'round' !~ '^[0-9]+$' or (item->>'round')::int not between 1 and 100 then raise exception 'INVALID_STYLE: sample round'; end if;
    if jsonb_typeof(item->'isPP') is distinct from 'boolean' then raise exception 'INVALID_STYLE: sample PP flag'; end if;
    if ((item->>'isPP')||':'||(item->>'round'))=any(seen_rounds) then raise exception 'INVALID_STYLE: duplicate sample round'; end if;
    seen_rounds := array_append(seen_rounds,(item->>'isPP')||':'||(item->>'round'));
    if item->>'status' not in ('unset','todo','progress','done','approved','delayed') then raise exception 'INVALID_STYLE: sample status'; end if;
    foreach field in array array['factoryId','ownerId'] loop
      if jsonb_typeof(item->field) is distinct from 'string' or (not(field='ownerId' and item->>field='') and item->>field !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then raise exception 'INVALID_STYLE: sample canonical UUID required'; end if;
    end loop;
    if not exists(select 1 from public.factories where id=(item->>'factoryId')::uuid) then raise exception 'INVALID_STYLE: sample factory'; end if;
    if item->>'ownerId'<>'' and not exists(select 1 from public.profiles where id=nullif(item->>'ownerId','')::uuid and role in ('admin','internal')) then raise exception 'INVALID_STYLE: sample owner'; end if;
    foreach field in array array['requestedAt','plannedAt','completedAt','shippedAt','receivedAt','reviewedAt'] loop perform public.validate_sig_date(item->>field); end loop;
    foreach field in array array['status','factoryId','ownerId','tracking','request','factoryComment','updatedAt'] loop
      if jsonb_typeof(item->field) is distinct from 'string' or length(item->>field)>10000 then raise exception 'INVALID_STYLE: sample %',field; end if;
    end loop;
  end loop;
  if jsonb_typeof(d->'production') is distinct from 'array' or jsonb_array_length(d->'production')<>jsonb_array_length(d->'colors') then raise exception 'INVALID_STYLE: one production line per color required'; end if;
  seen_ids := '{}'; seen_rounds := '{}';
  for item in select * from jsonb_array_elements(d->'production') loop
    known := array['id','color','order','shipped','received','packing','checks','confirmDue','shippedAt','receivedAt','invoice','invoiceAmount','paymentDue','paymentStatus','measurements','factoryComment'];
    if jsonb_typeof(item) is distinct from 'object' or not(item ?& known) or exists(select 1 from jsonb_object_keys(item) k where not(k=any(known||array['ownerId']))) then raise exception 'INVALID_STYLE: production fields'; end if;
    -- Absent ownerId retains the legacy style owner. Empty text explicitly means
    -- unassigned; it must never fall back to the uploader or another color.
    if item ? 'ownerId' then
      if jsonb_typeof(item->'ownerId') is distinct from 'string' then raise exception 'INVALID_STYLE: color owner must be text'; end if;
      if item->>'ownerId'<>'' then
        if item->>'ownerId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_STYLE: color owner UUID required'; end if;
        if not exists(select 1 from public.profiles p where p.id=(item->>'ownerId')::uuid and p.role in ('admin','internal') and (
          (p.approved and p.active) or exists(
            select 1 from public.styles oldstyle, jsonb_array_elements(oldstyle.data->'production') oldline
            where oldstyle.id=p_id and oldline->>'id'=item->>'id'
              and (case when oldline ? 'ownerId' then oldline->>'ownerId' else oldstyle.data->>'ownerId' end)=item->>'ownerId'
          )
        )) then raise exception 'INVALID_STYLE: color owner must be an active approved employee or unchanged historical owner'; end if;
      end if;
    end if;
    if jsonb_typeof(item->'id') is distinct from 'string' or item->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_STYLE: production UUID'; end if;
    perform (item->>'id')::uuid;
    if (item->>'id')=any(seen_ids) or (item->>'color')=any(seen_rounds) then raise exception 'INVALID_STYLE: duplicate production id/color'; end if;
    seen_ids := array_append(seen_ids,item->>'id'); seen_rounds := array_append(seen_rounds,item->>'color');
    if not(d->'colors' ? (item->>'color')) then raise exception 'INVALID_STYLE: production color'; end if;
    foreach field in array array['order','shipped','received','packing'] loop
      q:=item->field;
      if jsonb_typeof(q) is distinct from 'object' or not(q ?& array['XXS','XS','S','M','L','XL']) or (select count(*) from jsonb_object_keys(q))<>6 then raise exception 'INVALID_STYLE: six sizes required'; end if;
      for value in select jsonb_object_keys(q) loop
        if jsonb_typeof(q->value) is distinct from 'number' or q->>value !~ '^[0-9]+$' or (q->>value)::numeric > 10000000 then raise exception 'INVALID_STYLE: quantities must be nonnegative integers'; end if;
      end loop;
    end loop;
    q:=item->'checks'; known:=array['tp','pp','gb','labels','care','materials','packing','main','quality','packingList'];
    if jsonb_typeof(q) is distinct from 'object' or not(q ?& known) or (select count(*) from jsonb_object_keys(q))<>10 then raise exception 'INVALID_STYLE: production checks'; end if;
    for value in select jsonb_object_keys(q) loop
      if jsonb_typeof(q->value) is distinct from 'string' or q->>value not in ('unset','todo','progress','done','approved','delayed') then raise exception 'INVALID_STYLE: check status'; end if;
    end loop;
    foreach field in array array['invoice','paymentStatus'] loop
      if jsonb_typeof(item->field) is distinct from 'string' or item->>field not in ('unset','todo','progress','done','approved','delayed') then raise exception 'INVALID_STYLE: financial status'; end if;
    end loop;
    if jsonb_typeof(item->'invoiceAmount') is distinct from 'number' or (item->>'invoiceAmount')::numeric < 0 or (item->>'invoiceAmount')::numeric > 1000000000000 then raise exception 'INVALID_STYLE: invoice amount'; end if;
    foreach field in array array['confirmDue','shippedAt','receivedAt','paymentDue'] loop perform public.validate_sig_date(item->>field); end loop;
    foreach field in array array['color','measurements','factoryComment'] loop
      if jsonb_typeof(item->field) is distinct from 'string' or length(item->>field)>10000 then raise exception 'INVALID_STYLE: production text'; end if;
    end loop;
  end loop;
end $$;

create or replace function public.register_order_style(p_id uuid,p_expected_version integer,p_data jsonb,p_project jsonb,p_reason text)
returns public.styles language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; proj public.projects; oldstyle public.styles; item jsonb; previous jsonb; base jsonb; result public.styles; pid uuid;
begin
 actor:=public.operations_actor(); if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 perform public.operations_reason(p_reason); perform public.operations_shape(p_project,array['id','code','name','season','expected']);
 perform public.operations_text(p_project,'code',120,true); perform public.operations_text(p_project,'name',160,true); perform public.operations_text(p_project,'season',30,true);
 if p_project->>'code' ~ '[[:cntrl:]]' then raise exception 'INVALID_PROJECT'; end if;
 pid:=public.operations_uuid(p_project->>'id');
 perform pg_advisory_xact_lock(hashtextextended('project:'||lower(trim(p_project->>'code')),0));
 perform pg_advisory_xact_lock(hashtextextended('style:'||lower(p_data->>'code'),0));
 select * into proj from public.projects where id=pid for update;
 if proj.id is null then
  if p_project->'expected'<>'null'::jsonb then raise exception 'VERSION_CONFLICT: project removed' using errcode='40001'; end if;
  if exists(select 1 from public.projects where lower(trim(code))=lower(trim(p_project->>'code')) or (trim(code)='' and name=trim(p_project->>'name') and season=trim(p_project->>'season'))) then raise exception 'VERSION_CONFLICT: project already registered' using errcode='40001'; end if;
  insert into public.projects(id,code,name,season) values(pid,trim(p_project->>'code'),trim(p_project->>'name'),trim(p_project->>'season')) returning * into proj;
 else
  if p_project->'expected'='null'::jsonb then raise exception 'VERSION_CONFLICT: project already exists' using errcode='40001'; end if;
  perform public.operations_shape(p_project->'expected',array['code','name','season']);
  if jsonb_build_object('code',proj.code,'name',proj.name,'season',proj.season)<>p_project->'expected' then raise exception 'VERSION_CONFLICT: project changed' using errcode='40001'; end if;
  if proj.name<>trim(p_project->>'name') or proj.season<>trim(p_project->>'season') or (proj.code<>'' and lower(proj.code)<>lower(trim(p_project->>'code'))) then raise exception 'PROJECT_CONFLICT: existing project cannot be renamed by import'; end if;
  if proj.code='' then update public.projects set code=trim(p_project->>'code') where id=pid returning * into proj; end if;
 end if;
 if p_data->>'projectId'<>pid::text or p_data->>'season'<>proj.season then raise exception 'PROJECT_CONFLICT'; end if;
 select * into oldstyle from public.styles where id=p_id for update;
 if coalesce(oldstyle.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
 if oldstyle.id is not null and (oldstyle.deleted_at is not null or not public.can_access_style(p_id)) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if oldstyle.id is not null and (p_data-array['production','colors','projectId','season','version','updatedAt','updatedBy','deletedAt']) is distinct from (oldstyle.data-array['production','colors','projectId','season','version','updatedAt','updatedBy','deletedAt']) then raise exception 'INVALID_REGISTRATION: existing metadata changed'; end if;
 for item in select * from jsonb_array_elements(p_data->'production') loop
  select value into previous from jsonb_array_elements(coalesce(oldstyle.data->'production','[]')) where value->>'id'=item->>'id';
  if previous is not null then
   if (item-'ownerId')<>(previous-'ownerId') then raise exception 'INVALID_REGISTRATION: existing quantities changed'; end if;
  else
   base:='{"order":{"XXS":0,"XS":0,"S":0,"M":0,"L":0,"XL":0},"shipped":{"XXS":0,"XS":0,"S":0,"M":0,"L":0,"XL":0},"received":{"XXS":0,"XS":0,"S":0,"M":0,"L":0,"XL":0},"packing":{"XXS":0,"XS":0,"S":0,"M":0,"L":0,"XL":0},"checks":{"tp":"unset","pp":"unset","gb":"unset","labels":"unset","care":"unset","materials":"unset","packing":"unset","main":"unset","quality":"unset","packingList":"unset"},"confirmDue":"","shippedAt":"","receivedAt":"","invoice":"unset","invoiceAmount":0,"paymentDue":"","paymentStatus":"unset","measurements":"","factoryComment":""}';
   if item-array['id','color','ownerId']<>base then raise exception 'INVALID_REGISTRATION: new color must start blank'; end if;
  end if;
 end loop;
 if oldstyle.id is null and (p_data->'samples'<>'[]'::jsonb or p_data->>'stage'<>'registered' or p_data->'ppApproved'<>'false'::jsonb or p_data->>'name'<>p_data->>'code') then raise exception 'INVALID_REGISTRATION: new style defaults'; end if;
 result:=public.save_style(p_id,p_data,p_expected_version,trim(p_reason)); return result;
end $$;

create or replace function public.save_production_run(p_id uuid,p_style_id uuid,p_line_id uuid,p_data jsonb,p_expected_version integer,p_reason text)
returns public.production_runs language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;s public.styles;oldrow public.production_runs;result public.production_runs;project public.projects;po public.po_dispatches;
 v_project_id uuid;v_po_id uuid;correction uuid;cost numeric;key text;allocated bigint;stamp timestamptz:=clock_timestamp();line jsonb;next_round integer;
 factory_id uuid;owner_id uuid;factory_name text;owner_name text;
begin
 actor:=public.production_ledger_actor();perform public.operations_reason(p_reason);
 if p_id is null or p_style_id is null or p_line_id is null or p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_VERSION';end if;
 -- Parent first, then run: all writes on the same style serialize, including new rounds.
 select * into s from public.styles where id=p_style_id and deleted_at is null for update;
 if not found or not public.can_access_style(p_style_id) then raise exception 'FORBIDDEN: inaccessible style' using errcode='42501';end if;
 select x into line from jsonb_array_elements(s.data->'production') x where x->>'id'=p_line_id::text;
 if line is null then raise exception 'INVALID_PRODUCTION_RUN: registered production line required';end if;
 select * into oldrow from public.production_runs where id=p_id for update;
 if coalesce(oldrow.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if oldrow.id is not null and (oldrow.style_id<>p_style_id or oldrow.line_id<>p_line_id) then raise exception 'FORBIDDEN: different production line' using errcode='42501';end if;
 if oldrow.closed_at is not null then raise exception 'HISTORY_PROTECTED: finalized production run is immutable';end if;
 perform public.operations_shape(p_data,array['name','projectId','projectCode','expectedDue','poId','unitCost','itemType','order','correctsRunId']);
 perform public.operations_text(p_data,'name',120,true);perform public.operations_text(p_data,'projectCode',120);
 perform public.operations_text(p_data,'expectedDue',10);perform public.validate_sig_date(p_data->>'expectedDue');
 if p_data->>'name' ~ '[[:cntrl:]]' or p_data->>'projectCode' ~ '[[:cntrl:]]' then raise exception 'INVALID_PRODUCTION_RUN: control characters';end if;
 v_project_id:=public.operations_uuid(p_data->>'projectId');select * into project from public.projects where id=v_project_id for share;
 if project.id is null then raise exception 'INVALID_PRODUCTION_RUN: registered project required';end if;
 if trim(project.code)<>'' and trim(p_data->>'projectCode')<>trim(project.code) then raise exception 'INVALID_PRODUCTION_RUN: project code mismatch';end if;
 if jsonb_typeof(p_data->'itemType') is distinct from 'string' or p_data->>'itemType' not in ('product','fabric','label') then raise exception 'INVALID_PRODUCTION_RUN: item type';end if;
 perform public.operations_quantities(p_data->'order');
 if p_data->'unitCost'<>'null'::jsonb then
  if jsonb_typeof(p_data->'unitCost') is distinct from 'number' then raise exception 'INVALID_PRODUCTION_RUN: numeric cost required';end if;
  cost:=(p_data->>'unitCost')::numeric;if cost<0 or cost>1000000000 or cost<>round(cost,2) then raise exception 'INVALID_PRODUCTION_RUN: cost range or precision';end if;
 end if;
 if cost*public.production_quantity_total(p_data->'order')>1000000000000 then raise exception 'INVALID_PRODUCTION_RUN: amount exceeds one trillion';end if;
 factory_id:=coalesce(oldrow.factory_id_snapshot,(s.data->>'factoryId')::uuid);
 -- Existing nonblank snapshots are historical identities. Only an unassigned
 -- draft can capture a later manual assignment from its own color.
 owner_id:=coalesce(oldrow.owner_id_snapshot,nullif(case when line ? 'ownerId' then line->>'ownerId' else s.data->>'ownerId' end,'')::uuid);
 select name into factory_name from public.factories where id=factory_id;
 if oldrow.owner_id_snapshot is not null then owner_name:=oldrow.owner_name_snapshot;
 elsif owner_id is not null then
  select name into owner_name from public.profiles where id=owner_id and role in ('admin','internal') and approved and active;
  if coalesce(trim(owner_name),'')='' then raise exception 'INVALID_PRODUCTION_RUN: active approved headquarters owner required';end if;
 else owner_name:='';end if;
 if coalesce(trim(factory_name),'')='' then raise exception 'INVALID_PRODUCTION_RUN: factory required';end if;
 if p_data->'poId'<>'null'::jsonb then
  -- Draft edits serialize through the parent style lock. Provider finalization
  -- locks the PO first and writes a style-linked audit, so do not take a PO
  -- lock here in the reverse order. Sent PO content is immutable.
  v_po_id:=public.operations_uuid(p_data->>'poId');select * into po from public.po_dispatches where id=v_po_id;
  if po.id is null or po.style_id<>p_style_id or po.voided or po.factory_id_snapshot<>factory_id then raise exception 'INVALID_PRODUCTION_RUN: PO style or factory scope';end if;
 end if;
 if p_data->'correctsRunId'<>'null'::jsonb then
  correction:=public.operations_uuid(p_data->>'correctsRunId');
  if not exists(select 1 from public.production_runs where id=correction and id<>p_id and style_id=p_style_id and line_id=p_line_id and project_id=v_project_id and closed_at is not null) then raise exception 'INVALID_PRODUCTION_RUN: finalized correction target required';end if;
 end if;
 if oldrow.id is not null and exists(select 1 from public.production_receipts where run_id=p_id and not voided) and
  (oldrow.project_id<>v_project_id or oldrow.project_code<>trim(p_data->>'projectCode') or oldrow.unit_cost is distinct from cost or oldrow.item_type<>p_data->>'itemType' or oldrow.po_id is distinct from v_po_id or oldrow.corrects_run_id is distinct from correction)
 then raise exception 'HISTORY_PROTECTED: receipt-bearing financial identity is immutable';end if;
 -- No cap against current Style.order/received: another project can reorder the same SKU.
 foreach key in array array['XXS','XS','S','M','L','XL'] loop
  select coalesce(sum((quantities->>key)::bigint),0) into allocated from public.production_receipts where run_id=p_id and not voided;
  if allocated>(p_data->'order'->>key)::bigint then raise exception 'INVALID_PRODUCTION_RUN: order below actual receipts';end if;
 end loop;
 if oldrow.id is not null and oldrow.project_id<>v_project_id then raise exception 'HISTORY_PROTECTED: project cannot be moved; create a new production run';end if;
 select coalesce(max(round),0)+1 into next_round from public.production_runs where style_id=p_style_id and line_id=p_line_id and production_runs.project_id=v_project_id;
 if oldrow.id is null then
  insert into public.production_runs(id,style_id,line_id,project_id,name,project_code,expected_due,po_id,unit_cost,item_type,order_quantities,corrects_run_id,round,version,factory_id_snapshot,owner_id_snapshot,style_code_snapshot,factory_name_snapshot,owner_name_snapshot,created_at,updated_at,updated_by)
  values(p_id,p_style_id,p_line_id,v_project_id,trim(p_data->>'name'),trim(p_data->>'projectCode'),nullif(p_data->>'expectedDue','')::date,v_po_id,cost,p_data->>'itemType',p_data->'order',correction,next_round,1,factory_id,owner_id,case when s.data->>'code' ~ '^[A-Z0-9]{12}[A-Z]{2}$' and right(s.data->>'code',2)=line->>'color' then s.data->>'code' else coalesce(s.data->>'code','')||coalesce(line->>'color','') end,factory_name,owner_name,stamp,stamp,actor.id) returning * into result;
 else
  update public.production_runs set name=trim(p_data->>'name'),project_code=trim(p_data->>'projectCode'),expected_due=nullif(p_data->>'expectedDue','')::date,po_id=v_po_id,unit_cost=cost,item_type=p_data->>'itemType',order_quantities=p_data->'order',corrects_run_id=correction,owner_id_snapshot=owner_id,owner_name_snapshot=owner_name,version=version+1,updated_at=stamp,updated_by=actor.id where id=p_id returning * into result;
 end if;
 perform public.production_ledger_audit(actor,result,'생산 차수 저장',p_reason,case when oldrow.id is null then null else to_jsonb(oldrow) end,to_jsonb(result));return result;
end $$;

create or replace function public.finalize_production_run(p_run_id uuid,p_expected_version integer,p_reason text)
returns public.production_runs language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;r public.production_runs;result public.production_runs;s public.styles;v_style_id uuid;quantity bigint;amount numeric;receipts jsonb;last_received date;stamp timestamptz:=clock_timestamp();frozen jsonb;before_row jsonb;line jsonb;owner_id uuid;owner_name text;
begin
 actor:=public.production_ledger_actor();perform public.operations_reason(p_reason);
 select production_runs.style_id into v_style_id from public.production_runs where id=p_run_id;
 select * into s from public.styles where id=v_style_id and deleted_at is null for update;
 if not found or not public.can_access_style(v_style_id) then raise exception 'FORBIDDEN: inaccessible style' using errcode='42501';end if;
 select * into r from public.production_runs where id=p_run_id for update;
 if r.id is null or p_expected_version is null or r.version<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 before_row:=to_jsonb(r);
 if r.closed_at is not null then raise exception 'HISTORY_PROTECTED: finalized production run is immutable';end if;
 if not exists(select 1 from jsonb_array_elements(s.data->'production') x where x->>'id'=r.line_id::text) then raise exception 'INVALID_PRODUCTION_RUN: production line removed';end if;
 select coalesce(sum(public.production_quantity_total(quantities)),0),jsonb_agg(public.production_receipt_json(x) order by x.received_at,x.id),max(received_at)
 into quantity,receipts,last_received from public.production_receipts x where run_id=p_run_id and not voided;
 if quantity=0 or r.unit_cost is null or trim(r.project_code)='' then raise exception 'INVALID_PRODUCTION_RUN: price, project and actual receipt required';end if;
 amount:=r.unit_cost*quantity;if amount>1000000000000 then raise exception 'INVALID_PRODUCTION_RUN: amount exceeds one trillion';end if;
 -- A later manual assignment can fill a previously blank draft snapshot; an
 -- assigned historical owner is preserved even if the parent changes again.
 if r.owner_id_snapshot is null then
  select x into line from jsonb_array_elements(s.data->'production') x where x->>'id'=r.line_id::text;
  owner_id:=nullif(case when line ? 'ownerId' then line->>'ownerId' else s.data->>'ownerId' end,'')::uuid;
  select name into owner_name from public.profiles where id=owner_id and role in ('admin','internal') and approved and active;
  if coalesce(trim(owner_name),'')='' then raise exception 'INVALID_PRODUCTION_RUN: assign headquarters owner before finalization';end if;
  r.owner_id_snapshot:=owner_id;r.owner_name_snapshot:=owner_name;
 end if;
 if coalesce(trim(r.owner_name_snapshot),'')='' then raise exception 'INVALID_PRODUCTION_RUN: owner required before finalization';end if;
 frozen:=jsonb_build_object('projectId',r.project_id,'projectCode',r.project_code,'expectedDue',coalesce(r.expected_due::text,''),'factoryIdSnapshot',r.factory_id_snapshot,'ownerIdSnapshot',r.owner_id_snapshot,'styleCodeSnapshot',r.style_code_snapshot,'factoryNameSnapshot',r.factory_name_snapshot,'ownerNameSnapshot',r.owner_name_snapshot,'styleCode',r.style_code_snapshot,'factory',r.factory_name_snapshot,'owner',r.owner_name_snapshot,'name',r.name,'round',r.round,'poId',r.po_id,'itemType',r.item_type,'unitCost',r.unit_cost,'orderQuantity',public.production_quantity_total(r.order_quantities),'receivedQuantity',quantity,'netAmount',amount,'vatAmount',amount/10,'grossAmount',amount*11/10,'lastReceivedAt',last_received,'receipts',receipts,'finalizedAt',stamp,'finalizedBy',actor.id);
 update public.production_runs set closed_at=stamp,snapshot=frozen,owner_id_snapshot=r.owner_id_snapshot,owner_name_snapshot=r.owner_name_snapshot,version=version+1,updated_at=stamp,updated_by=actor.id where id=p_run_id returning * into result;
 perform public.production_ledger_audit(actor,result,'생산 차수 마감 확정',p_reason,before_row,to_jsonb(result));return result;
end $$;
-- Factories can display only the names/IDs/roles of headquarters owners linked
-- to an accessible style. Per-color owners inherit this narrow projection;
-- profiles RLS stays self-only and email addresses remain private.
create or replace function public.visible_style_owners() returns table(id uuid,name text,role text)
language sql stable security definer set search_path=public,pg_temp as $$
 select p.id,p.name,p.role from public.profiles p
 where p.approved and p.active and p.role in ('admin','internal') and exists (
  select 1 from public.styles s
  where s.deleted_at is null and public.can_access_style(s.id) and (
   s.data->>'ownerId'=p.id::text or exists (
    select 1 from jsonb_array_elements(s.data->'samples') item where item->>'ownerId'=p.id::text
   ) or exists (
    select 1 from jsonb_array_elements(s.data->'production') item where item->>'ownerId'=p.id::text
   )
  )
 )
$$;

create or replace function public.get_import_color_owners_capability() returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.profiles where id=auth.uid() and approved and active and role in ('admin','internal'))
$$;
revoke execute on function public.get_import_color_owners_capability() from public,anon;
grant execute on function public.get_import_color_owners_capability() to authenticated;
-- CREATE OR REPLACE preserves the original RPC grants and internal validator ACL.
commit;
