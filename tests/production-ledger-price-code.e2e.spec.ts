import { expect, test, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1', CODE = 'QAPRICECODE1'
const RUN_A = 'a1000000-0000-4000-8000-000000000001', RUN_B = 'a1000000-0000-4000-8000-000000000002', RUN_BLANK = 'a1000000-0000-4000-8000-000000000003', RUN_CLOSED = 'a1000000-0000-4000-8000-000000000004'
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page, approved = false) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, code, ids, approved }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    const style = w.styles[1], line = style.production[0], admin = w.profiles.find(item => item.role === 'admin')!
    const projectA = w.projects.find(item => item.id === style.projectId)!, projectB = w.projects.find(item => item.id !== projectA.id)!
    projectA.name = 'QA 직접 단가 프로젝트 A'; projectA.code = 'QA-CODE-A'; projectB.name = 'QA 직접 단가 프로젝트 B'; projectB.code = 'QA-CODE-B'
    style.code = code; style.samples = []; style.stage = 'production'; style.production = [line]; style.colors = [line.color]
    w.styles = [style]; w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []
    const stamp = { version: 1, createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z', updatedBy: admin.id }
    const identity = { factoryIdSnapshot: style.factoryId, ownerIdSnapshot: style.ownerId, styleCodeSnapshot: `${code}${line.color}`, factoryNameSnapshot: 'QA 검토 공장', ownerNameSnapshot: admin.name }
    const order = { XXS: 0, XS: 0, S: 10, M: 0, L: 0, XL: 0 }
    w.productionRuns = ids.map((id, index) => ({ ...stamp, ...identity, id, styleId: style.id, lineId: line.id, projectId: index === 1 || index === 3 ? projectB.id : projectA.id, projectCode: index === 2 ? '' : index === 3 ? 'QA-CURRENT-B' : index === 1 ? 'QA-CODE-B' : 'QA-CODE-A', name: ['QA 검토 A', 'QA 검토 B', 'QA 코드 미입력', 'QA 확정 과거 B'][index], expectedDue: '2026-12-01', poId: null, unitCost: index === 3 ? 40 : index === 0 && approved ? 125 : null, itemType: 'product', order: { ...order }, correctsRunId: null, round: index + 1, createdAt: index === 0 ? '2026-10-30T00:00:00Z' : stamp.createdAt, closedAt: index === 3 ? stamp.createdAt : null, snapshot: index === 3 ? { ...identity, projectId: projectB.id, projectCode: 'QA-FROZEN-B', expectedDue: '2026-12-01', styleCode: `${code}${line.color}`, factory: identity.factoryNameSnapshot, owner: admin.name, name: 'QA 확정 과거 B', round: 4, poId: null, itemType: 'product', unitCost: 40, orderQuantity: 10, receivedQuantity: 4, netAmount: 160, vatAmount: 16, grossAmount: 176, lastReceivedAt: '2026-10-29', receipts: [], finalizedAt: stamp.createdAt, finalizedBy: admin.id } : null }))
    w.productionReceipts = []; w.productionRunAudits = []; w.supplierProductionOrders = []
    w.productionConditions = [{ runId: ids[0], runVersion: 1, poVersion: null, version: 0, productionMode: approved ? 'cmt' : null, internalUnitCost: approved ? 100 : null, status: approved ? 'approved' : 'awaiting_po', legacy: false, proposal: null, approval: approved ? { id: crypto.randomUUID(), finalDeliveryDate: '2026-12-01', unitCost: 125, approvedBy: admin.id, approvedByName: admin.name, approvedAt: stamp.createdAt, termsSnapshot: {}, poSnapshot: {} } : null, timeline: [], changeRequests: [] }]
    w.operations!.poDispatches = []; w.operations!.poDispatchAttempts = []
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, code: CODE, ids: [RUN_A, RUN_B, RUN_BLANK, RUN_CLOSED], approved })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function open(page: Page) {
  await page.locator('.style-code').filter({ hasText: CODE }).first().click()
  const detail = page.getByRole('dialog').filter({ has: page.getByRole('heading', { level: 1 }) })
  await detail.getByRole('tab', { name: /생산 차수·마감/ }).click()
  return { detail, ledger: detail.getByRole('region', { name: '프로젝트별 생산 차수 및 마감', exact: true }) }
}

