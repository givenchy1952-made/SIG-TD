import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from '../src/lib/types'
import type { BudgetCostImportRequest } from '../src/lib/budget-cost-import-types'

const mock = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/lib/repository', () => ({ supabase: { rpc: mock.rpc }, getDemoWorkspace: vi.fn(), locked: vi.fn(), persist: vi.fn() }))
import { importBudgetCosts, loadBudgetCostImports } from '../src/lib/budget-cost-import-repository'

beforeEach(() => mock.rpc.mockReset())
const client = () => ({ rpc: mock.rpc }) as unknown as SupabaseClient
const request: BudgetCostImportRequest = { importId: '99110000-0000-4000-8000-000000000001', fileName: 'QA.xlsx', contentHash: 'a'.repeat(64), rows: [] }
const actor: Profile = { id: '99110000-0000-4000-8000-000000000002', name: '본사', email: 'qa@example.test', role: 'internal', approved: true, active: true, factoryId: null }

describe('원가 업로드 클라우드 경계', () => {
  it('미설정과 공장 권한은 원본 연결 목록을 조회하지 않는다', async () => {
    for (const result of [{ data: false, error: null }, { data: null, error: { code: 'PGRST202' } }]) {
      mock.rpc.mockReset().mockResolvedValue(result)
      expect(await loadBudgetCostImports(client())).toEqual({ budgetCostImportAvailable: false, budgetCostImports: [], budgetCostImportAliases: [] })
      expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('get_budget_cost_import_capability')
    }
  })
  it('원본 목록과 별칭을 페이지 제한 없는 단일 조회로 읽는다', async () => {
    const imports = Array.from({ length: 1100 }, (_, index) => ({ recordId: String(index) })), aliases = [{ recordId: '0' }]
    mock.rpc.mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: { imports, aliases }, error: null })
    expect(await loadBudgetCostImports(client())).toEqual({ budgetCostImportAvailable: true, budgetCostImports: imports, budgetCostImportAliases: aliases })
    expect(mock.rpc.mock.calls).toEqual([['get_budget_cost_import_capability'], ['get_budget_cost_imports']])
  })
  it('권한 회수·통신 오류·불완전한 응답을 미설정이나 성공으로 숨기지 않는다', async () => {
    const denied = { code: '42501', message: 'revoked' }
    mock.rpc.mockResolvedValue({ data: null, error: denied })
    await expect(loadBudgetCostImports(client())).rejects.toEqual(denied)
    mock.rpc.mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: { imports: [] }, error: null })
    await expect(loadBudgetCostImports(client())).rejects.toThrow('원본 정보')
  })
  it('단일 원자적 저장 요청에는 클라이언트 역할을 권한 근거로 보내지 않는다', async () => {
    mock.rpc.mockResolvedValue({ data: { inserted: 2, updated: 1, skipped: 3 }, error: null })
    expect(await importBudgetCosts(request, '원가 확인', actor)).toEqual({ inserted: 2, updated: 1, skipped: 3 })
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('import_budget_cost_rows', { p_request: request, p_reason: '원가 확인' })
  })
  it('버전 충돌을 전달하며 불확실한 저장 결과와 누락된 SQL은 성공 처리하지 않는다', async () => {
    const conflict = { code: '40001', message: 'VERSION_CONFLICT' }
    mock.rpc.mockResolvedValue({ data: null, error: conflict })
    await expect(importBudgetCosts(request, '원가 확인', actor)).rejects.toEqual(conflict)
    mock.rpc.mockResolvedValue({ data: { inserted: -1, updated: 0, skipped: 0 }, error: null })
    await expect(importBudgetCosts(request, '원가 확인', actor)).rejects.toThrow('결과')
    mock.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    await expect(importBudgetCosts(request, '원가 확인', actor)).rejects.toThrow('025_budget_cost_import.sql')
  })
})
