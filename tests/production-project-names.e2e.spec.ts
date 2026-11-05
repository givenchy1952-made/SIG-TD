import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1', M = '시그니피컨트 2026 3Q', OTHER_M = '시그니피컨트 2027 11M-1'
const A = 'SIGNIFICANT-2026FY-MPQ-46093', OTHER_A = 'SIGNIFICANT-2027FY-RPQ-46318', MISSING_A = 'SIGNIFICANT-2026FY-RPQ-99999'
const FACTORY = '10000000-0000-4000-8000-000000000004'
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, name, otherName, budget, otherBudget, missingBudget }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    const original = structuredClone(w.styles[0])
    w.projects = w.projects.slice(0, 3).map((project, index) => ({ ...project, name: [name, otherName, ''][index], code: [budget, otherBudget, missingBudget][index], season: index === 1 ? '2027FY' : '2026FY' }))
    const factory = w.profiles.find(person => person.role === 'factory' && person.approved)!.factoryId!
    w.styles = w.projects.map((project, index) => {
      const style = structuredClone(original), line = structuredClone(original.production[0])
      style.id = crypto.randomUUID(); style.code = `QAPRODUCTIONM0${index + 1}`; style.name = `명칭 구분 검증 ${index + 1}`
      style.projectId = project.id; style.factoryId = index === 1 ? w.factories.find(item => item.id !== factory)!.id : factory
      style.season = '2099WRONG'; style.notes = ''; style.stage = 'production'; style.samples = []; style.colors = ['BK']; style.deletedAt = null
      line.id = crypto.randomUUID(); line.color = 'BK'; line.order = { XXS: 1, XS: 2, S: 3, M: 4, L: 5, XL: 6 }
      style.production = [line]
      return style
    })
    w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []
    w.productionRuns = []; w.productionReceipts = []; w.productionRunAudits = []; w.productionConditions = []; w.supplierProductionOrders = []; w.productionPoContexts = []
    w.operations!.poDispatches = []; w.operations!.poDispatchAttempts = []; w.operations!.orderSourceRecords = []; w.operations!.calendarEvents = []
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, name: M, otherName: OTHER_M, budget: A, otherBudget: OTHER_A, missingBudget: MISSING_A })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: '메뉴 열기', exact: true }); if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name, exact: true }).click()
}

