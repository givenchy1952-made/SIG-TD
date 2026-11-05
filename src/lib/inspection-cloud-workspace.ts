import type { SupabaseClient } from '@supabase/supabase-js'
import type { Factory, Profile, Workspace } from './types'
import { loadInspectionAssignments } from './inspection-assignments-repository'
import { loadSupplierWorkRates } from './supplier-work-rates-repository'
import { inspectionOnlyWorkspace } from './inspection-workspace'

/** Discover the canonical account service before querying any order tables.
 * The session ID is only a lookup key; table RLS and both RPCs authorize it. */
export async function loadInspectionOnlyWorkspace(client: SupabaseClient): Promise<Workspace | null> {
  const session = await client.auth.getSession()
  if (session.error) throw session.error
  const id = session.data.session?.user.id
  if (!id) return null
  const own = await client.from('profiles').select('*').eq('id', id).maybeSingle()
  if (own.error) throw own.error
  if (!own.data || own.data.role !== 'factory') return null
  const profile: Profile = { id: own.data.id, name: own.data.name, email: own.data.email, role: 'factory', approved: !!own.data.approved, active: !!own.data.active, factoryId: own.data.factory_id || null,
    ...('withdrawn_at' in own.data ? { withdrawnAt: own.data.withdrawn_at, withdrawnBy: own.data.withdrawn_by } : {}) }
  const base: Workspace = { profiles: [profile], factories: [], styles: [], projects: [], comments: [], attachments: [], audits: [] }
  // Inactive/unapproved accounts cannot read their vendor row under RLS.
  // Stop before that lookup rather than mistaking its absence for production.
  if (!profile.approved || !profile.active || !profile.factoryId) return inspectionOnlyWorkspace(base, profile)
  const result = await client.from('factories').select('*').eq('id', own.data.factory_id).maybeSingle()
  if (result.error) throw result.error
  const row = result.data
  // An absent canonical vendor does not prove production access. It may be
  // a classification/approval change between the two authorized reads.
  if (!row) return inspectionOnlyWorkspace(base, profile)
  if (row.service_type !== 'inspection') return null
  const factory: Factory = { id: row.id, name: row.name, country: row.country, active: row.active !== false, serviceType: 'inspection', inspectionProvider: ['able', 'kotiti'].includes(row.inspection_provider) ? row.inspection_provider : null, serviceSettingsVersion: row.service_settings_version || 0 }
  base.factories = [factory]
  if (factory.active === false) return inspectionOnlyWorkspace(base, profile)
  const [inspection, rates] = await Promise.all([loadInspectionAssignments(client), loadSupplierWorkRates(client)])
  return inspectionOnlyWorkspace({ ...base, ...inspection, ...rates }, profile)
}
