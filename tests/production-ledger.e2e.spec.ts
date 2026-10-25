import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'

const STORAGE = 'sig-workspace-demo-v1', CODE = 'BO42FYHD0102', FACTORY = '10000000-0000-4000-8000-000000000004'
async function fixture(page: Page, closed = false) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await page.evaluate(({ key, code, closed }) => {
    const workspace = JSON.parse(localStorage.getItem(key)!)
    const style = workspace.styles.find((item: { code: string }) => item.code === code), line = style.production[0]
    const actor = workspace.profiles.find((item: { role: string }) => item.role === 'admin'), factoryActor = workspace.profiles.find((item: { role: string; factoryId: string }) => item.role === 'factory' && item.factoryId === style.factoryId)
    workspace.styles = [style]; style.production = [line]; style.colors = [line.color]; style.stage = 'production'
    workspace.productionLedgerAvailable = true; workspace.supplierOrdersAvailable = true; workspace.productionRunAudits = []; workspace.productionReceipts = []
    const project = workspace.projects.find((item: { id: string }) => item.id === style.projectId)
    project.code = 'QA-RUN-PROJECT-2026'
    const now = '2026-10-25T00:00:00Z', quantities = { XXS: 0, XS: 0, S: 10, M: 0, L: 0, XL: 0 }
    const make = (round: number, cost: number) => {
      const runId = crypto.randomUUID(), poId = crypto.randomUUID(), code = `${style.code}${line.color}`
      const identity = { factoryIdSnapshot: style.factoryId, ownerIdSnapshot: style.ownerId, styleCodeSnapshot: code, factoryNameSnapshot: 'QA 확정 공장', ownerNameSnapshot: 'QA 확정 담당자' }
      workspace.operations.poDispatches.push({ id: poId, styleId: style.id, dueDate: '2026-11-05', recipient: 'qa-factory@example.test', subject: `QA ${round}차 PO`, body: `QA ${round}차 생산 요청`, evidenceAttachmentId: null, status: 'sent', sentAt: now, providerMessageId: 'fixture-not-a-real-email', lastError: null, attempts: 1, idempotencyKey: crypto.randomUUID(), ...identity, voided: false, version: 2, createdAt: now, updatedAt: now, updatedBy: actor.id })
      const run = { id: runId, styleId: style.id, lineId: line.id, projectId: project.id, projectCode: project.code, expectedDue: '2026-11-05', name: `QA 생산 ${round}`, round, poId, order: quantities, unitCost: cost, itemType: 'product', correctsRunId: null, ...identity, version: 1, createdAt: now, updatedAt: now, updatedBy: actor.id, closedAt: null as string | null, snapshot: null as object | null }
      const acceptance = { id: crypto.randomUUID(), expectedDeliveryDate: '2026-11-05', acceptedAt: now, actorId: factoryActor.id, actorName: factoryActor.name, actorEmail: factoryActor.email, factoryId: style.factoryId, runVersion: 1, poVersion: 2, poSnapshot: { id: poId, version: 2, factoryId: style.factoryId }, termsSnapshot: {} }
      workspace.supplierProductionOrders.push({ runId, acceptance, startedAt: now, startedBy: actor.id, startedByName: actor.name })
      if (closed) {
        const receipt = { id: crypto.randomUUID(), runId, styleId: style.id, lineId: line.id, receivedAt: '2026-10-25', quantities: { ...quantities, S: 4 }, unitCost: cost, netAmount: cost * 4, voided: false, version: 1, createdAt: now, createdBy: actor.id }
        workspace.productionReceipts.push(receipt); run.closedAt = now
        run.snapshot = { ...identity, projectId: project.id, projectCode: project.code, expectedDue: run.expectedDue, styleCode: code, factory: identity.factoryNameSnapshot, owner: identity.ownerNameSnapshot, name: run.name, round, poId, itemType: 'product', unitCost: cost, orderQuantity: 10, receivedQuantity: 4, netAmount: cost * 4, vatAmount: cost * 0.4, grossAmount: cost * 4.4, lastReceivedAt: '2026-10-25', receipts: [receipt], finalizedAt: now, finalizedBy: actor.id }
      }
      return run
    }
    workspace.supplierProductionOrders = []
    workspace.productionRuns = closed ? [make(1, 100), make(2, 200)] : [make(1, 100)]
    workspace.settlementTermsAvailable = true
    workspace.settlementTerms = [{ styleId: style.id, lineId: line.id, projectCode: project.code, unitCost: 999, itemType: 'product', version: 1, createdAt: now, updatedAt: now, updatedBy: actor.id }]
    line.received = { ...quantities, S: 999 }; line.receivedAt = '2026-10-25'
    localStorage.setItem(key, JSON.stringify(workspace))
  }, { key: STORAGE, code: CODE, closed })
  await page.reload()
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
}
async function open(page: Page) {
  await page.getByLabel('스타일 검색', { exact: true }).fill(CODE)
  await page.locator('.style-code').filter({ hasText: CODE }).first().click()
  const detail = page.getByRole('dialog').filter({ has: page.getByRole('heading', { level: 1 }) })
  await detail.getByRole('tab', { name: /생산 차수·마감/ }).click()
  return { detail, ledger: detail.getByRole('region', { name: '프로젝트별 생산 차수 및 마감', exact: true }) }
}

