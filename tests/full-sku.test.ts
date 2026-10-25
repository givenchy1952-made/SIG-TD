import { describe, expect, it } from 'vitest'
import { createSeed } from '../src/lib/seed'
import { emptyQuantities } from '../src/lib/types'
import { buildOrderImportPreview, readSigRowSku, resolveSigOrderIdentity, sigOrderColumnMapping } from '../src/lib/order-import'
import type { ImportCell, OrderImportOptions } from '../src/lib/order-import'

const BASE = 'BP06FYDW0101', SKU = `${BASE}BK`, PROJECT = 'SIGNIFICANT-2026FY-MPQ-46093'
const EXPECTED = { XXS: 60, XS: 384, S: 626, M: 1296, L: 1162, XL: 610 }
function fixture(legacy = false) {
  const workspace = createSeed(), style = workspace.styles[0]
  workspace.styles = [style]
  style.code = legacy ? SKU : BASE
  style.production = [style.production[0]]; style.colors = ['BK']; style.production[0].order = emptyQuantities()
  const row: ImportCell[] = Array(153).fill(''), headers: ImportCell[] = Array(153).fill('')
  row[0] = PROJECT; row[1] = `${PROJECT}${SKU}`; row[5] = BASE; row[8] = { error: 'I열은 사용하지 않음' }
  row[11] = '2026FY'; row[12] = '시그니피컨트 2026 3Q'
  Object.values(EXPECTED).forEach((value, index) => { row[42 + index] = value.toLocaleString('en-US') })
  row[50] = '4,138'
  headers[5] = '스타일코드'; headers[50] = 'TOTAL QTY'
  const sheet = { name: 'ORDER QTY', rows: [headers, row] }
  const options: OrderImportOptions = { preset: 'sig-order-qty', headerRow: 1, mapping: sigOrderColumnMapping(), layout: 'wide', duplicateMode: 'reject', missingSizes: 'reject', mode: 'replace', sigBudgetFallback: true }
  return { workspace, style, row, sheet, options }
}

describe('완성 품번 확인과 예산 코드 보완', () => {
  it('F열에 완성 품번이 있으면 다른 코드보다 우선한다', () => {
    const { row } = fixture(); row[5] = SKU; row[1] = `${PROJECT}${BASE}OW`
    expect(readSigRowSku(row, undefined, true)).toBe(SKU)
  })

  it('B열 보완은 명시적으로 활성화한 경우에만 A+F+두 자리 형식을 읽는다', () => {
    const { row } = fixture()
    expect(readSigRowSku(row)).toBe(BASE)
    expect(readSigRowSku(row, undefined, true)).toBe(SKU)
    row[0] = ` ${PROJECT} `; row[5] = ` ${BASE.toLowerCase()} `; row[1] = ` ${PROJECT}${SKU} `
    expect(readSigRowSku(row, undefined, true)).toBe(SKU)
  })

  it.each(['WRONGPROJECT', `${PROJECT}X`, ''])('프로젝트 접두사 %s가 다르면 B열로 품번을 만들지 않는다', project => {
    const { row } = fixture(); row[0] = project
    expect(readSigRowSku(row, undefined, true)).toBe(BASE)
  })

  it.each([`${PROJECT}${BASE}B`, `${PROJECT}${BASE}BKK`, `${PROJECT}${BASE}01`, `${PROJECT}OTHER0101BK`])('예산 코드 %s를 느슨하게 잘라 맞추지 않는다', budget => {
    const { row } = fixture(); row[1] = budget
    expect(readSigRowSku(row, undefined, true)).toBe(BASE)
  })

  it('직접 입력한 완성 품번을 우선하고 빈 입력도 임의로 채우지 않는다', () => {
    const { row } = fixture()
    expect(readSigRowSku(row, `${BASE}OW`, true)).toBe(`${BASE}OW`)
    expect(readSigRowSku(row, '', true)).toBe('')
  })

  it('읽지 않는 I열과 잘못된 B열 객체를 컬러로 사용하지 않는다', () => {
    const { row } = fixture(); row[1] = { error: '#REF!' }; row[8] = 'BK'
    expect(readSigRowSku(row, undefined, true)).toBe(BASE)
  })
})

describe('완성 품번의 기존 생산 연결', () => {
  it('일반 기본 품번+컬러와 기존 전체 품번 스타일을 모두 연결한다', () => {
    const normal = fixture(), legacy = fixture(true)
    expect(resolveSigOrderIdentity(normal.workspace, SKU)).toEqual({ base: BASE, color: 'BK', fullSku: SKU })
    expect(resolveSigOrderIdentity(legacy.workspace, SKU)).toEqual({ base: SKU, color: 'BK', fullSku: SKU })
  })

  it('전체 품번과 기본 품번 조합이 모두 존재하면 임의로 선택하지 않는다', () => {
    const { workspace, style } = fixture()
    const duplicate = structuredClone(style); duplicate.id = crypto.randomUUID(); duplicate.code = SKU
    workspace.styles.push(duplicate)
    expect(() => resolveSigOrderIdentity(workspace, SKU)).toThrow('여러 스타일')
  })

  it('전체 품번 스타일에 생산 내역이 여러 개면 색상을 추측하지 않는다', () => {
    const { workspace, style } = fixture(true)
    style.production.push({ ...structuredClone(style.production[0]), id: crypto.randomUUID(), color: 'OW' }); style.colors.push('OW')
    expect(() => resolveSigOrderIdentity(workspace, SKU)).toThrow('생산 내역이 여러 개')
  })

  it('미등록 완성 품번은 표시값을 유지하며 기존 내부 등록 구조로 분리한다', () => {
    const { workspace } = fixture(); workspace.styles = []
    expect(resolveSigOrderIdentity(workspace, SKU)).toEqual({ base: BASE, color: 'BK', fullSku: SKU })
  })

  it.each([false, true])('기존 전체 품번 여부 %s에서도 수량 4138과 원본 F를 보존한다', legacy => {
    const { workspace, style, sheet, options } = fixture(legacy), before = structuredClone(workspace)
    const result = buildOrderImportPreview(workspace, sheet, options)
    expect(result.errors).toEqual([]); expect(result.rows[0].errors).toEqual([])
    expect(result.rows[0].sku).toBe(SKU)
    expect(result.rows[0].after).toEqual(EXPECTED)
    expect(result.changes[0].lines[0].lineId).toBe(style.production[0].id)
    expect(result.changes[0].lines[0].source!.rows[0].columns.F).toBe(BASE)
    expect('I' in result.changes[0].lines[0].source!.rows[0].columns).toBe(false)
    expect(workspace).toEqual(before)
  })

  it('행별 완성 품번 수정은 원본 F를 덮어쓰지 않으며 B열 보완이 꺼져도 동작한다', () => {
    const { workspace, sheet, options } = fixture(true)
    const result = buildOrderImportPreview(workspace, sheet, { ...options, sigBudgetFallback: false, sigSkus: { 2: SKU } })
    expect(result.rows[0].errors).toEqual([]); expect(result.rows[0].sku).toBe(SKU)
    expect(result.changes[0].lines[0].quantities).toEqual(EXPECTED)
    expect(result.changes[0].lines[0].source!.rows[0].columns.F).toBe(BASE)
  })
})
