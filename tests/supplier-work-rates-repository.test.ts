import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from '../src/lib/types'
import type { StyleOperationInput } from '../src/lib/operations-types'

const mock = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/lib/repository', () => ({ supabase: { rpc: mock.rpc }, getDemoWorkspace: vi.fn(), locked: vi.fn(), persist: vi.fn() }))
import { applySupplierQualityRate, loadSupplierWorkRates, saveStyleOperationWithSupplier, saveSupplierWorkItem, saveSupplierWorkRate } from '../src/lib/supplier-work-rates-repository'

const actor: Profile = { id: 'actor', name: '시험 본사', email: 'staff@example.test', role: 'internal', active: true, approved: true, factoryId: null }
beforeEach(() => mock.rpc.mockReset())

describe('업체 기준과 작업 단가의 클라우드 계약', () => {
  it('기준 작업과 단가를 한 번에 저장하며 카탈로그·가격 버전을 각각 전달한다', async () => {
    mock.rpc.mockResolvedValue({ error: null })
    await saveSupplierWorkItem('catalog', 'vendor', 'label', { name: '메인라벨', specification: '20×40', active: true, unitCost: 0 }, 3, 7, '미래 오더 기준 수정', actor)
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('save_supplier_work_item', { p_id: 'catalog', p_factory_id: 'vendor', p_kind: 'label', p_name: '메인라벨', p_specification: '20×40', p_active: true, p_unit_cost: 0, p_expected_catalog_version: 3, p_expected_rate_version: 7, p_reason: '미래 오더 기준 수정' })
  })
  it('작업 배정과 기본 단가 스냅샷은 공급업체 RPC 한 번으로 저장하고 임의 메타데이터는 제외한다', async () => {
    mock.rpc.mockResolvedValue({ error: null })
    const data: StyleOperationInput = { rows: [], note: '작업 요청', voided: false, supplierFactoryId: 'tampered', catalogVersions: { tampered: 999 } }
    await saveStyleOperationWithSupplier('operation', 'style', 'embroidery', 'vendor', 4, data, '자수 작업 등록', actor, { catalog: 2 })
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('save_style_operation_with_supplier', { p_id: 'operation', p_style_id: 'style', p_kind: 'embroidery', p_supplier_factory_id: 'vendor', p_expected_version: 4, p_data: { rows: [], note: '작업 요청', voided: false }, p_reason: '자수 작업 등록', p_catalog_versions: { catalog: 2 } })
  })
  it('검사 기준 적용에 배정 버전·스타일 단가 버전을 모두 보내고 서버 충돌을 유지한다', async () => {
    const failure = { code: '40001', message: 'VERSION_CONFLICT' }
    mock.rpc.mockResolvedValue({ error: failure })
    await expect(applySupplierQualityRate('style', 'line', 'kotiti', '아우터', 3, 5, '검사 업체 단가 적용', actor)).rejects.toEqual(failure)
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('apply_supplier_quality_rate', { p_style_id: 'style', p_line_id: 'line', p_factory_id: 'kotiti', p_category: '아우터', p_expected_assignment_version: 3, p_expected_price_version: 5, p_reason: '검사 업체 단가 적용' })
  })
  it('잘못된 단가는 호출 전에 거부하고 미적용 SQL은 기존 저장에 우회하지 않는다', async () => {
    await expect(saveSupplierWorkRate('vendor', 'label', 'catalog', 1.001, 1, '단가 수정', actor)).rejects.toThrow('소수 둘째')
    expect(mock.rpc).not.toHaveBeenCalled()
    mock.rpc.mockResolvedValue({ error: { code: 'PGRST202' } })
    await expect(saveSupplierWorkRate('vendor', 'quality', '아우터', null, 0, '검사 단가 미기재', actor)).rejects.toThrow('021')
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('save_supplier_work_rate', { p_factory_id: 'vendor', p_kind: 'quality', p_item_key: '아우터', p_unit_cost: null, p_expected_version: 0, p_reason: '검사 단가 미기재' })
  })
  it('지원되지 않거나 승인되지 않은 기준 기능은 테이블을 읽지 않고 권한 오류는 숨기지 않는다', async () => {
    for (const response of [{ data: false, error: null }, { data: null, error: { code: '42883' } }]) {
      const client = { rpc: vi.fn(async () => response), from: vi.fn() }
      expect(await loadSupplierWorkRates(client as unknown as SupabaseClient)).toEqual({ supplierWorkRatesAvailable: false, supplierWorkRates: [], supplierWorkRateAudits: [] })
      expect(client.from).not.toHaveBeenCalled()
    }
    const error = { code: '42501', message: 'denied' }
    await expect(loadSupplierWorkRates({ rpc: vi.fn(async () => ({ data: null, error })) } as unknown as SupabaseClient)).rejects.toEqual(error)
  })
  it('기준 단가와 비공개 이력의 0원·null을 구분하고 모든 페이지를 읽는다', async () => {
    const base = { factory_id: 'vendor', kind: 'label', item_key: 'catalog', unit_cost: '0', version: 2, created_at: 'created', updated_at: 'updated', updated_by: 'actor' }
    const requests: { table: string; orders: string[]; range?: number[] }[] = []
    const client = {
      rpc: vi.fn(async () => ({ data: true, error: null })),
      from: (table: string) => {
        const state = { table, orders: [] as string[], range: undefined as number[] | undefined }; requests.push(state)
        const query = { select: () => query, order: (key: string) => { state.orders.push(key); return query }, range: async (start: number, end: number) => {
          state.range = [start, end]
          const data = table === 'supplier_work_rates' ? start === 0 ? Array.from({ length: 500 }, (_, index) => ({ ...base, item_key: `catalog-${index}` })) : [{ ...base, item_key: 'blank', unit_cost: null }] : [{ id: 'audit', factory_id: 'vendor', kind: 'label', item_key: 'catalog', actor_id: 'actor', actor_name: '업체 담당자', reason: '기준 단가 수정', before: { ...base, unit_cost: null }, after: base, created_at: 'updated' }]
          return { data, error: null }
        } }
        return query
      },
    }
    const result = await loadSupplierWorkRates(client as unknown as SupabaseClient)
    expect(result.supplierWorkRatesAvailable).toBe(true)
    expect(result.supplierWorkRates).toHaveLength(501)
    expect(result.supplierWorkRates![0]).toMatchObject({ factoryId: 'vendor', unitCost: 0 })
    expect(result.supplierWorkRates!.at(-1)?.unitCost).toBeNull()
    expect(result.supplierWorkRateAudits![0]).toMatchObject({ before: { unitCost: null }, after: { unitCost: 0 }, actorName: '업체 담당자' })
    expect(requests).toEqual([{ table: 'supplier_work_rates', orders: ['factory_id', 'kind', 'item_key'], range: [0, 499] }, { table: 'supplier_work_rates', orders: ['factory_id', 'kind', 'item_key'], range: [500, 999] }, { table: 'supplier_work_rate_audits', orders: ['id'], range: [0, 499] }])
  })
})
