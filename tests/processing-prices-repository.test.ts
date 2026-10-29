import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from '../src/lib/types'

const mock = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/lib/repository', () => ({ supabase: { rpc: mock.rpc }, getDemoWorkspace: vi.fn(), locked: vi.fn(), persist: vi.fn() }))
import { loadProcessingUnitPrices, saveProcessingUnitPrice } from '../src/lib/processing-prices-repository'

const staff: Profile = { id: 'actor', name: '시험 본사', email: 'staff@example.test', role: 'internal', active: true, approved: true, factoryId: null }
function client(capability = { data: true as unknown, error: null as unknown }, pages: Record<string, unknown>[][] = [], failure: unknown = null) {
  const requests: { table: string; orders: string[]; ranges: number[][] }[] = []
  const from = vi.fn((table: string) => {
    const state = { table, orders: [] as string[], ranges: [] as number[][] }; requests.push(state)
    const request = { select: () => request, order: (column: string) => { state.orders.push(column); return request }, range: async (start: number, end: number) => { state.ranges.push([start,end]); return { data: pages[start / 500] || [], error: failure } } }
    return request
  })
  return { value: { rpc: vi.fn(async () => capability), from } as unknown as SupabaseClient, from, requests }
}
beforeEach(() => mock.rpc.mockReset())

describe('가공·품질 단가 저장·클라우드 읽기', () => {
  it('공개 입력만 RPC에 보내고 클라이언트의 역할·수정 시각을 저장 근거로 보내지 않는다', async () => {
    mock.rpc.mockResolvedValue({ error: null })
    await saveProcessingUnitPrice('style','color','label','work',125.25,3,'업체 단가 협의',staff)
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('save_processing_unit_price', { p_style_id: 'style', p_line_id: 'color', p_kind: 'label', p_item_key: 'work', p_unit_cost: 125.25, p_expected_version: 3, p_reason: '업체 단가 협의' })
  })
  it('잘못된 가격은 네트워크 호출 전 거부하고 서버 충돌은 숨기지 않는다', async () => {
    await expect(saveProcessingUnitPrice('s','l','label','i',1.001,0,'단가 협의',staff)).rejects.toThrow('소수 둘째')
    expect(mock.rpc).not.toHaveBeenCalled()
    const error = { code: '40001', message: 'VERSION_CONFLICT' }; mock.rpc.mockResolvedValue({ error })
    await expect(saveProcessingUnitPrice('s','l','label','i',100,0,'단가 협의',staff)).rejects.toEqual(error)
    expect(mock.rpc).toHaveBeenCalledTimes(1)
  })
  it('미설정·미승인 기능에는 단가 테이블을 요청하지 않는다', async () => {
    for (const capability of [{ data: false, error: null }, { data: null, error: { code: 'PGRST202' } }]) {
      const fixture = client(capability)
      expect(await loadProcessingUnitPrices(fixture.value)).toEqual({ processingUnitPrices: [], processingPricesAvailable: false })
      expect(fixture.from).not.toHaveBeenCalled()
    }
  })
  it('권한과 통신 실패를 설정 미완료로 숨기지 않는다', async () => {
    const denied = { code: '42501', message: 'permission denied' }, first = client({ data: null, error: denied })
    await expect(loadProcessingUnitPrices(first.value)).rejects.toEqual(denied)
    const failure = { code: 'NETWORK', message: 'offline' }, second = client(undefined, [], failure)
    await expect(loadProcessingUnitPrices(second.value)).rejects.toEqual(failure)
  })
  it('500개 이후도 정렬된 전체 키로 읽고 숫자·공란·메타데이터를 보존한다', async () => {
    const row = { style_id: 'style', line_id: 'color', kind: 'label', item_key: 'item', unit_cost: '1250.25', version: 4, created_at: 'created', updated_at: 'updated', updated_by: 'actor' }
    const fixture = client(undefined, [Array.from({ length: 500 }, (_, index) => ({ ...row, item_key: `item-${index}` })), [{ ...row, item_key: 'last', unit_cost: null }]])
    const result = await loadProcessingUnitPrices(fixture.value)
    expect(result.processingPricesAvailable).toBe(true); expect(result.processingUnitPrices).toHaveLength(501)
    expect(result.processingUnitPrices[0]).toEqual({ styleId: 'style', lineId: 'color', kind: 'label', itemKey: 'item-0', unitCost: 1250.25, version: 4, createdAt: 'created', updatedAt: 'updated', updatedBy: 'actor' })
    expect(result.processingUnitPrices.at(-1)?.unitCost).toBeNull()
    expect(fixture.requests).toEqual([
      { table: 'processing_unit_prices', orders: ['style_id','line_id','kind','item_key'], ranges: [[0,499]] },
      { table: 'processing_unit_prices', orders: ['style_id','line_id','kind','item_key'], ranges: [[500,999]] },
    ])
    expect(fixture.requests.some(request => request.table === 'processing_unit_price_audits')).toBe(false)
  })
})
