-- Per-item material review submissions and decisions. Existing production,
-- financial approvals, PO records and legacy materials checkboxes are unchanged.
begin;
create table if not exists public.material_review_items (
 id uuid primary key, style_id uuid not null references public.styles(id) on delete restrict, line_id uuid not null,
 kind text not null check(kind in ('fabric','trim')), name text not null, specification text not null,
 version integer not null check(version>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),updated_by uuid not null references public.profiles(id)
);
create index if not exists material_review_items_style_idx on public.material_review_items(style_id,line_id);
create table if not exists public.material_review_rounds (
 id uuid primary key,item_id uuid not null references public.material_review_items(id) on delete restrict,
 round integer not null check(round between 1 and 100),status text not null check(status in ('pending','approved','rejected')),
 comment text not null,attachment_ids uuid[] not null default '{}',item_snapshot jsonb not null,
 actor_id uuid not null references public.profiles(id),actor_name text not null,
 version integer not null check(version in (1,2)),created_at timestamptz not null default now(),
 reviewer_comment text not null default '',review_attachment_ids uuid[] not null default '{}',
 reviewed_by uuid references public.profiles(id),reviewed_by_name text not null default '',reviewed_at timestamptz,
 unique(item_id,round),check((status='pending' and reviewed_by is null and reviewed_at is null and version=1) or (status<>'pending' and reviewed_by is not null and reviewed_at is not null))
);
create table if not exists public.material_review_attachments (
 round_id uuid not null references public.material_review_rounds(id) on delete restrict,
 attachment_id uuid not null references public.attachments(id) on delete restrict,
 phase text not null check(phase in ('submission','review')),primary key(round_id,attachment_id,phase)
);
create table if not exists public.material_review_events (
 id uuid primary key default gen_random_uuid(),item_id uuid not null references public.material_review_items(id) on delete restrict,
 actor_id uuid not null references public.profiles(id),actor_name text not null,action text not null,reason text not null,
 before jsonb,after jsonb not null,created_at timestamptz not null default now()
);

create or replace function public.get_material_reviews_capability() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.profiles where id=auth.uid() and approved and active and (role in ('admin','internal') or role='factory' and factory_id is not null))
$$;
create or replace function public.protect_material_review_history() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin raise exception 'HISTORY_PROTECTED: material review archive is immutable';end $$;
create or replace function public.protect_material_review_item() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if tg_op='DELETE' or new.id is distinct from old.id or new.style_id is distinct from old.style_id or new.line_id is distinct from old.line_id or new.created_at is distinct from old.created_at then raise exception 'HISTORY_PROTECTED: material item identity cannot change';end if;
 return new;
end $$;
create or replace function public.protect_material_review_round() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles; allowed text[]:=array['status','reviewer_comment','review_attachment_ids','reviewed_by','reviewed_by_name','reviewed_at','version'];
begin
 if tg_op='DELETE' then raise exception 'HISTORY_PROTECTED: material submission cannot be deleted';end if;
 select * into actor from public.profiles where id=auth.uid() and approved and active and role in ('admin','internal');
 if actor.id is null or old.status<>'pending' or old.version<>1 or new.version<>2 or new.status not in ('approved','rejected')
   or (to_jsonb(new)-allowed) is distinct from (to_jsonb(old)-allowed)
   or new.reviewed_by is distinct from actor.id or new.reviewed_by_name is distinct from actor.name or new.reviewed_at is null then
  raise exception 'HISTORY_PROTECTED: only a first HQ decision may update a pending round';
 end if;
 return new;
end $$;
create or replace function public.protect_material_review_attachment() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if exists(select 1 from public.material_review_attachments where attachment_id=old.id) and (tg_op='DELETE' or to_jsonb(new) is distinct from to_jsonb(old)) then raise exception 'HISTORY_PROTECTED: archived material image metadata is immutable';end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
create or replace function public.protect_material_review_storage() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if old.bucket_id='sig-files' and exists(select 1 from public.material_review_attachments ref join public.attachments a on a.id=ref.attachment_id where a.path=old.name)
  and (tg_op='DELETE' or (to_jsonb(new)-'last_accessed_at') is distinct from (to_jsonb(old)-'last_accessed_at')) then raise exception 'HISTORY_PROTECTED: archived material image object is immutable';end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
