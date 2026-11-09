import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { emptyQuantities, type Style, type Workspace } from '../src/lib/types'
import { freshOperations, saveShipmentInWorkspace } from '../src/lib/operations-domain'
import { finalizeProductionRunInWorkspace, saveProductionRunInWorkspace } from '../src/lib/production-ledger'
import { confirmMainProductionReceiptInWorkspace, saveMainProductionStyleInWorkspace, scopeProductionMovementsWorkspace } from '../src/lib/production-movements'
import type { ConfirmMainProductionReceiptRequest, ProductionMovementFields } from '../src/lib/production-movements-types'

type W = Workspace & ProductionMovementFields
const quantities = (M: number) => ({ ...emptyQuantities(), M })
const reason = '메인 생산 사이즈별 수량 확인'
function fixture() {
  let w: W = { ...createSeed({ includeFinance: true }), operations: freshOperations(), mainProductionSyncAvailable: true, shipmentAdjustments: [], productionRuns: [], productionReceipts: [], productionRunAudits: [], productionLedgerAvailable: true }
  const style = w.styles[1], admin = w.profiles.find(item => item.id === DEMO_IDS.admin)!, factory = w.profiles.find(item => item.id === DEMO_IDS.factory)!, internal = w.profiles.find(item => item.id === DEMO_IDS.internal)!, finance = w.profiles.find(item => item.role === 'finance')!
  for (const line of style.production) { line.shipped = quantities(0); line.received = quantities(0); line.order = quantities(500); line.shippedAt = ''; line.receivedAt = '' }
  w.projects.find(project => project.id === style.projectId)!.code = 'QA-PROJECT'
  const runId = crypto.randomUUID(), lineId = style.production[0].id
  w = saveProductionRunInWorkspace(w, admin, runId, style.id, lineId, { name: '입고 자동 연결 검증', projectId: style.projectId, projectCode: 'QA-PROJECT', expectedDue: '', poId: null, unitCost: 1250.25, itemType: 'product', order: quantities(500), correctsRunId: null }, 0, reason)
  return { w, styleId: style.id, lineId, runId, admin, factory, internal, finance }
}
const currentStyle = (w: W, id: string): Style => structuredClone(w.styles.find(item => item.id === id)!)
function request(f: ReturnType<typeof fixture>, w = f.w, total = 250): ConfirmMainProductionReceiptRequest {
  const style = currentStyle(w, f.styleId), line = style.production.find(item => item.id === f.lineId)!
  line.received = quantities(total); line.receivedAt = '2026-11-09'
  return { requestId: crypto.randomUUID(), styleId: f.styleId, lineId: f.lineId, runId: f.runId, expectedStyleVersion: style.version, expectedRunVersion: w.productionRuns!.find(item => item.id === f.runId)!.version, style }
}
function shipped(f: ReturnType<typeof fixture>, total: number, w = f.w, at = '2026-11-09') {
  const style = currentStyle(w, f.styleId), line = style.production.find(item => item.id === f.lineId)!
  line.shipped = quantities(total); line.shippedAt = at
  return style
}

