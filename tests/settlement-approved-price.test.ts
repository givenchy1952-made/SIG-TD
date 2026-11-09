import { describe, expect, it } from 'vitest'
import { createSeed } from '../src/lib/seed'
import { emptyQuantities, type Workspace } from '../src/lib/types'
import type { ProductionRun, ProductionSettlementSnapshot } from '../src/lib/production-ledger'
import type { ProductionCondition } from '../src/lib/production-conditions'
import { resolveApprovedSettlementPrice } from '../src/lib/settlement-approved-price'
import { buildSigEuljiRows } from '../src/lib/sig-eulji'
import { buildProductionRunEuljiRows } from '../src/lib/production-ledger-export'

function fixture() {
  const workspace: Workspace = { ...createSeed(), settlementTermsAvailable: true, productionLedgerAvailable: true, productionConditionsAvailable: true, productionRuns: [], productionReceipts: [], productionConditions: [] }
  const style = workspace.styles[0], line = style.production[0], actor = workspace.profiles.find(person => person.role === 'admin')!
  const run: ProductionRun = { id: crypto.randomUUID(), styleId: style.id, lineId: line.id, projectId: style.projectId, projectCode: 'QA-APPROVED-A', name: 'QA 승인 생산', round: 1, expectedDue: '2026-11-20', poId: null, unitCost: 15.25, itemType: 'product', order: { ...emptyQuantities(), M: 10 }, correctsRunId: null, factoryIdSnapshot: style.factoryId, ownerIdSnapshot: style.ownerId, styleCodeSnapshot: `${style.code}${line.color}`, factoryNameSnapshot: 'QA 승인 공장', ownerNameSnapshot: 'QA 승인 담당자', version: 3, createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', updatedBy: actor.id, closedAt: null, snapshot: null }
  const condition: ProductionCondition = { runId: run.id, runVersion: run.version, poVersion: null, version: 2, productionMode: 'full_package', status: 'approved', legacy: false, internalUnitCost: 123, proposal: null, approval: { id: crypto.randomUUID(), finalDeliveryDate: '2026-11-20', unitCost: run.unitCost!, approvedBy: actor.id, approvedByName: actor.name, approvedAt: '2026-11-09T00:00:00Z', termsSnapshot: { runId: run.id, styleId: style.id, lineId: line.id, projectId: style.projectId }, poSnapshot: {} }, timeline: [], changeRequests: [] }
  workspace.productionRuns = [run]; workspace.productionConditions = [condition]
  workspace.settlementTerms = [{ styleId: style.id, lineId: line.id, projectCode: 'OLD-MANUAL', unitCost: 999, itemType: 'label', version: 1, createdAt: '', updatedAt: '', updatedBy: actor.id }]
  return { workspace, style, line, run, condition, actor }
}
const resolve = (f: ReturnType<typeof fixture>, selection: { projectId?: string; runId?: string } = {}) => resolveApprovedSettlementPrice(f.workspace, f.style.id, f.line.id, selection)
function close(f: ReturnType<typeof fixture>): ProductionSettlementSnapshot {
  const receipt = { id: crypto.randomUUID(), runId: f.run.id, styleId: f.style.id, lineId: f.line.id, receivedAt: '2026-11-09', quantities: { ...emptyQuantities(), M: 3 }, unitCost: 15.25, netAmount: 45.75, voided: false, version: 1, createdAt: '', createdBy: f.actor.id }
  const snapshot: ProductionSettlementSnapshot = { ...f.run, projectId: f.run.projectId, styleCode: f.run.styleCodeSnapshot, factory: f.run.factoryNameSnapshot, owner: f.run.ownerNameSnapshot, unitCost: 15.25, orderQuantity: 10, receivedQuantity: 3, netAmount: 45.75, vatAmount: 4.575, grossAmount: 50.325, lastReceivedAt: receipt.receivedAt, receipts: [receipt], finalizedAt: '2026-11-09T00:00:00Z', finalizedBy: f.actor.id }
  f.run.closedAt = snapshot.finalizedAt; f.run.snapshot = snapshot; f.workspace.productionReceipts = [receipt]
  return snapshot
}

describe('을지 단가의 최종 승인 자동 연결', () => {
  it('수동 을지 정보와 내부 검토 단가보다 같은 차수의 최종 승인 단가를 우선한다', () => {
    const f = fixture(), before = structuredClone(f.workspace)
    expect(resolve(f)).toMatchObject({ managed: true, status: 'approved', unitCost: 15.25, projectCode: 'QA-APPROVED-A', itemType: 'product', run: { id: f.run.id } })
    expect(f.workspace).toEqual(before)
    f.workspace.settlementTerms = []
    expect(resolve(f).unitCost).toBe(15.25)
  })
  it('승인되지 않은 제안·본사 검토 단가와 기존 수동 가격을 확정 가격으로 사용하지 않는다', () => {
    const f = fixture(); f.condition.approval = null; f.condition.status = 'awaiting_approval'; f.run.unitCost = null
    expect(resolve(f)).toMatchObject({ status: 'pending', unitCost: null })
    f.condition.legacy = true
    expect(resolve(f)).toMatchObject({ status: 'legacy', unitCost: null })
  })
  it('명시한 최종 승인 0원도 누락으로 처리하지 않는다', () => {
    const f = fixture(); f.run.unitCost = 0; f.condition.approval!.unitCost = 0
    expect(resolve(f)).toMatchObject({ status: 'approved', unitCost: 0 })
  })
  it('승인 금액이나 승인에 기록된 프로젝트·컬러 연결이 다르면 자동 확정을 거부한다', () => {
    const f = fixture(); f.condition.approval!.unitCost = 10
    expect(resolve(f)).toMatchObject({ status: 'inconsistent', unitCost: null })
    f.condition.approval!.unitCost = 15.25; f.condition.approval!.termsSnapshot.lineId = crypto.randomUUID()
    expect(resolve(f)).toMatchObject({ status: 'inconsistent', unitCost: null })
  })
  it('여러 차수는 임의로 선택하지 않으며 명시 선택한 차수만 사용한다', () => {
    const f = fixture(), second = { ...structuredClone(f.run), id: crypto.randomUUID(), round: 2, unitCost: 41.75 }
    f.workspace.productionRuns!.push(second)
    f.workspace.productionConditions!.push({ ...structuredClone(f.condition), runId: second.id, approval: { ...structuredClone(f.condition.approval!), unitCost: second.unitCost, termsSnapshot: { ...f.condition.approval!.termsSnapshot, runId: second.id } } })
    expect(resolve(f)).toMatchObject({ status: 'ambiguous', unitCost: null })
    expect(resolve(f, { runId: second.id })).toMatchObject({ status: 'approved', unitCost: 41.75, run: { id: second.id } })
  })
  it('같은 컬러의 다른 프로젝트와 다른 컬러의 차수를 섞지 않는다', () => {
    const f = fixture(), projectId = crypto.randomUUID(), second = { ...structuredClone(f.run), id: crypto.randomUUID(), projectId, projectCode: 'QA-B', unitCost: 99 }
    f.workspace.productionRuns!.push(second)
    f.workspace.productionConditions!.push({ ...structuredClone(f.condition), runId: second.id, approval: { ...structuredClone(f.condition.approval!), unitCost: 99, termsSnapshot: { runId: second.id, styleId: second.styleId, lineId: second.lineId, projectId } } })
    expect(resolve(f)).toMatchObject({ unitCost: 15.25, projectId: f.run.projectId })
    expect(resolve(f, { projectId })).toMatchObject({ unitCost: 99, projectCode: 'QA-B' })
    expect(resolve(f, { projectId: f.run.projectId, runId: second.id })).toMatchObject({ status: 'missing', unitCost: null })
    const otherLine = f.style.production.find(line => line.id !== f.line.id)!
    expect(resolveApprovedSettlementPrice(f.workspace, f.style.id, otherLine.id, { runId: f.run.id })).toMatchObject({ managed: false, status: 'manual', unitCost: null })
  })
  it('마감 확정 단가와 실제 을지는 현재 차수·수동 가격이 바뀌어도 동결 값을 사용한다', () => {
    const f = fixture(), snapshot = close(f)
    f.run.unitCost = 600; f.condition.approval!.unitCost = 600; f.run.projectCode = 'CHANGED'
    expect(resolve(f)).toMatchObject({ status: 'closed', unitCost: 15.25, projectCode: snapshot.projectCode })
    const exported = buildProductionRunEuljiRows(f.workspace, [f.run.id], f.actor)
    expect(exported.errors).toEqual([])
    expect(exported.rows[0]).toMatchObject({ unitCost: 15.25, receivedQuantity: 3, netAmount: 45.75 })
    expect(buildSigEuljiRows(f.workspace, [{ ...f.style, production: [f.line] }], f.actor).errors[0]).toContain('확정한 차수 기준')
    f.run.projectId = crypto.randomUUID()
    expect(resolve(f, { projectId: snapshot.projectId })).toMatchObject({ status: 'closed', projectId: snapshot.projectId, unitCost: 15.25 })
    f.run.snapshot = null
    expect(resolve(f, { projectId: f.run.projectId })).toMatchObject({ status: 'inconsistent', unitCost: null })
  })
  it('관리형 차수가 없는 기존 스타일은 수동 정산 호환을 유지한다', () => {
    const f = fixture(); f.workspace.productionRuns = []
    expect(resolve(f)).toMatchObject({ managed: false, status: 'manual', unitCost: null })
    expect(f.workspace.settlementTerms?.[0].unitCost).toBe(999)
  })
})
