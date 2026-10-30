import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from './types'
import { getDemoWorkspace, locked, persist, supabase } from './repository'
import { appendMaterialReviewRoundInWorkspace, decideMaterialReviewRoundInWorkspace, saveMaterialReviewItemInWorkspace, type MaterialReviewDecisionInput, type MaterialReviewItem, type MaterialReviewItemInput, type MaterialReviewRound, type MaterialReviewRoundInput, type MaterialReviewsFields } from './material-reviews'

const missing = (code?: string) => ['PGRST202', 'PGRST205', '42P01', '42883'].includes(code || '')
export async function loadMaterialReviews(client: SupabaseClient): Promise<MaterialReviewsFields> {
  const probe = await client.rpc('get_material_reviews_capability')
  if (probe.error && missing(probe.error.code) || !probe.error && probe.data !== true) return { materialReviewItems: [], materialReviewRounds: [], materialReviewsAvailable: false }
  if (probe.error) throw probe.error
  const items: MaterialReviewItem[] = [], rounds: MaterialReviewRound[] = []
  for (let offset = 0;; offset += 500) {
    const result = await client.from('material_review_items').select('*').order('id').range(offset, offset + 499)
    if (result.error) throw result.error
    const page = result.data || []
    items.push(...page.map(row => ({ id: row.id, styleId: row.style_id, lineId: row.line_id, kind: row.kind, name: row.name, specification: row.specification, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: row.updated_by })))
    if (page.length < 500) break
  }
  for (let offset = 0;; offset += 500) {
    const result = await client.from('material_review_rounds').select('*').order('id').range(offset, offset + 499)
    if (result.error) throw result.error
    const page = result.data || []
    rounds.push(...page.map(row => ({ id: row.id, itemId: row.item_id, round: row.round, status: row.status, comment: row.comment, attachmentIds: row.attachment_ids, itemSnapshot: row.item_snapshot, actorId: row.actor_id, actorName: row.actor_name, version: row.version, createdAt: row.created_at, reviewerComment: row.reviewer_comment, reviewAttachmentIds: row.review_attachment_ids, reviewedBy: row.reviewed_by, reviewedByName: row.reviewed_by_name, reviewedAt: row.reviewed_at })))
    if (page.length < 500) break
  }
  return { materialReviewItems: items, materialReviewRounds: rounds, materialReviewsAvailable: true }
}
export async function saveMaterialReviewItem(id: string, styleId: string, lineId: string, expectedVersion: number, data: MaterialReviewItemInput, reason: string, actor: Profile): Promise<void> {
  if (supabase) { const result = await supabase.rpc('save_material_review_item', { p_id: id, p_style_id: styleId, p_line_id: lineId, p_expected_version: expectedVersion, p_data: data, p_reason: reason }); if (result.error) throw result.error; return }
  await locked(() => persist(saveMaterialReviewItemInWorkspace(getDemoWorkspace(), actor, id, styleId, lineId, expectedVersion, data, reason)))
}
export async function appendMaterialReviewRound(id: string, itemId: string, expectedItemVersion: number, data: MaterialReviewRoundInput, reason: string, actor: Profile): Promise<void> {
  if (supabase) { const result = await supabase.rpc('append_material_review_round', { p_id: id, p_item_id: itemId, p_expected_item_version: expectedItemVersion, p_data: data, p_reason: reason }); if (result.error) throw result.error; return }
  await locked(() => persist(appendMaterialReviewRoundInWorkspace(getDemoWorkspace(), actor, id, itemId, expectedItemVersion, data, reason)))
}
export async function decideMaterialReviewRound(roundId: string, expectedRoundVersion: number, data: MaterialReviewDecisionInput, reason: string, actor: Profile): Promise<void> {
  if (supabase) { const result = await supabase.rpc('decide_material_review_round', { p_round_id: roundId, p_expected_round_version: expectedRoundVersion, p_data: data, p_reason: reason }); if (result.error) throw result.error; return }
  await locked(() => persist(decideMaterialReviewRoundInWorkspace(getDemoWorkspace(), actor, roundId, expectedRoundVersion, data, reason)))
}
