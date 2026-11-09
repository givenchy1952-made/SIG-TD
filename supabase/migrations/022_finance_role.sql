-- Apply after 021. Adds a read-only FA role without changing existing accounts.
-- Finance's dedicated projection and financial records are supplied by 023.
-- No styles, orders, approvals, shipments, settlements or histories are reset.
begin;

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check(role in ('admin','internal','factory','finance'));

create or replace function public.get_finance_role_capability() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles where id=auth.uid() and active and approved and role in ('admin','internal'))
$$;
revoke execute on function public.get_finance_role_capability() from public,anon,service_role;
grant execute on function public.get_finance_role_capability() to authenticated;

-- Finance must not inherit any of the production-side non-factory branches.
-- Returning NULL here also closes existing RLS predicates for production data.
create or replace function public.current_app_role() returns text language sql stable security definer set search_path='' as $$
 select p.role from public.profiles p where p.id=auth.uid() and p.approved and p.active and p.role in ('admin','internal','factory') and not public.is_inspection_actor()
$$;
revoke execute on function public.current_app_role() from public,anon,service_role;
grant execute on function public.current_app_role() to authenticated;
create or replace function public.operations_actor() returns public.profiles language plpgsql stable security definer set search_path='' as $$
declare actor public.profiles;
begin
 select * into actor from public.profiles where id=auth.uid() and approved and active and role in ('admin','internal','factory');
 if not found or public.is_inspection_actor() then raise exception 'FORBIDDEN: approved production or HQ account required' using errcode='42501';end if;
 return actor;
end $$;
revoke execute on function public.operations_actor() from public,anon,service_role;
-- Existing public RPCs call this internal helper as their definer.
revoke execute on function public.operations_actor() from authenticated;

create or replace function public.get_workflow_refinements_capability() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles where id=auth.uid() and approved and active and role in ('admin','internal','factory'))
$$;

-- Launch and own-leave visibility previously applied to any approved account.
-- Keep those scopes for production roles while excluding finance entirely.
create or replace function public.can_read_calendar_event(p_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.calendar_events e join public.profiles p on p.id=auth.uid() and p.approved and p.active and p.role in ('admin','internal','factory')
  where e.id=p_id and ((e.kind='personal_leave' and ((e.visibility='private' and e.owner_id=p.id) or (e.visibility='hq' and p.role in ('admin','internal'))))
   or e.kind='launch' or (e.kind='factory_holiday' and p.role in ('admin','internal'))))
$$;
create or replace function public.can_read_calendar_snapshot(d jsonb) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p where p.id=auth.uid() and p.approved and p.active and p.role in ('admin','internal','factory')
  and (d is null or ((d->>'kind'='personal_leave' and ((d->>'visibility'='private' and d->>'owner_id'=p.id::text) or (d->>'visibility'='hq' and p.role in ('admin','internal'))))
   or d->>'kind'='launch' or (d->>'kind'='factory_holiday' and p.role in ('admin','internal')))))
$$;

