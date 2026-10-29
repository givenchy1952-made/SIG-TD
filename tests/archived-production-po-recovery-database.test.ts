import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { emptyQuantities } from '../src/lib/types'

const db = new PGlite(), fixture = createSeed(), style = structuredClone(fixture.styles[1]), line = style.production[0]
const runId = crypto.randomUUID(), previousPoId = crypto.randomUUID(), poId = crypto.randomUUID()
const migration = readFileSync(new URL('../supabase/migrations/016_archived_production_po_recovery.sql', import.meta.url), 'utf8')
const quantities = { ...emptyQuantities(), S: 10 }
const poData = { dueDate: '2026-12-01', recipient: 'factory@example.test', subject: 'QA 발주 문서', body: '실제 발송 문서 원본 보존', evidenceAttachmentId: null, voided: false }
const confirmed = { documentConfirmed: true, scopeDifferenceConfirmed: true, sourceSnapshotMissingConfirmed: false, projectId: style.projectId, styleCode: `${style.code}${line.color}`, color: line.color, factoryId: style.factoryId, order: quantities }
let transaction = false, sequence = 0
async function query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  if (!transaction) return db.query<T>(sql, params)
  const savepoint = `archived_po_${sequence++}`; await db.exec(`savepoint ${savepoint}`)
  try { const result = await db.query<T>(sql, params); await db.exec(`release savepoint ${savepoint}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${savepoint};release savepoint ${savepoint}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function owner(sql: string, params: unknown[] = []) { await db.exec('reset role'); const result = await query(sql, params); await as(DEMO_IDS.admin); return result }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await as(DEMO_IDS.admin); await fn() } finally { transaction = false; await db.exec('rollback') } }
async function replace(override: Record<string, unknown> = {}, versions = [3, 2, 3], previous = previousPoId, replacement = poId) {
  return query('select public.replace_archived_production_po_link($1,$2,$3,$4,$5,$6,$7::jsonb,$8)', [runId, previous, replacement, ...versions, JSON.stringify({ ...confirmed, ...override }), '실제 발송 문서 확인 후 보관 초안 연결 교체'])
}
async function proposal() {
  return (await owner(`insert into public.production_condition_proposals(run_id,expected_delivery_date,unit_cost,can_produce,quantity_confirmed,agreed,confirmed_quantities,comment,delay_reason,price_reason,actor_id,actor_name,factory_id,run_version,po_id,po_version,terms_snapshot,po_snapshot)
    values($1,'2026-12-01',1000,true,true,true,$2::jsonb,'QA 회신','','',$3,'QA 업체',$4,3,$5,3,'{}','{}') returning id`, [runId, JSON.stringify(quantities), DEMO_IDS.factory, style.factoryId, poId])).rows[0].id
}

beforeAll(async () => {
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create schema storage;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;grant select,insert,update,delete on storage.objects to authenticated;`)
  for (const name of readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(name => /^0(?:0[1-9]|1[0-6])_.*\.sql$/.test(name)).sort()) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const item of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [item.id, item.name, item.country])
  for (const item of fixture.projects) await query('insert into public.projects(id,name,season) values($1,$2,$3)', [item.id, item.name, item.season])
  await query('update public.projects set code=$2 where id=$1', [style.projectId, 'QA-RECOVERY'])
  for (const item of fixture.profiles) { await query('insert into auth.users(id,email) values($1,$2)', [item.id, item.email]); await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [item.id, item.name, item.role, item.approved, item.active, item.factoryId]) }
  await as(DEMO_IDS.admin); style.version = 0
  await query('select public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), '보관 PO 복구 시험 품번'])
  const runData = { name: 'QA 복구 차수', projectId: style.projectId, projectCode: 'QA-RECOVERY', expectedDue: '2026-12-01', poId: null, unitCost: null, itemType: 'product', order: quantities, correctsRunId: null }
  await query('select public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [runId, style.id, line.id, JSON.stringify(runData), 'QA 차수 등록'])
  await query("select public.configure_production_conditions($1,1,0,'full_package',null,'생산 방식 설정')", [runId])
  await query('select public.create_production_order_po($1,2,$2,$3::jsonb,$4)', [runId, previousPoId, JSON.stringify(poData), 'QA 차수 초안 연결'])
  await query('select public.save_po_dispatch($1,$2,1,$3::jsonb,$4)', [previousPoId, style.id, JSON.stringify({ ...poData, voided: true }), '미발송 초안 보관'])
  await query('select public.save_po_dispatch($1,$2,0,$3::jsonb,$4)', [poId, style.id, JSON.stringify(poData), '발송할 문서 저장'])
  await query('select public.begin_po_dispatch($1,1)', [poId]); await as(null, 'service_role')
  await query("select public.finalize_po_dispatch($1,'qa-recovery-provider-message',null,'sent')", [poId]); await as(DEMO_IDS.admin)
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('016 실제 PostgreSQL 보관된 미발송 PO 연결 복구', () => {
  it('기존 저장 RPC로 연결된 초안을 복원해도 차수·문서·발송 이력은 유지하고 메일은 발송하지 않는다', async () => isolated(async () => {
    const before = (await query('select * from public.po_dispatches where id=$1', [previousPoId])).rows[0]
    const run = (await query('select * from public.production_runs where id=$1', [runId])).rows
    const contexts = (await query('select * from public.po_production_contexts order by po_id')).rows
    const attempts = (await query('select * from public.po_dispatch_attempts order by id')).rows
    await query('select public.save_po_dispatch($1,$2,2,$3::jsonb,$4)', [previousPoId, style.id, JSON.stringify(poData), '정확한 차수 발주 초안 복원'])
    const after = (await query('select * from public.po_dispatches where id=$1', [previousPoId])).rows[0]
    expect(after).toMatchObject({ ...before, voided: false, version: 3, updated_at: expect.any(Date) })
    expect((await query('select * from public.production_runs where id=$1', [runId])).rows).toEqual(run)
    expect((await query('select * from public.po_production_contexts order by po_id')).rows).toEqual(contexts)
    expect((await query('select * from public.po_dispatch_attempts order by id')).rows).toEqual(attempts)
    expect(after).toMatchObject({ status: 'draft', attempts: 0, sent_at: null })
    const conditions = (await query('select public.get_production_conditions() as item')).rows
    expect(conditions.find(item => item.item.runId === runId)!.item.status).toBe('awaiting_po')
  }))
  it('HQ 확인 후 연결만 교체하며 PO·발송 시도·수량·조건·원가를 그대로 보존한다', async () => isolated(async () => {
    const before = (await query('select * from public.production_runs where id=$1', [runId])).rows[0]
    const pos = (await query('select * from public.po_dispatches order by id')).rows
    const attempts = (await query('select * from public.po_dispatch_attempts order by id')).rows
    const conditions = (await owner('select * from public.production_conditions')).rows
    const styleBefore = (await query('select * from public.styles')).rows
    await replace()
    const after = (await query('select * from public.production_runs where id=$1', [runId])).rows[0]
    expect(after).toMatchObject({ ...before, po_id: poId, version: 4, updated_at: expect.any(Date), updated_by: DEMO_IDS.admin })
    expect((await query('select * from public.po_dispatches order by id')).rows).toEqual(pos)
    expect((await query('select * from public.po_dispatch_attempts order by id')).rows).toEqual(attempts)
    expect((await owner('select * from public.production_conditions')).rows).toEqual(conditions)
    expect((await query('select * from public.styles')).rows).toEqual(styleBefore)
    expect((await query('select * from public.production_po_recovery_audits')).rows[0]).toMatchObject({ run_id: runId, previous_po_id: previousPoId, po_id: poId, actor_id: DEMO_IDS.admin, run_before: { po_id: previousPoId, version: 3 }, previous_po_snapshot: { voided: true, status: 'draft', attempts: 0 }, po_snapshot: { status: 'sent', provider_message_id: 'qa-recovery-provider-message' }, confirmed_snapshot: confirmed })
    expect((await query('select * from public.production_po_link_audits')).rows).toHaveLength(1)
    const state = (await query('select public.get_supplier_production_orders() as item')).rows.find(item => item.item.runId === runId)!.item
    expect(state).toMatchObject({ poId, poStatus: 'sent', status: 'awaiting_acceptance' })
  }))
  it('기존 미발송 PO가 보관 상태가 아니면 연결을 변경하지 않는다', async () => isolated(async () => {
    await owner('update public.po_dispatches set voided=false where id=$1', [previousPoId])
    await expect(replace()).rejects.toThrow(/ARCHIVED_UNUSED_PO_REQUIRED/)
    expect((await query('select po_id,version from public.production_runs where id=$1', [runId])).rows[0]).toEqual({ po_id: previousPoId, version: 3 })
  }))
  it.each(['sending', 'sent', 'failed', 'unknown'])('기존 초안에 %s 상태 또는 발송 시도가 있으면 거부한다', async status => isolated(async () => {
    await owner("update public.po_dispatches set status=$2,attempts=1,sent_at=case when $2='sent' then now() else null end,provider_message_id=case when $2='sent' then 'old-proof' else null end where id=$1", [previousPoId, status])
    await expect(replace()).rejects.toThrow(/ARCHIVED_UNUSED_PO_REQUIRED/)
  }))
  it.each(['attempts=1', "sender_email_snapshot='hq@example.test'", "last_error='historical failure'"])('미발송 주장과 충돌하는 이력은 거부한다: %s', async change => isolated(async () => {
    await owner(`update public.po_dispatches set ${change} where id=$1`, [previousPoId])
    await expect(replace()).rejects.toThrow(/ARCHIVED_UNUSED_PO_REQUIRED/)
  }))
  it('attempts=0이어도 별도 발송 시도 행이 남아 있으면 교체하지 않는다', async () => isolated(async () => {
    await owner("insert into public.po_dispatch_attempts(dispatch_id,attempt,status,snapshot,started_at,actor_id) values($1,1,'failed','{}',now(),$2)", [previousPoId, DEMO_IDS.admin])
    await expect(replace()).rejects.toThrow(/ARCHIVED_UNUSED_PO_REQUIRED/)
  }))
  it.each([{ versions: [2, 2, 3] }, { versions: [3, 1, 3] }, { versions: [3, 2, 2] }])('차수·기존 PO·새 PO 중 오래된 버전은 거부한다: %j', async ({ versions }) => isolated(async () => {
    await expect(replace({}, versions)).rejects.toThrow(/VERSION_CONFLICT/)
  }))
  it('기존 연결 ID가 바뀌었거나 동일 PO로 교체하려는 요청은 거부한다', async () => isolated(async () => {
    await expect(replace({}, [3, 2, 3], crypto.randomUUID())).rejects.toThrow(/ARCHIVED_PO_LINK_CHANGED/)
    await expect(replace({}, [3, 2, 3], previousPoId, previousPoId)).rejects.toThrow(/ARCHIVED_PO_LINK_CHANGED/)
  }))
  it.each([{ documentConfirmed: false }, { scopeDifferenceConfirmed: false }, { projectId: crypto.randomUUID() }, { color: 'ZZ' }, { styleCode: 'OTHER-FULL-SKU' }, { factoryId: crypto.randomUUID() }, { order: { ...quantities, S: 11 } }])('015 문서·수량 검증 실패 시 임시 해제와 모든 감사 기록도 되돌린다: %j', async override => isolated(async () => {
    await expect(replace(override)).rejects.toThrow(/CONFIRMATION_REQUIRED|INVALID_PO_LINK/)
    expect((await query('select po_id,version from public.production_runs where id=$1', [runId])).rows[0]).toEqual({ po_id: previousPoId, version: 3 })
    expect((await query('select * from public.production_po_recovery_audits')).rows).toEqual([])
    expect((await query('select * from public.production_po_link_audits')).rows).toEqual([])
  }))
  it('새 PO가 발송 완료 상태가 아니면 원래 연결을 유지한다', async () => isolated(async () => {
    await owner("update public.po_dispatches set status='draft',sent_at=null,provider_message_id=null where id=$1", [poId])
    await expect(replace()).rejects.toThrow(/PO_NOT_SENT/)
    expect((await query('select po_id,version from public.production_runs where id=$1', [runId])).rows[0]).toEqual({ po_id: previousPoId, version: 3 })
  }))
  it('새 PO가 다른 차수에 연결됐으면 기존 연결과 감사 기록을 되돌린다', async () => isolated(async () => {
    await owner('insert into public.production_runs select (jsonb_populate_record(null::public.production_runs,to_jsonb(r)||$2::jsonb)).* from public.production_runs r where id=$1', [runId, JSON.stringify({ id: crypto.randomUUID(), round: 2, po_id: poId })])
    await expect(replace()).rejects.toThrow(/DUPLICATE_PO_LINK/)
    expect((await query('select po_id,version from public.production_runs where id=$1', [runId])).rows[0]).toEqual({ po_id: previousPoId, version: 3 })
    expect((await query('select * from public.production_po_recovery_audits')).rows).toEqual([])
  }))
  it('동일 보관 초안을 공유하는 다른 차수가 있으면 임의로 연결을 교체하지 않는다', async () => isolated(async () => {
    await owner('insert into public.production_runs select (jsonb_populate_record(null::public.production_runs,to_jsonb(r)||$2::jsonb)).* from public.production_runs r where id=$1', [runId, JSON.stringify({ id: crypto.randomUUID(), round: 2, line_id: crypto.randomUUID() })])
    await expect(replace()).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('새 PO가 보관되었거나 원본 프로젝트가 다르면 원래 연결을 유지한다', async () => isolated(async () => {
    await owner('update public.po_dispatches set voided=true where id=$1', [poId])
    await expect(replace()).rejects.toThrow(/PO_NOT_SENT/)
    await owner('update public.po_dispatches set voided=false where id=$1', [poId])
    await owner('update public.production_runs set project_code=$2 where id=$1', [runId, 'OTHER'])
    await expect(replace()).rejects.toThrow(/INVALID_PO_LINK/)
    expect((await query('select po_id from public.production_runs where id=$1', [runId])).rows[0].po_id).toBe(previousPoId)
  }))
  it('같은 공장이 아니거나 현재 배정이 달라졌다면 교체하지 않는다', async () => isolated(async () => {
    await owner('update public.po_dispatches set factory_id_snapshot=$2 where id=$1', [previousPoId, DEMO_IDS.vietnam])
    await expect(replace()).rejects.toThrow(/ASSIGNMENT_CHANGED/)
  }))
  it('이미 제출된 과거 제안 행은 현재 proposal_id가 비어 있어도 보호한다', async () => isolated(async () => {
    await proposal(); await expect(replace()).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('본사 승인 이력이 있으면 보호한다', async () => isolated(async () => {
    const id = await proposal()
    await owner("insert into public.production_condition_approvals(run_id,proposal_id,final_delivery_date,unit_cost,approved_by,approved_by_name,reason,terms_snapshot,po_snapshot) values($1,$2,'2026-12-01',1000,$3,'QA 본사','과거 승인','{}','{}')", [runId, id, DEMO_IDS.admin])
    await expect(replace()).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('이전 생산 동의와 시작 이력은 보호한다', async () => isolated(async () => {
    const acceptance = (await owner("insert into public.production_order_acceptances(run_id,factory_id,actor_id,actor_name,actor_email,expected_delivery_date,run_version_snapshot,po_id,po_version,po_snapshot,terms_snapshot) values($1,$2,$3,'QA 업체','factory@example.test','2026-12-01',3,$4,3,'{}','{}') returning id", [runId, style.factoryId, DEMO_IDS.factory, poId])).rows[0].id
    await owner("insert into public.production_order_starts(run_id,acceptance_id,started_by,started_by_name) values($1,$2,$3,'QA 본사')", [runId, acceptance, DEMO_IDS.admin])
    await expect(replace()).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('이전 방식 시작과 변경 요청은 각각 보호한다', async () => isolated(async () => {
    await owner("insert into public.production_condition_legacy_starts(run_id,start_snapshot,acceptance_snapshot) values($1,'{}','{}')", [runId])
    await expect(replace()).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('승인 전이라도 변경 요청 이력이 있으면 보호한다', async () => isolated(async () => {
    await owner("insert into public.production_condition_changes(run_id,legacy,reason,actor_id,actor_name,terms_snapshot) values($1,false,'QA 과거 변경 요청',$2,'QA 본사','{}')", [runId, DEMO_IDS.admin])
    await expect(replace()).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('이미 마감됐거나 취소된 입고 이력이 있어도 보호한다', async () => isolated(async () => {
    // Simulate a historical receipt imported before the current start guard.
    await db.exec('reset role;alter table public.production_receipts disable trigger production_receipts_require_start')
    await query("insert into public.production_receipts(id,run_id,style_id,line_id,received_at,quantities,unit_cost,net_amount,voided,version,created_by) values($1,$2,$3,$4,'2026-12-01',$5::jsonb,1000,10000,true,1,$6)", [crypto.randomUUID(), runId, style.id, line.id, JSON.stringify(quantities), DEMO_IDS.admin])
    await db.exec('alter table public.production_receipts enable trigger production_receipts_require_start'); await as(DEMO_IDS.admin)
    await expect(replace()).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('이미 마감된 차수는 연결 교체로 다시 열 수 없다', async () => isolated(async () => {
    await db.exec('reset role;alter table public.production_runs disable trigger production_run_close_require_start')
    await query("update public.production_runs set closed_at=now(),snapshot='{}' where id=$1", [runId])
    await db.exec('alter table public.production_runs enable trigger production_run_close_require_start'); await as(DEMO_IDS.admin)
    await expect(replace()).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('공장·미승인·비활성·익명·서비스 키는 우회할 수 없다', async () => isolated(async () => {
    for (const id of [DEMO_IDS.factory, fixture.profiles.find(item => !item.approved)!.id]) {
      await as(id); await expect(replace()).rejects.toThrow(/FORBIDDEN/)
      expect((await query('select public.get_archived_production_po_recovery_capability() as enabled')).rows[0].enabled).toBe(false)
      expect((await query('select * from public.production_po_recovery_audits')).rows).toEqual([])
    }
    await owner('update public.profiles set active=false where id=$1', [DEMO_IDS.admin]); await expect(replace()).rejects.toThrow(/FORBIDDEN/)
    for (const role of ['anon', 'service_role']) { await as(null, role); await expect(replace()).rejects.toThrow(/permission denied/) }
  }))
  it('복구 감사 기록은 본사만 읽을 수 있고 관리자 SQL로도 변경·삭제할 수 없다', async () => isolated(async () => {
    await replace()
    await expect(query("update public.production_po_recovery_audits set reason='rewrite'")).rejects.toThrow(/permission denied/)
    await as(DEMO_IDS.factory); expect((await query('select * from public.production_po_recovery_audits')).rows).toEqual([])
    await db.exec('reset role')
    await expect(query("update public.production_po_recovery_audits set reason='rewrite'")).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(query('delete from public.production_po_recovery_audits')).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('재실행은 복구 기록과 연결을 변경하지 않으며 같은 요청 재호출은 거부한다', async () => {
    await as(DEMO_IDS.admin); await replace()
    const audits = (await query('select * from public.production_po_recovery_audits')).rows
    await db.exec('reset role'); await db.exec(migration); await as(DEMO_IDS.admin)
    expect((await query('select * from public.production_po_recovery_audits')).rows).toEqual(audits)
    expect((await query('select po_id,version from public.production_runs where id=$1', [runId])).rows[0]).toEqual({ po_id: poId, version: 4 })
    await expect(replace()).rejects.toThrow(/ARCHIVED_PO_LINK_CHANGED/)
  })
})
