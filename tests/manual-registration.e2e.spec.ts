import { test, expect, type Locator, type Page } from '@playwright/test'
import type { Style, Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1'

async function snapshot(page: Page): Promise<Workspace> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE)
}

async function ready(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(key => {
    const workspace = JSON.parse(localStorage.getItem(key)!) as Workspace
    workspace.styles = []
    workspace.comments = []; workspace.attachments = []; workspace.audits = []; workspace.styleImages = []
    localStorage.setItem(key, JSON.stringify(workspace))
  }, STORAGE)
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}

async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: '메뉴 열기', exact: true })
  if (await menu.isVisible()) await menu.click()
  const nav = page.getByRole('navigation', { name: '주 메뉴' })
  await nav.getByRole('button', { name: name === '샘플 관리' ? /^샘플 관리/ : name, exact: name !== '샘플 관리' }).click()
}

async function openCreate(page: Page) {
  await page.getByRole('button', { name: '스타일 등록', exact: true }).first().click()
  return page.getByRole('dialog', { name: '새 스타일 등록', exact: true })
}

async function register(page: Page, form: Locator, code: string) {
  await form.getByLabel(/스타일 코드/).fill(code)
  await form.getByLabel(/제품명/).fill('QA 수기 등록 분류 검증')
  await form.getByLabel(/컬러 코드/).fill('BL')
  await form.getByRole('button', { name: '스타일 등록', exact: true }).click()
  const detail = page.getByRole('dialog')
  await expect(detail.getByRole('heading', { level: 1 })).toContainText(`${code}BL`)
  return detail
}

function sampleCount(page: Page) {
  return page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: /^샘플 관리/ }).locator('.nav-count')
}

function assertBlankMain(style: Style) {
  expect(style).toMatchObject({ stage: 'production', samples: [], ppApproved: false, colors: ['BL'] })
  expect(style.production).toHaveLength(1)
  for (const field of ['order', 'shipped', 'received', 'packing'] as const) {
    expect(Object.values(style.production[0][field])).toEqual([0, 0, 0, 0, 0, 0])
  }
  expect(Object.values(style.production[0].checks).every(status => status === 'unset')).toBe(true)
}

for (const [menu, code] of [['메인 생산', 'QAMANUALMAIN01'], ['결제 · 마감', 'QAMANUALMAIN02']]) {
  test(`${menu}에서 수기 등록하면 수량이 없어도 메인으로 저장하며 샘플 집계와 분리한다`, async ({ page }) => {
    await ready(page)
    await navigate(page, menu)
    const form = await openCreate(page)
    await expect(form.getByLabel('등록 구분', { exact: true })).toHaveValue('production')
    const detail = await register(page, form, code)
    assertBlankMain((await snapshot(page)).styles.find(style => style.code === code)!)
    await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
    await expect(sampleCount(page)).toHaveText('0')
    await page.reload()
    await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
    assertBlankMain((await snapshot(page)).styles.find(style => style.code === code)!)
    await expect(sampleCount(page)).toHaveText('0')
    await expect(page.locator('.workflow-count').filter({ hasText: '메인 생산' }).locator('b')).toHaveText('1')
    const approvedCard = page.locator('.kpi-card').filter({ hasText: '컨펌 완료' })
    await expect(approvedCard.locator('.kpi-number')).toHaveText(/^0\s*스타일$/)
    await approvedCard.click()
    await expect(page.locator('.style-code')).toHaveCount(0)
    await navigate(page, '샘플 관리')
    const sampleCard = page.locator('.kpi-card').filter({ hasText: '샘플 진행 중' })
    await expect(sampleCard.locator('.kpi-number')).toHaveText(/^0\s*스타일$/)
    await sampleCard.click()
    await expect(page.locator('.style-code')).toHaveCount(0)
    await navigate(page, '메인 생산')
    await expect(page.locator('.style-code')).toHaveText([`${code}BL`])
  })
}

test('샘플 관리의 기본 등록은 샘플로 유지하고 메인 구분을 명시하면 그대로 저장한다', async ({ page }) => {
  await ready(page)
  await navigate(page, '샘플 관리')
  let form = await openCreate(page)
  await expect(form.getByLabel('등록 구분', { exact: true })).toHaveValue('samples')
  let detail = await register(page, form, 'QAMANUALSAMPLE01')
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await expect(sampleCount(page)).toHaveText('1')
  const sample = (await snapshot(page)).styles.find(style => style.code === 'QAMANUALSAMPLE01')!
  expect(sample).toMatchObject({ stage: 'registered', samples: [], ppApproved: false })

  form = await openCreate(page)
  await form.getByLabel('등록 구분', { exact: true }).selectOption('production')
  detail = await register(page, form, 'QAMANUALMAIN03')
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  const after = await snapshot(page)
  assertBlankMain(after.styles.find(style => style.code === 'QAMANUALMAIN03')!)
  expect(after.styles.find(style => style.id === sample.id)).toEqual(sample)
  await expect(sampleCount(page)).toHaveText('1')
})

test('메인 생산 메뉴에서도 등록 구분을 샘플로 바꾸면 사용자의 선택을 유지한다', async ({ page }) => {
  await ready(page)
  await navigate(page, '메인 생산')
  const form = await openCreate(page)
  await expect(form.getByLabel('등록 구분', { exact: true })).toHaveValue('production')
  await form.getByLabel('등록 구분', { exact: true }).selectOption('samples')
  const detail = await register(page, form, 'QAMANUALSAMPLE02')
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  expect((await snapshot(page)).styles[0]).toMatchObject({ stage: 'registered', samples: [], ppApproved: false })
  await expect(sampleCount(page)).toHaveText('1')
})

test('기존 수기 등록 품번의 단계를 메인으로 보정해도 컬러·수량·승인·샘플 이력은 그대로 보존한다', async ({ page }) => {
  await ready(page)
  const detail = await register(page, await openCreate(page), 'QALEGACYMANUAL01')
  const before = (await snapshot(page)).styles[0]
  await expect(sampleCount(page)).toHaveText('1')
  await detail.getByRole('button', { name: '기본 정보', exact: true }).click()
  await detail.getByRole('combobox', { name: '전체 진행 단계', exact: true }).selectOption('production')
  const reason = 'QA 수기 메인 등록의 샘플 분류 오류 보정'
  await detail.getByLabel('변경 사유', { exact: true }).fill(reason)
  await detail.getByRole('button', { name: '변경 저장', exact: true }).click()
  await expect(detail.locator('.success-message')).toContainText('변경 내용을 저장했습니다.')
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await expect(sampleCount(page)).toHaveText('0')
  const after = await snapshot(page), changed = after.styles.find(style => style.id === before.id)!
  expect(changed).toEqual({ ...before, stage: 'production', version: before.version + 1, updatedAt: changed.updatedAt, updatedBy: changed.updatedBy })
  const audit = after.audits.find(item => item.reason === reason)!
  expect(audit.before).toEqual(before)
  expect(audit.after).toEqual(changed)
  await page.reload()
  await expect(sampleCount(page)).toHaveText('0')
})
