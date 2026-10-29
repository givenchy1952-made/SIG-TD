import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from './types'
import { getDemoWorkspace, locked, persist, supabase } from './repository'
import { linkProductionPoInWorkspace, type ProductionPoContext, type ProductionPoLinkConfirmation, type ProductionPoLinkFields } from './production-po-links'

const missing = (code?: string) => ['PGRST202', 'PGRST205', '42P01', '42883'].includes(code || '')
export async function loadProductionPoLinks(client: SupabaseClient): Promise<ProductionPoLinkFields> {
  const capability = await client.rpc('get_production_po_links_capability')
  if (capability.error && missing(capability.error.code) || !capability.error && capability.data !== true) return { productionPoContexts: [], productionPoLinksAvailable: false }
  if (capability.error) throw capability.error
  const contexts: ProductionPoContext[] = []
  for (let offset = 0; ; offset += 500) {
    const result = await client.from('po_production_contexts').select('*').order('po_id').range(offset, offset + 499)
    if (result.error) throw result.error
    const page = result.data || []
    contexts.push(...page.map(item => ({ poId: item.po_id, source: item.source, snapshot: item.snapshot, capturedAt: item.captured_at })))
    if (page.length < 500) break
  }
  return { productionPoContexts: contexts, productionPoLinksAvailable: true }
}
export async function linkProductionPo(runId: string, poId: string, runVersion: number, poVersion: number, confirmation: ProductionPoLinkConfirmation, reason: string, profile: Profile): Promise<void> {
  if (supabase) {
    const result = await supabase.rpc('link_production_po', { p_run_id: runId, p_po_id: poId, p_expected_run_version: runVersion, p_expected_po_version: poVersion, p_data: confirmation, p_reason: reason })
    if (result.error) throw result.error
    return
  }
  await locked(() => persist(linkProductionPoInWorkspace(getDemoWorkspace(), profile, runId, poId, runVersion, poVersion, confirmation, reason)))
}
