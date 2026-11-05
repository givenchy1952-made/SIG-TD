import { expect, test, type Locator, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1'
const ADMIN = '10000000-0000-4000-8000-000000000001'
const ABLE = '98740000-0000-4000-8000-000000000001', KOTITI = '98740000-0000-4000-8000-000000000002'
const ABLE_USER = '98740000-0000-4000-8000-000000000003', KOTITI_USER = '98740000-0000-4000-8000-000000000004'
const PROJECT = '98740000-0000-4000-8000-000000000005'
const CODES = ['QAINSPECT01', 'QAINSPECT02']
const NAME = '시그니피컨트 검사 검증 프로젝트', BUDGET = 'SIGNIFICANT-2026FY-RPQ-99999'

async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page, ready = true, provider: 'able' | null = 'able') {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, able, kotiti, ableUser, kotitiUser, project, codes, name, budget, ready, provider, admin }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    const original = w.styles[1], actor = w.profiles.find(item => item.id === admin)!, now = new Date().toISOString()
    w.factories.push(
      { id: able, name: 'QA 에이블 검사', country: '대한민국', active: true, serviceType: 'inspection', inspectionProvider: provider, serviceSettingsVersion: 1 },
      { id: kotiti, name: 'QA KOTITI 검사', country: '대한민국', active: true, serviceType: 'inspection', inspectionProvider: 'kotiti', serviceSettingsVersion: 1 },
    )
    w.profiles.push(
      { ...actor, id: ableUser, name: 'QA 에이블 담당', email: 'able@example.test', role: 'factory', factoryId: able },
      { ...actor, id: kotitiUser, name: 'QA KOTITI 담당', email: 'kotiti@example.test', role: 'factory', factoryId: kotiti },
    )
    w.projects = [{ id: project, name, code: budget, season: '2026FY' }]
    w.styles = codes.map(code => {
      const style = structuredClone(original), line = structuredClone(original.production[0])
      style.id = crypto.randomUUID(); style.code = code; style.name = '검사 업체 접근 검증'; style.projectId = project; style.season = '2026FY'
      style.stage = 'production'; style.samples = []; style.colors = ['BK']; style.notes = '본사 내부 메모 노출 금지'
      line.id = crypto.randomUUID(); line.color = 'BK'; line.order = { XXS: 1, XS: 2, S: 3, M: 4, L: 5, XL: 6 }
      style.production = [line]; return style
    })
    w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []
    w.productionRuns = []; w.productionReceipts = []; w.productionRunAudits = []; w.productionConditions = []; w.supplierProductionOrders = []; w.productionPoContexts = []
    w.supplierWorkRates = []; w.supplierWorkRatesAvailable = true; w.processingUnitPrices = []; w.processingPricesAvailable = true
    w.refinementsAvailable = true; w.inspectionAssignmentsAvailable = ready
    w.inspectionAssignments = [{ styleId: w.styles[1].id, lineId: w.styles[1].production[0].id, provider: 'kotiti', version: 1, updatedAt: now, updatedBy: admin }]
    delete w.inspectionOrders
    w.productionDetails = w.styles.map(style => ({ styleId: style.id, lineId: style.production[0].id, quality: { category: '아우터', quantity: 21, status: 'todo', requestedAt: '2026-11-04', completedAt: '', note: '봉제·오염 확인 요청' }, measurements: { upper: [], lower: [] }, version: 1, createdAt: now, updatedAt: now, updatedBy: admin }))
    if (w.operations) { w.operations.styleOperations = []; w.operations.poDispatches = []; w.operations.poDispatchAttempts = []; w.operations.orderSourceRecords = []; w.operations.shipmentLedgers = []; w.operations.shipmentBatches = [] }
    localStorage.setItem(key, JSON.stringify(w)); localStorage.setItem('sig-demo-profile', admin)
  }, { key: STORAGE, able: ABLE, kotiti: KOTITI, ableUser: ABLE_USER, kotitiUser: KOTITI_USER, project: PROJECT, codes: CODES, name: NAME, budget: BUDGET, ready, provider, admin: ADMIN })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function role(page: Page, id: string) { await page.getByLabel('체험 역할', { exact: true }).selectOption(id) }
