import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { emptyQuantities, type Workspace } from '../src/lib/types'
import { EMPTY_OPERATIONS, type PoDispatch } from '../src/lib/operations-types'
import { saveProductionRunInWorkspace, allocateProductionReceiptInWorkspace, finalizeProductionRunInWorkspace } from '../src/lib/production-ledger'
import { assertProductionRunStarted, getDemoSupplierProductionOrders } from '../src/lib/supplier-orders'
import { configureProductionConditionsInWorkspace, getDemoProductionConditions, getProductionCondition, hasFinalProductionApproval, linkProductionConditionChangeInWorkspace, productionDelayDays, productionPriceDifference, requestProductionConditionChangeInWorkspace, reviewProductionConditionsInWorkspace, scopeProductionConditionsWorkspace, submitProductionConditionsInWorkspace, validateProductionConditionsInput, type ProductionConditionsInput } from '../src/lib/production-conditions'

function fixture() {
  let workspace: Workspace = { ...createSeed(), operations: structuredClone(EMPTY_OPERATIONS), productionLedgerAvailable: true, supplierOrdersAvailable: true, productionRuns: [], productionReceipts: [], supplierProductionOrders: [], productionConditionsAvailable: true, productionConditions: [] }
  const style = workspace.styles[1], line = style.production[0], admin = workspace.profiles.find(item => item.id === DEMO_IDS.admin)!, factory = workspace.profiles.find(item => item.id === DEMO_IDS.factory)!
  const po: PoDispatch = { id: crypto.randomUUID(), styleId: style.id, dueDate: '2026-11-11', recipient: 'supplier@example.test', subject: '생산 발주', body: '프로젝트와 사이즈별 수량을 확인해 주세요.', evidenceAttachmentId: null, status: 'sent', sentAt: '2026-10-28T01:00:00Z', providerMessageId: null, provider: 'outlook', providerRequestId: 'request-proof', senderEmailSnapshot: 'hq@example.test', lastError: null, attempts: 1, idempotencyKey: 'unit-fixture', factoryIdSnapshot: style.factoryId, styleCodeSnapshot: style.code, voided: false, version: 3, createdAt: '2026-10-28T01:00:00Z', updatedAt: '2026-10-28T01:00:00Z', updatedBy: admin.id }
  workspace.operations!.poDispatches = [po]
  const id = crypto.randomUUID(), input = { name: '승인 검증 1차', projectId: style.projectId, projectCode: 'TEST-PROJECT', expectedDue: '2026-11-11', poId: po.id, unitCost: null, itemType: 'product' as const, order: { ...emptyQuantities(), S: 10, M: 20 }, correctsRunId: null }
  workspace = saveProductionRunInWorkspace(workspace, admin, id, style.id, line.id, input, 0, '생산 차수 생성')
  workspace.supplierProductionOrders = getDemoSupplierProductionOrders(workspace)
  workspace.productionConditions = getDemoProductionConditions(workspace)
  return { workspace, style, line, admin, factory, po, id, input }
}
function quote(order = { ...emptyQuantities(), S: 10, M: 20 }): ProductionConditionsInput {
  return { expectedDeliveryDate: '2026-11-30', unitCost: 12000, canProduce: true, quantityConfirmed: true, agreed: true, comment: '검토 요청드립니다.', delayReason: '원단 입고 지연', priceReason: '작업 사양 반영', confirmedQuantities: order }
}
function configured() {
  const f = fixture(); f.workspace = configureProductionConditionsInWorkspace(f.workspace, f.admin, f.id, 1, 0, 'full_package', 9999, '내부 검토 기준 9999원 설정'); return f
}
function submitted() {
  const f = configured(); f.workspace = submitProductionConditionsInWorkspace(f.workspace, f.factory, f.id, 2, f.po.version, 1, quote()); return f
}
function approved() {
  const f = submitted(); f.workspace = reviewProductionConditionsInWorkspace(f.workspace, f.admin, f.id, 3, 2, 'approve', '2026-11-25', 11500, '협의한 납기와 단가 최종 승인'); return f
}

