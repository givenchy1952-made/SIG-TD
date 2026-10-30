import { test, expect, type Page, type Locator } from '@playwright/test'

const STORAGE = 'sig-workspace-demo-v1'
const ADMIN = '10000000-0000-4000-8000-000000000001'
const INTERNAL = '10000000-0000-4000-8000-000000000002'
const FACTORY_A = '10000000-0000-4000-8000-000000000004'
const FACTORY_B = '10000000-0000-4000-8000-000000000021'
const PENDING = '10000000-0000-4000-8000-000000000005'
const FACTORY_ID = '20000000-0000-4000-8000-000000000002'
const CODE = 'BO42FYHD0102'

async function ready(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: '메뉴 열기', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name, exact: true }).click()
}
async function openSupplier(page: Page) {
  await page.getByLabel('스타일 검색', { exact: true }).fill(CODE)
  await page.locator('.style-code').filter({ hasText: CODE }).first().click()
  const detail = page.getByRole('dialog').filter({ has: page.getByRole('heading', { level: 1 }) })
  await detail.getByRole('tab', { name: /생산 조건 협의·승인/ }).click()
  return { detail, panel: detail.getByRole('region', { name: '생산 조건 협의·승인', exact: true }) }
}
async function fillProposal(panel: Locator, date: string) {
  await panel.getByRole('button', { name: '생산 조건 회신', exact: true }).click()
  await panel.getByLabel('업체 예상 납기일', { exact: true }).fill(date)
  await panel.getByLabel('업체 제안 생산 단가', { exact: true }).fill('100')
  await panel.getByLabel('업체 생산 가능 여부', { exact: true }).selectOption('yes')
  await panel.getByLabel('PO 수량 확인', { exact: true }).check()
  await panel.getByLabel('생산 조건 동의', { exact: true }).check()
}
async function productionFixture(page: Page) {
  await ready(page)
  await page.evaluate(({ key, code, actor, secondFactory }) => {
    const w = JSON.parse(localStorage.getItem(key)!)
    const style = w.styles.find((item: { code: string }) => item.code === code)
    const now = '2026-10-26T01:00:00.000Z'
    w.styles = [style]
    w.staffApprovalsAvailable = true; w.productionLedgerAvailable = true; w.supplierOrdersAvailable = true
    w.productionRuns = []; w.productionReceipts = []; w.productionRunAudits = []; w.supplierProductionOrders = []; w.productionConditions = []; w.productionConditionsAvailable = true
    w.profiles.push({ id: secondFactory, name: 'QA B 공장 담당자', email: 'qa-b@example.test', role: 'factory', approved: true, active: true, factoryId: w.factories[2].id })
    w.projects[0].code = 'QA-PROJECT-A'; w.projects[1].code = 'QA-PROJECT-B'
    const factory = w.factories.find((item: { id: string }) => item.id === style.factoryId)
    const owner = w.profiles.find((item: { id: string }) => item.id === style.ownerId)
    for (const index of [0, 1]) {
      const project = w.projects[index], poId = `81000000-0000-4000-8000-00000000000${index + 1}`
      const order = { XXS: 1 + index, XS: 2 + index, S: 3 + index, M: 4 + index, L: 5 + index, XL: 6 + index }
      w.operations.poDispatches.push({ id: poId, styleId: style.id, dueDate: '2026-12-10', recipient: 'qa-supplier@example.test', subject: `QA PO ${project.code}`, body: `QA 고정 발주 내용 ${project.code}\n실제 메일을 보내지 않는 브라우저 테스트입니다.`, evidenceAttachmentId: null, voided: false, status: 'sent', sentAt: now, providerMessageId: `qa-fixture-message-${index}`, lastError: null, attempts: 1, idempotencyKey: `qa-fixture-${index}`, factoryIdSnapshot: style.factoryId, styleCodeSnapshot: style.code, version: 2, createdAt: now, updatedAt: now, updatedBy: actor })
      w.productionRuns.push({ id: `82000000-0000-4000-8000-00000000000${index + 1}`, styleId: style.id, lineId: style.production[0].id, projectId: project.id, projectCode: project.code, expectedDue: '2026-12-10', name: `QA ${index + 1} 프로젝트 생산`, poId, unitCost: 983746.17 + index, itemType: 'product', order, correctsRunId: null, round: 1, version: 1, createdAt: now, updatedAt: now, updatedBy: actor, closedAt: null, snapshot: null, factoryIdSnapshot: style.factoryId, factoryNameSnapshot: factory.name, ownerIdSnapshot: style.ownerId, ownerNameSnapshot: owner.name, styleCodeSnapshot: `${style.code}${style.production[0].color}` })
    }
    w.productionConditions = w.productionRuns.map((run: { id: string; unitCost: number }) => ({ runId: run.id, runVersion: 1, poVersion: 2, version: 1, productionMode: 'full_package', status: 'awaiting_supplier', legacy: false, internalUnitCost: run.unitCost, proposal: null, approval: null, timeline: [], changeRequests: [] }))
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, code: CODE, actor: ADMIN, secondFactory: FACTORY_B })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}

