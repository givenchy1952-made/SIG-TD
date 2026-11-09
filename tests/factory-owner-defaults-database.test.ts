import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import type { Style } from '../src/lib/types'

const db = new PGlite(), seed = createSeed({ includeFinance: true }), style = structuredClone(seed.styles.find(row => row.production.length)!)
const migration = readFileSync(new URL('../supabase/migrations/027_factory_owner_defaults.sql', import.meta.url), 'utf8')
const internal = seed.profiles.find(person => person.id === DEMO_IDS.internal)!, admin = seed.profiles.find(person => person.id === DEMO_IDS.admin)!
let transaction = false, sequence = 0
async function query<T = Record<string, any>>(sql: string, values: unknown[] = []) {
  if (!transaction) return db.query<T>(sql, values)
  const savepoint = `factory_owner_${sequence++}`; await db.exec(`savepoint ${savepoint}`)
  try { const result = await db.query<T>(sql, values); await db.exec(`release savepoint ${savepoint}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${savepoint};release savepoint ${savepoint}`); throw error }
}
async function as(id: string) { await db.exec('reset role;set role authenticated'); await query("select set_config('request.jwt.claim.sub',$1,false)", [id]) }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await as(admin.id); await fn() } finally { transaction = false; await db.exec('rollback') } }
async function owner(sql: string, values: unknown[] = []) { await db.exec('reset role'); try { return await query(sql, values) } finally { await as(admin.id) } }
async function assignment(employeeId: string, factories: string[], version = 0) { return (await query('select to_jsonb(public.save_employee_factory_assignment($1,$2,$3,$4)) value', [employeeId, factories, version, '공장 담당자 배정 검증'])).rows[0].value }
async function currentStyle() { return (await query('select data from public.styles where id=$1', [style.id])).rows[0].data as Style }
async function save(value: Style, expected = value.version) { return (await query('select to_jsonb(public.save_style($1,$2::jsonb,$3,$4)) value', [value.id, JSON.stringify(value), expected, '스타일 담당자 기본 연결'])).rows[0].value }
async function newRun() {
  const input = { name: '담당자 기본값 검증', projectId: style.projectId, projectCode: 'SIGNIFICANT-2026FY-RPQ-99027', expectedDue: '', poId: null, unitCost: null, itemType: 'product', order: style.production[0].order, correctsRunId: null }
  return (await query('select to_jsonb(public.save_production_run($1,$2,$3,$4::jsonb,0,$5)) value', [crypto.randomUUID(), style.id, style.production[0].id, JSON.stringify(input), '공장 담당자 차수 연결'])).rows[0].value
}

