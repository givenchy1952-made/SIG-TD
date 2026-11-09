import { expect, test, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1', CODE = 'QASYNC0001'
const ADMIN = '10000000-0000-4000-8000-000000000001', FACTORY = '10000000-0000-4000-8000-000000000004'
const RUN = '99350000-0000-4000-8000-000000000001', SECOND_RUN = '99350000-0000-4000-8000-000000000002'
const quantity = { XXS: 0, XS: 0, S: 50, M: 50, L: 0, XL: 0 }
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page, options: { duplicateShipment?: boolean; legacyReceived?: boolean; multiple?: boolean } = {}) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, code, runId, secondRunId, quantities, options, adminId }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace, style = w.styles[1], original = style.production[0]
    const admin = w.profiles.find(person => person.id === adminId)!, factory = w.profiles.find(person => person.role === 'factory' && person.approved && person.active)!
    const now = '2026-11-01T00:00:00Z', zero = { XXS: 0, XS: 0, S: 0, M: 0, L: 0, XL: 0 }
    style.code = code; style.name = 'QA 출입고 단일 입력'; style.factoryId = factory.factoryId!; style.ownerId = ''; style.stage = 'production'; style.samples = []; style.colors = ['BK', 'GR']
    style.production = ['BK', 'GR'].map((color, index) => ({ ...structuredClone(original), id: `99351000-0000-4000-8000-00000000000${index + 1}`, color, ownerId: '', order: { ...quantities }, shipped: { ...zero }, received: { ...zero }, shippedAt: '', receivedAt: '' }))
    const line = style.production[1], project = w.projects.find(item => item.id === style.projectId)!
    project.code = 'QA-SYNC-PROJECT'; project.name = 'QA 입고 자동 연결 프로젝트'
    if (options.duplicateShipment) { line.shipped = { ...zero, S: 100, M: 100 }; line.shippedAt = '2026-11-01' }
    if (options.legacyReceived) { line.received = { ...quantities }; line.receivedAt = '2026-11-01' }
    w.styles = [style]; w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []; w.productionReceipts = []; w.productionRunAudits = []; w.shipmentAdjustments = []; w.productionMovementRequests = []
    w.mainProductionSyncAvailable = true; w.productionLedgerAvailable = true; w.supplierOrdersAvailable = true; w.productionConditionsAvailable = true
    w.operations!.poDispatches = []; w.operations!.shipmentLedgers = []; w.operations!.shipmentBatches = []
    w.operations!.employeeFactoryAssignments = [{ employeeId: admin.id, factoryIds: [style.factoryId], version: 1, createdAt: now, updatedAt: now, updatedBy: admin.id }]
    if (options.duplicateShipment) {
      w.operations!.shipmentLedgers.push({ styleId: style.id, lineId: line.id, baselineQuantities: { ...quantities }, baselineDate: '2026-11-01', createdAt: now, createdBy: admin.id })
      w.operations!.shipmentBatches.push({ id: crypto.randomUUID(), styleId: style.id, lineId: line.id, round: 1, shippedAt: '2026-11-01', quantities: { ...quantities }, tracking: '', note: 'QA 기존 보존 출고', voided: false, version: 1, createdAt: now, updatedAt: now, updatedBy: admin.id })
    }
    w.productionRuns = []; w.supplierProductionOrders = []; w.productionConditions = []
    for (const id of options.multiple ? [runId, secondRunId] : [runId]) {
      const poId = crypto.randomUUID(), cost = id === secondRunId ? 200 : 100
      w.operations!.poDispatches.push({ id: poId, styleId: style.id, dueDate: '2026-12-01', recipient: factory.email, subject: 'QA 자동 입고 PO', body: '로컬 검증 · 실제 발송 없음', evidenceAttachmentId: null, status: 'sent', sentAt: now, providerMessageId: 'fixture', lastError: null, attempts: 1, idempotencyKey: id, factoryIdSnapshot: style.factoryId, styleCodeSnapshot: code + 'GR', voided: false, version: 2, createdAt: now, updatedAt: now, updatedBy: admin.id })
      w.productionRuns.push({ id, styleId: style.id, lineId: line.id, projectId: project.id, projectCode: project.code, name: id === secondRunId ? 'QA 두 번째 생산' : 'QA 첫 번째 생산', round: id === secondRunId ? 2 : 1, expectedDue: '2026-12-01', poId, unitCost: cost, itemType: 'product', order: { ...quantities }, correctsRunId: null, factoryIdSnapshot: style.factoryId, factoryNameSnapshot: 'QA 공장', ownerIdSnapshot: admin.id, ownerNameSnapshot: admin.name, styleCodeSnapshot: code + 'GR', version: 1, createdAt: now, updatedAt: now, updatedBy: admin.id, closedAt: null, snapshot: null })
      const acceptance = { id: crypto.randomUUID(), expectedDeliveryDate: '2026-12-01', acceptedAt: now, actorId: factory.id, actorName: factory.name, actorEmail: factory.email, factoryId: style.factoryId, runVersion: 1, poVersion: 2, poSnapshot: { id: poId, version: 2, factoryId: style.factoryId }, termsSnapshot: {} }
      w.supplierProductionOrders.push({ runId: id, acceptance, startedAt: now, startedBy: admin.id, startedByName: admin.name } as NonNullable<Workspace['supplierProductionOrders']>[number])
      w.productionConditions.push({ runId: id, runVersion: 1, poVersion: 2, version: 1, productionMode: 'full_package', status: 'approved', legacy: false, internalUnitCost: cost, proposal: null, approval: { id: crypto.randomUUID(), finalDeliveryDate: '2026-12-01', unitCost: cost, approvedBy: admin.id, approvedByName: admin.name, approvedAt: now, termsSnapshot: { runId: id, styleId: style.id, lineId: line.id, projectId: project.id }, poSnapshot: {} }, timeline: [], changeRequests: [] })
    }
    localStorage.setItem(key, JSON.stringify(w)); localStorage.setItem('sig-demo-profile', adminId)
  }, { key: STORAGE, code: CODE, runId: RUN, secondRunId: SECOND_RUN, quantities: quantity, options, adminId: ADMIN })
  await page.reload()
}
async function open(page: Page) {
  await page.getByRole('button', { name: CODE + 'GR', exact: true }).click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /메인 생산/ }).click()
  await expect(detail.getByRole('tabpanel', { name: '메인 생산', exact: true }).locator('.production-color.active')).toContainText('GR')
  return detail
}

