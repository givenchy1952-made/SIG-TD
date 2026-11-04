import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { blankProductionDetails } from '../src/lib/workflow-refinements'

const db = new PGlite(), fixture = createSeed(), sql = new URL('../supabase/migrations/020_inspection_assignments.sql', import.meta.url)
const able = crypto.randomUUID(), kotiti = crypto.randomUUID(), blankInspector = crypto.randomUUID()
const ableActor = crypto.randomUUID(), kotitiActor = crypto.randomUUID(), blankActor = crypto.randomUUID()
const budget = 'SIGNIFICANT-2026FY-MPQ-46093', projectName = '시그니피컨트 2026 3Q'
const project = { ...fixture.projects[0], code: budget, name: budget, season: '2026FY' }
const styles = [0, 1].map((index) => ({ ...structuredClone(fixture.styles[1]), id: crypto.randomUUID(), code: `QAINSPECT${index}`, name: '검사 주문 최소 공개 검증', projectId: project.id, season: project.season, factoryId: index ? able : DEMO_IDS.china, version: 0, notes: '본사 내부 원본 공개 금지', colors: fixture.styles[1].colors.slice(0, 2), production: structuredClone(fixture.styles[1].production.slice(0, 2)) }))
const pending = fixture.profiles.find(row => !row.approved)!.id
const runs = styles.map(() => crypto.randomUUID()), po = crypto.randomUUID(), attachment = crypto.randomUUID(), material = crypto.randomUUID()
const originalPath = `${styles[1].id}/${attachment}.png`
let transaction = false, sequence = 0, before020: unknown
async function query<T = Record<string, any>>(statement: string, values: unknown[] = []) {
 if (!transaction) return db.query<T>(statement, values)
 const point = `inspection_${sequence++}`;await db.exec(`savepoint ${point}`)
 try { const result = await db.query<T>(statement, values);await db.exec(`release savepoint ${point}`);return result }
 catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`);throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`);await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function owner(statement: string, values: unknown[] = []) { await db.exec('reset role');try { return await query(statement, values) } finally { await as(DEMO_IDS.admin) } }
async function isolated(fn: () => Promise<void>) { await db.exec('begin');transaction = true;try { await as(DEMO_IDS.admin);await fn() } finally { transaction = false;await db.exec('rollback') } }
async function orders() { return (await query<{ value: Record<string, any> }>('select public.get_inspection_orders() value')).rows.map(row => row.value) }
async function assign(provider: string | null, expected = 0, style = styles[0], lineId = style.production[0].id) { return query('select public.save_inspection_assignment($1,$2,$3,$4,$5)', [style.id, lineId, provider, expected, '검사 업체 배정 변경']) }
async function settings(id = able, type = 'inspection', provider: string | null = 'able', version = 0) { return query('select public.save_factory_service_settings($1,$2,$3,$4,$5)', [id, type, provider, version, '명시적인 검사 업체 역할 설정']) }
async function business() {
 const snapshot: Record<string, unknown> = {}
 for (const table of ['styles', 'projects', 'profiles', 'order_source_records', 'po_dispatches', 'po_dispatch_attempts', 'production_runs', 'production_receipts', 'production_conditions', 'production_condition_proposals', 'production_condition_approvals', 'production_partial_delivery_plans', 'production_details', 'processing_unit_prices', 'settlement_terms', 'material_review_items', 'material_review_rounds', 'comments', 'attachments', 'style_images']) snapshot[table] = (await owner(`select to_jsonb(t) value from public.${table} t order by to_jsonb(t)::text`)).rows
 return snapshot
}

