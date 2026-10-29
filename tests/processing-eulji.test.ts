import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { freshOperations } from '../src/lib/operations-domain'
import { blankProductionDetails } from '../src/lib/workflow-refinements'
import { buildSigEuljiRows, fillSigEuljiTemplate, type SigEuljiRow } from '../src/lib/sig-eulji'
import type { OperationRow } from '../src/lib/operations-types'

const source = async () => new Uint8Array(await readFile(new URL('../src/assets/sig-eulji-template.xlsx', import.meta.url)))
const stamp = { version: 1, createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z', updatedBy: DEMO_IDS.admin }
const workRow = (id: string, overrides: Partial<OperationRow> = {}): OperationRow => ({ id, catalogId: id, name: `작업 ${id}`, specification: '23mm / 검정', quantity: 20, lossQuantity: 3, completedQuantity: 7, status: 'done', orderedAt: '2026-10-01', requestedAt: '2026-10-02', completedAt: '2026-10-24', dueDate: '2026-10-23', note: 'QA 작업 기록', ...overrides })
function fixture() {
  const workspace = createSeed(), profile = workspace.profiles.find(item => item.id === DEMO_IDS.admin)!, style = workspace.styles[0]
  workspace.operationsAvailable = true; workspace.refinementsAvailable = true; workspace.settlementTermsAvailable = true
  workspace.processingPricesAvailable = true; workspace.processingUnitPrices = []
  workspace.projects.find(item => item.id === style.projectId)!.code = 'TESTPROJECT-2026FY-MPQ-00001'
  style.production = style.production.slice(0, 2); style.colors = style.production.map(line => line.color)
  style.production.forEach((line, index) => {
    for (const key of ['order', 'shipped', 'received'] as const) for (const size of Object.keys(line[key]) as (keyof typeof line.order)[]) line[key][size] = 0
    line.order.M = index ? 120 : 290; line.shipped.M = index ? 110 : 300; line.received.M = index ? 99 : 277
    line.receivedAt = index ? '2026-10-27' : '2026-10-26'
  })
  workspace.settlementTerms = style.production.map(line => ({ ...stamp, styleId: style.id, lineId: line.id, projectCode: 'TESTPROJECT-2026FY-MPQ-00001', unitCost: 9999, itemType: 'product' as const }))
  workspace.operations = freshOperations()
  workspace.operations.styleOperations = [
    { ...stamp, id: 'labels', styleId: style.id, kind: 'label', rows: [workRow('label-1'), workRow('label-2', { quantity: 10, completedAt: '' })], note: '라벨 업체 전체 메모', voided: false },
    { ...stamp, id: 'embroidery', styleId: style.id, kind: 'embroidery', rows: [workRow('embroidery-1')], note: '', voided: false },
  ]
  workspace.productionDetails = style.production.map((line, index) => ({ ...stamp, ...blankProductionDetails(), styleId: style.id, lineId: line.id, quality: { category: index ? '바지' as const : '아우터' as const, quantity: index ? 15 : 12, status: index ? 'progress' as const : 'done' as const, requestedAt: '2026-10-01', completedAt: index ? '' : '2026-10-24', note: '품질 검사 확인' } }))
  return { workspace, profile, style }
}
function pricedFixture() {
  const f = fixture()
  for (const line of f.style.production) {
    for (const record of f.workspace.operations!.styleOperations) for (const item of record.rows) {
      f.workspace.processingUnitPrices!.push({ ...stamp, styleId: f.style.id, lineId: line.id, kind: record.kind, itemKey: item.id, unitCost: record.kind === 'label' ? 12.34 : 50 })
    }
    f.workspace.processingUnitPrices!.push({ ...stamp, styleId: f.style.id, lineId: line.id, kind: 'quality', itemKey: f.workspace.productionDetails!.find(row => row.lineId === line.id)!.quality.category, unitCost: 100 })
  }
  return f
}
async function workbook(rows: SigEuljiRow[]) {
  const bytes = await fillSigEuljiTemplate(await source(), rows), workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes)
  return { bytes, sheet: workbook.worksheets[0] }
}

