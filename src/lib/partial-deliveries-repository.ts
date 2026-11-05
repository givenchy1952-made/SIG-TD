import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from './types'
import type { PartialDeliveryFields, PartialDeliveryInstallment, PartialDeliveryPlan } from './partial-deliveries'
import { savePartialDeliveryInWorkspace } from './partial-deliveries'
import { getDemoWorkspace, locked, persist, supabase } from './repository'

const missing = (code?: string) => ['PGRST202', 'PGRST205', '42883', '42P01'].includes(code || '')
export async function loadPartialDeliveryPlans(client: SupabaseClient): Promise<PartialDeliveryFields> {
  const probe = await client.rpc('get_partial_delivery_plan_capability')
  if (probe.error && missing(probe.error.code)) return { partialDeliveryAvailable: false, partialDeliverySizesAvailable: false, partialDeliveryPlans: [] }
  if (probe.error) throw probe.error
  if (probe.data !== true) return { partialDeliveryAvailable: false, partialDeliverySizesAvailable: false, partialDeliveryPlans: [] }
  const sizeProbe = await client.rpc('get_partial_delivery_sizes_capability')
  if (sizeProbe.error && !missing(sizeProbe.error.code)) throw sizeProbe.error
  const items: PartialDeliveryPlan[] = []
  for (let from = 0;; from += 500) {
    const result = await client.rpc('get_partial_delivery_plans').range(from, from + 499)
    if (result.error) throw result.error
    const page = (result.data || []) as PartialDeliveryPlan[]
    items.push(...page)
    if (page.length < 500) break
  }
  return { partialDeliveryAvailable: true, partialDeliverySizesAvailable: !sizeProbe.error && sizeProbe.data === true, partialDeliveryPlans: items }
}
export async function savePartialDeliveryPlan(runId: string, version: number, items: PartialDeliveryInstallment[], reason: string, actor: Profile): Promise<void> {
  if (supabase) {
    if (items.some(item => Object.hasOwn(item, 'quantities'))) {
      const capability = await supabase.rpc('get_partial_delivery_sizes_capability')
      if (capability.error && !missing(capability.error.code)) throw capability.error
      if (capability.error || capability.data !== true) throw new Error('사이즈별 부분 납기 저장은 018_partial_delivery_sizes.sql 적용 후 사용할 수 있습니다. 기존 계획은 그대로 유지됩니다.')
    }
    const result = await supabase.rpc('save_partial_delivery_plan', { p_run_id: runId, p_expected_version: version, p_items: items, p_reason: reason })
    if (result.error) throw result.error
    return
  }
  await locked(() => persist(savePartialDeliveryInWorkspace(getDemoWorkspace(), actor, runId, version, items, reason)))
}
