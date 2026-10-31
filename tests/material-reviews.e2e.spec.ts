import { test, expect, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { Workspace } from '../src/lib/types'

const STORAGE = 'sig-workspace-demo-v1', CODE = 'QAMATERIAL01'
const ADMIN = '10000000-0000-4000-8000-000000000001', FACTORY = '10000000-0000-4000-8000-000000000004', OTHER = '98900000-0000-4000-8000-000000000001'
const IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYvYAAAAASUVORK5CYII=', 'base64')
async function snapshot(page: Page): Promise<Workspace> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function fixture(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, code, other }) => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    const style = w.styles[1], supplier = w.profiles.find(person => person.role === 'factory' && person.approved)!
    style.code = code; style.name = 'QA 원부자재 세부 컨펌'; style.factoryId = supplier.factoryId!; style.stage = 'production'; style.samples = []; style.ppApproved = false
    style.production = [style.production[0]]; style.production[0].color = 'BK'; style.colors = ['BK']; style.production[0].checks.materials = 'todo'
    w.styles = [style]; w.comments = []; w.attachments = []; w.audits = []; w.styleImages = []
    w.materialReviewItems = []; w.materialReviewRounds = []; w.materialReviewsAvailable = true
    w.productionRuns = []; w.productionReceipts = []; w.productionRunAudits = []; w.productionConditions = []; w.supplierProductionOrders = []; w.productionPoContexts = []
    w.operations!.poDispatches = []; w.operations!.poDispatchAttempts = []; w.operations!.shipmentBatches = []; w.operations!.shipmentLedgers = []; w.operations!.styleOperations = []; w.operations!.orderSourceRecords = []
    w.profiles.push({ ...supplier, id: other, name: 'QA 다른 배정 업체', email: 'other-materials@example.test', factoryId: w.factories.find(factory => factory.id !== supplier.factoryId)!.id })
    localStorage.setItem(key, JSON.stringify(w))
  }, { key: STORAGE, code: CODE, other: OTHER })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function role(page: Page, actor: string) { await page.getByLabel('체험 역할', { exact: true }).selectOption(actor) }
async function open(page: Page) {
  await page.getByRole('button', { name: `${CODE}BK`, exact: true }).click()
  const detail = page.getByRole('dialog')
  await detail.getByRole('tab', { name: /^메인 생산/ }).click()
  const panel = detail.getByRole('region', { name: '원·부자재 세부 컨펌', exact: true })
  await expect(panel).toBeVisible()
  return { detail, panel }
}
async function close(detail: Locator) { await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click(); await expect(detail).not.toBeVisible() }
async function createItem(panel: Locator) {
  await panel.getByRole('button', { name: '원·부자재 항목 추가', exact: true }).click()
  await panel.getByLabel('원·부자재 구분', { exact: true }).selectOption('fabric')
  await panel.getByLabel('원·부자재 항목명', { exact: true }).fill('QA 코튼 원단')
  await panel.getByLabel('원·부자재 사양', { exact: true }).fill('면 100% · BK · 40수')
  await panel.getByLabel('원·부자재 기록 사유', { exact: true }).fill('QA 원단 항목 등록')
  await panel.getByRole('button', { name: '원·부자재 항목 저장', exact: true }).click()
  await expect(panel.getByRole('article', { name: '원단 QA 코튼 원단 컨펌', exact: true })).toBeVisible()
}
async function submit(page: Page, panel: Locator, round: number, filename: string, comment: string) {
  await panel.getByRole('button', { name: `${round}차 컨펌 요청`, exact: true }).click()
  await panel.getByLabel('원·부자재 컨펌 코멘트', { exact: true }).fill(comment)
  await panel.getByLabel('원·부자재 컨펌 이미지 업로드', { exact: true }).setInputFiles({ name: filename, mimeType: 'image/png', buffer: IMAGE })
  await expect(panel.getByRole('checkbox', { name: `컨펌 이미지 ${filename}`, exact: true })).toBeVisible()
  await panel.getByRole('checkbox', { name: `컨펌 이미지 ${filename}`, exact: true }).check()
  await panel.getByLabel('원·부자재 기록 사유', { exact: true }).fill(`QA ${round}차 원단 컨펌 요청`)
  await panel.getByRole('button', { name: '원·부자재 컨펌 요청 저장', exact: true }).click()
  await expect(panel.getByRole('listitem', { name: `QA 코튼 원단 ${round}차 컨펌 이력`, exact: true })).toContainText(`${round}차 · 컨펌 대기`)
}
async function decide(panel: Locator, round: number, status: '확정' | '리젝', comment: string) {
  await panel.getByRole('button', { name: `${round}차 ${status}`, exact: true }).click()
  await panel.getByLabel('원·부자재 컨펌 코멘트', { exact: true }).fill(comment)
  await panel.getByLabel('원·부자재 기록 사유', { exact: true }).fill(`QA ${round}차 원단 ${status} 검토`)
  await panel.getByRole('button', { name: '원·부자재 검토 확정', exact: true }).click()
  await expect(panel.getByRole('listitem', { name: `QA 코튼 원단 ${round}차 컨펌 이력`, exact: true })).toContainText(`${round}차 · ${status}`)
}

