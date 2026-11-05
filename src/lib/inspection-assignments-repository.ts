import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from './types'
import { getDemoWorkspace, locked, persist, supabase } from './repository'
import { saveFactoryServiceSettingsInWorkspace, saveInspectionAssignmentInWorkspace, type FactoryServiceSettingsInput, type InspectionAssignment, type InspectionAssignmentFields, type InspectionOrder, type InspectionProvider } from './inspection-assignments'

const missing = (code?: string) => ['PGRST202', 'PGRST205', '42P01', '42883'].includes(code || '')
export async function loadInspectionAssignments(client: SupabaseClient): Promise<InspectionAssignmentFields> {
  const probe = await client.rpc('get_inspection_assignments_capability')
  if (probe.error && missing(probe.error.code) || !probe.error && probe.data !== true) return { inspectionAssignmentsAvailable: false, inspectionAssignments: [], inspectionOrders: [] }
  if (probe.error) throw probe.error
  const assignments: InspectionAssignment[] = [], orders: InspectionOrder[] = []
  for (let offset = 0;; offset += 500) {
    const result = await client.from('inspection_assignments').select('*').order('style_id').order('line_id').range(offset, offset + 499)
    if (result.error) throw result.error
    const page = result.data || []
    assignments.push(...page.map(row => ({ styleId: row.style_id, lineId: row.line_id, provider: row.provider, version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by })))
    if (page.length < 500) break
  }
  for (let offset = 0;; offset += 500) {
    const result = await client.rpc('get_inspection_orders').range(offset, offset + 499)
    if (result.error) throw result.error
    const page = (result.data || []) as InspectionOrder[]
    orders.push(...page)
    if (page.length < 500) break
  }
  return { inspectionAssignmentsAvailable: true, inspectionAssignments: assignments, inspectionOrders: orders }
}
export async function saveInspectionAssignment(styleId: string, lineId: string, provider: InspectionProvider | null, expectedVersion: number, reason: string, actor: Profile): Promise<void> {
  if (supabase) { const result = await supabase.rpc('save_inspection_assignment', { p_style_id: styleId, p_line_id: lineId, p_provider: provider, p_expected_version: expectedVersion, p_reason: reason }); if (result.error) throw result.error; return }
  await locked(() => persist(saveInspectionAssignmentInWorkspace(getDemoWorkspace(), actor, styleId, lineId, provider, expectedVersion, reason)))
}
export async function saveFactoryServiceSettings(id: string, data: FactoryServiceSettingsInput, expectedVersion: number, reason: string, actor: Profile): Promise<void> {
  if (supabase) { const result = await supabase.rpc('save_factory_service_settings', { p_id: id, p_service_type: data.serviceType, p_inspection_provider: data.inspectionProvider, p_expected_version: expectedVersion, p_reason: reason }); if (result.error) throw result.error; return }
  await locked(() => persist(saveFactoryServiceSettingsInWorkspace(getDemoWorkspace(), actor, id, data, expectedVersion, reason)))
}
