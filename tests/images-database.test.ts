import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createSeed } from '../src/lib/seed'

// Execute both production migrations in PostgreSQL; hosted Storage and Realtime
// still require testing against the actual Supabase project after migration002.
const db = new PGlite()
const ids = {
  admin: '10000000-0000-4000-8000-000000000001',
  internal: '10000000-0000-4000-8000-000000000002',
  factory: '10000000-0000-4000-8000-000000000003',
  otherFactory: '10000000-0000-4000-8000-000000000004',
  pending: '10000000-0000-4000-8000-000000000005',
  f1: '20000000-0000-4000-8000-000000000001',
  f2: '20000000-0000-4000-8000-000000000002',
  project: '30000000-0000-4000-8000-000000000001',
  style: '40000000-0000-4000-8000-000000000001',
  otherStyle: '40000000-0000-4000-8000-000000000002',
  image: '70000000-0000-4000-8000-000000000001',
  replacement: '70000000-0000-4000-8000-000000000002',
  pdf: '70000000-0000-4000-8000-000000000003',
  sampleImage: '70000000-0000-4000-8000-000000000004',
  otherImage: '70000000-0000-4000-8000-000000000005',
}
interface ImageRow { style_id: string; color: string; attachment_id: string | null; version: number; updated_at: string; updated_by: string }
async function as(id: string | null, role='authenticated') {
  await db.exec(`reset role; set role ${role}`)
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || ''])
}
async function setImage(attachment: string | null, expected: number, color='', reason='대표 이미지 설정', style=ids.style) {
  return db.query<ImageRow>('select * from public.set_style_image($1,$2,$3,$4,$5)', [style,color,attachment,expected,reason])
}
async function row(color='') {
  return (await db.query<ImageRow>('select * from public.style_images where style_id=$1 and color=$2',[ids.style,color])).rows[0]
}
async function rollbackWork(fn: () => Promise<void>) {
  await db.exec('begin')
  try { await fn() } finally { await db.exec('rollback') }
}
beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;
    grant select,insert,update,delete on storage.objects to authenticated;
  `)
  await db.exec(readFileSync(new URL('../supabase/migrations/001_initial.sql',import.meta.url),'utf8'))
  await db.exec(readFileSync(new URL('../supabase/migrations/002_style_images.sql',import.meta.url),'utf8'))
  for (const key of ['admin','internal','factory','otherFactory','pending'] as const) {
    await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[ids[key],`${key}@example.test`,JSON.stringify({name:`예시 ${key}`})])
  }
  await db.query('insert into public.factories(id,name,country) values($1,$2,$3),($4,$5,$6)',[ids.f1,'예시 A','중국',ids.f2,'예시 B','베트남'])
  await db.query('insert into public.projects(id,name,season) values($1,$2,$3)',[ids.project,'예시 이미지 프로젝트','2026FW'])
  await db.query("update public.profiles set role='admin',approved=true where id=$1",[ids.admin])
  await db.query("update public.profiles set role='internal',approved=true where id=$1",[ids.internal])
  await db.query("update public.profiles set role='factory',approved=true,factory_id=$2 where id=$1",[ids.factory,ids.f1])
  await db.query("update public.profiles set role='factory',approved=true,factory_id=$2 where id=$1",[ids.otherFactory,ids.f2])
  const style=createSeed().styles[0]
  style.factoryId=ids.f1; style.ownerId=ids.internal; style.projectId=ids.project; style.version=0
  style.samples=style.samples.map(sample=>({...sample,factoryId:ids.f1,ownerId:ids.internal}))
  await as(ids.admin)
  await db.query('select * from public.save_style($1,$2::jsonb,0,$3)',[ids.style,JSON.stringify(style),'예시 스타일 등록'])
  const other=structuredClone(style); other.id=ids.otherStyle;other.code='EXAMPLE-IMAGE-OTHER';other.factoryId=ids.f2
  other.samples=other.samples.map(sample=>({...sample,factoryId:ids.f2}))
  await db.query('select * from public.save_style($1,$2::jsonb,0,$3)',[ids.otherStyle,JSON.stringify(other),'다른 공장 스타일 등록'])
  for (const [id,mime,sampleId,styleId] of [
    [ids.image,'image/png',null,ids.style],
    [ids.replacement,'image/webp',null,ids.style],
    [ids.pdf,'application/pdf',null,ids.style],
    [ids.sampleImage,'image/jpeg',style.samples[0].id,ids.style],
    [ids.otherImage,'image/png',null,ids.otherStyle],
  ] as const) {
    const path=`${styleId}/${id}.${mime==='application/pdf'?'pdf':mime.split('/')[1]}`
    await db.query("insert into storage.objects(bucket_id,name,metadata) values('sig-files',$1,$2)",[path,JSON.stringify({mimetype:mime,size:200})])
    await db.query('insert into public.attachments(id,style_id,sample_id,name,path,mime,size) values($1,$2,$3,$4,$5,$6,200)',[id,styleId,sampleId,`예시.${mime.split('/')[1]}`,path,mime])
  }
},30000)
afterAll(async () => {await db.close()})

describe.sequential('Private representative image SQL permissions and version history',()=>{
  it('lets approved headquarters set a style-wide cutout, with authoritative actor and time',async()=>{
    await as(ids.internal)
    const result=(await setImage(ids.image,0)).rows[0]
    expect(result).toMatchObject({style_id:ids.style,color:'',attachment_id:ids.image,version:1,updated_by:ids.internal})
    expect(new Date(result.updated_at).getTime()).toBeGreaterThan(Date.now()-60_000)
    const audits=await db.query<{action:string;actor_id:string;reason:string;before:unknown;after:ImageRow}>("select * from public.audits where action='대표 이미지 등록'")
    expect(audits.rows).toHaveLength(1)
    expect(audits.rows[0]).toMatchObject({actor_id:ids.internal,reason:'대표 이미지 설정',before:null,after:{attachment_id:ids.image,version:1}})
  })
  it('lets the assigned factory read while hiding mappings and private storage from another factory',async()=>{
    await as(ids.factory)
    expect((await row()).attachment_id).toBe(ids.image)
    expect((await db.query("select * from storage.objects where name like $1",[`${ids.style}/%`])).rows).toHaveLength(4)
    await as(ids.otherFactory)
    expect(await row()).toBeUndefined()
    expect((await db.query('select * from storage.objects where name like $1',[`${ids.style}/%`])).rows).toHaveLength(0)
  })
  it.each([['assigned factory',ids.factory],['other factory',ids.otherFactory],['pending user',ids.pending]])('rejects image-management RPC writes from %s',async(_label,id)=>{
    await as(id)
    await expect(setImage(ids.replacement,1)).rejects.toThrow(/FORBIDDEN/)
  })
  it('denies pending users all image metadata',async()=>{
    await as(ids.pending)
    expect((await db.query('select * from public.style_images')).rows).toHaveLength(0)
  })
  it('denies anonymous reads and RPC execution',async()=>{
    await as(null,'anon')
    await expect(db.query('select * from public.style_images')).rejects.toThrow(/permission denied/)
    await expect(setImage(ids.image,1)).rejects.toThrow(/permission denied/)
  })
  it('denies direct update/delete/insert even to administrators',async()=>{
    await as(ids.admin)
    await expect(db.query('update public.style_images set attachment_id=null')).rejects.toThrow(/permission denied/)
    await expect(db.query('delete from public.style_images')).rejects.toThrow(/permission denied/)
    await expect(db.query('insert into public.style_images(style_id,color,attachment_id,updated_by) values($1,$2,$3,$4)',[ids.style,'BK',ids.image,ids.admin])).rejects.toThrow(/permission denied/)
  })
  it.each([['a PDF',ids.pdf],['a sample-scoped image',ids.sampleImage],['another style image',ids.otherImage],['an unknown image','70000000-0000-4000-8000-000000000099']])('rejects %s as a representative image',async(_label,id)=>{
    await as(ids.admin)
    await expect(setImage(id,1)).rejects.toThrow(/INVALID_IMAGE_ATTACHMENT/)
    expect((await row()).version).toBe(1)
  })
  it.each(['bk','ZZ','B',' BK'])('rejects invalid or unregistered color %s',async(color)=>{
    await as(ids.admin)
    await expect(setImage(ids.image,0,color)).rejects.toThrow(/INVALID_IMAGE_COLOR/)
  })
  it.each(['','한','x'.repeat(1001)])('requires a bounded reason (%s)',async(reason)=>{
    await as(ids.admin)
    await expect(setImage(ids.replacement,1,'',reason)).rejects.toThrow(/REASON_REQUIRED/)
  })
  it('allows a color override without overwriting the style fallback',async()=>{
    await as(ids.admin)
    const specific=(await setImage(ids.replacement,0,'BK','검정 컬러별 대표 이미지')).rows[0]
    expect(specific).toMatchObject({color:'BK',attachment_id:ids.replacement,version:1})
    expect((await row()).attachment_id).toBe(ids.image)
  })
  it('replaces an image, then rejects an old editor and duplicate initial writer',async()=>{
    await as(ids.internal)
    expect((await setImage(ids.replacement,1)).rows[0].version).toBe(2)
    await expect(setImage(ids.image,1)).rejects.toThrow(/VERSION_CONFLICT/)
    await expect(setImage(ids.image,0,'BK')).rejects.toThrow(/VERSION_CONFLICT/)
    expect((await row()).attachment_id).toBe(ids.replacement)
  })
  it('preserves tombstones and rejects stale restore after clearing/recreating',async()=>{
    await as(ids.internal)
    const cleared=(await setImage(null,2,'','이미지 연결 해제')).rows[0]
    expect(cleared).toMatchObject({attachment_id:null,version:3})
    await expect(setImage(ids.image,0)).rejects.toThrow(/VERSION_CONFLICT/)
    await expect(setImage(ids.image,2)).rejects.toThrow(/VERSION_CONFLICT/)
    const restored=(await setImage(ids.image,3,'','새 대표 이미지 등록')).rows[0]
    expect(restored).toMatchObject({attachment_id:ids.image,version:4})
    await expect(setImage(ids.replacement,3)).rejects.toThrow(/VERSION_CONFLICT/)
    const audits=(await db.query<{action:string;before:ImageRow;after:ImageRow}>("select action,before,after from public.audits where action like '대표 이미지 %' order by created_at")).rows
    expect(audits.some(a=>a.action==='대표 이미지 해제'&&a.before.attachment_id===ids.replacement&&a.after.attachment_id===null)).toBe(true)
    expect(audits.at(-1)?.after.version).toBe(4)
    expect((await db.query('select * from public.attachments where id=$1',[ids.replacement])).rows).toHaveLength(1)
  })
  it('retains audit records but prevents metadata/image updates on a deleted style',async()=>{
    await rollbackWork(async()=>{
      await as(ids.admin)
      const style=(await db.query<{version:number}>('select version from public.styles where id=$1',[ids.style])).rows[0]
      await db.query('select * from public.soft_delete_style($1,$2,$3)',[ids.style,style.version,'대표 이미지 포함 보존 삭제'])
      expect(await row()).toBeUndefined()
      const audits=await db.query("select * from public.audits where style_id=$1 and action like '대표 이미지 %'",[ids.style])
      expect(audits.rows.length).toBeGreaterThan(0)
      await as(ids.factory)
      expect((await db.query('select * from public.style_images')).rows).toHaveLength(0)
      await as(ids.admin)
      await expect(setImage(ids.replacement,4)).rejects.toThrow(/FORBIDDEN/)
    })
  })
  it('immediately revokes metadata and RPC access when a user becomes inactive',async()=>{
    await rollbackWork(async()=>{
      await as(ids.admin)
      await db.exec('reset role')
      await db.query('update public.profiles set active=false where id=$1',[ids.internal])
      await as(ids.internal)
      expect((await db.query('select * from public.style_images')).rows).toHaveLength(0)
      await expect(setImage(ids.image,4)).rejects.toThrow(/FORBIDDEN/)
    })
  })
  it('hides images from the former factory after style reassignment',async()=>{
    await rollbackWork(async()=>{
      await as(ids.admin)
      const style=(await db.query<{data:Record<string,unknown>;version:number}>('select data,version from public.styles where id=$1',[ids.style])).rows[0]
      const data=style.data;data.factoryId=ids.f2
      await db.query('select * from public.save_style($1,$2::jsonb,$3,$4)',[ids.style,JSON.stringify(data),style.version,'공장 재배정'])
      await as(ids.factory)
      expect((await db.query('select * from public.style_images')).rows).toHaveLength(0)
      expect((await db.query('select * from storage.objects where name like $1',[`${ids.style}/%`])).rows).toHaveLength(0)
      await as(ids.otherFactory)
      expect((await db.query('select * from public.style_images where style_id=$1',[ids.style])).rows).toHaveLength(2)
    })
  })
})