for (const mobile of [false, true]) test(`원단 1차 리젝 후 2차 요청·확정하고 코멘트·사진·기존 생산 정보를 보존한다 · ${mobile ? '모바일' : 'PC'}`, async ({ page }) => {
  test.setTimeout(45000)
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  const before = await snapshot(page)
  let { detail, panel } = await open(page)
  await createItem(panel); await close(detail)
  await role(page, FACTORY); ({ detail, panel } = await open(page))
  await expect(panel.getByRole('button', { name: '원·부자재 항목 추가', exact: true })).toHaveCount(0)
  await submit(page, panel, 1, 'QA_원단_1차.png', '1차 원단 컬러 확인 요청')
  await expect(panel.getByRole('button', { name: '1차 확정', exact: true })).toHaveCount(0)
  await close(detail); await role(page, ADMIN); ({ detail, panel } = await open(page))
  await decide(panel, 1, '리젝', '원단 색상 차이가 있어 다시 요청해 주세요.')
  const rejected = (await snapshot(page)).materialReviewRounds![0]
  expect(rejected).toMatchObject({ round: 1, status: 'rejected', comment: '1차 원단 컬러 확인 요청', reviewerComment: '원단 색상 차이가 있어 다시 요청해 주세요.', version: 2 })
  expect(rejected.attachmentIds).toHaveLength(1)
  await close(detail); await role(page, FACTORY); ({ detail, panel } = await open(page))
  await submit(page, panel, 2, 'QA_원단_2차.png', '컬러 수정한 2차 원단 확인 요청')
  await close(detail); await role(page, ADMIN); ({ detail, panel } = await open(page))
  await decide(panel, 2, '확정', '수정된 컬러 확인 완료, 이 원단으로 진행해 주세요.')
  const archive = panel.getByRole('listitem', { name: 'QA 코튼 원단 1차 컨펌 이력', exact: true })
  await expect(archive).toContainText('1차 원단 컬러 확인 요청')
  await expect(archive).toContainText('원단 색상 차이가 있어 다시 요청해 주세요.')
  await expect(archive).toContainText('QA_원단_1차.png')
  const pending = page.waitForEvent('download')
  await archive.getByRole('button', { name: 'QA 코튼 원단 1차 요청 QA_원단_1차.png 다운로드', exact: true }).click()
  expect(await readFile((await (await pending).path())!)).toEqual(IMAGE)
  const after = await snapshot(page)
  expect(after.materialReviewRounds).toHaveLength(2)
  expect(after.materialReviewRounds![0]).toEqual(rejected)
  expect(after.materialReviewRounds![1]).toMatchObject({ round: 2, status: 'approved', comment: '컬러 수정한 2차 원단 확인 요청', reviewerComment: '수정된 컬러 확인 완료, 이 원단으로 진행해 주세요.', version: 2 })
  expect(after.materialReviewRounds![1].attachmentIds).toHaveLength(1)
  expect(after.materialReviewRounds![1].attachmentIds[0]).not.toBe(rejected.attachmentIds[0])
  expect(after.styles).toEqual(before.styles)
  expect(after.styles[0].production[0].checks.materials).toBe('todo')
  expect(after.operations).toEqual(before.operations)
  expect(after.productionRuns).toEqual(before.productionRuns)
  expect(after.productionConditions).toEqual(before.productionConditions)
  await panel.getByRole('button', { name: '항목 정보 수정', exact: true }).click()
  await panel.getByLabel('원·부자재 사양', { exact: true }).fill('면 100% · BK · 60수 변경')
  await panel.getByLabel('원·부자재 기록 사유', { exact: true }).fill('QA 확정 후 사양 변경 재컨펌 표시')
  await panel.getByRole('button', { name: '원·부자재 항목 저장', exact: true }).click()
  await expect(panel).toContainText('항목 정보 변경 · 재컨펌 필요')
  await expect(panel.locator('.material-review-history-identity').first()).toContainText('면 100% · BK · 40수')
  expect((await snapshot(page)).materialReviewRounds).toEqual(after.materialReviewRounds)
  if (mobile) await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await close(detail); await role(page, FACTORY); ({ detail, panel } = await open(page))
  await expect(panel.getByRole('button', { name: '3차 컨펌 요청', exact: true })).toHaveCount(0)
  await close(detail); await role(page, OTHER)
  await expect(page.locator('.style-code')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('QA 코튼 원단')
  await expect(page.locator('body')).not.toContainText('수정된 컬러 확인 완료')
})

test('원·부자재 입력 중 닫기를 보호하고 다른 사용자가 항목을 변경하면 초안은 유지하며 오래된 저장을 막는다', async ({ page }) => {
  await fixture(page)
  const { detail, panel } = await open(page)
  await createItem(panel)
  await panel.getByRole('button', { name: '1차 컨펌 요청', exact: true }).click()
  await panel.getByLabel('원·부자재 컨펌 코멘트', { exact: true }).fill('QA 작성 중인 컨펌 코멘트')
  await panel.getByLabel('원·부자재 기록 사유', { exact: true }).fill('QA 동시 변경 확인')
  await page.evaluate(key => {
    const w = JSON.parse(localStorage.getItem(key)!) as Workspace
    w.materialReviewItems![0].version += 1
    localStorage.setItem(key, JSON.stringify(w)); window.dispatchEvent(new Event('sig-workspace-change'))
  }, STORAGE)
  await expect(panel).toContainText('다른 사용자가 이 항목이나 컨펌을 변경했습니다.')
  await expect(panel.getByLabel('원·부자재 컨펌 코멘트', { exact: true })).toHaveValue('QA 작성 중인 컨펌 코멘트')
  await expect(panel.getByRole('button', { name: '원·부자재 컨펌 요청 저장', exact: true })).toBeDisabled()
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  const warning = detail.getByRole('alertdialog')
  await expect(warning).toContainText('저장하지 않은 변경')
  await warning.getByRole('button', { name: '편집 계속', exact: true }).click()
  await expect(panel.getByLabel('원·부자재 컨펌 코멘트', { exact: true })).toHaveValue('QA 작성 중인 컨펌 코멘트')
  expect((await snapshot(page)).materialReviewRounds).toHaveLength(0)
})
