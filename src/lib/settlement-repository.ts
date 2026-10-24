import type { Profile } from './types'
import type { SettlementTermsInput } from './settlement-types'
import { getDemoWorkspace, locked, persist, supabase } from './repository'
import { saveSettlementTermsInWorkspace } from './settlement-domain'

export async function saveSettlementTerms(styleId: string, lineId: string, data: SettlementTermsInput, expectedVersion: number, reason: string, profile: Profile): Promise<void> {
  if (supabase) {
    const result = await supabase.rpc('save_settlement_terms', { p_style_id: styleId, p_line_id: lineId, p_expected_version: expectedVersion, p_data: data, p_reason: reason })
    if (result.error) {
      if (['PGRST202', 'PGRST205', '42P01'].includes(result.error.code)) throw new Error('을지 단가 저장 설정이 필요합니다. Supabase에 004_settlement_terms.sql을 적용한 뒤 다시 접속해 주세요.')
      throw result.error
    }
    return
  }
  await locked(() => persist(saveSettlementTermsInWorkspace(getDemoWorkspace(), profile, styleId, lineId, data, expectedVersion, reason)))
}