describe('가공·품질 을지의 컬러별 실제 수량·저장 단가', () => {
  it('중화라벨은 작업·선택 컬러별 전체 품번과 실제 출고 수량을 사용하고 공통 작업 수량·로스를 비고에 보존한다', () => {
    const { workspace, profile, style } = fixture(), before = structuredClone(workspace)
    const result = buildSigEuljiRows(workspace, [style], profile, 'label')
    expect(result.errors).toEqual([]); expect(result.rows).toHaveLength(4)
    expect(result.rows.map(row => row.colorStyleCode)).toEqual([`${style.code}${style.colors[0]}`, `${style.code}${style.colors[1]}`, `${style.code}${style.colors[0]}`, `${style.code}${style.colors[1]}`])
    expect(result.rows.map(row => row.receivedQuantity)).toEqual([300, 110, 300, 110])
    expect(result.rows[0]).toMatchObject({ kind: 'label', factory: '주식회사 중화라벨', itemName: '작업 label-1', orderQuantity: 290, receivedAtISO: '2026-10-26', unitCost: null, netAmount: null, unit: 'EA' })
    expect(result.rows[1]).toMatchObject({ orderQuantity: 120, receivedAtISO: '2026-10-27' })
    expect(result.rows[0].note).toContain('작업 요청 수량 20개'); expect(result.rows[0].note).toContain('로스 수량 3개')
    expect(result.rows[0].note).not.toContain('직접 입력')
    expect(workspace).toEqual(before)
  })

  it('비와이 자수는 작업 완료 수량 7과 구분하여 메인 실제 입고 277·99와 입고일을 사용한다', () => {
    const { workspace, profile, style } = fixture()
    const result = buildSigEuljiRows(workspace, [style], profile, 'embroidery')
    expect(result.errors).toEqual([]); expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toMatchObject({ factory: 'BY컴퓨터자수', orderQuantity: 290, receivedQuantity: 277, receivedAtISO: '2026-10-26', unitCost: null, netAmount: null })
    expect(result.rows[0].note).toContain('가공 완료 수량 7개')
    expect(result.rows[1]).toMatchObject({ receivedQuantity: 99, receivedAtISO: '2026-10-27' })
    workspace.operations!.styleOperations.find(item => item.kind === 'embroidery')!.rows[0].completedQuantity = 0
    expect(buildSigEuljiRows(workspace, [style], profile, 'embroidery').rows[0].receivedQuantity).toBe(277)
  })

  it('품질검사는 검사 수량·완료 상태와 별도로 선택 컬러의 실제 입고와 입고일을 사용한다', () => {
    const { workspace, profile, style } = fixture()
    const selected = { ...style, production: [style.production[1]] }
    const result = buildSigEuljiRows(workspace, [selected], profile, 'quality')
    expect(result.errors).toEqual([]); expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ factory: '', colorStyleCode: `${style.code}${style.colors[1]}`, orderQuantity: 120, receivedQuantity: 99, receivedAtISO: '2026-10-27', itemName: '품질검사 · 바지' })
    expect(result.rows[0].note).toContain('검사 요청 수량 15개')
    workspace.productionDetails![1].quality.completedAt = ''
    expect(buildSigEuljiRows(workspace, [selected], profile, 'quality').rows[0].receivedQuantity).toBe(99)
  })

  it.each(['label', 'embroidery', 'quality'] as const)('%s는 선택 컬러의 담당자를 사용하고 미지정 담당자는 공란으로 보존한다', kind => {
    const { workspace, profile, style } = fixture()
    style.production[0].ownerId = profile.id; style.production[1].ownerId = ''
    const result = buildSigEuljiRows(workspace, [style], profile, kind)
    expect(result.errors).toEqual([])
    expect(result.rows[0].owner).toBe(profile.name); expect(result.rows[1].owner).toBe('')
  })

  it.each(['label', 'embroidery', 'quality'] as const)('%s는 저장한 해당 작업·컬러 단가를 사용하고 제품 원가를 가져오지 않는다', kind => {
    const { workspace, profile, style } = pricedFixture()
    const result = buildSigEuljiRows(workspace, [style], profile, kind)
    expect(result.errors).toEqual([])
    const price = kind === 'label' ? 12.34 : kind === 'embroidery' ? 50 : 100
    const actual = kind === 'label' ? 300 : 277
    expect(result.rows[0]).toMatchObject({ unitCost: price, receivedQuantity: actual, netAmount: price * actual })
    workspace.processingUnitPrices = []
    expect(buildSigEuljiRows(workspace, [style], profile, kind).rows[0]).toMatchObject({ unitCost: null, netAmount: null })
  })

  it('0원은 미등록과 구분하며 다른 스타일·컬러·작업·종류의 단가를 섞지 않는다', () => {
    const { workspace, profile, style } = pricedFixture()
    workspace.processingUnitPrices = [
      { ...stamp, styleId: style.id, lineId: style.production[0].id, kind: 'label', itemKey: 'label-1', unitCost: 0 },
      { ...stamp, styleId: style.id, lineId: style.production[1].id, kind: 'label', itemKey: 'label-1', unitCost: 9 },
      { ...stamp, styleId: crypto.randomUUID(), lineId: style.production[0].id, kind: 'label', itemKey: 'label-2', unitCost: 999 },
      { ...stamp, styleId: style.id, lineId: style.production[0].id, kind: 'embroidery', itemKey: 'label-2', unitCost: 888 },
    ]
    const rows = buildSigEuljiRows(workspace, [style], profile, 'label').rows
    expect(rows.map(row => row.unitCost)).toEqual([0, 9, null, null])
    expect(rows.map(row => row.netAmount)).toEqual([0, 990, null, null])
  })

  it('반복 다운로드가 저장 단가를 변경하지 않고 명시적으로 바꾼 단가만 다음 출력에 반영한다', () => {
    const { workspace, profile, style } = pricedFixture(), before = structuredClone(workspace)
    const first = buildSigEuljiRows(workspace, [style], profile, 'label')
    expect(buildSigEuljiRows(workspace, [style], profile, 'label')).toEqual(first)
    expect(workspace).toEqual(before)
    workspace.processingUnitPrices![0].unitCost = 25
    const next = buildSigEuljiRows(workspace, [style], profile, 'label')
    expect(next.rows[0]).toMatchObject({ unitCost: 25, netAmount: 7500 })
    expect(next.rows.slice(1)).toEqual(first.rows.slice(1))
  })

  it.each([-1, 1.001, Number.NaN])('잘못된 저장 단가 %s는 화면에서 예외를 던지지 않고 해당 행의 오류로 알린다', unitCost => {
    const { workspace, profile, style } = pricedFixture()
    workspace.processingUnitPrices![0].unitCost = unitCost
    const result = buildSigEuljiRows(workspace, [style], profile, 'label')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('원가')
    expect(result.rows).toHaveLength(3)
    expect(result.rows.every(row => row.unitCost !== unitCost)).toBe(true)
  })

  it('유효한 저장 단가·수량의 곱이 한도를 넘으면 미리보기를 중단하지 않고 해당 행만 오류로 분리한다', () => {
    const { workspace, profile, style } = pricedFixture()
    workspace.processingUnitPrices![0].unitCost = 1_000_000_000
    style.production[0].shipped.M = 2000
    const result = buildSigEuljiRows(workspace, [style], profile, 'label')
    expect(result.errors).toHaveLength(1); expect(result.errors[0]).toContain('1조 원')
    expect(result.rows).toHaveLength(3)
    expect(result.rows.some(row => row.unitCost === 1_000_000_000)).toBe(false)
  })

  it.each(['label', 'embroidery', 'quality'] as const)('%s는 0 수량과 미기재 입고일을 그대로 사용하고 작업 완료일을 대신 넣지 않는다', kind => {
    const { workspace, profile, style } = fixture()
    const line = style.production[0]
    line.shipped.M = 0; line.received.M = 0; line.receivedAt = ''
    expect(buildSigEuljiRows(workspace, [{ ...style, production: [line] }], profile, kind).rows[0]).toMatchObject({ receivedQuantity: 0, receivedAtISO: '' })
  })

  it('컬러 선택 범위를 지키고 다른 컬러의 프로젝트 코드 충돌을 섞지 않는다', () => {
    const { workspace, profile, style } = fixture()
    workspace.settlementTerms![1].projectCode = 'DIFFERENT-PROJECT'
    const result = buildSigEuljiRows(workspace, [style], profile, 'label')
    expect(result.rows[0].projectCode).toBe('TESTPROJECT-2026FY-MPQ-00001')
    expect(result.rows[1].projectCode).toBe('')
    const selected = buildSigEuljiRows(workspace, [{ ...style, production: [style.production[1]] }], profile, 'label')
    expect(selected.rows).toHaveLength(2)
    expect(selected.rows.every(row => row.colorStyleCode.endsWith(style.colors[1]) && row.receivedQuantity === 110)).toBe(true)
  })

  it('중복된 공통 작업·컬러의 수량을 두 번 기록하지 않고 오류로 알린다', () => {
    const { workspace, profile, style } = fixture()
    workspace.operations!.styleOperations[0].rows.push(structuredClone(workspace.operations!.styleOperations[0].rows[0]))
    const result = buildSigEuljiRows(workspace, [style], profile, 'label')
    expect(result.errors).toHaveLength(2); expect(result.rows).toHaveLength(4)
  })

  it('무효·다른 스타일 작업과 미등록 검사 항목을 임의 추가하지 않는다', () => {
    const { workspace, profile, style } = fixture()
    workspace.operations!.styleOperations[0].voided = true
    expect(buildSigEuljiRows(workspace, [style], profile, 'label')).toMatchObject({ rows: [], errors: [expect.stringContaining('등록된 중화라벨 내역이 없습니다')] })
    workspace.productionDetails![0].quality.category = ''
    expect(buildSigEuljiRows(workspace, [{ ...style, production: [style.production[0]] }], profile, 'quality').rows).toEqual([])
    expect(buildSigEuljiRows(workspace, [workspace.styles[1]], profile, 'embroidery').rows).toEqual([])
  })

  it.each(['label', 'embroidery', 'quality'] as const)('공장·위조한 역할·미승인·비활성 계정의 %s 내보내기를 막는다', kind => {
    const { workspace, profile, style } = fixture(), factory = workspace.profiles.find(item => item.role === 'factory')!
    for (const actor of [factory, { ...factory, role: 'admin' as const }]) expect(buildSigEuljiRows(workspace, [style], actor, kind).rows).toEqual([])
    profile.approved = false
    expect(buildSigEuljiRows(workspace, [style], profile, kind).rows).toEqual([])
    profile.approved = true; profile.active = false
    expect(buildSigEuljiRows(workspace, [style], profile, kind).rows).toEqual([])
  })

  it('범위 밖·중복·변경된 컬러와 없는 담당자는 오류로 처리한다', () => {
    const { workspace, profile, style } = fixture()
    expect(buildSigEuljiRows(workspace, [{ ...style, id: crypto.randomUUID() }], profile, 'label').errors).not.toEqual([])
    expect(buildSigEuljiRows(workspace, [{ ...style, production: [style.production[0], style.production[0]] }], profile, 'label').errors).not.toEqual([])
    expect(buildSigEuljiRows(workspace, [{ ...style, production: [{ ...style.production[0], color: 'ZZ' }] }], profile, 'quality').errors).not.toEqual([])
    style.ownerId = crypto.randomUUID()
    expect(buildSigEuljiRows(workspace, [style], profile, 'embroidery').errors[0]).toContain('담당자')
  })

  it('가공 저장 기능만 요구하며 단가 기능이 없으면 빈 단가로 계속 다운로드한다', () => {
    const { workspace, profile, style } = fixture()
    workspace.settlementTermsAvailable = false; workspace.processingPricesAvailable = false
    expect(buildSigEuljiRows(workspace, [style], profile, 'label').errors).toEqual([])
    workspace.operationsAvailable = false
    expect(buildSigEuljiRows(workspace, [style], profile, 'label').rows).toEqual([])
    workspace.refinementsAvailable = false
    expect(buildSigEuljiRows(workspace, [style], profile, 'quality').rows).toEqual([])
  })
})

