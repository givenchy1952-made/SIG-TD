import { test, expect, type Locator, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1'
const ADMIN = '10000000-0000-4000-8000-000000000001'
const CHINA = '20000000-0000-4000-8000-000000000002'
const QUANTITIES = { XXS: 60, XS: 384, S: 626, M: 1296, L: 1162, XL: 610 }

async function ready(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function registerFixtureProjectCode(page: Page, styleCode: string, projectCode: string) {
  await page.evaluate(({ key, styleCode, projectCode }) => {
    const workspace = JSON.parse(localStorage.getItem(key)!) as Workspace
    const style = workspace.styles.find(item => item.code === styleCode)!
    workspace.projects.find(project => project.id === style.projectId)!.code = projectCode
    localStorage.setItem(key, JSON.stringify(workspace))
  }, { key: STORAGE, styleCode, projectCode })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function openImport(page: Page, query?: string) {
  const menu = page.getByRole('button', { name: '메뉴 열기', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '메인 생산', exact: true }).click()
  if (query) await page.getByLabel('스타일 검색', { exact: true }).fill(query)
  await page.getByRole('button', { name: '오더 엑셀 업로드', exact: true }).click()
  return page.getByRole('dialog', { name: 'Excel 오더 수량 가져오기', exact: true })
}
async function skuEditor(modal: Locator) {
  const first = modal.locator('.import-sku-row input').first()
  if (!await first.isVisible()) await modal.getByText('품번 판독값 수정 (선택)', { exact: true }).click()
}
async function selectNewFactory(modal: Locator) {
  const settings = modal.locator('[aria-label="업로드 기본 설정"]')
  await settings.getByLabel('일괄 등록 공장 QA 별도 공장', { exact: true }).selectOption(CHINA)
}
function csv(sku: string, project = { code: 'QA-BASE-IMPORT-01', name: 'QA 기본 품번 프로젝트', season: '2026FY' }, overrides: Record<number, string> = {}) {
  const headers = Array<string>(153).fill(''), row = Array<string>(153).fill('')
  headers[0] = '프로젝트 코드'; headers[1] = '예산 코드'; headers[5] = '스타일코드'; headers[8] = '컬러'; headers[11] = '년도/시즌'; headers[12] = '프로젝트 명칭'
  headers[22] = '생산처'; headers[24] = '생산 담당자'; headers[50] = 'TOTAL QTY'
  headers[40] = '입고예정일'
  row[0] = project.code; row[5] = sku; row[8] = '#REF!'; row[11] = project.season; row[12] = project.name
  row[22] = 'QA 별도 공장'; row[24] = 'QA 별도 담당자'; row[50] = '4,138'
  Object.values(QUANTITIES).forEach((quantity, index) => { headers[42 + index] = `TTL ${index + 1}`; row[42 + index] = quantity.toLocaleString('en-US') })
  row[4] = '#NAME?'; row[96] = '#REF!'
  for (const [column, value] of Object.entries(overrides)) row[Number(column)] = value
  const quote = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
  return Buffer.from('\uFEFF' + [headers, row].map(values => values.map(quote).join(',')).join('\r\n'))
}

test('F 기본 품번의 실제 수량을 표시하고 전체 품번 보정 후 오더 적용 한 번으로 자동 등록한다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await ready(page)
  const before = await snapshot(page), modal = await openImport(page)
  await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name: 'QA-BASE-ORDER.csv', mimeType: 'text/csv', buffer: csv('QAFYDW9901') })
  await expect(modal.getByRole('heading', { name: '적용 전 미리보기', exact: true })).toBeVisible()
  const row = modal.locator('.import-preview-table tbody tr').first()
  await expect(row).toContainText('QAFYDW9901')
  await expect(row.locator('.import-total-cell')).toContainText('4,138')
  await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeDisabled()
  await expect(modal.getByLabel('색상 열', { exact: true })).toHaveCount(0)
  await skuEditor(modal)
  await modal.getByLabel('원본 2행 품번', { exact: true }).fill('QAFYDW9901BK')
  await expect(modal.getByRole('button', { name: '스타일·프로젝트 등록', exact: true })).toHaveCount(0)
  await expect(modal.getByRole('region', { name: '미등록 스타일 등록', exact: true })).toHaveCount(0)
  await expect(modal.locator('.import-preview-table tbody tr').first()).toContainText('자동 등록 예정')
  await selectNewFactory(modal)
  expect(await snapshot(page)).toEqual(before)
  await modal.getByLabel('오더 변경 사유', { exact: true }).fill('QA AQ AV 수량 4138개 반영')
  await modal.getByRole('button', { name: '검증된 오더 적용', exact: true }).click()
  await expect(modal.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
  const after = await snapshot(page), style = after.styles.find(item => item.code === 'QAFYDW9901')!
  expect(after.styles).toHaveLength(before.styles.length + 1)
  expect(style.production[0].order).toEqual(QUANTITIES)
  expect(Object.values(style.production[0].shipped)).toEqual([0, 0, 0, 0, 0, 0])
  expect(Object.values(style.production[0].received)).toEqual([0, 0, 0, 0, 0, 0])
  expect(style).toMatchObject({ factoryId: CHINA, ownerId: ADMIN, dueDate: '', colors: ['BK'] })
  expect(after.productionRuns).toHaveLength(1)
  const source = after.operations!.orderSourceRecords.find(item => item.styleId === style.id)!
  expect(source.rows[0].columns).toMatchObject({ F: 'QAFYDW9901', AQ: '60', AR: '384', AS: '626', AT: '1,296', AU: '1,162', AV: '610', AY: '4,138' })
  expect('I' in source.rows[0].columns).toBe(false)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('기본 품번에 여러 컬러가 있으면 선택 전 적용을 막고 선택한 컬러의 오더만 변경한다', async ({ page }) => {
  await ready(page)
  await registerFixtureProjectCode(page, 'BO42FYHD0102', 'QA-EXISTING-01')
  const before = await snapshot(page), original = before.styles.find(item => item.code === 'BO42FYHD0102')!, project = before.projects.find(item => item.id === original.projectId)!
  const modal = await openImport(page)
  await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name: 'QA-MULTICOLOR.csv', mimeType: 'text/csv', buffer: csv(original.code, { code: 'QA-EXISTING-01', name: project.name, season: project.season }) })
  await expect(modal.locator('.import-preview-table tbody tr').first().locator('.import-total-cell')).toContainText('4,138')
  await modal.getByLabel('오더 변경 사유', { exact: true }).fill('QA 여러 컬러 중 OW만 변경')
  await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeDisabled()
  await skuEditor(modal)
  await modal.getByLabel('원본 2행 품번', { exact: true }).fill(`${original.code}OW`)
  await modal.getByRole('button', { name: '검증된 오더 적용', exact: true }).click()
  await expect(modal.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
  const after = await snapshot(page), updated = after.styles.find(item => item.id === original.id)!
  expect(updated.production.find(line => line.color === 'OW')!.order).toEqual(QUANTITIES)
  for (const line of original.production) {
    const current = updated.production.find(item => item.id === line.id)!
    if (line.color !== 'OW') expect(current).toEqual(line)
    expect(current.shipped).toEqual(line.shipped); expect(current.received).toEqual(line.received)
  }
  expect(updated.colors).toEqual(original.colors)
  expect(after.operations!.orderSourceRecords.find(item => item.styleId === original.id)!.rows[0].columns.F).toBe(original.code)
  expect(after.productionRuns).toHaveLength(1)
  expect(after.productionRuns![0]).toMatchObject({ styleId: original.id, projectId: project.id, projectCode: 'QA-EXISTING-01', order: QUANTITIES, round: 1 })
})

test('단일 등록 컬러의 기본 품번과 기존 컬러 포함 품번을 모두 읽고 I열은 사용하지 않는다', async ({ page }) => {
  await ready(page)
  await registerFixtureProjectCode(page, 'BO42FYVT0109', 'QA-EXISTING-02')
  const before = await snapshot(page), original = before.styles.find(item => item.code === 'BO42FYVT0109')!, project = before.projects.find(item => item.id === original.projectId)!
  const modal = await openImport(page)
  for (const sku of [original.code, `${original.code}BK`]) {
    await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name: `QA-${sku}.csv`, mimeType: 'text/csv', buffer: csv(sku, { code: 'QA-EXISTING-02', name: project.name, season: project.season }) })
    await modal.getByLabel('오더 변경 사유', { exact: true }).fill(`QA ${sku} 자동 매칭`)
    await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeEnabled()
    await modal.getByRole('button', { name: '검증된 오더 적용', exact: true }).click()
    await expect(modal.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
    const after = await snapshot(page), updated = after.styles.find(item => item.id === original.id)!
    expect(updated.production[0].order).toEqual(QUANTITIES)
    expect(updated.production[0].shipped).toEqual(original.production[0].shipped)
    const source = after.operations!.orderSourceRecords.find(item => item.styleId === original.id)!
    expect(source.rows[0].columns.F).toBe(sku); expect('I' in source.rows[0].columns).toBe(false)
    const runs = after.productionRuns!.filter(run => run.styleId === original.id)
    expect(runs).toHaveLength(sku === original.code ? 1 : 2)
    expect(runs.at(-1)).toMatchObject({ projectId: project.id, projectCode: 'QA-EXISTING-02', order: QUANTITIES })
  }
})

test('품번 행을 더 펼친 뒤 26번째 데이터의 전체 품번을 입력해도 행과 입력값을 유지한다', async ({ page }) => {
  await ready(page)
  const before = await snapshot(page), modal = await openImport(page)
  const [header, row] = csv('QAFYDW9998').toString('utf8').split('\r\n')
  const buffer = Buffer.from([header, ...Array<string>(30).fill(row)].join('\r\n'))
  await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name: 'QA-30-BASE-ROWS.csv', mimeType: 'text/csv', buffer })
  await skuEditor(modal)
  await expect(modal.getByLabel('원본 27행 품번', { exact: true })).toHaveCount(0)
  await modal.getByRole('button', { name: '품번 행 더 보기', exact: true }).click()
  const fullSku = modal.getByLabel('원본 27행 품번', { exact: true })
  await expect(fullSku).toBeVisible()
  await fullSku.fill('Q')
  await expect(fullSku).toBeVisible()
  await fullSku.fill('QAFYDW9998BK')
  await expect(fullSku).toBeVisible()
  await expect(fullSku).toHaveValue('QAFYDW9998BK')
  await expect(modal.getByLabel('원본 31행 품번', { exact: true })).toBeVisible()
  await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeDisabled()
  expect(await snapshot(page)).toEqual(before)
})

