import { describe, expect, it } from 'vitest'
import { savePartialDeliveryInWorkspace, scopePartialDeliveryWorkspace, totalPlanned, totalPlannedBySize, validatePartialDeliveries, type PartialDeliveryInstallment } from '../src/lib/partial-deliveries'
import { createSeed } from '../src/lib/seed'
import { emptyQuantities, type Quantities } from '../src/lib/types'
import { saveProductionRunInWorkspace } from '../src/lib/production-ledger'
import { getDemoSupplierProductionOrders } from '../src/lib/supplier-orders'

const items: PartialDeliveryInstallment[] = [
  { id: 'a', dueDate: '2026-11-10', quantity: 200, note: '1차 입고 예정' },
  { id: 'b', dueDate: '2026-11-20', quantity: 200, note: '2차 입고 예정' },
]
describe('manual partial-delivery installments', () => {
  it('splits a 400-piece order into two dated installments without a new production round', () => {
    expect(() => validatePartialDeliveries(items, 400)).not.toThrow()
    expect(totalPlanned(items)).toBe(400)
  })
  it('rejects totals that disagree with the original order', () => {
    expect(() => validatePartialDeliveries(items, 450)).toThrow(/합계/)
  })
  it('rejects zero, fractional and negative quantities', () => {
    for (const quantity of [0, -10, 0.5, NaN]) {
      expect(() => validatePartialDeliveries([{ ...items[0], quantity }, items[1]], 400)).toThrow()
    }
  })
  it('prevents duplicate identifiers and out-of-order delivery dates', () => {
    expect(() => validatePartialDeliveries([items[0], { ...items[1], id: 'a' }], 400)).toThrow(/중복/)
    expect(() => validatePartialDeliveries([items[1], items[0]], 400)).toThrow(/순서/)
  })
  it('rejects invalid calendar dates', () => {
    expect(() => validatePartialDeliveries([{ ...items[0], dueDate: '2026-02-30' }, items[1]], 400)).toThrow(/납기일/)
  })
})

const order: Quantities = { XXS: 10, XS: 20, S: 30, M: 40, L: 50, XL: 60 }
const sizes: PartialDeliveryInstallment[] = [
  { id: 'size-one', dueDate: '2026-11-10', quantities: { XXS: 10, XS: 10, S: 15, M: 20, L: 25, XL: 30 }, quantity: 110, note: '1차' },
  { id: 'size-two', dueDate: '2026-11-20', quantities: { XXS: 0, XS: 10, S: 15, M: 20, L: 25, XL: 30 }, quantity: 100, note: '2차' },
]
describe('size allocations in partial-delivery installments', () => {
  it('accepts complete six-size plans including zero in an individual size and checks each order size', () => {
    expect(() => validatePartialDeliveries(sizes, order)).not.toThrow()
    expect(totalPlannedBySize(sizes)).toEqual(order)
    expect(totalPlanned(sizes)).toBe(210)
  })
  it('rejects the same grand total allocated to the wrong size', () => {
    const wrong = structuredClone(sizes)
    wrong[1].quantities!.XXS += 1; wrong[1].quantities!.XS -= 1
    expect(totalPlanned(wrong)).toBe(210)
    expect(() => validatePartialDeliveries(wrong, order)).toThrow(/사이즈별 합계/)
  })
  it('rejects a row total that differs from the six-size row sum', () => {
    const wrong = structuredClone(sizes); wrong[0].quantities!.S += 1
    expect(() => validatePartialDeliveries(wrong, order)).toThrow(/각 납기 차수/)
  })
  it('requires exact six-size integer allocations rather than missing, extra, negative or fractional values', () => {
    const incomplete = { ...sizes[0].quantities }; delete incomplete.XL
    for (const value of [incomplete, { ...sizes[0].quantities, XXL: 1 }, { ...sizes[0].quantities, S: -1 }, { ...sizes[0].quantities, S: 1.5 }, { ...sizes[0].quantities, S: NaN }, null]) {
      const invalid = [{ ...sizes[0], quantities: value }, sizes[1]] as PartialDeliveryInstallment[]
      expect(() => validatePartialDeliveries(invalid, order)).toThrow(/사이즈별 예정 수량/)
    }
  })
  it('does not mix sized rows with legacy totals or infer an allocation for a legacy plan', () => {
    const legacy = sizes.map(({ quantities: _sizes, ...item }) => item)
    expect(() => validatePartialDeliveries(legacy, order)).not.toThrow()
    expect(totalPlannedBySize(legacy)).toEqual(emptyQuantities())
    expect(() => validatePartialDeliveries([sizes[0], legacy[1]], order)).toThrow(/기존 합계/)
    expect(legacy.every(item => !('quantities' in item))).toBe(true)
  })
  it('requires the actual size order when saving size allocations', () => {
    expect(() => validatePartialDeliveries(sizes, 210)).toThrow(/오더 수량과 함께/)
  })
  it('preserves business records and the source workspace while saving allocation audit, then enforces CAS and frozen plans', () => {
    const initial = createSeed(), admin = initial.profiles.find(profile => profile.role === 'admin')!, style = initial.styles[1], id = crypto.randomUUID()
    const workspace = saveProductionRunInWorkspace(initial, admin, id, style.id, style.production[0].id, { name: '분할 납기 시험', projectId: style.projectId, projectCode: 'HQ-BUDGET', expectedDue: '2026-11-20', poId: null, unitCost: null, itemType: 'product', order, correctsRunId: null }, 0, '부분 납기 수량 시험')
    const before = structuredClone(workspace)
    const saved = savePartialDeliveryInWorkspace(workspace, admin, id, 0, sizes, '사이즈별 부분 납기 계획')
    expect(workspace).toEqual(before)
    expect(saved.styles).toEqual(before.styles); expect(saved.productionRuns).toEqual(before.productionRuns)
    expect(saved.productionReceipts).toEqual(before.productionReceipts); expect(saved.operations).toEqual(before.operations)
    expect(saved.partialDeliveryPlans?.[0]).toMatchObject({ runId: id, version: 1, items: sizes })
    expect(() => savePartialDeliveryInWorkspace(saved, admin, id, 0, sizes, '오래된 계획 저장')).toThrow(/VERSION_CONFLICT/)
    const factory = saved.profiles.find(profile => profile.role === 'factory')!
    expect(() => savePartialDeliveryInWorkspace(saved, factory, id, 1, sizes, '업체 임의 계획 저장')).toThrow(/본사/)
    saved.productionRuns![0].closedAt = '2026-11-30T00:00:00Z'
    expect(() => savePartialDeliveryInWorkspace(saved, admin, id, 1, sizes, '마감 후 계획 변경')).toThrow(/수정할 수 없습니다/)
  })
})

