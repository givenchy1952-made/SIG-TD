import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
vi.mock('../src/lib/repository', () => ({ getDemoWorkspace: vi.fn(), locked: vi.fn(), persist: vi.fn(), supabase: null }))
import { loadMaterialReviews } from '../src/lib/material-reviews-repository'

function client(capability: { data: unknown; error: unknown }, pages: Record<string, Record<string, unknown>[][]> = {}, failure: unknown = null) {
  const from = vi.fn((table: string) => {
    const request = { select: () => request, order: () => request, range: async (offset: number) => ({ data: pages[table]?.[offset / 500] || [], error: failure }) }
    return request
  })
  return { value: { rpc: vi.fn(async () => capability), from } as unknown as SupabaseClient, from }
}

describe('원·부자재 검토 클라우드 단계별 적용', () => {
  it('017 이전 서버는 기존 업무를 유지하며 원부자재 이력 기능만 준비 상태로 읽는다', async () => {
    const mock = client({ data: null, error: { code: 'PGRST202' } })
    expect(await loadMaterialReviews(mock.value)).toEqual({ materialReviewsAvailable: false, materialReviewItems: [], materialReviewRounds: [] })
    expect(mock.from).not.toHaveBeenCalled()
  })
  it('사용 권한이 없는 계정은 원부자재 테이블을 요청하지 않는다', async () => {
    const mock = client({ data: false, error: null })
    expect((await loadMaterialReviews(mock.value)).materialReviewsAvailable).toBe(false)
    expect(mock.from).not.toHaveBeenCalled()
  })
  it('품목 전체 페이지와 같은 차수의 제출·본사 검토 이미지·코멘트를 분리해 읽는다', async () => {
    const item = { id: 'item', style_id: 'style', line_id: 'line', kind: 'fabric', name: '겉감', specification: '원단 사양', version: 3, created_at: '2026-10-30', updated_at: '2026-10-30', updated_by: 'hq' }
    const round = { id: 'round', item_id: 'item', round: 2, status: 'approved', comment: '공장 재제출', attachment_ids: ['submission-image'], item_snapshot: { styleId: 'style', lineId: 'line', name: '당시 겉감' }, actor_id: 'factory', actor_name: '업체', version: 2, created_at: '2026-10-30', reviewer_comment: '본사 2차 승인', review_attachment_ids: ['review-image'], reviewed_by: 'hq', reviewed_by_name: '본사', reviewed_at: '2026-10-30' }
    const mock = client({ data: true, error: null }, { material_review_items: [Array.from({ length: 500 }, () => item), [{ ...item, id: 'last-item' }]], material_review_rounds: [[round]] })
    const result = await loadMaterialReviews(mock.value)
    expect(result.materialReviewsAvailable).toBe(true)
    expect(result.materialReviewItems).toHaveLength(501)
    expect(result.materialReviewItems?.at(-1)).toMatchObject({ id: 'last-item', styleId: 'style', lineId: 'line', version: 3 })
    expect(result.materialReviewRounds?.[0]).toMatchObject({ round: 2, version: 2, comment: '공장 재제출', attachmentIds: ['submission-image'], reviewerComment: '본사 2차 승인', reviewAttachmentIds: ['review-image'], reviewedBy: 'hq', itemSnapshot: { name: '당시 겉감' } })
  })
  it('권한·연결 실패를 기능 미설치로 숨기지 않는다', async () => {
    const denied = { code: '42501', message: 'permission denied' }
    await expect(loadMaterialReviews(client({ data: null, error: denied }).value)).rejects.toEqual(denied)
    const disconnected = { code: 'NETWORK', message: 'disconnected' }
    await expect(loadMaterialReviews(client({ data: true, error: null }, {}, disconnected).value)).rejects.toEqual(disconnected)
  })
})
