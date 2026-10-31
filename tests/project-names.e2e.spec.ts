import { test, expect, type Locator, type Page } from '@playwright/test'
import ExcelJS from 'exceljs'
import { readFile } from 'node:fs/promises'
import type { Workspace } from '../src/lib/types'
import { parseOrderCSV } from '../src/lib/order-import'

const STORAGE = 'sig-workspace-demo-v1'
const FACTORY_ACTOR = '10000000-0000-4000-8000-000000000004'
const PROJECT_IDS = ['98100000-0000-4000-8000-000000000001', '98100000-0000-4000-8000-000000000002', '98100000-0000-4000-8000-000000000003', '98100000-0000-4000-8000-000000000004']
const PROJECT_CODES = ['SIGNIFICANT-2026FY-RPQ-46318', 'SIGNIFICANT-2026FY-RPQ-46319', 'SIGNIFICANT-2027FY-MPQ-47320', 'SIGNIFICANT-2026FY-MPQ-46321']
const SHARED_NAME = '시그니피컨트 2026 11M-1'
const CODES = ['QAPROJ000001', 'QAPROJ000002', 'QAPROJ000003', 'QAPROJ000004', 'QAPROJ000005']

async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, ids, projectCodes, codes, sharedName }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    const source = w.styles.find(style => style.samples.length)!, china = w.factories.find(factory => factory.country === '중국')!, korea = w.factories.find(factory => factory.country === '대한민국')!
    const ownerA = w.profiles.find(actor => actor.role === 'admin')!, ownerB = w.profiles.find(actor => actor.role === 'internal')!
    china.name = '프로젝트 QA 공장 A'; korea.name = '프로젝트 QA 공장 B'
    ownerA.name = '프로젝트 QA 담당 A'; ownerB.name = '프로젝트 QA 담당 B'
    w.projects = ids.map((id, index) => ({ id, code: projectCodes[index], name: index < 2 ? sharedName : index === 2 ? '시그니피컨트 2027 캡슐' : '', season: index === 2 ? '2027FY' : '2026FY' }))
    const zero = { XXS: 0, XS: 0, S: 0, M: 0, L: 0, XL: 0 }, stamp = { version: 1, createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', updatedBy: ownerA.id }
    w.styles = codes.map((code, index) => {
      const style = structuredClone(source), project = w.projects[[0, 1, 1, 2, 3][index]], owner = [ownerA, ownerB, ownerA, ownerA, ownerB][index]
      style.id = `98200000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`; style.code = code; style.name = `프로젝트 QA 스타일 ${index + 1}`
      style.projectId = project.id; style.season = project.season; style.factoryId = index === 2 || index === 4 ? korea.id : china.id; style.ownerId = owner.id
      style.colors = [['BK'], ['OW'], ['BK'], ['NV'], ['WH']][index]; style.stage = index < 3 ? 'production' : 'sample1'; style.ppApproved = false; style.deletedAt = null
      style.dueDate = '2027-01-30'; style.notes = ''; style.version = 1; style.updatedBy = ownerA.id
      style.samples = [{ ...style.samples[0], id: `98300000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, factoryId: style.factoryId, ownerId: owner.id, status: 'progress', plannedAt: '2026-11-15', request: '', factoryComment: '' }]
      style.production = [{ ...style.production[0], id: `98400000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, color: style.colors[0], ownerId: owner.id, order: { ...zero, M: 20 + index }, shipped: { ...zero, M: 10 + index }, received: { ...zero, M: 10 + index }, packing: { ...zero }, shippedAt: '2026-10-29', receivedAt: '2026-10-30', factoryComment: '' }]
      return style
    })
    w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []; w.productionRuns = []; w.productionReceipts = []; w.productionRunAudits = []; w.productionConditions = []; w.supplierProductionOrders = []; w.productionPoContexts = []
    w.settlementTerms = w.styles.map((style, index) => ({ ...stamp, styleId: style.id, lineId: style.production[0].id, projectCode: w.projects.find(project => project.id === style.projectId)!.code!, unitCost: 100 + index, itemType: 'product' }))
    w.settlementTermsAudits = []; w.settlementTermsAvailable = true
    w.operations!.orderSourceRecords = []; w.operations!.poDispatches = []; w.operations!.poDispatchAttempts = []; w.operations!.shipmentBatches = []; w.operations!.shipmentLedgers = []; w.operations!.styleOperations = []; w.operations!.calendarEvents = []
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, ids: PROJECT_IDS, projectCodes: PROJECT_CODES, codes: CODES, sharedName: SHARED_NAME })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}

