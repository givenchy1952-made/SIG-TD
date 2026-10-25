import type { PoDispatchInput, PoDispatchStatus } from './operations-types'
import type { ProductionLedgerWorkspace, ProductionRun } from './production-ledger'
import { savePoInWorkspace } from './operations-domain'
import { assertActive } from './permissions'
import { quantityTotal, type Profile, type Quantities, type Workspace } from './types'

export type SupplierOrderStatus = 'awaiting_po' | 'awaiting_acceptance' | 'accepted' | 'in_progress' | 'closed' | 'assignment_changed'
export interface SupplierAcceptance {
  id: string; expectedDeliveryDate: string; acceptedAt: string; actorId: string; actorName: string; actorEmail: string; factoryId: string
  runVersion: number; poVersion: number; poSnapshot: Record<string, unknown>; termsSnapshot: Record<string, unknown>
}
export interface SupplierOrder {
  runId: string; styleId: string; lineId: string; projectId: string; projectCode: string; projectName: string; name: string; round: number
  order: Quantities; expectedDue: string; factoryId: string; factoryName: string; styleCode: string; runVersion: number
  poId: string | null; poVersion: number | null; poStatus: PoDispatchStatus | null; requestedDue: string; subject: string; body: string; sentAt: string | null
  status: SupplierOrderStatus; acceptance: SupplierAcceptance | null; startedAt: string | null; startedBy: string | null; startedByName: string | null
}
export interface SupplierOrderFields { supplierProductionOrders?: SupplierOrder[]; supplierOrdersAvailable?: boolean }
export type SupplierOrderWorkspace = ProductionLedgerWorkspace & SupplierOrderFields

