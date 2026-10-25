import { test, expect, type Page } from '@playwright/test'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1'
const ADMIN = '10000000-0000-4000-8000-000000000001'
const CHINA = '20000000-0000-4000-8000-000000000002'
const QUANTITIES = { XXS: 60, XS: 384, S: 626, M: 1296, L: 1162, XL: 610 }

async function ready(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function openImport(page: Page) {
  const menu = page.getByRole('button', { name: '메뉴 열기', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '메인 생산', exact: true }).click()
  await page.getByRole('button', { name: '오더 엑셀 업로드', exact: true }).click()
  return page.getByRole('dialog', { name: 'Excel 오더 수량 가져오기', exact: true })
}
function csv(sku: string, project = { code: 'QA-BASE-IMPORT-01', name: 'QA 기본 품번 프로젝트', season: '2026FY' }) {
  const headers = Array<string>(153).fill(''), row = Array<string>(153).fill('')
  headers[0] = '프로젝트 코드'; headers[5] = '스타일코드'; headers[8] = '컬러'; headers[11] = '년도/시즌'; headers[12] = '프로젝트 명칭'
  headers[22] = '생산처'; headers[24] = '생산 담당자'; headers[50] = 'TOTAL QTY'
  row[0] = project.code; row[5] = sku; row[8] = '#REF!'; row[11] = project.season; row[12] = project.name
  row[22] = 'QA 별도 공장'; row[24] = 'QA 별도 담당자'; row[50] = '4,138'
  Object.values(QUANTITIES).forEach((quantity, index) => { headers[42 + index] = `TTL ${index + 1}`; row[42 + index] = quantity.toLocaleString('en-US') })
  row[4] = '#NAME?'; row[96] = '#REF!'
  const quote = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
  return Buffer.from('\uFEFF' + [headers, row].map(values => values.map(quote).join(',')).join('\r\n'))
}

test('컬러 없는 F 기본 품번의 실제 수량을 먼저 표시하고 명시한 컬러로 등록·적용하며 원본을 보존한다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await ready(page)
  const before = await snapshot(page), modal = await openImport(page)
  await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name: 'QA-BASE-ORDER.csv', mimeType: 'text/csv', buffer: csv('QAFYDW9901') })
  await expect(modal.getByRole('heading', { name: '적용 전 미리보기', exact: true })).toBeVisible()
  const row = modal.locator('.import-preview-table tbody tr').first()
  await expect(row).toContainText('QAFYDW9901')
  await expect(row.locator('.import-total-cell')).toContainText('4,138')
  await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeDisabled()
  await expect(modal.getByLabel('색상 열', { exact: true })).toHaveCount(0)
  await modal.getByLabel('원본 2행 컬러', { exact: true }).fill('BK')
  await modal.getByRole('button', { name: '스타일·프로젝트 등록', exact: true }).click()
  const registration = modal.getByRole('region', { name: '미등록 스타일 등록', exact: true })
  await expect(registration.getByLabel('등록 기본 품번', { exact: true })).toHaveValue('QAFYDW9901')
  await expect(registration.getByLabel('등록 컬러', { exact: true })).toHaveValue('BK')
  await registration.getByLabel('등록 담당 공장', { exact: true }).selectOption(CHINA)
  await registration.getByLabel('등록 본사 담당자', { exact: true }).selectOption(ADMIN)
  await registration.getByLabel('등록 기준 납기일', { exact: true }).fill('2027-03-01')
  await registration.getByLabel('스타일 등록 사유', { exact: true }).fill('QA 기본 품번의 직접 선택 컬러 등록')
  await registration.getByRole('button', { name: '스타일·프로젝트 등록 저장', exact: true }).click()
  await expect(registration).toHaveCount(0)
  const registered = (await snapshot(page)).styles.find(style => style.code === 'QAFYDW9901')!
  expect(registered.colors).toEqual(['BK'])
  expect(Object.values(registered.production[0].order)).toEqual([0, 0, 0, 0, 0, 0])
  await modal.getByLabel('오더 변경 사유', { exact: true }).fill('QA AQ AV 수량 4138개 반영')
  await modal.getByRole('button', { name: '검증된 오더 적용', exact: true }).click()
  await expect(modal.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
  const after = await snapshot(page), style = after.styles.find(item => item.id === registered.id)!
  expect(after.styles).toHaveLength(before.styles.length + 1)
  expect(style.production[0].order).toEqual(QUANTITIES)
  expect(Object.values(style.production[0].shipped)).toEqual([0, 0, 0, 0, 0, 0])
  expect(Object.values(style.production[0].received)).toEqual([0, 0, 0, 0, 0, 0])
  const source = after.operations!.orderSourceRecords.find(item => item.styleId === registered.id)!
  expect(source.rows[0].columns).toMatchObject({ F: 'QAFYDW9901', AQ: '60', AR: '384', AS: '626', AT: '1,296', AU: '1,162', AV: '610', AY: '4,138' })
  expect('I' in source.rows[0].columns).toBe(false)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('기본 품번에 여러 컬러가 있으면 선택 전 적용을 막고 선택한 컬러의 오더만 변경한다', async ({ page }) => {
  await ready(page)
  const before = await snapshot(page), original = before.styles.find(item => item.code === 'BO42FYHD0102')!, project = before.projects.find(item => item.id === original.projectId)!
  const modal = await openImport(page)
  await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name: 'QA-MULTICOLOR.csv', mimeType: 'text/csv', buffer: csv(original.code, { code: 'QA-EXISTING-01', name: project.name, season: project.season }) })
  await expect(modal.locator('.import-preview-table tbody tr').first().locator('.import-total-cell')).toContainText('4,138')
  await modal.getByLabel('오더 변경 사유', { exact: true }).fill('QA 여러 컬러 중 OW만 변경')
  await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeDisabled()
  await modal.getByLabel('원본 2행 컬러', { exact: true }).fill('OW')
  await modal.getByRole('button', { name: '검증된 오더 적용', exact: true }).click()
  await expect(modal.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
  const after = await snapshot(page), updated = after.styles.find(item => item.id === original.id)!
  expect(updated.production.find(line => line.color === 'OW')!.order).toEqual(QUANTITIES)
  for (const line of original.production) {
    const current = updated.production.find(item => item.id === line.id)!
    if (line.color !== 'OW') expect(current).toEqual(line)
    expect(current.shipped).toEqual(line.shipped); expect(current.received).toEqual(line.received)
  }
  expect(updated.colors).toEqual(original.colors)
  expect(after.operations!.orderSourceRecords.find(item => item.styleId === original.id)!.rows[0].columns.F).toBe(original.code)
})

