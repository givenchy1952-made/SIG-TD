import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import type { Workspace } from '../src/lib/types'
import type { BudgetCostData, BudgetFAEntry, BudgetIdentity, BudgetRecord, BudgetSources } from '../src/lib/budget-types'
import { parseOrderCSV } from '../src/lib/order-import'

const STORAGE = 'sig-workspace-demo-v1'
const ADMIN = '10000000-0000-4000-8000-000000000001', FINANCE = '10000000-0000-4000-8000-000000000006', FACTORY = '10000000-0000-4000-8000-000000000004'
const IDS = ['99070000-0000-4000-8000-000000000001', '99070000-0000-4000-8000-000000000002', '99070000-0000-4000-8000-000000000003']
const FACTORIES = ['20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002']
const NAMES = ['시그니피컨트 2027 1M-1', '시그니피컨트 2027 2M-1', '시그니피컨트 2028 1M-1']
const CODES = ['SIGNIFICANT-2027FY-RPQ-99001', 'SIGNIFICANT-2027FY-RPQ-99002', 'SIGNIFICANT-2028FY-RPQ-99003']
const STYLES = ['BP09FYJK0001BK', 'BP09FYPT0002NV', 'BP10FYTS0003WH']
const SUPPLIERS = ['QA 국내 생산', 'QA 해외 생산']
const PRIVATE = '예산에서 열면 안 되는 생산 내부 코멘트'
const stamp = { version: 1, createdAt: '2026-11-08T03:00:00Z', updatedAt: '2026-11-08T03:00:00Z', updatedBy: ADMIN }
const identity = (index: number): BudgetIdentity => ({ projectId: IDS[index], projectCode: CODES[index], projectName: NAMES[index], budgetCode: CODES[index] + STYLES[index], styleId: `99071000-0000-4000-8000-00000000000${index + 1}`, lineId: `99072000-0000-4000-8000-00000000000${index + 1}`, styleCode: STYLES[index], color: ['BK', 'NV', 'WH'][index], season: index === 2 ? '2028FY' : '2027FY', factoryId: FACTORIES[index === 1 ? 1 : 0], factoryName: SUPPLIERS[index === 1 ? 1 : 0] })
function settlement(index: number, quantity: number, unitCost: number): BudgetFAEntry {
  const sourceKey = `production:99073000-0000-4000-8000-00000000000${index + 1}`
  return { ...identity(index), sourceKey, sourceVersion: 3, sourceFingerprint: `${sourceKey}@3`, orderDate: '2026-11-01', receivedAt: '2026-11-07', unitCost, consumption: null, orderQuantity: quantity, receivedQuantity: quantity, unit: 'EA', netAmount: quantity * unitCost, vatAmount: quantity * unitCost / 10, grossAmount: quantity * unitCost + quantity * unitCost / 10, owner: 'QA 본사', item: '제품', evidence: '생산 차수 마감 확정' }
}
function sources(): BudgetSources {
  return { orders: [10, 5, 4].map((quantity, index) => ({ ...identity(index), sourceKey: `production:99073000-0000-4000-8000-00000000000${index + 1}`, brand: 'SIGNIFICANT', productionType: 'RPQ', orderCode: String(99001 + index), orderDate: '2026-11-01', quantity, receivedQuantity: index === 1 ? 0 : quantity, joorQuantity: index === 0 ? 3 : 0, aderQuantity: index === 0 ? 7 : quantity })), settlements: [settlement(0, 10, 1200), settlement(2, 4, 1500)], warnings: [] }
}
function cost(index: number, amount: number, stage: 'pre' | 'post' = 'pre'): BudgetRecord {
  const source = identity(index)
  const data: BudgetCostData = { projectId: source.projectId, budgetCode: source.budgetCode, styleCode: source.styleCode, supplierId: source.factoryId, supplierName: source.factoryName, stage, category: '제품', description: 'QA 명시 원가', position: '', specification: '', itemName: '완제품', composition: '', color: source.color, unitCost: null, variableUnitCost: null, consumption: null, unit: 'EA', amount, voided: false }
  return { id: `99074000-0000-4000-8000-00000000000${index + 1}`, kind: 'cost', data, ...stamp }
}
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function menu(page: Page, name = '예산·을지 누적') {
  const trigger = page.getByRole('button', { name: '메뉴 열기', exact: true })
  if (await trigger.isVisible()) await trigger.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name, exact: true }).click()
}
async function fixture(page: Page, withCosts = true) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, admin, finance, budgetSources, records, privateNote, factoryIds, supplierNames }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    if (!w.profiles.some(person => person.id === finance)) w.profiles.push({ id: finance, name: 'QA FA 담당', email: 'finance@example.test', role: 'finance', approved: true, active: true, factoryId: null })
    w.factories.forEach(factory => { const index = factoryIds.indexOf(factory.id); if (index >= 0) factory.name = supplierNames[index] })
    w.budgetAvailable = true; w.financeRoleAvailable = true; w.budgetSources = budgetSources; w.budgetRecords = records; w.budgetAudits = []
    w.styles.forEach(style => { style.notes = privateNote })
    w.comments = [{ id: crypto.randomUUID(), styleId: w.styles[0].id, sampleId: null, authorId: admin, authorName: 'QA 본사', body: privateNote, createdAt: new Date().toISOString() }]
    localStorage.setItem(key, JSON.stringify(w)); localStorage.setItem('sig-demo-profile', admin)
  }, { key: STORAGE, admin: ADMIN, finance: FINANCE, budgetSources: sources(), records: withCosts ? [cost(0, 10000), cost(1, 5000), cost(2, 8000)] : [], privateNote: PRIVATE, factoryIds: FACTORIES, supplierNames: SUPPLIERS })
  await page.reload(); await menu(page)
  await expect(page.getByRole('heading', { name: '예산·을지 누적', exact: true })).toBeVisible()
  return page.locator('.budget-ledger')
}
async function tab(page: Page, name: string) { await page.getByRole('navigation', { name: '예산·을지 탭' }).getByRole('button', { name: new RegExp(`^${name}`) }).click() }
async function filter(page: Page, label: string, names: string[]) {
  await page.getByRole('button', { name: label, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `${label} 선택`, exact: true })
  await dialog.getByRole('button', { name: '선택해제', exact: true }).click()
  for (const name of names) await dialog.getByRole('checkbox', { name, exact: true }).check()
  await dialog.getByRole('button', { name: '완료', exact: true }).click()
}
async function xlsxDownload(page: Page) {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: '전체 Excel 다운로드', exact: true }).click()
  const workbook = new ExcelJS.Workbook(), file = await pending
  await workbook.xlsx.load(await readFile((await file.path())!))
  return workbook
}

