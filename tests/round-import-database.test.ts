import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { existsSync, readFileSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { ORDER_SOURCE_COLUMNS, type OrderSourceData } from '../src/lib/operations-types'
import { emptyQuantities } from '../src/lib/types'

const db = new PGlite(), fixture = createSeed(), style = structuredClone(fixture.styles[0]), line = style.production[0]
let transaction = false, seq = 0
async function query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  if (!transaction) return db.query<T>(sql, params)
  const point = `round_import_${seq++}`; await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(sql, params); await db.exec(`release savepoint ${point}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await fn() } finally { transaction = false; await db.exec('rollback') } }
function source(projectIndex = 0, expectedVersion = 0) {
  const project = fixture.projects[projectIndex]
  const data: OrderSourceData & { expectedVersion: number } = { expectedVersion, fileName: 'orders.csv', sheetName: 'ORDER QTY', headers: Object.fromEntries(ORDER_SOURCE_COLUMNS.map(column => [column, column])) as OrderSourceData['headers'], rows: [{ rowNumber: 2, columns: { A: `PROJECT-${projectIndex + 1}`, F: 'BP06FYDW0101BK', L: project.season, M: project.name, S: '', V: '', W: '', X: '', Y: '', AQ: 0, AR: 0, AS: 4, AT: 0, AU: 0, AV: 0, AY: 4 } }] }
  return data
}
function changes(projectIndex = 0, expectedStyleVersion = 1, expectedSourceVersion = 0) { return [{ styleId: style.id, expectedVersion: expectedStyleVersion, lines: [{ lineId: line.id, color: line.color, quantities: { ...emptyQuantities(), S: 4 }, source: source(projectIndex, expectedSourceVersion) }] }] }
async function apply(id = crypto.randomUUID(), updates = changes(), mode = 'replace', reason = '프로젝트 생산 차수 업로드') { return query('select public.bulk_import_production_orders($1,$2::jsonb,$3,$4) result', [id, JSON.stringify(updates), mode, reason]) }
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
  for (const name of ['001_initial.sql', '002_style_images.sql', '003_operations.sql', '004_settlement_terms.sql', '005_workflow_refinements.sql', '006_staff_approvals.sql', '007_production_ledger.sql', '008_supplier_acceptance.sql', '009_import_production_runs.sql']) {
    const file = new URL(`../supabase/migrations/${name}`, import.meta.url)
    if (name.startsWith('008_') && !existsSync(file)) continue
    await db.exec(readFileSync(file, 'utf8'))
  }
  for (const item of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [item.id, item.name, item.country])
  for (const [index, item] of fixture.projects.entries()) await query('insert into public.projects(id,name,season,code) values($1,$2,$3,$4)', [item.id, item.name, item.season, `PROJECT-${index + 1}`])
  for (const item of fixture.profiles) {
    await query('insert into auth.users(id,email) values($1,$2)', [item.id, item.email])
    await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [item.id, item.name, item.role, item.approved, item.active, item.factoryId])
  }
  await as(DEMO_IDS.admin); style.version = 0
  await query('select * from public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), '발주 업로드 테스트 스타일'])
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('009 실제 PostgreSQL 프로젝트·생산 차수 오더 업로드', () => {
  it('본사 직원이 수량과 원본을 저장하며 프로젝트별 신규 1차를 만든다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    const result = (await apply()).rows[0].result
    expect(result.runIds).toHaveLength(1)
    expect((await query('select project_id,project_code,round,order_quantities,unit_cost,po_id from public.production_runs')).rows).toEqual([{ project_id: fixture.projects[0].id, project_code: 'PROJECT-1', round: 1, order_quantities: { ...emptyQuantities(), S: 4 }, unit_cost: null, po_id: null }])
    expect((await query('select version from public.styles where id=$1', [style.id])).rows[0].version).toBe(2)
    expect((await query('select version from public.order_source_records')).rows[0].version).toBe(1)
  }))
  it('같은 요청 재시도는 CAS가 바뀐 뒤에도 같은 결과만 반환한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal); const id = crypto.randomUUID(), updates = changes()
    const first = (await apply(id, updates)).rows[0].result
    expect((await apply(id, updates)).rows[0].result).toEqual(first)
    expect((await query('select id from public.production_runs')).rows).toHaveLength(1)
    expect((await query('select version from public.styles where id=$1', [style.id])).rows[0].version).toBe(2)
    await expect(apply(id, updates, 'add')).rejects.toThrow(/IMPORT_ID_REUSED/)
  }))
  it('리오더는 앞 차수를 바꾸지 않고 파일 수량만 새 2차에 저장한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal); await apply()
    const initial = (await query('select * from public.production_runs')).rows[0]
    await apply(crypto.randomUUID(), changes(0, 2, 1), 'add')
    const rows = (await query('select * from public.production_runs order by round')).rows
    expect(rows).toHaveLength(2); expect(rows[0]).toEqual(initial)
    expect(rows[1]).toMatchObject({ round: 2, order_quantities: { ...emptyQuantities(), S: 4 } })
    expect((await query("select data->'production'->0->'order' quantity from public.styles where id=$1", [style.id])).rows[0].quantity.S).toBe(8)
  }))
  it('같은 품번도 다른 프로젝트는 별도 1차가 된다', async () => isolated(async () => {
    await as(DEMO_IDS.internal); await apply()
    await apply(crypto.randomUUID(), changes(1, 2, 1))
    const runs = (await query('select project_id,round from public.production_runs order by project_code')).rows
    expect(runs).toEqual([{ project_id: fixture.projects[0].id, round: 1 }, { project_id: fixture.projects[1].id, round: 1 }])
    expect((await query("select data->>'projectId' id from public.styles where id=$1", [style.id])).rows[0].id).toBe(fixture.projects[0].id)
  }))
  it('알 수 없는 프로젝트와 혼합 프로젝트·명칭 불일치에서는 모든 변경이 롤백된다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    const unknown = changes(); unknown[0].lines[0].source.rows[0].columns.A = 'NOT-REGISTERED'
    await expect(apply(crypto.randomUUID(), unknown)).rejects.toThrow(/IMPORT_PROJECT_REQUIRED/)
    const mixed = changes(); mixed[0].lines[0].source.rows.push({ ...structuredClone(mixed[0].lines[0].source.rows[0]), rowNumber: 3, columns: { ...mixed[0].lines[0].source.rows[0].columns, A: 'PROJECT-2' } })
    await expect(apply(crypto.randomUUID(), mixed)).rejects.toThrow(/IMPORT_MIXED_PROJECTS/)
    const mismatch = changes(); mismatch[0].lines[0].source.rows[0].columns.M = '잘못된 프로젝트'
    await expect(apply(crypto.randomUUID(), mismatch)).rejects.toThrow(/IMPORT_PROJECT_MISMATCH/)
    expect((await query('select id from public.production_runs')).rows).toHaveLength(0)
    expect((await query('select version from public.styles where id=$1', [style.id])).rows[0].version).toBe(1)
  }))
  it('원본/스타일 버전 충돌과 잘못된 수량도 신규 차수·요청 기록을 남기지 않는다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    await expect(apply(crypto.randomUUID(), changes(0, 99))).rejects.toThrow(/VERSION_CONFLICT/)
    const malformed = changes(); malformed[0].lines[0].quantities.S = -1
    await expect(apply(crypto.randomUUID(), malformed)).rejects.toThrow(/INVALID_QUANTITIES/)
    expect((await query('select id from public.production_runs')).rows).toHaveLength(0)
    await db.exec('reset role'); expect((await query('select count(*) count from public.production_order_imports')).rows[0].count).toBe(0)
  }))
  it('공장·미승인·익명은 업로드 및 요청 기록 직접 조회·변경이 차단된다', async () => isolated(async () => {
    await as(DEMO_IDS.factory); await expect(apply()).rejects.toThrow(/FORBIDDEN/)
    await expect(query('select * from public.production_order_imports')).rejects.toThrow(/permission denied/)
    await expect(query('delete from public.production_order_imports')).rejects.toThrow(/permission denied/)
    const pending = fixture.profiles.find(person => !person.approved)!
    await as(pending.id); await expect(apply()).rejects.toThrow(/FORBIDDEN/)
    await as(null, 'anon'); await expect(apply()).rejects.toThrow(/permission denied/)
  }))
})
