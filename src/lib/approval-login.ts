import type { SupabaseClient } from '@supabase/supabase-js'

export const APPROVAL_PENDING_MESSAGE = '본사 관리자 또는 본사 직원의 승인·공장 배정이 완료되지 않았습니다. 승인 완료 후 로그인해 주세요.'

let pendingFlows = 0
const flowListeners = new Set<() => void>()
export function isApprovalAuthFlowPending(): boolean { return pendingFlows > 0 }
export function subscribeApprovalAuthFlow(listener: () => void): () => void { flowListeners.add(listener); return () => { flowListeners.delete(listener) } }
async function approvalFlow<T>(action: () => Promise<T>): Promise<T> {
  pendingFlows += 1
  for (const listener of flowListeners) listener()
  try { return await action() }
  finally { pendingFlows -= 1; for (const listener of flowListeners) listener() }
}

/** This is the app's admission check, not a replacement for database RLS. */
export function assertApprovedLogin(profile: unknown, userId: string): void {
  if (!profile || typeof profile !== 'object') throw new Error('가입 정보를 확인하지 못했습니다. 본사 담당자에게 문의해 주세요.')
  const row = profile as Record<string, unknown>
  if (row.id !== userId || !['admin', 'internal', 'factory'].includes(String(row.role))) throw new Error('계정 정보를 확인하지 못했습니다. 본사 담당자에게 문의해 주세요.')
  if (row.active !== true) throw new Error('사용 중지된 계정입니다. 본사 관리자에게 문의해 주세요.')
  if (row.approved !== true) throw new Error(APPROVAL_PENDING_MESSAGE)
  if (row.role === 'factory' && (typeof row.factory_id !== 'string' || !row.factory_id.trim())) throw new Error('담당 공장이 배정되지 않았습니다. 본사 관리자 또는 본사 직원에게 공장 배정을 요청해 주세요.')
}

async function discardLocalSession(client: SupabaseClient): Promise<void> {
  const { error } = await client.auth.signOut({ scope: 'local' })
  if (error) throw new Error('로그인을 완료하지 않았지만 접속 종료 처리에 실패했습니다. 다시 시도하거나 본사 담당자에게 문의해 주세요.')
}

export async function signInAfterApproval(client: SupabaseClient, email: string, password: string): Promise<void> {
  return approvalFlow(async () => {
    const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password })
    if (error) throw error
    try {
      if (!data.user || !data.session) throw new Error('로그인을 완료하지 못했습니다. 다시 로그인해 주세요.')
      const result = await client.from('profiles').select('id,role,approved,active,factory_id').eq('id', data.user.id).single()
      if (result.error) throw new Error('가입 승인 정보를 확인하지 못했습니다. 다시 시도하거나 본사 담당자에게 문의해 주세요.')
      assertApprovedLogin(result.data, data.user.id)
    } catch (failure) {
      await discardLocalSession(client)
      throw failure
    }
  })
}

export async function signupForApproval(client: SupabaseClient, email: string, password: string, name: string): Promise<{ message: string; requiresProviderSetting: boolean }> {
  return approvalFlow(async () => {
    const { data, error } = await client.auth.signUp({ email: email.trim(), password, options: { data: { name: name.trim() } } })
    if (error) throw error
    // With Confirm email disabled Supabase signs in a new user automatically.
    // Keep signup as an approval request; the user must log in after approval.
    if (data.session) await discardLocalSession(client)
    const requiresProviderSetting = !data.session
    return {
      requiresProviderSetting,
      message: requiresProviderSetting
        ? '가입 요청을 접수했습니다. 본사 담당자가 승인·공장 배정과 가입 설정을 확인해야 합니다. 로그인할 때 메일 인증을 요구하면 담당자에게 문의해 주세요.'
        : '가입 요청을 접수했습니다. 본사 관리자 또는 본사 직원이 승인·공장 배정을 완료한 뒤 로그인해 주세요.',
    }
  })
}
