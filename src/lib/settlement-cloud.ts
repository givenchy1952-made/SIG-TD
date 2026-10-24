import type { SupabaseClient } from '@supabase/supabase-js'
import type { SettlementTerms, SettlementTermsAudit } from './settlement-types'

const camel = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()), value]))
function term(row: Record<string, unknown>): SettlementTerms {
  const mapped = camel(row)
  return { ...mapped, unitCost: mapped.unitCost == null ? null : Number(mapped.unitCost) } as unknown as SettlementTerms
}
/** Schema 004 has its own availability flag; an old project keeps all 003 features. */
export async function loadSettlementTermsWorkspace(client: SupabaseClient): Promise<{ settlementTerms: SettlementTerms[]; settlementTermsAudits: SettlementTermsAudit[]; settlementTermsAvailable: boolean }> {
  const results = await Promise.all(['settlement_terms', 'settlement_terms_audits'].map(async table => {
    const rows: Record<string, unknown>[] = []
    for (let offset = 0; ; offset += 500) {
      let request = client.from(table).select('*')
      request = table === 'settlement_terms' ? request.order('style_id').order('line_id') : request.order('id')
      const result = await request.range(offset, offset + 499)
      if (result.error && ['PGRST205', '42P01'].includes(result.error.code)) return { rows: [], missing: true }
      if (result.error) throw result.error
      rows.push(...result.data || [])
      if ((result.data || []).length < 500) return { rows, missing: false }
    }
  }))
  if (results.some(result => result.missing)) return { settlementTerms: [], settlementTermsAudits: [], settlementTermsAvailable: false }
  return {
    settlementTerms: results[0].rows.map(term),
    settlementTermsAudits: results[1].rows.map(row => ({ ...camel(row), before: row.before ? term(row.before as Record<string, unknown>) : null, after: term(row.after as Record<string, unknown>) }) as unknown as SettlementTermsAudit),
    settlementTermsAvailable: true,
  }
}
