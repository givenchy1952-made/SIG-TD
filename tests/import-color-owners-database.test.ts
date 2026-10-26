import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { blankProduction, emptyQuantities, type Style } from '../src/lib/types'
import { ORDER_SOURCE_COLUMNS } from '../src/lib/operations-types'

const db = new PGlite(), fixture = createSeed(), style = structuredClone(fixture.styles[1]), lineId = style.production[0].id
const projectCode = 'COLOR-OWNER-PROJECT'
let transaction = false, sequence = 0
async function query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  if (!transaction) return db.query<T>(sql, params)
  const point = `owner_${sequence++}`; await db.exec(`savepoint ${point}`)
  try { const result = await db.query<T>(sql, params); await db.exec(`release savepoint ${point}`); return result }
  catch (error) { await db.exec(`rollback to savepoint ${point};release savepoint ${point}`); throw error }
}
async function as(id: string | null, role = 'authenticated') { await db.exec(`reset role;set role ${role}`); await query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']) }
async function isolated(fn: () => Promise<void>) { await db.exec('begin'); transaction = true; try { await as(DEMO_IDS.admin); await fn() } finally { transaction = false; await db.exec('rollback') } }
async function current() { return (await query<{ data: Style; version: number }>('select data,version from public.styles where id=$1', [style.id])).rows[0] }
async function saveStyle(data: Style, version: number) { return (await query('select * from public.save_style($1,$2::jsonb,$3,$4)', [style.id, JSON.stringify(data), version, '컬러 담당자 변경'])).rows[0] }
async function assign(ownerId: string) { const row = await current(); row.data.production.find(item => item.id === lineId)!.ownerId = ownerId; return saveStyle(row.data, row.version) }
const runInput = () => ({ name: '컬러별 생산', projectId: style.projectId, projectCode, expectedDue: '2026-12-20', poId: null, unitCost: 1200, itemType: 'product', order: { ...emptyQuantities(), S: 10 }, correctsRunId: null })
async function saveRun(id = crypto.randomUUID(), version = 0, targetLine = lineId) { return (await query('select * from public.save_production_run($1,$2,$3,$4::jsonb,$5,$6)', [id, style.id, targetLine, JSON.stringify(runInput()), version, '컬러별 차수 생성'])).rows[0] }
function project() { const item = fixture.projects.find(item => item.id === style.projectId)!; return { ...item, code: projectCode, expected: { code: projectCode, name: item.name, season: item.season } } }
async function register(data: Style, version: number) { return (await query('select * from public.register_order_style($1,$2,$3::jsonb,$4::jsonb,$5)', [data.id, version, JSON.stringify(data), JSON.stringify(project()), 'CSV 담당자 등록'])).rows[0] }
async function startedUnassignedRun() {
  await assign(''); const run = await saveRun(), po = crypto.randomUUID()
  await query('select public.create_production_order_po($1,1,$2,$3::jsonb,$4)', [run.id, po, JSON.stringify({ dueDate: '2026-12-20', recipient: 'factory@example.test', subject: '생산 요청', body: '생산 요청 납기 2026-12-20', evidenceAttachmentId: null, voided: false }), 'PO 초안 생성'])
  await query('select public.begin_po_dispatch($1,1)', [po])
  await as(null, 'service_role'); await query('select public.finalize_po_dispatch($1,$2,null,$3)', [po, 'owner-test-message', 'sent'])
  await as(DEMO_IDS.factory); await query('select public.accept_supplier_production_order($1,2,3,$2,true)', [run.id, '2026-12-21'])
  await as(DEMO_IDS.admin); await query('select public.allocate_production_receipt($1,$2,$3::jsonb,3,$4)', [crypto.randomUUID(), run.id, JSON.stringify({ receivedAt: '2026-12-22', quantities: { ...emptyQuantities(), S: 4 } }), '실입고 배분'])
  return run.id as string
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
  for (const name of ['001_initial.sql', '002_style_images.sql', '003_operations.sql', '004_settlement_terms.sql', '005_workflow_refinements.sql', '006_staff_approvals.sql', '007_production_ledger.sql', '008_supplier_acceptance.sql', '009_import_production_runs.sql', '010_member_withdrawal.sql', '011_import_color_owners.sql']) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
  for (const item of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)', [item.id, item.name, item.country])
  for (const item of fixture.projects) await query('insert into public.projects(id,name,season,code) values($1,$2,$3,$4)', [item.id, item.name, item.season, item.id === style.projectId ? projectCode : `OTHER-${item.id}`])
  for (const item of fixture.profiles) {
    await query('insert into auth.users(id,email) values($1,$2)', [item.id, item.email])
    await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1', [item.id, item.name, item.role, item.approved, item.active, item.factoryId])
  }
  style.code = 'BP06FYHD0402'; style.production[0].color = 'BL'; style.colors[0] = 'BL'; style.version = 0
  await as(DEMO_IDS.admin); await query('select public.save_style($1,$2::jsonb,0,$3)', [style.id, JSON.stringify(style), '컬러 담당자 테스트 스타일'])
}, 30000)
afterAll(async () => { await db.close() })

