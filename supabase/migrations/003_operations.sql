-- Apply AFTER 001_initial.sql and 002_style_images.sql.
-- Additional business records stay outside the protected Style JSON contract.
begin;

create table public.po_dispatches (
  id uuid primary key,style_id uuid not null references public.styles(id) on delete restrict,
  due_date date not null,recipient text not null,subject text not null,body text not null,
  evidence_attachment_id uuid references public.attachments(id) on delete restrict,
  status text not null default 'draft' check(status in ('draft','sending','sent','failed','unknown')),
  sent_at timestamptz,provider_message_id text,last_error text,
  attempts integer not null default 0 check(attempts>=0),idempotency_key text not null unique,
  factory_id_snapshot uuid not null references public.factories(id),style_code_snapshot text not null,
  voided boolean not null default false,version integer not null check(version>0),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id),
  check((status='sent' and sent_at is not null and provider_message_id is not null) or (status<>'sent' and sent_at is null))
);
create index po_dispatches_style_idx on public.po_dispatches(style_id,created_at);
create table public.po_dispatch_attempts (
  id uuid primary key default gen_random_uuid(),dispatch_id uuid not null references public.po_dispatches(id) on delete restrict,
  attempt integer not null check(attempt>0),status text not null check(status in ('sending','sent','failed','unknown')),
  snapshot jsonb not null,provider_message_id text,error text,
  started_at timestamptz not null,finished_at timestamptz,actor_id uuid not null references public.profiles(id),
  unique(dispatch_id,attempt)
);
create table public.shipment_ledgers (
  style_id uuid not null references public.styles(id) on delete restrict,
  line_id uuid not null,
  baseline_quantities jsonb not null,
  baseline_date date,
  created_at timestamptz not null default now(), created_by uuid not null references public.profiles(id),
  primary key(style_id,line_id)
);
create table public.shipment_batches (
  id uuid primary key,
  style_id uuid not null, line_id uuid not null,
  round integer not null check(round between 1 and 10000),
  shipped_at date not null, quantities jsonb not null,
  tracking text not null, note text not null,
  voided boolean not null default false,
  version integer not null check(version>0),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id),
  foreign key(style_id,line_id) references public.shipment_ledgers(style_id,line_id) on delete restrict,
  unique(style_id,line_id,round)
);
create index shipment_batches_parent_idx on public.shipment_batches(style_id,line_id);
create table public.operation_catalogs (
  id uuid primary key,kind text not null check(kind in ('label','embroidery')),
  name text not null check(length(trim(name)) between 1 and 120),active boolean not null,
  version integer not null check(version>0),created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),updated_by uuid references public.profiles(id)
);
create unique index operation_catalog_name_idx on public.operation_catalogs(kind,lower(name));
create table public.style_operations (
  id uuid primary key, style_id uuid not null references public.styles(id) on delete restrict,
  kind text not null check(kind in ('label','embroidery')),
  rows_data jsonb not null, note text not null, voided boolean not null default false,
  version integer not null check(version>0),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id),
  unique(style_id,kind)
);
create table public.order_source_records (
  style_id uuid not null references public.styles(id) on delete restrict,line_id uuid not null,
  file_name text not null,sheet_name text not null,headers jsonb not null,rows_data jsonb not null,
  version integer not null check(version>0),created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),updated_by uuid not null references public.profiles(id),
  primary key(style_id,line_id)
);
create table public.calendar_events (
  id uuid primary key,
  kind text not null check(kind in ('personal_leave','launch','factory_holiday')),
  visibility text not null check(visibility in ('private','hq','all')),
  title text not null,
  start_date date not null, end_date date not null check(end_date>=start_date),
  owner_id uuid not null references public.profiles(id), factory_id uuid references public.factories(id),
  note text not null, deleted_at timestamptz,
  version integer not null check(version>0),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id),
  check((kind='personal_leave' and visibility in ('private','hq') and factory_id is null)
    or (kind='launch' and visibility='all' and factory_id is null)
    or (kind='factory_holiday' and visibility='hq' and factory_id is not null))
);
create index calendar_events_dates_idx on public.calendar_events(start_date,end_date);
-- Kept separate from public.audits: global admin audits must not leak private leave.
create table public.calendar_event_audits (
  id uuid primary key default gen_random_uuid(),event_id uuid not null references public.calendar_events(id) on delete restrict,
  actor_id uuid not null references public.profiles(id),actor_name text not null,
  action text not null,reason text not null,before jsonb,after jsonb,created_at timestamptz not null default now()
);
create index calendar_event_audits_event_idx on public.calendar_event_audits(event_id,created_at);
create table public.employee_factory_assignments (
  employee_id uuid primary key references public.profiles(id) on delete restrict,
  factory_ids uuid[] not null default '{}',version integer not null check(version>0),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id)
);

create function public.operations_actor() returns public.profiles language plpgsql stable security definer set search_path=public,pg_temp as $$
declare actor public.profiles;
begin
  select * into actor from public.profiles where id=auth.uid() and approved and active;
  if not found then raise exception 'FORBIDDEN: administrator approval required' using errcode='42501'; end if;
  return actor;
end $$;
create function public.operations_reason(reason text) returns void language plpgsql immutable set search_path=public,pg_temp as $$
begin
  if length(trim(coalesce(reason,''))) not between 2 and 1000 then raise exception 'REASON_REQUIRED: enter 2 to 1000 characters'; end if;
end $$;
create function public.operations_shape(d jsonb,keys text[]) returns void language plpgsql immutable set search_path=public,pg_temp as $$
begin
  if jsonb_typeof(d) is distinct from 'object' or not(d ?& keys) then raise exception 'INVALID_OPERATION: missing fields'; end if;
  if exists(select 1 from jsonb_object_keys(d) k where not(k=any(keys))) then raise exception 'INVALID_OPERATION: unknown field'; end if;
end $$;
create function public.operations_text(d jsonb,key text,max_length integer,required boolean default false) returns void language plpgsql immutable set search_path=public,pg_temp as $$
begin
  if jsonb_typeof(d->key) is distinct from 'string' or length(d->>key)>max_length or (required and length(trim(d->>key))=0) then raise exception 'INVALID_OPERATION: invalid %',key; end if;
end $$;
create function public.operations_quantities(q jsonb) returns void language plpgsql immutable set search_path=public,pg_temp as $$
declare key text;
begin
  perform public.operations_shape(q,array['XXS','XS','S','M','L','XL']);
  foreach key in array array['XXS','XS','S','M','L','XL'] loop
    if jsonb_typeof(q->key) is distinct from 'number' or q->>key !~ '^[0-9]+$' or (q->>key)::numeric>10000000 then raise exception 'INVALID_QUANTITIES: six nonnegative integers, max 10000000 each'; end if;
  end loop;
end $$;
create function public.operations_uuid(value text) returns uuid language plpgsql immutable set search_path=public,pg_temp as $$
begin
  if value is null or value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_OPERATION: canonical UUID required'; end if;
  return value::uuid;
end $$;

