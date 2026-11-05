import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import type { Workspace } from '../src/lib/types'
import type { ProcessingPriceKind } from '../src/lib/processing-prices'

const STORAGE = 'sig-workspace-demo-v1', CODE = 'QA05FYJK0101'
const LABEL = '98850000-0000-4000-8000-000000000001', EMBROIDERY = '98850000-0000-4000-8000-000000000002'
const ABLE = '98850000-0000-4000-8000-000000000003', KOTITI = '98850000-0000-4000-8000-000000000004'
const WORK = { label: 'QA 포인트 라벨', embroidery: 'QA 로고 자수', quality: '아우터' }
const KIND = { label: '라벨', embroidery: '자수', quality: '품질 검사' }

async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page, assigned = true, paid = false) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, code, label, embroidery, able, kotiti, assigned, paid, work }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace, now = new Date().toISOString()
    const original = w.styles[1], style = structuredClone(original), stamp = { version: 1, createdAt: now, updatedAt: now, updatedBy: style.ownerId }
    style.id = crypto.randomUUID(); style.code = code; style.name = '작업 화면 직접 단가 검증'; style.stage = 'production'; style.samples = []; style.colors = ['BK', 'OW']; style.notes = ''
    style.production = ['BK', 'OW'].map((color, index) => {
      const line = structuredClone(original.production[0]); line.id = crypto.randomUUID(); line.color = color
      line.order = { XXS: 0, XS: 0, S: 0, M: 20 + index, L: 0, XL: 0 }
      line.shipped = { XXS: 0, XS: 0, S: 0, M: 18 + index, L: 0, XL: 0 }
      line.received = { XXS: 0, XS: 0, S: 0, M: 15 + index, L: 0, XL: 0 }
      line.receivedAt = '2026-11-05'; line.paymentStatus = paid && index === 0 ? 'done' : 'todo'; return line
    })
    const project = w.projects.find(item => item.id === style.projectId)!
    project.code = 'SIGNIFICANT-2026FY-RPQ-99881'; project.name = 'QA 인라인 단가 프로젝트'; project.season = '2026FY'; style.season = '2026FY'
    w.factories.push(
      { id: label, name: '중화라벨', country: '대한민국', active: true, serviceType: 'label', serviceSettingsVersion: 1 },
      { id: embroidery, name: '비와이자수', country: '대한민국', active: true, serviceType: 'embroidery', serviceSettingsVersion: 1 },
      { id: able, name: '에이블', country: '대한민국', active: true, serviceType: 'inspection', inspectionProvider: 'able', serviceSettingsVersion: 1 },
      { id: kotiti, name: 'KOTITI', country: '대한민국', active: true, serviceType: 'inspection', inspectionProvider: 'kotiti', serviceSettingsVersion: 1 },
    )
    w.styles = [style]; w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []
    w.productionRuns = []; w.productionReceipts = []; w.productionRunAudits = []; w.productionConditions = []; w.supplierProductionOrders = []; w.productionPoContexts = []
    w.settlementTerms = []; w.settlementTermsAvailable = true
    w.processingPricesAvailable = true; w.processingUnitPrices = []; w.supplierWorkRatesAvailable = true; w.supplierWorkRateAudits = []
    w.operations!.styleOperations = (['label', 'embroidery'] as const).map((kind, index) => {
      const vendor = kind === 'label' ? label : embroidery, catalogId = crypto.randomUUID()
      w.operations!.operationCatalogs.push({ ...stamp, id: catalogId, kind, name: work[kind], active: true, specification: 'QA 실제 작업 사양', supplierFactoryId: vendor })
      return { ...stamp, id: crypto.randomUUID(), styleId: style.id, kind, supplierFactoryId: vendor, supplierNameSnapshot: index === 0 ? '중화라벨' : '비와이자수', rows: [{ id: crypto.randomUUID(), catalogId, name: work[kind], specification: 'QA 실제 작업 사양', quantity: 20, lossQuantity: 2, completedQuantity: 10, status: 'progress', orderedAt: '2026-11-01', requestedAt: '2026-11-01', completedAt: '', dueDate: '2026-11-06', note: '' }], note: '', voided: false }
    })
    w.supplierWorkRates = w.operations!.styleOperations.map((item, index) => ({ ...stamp, factoryId: item.supplierFactoryId!, kind: item.kind, itemKey: item.rows[0].catalogId, unitCost: 100 + index }))
    w.operations!.poDispatches = []; w.operations!.poDispatchAttempts = []; w.operations!.orderSourceRecords = []; w.operations!.shipmentLedgers = []; w.operations!.shipmentBatches = []
    w.refinementsAvailable = true; w.inspectionAssignmentsAvailable = true
    w.inspectionAssignments = assigned ? style.production.map((line, index) => ({ styleId: style.id, lineId: line.id, provider: index === 0 ? 'able' : 'kotiti', version: 1, updatedAt: now, updatedBy: style.ownerId })) : []
    delete w.inspectionOrders
    w.productionDetails = style.production.map(line => ({ ...stamp, styleId: style.id, lineId: line.id, quality: { category: '아우터', quantity: 15, status: 'progress', requestedAt: '2026-11-01', completedAt: '', note: '' }, measurements: { upper: [], lower: [] } }))
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, code: CODE, label: LABEL, embroidery: EMBROIDERY, able: ABLE, kotiti: KOTITI, assigned, paid, work: WORK })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function open(page: Page, kind: ProcessingPriceKind) {
  await page.getByRole('button', { name: `${CODE}BK`, exact: true }).click()
  const detail = page.getByRole('dialog').filter({ has: page.getByRole('heading', { level: 1 }) })
  await detail.getByRole('tab', { name: /가공·품질 관리/ }).click()
  await detail.getByRole('tablist', { name: '스타일 추가 업무', exact: true }).getByRole('tab', { name: kind === 'label' ? /^라벨 관리/ : kind === 'embroidery' ? /^자수 관리/ : /^품질 검사/ }).click()
  return { detail, inline: detail.getByRole('region', { name: `${KIND[kind]} 작업 단가 입력`, exact: true }) }
}
function field(panel: Locator, kind: ProcessingPriceKind, color = 'BK') { return panel.getByLabel(`${KIND[kind]} ${WORK[kind]} ${CODE}${color} 단가 직접 입력`, { exact: true }) }
async function save(panel: Locator, kind: ProcessingPriceKind, value: string, color = 'BK') {
  await field(panel, kind, color).fill(value)
  await panel.getByLabel('직접 단가 변경 사유', { exact: true }).fill('QA 작업 화면에서 단가 명시 저장')
  await panel.getByRole('button', { name: '작업 단가 저장', exact: true }).click()
  await expect(panel.getByRole('button', { name: '작업 단가 저장', exact: true })).not.toBeVisible()
  await expect(field(panel, kind, color)).toBeEnabled()
}
function quote(w: Workspace, kind: ProcessingPriceKind, color = 'BK') {
  const style = w.styles[0], line = style.production.find(item => item.color === color)!
  const key = kind === 'quality' ? '아우터' : w.operations!.styleOperations.find(item => item.styleId === style.id && item.kind === kind)!.rows[0].id
  return w.processingUnitPrices!.find(item => item.styleId === style.id && item.lineId === line.id && item.kind === kind && item.itemKey === key)
}

