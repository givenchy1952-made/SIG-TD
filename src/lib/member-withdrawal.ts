import type { Profile, Workspace } from './types'

/** The actor comes from current workspace state, not a stale UI role. */
export function withdrawMemberInWorkspace(workspace: Workspace, supplied: Profile, targetId: string, reason: string): Workspace {
  const actor = workspace.profiles.find(item => item.id === supplied.id)
  if (!actor?.active || !actor.approved || actor.role !== 'admin') throw new Error('승인된 관리자만 구성원을 탈퇴 처리할 수 있습니다.')
  if (actor.id === targetId) throw new Error('현재 로그인한 관리자 본인은 탈퇴 처리할 수 없습니다.')
  if (typeof reason !== 'string' || reason.trim().length < 2 || reason.length > 1000) throw new Error('탈퇴 사유를 2~1,000자로 입력해 주세요.')
  const before = workspace.profiles.find(item => item.id === targetId)
  if (!before) throw new Error('탈퇴 처리할 구성원을 찾을 수 없습니다. 최신 목록을 확인해 주세요.')
  if (before.withdrawnAt) throw new Error('이미 탈퇴 처리한 구성원입니다.')
  const now = new Date().toISOString(), after: Profile = { ...before, approved: false, active: false, withdrawnAt: now, withdrawnBy: actor.id }
  const next = structuredClone(workspace)
  next.profiles = next.profiles.map(item => item.id === targetId ? after : item)
  next.audits.unshift({ id: crypto.randomUUID(), styleId: null, actorId: actor.id, actorName: actor.name, action: '구성원 탈퇴', reason: reason.trim(), before: structuredClone(before), after: structuredClone(after), createdAt: now })
  return next
}
