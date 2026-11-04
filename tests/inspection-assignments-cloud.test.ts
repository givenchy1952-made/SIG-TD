import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
const api = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/lib/repository', () => ({ supabase: api, getDemoWorkspace: vi.fn(), locked: vi.fn(), persist: vi.fn() }))
import { loadInspectionAssignments, saveFactoryServiceSettings, saveInspectionAssignment } from '../src/lib/inspection-assignments-repository'
import { createSeed } from '../src/lib/seed'
import { emptyQuantities } from '../src/lib/types'
const assignment = { style_id: 'style', line_id: 'line', provider: 'able', version: 1, updated_at: '2026-11-04', updated_by: 'hq' }
const order = { styleId: 'style', lineId: 'line', projectId: 'project', projectName: '생산 명칭', season: '2026FY', styleCode: 'STYLE', color: 'BK', order: { ...emptyQuantities(), S: 10 }, orderQuantity: 10, dueDate: '2026-12-01', provider: 'able', quality: { category: '아우터', status: 'todo', quantity: 10, note: '검사 요청' } }
function client(probe: { data: unknown; error: unknown }, assignmentPages: unknown[][] = [[assignment]], orderPages: unknown[][] = [[order]], failure: unknown = null) {
  const from = vi.fn(() => { const request = { select: () => request, order: () => request, range: async (offset: number) => ({ data: assignmentPages[offset / 500] || [], error: failure }) }; return request })
  const rpc = vi.fn((name: string) => name === 'get_inspection_assignments_capability' ? Promise.resolve(probe) : { range: async (offset: number) => ({ data: orderPages[offset / 500] || [], error: failure }) })
  return { value: { rpc, from } as unknown as SupabaseClient, rpc, from }
}
beforeEach(() => api.rpc.mockReset())
describe('검사 배정 클라우드 저장·단계별 적용', () => {
  it('020 미설치는 기존 기능과 구분하고 검사 조회를 준비 상태로 둔다', async () => {
    const c = client({ data: null, error: { code: 'PGRST202' } })
    expect(await loadInspectionAssignments(c.value)).toEqual({ inspectionAssignmentsAvailable: false, inspectionAssignments: [], inspectionOrders: [] })
    expect(c.from).not.toHaveBeenCalled(); expect(c.rpc).toHaveBeenCalledTimes(1)
  })
  it('승인되지 않은 계정은 배정·검사 오더를 요청하지 않는다', async () => {
    const c = client({ data: false, error: null })
    expect((await loadInspectionAssignments(c.value)).inspectionOrders).toEqual([])
    expect(c.from).not.toHaveBeenCalled()
  })
  it('본사 배정 테이블과 최소 오더 투영값을 끝 페이지까지 읽는다', async () => {
    const c = client({ data: true, error: null }, [Array.from({ length: 500 }, () => assignment), [assignment]], [Array.from({ length: 500 }, () => order), [order]])
    const result = await loadInspectionAssignments(c.value)
    expect(result.inspectionAssignmentsAvailable).toBe(true)
    expect(result.inspectionAssignments).toHaveLength(501); expect(result.inspectionOrders).toHaveLength(501)
    expect(result.inspectionAssignments?.at(-1)).toEqual({ styleId: 'style', lineId: 'line', provider: 'able', version: 1, updatedAt: '2026-11-04', updatedBy: 'hq' })
  })
  it('검사 계정의 원본 배정 테이블이 RLS로 비어 있어도 허용된 오더 투영값을 받는다', async () => {
    const result = await loadInspectionAssignments(client({ data: true, error: null }, [[]]).value)
    expect(result.inspectionAssignments).toEqual([]); expect(result.inspectionOrders).toEqual([order])
  })
  it('권한·네트워크 실패를 미설치로 숨기지 않는다', async () => {
    const denied = { code: '42501', message: 'permission denied' }
    await expect(loadInspectionAssignments(client({ data: null, error: denied }).value)).rejects.toEqual(denied)
    await expect(loadInspectionAssignments(client({ data: true, error: null }, [], [], denied).value)).rejects.toEqual(denied)
  })
  it('배정·해제를 기존 ID·예상 버전·사유와 함께 RPC로 전달한다', async () => {
    api.rpc.mockResolvedValue({ error: null })
    await saveInspectionAssignment('style', 'line', null, 4, '검사 배정 해제', createSeed().profiles[0])
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith('save_inspection_assignment', { p_style_id: 'style', p_line_id: 'line', p_provider: null, p_expected_version: 4, p_reason: '검사 배정 해제' })
  })
  it('업체 서비스 설정은 별도 버전 RPC를 사용하며 서버 충돌을 보존한다', async () => {
    const failure = { code: '40001', message: 'VERSION_CONFLICT' }; api.rpc.mockResolvedValue({ error: failure })
    await expect(saveFactoryServiceSettings('factory', { serviceType: 'inspection', inspectionProvider: 'kotiti' }, 2, 'KOTITI 서비스 연결', createSeed().profiles[0])).rejects.toEqual(failure)
    expect(api.rpc).toHaveBeenCalledExactlyOnceWith('save_factory_service_settings', { p_id: 'factory', p_service_type: 'inspection', p_inspection_provider: 'kotiti', p_expected_version: 2, p_reason: 'KOTITI 서비스 연결' })
  })
})
