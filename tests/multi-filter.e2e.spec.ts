import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1'
const FACTORY = '10000000-0000-4000-8000-000000000004'
const CODES = ['QAFILTER0001', 'QAFILTER0002', 'QAFILTER0003', 'QAFILTER0004']
async function ready(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page) {
  await ready(page)
  await page.evaluate(({ key, codes }) => {
    const w = JSON.parse(localStorage.getItem(key)!)
    const source = w.styles.find((s: { samples: unknown[] }) => s.samples.length)
    const china = w.factories.find((f: {country:string}) => f.country === '중국')
    const korea = w.factories.find((f: {country:string}) => f.country === '대한민국')
    china.name = 'QA 선택 공장'; korea.name = 'QA 다른 공장'
    const today = new Date().toLocaleDateString('en-CA')
    w.projects = w.projects.slice(0, 3).map((p: object, i: number) => ({ ...p, code: '', name: `QA 프로젝트 ${['A', 'B', 'C'][i]}`, season: i === 2 ? '2027SS' : '2026FW' }))
    w.styles = codes.map((code: string, i: number) => {
      const style = structuredClone(source)
      style.id = crypto.randomUUID(); style.code = code; style.name = `QA 필터 제품 ${i + 1}`
      style.projectId = w.projects[[0, 1, 2, 1][i]].id; style.season = w.projects[[0, 1, 2, 1][i]].season
      style.factoryId = i === 3 ? korea.id : china.id; style.dueDate = today; style.stage = 'sample1'; style.deletedAt = null
      style.samples = [{ ...style.samples[0], id: crypto.randomUUID(), factoryId: style.factoryId, status: 'progress', plannedAt: today, completedAt: '', shippedAt: '', receivedAt: '', reviewedAt: '' }]
      style.production = [{ ...style.production[0], id: crypto.randomUUID(), color: ['BK', 'OW', 'NV', 'BK'][i], confirmDue: today, shippedAt: '', receivedAt: '', paymentDue: today, paymentStatus: 'todo' }]
      style.colors = [style.production[0].color]
      for (const field of ['order', 'packing', 'shipped', 'received']) for (const size of Object.keys(style.production[0][field])) style.production[0][field][size] = 0
      style.production[0].order.M = 10 + i
      return style
    })
    w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []
    w.operations.calendarEvents = [{ id: crypto.randomUUID(), kind: 'factory_holiday', visibility: 'hq', title: 'QA 비공개 업체 휴가', startDate: today, endDate: today, ownerId: w.profiles[0].id, factoryId: china.id, note: 'QA 비공개 휴가 메모', deletedAt: null, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), updatedBy: w.profiles[0].id }]
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, codes: CODES })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function navigate(page: Page, title: string) {
  const menu = page.getByRole('button', { name: '메뉴 열기', exact: true }); if (await menu.isVisible()) await menu.click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: title, exact: true }).click()
}
async function openFilter(page: Page, label: string) {
  await page.getByRole('button', { name: label, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `${label} 선택`, exact: true }); await expect(dialog).toBeVisible(); return dialog
}
async function select(page: Page, label: string, options: string[]) {
  const dialog = await openFilter(page, label)
  await dialog.getByRole('button', { name: '선택해제', exact: true }).click()
  for (const value of options) await dialog.getByRole('checkbox', { name: value, exact: true }).check()
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0)
}

test('프로젝트 내 복수 선택과 공장·제품 교차 필터를 적용하고 선택한 품번만 CSV·Excel에 포함한다', async ({ page }) => {
  await fixture(page)
  const before = await snapshot(page)
  await navigate(page, '메인 생산')
  await select(page, '프로젝트 필터', ['QA 프로젝트 A', 'QA 프로젝트 B'])
  await expect(page.locator('.style-code')).toHaveCount(3)
  await select(page, '공장 필터', ['QA 선택 공장'])
  await expect(page.locator('.style-code')).toHaveCount(2)
  await select(page, '제품 필터', [`${CODES[0]} · QA 필터 제품 1`, `${CODES[1]} · QA 필터 제품 2`])
  await expect(page.locator('.style-code')).toContainText([`${CODES[0]}BK`, `${CODES[1]}OW`])
  await page.getByRole('button', { name: '다운로드', exact: true }).click()
  let pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 파일 (.csv)', exact: true }).click()
  const csv = await readFile((await (await pending).path())!, 'utf8')
  for (const code of CODES.slice(0, 2)) expect(csv).toContain(code)
  for (const code of CODES.slice(2)) expect(csv).not.toContain(code)
  await page.getByRole('button', { name: '다운로드', exact: true }).click()
  pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Excel 통합 문서 (.xlsx)', exact: true }).click()
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile((await (await pending).path())!)
  expect(workbook.getWorksheet('스타일')!.rowCount).toBe(3)
  expect(workbook.getWorksheet('메인 생산')!.rowCount).toBe(3)
  const exported = JSON.stringify(workbook.getWorksheet('메인 생산')!.getSheetValues())
  expect(exported).toContain(`${CODES[0]}BK`); expect(exported).toContain(`${CODES[1]}OW`)
  for (const code of CODES.slice(2)) expect(exported).not.toContain(code)
  await select(page, '프로젝트 필터', [])
  await expect(page.getByRole('heading', { name: '조건에 맞는 스타일이 없습니다.' })).toBeVisible()
  await page.getByRole('button', { name: '프로젝트 필터 해제', exact: true }).click()
  await expect(page.locator('.style-code')).toHaveCount(2)
  await page.getByRole('button', { name: '초기화', exact: true }).click()
  await expect(page.locator('.style-code')).toHaveCount(4)
  expect(await snapshot(page)).toEqual(before)
})

