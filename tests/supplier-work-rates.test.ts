import { describe, expect, it } from 'vitest'
import { createSeed } from '../src/lib/seed'
import { applySupplierQualityRateInWorkspace, findSupplierWorkRate, saveStyleOperationWithSupplierInWorkspace, saveSupplierWorkItemInWorkspace, saveSupplierWorkRateInWorkspace, scopeSupplierWorkRates, supplierCatalogOptions } from '../src/lib/supplier-work-rates'
import { findProcessingUnitPrice, saveProcessingUnitPriceInWorkspace } from '../src/lib/processing-prices'
import type { OperationRow } from '../src/lib/operations-types'
import { blankProductionDetails } from '../src/lib/workflow-refinements'
import { freshOperations } from '../src/lib/operations-domain'

function fixture() {
  const workspace = createSeed(), hq = workspace.profiles.find(person => person.role === 'admin')!, vendor = workspace.profiles.find(person => person.role === 'factory')!
  const label = { id: crypto.randomUUID(), name: '가상 라벨 업체', country: '대한민국', serviceType: 'label' as const, active: true }
  const embroidery = { id: crypto.randomUUID(), name: '가상 자수 업체', country: '대한민국', serviceType: 'embroidery' as const, active: true }
  const able = { id: crypto.randomUUID(), name: '가상 에이블', country: '대한민국', serviceType: 'inspection' as const, inspectionProvider: 'able' as const, active: true }
  const kotiti = { id: crypto.randomUUID(), name: '가상 KOTITI', country: '대한민국', serviceType: 'inspection' as const, inspectionProvider: 'kotiti' as const, active: true }
  workspace.factories.push(label, embroidery, able, kotiti); vendor.factoryId = label.id
  workspace.supplierWorkRatesAvailable = true; workspace.supplierWorkRates = []; workspace.supplierWorkRateAudits = []
  workspace.processingUnitPrices = []; workspace.productionRuns = []; workspace.inspectionAssignments = []; workspace.inspectionAssignmentsAvailable = true
  workspace.operations = freshOperations()
  const style = workspace.styles[0], line = style.production[0]
  return { workspace, hq, vendor, label, embroidery, able, kotiti, style, line }
}
const row = (catalogId: string): OperationRow => ({ id: crypto.randomUUID(), catalogId, name: '메인 라벨', specification: '기본 20×40', quantity: 100, lossQuantity: 5, completedQuantity: 90, status: 'done', orderedAt: '2026-11-01', requestedAt: '', completedAt: '2026-11-03', dueDate: '2026-11-05', note: '' })

