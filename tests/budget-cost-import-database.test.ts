import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import type { BudgetCostData } from '../src/lib/budget-types'
import type { BudgetCostImportRequest, BudgetCostImportWriteRow } from '../src/lib/budget-cost-import-types'

const db = new PGlite(), fixture = createSeed(), finance = crypto.randomUUID()
const project = { ...fixture.projects[0], code: 'SIGNIFICANT-2027FY-RPQ-99001', name: '원가 자동 연결 검증', season: '2027FY' }
const style = structuredClone(fixture.styles[1]), sku = 'BP07FYKT0703BK', reason = '원가 파일 수량·단가 연결 검증'
let transaction = false, sequence = 0
async function query<T = Record<string, any>>(sql: string, values: unknown[] = []) {
  if (!transaction) return db.query<T>(sql, values)
  const point = `cost_import_${sequence++}`; await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(sql, values); await db.exec(`release savepoint ${point}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await as(DEMO_IDS.admin); await fn() } finally { transaction = false; await db.exec('rollback') } }
async function owner(sql: string, values: unknown[] = []) { await db.exec('reset role'); try { return await query(sql, values) } finally { await as(DEMO_IDS.admin) } }
function cost(overrides: Partial<BudgetCostData> = {}): BudgetCostData { return { projectId: project.id, budgetCode: project.code + sku, styleCode: sku, supplierId: fixture.factories[0].id, supplierName: '원가 공급사', stage: 'pre', category: '원단', description: '업로드 원가', position: '', specification: '', itemName: '명시 품명', composition: '', color: 'BK', unitCost: 12.34, variableUnitCost: null, consumption: 0.125, unit: 'YDS', amount: 1.5425, voided: false, ...overrides } }
function row(number = 16, fileName = 'cost.xlsx', hash = 'a'.repeat(64), overrides: Partial<BudgetCostImportWriteRow> = {}): BudgetCostImportWriteRow { return { recordId: crypto.randomUUID(), expectedVersion: 0, projectCode: project.code, styleCode: sku, data: cost(), action: 'insert', source: { fileName, sheetName: '원가', rowNumber: number, sourceKey: JSON.stringify([fileName.normalize('NFKC').trim().toLowerCase().replace(/\.xlsx$/i, ''), '원가', number, project.id, sku]), rowFingerprint: 'f'.repeat(64), contentHash: hash }, ...overrides } }
function request(rows = [row()], id = crypto.randomUUID()): BudgetCostImportRequest { return { importId: id, fileName: rows[0].source.fileName, contentHash: rows[0].source.contentHash, rows } }
async function upload(value: BudgetCostImportRequest) { return (await query('select public.import_budget_cost_rows($1::jsonb,$2) value', [JSON.stringify(value), reason])).rows[0].value }
async function records() { return (await query('select public.get_budget_workspace() value')).rows[0].value.records }
async function metadata() { return (await query('select public.get_budget_cost_imports() value')).rows[0].value }
async function save(id: string, data: BudgetCostData, version: number) { return query("select public.save_budget_record('cost',$1,$2::jsonb,$3,$4)", [id, JSON.stringify(data), version, reason]) }

beforeAll(async () => {
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create schema storage;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,last_accessed_at timestamptz,unique(bucket_id,name));alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;grant select,insert,update,delete on storage.objects to authenticated;`)
  for (const name of readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 25).sort()) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const factory of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [factory.id, factory.name, factory.country])
  await query('insert into public.projects(id,name,season,code) values($1,$2,$3,$4)', [project.id, project.name, project.season, project.code])
  for (const person of [...fixture.profiles, { id: finance, name: 'FA 원가 담당', email: 'finance@example.test', role: 'finance', approved: true, active: true, factoryId: null }]) {
    await query('insert into auth.users(id,email) values($1,$2)', [person.id, person.email]); await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [person.id, person.name, person.role, person.approved, person.active, person.factoryId])
  }
  style.id = crypto.randomUUID();style.code = sku;style.projectId = project.id;style.season = project.season;style.stage = 'production';style.samples = [];style.colors = ['BK'];style.version = 0
  style.production = [style.production[0]];style.production[0].color = 'BK';style.production[0].order = { XXS: 0, XS: 0, S: 0, M: 10, L: 0, XL: 0 };style.production[0].received = { XXS: 0, XS: 0, S: 0, M: 0, L: 0, XL: 0 };style.production[0].shipped = { ...style.production[0].received }
  await as(DEMO_IDS.admin); await query('select public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), reason])
}, 60000)
afterAll(async () => { await db.close() })

