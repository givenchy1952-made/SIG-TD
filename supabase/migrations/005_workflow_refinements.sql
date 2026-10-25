-- Apply once after 001, 002, 003 and 004. Existing quantities/history are retained.
begin;
alter table public.projects add column code text not null default '' check(length(code)<=120 and code !~ '[[:cntrl:]]');
create unique index projects_code_unique on public.projects(lower(trim(code))) where trim(code)<>'';
create function public.get_workflow_refinements_capability() returns boolean language sql stable security definer set search_path=public,pg_temp as $$select exists(select 1 from public.profiles where id=auth.uid() and approved and active)$$;
revoke execute on function public.get_workflow_refinements_capability() from public,anon;
grant execute on function public.get_workflow_refinements_capability() to authenticated;

alter table public.calendar_events add column leave_type text not null default 'full' check(leave_type in ('full','am','pm','two_hours'));
alter table public.calendar_events add column start_time text not null default '';
alter table public.calendar_events add column end_time text not null default '';
alter function public.save_calendar_event(uuid,integer,jsonb,text) rename to save_calendar_event_v1;
revoke execute on function public.save_calendar_event_v1(uuid,integer,jsonb,text) from public,anon,authenticated;
create function public.save_calendar_event(p_id uuid,p_expected_version integer,p_data jsonb,p_reason text)
returns public.calendar_events language plpgsql security definer set search_path=public,pg_temp as $$
declare result public.calendar_events; prior public.calendar_events; subtype text; starts text; ends text; actor public.profiles;
begin
 actor:=public.operations_actor();
 if p_data ? 'leaveType' then perform public.operations_text(p_data,'leaveType',20,true); end if;
 if p_data ? 'startTime' then perform public.operations_text(p_data,'startTime',5); end if;
 if p_data ? 'endTime' then perform public.operations_text(p_data,'endTime',5); end if;
 select * into prior from public.calendar_events where id=p_id for update;
 if prior.id is not null and (not public.can_read_calendar_event(p_id) or (prior.kind='personal_leave' and prior.owner_id<>actor.id and actor.role<>'admin') or (prior.kind<>'personal_leave' and actor.role not in ('admin','internal'))) then raise exception 'FORBIDDEN: event edit not permitted' using errcode='42501'; end if;
 subtype:=coalesce(p_data->>'leaveType',prior.leave_type,'full'); starts:=coalesce(p_data->>'startTime',prior.start_time,''); ends:=coalesce(p_data->>'endTime',prior.end_time,'');
 if subtype not in ('full','am','pm','two_hours') or (p_data->>'kind'<>'personal_leave' and (subtype<>'full' or starts<>'' or ends<>'')) then raise exception 'INVALID_LEAVE: personal leave subtype'; end if;
 if subtype<>'full' and p_data->>'startDate'<>p_data->>'endDate' then raise exception 'INVALID_LEAVE: partial leave must be one day'; end if;
 if subtype='two_hours' then
  if starts !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or ends !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or ends::time-starts::time<>interval '2 hours' then raise exception 'INVALID_LEAVE: exact two-hour interval required'; end if;
 elsif starts<>'' or ends<>'' then raise exception 'INVALID_LEAVE: times only for two-hour leave'; end if;
 result:=public.save_calendar_event_v1(p_id,p_expected_version,p_data-array['leaveType','startTime','endTime'],p_reason);
 update public.calendar_events set leave_type=subtype,start_time=starts,end_time=ends where id=p_id returning * into result;
 update public.calendar_event_audits set after=to_jsonb(result) where event_id=p_id and (after->>'version')::integer=result.version;
 return result;
end $$;
revoke execute on function public.save_calendar_event(uuid,integer,jsonb,text) from public,anon;
grant execute on function public.save_calendar_event(uuid,integer,jsonb,text) to authenticated;

