import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
const loaders = vi.hoisted(() => ({ inspections: vi.fn(), rates: vi.fn() }))
vi.mock('../src/lib/inspection-assignments-repository', () => ({ loadInspectionAssignments: loaders.inspections }))
vi.mock('../src/lib/supplier-work-rates-repository', () => ({ loadSupplierWorkRates: loaders.rates }))
import { loadInspectionOnlyWorkspace } from '../src/lib/inspection-cloud-workspace'

const profile = { id: 'inspector', name: '검사 담당자', email: 'inspector@example.test', role: 'factory', approved: true, active: true, factory_id: 'able-factory' }
const factory = { id: 'able-factory', name: '에이블', country: '대한민국', active: true, service_type: 'inspection', inspection_provider: 'able', service_settings_version: 1 }
const order = { styleId: 'assigned-style', lineId: 'line', projectId: 'project', projectName: '시그니피컨트 검사 프로젝트', season: '2026FY', styleCode: 'QACLOUD', color: 'BK', order: { XXS: 1, XS: 2, S: 3, M: 4, L: 5, XL: 6 }, orderQuantity: 21, dueDate: '2026-12-01', provider: 'able', quality: { category: '아우터', status: 'todo', quantity: 21, note: '검사 요청' } }
function client(person = profile, supplier: typeof factory | null = factory, failure: unknown = null) {
  const tables: string[] = []
  const value = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'inspector' } } }, error: null }) },
    from: (table: string) => { tables.push(table); const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: table === 'profiles' ? person : supplier, error: failure }) }; return query },
  } as unknown as SupabaseClient
  return { value, tables }
}
beforeEach(() => {
  loaders.inspections.mockReset(); loaders.rates.mockReset()
  loaders.inspections.mockResolvedValue({ inspectionAssignmentsAvailable: true, inspectionAssignments: [{ styleId: 'other', provider: 'kotiti' }], inspectionOrders: [{ ...order, projectCode: 'INTERNAL-A', price: 900 }, { ...order, styleId: 'other', provider: 'kotiti' }] })
  loaders.rates.mockResolvedValue({ supplierWorkRatesAvailable: true, supplierWorkRates: [{ factoryId: 'able-factory', kind: 'quality', itemKey: '아우터', unitCost: 300, version: 1 }, { factoryId: 'kotiti-factory', kind: 'quality', itemKey: '아우터', unitCost: 800, version: 1 }], supplierWorkRateAudits: [] })
})
describe('검사 계정의 주문 조회 전 별도 워크스페이스', () => {
  it('계정·자기업체 외 일반 생산 테이블을 요청하지 않고 배정 검사 정보만 보존한다', async () => {
    const mock = client(), result = await loadInspectionOnlyWorkspace(mock.value)
    expect(mock.tables).toEqual(['profiles', 'factories'])
    expect(result?.styles).toEqual([]); expect(result?.projects).toEqual([]); expect(result?.operations?.poDispatches).toEqual([])
    expect(result?.inspectionOrders).toEqual([order]); expect(result?.inspectionAssignments).toEqual([])
    expect(result?.supplierWorkRates).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('INTERNAL-A'); expect(JSON.stringify(result)).not.toContain('kotiti-factory')
  })
  it('검사 업체 미지정 계정도 일반 생산 모드로 빠지지 않고 빈 오더만 표시한다', async () => {
    const result = await loadInspectionOnlyWorkspace(client(profile, { ...factory, inspection_provider: null as unknown as string }).value)
    expect(result).not.toBeNull(); expect(result?.inspectionOrders).toEqual([]); expect(result?.styles).toEqual([])
  })
  it('비활성 검사 계정은 주문·단가 RPC까지 요청하지 않는다', async () => {
    const mock = client({ ...profile, active: false }, null), result = await loadInspectionOnlyWorkspace(mock.value)
    expect(mock.tables).toEqual(['profiles'])
    expect(result?.profiles[0]).toMatchObject({ id: profile.id, active: false })
    expect(result?.inspectionOrders).toEqual([]); expect(result?.supplierWorkRates).toEqual([])
    expect(loaders.inspections).not.toHaveBeenCalled(); expect(loaders.rates).not.toHaveBeenCalled()
  })
  it('미승인 계정도 RLS상 보이지 않는 업체를 조회하거나 일반 업무 로더로 빠지지 않는다', async () => {
    const mock = client({ ...profile, approved: false }, null), result = await loadInspectionOnlyWorkspace(mock.value)
    expect(mock.tables).toEqual(['profiles']);expect(result).not.toBeNull()
    expect(result?.profiles[0]).toMatchObject({ id: profile.id, approved: false })
    expect(result?.styles).toEqual([]);expect(result?.inspectionOrders).toEqual([])
    expect(loaders.inspections).not.toHaveBeenCalled();expect(loaders.rates).not.toHaveBeenCalled()
  })
  it('승인 확인과 업체 조회 사이에 업체가 보이지 않게 되면 이전 업무 범위로 돌아가지 않는다', async () => {
    const mock = client(profile, null), result = await loadInspectionOnlyWorkspace(mock.value)
    expect(mock.tables).toEqual(['profiles', 'factories']);expect(result).not.toBeNull()
    expect(result?.profiles).toHaveLength(1);expect(result?.factories).toEqual([])
    expect(result?.styles).toEqual([]);expect(result?.projects).toEqual([]);expect(result?.inspectionOrders).toEqual([])
    expect(loaders.inspections).not.toHaveBeenCalled();expect(loaders.rates).not.toHaveBeenCalled()
  })
  it('업체 배정이 없는 계정은 본사 승인 안내에 필요한 프로필만 유지한다', async () => {
    const mock = client({ ...profile, approved: false, factory_id: '' }, null), result = await loadInspectionOnlyWorkspace(mock.value)
    expect(mock.tables).toEqual(['profiles']);expect(result?.profiles[0].factoryId).toBeNull()
    expect(result?.styles).toEqual([]);expect(loaders.inspections).not.toHaveBeenCalled()
  })
  it('일반 생산 업체는 기존 로더를 계속 사용한다', async () => {
    expect(await loadInspectionOnlyWorkspace(client(profile, { ...factory, service_type: 'production' }).value)).toBeNull()
    expect(loaders.inspections).not.toHaveBeenCalled()
  })
  it('020 적용 전 서비스 구분이 없는 기존 생산 업체도 기존 로더를 유지한다', async () => {
    expect(await loadInspectionOnlyWorkspace(client(profile, { ...factory, service_type: undefined as unknown as string }).value)).toBeNull()
    expect(loaders.inspections).not.toHaveBeenCalled();expect(loaders.rates).not.toHaveBeenCalled()
  })
  it('본사 계정은 검사 주문 전용 경로에 들어가지 않는다', async () => {
    const mock = client({ ...profile, role: 'internal' })
    expect(await loadInspectionOnlyWorkspace(mock.value)).toBeNull(); expect(mock.tables).toEqual(['profiles'])
  })
  it('권한·연결 오류를 일반 생산 경로로 숨기지 않는다', async () => {
    const denied = { code: '42501', message: 'permission denied' }
    await expect(loadInspectionOnlyWorkspace(client(profile, factory, denied).value)).rejects.toEqual(denied)
    expect(loaders.inspections).not.toHaveBeenCalled()
  })
})