function liveActor(workspace: Workspace, profile: Profile): Profile {
  const actor = workspace.profiles.find(person => person.id === profile.id)
  if (!actor) throw new Error('계정을 확인해 주세요.')
  assertActive(actor); return actor
}
function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}
/** Rebuild nonfinancial views after any demo ledger/PO mutation; never copy prices. */
export function getDemoSupplierProductionOrders(workspace: SupplierOrderWorkspace): SupplierOrder[] {
  if (!workspace.productionRuns || workspace.productionLedgerAvailable !== true) return structuredClone(workspace.supplierProductionOrders || [])
  return workspace.productionRuns.map(run => {
    const prior = workspace.supplierProductionOrders?.find(order => order.runId === run.id)
    const style = workspace.styles.find(style => style.id === run.styleId)
    const po = workspace.operations?.poDispatches.find(po => po.id === run.poId)
    const acceptance = prior?.acceptance || null, startedAt = prior?.startedAt || null
    let status: SupplierOrderStatus = run.closedAt ? 'closed' : style?.factoryId !== run.factoryIdSnapshot ? 'assignment_changed' : !po || po.status !== 'sent' || po.voided || po.factoryIdSnapshot !== run.factoryIdSnapshot ? 'awaiting_po' : !acceptance ? 'awaiting_acceptance' : !startedAt ? 'accepted' : 'in_progress'
    if (!style || style.deletedAt) status = 'assignment_changed'
    return {
      runId: run.id, styleId: run.styleId, lineId: run.lineId, projectId: run.projectId, projectCode: run.projectCode,
      projectName: workspace.projects.find(project => project.id === run.projectId)?.name || '', name: run.name, round: run.round,
      order: structuredClone(run.order), expectedDue: run.expectedDue, factoryId: run.factoryIdSnapshot, factoryName: run.factoryNameSnapshot,
      styleCode: run.styleCodeSnapshot, runVersion: run.version, poId: run.poId, poVersion: po?.version ?? null, poStatus: po?.status || null,
      requestedDue: po?.dueDate || '', subject: po?.subject || '', body: po?.body || '', sentAt: po?.sentAt || null,
      status, acceptance: structuredClone(acceptance), startedAt, startedBy: prior?.startedBy || null, startedByName: prior?.startedByName || null,
    }
  })
}
export function scopeSupplierOrders(workspace: SupplierOrderWorkspace, profile: Profile): SupplierOrderFields {
  const all = workspace.supplierProductionOrders || getDemoSupplierProductionOrders(workspace)
  if (!profile.active || !profile.approved) return { supplierProductionOrders: [], supplierOrdersAvailable: workspace.supplierOrdersAvailable }
  const orders = all.filter(order => {
    const style = workspace.styles.find(style => style.id === order.styleId && !style.deletedAt)
    return !!style && (profile.role !== 'factory' || !!profile.factoryId && order.factoryId === profile.factoryId && style.factoryId === profile.factoryId)
  })
  return { supplierProductionOrders: orders.map(order => profile.role === 'factory' && order.poStatus !== 'sent' ? { ...order, subject: '', body: '', requestedDue: '', sentAt: null } : order), supplierOrdersAvailable: workspace.supplierOrdersAvailable }
}
function orderFor(workspace: SupplierOrderWorkspace, runId: string, version: number) {
  const order = getDemoSupplierProductionOrders(workspace).find(order => order.runId === runId)
  if (!order) throw new Error('생산 발주를 확인해 주세요.')
  if (!Number.isSafeInteger(version) || order.runVersion !== version) throw new Error('VERSION_CONFLICT')
  return order
}
function replaceOrder(workspace: SupplierOrderWorkspace, order: SupplierOrder, actor: Profile, action: string, now: string) {
  workspace.supplierProductionOrders = [...getDemoSupplierProductionOrders(workspace).filter(item => item.runId !== order.runId), order]
  workspace.productionRuns = workspace.productionRuns?.map(run => run.id === order.runId ? { ...run, version: order.runVersion + 1, updatedAt: now, updatedBy: actor.id } : run)
  workspace.audits.unshift({ id: crypto.randomUUID(), styleId: order.styleId, actorId: actor.id, actorName: actor.name, action, reason: '발송된 PO 확인 및 업체의 명시적인 생산 동의 절차', before: null, after: { runId: order.runId, acceptanceId: order.acceptance?.id, expectedDeliveryDate: order.acceptance?.expectedDeliveryDate, startedAt: order.startedAt }, createdAt: now })
  return workspace
}
export function acceptSupplierOrderInWorkspace(workspace: SupplierOrderWorkspace, supplied: Profile, runId: string, runVersion: number, poVersion: number, expectedDeliveryDate: string, agreed: boolean): SupplierOrderWorkspace {
  const actor = liveActor(workspace, supplied), order = orderFor(workspace, runId, runVersion)
  const style = workspace.styles.find(style => style.id === order.styleId && !style.deletedAt)
  if (actor.role !== 'factory' || !actor.factoryId || actor.factoryId !== order.factoryId || style?.factoryId !== actor.factoryId) throw new Error('배정된 업체 계정으로만 생산 동의를 제출할 수 있습니다.')
  if (agreed !== true) throw new Error('PO 내용을 확인하고 생산 동의 항목에 체크해 주세요.')
  if (!validDate(expectedDeliveryDate)) throw new Error('예상 납기일을 입력해 주세요.')
  if (order.acceptance || order.status === 'closed') throw new Error('기록된 생산 동의는 변경할 수 없습니다. 조건 변경 시 새 차수로 발주해 주세요.')
  if (order.status !== 'awaiting_acceptance' || !order.poId || !order.sentAt || order.poStatus !== 'sent') throw new Error('발송 완료된 PO를 먼저 확인해 주세요.')
  if (order.poVersion !== poVersion) throw new Error('VERSION_CONFLICT')
  if (quantityTotal(order.order) === 0) throw new Error('발주 수량을 먼저 입력해 주세요.')
  const next = structuredClone(workspace), now = new Date().toISOString(), po = workspace.operations!.poDispatches.find(item => item.id === order.poId)!
  order.acceptance = { id: crypto.randomUUID(), expectedDeliveryDate, acceptedAt: now, actorId: actor.id, actorName: actor.name, actorEmail: actor.email, factoryId: actor.factoryId,
    runVersion, poVersion, poSnapshot: { id: po.id, version: po.version, recipient: po.recipient, subject: po.subject, body: po.body, dueDate: po.dueDate, sentAt: po.sentAt, providerMessageId: po.providerMessageId, evidenceAttachmentId: po.evidenceAttachmentId, factoryId: po.factoryIdSnapshot, styleCode: po.styleCodeSnapshot },
    termsSnapshot: { runId: order.runId, styleId: order.styleId, lineId: order.lineId, projectId: order.projectId, projectCode: order.projectCode, projectName: order.projectName, name: order.name, round: order.round, order: structuredClone(order.order), expectedDue: order.expectedDue, factoryId: order.factoryId, factoryName: order.factoryName, styleCode: order.styleCode } }
  order.status = 'in_progress'; order.startedAt = now; order.startedBy = actor.id; order.startedByName = actor.name
  return replaceOrder(next, order, actor, '업체 생산 동의', now)
}
export function startSupplierOrderInWorkspace(workspace: SupplierOrderWorkspace, supplied: Profile, runId: string, runVersion: number): SupplierOrderWorkspace {
  const actor = liveActor(workspace, supplied), order = orderFor(workspace, runId, runVersion)
  if (actor.role === 'factory') throw new Error('생산 시작은 본사 담당자만 처리할 수 있습니다.')
  if (order.status !== 'accepted' || !order.acceptance || order.acceptance.poVersion !== order.poVersion) throw new Error('업체의 PO 확인·예상 납기·생산 동의가 먼저 필요합니다.')
  const next = structuredClone(workspace), now = new Date().toISOString()
  order.status = 'in_progress'; order.startedAt = now; order.startedBy = actor.id; order.startedByName = actor.name
  return replaceOrder(next, order, actor, '차수 생산 시작', now)
}
/** Historical HQ receipts follow the original accepted PO, even after the
 * parent's current factory changes for another project's production. */
