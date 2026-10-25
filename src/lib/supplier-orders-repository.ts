import type { SupabaseClient } from '@supabase/supabase-js'
import type { PoDispatchInput } from './operations-types'
import type { Profile } from './types'
import { getDemoWorkspace, locked, persist, supabase } from './repository'
import { createProductionOrderPoInWorkspace, acceptSupplierOrderInWorkspace, startSupplierOrderInWorkspace, type SupplierOrder, type SupplierOrderFields } from './supplier-orders'

const missing = (code?: string) => ['PGRST202', 'PGRST205', '42883', '42P01'].includes(code || '')
export async function loadSupplierProductionOrders(client: SupabaseClient): Promise<SupplierOrderFields> {
  const capability = await client.rpc('get_supplier_orders_capability')
  if (capability.error) {
    if (missing(capability.error.code)) return { supplierOrdersAvailable: false, supplierProductionOrders: [] }
    throw capability.error
  }
  if (capability.data !== true) return { supplierOrdersAvailable: true, supplierProductionOrders: [] }
  const orders: SupplierOrder[] = []
  for (let offset = 0; ; offset += 500) {
    const response = await client.rpc('get_supplier_production_orders').range(offset, offset + 499)
    if (response.error) throw response.error
    const page = (response.data || []) as SupplierOrder[]
    orders.push(...page)
    if (page.length < 500) break
  }
  return { supplierOrdersAvailable: true, supplierProductionOrders: orders }
}
async function rpc(name: string, args: Record<string, unknown>) {
  const result = await supabase!.rpc(name, args)
  if (result.error) {
    if (missing(result.error.code)) throw new Error('업체 생산 동의 설정이 필요합니다. 008_supplier_acceptance.sql을 적용해 주세요.')
    throw result.error
  }
  return result.data
}
export async function acceptSupplierProductionOrder(runId: string, runVersion: number, poVersion: number, date: string, agreed: boolean, profile: Profile): Promise<void> {
  if (supabase) { await rpc('accept_supplier_production_order', { p_run_id: runId, p_expected_run_version: runVersion, p_expected_po_version: poVersion, p_expected_delivery_date: date, p_agreed: agreed }); return }
  await locked(() => persist(acceptSupplierOrderInWorkspace(getDemoWorkspace(), profile, runId, runVersion, poVersion, date, agreed)))
}
export async function startProductionRun(runId: string, runVersion: number, profile: Profile): Promise<void> {
  if (supabase) { await rpc('start_supplier_production_run', { p_run_id: runId, p_expected_run_version: runVersion }); return }
  await locked(() => persist(startSupplierOrderInWorkspace(getDemoWorkspace(), profile, runId, runVersion)))
}

export async function createProductionOrderPo(runId: string, runVersion: number, poId: string, data: PoDispatchInput, reason: string, profile: Profile): Promise<void> {
  if (supabase) { await rpc('create_production_order_po', { p_run_id: runId, p_expected_run_version: runVersion, p_po_id: poId, p_data: data, p_reason: reason }); return }
  await locked(() => persist(createProductionOrderPoInWorkspace(getDemoWorkspace(), profile, runId, runVersion, poId, data, reason)))
}
