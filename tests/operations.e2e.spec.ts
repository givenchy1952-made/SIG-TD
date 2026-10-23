import { test, expect, type Page, type Locator } from '@playwright/test'
import ExcelJS from 'exceljs'
import { readFile } from 'node:fs/promises'
import type { Workspace, Quantities } from '../src/lib/types'
import type { OperationsWorkspace } from '../src/lib/operations-types'

const STORAGE = 'sig-workspace-demo-v1'
const ADMIN = '10000000-0000-4000-8000-000000000001'
const INTERNAL = '10000000-0000-4000-8000-000000000002'
const FACTORY = '10000000-0000-4000-8000-000000000004'
const CHINA = '20000000-0000-4000-8000-000000000002'
const CODE = 'BO42FYJK0101'
const SHIPPING_CODE = 'BO42FYHD0102'
const SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL'] as const
const headers = ['품번', '색상', ...SIZES, '합계']
type Snapshot = Workspace & { operations: OperationsWorkspace }

async function ready(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await expect(page.getByLabel('체험 역할')).toHaveValue(ADMIN)
}
async function stored(page: Page): Promise<Snapshot> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: '메뉴 열기', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name, exact: true }).click()
}
async function openStyle(page: Page, code = CODE) {
  await page.getByLabel('스타일 검색', { exact: true }).fill(code)
  await page.locator('.style-code').filter({ hasText: code }).first().click()
  const detail = page.getByRole('dialog')
  await expect(detail.getByRole('heading', { level: 1 })).toContainText(code)
  return detail
}
async function operationTab(detail: Locator, name: string) {
  await detail.getByRole('tab', { name: /발주·출고·가공/ }).click()
  await detail.getByRole('tablist', { name: '스타일 추가 업무', exact: true }).getByRole('tab', { name: new RegExp(`^${name}`) }).click()
}
function amounts(values: number[]): Quantities { return Object.fromEntries(SIZES.map((size, index) => [size, values[index]])) as Quantities }
function sum(q: Quantities) { return SIZES.reduce((total, size) => total + q[size], 0) }
async function dateToday(page: Page) { return page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }) }
async function workbookBytes(rows: (string | number)[][], names = headers): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('QA 오더')
  sheet.addRow(names); rows.forEach(row => sheet.addRow(row))
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
async function openImport(page: Page) {
  await navigate(page, '메인 생산')
  await page.getByRole('button', { name: '오더 엑셀 업로드', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Excel 오더 수량 가져오기', exact: true })
  await expect(modal).toBeVisible()
  return modal
}
async function importFile(modal: Locator, bytes: Buffer, name = 'qa-order.xlsx') {
  await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes })
  await expect(modal.getByRole('heading', { name: '적용 전 미리보기', exact: true })).toBeVisible()
}

test('PO 납기는 필수이며 체험 모드의 메일 발송은 실제 발송으로 기록되지 않는다', async ({ page }) => {
  await ready(page)
  const sendRequests: string[] = []
  await page.route('**/functions/v1/send-po-email', route => { sendRequests.push(route.request().url()); return route.abort() })
  const detail = await openStyle(page, SHIPPING_CODE)
  await operationTab(detail, 'PO 발송 이력')
  await detail.getByRole('button', { name: 'PO 작성', exact: true }).click()
  await detail.getByLabel('PO 납기일', { exact: true }).fill('')
  await detail.getByLabel('PO 수신 이메일', { exact: true }).fill('qa-supplier@example.test')
  await detail.getByLabel('PO 메일 제목', { exact: true }).fill('QA PO 직접 발송 검증')
  await detail.getByLabel('PO 메일 내용', { exact: true }).fill('QA 테스트 초안입니다. 실제 수신자에게 발송하면 안 됩니다.')
  await detail.getByLabel('PO 변경 사유', { exact: true }).fill('QA 납기 필수와 실제 발송 상태 검증')
  await detail.getByRole('button', { name: 'PO 초안 저장', exact: true }).click()
  await expect(detail.getByRole('alert')).toContainText('납기일')
  expect((await stored(page)).operations.poDispatches).toHaveLength(0)
  await detail.getByLabel('PO 납기일', { exact: true }).fill('2026-12-20')
  await detail.getByRole('button', { name: 'PO 초안 저장', exact: true }).click()
  await expect(detail.locator('.ops-po-card')).toContainText('초안 · 미발송')
  await detail.getByRole('button', { name: 'PO 메일 발송', exact: true }).click()
  const confirm = detail.getByRole('alertdialog', { name: 'PO 메일 발송 확인', exact: true })
  await expect(confirm).toContainText('qa-supplier@example.test')
  await confirm.getByRole('button', { name: '발송 확인', exact: true }).click()
  await expect(detail.getByRole('alert')).toContainText(/체험|설정|연결|실제/)
  const snapshot = await stored(page)
  expect(snapshot.operations.poDispatches).toHaveLength(1)
  expect(snapshot.operations.poDispatches[0]).toMatchObject({ status: 'draft', sentAt: '', providerMessageId: null, attempts: 0, dueDate: '2026-12-20' })
  expect(snapshot.operations.poDispatchAttempts).toHaveLength(0)
  expect(sendRequests).toHaveLength(0)
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await page.getByLabel('체험 역할').selectOption(FACTORY)
  const factoryDetail = await openStyle(page, SHIPPING_CODE)
  await operationTab(factoryDetail, 'PO 발송 이력')
  await expect(factoryDetail.locator('.ops-po-card')).toContainText('QA PO 직접 발송 검증')
  await expect(factoryDetail.getByRole('button', { name: 'PO 작성', exact: true })).toHaveCount(0)
  await expect(factoryDetail.getByRole('button', { name: 'PO 메일 발송', exact: true })).toHaveCount(0)
})

