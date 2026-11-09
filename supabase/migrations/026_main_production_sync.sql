-- Apply after 025. Append cumulative shipment corrections and atomically confirm
-- main-production receipts. Existing baselines, batches, receipts and closed
-- financial snapshots are never rewritten or inferred during installation.
begin;

create table if not exists public.shipment_total_adjustments (
 id uuid primary key default gen_random_uuid(),
 style_id uuid not null references public.styles(id) on delete restrict,
 line_id uuid not null,delta jsonb not null check(jsonb_typeof(delta)='object'),
 shipped_at date,created_at timestamptz not null default clock_timestamp(),
 created_by uuid not null references public.profiles(id) on delete restrict,
 reason text not null,
 foreign key(style_id,line_id) references public.shipment_ledgers(style_id,line_id) on delete restrict
);
create index if not exists shipment_total_adjustments_line on public.shipment_total_adjustments(style_id,line_id,created_at,id);
create table if not exists public.main_production_receipt_requests (
 request_id uuid primary key,actor_id uuid not null references public.profiles(id) on delete restrict,
 request jsonb not null,reason text not null,response jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create or replace function public.protect_main_production_sync_history() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'HISTORY_PROTECTED: production movement history is immutable';end $$;
drop trigger if exists shipment_total_adjustments_history on public.shipment_total_adjustments;
create trigger shipment_total_adjustments_history before update or delete on public.shipment_total_adjustments for each row execute function public.protect_main_production_sync_history();
drop trigger if exists main_production_receipt_requests_history on public.main_production_receipt_requests;
create trigger main_production_receipt_requests_history before update or delete on public.main_production_receipt_requests for each row execute function public.protect_main_production_sync_history();

create or replace function public.get_main_production_sync_capability() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p where p.id=auth.uid() and p.approved and p.active and p.role in ('admin','internal','factory')) and not public.is_inspection_actor()
$$;
create or replace function public.get_main_production_sync() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.get_main_production_sync_capability() then raise exception 'FORBIDDEN: approved production actor required' using errcode='42501';end if;
 return jsonb_build_object('shipmentAdjustments',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'styleId',x.style_id,'lineId',x.line_id,'delta',x.delta,'shippedAt',coalesce(x.shipped_at::text,''),'createdAt',x.created_at,'createdBy',x.created_by,'reason',x.reason) order by x.created_at,x.id) from public.shipment_total_adjustments x where public.can_access_style(x.style_id)),'[]'::jsonb));
end $$;

-- A correction is signed and append-only. Old baseline/batch rows continue to
-- explain their original contribution, and later batch saves use this same sum.
create or replace function public.shipment_ledger_total(p_style_id uuid,p_line_id uuid) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare ledger public.shipment_ledgers;correction public.shipment_total_adjustments;q jsonb:='{}';key text;total numeric;latest date;batch_date date;
begin
 select * into ledger from public.shipment_ledgers where style_id=p_style_id and line_id=p_line_id;
 if not found then return null;end if;
 foreach key in array array['XXS','XS','S','M','L','XL'] loop
  select (ledger.baseline_quantities->>key)::numeric
   +coalesce((select sum((b.quantities->>key)::numeric) from public.shipment_batches b where b.style_id=p_style_id and b.line_id=p_line_id and not b.voided),0)
   +coalesce((select sum((a.delta->>key)::numeric) from public.shipment_total_adjustments a where a.style_id=p_style_id and a.line_id=p_line_id),0) into total;
  if total<0 or total>10000000 or total<>trunc(total) then raise exception 'INVALID_QUANTITIES: shipment aggregate must be a whole number from 0 to 10000000 per size';end if;
  q:=q||jsonb_build_object(key,total);
 end loop;
 select * into correction from public.shipment_total_adjustments a where a.style_id=p_style_id and a.line_id=p_line_id order by a.created_at desc,a.id desc limit 1;
 if correction.id is null then
  select greatest(ledger.baseline_date,max(b.shipped_at)) into latest from public.shipment_batches b where b.style_id=p_style_id and b.line_id=p_line_id and not b.voided;
 else
  select max(b.shipped_at) into batch_date from public.shipment_batches b where b.style_id=p_style_id and b.line_id=p_line_id and not b.voided and b.updated_at>correction.created_at;
  latest:=greatest(correction.shipped_at,batch_date);
 end if;
 return jsonb_build_object('quantities',q,'shippedAt',coalesce(latest::text,''));
