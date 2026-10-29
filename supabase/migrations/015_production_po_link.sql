-- Explicit linkage preserves sent PO documents and records the comparison basis.
begin;
create table if not exists public.po_production_contexts (
  po_id uuid primary key references public.po_dispatches(id) on delete restrict,
  style_id uuid not null references public.styles(id) on delete restrict,
  source text not null check(source in ('style','run')),
  snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
  captured_at timestamptz not null default now()
);
create table if not exists public.production_po_link_audits (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.production_runs(id) on delete restrict,
  po_id uuid not null unique references public.po_dispatches(id) on delete restrict,
  style_id uuid not null references public.styles(id) on delete restrict,
  actor_id uuid not null references public.profiles(id), actor_name text not null,
  reason text not null, verification text not null,
  source_snapshot jsonb, confirmed_snapshot jsonb not null,
  po_snapshot jsonb not null, created_at timestamptz not null default now()
);

create or replace function public.capture_po_style_context() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.styles; p public.projects; lines jsonb;
begin
  select * into s from public.styles where id=new.style_id;
  select * into p from public.projects where id=(s.data->>'projectId')::uuid;
  select coalesce(jsonb_agg(jsonb_build_object('lineId',line->>'id','color',line->>'color',
    'styleCode',case when s.data->>'code' ~ '^[A-Z0-9]{12}[A-Z]{2}$' and right(s.data->>'code',2)=line->>'color' then s.data->>'code' else coalesce(s.data->>'code','')||coalesce(line->>'color','') end,
    'order',line->'order')),'[]'::jsonb) into lines from jsonb_array_elements(s.data->'production') line;
  insert into public.po_production_contexts(po_id,style_id,source,snapshot)
    values(new.id,new.style_id,'style',jsonb_build_object('styleId',new.style_id,'projectId',p.id,'projectCode',coalesce(p.code,''),'projectName',p.name,
      'factoryId',new.factory_id_snapshot,'runId',null,'lineId',null,'styleCode',new.style_code_snapshot,'color',null,'order',null,'lines',lines,'productionMode',null));
  return new;
end $$;
drop trigger if exists po_style_context_capture on public.po_dispatches;
create trigger po_style_context_capture after insert on public.po_dispatches for each row execute function public.capture_po_style_context();

create or replace function public.protect_po_context_history() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='DELETE' or exists(select 1 from public.po_dispatches po where po.id=old.po_id and (po.attempts>0 or po.status<>'draft')) then
    raise exception 'HISTORY_PROTECTED: PO comparison source cannot change after a send attempt';
  end if;
  return new;
end $$;
drop trigger if exists po_context_history_guard on public.po_production_contexts;
create trigger po_context_history_guard before update or delete on public.po_production_contexts for each row execute function public.protect_po_context_history();
create or replace function public.protect_po_link_history() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin raise exception 'HISTORY_PROTECTED: PO linkage audit is immutable'; end $$;
drop trigger if exists production_po_link_history_guard on public.production_po_link_audits;
create trigger production_po_link_history_guard before update or delete on public.production_po_link_audits for each row execute function public.protect_po_link_history();

do $$ begin
  if to_regprocedure('public.create_production_order_po_before_context_015(uuid,integer,uuid,jsonb,text)') is null then
    alter function public.create_production_order_po(uuid,integer,uuid,jsonb,text) rename to create_production_order_po_before_context_015;
  end if;
  if to_regprocedure('public.save_production_run_before_link_015(uuid,uuid,uuid,jsonb,integer,text)') is null then
    alter function public.save_production_run(uuid,uuid,uuid,jsonb,integer,text) rename to save_production_run_before_link_015;
  end if;
