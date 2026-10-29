import type { Profile, Quantities, Workspace } from './types'
import { SIZES, quantityTotal } from './types'
import { canViewStyle } from './permissions'
import { validateOperationReason } from './operations-domain'
import { validateRunQuantities } from './production-ledger'
import { fullStyleSku } from './style-identity'
import type { ProductionRun } from './production-ledger'
import type { PoDispatch } from './operations-types'

export interface ProductionPoSourceLine { lineId: string; color: string; styleCode: string; order: Quantities }
export interface ProductionPoContext {
  poId: string; source: 'style' | 'run'; capturedAt: string;
  snapshot: { styleId: string; projectId: string; projectCode: string; factoryId: string; runId: string | null; lineId: string | null; styleCode: string; color: string | null; order: Quantities | null; lines: ProductionPoSourceLine[]; productionMode: 'full_package' | 'cmt' | null }
}
export interface ProductionPoLinkFields { productionPoContexts?: ProductionPoContext[]; productionPoLinksAvailable?: boolean; productionPoRecoveryAvailable?: boolean }
export interface ProductionPoLinkConfirmation { documentConfirmed: boolean; scopeDifferenceConfirmed: boolean; sourceSnapshotMissingConfirmed: boolean; projectId: string; styleCode: string; color: string; factoryId: string; order: Quantities }
type LinkWorkspace = Workspace & ProductionPoLinkFields
const sameQuantities = (left: Quantities, right: Quantities) => SIZES.every(size => left[size] === right[size])

export function captureStylePoContextInWorkspace(workspace: LinkWorkspace, poId: string): LinkWorkspace {
  const po = workspace.operations?.poDispatches.find(item => item.id === poId), style = workspace.styles.find(item => item.id === po?.styleId)
  if (!po || !style || workspace.productionPoLinksAvailable !== true || workspace.productionPoContexts?.some(item => item.poId === poId)) return workspace
  const project = workspace.projects.find(item => item.id === style.projectId)
  const context: ProductionPoContext = { poId, source: 'style', capturedAt: new Date().toISOString(), snapshot: {
    styleId: style.id, projectId: style.projectId, projectCode: project?.code || '', factoryId: po.factoryIdSnapshot,
    runId: null, lineId: null, styleCode: po.styleCodeSnapshot, color: null, order: null, productionMode: null,
    lines: style.production.map(line => ({ lineId: line.id, color: line.color, styleCode: fullStyleSku(style.code, line.color), order: structuredClone(line.order) })),
  } }
  return { ...workspace, productionPoContexts: [...(workspace.productionPoContexts || []), context] }
}
export function captureRunPoContextInWorkspace(workspace: LinkWorkspace, runId: string, mode: 'full_package' | 'cmt' | null): LinkWorkspace {
  const run = workspace.productionRuns?.find(item => item.id === runId), po = workspace.operations?.poDispatches.find(item => item.id === run?.poId)
  const line = workspace.styles.find(item => item.id === run?.styleId)?.production.find(item => item.id === run?.lineId)
  if (!run || !po || !line || workspace.productionPoLinksAvailable !== true) return workspace
  if (po.status !== 'draft' || po.attempts > 0) throw new Error('발송을 시도한 PO 원본 정보는 변경할 수 없습니다.')
  const context: ProductionPoContext = { poId: po.id, source: 'run', capturedAt: new Date().toISOString(), snapshot: {
    styleId: run.styleId, projectId: run.projectId, projectCode: run.projectCode, factoryId: run.factoryIdSnapshot,
    runId: run.id, lineId: run.lineId, styleCode: run.styleCodeSnapshot, color: line.color, order: structuredClone(run.order), lines: [], productionMode: mode,
  } }
  return { ...workspace, productionPoContexts: [...(workspace.productionPoContexts || []).filter(item => item.poId !== po.id), context] }
}

export function scopeProductionPoLinks(workspace: LinkWorkspace, supplied: Profile): ProductionPoLinkFields {
  const actor = workspace.profiles.find(item => item.id === supplied.id)
  const ids = new Set(actor?.active && actor.approved && actor.role !== 'factory' ? workspace.styles.filter(style => canViewStyle(actor, style)).map(style => style.id) : [])
  return { productionPoLinksAvailable: workspace.productionPoLinksAvailable, productionPoRecoveryAvailable: workspace.productionPoRecoveryAvailable, productionPoContexts: (workspace.productionPoContexts || []).filter(context => ids.has(context.snapshot.styleId)) }
}

