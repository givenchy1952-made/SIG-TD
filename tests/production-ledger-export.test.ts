import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { emptyQuantities } from '../src/lib/types'
import type { ProductionLedgerWorkspace, ProductionReceipt, ProductionRun, ProductionSettlementSnapshot } from '../src/lib/production-ledger'
import { buildFrozenProductionEuljiRows, buildProductionRunEuljiRows } from '../src/lib/production-ledger-export'
import { fillSigEuljiTemplate } from '../src/lib/sig-eulji'

function fixture() {
  const workspace: ProductionLedgerWorkspace = createSeed(), actor = workspace.profiles.find(item => item.id === DEMO_IDS.admin)!
  const style = workspace.styles[0], line = style.production[0]
  const receipt: ProductionReceipt = { id: crypto.randomUUID(), runId: crypto.randomUUID(), styleId: style.id, lineId: line.id, receivedAt: '2026-10-25', quantities: { ...emptyQuantities(), S: 4 }, unitCost: 10.25, netAmount: 41, version: 1, voided: false, createdAt: '2026-10-25T00:00:00Z', createdBy: actor.id }
  const identity = { factoryIdSnapshot: style.factoryId, ownerIdSnapshot: style.ownerId, styleCodeSnapshot: 'BP06FYDW0101BK', factoryNameSnapshot: '확정 당시 공장', ownerNameSnapshot: '확정 당시 담당자' }
  const snapshot: ProductionSettlementSnapshot = { ...identity, projectId: style.projectId, projectCode: 'SIGNIFICANT-2026FY-RPQ-12345', expectedDue: '2026-10-25', styleCode: identity.styleCodeSnapshot, factory: identity.factoryNameSnapshot, owner: identity.ownerNameSnapshot, name: '첫 생산', round: 1, poId: null, itemType: 'product', unitCost: 10.25, orderQuantity: 10, receivedQuantity: 4, netAmount: 41, vatAmount: 4.1, grossAmount: 45.1, lastReceivedAt: '2026-10-25', receipts: [receipt], finalizedAt: '2026-10-25T00:00:00Z', finalizedBy: actor.id }
  const run: ProductionRun = { ...identity, id: receipt.runId, styleId: style.id, lineId: line.id, name: '첫 생산', projectId: style.projectId, projectCode: snapshot.projectCode, expectedDue: snapshot.expectedDue, poId: null, unitCost: 10.25, itemType: 'product', order: { ...emptyQuantities(), S: 10 }, correctsRunId: null, round: 1, version: 3, createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z', updatedBy: actor.id, closedAt: snapshot.finalizedAt, snapshot }
  workspace.productionRuns = [run]; workspace.productionReceipts = [receipt]; workspace.productionLedgerAvailable = true
  return { workspace, actor, run, snapshot, style }
}

describe('차수 마감 확정 을지', () => {
  it('현재 스타일·프로젝트·단가·업체가 바뀌어도 확정된 값을 사용한다', () => {
    const { workspace, actor, run, style } = fixture()
    style.code = 'CHANGED'; style.projectId = 'new-project'; style.factoryId = 'new-factory'; style.ownerId = 'new-owner'
    run.unitCost = 999; run.projectCode = 'changed-current'; run.order.S = 999
    workspace.productionReceipts = []
    const result = buildProductionRunEuljiRows(workspace, [run.id, run.id], actor)
    expect(result.errors).toEqual([])
    const project = workspace.projects.find(item => item.id === run.snapshot!.projectId)!
    expect(result.rows).toEqual([{ projectId: project.id, projectName: project.name, season: project.season, projectCode: 'SIGNIFICANT-2026FY-RPQ-12345', receivedAtISO: '2026-10-25', factory: '확정 당시 공장', colorStyleCode: 'BP06FYDW0101BK', unitCost: 10.25, orderQuantity: 10, receivedQuantity: 4, unit: 'EA', netAmount: 41, owner: '확정 당시 담당자' }])
  })
  it('제공된 을지 양식의 단가·금액과 프로젝트·차수 입고를 실제 XLSX에 기록한다', async () => {
    const { workspace, actor, run } = fixture(), result = buildProductionRunEuljiRows(workspace, [run.id], actor)
    const bytes = await fillSigEuljiTemplate(new Uint8Array(await readFile(new URL('../src/assets/sig-eulji-template.xlsx', import.meta.url))), result.rows)
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes)
    const sheet = workbook.getWorksheet('대금지급(을)')!
    expect(sheet.getCell('A3').value).toBe('SIGNIFICANT-2026FY-RPQ-12345')
    expect(sheet.getCell('N3').value).toBe(10.25); expect(sheet.getCell('P3').value).toBe(10); expect(sheet.getCell('R3').value).toBe(4); expect(sheet.getCell('T3').value).toBe(41)
    expect(sheet.getCell('D3').value).toBe('확정 당시 공장'); expect(sheet.getCell('W3').value).toBe('확정 당시 담당자')
  })
  it('미확정 차수나 잘못된 스냅샷 금액을 다운로드하지 않는다', () => {
    const { workspace, actor, run, snapshot } = fixture()
    run.closedAt = null
    expect(buildProductionRunEuljiRows(workspace, [run.id], actor).rows).toHaveLength(0)
    run.closedAt = snapshot.finalizedAt; snapshot.netAmount = 999
    expect(buildProductionRunEuljiRows(workspace, [run.id], actor).errors).toHaveLength(1)
  })
  it('전체 을지에서도 관리 중인 컬러의 최신 단가를 재사용하지 않고 확정 차수별로 분리한다', () => {
    const { workspace, actor, run, style } = fixture()
    style.production = [style.production[0]]
    const reorder: ProductionRun = structuredClone(run)
    reorder.id = crypto.randomUUID(); reorder.round = 2; reorder.unitCost = 20.5
    reorder.snapshot!.round = 2; reorder.snapshot!.unitCost = 20.5; reorder.snapshot!.netAmount = 82
    reorder.snapshot!.receipts[0].unitCost = 20.5; reorder.snapshot!.receipts[0].netAmount = 82
    workspace.productionRuns!.push(reorder)
    workspace.settlementTermsAvailable = false
    const result = buildFrozenProductionEuljiRows(workspace, [style], actor)
    expect(result.errors).toEqual([])
    expect(result.rows.map(row => [row.unitCost, row.receivedQuantity, row.netAmount])).toEqual([[10.25, 4, 41], [20.5, 4, 82]])
    reorder.closedAt = null; reorder.snapshot = null
    const pending = buildFrozenProductionEuljiRows(workspace, [style], actor)
    expect(pending.errors).toHaveLength(1); expect(pending.rows).toHaveLength(1)
  })
  it('전체 을지에서 다른 컬러의 기존 마감 정보는 해당 컬러로만 유지한다', () => {
    const { workspace, actor, run, style } = fixture()
    const legacyLine = style.production.find(item => item.id !== run.lineId)!
    style.production = [style.production[0], legacyLine]
    legacyLine.receivedAt = '2026-10-25'; legacyLine.received = { ...emptyQuantities(), M: 2 }
    workspace.projects.find(item => item.id === style.projectId)!.code = 'SIGNIFICANT-2026FY-RPQ-12345'
    workspace.settlementTermsAvailable = true
    workspace.settlementTerms = [{ styleId: style.id, lineId: legacyLine.id, projectCode: 'SIGNIFICANT-2026FY-RPQ-12345', unitCost: 500, itemType: 'product', version: 1, createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z', updatedBy: actor.id }]
    const result = buildFrozenProductionEuljiRows(workspace, [style], actor)
    expect(result.errors).toEqual([])
    expect(result.rows.map(row => row.netAmount)).toEqual([41, 1000])
  })
  it('프로젝트 B 필터는 같은 품번의 프로젝트 A 차수를 포함하거나 A 미확정 때문에 차단하지 않는다', () => {
    const { workspace, actor, run, style } = fixture()
    style.production = [style.production[0]]
    const reorder = structuredClone(run), projectB = workspace.projects.find(item => item.id !== run.projectId)!
    reorder.id = crypto.randomUUID(); reorder.projectId = projectB.id; reorder.projectCode = 'PROJECT-B'
    reorder.snapshot!.projectId = projectB.id; reorder.snapshot!.projectCode = 'PROJECT-B'
    workspace.productionRuns!.push(reorder); style.projectId = projectB.id
    expect(buildFrozenProductionEuljiRows(workspace, [style], actor, { projectIds: [projectB.id] }).rows.map(row => row.projectCode)).toEqual(['PROJECT-B'])
    run.closedAt = null; run.snapshot = null
    const result = buildFrozenProductionEuljiRows(workspace, [style], actor, { projectIds: [projectB.id] })
    expect(result.errors).toEqual([]); expect(result.rows.map(row => row.projectCode)).toEqual(['PROJECT-B'])
  })
  it('프로젝트 선택을 모두 해제하면 이전 컬러 합계로 대체하지 않는다', () => {
    const { workspace, actor, style } = fixture()
    style.production = [style.production[0]]
    const result = buildFrozenProductionEuljiRows(workspace, [style], actor, { projectIds: [] })
    expect(result.rows).toEqual([]); expect(result.errors).not.toEqual([])
  })
  it('차수가 없는 기존 컬러도 자체 담당자·미지정 필터와 W 값을 따로 유지한다', () => {
    const { workspace, actor, style } = fixture()
    workspace.productionRuns = []
    style.production = style.production.slice(0, 2)
    style.production[0].ownerId = actor.id; style.production[1].ownerId = ''
    workspace.settlementTermsAvailable = true
    workspace.projects.find(item => item.id === style.projectId)!.code = 'LEGACY-PROJECT'
    workspace.settlementTerms = style.production.map(line => {
      line.receivedAt = '2026-10-25'; line.received = { ...emptyQuantities(), S: 3 }
      return { styleId: style.id, lineId: line.id, projectCode: 'LEGACY-PROJECT', unitCost: 100, itemType: 'product' as const, version: 1, createdAt: '', updatedAt: '', updatedBy: actor.id }
    })
    const assigned = buildFrozenProductionEuljiRows(workspace, [style], actor, { ownerIds: [actor.id] })
    expect(assigned.errors).toEqual([]); expect(assigned.rows).toHaveLength(1)
    expect(assigned.rows[0].owner).toBe(actor.name)
    const blank = buildFrozenProductionEuljiRows(workspace, [style], actor, { ownerIds: [''] })
    expect(blank.errors).toEqual([]); expect(blank.rows).toHaveLength(1)
    expect(blank.rows[0].owner).toBe('')
    expect(blank.rows[0].colorStyleCode).toBe(`${style.code}${style.production[1].color}`)
  })
  it.each(['factoryIds', 'ownerIds', 'seasons'] as const)('%s 필터도 현재 스타일 대신 차수의 업체·담당자·프로젝트 시즌으로 적용한다', field => {
    const { workspace, actor, run, style } = fixture()
    style.production = [style.production[0]]
    const next = structuredClone(run), project = workspace.projects.find(item => item.id !== run.projectId)!
    const factory = workspace.factories.find(item => item.id !== run.factoryIdSnapshot)!, owner = workspace.profiles.find(item => item.role === 'internal' && item.id !== run.ownerIdSnapshot)!
    project.season = 'QA-NEW-SEASON'
    next.id = crypto.randomUUID(); next.projectId = project.id; next.projectCode = 'FILTERED-RUN'
    next.factoryIdSnapshot = factory.id; next.ownerIdSnapshot = owner.id
    next.snapshot!.projectId = project.id; next.snapshot!.projectCode = 'FILTERED-RUN'
    next.snapshot!.factoryIdSnapshot = factory.id; next.snapshot!.ownerIdSnapshot = owner.id
    workspace.productionRuns!.push(next); run.closedAt = null; run.snapshot = null
    style.factoryId = factory.id; style.ownerId = owner.id; style.projectId = project.id; style.season = project.season
    const value = field === 'factoryIds' ? factory.id : field === 'ownerIds' ? owner.id : project.season
    const result = buildFrozenProductionEuljiRows(workspace, [style], actor, { [field]: [value] })
    expect(result.errors).toEqual([]); expect(result.rows.map(row => row.projectCode)).toEqual(['FILTERED-RUN'])
  })
  it('외부 공장·미승인 계정은 현재 역할을 위조해도 금액을 내보내지 못한다', () => {
    const { workspace, actor, run } = fixture(), factory = workspace.profiles.find(item => item.role === 'factory')!
    expect(buildProductionRunEuljiRows(workspace, [run.id], { ...factory, role: 'admin' }).rows).toEqual([])
    actor.approved = false
    expect(buildProductionRunEuljiRows(workspace, [run.id], { ...actor, approved: true }).rows).toEqual([])
  })
})
