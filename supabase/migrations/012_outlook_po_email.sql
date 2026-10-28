-- Apply after 001-011. Microsoft 365 uses delegated browser OAuth/PKCE;
-- only public application identifiers are stored. No mail tokens or passwords.
-- Graph acceptance request IDs are kept separately from email message IDs.
begin;

create table if not exists public.outlook_configuration (
  singleton boolean primary key default true check(singleton),
  client_id uuid not null,
  tenant_id uuid not null,
  version integer not null check(version>0),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id) on delete restrict
);
alter table public.outlook_configuration enable row level security;
revoke all on public.outlook_configuration from public,anon,authenticated,service_role;

create or replace function public.get_outlook_configuration() returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare actor public.profiles; result jsonb;
begin
  actor:=public.operations_actor();
  if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN: headquarters account required' using errcode='42501';end if;
  select jsonb_build_object('clientId',client_id,'tenantId',tenant_id,'version',version,'updatedAt',updated_at)
    into result from public.outlook_configuration where singleton;
  return result;
end $$;
revoke execute on function public.get_outlook_configuration() from public,anon,authenticated,service_role;
grant execute on function public.get_outlook_configuration() to authenticated;

create or replace function public.save_outlook_configuration(p_client_id uuid,p_tenant_id uuid,p_expected_version integer,p_reason text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; oldrow public.outlook_configuration; result public.outlook_configuration; stamp timestamptz:=clock_timestamp();
begin
  actor:=public.operations_actor();
  if actor.role<>'admin' then raise exception 'FORBIDDEN: administrator required' using errcode='42501';end if;
  perform public.operations_reason(p_reason);
  if p_client_id is null or p_tenant_id is null then raise exception 'INVALID_OUTLOOK_CONFIGURATION: application and directory IDs required';end if;
  if p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_VERSION';end if;
  -- The same lock also protects concurrent first configuration inserts.
  perform pg_advisory_xact_lock(hashtextextended('sig:outlook-configuration',0));
  select * into oldrow from public.outlook_configuration where singleton for update;
  if coalesce(oldrow.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
  insert into public.outlook_configuration(singleton,client_id,tenant_id,version,updated_at,updated_by)
    values(true,p_client_id,p_tenant_id,coalesce(oldrow.version,0)+1,stamp,actor.id)
    on conflict(singleton) do update set client_id=excluded.client_id,tenant_id=excluded.tenant_id,
      version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by returning * into result;
  insert into public.audits(actor_id,actor_name,action,reason,before,after)
    values(actor.id,actor.name,'Outlook 발송 설정 변경',trim(p_reason),
      case when oldrow.singleton is null then null else to_jsonb(oldrow) end,to_jsonb(result));
  return jsonb_build_object('clientId',result.client_id,'tenantId',result.tenant_id,'version',result.version,'updatedAt',result.updated_at);
end $$;
revoke execute on function public.save_outlook_configuration(uuid,uuid,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.save_outlook_configuration(uuid,uuid,integer,text) to authenticated;

alter table public.po_dispatches
  add column if not exists provider text not null default 'resend',
  add column if not exists sender_email_snapshot text,
  add column if not exists provider_request_id text;
alter table public.po_dispatch_attempts
  add column if not exists provider text not null default 'resend',
  add column if not exists sender_email_snapshot text,
  add column if not exists provider_request_id text;

do $$declare c record;begin
  -- 003's unnamed CHECK required a Resend message ID for every sent record.
  -- Remove only that exact kind of constraint; retain every other legacy CHECK.
  for c in select conname from pg_constraint where conrelid='public.po_dispatches'::regclass and contype='c'
    and conname<>'po_dispatches_provider_evidence' and pg_get_constraintdef(oid) like '%provider_message_id%'
    and pg_get_constraintdef(oid) like '%sent_at%'
  loop execute format('alter table public.po_dispatches drop constraint %I',c.conname);end loop;
  if not exists(select 1 from pg_constraint where conrelid='public.po_dispatches'::regclass and conname='po_dispatches_provider_evidence') then
    alter table public.po_dispatches add constraint po_dispatches_provider_evidence check (
      (status='sent' and sent_at is not null and
        ((provider='resend' and provider_message_id is not null and provider_request_id is null)
          or (provider='outlook' and provider_message_id is null and provider_request_id is not null
            and sender_email_snapshot is not null and length(trim(provider_request_id)) between 1 and 500
            and length(trim(sender_email_snapshot)) between 3 and 254)))
      or (status<>'sent' and sent_at is null and provider_message_id is null and provider_request_id is null)
    );
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.po_dispatches'::regclass and conname='po_dispatches_provider_allowed') then
    alter table public.po_dispatches add constraint po_dispatches_provider_allowed check(provider in ('resend','outlook'));
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.po_dispatch_attempts'::regclass and conname='po_dispatch_attempts_provider_allowed') then
    alter table public.po_dispatch_attempts add constraint po_dispatch_attempts_provider_allowed check(provider in ('resend','outlook'));
  end if;
end $$;

-- Private core preserves original parent/style locks, authorization, version
-- checks, supplier terms protection and audit/attempt creation from 003/008.
do $$begin
  if to_regprocedure('public.begin_po_dispatch_before_outlook(uuid,integer)') is null then
    alter function public.begin_po_dispatch(uuid,integer) rename to begin_po_dispatch_before_outlook;
  end if;
end $$;
revoke execute on function public.begin_po_dispatch_before_outlook(uuid,integer) from public,anon,authenticated,service_role;

create or replace function public.begin_po_dispatch(p_id uuid,p_expected_version integer)
returns public.po_dispatches language plpgsql security definer set search_path=public,pg_temp as $$
declare result public.po_dispatches;
begin
  result:=public.begin_po_dispatch_before_outlook(p_id,p_expected_version);
  -- A different provider cannot retry an attempted Outlook dispatch. Raising
  -- rolls back the core's claim and audit insert in the same transaction.
  if result.provider<>'resend' then raise exception 'PO_PROVIDER_MISMATCH: create a new PO to change mail provider';end if;
  return result;
end $$;
revoke execute on function public.begin_po_dispatch(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.begin_po_dispatch(uuid,integer) to authenticated;

create or replace function public.begin_outlook_po_dispatch(p_id uuid,p_expected_version integer)
returns public.po_dispatches language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; before_row public.po_dispatches; result public.po_dispatches; sender text;
begin
  actor:=public.operations_actor();
  if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN: headquarters account required' using errcode='42501';end if;
  if not exists(select 1 from public.outlook_configuration where singleton) then raise exception 'OUTLOOK_CONFIGURATION_REQUIRED';end if;
  sender:=lower(trim(actor.email));
  if length(sender) not between 3 and 254 or sender !~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+\.[^[:space:]@,;<>]+$' then raise exception 'INVALID_OUTLOOK_SENDER: account email required';end if;
  result:=public.begin_po_dispatch_before_outlook(p_id,p_expected_version);
  if result.provider<>'outlook' and result.attempts>1 then raise exception 'PO_PROVIDER_MISMATCH: create a new PO to change mail provider';end if;
  if result.provider='outlook' and result.sender_email_snapshot is distinct from sender then raise exception 'PO_SENDER_MISMATCH: attempted PO sender cannot change';end if;
  before_row:=result;
  update public.po_dispatches set provider='outlook',sender_email_snapshot=sender
    where id=p_id returning * into result;
  update public.po_dispatch_attempts set provider='outlook',sender_email_snapshot=sender,
      snapshot=snapshot||jsonb_build_object('provider','outlook','senderEmail',sender)
    where dispatch_id=p_id and attempt=result.attempts and status='sending';
  if not found then raise exception 'PO_SEND_BLOCKED: attempt ledger mismatch';end if;
  insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after)
    values(result.style_id,actor.id,actor.name,'PO Outlook 발신자 확인','로그인한 본사 계정의 이메일로 발송',to_jsonb(before_row),to_jsonb(result));
  return result;
end $$;
revoke execute on function public.begin_outlook_po_dispatch(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.begin_outlook_po_dispatch(uuid,integer) to authenticated;

create or replace function public.finalize_outlook_po_dispatch(p_id uuid,p_request_id text,p_error text,p_outcome text)
returns public.po_dispatches language plpgsql security definer set search_path=public,pg_temp as $$
declare oldrow public.po_dispatches; result public.po_dispatches; actor public.profiles; stamp timestamptz:=clock_timestamp();
begin
  if p_outcome is null or p_outcome not in ('sent','failed','unknown') then raise exception 'INVALID_OPERATION: provider outcome';end if;
  if p_outcome='sent' and (length(trim(coalesce(p_request_id,''))) not between 1 and 500 or p_request_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' or p_error is not null) then
    raise exception 'INVALID_OPERATION: Microsoft accepted response request ID required';
  end if;
  if p_outcome<>'sent' and (p_request_id is not null or length(trim(coalesce(p_error,''))) not between 1 and 5000) then
    raise exception 'INVALID_OPERATION: failed/unknown requires error details';
  end if;
  select * into oldrow from public.po_dispatches where id=p_id for update;
  if not found or oldrow.status<>'sending' or oldrow.provider<>'outlook' then raise exception 'PO_SEND_BLOCKED: no Outlook sending attempt to finalize';end if;
  select * into actor from public.profiles where id=oldrow.updated_by;
  update public.po_dispatches set status=p_outcome,sent_at=case when p_outcome='sent' then stamp else null end,
      provider_message_id=null,provider_request_id=p_request_id,last_error=p_error,version=version+1,updated_at=stamp
    where id=p_id returning * into result;
  update public.po_dispatch_attempts set status=p_outcome,provider_message_id=null,provider_request_id=p_request_id,error=p_error,finished_at=stamp
    where dispatch_id=p_id and attempt=oldrow.attempts and status='sending' and provider='outlook' and sender_email_snapshot=oldrow.sender_email_snapshot;
  if not found then raise exception 'PO_SEND_BLOCKED: attempt ledger mismatch';end if;
  insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after)
    values(result.style_id,actor.id,actor.name,
      case when p_outcome='sent' then 'PO Outlook Microsoft 접수 확인' when p_outcome='failed' then 'PO Outlook 발송 실패' else 'PO Outlook 결과 미확인' end,
      coalesce(p_error,'Microsoft 접수 추적 ID: '||p_request_id),to_jsonb(oldrow),to_jsonb(result));
  return result;
end $$;
revoke execute on function public.finalize_outlook_po_dispatch(uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.finalize_outlook_po_dispatch(uuid,text,text,text) to service_role;

-- Supplier consent retains the actual provider evidence without mistaking a
-- Microsoft acceptance request ID for an email message identifier.
create or replace function public.supplier_order_po_snapshot(po public.po_dispatches) returns jsonb
language sql immutable set search_path=public,pg_temp as $$
  select jsonb_build_object('id',po.id,'version',po.version,'recipient',po.recipient,'subject',po.subject,'body',po.body,'dueDate',po.due_date::text,
    'sentAt',po.sent_at,'providerMessageId',po.provider_message_id,'provider',po.provider,
    'providerRequestId',po.provider_request_id,'senderEmail',po.sender_email_snapshot,
    'evidenceAttachmentId',po.evidence_attachment_id,'factoryId',po.factory_id_snapshot,'styleCode',po.style_code_snapshot)
$$;
revoke execute on function public.supplier_order_po_snapshot(public.po_dispatches) from public,anon,authenticated,service_role;

notify pgrst,'reload schema';
commit;
