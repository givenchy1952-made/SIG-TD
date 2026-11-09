import { expect, test, type Locator, type Page } from '@playwright/test'
import ExcelJS from 'exceljs'
import { readFile } from 'node:fs/promises'
import type { Workspace } from '../src/lib/types'
import type { BudgetCostData, BudgetOrderSource, BudgetRecord } from '../src/lib/budget-types'

const STORAGE = 'sig-workspace-demo-v1'
const ADMIN = '10000000-0000-4000-8000-000000000001', FINANCE = '10000000-0000-4000-8000-000000000006', FACTORY = '10000000-0000-4000-8000-000000000004'
const PROJECTS = ['99110000-0000-4000-8000-000000000001', '99110000-0000-4000-8000-000000000002', '99110000-0000-4000-8000-000000000003']
const CODES = ['SIGNIFICANT-2027FY-RPQ-99101', 'SIGNIFICANT-2027FY-RPQ-99102']
const SKUS = ['BP09FYJK0101BK', 'BP09FYPT0102NV']
const NAMES = ['시그니피컨트 원가 연결 A', '시그니피컨트 원가 연결 B', '시그니피컨트 원가 연결 A-별도']
const SUPPLIER = '20000000-0000-4000-8000-000000000001', SUPPLIER_NAME = 'QA 원가 공급사'
const MANUAL = '99114000-0000-4000-8000-000000000001'
const stamp = { version: 1, createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', updatedBy: ADMIN }
const HEADERS = ['프로젝트코드', 'SKU NO.', '종류', '업체', '내역', '위치', '규격', '품명', '혼용율', '컬러', '단가', '변동단가', '요척량', '단위']
type SourceRow = { project: number; description: string; price: ExcelJS.CellValue; consumption: ExcelJS.CellValue; sku?: string; code?: string; supplierName?: string; category?: string }
const defaultRows = (): SourceRow[] => [
  { project: 0, description: 'QA 주원단', price: 12.34, consumption: 0.125 },
  { project: 0, description: 'QA 봉제', price: 8.7, consumption: 2 },
  { project: 1, description: 'QA 부자재', price: 100, consumption: 3, supplierName: 'QA 미등록 원단사', category: '공용비용' },
]
function order(index: number): BudgetOrderSource {
  const mapped = index === 2 ? 0 : index
  return { projectId: PROJECTS[index], projectCode: CODES[mapped], projectName: NAMES[index], budgetCode: CODES[mapped] + SKUS[mapped], styleId: `99111000-0000-4000-8000-00000000000${index + 1}`, lineId: `99112000-0000-4000-8000-00000000000${index + 1}`, styleCode: SKUS[mapped], color: mapped ? 'NV' : 'BK', season: '2027FY', factoryId: SUPPLIER, factoryName: SUPPLIER_NAME, sourceKey: `legacy:qa:${index}`, brand: 'SIGNIFICANT', productionType: 'RPQ', orderCode: String(99101 + mapped), orderDate: '2026-11-01', quantity: mapped ? 20 : 10, receivedQuantity: 0, joorQuantity: 0, aderQuantity: mapped ? 20 : 10 }
}
function manualCost(): BudgetRecord {
  const source = order(0)
  const data: BudgetCostData = { projectId: source.projectId, budgetCode: source.budgetCode, styleCode: source.styleCode, supplierId: SUPPLIER, supplierName: SUPPLIER_NAME, stage: 'pre', category: '수동', description: 'QA 직접 등록 금액', position: '', specification: '', itemName: '수동 항목', composition: '', color: 'BK', unitCost: 777, variableUnitCost: null, consumption: 2, unit: 'EA', amount: 5, voided: false }
  return { id: MANUAL, kind: 'cost', data, ...stamp }
}
async function workbook(rows: SourceRow[] = defaultRows()) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('SIG_TD 사이트 원가계산서 예시')
  sheet.getCell('C8').value = CODES[0]; sheet.getCell('C4').value = SKUS[0]
  HEADERS.forEach((value, index) => { sheet.getCell(15, index + 2).value = value })
  rows.forEach((source, index) => {
    const row = index + 16, mapped = source.project
    sheet.getCell(row, 2).value = { formula: '$C$8', result: ` ${source.code || CODES[mapped]} ` }
    sheet.getCell(row, 3).value = { formula: '$C$4', result: source.sku || SKUS[mapped] }
    ;[source.category || '원자재', source.supplierName || SUPPLIER_NAME, source.description, '몸판', 'QA 40mm', 123, 'COTTON 100%', mapped ? 'NV' : 'BK', source.price, 99.99, source.consumption, 'YDS'].forEach((value, column) => { sheet.getCell(row, column + 4).value = value })
  })
  // Blank template formulas have no cached values and must not turn into errors.
  sheet.getCell(rows.length + 16, 2).value = { formula: '$C$8' }
  sheet.getCell(rows.length + 16, 3).value = { formula: '$C$4' }
  const directory = book.addWorksheet('업체리스트'); directory.getCell('B15').value = '관련 없는 참조 목록'; directory.getCell('D16').value = '가져오면 안 되는 원본 참조'
  return Buffer.from(await book.xlsx.writeBuffer())
}
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function navigate(page: Page) {
  const mobile = page.getByRole('button', { name: '메뉴 열기', exact: true })
  if (await mobile.isVisible()) await mobile.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '예산·을지 누적', exact: true }).click()
}
async function tab(page: Page, name: string) { await page.getByRole('navigation', { name: '예산·을지 탭' }).getByRole('button', { name: new RegExp(`^${name}`) }).click() }
async function fixture(page: Page, ambiguous = false, available = true) {
  page.on('dialog', dialogue => { void dialogue.accept() })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, admin, finance, orders, records, supplier, supplierName, available }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    if (!w.profiles.some(person => person.id === finance)) w.profiles.push({ id: finance, name: 'QA FA 원가 담당', email: 'finance@example.test', role: 'finance', approved: true, active: true, factoryId: null })
    w.factories.find(factory => factory.id === supplier)!.name = supplierName
    w.budgetSources = { orders, settlements: [], warnings: [] }; w.budgetRecords = records; w.budgetAudits = []
    w.budgetAvailable = true; w.budgetCostImportAvailable = available; w.budgetCostImports = []
    localStorage.setItem(key, JSON.stringify(w)); localStorage.setItem('sig-demo-profile', admin)
  }, { key: STORAGE, admin: ADMIN, finance: FINANCE, orders: ambiguous ? [order(0), order(1), order(2)] : [order(0), order(1)], records: [manualCost()], supplier: SUPPLIER, supplierName: SUPPLIER_NAME, available })
  await page.reload(); await navigate(page); await tab(page, '원가계산서')
}
async function openUpload(page: Page, rows = defaultRows(), filename = 'QA-OUTER.xlsx') {
  await page.getByRole('button', { name: '원가계산서 업로드', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '원가계산서 가져오기', exact: true })
  await dialog.getByLabel('원가계산서 Excel 파일', { exact: true }).setInputFiles({ name: filename, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await workbook(rows) })
  await expect(dialog.getByRole('table', { name: '원가 업로드 미리보기', exact: true })).toBeVisible()
  return dialog
}
async function apply(dialog: Locator) {
  await dialog.getByLabel('원가 업로드 사유', { exact: true }).fill('QA 원가 파일과 발주 코드 대조')
  await dialog.getByRole('button', { name: '검증된 원가 적용', exact: true }).click()
  await expect(dialog.getByRole('status').filter({ hasText: '원가 업로드 완료' })).toBeVisible()
}
async function close(dialog: Locator) { const button = dialog.locator('.modal-footer').getByRole('button', { name: '닫기', exact: true }); await expect(button).toBeEnabled(); await button.click(); await expect(dialog).not.toBeVisible() }
function costs(w: Workspace) { return w.budgetRecords?.filter((record): record is Extract<BudgetRecord, { kind: 'cost' }> => record.kind === 'cost') || [] }
async function downloaded(page: Page) {
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: '전체 Excel 다운로드', exact: true }).click()
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await readFile((await (await pending).path())!)); return book
}

