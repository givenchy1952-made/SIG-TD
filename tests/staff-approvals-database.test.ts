import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'

const db = new PGlite(), fixture = createSeed(), style = structuredClone(fixture.styles[0])
const ids = { pending: '93000000-0000-4000-8000-000000000001', pendingOther: '93000000-0000-4000-8000-000000000002', pendingInactive: '93000000-0000-4000-8000-000000000003', factory: '93000000-0000-4000-8000-000000000004', otherFactory: '93000000-0000-4000-8000-000000000005' }
let transaction = false, seq = 0
async function query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  if (!transaction) return db.query<T>(sql, params)
  const point = `approval_${seq++}`; await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(sql, params); await db.exec(`release savepoint ${point}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await fn() } finally { transaction = false; await db.exec('rollback') } }
async function manage(id = ids.pending, role: string | null = 'factory', approved: boolean | null = true, active: boolean | null = true, factoryId: string | null = style.factoryId, name: string | null = '가입 담당자') {
  return query('select * from public.manage_profile($1,$2,$3,$4,$5,$6)', [id, name, role, approved, active, factoryId])
}
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
  for (const name of ['001_initial.sql', '002_style_images.sql', '003_operations.sql', '004_settlement_terms.sql', '005_workflow_refinements.sql', '006_staff_approvals.sql']) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const item of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [item.id, item.name, item.country])
  for (const item of fixture.projects) await query('insert into public.projects(id,name,season) values($1,$2,$3)', [item.id, item.name, item.season])
  for (const item of fixture.profiles) {
    await query('insert into auth.users(id,email) values($1,$2)', [item.id, item.email])
    await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [item.id, item.name, item.role, item.approved, item.active, item.factoryId])
  }
  for (const id of Object.values(ids)) await query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3::jsonb)', [id, `${id}@example.test`, JSON.stringify({ name: '가입 담당자', role: 'admin', approved: true, factoryId: style.factoryId })])
  await query('update public.profiles set active=false where id=$1', [ids.pendingInactive])
  await query("update public.profiles set role='factory',approved=true,factory_id=$2 where id=$1", [ids.factory, style.factoryId])
  await query("update public.profiles set role='factory',approved=true,factory_id=$2 where id=$1", [ids.otherFactory, fixture.factories.find(item => item.id !== style.factoryId)!.id])
  await as(DEMO_IDS.admin); style.version = 0
  await query('select * from public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), '가입 승인 테스트 스타일'])
  const path = `${style.id}/${crypto.randomUUID()}.pdf`
  await query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3::jsonb)', ['sig-files', path, JSON.stringify({ size: 10, mimetype: 'application/pdf' })])
  await query('insert into public.attachments(id,style_id,sample_id,name,path,mime,size,uploaded_by) values($1,$2,null,$3,$4,$5,10,$6)', [crypto.randomUUID(), style.id, 'approval-test.pdf', path, 'application/pdf', DEMO_IDS.admin])
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('006 실제 PostgreSQL 본사 승인·공장 배정', () => {
  it('가입 메타데이터의 관리자·승인 주장을 무시하고 승인 전 자기 프로필만 읽는다', async () => isolated(async () => {
    await as(ids.pending)
    expect((await query('select role,approved,active,factory_id from public.profiles')).rows).toEqual([{ role: 'internal', approved: false, active: true, factory_id: null }])
    expect((await query('select * from public.styles')).rows).toHaveLength(0)
    expect((await query('select * from public.attachments')).rows).toHaveLength(0)
    await expect(manage()).rejects.toThrow(/FORBIDDEN/)
  }))
  it('승인된 본사·관리자에게만 승인 기능 상태를 제공한다', async () => isolated(async () => {
    for (const actor of [DEMO_IDS.admin, DEMO_IDS.internal]) {
      await as(actor); expect((await query('select public.get_staff_approvals_capability() enabled')).rows[0].enabled).toBe(true)
    }
    for (const actor of [ids.pending, ids.factory]) {
      await as(actor); expect((await query('select public.get_staff_approvals_capability() enabled')).rows[0].enabled).toBe(false)
    }
    await as(null, 'anon'); await expect(query('select public.get_staff_approvals_capability()')).rejects.toThrow(/permission denied/)
  }))
  it('본사 직원이 신규 가입자를 등록 공장에 배정·승인하면 해당 공장 데이터만 접근한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    expect((await manage()).rows[0]).toMatchObject({ role: 'factory', approved: true, active: true, factory_id: style.factoryId })
    await as(ids.pending)
    expect((await query('select * from public.styles')).rows).toHaveLength(1)
    expect((await query('select * from public.attachments')).rows).toHaveLength(1)
    await expect(manage(ids.pendingOther)).rejects.toThrow(/FORBIDDEN/)
  }))
  it('다른 공장에 배정하면 현재 스타일과 첨부파일 접근은 계속 차단한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal); await manage(ids.pending, 'factory', true, true, fixture.factories.find(item => item.id !== style.factoryId)!.id)
    await as(ids.pending)
    expect((await query('select * from public.styles')).rows).toHaveLength(0)
    expect((await query('select * from public.attachments')).rows).toHaveLength(0)
  }))
  it('공장 배정 없는 승인과 존재하지 않는 공장을 거부한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    await expect(manage(ids.pending, 'factory', true, true, null)).rejects.toThrow(/INVALID_PROFILE/)
    await expect(manage(ids.pending, 'factory', true, true, crypto.randomUUID())).rejects.toThrow(/INVALID_PROFILE/)
    expect((await query('select approved from public.profiles where id=$1', [ids.pending])).rows[0].approved).toBe(false)
  }))
  it('본사 직원은 신규 본사 직원도 승인하지만 승인 뒤 기존 본사 권한은 수정할 수 없다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    expect((await manage(ids.pending, 'internal', true, true, null)).rows[0]).toMatchObject({ role: 'internal', approved: true, factory_id: null })
    await expect(manage(ids.pending, 'factory', true, true, style.factoryId)).rejects.toThrow(/FORBIDDEN/)
    await expect(manage(ids.pending, 'internal', false, true, null)).rejects.toThrow(/FORBIDDEN/)
  }))
  it('본사 직원의 관리자 승격·관리자 수정·자기 계정 변경을 차단한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    await expect(manage(ids.pending, 'admin', true, true, null)).rejects.toThrow(/FORBIDDEN/)
    await expect(manage(DEMO_IDS.admin, 'factory', true, true, style.factoryId)).rejects.toThrow(/FORBIDDEN/)
    await expect(manage(DEMO_IDS.internal, 'internal', true, true, null)).rejects.toThrow(/FORBIDDEN/)
    await expect(manage(fixture.profiles.find(item => item.role === 'internal' && item.id !== DEMO_IDS.internal)!.id, 'internal', false, true, null)).rejects.toThrow(/FORBIDDEN/)
  }))
  it('비활성 본사 계정은 승인·배정할 수 없고 비활성 신규 본사는 관리자만 관리한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    await expect(manage(ids.pendingInactive, 'internal', true, true, null)).rejects.toThrow(/FORBIDDEN/)
    await db.exec('reset role'); await query('update public.profiles set active=false where id=$1', [DEMO_IDS.internal]); await as(DEMO_IDS.internal)
    await expect(manage()).rejects.toThrow(/FORBIDDEN/)
  }))
  it('본사 직원이 공장 계정을 재배정하면 이전 공장의 데이터 접근을 즉시 차단한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    await manage(ids.factory, 'factory', true, true, fixture.factories.find(item => item.id !== style.factoryId)!.id)
    await as(ids.factory)
    expect((await query('select * from public.styles')).rows).toHaveLength(0)
    expect((await query('select * from public.attachments')).rows).toHaveLength(0)
  }))
  it('본사 직원이 공장 승인을 취소하거나 비활성화하면 기존 세션도 업무를 조회하지 못한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal); await manage(ids.factory, 'factory', false, true)
    await as(ids.factory); expect((await query('select * from public.styles')).rows).toHaveLength(0)
    await as(DEMO_IDS.internal); await manage(ids.factory, 'factory', true, false)
    await as(ids.factory); expect((await query('select * from public.styles')).rows).toHaveLength(0)
  }))
  it('관리자는 기존 본사와 관리자 계정을 관리하되 자신의 관리자 권한은 해제하지 못한다', async () => isolated(async () => {
    await as(DEMO_IDS.admin)
    await expect(manage(DEMO_IDS.admin, 'internal', true, true, null)).rejects.toThrow(/LAST_ADMIN_PROTECTED/)
    await expect(manage(DEMO_IDS.admin, 'admin', false, true, null)).rejects.toThrow(/LAST_ADMIN_PROTECTED/)
    expect((await manage(ids.pending, 'admin', true, true, null)).rows[0].role).toBe('admin')
    await manage(DEMO_IDS.internal, 'internal', false, true, null)
    expect((await query('select approved from public.profiles where id=$1', [DEMO_IDS.internal])).rows[0].approved).toBe(false)
  }))
  it('승인·공장 변경 이력은 관리자가 조회하고 공장·신규 가입자에게 공개하지 않는다', async () => isolated(async () => {
    await as(DEMO_IDS.internal); await manage()
    expect((await query("select * from public.audits where action='사용자 권한 변경'")).rows).toHaveLength(0)
    await as(DEMO_IDS.admin)
    const row = (await query("select * from public.audits where action='사용자 권한 변경'")).rows[0]
    expect(row.before).toMatchObject({ approved: false, factory_id: null })
    expect(row.after).toMatchObject({ approved: true, factory_id: style.factoryId })
    expect(row.actor_id).toBe(DEMO_IDS.internal)
    await as(ids.pending); expect((await query("select * from public.audits where action='사용자 권한 변경'")).rows).toHaveLength(0)
  }))
  it('프로필 직접 DML 및 익명·공장 계정의 승인 RPC 호출을 차단한다', async () => isolated(async () => {
    for (const actor of [DEMO_IDS.internal, ids.pending, ids.factory]) {
      await as(actor)
      await expect(query('update public.profiles set approved=true where id=$1', [ids.pendingOther])).rejects.toThrow(/permission denied/)
    }
    await as(ids.factory); await expect(manage()).rejects.toThrow(/FORBIDDEN/)
    await as(null, 'anon'); await expect(manage()).rejects.toThrow(/permission denied/)
  }))
  it.each([null, '', 'a'.repeat(121), '이름\n변조'])('잘못된 담당자 이름 %s은 계정을 바꾸지 않는다', async name => isolated(async () => {
    await as(DEMO_IDS.internal); await expect(manage(ids.pending, 'factory', true, true, style.factoryId, name)).rejects.toThrow(/INVALID_PROFILE/)
    expect((await query('select approved from public.profiles where id=$1', [ids.pending])).rows[0].approved).toBe(false)
  }))
  it('본사 직원이 승인된 본사 직원에게 여러 담당 공장을 배정하고 HQ가 배정 정보를 조회한다', async () => isolated(async () => {
    const employee = fixture.profiles.find(item => item.role === 'internal' && item.id !== DEMO_IDS.internal)!
    await as(DEMO_IDS.internal)
    const factories = fixture.factories.slice(0, 2).map(item => item.id)
    const row = (await query('select * from public.save_employee_factory_assignment($1,$2,0,$3)', [employee.id, factories, '본사 직원 담당 공장 배정'])).rows[0]
    expect(row).toMatchObject({ employee_id: employee.id, factory_ids: factories, version: 1, updated_by: DEMO_IDS.internal })
    await as(employee.id)
    expect((await query('select * from public.employee_factory_assignments')).rows).toHaveLength(1)
    await as(DEMO_IDS.admin)
    expect((await query('select * from public.employee_factory_assignments')).rows).toHaveLength(1)
    await as(ids.factory)
    expect((await query('select * from public.employee_factory_assignments')).rows).toHaveLength(0)
  }))
  it('본사 직원의 관리자 담당 공장 수정과 미승인·공장 직원 대상 배정을 차단한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    await expect(query('select * from public.save_employee_factory_assignment($1,$2,0,$3)', [DEMO_IDS.admin, [style.factoryId], '관리자 배정 변경 시도'])).rejects.toThrow(/FORBIDDEN/)
    for (const target of [ids.pending, ids.factory]) await expect(query('select * from public.save_employee_factory_assignment($1,$2,0,$3)', [target, [style.factoryId], '미승인 공장 대상 배정'])).rejects.toThrow(/INVALID_OPERATION/)
    expect((await query('select * from public.employee_factory_assignments')).rows).toHaveLength(0)
  }))
  it('본사 담당 공장 배정은 버전 충돌·중복·알 수 없는 공장을 거부하고 관리자 권한은 유지한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    await query('select * from public.save_employee_factory_assignment($1,$2,0,$3)', [DEMO_IDS.internal, [style.factoryId], '자신의 업무 담당 공장 배정'])
    await expect(query('select * from public.save_employee_factory_assignment($1,$2,0,$3)', [DEMO_IDS.internal, [], '낡은 배정 변경 시도'])).rejects.toThrow(/VERSION_CONFLICT/)
    for (const factories of [[style.factoryId, style.factoryId], [crypto.randomUUID()]]) await expect(query('select * from public.save_employee_factory_assignment($1,$2,1,$3)', [DEMO_IDS.internal, factories, '잘못된 담당 공장 배정'])).rejects.toThrow(/INVALID_OPERATION/)
    await as(DEMO_IDS.admin)
    expect((await query('select * from public.save_employee_factory_assignment($1,$2,0,$3)', [DEMO_IDS.admin, [style.factoryId], '관리자 자신의 담당 공장 배정'])).rows[0].version).toBe(1)
  }))
  it('공장·미승인·비활성 본사의 담당 공장 배정 RPC와 직접 쓰기를 차단한다', async () => isolated(async () => {
    for (const actor of [ids.pending, ids.factory]) {
      await as(actor)
      await expect(query('select * from public.save_employee_factory_assignment($1,$2,0,$3)', [DEMO_IDS.internal, [style.factoryId], '권한 없는 담당 공장 배정'])).rejects.toThrow(/FORBIDDEN/)
      await expect(query('delete from public.employee_factory_assignments')).rejects.toThrow(/permission denied/)
    }
    await db.exec('reset role'); await query('update public.profiles set active=false where id=$1', [DEMO_IDS.internal]); await as(DEMO_IDS.internal)
    await expect(query('select * from public.save_employee_factory_assignment($1,$2,0,$3)', [DEMO_IDS.internal, [style.factoryId], '비활성 본사 담당 공장 배정'])).rejects.toThrow(/FORBIDDEN/)
  }))
  it('알 수 없는 역할·null 승인 상태·미가입 계정은 거부한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    await expect(manage(ids.pending, 'owner')).rejects.toThrow(/INVALID_PROFILE/)
    await expect(manage(ids.pending, 'factory', null)).rejects.toThrow(/INVALID_PROFILE/)
    await expect(manage(ids.pending, 'factory', true, null)).rejects.toThrow(/INVALID_PROFILE/)
    await expect(manage(crypto.randomUUID())).rejects.toThrow(/NOT_FOUND/)
  }))
})