async function saveEditor(dialog: Locator, reason = 'QA 명시 금액과 원본 연결 확인') {
  await dialog.getByLabel('예산 변경 사유', { exact: true }).fill(reason)
  await dialog.getByRole('button', { name: '변경 저장', exact: true }).click()
  await expect(dialog).not.toBeVisible()
}
function orderRow(page: Page, index: number) { return page.getByRole('table', { name: '발주요청세부', exact: true }).locator('tbody tr').filter({ hasText: STYLES[index] }) }
function faRow(page: Page, index: number) { return page.getByRole('table', { name: 'FA을지 누적', exact: true }).locator('tbody tr').filter({ hasText: STYLES[index] }) }
async function payFirst(page: Page) {
  await tab(page, 'FA을지 누적')
  await faRow(page, 0).getByRole('combobox').selectOption('paid')
  const dialog = page.getByRole('dialog', { name: 'FA을지 결제 정보', exact: true })
  await dialog.getByLabel('FA 지급일', { exact: true }).fill('2026-11-08')
  await dialog.getByLabel('FA 품의서 번호', { exact: true }).fill('QA-FA-1108')
  await dialog.getByLabel('FA ERP계정과목', { exact: true }).fill('제품 매입')
  await dialog.getByLabel('FA 산출근거', { exact: true }).fill('본사 이체 확인')
  await saveEditor(dialog, 'QA 전액 지급 확인')
  await expect(faRow(page, 0).getByRole('combobox')).toHaveValue('paid')
}

