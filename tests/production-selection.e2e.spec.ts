import { expect, test, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1', CODE = 'QA06FYHD0001'
const PROJECT_A = '99280000-0000-4000-8000-000000000001', PROJECT_B = '99280000-0000-4000-8000-000000000002'
const LINE_BK = '99281000-0000-4000-8000-000000000001', LINE_GR = '99281000-0000-4000-8000-000000000002', LINE_OT = '99281000-0000-4000-8000-000000000003'
const RUN_BK = '99282000-0000-4000-8000-000000000001', RUN_GR_A = '99282000-0000-4000-8000-000000000002', RUN_OT = '99282000-0000-4000-8000-000000000003', RUN_GR_B = '99282000-0000-4000-8000-000000000004'
const NAME_A = 'QA 컬러 선택 프로젝트 A', NAME_B = 'QA 컬러 선택 프로젝트 B'
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, code, projects, lines, runs, names }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace, style = w.styles[1], template = style.production[0], admin = w.profiles.find(person => person.role === 'admin')!
    const zero = { XXS: 0, XS: 0, S: 0, M: 0, L: 0, XL: 0 }
    style.code = code; style.name = 'QA 선택 문맥 검증'; style.projectId = projects[0]; style.stage = 'production'; style.samples = []; style.colors = ['BK', 'GR', 'OT']
    style.production = lines.map((id, index) => ({ ...structuredClone(template), id, color: style.colors[index], order: { ...zero, M: (index + 1) * 100 }, shipped: { ...zero }, received: { ...zero }, shippedAt: '', receivedAt: '' }))
    w.projects = projects.map((id, index) => ({ id, code: `QA-SELECTION-${index + 1}`, name: names[index], season: '2026FY' })); w.styles = [style]
    w.attachments = []; w.styleImages = []; w.comments = []; w.audits = []; w.productionReceipts = []; w.productionRunAudits = []
    w.productionRuns = runs.map((id, index) => {
      const colorIndex = index === 3 ? 1 : index, projectIndex = index === 3 ? 1 : 0, line = style.production[colorIndex], now = `2026-11-0${index + 1}T00:00:00Z`
      return { id, styleId: style.id, lineId: line.id, projectId: projects[projectIndex], projectCode: w.projects[projectIndex].code!, name: `QA ${line.color} ${projectIndex + 1}`, round: index + 1, expectedDue: '2026-12-01', poId: null, unitCost: null, itemType: 'product', order: { ...zero, M: index === 3 ? 90 : (index + 1) * 100 }, correctsRunId: null, factoryIdSnapshot: style.factoryId, factoryNameSnapshot: w.factories.find(factory => factory.id === style.factoryId)!.name, ownerIdSnapshot: admin.id, ownerNameSnapshot: admin.name, styleCodeSnapshot: code + line.color, version: 1, createdAt: now, updatedAt: now, updatedBy: admin.id, closedAt: null, snapshot: null }
    })
    w.supplierProductionOrders = []; w.productionConditions = []; w.productionPoContexts = []; w.partialDeliveryPlans = []
    localStorage.setItem(key, JSON.stringify(w)); localStorage.setItem('sig-demo-profile', admin.id)
  }, { key: STORAGE, code: CODE, projects: [PROJECT_A, PROJECT_B], lines: [LINE_BK, LINE_GR, LINE_OT], runs: [RUN_BK, RUN_GR_A, RUN_OT, RUN_GR_B], names: [NAME_A, NAME_B] })
  await page.reload()
  await expect(page.getByRole('button', { name: `${CODE}GR`, exact: true })).toBeVisible()
}