-- Explicit role authorization is required before the new-style branch. The
-- remaining save/version/production protections are identical to existing 001.
create or replace function public.save_style(p_id uuid,p_data jsonb,p_expected_version integer,p_reason text default '')
returns public.styles language plpgsql security definer set search_path = public, pg_temp as $$
declare actor public.profiles; oldrow public.styles; result public.styles; d jsonb; o jsonb; item jsonb; previous jsonb; role_name text; changed_dates boolean:=false; key text; stamp timestamptz:=clock_timestamp(); clean_samples jsonb:='[]';
begin
  select * into actor from public.profiles where id=auth.uid() and approved and active and role in ('admin','internal','factory');
  if not found then raise exception 'FORBIDDEN: administrator approval required' using errcode='42501'; end if;
  role_name:=actor.role;
  if p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_VERSION'; end if;
  if length(coalesce(p_reason,''))>1000 then raise exception 'INVALID_REASON'; end if;
  select * into oldrow from public.styles where id=p_id for update;
  -- Authorize before validating references: inaccessible IDs are not an oracle.
  if oldrow.id is not null and (oldrow.deleted_at is not null or not public.can_access_style(p_id)) then raise exception 'FORBIDDEN: inaccessible style' using errcode='42501'; end if;
  if oldrow.id is null and role_name='factory' then raise exception 'FORBIDDEN: only headquarters can register styles' using errcode='42501'; end if;
  perform public.validate_style(p_id,p_data);
  if oldrow.id is not null then
    if oldrow.deleted_at is not null or not public.can_access_style(p_id) then raise exception 'FORBIDDEN: inaccessible style' using errcode='42501'; end if;
    if oldrow.version<>p_expected_version then raise exception 'VERSION_CONFLICT: reload the latest version before saving' using errcode='40001'; end if;
    o:=oldrow.data;
    -- Existing samples and production records are never removed or renumbered.
    for previous in select * from jsonb_array_elements(o->'samples') loop
      select value into item from jsonb_array_elements(p_data->'samples') where value->>'id'=previous->>'id';
      if item is null or (item->'round') is distinct from (previous->'round') or (item->'isPP') is distinct from (previous->'isPP') then raise exception 'HISTORY_PROTECTED: sample deletion/renumbering is forbidden'; end if;
    end loop;
    for previous in select * from jsonb_array_elements(o->'production') loop
      select value into item from jsonb_array_elements(p_data->'production') where value->>'id'=previous->>'id';
      if item is null or (item->'color') is distinct from (previous->'color') then raise exception 'HISTORY_PROTECTED: production deletion/color changes are forbidden'; end if;
    end loop;
    if role_name='factory' then
      if (p_data-array['samples','production','version','updatedAt','updatedBy','deletedAt']) is distinct from (o-array['samples','production','version','updatedAt','updatedBy','deletedAt']) then raise exception 'FORBIDDEN_FIELD: factory cannot change headquarters fields' using errcode='42501'; end if;
      if jsonb_array_length(p_data->'samples')<>jsonb_array_length(o->'samples') or jsonb_array_length(p_data->'production')<>jsonb_array_length(o->'production') then raise exception 'FORBIDDEN_FIELD: factory cannot add records' using errcode='42501'; end if;
      for item in select * from jsonb_array_elements(p_data->'samples') loop
        select value into previous from jsonb_array_elements(o->'samples') where value->>'id'=item->>'id';
        if (item-array['status','plannedAt','completedAt','shippedAt','tracking','factoryComment','updatedAt']) is distinct from (previous-array['status','plannedAt','completedAt','shippedAt','tracking','factoryComment','updatedAt']) then raise exception 'FORBIDDEN_FIELD: sample headquarters fields' using errcode='42501'; end if;
        if (item->'status') is distinct from (previous->'status') and (item->>'status'='approved' or previous->>'status'='approved') then raise exception 'FORBIDDEN_FIELD: final approval' using errcode='42501'; end if;
        if item is distinct from previous and item->>'factoryId'<>actor.factory_id::text then raise exception 'FORBIDDEN_FIELD: sample belongs to another factory' using errcode='42501'; end if;
      end loop;
      for item in select * from jsonb_array_elements(p_data->'production') loop
        select value into previous from jsonb_array_elements(o->'production') where value->>'id'=item->>'id';
        if (item-array['shipped','confirmDue','shippedAt','receivedAt','invoice','measurements','factoryComment']) is distinct from (previous-array['shipped','confirmDue','shippedAt','receivedAt','invoice','measurements','factoryComment']) then raise exception 'FORBIDDEN_FIELD: production headquarters fields' using errcode='42501'; end if;
      end loop;
    elsif role_name='internal' then
      for item in select * from jsonb_array_elements(p_data->'production') loop
        select value into previous from jsonb_array_elements(o->'production') where value->>'id'=item->>'id';
        if previous is null then
          if item->'shipped'<>'{"XXS":0,"XS":0,"S":0,"M":0,"L":0,"XL":0}'::jsonb or item->'received'<>'{"XXS":0,"XS":0,"S":0,"M":0,"L":0,"XL":0}'::jsonb then raise exception 'FORBIDDEN_FIELD: shipment/receipt quantities' using errcode='42501'; end if;
        elsif (item->'shipped') is distinct from (previous->'shipped') or (item->'received') is distinct from (previous->'received') then raise exception 'FORBIDDEN_FIELD: shipment/receipt quantities' using errcode='42501'; end if;
      end loop;
    end if;
    if p_data->'dueDate' is distinct from o->'dueDate' then changed_dates:=true; end if;
    for item in select * from jsonb_array_elements(p_data->'samples') loop
      select value into previous from jsonb_array_elements(o->'samples') where value->>'id'=item->>'id';
      if previous is not null then
        foreach key in array array['requestedAt','plannedAt','completedAt','shippedAt','receivedAt','reviewedAt'] loop
          if item->key is distinct from previous->key then changed_dates:=true; end if;
        end loop;
      end if;
    end loop;
    for item in select * from jsonb_array_elements(p_data->'production') loop
      select value into previous from jsonb_array_elements(o->'production') where value->>'id'=item->>'id';
      if previous is not null then
        foreach key in array array['confirmDue','shippedAt','receivedAt','paymentDue'] loop
          if item->key is distinct from previous->key then changed_dates:=true; end if;
        end loop;
      end if;
    end loop;
    if changed_dates and length(trim(coalesce(p_reason,'')))<2 then raise exception 'REASON_REQUIRED: date changes require a reason'; end if;
  else
    if role_name='factory' then raise exception 'FORBIDDEN: only headquarters can register styles' using errcode='42501'; end if;
    if p_expected_version<>0 then raise exception 'VERSION_CONFLICT: style does not exist' using errcode='40001'; end if;
    if role_name='internal' and exists(select 1 from jsonb_array_elements(p_data->'production') e where e.value->'shipped'<>'{"XXS":0,"XS":0,"S":0,"M":0,"L":0,"XL":0}'::jsonb or e.value->'received'<>'{"XXS":0,"XS":0,"S":0,"M":0,"L":0,"XL":0}'::jsonb) then raise exception 'FORBIDDEN_FIELD: shipment/receipt quantities' using errcode='42501'; end if;
  end if;
  -- Server stamps metadata; caller-supplied actor/time/version never become authoritative.
  for item in select * from jsonb_array_elements(p_data->'samples') loop
    select value into previous from jsonb_array_elements(coalesce(oldrow.data->'samples','[]'::jsonb)) where value->>'id'=item->>'id';
    -- A timestamp-only client edit is ignored; genuine content edits get the
    -- same authoritative clock as the parent style. This runs after field ACLs.
    if previous is null or (item-'updatedAt') is distinct from (previous-'updatedAt') then
      item:=jsonb_set(item,'{updatedAt}',to_jsonb(stamp));
    else
      item:=jsonb_set(item,'{updatedAt}',previous->'updatedAt');
    end if;
    clean_samples:=clean_samples||jsonb_build_array(item);
  end loop;
  d:=p_data||jsonb_build_object('id',p_id,'samples',clean_samples,'version',coalesce(oldrow.version,0)+1,'updatedAt',stamp,'updatedBy',actor.id,'deletedAt',null);
  if oldrow.id is null then
    insert into public.styles(id,data,version,updated_at,updated_by) values(p_id,d,1,stamp,actor.id) returning * into result;
  else
    update public.styles set data=d,version=oldrow.version+1,updated_at=stamp,updated_by=actor.id where id=p_id returning * into result;
  end if;
  insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after) values(p_id,actor.id,actor.name,case when oldrow.id is null then '스타일 등록' else '스타일 수정' end,coalesce(p_reason,''),oldrow.data,d);
  return result;
