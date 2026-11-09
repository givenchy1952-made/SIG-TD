import { expect, test, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'
import type { ProductionRun } from '../src/lib/production-ledger'
import type { ProductionCondition } from '../src/lib/production-conditions'

const STORAGE = 'sig-workspace-demo-v1', CODE = 'QA16FYTS0001'
async function fixture(page: Page, mode: 'approved' | 'pending' | 'multiple' = 'approved') {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  const ids = await page.evaluate(({ key, code, mode }) => {
    const workspace = JSON.parse(localStorage.getItem(key)!) as Workspace, style = workspace.styles[0]
    const actor = workspace.profiles.find(person => person.role === 'admin')!, stamp = '2026-11-09T00:00:00Z'
    style.code = code; style.stage = 'production'; style.samples = []; style.production = style.production.slice(0, 2)
    style.colors = ['BK', 'GR']; style.production.forEach((line, index) => { line.color = style.colors[index]; line.received = { XXS: 0, XS: 0, S: 0, M: 99, L: 0, XL: 0 }; line.receivedAt = '2026-11-01' })
    workspace.styles = [style]; workspace.productionRuns = []; workspace.productionReceipts = []; workspace.productionConditions = []
    workspace.settlementTermsAvailable = true; workspace.productionLedgerAvailable = true; workspace.productionConditionsAvailable = true
    workspace.settlementTerms = style.production.map(line => ({ styleId: style.id, lineId: line.id, projectCode: 'QA-OLD-MANUAL', unitCost: 999, itemType: 'label', version: 1, createdAt: stamp, updatedAt: stamp, updatedBy: actor.id }))
    const make = (index: number, unitCost: number, round = 1) => {
      const line = style.production[index], run: ProductionRun = { id: crypto.randomUUID(), styleId: style.id, lineId: line.id, projectId: style.projectId, projectCode: 'QA-APPROVED-PROJECT', name: `QA ${line.color} 생산`, round, expectedDue: '2026-11-20', poId: null, unitCost, itemType: 'product', order: { XXS: 0, XS: 0, S: 0, M: 10, L: 0, XL: 0 }, correctsRunId: null, factoryIdSnapshot: style.factoryId, ownerIdSnapshot: style.ownerId, styleCodeSnapshot: `${code}${line.color}`, factoryNameSnapshot: 'QA 승인 공장', ownerNameSnapshot: 'QA 승인 담당자', version: 3, createdAt: stamp, updatedAt: stamp, updatedBy: actor.id, closedAt: null, snapshot: null }
      const condition: ProductionCondition = { runId: run.id, runVersion: run.version, poVersion: null, version: 2, productionMode: 'full_package', status: mode === 'pending' ? 'awaiting_approval' : 'approved', legacy: false, internalUnitCost: 456, proposal: null, approval: mode === 'pending' ? null : { id: crypto.randomUUID(), finalDeliveryDate: '2026-11-20', unitCost, approvedBy: actor.id, approvedByName: actor.name, approvedAt: stamp, termsSnapshot: { runId: run.id, styleId: style.id, lineId: line.id, projectId: style.projectId }, poSnapshot: {} }, timeline: [], changeRequests: [] }
      workspace.productionRuns!.push(run); workspace.productionConditions!.push(condition)
      workspace.productionReceipts!.push({ id: crypto.randomUUID(), runId: run.id, styleId: style.id, lineId: line.id, receivedAt: '2026-11-09', quantities: { XXS: 0, XS: 0, S: 0, M: index ? 5 : 2, L: 0, XL: 0 }, unitCost, netAmount: unitCost * (index ? 5 : 2), voided: false, version: 1, createdAt: stamp, createdBy: actor.id })
      return run.id
    }
    make(0, 7.11); const gr = make(1, 12.34), extra = mode === 'multiple' ? make(1, 0, 2) : null
    localStorage.setItem(key, JSON.stringify(workspace)); localStorage.setItem('sig-demo-profile', actor.id)
    return { gr, extra }
  }, { key: STORAGE, code: CODE, mode })
  await page.reload()
  await page.getByLabel('스타일 검색', { exact: true }).fill(CODE)
  await page.locator('.style-code').filter({ hasText: CODE }).first().click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /을지·단가/ }).click()
  const panel = detail.getByRole('region', { name: '을지 및 단가 관리', exact: true })
  return { panel, ids }
}

test('을지 단가는 재입력 없이 선택한 컬러의 최종 승인과 차수 입고를 자동으로 사용한다', async ({ page }) => {
  const { panel } = await fixture(page)
  const before = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE)
  await expect(panel.getByLabel('장당 원가', { exact: true })).toHaveValue('7.11')
  await expect(panel.getByLabel('장당 원가', { exact: true })).toBeDisabled()
  await expect(panel.getByRole('button', { name: '단가·을지 정보 수정', exact: true })).toHaveCount(0)
  await panel.locator('.production-color').filter({ hasText: 'GR' }).click()
  await expect(panel.getByLabel('장당 원가', { exact: true })).toHaveValue('12.34')
  await expect(panel.getByLabel('을지 예산 관리 코드', { exact: true })).toHaveValue('QA-APPROVED-PROJECT')
  await expect(panel.locator('input[readonly]')).toHaveValue('5 EA / 2026-11-09')
  await expect(panel.getByRole('status')).toContainText('최종 승인한 단가가 자동 연결')
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE)).toEqual(before)
})

test('미승인 금액은 표시하지 않고 복수 차수는 선택 후 명시적 승인 0원도 연결한다', async ({ page }) => {
  let result = await fixture(page, 'pending')
  await expect(result.panel.getByLabel('장당 원가', { exact: true })).toHaveValue('')
  await expect(result.panel.getByRole('status')).toContainText('본사 최종 승인 후')
  await page.reload()
  result = await fixture(page, 'multiple')
  await result.panel.locator('.production-color').filter({ hasText: 'GR' }).click()
  await expect(result.panel.getByLabel('장당 원가', { exact: true })).toHaveValue('')
  await expect(result.panel.getByRole('status')).toContainText('여러 생산 차수')
  await result.panel.getByLabel('을지 생산 차수 선택', { exact: true }).selectOption(result.ids.extra!)
  await expect(result.panel.getByLabel('장당 원가', { exact: true })).toHaveValue('0')
})
