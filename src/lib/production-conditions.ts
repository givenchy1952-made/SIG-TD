import type { ProductionRun } from './production-ledger'
import type { SupplierAcceptance, SupplierOrder } from './supplier-orders'
import { getDemoSupplierProductionOrders } from './supplier-orders'
import { assertActive } from './permissions'
import { validateOperationReason } from './operations-domain'
import { emptyQuantities, quantityTotal, SIZES, type Profile, type Quantities, type Workspace } from './types'
import type { PoDispatch } from './operations-types'

export type ProductionMode = 'full_package' | 'cmt'
export type ProductionConditionStatus = 'awaiting_po' | 'awaiting_supplier' | 'awaiting_approval' | 'revision_requested' | 'approved' | 'rejected' | 'closed' | 'assignment_changed'
export type ProductionConditionDecision = 'approve' | 'request_revision' | 'reject'
export interface ProductionConditionsInput {
  expectedDeliveryDate: string; unitCost: number; canProduce: boolean; quantityConfirmed: boolean; agreed: boolean;
  comment: string; delayReason: string; priceReason: string; confirmedQuantities: Quantities;
}
export interface ProductionConditionProposal extends ProductionConditionsInput {
  id: string; actorId: string; actorName: string; submittedAt: string;
  termsSnapshot: Record<string, unknown>; poSnapshot: Record<string, unknown>;
}
export interface ProductionConditionApproval {
  id: string; finalDeliveryDate: string; unitCost: number; approvedBy: string; approvedByName: string; approvedAt: string;
  termsSnapshot: Record<string, unknown>; poSnapshot: Record<string, unknown>;
}
export interface ProductionConditionTimeline {
  id: string; action: string; actorId: string; actorName: string; createdAt: string; reason: string;
  before?: unknown; after?: unknown; data?: Record<string, unknown>;
}
export interface ProductionConditionChangeRequest {
  id: string; reason: string; actorId: string; actorName: string; requestedAt: string; correctingRunId: string | null;
}
export interface ProductionCondition {
  runId: string; runVersion: number; poVersion: number | null; version: number; productionMode: ProductionMode | null;
  status: ProductionConditionStatus; legacy: boolean; internalUnitCost?: number | null;
  proposal: ProductionConditionProposal | null; approval: ProductionConditionApproval | null;
  timeline: ProductionConditionTimeline[]; changeRequests: ProductionConditionChangeRequest[];
  changeRequestId?: string | null; priorRunId?: string | null;
}
export interface ProductionConditionsFields { productionConditions?: ProductionCondition[]; productionConditionsAvailable?: boolean }
export const PRODUCTION_CONDITION_STATUS_LABEL: Record<ProductionConditionStatus, string> = {
  awaiting_po: 'PO 발송 대기', awaiting_supplier: '업체 회신 대기', awaiting_approval: '본사 최종 승인 대기',
  revision_requested: '업체 재협의 요청', approved: '생산 승인 완료 / 생산 진행 중', rejected: '발주 거절', closed: '마감 확정', assignment_changed: '공장 배정 변경',
}
export const PRODUCTION_MODE_LABEL: Record<ProductionMode, string> = { full_package: '완사입', cmt: '임가공 (CMT)' }
export function validProductionConditionDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}
export function productionDelayDays(requested: string, proposed: string): number | null {
  return validProductionConditionDate(requested) && validProductionConditionDate(proposed) ? Math.round((Date.parse(`${proposed}T00:00:00Z`) - Date.parse(`${requested}T00:00:00Z`)) / 86400000) : null
}
export function productionPriceDifference(internal: number | null | undefined, proposed: number | null | undefined): number | null {
  return internal === null || internal === undefined || proposed === null || proposed === undefined || !Number.isFinite(internal) || !Number.isFinite(proposed) ? null : Math.round((proposed - internal) * 100) / 100
}
function validateCost(value: unknown, nullable: boolean): asserts value is number | null {
  if (nullable && value === null) return
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000 || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) throw new Error('단가는 미입력 또는 0~1,000,000,000원 범위의 소수 둘째 자리까지 입력해 주세요.')
}
function sameQuantities(left: Quantities, right: Quantities) { return SIZES.every(size => left[size] === right[size]) }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item)
/** Public production terms deliberately omit all HQ reference and garment costs. */
function productionTermsSnapshot(workspace: Workspace, run: ProductionRun, mode: ProductionMode): Record<string, unknown> {
  const color = workspace.styles.find(style => style.id === run.styleId)?.production.find(line => line.id === run.lineId)?.color || ''
  return { runId: run.id, styleId: run.styleId, lineId: run.lineId, projectId: run.projectId, projectCode: run.projectCode, projectName: workspace.projects.find(project => project.id === run.projectId)?.name || '', name: run.name, round: run.round, order: structuredClone(run.order), expectedDue: run.expectedDue, itemType: run.itemType, factoryId: run.factoryIdSnapshot, factoryName: run.factoryNameSnapshot, styleCode: run.styleCodeSnapshot, fullStyleCode: run.styleCodeSnapshot, color, productionMode: mode }
}
function productionPoSnapshot(po: PoDispatch): Record<string, unknown> {
  return { id: po.id, version: po.version, recipient: po.recipient, subject: po.subject, body: po.body, dueDate: po.dueDate, sentAt: po.sentAt, providerMessageId: po.providerMessageId, providerRequestId: po.providerRequestId || null, senderEmailSnapshot: po.senderEmailSnapshot || null, evidenceAttachmentId: po.evidenceAttachmentId, factoryId: po.factoryIdSnapshot, styleCode: po.styleCodeSnapshot }
}
export function validateProductionConditionsInput(value: ProductionConditionsInput): void {
  const keys = ['expectedDeliveryDate', 'unitCost', 'canProduce', 'quantityConfirmed', 'agreed', 'comment', 'delayReason', 'priceReason', 'confirmedQuantities']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('업체 회신 항목을 확인해 주세요.')
  if (!validProductionConditionDate(value.expectedDeliveryDate)) throw new Error('올바른 업체 예상 납기일을 입력해 주세요.')
  validateCost(value.unitCost, false)
  for (const key of ['canProduce', 'quantityConfirmed', 'agreed'] as const) if (typeof value[key] !== 'boolean') throw new Error('생산 가능 여부와 수량·조건 확인 항목을 선택해 주세요.')
  for (const key of ['comment', 'delayReason', 'priceReason'] as const) if (typeof value[key] !== 'string' || value[key].length > 5000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value[key])) throw new Error('업체 의견과 협의 사유는 각각 5,000자 이하로 입력해 주세요.')
  const q = value.confirmedQuantities
  if (!q || typeof q !== 'object' || Array.isArray(q) || Object.keys(q).length !== SIZES.length || !SIZES.every(size => Number.isSafeInteger(q[size]) && q[size] >= 0 && q[size] <= 10_000_000)) throw new Error('확인 수량은 XXS~XL의 0~10,000,000 정수로 입력해 주세요.')
}
function actorFor(workspace: Workspace, supplied: Profile) {
  const actor = workspace.profiles.find(person => person.id === supplied.id)
  if (!actor) throw new Error('계정을 확인해 주세요.')
  assertActive(actor); return actor
}
function orderVisible(workspace: Workspace, order: SupplierOrder, actor: Profile) {
  const style = workspace.styles.find(item => item.id === order.styleId && !item.deletedAt)
  return !!style && (actor.role !== 'factory' || !!actor.factoryId && actor.factoryId === order.factoryId && actor.factoryId === style.factoryId)
}
/** Rebuild public states from authoritative demo runs while preserving historical
 * starts as legacy records. No final approval is fabricated for old production. */
