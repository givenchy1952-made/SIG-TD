import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationsWorkspace } from './operations-types'
import { freshOperations } from './operations-domain'

const TABLES = [
  ['po_dispatches', 'poDispatches', ['id']], ['po_dispatch_attempts', 'poDispatchAttempts', ['id']],
  ['shipment_ledgers', 'shipmentLedgers', ['style_id', 'line_id']], ['shipment_batches', 'shipmentBatches', ['id']],
  ['style_operations', 'styleOperations', ['id']], ['calendar_events', 'calendarEvents', ['id']],
  ['calendar_event_audits', 'calendarEventAudits', ['id']], ['employee_factory_assignments', 'employeeFactoryAssignments', ['employee_id']],
  ['operation_catalogs', 'operationCatalogs', ['id']], ['order_source_records', 'orderSourceRecords', ['style_id', 'line_id']],
] as const
function camelRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key === 'rows_data' ? 'rows' : key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()), value]))
}
/** Only missing incremental schema degrades gracefully. Permission/network errors remain visible. */
export async function loadOperationsWorkspace(client: SupabaseClient): Promise<{ operations: OperationsWorkspace; operationsAvailable: boolean }> {
  const results = await Promise.all(TABLES.map(async ([table, key, orders]) => {
    const rows: Record<string, unknown>[] = []
    for (let from = 0; ; from += 500) {
      let query = client.from(table).select('*')
      for (const column of orders) query = query.order(column)
      const result = await query.range(from, from + 499)
      if (result.error && ['PGRST205', '42P01'].includes(result.error.code)) return { key, missing: true, rows: [] }
      if (result.error) throw result.error
      const page = result.data || []
      rows.push(...page.map(row => { const mapped = camelRow(row); if ('sentAt' in mapped) mapped.sentAt ??= ''; if ('baselineDate' in mapped) mapped.baselineDate ??= ''; if ('updatedBy' in mapped) mapped.updatedBy ??= ''; return mapped }))
      if (page.length < 500) return { key, missing: false, rows }
    }
  }))
  if (results.some(result => result.missing)) return { operations: freshOperations(), operationsAvailable: false }
  return { operations: Object.fromEntries(results.map(result => [result.key, result.rows])) as unknown as OperationsWorkspace, operationsAvailable: true }
}
