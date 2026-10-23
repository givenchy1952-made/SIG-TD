import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { SIZES } from '../src/lib/types'
import { MAX_SETTLEMENT_TEMPLATE_BYTES, autoMapSettlementColumns, buildSettlementRows, fillSettlementTemplate, inspectSettlementSheet, loadSettlementTemplate, preflightSettlementTemplate, type SettlementTemplateOptions } from '../src/lib/settlement-template'

/** Generated test fixture, never a claim to reproduce the user's missing 을지 form. */
async function fixture(mutate?: (workbook: ExcelJS.Workbook) => void | Promise<void>) {
  const workspace = createSeed(), profile = workspace.profiles.find(p => p.id === DEMO_IDS.admin)!
  const styles = workspace.styles.slice(0, 1)
  styles[0].production[0].invoiceAmount = 120000
  styles[0].production[1].invoiceAmount = 80000
  const rows = buildSettlementRows(workspace, styles, profile)
  const workbook = new ExcelJS.Workbook()
  workbook.creator = '테스트 양식 작성자'
  const sheet = workbook.addWorksheet('테스트 마감', { views: [{ state: 'frozen', ySplit: 3 }] })
  sheet.mergeCells('A1:H1'); sheet.getCell('A1').value = '테스트용 마감 양식 (공식 을지 양식 아님)'
  sheet.getCell('A1').font = { name: '맑은 고딕', size: 17, bold: true }
  sheet.getCell('A2').value = '실제 양식은 사용자 제공 필요'
  sheet.getRow(3).values = ['품번', '제품명', '컬러', '출고 XXS', '실 출고 합계', '금액', '입고일', '검산']
  for (let row = 4; row <= 7; row++) {
    sheet.getRow(row).height = 26
    sheet.getCell(row, 6).numFmt = '#,##0" 원"'
    sheet.getCell(row, 6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FA' } }
    sheet.getCell(row, 6).border = { bottom: { style: 'thin', color: { argb: 'FF8899AA' } } }
    sheet.getCell(row, 8).value = { formula: `SUM(D${row}:E${row})`, result: 0 }
  }
  sheet.getColumn(1).width = 25; sheet.getColumn(6).width = 22
  sheet.mergeCells('A8:E8'); sheet.getCell('A8').value = '합계'
  sheet.getCell('F8').value = { formula: 'SUM(F4:F7)', result: 0 }
  sheet.mergeCells('A9:H9'); sheet.getCell('A9').value = '검토자 / 서명'
  sheet.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1, printArea: 'A1:H9', printTitlesRow: '1:3', margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } }
  sheet.headerFooter.oddFooter = '테스트용 양식 &P / &N'
  workbook.addWorksheet('작성 안내').getCell('A1').value = '다른 시트도 보존'
  await mutate?.(workbook)
  const template = await loadSettlementTemplate(new Uint8Array(await workbook.xlsx.writeBuffer()), '테스트_원본양식.xlsx')
  const options: SettlementTemplateOptions = { sheetName: '테스트 마감', headerRow: 3, startRow: 4, endRow: 7, mapping: autoMapSettlementColumns(inspectSettlementSheet(template, '테스트 마감', 3)), overwriteExisting: false }
  return { workspace, profile, styles, rows, template, options }
}
async function reopen(bytes: Uint8Array) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0])
  return workbook
}

