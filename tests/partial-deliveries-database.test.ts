import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { emptyQuantities, SIZES } from '../src/lib/types'

// Local PostgreSQL only: no operating data, account, SQL or mail is used.
const db = new PGlite(), fixture = createSeed(), style = structuredClone(fixture.styles[1])
const otherStyle = { ...structuredClone(style), id: crypto.randomUUID(), code: 'QAPARTIALOTHER', factoryId: DEMO_IDS.vietnam, version: 0 }
const runId = crypto.randomUUID(), otherRun = crypto.randomUUID(), otherFactory = crypto.randomUUID()
const pending = fixture.profiles.find(profile => !profile.approved)!.id
const migrationURL = new URL('../supabase/migrations/018_partial_delivery_sizes.sql', import.meta.url)
const order = { XXS: 10, XS: 20, S: 30, M: 40, L: 50, XL: 60 }
const sizes = () => [
  { id: crypto.randomUUID(), dueDate: '2026-11-10', quantity: 75, note: '1차 예정', quantities: { XXS: 5, XS: 5, S: 10, M: 15, L: 20, XL: 20 } },
  { id: crypto.randomUUID(), dueDate: '2026-11-20', quantity: 135, note: '2차 예정', quantities: { XXS: 5, XS: 15, S: 20, M: 25, L: 30, XL: 40 } },
]
const legacy = [{ id: crypto.randomUUID(), dueDate: '2026-11-15', quantity: 210, note: '기존 총수량만 저장된 계획' }]
let transaction = false, sequence = 0, originalLegacy: unknown