test('본사 직원이 가입자를 승인하고 공장을 배정하되 관리자 권한과 기준 정보는 변경하지 못한다', async ({ page }) => {
  await ready(page)
  await page.evaluate(({ key, pending }) => {
    const w = JSON.parse(localStorage.getItem(key)!)
    w.profiles.find((profile: { id: string }) => profile.id === pending).role = 'internal'
    w.staffApprovalsAvailable = true
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, pending: PENDING })
  await page.reload()
  await page.getByLabel('체험 역할').selectOption(INTERNAL)
  await navigate(page, '사용자 · 기본 설정')
  await expect(page.getByRole('heading', { name: '가입 승인 및 공장 배정', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '공장 관리', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '프로젝트 관리', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '남주현 권한 수정', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '천민영 권한 수정', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: /^권한 지정 및 승인/ }).click()
  const modal = page.getByRole('dialog', { name: '사용자 권한 관리', exact: true })
  await expect(modal.getByRole('combobox', { name: '역할', exact: true })).toHaveValue('factory')
  await expect(modal.getByRole('combobox', { name: '역할', exact: true }).getByRole('option', { name: '관리자', exact: true })).toHaveCount(0)
  await expect(modal.getByRole('combobox', { name: '담당 공장', exact: true })).toHaveValue('')
  await modal.getByRole('button', { name: '변경 저장', exact: true }).click()
  expect(await page.evaluate(({ key, id }) => JSON.parse(localStorage.getItem(key)!).profiles.find((p: { id: string }) => p.id === id).approved, { key: STORAGE, id: PENDING })).toBe(false)
  await modal.getByRole('combobox', { name: '담당 공장', exact: true }).selectOption(FACTORY_ID)
  await modal.getByRole('button', { name: '변경 저장', exact: true }).click()
  await expect(modal).toHaveCount(0)
  const approved = await page.evaluate(({ key, id }) => JSON.parse(localStorage.getItem(key)!).profiles.find((p: { id: string }) => p.id === id), { key: STORAGE, id: PENDING })
  expect(approved).toMatchObject({ role: 'factory', approved: true, active: true, factoryId: FACTORY_ID })
  await page.getByRole('button', { name: '신규 협력사 권한 수정', exact: true }).click()
  await expect(modal.getByRole('combobox', { name: '역할', exact: true })).toBeDisabled()
  await modal.getByRole('button', { name: '취소', exact: true }).click()
  await page.getByLabel('체험 역할').selectOption(PENDING)
  await expect(page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '사용자 · 기본 설정', exact: true })).toHaveCount(0)
})

