import type { Profile, Workspace } from './types'
import { assertActive, canViewStyle } from './permissions'
import { validateOperationReason } from './operations-domain'

export type ProcessingPriceKind = 'label' | 'embroidery' | 'quality'
export interface ProcessingUnitPrice {
  styleId: string; lineId: string; kind: ProcessingPriceKind; itemKey: string; unitCost: number | null;
  version: number; createdAt: string; updatedAt: string; updatedBy: string;
}
export interface ProcessingPricesWorkspaceFields { processingUnitPrices?: ProcessingUnitPrice[]; processingPricesAvailable?: boolean }
type PricesWorkspace = Workspace & ProcessingPricesWorkspaceFields

export const processingPriceKey = (styleId: string, lineId: string, kind: ProcessingPriceKind, itemKey: string) => JSON.stringify([styleId, lineId, kind, itemKey])
export function findProcessingUnitPrice(workspace: ProcessingPricesWorkspaceFields, styleId: string, lineId: string, kind: ProcessingPriceKind, itemKey: string): ProcessingUnitPrice | undefined {
  return workspace.processingUnitPrices?.find(row => row.styleId === styleId && row.lineId === lineId && row.kind === kind && row.itemKey === itemKey)
}
export function validateProcessingUnitCost(unitCost: number | null): void {
  if (unitCost !== null && (typeof unitCost !== 'number' || !Number.isFinite(unitCost) || unitCost < 0 || unitCost > 1_000_000_000 || !/^\d+(?:\.\d{1,2})?$/.test(String(unitCost)))) throw new Error('가공·품질 단가는 미기재 또는 0~1,000,000,000 범위의 소수 둘째 자리까지 입력해 주세요.')
}
export function scopeProcessingPricesWorkspace(workspace: PricesWorkspace, supplied: Profile): ProcessingPricesWorkspaceFields {
  const actor = workspace.profiles.find(person => person.id === supplied.id)
  const visible = new Set(actor?.approved && actor.active ? workspace.styles.filter(style => canViewStyle(actor, style)).map(style => style.id) : [])
  return { processingPricesAvailable: workspace.processingPricesAvailable, processingUnitPrices: (workspace.processingUnitPrices || []).filter(price => visible.has(price.styleId)) }
}
/** A separate price record gives assigned suppliers a narrow editable field without
 * granting access to product costs or headquarters-owned work instructions. */
export function saveProcessingUnitPriceInWorkspace(workspace: PricesWorkspace, supplied: Profile, styleId: string, lineId: string, kind: ProcessingPriceKind, itemKey: string, unitCost: number | null, expectedVersion: number, reason: string): PricesWorkspace {
  const actor = workspace.profiles.find(person => person.id === supplied.id)
  if (!actor) throw new Error('계정을 확인해 주세요.')
  assertActive(actor)
  const style = workspace.styles.find(item => item.id === styleId && canViewStyle(actor, item))
  if (!style || !style.production.some(line => line.id === lineId)) throw new Error('접근 가능한 스타일과 저장된 생산 컬러를 선택해 주세요.')
  validateOperationReason(reason)
  validateProcessingUnitCost(unitCost)
  if (!['label', 'embroidery', 'quality'].includes(kind) || typeof itemKey !== 'string' || !itemKey || itemKey.length > 120 || /[\x00-\x1f\x7f]/.test(itemKey)) throw new Error('가공·품질 작업을 확인해 주세요.')
  const exists = kind === 'quality'
    ? workspace.productionDetails?.some(detail => detail.styleId === styleId && detail.lineId === lineId && detail.quality.category === itemKey)
    : workspace.operations?.styleOperations.some(record => record.styleId === styleId && record.kind === kind && !record.voided && record.rows.some(row => row.id === itemKey))
  if (!exists) throw new Error('저장된 가공·품질 작업을 먼저 선택해 주세요.')
  const before = findProcessingUnitPrice(workspace, styleId, lineId, kind, itemKey)
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || (before?.version || 0) !== expectedVersion) throw new Error('VERSION_CONFLICT: 다른 사용자가 단가를 먼저 수정했습니다. 최신 내용을 확인해 주세요.')
  const now = new Date().toISOString()
  const after: ProcessingUnitPrice = { styleId, lineId, kind, itemKey, unitCost, version: expectedVersion + 1, createdAt: before?.createdAt || now, updatedAt: now, updatedBy: actor.id }
  const next = structuredClone(workspace)
  next.processingUnitPrices = [...(next.processingUnitPrices || []).filter(row => processingPriceKey(row.styleId, row.lineId, row.kind, row.itemKey) !== processingPriceKey(styleId, lineId, kind, itemKey)), after]
  next.processingPricesAvailable = true
  // Public style audits can remain visible after a factory reassignment. Keep
  // historical prices out of those snapshots; hosted SQL stores them privately.
  const summary = (row: ProcessingUnitPrice | undefined) => row ? { styleId, lineId, kind, itemKey, version: row.version } : null
  next.audits.unshift({ id: crypto.randomUUID(), styleId, actorId: actor.id, actorName: actor.name, action: '가공·품질 단가 저장', reason: '가공·품질 단가 변경', before: summary(before), after: summary(after), createdAt: now })
  return next
}
