import type { Profile, Workspace } from './types'
import { canViewStyle } from './permissions'
import { validateOperationReason } from './operations-domain'

export type MaterialReviewKind = 'fabric' | 'trim'
export type MaterialReviewStatus = 'pending' | 'approved' | 'rejected'
export interface MaterialReviewItemInput { kind: MaterialReviewKind; name: string; specification: string }
export interface MaterialReviewItem extends MaterialReviewItemInput { id: string; styleId: string; lineId: string; version: number; createdAt: string; updatedAt: string; updatedBy: string }
export interface MaterialReviewItemSnapshot extends MaterialReviewItemInput { styleId: string; lineId: string; color: string; styleCode: string }
export interface MaterialReviewRoundInput { status: MaterialReviewStatus; comment: string; attachmentIds: string[] }
export interface MaterialReviewDecisionInput { status: 'approved' | 'rejected'; comment: string; attachmentIds: string[] }
export interface MaterialReviewRound {
  id: string; itemId: string; round: number; status: MaterialReviewStatus; comment: string; attachmentIds: string[];
  itemSnapshot: MaterialReviewItemSnapshot; actorId: string; actorName: string; version: number; createdAt: string;
  reviewerComment: string; reviewAttachmentIds: string[]; reviewedBy: string | null; reviewedByName: string; reviewedAt: string | null;
}
export interface MaterialReviewsFields { materialReviewItems?: MaterialReviewItem[]; materialReviewRounds?: MaterialReviewRound[]; materialReviewsAvailable?: boolean }
type ReviewWorkspace = Workspace & MaterialReviewsFields
const control = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/
const imageMimes = new Set(['image/jpeg', 'image/png', 'image/webp'])
export const MATERIAL_REVIEW_KIND_LABEL: Record<MaterialReviewKind, string> = { fabric: '원단', trim: '부자재' }
export const MATERIAL_REVIEW_STATUS_LABEL: Record<MaterialReviewStatus, string> = { pending: '확인 대기', approved: '승인', rejected: '반려' }

