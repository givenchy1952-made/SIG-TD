-- Production conditions are proposals until an authorized HQ account approves.
-- Apply after 013. Existing starts/receipts/closed snapshots are never repriced.
begin;

create table if not exists public.production_condition_legacy_cutover (
 singleton boolean primary key default true check(singleton), cutover_at timestamptz not null default clock_timestamp()
);
create table if not exists public.production_condition_legacy_starts (
 run_id uuid primary key references public.production_runs(id) on delete restrict,
 start_snapshot jsonb not null, acceptance_snapshot jsonb not null,
 recorded_at timestamptz not null default clock_timestamp()
);
-- A one-time marker is essential: rerunning this migration must not turn new
-- HQ approvals into legacy exemptions.
do $$ begin
 insert into public.production_condition_legacy_cutover(singleton) values(true) on conflict do nothing;
 if found then
  insert into public.production_condition_legacy_starts(run_id,start_snapshot,acceptance_snapshot)
   select st.run_id,to_jsonb(st),to_jsonb(a) from public.production_order_starts st
    join public.production_order_acceptances a on a.id=st.acceptance_id;
 end if;
end $$;

create table if not exists public.production_conditions (
 run_id uuid primary key references public.production_runs(id) on delete restrict,
 version integer not null default 0 check(version>=0),
 production_mode text check(production_mode in ('full_package','cmt')),
 internal_unit_cost numeric check(internal_unit_cost is null or (internal_unit_cost>=0 and internal_unit_cost<=1000000000 and internal_unit_cost=round(internal_unit_cost,2))),
 status text not null default 'awaiting_supplier' check(status in ('awaiting_supplier','awaiting_approval','revision_requested','approved','rejected')),
 proposal_id uuid, approval_id uuid,
 updated_at timestamptz not null default clock_timestamp(), updated_by uuid references public.profiles(id)
);
create table if not exists public.production_condition_proposals (
 id uuid primary key default gen_random_uuid(), run_id uuid not null references public.production_runs(id) on delete restrict,
 expected_delivery_date date not null, unit_cost numeric not null,
 can_produce boolean not null, quantity_confirmed boolean not null, agreed boolean not null check(agreed),
 confirmed_quantities jsonb not null, comment text not null, delay_reason text not null, price_reason text not null,
 actor_id uuid not null references public.profiles(id), actor_name text not null, factory_id uuid not null references public.factories(id),
 submitted_at timestamptz not null default clock_timestamp(),
 run_version integer not null, po_id uuid not null references public.po_dispatches(id), po_version integer not null,
 terms_snapshot jsonb not null, po_snapshot jsonb not null,
 check(unit_cost>=0 and unit_cost<=1000000000 and unit_cost=round(unit_cost,2))
);
create table if not exists public.production_condition_approvals (
 id uuid primary key default gen_random_uuid(),run_id uuid not null unique references public.production_runs(id) on delete restrict,
 proposal_id uuid not null references public.production_condition_proposals(id),
 final_delivery_date date not null, unit_cost numeric not null,
 approved_by uuid not null references public.profiles(id), approved_by_name text not null,
 approved_at timestamptz not null default clock_timestamp(),reason text not null,
 terms_snapshot jsonb not null, po_snapshot jsonb not null,
 check(unit_cost>=0 and unit_cost<=1000000000 and unit_cost=round(unit_cost,2))
);
create table if not exists public.production_condition_events (
 id uuid primary key default gen_random_uuid(),run_id uuid not null references public.production_runs(id) on delete restrict,
 action text not null,actor_id uuid not null references public.profiles(id),actor_name text not null,
 created_at timestamptz not null default clock_timestamp(),reason text not null,before jsonb,after jsonb,shared boolean not null default true
);
create index if not exists production_condition_events_run_idx on public.production_condition_events(run_id,created_at,id);
create table if not exists public.production_condition_changes (
 id uuid primary key default gen_random_uuid(),run_id uuid not null references public.production_runs(id) on delete restrict,
 approval_id uuid references public.production_condition_approvals(id),legacy boolean not null,
 reason text not null,actor_id uuid not null references public.profiles(id),actor_name text not null,
 requested_at timestamptz not null default clock_timestamp(),terms_snapshot jsonb not null
);
create table if not exists public.production_condition_change_links (
 request_id uuid primary key references public.production_condition_changes(id) on delete restrict,
 replacement_run_id uuid not null unique references public.production_runs(id) on delete restrict,
 actor_id uuid not null references public.profiles(id),actor_name text not null,reason text not null,
 confirmed_new_scope boolean not null check(confirmed_new_scope),linked_at timestamptz not null default clock_timestamp()
);

create or replace function public.production_condition_immutable() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin raise exception 'HISTORY_PROTECTED: production condition history is immutable';end $$;
do $$ declare t text;begin
 foreach t in array array['production_condition_legacy_cutover','production_condition_legacy_starts','production_condition_proposals','production_condition_approvals','production_condition_events','production_condition_changes','production_condition_change_links'] loop
  execute format('drop trigger if exists production_condition_history_guard on public.%I',t);
  execute format('create trigger production_condition_history_guard before update or delete on public.%I for each row execute function public.production_condition_immutable()',t);
 end loop;
