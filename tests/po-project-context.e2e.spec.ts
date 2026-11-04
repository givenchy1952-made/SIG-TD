import { expect, test, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1', CODE = 'QAPOCONTEXT01'
const PO = '98940000-0000-4000-8000-000000000001', RUN = '98940000-0000-4000-8000-000000000002'
const M_CURRENT = '시그니피컨트 현재 생산', M_PREVIOUS = '시그니피컨트 이전 생산'
const A_CURRENT = 'SIGNIFICANT-2026FY-MPQ-46093', A_PREVIOUS = 'SIGNIFICANT-2026FY-RPQ-46318'
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page, budgetDraft = false) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, code, poId, runId, currentName, previousName, currentCode, previousCode, budgetDraft }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    const style = w.styles[1], line = style.production[0], admin = w.profiles.find(person => person.role === 'admin')!
    const [current, previous] = w.projects
    current.name = currentName; current.code = currentCode; previous.name = previousName; previous.code = previousCode
    style.projectId = current.id; style.code = code; style.production = [line]; style.samples = []; style.colors = ['BK']; style.stage = 'production'; line.color = 'BK'
    const quantities = { XXS: 1, XS: 2, S: 3, M: 4, L: 5, XL: 6 }
    line.order = { ...quantities }
    w.styles = [style]; w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []
    const stamp = { version: 1, createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z', updatedBy: admin.id }
    const projectText = budgetDraft ? previousCode : previousName
    w.operations!.poDispatches = [{ ...stamp, id: poId, styleId: style.id, dueDate: '2026-12-20', recipient: 'supplier@example.test', subject: `[PO] ${projectText} / ${code}`, body: `프로젝트 명칭: ${projectText}\nQA 실제 발송하지 않는 문맥 검증`, evidenceAttachmentId: null, status: 'draft', sentAt: '', providerMessageId: null, lastError: null, attempts: 0, idempotencyKey: 'qa-project-context', factoryIdSnapshot: style.factoryId, styleCodeSnapshot: style.code, voided: false }]
    w.operations!.poDispatchAttempts = []; w.operations!.orderSourceRecords = []; w.operations!.shipmentLedgers = []; w.operations!.shipmentBatches = []; w.operations!.styleOperations = []
    w.productionRuns = [{ ...stamp, id: runId, styleId: style.id, lineId: line.id, projectId: previous.id, projectCode: previousCode, name: '이전 프로젝트 발주 차수', expectedDue: '2026-12-20', poId, unitCost: null, itemType: 'product', order: quantities, correctsRunId: null, factoryIdSnapshot: style.factoryId, factoryNameSnapshot: w.factories.find(item => item.id === style.factoryId)!.name, styleCodeSnapshot: `${code}BK`, ownerIdSnapshot: style.ownerId, ownerNameSnapshot: admin.name, round: 1, closedAt: null, snapshot: null }]
    w.productionPoContexts = [{ poId, source: 'run', capturedAt: stamp.createdAt, snapshot: { styleId: style.id, projectId: previous.id, projectCode: previousCode, factoryId: style.factoryId, runId, lineId: line.id, styleCode: `${code}BK`, color: 'BK', order: quantities, lines: [], productionMode: 'full_package' } }]
    w.productionConditions = []; w.supplierProductionOrders = []; w.productionReceipts = []; w.productionRunAudits = []; w.partialDeliveryPlans = []
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, code: CODE, poId: PO, runId: RUN, currentName: M_CURRENT, previousName: M_PREVIOUS, currentCode: A_CURRENT, previousCode: A_PREVIOUS, budgetDraft })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.getByRole('button', { name: `${CODE}BK`, exact: true }).click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /생산 조건 협의·승인/ }).click()
  return detail
}

test('스타일이 다른 프로젝트로 이동해도 연결된 차수의 M 명칭으로 발송을 확인하며 체험 메일은 보내지 않는다', async ({ page }) => {
  const sentRequests: string[] = []
  await page.route('**/functions/v1/send-po-*', route => { sentRequests.push(route.request().url()); return route.abort() })
  const detail = await fixture(page), before = await snapshot(page)
  await expect(detail.getByLabel('PO 프로젝트 명칭', { exact: true })).toContainText(M_PREVIOUS)
  const card = detail.getByRole('region', { name: '이 차수 PO 발송', exact: true })
  await expect(card).toContainText(M_PREVIOUS)
  await card.getByRole('button', { name: 'PO 메일 발송', exact: true }).click()
  const confirm = detail.getByRole('alertdialog', { name: 'PO 메일 발송 확인', exact: true })
  await expect(confirm).toContainText(M_PREVIOUS)
  await confirm.getByRole('button', { name: '발송 확인', exact: true }).click()
  await expect(detail.getByRole('alert')).toContainText('체험 모드에서는 실제 메일을 발송하지 않습니다.')
  expect(sentRequests).toEqual([])
  const after = await snapshot(page)
  expect(after.operations).toEqual(before.operations)
  expect(after.productionRuns).toEqual(before.productionRuns)
  expect(after.productionPoContexts).toEqual(before.productionPoContexts)
})

test('이전 프로젝트 미발송 초안의 편집과 EML 파일명은 해당 차수의 M 명칭을 유지한다', async ({ page }) => {
  const detail = await fixture(page), before = await snapshot(page)
  await detail.getByRole('region', { name: '이 차수 PO 발송', exact: true }).getByRole('button', { name: 'PO 초안 수정', exact: true }).click()
  await expect(detail.getByLabel('PO 메일 제목', { exact: true })).toHaveValue(new RegExp(M_PREVIOUS))
  const pending = page.waitForEvent('download')
  await detail.getByRole('button', { name: '메일 초안 다운로드 (.eml)', exact: true }).click()
  const file = await pending
  expect(file.suggestedFilename()).toContain(M_PREVIOUS)
  expect(file.suggestedFilename()).not.toContain(M_CURRENT)
  expect(file.suggestedFilename()).not.toContain(A_PREVIOUS)
  await detail.getByRole('button', { name: 'PO 편집 취소', exact: true }).click()
  expect((await snapshot(page)).operations).toEqual(before.operations)
})

test('이전 차수의 A 코드가 들어간 미발송 초안은 발송하지 않고 원본·시도 기록을 유지한다', async ({ page }) => {
  const detail = await fixture(page, true), before = await snapshot(page)
  await detail.getByRole('region', { name: '이 차수 PO 발송', exact: true }).getByRole('button', { name: 'PO 메일 발송', exact: true }).click()
  await detail.getByRole('alertdialog', { name: 'PO 메일 발송 확인', exact: true }).getByRole('button', { name: '발송 확인', exact: true }).click()
  await expect(detail.getByRole('alert')).toContainText('예산 관리 코드')
  expect((await snapshot(page)).operations).toEqual(before.operations)
})