export function latestMaterialReviewRound(workspace: ReviewWorkspace, itemId: string): MaterialReviewRound | undefined {
  return (workspace.materialReviewRounds || []).filter(round => round.itemId === itemId).sort((a, b) => b.round - a.round)[0]
}
export function materialReviewItemChangedSinceRound(item: MaterialReviewItem, round: MaterialReviewRound | undefined): boolean {
  return !!round && (item.kind !== round.itemSnapshot.kind || item.name !== round.itemSnapshot.name || item.specification !== round.itemSnapshot.specification)
}
export function scopeMaterialReviewsWorkspace(workspace: ReviewWorkspace, supplied: Profile): MaterialReviewsFields {
  const actor = workspace.profiles.find(profile => profile.id === supplied.id)
  const styles = new Set(actor ? workspace.styles.filter(style => canViewStyle(actor, style)).map(style => style.id) : [])
  const items = (workspace.materialReviewItems || []).filter(item => styles.has(item.styleId))
  const ids = new Set(items.map(item => item.id))
  return { materialReviewsAvailable: workspace.materialReviewsAvailable, materialReviewItems: items, materialReviewRounds: (workspace.materialReviewRounds || []).filter(round => ids.has(round.itemId)) }
}
function actorFor(workspace: ReviewWorkspace, supplied: Profile): Profile {
  const actor = workspace.profiles.find(profile => profile.id === supplied.id)
  if (!actor?.active || !actor.approved) throw new Error('승인된 활성 계정만 원부자재 확인을 사용할 수 있습니다.')
  return actor
}
function text(value: unknown, limit: number, required = false): value is string { return typeof value === 'string' && value.length <= limit && (!required || !!value.trim()) && !control.test(value) }
function validateItem(data: MaterialReviewItemInput) {
  if (!data || Object.keys(data).sort().join(',') !== 'kind,name,specification' || !['fabric', 'trim'].includes(data.kind) || !text(data.name, 160, true) || !text(data.specification, 2000)) throw new Error('원부자재 구분·품목명·사양을 확인해 주세요.')
}
function validateRound(workspace: ReviewWorkspace, styleId: string, data: MaterialReviewRoundInput) {
  if (!data || Object.keys(data).sort().join(',') !== 'attachmentIds,comment,status' || !['pending', 'approved', 'rejected'].includes(data.status) || !text(data.comment, 4000) || !Array.isArray(data.attachmentIds) || data.attachmentIds.length > 12 || new Set(data.attachmentIds).size !== data.attachmentIds.length || (!data.comment.trim() && !data.attachmentIds.length)) throw new Error('확인 상태와 코멘트 또는 이미지(최대 12장)를 입력해 주세요.')
  for (const id of data.attachmentIds) if (typeof id !== 'string' || !workspace.attachments.some(file => file.id === id && file.styleId === styleId && imageMimes.has(file.mime))) throw new Error('같은 스타일의 JPG·PNG·WEBP 이미지만 보관할 수 있습니다.')
}
function audit(next: ReviewWorkspace, actor: Profile, styleId: string, action: string, reason: string, before: unknown, after: unknown) {
  next.audits.unshift({ id: crypto.randomUUID(), styleId, actorId: actor.id, actorName: actor.name, action, reason: reason.trim(), before, after, createdAt: new Date().toISOString() })
}
export function saveMaterialReviewItemInWorkspace(workspace: ReviewWorkspace, supplied: Profile, id: string, styleId: string, lineId: string, expectedVersion: number, data: MaterialReviewItemInput, reason: string): ReviewWorkspace {
  const actor = actorFor(workspace, supplied)
  if (actor.role === 'factory') throw new Error('원부자재 품목 등록·수정은 본사만 가능합니다.')
  validateOperationReason(reason); validateItem(data)
  const style = workspace.styles.find(style => style.id === styleId && canViewStyle(actor, style))
  const before = workspace.materialReviewItems?.find(item => item.id === id)
  if (!style || !style.production.some(line => line.id === lineId) || before && (before.styleId !== styleId || before.lineId !== lineId)) throw new Error('원부자재를 등록할 스타일과 컬러를 확인해 주세요.')
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || (before?.version || 0) !== expectedVersion) throw new Error('VERSION_CONFLICT')
  if (!before && (workspace.materialReviewItems || []).filter(item => item.styleId === styleId).length >= 200) throw new Error('한 스타일에 원부자재 품목은 최대 200개입니다.')
  const next = structuredClone(workspace), now = new Date().toISOString()
  const after: MaterialReviewItem = { ...data, name: data.name.trim(), id, styleId, lineId, version: expectedVersion + 1, createdAt: before?.createdAt || now, updatedAt: now, updatedBy: actor.id }
  next.materialReviewItems = [...(next.materialReviewItems || []).filter(item => item.id !== id), after]
  audit(next, actor, styleId, '원부자재 품목 저장', reason, before || null, after)
  return next
}
export function appendMaterialReviewRoundInWorkspace(workspace: ReviewWorkspace, supplied: Profile, id: string, itemId: string, expectedItemVersion: number, data: MaterialReviewRoundInput, reason: string): ReviewWorkspace {
  const actor = actorFor(workspace, supplied); validateOperationReason(reason)
  const item = workspace.materialReviewItems?.find(item => item.id === itemId)
  const style = item && workspace.styles.find(style => style.id === item.styleId && canViewStyle(actor, style))
  const line = style?.production.find(line => line.id === item?.lineId)
  if (!item || !style || !line) throw new Error('현재 배정된 스타일의 원부자재 품목을 확인해 주세요.')
  if (item.version !== expectedItemVersion || workspace.materialReviewRounds?.some(round => round.id === id)) throw new Error('VERSION_CONFLICT')
  validateRound(workspace, style.id, data)
  const latest = latestMaterialReviewRound(workspace, itemId)
  if (latest?.status === 'pending' || actor.role === 'factory' && (data.status !== 'pending' || latest?.status === 'approved')) throw new Error('대기 중인 차수는 본사 확인 후 재제출할 수 있고, 승인·반려는 본사만 기록합니다.')
  if ((latest?.round || 0) >= 100) throw new Error('품목별 확인 이력은 최대 100차까지 등록할 수 있습니다.')
  const next = structuredClone(workspace), now = new Date().toISOString()
  const after: MaterialReviewRound = { ...data, attachmentIds: [...data.attachmentIds], id, itemId, round: (latest?.round || 0) + 1, itemSnapshot: { styleId: style.id, lineId: line.id, color: line.color, styleCode: style.code, kind: item.kind, name: item.name, specification: item.specification }, actorId: actor.id, actorName: actor.name, version: 1, createdAt: now, reviewerComment: '', reviewAttachmentIds: [], reviewedBy: data.status === 'pending' ? null : actor.id, reviewedByName: data.status === 'pending' ? '' : actor.name, reviewedAt: data.status === 'pending' ? null : now }
  next.materialReviewRounds = [...(next.materialReviewRounds || []), after]
  next.materialReviewItems = next.materialReviewItems!.map(row => row.id === itemId ? { ...row, version: row.version + 1, updatedAt: now, updatedBy: actor.id } : row)
  audit(next, actor, style.id, '원부자재 확인 차수 제출', reason, null, after)
  return next
}
export function decideMaterialReviewRoundInWorkspace(workspace: ReviewWorkspace, supplied: Profile, roundId: string, expectedRoundVersion: number, data: MaterialReviewDecisionInput, reason: string): ReviewWorkspace {
  const actor = actorFor(workspace, supplied)
  if (actor.role === 'factory') throw new Error('원부자재 승인·반려는 본사만 가능합니다.')
  validateOperationReason(reason)
  const before = workspace.materialReviewRounds?.find(round => round.id === roundId)
  const item = workspace.materialReviewItems?.find(item => item.id === before?.itemId)
  const style = item && workspace.styles.find(style => style.id === item.styleId && canViewStyle(actor, style))
  if (!before || !item || !style) throw new Error('확인할 원부자재 차수를 찾을 수 없습니다.')
  if (before.version !== expectedRoundVersion) throw new Error('VERSION_CONFLICT')
  if (before.status !== 'pending' || latestMaterialReviewRound(workspace, item.id)?.id !== roundId) throw new Error('이미 결정된 원부자재 차수는 수정할 수 없습니다.')
  if (!data || !['approved', 'rejected'].includes(data.status)) throw new Error('승인 또는 반려를 선택해 주세요.')
  validateRound(workspace, style.id, data)
  const next = structuredClone(workspace), now = new Date().toISOString()
  const after: MaterialReviewRound = { ...before, status: data.status, reviewerComment: data.comment, reviewAttachmentIds: [...data.attachmentIds], reviewedBy: actor.id, reviewedByName: actor.name, reviewedAt: now, version: before.version + 1 }
  next.materialReviewRounds = next.materialReviewRounds!.map(round => round.id === roundId ? after : round)
  next.materialReviewItems = next.materialReviewItems!.map(row => row.id === item.id ? { ...row, version: row.version + 1, updatedAt: now, updatedBy: actor.id } : row)
  audit(next, actor, style.id, '원부자재 확인 차수 결정', reason, before, after)
  return next
}