test('15행 제목 아래 원가를 프로젝트 코드·SKU에 연결하고 I~T와 U=Q×S를 Excel까지 보존한다', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page), dialog = await openUpload(page)
  await expect(dialog).toContainText('QA 주원단'); await expect(dialog).toContainText('1.5425')
  await page.screenshot({ path: '/tmp/sig-cost-import-desktop.png', fullPage: true })
  expect(costs(await snapshot(page))).toEqual(costs(before))
  await apply(dialog); await close(dialog)
  await expect.poll(async () => costs(await snapshot(page)).length).toBe(4)
  const after = await snapshot(page)
  expect(costs(after).find(record => record.id === MANUAL)).toEqual(manualCost())
  const imported = costs(after).find(record => record.data.description === 'QA 주원단')!
  expect(imported.data).toMatchObject({ projectId: PROJECTS[0], budgetCode: CODES[0] + SKUS[0], styleCode: SKUS[0], category: '원자재', supplierName: SUPPLIER_NAME, description: 'QA 주원단', position: '몸판', specification: 'QA 40mm', itemName: '123', composition: 'COTTON 100%', color: 'BK', unitCost: 12.34, variableUnitCost: 99.99, consumption: 0.125, unit: 'YDS', amount: 1.5425 })
  expect(after.styles).toEqual(before.styles); expect(after.productionRuns).toEqual(before.productionRuns); expect(after.operations).toEqual(before.operations)
  await tab(page, '발주요청세부')
  const orderRow = page.getByRole('table', { name: '발주요청세부', exact: true }).locator('tbody tr').filter({ hasText: SKUS[0] })
  await expect(orderRow.locator('td').nth(12)).toHaveText('2,130')
  await expect(orderRow.locator('td').nth(13)).toHaveText('213')
  const commonOrder = page.getByRole('table', { name: '발주요청세부', exact: true }).locator('tbody tr').filter({ hasText: SKUS[1] })
  await expect(commonOrder.locator('td').nth(12)).toHaveText('5,999')
  await expect(commonOrder.locator('td').nth(13)).toHaveText('300')
  await expect(page.getByRole('table', { name: '발주요청세부', exact: true }).getByRole('columnheader', { name: /사후원가/ })).toHaveCount(0)
  await page.screenshot({ path: '/tmp/sig-budget-quantity-orders-desktop.png', fullPage: true })
  const book = await downloaded(page), sheet = book.worksheets[1]
  expect(book.worksheets[0].getCell('M2').value).toEqual({ formula: 'IF(O2="","",O2*J2)', result: 2129.7875 })
  expect(book.worksheets[0].getCell('O2').value).toBe(212.97875)
  expect(book.worksheets[0].getCell('M3').result).toBe(5999.4)
  expect(book.worksheets[0].getCell('O3').value).toBe(299.97)
  expect(book.worksheets[0].getCell('O2').numFmt).toBe('#,##0;[Red]-#,##0')
  expect(book.worksheets[0].getColumn(14).hidden).toBe(true)
  expect(book.worksheets[0].getCell('N2').value).toBeNull()
  let sourceRow = 0
  sheet.eachRow((row, index) => { if (row.getCell(11).value === 'QA 주원단') sourceRow = index })
  expect(sourceRow).toBeGreaterThan(1)
  expect(sheet.getRow(sourceRow).values.slice(1, 9)).toEqual([CODES[0], expect.anything(), NAMES[0], SKUS[0], 'SIGNIFICANT', '2027FY', 'RPQ', '99101'])
  expect(sheet.getCell(sourceRow, 2).result).toBe(CODES[0] + SKUS[0])
  expect(sheet.getRow(sourceRow).values.slice(9, 21)).toEqual(['원자재', SUPPLIER_NAME, 'QA 주원단', '몸판', 'QA 40mm', '123', 'COTTON 100%', 'BK', 12.34, 99.99, 0.125, 'YDS'])
  expect(sheet.getCell(sourceRow, 21).formula).toBe(`Q${sourceRow}*S${sourceRow}`); expect(sheet.getCell(sourceRow, 21).result).toBe(1.5425)
  expect(sheet.getCell('U2').value).toBe(5)
  await tab(page, '원가계산서')
  await page.getByRole('button', { name: '예산 업체', exact: true }).click()
  const supplierFilter = page.getByRole('dialog', { name: '예산 업체 선택', exact: true })
  await supplierFilter.getByRole('button', { name: '선택해제', exact: true }).click()
  await supplierFilter.getByRole('checkbox', { name: 'QA 미등록 원단사 · 미연결', exact: true }).check()
  await supplierFilter.getByRole('button', { name: '완료', exact: true }).click()
  const filtered = page.getByRole('table', { name: '원가계산서', exact: true })
  await expect(filtered.locator('tbody tr')).toHaveCount(1)
  await expect(filtered).toContainText('QA 미등록 원단사')
  await expect(filtered).toContainText('QA 부자재')
  await page.reload(); await navigate(page); await tab(page, '원가계산서')
  await expect(page.getByRole('table', { name: '원가계산서', exact: true })).toContainText('QA 주원단')
})