create function public.save_po_dispatch(p_id uuid,p_style_id uuid,p_expected_version integer,p_data jsonb,p_reason text)
returns public.po_dispatches language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; s public.styles; oldrow public.po_dispatches; result public.po_dispatches; proof uuid; stamp timestamptz:=clock_timestamp();
begin
  actor:=public.operations_actor();
  if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN: PO drafts are managed by headquarters' using errcode='42501'; end if;
  perform public.operations_reason(p_reason);
  if p_id is null or p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_VERSION'; end if;
  select * into s from public.styles where id=p_style_id and deleted_at is null for update;
  if not found or not public.can_access_style(p_style_id) then raise exception 'FORBIDDEN: inaccessible style' using errcode='42501'; end if;
  select * into oldrow from public.po_dispatches where id=p_id for update;
  if oldrow.id is not null and oldrow.style_id<>p_style_id then raise exception 'FORBIDDEN: record belongs to another style' using errcode='42501'; end if;
  if coalesce(oldrow.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  if oldrow.id is not null and (oldrow.status<>'draft' or oldrow.attempts>0) then raise exception 'HISTORY_PROTECTED: attempted PO snapshots are immutable'; end if;
  perform public.operations_shape(p_data,array['dueDate','recipient','subject','body','evidenceAttachmentId','voided']);
  perform public.operations_text(p_data,'dueDate',10,true); perform public.validate_sig_date(p_data->>'dueDate');
  perform public.operations_text(p_data,'recipient',254,true); perform public.operations_text(p_data,'subject',500,true); perform public.operations_text(p_data,'body',20000,true);
  if p_data->>'recipient' !~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$' or p_data->>'subject' ~ E'[\r\n]' then raise exception 'INVALID_OPERATION: recipient email or subject'; end if;
  if jsonb_typeof(p_data->'voided') is distinct from 'boolean' then raise exception 'INVALID_OPERATION: void flag'; end if;
  if p_data->'evidenceAttachmentId'<>'null'::jsonb then
    proof:=public.operations_uuid(p_data->>'evidenceAttachmentId');
    if not exists(select 1 from public.attachments where id=proof and style_id=p_style_id) then raise exception 'INVALID_OPERATION: choose attachment from this style'; end if;
  end if;
  if oldrow.id is null then
    if (p_data->>'voided')::boolean then raise exception 'INVALID_OPERATION: new draft cannot be voided'; end if;
    insert into public.po_dispatches(id,style_id,due_date,recipient,subject,body,evidence_attachment_id,status,idempotency_key,factory_id_snapshot,style_code_snapshot,voided,version,created_at,updated_at,updated_by)
    values(p_id,p_style_id,(p_data->>'dueDate')::date,p_data->>'recipient',p_data->>'subject',p_data->>'body',proof,'draft','sig-po-'||p_id::text,(s.data->>'factoryId')::uuid,s.data->>'code',false,1,stamp,stamp,actor.id) returning * into result;
  else
    update public.po_dispatches set due_date=(p_data->>'dueDate')::date,recipient=p_data->>'recipient',subject=p_data->>'subject',body=p_data->>'body',evidence_attachment_id=proof,factory_id_snapshot=(s.data->>'factoryId')::uuid,style_code_snapshot=s.data->>'code',voided=(p_data->>'voided')::boolean,version=version+1,updated_at=stamp,updated_by=actor.id where id=p_id returning * into result;
  end if;
  insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after) values(p_style_id,actor.id,actor.name,'PO 발송 초안 저장',trim(p_reason),case when oldrow.id is null then null else to_jsonb(oldrow) end,to_jsonb(result));
  return result;
end $$;

create function public.begin_po_dispatch(p_id uuid,p_expected_version integer)
returns public.po_dispatches language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; row public.po_dispatches; result public.po_dispatches; s public.styles; stamp timestamptz:=clock_timestamp();
begin
  actor:=public.operations_actor();
  if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN: PO sending requires headquarters' using errcode='42501'; end if;
  -- Parent then dispatch is the same lock order as draft edits and style updates.
  select * into row from public.po_dispatches where id=p_id;
  if not found then raise exception 'FORBIDDEN: inaccessible PO' using errcode='42501'; end if;
  select * into s from public.styles where id=row.style_id and deleted_at is null for update;
  if not found or not public.can_access_style(row.style_id) then raise exception 'FORBIDDEN: inaccessible style' using errcode='42501'; end if;
  select * into row from public.po_dispatches where id=p_id for update;
  if p_expected_version is null or row.version<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  if row.voided or row.status not in ('draft','failed') then raise exception 'PO_SEND_BLOCKED: sent, pending or uncertain requests cannot be automatically retried'; end if;
  if row.factory_id_snapshot::text is distinct from s.data->>'factoryId' or row.style_code_snapshot is distinct from s.data->>'code' then raise exception 'PO_ASSIGNMENT_CHANGED: review and resave the current draft, or create a new PO if already attempted'; end if;
  update public.po_dispatches set status='sending',attempts=attempts+1,last_error=null,version=version+1,updated_at=stamp,updated_by=actor.id where id=p_id returning * into result;
  insert into public.po_dispatch_attempts(dispatch_id,attempt,status,snapshot,started_at,actor_id)
  values(p_id,result.attempts,'sending',jsonb_build_object('recipient',result.recipient,'subject',result.subject,'body',result.body,'dueDate',result.due_date,'factoryId',result.factory_id_snapshot,'styleCode',result.style_code_snapshot,'idempotencyKey',result.idempotency_key),stamp,actor.id);
  insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after) values(result.style_id,actor.id,actor.name,'PO 이메일 발송 요청','사용자가 프로그램에서 직접 발송 요청',to_jsonb(row),to_jsonb(result));
  return result;
end $$;

-- Only the trusted Edge Function's service client may confirm the provider result.
-- Sending itself is never performed in SQL and credentials are never persisted.
create function public.finalize_po_dispatch(p_id uuid,p_provider_message_id text,p_error text,p_outcome text)
returns public.po_dispatches language plpgsql security definer set search_path=public,pg_temp as $$
declare oldrow public.po_dispatches; result public.po_dispatches; actor public.profiles; stamp timestamptz:=clock_timestamp();
begin
  if p_outcome is null or p_outcome not in ('sent','failed','unknown') then raise exception 'INVALID_OPERATION: provider outcome'; end if;
  if p_outcome='sent' and (length(trim(coalesce(p_provider_message_id,''))) not between 1 and 500 or p_error is not null) then raise exception 'INVALID_OPERATION: sent requires provider message id'; end if;
  if p_outcome<>'sent' and (p_provider_message_id is not null or length(trim(coalesce(p_error,''))) not between 1 and 5000) then raise exception 'INVALID_OPERATION: failed/unknown requires error details'; end if;
  select * into oldrow from public.po_dispatches where id=p_id for update;
  if not found or oldrow.status<>'sending' then raise exception 'PO_SEND_BLOCKED: no sending attempt to finalize'; end if;
  select * into actor from public.profiles where id=oldrow.updated_by;
  update public.po_dispatches set status=p_outcome,sent_at=case when p_outcome='sent' then stamp else null end,provider_message_id=p_provider_message_id,last_error=p_error,version=version+1,updated_at=stamp where id=p_id returning * into result;
  update public.po_dispatch_attempts set status=p_outcome,provider_message_id=p_provider_message_id,error=p_error,finished_at=stamp where dispatch_id=p_id and attempt=oldrow.attempts and status='sending';
  if not found then raise exception 'PO_SEND_BLOCKED: attempt ledger mismatch'; end if;
  insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after) values(result.style_id,actor.id,actor.name,case when p_outcome='sent' then 'PO 이메일 공급자 접수 확인' when p_outcome='failed' then 'PO 이메일 발송 실패' else 'PO 이메일 결과 미확인' end,coalesce(p_error,'공급자 응답 ID: '||p_provider_message_id),to_jsonb(oldrow),to_jsonb(result));
  return result;
end $$;