test('고정 종류에서 라벨·BY를 선택하고 발주·로스 및 요청·완료 수량을 분리해 보존한다', async ({ page }) => {
  await ready(page)
  const labelId = '88000000-0000-4000-8000-000000000001', embroideryId = '88000000-0000-4000-8000-000000000002'
  // Explicit QA catalog fixtures exercise selection without inventing vendor data.
  await page.evaluate(({ key, labelId, embroideryId, actor }) => {
    const workspace = JSON.parse(localStorage.getItem(key)!)
    const stamp = { version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), updatedBy: actor }
    workspace.operations.operationCatalogs.push({ id: labelId, kind: 'label', name: 'QA 고정 라벨 종류', active: true, ...stamp }, { id: embroideryId, kind: 'embroidery', name: 'QA 고정 BY 종류', active: true, ...stamp })
    localStorage.setItem(key, JSON.stringify(workspace))
  }, { key: STORAGE, labelId, embroideryId, actor: ADMIN })
  await page.reload()
  const detail = await openStyle(page, SHIPPING_CODE)
  await operationTab(detail, '중화 라벨')
  await detail.getByRole('button', { name: '라벨 관리 시작', exact: true }).click()
  const labelSelect = detail.getByRole('combobox', { name: '라벨 종류 1', exact: true })
  await expect(labelSelect.getByRole('option', { name: 'QA 고정 BY 종류', exact: true })).toHaveCount(0)
  await labelSelect.selectOption(labelId)
  await detail.getByLabel('라벨 발주 수량 1', { exact: true }).fill('100')
  await detail.getByLabel('라벨 로스 수량 1', { exact: true }).fill('7')
  await expect(detail.getByLabel('라벨 총 필요 수량 1', { exact: true })).toHaveValue('107')
  await detail.getByLabel('라벨 발주일 1', { exact: true }).fill('2026-10-25')
  await detail.getByLabel('라벨 입고 예정일 1', { exact: true }).fill('2026-11-03')
  await detail.getByLabel('라벨 상태 1', { exact: true }).selectOption('progress')
  await detail.getByLabel('라벨 변경 사유', { exact: true }).fill('QA 발주 수량과 로스 수량 분리')
  await detail.getByRole('button', { name: '라벨 내역 저장', exact: true }).click()
  await expect(detail.getByLabel('라벨 발주 수량 1', { exact: true })).toBeDisabled()
  await operationTab(detail, '비와이 자수')
  await detail.getByRole('button', { name: '자수 관리 시작', exact: true }).click()
  const embroiderySelect = detail.getByRole('combobox', { name: '자수 작업명 1', exact: true })
  await expect(embroiderySelect.getByRole('option', { name: 'QA 고정 라벨 종류', exact: true })).toHaveCount(0)
  await embroiderySelect.selectOption(embroideryId)
  await detail.getByLabel('자수 요청 수량 1', { exact: true }).fill('80')
  await detail.getByLabel('자수 완료 수량 1', { exact: true }).fill('81')
  await detail.getByLabel('자수 변경 사유', { exact: true }).fill('QA BY 요청과 완료 수량 분리')
  await detail.getByRole('button', { name: '자수 내역 저장', exact: true }).click()
  await expect(detail.getByRole('alert')).toContainText('초과')
  await detail.getByLabel('자수 완료 수량 1', { exact: true }).fill('60')
  await detail.getByLabel('자수 요청일 1', { exact: true }).fill('2026-10-26')
  await detail.getByLabel('자수 예정일 1', { exact: true }).fill('2026-11-04')
  await detail.getByLabel('자수 상태 1', { exact: true }).selectOption('progress')
  await expect(detail.getByLabel('자수 잔여 수량 1', { exact: true })).toHaveValue('20')
  await detail.getByRole('button', { name: '자수 내역 저장', exact: true }).click()
  await expect(detail.getByLabel('자수 요청 수량 1', { exact: true })).toBeDisabled()
  const records = (await stored(page)).operations.styleOperations
  expect(records.find(record => record.kind === 'label')!.rows[0]).toMatchObject({ catalogId: labelId, name: 'QA 고정 라벨 종류', quantity: 100, lossQuantity: 7 })
  expect(records.find(record => record.kind === 'embroidery')!.rows[0]).toMatchObject({ catalogId: embroideryId, name: 'QA 고정 BY 종류', quantity: 80, completedQuantity: 60 })
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await page.reload()
  await page.getByLabel('체험 역할').selectOption(FACTORY)
  const factoryDetail = await openStyle(page, SHIPPING_CODE)
  await operationTab(factoryDetail, '중화 라벨')
  await expect(factoryDetail.getByLabel('라벨 발주 수량 1', { exact: true })).toHaveValue('100')
  await expect(factoryDetail.getByLabel('라벨 로스 수량 1', { exact: true })).toHaveValue('7')
  await expect(factoryDetail.getByRole('button', { name: '라벨 관리 수정', exact: true })).toHaveCount(0)
  await operationTab(factoryDetail, '비와이 자수')
  await expect(factoryDetail.getByLabel('자수 완료 수량 1', { exact: true })).toHaveValue('60')
  await expect(factoryDetail.getByRole('button', { name: '자수 관리 수정', exact: true })).toHaveCount(0)
})

