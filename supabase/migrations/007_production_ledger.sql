-- Apply once after 006_staff_approvals.sql. No existing quantities are migrated,
-- inferred or repriced. Each project/production round has its own actual receipts.
begin;

create table public.production_runs (
 id uuid primary key,style_id uuid not null references public.styles(id) on delete restrict,line_id uuid not null,
 project_id uuid not null references public.projects(id) on delete restrict,
 name text not null,project_code text not null,expected_due date,po_id uuid references public.po_dispatches(id) on delete restrict,
 unit_cost numeric check(unit_cost is null or (unit_cost>=0 and unit_cost<=1000000000 and unit_cost=round(unit_cost,2))),
 item_type text not null check(item_type in ('product','fabric','label')),order_quantities jsonb not null,
 corrects_run_id uuid references public.production_runs(id) on delete restrict,
 round integer not null check(round between 1 and 10000),version integer not null check(version>0),
 factory_id_snapshot uuid not null references public.factories(id) on delete restrict,
 owner_id_snapshot uuid not null references public.profiles(id) on delete restrict,
 style_code_snapshot text not null,factory_name_snapshot text not null,owner_name_snapshot text not null,
 closed_at timestamptz,snapshot jsonb,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),updated_by uuid not null references public.profiles(id),
 unique(project_id,style_id,line_id,round),check((closed_at is null)=(snapshot is null))
);
create unique index production_runs_po_line_unique on public.production_runs(po_id,line_id) where po_id is not null;
create index production_runs_style_idx on public.production_runs(style_id,line_id,project_id);
create table public.production_receipts (
 id uuid primary key,run_id uuid not null references public.production_runs(id) on delete restrict,
 style_id uuid not null references public.styles(id) on delete restrict,line_id uuid not null,
 received_at date not null,quantities jsonb not null,unit_cost numeric not null,net_amount numeric not null,
 voided boolean not null default false,version integer not null check(version>0),
 created_at timestamptz not null default now(),created_by uuid not null references public.profiles(id)
);
create index production_receipts_run_idx on public.production_receipts(run_id,received_at,id);
-- Financial before/after values are never written into factory-visible audits.
create table public.production_run_audits (
 id uuid primary key default gen_random_uuid(),run_id uuid not null references public.production_runs(id) on delete restrict,
 style_id uuid not null references public.styles(id) on delete restrict,line_id uuid not null,
 actor_id uuid not null references public.profiles(id),actor_name text not null,action text not null,reason text not null,
 before jsonb,after jsonb,created_at timestamptz not null default now()
);
create index production_run_audits_run_idx on public.production_run_audits(run_id,created_at);

create function public.guard_production_run_parent() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if exists(select 1 from public.production_runs r where r.style_id=new.id and not exists(select 1 from jsonb_array_elements(new.data->'production') line where line->>'id'=r.line_id::text)) then
  raise exception 'HISTORY_PROTECTED: a production-run line cannot be removed';
 end if;
 return new;
end $$;
create trigger production_run_parent_guard before update of data on public.styles for each row execute function public.guard_production_run_parent();

create function public.guard_production_run_history() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if old.closed_at is not null then raise exception 'HISTORY_PROTECTED: finalized production run is immutable';end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger production_run_history_guard before update or delete on public.production_runs for each row execute function public.guard_production_run_history();
create function public.guard_production_receipt_history() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if tg_op='DELETE' or exists(select 1 from public.production_runs where id=old.run_id and closed_at is not null) then raise exception 'HISTORY_PROTECTED: actual receipt history cannot be deleted or changed after finalization';end if;
 if (to_jsonb(new)-array['voided','version']) is distinct from (to_jsonb(old)-array['voided','version']) or old.voided or not new.voided or new.version<>old.version+1 then raise exception 'HISTORY_PROTECTED: void the receipt instead of rewriting it';end if;
 return new;
end $$;
create trigger production_receipt_history_guard before update or delete on public.production_receipts for each row execute function public.guard_production_receipt_history();

create function public.get_production_ledger_capability() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.profiles where id=auth.uid() and approved and active and role in ('admin','internal'))
$$;
create function public.production_ledger_actor() returns public.profiles language plpgsql stable security definer set search_path=public,pg_temp as $$
declare actor public.profiles;
begin
 actor:=public.operations_actor();
 if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN: production financial ledger is headquarters-only' using errcode='42501';end if;
 return actor;
