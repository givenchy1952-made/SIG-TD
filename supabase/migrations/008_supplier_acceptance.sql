-- Apply once after 007_production_ledger.sql.
-- Supplier consent is a distinct, append-only record. Financial ledger tables
-- remain headquarters-only; the supplier RPC deliberately returns no prices.
begin;

create table public.production_order_acceptances (
 id uuid primary key default gen_random_uuid(),run_id uuid not null unique references public.production_runs(id) on delete restrict,
 factory_id uuid not null references public.factories(id),actor_id uuid not null references public.profiles(id),actor_name text not null,actor_email text not null,
 expected_delivery_date date not null,accepted_at timestamptz not null default clock_timestamp(),
 run_version_snapshot integer not null,po_id uuid not null references public.po_dispatches(id),po_version integer not null,
 po_snapshot jsonb not null,terms_snapshot jsonb not null
);
create table public.production_order_starts (
 run_id uuid primary key references public.production_runs(id) on delete restrict,
 acceptance_id uuid not null unique references public.production_order_acceptances(id) on delete restrict,
 started_at timestamptz not null default clock_timestamp(),started_by uuid not null references public.profiles(id),started_by_name text not null
);

create function public.get_supplier_orders_capability() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.profiles where id=auth.uid() and approved and active and (role in ('admin','internal') or role='factory' and factory_id is not null))
$$;

-- This helper is never callable by an API client.
create function public.supplier_order_terms(r public.production_runs) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('runId',r.id,'styleId',r.style_id,'lineId',r.line_id,'projectId',r.project_id,'projectCode',r.project_code,
  'projectName',(select name from public.projects where id=r.project_id),'name',r.name,'round',r.round,'order',r.order_quantities,
  'expectedDue',coalesce(r.expected_due::text,''),'factoryId',r.factory_id_snapshot,'factoryName',r.factory_name_snapshot,'styleCode',r.style_code_snapshot)
$$;
create function public.supplier_order_po_snapshot(po public.po_dispatches) returns jsonb language sql immutable set search_path=public,pg_temp as $$
 select jsonb_build_object('id',po.id,'version',po.version,'recipient',po.recipient,'subject',po.subject,'body',po.body,'dueDate',po.due_date::text,
  'sentAt',po.sent_at,'providerMessageId',po.provider_message_id,'evidenceAttachmentId',po.evidence_attachment_id,'factoryId',po.factory_id_snapshot,'styleCode',po.style_code_snapshot)
$$;

create function public.get_supplier_production_orders() returns setof jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare actor public.profiles;r record;a public.production_order_acceptances;st public.production_order_starts;po public.po_dispatches;state text;
begin
 actor:=public.operations_actor();
 if actor.role='factory' and actor.factory_id is null then return;end if;
 for r in select pr.*,s.data as current_style from public.production_runs pr join public.styles s on s.id=pr.style_id
  where s.deleted_at is null and (actor.role in ('admin','internal') or actor.role='factory' and actor.factory_id=pr.factory_id_snapshot and s.data->>'factoryId'=actor.factory_id::text)
  order by pr.created_at,pr.id
 loop
  select * into a from public.production_order_acceptances where run_id=r.id;
  select * into st from public.production_order_starts where run_id=r.id;
  select * into po from public.po_dispatches where id=r.po_id;
  state:=case when r.closed_at is not null then 'closed'
   when r.current_style->>'factoryId' is distinct from r.factory_id_snapshot::text then 'assignment_changed'
   when po.id is null or po.status<>'sent' or po.voided or po.factory_id_snapshot<>r.factory_id_snapshot then 'awaiting_po'
   when a.id is null then 'awaiting_acceptance' when st.run_id is null then 'accepted' else 'in_progress' end;
  return next jsonb_build_object('runId',r.id,'styleId',r.style_id,'lineId',r.line_id,'projectId',r.project_id,'projectCode',r.project_code,
   'projectName',(select name from public.projects where id=r.project_id),'name',r.name,'round',r.round,'order',r.order_quantities,
   'expectedDue',coalesce(r.expected_due::text,''),'factoryId',r.factory_id_snapshot,'factoryName',r.factory_name_snapshot,'styleCode',r.style_code_snapshot,
   'runVersion',r.version,'poId',r.po_id,'poVersion',po.version,'poStatus',po.status,'requestedDue',case when actor.role in ('admin','internal') or po.status='sent' then coalesce(po.due_date::text,'') else '' end,
   'subject',case when actor.role in ('admin','internal') or po.status='sent' then coalesce(po.subject,'') else '' end,
   'body',case when actor.role in ('admin','internal') or po.status='sent' then coalesce(po.body,'') else '' end,'sentAt',po.sent_at,'status',state,
   'acceptance',case when a.id is null then null else jsonb_build_object('id',a.id,'expectedDeliveryDate',a.expected_delivery_date::text,'acceptedAt',a.accepted_at,
    'actorId',a.actor_id,'actorName',a.actor_name,'actorEmail',a.actor_email,'factoryId',a.factory_id,'runVersion',a.run_version_snapshot,'poVersion',a.po_version,'poSnapshot',a.po_snapshot,'termsSnapshot',a.terms_snapshot) end,
   'startedAt',st.started_at,'startedBy',st.started_by,'startedByName',st.started_by_name);
 end loop;