end $$;

create or replace function public.production_condition_cost(p_value jsonb,p_required boolean default false) returns numeric language plpgsql immutable set search_path=public,pg_temp as $$
declare cost numeric;begin
 if p_value is null or p_value='null'::jsonb then
  if p_required then raise exception 'INVALID_PRODUCTION_CONDITIONS: unit cost required';end if;
  return null;
 end if;
 if jsonb_typeof(p_value) is distinct from 'number' then raise exception 'INVALID_PRODUCTION_CONDITIONS: numeric unit cost required';end if;
 cost:=(p_value#>>'{}')::numeric;
 if cost<0 or cost>1000000000 or cost<>round(cost,2) then raise exception 'INVALID_PRODUCTION_CONDITIONS: unit cost range or precision';end if;
 return cost;
end $$;

create or replace function public.lock_production_conditions_run(p_run_id uuid,p_expected_run_version integer) returns public.production_runs language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;s public.styles;r public.production_runs;sid uuid;begin
 actor:=public.operations_actor();
 select style_id into sid from public.production_runs where id=p_run_id;
 select * into s from public.styles where id=sid and deleted_at is null for update;
 select * into r from public.production_runs where id=p_run_id for update;
 if s.id is null or r.id is null or not public.can_access_style(r.style_id) or
   (actor.role='factory' and (actor.factory_id is null or actor.factory_id<>r.factory_id_snapshot or s.data->>'factoryId' is distinct from actor.factory_id::text))
 then raise exception 'FORBIDDEN: inaccessible production conditions' using errcode='42501';end if;
 if p_expected_run_version is null or r.version<>p_expected_run_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 return r;
end $$;

create or replace function public.production_condition_event(actor public.profiles,r public.production_runs,p_action text,p_reason text,p_before jsonb,p_after jsonb,p_shared boolean default true) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.production_condition_events(run_id,action,actor_id,actor_name,reason,before,after,shared)
 values(r.id,p_action,actor.id,actor.name,trim(p_reason),p_before,p_after,p_shared);
 insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after)
 values(r.style_id,actor.id,actor.name,p_action,'생산 조건 협의 기록',null,jsonb_build_object('runId',r.id));
end $$;

create or replace function public.get_production_conditions_capability() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(public.current_app_role() in ('admin','internal','factory'),false)
$$;

-- 007 stores the full color SKU in style_code_snapshot. Retain that immutable
-- value and add the exact registered line color to each new proposal snapshot.
create or replace function public.supplier_order_terms(r public.production_runs) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('runId',r.id,'styleId',r.style_id,'lineId',r.line_id,'projectId',r.project_id,'projectCode',r.project_code,
  'projectName',(select name from public.projects where id=r.project_id),'name',r.name,'round',r.round,'order',r.order_quantities,
  'expectedDue',coalesce(r.expected_due::text,''),'itemType',r.item_type,'factoryId',r.factory_id_snapshot,'factoryName',r.factory_name_snapshot,
  'styleCode',r.style_code_snapshot,'fullStyleCode',r.style_code_snapshot,
  'color',(select line->>'color' from public.styles s cross join lateral jsonb_array_elements(s.data->'production') line where s.id=r.style_id and line->>'id'=r.line_id::text))
$$;

create or replace function public.get_production_conditions() returns setof jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare actor public.profiles;r record;c public.production_conditions;p public.production_condition_proposals;a public.production_condition_approvals;po public.po_dispatches;
 state text;is_legacy boolean;doc jsonb;events jsonb;changes jsonb;link record;