function scopeFixture() {
  let workspace = createSeed()
  const admin = workspace.profiles.find(person => person.role === 'admin')!, factory = workspace.profiles.find(person => person.role === 'factory' && person.active && person.approved)!
  const ownStyle = workspace.styles.find(style => style.factoryId === factory.factoryId)!, otherStyle = workspace.styles.find(style => style.factoryId !== factory.factoryId)!
  const runIds = [crypto.randomUUID(), crypto.randomUUID()]
  for (const [index, style] of [ownStyle, otherStyle].entries()) workspace = saveProductionRunInWorkspace(workspace, admin, runIds[index], style.id, style.production[0].id, { name: '배정별 부분 납기 계획', projectId: style.projectId, projectCode: 'HQ-BUDGET', expectedDue: '2026-11-20', poId: null, unitCost: 10, itemType: 'product', order, correctsRunId: null }, 0, '부분 납기 조회 범위 검증')
  workspace.partialDeliveryAvailable = true; workspace.partialDeliverySizesAvailable = true; workspace.productionLedgerAvailable = true
  workspace.partialDeliveryPlans = runIds.map(runId => ({ runId, version: 1, items: structuredClone(sizes), updatedAt: '2026-11-04T00:00:00Z', updatedBy: admin.id }))
  workspace.supplierProductionOrders = getDemoSupplierProductionOrders(workspace)
  return { workspace, factory, admin, ownStyle, runIds }
}
describe('부분 납기의 본사·배정 업체 조회 범위', () => {
  it('금융용 productionRuns가 없는 공장 클라우드에서도 배정 발주의 사이즈 계획과 capability를 유지한다', () => {
    const { workspace, factory, runIds } = scopeFixture()
    workspace.productionRuns = []
    const before = structuredClone(workspace)
    const scoped = scopePartialDeliveryWorkspace(workspace, factory)
    expect(scoped).toEqual({ partialDeliveryAvailable: true, partialDeliverySizesAvailable: true, partialDeliveryPlans: [workspace.partialDeliveryPlans![0]] })
    expect(scoped.partialDeliveryPlans?.map(plan => plan.runId)).toEqual([runIds[0]])
    expect(scoped).not.toHaveProperty('productionRuns')
    expect(workspace).toEqual(before)
    scoped.partialDeliveryPlans![0].items[0].quantities!.XXS = 999
    expect(workspace.partialDeliveryPlans![0].items[0].quantities!.XXS).toBe(sizes[0].quantities!.XXS)
  })
  it('다른 공장·재배정·삭제 스타일의 계획을 제외하고 요청한 역할 대신 저장된 계정을 검사한다', () => {
    const { workspace, factory, ownStyle } = scopeFixture()
    const supplied = { ...factory, role: 'admin' as const }
    expect(scopePartialDeliveryWorkspace(workspace, supplied).partialDeliveryPlans).toHaveLength(1)
    workspace.supplierProductionOrders![0].factoryId = workspace.factories.find(item => item.id !== factory.factoryId)!.id
    expect(scopePartialDeliveryWorkspace(workspace, supplied).partialDeliveryPlans).toEqual([])
    workspace.supplierProductionOrders![0].factoryId = factory.factoryId!
    workspace.styles.find(style => style.id === ownStyle.id)!.deletedAt = '2026-11-04T00:00:00Z'
    expect(scopePartialDeliveryWorkspace(workspace, supplied).partialDeliveryPlans).toEqual([])
  })
  it('본사는 기존 접근 가능한 실제 차수만 보며 고아 계획을 추가하지 않고 미승인·비활성·알 수 없는 계정은 비운다', () => {
    const { workspace, admin, factory, runIds } = scopeFixture()
    workspace.partialDeliveryPlans!.push({ ...structuredClone(workspace.partialDeliveryPlans![0]), runId: 'orphan-plan' })
    workspace.supplierProductionOrders = []
    expect(scopePartialDeliveryWorkspace(workspace, admin).partialDeliveryPlans?.map(plan => plan.runId)).toEqual(runIds)
    expect(scopePartialDeliveryWorkspace(workspace, { ...admin, id: 'missing-actor' }).partialDeliveryPlans).toEqual([])
    workspace.profiles.find(person => person.id === factory.id)!.active = false
    expect(scopePartialDeliveryWorkspace(workspace, { ...factory, active: true }).partialDeliveryPlans).toEqual([])
    workspace.profiles.find(person => person.id === admin.id)!.approved = false
    expect(scopePartialDeliveryWorkspace(workspace, { ...admin, approved: true }).partialDeliveryPlans).toEqual([])
    expect(scopePartialDeliveryWorkspace(workspace, admin)).toMatchObject({ partialDeliveryAvailable: true, partialDeliverySizesAvailable: true })
  })
})
