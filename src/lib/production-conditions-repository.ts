import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from './types'
import { getDemoWorkspace, locked, persist, supabase } from './repository'
import { configureProductionConditionsInWorkspace, linkProductionConditionChangeInWorkspace, requestProductionConditionChangeInWorkspace, reviewProductionConditionsInWorkspace, submitProductionConditionsInWorkspace, type ProductionCondition, type ProductionConditionDecision, type ProductionConditionsFields, type ProductionConditionsInput, type ProductionMode } from './production-conditions'

const missing = (code?: string) => ['PGRST202', 'PGRST205', '42883', '42P01'].includes(code || '')
export async function loadProductionConditions(client: SupabaseClient): Promise<ProductionConditionsFields> {
  const empty = { productionConditionsAvailable: false, productionConditions: [] }
  const capability = await client.rpc('get_production_conditions_capability')
  if (capability.error && missing(capability.error.code)) return empty
  if (capability.error) throw capability.error
  if (capability.data !== true) return empty
  const conditions: ProductionCondition[] = []
  for (let offset = 0; ; offset += 500) {
    const result = await client.rpc('get_production_conditions').range(offset, offset + 499)
    if (result.error) throw result.error
    const page = (result.data || []) as ProductionCondition[]
    conditions.push(...page)
    if (page.length < 500) return { productionConditionsAvailable: true, productionConditions: conditions }
  }
}
async function rpc(name: string, values: Record<string, unknown>): Promise<void> {
  const result = await supabase!.rpc(name, values)
  if (result.error) {
    if (missing(result.error.code)) throw new Error('생산 조건 협의·승인 설정이 아직 완료되지 않았습니다. 관리자에게 문의해 주세요.')
    throw result.error
  }
}
export async function configureProductionConditions(runId: string, runVersion: number, version: number, mode: ProductionMode, internalUnitCost: number | null, reason: string, profile: Profile): Promise<void> {
  if (supabase) return rpc('configure_production_conditions', { p_run_id: runId, p_expected_run_version: runVersion, p_expected_version: version, p_production_mode: mode, p_internal_unit_cost: internalUnitCost, p_reason: reason })
  await locked(() => persist(configureProductionConditionsInWorkspace(getDemoWorkspace(), profile, runId, runVersion, version, mode, internalUnitCost, reason)))
}
export async function submitProductionConditions(runId: string, runVersion: number, poVersion: number, version: number, data: ProductionConditionsInput, profile: Profile): Promise<void> {
  if (supabase) return rpc('submit_production_conditions', { p_run_id: runId, p_expected_run_version: runVersion, p_expected_po_version: poVersion, p_expected_version: version, p_data: data })
  await locked(() => persist(submitProductionConditionsInWorkspace(getDemoWorkspace(), profile, runId, runVersion, poVersion, version, data)))
}
export async function reviewProductionConditions(runId: string, runVersion: number, version: number, decision: ProductionConditionDecision, finalDeliveryDate: string, finalUnitCost: number | null, reason: string, profile: Profile): Promise<void> {
  if (supabase) return rpc('review_production_conditions', { p_run_id: runId, p_expected_run_version: runVersion, p_expected_version: version, p_decision: decision, p_final_delivery_date: finalDeliveryDate, p_final_unit_cost: finalUnitCost, p_reason: reason })
  await locked(() => persist(reviewProductionConditionsInWorkspace(getDemoWorkspace(), profile, runId, runVersion, version, decision, finalDeliveryDate, finalUnitCost, reason)))
}
export async function requestProductionConditionChange(runId: string, runVersion: number, version: number, reason: string, profile: Profile): Promise<void> {
  if (supabase) return rpc('request_production_condition_change', { p_run_id: runId, p_expected_run_version: runVersion, p_expected_version: version, p_reason: reason })
  await locked(() => persist(requestProductionConditionChangeInWorkspace(getDemoWorkspace(), profile, runId, runVersion, version, reason)))
}
export async function linkProductionConditionChange(requestId: string, replacementRunId: string, replacementRunVersion: number, reason: string, confirmedNewScope: boolean, profile: Profile): Promise<void> {
  if (supabase) return rpc('link_production_condition_change', { p_request_id: requestId, p_replacement_run_id: replacementRunId, p_expected_replacement_run_version: replacementRunVersion, p_reason: reason, p_confirmed_new_scope: confirmedNewScope })
  await locked(() => persist(linkProductionConditionChangeInWorkspace(getDemoWorkspace(), profile, requestId, replacementRunId, replacementRunVersion, reason, confirmedNewScope)))
}