exception when unique_violation then
  raise exception 'DUPLICATE_STYLE: style code or identifier already exists' using errcode='23505';
end $$;

-- Only administrators can grant or maintain FA access. Signup continues to
-- create an unapproved internal profile irrespective of Auth metadata.
create or replace function public.manage_profile(p_id uuid,p_name text,p_role text,p_approved boolean,p_active boolean,p_factory_id uuid default null)
returns public.profiles language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; oldrow public.profiles; result public.profiles;
begin
  -- Serialise account management, including concurrent administrator handovers.
  perform pg_advisory_xact_lock(hashtextextended('sig:manage-profile',0));
  select * into actor from public.profiles where id=auth.uid() and approved and active and role in ('admin','internal');
  if not found then raise exception 'FORBIDDEN: approved headquarters account required' using errcode='42501'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or p_role is null or p_role not in ('admin','internal','factory','finance') or p_approved is null or p_active is null then raise exception 'INVALID_PROFILE: name, role and account state required'; end if;
  select * into oldrow from public.profiles where id=p_id for update;
  if not found then raise exception 'NOT_FOUND: user must sign up first'; end if;
  if actor.role='internal' then
    if p_id=actor.id or oldrow.role in ('admin','finance') or p_role in ('admin','finance') then raise exception 'FORBIDDEN: administrators and own account cannot be managed by staff' using errcode='42501'; end if;
    -- Staff may approve a new active signup, and maintain factory accounts.
    -- Existing approved headquarters accounts remain administrator-managed.
    if not ((not oldrow.approved and oldrow.active) or (oldrow.role='factory' and p_role='factory')) then raise exception 'FORBIDDEN: existing headquarters accounts require an administrator' using errcode='42501'; end if;
  end if;
  if actor.role='admin' and p_id=actor.id and (p_role<>'admin' or not p_approved or not p_active) then raise exception 'LAST_ADMIN_PROTECTED: you cannot revoke your own administrator access'; end if;
  if p_role='factory' and (p_factory_id is null or not exists(select 1 from public.factories where id=p_factory_id)) then raise exception 'INVALID_PROFILE: choose a registered factory'; end if;
  update public.profiles set name=trim(p_name),role=p_role,approved=p_approved,active=p_active,factory_id=case when p_role='factory' then p_factory_id else null end where id=p_id returning * into result;
  insert into public.audits(actor_id,actor_name,action,reason,before,after)
    values(actor.id,actor.name,'사용자 권한 변경',case when actor.role='admin' then '관리자 승인 및 계정 관리' else '본사 승인 및 공장 배정' end,to_jsonb(oldrow),to_jsonb(result));
  return result;
end $$;
revoke execute on function public.manage_profile(uuid,text,text,boolean,boolean,uuid) from public,anon;
grant execute on function public.manage_profile(uuid,text,text,boolean,boolean,uuid) to authenticated;

commit;
