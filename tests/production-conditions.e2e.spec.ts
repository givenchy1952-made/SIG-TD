import { test, expect, type Locator, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1', CODE = 'QACONDITIONS01'
const ADMIN = '10000000-0000-4000-8000-000000000001', FACTORY = '10000000-0000-4000-8000-000000000004'
const OTHER_FACTORY = '10000000-0000-4000-8000-000000000006', RUN = '84000000-0000-4000-8000-000000000001'
const QUANTITIES = { XXS: 1, XS: 2, S: 3, M: 4, L: 5, XL: 6 }
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page, options: { sent?: boolean; legacy?: boolean } = {}) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, code, runId, quantities, options, otherFactory }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    const style = w.styles[0], line = style.production[0], admin = w.profiles.find(person => person.role === 'admin')!
    const supplier = w.profiles.find(person => person.role === 'factory' && person.approved)!
    style.code = code; style.stage = 'production'; style.samples = []; style.ppApproved = false
    style.factoryId = supplier.factoryId!; style.production = [line]; style.colors = ['BK']; line.color = 'BK'
    line.order = { ...quantities, M: 83 }; line.shipped = { XXS: 0, XS: 0, S: 0, M: 0, L: 0, XL: 0 }; line.received = { ...line.shipped }
    const project = w.projects.find(item => item.id === style.projectId)!; project.code = 'QA-APPROVAL-2026'
    w.styles = [style]; w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []
    w.profiles.push({ ...supplier, id: otherFactory, name: 'QA 다른 업체', email: 'other-qa@example.test', factoryId: w.factories.find(factory => factory.id !== supplier.factoryId)!.id })
    w.productionRuns = []; w.productionReceipts = []; w.productionRunAudits = []; w.supplierProductionOrders = []
    w.productionLedgerAvailable = true; w.supplierOrdersAvailable = true; w.productionConditionsAvailable = true
    w.operations!.poDispatches = []; w.operations!.shipmentBatches = []; w.operations!.shipmentLedgers = []
    const now = '2026-10-28T00:00:00Z', poId = '94000000-0000-4000-8000-000000000001'
    const sent = options.sent !== false
    if (sent) w.operations!.poDispatches.push({ id: poId, styleId: style.id, dueDate: '2026-11-11', recipient: supplier.email, subject: 'QA 생산 승인 시험 PO', body: 'QA 테스트 발주서 · 실제 메일을 보내지 않습니다.', evidenceAttachmentId: null, status: 'sent', sentAt: now, providerMessageId: 'fixture-accepted-only', lastError: null, attempts: 1, idempotencyKey: 'qa-approval-test', factoryIdSnapshot: style.factoryId, styleCodeSnapshot: `${code}BK`, voided: false, version: 2, createdAt: now, updatedAt: now, updatedBy: admin.id })
    w.productionRuns.push({ id: runId, styleId: style.id, lineId: line.id, projectId: style.projectId, projectCode: project.code, expectedDue: '2026-11-11', name: 'QA 협의 생산', round: 1, poId: sent ? poId : null, order: quantities, unitCost: options.legacy ? 222.22 : null, itemType: 'product', correctsRunId: null, factoryIdSnapshot: style.factoryId, ownerIdSnapshot: style.ownerId, styleCodeSnapshot: `${code}BK`, factoryNameSnapshot: 'QA 배정 공장', ownerNameSnapshot: admin.name, version: 1, createdAt: now, updatedAt: now, updatedBy: admin.id, closedAt: null, snapshot: null })
    const acceptance = options.legacy ? { id: crypto.randomUUID(), expectedDeliveryDate: '2026-11-12', acceptedAt: now, actorId: supplier.id, actorName: supplier.name, actorEmail: supplier.email, factoryId: style.factoryId, runVersion: 1, poVersion: 2, poSnapshot: { id: poId, version: 2, factoryId: style.factoryId }, termsSnapshot: {} } : null
    w.supplierProductionOrders = [{ runId, acceptance, startedAt: options.legacy ? now : null, startedBy: options.legacy ? supplier.id : null, startedByName: options.legacy ? supplier.name : null }] as Workspace['supplierProductionOrders']
    w.productionConditions = [{ runId, runVersion: 1, poVersion: sent ? 2 : null, version: sent ? 1 : 0, productionMode: sent ? 'full_package' : null, status: options.legacy ? 'approved' : sent ? 'awaiting_supplier' : 'awaiting_po', legacy: !!options.legacy, internalUnitCost: sent ? 91000 : null, proposal: null, approval: null, timeline: [], changeRequests: [] }]
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, code: CODE, runId: RUN, quantities: QUANTITIES, options, otherFactory: OTHER_FACTORY })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function open(page: Page) {
  await page.getByRole('button', { name: `${CODE}BK`, exact: true }).click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /생산 조건 협의·승인/ }).click()
  const panel = detail.getByRole('region', { name: '생산 조건 협의·승인', exact: true })
  await expect(panel).toBeVisible()
  return { detail, panel }
}
async function close(detail: Locator) { await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click() }
async function role(page: Page, id: string) { await page.getByLabel('체험 역할', { exact: true }).selectOption(id) }
async function proposal(panel: Locator, date = '2026-11-30', price = '100000', revision = false) {
  await panel.getByRole('button', { name: revision ? '수정 조건 재제출' : '생산 조건 회신', exact: true }).click()
  await panel.getByLabel('업체 예상 납기일', { exact: true }).fill(date)
  await panel.getByLabel('업체 제안 생산 단가', { exact: true }).fill(price)
  await panel.getByLabel('업체 생산 가능 여부', { exact: true }).selectOption('yes')
  await panel.getByLabel('PO 수량 확인', { exact: true }).check()
  await panel.getByLabel('생산 조건 동의', { exact: true }).check()
  await panel.getByRole('button', { name: '생산 조건 제출', exact: true }).click()
  await expect(panel).toContainText('본사 최종 승인 대기')
}
async function approve(panel: Locator, price = '95000', date = '2026-11-25') {
  await panel.getByRole('button', { name: '최종 승인 검토', exact: true }).click()
  await panel.getByLabel('최종 승인 납기일', { exact: true }).fill(date)
  await panel.getByLabel('최종 승인 생산 단가', { exact: true }).fill(price)
  await panel.getByLabel('생산 조건 변경 사유', { exact: true }).fill('QA 본사 최종 조건 합의')
  await panel.getByRole('button', { name: '최종 승인 및 생산 시작', exact: true }).click()
  await expect(panel.getByRole('region', { name: '본사 최종 승인 기록', exact: true })).toBeVisible()
}