test('업체의 프로젝트별 생산 조건 회신은 본사 승인 대기이며 본사 최종 승인 후에만 해당 차수가 시작된다', async ({ page }) => {
  await productionFixture(page)
  const projectNames = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).projects.slice(0, 2).map((project: { name: string }) => project.name), STORAGE)
  await page.getByLabel('체험 역할').selectOption(FACTORY_A)
  const { detail, panel } = await openSupplier(page)
  await expect(detail.getByRole('tab', { name: /생산 차수.*마감|단가/ })).toHaveCount(0)
  await expect(panel).not.toContainText('983746.17')
  await expect(panel.getByLabel('본사 내부 검토 단가', { exact: true })).toHaveCount(0)
  const rounds = panel.getByLabel('생산 조건 협의 차수', { exact: true })
  await expect(rounds.getByRole('option')).toHaveCount(2)
  await expect(panel.locator('.supplier-order-card > header strong')).toContainText('1차')
  await expect(panel.locator('.supplier-order-card > header strong')).toContainText(projectNames[0])
  await expect(panel.locator('.supplier-order-card > header')).toContainText('QA-PROJECT-A')
  await expect(panel.getByRole('table', { name: '생산 발주 사이즈별 수량', exact: true })).toContainText('21')
  await panel.getByText('QA PO QA-PROJECT-A', { exact: true }).click()
  await expect(panel).toContainText('QA 고정 발주 내용 QA-PROJECT-A')
  await panel.getByRole('button', { name: '생산 조건 회신', exact: true }).click()
  await panel.getByLabel('업체 예상 납기일', { exact: true }).fill('2026-12-14')
  await panel.getByLabel('업체 제안 생산 단가', { exact: true }).fill('100')
  await panel.getByLabel('업체 생산 가능 여부', { exact: true }).selectOption('yes')
  await expect(rounds).toBeDisabled()
  await panel.getByRole('button', { name: '생산 조건 제출', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('모두 체크')
  await panel.getByLabel('PO 수량 확인', { exact: true }).check()
  await panel.getByLabel('생산 조건 동의', { exact: true }).check()
  await panel.getByRole('button', { name: '생산 조건 제출', exact: true }).click()
  await expect(panel).toContainText('본사 최종 승인 대기')
  await expect(panel.getByRole('region', { name: '업체 생산 조건 회신', exact: true })).toContainText('이준')
  let stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE)
  const proposal = stored.productionConditions.find((condition: { runId: string }) => condition.runId === '82000000-0000-4000-8000-000000000001')
  expect(proposal).toMatchObject({ status: 'awaiting_approval', proposal: { actorId: FACTORY_A, expectedDeliveryDate: '2026-12-14', unitCost: 100, confirmedQuantities: { XXS: 1, XL: 6 } }, approval: null })
  expect(stored.supplierProductionOrders.find((order: { projectCode: string }) => order.projectCode === 'QA-PROJECT-A')).toMatchObject({ acceptance: null, startedAt: null })
  await rounds.selectOption('82000000-0000-4000-8000-000000000002')
  await expect(panel.locator('.supplier-order-card > header strong')).toContainText('1차')
  await expect(panel.locator('.supplier-order-card > header strong')).toContainText(projectNames[1])
  await expect(panel.locator('.supplier-order-card > header')).toContainText('QA-PROJECT-B')
  await expect(rounds.getByRole('option', { name: /QA-PROJECT-B/ })).toHaveCount(1)
  await expect(panel.locator('.supplier-order-card > header')).not.toContainText('프로젝트 미지정')
  await expect(panel.getByRole('table', { name: '생산 발주 사이즈별 수량', exact: true })).toContainText('27')
  await expect(panel.getByRole('region', { name: '업체 생산 조건 회신', exact: true })).toHaveCount(0)
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await page.getByLabel('체험 역할').selectOption(INTERNAL)
  const hq = await openSupplier(page)
  await expect(hq.panel.getByRole('table', { name: '본사 업체 생산 조건 비교', exact: true })).toContainText('4일 지연')
  await hq.panel.getByRole('button', { name: '최종 승인 검토', exact: true }).click()
  await hq.panel.getByLabel('최종 승인 납기일', { exact: true }).fill('2026-12-13')
  await hq.panel.getByLabel('최종 승인 생산 단가', { exact: true }).fill('105')
  await hq.panel.getByLabel('생산 조건 변경 사유', { exact: true }).fill('QA 납기와 단가 협의 후 최종 승인')
  await hq.panel.getByRole('button', { name: '최종 승인 및 생산 시작', exact: true }).click()
  await expect(hq.panel.getByRole('region', { name: '본사 최종 승인 기록', exact: true })).toContainText('2026-12-13')
  stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE)
  expect(stored.supplierProductionOrders.find((order: { projectCode: string }) => order.projectCode === 'QA-PROJECT-A')).toMatchObject({ status: 'in_progress', startedBy: INTERNAL })
  expect(stored.productionRuns.find((run: { projectCode: string }) => run.projectCode === 'QA-PROJECT-A')).toMatchObject({ unitCost: 105 })
  await hq.detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await page.getByLabel('체험 역할').selectOption(FACTORY_B)
  await page.getByLabel('스타일 검색', { exact: true }).fill(CODE)
  await expect(page.locator('.style-code').filter({ hasText: CODE })).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('QA 고정 발주 내용 QA-PROJECT-A')
})