test('발주·요약은 원 단위로 표시하고 Excel·CSV 원본과 상세 원가·FA 소수 근거를 보존한다', async ({ page }) => {
  await fixture(page)
  await page.evaluate(key => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    const record = w.budgetRecords!.find(record => record.kind === 'cost')!
    if (record.kind === 'cost') Object.assign(record.data, { amount: 253210.75714, unitCost: 123.45, variableUnitCost: 234.56, consumption: 0.1234 })
    Object.assign(w.budgetSources!.settlements[0], { unitCost: 1234.56, netAmount: 12345.6, vatAmount: 1234.56, grossAmount: 13580.16 })
    localStorage.setItem(key, JSON.stringify(w))
  }, STORAGE)
  const before = await snapshot(page)
  await page.reload(); await menu(page)
  await expect(page.getByRole('article', { name: '발주 예산 합계', exact: true }).locator('strong')).toHaveText('266,211원')
  await expect(page.getByRole('article', { name: '미지급 합계', exact: true }).locator('strong')).toHaveText('18,346원')
  await tab(page, '발주요청세부')
  await expect(orderRow(page, 0).locator('td').nth(12)).toHaveText('253,211')
  await expect(orderRow(page, 0).locator('td').nth(13)).toHaveText('25,321')
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: '현재 탭 CSV', exact: true }).click()
  const rows = parseOrderCSV(await readFile((await (await pending).path())!, 'utf8'))
  expect(rows[1][12]).toBe('253210.75714'); expect(rows[1][14]).toBe('25321.075714')
  const workbook = await xlsxDownload(page), order = workbook.worksheets[0]
  expect(order.getCell('M2').result).toBe(253210.75714); expect(order.getCell('O2').value).toBe(25321.075714)
  expect(order.getCell('M2').numFmt).toBe('#,##0;[Red]-#,##0'); expect(order.getCell('O2').numFmt).toBe('#,##0;[Red]-#,##0')
  await tab(page, '원가계산서')
  const costRow = page.getByRole('table', { name: '원가계산서', exact: true }).locator('tbody tr').filter({ hasText: STYLES[0] })
  await expect(costRow.locator('td').nth(16)).toHaveText('123.45')
  await expect(costRow.locator('td').nth(17)).toHaveText('234.56')
  await expect(costRow.locator('td').nth(18)).toHaveText('0.1234')
  await expect(costRow.locator('td').nth(20)).toHaveText('253,210.75714')
  await tab(page, 'FA을지 누적')
  await expect(faRow(page, 0).locator('td').nth(9)).toHaveText('1,234.56')
  await expect(faRow(page, 0).locator('td').nth(14)).toHaveText('12,345.6')
  const after = await snapshot(page)
  expect(after.budgetRecords).toEqual(before.budgetRecords); expect(after.budgetSources).toEqual(before.budgetSources)
})

