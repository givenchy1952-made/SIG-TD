import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from './types'
import type { PartialDeliveryFields, PartialDeliveryInstallment, PartialDeliveryPlan } from './partial-deliveries'
import { savePartialDeliveryInWorkspace } from './partial-deliveries'
import { getDemoWorkspace, locked, persist, supabase } from './repository'

const missing = (code?: string) => ['PGRST202', 'PGRST205', '42883', '42P01'].includes(code || '')
export async function loadPartialDeliveryPlans(client: SupabaseClient): Promise<PartialDeliveryFields> {
  const probe = await client.rpc('get_partial_delivery_plan_capability')
  if (probe.error && missing(probe.error.code)) return { partialDeliveryAvailable: false, partialDeliveryPlans: [] }
  if (probe.error) throw probe.error
  const items: PartialDeliveryPlan[] = []
  for (let from = 0;; from += 500) {
    const result = await client.rpc('get_partial_delivery_plans').range(from, from + 499)
    if (result.error) throw result.error
    const page = (result.data || []) as PartialDeliveryPlan[]
    items.push(...page)
    if (page.length < 500) break
  }
  return { partialDeliveryAvailable: probe.data === true, partialDeliveryPlans: items }
}
export async function savePartialDeliveryPlan(runId: string, version: number, items: PartialDeliveryInstallment[], reason: string, actor: Profile): Promise<void> {
  if (supabase) {
    const result = await supabase.rpc('save_partial_delivery_plan', { p_run_id: runId, p_expected_version: version, p_items: items, p_reason: reason })
    if (result.error) throw result.error
    return
  }
  await locked(() => persist(savePartialDeliveryInWorkspace(getDemoWorkspace(), actor, runId, version, items, reason)))
}