test('업체 제안은 생산을 시작하지 않고 본사가 지연·단가를 검토해 승인한 후에만 시작한다', async ({ page }) => {
  await fixture(page); await role(page, FACTORY)
  let { detail, panel } = await open(page)
  await expect(panel).not.toContainText('91,000원')
  await expect(panel.getByText('본사 내부 검토 단가', { exact: true })).toHaveCount(0)
  await proposal(panel)
  let stored = await snapshot(page)
  expect(stored.productionConditions![0]).toMatchObject({ status: 'awaiting_approval', proposal: { unitCost: 100000, expectedDeliveryDate: '2026-11-30', confirmedQuantities: QUANTITIES }, approval: null })
  expect(stored.productionRuns![0].unitCost).toBeNull()
  expect(stored.supplierProductionOrders![0].startedAt).toBeNull()
  await expect(panel.getByRole('button', { name: '최종 승인 검토', exact: true })).toHaveCount(0)
  await close(detail); await role(page, ADMIN)
  ;({ detail, panel } = await open(page))
  await expect(panel.getByRole('table', { name: '본사 업체 생산 조건 비교', exact: true })).toContainText('19일 지연')
  await expect(panel).toContainText('91,000원')
  await expect(panel).toContainText('+9,000원')
  await approve(panel)
  stored = await snapshot(page)
  expect(stored.productionConditions![0]).toMatchObject({ status: 'approved', approval: { unitCost: 95000, finalDeliveryDate: '2026-11-25', approvedBy: ADMIN } })
  expect(stored.productionRuns![0]).toMatchObject({ unitCost: 95000, expectedDue: '2026-11-11', order: QUANTITIES })
  expect(stored.supplierProductionOrders![0]).toMatchObject({ status: 'in_progress', startedBy: ADMIN })
  await expect(panel.getByRole('region', { name: '생산 조건 협의 승인 이력', exact: true })).toContainText('생산 시작')
  await expect(panel.getByRole('button', { name: '최종 승인 검토', exact: true })).toHaveCount(0)
  await close(detail); await role(page, FACTORY)
  const supplier = await open(page)
  await expect(supplier.panel.getByRole('region', { name: '본사 최종 승인 기록', exact: true })).toContainText('95,000원')
  await expect(supplier.panel).not.toContainText('91,000원')
})

