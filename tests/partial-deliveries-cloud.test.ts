import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
const api = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/lib/repository', () => ({ supabase: api, getDemoWorkspace: vi.fn(), locked: vi.fn(), persist: vi.fn() }))
import { loadPartialDeliveryPlans, savePartialDeliveryPlan } from '../src/lib/partial-deliveries-repository'
import { createSeed } from '../src/lib/seed'
import { emptyQuantities } from '../src/lib/types'

const oldItem = { id: 'legacy', dueDate: '2026-11-10', quantity: 10, note: '기존 합계만 있는 계획' }
const newItem = { ...oldItem, quantities: { ...emptyQuantities(), S: 10 } }
const plan = { runId: 'run', version: 1, items: [oldItem], updatedAt: '2026-10-31', updatedBy: 'hq' }
function client(capability: { data: unknown; error: unknown }, sizes: { data: unknown; error: unknown }, pages = [[plan]]) {
  const rpc = vi.fn((name: string) => name === 'get_partial_delivery_plan_capability' ? Promise.resolve(capability) : name === 'get_partial_delivery_sizes_capability' ? Promise.resolve(sizes) : { range: async (offset: number) => ({ data: pages[offset / 500] || [], error: null }) })
  return { rpc, value: { rpc } as unknown as SupabaseClient }
}
beforeEach(() => api.rpc.mockReset())
describe('부분 납기 사이즈 저장의 단계별 적용', () => {
  it('016이 없으면 기존 업무를 유지하고 신규 기능은 준비 상태다', async () => {
    const c = client({ data: null, error: { code: 'PGRST202' } }, { data: false, error: null })
    expect(await loadPartialDeliveryPlans(c.value)).toEqual({ partialDeliveryAvailable: false, partialDeliverySizesAvailable: false, partialDeliveryPlans: [] })
    expect(c.rpc).toHaveBeenCalledTimes(1)
  })
  it('018이 없어도 기존 합계 계획을 원본 그대로 읽으며 사이즈를 추정하지 않는다', async () => {
    const c = client({ data: true, error: null }, { data: null, error: { code: '42883' } })
    expect(await loadPartialDeliveryPlans(c.value)).toEqual({ partialDeliveryAvailable: true, partialDeliverySizesAvailable: false, partialDeliveryPlans: [plan] })
    expect(plan.items[0]).not.toHaveProperty('quantities')
  })
  it('승인되지 않은 계정에는 추가 기능·목록을 요청하지 않는다', async () => {
    const c = client({ data: false, error: null }, { data: true, error: null })
    expect((await loadPartialDeliveryPlans(c.value)).partialDeliveryAvailable).toBe(false)
    expect(c.rpc).toHaveBeenCalledTimes(1)
  })
  it('사이즈 지원 여부와 전체 페이지를 읽으며 이미 기록한 배분을 유지한다', async () => {
    const sized = { ...plan, items: [newItem] }
    const c = client({ data: true, error: null }, { data: true, error: null }, [Array.from({ length: 500 }, () => sized), [sized]])
    const loaded = await loadPartialDeliveryPlans(c.value)
    expect(loaded.partialDeliverySizesAvailable).toBe(true)
    expect(loaded.partialDeliveryPlans).toHaveLength(501)
    expect(loaded.partialDeliveryPlans?.at(-1)?.items[0]).toEqual(newItem)
  })
  it('네트워크·권한 실패를 미설치 안내로 숨기지 않는다', async () => {
    const failure = { code: '42501', message: 'permission denied' }
    const c = client({ data: true, error: null }, { data: null, error: failure })
    await expect(loadPartialDeliveryPlans(c.value)).rejects.toEqual(failure)
  })
  it('018 미설치 상태에서 사이즈 저장을 기존016에 전달하지 않는다', async () => {
    api.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    await expect(savePartialDeliveryPlan('run', 0, [newItem], '사이즈 계획 저장', createSeed().profiles[0])).rejects.toThrow(/018_partial_delivery_sizes.sql/)
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith('get_partial_delivery_sizes_capability')
  })
  it('018 지원 서버에 기존 저장 RPC와 사이즈 값을 전달한다', async () => {
    api.rpc.mockResolvedValue({ data: true, error: null })
    await savePartialDeliveryPlan('run', 1, [newItem], '사이즈 계획 저장', createSeed().profiles[0])
    expect(api.rpc).toHaveBeenLastCalledWith('save_partial_delivery_plan', { p_run_id: 'run', p_expected_version: 1, p_items: [newItem], p_reason: '사이즈 계획 저장' })
  })
})
