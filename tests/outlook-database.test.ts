import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { emptyQuantities } from '../src/lib/types'

const db = new PGlite(), fixture = createSeed(), style = structuredClone(fixture.styles[1])
const clientId = 'a0000000-0000-4000-8000-000000000001', tenantId = 'a0000000-0000-4000-8000-000000000002'
const requestId = 'a0000000-0000-4000-8000-000000000003'
const pendingId = fixture.profiles.find(person => !person.approved)!.id
const senderEmail = fixture.profiles.find(person => person.id === DEMO_IDS.internal)!.email.toLowerCase()
const migration = readFileSync(new URL('../supabase/migrations/012_outlook_po_email.sql', import.meta.url), 'utf8')
let transaction = false, sequence = 0
async function query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  if (!transaction) return db.query<T>(sql, params)
  const point = `outlook_${sequence++}`; await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(sql, params); await db.exec(`release savepoint ${point}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw error }
}
async function as(id: string | null, role = 'authenticated') {
  await db.exec(`reset role;set role ${role}`)
  await query("select set_config('request.jwt.claim.sub',$1,false)", [id || ''])
}
async function isolated(fn: () => Promise<void>) {
  await db.exec('begin'); transaction = true
  try { await fn() } finally { transaction = false; await db.exec('rollback') }
}
async function configuration(version = 0) {
  await as(DEMO_IDS.admin)
  return (await query('select public.save_outlook_configuration($1,$2,$3,$4) item', [clientId, tenantId, version, 'Microsoft 365 발송 설정'])).rows[0].item
}
async function createPo() {
  const id = crypto.randomUUID()
  await as(DEMO_IDS.internal)
  await query('select public.save_po_dispatch($1,$2,0,$3::jsonb,$4)', [id, style.id, JSON.stringify({ dueDate: '2026-12-20', recipient: 'factory@example.test', subject: 'Outlook PO 시험', body: '실제 업무가 아닌 격리된 권한 시험', evidenceAttachmentId: null, voided: false }), 'PO 시험 초안'])
  return id
}
async function begin(id: string, version = 1) { return (await query('select * from public.begin_outlook_po_dispatch($1,$2)', [id, version])).rows[0] }
async function finish(id: string, outcome = 'sent', receipt: string | null = requestId, error: string | null = null) {
  await as(null, 'service_role')
  return (await query('select * from public.finalize_outlook_po_dispatch($1,$2,$3,$4)', [id, receipt, error, outcome])).rows[0]
}
async function row(id: string) { await as(DEMO_IDS.admin); return (await query('select * from public.po_dispatches where id=$1', [id])).rows[0] }

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
  for (const name of ['001_initial.sql', '002_style_images.sql', '003_operations.sql', '004_settlement_terms.sql', '005_workflow_refinements.sql', '006_staff_approvals.sql', '007_production_ledger.sql', '008_supplier_acceptance.sql', '009_import_production_runs.sql', '010_member_withdrawal.sql', '011_import_color_owners.sql', '012_outlook_po_email.sql']) {
    await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  }
  for (const item of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [item.id, item.name, item.country])
  for (const item of fixture.projects) await query('insert into public.projects(id,name,season) values($1,$2,$3)', [item.id, item.name, item.season])
  for (const item of fixture.profiles) {
    await query('insert into auth.users(id,email) values($1,$2)', [item.id, item.email])
    await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [item.id, item.name, item.role, item.approved, item.active, item.factoryId])
  }
  style.version = 0
  await as(DEMO_IDS.admin)
  await query('select public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), 'Outlook PO 격리 시험'])
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('012 실제 PostgreSQL Outlook 발송 설정·접수 증거', () => {
  it('미설정 상태를 본사에만 공개하고 공장·미승인·익명은 차단한다', async () => isolated(async () => {
    for (const person of [DEMO_IDS.admin, DEMO_IDS.internal]) { await as(person); expect((await query('select public.get_outlook_configuration() item')).rows[0].item).toBeNull() }
    for (const person of [DEMO_IDS.factory, pendingId]) { await as(person); await expect(query('select public.get_outlook_configuration()')).rejects.toThrow(/FORBIDDEN/) }
    await as(null, 'anon'); await expect(query('select public.get_outlook_configuration()')).rejects.toThrow(/permission denied/)
  }))

  it('관리자만 앱·디렉터리 ID를 저장하고 본사는 공개 식별자만 조회한다', async () => isolated(async () => {
    const result = await configuration()
    expect(result).toMatchObject({ clientId, tenantId, version: 1 })
    await as(DEMO_IDS.internal)
    expect((await query('select public.get_outlook_configuration() item')).rows[0].item).toEqual(result)
    await expect(query('select public.save_outlook_configuration($1,$2,1,$3)', [clientId, tenantId, '직원 설정 변경'])).rejects.toThrow(/FORBIDDEN/)
    expect(Object.keys(result).sort()).toEqual(['clientId', 'tenantId', 'updatedAt', 'version'])
  }))

  it('설정 CAS·필수 ID·변경 사유를 검사하고 감사 이력을 보존한다', async () => isolated(async () => {
    await configuration()
    await expect(configuration(0)).rejects.toThrow(/VERSION_CONFLICT/)
    await expect(query('select public.save_outlook_configuration(null,$1,1,$2)', [tenantId, '앱 누락 시험'])).rejects.toThrow(/INVALID_OUTLOOK_CONFIGURATION/)
    await expect(query('select public.save_outlook_configuration($1,$2,1,$3)', [clientId, tenantId, ''])).rejects.toThrow(/REASON_REQUIRED/)
    expect((await configuration(1)).version).toBe(2)
    const audits = (await query("select before,after from public.audits where action='Outlook 발송 설정 변경' order by created_at,id")).rows
    expect(audits).toHaveLength(2)
    expect(audits.some(record => record.before?.version === 1 && record.after.version === 2)).toBe(true)
  }))

  it('서비스 키에도 설정 테이블 직접 읽기·수정과 비공개 begin 코어 호출을 허용하지 않는다', async () => isolated(async () => {
    for (const [person, role] of [[DEMO_IDS.admin, 'authenticated'], [null, 'service_role']] as const) {
      await as(person, role)
      for (const sql of ['select * from public.outlook_configuration', 'delete from public.outlook_configuration', 'select public.begin_po_dispatch_before_outlook(null,1)']) await expect(query(sql)).rejects.toThrow(/permission denied/)
    }
  }))

  it('설정 누락은 발송 시도·버전 증가 없이 차단한다', async () => isolated(async () => {
    const id = await createPo()
    await expect(begin(id)).rejects.toThrow(/OUTLOOK_CONFIGURATION_REQUIRED/)
    expect(await row(id)).toMatchObject({ status: 'draft', version: 1, attempts: 0, provider: 'resend' })
    expect((await query('select * from public.po_dispatch_attempts where dispatch_id=$1', [id])).rows).toHaveLength(0)
  }))

  it('본사 본인의 발신 이메일과 공급자를 서버에서 시도 이력에 고정한다', async () => isolated(async () => {
    await configuration(); const id = await createPo(), result = await begin(id)
    expect(result).toMatchObject({ status: 'sending', version: 2, attempts: 1, provider: 'outlook', sender_email_snapshot: senderEmail, provider_message_id: null, provider_request_id: null })
    const attempt = (await query('select * from public.po_dispatch_attempts where dispatch_id=$1', [id])).rows[0]
    expect(attempt).toMatchObject({ status: 'sending', provider: 'outlook', sender_email_snapshot: senderEmail, snapshot: { provider: 'outlook', senderEmail } })
    await expect(begin(id, 1)).rejects.toThrow(/VERSION_CONFLICT/)
    await as(DEMO_IDS.factory); await expect(begin(id, 2)).rejects.toThrow(/FORBIDDEN/)
    await as(pendingId); await expect(begin(id, 2)).rejects.toThrow(/FORBIDDEN/)
  }))

  it('승인된 본사도 Microsoft 접수를 직접 위조할 수 없다', async () => isolated(async () => {
    await configuration(); const id = await createPo(); await begin(id)
    for (const person of [DEMO_IDS.admin, DEMO_IDS.internal, DEMO_IDS.factory]) {
      await as(person); await expect(query('select public.finalize_outlook_po_dispatch($1,$2,null,$3)', [id, requestId, 'sent'])).rejects.toThrow(/permission denied/)
    }
  }))

  it('공장에는 미발송 Outlook 초안·시도·감사 원문이 노출되지 않는다', async () => isolated(async () => {
    await configuration(); const id = await createPo(); await begin(id)
    await as(DEMO_IDS.factory)
    expect((await query('select * from public.po_dispatches where id=$1', [id])).rows).toHaveLength(0)
    expect((await query('select * from public.po_dispatch_attempts where dispatch_id=$1', [id])).rows).toHaveLength(0)
    expect((await query("select * from public.audits where style_id=$1 and (action like 'PO %' or action like '%Outlook%')", [style.id])).rows).toHaveLength(0)
    await finish(id)
    await as(DEMO_IDS.factory)
    expect((await query('select * from public.po_dispatches where id=$1', [id])).rows).toHaveLength(1)
    expect((await query("select * from public.audits where style_id=$1 and action like 'PO %'", [style.id])).rows).toHaveLength(0)
  }))

  it('실제 Microsoft 추적 ID가 있는 접수만 sent로 저장하며 메시지 ID는 만들지 않는다', async () => isolated(async () => {
    await configuration(); const id = await createPo(); await begin(id)
    for (const receipt of [null, '', 'injected\r\nheader']) await expect(finish(id, 'sent', receipt)).rejects.toThrow(/Microsoft accepted response request ID/)
    const result = await finish(id)
    expect(result).toMatchObject({ status: 'sent', version: 3, provider: 'outlook', sender_email_snapshot: senderEmail, provider_message_id: null, provider_request_id: requestId })
    expect(result.sent_at).not.toBeNull()
    await as(DEMO_IDS.internal)
    expect((await query('select * from public.po_dispatch_attempts where dispatch_id=$1', [id])).rows[0]).toMatchObject({ status: 'sent', provider_message_id: null, provider_request_id: requestId })
    await expect(begin(id, 3)).rejects.toThrow(/PO_SEND_BLOCKED/)
    await expect(finish(id)).rejects.toThrow(/PO_SEND_BLOCKED/)
  }))

  it('CHECK 제약도 누락된 추적 ID와 위조 메시지 ID를 차단한다', async () => isolated(async () => {
    await configuration(); const id = await createPo(); await begin(id)
    await as(null, 'postgres')
    await expect(query("update public.po_dispatches set status='sent',sent_at=now() where id=$1", [id])).rejects.toThrow(/po_dispatches_provider_evidence/)
    await expect(query("update public.po_dispatches set status='sent',sent_at=now(),provider_message_id='fake',provider_request_id=$2 where id=$1", [id, requestId])).rejects.toThrow(/po_dispatches_provider_evidence/)
  }))

  it('결과 미확인은 재전송을 차단하고 공급자 접수를 주장하지 않는다', async () => isolated(async () => {
    await configuration(); const id = await createPo(); await begin(id)
    const result = await finish(id, 'unknown', null, 'Microsoft 응답을 확인하지 못했습니다.')
    expect(result).toMatchObject({ status: 'unknown', provider_message_id: null, provider_request_id: null, sent_at: null })
    await as(DEMO_IDS.internal); await expect(begin(id, 3)).rejects.toThrow(/PO_SEND_BLOCKED/)
    await expect(query('select public.begin_po_dispatch($1,3)', [id])).rejects.toThrow(/PO_SEND_BLOCKED/)
  }))

  it('명확한 실패만 같은 담당자·같은 공급자로 재시도하며 다른 경로의 claim은 롤백한다', async () => isolated(async () => {
    await configuration(); const id = await createPo(); await begin(id)
    await finish(id, 'failed', null, 'Microsoft가 요청을 거절했습니다.')
    await as(DEMO_IDS.internal); await expect(query('select public.begin_po_dispatch($1,3)', [id])).rejects.toThrow(/PO_PROVIDER_MISMATCH/)
    await as(DEMO_IDS.admin); await expect(begin(id, 3)).rejects.toThrow(/PO_SENDER_MISMATCH/)
    expect(await row(id)).toMatchObject({ status: 'failed', version: 3, attempts: 1 })
    await as(DEMO_IDS.internal); expect(await begin(id, 3)).toMatchObject({ status: 'sending', version: 4, attempts: 2 })
  }))

  it('기존 Resend 실패를 Outlook으로 바꾸지 않고 기존 접수 증거 계약을 유지한다', async () => isolated(async () => {
    await configuration(); const id = await createPo()
    await query('select public.begin_po_dispatch($1,1)', [id])
    await as(null, 'service_role'); await query('select public.finalize_po_dispatch($1,null,$2,$3)', [id, 'Resend rejected', 'failed'])
    await as(DEMO_IDS.internal); await expect(begin(id, 3)).rejects.toThrow(/PO_PROVIDER_MISMATCH/)
    await query('select public.begin_po_dispatch($1,3)', [id])
    await as(null, 'service_role'); await query('select public.finalize_po_dispatch($1,$2,null,$3)', [id, 'real-resend-message', 'sent'])
    expect(await row(id)).toMatchObject({ status: 'sent', provider: 'resend', provider_message_id: 'real-resend-message', provider_request_id: null })
  }))

  it('시도 원장 불일치는 접수 확정과 PO 변경을 한 트랜잭션으로 되돌린다', async () => isolated(async () => {
    await configuration(); const id = await createPo(); await begin(id)
    await as(null, 'postgres'); await query("update public.po_dispatch_attempts set sender_email_snapshot='other@example.test' where dispatch_id=$1", [id])
    await expect(finish(id)).rejects.toThrow(/attempt ledger mismatch/)
    expect(await row(id)).toMatchObject({ status: 'sending', version: 2, sent_at: null, provider_request_id: null })
  }))

  it('Outlook 접수 이후 업체 동의는 당시 발신자·공급자·추적 ID를 보존한다', async () => isolated(async () => {
    await configuration(); const id = await createPo(), runId = crypto.randomUUID()
    const data = { name: 'Outlook 발주 차수', projectId: style.projectId, projectCode: 'OUTLOOK-TEST', expectedDue: '2026-12-20', poId: id, unitCost: 1200, itemType: 'product', order: { ...emptyQuantities(), S: 10 }, correctsRunId: null }
    await query('select public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [runId, style.id, style.production[0].id, JSON.stringify(data), 'Outlook 발주 연결'])
    await begin(id); await finish(id)
    await as(DEMO_IDS.factory)
    await query('select public.accept_supplier_production_order($1,1,3,$2,true)', [runId, '2026-12-22'])
    const item = (await query('select public.get_supplier_production_orders() item')).rows.find(record => record.item.runId === runId)!.item
    expect(item.acceptance.poSnapshot).toMatchObject({ provider: 'outlook', senderEmail, providerRequestId: requestId, providerMessageId: null })
    expect(item.status).toBe('in_progress')
  }))

  it('012 재실행은 저장된 앱 설정·접수 원본과 기존 wrapper 권한을 보존한다', async () => {
    await configuration(); const id = await createPo(); await begin(id); await finish(id)
    await as(null, 'postgres'); await db.exec(migration)
    await as(DEMO_IDS.internal)
    expect((await query('select public.get_outlook_configuration() item')).rows[0].item).toMatchObject({ clientId, tenantId, version: 1 })
    expect(await row(id)).toMatchObject({ provider: 'outlook', status: 'sent', provider_message_id: null, provider_request_id: requestId })
    await expect(query('select public.begin_po_dispatch_before_outlook($1,3)', [id])).rejects.toThrow(/permission denied/)
  })
})