test('본사의 수정 요청 후 업체가 재제출하며 0원 승인도 미입력과 구분한다', async ({ page }) => {
  await fixture(page); await role(page, FACTORY)
  let { detail, panel } = await open(page); await proposal(panel); await close(detail)
  await role(page, ADMIN); ({ detail, panel } = await open(page))
  await panel.getByRole('button', { name: '수정 요청', exact: true }).click()
  await panel.getByLabel('생산 조건 변경 사유', { exact: true }).fill('QA 납기 앞당김과 단가 재협의 요청')
  await panel.getByRole('button', { name: '수정 요청 전달', exact: true }).click()
  expect((await snapshot(page)).productionConditions![0].status).toBe('revision_requested')
  expect((await snapshot(page)).supplierProductionOrders![0].startedAt).toBeNull()
  await close(detail); await role(page, FACTORY); ({ detail, panel } = await open(page))
  await proposal(panel, '2026-11-20', '90000', true); await close(detail)
  await role(page, ADMIN); ({ detail, panel } = await open(page))
  await expect(panel).toContainText('9일 지연')
  await approve(panel, '0', '2026-11-20')
  const stored = await snapshot(page)
  expect(stored.productionRuns![0].unitCost).toBe(0)
  expect(stored.productionConditions![0].timeline.filter(event => event.action.includes('제출'))).toHaveLength(2)
  await expect(panel.getByRole('region', { name: '본사 최종 승인 기록', exact: true })).toContainText('0원')
})

test('발주 거절은 생산 시작을 차단하고 다른 업체에는 발주와 내부 검토가 표시되지 않는다', async ({ page }) => {
  await fixture(page); await role(page, FACTORY)
  let { detail, panel } = await open(page); await proposal(panel); await close(detail)
  await role(page, ADMIN); ({ detail, panel } = await open(page))
  await panel.getByRole('button', { name: '발주 거절', exact: true }).click()
  await panel.getByLabel('생산 조건 변경 사유', { exact: true }).fill('QA 납기 협의 불가로 발주 거절')
  await panel.getByRole('button', { name: '발주 거절 확정', exact: true }).click()
  const stored = await snapshot(page)
  expect(stored.productionConditions![0].status).toBe('rejected')
  expect(stored.supplierProductionOrders![0].startedAt).toBeNull()
  await close(detail); await role(page, OTHER_FACTORY)
  await expect(page.getByRole('button', { name: `${CODE}BK`, exact: true })).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('QA 생산 승인 시험 PO')
})