beforeAll(async () => {
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create schema storage;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,last_accessed_at timestamptz,unique(bucket_id,name));alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;grant select,insert,update,delete on storage.objects to authenticated;`)
  for (const name of readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 26).sort()) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  await db.exec(migration)
  for (const factory of seed.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [factory.id, factory.name, factory.country])
  for (const project of seed.projects.filter(item => item.id === style.projectId)) await query('insert into public.projects(id,name,season,code) values($1,$2,$3,$4)', [project.id, project.name, project.season, 'SIGNIFICANT-2026FY-RPQ-99027'])
  for (const person of seed.profiles) {
    await query('insert into auth.users(id,email) values($1,$2)', [person.id, person.email])
    await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [person.id, person.name, person.role, person.approved, person.active, person.id === DEMO_IDS.factory ? style.factoryId : person.factoryId])
  }
  style.version = 0; style.ownerId = admin.id; style.production = [style.production[0]]; style.colors = [style.production[0].color]
  style.production[0].ownerId = admin.id
  await as(admin.id); await save(style, 0)
}, 60000)
afterAll(async () => { await db.close() })

describe.sequential('027 담당 공장 배정과 현재 스타일 본사 담당자 연결', () => {
  it('배정 한 번으로 현재 스타일과 컬러가 바뀌며 정상 버전·감사 이력을 보존한다', async () => isolated(async () => {
    const before = await currentStyle(), assignmentRow = await assignment(internal.id, [style.factoryId]), after = await currentStyle()
    expect(assignmentRow.employee_id).toBe(internal.id)
    expect(after.ownerId).toBe(internal.id); expect(after.production[0].ownerId).toBe(internal.id)
    expect(after.version).toBe(before.version + 1)
    expect(after.production[0].order).toEqual(before.production[0].order); expect(after.production[0].received).toEqual(before.production[0].received)
    const audit = (await query('select before,after from public.audits where style_id=$1 order by created_at desc,id desc', [style.id])).rows.find(row => row.after.ownerId === internal.id)
    expect(audit?.before.ownerId).toBe(admin.id)
    await assignment(internal.id, [style.factoryId], 1)
    expect((await currentStyle()).version).toBe(after.version)
  }))
  it('공장 담당자가 유일하면 새 스타일 저장에도 입력한 다른 본사 담당자 대신 자동 연결한다', async () => isolated(async () => {
    await assignment(internal.id, [style.factoryId])
    const value = await currentStyle();value.id = crypto.randomUUID();value.code = 'QA_OWNER_002';value.version = 0;value.ownerId = admin.id
    value.production[0].id = crypto.randomUUID();value.production[0].ownerId = admin.id
    const result = await save(value, 0)
    expect(result.data.ownerId).toBe(internal.id);expect(result.data.production[0].ownerId).toBe(internal.id)
    expect((await query('select after from public.audits where style_id=$1', [value.id])).rows[0].after.ownerId).toBe(internal.id)
  }))
  it('복수·미배정 공장은 기존 명시값을 유지하며 비활성 후보는 자동 연결하지 않는다', async () => isolated(async () => {
    await assignment(admin.id, [style.factoryId]);await assignment(internal.id, [style.factoryId])
    expect((await currentStyle()).ownerId).toBe(admin.id)
    await assignment(internal.id, [], 1);expect((await currentStyle()).ownerId).toBe(admin.id)
    await owner('update public.profiles set active=false where id=$1', [internal.id])
    await owner('update public.employee_factory_assignments set factory_ids=$2 where employee_id=$1', [internal.id, [style.factoryId]])
    const value = await currentStyle();expect((await save(value)).data.ownerId).toBe(admin.id)
  }))
  it('새 생산 차수는 공장 담당자를 스냅샷에 기록하고 기존 차수·확정 스냅샷은 바꾸지 않는다', async () => isolated(async () => {
    const earlier = await newRun()
    const frozenId = crypto.randomUUID()
    await owner(`insert into public.production_runs(id,style_id,line_id,project_id,name,project_code,unit_cost,item_type,order_quantities,round,version,factory_id_snapshot,owner_id_snapshot,style_code_snapshot,factory_name_snapshot,owner_name_snapshot,closed_at,snapshot,updated_by)
      values($1,$2,$3,$4,'확정 과거 차수','SIGNIFICANT-2026FY-RPQ-99027',100,'product',$5::jsonb,99,1,$6,$7,'QA_FINAL_BK','과거 공장','과거 담당',now(),$8::jsonb,$7)`, [frozenId, style.id, style.production[0].id, style.projectId, JSON.stringify(style.production[0].order), style.factoryId, admin.id, JSON.stringify({ ownerIdSnapshot: admin.id, ownerNameSnapshot: '과거 담당', netAmount: 123 })])
    const before = (await query('select * from public.production_runs order by id')).rows
    await assignment(internal.id, [style.factoryId])
    expect((await query('select * from public.production_runs order by id')).rows).toEqual(before)
    const next = await newRun()
    expect(earlier.owner_id_snapshot).toBe(admin.id);expect(next.owner_id_snapshot).toBe(internal.id);expect(next.owner_name_snapshot).toBe(internal.name)
  }))
  it('공장·FA·미승인 계정은 배정을 변경할 수 없으며 이전 내부 함수도 직접 부를 수 없다', async () => isolated(async () => {
    for (const person of [seed.profiles.find(person => person.id === DEMO_IDS.factory)!, seed.profiles.find(person => person.role === 'finance')!, seed.profiles.find(person => !person.approved)!]) {
      await as(person.id);await expect(assignment(internal.id, [style.factoryId])).rejects.toThrow(/FORBIDDEN/)
      await expect(query('select public.unique_factory_owner($1)', [style.factoryId])).rejects.toThrow(/permission denied/)
      await expect(query('select public.save_style_before_factory_defaults($1,$2::jsonb,1,$3)', [style.id, JSON.stringify(style), '우회 저장 시도'])).rejects.toThrow(/permission denied/)
    }
  }))
  it('기존 본사 직원의 배정 권한 범위와 버전 충돌·잘못된 필드 검증을 유지한다', async () => isolated(async () => {
    await as(internal.id);await expect(assignment(admin.id, [style.factoryId])).rejects.toThrow(/FORBIDDEN/)
    await assignment(internal.id, [style.factoryId]);await expect(assignment(internal.id, [], 0)).rejects.toThrow(/VERSION_CONFLICT/)
    const value = await currentStyle();value.ownerId = 'invalid-owner'
    await expect(save(value)).rejects.toThrow(/INVALID_STYLE/)
  }))
  it('재실행은 배정·스타일·차수·감사 이력을 다시 작성하지 않는다', async () => isolated(async () => {
    await assignment(internal.id, [style.factoryId]);await newRun()
    const before = { styles: (await query('select * from public.styles')).rows, runs: (await query('select * from public.production_runs')).rows, audits: (await query('select * from public.audits order by id')).rows }
    await db.exec('reset role');await db.exec(migration.replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, ''));await as(admin.id)
    expect({ styles: (await query('select * from public.styles')).rows, runs: (await query('select * from public.production_runs')).rows, audits: (await query('select * from public.audits order by id')).rows }).toEqual(before)
  }))
})