test('본사는 생산 차수의 수량과 접속 안내가 채워진 PO 초안을 저장해 연결하고 발송 전 내용을 확인한다', async ({ page }) => {
  await productionFixture(page)
  const mailRequests: string[] = []
  page.on('request', request => { if (request.url().includes('/functions/v1/send-po-email')) mailRequests.push(request.url()) })
  await page.evaluate(key => {
    const w = JSON.parse(localStorage.getItem(key)!)
    w.productionRuns[0].poId = null
    localStorage.setItem(key, JSON.stringify(w))
  }, STORAGE)
  await page.reload()
  const { detail, panel } = await openSupplier(page)
  await panel.getByRole('button', { name: '이 차수 PO 작성', exact: true }).click()
  const form = panel.getByRole('region', { name: '생산 차수 PO 초안', exact: true })
  await expect(form.getByLabel('차수 PO 수신 이메일', { exact: true })).toHaveValue('factory@example.test')
  await expect(form.getByLabel('차수 PO 납기일', { exact: true })).toHaveValue('2026-12-10')
  await expect(form.getByLabel('차수 PO 제목', { exact: true })).toHaveValue(/QA-PROJECT-A.*BO42FYHD0102BK.*1차/)
  await expect(form.getByLabel('차수 PO 내용', { exact: true })).toHaveValue(/XXS: 1 pcs.*XL: 6 pcs/s)
  await expect(form.getByLabel('차수 PO 내용', { exact: true })).toHaveValue(/총 오더 수량: 21 pcs/)
  await expect(form.getByLabel('차수 PO 내용', { exact: true })).toHaveValue(/업체 계정으로 로그인.*생산 조건/s)
  await form.getByLabel('차수 PO 수신 이메일', { exact: true }).fill('qa-purchase@example.test')
  await form.getByLabel('차수 PO 납기일', { exact: true }).fill('2026-12-16')
  await expect(form.getByLabel('차수 PO 내용', { exact: true })).toHaveValue(/본사 요청 납기: 2026-12-16/)
  await expect(panel.getByLabel('생산 조건 협의 차수', { exact: true })).toBeDisabled()
  await form.getByRole('button', { name: '차수 PO 초안 저장 및 연결', exact: true }).click()
  await expect(detail.getByRole('tabpanel', { name: 'PO', exact: true })).toBeVisible()
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE)
  const run = stored.productionRuns.find((run: { projectCode: string }) => run.projectCode === 'QA-PROJECT-A')
  const po = stored.operations.poDispatches.find((po: { id: string }) => po.id === run.poId)
  expect(po).toMatchObject({ status: 'draft', dueDate: '2026-12-16', recipient: 'qa-purchase@example.test', attempts: 0, sentAt: '', providerMessageId: null })
  expect(po.body).toContain('총 오더 수량: 21 pcs')
  expect(run.version).toBe(2)
  expect(stored.operations.poDispatches).toHaveLength(3)
  expect(stored.operations.poDispatchAttempts).toHaveLength(0)
  expect(mailRequests).toEqual([])
  await detail.getByRole('tab', { name: /생산 조건 협의·승인/ }).click()
  await expect(panel).toContainText('이 생산 차수에 PO가 연결되어 있습니다.')
  await expect(panel.getByRole('button', { name: '이 차수 PO 작성', exact: true })).toHaveCount(0)
})