create function public.save_operation_catalog(p_id uuid,p_kind text,p_name text,p_active boolean,p_expected_version integer,p_reason text)
returns public.operation_catalogs language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; oldrow public.operation_catalogs; result public.operation_catalogs; stamp timestamptz:=clock_timestamp();
begin
  actor:=public.operations_actor(); if actor.role<>'admin' then raise exception 'FORBIDDEN: catalog management requires an administrator' using errcode='42501'; end if;
  perform public.operations_reason(p_reason);
  if p_id is null or p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_VERSION'; end if;
  if p_kind is null or p_kind not in ('label','embroidery') or p_active is null or length(trim(coalesce(p_name,''))) not between 1 and 120 then raise exception 'INVALID_OPERATION: catalog values'; end if;
  perform 1 from public.profiles where id=actor.id for update;
  select * into oldrow from public.operation_catalogs where id=p_id for update;
  -- The user supplied a fixed 23-label / 33-embroidery catalog. Authenticated
  -- administrators may hide/show existing kinds but cannot invent or rename them.
  if oldrow.id is null then raise exception 'INVALID_CATALOG: only the configured fixed kinds may be used'; end if;
  if oldrow.kind<>p_kind or oldrow.name is distinct from p_name then raise exception 'HISTORY_PROTECTED: fixed catalog kind and name are immutable'; end if;
  if oldrow.version<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  update public.operation_catalogs set active=p_active,version=version+1,updated_at=stamp,updated_by=actor.id where id=p_id returning * into result;
  insert into public.audits(actor_id,actor_name,action,reason,before,after) values(actor.id,actor.name,'라벨·자수 작업 종류 사용 설정',trim(p_reason),to_jsonb(oldrow),to_jsonb(result));
  return result;
end $$;

-- Pure server-side aggregation shared by the RPC and write guard. No bypass
-- flag/session setting exists: even legacy save_style must match these totals.
create function public.shipment_ledger_total(p_style_id uuid,p_line_id uuid) returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare ledger public.shipment_ledgers; q jsonb:='{}'; key text; total numeric; latest date;
begin
  select * into ledger from public.shipment_ledgers where style_id=p_style_id and line_id=p_line_id;
  if not found then return null; end if;
  foreach key in array array['XXS','XS','S','M','L','XL'] loop
    select (ledger.baseline_quantities->>key)::numeric+coalesce(sum((b.quantities->>key)::numeric),0) into total from public.shipment_batches b where b.style_id=p_style_id and b.line_id=p_line_id and not b.voided;
    if total>10000000 then raise exception 'INVALID_QUANTITIES: aggregate exceeds 10000000 per size'; end if;
    q:=q||jsonb_build_object(key,total);
  end loop;
  select greatest(ledger.baseline_date,max(b.shipped_at)) into latest from public.shipment_batches b where b.style_id=p_style_id and b.line_id=p_line_id and not b.voided;
  return jsonb_build_object('quantities',q,'shippedAt',coalesce(latest::text,''));
end $$;
create function public.guard_shipment_aggregates() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare ledger public.shipment_ledgers; item jsonb; total jsonb;
begin
  for ledger in select * from public.shipment_ledgers where style_id=new.id loop
    select e.value into item from jsonb_array_elements(new.data->'production') e where e.value->>'id'=ledger.line_id::text;
    total:=public.shipment_ledger_total(new.id,ledger.line_id);
    if item is null or item->'shipped' is distinct from total->'quantities' or item->>'shippedAt' is distinct from total->>'shippedAt' then raise exception 'SHIPMENT_LEDGER_PROTECTED: update partial shipment records instead of aggregate fields'; end if;
  end loop;
  return new;
end $$;
create trigger guard_style_shipment_totals before update on public.styles for each row execute function public.guard_shipment_aggregates();

create function public.save_shipment_batch(p_id uuid,p_style_id uuid,p_line_id uuid,p_expected_version integer,p_expected_style_version integer,p_data jsonb,p_reason text)
returns public.shipment_batches language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; s public.styles; oldrow public.shipment_batches; result public.shipment_batches; line jsonb; item jsonb; updated_production jsonb:='[]'; total jsonb; stamp timestamptz:=clock_timestamp(); next_round integer; saved_style public.styles;
begin
  actor:=public.operations_actor();
  if actor.role not in ('admin','factory') then raise exception 'FORBIDDEN: shipment quantities require a factory or administrator' using errcode='42501'; end if;
  perform public.operations_reason(p_reason);
  if p_id is null or p_line_id is null or p_expected_version is null or p_expected_version<0 or p_expected_style_version is null then raise exception 'INVALID_VERSION'; end if;
  select * into s from public.styles where id=p_style_id and deleted_at is null for update;
  if not found or not public.can_access_style(p_style_id) then raise exception 'FORBIDDEN: inaccessible style' using errcode='42501'; end if;
  if s.version<>p_expected_style_version then raise exception 'VERSION_CONFLICT: parent style changed' using errcode='40001'; end if;
  select e.value into line from jsonb_array_elements(s.data->'production') e where e.value->>'id'=p_line_id::text;
  if line is null then raise exception 'INVALID_OPERATION: unknown production line'; end if;
  select * into oldrow from public.shipment_batches where id=p_id for update;
  if oldrow.id is not null and (oldrow.style_id<>p_style_id or oldrow.line_id<>p_line_id) then raise exception 'FORBIDDEN: batch belongs to another line' using errcode='42501'; end if;
  if coalesce(oldrow.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT: shipment changed' using errcode='40001'; end if;
  perform public.operations_shape(p_data,array['shippedAt','quantities','tracking','note','voided']);
  perform public.operations_quantities(p_data->'quantities');
  perform public.operations_text(p_data,'shippedAt',10,true); perform public.validate_sig_date(p_data->>'shippedAt');
  perform public.operations_text(p_data,'tracking',200); perform public.operations_text(p_data,'note',10000);
  if jsonb_typeof(p_data->'voided') is distinct from 'boolean' then raise exception 'INVALID_OPERATION: void flag'; end if;
  if oldrow.id is null and (p_data->>'voided')::boolean then raise exception 'INVALID_OPERATION: new shipment cannot be voided'; end if;
  if actor.role<>'admin' and (coalesce(oldrow.voided,false) or (p_data->>'voided')::boolean) then raise exception 'FORBIDDEN: only an administrator may cancel, restore or edit a cancelled shipment' using errcode='42501'; end if;
  if not (p_data->>'voided')::boolean and (select sum(e.value::numeric) from jsonb_each_text(p_data->'quantities') e)<=0 then raise exception 'INVALID_QUANTITIES: active shipment must contain at least one item'; end if;
  -- Snapshot the PRE-EXISTING aggregate exactly once, before adding any batch.
  insert into public.shipment_ledgers(style_id,line_id,baseline_quantities,baseline_date,created_by)
  values(p_style_id,p_line_id,line->'shipped',nullif(line->>'shippedAt','')::date,actor.id) on conflict(style_id,line_id) do nothing;
  if oldrow.id is null then
    select coalesce(max(round),0)+1 into next_round from public.shipment_batches where style_id=p_style_id and line_id=p_line_id;
    insert into public.shipment_batches(id,style_id,line_id,round,shipped_at,quantities,tracking,note,voided,version,created_at,updated_at,updated_by)
    values(p_id,p_style_id,p_line_id,next_round,(p_data->>'shippedAt')::date,p_data->'quantities',p_data->>'tracking',p_data->>'note',false,1,stamp,stamp,actor.id) returning * into result;
  else
    update public.shipment_batches set shipped_at=(p_data->>'shippedAt')::date,quantities=p_data->'quantities',tracking=p_data->>'tracking',note=p_data->>'note',voided=(p_data->>'voided')::boolean,version=version+1,updated_at=stamp,updated_by=actor.id where id=p_id returning * into result;
  end if;
  total:=public.shipment_ledger_total(p_style_id,p_line_id);
  for item in select * from jsonb_array_elements(s.data->'production') loop
    if item->>'id'=p_line_id::text then item:=item||jsonb_build_object('shipped',total->'quantities','shippedAt',total->>'shippedAt'); end if;
    updated_production:=updated_production||jsonb_build_array(item);
  end loop;
  -- save_style retains the original role guards, dates/reasons and audit format.
  saved_style:=public.save_style(p_style_id,jsonb_set(s.data,'{production}',updated_production),s.version,trim(p_reason));
  insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after) values(p_style_id,actor.id,actor.name,case when oldrow.id is null then '분할 출고 등록' else '분할 출고 수정' end,trim(p_reason),case when oldrow.id is null then null else to_jsonb(oldrow) end,jsonb_build_object('batch',to_jsonb(result),'styleVersion',saved_style.version,'aggregate',total));
  return result;
