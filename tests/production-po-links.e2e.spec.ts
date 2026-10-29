import { test, expect, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1', CODE = 'QAPOLINK01'
const PO = '96000000-0000-4000-8000-000000000001', RUN = '96000000-0000-4000-8000-000000000002'
const ARCHIVED_PO = '96000000-0000-4000-8000-000000000004'
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page, incompatibleSource = false, archivedDraft = false) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, code, poId, runId, incompatibleSource, archivedDraft, archivedPoId }) => {
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
    w.productionConditions = []; w.productionPoContexts = []; w.productionPoLinksAvailable = true; w.productionPoRecoveryAvailable = true
    if (archivedDraft) {
      w.operations!.poDispatches.push({ ...w.operations!.poDispatches[0], id: archivedPoId, subject: 'QA 보관된 연결 초안', status: 'draft', sentAt: '', attempts: 0, providerRequestId: null, senderEmailSnapshot: null, voided: true, version: 2, idempotencyKey: 'qa-archived-draft' })
      w.productionRuns[0].poId = archivedPoId
    }
    if (incompatibleSource) w.productionPoContexts.push({ poId, source: 'style', capturedAt: stamp.createdAt, snapshot: { styleId: style.id, projectId: w.projects.find(item => item.id !== project.id)!.id, projectCode: 'OTHER-PROJECT', factoryId: style.factoryId, runId: null, lineId: null, styleCode: style.code, color: null, order: null, productionMode: null, lines: [{ lineId: line.id, color: line.color, styleCode: `${code}BK`, order: { ...line.order } }] } })
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, code: CODE, poId: PO, runId: RUN, incompatibleSource, archivedDraft, archivedPoId: ARCHIVED_PO })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function openPO(page: Page) {
  await page.getByRole('button', { name: `${CODE}BK`, exact: true }).click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /^PO/ }).click()
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

