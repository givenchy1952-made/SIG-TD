import { test, expect, type Page, type Locator } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1'
const ADMIN = '10000000-0000-4000-8000-000000000001'
const FACTORY = '10000000-0000-4000-8000-000000000004'
const CODE = 'BO42FYHD0102'
const QUALITY = ['아우터', '니트', '티셔츠', '바지', '가방', '악세사리', '모자']
async function ready(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function fixture(page: Page) {
  await ready(page)
  await page.evaluate(({ key, code }) => {
    const w = JSON.parse(localStorage.getItem(key)!)
    const style = w.styles.find((item: { code: string }) => item.code === code)
    w.styles = [style]; w.productionDetails = []; w.refinementsAvailable = true
    style.production[0].measurements = 'QA 이전 서술 기록 · 총장 68cm'
    style.production[0].packing = { XXS: 91, XS: 92, S: 93, M: 94, L: 95, XL: 96 }
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, code: CODE })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function openStyle(page: Page) {
  await page.getByLabel('스타일 검색', { exact: true }).fill(CODE)
  await page.locator('.style-code').filter({ hasText: CODE }).first().click()
  return page.getByRole('dialog').filter({ has: page.getByRole('heading', { level: 1 }) })
}
async function production(detail: Locator) { await detail.getByRole('tab', { name: /메인 생산/ }).click(); return detail.getByRole('tabpanel', { name: '메인 생산', exact: true }) }
async function quality(detail: Locator) {
  await detail.getByRole('tab', { name: /가공·품질 관리/ }).click()
  await detail.getByRole('tablist', { name: '스타일 추가 업무', exact: true }).getByRole('tab', { name: /^품질 검사/ }).click()
  return detail.getByRole('region', { name: '품질 검사', exact: true })
}
async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: '메뉴 열기', exact: true }); if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name, exact: true }).click()
}

