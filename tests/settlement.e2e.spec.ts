import { test, expect, type Page, type Locator } from '@playwright/test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { readFile } from 'node:fs/promises'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1'
const INTERNAL = '10000000-0000-4000-8000-000000000002'
const FACTORY = '10000000-0000-4000-8000-000000000004'
const CODE = 'BO42FYHD0102'
const PROJECT = 'QA-2026FY-MPQ-001'
const SOURCE_COLUMNS = ['A', 'F', 'L', 'M', 'S', 'V', 'W', 'X', 'Y', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AV', 'AY']

async function ready(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function stored(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page, code = CODE) {
  await ready(page)
  await page.evaluate(({ key, code, original, actor, project, columns }) => {
    const workspace = JSON.parse(localStorage.getItem(key)!)
    const style = workspace.styles.find((item: { code: string }) => item.code === original)
    workspace.styles = [style]
    style.code = code; style.ownerId = actor
    workspace.profiles.find((item: { id: string }) => item.id === actor).name = 'QA 담당자'
    workspace.factories.find((item: { id: string }) => item.id === style.factoryId).name = 'QA 업체'
    for (const line of style.production) {
      line.order = { XXS: 1, XS: 2, S: 3, M: 4, L: 5, XL: 6 }
      line.received = { XXS: 0, XS: 0, S: 7, M: 2, L: 0, XL: 0 }
      line.receivedAt = '2026-10-24'; line.invoiceAmount = 987654321
    }
    workspace.settlementTerms = []; workspace.settlementTermsAudits = []; workspace.settlementTermsAvailable = true
    workspace.operations.orderSourceRecords = [{ styleId: style.id, lineId: style.production[0].id, fileName: 'QA-원본.csv', sheetName: 'ORDER QTY',
      headers: Object.fromEntries(columns.map((column: string) => [column, `QA ${column}`])),
      rows: [{ rowNumber: 8, columns: Object.fromEntries(columns.map((column: string) => [column, column === 'A' ? project : column === 'F' ? `${code}BK` : null])) }],
      version: 1, createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z', updatedBy: actor }]
    localStorage.setItem(key, JSON.stringify(workspace))
  }, { key: STORAGE, code, original: CODE, actor: INTERNAL, project: PROJECT, columns: SOURCE_COLUMNS })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: '메뉴 열기', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name, exact: true }).click()
}
async function openTerms(page: Page, code = CODE) {
  await page.getByLabel('스타일 검색', { exact: true }).fill(code)
  await page.locator('.style-code').filter({ hasText: code }).first().click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /을지·단가/ }).click()
  return detail
}
async function editTerms(detail: Locator, cost: string, itemType = 'product') {
  await detail.getByRole('button', { name: '단가·을지 정보 수정', exact: true }).click()
  await detail.getByLabel('장당 원가', { exact: true }).fill(cost)
  await detail.getByLabel('을지 품목 구분', { exact: true }).selectOption(itemType)
  await detail.getByLabel('단가·을지 변경 사유', { exact: true }).fill('QA 실제 입고 기준 단가 확인')
}
async function saveTerms(detail: Locator) {
  await detail.getByRole('button', { name: '단가·을지 정보 저장', exact: true }).click()
  await expect(detail.getByRole('status').filter({ hasText: '단가·을지 정보를 저장했습니다.' })).toBeVisible()
}
async function exportModal(page: Page, sku = `${CODE}BK`) {
  await navigate(page, '결제 · 마감')
  await page.getByLabel('스타일 검색', { exact: true }).fill(sku)
  await page.getByRole('button', { name: '을지 양식 다운로드', exact: true }).click()
  const modal = page.getByRole('dialog', { name: '마감 양식에 채워서 다운로드', exact: true })
  await expect(modal.getByRole('tab', { name: 'SIG 을지 자동 작성', exact: true })).toHaveAttribute('aria-selected', 'true')
  return modal
}
async function downloadWorkbook(page: Page, modal: Locator) {
  const waiting = page.waitForEvent('download')
  await modal.getByRole('button', { name: '을지 다운로드', exact: true }).click()
  const download = await waiting, path = test.info().outputPath('SIG_을지_QA.xlsx')
  await download.saveAs(path)
  const bytes = await readFile(path)
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes)
  return { workbook, bytes }
}