end $$;
create function public.production_quantity_total(q jsonb) returns bigint language sql immutable set search_path=public,pg_temp as $$
 select sum(value::bigint) from jsonb_each_text(q)
$$;
create function public.production_receipt_json(r public.production_receipts) returns jsonb language sql immutable set search_path=public,pg_temp as $$
 select jsonb_build_object('id',r.id,'runId',r.run_id,'styleId',r.style_id,'lineId',r.line_id,'receivedAt',r.received_at,'quantities',r.quantities,'unitCost',r.unit_cost,'netAmount',r.net_amount,'voided',r.voided,'version',r.version,'createdAt',r.created_at,'createdBy',r.created_by)
$$;
create function public.production_ledger_audit(actor public.profiles,r public.production_runs,p_action text,p_reason text,p_before jsonb,p_after jsonb) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.production_run_audits(run_id,style_id,line_id,actor_id,actor_name,action,reason,before,after)
 values(r.id,r.style_id,r.line_id,actor.id,actor.name,p_action,trim(p_reason),p_before,p_after);
 insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after)
 values(r.style_id,actor.id,actor.name,p_action,'본사 전용 생산 차수 정산 변경',null,jsonb_build_object('runId',r.id,'version',r.version));
end $$;

create function public.save_production_run(p_id uuid,p_style_id uuid,p_line_id uuid,p_data jsonb,p_expected_version integer,p_reason text)
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
 factory_id:=coalesce(oldrow.factory_id_snapshot,(s.data->>'factoryId')::uuid);owner_id:=coalesce(oldrow.owner_id_snapshot,(s.data->>'ownerId')::uuid);
 select name into factory_name from public.factories where id=factory_id;select name into owner_name from public.profiles where id=owner_id;
 if coalesce(trim(factory_name),'')='' or coalesce(trim(owner_name),'')='' then raise exception 'INVALID_PRODUCTION_RUN: factory and owner required';end if;
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
  update public.production_runs set name=trim(p_data->>'name'),project_code=trim(p_data->>'projectCode'),expected_due=nullif(p_data->>'expectedDue','')::date,po_id=v_po_id,unit_cost=cost,item_type=p_data->>'itemType',order_quantities=p_data->'order',corrects_run_id=correction,version=version+1,updated_at=stamp,updated_by=actor.id where id=p_id returning * into result;
 end if;
 perform public.production_ledger_audit(actor,result,'생산 차수 저장',p_reason,case when oldrow.id is null then null else to_jsonb(oldrow) end,to_jsonb(result));return result;
end $$;

create function public.allocate_production_receipt(p_id uuid,p_run_id uuid,p_data jsonb,p_expected_run_version integer,p_reason text)
returns public.production_receipts language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;r public.production_runs;s public.styles;result public.production_receipts;key text;allocated bigint;amount numeric;stamp timestamptz:=clock_timestamp();v_style_id uuid;
begin
 actor:=public.production_ledger_actor();if actor.role<>'admin' then raise exception 'FORBIDDEN: actual receipts require administrator' using errcode='42501';end if;perform public.operations_reason(p_reason);
 select production_runs.style_id into v_style_id from public.production_runs where id=p_run_id;
 select * into s from public.styles where id=v_style_id and deleted_at is null for update;
 if not found or not public.can_access_style(v_style_id) then raise exception 'FORBIDDEN: inaccessible style' using errcode='42501';end if;
 select * into r from public.production_runs where id=p_run_id for update;
 if r.id is null or p_id is null or p_expected_run_version is null or r.version<>p_expected_run_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if r.closed_at is not null then raise exception 'HISTORY_PROTECTED: finalized production run is immutable';end if;
 if not exists(select 1 from jsonb_array_elements(s.data->'production') x where x->>'id'=r.line_id::text) then raise exception 'INVALID_PRODUCTION_RUN: production line removed';end if;
 perform public.operations_shape(p_data,array['receivedAt','quantities']);perform public.operations_text(p_data,'receivedAt',10,true);perform public.validate_sig_date(p_data->>'receivedAt');perform public.operations_quantities(p_data->'quantities');
 if public.production_quantity_total(p_data->'quantities')=0 or r.unit_cost is null or trim(r.project_code)='' then raise exception 'INVALID_PRODUCTION_RECEIPT: quantity, price and project required';end if;
 foreach key in array array['XXS','XS','S','M','L','XL'] loop
  select coalesce(sum((quantities->>key)::bigint),0) into allocated from public.production_receipts where run_id=r.id and not voided;
  if allocated+(p_data->'quantities'->>key)::bigint>(r.order_quantities->>key)::bigint then raise exception 'INVALID_PRODUCTION_RECEIPT: actual receipt exceeds run order';end if;
 end loop;
 amount:=r.unit_cost*public.production_quantity_total(p_data->'quantities');if amount>1000000000000 then raise exception 'INVALID_PRODUCTION_RECEIPT: amount exceeds one trillion';end if;
 insert into public.production_receipts(id,run_id,style_id,line_id,received_at,quantities,unit_cost,net_amount,version,created_at,created_by)
 values(p_id,r.id,r.style_id,r.line_id,(p_data->>'receivedAt')::date,p_data->'quantities',r.unit_cost,amount,1,stamp,actor.id) returning * into result;
 update public.production_runs set version=version+1,updated_at=stamp,updated_by=actor.id where id=r.id returning * into r;
 perform public.production_ledger_audit(actor,r,'생산 차수 실입고 기록',p_reason,null,to_jsonb(result));return result;