test('부분 출고 차수는 기존 출고를 보존하고 6사이즈 합계를 부모 스타일과 일치시킨다', async ({ page }) => {
  await ready(page)
  const before = await stored(page), original = before.styles.find(style => style.code === SHIPPING_CODE)!, originalLine = original.production[0]
  expect(sum(originalLine.shipped)).toBeGreaterThan(0)
  const first = [1, 2, 3, 4, 5, 6], second = [6, 5, 4, 3, 2, 1]
  const detail = await openStyle(page, SHIPPING_CODE)
  await operationTab(detail, '부분 출고')
  await detail.getByLabel('출고 컬러', { exact: true }).selectOption(originalLine.id)
  for (const [index, quantities] of [first, second].entries()) {
    await detail.getByRole('button', { name: '출고 차수 추가', exact: true }).click()
    await detail.getByLabel('출고일', { exact: true }).fill(index === 0 ? '2026-11-05' : '2026-11-08')
    for (const [sizeIndex, size] of SIZES.entries()) await detail.getByLabel(`${size} 출고 수량`, { exact: true }).fill(String(quantities[sizeIndex]))
    await detail.getByLabel('운송장 번호', { exact: true }).fill(`QA-SHIPMENT-${index + 1}`)
    await detail.getByLabel('출고 메모', { exact: true }).fill(`QA ${index + 1}차 출고 기록`)
    await detail.getByLabel('출고 변경 사유', { exact: true }).fill(`QA ${index + 1}차 출고 수량 검증`)
    await detail.getByRole('button', { name: '출고 차수 저장', exact: true }).click()
    await expect(detail.getByLabel('출고 변경 사유', { exact: true })).toHaveCount(0)
  }
  const after = await stored(page), line = after.styles.find(style => style.id === original.id)!.production.find(line => line.id === originalLine.id)!
  const ledger = after.operations.shipmentLedgers.find(item => item.styleId === original.id && item.lineId === originalLine.id)!
  const batches = after.operations.shipmentBatches.filter(item => item.styleId === original.id && item.lineId === originalLine.id)
  expect(ledger.baselineQuantities).toEqual(originalLine.shipped)
  expect(ledger.baselineDate).toBe(originalLine.shippedAt)
  expect(batches.map(batch => batch.round)).toEqual([1, 2])
  expect(batches[0].quantities).toEqual(amounts(first)); expect(batches[1].quantities).toEqual(amounts(second))
  for (const size of SIZES) expect(line.shipped[size]).toBe(originalLine.shipped[size] + 7)
  expect(line.shippedAt).toBe('2026-11-08')
  expect(after.styles.find(style => style.id === original.id)!.version).toBe(original.version + 2)
  await detail.locator('.ops-quantity-scroll').scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'docs/screenshots/operations.png' })
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await page.reload()
  const restored = await openStyle(page, SHIPPING_CODE)
  await operationTab(restored, '부분 출고')
  await restored.getByRole('button', { name: '1차', exact: true }).click()
  await expect(restored.getByLabel('운송장 번호', { exact: true })).toHaveValue('QA-SHIPMENT-1')
  await restored.getByRole('button', { name: '2차', exact: true }).click()
  await expect(restored.getByLabel('운송장 번호', { exact: true })).toHaveValue('QA-SHIPMENT-2')
  await restored.getByRole('tab', { name: /메인 생산/ }).click()
  await expect(restored.getByLabel('BK 실 출고 수량 M', { exact: true })).toBeDisabled()
})

