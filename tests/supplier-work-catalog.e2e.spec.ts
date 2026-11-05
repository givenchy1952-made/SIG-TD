import { expect, test, type Locator, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'
import type { StyleOperationKind } from '../src/lib/operations-types'

const STORAGE = 'sig-workspace-demo-v1', VENDOR = '98730000-0000-4000-8000-000000000001'
const CODES = ['QAVENDWORK01', 'QAVENDWORK02', 'QAVENDWORK03']
const WORK = 'QA 업체 공통 작업', OLD_SPEC = '처음 등록한 공통 사양', NEW_SPEC = '단가 인상 시 변경한 사양'
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page, kind: StyleOperationKind, ready = true) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, codes, vendor, kind, ready }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    const original = w.styles[1]
    w.factories.push({ id: vendor, name: 'QA 공통 작업 업체', country: '대한민국', active: true, serviceType: kind, serviceSettingsVersion: 1 })
    w.styles = codes.map(code => {
      const style = structuredClone(original), line = structuredClone(original.production[0])
      style.id = crypto.randomUUID(); style.code = code; style.name = '업체 공통 작업 검증'; style.stage = 'production'; style.samples = []; style.colors = ['BK']; style.notes = ''
      line.id = crypto.randomUUID(); line.color = 'BK'; line.order = { XXS: 0, XS: 0, S: 10, M: 0, L: 0, XL: 0 }; line.shipped = { ...line.order }; line.received = { ...line.order }; line.receivedAt = '2026-11-05'
      style.production = [line]; return style
    })
    w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []; w.productionDetails = []
    w.productionRuns = []; w.productionReceipts = []; w.productionRunAudits = []; w.productionConditions = []; w.supplierProductionOrders = []; w.productionPoContexts = []
    w.supplierWorkRates = []; w.supplierWorkRatesAvailable = ready; w.processingUnitPrices = []; w.processingPricesAvailable = true
    w.operations!.styleOperations = []; w.operations!.poDispatches = []; w.operations!.poDispatchAttempts = []; w.operations!.orderSourceRecords = []; w.operations!.shipmentLedgers = []; w.operations!.shipmentBatches = []
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, codes: CODES, vendor: VENDOR, kind, ready })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function open(page: Page, code: string, kind: StyleOperationKind) {
  await page.getByRole('button', { name: `${code}BK`, exact: true }).click()
  const detail = page.getByRole('dialog').filter({ has: page.getByRole('heading', { level: 1 }) })
  await detail.getByRole('tab', { name: /가공·품질 관리/ }).click()
  await detail.getByRole('tablist', { name: '스타일 추가 업무', exact: true }).getByRole('tab', { name: kind === 'label' ? /^라벨 관리/ : /^자수 관리/ }).click()
  return detail
}
async function close(detail: Locator) { await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click(); await expect(detail).not.toBeVisible() }
const label = (kind: StyleOperationKind) => kind === 'label' ? '라벨' : '자수'
const catalogLabel = (kind: StyleOperationKind) => kind === 'label' ? '라벨 종류' : '자수 작업'
async function chooseVendor(detail: Locator, kind: StyleOperationKind) { await detail.getByLabel(`${label(kind)} 담당 업체`, { exact: true }).selectOption(VENDOR) }
async function saveMaster(detail: Locator, kind: StyleOperationKind, cost: string, specification: string, editing = false) {
  const panel = detail.getByRole('region', { name: `${catalogLabel(kind)} 업체 공통 작업·단가`, exact: true })
  await panel.getByRole('button', { name: editing ? `${WORK} 공통 작업·단가 수정` : `${catalogLabel(kind)} 공통 등록`, exact: true }).click()
  await panel.getByLabel('업체 공통 작업명', { exact: true }).fill(WORK)
  await panel.getByLabel('업체 공통 작업 사양', { exact: true }).fill(specification)
  await panel.getByLabel('업체 공통 기본 단가', { exact: true }).fill(cost)
  await panel.getByLabel('업체 공통 작업 변경 사유', { exact: true }).fill('QA 업체 공통 기준 저장')
  await panel.getByRole('button', { name: '업체 공통 작업·단가 저장', exact: true }).click()
  await expect(panel.getByRole('button', { name: `${WORK} 공통 작업·단가 수정`, exact: true })).toBeVisible()
}
async function useWork(detail: Locator, kind: StyleOperationKind, specification: string) {
  await detail.getByRole('button', { name: `${label(kind)} 관리 시작`, exact: true }).click()
  await detail.getByLabel(`${kind === 'label' ? '라벨 종류' : '자수 작업명'} 1`, { exact: true }).selectOption({ label: WORK })
  await expect(detail.getByLabel(`${label(kind)} 사양 1`, { exact: true })).toHaveValue(specification)
  await detail.getByLabel(`${label(kind)} ${kind === 'label' ? '발주' : '요청'} 수량 1`, { exact: true }).fill('10')
  await detail.getByLabel(`${label(kind)} 변경 사유`, { exact: true }).fill('QA 저장된 업체 작업 선택')
  await detail.getByRole('button', { name: `${label(kind)} 내역 저장`, exact: true }).click()
  await expect(detail.getByRole('button', { name: `${label(kind)} 관리 수정`, exact: true })).toBeVisible()
}
function storedPrice(w: Workspace, code: string, kind: StyleOperationKind) {
  const style = w.styles.find(item => item.code === code)!, operation = w.operations!.styleOperations.find(item => item.styleId === style.id && item.kind === kind)!
  return w.processingUnitPrices!.find(price => price.styleId === style.id && price.lineId === style.production[0].id && price.kind === kind && price.itemKey === operation.rows[0].id)!
}

