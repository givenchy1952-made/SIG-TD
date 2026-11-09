import { expect, test, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1'
const ADMIN = '10000000-0000-4000-8000-000000000001', INTERNAL = '10000000-0000-4000-8000-000000000002'
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function menu(page: Page, name: string) {
  const mobile = page.getByRole('button', { name: '메뉴 열기', exact: true })
  if (await mobile.isVisible()) await mobile.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name, exact: true }).click()
}
async function fixture(page: Page, multiple = false) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, admin, internal, multiple }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    const style = w.styles.find(item => item.production.length)!
    w.styles = [style]; style.ownerId = admin
    for (const line of style.production) line.ownerId = admin
    w.operations!.employeeFactoryAssignments = multiple ? [admin, internal].map(employeeId => ({ employeeId, factoryIds: [style.factoryId], version: 1, createdAt: '', updatedAt: '', updatedBy: admin })) : []
    localStorage.setItem(key, JSON.stringify(w)); localStorage.setItem('sig-demo-profile', admin)
  }, { key: STORAGE, admin: ADMIN, internal: INTERNAL, multiple })
  await page.reload()
  return (await snapshot(page)).styles[0]
}
async function openProduction(page: Page, code: string) {
  await menu(page, '오버뷰')
  await page.getByLabel('스타일 검색', { exact: true }).fill(code)
  await page.locator('.style-code').filter({ hasText: code }).first().click()
  const detail = page.getByRole('dialog').filter({ has: page.getByRole('heading', { level: 1 }) })
  await detail.getByRole('tab', { name: /메인 생산/ }).click()
  return detail
}

test('공장 배정 한 번으로 기존 스타일·컬러의 담당자가 연결되고 메인 생산에서 재선택하지 않는다', async ({ page }) => {
  const style = await fixture(page), before = await snapshot(page)
  const internal = before.profiles.find(person => person.id === INTERNAL)!, factory = before.factories.find(item => item.id === style.factoryId)!
  await menu(page, '사용자 · 기본 설정')
  await page.getByRole('button', { name: `${internal.name} 담당 공장 배정`, exact: true }).click()
  const modal = page.getByRole('dialog', { name: '담당 공장 배정', exact: true })
  await modal.getByText(factory.name, { exact: true }).locator('..').getByRole('checkbox').check()
  await modal.getByLabel('공장 배정 변경 사유', { exact: true }).fill('QA 공장 단위 담당자 연결')
  await modal.getByRole('button', { name: '배정 저장', exact: true }).click()
  await expect(modal).not.toBeVisible()
  await expect.poll(async () => (await snapshot(page)).styles[0].ownerId).toBe(INTERNAL)
  const after = await snapshot(page)
  expect(after.styles[0].production.every(line => line.ownerId === INTERNAL)).toBe(true)
  expect(after.styles[0].samples).toEqual(before.styles[0].samples)
  expect(after.styles[0].production.map(line => [line.order, line.shipped, line.received])).toEqual(before.styles[0].production.map(line => [line.order, line.shipped, line.received]))
  expect(after.productionRuns).toEqual(before.productionRuns)
  const detail = await openProduction(page, style.code)
  await expect(detail.getByLabel(`${style.production[0].color} 본사 담당자`, { exact: true })).toHaveValue(INTERNAL)
  await expect(detail.getByLabel(`${style.production[0].color} 본사 담당자`, { exact: true })).toBeDisabled()
  await expect(detail.locator('.detail-meta')).toContainText(`담당 ${internal.name}`)
  await expect(detail.getByText('공장에 배정된 본사 담당자가 자동 연결됩니다.', { exact: true })).toBeVisible()
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await page.getByRole('button', { name: '스타일 등록', exact: true }).click()
  const form = page.getByRole('dialog', { name: '새 스타일 등록', exact: true })
  await form.getByLabel('담당 공장', { exact: false }).selectOption(factory.id)
  await expect(form.getByLabel('본사 담당자', { exact: true })).toHaveValue(INTERNAL)
  await expect(form.getByLabel('본사 담당자', { exact: true })).toBeDisabled()
  await form.getByLabel('스타일 코드', { exact: false }).fill('QAOWNERNEW01')
  await form.getByLabel('제품명', { exact: false }).fill('QA 공장 담당자 자동 등록')
  await form.getByRole('button', { name: '스타일 등록', exact: true }).click()
  await expect(form).not.toBeVisible()
  const registered = (await snapshot(page)).styles.find(item => item.code === 'QAOWNERNEW01')!
  expect(registered.ownerId).toBe(INTERNAL)
  expect(registered.production.every(line => line.ownerId === INTERNAL)).toBe(true)
})

test('담당자가 여러 명인 공장은 임의 선택하지 않고 기존 명시 담당자를 유지하며 변경할 수 있다', async ({ page }) => {
  const style = await fixture(page, true), detail = await openProduction(page, style.code)
  const owner = detail.getByLabel(`${style.production[0].color} 본사 담당자`, { exact: true })
  await expect(owner).toHaveValue(ADMIN); await expect(owner).toBeEnabled()
  await owner.selectOption(INTERNAL)
  await detail.getByLabel('변경 사유', { exact: true }).fill('QA 복수 담당 공장 제품 담당 지정')
  await detail.getByRole('button', { name: '변경 저장', exact: true }).click()
  await expect.poll(async () => (await snapshot(page)).styles[0].production[0].ownerId).toBe(INTERNAL)
})
