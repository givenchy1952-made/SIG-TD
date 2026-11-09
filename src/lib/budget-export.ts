import type { CellValue, Worksheet } from 'exceljs'
import type { BudgetException, BudgetGroup, BudgetOrderRow, BudgetReport } from './budget-types'
import { groupBudgetReport } from './budget-domain'
import { safeCSVCell } from './export'
import { multiplyBudgetCost } from './budget-money'

export type BudgetExportTab = 'dashboard' | 'orders' | 'costs' | 'fa' | 'excess' | 'unclosed'
type Value = string | number | null
interface SheetData { tab: BudgetExportTab; name: string; headerRow: number; headers: string[]; rows: Value[][] }
export const BUDGET_SHEET_NAMES = {
  orders: '1-0.발주요청세부(Order Quantity 관련)', costs: '2-0.원가계산서(TD 사전원가와 관련)',
  fa: 'FA을지 누적용', dashboard: '7-0.대시보드(최종 취합)', excess: '7-1.초과 내역', unclosed: '7-2.미종결 내역',
} as const
export const BUDGET_ORDER_HEADERS = ['프로젝트 코드', '예산 코드', '프로젝트 명칭', '스타일코드', '브랜드', '년도/시즌', '생산구분', '발주 코드', '발주 요청일', '합계 : TTL', '합계 : JOOR GB', '합계 : ADER KOR', '생산 예산', '2-0.사후원가 확인', '생산 원가']
export const BUDGET_COST_HEADERS = ['프로젝트코드', '예산코드', '프로젝트 명칭', '스타일코드', '브랜드', '년도/시즌', '생산구분', '발주 코드', '종류', '업체', '내역', '위치', '규격', '품명', '혼용율', '컬러2', '단가', '변동단가', '요척량', '단위', '금액']
export const BUDGET_FA_HEADERS = ['지급일', '품의서 #', '업체명', '발주날짜', '프로젝트코드', '프로젝트+업체 코드', '스타일코드', 'ERP계정과목', '품목', '단가', '요척', '오더수량', '입고수량', '단위', '금액', 'VAT', '합계', '담당자', '산출근거', '분할 결제', '결제 상태']
const PROJECT_HEADERS = ['년도/시즌', '프로젝트 명칭', '프로젝트코드', '발주날짜', '합계 : 예산', '지출내역', '진행율', '예산종결여부']
const FACTORY_HEADERS = ['년도/시즌', '프로젝트코드', '발주날짜', '생산 구분', '생산 차수', '업체', '합계 : 예산', '프로젝트+업체', '지출현황', '진행율', '종결여부', '미지급']
const EXCESS_HEADERS = ['년도/시즌', '프로젝트코드', '발주날짜', '생산 구분', '생산 차수', '업체', '합계 : 예산', '프로젝트+업체', '지출현황', '진행율', '종결여부', '초과금액', '초과사유', '프로젝트 명칭', '스타일코드', '확인 사항']
const UNCLOSED_HEADERS = ['년도/시즌', '프로젝트 명칭', '프로젝트코드', '스타일코드', '업체', '생산 예산', '지출현황', '확정 미결제', '확인 사항', '미종결 사유']
const MONEY = '#,##0.00;[Red]-#,##0.00'
const COST_MONEY = '#,##0.00####;[Red]-#,##0.00####'
const PERCENT = '0.0%'
const MAX_ROWS = 10000

