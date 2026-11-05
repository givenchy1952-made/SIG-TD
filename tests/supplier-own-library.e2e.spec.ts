import { expect, test, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'
import type { StyleOperationKind } from '../src/lib/operations-types'

const STORAGE = 'sig-workspace-demo-v1', OWN_VENDOR = '98770000-0000-4000-8000-000000000001', OTHER_VENDOR = '98770000-0000-4000-8000-000000000002', ACTOR = '98770000-0000-4000-8000-000000000003'
const PRIVATE_WORK = 'QA 타 업체 비공개 작업', WORK = 'QA 내 업체 공통 작업'
async function fixture(page: Page, kind: StyleOperationKind) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, own, other, actor, kind, privateWork }) => {
    const workspace = JSON.parse(localStorage.getItem(key)!) as Workspace
    workspace.factories.push({ id: own, name: 'QA 내 업체', country: '대한민국', active: true, serviceType: kind, serviceSettingsVersion: 1 }, { id: other, name: 'QA 다른 업체', country: '대한민국', active: true, serviceType: kind, serviceSettingsVersion: 1 })
    workspace.profiles.push({ id: actor, name: 'QA 내 업체 담당자', email: 'qa-own-vendor@example.test', role: 'factory', approved: true, active: true, factoryId: own })
    workspace.supplierWorkRatesAvailable = true; workspace.supplierWorkRates = []; workspace.supplierWorkRateAudits = []
    workspace.operations!.operationCatalogs.push({ id: crypto.randomUUID(), supplierFactoryId: other, kind, name: privateWork, specification: '외부 공개 금지', active: true, version: 1, createdAt: '2026-11-04', updatedAt: '2026-11-04', updatedBy: actor })
    localStorage.setItem(key, JSON.stringify(workspace)); localStorage.setItem('sig-demo-profile', actor)
  }, { key: STORAGE, own: OWN_VENDOR, other: OTHER_VENDOR, actor: ACTOR, kind, privateWork: PRIVATE_WORK })
  await page.reload()
  await expect(page.getByRole('region', { name: '내 업체 공통 작업·단가', exact: true })).toBeVisible()
}

for (const [kind, mobile] of [['label', false], ['embroidery', false], ['label', true]] as const) test(`생산 스타일 없는 ${kind === 'label' ? '라벨' : '자수'} 업체가 자기 작업명·단가를 직접 등록하고 수정한다 · ${mobile ? '모바일' : 'PC'}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page, kind)
  const region = page.getByRole('region', { name: '내 업체 공통 작업·단가', exact: true })
  const before = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!) as Workspace, STORAGE)
  const label = kind === 'label' ? '라벨 종류' : '자수 작업'
  await expect(page.getByText(PRIVATE_WORK, { exact: true })).toHaveCount(0)
  await region.getByRole('button', { name: `${label} 공통 등록`, exact: true }).click()
  await expect(page.getByLabel('체험 역할', { exact: true })).toBeDisabled()
  await region.getByLabel('업체 공통 작업명', { exact: true }).fill(WORK)
  await region.getByLabel('업체 공통 작업 사양', { exact: true }).fill('내 업체 기본 사양')
  await region.getByLabel('업체 공통 기본 단가', { exact: true }).fill('125.5')
  await region.getByLabel('업체 공통 작업 변경 사유', { exact: true }).fill('QA 내 업체 공통 항목 등록')
  await region.getByRole('button', { name: '업체 공통 작업·단가 저장', exact: true }).click()
  await expect(region.getByRole('button', { name: `${WORK} 공통 작업·단가 수정`, exact: true })).toBeVisible()
  await expect(page.getByLabel('체험 역할', { exact: true })).toBeEnabled()
  await page.reload()
  const reloaded = page.getByRole('region', { name: '내 업체 공통 작업·단가', exact: true })
  await reloaded.getByRole('button', { name: `${WORK} 공통 작업·단가 수정`, exact: true }).click()
  await expect(reloaded.getByLabel('업체 공통 기본 단가', { exact: true })).toHaveValue('125.5')
  await reloaded.getByLabel('업체 공통 기본 단가', { exact: true }).fill('200')
  await reloaded.getByLabel('업체 공통 작업 변경 사유', { exact: true }).fill('QA 단가 인상')
  await reloaded.getByRole('button', { name: '업체 공통 작업·단가 저장', exact: true }).click()
  await expect(reloaded.getByRole('button', { name: `${WORK} 공통 작업·단가 수정`, exact: true })).toBeVisible()
  const after = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!) as Workspace, STORAGE)
  expect(after.supplierWorkRates!.find(rate => rate.factoryId === OWN_VENDOR && rate.kind === kind)).toMatchObject({ unitCost: 200, version: 2 })
  expect(after.supplierWorkRates!.filter(rate => rate.factoryId === OTHER_VENDOR)).toEqual([])
  expect(after.styles).toEqual(before.styles)
  expect(after.operations!.operationCatalogs.find(item => item.supplierFactoryId === OTHER_VENDOR)).toEqual(before.operations!.operationCatalogs.find(item => item.supplierFactoryId === OTHER_VENDOR))
  await expect(page.getByText(PRIVATE_WORK, { exact: true })).toHaveCount(0)
  if (mobile) await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})