end $$;

-- Called only by the two public transaction boundaries below. Do not replace
-- save_style: its authorization, owner defaults and later guards remain active.
create or replace function public.save_main_production_style_core(p_id uuid,p_data jsonb,p_expected_version integer,p_reason text,p_confirmed_line_id uuid default null)
returns public.styles language plpgsql security definer set search_path='' as $$
declare actor public.profiles;oldrow public.styles;result public.styles;item jsonb;previous jsonb;total jsonb;delta jsonb;key text;line_uuid uuid;stamp timestamptz;allocated bigint;
begin
 actor:=public.operations_actor();perform public.operations_reason(p_reason);
 if not public.get_main_production_sync_capability() then raise exception 'FORBIDDEN: production movement access required' using errcode='42501';end if;
 if p_id is null or p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_VERSION';end if;
 select * into oldrow from public.styles where id=p_id for update;
 if oldrow.id is null then
  if p_confirmed_line_id is not null then raise exception 'INVALID_PRODUCTION_RECEIPT: saved style required';end if;
  return public.save_style(p_id,p_data,p_expected_version,p_reason);
 end if;
 if oldrow.deleted_at is not null or not public.can_access_style(p_id) then raise exception 'FORBIDDEN: inaccessible style' using errcode='42501';end if;
 if oldrow.version<>p_expected_version then raise exception 'VERSION_CONFLICT: parent style changed' using errcode='40001';end if;
 perform public.validate_style(p_id,p_data);
 for item in select value from jsonb_array_elements(p_data->'production') loop
  select value into previous from jsonb_array_elements(oldrow.data->'production') where value->>'id'=item->>'id';
  if previous is null then continue;end if;
  line_uuid:=(item->>'id')::uuid;
  if item->'received' is distinct from previous->'received' or item->>'receivedAt' is distinct from previous->>'receivedAt' then
   if p_confirmed_line_id is not null and line_uuid<>p_confirmed_line_id then raise exception 'RECEIPT_CONFIRMATION_REQUIRED: confirm other colors separately';end if;
   if line_uuid is distinct from p_confirmed_line_id and exists(select 1 from public.production_runs where style_id=p_id and line_id=line_uuid) then raise exception 'RECEIPT_CONFIRMATION_REQUIRED: confirm actual receipts from main production';end if;
   if line_uuid=p_confirmed_line_id then
    foreach key in array array['XXS','XS','S','M','L','XL'] loop
     select coalesce(sum((r.quantities->>key)::bigint),0) into allocated from public.production_receipts r where r.style_id=p_id and r.line_id=line_uuid and not r.voided;
     if (item->'received'->>key)::bigint<allocated then raise exception 'INVALID_PRODUCTION_RECEIPT: cumulative quantity below confirmed receipts';end if;
    end loop;
   end if;
  end if;
  if item->'shipped' is distinct from previous->'shipped' or item->>'shippedAt' is distinct from previous->>'shippedAt' then
   if actor.role not in ('admin','factory') then raise exception 'FORBIDDEN: shipment quantities require a factory or administrator' using errcode='42501';end if;
   perform public.operations_quantities(item->'shipped');
   perform public.operations_text(item,'shippedAt',10,public.production_quantity_total(item->'shipped')>0);
   if item->>'shippedAt'<>'' then perform public.validate_sig_date(item->>'shippedAt');end if;
   insert into public.shipment_ledgers(style_id,line_id,baseline_quantities,baseline_date,created_by)
    values(p_id,line_uuid,previous->'shipped',nullif(previous->>'shippedAt','')::date,actor.id) on conflict(style_id,line_id) do nothing;
   total:=public.shipment_ledger_total(p_id,line_uuid);delta:='{}';
   foreach key in array array['XXS','XS','S','M','L','XL'] loop delta:=delta||jsonb_build_object(key,(item->'shipped'->>key)::bigint-(total->'quantities'->>key)::bigint);end loop;
   select greatest(clock_timestamp(),coalesce(max(x.created_at)+interval '1 microsecond','-infinity'::timestamptz)) into stamp from public.shipment_total_adjustments x where x.style_id=p_id and x.line_id=line_uuid;
   insert into public.shipment_total_adjustments(style_id,line_id,delta,shipped_at,created_at,created_by,reason)
    values(p_id,line_uuid,delta,nullif(item->>'shippedAt','')::date,stamp,actor.id,btrim(p_reason));
  end if;
 end loop;
 result:=public.save_style(p_id,p_data,p_expected_version,p_reason);
 return result;
