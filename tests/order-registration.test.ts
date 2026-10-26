import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { planRegistrationFromRow } from '../src/lib/order-registration'
import { buildOrderImportPreview, sigOrderColumnMapping, type ImportCell, type ImportSheet } from '../src/lib/order-import'
import { quantityTotal } from '../src/lib/types'

function fixture() {
  const workspace = createSeed()
  const headers: ImportCell[] = Array.from({ length: 51 }, () => '')
  Object.assign(headers, { 0: '프로젝트 코드', 5: '스타일코드', 11: '년도/시즌', 12: '프로젝트 명칭', 42: 'XXS', 43: 'XS', 44: 'S', 45: 'M', 46: 'L', 47: 'XL', 50: 'TOTAL QTY' })
  const row: ImportCell[] = Array.from({ length: 51 }, () => null)
  Object.assign(row, { 0: 'QA-PROJECT-2026', 5: 'QAFYTS9001BK', 6: '이 값은 제품명으로 사용하지 않음', 8: 'WH', 11: '2026FY', 12: 'QA 프로젝트 명칭', 18: '2026-01-01', 22: '등록되지 않은 공장', 24: '등록되지 않은 담당자', 42: 1, 43: 2, 44: 3, 45: 4, 46: 5, 47: 6, 50: 21 })
  const sheet: ImportSheet = { name: 'ORDER QTY', rows: [headers, row] }
  const defaults = { factoryId: DEMO_IDS.china, ownerId: DEMO_IDS.internal, dueDate: '2026-11-30' }
  const plan = () => planRegistrationFromRow(workspace, sheet, 1, 2, defaults)
  return { workspace, row, sheet, defaults, plan }
}