create table public.production_details (
 style_id uuid not null references public.styles(id),line_id uuid not null,data jsonb not null,version integer not null check(version>0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),updated_by uuid not null references public.profiles(id),primary key(style_id,line_id)
);
create function public.validate_production_details(d jsonb) returns void language plpgsql immutable set search_path=public,pg_temp as $$
declare q jsonb; rows jsonb; item jsonb; val jsonb; part text; seen text[];
begin
 perform public.operations_shape(d,array['quality','measurements']); q:=d->'quality';
 perform public.operations_shape(q,array['category','quantity','status','requestedAt','completedAt','note']);
 perform public.operations_text(q,'category',20); perform public.operations_text(q,'note',5000);
 if q->>'category' not in ('','아우터','니트','티셔츠','바지','가방','악세사리','모자') or q->>'status' not in ('unset','todo','progress','done','approved','delayed') or jsonb_typeof(q->'status')<>'string' then raise exception 'INVALID_DETAILS: quality category/status'; end if;
 if jsonb_typeof(q->'quantity') is distinct from 'number' or (q->>'quantity')::numeric<0 or (q->>'quantity')::numeric>10000000 or trunc((q->>'quantity')::numeric)<>(q->>'quantity')::numeric then raise exception 'INVALID_DETAILS: inspection quantity'; end if;
 perform public.operations_text(q,'requestedAt',10); perform public.operations_text(q,'completedAt',10); perform public.validate_sig_date(q->>'requestedAt'); perform public.validate_sig_date(q->>'completedAt');
 perform public.operations_shape(d->'measurements',array['upper','lower']);
 foreach part in array array['upper','lower'] loop
  rows:=d->'measurements'->part; seen:=array[]::text[];
  if jsonb_typeof(rows) is distinct from 'array' or jsonb_array_length(rows) not between 1 and 30 then raise exception 'INVALID_DETAILS: 1-30 measurement positions'; end if;
  for item in select * from jsonb_array_elements(rows) loop
   perform public.operations_shape(item,array['id','label','grade','values']); perform public.operations_text(item,'id',80,true); perform public.operations_text(item,'label',80,true);
   if item->>'id' !~ '^[a-zA-Z0-9_-]{1,80}$' or item->>'id'=any(seen) then raise exception 'INVALID_DETAILS: measurement position'; end if; seen:=array_append(seen,item->>'id');
   perform public.operations_shape(item->'values',array['XXS','XS','S','M','L','XL','XXL']);
   for val in select value from jsonb_each(item->'values') union all select item->'grade' loop
    if val<>'null'::jsonb and (jsonb_typeof(val) is distinct from 'number' or (val#>>'{}')::numeric<0 or (val#>>'{}')::numeric>1000 or round((val#>>'{}')::numeric,2)<>(val#>>'{}')::numeric) then raise exception 'INVALID_DETAILS: measurement precision/range'; end if;
   end loop;
  end loop;
 end loop;
end $$;
create function public.save_production_details(p_style_id uuid,p_line_id uuid,p_expected_version integer,p_data jsonb,p_reason text)
returns public.production_details language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;s public.styles;oldrow public.production_details;result public.production_details;empty_quality jsonb:='{"category":"","quantity":0,"status":"unset","requestedAt":"","completedAt":"","note":""}';
begin
 actor:=public.operations_actor(); perform public.operations_reason(p_reason);
 select * into s from public.styles where id=p_style_id and deleted_at is null for update;
 if not found or not public.can_access_style(p_style_id) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if not exists(select 1 from jsonb_array_elements(s.data->'production') x where x->>'id'=p_line_id::text) then raise exception 'INVALID_DETAILS: registered color required'; end if;
 select * into oldrow from public.production_details where style_id=p_style_id and line_id=p_line_id for update;
 if p_expected_version is null or p_expected_version<0 or coalesce(oldrow.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
 perform public.validate_production_details(p_data);
 if actor.role='factory' and (p_data->'quality') is distinct from coalesce(oldrow.data->'quality',empty_quality) then raise exception 'FORBIDDEN: quality instructions are headquarters-only' using errcode='42501'; end if;
 insert into public.production_details(style_id,line_id,data,version,updated_by) values(p_style_id,p_line_id,p_data,1,actor.id)
 on conflict(style_id,line_id) do update set data=excluded.data,version=production_details.version+1,updated_at=clock_timestamp(),updated_by=actor.id returning * into result;
 insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after) values(p_style_id,actor.id,actor.name,'품질 검사·사이즈 측정 저장',trim(p_reason),case when oldrow.style_id is null then null else to_jsonb(oldrow) end,to_jsonb(result)); return result;
end $$;
alter table public.production_details enable row level security;
create policy production_details_read on public.production_details for select to authenticated using(public.can_access_style(style_id) and exists(select 1 from public.styles s where s.id=style_id and s.deleted_at is null));
revoke all on public.production_details from public,anon,authenticated;
grant select on public.production_details to authenticated;
revoke execute on function public.validate_production_details(jsonb) from public,anon,authenticated;
revoke execute on function public.save_production_details(uuid,uuid,integer,jsonb,text) from public,anon;
grant execute on function public.save_production_details(uuid,uuid,integer,jsonb,text) to authenticated;

create function public.register_order_style(p_id uuid,p_expected_version integer,p_data jsonb,p_project jsonb,p_reason text)
returns public.styles language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; proj public.projects; oldstyle public.styles; item jsonb; previous jsonb; base jsonb; result public.styles; pid uuid;
begin
 actor:=public.operations_actor(); if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 perform public.operations_reason(p_reason); perform public.operations_shape(p_project,array['id','code','name','season','expected']);
 perform public.operations_text(p_project,'code',120,true); perform public.operations_text(p_project,'name',160,true); perform public.operations_text(p_project,'season',30,true);
 if p_project->>'code' ~ '[[:cntrl:]]' then raise exception 'INVALID_PROJECT'; end if;
 pid:=public.operations_uuid(p_project->>'id');
 perform pg_advisory_xact_lock(hashtextextended('project:'||lower(trim(p_project->>'code')),0));
 perform pg_advisory_xact_lock(hashtextextended('style:'||lower(p_data->>'code'),0));
 select * into proj from public.projects where id=pid for update;
 if proj.id is null then
  if p_project->'expected'<>'null'::jsonb then raise exception 'VERSION_CONFLICT: project removed' using errcode='40001'; end if;
  if exists(select 1 from public.projects where lower(trim(code))=lower(trim(p_project->>'code')) or (trim(code)='' and name=trim(p_project->>'name') and season=trim(p_project->>'season'))) then raise exception 'VERSION_CONFLICT: project already registered' using errcode='40001'; end if;
  insert into public.projects(id,code,name,season) values(pid,trim(p_project->>'code'),trim(p_project->>'name'),trim(p_project->>'season')) returning * into proj;
 else
  if p_project->'expected'='null'::jsonb then raise exception 'VERSION_CONFLICT: project already exists' using errcode='40001'; end if;
  perform public.operations_shape(p_project->'expected',array['code','name','season']);
  if jsonb_build_object('code',proj.code,'name',proj.name,'season',proj.season)<>p_project->'expected' then raise exception 'VERSION_CONFLICT: project changed' using errcode='40001'; end if;
  if proj.name<>trim(p_project->>'name') or proj.season<>trim(p_project->>'season') or (proj.code<>'' and lower(proj.code)<>lower(trim(p_project->>'code'))) then raise exception 'PROJECT_CONFLICT: existing project cannot be renamed by import'; end if;
  if proj.code='' then update public.projects set code=trim(p_project->>'code') where id=pid returning * into proj; end if;
 end if;
 if p_data->>'projectId'<>pid::text or p_data->>'season'<>proj.season then raise exception 'PROJECT_CONFLICT'; end if;
 select * into oldstyle from public.styles where id=p_id for update;
 if coalesce(oldstyle.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
 if oldstyle.id is not null and (oldstyle.deleted_at is not null or not public.can_access_style(p_id)) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if oldstyle.id is not null and (p_data-array['production','colors','projectId','season','version','updatedAt','updatedBy','deletedAt']) is distinct from (oldstyle.data-array['production','colors','projectId','season','version','updatedAt','updatedBy','deletedAt']) then raise exception 'INVALID_REGISTRATION: existing metadata changed'; end if;
 for item in select * from jsonb_array_elements(p_data->'production') loop
  select value into previous from jsonb_array_elements(coalesce(oldstyle.data->'production','[]')) where value->>'id'=item->>'id';
  if previous is not null then
   if item<>previous then raise exception 'INVALID_REGISTRATION: existing quantities changed'; end if;
  else
   base:='{"order":{"XXS":0,"XS":0,"S":0,"M":0,"L":0,"XL":0},"shipped":{"XXS":0,"XS":0,"S":0,"M":0,"L":0,"XL":0},"received":{"XXS":0,"XS":0,"S":0,"M":0,"L":0,"XL":0},"packing":{"XXS":0,"XS":0,"S":0,"M":0,"L":0,"XL":0},"checks":{"tp":"unset","pp":"unset","gb":"unset","labels":"unset","care":"unset","materials":"unset","packing":"unset","main":"unset","quality":"unset","packingList":"unset"},"confirmDue":"","shippedAt":"","receivedAt":"","invoice":"unset","invoiceAmount":0,"paymentDue":"","paymentStatus":"unset","measurements":"","factoryComment":""}';
   if item-array['id','color']<>base then raise exception 'INVALID_REGISTRATION: new color must start blank'; end if;
  end if;
 end loop;
 if oldstyle.id is null and (p_data->'samples'<>'[]'::jsonb or p_data->>'stage'<>'registered' or p_data->'ppApproved'<>'false'::jsonb or p_data->>'name'<>p_data->>'code') then raise exception 'INVALID_REGISTRATION: new style defaults'; end if;
 result:=public.save_style(p_id,p_data,p_expected_version,trim(p_reason)); return result;
end $$;
revoke execute on function public.register_order_style(uuid,integer,jsonb,jsonb,text) from public,anon;
grant execute on function public.register_order_style(uuid,integer,jsonb,jsonb,text) to authenticated;
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then alter publication supabase_realtime add table public.production_details;end if;
end $$;
commit;