function authorized(report: BudgetReport) {
  if (!report.authorized) throw new Error('예산·을지 누적을 열람할 권한이 없습니다.')
  for (const rows of [report.orders, report.costs, report.settlements, report.groups, report.excess, report.unclosed]) if (rows.length > MAX_ROWS) throw new Error('예산 내보내기는 시트별 10,000행까지 지원합니다. 필터를 좁혀 주세요.')
}
const unique = (values: string[]) => [...new Set(values.filter(Boolean))].join(', ')
const budgetCode = (project: string, style: string) => `${project}${style}`.replace(/\s/gu, '')
// A stale mutable source does not undo a real, captured payment. The domain supplies its frozen financial snapshot.
const paid = (row: BudgetReport['settlements'][number]) => row.payment.status === 'paid'
const metadata = (report: BudgetReport, group: BudgetGroup, kind: 'project' | 'factory') => report.orders.filter(order => kind === 'project' ? order.projectId === group.key : order.factoryId === group.key || report.costs.some(record => record.data.projectId === order.projectId && record.data.budgetCode === order.budgetCode && record.data.supplierId === group.key))
const groupBudget = (group: BudgetGroup) => group.totals.missingCostCount > 0 && group.totals.budget === 0 ? null : group.totals.budget
const progress = (paidAmount: number, budget: number | null) => budget === null || budget <= 0 ? null : paidAmount / budget
function orderCells(order: BudgetOrderRow): Value[] {
  return [order.projectCode, budgetCode(order.projectCode, order.styleCode), order.projectName, order.styleCode, order.brand, order.season, order.productionType, order.orderCode, order.orderDate, order.quantity, order.joorQuantity, order.aderQuantity, order.productionBudget, order.costMatched, order.productionUnitCost]
}
function exceptionCells(exception: BudgetException, report: BudgetReport): Value[] {
  const rows = report.orders.filter(order => JSON.stringify([order.projectId, order.budgetCode]) === exception.key)
  return [exception.season, exception.projectCode, unique(rows.map(row => row.orderDate)), unique(rows.map(row => row.productionType)), '', exception.factoryName, exception.budget, `${exception.projectCode}${exception.factoryName}`, exception.paid, progress(exception.paid, exception.budget), '', exception.overage, exception.reason, exception.projectName, exception.styleCode, exception.explanation]
}
function projectCells(report: BudgetReport, group: BudgetGroup): Value[] {
  return [group.season, group.label, group.projectCode, unique(metadata(report, group, 'project').map(order => order.orderDate)), groupBudget(group), group.totals.paid, group.totals.progress, group.closed ? '종결' : '미종결']
}
function factoryCells(report: BudgetReport, group: BudgetGroup): Value[] {
  const orders = metadata(report, group, 'factory')
  return [group.season, group.projectCode, unique(orders.map(order => order.orderDate)), unique(orders.map(order => order.productionType)), '', group.label, groupBudget(group), `${group.projectCode}${group.label}`, group.totals.paid, group.totals.progress, group.closed ? '종결' : '미종결', group.totals.unpaid]
}
function sheets(report: BudgetReport): SheetData[] {
  authorized(report)
  return [
    { tab: 'orders', name: BUDGET_SHEET_NAMES.orders, headerRow: 1, headers: BUDGET_ORDER_HEADERS, rows: report.orders.map(orderCells) },
    { tab: 'costs', name: BUDGET_SHEET_NAMES.costs, headerRow: 1, headers: BUDGET_COST_HEADERS, rows: report.costs.map(record => {
      const cost = record.data, identity = report.orders.find(order => order.projectId === cost.projectId && order.budgetCode === cost.budgetCode)
      const category = report.budgetCostImportRecordIds?.includes(record.id) ? cost.category : `${cost.stage === 'pre' ? '사전' : '사후'}${cost.category ? ` · ${cost.category}` : ''}`
      return [identity?.projectCode || '', cost.budgetCode, identity?.projectName || '', cost.styleCode, identity?.brand || '', identity?.season || '', identity?.productionType || '', identity?.orderCode || '', category, cost.supplierName, cost.description, cost.position, cost.specification, cost.itemName, cost.composition, cost.color, cost.unitCost, cost.variableUnitCost, cost.consumption, cost.unit, cost.amount]
    }) },
    { tab: 'fa', name: BUDGET_SHEET_NAMES.fa, headerRow: 3, headers: BUDGET_FA_HEADERS, rows: report.settlements.map(row => [paid(row) ? row.payment.paidAt : '', row.payment.voucherNo, row.factoryName, row.orderDate, row.projectCode, `${row.factoryName}${row.projectCode}`, row.styleCode, row.payment.account, row.item, row.unitCost, row.consumption, row.orderQuantity, row.receivedQuantity, row.unit, row.netAmount, row.vatAmount, row.grossAmount, row.owner, [row.evidence, row.payment.description, row.paymentStale ? '원본 변경 확인 필요 · 결제 당시 금액 보존' : ''].filter(Boolean).join(' · '), row.payment.splitPayment, paid(row) ? '결제' : '미결제']) },
    { tab: 'dashboard', name: BUDGET_SHEET_NAMES.dashboard, headerRow: 7, headers: PROJECT_HEADERS, rows: groupBudgetReport(report, 'project').map(group => projectCells(report, group)) },
    { tab: 'excess', name: BUDGET_SHEET_NAMES.excess, headerRow: 2, headers: EXCESS_HEADERS, rows: report.excess.map(row => exceptionCells(row, report)) },
    { tab: 'unclosed', name: BUDGET_SHEET_NAMES.unclosed, headerRow: 1, headers: UNCLOSED_HEADERS, rows: report.unclosed.map(row => [row.season, row.projectName, row.projectCode, row.styleCode, row.factoryName, row.budget, row.paid, row.unpaid, row.explanation, row.reason]) },
  ]
}

