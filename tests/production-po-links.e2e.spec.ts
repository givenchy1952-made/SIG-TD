import { test, expect, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1', CODE = 'QAPOLINK01'
const PO = '96000000-0000-4000-8000-000000000001', RUN = '96000000-0000-4000-8000-000000000002'
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page, incompatibleSource = false) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, code, poId, runId, incompatibleSource }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    const style = w.styles[1], line = style.production[0], admin = w.profiles.find(item => item.role === 'admin')!
    const project = w.projects.find(item => item.id === style.projectId)!
    project.code = 'QA-PO-LINK-2026'; style.code = code; style.production = [line]; style.colors = ['BK']; style.samples = []; style.stage = 'production'; line.color = 'BK'
    const zero = { XXS: 0, XS: 0, S: 0, M: 0, L: 0, XL: 0 }
    line.order = { ...zero, M: 100 }; line.shipped = { ...zero }; line.received = { ...zero }
    w.styles = [style]; w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []
    const stamp = { version: 1, createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z', updatedBy: admin.id }
    w.operations!.poDispatches = [{ ...stamp, id: poId, styleId: style.id, dueDate: '2026-11-11', recipient: 'supplier@example.test', subject: 'QA 보존할 발송 PO', body: 'QA 원본 문서 보존 · 실제 발송하지 않습니다.', evidenceAttachmentId: null, status: 'sent', sentAt: stamp.createdAt, providerMessageId: null, provider: 'outlook', providerRequestId: '96000000-0000-4000-8000-000000000003', senderEmailSnapshot: 'hq@example.test', lastError: null, attempts: 1, idempotencyKey: 'qa-link', factoryIdSnapshot: style.factoryId, styleCodeSnapshot: style.code, voided: false, version: 3 }]
    w.productionRuns = [{ ...stamp, id: runId, styleId: style.id, lineId: line.id, projectId: project.id, projectCode: project.code, name: 'QA 연결 차수', expectedDue: '2026-11-11', poId: null, unitCost: null, itemType: 'product', order: { ...zero, M: 10 }, correctsRunId: null, factoryIdSnapshot: style.factoryId, factoryNameSnapshot: w.factories.find(item => item.id === style.factoryId)!.name, styleCodeSnapshot: `${code}BK`, ownerIdSnapshot: style.ownerId, ownerNameSnapshot: w.profiles.find(item => item.id === style.ownerId)!.name, round: 1, closedAt: null, snapshot: null }]
    w.productionReceipts = []; w.productionRunAudits = []; w.supplierProductionOrders = []
    w.productionConditions = []; w.productionPoContexts = []; w.productionPoLinksAvailable = true
    if (incompatibleSource) w.productionPoContexts.push({ poId, source: 'style', capturedAt: stamp.createdAt, snapshot: { styleId: style.id, projectId: w.projects.find(item => item.id !== project.id)!.id, projectCode: 'OTHER-PROJECT', factoryId: style.factoryId, runId: null, lineId: null, styleCode: style.code, color: null, order: null, productionMode: null, lines: [{ lineId: line.id, color: line.color, styleCode: `${code}BK`, order: { ...line.order } }] } })
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, code: CODE, poId: PO, runId: RUN, incompatibleSource })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function openPO(page: Page) {
  await page.getByRole('button', { name: `${CODE}BK`, exact: true }).click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /생산 조건 협의·승인/ }).click(); await detail.locator('summary').filter({ hasText: /^전체 PO 이력/ }).click()
  return { detail, panel: detail.getByRole('region', { name: '생산 차수 PO 연결', exact: true }) }
}

for (const mobile of [false, true]) test(`발송 PO의 차수 미연결 안내에서 문서·범위 확인 후 연결하고 메일을 재발송하지 않는다 · ${mobile ? '모바일' : 'PC'}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  const before = await snapshot(page), { panel } = await openPO(page)
  await expect(panel).toContainText('생산 차수 미연결')
  await panel.getByRole('button', { name: '기존 생산 차수에 연결', exact: true }).click()
  await panel.getByLabel('연결할 기존 생산 차수', { exact: true }).selectOption(RUN)
  await expect(panel.getByRole('table', { name: 'PO 연결 수량 비교' })).toContainText('100')
  await expect(panel.getByRole('table', { name: 'PO 연결 수량 비교' })).toContainText('10')
  await panel.getByLabel('발송 문서 생산 조건 확인', { exact: true }).check()
  await panel.getByLabel('PO 연결 확인 사유', { exact: true }).fill('QA 발송 문서와 차수의 집계 범위 확인')
  await expect(panel.getByRole('button', { name: '확인한 생산 차수에 연결', exact: true })).toBeDisabled()
  await panel.getByLabel('수량 집계 범위 차이 확인', { exact: true }).check()
  await panel.getByLabel('기존 PO 비교 정보 미등록 확인', { exact: true }).check()
  await panel.getByRole('button', { name: '확인한 생산 차수에 연결', exact: true }).click()
  await expect(panel).toContainText('생산 차수 연결됨')
  const after = await snapshot(page)
  expect(after.productionRuns![0]).toMatchObject({ poId: PO, version: 2, order: before.productionRuns![0].order })
  expect(after.styles).toEqual(before.styles); expect(after.operations!.poDispatches).toEqual(before.operations!.poDispatches)
  expect(after.operations!.poDispatches[0].attempts).toBe(1)
  expect(after.productionConditions?.find(item => item.runId === RUN)?.approval).toBeFalsy()
  if (mobile) await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('PO 작성 당시 프로젝트가 다른 경우 확인 체크만으로 연결하거나 원본을 덮어쓰지 못한다', async ({ page }) => {
  await fixture(page, true)
  const before = await snapshot(page), { panel } = await openPO(page)
  await panel.getByRole('button', { name: '기존 생산 차수에 연결', exact: true }).click()
  await panel.getByLabel('연결할 기존 생산 차수', { exact: true }).selectOption(RUN)
  await panel.getByLabel('수량 집계 범위 차이 확인', { exact: true }).check()
  await panel.getByLabel('발송 문서 생산 조건 확인', { exact: true }).check()
  await panel.getByLabel('PO 연결 확인 사유', { exact: true }).fill('QA 다른 프로젝트 원본 차단')
  await panel.getByRole('button', { name: '확인한 생산 차수에 연결', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('원본의 프로젝트·업체')
  expect((await snapshot(page)).productionRuns).toEqual(before.productionRuns)
  expect((await snapshot(page)).operations!.poDispatches).toEqual(before.operations!.poDispatches)
})
