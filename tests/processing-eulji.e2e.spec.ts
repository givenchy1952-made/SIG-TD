import { test, expect, type Page } from '@playwright/test'
import ExcelJS from 'exceljs'
import { readFile } from 'node:fs/promises'

const STORAGE = 'sig-workspace-demo-v1', CODE = 'BO42FYHD0102'
async function fixture(page: Page, empty = false, priced = false) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, code, empty, priced }) => {
    const w = JSON.parse(localStorage.getItem(key)!), style = w.styles.find((item: { code: string }) => item.code === code)
    w.styles = [style]; w.settlementTerms = []; w.settlementTermsAvailable = true; w.refinementsAvailable = true
    w.projects.find((p: { id: string }) => p.id === style.projectId).code = 'QA-PROCESSING-001'
    style.production.forEach((line: { color: string; order: Record<string, number>; shipped: Record<string, number>; received: Record<string, number>; receivedAt: string }) => {
      for (const field of ['order', 'shipped', 'received'] as const) for (const size of Object.keys(line[field])) line[field][size] = 0
      const first = line.color === 'BK'
      line.order.M = first ? 290 : 120; line.shipped.M = first ? 300 : 110; line.received.M = first ? 277 : 99; line.receivedAt = first ? '2026-10-26' : '2026-10-27'
    })
    const stamp = { version: 1, createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z', updatedBy: style.ownerId }
    const row = (name: string, quantity: number, loss: number, completed: number, date = '') => ({ id: crypto.randomUUID(), catalogId: crypto.randomUUID(), name, specification: 'QA 별도 작업', quantity, lossQuantity: loss, completedQuantity: completed, status: 'progress', orderedAt: '2026-10-01', requestedAt: '', completedAt: date, dueDate: '', note: 'QA 담당자 확인' })
    const labels = [row('QA 포인트 라벨', 100, 5, 0), row('QA 케어 라벨', 200, 8, 0)]
    w.operations.styleOperations = [{ ...stamp, id: crypto.randomUUID(), styleId: style.id, kind: 'label', rows: labels, note: '', voided: false }, { ...stamp, id: crypto.randomUUID(), styleId: style.id, kind: 'embroidery', rows: [row('QA 자수 작업', 50, 0, 40, '2026-10-23')], note: '', voided: false }, { ...stamp, id: crypto.randomUUID(), styleId: style.id, kind: 'label', rows: [row('QA 무효 라벨', 999, 0, 0)], note: '', voided: true }]
    const measurements = { upper: [], lower: [] }
    w.productionDetails = style.production.slice(0, 2).map((line: { id: string }, index: number) => ({ ...stamp, styleId: style.id, lineId: line.id, quality: { category: '티셔츠', quantity: index === 0 ? 12 : 99, status: 'done', requestedAt: '2026-10-20', completedAt: '2026-10-24', note: 'QA 품질검사 완료' }, measurements }))
    w.processingPricesAvailable = true; w.processingUnitPrices = []
    if (priced) for (const line of style.production) {
      for (const record of w.operations.styleOperations.filter((item: { voided: boolean }) => !item.voided)) for (const item of record.rows) w.processingUnitPrices.push({ ...stamp, styleId: style.id, lineId: line.id, kind: record.kind, itemKey: item.id, unitCost: record.kind === 'label' ? 2.5 : 10 })
      w.processingUnitPrices.push({ ...stamp, styleId: style.id, lineId: line.id, kind: 'quality', itemKey: '티셔츠', unitCost: 100 })
    }
    if (empty) { w.operations.styleOperations = []; w.productionDetails = []; w.processingUnitPrices = [] }
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, code: CODE, empty, priced })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '결제 · 마감', exact: true }).click()
  await page.getByLabel('스타일 검색', { exact: true }).fill(`${CODE}BK`)
  await page.getByRole('button', { name: '을지 양식 다운로드', exact: true }).click()
  return page.getByRole('dialog', { name: '마감 양식에 채워서 다운로드', exact: true })
}

