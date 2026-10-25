import { test, expect } from '@playwright/test'

const expiredFragment = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb='

test('만료된 이전 인증 링크는 한국어 오류와 본사 설정 확인 안내를 표시한다', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => sessionStorage.setItem('sig-demo-logout', 'true'))
  await page.goto(`/${expiredFragment}`)
  const notice = page.getByRole('alert').filter({ hasText: /만료|유효/ }).first()
  await expect(notice).toBeVisible()
  await expect(notice).toContainText(/인증|링크/)
  await expect(notice).toContainText(/다시|새로|재발송/)
  await expect(notice).toContainText('본사 담당자')
  await expect(page.getByRole('button', { name: '인증 메일 다시 받기', exact: true })).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('Email link is invalid or has expired')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test('메일 인증 없는 가입은 본사 승인·공장 배정을 안내하고 비밀번호 재설정은 유지한다', async ({ page }) => {
  const authRequests: string[] = []
  page.on('request', request => { if (new URL(request.url()).pathname.includes('/auth/v1/')) authRequests.push(request.url()) })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.getByRole('button', { name: '로그아웃', exact: true }).click()
  await expect(page.getByRole('heading', { name: '다시 만나 반갑습니다.' })).toBeVisible()
  await expect(page.getByRole('button', { name: '인증 메일 다시 받기', exact: true })).toHaveCount(0)
  await page.getByLabel('이메일', { exact: true }).fill('fixture@example.test')
  await expect(page.getByLabel('비밀번호', { exact: true })).toHaveValue('')
  await page.getByRole('button', { name: '회원가입', exact: true }).click()
  await expect(page.getByRole('heading', { name: '워크스페이스 가입' })).toBeVisible()
  await expect(page.locator('.auth-form-wrap')).toContainText('메일 인증 없이 가입을 요청하고, 본사 승인·공장 배정 후 이용합니다.')
  await expect(page.getByRole('button', { name: '인증 메일 다시 받기', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('담당자 이름', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('비밀번호', { exact: true })).toHaveValue('')
  await page.getByLabel('담당자 이름', { exact: true }).fill('QA 승인 요청자')
  await page.getByLabel('비밀번호', { exact: true }).fill('fixture-password-only')
  await page.getByRole('button', { name: '가입 요청', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(/Supabase.*설정|연결 정보.*설정/)
  await expect(page.locator('.success-message')).toHaveCount(0)
  await page.getByRole('button', { name: '로그인으로 돌아가기', exact: true }).click()
  await page.getByRole('button', { name: '비밀번호를 잊으셨나요?', exact: true }).click()
  await expect(page.getByRole('heading', { name: '비밀번호 재설정' })).toBeVisible()
  await expect(page.getByLabel('비밀번호', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '인증 메일 다시 받기', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '재설정 이메일 발송', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(/Supabase.*설정|연결 정보.*설정/)
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