test('캘린더 여러 프로젝트·일정 종류를 함께 선택하고 주간 전환·제품 필터 및 공장 권한을 유지한다', async ({ page }) => {
  await fixture(page)
  await navigate(page, '프로젝트 캘린더')
  await select(page, '일정 프로젝트 필터', ['QA 프로젝트 A', 'QA 프로젝트 B'])
  await select(page, '일정 공장 필터', ['QA 선택 공장'])
  await select(page, '일정 유형 필터', ['샘플', '결제'])
  await expect(page.locator('.calendar-bottom>.panel').first().locator('.section-heading .pill')).toHaveText('4건')
  await expect(page.locator('.calendar-summary strong').first()).toHaveText('4')
  await page.getByRole('button', { name: '주간', exact: true }).click()
  await expect(page.locator('.calendar-cell')).toHaveCount(7)
  await expect(page.getByRole('button', { name: '일정 프로젝트 필터', exact: true })).toContainText('외 1개')
  await expect(page.getByRole('button', { name: '일정 유형 필터', exact: true })).toContainText('외 1개')
  await select(page, '일정 제품 필터', [`${CODES[1]} · QA 필터 제품 2`])
  await expect(page.locator('.calendar-bottom>.panel').first().locator('.section-heading .pill')).toHaveText('2건')
  await expect(page.locator('.calendar-summary strong').first()).toHaveText('2')
  await select(page, '일정 유형 필터', [])
  await expect(page.locator('.calendar-summary strong').first()).toHaveText('0')
  await page.getByRole('button', { name: '필터 초기화', exact: true }).click()
  await page.getByLabel('체험 역할').selectOption(FACTORY)
  await expect(page.locator('body')).not.toContainText('QA 비공개 업체 휴가')
  await expect(page.locator('body')).not.toContainText('QA 비공개 휴가 메모')
  const dialog = await openFilter(page, '일정 유형 필터')
  await expect(dialog.getByRole('checkbox', { name: '협력업체 휴가', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('모바일에서 검색해 여러 항목을 고르고 전체 선택·선택 해제·Esc 복귀가 동작하며 가로로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  const dialog = await openFilter(page, '프로젝트 필터')
  await dialog.getByRole('button', { name: '선택해제', exact: true }).click()
  const search = dialog.getByRole('searchbox', { name: '프로젝트 필터 검색', exact: true })
  await search.fill('프로젝트 A')
  await dialog.getByRole('checkbox', { name: 'QA 프로젝트 A', exact: true }).check()
  await search.fill('프로젝트 B')
  await dialog.getByRole('checkbox', { name: 'QA 프로젝트 B', exact: true }).check()
  await search.fill('')
  await expect(dialog.getByRole('checkbox', { name: 'QA 프로젝트 A', exact: true })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'QA 프로젝트 B', exact: true })).toBeChecked()
  const box = await dialog.boundingBox(); expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '프로젝트 필터', exact: true })).toBeFocused()
  await expect(page.locator('.style-code')).toHaveCount(3)
  const all = await openFilter(page, '프로젝트 필터')
  await all.getByRole('checkbox', { name: '전체선택', exact: true }).check()
  await page.keyboard.press('Escape'); await expect(page.locator('.style-code')).toHaveCount(4)
  const none = await openFilter(page, '프로젝트 필터')
  await none.getByRole('checkbox', { name: '전체선택', exact: true }).uncheck()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '조건에 맞는 스타일이 없습니다.' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('전체 스타일 보기에서도 선택한 두 컬러만 Excel 생산 행과 CSV 오더 합계에 포함한다', async ({ page }) => {
  await ready(page)
  const before = await snapshot(page), style = before.styles.find(item => item.code === 'BO42FYHD0102')!
  const expectedOrder = style.production.filter(line => ['BK', 'OW'].includes(line.color)).reduce((sum, line) => sum + Object.values(line.order).reduce((quantity, value) => quantity + value, 0), 0)
  await select(page, '제품 필터', [`${style.code} · ${style.name}`])
  await page.getByRole('button', { name: /^상세 필터/ }).click()
  await select(page, '컬러', ['BK', 'OW'])
  await expect(page.locator('.style-code')).toHaveCount(1)
  await expect(page.locator('.styles-table tbody tr').first().locator('.amount')).toContainText(expectedOrder.toLocaleString('ko-KR'))
  await page.getByRole('button', { name: '다운로드', exact: true }).click()
  let pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Excel 통합 문서 (.xlsx)', exact: true }).click()
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile((await (await pending).path())!)
  const production = workbook.getWorksheet('메인 생산')!
  expect(production.rowCount).toBe(3)
  const exported = JSON.stringify(production.getSheetValues())
  expect(exported).toContain(`${style.code}BK`); expect(exported).toContain(`${style.code}OW`)
  expect(exported).not.toContain(`${style.code}NV`)
  expect(workbook.getWorksheet('스타일')!.getRow(2).getCell(13).value).toBe(expectedOrder)
  await page.getByRole('button', { name: '다운로드', exact: true }).click()
  pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'CSV 파일 (.csv)', exact: true }).click()
  const csv = await readFile((await (await pending).path())!, 'utf8')
  expect(csv).toContain(`"${expectedOrder}"`)
  expect(csv).not.toContain(`${style.code}NV`)
  expect(await snapshot(page)).toEqual(before)
})