describe('실제 사용자 양식을 위한 설정 가능한 마감 Excel 내보내기', () => {
  it('컬러별 품번과 6사이즈 수량, 합계, 결제 정보는 필터 결과에서만 만든다', async () => {
    const { rows, styles, workspace } = await fixture()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ rowNumber: 1, styleCode: styles[0].code, colorCode: styles[0].code + styles[0].production[0].color, invoiceAmount: 120000, factory: workspace.factories[0].name })
    for (const group of ['order', 'packing', 'shipped', 'received'] as const) {
      for (const size of SIZES) expect(rows[0][`${group}.${size}`]).toBe(styles[0].production[0][group][size])
      expect(rows[0][`${group}.total`]).toBe(SIZES.reduce((sum, size) => sum + styles[0].production[0][group][size], 0))
    }
  })

  it('잘못 전달된 전체 목록도 공장은 자기 스타일만, 미승인·비활성은 0행으로 제한한다', () => {
    const workspace = createSeed(), factory = workspace.profiles.find(p => p.id === DEMO_IDS.factory)!
    const rows = buildSettlementRows(workspace, workspace.styles, factory)
    const own = workspace.styles.filter(style => style.factoryId === factory.factoryId)
    expect(rows).toHaveLength(own.reduce((sum, style) => sum + style.production.length, 0))
    expect(rows.every(row => own.some(style => style.code === row.styleCode))).toBe(true)
    expect(buildSettlementRows(workspace, workspace.styles, { ...factory, approved: false })).toEqual([])
    expect(buildSettlementRows(workspace, workspace.styles, { ...factory, active: false })).toEqual([])
    own.forEach(style => { style.deletedAt = new Date().toISOString() })
    expect(buildSettlementRows(workspace, workspace.styles, factory)).toEqual([])
  })

  it('실제 .xlsx를 읽고 정확한 별칭만 자동 연결하며 머리글 행을 찾는다', async () => {
    const { template, options } = await fixture()
    expect(template.sheets[0]).toMatchObject({ name: '테스트 마감', suggestedHeaderRow: 3 })
    expect(options.mapping).toMatchObject({ 1: 'colorCode', 2: 'styleName', 3: 'color', 4: 'shipped.XXS', 5: 'shipped.total', 6: 'invoiceAmount', 7: 'receivedAt' })
    expect(options.mapping[8]).toBeUndefined()
    expect(autoMapSettlementColumns([{ column: 1, letter: 'A', header: 'XXS' }, { column: 2, letter: 'B', header: '수량' }])).toEqual({})
    expect(inspectSettlementSheet(template, '테스트 마감', NaN)).toEqual([])
  })

  it('머리글·스타일·병합·다른 시트·검산 수식·인쇄 설정을 실제 다운로드 바이트에서 보존한다', async () => {
    const { template, options, rows } = await fixture()
    expect(preflightSettlementTemplate(template, options, rows.length)).toEqual([])
    const output = await fillSettlementTemplate(template, options, rows)
    const workbook = await reopen(output)
    const sheet = workbook.getWorksheet(options.sheetName)!, original = template.workbook.getWorksheet(options.sheetName)!
    expect(sheet.getCell('A1').value).toBe(original.getCell('A1').value)
    expect(sheet.getCell('A1').font).toEqual(original.getCell('A1').font)
    expect(sheet.model.merges).toEqual(original.model.merges)
    expect(sheet.getRow(4).height).toBe(26)
    expect(sheet.getCell('F4').numFmt).toBe(original.getCell('F4').numFmt)
    expect(sheet.getCell('F4').fill).toEqual(original.getCell('F4').fill)
    expect(sheet.getCell('F4').border).toEqual(original.getCell('F4').border)
    expect(sheet.getColumn(6).width).toBe(22)
    expect(sheet.getCell('A4').value).toBe(rows[0].colorCode)
    expect(sheet.getCell('F4').value).toBe(120000)
    expect(sheet.getCell('F5').value).toBe(80000)
    expect(sheet.getCell('F6').value).toBeNull()
    expect(sheet.getCell('H4').formula).toBe('SUM(D4:E4)')
    expect(sheet.getCell('F8').formula).toBe('SUM(F4:F7)')
    expect(sheet.getCell('A9').value).toBe('검토자 / 서명')
    expect(sheet.pageSetup).toEqual(original.pageSetup)
    expect(sheet.headerFooter).toEqual(original.headerFooter)
    expect(sheet.views).toEqual(original.views)
    expect(workbook.getWorksheet('작성 안내')!.getCell('A1').value).toBe('다른 시트도 보존')
    // ExcelJS writes calcPr but does not read it back; inspect the actual XLSX XML.
    const archive = await JSZip.loadAsync(output)
    expect(await archive.file('xl/workbook.xml')!.async('string')).toContain('fullCalcOnLoad="1"')
    expect(original.getCell('F4').value).toBeNull()
  })

  it('연결한 범위의 기존 값은 명시적 교체 선택 전에는 덮어쓰지 않는다', async () => {
    const { template, options, rows } = await fixture(workbook => { workbook.getWorksheet('테스트 마감')!.getCell('F7').value = 999999 })
    expect(preflightSettlementTemplate(template, options, rows.length).join(' ')).toContain('기존 값')
    await expect(fillSettlementTemplate(template, options, rows)).rejects.toThrow('기존 값')
    const workbook = await reopen(await fillSettlementTemplate(template, { ...options, overwriteExisting: true }, rows))
    expect(workbook.getWorksheet('테스트 마감')!.getCell('F7').value).toBeNull()
    expect(template.workbook.getWorksheet('테스트 마감')!.getCell('F7').value).toBe(999999)
  })

  it('양식에 지정된 인쇄 시작 페이지 번호는 그대로 유지한다', async () => {
    const { template, options, rows } = await fixture(workbook => {
      workbook.getWorksheet('테스트 마감')!.pageSetup.firstPageNumber = 7
    })
    const output = await fillSettlementTemplate(template, options, rows)
    const workbook = await reopen(output)
    const sheet = workbook.getWorksheet(options.sheetName)!
    expect(sheet.pageSetup.firstPageNumber).toBe(7)
    expect(sheet.pageSetup).toEqual(template.workbook.getWorksheet(options.sheetName)!.pageSetup)
    const archive = await JSZip.loadAsync(output)
    const xml = await archive.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(xml).toContain('firstPageNumber="7"')
    expect(xml).toContain('useFirstPageNumber="1"')
  })

  it('수식 셀과 footer에 연결하거나 병합 데이터 행을 지정하면 교체 허용 여부와 무관하게 중단한다', async () => {
    const { template, options, rows } = await fixture()
    await expect(fillSettlementTemplate(template, { ...options, mapping: { 8: 'invoiceAmount' }, overwriteExisting: true }, rows)).rejects.toThrow('수식 보존')
    const problems = preflightSettlementTemplate(template, { ...options, endRow: 8, overwriteExisting: true }, rows.length)
    expect(problems.join(' ')).toContain('병합 셀')
    expect(problems.join(' ')).toContain('수식 보존')
    const merged = await fixture(workbook => workbook.getWorksheet('테스트 마감')!.mergeCells('A4:B4'))
    expect(preflightSettlementTemplate(merged.template, merged.options, merged.rows.length).join(' ')).toContain('병합 셀')
  })

  it('배열 수식의 숫자처럼 보이는 하위 셀도 덮어쓰지 않는다', async () => {
    const { template, options, rows } = await fixture(workbook => {
      const sheet = workbook.getWorksheet('테스트 마감')!
      sheet.getCell('F2').value = { formula: 'ROW(F2:F7)', shareType: 'array', ref: 'F2:F7', result: 2 }
      sheet.getCell('F4').value = 4
    })
    await expect(fillSettlementTemplate(template, { ...options, overwriteExisting: true }, rows)).rejects.toThrow('수식 보존')
  })

  it('입력 범위 밖·초과 데이터·빈 데이터·잘못된 열·보호 시트는 모두 거절한다', async () => {
    const { template, options } = await fixture()
    expect(preflightSettlementTemplate(template, options, 5).join(' ')).toContain('초과')
    expect(preflightSettlementTemplate(template, options, 0).join(' ')).toContain('데이터가 없습니다')
    expect(preflightSettlementTemplate(template, { ...options, endRow: options.headerRow }, 2).join(' ')).toContain('범위')
    expect(preflightSettlementTemplate(template, { ...options, endRow: 20000 }, 2).join(' ')).toContain('10,000')
    expect(preflightSettlementTemplate(template, { ...options, mapping: { 0: 'invoiceAmount' } }, 2).join(' ')).toContain('열 연결')
    expect(preflightSettlementTemplate(template, { ...options, mapping: {} }, 2).join(' ')).toContain('하나 이상')
    const protectedTemplate = await fixture(async workbook => { await workbook.getWorksheet('테스트 마감')!.protect('', { selectLockedCells: true }) })
    expect(preflightSettlementTemplate(protectedTemplate.template, protectedTemplate.options, 2).join(' ')).toContain('보호된 시트')
  })

  it.each(['=HYPERLINK("https://example.test","명칭")', '+SUM(1,2)', '-1+2', '@SUM(A1)', '\t=1+1'])('업무 텍스트를 Excel 수식으로 실행하지 않는다: %s', async value => {
    const { template, options, rows } = await fixture()
    rows[0].styleName = value
    const workbook = await reopen(await fillSettlementTemplate(template, options, rows))
    const cell = workbook.getWorksheet(options.sheetName)!.getCell('B4')
    expect(cell.value).toBe(value)
    expect(cell.type).toBe(ExcelJS.ValueType.String)
    expect(cell.formula).toBeUndefined()
  })

  it('같은 양식에서 여러 번 내려받아도 이전 출력이 템플릿에 남지 않는다', async () => {
    const { template, options, rows } = await fixture()
    await fillSettlementTemplate(template, options, rows)
    const workbook = await reopen(await fillSettlementTemplate(template, options, [{ ...rows[0], invoiceAmount: 1 }]))
    expect(workbook.getWorksheet(options.sheetName)!.getCell('F4').value).toBe(1)
    expect(workbook.getWorksheet(options.sheetName)!.getCell('F5').value).toBeNull()
    expect(template.workbook.getWorksheet(options.sheetName)!.getCell('F4').value).toBeNull()
  })

  it('지원되지 않는 형식·손상 파일·10MB 초과 파일을 명확히 거절한다', async () => {
    await expect(loadSettlementTemplate(new Uint8Array([1]), '양식.xls')).rejects.toThrow('.xlsx')
    await expect(loadSettlementTemplate(new Uint8Array([1]), '양식.xlsx')).rejects.toThrow('올바른')
    await expect(loadSettlementTemplate(new Uint8Array([0x50, 0x4b, 1]), '양식.xlsx')).rejects.toThrow('읽을 수 없습니다')
    await expect(loadSettlementTemplate(new Uint8Array(MAX_SETTLEMENT_TEMPLATE_BYTES + 1), '양식.xlsx')).rejects.toThrow('10MB')
  })
})
