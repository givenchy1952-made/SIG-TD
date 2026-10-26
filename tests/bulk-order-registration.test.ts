import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { quantityTotal } from '../src/lib/types'
import { buildOrderImportPreview, orderImportDefaults, parseOrderWorkbook, type OrderImportOptions } from '../src/lib/order-import'
import { buildBulkOrderRegistrationPlan, sourceFactoryGroups } from '../src/lib/bulk-order-registration'
import { importProductionOrdersInWorkspace } from '../src/lib/round-import'
vi.mock('../src/lib/repository', () => ({ supabase: null, getDemoWorkspace: vi.fn(), locked: vi.fn(), persist: vi.fn() }))
import { registerOrderStyleInWorkspace } from '../src/lib/workflow-repository'

async function fixture() {
  const bytes = await readFile(new URL('./fixtures/sig-order-26-cp949.csv', import.meta.url))
  const book = await parseOrderWorkbook(new File([bytes], 'qa-orders.csv'))
  const workspace = createSeed(); workspace.styles = []; workspace.projects = []
  workspace.factories = Array.from({ length: 8 }, (_, index) => ({ id: crypto.randomUUID(), name: `QA 공장 ${index + 1}`, country: '대한민국' }))
  const actor = workspace.profiles.find(person => person.id === DEMO_IDS.internal)!
  const defaults = orderImportDefaults(book), sheet = book.sheets[defaults.sheetIndex]
  const options: OrderImportOptions = { ...defaults, fileName: book.name, createProductionRounds: true, sigBudgetFallback: true, duplicateMode: 'reject', missingSizes: 'reject', mode: 'replace' }
  const settings = { defaults: { ownerId: actor.id, dueDate: '2026-11-20' }, factoryMappings: {} }
  const build = () => buildBulkOrderRegistrationPlan(workspace, sheet, options, settings)
  return { workspace, actor, sheet, options, settings, build }
}

