import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { buildBudgetWorkbook, budgetCSV, BUDGET_COST_HEADERS, BUDGET_FA_HEADERS, BUDGET_ORDER_HEADERS, BUDGET_SHEET_NAMES } from '../src/lib/budget-export'
import type { BudgetCostData, BudgetFAEntry, BudgetFARow, BudgetOrderRow, BudgetRecord, BudgetReport, BudgetSummary } from '../src/lib/budget-types'
import { parseOrderCSV } from '../src/lib/order-import'

const now = '2026-11-08T01:00:00Z'
const summary = (values: Partial<BudgetSummary> = {}): BudgetSummary => ({ budget: 0, paid: 0, unpaid: 0, confirmed: 0, remaining: 0, overage: 0, paidVat: 0, paidGross: 0, missingCostCount: 0, orderQuantity: 0, receivedQuantity: 0, annualLimit: null, unallocated: null, progress: null, ...values })
function fixture(): BudgetReport {
  const identity = { projectId: 'project-a', projectCode: 'SIG-2027 RPQ-A', projectName: '시그니피컨트 2027 1M', budgetCode: 'SIG-2027RPQ-AQA001BK', styleId: 'style-a', lineId: 'line-a', styleCode: 'QA 001BK', color: 'BK', season: '2027FY', factoryId: 'factory-a', factoryName: '=테스트 공급업체' }
  const order: BudgetOrderRow = { ...identity, sourceKey: 'production:run-a', brand: 'SIG', productionType: 'RPQ', orderCode: 'ORDER-A', orderDate: '2026-11-07', quantity: 2, receivedQuantity: 2, joorQuantity: 1, aderQuantity: 1, productionBudget: 1234.56, costMatched: identity.budgetCode, productionUnitCost: 617.28, postCost: 1300 }
  const unknown: BudgetOrderRow = { ...order, projectId: 'project-b', projectCode: 'SIG-2027-RPQ-B', projectName: '미등록 원가 프로젝트', budgetCode: 'SIG-2027-RPQ-BQA002WH', styleId: 'style-b', lineId: 'line-b', styleCode: 'QA002WH', factoryId: 'factory-b', factoryName: '테스트 B', color: 'WH', sourceKey: 'legacy:style-b:line-b', quantity: 10, receivedQuantity: 0, joorQuantity: null, aderQuantity: null, productionBudget: null, productionUnitCost: null, postCost: null, costMatched: '미등록' }
  const cost: BudgetCostData = { projectId: identity.projectId, budgetCode: identity.budgetCode, styleCode: identity.styleCode, supplierId: identity.factoryId, supplierName: identity.factoryName, stage: 'pre', category: '제품', description: '원가 예시 직접 기입', position: '', specification: 'QA', itemName: '테스트 제품', composition: '', color: 'BK', unitCost: 1.23, variableUnitCost: null, consumption: 1.5, unit: 'EA', amount: 1234.56, voided: false }
  const record = (id: string, data: BudgetCostData): Extract<BudgetRecord, { kind: 'cost' }> => ({ id, kind: 'cost', data, version: 1, createdAt: now, updatedAt: now, updatedBy: 'admin' })
  const entry: BudgetFAEntry = { ...identity, sourceKey: 'production:run-a', sourceVersion: 3, sourceFingerprint: 'production:run-a@3', orderDate: '2026-11-07', receivedAt: '2026-11-08', unitCost: 650.12, consumption: null, orderQuantity: 2, receivedQuantity: 2, unit: 'EA', netAmount: 1300.24, vatAmount: 130.024, grossAmount: 1430.264, owner: 'QA 본사', item: '제품', evidence: '생산 차수 최종 확정' }
  const fa: BudgetFARow = { ...entry, payment: { sourceKey: entry.sourceKey, sourceFingerprint: entry.sourceFingerprint, sourceSnapshot: entry, status: 'paid', paidAt: '2026-11-08', voucherNo: 'VOUCHER-1', account: '제품매입', description: '+계산식이 아닌 메모', splitPayment: '일시 지급' }, paymentRecord: null, paymentStale: false }
  const unpaid: BudgetFARow = { ...fa, sourceKey: 'processing:line-a:work-a', sourceFingerprint: 'processing:line-a:work-a@1', item: '라벨', unitCost: 0, netAmount: 0, vatAmount: 0, grossAmount: 0, payment: { ...fa.payment, sourceKey: 'processing:line-a:work-a', sourceFingerprint: 'processing:line-a:work-a@1', status: 'unpaid', paidAt: '', voucherNo: '', splitPayment: '' } }
  const excess = { key: 'excess-a', kind: 'excess' as const, projectName: identity.projectName, projectCode: identity.projectCode, styleCode: identity.styleCode, season: identity.season, factoryName: identity.factoryName, budget: 1234.56, paid: 1300.24, unpaid: 0, overage: 65.68, explanation: '지출이 등록 예산을 초과했습니다.', reason: '원가 상승', noteRecord: null }
  const unclosed = { ...excess, key: 'unclosed-b', kind: 'unclosed' as const, projectName: unknown.projectName, projectCode: unknown.projectCode, styleCode: unknown.styleCode, factoryName: unknown.factoryName, budget: null, paid: 0, overage: 0, explanation: '원가 미등록 · 입고 대기', reason: '차주 입고 예정' }
  return { authorized: true, readOnly: false, orders: [order, unknown], settlements: [fa, unpaid], costs: [record('pre-a', cost), record('post-a', { ...cost, stage: 'post', amount: 1300 })], limits: [], groups: [], totals: summary({ budget: 1234.56, paid: 1300.24, confirmed: 1300.24, paidVat: 130.024, paidGross: 1430.264, remaining: 0, overage: 65.68, missingCostCount: 1, orderQuantity: 12, receivedQuantity: 2, annualLimit: 5000, unallocated: 3765.44, progress: 1300.24 / 1234.56 }), excess: [excess], unclosed: [unclosed], warnings: ['원가 미등록 1건은 0원과 다릅니다.'], sources: { orders: [order, unknown], settlements: [entry], warnings: [] } }
}
async function reopen(bytes: Uint8Array) { const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0]); return workbook }