for (const mobile of [false, true]) test(`본사 목록은 M 명칭·A 예산 코드·L 시즌을 별도 열로 나누고 새 스타일 등록은 M을 선택한다 · ${mobile ? '모바일' : 'PC'}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  const before = await snapshot(page)
  const firstRow = page.locator('.styles-table tbody tr').filter({ hasText: 'QAPRODUCTIONM01' })
  await expect(firstRow.locator('.project-identity-cell')).toContainText(M)
  await expect(firstRow.locator('.project-season-cell')).toHaveText('2026FY')
  await expect(firstRow.locator('.project-identity-cell')).not.toContainText('2099WRONG')
  await expect(firstRow.locator('.project-name-cell')).not.toContainText(A)
  await expect(firstRow.locator('.budget-code-cell')).toHaveText(A)
  await expect(page.locator('.styles-table').getByRole('columnheader', { name: '예산 관리 코드 (본사)', exact: true })).toHaveCount(1)
  await expect(page.locator('.styles-table')).toContainText('프로젝트 명칭 미등록')
  await page.getByRole('button', { name: '프로젝트 명칭', exact: true }).click()
  const filter = page.getByRole('dialog', { name: '프로젝트 명칭 선택', exact: true })
  await expect(filter).toContainText(M)
  await expect(filter).not.toContainText(A)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '스타일 등록', exact: true }).first().click()
  const create = page.getByRole('dialog', { name: '새 스타일 등록', exact: true })
  const project = create.getByLabel('프로젝트 명칭', { exact: true })
  await expect(project).toContainText(M)
  await expect(project).not.toContainText(A)
  await expect(project.locator('option').filter({ hasText: '프로젝트 명칭 미등록' })).toHaveJSProperty('disabled', true)
  await project.selectOption(before.projects[1].id)
  await expect(create.getByLabel('시즌 / 년도', { exact: true })).toHaveValue('2027FY')
  await create.getByLabel(/스타일 코드/).fill('QANEWMNAME01')
  await create.getByLabel(/제품명/).fill('M 명칭으로 수기 등록')
  await create.getByLabel(/컬러 코드/).fill('BK')
  await create.getByRole('button', { name: '스타일 등록', exact: true }).click()
  const detail = page.getByRole('dialog')
  await expect(detail.getByRole('heading', { level: 1 })).toContainText('QANEWMNAME01BK')
  await expect(detail.locator('.detail-eyebrow')).toContainText(OTHER_M)
  await expect(detail.locator('.detail-eyebrow')).toContainText('시즌 · 2027FY')
  await expect(detail.locator('.detail-eyebrow')).not.toContainText(OTHER_A)
  const after = await snapshot(page), added = after.styles.find(style => style.code === 'QANEWMNAME01')!
  expect(added).toMatchObject({ projectId: before.projects[1].id, season: '2027FY' })
  expect(after.projects).toEqual(before.projects)
  expect(after.styles.filter(style => style.id !== added.id)).toEqual(before.styles)
  if (mobile) await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('업체는 배정된 프로젝트 명칭으로 검색·일정을 확인하고 예산코드로 생산을 찾지 않는다', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page)
  await page.getByLabel('체험 역할', { exact: true }).selectOption(FACTORY)
  await expect(page.locator('body')).not.toContainText(A)
  await expect(page.locator('.budget-code-cell')).toHaveCount(0)
  await expect(page.locator('.styles-table').getByRole('columnheader', { name: '예산 관리 코드 (본사)', exact: true })).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(OTHER_M)
  await page.getByLabel('스타일 검색', { exact: true }).fill(A)
  await expect(page.locator('.style-code')).toHaveCount(0)
  await page.getByLabel('스타일 검색', { exact: true }).fill(M)
  await expect(page.locator('.style-code')).toHaveCount(1)
  await expect(page.locator('.style-code')).toContainText('QAPRODUCTIONM01')
  await page.getByLabel('스타일 검색', { exact: true }).fill('')
  await navigate(page, '프로젝트 캘린더')
  await page.getByRole('button', { name: '일정 프로젝트 명칭', exact: true }).click()
  const filter = page.getByRole('dialog', { name: '일정 프로젝트 명칭 선택', exact: true })
  await expect(filter).toContainText(M)
  await expect(filter).not.toContainText(A)
  await expect(filter).not.toContainText(OTHER_M)
  expect(await snapshot(page)).toEqual(before)
})

test('새 PO와 메일 초안은 M 명칭을 사용하고 A 예산코드가 들어간 새 초안은 저장하지 않는다', async ({ page }) => {
  await fixture(page)
  await page.getByRole('button', { name: 'QAPRODUCTIONM01BK', exact: true }).click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /생산 조건 협의·승인/ }).click()
  await detail.getByRole('button', { name: 'PO 작성', exact: true }).click()
  await expect(detail.getByLabel('PO 메일 제목', { exact: true })).toHaveValue(new RegExp(M))
  await expect(detail.getByLabel('PO 메일 내용', { exact: true })).toHaveValue(new RegExp(M))
  const pending = page.waitForEvent('download')
  await detail.getByRole('button', { name: '메일 초안 다운로드 (.eml)', exact: true }).click()
  const download = await pending
  expect(download.suggestedFilename()).toContain(M)
  expect(download.suggestedFilename()).not.toContain(A)
  expect((await readFile((await download.path())!)).toString('utf8')).toContain(M)
  await detail.getByLabel('PO 수신 이메일', { exact: true }).fill('qa@example.test')
  await detail.getByLabel('PO 메일 제목', { exact: true }).fill(`[PO] ${A}`)
  await detail.getByLabel('PO 변경 사유', { exact: true }).fill('예산 코드 사용 차단 검증')
  await detail.getByRole('button', { name: 'PO 초안 저장', exact: true }).click()
  await expect(detail.getByRole('alert')).toContainText('예산 관리 코드')
  expect((await snapshot(page)).operations!.poDispatches).toHaveLength(0)
})