async function openQuality(page: Page, code = CODES[0]) {
  await page.getByRole('button', { name: `${code}BK`, exact: true }).click()
  const detail = page.getByRole('dialog').filter({ has: page.getByRole('heading', { level: 1 }) })
  await detail.getByRole('tab', { name: /가공·품질 관리/ }).click()
  await detail.getByRole('tablist', { name: '스타일 추가 업무', exact: true }).getByRole('tab', { name: /^품질 검사/ }).click()
  return detail
}
async function close(detail: Locator) { await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click(); await expect(detail).not.toBeVisible() }
async function assign(detail: Locator, provider: '에이블' | 'KOTITI' | '미지정') {
  const panel = detail.getByRole('region', { name: '품질 검사 업체 지정', exact: true })
  await panel.getByRole('button', { name: /^검사 업체 지정(?: 수정)?$/, exact: true }).click()
  await panel.getByLabel(`검사 업체 ${provider}`, { exact: true }).check()
  await panel.getByLabel('검사 업체 지정 사유', { exact: true }).fill(`QA 검사 업체 ${provider} 지정`)
  await panel.getByRole('button', { name: '검사 업체 지정 저장', exact: true }).click()
  await expect(panel.getByRole('button', { name: '검사 업체 지정 수정', exact: true })).toBeVisible()
}
async function portalHasNoInternalData(page: Page) {
  await expect(page.getByRole('main', { name: '검사 업체 전용 오더' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '주 메뉴' })).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(BUDGET)
  await expect(page.locator('body')).not.toContainText('본사 내부 메모 노출 금지')
  await expect(page.getByRole('button', { name: /PO|을지|스타일 등록|메인 생산|결제/ })).toHaveCount(0)
  await expect(page.locator('a[href*="style"], a[href*="po"], a[href*="source"]')).toHaveCount(0)
}