test('프로젝트 차수의 실제 입고와 단가로 마감을 확정하고 과거 금액을 잠가 보관한다', async ({ page }) => {
  await fixture(page)
  const { ledger } = await open(page)
  await expect(ledger.locator('.ledger-summary')).toContainText('100원')
  await ledger.getByRole('button', { name: '실입고 추가', exact: true }).click()
  await ledger.getByLabel('차수 실입고일', { exact: true }).fill('2026-10-25')
  await ledger.getByLabel('추가 실입고 S', { exact: true }).fill('4')
  await ledger.getByLabel('실입고 등록 사유', { exact: true }).fill('QA 실제 차수 입고')
  await ledger.getByRole('button', { name: '실입고 저장', exact: true }).click()
  await expect(ledger.getByRole('status')).toContainText('실제 입고를 기록')
  await ledger.getByLabel('생산 마감 사유', { exact: true }).fill('QA 차수 마감 확정')
  await ledger.getByLabel('생산 마감 확정 확인', { exact: true }).check()
  await ledger.getByRole('button', { name: '마감 확정', exact: true }).click()
  await expect(ledger.getByRole('button', { name: '확정 을지 다운로드', exact: true })).toBeVisible()
  await expect(ledger.getByRole('button', { name: '차수 수정', exact: true })).toHaveCount(0)
  await expect(ledger.locator('.ledger-summary')).toContainText('400원')
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE)
  expect(stored.productionRuns[0].snapshot).toMatchObject({ unitCost: 100, receivedQuantity: 4, netAmount: 400, factory: 'QA 확정 공장', owner: 'QA 확정 담당자' })
  expect(stored.styles[0].production[0].received.S).toBe(999)
  const pending = page.waitForEvent('download')
  await ledger.getByRole('button', { name: '확정 을지 다운로드', exact: true }).click()
  const download = await pending, workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await readFile((await download.path())!))
  expect(workbook.worksheets[0].getCell('N3').value).toBe(100)
  expect(workbook.worksheets[0].getCell('R3').value).toBe(4)
  expect(workbook.worksheets[0].getCell('T3').value).toBe(400)
})

test('전체 을지에서 같은 품번의 차수별 과거 단가를 보존하고 외부 공장에는 단가 탭을 표시하지 않는다', async ({ page }) => {
  await fixture(page, true)
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '결제 · 마감', exact: true }).click()
  await page.getByLabel('스타일 검색', { exact: true }).fill(CODE)
  await page.getByRole('button', { name: '을지 양식 다운로드', exact: true }).click()
  const modal = page.getByRole('dialog', { name: '마감 양식에 채워서 다운로드', exact: true })
  const pending = page.waitForEvent('download')
  await modal.getByRole('button', { name: '을지 다운로드', exact: true }).click()
  const download = await pending, workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await readFile((await download.path())!))
  expect(workbook.worksheets[0].getCell('N3').value).toBe(100)
  expect(workbook.worksheets[0].getCell('N4').value).toBe(200)
  expect(workbook.worksheets[0].getCell('T3').value).toBe(400)
  expect(workbook.worksheets[0].getCell('T4').value).toBe(800)
  await modal.getByLabel('닫기', { exact: true }).click()
  await page.getByLabel('체험 역할').selectOption(FACTORY)
  await page.getByLabel('스타일 검색', { exact: true }).fill(CODE)
  await page.locator('.style-code').filter({ hasText: CODE }).first().click()
  const detail = page.getByRole('dialog').filter({ has: page.getByRole('heading', { level: 1 }) })
  await expect(detail.getByRole('tab', { name: /생산 차수·마감/ })).toHaveCount(0)
  await expect(detail.getByRole('tab', { name: /을지·단가/ })).toHaveCount(0)
  await expect(detail.getByRole('tab', { name: /업체 납기·동의/ })).toBeVisible()
})

