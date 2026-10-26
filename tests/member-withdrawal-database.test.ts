import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { assertApprovedLogin } from '../src/lib/approval-login'
import { createSeed, DEMO_IDS } from '../src/lib/seed'

const db = new PGlite(), fixture = createSeed(), style = structuredClone(fixture.styles[0])
const ids = { admin: crypto.randomUUID(), factory: crypto.randomUUID(), pending: crypto.randomUUID(), run: crypto.randomUUID(), receipt: crypto.randomUUID() }
const qty = (count: number) => ({ XXS: count, XS: count, S: count, M: count, L: count, XL: count })
let transaction = false, seq = 0
async function query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  if (!transaction) return db.query<T>(sql, params)
  const point = `withdrawal_${seq++}`; await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(sql, params); await db.exec(`release savepoint ${point}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await as(DEMO_IDS.admin); await fn() } finally { transaction = false; await db.exec('rollback') } }
async function withdraw(id: string | null = ids.factory, reason: string | null = '퇴사에 따른 업무 접근 종료') { return query('select * from public.withdraw_workspace_member($1,$2)', [id, reason]) }
async function manage(id = ids.factory, approved = true, active = true, name = '공장 담당자') { return query('select * from public.manage_profile($1,$2,$3,$4,$5,$6)', [id, name, 'factory', approved, active, style.factoryId]) }
async function loadMigration(name: string) { await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')) }

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
  for (const name of ['001_initial.sql', '002_style_images.sql', '003_operations.sql', '004_settlement_terms.sql', '005_workflow_refinements.sql', '006_staff_approvals.sql', '007_production_ledger.sql']) await loadMigration(name)
  for (const item of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [item.id, item.name, item.country])
  for (const item of fixture.projects) await query('insert into public.projects(id,name,season,code) values($1,$2,$3,$4)', [item.id, item.name, item.season, item.id === style.projectId ? 'WITHDRAWAL-PROJECT' : ''])
  for (const item of fixture.profiles) {
    await query('insert into auth.users(id,email) values($1,$2)', [item.id, item.email])
    await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [item.id, item.name, item.role, item.approved, item.active, item.factoryId])
  }
  for (const id of [ids.admin, ids.factory, ids.pending]) await query('insert into auth.users(id,email) values($1,$2)', [id, `${id}@example.test`])
  await query("update public.profiles set name='추가 관리자',role='admin',approved=true,active=true where id=$1", [ids.admin])
  await query("update public.profiles set name='공장 담당자',role='factory',approved=true,active=true,factory_id=$2 where id=$1", [ids.factory, style.factoryId])
  await as(DEMO_IDS.admin)
  style.ownerId = DEMO_IDS.internal; style.version = 0
  await query('select * from public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), '구성원 탈퇴 검증 스타일'])
  // Preserve a genuinely finalized ledger created before supplier consent was
  // introduced. Applying 008-010 must not rewrite the existing financial record.
  await query('select * from public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [ids.run, style.id, style.production[0].id, JSON.stringify({ name: '확정 생산 1차', projectId: style.projectId, projectCode: 'WITHDRAWAL-PROJECT', expectedDue: '2026-11-01', poId: null, unitCost: 1250.25, itemType: 'product', order: qty(10), correctsRunId: null }), '생산 차수 등록'])
  await query('select * from public.allocate_production_receipt($1,$2,$3::jsonb,1,$4)', [ids.receipt, ids.run, JSON.stringify({ receivedAt: '2026-11-01', quantities: qty(2) }), '실제 입고 수량 확인'])
  await query('select * from public.finalize_production_run($1,2,$2)', [ids.run, '입고 확인 후 마감 확정'])
  await db.exec('reset role')
  for (const name of ['008_supplier_acceptance.sql', '009_import_production_runs.sql', '010_member_withdrawal.sql']) await loadMigration(name)
  await as(DEMO_IDS.internal)
  await query('insert into public.comments(style_id,body) values($1,$2)', [style.id, '담당자 퇴사 후에도 보존할 업무 코멘트'])
  const path = `${style.id}/${crypto.randomUUID()}.pdf`
  await query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3::jsonb)', ['sig-files', path, JSON.stringify({ size: 10, mimetype: 'application/pdf' })])
  await query('insert into public.attachments(style_id,name,path,mime,size) values($1,$2,$3,$4,10)', [style.id, '보존할-계약서.pdf', path, 'application/pdf'])
  await as(DEMO_IDS.admin)
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('010 실제 PostgreSQL 구성원 탈퇴와 기록 보존', () => {
  it('현재 활성·승인 관리자에게만 탈퇴 기능 상태를 제공한다', async () => isolated(async () => {
    for (const id of [DEMO_IDS.admin, ids.admin]) { await as(id); expect((await query('select public.get_member_withdrawal_capability() enabled')).rows[0].enabled).toBe(true) }
    for (const id of [DEMO_IDS.internal, ids.factory, ids.pending]) { await as(id); expect((await query('select public.get_member_withdrawal_capability() enabled')).rows[0].enabled).toBe(false) }
    await as(null, 'anon'); await expect(query('select public.get_member_withdrawal_capability()')).rejects.toThrow(/permission denied/)
  }))
  it('탈퇴 사유·처리자·시각을 비공개 이력에 남기고 공장과 계정 식별 정보는 보존한다', async () => isolated(async () => {
    const before = (await query('select * from public.profiles where id=$1', [ids.factory])).rows[0]
    const result = (await withdraw(ids.factory, '  협력업체 담당자 퇴사  ')).rows[0]
    expect(result).toMatchObject({ ...before, active: false, approved: false, withdrawn_by: DEMO_IDS.admin, withdrawn_at: expect.any(Date) })
    expect(result.withdrawn_at).not.toBeNull()
    const audit = (await query("select * from public.audits where action='구성원 탈퇴'")).rows[0]
    expect(audit).toMatchObject({ style_id: null, actor_id: DEMO_IDS.admin, reason: '협력업체 담당자 퇴사', before, after: { ...result, withdrawn_at: expect.any(String) } })
    expect(new Date(audit.after.withdrawn_at)).toEqual(result.withdrawn_at)
    expect(audit.created_at).toEqual(result.withdrawn_at)
    expect(result).not.toHaveProperty('withdrawal_reason')
    await db.exec('reset role')
    expect((await query('select id from auth.users where id=$1', [ids.factory])).rows).toHaveLength(1)
    expect((await query('select id from public.factories where id=$1', [before.factory_id])).rows).toHaveLength(1)
  }))
  it('본사 탈퇴 후에도 품번·담당자·파일·코멘트·확정 마감·입고·변경 이력을 그대로 보존한다', async () => isolated(async () => {
    const preserved = ['styles', 'comments', 'attachments', 'production_runs', 'production_receipts', 'production_run_audits']
    const before: Record<string, any>[][] = []
    for (const table of preserved) before.push((await query(`select * from public.${table} order by id`)).rows)
    const businessAudits = (await query('select * from public.audits order by id')).rows
    await withdraw(DEMO_IDS.internal)
    for (let i = 0; i < preserved.length; i++) expect((await query(`select * from public.${preserved[i]} order by id`)).rows).toEqual(before[i])
    const run = (await query('select * from public.production_runs where id=$1', [ids.run])).rows[0]
    expect(run).toMatchObject({ owner_id_snapshot: DEMO_IDS.internal, snapshot: { netAmount: 15003 } })
    const afterAudits = (await query("select * from public.audits where action<>'구성원 탈퇴' order by id")).rows
    expect(afterAudits).toEqual(businessAudits)
    expect((await query('select * from storage.objects')).rows).toHaveLength(1)
  }))
  it.each([['공장', ids.factory], ['본사', DEMO_IDS.internal]])('%s 탈퇴 시 기존 세션의 업무·첨부·저장소 접근과 로그인 진입을 차단한다', async (_label, id) => isolated(async () => {
    await as(id)
    for (const table of ['styles', 'attachments']) expect((await query(`select * from public.${table}`)).rows).toHaveLength(1)
    expect((await query('select * from storage.objects')).rows).toHaveLength(1)
    await as(DEMO_IDS.admin); await withdraw(id); await as(id)
    for (const table of ['styles', 'attachments', 'comments', 'production_runs', 'production_receipts', 'production_run_audits']) expect((await query(`select * from public.${table}`)).rows).toHaveLength(0)
    expect((await query('select * from storage.objects')).rows).toHaveLength(0)
    const profile = (await query('select * from public.profiles')).rows[0]
    expect(profile).toMatchObject({ id, active: false, approved: false })
    expect(() => assertApprovedLogin(profile, id)).toThrow('사용 중지된 계정')
    await expect(query('select * from public.get_supplier_production_orders()')).rejects.toThrow(/FORBIDDEN/)
  }))
  it('관리자만 탈퇴 사유를 읽고 본사·공장에게 공개하지 않는다', async () => isolated(async () => {
    await withdraw()
    for (const id of [DEMO_IDS.internal, DEMO_IDS.factory, ids.factory, ids.pending]) { await as(id); expect((await query("select * from public.audits where action='구성원 탈퇴'")).rows).toHaveLength(0) }
    await as(ids.admin); expect((await query("select reason from public.audits where action='구성원 탈퇴'")).rows[0].reason).toBe('퇴사에 따른 업무 접근 종료')
  }))
  it('본사 직원이 기존 승인 RPC로 탈퇴 공장을 편집·재승인·재배정하지 못한다', async () => isolated(async () => {
    const result = (await withdraw()).rows[0]
    await as(DEMO_IDS.internal)
    for (const [approved, active] of [[true, true], [false, false], [true, false], [false, true]]) await expect(manage(ids.factory, approved, active, '몰래 변경')).rejects.toThrow(/FORBIDDEN/)
    expect((await query('select * from public.profiles where id=$1', [ids.factory])).rows[0]).toEqual(result)
  }))
  it('관리자의 비활성 정보 수정은 탈퇴 표식을 보존하고 승인·활성 동시 복구만 표식을 지운다', async () => isolated(async () => {
    const withdrawn = (await withdraw()).rows[0]
    expect((await manage(ids.factory, false, false, '퇴사 기록 이름 정정')).rows[0]).toMatchObject({ withdrawn_at: withdrawn.withdrawn_at, withdrawn_by: DEMO_IDS.admin, active: false, approved: false })
    for (const [approved, active] of [[true, false], [false, true]]) await expect(manage(ids.factory, approved, active)).rejects.toThrow(/profiles_withdrawal_access/)
    expect((await manage()).rows[0]).toMatchObject({ active: true, approved: true, withdrawn_at: null, withdrawn_by: null, factory_id: style.factoryId })
    await as(ids.factory); expect((await query('select * from public.styles')).rows).toHaveLength(1)
  }))
  it('중복·자기 계정·미가입 대상·잘못된 사유는 프로필과 이력을 바꾸지 않는다', async () => isolated(async () => {
    const users = (await query('select * from public.profiles order by id')).rows
    for (const target of [null, crypto.randomUUID()]) await expect(withdraw(target)).rejects.toThrow(/NOT_FOUND/)
    await expect(withdraw(DEMO_IDS.admin)).rejects.toThrow(/LAST_ADMIN_PROTECTED/)
    for (const reason of [null, '', ' ', 'a', 'a'.repeat(1001)]) await expect(withdraw(ids.factory, reason)).rejects.toThrow(/REASON_REQUIRED/)
    expect((await query('select * from public.profiles order by id')).rows).toEqual(users)
    expect((await query("select * from public.audits where action='구성원 탈퇴'")).rows).toHaveLength(0)
    await withdraw(); await expect(withdraw()).rejects.toThrow(/ALREADY_WITHDRAWN/)
    expect((await query("select * from public.audits where action='구성원 탈퇴'")).rows).toHaveLength(1)
  }))
  it('본사·공장·미승인·익명과 비활성 관리자의 탈퇴 RPC를 거부한다', async () => isolated(async () => {
    for (const id of [DEMO_IDS.internal, ids.factory, ids.pending]) { await as(id); await expect(withdraw()).rejects.toThrow(/FORBIDDEN/) }
    await as(null, 'anon'); await expect(withdraw()).rejects.toThrow(/permission denied/)
    await as(DEMO_IDS.admin); await withdraw(ids.admin); await as(ids.admin)
    expect((await query('select public.get_member_withdrawal_capability() enabled')).rows[0].enabled).toBe(false)
    await expect(withdraw(DEMO_IDS.admin)).rejects.toThrow(/FORBIDDEN/)
  }))
  it('006과 같은 전역 잠금을 먼저 잡고 처리자를 다시 확인하여 마지막 활성 관리자를 보호한다', async () => isolated(async () => {
    const body = (await query("select prosrc from pg_proc where oid='public.withdraw_workspace_member(uuid,text)'::regprocedure")).rows[0].prosrc as string
    expect(body).toContain("hashtextextended('sig:manage-profile',0)")
    expect(body.indexOf('pg_advisory_xact_lock')).toBeLessThan(body.indexOf('select * into actor'))
    await withdraw(ids.admin); await as(ids.admin); await expect(withdraw(DEMO_IDS.admin)).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.admin)
    expect((await query("select id from public.profiles where role='admin' and active and approved")).rows).toEqual([{ id: DEMO_IDS.admin }])
  }))
  it('관리자를 포함해 프로필 직접 DML·탈퇴 표식 위조·트리거 함수 호출을 허용하지 않는다', async () => isolated(async () => {
    for (const id of [DEMO_IDS.admin, DEMO_IDS.internal, ids.factory]) {
      await as(id)
      await expect(query('update public.profiles set active=false,approved=false,withdrawn_at=now(),withdrawn_by=$1 where id=$2', [id, ids.pending])).rejects.toThrow(/permission denied/)
      await expect(query('delete from public.profiles where id=$1', [ids.pending])).rejects.toThrow(/permission denied/)
      await expect(query('select public.protect_member_withdrawal()')).rejects.toThrow(/permission denied/)
    }
  }))
  it('010 재실행 시 탈퇴 표식·사유·업무 기록을 유지하고 트리거를 중복 생성하지 않는다', async () => {
    await as(DEMO_IDS.admin)
    const withdrawn = (await withdraw()).rows[0]
    const audits = (await query("select * from public.audits where action='구성원 탈퇴' order by id")).rows
    const styles = (await query('select * from public.styles order by id')).rows
    await db.exec('reset role')
    await loadMigration('010_member_withdrawal.sql')
    await as(DEMO_IDS.admin)
    expect((await query('select * from public.profiles where id=$1', [ids.factory])).rows[0]).toEqual(withdrawn)
    expect((await query("select * from public.audits where action='구성원 탈퇴' order by id")).rows).toEqual(audits)
    expect((await query('select * from public.styles order by id')).rows).toEqual(styles)
    expect((await query("select count(*)::int total from pg_trigger where tgrelid='public.profiles'::regclass and tgname='profiles_withdrawal_protected'")).rows[0].total).toBe(1)
    await as(DEMO_IDS.internal); await expect(manage()).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.admin); await manage()
  })
})