test('본사 생산 방식과 내부 검토 기준을 저장하고 컬러·CMT가 포함된 PO 초안을 자동 연결한다', async ({ page }) => {
  await fixture(page, { sent: false })
  const { detail, panel } = await open(page)
  await panel.getByRole('button', { name: '생산 방식·검토 기준 설정', exact: true }).click()
  await panel.getByLabel('생산 방식', { exact: true }).selectOption('cmt')
  await panel.getByLabel('본사 내부 검토 단가', { exact: true }).fill('0')
  await panel.getByLabel('생산 조건 변경 사유', { exact: true }).fill('QA 임가공 방식 검토 기준 설정')
  await panel.getByRole('button', { name: '생산 조건 기준 저장', exact: true }).click()
  await expect(panel).toContainText('생산 방식과 본사 검토 기준을 저장했습니다.')
  await panel.getByRole('button', { name: '이 차수 PO 작성', exact: true }).click()
  await expect(panel.getByLabel('차수 PO 제목', { exact: true })).toHaveValue(new RegExp(`${CODE}BK`))
  await expect(panel.getByLabel('차수 PO 내용', { exact: true })).toHaveValue(/임가공 \(CMT\)/)
  await panel.getByRole('button', { name: '차수 PO 초안 저장 및 연결', exact: true }).click()
  await expect(detail.getByRole('tab', { name: /^PO/ })).toHaveAttribute('aria-selected', 'true')
  const stored = await snapshot(page)
  expect(stored.productionConditions![0]).toMatchObject({ productionMode: 'cmt', internalUnitCost: 0 })
  expect(stored.productionRuns![0].poId).toBe(stored.operations!.poDispatches[0].id)
  expect(stored.operations!.poDispatches[0]).toMatchObject({ status: 'draft', attempts: 0 })
  expect(stored.operations!.poDispatches[0].body).not.toContain('0원')
})

