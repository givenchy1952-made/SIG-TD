import { test, expect, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1', FACTORY = '10000000-0000-4000-8000-000000000004', CODE = 'BO42FYHD0102'
const INTERNAL = '10000000-0000-4000-8000-000000000002'
async function ready(page: Page) { await page.goto('/'); await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible() }
async function navigate(page: Page) {
  const menu = page.getByRole('button', { name: '메뉴 열기', exact: true }); if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '메인 생산', exact: true }).click()
}
async function upload(page: Page) {
  await page.getByRole('button', { name: '오더 엑셀 업로드', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Excel 오더 수량 가져오기', exact: true })
  await dialog.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name: 'same-reorder.csv', mimeType: 'text/csv', buffer: Buffer.from(`스타일코드,컬러,XXS,XS,S,M,L,XL\n${CODE},BK,0,0,0,5,0,0\n`, 'utf8') })
  const apply = dialog.getByRole('button', { name: '검증된 오더 적용', exact: true })
  await expect(apply).toBeEnabled(); await apply.click()
  await expect(dialog.getByRole('status')).toContainText('새 생산 차수 1개')
  await dialog.locator('.order-import-close').getByRole('button', { name: '닫기', exact: true }).click()
}

test('동일 수량 리오더와 다른 프로젝트 발주를 별도 차수로 보존하고 복수 프로젝트를 선택한다', async ({ page }) => {
  await ready(page)
  await page.evaluate(({ key, code }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    const style = w.styles.find(style => style.code === code)!
    w.styles = [style]; style.colors = ['BK']; style.production = [{ ...style.production[0], color: 'BK' }]
    for (const field of ['order', 'shipped', 'received', 'packing'] as const) for (const size of ['XXS', 'XS', 'S', 'M', 'L', 'XL'] as const) style.production[0][field][size] = 0
    w.projects[0].code = 'QA-PROJECT-A'; w.projects[0].name = 'QA 프로젝트 A'; w.projects[1].code = 'QA-PROJECT-B'; w.projects[1].name = 'QA 프로젝트 B'
    style.projectId = w.projects[0].id
    w.productionRuns = []; w.productionReceipts = []; w.productionRunAudits = []; w.supplierProductionOrders = []
    w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, code: CODE })
  await page.reload(); await navigate(page)
  await upload(page); await upload(page)
  let saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!) as Workspace, STORAGE)
  expect(saved.productionRuns!.map(run => [run.projectCode, run.round, run.order.M])).toEqual([['QA-PROJECT-A', 1, 5], ['QA-PROJECT-A', 2, 5]])
  expect(saved.styles[0].production[0].order.M).toBe(5)
  await page.evaluate(key => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    w.styles[0].projectId = w.projects[1].id; w.styles[0].version += 1
    localStorage.setItem(key, JSON.stringify(w))
  }, STORAGE)
  await page.reload(); await navigate(page); await upload(page)
  saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!) as Workspace, STORAGE)
  expect(saved.productionRuns!.map(run => [run.projectCode, run.round, run.order.M])).toEqual([['QA-PROJECT-A', 1, 5], ['QA-PROJECT-A', 2, 5], ['QA-PROJECT-B', 1, 5]])
  const board = page.getByRole('region', { name: '프로젝트·생산 차수별 현황', exact: true })
  await expect(board.locator('tbody tr')).toHaveCount(3)
  await board.getByRole('button', { name: '생산 차수 프로젝트', exact: true }).click()
  let filter = page.getByRole('dialog', { name: '생산 차수 프로젝트 선택', exact: true })
  await filter.getByRole('button', { name: '선택해제', exact: true }).click()
  await filter.getByRole('checkbox', { name: 'QA-PROJECT-A · QA 프로젝트 A', exact: true }).check(); await page.keyboard.press('Escape')
  await expect(board.locator('tbody tr')).toHaveCount(2)
  await board.getByRole('button', { name: '생산 차수 프로젝트', exact: true }).click()
  filter = page.getByRole('dialog', { name: '생산 차수 프로젝트 선택', exact: true })
  await filter.getByRole('checkbox', { name: 'QA-PROJECT-B · QA 프로젝트 B', exact: true }).check(); await page.keyboard.press('Escape')
  await expect(board.locator('tbody tr')).toHaveCount(3)
  // A registered SKU can immediately reorder under a previously unknown
  // A-column project through the same apply action, without a separate form.
  const priorRuns = structuredClone(saved.productionRuns!)
  await page.getByLabel('체험 역할', { exact: true }).selectOption(INTERNAL)
  await page.getByRole('button', { name: '오더 엑셀 업로드', exact: true }).click()
  const importer = page.getByRole('dialog', { name: 'Excel 오더 수량 가져오기', exact: true })
  const headers = Array<string>(51).fill(''), values = Array<string>(51).fill('')
  headers[0] = '프로젝트 코드'; headers[5] = '스타일코드'; headers[11] = '년도/시즌'; headers[12] = '프로젝트 명칭'; headers[50] = 'TOTAL QTY'
  values[0] = 'QA-PROJECT-NEW'; values[5] = `${CODE}BK`; values[11] = '2026FY'; values[12] = 'QA 신규 리오더 프로젝트'; values[50] = '9'
  for (const [index, size] of ['XXS', 'XS', 'S', 'M', 'L', 'XL'].entries()) { headers[42 + index] = size; values[42 + index] = index === 3 ? '9' : '0' }
  await importer.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name: 'new-project-reorder.csv', mimeType: 'text/csv', buffer: Buffer.from(`${headers.join(',')}\n${values.join(',')}\n`, 'utf8') })
  await expect(importer.getByRole('button', { name: '프로젝트 연결', exact: true })).toHaveCount(0)
  await expect(importer.getByRole('button', { name: '스타일·프로젝트 등록', exact: true })).toHaveCount(0)
  await expect(importer).toContainText('QA-PROJECT-NEW')
  await expect(importer).toContainText('QA 신규 리오더 프로젝트')
  expect((await page.evaluate(key => JSON.parse(localStorage.getItem(key)!) as Workspace, STORAGE)).projects.some(project => project.code === 'QA-PROJECT-NEW')).toBe(false)
  await importer.getByRole('button', { name: '검증된 오더 적용', exact: true }).click()
  await expect(importer.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
  await importer.locator('.order-import-close').getByRole('button', { name: '닫기', exact: true }).click()
  saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!) as Workspace, STORAGE)
  expect(saved.productionRuns).toHaveLength(4)
  expect(saved.productionRuns!.slice(0, 3)).toEqual(priorRuns)
  expect(saved.productionRuns!.at(-1)).toMatchObject({ projectCode: 'QA-PROJECT-NEW', round: 1, order: { XXS: 0, XS: 0, S: 0, M: 9, L: 0, XL: 0 } })
  const project = saved.projects.find(item => item.code === 'QA-PROJECT-NEW')!
  expect(project).toMatchObject({ name: 'QA 신규 리오더 프로젝트', season: '2026FY' })
  expect(saved.productionRuns!.at(-1)!.projectId).toBe(project.id)
  await page.getByLabel('체험 역할', { exact: true }).selectOption(FACTORY)
  await board.getByRole('button', { name: '생산 차수 프로젝트', exact: true }).click()
  filter = page.getByRole('dialog', { name: '생산 차수 프로젝트 선택', exact: true })
  await filter.getByRole('button', { name: '전체보기', exact: true }).click(); await page.keyboard.press('Escape')
  await expect(board.locator('tbody tr')).toHaveCount(4)
  await expect(board).toContainText('PO 발송 대기')
  await expect(page.getByRole('button', { name: '오더 엑셀 업로드', exact: true })).toHaveCount(0)
})