test('같은 원가 파일을 이름을 바꾸어 다시 업로드해도 원가가 중복 누적되지 않는다', async ({ page }) => {
  await fixture(page)
  let dialog = await openUpload(page); await apply(dialog); await close(dialog)
  const before = await snapshot(page)
  dialog = await openUpload(page, defaultRows(), 'QA-OUTER-이름변경.xlsx')
  await expect(dialog).toContainText(/동일|중복|건너|변경 없음/)
  const button = dialog.getByRole('button', { name: '검증된 원가 적용', exact: true })
  if (await button.isEnabled()) await apply(dialog)
  await close(dialog)
  expect(costs(await snapshot(page))).toEqual(costs(before))
})

test('동일 파일의 수정 행만 갱신하고 기존 수동 원가와 다른 업로드 행은 유지한다', async ({ page }) => {
  await fixture(page)
  let dialog = await openUpload(page); await apply(dialog); await close(dialog)
  const before = await snapshot(page), previous = costs(before).find(record => record.data.description === 'QA 주원단')!
  const changed = defaultRows(); changed[0].price = 20
  dialog = await openUpload(page, changed)
  await expect(dialog).toContainText(/수정|갱신|변경/)
  await apply(dialog); await close(dialog)
  const after = await snapshot(page), current = costs(after).find(record => record.id === previous.id)!
  expect(current.version).toBe(previous.version + 1); expect(current.data).toMatchObject({ unitCost: 20, amount: 2.5 })
  expect(costs(after)).toHaveLength(4)
  expect(costs(after).filter(record => record.id !== previous.id)).toEqual(costs(before).filter(record => record.id !== previous.id))
})

