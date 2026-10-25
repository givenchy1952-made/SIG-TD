import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { freshOperations } from '../src/lib/operations-domain'
import { blankProductionDetails } from '../src/lib/workflow-refinements'
import { buildSigEuljiRows, fillSigEuljiTemplate, type SigEuljiKind, type SigEuljiRow } from '../src/lib/sig-eulji'
import type { OperationRow } from '../src/lib/operations-types'

const source = async () => new Uint8Array(await readFile(new URL('../src/assets/sig-eulji-template.xlsx', import.meta.url)))
const stamp = { version: 1, createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z', updatedBy: DEMO_IDS.admin }
const workRow = (id: string, overrides: Partial<OperationRow> = {}): OperationRow => ({ id, catalogId: id, name: `작업 ${id}`, specification: '23mm / 검정', quantity: 20, lossQuantity: 3, completedQuantity: 7, status: 'done', orderedAt: '2026-10-01', requestedAt: '2026-10-02', completedAt: '2026-10-24', dueDate: '2026-10-23', note: 'QA 작업 기록', ...overrides })
function fixture() {
  const workspace = createSeed(), profile = workspace.profiles.find(item => item.id === DEMO_IDS.admin)!, style = workspace.styles[0]
  workspace.operationsAvailable = true; workspace.refinementsAvailable = true; workspace.settlementTermsAvailable = true
  workspace.projects.find(item => item.id === style.projectId)!.code = 'TESTPROJECT-2026FY-MPQ-00001'
  workspace.settlementTerms = style.production.map(line => ({ ...stamp, styleId: style.id, lineId: line.id, projectCode: 'TESTPROJECT-2026FY-MPQ-00001', unitCost: 9999, itemType: 'product' as const }))
  workspace.operations = freshOperations()
  workspace.operations.styleOperations = [
    { ...stamp, id: 'labels', styleId: style.id, kind: 'label', rows: [workRow('label-1'), workRow('label-2', { quantity: 10, completedAt: '' })], note: '라벨 업체 전체 메모', voided: false },
    { ...stamp, id: 'embroidery', styleId: style.id, kind: 'embroidery', rows: [workRow('embroidery-1')], note: '', voided: false },
  ]
  workspace.productionDetails = style.production.map((line, index) => ({ ...stamp, ...blankProductionDetails(), styleId: style.id, lineId: line.id, quality: { category: index ? '바지' as const : '아우터' as const, quantity: index ? 15 : 12, status: index ? 'progress' as const : 'done' as const, requestedAt: '2026-10-01', completedAt: index ? '' : '2026-10-24', note: '품질 검사 확인' } }))
  return { workspace, profile, style }
}
async function workbook(rows: SigEuljiRow[]) {
  const bytes = await fillSigEuljiTemplate(await source(), rows), workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes)
  return { bytes, sheet: workbook.worksheets[0] }
}