test('원가 미등록과 0원을 구분하고 사전·사후 원가를 발주 예산·코드·단가에 연결해 보존한다', async ({ page }) => {
  await fixture(page, false)
  const before = await snapshot(page)
  await expect(page.getByRole('status')).toContainText('사전원가 미등록 3건')
  await tab(page, '발주요청세부')
  await expect(orderRow(page, 0).locator('td').nth(12)).toHaveText('미등록')
  for (const [index, stage, amount] of [[0, 'pre', '10000'], [0, 'post', '11000'], [1, 'pre', '0']] as const) {
    await tab(page, '원가계산서')
    await page.getByRole('button', { name: '원가 항목 등록', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '원가 항목 등록·수정', exact: true })
    await dialog.getByLabel('원가 프로젝트·스타일 선택', { exact: true }).selectOption(JSON.stringify([IDS[index], CODES[index] + STYLES[index]]))
    await dialog.getByLabel('사전·사후원가', { exact: true }).selectOption(stage)
    await dialog.getByLabel('원가 업체', { exact: true }).selectOption(FACTORIES[index === 1 ? 1 : 0])
    await dialog.getByLabel('내역', { exact: true }).fill(`QA ${stage} 총액`)
    await dialog.getByLabel('단가', { exact: true }).fill('777')
    await dialog.getByLabel('요척량', { exact: true }).fill('2')
    await dialog.getByLabel('원가 금액', { exact: true }).fill(amount)
    await saveEditor(dialog)
  }
  await tab(page, '발주요청세부')
  await expect(orderRow(page, 0).locator('td').nth(1)).toHaveText(CODES[0] + STYLES[0])
  await expect(orderRow(page, 0).locator('td').nth(12)).toHaveText('10,000')
  await expect(page.getByRole('table', { name: '발주요청세부', exact: true }).getByRole('columnheader', { name: /사후원가/ })).toHaveCount(0)
  await expect(orderRow(page, 0).locator('td')).toHaveCount(14)
  await expect(orderRow(page, 0).locator('td').nth(13)).toHaveText('1,000')
  await expect(orderRow(page, 1).locator('td').nth(12)).toHaveText('0')
  await expect(orderRow(page, 2).locator('td').nth(12)).toHaveText('미등록')
  const after = await snapshot(page)
  expect(after.budgetRecords?.filter(record => record.kind === 'cost').map(record => record.data.amount)).toEqual(expect.arrayContaining([10000, 11000, 0]))
  expect(after.styles).toEqual(before.styles); expect(after.productionRuns).toEqual(before.productionRuns)
  expect(after.operations).toEqual(before.operations)
  await page.reload(); await menu(page); await tab(page, '발주요청세부')
  await expect(orderRow(page, 0).locator('td').nth(12)).toHaveText('10,000')
  await expect(orderRow(page, 1).locator('td').nth(12)).toHaveText('0')
})