end $$;

-- A single transaction creates the reviewed draft and links the correct run.
-- Mail delivery remains the existing explicit send-po-email action.
create function public.create_production_order_po(p_run_id uuid,p_expected_run_version integer,p_po_id uuid,p_data jsonb,p_reason text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;r public.production_runs;s public.styles;po public.po_dispatches;sid uuid;stamp timestamptz:=clock_timestamp();
begin
 actor:=public.production_ledger_actor();perform public.operations_reason(p_reason);
 select style_id into sid from public.production_runs where id=p_run_id;
 select * into s from public.styles where id=sid and deleted_at is null for update;
 select * into r from public.production_runs where id=p_run_id for update;
 if s.id is null or r.id is null or not public.can_access_style(r.style_id) then raise exception 'FORBIDDEN: inaccessible production order' using errcode='42501';end if;
 if p_expected_run_version is null or r.version<>p_expected_run_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if r.closed_at is not null or r.po_id is not null or exists(select 1 from public.production_order_acceptances where run_id=r.id) then raise exception 'HISTORY_PROTECTED: PO already linked or run already closed';end if;
 if s.data->>'factoryId' is distinct from r.factory_id_snapshot::text then raise exception 'ASSIGNMENT_CHANGED: create an order for the newly assigned factory';end if;
 if p_po_id is null or exists(select 1 from public.po_dispatches where id=p_po_id) then raise exception 'INVALID_PO: new PO identifier required';end if;
 if public.production_quantity_total(r.order_quantities)=0 then raise exception 'INVALID_ORDER: positive order quantity required';end if;
 po:=public.save_po_dispatch(p_po_id,r.style_id,0,p_data,p_reason);
 update public.production_runs set po_id=po.id,expected_due=po.due_date,version=version+1,updated_at=stamp,updated_by=actor.id where id=r.id;
 insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after)
 values(r.style_id,actor.id,actor.name,'생산 차수 PO 연결',trim(p_reason),null,jsonb_build_object('runId',r.id,'poId',po.id));
 return po.id;
end $$;