for (const mobile of [false, true]) test(`차수 화면에서 생산 방식을 명시하고 검토 단가 0원·빈칸을 직접 저장한다 · ${mobile ? '모바일' : 'PC'}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  const before = await snapshot(page), { detail, ledger } = await open(page)
  const editor = ledger.getByRole('region', { name: '생산 차수 본사 검토 단가', exact: true })
  await editor.getByRole('button', { name: '본사 검토 단가 입력·수정', exact: true }).click()
  await expect(editor.getByLabel('차수 단가 생산 방식', { exact: true })).toHaveValue('')
  await editor.getByLabel('차수 본사 검토 단가', { exact: true }).fill('0')
  await editor.getByLabel('차수 단가 검토 사유', { exact: true }).fill('QA 원가 검토 0원 명시')
  await expect(editor.getByRole('button', { name: '본사 검토 단가 저장', exact: true })).toBeDisabled()
  await editor.getByLabel('차수 단가 생산 방식', { exact: true }).selectOption('cmt')
  await editor.getByRole('button', { name: '본사 검토 단가 저장', exact: true }).click()
  await expect(editor.locator('.production-run-price-heading>span')).toHaveText('0원')
  let saved = await snapshot(page)
  expect(saved.productionRuns!.find(run => run.id === RUN_A)).toMatchObject({ unitCost: null, version: 2 })
  expect(saved.productionConditions!.find(condition => condition.runId === RUN_A)).toMatchObject({ productionMode: 'cmt', internalUnitCost: 0, approval: null })
  await expect(detail.getByRole('tab', { name: /생산 차수·마감/ })).toHaveAttribute('aria-selected', 'true')
  await editor.getByRole('button', { name: '본사 검토 단가 입력·수정', exact: true }).click()
  await editor.getByLabel('차수 본사 검토 단가', { exact: true }).fill('')
  await editor.getByLabel('차수 단가 검토 사유', { exact: true }).fill('QA 검토 단가 미입력으로 변경')
  await editor.getByRole('button', { name: '본사 검토 단가 저장', exact: true }).click()
  await expect(editor.locator('.production-run-price-heading>span')).toHaveText('미입력')
  saved = await snapshot(page)
  expect(saved.productionConditions!.find(condition => condition.runId === RUN_A)?.internalUnitCost).toBeNull()
  expect(saved.productionRuns!.find(run => run.id === RUN_A)?.unitCost).toBeNull()
  expect(saved.styles).toEqual(before.styles); expect(saved.operations).toEqual(before.operations); expect(saved.productionReceipts).toEqual(before.productionReceipts)
  if (mobile) await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('수정 중 구조 변경을 먼저 저장한 뒤 같은 차수 화면에서 단가를 검토한다', async ({ page }) => {
  await fixture(page)
  const { ledger } = await open(page)
  await ledger.getByRole('button', { name: '차수 수정', exact: true }).click()
  const form = ledger.getByRole('region', { name: '생산 차수 편집', exact: true })
  await form.getByLabel('생산 차수명', { exact: true }).fill('QA 변경한 차수명')
  await expect(form.getByRole('button', { name: '본사 검토 단가 입력·수정', exact: true })).toBeDisabled()
  await expect(form).toContainText('변경 내용을 먼저 저장')
  await form.getByLabel('생산 차수 변경 사유', { exact: true }).fill('QA 차수 정보 변경')
  await form.getByRole('button', { name: '차수 저장', exact: true }).click()
  await expect(form).not.toBeVisible()
  await ledger.getByRole('button', { name: '본사 검토 단가 입력·수정', exact: true }).click()
  await ledger.getByLabel('차수 단가 생산 방식', { exact: true }).selectOption('full_package')
  await ledger.getByLabel('차수 본사 검토 단가', { exact: true }).fill('123.45')
  await ledger.getByLabel('차수 단가 검토 사유', { exact: true }).fill('QA 동일 화면 직접 검토')
  await ledger.getByRole('button', { name: '본사 검토 단가 저장', exact: true }).click()
  await expect(ledger.locator('.production-run-price-heading>span')).toHaveText('123.45원')
  const saved = await snapshot(page)
  expect(saved.productionRuns!.find(run => run.id === RUN_A)).toMatchObject({ name: 'QA 변경한 차수명', unitCost: null })
})

test('오래된 차수 버전에서 검토 단가를 저장하지 않고 작성한 값을 보존한다', async ({ page }) => {
  await fixture(page)
  const { ledger } = await open(page)
  await ledger.getByRole('button', { name: '본사 검토 단가 입력·수정', exact: true }).click()
  await ledger.getByLabel('차수 단가 생산 방식', { exact: true }).selectOption('cmt')
  await ledger.getByLabel('차수 본사 검토 단가', { exact: true }).fill('315.50')
  await ledger.getByLabel('차수 단가 검토 사유', { exact: true }).fill('QA 동시 변경 보호')
  await page.evaluate(({ key, runId }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    w.productionRuns!.find(run => run.id === runId)!.version += 1
    localStorage.setItem(key, JSON.stringify(w)); window.dispatchEvent(new Event('sig-workspace-change'))
  }, { key: STORAGE, runId: RUN_A })
  await expect(ledger).toContainText('생산 차수나 검토 조건이 변경되었습니다.')
  await expect(ledger.getByRole('button', { name: '본사 검토 단가 저장', exact: true })).toBeDisabled()
  await expect(ledger.getByLabel('차수 본사 검토 단가', { exact: true })).toHaveValue('315.50')
  expect((await snapshot(page)).productionConditions!.find(condition => condition.runId === RUN_A)?.internalUnitCost).toBeNull()
})

test('변경하지 않은 차수 편집에서 검토 단가를 저장하면 최신 버전으로 안전하게 돌아온다', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page), { ledger } = await open(page)
  await ledger.getByRole('button', { name: '차수 수정', exact: true }).click()
  const form = ledger.getByRole('region', { name: '생산 차수 편집', exact: true })
  await form.getByRole('button', { name: '본사 검토 단가 입력·수정', exact: true }).click()
  await form.getByLabel('차수 단가 생산 방식', { exact: true }).selectOption('cmt')
  await form.getByLabel('차수 본사 검토 단가', { exact: true }).fill('87.25')
  await form.getByLabel('차수 단가 검토 사유', { exact: true }).fill('QA 변경 없는 차수에서 검토 단가 저장')
  await expect(form.getByRole('button', { name: '차수 저장', exact: true })).toBeDisabled()
  await form.getByRole('button', { name: '본사 검토 단가 저장', exact: true }).click()
  await expect(form).not.toBeVisible()
  await expect(ledger.locator('.production-run-price-heading>span')).toHaveText('87.25원')
  const saved = await snapshot(page), original = before.productionRuns!.find(run => run.id === RUN_A)!
  expect(saved.productionRuns!.find(run => run.id === RUN_A)).toMatchObject({ name: original.name, order: original.order, unitCost: null, version: original.version + 1 })
  await expect(ledger).not.toContainText('다른 사용자가 차수를 변경했습니다.')
})

test('최종 승인·마감 단가는 직접 입력으로 덮어쓰지 않는다', async ({ page }) => {
  await fixture(page, true)
  const before = await snapshot(page), { ledger } = await open(page)
  await expect(ledger.locator('.production-run-price-heading>span')).toHaveText('125원')
  await expect(ledger.getByRole('button', { name: '본사 검토 단가 입력·수정', exact: true })).toHaveCount(0)
  await ledger.getByRole('button', { name: '차수 수정', exact: true }).click()
  await expect(ledger.getByLabel('생산 차수 단가', { exact: true })).toBeDisabled()
  await ledger.getByRole('button', { name: '차수 편집 취소', exact: true }).click()
  await ledger.locator('.ledger-run').filter({ hasText: 'QA 확정 과거 B' }).click()
  await expect(ledger.locator('.production-run-price-heading>span')).toHaveText('40원')
  await expect(ledger.getByRole('button', { name: '차수 수정', exact: true })).toHaveCount(0)
  await expect(ledger.getByRole('button', { name: '본사 검토 단가 입력·수정', exact: true })).toHaveCount(0)
  expect(await snapshot(page)).toEqual(before)
})

test('차수 프로젝트 코드 검색·복수 선택과 명칭 교차 필터를 고정 코드 및 빈 코드에도 적용한다', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page), { ledger } = await open(page)
  await expect(ledger.locator('.ledger-run')).toHaveCount(4)
  await ledger.getByRole('button', { name: '생산 차수 프로젝트 코드 필터', exact: true }).click()
  const filter = page.getByRole('dialog', { name: '생산 차수 프로젝트 코드 필터 선택', exact: true })
  await filter.getByRole('button', { name: '선택해제', exact: true }).click()
  await filter.getByRole('searchbox', { name: '생산 차수 프로젝트 코드 필터 검색', exact: true }).fill('FROZEN')
  await filter.getByRole('checkbox', { name: 'QA-FROZEN-B', exact: true }).check()
  await page.keyboard.press('Escape')
  await expect(ledger.locator('.ledger-run')).toHaveCount(1)
  await expect(ledger.locator('.ledger-run')).toContainText('QA 확정 과거 B')
  await ledger.getByLabel('생산 차수 프로젝트 필터', { exact: true }).selectOption(before.styles[0].projectId)
  await expect(ledger.locator('.ledger-run')).toHaveCount(0)
  await ledger.getByRole('button', { name: '차수 필터 초기화', exact: true }).click()
  await ledger.getByRole('button', { name: '생산 차수 프로젝트 코드 필터', exact: true }).click()
  await filter.getByRole('button', { name: '선택해제', exact: true }).click()
  await filter.getByRole('checkbox', { name: 'QA-CODE-A', exact: true }).check()
  await filter.getByRole('checkbox', { name: '프로젝트 코드 미입력', exact: true }).check()
  await page.keyboard.press('Escape')
  await expect(ledger.locator('.ledger-run')).toHaveCount(2)
  await expect(ledger.getByLabel('선택한 차수 프로젝트 코드', { exact: true })).toContainText('프로젝트 코드 미입력')
  await ledger.getByRole('button', { name: '차수 필터 초기화', exact: true }).click()
  await expect(ledger.locator('.ledger-run')).toHaveCount(4)
  expect(await snapshot(page)).toEqual(before)
})
