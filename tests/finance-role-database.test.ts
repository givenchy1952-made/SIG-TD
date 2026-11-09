import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { blankProduction } from '../src/lib/types'

const DEMO_IDS = { admin: '10000000-0000-4000-8000-000000000001', internal: '10000000-0000-4000-8000-000000000002', factory: '10000000-0000-4000-8000-000000000004', china: '20000000-0000-4000-8000-000000000002' }
const db = new PGlite()
const seed = {
  factories: [{ id: DEMO_IDS.china, name: '권한 검증 공장', country: '중국' }],
  profiles: [
    { id: DEMO_IDS.admin, name: '관리자', email: 'admin@example.test', role: 'admin', approved: true, active: true, factoryId: null },
    { id: DEMO_IDS.internal, name: '본사 직원', email: 'internal@example.test', role: 'internal', approved: true, active: true, factoryId: null },
    { id: DEMO_IDS.factory, name: '공장 담당자', email: 'factory@example.test', role: 'factory', approved: true, active: true, factoryId: DEMO_IDS.china },
  ],
}
const finance = crypto.randomUUID(), pendingFinance = crypto.randomUUID(), spoofSignup = crypto.randomUUID()
const project = { id: crypto.randomUUID(), name: '시그니피컨트 2026 11M-1', season: '2026FY' }
const line = blankProduction('BK'); line.order.M = 100
const style = { id: crypto.randomUUID(), code: 'QAFINANCE0001', name: 'FA 원본 접근 시험', category: 'OUTERWEAR', season: project.season, projectId: project.id, factoryId: DEMO_IDS.china, ownerId: DEMO_IDS.internal, colors: ['BK'], dueDate: '2026-12-01', stage: 'production', ppApproved: true, notes: 'FA에 노출하면 안 되는 생산 원본', samples: [], production: [line], version: 0, updatedAt: '2026-11-08T01:00:00Z', updatedBy: DEMO_IDS.admin, deletedAt: null }
const po = crypto.randomUUID(), file = crypto.randomUUID(), launch = crypto.randomUUID(), privateLeave = crypto.randomUUID()
const path = `${style.id}/${file}.pdf`, reason = 'FA 권한과 원본 보존 검증'
const migration = new URL('../supabase/migrations/022_finance_role.sql', import.meta.url)
let transaction = false, sequence = 0, beforeInstall: unknown, afterInstall: unknown

