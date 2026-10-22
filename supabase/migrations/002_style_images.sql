-- SIG SAMPLE MANAGEMENT: representative and color images.
-- Existing installations: apply this file once AFTER 001_initial.sql.
-- Images stay in the existing private sig-files bucket. This table stores only
-- references to immutable, style-common image attachments; no public URLs.
begin;

create table public.style_images (
  style_id uuid not null references public.styles(id) on delete restrict,
  color text not null default '' check (color='' or color ~ '^[A-Z]{2}$'),
  attachment_id uuid references public.attachments(id) on delete restrict,
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id),
  primary key (style_id, color)
);
create index style_images_attachment_idx on public.style_images(attachment_id) where attachment_id is not null;

-- A NULL attachment is a retained clearing record, not a deleted mapping. Keep
-- its version so an older editor cannot restore a cleared/replaced image.
create function public.set_style_image(
  p_style_id uuid,
  p_color text,
  p_attachment_id uuid,
  p_expected_version integer,
  p_reason text
) returns public.style_images
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor public.profiles;
  target_style public.styles;
  oldrow public.style_images;
  result public.style_images;
  stamp timestamptz:=clock_timestamp();
  audit_action text;
begin
  select * into actor from public.profiles
    where id=auth.uid() and approved and active and role in ('admin','internal');
  if not found then raise exception 'FORBIDDEN: representative images are managed by headquarters' using errcode='42501'; end if;
  if p_expected_version is null or p_expected_version < 0 then raise exception 'INVALID_VERSION'; end if;
  if length(trim(coalesce(p_reason,''))) < 2 or length(p_reason) > 1000 then
    raise exception 'REASON_REQUIRED: image changes require a reason of 2 to 1000 characters';
  end if;

  -- Lock the parent style before reading its mapping. This also serializes the
  -- first INSERT for a previously absent color and blocks a concurrent soft
  -- deletion/reassignment in save_style/soft_delete_style until this commits.
  select * into target_style from public.styles
    where id=p_style_id and deleted_at is null for update;
  if not found or not public.can_access_style(p_style_id) then
    raise exception 'FORBIDDEN: inaccessible style' using errcode='42501';
  end if;
  if p_color is null or not (p_color='' or (p_color ~ '^[A-Z]{2}$' and target_style.data->'colors' ? p_color)) then
    raise exception 'INVALID_IMAGE_COLOR: choose a color registered on this style';
  end if;

  select * into oldrow from public.style_images
    where style_id=p_style_id and color=p_color for update;
  if coalesce(oldrow.version,0) <> p_expected_version then
    raise exception 'VERSION_CONFLICT: the representative image changed; reload before saving' using errcode='40001';
  end if;
  if p_attachment_id is not null and not exists (
    select 1 from public.attachments a
    where a.id=p_attachment_id and a.style_id=p_style_id and a.sample_id is null
      and a.mime in ('image/jpeg','image/png','image/webp')
  ) then
    raise exception 'INVALID_IMAGE_ATTACHMENT: select a style-common image from this style';
  end if;

  if oldrow.style_id is null then
    insert into public.style_images(style_id,color,attachment_id,version,updated_at,updated_by)
      values(p_style_id,p_color,p_attachment_id,1,stamp,actor.id) returning * into result;
  else
    update public.style_images
      set attachment_id=p_attachment_id,version=oldrow.version+1,updated_at=stamp,updated_by=actor.id
      where style_id=p_style_id and color=p_color returning * into result;
  end if;
  audit_action:=case when p_attachment_id is null then '대표 이미지 해제'
    when oldrow.attachment_id is null then '대표 이미지 등록' else '대표 이미지 변경' end;
  insert into public.audits(style_id,actor_id,actor_name,action,reason,before,after)
    values(p_style_id,actor.id,actor.name,audit_action,trim(p_reason),
      case when oldrow.style_id is null then null else to_jsonb(oldrow) end,to_jsonb(result));
  return result;
end $$;

alter table public.style_images enable row level security;
create policy style_images_read on public.style_images for select to authenticated using (
  public.can_access_style(style_id)
  and exists(select 1 from public.styles s where s.id=style_id and s.deleted_at is null)
);
-- Never rely only on the interface for write controls or caller-supplied metadata.
revoke all on public.style_images from public,anon,authenticated;
grant select on public.style_images to authenticated;
revoke execute on function public.set_style_image(uuid,text,uuid,integer,text) from public,anon;
grant execute on function public.set_style_image(uuid,text,uuid,integer,text) to authenticated;

do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='style_images') then
    alter publication supabase_realtime add table public.style_images;
  end if;
end $$;
commit;