for (const mobile of [false, true]) test(`보관된 초안 연결을 정확히 표시하고 문서 확인 후 발송 PO로 교체한다 · ${mobile ? '모바일' : 'PC'}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page, false, true)
  const before = await snapshot(page)
  await page.getByRole('button', { name: `${CODE}BK`, exact: true }).click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /^생산 조건 협의/ }).click()
  await expect(detail).toContainText('보관된 미발송 초안이 이 차수에 연결되어 있어 발송 대기로 표시됩니다.')
  await detail.getByRole('tab', { name: /^생산 차수/ }).click()
  await detail.getByRole('button', { name: '차수 수정', exact: true }).click()
  await expect(detail.getByLabel('생산 차수 PO', { exact: true })).toHaveValue(ARCHIVED_PO)
  await expect(detail.getByLabel('생산 차수 PO', { exact: true }).locator('option:checked')).toHaveText('QA 보관된 연결 초안 · 보관된 초안')
  await detail.getByRole('button', { name: '차수 편집 취소', exact: true }).click()
  await detail.getByRole('tab', { name: /^PO/ }).click()
  const card = detail.locator('.ops-po-card').filter({ has: page.getByRole('heading', { name: 'QA 보존할 발송 PO', exact: true }) })
  const panel = card.getByRole('region', { name: '생산 차수 PO 연결', exact: true })
  await panel.getByRole('button', { name: '기존 생산 차수에 연결', exact: true }).click()
  await panel.getByLabel('연결할 기존 생산 차수', { exact: true }).selectOption(RUN)
  await expect(panel).toContainText('현재 연결: QA 보관된 연결 초안')
  await panel.getByLabel('발송 문서 생산 조건 확인', { exact: true }).check()
  await panel.getByLabel('수량 집계 범위 차이 확인', { exact: true }).check()
  await panel.getByLabel('기존 PO 비교 정보 미등록 확인', { exact: true }).check()
  await panel.getByLabel('PO 연결 확인 사유', { exact: true }).fill('QA 실제 발송 문서 확인 후 보관된 초안 연결 교체')
  const replace = panel.getByRole('button', { name: '확인한 발송 PO로 연결 교체', exact: true })
  await expect(replace).toBeDisabled()
  await panel.getByLabel('보관된 미발송 초안 연결 교체 확인', { exact: true }).check()
  await replace.click()
  await expect(panel).toContainText('생산 차수 연결됨')
  const after = await snapshot(page)
  expect(after.productionRuns![0]).toMatchObject({ poId: PO, version: 2, order: before.productionRuns![0].order })
  expect(after.operations!.poDispatches).toEqual(before.operations!.poDispatches)
  expect(after.operations!.poDispatchAttempts).toEqual(before.operations!.poDispatchAttempts)
  expect(after.styles).toEqual(before.styles)
  await detail.getByRole('tab', { name: /^생산 조건 협의/ }).click()
  await expect(detail.locator('.supplier-order-card > header')).toContainText('업체 회신 대기')
  expect(after.productionConditions?.find(item => item.runId === RUN)?.approval).toBeFalsy()
  if (mobile) await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('발송 시도 이력이 있는 보관 PO의 연결은 교체 후보에 표시하지 않는다', async ({ page }) => {
  await fixture(page, false, true)
  await page.evaluate(({ key, poId }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    w.operations!.poDispatches.find(po => po.id === poId)!.attempts = 1
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, poId: ARCHIVED_PO })
  await page.reload()
  await page.getByRole('button', { name: `${CODE}BK`, exact: true }).click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /^PO/ }).click()
  const panel = detail.locator('.ops-po-card').filter({ has: page.getByRole('heading', { name: 'QA 보존할 발송 PO', exact: true }) }).getByRole('region', { name: '생산 차수 PO 연결', exact: true })
  await panel.getByRole('button', { name: '기존 생산 차수에 연결', exact: true }).click()
  await expect(panel).toContainText('연결 가능한 차수가 없습니다.')
  await expect(panel.getByLabel('연결할 기존 생산 차수', { exact: true }).locator('option')).toHaveCount(1)
  expect((await snapshot(page)).productionRuns![0].poId).toBe(ARCHIVED_PO)
})

for (const mobile of [false, true]) test(`연결된 보관 초안을 복원해도 내용·차수 연결을 유지하고 메일은 자동 발송하지 않는다 · ${mobile ? '모바일' : 'PC'}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page, false, true)
  const before = await snapshot(page)
  await page.getByRole('button', { name: `${CODE}BK`, exact: true }).click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /^생산 조건 협의/ }).click()
  await expect(detail).toContainText('연결된 초안 복원')
  await detail.getByRole('tab', { name: /^PO/ }).click()
  const card = detail.locator('.ops-po-card').filter({ has: page.getByRole('heading', { name: 'QA 보관된 연결 초안', exact: true }) })
  await card.getByRole('button', { name: '연결된 초안 복원', exact: true }).click()
  const confirm = detail.getByRole('alertdialog', { name: '연결된 미발송 PO 초안 복원', exact: true })
  await expect(confirm).toContainText('복원만으로 메일이 발송되지 않습니다.')
  await expect(confirm.getByRole('button', { name: '미발송 초안 복원 확인', exact: true })).toBeDisabled()
  await confirm.getByLabel('PO 복원 사유', { exact: true }).fill('QA 연결된 원본 발주 초안 복원')
  await confirm.getByRole('button', { name: '미발송 초안 복원 확인', exact: true }).click()
  await expect(confirm).not.toBeVisible()
  await expect(card).toContainText('초안 · 미발송')
  await expect(card.getByRole('button', { name: 'PO 메일 발송', exact: true })).toBeVisible()
  const after = await snapshot(page)
  const original = before.operations!.poDispatches.find(po => po.id === ARCHIVED_PO)!
  expect(after.operations!.poDispatches.find(po => po.id === ARCHIVED_PO)).toMatchObject({ ...original, voided: false, version: original.version + 1, updatedAt: expect.any(String), updatedBy: expect.any(String) })
  expect(after.operations!.poDispatches.filter(po => po.id !== ARCHIVED_PO)).toEqual(before.operations!.poDispatches.filter(po => po.id !== ARCHIVED_PO))
  expect(after.productionRuns).toEqual(before.productionRuns)
  expect(after.productionPoContexts).toEqual(before.productionPoContexts)
  expect(after.operations!.poDispatchAttempts).toEqual(before.operations!.poDispatchAttempts)
  expect(after.productionReceipts).toEqual(before.productionReceipts)
  expect(after.styles).toEqual(before.styles)
  await detail.getByRole('tab', { name: /^생산 조건 협의/ }).click()
  await expect(detail.locator('.supplier-order-card > header')).toContainText('PO 발송 대기')
  await expect(detail).not.toContainText('보관된 미발송 초안이 이 차수에 연결되어 있어')
  if (mobile) await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})