describe('업체별 재사용 작업·기준 단가', () => {
  it('업체가 자기 작업명·기본 규격·0원 단가를 등록하고 서로 다른 스타일에 재사용한다', () => {
    const { workspace, vendor, hq, label, style } = fixture(), id = crypto.randomUUID()
    const saved = saveSupplierWorkItemInWorkspace(workspace, vendor, id, label.id, 'label', { name: '메인 라벨', specification: '기본 20×40', unitCost: 0, active: true }, 0, 0, 'QA 업체 기준 등록')
    expect(supplierCatalogOptions(saved, label.id, 'label')).toHaveLength(1)
    expect(findSupplierWorkRate(saved, label.id, 'label', id)).toMatchObject({ unitCost: 0, version: 1 })
    const first = row(id), second = row(id), nextStyle = saved.styles[1]
    let next = saveStyleOperationWithSupplierInWorkspace(saved, hq, crypto.randomUUID(), style.id, 'label', label.id, 0, { rows: [first], note: '', voided: false }, 'QA 첫 스타일 적용', { [id]: 1 })
    next = saveStyleOperationWithSupplierInWorkspace(next, hq, crypto.randomUUID(), nextStyle.id, 'label', label.id, 0, { rows: [second], note: '', voided: false }, 'QA 다음 스타일 적용', { [id]: 1 })
    expect(findProcessingUnitPrice(next, style.id, style.production[0].id, 'label', first.id)).toMatchObject({ unitCost: 0, supplierFactoryId: label.id, supplierCatalogId: id, masterRateVersion: 1 })
    expect(findProcessingUnitPrice(next, nextStyle.id, nextStyle.production[0].id, 'label', second.id)).toMatchObject({ unitCost: 0, supplierFactoryId: label.id })
    expect(workspace.operations!.styleOperations).toEqual([])
  })
  it('기준 단가 인상·작업명·규격 변경 후에도 기존 합의 단가와 작업 스냅샷·생산 기록은 유지한다', () => {
    const { workspace, vendor, hq, label, style, line } = fixture(), id = crypto.randomUUID(), work = row(id), recordId = crypto.randomUUID()
    let next = saveSupplierWorkItemInWorkspace(workspace, vendor, id, label.id, 'label', { name: work.name, specification: work.specification, unitCost: 250, active: true }, 0, 0, 'QA 기준 등록')
    next = saveStyleOperationWithSupplierInWorkspace(next, hq, recordId, style.id, 'label', label.id, 0, { rows: [work], note: '', voided: false }, 'QA 스타일 적용', { [id]: 1 })
    next = saveProcessingUnitPriceInWorkspace(next, hq, style.id, line.id, 'label', work.id, 333, 1, 'QA 개별 합의 단가')
    const oldPrices = structuredClone(next.processingUnitPrices), oldStyles = structuredClone(next.styles), oldRuns = structuredClone(next.productionRuns)
    next = saveSupplierWorkItemInWorkspace(next, vendor, id, label.id, 'label', { name: '메인 라벨 새 명칭', specification: '기본 25×50', unitCost: 450, active: true }, 1, 1, 'QA 업체 단가 인상')
    next = saveStyleOperationWithSupplierInWorkspace(next, hq, recordId, style.id, 'label', label.id, 1, { rows: [{ ...work, note: '진행 코멘트 추가' }], note: '', voided: false }, 'QA 진행 상태 기록')
    expect(next.processingUnitPrices).toEqual(oldPrices)
    expect(next.operations!.styleOperations[0].rows[0]).toMatchObject({ name: work.name, specification: work.specification })
    expect(next.styles).toEqual(oldStyles); expect(next.productionRuns).toEqual(oldRuns)
    expect(findSupplierWorkRate(next, label.id, 'label', id)).toMatchObject({ unitCost: 450, version: 2 })
    expect(next.supplierWorkRateAudits![1]).toMatchObject({ before: { unitCost: 250 }, after: { unitCost: 450 } })
  })
  it('새 작업 선택 중 기준이 바뀌면 입력을 덮어쓰지 않고 저장을 거부하며 개별 규격 수정은 허용한다', () => {
    const { workspace, vendor, hq, label, style } = fixture(), id = crypto.randomUUID(), work = row(id)
    let next = saveSupplierWorkItemInWorkspace(workspace, vendor, id, label.id, 'label', { name: work.name, specification: work.specification, unitCost: 100, active: true }, 0, 0, 'QA 기준 등록')
    next = saveSupplierWorkItemInWorkspace(next, vendor, id, label.id, 'label', { name: work.name, specification: work.specification, unitCost: 150, active: true }, 1, 1, 'QA 단가 인상')
    expect(() => saveStyleOperationWithSupplierInWorkspace(next, hq, crypto.randomUUID(), style.id, 'label', label.id, 0, { rows: [work], note: '', voided: false }, 'QA 오래된 선택', { [id]: 1 })).toThrow('VERSION_CONFLICT')
    const saved = saveStyleOperationWithSupplierInWorkspace(next, hq, crypto.randomUUID(), style.id, 'label', label.id, 0, { rows: [{ ...work, specification: '이 스타일만 30×60' }], note: '', voided: false }, 'QA 개별 사양 지정', { [id]: 2 })
    expect(saved.operations!.styleOperations[0].rows[0].specification).toBe('이 스타일만 30×60')
  })
  it('업체 간 기준·업무 구분을 구분하고 위조 역할로 다른 업체를 수정할 수 없다', () => {
    const { workspace, vendor, hq, label, embroidery } = fixture(), id = crypto.randomUUID()
    const data = { name: '메인 라벨', specification: '', unitCost: null, active: true }
    expect(() => saveSupplierWorkItemInWorkspace(workspace, { ...vendor, role: 'admin' }, id, embroidery.id, 'embroidery', data, 0, 0, 'QA 권한 위조')).toThrow('권한')
    expect(() => saveSupplierWorkItemInWorkspace(workspace, hq, id, label.id, 'embroidery', data, 0, 0, 'QA 업무 구분')).toThrow('업무 구분')
    let next = saveSupplierWorkItemInWorkspace(workspace, vendor, id, label.id, 'label', data, 0, 0, 'QA 자기 업체 등록')
    next = saveSupplierWorkItemInWorkspace(next, hq, crypto.randomUUID(), embroidery.id, 'embroidery', data, 0, 0, 'QA 다른 업체 등록')
    expect(scopeSupplierWorkRates(next, vendor).supplierWorkRates).toHaveLength(1)
    expect(() => saveSupplierWorkRateInWorkspace(next, vendor, label.id, 'label', id, 1.001, 1, 'QA 소수 검증')).toThrow('단가')
    expect(() => saveSupplierWorkRateInWorkspace(next, vendor, label.id, 'label', id, 100, 0, 'QA 충돌 검증')).toThrow('VERSION_CONFLICT')
    expect(next.styles).toEqual(workspace.styles)
  })
  it('업체 또는 작업 종류를 바꾸면서 이전 단가의 작업 ID를 재사용하지 못한다', () => {
    const { workspace, hq, label, style } = fixture(), one = crypto.randomUUID(), two = crypto.randomUUID(), work = row(one), recordId = crypto.randomUUID()
    let next = saveSupplierWorkItemInWorkspace(workspace, hq, one, label.id, 'label', { name: work.name, specification: work.specification, unitCost: 100, active: true }, 0, 0, 'QA 기준 등록')
    next = saveSupplierWorkItemInWorkspace(next, hq, two, label.id, 'label', { name: '다른 라벨', specification: '기본', unitCost: 200, active: true }, 0, 0, 'QA 다음 기준 등록')
    next = saveStyleOperationWithSupplierInWorkspace(next, hq, recordId, style.id, 'label', label.id, 0, { rows: [work], note: '', voided: false }, 'QA 스타일 적용', { [one]: 1 })
    expect(() => saveStyleOperationWithSupplierInWorkspace(next, hq, recordId, style.id, 'label', label.id, 1, { rows: [{ ...work, catalogId: two, name: '다른 라벨', specification: '기본' }], note: '', voided: false }, 'QA 작업 변경', { [two]: 1 })).toThrow('새 작업 행')
  })
  it('기준 단가 인상은 새 작업에만 적용하고 과거 빈 단가와 결제 마감 컬러에는 소급하지 않는다', () => {
    const { workspace, hq, label, style } = fixture(), id = crypto.randomUUID(), first = row(id), second = row(id), recordId = crypto.randomUUID()
    const firstLine = style.production[0], closedLine = style.production[1]
    firstLine.paymentStatus = 'todo'; closedLine.paymentStatus = 'done'
    let next = saveSupplierWorkItemInWorkspace(workspace, hq, id, label.id, 'label', { name: first.name, specification: first.specification, unitCost: 100, active: true }, 0, 0, 'QA 기준 등록')
    next = saveStyleOperationWithSupplierInWorkspace(next, hq, recordId, style.id, 'label', label.id, 0, { rows: [first], note: '', voided: false }, 'QA 최초 작업', { [id]: 1 })
    expect(findProcessingUnitPrice(next, style.id, closedLine.id, 'label', first.id)).toBeUndefined()
    next.processingUnitPrices = [] // Existing work can predate a saved quotation.
    next = saveSupplierWorkRateInWorkspace(next, hq, label.id, 'label', id, 200, 1, 'QA 미래 단가 인상')
    next = saveStyleOperationWithSupplierInWorkspace(next, hq, recordId, style.id, 'label', label.id, 1, { rows: [first, second], note: '', voided: false }, 'QA 새 작업 추가', { [id]: 1 })
    expect(findProcessingUnitPrice(next, style.id, firstLine.id, 'label', first.id)).toBeUndefined()
    expect(findProcessingUnitPrice(next, style.id, firstLine.id, 'label', second.id)).toMatchObject({ unitCost: 200, masterRateVersion: 2 })
    expect(findProcessingUnitPrice(next, style.id, closedLine.id, 'label', second.id)).toBeUndefined()
  })
  it('비활성·업무 구분이 바뀐 업체 기준은 보이지 않고 위조 활성 상태로 수정할 수 없다', () => {
    const { workspace, hq, vendor, label } = fixture(), id = crypto.randomUUID()
    const saved = saveSupplierWorkItemInWorkspace(workspace, hq, id, label.id, 'label', { name: '메인 라벨', specification: '', unitCost: null, active: true }, 0, 0, 'QA 업체 기준 등록')
    saved.factories.find(factory => factory.id === label.id)!.active = false
    expect(scopeSupplierWorkRates(saved, vendor).supplierWorkRates).toEqual([])
    expect(() => saveSupplierWorkRateInWorkspace(saved, { ...vendor, role: 'admin', active: true }, label.id, 'label', id, 100, 1, 'QA 비활성 위조')).toThrow('권한')
  })
  it('검사 업체·품목별 기본 단가는 명시적 배정에만 적용하고 기존 업체 합의값을 자동 변경하지 않는다', () => {
    const { workspace, hq, able, kotiti, style, line } = fixture()
    const actor = workspace.profiles.find(profile => profile.role === 'factory')!
    actor.factoryId = able.id
    let next = saveSupplierWorkRateInWorkspace(workspace, actor, able.id, 'quality', '아우터', 500, 0, 'QA 검사 단가 등록')
    next = saveSupplierWorkRateInWorkspace(next, hq, kotiti.id, 'quality', '아우터', 800, 0, 'QA 코티티 단가 등록')
    next.inspectionAssignments = [{ styleId: style.id, lineId: line.id, provider: 'able', version: 1, updatedAt: '2026-11-04', updatedBy: hq.id }]
    next.productionDetails = [{ ...blankProductionDetails(), styleId: style.id, lineId: line.id, version: 1, createdAt: '2026-11-04', updatedAt: '2026-11-04', updatedBy: hq.id }]
    next.productionDetails[0].quality.category = '아우터'
    next = applySupplierQualityRateInWorkspace(next, hq, style.id, line.id, able.id, '아우터', 1, 0, 'QA 배정 단가 적용')
    next = saveSupplierWorkRateInWorkspace(next, actor, able.id, 'quality', '아우터', 900, 1, 'QA 기준 단가 인상')
    next = applySupplierQualityRateInWorkspace(next, hq, style.id, line.id, able.id, '아우터', 1, 1, 'QA 같은 업체 유지')
    expect(findProcessingUnitPrice(next, style.id, line.id, 'quality', '아우터')).toMatchObject({ unitCost: 500, supplierFactoryId: able.id, version: 1 })
    next.inspectionAssignments[0].provider = 'kotiti'; next.inspectionAssignments[0].version = 2
    expect(() => applySupplierQualityRateInWorkspace(next, hq, style.id, line.id, able.id, '아우터', 1, 1, 'QA 오래된 배정')).toThrow('VERSION_CONFLICT')
    next = applySupplierQualityRateInWorkspace(next, hq, style.id, line.id, kotiti.id, '아우터', 2, 1, 'QA 코티티 배정 적용')
    expect(findProcessingUnitPrice(next, style.id, line.id, 'quality', '아우터')).toMatchObject({ unitCost: 800, supplierFactoryId: kotiti.id, version: 2 })
    expect(next.productionRuns).toEqual(workspace.productionRuns)
  })
  it('결제 마감된 컬러에는 검사 업체 기본 단가를 새로 만들지 않는다', () => {
    const { workspace, hq, able, style, line } = fixture()
    line.paymentStatus = 'approved'
    let next = saveSupplierWorkRateInWorkspace(workspace, hq, able.id, 'quality', '아우터', 500, 0, 'QA 검사 단가 등록')
    next.inspectionAssignments = [{ styleId: style.id, lineId: line.id, provider: 'able', version: 1, updatedAt: '2026-11-04', updatedBy: hq.id }]
    next.productionDetails = [{ ...blankProductionDetails(), styleId: style.id, lineId: line.id, version: 1, createdAt: '', updatedAt: '', updatedBy: hq.id }]
    next.productionDetails[0].quality.category = '아우터'
    expect(() => applySupplierQualityRateInWorkspace(next, hq, style.id, line.id, able.id, '아우터', 1, 0, 'QA 마감 단가 변경')).toThrow('HISTORY_PROTECTED')
    expect(next.processingUnitPrices).toEqual([])
  })
})