/** Fresh output contains only the already-authorized, filtered report. No original pivot caches or stale company rows are copied. */
export function budgetCSV(report: BudgetReport, tab: BudgetExportTab = 'orders'): string {
  const data = sheets(report).find(sheet => sheet.tab === tab)
  if (!data) throw new Error('내보낼 예산 화면을 확인해 주세요.')
  let rows: Value[][] = [data.headers, ...data.rows]
  if (tab === 'dashboard') rows = [
    ['항목', '금액·수량', '기준'],
    ['발주 예산합계 (등록분)', report.totals.budget, '공급가액 KRW'], ['지출합계', report.totals.paid, '결제로 확인된 공급가액'],
    ['미지급합계 (계획 잔액)', report.totals.remaining, '등록된 예산에서 지출 차감'], ['확정 미결제 을지', report.totals.unpaid, '확정 을지 공급가액'],
    ['예산 진행률', report.totals.progress, '지출 / 등록 예산'], ['예산한도', report.totals.annualLimit, '등록된 시즌 한도'], ['예산잔액', report.totals.unallocated, '한도에서 배정 예산 차감'],
    ['원가 미등록', report.totals.missingCostCount, '건'], ['결제 VAT', report.totals.paidVat, 'KRW'], ['결제 합계 (VAT 포함)', report.totals.paidGross, 'KRW'],
    [], data.headers, ...data.rows, [], FACTORY_HEADERS, ...groupBudgetReport(report, 'factory').map(group => factoryCells(report, group)),
    [], ['집계 확인 사항'], ...report.warnings.map(warning => [warning]),
  ]
  return '\uFEFF' + rows.map(row => row.map(safeCSVCell).join(',')).join('\r\n') + '\r\n'
}