test('연결되지 않은 코드·SKU와 계산 결과가 없는 유효 행은 전체 적용을 막는다', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page)
  const invalid = defaultRows(); invalid[1].sku = 'UNKNOWN-SKU'; invalid[2].price = { formula: '1+2' }
  const dialog = await openUpload(page, invalid)
  await expect(dialog).toContainText('UNKNOWN-SKU')
  await expect(dialog.getByRole('button', { name: '검증된 원가 적용', exact: true })).toBeDisabled()
  expect(await snapshot(page)).toEqual(before)
})

test('코드와 SKU가 같은 서로 다른 프로젝트는 명시적으로 선택한 프로젝트에만 연결한다', async ({ page }) => {
  await fixture(page, true)
  const dialog = await openUpload(page, [defaultRows()[0]])
  await expect(dialog.getByRole('button', { name: '검증된 원가 적용', exact: true })).toBeDisabled()
  await dialog.getByLabel(`원가 프로젝트 연결 ${CODES[0]} ${SKUS[0]}`, { exact: true }).selectOption(PROJECTS[2])
  await apply(dialog); await close(dialog)
  const imported = costs(await snapshot(page)).filter(record => record.id !== MANUAL)
  expect(imported).toHaveLength(1); expect(imported[0].data.projectId).toBe(PROJECTS[2])
})

