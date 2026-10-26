import { test, expect, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1'
const BASE = 'BP06FYHD0402'
async function ready(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, code }) => {
    const workspace = JSON.parse(localStorage.getItem(key)!) as Workspace
    const style = workspace.styles[0]
    style.code = code; style.name = 'QA 컬러별 제품'; style.stage = 'production'
    style.dueDate = ''; style.colors = ['BL', 'BK']
    style.production = style.production.slice(0, 2)
    style.production.forEach((line, index) => {
      line.color = style.colors[index]
      for (const field of ['order', 'shipped', 'received'] as const) for (const size of Object.keys(line[field]) as (keyof typeof line.order)[]) line[field][size] = 0
      line.order.M = index ? 250 : 100
      line.shipped.M = index ? 70 : 20
      line.received.M = index ? 30 : 10
      line.ownerId = index ? '' : workspace.profiles[1].id
      line.checks.gb = index ? 'progress' : 'done'
    })
    workspace.styles = [style]
    workspace.comments = []; workspace.attachments = []; workspace.audits = []; workspace.styleImages = []
    localStorage.setItem(key, JSON.stringify(workspace))
  }, { key: STORAGE, code: BASE })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function navigate(page: Page, name: string) {
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name, exact: true }).click()
}
async function choose(page: Page, label: string, value: string) {
  await page.getByRole('button', { name: label, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `${label} 선택`, exact: true })
  await dialog.getByRole('button', { name: '선택해제', exact: true }).click()
  await dialog.getByRole('checkbox', { name: value, exact: true }).check()
  await page.keyboard.press('Escape')
}

test('메인 화면은 같은 스타일의 BL·BK를 전체 품번과 개별 수량으로 나누며 선택한 컬러 상세를 연다', async ({ page }) => {
  await ready(page)
  const rows = page.locator('.styles-table tbody tr')
  await expect(rows).toHaveCount(2)
  await expect(page.locator('.style-code')).toHaveText([`${BASE}BL`, `${BASE}BK`])
  await expect(rows.nth(0).locator('.numeric')).toHaveText(['100pcs', '10pcs'])
  await expect(rows.nth(1).locator('.numeric')).toHaveText(['250pcs', '30pcs'])
  await expect(rows.nth(0).locator('.owner-cell')).toContainText('천민영')
  await expect(rows.nth(1).locator('.owner-cell')).toContainText('미지정')
  await expect(page.locator('.table-heading .count-pill')).toHaveText('1')
  await expect(page.locator('.table-heading-sub')).toContainText('2개 컬러')
  await page.getByRole('button', { name: `${BASE}BK`, exact: true }).click()
  const detail = page.getByRole('dialog')
  await expect(detail.getByRole('heading', { level: 1 })).toContainText(`${BASE}BK`)
  await detail.getByRole('tab', { name: /^메인 생산/ }).click()
  await expect(detail.getByRole('tabpanel', { name: '메인 생산', exact: true }).locator('.production-color.active')).toContainText(`${BASE}BK`)
  await expect(detail.getByLabel('BK 오더 수량 M', { exact: true })).toHaveValue('250')
})

test('전체 품번 검색과 컬러 필터는 다른 컬러를 제외하고 메인 생산 출입고·상태도 혼합하지 않는다', async ({ page }) => {
  await ready(page)
  await page.getByLabel('스타일 검색', { exact: true }).fill(`${BASE}BL`)
  await expect(page.locator('.style-code')).toHaveText([`${BASE}BL`])
  await page.getByLabel('스타일 검색', { exact: true }).fill('')
  await navigate(page, '메인 생산')
  const rows = page.locator('.styles-table tbody tr')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0).locator('.numeric')).toHaveText(['100pcs', '20', '10'])
  await expect(rows.nth(1).locator('.numeric')).toHaveText(['250pcs', '70', '30'])
  await page.getByRole('button', { name: '상세 필터', exact: true }).click()
  await choose(page, '컬러', 'BK')
  await expect(page.locator('.style-code')).toHaveText([`${BASE}BK`])
  await expect(page.locator('.active-filter-row')).toContainText('오더 250 pcs')
})

test('담당자 미지정 필터는 Y열이 비어 있는 컬러만 표시한다', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: '상세 필터', exact: true }).click()
  await choose(page, '담당자', '미지정')
  await expect(page.locator('.style-code')).toHaveText([`${BASE}BK`])
  await expect(page.locator('.owner-cell')).toContainText('미지정')
  await expect(page.locator('.active-filter-row')).toContainText('오더 250 pcs')
})

test('미지정 컬러의 담당자를 나중에 수동 배정하고 다른 컬러 담당자는 유지한다', async ({ page }) => {
  await ready(page)
  const before = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!) as Workspace, STORAGE)
  const expectedOwner = before.profiles.find(profile => profile.role === 'admin')!
  const otherColor = structuredClone(before.styles[0].production.find(line => line.color === 'BL')!)
  await page.getByRole('button', { name: `${BASE}BK`, exact: true }).click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /^메인 생산/ }).click()
  await expect(detail.getByLabel('BK 본사 담당자', { exact: true })).toHaveValue('')
  await detail.getByLabel('BK 본사 담당자', { exact: true }).selectOption(expectedOwner.id)
  await detail.getByLabel('변경 사유', { exact: true }).fill('QA 파일 담당자 공란 이후 BK 컬러 담당자 수동 배정')
  await detail.getByRole('button', { name: '변경 저장', exact: true }).click()
  await expect(detail.locator('.success-message')).toContainText('변경 내용을 저장했습니다.')
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await page.reload()
  const after = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!) as Workspace, STORAGE)
  expect(after.styles[0].production.find(line => line.color === 'BK')!.ownerId).toBe(expectedOwner.id)
  expect(after.styles[0].production.find(line => line.color === 'BL')).toEqual(otherColor)
  await expect(page.locator('.styles-table tbody tr').filter({ has: page.getByRole('button', { name: `${BASE}BK`, exact: true }) }).locator('.owner-cell')).toContainText(expectedOwner.name)
})