describe('가공·품질 을지 실제 Excel 출력', () => {
  it.each(['label', 'embroidery', 'quality'] as const)('%s C·I·N·P·Q·R·T를 저장 단가와 컬러별 실제 이동으로 채운다', async kind => {
    const { workspace, profile, style } = pricedFixture()
    const rows = buildSigEuljiRows(workspace, [{ ...style, production: [style.production[0]] }], profile, kind).rows
    const { sheet } = await workbook(rows)
    expect(sheet.getCell('C3').value).toEqual(new Date('2026-10-26T00:00:00Z'))
    expect(sheet.getCell('I3').value).toBe(`${style.code}${style.colors[0]}`)
    expect(sheet.getCell('M3').result).toBe(style.colors[0])
    expect(sheet.getCell('N3').value).toBe(kind === 'label' ? 12.34 : kind === 'embroidery' ? 50 : 100)
    expect(sheet.getCell('P3').value).toBe(290); expect(sheet.getCell('Q3').value).toBe(290)
    expect(sheet.getCell('R3').value).toBe(kind === 'label' ? 300 : 277)
    expect(sheet.getCell('T3').result).toBe(rows[0].netAmount)
    expect(sheet.getCell('U3').result).toBe(rows[0].netAmount! / 10)
    expect(sheet.getCell('V3').result).toBe(kind === 'label' ? 4072.2 : kind === 'embroidery' ? 15235 : 30470)
    expect(sheet.getCell('T3').formula).toBe('IF(OR(N3="",R3=""),"",N3*R3)')
    expect(sheet.getCell('D3').value).toBe(kind === 'label' ? '주식회사 중화라벨' : kind === 'embroidery' ? 'BY컴퓨터자수' : null)
  })

  it('미등록 단가와 날짜는 빈 셀을 유지하며 모든 금액을 채우기 전 합계도 비워 둔다', async () => {
    const { workspace, profile, style } = fixture()
    style.production[0].receivedAt = ''
    const rows = buildSigEuljiRows(workspace, [{ ...style, production: [style.production[0]] }], profile, 'label').rows
    const { bytes, sheet } = await workbook(rows)
    for (const cell of ['N3', 'C3']) expect(sheet.getCell(cell).value).toBeNull()
    expect(sheet.getCell('R3').value).toBe(300)
    expect(sheet.getCell('T1').result ?? '').toBe('')
    expect(sheet.getCell('T1').formula).toContain('COUNT(T3:T4)')
    const zip = await JSZip.loadAsync(bytes), xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(xml).toMatch(/r="T3"[^>]*t="str"/)
  })

  it('미지정 담당자·품질 업체는 빈 셀이며 비고의 수식 모양 텍스트도 실행하지 않는다', async () => {
    const { workspace, profile, style } = fixture()
    style.production[0].ownerId = ''
    workspace.productionDetails![0].quality.note = '=HYPERLINK("https://example.test","검사 <확인>")'
    const rows = buildSigEuljiRows(workspace, [{ ...style, production: [style.production[0]] }], profile, 'quality').rows
    const { sheet } = await workbook(rows)
    expect(sheet.getCell('D3').value).toBeNull(); expect(sheet.getCell('W3').value).toBeNull()
    expect(sheet.getCell('L3').value).toBe('품질검사 · 아우터')
    expect(sheet.getCell('R3').value).toBe(277)
    expect(sheet.getCell('X3').value).toContain('=HYPERLINK'); expect(sheet.getCell('X3').formula).toBeUndefined()
  })

  it('원본 헤더·스타일·인쇄 설정·다른 ZIP 구성은 보존한다', async () => {
    const { workspace, profile, style } = fixture(), before = await JSZip.loadAsync(await source())
    const after = await JSZip.loadAsync((await workbook(buildSigEuljiRows(workspace, [style], profile, 'label').rows)).bytes)
    for (const path of ['xl/styles.xml', 'xl/printerSettings/printerSettings1.bin', 'xl/theme/theme1.xml', 'docProps/core.xml']) {
      if (before.file(path)) expect(await after.file(path)!.async('uint8array')).toEqual(await before.file(path)!.async('uint8array'))
    }
    const input = await before.file('xl/worksheets/sheet1.xml')!.async('string'), output = await after.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(output.match(/<row\b[^>]*r="2"[^>]*>[\s\S]*?<\/row>/)?.[0]).toBe(input.match(/<row\b[^>]*r="2"[^>]*>[\s\S]*?<\/row>/)?.[0])
  })

  it('제품 내보내기의 필수 검증과 가공 단가·업체 검증을 유지한다', async () => {
    const { workspace, profile, style } = fixture(), service = buildSigEuljiRows(workspace, [style], profile, 'quality').rows[0]
    await expect(workbook([{ ...service, factory: '임의 품질 업체' }])).rejects.toThrow('업체명')
    await expect(workbook([{ ...service, kind: undefined, factory: '제품 업체', unitCost: null }])).rejects.toThrow('단가')
    const label = buildSigEuljiRows(workspace, [style], profile, 'label').rows[0]
    await expect(workbook([{ ...label, unitCost: -1 }])).rejects.toThrow('원가')
  })
})
