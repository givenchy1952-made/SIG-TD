import { expect, test } from '@playwright/test'

test('Outlook popup callback stays isolated from site login and business data', async ({ page }) => {
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  await page.goto('/outlook-callback.html#code=fixture-code-not-a-real-token&state=fixture-state')
  await expect(page).toHaveTitle('Microsoft 365 연결')
  await expect(page.locator('body')).toContainText('연결을 처리하고 있습니다')
  await expect(page.locator('#root')).toHaveCount(0)
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([])
  expect(requests.filter(url => /supabase|graph\.microsoft|send-po-|\/assets\//.test(url))).toEqual([])
})

test('demo headquarters sees the Outlook connection explanation without pretending to connect', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.getByLabel('스타일 검색', { exact: true }).fill('BO42FYHD0102')
  await page.locator('.style-code').filter({ hasText: 'BO42FYHD0102' }).first().click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /생산 조건 협의·승인/ }).click(); await detail.locator('summary').filter({ hasText: /^전체 PO 이력/ }).click()
  await expect(detail.getByRole('region', { name: 'Microsoft 365 Outlook 발송 설정' })).toContainText('실제 Outlook 연결과 발송은 운영 사이트')
  await expect(detail.getByRole('button', { name: 'Outlook 연결', exact: true })).toHaveCount(0)
  await expect(detail.getByLabel('Microsoft 애플리케이션 ID')).toHaveCount(0)
})

test('factory cannot access Microsoft application setup or mailbox connection controls', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.getByLabel('체험 역할').selectOption('10000000-0000-4000-8000-000000000004')
  await page.getByLabel('스타일 검색', { exact: true }).fill('BO42FYHD0102')
  await page.locator('.style-code').filter({ hasText: 'BO42FYHD0102' }).first().click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /생산 조건 협의·승인/ }).click(); await detail.locator('summary').filter({ hasText: /^전체 PO 이력/ }).click()
  await expect(detail.getByRole('region', { name: 'Microsoft 365 Outlook 발송 설정' })).toHaveCount(0)
  await expect(detail.getByRole('button', { name: 'PO 작성', exact: true })).toHaveCount(0)
})
