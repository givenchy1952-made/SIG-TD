import type { Profile, Workspace } from './types'
import { assertActive } from './permissions'

/** Match SQL 006 using the current actor, never a stale caller's role. */
export function manageProfileInWorkspace(workspace: Workspace, supplied: Profile, target: Profile): Workspace {
  const actor = workspace.profiles.find(row => row.id === supplied.id)
  if (!actor) throw new Error('로그인 계정을 확인해 주세요.')
  assertActive(actor)
  if (actor.role === 'factory') throw new Error('본사 관리자 또는 본사 직원만 승인할 수 있습니다.')
  const before = workspace.profiles.find(row => row.id === target.id)
  if (!before) throw new Error('먼저 회원가입한 계정만 승인할 수 있습니다.')
  if (!target.name.trim() || target.name.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(target.name) || !['admin', 'internal', 'factory'].includes(target.role) || typeof target.approved !== 'boolean' || typeof target.active !== 'boolean') throw new Error('이름·역할·승인 상태를 확인해 주세요.')
  if (actor.role === 'internal') {
    if (target.id === actor.id || before.role === 'admin' || target.role === 'admin') throw new Error('본인과 관리자 권한은 변경할 수 없습니다.')
    if (!(!before.approved && before.active || before.role === 'factory' && target.role === 'factory')) throw new Error('승인된 본사 계정은 관리자만 변경할 수 있습니다.')
  }
  if (actor.role === 'admin' && actor.id === target.id && (target.role !== 'admin' || !target.active || !target.approved)) throw new Error('본인의 관리자 권한은 해제할 수 없습니다.')
  if (target.role === 'factory' && (!target.factoryId || !workspace.factories.some(row => row.id === target.factoryId))) throw new Error('등록된 공장을 지정해 주세요.')
  const after: Profile = { ...target, name: target.name.trim(), email: before.email, factoryId: target.role === 'factory' ? target.factoryId : null }
  const next = structuredClone(workspace)
  next.profiles = next.profiles.map(row => row.id === target.id ? after : row)
  next.audits.unshift({ id: crypto.randomUUID(), styleId: null, actorId: actor.id, actorName: actor.name, action: '사용자 권한 변경', reason: actor.role === 'admin' ? '관리자 승인 및 계정 관리' : '본사 승인 및 공장 배정', before, after, createdAt: new Date().toISOString() })
  return next
}
