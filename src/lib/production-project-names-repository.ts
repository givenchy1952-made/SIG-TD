import type { SupabaseClient } from '@supabase/supabase-js'

export interface ProductionProjectName { projectId: string; name: string; season: string }
export interface ProductionProjectNameFields { productionProjectNames?: ProductionProjectName[] }
const missing = (code?: string) => ['PGRST202', '42883'].includes(code || '')

/** Only a scoped, read-only M/L projection. It never loads HQ source rows or A. */
export async function loadProductionProjectNames(client: SupabaseClient): Promise<ProductionProjectNameFields> {
  const names: ProductionProjectName[] = []
  for (let offset = 0;; offset += 500) {
    const result = await client.rpc('get_production_project_names').range(offset, offset + 499)
    if (result.error && missing(result.error.code)) return { productionProjectNames: [] }
    if (result.error) throw result.error
    const page = (result.data || []) as ProductionProjectName[]
    names.push(...page)
    if (page.length < 500) return { productionProjectNames: names }
  }
}