async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: '메뉴 열기', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: name === '샘플 관리' ? /^샘플 관리/ : name, exact: name !== '샘플 관리' }).click()
}
async function filter(page: Page, label: string) {
  await page.getByRole('button', { name: label, exact: true }).click()
  const result = page.getByRole('dialog', { name: `${label} 선택`, exact: true })
  await expect(result).toBeVisible()
  return result
}
async function chooseProjects(page: Page, codes: string[]) {
  const popup = await filter(page, '프로젝트 명칭')
  await popup.getByRole('button', { name: '선택해제', exact: true }).click()
  for (const code of codes) await popup.getByRole('checkbox', { name: new RegExp(code) }).check()
  await page.keyboard.press('Escape')
}
async function choose(page: Page, label: string, values: string[]) {
  const popup = await filter(page, label)
  await popup.getByRole('button', { name: '선택해제', exact: true }).click()
  for (const value of values) await popup.getByRole('checkbox', { name: value, exact: true }).check()
  await page.keyboard.press('Escape')
}
async function downloadList(page: Page, format: 'csv' | 'xlsx') {
  await page.getByRole('button', { name: '다운로드', exact: true }).click()
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: format === 'csv' ? 'CSV 파일 (.csv)' : 'Excel 통합 문서 (.xlsx)', exact: true }).click()
  return readFile((await (await pending).path())!)
}
async function downloadEulji(page: Page, modal: Locator) {
  const pending = page.waitForEvent('download')
  await modal.getByRole('button', { name: '을지 다운로드', exact: true }).click()
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await readFile((await (await pending).path())!))
  return workbook
}
function dataRows(sheet: ExcelJS.Worksheet) {
  const headers = (sheet.getRow(1).values as string[]).slice(1)
  return [...Array(Math.max(0, sheet.rowCount - 1))].map((_, index) => Object.fromEntries(headers.map((header, column) => [header, sheet.getRow(index + 2).getCell(column + 1).value])))
}

test('공식 프로젝트 명칭·코드·시즌을 모든 목록에서 표시하며 같은 명칭도 ID별로 선택하고 검색·교차 필터·해제한다', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page)
  for (const view of ['오버뷰', '샘플 관리', '메인 생산', '결제 · 마감']) {
    await navigate(page, view)
    const first = page.locator('.styles-table tbody tr').filter({ hasText: CODES[0] })
    await expect(first).toContainText(SHARED_NAME)
    await expect(first).toContainText(PROJECT_CODES[0])
    await expect(first).toContainText('2026FY')
    const fallback = page.locator('.styles-table tbody tr').filter({ hasText: CODES[4] })
    await expect(fallback).toContainText(PROJECT_CODES[3])
  }
  await navigate(page, '오버뷰')
  const popup = await filter(page, '프로젝트 명칭')
  await popup.getByRole('searchbox', { name: '프로젝트 명칭 검색', exact: true }).fill(SHARED_NAME)
  await expect(popup.locator('.multi-select-filter-options input')).toHaveCount(2)
  await popup.getByRole('button', { name: '선택해제', exact: true }).click()
  await popup.getByRole('checkbox', { name: new RegExp(PROJECT_CODES[0]) }).check()
  await page.keyboard.press('Escape')
  await expect(page.locator('.style-code')).toHaveText([`${CODES[0]}BK`])
  await expect(page.getByRole('region', { name: '선택한 필터' }).or(page.locator('.dashboard-filter-chips'))).toContainText(SHARED_NAME)
  await chooseProjects(page, PROJECT_CODES.slice(0, 2))
  await expect(page.locator('.style-code')).toHaveCount(3)
  await choose(page, '시즌 필터', ['2026FY'])
  await choose(page, '공장 필터', ['프로젝트 QA 공장 A'])
  await expect(page.locator('.style-code')).toHaveText([`${CODES[0]}BK`, `${CODES[1]}OW`])
  await page.getByRole('button', { name: /^상세 필터/ }).click()
  await choose(page, '담당자', ['프로젝트 QA 담당 A'])
  await choose(page, '컬러', ['BK'])
  await choose(page, '진행 단계', ['메인 생산'])
  await expect(page.locator('.style-code')).toHaveText([`${CODES[0]}BK`])
  await page.getByRole('button', { name: '초기화', exact: true }).click()
  await expect(page.locator('.style-code')).toHaveCount(5)
  await page.getByLabel('전체 스타일 검색', { exact: true }).fill('2027 캡슐')
  await expect(page.locator('.style-code')).toHaveText([`${CODES[3]}NV`])
  await page.getByLabel('전체 스타일 검색', { exact: true }).fill('')
  await page.getByLabel('스타일 검색', { exact: true }).fill(SHARED_NAME)
  await expect(page.locator('.style-code')).toHaveCount(3)
  await page.getByLabel('스타일 검색', { exact: true }).fill('')
  await chooseProjects(page, [])
  await expect(page.getByRole('heading', { name: '조건에 맞는 스타일이 없습니다.' })).toBeVisible()
  const all = await filter(page, '프로젝트 명칭')
  await all.getByRole('checkbox', { name: '전체선택', exact: true }).check()
  await page.keyboard.press('Escape')
  await expect(page.locator('.style-code')).toHaveCount(5)
  expect(await snapshot(page)).toEqual(before)
})