describe('메인 생산 출고 수량 단일 입력', () => {
  it('사이즈별 누적 출고 수량을 한 번 저장하고 이중 합산하지 않는다', () => {
    const f = fixture(), before = structuredClone(f.w)
    const next = saveMainProductionStyleInWorkspace(f.w, f.admin, shipped(f, 250), reason)
    expect(next.styles.find(item => item.id === f.styleId)?.production[0].shipped).toEqual(quantities(250))
    expect(next.shipmentAdjustments).toHaveLength(1)
    expect(next.shipmentAdjustments?.[0]).toMatchObject({ delta: quantities(250), shippedAt: '2026-11-09', reason })
    expect(next.operations?.shipmentLedgers[0].baselineQuantities).toEqual(quantities(0))
    expect(next.operations?.shipmentBatches).toEqual([])
    expect(f.w).toEqual(before)
  })
  it('기존 이전출고 250+차수250을 누적250으로 정정해도 과거 두 기록을 보존한다', () => {
    const f = fixture()
    const originalStyle = f.w.styles.find(item => item.id === f.styleId)!
    originalStyle.production[0].shipped = quantities(250); originalStyle.production[0].shippedAt = '2026-11-08'
    const withBatch = saveShipmentInWorkspace(f.w, f.admin, crypto.randomUUID(), f.styleId, f.lineId, { shippedAt: '2026-11-09', quantities: quantities(250), tracking: '', note: '기존 차수 출고', voided: false }, 0, originalStyle.version, reason)
    const before = structuredClone(withBatch)
    const next = saveMainProductionStyleInWorkspace(withBatch, f.admin, shipped(f, 250, withBatch), reason)
    expect(next.styles.find(item => item.id === f.styleId)?.production[0].shipped.M).toBe(250)
    expect(next.shipmentAdjustments?.[0].delta.M).toBe(-250)
    expect(next.operations?.shipmentLedgers).toEqual(before.operations?.shipmentLedgers)
    expect(next.operations?.shipmentBatches).toEqual(before.operations?.shipmentBatches)
    expect(withBatch).toEqual(before)
  })
  it('재수정은 차이만 이력에 남기고 출고일을 직접 수정한다', () => {
    const f = fixture(), first = saveMainProductionStyleInWorkspace(f.w, f.admin, shipped(f, 250), reason)
    const second = saveMainProductionStyleInWorkspace(first, f.admin, shipped(f, 300, first, '2026-11-08'), reason)
    expect(second.shipmentAdjustments?.map(item => item.delta.M)).toEqual([250, 50])
    expect(second.styles.find(item => item.id === f.styleId)?.production[0]).toMatchObject({ shipped: quantities(300), shippedAt: '2026-11-08' })
    const unchanged = saveMainProductionStyleInWorkspace(second, f.admin, currentStyle(second, f.styleId), reason)
    expect(unchanged.shipmentAdjustments).toEqual(second.shipmentAdjustments)
  })
  it('배정된 공장만 출고하고 본사 직원·미배정 공장·위조 역할은 권한을 얻지 못한다', () => {
    const f = fixture(), draft = shipped(f, 250)
    expect(() => saveMainProductionStyleInWorkspace(f.w, f.factory, draft, reason)).not.toThrow()
    expect(() => saveMainProductionStyleInWorkspace(f.w, { ...f.internal, role: 'admin' }, draft, reason)).toThrow(/출고/)
    const unassigned = structuredClone(f.w); unassigned.profiles.find(item => item.id === f.factory.id)!.factoryId = DEMO_IDS.korea
    expect(() => saveMainProductionStyleInWorkspace(unassigned, f.factory, draft, reason)).toThrow(/접근/)
    expect(() => saveMainProductionStyleInWorkspace(f.w, f.finance, draft, reason)).toThrow(/FA팀/)
  })
  it('스타일 충돌·설정 누락·잘못된 날짜의 입력은 저장하지 않는다', () => {
    const f = fixture(), before = structuredClone(f.w), stale = shipped(f, 250)
    stale.version -= 1
    expect(() => saveMainProductionStyleInWorkspace(f.w, f.admin, stale, reason)).toThrow(/VERSION_CONFLICT/)
    expect(() => saveMainProductionStyleInWorkspace({ ...f.w, mainProductionSyncAvailable: false }, f.admin, shipped(f, 250), reason)).toThrow(/설정/)
    expect(() => saveMainProductionStyleInWorkspace(f.w, f.admin, shipped(f, 250, f.w, '2026-11-31'), reason)).toThrow(/날짜/)
    expect(f.w).toEqual(before)
  })
  it('본사 저장은 유일한 공장 담당자를 현재 스타일에 연결하고 기존 차수 담당자 기록을 유지한다', () => {
    const f = fixture(), before = structuredClone(f.w.productionRuns)
    f.w.operations!.employeeFactoryAssignments = [{ employeeId: f.internal.id, factoryIds: [f.w.styles.find(style => style.id === f.styleId)!.factoryId], version: 1, createdAt: '', updatedAt: '', updatedBy: f.admin.id }]
    const next = saveMainProductionStyleInWorkspace(f.w, f.admin, shipped(f, 250), reason)
    expect(next.styles.find(style => style.id === f.styleId)).toMatchObject({ ownerId: f.internal.id })
    expect(next.styles.find(style => style.id === f.styleId)?.production.every(line => line.ownerId === f.internal.id)).toBe(true)
    expect(next.productionRuns).toEqual(before)
  })
})