for (const mobile of [false, true]) test(`검사 업체 지정 전 비공개·업체 분리·기준 단가·지정 변경 접근 회수 · ${mobile ? '모바일' : 'PC'}`, async ({ page }) => {
  test.setTimeout(60000)
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  const before = await snapshot(page)
  await role(page, ABLE_USER)
  await expect(page.getByRole('region', { name: '지정된 검사 오더 없음' })).toBeVisible()
  await portalHasNoInternalData(page)
  await role(page, ADMIN)
  let detail = await openQuality(page)
  await assign(detail, '에이블'); await close(detail)
  await role(page, ABLE_USER)
  const order = page.getByRole('article', { name: `${CODES[0]} BK 검사 오더`, exact: true })
  await expect(order).toContainText(NAME); await expect(order).toContainText('21 pcs')
  await expect(page.getByRole('article', { name: `${CODES[1]} BK 검사 오더`, exact: true })).toHaveCount(0)
  await expect(order.getByRole('table')).toContainText('XXS'); await expect(order.getByRole('table')).toContainText('XL')
  await portalHasNoInternalData(page)
  const rates = page.getByRole('region', { name: '아우터 검사 기준 단가', exact: true })
  await rates.getByRole('button', { name: '검사 기준 단가 등록', exact: true }).click()
  await rates.getByLabel('검사 기준 단가', { exact: true }).fill('250.5')
  await rates.getByLabel('검사 기준 단가 변경 사유', { exact: true }).fill('QA 검사 기준 단가 최초 등록')
  await rates.getByRole('button', { name: '검사 기준 단가 저장', exact: true }).click()
  await expect(rates.getByRole('button', { name: '검사 기준 단가 수정', exact: true })).toBeVisible()
  let w = await snapshot(page)
  expect(w.supplierWorkRates).toHaveLength(1)
  expect(w.supplierWorkRates![0]).toMatchObject({ factoryId: ABLE, kind: 'quality', itemKey: '아우터', unitCost: 250.5 })
  expect(w.processingUnitPrices).toHaveLength(0)
  await page.goto(`/?style=${w.styles[0].id}&tab=po`)
  await portalHasNoInternalData(page)
  await expect(page.getByRole('article', { name: `${CODES[0]} BK 검사 오더`, exact: true })).toBeVisible()
  await role(page, KOTITI_USER)
  await expect(page.getByRole('article', { name: `${CODES[1]} BK 검사 오더`, exact: true })).toBeVisible()
  await expect(page.getByRole('article', { name: `${CODES[0]} BK 검사 오더`, exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '아우터 검사 기준 단가', exact: true })).toContainText('미입력')
  await expect(page.locator('body')).not.toContainText('250.5원')
  await role(page, ADMIN); detail = await openQuality(page)
  const assignment = detail.getByRole('region', { name: '품질 검사 업체 지정', exact: true })
  await assignment.getByLabel('검사 오더 단가 적용 사유', { exact: true }).fill('QA 현재 업체 기준 단가 확인')
  await assignment.getByRole('button', { name: '이 오더에 기준 단가 적용', exact: true }).click()
  await expect(assignment).toContainText('250.5원')
  w = await snapshot(page)
  expect(w.processingUnitPrices![0]).toMatchObject({ supplierFactoryId: ABLE, unitCost: 250.5 })
  await assign(detail, 'KOTITI'); await close(detail)
  await role(page, ABLE_USER)
  await expect(page.getByRole('region', { name: '지정된 검사 오더 없음' })).toBeVisible()
  await portalHasNoInternalData(page)
  await role(page, KOTITI_USER)
  await expect(page.getByRole('article')).toHaveCount(2)
  await role(page, ADMIN); detail = await openQuality(page); await assign(detail, '미지정'); await close(detail)
  await role(page, KOTITI_USER)
  await expect(page.getByRole('article')).toHaveCount(1)
  w = await snapshot(page)
  expect(w.styles).toEqual(before.styles); expect(w.productionDetails).toEqual(before.productionDetails)
  expect(w.productionRuns).toEqual(before.productionRuns); expect(w.productionConditions).toEqual(before.productionConditions)
  expect(w.processingUnitPrices![0].unitCost).toBe(250.5)
  if (mobile) await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('검사 업체 연결이 없거나 020 미적용이어도 생산 화면으로 돌아가지 않고 오더를 비공개한다', async ({ page }) => {
  await fixture(page, true, null)
  await role(page, ABLE_USER)
  await portalHasNoInternalData(page)
  await expect(page.getByRole('region', { name: '지정된 검사 오더 없음' })).toBeVisible()
  await expect(page.getByRole('region', { name: '검사 업체 기준 단가 관리' })).toHaveCount(0)
  await page.evaluate(key => { const w = JSON.parse(localStorage.getItem(key)!) as Workspace; w.inspectionAssignmentsAvailable = false; localStorage.setItem(key, JSON.stringify(w)) }, STORAGE)
  await page.reload()
  await portalHasNoInternalData(page)
  await expect(page.getByRole('heading', { name: '검사 오더 조회를 준비 중입니다.', exact: true })).toBeVisible()
  await expect(page.getByRole('article')).toHaveCount(0)
  await role(page, ADMIN)
  const detail = await openQuality(page)
  await expect(detail.getByRole('region', { name: '품질 검사 업체 지정', exact: true })).toContainText('검사 업체 지정 기능을 준비 중')
  await expect(detail.getByRole('button', { name: '검사 업체 지정', exact: true })).toHaveCount(0)
})

test('관리자는 기존 업체의 서비스 구분을 별도 저장하고 공장명 수정 후에도 검사 설정을 유지한다', async ({ page }) => {
  await fixture(page, true, null)
  const before = await snapshot(page)
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '사용자 · 기본 설정', exact: true }).click()
  await page.getByRole('button', { name: /^공장 관리/ }).click()
  await page.getByRole('button', { name: 'QA 에이블 검사 업체 서비스 설정', exact: true }).click()
  let modal = page.getByRole('dialog', { name: '업체 서비스 설정', exact: true })
  await modal.getByLabel('검사 업체 연결', { exact: true }).selectOption('able')
  await modal.getByLabel('업체 서비스 설정 변경 사유', { exact: true }).fill('QA 에이블 검사 전용 업체 연결')
  await modal.getByRole('button', { name: '서비스 설정 저장', exact: true }).click()
  await expect(modal).not.toBeVisible()
  await page.getByRole('button', { name: 'QA 에이블 검사 공장 정보 수정', exact: true }).click()
  modal = page.getByRole('dialog', { name: '공장 정보', exact: true })
  await modal.getByLabel('공장명', { exact: true }).fill('QA 에이블 검사 이름 수정')
  await modal.getByRole('button', { name: '변경 저장', exact: true }).click()
  await expect(modal).not.toBeVisible()
  const w = await snapshot(page)
  expect(w.factories.find(factory => factory.id === ABLE)).toMatchObject({ name: 'QA 에이블 검사 이름 수정', serviceType: 'inspection', inspectionProvider: 'able', serviceSettingsVersion: 2 })
  expect(w.styles).toEqual(before.styles); expect(w.profiles).toEqual(before.profiles)
})
