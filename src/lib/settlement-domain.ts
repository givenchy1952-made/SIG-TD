import type { Profile } from './types'
import { assertActive, canViewStyle } from './permissions'
import type { SettlementTerms, SettlementTermsInput, SettlementWorkspace, SettlementWorkspaceFields } from './settlement-types'
import { validateOperationReason } from './operations-domain'

export function validateSettlementTerms(data: SettlementTermsInput): void {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 3 || !['projectCode', 'unitCost', 'itemType'].every(key => key in data)) throw new Error('을지 정산 정보의 항목을 확인해 주세요.')
  if (typeof data.projectCode !== 'string' || data.projectCode.length > 120 || /[\x00-\x1f\x7f]/.test(data.projectCode)) throw new Error('프로젝트 코드는 제어 문자 없이 120자 이내로 입력해 주세요.')
  if (!['product', 'fabric', 'label'].includes(data.itemType)) throw new Error('제품·원단·라벨 중 정산 품목 종류를 선택해 주세요.')
  if (data.unitCost !== null && (typeof data.unitCost !== 'number' || !Number.isFinite(data.unitCost) || data.unitCost < 0 || data.unitCost > 1_000_000_000 || !/^\d+(?:\.\d{1,2})?$/.test(String(data.unitCost)))) throw new Error('장당 원가는 미기재 또는 0~1,000,000,000 범위의 소수 둘째 자리까지 입력해 주세요.')
}
function publicSummary(row: SettlementTerms | undefined) { return row ? { styleId: row.styleId, lineId: row.lineId, version: row.version } : null }

export function scopeSettlementTermsWorkspace(workspace: SettlementWorkspace, profile: Profile): SettlementWorkspaceFields {
  if (!profile.approved || !profile.active || profile.role === 'factory') return { settlementTerms: [], settlementTermsAudits: [], settlementTermsAvailable: workspace.settlementTermsAvailable }
  const visible = new Set(workspace.styles.filter(style => canViewStyle(profile, style)).map(style => style.id))
  return { settlementTerms: (workspace.settlementTerms || []).filter(row => visible.has(row.styleId)), settlementTermsAudits: (workspace.settlementTermsAudits || []).filter(row => visible.has(row.styleId)), settlementTermsAvailable: workspace.settlementTermsAvailable }
}

/** Resolves the live stored actor, preserves price history privately, and never changes receipt/order quantities. */
export function saveSettlementTermsInWorkspace(workspace: SettlementWorkspace, supplied: Profile, styleId: string, lineId: string, data: SettlementTermsInput, expectedVersion: number, reason: string): SettlementWorkspace {
  const actor = workspace.profiles.find(profile => profile.id === supplied.id)
  if (!actor) throw new Error('사용자 계정을 확인할 수 없습니다.')
  assertActive(actor)
  if (actor.role === 'factory') throw new Error('을지 정산 정보는 승인된 관리자·본사 직원만 수정할 수 있습니다.')
  validateOperationReason(reason)
  validateSettlementTerms(data)
  const style = workspace.styles.find(item => item.id === styleId && canViewStyle(actor, item))
  if (!style || !style.production.some(line => line.id === lineId)) throw new Error('접근 가능한 스타일과 저장된 생산 컬러를 선택해 주세요.')
  const before = workspace.settlementTerms?.find(row => row.styleId === styleId && row.lineId === lineId)
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || (before?.version || 0) !== expectedVersion) throw new Error('VERSION_CONFLICT: 다른 사용자가 정산 정보를 먼저 수정했습니다. 최신 내용을 확인해 주세요.')
  const now = new Date().toISOString()
  const after: SettlementTerms = { styleId, lineId, projectCode: data.projectCode.trim(), unitCost: data.unitCost, itemType: data.itemType, version: (before?.version || 0) + 1, createdAt: before?.createdAt || now, updatedAt: now, updatedBy: actor.id }
  const next = structuredClone(workspace)
  next.settlementTerms = [...(next.settlementTerms || []).filter(row => row.styleId !== styleId || row.lineId !== lineId), after]
  next.settlementTermsAvailable = true
  next.settlementTermsAudits = [{ id: crypto.randomUUID(), styleId, lineId, actorId: actor.id, actorName: actor.name, reason: reason.trim(), before: before ? structuredClone(before) : null, after: structuredClone(after), createdAt: now }, ...(next.settlementTermsAudits || [])]
  // Assigned factories can read public style audits, so prices/codes never enter those snapshots.
  next.audits.unshift({ id: crypto.randomUUID(), styleId, actorId: actor.id, actorName: actor.name, action: '을지 정산 정보 저장', reason: '본사 전용 정산 정보 변경', before: publicSummary(before), after: publicSummary(after), createdAt: now })
  return next
}
