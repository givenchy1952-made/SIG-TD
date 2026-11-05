import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { Workspace } from '../src/lib/types'
import { parseOrderCSV } from '../src/lib/order-import'

const STORAGE = 'sig-workspace-demo-v1', ADMIN = '10000000-0000-4000-8000-000000000001', FACTORY = '10000000-0000-4000-8000-000000000004'
const PROJECT_A = '98910000-0000-4000-8000-000000000001', PROJECT_B = '98910000-0000-4000-8000-000000000002'
const NAME_A = 'CEO 보고 프로젝트 A', NAME_B = '=CEO 보고 프로젝트 B', BUDGET = 'SIGNIFICANT-2026FY-RPQ-99991'
const UNKNOWN = '98910000-0000-4000-8000-000000000003'
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function navigate(page: Page, name: string) {
  const mobileMenu = page.getByRole('button', { name: '메뉴 열기', exact: true })
  if (await mobileMenu.isVisible()) await mobileMenu.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name, exact: true }).click()
}
async function openReceiptStatus(page: Page) {
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await expect(page.getByRole('region', { name: '입고현황', exact: true })).toHaveCount(0)
  await navigate(page, '입고현황')
  const report = page.getByRole('region', { name: '입고현황', exact: true })
  await expect(report.getByRole('heading', { name: '입고현황', level: 1, exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toHaveCount(0)
  await expect(page.getByText(/보고 범위/)).toHaveCount(0)
  await expect(page.locator('.breadcrumb strong')).toHaveText('입고현황')
  return report
}
async function fixture(page: Page) {
  await page.clock.setFixedTime(new Date('2026-11-05T03:00:00Z'))
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { executiveCopied: string }).executiveCopied = text } } })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, admin, projectA, projectB, nameA, nameB, budget, unknown }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace, original = w.styles[1], now = '2026-11-05T03:00:00Z'
    const korea = w.factories.find(factory => factory.country === '대한민국')!, vietnam = w.factories.find(factory => factory.country === '베트남')!, china = w.factories.find(factory => factory.country === '중국')!
    korea.country = 'KR'; vietnam.country = 'Vietnam'
    w.factories.push({ id: unknown, name: 'QA 생산국 확인 공장', country: '', serviceType: 'production' })
    w.projects = [{ id: projectA, name: nameA, code: budget, season: '2026FY' }, { id: projectB, name: nameB, code: 'SIGNIFICANT-2027FY-RPQ-99992', season: '2027FY' }]
    const zero = { XXS: 0, XS: 0, S: 0, M: 0, L: 0, XL: 0 }
    const factories = [korea.id, vietnam.id, china.id, unknown, korea.id], quantities = [25, 200, 40, 10, 5], received = [20, 50, 0, 0, 0], dates = ['2026-11-20', '2026-12-20', '2027-03-15', '2027-01-15', '']
    w.styles = quantities.map((quantity, index) => {
      const style = structuredClone(original), line = structuredClone(original.production[0])
      style.id = crypto.randomUUID(); style.code = `QAEXECUTIVE${index + 1}`; style.name = '경영 보고 실제 수량 검증'; style.stage = 'production'; style.samples = []; style.projectId = index === 1 || index === 4 ? projectB : projectA
      style.season = index === 1 || index === 4 ? '2027FY' : '2026FY'; style.factoryId = factories[index]; style.colors = ['BK']; style.dueDate = dates[index]; style.notes = '본사 보고용 원본 보존 검증'
      line.id = crypto.randomUUID(); line.color = 'BK'; line.order = { ...zero, M: quantity }; line.received = { ...zero, M: received[index] }; line.shipped = { ...zero, M: received[index] }; line.receivedAt = received[index] ? '2026-11-02' : ''; style.production = [line]; return style
    })
    const run = (styleIndex: number, quantity: number, round: number, expectedDue: string) => {
      const style = w.styles[styleIndex], line = style.production[0]
      return { id: crypto.randomUUID(), styleId: style.id, lineId: line.id, name: `경영 보고 ${round}차`, projectId: style.projectId, projectCode: w.projects.find(project => project.id === style.projectId)!.code!, expectedDue, poId: null, unitCost: null, itemType: 'product' as const, order: { ...zero, M: quantity }, correctsRunId: null, round, version: 1, createdAt: now, updatedAt: now, updatedBy: admin, closedAt: null, snapshot: null, factoryIdSnapshot: style.factoryId, factoryNameSnapshot: w.factories.find(factory => factory.id === style.factoryId)!.name, ownerIdSnapshot: admin, ownerNameSnapshot: 'QA 본사', styleCodeSnapshot: style.code }
    }
    // Same SKU's 100-piece original and 25-piece reorder are separate even
    // though its current parent line contains only the latest 25-piece order.
    w.productionRuns = [run(0, 100, 1, '2026-11-20'), run(0, 25, 2, '2027-02-15'), run(1, 200, 1, '2026-12-20')]
    w.productionReceipts = [[0, 20], [2, 50]].map(([index, quantity]) => {
      const source = w.productionRuns![index]
      return { id: crypto.randomUUID(), runId: source.id, styleId: source.styleId, lineId: source.lineId, receivedAt: '2026-11-02', quantities: { ...zero, M: quantity }, unitCost: 1, netAmount: quantity, voided: false, version: 1, createdAt: now, createdBy: admin }
    })
    w.partialDeliveryPlans = [{ runId: w.productionRuns[0].id, version: 1, updatedAt: now, updatedBy: admin, items: [{ id: crypto.randomUUID(), dueDate: '2026-11-20', quantity: 70, quantities: { ...zero, M: 70 }, note: '첫 부분 납기' }, { id: crypto.randomUUID(), dueDate: '2026-12-10', quantity: 30, quantities: { ...zero, M: 30 }, note: '두 번째 부분 납기' }] }]
    w.productionConditions = [{ runId: w.productionRuns[0].id, runVersion: 1, poVersion: null, version: 1, productionMode: 'full_package', status: 'approved', legacy: true, internalUnitCost: null, proposal: null, approval: null, timeline: [], changeRequests: [] }]
    w.supplierProductionOrders = []; w.productionRunAudits = []; w.productionPoContexts = []; w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []
    w.processingUnitPrices = []; w.productionDetails = []; w.materialReviewItems = []; w.materialReviewRounds = []
    w.operations!.poDispatches = []; w.operations!.poDispatchAttempts = []; w.operations!.shipmentLedgers = []; w.operations!.shipmentBatches = []; w.operations!.styleOperations = []; w.operations!.orderSourceRecords = []
    localStorage.setItem(key, JSON.stringify(w)); localStorage.setItem('sig-demo-profile', admin)
  }, { key: STORAGE, admin: ADMIN, projectA: PROJECT_A, projectB: PROJECT_B, nameA: NAME_A, nameB: NAME_B, budget: BUDGET, unknown: UNKNOWN })
  await page.reload()
  const report = await openReceiptStatus(page)
  await expect(report.getByLabel('입고현황 시작 월', { exact: true })).toHaveValue('2026-11')
  await expect(report.getByLabel('입고현황 종료 월', { exact: true })).toHaveValue('2027-03')
  return report
}

