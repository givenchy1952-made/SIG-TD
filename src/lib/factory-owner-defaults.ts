import type { Profile, Style, Workspace } from './types'

type OwnerWorkspace = Pick<Workspace, 'profiles'> & Partial<Pick<Workspace, 'operations'>>
export interface FactoryOwnerResolution {
  ownerId: string
  source: 'factory' | 'explicit' | 'unassigned'
  candidates: Profile[]
}

/** A factory's one active HQ assignment is its default production owner.
 * Multiple assignees never become an arbitrary first-person selection. */
export function resolveFactoryOwner(workspace: OwnerWorkspace, factoryId: string, fallbackOwnerId = ''): FactoryOwnerResolution {
  const assigned = new Set((workspace.operations?.employeeFactoryAssignments || []).filter(row => row.factoryIds.includes(factoryId)).map(row => row.employeeId))
  const candidates = workspace.profiles.filter(person => assigned.has(person.id) && person.approved && person.active && !person.withdrawnAt && ['admin', 'internal'].includes(person.role))
    .sort((left, right) => left.name.localeCompare(right.name, 'ko-KR') || left.id.localeCompare(right.id))
  if (candidates.length === 1) return { ownerId: candidates[0].id, source: 'factory', candidates }
  return { ownerId: fallbackOwnerId, source: fallbackOwnerId ? 'explicit' : 'unassigned', candidates }
}

/** Applies current defaults to current style/colour data only. Samples and
 * production-run snapshots remain separate historical records. */
export function applyFactoryOwnerDefaults(workspace: OwnerWorkspace, style: Style): Style {
  const owner = resolveFactoryOwner(workspace, style.factoryId, style.ownerId)
  if (style.deletedAt || owner.source !== 'factory') return structuredClone(style)
  return { ...structuredClone(style), ownerId: owner.ownerId, production: style.production.map(line => ({ ...structuredClone(line), ownerId: owner.ownerId })) }
}

/** Called after an explicit factory-assignment save. Existing current styles
 * receive the same owner automatically, with normal version/audit evidence. */
export function syncFactoryOwnerStylesInWorkspace(workspace: Workspace, supplied: Profile, factoryIds: readonly string[], reason: string): Workspace {
  const actor = workspace.profiles.find(person => person.id === supplied.id)
  if (!actor?.active || !actor.approved || actor.withdrawnAt || !['admin', 'internal'].includes(actor.role)) throw new Error('담당 공장 연결은 승인된 본사 계정만 변경할 수 있습니다.')
  if (reason.trim().length < 2 || reason.trim().length > 1000) throw new Error('변경 사유를 2~1,000자로 입력해 주세요.')
  const next = structuredClone(workspace), now = new Date().toISOString(), factories = new Set(factoryIds)
  next.styles = next.styles.map(style => {
    if (style.deletedAt || !factories.has(style.factoryId)) return style
    const derived = applyFactoryOwnerDefaults(next, style)
    if (derived.ownerId === style.ownerId && derived.production.every((line, index) => line.ownerId === style.production[index].ownerId)) return style
    const after = { ...derived, version: style.version + 1, updatedAt: now, updatedBy: actor.id }
    next.audits.unshift({ id: crypto.randomUUID(), styleId: style.id, actorId: actor.id, actorName: actor.name, action: '공장 배정 담당자 자동 연결', reason: reason.trim(), before: structuredClone(style), after: structuredClone(after), createdAt: now })
    return after
  })
  return next
}