test('가공·품질 을지의 입고일·컬러 품번과 종류별 실출고·실입고를 채우며 미등록 단가는 공란으로 보존한다', async ({ page }) => {
  const modal = await fixture(page)
  await expect(modal.getByRole('button', { name: '을지 다운로드', exact: true })).toBeDisabled()
  const cases = [{ tab: '중화라벨', vendor: '주식회사 중화라벨', count: 2, actual: 300, name: 'QA 포인트 라벨' }, { tab: '비와이 자수', vendor: 'BY컴퓨터자수', count: 1, actual: 277, name: 'QA 자수 작업' }, { tab: '품질검사', vendor: null, count: 1, actual: 277, name: '티셔츠' }]
  for (const item of cases) {
    await modal.getByRole('tab', { name: item.tab, exact: true }).click()
    await expect(modal.getByRole('button', { name: '을지 다운로드', exact: true })).toBeEnabled()
    const pending = page.waitForEvent('download')
    await modal.getByRole('button', { name: '을지 다운로드', exact: true }).click()
    const download = await pending
    expect(download.suggestedFilename()).toContain(item.tab)
    const bytes = await readFile((await download.path())!)
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes)
    const sheet = workbook.getWorksheet('대금지급(을)')!
    expect(sheet.rowCount).toBe(item.count + 2)
    expect(sheet.getCell('A3').value).toBe('QA-PROCESSING-001')
    expect(sheet.getCell('D3').value).toBe(item.vendor)
    expect(sheet.getCell('C3').value).toEqual(new Date('2026-10-26T00:00:00Z'))
    expect(sheet.getCell('I3').value).toBe(`${CODE}BK`)
    expect(sheet.getCell('M3').result).toBe('BK')
    expect(String(sheet.getCell('L3').value)).toContain(item.name)
    expect(sheet.getCell('N3').value).toBeNull()
    expect(sheet.getCell('P3').value).toBe(290)
    expect(sheet.getCell('Q3').value).toBe(290)
    expect(sheet.getCell('R3').value).toBe(item.actual)
    expect(sheet.getCell('S3').value).toBe('EA')
    expect(sheet.getCell('T3').formula).toContain('IF(')
    expect(sheet.getCell('U3').formula).toBeTruthy()
    expect(sheet.getCell('V3').formula).toBeTruthy()
    if (item.tab === '중화라벨') {
      expect(String(sheet.getCell('X3').value)).toContain('5')
      expect(sheet.getCell('P4').value).toBe(290)
      expect(String(sheet.getCell('X4').value)).toContain('작업 요청 수량 200개')
    }
    if (item.tab === '품질검사') {
      expect(sheet.getCell('I3').value).toBe(`${CODE}BK`)
      sheet.getCell('D3').value = 'QA 담당자가 입력한 검사 업체'
      const edited = new ExcelJS.Workbook(); await edited.xlsx.load(await workbook.xlsx.writeBuffer())
      expect(edited.getWorksheet('대금지급(을)')!.getCell('D3').value).toBe('QA 담당자가 입력한 검사 업체')
    }
  }
})

test('등록된 작업이 없으면 항목별 다운로드를 막고 메인 제품 원가도 대신 사용하지 않는다', async ({ page }) => {
  const modal = await fixture(page, true)
  for (const tab of ['중화라벨', '비와이 자수', '품질검사']) {
    await modal.getByRole('tab', { name: tab, exact: true }).click()
    await expect(modal.getByRole('button', { name: '을지 다운로드', exact: true })).toBeDisabled()
    await expect(modal.getByRole('alert')).toContainText('등록된')
  }
  await expect(modal.locator('.sig-eulji-rule')).toContainText('업체명은 빈칸')
  await modal.getByRole('tab', { name: '메인 제품', exact: true }).click()
  await expect(modal.getByRole('button', { name: '을지 다운로드', exact: true })).toBeDisabled()
  await expect(modal.getByRole('alert')).toContainText('장당 원가')
})

test('저장한 작업·컬러별 단가를 반복 다운로드와 새로고침 뒤에도 N·T에 적용한다', async ({ page }) => {
  let modal = await fixture(page, false, true)
  const pricesBefore = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).processingUnitPrices, STORAGE)
  const download = async (tab: string, price: number, quantity: number) => {
    await modal.getByRole('tab', { name: tab, exact: true }).click()
    const pending = page.waitForEvent('download')
    await modal.getByRole('button', { name: '을지 다운로드', exact: true }).click()
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(await readFile((await (await pending).path())!))
    const sheet = workbook.getWorksheet('대금지급(을)')!
    expect(sheet.getCell('I3').value).toBe(`${CODE}BK`)
    expect(sheet.getCell('N3').value).toBe(price)
    expect(sheet.getCell('R3').value).toBe(quantity)
    expect(sheet.getCell('T3').result).toBe(price * quantity)
    expect(sheet.getCell('U3').result).toBe(price * quantity / 10)
  }
  await download('중화라벨', 2.5, 300)
  await download('비와이 자수', 10, 277)
  await download('품질검사', 100, 277)
  await modal.getByRole('button', { name: '닫기', exact: true }).first().click()
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '결제 · 마감', exact: true }).click()
  await page.getByLabel('스타일 검색', { exact: true }).fill(`${CODE}BK`)
  await page.getByRole('button', { name: '을지 양식 다운로드', exact: true }).click()
  modal = page.getByRole('dialog', { name: '마감 양식에 채워서 다운로드', exact: true })
  await download('중화라벨', 2.5, 300)
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).processingUnitPrices, STORAGE)).toEqual(pricesBefore)
})
