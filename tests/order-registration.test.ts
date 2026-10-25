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

  it('기존 기본 품번에 컬러가 잘못 포함된 경우 중복 스타일을 생성하지 않는다', () => {
    const { workspace, row, plan } = fixture()
    const style = workspace.styles[0]
    row[5] = `${style.code}BK`; style.code = String(row[5])
    const result = plan()
    expect(result.style).toBeNull()
    expect(result.errors.join(' ')).toContain('컬러 BK가 포함')
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
})
