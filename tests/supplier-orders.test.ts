import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { emptyQuantities } from '../src/lib/types'
import { EMPTY_OPERATIONS, type PoDispatch } from '../src/lib/operations-types'
import { saveProductionRunInWorkspace, allocateProductionReceiptInWorkspace, finalizeProductionRunInWorkspace, scopeProductionLedgerWorkspace } from '../src/lib/production-ledger'
import { acceptSupplierOrderInWorkspace, createProductionOrderPoInWorkspace, assertProductionRunStarted, getDemoSupplierProductionOrders, scopeSupplierOrders, startSupplierOrderInWorkspace, type SupplierOrderWorkspace } from '../src/lib/supplier-orders'

function fixture() {
  let workspace: SupplierOrderWorkspace = { ...createSeed(), operations: structuredClone(EMPTY_OPERATIONS), productionLedgerAvailable: true, supplierOrdersAvailable: true, productionRuns: [], productionReceipts: [], supplierProductionOrders: [] }
  const style = workspace.styles[1], line = style.production[0], admin = workspace.profiles.find(item => item.id === DEMO_IDS.admin)!, factory = workspace.profiles.find(item => item.id === DEMO_IDS.factory)!
  const po: PoDispatch = { id: crypto.randomUUID(), styleId: style.id, dueDate: '2026-12-10', recipient: 'factory@example.test', subject: '납기 2026-12-10 발주', body: '생산 발주 내용', evidenceAttachmentId: null, status: 'sent', sentAt: '2026-10-25T10:00:00Z', providerMessageId: 'provider-id', lastError: null, attempts: 1, idempotencyKey: 'test-idempotency', factoryIdSnapshot: style.factoryId, styleCodeSnapshot: style.code, voided: false, version: 3, createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z', updatedBy: admin.id }
  workspace.operations!.poDispatches = [po]
  const id = crypto.randomUUID(), input = { name: '리오더 1차', projectId: style.projectId, projectCode: 'TEST-PROJECT', expectedDue: '2026-12-10', poId: po.id, unitCost: 13000, itemType: 'product' as const, order: { ...emptyQuantities(), S: 10 }, correctsRunId: null }
  workspace = saveProductionRunInWorkspace(workspace, admin, id, style.id, line.id, input, 0, '프로젝트 차수 생성')
  workspace.supplierProductionOrders = getDemoSupplierProductionOrders(workspace)
  return { workspace, admin, factory, style, line, id, input, po }
}
describe('supplier production order domain', () => {
  it('PO 내용·수량·프로젝트·업체 동의 계정과 시각을 보존하고 가격은 공개하지 않는다', () => {
    const { workspace, factory, id } = fixture()
    const next = acceptSupplierOrderInWorkspace(workspace, factory, id, 1, 3, '2026-12-12', true)
    const order = getDemoSupplierProductionOrders(next)[0]
    expect(order.status).toBe('in_progress'); expect(order.runVersion).toBe(2)
    expect(order.acceptance).toMatchObject({ actorId: factory.id, actorEmail: factory.email, expectedDeliveryDate: '2026-12-12', runVersion: 1, poVersion: 3 })
    expect(order.acceptance?.termsSnapshot).toMatchObject({ order: { ...emptyQuantities(), S: 10 }, projectCode: 'TEST-PROJECT' })
    expect(order.acceptance?.poSnapshot).toMatchObject({ body: '생산 발주 내용', providerMessageId: 'provider-id', dueDate: '2026-12-10' })
    expect(JSON.stringify(order)).not.toContain('13000'); expect(getDemoSupplierProductionOrders(workspace)[0].acceptance).toBe(null)
  })
  it('공급자 동의 전 생산·실입고를 차단하고 동의와 동시에 생산을 시작한다', () => {
    const { workspace, factory, admin, id } = fixture()
    expect(() => assertProductionRunStarted(workspace, id)).toThrow(/생산 동의/)
    expect(() => allocateProductionReceiptInWorkspace(workspace, admin, crypto.randomUUID(), id, { receivedAt: '2026-12-13', quantities: { ...emptyQuantities(), S: 1 } }, 1, '실입고 기록')).toThrow(/생산 동의/)
    const agreed = acceptSupplierOrderInWorkspace(workspace, factory, id, 1, 3, '2026-12-12', true)
    expect(() => startSupplierOrderInWorkspace(agreed, factory, id, 2)).toThrow(/본사/)
    expect(() => startSupplierOrderInWorkspace(agreed, admin, id, 2)).toThrow(/생산 동의/)
    expect(getDemoSupplierProductionOrders(agreed)[0]).toMatchObject({ runVersion: 2, status: 'in_progress', startedBy: factory.id })
    expect(() => assertProductionRunStarted(agreed, id)).not.toThrow()
  })
  it('업체A·B 및 미승인·회수된 권한을 라이브 프로필 기준으로 확인한다', () => {
    const { workspace, factory, admin, id } = fixture()
    expect(() => acceptSupplierOrderInWorkspace(workspace, admin, id, 1, 3, '2026-12-12', true)).toThrow(/업체 계정/)
    const other = { ...factory, id: crypto.randomUUID(), factoryId: DEMO_IDS.korea }; workspace.profiles.push(other)
    expect(scopeSupplierOrders(workspace, other).supplierProductionOrders).toEqual([])
    expect(() => acceptSupplierOrderInWorkspace(workspace, other, id, 1, 3, '2026-12-12', true)).toThrow(/업체 계정/)
    workspace.profiles = workspace.profiles.map(item => item.id === factory.id ? { ...item, approved: false } : item)
    expect(() => acceptSupplierOrderInWorkspace(workspace, factory, id, 1, 3, '2026-12-12', true)).toThrow(/승인/)
  })
  it('날짜·명시적 동의·경합 버전·이미 동의한 이력 재작성 방지', () => {
    const { workspace, factory, id } = fixture()
    expect(() => acceptSupplierOrderInWorkspace(workspace, factory, id, 1, 3, '2026-12-12', false)).toThrow(/체크/)
    for (const date of ['', '2026-02-30', '2026-12-12 10:00']) expect(() => acceptSupplierOrderInWorkspace(workspace, factory, id, 1, 3, date, true)).toThrow(/납기일/)
    expect(() => acceptSupplierOrderInWorkspace(workspace, factory, id, 0, 3, '2026-12-12', true)).toThrow(/VERSION_CONFLICT/)
    expect(() => acceptSupplierOrderInWorkspace(workspace, factory, id, 1, 2, '2026-12-12', true)).toThrow(/VERSION_CONFLICT/)
    const agreed = acceptSupplierOrderInWorkspace(workspace, factory, id, 1, 3, '2026-12-12', true)
    expect(() => acceptSupplierOrderInWorkspace(agreed, factory, id, 2, 3, '2026-12-13', true)).toThrow(/변경할 수 없습니다/)
  })
  it('동의한 수량·납기를 변경할 수 없고 새로운 차수는 독립적으로 생성된다', () => {
    const { workspace, admin, factory, id, style, line, input } = fixture()
    const agreed = acceptSupplierOrderInWorkspace(workspace, factory, id, 1, 3, '2026-12-12', true)
    expect(() => saveProductionRunInWorkspace(agreed, admin, id, style.id, line.id, { ...input, order: { ...emptyQuantities(), S: 11 } }, 2, '수량 변경')).toThrow(/발송을 시도한/)
    const next = saveProductionRunInWorkspace(agreed, admin, crypto.randomUUID(), style.id, line.id, { ...input, poId: null }, 0, '리오더 신규 생성')
    expect(next.productionRuns).toHaveLength(2); expect(next.productionRuns?.[1].round).toBe(2)
    expect(getDemoSupplierProductionOrders(next).map(item => item.status)).toEqual(['in_progress', 'awaiting_po'])
  })
  it('PO 없는 차수의 초안을 본사만 생성·연결하며 실제 발송 상태는 바꾸지 않는다', () => {
    const { workspace, admin, factory, id } = fixture()
    workspace.productionRuns![0].poId = null; workspace.supplierProductionOrders = getDemoSupplierProductionOrders(workspace)
    const poId = crypto.randomUUID(), data = { dueDate: '2026-12-24', recipient: 'factory@example.test', subject: '새 차수 PO', body: '새 생산 요청', evidenceAttachmentId: null, voided: false }
    expect(() => createProductionOrderPoInWorkspace(workspace, factory, id, 1, poId, data, 'PO 작성')).toThrow(/본사/)
    const next = createProductionOrderPoInWorkspace(workspace, admin, id, 1, poId, data, 'PO 초안 작성')
    expect(getDemoSupplierProductionOrders(next)[0]).toMatchObject({ poId, poStatus: 'draft', status: 'awaiting_po', sentAt: null, runVersion: 2, expectedDue: '2026-12-24' })
    expect(scopeSupplierOrders({ ...next, supplierProductionOrders: getDemoSupplierProductionOrders(next) }, factory).supplierProductionOrders![0]).toMatchObject({ subject: '', body: '', requestedDue: '' })
    expect(workspace.productionRuns![0].poId).toBe(null)
  })
  it('본사 전용 ledger가 없는 공장용 서버 RPC 결과를 누락하지 않는다', () => {
    const { workspace, factory } = fixture(), serverOrders = getDemoSupplierProductionOrders(workspace)
    const cloudFactory = { ...workspace, productionRuns: [], productionLedgerAvailable: false, supplierProductionOrders: serverOrders }
    expect(scopeSupplierOrders(cloudFactory, factory).supplierProductionOrders).toHaveLength(1)
    expect(getDemoSupplierProductionOrders(cloudFactory)).toEqual(serverOrders)
  })
  it('새 프로젝트 공장 재배정 후에도 본사는 이전 업체가 동의한 차수의 입고·마감을 기록한다', () => {
    const { workspace, admin, factory, id, style, line, input } = fixture()
    let next = acceptSupplierOrderInWorkspace(workspace, factory, id, 1, 3, '2026-12-12', true)
    next.styles.find(item => item.id === style.id)!.factoryId = DEMO_IDS.korea
    const otherProject = next.projects.find(item => item.id !== style.projectId)!
    const newRunId = crypto.randomUUID(), factoryB = { ...factory, id: crypto.randomUUID(), factoryId: DEMO_IDS.korea }
    next.profiles.push(factoryB)
    next = saveProductionRunInWorkspace(next, admin, newRunId, style.id, line.id, { ...input, projectId: otherProject.id, projectCode: 'PROJECT-B', poId: null }, 0, '새 프로젝트 B 생산')
    next.supplierProductionOrders = getDemoSupplierProductionOrders(next)
    expect(next.supplierProductionOrders.find(item => item.runId === id)?.status).toBe('assignment_changed')
    expect(scopeSupplierOrders(next, factory).supplierProductionOrders).toEqual([])
    expect(scopeSupplierOrders(next, factoryB).supplierProductionOrders?.map(item => item.runId)).toEqual([newRunId])
    for (const actor of [factory, factoryB]) expect(scopeProductionLedgerWorkspace(next, actor).productionRuns).toEqual([])
    expect(() => assertProductionRunStarted(next, id)).not.toThrow()
    next = allocateProductionReceiptInWorkspace(next, admin, crypto.randomUUID(), id, { receivedAt: '2026-12-13', quantities: { ...emptyQuantities(), S: 3 } }, 2, '이전 차수 실제 입고')
    next = finalizeProductionRunInWorkspace(next, admin, id, 3, '이전 업체 차수 마감')
    expect(next.productionRuns?.find(item => item.id === id)?.snapshot).toMatchObject({ factoryIdSnapshot: factory.factoryId, projectId: style.projectId, unitCost: 13000, receivedQuantity: 3, netAmount: 39000 })
    expect(next.productionRuns?.find(item => item.id === newRunId)).toMatchObject({ factoryIdSnapshot: DEMO_IDS.korea, projectId: otherProject.id, version: 1, closedAt: null })
  })
  it('재배정된 과거 차수라도 원래 PO·동의·생산 시작 근거가 없거나 달라지면 입고를 차단한다', () => {
    const { workspace, admin, factory, id, style } = fixture()
    const agreed = acceptSupplierOrderInWorkspace(workspace, factory, id, 1, 3, '2026-12-12', true)
    agreed.styles.find(item => item.id === style.id)!.factoryId = DEMO_IDS.korea
    for (const alter of [
      (w: SupplierOrderWorkspace) => { w.operations!.poDispatches[0].version += 1 },
      (w: SupplierOrderWorkspace) => { w.operations!.poDispatches[0].factoryIdSnapshot = DEMO_IDS.korea },
      (w: SupplierOrderWorkspace) => { w.operations!.poDispatches[0].voided = true },
      (w: SupplierOrderWorkspace) => { w.supplierProductionOrders![0].startedAt = null },
      (w: SupplierOrderWorkspace) => { w.supplierProductionOrders![0].acceptance = null },
    ]) {
      const changed = structuredClone(agreed); alter(changed)
      expect(() => allocateProductionReceiptInWorkspace(changed, admin, crypto.randomUUID(), id, { receivedAt: '2026-12-13', quantities: { ...emptyQuantities(), S: 3 } }, 2, '과거 차수 입고')).toThrow(/생산 동의/)
    }
  })
})
