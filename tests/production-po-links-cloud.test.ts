import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
vi.mock('../src/lib/repository', () => ({ getDemoWorkspace: vi.fn(), locked: vi.fn(), persist: vi.fn(), supabase: null }))
import { loadProductionPoLinks } from '../src/lib/production-po-links-repository'

function client(recovery: { data: unknown; error: unknown }, allowed = true) {
  const rpc = vi.fn(async (name: string) => name === 'get_production_po_links_capability' ? { data: allowed, error: null } : recovery)
  const request = { select: () => request, order: () => request, range: async () => ({ data: [{ po_id: 'po', source: 'run', snapshot: { runId: 'run' }, captured_at: '2026-10-29T00:00:00Z' }], error: null }) }
  const from = vi.fn(() => request)
  return { value: { rpc, from } as unknown as SupabaseClient, rpc, from }
}

describe('보관 PO 복구 기능의 점진적 배포', () => {
  it('016 적용 전에도 기존 PO 비교·연결을 유지하고 교체 기능만 비활성화한다', async () => {
    const mock = client({ data: null, error: { code: 'PGRST202' } })
    const result = await loadProductionPoLinks(mock.value)
    expect(result).toMatchObject({ productionPoLinksAvailable: true, productionPoRecoveryAvailable: false, productionPoContexts: [{ poId: 'po', source: 'run' }] })
  })
  it('서버가 복구 기능을 제공할 때만 연결 교체를 노출한다', async () => {
    expect((await loadProductionPoLinks(client({ data: true, error: null }).value)).productionPoRecoveryAvailable).toBe(true)
    expect((await loadProductionPoLinks(client({ data: false, error: null }).value)).productionPoRecoveryAvailable).toBe(false)
  })
  it('공장 계정에는 비교 원본이나 복구 기능을 조회하지 않는다', async () => {
    const mock = client({ data: true, error: null }, false)
    expect((await loadProductionPoLinks(mock.value)).productionPoLinksAvailable).toBe(false)
    expect(mock.rpc).toHaveBeenCalledTimes(1)
    expect(mock.from).not.toHaveBeenCalled()
  })
  it('접근 거부는 미설치로 숨기지 않는다', async () => {
    const failure = { code: '42501', message: 'permission denied' }
    await expect(loadProductionPoLinks(client({ data: null, error: failure }).value)).rejects.toEqual(failure)
  })
})
