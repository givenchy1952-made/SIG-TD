import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from './types'
import type { BudgetCostImportRequest, BudgetCostImportResult, BudgetCostImportsFields } from './budget-cost-import-types'
import { applyBudgetCostImportInWorkspace } from './budget-cost-import'
import { getDemoWorkspace, locked, persist, supabase } from './repository'

const missing = (code: string) => ['PGRST202', 'PGRST205', '42P01', '42883'].includes(code)
const unavailable = (): BudgetCostImportsFields => ({ budgetCostImportAvailable: false, budgetCostImports: [], budgetCostImportAliases: [] })

/** Provenance is financial metadata only. The single JSON RPC includes all
 * rows, avoiding silent truncation at the REST service's default row cap. */
export async function loadBudgetCostImports(client: SupabaseClient): Promise<BudgetCostImportsFields> {
  const capability = await client.rpc('get_budget_cost_import_capability')
  if (capability.error && missing(capability.error.code)) return unavailable()
  if (capability.error) throw capability.error
  if (capability.data !== true) return unavailable()
  const result = await client.rpc('get_budget_cost_imports')
  if (result.error && missing(result.error.code)) return unavailable()
  if (result.error) throw result.error
  if (!result.data || !Array.isArray(result.data.imports) || !Array.isArray(result.data.aliases)) throw new Error('원가 업로드 원본 정보를 확인하지 못했습니다. 다시 불러와 주세요.')
  return { budgetCostImportAvailable: true, budgetCostImports: result.data.imports, budgetCostImportAliases: result.data.aliases }
}

export async function importBudgetCosts(request: BudgetCostImportRequest, reason: string, profile: Profile): Promise<BudgetCostImportResult> {
  if (supabase) {
    const result = await supabase.rpc('import_budget_cost_rows', { p_request: request, p_reason: reason })
    if (result.error) {
      if (missing(result.error.code)) throw new Error('원가계산서 업로드 설정이 필요합니다. 025_budget_cost_import.sql을 적용한 뒤 다시 접속해 주세요.')
      throw result.error
    }
    const value = result.data
    if (!value || !['inserted', 'updated', 'skipped'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) throw new Error('원가 업로드 결과를 확인하지 못했습니다. 새로고침한 뒤 원본 연결 내역을 확인해 주세요.')
    return { inserted: value.inserted, updated: value.updated, skipped: value.skipped }
  }
  return locked(() => {
    const { workspace, result } = applyBudgetCostImportInWorkspace(getDemoWorkspace(), profile, request, reason)
    persist(workspace)
    return result
  })
}

export const importBudgetCostRows = importBudgetCosts