describe('F열 전용 미등록 스타일·프로젝트 등록 계획', () => {
  it('F 끝 두 자리만 컬러로 읽고 충돌하는 I열과 제품명 G열은 사용하지 않는다', () => {
    const { row, plan } = fixture()
    row[8] = { error: '#REF!' }
    const result = plan()
    expect(result.errors).toEqual([])
    expect(result.style).toMatchObject({ code: 'QAFYTS9001', name: 'QAFYTS9001', colors: ['BK'], stage: 'registered', version: 0, ppApproved: false })
    expect(result.style!.production[0].color).toBe('BK')
    expect(result.style!.code).not.toContain('BK')
    expect(result.style!.name).not.toContain('제품명')
  })

  it('등록 후 F만으로 다시 매칭하며 AQ~AV 수량과 A·M 원본을 그대로 미리 본다', () => {
    const { workspace, row, sheet, plan } = fixture()
    row[8] = 'I열 컬러는 F와 달라도 사용하지 않음'
    const result = plan()
    workspace.projects.push(result.project!)
    workspace.styles.push({ ...result.style!, version: 1 })
    const preview = buildOrderImportPreview(workspace, sheet, { preset: 'sig-order-qty', mapping: sigOrderColumnMapping(), headerRow: 1, layout: 'wide', duplicateMode: 'reject', missingSizes: 'reject', mode: 'replace', fileName: 'QA.csv' })
    expect(preview.errors).toEqual([])
    expect(preview.rows[0].errors).toEqual([])
    expect(preview.rows[0].sku).toBe('QAFYTS9001BK')
    expect(preview.rows[0].imported).toEqual({ XXS: 1, XS: 2, S: 3, M: 4, L: 5, XL: 6 })
    expect(preview.rows[0].source!.rows[0].columns.A).toBe('QA-PROJECT-2026')
    expect(preview.rows[0].source!.rows[0].columns.M).toBe('QA 프로젝트 명칭')
    expect(preview.rows[0].source!.rows[0].columns).not.toHaveProperty('I')
  })

  it('A는 프로젝트 코드, M은 프로젝트 명칭, L은 시즌으로 각각 분리한다', () => {
    const { plan } = fixture(), result = plan()
    expect(result.project).toMatchObject({ code: 'QA-PROJECT-2026', name: 'QA 프로젝트 명칭', season: '2026FY', expected: null })
    expect(result.isNewProject).toBe(true)
    expect(result.style!.projectId).toBe(result.project!.id)
  })

  it('등록 단계에서 오더·입고·출고 수량과 샘플을 미리 생성하지 않는다', () => {
    const { plan } = fixture(), result = plan(), line = result.style!.production[0]
    for (const group of ['order', 'received', 'shipped', 'packing'] as const) expect(quantityTotal(line[group])).toBe(0)
    expect(result.style!.samples).toEqual([])
    expect(line.receivedAt).toBe('')
    expect(line.shippedAt).toBe('')
    expect(line.invoiceAmount).toBe(0)
  })

  it('기존 프로젝트는 전체 이전 스냅샷을 보관하고 빈 코드만 채울 계획을 만든다', () => {
    const { workspace, plan } = fixture()
    const project = workspace.projects[0]
    project.name = 'QA 프로젝트 명칭'; project.season = '2026FY'
    const result = plan()
    expect(result.isNewProject).toBe(false)
    expect(result.project).toMatchObject({ id: project.id, code: 'QA-PROJECT-2026', expected: { code: '', name: project.name, season: project.season } })
    expect(project.code).toBeUndefined()
  })

  it('같은 코드에 다른 명칭이 있으면 프로젝트를 덮어쓰지 않는다', () => {
    const { workspace, plan } = fixture()
    workspace.projects[0].code = 'QA-PROJECT-2026'
    const before = structuredClone(workspace)
    const result = plan()
    expect(result.errors.join(' ')).toContain('명칭·시즌')
    expect(result.style).toBeNull()
    expect(workspace).toEqual(before)
  })

  it('프로젝트 명칭이 같아도 MPQ·RPQ처럼 코드가 다르면 별도 프로젝트로 구분한다', () => {
    const { workspace, plan } = fixture()
    Object.assign(workspace.projects[0], { code: 'ANOTHER-CODE', name: 'QA 프로젝트 명칭', season: '2026FY' })
    const result = plan()
    expect(result.errors).toEqual([])
    expect(result.isNewProject).toBe(true)
    expect(result.project!.id).not.toBe(workspace.projects[0].id)
    expect(workspace.projects[0].code).toBe('ANOTHER-CODE')
  })

  it('파일 W·Y가 정확히 하나의 등록된 공장·본사 담당자와 일치할 때만 연결한다', () => {
    const { workspace, row, plan } = fixture()
    row[22] = workspace.factories[0].name; row[24] = workspace.profiles[0].name
    const result = plan()
    expect(result.style!.factoryId).toBe(workspace.factories[0].id)
    expect(result.style!.ownerId).toBe(workspace.profiles[0].id)
  })

  it('매칭되지 않는 공장·담당자는 사용자가 선택한 기본값을 사용하며 새 업체를 추측하지 않는다', () => {
    const { workspace, plan, defaults } = fixture()
    const before = structuredClone(workspace), result = plan()
    expect(result.style).toMatchObject({ factoryId: defaults.factoryId, ownerId: defaults.ownerId, dueDate: defaults.dueDate })
    expect(workspace).toEqual(before)
  })

  it('납기가 없으면 S열 요청일을 대신 쓰지 않고 직접 입력하도록 안내한다', () => {
    const { workspace, sheet, defaults } = fixture()
    const result = planRegistrationFromRow(workspace, sheet, 1, 2, { ...defaults, dueDate: '' })
    expect(result.style!.dueDate).toBe('')
    expect(result.errors.join(' ')).toContain('직접 선택')
  })
  it('자동 등록은 납기 미정을 빈 값으로 두고 S열 요청일로 채우지 않는다', () => {
    const { workspace, sheet, defaults, row } = fixture()
    const result = planRegistrationFromRow(workspace, sheet, 1, 2, { ...defaults, dueDate: '', allowMissingDueDate: true })
    expect(result.errors).toEqual([])
    expect(result.style!.dueDate).toBe('')
    expect(result.style!.dueDate).not.toBe(row[18])
  })
  it('자동 등록이어도 명시한 잘못된 기준 납기는 허용하지 않는다', () => {
    const { workspace, sheet, defaults } = fixture()
    const result = planRegistrationFromRow(workspace, sheet, 1, 2, { ...defaults, dueDate: '2026-02-30', allowMissingDueDate: true })
    expect(result.errors.join(' ')).toContain('납기일')
  })

  it('기존 스타일에는 신규 컬러만 추가하고 원본 수량·샘플·담당자·납기는 보존한다', () => {
    const { workspace, row, plan } = fixture()
    const style = workspace.styles[0], before = structuredClone(style)
    row[5] = `${style.code}WH`
    const result = plan()
    expect(result.isNewStyle).toBe(false)
    expect(result.style!.version).toBe(style.version)
    expect(result.style!.production.slice(0, before.production.length)).toEqual(before.production)
    expect(result.style!.samples).toEqual(before.samples)
    expect(result.style!.dueDate).toBe(before.dueDate)
    expect(result.style!.factoryId).toBe(before.factoryId)
    expect(result.style!.ownerId).toBe(before.ownerId)
    expect(result.style!.colors.at(-1)).toBe('WH')
    expect(workspace.styles[0]).toEqual(before)
  })

  it('이미 등록된 컬러도 A·M 프로젝트 연결을 명시적으로 바꾸되 생산 이력은 보존한다', () => {
    const { workspace, row, plan } = fixture()
    const style = workspace.styles[0], before = structuredClone(style)
    row[5] = `${style.code}${style.colors[0]}`
    const result = plan()
    expect(result.errors).toEqual([])
    expect(result.isNewStyle).toBe(false)
    expect(result.isNewColor).toBe(false)
    expect(result.color).toBe(style.colors[0])
    expect(result.style!.projectId).toBe(result.project!.id)
    expect(result.project).toMatchObject({ code: 'QA-PROJECT-2026', name: 'QA 프로젝트 명칭' })
    expect(result.style!.production).toEqual(before.production)
    expect(result.style!.colors).toEqual(before.colors)
    expect(result.style!.samples).toEqual(before.samples)
    expect(result.style!.factoryId).toBe(before.factoryId)
    expect(result.style!.ownerId).toBe(before.ownerId)
    expect(workspace.styles[0]).toEqual(before)
  })

  it('기존 전체 품번이 정확히 일치하면 컬러를 다시 붙이거나 중복 스타일을 생성하지 않는다', () => {
    const { workspace, row, plan } = fixture()
    const style = workspace.styles[0]
    row[5] = `${style.code}BK`; style.code = String(row[5])
    style.production = [style.production[0]]; style.production[0].color = 'BK'; style.colors = ['BK']
    const before = structuredClone(style)
    const result = plan()
    expect(result.errors).toEqual([])
    expect(result.isNewStyle).toBe(false)
    expect(result.isNewColor).toBe(false)
    expect(result.fullSku).toBe(String(row[5]))
    expect(result.style!.code).toBe(String(row[5]))
    expect(result.style!.production).toEqual(before.production)
    expect(style).toEqual(before)
  })

  it.each([0, 11, 12])('필수 프로젝트 열 %i가 없으면 등록하지 않는다', index => {
    const { row, plan } = fixture(); row[index] = ''
    expect(plan().style).toBeNull()
    expect(plan().errors.length).toBeGreaterThan(0)
  })

  it('재계산에 필요한 ID 공급자를 주입해 입력 중 후보 ID를 안정적으로 보존할 수 있다', () => {
    const { workspace, sheet, defaults } = fixture()
    const ids = ['project-stable', 'style-stable']; let n = 0
    const result = planRegistrationFromRow(workspace, sheet, 1, 2, defaults, () => ids[n++])
    expect(result.project!.id).toBe('project-stable')
    expect(result.style!.id).toBe('style-stable')
  })

  it('F가 기본 품번이면 직접 선택한 컬러로 등록하고 끝 숫자와 원본 F를 보존한다', () => {
    const { workspace, row, sheet, defaults } = fixture()
    row[5] = 'QAFYTS9001'; row[8] = 'WH'
    const before = structuredClone(workspace)
    const result = planRegistrationFromRow(workspace, sheet, 1, 2, defaults, undefined, 'BK')
    expect(result.errors).toEqual([])
    expect(result.style).toMatchObject({ code: 'QAFYTS9001', name: 'QAFYTS9001', colors: ['BK'] })
    expect(result.fullSku).toBe('QAFYTS9001BK')
    expect(result.color).toBe('BK')
    expect(row[5]).toBe('QAFYTS9001')
    for (const group of ['order', 'received', 'shipped', 'packing'] as const) expect(quantityTotal(result.style!.production[0][group])).toBe(0)
    expect(workspace).toEqual(before)
  })

  it('미등록 기본 품번의 컬러를 직접 고르지 않으면 I열 값으로 추측하지 않는다', () => {
    const { row, plan } = fixture()
    row[5] = 'QAFYTS9001'; row[8] = 'BK'
    const result = plan()
    expect(result.style).toBeNull()
    expect(result.errors.join(' ')).toContain('컬러')
  })

  it('기본 품번의 등록된 생산 컬러가 하나일 때만 그 컬러로 연결한다', () => {
    const { workspace, row, plan } = fixture(), style = workspace.styles[0]
    style.production = [style.production[0]]; style.colors = [style.production[0].color]
    row[5] = style.code; row[8] = { error: '#REF!' }
    const before = structuredClone(style), result = plan()
    expect(result.errors).toEqual([])
    expect(result.style!.code).toBe(before.code)
    expect(result.style!.production).toEqual(before.production)
    expect(result.color).toBe(before.colors[0])
    expect(result.isNewStyle).toBe(false)
    expect(result.isNewColor).toBe(false)
  })

  it('기본 품번의 컬러가 여러 개면 명시적 선택 없이 하나를 고르지 않는다', () => {
    const { workspace, row, plan } = fixture(), style = workspace.styles[0]
    expect(style.production.length).toBeGreaterThan(1)
    row[5] = style.code; row[8] = style.production[0].color
    const result = plan()
    expect(result.style).toBeNull()
    expect(result.errors.join(' ')).toContain('컬러')
  })

  it('기본 품번의 여러 기존 컬러 중 직접 선택한 컬러를 정확하게 연결한다', () => {
    const { workspace, row, sheet, defaults } = fixture(), style = workspace.styles[0]
    const before = structuredClone(style)
    row[5] = style.code; row[8] = 'ZZ'
    const color = style.production[1].color
    const result = planRegistrationFromRow(workspace, sheet, 1, 2, defaults, undefined, color)
    expect(result.errors).toEqual([])
    expect(result.color).toBe(color)
    expect(result.isNewColor).toBe(false)
    expect(result.style!.production).toEqual(before.production)
    expect(result.style!.factoryId).toBe(before.factoryId)
  })

  it('기본 품번에 신규 컬러를 직접 선택해도 기존 수량과 생산 이력을 바꾸지 않는다', () => {
    const { workspace, row, sheet, defaults } = fixture(), style = workspace.styles[0]
    const before = structuredClone(style)
    row[5] = style.code; row[8] = 'BK'
    const result = planRegistrationFromRow(workspace, sheet, 1, 2, defaults, undefined, 'ZZ')
    expect(result.errors).toEqual([])
    expect(result.isNewStyle).toBe(false)
    expect(result.isNewColor).toBe(true)
    expect(result.style!.production.slice(0, before.production.length)).toEqual(before.production)
    expect(result.style!.production.at(-1)!.color).toBe('ZZ')
    expect(quantityTotal(result.style!.production.at(-1)!.order)).toBe(0)
    expect(style).toEqual(before)
  })

  it('F에 이미 컬러가 붙어 있으면 직접 선택값으로 그 컬러를 바꾸지 않는다', () => {
    const { workspace, sheet, defaults } = fixture()
    const result = planRegistrationFromRow(workspace, sheet, 1, 2, defaults, undefined, 'WH')
    expect(result.errors).toEqual([])
    expect(result.color).toBe('BK')
    expect(result.style!.colors).toEqual(['BK'])
  })

  it.each(['B', 'B1', '1K'])('기본 품번의 수기 컬러 %s가 영문 두 자리가 아니면 등록하지 않는다', color => {
    const { workspace, row, sheet, defaults } = fixture()
    row[5] = 'QAFYTS9001'
    const result = planRegistrationFromRow(workspace, sheet, 1, 2, defaults, undefined, color)
    expect(result.style).toBeNull()
    expect(result.errors.join(' ')).toContain('컬러')
  })

  it.each([12345, true])('F열의 숫자·불리언 값 %s를 기본 품번으로 등록하지 않는다', value => {
    const { workspace, row, sheet, defaults } = fixture()
    row[5] = value
    const result = planRegistrationFromRow(workspace, sheet, 1, 2, defaults, undefined, 'BK')
    expect(result.style).toBeNull()
    expect(result.errors.join(' ')).toContain('F열 품번')
  })

  it('명시한 전체 품번으로 등록하면서 CSV의 기본 품번 F와 I열은 바꾸지 않는다', () => {
    const { workspace, row, sheet, defaults } = fixture()
    row[5] = 'QAFYTS9001'; row[8] = '#REF!'
    const original = structuredClone(sheet)
    const result = planRegistrationFromRow(workspace, sheet, 1, 2, defaults, undefined, undefined, 'QAFYTS9001BK')
    expect(result.errors).toEqual([])
    expect(result.fullSku).toBe('QAFYTS9001BK')
    expect(result.style).toMatchObject({ code: 'QAFYTS9001', colors: ['BK'] })
    expect(sheet).toEqual(original)
    expect(quantityTotal(result.style!.production[0].order)).toBe(0)
  })

  it('명시한 전체 품번이 유효하지 않으면 원본 품번이 있어도 등록하지 않는다', () => {
    const { workspace, sheet, defaults } = fixture()
    const result = planRegistrationFromRow(workspace, sheet, 1, 2, defaults, undefined, undefined, '#REF!')
    expect(result.style).toBeNull()
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('W열의 ㈜·(주) 표기와 공백 차이만 정규화해 유일한 기존 공장에 연결한다', () => {
    const { workspace, row, plan } = fixture()
    workspace.factories[0].name = '티피 나디아 (주)'; row[22] = ' 티피나디아㈜ '
    const result = plan()
    expect(result.errors).toEqual([])
    expect(result.style!.factoryId).toBe(workspace.factories[0].id)
    expect(result.sourceFactory).toBe('티피나디아㈜')
  })

  it('법인 표기 정규화 뒤 여러 공장이 일치하면 그 중 하나를 임의로 고르지 않는다', () => {
    const { workspace, row, plan, defaults } = fixture()
    workspace.factories[0].name = '티피나디아(주)'
    workspace.factories.push({ id: 'duplicate-factory', name: '티피 나디아㈜', country: '베트남' })
    row[22] = '티피나디아㈜'
    const result = plan()
    expect(result.style!.factoryId).toBe(defaults.factoryId)
    expect(result.style!.factoryId).not.toBe('duplicate-factory')
  })

  it('W열의 다른 구두점·빠진 법인 표기를 임의로 제거해 공장을 추측하지 않는다', () => {
    const { workspace, row, plan, defaults } = fixture()
    workspace.factories[0].name = '티피-나디아(주)'; row[22] = '티피나디아㈜'
    expect(plan().style!.factoryId).toBe(defaults.factoryId)
    workspace.factories[0].name = '티피나디아'; row[22] = '티피나디아㈜'
    expect(plan().style!.factoryId).toBe(defaults.factoryId)
  })

  it('AO열 제목이 입고예정일이고 값이 유효한 날짜면 신규 납기를 미리 채워 출처를 표시한다', () => {
    const { workspace, row, sheet, defaults } = fixture()
    sheet.rows[0][40] = ' 입고 예정일 '; row[40] = ' 2026-10-14 '
    row[18] = '2026-01-01'; row[37] = '2026-10-20'
    const original = structuredClone(sheet)
    const result = planRegistrationFromRow(workspace, sheet, 1, 2, { ...defaults, dueDate: '' })
    expect(result.errors).toEqual([])
    expect(result.style!.dueDate).toBe('2026-10-14')
    expect(result.dueDateSource).toBe('AO열 입고예정일')
    expect(result.style!.production[0].receivedAt).toBe('')
    expect(sheet).toEqual(original)
  })

  it.each(['실입고일', '발주 요청일', ''])('AO열 제목이 %s이면 날짜를 납기로 추측하지 않는다', header => {
    const { row, sheet, plan, defaults } = fixture()
    sheet.rows[0][40] = header; row[40] = '2026-10-14'
    const result = plan()
    expect(result.style!.dueDate).toBe(defaults.dueDate)
    expect(result.dueDateSource).toBeUndefined()
  })

  it.each(['2026-02-30', '2026/10/14', '2026-10-14T00:00:00Z', 20261014, { error: '#REF!' }])('AO열의 유효한 ISO 날짜가 아닌 값 %s는 수기 납기 기본값을 유지한다', value => {
    const { row, sheet, plan, defaults } = fixture()
    sheet.rows[0][40] = '입고예정일'; row[40] = value
    const result = plan()
    expect(result.errors).toEqual([])
    expect(result.style!.dueDate).toBe(defaults.dueDate)
    expect(result.dueDateSource).toBeUndefined()
  })

  it('AO 입고예정일은 이미 등록된 스타일의 납기를 바꾸지 않는다', () => {
    const { workspace, row, sheet, plan } = fixture(), style = workspace.styles[0]
    row[5] = `${style.code}${style.production[0].color}`
    sheet.rows[0][40] = '입고예정일'; row[40] = '2027-12-31'
    const before = structuredClone(style), result = plan()
    expect(result.errors).toEqual([])
    expect(result.isNewStyle).toBe(false)
    expect(result.style!.dueDate).toBe(before.dueDate)
    expect(result.dueDateSource).toBeUndefined()
  })
})
