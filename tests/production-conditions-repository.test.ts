import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from '../src/lib/types'
import { emptyQuantities } from '../src/lib/types'

const mock = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/lib/repository', () => ({ supabase: { rpc: mock.rpc }, getDemoWorkspace: vi.fn(), locked: vi.fn(), persist: vi.fn() }))
import { configureProductionConditions, linkProductionConditionChange, loadProductionConditions, requestProductionConditionChange, reviewProductionConditions, submitProductionConditions } from '../src/lib/production-conditions-repository'

const profile: Profile = { id: 'profile-id', name: '본사', email: 'hq@example.test', active: true, approved: true, role: 'internal', factoryId: null }
beforeEach(() => mock.rpc.mockReset())

describe('생산 조건 RPC 연결과 기능 탐지', () => {
  it('서버가 제공한 기능이 없으면 기존 읽기 흐름을 유지하고 승인 조회를 시도하지 않는다', async () => {
    for (const capability of [{ data: false, error: null }, { data: null, error: { code: 'PGRST202' } }]) {
      const rpc = vi.fn().mockResolvedValue(capability)
      expect(await loadProductionConditions({ rpc } as unknown as SupabaseClient)).toEqual({ productionConditionsAvailable: false, productionConditions: [] })
      expect(rpc).toHaveBeenCalledTimes(1)
    }
  })
  it('500건 이후도 RPC의 공장별 공개 결과를 누락 없이 읽으며 내부 필드를 임의로 추가하지 않는다', async () => {
    const ranges: number[][] = [], first = Array.from({ length: 500 }, (_, index) => ({ runId: `run-${index}`, version: 1, status: 'awaiting_approval', internalUnitCost: undefined })), second = [{ runId: 'run-500', version: 2, status: 'approved' }]
    const rpc = vi.fn((name: string) => name === 'get_production_conditions_capability' ? Promise.resolve({ data: true, error: null }) : { range: async (start: number, end: number) => { ranges.push([start, end]); return { data: start ? second : first, error: null } } })
    const result = await loadProductionConditions({ rpc } as unknown as SupabaseClient)
    expect(result.productionConditions).toHaveLength(501)
    expect(result.productionConditions!.at(-1)).toEqual(second[0])
    expect(ranges).toEqual([[0, 499], [500, 999]])
    expect(result.productionConditions!.at(-1)).not.toHaveProperty('internalUnitCost')
  })
  it('권한·연결 오류를 미설정으로 숨기지 않는다', async () => {
    const error = { code: '42501', message: 'FORBIDDEN' }
    await expect(loadProductionConditions({ rpc: vi.fn().mockResolvedValue({ data: null, error }) } as unknown as SupabaseClient)).rejects.toEqual(error)
    const failed = { rpc: vi.fn((name: string) => name === 'get_production_conditions_capability' ? Promise.resolve({ data: true, error: null }) : { range: async () => ({ data: null, error: { code: 'network', message: 'offline' } }) }) }
    await expect(loadProductionConditions(failed as unknown as SupabaseClient)).rejects.toEqual({ code: 'network', message: 'offline' })
  })
  it('공급자 제안과 본사 확정을 별도 RPC로 보내고 클라이언트 역할·승인 시각을 신뢰 근거로 전달하지 않는다', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: null })
    await configureProductionConditions('run', 1, 0, 'cmt', 0, '본사 내부 기준', profile)
    expect(mock.rpc).toHaveBeenLastCalledWith('configure_production_conditions', { p_run_id: 'run', p_expected_run_version: 1, p_expected_version: 0, p_production_mode: 'cmt', p_internal_unit_cost: 0, p_reason: '본사 내부 기준' })
    const data = { expectedDeliveryDate: '2026-11-30', unitCost: 1500, canProduce: true, quantityConfirmed: true, agreed: true, comment: '', delayReason: '', priceReason: '', confirmedQuantities: { ...emptyQuantities(), S: 10 } }
    await submitProductionConditions('run', 2, 3, 1, data, profile)
    expect(mock.rpc).toHaveBeenLastCalledWith('submit_production_conditions', { p_run_id: 'run', p_expected_run_version: 2, p_expected_po_version: 3, p_expected_version: 1, p_data: data })
    await reviewProductionConditions('run', 3, 2, 'approve', '2026-11-25', 1400, '협의한 조건 승인', profile)
    expect(mock.rpc).toHaveBeenLastCalledWith('review_production_conditions', { p_run_id: 'run', p_expected_run_version: 3, p_expected_version: 2, p_decision: 'approve', p_final_delivery_date: '2026-11-25', p_final_unit_cost: 1400, p_reason: '협의한 조건 승인' })
    expect(JSON.stringify(mock.rpc.mock.calls)).not.toContain('profile-id')
    expect(JSON.stringify(mock.rpc.mock.calls)).not.toContain('approvedAt')
  })
  it('수정·거절·변경 요청을 승인 호출과 구분하고 새 차수 연결은 수량 범위 확인을 명시한다', async () => {
    mock.rpc.mockResolvedValue({ data: null, error: null })
    await reviewProductionConditions('run', 3, 2, 'request_revision', '', null, '납기 재협의', profile)
    expect(mock.rpc.mock.calls[0][1]).toMatchObject({ p_decision: 'request_revision', p_final_unit_cost: null })
    await requestProductionConditionChange('run', 4, 3, '후속 생산 사양 변경', profile)
    expect(mock.rpc).toHaveBeenLastCalledWith('request_production_condition_change', { p_run_id: 'run', p_expected_run_version: 4, p_expected_version: 3, p_reason: '후속 생산 사양 변경' })
    await linkProductionConditionChange('request', 'replacement', 1, '별도 차수 수량 범위 확인', true, profile)
    expect(mock.rpc).toHaveBeenLastCalledWith('link_production_condition_change', { p_request_id: 'request', p_replacement_run_id: 'replacement', p_expected_replacement_run_version: 1, p_reason: '별도 차수 수량 범위 확인', p_confirmed_new_scope: true })
  })
  it('서버 충돌과 누락된 승인 기능은 사용자에게 명시적으로 전달한다', async () => {
    const error = { code: '40001', message: 'VERSION_CONFLICT' }; mock.rpc.mockResolvedValue({ error })
    await expect(requestProductionConditionChange('run', 4, 3, '변경 요청', profile)).rejects.toEqual(error)
    mock.rpc.mockResolvedValue({ error: { code: 'PGRST202' } })
    await expect(configureProductionConditions('run', 1, 0, 'cmt', null, '설정 요청', profile)).rejects.toThrow('관리자에게 문의')
  })
})