test('모바일에서도 업로드를 확인하며 FA·공장과 미설정 계정의 원가 업로드를 제한한다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  const dialog = await openUpload(page)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: '/tmp/sig-cost-import-mobile.png', fullPage: true })
  await apply(dialog); await close(dialog)
  await tab(page, '발주요청세부')
  const orderTable = page.getByRole('table', { name: '발주요청세부', exact: true })
  await expect(orderTable.getByRole('columnheader', { name: /사후원가/ })).toHaveCount(0)
  const firstOrder = orderTable.locator('tbody tr').filter({ hasText: SKUS[0] })
  await expect(firstOrder.locator('td').nth(12)).toHaveText('2,130')
  await expect(firstOrder.locator('td').nth(13)).toHaveText('213')
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: '/tmp/sig-budget-quantity-orders-mobile.png', fullPage: true })
  await page.getByLabel('체험 역할', { exact: true }).selectOption(FINANCE)
  await tab(page, '원가계산서'); await expect(page.getByRole('button', { name: '원가계산서 업로드', exact: true })).toHaveCount(0)
  const book = await downloaded(page), sourceSheet = book.worksheets[1]
  let sourceRow = 0
  sourceSheet.eachRow((row, index) => { if (row.getCell(11).value === 'QA 주원단') sourceRow = index })
  expect(sourceRow).toBeGreaterThan(1)
  expect(sourceSheet.getCell(sourceRow, 21).formula).toBe(`Q${sourceRow}*S${sourceRow}`)
  expect(sourceSheet.getCell(sourceRow, 21).result).toBe(1.5425)
  await page.getByLabel('체험 역할', { exact: true }).selectOption(FACTORY)
  await expect(page.getByRole('region', { name: '예산·을지 누적', exact: true })).toHaveCount(0)
  await page.getByLabel('체험 역할', { exact: true }).selectOption(ADMIN)
  await page.evaluate(key => { const w = JSON.parse(localStorage.getItem(key)!) as Workspace; w.budgetCostImportAvailable = false; localStorage.setItem(key, JSON.stringify(w)) }, STORAGE)
  await page.reload(); await navigate(page); await tab(page, '원가계산서')
  const trigger = page.getByRole('button', { name: '원가계산서 업로드', exact: true })
  if (await trigger.isEnabled()) {
    await trigger.click()
    await expect(page.getByRole('button', { name: '검증된 원가 적용', exact: true })).toBeDisabled()
  } else await expect(trigger).toBeDisabled()
})

test('미리보기 이후 마지막 원가 행이 바뀌면 앞 행도 저장하지 않고 원가 파일을 보존한다', async ({ page }) => {
  await fixture(page)
  let dialog = await openUpload(page); await apply(dialog); await close(dialog)
  const changed = defaultRows(); changed[0].price = 20; changed[2].price = 150
  dialog = await openUpload(page, changed)
  await page.evaluate(key => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace, last = w.budgetRecords!.find(record => record.kind === 'cost' && record.data.description === 'QA 부자재')!
    last.version += 1
    if (last.kind === 'cost') last.data.amount = 333
    localStorage.setItem(key, JSON.stringify(w))
  }, STORAGE)
  const before = await snapshot(page)
  await dialog.getByLabel('원가 업로드 사유', { exact: true }).fill('QA 동시 수정 전체 롤백 확인')
  await dialog.getByRole('button', { name: '검증된 원가 적용', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText(/다른|최신|충돌|먼저|VERSION/)
  expect(await snapshot(page)).toEqual(before)
  await expect(dialog).toContainText('QA 주원단')
})
