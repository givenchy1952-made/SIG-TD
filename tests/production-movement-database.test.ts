import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { emptyQuantities, type Style } from '../src/lib/types'

const db = new PGlite(), seed = createSeed({ includeFinance: true }), style = structuredClone(seed.styles.find(item => item.production.length)!)
const lineId = style.production[0].id, financeId = seed.profiles.find(person => person.role === 'finance')!.id
const otherFactoryActor = crypto.randomUUID(), reason = '메인 생산 수량 확인'
const migration = readFileSync(new URL('../supabase/migrations/026_main_production_sync.sql', import.meta.url), 'utf8')
let transaction = false, sequence = 0
async function query<T = Record<string, any>>(sql: string, params: unknown[] = []) {
  if (!transaction) return db.query<T>(sql, params)
  const point = `movement_${sequence++}`; await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(sql, params); await db.exec(`release savepoint ${point}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function owner(sql: string, params: unknown[] = []) { await db.exec('reset role'); try { return await query(sql, params) } finally { await as(DEMO_IDS.admin) } }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await as(DEMO_IDS.admin); await fn() } finally { transaction = false; await db.exec('rollback') } }
async function current(): Promise<Style> { return (await query('select data from public.styles where id=$1', [style.id])).rows[0].data }
async function save(value: Style, expected = value.version) { return (await query('select to_jsonb(public.save_main_production_style($1,$2::jsonb,$3,$4)) value', [value.id, JSON.stringify(value), expected, reason])).rows[0].value }
async function run(id: string) { return (await query('select * from public.production_runs where id=$1', [id])).rows[0] }
async function conditions(id: string) { return (await query('select public.get_production_conditions() item')).rows.map(row => row.item).find(item => item.runId === id) }
async function newRun() {
  const id = crypto.randomUUID(), input = { name: '입고 자동 연결', projectId: style.projectId, projectCode: 'SIGNIFICANT-2026FY-RPQ-99026', expectedDue: '2026-11-10', poId: null, unitCost: null, itemType: 'product', order: { ...emptyQuantities(), M: 20, S: 10 }, correctsRunId: null }
  await query('select public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [id, style.id, lineId, JSON.stringify(input), reason]); return id
}
async function approved() {
  const id = await newRun(), poId = crypto.randomUUID()
  await query('select public.configure_production_conditions($1,$2,0,$3,$4::jsonb,$5)', [id, (await run(id)).version, 'full_package', JSON.stringify(100), reason])
  const po = { dueDate: '2026-11-10', recipient: 'factory@example.test', subject: '입고 확정 검증 PO', body: '프로젝트 생산 조건 확인', evidenceAttachmentId: null, voided: false }
  await query('select public.create_production_order_po($1,$2,$3,$4::jsonb,$5)', [id, (await run(id)).version, poId, JSON.stringify(po), reason])
  const version = (await query('select version from public.po_dispatches where id=$1', [poId])).rows[0].version
  await query('select public.begin_po_dispatch($1,$2)', [poId, version]); await as(null, 'service_role')
  await query('select public.finalize_po_dispatch($1,$2,null,$3)', [poId, 'movement-provider', 'sent']); await as(DEMO_IDS.admin)
  const r = await run(id), c = await conditions(id), sentPo = (await query('select * from public.po_dispatches where id=$1', [poId])).rows[0]
  await as(DEMO_IDS.factory)
  const proposal = { expectedDeliveryDate: '2026-11-10', unitCost: 100, canProduce: true, quantityConfirmed: true, agreed: true, confirmedQuantities: r.order_quantities, comment: '', delayReason: '', priceReason: '' }
  await query('select public.submit_production_conditions($1,$2,$3,$4,$5::jsonb)', [id, r.version, sentPo.version, c.version, JSON.stringify(proposal)]); await as(DEMO_IDS.admin)
  const after = await run(id), terms = await conditions(id)
  await query('select public.review_production_conditions($1,$2,$3,$4,$5,$6::jsonb,$7)', [id, after.version, terms.version, 'approve', '2026-11-10', JSON.stringify(100), reason])
  return id
}
async function request(id: string, count = 5, requestId = crypto.randomUUID()) {
  const data = await current(), r = await run(id); data.production[0].received = { ...emptyQuantities(), M: count }; data.production[0].receivedAt = '2026-11-10'
  return { requestId, styleId: style.id, lineId, runId: id, expectedStyleVersion: data.version, expectedRunVersion: r.version, style: data }
}
async function confirm(value: Awaited<ReturnType<typeof request>>, why = reason) { return (await query('select public.confirm_main_production_receipt($1::jsonb,$2) value', [JSON.stringify(value), why])).rows[0].value }
async function count(table: string) { return (await query(`select count(*)::int value from public.${table}`)).rows[0].value }

beforeAll(async () => {
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   create schema auth;create schema storage;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,last_accessed_at timestamptz,unique(bucket_id,name));alter table storage.objects enable row level security;
   grant usage on schema public,auth,storage to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;grant select,insert,update,delete on storage.objects to authenticated;`)
  // Run all movement transactions with the later owner-default save wrapper in
  // place too: both migrations call the same original style authorization path.
  for (const name of readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 27).sort()) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const factory of seed.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [factory.id, factory.name, factory.country])
  for (const project of seed.projects) await query('insert into public.projects(id,name,season,code) values($1,$2,$3,$4)', [project.id, project.name, project.season, project.id === style.projectId ? 'SIGNIFICANT-2026FY-RPQ-99026' : project.code || ''])
  for (const person of seed.profiles) {
    await query('insert into auth.users(id,email) values($1,$2)', [person.id, person.email])
    await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [person.id, person.name, person.role, person.approved, person.active, person.id === DEMO_IDS.factory ? style.factoryId : person.factoryId])
  }
  await query('insert into auth.users(id,email) values($1,$2)', [otherFactoryActor, 'movement-other@example.test'])
  await query("update public.profiles set role='factory',approved=true,active=true,factory_id=$2 where id=$1", [otherFactoryActor, seed.factories.find(factory => factory.id !== style.factoryId)!.id])
  style.version = 0; style.production = [style.production[0]]; style.colors = [style.production[0].color]; style.stage = 'production'; style.ownerId = DEMO_IDS.admin; style.production[0].ownerId = DEMO_IDS.admin
  style.production[0].order = { ...emptyQuantities(), M: 20, S: 10 }; style.production[0].received = emptyQuantities(); style.production[0].shipped = emptyQuantities(); style.production[0].receivedAt = ''; style.production[0].shippedAt = ''
  await as(DEMO_IDS.admin); await query('select public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), reason])
}, 60000)
afterAll(async () => { await db.close() })

