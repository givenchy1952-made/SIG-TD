import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { buildBudgetSources, defaultBudgetPayment } from '../src/lib/budget-domain'
import type { BudgetCostData, BudgetFAEntry, BudgetPaymentData } from '../src/lib/budget-types'
import type { Workspace } from '../src/lib/types'

const db = new PGlite(), fixture = createSeed(), finance = crypto.randomUUID(), runId = crypto.randomUUID()
const style = structuredClone(fixture.styles[1]), project = { ...fixture.projects[0], name: '테스트 공식 프로젝트', code: 'SIGNIFICANT-2027FY-RPQ-47001', season: '2027FY' }
const sourceSku = 'BP07FYKT0703BK', financeSecret = 'DO_NOT_EXPOSE_PRIVATE_PRODUCTION_DATA'
let transaction = false, sequence = 0, source: BudgetFAEntry
async function query<T = Record<string, any>>(sql: string, values: unknown[] = []) {
  if (!transaction) return db.query<T>(sql, values)
  const point = `budget_query_${sequence++}`; await db.exec(`savepoint ${point}`)
  try { const value = await db.query<T>(sql, values); await db.exec(`release savepoint ${point}`); return value }
  catch (failure) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw failure }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function owner(sql: string, values: unknown[] = []) { await db.exec('reset role'); try { return await query(sql, values) } finally { await as(DEMO_IDS.admin) } }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await as(DEMO_IDS.admin); await fn() } finally { transaction = false; await db.exec('rollback') } }
async function save(kind: string, data: unknown, id = crypto.randomUUID(), version = 0, reason = '예산 누적 입력 검증') { return (await query('select to_jsonb(public.save_budget_record($1,$2,$3::jsonb,$4,$5)) value', [kind, id, JSON.stringify(data), version, reason])).rows[0].value }
const cost = (changes: Partial<BudgetCostData> = {}): BudgetCostData => ({ projectId: project.id, budgetCode: project.code + sourceSku, styleCode: sourceSku, supplierId: style.factoryId, supplierName: '예산 업체', stage: 'pre', category: '생산', description: '명시 원가 금액', position: '', specification: '', itemName: '제품', composition: '', color: 'BK', unitCost: null, variableUnitCost: null, consumption: null, unit: 'EA', amount: 1000, voided: false, ...changes })
const payment = (changes: Partial<BudgetPaymentData> = {}): BudgetPaymentData => ({ ...defaultBudgetPayment(source), status: 'paid', paidAt: '2026-11-08', ...changes })
async function workspace() { return (await query('select public.get_budget_workspace() value')).rows[0].value }

