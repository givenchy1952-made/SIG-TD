import { test, expect, type Page } from '@playwright/test'

const STORAGE = 'sig-workspace-demo-v1'
const ADMIN = '10000000-0000-4000-8000-000000000001'
const INTERNAL = '10000000-0000-4000-8000-000000000002'
const FACTORY = '10000000-0000-4000-8000-000000000004'
const PENDING = '10000000-0000-4000-8000-000000000005'

async function ready(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await expect(page.getByLabel('체험 역할', { exact: true })).toHaveValue(ADMIN)
}
async function administration(page: Page) {
  const menu = page.getByRole('button', { name: '메뉴 열기', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '사용자 · 기본 설정', exact: true }).click()
}
async function stored(page: Page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE)
}
async function openWithdrawal(page: Page, name: string) {
  await page.getByRole('button', { name: `${name} 구성원 탈퇴`, exact: true }).click()
  const modal = page.getByRole('dialog', { name: '구성원 탈퇴', exact: true })
  await expect(modal).toBeVisible()
  await expect(modal).toContainText(name)
  return modal
}
const history = (workspace: Record<string, unknown>) => Object.fromEntries(Object.entries(workspace).filter(([key]) => key !== 'profiles' && key !== 'audits'))

test('관리자는 대상과 사유를 확인해 구성원을 탈퇴 처리하고 기존 업무 이력은 보존한다', async ({ page }) => {
  await ready(page)
  const before = await stored(page), target = before.profiles.find((profile: { id: string }) => profile.id === INTERNAL)
  await administration(page)
  await expect(page.getByRole('button', { name: '남주현 구성원 탈퇴', exact: true })).toHaveCount(0)
  const modal = await openWithdrawal(page, target.name)
  await expect(modal).toContainText(target.email)
  await expect(modal).toContainText(/이력.*보존|보존.*이력/)
  const apply = modal.getByRole('button', { name: '탈퇴 처리', exact: true })
  await expect(apply).toBeDisabled()
  await modal.getByLabel('구성원 탈퇴 사유', { exact: true }).fill('QA 구성원 퇴사에 따른 접근 종료')
  await expect(apply).toBeDisabled()
  await modal.getByRole('checkbox', { name: '이 구성원의 업무 접근을 차단합니다.', exact: true }).check()
  await expect(apply).toBeEnabled()
  await apply.click()
  await expect(modal).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: '구성원 탈퇴를 처리했습니다.' })).toBeVisible()
  const after = await stored(page)
  expect(after.profiles).toHaveLength(before.profiles.length)
  expect(after.profiles.filter((profile: { id: string }) => profile.id !== INTERNAL)).toEqual(before.profiles.filter((profile: { id: string }) => profile.id !== INTERNAL))
  expect(after.profiles.find((profile: { id: string }) => profile.id === INTERNAL)).toMatchObject({ id: INTERNAL, name: target.name, email: target.email, role: 'internal', active: false, approved: false })
  expect(after.profiles.find((profile: { id: string }) => profile.id === INTERNAL)).toMatchObject({ withdrawnBy: ADMIN, withdrawnAt: expect.any(String) })
  expect(history(after)).toEqual(history(before))
  expect(after.audits.slice(1)).toEqual(before.audits)
  const audit = after.audits.find((item: { action: string; after?: { id?: string } }) => item.action === '구성원 탈퇴' && item.after?.id === INTERNAL)
  expect(audit).toMatchObject({ actorId: ADMIN, reason: 'QA 구성원 퇴사에 따른 접근 종료', after: { id: INTERNAL, active: false, approved: false } })
  await page.evaluate(id => localStorage.setItem('sig-demo-profile', id), INTERNAL)
  await page.reload()
  await expect(page.getByRole('heading', { name: /비활성|탈퇴/ })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '주 메뉴' })).toHaveCount(0)
  await expect(page.locator('.style-code')).toHaveCount(0)
})

test('공장 계정과 공장 미배정 가입자도 관리자가 탈퇴 처리하며 취소는 계정을 바꾸지 않는다', async ({ page }) => {
  await ready(page)
  await page.setViewportSize({ width: 390, height: 844 })
  const before = await stored(page)
  await administration(page)
  const factory = before.profiles.find((profile: { id: string }) => profile.id === FACTORY)
  let modal = await openWithdrawal(page, factory.name)
  await modal.getByLabel('구성원 탈퇴 사유', { exact: true }).fill('QA 잘못 선택한 계정 취소')
  await modal.getByRole('checkbox', { name: '이 구성원의 업무 접근을 차단합니다.', exact: true }).check()
  await modal.getByRole('button', { name: '취소', exact: true }).click()
  expect((await stored(page)).profiles).toEqual(before.profiles)
  for (const id of [FACTORY, PENDING]) {
    const target = before.profiles.find((profile: { id: string }) => profile.id === id)
    modal = await openWithdrawal(page, target.name)
    await modal.getByLabel('구성원 탈퇴 사유', { exact: true }).fill('QA 계약 종료 계정 접근 차단')
    await modal.getByRole('checkbox', { name: '이 구성원의 업무 접근을 차단합니다.', exact: true }).check()
    await modal.getByRole('button', { name: '탈퇴 처리', exact: true }).click()
    await expect(modal).toHaveCount(0)
    expect((await stored(page)).profiles.find((profile: { id: string }) => profile.id === id)).toMatchObject({ active: false, approved: false })
  }
  const after = await stored(page)
  for (const id of [FACTORY, PENDING]) expect(after.profiles.find((profile: { id: string }) => profile.id === id)).toMatchObject({ withdrawnBy: ADMIN, withdrawnAt: expect.any(String) })
  expect(history(after)).toEqual(history(before))
  expect(after.audits.slice(2)).toEqual(before.audits)
  expect(after.profiles).toHaveLength(before.profiles.length)
  expect(after.profiles.filter((profile: { id: string }) => ![FACTORY, PENDING].includes(profile.id))).toEqual(before.profiles.filter((profile: { id: string }) => ![FACTORY, PENDING].includes(profile.id)))
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await page.getByLabel('체험 역할', { exact: true }).selectOption(INTERNAL)
  await administration(page)
  await expect(page.getByRole('button', { name: `${factory.name} 권한 수정`, exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '신규 협력사 권한 수정', exact: true })).toHaveCount(0)
})

test('본사 직원과 공장 계정에는 관리자 구성원 탈퇴 동작을 표시하지 않는다', async ({ page }) => {
  await ready(page)
  await page.getByLabel('체험 역할', { exact: true }).selectOption(INTERNAL)
  await administration(page)
  await expect(page.getByRole('button', { name: /구성원 탈퇴$/ })).toHaveCount(0)
  await page.getByLabel('체험 역할', { exact: true }).selectOption(FACTORY)
  await expect(page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '사용자 · 기본 설정', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /구성원 탈퇴$/ })).toHaveCount(0)
})
