-- Apply after 026. Current factory assignments provide production-owner
-- defaults. Existing run snapshots, approvals and historical audits stay frozen.
begin;

create or replace function public.unique_factory_owner(p_factory_id uuid) returns uuid
language sql stable security definer set search_path='' as $$
 select case when count(*)=1 then (array_agg(p.id order by p.id))[1] else null end
 from public.profiles p join public.employee_factory_assignments a on a.employee_id=p.id
 where p.approved and p.active and p.withdrawn_at is null and p.role in ('admin','internal') and p_factory_id=any(a.factory_ids)
$$;

create or replace function public.factory_owner_defaults_json(p_data jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare owner_id uuid;production jsonb;
begin
 owner_id:=public.unique_factory_owner(nullif(p_data->>'factoryId','')::uuid);
 if owner_id is null then return p_data;end if;
 select coalesce(jsonb_agg(jsonb_set(item,'{ownerId}',to_jsonb(owner_id::text)) order by ordinal),'[]'::jsonb)
 into production from jsonb_array_elements(p_data->'production') with ordinality as rows(item,ordinal);
 return jsonb_set(jsonb_set(p_data,'{ownerId}',to_jsonb(owner_id::text)),'{production}',production);
end $$;

-- Preserve the complete existing save implementation (including future 026
-- callers), all field ACLs, optimistic versions and its original audit format.
do $$begin
 if to_regprocedure('public.save_style_before_factory_defaults(uuid,jsonb,integer,text)') is null then
  alter function public.save_style(uuid,jsonb,integer,text) rename to save_style_before_factory_defaults;
 end if;
end $$;
create or replace function public.save_style(p_id uuid,p_data jsonb,p_expected_version integer,p_reason text default '')
returns public.styles language plpgsql security definer set search_path='' as $$
declare current_style public.styles;
begin
 if public.current_app_role() in ('admin','internal') then
  -- Match movement/run writers' parent-first lock order. No assignment lock is
  -- taken here; an assignment save re-reads and synchronizes each parent later.
  select * into current_style from public.styles where id=p_id for update;
  if current_style.id is null or current_style.deleted_at is null and public.can_access_style(p_id) then
   -- Reject malformed supplied fields before deriving approved default owners.
   perform public.validate_style(p_id,p_data);
   p_data:=public.factory_owner_defaults_json(p_data);
  end if;
 end if;
 return public.save_style_before_factory_defaults(p_id,p_data,p_expected_version,p_reason);
end $$;

do $$begin
 if to_regprocedure('public.save_employee_factory_assignment_before_defaults(uuid,uuid[],integer,text)') is null then
  alter function public.save_employee_factory_assignment(uuid,uuid[],integer,text) rename to save_employee_factory_assignment_before_defaults;
 end if;
end $$;
create or replace function public.save_employee_factory_assignment(p_employee_id uuid,p_factory_ids uuid[],p_expected_version integer,p_reason text)
returns public.employee_factory_assignments language plpgsql security definer set search_path='' as $$
declare actor public.profiles;previous public.employee_factory_assignments;result public.employee_factory_assignments;s public.styles;derived jsonb;affected uuid[];
begin
 actor:=public.operations_actor();
 if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN: headquarters required' using errcode='42501';end if;
 -- Assignment changes serialize independently of ordinary style writes. Parent
 -- writers never wait on this lock while they hold a style row lock.
 perform pg_advisory_xact_lock(hashtextextended('sig:factory-owner-assignment',0));
 select * into previous from public.employee_factory_assignments where employee_id=p_employee_id;
 result:=public.save_employee_factory_assignment_before_defaults(p_employee_id,p_factory_ids,p_expected_version,p_reason);
 select coalesce(array_agg(distinct factory_id),'{}'::uuid[]) into affected
 from unnest(coalesce(previous.factory_ids,'{}'::uuid[])||coalesce(result.factory_ids,'{}'::uuid[])) factory_id;
 for s in select * from public.styles where deleted_at is null and nullif(data->>'factoryId','')::uuid=any(affected) order by id for update loop
  derived:=public.factory_owner_defaults_json(s.data);
  if derived is distinct from s.data then
   perform public.save_style(s.id,derived,s.version,p_reason);
  end if;
 end loop;
 return result;
end $$;

-- A new run records its current factory default once. Every existing run,
-- including an approved run with an unassigned owner, keeps its original
-- identity when factory assignments or receipt/version fields change.
create or replace function public.apply_new_run_factory_owner() returns trigger
language plpgsql security definer set search_path='' as $$
declare owner_id uuid;owner_name text;
begin
 if new.closed_at is not null or new.snapshot is not null then return new;end if;
 owner_id:=public.unique_factory_owner(new.factory_id_snapshot);
 if owner_id is not null then
  select name into owner_name from public.profiles where id=owner_id;
  new.owner_id_snapshot:=owner_id;new.owner_name_snapshot:=owner_name;
 end if;
 return new;
end $$;
drop trigger if exists production_run_factory_owner_default on public.production_runs;
create trigger production_run_factory_owner_default before insert on public.production_runs
for each row execute function public.apply_new_run_factory_owner();

revoke execute on function public.unique_factory_owner(uuid),public.factory_owner_defaults_json(jsonb),public.apply_new_run_factory_owner(),public.save_style_before_factory_defaults(uuid,jsonb,integer,text),public.save_employee_factory_assignment_before_defaults(uuid,uuid[],integer,text) from public,anon,authenticated,service_role;
revoke execute on function public.save_style(uuid,jsonb,integer,text),public.save_employee_factory_assignment(uuid,uuid[],integer,text) from public,anon,authenticated,service_role;
grant execute on function public.save_style(uuid,jsonb,integer,text),public.save_employee_factory_assignment(uuid,uuid[],integer,text) to authenticated;
commit;