test('모바일에서도 회신을 입력하고 동시 변경 시 작성값을 보존하며 오래된 제출을 막는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page); await role(page, FACTORY)
  const { panel } = await open(page)
  await panel.getByRole('button', { name: '생산 조건 회신', exact: true }).click()
  await panel.getByLabel('업체 예상 납기일', { exact: true }).fill('2026-11-30')
  await panel.getByLabel('업체 제안 생산 단가', { exact: true }).fill('100000')
  await page.evaluate(key => { const w = JSON.parse(localStorage.getItem(key)!) as Workspace; w.productionRuns![0].version += 1; localStorage.setItem(key, JSON.stringify(w)); window.dispatchEvent(new Event('sig-workspace-change')) }, STORAGE)
  await expect(panel).toContainText('다른 사용자가 발주나 생산 조건을 변경했습니다.')
  await expect(panel.getByLabel('업체 예상 납기일', { exact: true })).toHaveValue('2026-11-30')
  await expect(panel.getByLabel('업체 제안 생산 단가', { exact: true })).toHaveValue('100000')
  await expect(panel.getByRole('button', { name: '생산 조건 제출', exact: true })).toBeDisabled()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('기존 프로세스로 시작한 생산은 단가·동의·시작 기록을 유지한다', async ({ page }) => {
  await fixture(page, { legacy: true })
  const before = await snapshot(page), { panel } = await open(page)
  await expect(panel).toContainText('기존 프로세스 승인 기록')
  await expect(panel.getByRole('button', { name: '최종 승인 검토', exact: true })).toHaveCount(0)
  const after = await snapshot(page)
  expect(after.productionRuns).toEqual(before.productionRuns)
  expect(after.supplierProductionOrders).toEqual(before.supplierProductionOrders)
  expect(after.productionConditions![0].approval).toBeNull()
})

test('승인 조건 변경은 새 차수의 집계 범위를 확인해 연결하며 기존 승인·PO·가격을 유지한다', async ({ page }) => {
  await fixture(page); await role(page, FACTORY)
  let { detail, panel } = await open(page)
  await proposal(panel); await close(detail); await role(page, ADMIN)
  ;({ detail, panel } = await open(page))
  await approve(panel)
  const approved = await snapshot(page), priorApproval = structuredClone(approved.productionConditions![0].approval)
  const priorRun = structuredClone(approved.productionRuns![0]), priorPOs = structuredClone(approved.operations!.poDispatches)
  await panel.getByRole('button', { name: '승인 조건 변경 요청', exact: true }).click()
  await panel.getByLabel('생산 조건 변경 사유', { exact: true }).fill('QA 추가 생산 물량을 별도 차수에서 재협의')
  await panel.getByRole('button', { name: '조건 변경 요청 기록', exact: true }).click()
  await expect(panel.getByRole('region', { name: '승인 조건 변경 요청 기록', exact: true })).toContainText('본사의 새 생산 차수 연결 대기')
  await close(detail)

  const replacementId = await page.evaluate(({ key, runId }) => {
    const workspace = JSON.parse(localStorage.getItem(key)!) as Workspace
    const previous = workspace.productionRuns!.find(run => run.id === runId)!
    const id = crypto.randomUUID(), now = new Date().toISOString()
    workspace.productionRuns!.push({ ...structuredClone(previous), id, round: previous.round + 1, name: 'QA 별도 재승인 생산', poId: null, unitCost: null, order: { XXS: 0, XS: 0, S: 0, M: 10, L: 0, XL: 0 }, correctsRunId: null, version: 1, closedAt: null, snapshot: null, createdAt: now, updatedAt: now })
    localStorage.setItem(key, JSON.stringify(workspace))
    window.dispatchEvent(new Event('sig-workspace-change'))
    return id
  }, { key: STORAGE, runId: RUN })
  await page.reload()
  ;({ detail, panel } = await open(page))
  await panel.getByLabel('생산 조건 협의 차수', { exact: true }).selectOption(RUN)
  await panel.getByRole('button', { name: '변경 요청에 새 차수 연결', exact: true }).click()
  await panel.getByLabel('재승인할 새 생산 차수', { exact: true }).selectOption(replacementId)
  const scope = panel.getByRole('table', { name: '변경 전후 오더 집계 범위 비교', exact: true })
  await expect(scope).toContainText('기존 승인 차수')
  await expect(scope).toContainText('재승인할 새 차수')
  await expect(scope).toContainText('메인 생산 누적 오더')
  await panel.getByLabel('생산 조건 변경 사유', { exact: true }).fill('QA 새 차수 오더 범위 확인 후 재승인 대상으로 연결')
  await panel.getByRole('button', { name: '변경 요청과 새 차수 연결', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('오더 수량·집계 범위를 확인')
  expect((await snapshot(page)).productionConditions!.find(condition => condition.runId === RUN)!.changeRequests[0].correctingRunId).toBeNull()
  await panel.getByLabel('새 차수 오더 수량 및 집계 범위 확인', { exact: true }).check()
  await panel.getByRole('button', { name: '변경 요청과 새 차수 연결', exact: true }).click()
  await expect(panel.getByRole('region', { name: '승인 조건 변경 요청 기록', exact: true })).toContainText('재승인 차수: QA 별도 재승인 생산')
  const after = await snapshot(page)
  const originalCondition = after.productionConditions!.find(condition => condition.runId === RUN)!
  expect(originalCondition.approval).toEqual(priorApproval)
  expect(originalCondition.changeRequests[0].correctingRunId).toBe(replacementId)
  expect(after.productionRuns!.find(run => run.id === RUN)).toEqual(priorRun)
  expect(after.operations!.poDispatches).toEqual(priorPOs)
  expect(after.productionConditions!.find(condition => condition.runId === replacementId)).toMatchObject({ priorRunId: RUN, changeRequestId: originalCondition.changeRequests[0].id, approval: null })
  expect(after.productionRuns!.find(run => run.id === replacementId)).toMatchObject({ unitCost: null, poId: null })
  await panel.getByLabel('생산 조건 협의 차수', { exact: true }).selectOption(replacementId)
  await expect(panel).toContainText('PO 발송 대기')
  await expect(panel.getByRole('region', { name: '본사 최종 승인 기록', exact: true })).toHaveCount(0)
})
