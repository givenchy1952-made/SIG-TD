import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import type { SettlementTermsInput } from '../src/lib/settlement-types'

const db = new PGlite(), fixture = createSeed(), first = structuredClone(fixture.styles[0])
const factoryUser = '91000000-0000-4000-8000-000000000001'
let transaction = false, seq = 0
async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  if (!transaction) return db.query<T>(sql, params)
  const point = `settlement_query_${seq++}`; await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(sql, params); await db.exec(`release savepoint ${point}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await fn() } finally { transaction = false; await db.exec('rollback') } }
const input = (overrides: Partial<SettlementTermsInput> = {}): SettlementTermsInput => ({ projectCode: 'TEST-PROJECT', unitCost: 1234.56, itemType: 'product', ...overrides })
async function save(data: unknown = input(), version = 0, lineId = first.production[0].id, styleId = first.id, reason = '정산 단가 저장') { return query('select * from public.save_settlement_terms($1,$2,$3,$4::jsonb,$5)', [styleId, lineId, version, JSON.stringify(data), reason]) }
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
  for (const name of ['001_initial.sql', '002_style_images.sql', '003_operations.sql', '004_settlement_terms.sql']) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const row of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [row.id, row.name, row.country])
  for (const row of fixture.projects) await query('insert into public.projects(id,name,season) values($1,$2,$3)', [row.id, row.name, row.season])
  for (const row of [...fixture.profiles, { id: factoryUser, name: '테스트 공장', email: 'factory@example.test', role: 'factory', approved: true, active: true, factoryId: first.factoryId }]) {
    await query('insert into auth.users(id,email) values($1,$2)', [row.id, row.email])
    await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [row.id, row.name, row.role, row.approved, row.active, row.factoryId])
  }
  await as(DEMO_IDS.admin); first.version = 0
  await query('select * from public.save_style($1,$2::jsonb,0,$3)', [first.id, JSON.stringify(first), '정산 테스트 스타일'])
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('004 실제 PostgreSQL 정산 단가·본사 정보', () => {
  it('기존 스타일 계약을 변경하지 않고 본사 단가·프로젝트·단위를 저장한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    const before = (await query('select data,version from public.styles where id=$1', [first.id])).rows[0]
    const row = (await save(input({ projectCode: '  TEST-PROJECT  ' }))).rows[0]
    expect(row).toMatchObject({ project_code: 'TEST-PROJECT', unit_cost: '1234.56', item_type: 'product', version: 1, updated_by: DEMO_IDS.internal })
    expect((await query('select data,version from public.styles where id=$1', [first.id])).rows[0]).toEqual(before)
  }))
  it('미기재 단가 null과 명시한 무상 단가 0을 구분하고 이후 수정한다', async () => isolated(async () => {
    await as(DEMO_IDS.admin)
    expect((await save(input({ unitCost: null, projectCode: '' }))).rows[0].unit_cost).toBeNull()
    expect((await save(input({ unitCost: 0 }), 1)).rows[0].unit_cost).toBe('0')
    expect((await save(input({ unitCost: 7.12, itemType: 'fabric' }), 2)).rows[0]).toMatchObject({ unit_cost: '7.12', item_type: 'fabric', version: 3 })
  }))
  it('버전 충돌과 잘못된 후속 변경에서 단가·버전·이력을 보존한다', async () => isolated(async () => {
    await as(DEMO_IDS.admin); await save()
    await expect(save(input({ unitCost: 999 }), 0)).rejects.toThrow(/VERSION_CONFLICT/)
    await expect(save(input({ unitCost: -1 }), 1)).rejects.toThrow(/INVALID_SETTLEMENT/)
    expect((await query('select unit_cost,version from public.settlement_terms')).rows[0]).toEqual({ unit_cost: '1234.56', version: 1 })
    expect((await query('select * from public.settlement_terms_audits')).rows).toHaveLength(1)
  }))
  it('정확한 항목만 허용하고 금액 문자열·음수·세 자리 소수·범위 초과를 거부한다', async () => isolated(async () => {
    await as(DEMO_IDS.admin)
    for (const data of [{ ...input(), extra: true }, { ...input(), unitCost: '123' }, input({ unitCost: -1 }), input({ unitCost: .001 }), input({ unitCost: 1000000000.01 }), { projectCode: '', itemType: 'product' }]) await expect(save(data)).rejects.toThrow(/INVALID_/)
    expect((await query('select * from public.settlement_terms')).rows).toHaveLength(0)
  }))
  it('프로젝트 코드 제어문자·과도한 길이·없는 품목 종류를 거부한다', async () => isolated(async () => {
    await as(DEMO_IDS.admin)
    for (const data of [input({ projectCode: 'CODE\nNEW' }), input({ projectCode: 'a'.repeat(121) }), { ...input(), itemType: 'other' }]) await expect(save(data)).rejects.toThrow(/INVALID_/)
  }))
  it('알 수 없는 스타일·컬러·삭제된 스타일을 거부한다', async () => isolated(async () => {
    await as(DEMO_IDS.admin)
    await expect(save(input(), 0, crypto.randomUUID())).rejects.toThrow(/production line/)
    await expect(save(input(), 0, first.production[0].id, crypto.randomUUID())).rejects.toThrow(/FORBIDDEN/)
    await query('select public.soft_delete_style($1,1,$2)', [first.id, '삭제된 정산 스타일'])
    await expect(save()).rejects.toThrow(/FORBIDDEN/)
  }))
  it('미승인·비활성·익명 및 공장 계정의 단가 접근·변경을 차단한다', async () => isolated(async () => {
    await as(DEMO_IDS.admin); await save()
    for (const actor of [fixture.profiles.find(profile => !profile.approved)!.id, factoryUser, DEMO_IDS.factory]) {
      await as(actor)
      expect((await query('select * from public.settlement_terms')).rows).toHaveLength(0)
      expect((await query('select * from public.settlement_terms_audits')).rows).toHaveLength(0)
      await expect(save()).rejects.toThrow(/FORBIDDEN/)
    }
    await db.exec('reset role'); await query('update public.profiles set active=false where id=$1', [DEMO_IDS.internal]); await as(DEMO_IDS.internal)
    expect((await query('select * from public.settlement_terms')).rows).toHaveLength(0)
    await expect(save()).rejects.toThrow(/FORBIDDEN/)
    await as(null, 'anon'); await expect(query('select * from public.settlement_terms')).rejects.toThrow(/permission denied/)
    await expect(save()).rejects.toThrow(/permission denied/)
  }))
  it('관리자도 직접 DML·감사 기록 위조·버전 변경을 할 수 없다', async () => isolated(async () => {
    await as(DEMO_IDS.admin); await save()
    for (const table of ['settlement_terms', 'settlement_terms_audits']) await expect(query(`delete from public.${table}`)).rejects.toThrow(/permission denied/)
    await expect(query('update public.settlement_terms set version=5')).rejects.toThrow(/permission denied/)
  }))
  it('본사 전용 감사 기록에 수정 전후 값·사유를 남기고 일반 감사 기록에서는 가린다', async () => isolated(async () => {
    await as(DEMO_IDS.internal); await save(input({ projectCode: 'CONFIDENTIAL-CODE', unitCost: 987654.32 }), 0, first.production[0].id, first.id, '비밀 단가 987654.32')
    await save(input({ unitCost: 7.12 }), 1)
    const privateRows = (await query('select * from public.settlement_terms_audits order by created_at')).rows
    expect(privateRows).toHaveLength(2)
    expect(privateRows[0].before).toBeNull()
    expect(privateRows[1].before).toMatchObject({ unit_cost: 987654.32, project_code: 'CONFIDENTIAL-CODE' })
    expect(privateRows[1].after).toMatchObject({ unit_cost: 7.12, version: 2 })
    await as(factoryUser)
    expect((await query('select * from public.settlement_terms_audits')).rows).toHaveLength(0)
    const publicRows = (await query("select * from public.audits where action='을지 정산 정보 저장'")).rows
    expect(publicRows).toHaveLength(2)
    expect(JSON.stringify(publicRows)).not.toMatch(/987654|CONFIDENTIAL|비밀/)
  }))
  it('소프트 삭제 후 본사에도 기존 단가와 감사 기록을 노출하지 않는다', async () => isolated(async () => {
    await as(DEMO_IDS.admin); await save(); await query('select public.soft_delete_style($1,1,$2)', [first.id, '개별 스타일 삭제'])
    expect((await query('select * from public.settlement_terms')).rows).toHaveLength(0)
    expect((await query('select * from public.settlement_terms_audits')).rows).toHaveLength(0)
  }))
  it('버전·사유·종류별 입력 한계를 검증한다', async () => isolated(async () => {
    await as(DEMO_IDS.admin)
    await expect(save(input(), -1)).rejects.toThrow(/INVALID_VERSION/)
    await expect(save(input(), 0, first.production[0].id, first.id, 'x')).rejects.toThrow(/REASON_REQUIRED/)
    await expect(save(input(), 0, first.production[0].id, first.id, 'x'.repeat(1001))).rejects.toThrow(/REASON_REQUIRED/)
    expect((await save(input({ unitCost: 1000000000, projectCode: 'a'.repeat(120), itemType: 'label' }))).rows[0]).toMatchObject({ item_type: 'label', unit_cost: '1000000000' })
  }))
})