/** Only an archived draft with no dispatch or production history is recoverable.
 * The server repeats these checks under locks before changing the linkage. */
export function getArchivedProductionPoCandidate(workspace: LinkWorkspace, run: ProductionRun): PoDispatch | null {
  const po = workspace.operations?.poDispatches.find(item => item.id === run.poId)
  const condition = workspace.productionConditions?.find(item => item.runId === run.id)
  if (run.closedAt || !po || !po.voided || po.status !== 'draft' || po.attempts !== 0 || po.sentAt || po.providerMessageId != null || po.providerRequestId != null || po.senderEmailSnapshot != null || po.lastError != null || po.styleId !== run.styleId || po.factoryIdSnapshot !== run.factoryIdSnapshot) return null
  if (workspace.operations?.poDispatchAttempts.some(item => item.dispatchId === po.id) || workspace.productionReceipts?.some(item => item.runId === run.id)) return null
  if (workspace.productionRuns?.some(item => item.id !== run.id && item.poId === po.id)) return null
  if (workspace.supplierProductionOrders?.some(item => item.runId === run.id && (item.acceptance || item.startedAt))) return null
  if (condition?.legacy || condition?.proposal || condition?.approval || condition?.changeRequests.length || condition?.changeRequestId || condition?.priorRunId || condition && ['awaiting_approval', 'revision_requested', 'approved', 'rejected', 'closed'].includes(condition.status)) return null
  return po
}

export function replaceArchivedProductionPoLinkInWorkspace(workspace: LinkWorkspace, supplied: Profile, runId: string, previousPoId: string, poId: string, expectedRunVersion: number, expectedPreviousPoVersion: number, expectedPoVersion: number, confirmation: ProductionPoLinkConfirmation, reason: string): LinkWorkspace {
  const actor = workspace.profiles.find(item => item.id === supplied.id)
  if (!actor?.active || !actor.approved || actor.role === 'factory') throw new Error('생산 차수 PO 연결 교체는 승인된 본사만 가능합니다.')
  if (workspace.productionPoRecoveryAvailable !== true) throw new Error('보관된 PO 연결 복구 설정을 먼저 적용해 주세요.')
  const run = workspace.productionRuns?.find(item => item.id === runId)
  const previous = workspace.operations?.poDispatches.find(item => item.id === previousPoId)
  if (!run || !previous || run.version !== expectedRunVersion || previous.version !== expectedPreviousPoVersion || run.poId !== previousPoId) throw new Error('VERSION_CONFLICT')
  if (!getArchivedProductionPoCandidate(workspace, run)) throw new Error('발송·협의·생산·입고 이력이 없는 보관된 초안만 연결을 교체할 수 있습니다.')
  const temporary = structuredClone(workspace)
  temporary.productionRuns = temporary.productionRuns!.map(item => item.id === runId ? { ...item, poId: null } : item)
  // Reuse the complete sent-document validation; a failure never persists the temporary unlink.
  const next = linkProductionPoInWorkspace(temporary, supplied, runId, poId, expectedRunVersion, expectedPoVersion, confirmation, reason)
  next.audits.unshift({ id: crypto.randomUUID(), styleId: run.styleId, actorId: actor.id, actorName: actor.name, action: '보관된 생산 차수 PO 연결 교체', reason: reason.trim(), before: { runId, poId: previous.id, poVersion: previous.version }, after: { runId, poId, previousPoId, confirmation: structuredClone(confirmation) }, createdAt: new Date().toISOString() })
  return next
}
/** Link only after the reviewer checks the actual sent document. A style snapshot
 * identifies its capture scope; it does not prove the mail body contained it. */