end $$;

create function public.void_production_receipt(p_id uuid,p_run_id uuid,p_expected_receipt_version integer,p_expected_run_version integer,p_reason text)
returns public.production_receipts language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;r public.production_runs;oldrow public.production_receipts;result public.production_receipts;s public.styles;v_style_id uuid;stamp timestamptz:=clock_timestamp();
begin
 actor:=public.production_ledger_actor();if actor.role<>'admin' then raise exception 'FORBIDDEN: actual receipts require administrator' using errcode='42501';end if;perform public.operations_reason(p_reason);
 select production_runs.style_id into v_style_id from public.production_runs where id=p_run_id;
 select * into s from public.styles where id=v_style_id and deleted_at is null for update;
 if not found or not public.can_access_style(v_style_id) then raise exception 'FORBIDDEN: inaccessible style' using errcode='42501';end if;
 select * into r from public.production_runs where id=p_run_id for update;
 if r.id is null or p_expected_run_version is null or r.version<>p_expected_run_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if r.closed_at is not null then raise exception 'HISTORY_PROTECTED: finalized production run is immutable';end if;
 select * into oldrow from public.production_receipts where id=p_id and run_id=p_run_id for update;
 if oldrow.id is null or oldrow.voided or p_expected_receipt_version is null or oldrow.version<>p_expected_receipt_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 update public.production_receipts set voided=true,version=version+1 where id=p_id returning * into result;
 update public.production_runs set version=version+1,updated_at=stamp,updated_by=actor.id where id=p_run_id returning * into r;
 perform public.production_ledger_audit(actor,r,'생산 실입고 무효',p_reason,to_jsonb(oldrow),to_jsonb(result));return result;
end $$;