test('개인 휴가와 본사 전용 업체 휴가는 권한대로 숨기고 런칭 일정만 공장에 공유한다', async ({ page }) => {
  await ready(page); await navigate(page, '프로젝트 캘린더')
  const today = await dateToday(page)
  const names = { private: 'QA-PRIVATE-개인 휴가', hq: 'QA-HQ-공유 휴가', launch: 'QA-ALL-제품 런칭', vendor: 'QA-CONFIDENTIAL-업체 휴가' }
  const scenarios = [
    { kind: 'personal_leave', title: names.private, visibility: 'private' },
    { kind: 'personal_leave', title: names.hq, visibility: 'hq' },
    { kind: 'launch', title: names.launch, visibility: 'all' },
    { kind: 'factory_holiday', title: names.vendor, visibility: 'hq' },
  ]
  for (const item of scenarios) {
    await page.getByRole('button', { name: '일정 등록', exact: true }).click()
    const modal = page.getByRole('dialog', { name: '일정 등록', exact: true })
    await modal.getByLabel('일정 유형', { exact: true }).selectOption(item.kind)
    await modal.getByLabel('일정명', { exact: true }).fill(item.title)
    await modal.getByLabel('일정 시작일', { exact: true }).fill(today)
    await modal.getByLabel('일정 종료일', { exact: true }).fill(today)
    if (item.kind === 'personal_leave') await modal.getByLabel('휴가 공개 범위', { exact: true }).selectOption(item.visibility)
    if (item.kind === 'factory_holiday') await modal.getByLabel('휴가 공장', { exact: true }).selectOption(CHINA)
    await modal.getByLabel('일정 메모', { exact: true }).fill(`${item.title} 메모`)
    await modal.getByLabel('일정 변경 사유', { exact: true }).fill('QA 일정 공개 범위 검증')
    await modal.getByRole('button', { name: '일정 등록', exact: true }).click()
    await expect(modal).toHaveCount(0)
  }
  expect((await stored(page)).operations.calendarEvents).toHaveLength(4)
  await page.getByLabel('체험 역할').selectOption(INTERNAL)
  await expect(page.locator('body')).not.toContainText(names.private)
  await expect(page.locator('body')).toContainText(names.hq)
  await expect(page.locator('body')).toContainText(names.vendor)
  await page.getByLabel('체험 역할').selectOption(FACTORY)
  await expect(page.locator('body')).toContainText(names.launch)
  for (const secret of [names.private, names.hq, names.vendor]) await expect(page.locator('body')).not.toContainText(secret)
  await expect(page.getByLabel('일정 유형 필터').getByRole('option', { name: '협력업체 휴가', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '예정 일정 알림', exact: true }).click()
  for (const secret of [names.private, names.hq, names.vendor]) await expect(page.locator('body')).not.toContainText(secret)
})

test('본사 직원 담당 공장 배정은 공장 계정의 스타일 접근 권한을 변경하지 않는다', async ({ page }) => {
  await ready(page)
  const before = await stored(page), factoryProfile = before.profiles.find(profile => profile.id === FACTORY)!
  const expectedCodes = before.styles.filter(style => style.factoryId === factoryProfile.factoryId).map(style => style.code).sort()
  await navigate(page, '사용자 · 기본 설정')
  await page.getByRole('button', { name: '천민영 담당 공장 배정', exact: true }).click()
  const modal = page.getByRole('dialog', { name: '담당 공장 배정', exact: true })
  const checks = modal.getByRole('checkbox')
  for (let index = 0; index < await checks.count(); index++) await checks.nth(index).uncheck()
  const china = before.factories.find(factory => factory.id === CHINA)!
  await modal.getByRole('checkbox', { name: new RegExp(china.name) }).check()
  await modal.getByLabel('공장 배정 변경 사유', { exact: true }).fill('QA 본사 직원 담당 공장 배정')
  await modal.getByRole('button', { name: '배정 저장', exact: true }).click()
  await expect(modal).toHaveCount(0)
  const after = await stored(page)
  expect(after.operations.employeeFactoryAssignments.find(item => item.employeeId === INTERNAL)?.factoryIds).toEqual([CHINA])
  expect(after.profiles.find(profile => profile.id === FACTORY)).toEqual(factoryProfile)
  expect(after.styles.map(style => [style.id, style.factoryId])).toEqual(before.styles.map(style => [style.id, style.factoryId]))
  await navigate(page, '오버뷰'); await page.getByLabel('체험 역할').selectOption(FACTORY)
  expect((await page.locator('.style-code').allTextContents()).sort()).toEqual(expectedCodes)
})

test('실제 Excel 오더 파일을 미리 보고 교체·재오더 추가 수량을 정확히 저장한다', async ({ page }) => {
  await ready(page)
  const before = await stored(page)
  const rows = [[CODE, 'BK', 1, 2, 3, 4, 5, 6, 21], [SHIPPING_CODE, 'OW', 6, 5, 4, 3, 2, 1, 21]]
  let modal = await openImport(page)
  await importFile(modal, await workbookBytes(rows))
  await modal.getByLabel(/기존 오더 교체/).check()
  await modal.getByLabel('오더 변경 사유', { exact: true }).fill('QA Excel 오더 수량 교체')
  await modal.getByRole('button', { name: '검증된 오더 적용', exact: true }).click()
  await expect(modal.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
  await modal.locator('.order-import-close').getByRole('button', { name: '닫기', exact: true }).click()
  await expect(modal).toHaveCount(0)
  let after = await stored(page)
  expect(after.styles.find(style => style.code === CODE)!.production.find(line => line.color === 'BK')!.order).toEqual(amounts([1, 2, 3, 4, 5, 6]))
  expect(after.styles.find(style => style.code === SHIPPING_CODE)!.production.find(line => line.color === 'OW')!.order).toEqual(amounts([6, 5, 4, 3, 2, 1]))
  expect(after.styles.find(style => style.code === CODE)!.production.find(line => line.color === 'OT')!.order).toEqual(before.styles.find(style => style.code === CODE)!.production.find(line => line.color === 'OT')!.order)
  modal = await openImport(page)
  await importFile(modal, await workbookBytes([[CODE, 'BK', 1, 1, 1, 1, 1, 1, 6]]), 'qa-reorder.xlsx')
  await modal.getByLabel(/기존 오더에 추가/).check()
  await modal.getByLabel('오더 변경 사유', { exact: true }).fill('QA Excel 재오더 추가')
  await modal.getByRole('button', { name: '검증된 오더 적용', exact: true }).click()
  await expect(modal.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
  await modal.locator('.order-import-close').getByRole('button', { name: '닫기', exact: true }).click()
  await expect(modal).toHaveCount(0)
  after = await stored(page)
  const changed = after.styles.find(style => style.code === CODE)!, original = before.styles.find(style => style.code === CODE)!
  expect(changed.production.find(line => line.color === 'BK')!.order).toEqual(amounts([2, 3, 4, 5, 6, 7]))
  expect(changed.production.map(line => line.shipped)).toEqual(original.production.map(line => line.shipped))
  expect(changed.production.map(line => line.received)).toEqual(original.production.map(line => line.received))
})

test('불일치·필수 열 누락 오더는 적용을 차단하고 동시 수정 시 전체 가져오기를 원자적으로 거부한다', async ({ page, context }) => {
  await ready(page)
  const before = await stored(page)
  let modal = await openImport(page)
  await importFile(modal, await workbookBytes([['UNKNOWN-QA-STYLE', 'BK', 1, 1, 1, 1, 1, 1, 6]]), 'qa-unmatched.xlsx')
  await modal.getByLabel('오더 변경 사유', { exact: true }).fill('QA 미일치 수량 차단')
  await expect(modal).toContainText(/불일치|찾을 수 없|등록되지 않|매칭|일치하는 품번이 없/)
  await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeDisabled()
  await modal.locator('.order-import-close').getByRole('button', { name: '닫기', exact: true }).click()
  modal = await openImport(page)
  await importFile(modal, await workbookBytes([[CODE, 'BK', 1, 2, 3, 4, 5]], ['품번', '색상', 'XXS', 'XS', 'S', 'M', 'L']), 'qa-missing-size.xlsx')
  await modal.getByLabel('오더 변경 사유', { exact: true }).fill('QA 필수 사이즈 열 차단')
  await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeDisabled()
  await modal.locator('.order-import-close').getByRole('button', { name: '닫기', exact: true }).click()
  modal = await openImport(page)
  await importFile(modal, await workbookBytes([[CODE, 'BK', 9, 9, 9, 9, 9, 9, 54], [SHIPPING_CODE, 'OW', 8, 8, 8, 8, 8, 8, 48]]), 'qa-atomic.xlsx')
  await modal.getByLabel('오더 변경 사유', { exact: true }).fill('QA 오래된 미리보기 전체 차단')
  await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeEnabled()
  const other = await context.newPage(); await ready(other)
  const detail = await openStyle(other)
  await detail.getByRole('button', { name: '기본 정보', exact: true }).click()
  await detail.getByRole('textbox', { name: /^본사 요청사항/ }).fill('QA 동시 수정 — 이 메모를 보존해야 합니다.')
  await detail.getByLabel('변경 사유', { exact: true }).fill('QA 오더 미리보기 후 다른 사용자 수정')
  await detail.getByRole('button', { name: '변경 저장', exact: true }).click()
  await expect(detail.locator('.success-message')).toContainText('변경 내용을 저장했습니다.')
  await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeDisabled()
  await expect(modal).toContainText(/다른 사용자|충돌|최신/)
  const after = await stored(page)
  for (const code of [CODE, SHIPPING_CODE]) expect(after.styles.find(style => style.code === code)!.production.map(line => line.order)).toEqual(before.styles.find(style => style.code === code)!.production.map(line => line.order))
  expect(after.styles.find(style => style.code === CODE)!.notes).toContain('QA 동시 수정')
})

test('테스트 마감 양식의 머리글·병합·수식을 보존하며 실제 업무 수량을 연결해 다운로드한다', async ({ page }) => {
  await ready(page)
  const source = await stored(page)
  const template = new ExcelJS.Workbook(), sheet = template.addWorksheet('QA 양식 — 실제 을지 아님')
  sheet.mergeCells('A1:F1'); sheet.getCell('A1').value = 'QA 합성 마감 양식 — 실제 을지 서식이 아닙니다.'
  const headerNames = ['품번', '제품명', '오더', '출고', '입고', '금액']
  sheet.getRow(3).values = headerNames; sheet.getRow(3).font = { bold: true }
  sheet.getCell('A42').value = 'QA 기존 합계행 유지'; sheet.getCell('F42').value = { formula: 'SUM(F4:F40)', result: 0 }
  const bytes = Buffer.from(await template.xlsx.writeBuffer())
  await navigate(page, '결제 · 마감')
  await page.getByRole('button', { name: '을지 양식 다운로드', exact: true }).click()
  const modal = page.getByRole('dialog', { name: '마감 양식에 채워서 다운로드', exact: true })
  await modal.getByLabel('마감 양식 파일', { exact: true }).setInputFiles({ name: 'qa-template.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes })
  await modal.getByLabel('머리글 행', { exact: true }).fill('3')
  await modal.getByLabel('데이터 시작 행', { exact: true }).fill('4')
  await modal.getByLabel('데이터 마지막 행', { exact: true }).fill('40')
  for (const [column, field] of [['A', 'colorCode'], ['B', 'styleName'], ['C', 'order.total'], ['D', 'shipped.total'], ['E', 'received.total'], ['F', 'invoiceAmount']]) await modal.getByLabel(`${column}열 연결`, { exact: true }).selectOption(field)
  await modal.getByRole('checkbox', { name: '지정한 범위가 합계·서명란을 제외한 데이터 영역임을 확인했습니다.', exact: true }).check()
  const downloadPending = page.waitForEvent('download')
  await modal.getByRole('button', { name: '양식 채워서 다운로드', exact: true }).click()
  const download = await downloadPending
  const output = new ExcelJS.Workbook(); await output.xlsx.load(await readFile((await download.path())!))
  const result = output.getWorksheet('QA 양식 — 실제 을지 아님')!
  expect(result.getCell('A1').value).toBe('QA 합성 마감 양식 — 실제 을지 서식이 아닙니다.')
  expect(result.model.merges).toContain('A1:F1')
  expect(result.getRow(3).values).toEqual([undefined, ...headerNames])
  expect(result.getRow(3).font.bold).toBe(true)
  expect(result.getCell('A42').value).toBe('QA 기존 합계행 유지')
  expect(result.getCell('F42').formula).toBe('SUM(F4:F40)')
  const expected = new Map(source.styles.flatMap(style => style.production.map(line => [`${style.code}${line.color}`, { line, name: style.name }] as const)))
  let count = 0
  for (let row = 4; row <= 40; row++) {
    const sku = result.getCell(`A${row}`).text
    if (!sku) continue
    const item = expected.get(sku)!
    expect(item).toBeDefined()
    expect(result.getCell(`B${row}`).text).toBe(item.name)
    expect(result.getCell(`C${row}`).value).toBe(sum(item.line.order))
    expect(result.getCell(`D${row}`).value).toBe(sum(item.line.shipped))
    expect(result.getCell(`E${row}`).value).toBe(sum(item.line.received))
    expect(result.getCell(`F${row}`).value).toBe(item.line.invoiceAmount)
    count++
  }
  expect(count).toBe(expected.size)
})

test('SIG 51열 CSV의 원본 16개 열을 보존하고 본사 참조 수정과 실제 오더 수량을 분리한다', async ({ page, context }) => {
  await ready(page)
  const sourceColumns = { A: 0, F: 5, L: 11, M: 12, S: 18, V: 21, W: 22, X: 23, Y: 24, AQ: 42, AR: 43, AS: 44, AT: 45, AU: 46, AV: 47, AY: 50 }
  const titles = Array.from({ length: 51 }, (_, index) => `QA 제목 ${index + 1}`)
  const values = Array.from({ length: 51 }, () => '')
  for (const [column, index] of Object.entries(sourceColumns)) values[index] = `QA-${column}-원본`
  values[0] = 'QA-프로젝트, "인용"'; values[5] = `${SHIPPING_CODE}BK`; values[11] = 'QA 제품명\n다음 줄'
  SIZES.forEach((size, index) => { titles[42 + index] = size; values[42 + index] = String(index + 1) })
  titles[50] = '총수량'; values[50] = '21'
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
  const bytes = Buffer.from(`\uFEFF${[titles, values].map(row => row.map(quote).join(',')).join('\r\n')}`, 'utf8')
  const modal = await openImport(page)
  await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name: 'qa-controlled-order-qty.csv', mimeType: 'text/csv', buffer: bytes })
  await expect(modal.getByLabel('오더 파일 형식', { exact: true })).toHaveValue('sig-order-qty')
  await expect(modal).toContainText('원본 정보')
  await modal.getByLabel('오더 변경 사유', { exact: true }).fill('QA 합성 51열 CSV 수량 및 원본 열 저장')
  await modal.getByRole('heading', { name: '적용 전 미리보기', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'docs/screenshots/order-import.png' })
  await modal.getByRole('button', { name: '검증된 오더 적용', exact: true }).click()
  await expect(modal.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
  await modal.locator('.order-import-close').getByRole('button', { name: '닫기', exact: true }).click()
  const imported = await stored(page), source = imported.operations.orderSourceRecords[0]
  expect(source.fileName).toBe('qa-controlled-order-qty.csv')
  expect(Object.keys(source.headers).sort()).toEqual(Object.keys(sourceColumns).sort())
  expect(source.rows).toHaveLength(1)
  expect(source.rows[0].rowNumber).toBe(2)
  for (const [column, index] of Object.entries(sourceColumns)) {
    expect(source.headers[column as keyof typeof source.headers]).toBe(titles[index])
    expect(source.rows[0].columns[column as keyof typeof source.rows[0]['columns']]).toBe(values[index])
  }
  const detail = await openStyle(page, SHIPPING_CODE)
  await detail.getByRole('tab', { name: /ORDER QTY 원본/ }).click()
  await expect(detail.locator('.order-source-table tbody tr')).toHaveCount(16)
  await detail.getByRole('button', { name: '원본 참조 정보 수정', exact: true }).click()
  await expect(detail.getByLabel('원본 2행 F열', { exact: true })).toHaveCount(0)
  await expect(detail.getByLabel('원본 2행 AQ열', { exact: true })).toHaveCount(0)
  await detail.getByLabel('원본 2행 A열', { exact: true }).fill('QA 본사 수정 프로젝트')
  await detail.getByLabel('원본 정보 변경 사유', { exact: true }).fill('QA 본사 참조 정보 수정')
  await detail.getByRole('button', { name: '원본 정보 저장', exact: true }).click()
  await expect(detail.locator('.order-source-panel')).toContainText('원본 참조 정보를 저장했습니다.')
  await detail.getByRole('button', { name: '원본 참조 정보 수정', exact: true }).click()
  await detail.getByLabel('원본 2행 A열', { exact: true }).fill('QA 오래된 편집 보존')
  await detail.getByLabel('원본 정보 변경 사유', { exact: true }).fill('QA 동시 원본 수정 차단')
  const other = await context.newPage(); await ready(other)
  const otherDetail = await openStyle(other, SHIPPING_CODE)
  await otherDetail.getByRole('tab', { name: /ORDER QTY 원본/ }).click()
  await otherDetail.getByRole('button', { name: '원본 참조 정보 수정', exact: true }).click()
  await otherDetail.getByLabel('원본 2행 A열', { exact: true }).fill('QA 최신 참조 프로젝트')
  await otherDetail.getByLabel('원본 정보 변경 사유', { exact: true }).fill('QA 다른 탭 원본 정보 저장')
  await otherDetail.getByRole('button', { name: '원본 정보 저장', exact: true }).click()
  await expect(detail.getByRole('button', { name: '원본 정보 저장', exact: true })).toBeDisabled()
  await expect(detail.getByLabel('원본 2행 A열', { exact: true })).toHaveValue('QA 오래된 편집 보존')
  await detail.getByRole('button', { name: '원본 편집 취소', exact: true }).click()
  await expect(detail.locator('.order-source-table')).toContainText('QA 최신 참조 프로젝트')
  await detail.getByRole('button', { name: '메인 생산에서 수량 수정', exact: true }).click()
  await detail.getByLabel('BK 오더 수량 M', { exact: true }).fill('77')
  await detail.getByLabel('변경 사유', { exact: true }).fill('QA 원본 스냅샷과 실제 오더 수량 분리')
  await detail.getByRole('button', { name: '변경 저장', exact: true }).click()
  await expect(detail.locator('.success-message')).toContainText('변경 내용을 저장했습니다.')
  const after = await stored(page)
  expect(after.styles.find(style => style.code === SHIPPING_CODE)!.production[0].order.M).toBe(77)
  expect(after.operations.orderSourceRecords[0].rows[0].columns.AT).toBe('4')
  expect(after.operations.orderSourceRecords[0].rows[0].columns.A).toBe('QA 최신 참조 프로젝트')
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await page.getByLabel('체험 역할').selectOption(FACTORY)
  const factoryDetail = await openStyle(page, SHIPPING_CODE)
  await expect(factoryDetail.getByRole('tab', { name: /ORDER QTY 원본/ })).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('QA 최신 참조 프로젝트')
})

test('390px 모바일에서 추가 업무 초안을 탭 이동과 닫기 확인 동안 보존하며 가로 넘침을 막는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await ready(page)
  const detail = await openStyle(page, SHIPPING_CODE)
  await operationTab(detail, 'PO 발송 이력')
  await detail.getByRole('button', { name: 'PO 작성', exact: true }).click()
  await detail.getByLabel('PO 메일 제목', { exact: true }).fill('QA 모바일 보존할 초안')
  await detail.getByRole('tab', { name: /샘플 이력/ }).click()
  await operationTab(detail, 'PO 발송 이력')
  await expect(detail.getByLabel('PO 메일 제목', { exact: true })).toHaveValue('QA 모바일 보존할 초안')
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  await detail.getByLabel('PO 메일 제목', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'docs/screenshots/operations-mobile.png' })
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  const confirm = detail.getByRole('alertdialog', { name: '저장하지 않은 변경 내용이 있습니다.', exact: true })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: '편집 계속', exact: true }).click()
  await expect(detail.getByLabel('PO 메일 제목', { exact: true })).toHaveValue('QA 모바일 보존할 초안')
  await detail.getByRole('button', { name: 'PO 편집 취소', exact: true }).click()
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await expect(detail).toHaveCount(0)
  const modal = await openImport(page)
  await importFile(modal, await workbookBytes([[SHIPPING_CODE, 'BK', 1, 2, 3, 4, 5, 6, 21]]))
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: 'docs/screenshots/order-import-mobile.png' })
})