async function formulas(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  return Promise.all(Object.keys(zip.files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).map(async name => ({ name, xml: await zip.file(name)!.async('string') })))
}

describe('신규 예산·FA 누적 Excel/CSV', () => {
  it('발주·요약 금액은 원 단위 서식으로 표시하면서 소수 원본과 상세 원가·FA 근거는 유지한다', async () => {
    const report = fixture()
    report.orders[0].quantity = 10; report.orders[0].productionBudget = 253210.75714; report.orders[0].productionUnitCost = 25321.075714
    report.totals.budget = 253210.75714
    const workbook = await reopen(await buildBudgetWorkbook(report))
    const order = workbook.getWorksheet(BUDGET_SHEET_NAMES.orders)!, dashboard = workbook.getWorksheet(BUDGET_SHEET_NAMES.dashboard)!
    const cost = workbook.getWorksheet(BUDGET_SHEET_NAMES.costs)!, fa = workbook.getWorksheet(BUDGET_SHEET_NAMES.fa)!
    const excess = workbook.getWorksheet(BUDGET_SHEET_NAMES.excess)!, unclosed = workbook.getWorksheet(BUDGET_SHEET_NAMES.unclosed)!
    const wonFormat = '#,##0;[Red]-#,##0'
    for (const cell of [order.getCell('M2'), order.getCell('O2'), dashboard.getCell('A2'), dashboard.getCell('B4'), dashboard.getCell('E8'), dashboard.getCell('R8'), excess.getCell('G3'), excess.getCell('L3'), excess.getCell('L1'), unclosed.getCell('F2')]) expect(cell.numFmt).toBe(wonFormat)
    expect(order.getCell('M2').result).toBe(253210.75714)
    expect(order.getCell('O2').value).toBe(25321.075714)
    expect(dashboard.getCell('A2').result).toBe(253210.75714)
    expect(cost.getCell('Q2').value).toBe(1.23); expect(cost.getCell('Q2').numFmt).toBe('#,##0.00;[Red]-#,##0.00')
    expect(cost.getCell('S2').value).toBe(1.5); expect(cost.getCell('S2').numFmt).toBe('#,##0.####')
    expect(cost.getCell('U2').value).toBe(1234.56); expect(cost.getCell('U2').numFmt).toBe('#,##0.00####;[Red]-#,##0.00####')
    expect(fa.getCell('O4').result).toBe(1300.24); expect(fa.getCell('O4').numFmt).toBe('#,##0.00;[Red]-#,##0.00')
    const rows = parseOrderCSV(budgetCSV(report, 'orders'))
    expect(rows[1][12]).toBe('253210.75714'); expect(rows[1][14]).toBe('25321.075714')
  })

  it('사후원가 확인을 제거하고 M=장당 O×수량 J와 O 주소를 Excel·CSV에서 유지한다', async () => {
    const report = fixture(), workbook = await reopen(await buildBudgetWorkbook(report))
    const sheet = workbook.getWorksheet(BUDGET_SHEET_NAMES.orders)!
    expect(sheet.getCell('M1').value).toBe('생산 예산')
    expect(sheet.getCell('N1').value).toBe('')
    expect(sheet.getColumn(14).hidden).toBe(true)
    expect(sheet.getCell('N2').value).toBeNull()
    expect(sheet.getCell('O1').value).toBe('생산 원가')
    expect(sheet.getCell('O2').value).toBe(617.28)
    expect(sheet.getCell('O2').formula).toBeUndefined()
    expect(sheet.getCell('M2').value).toEqual({ formula: 'IF(O2="","",O2*J2)', result: 1234.56 })
    const csv = budgetCSV(report, 'orders'), rows = parseOrderCSV(csv)
    expect(csv).not.toContain('사후원가 확인')
    expect(rows[0]).toHaveLength(15)
    expect(rows[0][13]).toBe(''); expect(rows[1][13]).toBe('')
    expect(rows[1][12]).toBe('1234.56'); expect(rows[1][14]).toBe('617.28')
    expect(rows[2][12]).toBe(''); expect(rows[2][14]).toBe('')
    report.orders[0].quantity = 0; report.orders[0].productionUnitCost = 0; report.orders[0].productionBudget = 0
    const zero = (await reopen(await buildBudgetWorkbook(report))).getWorksheet(BUDGET_SHEET_NAMES.orders)!
    expect(zero.getCell('O2').value).toBe(0)
    expect(zero.getCell('M2').formula).toBe('IF(O2="","",O2*J2)')
    expect(zero.getCell('M2').result).toBe(0)
  })

  it('업로드한 원가에만 Q×S 수식을 넣고 수동 금액과 소수 6자리를 보존한다', async () => {
    const report = fixture()
    report.budgetCostImportRecordIds = ['pre-a']
    report.costs[0].data.unitCost = 333.33
    report.costs[0].data.consumption = 0.0003
    report.costs[0].data.amount = 0.099999
    const workbook = await reopen(await buildBudgetWorkbook(report)), cost = workbook.getWorksheet(BUDGET_SHEET_NAMES.costs)!
    expect(cost.getCell('I2').value).toBe(report.costs[0].data.category)
    expect(parseOrderCSV(budgetCSV(report, 'costs'))[1][8]).toBe(report.costs[0].data.category)
    expect(cost.getCell('U2').value).toEqual({ formula: 'Q2*S2', result: 0.099999 })
    expect(cost.getCell('U2').numFmt).toContain('00####')
    expect(cost.getCell('U3').value).toBe(1300)
    expect(cost.getCell('U3').formula).toBeUndefined()
    expect(parseOrderCSV(budgetCSV(report, 'costs'))[1][20]).toBe('0.099999')
    report.costs[0].data.unitCost = null; report.costs[0].data.amount = null
    expect((await reopen(await buildBudgetWorkbook(report))).getWorksheet(BUDGET_SHEET_NAMES.costs)!.getCell('U2').value).toBeNull()
    report.costs[0].data.unitCost = 0; report.costs[0].data.amount = 0
    const zeroBytes = await buildBudgetWorkbook(report), zeroCell = (await reopen(zeroBytes)).getWorksheet(BUDGET_SHEET_NAMES.costs)!.getCell('U2')
    expect(zeroCell.formula).toBe('Q2*S2'); expect(zeroCell.result).toBe(0)
    const zeroZip = await JSZip.loadAsync(zeroBytes)
    expect(await zeroZip.file('xl/worksheets/sheet2.xml')!.async('string')).toMatch(/<c r="U2"[^>]*><f>Q2\*S2<\/f><v>0<\/v><\/c>/)
    report.costs[0].data.amount = 5
    await expect(buildBudgetWorkbook(report)).rejects.toThrow('단가·요척량·금액 연결')
  })

  it('6개 시트를 생성하고 제공된 발주·원가·FA 헤더와 고정 행·열을 지킨다', async () => {
    const bytes = await buildBudgetWorkbook(fixture()), workbook = await reopen(bytes)
    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(Object.values(BUDGET_SHEET_NAMES))
    expect(workbook.getWorksheet(BUDGET_SHEET_NAMES.orders)!.getRow(1).values).toEqual([undefined, ...BUDGET_ORDER_HEADERS])
    expect(workbook.getWorksheet(BUDGET_SHEET_NAMES.costs)!.getRow(1).values).toEqual([undefined, ...BUDGET_COST_HEADERS])
    const fa = workbook.getWorksheet(BUDGET_SHEET_NAMES.fa)!
    expect(fa.getRow(3).values).toEqual([undefined, ...BUDGET_FA_HEADERS])
    expect(fa.getCell('A4').value).toBe('2026-11-08')
    expect(fa.getCell('B4').value).toBe('VOUCHER-1')
    expect(fa.getCell('C4').value).toBe('=테스트 공급업체')
    expect(fa.getCell('G4').value).toBe('QA 001BK')
    expect(fa.getCell('M4').value).toBe(2)
    expect(fa.getCell('U4').value).toBe('결제')
    expect(fa.getCell('U5').value).toBe('미결제')
    expect(fa.getCell('U4').dataValidation).toMatchObject({ type: 'list', formulae: ['"결제,미결제"'] })
    expect(fa.getCell('U6').dataValidation.formulae).toEqual(['"결제,미결제"'])
    expect(fa.views[0]).toMatchObject({ state: 'frozen', ySplit: 3 })
  })

  it('A+D 예산 키·생산 장당 원가·FA 금액/VAT/합계를 유효한 수식과 정확한 캐시로 만든다', async () => {
    const report = fixture(), bytes = await buildBudgetWorkbook(report), workbook = await reopen(bytes)
    const order = workbook.getWorksheet(BUDGET_SHEET_NAMES.orders)!, cost = workbook.getWorksheet(BUDGET_SHEET_NAMES.costs)!, fa = workbook.getWorksheet(BUDGET_SHEET_NAMES.fa)!
    expect(order.getCell('B2').result).toBe('SIG-2027RPQ-AQA001BK')
    expect(order.getCell('B2').formula).toContain('A2&D2')
    expect(order.getCell('O2').value).toBe(617.28)
    expect(order.getCell('M2').value).toEqual({ formula: 'IF(O2="","",O2*J2)', result: 1234.56 })
    expect(cost.getCell('B2').result).toBe('SIG-2027RPQ-AQA001BK')
    expect(cost.getCell('I2').value).toBe('사전 · 제품')
    expect(cost.getCell('I3').value).toBe('사후 · 제품')
    expect(cost.getCell('Q2').value).toBe(1.23)
    expect(cost.getCell('S2').value).toBe(1.5)
    expect(cost.getCell('U2').value).toBe(1234.56) // Deliberately not unit price × consumption.
    expect(cost.getCell('U2').formula).toBeUndefined()
    expect(fa.getCell('O4').value).toEqual({ formula: 'M4*J4', result: 1300.24 })
    expect(fa.getCell('P4').value).toEqual({ formula: 'O4*0.1', result: 130.024 })
    expect(fa.getCell('Q4').value).toEqual({ formula: 'O4+P4', result: 1430.264 })
    expect(fa.getCell('Q2').value).toEqual({ formula: 'SUM(Q4:Q5)', result: 1430.264 })
    expect(fa.getCell('U2').value).toEqual({ formula: 'COUNTIF(U4:U5,"결제")', result: 1 })
    for (const { xml } of await formulas(bytes)) expect(xml).not.toMatch(/#REF!|#DIV\/0!|GETPIVOTDATA|<c[^>]*t="e"/)
  })

  it('원가·한도 미등록은 빈칸이고 명시적인 0원은 숫자 0으로 보존한다', async () => {
    const report = fixture(); report.totals.annualLimit = null; report.totals.unallocated = null
    report.costs[0].data.unitCost = 0; report.costs[0].data.amount = 0
    const workbook = await reopen(await buildBudgetWorkbook(report)), order = workbook.getWorksheet(BUDGET_SHEET_NAMES.orders)!, cost = workbook.getWorksheet(BUDGET_SHEET_NAMES.costs)!, fa = workbook.getWorksheet(BUDGET_SHEET_NAMES.fa)!, dashboard = workbook.getWorksheet(BUDGET_SHEET_NAMES.dashboard)!
    expect(order.getCell('M3').result ?? '').toBe('')
    expect(order.getCell('K3').value).toBeNull()
    expect(order.getCell('O3').value).toBeNull()
    expect(cost.getCell('U2').value).toBe(0)
    expect(cost.getCell('R2').value).toBeNull()
    expect(fa.getCell('O5').result).toBe(0)
    expect(dashboard.getCell('A4').value).toBeNull()
    expect(dashboard.getCell('B4').value).toBeNull()
    expect(dashboard.getCell('A5').value).toContain('원가 미등록 1건은 0원이 아닙니다')
  })

  it('화면 요약과 내보낸 지급·미지급·예산 진행률이 같고 초과/미종결 사유를 남긴다', async () => {
    const report = fixture(), workbook = await reopen(await buildBudgetWorkbook(report)), dashboard = workbook.getWorksheet(BUDGET_SHEET_NAMES.dashboard)!
    expect(dashboard.getCell('A2').result).toBe(report.totals.budget)
    expect(dashboard.getCell('B2').result).toBe(report.totals.paid)
    expect(dashboard.getCell('C2').result).toBe(report.totals.remaining)
    expect(dashboard.getCell('D2').result).toBe(report.totals.progress)
    expect(dashboard.getCell('F2').result).toBe(report.totals.paidVat)
    expect(dashboard.getCell('G2').result).toBe(report.totals.paidGross)
    expect(dashboard.getCell('A4').value).toBe(5000)
    expect(dashboard.getCell('B4').value).toBe(3765.44)
    expect(workbook.getWorksheet(BUDGET_SHEET_NAMES.excess)!.getCell('M3').value).toBe('원가 상승')
    expect(workbook.getWorksheet(BUDGET_SHEET_NAMES.unclosed)!.getCell('J2').value).toBe('차주 입고 예정')
    const rows = parseOrderCSV(budgetCSV(report, 'dashboard'))
    expect(rows).toContainEqual(['발주 예산합계 (등록분)', '1234.56', '공급가액 KRW'])
    expect(rows).toContainEqual(['지출합계', '1300.24', '결제로 확인된 공급가액'])
  })

  it('필터에서 제외된 원본 소스·회사 피벗 캐시를 복사하지 않고 문자열 수식을 실행하지 않는다', async () => {
    const report = fixture(), hidden = { ...report.orders[0], projectId: 'hidden', projectCode: 'SHOULD-NEVER-EXPORT', projectName: '비선택 원본 데이터' }
    report.sources.orders.push(hidden)
    report.orders = report.orders.slice(0, 1); report.excess = []; report.unclosed = []
    const bytes = await buildBudgetWorkbook(report), zip = await JSZip.loadAsync(bytes), workbook = await reopen(bytes)
    expect(Object.keys(zip.files).some(name => /pivot|externalLinks/i.test(name))).toBe(false)
    expect(workbook.getWorksheet(BUDGET_SHEET_NAMES.fa)!.getCell('C4').type).toBe(ExcelJS.ValueType.String)
    expect(workbook.getWorksheet(BUDGET_SHEET_NAMES.fa)!.getCell('C4').formula).toBeUndefined()
    const strings = await zip.file('xl/sharedStrings.xml')!.async('string')
    expect(strings).not.toContain('SHOULD-NEVER-EXPORT')
    expect(strings).not.toContain('비선택 원본 데이터')
    const csv = budgetCSV(report, 'fa')
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain("'=테스트 공급업체")
    expect(csv).not.toContain('SHOULD-NEVER-EXPORT')
    expect(parseOrderCSV(csv)[1][20]).toBe('결제')
  })

  it('결제 뒤 원본 변경이 있어도 결제 당시 금액과 상태를 보존하며 확인 문구를 남긴다', async () => {
    const report = fixture(); report.settlements[0].paymentStale = true
    const rows = parseOrderCSV(budgetCSV(report, 'fa'))
    expect(rows[1][0]).toBe('2026-11-08')
    expect(rows[1][20]).toBe('결제')
    expect(rows[1][18]).toContain('원본 변경 확인 필요 · 결제 당시 금액 보존')
    const workbook = await reopen(await buildBudgetWorkbook(report)), fa = workbook.getWorksheet(BUDGET_SHEET_NAMES.fa)!
    expect(fa.getCell('U4').value).toBe('결제')
    expect(fa.getCell('U2').result).toBe(1)
    expect(fa.getCell('O4').result).toBe(1300.24)
  })

  it('빈 필터 결과와 FA 읽기 전용 결과도 오류·이전 자료 없이 내보낸다', async () => {
    const report = fixture(); report.readOnly = true
    report.orders = []; report.costs = []; report.settlements = []; report.groups = []; report.excess = []; report.unclosed = []; report.warnings = []; report.totals = summary()
    const bytes = await buildBudgetWorkbook(report), workbook = await reopen(bytes), zip = await JSZip.loadAsync(bytes)
    expect(workbook.worksheets).toHaveLength(6)
    expect(workbook.getWorksheet(BUDGET_SHEET_NAMES.orders)!.getCell('A2').value).toBeNull()
    expect(workbook.getWorksheet(BUDGET_SHEET_NAMES.fa)!.getCell('A4').value).toBeNull()
    expect(workbook.getWorksheet(BUDGET_SHEET_NAMES.fa)!.getCell('U2').result ?? 0).toBe(0)
    const strings = await zip.file('xl/sharedStrings.xml')!.async('string')
    expect(strings).not.toContain('시그니피컨트 2027 1M')
    expect(strings).not.toContain('테스트 공급업체')
    expect(parseOrderCSV(budgetCSV(report, 'fa'))).toEqual([BUDGET_FA_HEADERS])
  })

  it('동일한 프로젝트 코드·품번을 가진 서로 다른 ID의 발주 메타데이터를 섞지 않는다', async () => {
    const report = fixture(), first = report.orders[0]
    report.orders = [first, { ...first, projectId: 'distinct-project', projectName: '다른 프로젝트 ID', orderDate: '2026-12-09', productionType: 'MOQ', productionBudget: null, productionUnitCost: null, postCost: null }]
    report.excess[0].key = JSON.stringify([first.projectId, first.budgetCode])
    const workbook = await reopen(await buildBudgetWorkbook(report))
    const excess = workbook.getWorksheet(BUDGET_SHEET_NAMES.excess)!, dashboard = workbook.getWorksheet(BUDGET_SHEET_NAMES.dashboard)!
    expect(excess.getCell('C3').value).toBe(first.orderDate)
    expect(excess.getCell('D3').value).toBe(first.productionType)
    const other = Array.from({ length: 2 }, (_, index) => index + 8).find(row => dashboard.getCell(row, 2).value === '다른 프로젝트 ID')!
    expect(dashboard.getCell(other, 4).value).toBe('2026-12-09')
    expect(dashboard.getCell(other, 5).value).toBeNull()
    const firstRow = Array.from({ length: 2 }, (_, index) => index + 8).find(row => dashboard.getCell(row, 2).value === first.projectName)!
    expect(dashboard.getCell(firstRow, 4).value).toBe(first.orderDate)
    const csv = parseOrderCSV(budgetCSV(report, 'excess'))
    expect(csv[1][2]).toBe(first.orderDate); expect(csv[1][3]).toBe(first.productionType)
  })

  it('권한이 없는 보고서는 CSV와 Excel 모두 거부한다', async () => {
    const report = fixture(); report.authorized = false
    expect(() => budgetCSV(report)).toThrow('권한')
    await expect(buildBudgetWorkbook(report)).rejects.toThrow('권한')
  })
})
