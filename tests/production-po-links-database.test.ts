import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { emptyQuantities } from '../src/lib/types'

const db = new PGlite(), fixture = createSeed(), style = structuredClone(fixture.styles[1]), line = style.production[0]
const runId = crypto.randomUUID(), legacyPoId = crypto.randomUUID(), otherFactory = crypto.randomUUID()
const migration = readFileSync(new URL('../supabase/migrations/015_production_po_link.sql', import.meta.url), 'utf8')
let transaction = false, sequence = 0
async function query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  if (!transaction) return db.query<T>(sql, params)
  const savepoint = `po_link_${sequence++}`; await db.exec(`savepoint ${savepoint}`)
  try { const result = await db.query<T>(sql, params); await db.exec(`release savepoint ${savepoint}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${savepoint};release savepoint ${savepoint}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await as(DEMO_IDS.admin); await fn() } finally { transaction = false; await db.exec('rollback') } }
const input = (poId: string | null = null, order = { ...emptyQuantities(), S: 10 }) => ({ name: 'QA 연결 차수', projectId: style.projectId, projectCode: 'QA-LINK-PROJECT', expectedDue: '2026-12-01', poId, unitCost: null, itemType: 'product', order, correctsRunId: null })
const poInput = { dueDate: '2026-12-01', recipient: 'factory@example.test', subject: 'QA 문서 확인용 발주', body: '원본 발송 내용 보존', evidenceAttachmentId: null, voided: false }
const confirmation = (override: Record<string, unknown> = {}) => ({ documentConfirmed: true, scopeDifferenceConfirmed: true, sourceSnapshotMissingConfirmed: true, projectId: style.projectId, styleCode: `${style.code}${line.color}`, color: line.color, factoryId: style.factoryId, order: { ...emptyQuantities(), S: 10 }, ...override })
async function link(poId = legacyPoId, runVersion = 1, poVersion = 3, override = {}, targetRun = runId) { return query('select public.link_production_po($1,$2,$3,$4,$5::jsonb,$6)', [targetRun, poId, runVersion, poVersion, JSON.stringify(confirmation(override)), '실제 발송 문서와 차수 확인']) }
async function send(poId: string) { await as(DEMO_IDS.admin); await query('select public.begin_po_dispatch($1,1)', [poId]); await as(null, 'service_role'); await query("select public.finalize_po_dispatch($1,'qa-provider-message',null,'sent')", [poId]); await as(DEMO_IDS.admin) }
async function newPo() { const id = crypto.randomUUID(); await query('select public.save_po_dispatch($1,$2,0,$3::jsonb,$4)', [id, style.id, JSON.stringify(poInput), '새 PO 원본 기록']); return id }

beforeAll(async () => {
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create schema storage;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;grant select,insert,update,delete on storage.objects to authenticated;`)
  for (const name of readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(name => /^0(?:0[1-9]|1[0-4])_.*\.sql$/.test(name)).sort()) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const item of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [item.id, item.name, item.country])
  for (const item of fixture.projects) await query('insert into public.projects(id,name,season) values($1,$2,$3)', [item.id, item.name, item.season])
  await query('update public.projects set code=$2 where id=$1', [style.projectId, 'QA-LINK-PROJECT'])
  for (const item of fixture.profiles) { await query('insert into auth.users(id,email) values($1,$2)', [item.id, item.email]); await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [item.id, item.name, item.role, item.approved, item.active, item.factoryId]) }
  await query('insert into auth.users(id,email) values($1,$2)', [otherFactory, 'other@example.test']); await query("update public.profiles set role='factory',approved=true,active=true,factory_id=$2 where id=$1", [otherFactory, DEMO_IDS.vietnam])
  await as(DEMO_IDS.admin); style.version = 0
  await query('select public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), 'PO 연결 시험 품번'])
  await query('select public.save_po_dispatch($1,$2,0,$3::jsonb,$4)', [legacyPoId, style.id, JSON.stringify(poInput), '이전 방식 PO 저장'])
  await send(legacyPoId)
  await query('select public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [runId, style.id, line.id, JSON.stringify(input()), '연결할 기존 차수'])
  await db.exec('reset role'); await db.exec(migration)
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('015 실제 PostgreSQL 생산 차수 PO 확인 연결', () => {
  it('기존 PO는 명시적 문서 확인 후 연결하며 문서와 발송·가격·수량을 변경하지 않는다', async () => isolated(async () => {
    const beforePo = (await query('select * from public.po_dispatches where id=$1', [legacyPoId])).rows[0]
    const beforeStyle = (await query('select * from public.styles where id=$1', [style.id])).rows[0]
    await link()
    expect((await query('select * from public.production_runs where id=$1', [runId])).rows[0]).toMatchObject({ po_id: legacyPoId, version: 2, unit_cost: null })
    expect((await query('select * from public.po_dispatches where id=$1', [legacyPoId])).rows[0]).toEqual(beforePo)
    expect((await query('select * from public.styles where id=$1', [style.id])).rows[0]).toEqual(beforeStyle)
    expect((await query('select * from public.production_po_link_audits')).rows[0]).toMatchObject({ verification: 'legacy_document_confirmed', actor_id: DEMO_IDS.admin })
  }))
  it('문서·기존 정보 미등록·누적과 차수 수량 차이 확인을 각각 요구한다', async () => isolated(async () => {
    await expect(link(legacyPoId, 1, 3, { documentConfirmed: false })).rejects.toThrow(/PO_DOCUMENT_CONFIRMATION_REQUIRED/)
    await expect(link(legacyPoId, 1, 3, { sourceSnapshotMissingConfirmed: false })).rejects.toThrow(/LEGACY_PO_DOCUMENT_CONFIRMATION_REQUIRED/)
    await expect(link(legacyPoId, 1, 3, { scopeDifferenceConfirmed: false })).rejects.toThrow(/ORDER_SCOPE_CONFIRMATION_REQUIRED/)
    expect((await query('select * from public.production_po_link_audits')).rows).toEqual([])
  }))
  it.each([{ projectId: crypto.randomUUID() }, { styleCode: 'WRONG-FULLSKU' }, { color: 'ZZ' }, { factoryId: crypto.randomUUID() }, { order: { ...emptyQuantities(), S: 11 } }])('확인한 원본 항목이 차수와 다르면 체크로 우회하지 못한다: %j', async override => isolated(async () => { await expect(link(legacyPoId, 1, 3, override)).rejects.toThrow(/INVALID_PO_LINK/) }))
  it('본사라도 오래된 차수·PO 버전과 중복 연결은 거부한다', async () => isolated(async () => {
    await expect(link(legacyPoId, 0)).rejects.toThrow(/VERSION_CONFLICT/)
    await expect(link(legacyPoId, 1, 2)).rejects.toThrow(/VERSION_CONFLICT/)
    await link(); await expect(link(legacyPoId, 2)).rejects.toThrow(/DUPLICATE_PO_LINK/)
  }))
  it('공장·미승인·익명·서비스 키는 연결 RPC와 원본 비교 정보를 우회하지 못한다', async () => isolated(async () => {
    for (const id of [DEMO_IDS.factory, otherFactory, fixture.profiles.find(item => !item.approved)!.id]) {
      await as(id); await expect(link()).rejects.toThrow(/FORBIDDEN/)
      expect((await query('select * from public.po_production_contexts')).rows).toEqual([])
      expect((await query('select * from public.production_po_link_audits')).rows).toEqual([])
    }
    for (const role of ['anon', 'service_role']) { await as(null, role); await expect(link()).rejects.toThrow(/permission denied/) }
  }))
  it('일반 차수 저장을 통해 명시적 PO 확인 절차를 우회하지 못한다', async () => isolated(async () => {
    await expect(query('select public.save_production_run($1,$2,$3,$4::jsonb,1,$5)', [runId, style.id, line.id, JSON.stringify(input(legacyPoId)), '직접 PO 바꾸기'])).rejects.toThrow(/PO_LINK_CONFIRMATION_REQUIRED/)
  }))
  it('신규 일반 PO는 작성 당시 프로젝트·전체 컬러와 누적 수량을 보존한다', async () => isolated(async () => {
    const id = await newPo(), context = (await query('select * from public.po_production_contexts where po_id=$1', [id])).rows[0]
    expect(context).toMatchObject({ source: 'style', snapshot: { projectId: style.projectId, factoryId: style.factoryId } })
    expect(context.snapshot.lines[0]).toMatchObject({ lineId: line.id, color: line.color, styleCode: `${style.code}${line.color}`, order: line.order })
    await send(id)
    await expect(query('update public.po_production_contexts set snapshot=$2::jsonb where po_id=$1', [id, '{}'])).rejects.toThrow(/permission denied/)
    await db.exec('reset role'); await expect(query('update public.po_production_contexts set snapshot=$2::jsonb where po_id=$1', [id, '{}'])).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('일반 PO 원본의 프로젝트가 차수와 다르면 명시적 체크로도 연결하지 않는다', async () => isolated(async () => {
    const id = await newPo(); await db.exec('reset role')
    await query("update public.po_production_contexts set snapshot=jsonb_set(snapshot,'{projectId}',to_jsonb($2::text)) where po_id=$1", [id, crypto.randomUUID()])
    await send(id); await expect(link(id)).rejects.toThrow(/INVALID_PO_LINK/)
  }))
  it('차수에서 PO를 만들면 같은 차수의 정확한 수량·생산 방식으로 자동 연결하고 별도 메일은 보내지 않는다', async () => isolated(async () => {
    await query("select public.configure_production_conditions($1,1,0,'cmt',null,'생산 방식 설정')", [runId])
    const id = crypto.randomUUID()
    await query('select public.create_production_order_po($1,2,$2,$3::jsonb,$4)', [runId, id, JSON.stringify(poInput), '해당 차수 PO 작성'])
    const context = (await query('select * from public.po_production_contexts where po_id=$1', [id])).rows[0]
    expect(context).toMatchObject({ source: 'run', snapshot: { runId, lineId: line.id, styleCode: `${style.code}${line.color}`, productionMode: 'cmt', order: { ...emptyQuantities(), S: 10 } } })
    expect(JSON.stringify(context.snapshot)).not.toMatch(/internalUnitCost|unitCost/)
    expect((await query('select status,attempts from public.po_dispatches where id=$1', [id])).rows[0]).toEqual({ status: 'draft', attempts: 0 })
  }))
  it('마이그레이션 재실행은 기존 연결과 원본 및 이력을 그대로 보존한다', async () => {
    // The production migration owns BEGIN/COMMIT. Run it outside the per-case
    // rollback transaction so its transaction semantics are exercised as shipped.
    await as(DEMO_IDS.admin); await link(); const audits = (await query('select * from public.production_po_link_audits')).rows
    await db.exec('reset role'); await db.exec(migration); await as(DEMO_IDS.admin)
    expect((await query('select * from public.production_po_link_audits')).rows).toEqual(audits)
    expect((await query('select po_id from public.production_runs where id=$1', [runId])).rows[0].po_id).toBe(legacyPoId)
  })
  it('014를 015 이후 다시 적용해도 자동 PO 연결의 원본 캡처와 생산 방식 검증을 유지한다', async () => {
    await db.exec('reset role'); await db.exec(readFileSync(new URL('../supabase/migrations/014_production_conditions.sql', import.meta.url), 'utf8'))
    await as(DEMO_IDS.admin)
    const newRunId = crypto.randomUUID(), newPoId = crypto.randomUUID()
    await query('select public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [newRunId, style.id, line.id, JSON.stringify(input()), '재적용 후 차수'])
    await expect(query('select public.create_production_order_po($1,1,$2,$3::jsonb,$4)', [newRunId, newPoId, JSON.stringify(poInput), '생산 방식 미설정 차단'])).rejects.toThrow(/PRODUCTION_MODE_REQUIRED/)
    await query("select public.configure_production_conditions($1,1,0,'full_package',null,'생산 방식 설정')", [newRunId])
    await query('select public.create_production_order_po($1,2,$2,$3::jsonb,$4)', [newRunId, newPoId, JSON.stringify(poInput), '재적용 후 PO 작성'])
    expect((await query('select source,snapshot from public.po_production_contexts where po_id=$1', [newPoId])).rows[0]).toMatchObject({ source: 'run', snapshot: { runId: newRunId, productionMode: 'full_package' } })
  })
})
