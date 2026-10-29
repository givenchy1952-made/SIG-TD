import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { blankProductionDetails } from '../src/lib/workflow-refinements'
import type { OperationRow } from '../src/lib/operations-types'

const db = new PGlite(), fixture = createSeed(), style = structuredClone(fixture.styles[1])
const lineId = style.production[0].id, labelKey = crypto.randomUUID(), embroideryKey = crypto.randomUUID()
const otherFactoryId = crypto.randomUUID(), pendingId = fixture.profiles.find(person => !person.approved)!.id
const migration = readFileSync(new URL('../supabase/migrations/013_processing_unit_prices.sql', import.meta.url), 'utf8')
let transaction = false, sequence = 0
let labelOperationId = '', labelRow: OperationRow
async function query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  if (!transaction) return db.query<T>(sql, params)
  const point = `price_${sequence++}`; await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(sql, params); await db.exec(`release savepoint ${point}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await as(DEMO_IDS.admin); await fn() } finally { transaction = false; await db.exec('rollback') } }
async function save(cost: unknown = 125.5, version = 0, kind = 'label', itemKey = labelKey, targetLine = lineId, targetStyle = style.id, reason = '업체 협의 단가 등록') {
  return (await query('select * from public.save_processing_unit_price($1,$2,$3,$4,$5::jsonb,$6,$7)', [targetStyle, targetLine, kind, itemKey, cost === undefined ? null : JSON.stringify(cost), version, reason])).rows[0]
}
async function currentStyle() { return (await query('select * from public.styles where id=$1', [style.id])).rows[0] }

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
  for (const name of ['001_initial.sql', '002_style_images.sql', '003_operations.sql', '004_settlement_terms.sql', '005_workflow_refinements.sql', '006_staff_approvals.sql', '007_production_ledger.sql', '008_supplier_acceptance.sql', '009_import_production_runs.sql', '010_member_withdrawal.sql', '011_import_color_owners.sql', '012_outlook_po_email.sql', '013_processing_unit_prices.sql']) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const item of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [item.id, item.name, item.country])
  for (const item of fixture.projects) await query('insert into public.projects(id,name,season) values($1,$2,$3)', [item.id, item.name, item.season])
  for (const item of fixture.profiles) {
    await query('insert into auth.users(id,email) values($1,$2)', [item.id, item.email])
    await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [item.id, item.name, item.role, item.approved, item.active, item.factoryId])
  }
  await query('insert into auth.users(id,email) values($1,$2)', [otherFactoryId, 'other-factory@example.test'])
  await query("update public.profiles set name='별도 공장',role='factory',approved=true,active=true,factory_id=$2 where id=$1", [otherFactoryId, DEMO_IDS.vietnam])
  style.version = 0; await as(DEMO_IDS.admin)
  await query('select public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), '가공 단가 격리 시험'])
  for (const [kind, itemKey] of [['label', labelKey], ['embroidery', embroideryKey]]) {
    const catalog = (await query('select id,name from public.operation_catalogs where kind=$1 and active order by id limit 1', [kind])).rows[0]
    const row: OperationRow = { id: itemKey, catalogId: catalog.id, name: catalog.name, specification: 'QA 테스트 사양', quantity: 20, lossQuantity: 0, completedQuantity: 10, status: 'progress', orderedAt: '', requestedAt: '', completedAt: '', dueDate: '', note: '' }
    const operationId = crypto.randomUUID()
    await query('select public.save_style_operation($1,$2,$3,0,$4::jsonb,$5)', [operationId, style.id, kind, JSON.stringify({ rows: [row], note: '', voided: false }), '가공 작업 등록'])
    if (kind === 'label') { labelOperationId = operationId; labelRow = row }
  }
  const details = blankProductionDetails(); details.quality.category = '아우터'
  await query('select public.save_production_details($1,$2,0,$3::jsonb,$4)', [style.id, lineId, JSON.stringify(details), '품질 검사 대상 등록'])
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('013 실제 PostgreSQL 가공·품질 단가', () => {
  it('승인된 본사와 배정된 공장이 각각 저장하고 저장자는 서버 프로필로 기록한다', async () => isolated(async () => {
    for (const [index, actor] of [DEMO_IDS.admin, DEMO_IDS.internal, DEMO_IDS.factory].entries()) {
      await as(actor)
      const result = await save(125.5 + index, index)
      expect(Number(result.unit_cost)).toBe(125.5 + index); expect(result.version).toBe(index + 1); expect(result.updated_by).toBe(actor)
      expect((await query('select * from public.processing_unit_prices')).rows).toHaveLength(1)
    }
  }))
  it('단가 입력으로 스타일·수량·작업 지시·품질·제품 원가를 수정하지 않는다', async () => isolated(async () => {
    const before = await currentStyle()
    const work = (await query('select * from public.style_operations order by id')).rows
    const details = (await query('select * from public.production_details')).rows
    await as(DEMO_IDS.factory); await save(72.25)
    expect(await currentStyle()).toEqual(before)
    expect((await query('select * from public.style_operations order by id')).rows).toEqual(work)
    expect((await query('select * from public.production_details')).rows).toEqual(details)
    expect((await query('select * from public.settlement_terms')).rows).toEqual([])
  }))
  it('다른 컬러·작업의 단가는 독립적으로 유지한다', async () => isolated(async () => {
    await save(100); await save(200, 0, 'label', labelKey, style.production[1].id)
    await save(300, 0, 'embroidery', embroideryKey); await save(400, 0, 'quality', '아우터')
    const rows = (await query('select * from public.processing_unit_prices order by kind,line_id')).rows
    expect(rows).toHaveLength(4); expect(rows.map(row => Number(row.unit_cost)).sort((a,b) => a-b)).toEqual([100,200,300,400])
  }))
  it('기존 단가는 명시적 변경 전 유지하며 0과 미입력을 구분한다', async () => isolated(async () => {
    const first = await save(0); expect(Number(first.unit_cost)).toBe(0)
    const second = await save(null, 1); expect(second.unit_cost).toBeNull(); expect(second.created_at).toEqual(first.created_at)
    const third = await save(999.99, 2); expect(Number(third.unit_cost)).toBe(999.99)
    expect((await query('select * from public.processing_unit_price_audits')).rows).toHaveLength(3)
  }))
  it('사유·버전 검사에 실패하면 단가와 감사 이력이 생기지 않는다', async () => isolated(async () => {
    await expect(save(100, 0, 'label', labelKey, lineId, style.id, '')).rejects.toThrow(/REASON_REQUIRED/)
    await expect(save(100, -1)).rejects.toThrow(/INVALID_VERSION/)
    await expect(save(100, 1)).rejects.toThrow(/VERSION_CONFLICT/)
    expect((await query('select * from public.processing_unit_prices')).rows).toHaveLength(0)
    expect((await query('select * from public.processing_unit_price_audits')).rows).toHaveLength(0)
  }))
  it('오래된 저장은 기존 단가를 덮어쓰지 않고 초기 중복 요청도 거부한다', async () => isolated(async () => {
    await save(100)
    await expect(save(200, 0)).rejects.toThrow(/VERSION_CONFLICT/)
    await save(300, 1)
    await expect(save(400, 1)).rejects.toThrow(/VERSION_CONFLICT/)
    expect(Number((await query('select * from public.processing_unit_prices')).rows[0].unit_cost)).toBe(300)
  }))
  it.each([-1, 1_000_000_000.01, 1.001, '100', true, false, [], {}, 'NaN'])('잘못된 단가 %j를 강제 변환하지 않는다', async value => isolated(async () => {
    await expect(save(value)).rejects.toThrow(/INVALID_PROCESSING_PRICE/)
  }))
  it('알 수 없는 컬러·작업·검사 대상과 다른 작업 종류의 키를 거부한다', async () => isolated(async () => {
    for (const [kind, key, color] of [['label', labelKey, crypto.randomUUID()], ['label', embroideryKey, lineId], ['embroidery', labelKey, lineId], ['quality', '바지', lineId], ['quality', '', lineId], ['invalid', labelKey, lineId], ['label', crypto.randomUUID(), lineId]]) await expect(save(100, 0, kind, key, color)).rejects.toThrow(/INVALID_PROCESSING_PRICE/)
  }))
  it('작업이 보관되거나 검사 대상이 바뀌면 과거 키의 추가 수정은 거부하고 기존 단가를 보존한다', async () => isolated(async () => {
    await save(100)
    await query('select public.save_style_operation($1,$2,$3,1,$4::jsonb,$5)', [labelOperationId, style.id, 'label', JSON.stringify({ rows: [labelRow], note: '', voided: true }), '작업 보관'])
    await expect(save(200, 1)).rejects.toThrow(/INVALID_PROCESSING_PRICE/)
    expect(Number((await query('select * from public.processing_unit_prices')).rows[0].unit_cost)).toBe(100)
    await save(300, 0, 'quality', '아우터')
    const details = blankProductionDetails(); details.quality.category = '바지'
    await query('select public.save_production_details($1,$2,1,$3::jsonb,$4)', [style.id, lineId, JSON.stringify(details), '검사 대상 변경'])
    await expect(save(400, 1, 'quality', '아우터')).rejects.toThrow(/INVALID_PROCESSING_PRICE/)
  }))
  it('타 공장은 단가·이력·존재 여부를 읽거나 수정하지 못한다', async () => isolated(async () => {
    await save(100); await as(otherFactoryId)
    expect((await query('select * from public.processing_unit_prices')).rows).toEqual([])
    expect((await query('select * from public.processing_unit_price_audits')).rows).toEqual([])
    await expect(save(200, 1)).rejects.toThrow(/FORBIDDEN/)
    await expect(save('bad', 1, 'notkind', 'nonexistent')).rejects.toThrow(/FORBIDDEN/)
  }))
  it('탈퇴·미승인·비활성 계정의 기존 세션도 읽기와 수정이 즉시 차단된다', async () => isolated(async () => {
    await save(100)
    await query('select public.withdraw_workspace_member($1,$2)', [DEMO_IDS.factory, '협력사 계정 탈퇴'])
    for (const id of [DEMO_IDS.factory, pendingId]) {
      await as(id); expect((await query('select * from public.processing_unit_prices')).rows).toEqual([])
      await expect(save(200, 1)).rejects.toThrow(/FORBIDDEN/)
      expect((await query('select public.get_processing_prices_capability() available')).rows[0].available).toBe(false)
    }
  }))
  it('공장에는 현재 단가만 공개하고 감사 이력의 가격·사용자 사유는 본사에만 남긴다', async () => isolated(async () => {
    await as(DEMO_IDS.factory); await save(12345.67, 0, 'label', labelKey, lineId, style.id, '협의 단가 12345.67원 저장')
    const publicAudits = (await query("select * from public.audits where action='가공·품질 단가 저장'")).rows
    expect(JSON.stringify(publicAudits)).not.toContain('12345.67')
    expect((await query('select * from public.processing_unit_price_audits')).rows).toEqual([])
    await as(DEMO_IDS.admin)
    const history = (await query('select * from public.processing_unit_price_audits')).rows
    expect(history).toHaveLength(1); expect(history[0].reason).toContain('12345.67'); expect(Number(history[0].after.unit_cost)).toBe(12345.67)
  }))
  it('공장 재배정은 과거 공장의 가격 조회·수정을 회수하고 기록을 지우지 않는다', async () => isolated(async () => {
    await as(DEMO_IDS.factory); await save(100)
    await as(DEMO_IDS.admin); const before = await currentStyle(); before.data.factoryId = DEMO_IDS.vietnam
    await query('select public.save_style($1,$2::jsonb,$3,$4)', [style.id, JSON.stringify(before.data), before.version, '생산 담당 공장 변경'])
    await as(DEMO_IDS.factory); expect((await query('select * from public.processing_unit_prices')).rows).toEqual([])
    await expect(save(200, 1)).rejects.toThrow(/FORBIDDEN/)
    await as(otherFactoryId); expect((await query('select * from public.processing_unit_prices')).rows).toHaveLength(1)
    await save(300, 1)
    await as(DEMO_IDS.admin); expect((await query('select * from public.processing_unit_price_audits')).rows).toHaveLength(2)
  }))
  it('보존 삭제한 스타일의 단가를 읽거나 수정하지 못한다', async () => isolated(async () => {
    await save(100); const original = await currentStyle()
    await query('select public.soft_delete_style($1,$2,$3)', [style.id, original.version, '시험 스타일 삭제'])
    expect((await query('select * from public.processing_unit_prices')).rows).toEqual([])
    await expect(save(200, 1)).rejects.toThrow(/FORBIDDEN/)
  }))
  it('관리자·공장·서비스 키도 테이블 직접 변경으로 검증과 이력을 우회하지 못한다', async () => isolated(async () => {
    await save(100)
    for (const [id, role] of [[DEMO_IDS.admin, 'authenticated'], [DEMO_IDS.factory, 'authenticated'], [null, 'service_role']] as const) {
      await as(id, role)
      for (const sql of ['update public.processing_unit_prices set unit_cost=1', 'delete from public.processing_unit_prices', 'insert into public.processing_unit_prices default values', 'delete from public.processing_unit_price_audits']) await expect(query(sql)).rejects.toThrow(/permission denied/)
    }
    await as(null, 'service_role'); await expect(save()).rejects.toThrow(/permission denied/)
    await as(null, 'anon'); await expect(save()).rejects.toThrow(/permission denied/)
    await expect(query('select * from public.processing_unit_prices')).rejects.toThrow(/permission denied/)
  }))
  it('승인된 사용자만 기능을 확인하고 마이그레이션 재실행에도 이력을 보존한다', async () => {
    await as(DEMO_IDS.admin); await save(100)
    await db.exec('reset role'); await db.exec(migration)
    await as(DEMO_IDS.factory)
    expect((await query('select public.get_processing_prices_capability() available')).rows[0].available).toBe(true)
    expect(Number((await query('select * from public.processing_unit_prices')).rows[0].unit_cost)).toBe(100)
    await as(DEMO_IDS.admin); expect((await query('select * from public.processing_unit_price_audits')).rows).toHaveLength(1)
  })
})
