-- Recover only an archived, never-attempted draft link after HQ reviews the
-- replacement sent document. This migration never sends or changes a PO.
begin;

create table if not exists public.production_po_recovery_audits (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.production_runs(id) on delete restrict,
  style_id uuid not null references public.styles(id) on delete restrict,
  previous_po_id uuid not null unique references public.po_dispatches(id) on delete restrict,
  po_id uuid not null unique references public.po_dispatches(id) on delete restrict,
  actor_id uuid not null references public.profiles(id), actor_name text not null,
  reason text not null, run_before jsonb not null,
  previous_po_snapshot jsonb not null, po_snapshot jsonb not null,
  confirmed_snapshot jsonb not null, created_at timestamptz not null default clock_timestamp(),
  check(previous_po_id<>po_id)
);
drop trigger if exists production_po_recovery_history_guard on public.production_po_recovery_audits;
create trigger production_po_recovery_history_guard before update or delete on public.production_po_recovery_audits
  for each row execute function public.protect_po_link_history();

create or replace function public.get_archived_production_po_recovery_capability()
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(public.current_app_role() in ('admin','internal'),false)
$$;

create or replace function public.replace_archived_production_po_link(
  p_run_id uuid,p_previous_po_id uuid,p_po_id uuid,p_expected_run_version integer,
  p_expected_previous_po_version integer,p_expected_po_version integer,p_data jsonb,p_reason text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; r public.production_runs; s public.styles;
  previous_po public.po_dispatches; po public.po_dispatches; sid uuid; stamp timestamptz:=clock_timestamp();
begin
  actor:=public.production_ledger_actor(); perform public.operations_reason(p_reason);
  select style_id into sid from public.production_runs where id=p_run_id;
  select * into s from public.styles where id=sid and deleted_at is null for update;
  select * into r from public.production_runs where id=p_run_id for update;
  if s.id is null or r.id is null or not public.can_access_style(r.style_id) then
    raise exception 'FORBIDDEN: inaccessible production order' using errcode='42501';
  end if;
  if p_previous_po_id is null or p_po_id is null or p_previous_po_id=p_po_id
    or r.po_id is distinct from p_previous_po_id then
    raise exception 'ARCHIVED_PO_LINK_CHANGED: reload the current production PO link';
  end if;
  -- Both PO rows use a deterministic lock order; the old draft cannot be
  -- restored or dispatched between the eligibility check and replacement.
  perform id from public.po_dispatches where id in (p_previous_po_id,p_po_id) order by id for update;
  select * into previous_po from public.po_dispatches where id=p_previous_po_id;
  select * into po from public.po_dispatches where id=p_po_id;
  if previous_po.id is null or po.id is null or previous_po.style_id<>r.style_id or po.style_id<>r.style_id then
    raise exception 'INVALID_PO_LINK: same style required';
  end if;
  if p_expected_run_version is null or p_expected_previous_po_version is null or p_expected_po_version is null
    or r.version<>p_expected_run_version or previous_po.version<>p_expected_previous_po_version or po.version<>p_expected_po_version then
    raise exception 'VERSION_CONFLICT' using errcode='40001';
  end if;
  if not previous_po.voided or previous_po.status<>'draft' or previous_po.attempts<>0
    or previous_po.sent_at is not null or previous_po.provider_message_id is not null or previous_po.provider_request_id is not null
    or previous_po.sender_email_snapshot is not null or previous_po.last_error is not null
    or exists(select 1 from public.po_dispatch_attempts where dispatch_id=previous_po.id)
    or exists(select 1 from public.production_po_link_audits where po_id=previous_po.id)
    or exists(select 1 from public.production_po_recovery_audits where previous_po_id=previous_po.id) then
    raise exception 'ARCHIVED_UNUSED_PO_REQUIRED: only an archived draft with no dispatch history can be replaced';
  end if;
  if previous_po.factory_id_snapshot is distinct from r.factory_id_snapshot
    or s.data->>'factoryId' is distinct from r.factory_id_snapshot::text then raise exception 'ASSIGNMENT_CHANGED'; end if;
  if r.closed_at is not null
    or exists(select 1 from public.production_runs where po_id=previous_po.id and id<>r.id)
    or exists(select 1 from public.production_order_acceptances where run_id=r.id)
    or exists(select 1 from public.production_order_starts where run_id=r.id)
    or exists(select 1 from public.production_receipts where run_id=r.id)
    or exists(select 1 from public.production_condition_proposals where run_id=r.id)
    or exists(select 1 from public.production_condition_approvals where run_id=r.id)
    or exists(select 1 from public.production_condition_legacy_starts where run_id=r.id)
    or exists(select 1 from public.production_condition_changes where run_id=r.id)
    or exists(select 1 from public.production_condition_change_links where replacement_run_id=r.id)
    or exists(select 1 from public.production_conditions where run_id=r.id and
      (proposal_id is not null or approval_id is not null or status<>'awaiting_supplier')) then
    raise exception 'HISTORY_PROTECTED: negotiation, production, receipt, or prior change already recorded';
  end if;
  -- Reuse every 015 document, source scope, assignment and quantity check.
  -- Any later error rolls back this temporary clear and all generated audits.
  update public.production_runs set po_id=null where id=r.id;
  perform public.link_production_po(r.id,po.id,p_expected_run_version,p_expected_po_version,p_data,p_reason);
  insert into public.production_po_recovery_audits(
    run_id,style_id,previous_po_id,po_id,actor_id,actor_name,reason,run_before,
    previous_po_snapshot,po_snapshot,confirmed_snapshot,created_at)
    values(r.id,r.style_id,previous_po.id,po.id,actor.id,actor.name,trim(p_reason),to_jsonb(r),
      to_jsonb(previous_po),to_jsonb(po),p_data,stamp);
  insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after,created_at)
    values(r.style_id,actor.id,actor.name,'보관된 미발송 PO 연결 교체',trim(p_reason),
      jsonb_build_object('runId',r.id,'poId',previous_po.id,'poVersion',previous_po.version,'runVersion',r.version),
      jsonb_build_object('runId',r.id,'poId',po.id,'poVersion',po.version,'runVersion',r.version+1),stamp);
end $$;

alter table public.production_po_recovery_audits enable row level security;
drop policy if exists production_po_recovery_hq_read on public.production_po_recovery_audits;
create policy production_po_recovery_hq_read on public.production_po_recovery_audits for select to authenticated
  using(public.current_app_role() in ('admin','internal') and public.can_access_style(style_id));
revoke all on public.production_po_recovery_audits from public,anon,authenticated,service_role;
grant select on public.production_po_recovery_audits to authenticated;
revoke execute on function public.get_archived_production_po_recovery_capability(),
  public.replace_archived_production_po_link(uuid,uuid,uuid,integer,integer,integer,jsonb,text) from public,anon,service_role;
grant execute on function public.get_archived_production_po_recovery_capability(),
  public.replace_archived_production_po_link(uuid,uuid,uuid,integer,integer,integer,jsonb,text) to authenticated;
notify pgrst,'reload schema';
commit;
