import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { parseOrderCSV } from '../src/lib/order-import'
import { quantityTotal, type Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1'
const INTERNAL = '10000000-0000-4000-8000-000000000002'
const fixturePath = new URL('./fixtures/sig-order-26-cp949.csv', import.meta.url)
const factoryId = (number: number) => `97000000-0000-4000-8000-${String(number).padStart(12, '0')}`

async function workspace(page: Page): Promise<Workspace> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE)
}
async function ready(page: Page, unknownFactory = false) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, unknownFactory }) => {
    const saved = JSON.parse(localStorage.getItem(key)!) as Workspace
    saved.styles = []; saved.projects = []; saved.comments = []; saved.attachments = []; saved.audits = []; saved.styleImages = []
    saved.productionRuns = []; saved.productionReceipts = []; saved.productionRunAudits = []; saved.supplierProductionOrders = []
    saved.productionDetails = []; saved.settlementTerms = []; saved.settlementTermsAudits = []
    saved.operations!.orderSourceRecords = []; saved.operations!.poDispatches = []; saved.operations!.poDispatchAttempts = []
    saved.operations!.shipmentLedgers = []; saved.operations!.shipmentBatches = []; saved.operations!.styleOperations = []
    saved.factories = Array.from({ length: 8 }, (_, index) => ({ id: `97000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, name: unknownFactory && index === 7 ? 'QA 등록명 다른 공장' : `QA 공장 ${index + 1}`, country: '대한민국' }))
    for (const profile of saved.profiles) if (profile.role === 'factory' && profile.factoryId) profile.factoryId = saved.factories[0].id
    localStorage.setItem(key, JSON.stringify(saved))
  }, { key: STORAGE, unknownFactory })
  await page.reload()
  await page.getByLabel('체험 역할', { exact: true }).selectOption(INTERNAL)
  const menu = page.getByRole('button', { name: '메뉴 열기', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '메인 생산', exact: true }).click()
}
async function upload(page: Page, bytes?: Buffer, name = 'qa-26-order.csv') {
  await page.getByRole('button', { name: '오더 엑셀 업로드', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Excel 오더 수량 가져오기', exact: true })
  await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name, mimeType: 'text/csv', buffer: bytes || await readFile(fixturePath) })
  await expect(modal.getByRole('heading', { name: '적용 전 미리보기', exact: true })).toBeVisible()
  return modal
}
async function fixtureRows() {
  return parseOrderCSV(new TextDecoder('euc-kr').decode(await readFile(fixturePath)))
}
function csvBytes(rows: Awaited<ReturnType<typeof fixtureRows>>) {
  const quote = (value: unknown) => {
    const text = value == null ? '' : String(value)
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  return Buffer.from('\uFEFF' + rows.map(row => row.map(quote).join(',')).join('\r\n'), 'utf8')
}

test('CP949 26개 품번은 별도 등록과 납기 입력 없이 한 번 적용해 자동 등록하고 같은 수량 리오더를 분리한다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await ready(page)
  const modal = await upload(page)
  const expected = (await fixtureRows()).slice(7, 33)
  await expect(modal.getByRole('button', { name: '미등록 품번 일괄 등록', exact: true })).toHaveCount(0)
  await expect(modal.getByRole('button', { name: '스타일·프로젝트 등록', exact: true })).toHaveCount(0)
  await expect(modal.getByRole('button', { name: '프로젝트 연결', exact: true })).toHaveCount(0)
  await expect(modal.locator('.import-row-error')).toHaveCount(0)
  await expect(modal.getByText('자동 등록 예정', { exact: true }).first()).toBeVisible()
  const beforeApply = await workspace(page)
  expect(beforeApply.styles).toHaveLength(0); expect(beforeApply.projects).toHaveLength(0)
  const apply = modal.getByRole('button', { name: '검증된 오더 적용', exact: true })
  await expect(apply).toBeEnabled()
  await apply.click()
  await expect(modal.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
  let saved = await workspace(page)
  expect(saved.styles).toHaveLength(19)
  expect(saved.styles.flatMap(style => style.production)).toHaveLength(26)
  expect(saved.projects).toHaveLength(1)
  expect(saved.projects[0]).toMatchObject({ code: 'QA-PROJECT-2026-RPQ-00001', name: 'QA 2026 생산 프로젝트', season: '2026FY' })
  expect(saved.productionRuns).toHaveLength(26)
  expect(saved.productionRuns!.reduce((total, run) => total + quantityTotal(run.order), 0)).toBe(7950)
  expect(saved.styles.reduce((total, style) => total + style.production.reduce((sum, line) => sum + quantityTotal(line.order), 0), 0)).toBe(7950)
  for (const row of expected) {
    const code = String(row[5]).trim(), style = saved.styles.find(item => `${item.code}${String(row[5]).trim().slice(-2)}` === code)!
    const line = style.production.find(item => item.color === code.slice(-2))!
    expect(style.ownerId).toBe(''); expect(line.ownerId).toBe(''); expect(style.dueDate).toBe('')
    expect(style.factoryId).toBe(factoryId(Number(String(row[22]).trim().split(' ').at(-1))))
    expect(style.samples).toEqual([]); expect(style.ppApproved).toBe(false)
    expect(Object.values(line.shipped)).toEqual([0, 0, 0, 0, 0, 0]); expect(Object.values(line.received)).toEqual([0, 0, 0, 0, 0, 0])
    expect(Object.values(line.order)).toEqual(row.slice(42, 48).map(value => String(value).trim() === '-' ? 0 : Number(String(value).trim())))
  }
  const sources = saved.operations!.orderSourceRecords
  expect(sources).toHaveLength(26)
  const sizeColumns = ['AQ', 'AR', 'AS', 'AT', 'AU', 'AV'] as const
  expect(sources.filter(source => source.rows.some(row => sizeColumns.some(column => String(row.columns[column]).trim() === '-')))).toHaveLength(9)
  expect(sources.every(source => source.rows.every(row => !Object.hasOwn(row.columns, 'I')))).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  const priorRuns = structuredClone(saved.productionRuns!)
  await modal.locator('.order-import-close').getByRole('button', { name: '닫기', exact: true }).click()
  const second = await upload(page)
  await expect(second.getByRole('button', { name: '미등록 품번 일괄 등록', exact: true })).toHaveCount(0)
  await second.getByRole('button', { name: '검증된 오더 적용', exact: true }).click()
  await expect(second.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
  saved = await workspace(page)
  expect(saved.styles).toHaveLength(19); expect(saved.projects).toHaveLength(1)
  expect(saved.productionRuns).toHaveLength(52)
  for (const run of priorRuns) expect(saved.productionRuns!.find(item => item.id === run.id)).toEqual(run)
  expect(saved.productionRuns!.filter(run => run.round === 2)).toHaveLength(26)
  expect(saved.styles.reduce((total, style) => total + style.production.reduce((sum, line) => sum + quantityTotal(line.order), 0), 0)).toBe(7950)
})

test('납기가 없어도 자동 등록하며 매칭되지 않은 생산처만 한 번 연결한다', async ({ page }) => {
  await ready(page, true)
  const modal = await upload(page)
  const settings = modal.locator('[aria-label="업로드 기본 설정"]')
  const apply = modal.getByRole('button', { name: '검증된 오더 적용', exact: true })
  await expect(settings.getByLabel('일괄 등록 기준 납기일', { exact: true })).toHaveValue('')
  await expect(settings.getByLabel('일괄 등록 공장 QA 공장 8', { exact: true })).toHaveValue('')
  await expect(apply).toBeDisabled()
  let saved = await workspace(page)
  expect(saved.styles).toHaveLength(0); expect(saved.projects).toHaveLength(0); expect(saved.productionRuns).toHaveLength(0)
  await settings.getByLabel('일괄 등록 공장 QA 공장 8', { exact: true }).selectOption(factoryId(8))
  await expect(apply).toBeEnabled()
  saved = await workspace(page)
  expect(saved.styles).toHaveLength(0)
  await apply.click()
  await expect(modal.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
  saved = await workspace(page)
  expect(saved.styles).toHaveLength(19)
  expect(saved.styles.every(style => style.dueDate === '')).toBe(true)
})

for (const invalid of [{ name: '음수 사이즈', column: 42, value: '-1' }, { name: 'AY 합계 불일치', column: 50, value: '9999' }]) {
  test(`${invalid.name}가 있으면 품번·프로젝트를 하나도 저장하지 않고 전체 적용을 막는다`, async ({ page }) => {
    await ready(page)
    const rows = await fixtureRows(); rows[7][invalid.column] = invalid.value
    const modal = await upload(page, csvBytes(rows), 'qa-invalid-order.csv')
    await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeDisabled()
    const saved = await workspace(page)
    expect(saved.styles).toHaveLength(0); expect(saved.projects).toHaveLength(0); expect(saved.productionRuns).toHaveLength(0)
  })
}

test('Y열은 컬러별 담당자를 연결하고 빈칸은 업로더로 채우지 않는다', async ({ page }) => {
  await ready(page)
  const before = await workspace(page), rows = await fixtureRows()
  const admin = before.profiles.find(person => person.role === 'admin')!
  const internal = before.profiles.find(person => person.id === INTERNAL)!
  rows.find(row => row[5] === 'QA26FYTS0003BK')![24] = admin.name
  rows.find(row => row[5] === 'QA26FYTS0003NV')![24] = internal.email.toUpperCase()
  const modal = await upload(page, csvBytes(rows), 'qa-Y-owner.csv')
  await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeEnabled()
  await modal.getByRole('button', { name: '검증된 오더 적용', exact: true }).click()
  await expect(modal.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
  const saved = await workspace(page), style = saved.styles.find(item => item.code === 'QA26FYTS0003')!
  const black = style.production.find(line => line.color === 'BK')!, navy = style.production.find(line => line.color === 'NV')!
  expect(black.ownerId).toBe(admin.id)
  expect(navy.ownerId).toBe(internal.id)
  expect(saved.productionRuns!.find(run => run.styleId === style.id && run.lineId === black.id)!.ownerIdSnapshot).toBe(admin.id)
  expect(saved.productionRuns!.find(run => run.styleId === style.id && run.lineId === navy.id)!.ownerIdSnapshot).toBe(internal.id)
  const blankStyle = saved.styles.find(item => item.code === 'QA26FYTS0001')!
  expect(blankStyle.ownerId).toBe('')
  expect(blankStyle.production[0].ownerId).toBe('')
  const blankRun = saved.productionRuns!.find(run => run.styleId === blankStyle.id)!
  expect(blankRun.ownerIdSnapshot).toBe('')
  expect(blankRun.ownerNameSnapshot).toBe('')
})

test('Y열의 모르는 이름만 한 번 연결하고 빈 담당자 행은 그대로 둔다', async ({ page }) => {
  await ready(page)
  const rows = await fixtureRows()
  rows[7][24] = 'CSV 담당자 별칭'
  rows[8][24] = 'CSV 담당자 별칭'
  const modal = await upload(page, csvBytes(rows), 'qa-Y-unmatched.csv')
  const apply = modal.getByRole('button', { name: '검증된 오더 적용', exact: true })
  await expect(apply).toBeDisabled()
  await expect(modal.getByLabel('Y열 담당자 연결 CSV 담당자 별칭', { exact: true })).toHaveValue('')
  await modal.getByLabel('Y열 담당자 연결 CSV 담당자 별칭', { exact: true }).selectOption(INTERNAL)
  await expect(apply).toBeEnabled()
  await apply.click()
  await expect(modal.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
  const saved = await workspace(page)
  expect(saved.styles.find(item => item.code === 'QA26FYTS0001')!.production[0].ownerId).toBe(INTERNAL)
  expect(saved.styles.find(item => item.code === 'QA26FYTS0002')!.production[0].ownerId).toBe(INTERNAL)
  expect(saved.styles.find(item => item.code === 'QA26FYTS0003')!.production.every(line => line.ownerId === '')).toBe(true)
})