test('선택한 프로젝트의 스타일·샘플·메인 생산 CSV와 Excel에 공식 명칭·코드를 함께 넣고 다른 프로젝트를 제외한다', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page)
  for (const [view, sheetName] of [['오버뷰', '스타일'], ['샘플 관리', '샘플 이력'], ['메인 생산', '메인 생산'], ['결제 · 마감', '메인 생산']]) {
    await navigate(page, view)
    await chooseProjects(page, [PROJECT_CODES[1]])
    const csv = parseOrderCSV((await downloadList(page, 'csv')).toString('utf8'))
    const headers = csv[0].map(value => String(value).replace(/^\uFEFF/, '')), nameColumn = headers.indexOf('프로젝트 명칭'), codeColumn = headers.indexOf('프로젝트 코드')
    expect(nameColumn).toBeGreaterThanOrEqual(0); expect(codeColumn).toBeGreaterThanOrEqual(0)
    expect(csv.slice(1).map(row => row[nameColumn])).toEqual([SHARED_NAME, SHARED_NAME])
    expect(csv.slice(1).map(row => row[codeColumn])).toEqual([PROJECT_CODES[1], PROJECT_CODES[1]])
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await downloadList(page, 'xlsx'))
    const rows = dataRows(workbook.getWorksheet(sheetName)!)
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row['프로젝트 명칭'])).toEqual([SHARED_NAME, SHARED_NAME])
    expect(rows.map(row => row['프로젝트 코드'])).toEqual([PROJECT_CODES[1], PROJECT_CODES[1]])
    for (const sheet of workbook.worksheets) {
      const text = JSON.stringify(sheet.getSheetValues())
      expect(text).not.toContain(CODES[0]); expect(text).not.toContain(CODES[3]); expect(text).not.toContain(CODES[4])
    }
  }
  expect(await snapshot(page)).toEqual(before)
})

