import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from './types'
import type { ProductionLedgerFields, ProductionReceipt, ProductionReceiptInput, ProductionRun, ProductionRunAudit, ProductionRunInput } from './production-ledger'
import { allocateProductionReceiptInWorkspace, finalizeProductionRunInWorkspace, saveProductionRunInWorkspace, voidProductionReceiptInWorkspace } from './production-ledger'
import { getDemoWorkspace, locked, persist, supabase } from './repository'

const missing = (code: string) => ['PGRST202', 'PGRST205', '42P01', '42883'].includes(code)
const camel = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key === 'order_quantities' ? 'order' : key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()), value]))
function run(row: Record<string, unknown>): ProductionRun {
  const mapped = camel(row)
  return { ...mapped, expectedDue: mapped.expectedDue || '', unitCost: mapped.unitCost === null ? null : Number(mapped.unitCost) } as unknown as ProductionRun
}
function receipt(row: Record<string, unknown>): ProductionReceipt {
  const mapped = camel(row)
  return { ...mapped, unitCost: Number(mapped.unitCost), netAmount: Number(mapped.netAmount) } as unknown as ProductionReceipt
}
function auditPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const row = value as Record<string, unknown>
  return 'order_quantities' in row ? run(row) : 'quantities' in row && 'run_id' in row ? receipt(row) : camel(row)
}
export async function loadProductionLedgerWorkspace(client: SupabaseClient): Promise<ProductionLedgerFields> {
  const empty: ProductionLedgerFields = { productionRuns: [], productionReceipts: [], productionRunAudits: [], productionLedgerAvailable: false }
  const capability = await client.rpc('get_production_ledger_capability')
  if (capability.error && missing(capability.error.code)) return empty
  if (capability.error) throw capability.error
  if (capability.data !== true) return empty
  const tables = ['production_runs', 'production_receipts', 'production_run_audits']
  const results = await Promise.all(tables.map(async table => {
    const rows: Record<string, unknown>[] = []
    for (let offset = 0; ; offset += 500) {
      const result = await client.from(table).select('*').order('id').range(offset, offset + 499)
      if (result.error && missing(result.error.code)) return null
      if (result.error) throw result.error
      rows.push(...result.data || [])
      if ((result.data || []).length < 500) return rows
    }
  }))
  if (results.some(result => result === null)) return empty
  return {
    productionRuns: results[0]!.map(run), productionReceipts: results[1]!.map(receipt), productionLedgerAvailable: true,
    productionRunAudits: results[2]!.map(row => ({ ...camel(row), before: auditPayload(row.before), after: auditPayload(row.after) }) as unknown as ProductionRunAudit),
  }
}
async function rpc(name: string, args: Record<string, unknown>): Promise<void> {
  const result = await supabase!.rpc(name, args)
  if (result.error) {
    if (missing(result.error.code)) throw new Error('생산 차수·마감 설정이 필요합니다. Supabase에 007_production_ledger.sql을 적용한 뒤 다시 접속해 주세요.')
    throw result.error
  }
}
export async function saveProductionRun(id: string, styleId: string, lineId: string, data: ProductionRunInput, expectedVersion: number, reason: string, profile: Profile): Promise<void> {
  if (supabase) return rpc('save_production_run', { p_id: id, p_style_id: styleId, p_line_id: lineId, p_data: data, p_expected_version: expectedVersion, p_reason: reason })
  await locked(() => persist(saveProductionRunInWorkspace(getDemoWorkspace(), profile, id, styleId, lineId, data, expectedVersion, reason)))
}
export async function allocateProductionReceipt(id: string, runId: string, data: ProductionReceiptInput, expectedRunVersion: number, reason: string, profile: Profile): Promise<void> {
  if (supabase) return rpc('allocate_production_receipt', { p_id: id, p_run_id: runId, p_data: data, p_expected_run_version: expectedRunVersion, p_reason: reason })
  await locked(() => persist(allocateProductionReceiptInWorkspace(getDemoWorkspace(), profile, id, runId, data, expectedRunVersion, reason)))
}
export async function voidProductionReceipt(id: string, runId: string, expectedReceiptVersion: number, expectedRunVersion: number, reason: string, profile: Profile): Promise<void> {
  if (supabase) return rpc('void_production_receipt', { p_id: id, p_run_id: runId, p_expected_receipt_version: expectedReceiptVersion, p_expected_run_version: expectedRunVersion, p_reason: reason })
  await locked(() => persist(voidProductionReceiptInWorkspace(getDemoWorkspace(), profile, id, runId, expectedReceiptVersion, expectedRunVersion, reason)))
}
export async function finalizeProductionRun(runId: string, expectedVersion: number, reason: string, profile: Profile): Promise<void> {
  if (supabase) return rpc('finalize_production_run', { p_run_id: runId, p_expected_version: expectedVersion, p_reason: reason })
  await locked(() => persist(finalizeProductionRunInWorkspace(getDemoWorkspace(), profile, runId, expectedVersion, reason)))
}