create function public.finalize_production_run(p_run_id uuid,p_expected_version integer,p_reason text)
returns public.production_runs language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;r public.production_runs;result public.production_runs;s public.styles;v_style_id uuid;quantity bigint;amount numeric;receipts jsonb;last_received date;stamp timestamptz:=clock_timestamp();frozen jsonb;
begin
 actor:=public.production_ledger_actor();perform public.operations_reason(p_reason);
 select production_runs.style_id into v_style_id from public.production_runs where id=p_run_id;
 select * into s from public.styles where id=v_style_id and deleted_at is null for update;
 if not found or not public.can_access_style(v_style_id) then raise exception 'FORBIDDEN: inaccessible style' using errcode='42501';end if;
 select * into r from public.production_runs where id=p_run_id for update;
 if r.id is null or p_expected_version is null or r.version<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if r.closed_at is not null then raise exception 'HISTORY_PROTECTED: finalized production run is immutable';end if;
 if not exists(select 1 from jsonb_array_elements(s.data->'production') x where x->>'id'=r.line_id::text) then raise exception 'INVALID_PRODUCTION_RUN: production line removed';end if;
 select coalesce(sum(public.production_quantity_total(quantities)),0),jsonb_agg(public.production_receipt_json(x) order by x.received_at,x.id),max(received_at)
 into quantity,receipts,last_received from public.production_receipts x where run_id=p_run_id and not voided;
 if quantity=0 or r.unit_cost is null or trim(r.project_code)='' then raise exception 'INVALID_PRODUCTION_RUN: price, project and actual receipt required';end if;
 amount:=r.unit_cost*quantity;if amount>1000000000000 then raise exception 'INVALID_PRODUCTION_RUN: amount exceeds one trillion';end if;
 frozen:=jsonb_build_object('projectId',r.project_id,'projectCode',r.project_code,'expectedDue',coalesce(r.expected_due::text,''),'factoryIdSnapshot',r.factory_id_snapshot,'ownerIdSnapshot',r.owner_id_snapshot,'styleCodeSnapshot',r.style_code_snapshot,'factoryNameSnapshot',r.factory_name_snapshot,'ownerNameSnapshot',r.owner_name_snapshot,'styleCode',r.style_code_snapshot,'factory',r.factory_name_snapshot,'owner',r.owner_name_snapshot,'name',r.name,'round',r.round,'poId',r.po_id,'itemType',r.item_type,'unitCost',r.unit_cost,'orderQuantity',public.production_quantity_total(r.order_quantities),'receivedQuantity',quantity,'netAmount',amount,'vatAmount',amount/10,'grossAmount',amount*11/10,'lastReceivedAt',last_received,'receipts',receipts,'finalizedAt',stamp,'finalizedBy',actor.id);
 update public.production_runs set closed_at=stamp,snapshot=frozen,version=version+1,updated_at=stamp,updated_by=actor.id where id=p_run_id returning * into result;
 perform public.production_ledger_audit(actor,result,'생산 차수 마감 확정',p_reason,to_jsonb(r),to_jsonb(result));return result;
end $$;

alter table public.production_runs enable row level security;
alter table public.production_receipts enable row level security;
alter table public.production_run_audits enable row level security;
create policy production_runs_hq_read on public.production_runs for select to authenticated using(public.current_app_role() in ('admin','internal') and public.can_access_style(style_id) and exists(select 1 from public.styles where id=style_id and deleted_at is null));
create policy production_receipts_hq_read on public.production_receipts for select to authenticated using(public.current_app_role() in ('admin','internal') and public.can_access_style(style_id) and exists(select 1 from public.styles where id=style_id and deleted_at is null));
create policy production_run_audits_hq_read on public.production_run_audits for select to authenticated using(public.current_app_role() in ('admin','internal') and public.can_access_style(style_id) and exists(select 1 from public.styles where id=style_id and deleted_at is null));
revoke all on public.production_runs,public.production_receipts,public.production_run_audits from public,anon,authenticated;
grant select on public.production_runs,public.production_receipts,public.production_run_audits to authenticated;
revoke execute on function public.guard_production_run_parent(),public.guard_production_run_history(),public.guard_production_receipt_history(),public.production_ledger_actor(),public.production_quantity_total(jsonb),public.production_receipt_json(public.production_receipts),public.production_ledger_audit(public.profiles,public.production_runs,text,text,jsonb,jsonb) from public,anon,authenticated;
revoke execute on function public.get_production_ledger_capability(),public.save_production_run(uuid,uuid,uuid,jsonb,integer,text),public.allocate_production_receipt(uuid,uuid,jsonb,integer,text),public.void_production_receipt(uuid,uuid,integer,integer,text),public.finalize_production_run(uuid,integer,text) from public,anon;
grant execute on function public.get_production_ledger_capability(),public.save_production_run(uuid,uuid,uuid,jsonb,integer,text),public.allocate_production_receipt(uuid,uuid,jsonb,integer,text),public.void_production_receipt(uuid,uuid,integer,integer,text),public.finalize_production_run(uuid,integer,text) to authenticated;
do $$declare t text;begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  foreach t in array array['production_runs','production_receipts','production_run_audits'] loop
   if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then execute format('alter publication supabase_realtime add table public.%I',t);end if;
  end loop;
 end if;
end $$;
commit;