test('동일 품번을 새 프로젝트의 별도 생산 차수로 등록하고 이전 차수 수량을 보존한다', async ({ page }) => {
  await fixture(page)
  const before = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE)
  const project = before.projects.find((item: { id: string }) => item.id !== before.styles[0].projectId)
  const { ledger } = await open(page)
  await ledger.getByRole('button', { name: '생산 차수 추가', exact: true }).click()
  await ledger.getByLabel('생산 차수명', { exact: true }).fill('QA 다른 프로젝트 리오더')
  await ledger.getByLabel('생산 차수 프로젝트', { exact: true }).selectOption(project.id)
  await ledger.getByLabel('생산 차수 프로젝트 코드', { exact: true }).fill('QA-SECOND-PROJECT-2026')
  await ledger.getByLabel('생산 차수 단가', { exact: true }).fill('225')
  await ledger.getByLabel('차수 오더 S', { exact: true }).fill('25')
  await ledger.getByLabel('생산 차수 변경 사유', { exact: true }).fill('QA 다른 프로젝트 독립 리오더')
  await ledger.getByRole('button', { name: '차수 저장', exact: true }).click()
  await expect(ledger.getByRole('status')).toContainText('생산 차수를 저장')
  const after = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE)
  expect(after.productionRuns).toHaveLength(2)
  expect(after.productionRuns.find((item: { id: string }) => item.id === before.productionRuns[0].id)).toEqual(before.productionRuns[0])
  expect(after.productionRuns.find((item: { projectId: string }) => item.projectId === project.id)).toMatchObject({ projectCode: 'QA-SECOND-PROJECT-2026', unitCost: 225, order: { S: 25 }, round: 1 })
  expect(after.styles).toEqual(before.styles)
})

test('프로젝트 B로 필터한 을지에는 같은 품번의 미확정 A 차수를 포함하지 않는다', async ({ page }) => {
  await fixture(page, true)
  const selectedProject = await page.evaluate(key => {
    const workspace = JSON.parse(localStorage.getItem(key)!), style = workspace.styles[0]
    const projectB = workspace.projects.find((project: { id: string }) => project.id !== style.projectId)
    projectB.code = 'QA-PROJECT-B'; projectB.name = 'QA 을지 프로젝트 B'
    const [runA, runB] = workspace.productionRuns
    runA.closedAt = null; runA.snapshot = null
    runB.projectId = projectB.id; runB.projectCode = projectB.code; runB.round = 1
    runB.snapshot.projectId = projectB.id; runB.snapshot.projectCode = projectB.code; runB.snapshot.round = 1
    style.projectId = projectB.id
    localStorage.setItem(key, JSON.stringify(workspace))
    return `${projectB.code} · ${projectB.name}`
  }, STORAGE)
  await page.reload()
  await page.getByRole('button', { name: '프로젝트 필터', exact: true }).click()
  const filter = page.getByRole('dialog', { name: '프로젝트 필터 선택', exact: true })
  await filter.getByRole('button', { name: '선택해제', exact: true }).click()
  await filter.getByRole('checkbox', { name: selectedProject, exact: true }).check()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '다운로드', exact: true }).click()
  await page.getByRole('button', { name: '을지 양식 다운로드', exact: true }).click()
  const modal = page.getByRole('dialog', { name: '마감 양식에 채워서 다운로드', exact: true })
  await expect(modal.getByRole('alert')).toHaveCount(0)
  const pending = page.waitForEvent('download')
  await modal.getByRole('button', { name: '을지 다운로드', exact: true }).click()
  const download = await pending, workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await readFile((await download.path())!))
  const sheet = workbook.worksheets[0]
  expect(sheet.getCell('A3').value).toBe('QA-PROJECT-B')
  expect(sheet.getCell('N3').value).toBe(200); expect(sheet.getCell('T3').value).toBe(800)
  expect(sheet.getCell('I4').value).toBeNull()
})