begin
 actor:=public.operations_actor();
 for r in select pr.*,s.data as current_style from public.production_runs pr join public.styles s on s.id=pr.style_id
  where s.deleted_at is null and (actor.role in ('admin','internal') or actor.role='factory' and actor.factory_id=pr.factory_id_snapshot and s.data->>'factoryId'=actor.factory_id::text)
  order by pr.created_at,pr.id
 loop
  select * into c from public.production_conditions where run_id=r.id;
  select * into p from public.production_condition_proposals where id=c.proposal_id;
  select * into a from public.production_condition_approvals where id=c.approval_id;
  select * into po from public.po_dispatches where id=r.po_id;
  select exists(select 1 from public.production_condition_legacy_starts where run_id=r.id) into is_legacy;
  state:=case when r.closed_at is not null then 'closed'
   when r.current_style->>'factoryId' is distinct from r.factory_id_snapshot::text then 'assignment_changed'
   when is_legacy then 'approved'
   when po.id is null or po.status<>'sent' or po.voided or po.factory_id_snapshot<>r.factory_id_snapshot then 'awaiting_po'
   when c.status='awaiting_approval' then 'awaiting_approval' when c.status='revision_requested' then 'revision_requested'
   when c.status='approved' and a.id is not null then 'approved' when c.status='rejected' then 'rejected'
   else 'awaiting_supplier' end;
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'action',e.action,'actorId',e.actor_id,'actorName',e.actor_name,'createdAt',e.created_at,'reason',e.reason,'before',e.before,'after',e.after) order by e.created_at,e.id),'[]')
   into events from public.production_condition_events e where e.run_id=r.id and (actor.role in ('admin','internal') or e.shared);
  if po.id is not null and po.status='sent' then
   events:=jsonb_build_array(jsonb_build_object('id','po-'||po.id::text,'action','본사 PO 발송','actorId',null,'actorName','본사','createdAt',po.sent_at,'reason','메일 서비스 발송 접수','before',null,'after',jsonb_build_object('poId',po.id,'poVersion',po.version)))||events;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',ch.id,'reason',ch.reason,'actorId',ch.actor_id,'actorName',ch.actor_name,'requestedAt',ch.requested_at,'correctingRunId',cl.replacement_run_id) order by ch.requested_at,ch.id),'[]')
   into changes from public.production_condition_changes ch left join public.production_condition_change_links cl on cl.request_id=ch.id where ch.run_id=r.id;
  select cl.request_id,ch.run_id as prior_run_id into link from public.production_condition_change_links cl join public.production_condition_changes ch on ch.id=cl.request_id where cl.replacement_run_id=r.id;
  doc:=jsonb_build_object('runId',r.id,'runVersion',r.version,'poVersion',po.version,'version',coalesce(c.version,0),'productionMode',c.production_mode,'status',state,'legacy',is_legacy,
   'proposal',case when p.id is null then null else jsonb_build_object('id',p.id,'expectedDeliveryDate',p.expected_delivery_date::text,'unitCost',p.unit_cost,'canProduce',p.can_produce,'quantityConfirmed',p.quantity_confirmed,'agreed',p.agreed,'comment',p.comment,'delayReason',p.delay_reason,'priceReason',p.price_reason,'confirmedQuantities',p.confirmed_quantities,'actorId',p.actor_id,'actorName',p.actor_name,'submittedAt',p.submitted_at,'termsSnapshot',p.terms_snapshot,'poSnapshot',p.po_snapshot) end,
   'approval',case when a.id is null then null else jsonb_build_object('id',a.id,'finalDeliveryDate',a.final_delivery_date::text,'unitCost',a.unit_cost,'approvedBy',a.approved_by,'approvedByName',a.approved_by_name,'approvedAt',a.approved_at,'termsSnapshot',a.terms_snapshot,'poSnapshot',a.po_snapshot) end,
   'timeline',events,'changeRequests',changes,'changeRequestId',link.request_id,'priorRunId',link.prior_run_id);
  if actor.role in ('admin','internal') then doc:=doc||jsonb_build_object('internalUnitCost',c.internal_unit_cost);end if;
  return next doc;
 end loop;
end $$;