for (const [kind, mobile, price] of [['label', false, '123.45'], ['embroidery', true, '250.5']] as const) test(`${KIND[kind]} 작업 행에서 ${kind === 'label' ? '중화라벨' : '비와이자수'} 단가를 직접 입력하고 재접속·을지에 유지한다 · ${mobile ? '모바일' : 'PC'}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  const before = await snapshot(page)
  let { detail, inline } = await open(page, kind)
  await expect(inline).toContainText(kind === 'label' ? '중화라벨' : '비와이자수')
  await expect(field(inline, kind)).toBeVisible(); await expect(field(inline, kind)).toBeEnabled()
  await save(inline, kind, price)
  let after = await snapshot(page)
  expect(quote(after, kind)?.unitCost).toBe(Number(price)); expect(quote(after, kind, 'OW')).toBeUndefined()
  expect(after.styles).toEqual(before.styles); expect(after.operations!.styleOperations).toEqual(before.operations!.styleOperations)
  expect(after.supplierWorkRates).toEqual(before.supplierWorkRates)
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click(); await page.reload()
  ;({ detail, inline } = await open(page, kind))
  await expect(field(inline, kind)).toHaveValue(price)
  await detail.getByRole('button', { name: '을지 다운로드', exact: true }).click()
  const exporter = page.getByRole('dialog', { name: '마감 양식에 채워서 다운로드', exact: true })
  await exporter.getByRole('tab', { name: KIND[kind], exact: true }).click()
  const pending = page.waitForEvent('download')
  await exporter.getByRole('button', { name: '을지 다운로드', exact: true }).click()
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await readFile((await (await pending).path())!))
  const sheet = workbook.getWorksheet('대금지급(을)')!
  expect(sheet.getCell('N3').value).toBe(Number(price)); expect(sheet.getCell('I3').value).toBe(`${CODE}BK`)
  expect(sheet.getCell('D3').value).toBe(kind === 'label' ? '중화라벨' : '비와이자수')
  const quantity = kind === 'label' ? 18 : 15
  expect(sheet.getCell('R3').value).toBe(quantity); expect(sheet.getCell('T3').result).toBe(Number(price) * quantity)
  await exporter.getByRole('button', { name: '닫기', exact: true }).first().click()
  await save(inline, kind, '0'); expect(quote(await snapshot(page), kind)?.unitCost).toBe(0)
  await save(inline, kind, ''); after = await snapshot(page); expect(quote(after, kind)?.unitCost).toBeNull()
  expect(after.supplierWorkRates).toEqual(before.supplierWorkRates)
  if (mobile) await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('품질 검사 안에서 에이블과 KOTITI의 배정 컬러 단가를 각각 입력하고 서로 덮어쓰지 않는다', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page), { detail, inline } = await open(page, 'quality')
  await expect(inline).toContainText('에이블'); await expect(field(inline, 'quality')).toBeEnabled()
  await save(inline, 'quality', '1000.25')
  const ow = before.styles[0].production.find(item => item.color === 'OW')!
  await detail.getByLabel('품질 검사 컬러', { exact: true }).selectOption(ow.id)
  await expect(inline).toContainText('KOTITI'); await expect(field(inline, 'quality', 'OW')).toBeEnabled()
  await save(inline, 'quality', '2000.5', 'OW')
  const after = await snapshot(page)
  expect(quote(after, 'quality')).toMatchObject({ supplierFactoryId: ABLE, unitCost: 1000.25 })
  expect(quote(after, 'quality', 'OW')).toMatchObject({ supplierFactoryId: KOTITI, unitCost: 2000.5 })
  expect(after.styles).toEqual(before.styles); expect(after.productionDetails).toEqual(before.productionDetails)
  expect(after.inspectionAssignments).toEqual(before.inspectionAssignments); expect(after.supplierWorkRates).toEqual(before.supplierWorkRates)
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await expect(detail).not.toBeVisible()
  await page.getByRole('button', { name: '을지 양식 다운로드', exact: true }).click()
  const exporter = page.getByRole('dialog', { name: '마감 양식에 채워서 다운로드', exact: true })
  await exporter.getByRole('tab', { name: '품질검사', exact: true }).click()
  const pending = page.waitForEvent('download')
  await exporter.getByRole('button', { name: '을지 다운로드', exact: true }).click()
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await readFile((await (await pending).path())!))
  const sheet = workbook.getWorksheet('대금지급(을)')!
  expect(sheet.getCell('D3').value).toBe('에이블'); expect(sheet.getCell('N3').value).toBe(1000.25)
  expect(sheet.getCell('R3').value).toBe(15); expect(sheet.getCell('T3').result).toBe(15003.75)
  expect(sheet.getCell('D4').value).toBe('KOTITI'); expect(sheet.getCell('N4').value).toBe(2000.5)
  expect(sheet.getCell('R4').value).toBe(16); expect(sheet.getCell('T4').result).toBe(32008)
})

test('미지정 검사 오더와 미저장 가공 작업에도 단가 칸은 표시하고 입력할 수 없는 이유를 안내한다', async ({ page }) => {
  await fixture(page, false)
  const before = await snapshot(page)
  let { detail, inline } = await open(page, 'quality')
  await expect(field(inline, 'quality')).toBeVisible(); await expect(field(inline, 'quality')).toBeDisabled()
  await expect(inline).toContainText(/업체.*지정|지정.*업체/)
  await detail.getByRole('tablist', { name: '스타일 추가 업무', exact: true }).getByRole('tab', { name: /^라벨 관리/ }).click()
  await detail.getByRole('button', { name: '라벨 관리 수정', exact: true }).click()
  inline = detail.getByRole('region', { name: '라벨 작업 단가 입력', exact: true })
  await expect(field(inline, 'label')).toBeDisabled(); await expect(inline).toContainText(/작업.*저장|저장.*작업/)
  await detail.getByRole('button', { name: '라벨 종류 추가', exact: true }).click()
  const added = detail.getByRole('tabpanel', { name: /^라벨 관리/ }).locator('.ops-processing-row').last().getByRole('region', { name: '라벨 작업 단가 입력', exact: true })
  await expect(added.getByRole('spinbutton')).toHaveCount(2)
  for (const input of await added.getByRole('spinbutton').all()) await expect(input).toBeDisabled()
  expect((await snapshot(page)).processingUnitPrices).toEqual(before.processingUnitPrices)
})

test('직접 단가 편집 중 다른 창의 저장은 입력값을 보존하고 저장과 상세 닫기를 보호한다', async ({ page }) => {
  await fixture(page)
  const { detail, inline } = await open(page, 'label')
  await field(inline, 'label').fill('777.25')
  await inline.getByLabel('직접 단가 변경 사유', { exact: true }).fill('다른 창 저장 후에도 유지할 입력')
  await page.evaluate(({ key, vendor }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace, style = w.styles[0], work = w.operations!.styleOperations.find(item => item.kind === 'label')!, now = new Date().toISOString()
    w.processingUnitPrices!.push({ styleId: style.id, lineId: style.production[0].id, kind: 'label', itemKey: work.rows[0].id, unitCost: 321, supplierFactoryId: vendor, supplierNameSnapshot: '중화라벨', supplierCatalogId: work.rows[0].catalogId, masterRateVersion: null, version: 1, createdAt: now, updatedAt: now, updatedBy: style.ownerId })
    localStorage.setItem(key, JSON.stringify(w)); window.dispatchEvent(new Event('sig-workspace-change'))
  }, { key: STORAGE, vendor: LABEL })
  await expect(inline).toContainText(/다른 사용자|변경.*확인|최신/)
  await expect(field(inline, 'label')).toHaveValue('777.25')
  await expect(inline.getByRole('button', { name: '작업 단가 저장', exact: true })).toBeDisabled()
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await expect(detail.getByRole('alertdialog')).toContainText('저장하지 않은 변경')
  await detail.getByRole('alertdialog').getByRole('button', { name: '편집 계속', exact: true }).click()
  await expect(field(inline, 'label')).toHaveValue('777.25')
  expect(quote(await snapshot(page), 'label')?.unitCost).toBe(321)
})

test('결제 마감된 컬러의 업체 단가는 읽기 전용이며 다른 미마감 컬러만 편집한다', async ({ page }) => {
  await fixture(page, true, true)
  const before = await snapshot(page), { inline } = await open(page, 'label')
  await expect(field(inline, 'label')).toBeVisible(); await expect(field(inline, 'label')).toBeDisabled()
  await expect(field(inline, 'label', 'OW')).toBeEnabled()
  await expect(inline).toContainText(/마감|결제/)
  await save(inline, 'label', '88', 'OW')
  const after = await snapshot(page)
  expect(quote(after, 'label')).toBeUndefined(); expect(quote(after, 'label', 'OW')?.unitCost).toBe(88)
  expect(after.styles).toEqual(before.styles)
})

for (const change of ['provider', 'category'] as const) test(`검사 직접 단가 편집 중 다른 창의 ${change === 'provider' ? '업체 재배정' : '품목 변경'}은 입력을 보존하고 오래된 저장을 막는다`, async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page), { detail, inline } = await open(page, 'quality')
  await field(inline, 'quality').fill('777.25')
  await inline.getByLabel('직접 단가 변경 사유', { exact: true }).fill('검사 배정 변경 후에도 유지할 입력')
  await page.evaluate(({ key, change }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace, lineId = w.styles[0].production[0].id
    if (change === 'provider') {
      const assignment = w.inspectionAssignments!.find(item => item.lineId === lineId)!
      assignment.provider = 'kotiti'; assignment.version += 1
    } else {
      const detail = w.productionDetails!.find(item => item.lineId === lineId)!
      detail.quality.category = '바지'; detail.version += 1
    }
    localStorage.setItem(key, JSON.stringify(w)); window.dispatchEvent(new Event('sig-workspace-change'))
  }, { key: STORAGE, change })
  await expect(inline.getByRole('status')).toContainText(/다른 사용자|변경.*확인|최신/)
  await expect(inline.getByRole('spinbutton')).toHaveValue('777.25')
  await expect(inline.getByLabel('직접 단가 변경 사유', { exact: true })).toHaveValue('검사 배정 변경 후에도 유지할 입력')
  await expect(inline.getByRole('button', { name: '작업 단가 저장', exact: true })).toBeDisabled()
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await expect(detail.getByRole('alertdialog')).toContainText('저장하지 않은 변경')
  await detail.getByRole('alertdialog').getByRole('button', { name: '편집 계속', exact: true }).click()
  await expect(inline.getByRole('spinbutton')).toHaveValue('777.25')
  const after = await snapshot(page)
  expect(after.processingUnitPrices).toEqual(before.processingUnitPrices)
  expect(after.supplierWorkRates).toEqual(before.supplierWorkRates)
})