beforeAll(async () => {
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,last_accessed_at timestamptz,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;
    grant execute on function auth.uid() to authenticated,anon,service_role;
    grant select,insert,update,delete on storage.objects to authenticated;`)
  for (const name of readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(name => /^0(?:0[1-9]|1[0-9]|2[0-3])_.*\.sql$/.test(name)).sort()) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const row of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [row.id, row.name, row.country])
  await query('insert into public.projects(id,name,season,code) values($1,$2,$3,$4)', [project.id, project.name, project.season, project.code])
  for (const row of [...fixture.profiles, { id: finance, name: '자금팀', email: 'finance@example.test', role: 'finance', approved: true, active: true, factoryId: null }]) {
    await query('insert into auth.users(id,email) values($1,$2)', [row.id, row.email]); await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [row.id, row.name, row.role, row.approved, row.active, row.factoryId])
  }
  style.id = crypto.randomUUID(); style.code = 'BP07FYKT0703'; style.name = '예산 테스트 스타일'; style.projectId = project.id; style.season = project.season; style.stage = 'production'; style.colors = ['BK']; style.samples = []; style.production = [style.production[0]]; style.production[0].color = 'BK'; style.notes = financeSecret; style.version = 0
  style.production[0].order = { XXS: 0, XS: 0, S: 0, M: 10, L: 0, XL: 0 }; style.production[0].received = { ...style.production[0].order }; style.production[0].shipped = { ...style.production[0].order }; style.production[0].receivedAt = '2026-11-01'
  await as(DEMO_IDS.admin); await query('select public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), '예산 원본 스타일 생성'])
  const snapshot = { projectId: project.id, projectCode: project.code, styleCode: sourceSku, factory: fixture.factories.find(f => f.id === style.factoryId)!.name, owner: '본사 담당자', name: '누적 테스트', round: 1, poId: null, itemType: 'product', unitCost: 12.34, orderQuantity: 10, receivedQuantity: 10, netAmount: 123.4, vatAmount: 12.34, grossAmount: 135.74, lastReceivedAt: '2026-11-01', receipts: [], finalizedAt: '2026-11-02T00:00:00Z', finalizedBy: DEMO_IDS.admin, factoryIdSnapshot: style.factoryId, factoryNameSnapshot: fixture.factories.find(f => f.id === style.factoryId)!.name, ownerIdSnapshot: DEMO_IDS.admin, ownerNameSnapshot: '본사 담당자', styleCodeSnapshot: sourceSku }
  await owner('insert into public.production_runs(id,style_id,line_id,project_id,name,project_code,expected_due,unit_cost,item_type,order_quantities,round,version,factory_id_snapshot,owner_id_snapshot,style_code_snapshot,factory_name_snapshot,owner_name_snapshot,closed_at,snapshot,updated_by) values($1,$2,$3,$4,$5,$6,$7,12.34,$8,$9::jsonb,1,3,$10,$11,$12,$13,$14,$15,$16::jsonb,$11)', [runId, style.id, style.production[0].id, project.id, '마감 완료', project.code, '2026-11-01', 'product', JSON.stringify(style.production[0].order), style.factoryId, DEMO_IDS.admin, sourceSku, snapshot.factory, '본사 담당자', '2026-11-02T00:00:00Z', JSON.stringify(snapshot)])
  await query("insert into public.comments(style_id,body) values($1,$2)", [style.id, financeSecret])
  const value = await workspace(); source = buildBudgetSources(value.sourceInput as Workspace).settlements[0]
  expect(source).toBeTruthy()
}, 60000)
afterAll(async () => { await db.close() })

describe.sequential('023 예산·FA 누적 PostgreSQL 권한과 금액 보존', () => {
  it('본사·FA만 최소 재무 자료를 읽고 FA는 원본·댓글·프로필 명단·감사를 읽지 않는다', async () => isolated(async () => {
    await save('cost', cost()); await as(finance)
    expect((await query('select public.get_budget_capability() value')).rows[0].value).toBe(true)
    const value = await workspace()
    expect(value.records).toHaveLength(1); expect(value.audits).toHaveLength(0)
    expect(JSON.stringify(value)).not.toContain(financeSecret); expect(JSON.stringify(value)).not.toContain('@example')
    expect(value.sourceInput.styles[0]).not.toHaveProperty('notes')
    for (const owner of value.sourceInput.profiles) expect(Object.keys(owner).sort()).toEqual(['id', 'name'])
    expect(value.sourceInput.operations).not.toHaveProperty('poDispatches')
    expect((await query('select * from public.styles')).rows).toHaveLength(0)
    expect((await query('select * from public.comments')).rows).toHaveLength(0)
    expect((await query('select * from public.budget_record_audits')).rows).toHaveLength(0)
    await expect(query('select public.budget_source_input()')).rejects.toThrow(/permission denied/)
  }))
  it('원가·한도 저장은 null과0원을 구분하고 원본 생산 금액을 바꾸지 않는다', async () => isolated(async () => {
    const before = (await query('select snapshot,order_quantities,version from public.production_runs')).rows
    const id = crypto.randomUUID(); expect((await save('cost', cost({ amount: null }), id)).data.amount).toBeNull()
    expect((await save('cost', cost({ amount: 0 }), id, 1)).data.amount).toBe(0)
    expect((await save('limit', { season: '2027FY', amount: null })).data.amount).toBeNull()
    expect((await query('select snapshot,order_quantities,version from public.production_runs')).rows).toEqual(before)
  }))
  it('실제 결제는 확정 원본 스냅샷에 묶이고 금융 전후 이력을 보존한다', async () => isolated(async () => {
    const id = crypto.randomUUID(); const saved = await save('payment', payment(), id)
    expect(saved.data).toEqual(payment()); expect(saved.version).toBe(1)
    await save('payment', payment({ status: 'unpaid', paidAt: '' }), id, 1)
    const value = await workspace(); expect(value.audits).toHaveLength(2)
    expect(value.audits[1].before.data.status).toBe('paid'); expect(value.audits[1].after.data.status).toBe('unpaid')
  }))
  it('올바른 버전 토큰을 사용해도 금액·수량·프로젝트·업체를 위조할 수 없다', async () => isolated(async () => {
    for (const overrides of [{ netAmount: 9999 }, { vatAmount: 999 }, { grossAmount: 999 }, { receivedQuantity: 99 }, { unitCost: 1 }, { projectId: crypto.randomUUID() }, { budgetCode: 'FAKE' }, { factoryId: crypto.randomUUID() }, { projectName: '변조한 프로젝트' }, { factoryName: '다른 지급 업체' }, { owner: '변조 담당자' }, { item: '다른 품목' }, { receivedAt: '2026-11-03' }, { orderDate: '2026-11-03' }, { evidence: '다른 마감 근거' }]) {
      await expect(save('payment', payment({ sourceSnapshot: { ...source, ...overrides } }))).rejects.toThrow(/BUDGET_SOURCE_CHANGED/)
    }
    await expect(save('payment', payment({ sourceFingerprint: `${source.sourceKey}@999` }))).rejects.toThrow(/BUDGET_SOURCE_CHANGED/)
    expect((await workspace()).records).toHaveLength(0)
  }))
  it('이미 지급한 원본 금액은 직접 다른 결제 금액으로 교체하지 못하고 명시적 미결제 정정을 거친다', async () => isolated(async () => {
    const id = crypto.randomUUID(); await save('payment', payment(), id)
    await expect(save('payment', payment({ sourceFingerprint: source.sourceFingerprint + ':changed', sourceSnapshot: { ...source, netAmount: 999 } }), id, 1)).rejects.toThrow(/HISTORY_PROTECTED/)
    expect((await workspace()).records.find((row: { id: string }) => row.id === id).data.sourceSnapshot.netAmount).toBe(source.netAmount)
    await save('payment', payment({ status: 'unpaid', paidAt: '' }), id, 1)
    await save('payment', payment(), id, 2)
    expect((await workspace()).audits).toHaveLength(3)
  }))
  it('가공 지급은 실제 업체·완료 작업·단가에 연결하고 변경·무효 후에도 명시적 정정 전 지급액을 보존한다', async () => isolated(async () => {
    const supplier = crypto.randomUUID(), operation = crypto.randomUUID(), item = crypto.randomUUID(), id = crypto.randomUUID()
    await owner("insert into public.factories(id,name,country,service_type) values($1,'QA 라벨 공급사','대한민국','label')", [supplier])
    const work = { id: item, catalogId: crypto.randomUUID(), name: 'QA 라벨', specification: '10mm', quantity: 10, lossQuantity: 0, completedQuantity: 10, status: 'done', orderedAt: '2026-10-20', requestedAt: '', completedAt: '2026-11-01', dueDate: '', note: financeSecret }
    await owner("insert into public.style_operations(id,style_id,kind,rows_data,note,version,updated_by,supplier_factory_id,supplier_name_snapshot) values($1,$2,'label',$3::jsonb,$4,1,$5,$6,'QA 라벨 공급사')", [operation, style.id, JSON.stringify([work]), financeSecret, DEMO_IDS.admin, supplier])
    await owner("insert into public.processing_unit_prices(style_id,line_id,kind,item_key,unit_cost,version,updated_by,supplier_factory_id,supplier_name_snapshot) values($1,$2,'label',$3,0.15,1,$4,$5,'QA 라벨 공급사')", [style.id, style.production[0].id, item, DEMO_IDS.admin, supplier])
    // An unrelated inspection version must not enter a label source token.
    await owner('insert into public.inspection_assignments(style_id,line_id,provider,version,updated_by) values($1,$2,null,7,$3)', [style.id, style.production[0].id, DEMO_IDS.admin])
    const first = buildBudgetSources((await workspace()).sourceInput as Workspace).settlements.find(row => row.sourceKey.startsWith('processing:label:'))!
    expect(first).toMatchObject({ netAmount: 1.5, factoryId: supplier, evidence: '10mm' })
    const paid = { ...defaultBudgetPayment(first), status: 'paid' as const, paidAt: '2026-11-08' }
    await save('payment', paid, id)
    await owner("update public.processing_unit_prices set unit_cost=0.20,version=2 where style_id=$1 and line_id=$2 and kind='label' and item_key=$3", [style.id, style.production[0].id, item])
    const changed = buildBudgetSources((await workspace()).sourceInput as Workspace).settlements.find(row => row.sourceKey === first.sourceKey)!
    await expect(save('payment', { ...defaultBudgetPayment(changed), status: 'paid', paidAt: '2026-11-08' }, id, 1)).rejects.toThrow(/HISTORY_PROTECTED/)
    expect((await workspace()).records[0].data.sourceSnapshot.netAmount).toBe(1.5)
    await owner('update public.style_operations set voided=true,version=2 where id=$1', [operation])
    expect(buildBudgetSources((await workspace()).sourceInput as Workspace).settlements.some(row => row.sourceKey === first.sourceKey)).toBe(false)
    await save('payment', { ...paid, status: 'unpaid', paidAt: '' }, id, 1)
    const records = (await workspace()).records
    expect(records[0].data.status).toBe('unpaid')
    expect((await workspace()).audits).toHaveLength(2)
  }))
  it('부족 입고로 생산 마감한 가공은 사이즈별 원장 일치가 확인된 경우에만 실제 수량으로 결제한다', async () => isolated(async () => {
    const short = structuredClone(style), shortRun = crypto.randomUUID(), supplier = crypto.randomUUID(), operation = crypto.randomUUID(), item = crypto.randomUUID()
    short.id = crypto.randomUUID();short.code = 'BP07FYKT0704';short.production[0].id = crypto.randomUUID();short.version = 0
    short.production[0].received.M = 7;short.production[0].shipped.M = 7
    const line = short.production[0], sku = short.code + line.color
    await query('select public.save_style($1,$2::jsonb,0,$3)', [short.id, JSON.stringify(short), '부족 입고 생산 마감 원본'])
    const snapshot = { projectId: project.id, projectCode: project.code, styleCode: sku, factory: fixture.factories.find(f => f.id === short.factoryId)!.name, owner: '본사 담당자', round: 1, name: '부족 입고 마감', itemType: 'product', unitCost: 12.34, orderQuantity: 10, receivedQuantity: 7, netAmount: 86.38, vatAmount: 8.638, grossAmount: 95.018, lastReceivedAt: '2026-11-01', finalizedAt: '2026-11-02T00:00:00Z', factoryIdSnapshot: short.factoryId, ownerNameSnapshot: '본사 담당자' }
    await owner('insert into public.production_runs(id,style_id,line_id,project_id,name,project_code,unit_cost,item_type,order_quantities,round,version,factory_id_snapshot,owner_id_snapshot,style_code_snapshot,factory_name_snapshot,owner_name_snapshot,closed_at,snapshot,updated_by) values($1,$2,$3,$4,$5,$6,12.34,$7,$8::jsonb,1,3,$9,$10,$11,$12,$13,$14,$15::jsonb,$10)', [shortRun, short.id, line.id, project.id, '부족 입고 마감', project.code, 'product', JSON.stringify(line.order), short.factoryId, DEMO_IDS.admin, sku, snapshot.factory, snapshot.owner, '2026-11-02T00:00:00Z', JSON.stringify(snapshot)])
    // Seed a historical, already-finalized receipt directly. The unrelated PO
    // start workflow is tested separately; its trigger is bypassed only during
    // this owner-only local fixture insert and is immediately restored.
    await owner('alter table public.production_receipts disable trigger production_receipts_require_start')
    await owner('insert into public.production_receipts(id,run_id,style_id,line_id,received_at,quantities,unit_cost,net_amount,version,created_by) values($1,$2,$3,$4,$5,$6::jsonb,12.34,86.38,1,$7)', [crypto.randomUUID(), shortRun, short.id, line.id, '2026-11-01', JSON.stringify(line.received), DEMO_IDS.admin])
    await owner('alter table public.production_receipts enable trigger production_receipts_require_start')
    await owner("insert into public.factories(id,name,country,service_type) values($1,'QA 부족 입고 라벨','대한민국','label')", [supplier])
    const work = { id: item, catalogId: crypto.randomUUID(), name: 'QA 부족 입고 라벨', specification: '20mm', status: 'done' }
    await owner("insert into public.style_operations(id,style_id,kind,rows_data,note,version,updated_by,supplier_factory_id,supplier_name_snapshot) values($1,$2,'label',$3::jsonb,'',1,$4,$5,'QA 부족 입고 라벨')", [operation, short.id, JSON.stringify([work]), DEMO_IDS.admin, supplier])
    await owner("insert into public.processing_unit_prices(style_id,line_id,kind,item_key,unit_cost,version,updated_by,supplier_factory_id,supplier_name_snapshot) values($1,$2,'label',$3,0.15,1,$4,$5,'QA 부족 입고 라벨')", [short.id, line.id, item, DEMO_IDS.admin, supplier])
    const entry = buildBudgetSources((await workspace()).sourceInput as Workspace).settlements.find(row => row.sourceKey.startsWith(`processing:label:${short.id}:`))!
    expect(entry).toMatchObject({ orderQuantity: 10, receivedQuantity: 7, netAmount: 1.05 })
    await save('payment', { ...defaultBudgetPayment(entry), status: 'paid', paidAt: '2026-11-08' })
    // The same closed snapshot cannot authorize a parent quantity that no longer
    // reconciles to its receipt ledger, even when all source IDs remain valid.
    await owner("update public.styles set data=jsonb_set(data,'{production,0,received,M}','8'::jsonb),version=version+1 where id=$1", [short.id])
    await expect(query('select public.budget_payment_fingerprint($1)', [entry.sourceKey])).rejects.toThrow(/permission denied/)
    await expect(save('payment', { ...defaultBudgetPayment(entry), status: 'paid', paidAt: '2026-11-08' })).rejects.toThrow(/BUDGET_SOURCE_CHANGED/)
  }))
  it('중복 한도·결제 키와 버전 충돌은 기존 자료를 덮어쓰지 않는다', async () => isolated(async () => {
    const id = crypto.randomUUID(); await save('cost', cost(), id)
    await expect(save('cost', cost({ amount: 2 }), id, 0)).rejects.toThrow(/VERSION_CONFLICT/)
    await save('limit', { season: '2027FY', amount: 10000 })
    await expect(save('limit', { season: '2027FY', amount: 1 })).rejects.toThrow(/VERSION_CONFLICT/)
    await save('payment', payment())
    await expect(save('payment', payment())).rejects.toThrow(/VERSION_CONFLICT/)
    expect((await workspace()).records).toHaveLength(3)
  }))
  it('금액 형식·원가 연결·추가 필드·결제일을 검증한다', async () => isolated(async () => {
    for (const invalid of [cost({ amount: -1 }), cost({ amount: .001 }), { ...cost(), amount: '12' }, { ...cost(), extra: true }, cost({ budgetCode: 'FAKE' }), cost({ styleCode: 'UNKNOWN' })]) await expect(save('cost', invalid)).rejects.toThrow(/INVALID_/)
    await expect(save('payment', payment({ paidAt: '2099-01-01' }))).rejects.toThrow(/INVALID_BUDGET/)
    await expect(save('payment', payment({ paidAt: '2026-02-30' }))).rejects.toThrow(/INVALID_/)
    await expect(save('payment', payment({ sourceSnapshot: null }))).rejects.toThrow(/INVALID_BUDGET/)
    await expect(save('limit', { season: '2027FY', amount: 1 }, crypto.randomUUID(), 0, 'x')).rejects.toThrow(/REASON_REQUIRED/)
  }))
  it('FA·공장·미승인·비활성·익명의 직접 변경과 감사를 차단한다', async () => isolated(async () => {
    for (const id of [finance, DEMO_IDS.factory, fixture.profiles.find(p => !p.approved)!.id]) {
      await as(id); await expect(save('cost', cost())).rejects.toThrow(/FORBIDDEN/)
      await expect(query('delete from public.budget_records')).rejects.toThrow(/permission denied/)
      await expect(query('insert into public.budget_record_audits(record_id,kind,actor_id,actor_name,reason,after) values($1,$2,$3,$4,$5,$6::jsonb)', [crypto.randomUUID(), 'cost', id, '위조', '위조 사유', '{}'])).rejects.toThrow(/permission denied/)
    }
    await owner('update public.profiles set active=false where id=$1', [finance]); await as(finance)
    expect((await query('select public.get_budget_capability() value')).rows[0].value).toBe(false)
    expect((await query('select * from public.budget_records')).rows).toHaveLength(0)
    await expect(workspace()).rejects.toThrow(/FORBIDDEN/)
    await as(null, 'anon'); await expect(workspace()).rejects.toThrow(/permission denied/)
  }))
  it('원본 스타일을 소프트 삭제해도 확정 재무 스냅샷이 남고 재설치는 자료를 보존한다', async () => isolated(async () => {
    await save('payment', payment())
    await owner('update public.styles set deleted_at=clock_timestamp() where id=$1', [style.id])
    const value = await workspace(), sources = buildBudgetSources(value.sourceInput as Workspace)
    expect(sources.settlements[0]).toMatchObject({ sourceKey: source.sourceKey, netAmount: source.netAmount })
    const before = value.records
    await db.exec('reset role'); await db.exec(readFileSync(new URL('../supabase/migrations/023_budget_fa_ledger.sql', import.meta.url), 'utf8').replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '')); await as(DEMO_IDS.admin)
    expect((await workspace()).records).toEqual(before)
  }))
})
