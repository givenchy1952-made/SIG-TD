-- SIG SAMPLE MANAGEMENT: apply once through the Supabase SQL editor or CLI.
-- Application keys are publishable/anon only. The browser never receives service_role.
begin;

create table public.factories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  country text not null check (length(country) between 1 and 40)
);
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 160),
  season text not null check (length(season) between 1 and 40)
);
create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 120),
  email text not null,
  role text not null default 'internal' check (role in ('admin','internal','factory')),
  approved boolean not null default false,
  active boolean not null default true,
  factory_id uuid references public.factories(id),
  check (role <> 'factory' or not approved or factory_id is not null)
);
create table public.styles (
  id uuid primary key,
  data jsonb not null,
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id),
  deleted_at timestamptz
);
create index styles_factory_idx on public.styles ((data->>'factoryId')) where deleted_at is null;
create index styles_project_idx on public.styles ((data->>'projectId')) where deleted_at is null;
create unique index styles_code_unique on public.styles (lower(data->>'code')) where deleted_at is null;
create table public.comments (
  id uuid primary key default gen_random_uuid(),
  style_id uuid not null references public.styles(id) on delete restrict,
  sample_id uuid,
  author_id uuid not null default auth.uid() references public.profiles(id),
  author_name text not null default '',
  body text not null check (length(trim(body)) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index comments_style_idx on public.comments(style_id, created_at);
create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  style_id uuid not null references public.styles(id) on delete restrict,
  sample_id uuid,
  name text not null check (length(name) between 1 and 250),
  path text not null unique,
  mime text not null check (mime in ('image/jpeg','image/png','image/webp','application/pdf')),
  size bigint not null check (size between 1 and 10485760),
  uploaded_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now()
);
create index attachments_style_idx on public.attachments(style_id, created_at);
create table public.audits (
  id uuid primary key default gen_random_uuid(),
  style_id uuid references public.styles(id) on delete restrict,
  actor_id uuid references public.profiles(id),
  actor_name text not null,
  action text not null,
  reason text not null default '',
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index audits_style_idx on public.audits(style_id, created_at desc);

-- Each authorization helper reads the live profile, so revocation is immediate.
create function public.current_app_role() returns text language sql stable security definer
set search_path = public, pg_temp as $$
  select role from public.profiles where id=auth.uid() and approved and active
$$;
create function public.can_access_style(p_id uuid) returns boolean language sql stable security definer
set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.styles s join public.profiles p on p.id=auth.uid()
    where s.id=p_id and p.approved and p.active
      and (s.deleted_at is null or p.role='admin')
      and (p.role in ('admin','internal') or (p.role='factory' and s.data->>'factoryId'=p.factory_id::text))
  )
$$;

-- Factory clients need only the display identity of assigned-style HQ owners.
-- Keep profiles RLS self-only for factories; this projection never exposes email,
-- approval flags, factory memberships or other unrelated employee records.
create function public.visible_style_owners() returns table(id uuid,name text,role text)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id,p.name,p.role
  from public.profiles p
  where p.approved and p.active and p.role in ('admin','internal')
    and exists (
      select 1 from public.styles s
      where s.deleted_at is null and public.can_access_style(s.id)
        and (s.data->>'ownerId'=p.id::text or exists (
          select 1 from jsonb_array_elements(s.data->'samples') item
          where item->>'ownerId'=p.id::text
        ))
    )
$$;

create function public.on_auth_signup() returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  insert into public.profiles(id,name,email,role,approved,active)
  values(new.id,coalesce(nullif(left(trim(new.raw_user_meta_data->>'name'),120),''),split_part(new.email,'@',1),'사용자'),coalesce(new.email,''),'internal',false,true);
  return new;
end $$;
create trigger sig_auth_signup after insert on auth.users for each row execute function public.on_auth_signup();

-- Validate shape and every value on the server, including direct RPC callers.
create function public.validate_style(p_id uuid, d jsonb) returns void language plpgsql
set search_path = public, pg_temp as $$
declare item jsonb; q jsonb; field text; value text; known text[]; color text; seen_ids text[] := '{}'; seen_rounds text[] := '{}';
begin
  if jsonb_typeof(d) is distinct from 'object' then raise exception 'INVALID_STYLE: object required'; end if;
  known := array['id','code','name','category','season','projectId','factoryId','ownerId','colors','dueDate','stage','ppApproved','notes','samples','production','version','updatedAt','updatedBy','deletedAt'];
  if exists(select 1 from jsonb_object_keys(d) k where not(k=any(known))) then raise exception 'INVALID_STYLE: unknown field'; end if;
  if not(d ?& known) then raise exception 'INVALID_STYLE: missing field'; end if;
  if d->>'id' is distinct from p_id::text then raise exception 'INVALID_STYLE: id mismatch'; end if;
  foreach field in array array['code','name','category','season','projectId','factoryId','ownerId','dueDate','stage','notes'] loop
    if jsonb_typeof(d->field) is distinct from 'string' then raise exception 'INVALID_STYLE: % must be text',field; end if;
    if length(d->>field)>10000 then raise exception 'INVALID_STYLE: value too long'; end if;
  end loop;
  if length(trim(d->>'code')) not between 1 and 80 or length(trim(d->>'name')) not between 1 and 200 then raise exception 'INVALID_STYLE: code/name required'; end if;
  if d->>'stage' not in ('registered','pattern','sample1','sampleN','review','revision','approved','production') then raise exception 'INVALID_STYLE: stage'; end if;
  if jsonb_typeof(d->'ppApproved') is distinct from 'boolean' then raise exception 'INVALID_STYLE: PP approval'; end if;
  foreach field in array array['factoryId','projectId','ownerId'] loop
    if d->>field !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_STYLE: canonical UUID required'; end if;
  end loop;
  if not exists(select 1 from public.factories where id=(d->>'factoryId')::uuid) then raise exception 'INVALID_STYLE: unknown factory'; end if;
  if not exists(select 1 from public.projects where id=(d->>'projectId')::uuid) then raise exception 'INVALID_STYLE: unknown project'; end if;
  if not exists(select 1 from public.profiles where id=(d->>'ownerId')::uuid and role in ('admin','internal') and approved and active) then raise exception 'INVALID_STYLE: owner must be an active approved employee'; end if;
  perform public.validate_sig_date(d->>'dueDate');
  if jsonb_typeof(d->'colors') is distinct from 'array' or jsonb_array_length(d->'colors') not between 1 and 40 then raise exception 'INVALID_STYLE: colors'; end if;
  if (select count(*) from jsonb_array_elements(d->'colors')) <> (select count(distinct e.value) from jsonb_array_elements(d->'colors') e) then raise exception 'INVALID_STYLE: duplicate color'; end if;
  for item in select * from jsonb_array_elements(d->'colors') loop
    if jsonb_typeof(item) is distinct from 'string' or (item#>>'{}') !~ '^[A-Z]{2}$' then raise exception 'INVALID_STYLE: color must be two uppercase letters'; end if;
  end loop;
  if jsonb_typeof(d->'samples') is distinct from 'array' or jsonb_array_length(d->'samples')>100 then raise exception 'INVALID_STYLE: samples'; end if;
  for item in select * from jsonb_array_elements(d->'samples') loop
    known := array['id','round','isPP','status','factoryId','ownerId','requestedAt','plannedAt','completedAt','shippedAt','receivedAt','reviewedAt','tracking','request','factoryComment','updatedAt'];
    if jsonb_typeof(item) is distinct from 'object' or not(item ?& known) or exists(select 1 from jsonb_object_keys(item) k where not(k=any(known))) then raise exception 'INVALID_STYLE: sample fields'; end if;
    if jsonb_typeof(item->'id') is distinct from 'string' or item->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_STYLE: sample UUID'; end if;
    if (item->>'id')=any(seen_ids) then raise exception 'INVALID_STYLE: duplicate sample id'; end if;
    perform (item->>'id')::uuid;
    seen_ids := array_append(seen_ids,item->>'id');
    if jsonb_typeof(item->'round') is distinct from 'number' or item->>'round' !~ '^[0-9]+$' or (item->>'round')::int not between 1 and 100 then raise exception 'INVALID_STYLE: sample round'; end if;
    if jsonb_typeof(item->'isPP') is distinct from 'boolean' then raise exception 'INVALID_STYLE: sample PP flag'; end if;
    if ((item->>'isPP')||':'||(item->>'round'))=any(seen_rounds) then raise exception 'INVALID_STYLE: duplicate sample round'; end if;
    seen_rounds := array_append(seen_rounds,(item->>'isPP')||':'||(item->>'round'));
    if item->>'status' not in ('unset','todo','progress','done','approved','delayed') then raise exception 'INVALID_STYLE: sample status'; end if;
    foreach field in array array['factoryId','ownerId'] loop
      if jsonb_typeof(item->field) is distinct from 'string' or item->>field !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_STYLE: sample canonical UUID required'; end if;
    end loop;
    if not exists(select 1 from public.factories where id=(item->>'factoryId')::uuid) then raise exception 'INVALID_STYLE: sample factory'; end if;
    if not exists(select 1 from public.profiles where id=(item->>'ownerId')::uuid and role in ('admin','internal')) then raise exception 'INVALID_STYLE: sample owner'; end if;
    foreach field in array array['requestedAt','plannedAt','completedAt','shippedAt','receivedAt','reviewedAt'] loop perform public.validate_sig_date(item->>field); end loop;
    foreach field in array array['status','factoryId','ownerId','tracking','request','factoryComment','updatedAt'] loop
      if jsonb_typeof(item->field) is distinct from 'string' or length(item->>field)>10000 then raise exception 'INVALID_STYLE: sample %',field; end if;
    end loop;
  end loop;
  if jsonb_typeof(d->'production') is distinct from 'array' or jsonb_array_length(d->'production')<>jsonb_array_length(d->'colors') then raise exception 'INVALID_STYLE: one production line per color required'; end if;
  seen_ids := '{}'; seen_rounds := '{}';
  for item in select * from jsonb_array_elements(d->'production') loop
    known := array['id','color','order','shipped','received','packing','checks','confirmDue','shippedAt','receivedAt','invoice','invoiceAmount','paymentDue','paymentStatus','measurements','factoryComment'];
    if jsonb_typeof(item) is distinct from 'object' or not(item ?& known) or exists(select 1 from jsonb_object_keys(item) k where not(k=any(known))) then raise exception 'INVALID_STYLE: production fields'; end if;
    if jsonb_typeof(item->'id') is distinct from 'string' or item->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_STYLE: production UUID'; end if;
    perform (item->>'id')::uuid;
    if (item->>'id')=any(seen_ids) or (item->>'color')=any(seen_rounds) then raise exception 'INVALID_STYLE: duplicate production id/color'; end if;
    seen_ids := array_append(seen_ids,item->>'id'); seen_rounds := array_append(seen_rounds,item->>'color');
    if not(d->'colors' ? (item->>'color')) then raise exception 'INVALID_STYLE: production color'; end if;
    foreach field in array array['order','shipped','received','packing'] loop
      q:=item->field;
      if jsonb_typeof(q) is distinct from 'object' or not(q ?& array['XXS','XS','S','M','L','XL']) or (select count(*) from jsonb_object_keys(q))<>6 then raise exception 'INVALID_STYLE: six sizes required'; end if;
      for value in select jsonb_object_keys(q) loop
        if jsonb_typeof(q->value) is distinct from 'number' or q->>value !~ '^[0-9]+$' or (q->>value)::numeric > 10000000 then raise exception 'INVALID_STYLE: quantities must be nonnegative integers'; end if;
      end loop;
    end loop;
    q:=item->'checks'; known:=array['tp','pp','gb','labels','care','materials','packing','main','quality','packingList'];
    if jsonb_typeof(q) is distinct from 'object' or not(q ?& known) or (select count(*) from jsonb_object_keys(q))<>10 then raise exception 'INVALID_STYLE: production checks'; end if;
    for value in select jsonb_object_keys(q) loop
      if jsonb_typeof(q->value) is distinct from 'string' or q->>value not in ('unset','todo','progress','done','approved','delayed') then raise exception 'INVALID_STYLE: check status'; end if;
    end loop;
    foreach field in array array['invoice','paymentStatus'] loop
      if jsonb_typeof(item->field) is distinct from 'string' or item->>field not in ('unset','todo','progress','done','approved','delayed') then raise exception 'INVALID_STYLE: financial status'; end if;
    end loop;
    if jsonb_typeof(item->'invoiceAmount') is distinct from 'number' or (item->>'invoiceAmount')::numeric < 0 or (item->>'invoiceAmount')::numeric > 1000000000000 then raise exception 'INVALID_STYLE: invoice amount'; end if;
    foreach field in array array['confirmDue','shippedAt','receivedAt','paymentDue'] loop perform public.validate_sig_date(item->>field); end loop;
    foreach field in array array['color','measurements','factoryComment'] loop
      if jsonb_typeof(item->field) is distinct from 'string' or length(item->>field)>10000 then raise exception 'INVALID_STYLE: production text'; end if;
    end loop;
  end loop;
end $$;

create function public.validate_sig_date(d text) returns void language plpgsql immutable
set search_path = public, pg_temp as $$
begin
  if d is null or (d<>'' and d !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then raise exception 'INVALID_STYLE: ISO date required'; end if;
  if d<>'' then perform d::date; end if;
end $$;

create function public.save_style(p_id uuid,p_data jsonb,p_expected_version integer,p_reason text default '')
returns public.styles language plpgsql security definer set search_path = public, pg_temp as $$
declare actor public.profiles; oldrow public.styles; result public.styles; d jsonb; o jsonb; item jsonb; previous jsonb; role_name text; changed_dates boolean:=false; key text; stamp timestamptz:=clock_timestamp(); clean_samples jsonb:='[]';
begin
  select * into actor from public.profiles where id=auth.uid() and approved and active;
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

create function public.soft_delete_style(p_id uuid,p_expected_version integer,p_reason text)
returns public.styles language plpgsql security definer set search_path = public, pg_temp as $$
declare actor public.profiles; oldrow public.styles; result public.styles; stamp timestamptz:=clock_timestamp();
begin
  select * into actor from public.profiles where id=auth.uid() and approved and active and role='admin';
  if not found then raise exception 'FORBIDDEN: administrator required' using errcode='42501'; end if;
  if length(trim(coalesce(p_reason,'')))<2 or length(p_reason)>1000 then raise exception 'REASON_REQUIRED: deletion reason required'; end if;
  select * into oldrow from public.styles where id=p_id and deleted_at is null for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if p_expected_version is null or oldrow.version<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  update public.styles set deleted_at=stamp,version=version+1,updated_at=stamp,updated_by=actor.id,
    data=data||jsonb_build_object('deletedAt',stamp,'updatedAt',stamp,'updatedBy',actor.id,'version',version+1)
    where id=p_id returning * into result;
  insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after) values(p_id,actor.id,actor.name,'스타일 삭제',p_reason,oldrow.data,result.data);
  return result;
end $$;

create function public.manage_profile(p_id uuid,p_name text,p_role text,p_approved boolean,p_active boolean,p_factory_id uuid default null)
returns public.profiles language plpgsql security definer set search_path = public, pg_temp as $$
declare actor public.profiles; oldrow public.profiles; result public.profiles;
begin
  select * into actor from public.profiles where id=auth.uid() and approved and active and role='admin';
  if not found then raise exception 'FORBIDDEN: administrator required' using errcode='42501'; end if;
  if p_id=actor.id and (p_role<>'admin' or not p_approved or not p_active) then raise exception 'LAST_ADMIN_PROTECTED: you cannot revoke your own administrator access'; end if;
  select * into oldrow from public.profiles where id=p_id for update;
  if not found then raise exception 'NOT_FOUND: user must sign up first'; end if;
  update public.profiles set name=trim(p_name),role=p_role,approved=p_approved,active=p_active,factory_id=case when p_role='factory' then p_factory_id else null end where id=p_id returning * into result;
  insert into public.audits(actor_id,actor_name,action,reason,before,after) values(actor.id,actor.name,'사용자 권한 변경','관리자 승인 및 계정 관리',to_jsonb(oldrow),to_jsonb(result));
  return result;
end $$;

create function public.stamp_collaboration() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare actor public.profiles; s public.styles; object_metadata jsonb;
begin
  select * into actor from public.profiles where id=auth.uid() and approved and active;
  if not found or not public.can_access_style(new.style_id) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into s from public.styles where id=new.style_id and deleted_at is null;
  if not found then raise exception 'FORBIDDEN: deleted style' using errcode='42501'; end if;
  if new.sample_id is not null and not exists(select 1 from jsonb_array_elements(s.data->'samples') item where item->>'id'=new.sample_id::text) then raise exception 'INVALID_SAMPLE'; end if;
  new.created_at:=clock_timestamp();
  if tg_table_name='comments' then
    new.author_id:=actor.id; new.author_name:=actor.name;
    insert into public.audits(style_id,actor_id,actor_name,action,after) values(new.style_id,actor.id,actor.name,'코멘트 등록',jsonb_build_object('commentId',new.id,'body',new.body,'sampleId',new.sample_id));
  else
    new.uploaded_by:=actor.id;
    if split_part(new.path,'/',1)<>new.style_id::text or new.path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$' then raise exception 'INVALID_ATTACHMENT_PATH'; end if;
    select metadata into object_metadata from storage.objects where bucket_id='sig-files' and name=new.path;
    if not found then raise exception 'ATTACHMENT_UPLOAD_REQUIRED'; end if;
    if object_metadata->>'mimetype' is distinct from new.mime or (object_metadata->>'size')::bigint is distinct from new.size then raise exception 'ATTACHMENT_METADATA_MISMATCH'; end if;
    insert into public.audits(style_id,actor_id,actor_name,action,after) values(new.style_id,actor.id,actor.name,'파일 첨부',jsonb_build_object('attachmentId',new.id,'name',new.name,'sampleId',new.sample_id));
  end if;
  return new;
end $$;
create trigger stamp_comment before insert on public.comments for each row execute function public.stamp_collaboration();
create trigger stamp_attachment before insert on public.attachments for each row execute function public.stamp_collaboration();

create function public.audit_metadata() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare actor public.profiles; label text;
begin
  select * into actor from public.profiles where id=auth.uid();
  label:=case when tg_table_name='factories' then '공장' else '프로젝트' end;
  insert into public.audits(actor_id,actor_name,action,before,after)
  values(actor.id,coalesce(actor.name,'시스템 · SQL'),label||case when tg_op='INSERT' then ' 등록' else ' 수정' end,
    case when tg_op='INSERT' then null else to_jsonb(old) end,to_jsonb(new));
  return new;
end $$;
create trigger audit_factories after insert or update on public.factories for each row execute function public.audit_metadata();
create trigger audit_projects after insert or update on public.projects for each row execute function public.audit_metadata();

alter table public.profiles enable row level security;
alter table public.factories enable row level security;
alter table public.projects enable row level security;
alter table public.styles enable row level security;
alter table public.comments enable row level security;
alter table public.attachments enable row level security;
alter table public.audits enable row level security;
create policy profiles_read on public.profiles for select to authenticated using (id=auth.uid() or public.current_app_role() in ('admin','internal'));
create policy factories_read on public.factories for select to authenticated using (
  public.current_app_role() in ('admin','internal') or (public.current_app_role()='factory' and id=(select factory_id from public.profiles where id=auth.uid()))
);
create policy projects_read on public.projects for select to authenticated using (
  public.current_app_role() in ('admin','internal') or (public.current_app_role()='factory' and exists(select 1 from public.styles s where s.data->>'projectId'=projects.id::text))
);
create policy factories_insert on public.factories for insert to authenticated with check (public.current_app_role()='admin');
create policy factories_update on public.factories for update to authenticated using (public.current_app_role()='admin') with check (public.current_app_role()='admin');
create policy projects_insert on public.projects for insert to authenticated with check (public.current_app_role()='admin');
create policy projects_update on public.projects for update to authenticated using (public.current_app_role()='admin') with check (public.current_app_role()='admin');
create policy styles_read on public.styles for select to authenticated using (public.can_access_style(id));
create policy comments_read on public.comments for select to authenticated using (public.can_access_style(style_id));
create policy comments_insert on public.comments for insert to authenticated with check (public.can_access_style(style_id) and author_id=auth.uid());
create policy attachments_read on public.attachments for select to authenticated using (public.can_access_style(style_id));
create policy attachments_insert on public.attachments for insert to authenticated with check (public.can_access_style(style_id) and uploaded_by=auth.uid());
create policy audits_read on public.audits for select to authenticated using (public.current_app_role()='admin' or (style_id is not null and public.can_access_style(style_id)));

-- Private files are fetched through authenticated Storage downloads. No public URLs.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('sig-files','sig-files',false,10485760,array['image/jpeg','image/png','image/webp','application/pdf']);
create function public.can_access_storage_path(p_path text) returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare style_id uuid;
begin
  if p_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$' then return false; end if;
  begin style_id:=split_part(p_path,'/',1)::uuid; exception when invalid_text_representation then return false; end;
  return public.can_access_style(style_id) and exists(select 1 from public.styles where id=style_id and deleted_at is null);
end $$;
create policy sig_files_read on storage.objects for select to authenticated using (bucket_id='sig-files' and public.can_access_storage_path(name));
create policy sig_files_insert on storage.objects for insert to authenticated with check (bucket_id='sig-files' and public.can_access_storage_path(name));
-- No storage UPDATE/DELETE grants are added: files are immutable to preserve history.
-- Orphaned uploads can be cleaned by a trusted administrator outside the client.

revoke all on public.profiles,public.factories,public.projects,public.styles,public.comments,public.attachments,public.audits from anon,authenticated;
grant select on public.profiles,public.factories,public.projects,public.styles,public.comments,public.attachments,public.audits to authenticated;
grant insert,update on public.factories,public.projects to authenticated;
grant insert on public.comments,public.attachments to authenticated;
revoke execute on function public.validate_style(uuid,jsonb),public.validate_sig_date(text),public.on_auth_signup(),public.stamp_collaboration(),public.audit_metadata() from public,anon,authenticated;
revoke execute on function public.current_app_role(),public.can_access_style(uuid),public.visible_style_owners(),public.can_access_storage_path(text),public.save_style(uuid,jsonb,integer,text),public.soft_delete_style(uuid,integer,text),public.manage_profile(uuid,text,text,boolean,boolean,uuid) from public,anon;
grant execute on function public.current_app_role(),public.can_access_style(uuid),public.visible_style_owners(),public.can_access_storage_path(text),public.save_style(uuid,jsonb,integer,text),public.soft_delete_style(uuid,integer,text),public.manage_profile(uuid,text,text,boolean,boolean,uuid) to authenticated;

-- RLS remains authoritative on all realtime SELECTs. Version refetch on focus also
-- catches revoked access, missed messages and soft-deleted records.
do $$
declare table_name text;
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    foreach table_name in array array['styles','comments','attachments','audits','profiles','factories','projects'] loop
      if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=table_name) then
        execute format('alter publication supabase_realtime add table public.%I',table_name);
      end if;
    end loop;
  end if;
end $$;
commit;