describe.sequential('011 실제 PostgreSQL 컬러별 담당자·미지정 오더', () => {
  it('기존 컬러에는 선택 필드가 없어도 기존 스타일 담당자를 사용한다', async () => isolated(async () => {
    const run = await saveRun()
    expect(run.owner_id_snapshot).toBe(style.ownerId); expect(run.style_code_snapshot).toBe('BP06FYHD0402BL')
  }))
  it('빈 스타일·샘플 담당자를 저장하며 명시적인 빈 컬러 담당자는 기본 담당자를 상속하지 않는다', async () => isolated(async () => {
    const row = await current(); row.data.ownerId = ''; for (const sample of row.data.samples) sample.ownerId = ''; row.data.production[0].ownerId = ''
    await saveStyle(row.data, row.version)
    const run = await saveRun()
    expect(run).toMatchObject({ owner_id_snapshot: null, owner_name_snapshot: '' })
    expect((await current()).data.samples.every(sample => sample.ownerId === '')).toBe(true)
  }))
  it('같은 기본 품번도 컬러별로 서로 다른 담당자를 보존한다', async () => isolated(async () => {
    const row = await current(); row.data.production[0].ownerId = DEMO_IDS.admin; row.data.production[1].ownerId = DEMO_IDS.internal
    await saveStyle(row.data, row.version)
    const first = await saveRun(), second = await saveRun(crypto.randomUUID(), 0, style.production[1].id)
    expect(first.owner_id_snapshot).toBe(DEMO_IDS.admin); expect(second.owner_id_snapshot).toBe(DEMO_IDS.internal)
    expect(first.style_code_snapshot).toBe('BP06FYHD0402BL'); expect(second.style_code_snapshot).toBe('BP06FYHD0402OW')
  }))
  it('기본 담당자가 있어도 CSV에서 명시한 공란 컬러는 미지정 차수로 업로드된다', async () => isolated(async () => {
    await assign(''); await as(DEMO_IDS.internal)
    const before = await current(), projectItem = fixture.projects.find(item => item.id === style.projectId)!
    const source = { expectedVersion: 0, fileName: 'color.csv', sheetName: 'ORDER QTY', headers: Object.fromEntries(ORDER_SOURCE_COLUMNS.map(column => [column, column])), rows: [{ rowNumber: 2, columns: { A: projectCode, F: 'BP06FYHD0402BL', L: projectItem.season, M: projectItem.name, S: '', V: '', W: '', X: '', Y: '', AQ: 0, AR: 0, AS: 4, AT: 0, AU: 0, AV: 0, AY: 4 } }] }
    const changes = [{ styleId: style.id, expectedVersion: before.version, lines: [{ lineId, color: 'BL', quantities: { ...emptyQuantities(), S: 4 }, source }] }]
    const result = (await query('select public.bulk_import_production_orders($1,$2::jsonb,$3,$4) result', [crypto.randomUUID(), JSON.stringify(changes), 'replace', '빈 담당자 오더 업로드'])).rows[0].result
    expect(result.runIds).toHaveLength(1)
    expect((await query('select owner_id_snapshot,owner_name_snapshot,order_quantities from public.production_runs')).rows).toEqual([{ owner_id_snapshot: null, owner_name_snapshot: '', order_quantities: { ...emptyQuantities(), S: 4 } }])
    expect((await query('select rows_data from public.order_source_records')).rows[0].rows_data[0].columns.Y).toBe('')
  }))
  it('새 품번과 공란 담당자를 한 번에 등록해 생산 차수를 만들 수 있다', async () => isolated(async () => {
    const data: Style = { ...structuredClone(style), id: crypto.randomUUID(), code: 'BP06FYHD0499', name: 'BP06FYHD0499', ownerId: '', colors: ['BL'], stage: 'registered', ppApproved: false, samples: [], production: [{ ...blankProduction('BL'), ownerId: '' }], version: 0 }
    await as(DEMO_IDS.internal); await register(data, 0)
    const run = (await query('select * from public.save_production_run($1,$2,$3,$4::jsonb,0,$5)', [crypto.randomUUID(), data.id, data.production[0].id, JSON.stringify(runInput()), '미지정 신규 생산 차수'])).rows[0]
    expect(run).toMatchObject({ owner_id_snapshot: null, owner_name_snapshot: '', style_code_snapshot: 'BP06FYHD0499BL' })
    expect((await query('select data from public.styles where id=$1', [data.id])).rows[0].data.ownerId).toBe('')
  }))
  it('기능 상태는 승인된 본사에만 열리고 익명은 조회할 수 없다', async () => isolated(async () => {
    expect((await query('select public.get_import_color_owners_capability() enabled')).rows[0].enabled).toBe(true)
    await as(DEMO_IDS.factory); expect((await query('select public.get_import_color_owners_capability() enabled')).rows[0].enabled).toBe(false)
    await as(fixture.profiles.find(item => !item.approved)!.id); expect((await query('select public.get_import_color_owners_capability() enabled')).rows[0].enabled).toBe(false)
    await as(null, 'anon'); await expect(query('select public.get_import_color_owners_capability()')).rejects.toThrow(/permission denied/)
  }))
  it('잘못된 담당자 타입·UUID·공장 계정·미승인 계정과 알 수 없는 필드를 거부한다', async () => isolated(async () => {
    const pending = fixture.profiles.find(item => !item.approved)!
    for (const owner of [null, false, ['bad'], 'not-a-uuid', crypto.randomUUID(), DEMO_IDS.factory, pending.id]) {
      const row = await current(); row.data.production[0].ownerId = owner as unknown as string
      await expect(saveStyle(row.data, row.version)).rejects.toThrow(/INVALID_STYLE/)
    }
    const row = await current(); Object.assign(row.data.production[0], { owner: DEMO_IDS.admin })
    await expect(saveStyle(row.data, row.version)).rejects.toThrow(/INVALID_STYLE/)
  }))
  it('스타일 기본 담당자는 공란만 예외이며 공장·잘못된 UUID를 허용하지 않는다', async () => isolated(async () => {
    for (const owner of [DEMO_IDS.factory, crypto.randomUUID(), 'invalid']) { const row = await current(); row.data.ownerId = owner; await expect(saveStyle(row.data, row.version)).rejects.toThrow(/INVALID_STYLE/) }
  }))
  it('기존 컬러의 CSV 등록은 담당자만 갱신하고 기존 수량·공정 변경은 거부한다', async () => isolated(async () => {
    const row = await current(); row.data.production[0].ownerId = ''
    await as(DEMO_IDS.internal); await register(row.data, row.version)
    const after = await current(); expect(after.data.ownerId).toBe(style.ownerId); expect(after.data.production[0].ownerId).toBe('')
    expect(after.data.production[0].order).toEqual(style.production[0].order)
    after.data.production[0].order.S += 1
    await expect(register(after.data, after.version)).rejects.toThrow(/INVALID_REGISTRATION/)
  }))
  it('신규 컬러 등록은 빈 수량과 명시적 담당자를 함께 받는다', async () => isolated(async () => {
    const row = await current(), line = { ...blankProduction('RD'), ownerId: '' }; row.data.colors.push('RD'); row.data.production.push(line)
    await register(row.data, row.version)
    expect((await current()).data.production.find(item => item.color === 'RD')).toMatchObject({ ownerId: '', order: emptyQuantities() })
  }))
  it('공장은 본인에게 배정된 스타일도 컬러 담당자를 수정할 수 없다', async () => isolated(async () => {
    const row = await current(); row.data.production[0].ownerId = DEMO_IDS.admin
    await as(DEMO_IDS.factory); await expect(saveStyle(row.data, row.version)).rejects.toThrow(/FORBIDDEN_FIELD/)
    await expect(register(row.data, row.version)).rejects.toThrow(/FORBIDDEN/)
  }))
  it('공장은 접근 가능한 컬러 담당자의 표시명만 보고 타 공장의 담당자와 이메일은 볼 수 없다', async () => isolated(async () => {
    const colorOwner = crypto.randomUUID(), otherOwner = crypto.randomUUID()
    await db.exec('reset role')
    for (const [id, name] of [[colorOwner, '컬러 전담 직원'], [otherOwner, '다른 공장 직원']]) {
      await query('insert into auth.users(id,email) values($1,$2)', [id, `${id}@private.example.test`])
      await query("update public.profiles set name=$2,role='internal',approved=true,active=true where id=$1", [id, name])
    }
    await as(DEMO_IDS.admin); await assign(colorOwner)
    const otherFactory = fixture.factories.find(item => item.id !== style.factoryId)!
    const otherStyle: Style = { ...structuredClone(style), id: crypto.randomUUID(), code: 'BP06FYHD0999', name: '타 공장 스타일', factoryId: otherFactory.id, ownerId: otherOwner, samples: [], production: [{ ...blankProduction('BK'), ownerId: otherOwner }], colors: ['BK'], version: 0 }
    await query('select public.save_style($1,$2::jsonb,0,$3)', [otherStyle.id, JSON.stringify(otherStyle), '공장별 표시 권한 테스트'])
    await as(DEMO_IDS.factory)
    const projected = (await query('select * from public.visible_style_owners()')).rows
    expect(projected).toContainEqual({ id: colorOwner, name: '컬러 전담 직원', role: 'internal' })
    expect(projected.some(item => item.id === otherOwner)).toBe(false)
    for (const owner of projected) expect(Object.keys(owner).sort()).toEqual(['id', 'name', 'role'])
    expect((await query('select id from public.profiles where id=$1', [colorOwner])).rows).toHaveLength(0)
    await as(null, 'anon'); await expect(query('select * from public.visible_style_owners()')).rejects.toThrow(/permission denied/)
  }))
  it('담당자가 탈퇴해도 공장은 기존 기록을 계속 작성하고 본사는 컬러별로 재배정할 수 있다', async () => isolated(async () => {
    const before = await current(); before.data.ownerId = DEMO_IDS.internal
    for (const line of before.data.production) line.ownerId = DEMO_IDS.internal
    await saveStyle(before.data, before.version)
    await query('select public.withdraw_workspace_member($1,$2)', [DEMO_IDS.internal, '담당자 퇴사 처리'])
    await as(DEMO_IDS.factory)
    const factoryEdit = await current(); factoryEdit.data.production[0].factoryComment = '퇴사 후에도 생산 진행'; factoryEdit.data.production[0].shipped.S += 1
    await saveStyle(factoryEdit.data, factoryEdit.version)
    await as(DEMO_IDS.admin)
    const reassign = await current(); reassign.data.production[0].ownerId = DEMO_IDS.admin
    await saveStyle(reassign.data, reassign.version)
    const after = await current()
    expect(after.data.ownerId).toBe(DEMO_IDS.internal)
    expect(after.data.production[0]).toMatchObject({ ownerId: DEMO_IDS.admin, factoryComment: '퇴사 후에도 생산 진행' })
    expect(after.data.production[1].ownerId).toBe(DEMO_IDS.internal)
    expect(after.data.production[0].shipped.S).toBe(before.data.production[0].shipped.S + 1)
    // Reassigning back to an inactive owner is a new assignment, not retention.
    after.data.production[0].ownerId = DEMO_IDS.internal
    await expect(saveStyle(after.data, after.version)).rejects.toThrow(/INVALID_STYLE/)
    const newStyle: Style = { ...structuredClone(before.data), id: crypto.randomUUID(), code: 'BP06FYHD0988', name: '퇴사자 신규 배정 금지', samples: [], version: 0 }
    await expect(query('select public.save_style($1,$2::jsonb,0,$3)', [newStyle.id, JSON.stringify(newStyle), '신규 배정 검증'])).rejects.toThrow(/INVALID_STYLE/)
    const newColor = await current(); newColor.data.colors.push('RD'); newColor.data.production.push({ ...blankProduction('RD'), ownerId: DEMO_IDS.internal })
    await expect(saveStyle(newColor.data, newColor.version)).rejects.toThrow(/INVALID_STYLE/)
  }))
  it('미지정 차수는 수동 지정 후 저장할 때 담당자를 한 번 채우고 이후 재배정으로 과거 값을 바꾸지 않는다', async () => isolated(async () => {
    await assign(''); const first = await saveRun(); await assign(DEMO_IDS.admin)
    const assigned = await saveRun(first.id, 1); expect(assigned.owner_id_snapshot).toBe(DEMO_IDS.admin)
    await assign(DEMO_IDS.internal); const preserved = await saveRun(first.id, 2)
    expect(preserved.owner_id_snapshot).toBe(DEMO_IDS.admin); expect(preserved.owner_name_snapshot).toBe(fixture.profiles.find(item => item.id === DEMO_IDS.admin)!.name)
    expect((await saveRun()).owner_id_snapshot).toBe(DEMO_IDS.internal)
  }))
  it('미지정 담당자로는 마감할 수 없고 수동 배정 후 바로 확정하면 그 담당자를 고정한다', async () => isolated(async () => {
    const id = await startedUnassignedRun()
    await expect(query('select public.finalize_production_run($1,4,$2)', [id, '담당자 미지정 마감'])).rejects.toThrow(/OWNER_REQUIRED|owner|required/)
    await assign(DEMO_IDS.admin)
    const closed = (await query('select * from public.finalize_production_run($1,4,$2)', [id, '배정 후 마감 확정'])).rows[0]
    expect(closed.owner_id_snapshot).toBe(DEMO_IDS.admin); expect(closed.snapshot.ownerIdSnapshot).toBe(DEMO_IDS.admin)
    expect(closed.snapshot.owner).toBe(fixture.profiles.find(item => item.id === DEMO_IDS.admin)!.name)
    await assign(DEMO_IDS.internal)
    expect((await query('select snapshot from public.production_runs where id=$1', [id])).rows[0].snapshot).toEqual(closed.snapshot)
  }))
})
