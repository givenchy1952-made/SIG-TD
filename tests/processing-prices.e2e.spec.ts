import { test, expect, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1', CODE = 'BO42FYHD0102'
const FACTORY = '10000000-0000-4000-8000-000000000004'
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, code }) => {
    const w = JSON.parse(localStorage.getItem(key)!), style = w.styles.find((item: { code: string }) => item.code === code)
    style.production = style.production.slice(0, 2); style.colors = style.production.map((item: { color: string }) => item.color)
    const sizes = ['XXS', 'XS', 'S', 'M', 'L', 'XL']
    style.production.forEach((line: { order: Record<string, number>; received: Record<string, number>; shipped: Record<string, number>; receivedAt: string }, index: number) => {
      sizes.forEach(size => { line.order[size] = 0; line.shipped[size] = 0; line.received[size] = 0 })
      line.order.M = 30 + index; line.shipped.M = 24 + index; line.received.M = 20 + index; line.receivedAt = '2026-10-28'
    })
    const other = structuredClone(style); other.id = crypto.randomUUID(); other.code = 'QAOTHERFACTORY01'; other.factoryId = w.factories.find((item: { country: string }) => item.country === '대한민국').id
    other.production = other.production.map((item: object) => ({ ...item, id: crypto.randomUUID() }))
    w.styles = [style, other]; w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []
    w.processingUnitPrices = []; w.processingPricesAvailable = true; w.operationsAvailable = true; w.refinementsAvailable = true
    w.productionRuns = []; w.supplierProductionOrders = []
    const stamp = { version: 1, createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z', updatedBy: style.ownerId }
    const row = (kind: string) => {
      const catalog = w.operations.operationCatalogs.find((item: { kind: string; active: boolean }) => item.kind === kind && item.active)
      return { id: crypto.randomUUID(), catalogId: catalog.id, name: catalog.name, specification: 'QA 단가 검증', quantity: 99, lossQuantity: 3, completedQuantity: 7, status: 'progress', orderedAt: '2026-10-01', requestedAt: '2026-10-02', completedAt: '2026-10-03', dueDate: '2026-10-04', note: '원본 작업 보존' }
    }
    w.operations.styleOperations = ['label', 'embroidery'].map(kind => ({ ...stamp, id: crypto.randomUUID(), styleId: style.id, kind, rows: [row(kind)], note: '원본 공통 메모', voided: false }))
    w.operations.shipmentLedgers = []; w.operations.shipmentBatches = []
    w.productionDetails = style.production.map((line: { id: string }) => ({ ...stamp, styleId: style.id, lineId: line.id, quality: { category: '아우터', quantity: 8, status: 'done', requestedAt: '2026-10-01', completedAt: '2026-10-03', note: '검사 메모' }, measurements: { upper: [], lower: [] } }))
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, code: CODE })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function open(page: Page) {
  await page.getByRole('button', { name: `${CODE}BK`, exact: true }).click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /가공·품질 관리/ }).click()
  const panel = detail.getByRole('region', { name: '가공·품질 단가 관리', exact: true })
  await expect(panel).toBeVisible()
  return { detail, panel }
}
function firstRow(panel: Locator, color = 'BK') { return panel.locator('.processing-price-table tbody tr').filter({ hasText: `${CODE}${color}` }).first() }
async function changePrice(panel: Locator, value: string, color = 'BK') {
  const row = firstRow(panel, color)
  await row.getByRole('button', { name: /단가 수정$/ }).click()
  await row.getByRole('spinbutton').fill(value)
  await panel.getByLabel('가공·품질 단가 변경 사유', { exact: true }).fill('QA 업체 단가 저장 검증')
  await panel.getByRole('button', { name: '단가 저장', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('단가를 저장했습니다.')
}

test('컬러·작업별 단가는 새로고침 후에도 유지하고 명시적으로 수정한 행만 변경한다', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page)
  let { detail, panel } = await open(page)
  await expect(firstRow(panel).locator('td').nth(3)).toHaveText('미입력')
  await changePrice(panel, '123.45')
  let after = await snapshot(page)
  expect(after.processingUnitPrices).toHaveLength(1)
  expect(after.processingUnitPrices![0]).toMatchObject({ styleId: before.styles[0].id, lineId: before.styles[0].production[0].id, kind: 'label', unitCost: 123.45, version: 1 })
  expect(after.styles).toEqual(before.styles)
  expect(after.operations!.styleOperations).toEqual(before.operations!.styleOperations)
  expect(after.productionDetails).toEqual(before.productionDetails)
  await expect(firstRow(panel, 'OW').locator('td').nth(3)).toHaveText('미입력')
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await page.reload()
  ;({ detail, panel } = await open(page))
  await expect(firstRow(panel).locator('td').nth(3)).toHaveText('123.45')
  await panel.getByLabel('단가 작업 구분', { exact: true }).selectOption('embroidery')
  await changePrice(panel, '200')
  await panel.getByLabel('단가 작업 구분', { exact: true }).selectOption('quality')
  await changePrice(panel, '50.5')
  after = await snapshot(page)
  expect(after.processingUnitPrices!.map(item => [item.kind, item.unitCost])).toEqual(expect.arrayContaining([['label', 123.45], ['embroidery', 200], ['quality', 50.5]]))
  expect(after.processingUnitPrices).toHaveLength(3)
  expect(after.styles).toEqual(before.styles)
  await detail.getByRole('button', { name: '을지 다운로드', exact: true }).click()
  const exporter = page.getByRole('dialog', { name: '마감 양식에 채워서 다운로드', exact: true })
  await exporter.getByRole('tab', { name: '중화라벨', exact: true }).click()
  const pending = page.waitForEvent('download')
  await exporter.getByRole('button', { name: '을지 다운로드', exact: true }).click()
  const download = await pending, workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await readFile((await download.path())!))
  const sheet = workbook.getWorksheet('대금지급(을)')!
  expect(sheet.getCell('I3').value).toBe(`${CODE}BK`)
  expect(sheet.getCell('N3').value).toBe(123.45)
  expect(sheet.getCell('R3').value).toBe(24)
  expect(sheet.getCell('T3').result).toBe(2962.8)
  expect(sheet.getCell('C3').value).toBeInstanceOf(Date)
  expect((sheet.getCell('C3').value as Date).toISOString().slice(0, 10)).toBe('2026-10-28')
  // The detail export is scoped to the selected BK color; OW stays outside it.
  expect(sheet.getCell('I4').value).toBeNull()
  expect(sheet.getCell('N4').value).toBeNull()
  expect((await snapshot(page)).processingUnitPrices).toEqual(after.processingUnitPrices)
})