describe('가공·품질 을지 데이터', () => {
  it('중화라벨은 컬러별 중복 없이 작업별 발주 수량을 보존하고 LOSS와 미입력 가격·입고 수량을 구분한다', () => {
    const { workspace, profile, style } = fixture(), before = structuredClone(workspace)
    expect(style.production.length).toBeGreaterThan(1)
    const result = buildSigEuljiRows(workspace, [style], profile, 'label')
    expect(result.errors).toEqual([]); expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toMatchObject({ kind: 'label', factory: '주식회사 중화라벨', colorStyleCode: style.code, itemName: '작업 label-1', orderQuantity: 20, receivedQuantity: null, unitCost: null, netAmount: null, unit: 'EA' })
    expect(result.rows[0].note).toContain('로스 수량 3개')
    expect(result.rows[0].note).toContain('입고 수량 직접 입력')
    expect(result.rows[1].receivedAtISO).toBe('')
    expect(workspace).toEqual(before)
  })

  it('비와이 자수는 작업 요청·실제 완료 수량과 완료일을 사용하고 제품 원가·제품 입고 수량을 사용하지 않는다', () => {
    const { workspace, profile, style } = fixture()
    const result = buildSigEuljiRows(workspace, [style], profile, 'embroidery')
    expect(result.errors).toEqual([]); expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ factory: 'BY컴퓨터자수', orderQuantity: 20, receivedQuantity: 7, receivedAtISO: '2026-10-24', unitCost: null, netAmount: null })
    workspace.operations!.styleOperations.find(item => item.kind === 'embroidery')!.rows[0].completedQuantity = 0
    expect(buildSigEuljiRows(workspace, [style], profile, 'embroidery').rows[0].receivedQuantity).toBe(0)
  })

  it('품질검사는 선택한 컬러만 내보내고 업체는 비워 두며 완료 여부와 날짜가 확인된 수량만 기록한다', () => {
    const { workspace, profile, style } = fixture()
    const result = buildSigEuljiRows(workspace, [{ ...style, production: [style.production[0]] }], profile, 'quality')
    expect(result.errors).toEqual([]); expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ factory: '', colorStyleCode: `${style.code}${style.production[0].color}`, orderQuantity: 12, receivedQuantity: 12, itemName: '품질검사 · 아우터' })
    const all = buildSigEuljiRows(workspace, [style], profile, 'quality')
    expect(all.rows[1]).toMatchObject({ factory: '', receivedQuantity: null, receivedAtISO: '', orderQuantity: 15 })
    workspace.productionDetails![0].quality.completedAt = ''
    expect(buildSigEuljiRows(workspace, [style], profile, 'quality').rows[0].receivedQuantity).toBeNull()
  })

  it('해제·다른 스타일·다른 작업 종류와 미등록 검사 항목을 임의로 추가하지 않는다', () => {
    const { workspace, profile, style } = fixture()
    workspace.operations!.styleOperations[0].voided = true
    expect(buildSigEuljiRows(workspace, [style], profile, 'label')).toMatchObject({ rows: [], errors: [expect.stringContaining('등록된 중화라벨 내역이 없습니다')] })
    workspace.productionDetails![0].quality.category = ''
    expect(buildSigEuljiRows(workspace, [{ ...style, production: [style.production[0]] }], profile, 'quality').rows).toEqual([])
    expect(buildSigEuljiRows(workspace, [workspace.styles[1]], profile, 'embroidery').rows).toEqual([])
  })

  it('프로젝트 코드가 없거나 서로 다르면 임의로 골라 넣지 않고 담당자 입력 칸으로 남긴다', () => {
    const { workspace, profile, style } = fixture()
    workspace.settlementTerms![1].projectCode = 'DIFFERENT-PROJECT'
    const conflict = buildSigEuljiRows(workspace, [style], profile, 'label')
    expect(conflict.errors).toEqual([]); expect(conflict.rows[0].projectCode).toBe('')
    workspace.projects.find(item => item.id === style.projectId)!.code = ''
    workspace.settlementTerms = []
    expect(buildSigEuljiRows(workspace, [style], profile, 'label').rows[0].projectCode).toBe('')
  })

  it.each(['label', 'embroidery', 'quality'] as const)('공장·위조한 역할·미승인·비활성 계정의 %s 을지 내보내기를 막는다', kind => {
    const { workspace, profile, style } = fixture(), factory = workspace.profiles.find(item => item.role === 'factory')!
    for (const actor of [factory, { ...factory, role: 'admin' as const }]) expect(buildSigEuljiRows(workspace, [style], actor, kind).rows).toEqual([])
    profile.approved = false
    expect(buildSigEuljiRows(workspace, [style], profile, kind).rows).toEqual([])
    profile.approved = true; profile.active = false
    expect(buildSigEuljiRows(workspace, [style], profile, kind).rows).toEqual([])
  })

  it('현재 조회 범위 밖 스타일·중복 컬러·변경된 컬러 선택과 없는 담당자를 오류로 처리한다', () => {
    const { workspace, profile, style } = fixture()
    expect(buildSigEuljiRows(workspace, [{ ...style, id: crypto.randomUUID() }], profile, 'label').errors).not.toEqual([])
    expect(buildSigEuljiRows(workspace, [{ ...style, production: [style.production[0], style.production[0]] }], profile, 'label').errors).not.toEqual([])
    expect(buildSigEuljiRows(workspace, [{ ...style, production: [{ ...style.production[0], color: 'ZZ' }] }], profile, 'quality').errors).not.toEqual([])
    style.ownerId = crypto.randomUUID()
    expect(buildSigEuljiRows(workspace, [style], profile, 'embroidery').errors[0]).toContain('담당자')
  })

  it('관련 저장 기능이 없으면 설정 오류를 안내하지만 제품 단가 설정은 가공 다운로드에 요구하지 않는다', () => {
    const { workspace, profile, style } = fixture()
    workspace.settlementTermsAvailable = false
    expect(buildSigEuljiRows(workspace, [style], profile, 'label').errors).toEqual([])
    workspace.operationsAvailable = false
    expect(buildSigEuljiRows(workspace, [style], profile, 'label').rows).toEqual([])
    workspace.refinementsAvailable = false
    expect(buildSigEuljiRows(workspace, [style], profile, 'quality').rows).toEqual([])
  })
})