end $$;
create or replace function public.save_main_production_style(p_id uuid,p_data jsonb,p_expected_version integer,p_reason text)
returns public.styles language plpgsql security definer set search_path='' as $$
begin return public.save_main_production_style_core(p_id,p_data,p_expected_version,p_reason,null);end $$;

-- The same final-approval proof required by the receipt INSERT trigger is also
-- checked on delta-zero confirmations; no empty confirmation can bypass it.
create or replace function public.assert_main_production_run_started(p_run_id uuid) returns void language plpgsql stable security definer set search_path='' as $$
declare r public.production_runs;po public.po_dispatches;a public.production_order_acceptances;approval public.production_condition_approvals;legacy boolean;
begin
 select * into r from public.production_runs where id=p_run_id;
 select * into a from public.production_order_acceptances where run_id=p_run_id;
 select * into po from public.po_dispatches where id=r.po_id;
 select exists(select 1 from public.production_condition_legacy_starts where run_id=p_run_id) into legacy;
 select * into approval from public.production_condition_approvals where run_id=p_run_id;
 if coalesce(public.current_app_role(),'') not in ('admin','internal') or not exists(select 1 from public.styles where id=r.style_id and deleted_at is null)
  or a.id is null or a.factory_id is distinct from r.factory_id_snapshot or po.id is null or po.status<>'sent' or po.voided or po.factory_id_snapshot is distinct from r.factory_id_snapshot
  or po.id<>a.po_id or po.version<>a.po_version or not exists(select 1 from public.production_order_starts where run_id=p_run_id and acceptance_id=a.id)
 then raise exception 'PRODUCTION_NOT_STARTED';end if;
 if not legacy and (approval.id is null or approval.unit_cost is distinct from r.unit_cost or approval.po_snapshot->>'id' is distinct from po.id::text or (approval.po_snapshot->>'version')::integer is distinct from po.version)
 then raise exception 'HQ_APPROVAL_REQUIRED: final production approval is required before receipt';end if;
end $$;