for (const mobile of [false, true]) test(`GR 행의 컬러·프로젝트가 조건 협의·차수·메인 생산 사이에서 유지된다 · ${mobile ? '모바일' : 'PC'}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  const before = await snapshot(page)
  await page.getByRole('button', { name: `${CODE}GR`, exact: true }).click()
  const detail = page.getByRole('dialog')
  await expect(detail.getByRole('heading', { level: 1 })).toContainText(`${CODE}GR`)
  await detail.getByRole('tab', { name: /생산 조건 협의·승인/ }).click()
  await expect(detail.locator(`input[data-run-id="${RUN_GR_A}"]`)).toBeChecked()
  await expect(detail.locator('.supplier-order-summary')).toContainText(NAME_A)
  await expect(detail.locator('.supplier-order-summary')).toContainText('GR')
  await detail.getByRole('tab', { name: /생산 차수·마감/ }).click()
  await expect(detail.locator('.ledger-run.active')).toContainText('QA GR 1')
  await detail.getByRole('tab', { name: /메인 생산/ }).click()
  await expect(detail.getByRole('tabpanel', { name: '메인 생산', exact: true }).locator('.production-color.active')).toContainText('GR')
  const context = detail.getByRole('region', { name: '선택한 프로젝트 생산 현황', exact: true })
  await expect(context).toContainText(NAME_A)
  await expect(context.locator('div').filter({ has: page.locator('dt', { hasText: /^오더 수량$/ }) }).locator('dd')).toHaveText('200장')
  await detail.getByRole('tab', { name: /생산 조건 협의·승인/ }).click()
  await detail.locator(`input[data-run-id="${RUN_GR_B}"]`).check()
  await expect(detail.locator('.supplier-order-summary')).toContainText(NAME_B)
  await expect(detail.getByRole('heading', { level: 1 })).toContainText(`${CODE}GR`)
  await detail.getByRole('tab', { name: /생산 차수·마감/ }).click()
  await expect(detail.locator('.ledger-run.active')).toContainText('QA GR 2')
  await detail.getByRole('tab', { name: /메인 생산/ }).click()
  await expect(context).toContainText(NAME_B)
  await expect(context.locator('div').filter({ has: page.locator('dt', { hasText: /^오더 수량$/ }) }).locator('dd')).toHaveText('90장')
  await expect(detail.getByLabel('GR 오더 수량 M', { exact: true })).toHaveValue('200')
  const after = await snapshot(page)
  expect(after.styles).toEqual(before.styles); expect(after.productionRuns).toEqual(before.productionRuns)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('프로젝트·생산 차수별 현황 상세는 클릭한 차수의 컬러·프로젝트를 전달한다', async ({ page }) => {
  await fixture(page)
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '메인 생산', exact: true }).click()
  const board = page.getByRole('region', { name: '프로젝트·생산 차수별 현황', exact: true })
  await board.getByRole('button', { name: `${CODE}GR ${NAME_B} 4차 상세`, exact: true }).click()
  const detail = page.getByRole('dialog')
  await expect(detail.getByRole('heading', { level: 1 })).toContainText(`${CODE}GR`)
  await detail.getByRole('tab', { name: /생산 조건 협의·승인/ }).click()
  await expect(detail.locator(`input[data-run-id="${RUN_GR_B}"]`)).toBeChecked()
  await expect(detail.locator('.supplier-order-summary')).toContainText(NAME_B)
  await detail.getByRole('tab', { name: /생산 차수·마감/ }).click()
  await expect(detail.locator('.ledger-run.active')).toContainText('QA GR 2')
})

test('입고 확정 전에는 다른 탭에서도 컬러·차수를 바꾸지 않고 입력 문맥을 유지한다', async ({ page }) => {
  await fixture(page)
  await page.getByRole('button', { name: `${CODE}GR`, exact: true }).click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /메인 생산/ }).click()
  await detail.getByLabel('GR 실 입고 수량 M', { exact: true }).fill('10')
  await detail.getByRole('tab', { name: /생산 차수·마감/ }).click()
  await expect(detail.locator('.ledger-run').filter({ hasText: 'QA BK 1' })).toBeDisabled()
  await expect(detail.getByRole('button', { name: '생산 차수 추가', exact: true })).toBeDisabled()
  await expect(detail.locator('.ledger-run.active')).toContainText('QA GR 1')
  await detail.getByRole('tab', { name: /을지·단가/ }).click()
  const settlement = detail.getByRole('region', { name: '을지 및 단가 관리', exact: true })
  await expect(settlement.locator('.production-color').filter({ hasText: `${CODE}BK` })).toBeDisabled()
  await expect(settlement.getByLabel('을지 생산 차수 선택', { exact: true })).toBeDisabled()
  await expect(settlement.locator('.production-color.active')).toContainText('GR')
  await expect(detail.getByRole('heading', { level: 1 })).toContainText(`${CODE}GR`)
  await detail.getByRole('tab', { name: /메인 생산/ }).click()
  await expect(detail.getByLabel('GR 실 입고 수량 M', { exact: true })).toHaveValue('10')
  await detail.getByLabel('GR 실 입고 수량 M', { exact: true }).fill('0')
  await detail.getByRole('tab', { name: /을지·단가/ }).click()
  await settlement.locator('.production-color').filter({ hasText: `${CODE}BK` }).click()
  await expect(detail.getByRole('heading', { level: 1 })).toContainText(`${CODE}BK`)
})

test('차수 등록에서 선택한 컬러·프로젝트가 저장 후 모든 생산 탭에 연결된다', async ({ page }) => {
  await fixture(page)
  await page.getByRole('button', { name: `${CODE}GR`, exact: true }).click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /생산 차수·마감/ }).click()
  await detail.getByRole('button', { name: '생산 차수 추가', exact: true }).click()
  await detail.getByLabel('생산 차수명', { exact: true }).fill('QA 새 BK 프로젝트 B')
  await detail.getByLabel('생산 차수 컬러', { exact: true }).selectOption(LINE_BK)
  await detail.getByLabel('생산 차수 프로젝트 명칭', { exact: true }).selectOption(PROJECT_B)
  await detail.getByLabel('차수 오더 M', { exact: true }).fill('5')
  await detail.getByLabel('생산 차수 변경 사유', { exact: true }).fill('QA 컬러와 프로젝트 문맥 자동 연결')
  await detail.getByRole('button', { name: '차수 저장', exact: true }).click()
  await expect(detail.locator('.ledger-run.active')).toContainText('QA 새 BK 프로젝트 B')
  await expect(detail.getByRole('heading', { level: 1 })).toContainText(`${CODE}BK`)
  await detail.getByRole('tab', { name: /메인 생산/ }).click()
  const context = detail.getByRole('region', { name: '선택한 프로젝트 생산 현황', exact: true })
  await expect(context).toContainText(NAME_B)
  await expect(context).toContainText('QA 새 BK 프로젝트 B')
  await detail.getByRole('tab', { name: /생산 조건 협의·승인/ }).click()
  const stored = await snapshot(page), run = stored.productionRuns!.find(item => item.name === 'QA 새 BK 프로젝트 B')!
  await expect(detail.locator(`input[data-run-id="${run.id}"]`)).toBeChecked()
  expect(stored.styles[0].projectId).toBe(PROJECT_A)
})