describe('가공·품질 을지 실제 Excel 출력', () => {
  it('정해진 업체·품명·발주·LOSS를 채우고 미입력 단가와 라벨 입고 수량은 빈 칸으로 보존한다', async () => {
    const { workspace, profile, style } = fixture(), rows = buildSigEuljiRows(workspace, [style], profile, 'label').rows
    const { bytes, sheet } = await workbook(rows)
    expect(sheet.getCell('D3').value).toBe('주식회사 중화라벨')
    expect(sheet.getCell('I3').value).toBe(style.code)
    expect(sheet.getCell('L3').value).toBe('작업 label-1')
    expect(sheet.getCell('P3').value).toBe(20); expect(sheet.getCell('Q3').value).toBe(20)
    expect(sheet.getCell('X3').value).toContain('로스 수량 3개')
    for (const cell of ['N3', 'R3', 'M3', 'C4']) expect(sheet.getCell(cell).value).toBeNull()
    expect(sheet.getCell('T3').formula).toBe('IF(OR(N3="",R3=""),"",N3*R3)')
    expect(sheet.getCell('U3').formula).toBe('IF(T3="","",T3*0.1)')
    expect(sheet.getCell('V3').formula).toBe('IF(T3="","",T3+U3)')
    const zip = await JSZip.loadAsync(bytes), xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(xml).toMatch(/r="T3"[^>]*t="str"/)
    expect(xml).toContain('<v></v>')
    expect(sheet.getCell('T1').formula).toContain('COUNT(T3:T4)')
    expect(sheet.getCell('T1').formula).toContain('ROWS(T3:T4)')
    expect(sheet.getCell('T1').result ?? '').toBe('')
  })

  it('품질검사의 업체 D 칸을 실제 빈 셀로 내려받고 수식이 없는 업무 이름을 입력한다', async () => {
    const { workspace, profile, style } = fixture()
    workspace.productionDetails![0].quality.note = '=HYPERLINK("https://example.test","검사 <확인>")'
    const rows = buildSigEuljiRows(workspace, [{ ...style, production: [style.production[0]] }], profile, 'quality').rows
    const { sheet } = await workbook(rows)
    expect(sheet.getCell('D3').value).toBeNull()
    expect(sheet.getCell('L3').value).toBe('품질검사 · 아우터')
    expect(sheet.getCell('R3').value).toBe(12)
    expect(sheet.getCell('N3').value).toBeNull()
    expect(sheet.getCell('X3').value).toContain('=HYPERLINK')
    expect(sheet.getCell('X3').formula).toBeUndefined()
  })

  it('날짜·단가가 없는 가공 행도 다운로드하며 모든 금액이 입력될 때까지 합계를 빈 칸으로 남긴다', async () => {
    const { workspace, profile, style } = fixture(), rows = buildSigEuljiRows(workspace, [style], profile, 'embroidery').rows
    rows[0].projectCode = ''; rows[0].receivedAtISO = ''
    const { sheet } = await workbook(rows)
    for (const cell of ['A3', 'C3', 'N3']) expect(sheet.getCell(cell).value).toBeNull()
    expect(sheet.getCell('D3').value).toBe('BY컴퓨터자수')
    expect(sheet.getCell('T1').result ?? '').toBe('')
    const priced = { ...rows[0], unitCost: 12.34, receivedQuantity: 3, netAmount: 37.02 }
    const complete = await workbook([priced])
    expect(complete.sheet.getCell('T3').result).toBe(37.02)
    expect(complete.sheet.getCell('U3').result).toBe(3.702)
    expect(complete.sheet.getCell('V3').result).toBe(40.722)
    expect(complete.sheet.getCell('T1').result).toBe(37.02)
  })

  it('원본 헤더·스타일·인쇄 설정·다른 ZIP 구성은 그대로 보존한다', async () => {
    const { workspace, profile, style } = fixture(), before = await JSZip.loadAsync(await source())
    const after = await JSZip.loadAsync((await workbook(buildSigEuljiRows(workspace, [style], profile, 'label').rows)).bytes)
    for (const path of ['xl/styles.xml', 'xl/printerSettings/printerSettings1.bin', 'xl/theme/theme1.xml', 'docProps/core.xml']) {
      if (before.file(path)) expect(await after.file(path)!.async('uint8array')).toEqual(await before.file(path)!.async('uint8array'))
    }
    const input = await before.file('xl/worksheets/sheet1.xml')!.async('string'), output = await after.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(output.match(/<row\b[^>]*r="2"[^>]*>[\s\S]*?<\/row>/)?.[0]).toBe(input.match(/<row\b[^>]*r="2"[^>]*>[\s\S]*?<\/row>/)?.[0])
  })

  it('제품 내보내기의 필수 업체·날짜·단가 검증을 약화하지 않고 서비스 업체도 종류에 맞게 고정한다', async () => {
    const { workspace, profile, style } = fixture(), service = buildSigEuljiRows(workspace, [style], profile, 'quality').rows[0]
    await expect(workbook([{ ...service, factory: '임의 품질 업체' }])).rejects.toThrow('업체명')
    const product = { ...service, kind: undefined, factory: '제품 업체', unitCost: null }
    await expect(workbook([product])).rejects.toThrow('단가')
    const label = buildSigEuljiRows(workspace, [style], profile, 'label').rows[0]
    await expect(workbook([{ ...label, unitCost: -1 }])).rejects.toThrow('원가')
  })
})