describe('생산 조건 제안과 본사 최종 승인', () => {
  it('발송된 PO는 업체 회신 대기이고 업체 제출 후에도 생산·실입고·마감은 차단한다', () => {
    const f = configured()
    expect(getProductionCondition(f.workspace, f.id)).toMatchObject({ status: 'awaiting_supplier', productionMode: 'full_package', version: 1 })
    f.workspace = submitProductionConditionsInWorkspace(f.workspace, f.factory, f.id, 2, f.po.version, 1, quote())
    expect(getProductionCondition(f.workspace, f.id)).toMatchObject({ status: 'awaiting_approval', version: 2, approval: null, legacy: false })
    expect(getDemoSupplierProductionOrders(f.workspace)[0]).toMatchObject({ startedAt: null, acceptance: null })
    expect(() => assertProductionRunStarted(f.workspace, f.id)).toThrow('HQ_APPROVAL_REQUIRED')
    expect(() => allocateProductionReceiptInWorkspace(f.workspace, f.admin, crypto.randomUUID(), f.id, { receivedAt: '2026-11-26', quantities: { ...emptyQuantities(), S: 1 } }, 3, '승인 전 입고')).toThrow('HQ_APPROVAL_REQUIRED')
    expect(() => finalizeProductionRunInWorkspace(f.workspace, f.admin, f.id, 3, '승인 전 마감')).toThrow('HQ_APPROVAL_REQUIRED')
  })
  it('본사 승인만 생산을 시작하고 최종 단가를 입고 원가에 적용하며 요청 납기는 보존한다', () => {
    const f = approved(), condition = getProductionCondition(f.workspace, f.id)
    expect(condition).toMatchObject({ status: 'approved', legacy: false, approval: { finalDeliveryDate: '2026-11-25', unitCost: 11500, approvedBy: f.admin.id } })
    expect(f.workspace.productionRuns![0]).toMatchObject({ unitCost: 11500, expectedDue: '2026-11-11', version: 4 })
    expect(condition.approval!.termsSnapshot).toMatchObject({ proposedUnitCost: 12000, productionMode: 'full_package', order: f.input.order, requestedDeliveryDate: '2026-11-11', finalDeliveryDate: '2026-11-25' })
    expect(condition.approval!.poSnapshot).toMatchObject({ providerRequestId: 'request-proof', sentAt: f.po.sentAt, id: f.po.id })
    expect(hasFinalProductionApproval(f.workspace, f.id)).toBe(true)
    expect(() => assertProductionRunStarted(f.workspace, f.id)).not.toThrow()
    const next = allocateProductionReceiptInWorkspace(f.workspace, f.admin, crypto.randomUUID(), f.id, { receivedAt: '2026-11-26', quantities: { ...emptyQuantities(), S: 2 } }, 4, '승인 후 입고')
    expect(next.productionReceipts![0]).toMatchObject({ unitCost: 11500, netAmount: 23000 })
    expect(condition.timeline.map(event => event.action)).toEqual(expect.arrayContaining(['업체 생산 조건 최초 제출', '본사 최종 승인', '생산 시작']))
  })
  it('납기 19일 지연과 단가 차이를 계산하며 미입력과 0원을 구분한다', () => {
    expect(productionDelayDays('2026-11-11', '2026-11-30')).toBe(19)
    expect(productionDelayDays('2026-11-11', '2026-11-10')).toBe(-1)
    expect(productionDelayDays('', '2026-11-30')).toBeNull()
    expect(productionPriceDifference(10000, 12000)).toBe(2000)
    expect(productionPriceDifference(null, 0)).toBeNull()
    expect(productionPriceDifference(0, 0)).toBe(0)
    const f = configured(); f.workspace = submitProductionConditionsInWorkspace(f.workspace, f.factory, f.id, 2, 3, 1, { ...quote(), unitCost: 0 })
    const next = reviewProductionConditionsInWorkspace(f.workspace, f.admin, f.id, 3, 2, 'approve', '2026-11-12', 0, '무상 생산 조건 최종 승인')
    expect(next.productionRuns![0].unitCost).toBe(0)
    expect(() => reviewProductionConditionsInWorkspace(f.workspace, f.admin, f.id, 3, 2, 'approve', '2026-11-12', null, '단가 미입력 승인')).toThrow('단가')
  })
  it('본사 수정 요청 뒤 업체 재제출·재승인하며 이전 제안의 날짜와 단가는 타임라인에 보존한다', () => {
    const f = submitted()
    f.workspace = reviewProductionConditionsInWorkspace(f.workspace, f.admin, f.id, 3, 2, 'request_revision', '', null, '납기와 단가 재협의 요청')
    f.workspace = submitProductionConditionsInWorkspace(f.workspace, f.factory, f.id, 4, 3, 3, { ...quote(), expectedDeliveryDate: '2026-11-20', unitCost: 11000 })
    f.workspace = reviewProductionConditionsInWorkspace(f.workspace, f.admin, f.id, 5, 4, 'approve', '2026-11-20', 11000, '수정 조건 최종 승인')
    const condition = getProductionCondition(f.workspace, f.id)
    expect(condition.proposal).toMatchObject({ expectedDeliveryDate: '2026-11-20', unitCost: 11000 })
    expect(condition.timeline.find(event => event.action === '업체 생산 조건 최초 제출')!.after).toMatchObject({ expectedDeliveryDate: '2026-11-30', unitCost: 12000 })
    expect(condition.timeline.map(event => event.action)).toContain('업체 수정 조건 재제출')
  })
  it('회신 뒤 변경된 차수명·입고 단위·프로젝트명은 그대로 승인하지 않고 업체 재확인을 요구한다', () => {
    for (const change of ['name', 'itemType', 'projectName'] as const) {
      const f = submitted(), original = structuredClone(getProductionCondition(f.workspace, f.id).proposal!)
      if (change === 'projectName') f.workspace.projects.find(project => project.id === f.input.projectId)!.name = '본사에서 변경한 프로젝트명'
      else f.workspace = saveProductionRunInWorkspace(f.workspace, f.admin, f.id, f.style.id, f.line.id, { ...f.input, ...(change === 'name' ? { name: '변경된 후속 생산명' } : { itemType: 'fabric' as const }) }, 3, '업체 회신 뒤 생산 기준 변경')
      const run = f.workspace.productionRuns!.find(item => item.id === f.id)!
      expect(() => reviewProductionConditionsInWorkspace(f.workspace, f.admin, f.id, run.version, 2, 'approve', '2026-11-25', 11500, '변경 전 회신 승인 시도')).toThrow('PRODUCTION_CONDITIONS_CHANGED')
      expect(getProductionCondition(f.workspace, f.id).proposal).toEqual(original)
      expect(getDemoSupplierProductionOrders(f.workspace)[0].startedAt).toBeNull()
    }
  })
  it('오래된 조건은 수정 요청으로 다시 회신받거나 거절하며 이전 회신·문서는 보존한다', () => {
    const f = submitted(), original = structuredClone(getProductionCondition(f.workspace, f.id).proposal!)
    f.workspace.projects.find(project => project.id === f.input.projectId)!.name = '업체 재확인이 필요한 프로젝트명'
    const rejected = reviewProductionConditionsInWorkspace(f.workspace, f.admin, f.id, 3, 2, 'reject', '', null, '변경된 프로젝트 조건으로 발주 거절')
    expect(getProductionCondition(rejected, f.id)).toMatchObject({ status: 'rejected', proposal: original, approval: null })
    f.workspace = reviewProductionConditionsInWorkspace(f.workspace, f.admin, f.id, 3, 2, 'request_revision', '', null, '현재 프로젝트 조건을 다시 확인해 주세요.')
    f.workspace = submitProductionConditionsInWorkspace(f.workspace, f.factory, f.id, 4, 3, 3, quote())
    const revised = getProductionCondition(f.workspace, f.id).proposal!
    expect(revised.termsSnapshot.projectName).toBe('업체 재확인이 필요한 프로젝트명')
    expect(revised.poSnapshot).toEqual(original.poSnapshot)
    f.workspace = reviewProductionConditionsInWorkspace(f.workspace, f.admin, f.id, 5, 4, 'approve', '2026-11-25', 11500, '재확인한 현재 조건 최종 승인')
    const condition = getProductionCondition(f.workspace, f.id)
    expect(condition.status).toBe('approved')
    expect(condition.timeline.find(event => event.action === '업체 생산 조건 최초 제출')!.after).toMatchObject({ termsSnapshot: original.termsSnapshot, poSnapshot: original.poSnapshot })
  })
  it('업체 회신은 정확한 전체 품번·컬러·단위·발송 PO를 저장하며 이후 다른 PO로 승인하지 않는다', () => {
    const f = submitted(), proposal = getProductionCondition(f.workspace, f.id).proposal!
    expect(proposal.termsSnapshot).toMatchObject({ styleId: f.style.id, lineId: f.line.id, fullStyleCode: `${f.style.code}${f.line.color}`, color: f.line.color, itemType: 'product', productionMode: 'full_package', order: f.input.order })
    expect(proposal.termsSnapshot).not.toHaveProperty('internalUnitCost')
    expect(proposal.termsSnapshot).not.toHaveProperty('unitCost')
    expect(proposal.poSnapshot).toMatchObject({ id: f.po.id, version: 3, body: f.po.body, providerRequestId: 'request-proof' })
    f.workspace.operations!.poDispatches[0].version += 1
    expect(() => reviewProductionConditionsInWorkspace(f.workspace, f.admin, f.id, 3, 2, 'approve', '2026-11-25', 11500, '변경된 PO 승인 시도')).toThrow('PO_NOT_SENT')
  })
  it('생산 방식 설정 뒤 PO가 발송되어도 이력을 한 번만 추가하고 발송한 방식은 변경하지 않는다', () => {
    const f = fixture()
    f.workspace.operations!.poDispatches[0] = { ...f.po, status: 'draft', attempts: 0, sentAt: '' }
    f.workspace.productionConditions = []
    f.workspace = configureProductionConditionsInWorkspace(f.workspace, f.admin, f.id, 1, 0, 'cmt', 9000, '발송 전 임가공 검토 기준')
    expect(getProductionCondition(f.workspace, f.id).timeline.map(event => event.action)).not.toContain('본사 PO 발송')
    f.workspace.operations!.poDispatches[0] = { ...f.po, sentAt: new Date().toISOString() }
    const before = structuredClone(f.workspace)
    f.workspace.productionConditions = getDemoProductionConditions(f.workspace)
    expect(before.productionConditions![0].timeline.map(event => event.action)).not.toContain('본사 PO 발송')
    const reloaded = getDemoProductionConditions(f.workspace)
    expect(reloaded[0].timeline.filter(event => event.action === '본사 PO 발송')).toHaveLength(1)
    expect(reloaded[0].timeline.map(event => event.action)).toContain('본사 생산 방식·검토 단가 설정')
    expect(() => configureProductionConditionsInWorkspace(f.workspace, f.admin, f.id, 2, 1, 'full_package', 9000, '발송 뒤 완사입으로 변경')).toThrow('생산 방식')
    expect(configureProductionConditionsInWorkspace(f.workspace, f.admin, f.id, 2, 1, 'cmt', 9500, '같은 방식의 내부 기준 조정').productionConditions![0].internalUnitCost).toBe(9500)
  })
  it('생산 불가 또는 수량 미확인 회신은 제출할 수 있으나 승인할 수 없다', () => {
    for (const changes of [{ canProduce: false }, { quantityConfirmed: false }]) {
      const f = configured(); f.workspace = submitProductionConditionsInWorkspace(f.workspace, f.factory, f.id, 2, 3, 1, { ...quote(), ...changes })
      expect(getProductionCondition(f.workspace, f.id).status).toBe('awaiting_approval')
      expect(() => reviewProductionConditionsInWorkspace(f.workspace, f.admin, f.id, 3, 2, 'approve', '2026-11-20', 10000, '미확인 승인 시도')).toThrow('업체')
    }
  })
  it('발주 거절 뒤 재제출과 생산 시작을 차단하고 회신 이력은 남긴다', () => {
    const f = submitted(); const next = reviewProductionConditionsInWorkspace(f.workspace, f.admin, f.id, 3, 2, 'reject', '', null, '생산 일정 불일치로 발주 거절')
    expect(getProductionCondition(next, f.id)).toMatchObject({ status: 'rejected', proposal: { unitCost: 12000 }, approval: null })
    expect(() => submitProductionConditionsInWorkspace(next, f.factory, f.id, 4, 3, 3, quote())).toThrow('상태')
    expect(() => assertProductionRunStarted(next, f.id)).toThrow('HQ_APPROVAL_REQUIRED')
  })
  it('공장에는 본사 내부 검토 단가·개인 설정 사유를 공개하지 않고 타 공장 발주는 숨긴다', () => {
    const f = submitted(), scoped = scopeProductionConditionsWorkspace(f.workspace, f.factory)
    expect(scoped.productionConditions).toHaveLength(1)
    expect(JSON.stringify(scoped)).not.toContain('9999')
    expect(scoped.productionConditions![0]).not.toHaveProperty('internalUnitCost')
    expect(scoped.productionConditions![0].timeline.map(event => event.action)).not.toContain('본사 생산 방식·검토 단가 설정')
    expect(scopeProductionConditionsWorkspace(f.workspace, { ...f.factory, role: 'admin' }).productionConditions![0]).not.toHaveProperty('internalUnitCost')
    const other = { ...f.factory, id: crypto.randomUUID(), factoryId: DEMO_IDS.korea }; f.workspace.profiles.push(other)
    expect(scopeProductionConditionsWorkspace(f.workspace, other).productionConditions).toEqual([])
    expect(() => submitProductionConditionsInWorkspace(f.workspace, other, f.id, 3, 3, 2, quote())).toThrow('접근')
  })
  it('본사와 공장 역할을 위조하거나 탈퇴한 세션으로 검토·제출할 수 없다', () => {
    const f = submitted()
    expect(() => reviewProductionConditionsInWorkspace(f.workspace, { ...f.factory, role: 'admin' }, f.id, 3, 2, 'approve', '2026-11-20', 10000, '역할 위조')).toThrow('본사')
    f.workspace.profiles = f.workspace.profiles.map(person => person.id === f.factory.id ? { ...person, active: false } : person)
    expect(() => submitProductionConditionsInWorkspace(f.workspace, f.factory, f.id, 3, 3, 2, quote())).toThrow('승인')
    expect(scopeProductionConditionsWorkspace(f.workspace, f.factory).productionConditions).toEqual([])
  })
  it('다른 사용자의 수정과 중복 승인·기존 PO 버전 변경을 덮어쓰지 않는다', () => {
    const f = configured()
    expect(() => submitProductionConditionsInWorkspace(f.workspace, f.factory, f.id, 1, 3, 1, quote())).toThrow('VERSION_CONFLICT')
    expect(() => submitProductionConditionsInWorkspace(f.workspace, f.factory, f.id, 2, 2, 1, quote())).toThrow('VERSION_CONFLICT')
    const a = approved()
    expect(() => reviewProductionConditionsInWorkspace(a.workspace, a.admin, a.id, 3, 2, 'approve', '2026-11-25', 11500, '중복 승인')).toThrow('VERSION_CONFLICT')
  })
  it('승인 후 일반 수정은 차단하고 변경 요청은 원래 승인·생산·단가를 보존한다', () => {
    const f = approved(), before = structuredClone(f.workspace)
    expect(() => saveProductionRunInWorkspace(f.workspace, f.admin, f.id, f.style.id, f.line.id, { ...f.input, unitCost: 1 }, 4, '일반 단가 수정')).toThrow('최종 승인')
    const next = requestProductionConditionChangeInWorkspace(f.workspace, f.factory, f.id, 4, 3, '다음 생산에서 사양과 단가 변경 요청')
    expect(next.productionRuns).toEqual(before.productionRuns)
    expect(getProductionCondition(next, f.id).approval).toEqual(getProductionCondition(before, f.id).approval)
    expect(getProductionCondition(next, f.id)).toMatchObject({ version: 4, status: 'approved', changeRequests: [{ correctingRunId: null }] })
  })
  it('새 차수와 명시적으로 연결한 변경 요청만 독립된 재승인 절차에 들어간다', () => {
    const f = approved(); f.workspace = requestProductionConditionChangeInWorkspace(f.workspace, f.admin, f.id, 4, 3, '후속 생산 사양 재협의')
    const request = getProductionCondition(f.workspace, f.id).changeRequests[0], replacementId = crypto.randomUUID()
    f.workspace = saveProductionRunInWorkspace(f.workspace, f.admin, replacementId, f.style.id, f.line.id, { ...f.input, poId: null }, 0, '별도 범위의 재협의 생산 차수')
    expect(() => linkProductionConditionChangeInWorkspace(f.workspace, f.admin, request.id, replacementId, 1, '후속 차수 연결', false)).toThrow('집계 범위')
    const next = linkProductionConditionChangeInWorkspace(f.workspace, f.admin, request.id, replacementId, 1, '후속 차수와 수량 범위 확인', true)
    expect(getProductionCondition(next, f.id).changeRequests[0].correctingRunId).toBe(replacementId)
    expect(getProductionCondition(next, replacementId)).toMatchObject({ priorRunId: f.id, changeRequestId: request.id, approval: null, status: 'awaiting_po' })
    expect(next.productionRuns!.find(run => run.id === f.id)).toEqual(f.workspace.productionRuns!.find(run => run.id === f.id))
  })
  it('잘못된 단가·날짜·추가 필드·수량 동의와 금액 초과를 실제 저장 전에 거부한다', () => {
    const f = configured()
    for (const bad of [{ unitCost: null }, { unitCost: -1 }, { unitCost: '100' }, { unitCost: 1.001 }, { expectedDeliveryDate: '2026-02-30' }, { internalUnitCost: 5000 }]) expect(() => validateProductionConditionsInput({ ...quote(), ...bad } as ProductionConditionsInput)).toThrow()
    expect(() => submitProductionConditionsInWorkspace(f.workspace, f.factory, f.id, 2, 3, 1, { ...quote(), agreed: false })).toThrow('체크')
    expect(() => submitProductionConditionsInWorkspace(f.workspace, f.factory, f.id, 2, 3, 1, { ...quote(), confirmedQuantities: emptyQuantities() })).toThrow('수량')
  })
  it('원본 워크스페이스를 변경하지 않으며 공장용 클라우드 자료는 본사 원장 없이도 조회한다', () => {
    const f = configured(), before = structuredClone(f.workspace)
    submitProductionConditionsInWorkspace(f.workspace, f.factory, f.id, 2, 3, 1, quote())
    expect(f.workspace).toEqual(before)
    const publicView = { ...f.workspace, productionRuns: [], ...scopeProductionConditionsWorkspace(f.workspace, f.factory) }
    expect(getProductionCondition(publicView, f.id)).toMatchObject({ runId: f.id, status: 'awaiting_supplier', version: 1 })
  })
})