test('메일 미발송 발주는 업체가 동의할 수 없고 납기 초안은 상세 닫기 전에 보호한다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await productionFixture(page)
  await page.evaluate(key => {
    const w = JSON.parse(localStorage.getItem(key)!)
    w.operations.poDispatches[0].status = 'draft'; w.operations.poDispatches[0].sentAt = ''; w.operations.poDispatches[0].providerMessageId = null
    localStorage.setItem(key, JSON.stringify(w))
  }, STORAGE)
  await page.reload()
  await page.getByLabel('체험 역할').selectOption(FACTORY_A)
  const { detail, panel } = await openSupplier(page)
  await expect(panel).toContainText('PO 발송 대기')
  await expect(panel.getByLabel('업체 예상 납기일', { exact: true })).toHaveCount(0)
  await panel.getByLabel('생산 조건 협의 차수', { exact: true }).selectOption('82000000-0000-4000-8000-000000000002')
  await panel.getByRole('button', { name: '생산 조건 회신', exact: true }).click()
  await panel.getByLabel('업체 예상 납기일', { exact: true }).fill('2026-12-17')
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  const warning = detail.getByRole('alertdialog', { name: '저장하지 않은 변경 내용이 있습니다.', exact: true })
  await expect(warning).toBeVisible()
  await warning.getByRole('button', { name: '편집 계속', exact: true }).click()
  await expect(panel.getByLabel('업체 예상 납기일', { exact: true })).toHaveValue('2026-12-17')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await panel.getByRole('button', { name: '생산 조건 입력 취소', exact: true }).click()
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await expect(detail).toHaveCount(0)
})

test('다른 창에서 업체 조건이 먼저 제출되면 기존 입력을 보존하고 중복 제출을 막는다', async ({ page, context }) => {
  await productionFixture(page)
  await page.getByLabel('체험 역할').selectOption(FACTORY_A)
  const first = await openSupplier(page)
  const second = await context.newPage()
  await ready(second)
  const other = await openSupplier(second)
  await fillProposal(other.panel, '2026-12-18')
  await fillProposal(first.panel, '2026-12-14')
  await first.panel.getByRole('button', { name: '생산 조건 제출', exact: true }).click()
  await expect(first.panel).toContainText('본사 최종 승인 대기')
  await expect(other.panel.getByRole('status').filter({ hasText: '작성한 내용은 유지됩니다.' })).toBeVisible()
  await expect(other.panel.getByLabel('업체 예상 납기일', { exact: true })).toHaveValue('2026-12-18')
  await expect(other.panel.getByRole('button', { name: '생산 조건 제출', exact: true })).toBeDisabled()
  await other.panel.getByRole('button', { name: '생산 조건 입력 취소', exact: true }).click()
  await expect(other.panel.getByRole('region', { name: '업체 생산 조건 회신', exact: true })).toBeVisible()
  await expect(other.panel.getByRole('table', { name: '본사 업체 생산 조건 비교', exact: true })).toContainText('2026-12-14')
  await expect(other.panel.getByLabel('업체 예상 납기일', { exact: true })).toHaveCount(0)
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE)
  expect(saved.productionConditions.find((condition: { runId: string }) => condition.runId === '82000000-0000-4000-8000-000000000001').status).toBe('awaiting_approval')
  expect(saved.supplierProductionOrders.find((order: { projectCode: string }) => order.projectCode === 'QA-PROJECT-A').startedAt).toBeNull()
  await second.close()
})
