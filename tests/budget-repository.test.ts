import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from '../src/lib/types'

const mock = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/lib/repository', () => ({ supabase: { rpc: mock.rpc }, getDemoWorkspace: vi.fn(), locked: vi.fn(), persist: vi.fn() }))
import { loadBudgetWorkspace, loadFinanceOnlyWorkspace, saveBudgetRecord } from '../src/lib/budget-repository'

const own = { id: 'finance', name: 'FA 담당자', email: 'finance@example.test', role: 'finance', approved: true, active: true, factory_id: null }
const input = { styles: [], profiles: [], projects: [], factories: [], comments: [], attachments: [], audits: [] }
function client(profile = own, capability: { data: unknown; error: unknown } = { data: true, error: null }, response: { data: unknown; error: unknown } = { data: { records: [], audits: [], sourceInput: input }, error: null }) {
  const tables: string[] = []
  const rpc = vi.fn(async (name: string) => name === 'get_budget_capability' ? capability : name === 'get_budget_cost_import_capability' ? { data: true, error: null } : name === 'get_budget_cost_imports' ? { data: { imports: [], aliases: [] }, error: null } : response)
  const value = { auth: { getSession: async () => ({ data: { session: { user: { id: own.id } } }, error: null }) }, rpc,
    from: (table: string) => { tables.push(table); const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: profile, error: null }) }; return query },
  } as unknown as SupabaseClient
  return { value, tables, rpc }
}
beforeEach(() => mock.rpc.mockReset())

describe('예산 전용 클라우드 조회와 저장 경계', () => {
  it('FA 계정을 발견한 뒤 일반 생산 테이블을 요청하지 않고 전용 조회만 사용한다', async () => {
    const fixture = client(), result = await loadFinanceOnlyWorkspace(fixture.value)
    expect(fixture.tables).toEqual(['profiles'])
    expect(fixture.rpc.mock.calls.map(args => args[0])).toEqual(['get_budget_capability', 'get_budget_workspace', 'get_budget_cost_import_capability', 'get_budget_cost_imports'])
    expect(result?.profiles).toHaveLength(1)
    expect(result?.profiles[0]).toMatchObject({ id: own.id, role: 'finance' })
    expect(result?.styles).toEqual([]); expect(result?.projects).toEqual([]); expect(result?.factories).toEqual([])
    expect(result?.operations?.poDispatches).toEqual([]); expect(result?.attachments).toEqual([])
    expect(result?.budgetSources).toEqual({ orders: [], settlements: [], warnings: [] })
    expect(result?.budgetAvailable).toBe(true)
  })
  it('미승인·비활성 FA에는 재무 조회 RPC도 호출하지 않고 일반 로더로 돌아가지 않는다', async () => {
    for (const profile of [{ ...own, active: false }, { ...own, approved: false }]) {
      const fixture = client(profile), result = await loadFinanceOnlyWorkspace(fixture.value)
      expect(fixture.tables).toEqual(['profiles']); expect(fixture.rpc).not.toHaveBeenCalled()
      expect(result).not.toBeNull(); expect(result?.budgetAvailable).toBe(false); expect(result?.styles).toEqual([])
    }
  })
  it('설정 미적용과 조회 중 권한 회수를 빈 생산 화면으로 대체하지 않는다', async () => {
    const fixture = client(own, { data: null, error: { code: 'PGRST202' } })
    const result = await loadFinanceOnlyWorkspace(fixture.value)
    expect(result).not.toBeNull(); expect(result?.budgetAvailable).toBe(false)
    expect(fixture.rpc).toHaveBeenCalledTimes(1)
    const denied = { code: '42501', message: 'access revoked' }, revoked = client(own, undefined, { data: null, error: denied })
    await expect(loadFinanceOnlyWorkspace(revoked.value)).rejects.toEqual(denied)
    expect(revoked.tables).toEqual(['profiles'])
  })
  it('공장 기능 비활성 응답은 재무 자료 조회를 하지 않고 기존 생산 로더를 유지한다', async () => {
    const fixture = client({ ...own, role: 'factory' }, { data: false, error: null })
    expect(await loadFinanceOnlyWorkspace(fixture.value)).toBeNull()
    expect(fixture.rpc).not.toHaveBeenCalled()
    expect((await loadBudgetWorkspace(fixture.value)).budgetAvailable).toBe(false)
    expect(fixture.rpc.mock.calls.map(args => args[0])).toEqual(['get_budget_capability'])
  })
  it('통신 오류와 잘못된 전용 조회 형식을 성공이나 미설정으로 숨기지 않는다', async () => {
    const network = { code: 'NETWORK', message: 'offline' }, fixture = client(own, { data: null, error: network })
    await expect(loadBudgetWorkspace(fixture.value)).rejects.toEqual(network)
    await expect(loadBudgetWorkspace(client(own, undefined, { data: { records: [] }, error: null }).value)).rejects.toThrow('예산·을지 정보')
  })
  it('저장 시 사용자 역할을 권한 근거로 전송하지 않고 서버 버전 충돌을 전달한다', async () => {
    const actor: Profile = { ...own, role: 'internal', factoryId: null }
    mock.rpc.mockResolvedValue({ data: null, error: null })
    await saveBudgetRecord('limit', 'id', { season: '2027FY', amount: 10000 }, 2, '예산 한도 확인', actor)
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('save_budget_record', { p_kind: 'limit', p_id: 'id', p_data: { season: '2027FY', amount: 10000 }, p_expected_version: 2, p_reason: '예산 한도 확인' })
    const conflict = { code: '40001', message: 'VERSION_CONFLICT' }; mock.rpc.mockResolvedValue({ data: null, error: conflict })
    await expect(saveBudgetRecord('limit', 'id', { season: '2027FY', amount: 9000 }, 2, '예산 한도 변경', actor)).rejects.toEqual(conflict)
  })
})