describe.sequential('025 원가 파일 일괄 업로드 PostgreSQL', () => {
  it('B/C를 기존 발주에 연결하고 Q×S 소수 여섯 자리까지 저장하며 기존 생산 자료를 보존한다', async () => isolated(async () => {
    const before = (await query('select data,version from public.styles')).rows
    const value = row(), batch = request([value]); value.projectCode += ' '
    expect(await upload(batch)).toEqual({ inserted: 1, updated: 0, skipped: 0 })
    expect((await records())[0]).toMatchObject({ id: value.recordId, data: { amount: 1.5425, unitCost: 12.34, consumption: 0.125 } })
    expect((await metadata()).imports[0]).toMatchObject({ recordId: value.recordId, fileName: 'cost.xlsx', rowNumber: 16 })
    expect((await query('select data,version from public.styles')).rows).toEqual(before)
  }))
  it('같은 요청의 네트워크 재시도와 이름만 바꾼 같은 파일은 원가를 중복 생성하지 않는다', async () => isolated(async () => {
    const first = row(), original = request([first])
    expect(await upload(original)).toMatchObject({ inserted: 1 });expect(await upload(original)).toMatchObject({ inserted: 1 })
    expect(await upload(request([row(16, 'renamed.xlsx', first.source.contentHash, { recordId: first.recordId, expectedVersion: 1, action: 'skip' })]))).toEqual({ inserted: 0, updated: 0, skipped: 1 })
    expect(await records()).toHaveLength(1);expect((await metadata()).imports).toHaveLength(1)
    expect((await query('select * from public.budget_record_audits')).rows).toHaveLength(1)
    await expect(upload({ ...original, fileName: 'other.xlsx' })).rejects.toThrow(/VERSION_CONFLICT/)
    await expect(query('select public.import_budget_cost_rows($1::jsonb,$2)', [JSON.stringify(original), '다른 재시도 사유'])).rejects.toThrow(/VERSION_CONFLICT/)
  }))
  it('동일 파일의 수정 행만 갱신하고 미변경 행의 새 파일 지문도 보존한다', async () => isolated(async () => {
    const first = row(), second = row(17);await upload(request([first, second]))
    const hash = 'b'.repeat(64), updated = row(16, 'cost.xlsx', hash, { recordId: first.recordId, expectedVersion: 1, action: 'update', data: cost({ unitCost: 14, consumption: 0.25, amount: 3.5 }) }), unchanged = row(17, 'cost.xlsx', hash, { recordId: second.recordId, expectedVersion: 1, action: 'skip' })
    expect(await upload(request([updated, unchanged]))).toEqual({ inserted: 0, updated: 1, skipped: 1 })
    const current = await records();expect(current.find((item: { id: string }) => item.id === first.recordId)).toMatchObject({ version: 2, data: { amount: 3.5 } });expect(current.find((item: { id: string }) => item.id === second.recordId).version).toBe(1)
    expect((await metadata()).imports.every((item: { contentHash: string }) => item.contentHash === hash)).toBe(true)
    const renamed = [row(16, 'copy.xlsx', hash, { recordId: first.recordId, expectedVersion: 2, action: 'skip', data: updated.data }), row(17, 'copy.xlsx', hash, { recordId: second.recordId, expectedVersion: 1, action: 'skip' })]
    expect(await upload(request(renamed))).toEqual({ inserted: 0, updated: 0, skipped: 2 });expect(await records()).toHaveLength(2)
    expect((await metadata()).aliases).toHaveLength(4)
  }))
  it('과거 파일 지문도 현재 원가 버전과 연결하며 버전 충돌이나 다른 원본 덮어쓰기를 차단한다', async () => isolated(async () => {
    const original = row();await upload(request([original]));await upload(request([row(16, 'cost.xlsx', 'b'.repeat(64), { recordId: original.recordId, expectedVersion: 1, action: 'update', data: cost({ amount: 2.5, unitCost: 10, consumption: 0.25 }) })]))
    await expect(upload(request([row(16, 'different.xlsx', 'c'.repeat(64), { recordId: original.recordId, expectedVersion: 2, action: 'update' })]))).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(upload(request([row(16, 'cost.xlsx', 'd'.repeat(64), { recordId: original.recordId, expectedVersion: 1, action: 'update' })]))).rejects.toThrow(/VERSION_CONFLICT/)
    expect(await upload(request([row(16, 'old-version-copy.xlsx', 'a'.repeat(64), { recordId: original.recordId, expectedVersion: 2, action: 'update' })]))).toEqual({ inserted: 0, updated: 1, skipped: 0 })
    expect((await records())[0]).toMatchObject({ version: 3, data: { amount: 1.5425 } })
  }))
  it('이름을 바꾼 후 내용까지 달라진 원본은 같은 좌표의 원가를 중복 생성하지 않는다', async () => isolated(async () => {
    const original = row();await upload(request([original]))
    const renamedChanged = row(16, 'renamed-and-changed.xlsx', 'e'.repeat(64), { data: cost({ unitCost: 10, consumption: 0.25, amount: 2.5 }) })
    await expect(upload(request([renamedChanged]))).rejects.toThrow(/BUDGET_IMPORT_ORIGIN_REQUIRED/)
    expect(await records()).toHaveLength(1);expect((await records())[0].data.amount).toBe(1.5425)
  }))
  it('마지막 행이 잘못되어도 앞 행·원본 연결·이력을 함께 롤백한다', async () => isolated(async () => {
    const good = row(), bad = row(17, 'cost.xlsx', good.source.contentHash, { data: cost({ amount: 999 }) })
    await expect(upload(request([good, bad]))).rejects.toThrow(/Q times S/)
    expect(await records()).toHaveLength(0);expect((await metadata()).imports).toHaveLength(0)
    expect((await query('select * from public.budget_record_audits')).rows).toHaveLength(0)
    expect((await owner('select * from public.budget_cost_import_requests')).rows).toHaveLength(0)
  }))
  it('수동 원가·다른 프로젝트·품번과 조작된 파일 위치를 가져오기로 덮어쓰지 않는다', async () => isolated(async () => {
    const manual = crypto.randomUUID();await save(manual, cost({ amount: 25 }), 0)
    await expect(upload(request([row(16, 'cost.xlsx', 'a'.repeat(64), { recordId: manual, expectedVersion: 1, action: 'update' })]))).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(upload(request([row(16, 'cost.xlsx', 'a'.repeat(64), { projectCode: 'OTHER-PROJECT' })]))).rejects.toThrow(/INVALID_COST_IMPORT/)
    const forged = row();forged.source.sourceKey = JSON.stringify(['cost', '원가', 99, project.id, sku]);await expect(upload(request([forged]))).rejects.toThrow(/source identity/)
    expect(await records()).toHaveLength(1)
  }))
  it('가져온 원가는 이후 직접 수정해도 Q×S를 유지하며 수동 원가의 명시 총액은 계속 허용한다', async () => isolated(async () => {
    const imported = row();await upload(request([imported]))
    await expect(save(imported.recordId, cost({ amount: 999 }), 1)).rejects.toThrow(/Q times S/)
    await save(imported.recordId, cost({ unitCost: 0.25, consumption: 0.125, amount: 0.03125 }), 1)
    const manual = crypto.randomUUID();await save(manual, cost({ amount: 25 }), 0)
    expect((await records()).find((item: { id: string }) => item.id === imported.recordId).data.amount).toBe(0.03125)
    expect((await records()).find((item: { id: string }) => item.id === manual).data.amount).toBe(25)
    await expect(save(manual, cost({ amount: 0.0000001 }), 1)).rejects.toThrow(/precision/)
    await expect(query("select public.save_budget_record('limit',$1,'{\"season\":\"2027FY\",\"amount\":0.123}'::jsonb,0,$2)", [crypto.randomUUID(), reason])).rejects.toThrow(/precision/)
  }))
  it('FA는 원본 연결 정보만 읽으며 업체·미승인 계정의 조회와 모든 가져오기 쓰기는 차단한다', async () => isolated(async () => {
    const batch = request();await upload(batch);await as(finance)
    expect((await query('select public.get_budget_cost_import_capability() value')).rows[0].value).toBe(true);expect((await metadata()).imports).toHaveLength(1)
    await expect(upload(request())).rejects.toThrow(/FORBIDDEN/)
    await expect(query('delete from public.budget_cost_import_rows')).rejects.toThrow(/permission denied/)
    await expect(query('select * from public.budget_cost_import_requests')).rejects.toThrow(/permission denied/)
    await as(DEMO_IDS.factory);expect((await query('select public.get_budget_cost_import_capability() value')).rows[0].value).toBe(false)
    await expect(metadata()).rejects.toThrow(/FORBIDDEN/);await expect(upload(request())).rejects.toThrow(/FORBIDDEN/)
    const pending = fixture.profiles.find(person => !person.approved)!;await as(pending.id);await expect(metadata()).rejects.toThrow(/FORBIDDEN/)
  }))
  it('재실행은 기존 원가·결제·생산 자료와 가져오기 원본을 초기화하지 않는다', async () => isolated(async () => {
    await upload(request());const before = { records: await records(), metadata: await metadata(), styles: (await query('select data,version from public.styles')).rows }
    await db.exec('reset role'); await db.exec(readFileSync(new URL('../supabase/migrations/025_budget_cost_import.sql', import.meta.url), 'utf8').replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '')); await as(DEMO_IDS.admin)
    expect({ records: await records(), metadata: await metadata(), styles: (await query('select data,version from public.styles')).rows }).toEqual(before)
  }))
})