test('가공·품질 관리에 고정 검사 품목을 기록하고 상·하의 치수표와 기존 기록·패킹 데이터를 함께 보존한다', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page), detail = await openStyle(page)
  await expect(detail.getByRole('tab', { name: /^PO/ })).toBeVisible()
  await expect(detail.getByRole('tab', { name: /발주·출고·가공/ })).toHaveCount(0)
  const qc = await quality(detail)
  await qc.getByRole('button', { name: '품질 검사 수정', exact: true }).click()
  await expect(qc.getByLabel('품질 검사 대상').getByRole('option')).toHaveText(['품목 선택', ...QUALITY])
  await qc.getByLabel('품질 검사 대상', { exact: true }).selectOption('니트')
  await qc.getByLabel('품질 검사 수량', { exact: true }).fill('23')
  await qc.getByLabel('품질 검사 상태', { exact: true }).selectOption('done')
  await qc.getByLabel('품질 검사 완료일', { exact: true }).fill('2026-11-02')
  await qc.getByLabel('품질 검사 메모', { exact: true }).fill('QA 봉제 및 외관 검사 완료')
  await qc.getByLabel('품질 검사 변경 사유', { exact: true }).fill('QA 품목별 검사 확인')
  await qc.getByRole('button', { name: '품질 검사 저장', exact: true }).click()
  await expect(qc.getByRole('button', { name: '품질 검사 수정', exact: true })).toBeVisible()
  const main = await production(detail)
  await expect(main.locator('.quantity-table').getByRole('rowheader', { name: '패킹리스트', exact: true })).toHaveCount(0)
  await expect(main.getByRole('textbox', { name: '메인 제품 사이즈 측정', exact: true })).toHaveCount(0)
  const measurements = main.getByRole('region', { name: '메인 제품 사이즈 측정', exact: true })
  await measurements.getByRole('button', { name: '사이즈 측정 수정', exact: true }).click()
  await expect(measurements.getByRole('table', { name: '상의 사이즈 측정표', exact: true }).getByRole('columnheader')).toContainText(['위치', '편차', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL'])
  await measurements.getByLabel('상의 총장 (옆목) 편차', { exact: true }).fill('2')
  await measurements.getByLabel('상의 총장 (옆목) XXS', { exact: true }).fill('47.4')
  await measurements.getByLabel('상의 총장 (옆목) XXL', { exact: true }).fill('0')
  await measurements.getByRole('tab', { name: '하의', exact: true }).click()
  await measurements.getByLabel('하의 허리 (단면) M', { exact: true }).fill('40')
  await measurements.getByLabel('사이즈 측정 변경 사유', { exact: true }).fill('QA 상의 하의 실측 입력')
  await measurements.getByRole('button', { name: '사이즈 측정 저장', exact: true }).click()
  await expect(measurements.getByRole('button', { name: '사이즈 측정 수정', exact: true })).toBeVisible()
  const after = await snapshot(page), record = after.productionDetails![0]
  expect(after.styles[0]).toEqual(before.styles[0])
  expect(record.quality).toMatchObject({ category: '니트', quantity: 23, status: 'done', completedAt: '2026-11-02', note: 'QA 봉제 및 외관 검사 완료' })
  expect(record.measurements.upper[0]).toMatchObject({ grade: 2, values: { XXS: 47.4, XS: null, XXL: 0 } })
  expect(record.measurements.lower[0].values.M).toBe(40)
  expect(record.version).toBe(2)
  expect(after.audits.filter(item => item.action === '품질 검사·사이즈 측정 저장')).toHaveLength(2)
  await measurements.getByText('기존 측정 기록 (보관)', { exact: true }).click()
  await expect(measurements).toContainText('QA 이전 서술 기록 · 총장 68cm')
  await page.screenshot({ path: 'docs/screenshots/refinements-measurements.png' })
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await page.reload()
  await page.getByLabel('체험 역할').selectOption(FACTORY)
  const factoryDetail = await openStyle(page), factoryQC = await quality(factoryDetail)
  await expect(factoryDetail.getByRole('button', { name: '을지 다운로드', exact: true })).toHaveCount(0)
  await expect(factoryQC.getByLabel('품질 검사 대상')).toHaveValue('니트')
  await expect(factoryQC.getByRole('button', { name: '품질 검사 수정', exact: true })).toHaveCount(0)
  const factoryMain = await production(factoryDetail), factoryMeasurements = factoryMain.getByRole('region', { name: '메인 제품 사이즈 측정', exact: true })
  await factoryMeasurements.getByRole('button', { name: '사이즈 측정 수정', exact: true }).click()
  await factoryMeasurements.getByLabel('상의 총장 (옆목) S', { exact: true }).fill('51.4')
  await factoryMeasurements.getByLabel('사이즈 측정 변경 사유', { exact: true }).fill('QA 공장 실측 보완')
  await factoryMeasurements.getByRole('button', { name: '사이즈 측정 저장', exact: true }).click()
  await expect(factoryMeasurements.getByRole('button', { name: '사이즈 측정 수정', exact: true })).toBeVisible()
  expect((await snapshot(page)).productionDetails![0].quality).toEqual(record.quality)
  expect((await snapshot(page)).styles[0].production[0].packing).toEqual(before.styles[0].production[0].packing)
})

test('개인 오전·오후 반차와 2시간 반반차를 저장하고 캘린더에 구분·시간을 표시한다', async ({ page }) => {
  await ready(page); await navigate(page, '프로젝트 캘린더')
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })
  for (const [type, label] of [['am', '오전 반차'], ['pm', '오후 반차'], ['two_hours', '반반차 (2시간)']]) {
    await page.getByRole('button', { name: '일정 등록', exact: true }).click()
    const modal = page.getByRole('dialog', { name: '일정 등록', exact: true })
    await modal.getByLabel('일정명', { exact: true }).fill(`QA ${label}`)
    await modal.getByLabel('휴가 구분', { exact: true }).selectOption(type)
    await modal.getByLabel('일정 시작일', { exact: true }).fill(today)
    await expect(modal.getByLabel('일정 종료일', { exact: true })).toHaveValue(today)
    if (type === 'two_hours') {
      await modal.getByLabel('반반차 시작 시간', { exact: true }).fill('09:15')
      await expect(modal.getByLabel('반반차 종료 시간', { exact: true })).toHaveValue('11:15')
      await expect(modal.getByLabel('반반차 종료 시간', { exact: true })).toHaveAttribute('readonly', '')
    }
    await modal.getByLabel('일정 변경 사유', { exact: true }).fill('QA 부분 휴가 등록')
    await modal.getByRole('button', { name: '일정 등록', exact: true }).click()
    await expect(modal).toHaveCount(0)
    await expect(page.locator('.calendar-page')).toContainText(label)
  }
  const events = (await snapshot(page)).operations!.calendarEvents
  expect(events.map(event => event.leaveType)).toEqual(expect.arrayContaining(['am', 'pm', 'two_hours']))
  const quarter = events.find(event => event.leaveType === 'two_hours')!
  expect(quarter).toMatchObject({ startDate: today, endDate: today, startTime: '09:15', endTime: '11:15', visibility: 'private' })
  const audits = (await snapshot(page)).operations!.calendarEventAudits
  expect(audits).toHaveLength(3)
  await page.screenshot({ path: 'docs/screenshots/refinements-calendar.png' })
})