async function query<T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
  if (!transaction) return db.query<T>(sql, values)
  const point = `partial_sizes_${sequence++}`; await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(sql, values); await db.exec(`release savepoint ${point}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function owner(sql: string, values: unknown[] = []) { await db.exec('reset role'); try { return await query(sql, values) } finally { await as(DEMO_IDS.admin) } }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await as(DEMO_IDS.admin); await fn() } finally { transaction = false; await db.exec('rollback') } }
async function save(items: unknown = sizes(), version = 1, id = runId, reason = '사이즈별 부분 납기 계획 저장') { return query('select public.save_partial_delivery_plan($1,$2,$3::jsonb,$4)', [id, version, JSON.stringify(items), reason]) }
async function plans() { return (await query<{ value: Record<string, any> }>('select public.get_partial_delivery_plans() value')).rows.map(row => row.value) }
async function rawPlans() { return owner('select to_jsonb(p) value from public.production_partial_delivery_plans p order by run_id') }
async function version(table: string, id = runId) { return (await owner(`select version from public.${table} where ${table === 'production_runs' ? 'id' : 'run_id'}=$1`, [id])).rows[0].version }
async function businessSnapshot() {
  const result: Record<string, unknown> = {}
  for (const table of ['styles', 'projects', 'production_runs', 'production_receipts', 'production_conditions', 'production_condition_proposals', 'production_condition_approvals', 'po_dispatches', 'po_dispatch_attempts', 'production_order_starts', 'settlement_terms', 'audits']) result[table] = (await owner(`select to_jsonb(t) value from public.${table} t order by to_jsonb(t)::text`)).rows
  return result
}
async function makeRun(id: string, target = style) {
  await query('select public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [id, target.id, target.production[0].id, JSON.stringify({ name: '사이즈별 분할 납기 대상', projectId: target.projectId, projectCode: 'QA-PARTIAL-BUDGET', expectedDue: '2026-11-20', poId: null, unitCost: null, itemType: 'product', order, correctsRunId: null }), '분할 납기 검증 대상 등록'])
}

beforeAll(async () => {
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create schema storage;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,last_accessed_at timestamptz,unique(bucket_id,name));alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;grant select,insert,update,delete on storage.objects to authenticated;`)
  for (const name of readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(name => /^0(?:0[1-9]|1[0-7])_.*\.sql$/.test(name)).sort()) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const row of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [row.id, row.name, row.country])
  for (const row of fixture.projects) await query('insert into public.projects(id,name,season) values($1,$2,$3)', [row.id, row.name, row.season])
  for (const row of fixture.profiles) { await query('insert into auth.users(id,email) values($1,$2)', [row.id, row.email]); await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [row.id, row.name, row.role, row.approved, row.active, row.factoryId]) }
  await query('insert into auth.users(id,email) values($1,$2)', [otherFactory, 'other-partial-factory@example.test'])
  await query("update public.profiles set name='다른 배정 업체',role='factory',approved=true,active=true,factory_id=$2 where id=$1", [otherFactory, DEMO_IDS.vietnam])
  await as(DEMO_IDS.admin); style.version = 0
  for (const target of [style, otherStyle]) await query('select public.save_style($1,$2::jsonb,0,$3)', [target.id, JSON.stringify(target), '부분 납기 시험 스타일 등록'])
  await makeRun(runId); await makeRun(otherRun, otherStyle)
  await save(legacy, 0); await save(legacy, 0, otherRun)
  originalLegacy = (await rawPlans()).rows
  await db.exec('reset role'); await db.exec(readFileSync(migrationURL, 'utf8')); await as(DEMO_IDS.admin)
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('018 실제 PostgreSQL 사이즈별 부분 납기', () => {
  it('018 적용 전 총수량만 있던 계획을 사이즈로 분배하거나 새 이력으로 만들지 않는다', async () => {
    expect((await rawPlans()).rows).toEqual(originalLegacy)
    const stored = (await plans()).find(plan => plan.runId === runId)!
    expect(stored.items).toEqual(legacy); expect(stored.items[0]).not.toHaveProperty('quantities')
  })
  it('본사는 각 사이즈 총합이 오더와 같은 1·2차 계획을 저장하며 기존 업무는 바꾸지 않는다', async () => isolated(async () => {
    const before = await businessSnapshot(), items = sizes()
    await as(DEMO_IDS.internal); await save(items)
    expect((await plans()).find(plan => plan.runId === runId)).toMatchObject({ version: 2, items, updatedBy: DEMO_IDS.internal })
    expect(await businessSnapshot()).toEqual(before)
    const events = (await owner('select before,after from public.production_partial_delivery_plan_events where run_id=$1 order by created_at', [runId])).rows
    expect(events).toHaveLength(2); expect(events[1].before).toMatchObject({ items: legacy, version: 1 }); expect(events[1].after).toMatchObject({ items, version: 2 })
  }))
  it('전체 합계가 같아도 XXS를 줄이고 XL을 늘린 계획은 거부한다', async () => isolated(async () => {
    const items = sizes(); items[0].quantities.XXS -= 1; items[0].quantities.XL += 1
    await expect(save(items)).rejects.toThrow(/SIZE|사이즈/)
    expect((await plans()).find(plan => plan.runId === runId)!.items).toEqual(legacy)
  }))
  it('차수 합계와 사이즈 합계가 다르면 원본 계획과 이벤트를 변경하지 않는다', async () => isolated(async () => {
    const before = (await rawPlans()).rows, items = sizes(); items[0].quantity += 1; items[1].quantity -= 1
    await expect(save(items)).rejects.toThrow(/SIZE|QUANTITY|TOTAL|사이즈/)
    expect((await rawPlans()).rows).toEqual(before)
  }))
  const invalidSizes: [string, (value: Record<string, unknown>) => void][] = [
    ['누락된 사이즈', value => { delete value.XXS }], ['추가 사이즈', value => { value.XXL = 0 }],
    ['음수', value => { value.S = -1 }], ['소수', value => { value.S = 0.5 }],
    ['문자열', value => { value.S = '10' }], ['초과 수량', value => { value.S = 10_000_001 }],
  ]
  it.each(invalidSizes)('%s 입력은 거부한다', async (_label, change) => isolated(async () => {
    const items = sizes(); change(items[0].quantities)
    await expect(save(items)).rejects.toThrow()
    expect((await plans()).find(plan => plan.runId === runId)!.version).toBe(1)
  }))
  it('기존 총수량 차수와 사이즈별 차수를 섞어서 저장하지 못한다', async () => isolated(async () => {
    const items: Record<string, unknown>[] = sizes(); delete items[0].quantities
    await expect(save(items)).rejects.toThrow(/SIZE|사이즈|INVALID_OPERATION|INVALID_QUANTITIES/)
  }))
  it('기존 총수량 계획 저장은 호환성을 유지하되 오래된 버전은 거부한다', async () => isolated(async () => {
    const before = (await rawPlans()).rows
    await expect(save(sizes(), 0)).rejects.toThrow(/VERSION_CONFLICT/)
    expect((await rawPlans()).rows).toEqual(before)
    await save([{ ...legacy[0], note: '기존 총수량 형식 유지' }])
    expect((await plans()).find(plan => plan.runId === runId)!.items[0]).not.toHaveProperty('quantities')
  }))
  it('배정 업체는 해당 스타일 계획만 보고 수정·직접 테이블 쓰기는 할 수 없다', async () => isolated(async () => {
    await save(sizes()); await as(DEMO_IDS.factory)
    expect(await query('select public.get_partial_delivery_sizes_capability() value')).toMatchObject({ rows: [{ value: true }] })
    expect((await plans()).map(plan => plan.runId)).toEqual([runId])
    await expect(save(sizes(), 2)).rejects.toThrow(/FORBIDDEN|permission denied/)
    await expect(query("update public.production_partial_delivery_plans set version=999 where run_id=$1", [runId])).rejects.toThrow(/permission denied/)
    await as(otherFactory); expect((await plans()).map(plan => plan.runId)).toEqual([otherRun])
  }))
  it('공장 재배정 후 이전 업체는 과거 계획을 볼 수 없다', async () => isolated(async () => {
    await owner("update public.styles set data=jsonb_set(data,'{factoryId}',to_jsonb($2::text)) where id=$1", [style.id, DEMO_IDS.vietnam])
    await as(DEMO_IDS.factory); expect(await plans()).toEqual([])
  }))
  it('미승인·비활성 계정의 capability와 변경을 차단한다', async () => isolated(async () => {
    await as(pending)
    expect((await query('select public.get_partial_delivery_sizes_capability() value')).rows[0].value).toBe(false)
    await expect(save()).rejects.toThrow(/FORBIDDEN/)
    await owner('update public.profiles set active=false where id=$1', [DEMO_IDS.internal]); await as(DEMO_IDS.internal)
    expect((await query('select public.get_partial_delivery_sizes_capability() value')).rows[0].value).toBe(false)
    await expect(save()).rejects.toThrow(/FORBIDDEN/)
  }))
  it('업체 회신·최종 승인·입고·마감 이후에는 기존 계획을 변경하지 않는다', async () => isolated(async () => {
    await save(sizes())
    const plan = (await plans()).find(row => row.runId === runId), poId = crypto.randomUUID()
    await query("select public.configure_production_conditions($1,$2,0,'cmt','900'::jsonb,'부분 납기 생산 방식 설정')", [runId, await version('production_runs')])
    await query('select public.create_production_order_po($1,$2,$3,$4::jsonb,$5)', [runId, await version('production_runs'), poId, JSON.stringify({ dueDate: '2026-11-20', recipient: 'factory@example.test', subject: '부분 납기 회신 확인', body: '사이즈별 납기 계획 확인', evidenceAttachmentId: null, voided: false }), '생산 발주 생성'])
    await query('select public.begin_po_dispatch($1,1)', [poId]); await as(null, 'service_role')
    await query("select public.finalize_po_dispatch($1,'qa-local-partial-test',null,'sent')", [poId])
    const rv = await version('production_runs'), cv = await version('production_conditions')
    const pv = (await owner('select version from public.po_dispatches where id=$1', [poId])).rows[0].version
    await as(DEMO_IDS.factory)
    await query('select public.submit_production_conditions($1,$2,$3,$4,$5::jsonb)', [runId, rv, pv, cv, JSON.stringify({ expectedDeliveryDate: '2026-11-20', unitCost: 100.5, canProduce: true, quantityConfirmed: true, agreed: true, confirmedQuantities: order, comment: '사이즈별 부분 납기 계획 확인', delayReason: '', priceReason: '' })])
    await as(DEMO_IDS.admin); await expect(save(sizes(), 2)).rejects.toThrow(/HISTORY_PROTECTED/)
    await query("select public.review_production_conditions($1,$2,$3,'approve','2026-11-20','100.5'::jsonb,'부분 납기 최종 승인')", [runId, await version('production_runs'), await version('production_conditions')])
    await expect(save(sizes(), 2)).rejects.toThrow(/HISTORY_PROTECTED/)
    await query('select public.allocate_production_receipt($1,$2,$3::jsonb,$4,$5)', [crypto.randomUUID(), runId, JSON.stringify({ receivedAt: '2026-11-10', quantities: { ...emptyQuantities(), S: 5 } }), await version('production_runs'), '부분 실입고 기록'])
    await expect(save(sizes(), 2)).rejects.toThrow(/HISTORY_PROTECTED/)
    await query("select public.finalize_production_run($1,$2,'부분 납기 검증 마감')", [runId, await version('production_runs')])
    const closedBusiness = await businessSnapshot()
    await expect(save(sizes(), 2)).rejects.toThrow(/HISTORY_PROTECTED/)
    expect(await businessSnapshot()).toEqual(closedBusiness)
    expect((await plans()).find(row => row.runId === runId)).toEqual(plan)
  }))
  it('018 재실행은 사이즈 계획·기존 계획·이력을 그대로 보존한다', async () => {
    await as(DEMO_IDS.admin); await save(sizes())
    const before = (await rawPlans()).rows
    const history = await owner('select to_jsonb(t) value from public.production_partial_delivery_plan_events t order by id')
    await db.exec('reset role'); await db.exec(readFileSync(migrationURL, 'utf8')); await as(DEMO_IDS.admin)
    expect((await rawPlans()).rows).toEqual(before)
    expect((await owner('select to_jsonb(t) value from public.production_partial_delivery_plan_events t order by id')).rows).toEqual(history.rows)
    const totals = (await plans()).find(row => row.runId === runId)!.items.reduce((sum: Record<string, number>, item: { quantities: Record<string, number> }) => { for (const size of SIZES) sum[size] += item.quantities[size]; return sum }, emptyQuantities())
    expect(totals).toEqual(order)
  })
})
