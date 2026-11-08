import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { SIZES, emptyQuantities } from '../src/lib/types'
import { ORDER_SOURCE_COLUMNS, type OrderSourceData } from '../src/lib/operations-types'
import { buildOrderImportPreview, orderImportDefaults, type ImportCell, type ImportSheet, type OrderImportOptions } from '../src/lib/order-import'
import { saveOrderSourceInWorkspace, validateOrderSourceData } from '../src/lib/operations-domain'
import { buildBudgetSources } from '../src/lib/budget-domain'

/** Only the user's column geometry is modeled; no company workbook rows ship. */
function fixture(available = true) {
  const workspace = createSeed(), style = workspace.styles[0], line = style.production[0]
  const project = workspace.projects.find(project => project.id === style.projectId)!
  workspace.styles = [style]; style.production = [line]; style.colors = [line.color]
  project.code = 'QA-2027FY-RPQ-91001'; project.name = 'QA 예산 원본 확인'; project.season = '2027FY'
  workspace.budgetOrderMetadataAvailable = available
  line.order = { ...emptyQuantities(), M: 4138 }
  const headers: ImportCell[] = Array(153).fill(null), row: ImportCell[] = Array(153).fill(null)
  for (const column of ORDER_SOURCE_COLUMNS) headers[index(column)] = `원본 ${column}`
  const labels = { A: '프로젝트 코드', F: '스타일코드', K: ' 브랜드 ', L: ' 년도/시즌 ', M: ' 프로젝트 명칭 ', S: ' 발주 요청일 ', V: '생산구분', AY: 'TOTAL QTY', BH: 'JOOR GB', BZ: 'ADER KOR' }
  for (const [column, label] of Object.entries(labels)) headers[index(column)] = label
  Object.entries({ A: project.code, F: `${style.code}${line.color}`, K: 'QA BRAND', L: project.season, M: project.name, S: '2026-11-08', V: 'RPQ', AY: 4138, BH: '268', BZ: '3,870' }).forEach(([column, value]) => { row[index(column)] = value })
  SIZES.forEach((size, offset) => { headers[index('AQ') + offset] = size; row[index('AQ') + offset] = size === 'M' ? 4138 : 0 })
  const sheet: ImportSheet = { name: 'ORDER QTY', rows: [headers, row] }
  const options: OrderImportOptions = { ...orderImportDefaults({ name: 'qa-order.csv', sheets: [sheet] }), duplicateMode: 'reject', missingSizes: 'reject', mode: 'replace', fileName: 'qa-order.csv' }
  return { workspace, style, line, project, sheet, options, preview: () => buildOrderImportPreview(workspace, sheet, options) }
}
function index(column: string) { return [...column].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1 }
function source(ready = true) { const value = fixture(ready).preview(); expect(value.errors).toEqual([]); expect(value.rows.flatMap(row => row.errors)).toEqual([]); return value.rows[0].source! }

describe('024 예산용 오더 원본 열', () => {
  it('확인된 새 서버에서는 브랜드 K·JOOR GB BH·ADER KOR BZ를 원본 값 그대로 보존한다', () => {
    const data = source()
    expect(Object.keys(data.headers)).toHaveLength(19)
    expect(data.headers).toMatchObject({ K: ' 브랜드 ', BH: 'JOOR GB', BZ: 'ADER KOR' })
    expect(data.rows[0].columns).toMatchObject({ K: 'QA BRAND', BH: '268', BZ: '3,870', S: '2026-11-08' })
    const { expectedVersion: _, ...payload } = data
    expect(() => validateOrderSourceData(payload)).not.toThrow()
  })
  it('이전 서버 및 제목이 다른 파일에는 추가 열을 보내지 않아 기존16열 형식을 보존한다', () => {
    expect(Object.keys(source(false).headers)).toEqual([...ORDER_SOURCE_COLUMNS])
    const value = fixture(); value.sheet.rows[0][index('BH')] = '다른 내부 정보'
    expect(value.preview().rows[0].source?.headers).not.toHaveProperty('BH')
    expect(value.preview().rows[0].source?.headers).toHaveProperty('BZ')
  })
  it('수량이 같아도 예산 배분 원본이 바뀌면 저장 대상이며 기존 스타일 수량은 바꾸지 않는다', () => {
    const value = fixture(), initial = value.preview().rows[0].source!, { expectedVersion: _, ...data } = initial
    const before = structuredClone(value.workspace.styles)
    const saved = saveOrderSourceInWorkspace(value.workspace, value.workspace.profiles.find(profile => profile.id === DEMO_IDS.admin)!, value.style.id, value.line.id, data, 0, '예산 배분 원본 확인')
    expect(saved.styles).toEqual(before)
    expect(buildOrderImportPreview(saved, value.sheet, value.options).rows[0].sourceChanged).toBe(false)
    value.sheet.rows[1][index('BH')] = '269'; value.sheet.rows[1][index('BZ')] = '3,869'
    expect(buildOrderImportPreview(saved, value.sheet, value.options).rows[0].sourceChanged).toBe(true)
    const row = buildBudgetSources(saved).orders[0]
    expect(row).toMatchObject({ brand: 'QA BRAND', orderDate: '2026-11-08', joorQuantity: 268, aderQuantity: 3870, quantity: 4138 })
  })
  it('기본열 누락·예산 열/제목 불일치·임의열·수식 객체를 허용하지 않는다', () => {
    const { expectedVersion: _, ...data } = source()
    for (const mutate of [
      (value: OrderSourceData) => { delete (value.headers as Partial<OrderSourceData['headers']>).A },
      (value: OrderSourceData) => { delete value.rows[0].columns.BH },
      (value: OrderSourceData) => { (value.headers as Record<string, unknown>).ZZ = '임의열'; (value.rows[0].columns as Record<string, unknown>).ZZ = 1 },
      (value: OrderSourceData) => { (value.rows[0].columns as Record<string, unknown>).BZ = { formula: '1+1' } },
    ]) { const value = structuredClone(data); mutate(value); expect(() => validateOrderSourceData(value)).toThrow('원본 정보') }
  })
})