create function public.accept_supplier_production_order(p_run_id uuid,p_expected_run_version integer,p_expected_po_version integer,p_expected_delivery_date text,p_agreed boolean)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;r public.production_runs;s public.styles;po public.po_dispatches;result public.production_order_acceptances;sid uuid;stamp timestamptz:=clock_timestamp();
begin
 actor:=public.operations_actor();
 if actor.role<>'factory' or actor.factory_id is null then raise exception 'FORBIDDEN: assigned supplier account must explicitly agree' using errcode='42501';end if;
 if p_agreed is distinct from true then raise exception 'AGREEMENT_REQUIRED: review the PO and explicitly agree to produce';end if;
 if p_expected_delivery_date is null or p_expected_delivery_date='' then raise exception 'INVALID_DELIVERY_DATE: expected date required';end if;
 perform public.validate_sig_date(p_expected_delivery_date);
 select style_id into sid from public.production_runs where id=p_run_id;
 select * into s from public.styles where id=sid and deleted_at is null for update;
 select * into r from public.production_runs where id=p_run_id for update;
 if s.id is null or r.id is null or actor.factory_id<>r.factory_id_snapshot or s.data->>'factoryId' is distinct from actor.factory_id::text then raise exception 'FORBIDDEN: production order is assigned to another factory' using errcode='42501';end if;
 if r.closed_at is not null then raise exception 'HISTORY_PROTECTED: production run is closed';end if;
 if p_expected_run_version is null or r.version<>p_expected_run_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 -- A sent PO is immutable; an unfinished provider result is rejected below.
 -- Avoid a PO lock after the style lock: provider finalization locks PO first.
 select * into po from public.po_dispatches where id=r.po_id;
 if po.id is null or po.status<>'sent' or po.voided or po.factory_id_snapshot<>actor.factory_id or po.style_id<>r.style_id then raise exception 'PO_NOT_SENT: sent PO for this factory required';end if;
 if p_expected_po_version is null or po.version<>p_expected_po_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if public.production_quantity_total(r.order_quantities)=0 then raise exception 'INVALID_ORDER: positive order quantity required';end if;
 if exists(select 1 from public.production_order_acceptances where run_id=r.id) then raise exception 'HISTORY_PROTECTED: acceptance is already recorded; create a new run for changed terms';end if;
 insert into public.production_order_acceptances(run_id,factory_id,actor_id,actor_name,actor_email,expected_delivery_date,accepted_at,run_version_snapshot,po_id,po_version,po_snapshot,terms_snapshot)
 values(r.id,actor.factory_id,actor.id,actor.name,actor.email,p_expected_delivery_date::date,stamp,r.version,po.id,po.version,public.supplier_order_po_snapshot(po),public.supplier_order_terms(r)) returning * into result;
 insert into public.production_order_starts(run_id,acceptance_id,started_at,started_by,started_by_name) values(r.id,result.id,stamp,actor.id,actor.name);
 update public.production_runs set version=version+1,updated_at=stamp,updated_by=actor.id where id=r.id;
 insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after)
 values(r.style_id,actor.id,actor.name,'업체 생산 동의','업체가 발송된 PO를 확인하고 예상 납기일과 생산 동의를 제출',null,jsonb_build_object('runId',r.id,'acceptanceId',result.id,'expectedDeliveryDate',result.expected_delivery_date,'acceptedAt',stamp));
 return result.id;
end $$;

create function public.start_supplier_production_run(p_run_id uuid,p_expected_run_version integer)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;r public.production_runs;s public.styles;po public.po_dispatches;a public.production_order_acceptances;sid uuid;stamp timestamptz:=clock_timestamp();
begin
 actor:=public.production_ledger_actor();
 select style_id into sid from public.production_runs where id=p_run_id;
 select * into s from public.styles where id=sid and deleted_at is null for update;
 select * into r from public.production_runs where id=p_run_id for update;
 if s.id is null or r.id is null or not public.can_access_style(r.style_id) then raise exception 'FORBIDDEN: inaccessible production order' using errcode='42501';end if;
 if p_expected_run_version is null or r.version<>p_expected_run_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if r.closed_at is not null then raise exception 'HISTORY_PROTECTED: production run is closed';end if;
 if s.data->>'factoryId' is distinct from r.factory_id_snapshot::text then raise exception 'ASSIGNMENT_CHANGED: create an order for the newly assigned factory';end if;
 select * into a from public.production_order_acceptances where run_id=r.id;
 select * into po from public.po_dispatches where id=r.po_id;
 if a.id is null or po.id is null or po.status<>'sent' or po.voided or a.po_id<>po.id or a.po_version<>po.version then raise exception 'SUPPLIER_ACCEPTANCE_REQUIRED: supplier must agree to the sent PO first';end if;
 if exists(select 1 from public.production_order_starts where run_id=r.id) then raise exception 'HISTORY_PROTECTED: production has already started';end if;
 insert into public.production_order_starts(run_id,acceptance_id,started_at,started_by,started_by_name) values(r.id,a.id,stamp,actor.id,actor.name);
 update public.production_runs set version=version+1,updated_at=stamp,updated_by=actor.id where id=r.id;
 insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after)
 values(r.style_id,actor.id,actor.name,'차수 생산 시작','업체의 PO 확인·예상 납기·생산 동의 후 생산 시작',null,jsonb_build_object('runId',r.id,'acceptanceId',a.id,'startedAt',stamp));
end $$;