end $$;

create function public.save_style_operation(p_id uuid,p_style_id uuid,p_kind text,p_expected_version integer,p_data jsonb,p_reason text)
returns public.style_operations language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; s public.styles; oldrow public.style_operations; result public.style_operations; item jsonb; key text; seen uuid[]:='{}'; row_id uuid; cat public.operation_catalogs; previous_row jsonb; clean_rows jsonb:='[]'; stamp timestamptz:=clock_timestamp();
begin
  actor:=public.operations_actor();
  if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN: work instructions require headquarters' using errcode='42501'; end if;
  perform public.operations_reason(p_reason);
  if p_id is null or p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_VERSION'; end if;
  if p_kind is null or p_kind not in ('label','embroidery') then raise exception 'INVALID_OPERATION: kind'; end if;
  select * into s from public.styles where id=p_style_id and deleted_at is null for update;
  if not found or not public.can_access_style(p_style_id) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into oldrow from public.style_operations where style_id=p_style_id and kind=p_kind for update;
  if oldrow.id is not null and oldrow.id<>p_id then raise exception 'VERSION_CONFLICT: use the existing work record' using errcode='40001'; end if;
  if coalesce(oldrow.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  perform public.operations_shape(p_data,array['rows','note','voided']); perform public.operations_text(p_data,'note',10000);
  if jsonb_typeof(p_data->'voided') is distinct from 'boolean' or jsonb_typeof(p_data->'rows') is distinct from 'array' or jsonb_array_length(p_data->'rows') not between 1 and 200 then raise exception 'INVALID_OPERATION: rows or void flag'; end if;
  for item in select * from jsonb_array_elements(p_data->'rows') loop
    perform public.operations_shape(item,array['id','catalogId','name','specification','quantity','lossQuantity','completedQuantity','status','orderedAt','requestedAt','completedAt','dueDate','note']);
    row_id:=public.operations_uuid(item->>'id');
    if row_id=any(seen) then raise exception 'INVALID_OPERATION: duplicate work row'; end if; seen:=array_append(seen,row_id);
    select * into cat from public.operation_catalogs where id=public.operations_uuid(item->>'catalogId') and kind=p_kind for share;
    if not found then raise exception 'INVALID_OPERATION: select a registered work kind'; end if;
    select e.value into previous_row from jsonb_array_elements(coalesce(oldrow.rows_data,'[]')) e where e.value->>'id'=row_id::text;
    if not cat.active and (previous_row is null or previous_row->>'catalogId'<>cat.id::text) then raise exception 'INVALID_OPERATION: inactive work kind'; end if;
    item:=jsonb_set(item,'{name}',case when not cat.active and previous_row is not null then previous_row->'name' else to_jsonb(cat.name) end);
    perform public.operations_text(item,'name',150,true); perform public.operations_text(item,'specification',1000); perform public.operations_text(item,'note',5000);
    foreach key in array array['quantity','lossQuantity','completedQuantity'] loop
      if jsonb_typeof(item->key) is distinct from 'number' or item->>key !~ '^[0-9]+$' or (item->>key)::numeric>10000000 then raise exception 'INVALID_QUANTITIES'; end if;
    end loop;
    if (item->>'completedQuantity')::numeric>(item->>'quantity')::numeric+(item->>'lossQuantity')::numeric then raise exception 'INVALID_QUANTITIES: completed quantity exceeds order plus loss'; end if;
    if jsonb_typeof(item->'status') is distinct from 'string' or item->>'status' not in ('unset','todo','progress','done','approved','delayed') then raise exception 'INVALID_OPERATION: status'; end if;
    foreach key in array array['orderedAt','requestedAt','completedAt','dueDate'] loop
      perform public.operations_text(item,key,10); perform public.validate_sig_date(item->>key);
    end loop;
    clean_rows:=clean_rows||jsonb_build_array(item);
  end loop;
  if oldrow.id is null then
    insert into public.style_operations(id,style_id,kind,rows_data,note,voided,version,created_at,updated_at,updated_by)
    values(p_id,p_style_id,p_kind,clean_rows,p_data->>'note',(p_data->>'voided')::boolean,1,stamp,stamp,actor.id) returning * into result;
  else
    update public.style_operations set rows_data=clean_rows,note=p_data->>'note',voided=(p_data->>'voided')::boolean,version=version+1,updated_at=stamp,updated_by=actor.id where id=p_id returning * into result;
  end if;
  insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after) values(p_style_id,actor.id,actor.name,case when p_kind='label' then '중화 라벨 관리' else '비와이 자수 관리' end,trim(p_reason),case when oldrow.id is null then null else to_jsonb(oldrow) end,to_jsonb(result));
  return result;
end $$;

create function public.can_read_calendar_event(p_id uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.calendar_events e join public.profiles p on p.id=auth.uid() and p.approved and p.active
    where e.id=p_id and ((e.kind='personal_leave' and ((e.visibility='private' and e.owner_id=p.id) or (e.visibility='hq' and p.role in ('admin','internal'))))
      or e.kind='launch' or (e.kind='factory_holiday' and p.role in ('admin','internal'))))
$$;
-- Audit rows must pass BOTH historical scopes as well as current event scope.
-- Sharing a previously private event does not expose old private snapshots.
create function public.can_read_calendar_snapshot(d jsonb) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select d is null or exists(select 1 from public.profiles p where p.id=auth.uid() and p.approved and p.active
    and ((d->>'kind'='personal_leave' and ((d->>'visibility'='private' and d->>'owner_id'=p.id::text) or (d->>'visibility'='hq' and p.role in ('admin','internal'))))
      or d->>'kind'='launch' or (d->>'kind'='factory_holiday' and p.role in ('admin','internal'))))
