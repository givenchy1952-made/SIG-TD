import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile, Workspace } from './types'
import type { BudgetDataByKind, BudgetRecordKind, BudgetWorkspaceFields } from './budget-types'
import type { BudgetCostImportsFields } from './budget-cost-import-types'
import { buildBudgetSources, saveBudgetRecordInWorkspace } from './budget-domain'
import { EMPTY_OPERATIONS } from './operations-types'
import { loadBudgetCostImports } from './budget-cost-import-repository'
import { getDemoWorkspace, locked, persist, supabase } from './repository'

const missing = (code: string) => ['PGRST202', 'PGRST205', '42P01', '42883'].includes(code)
const unavailable = (): BudgetWorkspaceFields & BudgetCostImportsFields => ({ budgetAvailable: false, budgetCostImportAvailable: false, budgetCostImports: [], budgetCostImportAliases: [], budgetSources: { orders: [], settlements: [], warnings: [] }, budgetRecords: [], budgetAudits: [] })

/** A single JSON RPC avoids the REST row cap. Its server-side projection is
 * intentionally limited to financial identities, quantities and amounts.
 * The temporary source inputs never become a general production workspace. */
export async function loadBudgetWorkspace(client: SupabaseClient): Promise<BudgetWorkspaceFields & BudgetCostImportsFields> {
  const capability = await client.rpc('get_budget_capability')
  if (capability.error && missing(capability.error.code)) return unavailable()
  if (capability.error) throw capability.error
  if (capability.data !== true) return unavailable()
  const result = await client.rpc('get_budget_workspace')
  if (result.error && missing(result.error.code)) return unavailable()
  if (result.error) throw result.error
  const value = result.data
  if (!value || !Array.isArray(value.records) || !Array.isArray(value.audits) || !value.sourceInput || !Array.isArray(value.sourceInput.styles) || !Array.isArray(value.sourceInput.projects)) throw new Error('예산·을지 정보를 확인하지 못했습니다. 다시 접속해 주세요.')
  const input = value.sourceInput as Partial<Workspace>
  const financialInput: Workspace = {
    styles: [], profiles: [], factories: [], projects: [], comments: [], attachments: [], audits: [],
    ...input,
    operations: { ...structuredClone(EMPTY_OPERATIONS), ...input.operations },
    operationsAvailable: true, processingPricesAvailable: true, productionLedgerAvailable: true,
    inspectionAssignmentsAvailable: true, refinementsAvailable: true,
  }
  return { ...await loadBudgetCostImports(client), budgetAvailable: true, budgetSources: buildBudgetSources(financialInput), budgetRecords: value.records, budgetAudits: value.audits }
}

/** Discover finance before any normal order/PO/storage loaders. Even if the
 * migration is missing or access was revoked, a finance account must never
 * fall through to the ordinary production loader. */
export async function loadFinanceOnlyWorkspace(client: SupabaseClient): Promise<Workspace | null> {
  const session = await client.auth.getSession()
  if (session.error) throw session.error
  const id = session.data.session?.user.id
  if (!id) return null
  const own = await client.from('profiles').select('*').eq('id', id).maybeSingle()
  if (own.error) throw own.error
  if (!own.data || own.data.role !== 'finance') return null
  const row = own.data
  const profile: Profile = { id: row.id, name: row.name, email: row.email, role: 'finance', approved: !!row.approved, active: !!row.active, factoryId: null,
    ...('withdrawn_at' in row ? { withdrawnAt: row.withdrawn_at, withdrawnBy: row.withdrawn_by } : {}) }
  const base: Workspace = {
    profiles: [profile], styles: [], factories: [], projects: [], comments: [], attachments: [], audits: [],
    operations: structuredClone(EMPTY_OPERATIONS), operationsAvailable: false,
    productionRuns: [], productionReceipts: [], productionRunAudits: [], productionLedgerAvailable: false,
    supplierProductionOrders: [], supplierOrdersAvailable: false, productionConditions: [], productionConditionsAvailable: false,
    styleImages: [], styleImagesAvailable: false, materialReviewItems: [], materialReviewRounds: [], materialReviewsAvailable: false,
    processingUnitPrices: [], processingPricesAvailable: false, settlementTerms: [], settlementTermsAudits: [], settlementTermsAvailable: false,
    productionDetails: [], refinementsAvailable: false, partialDeliveryPlans: [], partialDeliveryAvailable: false, partialDeliverySizesAvailable: false,
    inspectionAssignments: [], inspectionOrders: [], inspectionAssignmentsAvailable: false,
    supplierWorkRates: [], supplierWorkRateAudits: [], supplierWorkRatesAvailable: false,
    ...unavailable(),
  }
  if (!profile.approved || !profile.active) return base
  return { ...base, ...await loadBudgetWorkspace(client) }
}

export async function saveBudgetRecord<K extends BudgetRecordKind>(kind: K, id: string, data: BudgetDataByKind[K], expectedVersion: number, reason: string, profile: Profile): Promise<void> {
  if (supabase) {
    const result = await supabase.rpc('save_budget_record', { p_kind: kind, p_id: id, p_data: data, p_expected_version: expectedVersion, p_reason: reason })
    if (result.error) {
      if (missing(result.error.code)) throw new Error('예산·을지 저장 기능 설정이 필요합니다. 022·023 SQL을 적용한 뒤 다시 접속해 주세요.')
      throw result.error
    }
    return
  }
  await locked(() => persist(saveBudgetRecordInWorkspace(getDemoWorkspace(), profile, id, kind, data, expectedVersion, reason)))
}
