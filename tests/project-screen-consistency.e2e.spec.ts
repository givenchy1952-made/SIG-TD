import { expect, test, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1'
const CODES = ['QACALPROJ01', 'QACALPROJ02', 'QACALPROJ03']
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, codes }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    const original = structuredClone(w.styles[0]), today = new Date().toLocaleDateString('en-CA')
    w.projects = w.projects.slice(0, 3).map((project, index) => ({ ...project, code: index === 2 ? '' : `QA-CALENDAR-${index + 1}`, name: index === 2 ? 'MAP-LEGACY' : '시그니피컨트 동일 명칭', season: '2026FY' }))
    w.styles = codes.map((code, index) => {
      const style = structuredClone(original), line = structuredClone(style.production[0])
      line.id = crypto.randomUUID(); line.color = 'BK'; line.confirmDue = ''; line.shippedAt = ''; line.receivedAt = ''; line.paymentDue = ''
      line.order = { XXS: 0, XS: 0, S: 10, M: 0, L: 0, XL: 0 }
      line.received = { XXS: 0, XS: 0, S: 0, M: 0, L: 0, XL: 0 }
      style.id = crypto.randomUUID(); style.code = code; style.name = `프로젝트 화면 검증 ${index + 1}`; style.projectId = w.projects[index].id; style.season = '2026FY'; style.deletedAt = null
      style.samples = []; style.colors = ['BK']; style.production = [line]; style.stage = 'production'; style.dueDate = today
      return style
    })
    const target = w.styles[2], stamp = { version: 1, createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', updatedBy: w.profiles.find(item => item.role === 'admin')!.id }
    const columns = Object.fromEntries(['A', 'F', 'L', 'M', 'S', 'V', 'W', 'X', 'Y', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AV', 'AY'].map(key => [key, null]))
    Object.assign(columns, { A: 'MAP-LEGACY', M: '시그니피컨트 2026 원본 명칭', L: '2026FY', F: `${target.code}BK` })
    w.operations!.calendarEvents = []
    w.operations!.orderSourceRecords = [{ ...stamp, styleId: target.id, lineId: target.production[0].id, fileName: 'QA_프로젝트_오더.xlsx', sheetName: '오더', headers: columns, rows: [{ rowNumber: 7, columns }] }] as typeof w.operations.orderSourceRecords
    w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []
    w.productionRuns = []; w.productionReceipts = []; w.productionRunAudits = []; w.productionConditions = []; w.supplierProductionOrders = []
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, codes: CODES })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function navigate(page: Page, title: string) {
  const menu = page.getByRole('button', { name: '메뉴 열기', exact: true }); if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: title, exact: true }).click()
}