for (const mobile of [false, true]) test(`별도 입고현황은 월별 예정·실적과 국내·해외·생산국을 구분하며 리오더를 중복 합산하지 않는다 · ${mobile ? '모바일' : 'PC'}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  const report = await fixture(page), before = await snapshot(page)
  await expect(report.getByRole('article', { name: '조회 기간 입고 예정', exact: true }).locator('strong')).toHaveText('305장')
  await expect(report.getByRole('article', { name: '조회 기간 입고 실적', exact: true }).locator('strong')).toHaveText('70장')
  await expect(report.getByRole('article', { name: '현재 생산 중', exact: true }).locator('strong')).toHaveText('80장')
  await expect(report.getByRole('article', { name: '현재 생산 대기', exact: true }).locator('strong')).toHaveText('175장')
  const november = report.getByRole('article', { name: '2026년 11월 입고 현황', exact: true })
  await expect(november).toContainText('국내 50장 · 해외 0장')
  await expect(report.getByRole('article', { name: '2027년 2월 입고 현황', exact: true })).toContainText('25')
  await expect(report.getByRole('article', { name: '대한민국 생산 현황', exact: true })).toContainText('110')
  await expect(report.getByRole('article', { name: '베트남 생산 현황', exact: true })).toContainText('150')
  await expect(report.getByRole('article', { name: '중국 생산 현황', exact: true })).toContainText('40')
  await expect(report.getByRole('article', { name: '국가 미지정 생산 현황', exact: true })).toContainText('10')
  await expect(report).toContainText('납기일 미등록 예정 5장')
  await expect(report).toContainText('생산 시작 상태 확인이 필요한 잔량 55장')
  await report.screenshot({ path: mobile ? '/tmp/sig-executive-mobile.png' : '/tmp/sig-executive-pc.png' })
  await report.getByText('월별 계획·예정·실적 상세', { exact: true }).click()
  const table = report.getByRole('table', { name: '월별 생산 입고 상세', exact: true })
  await expect(table.locator('tbody tr').first().locator('th,td')).toHaveText(['2026.11', '70', '50', '50', '0', '0', '70'])
  await expect(table.locator('tbody tr').nth(3).locator('th,td')).toHaveText(['2027.02', '25', '25', '25', '0', '0', '0'])
  await expect(table.locator('tfoot tr').locator('th,td')).toHaveText(['합계', '375', '305', '105', '190', '10', '70'])
  await report.getByRole('button', { name: '현황 복사', exact: true }).click()
  const copied = await page.evaluate(() => (window as unknown as { executiveCopied: string }).executiveCopied)
  expect(copied).toContain('SIG 입고현황 (2026-11-05 기준)')
  expect(copied).toContain('기간 입고 예정(잔량): 305장')
  expect(copied).toContain('현재 미입고 잔량: 310장')
  expect(copied).toContain('납기일 미등록 입고 예정 5장')
  expect(copied).not.toContain(BUDGET)
  expect(copied).not.toContain('보고 범위')
  const download = page.waitForEvent('download')
  await report.getByRole('button', { name: 'CSV 다운로드', exact: true }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^SIG_입고현황_/)
  const content = await readFile((await file.path())!, 'utf8')
  expect(content).not.toContain('보고 범위')
  expect(content.charCodeAt(0)).toBe(0xfeff)
  const rows = parseOrderCSV(content), headers = rows[0].map(String)
  expect(headers).toContain('입고 예정 잔량'); expect(headers).toContain('현재 미입고 잔량')
  const summary = rows.find(row => row[0] === '전체 요약')!
  expect(summary[headers.indexOf('입고 예정 잔량')]).toBe('305')
  expect(summary[headers.indexOf('입고 실적')]).toBe('70')
  expect(summary[headers.indexOf('현재 미입고 잔량')]).toBe('310')
  expect(content).toContain('납기일 미등록 입고 예정 5장')
  expect(content).not.toContain(BUDGET)
  expect(await snapshot(page)).toEqual(before)
  if (mobile) await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('입고현황 프로젝트·시즌 필터와 다운로드는 같은 범위이며 오버뷰 검색과 분리된다', async ({ page }) => {
  const report = await fixture(page), before = await snapshot(page)
  await navigate(page, '오버뷰')
  await expect(page.getByRole('region', { name: '입고현황', exact: true })).toHaveCount(0)
  await page.getByLabel('스타일 검색', { exact: true }).fill('검색 결과가 없는 품번')
  await openReceiptStatus(page)
  await expect(report.getByRole('article', { name: '조회 기간 입고 예정', exact: true }).locator('strong')).toHaveText('305장')
  await report.getByRole('button', { name: '입고현황 프로젝트 명칭', exact: true }).click()
  let filter = page.getByRole('dialog', { name: '입고현황 프로젝트 명칭 선택', exact: true })
  await filter.getByRole('button', { name: '선택해제', exact: true }).click()
  await filter.getByRole('checkbox', { name: NAME_B, exact: true }).check()
  await page.keyboard.press('Escape')
  await expect(report.getByRole('article', { name: '조회 기간 입고 예정', exact: true }).locator('strong')).toHaveText('150장')
  await expect(report.getByLabel('선택한 입고현황 조건', { exact: true })).toContainText(NAME_B)
  await report.getByRole('button', { name: '입고현황 시즌', exact: true }).click()
  filter = page.getByRole('dialog', { name: '입고현황 시즌 선택', exact: true })
  await filter.getByRole('button', { name: '선택해제', exact: true }).click(); await filter.getByRole('checkbox', { name: '2026FY', exact: true }).check(); await page.keyboard.press('Escape')
  await expect(report.getByRole('article', { name: '조회 기간 입고 예정', exact: true }).locator('strong')).toHaveText('0장')
  await report.getByRole('button', { name: '입고현황 시즌', exact: true }).click(); filter = page.getByRole('dialog', { name: '입고현황 시즌 선택', exact: true }); await filter.getByRole('button', { name: '전체보기', exact: true }).click(); await page.keyboard.press('Escape')
  const download = page.waitForEvent('download')
  await report.getByRole('button', { name: 'CSV 다운로드', exact: true }).click()
  const content = await readFile((await (await download).path())!, 'utf8')
  expect(content).toContain("'=CEO 보고 프로젝트 B")
  expect(content).not.toContain(NAME_A); expect(content).not.toContain(BUDGET)
  const rows = parseOrderCSV(content), headers = rows[0].map(String), summary = rows.find(row => row[0] === '전체 요약')!
  expect(summary[headers.indexOf('입고 예정 잔량')]).toBe('150')
  expect(summary[headers.indexOf('현재 미입고 잔량')]).toBe('155')
  await report.getByRole('button', { name: '필터 초기화', exact: true }).click()
  await expect(report.getByRole('article', { name: '조회 기간 입고 예정', exact: true }).locator('strong')).toHaveText('305장')
  expect(await snapshot(page)).toEqual(before)
})

test('미배분 누적 입고는 실적에 중복 합산하지 않고 화면·현황 복사·CSV에 확인 필요 수량을 표시한다', async ({ page }) => {
  await fixture(page)
  await page.evaluate(key => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    w.styles[0].production[0].received.M = 35
    localStorage.setItem(key, JSON.stringify(w))
  }, STORAGE)
  await page.reload()
  const report = await openReceiptStatus(page), before = await snapshot(page)
  await expect(report.getByRole('status')).toContainText('차수 배분 확인 필요 15장')
  await expect(report.getByRole('article', { name: '조회 기간 입고 실적', exact: true }).locator('strong')).toHaveText('70장')
  await report.getByRole('button', { name: '현황 복사', exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { executiveCopied: string }).executiveCopied)).toContain('차수 배분 확인 필요 15장')
  const download = page.waitForEvent('download'); await report.getByRole('button', { name: 'CSV 다운로드', exact: true }).click()
  expect(await readFile((await (await download).path())!, 'utf8')).toContain('차수 배분 확인 필요 15장')
  expect(await snapshot(page)).toEqual(before)
})

test('잘못된 조회 기간은 출력을 차단하고 외부 공장 계정은 입고현황 메뉴와 화면을 볼 수 없다', async ({ page }) => {
  const report = await fixture(page)
  await report.getByLabel('입고현황 종료 월', { exact: true }).fill('2026-10')
  await expect(report.getByRole('alert')).toContainText('조회 시작·종료 월')
  await expect(report.getByRole('button', { name: 'CSV 다운로드', exact: true })).toBeDisabled()
  await expect(report.getByRole('button', { name: '현황 복사', exact: true })).toBeDisabled()
  await report.getByRole('button', { name: '필터 초기화', exact: true }).click()
  await expect(report.getByRole('button', { name: 'CSV 다운로드', exact: true })).toBeEnabled()
  await page.getByLabel('체험 역할', { exact: true }).selectOption(FACTORY)
  await expect(page.getByRole('region', { name: '입고현황', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'CSV 다운로드', exact: true })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '입고현황', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await expect(page.locator('.breadcrumb strong')).toHaveText('오버뷰')
  await page.getByLabel('체험 역할', { exact: true }).selectOption(ADMIN)
  await openReceiptStatus(page)
})
