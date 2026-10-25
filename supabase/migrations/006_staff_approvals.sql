-- Apply once after 001-005. No accounts or business data are reset.
-- Signup email confirmation is an Auth setting; disable Confirm email in the
-- Supabase dashboard separately. This migration delegates only staff approval.
begin;

create function public.get_staff_approvals_capability() returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.profiles where id=auth.uid() and approved and active and role in ('admin','internal'))
$$;
revoke execute on function public.get_staff_approvals_capability() from public,anon;
grant execute on function public.get_staff_approvals_capability() to authenticated;

create or replace function public.manage_profile(p_id uuid,p_name text,p_role text,p_approved boolean,p_active boolean,p_factory_id uuid default null)
returns public.profiles language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; oldrow public.profiles; result public.profiles;
begin
  -- Serialise account management, including concurrent administrator handovers.
  perform pg_advisory_xact_lock(hashtextextended('sig:manage-profile',0));
  select * into actor from public.profiles where id=auth.uid() and approved and active and role in ('admin','internal');
  if not found then raise exception 'FORBIDDEN: approved headquarters account required' using errcode='42501'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]' or p_role is null or p_role not in ('admin','internal','factory') or p_approved is null or p_active is null then raise exception 'INVALID_PROFILE: name, role and account state required'; end if;
  select * into oldrow from public.profiles where id=p_id for update;
  if not found then raise exception 'NOT_FOUND: user must sign up first'; end if;
  if actor.role='internal' then
    if p_id=actor.id or oldrow.role='admin' or p_role='admin' then raise exception 'FORBIDDEN: administrators and own account cannot be managed by staff' using errcode='42501'; end if;
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


-- Assignments are headquarters workload metadata, not external factory ACLs.
-- Staff can assign approved internal employees; administrators retain control
-- of administrator account assignments.
create or replace function public.save_employee_factory_assignment(p_employee_id uuid,p_factory_ids uuid[],p_expected_version integer,p_reason text)
returns public.employee_factory_assignments language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; employee public.profiles; oldrow public.employee_factory_assignments; result public.employee_factory_assignments; stamp timestamptz:=clock_timestamp();
begin
  actor:=public.operations_actor();
  if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN: approved headquarters account required' using errcode='42501'; end if;
  perform public.operations_reason(p_reason);
  if p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_VERSION'; end if;
  select * into employee from public.profiles where id=p_employee_id and role in ('admin','internal') and approved and active for update;
  if not found then raise exception 'INVALID_OPERATION: choose an active headquarters employee'; end if;
  if actor.role='internal' and employee.role<>'internal' then raise exception 'FORBIDDEN: administrator assignments require an administrator' using errcode='42501'; end if;
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
revoke execute on function public.save_employee_factory_assignment(uuid,uuid[],integer,text) from public,anon;
grant execute on function public.save_employee_factory_assignment(uuid,uuid[],integer,text) to authenticated;
drop policy employee_assignments_read on public.employee_factory_assignments;
create policy employee_assignments_read on public.employee_factory_assignments for select to authenticated using(public.current_app_role() in ('admin','internal'));

commit;