for (const mobile of [false, true]) test(`캘린더 프로젝트 명칭 검색과 동일 명칭의 ID별 복수 선택을 유지한다 · ${mobile ? '모바일' : 'PC'}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  const before = await snapshot(page)
  await navigate(page, '프로젝트 캘린더')
  await page.getByRole('button', { name: '일정 프로젝트 명칭', exact: true }).click()
  const filter = page.getByRole('dialog', { name: '일정 프로젝트 명칭 선택', exact: true })
  await filter.getByRole('button', { name: '선택해제', exact: true }).click()
  await filter.getByRole('searchbox', { name: '일정 프로젝트 명칭 검색', exact: true }).fill('동일 명칭')
  await expect(filter.locator('.multi-select-filter-options input')).toHaveCount(2)
  await filter.getByRole('checkbox', { name: '시그니피컨트 동일 명칭 · QA-CALENDAR-1', exact: true }).check()
  await page.keyboard.press('Escape')
  const selectedEvents = page.locator('.calendar-bottom>.panel').first()
  await expect(selectedEvents).toContainText(CODES[0])
  await expect(selectedEvents).not.toContainText(CODES[1])
  await expect(selectedEvents).not.toContainText(CODES[2])
  await expect(selectedEvents).toContainText('시그니피컨트 동일 명칭')
  await page.getByRole('button', { name: '일정 프로젝트 명칭', exact: true }).click()
  await filter.getByRole('checkbox', { name: '시그니피컨트 동일 명칭 · QA-CALENDAR-2', exact: true }).check()
  await page.keyboard.press('Escape')
  await expect(selectedEvents).toContainText(CODES[0]); await expect(selectedEvents).toContainText(CODES[1])
  await expect(selectedEvents).not.toContainText(CODES[2])
  await page.getByRole('button', { name: '프로젝트 명칭 필터 해제', exact: true }).click()
  await expect(selectedEvents).toContainText(CODES[2])
  expect(await snapshot(page)).toEqual(before)
  if (mobile) await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('관리자가 오더 A·M·L 매핑을 검토한 후 같은 프로젝트 ID만 보완하고 스타일·이력을 유지한다', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page), target = before.projects[2]
  await navigate(page, '사용자 · 기본 설정')
  await page.getByRole('button', { name: '프로젝트 관리', exact: true }).click()
  const review = page.getByRole('region', { name: '오더 원본 프로젝트 매핑 검토', exact: true })
  await expect(review).toContainText('시그니피컨트 2026 원본 명칭')
  expect(await snapshot(page)).toEqual(before)
  await review.getByRole('button', { name: /MAP-LEGACY 매핑 검토/ }).click()
  const dialog = page.getByRole('dialog', { name: '프로젝트 정보', exact: true })
  await expect(dialog.getByLabel('프로젝트 명칭', { exact: true })).toHaveValue('시그니피컨트 2026 원본 명칭')
  await expect(dialog.getByLabel('프로젝트 코드', { exact: true })).toHaveValue('MAP-LEGACY')
  await expect(dialog).toContainText('QA_프로젝트_오더.xlsx · 7행')
  await expect(dialog.getByRole('button', { name: '변경 저장', exact: true })).toBeDisabled()
  await dialog.getByLabel('기존 프로젝트 매핑 보완 확인', { exact: true }).check()
  await dialog.getByRole('button', { name: '변경 저장', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const after = await snapshot(page)
  expect(after.projects).toHaveLength(before.projects.length)
  expect(after.projects.find(project => project.id === target.id)).toMatchObject({ id: target.id, code: 'MAP-LEGACY', name: '시그니피컨트 2026 원본 명칭', season: '2026FY' })
  expect(after.styles).toEqual(before.styles)
  expect(after.operations).toEqual(before.operations)
  expect(after.productionRuns).toEqual(before.productionRuns)
  expect(after.productionReceipts).toEqual(before.productionReceipts)
  expect(after.profiles).toEqual(before.profiles)
  expect(after.factories).toEqual(before.factories)
  expect(after.audits).toEqual(before.audits)
})

test('원본 명칭이 서로 충돌하는 프로젝트는 매핑 보완 대상으로 선택하지 않는다', async ({ page }) => {
  await fixture(page)
  await page.evaluate(key => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    const row = w.operations!.orderSourceRecords[0].rows[0]
    w.operations!.orderSourceRecords[0].rows.push({ rowNumber: 8, columns: { ...row.columns, M: '충돌하는 다른 공식 명칭' } })
    localStorage.setItem(key, JSON.stringify(w))
  }, STORAGE)
  await page.reload()
  const before = await snapshot(page)
  await navigate(page, '사용자 · 기본 설정')
  await page.getByRole('button', { name: '프로젝트 관리', exact: true }).click()
  const review = page.getByRole('region', { name: '오더 원본 프로젝트 매핑 검토', exact: true })
  await expect(review).toContainText('확인 필요')
  await expect(review).toContainText('같은 프로젝트에 연결된 오더 원본의 코드·명칭·시즌이 서로 다릅니다.')
  await expect(review.getByRole('button', { name: /매핑 검토/ })).toHaveCount(0)
  expect(await snapshot(page)).toEqual(before)
})
