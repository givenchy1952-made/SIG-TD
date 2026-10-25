import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { emptyQuantities } from '../src/lib/types'

const db = new PGlite(), fixture = createSeed(), style = structuredClone(fixture.styles[0]), otherStyle = structuredClone(fixture.styles[1])
const projectId = style.projectId, otherProjectId = fixture.projects.find(project => project.id !== projectId)!.id
const lineId = style.production[0].id, factoryId = style.factoryId, pendingId = crypto.randomUUID()
const factoryA = { id: crypto.randomUUID(),factoryId },factoryB = { id:crypto.randomUUID(),factoryId: fixture.factories.find(item => item.id !== factoryId)!.id }
const quantities = (quantity: number) => ({ XXS: quantity, XS: quantity, S: quantity, M: quantity, L: quantity, XL: quantity })
const input = (overrides: Record<string, unknown> = {}) => ({ name: '1차 생산', projectId, projectCode: 'PROJECT-A', expectedDue: '2026-11-20', poId: null, unitCost: 1250.25, itemType: 'product', order: quantities(10), correctsRunId: null, ...overrides })
let inTransaction = false, seq = 0
async function query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  if (!inTransaction) return db.query<T>(sql, params)
  const point = `ledger_${seq++}`;await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(sql, params);await db.exec(`release savepoint ${point}`);return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`);throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`);await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function isolated(fn: () => Promise<void>) { await db.exec('begin');inTransaction = true;try { await as(DEMO_IDS.admin);await fn() } finally { inTransaction = false;await db.exec('rollback') } }
