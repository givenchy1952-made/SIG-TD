import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from './types'
import type { StyleOperationInput, StyleOperationKind } from './operations-types'
import { getDemoWorkspace, locked, persist, supabase } from './repository'
import { applySupplierQualityRateInWorkspace, saveStyleOperationWithSupplierInWorkspace, saveSupplierWorkItemInWorkspace, saveSupplierWorkRateInWorkspace, type SupplierWorkItemInput, type SupplierWorkRate, type SupplierWorkRateAudit, type SupplierWorkRatesFields } from './supplier-work-rates'
import { validateProcessingUnitCost, type ProcessingPriceKind } from './processing-prices'

const missing = (code?: string) => ['PGRST202', 'PGRST205', '42883', '42P01'].includes(code || '')
const rate = (row: Record<string, any>): SupplierWorkRate => ({ factoryId: row.factory_id, kind: row.kind, itemKey: row.item_key, unitCost: row.unit_cost == null ? null : Number(row.unit_cost), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: row.updated_by })
async function rpc(name: string, args: Record<string, unknown>) {
  const result = await supabase!.rpc(name, args)
  if (result.error && missing(result.error.code)) throw new Error('업체별 작업·단가 설정(021)을 적용한 뒤 다시 시도해 주세요. 기존 단가는 유지됩니다.')
  if (result.error) throw result.error
}
export async function loadSupplierWorkRates(client: SupabaseClient): Promise<SupplierWorkRatesFields> {
  const capability = await client.rpc('get_supplier_work_rates_capability')
  if (capability.error && missing(capability.error.code) || !capability.error && capability.data !== true) return { supplierWorkRatesAvailable: false, supplierWorkRates: [], supplierWorkRateAudits: [] }
  if (capability.error) throw capability.error
  const rates: SupplierWorkRate[] = [], audits: SupplierWorkRateAudit[] = []
  for (let offset = 0;; offset += 500) {
    const result = await client.from('supplier_work_rates').select('*').order('factory_id').order('kind').order('item_key').range(offset, offset + 499)
    if (result.error) throw result.error
    const page = result.data || []; rates.push(...page.map(rate))
    if (page.length < 500) break
  }
  // Audits are private to HQ/the owning supplier, never general style histories.
  for (let offset = 0;; offset += 500) {
    const result = await client.from('supplier_work_rate_audits').select('*').order('id').range(offset, offset + 499)
    if (result.error) throw result.error
    const page = result.data || []
    audits.push(...page.map(row => ({ id: row.id, factoryId: row.factory_id, kind: row.kind, itemKey: row.item_key, actorId: row.actor_id, actorName: row.actor_name, reason: row.reason, before: row.before ? rate(row.before) : null, after: rate(row.after), createdAt: row.created_at })))
    if (page.length < 500) break
  }
  return { supplierWorkRatesAvailable: true, supplierWorkRates: rates, supplierWorkRateAudits: audits }
}
export async function saveSupplierWorkItem(id: string, factoryId: string, kind: StyleOperationKind, data: SupplierWorkItemInput, catalogVersion: number, rateVersion: number, reason: string, actor: Profile): Promise<void> {
  validateProcessingUnitCost(data.unitCost)
  if (supabase) { await rpc('save_supplier_work_item', { p_id: id, p_factory_id: factoryId, p_kind: kind, p_name: data.name, p_specification: data.specification, p_active: data.active, p_unit_cost: data.unitCost, p_expected_catalog_version: catalogVersion, p_expected_rate_version: rateVersion, p_reason: reason }); return }
  await locked(() => persist(saveSupplierWorkItemInWorkspace(getDemoWorkspace(), actor, id, factoryId, kind, data, catalogVersion, rateVersion, reason)))
}
export async function saveSupplierWorkRate(factoryId: string, kind: ProcessingPriceKind, itemKey: string, unitCost: number | null, expectedVersion: number, reason: string, actor: Profile): Promise<void> {
  validateProcessingUnitCost(unitCost)
  if (supabase) { await rpc('save_supplier_work_rate', { p_factory_id: factoryId, p_kind: kind, p_item_key: itemKey, p_unit_cost: unitCost, p_expected_version: expectedVersion, p_reason: reason }); return }
  await locked(() => persist(saveSupplierWorkRateInWorkspace(getDemoWorkspace(), actor, factoryId, kind, itemKey, unitCost, expectedVersion, reason)))
}
export async function saveStyleOperationWithSupplier(id: string, styleId: string, kind: StyleOperationKind, factoryId: string | null, expectedVersion: number, data: StyleOperationInput, reason: string, actor: Profile, catalogVersions: Record<string, number> = {}): Promise<void> {
  const clean = { rows: data.rows, note: data.note, voided: data.voided }
  if (supabase) { await rpc('save_style_operation_with_supplier', { p_id: id, p_style_id: styleId, p_kind: kind, p_supplier_factory_id: factoryId, p_expected_version: expectedVersion, p_data: clean, p_reason: reason, p_catalog_versions: catalogVersions }); return }
  await locked(() => persist(saveStyleOperationWithSupplierInWorkspace(getDemoWorkspace(), actor, id, styleId, kind, factoryId, expectedVersion, clean, reason, catalogVersions)))
}
export async function applySupplierQualityRate(styleId: string, lineId: string, factoryId: string, category: string, assignmentVersion: number, priceVersion: number, reason: string, actor: Profile): Promise<void> {
  if (supabase) { await rpc('apply_supplier_quality_rate', { p_style_id: styleId, p_line_id: lineId, p_factory_id: factoryId, p_category: category, p_expected_assignment_version: assignmentVersion, p_expected_price_version: priceVersion, p_reason: reason }); return }
  await locked(() => persist(applySupplierQualityRateInWorkspace(getDemoWorkspace(), actor, styleId, lineId, factoryId, category, assignmentVersion, priceVersion, reason)))
}
