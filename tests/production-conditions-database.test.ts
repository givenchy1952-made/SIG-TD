import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { emptyQuantities } from '../src/lib/types'

// Execute the real incremental schema. No remote account, mail provider or
// production database participates in these tests.
const db = new PGlite(), fixture = createSeed(), style = structuredClone(fixture.styles[1])
const lineId = style.production[0].id, otherFactory = crypto.randomUUID()
const pending = fixture.profiles.find(person => !person.approved)!.id
const legacyRun = crypto.randomUUID(), legacyClosedRun = crypto.randomUUID()
const migrationURL = new URL('../supabase/migrations/014_production_conditions.sql', import.meta.url)
const quantities = { ...emptyQuantities(), S: 10, M: 5 }
let transaction = false, sequence = 0
let legacyBefore: Record<string, unknown>, legacyClosedBefore: Record<string, unknown>

async function query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  if (!transaction) return db.query<T>(sql, params)
  const point = `condition_${sequence++}`
  await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(sql, params); await db.exec(`release savepoint ${point}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw error }
}
async function as(id: string | null, role = 'authenticated') {
  await db.exec(`reset role;set role ${role}`)
  await query("select set_config('request.jwt.claim.sub',$1,false)", [id || ''])
}
async function isolated(fn: () => Promise<void>) {
  await db.exec('begin'); transaction = true
  try { await as(DEMO_IDS.admin); await fn() } finally { transaction = false; await db.exec('rollback') }
}
async function run(id: string) { return (await query('select * from public.production_runs where id=$1', [id])).rows[0] }
async function conditions() { return (await query<{ item: any }>('select public.get_production_conditions() item')).rows.map(row => row.item) }
async function condition(id: string) { return (await conditions()).find(item => item.runId === id) }
async function sent(poId: string) {
  await as(DEMO_IDS.admin)
  const po = (await query('select * from public.po_dispatches where id=$1', [poId])).rows[0]
  await query('select public.begin_po_dispatch($1,$2)', [poId, po.version])
  await as(null, 'service_role')
  await query('select public.finalize_po_dispatch($1,$2,null,$3)', [poId, `condition-provider-${poId}`, 'sent'])
  await as(DEMO_IDS.admin)
}
const poData = () => ({ dueDate: '2026-11-11', recipient: 'factory@example.test', subject: '생산 조건 협의 PO', body: '사이즈별 수량과 납기·생산 조건을 확인해 주세요.', evidenceAttachmentId: null, voided: false })
const runInput = (poId: string | null = null, unitCost: number | null = null) => ({ name: '생산 조건 검증', projectId: style.projectId, projectCode: 'COND-PROJECT', expectedDue: '2026-11-11', poId, unitCost, itemType: 'product', order: { ...quantities }, correctsRunId: null })
async function createRun(id = crypto.randomUUID()) {
  await as(DEMO_IDS.admin)
  await query('select public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [id, style.id, lineId, JSON.stringify(runInput()), '생산 차수 등록'])
  return id
}
async function configure(id: string, mode = 'full_package', cost: unknown = 12000, expected?: number) {
  await as(DEMO_IDS.admin)
  const current = await run(id), terms = await condition(id)
  return query('select public.configure_production_conditions($1,$2,$3,$4,$5::jsonb,$6)', [id, current.version, expected ?? terms?.version ?? 0, mode, JSON.stringify(cost), '본사 내부 검토 전용: 기준 12000원·목표 마진 40%'])
}
async function createOrder(mode = 'full_package') {
  const id = await createRun(), poId = crypto.randomUUID()
  await configure(id, mode)
  const current = await run(id)
  await query('select public.create_production_order_po($1,$2,$3,$4::jsonb,$5)', [id, current.version, poId, JSON.stringify(poData()), '생산 차수 PO 작성'])
  await sent(poId)
  return { id, poId }
}
const proposal = (overrides: Record<string, unknown> = {}) => ({ expectedDeliveryDate: '2026-11-30', unitCost: 13500, canProduce: true, quantityConfirmed: true, agreed: true, confirmedQuantities: { ...quantities }, comment: '원단 입고 후 생산 가능', delayReason: '원단 준비 일정', priceReason: '가공 공정 추가', ...overrides })
async function submit(id: string, overrides: Record<string, unknown> = {}, expected?: number) {
  await as(DEMO_IDS.admin)
  const current = await run(id), po = (await query('select * from public.po_dispatches where id=$1', [current.po_id])).rows[0], terms = await condition(id)
  await as(DEMO_IDS.factory)
  return query('select public.submit_production_conditions($1,$2,$3,$4,$5::jsonb)', [id, current.version, po.version, expected ?? terms.version, JSON.stringify(proposal(overrides))])
}
async function review(id: string, decision = 'approve', cost: unknown = 13000, date = '2026-11-25', expected?: number, actor = DEMO_IDS.admin) {
  await as(DEMO_IDS.admin)
  const current = await run(id), terms = await condition(id)
  await as(actor)
  return query('select public.review_production_conditions($1,$2,$3,$4,$5,$6::jsonb,$7)', [id, current.version, expected ?? terms.version, decision, date, JSON.stringify(cost), decision === 'approve' ? '협의한 최종 조건 승인' : decision === 'reject' ? '일정 조건을 충족할 수 없어 발주 거절' : '납기와 단가 재협의 요청'])
}
async function receive(id: string, amount = 3) {
  const current = await run(id)
  return query('select * from public.allocate_production_receipt($1,$2,$3::jsonb,$4,$5)', [crypto.randomUUID(), id, JSON.stringify({ receivedAt: '2026-11-25', quantities: { ...emptyQuantities(), S: amount } }), current.version, '생산 차수 실입고'])
}
async function approvedOrder(mode = 'full_package') { const order = await createOrder(mode); await submit(order.id); await review(order.id); return order }

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
  for (const name of ['001_initial.sql', '002_style_images.sql', '003_operations.sql', '004_settlement_terms.sql', '005_workflow_refinements.sql', '006_staff_approvals.sql', '007_production_ledger.sql', '008_supplier_acceptance.sql', '009_import_production_runs.sql', '010_member_withdrawal.sql', '011_import_color_owners.sql', '012_outlook_po_email.sql', '013_processing_unit_prices.sql']) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const item of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [item.id, item.name, item.country])
  for (const item of fixture.projects) await query('insert into public.projects(id,name,season,code) values($1,$2,$3,$4)', [item.id, item.name, item.season, item.id === style.projectId ? 'COND-PROJECT' : ''])
  for (const item of fixture.profiles) {
    await query('insert into auth.users(id,email) values($1,$2)', [item.id, item.email])
    await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [item.id, item.name, item.role, item.approved, item.active, item.factoryId])
  }
  await query('insert into auth.users(id,email) values($1,$2)', [otherFactory, 'other-factory@example.test'])
  await query("update public.profiles set name='다른 공장',role='factory',approved=true,active=true,factory_id=$2 where id=$1", [otherFactory, DEMO_IDS.korea])
  await as(DEMO_IDS.admin); style.version = 0
  await query('select public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), '생산 조건 협의 격리 시험'])
  // Both legacy records pass through the actual old supplier-consent RPC before
  // migration014. The incremental migration must preserve these exact rows.
  for (const id of [legacyRun, legacyClosedRun]) {
    const poId = crypto.randomUUID()
    await as(DEMO_IDS.admin)
    await query('select public.save_po_dispatch($1,$2,0,$3::jsonb,$4)', [poId, style.id, JSON.stringify(poData()), '이전 방식 PO 초안'])
    await query('select public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [id, style.id, lineId, JSON.stringify(runInput(poId, 11000)), '이전 방식 생산 차수'])
    await sent(poId); await as(DEMO_IDS.factory)
    await query('select public.accept_supplier_production_order($1,1,3,$2,true)', [id, '2026-11-20'])
    await as(DEMO_IDS.admin)
    if (id === legacyClosedRun) { await receive(id); await query('select public.finalize_production_run($1,3,$2)', [id, '이전 방식 마감 확정']) }
  }
  legacyBefore = structuredClone(await run(legacyRun)); legacyClosedBefore = structuredClone(await run(legacyClosedRun))
  await db.exec('reset role')
  await db.exec(readFileSync(migrationURL, 'utf8'))
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('014 실제 PostgreSQL 생산 조건 협의 및 본사 최종 승인', () => {
  it('새 생산 발주의 방식은 본사만 설정하고 완사입·임가공 이외의 값을 거부한다', async () => isolated(async () => {
    const id = await createRun(), current = await run(id)
    await as(DEMO_IDS.factory)
    await expect(query('select public.configure_production_conditions($1,$2,0,$3,$4::jsonb,$5)', [id, current.version, 'full_package', JSON.stringify(12000), '업체의 내부 기준가 변경 시도'])).rejects.toThrow(/FORBIDDEN/)
    await expect(configure(id, 'mixed-price')).rejects.toThrow(/MODE|CONDITION|INVALID/)
    await expect(configure(id, 'cmt', '12000')).rejects.toThrow(/COST|CONDITION|INVALID/)
    await configure(id, 'cmt', 0)
    expect(await condition(id)).toMatchObject({ status: 'awaiting_po', productionMode: 'cmt', internalUnitCost: 0 })
  }))
  it('생산 방식 설정 없이 새 차수의 PO를 만들 수 없으며 잘못된 요청은 초안을 남기지 않는다', async () => isolated(async () => {
    const id = await createRun(), poId = crypto.randomUUID(), current = await run(id)
    await expect(query('select public.create_production_order_po($1,$2,$3,$4::jsonb,$5)', [id, current.version, poId, JSON.stringify(poData()), '생산 방식 누락 PO 작성'])).rejects.toThrow(/MODE|CONDITION|CONFIGURATION/)
    expect((await query('select * from public.po_dispatches where id=$1', [poId])).rows).toHaveLength(0)
  }))
  it('PO 발송 후 업체 회신 대기로 표시하고 본사 기준 단가는 업체에 노출하지 않는다', async () => isolated(async () => {
    const { id } = await createOrder()
    await as(DEMO_IDS.admin); expect(await condition(id)).toMatchObject({ status: 'awaiting_supplier', productionMode: 'full_package', internalUnitCost: 12000, legacy: false })
    await as(DEMO_IDS.factory)
    const result = await condition(id)
    expect(result).toMatchObject({ status: 'awaiting_supplier', productionMode: 'full_package' })
    expect(result).not.toHaveProperty('internalUnitCost')
    expect(JSON.stringify(result)).not.toContain('12000')
    expect(JSON.stringify(result)).not.toContain('목표 마진')
  }))
  it('업체가 늦은 납기와 제안 단가를 제출해도 본사 승인 대기이며 생산·입고·마감은 시작하지 않는다', async () => isolated(async () => {
    const { id } = await createOrder(); await submit(id)
    expect(await condition(id)).toMatchObject({ status: 'awaiting_approval', proposal: { expectedDeliveryDate: '2026-11-30', unitCost: 13500, actorId: DEMO_IDS.factory } })
    await as(DEMO_IDS.admin)
    expect((await run(id)).unit_cost).toBeNull()
    await expect(receive(id)).rejects.toThrow(/APPROVAL|PRODUCTION_NOT_STARTED|INVALID_PRODUCTION_RECEIPT/)
    // A populated pre-approval run price must not turn the missing-price check
    // into the sole barrier to recording receipt/closing.
    const unapproved = await run(id)
    await query('select public.save_production_run($1,$2,$3,$4::jsonb,$5,$6)', [id, style.id, lineId, JSON.stringify(runInput(unapproved.po_id, 12000)), unapproved.version, '승인 전 내부 검토 가격 입력'])
    await expect(receive(id)).rejects.toThrow(/APPROVAL|PRODUCTION_NOT_STARTED/)
    const current = await run(id)
    await expect(query('select public.finalize_production_run($1,$2,$3)', [id, current.version, '승인 전 마감 시도'])).rejects.toThrow(/APPROVAL|PRODUCTION_NOT_STARTED|INVALID/)
    await expect(query('select public.start_supplier_production_run($1,$2)', [id, current.version])).rejects.toThrow(/APPROVAL|SUPPLIER_ACCEPTANCE|PROTECTED/)
  }))
  it('본사 최종 승인만 생산을 시작하고 최종 단가를 차수·실입고·확정 을지 금액에 연결한다', async () => isolated(async () => {
    const { id } = await approvedOrder()
    const result = await condition(id)
    expect(result).toMatchObject({ status: 'approved', approval: { finalDeliveryDate: '2026-11-25', unitCost: 13000, approvedBy: DEMO_IDS.admin } })
    expect(result.approval.termsSnapshot).toMatchObject({ order: quantities, projectCode: 'COND-PROJECT', fullStyleCode: (await run(id)).style_code_snapshot, color: style.production[0].color })
    expect(result.approval.poSnapshot).toMatchObject({ recipient: 'factory@example.test', dueDate: '2026-11-11' })
    expect(result.approval.poSnapshot.sentAt).toBeTruthy()
    expect(Number((await run(id)).unit_cost)).toBe(13000)
    const receipt = (await receive(id)).rows[0]
    expect(Number(receipt.unit_cost)).toBe(13000); expect(Number(receipt.net_amount)).toBe(39000)
    const current = await run(id)
    const closed = (await query('select * from public.finalize_production_run($1,$2,$3)', [id, current.version, '최종 승인 단가로 마감'])).rows[0]
    expect(closed.snapshot).toMatchObject({ unitCost: 13000, receivedQuantity: 3, netAmount: 39000 })
    expect((await condition(id)).status).toBe('closed')
  }))
  it('회신 후 차수 조건이 바뀌면 낡은 제안의 승인을 막고 수정 요청·재회신으로만 다시 승인한다', async () => isolated(async () => {
    const { id } = await createOrder(); await submit(id); await as(DEMO_IDS.admin)
    const pendingRun = await run(id)
    await query('select public.save_production_run($1,$2,$3,$4::jsonb,$5,$6)', [id, style.id, lineId, JSON.stringify({ ...runInput(pendingRun.po_id), name: '변경된 생산 차수 명칭' }), pendingRun.version, '업체 회신 후 차수 조건 변경'])
    await expect(review(id)).rejects.toThrow(/PRODUCTION_CONDITIONS_CHANGED/)
    expect((await condition(id)).status).toBe('awaiting_approval')
    await review(id, 'request_revision', null, '')
    await submit(id, { comment: '변경된 생산 차수 명칭까지 재확인' })
    await review(id)
    expect((await condition(id)).approval.termsSnapshot.name).toBe('변경된 생산 차수 명칭')
  }))
  it('업체 회신 후 공장 배정이 달라지면 본사도 이전 공장의 제안을 승인할 수 없다', async () => isolated(async () => {
    const { id } = await createOrder(); await submit(id); await as(DEMO_IDS.admin)
    const current = (await query('select data,version from public.styles where id=$1', [style.id])).rows[0]
    await query('select public.save_style($1,$2::jsonb,$3,$4)', [style.id, JSON.stringify({ ...current.data, factoryId: DEMO_IDS.korea }), current.version, '업체 회신 후 담당 공장 재배정'])
    await expect(review(id)).rejects.toThrow(/ASSIGNMENT_CHANGED/)
    expect((await condition(id)).approval).toBeNull()
  }))
  it('본사 수정 요청 후 업체가 재제출하고 각각의 제안·검토 기록을 보존한다', async () => isolated(async () => {
    const { id } = await createOrder(); await submit(id); await review(id, 'request_revision', null, '')
    expect((await condition(id)).status).toBe('revision_requested')
    await submit(id, { expectedDeliveryDate: '2026-11-18', unitCost: 12500, comment: '납기와 가격 재협의 결과' })
    expect(await condition(id)).toMatchObject({ status: 'awaiting_approval', proposal: { expectedDeliveryDate: '2026-11-18', unitCost: 12500 } })
    await review(id, 'approve', 12500, '2026-11-18', undefined, DEMO_IDS.internal)
    const result = await condition(id)
    expect(result.status).toBe('approved')
    expect(result.timeline.length).toBeGreaterThanOrEqual(4)
    expect(result.proposal.unitCost).toBe(12500)
    expect(JSON.stringify(result.timeline)).toContain('2026-11-30')
    expect(JSON.stringify(result.timeline)).toContain('13500')
    expect(JSON.stringify(result.timeline)).toContain('2026-11-18')
  }))
  it('발주 거절은 기록을 보존하고 업체의 재제출·생산 시작·실입고를 차단한다', async () => isolated(async () => {
    const { id } = await createOrder(); await submit(id); await review(id, 'reject', null, '')
    expect((await condition(id)).status).toBe('rejected')
    await expect(submit(id)).rejects.toThrow(/PROTECTED|REJECTED|STATE/)
    await as(DEMO_IDS.admin); await expect(receive(id)).rejects.toThrow(/APPROVAL|PRODUCTION_NOT_STARTED|INVALID_PRODUCTION_RECEIPT/)
  }))
  it('업체가 생산 불가를 회신하면 그 제안을 본사 승인으로 생산 시작할 수 없다', async () => isolated(async () => {
    const { id } = await createOrder(); await submit(id, { canProduce: false, comment: '해당 기간 생산 여력 없음' })
    expect((await condition(id)).proposal.canProduce).toBe(false)
    await expect(review(id)).rejects.toThrow(/PRODUCE|CONDITION|APPROVAL|INVALID/)
    await review(id, 'reject', null, '')
    expect((await condition(id)).status).toBe('rejected')
  }))
  it('업체가 수량 미확인을 회신하면 명시적 확인 전 본사 최종 승인을 허용하지 않는다', async () => isolated(async () => {
    const { id } = await createOrder(); await submit(id, { quantityConfirmed: false, comment: '사이즈별 수량 재확인 요청' })
    expect((await condition(id)).proposal.quantityConfirmed).toBe(false)
    await expect(review(id)).rejects.toThrow(/QUANTITY|CONDITION|APPROVAL|INVALID/)
  }))
  it('명시 동의·생산 가능 여부·PO 수량 확인·일치한 사이즈별 수량과 유효 단가가 필요하다', async () => isolated(async () => {
    const { id } = await createOrder()
    for (const data of [{ agreed: false }, { agreed: 'true' }, { canProduce: null }, { quantityConfirmed: null }, { confirmedQuantities: { ...quantities, M: 6 } }, { expectedDeliveryDate: '2026-02-30' }, { unitCost: null }, { unitCost: -1 }, { unitCost: 0.001 }, { unitCost: '1000' }, { unitCost: 1_000_000_001 }]) await expect(submit(id, data)).rejects.toThrow()
    await submit(id, { unitCost: 0 })
    expect((await condition(id)).proposal.unitCost).toBe(0)
  }))
  it('업체 대신 본사가 회신하거나 업체가 최종 승인할 수 없고 다른 공장·미승인·익명도 차단한다', async () => isolated(async () => {
    const { id, poId } = await createOrder()
    const current = await run(id), terms = await condition(id), po = (await query('select * from public.po_dispatches where id=$1', [poId])).rows[0]
    for (const actor of [DEMO_IDS.admin, DEMO_IDS.internal, otherFactory, pending]) {
      await as(actor)
      await expect(query('select public.submit_production_conditions($1,$2,$3,$4,$5::jsonb)', [id, current.version, po.version, terms.version, JSON.stringify(proposal())])).rejects.toThrow(/FORBIDDEN/)
    }
    await submit(id)
    await expect(review(id, 'approve', 13000, '2026-11-25', undefined, DEMO_IDS.factory)).rejects.toThrow(/FORBIDDEN/)
    await as(otherFactory); expect((await conditions()).some(item => item.runId === id)).toBe(false)
    await as(pending); await expect(conditions()).rejects.toThrow(/FORBIDDEN/)
    await as(null, 'anon'); await expect(conditions()).rejects.toThrow(/permission denied/)
  }))
  it('동시에 바뀐 run·PO·조건 버전으로 회신하거나 중복 승인할 수 없다', async () => isolated(async () => {
    const { id, poId } = await createOrder(), current = await run(id), terms = await condition(id)
    const po = (await query('select * from public.po_dispatches where id=$1', [poId])).rows[0]
    await as(DEMO_IDS.factory)
    for (const values of [[current.version - 1, po.version, terms.version], [current.version, po.version - 1, terms.version], [current.version, po.version, terms.version - 1]]) await expect(query('select public.submit_production_conditions($1,$2,$3,$4,$5::jsonb)', [id, ...values, JSON.stringify(proposal())])).rejects.toThrow(/VERSION_CONFLICT/)
    await submit(id)
    await expect(review(id, 'approve', 13000, '2026-11-25', terms.version)).rejects.toThrow(/VERSION_CONFLICT/)
    await review(id)
    await expect(review(id)).rejects.toThrow(/PROTECTED|STATE|APPROVED|VERSION_CONFLICT|NOT_REVIEWABLE/)
  }))
  it('확정한 가격·납기·수량을 일반 수정하거나 승인 후 제안을 다시 제출할 수 없다', async () => isolated(async () => {
    const { id } = await approvedOrder(), before = structuredClone(await run(id))
    for (const update of [{ unitCost: 14000 }, { order: { ...quantities, S: 11 } }, { expectedDue: '2026-12-31' }]) await expect(query('select public.save_production_run($1,$2,$3,$4::jsonb,$5,$6)', [id, style.id, lineId, JSON.stringify({ ...runInput(before.po_id, Number(before.unit_cost)), ...update }), before.version, '승인 후 일반 수정 시도'])).rejects.toThrow(/PROTECTED|APPROVAL|IMMUTABLE/)
    await expect(submit(id)).rejects.toThrow(/PROTECTED|APPROVED|STATE/)
    await as(DEMO_IDS.admin); expect(await run(id)).toEqual(before)
  }))
  it('별도 조건 변경 요청은 확정된 기존 차수와 입고의 가격·수량을 바꾸지 않는다', async () => isolated(async () => {
    const { id } = await approvedOrder(); await receive(id)
    const before = structuredClone(await run(id)), receipts = (await query('select * from public.production_receipts where run_id=$1', [id])).rows, terms = await condition(id)
    await query('select public.request_production_condition_change($1,$2,$3,$4)', [id, before.version, terms.version, '다음 생산분의 납기·가격 재협의 요청'])
    expect(await run(id)).toEqual(before)
    expect((await query('select * from public.production_receipts where run_id=$1', [id])).rows).toEqual(receipts)
    const next = await condition(id)
    expect(next.approval).toEqual(terms.approval)
    expect(next.timeline.length).toBeGreaterThan(terms.timeline.length)
  }))
  it('변경 요청은 별도 생산 차수·새 PO·업체 재회신·본사 재승인을 거쳐 새 입고에만 적용한다', async () => isolated(async () => {
    const { id } = await approvedOrder(); await receive(id)
    const original = structuredClone(await run(id)), originalReceipts = (await query('select * from public.production_receipts where run_id=$1', [id])).rows, originalConditions = await condition(id)
    const request = (await query('select public.request_production_condition_change($1,$2,$3,$4) id', [id, original.version, originalConditions.version, '추가 생산분의 단가·납기 변경 요청'])).rows[0].id
    const replacement = await createRun(), unlinked = await run(replacement)
    await expect(query('select public.link_production_condition_change($1,$2,$3,$4,false)', [request, replacement, unlinked.version, '별도 생산분 범위 확인 전'])).rejects.toThrow(/CONFIRMATION_REQUIRED/)
    await query('select public.link_production_condition_change($1,$2,$3,$4,true)', [request, replacement, unlinked.version, '기존 누적 오더와 별개인 추가 생산분으로 확인'])
    const linked = await run(replacement)
    await expect(query('select public.link_production_condition_change($1,$2,$3,$4,true)', [request, replacement, linked.version, '같은 변경 요청 중복 연결'])).rejects.toThrow(/DUPLICATE/)
    expect(await condition(replacement)).toMatchObject({ priorRunId: id, changeRequestId: request, approval: null })
    expect((await condition(id)).changeRequests).toEqual(expect.arrayContaining([expect.objectContaining({ id: request, correctingRunId: replacement })]))
    await configure(replacement)
    const poId = crypto.randomUUID(), ready = await run(replacement)
    await query('select public.create_production_order_po($1,$2,$3,$4::jsonb,$5)', [replacement, ready.version, poId, JSON.stringify(poData()), '추가 생산분 새 PO 작성'])
    await sent(poId); await submit(replacement, { expectedDeliveryDate: '2026-12-01', unitCost: 14000 })
    await as(DEMO_IDS.admin); await expect(receive(replacement)).rejects.toThrow(/APPROVAL|PRODUCTION_NOT_STARTED|INVALID_PRODUCTION_RECEIPT/)
    await review(replacement, 'approve', 14000, '2026-12-01')
    const newReceipt = (await receive(replacement)).rows[0]
    expect(Number(newReceipt.unit_cost)).toBe(14000)
    expect(await run(id)).toEqual(original)
    expect((await query('select * from public.production_receipts where run_id=$1', [id])).rows).toEqual(originalReceipts)
    expect((await condition(id)).approval).toEqual(originalConditions.approval)
  }))
  it('다른 프로젝트의 차수를 조건 변경 대상으로 연결하거나 연결 요청만으로 차수를 복제하지 않는다', async () => isolated(async () => {
    const { id } = await approvedOrder(), original = await run(id), terms = await condition(id)
    const request = (await query('select public.request_production_condition_change($1,$2,$3,$4) id', [id, original.version, terms.version, '프로젝트 범위 검증 변경 요청'])).rows[0].id
    const otherProject = fixture.projects.find(project => project.id !== style.projectId)!, replacement = crypto.randomUUID()
    await query('select public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [replacement, style.id, lineId, JSON.stringify({ ...runInput(), projectId: otherProject.id, projectCode: '' }), '별도 프로젝트 신규 생산 차수'])
    const before = (await query('select * from public.production_runs order by id')).rows, candidate = await run(replacement)
    await expect(query('select public.link_production_condition_change($1,$2,$3,$4,true)', [request, replacement, candidate.version, '다른 프로젝트 연결 시도'])).rejects.toThrow(/INVALID_PRODUCTION_CHANGE_LINK/)
    expect((await query('select * from public.production_runs order by id')).rows).toEqual(before)
    expect((await condition(id)).changeRequests[0].correctingRunId).toBeNull()
  }))
  it('기존 시작·마감 차수는 승인을 되돌리거나 금액을 재산정하지 않는다', async () => isolated(async () => {
    expect(await run(legacyRun)).toEqual(legacyBefore)
    expect(await run(legacyClosedRun)).toEqual(legacyClosedBefore)
    expect(await condition(legacyRun)).toMatchObject({ legacy: true })
    expect(await condition(legacyClosedRun)).toMatchObject({ legacy: true, status: 'closed' })
    await receive(legacyRun)
    const current = await run(legacyRun)
    const closed = (await query('select * from public.finalize_production_run($1,$2,$3)', [legacyRun, current.version, '이전 승인 이력 보존 마감'])).rows[0]
    expect(closed.snapshot.unitCost).toBe(11000)
  }))
  it('구 생산 동의 RPC와 생산 시작 RPC로 신규 본사 승인을 우회할 수 없다', async () => isolated(async () => {
    const { id, poId } = await createOrder(), current = await run(id), po = (await query('select * from public.po_dispatches where id=$1', [poId])).rows[0]
    await as(DEMO_IDS.factory)
    await expect(query('select public.accept_supplier_production_order($1,$2,$3,$4,true)', [id, current.version, po.version, '2026-11-18'])).rejects.toThrow(/APPROVAL|CONDITION|PROTECTED/)
    await as(DEMO_IDS.admin); await expect(query('select public.start_supplier_production_run($1,$2)', [id, current.version])).rejects.toThrow(/APPROVAL|ACCEPTANCE|CONDITION|PROTECTED/)
    expect((await condition(id)).status).toBe('awaiting_supplier')
  }))
  it('원문 조건·내부 가격·불변 이력 테이블과 내부 도우미를 직접 호출하거나 변조할 수 없다', async () => isolated(async () => {
    await approvedOrder()
    const privateTables = ['production_conditions', 'production_condition_legacy_cutover', 'production_condition_legacy_starts', 'production_condition_proposals', 'production_condition_approvals', 'production_condition_events', 'production_condition_changes', 'production_condition_change_links']
    for (const actor of [DEMO_IDS.admin, DEMO_IDS.internal, DEMO_IDS.factory, otherFactory]) {
      await as(actor)
      for (const table of privateTables) {
        await expect(query(`select * from public.${table}`)).rejects.toThrow(/permission denied/)
        await expect(query(`delete from public.${table}`)).rejects.toThrow(/permission denied/)
      }
      await expect(query('select public.production_condition_cost($1::jsonb,true)', ['100'])).rejects.toThrow(/permission denied/)
    }
    await as(null, 'service_role')
    await expect(conditions()).rejects.toThrow(/permission denied/)
  }))
  it('최신 사용자 권한과 공장 배정이 바뀌면 기존 세션도 회신·승인을 할 수 없다', async () => isolated(async () => {
    const { id } = await createOrder(); await db.exec('reset role')
    await query('update public.profiles set active=false where id=$1', [DEMO_IDS.factory])
    await as(DEMO_IDS.factory); await expect(conditions()).rejects.toThrow(/FORBIDDEN/)
    await expect(submit(id)).rejects.toThrow(/FORBIDDEN/)
    await db.exec('reset role'); await query('update public.profiles set active=true where id=$1', [DEMO_IDS.factory])
    await as(DEMO_IDS.admin)
    const current = (await query('select data,version from public.styles where id=$1', [style.id])).rows[0]
    await query('select public.save_style($1,$2::jsonb,$3,$4)', [style.id, JSON.stringify({ ...current.data, factoryId: DEMO_IDS.korea }), current.version, '다른 업체로 재배정'])
    await as(DEMO_IDS.factory); expect((await conditions()).some(item => item.runId === id)).toBe(false)
    await expect(submit(id)).rejects.toThrow(/FORBIDDEN|ASSIGNMENT/)
  }))
  it('마이그레이션 재실행은 기존 생산·입고·마감 및 승인 증거를 보존한다', async () => {
    await as(DEMO_IDS.admin)
    const { id } = await approvedOrder()
    expect((await condition(id)).legacy).toBe(false)
    const before = (await query('select * from public.production_runs order by id')).rows
    const receipts = (await query('select * from public.production_receipts order by id')).rows
    const view = await conditions()
    await db.exec('reset role'); await db.exec(readFileSync(migrationURL, 'utf8'))
    await as(DEMO_IDS.admin)
    expect((await query('select * from public.production_runs order by id')).rows).toEqual(before)
    expect((await query('select * from public.production_receipts order by id')).rows).toEqual(receipts)
    expect(await conditions()).toEqual(view)
    expect((await condition(id)).legacy).toBe(false)
    const approved = await run(id)
    await expect(query('select public.save_production_run($1,$2,$3,$4::jsonb,$5,$6)', [id, style.id, lineId, JSON.stringify({ ...runInput(approved.po_id, 14000) }), approved.version, '재실행 이후 승인 단가 덮어쓰기 시도'])).rejects.toThrow(/PROTECTED|APPROVAL|IMMUTABLE/)
  })
})