test('본사 지급일 확인 후 결제를 기록하고 지출·미지급·초과 및 미종결 사유를 새로고침 후 유지한다', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page)
  await expect(page.getByRole('article', { name: '발주 예산 합계', exact: true }).locator('strong')).toHaveText('23,000원')
  await expect(page.getByRole('article', { name: '지출 합계', exact: true }).locator('strong')).toHaveText('0원')
  await expect(page.getByRole('article', { name: '미지급 합계', exact: true }).locator('strong')).toHaveText('18,000원')
  await tab(page, 'FA을지 누적')
  await faRow(page, 0).getByRole('combobox').selectOption('paid')
  let dialog = page.getByRole('dialog', { name: 'FA을지 결제 정보', exact: true })
  await dialog.getByLabel('예산 변경 사유', { exact: true }).fill('QA 지급일 필수 검증')
  await dialog.getByRole('button', { name: '변경 저장', exact: true }).click()
  await expect(dialog).toBeVisible()
  expect(await snapshot(page)).toEqual(before)
  await dialog.getByLabel('FA 지급일', { exact: true }).fill('2026-11-08')
  await dialog.getByLabel('FA 품의서 번호', { exact: true }).fill('QA-FA-1108')
  await saveEditor(dialog, 'QA 전액 지급 확인')
  await tab(page, '대시보드')
  await expect(page.getByRole('article', { name: '지출 합계', exact: true }).locator('strong')).toHaveText('12,000원')
  await expect(page.getByRole('article', { name: '미지급 합계', exact: true }).locator('strong')).toHaveText('6,000원')
  await expect(page.locator('.budget-funding-note')).toContainText('앞으로 지출할 예산 11,000원')
  await tab(page, '초과 내역')
  let row = page.getByRole('table', { name: '초과 내역', exact: true }).locator('tbody tr').filter({ hasText: STYLES[0] })
  await expect(row).toContainText('2,000')
  await row.getByRole('button', { name: '사유 입력', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '초과 발생 사유', exact: true })
  await dialog.getByLabel('발생 사유', { exact: true }).fill('QA 추가 가공 합의로 예산 초과')
  await saveEditor(dialog)
  await expect(row).toContainText('QA 추가 가공 합의로 예산 초과')
  await tab(page, '미종결 내역')
  row = page.getByRole('table', { name: '미종결 내역', exact: true }).locator('tbody tr').filter({ hasText: STYLES[1] })
  await expect(row).toContainText('미입고 5장')
  await row.getByRole('button', { name: '사유 입력', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '미종결 발생 사유', exact: true })
  await dialog.getByLabel('발생 사유', { exact: true }).fill('QA 업체 잔량 입고 대기')
  await saveEditor(dialog)
  const after = await snapshot(page)
  expect(after.styles).toEqual(before.styles); expect(after.productionRuns).toEqual(before.productionRuns); expect(after.productionReceipts).toEqual(before.productionReceipts)
  expect(after.budgetRecords?.filter(record => record.kind === 'payment')[0]).toMatchObject({ data: { status: 'paid', paidAt: '2026-11-08', voucherNo: 'QA-FA-1108' } })
  await page.reload(); await menu(page)
  await expect(page.getByRole('article', { name: '지출 합계', exact: true }).locator('strong')).toHaveText('12,000원')
  await tab(page, '초과 내역'); await expect(page.getByRole('table', { name: '초과 내역' })).toContainText('QA 추가 가공 합의로 예산 초과')
  await tab(page, '미종결 내역'); await expect(page.getByRole('table', { name: '미종결 내역' })).toContainText('QA 업체 잔량 입고 대기')
})

test('시즌별 한도와 프로젝트·코드·스타일·업체 복수 필터를 조합하고 같은 범위를 CSV·Excel에 출력한다', async ({ page }) => {
  await fixture(page)
  await page.getByRole('button', { name: '예산 한도 설정', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '시즌 예산 한도 설정', exact: true })
  await dialog.getByLabel('예산 한도 시즌', { exact: true }).selectOption('2027FY')
  await dialog.getByLabel('예산 한도 금액', { exact: true }).fill('50000')
  await saveEditor(dialog)
  await filter(page, '예산 프로젝트 명칭', NAMES.slice(0, 2))
  await filter(page, '예산 시즌', ['2027FY'])
  await expect(page.getByRole('article', { name: '발주 예산 합계', exact: true }).locator('strong')).toHaveText('15,000원')
  await expect(page.getByRole('article', { name: '예산 한도', exact: true }).locator('strong')).toHaveText('50,000원')
  await expect(page.getByRole('article', { name: '예산 잔액', exact: true }).locator('strong')).toHaveText('35,000원')
  await filter(page, '예산 프로젝트 코드', [CODES[0]])
  await filter(page, '예산 스타일코드', [STYLES[0]])
  await filter(page, '예산 업체', [SUPPLIERS[0]])
  await tab(page, '발주요청세부')
  await expect(page.getByRole('table', { name: '발주요청세부' }).locator('tbody tr')).toHaveCount(1)
  await expect(orderRow(page, 0)).toContainText(NAMES[0])
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: '현재 탭 CSV', exact: true }).click()
  const csv = await readFile((await (await pending).path())!, 'utf8')
  expect(csv.charCodeAt(0)).toBe(0xfeff)
  const rows = parseOrderCSV(csv)
  expect(rows).toHaveLength(2); expect(rows[1].slice(0, 4)).toEqual([CODES[0], CODES[0] + STYLES[0], NAMES[0], STYLES[0]])
  expect(csv).not.toContain(CODES[1]); expect(csv).not.toContain(CODES[2])
  const workbook = await xlsxDownload(page)
  expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['1-0.발주요청세부(Order Quantity 관련)', '2-0.원가계산서(TD 사전원가와 관련)', 'FA을지 누적용', '7-0.대시보드(최종 취합)', '7-1.초과 내역', '7-2.미종결 내역'])
  const order = workbook.worksheets[0], fa = workbook.getWorksheet('FA을지 누적용')!
  expect(order.getCell('A2').value).toBe(CODES[0]); expect(order.getCell('B2').result).toBe(CODES[0] + STYLES[0]); expect(order.getCell('D2').value).toBe(STYLES[0])
  expect(order.getCell('M2').value).toEqual({ formula: 'IF(O2="","",O2*J2)', result: 10000 }); expect(order.getCell('O2').value).toBe(1000)
  expect(order.getColumn(14).hidden).toBe(true); expect(order.getCell('N2').value).toBeNull()
  expect(order.getCell('A3').value).toBeNull()
  expect(fa.getRow(3).values).toEqual([, '지급일', '품의서 #', '업체명', '발주날짜', '프로젝트코드', '프로젝트+업체 코드', '스타일코드', 'ERP계정과목', '품목', '단가', '요척', '오더수량', '입고수량', '단위', '금액', 'VAT', '합계', '담당자', '산출근거', '분할 결제', '결제 상태'])
  expect(fa.getCell('O4').formula).toBe('M4*J4'); expect(fa.getCell('O4').result).toBe(12000)
  expect(fa.getCell('P4').formula).toBe('O4*0.1'); expect(fa.getCell('Q4').formula).toBe('O4+P4'); expect(fa.getCell('Q4').result).toBe(13200)
  expect(fa.getCell('U4').value).toBe('미결제'); expect(fa.getCell('U4').dataValidation.formulae).toEqual(['"결제,미결제"'])
  expect(fa.getCell('E5').value).toBeNull()
  await page.getByRole('button', { name: '필터 초기화', exact: true }).click()
  await expect(page.getByRole('table', { name: '발주요청세부' }).locator('tbody tr')).toHaveCount(3)
})