export function linkProductionPoInWorkspace(workspace: LinkWorkspace, supplied: Profile, runId: string, poId: string, expectedRunVersion: number, expectedPoVersion: number, confirmation: ProductionPoLinkConfirmation, reason: string): LinkWorkspace {
  const actor = workspace.profiles.find(item => item.id === supplied.id)
  if (!actor?.active || !actor.approved || actor.role === 'factory') throw new Error('생산 차수 PO 연결은 승인된 본사만 가능합니다.')
  validateOperationReason(reason); validateRunQuantities(confirmation.order)
  const run = workspace.productionRuns?.find(item => item.id === runId), po = workspace.operations?.poDispatches.find(item => item.id === poId)
  const style = run && workspace.styles.find(item => item.id === run.styleId && canViewStyle(actor, item))
  if (!run || !po || !style || po.styleId !== style.id) throw new Error('같은 스타일의 생산 차수와 PO를 확인해 주세요.')
  if (run.version !== expectedRunVersion || po.version !== expectedPoVersion) throw new Error('VERSION_CONFLICT')
  if (run.closedAt || run.poId || workspace.productionRuns?.some(item => item.poId === poId)) throw new Error('이미 연결되거나 마감된 생산 차수·PO는 다시 연결할 수 없습니다.')
  if (po.status !== 'sent' || po.voided || po.factoryIdSnapshot !== run.factoryIdSnapshot || style.factoryId !== run.factoryIdSnapshot) throw new Error('발송된 동일 공장의 PO만 연결할 수 있습니다.')
  if (workspace.productionReceipts?.some(item => item.runId === runId) || workspace.supplierProductionOrders?.some(item => item.runId === runId && (item.acceptance || item.startedAt))) throw new Error('이미 생산이 시작되거나 입고된 차수는 연결을 변경할 수 없습니다.')
  const conditions = workspace.productionConditions?.find(item => item.runId === runId)
  if (conditions?.proposal || conditions?.approval || conditions?.status === 'rejected') throw new Error('이미 협의가 제출되거나 거절된 차수의 PO는 변경할 수 없습니다.')
  const line = style.production.find(item => item.id === run.lineId)
  if (!line || !confirmation.documentConfirmed || confirmation.projectId !== run.projectId || confirmation.styleCode !== run.styleCodeSnapshot || confirmation.color !== line.color || confirmation.factoryId !== run.factoryIdSnapshot || !sameQuantities(confirmation.order, run.order) || quantityTotal(run.order) <= 0) throw new Error('실제 발송 문서의 프로젝트·품번·컬러·업체·차수 수량을 확인해 주세요.')
  const source = workspace.productionPoContexts?.find(item => item.poId === poId)
  if (!source && !confirmation.sourceSnapshotMissingConfirmed) throw new Error('기존 PO의 발송 문서를 확인하고 원본 비교 정보 미등록 여부에 동의해 주세요.')
  let differs = !sameQuantities(line.order, run.order)
  if (source) {
    const snapshot = source.snapshot
    if (snapshot.styleId !== style.id || snapshot.projectId !== run.projectId || snapshot.factoryId !== run.factoryIdSnapshot || snapshot.projectCode && snapshot.projectCode !== run.projectCode) throw new Error('PO 원본의 프로젝트·업체가 생산 차수와 다릅니다.')
    if (source.source === 'run') {
      if (snapshot.runId !== run.id || snapshot.lineId !== run.lineId || snapshot.styleCode !== run.styleCodeSnapshot || snapshot.color !== line.color || !snapshot.order || !sameQuantities(snapshot.order, run.order)) throw new Error('PO 원본의 품번·컬러·사이즈별 수량이 생산 차수와 다릅니다.')
    } else {
      const originalLine = snapshot.lines.find(item => item.lineId === run.lineId && item.styleCode === run.styleCodeSnapshot && item.color === line.color)
      if (!originalLine) throw new Error('PO 원본에 해당 품번·컬러가 없습니다.')
      differs ||= !sameQuantities(originalLine.order, run.order)
    }
  }
  if (differs && !confirmation.scopeDifferenceConfirmed) throw new Error('메인 누적 수량과 차수 수량의 집계 범위 차이를 확인해 주세요.')
  const next = structuredClone(workspace), now = new Date().toISOString()
  const updated = { ...run, poId, version: run.version + 1, updatedAt: now, updatedBy: actor.id }
  next.productionRuns = next.productionRuns!.map(item => item.id === runId ? updated : item)
  next.audits.unshift({ id: crypto.randomUUID(), styleId: style.id, actorId: actor.id, actorName: actor.name, action: '생산 차수 PO 확인 연결', reason: reason.trim(), before: null, after: { runId, poId, verification: source ? source.source : 'legacy_document_confirmed', confirmation: structuredClone(confirmation) }, createdAt: now })
  return next
}