function literal(value: Value): CellValue { return value === null ? null : typeof value === 'string' ? value.slice(0, 32767) : value }
function header(sheet: Worksheet, row: number, values: string[], startColumn = 1) {
  values.forEach((value, index) => {
    const cell = sheet.getCell(row, startColumn + index)
    cell.value = value; cell.font = { name: '맑은 고딕', size: 10, bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF243C56' } }
    cell.alignment = { vertical: 'middle', wrapText: true }
  })
  sheet.getRow(row).height = 33
}
function money(sheet: Worksheet, columns: number[], start: number, end: number, format = MONEY) {
  for (let row = start; row <= end; row++) for (const column of columns) sheet.getCell(row, column).numFmt = format
}
function blankIfUnknown(value: number | null): number | string { return value === null ? '' : value }
function whitespaceFormula(row: number) { return `SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(A${row}&D${row}," ",""),CHAR(9),""),CHAR(10),""),CHAR(13),""),CHAR(160),""),"　","")` }

export async function buildBudgetWorkbook(report: BudgetReport): Promise<Uint8Array> {
  const data = sheets(report), ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'SIG-TD'; workbook.subject = '예산·을지 누적'; workbook.calcProperties.fullCalcOnLoad = true
  for (const table of data) {
    const sheet = workbook.addWorksheet(table.name, { views: [{ state: 'frozen', ySplit: table.headerRow }], properties: { defaultRowHeight: 23 } })
    header(sheet, table.headerRow, table.headers)
    sheet.columns.forEach((column, index) => { column.width = table.headers[index]?.includes('코드') ? 30 : 18 })
    table.rows.forEach((values, index) => {
      const row = sheet.getRow(table.headerRow + 1 + index)
      values.forEach((value, column) => { row.getCell(column + 1).value = literal(value) })
      row.font = { name: '맑은 고딕', size: 10 }
      row.alignment = { vertical: 'middle', wrapText: true }
    })
    if (table.tab !== 'dashboard') sheet.autoFilter = { from: { row: table.headerRow, column: 1 }, to: { row: Math.max(table.headerRow + table.rows.length, table.headerRow + 1), column: table.headers.length } }
    sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `1:${table.headerRow}` }
  }
  const orderSheet = workbook.getWorksheet(BUDGET_SHEET_NAMES.orders)!
  report.orders.forEach((order, index) => {
    const row = index + 2
    orderSheet.getCell(row, 2).value = { formula: whitespaceFormula(row), result: budgetCode(order.projectCode, order.styleCode) }
    orderSheet.getCell(row, 15).value = { formula: `IF(OR(M${row}="",J${row}=0),"",M${row}/J${row})`, result: blankIfUnknown(order.productionUnitCost) }
  })
  money(orderSheet, [13, 15], 2, report.orders.length + 1)
  const costSheet = workbook.getWorksheet(BUDGET_SHEET_NAMES.costs)!
  const importedCostIds = new Set(report.budgetCostImportRecordIds || [])
  report.costs.forEach((record, index) => {
    const row = index + 2, identity = report.orders.find(order => order.projectId === record.data.projectId && order.budgetCode === record.data.budgetCode)
    // A supplied identity is necessary before creating A&D; an absent identity must not fabricate an unrelated budget key.
    if (identity) costSheet.getCell(row, 2).value = { formula: whitespaceFormula(row), result: budgetCode(identity.projectCode, record.data.styleCode) }
    if (importedCostIds.has(record.id)) {
      if (record.data.unitCost === null || record.data.consumption === null) costSheet.getCell(row, 21).value = null
      else {
        const amount = multiplyBudgetCost(record.data.unitCost, record.data.consumption)
        if (record.data.amount !== amount) throw new Error('업로드한 원가의 단가·요척량·금액 연결을 다시 확인해 주세요.')
        costSheet.getCell(row, 21).value = { formula: `Q${row}*S${row}`, result: amount }
      }
    }
  })
  money(costSheet, [17, 18, 19, 21], 2, report.costs.length + 1)
  for (let row = 2; row <= report.costs.length + 1; row++) {
    costSheet.getCell(row, 19).numFmt = '#,##0.####'
    costSheet.getCell(row, 21).numFmt = COST_MONEY
  }
  for (let row = 2; row <= report.orders.length + 1; row++) for (const column of [13, 15]) orderSheet.getCell(row, column).numFmt = COST_MONEY
  const fa = workbook.getWorksheet(BUDGET_SHEET_NAMES.fa)!, lastFA = Math.max(4, report.settlements.length + 3)
  fa.getCell('A1').value = 'FA 을지 누적 · 공급가액 / VAT 별도'; fa.getCell('A1').font = { bold: true, size: 12 }
  fa.getCell('O2').value = { formula: `SUM(O4:O${lastFA})`, result: report.settlements.reduce((sum, row) => sum + row.netAmount, 0) }
  fa.getCell('P2').value = { formula: `SUM(P4:P${lastFA})`, result: report.settlements.reduce((sum, row) => sum + row.vatAmount, 0) }
  fa.getCell('Q2').value = { formula: `SUM(Q4:Q${lastFA})`, result: report.settlements.reduce((sum, row) => sum + row.grossAmount, 0) }
  fa.getCell('T2').value = '결제 건수'; fa.getCell('U2').value = { formula: `COUNTIF(U4:U${lastFA},"결제")`, result: report.settlements.filter(paid).length }
  report.settlements.forEach((entry, index) => {
    const row = index + 4
    fa.getCell(row, 6).value = { formula: `C${row}&E${row}`, result: `${entry.factoryName}${entry.projectCode}` }
    fa.getCell(row, 15).value = { formula: `M${row}*J${row}`, result: entry.netAmount }
    fa.getCell(row, 16).value = { formula: `O${row}*0.1`, result: entry.vatAmount }
    fa.getCell(row, 17).value = { formula: `O${row}+P${row}`, result: entry.grossAmount }
  })
  // Retain the provided U-column dropdown for the generated rows and the next blank entry.
  for (let row = 4; row <= Math.max(4, lastFA + 1); row++) fa.getCell(row, 21).dataValidation = { type: 'list', allowBlank: true, formulae: ['"결제,미결제"'], showErrorMessage: true, errorTitle: '결제 상태', error: '결제 또는 미결제를 선택해 주세요.' }
  money(fa, [10, 11, 15, 16, 17], 2, lastFA)
  fa.getColumn(19).width = 48; fa.getColumn(7).width = 24
  const dashboard = workbook.getWorksheet(BUDGET_SHEET_NAMES.dashboard)!
  const summaryHeaders = ['발주 예산합계 (등록분)', '지출합계', '미지급합계 (계획 잔액)', '예산 진행률', '확정 미결제 을지', '결제 VAT', '결제 합계 (VAT 포함)', '원가 미등록 (건)']
  header(dashboard, 1, summaryHeaders)
  const endOrder = Math.max(2, report.orders.length + 1), faName = `'${BUDGET_SHEET_NAMES.fa}'`
  dashboard.getCell('A2').value = { formula: `SUM('${BUDGET_SHEET_NAMES.orders}'!M2:M${endOrder})`, result: report.totals.budget }
  dashboard.getCell('B2').value = { formula: `SUMIF(${faName}!U4:U${lastFA},"결제",${faName}!O4:O${lastFA})`, result: report.totals.paid }
  dashboard.getCell('C2').value = { formula: 'MAX(A2-B2,0)', result: report.totals.remaining }
  dashboard.getCell('D2').value = { formula: 'IF(A2=0,"",B2/A2)', result: blankIfUnknown(report.totals.progress) }
  dashboard.getCell('E2').value = { formula: `SUMIF(${faName}!U4:U${lastFA},"미결제",${faName}!O4:O${lastFA})`, result: report.totals.unpaid }
  dashboard.getCell('F2').value = { formula: `SUMIF(${faName}!U4:U${lastFA},"결제",${faName}!P4:P${lastFA})`, result: report.totals.paidVat }
  dashboard.getCell('G2').value = { formula: `SUMIF(${faName}!U4:U${lastFA},"결제",${faName}!Q4:Q${lastFA})`, result: report.totals.paidGross }
  dashboard.getCell('H2').value = report.totals.missingCostCount
  dashboard.getCell('A3').value = '예산한도'; dashboard.getCell('B3').value = '예산잔액'; dashboard.getCell('C3').value = '금액 기준'
  dashboard.getCell('A4').value = report.totals.annualLimit; dashboard.getCell('B4').value = report.totals.unallocated; dashboard.getCell('C4').value = '공급가액 KRW · VAT 별도'
  dashboard.getCell('A5').value = report.totals.missingCostCount ? `원가 미등록 ${report.totals.missingCostCount}건은 0원이 아닙니다. 예산 합계는 등록된 금액만 포함합니다.` : '예산과 지출은 공급가액 기준입니다. 미지급 계획 잔액과 확정 미결제 을지는 별도입니다.'
  dashboard.mergeCells('A5:H5'); dashboard.getCell('A5').alignment = { wrapText: true }; dashboard.getRow(5).height = 32
  money(dashboard, [1, 2, 3, 5, 6, 7], 2, 2, COST_MONEY); money(dashboard, [1, 2], 4, 4, COST_MONEY); dashboard.getCell('D2').numFmt = PERCENT
  const projectGroups = groupBudgetReport(report, 'project'), factoryGroups = groupBudgetReport(report, 'factory')
  header(dashboard, 7, FACTORY_HEADERS, 12)
  factoryGroups.forEach((group, index) => factoryCells(report, group).forEach((value, column) => { dashboard.getCell(index + 8, column + 12).value = literal(value) }))
  money(dashboard, [5, 6], 8, projectGroups.length + 7, COST_MONEY); money(dashboard, [18, 20, 23], 8, factoryGroups.length + 7, COST_MONEY)
  for (let row = 8; row < projectGroups.length + 8; row++) dashboard.getCell(row, 7).numFmt = PERCENT
  for (let row = 8; row < factoryGroups.length + 8; row++) dashboard.getCell(row, 21).numFmt = PERCENT
  const warningRow = Math.max(8 + projectGroups.length, 8 + factoryGroups.length) + 2
  dashboard.getCell(warningRow, 1).value = '집계 확인 사항'
  report.warnings.forEach((warning, index) => { dashboard.getCell(warningRow + index + 1, 1).value = warning.slice(0, 32767) })
  const excess = workbook.getWorksheet(BUDGET_SHEET_NAMES.excess)!, lastExcess = Math.max(3, report.excess.length + 2)
  excess.getCell('K1').value = '초과 합계'; excess.getCell('L1').value = { formula: `SUM(L3:L${lastExcess})`, result: report.excess.reduce((sum, row) => sum + row.overage, 0) }
  money(excess, [7, 9, 12], 3, lastExcess, COST_MONEY); excess.getColumn(13).width = 44; excess.getColumn(16).width = 44
  for (let row = 3; row <= lastExcess; row++) excess.getCell(row, 10).numFmt = PERCENT
  const unclosed = workbook.getWorksheet(BUDGET_SHEET_NAMES.unclosed)!
  money(unclosed, [6, 7, 8], 2, report.unclosed.length + 1, COST_MONEY); unclosed.getColumn(9).width = 44; unclosed.getColumn(10).width = 44
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}