for (const mobile of [false, true]) test(`FA팀은 예산 전용 화면과 동일한 집계만 읽으며 생산·결제 편집에 접근하지 않는다 · ${mobile ? '모바일' : 'PC'}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  await payFirst(page)
  const before = await snapshot(page)
  await page.getByLabel('체험 역할', { exact: true }).selectOption(FINANCE)
  const portal = page.getByRole('main', { name: 'FA팀 예산·을지 전용', exact: true })
  await expect(portal).toBeVisible()
  await expect(page.getByRole('navigation', { name: '주 메뉴' })).toHaveCount(0)
  await expect(page.getByLabel('전체 스타일 검색', { exact: true })).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(PRIVATE)
  await expect(portal.getByRole('article', { name: '지출 합계', exact: true }).locator('strong')).toHaveText('12,000원')
  await page.screenshot({ path: mobile ? '/tmp/sig-budget-fa-mobile.png' : '/tmp/sig-budget-fa-pc.png', fullPage: true })
  await expect(portal.getByRole('button', { name: '예산 한도 설정', exact: true })).toHaveCount(0)
  await tab(page, '원가계산서'); await expect(page.getByRole('button', { name: '원가 항목 등록', exact: true })).toHaveCount(0)
  await expect(page.getByRole('table', { name: '원가계산서' }).getByRole('button', { name: '수정', exact: true })).toHaveCount(0)
  await tab(page, 'FA을지 누적'); await expect(faRow(page, 0)).toContainText('결제')
  await expect(page.getByRole('table', { name: 'FA을지 누적' }).getByRole('combobox')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '상세 수정', exact: true })).toHaveCount(0)
  await tab(page, '초과 내역'); await expect(page.getByRole('button', { name: '사유 입력', exact: true })).toHaveCount(0)
  await page.goto(`/?style=${before.styles[0].id}&tab=po`)
  await expect(page.getByRole('main', { name: 'FA팀 예산·을지 전용', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(PRIVATE)
  await tab(page, 'FA을지 누적')
  const workbook = await xlsxDownload(page)
  expect(workbook.getWorksheet('FA을지 누적용')!.getCell('U4').value).toBe('결제')
  expect(await snapshot(page)).toEqual(before)
  if (mobile) await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('공장 계정에는 예산 메뉴가 없고 미승인·비활성 FA는 자료를 열람하지 못한다', async ({ page }) => {
  await fixture(page)
  await page.getByLabel('체험 역할', { exact: true }).selectOption(FACTORY)
  await expect(page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '예산·을지 누적', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '예산·을지 누적', exact: true })).toHaveCount(0)
  for (const [approved, active] of [[false, true], [true, false]]) {
    await page.evaluate(({ key, finance, approved, active }) => {
      const w = JSON.parse(localStorage.getItem(key)!) as Workspace, person = w.profiles.find(row => row.id === finance)!
      person.approved = approved; person.active = active
      localStorage.setItem(key, JSON.stringify(w)); localStorage.setItem('sig-demo-profile', finance)
    }, { key: STORAGE, finance: FINANCE, approved, active })
    await page.reload()
    await expect(page.getByRole('heading', { name: approved ? '계정이 비활성화되었습니다.' : '본사 승인을 기다리고 있습니다.', exact: true })).toBeVisible()
    await expect(page.getByRole('main', { name: 'FA팀 예산·을지 전용' })).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText(CODES[0])
  }
})

test('동시 수정으로 버전이 바뀌면 원가 입력을 보존하고 덮어쓰기를 차단한다', async ({ page }) => {
  await fixture(page)
  await tab(page, '원가계산서')
  const row = page.getByRole('table', { name: '원가계산서', exact: true }).locator('tbody tr').filter({ hasText: STYLES[0] })
  await row.getByRole('button', { name: '수정', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '원가 항목 등록·수정', exact: true })
  await dialog.getByLabel('원가 금액', { exact: true }).fill('12500')
  await dialog.getByLabel('예산 변경 사유', { exact: true }).fill('QA 작성 중인 금액')
  await page.evaluate(key => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace, record = w.budgetRecords!.find(row => row.kind === 'cost')!
    record.version += 1; if (record.kind === 'cost') record.data.amount = 10500
    localStorage.setItem(key, JSON.stringify(w)); window.dispatchEvent(new Event('sig-workspace-change'))
  }, STORAGE)
  await expect(dialog.getByRole('alert')).toContainText('다른 사용자가 기록 또는 연결 금액을 변경했습니다.')
  await expect(dialog.getByLabel('원가 금액', { exact: true })).toHaveValue('12500')
  await expect(dialog.getByRole('button', { name: '변경 저장', exact: true })).toBeDisabled()
  expect((await snapshot(page)).budgetRecords?.filter(record => record.kind === 'cost')[0].data.amount).toBe(10500)
})


test('저장 설정이 미적용이면 원가·한도·결제 편집을 비활성화하고 성공으로 기록하지 않는다', async ({ page }) => {
  await fixture(page)
  await page.evaluate(key => { const w = JSON.parse(localStorage.getItem(key)!) as Workspace; w.budgetAvailable = false; localStorage.setItem(key, JSON.stringify(w)) }, STORAGE)
  await page.reload(); await menu(page)
  const before = await snapshot(page)
  await expect(page.getByRole('status')).toContainText('저장 설정이 아직 적용되지 않았습니다.')
  await expect(page.getByRole('button', { name: '예산 한도 설정', exact: true })).toBeDisabled()
  await tab(page, '원가계산서'); await expect(page.getByRole('button', { name: '원가 항목 등록', exact: true })).toBeDisabled()
  await tab(page, 'FA을지 누적'); await expect(faRow(page, 0).getByRole('combobox')).toBeDisabled()
  expect(await snapshot(page)).toEqual(before)
})

test('새 오더 업로드의 브랜드·발주일·JOOR·ADER 수량이 예산 발주요청세부와 Excel에 자동 연결된다', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  const factoryName = await page.evaluate(({ key, code, projectId, projectName, sku }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace, style = structuredClone(w.styles[1]), line = structuredClone(w.styles[1].production[0])
    style.code = sku; style.projectId = projectId; style.season = '2027FY'; style.colors = ['BK']; style.stage = 'production'; style.samples = []
    line.color = 'BK'; line.order = { XXS: 0, XS: 0, S: 0, M: 0, L: 0, XL: 0 }; line.received = { ...line.order }; line.shipped = { ...line.order }; style.production = [line]
    w.styles = [style]; w.projects = [{ id: projectId, name: projectName, code, season: '2027FY' }]
    w.productionRuns = []; w.productionReceipts = []; w.productionRunAudits = []; w.productionConditions = []; w.productionPoContexts = []
    w.budgetAvailable = true; w.budgetOrderMetadataAvailable = true; w.budgetRecords = []; delete w.budgetSources
    w.operations!.orderSourceRecords = []; w.operations!.poDispatches = []; w.operations!.poDispatchAttempts = []
    localStorage.setItem(key, JSON.stringify(w))
    return w.factories.find(factory => factory.id === style.factoryId)!.name
  }, { key: STORAGE, code: CODES[0], projectId: IDS[0], projectName: NAMES[0], sku: STYLES[0] })
  await page.reload(); await menu(page, '메인 생산')
  await page.getByRole('button', { name: '오더 엑셀 업로드', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Excel 오더 수량 가져오기', exact: true })
  const headers = Array<string>(153).fill(''), values = Array<string>(153).fill('')
  for (const [index, label, value] of [[0, '프로젝트 코드', CODES[0]], [5, '스타일코드', STYLES[0]], [10, '브랜드', 'SIGNIFICANT'], [11, '년도/시즌', '2027FY'], [12, '프로젝트 명칭', NAMES[0]], [18, '발주 요청일', '2026-11-01'], [22, '생산처', factoryName], [24, '생산 담당자', 'admin@example.test'], [50, 'TOTAL QTY', '21'], [59, 'JOOR GB', '6'], [77, 'ADER KOR', '15']] as const) { headers[index] = label; values[index] = value }
  ;[1, 2, 3, 4, 5, 6].forEach((quantity, index) => { headers[42 + index] = `TTL ${index + 1}`; values[42 + index] = String(quantity) })
  const cell = (value: string) => `"${value.replaceAll('"', '""')}"`
  const buffer = Buffer.from('\uFEFF' + [headers, values].map(row => row.map(cell).join(',')).join('\r\n'))
  await dialog.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name: 'QA-BUDGET-ORDER.csv', mimeType: 'text/csv', buffer })
  await expect(dialog.getByRole('heading', { name: '적용 전 미리보기', exact: true })).toBeVisible()
  await dialog.getByLabel('오더 변경 사유', { exact: true }).fill('QA 예산 참조 열 자동 연결')
  await dialog.getByRole('button', { name: '검증된 오더 적용', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
  await dialog.getByLabel('닫기', { exact: true }).click()
  await menu(page); await tab(page, '발주요청세부')
  const row = orderRow(page, 0)
  await expect(row.locator('td').nth(4)).toHaveText('SIGNIFICANT')
  await expect(row.locator('td').nth(8)).toHaveText('2026-11-01')
  await expect(row.locator('td').nth(9)).toHaveText('21')
  await expect(row.locator('td').nth(10)).toHaveText('6')
  await expect(row.locator('td').nth(11)).toHaveText('15')
  const workbook = await xlsxDownload(page), order = workbook.worksheets[0]
  expect(order.getCell('B2').result).toBe(CODES[0] + STYLES[0])
  expect(order.getCell('K2').value).toBe(6); expect(order.getCell('L2').value).toBe(15)
})
