import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { blankProductionDetails } from '../src/lib/workflow-refinements'

// These tests execute the real migration/RPCs under PostgreSQL roles and RLS.
// No Supabase project, production data, or network connection is used.
const db = new PGlite(), fixture = createSeed()
const migration = readFileSync(new URL('../supabase/migrations/021_supplier_work_rates.sql', import.meta.url), 'utf8')
const vendors = { label: crypto.randomUUID(), other: crypto.randomUUID(), embroidery: crypto.randomUUID(), able: crypto.randomUUID(), kotiti: crypto.randomUUID() }
const actors = Object.fromEntries(Object.keys(vendors).map(key => [key, crypto.randomUUID()])) as Record<keyof typeof vendors, string>
const styles = [0, 1, 2].map(index => ({ ...structuredClone(fixture.styles[1]), id: crypto.randomUUID(), code: `QAQUOTE${index}`, version: 0,
  colors: fixture.styles[1].colors.slice(0, 2), production: fixture.styles[1].production.slice(0, 2).map(line => ({ ...structuredClone(line), id: crypto.randomUUID() })) }))
const legacyRowId = crypto.randomUUID(), legacyOperationId = crypto.randomUUID(), closedRun = crypto.randomUUID()
let transaction = false, sequence = 0, legacyCatalog: Record<string, any>, beforeMigration: unknown