export function getDemoProductionConditions(workspace: Workspace): ProductionCondition[] {
  const orders = workspace.productionRuns?.length ? getDemoSupplierProductionOrders(workspace) : workspace.supplierProductionOrders || getDemoSupplierProductionOrders(workspace)
  return orders.map(order => {
    const previous = workspace.productionConditions?.find(condition => condition.runId === order.runId)
    const legacy = previous?.legacy ?? !!order.startedAt
    const status: ProductionConditionStatus = order.status === 'closed' ? 'closed' : order.status === 'assignment_changed' ? 'assignment_changed' : legacy || previous?.approval ? 'approved' : order.poStatus !== 'sent' || !order.sentAt ? 'awaiting_po' : previous && ['awaiting_approval', 'revision_requested', 'rejected'].includes(previous.status) ? previous.status : 'awaiting_supplier'
    const po = workspace.operations?.poDispatches.find(item => item.id === order.poId)
    const timeline = structuredClone(previous?.timeline || [])
    if (po?.status === 'sent' && po.sentAt && !timeline.some(event => event.action === '본사 PO 발송' && (event.id === `po:${po.id}` || event.id === `po-${po.id}` || (event.after as { poId?: string } | undefined)?.poId === po.id))) {
      timeline.push({ id: `po:${po.id}`, action: '본사 PO 발송', actorId: po.updatedBy, actorName: workspace.profiles.find(person => person.id === po.updatedBy)?.name || '본사', createdAt: po.sentAt, reason: '메일 서비스 발송 접수', after: { poId: po.id, poVersion: po.version } })
      timeline.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    }
    return { runId: order.runId, runVersion: order.runVersion, poVersion: order.poVersion, version: previous?.version || 0, productionMode: previous?.productionMode || null, status, legacy, internalUnitCost: previous?.internalUnitCost ?? null, proposal: previous?.proposal ? structuredClone(previous.proposal) : null, approval: previous?.approval ? structuredClone(previous.approval) : null, timeline: structuredClone(timeline), changeRequests: structuredClone(previous?.changeRequests || []), changeRequestId: previous?.changeRequestId || null, priorRunId: previous?.priorRunId || null }
  })
}
export function getProductionCondition(workspace: Workspace, runId: string): ProductionCondition {
  return getDemoProductionConditions(workspace).find(condition => condition.runId === runId) || workspace.productionConditions?.find(condition => condition.runId === runId) || { runId, runVersion: 0, poVersion: null, version: 0, productionMode: null, status: 'awaiting_po', legacy: false, internalUnitCost: null, proposal: null, approval: null, timeline: [], changeRequests: [] }
}
export function scopeProductionConditionsWorkspace(workspace: Workspace, supplied: Profile): ProductionConditionsFields {
  const actor = workspace.profiles.find(person => person.id === supplied.id)
  if (!actor?.approved || !actor.active) return { productionConditionsAvailable: workspace.productionConditionsAvailable, productionConditions: [] }
  const orders = workspace.supplierProductionOrders || getDemoSupplierProductionOrders(workspace)
  const visible = new Set(orders.filter(order => orderVisible(workspace, order, actor)).map(order => order.runId))
  const conditions = workspace.productionRuns?.length && workspace.productionLedgerAvailable ? getDemoProductionConditions(workspace) : workspace.productionConditions || []
  return { productionConditionsAvailable: workspace.productionConditionsAvailable, productionConditions: conditions.filter(condition => visible.has(condition.runId)).map(condition => {
    const result = structuredClone(condition)
    if (actor.role === 'factory') {
      delete result.internalUnitCost
      result.timeline = result.timeline.filter(event => event.action !== '본사 생산 방식·검토 단가 설정')
    }
    return result
  }) }
}
export function hasFinalProductionApproval(workspace: Workspace, runId: string): boolean {
  const condition = getProductionCondition(workspace, runId)
  if (!condition || !['approved', 'closed', 'assignment_changed'].includes(condition.status)) return false
  return !!condition.approval || condition.legacy && !!getDemoSupplierProductionOrders(workspace).find(order => order.runId === runId)?.startedAt
}
export function assertFinalProductionApproval(workspace: Workspace, runId: string): void {
  if (workspace.productionConditionsAvailable && !hasFinalProductionApproval(workspace, runId)) throw new Error('HQ_FINAL_APPROVAL_REQUIRED: 본사가 생산 조건을 최종 승인해야 생산·실입고·마감을 진행할 수 있습니다.')
}
export function assertApprovedProductionTermsUnchanged(workspace: Workspace, before: ProductionRun | undefined, after: ProductionRun): void {
  if (!before || !getProductionCondition(workspace, before.id)?.approval) return
  for (const key of ['styleId', 'lineId', 'projectId', 'projectCode', 'poId', 'order', 'expectedDue', 'unitCost', 'itemType', 'factoryIdSnapshot', 'styleCodeSnapshot'] as const) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) throw new Error('승인된 생산 조건은 수정할 수 없습니다. 별도 변경 요청과 재승인을 진행해 주세요.')
}
function context(workspace: Workspace, supplied: Profile, runId: string, runVersion: number, version: number) {
  const actor = actorFor(workspace, supplied), order = getDemoSupplierProductionOrders(workspace).find(item => item.runId === runId), run = workspace.productionRuns?.find(item => item.id === runId)
  if (!order || !run || !orderVisible(workspace, order, actor)) throw new Error('접근 가능한 생산 발주를 확인해 주세요.')
  const condition = getProductionCondition(workspace, runId)!
  if (!Number.isSafeInteger(runVersion) || run.version !== runVersion || !Number.isSafeInteger(version) || version < 0 || condition.version !== version) throw new Error('VERSION_CONFLICT')
  if (condition.status === 'assignment_changed') throw new Error('ASSIGNMENT_CHANGED: 공장 배정이 변경되었습니다. 새 발주를 확인해 주세요.')
  return { actor, order, run, condition }
}
function requireHQ(actor: Profile) { if (actor.role === 'factory') throw new Error('본사 담당자만 생산 조건을 검토·승인할 수 있습니다.') }
function put(workspace: Workspace, condition: ProductionCondition, actor: Profile, action: string, reason: string, bumpRun: boolean) {
  const next = structuredClone(workspace), now = new Date().toISOString()
  const prior = getProductionCondition(workspace, condition.runId)
  const before = action === '본사 생산 방식·검토 단가 설정' ? { productionMode: prior.productionMode, internalUnitCost: prior.internalUnitCost ?? null } : structuredClone(prior.proposal)
  const afterData = action === '본사 생산 방식·검토 단가 설정' ? { productionMode: condition.productionMode, internalUnitCost: condition.internalUnitCost ?? null } : action === '본사 최종 승인' ? structuredClone(condition.approval) : action === '승인 조건 변경 요청' ? structuredClone(condition.changeRequests.at(-1)) : { ...structuredClone(condition.proposal), status: condition.status }
  const event: ProductionConditionTimeline = { id: crypto.randomUUID(), action, actorId: actor.id, actorName: actor.name, createdAt: now, reason, before, after: afterData }
  const after = { ...structuredClone(condition), version: condition.version + 1, runVersion: condition.runVersion + (bumpRun ? 1 : 0), timeline: [...condition.timeline, event] }
  next.productionConditions = [...(next.productionConditions || []).filter(row => row.runId !== condition.runId), after]
  next.productionConditionsAvailable = true
  if (bumpRun) next.productionRuns = next.productionRuns?.map(run => run.id === condition.runId ? { ...run, version: run.version + 1, updatedAt: now, updatedBy: actor.id } : run)
  const run = next.productionRuns?.find(item => item.id === condition.runId)
  next.audits.unshift({ id: crypto.randomUUID(), styleId: run?.styleId || null, actorId: actor.id, actorName: actor.name, action, reason: '생산 조건 협의 절차', before: null, after: { runId: condition.runId, version: after.version, status: after.status }, createdAt: now })
  return next
}
export function configureProductionConditionsInWorkspace(workspace: Workspace, supplied: Profile, runId: string, runVersion: number, version: number, mode: ProductionMode, internalUnitCost: number | null, reason: string): Workspace {
  const { actor, order, condition } = context(workspace, supplied, runId, runVersion, version); requireHQ(actor); validateOperationReason(reason); validateCost(internalUnitCost, true)
  if (!['full_package', 'cmt'].includes(mode)) throw new Error('완사입 또는 임가공 생산 방식을 선택해 주세요.')
  if (condition.legacy || condition.approval || ['closed', 'rejected'].includes(condition.status) || condition.proposal && condition.productionMode !== mode) throw new Error('제출·승인된 생산 방식은 덮어쓸 수 없습니다. 수정 요청 또는 새 발주를 진행해 주세요.')
  const po = workspace.operations?.poDispatches.find(item => item.id === order.poId)
  if (condition.productionMode && condition.productionMode !== mode && po && (po.attempts > 0 || po.status !== 'draft')) throw new Error('발송을 시도한 PO의 생산 방식은 변경할 수 없습니다. 별도 차수로 발주해 주세요.')
  return put(workspace, { ...condition, productionMode: mode, internalUnitCost }, actor, '본사 생산 방식·검토 단가 설정', reason.trim(), true)
}
export function submitProductionConditionsInWorkspace(workspace: Workspace, supplied: Profile, runId: string, runVersion: number, poVersion: number, version: number, data: ProductionConditionsInput): Workspace {
  const { actor, order, run, condition } = context(workspace, supplied, runId, runVersion, version)
  if (actor.role !== 'factory') throw new Error('배정된 업체 계정으로 생산 조건을 제출해 주세요.')
  validateProductionConditionsInput(data)
  if (condition.legacy || condition.approval || !['awaiting_supplier', 'revision_requested'].includes(condition.status)) throw new Error('현재 생산 조건은 업체 회신을 제출할 수 없는 상태입니다.')
  if (!condition.productionMode) throw new Error('본사에서 완사입·임가공 생산 방식을 먼저 설정해야 합니다.')
  if (order.poVersion !== poVersion || !Number.isSafeInteger(poVersion)) throw new Error('VERSION_CONFLICT')
  if (!order.poId || order.poStatus !== 'sent' || !order.sentAt || quantityTotal(order.order) <= 0) throw new Error('발송된 PO와 오더 수량을 확인해 주세요.')
  if (!data.agreed) throw new Error('생산 조건 동의 항목에 체크해 주세요.')
  if (data.quantityConfirmed && !sameQuantities(data.confirmedQuantities, order.order)) throw new Error('확인한 사이즈별 수량이 PO 수량과 다릅니다.')
  if (data.unitCost * quantityTotal(order.order) > 1_000_000_000_000) throw new Error('한 생산 차수의 금액은 1조 원 이하여야 합니다.')
  const po = workspace.operations!.poDispatches.find(item => item.id === order.poId)!
  const proposal: ProductionConditionProposal = { ...structuredClone(data), id: crypto.randomUUID(), actorId: actor.id, actorName: actor.name, submittedAt: new Date().toISOString(), termsSnapshot: productionTermsSnapshot(workspace, run, condition.productionMode), poSnapshot: productionPoSnapshot(po) }
  return put(workspace, { ...condition, status: 'awaiting_approval', proposal }, actor, condition.proposal ? '업체 수정 조건 재제출' : '업체 생산 조건 최초 제출', data.comment.trim() || '생산 조건 회신', true)
}
export function reviewProductionConditionsInWorkspace(workspace: Workspace, supplied: Profile, runId: string, runVersion: number, version: number, decision: ProductionConditionDecision, finalDeliveryDate: string, finalUnitCost: number | null, reason: string): Workspace {
  const { actor, order, run, condition } = context(workspace, supplied, runId, runVersion, version); requireHQ(actor); validateOperationReason(reason)
  if (!['approve', 'request_revision', 'reject'].includes(decision)) throw new Error('승인·수정 요청·거절 중 선택해 주세요.')
  if (condition.legacy || condition.approval || condition.status !== 'awaiting_approval' || !condition.proposal || !condition.productionMode) throw new Error('검토할 업체 회신을 확인해 주세요.')
  const proposal = condition.proposal
  const po = workspace.operations?.poDispatches.find(item => item.id === order.poId)
  if (!po || po.status !== 'sent' || po.voided || po.factoryIdSnapshot !== run.factoryIdSnapshot || proposal.poSnapshot?.id !== po.id || proposal.poSnapshot?.version !== po.version) throw new Error('PO_NOT_SENT: 회신 당시 발송된 PO와 현재 PO 기록을 확인해 주세요.')
  if (decision !== 'approve') return put(workspace, { ...condition, status: decision === 'reject' ? 'rejected' : 'revision_requested' }, actor, decision === 'reject' ? '발주 거절' : '본사 수정 요청', reason.trim(), true)
  if (canonical(proposal.termsSnapshot) !== canonical(productionTermsSnapshot(workspace, run, condition.productionMode))) throw new Error('PRODUCTION_CONDITIONS_CHANGED: 회신 당시 생산 조건이 변경되었습니다. 수정 요청 후 업체가 현재 조건을 다시 확인해야 합니다.')
  validateCost(finalUnitCost, false)
  if (finalUnitCost! * quantityTotal(run.order) > 1_000_000_000_000) throw new Error('한 생산 차수의 금액은 1조 원 이하여야 합니다.')
  if (!validProductionConditionDate(finalDeliveryDate)) throw new Error('최종 승인 납기일을 입력해 주세요.')
  if (!proposal.canProduce || !proposal.quantityConfirmed || !proposal.agreed || !sameQuantities(proposal.confirmedQuantities, run.order)) throw new Error('업체의 생산 가능·수량 확인·조건 동의와 사이즈별 발주 수량을 확인해 주세요.')
  if (!order.poId || order.poStatus !== 'sent' || !order.sentAt) throw new Error('발송된 PO를 먼저 확인해 주세요.')
  if (workspace.productionReceipts?.some(receipt => receipt.runId === runId) || order.startedAt) throw new Error('실입고·생산 시작 기록이 있는 차수의 승인 조건은 변경할 수 없습니다.')
  const now = new Date().toISOString(), poSnapshot = productionPoSnapshot(po)
  const termsSnapshot = { ...productionTermsSnapshot(workspace, run, condition.productionMode), requestedDeliveryDate: order.requestedDue, proposedDeliveryDate: proposal.expectedDeliveryDate, finalDeliveryDate, proposedUnitCost: proposal.unitCost, finalUnitCost, unitCost: finalUnitCost, supplierActorId: proposal.actorId, supplierActorName: proposal.actorName, submittedAt: proposal.submittedAt, approvedBy: actor.id, approvedAt: now }
  const approval: ProductionConditionApproval = { id: crypto.randomUUID(), finalDeliveryDate, unitCost: finalUnitCost!, approvedBy: actor.id, approvedByName: actor.name, approvedAt: now, termsSnapshot, poSnapshot }
  const next = put(workspace, { ...condition, status: 'approved', approval }, actor, '본사 최종 승인', reason.trim(), true)
  next.productionConditions = next.productionConditions?.map(item => item.runId === runId ? { ...item, timeline: [...item.timeline, { id: crypto.randomUUID(), action: '생산 시작', actorId: actor.id, actorName: actor.name, createdAt: now, reason: '본사 최종 승인에 따른 생산 시작' }] } : item)
  next.productionRuns = next.productionRuns?.map(item => item.id === runId ? { ...item, unitCost: finalUnitCost! } : item)
  const acceptance: SupplierAcceptance = { id: proposal.id, expectedDeliveryDate: proposal.expectedDeliveryDate, acceptedAt: proposal.submittedAt, actorId: proposal.actorId, actorName: proposal.actorName, actorEmail: workspace.profiles.find(person => person.id === proposal.actorId)?.email || '', factoryId: run.factoryIdSnapshot, runVersion, poVersion: po.version, poSnapshot: structuredClone(proposal.poSnapshot), termsSnapshot: structuredClone(proposal.termsSnapshot) }
  next.supplierProductionOrders = [...getDemoSupplierProductionOrders(next).filter(item => item.runId !== runId), { ...order, runVersion: runVersion + 1, status: 'in_progress', acceptance, startedAt: now, startedBy: actor.id, startedByName: actor.name }]
  return next
}
export function requestProductionConditionChangeInWorkspace(workspace: Workspace, supplied: Profile, runId: string, runVersion: number, version: number, reason: string): Workspace {
  const { actor, condition } = context(workspace, supplied, runId, runVersion, version); validateOperationReason(reason)
  if (!condition.approval && !condition.legacy || !['approved', 'closed'].includes(condition.status)) throw new Error('승인된 생산 조건에서 변경을 요청해 주세요.')
  const request: ProductionConditionChangeRequest = { id: crypto.randomUUID(), reason: reason.trim(), actorId: actor.id, actorName: actor.name, requestedAt: new Date().toISOString(), correctingRunId: null }
  return put(workspace, { ...condition, changeRequests: [...condition.changeRequests, request] }, actor, '승인 조건 변경 요청', reason.trim(), false)
}
export function linkProductionConditionChangeInWorkspace(workspace: Workspace, supplied: Profile, requestId: string, replacementRunId: string, replacementRunVersion: number, reason: string, confirmedNewScope: boolean): Workspace {
  const actor = actorFor(workspace, supplied); requireHQ(actor); validateOperationReason(reason)
  if (confirmedNewScope !== true) throw new Error('신규 차수의 오더 수량과 집계 범위를 확인해 주세요.')
  const conditions = getDemoProductionConditions(workspace), original = conditions.find(condition => condition.changeRequests.some(request => request.id === requestId))
  const request = original?.changeRequests.find(item => item.id === requestId)
  const prior = workspace.productionRuns?.find(run => run.id === original?.runId), replacement = workspace.productionRuns?.find(run => run.id === replacementRunId)
  const order = getDemoSupplierProductionOrders(workspace).find(item => item.runId === replacementRunId)
  if (!original || !request || request.correctingRunId || !prior || !replacement || !order || !orderVisible(workspace, order, actor)) throw new Error('연결할 변경 요청과 새로운 생산 차수를 확인해 주세요.')
  if (replacement.version !== replacementRunVersion) throw new Error('VERSION_CONFLICT')
  if (replacement.id === prior.id || replacement.styleId !== prior.styleId || replacement.lineId !== prior.lineId || replacement.projectId !== prior.projectId || replacement.factoryIdSnapshot !== prior.factoryIdSnapshot || replacement.closedAt || order.startedAt || workspace.productionReceipts?.some(receipt => receipt.runId === replacementRunId)) throw new Error('같은 프로젝트·품번·컬러·업체의 아직 시작하지 않은 새 차수만 연결할 수 있습니다.')
  const target = conditions.find(condition => condition.runId === replacementRunId)!
  if (target.proposal || target.approval || target.legacy || target.status === 'rejected' || target.changeRequestId || conditions.some(condition => condition.changeRequests.some(item => item.correctingRunId === replacementRunId))) throw new Error('이미 회신·승인되었거나 다른 변경 요청에 연결된 차수입니다.')
  let next = put(workspace, { ...original, changeRequests: original.changeRequests.map(item => item.id === requestId ? { ...item, correctingRunId: replacementRunId } : item) }, actor, '변경 요청의 새 차수 연결', reason.trim(), false)
  next = put(next, { ...target, changeRequestId: requestId, priorRunId: prior.id }, actor, '재승인 생산 차수 연결', reason.trim(), true)
  return next
}
export function blankProductionConditionsInput(): ProductionConditionsInput {
  return { expectedDeliveryDate: '', unitCost: 0, canProduce: true, quantityConfirmed: false, agreed: false, comment: '', delayReason: '', priceReason: '', confirmedQuantities: emptyQuantities() }
}