test('배정 공장은 단가를 입력할 수 있고 본사 작업·생산 원본과 다른 공장 자료를 변경하지 않는다', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page)
  await page.getByLabel('체험 역할', { exact: true }).selectOption(FACTORY)
  await expect(page.getByRole('button', { name: /QAOTHERFACTORY01/ })).toHaveCount(0)
  const { detail, panel } = await open(page)
  await changePrice(panel, '300.75')
  const after = await snapshot(page)
  expect(after.processingUnitPrices).toHaveLength(1)
  expect(after.processingUnitPrices![0]).toMatchObject({ unitCost: 300.75, updatedBy: FACTORY })
  expect(after.styles).toEqual(before.styles)
  expect(after.operations!.styleOperations).toEqual(before.operations!.styleOperations)
  expect(after.productionDetails).toEqual(before.productionDetails)
  await expect(detail.getByRole('button', { name: /라벨 관리 수정/ })).toHaveCount(0)
})

test('소수 셋째 자리 단가를 거절하고 0원과 공란 저장을 구분한다', async ({ page }) => {
  await fixture(page)
  const { panel } = await open(page), row = firstRow(panel)
  await row.getByRole('button', { name: /단가 수정$/ }).click()
  await row.getByRole('spinbutton').fill('10.123')
  await panel.getByLabel('가공·품질 단가 변경 사유', { exact: true }).fill('QA 잘못된 단가 거절 검증')
  await panel.getByRole('button', { name: '단가 저장', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('소수 둘째 자리')
  expect((await snapshot(page)).processingUnitPrices).toEqual([])
  await row.getByRole('spinbutton').fill('0')
  await panel.getByRole('button', { name: '단가 저장', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('단가를 저장했습니다.')
  expect((await snapshot(page)).processingUnitPrices![0].unitCost).toBe(0)
  await changePrice(panel, '')
  expect((await snapshot(page)).processingUnitPrices![0].unitCost).toBeNull()
  await expect(firstRow(panel).locator('td').nth(3)).toHaveText('미입력')
})

test('오래된 단가가 들어오면 작성값을 보존하고 저장을 막는다', async ({ page }) => {
  await fixture(page)
  const { panel } = await open(page), row = firstRow(panel)
  await row.getByRole('button', { name: /단가 수정$/ }).click()
  await row.getByRole('spinbutton').fill('999')
  await panel.getByLabel('가공·품질 단가 변경 사유', { exact: true }).fill('QA 동시 수정 검증')
  await page.evaluate(({ key, code }) => {
    const w = JSON.parse(localStorage.getItem(key)!), style = w.styles.find((item: { code: string }) => item.code === code)
    const work = w.operations.styleOperations.find((item: { styleId: string; kind: string }) => item.styleId === style.id && item.kind === 'label')
    w.processingUnitPrices.push({ styleId: style.id, lineId: style.production[0].id, kind: 'label', itemKey: work.rows[0].id, unitCost: 321, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), updatedBy: w.profiles[0].id })
    localStorage.setItem(key, JSON.stringify(w)); window.dispatchEvent(new Event('sig-workspace-change'))
  }, { key: STORAGE, code: CODE })
  await expect(panel.getByRole('status')).toContainText('다른 사용자가')
  await expect(row.getByRole('spinbutton')).toHaveValue('999')
  await expect(panel.getByRole('button', { name: '단가 저장', exact: true })).toBeDisabled()
  expect((await snapshot(page)).processingUnitPrices![0].unitCost).toBe(321)
})
