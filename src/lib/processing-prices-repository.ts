import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from './types'
import { getDemoWorkspace, locked, persist, supabase } from './repository'
import { saveProcessingUnitPriceInWorkspace, validateProcessingUnitCost, type ProcessingPriceKind, type ProcessingUnitPrice } from './processing-prices'

export async function loadProcessingUnitPrices(client: SupabaseClient): Promise<{ processingUnitPrices: ProcessingUnitPrice[]; processingPricesAvailable: boolean }> {
  const capability = await client.rpc('get_processing_prices_capability')
  if (capability.error && ['PGRST202', '42883'].includes(capability.error.code)) return { processingUnitPrices: [], processingPricesAvailable: false }
  if (capability.error) throw capability.error
  if (capability.data !== true) return { processingUnitPrices: [], processingPricesAvailable: false }
  const prices: ProcessingUnitPrice[] = []
  for (let offset = 0; ; offset += 500) {
    const result = await client.from('processing_unit_prices').select('*').order('style_id').order('line_id').order('kind').order('item_key').range(offset, offset + 499)
    if (result.error) throw result.error
    const rows = result.data || []
    prices.push(...rows.map(row => ({ styleId: row.style_id, lineId: row.line_id, kind: row.kind, itemKey: row.item_key, unitCost: row.unit_cost === null ? null : Number(row.unit_cost), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: row.updated_by })))
    if (rows.length < 500) return { processingUnitPrices: prices, processingPricesAvailable: true }
  }
}
export async function saveProcessingUnitPrice(styleId: string, lineId: string, kind: ProcessingPriceKind, itemKey: string, unitCost: number | null, expectedVersion: number, reason: string, profile: Profile): Promise<void> {
  validateProcessingUnitCost(unitCost)
  if (supabase) {
    const result = await supabase.rpc('save_processing_unit_price', { p_style_id: styleId, p_line_id: lineId, p_kind: kind, p_item_key: itemKey, p_unit_cost: unitCost, p_expected_version: expectedVersion, p_reason: reason })
    if (result.error) {
      if (['PGRST202', 'PGRST205', '42P01'].includes(result.error.code)) throw new Error('가공·품질 단가 저장 설정이 아직 완료되지 않았습니다. 관리자에게 문의해 주세요.')
      throw result.error
    }
    return
  }
  await locked(() => persist(saveProcessingUnitPriceInWorkspace(getDemoWorkspace(), profile, styleId, lineId, kind, itemKey, unitCost, expectedVersion, reason)))
}