drop trigger if exists material_review_item_history on public.material_review_items;
create trigger material_review_item_history before update or delete on public.material_review_items for each row execute function public.protect_material_review_item();
drop trigger if exists material_review_round_history on public.material_review_rounds;
create trigger material_review_round_history before update or delete on public.material_review_rounds for each row execute function public.protect_material_review_round();
drop trigger if exists material_review_event_history on public.material_review_events;
create trigger material_review_event_history before update or delete on public.material_review_events for each row execute function public.protect_material_review_history();
drop trigger if exists material_review_image_reference_history on public.material_review_attachments;
create trigger material_review_image_reference_history before update or delete on public.material_review_attachments for each row execute function public.protect_material_review_history();
drop trigger if exists material_review_image_archive on public.attachments;
create trigger material_review_image_archive before update or delete on public.attachments for each row execute function public.protect_material_review_attachment();
drop trigger if exists material_review_storage_archive on storage.objects;
create trigger material_review_storage_archive before update or delete on storage.objects for each row execute function public.protect_material_review_storage();

-- Validate under the caller RPC's style/item locks; hold image rows so concurrent
-- metadata deletion cannot race the permanent archive references.
create or replace function public.material_review_round_images(p_style_id uuid,p_data jsonb) returns uuid[] language plpgsql security definer set search_path=public,pg_temp as $$
declare images uuid[]:='{}'; entry jsonb; aid uuid; file public.attachments;
begin
 perform public.operations_shape(p_data,array['status','comment','attachmentIds']);
 if p_data->>'status' not in ('pending','approved','rejected') or jsonb_typeof(p_data->'status') is distinct from 'string'
  or jsonb_typeof(p_data->'comment') is distinct from 'string' or length(p_data->>'comment')>4000 or p_data->>'comment' ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
  or jsonb_typeof(p_data->'attachmentIds') is distinct from 'array' then raise exception 'INVALID_MATERIAL_REVIEW';end if;
 if jsonb_array_length(p_data->'attachmentIds')>12 or (btrim(p_data->>'comment')='' and jsonb_array_length(p_data->'attachmentIds')=0) then raise exception 'INVALID_MATERIAL_REVIEW: comment or at most 12 images required';end if;
 for entry in select value from jsonb_array_elements(p_data->'attachmentIds') loop
  if jsonb_typeof(entry)<>'string' then raise exception 'INVALID_MATERIAL_IMAGE';end if;
  aid:=public.operations_uuid(entry#>>'{}');
  if aid=any(images) then raise exception 'INVALID_MATERIAL_IMAGE: duplicate image';end if;
  select * into file from public.attachments where id=aid for share;
  if file.id is null or file.style_id<>p_style_id or file.mime not in ('image/jpeg','image/png','image/webp') then raise exception 'INVALID_MATERIAL_IMAGE: same-style JPG PNG WEBP required';end if;
  perform 1 from storage.objects where bucket_id='sig-files' and name=file.path for share;
  if not found then raise exception 'INVALID_MATERIAL_IMAGE: original image object is missing';end if;
  images:=array_append(images,aid);
 end loop;
 return images;
end $$;

create or replace function public.save_material_review_item(p_id uuid,p_style_id uuid,p_line_id uuid,p_expected_version integer,p_data jsonb,p_reason text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;s public.styles;prior public.material_review_items;result public.material_review_items;stamp timestamptz:=clock_timestamp();
begin
 actor:=public.operations_actor();perform public.operations_reason(p_reason);
 if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN: material items require HQ' using errcode='42501';end if;
 if p_id is null or p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_VERSION';end if;
 select * into s from public.styles where id=p_style_id and deleted_at is null for update;
 if s.id is null or not public.can_access_style(s.id) then raise exception 'FORBIDDEN: inaccessible material style' using errcode='42501';end if;
 if not exists(select 1 from jsonb_array_elements(s.data->'production') line where line->>'id'=p_line_id::text) then raise exception 'INVALID_MATERIAL_LINE';end if;
 select * into prior from public.material_review_items where id=p_id for update;
 if prior.id is not null and (prior.style_id<>p_style_id or prior.line_id<>p_line_id) then raise exception 'HISTORY_PROTECTED: material item identity';end if;
 if coalesce(prior.version,0)<>p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 perform public.operations_shape(p_data,array['kind','name','specification']);
 perform public.operations_text(p_data,'name',160,true);perform public.operations_text(p_data,'specification',2000,false);
 if jsonb_typeof(p_data->'kind') is distinct from 'string' or p_data->>'kind' not in ('fabric','trim') then raise exception 'INVALID_MATERIAL_KIND';end if;
 if prior.id is null and (select count(*) from public.material_review_items where style_id=s.id)>=200 then raise exception 'MATERIAL_ITEM_LIMIT';end if;
 insert into public.material_review_items(id,style_id,line_id,kind,name,specification,version,created_at,updated_at,updated_by)
 values(p_id,s.id,p_line_id,p_data->>'kind',btrim(p_data->>'name'),p_data->>'specification',p_expected_version+1,stamp,stamp,actor.id)
 on conflict(id) do update set kind=excluded.kind,name=excluded.name,specification=excluded.specification,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by returning * into result;
 insert into public.material_review_events(item_id,actor_id,actor_name,action,reason,before,after,created_at) values(p_id,actor.id,actor.name,'원부자재 품목 저장',btrim(p_reason),case when prior.id is null then null else to_jsonb(prior) end,to_jsonb(result),stamp);
end $$;

create or replace function public.append_material_review_round(p_id uuid,p_item_id uuid,p_expected_item_version integer,p_data jsonb,p_reason text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;item public.material_review_items;s public.styles;latest public.material_review_rounds;result public.material_review_rounds;line jsonb;images uuid[];sid uuid;stamp timestamptz:=clock_timestamp();
begin
 actor:=public.operations_actor();perform public.operations_reason(p_reason);
 select style_id into sid from public.material_review_items where id=p_item_id;
 select * into s from public.styles where id=sid and deleted_at is null for update;
 select * into item from public.material_review_items where id=p_item_id for update;
 if s.id is null or item.id is null or not public.can_access_style(s.id) then raise exception 'FORBIDDEN: inaccessible material item' using errcode='42501';end if;
 if p_id is null or p_expected_item_version is null or item.version<>p_expected_item_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 select value into line from jsonb_array_elements(s.data->'production') where value->>'id'=item.line_id::text;
 if line is null then raise exception 'INVALID_MATERIAL_LINE';end if;
 images:=public.material_review_round_images(s.id,p_data);
 select * into latest from public.material_review_rounds where item_id=item.id order by round desc limit 1;
 if latest.status='pending' or actor.role='factory' and (p_data->>'status'<>'pending' or latest.status='approved') then raise exception 'MATERIAL_REVIEW_STATE: wait for HQ decision or submit after rejection';end if;
 if coalesce(latest.round,0)>=100 then raise exception 'MATERIAL_ROUND_LIMIT';end if;
 insert into public.material_review_rounds(id,item_id,round,status,comment,attachment_ids,item_snapshot,actor_id,actor_name,version,created_at,reviewed_by,reviewed_by_name,reviewed_at)
 values(p_id,item.id,coalesce(latest.round,0)+1,p_data->>'status',p_data->>'comment',images,
  jsonb_build_object('styleId',s.id,'lineId',item.line_id,'color',line->>'color','styleCode',s.data->>'code','kind',item.kind,'name',item.name,'specification',item.specification),
  actor.id,actor.name,1,stamp,case when p_data->>'status'='pending' then null else actor.id end,case when p_data->>'status'='pending' then '' else actor.name end,case when p_data->>'status'='pending' then null else stamp end) returning * into result;
 insert into public.material_review_attachments(round_id,attachment_id,phase) select p_id,aid,'submission' from unnest(images) aid;
 update public.material_review_items set version=version+1,updated_at=stamp,updated_by=actor.id where id=item.id;
 insert into public.material_review_events(item_id,actor_id,actor_name,action,reason,before,after,created_at) values(item.id,actor.id,actor.name,'원부자재 확인 차수 제출',btrim(p_reason),null,to_jsonb(result),stamp);
end $$;

create or replace function public.decide_material_review_round(p_round_id uuid,p_expected_round_version integer,p_data jsonb,p_reason text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare actor public.profiles;item public.material_review_items;s public.styles;prior public.material_review_rounds;result public.material_review_rounds;images uuid[];sid uuid;iid uuid;stamp timestamptz:=clock_timestamp();
begin
 actor:=public.operations_actor();perform public.operations_reason(p_reason);
 if actor.role not in ('admin','internal') then raise exception 'FORBIDDEN: material review decisions require HQ' using errcode='42501';end if;
 select r.item_id,i.style_id into iid,sid from public.material_review_rounds r join public.material_review_items i on i.id=r.item_id where r.id=p_round_id;
 select * into s from public.styles where id=sid and deleted_at is null for update;
 select * into item from public.material_review_items where id=iid for update;
 select * into prior from public.material_review_rounds where id=p_round_id for update;
 if s.id is null or item.id is null or prior.id is null or not public.can_access_style(s.id) then raise exception 'FORBIDDEN: inaccessible material review' using errcode='42501';end if;
 if p_expected_round_version is null or prior.version<>p_expected_round_version then raise exception 'VERSION_CONFLICT' using errcode='40001';end if;
 if prior.status<>'pending' or exists(select 1 from public.material_review_rounds where item_id=item.id and round>prior.round) then raise exception 'HISTORY_PROTECTED: material round already decided';end if;
 images:=public.material_review_round_images(s.id,p_data);
 if p_data->>'status' not in ('approved','rejected') then raise exception 'INVALID_MATERIAL_DECISION';end if;
 update public.material_review_rounds set status=p_data->>'status',reviewer_comment=p_data->>'comment',review_attachment_ids=images,reviewed_by=actor.id,reviewed_by_name=actor.name,reviewed_at=stamp,version=version+1 where id=prior.id returning * into result;
 insert into public.material_review_attachments(round_id,attachment_id,phase) select prior.id,aid,'review' from unnest(images) aid;
 update public.material_review_items set version=version+1,updated_at=stamp,updated_by=actor.id where id=item.id;
 insert into public.material_review_events(item_id,actor_id,actor_name,action,reason,before,after,created_at) values(item.id,actor.id,actor.name,'원부자재 확인 차수 결정',btrim(p_reason),to_jsonb(prior),to_jsonb(result),stamp);
end $$;

alter table public.material_review_items enable row level security;
alter table public.material_review_rounds enable row level security;
alter table public.material_review_attachments enable row level security;
alter table public.material_review_events enable row level security;
drop policy if exists material_review_items_read on public.material_review_items;
create policy material_review_items_read on public.material_review_items for select to authenticated using(public.can_access_style(style_id));
drop policy if exists material_review_rounds_read on public.material_review_rounds;
create policy material_review_rounds_read on public.material_review_rounds for select to authenticated using(exists(select 1 from public.material_review_items i where i.id=item_id and public.can_access_style(i.style_id)));
drop policy if exists material_review_images_read on public.material_review_attachments;
create policy material_review_images_read on public.material_review_attachments for select to authenticated using(exists(select 1 from public.material_review_rounds r join public.material_review_items i on i.id=r.item_id where r.id=round_id and public.can_access_style(i.style_id)));
drop policy if exists material_review_events_read on public.material_review_events;
create policy material_review_events_read on public.material_review_events for select to authenticated using(exists(select 1 from public.material_review_items i where i.id=item_id and public.can_access_style(i.style_id)));
revoke all on public.material_review_items,public.material_review_rounds,public.material_review_attachments,public.material_review_events from public,anon,authenticated,service_role;
grant select on public.material_review_items,public.material_review_rounds,public.material_review_attachments,public.material_review_events to authenticated;
revoke execute on function public.protect_material_review_history(),public.protect_material_review_item(),public.protect_material_review_round(),public.protect_material_review_attachment(),public.protect_material_review_storage(),public.material_review_round_images(uuid,jsonb) from public,anon,authenticated,service_role;
revoke execute on function public.get_material_reviews_capability(),public.save_material_review_item(uuid,uuid,uuid,integer,jsonb,text),public.append_material_review_round(uuid,uuid,integer,jsonb,text),public.decide_material_review_round(uuid,integer,jsonb,text) from public,anon,service_role;
grant execute on function public.get_material_reviews_capability(),public.save_material_review_item(uuid,uuid,uuid,integer,jsonb,text),public.append_material_review_round(uuid,uuid,integer,jsonb,text),public.decide_material_review_round(uuid,integer,jsonb,text) to authenticated;
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='material_review_items') then alter publication supabase_realtime add table public.material_review_items;end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='material_review_rounds') then alter publication supabase_realtime add table public.material_review_rounds;end if;
 end if;
end $$;
notify pgrst,'reload schema';
commit;