async function save(id = crypto.randomUUID(), data = input(), version = 0, styleArg = style.id, lineArg = lineId) { return (await query('select * from public.save_production_run($1,$2,$3,$4::jsonb,$5,$6)', [id, styleArg, lineArg, JSON.stringify(data), version, '생산 차수 검증'])).rows[0] }
async function receive(runId: string, version = 1, count = 2, id = crypto.randomUUID(), data = { receivedAt: '2026-11-01', quantities: quantities(count) }) { return (await query('select * from public.allocate_production_receipt($1,$2,$3::jsonb,$4,$5)', [id, runId, JSON.stringify(data), version, '실입고 수량 확인'])).rows[0] }
async function close(runId: string, version = 2) { return (await query('select * from public.finalize_production_run($1,$2,$3)', [runId, version, '입고 대조 후 마감 확정'])).rows[0] }
async function voidReceipt(id: string, runId: string, receiptVersion = 1, runVersion = 2) { return (await query('select * from public.void_production_receipt($1,$2,$3,$4,$5)', [id, runId, receiptVersion, runVersion, '입고 오류 정정'])).rows[0] }
async function makePo(targetStyle = style.id) {
  const id = crypto.randomUUID()
  await query('select * from public.save_po_dispatch($1,$2,0,$3::jsonb,$4)', [id, targetStyle, JSON.stringify({ dueDate: '2026-11-15', recipient: 'factory@example.test', subject: '생산 요청', body: '납기일: 2026-11-15', evidenceAttachmentId: null, voided: false }), 'PO 발송 초안 작성'])
  return id
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
  for (const name of ['001_initial.sql','002_style_images.sql','003_operations.sql','004_settlement_terms.sql','005_workflow_refinements.sql','006_staff_approvals.sql','007_production_ledger.sql']) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const item of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [item.id,item.name,item.country])
  for (const item of fixture.projects) await query('insert into public.projects(id,name,season,code) values($1,$2,$3,$4)', [item.id,item.name,item.season,item.id === projectId ? 'PROJECT-A' : item.id === otherProjectId ? 'PROJECT-B' : ''])
  for (const item of fixture.profiles) {
    await query('insert into auth.users(id,email) values($1,$2)', [item.id,item.email])
    await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [item.id,item.name,item.role,item.approved,item.active,item.factoryId])
  }
  await query('insert into auth.users(id,email) values($1,$2)', [pendingId,'pending@example.test'])
  for (const item of [factoryA,factoryB]) { await query('insert into auth.users(id,email) values($1,$2)',[item.id,`${item.id}@example.test`]);await query("update public.profiles set role='factory',approved=true,active=true,factory_id=$2 where id=$1",[item.id,item.factoryId]) }
  await as(DEMO_IDS.admin)
  for (const item of [style, otherStyle]) { item.version = 0;await query('select * from public.save_style($1,$2::jsonb,0,$3)', [item.id,JSON.stringify(item),'차수별 정산 테스트 스타일']) }
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('007 실제 PostgreSQL 프로젝트·생산 차수별 단가와 확정 마감', () => {
  it('기존 스타일 수량에서 차수나 입고를 자동 생성하지 않는다', async () => isolated(async () => {
    expect((await query('select * from public.production_runs')).rows).toHaveLength(0)
    expect((await query('select * from public.production_receipts')).rows).toHaveLength(0)
  }))
  it('본사 생성 시 프로젝트·업체·담당자·품번을 고정하고 버전을 부여한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal);const run = await save()
    expect(run).toMatchObject({ project_id: projectId, project_code: 'PROJECT-A', round: 1, version: 1, unit_cost: '1250.25', factory_id_snapshot: factoryId, owner_id_snapshot: style.ownerId, style_code_snapshot: style.code + style.production[0].color, closed_at: null, snapshot: null })
    expect((await query('select public.get_production_ledger_capability() enabled')).rows[0].enabled).toBe(true)
  }))
  it('같은 품번의 프로젝트별 차수와 오더를 독립적으로 보존한다', async () => isolated(async () => {
    const first = await save(), second = await save(), third = await save(crypto.randomUUID(),input({ projectId: otherProjectId, projectCode: 'PROJECT-B' }))
    expect([first.round,second.round,third.round]).toEqual([1,2,1])
    expect((await query('select count(*)::int count from public.production_runs')).rows[0].count).toBe(3)
  }))
  it('현재 메인 생산의 오더·입고보다 많아도 각 차수 오더 이내 실입고를 기록한다', async () => isolated(async () => {
    await db.exec('reset role');const low = structuredClone(style);low.production[0].order=emptyQuantities();low.production[0].received=emptyQuantities()
    await query('update public.styles set data=$2::jsonb where id=$1',[style.id,JSON.stringify(low)]);await as(DEMO_IDS.admin)
    const first = await save(), second = await save(crypto.randomUUID(),input({ projectId: otherProjectId, projectCode: 'PROJECT-B' }))
    await receive(first.id,1,10);await receive(second.id,1,10)
    expect((await query('select sum(net_amount) amount from public.production_receipts')).rows[0].amount).toBe('150030.00')
    expect((await query('select data from public.styles where id=$1',[style.id])).rows[0].data.production[0].received).toEqual(emptyQuantities())
  }))
  it('공장 A·B는 단가·실입고·마감 및 비공개 변경 이력을 조회하거나 수정하지 못한다', async () => isolated(async () => {
    const run = await save();await receive(run.id)
    for (const factory of [factoryA,factoryB]) {
      await as(factory.id)
      for (const table of ['production_runs','production_receipts','production_run_audits']) expect((await query(`select * from public.${table}`)).rows).toHaveLength(0)
      expect((await query('select public.get_production_ledger_capability() enabled')).rows[0].enabled).toBe(false)
      await expect(save()).rejects.toThrow(/FORBIDDEN/);await expect(receive(run.id,2)).rejects.toThrow(/FORBIDDEN/);await expect(close(run.id)).rejects.toThrow(/FORBIDDEN/)
    }
  }))
  it('미승인·비활성 계정은 기존 세션에서도 접근하지 못한다', async () => isolated(async () => {
    const run = await save();await as(pendingId);await expect(save()).rejects.toThrow(/FORBIDDEN/)
    await db.exec('reset role');await query('update public.profiles set active=false where id=$1',[DEMO_IDS.internal]);await as(DEMO_IDS.internal)
    await expect(save()).rejects.toThrow(/FORBIDDEN/);expect((await query('select * from public.production_runs where id=$1',[run.id])).rows).toHaveLength(0)
    await as(null,'anon');await expect(query('select public.get_production_ledger_capability()')).rejects.toThrow(/permission denied/)
  }))
  it('승인된 본사는 초안·확정만 관리하며 실제 입고 기록과 무효는 관리자만 한다', async () => isolated(async () => {
    const run = await save();await as(DEMO_IDS.internal);await expect(receive(run.id)).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.admin);const receipt = await receive(run.id);await as(DEMO_IDS.internal)
    await expect(voidReceipt(receipt.id,run.id)).rejects.toThrow(/FORBIDDEN/)
    expect((await close(run.id)).closed_at).not.toBeNull()
  }))
  it('생성·수정 JSON의 누락·추가 키와 잘못된 타입을 거부한다', async () => isolated(async () => {
    for (const data of [input({ extra: true }),input({ name: null }),input({ unitCost: '1250' }),input({ itemType: 'other' }),input({ expectedDue: '2026-02-30' }),input({ name: 'bad\nname' })]) await expect(save(crypto.randomUUID(),data)).rejects.toThrow(/INVALID|date\/time/)
    const data = input();delete (data as Record<string,unknown>).poId;await expect(save(crypto.randomUUID(),data)).rejects.toThrow(/INVALID/)
  }))
  it('수량은 XXS~XL 여섯 개 정수이며 금액·정밀도 한도를 지킨다', async () => isolated(async () => {
    for (const data of [input({ order: { ...quantities(1), S: 1.5 } }),input({ order: { ...quantities(1), XXL: 1 } }),input({ order: quantities(-1) }),input({ unitCost: 1.001 }),input({ unitCost: -1 }),input({ unitCost: 1_000_000_001 }),input({ unitCost: 1_000_000_000, order: quantities(10_000_000) })]) await expect(save(crypto.randomUUID(),data)).rejects.toThrow(/INVALID/)
  }))
  it('존재하는 프로젝트·생산 컬러 및 일치하는 프로젝트 코드만 허용한다', async () => isolated(async () => {
    await expect(save(crypto.randomUUID(),input({ projectId: crypto.randomUUID() }))).rejects.toThrow(/INVALID_PRODUCTION_RUN/)
    await expect(save(crypto.randomUUID(),input({ projectCode: 'OTHER' }))).rejects.toThrow(/project code mismatch/)
    await expect(save(crypto.randomUUID(),input(),0,style.id,crypto.randomUUID())).rejects.toThrow(/registered production line/)
  }))
  it('PO는 해당 스타일·공장 범위여야 하며 같은 컬러의 PO를 다른 차수에 재사용하지 않는다', async () => isolated(async () => {
    const wrong = await makePo(otherStyle.id);await expect(save(crypto.randomUUID(),input({ poId: wrong }))).rejects.toThrow(/PO style or factory scope/)
    const po = await makePo();await save(crypto.randomUUID(),input({ poId: po }));await expect(save(crypto.randomUUID(),input({ poId: po }))).rejects.toThrow(/unique/)
    await db.exec('reset role');await query('update public.po_dispatches set factory_id_snapshot=$2 where id=$1',[po,fixture.factories.find(item => item.id !== factoryId)!.id]);await as(DEMO_IDS.admin)
    await expect(save(crypto.randomUUID(),input({ poId: po }))).rejects.toThrow(/PO style or factory scope/)
  }))
  it('CAS가 오래된 수정·입고·확정·무효 요청을 거부하고 중복 입고 ID를 보존한다', async () => isolated(async () => {
    const run = await save();await save(run.id,input({ name: '수정' }),1)
    await expect(save(run.id,input(),1)).rejects.toThrow(/VERSION_CONFLICT/);await expect(receive(run.id,1)).rejects.toThrow(/VERSION_CONFLICT/)
    const receipt = await receive(run.id,2);await expect(close(run.id,2)).rejects.toThrow(/VERSION_CONFLICT/)
    await expect(voidReceipt(receipt.id,run.id,1,2)).rejects.toThrow(/VERSION_CONFLICT/)
    await expect(receive(run.id,3,1,receipt.id)).rejects.toThrow(/duplicate key/)
  }))
  it('입고는 차수별·사이즈별 오더 이내에서만 누적한다', async () => isolated(async () => {
    const run = await save();await receive(run.id,1,6)
    await expect(receive(run.id,2,5)).rejects.toThrow(/exceeds run order/)
    await expect(receive(run.id,2,0,crypto.randomUUID(),{ receivedAt:'2026-11-01',quantities:{ ...emptyQuantities(),XXS:5 } })).rejects.toThrow(/exceeds run order/)
    await receive(run.id,2,4);expect((await query('select version from public.production_runs where id=$1',[run.id])).rows[0].version).toBe(3)
  }))
  it('영 수량·잘못된 일자·추가 입고 키 및 단가 미입력 입고를 거부한다', async () => isolated(async () => {
    const run = await save();await expect(receive(run.id,1,0)).rejects.toThrow(/INVALID/)
    await expect(receive(run.id,1,2,crypto.randomUUID(),{ receivedAt:'2026-02-30',quantities:quantities(2) })).rejects.toThrow(/INVALID|date\/time/)
    await expect(query('select * from public.allocate_production_receipt($1,$2,$3::jsonb,1,$4)',[crypto.randomUUID(),run.id,JSON.stringify({ receivedAt:'2026-11-01',quantities:quantities(1),unitCost:1 }),'잘못된 입고 검증'])).rejects.toThrow(/unknown field/)
    const empty = await save(crypto.randomUUID(),input({ unitCost:null }));await expect(receive(empty.id)).rejects.toThrow(/price and project/)
  }))
  it('실입고 후 단가·PO·품목·프로젝트를 변경하거나 오더를 입고 이하로 줄이지 못한다', async () => isolated(async () => {
    const run = await save();await receive(run.id)
    for (const change of [{unitCost:1},{itemType:'label'},{poId:await makePo()}]) await expect(save(run.id,input(change),2)).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(save(run.id,input({ order:quantities(1) }),2)).rejects.toThrow(/below actual receipts/)
    await expect(save(run.id,input({ projectId:otherProjectId,projectCode:'PROJECT-B' }),2)).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('입고 오류는 삭제 대신 무효로 남기고 정확한 버전과 사유를 요구한다', async () => isolated(async () => {
    const run = await save(),receipt = await receive(run.id)
    const voided = await voidReceipt(receipt.id,run.id);expect(voided).toMatchObject({ voided:true,version:2,net_amount:'15003.00' })
    await expect(voidReceipt(receipt.id,run.id,2,3)).rejects.toThrow(/VERSION_CONFLICT/)
    await save(run.id,input({ unitCost:2000 }),3)
    expect((await query('select count(*)::int count from public.production_receipts where run_id=$1',[run.id])).rows[0].count).toBe(1)
    await expect(close(run.id,4)).rejects.toThrow(/actual receipt required/)
  }))
  it('확정은 해당 차수 단가 × 실제 입고를 부가세 제외·포함 금액으로 고정한다', async () => isolated(async () => {
    const run = await save();await receive(run.id);const closed = await close(run.id)
    expect(closed.snapshot).toMatchObject({ projectId,projectCode:'PROJECT-A',expectedDue:'2026-11-20',unitCost:1250.25,orderQuantity:60,receivedQuantity:12,netAmount:15003,vatAmount:1500.3,grossAmount:16503.3,styleCode:style.code+style.production[0].color,factoryIdSnapshot:factoryId })
    expect(closed.snapshot.receipts).toHaveLength(1);expect(closed.version).toBe(3)
  }))
  it('단가가 바뀌거나 부모 공장·품번·담당자가 바뀌어도 과거 확정 금액과 업체는 그대로다', async () => isolated(async () => {
    const run = await save();await receive(run.id);const original = (await close(run.id)).snapshot
    await query('select * from public.save_settlement_terms($1,$2,0,$3::jsonb,$4)',[style.id,lineId,JSON.stringify({projectCode:'PROJECT-A',unitCost:999999,itemType:'product'}),'최신 단가 변경'])
    await db.exec('reset role');const changed = structuredClone(style);changed.factoryId=fixture.factories.find(item=>item.id!==factoryId)!.id;changed.code='CHANGED';changed.ownerId=DEMO_IDS.internal
    await query('update public.styles set data=$2::jsonb where id=$1',[style.id,JSON.stringify(changed)]);await as(DEMO_IDS.admin)
    expect((await query('select snapshot from public.production_runs where id=$1',[run.id])).rows[0].snapshot).toEqual(original)
    const second = await save(crypto.randomUUID(),input({unitCost:999}));await receive(second.id);expect((await close(second.id)).snapshot.netAmount).toBe(11988)
    expect((await query('select snapshot from public.production_runs where id=$1',[run.id])).rows[0].snapshot).toEqual(original)
  }))
  it('초안 생성 당시 업체·담당자·품번도 부모 재배정 후 확정까지 보존한다', async () => isolated(async () => {
    const run = await save();await db.exec('reset role');const changed = structuredClone(style);changed.factoryId=fixture.factories.find(item=>item.id!==factoryId)!.id;changed.code='NEW-CODE';changed.ownerId=DEMO_IDS.internal
    await query('update public.styles set data=$2::jsonb where id=$1',[style.id,JSON.stringify(changed)]);await as(DEMO_IDS.admin)
    await receive(run.id);const snapshot=(await close(run.id)).snapshot
    expect(snapshot.factoryIdSnapshot).toBe(factoryId);expect(snapshot.styleCode).toBe(style.code+style.production[0].color);expect(snapshot.ownerIdSnapshot).toBe(style.ownerId)
  }))
  it('확정한 차수의 편집·추가입고·입고무효·재확정을 모두 차단한다', async () => isolated(async () => {
    const run=await save(),receipt=await receive(run.id);await close(run.id)
    await expect(save(run.id,input({unitCost:999}),3)).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(receive(run.id,3)).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(voidReceipt(receipt.id,run.id,1,3)).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(close(run.id,3)).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('테이블 소유자 경로에서도 확정 원장·입고 원본을 다시 쓰거나 삭제할 수 없다', async () => isolated(async () => {
    const run=await save(),receipt=await receive(run.id);await db.exec('reset role')
    await expect(query('update public.production_receipts set unit_cost=1 where id=$1',[receipt.id])).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(query('delete from public.production_receipts where id=$1',[receipt.id])).rejects.toThrow(/HISTORY_PROTECTED/)
    await as(DEMO_IDS.admin);await close(run.id);await db.exec('reset role')
    await expect(query('update public.production_runs set unit_cost=1 where id=$1',[run.id])).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(query('delete from public.production_runs where id=$1',[run.id])).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(query('update public.production_receipts set voided=true,version=2 where id=$1',[receipt.id])).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('확정 오류 보정은 같은 프로젝트·컬러의 새 차수에서 원본 참조로 기록한다', async () => isolated(async () => {
    const run=await save();await receive(run.id);await close(run.id)
    expect((await save(crypto.randomUUID(),input({correctsRunId:run.id,name:'보정 생산'}))).corrects_run_id).toBe(run.id)
    await expect(save(crypto.randomUUID(),input({correctsRunId:run.id,projectId:otherProjectId,projectCode:'PROJECT-B'}))).rejects.toThrow(/correction target/)
    const open=await save();await expect(save(crypto.randomUUID(),input({correctsRunId:open.id}))).rejects.toThrow(/correction target/)
  }))
  it('비공개 이력에만 금액을 보존하고 공장 조회 가능한 전역 이력에는 금액·변경 사유가 없다', async () => isolated(async () => {
    const run=await save();await receive(run.id);await close(run.id)
    const privateAudits=(await query('select * from public.production_run_audits where run_id=$1',[run.id])).rows
    expect(privateAudits).toHaveLength(3);expect(JSON.stringify(privateAudits)).toContain('1250.25')
    await as(factoryA.id);const publicAudits=(await query("select * from public.audits where style_id=$1 and action like '생산%'",[style.id])).rows
    expect(publicAudits).toHaveLength(3)
    for (const audit of publicAudits) { expect(audit.reason).toBe('본사 전용 생산 차수 정산 변경');expect(Object.keys(audit.after).sort()).toEqual(['runId','version']);expect(audit.before).toBeNull() }
    expect(JSON.stringify(publicAudits)).not.toContain('1250.25')
  }))
  it('컬러를 포함한 전체 14자리 품번을 한 번만 기록한다', async () => isolated(async () => {
    await db.exec('reset role')
    const changed=structuredClone(style);changed.code='BP06FYDW0101BK';changed.production[0].color='BK'
    await query('update public.styles set data=$2::jsonb where id=$1',[style.id,JSON.stringify(changed)])
    await as(DEMO_IDS.admin)
    expect((await save()).style_code_snapshot).toBe('BP06FYDW0101BK')
  }))
  it('관리자도 테이블 직접 갱신·삭제·감사 위조를 못 하고 내부 함수도 실행하지 못한다', async () => isolated(async () => {
    const run=await save()
    for (const sql of ['update public.production_runs set unit_cost=1 where id=$1','delete from public.production_runs where id=$1','delete from public.production_run_audits where run_id=$1']) await expect(query(sql,[run.id])).rejects.toThrow(/permission denied/)
    await expect(query('select public.production_ledger_actor()')).rejects.toThrow(/permission denied/)
    await expect(query("select * from public.save_production_run($1,$2,$3,$4::jsonb,1,'')",[run.id,style.id,lineId,JSON.stringify(input())])).rejects.toThrow(/REASON_REQUIRED/)
  }))
  it('부모 스타일 수량을 바꾸어도 차수 이력을 유지하되 연결된 생산 컬러 삭제는 막는다', async () => isolated(async () => {
    await save();await db.exec('reset role')
    const changed=structuredClone(style);changed.production[0].order=emptyQuantities();changed.production[0].received=emptyQuantities()
    await query('update public.styles set data=$2::jsonb where id=$1',[style.id,JSON.stringify(changed)])
    changed.production=changed.production.filter(line=>line.id!==lineId)
    await expect(query('update public.styles set data=$2::jsonb where id=$1',[style.id,JSON.stringify(changed)])).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('스타일 보존 삭제 후 새 입고·마감을 차단하되 확정 원본을 삭제하지 않는다', async () => isolated(async () => {
    const run=await save();await receive(run.id);await db.exec('reset role');await query('update public.styles set deleted_at=now() where id=$1',[style.id]);await as(DEMO_IDS.admin)
    expect((await query('select * from public.production_runs')).rows).toHaveLength(0)
    await expect(close(run.id)).rejects.toThrow(/FORBIDDEN/);await expect(receive(run.id,2)).rejects.toThrow(/FORBIDDEN/)
    await db.exec('reset role');expect((await query('select * from public.production_receipts where run_id=$1',[run.id])).rows).toHaveLength(1)
  }))
})