async function query<T = Record<string, any>>(sql: string, params: unknown[] = []) {
  if (!transaction) return db.query<T>(sql, params)
  const savepoint = `finance_${sequence++}`; await db.exec(`savepoint ${savepoint}`)
  try { const value = await db.query<T>(sql, params); await db.exec(`release savepoint ${savepoint}`); return value }
  catch (error) { await db.exec(`rollback to savepoint ${savepoint};release savepoint ${savepoint}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function owner(sql: string, params: unknown[] = []) { await db.exec('reset role'); try { return await query(sql, params) } finally { await as(DEMO_IDS.admin) } }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await as(DEMO_IDS.admin); await fn() } finally { transaction = false; await db.exec('rollback') } }
async function manage(id: string, role: string, approved = true, active = true) {
  return query('select * from public.manage_profile($1,$2,$3,$4,$5,$6)', [id, 'FA 권한 테스트', role, approved, active, role === 'factory' ? style.factoryId : null])
}
async function business() {
  const value: Record<string, unknown> = {}
  for (const table of ['profiles', 'projects', 'factories', 'styles', 'po_dispatches', 'attachments', 'comments', 'settlement_terms', 'settlement_terms_audits', 'calendar_events', 'calendar_event_audits', 'audits']) value[table] = (await owner(`select to_jsonb(t) value from public.${table} t order by to_jsonb(t)::text`)).rows
  return value
}
const rawTables = ['styles', 'projects', 'factories', 'comments', 'attachments', 'style_images', 'audits', 'po_dispatches', 'po_dispatch_attempts', 'order_source_records', 'shipment_ledgers', 'shipment_batches', 'style_operations', 'operation_catalogs', 'employee_factory_assignments', 'calendar_events', 'calendar_event_audits', 'settlement_terms', 'settlement_terms_audits', 'production_runs', 'production_receipts', 'production_run_audits', 'production_details', 'processing_unit_prices', 'processing_unit_price_audits', 'material_review_items', 'material_review_rounds', 'material_review_attachments', 'material_review_events', 'inspection_assignments', 'inspection_assignment_events', 'factory_service_settings_events', 'supplier_work_rates', 'supplier_work_rate_audits', 'supplier_work_item_audits']

beforeAll(async () => {
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create schema storage;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,last_accessed_at timestamptz,unique(bucket_id,name));alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;grant select,insert,update,delete on storage.objects to authenticated;`)
  for (const name of readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter(name => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 21).sort()) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const row of seed.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [row.id, row.name, row.country])
  await query('insert into public.projects(id,name,season,code) values($1,$2,$3,$4)', [project.id, project.name, project.season, 'SIGNIFICANT-2026FY-RPQ-46024'])
  for (const row of seed.profiles.filter(row => row.role !== 'finance')) {
    await query('insert into auth.users(id,email) values($1,$2)', [row.id, row.email])
    await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [row.id, row.name, row.role, row.approved, row.active, row.factoryId])
  }
  for (const id of [finance, pendingFinance]) await query('insert into auth.users(id,email) values($1,$2)', [id, `${id}@example.test`])
  await as(DEMO_IDS.admin)
  await query('select public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), reason])
  await query('select public.save_po_dispatch($1,$2,0,$3::jsonb,$4)', [po, style.id, JSON.stringify({ recipient: 'private@example.test', dueDate: '2026-12-01', subject: '내부 PO', body: 'FA에게 전송하지 않는 생산 협의', evidenceAttachmentId: null, voided: false }), reason])
  await query("insert into public.comments(style_id,body) values($1,'FA에게 노출하지 않는 공장 코멘트')", [style.id])
  await query("insert into storage.objects(bucket_id,name,metadata) values('sig-files',$1,$2::jsonb)", [path, JSON.stringify({ size: 100, mimetype: 'application/pdf' })])
  await query("insert into public.attachments(id,style_id,name,path,mime,size) values($1,$2,'원본.pdf',$3,'application/pdf',100)", [file, style.id, path])
  await query('select public.save_settlement_terms($1,$2,0,$3::jsonb,$4)', [style.id, style.production[0].id, JSON.stringify({ projectCode: 'SIGNIFICANT-2026FY-RPQ-46024', unitCost: 12345, itemType: 'product' }), reason])
  await owner("insert into public.calendar_events(id,kind,visibility,title,start_date,end_date,owner_id,note,version,updated_by) values($1,'launch','all','다른 부서 출시 일정','2026-12-01','2026-12-01',$2,'비예산 일정',1,$2),($3,'personal_leave','private','FA 전환 전 개인 휴가','2026-12-02','2026-12-02',$4,'개인 정보',1,$2)", [launch, DEMO_IDS.admin, privateLeave, finance])
  beforeInstall = await business(); await db.exec('reset role'); await db.exec(readFileSync(migration, 'utf8')); afterInstall = await business()
  await as(DEMO_IDS.admin); await manage(finance, 'finance'); await manage(pendingFinance, 'finance', false)
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('022 FA팀 역할은 별도 예산 조회만 허용하고 기존 원본을 차단한다', () => {
  it('설치와 재실행은 기존 프로젝트·스타일·PO·파일·금액·사용자 역할을 보존한다', async () => {
    expect(afterInstall).toEqual(beforeInstall)
    const before = await business(); await db.exec('reset role'); await db.exec(readFileSync(migration, 'utf8')); await as(DEMO_IDS.admin)
    expect(await business()).toEqual(before)
  })
  it('관리자만 FA팀을 지정하고 직원의 승격·FA 계정 변경은 거부한다', async () => isolated(async () => {
    await as(DEMO_IDS.internal)
    await expect(manage(pendingFinance, 'finance')).rejects.toThrow(/FORBIDDEN/)
    await expect(manage(finance, 'internal')).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.admin)
    expect((await manage(pendingFinance, 'finance')).rows[0]).toMatchObject({ role: 'finance', approved: true, active: true, factory_id: null })
    await as(finance); await expect(manage(pendingFinance, 'internal')).rejects.toThrow(/FORBIDDEN/)
  }))
  it('가입 메타데이터의 FA·승인 요청은 권한을 부여하지 않는다', async () => isolated(async () => {
    await owner('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3::jsonb)', [spoofSignup, 'spoof@example.test', JSON.stringify({ role: 'finance', approved: true, active: true })])
    await as(spoofSignup)
    expect((await query('select role,approved,active,factory_id from public.profiles')).rows).toEqual([{ role: 'internal', approved: false, active: true, factory_id: null }])
  }))
  it('승인된 FA도 본인 프로필 외 생산·공장·파일·금액·캘린더 원본을 읽지 못한다', async () => isolated(async () => {
    await as(finance)
    expect((await query('select id,role from public.profiles')).rows).toEqual([{ id: finance, role: 'finance' }])
    expect((await query('select public.current_app_role() role,public.can_access_style($1) style,public.can_access_storage_path($2) storage,public.can_read_calendar_event($3) launch,public.can_read_calendar_event($4) own_leave', [style.id, path, launch, privateLeave])).rows[0]).toEqual({ role: null, style: false, storage: false, launch: false, own_leave: false })
    for (const table of rawTables) {
      try { expect((await query(`select * from public.${table}`)).rows, table).toEqual([]) }
      catch (error) { expect(String(error), table).toMatch(/permission denied/) }
    }
    expect((await query('select * from storage.objects')).rows).toEqual([])
    expect((await query('select * from public.visible_style_owners()')).rows).toEqual([])
    expect((await query('select public.get_production_project_names()')).rows).toEqual([])
    expect((await query('select public.get_inspection_orders()')).rows).toEqual([])
    expect((await query("select public.can_read_calendar_snapshot('{\"kind\":\"launch\",\"visibility\":\"all\"}'::jsonb) allowed")).rows[0].allowed).toBe(false)
    for (const rpc of ['get_supplier_production_orders', 'get_production_conditions']) await expect(query(`select public.${rpc}()`)).rejects.toThrow(/FORBIDDEN|permission denied/)
    expect((await query('select public.get_partial_delivery_plans()')).rows).toEqual([])
  }))
  it('직접 RPC와 DML로 신규 스타일·원본 변경·승인·파일 업로드를 우회하지 못한다', async () => isolated(async () => {
    const before = await business(); await as(finance)
    const fresh = { ...style, id: crypto.randomUUID(), code: 'FINANCEUNAUTHORIZED' }
    for (const [id, data, version] of [[fresh.id, fresh, 0], [style.id, style, 1]] as const) await expect(query('select public.save_style($1,$2::jsonb,$3,$4)', [id, JSON.stringify(data), version, reason])).rejects.toThrow(/FORBIDDEN/)
    await expect(query('select public.operations_actor()')).rejects.toThrow(/permission denied|FORBIDDEN/)
    await expect(query('select public.save_settlement_terms($1,$2,1,$3::jsonb,$4)', [style.id, style.production[0].id, JSON.stringify({ projectCode: '', unitCost: 1, itemType: 'product' }), reason])).rejects.toThrow(/FORBIDDEN/)
    await expect(query('select public.save_po_dispatch($1,$2,1,$3::jsonb,$4)', [po, style.id, '{}', reason])).rejects.toThrow(/FORBIDDEN/)
    await expect(query('update public.profiles set approved=true where id=$1', [finance])).rejects.toThrow(/permission denied/)
    await expect(query('update public.styles set data=data where id=$1', [style.id])).rejects.toThrow(/permission denied/)
    await expect(query("insert into public.comments(style_id,body) values($1,'FA 우회 댓글')", [style.id])).rejects.toThrow(/FORBIDDEN|row-level security/)
    await expect(query("insert into storage.objects(bucket_id,name) values('sig-files',$1)", [`${style.id}/${crypto.randomUUID()}.pdf`])).rejects.toThrow(/row-level security/)
    expect(await business()).toEqual(before)
  }))
  it('미승인·비활성 FA와 공장 연결이 남은 FA도 생산 접근을 얻지 못한다', async () => isolated(async () => {
    for (const actor of [pendingFinance, finance]) {
      if (actor === finance) await owner('update public.profiles set active=false where id=$1', [finance])
      await as(actor)
      expect((await query('select * from public.styles')).rows).toEqual([])
      expect((await query('select * from public.po_dispatches')).rows).toEqual([])
      expect((await query('select * from public.calendar_events')).rows).toEqual([])
      await expect(manage(pendingFinance, 'internal')).rejects.toThrow(/FORBIDDEN/)
    }
    await owner('update public.profiles set active=true,factory_id=$2 where id=$1', [finance, style.factoryId]); await as(finance)
    expect((await query('select public.can_access_style($1) allowed', [style.id])).rows[0].allowed).toBe(false)
    expect((await query('select * from public.factories')).rows).toEqual([])
    await as(null, 'anon'); await expect(query('select public.get_finance_role_capability()')).rejects.toThrow(/permission denied/)
  }))
  it('기존 본사와 배정 공장의 스타일·파일·캘린더 권한은 유지한다', async () => isolated(async () => {
    for (const actor of [DEMO_IDS.admin, DEMO_IDS.internal]) {
      await as(actor)
      expect((await query('select public.get_finance_role_capability() enabled')).rows[0].enabled).toBe(true)
      expect((await query('select id from public.styles')).rows).toEqual([{ id: style.id }])
      expect((await query('select style_id from public.settlement_terms')).rows).toEqual([{ style_id: style.id }])
    }
    await as(DEMO_IDS.factory)
    expect((await query('select id from public.styles')).rows).toEqual([{ id: style.id }])
    expect((await query('select id from public.attachments')).rows).toEqual([{ id: file }])
    expect((await query('select id from public.calendar_events')).rows).toEqual([{ id: launch }])
    expect((await query('select * from public.settlement_terms')).rows).toEqual([])
  }))
})