describe.sequential('026 메인 생산 출고 1회 입력과 입고 확정 원자 연결', () => {
  it('설치와 재실행은 기존 생산·출고·입고를 추정 생성하거나 변경하지 않는다', async () => isolated(async () => {
    const before = await current(); expect(await count('shipment_total_adjustments')).toBe(0); expect(await count('production_receipts')).toBe(0)
    await db.exec('reset role'); await db.exec(migration.replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '')); await as(DEMO_IDS.admin)
    expect(await current()).toEqual(before); expect(await count('shipment_total_adjustments')).toBe(0)
  }))
  it('메인 출고 누적값을 한 번 입력하고 기존 baseline과 batch를 그대로 보존한다', async () => isolated(async () => {
    const data = await current(); data.production[0].shipped.M = 10; data.production[0].shippedAt = '2026-11-09'
    await query('select public.save_style($1,$2::jsonb,$3,$4)', [style.id, JSON.stringify(data), data.version, reason])
    const value = await current(), batchId = crypto.randomUUID()
    await query('select public.save_shipment_batch($1,$2,$3,0,$4,$5::jsonb,$6)', [batchId, style.id, lineId, value.version, JSON.stringify({ shippedAt: '2026-11-09', quantities: { ...emptyQuantities(), M: 10 }, tracking: '', note: '', voided: false }), reason])
    const beforeLedger = (await query('select * from public.shipment_ledgers')).rows, beforeBatches = (await query('select * from public.shipment_batches')).rows
    const target = await current(); expect(target.production[0].shipped.M).toBe(20); target.production[0].shipped.M = 10
    await save(target)
    expect((await current()).production[0].shipped.M).toBe(10)
    expect((await query('select * from public.shipment_ledgers')).rows).toEqual(beforeLedger); expect((await query('select * from public.shipment_batches')).rows).toEqual(beforeBatches)
    expect((await query('select delta from public.shipment_total_adjustments')).rows[0].delta.M).toBe(-10)
    await save(await current()); expect(await count('shipment_total_adjustments')).toBe(1)
  }))
  it('공장은 배정된 스타일만 출고를 입력하며 본사 직원·FA·미승인자는 수량 권한을 확대하지 않는다', async () => isolated(async () => {
    const data = await current(); data.production[0].shipped.M = 3; data.production[0].shippedAt = '2026-11-09'
    await as(DEMO_IDS.internal); await expect(save(data)).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.factory); await save(data)
    expect((await query('select public.get_main_production_sync() value')).rows[0].value.shipmentAdjustments).toHaveLength(1)
    await as(otherFactoryActor); expect((await query('select public.get_main_production_sync() value')).rows[0].value.shipmentAdjustments).toEqual([]); await expect(save(data)).rejects.toThrow(/FORBIDDEN/)
    for (const id of [financeId, seed.profiles.find(person => !person.approved)!.id]) {
      await as(id); expect((await query('select public.get_main_production_sync_capability() value')).rows[0].value).toBe(false)
      await expect(query('select public.get_main_production_sync()')).rejects.toThrow(/FORBIDDEN/)
    }
  }))
  it('출고일 정정과 후속 부분 출고를 같은 누적 원장에 합산한다', async () => isolated(async () => {
    let data = await current(); data.production[0].shipped.M = 10; data.production[0].shippedAt = '2026-11-15'; await save(data)
    data = await current(); data.production[0].shippedAt = '2026-11-09'; await save(data)
    let total = (await query('select public.shipment_ledger_total($1,$2) value', [style.id, lineId]).catch(() => ({ rows: [] }))).rows[0]
    expect(total).toBeUndefined() // private aggregate helper is not an API permission.
    data = await current(); await query('select public.save_shipment_batch($1,$2,$3,0,$4,$5::jsonb,$6)', [crypto.randomUUID(), style.id, lineId, data.version, JSON.stringify({ shippedAt: '2026-11-10', quantities: { ...emptyQuantities(), M: 2 }, tracking: '', note: '', voided: false }), reason])
    expect((await current()).production[0]).toMatchObject({ shippedAt: '2026-11-10', shipped: { M: 12 } })
    data = await current(); data.production[0].shipped = emptyQuantities(); data.production[0].shippedAt = ''; await save(data)
    expect((await current()).production[0]).toMatchObject({ shippedAt: '', shipped: emptyQuantities() })
  }))
  it('입고 확정은 출고·메인 입고·차수 receipt를 같은 트랜잭션에 한 번 저장한다', async () => isolated(async () => {
    const id = await approved(), value = await request(id), before = await run(id)
    value.style.production[0].shipped.M = 5; value.style.production[0].shippedAt = '2026-11-10'
    const result = await confirm(value)
    expect(result.added).toEqual({ ...emptyQuantities(), M: 5 }); expect(result.receiptId).toBe(value.requestId); expect(result.runVersion).toBe(before.version + 1)
    expect(result.style.data.production[0]).toMatchObject({ shipped: { M: 5 }, received: { M: 5 }, receivedAt: '2026-11-10' })
    expect((await query('select * from public.production_receipts')).rows[0]).toMatchObject({ quantities: { M: 5, ...Object.fromEntries(['XXS', 'XS', 'S', 'L', 'XL'].map(size => [size, 0])) }, unit_cost: '100', net_amount: '500' })
    expect(await count('shipment_total_adjustments')).toBe(1)
  }))
  it('기존 메인 입고가 이미 입력돼도 receipt 원장과의 차이만 따라잡고 재확정은 중복하지 않는다', async () => isolated(async () => {
    const data = await current(); data.production[0].received.M = 5; data.production[0].receivedAt = '2026-11-10'; await save(data)
    const id = await approved(), first = await request(id), result = await confirm(first)
    expect(result.added.M).toBe(5); expect(await count('production_receipts')).toBe(1)
    expect(await confirm(first)).toEqual(result); expect(await count('production_receipts')).toBe(1)
    const next = await request(id), again = await confirm(next)
    expect(again.added).toEqual(emptyQuantities()); expect(again.receiptId).toBeNull(); expect(again.runVersion).toBe(result.runVersion); expect(await count('production_receipts')).toBe(1)
    await expect(confirm({ ...first, style: { ...first.style, name: '다른 요청' } })).rejects.toThrow(/VERSION_CONFLICT/)
    await expect(confirm(first, '다른 확인 사유')).rejects.toThrow(/VERSION_CONFLICT/)
    await owner("update public.profiles set role='admin' where id=$1", [DEMO_IDS.internal]); await as(DEMO_IDS.internal)
    await expect(confirm(first)).rejects.toThrow(/VERSION_CONFLICT/)
  }))
  it('부분 입고와 다음 생산 차수는 컬러 전체에서 이미 기록한 수량을 제외한 차이만 배정한다', async () => isolated(async () => {
    const firstRun = await approved()
    expect((await confirm(await request(firstRun, 5))).added.M).toBe(5)
    expect((await confirm(await request(firstRun, 12))).added.M).toBe(7)
    const secondRun = await approved()
    expect((await confirm(await request(secondRun, 15))).added.M).toBe(3)
    const receipts = (await query('select run_id,quantities,net_amount from public.production_receipts order by created_at,id')).rows
    expect(receipts.map(row => row.run_id)).toEqual([firstRun, firstRun, secondRun])
    expect(receipts.map(row => row.quantities.M)).toEqual([5, 7, 3])
    expect(receipts.map(row => Number(row.net_amount))).toEqual([500, 700, 300])
    expect((await current()).production[0].received.M).toBe(15)
  }))
  it('이미 승인된 미배정 담당자 스냅샷은 공장 배정 후 입고를 확정해도 바꾸지 않는다', async () => isolated(async () => {
    // Unassigned owners have been valid since011. Assigning a factory later
    // changes current styles, never the owner identity of that approved order.
    const data = await current(); data.ownerId = ''; data.production[0].ownerId = ''; await save(data)
    const id = await approved(), before = await run(id)
    expect(before.owner_id_snapshot).toBeNull(); expect(before.owner_name_snapshot).toBe('')
    await query('select public.save_employee_factory_assignment($1,$2,0,$3)', [DEMO_IDS.internal, [style.factoryId], reason])
    expect((await current()).ownerId).toBe(DEMO_IDS.internal)
    await confirm(await request(id))
    const after = await run(id)
    expect(after.owner_id_snapshot).toBeNull(); expect(after.owner_name_snapshot).toBe('')
    expect(after.version).toBe(before.version + 1)
  }))
  it('입고 대상·권한·개별 사이즈 오더·버전·승인 누락을 서버에서 차단한다', async () => isolated(async () => {
    const id = await approved(), first = await request(id)
    await as(DEMO_IDS.internal); await expect(confirm(first)).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.factory); await expect(confirm(first)).rejects.toThrow(/FORBIDDEN/); await as(DEMO_IDS.admin)
    await expect(confirm({ ...first, expectedStyleVersion: first.expectedStyleVersion - 1, style: { ...first.style, version: first.expectedStyleVersion - 1 } })).rejects.toThrow(/VERSION|INVALID/)
    await expect(confirm({ ...first, expectedRunVersion: first.expectedRunVersion - 1 })).rejects.toThrow(/VERSION/)
    await expect(confirm({ ...first, lineId: crypto.randomUUID() })).rejects.toThrow(/does not belong to selected style and color/)
    const over = await request(id, 21); await expect(confirm(over)).rejects.toThrow(/exceeds run order/)
    const raw = await newRun(); await expect(confirm(await request(raw, 0))).rejects.toThrow(/price and project|PRODUCTION_NOT_STARTED|APPROVAL/)
    expect(await count('production_receipts')).toBe(0); expect(await count('shipment_total_adjustments')).toBe(0)
  }))
  it('이미 확정된 수량보다 낮추거나 다른 색상 수량을 섞지 않는다', async () => isolated(async () => {
    const id = await approved(); await confirm(await request(id, 5))
    await expect(confirm(await request(id, 4))).rejects.toThrow(/below confirmed/)
    expect((await current()).production[0].received.M).toBe(5); expect(await count('production_receipts')).toBe(1)
    const direct = await current(); direct.production[0].received.M = 6
    await expect(save(direct)).rejects.toThrow(/RECEIPT_CONFIRMATION_REQUIRED/)
  }))
  it('스타일 저장이 뒤에서 실패하면 새 receipt·차수 버전·출고 정정·요청 응답을 모두 롤백한다', async () => isolated(async () => {
    const id = await approved(), before = await current(), r = await run(id), bad = await request(id)
    bad.style.name = ''; bad.style.production[0].shipped.M = 5; bad.style.production[0].shippedAt = '2026-11-10'
    await expect(confirm(bad)).rejects.toThrow(/INVALID_STYLE/)
    expect(await current()).toEqual(before); expect((await run(id)).version).toBe(r.version)
    expect(await count('production_receipts')).toBe(0); expect(await count('shipment_total_adjustments')).toBe(0)
    expect((await owner('select * from public.main_production_receipt_requests')).rows).toEqual([])
  }))
  it('마감 후 새 입고는 막고 같은 요청의 이미 저장된 응답만 재사용한다', async () => isolated(async () => {
    const id = await approved(), first = await request(id), result = await confirm(first)
    await query('select public.finalize_production_run($1,$2,$3)', [id, result.runVersion, reason])
    const closed = await run(id), data = await current()
    await expect(confirm(await request(id, 6))).rejects.toThrow(/HISTORY_PROTECTED/)
    expect(await confirm(first)).toEqual(result); expect(await run(id)).toEqual(closed); expect(await current()).toEqual(data)
  }))
  it('직접 DML·비공개 core·과거 정정/요청 수정과 삭제를 허용하지 않는다', async () => isolated(async () => {
    const data = await current(); data.production[0].shipped.M = 3; data.production[0].shippedAt = '2026-11-09'; await save(data)
    await expect(query('delete from public.shipment_total_adjustments')).rejects.toThrow(/permission denied/)
    await expect(query('insert into public.shipment_total_adjustments(style_id,line_id,delta,created_by,reason) values($1,$2,$3::jsonb,$4,$5)', [style.id, lineId, JSON.stringify(emptyQuantities()), DEMO_IDS.admin, reason])).rejects.toThrow(/permission denied/)
    await expect(query('select * from public.main_production_receipt_requests')).rejects.toThrow(/permission denied/)
    await expect(query('select public.save_main_production_style_core($1,$2::jsonb,$3,$4,null)', [style.id, JSON.stringify(await current()), (await current()).version, reason])).rejects.toThrow(/permission denied/)
    await expect(owner('delete from public.shipment_total_adjustments')).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
})