test('본사 단가를 저장하고 필터한 컬러만 실제 을지 양식의 지정 열과 부가세 수식에 채운다', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await fixture(page)
  const before = await stored(page), detail = await openTerms(page)
  await editTerms(detail, '100.25')
  await expect(detail.getByLabel('을지 프로젝트 코드', { exact: true })).toHaveValue(PROJECT)
  await saveTerms(detail)
  const snapshot = await stored(page)
  expect(snapshot.settlementTerms?.[0]).toMatchObject({ unitCost: 100.25, projectCode: PROJECT, itemType: 'product', version: 1 })
  expect(snapshot.styles[0]).toEqual(before.styles[0])
  expect(snapshot.settlementTermsAudits).toHaveLength(1)
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  const modal = await exportModal(page)
  await expect(modal.getByRole('button', { name: '을지 다운로드', exact: true })).toBeEnabled()
  await expect(modal.getByRole('tabpanel', { name: 'SIG 을지 자동 작성', exact: true }).getByRole('alert')).toHaveCount(0)
  await page.screenshot({ path: 'docs/screenshots/settlement-export.png' })
  const { workbook, bytes } = await downloadWorkbook(page, modal)
  const sheet = workbook.getWorksheet('대금지급(을)')!
  expect(sheet.rowCount).toBe(3)
  const expected = { A3: PROJECT, D3: 'QA 업체', I3: `${CODE}BK`, N3: 100.25, O3: 1, P3: 21, Q3: 21, R3: 9, S3: 'EA', T3: 902.25, W3: 'QA 담당자' }
  for (const [address, value] of Object.entries(expected)) expect(sheet.getCell(address).value, address).toBe(value)
  expect(sheet.getCell('C3').value).toEqual(new Date('2026-10-24T00:00:00Z'))
  expect(sheet.getCell('U3').result).toBeCloseTo(90.225)
  expect(sheet.getCell('V3').result).toBeCloseTo(992.475)
  expect(sheet.getCell('T1').result).toBeCloseTo(902.25)
  expect(sheet.getCell('V1').result).toBeCloseTo(992.475)
  expect(sheet.getCell('B3').value).toBeNull()
  expect(sheet.getCell('M3').formula).toContain('MID(')
  const zip = await JSZip.loadAsync(bytes), source = await JSZip.loadAsync(await readFile('src/assets/sig-eulji-template.xlsx'))
  expect(await zip.file('xl/tables/table1.xml')!.async('string')).toContain('ref="A2:X3"')
  expect(await zip.file('xl/printerSettings/printerSettings1.bin')!.async('uint8array')).toEqual(await source.file('xl/printerSettings/printerSettings1.bin')!.async('uint8array'))
})

test('원가 미입력은 0원과 구분하고 원단은 YDS, 라벨은 EA를 사용하며 공장에는 단가를 숨긴다', async ({ page }) => {
  await fixture(page)
  const missing = await exportModal(page)
  await expect(missing.getByRole('button', { name: '을지 다운로드', exact: true })).toBeDisabled()
  await expect(missing.getByRole('tabpanel', { name: 'SIG 을지 자동 작성' }).getByRole('alert')).toContainText('장당 원가')
  await missing.getByLabel('닫기', { exact: true }).click()
  const detail = await openTerms(page)
  await editTerms(detail, '0', 'fabric'); await saveTerms(detail)
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  const fabric = await exportModal(page)
  const first = await downloadWorkbook(page, fabric), fabricSheet = first.workbook.getWorksheet('대금지급(을)')!
  expect(fabricSheet.getCell('N3').value).toBe(0)
  expect(fabricSheet.getCell('S3').value).toBe('YDS')
  expect(fabricSheet.getCell('R3').value).toBe(9)
  expect(fabricSheet.getCell('T3').value).toBe(0)
  await fabric.getByLabel('닫기', { exact: true }).click()
  const again = await openTerms(page)
  await editTerms(again, '2.50', 'label'); await saveTerms(again)
  await again.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  const label = await exportModal(page), second = await downloadWorkbook(page, label)
  expect(second.workbook.getWorksheet('대금지급(을)')!.getCell('S3').value).toBe('EA')
  expect(second.workbook.getWorksheet('대금지급(을)')!.getCell('T3').value).toBe(22.5)
  await label.getByLabel('닫기', { exact: true }).click()
  await page.getByLabel('체험 역할').selectOption(FACTORY)
  await page.getByLabel('스타일 검색', { exact: true }).fill(CODE)
  await page.locator('.style-code').first().click()
  const factoryDetail = page.getByRole('dialog')
  await expect(factoryDetail.getByRole('tab', { name: /을지·단가/ })).toHaveCount(0)
  await factoryDetail.getByRole('tab', { name: /변경 이력/ }).click()
  await expect(factoryDetail).not.toContainText(PROJECT)
  await expect(factoryDetail).not.toContainText('2.50')
})