-- Accepted manufacturing terms cannot be edited retroactively. Receipt/version/
-- price/settlement updates do not change the supplier's original agreement.
create function public.protect_accepted_production_terms() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if (exists(select 1 from public.production_order_acceptances where run_id=old.id) or
  exists(select 1 from public.po_dispatches where id=old.po_id and (attempts>0 or status<>'draft'))) and
  (new.project_id is distinct from old.project_id or new.project_code is distinct from old.project_code or new.po_id is distinct from old.po_id or
   new.order_quantities is distinct from old.order_quantities or new.expected_due is distinct from old.expected_due or
   new.style_id is distinct from old.style_id or new.line_id is distinct from old.line_id or new.round is distinct from old.round or
   new.factory_id_snapshot is distinct from old.factory_id_snapshot or new.style_code_snapshot is distinct from old.style_code_snapshot)
 then raise exception 'HISTORY_PROTECTED: attempted PO project, quantity and delivery terms are immutable; create a new production run';end if;
 return new;
end $$;
create trigger production_runs_agreed_terms before update on public.production_runs for each row execute function public.protect_accepted_production_terms();

create function public.require_started_production_order() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare rid uuid;sid uuid;factory uuid;style_exists boolean;po public.po_dispatches;a public.production_order_acceptances;
begin
 if tg_table_name='production_runs' then
  if new.closed_at is not distinct from old.closed_at then return new;end if;
 end if;
 if tg_table_name='production_runs' then rid:=new.id;else rid:=new.run_id;end if;
 select style_id,factory_id_snapshot into sid,factory from public.production_runs where id=rid;
 -- Financial recording belongs to HQ and to the immutable original order.
 -- A later project can use a different factory on the parent style without
 -- preventing HQ from booking the earlier factory's accepted production.
 select exists(select 1 from public.styles where id=sid and deleted_at is null) into style_exists;
 select * into a from public.production_order_acceptances where run_id=rid;
 select pd.* into po from public.po_dispatches pd join public.production_runs pr on pr.po_id=pd.id where pr.id=rid;
 if coalesce(public.current_app_role(),'') not in ('admin','internal') or not style_exists or a.id is null or a.factory_id is distinct from factory or po.id is null or po.status<>'sent' or po.voided or po.factory_id_snapshot is distinct from factory or po.id<>a.po_id or po.version<>a.po_version or not exists(select 1 from public.production_order_starts where run_id=rid and acceptance_id=a.id)
 then raise exception 'PRODUCTION_NOT_STARTED: sent PO, supplier agreement and production start are required';end if;
 return new;
end $$;
create trigger production_receipts_require_start before insert on public.production_receipts for each row execute function public.require_started_production_order();
create trigger production_run_close_require_start before update of closed_at on public.production_runs for each row execute function public.require_started_production_order();

-- Factory accounts can read dispatched PO contents, never unreviewed drafts or a
-- PO retained from a previously assigned factory. Attempt visibility inherits this RLS.
drop policy po_dispatches_read on public.po_dispatches;
create policy po_dispatches_read on public.po_dispatches for select to authenticated using(
 public.can_access_style(style_id) and (public.current_app_role() in ('admin','internal') or
 status='sent' and factory_id_snapshot=(select factory_id from public.profiles where id=auth.uid()))
);

-- Historical PO audit snapshots can contain unreviewed drafts. Keep them for HQ;
-- suppliers read sent PO contents through the scoped PO table and consent RPC.
drop policy audits_read on public.audits;
create policy audits_read on public.audits for select to authenticated using(
 public.current_app_role()='admin' or (style_id is not null and public.can_access_style(style_id) and
 (public.current_app_role()='internal' or action not like 'PO %'))
);

alter table public.production_order_acceptances enable row level security;
alter table public.production_order_starts enable row level security;
-- No table access: even SELECT uses the narrow RPC, including current assignment checks.
revoke all on public.production_order_acceptances,public.production_order_starts from public,anon,authenticated;
revoke execute on function public.supplier_order_terms(public.production_runs),public.supplier_order_po_snapshot(public.po_dispatches),public.protect_accepted_production_terms(),public.require_started_production_order() from public,anon,authenticated;
revoke execute on function public.get_supplier_orders_capability(),public.get_supplier_production_orders(),public.create_production_order_po(uuid,integer,uuid,jsonb,text),public.accept_supplier_production_order(uuid,integer,integer,text,boolean),public.start_supplier_production_run(uuid,integer) from public,anon;
grant execute on function public.get_supplier_orders_capability(),public.get_supplier_production_orders(),public.create_production_order_po(uuid,integer,uuid,jsonb,text),public.accept_supplier_production_order(uuid,integer,integer,text,boolean),public.start_supplier_production_run(uuid,integer) to authenticated;
commit;
