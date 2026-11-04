import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'

const db = new PGlite(), fixture = createSeed(), migration = new URL('../supabase/migrations/019_production_project_names.sql', import.meta.url)
const projects = fixture.projects.map((p, i) => ({ ...p, code: `QA-BUDGET-${i + 1}`, name: i === 1 ? '기존 공식 명칭' : `QA-BUDGET-${i + 1}`, season: i === 2 ? '2027FY' : '2026FY' }))
const styles = projects.map((p, i) => ({ ...structuredClone(fixture.styles[1]), id: crypto.randomUUID(), projectId: p.id, factoryId: i === 1 ? DEMO_IDS.vietnam : DEMO_IDS.china, code: `QAPROJECTION${i}`, season: p.season || '2027FY', version: 0 }))
const names = ['시그니피컨트 2026 3Q', '오더 원본의 다른 명칭', '시그니피컨트 2027 1Q']
let transaction = false, sequence = 0, beforeMigration: unknown
async function query<T = Record<string, any>>(sql: string, values: unknown[] = []) {
  if (!transaction) return db.query<T>(sql, values)
  const point = `project_names_${sequence++}`; await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(sql, values); await db.exec(`release savepoint ${point}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function owner(sql: string, values: unknown[] = []) { await db.exec('reset role'); try { return await query(sql, values) } finally { await as(DEMO_IDS.admin) } }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await as(DEMO_IDS.admin); await fn() } finally { transaction = false; await db.exec('rollback') } }
async function list() { return (await query<{ value: { projectId: string; name: string; season: string } }>('select public.get_production_project_names() value')).rows.map(row => row.value) }
async function business() {
  const result: Record<string, unknown> = {}
  for (const table of ['projects', 'styles', 'profiles', 'order_source_records', 'po_dispatches', 'po_dispatch_attempts', 'production_runs', 'production_receipts', 'production_conditions', 'production_condition_proposals', 'production_condition_approvals', 'production_partial_delivery_plans', 'audits']) result[table] = (await owner(`select to_jsonb(t) value from public.${table} t order by to_jsonb(t)::text`)).rows
  return result
}
function source(i: number, override: Record<string, unknown> = {}) { return [{ rowNumber: 2, columns: { A: projects[i].code, M: names[i], L: projects[i].season || '2027FY', ...override } }] }
async function sources(i: number, rows: unknown) { await owner('update public.order_source_records set rows_data=$2::jsonb where style_id=$1', [styles[i].id, JSON.stringify(rows)]) }

beforeAll(async () => {
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create schema storage;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,last_accessed_at timestamptz,unique(bucket_id,name));alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;grant select,insert,update,delete on storage.objects to authenticated;`)
  for (const name of readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(name => /^0(?:0[1-9]|1[0-8])_.*\.sql$/.test(name)).sort()) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const row of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [row.id, row.name, row.country])
  for (const row of projects) await query('insert into public.projects(id,name,season,code) values($1,$2,$3,$4)', [row.id, row.name, row.season, row.code])
  for (const row of fixture.profiles) { await query('insert into auth.users(id,email) values($1,$2)', [row.id, row.email]); await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [row.id, row.name, row.role, row.approved, row.active, row.factoryId]) }
  await as(DEMO_IDS.admin)
  for (const [i, target] of styles.entries()) {
    await query('select public.save_style($1,$2::jsonb,0,$3)', [target.id, JSON.stringify(target), '프로젝트 명칭 조회 검증 대상'])
    await owner("insert into public.order_source_records(style_id,line_id,file_name,sheet_name,headers,rows_data,version,updated_by) values($1,$2,'가상 원본.csv','CSV','{}',$3::jsonb,1,$4)", [target.id, target.production[0].id, JSON.stringify(source(i)), DEMO_IDS.admin])
  }
  beforeMigration = await business(); await db.exec('reset role'); await db.exec(readFileSync(migration, 'utf8')); await as(DEMO_IDS.admin)
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('019 읽기 전용 생산 명칭과 업체 범위', () => {
  it('적용과 조회가 기존 ID·프로젝트·업무·원본·이력을 변경하지 않는다', async () => {
    expect(await business()).toEqual(beforeMigration)
    const before = await business(); await as(DEMO_IDS.admin); await list(); await as(DEMO_IDS.factory); await list()
    expect(await business()).toEqual(before)
  })
  it('본사는 코드로 저장된 이름만 검증 원본 M/L로 읽고 공식 명칭은 유지한다', async () => isolated(async () => {
    expect(await list()).toEqual([
      { projectId: projects[0].id, name: names[0], season: '2026FY' },
      { projectId: projects[1].id, name: '기존 공식 명칭', season: '2026FY' },
      { projectId: projects[2].id, name: names[2], season: '2027FY' },
    ])
  }))
  it('예전 공백 시즌은 같은 ID의 검증된 L열로 표시하되 저장 자료는 유지한다', async () => isolated(async () => {
    await owner("update public.projects set season=' ' where id=$1", [projects[2].id])
    const before = await business(); expect((await list())[2].season).toBe('2027FY'); expect(await business()).toEqual(before)
  }))
  it('업체는 원본·A열을 조회하지 않고 배정된 현재 프로젝트의 M명칭만 받는다', async () => isolated(async () => {
    await as(DEMO_IDS.factory)
    expect((await query('select * from public.order_source_records')).rows).toEqual([])
    const rows = await list()
    expect(rows.map(row => row.projectId)).toEqual([projects[0].id, projects[2].id])
    expect(rows[0].name).toBe(names[0])
    expect(rows.every(row => Object.keys(row).sort().join(',') === 'name,projectId,season')).toBe(true)
    expect(JSON.stringify(rows)).not.toContain('QA-BUDGET')
    expect(JSON.stringify(rows)).not.toContain(names[1])
    expect((await query('select public.get_production_project_names($1) value', [projects[0].id])).rows).toEqual([{ value: rows[0] }])
    expect((await query('select public.get_production_project_names($1) value', [projects[1].id])).rows).toEqual([])
  }))
  it('공장 재배정·삭제 후 이전 업체에 프로젝트 명칭을 남겨 노출하지 않는다', async () => isolated(async () => {
    await owner("update public.styles set data=jsonb_set(data,'{factoryId}',to_jsonb($2::text)) where id=$1", [styles[0].id, DEMO_IDS.vietnam])
    await owner('update public.styles set deleted_at=clock_timestamp() where id=$1', [styles[2].id])
    await as(DEMO_IDS.factory); expect(await list()).toEqual([])
  }))
  it('미승인·비활성·로그아웃 계정은 명칭을 받지 않는다', async () => isolated(async () => {
    await as(fixture.profiles.find(p => !p.approved)!.id); expect(await list()).toEqual([])
    await owner('update public.profiles set active=false where id=$1', [DEMO_IDS.factory]); await as(DEMO_IDS.factory); expect(await list()).toEqual([])
    await as(null); expect(await list()).toEqual([])
    await as(null, 'anon'); await expect(list()).rejects.toThrow(/permission denied/)
  }))
  it.each([
    ['같은 프로젝트 M명칭 충돌', () => [...source(0), ...source(0, { M: '서로 다른 명칭' })]],
    ['A열 연결 불일치', () => source(0, { A: 'OTHER-BUDGET' })],
    ['L열 시즌 불일치', () => source(0, { L: '2027FY' })],
    ['M열 공란', () => source(0, { M: '' })],
    ['M열에 A열 코드 대입', () => source(0, { M: projects[0].code })],
    ['M열에 다른 예산 코드 대입', () => source(0, { M: 'SIGNIFICANT-2026FY-RPQ-12345' })],
    ['잘못된 셀 자료형', () => source(0, { M: ['명칭'] })],
    ['제어문자', () => source(0, { M: '잘못\n명칭' })],
    ['Excel 오류', () => source(0, { M: '#REF!' })],
  ])('%s은 이름을 추측해 복원하지 않는다', async (_label, rows) => isolated(async () => {
    await sources(0, rows()); expect((await list())[0].name).toBe('')
  }))
  it('존재하지 않는 컬러 원본과 다른 프로젝트로 이동한 원본은 근거로 삼지 않는다', async () => isolated(async () => {
    await owner('update public.order_source_records set line_id=$2 where style_id=$1', [styles[0].id, crypto.randomUUID()])
    expect((await list())[0].name).toBe('')
  }))
  it('중복 예산 코드가 다른 ID에 있으면 기존 ID를 임의로 선택하지 않는다', async () => isolated(async () => {
    await owner("update public.projects set code='' where id=$1", [projects[0].id])
    await owner('update public.projects set code=$2 where id=$1', [projects[2].id, projects[0].code])
    expect((await list())[0].name).toBe('')
  }))
  it('등록 이름이 Excel 오류이면 생산 명칭으로 쓰지 않는다', async () => isolated(async () => {
    await owner("update public.projects set name='#REF!' where id=$1", [projects[1].id])
    expect((await list())[1].name).toBe('')
  }))
  it('019 재실행도 원본 업무와 표시 결과를 그대로 보존한다', async () => {
    await as(DEMO_IDS.admin); const before = await business(), namesBefore = await list()
    await db.exec('reset role'); await db.exec(readFileSync(migration, 'utf8')); await as(DEMO_IDS.admin)
    expect(await list()).toEqual(namesBefore); expect(await business()).toEqual(before)
  })
})