for (const [kind, mobile] of [['label', false], ['embroidery', false], ['label', true]] as const) test(`${kind === 'label' ? '라벨' : '자수'} 업체 작업을 한 번 등록해 여러 스타일에서 재사용하고 인상 전 단가·사양을 보존한다 · ${mobile ? '모바일' : 'PC'}`, async ({ page }) => {
  test.setTimeout(60000)
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page, kind)
  const before = await snapshot(page)
  let detail = await open(page, CODES[0], kind)
  await chooseVendor(detail, kind); await saveMaster(detail, kind, '100.25', OLD_SPEC); await useWork(detail, kind, OLD_SPEC)
  let w = await snapshot(page)
  expect(storedPrice(w, CODES[0], kind).unitCost).toBe(100.25)
  const original = structuredClone(w.operations!.styleOperations.find(item => item.styleId === w.styles[0].id && item.kind === kind)!)
  await close(detail); await page.reload()
  detail = await open(page, CODES[1], kind); await chooseVendor(detail, kind); await useWork(detail, kind, OLD_SPEC)
  w = await snapshot(page); expect(storedPrice(w, CODES[1], kind).unitCost).toBe(100.25)
  const overridden = kind === 'label' && !mobile
  if (overridden) {
    const prices = detail.getByRole('region', { name: '가공·품질 단가 관리', exact: true })
    await prices.getByLabel('단가 작업 구분', { exact: true }).selectOption(kind)
    const row = prices.locator('.processing-price-table tbody tr').first()
    await row.getByRole('button', { name: /단가 수정$/ }).click()
    await row.getByRole('spinbutton').fill('333')
    await prices.getByLabel('가공·품질 단가 변경 사유', { exact: true }).fill('QA 이 스타일의 단가만 별도 조정')
    await prices.getByRole('button', { name: '단가 저장', exact: true }).click()
  }
  await saveMaster(detail, kind, '200.5', NEW_SPEC, true)
  w = await snapshot(page)
  expect(storedPrice(w, CODES[0], kind).unitCost).toBe(100.25); expect(storedPrice(w, CODES[1], kind).unitCost).toBe(overridden ? 333 : 100.25)
  expect(w.operations!.styleOperations.find(item => item.id === original.id)).toEqual(original)
  await close(detail)
  detail = await open(page, CODES[2], kind); await chooseVendor(detail, kind); await useWork(detail, kind, NEW_SPEC)
  w = await snapshot(page)
  expect(storedPrice(w, CODES[2], kind).unitCost).toBe(200.5)
  expect(w.styles).toEqual(before.styles)
  expect(w.productionRuns).toEqual(before.productionRuns); expect(w.productionConditions).toEqual(before.productionConditions)
  if (mobile) await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('업체 공통 작업 설정 전에는 기존 공통 목록을 유지하고 업체 등록 성공으로 표시하지 않는다', async ({ page }) => {
  await fixture(page, 'label', false)
  const before = await snapshot(page), detail = await open(page, CODES[0], 'label')
  await expect(detail.getByLabel('라벨 담당 업체', { exact: true })).toBeDisabled()
  await expect(detail).toContainText('업체별 공통 작업·단가 설정을 준비 중')
  await expect(detail.getByRole('button', { name: '라벨 종류 공통 등록', exact: true })).toHaveCount(0)
  await expect(detail.getByRole('button', { name: '라벨 관리 시작', exact: true })).toBeEnabled()
  expect((await snapshot(page)).operations).toEqual(before.operations)
})
