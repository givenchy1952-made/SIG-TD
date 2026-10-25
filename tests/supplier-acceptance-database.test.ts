import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { emptyQuantities } from '../src/lib/types'

const db = new PGlite(), fixture = createSeed(), style = structuredClone(fixture.styles[1]), line = style.production[0]
const secondFactory = '95000000-0000-4000-8000-000000000001', pending = '95000000-0000-4000-8000-000000000002'
const runId = '95000000-0000-4000-8000-000000000003', poId = '95000000-0000-4000-8000-000000000004'
let transaction = false, seq = 0
async function query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  if (!transaction) return db.query<T>(sql, params)
  const point = `supplier_${seq++}`; await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(sql, params); await db.exec(`release savepoint ${point}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await fn() } finally { transaction = false; await db.exec('rollback') } }
const runInput = () => ({ name: '리오더 1차', projectId: style.projectId, projectCode: 'TEST-PROJECT', expectedDue: '2026-12-20', poId, unitCost: 12000, itemType: 'product', order: { ...emptyQuantities(), S: 10 }, correctsRunId: null })
async function view() { return (await query<{ item: any }>('select public.get_supplier_production_orders() item')).rows.map(row => row.item) }
async function accept(runVersion = 1, poVersion = 3, date = '2026-12-22', agreed: boolean | null = true) { return query('select public.accept_supplier_production_order($1,$2,$3,$4,$5) id', [runId, runVersion, poVersion, date, agreed]) }
async function start(version = 2) { return query('select public.start_supplier_production_run($1,$2)', [runId, version]) }
async function receive(version = 2) { return query('select * from public.allocate_production_receipt($1,$2,$3::jsonb,$4,$5)', [crypto.randomUUID(), runId, JSON.stringify({ receivedAt: '2026-12-23', quantities: { ...emptyQuantities(), S: 3 } }), version, '생산 차수 실입고']) }
async function sent() {
  await as(DEMO_IDS.admin); await query('select public.begin_po_dispatch($1,1)', [poId])
  await as(null, 'service_role'); await query('select public.finalize_po_dispatch($1,$2,null,$3)', [poId, 'test-provider-message', 'sent'])
}
async function accepted() { await sent(); await as(DEMO_IDS.factory); await accept() }
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
  for (const name of ['001_initial.sql', '002_style_images.sql', '003_operations.sql', '004_settlement_terms.sql', '005_workflow_refinements.sql', '006_staff_approvals.sql', '007_production_ledger.sql', '008_supplier_acceptance.sql']) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const item of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [item.id, item.name, item.country])
  for (const item of fixture.projects) await query('insert into public.projects(id,name,season) values($1,$2,$3)', [item.id, item.name, item.season])
  for (const item of fixture.profiles) {
    await query('insert into auth.users(id,email) values($1,$2)', [item.id, item.email])
    await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [item.id, item.name, item.role, item.approved, item.active, item.factoryId])
  }
  for (const id of [secondFactory, pending]) await query('insert into auth.users(id,email) values($1,$2)', [id, `${id}@example.test`])
  await query("update public.profiles set name='B공장',role='factory',approved=true,factory_id=$2 where id=$1", [secondFactory, DEMO_IDS.korea])
  await as(DEMO_IDS.admin); style.version = 0
  await query('select * from public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), '업체 생산 동의 테스트'])
  await query('select * from public.save_po_dispatch($1,$2,0,$3::jsonb,$4)', [poId, style.id, JSON.stringify({ dueDate: '2026-12-20', recipient: 'factory@example.test', subject: '리오더 요청 납기 2026-12-20', body: '확정 PO 요청 내역', evidenceAttachmentId: null, voided: false }), '발송 초안 저장'])
  await query('select * from public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [runId, style.id, line.id, JSON.stringify(runInput()), '프로젝트별 차수 생성'])
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('008 실제 PostgreSQL 업체 PO 확인·예상 납기·생산 동의', () => {
  it('초안만으로 생산 동의·생산 시작·실입고를 허용하지 않는다', async () => isolated(async () => {
    await as(DEMO_IDS.factory); expect((await view())[0]).toMatchObject({ status: 'awaiting_po', subject: '', body: '', requestedDue: '' })
    expect((await query('select * from public.po_dispatches')).rows).toHaveLength(0)
    expect((await query("select * from public.audits where action like 'PO %'")).rows).toHaveLength(0)
    await expect(accept()).rejects.toThrow(/PO_NOT_SENT/)
    await as(DEMO_IDS.admin); await expect(start(1)).rejects.toThrow(/SUPPLIER_ACCEPTANCE_REQUIRED/)
    await expect(receive(1)).rejects.toThrow(/PRODUCTION_NOT_STARTED/)
  }))
  it('본사·관리자는 업체 대신 동의할 수 없다', async () => isolated(async () => {
    await sent()
    for (const actor of [DEMO_IDS.admin, DEMO_IDS.internal]) { await as(actor); await expect(accept()).rejects.toThrow(/FORBIDDEN/) }
  }))
  it('A공장만 자기 PO를 읽고 B공장·미승인·익명은 접근할 수 없다', async () => isolated(async () => {
    await sent(); await as(DEMO_IDS.factory); expect((await view())[0].status).toBe('awaiting_acceptance')
    await as(secondFactory); expect(await view()).toEqual([]); await expect(accept()).rejects.toThrow(/FORBIDDEN/)
    await as(pending); await expect(view()).rejects.toThrow(/FORBIDDEN/); await expect(accept()).rejects.toThrow(/FORBIDDEN/)
    await as(null, 'anon'); await expect(view()).rejects.toThrow(/permission denied/)
  }))
  it('명시 동의·정상 납기일·현재 run/PO 버전 모두 필요하다', async () => isolated(async () => {
    await sent(); await as(DEMO_IDS.factory)
    for (const agreed of [false, null]) await expect(accept(1, 3, '2026-12-22', agreed)).rejects.toThrow(/AGREEMENT_REQUIRED/)
    for (const date of ['', '2026-02-30', '2026-12-22 00:00', 'not-a-date']) await expect(accept(1, 3, date)).rejects.toThrow(/DATE|date/)
    await expect(accept(0)).rejects.toThrow(/VERSION_CONFLICT/); await expect(accept(1, 2)).rejects.toThrow(/VERSION_CONFLICT/)
  }))
  it('발송 당시 PO·수량·프로젝트와 업체 계정·시간·예상 납기를 보존한다', async () => isolated(async () => {
    await accepted(); const order = (await view())[0]
    expect(order.runVersion).toBe(2); expect(order.status).toBe('in_progress')
    expect(order.acceptance).toMatchObject({ actorId: DEMO_IDS.factory, actorEmail: 'factory@example.test', expectedDeliveryDate: '2026-12-22', runVersion: 1, poVersion: 3 })
    expect(order.acceptance.poSnapshot).toMatchObject({ id: poId, body: '확정 PO 요청 내역', dueDate: '2026-12-20', providerMessageId: 'test-provider-message' })
    expect(order.acceptance.termsSnapshot).toMatchObject({ projectId: style.projectId, projectCode: 'TEST-PROJECT', order: { ...emptyQuantities(), S: 10 }, expectedDue: '2026-12-20', round: 1 })
    expect(Number.isFinite(Date.parse(order.acceptance.acceptedAt))).toBe(true)
    for (const field of ['unitCost', 'netAmount', 'vatAmount', 'grossAmount', 'snapshot']) expect(order).not.toHaveProperty(field)
    expect(JSON.stringify(order.acceptance)).not.toContain('12000')
  }))
  it('동의 이력을 직접 읽거나 수정·삭제·위조할 수 없다', async () => isolated(async () => {
    await accepted()
    for (const actor of [DEMO_IDS.factory, DEMO_IDS.internal, DEMO_IDS.admin]) {
      await as(actor)
      for (const sql of ['select * from public.production_order_acceptances', 'delete from public.production_order_acceptances', 'update public.production_order_acceptances set actor_name=\'위조\'', 'select * from public.production_order_starts']) await expect(query(sql)).rejects.toThrow(/permission denied/)
    }
    await as(DEMO_IDS.factory); await expect(accept(2)).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('동의 후 생산조건은 고정하고 금액을 노출하지 않으며 버전만 증가시킨다', async () => isolated(async () => {
    await accepted(); await as(DEMO_IDS.admin)
    for (const changed of [{ expectedDue: '2026-12-30' }, { order: { ...emptyQuantities(), S: 11 } }, { poId: null }]) await expect(query('select public.save_production_run($1,$2,$3,$4::jsonb,2,$5)', [runId, style.id, line.id, JSON.stringify({ ...runInput(), ...changed }), '동의 후 조건 변경'])).rejects.toThrow(/HISTORY_PROTECTED/)
    await query('select public.save_production_run($1,$2,$3,$4::jsonb,2,$5)', [runId, style.id, line.id, JSON.stringify({ ...runInput(), unitCost: 13000 }), '입고 전 단가 입력'])
    await as(DEMO_IDS.factory); const order = (await view())[0]; expect(order.runVersion).toBe(3); expect(order.acceptance.runVersion).toBe(1); expect(JSON.stringify(order)).not.toContain('13000')
  }))
  it('업체 동의와 같은 트랜잭션에서 생산을 시작하고 실입고·확정 마감을 기록한다', async () => isolated(async () => {
    await accepted(); await expect(start()).rejects.toThrow(/FORBIDDEN/)
    const startedOrder = (await view())[0]; expect(startedOrder.status).toBe('in_progress'); expect(startedOrder.runVersion).toBe(2); expect(startedOrder.startedBy).toBe(DEMO_IDS.factory)
    expect(startedOrder.startedAt).toBe(startedOrder.acceptance.acceptedAt)
    await as(DEMO_IDS.internal); await expect(start(2)).rejects.toThrow(/HISTORY_PROTECTED/)
    await as(DEMO_IDS.admin); await receive(); await query('select public.finalize_production_run($1,3,$2)', [runId, '차수 마감 확정'])
    const order = (await view())[0]; expect(order.status).toBe('closed'); expect(order.acceptance.expectedDeliveryDate).toBe('2026-12-22')
  }))
  it('업체 동의 전이라도 발송을 시도한 PO의 생산조건은 바꿀 수 없다', async () => isolated(async () => {
    await sent(); await as(DEMO_IDS.admin)
    await expect(query('select public.save_production_run($1,$2,$3,$4::jsonb,1,$5)', [runId, style.id, line.id, JSON.stringify({ ...runInput(), order: { ...emptyQuantities(), S: 11 } }), '발송 후 수량 변경'])).rejects.toThrow(/HISTORY_PROTECTED/)
    await query('select public.save_production_run($1,$2,$3,$4::jsonb,1,$5)', [runId, style.id, line.id, JSON.stringify({ ...runInput(), unitCost: 13000 }), '입고 전 단가 입력'])
    await as(DEMO_IDS.factory); await accept(2)
    expect((await view())[0].acceptance.termsSnapshot.order.S).toBe(10)
  }))
  it('PO 초안 생성과 차수 연결은 원자적이며 본사만 가능하고 메일 발송을 주장하지 않는다', async () => isolated(async () => {
    await as(DEMO_IDS.admin)
    const id = crypto.randomUUID(), newPo = crypto.randomUUID(), rejectedPo = crypto.randomUUID()
    await query('select public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [id, style.id, line.id, JSON.stringify({ ...runInput(), poId: null, expectedDue: '' }), '미발송 새 차수'])
    const data = { dueDate: '2026-12-24', recipient: 'factory@example.test', subject: '새 차수 PO', body: '새 차수 생산 요청', evidenceAttachmentId: null, voided: false }
    await as(DEMO_IDS.factory); await expect(query('select public.create_production_order_po($1,1,$2,$3::jsonb,$4)', [id, newPo, JSON.stringify(data), 'PO 초안 작성'])).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.internal); await query('select public.create_production_order_po($1,1,$2,$3::jsonb,$4)', [id, newPo, JSON.stringify(data), 'PO 초안 작성'])
    const order = (await view()).find(order => order.runId === id)
    expect(order).toMatchObject({ poId: newPo, runVersion: 2, expectedDue: '2026-12-24', poStatus: 'draft', status: 'awaiting_po', sentAt: null })
    await expect(query('select public.create_production_order_po($1,1,$2,$3::jsonb,$4)', [id, rejectedPo, JSON.stringify(data), '중복 초안 작성'])).rejects.toThrow(/VERSION_CONFLICT/)
    expect((await query('select * from public.po_dispatches where id=$1', [rejectedPo])).rows).toHaveLength(0)
    await as(DEMO_IDS.factory); expect((await view()).find(order => order.runId === id)).toMatchObject({ subject: '', body: '', status: 'awaiting_po' })
  }))
  it('공장 재배정 시 이전 업체·새 업체 모두 과거 발주를 승인할 수 없고 본사만 이력을 확인한다', async () => isolated(async () => {
    await accepted(); await as(DEMO_IDS.admin)
    const current = (await query<{ data: any }>('select data from public.styles where id=$1', [style.id])).rows[0].data
    current.factoryId = DEMO_IDS.korea
    await query('select public.save_style($1,$2::jsonb,1,$3)', [style.id, JSON.stringify(current), '공장 재배정'])
    expect((await view())[0].status).toBe('assignment_changed'); await expect(start()).rejects.toThrow(/ASSIGNMENT_CHANGED/)
    for (const actor of [DEMO_IDS.factory, secondFactory]) { await as(actor); expect(await view()).toEqual([]); await expect(accept(2)).rejects.toThrow(/FORBIDDEN/) }
  }))
  it('다른 프로젝트로 공장을 바꿔도 본사는 이미 동의·생산 시작한 이전 업체 차수의 실입고·마감을 보존한다', async () => isolated(async () => {
    await accepted(); await as(DEMO_IDS.admin)
    const current = (await query<{ data: any }>('select data from public.styles where id=$1', [style.id])).rows[0].data
    const nextProject = fixture.projects.find(item => item.id !== style.projectId)!, nextRunId = crypto.randomUUID()
    current.factoryId = DEMO_IDS.korea; current.projectId = nextProject.id; current.season = nextProject.season
    await query('select public.save_style($1,$2::jsonb,1,$3)', [style.id, JSON.stringify(current), 'B 프로젝트 공장 배정'])
    await query('select public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [nextRunId, style.id, line.id, JSON.stringify({ ...runInput(), projectId: nextProject.id, projectCode: 'PROJECT-B', poId: null, unitCost: 14000 }), 'B 프로젝트 신규 차수'])
    expect((await view()).find(order => order.runId === runId)?.status).toBe('assignment_changed')
    await as(DEMO_IDS.factory); expect(await view()).toEqual([])
    expect((await query('select * from public.styles')).rows).toHaveLength(0)
    expect((await query('select * from public.production_runs')).rows).toHaveLength(0)
    await as(secondFactory); expect((await view()).map(order => order.runId)).toEqual([nextRunId])
    expect((await query('select * from public.production_runs')).rows).toHaveLength(0)
    await expect(accept(2)).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.admin); await receive()
    const closed = (await query('select * from public.finalize_production_run($1,3,$2)', [runId, '이전 업체 입고 대조 후 마감'])).rows[0]
    expect(closed.snapshot).toMatchObject({ projectId: style.projectId, factoryIdSnapshot: style.factoryId, factory: fixture.factories.find(item => item.id === style.factoryId)!.name, unitCost: 12000, receivedQuantity: 3, netAmount: 36000 })
    const newRun = (await query('select * from public.production_runs where id=$1', [nextRunId])).rows[0]
    expect(newRun).toMatchObject({ project_id: nextProject.id, factory_id_snapshot: DEMO_IDS.korea, version: 1, closed_at: null })
    expect(Number(newRun.unit_cost)).toBe(14000)
  }))
  it('승인 취소·비활성화 후 즉시 업무 접근이 차단된다', async () => isolated(async () => {
    await sent(); await db.exec('reset role')
    await query('update public.profiles set approved=false where id=$1', [DEMO_IDS.factory])
    await as(DEMO_IDS.factory); await expect(accept()).rejects.toThrow(/FORBIDDEN/); await expect(view()).rejects.toThrow(/FORBIDDEN/)
  }))
  it('같은 품번의 프로젝트별 차수를 분리하고 A·B공장이 자기 발주만 조회한다', async () => isolated(async () => {
    await as(DEMO_IDS.admin)
    const projectId = fixture.projects[1].id, nextRun = crypto.randomUUID()
    await query('select public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [nextRun, style.id, line.id, JSON.stringify({ ...runInput(), projectId, projectCode: 'REORDER-PROJECT', poId: null }), '다른 프로젝트 리오더'])
    const bStyle = { ...structuredClone(style), id: crypto.randomUUID(), code: `${style.code}B`, projectId, factoryId: DEMO_IDS.korea, version: 0 }
    await query('select public.save_style($1,$2::jsonb,0,$3)', [bStyle.id, JSON.stringify(bStyle), 'B공장 스타일 등록'])
    await query('select public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [crypto.randomUUID(), bStyle.id, bStyle.production[0].id, JSON.stringify({ ...runInput(), projectId, projectCode: 'REORDER-PROJECT', poId: null }), 'B공장 발주 등록'])
    const all = await view(); expect(all).toHaveLength(3)
    expect(all.filter(order => order.styleId === style.id).map(order => [order.projectCode, order.round])).toEqual([['TEST-PROJECT', 1], ['REORDER-PROJECT', 1]])
    await as(DEMO_IDS.factory); expect((await view()).map(order => order.projectCode)).toEqual(['TEST-PROJECT', 'REORDER-PROJECT'])
    await as(secondFactory); expect((await view()).map(order => order.styleId)).toEqual([bStyle.id])
    expect((await query('select * from public.production_runs')).rows).toHaveLength(0)
  }))
  it('클라이언트가 내부 스냅샷·트리거 함수에 접근할 수 없다', async () => isolated(async () => {
    await as(DEMO_IDS.admin)
    await expect(query('select public.supplier_order_terms(null::public.production_runs)')).rejects.toThrow(/permission denied/)
    await expect(query('select public.supplier_order_po_snapshot(null::public.po_dispatches)')).rejects.toThrow(/permission denied/)
  }))
})
