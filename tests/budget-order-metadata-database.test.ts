import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { ORDER_SOURCE_COLUMNS, type OrderSourceData } from '../src/lib/operations-types'

const db = new PGlite(), fixture = createSeed(), style = structuredClone(fixture.styles[0])
const migration = readFileSync(new URL('../supabase/migrations/024_budget_order_metadata.sql', import.meta.url), 'utf8')
let transaction = false, sequence = 0
async function query<T = Record<string, any>>(sql: string, params: unknown[] = []) {
  if (!transaction) return db.query<T>(sql, params)
  const savepoint = `budget_source_${sequence++}`; await db.exec(`savepoint ${savepoint}`)
  try { const value = await db.query<T>(sql, params); await db.exec(`release savepoint ${savepoint}`); return value }
  catch (failure) { await db.exec(`rollback to savepoint ${savepoint};release savepoint ${savepoint}`); throw failure }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await as(DEMO_IDS.admin); await fn() } finally { transaction = false; await db.exec('rollback') } }
function source(optional = true): OrderSourceData {
  return { fileName: 'qa-order.xlsx', sheetName: 'ORDER QTY', headers: { ...Object.fromEntries(ORDER_SOURCE_COLUMNS.map(column => [column, `원본 ${column}`])), ...(optional ? { K: '브랜드', BH: 'JOOR GB', BZ: 'ADER KOR' } : {}) } as OrderSourceData['headers'], rows: [{ rowNumber: 2, columns: { ...Object.fromEntries(ORDER_SOURCE_COLUMNS.map(column => [column, column === 'F' ? `${style.code}${style.production[0].color}` : null])), ...(optional ? { K: 'QA BRAND', BH: 268, BZ: '3,870' } : {}) } as OrderSourceData['rows'][number]['columns'] }] }
}
async function save(value = source(), version = 0) { return query('select * from public.save_order_source_record($1,$2,$3,$4::jsonb,$5)', [style.id, style.production[0].id, version, JSON.stringify(value), '예산 참조 원본 저장']) }

beforeAll(async () => {
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create schema storage;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;grant select,insert,update,delete on storage.objects to authenticated;`)
  for (const name of ['001_initial.sql', '002_style_images.sql', '003_operations.sql']) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const factory of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [factory.id, factory.name, factory.country])
  for (const project of fixture.projects) await query('insert into public.projects(id,name,season) values($1,$2,$3)', [project.id, project.name, project.season])
  for (const profile of fixture.profiles) {
    await query('insert into auth.users(id,email) values($1,$2)', [profile.id, profile.email])
    await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [profile.id, profile.name, profile.role, profile.approved, profile.active, profile.factoryId])
  }
  await as(DEMO_IDS.admin); style.version = 0
  await query('select public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), '기존 스타일 원본 보존'])
  // Save a historical sixteen-column record before adding the capability.
  await save(source(false)); await db.exec('reset role'); await db.exec(migration); await as(DEMO_IDS.admin)
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('024 선택 예산 열의 PostgreSQL 검증과 호환성', () => {
  it('기존16열 자료를 바꾸지 않고 새19열 원본을 같은 행의 새 버전으로 보존한다', async () => isolated(async () => {
    const beforeStyle = (await query('select data from public.styles where id=$1', [style.id])).rows[0]
    const before = (await query('select * from public.order_source_records')).rows[0]
    expect(Object.keys(before.headers)).toHaveLength(16); expect(before.version).toBe(1)
    const after = (await save(source(), 1)).rows[0]
    expect(after.version).toBe(2); expect(after.headers).toMatchObject({ K: '브랜드', BH: 'JOOR GB', BZ: 'ADER KOR' })
    expect(after.rows_data[0].columns).toMatchObject({ K: 'QA BRAND', BH: 268, BZ: '3,870' })
    expect((await query('select data from public.styles where id=$1', [style.id])).rows[0]).toEqual(beforeStyle)
    await expect(save(source(), 1)).rejects.toThrow(/VERSION_CONFLICT/)
    expect((await save(source(false), 2)).rows[0].version).toBe(3)
  }))
  it('임의열·수식·누락·예산 헤더와 값의 불일치를 저장 전에 거부한다', async () => isolated(async () => {
    for (const alter of [
      (data: OrderSourceData) => { (data.headers as Record<string, unknown>).ZZ = '누출'; (data.rows[0].columns as Record<string, unknown>).ZZ = 1 },
      (data: OrderSourceData) => { delete data.rows[0].columns.BH },
      (data: OrderSourceData) => { delete (data.headers as Partial<OrderSourceData['headers']>).A },
      (data: OrderSourceData) => { (data.rows[0].columns as Record<string, unknown>).BZ = { formula: '1+1' } },
    ]) { const data = source(); alter(data); await expect(save(data, 1)).rejects.toThrow(/INVALID_/); expect((await query('select version from public.order_source_records')).rows[0].version).toBe(1) }
  }))
  it('본사만 새 기능을 사용하고 공장·미승인·익명은 원본을 읽거나 저장하지 못한다', async () => isolated(async () => {
    expect((await query('select public.get_budget_order_metadata_capability() value')).rows[0].value).toBe(true)
    await as(DEMO_IDS.internal); expect((await query('select public.get_budget_order_metadata_capability() value')).rows[0].value).toBe(true)
    await as(DEMO_IDS.factory); expect((await query('select public.get_budget_order_metadata_capability() value')).rows[0].value).toBe(false)
    expect((await query('select * from public.order_source_records')).rows).toEqual([]); await expect(save(source(), 1)).rejects.toThrow(/FORBIDDEN/)
    await as(fixture.profiles.find(profile => !profile.approved)!.id); expect((await query('select public.get_budget_order_metadata_capability() value')).rows[0].value).toBe(false)
    await as(null, 'anon'); await expect(query('select public.get_budget_order_metadata_capability()')).rejects.toThrow(/permission denied/)
  }))
  it('재실행은 원본 파일명·행·수량·버전과 기존 생산 자료를 그대로 남긴다', async () => {
    await as(DEMO_IDS.admin); const before = (await query('select to_jsonb(t) value from public.order_source_records t')).rows
    const styleBefore = (await query('select to_jsonb(t) value from public.styles t')).rows
    await db.exec('reset role'); await db.exec(migration); await as(DEMO_IDS.admin)
    expect((await query('select to_jsonb(t) value from public.order_source_records t')).rows).toEqual(before)
    expect((await query('select to_jsonb(t) value from public.styles t')).rows).toEqual(styleBefore)
  })
})
