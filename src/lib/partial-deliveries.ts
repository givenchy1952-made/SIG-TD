import type { Profile, Quantities, Workspace } from './types'
import { emptyQuantities, quantityTotal, SIZES } from './types'
import { canViewStyle } from './permissions'

/** A delivery installment is NOT a new production run or an actual receipt. */
export interface PartialDeliveryInstallment {
  id: string
  dueDate: string
  quantity: number
  /** Omitted on legacy plans whose size allocation was never recorded. */
  quantities?: Quantities
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
  partialDeliverySizesAvailable?: boolean
}
/** Factory cloud workspaces intentionally omit financial production runs. Use
 * their scoped supplier orders to retain only the assigned run's public plan. */
export function scopePartialDeliveryWorkspace(workspace: Workspace, supplied: Profile): PartialDeliveryFields {
  const fields = { partialDeliveryAvailable: workspace.partialDeliveryAvailable, partialDeliverySizesAvailable: workspace.partialDeliverySizesAvailable }
  const actor = workspace.profiles.find(person => person.id === supplied.id)
  if (!actor?.active || !actor.approved) return { ...fields, partialDeliveryPlans: [] }
  const styles = new Map(workspace.styles.filter(style => canViewStyle(actor, style)).map(style => [style.id, style]))
  const visible = new Set<string>()
  for (const order of workspace.supplierProductionOrders || []) {
    const style = styles.get(order.styleId)
    if (style && (actor.role !== 'factory' || !!actor.factoryId && order.factoryId === actor.factoryId && style.factoryId === actor.factoryId)) visible.add(order.runId)
  }
  if (actor.role !== 'factory') for (const run of workspace.productionRuns || []) if (styles.has(run.styleId)) visible.add(run.id)
  return { ...fields, partialDeliveryPlans: (workspace.partialDeliveryPlans || []).filter(plan => visible.has(plan.runId)).map(plan => structuredClone(plan)) }
}
export const totalPlanned = (items: PartialDeliveryInstallment[]): number => items.reduce((sum, item) => sum + item.quantity, 0)
/** Legacy totals do not imply a size allocation and are deliberately excluded. */
export function totalPlannedBySize(items: PartialDeliveryInstallment[]): Quantities {
  return items.reduce((sum, item) => {
    if (item.quantities) for (const size of SIZES) sum[size] += item.quantities[size]
    return sum
  }, emptyQuantities())
}
export function validatePartialDeliveries(items: PartialDeliveryInstallment[], order: number | Quantities): void {
  const orderQuantity = typeof order === 'number' ? order : quantityTotal(order)
  if (!Array.isArray(items) || !items.length || items.length > 24) throw new Error('분할 납기는 1~24차까지 등록할 수 있습니다.')
  const sized = items.some(item => item && Object.hasOwn(item, 'quantities'))
  const ids = new Set<string>()
  let previousDate = ''
  for (const item of items) {
    if (!item || typeof item !== 'object') throw new Error('부분 납기 입력값을 확인해 주세요.')
    if (!item.id || ids.has(item.id)) throw new Error('부분 납기 차수 식별자가 중복되었습니다.')
    ids.add(item.id)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.dueDate) || !Number.isFinite(Date.parse(item.dueDate + 'T00:00:00Z')) || new Date(item.dueDate + 'T00:00:00Z').toISOString().slice(0, 10) !== item.dueDate)
      throw new Error('각 차수의 납기일을 확인해 주세요.')
    if (previousDate && item.dueDate < previousDate) throw new Error('부분 납기일은 차수 순서대로 입력해 주세요.')
    previousDate = item.dueDate
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > 10_000_000) throw new Error('각 차수 수량은 1~10,000,000장으로 입력해 주세요.')
    if (typeof item.note !== 'string' || item.note.length > 500) throw new Error('납기 비고는 500자 이하여야 합니다.')
    if (sized) {
      const sizes = item.quantities
      if (!sizes || typeof sizes !== 'object' || Array.isArray(sizes) || Object.keys(sizes).sort().join(',') !== [...SIZES].sort().join(',') || SIZES.some(size => !Number.isSafeInteger(sizes[size]) || sizes[size] < 0 || sizes[size] > 10_000_000))
        throw new Error('모든 납기 차수의 XXS~XL 사이즈별 예정 수량을 0 이상의 정수로 입력해 주세요. 기존 합계만 있는 계획은 사이즈 배분을 직접 입력해야 합니다.')
      if (quantityTotal(sizes) !== item.quantity) throw new Error('각 납기 차수의 합계와 사이즈별 예정 수량 합계가 다릅니다.')
    }
  }
  if (totalPlanned(items) !== orderQuantity) throw new Error(`부분 납기 합계 ${totalPlanned(items).toLocaleString()}장과 생산 차수 오더 ${orderQuantity.toLocaleString()}장이 다릅니다.`)
  if (sized) {
    if (typeof order === 'number') throw new Error('사이즈별 부분 납기는 생산 차수의 XXS~XL 오더 수량과 함께 확인해야 합니다.')
    const planned = totalPlannedBySize(items)
    const mismatch = SIZES.filter(size => planned[size] !== order[size])
    if (mismatch.length) throw new Error(`부분 납기 사이즈별 합계가 생산 차수 오더와 다릅니다: ${mismatch.join(', ')}. 각 사이즈의 전체 예정 수량을 오더와 맞춰 주세요.`)
  }
}
export function savePartialDeliveryInWorkspace(workspace: Workspace, actor: Profile, runId: string, version: number, items: PartialDeliveryInstallment[], reason: string): Workspace {
  const person = workspace.profiles.find(item => item.id === actor.id)
  const run = workspace.productionRuns?.find(item => item.id === runId)
  const style = workspace.styles.find(item => item.id === run?.styleId && !item.deletedAt)
  if (!person?.active || !person.approved || !['admin', 'internal'].includes(person.role) || !run || !style) throw new Error('승인된 본사 담당자만 부분 납기 일정을 수정할 수 있습니다.')
  if (run.closedAt || workspace.productionReceipts?.some(item => item.runId === runId) || workspace.productionConditions?.some(item => item.runId === runId && (item.proposal || item.approval || item.legacy || item.status === 'rejected')) || workspace.supplierProductionOrders?.some(item => item.runId === runId && item.startedAt))
    throw new Error('업체 회신·생산 시작·입고 이후에는 기존 분할 납기를 수정할 수 없습니다.')
  const existing = workspace.partialDeliveryPlans?.find(item => item.runId === runId)
  if ((existing?.version || 0) !== version) throw new Error('VERSION_CONFLICT')
  if (reason.trim().length < 2 || reason.trim().length > 1000) throw new Error('분할 납기 변경 사유를 2~1,000자로 입력해 주세요.')
  validatePartialDeliveries(items, run.order)
  const next = structuredClone(workspace), now = new Date().toISOString()
  const updated = { runId, items: structuredClone(items), version: version + 1, updatedAt: now, updatedBy: person.id }
  next.partialDeliveryPlans = [...(next.partialDeliveryPlans || []).filter(item => item.runId !== runId), updated]
  next.audits.unshift({ id: crypto.randomUUID(), styleId: style.id, actorId: person.id, actorName: person.name, action: '부분 납기 일정 저장', reason: reason.trim(), before: existing || null, after: updated, createdAt: now })
  return next
}