$$;
create function public.save_calendar_event(p_id uuid,p_expected_version integer,p_data jsonb,p_reason text)
returns public.calendar_events language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; oldrow public.calendar_events; result public.calendar_events; event_owner uuid; event_factory uuid; stamp timestamptz:=clock_timestamp();
begin
  actor:=public.operations_actor(); perform public.operations_reason(p_reason);
  if p_id is null or p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_VERSION'; end if;
  -- Actor row is a stable lock for concurrent first inserts by this user.
  perform 1 from public.profiles where id=actor.id for update;
  select * into oldrow from public.calendar_events where id=p_id for update;
  if oldrow.id is not null then
    if not public.can_read_calendar_event(p_id) or (oldrow.kind='personal_leave' and oldrow.owner_id<>actor.id and actor.role<>'admin') or (oldrow.kind<>'personal_leave' and actor.role not in ('admin','internal')) then raise exception 'FORBIDDEN: event edit not permitted' using errcode='42501'; end if;
  end if;
  if coalesce(oldrow.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  perform public.operations_shape(p_data,array['kind','visibility','title','startDate','endDate','ownerId','factoryId','note','deleted']);
  perform public.operations_text(p_data,'kind',30,true); perform public.operations_text(p_data,'visibility',10,true);
  perform public.operations_text(p_data,'title',200,true); perform public.operations_text(p_data,'note',10000);
  perform public.operations_text(p_data,'startDate',10,true); perform public.validate_sig_date(p_data->>'startDate');
  perform public.operations_text(p_data,'endDate',10,true); perform public.validate_sig_date(p_data->>'endDate');
  if (p_data->>'endDate')::date<(p_data->>'startDate')::date then raise exception 'INVALID_OPERATION: end date precedes start date'; end if;
  if p_data->>'kind' not in ('personal_leave','launch','factory_holiday') or p_data->>'visibility' not in ('private','hq','all') or jsonb_typeof(p_data->'deleted') is distinct from 'boolean' then raise exception 'INVALID_OPERATION: event kind/visibility'; end if;
  event_owner:=public.operations_uuid(p_data->>'ownerId');
  if p_data->'factoryId'<>'null'::jsonb then event_factory:=public.operations_uuid(p_data->>'factoryId'); end if;
  if oldrow.id is not null and (oldrow.kind<>p_data->>'kind' or oldrow.owner_id<>event_owner) then raise exception 'HISTORY_PROTECTED: event kind/owner cannot change'; end if;
  if not exists(select 1 from public.profiles where id=event_owner and approved and active) then raise exception 'INVALID_OPERATION: inactive event owner'; end if;
  if p_data->>'kind'='personal_leave' and event_owner<>actor.id and (actor.role<>'admin' or not exists(select 1 from public.profiles where id=event_owner and role in ('admin','internal'))) then raise exception 'FORBIDDEN: create personal events only for yourself' using errcode='42501'; end if;
  if p_data->>'kind'='personal_leave' then
    if event_factory is not null or p_data->>'visibility' not in ('private','hq') or (p_data->>'visibility'='hq' and actor.role not in ('admin','internal')) then raise exception 'FORBIDDEN: personal event visibility' using errcode='42501'; end if;
  elsif p_data->>'kind'='launch' then
    if actor.role not in ('admin','internal') or p_data->>'visibility'<>'all' or event_factory is not null then raise exception 'FORBIDDEN: launch events require headquarters and public visibility' using errcode='42501'; end if;
  else
    if actor.role not in ('admin','internal') or p_data->>'visibility'<>'hq' or event_factory is null then raise exception 'FORBIDDEN: factory holidays are headquarters-only' using errcode='42501'; end if;
    if not exists(select 1 from public.factories where id=event_factory) then raise exception 'INVALID_OPERATION: unknown factory'; end if;
  end if;
  if oldrow.id is null and (p_data->>'deleted')::boolean then raise exception 'INVALID_OPERATION: cannot create a deleted event'; end if;
  if oldrow.id is null then
    insert into public.calendar_events(id,kind,visibility,title,start_date,end_date,owner_id,factory_id,note,deleted_at,version,created_at,updated_at,updated_by)
    values(p_id,p_data->>'kind',p_data->>'visibility',p_data->>'title',(p_data->>'startDate')::date,(p_data->>'endDate')::date,event_owner,event_factory,p_data->>'note',null,1,stamp,stamp,actor.id) returning * into result;
  else
    update public.calendar_events set visibility=p_data->>'visibility',title=p_data->>'title',start_date=(p_data->>'startDate')::date,end_date=(p_data->>'endDate')::date,factory_id=event_factory,note=p_data->>'note',deleted_at=case when (p_data->>'deleted')::boolean then coalesce(deleted_at,stamp) else null end,version=version+1,updated_at=stamp,updated_by=actor.id where id=p_id returning * into result;
  end if;
  insert into public.calendar_event_audits(event_id,actor_id,actor_name,action,reason,before,after) values(p_id,actor.id,actor.name,case when result.deleted_at is not null then '일정 삭제' when oldrow.id is null then '일정 등록' else '일정 수정' end,trim(p_reason),case when oldrow.id is null then null else to_jsonb(oldrow) end,to_jsonb(result));
  return result;
end $$;

create function public.save_employee_factory_assignment(p_employee_id uuid,p_factory_ids uuid[],p_expected_version integer,p_reason text)
returns public.employee_factory_assignments language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; employee public.profiles; oldrow public.employee_factory_assignments; result public.employee_factory_assignments; stamp timestamptz:=clock_timestamp();
begin
  actor:=public.operations_actor(); if actor.role<>'admin' then raise exception 'FORBIDDEN: administrator required' using errcode='42501'; end if;
  perform public.operations_reason(p_reason);
  if p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_VERSION'; end if;
  select * into employee from public.profiles where id=p_employee_id and role in ('admin','internal') and approved and active for update;
  if not found then raise exception 'INVALID_OPERATION: choose an active headquarters employee'; end if;
  if p_factory_ids is null or cardinality(p_factory_ids)>100 or array_position(p_factory_ids,null) is not null or cardinality(p_factory_ids)<>(select count(distinct f) from unnest(p_factory_ids) f) then raise exception 'INVALID_OPERATION: invalid factory assignment list'; end if;
  if exists(select 1 from unnest(p_factory_ids) f where not exists(select 1 from public.factories where id=f)) then raise exception 'INVALID_OPERATION: unknown assigned factory'; end if;
  select * into oldrow from public.employee_factory_assignments where employee_id=p_employee_id for update;
  if coalesce(oldrow.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  if oldrow.employee_id is null then
    insert into public.employee_factory_assignments(employee_id,factory_ids,version,created_at,updated_at,updated_by) values(p_employee_id,p_factory_ids,1,stamp,stamp,actor.id) returning * into result;
  else
    update public.employee_factory_assignments set factory_ids=p_factory_ids,version=version+1,updated_at=stamp,updated_by=actor.id where employee_id=p_employee_id returning * into result;
  end if;
  insert into public.audits(actor_id,actor_name,action,reason,before,after) values(actor.id,actor.name,'본사 담당 공장 배정',trim(p_reason),case when oldrow.employee_id is null then null else to_jsonb(oldrow) end,to_jsonb(result));
  return result;
end $$;

-- Store only the requested original columns; labels remain the workbook's own
-- text instead of guessed business meanings. Kept HQ-only because other source
-- columns can contain costing/internal data not present in the public Style JSON.
create function public.validate_order_source_data(d jsonb) returns void language plpgsql immutable set search_path=public,pg_temp as $$
declare columns text[]:=array['A','F','L','M','S','V','W','X','Y','AQ','AR','AS','AT','AU','AV','AY']; item jsonb; cell jsonb; key text; seen integer[]:='{}'; row_number integer;
begin
  perform public.operations_shape(d,array['fileName','sheetName','headers','rows']);
  if octet_length(d::text)>1048576 then raise exception 'INVALID_ORDER_SOURCE: source payload exceeds 1MB'; end if;
  perform public.operations_text(d,'fileName',255,true); perform public.operations_text(d,'sheetName',100,true);
  perform public.operations_shape(d->'headers',columns);
  foreach key in array columns loop perform public.operations_text(d->'headers',key,4000); end loop;
  if jsonb_typeof(d->'rows') is distinct from 'array' or jsonb_array_length(d->'rows') not between 1 and 100 then raise exception 'INVALID_ORDER_SOURCE: 1 to 100 original rows required'; end if;
  for item in select * from jsonb_array_elements(d->'rows') loop
    perform public.operations_shape(item,array['rowNumber','columns']);
    if jsonb_typeof(item->'rowNumber') is distinct from 'number' or item->>'rowNumber' !~ '^[0-9]+$' or (item->>'rowNumber')::numeric not between 1 and 10000 then raise exception 'INVALID_ORDER_SOURCE: invalid row number'; end if;
    row_number:=(item->>'rowNumber')::integer;
    if row_number=any(seen) then raise exception 'INVALID_ORDER_SOURCE: duplicate row number'; end if; seen:=array_append(seen,row_number);
    perform public.operations_shape(item->'columns',columns);
    foreach key in array columns loop
      cell:=item->'columns'->key;
      if jsonb_typeof(cell) not in ('string','number','boolean','null') then raise exception 'INVALID_ORDER_SOURCE: primitive cell values only'; end if;
      if jsonb_typeof(cell)='string' and length(item->'columns'->>key)>4000 then raise exception 'INVALID_ORDER_SOURCE: cell text exceeds 4000 characters'; end if;
      if jsonb_typeof(cell)='number' and abs((item->'columns'->>key)::numeric)>1000000000000000 then raise exception 'INVALID_ORDER_SOURCE: cell numeric magnitude exceeded'; end if;
    end loop;
  end loop;
end $$;
create function public.save_order_source_record(p_style_id uuid,p_line_id uuid,p_expected_version integer,p_data jsonb,p_reason text)
returns public.order_source_records language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; s public.styles; oldrow public.order_source_records; result public.order_source_records; stamp timestamptz:=clock_timestamp();
begin
  actor:=public.operations_actor(); if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN: source records require headquarters' using errcode='42501'; end if;
  perform public.operations_reason(p_reason);
  if p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_VERSION'; end if;
  select * into s from public.styles where id=p_style_id and deleted_at is null for update;
  if not found or not public.can_access_style(p_style_id) then raise exception 'FORBIDDEN: inaccessible source style' using errcode='42501'; end if;
  if not exists(select 1 from jsonb_array_elements(s.data->'production') line where line->>'id'=p_line_id::text) then raise exception 'INVALID_ORDER_SOURCE: unknown production line'; end if;
  perform public.validate_order_source_data(p_data);
  select * into oldrow from public.order_source_records where style_id=p_style_id and line_id=p_line_id for update;
  if coalesce(oldrow.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT: source record changed' using errcode='40001'; end if;
  if oldrow.style_id is null then
    insert into public.order_source_records(style_id,line_id,file_name,sheet_name,headers,rows_data,version,created_at,updated_at,updated_by)
    values(p_style_id,p_line_id,p_data->>'fileName',p_data->>'sheetName',p_data->'headers',p_data->'rows',1,stamp,stamp,actor.id) returning * into result;
  else
    update public.order_source_records set file_name=p_data->>'fileName',sheet_name=p_data->>'sheetName',headers=p_data->'headers',rows_data=p_data->'rows',version=version+1,updated_at=stamp,updated_by=actor.id
    where style_id=p_style_id and line_id=p_line_id returning * into result;
  end if;
  -- Generic style audits are visible to assigned factories. Record the operation
  -- and versions, never the HQ-only filenames, headers or original cell values.
  insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after)
  values(p_style_id,actor.id,actor.name,'오더 원본 정보 수정',trim(p_reason),case when oldrow.style_id is null then null else jsonb_build_object('styleId',p_style_id,'lineId',p_line_id,'version',oldrow.version,'rowCount',jsonb_array_length(oldrow.rows_data)) end,
  jsonb_build_object('styleId',p_style_id,'lineId',p_line_id,'version',result.version,'rowCount',jsonb_array_length(result.rows_data)));
  return result;
end $$;

create function public.bulk_import_order_quantities(p_changes jsonb,p_mode text,p_reason text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; change jsonb; detail jsonb; sid uuid; line_id uuid; all_ids uuid[]:='{}'; seen_lines uuid[]:='{}'; s public.styles; item jsonb; updated_production jsonb; q jsonb; key text; amount numeric; line_count integer:=0; result jsonb:='[]'; saved public.styles;
begin
  actor:=public.operations_actor(); if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN: order import requires headquarters' using errcode='42501'; end if;
  perform public.operations_reason(p_reason);
  if p_mode is null or p_mode not in ('replace','add') or jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) not between 1 and 500 then raise exception 'INVALID_IMPORT: mode or style count'; end if;
  -- Validate every target first, then acquire all parent locks in deterministic
  -- UUID order to avoid deadlocks. Any later failure rolls back the whole call.
  for change in select * from jsonb_array_elements(p_changes) loop
    perform public.operations_shape(change,array['styleId','expectedVersion','lines']); sid:=public.operations_uuid(change->>'styleId');
    if sid=any(all_ids) then raise exception 'INVALID_IMPORT: duplicate style'; end if; all_ids:=array_append(all_ids,sid);
    if jsonb_typeof(change->'expectedVersion') is distinct from 'number' or change->>'expectedVersion' !~ '^[0-9]+$' or (change->>'expectedVersion')::numeric not between 1 and 2147483647 then raise exception 'INVALID_VERSION'; end if;
    if jsonb_typeof(change->'lines') is distinct from 'array' or jsonb_array_length(change->'lines')=0 then raise exception 'INVALID_IMPORT: lines required'; end if;
    line_count:=line_count+jsonb_array_length(change->'lines'); if line_count>1000 then raise exception 'INVALID_IMPORT: maximum 1000 lines'; end if;
    for detail in select * from jsonb_array_elements(change->'lines') loop
      perform public.operations_shape(detail,case when detail ? 'source' then array['lineId','color','quantities','source'] else array['lineId','color','quantities'] end); line_id:=public.operations_uuid(detail->>'lineId');
      if detail ? 'source' then
        perform public.operations_shape(detail->'source',array['expectedVersion','fileName','sheetName','headers','rows']);
        if jsonb_typeof(detail->'source'->'expectedVersion') is distinct from 'number' or detail->'source'->>'expectedVersion' !~ '^[0-9]+$' or (detail->'source'->>'expectedVersion')::numeric not between 0 and 2147483647 then raise exception 'INVALID_VERSION'; end if;
        perform public.validate_order_source_data((detail->'source')-'expectedVersion');
      end if;
      if line_id=any(seen_lines) then raise exception 'INVALID_IMPORT: duplicate production line'; end if; seen_lines:=array_append(seen_lines,line_id);
      if jsonb_typeof(detail->'color') is distinct from 'string' or detail->>'color' !~ '^[A-Z]{2}$' then raise exception 'INVALID_IMPORT: color'; end if;
      perform public.operations_quantities(detail->'quantities');
    end loop;
  end loop;
  perform 1 from public.styles where id=any(all_ids) order by id for update;
  for change in select * from jsonb_array_elements(p_changes) loop
    sid:=(change->>'styleId')::uuid;
    select * into s from public.styles where id=sid and deleted_at is null;
    if not found or not public.can_access_style(sid) then raise exception 'FORBIDDEN: inaccessible import style' using errcode='42501'; end if;
    if s.version<>(change->>'expectedVersion')::integer then raise exception 'VERSION_CONFLICT: import style changed' using errcode='40001'; end if;
    for detail in select * from jsonb_array_elements(change->'lines') loop
      if not exists(select 1 from jsonb_array_elements(s.data->'production') e where e.value->>'id'=detail->>'lineId' and e.value->>'color'=detail->>'color') then raise exception 'INVALID_IMPORT: line/color does not match style'; end if;
    end loop;
    updated_production:='[]';
    for item in select * from jsonb_array_elements(s.data->'production') loop
      select e.value into detail from jsonb_array_elements(change->'lines') e where e.value->>'lineId'=item->>'id';
      if detail is not null then
        q:='{}';
        foreach key in array array['XXS','XS','S','M','L','XL'] loop
          amount:=(detail->'quantities'->>key)::numeric+case when p_mode='add' then (item->'order'->>key)::numeric else 0 end;
          if amount>10000000 then raise exception 'INVALID_QUANTITIES: imported total exceeds 10000000'; end if;
          q:=q||jsonb_build_object(key,amount);
        end loop;
        item:=jsonb_set(item,'{order}',q);
      end if;
      updated_production:=updated_production||jsonb_build_array(item);
    end loop;
    saved:=public.save_style(sid,jsonb_set(s.data,'{production}',updated_production),s.version,trim(p_reason));
    for detail in select * from jsonb_array_elements(change->'lines') loop
      if detail ? 'source' then perform public.save_order_source_record(sid,(detail->>'lineId')::uuid,(detail->'source'->>'expectedVersion')::integer,(detail->'source')-'expectedVersion',trim(p_reason)); end if;
    end loop;
    result:=result||jsonb_build_array(jsonb_build_object('styleId',sid,'version',saved.version));
  end loop;
  return result;
end $$;

-- Approval and live style assignments remain the authority for every new table.
alter table public.po_dispatches enable row level security;
alter table public.po_dispatch_attempts enable row level security;
alter table public.operation_catalogs enable row level security;
alter table public.shipment_ledgers enable row level security;
alter table public.shipment_batches enable row level security;
alter table public.style_operations enable row level security;
alter table public.order_source_records enable row level security;
alter table public.calendar_events enable row level security;
alter table public.calendar_event_audits enable row level security;
alter table public.employee_factory_assignments enable row level security;
create policy po_dispatches_read on public.po_dispatches for select to authenticated using(public.can_access_style(style_id));
create policy po_attempts_read on public.po_dispatch_attempts for select to authenticated using(exists(select 1 from public.po_dispatches d where d.id=dispatch_id and public.can_access_style(d.style_id)));
create policy operation_catalogs_read on public.operation_catalogs for select to authenticated using(public.current_app_role() in ('admin','internal'));
create policy shipment_ledgers_read on public.shipment_ledgers for select to authenticated using(public.can_access_style(style_id));
create policy shipment_batches_read on public.shipment_batches for select to authenticated using(public.can_access_style(style_id));
create policy style_operations_read on public.style_operations for select to authenticated using(public.can_access_style(style_id));
create policy order_source_records_read on public.order_source_records for select to authenticated using(public.current_app_role() in ('admin','internal') and public.can_access_style(style_id));
create policy calendar_events_read on public.calendar_events for select to authenticated using(public.can_read_calendar_event(id));
create policy calendar_event_audits_read on public.calendar_event_audits for select to authenticated using(public.can_read_calendar_event(event_id) and public.can_read_calendar_snapshot(before) and public.can_read_calendar_snapshot(after));
create policy employee_assignments_read on public.employee_factory_assignments for select to authenticated using(public.current_app_role()='admin' or (public.current_app_role()='internal' and employee_id=auth.uid()));
revoke all on public.po_dispatches,public.po_dispatch_attempts,public.operation_catalogs,public.shipment_ledgers,public.shipment_batches,public.style_operations,public.calendar_events,public.calendar_event_audits,public.employee_factory_assignments,public.order_source_records from public,anon,authenticated;
grant select on public.po_dispatches,public.po_dispatch_attempts,public.operation_catalogs,public.shipment_ledgers,public.shipment_batches,public.style_operations,public.calendar_events,public.calendar_event_audits,public.employee_factory_assignments,public.order_source_records to authenticated;
revoke execute on function public.operations_actor(),public.operations_reason(text),public.operations_shape(jsonb,text[]),public.operations_text(jsonb,text,integer,boolean),public.operations_quantities(jsonb),public.operations_uuid(text),public.shipment_ledger_total(uuid,uuid),public.guard_shipment_aggregates(),public.validate_order_source_data(jsonb) from public,anon,authenticated;
revoke execute on function public.save_po_dispatch(uuid,uuid,integer,jsonb,text),public.begin_po_dispatch(uuid,integer),public.save_operation_catalog(uuid,text,text,boolean,integer,text),public.save_shipment_batch(uuid,uuid,uuid,integer,integer,jsonb,text),public.save_style_operation(uuid,uuid,text,integer,jsonb,text),public.can_read_calendar_event(uuid),public.can_read_calendar_snapshot(jsonb),public.save_calendar_event(uuid,integer,jsonb,text),public.save_employee_factory_assignment(uuid,uuid[],integer,text),public.bulk_import_order_quantities(jsonb,text,text),public.save_order_source_record(uuid,uuid,integer,jsonb,text) from public,anon;
grant execute on function public.save_po_dispatch(uuid,uuid,integer,jsonb,text),public.begin_po_dispatch(uuid,integer),public.save_operation_catalog(uuid,text,text,boolean,integer,text),public.save_shipment_batch(uuid,uuid,uuid,integer,integer,jsonb,text),public.save_style_operation(uuid,uuid,text,integer,jsonb,text),public.can_read_calendar_event(uuid),public.can_read_calendar_snapshot(jsonb),public.save_calendar_event(uuid,integer,jsonb,text),public.save_employee_factory_assignment(uuid,uuid[],integer,text),public.bulk_import_order_quantities(jsonb,text,text),public.save_order_source_record(uuid,uuid,integer,jsonb,text) to authenticated;

revoke execute on function public.finalize_po_dispatch(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.finalize_po_dispatch(uuid,text,text,text) to service_role;

do $$
declare t text;
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    foreach t in array array['po_dispatches','po_dispatch_attempts','operation_catalogs','shipment_ledgers','shipment_batches','style_operations','calendar_events','calendar_event_audits','employee_factory_assignments','order_source_records'] loop
      if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then execute format('alter publication supabase_realtime add table public.%I',t); end if;
    end loop;
  end if;
end $$;
-- BEGIN USER-APPROVED CATALOG SEED
-- Exact kinds supplied by the user, 2026-10-23. No work orders/auth accounts.
-- A NULL actor means migration-seeded; authenticated RPC writes always stamp actor.
insert into public.operation_catalogs(id,kind,name,active,version,updated_by) values
 ('61000000-0000-4000-8000-000000000001','label','포인트라벨(A직조 라벨)_32mm(21SSA55)',true,1,null),
 ('61000000-0000-4000-8000-000000000002','label','4개국어 케어라벨(3EA)(CA-05)',true,1,null),
 ('61000000-0000-4000-8000-000000000003','label','테트리스 레더 데님 택션지_70mm(SG-L01)',true,1,null),
 ('61000000-0000-4000-8000-000000000004','label','테트리스 레더 택션지_30mm(SG-L02)',true,1,null),
 ('61000000-0000-4000-8000-000000000005','label','A 레더 라벨(스키작업)(SG-L03)',true,1,null),
 ('61000000-0000-4000-8000-000000000006','label','테트리스 PU 레더 라벨_30mm(SG-L04)',true,1,null),
 ('61000000-0000-4000-8000-000000000007','label','포인트라벨(A직조라벨)_27mm(SG-L05)',true,1,null),
 ('61000000-0000-4000-8000-000000000008','label','테트리스 레더 데님 택션지_55mm (SG-L07)',true,1,null),
 ('61000000-0000-4000-8000-000000000009','label','반접이 포인트 라벨_24mm (SG-L08)',true,1,null),
 ('61000000-0000-4000-8000-000000000010','label','SV TAG 택션지_30mm(SG-L10)',true,1,null),
 ('61000000-0000-4000-8000-000000000011','label','메인라벨 대 반접(테닛x) SG-ML01(반접)',true,1,null),
 ('61000000-0000-4000-8000-000000000012','label','메인라벨 대 양접(테닛x) SG-ML01(양접)',true,1,null),
 ('61000000-0000-4000-8000-000000000013','label','메인라벨+레이저컷팅+심지부착 (SG-ML02)',true,1,null),
 ('61000000-0000-4000-8000-000000000014','label','시그니피컨트메인라벨(블랙) SG-ML03(반접)',true,1,null),
 ('61000000-0000-4000-8000-000000000015','label','시그니피컨트메인라벨(블랙) SG-ML03(양접)',true,1,null),
 ('61000000-0000-4000-8000-000000000016','label','시그니피컨트메인라벨(OW_데님용) SG-ML04(반접)',true,1,null),
 ('61000000-0000-4000-8000-000000000017','label','시그니피컨트메인라벨(OW_데님용) SG-ML04(양접)',true,1,null),
 ('61000000-0000-4000-8000-000000000018','label','영문 사이즈라벨(BL)(SG-SL01)',true,1,null),
 ('61000000-0000-4000-8000-000000000019','label','영문사이즈라벨(BK)(SG-SL02)',true,1,null),
 ('61000000-0000-4000-8000-000000000020','label','영문사이즈라벨(OW_데님용)(SG-SL03)',true,1,null),
 ('61000000-0000-4000-8000-000000000021','label','영문 사이즈라벨(OW)(SG-SL04)',true,1,null),
 ('61000000-0000-4000-8000-000000000022','label','테트리스 레더 패치_23mm(SG-W11)',true,1,null),
 ('61000000-0000-4000-8000-000000000023','label','시크릿코드라벨',true,1,null),
 ('62000000-0000-4000-8000-000000000001','embroidery','라벨 지그재그ST자수 SG-E01-TS',true,1,null),
 ('62000000-0000-4000-8000-000000000002','embroidery','라벨 지그재그ST자수 SG-E01-HW',true,1,null),
 ('62000000-0000-4000-8000-000000000003','embroidery','라벨 지그재그ST자수 SG-E01-KT',true,1,null),
 ('62000000-0000-4000-8000-000000000004','embroidery','라벨 지그재그ST자수 SG-E01-DENIM PT',true,1,null),
 ('62000000-0000-4000-8000-000000000005','embroidery','라벨 지그재그ST자수 SG-E01-DENIM SHT',true,1,null),
 ('62000000-0000-4000-8000-000000000006','embroidery','라벨 지그재그ST자수 SG-E01-DENIM JK',true,1,null),
 ('62000000-0000-4000-8000-000000000007','embroidery','라벨 지그재그ST자수 SG-E01-SH',true,1,null),
 ('62000000-0000-4000-8000-000000000008','embroidery','와끼 지그재그자수 SG-E02(데님)',true,1,null),
 ('62000000-0000-4000-8000-000000000009','embroidery','바스 SG-B03',true,1,null),
 ('62000000-0000-4000-8000-000000000010','embroidery','바스 SG-B04',true,1,null),
 ('62000000-0000-4000-8000-000000000011','embroidery','테트리스 자수 패치1 (트윌 다다미) SG-W01',true,1,null),
 ('62000000-0000-4000-8000-000000000012','embroidery','테트리스 자수 패치2 (트윌 다다미) SG-W02',true,1,null),
 ('62000000-0000-4000-8000-000000000013','embroidery','테트리스 자수 패치3 (트윌 다다미) SG-W03',true,1,null),
 ('62000000-0000-4000-8000-000000000014','embroidery','테트리스 자수 패치3 (트윌 다다미) SG-W03(양말)',true,1,null),
 ('62000000-0000-4000-8000-000000000015','embroidery','테트리스 자수 패치4 (트윌 다다미) SG-W09',true,1,null),
 ('62000000-0000-4000-8000-000000000016','embroidery','테트리스 직자수 SG-E03(양말)',true,1,null),
 ('62000000-0000-4000-8000-000000000017','embroidery','테트리스 자수 패치5 (트윌 다다미) SG-W10',true,1,null),
 ('62000000-0000-4000-8000-000000000018','embroidery','면사 3mm*3회 테두리 자수 SG-E04',true,1,null),
 ('62000000-0000-4000-8000-000000000019','embroidery','라벨 지그재그ST자수 SG-E01-DENIM(SV)',true,1,null),
 ('62000000-0000-4000-8000-000000000020','embroidery','지그재그 ST 자수_30mm SG-E02-CT(30mm)',true,1,null),
 ('62000000-0000-4000-8000-000000000021','embroidery','지그재그 ST 자수_26mm SG-E02-CT(26mm)',true,1,null),
 ('62000000-0000-4000-8000-000000000022','embroidery','BK TAG_지그재그 ST 자수_23mm SG-E03-BK TAG(23mm)-JK',true,1,null),
 ('62000000-0000-4000-8000-000000000023','embroidery','BK TAG_지그재그 ST 자수_23mm SG-E03-BK TAG(23mm)-TS',true,1,null),
 ('62000000-0000-4000-8000-000000000024','embroidery','BK TAG_지그재그 ST 자수_23mm SG-E03-BK TAG(23mm)-PT',true,1,null),
 ('62000000-0000-4000-8000-000000000025','embroidery','BK TAG_지그재그 ST 자수_23mm SG-E03-BK TAG(23mm)-SH',true,1,null),
 ('62000000-0000-4000-8000-000000000026','embroidery','시그_필기체 그림자 자수 SG-E07-01',true,1,null),
 ('62000000-0000-4000-8000-000000000027','embroidery','테트리스 BK 자수 패치1 (트윌 다다미) SG-BKW01',true,1,null),
 ('62000000-0000-4000-8000-000000000028','embroidery','테트리스 BK 자수 패치2 (트윌 다다미) SG-BKW02',true,1,null),
 ('62000000-0000-4000-8000-000000000029','embroidery','테트리스 BK 자수 패치3 (트윌 다다미) SG-BKW03',true,1,null),
 ('62000000-0000-4000-8000-000000000030','embroidery','시그_도쿄 일반(RD)+고무(OW) 2도자수 SG-P26',true,1,null),
 ('62000000-0000-4000-8000-000000000031','embroidery','시그_도쿄 체인자수(RD) SG-P27-2',true,1,null),
 ('62000000-0000-4000-8000-000000000032','embroidery','테트리스 BK 자수 패치3 (트윌 다다미) SG-BKW03_BY',true,1,null),
 ('62000000-0000-4000-8000-000000000033','embroidery','면사 2mm*3회 테두리 자수 (SV TAG) SG-E05',true,1,null)
on conflict do nothing;
-- END USER-APPROVED CATALOG SEED
commit;