test('스타일에서 을지를 바로 열고 미입력 원가는 안내하며 PO를 별도 탭에서 관리한다', async ({ page }) => {
  await fixture(page)
  const detail = await openStyle(page)
  await detail.getByRole('tab', { name: /을지·단가/ }).click()
  await detail.getByRole('button', { name: '단가·을지 정보 수정', exact: true }).click()
  await detail.getByLabel('장당 원가', { exact: true }).fill('123.45')
  await detail.getByRole('button', { name: '을지 다운로드', exact: true }).click()
  await expect(detail.getByRole('alert')).toContainText('먼저 저장하거나 취소')
  await expect(page.getByRole('dialog', { name: '마감 양식에 채워서 다운로드', exact: true })).toHaveCount(0)
  await expect(detail.getByLabel('장당 원가', { exact: true })).toHaveValue('123.45')
  await detail.getByRole('button', { name: '단가 편집 취소', exact: true }).click()
  await detail.getByRole('button', { name: '오류 안내 닫기', exact: true }).click()
  await detail.getByRole('button', { name: '을지 다운로드', exact: true }).click()
  const modal = page.getByRole('dialog', { name: '마감 양식에 채워서 다운로드', exact: true })
  await expect(modal).toBeVisible()
  await expect(modal.getByRole('tab', { name: 'SIG 을지 자동 작성', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(modal.getByRole('button', { name: '을지 다운로드', exact: true })).toBeDisabled()
  await expect(modal).toContainText('장당 원가')
  await modal.getByLabel('닫기', { exact: true }).click()
  await expect(modal).toHaveCount(0)
  await expect(detail).toBeVisible()
  await detail.getByRole('tab', { name: /^PO/ }).click()
  await expect(detail.getByRole('heading', { name: 'PO 메일 및 발송 이력', exact: true })).toBeVisible()
  await expect(detail.getByRole('tab', { name: /부분 출고/ })).toHaveCount(0)
})

test('치수표 동시 수정은 오래된 저장을 막고 모바일에서 작성값과 닫기 보호를 유지한다', async ({ page, context }) => {
  await fixture(page)
  const second = await context.newPage(); await second.setViewportSize({ width: 390, height: 844 }); await ready(second)
  const firstDetail = await openStyle(page), secondDetail = await openStyle(second)
  const firstMain = await production(firstDetail), secondMain = await production(secondDetail)
  const first = firstMain.getByRole('region', { name: '메인 제품 사이즈 측정', exact: true }), other = secondMain.getByRole('region', { name: '메인 제품 사이즈 측정', exact: true })
  await first.getByRole('button', { name: '사이즈 측정 수정', exact: true }).click()
  await other.getByRole('button', { name: '사이즈 측정 수정', exact: true }).click()
  await first.getByLabel('상의 총장 (옆목) M', { exact: true }).fill('57')
  await other.getByLabel('상의 총장 (옆목) M', { exact: true }).fill('63.25')
  await first.getByLabel('사이즈 측정 변경 사유', { exact: true }).fill('QA 먼저 저장')
  await other.getByLabel('사이즈 측정 변경 사유', { exact: true }).fill('QA 보존할 초안')
  await first.getByRole('button', { name: '사이즈 측정 저장', exact: true }).click()
  await expect(other.getByRole('status').filter({ hasText: '다른 사용자가 먼저 수정했습니다.' })).toBeVisible()
  await expect(other.getByRole('button', { name: '사이즈 측정 저장', exact: true })).toBeDisabled()
  await expect(other.getByLabel('상의 총장 (옆목) M', { exact: true })).toHaveValue('63.25')
  await expect.poll(() => second.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await secondDetail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await expect(secondDetail.getByRole('alertdialog', { name: '저장하지 않은 변경 내용이 있습니다.', exact: true })).toBeVisible()
  await secondDetail.getByRole('button', { name: '편집 계속', exact: true }).click()
  await other.getByLabel('상의 총장 (옆목) M', { exact: true }).scrollIntoViewIfNeeded()
  await second.screenshot({ path: 'docs/screenshots/refinements-mobile.png' })
  expect((await snapshot(page)).productionDetails![0].measurements.upper[0].values.M).toBe(57)
  await second.close()
})

test('F열 새 품번과 A·M 프로젝트를 한 번의 오더 적용으로 자동 등록하고 AQ~AV 수량을 반영한다', async ({ page }) => {
  await ready(page)
  const before = await snapshot(page)
  await navigate(page, '메인 생산')
  await page.getByRole('button', { name: '오더 엑셀 업로드', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Excel 오더 수량 가져오기', exact: true })
  const headers = Array(51).fill(''), row = Array(51).fill('')
  headers[0] = '프로젝트 코드'; headers[5] = '스타일코드'; headers[8] = '컬러'; headers[11] = '년도/시즌'; headers[12] = '프로젝트 명칭'; headers[22] = '생산처'; headers[24] = '생산 담당자'; headers[50] = 'TOTAL QTY'
  row[0] = 'QA-PROJECT-IMPORT-01'; row[5] = 'QAFYTS9001BK'; row[8] = '#REF!'; row[11] = '2027SS'; row[12] = 'QA 신규 프로젝트'; row[22] = 'QA 미등록 공장'; row[24] = 'QA 담당자'
  for (const [index, size] of ['XXS', 'XS', 'S', 'M', 'L', 'XL'].entries()) { headers[42 + index] = size; row[42 + index] = String(index + 1) }
  row[50] = '21'
  const csv = Buffer.from('\uFEFF' + [headers.join(','), row.join(',')].join('\r\n'))
  await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name: 'ORDER QTY.csv', mimeType: 'text/csv', buffer: csv })
  await expect(modal.getByRole('heading', { name: '적용 전 미리보기', exact: true })).toBeVisible()
  await expect(modal.getByLabel('색상 열', { exact: true })).toHaveCount(0)
  await expect(modal).toContainText('I열은 사용하지 않음')
  await expect(modal.getByRole('region', { name: '미등록 스타일 등록', exact: true })).toHaveCount(0)
  await expect(modal.getByRole('button', { name: '스타일·프로젝트 등록', exact: true })).toHaveCount(0)
  await expect(modal).toContainText('QA-PROJECT-IMPORT-01')
  await expect(modal).toContainText('QA 신규 프로젝트')
  const apply = modal.getByRole('button', { name: '검증된 오더 적용', exact: true })
  await expect(apply).toBeDisabled()
  await modal.getByLabel('일괄 등록 공장 QA 미등록 공장', { exact: true }).selectOption('20000000-0000-4000-8000-000000000002')
  await expect(apply).toBeEnabled()
  const planned = await snapshot(page)
  expect(planned.styles).toHaveLength(before.styles.length)
  expect(planned.projects).toEqual(before.projects)
  await modal.getByLabel('오더 변경 사유', { exact: true }).fill('QA AQ AV 여섯 사이즈 적용')
  await apply.click()
  await expect(modal.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
  const after = await snapshot(page), updated = after.styles.find(item => item.code === 'QAFYTS9001')!
  expect(after.styles).toHaveLength(before.styles.length + 1)
  expect(updated.colors).toEqual(['BK']); expect(updated.production[0].color).toBe('BK')
  expect(updated.ownerId).toBe(ADMIN)
  expect(updated.factoryId).toBe('20000000-0000-4000-8000-000000000002')
  expect(updated.dueDate).toBe('')
  expect(after.projects.find(item => item.id === updated.projectId)).toMatchObject({ code: 'QA-PROJECT-IMPORT-01', name: 'QA 신규 프로젝트', season: '2027SS' })
  expect(updated.production[0].order).toEqual({ XXS: 1, XS: 2, S: 3, M: 4, L: 5, XL: 6 })
  expect(Object.values(updated.production[0].received)).toEqual([0, 0, 0, 0, 0, 0])
  expect(Object.values(updated.production[0].shipped)).toEqual([0, 0, 0, 0, 0, 0])
  const source = after.operations!.orderSourceRecords.find(item => item.styleId === updated.id)!
  expect(source.rows[0].columns).toMatchObject({ A: 'QA-PROJECT-IMPORT-01', F: 'QAFYTS9001BK', M: 'QA 신규 프로젝트', AQ: '1', AV: '6' })
  expect('I' in source.rows[0].columns).toBe(false)
})
