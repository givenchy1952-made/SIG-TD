import { test, expect, type Locator, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1'
const CODE = 'QAUNRECEIVED01'

async function ready(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, code }) => {
    const workspace = JSON.parse(localStorage.getItem(key)!) as Workspace
    const style = workspace.styles[0]
    style.code = code; style.name = 'QA 오더 대비 미입고'; style.stage = 'production'
    style.samples = []; style.ppApproved = false; style.colors = ['BK', 'OW']
    style.production = style.production.slice(0, 2)
    const sizes = ['XXS', 'XS', 'S', 'M', 'L', 'XL'] as const
    style.production.forEach((line, index) => {
      line.color = style.colors[index]
      sizes.forEach((size, sizeIndex) => {
        line.order[size] = index ? 10 : [20, 30, 50, 60, 80, 50][sizeIndex]
        line.shipped[size] = line.received[size] = index ? [2, 10, 15, 0, 0, 0][sizeIndex] : [19, 30, 45, 55, 79, 49][sizeIndex]
      })
    })
    workspace.styles = [style]; workspace.comments = []; workspace.attachments = []
    workspace.audits = []; workspace.styleImages = []; workspace.productionRuns = []
    workspace.supplierProductionOrders = []
    if (workspace.operations) { workspace.operations.shipmentLedgers = []; workspace.operations.shipmentBatches = [] }
    localStorage.setItem(key, JSON.stringify(workspace))
  }, { key: STORAGE, code: CODE })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}

async function open(page: Page, color = 'BK') {
  await page.getByRole('button', { name: `${CODE}${color}`, exact: true }).click()
  const detail = page.getByRole('dialog')
  await expect(detail.getByRole('tab', { name: /^메인 생산/ })).toHaveAttribute('aria-selected', 'true')
  return detail
}

function remaining(detail: Locator) {
  return detail.locator('.quantity-table tbody tr').filter({ hasText: '오더 대비 미입고' })
}

async function snapshot(page: Page): Promise<Workspace> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE)
}

test('오더 290·입고 277이면 사이즈별 미입고 합계 13을 출고 대비 미입고와 함께 표시한다', async ({ page }) => {
  await ready(page)
  const before = await snapshot(page), detail = await open(page), row = remaining(detail)
  await expect(row.locator('td')).toHaveText(['1', '0', '5', '5', '1', '1', '13'])
  await expect(row.locator('input')).toHaveCount(0)
  const shipment = detail.locator('.quantity-table tbody tr').filter({ hasText: '출고 대비 미입고' })
  await expect(shipment.locator('td')).toHaveText(['0', '0', '0', '0', '0', '0', '0'])
  expect(await snapshot(page)).toEqual(before)
})

test('편집 즉시 재계산하고 초과 입고 사이즈가 다른 사이즈의 부족 수량을 차감하지 않는다', async ({ page }) => {
  await ready(page)
  const before = await snapshot(page), detail = await open(page), row = remaining(detail)
  await detail.getByLabel('BK 실 입고 수량 XXS', { exact: true }).fill('25')
  await expect(row.locator('td')).toHaveText(['0', '0', '5', '5', '1', '1', '12'])
  await detail.getByLabel('BK 오더 수량 M', { exact: true }).fill('70')
  await expect(row.locator('td')).toHaveText(['0', '0', '5', '15', '1', '1', '22'])
  expect(await snapshot(page)).toEqual(before)
  await detail.getByLabel('변경 사유', { exact: true }).fill('QA 사이즈별 오더 대비 미입고 재계산 검증')
  await detail.getByRole('button', { name: '변경 저장', exact: true }).click()
  await expect(detail.locator('.success-message')).toContainText('변경 내용을 저장했습니다.')
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await page.reload()
  const restored = await open(page)
  await expect(remaining(restored).locator('td')).toHaveText(['0', '0', '5', '15', '1', '1', '22'])
  const after = await snapshot(page)
  expect(after.styles[0].production[1]).toEqual(before.styles[0].production[1])
  expect(after.styles[0].samples).toEqual([])
  expect(after.styles[0].ppApproved).toBe(false)
})

test('컬러 전환 시 선택한 컬러의 오더·입고만 계산하고 이전 컬러 수량을 보존한다', async ({ page }) => {
  await ready(page)
  const before = await snapshot(page), detail = await open(page)
  await expect(remaining(detail).locator('td')).toHaveText(['1', '0', '5', '5', '1', '1', '13'])
  await detail.getByRole('tabpanel', { name: '메인 생산', exact: true }).locator('.production-color').filter({ hasText: `${CODE}OW` }).click()
  await expect(remaining(detail).locator('td')).toHaveText(['8', '0', '0', '10', '10', '10', '38'])
  await detail.getByRole('tabpanel', { name: '메인 생산', exact: true }).locator('.production-color').filter({ hasText: `${CODE}BK` }).click()
  await expect(remaining(detail).locator('td')).toHaveText(['1', '0', '5', '5', '1', '1', '13'])
  expect(await snapshot(page)).toEqual(before)
})
