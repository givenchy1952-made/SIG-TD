import { test, expect } from '@playwright/test'

const expiredFragment = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb='

test('만료된 인증 링크를 체험 환경에서 열어도 한국어 오류와 재인증 안내를 표시한다', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => sessionStorage.setItem('sig-demo-logout', 'true'))
  await page.goto(`/${expiredFragment}`)
  const notice = page.getByRole('alert').filter({ hasText: /만료|유효/ }).first()
  await expect(notice).toBeVisible()
  await expect(notice).toContainText(/인증|링크/)
  await expect(notice).toContainText(/다시|새로|재발송/)
  await expect(page.locator('body')).not.toContainText('Email link is invalid or has expired')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test('재발송은 이름·비밀번호 없이 이메일만 받고 실제 연결이 없으면 실패를 명확히 알린다', async ({ page }) => {
  const authRequests: string[] = []
  page.on('request', request => { if (new URL(request.url()).pathname.includes('/auth/v1/')) authRequests.push(request.url()) })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.getByRole('button', { name: '로그아웃', exact: true }).click()
  await expect(page.getByRole('heading', { name: '다시 만나 반갑습니다.' })).toBeVisible()
  const resend = page.getByRole('button', { name: '인증 메일 다시 받기', exact: true })
  await expect(resend).toBeVisible()
  await page.getByLabel('이메일', { exact: true }).fill('fixture@example.test')
  await expect(page.getByLabel('비밀번호', { exact: true })).toHaveValue('')
  await resend.click()
  await expect(page.getByRole('alert')).toContainText(/Supabase.*설정|연결 정보.*설정/)
  await expect(page.locator('.success-message')).toHaveCount(0)
  await page.getByRole('button', { name: '회원가입', exact: true }).click()
  await expect(page.getByRole('heading', { name: '워크스페이스 가입' })).toBeVisible()
  await expect(page.getByLabel('담당자 이름', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('비밀번호', { exact: true })).toHaveValue('')
  await page.getByRole('button', { name: '인증 메일 다시 받기', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(/Supabase.*설정|연결 정보.*설정/)
  await expect(page.locator('.success-message')).toHaveCount(0)
  await page.getByRole('button', { name: '로그인으로 돌아가기', exact: true }).click()
  await page.getByRole('button', { name: '비밀번호를 잊으셨나요?', exact: true }).click()
  await expect(page.getByRole('heading', { name: '비밀번호 재설정' })).toBeVisible()
  await expect(page.getByRole('button', { name: '인증 메일 다시 받기', exact: true })).toHaveCount(0)
  expect(authRequests).toEqual([])
})

test('오류가 없는 인증 토큰 fragment는 만료 오류로 오인하거나 제거하지 않는다', async ({ page }) => {
  const fragment = '#access_token=fixture-access&refresh_token=fixture-refresh&token_type=bearer&type=recovery'
  await page.goto(`/${fragment}`)
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: /만료|유효하지/ })).toHaveCount(0)
  expect(new URL(page.url()).hash).toBe(fragment)
  await expect(page.locator('body')).not.toContainText('fixture-access')
  await expect(page.locator('body')).not.toContainText('fixture-refresh')
})
