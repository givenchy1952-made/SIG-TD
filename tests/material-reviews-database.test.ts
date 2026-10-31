import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { emptyQuantities } from '../src/lib/types'

// Real local PostgreSQL policies/RPCs only. No operating SQL, account or mail.
const db = new PGlite(), fixture = createSeed(), style = structuredClone(fixture.styles[1]), line = style.production[0]
const otherStyle = { ...structuredClone(style), id: crypto.randomUUID(), code: 'QAMATERIALOTHER', version: 0 }
const otherFactory = crypto.randomUUID(), pending = fixture.profiles.find(item => !item.approved)!.id
const itemId = crypto.randomUUID(), imageOne = crypto.randomUUID(), imageTwo = crypto.randomUUID(), reviewImage = crypto.randomUUID(), wrongStyleImage = crypto.randomUUID(), pdf = crypto.randomUUID()
const oldRun = crypto.randomUUID(), oldPo = crypto.randomUUID()
const migrationURL = new URL('../supabase/migrations/017_material_reviews.sql', import.meta.url)
const itemData = { kind: 'fabric', name: '원단 검토 품목', specification: '면 100% / 280g' }
const businessTables = ['styles', 'projects', 'profiles', 'factories', 'po_dispatches', 'po_dispatch_attempts', 'po_production_contexts', 'production_po_link_audits', 'production_runs', 'production_receipts', 'production_order_acceptances', 'production_order_starts', 'production_conditions', 'production_condition_proposals', 'production_condition_approvals', 'production_partial_delivery_plans', 'production_partial_delivery_plan_events', 'settlement_terms', 'processing_unit_prices', 'audits']
let transaction = false, sequence = 0
async function query<T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
  if (!transaction) return db.query<T>(sql, values)
  const point = `material_${sequence++}`; await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(sql, values); await db.exec(`release savepoint ${point}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function owner(sql: string, values: unknown[] = []) { await db.exec('reset role'); try { return await query(sql, values) } finally { await as(DEMO_IDS.admin) } }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await as(DEMO_IDS.admin); await fn() } finally { transaction = false; await db.exec('rollback') } }
async function saveItem(version = 0, data: Record<string, unknown> = itemData, id = itemId, targetStyle = style.id, targetLine = line.id, reason = '본사 원부자재 확인 품목 등록') {
  return query('select public.save_material_review_item($1,$2,$3,$4,$5::jsonb,$6)', [id, targetStyle, targetLine, version, JSON.stringify(data), reason])
}
async function append(version: number, status = 'pending', comment = '공장 원단 확인 요청', images: unknown[] = [imageOne], id = crypto.randomUUID(), reason = '원부자재 확인 차수 제출') {
  await query('select public.append_material_review_round($1,$2,$3,$4::jsonb,$5)', [id, itemId, version, JSON.stringify({ status, comment, attachmentIds: images }), reason]); return id
}
async function decide(roundId: string, status = 'rejected', version = 1, comment = '원단 색상 재확인 요청', images: unknown[] = [reviewImage], reason = '본사 원부자재 확인 결과 기록') {
  return query('select public.decide_material_review_round($1,$2,$3::jsonb,$4)', [roundId, version, JSON.stringify({ status, comment, attachmentIds: images }), reason])
}
async function materialRows() { return (await query('select * from public.material_review_rounds order by round')).rows }
async function itemVersion() { return (await query('select version from public.material_review_items where id=$1', [itemId])).rows[0].version }
async function image(id: string, targetStyle = style.id, mime = 'image/png') {
  const path = `${targetStyle}/${id}.${mime === 'application/pdf' ? 'pdf' : 'png'}`
  await query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3::jsonb)', ['sig-files', path, JSON.stringify({ mimetype: mime, size: 120 })])
  await query('insert into public.attachments(id,style_id,name,path,mime,size) values($1,$2,$3,$4,$5,120)', [id, targetStyle, `QA-${id}`, path, mime])
}
async function businessSnapshot() {
  const result: Record<string, unknown> = {}
  await db.exec('reset role')
  try { for (const table of businessTables) result[table] = (await query(`select to_jsonb(t) value from public.${table} t order by to_jsonb(t)::text`)).rows }
  finally { await as(DEMO_IDS.admin) }
  return result
}

beforeAll(async () => {
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create schema storage;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,last_accessed_at timestamptz,unique(bucket_id,name));alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;grant select,insert,update,delete on storage.objects to authenticated;`)
  for (const name of readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(name => /^0(?:0[1-9]|1[0-7])_.*\.sql$/.test(name)).sort()) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const row of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [row.id, row.name, row.country])
  for (const row of fixture.projects) await query('insert into public.projects(id,name,season) values($1,$2,$3)', [row.id, row.name, row.season])
  for (const row of fixture.profiles) { await query('insert into auth.users(id,email) values($1,$2)', [row.id, row.email]); await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [row.id, row.name, row.role, row.approved, row.active, row.factoryId]) }
  await query('insert into auth.users(id,email) values($1,$2)', [otherFactory, 'other-material-factory@example.test'])
  await query("update public.profiles set name='별도 공장',role='factory',approved=true,active=true,factory_id=$2 where id=$1", [otherFactory, DEMO_IDS.vietnam])
  await as(DEMO_IDS.admin); style.version = 0
  await query('select public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), '원부자재 검증 대상 등록'])
  await query('select public.save_style($1,$2::jsonb,0,$3)', [otherStyle.id, JSON.stringify(otherStyle), '별도 스타일 이미지 대상 등록'])
  for (const id of [imageOne, imageTwo, reviewImage]) await image(id)
  await image(wrongStyleImage, otherStyle.id); await image(pdf, style.id, 'application/pdf')

  // Keep a genuine pre-existing approved/closed run, PO and received amounts to
  // prove material reviews cannot reprice or restart business production data.
  const quantities = { ...emptyQuantities(), S: 10 }
  const runInput = { name: '기존 확정 생산', projectId: style.projectId, projectCode: 'QA-OLD-PROJECT', expectedDue: '2026-12-01', poId: null, unitCost: null, itemType: 'product', order: quantities, correctsRunId: null }
  await query('select public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [oldRun, style.id, line.id, JSON.stringify(runInput), '기존 생산 보존 검증'])
  await query('select public.save_partial_delivery_plan($1,0,$2::jsonb,$3)', [oldRun, JSON.stringify([{ id: crypto.randomUUID(), quantity: 10, dueDate: '2026-12-01', note: '기존 부분 납기 계획' }]), '기존 부분 납기 등록'])
  await query("select public.configure_production_conditions($1,1,0,'cmt','900'::jsonb,'기존 내부 검토 단가')", [oldRun])
  await query('select public.create_production_order_po($1,2,$2,$3::jsonb,$4)', [oldRun, oldPo, JSON.stringify({ dueDate: '2026-12-01', recipient: 'factory@example.test', subject: '기존 승인 PO', body: '기존 PO 원본 보존', evidenceAttachmentId: null, voided: false }), '기존 발주 PO 등록'])
  await query('select public.begin_po_dispatch($1,1)', [oldPo]); await as(null, 'service_role')
  await query("select public.finalize_po_dispatch($1,'qa-local-material-test-provider',null,'sent')", [oldPo]); await as(DEMO_IDS.factory)
  await query('select public.submit_production_conditions($1,3,3,1,$2::jsonb)', [oldRun, JSON.stringify({ expectedDeliveryDate: '2026-12-01', unitCost: 100.5, canProduce: true, quantityConfirmed: true, agreed: true, confirmedQuantities: quantities, comment: '기존 생산 조건', delayReason: '', priceReason: '' })])
  await as(DEMO_IDS.admin)
  await query("select public.review_production_conditions($1,4,2,'approve','2026-12-01','100.5'::jsonb,'기존 조건 최종 승인')", [oldRun])
  await query('select public.allocate_production_receipt($1,$2,$3::jsonb,5,$4)', [crypto.randomUUID(), oldRun, JSON.stringify({ receivedAt: '2026-12-01', quantities: { ...emptyQuantities(), S: 4 } }), '기존 실입고 보존'])
  await query("select public.finalize_production_run($1,6,'기존 마감 금액 확정')", [oldRun])
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('017 실제 PostgreSQL 원부자재 품목·차수 확인', () => {
  it('본사가 품목을 만들고 공장은 품목 정의를 만들거나 수정하지 못한다', async () => isolated(async () => {
    await saveItem()
    expect((await query('select * from public.material_review_items')).rows[0]).toMatchObject({ id: itemId, style_id: style.id, line_id: line.id, ...itemData, version: 1, updated_by: DEMO_IDS.admin })
    await as(DEMO_IDS.factory)
    await expect(saveItem(0, itemData, crypto.randomUUID())).rejects.toThrow(/FORBIDDEN/)
    await expect(saveItem(1, { ...itemData, name: '공장 임의 변경' })).rejects.toThrow(/FORBIDDEN/)
  }))
  it('공장 대기1차→본사 반려1차→공장 대기2차→본사 승인2차로 동일 제출 차수를 결정한다', async () => isolated(async () => {
    await saveItem(); await as(DEMO_IDS.factory)
    const first = await append(1)
    const firstSubmitted = (await materialRows())[0]
    expect(firstSubmitted).toMatchObject({ id: first, round: 1, status: 'pending', actor_id: DEMO_IDS.factory, comment: '공장 원단 확인 요청', attachment_ids: [imageOne], version: 1 })
    await as(DEMO_IDS.internal); await decide(first)
    expect((await materialRows())[0]).toMatchObject({ ...firstSubmitted, status: 'rejected', reviewer_comment: '원단 색상 재확인 요청', review_attachment_ids: [reviewImage], reviewed_by: DEMO_IDS.internal, reviewed_by_name: fixture.profiles.find(row => row.id === DEMO_IDS.internal)!.name, reviewed_at: expect.any(Date), version: 2 })
    const rejected = (await materialRows())[0]
    await as(DEMO_IDS.factory); const second = await append(3, 'pending', '수정 원단 2차 제출', [imageTwo])
    await as(DEMO_IDS.admin); await decide(second, 'approved', 1, '수정 원단 확인 완료', [])
    const rows = await materialRows()
    expect(rows).toHaveLength(2); expect(rows[0]).toEqual(rejected)
    expect(rows[1]).toMatchObject({ id: second, round: 2, status: 'approved', comment: '수정 원단 2차 제출', attachment_ids: [imageTwo], reviewer_comment: '수정 원단 확인 완료', reviewed_by: DEMO_IDS.admin, version: 2 })
    expect(await itemVersion()).toBe(5)
    expect((await query('select * from public.material_review_attachments order by phase,attachment_id')).rows).toHaveLength(3)
  }))
  it('품목명·사양을 고쳐도 과거 차수의 당시 품목·이미지·코멘트는 바뀌지 않는다', async () => isolated(async () => {
    await saveItem(); await as(DEMO_IDS.factory); const first = await append(1)
    const before = (await materialRows())[0]
    await as(DEMO_IDS.admin); await saveItem(2, { kind: 'trim', name: '이후 변경 부자재', specification: '새 사양' }); await decide(first)
    await as(DEMO_IDS.factory); await append(4, 'pending', '변경 사양 제출', [imageTwo])
    const rows = await materialRows()
    expect(rows[0].item_snapshot).toEqual(before.item_snapshot)
    expect(rows[0].comment).toBe(before.comment); expect(rows[0].attachment_ids).toEqual(before.attachment_ids)
    expect(rows[1].item_snapshot).toMatchObject({ kind: 'trim', name: '이후 변경 부자재', specification: '새 사양', color: line.color, styleId: style.id, lineId: line.id, styleCode: style.code })
  }))
  it('대기 중 새 차수를 추가하거나 승인 후 공장이 다시 제출하지 못한다', async () => isolated(async () => {
    await saveItem(); await as(DEMO_IDS.factory); const first = await append(1)
    await expect(append(2)).rejects.toThrow(/MATERIAL_REVIEW_STATE/)
    await as(DEMO_IDS.admin); await expect(append(2, 'rejected', '다른 차수로 대신 결정')).rejects.toThrow(/MATERIAL_REVIEW_STATE/)
    await decide(first, 'approved'); await as(DEMO_IDS.factory)
    await expect(append(3)).rejects.toThrow(/MATERIAL_REVIEW_STATE/)
    expect(await materialRows()).toHaveLength(1)
  }))
  it('본사는 과거 최종 확인을 새 이력으로 기록할 수 있지만 기존 승인 기록은 유지한다', async () => isolated(async () => {
    await saveItem(); const first = await append(1, 'approved', '기존 원단 최종 승인 기록', [imageOne])
    const before = (await materialRows())[0]
    await as(DEMO_IDS.internal); await append(2, 'rejected', '이후 별도 확인 기록', [reviewImage])
    const rows = await materialRows()
    expect(rows[0]).toEqual(before); expect(rows[1]).toMatchObject({ round: 2, status: 'rejected', reviewed_by: DEMO_IDS.internal, actor_id: DEMO_IDS.internal })
    expect(rows[0]).toMatchObject({ id: first, round: 1, reviewed_by: DEMO_IDS.admin, version: 1 })
  }))
  it.each(['approved', 'rejected'])('공장은 승인·반려 상태 %s를 제출하거나 결정자로 위장하지 못한다', async status => isolated(async () => {
    await saveItem(); await as(DEMO_IDS.factory)
    await query("select set_config('request.jwt.claim.role','admin',false)")
    await expect(append(1, status)).rejects.toThrow(/MATERIAL_REVIEW_STATE/)
    const first = await append(1)
    await expect(decide(first)).rejects.toThrow(/FORBIDDEN/)
    await expect(saveItem(2)).rejects.toThrow(/FORBIDDEN/)
  }))
  it('타 공장·미승인·비활성 계정은 품목·차수·이미지 참조·이력을 읽거나 제출하지 못한다', async () => isolated(async () => {
    await saveItem(); await as(DEMO_IDS.factory); const first = await append(1)
    for (const actor of [otherFactory, pending]) {
      await as(actor)
      for (const table of ['material_review_items', 'material_review_rounds', 'material_review_attachments', 'material_review_events']) expect((await query(`select * from public.${table}`)).rows).toEqual([])
      await expect(append(2)).rejects.toThrow(/FORBIDDEN/)
      await expect(decide(first)).rejects.toThrow(/FORBIDDEN/)
    }
    await owner('update public.profiles set active=false where id=$1', [DEMO_IDS.factory]); await as(DEMO_IDS.factory)
    expect((await query('select public.get_material_reviews_capability() enabled')).rows[0].enabled).toBe(false)
    expect((await query('select * from public.material_review_rounds')).rows).toEqual([])
    await expect(append(2)).rejects.toThrow(/FORBIDDEN/)
  }))
  it('익명·서비스 역할과 직접 테이블 쓰기로 승인 절차를 우회할 수 없다', async () => isolated(async () => {
    await saveItem()
    for (const role of ['anon', 'service_role']) { await as(null, role); await expect(append(1)).rejects.toThrow(/permission denied/); await expect(query('select * from public.material_review_items')).rejects.toThrow(/permission denied/) }
    await as(DEMO_IDS.admin)
    await expect(query("update public.material_review_items set name='직접 수정' where id=$1", [itemId])).rejects.toThrow(/permission denied/)
    await as(DEMO_IDS.factory); const round = await append(1)
    await expect(query("update public.material_review_rounds set status='approved',version=2 where id=$1", [round])).rejects.toThrow(/permission denied/)
  }))
  it.each([[wrongStyleImage], [pdf], [crypto.randomUUID()], [imageOne, imageOne], [123], Array(13).fill(imageOne)])('같은 스타일의 유효한 이미지 최대12장만 제출 가능하다: %j', async images => isolated(async () => {
    await saveItem(); await as(DEMO_IDS.factory)
    await expect(append(1, 'pending', '잘못된 첨부 검증', images)).rejects.toThrow(/INVALID_MATERIAL/)
    expect(await materialRows()).toEqual([])
    expect(await itemVersion()).toBe(1)
  }))
  it('결정 이미지도 같은 스타일 규칙을 적용하고 실패하면 대기 차수·버전·이력을 보존한다', async () => isolated(async () => {
    await saveItem(); await as(DEMO_IDS.factory); const first = await append(1)
    const before = await materialRows(), events = (await query('select * from public.material_review_events order by created_at,id')).rows
    await as(DEMO_IDS.admin)
    await expect(decide(first, 'approved', 1, '타 스타일 이미지', [wrongStyleImage])).rejects.toThrow(/INVALID_MATERIAL_IMAGE/)
    expect(await materialRows()).toEqual(before); expect(await itemVersion()).toBe(2)
    expect((await query('select * from public.material_review_events order by created_at,id')).rows).toEqual(events)
  }))
  it('첨부 메타데이터만 남고 원본 이미지 객체가 없으면 보관하지 않는다', async () => isolated(async () => {
    await saveItem()
    await owner('delete from storage.objects where bucket_id=$1 and name=$2', ['sig-files', `${style.id}/${imageTwo}.png`])
    await as(DEMO_IDS.factory)
    await expect(append(1, 'pending', '원본 소실 이미지', [imageTwo])).rejects.toThrow(/INVALID_MATERIAL_IMAGE/)
    expect(await materialRows()).toEqual([]); expect(await itemVersion()).toBe(1)
  }))
  it('현재 공장이 바뀌거나 스타일이 보관되면 이전 공장의 신규 제출과 조회를 차단한다', async () => isolated(async () => {
    await saveItem(); await as(DEMO_IDS.factory); await append(1)
    await owner("update public.styles set data=jsonb_set(data,'{factoryId}',to_jsonb($2::text)) where id=$1", [style.id, DEMO_IDS.vietnam])
    await as(DEMO_IDS.factory)
    expect((await query('select * from public.material_review_items')).rows).toEqual([])
    expect((await query('select * from public.material_review_rounds')).rows).toEqual([])
    await expect(append(2)).rejects.toThrow(/FORBIDDEN/)
    await owner('update public.styles set deleted_at=now() where id=$1', [style.id])
    await expect(saveItem(2)).rejects.toThrow(/FORBIDDEN/)
  }))
  it('이미지 참조는 제출·결정 단계 모두 보존하며 첨부 메타데이터와 파일 객체를 삭제·교체하지 못한다', async () => isolated(async () => {
    await saveItem(); await as(DEMO_IDS.factory); const first = await append(1)
    await as(DEMO_IDS.admin); await decide(first)
    const refs = (await query('select * from public.material_review_attachments order by phase')).rows
    expect(refs).toEqual(expect.arrayContaining([{ round_id: first, attachment_id: imageOne, phase: 'submission' }, { round_id: first, attachment_id: reviewImage, phase: 'review' }]))
    for (const id of [imageOne, reviewImage]) {
      await expect(owner('delete from public.attachments where id=$1', [id])).rejects.toThrow(/HISTORY_PROTECTED|foreign key/)
      await expect(owner("update public.attachments set name='변경 시도' where id=$1", [id])).rejects.toThrow(/HISTORY_PROTECTED/)
      const path = `${style.id}/${id}.png`
      await expect(owner('update storage.objects set last_accessed_at=now() where bucket_id=$1 and name=$2', ['sig-files', path])).resolves.toBeDefined()
      await expect(owner('delete from storage.objects where bucket_id=$1 and name=$2', ['sig-files', path])).rejects.toThrow(/HISTORY_PROTECTED/)
      await expect(owner("update storage.objects set metadata='{}'::jsonb where bucket_id=$1 and name=$2", ['sig-files', path])).rejects.toThrow(/HISTORY_PROTECTED/)
      await expect(owner('delete from public.material_review_attachments where attachment_id=$1', [id])).rejects.toThrow(/HISTORY_PROTECTED/)
    }
    expect((await query('select * from public.material_review_attachments order by phase')).rows).toEqual(refs)
  }))
  it('이미 보관된 차수의 본문·제출 이미지·사양 스냅샷과 결정 후 결과는 직접 덮어쓰거나 삭제하지 못한다', async () => isolated(async () => {
    await saveItem(); const first = await append(1)
    for (const change of ["comment='과거 코멘트 변경'", "attachment_ids='{}'::uuid[]", "item_snapshot='{}'::jsonb"]) await expect(owner(`update public.material_review_rounds set ${change} where id=$1`, [first])).rejects.toThrow(/HISTORY_PROTECTED/)
    await decide(first, 'approved')
    await expect(owner("update public.material_review_rounds set reviewer_comment='승인 후 수정' where id=$1", [first])).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(owner('delete from public.material_review_rounds where id=$1', [first])).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(owner('delete from public.material_review_items where id=$1', [itemId])).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(owner("update public.material_review_events set reason='이력 수정'")).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('품목·제출·결정의 오래된 버전 및 중복 ID를 거부하고 전체 변경을 롤백한다', async () => isolated(async () => {
    await saveItem(); await expect(saveItem(0, { ...itemData, name: '덮어쓰기' })).rejects.toThrow(/VERSION_CONFLICT/)
    await as(DEMO_IDS.factory); await expect(append(0)).rejects.toThrow(/VERSION_CONFLICT/)
    const first = await append(1)
    await expect(append(1)).rejects.toThrow(/VERSION_CONFLICT/)
    await as(DEMO_IDS.admin); await expect(decide(first, 'approved', 0)).rejects.toThrow(/VERSION_CONFLICT/)
    await decide(first)
    const before = await materialRows()
    await expect(decide(first, 'approved', 1)).rejects.toThrow(/VERSION_CONFLICT/)
    await expect(decide(first, 'approved', 2)).rejects.toThrow(/HISTORY_PROTECTED/)
    await as(DEMO_IDS.factory); await expect(append(2)).rejects.toThrow(/VERSION_CONFLICT/)
    await expect(append(3, 'pending', '동일 ID 중복', [imageTwo], first)).rejects.toThrow(/duplicate key|VERSION_CONFLICT/)
    expect(await materialRows()).toEqual(before); expect(await itemVersion()).toBe(3)
  }))
  it('사유·빈본문·상태·추가 키 검증 실패 시 품목·차수·이미지·이력을 부분 저장하지 않는다', async () => isolated(async () => {
    await expect(saveItem(0, itemData, itemId, style.id, line.id, '')).rejects.toThrow(/REASON_REQUIRED/)
    expect((await query('select * from public.material_review_items')).rows).toEqual([])
    await saveItem(); await expect(append(1, 'pending', '', [])).rejects.toThrow(/INVALID_MATERIAL_REVIEW/)
    await expect(query('select public.append_material_review_round($1,$2,1,$3::jsonb,$4)', [crypto.randomUUID(), itemId, JSON.stringify({ status: 'pending', comment: '추가 필드', attachmentIds: [], actorId: DEMO_IDS.admin }), '입력 검증'])).rejects.toThrow(/INVALID_OPERATION/)
    expect(await materialRows()).toEqual([]); expect(await itemVersion()).toBe(1)
    const first = await append(1)
    await expect(decide(first, 'pending')).rejects.toThrow(/INVALID_MATERIAL_DECISION/)
    await expect(decide(first, 'approved', 1, '', [])).rejects.toThrow(/INVALID_MATERIAL_REVIEW/)
    expect((await materialRows())[0]).toMatchObject({ status: 'pending', version: 1 })
  }))
  it('원부자재 등록·반려·승인이 기존 스타일·수량·단가·생산 승인·PO·부분 납기·입고·마감 금액을 변경하지 않는다', async () => isolated(async () => {
    const before = await businessSnapshot()
    expect((before.production_condition_approvals as unknown[]).length).toBeGreaterThan(0)
    expect((before.production_receipts as unknown[]).length).toBeGreaterThan(0)
    expect((before.po_dispatch_attempts as unknown[]).length).toBeGreaterThan(0)
    await saveItem(); await as(DEMO_IDS.factory); const first = await append(1)
    await as(DEMO_IDS.admin); await decide(first)
    await as(DEMO_IDS.factory); const second = await append(3, 'pending', '수정 사항 제출', [imageTwo])
    await as(DEMO_IDS.internal); await decide(second, 'approved')
    expect(await businessSnapshot()).toEqual(before)
  }))
  it('017을 다시 적용해도 기존 업무·원부자재 기록과 이미지 보관이 유지된다', async () => {
    await as(DEMO_IDS.admin); await saveItem(); await as(DEMO_IDS.factory); const first = await append(1)
    await as(DEMO_IDS.admin); await decide(first)
    const before = await businessSnapshot(), rows = await materialRows(), refs = (await query('select * from public.material_review_attachments order by phase')).rows
    await db.exec('reset role'); await db.exec(readFileSync(migrationURL, 'utf8')); await as(DEMO_IDS.admin)
    expect(await businessSnapshot()).toEqual(before); expect(await materialRows()).toEqual(rows)
    expect((await query('select * from public.material_review_attachments order by phase')).rows).toEqual(refs)
  })
})