for (const mobile of [false, true]) test(`사이즈 표 출고 한 번 저장·입고 확정으로 차수 입고와 승인 단가를 연결한다 · ${mobile ? '모바일' : 'PC'}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  const before = await snapshot(page), detail = await open(page)
  await expect(detail.getByLabel('GR 본사 담당자', { exact: true })).toHaveValue(ADMIN)
  await expect(detail.getByLabel('GR 본사 담당자', { exact: true })).toBeDisabled()
  await expect(detail.getByRole('button', { name: '출고 차수 추가', exact: true })).toHaveCount(0)
  await detail.getByLabel('GR 실 출고 수량 S', { exact: true }).fill('50')
  await detail.getByLabel('GR 실 출고 수량 M', { exact: true }).fill('50')
  await detail.locator('label').filter({ hasText: /^실 출고 일자$/ }).locator('input').fill('2026-11-09')
  await detail.getByLabel('변경 사유', { exact: true }).fill('QA 사이즈 표에 출고 한 번 기록')
  await detail.getByRole('button', { name: '변경 저장', exact: true }).click()
  await expect(detail.getByRole('status').filter({ hasText: '변경 내용을 저장' })).toBeVisible()
  let w = await snapshot(page)
  expect(w.styles[0].production[1].shipped).toEqual(quantity)
  expect(w.operations!.shipmentBatches).toHaveLength(0)
  expect(w.shipmentAdjustments).toHaveLength(1)
  for (const [s, m] of [[20, 30], [50, 50]]) {
    await detail.getByLabel('GR 실 입고 수량 S', { exact: true }).fill(String(s))
    await detail.getByLabel('GR 실 입고 수량 M', { exact: true }).fill(String(m))
    await detail.getByLabel('GR 실입고 일자', { exact: true }).fill('2026-11-09')
    await detail.getByLabel('변경 사유', { exact: true }).fill('QA 누적 입고를 차수에 자동 연결')
    await detail.getByRole('region', { name: '메인 생산 입고 확정', exact: true }).getByRole('button', { name: '입고 확정', exact: true }).click()
    await expect(detail.getByRole('status').filter({ hasText: '생산 차수·마감에 자동 반영' })).toBeVisible()
  }
  w = await snapshot(page)
  expect(w.productionReceipts).toHaveLength(2)
  expect(w.productionReceipts!.map(row => ({ count: Object.values(row.quantities).reduce((sum, count) => sum + count, 0), unitCost: row.unitCost, netAmount: row.netAmount }))).toEqual([{ count: 50, unitCost: 100, netAmount: 5000 }, { count: 50, unitCost: 100, netAmount: 5000 }])
  expect(w.styles[0].production[1].received).toEqual(quantity)
  expect(w.styles[0].production[0]).toEqual({ ...before.styles[0].production[0], ownerId: ADMIN })
  await detail.getByRole('tab', { name: /생산 차수·마감/ }).click()
  await expect(detail.locator('.ledger-summary')).toContainText('100')
  await expect(detail.getByRole('button', { name: '실입고 추가', exact: true })).toHaveCount(0)
  await expect(detail.getByRole('button', { name: '메인 생산에서 입고 확정', exact: true })).toBeVisible()
  const records = detail.getByRole('region', { name: '생산 차수 실입고', exact: true }).locator('tbody tr')
  await expect(records).toHaveCount(2)
  await detail.getByRole('tab', { name: /을지·단가/ }).click()
  await expect(detail.getByLabel('장당 원가', { exact: true })).toHaveValue('100')
  await expect(detail.getByLabel('장당 원가', { exact: true })).toBeDisabled()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('기존 baseline·출고 차수를 보존하면서 누적 출고 중복을 한 번의 수량 정정으로 바로잡는다', async ({ page }) => {
  await fixture(page, { duplicateShipment: true })
  const before = await snapshot(page), detail = await open(page)
  await detail.getByLabel('GR 실 출고 수량 S', { exact: true }).fill('50')
  await detail.getByLabel('GR 실 출고 수량 M', { exact: true }).fill('50')
  await detail.getByLabel('변경 사유', { exact: true }).fill('QA 중복 입력된 누적 출고 수량 정정')
  await detail.getByRole('button', { name: '변경 저장', exact: true }).click()
  await expect.poll(async () => (await snapshot(page)).styles[0].production[1].shipped.M).toBe(50)
  const after = await snapshot(page)
  expect(after.operations!.shipmentLedgers).toEqual(before.operations!.shipmentLedgers)
  expect(after.operations!.shipmentBatches).toEqual(before.operations!.shipmentBatches)
  expect(after.shipmentAdjustments![0].delta).toEqual({ XXS: 0, XS: 0, S: -50, M: -50, L: 0, XL: 0 })
})

test('이미 입력한 메인 입고는 수량 재입력 없이 확정하고 다시 확정해도 중복 기록하지 않는다', async ({ page }) => {
  await fixture(page, { legacyReceived: true })
  const detail = await open(page)
  for (let attempt = 0; attempt < 2; attempt++) {
    await detail.getByLabel('변경 사유', { exact: true }).fill(`QA 기존 입고 연결 확인 ${attempt}`)
    await detail.getByRole('region', { name: '메인 생산 입고 확정', exact: true }).getByRole('button', { name: '입고 확정', exact: true }).click()
    await expect.poll(async () => (await snapshot(page)).productionMovementRequests?.length).toBe(attempt + 1)
  }
  const w = await snapshot(page)
  expect(w.productionReceipts).toHaveLength(1)
  expect(w.productionReceipts![0].quantities).toEqual(quantity)
})

test('차수가 여러 개면 명시 선택한 차수에만 입고를 연결한다', async ({ page }) => {
  await fixture(page, { multiple: true })
  const detail = await open(page), confirmation = detail.getByRole('region', { name: '메인 생산 입고 확정', exact: true })
  await detail.getByLabel('GR 실 입고 수량 M', { exact: true }).fill('10')
  await detail.getByLabel('변경 사유', { exact: true }).fill('QA 두 번째 생산 차수 입고')
  await expect(confirmation.getByRole('button', { name: '입고 확정', exact: true })).toBeDisabled()
  await confirmation.getByLabel('입고 연결 생산 차수', { exact: true }).selectOption(SECOND_RUN)
  await confirmation.getByRole('button', { name: '입고 확정', exact: true }).click()
  await expect.poll(async () => (await snapshot(page)).productionReceipts?.length).toBe(1)
  expect((await snapshot(page)).productionReceipts![0]).toMatchObject({ runId: SECOND_RUN, unitCost: 200, netAmount: 2000 })
})

test('배정된 공장은 출고만 한 번 입력하며 관리자 입고 확정과 단가에는 접근하지 않는다', async ({ page }) => {
  await fixture(page)
  await page.getByLabel('체험 역할', { exact: true }).selectOption(FACTORY)
  const detail = await open(page)
  await expect(detail.getByLabel('GR 실 출고 수량 S', { exact: true })).toBeEnabled()
  await expect(detail.getByLabel('GR 실 입고 수량 S', { exact: true })).toBeDisabled()
  await expect(detail.getByRole('button', { name: '입고 확정', exact: true })).toHaveCount(0)
  await expect(detail.getByRole('tab', { name: /을지·단가/ })).toHaveCount(0)
})