create or replace function public.confirm_main_production_receipt(p_request jsonb,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles;s public.styles;saved public.styles;r public.production_runs;previous public.main_production_receipt_requests;
 request_uuid uuid;style_uuid uuid;line_uuid uuid;run_uuid uuid;style_version integer;run_version integer;target jsonb;added jsonb:='{}';key text;allocated bigint;quantity bigint;receipt_uuid uuid;response jsonb;item jsonb;
begin
 actor:=public.operations_actor();if actor.role<>'admin' then raise exception 'FORBIDDEN: actual receipts require administrator' using errcode='42501';end if;
 perform public.operations_reason(p_reason);
 perform public.operations_shape(p_request,array['requestId','styleId','lineId','runId','expectedStyleVersion','expectedRunVersion','style']);
 request_uuid:=public.operations_uuid(p_request->>'requestId');style_uuid:=public.operations_uuid(p_request->>'styleId');line_uuid:=public.operations_uuid(p_request->>'lineId');run_uuid:=public.operations_uuid(p_request->>'runId');
 if jsonb_typeof(p_request->'expectedStyleVersion') is distinct from 'number' or p_request->>'expectedStyleVersion' !~ '^[0-9]+$' or (p_request->>'expectedStyleVersion')::numeric not between 1 and 2147483646
  or jsonb_typeof(p_request->'expectedRunVersion') is distinct from 'number' or p_request->>'expectedRunVersion' !~ '^[0-9]+$' or (p_request->>'expectedRunVersion')::numeric not between 1 and 2147483646 then raise exception 'INVALID_VERSION';end if;
 style_version:=(p_request->>'expectedStyleVersion')::integer;run_version:=(p_request->>'expectedRunVersion')::integer;
 if p_request->'style'->>'id' is distinct from style_uuid::text or p_request->'style'->'version' is distinct from to_jsonb(style_version) then raise exception 'INVALID_VERSION: style payload differs from request';end if;
 perform pg_advisory_xact_lock(hashtextextended('sig:main-receipt:'||request_uuid::text,0));
 select * into previous from public.main_production_receipt_requests where request_id=request_uuid;
 if previous.request_id is not null then
  if previous.actor_id<>actor.id or previous.request is distinct from p_request or previous.reason<>btrim(p_reason) then raise exception 'VERSION_CONFLICT: receipt request ID reused with different contents' using errcode='40001';end if;
  return previous.response;
 end if;
 select * into s from public.styles where id=style_uuid and deleted_at is null for update;
 if s.id is null or not public.can_access_style(style_uuid) then raise exception 'FORBIDDEN: inaccessible style' using errcode='42501';end if;
 if s.version<>style_version then raise exception 'VERSION_CONFLICT: parent style changed' using errcode='40001';end if;
 select * into r from public.production_runs where id=run_uuid for update;
 if r.id is null or r.style_id<>style_uuid or r.line_id<>line_uuid then raise exception 'INVALID_PRODUCTION_RECEIPT: run does not belong to selected style and color';end if;
 if r.version<>run_version then raise exception 'VERSION_CONFLICT: production run changed' using errcode='40001';end if;
 if r.closed_at is not null then raise exception 'HISTORY_PROTECTED: finalized production run is immutable';end if;
 if r.unit_cost is null or btrim(r.project_code)='' then raise exception 'INVALID_PRODUCTION_RECEIPT: price and project required';end if;
 perform public.assert_main_production_run_started(run_uuid);
 select value into target from jsonb_array_elements(p_request->'style'->'production') where value->>'id'=line_uuid::text;
 if target is null or not exists(select 1 from jsonb_array_elements(s.data->'production') where value->>'id'=line_uuid::text) then raise exception 'INVALID_PRODUCTION_RECEIPT: saved production color required';end if;
 perform public.operations_quantities(target->'received');perform public.operations_text(target,'receivedAt',10,true);perform public.validate_sig_date(target->>'receivedAt');
 foreach key in array array['XXS','XS','S','M','L','XL'] loop
  select coalesce(sum((x.quantities->>key)::bigint),0) into allocated from public.production_receipts x where x.style_id=style_uuid and x.line_id=line_uuid and not x.voided;
  quantity:=(target->'received'->>key)::bigint-allocated;
  if quantity<0 then raise exception 'INVALID_PRODUCTION_RECEIPT: cumulative quantity below confirmed receipts';end if;
  added:=added||jsonb_build_object(key,quantity);
 end loop;
 if public.production_quantity_total(added)>0 then
  receipt_uuid:=request_uuid;
  perform public.allocate_production_receipt(receipt_uuid,run_uuid,jsonb_build_object('receivedAt',target->>'receivedAt','quantities',added),run_version,p_reason);
 end if;
 saved:=public.save_main_production_style_core(style_uuid,p_request->'style',style_version,p_reason,line_uuid);
 select version into run_version from public.production_runs where id=run_uuid;
 response:=jsonb_build_object('style',to_jsonb(saved),'receiptId',receipt_uuid,'added',added,'runVersion',run_version);
 insert into public.main_production_receipt_requests(request_id,actor_id,request,reason,response) values(request_uuid,actor.id,p_request,btrim(p_reason),response);
 return response;
end $$;

alter table public.shipment_total_adjustments enable row level security;
alter table public.main_production_receipt_requests enable row level security;
drop policy if exists shipment_total_adjustments_read on public.shipment_total_adjustments;
create policy shipment_total_adjustments_read on public.shipment_total_adjustments for select to authenticated using(public.get_main_production_sync_capability() and public.can_access_style(style_id));
revoke all on public.shipment_total_adjustments,public.main_production_receipt_requests from public,anon,authenticated,service_role;
grant select on public.shipment_total_adjustments to authenticated;
revoke execute on function public.protect_main_production_sync_history(),public.save_main_production_style_core(uuid,jsonb,integer,text,uuid),public.assert_main_production_run_started(uuid),public.get_main_production_sync_capability(),public.get_main_production_sync(),public.save_main_production_style(uuid,jsonb,integer,text),public.confirm_main_production_receipt(jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.get_main_production_sync_capability(),public.get_main_production_sync(),public.save_main_production_style(uuid,jsonb,integer,text),public.confirm_main_production_receipt(jsonb,text) to authenticated;
do $$begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='shipment_total_adjustments') then alter publication supabase_realtime add table public.shipment_total_adjustments;end if;
end $$;
notify pgrst,'reload schema';
commit;