test('을지는 화면 프로젝트를 기본 선택하고 명칭 검색·품번 조합으로 여러 프로젝트를 통합하되 고정 셀·수식을 유지한다', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page)
  await navigate(page, '결제 · 마감')
  await chooseProjects(page, [PROJECT_CODES[0]])
  await page.getByRole('button', { name: '을지 양식 다운로드', exact: true }).click()
  const modal = page.getByRole('dialog', { name: '마감 양식에 채워서 다운로드', exact: true })
  await expect(modal.getByRole('checkbox', { name: `을지 프로젝트 ${PROJECT_IDS[0]}`, exact: true })).toBeChecked()
  await expect(modal.getByRole('checkbox', { name: `을지 프로젝트 ${PROJECT_IDS[1]}`, exact: true })).not.toBeChecked()
  await modal.getByRole('searchbox', { name: '을지 프로젝트 명칭 검색', exact: true }).fill(SHARED_NAME)
  await expect(modal.getByRole('checkbox', { name: /^을지 프로젝트 / })).toHaveCount(2)
  await modal.getByRole('checkbox', { name: `을지 프로젝트 ${PROJECT_IDS[1]}`, exact: true }).check()
  await modal.getByRole('searchbox', { name: '을지 프로젝트 명칭 검색', exact: true }).fill('')
  await modal.getByRole('button', { name: '을지 스타일 전체 선택', exact: true }).click()
  const first = await downloadEulji(page, modal), firstSheet = first.getWorksheet('대금지급(을)')!
  expect([3, 4, 5].map(row => firstSheet.getCell(`A${row}`).value)).toEqual([PROJECT_CODES[0], PROJECT_CODES[1], PROJECT_CODES[1]])
  expect(firstSheet.getCell('A6').value).toBeNull()
  const guide = first.getWorksheet('프로젝트 안내')!
  expect(guide).toBeTruthy()
  expect(guide.getCell('B1').value).toBe('프로젝트 명칭'); expect(guide.getCell('C1').value).toBe('프로젝트 코드')
  expect(guide.getCell('B2').value).toBe(SHARED_NAME); expect(guide.getCell('C2').value).toBe(PROJECT_CODES[0])
  expect(JSON.stringify(guide.getSheetValues())).toContain(SHARED_NAME)
  expect(JSON.stringify(guide.getSheetValues())).toContain(PROJECT_CODES[0])
  expect(JSON.stringify(guide.getSheetValues())).toContain(PROJECT_CODES[1])
  expect(JSON.stringify(guide.getSheetValues())).not.toContain(PROJECT_CODES[2])
  expect(firstSheet.getCell('N3').value).toBe(100); expect(firstSheet.getCell('R3').value).toBe(10); expect(firstSheet.getCell('T3').value).toBe(1000)
  expect(firstSheet.getCell('U3').formula).toBeTruthy(); expect(firstSheet.getCell('V3').formula).toBeTruthy()
  expect(firstSheet.getCell('M3').formula).toContain('MID(')
  await modal.getByRole('button', { name: '을지 스타일 전체 해제', exact: true }).click()
  const target = before.styles[1]
  await modal.getByRole('checkbox', { name: `을지 스타일 ${target.id}:${target.production[0].id}`, exact: true }).check()
  const one = await downloadEulji(page, modal), oneSheet = one.getWorksheet('대금지급(을)')!
  expect(oneSheet.getCell('A3').value).toBe(PROJECT_CODES[1]); expect(oneSheet.getCell('I3').value).toBe(`${CODES[1]}OW`)
  expect(oneSheet.getCell('A4').value).toBeNull()
  await modal.getByRole('button', { name: '을지 프로젝트 전체 해제', exact: true }).click()
  await expect(modal.getByRole('button', { name: '을지 다운로드', exact: true })).toBeDisabled()
  expect(await snapshot(page)).toEqual(before)
})

test('모바일에서 프로젝트 명칭과 선택 내용을 표시하고 외부 공장에는 배정 스타일의 프로젝트만 조회·다운로드한다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  const before = await snapshot(page)
  const popup = await filter(page, '프로젝트 명칭')
  await popup.getByRole('searchbox', { name: '프로젝트 명칭 검색', exact: true }).fill(SHARED_NAME)
  await popup.getByRole('button', { name: '선택해제', exact: true }).click()
  await popup.getByRole('checkbox', { name: new RegExp(PROJECT_CODES[0]) }).check()
  await popup.getByRole('checkbox', { name: new RegExp(PROJECT_CODES[1]) }).check()
  const box = await popup.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '프로젝트 명칭', exact: true })).toContainText(SHARED_NAME)
  await expect(page.locator('.style-code')).toHaveCount(3)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await page.getByLabel('체험 역할').selectOption(FACTORY_ACTOR)
  await expect(page.locator('.style-code')).toHaveCount(2)
  const factoryProjects = await filter(page, '프로젝트 명칭')
  await expect(factoryProjects.getByRole('checkbox', { name: new RegExp(PROJECT_CODES[3]) })).toHaveCount(0)
  await page.keyboard.press('Escape')
  const csv = (await downloadList(page, 'csv')).toString('utf8')
  expect(csv).toContain(CODES[0]); expect(csv).toContain(CODES[1]); expect(csv).not.toContain(CODES[2]); expect(csv).not.toContain(CODES[3]); expect(csv).not.toContain(CODES[4])
  expect(await snapshot(page)).toEqual(before)
})
