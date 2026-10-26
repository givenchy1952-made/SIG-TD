-- Apply after 001-009. Reapplying this file preserves withdrawal history.
-- Withdrawal revokes workspace access; it does not
-- delete Auth identities, production records, financial history or files.
begin;

alter table public.profiles
  add column if not exists withdrawn_at timestamptz,
  add column if not exists withdrawn_by uuid references public.profiles(id) on delete restrict;
do $$begin
  if not exists(select 1 from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_withdrawal_marker') then
    alter table public.profiles add constraint profiles_withdrawal_marker check ((withdrawn_at is null) = (withdrawn_by is null));
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_withdrawal_access') then
    alter table public.profiles add constraint profiles_withdrawal_access check (withdrawn_at is null or (not active and not approved));
  end if;
end $$;

create or replace function public.get_member_withdrawal_capability() returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.profiles where id=auth.uid() and role='admin' and approved and active)
$$;
revoke execute on function public.get_member_withdrawal_capability() from public,anon;
grant execute on function public.get_member_withdrawal_capability() to authenticated;

-- 006 permits staff to maintain ordinary factory accounts. A withdrawn member
-- is administrator-managed, including later restoration through manage_profile.
create or replace function public.protect_member_withdrawal() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare actor_role text;
begin
  if old.withdrawn_at is not null or new.withdrawn_at is distinct from old.withdrawn_at or new.withdrawn_by is distinct from old.withdrawn_by then
    select role into actor_role from public.profiles where id=auth.uid() and active and approved;
    if actor_role is distinct from 'admin' then raise exception 'FORBIDDEN: withdrawn members require an administrator' using errcode='42501';end if;
    if old.withdrawn_at is not null then
      if new.active and new.approved then
        new.withdrawn_at:=null;new.withdrawn_by:=null;
      elsif new.withdrawn_at is distinct from old.withdrawn_at or new.withdrawn_by is distinct from old.withdrawn_by then
        raise exception 'HISTORY_PROTECTED: restore approval and activation together';
      end if;
    elsif new.withdrawn_at is null or new.withdrawn_by is distinct from auth.uid() or new.active or new.approved then
      raise exception 'INVALID_WITHDRAWAL: withdrawal must revoke approval and activation';
    end if;
  end if;
  return new;
end $$;
do $$begin
  if not exists(select 1 from pg_trigger where tgrelid='public.profiles'::regclass and tgname='profiles_withdrawal_protected' and not tgisinternal) then
    create trigger profiles_withdrawal_protected before update on public.profiles
    for each row execute function public.protect_member_withdrawal();
  end if;
end $$;
revoke execute on function public.protect_member_withdrawal() from public,anon,authenticated;

create or replace function public.withdraw_workspace_member(p_id uuid,p_reason text)
returns public.profiles language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;oldrow public.profiles;result public.profiles;stamp timestamptz:=clock_timestamp();
begin
  -- Share the account-management lock with 006. Re-check the actor after the
  -- lock so two administrators cannot withdraw each other concurrently.
  perform pg_advisory_xact_lock(hashtextextended('sig:manage-profile',0));
  select * into actor from public.profiles where id=auth.uid() and role='admin' and approved and active;
  if not found then raise exception 'FORBIDDEN: active approved administrator required' using errcode='42501';end if;
  perform public.operations_reason(p_reason);
  if p_id is null then raise exception 'NOT_FOUND: choose a registered member';end if;
  if p_id=actor.id then raise exception 'LAST_ADMIN_PROTECTED: you cannot withdraw your own account';end if;
  select * into oldrow from public.profiles where id=p_id for update;
  if not found then raise exception 'NOT_FOUND: choose a registered member';end if;
  if oldrow.withdrawn_at is not null then raise exception 'ALREADY_WITHDRAWN: member has already left';end if;
  update public.profiles set approved=false,active=false,withdrawn_at=stamp,withdrawn_by=actor.id where id=p_id returning * into result;
  insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after,created_at)
    values(null,actor.id,actor.name,'구성원 탈퇴',trim(p_reason),to_jsonb(oldrow),to_jsonb(result),stamp);
  return result;
end $$;
revoke execute on function public.withdraw_workspace_member(uuid,text) from public,anon;
grant execute on function public.withdraw_workspace_member(uuid,text) to authenticated;

commit;
