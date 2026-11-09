import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile, Style } from './types'
import type { ConfirmMainProductionReceiptRequest, ConfirmMainProductionReceiptResult, ProductionMovementFields } from './production-movements-types'
import { confirmMainProductionReceiptInWorkspace, saveMainProductionStyleInWorkspace } from './production-movements'
import { cloudStyle, getDemoWorkspace, locked, persist, supabase } from './repository'
import { validateRunQuantities } from './production-ledger'

const missing = (code: string) => ['PGRST202', 'PGRST205', '42P01', '42883'].includes(code)
const unavailable = (): ProductionMovementFields => ({ mainProductionSyncAvailable: false, shipmentAdjustments: [] })
function failure(error: { code?: string; message?: string }): never {
  if (missing(error.code || '')) throw new Error('메인 생산 출입고 연동 설정이 필요합니다. 026_main_production_sync.sql을 적용한 뒤 다시 접속해 주세요.')
  throw error
}
function savedStyle(row: unknown): Style {
  if (!row || typeof row !== 'object' || !('data' in row) || !row.data || typeof row.data !== 'object' || !('production' in row.data) || !Array.isArray(row.data.production) || !('id' in row) || !Number.isSafeInteger(Number((row as { version?: unknown }).version)) || Number((row as { version?: unknown }).version) < 1) throw new Error('저장 결과를 확인하지 못했습니다. 최신 내용을 다시 불러와 주세요.')
  return cloudStyle(row as Record<string, unknown>)
}

/** A single projection avoids the REST default row cap; the database enforces
 * each style's existing production access and excludes financial retry logs. */
export async function loadMainProductionSync(client: SupabaseClient): Promise<ProductionMovementFields> {
  const capability = await client.rpc('get_main_production_sync_capability')
  if (capability.error && missing(capability.error.code)) return unavailable()
  if (capability.error) throw capability.error
  if (capability.data !== true) return unavailable()
  const result = await client.rpc('get_main_production_sync')
  if (result.error && missing(result.error.code)) return unavailable()
  if (result.error) throw result.error
  if (!result.data || !Array.isArray(result.data.shipmentAdjustments)) throw new Error('출고 수량 연결 정보를 확인하지 못했습니다. 다시 불러와 주세요.')
  return { mainProductionSyncAvailable: true, shipmentAdjustments: result.data.shipmentAdjustments }
}
export async function saveMainProductionStyle(style: Style, reason: string, profile: Profile): Promise<Style> {
  if (supabase) {
    const result = await supabase.rpc('save_main_production_style', { p_id: style.id, p_data: style, p_expected_version: style.version, p_reason: reason })
    if (result.error) failure(result.error)
    return savedStyle(result.data)
  }
  return locked(() => {
    const next = saveMainProductionStyleInWorkspace(getDemoWorkspace(), profile, style, reason)
    persist(next)
    return structuredClone(next.styles.find(item => item.id === style.id)!)
  })
}
export async function confirmMainProductionReceipt(request: ConfirmMainProductionReceiptRequest, reason: string, profile: Profile): Promise<ConfirmMainProductionReceiptResult> {
  if (supabase) {
    const result = await supabase.rpc('confirm_main_production_receipt', { p_request: request, p_reason: reason })
    if (result.error) failure(result.error)
    const value = result.data
    if (!value || !Number.isSafeInteger(value.runVersion) || value.runVersion < 1 || value.receiptId !== null && typeof value.receiptId !== 'string' || !value.added) throw new Error('입고 확정 결과를 확인하지 못했습니다. 최신 입고 내역을 다시 불러와 주세요.')
    validateRunQuantities(value.added)
    return { style: savedStyle(value.style), receiptId: value.receiptId, added: value.added, runVersion: value.runVersion }
  }
  return locked(() => {
    const applied = confirmMainProductionReceiptInWorkspace(getDemoWorkspace(), profile, request, reason)
    persist(applied.workspace)
    return applied.result
  })
}