end $$;
create or replace function public.create_production_order_po(p_run_id uuid,p_expected_run_version integer,p_po_id uuid,p_data jsonb,p_reason text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare result uuid; r public.production_runs; line jsonb; mode text;
begin
  result:=public.create_production_order_po_before_context_015(p_run_id,p_expected_run_version,p_po_id,p_data,p_reason);
  select * into r from public.production_runs where id=p_run_id;
  select item into line from public.styles s cross join lateral jsonb_array_elements(s.data->'production') item where s.id=r.style_id and item->>'id'=r.line_id::text;
  select production_mode into mode from public.production_conditions where run_id=r.id;
  update public.po_production_contexts set source='run',snapshot=jsonb_build_object(
    'styleId',r.style_id,'projectId',r.project_id,'projectCode',r.project_code,'projectName',(select name from public.projects where id=r.project_id),
    'factoryId',r.factory_id_snapshot,'runId',r.id,'lineId',r.line_id,'styleCode',r.style_code_snapshot,'color',line->>'color',
    'order',r.order_quantities,'lines','[]'::jsonb,'productionMode',mode,'round',r.round,'requestedDue',p_data->>'dueDate')
    where po_id=result;
  return result;
end $$;
-- Existing links remain intact. A new linkage needs the explicit comparison RPC.
create or replace function public.save_production_run(p_id uuid,p_style_id uuid,p_line_id uuid,p_data jsonb,p_expected_version integer,p_reason text)
returns public.production_runs language plpgsql security definer set search_path=public,pg_temp as $$
declare prior public.production_runs;
begin
  perform public.production_ledger_actor();
  select * into prior from public.production_runs where id=p_id;
  if nullif(p_data->>'poId','') is not null and (prior.id is null or prior.po_id::text is distinct from p_data->>'poId') then
    raise exception 'PO_LINK_CONFIRMATION_REQUIRED: create the run first, then confirm the sent PO linkage';
  end if;
  return public.save_production_run_before_link_015(p_id,p_style_id,p_line_id,p_data,p_expected_version,p_reason);
end $$;

create or replace function public.get_production_po_links_capability() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(public.current_app_role() in ('admin','internal'),false)
$$;
create or replace function public.link_production_po(p_run_id uuid,p_po_id uuid,p_expected_run_version integer,p_expected_po_version integer,p_data jsonb,p_reason text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; r public.production_runs; s public.styles; po public.po_dispatches; context public.po_production_contexts;
  line jsonb; original_line jsonb; differs boolean; verification text; stamp timestamptz:=clock_timestamp(); sid uuid;
begin
  actor:=public.production_ledger_actor(); perform public.operations_reason(p_reason);
  select style_id into sid from public.production_runs where id=p_run_id;
  select * into s from public.styles where id=sid and deleted_at is null for update;
  select * into r from public.production_runs where id=p_run_id for update;
  if s.id is null or r.id is null or not public.can_access_style(r.style_id) then raise exception 'FORBIDDEN: inaccessible production order' using errcode='42501'; end if;
  select * into po from public.po_dispatches where id=p_po_id for update;
  if po.id is null or po.style_id<>r.style_id then raise exception 'INVALID_PO_LINK: same style required'; end if;
  if p_expected_run_version is null or p_expected_po_version is null or r.version<>p_expected_run_version or po.version<>p_expected_po_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  if r.po_id is not null or r.closed_at is not null or exists(select 1 from public.production_runs where po_id=p_po_id) then raise exception 'DUPLICATE_PO_LINK: PO or run already linked'; end if;
  if po.status<>'sent' or po.voided then raise exception 'PO_NOT_SENT'; end if;
  if s.data->>'factoryId' is distinct from r.factory_id_snapshot::text or po.factory_id_snapshot is distinct from r.factory_id_snapshot then raise exception 'ASSIGNMENT_CHANGED'; end if;
  if exists(select 1 from public.production_order_acceptances where run_id=r.id) or exists(select 1 from public.production_order_starts where run_id=r.id)
    or exists(select 1 from public.production_receipts where run_id=r.id) or exists(select 1 from public.production_conditions where run_id=r.id and (proposal_id is not null or approval_id is not null or status='rejected')) then
    raise exception 'HISTORY_PROTECTED: negotiation, production, or receipt already recorded';
  end if;
  perform public.operations_shape(p_data,array['documentConfirmed','scopeDifferenceConfirmed','sourceSnapshotMissingConfirmed','projectId','styleCode','color','factoryId','order']);
  if jsonb_typeof(p_data->'documentConfirmed') is distinct from 'boolean' or p_data->'documentConfirmed'<>'true'::jsonb
    or jsonb_typeof(p_data->'scopeDifferenceConfirmed') is distinct from 'boolean' or jsonb_typeof(p_data->'sourceSnapshotMissingConfirmed') is distinct from 'boolean' then raise exception 'PO_DOCUMENT_CONFIRMATION_REQUIRED'; end if;
  select item into line from jsonb_array_elements(s.data->'production') item where item->>'id'=r.line_id::text;
  perform public.operations_quantities(p_data->'order');
  if p_data->>'projectId' is distinct from r.project_id::text or p_data->>'styleCode' is distinct from r.style_code_snapshot or p_data->>'color' is distinct from line->>'color'
    or p_data->>'factoryId' is distinct from r.factory_id_snapshot::text or p_data->'order' is distinct from r.order_quantities or public.production_quantity_total(r.order_quantities)=0 then raise exception 'INVALID_PO_LINK: confirmed project, full SKU, color, factory or order differs'; end if;
  select * into context from public.po_production_contexts where po_id=po.id;
  differs:=line->'order' is distinct from r.order_quantities;
  if context.po_id is null then
    if p_data->'sourceSnapshotMissingConfirmed'<>'true'::jsonb then raise exception 'LEGACY_PO_DOCUMENT_CONFIRMATION_REQUIRED'; end if;
    verification:='legacy_document_confirmed';
  else
    if context.snapshot->>'styleId' is distinct from r.style_id::text or context.snapshot->>'projectId' is distinct from r.project_id::text or context.snapshot->>'factoryId' is distinct from r.factory_id_snapshot::text
      or coalesce(context.snapshot->>'projectCode','')<>'' and context.snapshot->>'projectCode' is distinct from r.project_code then raise exception 'INVALID_PO_LINK: captured project or factory differs'; end if;
    if context.source='run' then
      if context.snapshot->>'runId' is distinct from r.id::text or context.snapshot->>'lineId' is distinct from r.line_id::text or context.snapshot->>'styleCode' is distinct from r.style_code_snapshot
        or context.snapshot->>'color' is distinct from line->>'color' or context.snapshot->'order' is distinct from r.order_quantities then raise exception 'INVALID_PO_LINK: captured production run differs'; end if;
      verification:='captured_run';
    else
      select item into original_line from jsonb_array_elements(context.snapshot->'lines') item where item->>'lineId'=r.line_id::text and item->>'styleCode'=r.style_code_snapshot and item->>'color'=line->>'color';
      if original_line is null then raise exception 'INVALID_PO_LINK: captured color SKU missing'; end if;
      differs:=differs or original_line->'order' is distinct from r.order_quantities;
      verification:='captured_style_confirmed';
    end if;
  end if;
  if differs and p_data->'scopeDifferenceConfirmed'<>'true'::jsonb then raise exception 'ORDER_SCOPE_CONFIRMATION_REQUIRED'; end if;
  update public.production_runs set po_id=po.id,version=version+1,updated_at=stamp,updated_by=actor.id where id=r.id;
  insert into public.production_po_link_audits(run_id,po_id,style_id,actor_id,actor_name,reason,verification,source_snapshot,confirmed_snapshot,po_snapshot,created_at)
    values(r.id,po.id,r.style_id,actor.id,actor.name,trim(p_reason),verification,context.snapshot,p_data,public.supplier_order_po_snapshot(po),stamp);
  insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after,created_at)
    values(r.style_id,actor.id,actor.name,'생산 차수 PO 확인 연결',trim(p_reason),null,jsonb_build_object('runId',r.id,'poId',po.id,'verification',verification),stamp);
end $$;

alter table public.po_production_contexts enable row level security;
alter table public.production_po_link_audits enable row level security;
drop policy if exists po_production_contexts_hq_read on public.po_production_contexts;
create policy po_production_contexts_hq_read on public.po_production_contexts for select to authenticated using(public.current_app_role() in ('admin','internal') and public.can_access_style(style_id));
drop policy if exists production_po_links_hq_read on public.production_po_link_audits;
create policy production_po_links_hq_read on public.production_po_link_audits for select to authenticated using(public.current_app_role() in ('admin','internal') and public.can_access_style(style_id));
revoke all on public.po_production_contexts,public.production_po_link_audits from public,anon,authenticated,service_role;
grant select on public.po_production_contexts,public.production_po_link_audits to authenticated;
revoke execute on function public.capture_po_style_context(),public.protect_po_context_history(),public.protect_po_link_history(),public.create_production_order_po_before_context_015(uuid,integer,uuid,jsonb,text),public.save_production_run_before_link_015(uuid,uuid,uuid,jsonb,integer,text) from public,anon,authenticated,service_role;
revoke execute on function public.get_production_po_links_capability(),public.link_production_po(uuid,uuid,integer,integer,jsonb,text),public.create_production_order_po(uuid,integer,uuid,jsonb,text),public.save_production_run(uuid,uuid,uuid,jsonb,integer,text) from public,anon,service_role;
grant execute on function public.get_production_po_links_capability(),public.link_production_po(uuid,uuid,integer,integer,jsonb,text),public.create_production_order_po(uuid,integer,uuid,jsonb,text),public.save_production_run(uuid,uuid,uuid,jsonb,integer,text) to authenticated;
notify pgrst,'reload schema';
commit;
