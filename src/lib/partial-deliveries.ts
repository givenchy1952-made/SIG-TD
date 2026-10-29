import type { Profile, Workspace } from './types'
import { quantityTotal } from './types'

/** A delivery installment is NOT a new production run or an actual receipt. */
export interface PartialDeliveryInstallment {
  id: string
  dueDate: string
  quantity: number
  note: string
}
export interface PartialDeliveryPlan {
  runId: string
  version: number
  items: PartialDeliveryInstallment[]
  updatedAt: string
  updatedBy: string
}
export interface PartialDeliveryFields {
  partialDeliveryPlans?: PartialDeliveryPlan[]
  partialDeliveryAvailable?: boolean
}
export const totalPlanned = (items: PartialDeliveryInstallment[]): number => items.reduce((sum, item) => sum + item.quantity, 0)
export function validatePartialDeliveries(items: PartialDeliveryInstallment[], orderQuantity: number): void {
  if (!Array.isArray(items) || !items.length || items.length > 24) throw new Error('분할 납기는 1~24차까지 등록할 수 있습니다.')
  const ids = new Set<string>()
  let previousDate = ''
  for (const item of items) {
    if (!item.id || ids.has(item.id)) throw new Error('부분 납기 차수 식별자가 중복되었습니다.')
    ids.add(item.id)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.dueDate) || !Number.isFinite(Date.parse(item.dueDate + 'T00:00:00Z')) || new Date(item.dueDate + 'T00:00:00Z').toISOString().slice(0, 10) !== item.dueDate)
      throw new Error('각 차수의 납기일을 확인해 주세요.')
    if (previousDate && item.dueDate < previousDate) throw new Error('부분 납기일은 차수 순서대로 입력해 주세요.')
    previousDate = item.dueDate
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > 10_000_000) throw new Error('각 차수 수량은 1~10,000,000장으로 입력해 주세요.')
    if (item.note.length > 500) throw new Error('납기 비고는 500자 이하여야 합니다.')
  }
  if (totalPlanned(items) !== orderQuantity) throw new Error(`부분 납기 합계 ${totalPlanned(items).toLocaleString()}장과 생산 차수 오더 ${orderQuantity.toLocaleString()}장이 다릅니다.`)
}
export function savePartialDeliveryInWorkspace(workspace: Workspace, actor: Profile, runId: string, version: number, items: PartialDeliveryInstallment[], reason: string): Workspace {
  const person = workspace.profiles.find(item => item.id === actor.id)
  const run = workspace.productionRuns?.find(item => item.id === runId)
  const style = workspace.styles.find(item => item.id === run?.styleId && !item.deletedAt)
  if (!person?.active || !person.approved || person.role === 'factory' || !run || !style) throw new Error('승인된 본사 담당자만 부분 납기 일정을 수정할 수 있습니다.')
  if (run.closedAt || workspace.productionReceipts?.some(item => item.runId === runId) || workspace.productionConditions?.some(item => item.runId === runId && (item.proposal || item.approval || item.legacy || item.status === 'rejected')) || workspace.supplierProductionOrders?.some(item => item.runId === runId && item.startedAt))
    throw new Error('업체 회신·생산 시작·입고 이후에는 기존 분할 납기를 수정할 수 없습니다.')
  const existing = workspace.partialDeliveryPlans?.find(item => item.runId === runId)
  if ((existing?.version || 0) !== version) throw new Error('VERSION_CONFLICT')
  if (reason.trim().length < 2 || reason.trim().length > 1000) throw new Error('분할 납기 변경 사유를 2~1,000자로 입력해 주세요.')
  validatePartialDeliveries(items, quantityTotal(run.order))
  const next = structuredClone(workspace), now = new Date().toISOString()
  const updated = { runId, items: structuredClone(items), version: version + 1, updatedAt: now, updatedBy: actor.id }
  next.partialDeliveryPlans = [...(next.partialDeliveryPlans || []).filter(item => item.runId !== runId), updated]
  next.audits.unshift({ id: crypto.randomUUID(), styleId: style.id, actorId: actor.id, actorName: actor.name, action: '부분 납기 일정 저장', reason: reason.trim(), before: existing || null, after: updated, createdAt: now })
  return next
}
