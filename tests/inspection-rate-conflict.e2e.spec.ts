import { expect, test, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1', ADMIN = '10000000-0000-4000-8000-000000000001'
const ABLE = '98750000-0000-4000-8000-000000000001', KOTITI = '98750000-0000-4000-8000-000000000002'
const CODE = 'QARATECONFLICT'
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, admin, able, kotiti, code }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace, now = new Date().toISOString()
    const style = structuredClone(w.styles[1]), line = structuredClone(style.production[0])
    style.id = crypto.randomUUID(); style.code = code; style.name = '검사 기준 단가 편집 충돌 검증'; style.stage = 'production'; style.samples = []; style.colors = ['BK']
    line.id = crypto.randomUUID(); line.color = 'BK'; line.order = { XXS: 1, XS: 2, S: 3, M: 4, L: 5, XL: 6 }; style.production = [line]
    w.styles = [style]; w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []
    w.factories.push({ id: able, name: 'QA 에이블 충돌 검증', country: '대한민국', active: true, serviceType: 'inspection', inspectionProvider: 'able', serviceSettingsVersion: 1 }, { id: kotiti, name: 'QA KOTITI 충돌 검증', country: '대한민국', active: true, serviceType: 'inspection', inspectionProvider: 'kotiti', serviceSettingsVersion: 1 })
    w.productionRuns = []; w.productionReceipts = []; w.productionRunAudits = []; w.productionConditions = []; w.supplierProductionOrders = []; w.productionPoContexts = []
    w.processingUnitPrices = []; w.processingPricesAvailable = true; w.supplierWorkRatesAvailable = true; w.supplierWorkRateAudits = []
    w.supplierWorkRates = [[able, '아우터', 100], [kotiti, '아우터', 200], [able, '바지', 300]].map(([factoryId, itemKey, unitCost]) => ({ factoryId: String(factoryId), kind: 'quality' as const, itemKey: String(itemKey), unitCost: Number(unitCost), version: 1, createdAt: now, updatedAt: now, updatedBy: admin }))
    w.refinementsAvailable = true; w.inspectionAssignmentsAvailable = true
    w.inspectionAssignments = [{ styleId: style.id, lineId: line.id, provider: 'able', version: 1, updatedAt: now, updatedBy: admin }]
    delete w.inspectionOrders
    w.productionDetails = [{ styleId: style.id, lineId: line.id, quality: { category: '아우터', quantity: 21, status: 'todo', requestedAt: '2026-11-04', completedAt: '', note: '' }, measurements: { upper: [], lower: [] }, version: 1, createdAt: now, updatedAt: now, updatedBy: admin }]
    if (w.operations) { w.operations.styleOperations = []; w.operations.poDispatches = []; w.operations.poDispatchAttempts = []; w.operations.orderSourceRecords = []; w.operations.shipmentLedgers = []; w.operations.shipmentBatches = [] }
    localStorage.setItem(key, JSON.stringify(w)); localStorage.setItem('sig-demo-profile', admin)
  }, { key: STORAGE, admin: ADMIN, able: ABLE, kotiti: KOTITI, code: CODE })
  await page.reload()
  await page.getByRole('button', { name: `${CODE}BK`, exact: true }).click()
  const detail = page.getByRole('dialog').filter({ has: page.getByRole('heading', { level: 1 }) })
  await detail.getByRole('tab', { name: /가공·품질 관리/ }).click()
  await detail.getByRole('tablist', { name: '스타일 추가 업무', exact: true }).getByRole('tab', { name: /^품질 검사/ }).click()
  return detail.getByRole('region', { name: '품질 검사 업체 지정', exact: true })
}

for (const change of ['provider', 'category'] as const) test(`본사 검사 단가 편집 중 다른 사용자의 ${change === 'provider' ? '업체 재배정' : '품목 변경'}은 입력값을 보존하고 취소까지 저장을 막는다`, async ({ page }) => {
  const panel = await fixture(page), rates = panel.getByRole('region', { name: '아우터 검사 기준 단가', exact: true })
  await panel.getByLabel('검사 오더 단가 적용 사유', { exact: true }).fill('QA 검사 오더 기준 적용 사유')
  await rates.getByRole('button', { name: '검사 기준 단가 수정', exact: true }).click()
  await rates.getByLabel('검사 기준 단가', { exact: true }).fill('777.25')
  await rates.getByLabel('검사 기준 단가 변경 사유', { exact: true }).fill('저장 전 보존해야 하는 본사 입력값')
  const before = await snapshot(page)
  await page.evaluate(({ key, change }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    if (change === 'provider') { w.inspectionAssignments![0].provider = 'kotiti'; w.inspectionAssignments![0].version += 1 }
    else { w.productionDetails![0].quality.category = '바지'; w.productionDetails![0].version += 1 }
    localStorage.setItem(key, JSON.stringify(w)); window.dispatchEvent(new Event('sig-workspace-change'))
  }, { key: STORAGE, change })
  await expect(rates.getByRole('status')).toContainText('검사 업체 또는 품목이 변경되었습니다.')
  await expect(rates.getByLabel('검사 기준 단가', { exact: true })).toHaveValue('777.25')
  await expect(rates.getByLabel('검사 기준 단가 변경 사유', { exact: true })).toHaveValue('저장 전 보존해야 하는 본사 입력값')
  await expect(rates.getByRole('button', { name: '검사 기준 단가 저장', exact: true })).toBeDisabled()
  await expect(panel.getByRole('button', { name: '이 오더에 기준 단가 적용', exact: true })).toBeDisabled()
  const conflicted = await snapshot(page)
  expect(conflicted.supplierWorkRates).toEqual(before.supplierWorkRates)
  expect(conflicted.processingUnitPrices).toEqual(before.processingUnitPrices)
  expect(conflicted.supplierWorkRateAudits).toEqual(before.supplierWorkRateAudits)

  await rates.getByRole('button', { name: '검사 단가 편집 취소', exact: true }).click()
  const currentCategory = change === 'category' ? '바지' : '아우터'
  const current = panel.getByRole('region', { name: `${currentCategory} 검사 기준 단가`, exact: true })
  await expect(current.getByRole('button', { name: '검사 기준 단가 수정', exact: true })).toBeVisible()
  await expect(current).toContainText(change === 'provider' ? 'QA KOTITI 충돌 검증' : 'QA 에이블 충돌 검증')
  await current.getByRole('button', { name: '검사 기준 단가 수정', exact: true }).click()
  await expect(current.getByLabel('검사 기준 단가', { exact: true })).toHaveValue(change === 'provider' ? '200' : '300')
  await current.getByLabel('검사 기준 단가', { exact: true }).fill('555')
  await current.getByLabel('검사 기준 단가 변경 사유', { exact: true }).fill('QA 현재 업체와 품목 확인 후 저장')
  await current.getByRole('button', { name: '검사 기준 단가 저장', exact: true }).click()
  await expect(current.getByRole('button', { name: '검사 기준 단가 수정', exact: true })).toBeVisible()
  const after = await snapshot(page)
  expect(after.supplierWorkRates!.find(rate => rate.factoryId === ABLE && rate.itemKey === '아우터')!.unitCost).toBe(100)
  expect(after.supplierWorkRates!.find(rate => rate.factoryId === (change === 'provider' ? KOTITI : ABLE) && rate.itemKey === currentCategory)!.unitCost).toBe(555)
  expect(after.processingUnitPrices).toEqual(before.processingUnitPrices)
})