test('F 기본 품번과 B 예산코드의 전체 품번으로 등록 정보를 자동 채우고 한 번에 4138개를 반영한다', async ({ page }) => {
  await ready(page)
  await page.evaluate(({ key, factoryId }) => {
    const workspace = JSON.parse(localStorage.getItem(key)!)
    workspace.factories.find((factory: { id: string }) => factory.id === factoryId).name = 'QA나디아(주)'
    localStorage.setItem(key, JSON.stringify(workspace))
  }, { key: STORAGE, factoryId: CHINA })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  const before = await snapshot(page), modal = await openImport(page)
  const project = { code: 'QA-2026FY-MPQ-99999', name: 'QA 2026 3Q', season: '2026FY' }, fullSku = 'QAFYDW9999BK'
  await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({
    name: 'QA-SIG-BASE-BUDGET-ORDER.csv', mimeType: 'text/csv', buffer: csv('QAFYDW9999', project, {
      1: `${project.code}${fullSku}`, 22: 'QA나디아㈜', 24: '천민영', 40: '2026-10-14',
    }),
  })
  await expect(modal.getByRole('region', { name: '미등록 스타일 등록', exact: true })).toHaveCount(0)
  await expect(modal.getByRole('button', { name: '스타일·프로젝트 등록', exact: true })).toHaveCount(0)
  await expect(modal.locator('.import-preview-table tbody tr').first()).toContainText(fullSku)
  await expect(modal.locator('.import-preview-table tbody tr').first()).toContainText('자동 등록 예정')
  await expect(modal.locator('.import-preview-table tbody tr').first().locator('.import-total-cell')).toContainText('4,138')
  await modal.getByRole('button', { name: '검증된 오더 적용', exact: true }).click()
  await expect(modal.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
  const after = await snapshot(page), style = after.styles.find(item => item.code === 'QAFYDW9999')!
  expect(after.styles).toHaveLength(before.styles.length + 1)
  expect(style).toMatchObject({ factoryId: CHINA, ownerId: ADMIN, dueDate: '2026-10-14', colors: ['BK'] })
  expect(style.production[0].order).toEqual(QUANTITIES)
  expect(Object.values(style.production[0].shipped)).toEqual([0, 0, 0, 0, 0, 0])
  expect(Object.values(style.production[0].received)).toEqual([0, 0, 0, 0, 0, 0])
  expect(after.projects.find(item => item.id === style.projectId)).toMatchObject(project)
  const source = after.operations!.orderSourceRecords.find(item => item.styleId === style.id)!
  expect(source.rows[0].columns).toMatchObject({ A: project.code, F: 'QAFYDW9999', M: project.name, AY: '4,138' })
  expect('I' in source.rows[0].columns).toBe(false)
})

test('파일 합계가 사이즈 합계와 다르면 통합 적용 전에 프로젝트·품번 등록부터 차단한다', async ({ page }) => {
  await ready(page)
  const before = await snapshot(page), modal = await openImport(page)
  await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({
    name: 'QA-BAD-TOTAL.csv', mimeType: 'text/csv', buffer: csv('QAFYDW9997BK', undefined, { 50: '4,139' }),
  })
  await selectNewFactory(modal)
  await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeDisabled()
  await expect(modal.locator('.import-preview-table tbody tr').first()).toContainText('사이즈 합계')
  await expect(modal.getByRole('region', { name: '미등록 스타일 등록', exact: true })).toHaveCount(0)
  expect(await snapshot(page)).toEqual(before)
})

test('다른 탭이 기존 품번을 변경하면 통합 가져오기에서 새 프로젝트·품번 저장 전에 재검증을 요구한다', async ({ page, context }) => {
  await ready(page)
  const before = await snapshot(page), original = before.styles.find(item => item.code === 'BO42FYHD0102')!
  const modal = await openImport(page, original.code)
  const [header, existingRow] = csv(`${original.code}BK`).toString('utf8').split('\r\n')
  const [, newRow] = csv('QAFYDW9996', undefined, { 1: 'QA-BASE-IMPORT-01QAFYDW9996BK' }).toString('utf8').split('\r\n')
  await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name: 'QA-CONCURRENT-IMPORT.csv', mimeType: 'text/csv', buffer: Buffer.from([header, existingRow, newRow].join('\r\n')) })
  await selectNewFactory(modal)
  await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeEnabled()
  const second = await context.newPage()
  await ready(second)
  await second.evaluate(({ key, styleId }) => {
    const workspace = JSON.parse(localStorage.getItem(key)!)
    const style = workspace.styles.find((item: { id: string }) => item.id === styleId)
    style.production[0].order.M += 1; style.version += 1; style.updatedAt = new Date().toISOString()
    localStorage.setItem(key, JSON.stringify(workspace))
  }, { key: STORAGE, styleId: original.id })
  const revisedTotal = Object.values(original.production[0].order).reduce((sum, quantity) => sum + quantity, 0) + 1
  const dashboardRow = page.locator('.styles-table tbody tr').filter({ has: page.locator('.style-code').filter({ hasText: `${original.code}BK` }) })
  await expect(dashboardRow.locator('.amount')).toContainText(revisedTotal.toLocaleString('ko-KR'))
  const concurrent = await snapshot(page)
  await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeDisabled()
  await expect(modal.locator('.import-stale')).toBeVisible()
  expect(await snapshot(page)).toEqual(concurrent)
  expect(concurrent.styles.some(item => item.code === 'QAFYDW9996')).toBe(false)
  expect(concurrent.projects).toEqual(before.projects)
  await second.close()
})

test('자동 등록 미리보기 중 파일 형식을 바꾸면 예정 등록을 지우고 데이터를 저장하지 않는다', async ({ page }) => {
  await ready(page)
  const before = await snapshot(page), modal = await openImport(page)
  await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name: 'QA-CHANGE-PRESET.csv', mimeType: 'text/csv', buffer: csv('QAFYDW9995BK') })
  await expect(modal.locator('.import-preview-table tbody tr').first()).toContainText('자동 등록 예정')
  await expect(modal.getByRole('region', { name: '미등록 스타일 등록', exact: true })).toHaveCount(0)
  await modal.getByLabel('오더 파일 형식', { exact: true }).selectOption('generic')
  await expect(modal.getByText('자동 등록 예정', { exact: true })).toHaveCount(0)
  await expect(modal.getByRole('button', { name: '품번 등록 및 수량 적용', exact: true })).toHaveCount(0)
  await expect(modal.getByLabel('오더 Excel 파일', { exact: true })).toBeEnabled()
  expect(await snapshot(page)).toEqual(before)
})
