import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import { buildSigEuljiRows, fillSigEuljiTemplate, sigEuljiNetAmount, sigEuljiSourceProjectCode, type SigEuljiRow } from '../src/lib/sig-eulji'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { freshOperations } from '../src/lib/operations-domain'
import { ORDER_SOURCE_COLUMNS } from '../src/lib/operations-types'
import { emptyQuantities } from '../src/lib/types'

const templatePath = new URL('../src/assets/sig-eulji-template.xlsx', import.meta.url)
const source = async () => new Uint8Array(await readFile(templatePath))
const row = (overrides: Partial<SigEuljiRow> = {}): SigEuljiRow => ({ projectCode: 'TESTPROJECT-2026FY-MPQ-00001', receivedAtISO: '2026-10-24', factory: '테스트 업체', colorStyleCode: 'TESTFYTS0101BK', unitCost: 123.45, orderQuantity: 30, receivedQuantity: 20, unit: 'EA', netAmount: 2469, owner: '테스트 담당', ...overrides })
async function open(bytes: Uint8Array) { const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes); return workbook }
function fixture() {
  const workspace = createSeed(), profile = workspace.profiles.find(item => item.id === DEMO_IDS.admin)!, style = workspace.styles[0], line = style.production[0]
  style.production = [line]; style.colors = [line.color]; line.received = { ...emptyQuantities(), S: 7, M: 3 }; line.receivedAt = '2026-10-24'
  workspace.settlementTermsAvailable = true
  workspace.settlementTerms = [{ styleId: style.id, lineId: line.id, projectCode: 'TESTPROJECT-2026FY-MPQ-00001', unitCost: 100.25, itemType: 'product', version: 1, createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z', updatedBy: profile.id }]
  workspace.operations = freshOperations()
  return { workspace, profile, style, line }
}

describe('제공된 SIG 을지의 실제 OOXML 양식', () => {
  it('A/C/D/I/N/O/P/Q/R/S/T/W 지정 열과 원본 수식의 결과를 채운다', async () => {
    const output = await fillSigEuljiTemplate(await source(), [row()]), workbook = await open(output), sheet = workbook.getWorksheet('대금지급(을)')!
    expect(workbook.worksheets).toHaveLength(1)
    expect(sheet.getCell('A3').value).toBe(row().projectCode)
    expect(sheet.getCell('C3').value).toEqual(new Date('2026-10-24T00:00:00Z'))
    for (const [column, value] of Object.entries({ D: '테스트 업체', I: 'TESTFYTS0101BK', N: 123.45, O: 1, P: 30, Q: 30, R: 20, S: 'EA', T: 2469, W: '테스트 담당' })) expect(sheet.getCell(`${column}3`).value).toBe(value)
    for (const column of ['B', 'J', 'K', 'L', 'X']) expect(sheet.getCell(`${column}3`).value).toBeNull()
    expect(sheet.getCell('U3').value).toMatchObject({ formula: '거래명세표[[#This Row],[금액]]*0.1', result: 246.9 })
    expect(sheet.getCell('V3').value).toMatchObject({ formula: '거래명세표[[#This Row],[VAT]]+거래명세표[[#This Row],[금액]]', result: 2715.9 })
    expect(sheet.getCell('T1').value).toMatchObject({ formula: 'SUM(T3:T3)', result: 2469 })
  })

  it('여러 데이터 행으로 표·필터·유효성·요약 범위를 확장하고 E공유수식을 독립 수식으로 바꾼다', async () => {
    const bytes = await fillSigEuljiTemplate(await source(), [row(), row({ colorStyleCode: 'TESTFYTS0101OW', unit: 'YDS', unitCost: 12.34, receivedQuantity: 3, netAmount: 37.02 })])
    const zip = await JSZip.loadAsync(bytes), sheetXML = await zip.file('xl/worksheets/sheet1.xml')!.async('string'), tableXML = await zip.file('xl/tables/table1.xml')!.async('string')
    expect(sheetXML).toContain('<dimension ref="A1:X4"')
    expect(tableXML).toContain('ref="A2:X4"'); expect(tableXML.match(/ref="A2:X4"/g)).toHaveLength(2)
    expect(sheetXML).toContain('sqref="J3:J4"')
    expect(sheetXML).not.toContain('t="shared"')
    expect(sheetXML).toContain('<f>MID(A4,1,11)</f>')
    const workbook = await open(bytes), sheet = workbook.worksheets[0]
    expect(sheet.getCell('S4').value).toBe('YDS')
    expect(sheet.getCell('T4').value).toBe(37.02)
    expect(sheet.getCell('U4').value).toMatchObject({ result: 3.702 })
    expect(sheet.getCell('V4').value).toMatchObject({ result: 40.722 })
    expect(sheet.getCell('T1').value).toMatchObject({ formula: 'SUM(T3:T4)', result: 2506.02 })
    expect(sheet.getCell('E4').value).toMatchObject({ formula: 'MID(A4,1,11)', result: 'TESTPROJECT' })
  })

  it('원본 인쇄 바이너리·서식·관계·customXML과 헤더를 바이트 그대로 보존한다', async () => {
    const input = await source(), before = await JSZip.loadAsync(input), after = await JSZip.loadAsync(await fillSigEuljiTemplate(input, [row(), row()]))
    const changed = new Set(['xl/worksheets/sheet1.xml', 'xl/tables/table1.xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', '[Content_Types].xml', 'xl/calcChain.xml'])
    for (const [path, part] of Object.entries(before.files)) {
      if (part.dir || changed.has(path)) continue
      expect(await after.file(path)!.async('uint8array'), path).toEqual(await part.async('uint8array'))
    }
    const first = await before.file('xl/worksheets/sheet1.xml')!.async('string'), second = await after.file('xl/worksheets/sheet1.xml')!.async('string')
    for (const tag of ['cols', 'pageMargins', 'pageSetup', 'tableParts']) expect(second.match(new RegExp(`<${tag}\\b[^>]*(?:/>|>[\\s\\S]*?</${tag}>)`))?.[0]).toBe(first.match(new RegExp(`<${tag}\\b[^>]*(?:/>|>[\\s\\S]*?</${tag}>)`))?.[0])
    expect(second.match(/<row\b[^>]*r="2"[^>]*>[\s\S]*?<\/row>/)?.[0]).toBe(first.match(/<row\b[^>]*r="2"[^>]*>[\s\S]*?<\/row>/)?.[0])
    expect(input).toEqual(await source())
  })

  it('계산 체인과 참조를 제거하고 전체 재계산을 요청한다', async () => {
    const zip = await JSZip.loadAsync(await fillSigEuljiTemplate(await source(), [row()]))
    expect(zip.file('xl/calcChain.xml')).toBeNull()
    expect(await zip.file('xl/_rels/workbook.xml.rels')!.async('string')).not.toContain('/calcChain')
    expect(await zip.file('[Content_Types].xml')!.async('string')).not.toContain('/xl/calcChain.xml')
    expect(await zip.file('xl/workbook.xml')!.async('string')).toContain('fullCalcOnLoad="1" forceFullCalc="1"')
  })

  it('회사 제공 양식의 개인 작성자와 로컬 파일 경로를 포함하지 않는다', async () => {
    const zip = await JSZip.loadAsync(await source())
    const core = await zip.file('docProps/core.xml')!.async('string'), workbook = await zip.file('xl/workbook.xml')!.async('string')
    expect(core).toContain('<dc:creator>FIVE SPACE / SIG</dc:creator>')
    expect(core).toContain('<cp:lastModifiedBy>FIVE SPACE / SIG</cp:lastModifiedBy>')
    expect(workbook).not.toContain('absPath'); expect(workbook).not.toContain('C:\\Users')
  })

  it('문자열을 Excel 수식으로 해석하지 않고 XML 특수문자·한국어·줄바꿈을 보존한다', async () => {
    const supplier = '=HYPERLINK("https://example.test","업체 & <검수>")\n한글'
    const workbook = await open(await fillSigEuljiTemplate(await source(), [row({ factory: supplier })]))
    expect(workbook.worksheets[0].getCell('D3').value).toBe(supplier)
  })

  it.each([
    { unitCost: -1 }, { unitCost: 1.001 }, { unitCost: 1.000000001 }, { netAmount: 3000 }, { unit: 'BOX' as 'EA' },
    { receivedAtISO: '2026-02-30' }, { receivedQuantity: 1.5 }, { orderQuantity: -1 },
    { projectCode: '10000000-0000-4000-8000-000000000001' }, { factory: '업체\u0000' },
  ])('잘못된 내보내기 행을 거부한다: %j', async overrides => {
    await expect(fillSigEuljiTemplate(await source(), [row(overrides)])).rejects.toThrow()
  })

  it('빈 데이터·너무 많은 행·다른 파일을 거부하고 전체 금액 상한을 검사한다', async () => {
    await expect(fillSigEuljiTemplate(await source(), [])).rejects.toThrow()
    await expect(fillSigEuljiTemplate(await source(), Array.from({ length: 10001 }, () => row()))).rejects.toThrow()
    await expect(fillSigEuljiTemplate(new Uint8Array([1, 2]), [row()])).rejects.toThrow()
    await expect(fillSigEuljiTemplate(await source(), [row({ unitCost: 1_000_000_000, receivedQuantity: 600, netAmount: 600_000_000_000 }), row({ unitCost: 1_000_000_000, receivedQuantity: 600, netAmount: 600_000_000_000 })])).rejects.toThrow('전체 결제 금액')
  })
})

describe('프로젝트·스타일·컬러의 실제 입고 기준 을지 데이터', () => {
  it('현재 배정 업체·담당자·입고 수량을 사용하고 수기 정산액을 T로 재사용하지 않는다', () => {
    const { workspace, profile, style, line } = fixture(); line.invoiceAmount = 999999
    const result = buildSigEuljiRows(workspace, [style], profile)
    expect(result.errors).toEqual([])
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ projectCode: workspace.settlementTerms![0].projectCode, receivedQuantity: 10, netAmount: 1002.5, unit: 'EA', factory: workspace.factories.find(item => item.id === style.factoryId)!.name, owner: workspace.profiles.find(item => item.id === style.ownerId)!.name })
  })

  it('컬러 담당자를 우선하고 미지정은 실제 W 빈 셀로 유지하며 전체 품번의 컬러를 중복하지 않는다', async () => {
    const { workspace, profile, style, line } = fixture()
    style.code = 'BP06FYHD0402BL'; line.color = 'BL'; style.colors = ['BL']
    line.ownerId = profile.id
    const assigned = buildSigEuljiRows(workspace, [style], profile)
    expect(assigned.errors).toEqual([])
    expect(assigned.rows[0]).toMatchObject({ owner: profile.name, colorStyleCode: 'BP06FYHD0402BL' })
    line.ownerId = ''
    const unassigned = buildSigEuljiRows(workspace, [style], profile)
    expect(unassigned.errors).toEqual([]); expect(unassigned.rows[0].owner).toBe('')
    const sheet = (await open(await fillSigEuljiTemplate(await source(), unassigned.rows))).worksheets[0]
    expect(sheet.getCell('W3').value).toBeNull()
    expect(sheet.getCell('I3').value).toBe('BP06FYHD0402BL')
    expect(sheet.getCell('T3').value).toBe(1002.5)
  })

  it('컬러 담당자 ID가 잘못되었거나 공장이면 스타일 담당자로 조용히 대체하지 않는다', () => {
    const { workspace, profile, style, line } = fixture()
    for (const id of [crypto.randomUUID(), DEMO_IDS.factory]) {
      line.ownerId = id
      expect(buildSigEuljiRows(workspace, [style], profile)).toMatchObject({ rows: [], errors: [expect.stringContaining('본사 담당자')] })
    }
  })

  it('원단만 YDS, 제품·라벨은 EA이며 원가 0을 미입력으로 취급하지 않는다', () => {
    const { workspace, profile, style } = fixture(), terms = workspace.settlementTerms![0]
    for (const itemType of ['product', 'label', 'fabric'] as const) {
      terms.itemType = itemType; terms.unitCost = 0
      expect(buildSigEuljiRows(workspace, [style], profile)).toMatchObject({ errors: [], rows: [{ unit: itemType === 'fabric' ? 'YDS' : 'EA', unitCost: 0, netAmount: 0 }] })
    }
  })

  it('원본 A의 프로젝트 코드가 모두 일치할 때만 대체하고 등록 UUID나 원본 오류를 내보내지 않는다', () => {
    const { workspace, style, line, profile } = fixture(); workspace.settlementTerms![0].projectCode = ''
    const columns = Object.fromEntries(ORDER_SOURCE_COLUMNS.map(key => [key, key === 'A' ? 'TESTPROJECT-2026FY-MPQ-00002' : null]))
    workspace.operations!.orderSourceRecords = [{ styleId: style.id, lineId: line.id, fileName: 'fixture.csv', sheetName: 'ORDER QTY', headers: Object.fromEntries(ORDER_SOURCE_COLUMNS.map(key => [key, key])), rows: [{ rowNumber: 8, columns }], version: 1, createdAt: '', updatedAt: '', updatedBy: profile.id }]
    expect(sigEuljiSourceProjectCode(workspace, style.id, line.id)).toBe('TESTPROJECT-2026FY-MPQ-00002')
    expect(buildSigEuljiRows(workspace, [style], profile).rows[0].projectCode).toBe('TESTPROJECT-2026FY-MPQ-00002')
    workspace.operations!.orderSourceRecords[0].rows.push({ rowNumber: 9, columns: { ...columns, A: 'OTHER-PROJECT' } })
    expect(sigEuljiSourceProjectCode(workspace, style.id, line.id)).toBe('')
    expect(buildSigEuljiRows(workspace, [style], profile).errors[0]).toContain('프로젝트 코드')
    for (const bad of ['#REF!', '#NAME?', style.projectId]) { workspace.operations!.orderSourceRecords[0].rows = [{ rowNumber: 8, columns: { ...columns, A: bad } }]; expect(sigEuljiSourceProjectCode(workspace, style.id, line.id)).toBe('') }
  })

  it('단가·실입고일·담당자가 없으면 0이나 ID로 채우지 않고 누락을 안내한다', () => {
    const { workspace, profile, style, line } = fixture(); workspace.settlementTerms![0].unitCost = null; line.receivedAt = ''; style.ownerId = 'missing-owner'
    const result = buildSigEuljiRows(workspace, [style], profile)
    expect(result.rows).toEqual([]); expect(result.errors[0]).toContain('장당 원가·실 입고일·본사 담당자')
  })

  it('선택한 컬러를 조용히 건너뛰지 않고 0 입고도 날짜와 단가가 있으면 정확히 0으로 보존한다', () => {
    const { workspace, profile, style, line } = fixture(); line.received = emptyQuantities()
    expect(buildSigEuljiRows(workspace, [style], profile)).toMatchObject({ errors: [], rows: [{ receivedQuantity: 0, netAmount: 0 }] })
    line.receivedAt = ''
    expect(buildSigEuljiRows(workspace, [style], profile)).toMatchObject({ rows: [], errors: [expect.stringContaining('실 입고일')] })
  })

  it('공장·미승인·위조한 역할은 가격 파일을 내보낼 수 없다', () => {
    const { workspace, style, profile } = fixture(), factory = workspace.profiles.find(item => item.role === 'factory')!
    for (const supplied of [factory, { ...factory, role: 'admin' as const }]) expect(buildSigEuljiRows(workspace, [style], supplied).rows).toEqual([])
    profile.approved = false
    expect(buildSigEuljiRows(workspace, [style], profile).rows).toEqual([])
  })

  it('삭제된 스타일·중복 선택·미설정 기능을 명시하고 실제 프로젝트가 다른 스타일을 합치지 않는다', () => {
    const { workspace, style, profile } = fixture()
    expect(buildSigEuljiRows(workspace, [style, style], profile).errors).toContain('내보낼 스타일이 중복되었습니다.')
    style.deletedAt = '2026-10-24T00:00:00Z'
    expect(buildSigEuljiRows(workspace, [style], profile).rows).toEqual([])
    style.deletedAt = null; workspace.settlementTermsAvailable = false
    expect(buildSigEuljiRows(workspace, [style], profile).errors[0]).toContain('004_settlement_terms.sql')
  })

  it('컬러 필터는 선택된 컬러만 내보내고 변경되거나 위조한 컬러를 차단한다', () => {
    const { workspace, style, profile, line } = fixture()
    style.production.push({ ...structuredClone(line), id: crypto.randomUUID(), color: 'OW' })
    style.colors.push('OW')
    const selection = { ...style, production: [line] }
    expect(buildSigEuljiRows(workspace, [selection], profile)).toMatchObject({ errors: [], rows: [{ colorStyleCode: `${style.code}${line.color}` }] })
    expect(buildSigEuljiRows(workspace, [{ ...style, production: [{ ...line, color: 'XX' }] }], profile).errors).toEqual(expect.arrayContaining([expect.stringContaining('선택한 컬러')]))
    expect(buildSigEuljiRows(workspace, [{ ...style, production: [line, line] }], profile).errors).toEqual(expect.arrayContaining([expect.stringContaining('선택한 컬러')]))
  })

  it('입고 기준 금액은 소수 오차 없이 계산하고 한 행 상한을 넘으면 중단한다', () => {
    expect(sigEuljiNetAmount(0.29, 3)).toBe(0.87)
    expect(sigEuljiNetAmount(123.45, 20)).toBe(2469)
    expect(() => sigEuljiNetAmount(1_000_000_000, 1001)).toThrow('1조')
  })
})
