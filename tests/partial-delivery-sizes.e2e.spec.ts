import { test, expect, type Locator, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'
import { configureProductionConditionsInWorkspace, getDemoProductionConditions, getProductionCondition, submitProductionConditionsInWorkspace } from '../src/lib/production-conditions'
import { createProductionOrderPoInWorkspace, getDemoSupplierProductionOrders } from '../src/lib/supplier-orders'

const STORAGE = 'sig-workspace-demo-v1', CODE = 'QAPARTIAL01'
const ADMIN = '10000000-0000-4000-8000-000000000001', FACTORY = '10000000-0000-4000-8000-000000000004'
const RUN = '98800000-0000-4000-8000-000000000001'
const FIRST = '98800000-0000-4000-8000-000000000002', SECOND = '98800000-0000-4000-8000-000000000003'
const SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL'] as const
const ONE = [1, 1, 2, 2, 3, 3], TWO = [1, 2, 2, 3, 3, 4]
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page, mode: 'new' | 'legacy' | 'missing' | 'frozen' = 'new') {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, code, runId, first, second, admin, supplier, mode }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    const style = w.styles[1], factory = w.profiles.find(person => person.id === supplier)!
    const project = w.projects[0], now = '2026-10-31T01:00:00.000Z'
    project.name = '시그니피컨트 2026 3Q'; project.code = 'SIGNIFICANT-2026FY-MPQ-46093'; project.season = '2026FY'
    style.code = code; style.name = 'QA 사이즈별 부분 납기'; style.factoryId = factory.factoryId!; style.projectId = project.id; style.stage = 'production'; style.samples = []
    style.production = [style.production[0]]; style.production[0].color = 'BK'; style.colors = ['BK']
    const order = { XXS: 2, XS: 3, S: 4, M: 5, L: 6, XL: 7 }
    const factoryName = w.factories.find(item => item.id === factory.factoryId)!.name
    w.styles = [style]; w.comments = []; w.audits = []; w.attachments = []; w.styleImages = []
    w.partialDeliveryAvailable = true; w.partialDeliverySizesAvailable = mode !== 'missing'
    w.productionRuns = [{ id: runId, styleId: style.id, lineId: style.production[0].id, projectId: project.id, projectCode: project.code, expectedDue: '2026-12-20', name: '부분 납기 생산', poId: null, unitCost: null, itemType: 'product', order, correctsRunId: null, round: 1, version: 1, createdAt: now, updatedAt: now, updatedBy: admin, closedAt: null, snapshot: null, factoryIdSnapshot: style.factoryId, factoryNameSnapshot: factoryName, ownerIdSnapshot: style.ownerId, ownerNameSnapshot: 'QA 본사', styleCodeSnapshot: `${code}BK` }]
    w.productionReceipts = []; w.productionRunAudits = []; w.productionConditions = []; w.supplierProductionOrders = []; w.productionPoContexts = []
    w.operations!.poDispatches = []; w.operations!.poDispatchAttempts = []; w.operations!.shipmentBatches = []; w.operations!.shipmentLedgers = []; w.operations!.styleOperations = []; w.operations!.orderSourceRecords = []
    w.partialDeliveryPlans = mode === 'new' ? [] : [{ runId, version: 2, updatedAt: now, updatedBy: admin, items: [{ id: first, dueDate: '2026-12-10', quantity: 12, note: '기존 1차 총수량' }, { id: second, dueDate: '2026-12-20', quantity: 15, note: '기존 2차 총수량' }] }]
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, code: CODE, runId: RUN, first: FIRST, second: SECOND, admin: ADMIN, supplier: FACTORY, mode })
  // Persist the same derived baseline that the demo repository uses. Keeping
  // raw [] here would confuse normal view initialization with a business change.
  let ready = await snapshot(page)
  ready.supplierProductionOrders = getDemoSupplierProductionOrders(ready)
  ready.productionConditions = getDemoProductionConditions(ready)
  if (mode === 'frozen') {
    const admin = ready.profiles.find(person => person.id === ADMIN)!, supplier = ready.profiles.find(person => person.id === FACTORY)!
    ready = configureProductionConditionsInWorkspace(ready, admin, RUN, 1, 0, 'full_package', 100, 'QA 부분 납기 생산 방식 설정')
    const poId = '98800000-0000-4000-8000-000000000004'
    ready = createProductionOrderPoInWorkspace(ready, admin, RUN, ready.productionRuns![0].version, poId, { dueDate: '2026-12-20', recipient: supplier.email, subject: '[PO] 시그니피컨트 2026 3Q', body: '시그니피컨트 2026 3Q 부분 납기 및 수량 확인 요청', evidenceAttachmentId: null, voided: false }, 'QA 부분 납기 발주 연결')
    // Provider acceptance is a local fixture only; no email request is made.
    const po = ready.operations!.poDispatches.find(item => item.id === poId)!
    po.status = 'sent'; po.sentAt = '2026-10-31T02:00:00.000Z'; po.providerMessageId = 'qa-local-partial-sent'; po.attempts = 1; po.version += 1
    ready.supplierProductionOrders = getDemoSupplierProductionOrders(ready)
    ready.productionConditions = getDemoProductionConditions(ready)
    ready = submitProductionConditionsInWorkspace(ready, supplier, RUN, ready.productionRuns![0].version, po.version, getProductionCondition(ready, RUN).version, { expectedDeliveryDate: '2026-12-20', unitCost: 100, canProduce: true, quantityConfirmed: true, agreed: true, comment: 'QA 업체가 부분 납기와 사이즈별 오더 확인', delayReason: '', priceReason: '', confirmedQuantities: { ...ready.productionRuns![0].order } })
    ready.supplierProductionOrders = getDemoSupplierProductionOrders(ready)
    ready.productionConditions = getDemoProductionConditions(ready)
  }
  await page.evaluate(({ key, workspace }) => localStorage.setItem(key, JSON.stringify(workspace)), { key: STORAGE, workspace: ready })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function open(page: Page) {
  await page.getByRole('button', { name: `${CODE}BK`, exact: true }).click()
  const detail = page.getByRole('dialog').filter({ has: page.getByRole('heading', { level: 1 }) })
  await detail.getByRole('tab', { name: /생산 조건 협의·승인/ }).click()
  const panel = detail.getByRole('region', { name: '분할 납기 계획', exact: true })
  await expect(panel).toBeVisible()
  return { detail, panel }
}
async function sizes(panel: Locator, installment: number, values: number[]) {
  for (const [i, size] of SIZES.entries()) await panel.getByLabel(`${installment}차 예정 수량 ${size}`, { exact: true }).fill(String(values[i]))
}
async function split(panel: Locator) {
  await panel.getByRole('button', { name: '부분 납기 등록', exact: true }).click()
  await panel.getByLabel('1차 납기일', { exact: true }).fill('2026-12-10')
  await sizes(panel, 1, ONE)
  await panel.getByRole('button', { name: '납기 차수 추가', exact: true }).click()
  await panel.getByLabel('2차 납기일', { exact: true }).fill('2026-12-20')
  await sizes(panel, 2, TWO)
  await panel.getByLabel('부분 납기 등록·변경 사유', { exact: true }).fill('QA 두 번의 납기별 사이즈 계획')
}
for (const mobile of [false, true]) test(`부분 납기를 XXS~XL 두 차수로 저장하고 공장은 읽기만 하며 실제 입고·오더를 보존한다 · ${mobile ? '모바일' : 'PC'}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  const before = await snapshot(page), { detail, panel } = await open(page)
  await split(panel)
  await expect(panel.getByLabel('1차 예정 수량 합계', { exact: true })).toHaveText('12')
  await expect(panel.getByLabel('2차 예정 수량 합계', { exact: true })).toHaveText('15')
  await expect(panel.getByRole('row', { name: '사이즈별 계획 합계', exact: true })).toContainText('27')
  await panel.getByRole('button', { name: '부분 납기 저장', exact: true }).click()
  await expect(panel.getByRole('button', { name: '부분 납기 수정', exact: true })).toBeVisible()
  let saved = await snapshot(page)
  expect(saved.partialDeliveryPlans![0]).toMatchObject({ runId: RUN, version: 1, items: [{ quantity: 12, quantities: { XXS: 1, XS: 1, S: 2, M: 2, L: 3, XL: 3 } }, { quantity: 15, quantities: { XXS: 1, XS: 2, S: 2, M: 3, L: 3, XL: 4 } }] })
  expect(saved.styles).toEqual(before.styles); expect(saved.productionRuns).toEqual(before.productionRuns); expect(saved.productionReceipts).toEqual(before.productionReceipts); expect(saved.operations).toEqual(before.operations); expect(saved.productionConditions).toEqual(before.productionConditions)
  if (mobile) await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await page.reload()
  const restored = await open(page)
  await expect(restored.panel.getByLabel('2차 예정 수량 합계', { exact: true })).toHaveText('15')
  await restored.detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await page.getByLabel('체험 역할', { exact: true }).selectOption(FACTORY)
  const external = await open(page)
  await expect(external.panel.getByRole('button', { name: /부분 납기 등록|부분 납기 수정/ })).toHaveCount(0)
  await expect(external.panel.getByRole('table', { name: '차수별 부분 납기 일정', exact: true })).toContainText('XXS')
  await expect(external.panel.getByLabel('2차 예정 수량 합계', { exact: true })).toHaveText('15')
  saved = await snapshot(page); expect(saved.partialDeliveryPlans![0].version).toBe(1)
})

test('부분 납기 총수량이 같아도 사이즈별 합계가 오더와 다르면 저장을 막는다', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page), { panel } = await open(page)
  await split(panel)
  await panel.getByLabel('2차 예정 수량 XS', { exact: true }).fill('3')
  await panel.getByLabel('2차 예정 수량 XL', { exact: true }).fill('3')
  await expect(panel).toContainText('총수량 일치')
  await expect(panel.getByRole('button', { name: '부분 납기 저장', exact: true })).toBeDisabled()
  await expect(panel.locator('.partial-delivery-difference')).toHaveCount(2)
  expect((await snapshot(page)).partialDeliveryPlans).toEqual(before.partialDeliveryPlans)
})

test('기존 총수량 계획의 사이즈는 미등록으로 보존하고 담당자가 모든 차수를 직접 배분한다', async ({ page }) => {
  await fixture(page, 'legacy')
  const { panel } = await open(page)
  const old = (await snapshot(page)).partialDeliveryPlans![0]
  await expect(panel).toContainText('사이즈별 수량은 미등록')
  await panel.getByRole('button', { name: '부분 납기 수정', exact: true }).click()
  await expect(panel.getByLabel('1차 예정 수량 XXS', { exact: true })).toHaveCount(0)
  expect((await snapshot(page)).partialDeliveryPlans![0]).toEqual(old)
  await panel.getByRole('button', { name: '1차 사이즈별 수량 입력', exact: true }).click()
  await expect(panel.getByLabel('1차 예정 수량 XXS', { exact: true })).toHaveValue('0')
  await sizes(panel, 1, ONE)
  await panel.getByLabel('부분 납기 등록·변경 사유', { exact: true }).fill('QA 기존 총수량을 실제 사이즈로 보완')
  await expect(panel.getByRole('button', { name: '부분 납기 저장', exact: true })).toBeDisabled()
  await panel.getByRole('button', { name: '2차 사이즈별 수량 입력', exact: true }).click()
  await sizes(panel, 2, TWO)
  await panel.getByRole('button', { name: '부분 납기 저장', exact: true }).click()
  const saved = (await snapshot(page)).partialDeliveryPlans![0]
  expect(saved.version).toBe(3)
  expect(saved.items.map(item => [item.id, item.quantity, item.dueDate, item.note])).toEqual(old.items.map(item => [item.id, item.quantity, item.dueDate, item.note]))
  expect(saved.items[1].quantities).toEqual({ XXS: 1, XS: 2, S: 2, M: 3, L: 3, XL: 4 })
})

test('부분 납기 편집 중 다른 사용자가 저장하면 작성값을 유지하고 오래된 저장과 닫기를 보호한다', async ({ page }) => {
  await fixture(page, 'legacy')
  const { detail, panel } = await open(page)
  await panel.getByRole('button', { name: '부분 납기 수정', exact: true }).click()
  await panel.getByLabel('1차 비고', { exact: true }).fill('QA 작성 중인 납기 메모')
  await page.evaluate(key => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    w.partialDeliveryPlans![0].version += 1
    localStorage.setItem(key, JSON.stringify(w)); window.dispatchEvent(new Event('sig-workspace-change'))
  }, STORAGE)
  await expect(panel).toContainText('생산 차수 또는 부분 납기 계획이 변경되었습니다.')
  await expect(panel.getByLabel('1차 비고', { exact: true })).toHaveValue('QA 작성 중인 납기 메모')
  await expect(panel.getByRole('button', { name: '부분 납기 저장', exact: true })).toBeDisabled()
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await expect(detail.getByRole('alertdialog')).toContainText('저장하지 않은 변경')
})

test('018 이전에도 기존 총수량 계획을 조회하고 사이즈별 입력 준비를 안내한다', async ({ page }) => {
  await fixture(page, 'missing')
  const { panel } = await open(page)
  await expect(panel).toContainText('추가 설정(018) 적용 후')
  await panel.getByRole('button', { name: '부분 납기 수정', exact: true }).click()
  await expect(panel.getByLabel('1차 수량', { exact: true })).toHaveValue('12')
  await expect(panel.getByLabel('1차 예정 수량 XXS', { exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '1차 사이즈별 수량 입력', exact: true })).toHaveCount(0)
  expect((await snapshot(page)).partialDeliveryPlans![0].items[0]).not.toHaveProperty('quantities')
})

test('업체 회신 이후의 기존 부분 납기 계획을 직접 수정하지 않는다', async ({ page }) => {
  await fixture(page, 'frozen')
  const before = await snapshot(page)
  expect(before.productionConditions![0]).toMatchObject({ status: 'awaiting_approval', proposal: { actorId: FACTORY, agreed: true } })
  expect(before.operations!.poDispatches[0]).toMatchObject({ status: 'sent', providerMessageId: 'qa-local-partial-sent' })
  const { panel } = await open(page)
  await expect(panel.getByRole('button', { name: '부분 납기 수정', exact: true })).toHaveCount(0)
  await expect(panel).toContainText('업체 생산 조건 회신 이후에는')
  const after = await snapshot(page)
  expect(after.partialDeliveryPlans).toEqual(before.partialDeliveryPlans)
  expect(after.productionConditions).toEqual(before.productionConditions)
  expect(after.productionRuns).toEqual(before.productionRuns)
  expect(after.operations).toEqual(before.operations)
})