describe('여러 신규 품번의 등록 계획', () => {
  it('26개 컬러 품번을 19개 스타일·한 프로젝트로 묶고 7,950개 수량을 읽는다', async () => {
    const { workspace, build } = await fixture(), before = structuredClone(workspace), plan = build()
    expect(plan.errors).toEqual([])
    expect(plan.entries).toHaveLength(19)
    expect(plan.newStyleCount).toBe(19); expect(plan.newColorCount).toBe(26); expect(plan.projectCount).toBe(1)
    expect(plan.preview.rows).toHaveLength(26)
    expect(plan.preview.rows.reduce((sum, row) => sum + quantityTotal(row.imported), 0)).toBe(7950)
    expect(plan.prepared.projects).toHaveLength(1)
    expect(new Set(plan.entries.map(entry => entry.project.id)).size).toBe(1)
    expect(workspace).toEqual(before)
    for (const { style } of plan.entries) {
      expect(style.version).toBe(0); expect(style.ownerId).toBe(DEMO_IDS.internal); expect(style.dueDate).toBe('2026-11-20')
      expect(style.samples).toEqual([])
      for (const line of style.production) for (const key of ['order', 'received', 'shipped', 'packing'] as const) expect(quantityTotal(line[key])).toBe(0)
    }
  })
  it('첫 프로젝트만 신규 등록하고 나머지 저장은 등록된 프로젝트의 정확한 스냅샷을 사용한다', async () => {
    const { workspace, actor, options, sheet, build } = await fixture(), plan = build()
    expect(plan.entries[0].project.expected).toBeNull()
    for (const { project } of plan.entries.slice(1)) expect(project.expected).toEqual({ code: project.code, name: project.name, season: project.season })
    let current = workspace
    for (const entry of plan.entries) current = registerOrderStyleInWorkspace(current, actor, entry.style, entry.project, 'QA 여러 품번 등록')
    expect(current.styles).toHaveLength(19); expect(current.projects).toHaveLength(1)
    expect(current.styles.every(style => style.version === 1)).toBe(true)
    const preview = buildOrderImportPreview(current, sheet, options)
    expect([...preview.errors, ...preview.rows.flatMap(row => row.errors)]).toEqual([])
    expect(preview.changes).toHaveLength(19)
    const imported = importProductionOrdersInWorkspace(current, actor, crypto.randomUUID(), preview.changes, 'replace', 'QA 26컬러 오더 적용')
    expect(imported.productionRuns).toHaveLength(26)
    expect(imported.productionRuns!.reduce((sum, run) => sum + quantityTotal(run.order), 0)).toBe(7950)
    expect(imported.styles.reduce((sum, style) => sum + style.production.reduce((count, line) => count + quantityTotal(line.order), 0), 0)).toBe(7950)
  })
  it('중간에 등록이 멈춰도 이미 등록한 품번·프로젝트를 다시 만들지 않는다', async () => {
    const { workspace, actor, sheet, options, settings, build } = await fixture(), plan = build()
    let current = workspace
    for (const entry of plan.entries.slice(0, 3)) current = registerOrderStyleInWorkspace(current, actor, entry.style, entry.project, 'QA 등록 재개')
    const resumed = buildBulkOrderRegistrationPlan(current, sheet, options, settings)
    expect(resumed.errors).toEqual([]); expect(resumed.entries).toHaveLength(16); expect(resumed.newStyleCount).toBe(16)
    for (const entry of resumed.entries) current = registerOrderStyleInWorkspace(current, actor, entry.style, entry.project, 'QA 등록 재개')
    expect(current.styles).toHaveLength(19); expect(current.projects).toHaveLength(1)
  })
  it('코드가 비어 있는 기존 프로젝트를 한 번만 연결하고 혼합 대소문자 코드의 스냅샷을 일치시킨다', async () => {
    const { workspace, actor, sheet, build } = await fixture()
    workspace.projects.push({ id: crypto.randomUUID(), code: '', name: 'QA 2026 생산 프로젝트', season: '2026FY' })
    sheet.rows[8][0] = String(sheet.rows[8][0]).toLowerCase()
    const plan = build()
    expect(plan.errors).toEqual([]); expect(plan.prepared.projects).toHaveLength(1)
    expect(plan.entries[0].project.expected).toMatchObject({ code: '' })
    let current = workspace
    for (const entry of plan.entries) current = registerOrderStyleInWorkspace(current, actor, entry.style, entry.project, 'QA 기존 프로젝트 연결')
    expect(current.projects).toHaveLength(1)
    expect(current.projects[0].code).toBe('QA-PROJECT-2026-RPQ-00001')
  })
  it('등록된 전체 품번은 빈 업데이트 없이 수량 적용 미리보기만 준비한다', async () => {
    const { workspace, actor, sheet, options, settings, build } = await fixture()
    let current = workspace
    for (const entry of build().entries) current = registerOrderStyleInWorkspace(current, actor, entry.style, entry.project, 'QA 기존 품번 준비')
    const result = buildBulkOrderRegistrationPlan(current, sheet, options, settings)
    expect(result.errors).toEqual([]); expect(result.entries).toHaveLength(0)
    expect(result.newStyleCount).toBe(0); expect(result.newColorCount).toBe(0); expect(result.preview.changes).toHaveLength(19)
  })
  it('파일 생산처를 공백·대소문자·법인 표기만 정규화해 유일한 등록 공장과 연결한다', async () => {
    const { workspace, sheet, options } = await fixture()
    workspace.factories[0].name = '(주) qA 공장 1'
    for (const row of sheet.rows.slice(options.headerRow)) if (row[22] === 'QA 공장 1') row[22] = ' 주식회사 QA 공장 1 '
    const groups = sourceFactoryGroups(workspace, sheet, options.headerRow)
    expect(groups).toHaveLength(8)
    expect(groups.find(group => group.source === '주식회사 QA 공장 1')?.factoryId).toBe(workspace.factories[0].id)
    expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(26)
  })
  it('생산처를 새 공장으로 만들거나 모호한 이름을 임의 선택하지 않는다', async () => {
    const { workspace, sheet, options, build } = await fixture()
    workspace.factories.push({ ...workspace.factories[0], id: crypto.randomUUID(), name: '(주) QA 공장 1' })
    expect(sourceFactoryGroups(workspace, sheet, options.headerRow).find(group => group.source === 'QA 공장 1')?.factoryId).toBe('')
    expect(build().errors.join(' ')).toContain('담당 공장')
    expect(workspace.factories).toHaveLength(9)
  })
  it('사용자가 명시한 공장 배정은 자동 이름 매칭보다 우선한다', async () => {
    const { workspace, settings, build } = await fixture()
    settings.factoryMappings = { 'QA 공장 1': workspace.factories[7].id }
    const result = build()
    expect(result.errors).toEqual([])
    expect(result.entries.find(entry => entry.style.code === 'QA26FYTS0001')?.style.factoryId).toBe(workspace.factories[7].id)
    settings.factoryMappings['QA 공장 1'] = ''
    expect(build().errors.join(' ')).toContain('담당 공장')
  })
  it('같은 기본 품번의 컬러가 서로 다른 공장을 지정하면 등록을 막는다', async () => {
    const { sheet, build } = await fixture()
    sheet.rows.find(row => row[5] === 'QA26FYTS0003NV')![22] = 'QA 공장 1'
    expect(build().errors.join(' ')).toContain('컬러별 담당 공장이 다릅니다')
  })
  it('입고예정일 없는 신규 품번은 기준 납기 선택을 요구하고 발주 요청일을 대신 쓰지 않는다', async () => {
    const { settings, build } = await fixture()
    settings.defaults.dueDate = ''
    const result = build()
    expect(result.errors.join(' ')).toContain('납기일')
    expect(result.entries.every(entry => entry.style.dueDate === '')).toBe(true)
  })
  it('실제 AO 입고예정일이 있으면 공통 기본 납기보다 우선한다', async () => {
    const { sheet, build } = await fixture()
    sheet.rows[7][40] = '2026-11-25'
    const result = build()
    expect(result.errors).toEqual([])
    expect(result.entries.find(entry => entry.style.code === 'QA26FYTS0001')?.style.dueDate).toBe('2026-11-25')
  })
  it.each(['factory', 'inactive', 'pending'])('유효하지 않은 기본 담당자 %s를 신규 품번에 배정하지 않는다', async kind => {
    const { workspace, settings, build } = await fixture()
    const profile = workspace.profiles.find(person => person.id === settings.defaults.ownerId)!
    if (kind === 'factory') profile.role = 'factory'
    if (kind === 'inactive') profile.active = false
    if (kind === 'pending') profile.approved = false
    expect(build().errors.join(' ')).toContain('본사 담당자')
  })
  it('명시적으로 선택한 공통 담당자는 신규 품번의 Y열 자동 매칭보다 우선한다', async () => {
    const { workspace, sheet, settings, build } = await fixture()
    sheet.rows[7][24] = workspace.profiles.find(person => person.id === DEMO_IDS.admin)!.name
    settings.defaults.ownerId = DEMO_IDS.internal
    const result = build()
    expect(result.errors).toEqual([])
    expect(result.entries.every(entry => entry.style.ownerId === DEMO_IDS.internal)).toBe(true)
    expect(result.preview.rows.find(row => row.rowNumbers.includes(8))!.source!.rows[0].columns.Y).toBe(sheet.rows[7][24])
  })
  it('기존 스타일의 공장·담당자·납기와 수량은 파일 기본값으로 덮어쓰지 않는다', async () => {
    const { workspace, actor, settings, sheet, options, build } = await fixture()
    const first = build().entries[0]
    const current = registerOrderStyleInWorkspace(workspace, actor, first.style, first.project, 'QA 기존 스타일')
    const previous = current.styles.find(style => style.id === first.style.id)!
    previous.dueDate = '2026-12-01'; previous.ownerId = DEMO_IDS.admin; previous.production[0].received.S = 7
    const before = structuredClone(previous)
    settings.defaults.dueDate = '2027-01-01'; settings.factoryMappings = { 'QA 공장 1': workspace.factories[7].id }
    const plan = buildBulkOrderRegistrationPlan(current, sheet, options, settings)
    const retained = plan.prepared.styles.find(style => style.id === first.style.id)!
    expect(retained).toEqual(before)
    expect(plan.entries.some(entry => entry.style.id === first.style.id)).toBe(false)
    expect(current.styles.find(style => style.id === first.style.id)).toEqual(before)
  })
  it('신규 컬러를 기존 스타일에 합쳐도 기존 컬러의 식별자와 이력을 보존한다', async () => {
    const { workspace, actor, sheet, options, settings, build } = await fixture()
    const item = build().entries.find(entry => entry.style.code === 'QA26FYTS0003')!
    item.project.expected = null
    item.style.production = item.style.production.slice(0, 1); item.style.colors = item.style.colors.slice(0, 1)
    const current = registerOrderStyleInWorkspace(workspace, actor, item.style, item.project, 'QA 기존 컬러')
    const before = structuredClone(current.styles[0]), result = buildBulkOrderRegistrationPlan(current, sheet, options, settings)
    const entry = result.entries.find(entry => entry.style.id === before.id)!
    expect(entry.style.version).toBe(1); expect(entry.style.production).toHaveLength(2)
    expect(entry.style.production[0]).toEqual(before.production[0]); expect(entry.style.factoryId).toBe(before.factoryId)
    expect(entry.project.expected).toEqual({ code: item.project.code, name: item.project.name, season: item.project.season })
  })
  it('서로 다른 프로젝트를 같은 기본 품번에 섞거나 이름·시즌을 충돌시키면 막는다', async () => {
    const { sheet, build } = await fixture()
    const row = sheet.rows.find(row => row[5] === 'QA26FYTS0003NV')!
    row[0] = 'QA-ANOTHER-PROJECT'
    expect(build().errors.join(' ')).toContain('서로 다른 프로젝트')
    row[0] = sheet.rows[7][0]; row[12] = '다른 명칭'
    expect(build().errors.join(' ')).toContain('명칭·시즌')
  })
  it.each(['total', 'negative', 'duplicate', 'source'])('다른 행이 등록 가능해도 %s 데이터 오류는 전체 저장 전에 남긴다', async kind => {
    const { sheet, build } = await fixture()
    if (kind === 'total') sheet.rows[7][50] = 999
    if (kind === 'negative') sheet.rows[7][44] = '-1'
    if (kind === 'duplicate') sheet.rows.push(structuredClone(sheet.rows[7]))
    if (kind === 'source') sheet.rows[7][18] = '#REF!'
    expect(build().errors.length).toBeGreaterThan(0)
  })
  it('일반 형식에서는 SIG 전용 일괄 등록을 실행하지 않는다', async () => {
    const { workspace, sheet, options, settings } = await fixture()
    const result = buildBulkOrderRegistrationPlan(workspace, sheet, { ...options, preset: 'generic' }, settings)
    expect(result.entries).toHaveLength(0); expect(result.errors.join(' ')).toContain('SIG ORDER QTY')
  })
  it('005 등록을 시작하기 전에 009의 한 번에 스타일 500개 제한을 확인한다', async () => {
    const { sheet, build } = await fixture(), row = sheet.rows[7]
    sheet.rows = [...sheet.rows.slice(0, 7), ...Array.from({ length: 501 }, (_, index) => {
      const value = structuredClone(row); value[5] = `QA26FY${String(index).padStart(6, '0')}BK`; return value
    })]
    expect(build().errors.join(' ')).toMatch(/500개 스타일|스타일 500개/)
  })
})