test('단일 등록 컬러의 기본 품번과 기존 컬러 포함 품번을 모두 읽고 I열은 사용하지 않는다', async ({ page }) => {
  await ready(page)
  const before = await snapshot(page), original = before.styles.find(item => item.code === 'BO42FYVT0109')!, project = before.projects.find(item => item.id === original.projectId)!
  const modal = await openImport(page)
  for (const sku of [original.code, `${original.code}BK`]) {
    await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name: `QA-${sku}.csv`, mimeType: 'text/csv', buffer: csv(sku, { code: 'QA-EXISTING-02', name: project.name, season: project.season }) })
    await modal.getByLabel('오더 변경 사유', { exact: true }).fill(`QA ${sku} 자동 매칭`)
    await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeEnabled()
    await modal.getByRole('button', { name: '검증된 오더 적용', exact: true }).click()
    await expect(modal.getByRole('button', { name: '적용 완료', exact: true })).toBeVisible()
    const after = await snapshot(page), updated = after.styles.find(item => item.id === original.id)!
    expect(updated.production[0].order).toEqual(QUANTITIES)
    expect(updated.production[0].shipped).toEqual(original.production[0].shipped)
    const source = after.operations!.orderSourceRecords.find(item => item.styleId === original.id)!
    expect(source.rows[0].columns.F).toBe(sku); expect('I' in source.rows[0].columns).toBe(false)
  }
})

test('컬러 지정 행을 더 펼친 뒤 26번째 데이터의 컬러를 입력해도 행과 입력값을 유지한다', async ({ page }) => {
  await ready(page)
  const before = await snapshot(page), modal = await openImport(page)
  const [header, row] = csv('QAFYDW9998').toString('utf8').split('\r\n')
  const buffer = Buffer.from([header, ...Array<string>(30).fill(row)].join('\r\n'))
  await modal.getByLabel('오더 Excel 파일', { exact: true }).setInputFiles({ name: 'QA-30-BASE-ROWS.csv', mimeType: 'text/csv', buffer })
  await expect(modal.getByLabel('원본 27행 컬러', { exact: true })).toHaveCount(0)
  await modal.getByRole('button', { name: '컬러 지정 행 더 보기', exact: true }).click()
  const color = modal.getByLabel('원본 27행 컬러', { exact: true })
  await expect(color).toBeVisible()
  await color.fill('B')
  await expect(color).toBeVisible()
  await color.fill('BK')
  await expect(color).toBeVisible()
  await expect(color).toHaveValue('BK')
  await expect(modal.getByLabel('원본 31행 컬러', { exact: true })).toBeVisible()
  await expect(modal.getByRole('button', { name: '검증된 오더 적용', exact: true })).toBeDisabled()
  expect(await snapshot(page)).toEqual(before)
})
