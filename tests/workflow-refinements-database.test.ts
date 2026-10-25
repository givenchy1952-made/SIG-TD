import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { blankProduction } from '../src/lib/types'
import { blankProductionDetails } from '../src/lib/workflow-refinements'
import type { CalendarEventInput } from '../src/lib/operations-types'

const db = new PGlite(), fixture = createSeed(), first = structuredClone(fixture.styles[0])
const ownFactory = '92000000-0000-4000-8000-000000000001'
let transaction = false, sequence = 0
async function query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  if (!transaction) return db.query<T>(sql, params)
  const point = `workflow_${sequence++}`; await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(sql, params); await db.exec(`release savepoint ${point}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await fn() } finally { transaction = false; await db.exec('rollback') } }
const calendar = (change: Partial<CalendarEventInput> = {}): CalendarEventInput => ({ kind: 'personal_leave', visibility: 'private', title: '테스트 휴가', startDate: '2026-11-02', endDate: '2026-11-02', ownerId: DEMO_IDS.internal, factoryId: null, note: '', deleted: false, ...change })
async function saveEvent(data = calendar(), id = crypto.randomUUID(), version = 0) { return query('select * from public.save_calendar_event($1,$2,$3::jsonb,$4)', [id, version, JSON.stringify(data), '휴가 일정 테스트']) }
async function saveDetails(data: unknown = blankProductionDetails(), version = 0, lineId = first.production[0].id, styleId = first.id) { return query('select * from public.save_production_details($1,$2,$3,$4::jsonb,$5)', [styleId, lineId, version, JSON.stringify(data), '품질 치수 테스트']) }
const project = () => ({ id: crypto.randomUUID(), code: `QA-${crypto.randomUUID()}`, name: `테스트 프로젝트 ${crypto.randomUUID()}`, season: '2026FY', expected: null })
function newStyle(projectId: string) { return { ...structuredClone(first), id: crypto.randomUUID(), code: `QA${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`, name: '', season: '2026FY', projectId, colors: ['BK'], production: [blankProduction('BK')], samples: [], stage: 'registered' as const, ppApproved: false, notes: '', category: '', version: 0, deletedAt: null } }
async function register(style: ReturnType<typeof newStyle>, p: object) { return query('select * from public.register_order_style($1,$2,$3::jsonb,$4::jsonb,$5)', [style.id, style.version, JSON.stringify(style), JSON.stringify(p), '오더 스타일 등록 테스트']) }
beforeAll(async () => {
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;
    grant execute on function auth.uid() to authenticated,anon,service_role;
    grant select,insert,update,delete on storage.objects to authenticated;`)
  for (const name of ['001_initial.sql', '002_style_images.sql', '003_operations.sql', '004_settlement_terms.sql', '005_workflow_refinements.sql']) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const row of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [row.id, row.name, row.country])
  for (const row of fixture.projects) await query('insert into public.projects(id,name,season) values($1,$2,$3)', [row.id, row.name, row.season])
  for (const row of [...fixture.profiles, { id: ownFactory, name: '테스트 배정 공장', email: 'workflow-factory@example.test', role: 'factory', approved: true, active: true, factoryId: first.factoryId }]) {
    await query('insert into auth.users(id,email) values($1,$2)', [row.id, row.email])
    await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [row.id, row.name, row.role, row.approved, row.active, row.factoryId])
  }
  await as(DEMO_IDS.admin); first.version = 0
  await query('select * from public.save_style($1,$2::jsonb,0,$3)', [first.id, JSON.stringify(first), '기존 생산 스타일 테스트'])
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('005 실제 PostgreSQL 휴가·품질·치수·오더 등록', () => {
  it('기존 프로젝트에 빈 코드를 추가하고 승인 사용자에게 기능 상태를 제공한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    expect((await query('select code from public.projects limit 1')).rows[0].code).toBe('')
    expect((await query('select public.get_workflow_refinements_capability() as enabled')).rows[0].enabled).toBe(true)
    await as(fixture.profiles.find(p => !p.approved)!.id)
    expect((await query('select public.get_workflow_refinements_capability() as enabled')).rows[0].enabled).toBe(false)
  }))
  it.each(['am', 'pm'] as const)('%s 반차와 공개 범위 및 수정 이력을 저장한다', async subtype => isolated(async () => {
    await as(DEMO_IDS.internal)
    const id = crypto.randomUUID(), row = (await saveEvent(calendar({ leaveType: subtype, startTime: '', endTime: '' }), id)).rows[0]
    expect(row).toMatchObject({ leave_type: subtype, start_time: '', end_time: '', version: 1 })
    const audit = (await query('select * from public.calendar_event_audits where event_id=$1', [id])).rows[0]
    expect(audit.after).toMatchObject({ leave_type: subtype })
    await as(DEMO_IDS.admin)
    expect((await query('select * from public.calendar_events where id=$1', [id])).rows).toHaveLength(0)
  }))
  it('반반차는 당일의 정확한 두 시간을 저장하고 낡은 버전을 거부한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    const id = crypto.randomUUID(), data = calendar({ leaveType: 'two_hours', startTime: '10:30', endTime: '12:30' })
    expect((await saveEvent(data, id)).rows[0]).toMatchObject({ leave_type: 'two_hours', start_time: '10:30', end_time: '12:30' })
    await expect(saveEvent(data, id, 0)).rejects.toThrow(/VERSION_CONFLICT/)
    for (const change of [{ endTime: '12:00' }, { startTime: '22:00', endTime: '00:00' }, { startTime: 'bad' }, { endDate: '2026-11-03' }]) await expect(saveEvent({ ...data, ...change })).rejects.toThrow(/INVALID_LEAVE/)
  }))
  it('종일·다른 일정의 부적절한 시간이나 반차 구분 및 우회용 구버전 RPC를 차단한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    for (const data of [calendar({ leaveType: 'full', startTime: '09:00' }), calendar({ kind: 'launch', visibility: 'all', leaveType: 'am' }), calendar({ leaveType: 'am', endDate: '2026-11-03' })]) await expect(saveEvent(data)).rejects.toThrow(/INVALID_LEAVE/)
    await expect(query('select public.save_calendar_event_v1($1,0,$2::jsonb,$3)', [crypto.randomUUID(), JSON.stringify(calendar()), '권한 우회 시도'])).rejects.toThrow(/permission denied/)
  }))
  it('조회 불가한 개인 일정은 반차 구분을 검증하기 전에 권한을 거부한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    const id = crypto.randomUUID(); await saveEvent(calendar({ leaveType: 'am' }), id)
    await as(ownFactory)
    await expect(saveEvent(calendar({ ownerId: ownFactory, endDate: '2026-11-03' }), id, 1)).rejects.toThrow(/FORBIDDEN/)
    expect((await query('select * from public.calendar_event_audits where event_id=$1', [id])).rows).toHaveLength(0)
  }))
  it('추가 필드 없는 기존 일정 저장은 유지되고 기존 반차를 메모 변경 시 지우지 않는다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    expect((await saveEvent()).rows[0].leave_type).toBe('full')
    const id = crypto.randomUUID()
    await saveEvent(calendar({ leaveType: 'pm' }), id)
    expect((await saveEvent(calendar({ note: '기존 클라이언트 메모' }), id, 1)).rows[0]).toMatchObject({ leave_type: 'pm', note: '기존 클라이언트 메모', version: 2 })
  }))
  it.each(['아우터', '니트', '티셔츠', '바지', '가방', '악세사리', '모자'] as const)('%s 품질 검사를 기존 생산 수량과 독립 저장한다', async category => isolated(async () => {
    await as(DEMO_IDS.internal)
    const before = (await query('select data,version from public.styles where id=$1', [first.id])).rows[0]
    const data = blankProductionDetails(); data.quality = { category, quantity: 100, status: 'progress', requestedAt: '2026-11-01', completedAt: '', note: '테스트 검사 작업' }
    const row = (await saveDetails(data)).rows[0]
    expect(row.data.quality).toEqual(data.quality)
    expect((await query('select data,version from public.styles where id=$1', [first.id])).rows[0]).toEqual(before)
  }))
  it('상의·하의·편차·XXL의 null과 0을 구분하며 저장하고 이전 값 이력을 남긴다', async () => isolated(async () => {
    await as(DEMO_IDS.admin)
    const data = blankProductionDetails(); data.measurements.upper[0].values.XXS = 0; data.measurements.upper[0].values.XXL = 71.25; data.measurements.lower[0].grade = 1.5
    await saveDetails(data)
    data.measurements.upper[0].values.XXL = 72.5
    expect((await saveDetails(data, 1)).rows[0].version).toBe(2)
    const audits = (await query("select before,after from public.audits where action='품질 검사·사이즈 측정 저장' order by created_at")).rows
    expect(audits).toHaveLength(2)
    expect(audits[1].before.data.measurements.upper[0].values).toMatchObject({ XXS: 0, XS: null, XXL: 71.25 })
  }))
  it('품질·치수 입력 구조·정밀도·중복 위치·행 수와 CAS를 검증한다', async () => isolated(async () => {
    await as(DEMO_IDS.admin); await saveDetails()
    await expect(saveDetails(blankProductionDetails(), 0)).rejects.toThrow(/VERSION_CONFLICT/)
    for (const mutate of [(d: any) => { d.quality.category = '기타' }, (d: any) => { d.quality.quantity = -1 }, (d: any) => { d.measurements.upper[0].values.S = .001 }, (d: any) => { d.measurements.lower[0].grade = 1001 }, (d: any) => { d.measurements.upper.push(structuredClone(d.measurements.upper[0])) }, (d: any) => { d.extra = true }]) {
      const data = blankProductionDetails(); mutate(data); await expect(saveDetails(data, 1)).rejects.toThrow(/INVALID_/)
    }
  }))
  it('배정 공장은 치수만 변경하고 품질 지시·직접 DML·다른 공장 조회는 차단된다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    const data = blankProductionDetails(); data.quality.category = '티셔츠'; await saveDetails(data)
    await as(ownFactory)
    data.measurements.upper[0].values.M = 65.5
    expect((await saveDetails(data, 1)).rows[0].data.measurements.upper[0].values.M).toBe(65.5)
    data.quality.quantity = 3
    await expect(saveDetails(data, 2)).rejects.toThrow(/FORBIDDEN/)
    await expect(query('delete from public.production_details')).rejects.toThrow(/permission denied/)
    const other = fixture.profiles.find(p => p.role === 'factory' && p.factoryId !== first.factoryId)!
    await as(other.id)
    expect((await query('select * from public.production_details')).rows).toHaveLength(0)
    await expect(saveDetails()).rejects.toThrow(/FORBIDDEN/)
  }))
  it('미승인·비활성·없는 컬러·삭제 스타일은 품질 및 치수 저장을 거부한다', async () => isolated(async () => {
    await as(fixture.profiles.find(p => !p.approved)!.id); await expect(saveDetails()).rejects.toThrow(/FORBIDDEN/)
    await db.exec('reset role'); await query('update public.profiles set active=false where id=$1', [DEMO_IDS.internal]); await as(DEMO_IDS.internal); await expect(saveDetails()).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.admin); await expect(saveDetails(blankProductionDetails(), 0, crypto.randomUUID())).rejects.toThrow(/INVALID_DETAILS/)
    await saveDetails(); await query('select public.soft_delete_style($1,1,$2)', [first.id, '삭제 스타일 점검'])
    expect((await query('select * from public.production_details')).rows).toHaveLength(0)
    await expect(saveDetails()).rejects.toThrow(/FORBIDDEN/)
  }))
  it('프로젝트 A 코드와 M 명칭을 분리 저장하며 신규 스타일의 실제 출입고는 0으로 시작한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    const p = project(), style = newStyle(p.id); style.name = style.code
    const row = (await register(style, p)).rows[0]
    expect(row.data.code).toBe(style.code)
    expect(row.data.production[0]).toMatchObject({ color: 'BK', shipped: { XXS: 0, XS: 0, S: 0, M: 0, L: 0, XL: 0 }, received: { XXS: 0, XS: 0, S: 0, M: 0, L: 0, XL: 0 } })
    expect((await query('select code,name from public.projects where id=$1', [p.id])).rows[0]).toEqual({ code: p.code, name: p.name })
  }))
  it('기존 프로젝트의 빈 코드를 채우고 기존 수량을 유지하며 새 컬러만 등록한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    const original = (await query('select data from public.styles where id=$1', [first.id])).rows[0].data
    const oldProject = fixture.projects.find(p => p.id === first.projectId)!
    const p = { ...oldProject, code: 'QA-EXISTING', expected: { code: '', name: oldProject.name, season: oldProject.season } }
    const data = { ...original, colors: [...original.colors, 'ZZ'], production: [...original.production, blankProduction('ZZ')] }
    const row = (await register(data, p)).rows[0]
    expect(row.version).toBe(2)
    expect(row.data.production.slice(0, original.production.length)).toEqual(original.production)
    expect(row.data.production.at(-1).color).toBe('ZZ')
  }))
  it('등록 실패는 앞선 프로젝트 생성까지 롤백하고 프로젝트·스타일 CAS를 확인한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    const p = project(), style = newStyle(p.id); style.name = style.code; style.production[0].received.S = 1
    await expect(register(style, p)).rejects.toThrow(/INVALID_REGISTRATION/)
    expect((await query('select * from public.projects where id=$1', [p.id])).rows).toHaveLength(0)
    style.production[0].received.S = 0; await register(style, p)
    await expect(register(style, p)).rejects.toThrow(/VERSION_CONFLICT/)
    const snapshot = { code: p.code, name: p.name, season: p.season }
    style.version = 1
    await expect(register(style, { ...p, expected: { ...snapshot, name: '낡은 이름' } })).rejects.toThrow(/VERSION_CONFLICT/)
  }))
  it('공장 등록·기존 프로젝트 이름 변경·코드 중복·기존 메타데이터 편집을 차단한다', async () => isolated(async () => {
    const p = project(), style = newStyle(p.id); style.name = style.code
    await as(ownFactory); await expect(register(style, p)).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.admin); await register(style, p)
    const stored = (await query('select data from public.styles where id=$1', [style.id])).rows[0].data
    await expect(register({ ...stored, name: '기존 이름 덮어쓰기' }, { ...p, expected: { code: p.code, name: p.name, season: p.season } })).rejects.toThrow(/INVALID_REGISTRATION/)
    await expect(register(stored, { ...p, name: '다른 프로젝트 명', expected: { code: p.code, name: p.name, season: p.season } })).rejects.toThrow(/PROJECT_CONFLICT/)
  }))
})