describe('메인 실입고 확정과 생산 차수 자동 연결', () => {
  it('입고 확정 한 번으로 부모 누적 수량과 차수 실제 입고·단가를 함께 저장한다', () => {
    const f = fixture(), before = structuredClone(f.w), value = request(f)
    const applied = confirmMainProductionReceiptInWorkspace(f.w, f.admin, value, reason)
    expect(applied.result).toMatchObject({ receiptId: value.requestId, added: quantities(250), runVersion: 2 })
    expect(applied.result.style.production[0]).toMatchObject({ received: quantities(250), receivedAt: '2026-11-09' })
    expect(applied.result.style.version).toBe(value.expectedStyleVersion + 1)
    expect(applied.workspace.productionReceipts).toHaveLength(1)
    expect(applied.workspace.productionReceipts?.[0]).toMatchObject({ quantities: quantities(250), unitCost: 1250.25, netAmount: 312562.5 })
    expect(f.w).toEqual(before)
  })
  it('이전에 메인에 입력한 누적250을 차수에 처음 연결할 때 한 번만 따라잡는다', () => {
    const f = fixture(); f.w.styles.find(style => style.id === f.styleId)!.production[0].received = quantities(250)
    const value = request(f), first = confirmMainProductionReceiptInWorkspace(f.w, f.admin, value, reason)
    const retry = confirmMainProductionReceiptInWorkspace(first.workspace, f.admin, value, reason)
    expect(retry.result).toEqual(first.result)
    expect(retry.workspace.productionReceipts).toHaveLength(1)
    const second = confirmMainProductionReceiptInWorkspace(first.workspace, f.admin, request(f, first.workspace), reason)
    expect(second.result.added).toEqual(quantities(0))
    expect(second.result.receiptId).toBeNull()
    expect(second.workspace.productionReceipts).toHaveLength(1)
  })
  it('부분 입고 누적250 이후 누적300을 확정하면 추가50만 기록한다', () => {
    const f = fixture(), first = confirmMainProductionReceiptInWorkspace(f.w, f.admin, request(f), reason)
    const second = confirmMainProductionReceiptInWorkspace(first.workspace, f.admin, request(f, first.workspace, 300), reason)
    expect(second.result.added).toEqual(quantities(50))
    expect(second.workspace.productionReceipts?.map(item => item.quantities.M)).toEqual([250, 50])
    expect(second.result.style.production[0].received.M).toBe(300)
    expect(second.workspace.productionReceipts?.every(item => item.unitCost === 1250.25)).toBe(true)
  })
  it('일반 저장으로 입고 확정을 우회하지 못하지만 차수가 없는 기존 입력은 유지한다', () => {
    const f = fixture(), value = request(f)
    expect(() => saveMainProductionStyleInWorkspace(f.w, f.admin, value.style, reason)).toThrow(/입고 확정/)
    expect(() => saveMainProductionStyleInWorkspace({ ...f.w, productionRuns: [] }, f.admin, value.style, reason)).not.toThrow()
  })
  it('같은 확정 요청 ID를 다른 수량이나 사유로 재사용하지 못한다', () => {
    const f = fixture(), value = request(f), first = confirmMainProductionReceiptInWorkspace(f.w, f.admin, value, reason)
    const changed = structuredClone(value); changed.style.production[0].received = quantities(300)
    expect(() => confirmMainProductionReceiptInWorkspace(first.workspace, f.admin, changed, reason)).toThrow(/같은 입고 요청 ID/)
    expect(() => confirmMainProductionReceiptInWorkspace(first.workspace, f.admin, value, '다른 변경 사유')).toThrow(/같은 입고 요청 ID/)
  })
  it('관리자·최종승인·미마감·현재 스타일/차수 버전과 정확한 컬러 연결을 요구한다', () => {
    const f = fixture(), value = request(f)
    for (const person of [f.internal, f.factory, f.finance]) expect(() => confirmMainProductionReceiptInWorkspace(f.w, person, value, reason)).toThrow()
    const staleStyle = structuredClone(value); staleStyle.expectedStyleVersion += 1; staleStyle.style.version += 1
    expect(() => confirmMainProductionReceiptInWorkspace(f.w, f.admin, staleStyle, reason)).toThrow(/VERSION_CONFLICT/)
    expect(() => confirmMainProductionReceiptInWorkspace(f.w, f.admin, { ...value, expectedRunVersion: value.expectedRunVersion + 1 }, reason)).toThrow(/VERSION_CONFLICT/)
    expect(() => confirmMainProductionReceiptInWorkspace({ ...f.w, productionConditionsAvailable: true, productionConditions: [] }, f.admin, value, reason)).toThrow(/HQ_APPROVAL_REQUIRED/)
    expect(() => confirmMainProductionReceiptInWorkspace(f.w, f.admin, { ...value, lineId: f.w.styles.find(item => item.id === f.styleId)!.production[1].id }, reason)).toThrow(/차수/)
  })
  it('입고 취소가 필요한 감소와 오더 초과는 차수 이력을 수정하지 않는다', () => {
    const f = fixture(), first = confirmMainProductionReceiptInWorkspace(f.w, f.admin, request(f), reason), before = structuredClone(first.workspace)
    expect(() => confirmMainProductionReceiptInWorkspace(first.workspace, f.admin, request(f, first.workspace, 249), reason)).toThrow(/기록된 수량/)
    expect(() => confirmMainProductionReceiptInWorkspace(first.workspace, f.admin, request(f, first.workspace, 501), reason)).toThrow(/오더 수량/)
    expect(first.workspace).toEqual(before)
  })
  it('마감 확정된 차수의 입고·스냅샷은 다시 확정해도 바꾸지 않는다', () => {
    const f = fixture(), first = confirmMainProductionReceiptInWorkspace(f.w, f.admin, request(f), reason)
    const closed = finalizeProductionRunInWorkspace(first.workspace, f.admin, f.runId, first.result.runVersion, '기존 마감 확정'), before = structuredClone(closed)
    expect(() => confirmMainProductionReceiptInWorkspace(closed, f.admin, request(f, closed, 300), reason)).toThrow(/미마감/)
    expect(closed).toEqual(before)
  })
  it('뒤늦은 다른 컬러 입력·권한·값 오류에서도 입고와 출고 이력을 전부 원복한다', () => {
    const f = fixture(), value = request(f), before = structuredClone(f.w)
    value.style.production[0].shipped = quantities(250); value.style.production[0].shippedAt = '2026-11-09'
    value.style.production[1].received = quantities(1)
    expect(() => confirmMainProductionReceiptInWorkspace(f.w, f.admin, value, reason)).toThrow(/다른 컬러/)
    expect(f.w).toEqual(before)
    const invalid = request(f); invalid.style.production[0].invoiceAmount = -1
    expect(() => confirmMainProductionReceiptInWorkspace(f.w, f.admin, invalid, reason)).toThrow(/금액/)
    expect(f.w).toEqual(before)
  })
  it('공장에는 배정 스타일 출고 연결 정보만 투영하고 재시도·FA 자료는 노출하지 않는다', () => {
    const f = fixture(), next = saveMainProductionStyleInWorkspace(f.w, f.admin, shipped(f, 250), reason)
    next.shipmentAdjustments!.push({ ...next.shipmentAdjustments![0], id: crypto.randomUUID(), styleId: next.styles.find(style => style.factoryId !== f.factory.factoryId)!.id })
    const scoped = scopeProductionMovementsWorkspace(next, f.factory)
    expect(scoped.shipmentAdjustments).toHaveLength(1)
    expect(scoped).not.toHaveProperty('productionMovementRequests')
    expect(scopeProductionMovementsWorkspace(next, f.finance)).toEqual({ mainProductionSyncAvailable: false, shipmentAdjustments: [] })
  })
})