export function hasProductionRunStartProof(order: SupplierOrder | undefined): boolean {
  const acceptance = order?.acceptance
  return !!order && ['in_progress', 'assignment_changed'].includes(order.status) && !!order.startedAt && !!order.sentAt && !!order.poId && order.poStatus === 'sent' && !!acceptance
    && acceptance.factoryId === order.factoryId && acceptance.poVersion === order.poVersion
    && acceptance.poSnapshot?.id === order.poId && acceptance.poSnapshot?.version === order.poVersion && acceptance.poSnapshot?.factoryId === order.factoryId
}
export function assertProductionRunStarted(workspace: SupplierOrderWorkspace, runId: string) {
  if (workspace.supplierOrdersAvailable !== true) return
  const order = getDemoSupplierProductionOrders(workspace).find(order => order.runId === runId)
  const po = workspace.operations?.poDispatches.find(item => item.id === order?.poId)
  if (!hasProductionRunStartProof(order) || !po || po.voided || po.factoryIdSnapshot !== order!.factoryId) throw new Error('PO 발송 후 업체의 예상 납기 입력과 생산 동의가 필요합니다.')
}
/** Mirror the database trigger in demo mode without importing the ledger domain. */
export function assertAcceptedProductionTermsUnchanged(workspace: SupplierOrderWorkspace, before: ProductionRun | undefined, after: ProductionRun) {
  if (!before) return
  const po = workspace.operations?.poDispatches.find(po => po.id === before.poId)
  if (!workspace.supplierProductionOrders?.some(order => order.runId === before.id && order.acceptance) && !(po && (po.attempts > 0 || po.status !== 'draft'))) return
  for (const field of ['projectId', 'projectCode', 'poId', 'order', 'expectedDue', 'styleId', 'lineId', 'round', 'factoryIdSnapshot', 'styleCodeSnapshot'] as const) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) throw new Error('발송을 시도한 PO의 프로젝트·수량·납기는 수정할 수 없습니다. 새 생산 차수로 기록해 주세요.')
  }
}

/** Draft creation and linking are atomic in demo mode, matching the SQL RPC. */
export function createProductionOrderPoInWorkspace(workspace: SupplierOrderWorkspace, supplied: Profile, runId: string, runVersion: number, poId: string, data: PoDispatchInput, reason: string): SupplierOrderWorkspace {
  const actor = liveActor(workspace, supplied), order = orderFor(workspace, runId, runVersion)
  if (actor.role === 'factory') throw new Error('PO 작성은 본사 담당자만 가능합니다.')
  if (order.poId || order.acceptance || order.status === 'closed') throw new Error('이미 PO가 연결되었거나 마감된 생산 차수입니다.')
  if (order.status === 'assignment_changed') throw new Error('공장 배정이 변경되었습니다. 새 차수로 발주해 주세요.')
  if (workspace.operations?.poDispatches.some(po => po.id === poId)) throw new Error('새 PO 식별자가 필요합니다.')
  if (!quantityTotal(order.order)) throw new Error('발주 수량을 먼저 입력해 주세요.')
  const next = savePoInWorkspace(workspace, actor, poId, order.styleId, data, 0, reason) as SupplierOrderWorkspace
  const now = new Date().toISOString()
  next.productionRuns = next.productionRuns?.map(run => run.id === runId ? { ...run, poId, expectedDue: data.dueDate, version: run.version + 1, updatedAt: now, updatedBy: actor.id } : run)
  next.supplierProductionOrders = getDemoSupplierProductionOrders(next)
  next.audits.unshift({ id: crypto.randomUUID(), styleId: order.styleId, actorId: actor.id, actorName: actor.name, action: '생산 차수 PO 연결', reason, before: null, after: { runId, poId }, createdAt: now })
  return next
}