test('두 탭의 단가 수정 충돌 시 입력을 유지하고 모바일에서 미저장 닫기를 보호한다', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  const detail = await openTerms(page)
  await editTerms(detail, '125.5')
  const other = await context.newPage(); await ready(other)
  const second = await openTerms(other); await editTerms(second, '200'); await saveTerms(second)
  await expect(detail.getByRole('status').filter({ hasText: /다른 사용자가 단가/ })).toBeVisible()
  await expect(detail.getByLabel('장당 원가', { exact: true })).toHaveValue('125.5')
  await expect(detail.getByRole('button', { name: '단가·을지 정보 저장', exact: true })).toBeDisabled()
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  const warning = detail.getByRole('alertdialog')
  await expect(warning).toContainText('저장하지 않은 변경')
  await warning.getByRole('button', { name: '편집 계속', exact: true }).click()
  await expect(detail.getByLabel('장당 원가', { exact: true })).toHaveValue('125.5')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'docs/screenshots/settlement-mobile.png' })
  expect((await stored(page)).settlementTerms?.[0].unitCost).toBe(200)
  await detail.getByRole('button', { name: '단가 편집 취소', exact: true }).click()
  await expect(detail.getByLabel('장당 원가', { exact: true })).toHaveValue('200')
  await other.close()
})

test('CP949 153열 CSV의 실제 제목 행 구조를 인식하고 선택한 16개 열만 가져온다', async ({ page }) => {
  await fixture(page, 'TESTSTYLE01')
  await page.evaluate(key => {
    const workspace = JSON.parse(localStorage.getItem(key)!) as Workspace
    const project = workspace.projects.find(item => item.id === workspace.styles[0].projectId)!
    project.code = 'TEST-PROJECT-2026'; project.name = '검증 프로젝트'; project.season = '2026FY'
    localStorage.setItem(key, JSON.stringify(workspace))
  }, STORAGE)
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await navigate(page, '메인 생산')
  await page.getByRole('button', { name: '오더 엑셀 업로드', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Excel 오더 수량 가져오기', exact: true })
  await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles('tests/fixtures/sig-order-geometry-cp949.csv')
  await expect(modal.getByLabel('오더 파일 형식', { exact: true })).toHaveValue('sig-order-qty')
  await expect(modal.getByLabel('Excel 제목 행', { exact: true })).toHaveValue('7')
  await expect(modal).toContainText('CP949')
  await expect(modal.locator('.import-preview-summary')).toContainText('오류 0')
  await modal.getByLabel('오더 변경 사유', { exact: true }).fill('QA CP949 실제 헤더 구조 대조')
  await modal.getByRole('button', { name: '검증된 오더 적용', exact: true }).click()
  await expect(modal.getByRole('button', { name: '적용 완료', exact: true })).toBeDisabled()
  const snapshot = await stored(page), line = snapshot.styles[0].production[0]
  expect(line.order).toEqual({ XXS: 10, XS: 20, S: 30, M: 40, L: 50, XL: 60 })
  expect(line.received).toEqual({ XXS: 0, XS: 0, S: 7, M: 2, L: 0, XL: 0 })
  const source = snapshot.operations!.orderSourceRecords.find(item => item.lineId === line.id)!
  expect(source.rows).toHaveLength(1)
  expect(source.rows[0].rowNumber).toBe(8)
  expect(source.rows[0].columns.A).toBe('TEST-PROJECT-2026')
  expect(Object.keys(source.rows[0].columns)).toEqual(SOURCE_COLUMNS)
  expect(source.headers.W.trim()).toBe('생산처')
  expect(snapshot.productionRuns).toHaveLength(1)
  expect(snapshot.productionRuns![0]).toMatchObject({ styleId: snapshot.styles[0].id, projectCode: 'TEST-PROJECT-2026', round: 1, order: line.order })
})