async function query<T = Record<string, any>>(statement: string, values: unknown[] = []) {
  if (!transaction) return db.query<T>(statement, values)
  const point = `supplier_${sequence++}`; await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(statement, values); await db.exec(`release savepoint ${point}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function owner(statement: string, values: unknown[] = []) { await db.exec('reset role'); try { return await query(statement, values) } finally { await as(DEMO_IDS.admin) } }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await as(DEMO_IDS.admin); await fn() } finally { transaction = false; await db.exec('rollback') } }
const reason = '업체 작업·단가 명시적 저장'
async function master(id = crypto.randomUUID(), supplier = vendors.label, kind = 'label', cost: unknown = 120, catalogVersion = 0, rateVersion = 0, name = '메인 라벨', specification = '40 × 20 mm / 블랙', active = true) {
  return (await query('select * from public.save_supplier_work_item($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)', [id, supplier, kind, name, specification, active, JSON.stringify(cost), catalogVersion, rateVersion, reason])).rows[0]
}
async function rate(supplier: string, kind: string, key: string, cost: unknown, version = 0) {
  return (await query('select * from public.save_supplier_work_rate($1,$2,$3,$4::jsonb,$5,$6)', [supplier, kind, key, JSON.stringify(cost), version, reason])).rows[0]
}
function work(catalog: Record<string, any>, id = crypto.randomUUID()) {
  return { id, catalogId: catalog.id, name: catalog.name, specification: catalog.specification || '', quantity: 100, lossQuantity: 3, completedQuantity: 0, status: 'todo', orderedAt: '', requestedAt: '', completedAt: '', dueDate: '', note: '' }
}
async function job(catalog: Record<string, any>, target = styles[1], rows = [work(catalog)], id = crypto.randomUUID(), version = 0, supplier: string | null = vendors.label, versions: Record<string, number> = { [catalog.id]: catalog.version }) {
  return (await query('select * from public.save_style_operation_with_supplier($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)', [id, target.id, catalog.kind, supplier, version, JSON.stringify({ rows, note: '', voided: false }), reason, JSON.stringify(versions)])).rows[0]
}
async function prices(style = styles[1]) { return (await query('select * from public.processing_unit_prices where style_id=$1 order by kind,line_id,item_key', [style.id])).rows }
async function assign(provider: string | null, version = 0, target = styles[1]) { return query('select public.save_inspection_assignment($1,$2,$3,$4,$5)', [target.id, target.production[0].id, provider, version, reason]) }
async function apply(supplier = vendors.able, assignmentVersion = 1, priceVersion = 0, target = styles[1], category = '아우터') {
  return (await query('select * from public.apply_supplier_quality_rate($1,$2,$3,$4,$5,$6,$7)', [target.id, target.production[0].id, supplier, category, assignmentVersion, priceVersion, reason])).rows[0]
}
async function manual(style: typeof styles[number], kind: string, key: string, cost: unknown, version = 0) {
  return (await query('select * from public.save_processing_unit_price($1,$2,$3,$4,$5::jsonb,$6,$7)', [style.id, style.production[0].id, kind, key, JSON.stringify(cost), version, reason])).rows[0]
}
async function business() {
  const value: Record<string, unknown> = {}
  for (const table of ['styles', 'projects', 'profiles', 'production_runs', 'production_receipts', 'production_conditions', 'production_condition_proposals', 'production_condition_approvals', 'production_partial_delivery_plans', 'production_details', 'settlement_terms', 'po_dispatches', 'po_dispatch_attempts', 'order_source_records']) value[table] = (await owner(`select to_jsonb(t) value from public.${table} t order by to_jsonb(t)::text`)).rows
  return value
}

beforeAll(async () => {
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create schema storage;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,last_accessed_at timestamptz,unique(bucket_id,name));alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;grant select,insert,update,delete on storage.objects to authenticated;`)
  for (const name of readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(name => /^0(?:0[1-9]|1[0-9]|20)_.*\.sql$/.test(name)).sort()) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const row of [...fixture.factories, ...Object.entries(vendors).map(([name, id]) => ({ id, name: `QA ${name}`, country: '대한민국' }))]) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [row.id, row.name, row.country])
  for (const row of fixture.projects) await query('insert into public.projects(id,name,season,code) values($1,$2,$3,$4)', [row.id, row.name, row.season, `HQ-PRIVATE-${row.id}`])
  const people = [...fixture.profiles, ...Object.entries(actors).map(([key, id]) => ({ ...fixture.profiles[3], id, email: `${key}@qa.test`, factoryId: vendors[key as keyof typeof vendors] }))]
  for (const row of people) { await query('insert into auth.users(id,email) values($1,$2)', [row.id, row.email]); await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [row.id, row.name, row.role, row.approved, row.active, row.factoryId]) }
  await as(DEMO_IDS.admin)
  for (const [key, id] of Object.entries(vendors)) await query('select public.save_factory_service_settings($1,$2,$3,0,$4)', [id, key === 'able' || key === 'kotiti' ? 'inspection' : key === 'other' ? 'label' : key, key === 'able' || key === 'kotiti' ? key : null, reason])
  for (const style of styles) {
    await query('select public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), reason])
    const details = blankProductionDetails(); details.quality.category = '아우터'
    await query('select public.save_production_details($1,$2,0,$3::jsonb,$4)', [style.id, style.production[0].id, JSON.stringify(details), reason])
  }
  legacyCatalog = (await query("select * from public.operation_catalogs where kind='label' order by id limit 1")).rows[0]
  await query('select public.save_style_operation($1,$2,$3,0,$4::jsonb,$5)', [legacyOperationId, styles[0].id, 'label', JSON.stringify({ rows: [work(legacyCatalog, legacyRowId)], note: '', voided: false }), reason])
  await manual(styles[0], 'label', legacyRowId, 88); await manual(styles[0], 'quality', '아우터', 450)
  // A pre-existing closed product ledger is independent from later inspection invoices.
  await owner(`insert into public.production_runs(id,style_id,line_id,project_id,name,project_code,unit_cost,item_type,order_quantities,round,version,factory_id_snapshot,owner_id_snapshot,style_code_snapshot,factory_name_snapshot,owner_name_snapshot,closed_at,snapshot,updated_by)
    values($1,$2,$3,$4,'기존 제품 마감','HQ-BUDGET',12500,'product',$5::jsonb,1,2,$6,$7,'QAQUOTE0','기존 공장','본사 담당자',now(),'{"netAmount":1250000,"vatAmount":125000,"grossAmount":1375000}', $7)`, [closedRun, styles[0].id, styles[0].production[0].id, styles[0].projectId, JSON.stringify(styles[0].production[0].order), DEMO_IDS.china, DEMO_IDS.admin])
  beforeMigration = await business(); await db.exec('reset role'); await db.exec(migration); await as(DEMO_IDS.admin)
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('021 실제 PostgreSQL 업체별 작업·기본 단가', () => {
  it('설치 시 기존 생산·PO·승인·입고·마감 데이터와 수동 단가를 보존한다', async () => {
    expect(await business()).toEqual(beforeMigration)
    const saved = await prices(styles[0]); expect(saved.map(row => Number(row.unit_cost)).sort((a, b) => a - b)).toEqual([88, 450])
    expect(saved.every(row => row.supplier_factory_id === null && row.master_rate_version === null)).toBe(true)
    expect((await query('select * from public.supplier_work_rates')).rows).toEqual([])
  })
  it('본사와 자기 업체는 작업·사양·단가를 저장하고 다른 업체의 비공개 마스터는 조회·수정하지 못한다', async () => isolated(async () => {
    const first = await master(); const other = await master(crypto.randomUUID(), vendors.other)
    await as(actors.label); expect((await query('select * from public.operation_catalogs')).rows.map(row => row.id)).toEqual([first.id])
    expect((await query('select * from public.supplier_work_rates')).rows.map(row => row.factory_id)).toEqual([vendors.label])
    expect((await query('select * from public.supplier_work_rate_audits')).rows).toHaveLength(1)
    expect((await query('select * from public.supplier_work_item_audits')).rows).toHaveLength(1)
    await master(first.id, vendors.label, 'label', 130, 1, 1)
    await expect(rate(vendors.other, 'label', other.id, 999, 1)).rejects.toThrow(/FORBIDDEN/)
    await expect(query("update public.supplier_work_rates set unit_cost=999")).rejects.toThrow(/permission denied/)
    await expect(query("update public.operation_catalogs set specification='우회 수정'")).rejects.toThrow(/permission denied/)
    await as(DEMO_IDS.internal); expect((await query('select * from public.supplier_work_rates')).rows).toHaveLength(2)
    await rate(vendors.other, 'label', other.id, 150, 1)
  }))
  it('미승인·비활성·생산 업체·익명은 마스터를 우회할 수 없고 검사 업체도 자기 품질 단가만 본다', async () => isolated(async () => {
    const catalog = await master(); await rate(vendors.able, 'quality', '아우터', 500); await rate(vendors.kotiti, 'quality', '아우터', 600)
    for (const actor of [DEMO_IDS.factory, fixture.profiles.find(row => !row.approved)!.id]) {
      await as(actor); expect((await query('select * from public.supplier_work_rates')).rows).toEqual([])
      await expect(rate(vendors.label, 'label', catalog.id, 200, 1)).rejects.toThrow(/FORBIDDEN/)
    }
    await as(actors.able); expect((await query('select * from public.supplier_work_rates')).rows.map(row => row.factory_id)).toEqual([vendors.able])
    await rate(vendors.able, 'quality', '아우터', 550, 1)
    await expect(rate(vendors.kotiti, 'quality', '아우터', 900, 1)).rejects.toThrow(/FORBIDDEN/)
    await owner('update public.profiles set active=false where id=$1', [actors.label]); await as(actors.label)
    expect((await query('select * from public.supplier_work_rates')).rows).toEqual([])
    await expect(rate(vendors.label, 'label', catalog.id, 900, 1)).rejects.toThrow(/FORBIDDEN/)
    await as(null, 'anon'); await expect(query('select * from public.supplier_work_rates')).rejects.toThrow(/permission denied/)
    await expect(query('select public.get_supplier_work_rates_capability()')).rejects.toThrow(/permission denied/)
  }))
  it('동일 작업명은 업체별로 구분하고 다른 업체·업무로 정체성을 이동시키지 못한다', async () => isolated(async () => {
    const first = await master(), second = await master(crypto.randomUUID(), vendors.other)
    expect(first.name).toBe(second.name)
    await expect(master(crypto.randomUUID())).rejects.toThrow(/duplicate key/)
    await expect(master(first.id, vendors.other, 'label', 150, 1, 1)).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(master(crypto.randomUUID(), vendors.label, 'embroidery')).rejects.toThrow(/FORBIDDEN/)
    await expect(rate(vendors.able, 'quality', '임의 품목', 100)).rejects.toThrow(/INVALID_SUPPLIER_WORK_ITEM/)
  }))
  it('작업·단가 CAS와 유효성 검사 실패 시 카탈로그와 이력을 원자적으로 롤백한다', async () => isolated(async () => {
    const catalog = await master()
    await expect(master(catalog.id, vendors.label, 'label', 140, 1, 0, '새 이름')).rejects.toThrow(/VERSION_CONFLICT/)
    expect((await query('select * from public.operation_catalogs where id=$1', [catalog.id])).rows[0]).toEqual(catalog)
    expect((await query('select * from public.supplier_work_item_audits')).rows).toHaveLength(1)
    for (const cost of [-1, 0.001, 1000000001, '100']) await expect(rate(vendors.label, 'label', catalog.id, cost, 1)).rejects.toThrow(/INVALID_PROCESSING_PRICE/)
    await expect(rate(vendors.label, 'label', catalog.id, 200, 0)).rejects.toThrow(/VERSION_CONFLICT/)
    expect((await rate(vendors.label, 'label', catalog.id, 0, 1)).unit_cost).toBe('0')
    expect((await rate(vendors.label, 'label', catalog.id, null, 2)).unit_cost).toBeNull()
  }))
  it('처음 저장한 업체 작업·사양은 다음 스타일에서 재사용되고 단가는 컬러별 견적으로 저장된다', async () => isolated(async () => {
    const catalog = await master(), row = work(catalog), saved = await job(catalog, styles[1], [row])
    expect(saved.rows_data[0]).toMatchObject({ name: catalog.name, specification: catalog.specification })
    const quotes = await prices(); expect(quotes).toHaveLength(2)
    expect(quotes.every(quote => Number(quote.unit_cost) === 120 && quote.supplier_factory_id === vendors.label && quote.master_rate_version === 1 && quote.supplier_catalog_id === catalog.id)).toBe(true)
    expect((await query('select * from public.processing_unit_price_audits where style_id=$1', [styles[1].id])).rows).toHaveLength(2)
    await job(catalog, styles[2]); expect((await prices(styles[2]))).toHaveLength(2)
  }))
  it('마스터 가격 인상은 새 작업에만 적용되고 기존 견적·수동 단가·작업명·제품 마감을 덮어쓰지 않는다', async () => isolated(async () => {
    const catalog = await master(), row = work(catalog), saved = await job(catalog, styles[1], [row])
    await manual(styles[1], 'label', row.id, 77, 1)
    const before = await business(), old = await prices()
    const changed = await master(catalog.id, vendors.label, 'label', 200, 1, 1, '새 라벨명', '새 사양')
    const updated = await job(changed, styles[1], [row], saved.id, 1)
    expect(updated.rows_data[0].name).toBe(catalog.name); expect(await prices()).toEqual(old)
    await job(changed, styles[2]); expect((await prices(styles[2])).every(quote => Number(quote.unit_cost) === 200 && quote.master_rate_version === 2)).toBe(true)
    expect(await business()).toEqual(before)
  }))
  it('오래된 카탈로그·다른 업체·수량 오류는 작업과 자동 단가를 함께 저장하지 않는다', async () => isolated(async () => {
    const catalog = await master(), other = await master(crypto.randomUUID(), vendors.other)
    await expect(job(catalog, styles[1], [work(catalog)], crypto.randomUUID(), 0, vendors.label, { [catalog.id]: 99 })).rejects.toThrow(/VERSION_CONFLICT/)
    await expect(job(other)).rejects.toThrow(/INVALID_SUPPLIER_WORK_ITEM/)
    await expect(job(catalog, styles[1], [{ ...work(catalog), quantity: -1 }])).rejects.toThrow(/INVALID_QUANTITIES/)
    await expect(job(catalog, styles[1], [work(catalog)], legacyOperationId)).rejects.toThrow(/HISTORY_PROTECTED/)
    expect((await query('select * from public.style_operations where style_id=$1', [styles[1].id])).rows).toEqual([])
    expect(await prices()).toEqual([])
  }))
  it('기존 작업 저장은 뒤늦게 생긴 빈 견적을 최신 마스터 단가로 자동 채우지 않는다', async () => isolated(async () => {
    const catalog = await master(), row = work(catalog)
    await owner("update public.styles set data=jsonb_set(data,'{production,0,paymentStatus}','\"done\"'::jsonb) where id=$1", [styles[1].id])
    const saved = await job(catalog, styles[1], [row]); expect(await prices()).toHaveLength(1)
    await owner("update public.styles set data=jsonb_set(data,'{production,0,paymentStatus}','\"todo\"'::jsonb) where id=$1", [styles[1].id])
    await rate(vendors.label, 'label', catalog.id, 999, 1)
    await job(catalog, styles[1], [row], saved.id, 1)
    const quotes = await prices(); expect(quotes).toHaveLength(1)
    expect(quotes[0]).toMatchObject({ line_id: styles[1].production[1].id, unit_cost: '120', master_rate_version: 1 })
  }))
  it('과거 작업 행을 다른 업체 가격으로 재사용하지 않고 새 행으로만 업체를 변경한다', async () => isolated(async () => {
    const catalog = await master(), other = await master(crypto.randomUUID(), vendors.other), row = work(catalog), saved = await job(catalog, styles[1], [row])
    const old = await prices()
    await expect(job(other, styles[1], [work(other, row.id)], saved.id, 1, vendors.other)).rejects.toThrow(/SUPPLIER_PRICE_SCOPE_CHANGED/)
    await job(other, styles[1], [work(other)], saved.id, 1, vendors.other)
    const quotes = await prices(); expect(quotes).toHaveLength(4)
    expect(quotes.filter(quote => quote.supplier_factory_id === vendors.label)).toEqual(old)
    await expect(query('select public.save_style_operation($1,$2,$3,2,$4::jsonb,$5)', [saved.id, styles[1].id, 'label', JSON.stringify({ rows: [row], note: '', voided: false }), reason])).rejects.toThrow(/SUPPLIER_REQUIRED/)
  }))
  it('이전 전역 카탈로그·수동 단가는 그대로 저장하고 업체 마스터를 억지로 적용하지 않는다', async () => isolated(async () => {
    const row = work(legacyCatalog, legacyRowId)
    await query('select public.save_style_operation($1,$2,$3,1,$4::jsonb,$5)', [legacyOperationId, styles[0].id, 'label', JSON.stringify({ rows: [row], note: '이전 기록 편집', voided: false }), reason])
    await as(DEMO_IDS.factory); const edited = await manual(styles[0], 'label', legacyRowId, 99, 1)
    expect(edited.supplier_factory_id).toBeNull(); expect(Number(edited.unit_cost)).toBe(99)
    expect((await prices(styles[0])).find(quote => quote.kind === 'quality')!.unit_cost).toBe('450')
  }))
  it('검사 배정 전·다른 업체·품목·오래된 배정 및 단가 버전으로 기본 단가를 적용하지 못한다', async () => isolated(async () => {
    await rate(vendors.able, 'quality', '아우터', 500)
    await expect(apply()).rejects.toThrow(/FORBIDDEN/); await assign('able')
    await expect(apply(vendors.kotiti)).rejects.toThrow(/FORBIDDEN/)
    await expect(apply(vendors.able, 0)).rejects.toThrow(/VERSION_CONFLICT/)
    await expect(apply(vendors.able, 1, 1)).rejects.toThrow(/VERSION_CONFLICT/)
    await expect(apply(vendors.able, 1, 0, styles[1], '모자')).rejects.toThrow(/INVALID_PROCESSING_PRICE/)
    await as(actors.able); await expect(apply()).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.factory); await expect(apply()).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.internal); const quote = await apply(); expect(quote.supplier_factory_id).toBe(vendors.able)
  }))
  it('검사 업체 재배정은 본사의 명시적 적용으로 새 견적을 만들며 이전 업체·단가를 비공개 이력에 보존한다', async () => isolated(async () => {
    await rate(vendors.able, 'quality', '아우터', 500); await rate(vendors.kotiti, 'quality', '아우터', 650)
    await assign('able'); await apply(); const before = await manual(styles[1], 'quality', '아우터', 480, 1)
    await rate(vendors.able, 'quality', '아우터', 700, 1)
    expect(await apply(vendors.able, 1, 2)).toEqual(before)
    await assign('kotiti', 1); expect((await prices())[0]).toEqual(before)
    const quote = await apply(vendors.kotiti, 2, 2); expect(quote).toMatchObject({ supplier_factory_id: vendors.kotiti, unit_cost: '650', version: 3 })
    const audit = (await query("select * from public.processing_unit_price_audits where style_id=$1 and kind='quality' order by created_at", [styles[1].id])).rows.at(-1)!
    expect(audit.before).toMatchObject({ supplier_factory_id: vendors.able, unit_cost: 480 }); expect(audit.after).toMatchObject({ supplier_factory_id: vendors.kotiti, unit_cost: 650 })
    await as(actors.able); expect((await query('select * from public.processing_unit_prices')).rows).toEqual([])
    expect((await query('select * from public.processing_unit_price_audits')).rows).toEqual([])
  }))
  it('본사 명시적 적용은 업체가 미상인 기존 견적을 새 배정 업체로 전환해도 제품 마감 금액을 변경하지 않는다', async () => isolated(async () => {
    await rate(vendors.able, 'quality', '아우터', 520); await assign('able', 0, styles[0])
    const before = await business(), quote = await apply(vendors.able, 1, 1, styles[0])
    expect(quote).toMatchObject({ unit_cost: '520', supplier_factory_id: vendors.able, version: 2 })
    expect(await business()).toEqual(before)
    const audit = (await query("select * from public.processing_unit_price_audits where style_id=$1 and kind='quality' order by created_at", [styles[0].id])).rows.at(-1)!
    expect(audit.before).toMatchObject({ supplier_factory_id: null, unit_cost: 450 })
  }))
  it('결제 완료된 컬러는 자동 가격 추가·다른 검사 견적 덮어쓰기를 막는다', async () => isolated(async () => {
    const catalog = await master(); await rate(vendors.able, 'quality', '아우터', 500); await rate(vendors.kotiti, 'quality', '아우터', 600)
    await assign('able'); await apply(); await assign('kotiti', 1)
    await owner("update public.styles set data=jsonb_set(data,'{production,0,paymentStatus}','\"done\"'::jsonb) where id=$1", [styles[1].id])
    await expect(apply(vendors.kotiti, 2, 1)).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(manual(styles[1], 'quality', '아우터', 700, 1)).rejects.toThrow(/HISTORY_PROTECTED/)
    await job(catalog); const quotes = await prices()
    expect(quotes.filter(quote => quote.kind === 'label').map(quote => quote.line_id)).toEqual([styles[1].production[1].id])
    expect(quotes.find(quote => quote.kind === 'quality')).toMatchObject({ supplier_factory_id: vendors.able, unit_cost: '500', version: 1 })
  }))
  it('마스터 이력 직접 수정·삭제와 이전 별칭 RPC를 통한 우회를 거부한다', async () => isolated(async () => {
    await master()
    await expect(owner("update public.supplier_work_rate_audits set reason='변조'")).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(owner('delete from public.supplier_work_item_audits')).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(query('select public.save_processing_unit_price_before_supplier_021($1,$2,$3,$4,$5::jsonb,1,$6)', [styles[0].id, styles[0].production[0].id, 'label', legacyRowId, '999', reason])).rejects.toThrow(/permission denied/)
  }))
  it('021 재실행은 마스터·견적·업무 원본과 이력을 보존한다', async () => {
    await as(DEMO_IDS.admin); const catalog = await master(); await job(catalog)
    const before = await business(), rates = (await query('select * from public.supplier_work_rates order by factory_id,kind,item_key')).rows, quotes = await prices()
    const audits = (await query('select * from public.supplier_work_rate_audits order by id')).rows
    await db.exec('reset role'); await db.exec(migration); await as(DEMO_IDS.admin)
    expect(await business()).toEqual(before); expect(await prices()).toEqual(quotes)
    expect((await query('select * from public.supplier_work_rates order by factory_id,kind,item_key')).rows).toEqual(rates)
    expect((await query('select * from public.supplier_work_rate_audits order by id')).rows).toEqual(audits)
    await as(actors.label); expect((await query('select * from public.supplier_work_rates')).rows).toHaveLength(1)
  })
})