create or replace function public.configure_production_conditions(p_run_id uuid,p_expected_run_version integer,p_expected_version integer,p_production_mode text,p_internal_unit_cost jsonb,p_reason text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;r public.production_runs;c public.production_conditions;cost numeric;begin
 actor:=public.production_ledger_actor();perform public.operations_reason(p_reason);
 r:=public.lock_production_conditions_run(p_run_id,p_expected_run_version);
 if r.closed_at is not null or exists(select 1 from public.production_condition_legacy_starts where run_id=r.id) then raise exception 'HISTORY_PROTECTED: existing production terms cannot be reconfigured';end if;
 if (select data->>'factoryId' from public.styles where id=r.style_id) is distinct from r.factory_id_snapshot::text then raise exception 'ASSIGNMENT_CHANGED';end if;
 if p_production_mode is null or p_production_mode not in ('full_package','cmt') then raise exception 'INVALID_PRODUCTION_CONDITIONS: production mode required';end if;
 cost:=public.production_condition_cost(p_internal_unit_cost,false);
 select * into c from public.production_conditions where run_id=r.id for update;
 if p_expected_version is null or coalesce(c.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if c.approval_id is not null or c.status='rejected' or (c.proposal_id is not null and c.production_mode is distinct from p_production_mode) then raise exception 'HISTORY_PROTECTED: agreed production mode is immutable';end if;
 if c.production_mode is not null and c.production_mode is distinct from p_production_mode and exists(select 1 from public.po_dispatches where id=r.po_id and (attempts>0 or status<>'draft')) then raise exception 'HISTORY_PROTECTED: the dispatched PO production mode is immutable';end if;
 insert into public.production_conditions(run_id,version,production_mode,internal_unit_cost,updated_by)
 values(r.id,1,p_production_mode,cost,actor.id)
 on conflict(run_id) do update set version=production_conditions.version+1,production_mode=excluded.production_mode,internal_unit_cost=excluded.internal_unit_cost,updated_at=clock_timestamp(),updated_by=actor.id;
 update public.production_runs set version=version+1,updated_at=clock_timestamp(),updated_by=actor.id where id=r.id;
 perform public.production_condition_event(actor,r,'본사 생산 방식·검토 단가 설정',p_reason,case when c.run_id is null then null else jsonb_build_object('productionMode',c.production_mode,'internalUnitCost',c.internal_unit_cost) end,jsonb_build_object('productionMode',p_production_mode,'internalUnitCost',cost),false);
end $$;

create or replace function public.submit_production_conditions(p_run_id uuid,p_expected_run_version integer,p_expected_po_version integer,p_expected_version integer,p_data jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;r public.production_runs;c public.production_conditions;po public.po_dispatches;p public.production_condition_proposals;cost numeric;key text;prior jsonb;
begin
 actor:=public.operations_actor();if actor.role<>'factory' or actor.factory_id is null then raise exception 'FORBIDDEN: assigned supplier reply required' using errcode='42501';end if;
 r:=public.lock_production_conditions_run(p_run_id,p_expected_run_version);
 if r.closed_at is not null or exists(select 1 from public.production_condition_legacy_starts where run_id=r.id) then raise exception 'HISTORY_PROTECTED: production already approved';end if;
 select * into c from public.production_conditions where run_id=r.id for update;
 if p_expected_version is null or coalesce(c.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if c.production_mode is null then raise exception 'PRODUCTION_MODE_REQUIRED: headquarters must configure the production mode';end if;
 if c.status not in ('awaiting_supplier','revision_requested') or c.approval_id is not null then raise exception 'HISTORY_PROTECTED: headquarters review or final approval is pending';end if;
 select * into po from public.po_dispatches where id=r.po_id;
 if po.id is null or po.status<>'sent' or po.voided or po.style_id<>r.style_id or po.factory_id_snapshot<>r.factory_id_snapshot then raise exception 'PO_NOT_SENT';end if;
 if p_expected_po_version is null or po.version<>p_expected_po_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if public.production_quantity_total(r.order_quantities)=0 then raise exception 'INVALID_ORDER: positive order required';end if;
 perform public.operations_shape(p_data,array['expectedDeliveryDate','unitCost','canProduce','quantityConfirmed','agreed','comment','delayReason','priceReason','confirmedQuantities']);
 perform public.operations_text(p_data,'expectedDeliveryDate',10,true);perform public.validate_sig_date(p_data->>'expectedDeliveryDate');
 foreach key in array array['comment','delayReason','priceReason'] loop perform public.operations_text(p_data,key,5000);end loop;
 foreach key in array array['canProduce','quantityConfirmed','agreed'] loop if jsonb_typeof(p_data->key) is distinct from 'boolean' then raise exception 'INVALID_PRODUCTION_CONDITIONS: explicit confirmations required';end if;end loop;
 if p_data->'agreed' is distinct from 'true'::jsonb then raise exception 'AGREEMENT_REQUIRED';end if;
 perform public.operations_quantities(p_data->'confirmedQuantities');
 if p_data->'quantityConfirmed'='true'::jsonb and p_data->'confirmedQuantities' is distinct from r.order_quantities then raise exception 'QUANTITY_CONFIRMATION_MISMATCH: review the exact PO sizes';end if;
 cost:=public.production_condition_cost(p_data->'unitCost',true);
 if cost*public.production_quantity_total(r.order_quantities)>1000000000000 then raise exception 'INVALID_PRODUCTION_CONDITIONS: amount exceeds one trillion';end if;
 if c.proposal_id is not null then select jsonb_build_object('expectedDeliveryDate',expected_delivery_date::text,'unitCost',unit_cost,'confirmedQuantities',confirmed_quantities) into prior from public.production_condition_proposals where id=c.proposal_id;end if;
 insert into public.production_condition_proposals(run_id,expected_delivery_date,unit_cost,can_produce,quantity_confirmed,agreed,confirmed_quantities,comment,delay_reason,price_reason,actor_id,actor_name,factory_id,run_version,po_id,po_version,terms_snapshot,po_snapshot)
 values(r.id,(p_data->>'expectedDeliveryDate')::date,cost,(p_data->>'canProduce')::boolean,(p_data->>'quantityConfirmed')::boolean,true,p_data->'confirmedQuantities',p_data->>'comment',p_data->>'delayReason',p_data->>'priceReason',actor.id,actor.name,actor.factory_id,r.version,po.id,po.version,public.supplier_order_terms(r)||jsonb_build_object('productionMode',c.production_mode),public.supplier_order_po_snapshot(po)) returning * into p;
 update public.production_conditions set proposal_id=p.id,status='awaiting_approval',version=version+1,updated_at=clock_timestamp(),updated_by=actor.id where run_id=r.id;
 update public.production_runs set version=version+1,updated_at=clock_timestamp(),updated_by=actor.id where id=r.id;
 perform public.production_condition_event(actor,r,case when prior is null then '업체 생산 조건 최초 제출' else '업체 수정 조건 재제출' end,'업체 생산 조건 회신',prior,jsonb_build_object('expectedDeliveryDate',p.expected_delivery_date::text,'unitCost',p.unit_cost,'canProduce',p.can_produce,'quantityConfirmed',p.quantity_confirmed,'confirmedQuantities',p.confirmed_quantities,'comment',p.comment,'delayReason',p.delay_reason,'priceReason',p.price_reason),true);
 return p.id;
end $$;

create or replace function public.review_production_conditions(p_run_id uuid,p_expected_run_version integer,p_expected_version integer,p_decision text,p_final_delivery_date text,p_final_unit_cost jsonb,p_reason text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;r public.production_runs;c public.production_conditions;p public.production_condition_proposals;po public.po_dispatches;a public.production_condition_approvals;acceptance public.production_order_acceptances;cost numeric;terms jsonb;stamp timestamptz:=clock_timestamp();begin
 actor:=public.production_ledger_actor();perform public.operations_reason(p_reason);
 r:=public.lock_production_conditions_run(p_run_id,p_expected_run_version);
 if r.closed_at is not null or exists(select 1 from public.production_condition_legacy_starts where run_id=r.id) then raise exception 'HISTORY_PROTECTED: production already approved';end if;
 select * into c from public.production_conditions where run_id=r.id for update;
 if p_expected_version is null or coalesce(c.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if c.status is distinct from 'awaiting_approval' or c.proposal_id is null or c.approval_id is not null then raise exception 'PRODUCTION_CONDITIONS_NOT_REVIEWABLE';end if;
 if p_decision is null or p_decision not in ('approve','request_revision','reject') then raise exception 'INVALID_PRODUCTION_CONDITIONS: review decision required';end if;
 select * into p from public.production_condition_proposals where id=c.proposal_id;
 select * into po from public.po_dispatches where id=r.po_id;
 if po.id is null or po.status<>'sent' or po.voided or po.id<>p.po_id or po.version<>p.po_version or po.factory_id_snapshot<>r.factory_id_snapshot then raise exception 'PO_NOT_SENT';end if;
 if (select data->>'factoryId' from public.styles where id=r.style_id) is distinct from r.factory_id_snapshot::text then raise exception 'ASSIGNMENT_CHANGED';end if;
 if p_decision='approve' and p.terms_snapshot is distinct from (public.supplier_order_terms(r)||jsonb_build_object('productionMode',c.production_mode)) then raise exception 'PRODUCTION_CONDITIONS_CHANGED: supplier must review the current production terms';end if;
 if p_decision<>'approve' then
  update public.production_conditions set status=case when p_decision='reject' then 'rejected' else 'revision_requested' end,version=version+1,updated_at=stamp,updated_by=actor.id where run_id=r.id;
  update public.production_runs set version=version+1,updated_at=stamp,updated_by=actor.id where id=r.id;
  perform public.production_condition_event(actor,r,case when p_decision='reject' then '발주 거절' else '본사 수정 요청' end,p_reason,null,jsonb_build_object('proposalId',p.id,'expectedDeliveryDate',p.expected_delivery_date::text,'unitCost',p.unit_cost),true);
  return p.id;
 end if;
 if not p.can_produce or not p.quantity_confirmed or not p.agreed or p.confirmed_quantities is distinct from r.order_quantities then raise exception 'SUPPLIER_CONDITIONS_UNCONFIRMED: production ability and exact PO quantity required';end if;
 if p_final_delivery_date is null or p_final_delivery_date='' then raise exception 'INVALID_DELIVERY_DATE';end if;perform public.validate_sig_date(p_final_delivery_date);
 cost:=public.production_condition_cost(p_final_unit_cost,true);
 if cost*public.production_quantity_total(r.order_quantities)>1000000000000 then raise exception 'INVALID_PRODUCTION_CONDITIONS: amount exceeds one trillion';end if;
 if exists(select 1 from public.production_receipts where run_id=r.id) or exists(select 1 from public.production_order_starts where run_id=r.id) then raise exception 'HISTORY_PROTECTED: existing production financial records cannot be repriced';end if;
 -- This is the only new-process assignment of a final run price. No receipt or
 -- finalized snapshot is modified; the original requested due date stays intact.
 update public.production_runs set unit_cost=cost,version=version+1,updated_at=stamp,updated_by=actor.id where id=r.id;
 terms:=public.supplier_order_terms(r)||jsonb_build_object('productionMode',c.production_mode,'requestedDeliveryDate',coalesce(po.due_date::text,''),'proposedDeliveryDate',p.expected_delivery_date::text,'finalDeliveryDate',p_final_delivery_date,'proposedUnitCost',p.unit_cost,'unitCost',cost,'supplierReplyId',p.id,'supplierActorId',p.actor_id,'supplierActorName',p.actor_name,'supplierSubmittedAt',p.submitted_at,'approvedBy',actor.id,'approvedByName',actor.name,'approvedAt',stamp);
 insert into public.production_condition_approvals(run_id,proposal_id,final_delivery_date,unit_cost,approved_by,approved_by_name,approved_at,reason,terms_snapshot,po_snapshot)
 values(r.id,p.id,p_final_delivery_date::date,cost,actor.id,actor.name,stamp,trim(p_reason),terms,public.supplier_order_po_snapshot(po)) returning * into a;
 select * into acceptance from public.production_order_acceptances where run_id=r.id;
 if acceptance.id is null then
  insert into public.production_order_acceptances(run_id,factory_id,actor_id,actor_name,actor_email,expected_delivery_date,accepted_at,run_version_snapshot,po_id,po_version,po_snapshot,terms_snapshot)
  values(r.id,p.factory_id,p.actor_id,p.actor_name,(select email from public.profiles where id=p.actor_id),p.expected_delivery_date,p.submitted_at,p.run_version,po.id,po.version,p.po_snapshot,p.terms_snapshot) returning * into acceptance;
 elsif acceptance.po_id<>po.id or acceptance.po_version<>po.version then raise exception 'HISTORY_PROTECTED: prior supplier agreement refers to a different PO';end if;
 insert into public.production_order_starts(run_id,acceptance_id,started_at,started_by,started_by_name) values(r.id,acceptance.id,stamp,actor.id,actor.name);
 update public.production_conditions set approval_id=a.id,status='approved',version=version+1,updated_at=stamp,updated_by=actor.id where run_id=r.id;
 perform public.production_condition_event(actor,r,'본사 최종 승인',p_reason,jsonb_build_object('expectedDeliveryDate',p.expected_delivery_date::text,'unitCost',p.unit_cost),jsonb_build_object('approvalId',a.id,'finalDeliveryDate',p_final_delivery_date,'unitCost',cost,'productionMode',c.production_mode,'order',r.order_quantities),true);
 perform public.production_condition_event(actor,r,'생산 시작','본사 최종 승인에 따른 생산 시작',null,jsonb_build_object('approvalId',a.id,'startedAt',stamp),true);
 return a.id;
end $$;

create or replace function public.request_production_condition_change(p_run_id uuid,p_expected_run_version integer,p_expected_version integer,p_reason text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;r public.production_runs;c public.production_conditions;result public.production_condition_changes;a public.production_condition_approvals;legacy boolean;terms jsonb;begin
 actor:=public.operations_actor();perform public.operations_reason(p_reason);r:=public.lock_production_conditions_run(p_run_id,p_expected_run_version);
 select * into c from public.production_conditions where run_id=r.id for update;
 if p_expected_version is null or coalesce(c.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 select exists(select 1 from public.production_condition_legacy_starts where run_id=r.id) into legacy;
 select * into a from public.production_condition_approvals where id=c.approval_id;
 if not legacy and a.id is null then raise exception 'PRODUCTION_APPROVAL_REQUIRED: approved terms required for a change request';end if;
 terms:=case when a.id is null then public.supplier_order_terms(r)||jsonb_build_object('legacy',true) else a.terms_snapshot end;
 insert into public.production_condition_changes(run_id,approval_id,legacy,reason,actor_id,actor_name,terms_snapshot)
 values(r.id,a.id,legacy,trim(p_reason),actor.id,actor.name,terms) returning * into result;
 insert into public.production_conditions(run_id,version,status,updated_by) values(r.id,1,'approved',actor.id)
 on conflict(run_id) do update set version=production_conditions.version+1,updated_at=clock_timestamp(),updated_by=actor.id;
 perform public.production_condition_event(actor,r,'승인 조건 변경 요청',p_reason,null,jsonb_build_object('requestId',result.id,'approvalId',a.id,'requiresSeparateRun',true),true);
 return result.id;
end $$;

create or replace function public.link_production_condition_change(p_request_id uuid,p_replacement_run_id uuid,p_expected_replacement_run_version integer,p_reason text,p_confirmed_new_scope boolean)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;request public.production_condition_changes;oldrun public.production_runs;r public.production_runs;c public.production_conditions;begin
 actor:=public.production_ledger_actor();perform public.operations_reason(p_reason);
 if p_confirmed_new_scope is distinct from true then raise exception 'NEW_SCOPE_CONFIRMATION_REQUIRED';end if;
 select * into request from public.production_condition_changes where id=p_request_id;
 if request.id is null then raise exception 'FORBIDDEN: inaccessible change request' using errcode='42501';end if;
 select * into oldrun from public.production_runs where id=request.run_id;
 r:=public.lock_production_conditions_run(p_replacement_run_id,p_expected_replacement_run_version);
 if not public.can_access_style(oldrun.style_id) or r.id=oldrun.id or r.style_id<>oldrun.style_id or r.line_id<>oldrun.line_id or r.project_id<>oldrun.project_id or r.factory_id_snapshot<>oldrun.factory_id_snapshot then raise exception 'INVALID_PRODUCTION_CHANGE_LINK: matching project, style, color and factory required';end if;
 if (select data->>'factoryId' from public.styles where id=r.style_id) is distinct from r.factory_id_snapshot::text then raise exception 'ASSIGNMENT_CHANGED';end if;
 if r.closed_at is not null or exists(select 1 from public.production_order_starts where run_id=r.id) or exists(select 1 from public.production_receipts where run_id=r.id) or exists(select 1 from public.production_condition_approvals where run_id=r.id) then raise exception 'HISTORY_PROTECTED: replacement production must not have started';end if;
 select * into c from public.production_conditions where run_id=r.id for update;
 if c.proposal_id is not null or c.approval_id is not null or c.status='rejected' then raise exception 'HISTORY_PROTECTED: replacement conditions already submitted';end if;
 if exists(select 1 from public.production_condition_change_links where request_id=p_request_id or replacement_run_id=r.id) then raise exception 'DUPLICATE_PRODUCTION_CHANGE_LINK';end if;
 insert into public.production_condition_change_links(request_id,replacement_run_id,actor_id,actor_name,reason,confirmed_new_scope) values(request.id,r.id,actor.id,actor.name,trim(p_reason),true);
 insert into public.production_conditions(run_id,version,updated_by) values(r.id,1,actor.id) on conflict(run_id) do update set version=production_conditions.version+1,updated_at=clock_timestamp(),updated_by=actor.id;
 update public.production_conditions set version=version+1,updated_at=clock_timestamp(),updated_by=actor.id where run_id=oldrun.id;
 update public.production_runs set version=version+1,updated_at=clock_timestamp(),updated_by=actor.id where id=r.id;
 perform public.production_condition_event(actor,r,'변경 요청 생산 차수 연결',p_reason,null,jsonb_build_object('requestId',request.id,'priorRunId',oldrun.id,'confirmedNewScope',true),true);
 perform public.production_condition_event(actor,oldrun,'후속 생산 차수 연결',p_reason,null,jsonb_build_object('requestId',request.id,'correctingRunId',r.id),true);
end $$;

-- Legacy entrypoints remain present for older clients but can no longer start a
-- new run by accepting supplier terms or clicking a separate start action.
create or replace function public.accept_supplier_production_order(p_run_id uuid,p_expected_run_version integer,p_expected_po_version integer,p_expected_delivery_date text,p_agreed boolean)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
begin perform public.operations_actor();raise exception 'HQ_APPROVAL_REQUIRED: submit production conditions and wait for final headquarters approval';end $$;
create or replace function public.start_supplier_production_run(p_run_id uuid,p_expected_run_version integer)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin perform public.production_ledger_actor();raise exception 'HQ_APPROVAL_REQUIRED: final headquarters approval is required';end $$;

create or replace function public.guard_approved_production_conditions() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if exists(select 1 from public.production_condition_approvals where run_id=old.id) and
  (new.unit_cost is distinct from old.unit_cost or new.item_type is distinct from old.item_type or new.order_quantities is distinct from old.order_quantities or new.project_id is distinct from old.project_id or new.project_code is distinct from old.project_code or new.po_id is distinct from old.po_id or new.expected_due is distinct from old.expected_due or new.style_id is distinct from old.style_id or new.line_id is distinct from old.line_id or new.round is distinct from old.round or new.factory_id_snapshot is distinct from old.factory_id_snapshot or new.style_code_snapshot is distinct from old.style_code_snapshot or new.corrects_run_id is distinct from old.corrects_run_id)
 then raise exception 'HISTORY_PROTECTED: final approved production conditions are immutable; submit a change request and use a separate run';end if;
 return new;
end $$;
drop trigger if exists production_conditions_approved_terms_guard on public.production_runs;
create trigger production_conditions_approved_terms_guard before update on public.production_runs for each row execute function public.guard_approved_production_conditions();

create or replace function public.require_started_production_order() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare rid uuid;r public.production_runs;po public.po_dispatches;a public.production_order_acceptances;approval public.production_condition_approvals;legacy boolean;
begin
 if tg_table_name='production_runs' then
  if new.closed_at is not distinct from old.closed_at then return new;end if;
 end if;
 if tg_table_name='production_runs' then rid:=new.id;else rid:=new.run_id;end if;
 select * into r from public.production_runs where id=rid;
 select * into a from public.production_order_acceptances where run_id=rid;
 select * into po from public.po_dispatches where id=r.po_id;
 select exists(select 1 from public.production_condition_legacy_starts where run_id=rid) into legacy;
 select * into approval from public.production_condition_approvals where run_id=rid;
 if coalesce(public.current_app_role(),'') not in ('admin','internal') or not exists(select 1 from public.styles where id=r.style_id and deleted_at is null) or a.id is null or a.factory_id is distinct from r.factory_id_snapshot or po.id is null or po.status<>'sent' or po.voided or po.factory_id_snapshot is distinct from r.factory_id_snapshot or po.id<>a.po_id or po.version<>a.po_version or not exists(select 1 from public.production_order_starts where run_id=rid and acceptance_id=a.id) then raise exception 'PRODUCTION_NOT_STARTED';end if;
 if not legacy and (approval.id is null or approval.unit_cost is distinct from r.unit_cost or approval.po_snapshot->>'id' is distinct from po.id::text or (approval.po_snapshot->>'version')::integer is distinct from po.version) then raise exception 'HQ_APPROVAL_REQUIRED: final production approval is required before receipt or closing';end if;
 if tg_table_name='production_runs' and not legacy then new.snapshot:=new.snapshot||jsonb_build_object('productionApprovalId',approval.id,'approvedDeliveryDate',approval.final_delivery_date,'productionMode',approval.terms_snapshot->>'productionMode','productionConditionsSnapshot',approval.terms_snapshot);end if;
 return new;
end $$;

-- Keep automatic draft-to-run linking while requiring an explicit production
-- mode for the new process. No existing PO is resent or relinked here.
do $$ begin
 if to_regprocedure('public.create_production_order_po_before_conditions(uuid,integer,uuid,jsonb,text)') is null then
  alter function public.create_production_order_po(uuid,integer,uuid,jsonb,text) rename to create_production_order_po_before_conditions;
 end if;
end $$;
create or replace function public.create_production_order_po_conditions_014(p_run_id uuid,p_expected_run_version integer,p_po_id uuid,p_data jsonb,p_reason text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.production_runs;begin
 perform public.production_ledger_actor();r:=public.lock_production_conditions_run(p_run_id,p_expected_run_version);
 if not exists(select 1 from public.production_condition_legacy_starts where run_id=r.id) and not exists(select 1 from public.production_conditions where run_id=r.id and production_mode in ('full_package','cmt')) then raise exception 'PRODUCTION_MODE_REQUIRED';end if;
 return public.create_production_order_po_before_conditions(p_run_id,p_expected_run_version,p_po_id,p_data,p_reason);
end $$;
-- A later migration wraps the public entrypoint to capture immutable PO
-- context. Reapplying 014 must refresh its private implementation without
-- replacing that later wrapper or weakening the PO-link checks.
do $install$ begin
 if to_regprocedure('public.create_production_order_po_before_context_015(uuid,integer,uuid,jsonb,text)') is null then
  execute $definition$
   create or replace function public.create_production_order_po(p_run_id uuid,p_expected_run_version integer,p_po_id uuid,p_data jsonb,p_reason text)
   returns uuid language plpgsql security definer set search_path=public,pg_temp as $body$
   begin return public.create_production_order_po_conditions_014(p_run_id,p_expected_run_version,p_po_id,p_data,p_reason);end $body$
  $definition$;
 end if;
end $install$;

do $$ declare t text;begin
 foreach t in array array['production_condition_legacy_cutover','production_condition_legacy_starts','production_conditions','production_condition_proposals','production_condition_approvals','production_condition_events','production_condition_changes','production_condition_change_links'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
 end loop;
end $$;
revoke execute on function public.production_condition_immutable(),public.production_condition_cost(jsonb,boolean),public.lock_production_conditions_run(uuid,integer),public.production_condition_event(public.profiles,public.production_runs,text,text,jsonb,jsonb,boolean),public.guard_approved_production_conditions(),public.require_started_production_order(),public.create_production_order_po_before_conditions(uuid,integer,uuid,jsonb,text),public.create_production_order_po_conditions_014(uuid,integer,uuid,jsonb,text) from public,anon,authenticated,service_role;
revoke execute on function public.get_production_conditions_capability(),public.get_production_conditions(),public.configure_production_conditions(uuid,integer,integer,text,jsonb,text),public.submit_production_conditions(uuid,integer,integer,integer,jsonb),public.review_production_conditions(uuid,integer,integer,text,text,jsonb,text),public.request_production_condition_change(uuid,integer,integer,text),public.link_production_condition_change(uuid,uuid,integer,text,boolean),public.accept_supplier_production_order(uuid,integer,integer,text,boolean),public.start_supplier_production_run(uuid,integer),public.create_production_order_po(uuid,integer,uuid,jsonb,text) from public,anon,service_role;
grant execute on function public.get_production_conditions_capability(),public.get_production_conditions(),public.configure_production_conditions(uuid,integer,integer,text,jsonb,text),public.submit_production_conditions(uuid,integer,integer,integer,jsonb),public.review_production_conditions(uuid,integer,integer,text,text,jsonb,text),public.request_production_condition_change(uuid,integer,integer,text),public.link_production_condition_change(uuid,uuid,integer,text,boolean),public.accept_supplier_production_order(uuid,integer,integer,text,boolean),public.start_supplier_production_run(uuid,integer),public.create_production_order_po(uuid,integer,uuid,jsonb,text) to authenticated;
notify pgrst,'reload schema';
commit;