beforeAll(async () => {
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
 create schema auth;create schema storage;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,last_accessed_at timestamptz,unique(bucket_id,name));alter table storage.objects enable row level security;
 grant usage on schema public,auth,storage to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;grant select,insert,update,delete on storage.objects to authenticated;`)
 for (const name of readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(name => /^0(?:0[1-9]|1[0-9])_.*\.sql$/.test(name)).sort()) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
 for (const row of [...fixture.factories, { id: able, name: '품질 업체 A', country: '대한민국' }, { id: kotiti, name: '품질 업체 K', country: '대한민국' }, { id: blankInspector, name: '검사 역할 설정 대기', country: '대한민국' }]) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [row.id, row.name, row.country])
 await query('insert into public.projects(id,name,season,code) values($1,$2,$3,$4)', [project.id, project.name, project.season, project.code])
 const people = [...fixture.profiles, { ...fixture.profiles[3], id: ableActor, email: 'able@qa.test', factoryId: able }, { ...fixture.profiles[3], id: kotitiActor, email: 'kotiti@qa.test', factoryId: kotiti }, { ...fixture.profiles[3], id: blankActor, email: 'blank@qa.test', factoryId: blankInspector }]
 for (const row of people) { await query('insert into auth.users(id,email) values($1,$2)', [row.id, row.email]);await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [row.id, row.name, row.role, row.approved, row.active, row.factoryId]) }
 await as(DEMO_IDS.admin)
 for (const [index, style] of styles.entries()) {
  await query('select public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), '기존 생산 자료 보존 검증'])
  const details = blankProductionDetails();details.quality = { category: '아우터', quantity: 120, status: 'todo', requestedAt: '2026-11-10', completedAt: '', note: '검사 담당자에게 전달할 검토 요청' }
  await query('select public.save_production_details($1,$2,0,$3::jsonb,$4)', [style.id, style.production[0].id, JSON.stringify(details), '품질 검사 원본 등록'])
  await query('select public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [runs[index], style.id, style.production[0].id, JSON.stringify({ name: '기존 발주 보존', projectId: project.id, projectCode: budget, expectedDue: '2026-11-10', poId: null, unitCost: null, itemType: 'product', order: style.production[0].order, correctsRunId: null }), '기존 생산 발주 등록'])
  await query('select public.save_partial_delivery_plan($1,0,$2::jsonb,$3)', [runs[index], JSON.stringify([{ id: crypto.randomUUID(), dueDate: '2026-11-10', quantity: Object.values(style.production[0].order).reduce((sum, value) => sum + value, 0), quantities: style.production[0].order, note: '기존 사이즈별 부분 납기 보존' }]), '기존 부분 납기 계획 등록'])
  await owner("insert into public.order_source_records(style_id,line_id,file_name,sheet_name,headers,rows_data,version,updated_by) values($1,$2,'private-original.csv','CSV','{}',$3::jsonb,1,$4)", [style.id, style.production[0].id, JSON.stringify([{ rowNumber: 2, columns: { A: budget, M: projectName, L: project.season, V: '본사 원본 비공개' } }]), DEMO_IDS.admin])
 }
 await query("insert into public.comments(style_id,body) values($1,'본사 원본 댓글 비공개')", [styles[1].id])
 await query("insert into storage.objects(bucket_id,name,metadata) values('sig-files',$1,$2::jsonb)", [originalPath, JSON.stringify({ mimetype: 'image/png', size: 100 })])
 await query("insert into public.attachments(id,style_id,name,path,mime,size) values($1,$2,'내부이미지.png',$3,'image/png',100)", [attachment, styles[1].id, originalPath])
 await query("select public.set_style_image($1,'',$2,0,$3)", [styles[1].id, attachment, '기존 대표 이미지 등록'])
 await query('select public.save_material_review_item($1,$2,$3,0,$4::jsonb,$5)', [material, styles[1].id, styles[1].production[0].id, JSON.stringify({ kind: 'fabric', name: '기존 원단 보존', specification: '본사 원부자재 내부 사양' }), '기존 원부자재 기록 등록'])
 await query('select public.save_po_dispatch($1,$2,0,$3::jsonb,$4)', [po, styles[1].id, JSON.stringify({ recipient: 'private@qa.test', dueDate: '2026-11-10', subject: '본사 PO 비공개', body: '본사 내부 발주 내용', evidenceAttachmentId: null, voided: false }), '이전 PO 원본 보존'])
 before020 = await business();await db.exec('reset role');await db.exec(readFileSync(sql, 'utf8'));await as(DEMO_IDS.admin)
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('020 품질 검사 배정과 최소 공개', () => {
 it('설치가 기존 프로젝트·생산·PO·원본·금액과 업체 구분을 바꾸지 않는다', async () => {
  expect(await business()).toEqual(before020)
  const vendors = (await owner('select service_type,inspection_provider,service_settings_version,active from public.factories')).rows
  expect(vendors.every(vendor => vendor.service_type === 'production' && vendor.inspection_provider === null && vendor.service_settings_version === 0 && vendor.active)).toBe(true)
 })
 it('명시적으로 설정한 검사 계정은 배정 전 0건이고 제공자 미지정 검사 계정도 생산 화면에 접근하지 않는다', async () => isolated(async () => {
  await settings();await settings(blankInspector, 'inspection', null)
  await as(ableActor);expect(await orders()).toEqual([])
  await owner("update public.styles set data=jsonb_set(data,'{factoryId}',to_jsonb($2::text)) where id=$1", [styles[1].id, blankInspector])
  await as(blankActor);expect(await orders()).toEqual([])
  expect((await query('select public.current_app_role() role,public.can_access_style($1) allowed', [styles[1].id])).rows[0]).toEqual({ role: null, allowed: false })
  expect((await query('select * from public.styles')).rows).toEqual([])
  expect((await query('select * from public.projects')).rows).toEqual([])
 }))
 it('본사가 에이블에 지정한 컬러만 최소 명칭·수량·검사 정보로 반환한다', async () => isolated(async () => {
  await settings();await settings(kotiti, 'inspection', 'kotiti');await assign('able')
  const before = await business();await as(ableActor)
  const rows = await orders();expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ styleId: styles[0].id, lineId: styles[0].production[0].id, projectId: project.id, projectName, season: project.season, provider: 'able', order: styles[0].production[0].order, quality: { category: '아우터', status: 'todo', quantity: 120, note: '검사 담당자에게 전달할 검토 요청' } })
  expect(Object.keys(rows[0]).sort()).toEqual(['color', 'dueDate', 'lineId', 'order', 'orderQuantity', 'projectId', 'projectName', 'provider', 'quality', 'season', 'styleCode', 'styleId'])
  expect(Object.keys(rows[0].quality).sort()).toEqual(['category', 'note', 'quantity', 'status'])
  for (const text of [budget, '본사 원본 비공개', '본사 내부 원본 공개 금지', 'private@qa.test', 'unitCost']) expect(JSON.stringify(rows)).not.toContain(text)
  await as(kotitiActor);expect(await orders()).toEqual([])
  expect(await business()).toEqual(before)
 }))
 it('재배정·해제 시 이전 검사 업체의 조회 범위를 즉시 제거한다', async () => isolated(async () => {
  await settings();await settings(kotiti, 'inspection', 'kotiti');await assign('able');await as(ableActor);expect(await orders()).toHaveLength(1)
  await as(DEMO_IDS.internal);await assign('kotiti', 1)
  await as(ableActor);expect(await orders()).toEqual([]);await as(kotitiActor);expect(await orders()).toHaveLength(1)
  await as(DEMO_IDS.admin);await assign(null, 2);await as(kotitiActor);expect(await orders()).toEqual([])
  const events = (await owner('select before,after from public.inspection_assignment_events order by created_at')).rows
  expect(events).toHaveLength(3);expect(events[1].before.provider).toBe('able');expect(events[2].after.provider).toBeNull()
 }))
 it('직접 URL·원본 테이블·이전 생산 RPC와 별칭 호출로 검사 계정이 발주를 우회 조회하지 못한다', async () => isolated(async () => {
  await settings();await assign('able', 0, styles[1]);await as(ableActor)
  expect(await orders()).toHaveLength(1)
  for (const table of ['styles', 'projects', 'po_dispatches', 'po_dispatch_attempts', 'production_runs', 'production_details', 'order_source_records', 'comments', 'attachments', 'style_images', 'audits', 'processing_unit_prices', 'material_review_items', 'material_review_rounds', 'material_review_events', 'inspection_assignments', 'inspection_assignment_events', 'factory_service_settings_events']) expect((await query(`select * from public.${table}`)).rows, table).toEqual([])
  expect((await query('select * from storage.objects')).rows).toEqual([])
  expect((await query('select public.get_production_project_names() value')).rows).toEqual([])
  for (const rpc of ['get_supplier_production_orders', 'get_production_conditions', 'get_partial_delivery_plans']) expect((await query(`select public.${rpc}() value`)).rows).toEqual([])
  for (const rpc of ['inspection_legacy_supplier_orders', 'inspection_legacy_production_conditions', 'inspection_legacy_partial_deliveries']) await expect(query(`select public.${rpc}()`)).rejects.toThrow(/permission denied/)
  await expect(query('select public.inspection_project_identity($1)', [project.id])).rejects.toThrow(/permission denied/)
  await expect(query('select public.operations_actor()')).rejects.toThrow(/FORBIDDEN|permission denied/)
  expect((await query('select public.can_access_storage_path($1) allowed', [`${styles[1].id}/${crypto.randomUUID()}.png`])).rows[0].allowed).toBe(false)
 }))
 it('최소 오더는 이전 JSON 안의 알 수 없는 항목을 노출하거나 합산하지 않는다', async () => isolated(async () => {
  await settings();await assign('able')
  await owner("update public.styles set data=jsonb_set(data,'{production,0,order,internalPrice}','987654321'::jsonb) where id=$1", [styles[0].id])
  await as(ableActor);const rows = await orders()
  expect(rows).toHaveLength(1)
  expect(rows[0].order).toEqual(styles[0].production[0].order)
  expect(rows[0].orderQuantity).toBe(Object.values(styles[0].production[0].order).reduce((sum, value) => sum + value, 0))
  expect(JSON.stringify(rows)).not.toContain('internalPrice');expect(JSON.stringify(rows)).not.toContain('987654321')
 }))
 it('검사 업체는 배정·서비스 역할·업무 원본을 수정하지 못한다', async () => isolated(async () => {
  await settings();await as(ableActor)
  await expect(assign('able')).rejects.toThrow(/FORBIDDEN/);await expect(settings(kotiti, 'inspection', 'kotiti')).rejects.toThrow(/FORBIDDEN/)
  await expect(query('update public.inspection_assignments set provider=$1', ['able'])).rejects.toThrow(/permission denied/)
  expect((await query('update public.factories set service_type=$2 where id=$1', [able, 'production'])).affectedRows).toBe(0)
  expect((await query('select service_type from public.factories where id=$1', [able])).rows[0].service_type).toBe('inspection')
  await expect(query('select public.save_style($1,$2::jsonb,1,$3)', [styles[1].id, JSON.stringify(styles[1]), '검사 업체 우회 수정'])).rejects.toThrow(/FORBIDDEN|permission denied/)
  await expect(query("insert into public.comments(style_id,body) values($1,'검사 업체 우회 입력')", [styles[1].id])).rejects.toThrow(/FORBIDDEN|permission denied|row-level security/)
  await expect(query("insert into storage.objects(bucket_id,name) values('sig-files',$1)", [`${styles[1].id}/${crypto.randomUUID()}.png`])).rejects.toThrow(/row-level security/)
  await expect(query("update public.styles set data=data where id=$1", [styles[1].id])).rejects.toThrow(/permission denied/)
  await expect(query('select public.save_partial_delivery_plan($1,1,$2::jsonb,$3)', [runs[1], '[]', '검사 업체 납기 우회 변경'])).rejects.toThrow(/FORBIDDEN/)
  await expect(query('select public.save_material_review_item($1,$2,$3,1,$4::jsonb,$5)', [material, styles[1].id, styles[1].production[0].id, JSON.stringify({ kind: 'fabric', name: '우회 수정', specification: '' }), '검사 업체 원부자재 우회 변경'])).rejects.toThrow(/FORBIDDEN/)
 }))
 it('본사 직원은 배정할 수 있지만 관리자 서비스 설정과 가격·기존 업무는 변경하지 않는다', async () => isolated(async () => {
  await settings();const before = await business();await as(DEMO_IDS.internal);await assign('able')
  expect((await orders()).filter(row => row.provider === 'able')).toHaveLength(1)
  await expect(settings(kotiti, 'inspection', 'kotiti')).rejects.toThrow(/FORBIDDEN/)
  expect(await business()).toEqual(before)
 }))
 it('미등록·비활성 검사 업체와 잘못된 컬러·오래된 배정은 거부한다', async () => isolated(async () => {
  await expect(assign('able')).rejects.toThrow(/INSPECTION_VENDOR_REQUIRED/)
  await settings();await owner('update public.factories set active=false where id=$1', [able]);await expect(assign('able')).rejects.toThrow(/INSPECTION_VENDOR_REQUIRED/)
  await owner('update public.factories set active=true where id=$1', [able]);await expect(assign('able', 0, styles[0], crypto.randomUUID())).rejects.toThrow(/FORBIDDEN/)
  await assign('able');await expect(assign('kotiti', 0)).rejects.toThrow(/VERSION_CONFLICT/)
 }))
 it('업체 역할 설정은 관리자 버전 검사와 공급자 중복 검사를 적용한다', async () => isolated(async () => {
  await settings();await expect(settings(able, 'inspection', 'able', 0)).rejects.toThrow(/VERSION_CONFLICT/)
  await expect(settings(kotiti, 'inspection', 'able')).rejects.toThrow(/duplicate key/)
  await owner('update public.factories set active=false where id=$1', [able]);await expect(settings(kotiti, 'inspection', 'able')).rejects.toThrow(/duplicate key/)
  await expect(settings(kotiti, 'production', 'kotiti')).rejects.toThrow(/INVALID_VENDOR_SERVICE/)
  await settings(kotiti, 'inspection', 'kotiti')
  expect((await owner('select * from public.factory_service_settings_events')).rows).toHaveLength(2)
 }))
 it('계정 비활성·미승인·업체 비활성·스타일 삭제는 검사 조회를 닫고 기존 생산 컬러는 삭제되지 않는다', async () => isolated(async () => {
  await settings();await assign('able');await owner('update public.profiles set active=false where id=$1', [ableActor]);await as(ableActor);expect(await orders()).toEqual([])
  await owner('update public.profiles set active=true where id=$1', [ableActor]);await owner('update public.factories set active=false where id=$1', [able]);await as(ableActor);expect(await orders()).toEqual([])
  await owner('update public.factories set active=true where id=$1', [able]);await owner('update public.styles set deleted_at=clock_timestamp() where id=$1', [styles[0].id]);await as(ableActor);expect(await orders()).toEqual([])
  await expect(owner("update public.styles set deleted_at=null,data=jsonb_set(data,'{production}',(data->'production')-0) where id=$1", [styles[0].id])).rejects.toThrow(/HISTORY_PROTECTED/)
  await as(pending);expect(await orders()).toEqual([]);await as(null);expect(await orders()).toEqual([])
 }))
 it('삭제 대신 미배정 이력을 남기며 과거 배정·역할 변경 이력을 덮어쓸 수 없다', async () => isolated(async () => {
  await settings();await assign('able');await assign(null, 1)
  await expect(owner('delete from public.inspection_assignments where style_id=$1', [styles[0].id])).rejects.toThrow(/HISTORY_PROTECTED/)
  await expect(owner("update public.inspection_assignment_events set reason='변조' where style_id=$1", [styles[0].id])).rejects.toThrow(/HISTORY_PROTECTED/)
  await expect(owner("update public.factory_service_settings_events set reason='변조' where factory_id=$1", [able])).rejects.toThrow(/HISTORY_PROTECTED/)
 }))
 it('기존 생산 공장은 기존 배정 스타일·발주 조회를 계속 사용한다', async () => isolated(async () => {
  await as(DEMO_IDS.factory);expect((await query('select public.can_access_style($1) allowed', [styles[0].id])).rows[0].allowed).toBe(true)
  expect((await query('select * from public.styles')).rows.map(row => row.id)).toEqual([styles[0].id])
  expect((await query('select public.get_supplier_production_orders() value')).rows).toHaveLength(1)
  const plans = (await query('select public.get_partial_delivery_plans() value')).rows
  expect(plans).toHaveLength(1);expect(plans[0].value.items[0].quantities).toEqual(styles[0].production[0].order)
  expect((await query('select public.get_production_project_names() value')).rows[0].value).toEqual({ projectId: project.id, name: projectName, season: project.season })
  expect(await orders()).toEqual([])
 }))
 it('020 재실행은 배정·이력·업무와 생산 RPC를 보존한다', async () => {
  await as(DEMO_IDS.admin);await settings();await assign('able');const before = await business(), events = await owner('select to_jsonb(t) value from public.inspection_assignment_events t')
  await db.exec('reset role');await db.exec(readFileSync(sql, 'utf8'));await as(ableActor);expect(await orders()).toHaveLength(1)
  expect(await business()).toEqual(before);expect((await owner('select to_jsonb(t) value from public.inspection_assignment_events t')).rows).toEqual(events.rows)
 })
})
