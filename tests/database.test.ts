import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createSeed } from '../src/lib/seed'

// A real PostgreSQL WASM engine executes the production SQL with Supabase's
// auth/storage contracts stubbed. Hosted Auth/Storage/Realtime need staging tests.
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
  sample: '50000000-0000-4000-8000-000000000001',
  production: '60000000-0000-4000-8000-000000000001',
}
const zero = { XXS: 0, XS: 0, S: 0, M: 0, L: 0, XL: 0 }
const initial = {
  id: ids.style, code: 'EXAMPLE-ONLY-001', name: '예시 테스트 스타일', category: 'OUTER', season: '2026FW',
  projectId: ids.project, factoryId: ids.f1, ownerId: ids.internal, colors: ['BK'], dueDate: '2026-12-01', stage: 'sample1', ppApproved: false, notes: '',
  samples: [{ id: ids.sample, round: 1, isPP: false, status: 'progress', factoryId: ids.f1, ownerId: ids.internal,
    requestedAt: '2026-10-01', plannedAt: '2026-10-10', completedAt: '', shippedAt: '', receivedAt: '', reviewedAt: '', tracking: '', request: '본사 요청', factoryComment: '', updatedAt: '' }],
  production: [{ id: ids.production, color: 'BK', order: { ...zero, M: 100 }, shipped: zero, received: zero, packing: zero,
    checks: { tp: 'done', pp: 'unset', gb: 'unset', labels: 'unset', care: 'unset', materials: 'unset', packing: 'unset', main: 'unset', quality: 'unset', packingList: 'unset' },
    confirmDue: '', shippedAt: '', receivedAt: '', invoice: 'unset', invoiceAmount: 0, paymentDue: '', paymentStatus: 'unset', measurements: '', factoryComment: '' }],
  version: 0, updatedAt: '', updatedBy: ids.admin, deletedAt: null,
}
type Doc = typeof initial
async function as(user: string | null, role = 'authenticated') {
  await db.exec(`reset role; set role ${role};`)
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user || ''])
}
async function current(): Promise<Doc> {
  const { rows } = await db.query<{ data: Doc }>('select data from public.styles where id=$1', [ids.style])
  return structuredClone(rows[0].data)
}
async function save(data: Doc, expected = data.version, reason = '') {
  return db.query<{ data: Doc; version: number }>('select * from public.save_style($1,$2::jsonb,$3,$4)', [ids.style, JSON.stringify(data), expected, reason])
}
beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
    grant select,insert,update,delete on storage.objects to authenticated;
  `)
  await db.exec(readFileSync(new URL('../supabase/migrations/001_initial.sql', import.meta.url), 'utf8'))
  for (const [name, id] of Object.entries(ids).filter(([name]) => ['admin','internal','factory','otherFactory','pending'].includes(name))) {
    await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{\"role\":\"admin\",\"approved\":true,\"name\":\"테스트 사용자\"}')", [id, `${name}@example.test`])
  }
  await db.query('insert into public.factories(id,name,country) values ($1,$2,$3),($4,$5,$6)', [ids.f1,'예시 A 공장','중국',ids.f2,'예시 B 공장','베트남'])
  await db.query('insert into public.projects(id,name,season) values ($1,$2,$3)', [ids.project,'예시 프로젝트','2026FW'])
  await db.query("update public.profiles set role='admin',approved=true where id=$1", [ids.admin])
  await db.query("update public.profiles set role='internal',approved=true where id=$1", [ids.internal])
  await db.query("update public.profiles set role='factory',approved=true,factory_id=$2 where id=$1", [ids.factory,ids.f1])
  await db.query("update public.profiles set role='factory',approved=true,factory_id=$2 where id=$1", [ids.otherFactory,ids.f2])
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('Supabase production SQL security and collaboration', () => {
  it('ignores signup role/approval claims and exposes only the pending user profile', async () => {
    await as(ids.pending)
    const { rows } = await db.query<{ role:string;approved:boolean }>('select role,approved from public.profiles')
    expect(rows).toEqual([{ role: 'internal', approved: false }])
    expect((await db.query('select * from public.styles')).rows).toHaveLength(0)
    expect((await db.query('select * from public.factories')).rows).toHaveLength(0)
    expect((await db.query('select * from public.projects')).rows).toHaveLength(0)
    await expect(save(initial, 0)).rejects.toThrow(/FORBIDDEN/)
  })
  it('allows headquarters to register a validated style and stamps actor/version', async () => {
    await as(ids.internal)
    const result = await save(initial, 0, '최초 등록')
    expect(result.rows[0].version).toBe(1)
    expect(result.rows[0].data.updatedBy).toBe(ids.internal)
    expect((await db.query("select * from public.audits where style_id is not null")).rows).toHaveLength(1)
  })
  it('server-stamps new/changed sample timestamps and preserves unchanged timestamps despite spoofed input', async () => {
    await db.exec('begin')
    try {
      await as(ids.admin)
      const doc=await current()
      const spoof='1900-01-01T00:00:00.000Z'
      doc.samples[0].factoryComment='서버 시각으로 기록할 변경';doc.samples[0].updatedAt=spoof
      doc.samples.push({...doc.samples[0],id:'50000000-0000-4000-8000-000000000002',round:2,updatedAt:spoof})
      const changed=(await save(doc,doc.version,'샘플 이력 검증')).rows[0].data
      expect(changed.samples.every(sample=>sample.updatedAt===changed.updatedAt)).toBe(true)
      expect(new Date(changed.samples[0].updatedAt).getTime()).toBeGreaterThan(Date.now()-60_000)
      const unchanged=structuredClone(changed)
      unchanged.notes='샘플 이외의 스타일 메모만 변경'
      unchanged.samples.forEach(sample=>{sample.updatedAt=spoof})
      const saved=(await save(unchanged,unchanged.version,'스타일 메모 변경')).rows[0].data
      expect(saved.samples.map(sample=>sample.updatedAt)).toEqual(changed.samples.map(sample=>sample.updatedAt))
      expect(saved.samples.every(sample=>sample.updatedAt!==spoof)).toBe(true)
    } finally { await db.exec('rollback') }
  })
  it('denies anonymous table and RPC access', async () => {
    await as(null, 'anon')
    await expect(db.query('select * from public.styles')).rejects.toThrow(/permission denied/)
    await expect(save(initial, 0)).rejects.toThrow(/permission denied/)
    await expect(db.query('select * from public.visible_style_owners()')).rejects.toThrow(/permission denied/)
  })
  it('denies direct style writes even to approved administrators', async () => {
    await as(ids.admin)
    await expect(db.query("update public.styles set data='{}' where id=$1", [ids.style])).rejects.toThrow(/permission denied/)
    await expect(db.query('delete from public.styles where id=$1', [ids.style])).rejects.toThrow(/permission denied/)
  })
  it('hides other factory styles, projects, profiles, audit rows and RPC edits', async () => {
    await as(ids.otherFactory)
    expect((await db.query('select * from public.styles')).rows).toHaveLength(0)
    expect((await db.query('select * from public.projects')).rows).toHaveLength(0)
    expect((await db.query('select * from public.audits')).rows).toHaveLength(0)
    expect((await db.query('select * from public.profiles')).rows).toHaveLength(1)
    await expect(save(initial, 1)).rejects.toThrow(/FORBIDDEN/)
  })
  it('returns only scoped owner display identities without exposing full employee profiles', async () => {
    await as(ids.factory)
    const {rows}=await db.query<{id:string;name:string;role:string}>('select * from public.visible_style_owners()')
    expect(rows).toEqual([{id:ids.internal,name:'테스트 사용자',role:'internal'}])
    expect(Object.keys(rows[0]).sort()).toEqual(['id','name','role'])
    expect(rows.some(row=>row.id===ids.admin)).toBe(false)
    // The full profiles table still exposes only the factory user's own row.
    expect((await db.query('select id from public.profiles')).rows).toEqual([{id:ids.factory}])
    await as(ids.otherFactory)
    expect((await db.query('select * from public.visible_style_owners()')).rows).toHaveLength(0)
    await as(ids.pending)
    expect((await db.query('select * from public.visible_style_owners()')).rows).toHaveLength(0)
    // A sample may have a different HQ owner: include that name, then roll the
    // fixture change back so the subsequent optimistic-version cases stay fixed.
    await db.exec('begin')
    try {
      await as(ids.admin)
      const doc=await current();doc.samples[0].ownerId=ids.admin;await save(doc)
      await as(ids.factory)
      const sampleOwners=await db.query<{id:string}>('select * from public.visible_style_owners()')
      expect(sampleOwners.rows.map(row=>row.id).sort()).toEqual([ids.admin,ids.internal].sort())
    } finally { await db.exec('rollback') }
  })
  it('allows an assigned factory progress, shipping quantity and tracking updates', async () => {
    await as(ids.factory)
    const doc = await current()
    doc.samples[0].factoryComment='제작 진행 중'
    doc.samples[0].tracking='EXAMPLE-TRACKING'
    doc.production[0].shipped={ ...zero, M:25 }
    const { rows }=await save(doc)
    expect(rows[0].version).toBe(2)
    expect(rows[0].data.updatedBy).toBe(ids.factory)
  })
  it.each([
    ['headquarters deadline',(d:Doc)=>{d.dueDate='2026-12-02'}],
    ['final PP approval',(d:Doc)=>{d.ppApproved=true}],
    ['headquarters request',(d:Doc)=>{d.samples[0].request='임의 수정'}],
    ['sample approval',(d:Doc)=>{d.samples[0].status='approved'}],
    ['sample headquarters receipt date',(d:Doc)=>{d.samples[0].receivedAt='2026-10-18'}],
    ['sample review date',(d:Doc)=>{d.samples[0].reviewedAt='2026-10-20'}],
    ['materials confirmation',(d:Doc)=>{d.production[0].checks.materials='done'}],
    ['receipt quantity',(d:Doc)=>{d.production[0].received={...zero,M:1}}],
    ['order quantity',(d:Doc)=>{d.production[0].order={...zero,M:1}}],
    ['settlement amount',(d:Doc)=>{d.production[0].invoiceAmount=1000}],
    ['payment status',(d:Doc)=>{d.production[0].paymentStatus='done'}],
  ])('blocks factory modification of %s',async (_label,modify)=>{
    await as(ids.factory)
    const doc=await current();modify(doc)
    await expect(save(doc,doc.version,'테스트 변경')).rejects.toThrow(/FORBIDDEN_FIELD/)
  })
  it('blocks factory registration of extra sample/PP records', async () => {
    await as(ids.factory)
    const doc=await current();doc.samples.push({...doc.samples[0],id:'50000000-0000-4000-8000-000000000002',round:2,isPP:true})
    await expect(save(doc,doc.version,'임의 PP 추가')).rejects.toThrow(/FORBIDDEN_FIELD/)
  })
  it('requires a reason for date changes and records before/after dates', async () => {
    await as(ids.factory)
    const doc=await current();doc.samples[0].plannedAt='2026-10-12'
    await expect(save(doc)).rejects.toThrow(/REASON_REQUIRED/)
    const {rows}=await save(doc,doc.version,'원단 공급 일정 변경')
    expect(rows[0].data.samples[0].plannedAt).toBe('2026-10-12')
    const audits=await db.query<{before:Doc;after:Doc;reason:string}>('select * from public.audits order by created_at desc limit 1')
    expect(audits.rows[0].before.samples[0].plannedAt).toBe('2026-10-10')
    expect(audits.rows[0].reason).toBe('원단 공급 일정 변경')
  })
  it('rejects stale concurrent saves without losing newer changes', async () => {
    await as(ids.internal)
    const a=await current();const b=structuredClone(a)
    a.notes='사용자 A 변경';await save(a)
    b.notes='사용자 B 변경';await expect(save(b)).rejects.toThrow(/VERSION_CONFLICT/)
    expect((await current()).notes).toBe('사용자 A 변경')
  })
  it('blocks internal shipment and receipt quantity editing', async () => {
    await as(ids.internal)
    const doc=await current();doc.production[0].shipped={...zero,M:100}
    await expect(save(doc)).rejects.toThrow(/FORBIDDEN_FIELD/)
    doc.production[0].shipped={...zero,M:25};doc.production[0].received={...zero,M:25}
    await expect(save(doc)).rejects.toThrow(/FORBIDDEN_FIELD/)
  })
  it('allows administrator receipt entry and preserves per-size values', async () => {
    await as(ids.admin)
    const doc=await current();doc.production[0].received={...zero,M:24}
    const {rows}=await save(doc)
    expect(rows[0].data.production[0].received.M).toBe(24)
  })
  it('preserves sample and production history against deletion or renumbering', async () => {
    await as(ids.admin)
    const doc=await current();doc.samples=[]
    await expect(save(doc)).rejects.toThrow(/HISTORY_PROTECTED/)
    const next=await current();next.samples[0].round=2
    await expect(save(next)).rejects.toThrow(/HISTORY_PROTECTED/)
  })
  it.each([
    ['negative quantity',(d:Doc)=>{d.production[0].order.M=-1}],
    ['fractional quantity',(d:Doc)=>{d.production[0].order.M=1.5}],
    ['invalid status',(d:Doc)=>{d.samples[0].status='hacked'}],
    ['invalid date',(d:Doc)=>{d.dueDate='2026-02-30'}],
    ['unknown property',(d:Doc)=>{Object.assign(d,{admin:true})}],
    ['null sample id',(d:Doc)=>{Object.assign(d.samples[0],{id:null})}],
    ['null production id',(d:Doc)=>{Object.assign(d.production[0],{id:null})}],
    ['noncanonical factory id',(d:Doc)=>{d.factoryId=d.factoryId.replaceAll('-','')}],
    ['duplicate sample id',(d:Doc)=>{d.samples.push({...d.samples[0],round:2})}],
  ])('validates %s on the database server', async (_label,modify)=>{
    await as(ids.admin);const doc=await current();modify(doc)
    await expect(save(doc,doc.version,'검증 테스트')).rejects.toThrow()
  })
  it('stamps comments with the authenticated author and keeps them immutable', async () => {
    await as(ids.factory)
    await db.query('insert into public.comments(style_id,sample_id,body,author_id,author_name) values($1,$2,$3,$4,$5)',[ids.style,ids.sample,'테스트 코멘트',ids.admin,'위조 관리자'])
    const {rows}=await db.query<{author_id:string;author_name:string}>('select * from public.comments')
    expect(rows[0].author_id).toBe(ids.factory)
    expect(rows[0].author_name).not.toBe('위조 관리자')
    await expect(db.query("update public.comments set body='changed'")).rejects.toThrow(/permission denied/)
    await expect(db.query('delete from public.audits')).rejects.toThrow(/permission denied/)
  })
  it('blocks cross-factory comments and attachment uploads with private storage RLS', async () => {
    await as(ids.otherFactory)
    await expect(db.query('insert into public.comments(style_id,body) values($1,$2)',[ids.style,'공장 침범'])).rejects.toThrow(/FORBIDDEN/)
    await expect(db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)', ['sig-files',`${ids.style}/70000000-0000-4000-8000-000000000001.pdf`,'{"size":10,"mimetype":"application/pdf"}'])).rejects.toThrow(/row-level security/)
  })
  it('accepts a private assigned-style upload and enforces metadata integrity', async () => {
    await as(ids.factory)
    const path=`${ids.style}/70000000-0000-4000-8000-000000000001.pdf`
    await db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)', ['sig-files',path,'{"size":10,"mimetype":"application/pdf"}'])
    await expect(db.query('insert into public.attachments(style_id,name,path,mime,size) values($1,$2,$3,$4,$5)',[ids.style,'example.pdf',path,'image/png',10])).rejects.toThrow(/METADATA_MISMATCH/)
    await db.query('insert into public.attachments(style_id,name,path,mime,size) values($1,$2,$3,$4,$5)',[ids.style,'example.pdf',path,'application/pdf',10])
    expect((await db.query('select * from public.attachments')).rows).toHaveLength(1)
    await as(ids.otherFactory)
    expect((await db.query('select * from storage.objects')).rows).toHaveLength(0)
    expect((await db.query('select * from public.attachments')).rows).toHaveLength(0)
  })
  it('only administrators approve accounts and prevents self-revocation', async () => {
    await as(ids.internal)
    await expect(db.query('select public.manage_profile($1,$2,$3,$4,$5,$6)',[ids.pending,'승인 사용자','internal',true,true,null])).rejects.toThrow(/FORBIDDEN/)
    await as(ids.admin)
    await expect(db.query('select public.manage_profile($1,$2,$3,$4,$5,$6)',[ids.admin,'관리자','internal',true,true,null])).rejects.toThrow(/LAST_ADMIN_PROTECTED/)
    await db.query('select public.manage_profile($1,$2,$3,$4,$5,$6)',[ids.pending,'승인 사용자','internal',true,true,null])
    await as(ids.pending)
    expect((await db.query('select * from public.styles')).rows).toHaveLength(1)
  })
  it('applies account revocation immediately to reads and RPC writes', async () => {
    await as(ids.admin)
    await db.query('select public.manage_profile($1,$2,$3,$4,$5,$6)',[ids.pending,'승인 사용자','internal',false,true,null])
    await as(ids.pending)
    expect((await db.query('select * from public.styles')).rows).toHaveLength(0)
    await expect(save(initial,1)).rejects.toThrow(/FORBIDDEN/)
  })
  it('applies active=false revocation immediately even when approved remains true', async () => {
    await as(ids.admin)
    await db.query('select public.manage_profile($1,$2,$3,$4,$5,$6)',[ids.pending,'비활성 사용자','internal',true,false,null])
    await as(ids.pending)
    expect((await db.query('select * from public.styles')).rows).toHaveLength(0)
    await expect(save(initial,1)).rejects.toThrow(/FORBIDDEN/)
  })
  it('audits administrator factory/project edits and blocks non-admin writes', async () => {
    await as(ids.internal)
    await expect(db.query('insert into public.factories(name,country) values($1,$2)',['침범 공장','한국'])).rejects.toThrow(/row-level security/)
    await as(ids.admin)
    await db.query('update public.factories set name=$1 where id=$2',['예시 A 수정',ids.f1])
    const {rows}=await db.query<{actor_id:string;before:{name:string};after:{name:string}}>("select * from public.audits where action='공장 수정' order by created_at desc limit 1")
    expect(rows[0].actor_id).toBe(ids.admin)
    expect(rows[0].before.name).toBe('예시 A 공장')
    expect(rows[0].after.name).toBe('예시 A 수정')
  })
  it('soft deletes only for administrators and preserves data, comments, files and audit', async () => {
    await as(ids.internal)
    await expect(db.query('select public.soft_delete_style($1,$2,$3)',[ids.style,1,'테스트 삭제'])).rejects.toThrow(/FORBIDDEN/)
    await as(ids.admin)
    const doc=await current()
    await db.query('select public.soft_delete_style($1,$2,$3)',[ids.style,doc.version,'예시 스타일 정리'])
    const deleted=await current();expect(deleted.deletedAt).toBeTruthy()
    expect((await db.query('select * from public.comments')).rows).toHaveLength(1)
    expect((await db.query('select * from public.attachments')).rows).toHaveLength(1)
    expect((await db.query("select * from public.audits where action='스타일 삭제'")).rows).toHaveLength(1)
    await as(ids.factory)
    expect((await db.query('select * from public.styles')).rows).toHaveLength(0)
    expect((await db.query('select * from storage.objects')).rows).toHaveLength(0)
  })
  it('accepts the actual frontend fixture and revokes all former-factory history/file access after reassignment', async () => {
    const fixture=structuredClone(createSeed().styles[0])
    fixture.id='80000000-0000-4000-8000-000000000001';fixture.version=0
    await as(ids.admin)
    const saved=await db.query<{data:typeof fixture;version:number}>('select * from public.save_style($1,$2::jsonb,$3,$4)',[fixture.id,JSON.stringify(fixture),0,'프론트엔드 예시 계약 검증'])
    expect(saved.rows[0].data.code).toBe(fixture.code)
    expect(saved.rows[0].data.production).toEqual(fixture.production)
    expect(saved.rows[0].data.samples.map(s=>s.id)).toEqual(fixture.samples.map(s=>s.id))
    await as(ids.factory)
    await db.query('insert into public.comments(style_id,body) values($1,$2)',[fixture.id,'배정 변경 전 공장 코멘트'])
    const path=`${fixture.id}/81000000-0000-4000-8000-000000000001.jpeg`
    await db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)',['sig-files',path,'{"size":32,"mimetype":"image/jpeg"}'])
    await db.query('insert into public.attachments(style_id,name,path,mime,size) values($1,$2,$3,$4,$5)',[fixture.id,'예시사진.jpg',path,'image/jpeg',32])
    await as(ids.admin)
    const reassigned=saved.rows[0].data
    reassigned.factoryId=ids.f2
    reassigned.samples=reassigned.samples.map(s=>({...s,factoryId:ids.f2}))
    await db.query('select * from public.save_style($1,$2::jsonb,$3,$4)',[fixture.id,JSON.stringify(reassigned),saved.rows[0].version,'담당 공장 변경'])
    await as(ids.factory)
    for (const table of ['styles','comments','attachments','audits']) {
      const field=table==='styles'?'id':'style_id'
      expect((await db.query(`select * from public.${table} where ${field}=$1`,[fixture.id])).rows).toHaveLength(0)
    }
    expect((await db.query('select * from storage.objects where name=$1',[path])).rows).toHaveLength(0)
    await as(ids.otherFactory)
    expect((await db.query('select * from public.styles where id=$1',[fixture.id])).rows).toHaveLength(1)
    expect((await db.query('select * from public.comments where style_id=$1',[fixture.id])).rows).toHaveLength(1)
    expect((await db.query('select * from public.attachments where style_id=$1',[fixture.id])).rows).toHaveLength(1)
    expect((await db.query('select * from public.audits where style_id=$1',[fixture.id])).rows.length).toBeGreaterThan(1)
  })
  it('runs the optional example SQL seed twice without duplicating or overwriting data', async () => {
    await db.exec('reset role')
    const sql=readFileSync(new URL('../supabase/seed.sql',import.meta.url),'utf8')
    await db.exec(sql)
    await db.exec(sql)
    const {rows}=await db.query<{code:string;name:string}>("select data->>'code' code,data->>'name' name from public.styles where id='92000000-0000-4000-8000-000000000001'")
    expect(rows).toEqual([{code:'EXAMPLE-JK1601',name:'[예시] DENIM JACKET'}])
  })
})
