import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile } from './types'
import { getDemoWorkspace, locked, persist, supabase } from './repository'
import { withdrawMemberInWorkspace } from './member-withdrawal'

const missing = (code?: string) => ['PGRST202', 'PGRST205', '42883', '42P01'].includes(code || '')
export async function loadMemberWithdrawalCapability(client: SupabaseClient): Promise<boolean> {
  const result = await client.rpc('get_member_withdrawal_capability')
  if (result.error) {
    if (missing(result.error.code)) return false
    throw result.error
  }
  return result.data === true
}
export async function withdrawMember(targetId: string, reason: string, profile: Profile): Promise<void> {
  if (supabase) {
    const result = await supabase.rpc('withdraw_workspace_member', { p_id: targetId, p_reason: reason.trim() })
    if (result.error) {
      if (missing(result.error.code)) throw new Error('구성원 탈퇴 설정이 필요합니다. 010_member_withdrawal.sql을 적용한 뒤 다시 접속해 주세요.')
      throw result.error
    }
    return
  }
  await locked(() => persist(withdrawMemberInWorkspace(getDemoWorkspace(), profile, targetId, reason)))
}
