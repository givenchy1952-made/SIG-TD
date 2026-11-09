import { describe, expect, it } from 'vitest'
import { applyFactoryOwnerDefaults, resolveFactoryOwner, syncFactoryOwnerStylesInWorkspace } from '../src/lib/factory-owner-defaults'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { EMPTY_OPERATIONS } from '../src/lib/operations-types'

function fixture() {
  const w = createSeed(), style = w.styles.find(item => item.production.length)!
  w.styles = [style]; w.operations = structuredClone(EMPTY_OPERATIONS)
  style.ownerId = DEMO_IDS.admin
  for (const line of style.production) line.ownerId = DEMO_IDS.admin
  return { w, style, admin: w.profiles.find(person => person.id === DEMO_IDS.admin)!, internal: w.profiles.find(person => person.id === DEMO_IDS.internal)! }
}
function assignment(employeeId: string, factoryIds: string[]) { return { employeeId, factoryIds, version: 1, createdAt: '', updatedAt: '', updatedBy: DEMO_IDS.admin } }

describe('담당 공장 배정에서 스타일 본사 담당자 자동 연결', () => {
  it('활성 승인된 한 명의 공장 담당자를 스타일과 전체 컬러에 연결한다', () => {
    const { w, style, internal } = fixture(), before = structuredClone(style)
    w.operations!.employeeFactoryAssignments = [assignment(internal.id, [style.factoryId])]
    expect(resolveFactoryOwner(w, style.factoryId, style.ownerId)).toMatchObject({ ownerId: internal.id, source: 'factory' })
    const projected = applyFactoryOwnerDefaults(w, style)
    expect(projected.ownerId).toBe(internal.id)
    expect(projected.production.every(line => line.ownerId === internal.id)).toBe(true)
    expect(projected.samples).toEqual(style.samples)
    expect(style).toEqual(before)
  })
  it('담당 공장 복수 배정은 첫 이름을 고르지 않고 기존 명시값을 유지한다', () => {
    const { w, style, admin, internal } = fixture()
    w.operations!.employeeFactoryAssignments = [assignment(admin.id, [style.factoryId]), assignment(internal.id, [style.factoryId])]
    expect(resolveFactoryOwner(w, style.factoryId, style.ownerId)).toMatchObject({ ownerId: admin.id, source: 'explicit' })
    expect(applyFactoryOwnerDefaults(w, style)).toEqual(style)
    expect(resolveFactoryOwner(w, style.factoryId)).toMatchObject({ ownerId: '', source: 'unassigned' })
  })
  it('다른 공장·미승인·비활성·외부 업체·탈퇴 계정은 자동 담당 후보가 아니다', () => {
    for (const update of [{ approved: false }, { active: false }, { role: 'factory' as const }, { withdrawnAt: '2026-11-09T00:00:00Z' }]) {
      const { w, style, internal } = fixture()
      Object.assign(internal, update)
      w.operations!.employeeFactoryAssignments = [assignment(internal.id, [style.factoryId])]
      expect(resolveFactoryOwner(w, style.factoryId)).toMatchObject({ ownerId: '', source: 'unassigned', candidates: [] })
    }
    const { w, style, internal } = fixture()
    w.operations!.employeeFactoryAssignments = [assignment(internal.id, ['different-factory'])]
    expect(applyFactoryOwnerDefaults(w, style)).toEqual(style)
  })
  it('명시적 공장 배정 저장은 현재 스타일에 감사 이력을 남기고 기존 차수 기록은 보존한다', () => {
    const { w, style, admin, internal } = fixture()
    w.operations!.employeeFactoryAssignments = [assignment(internal.id, [style.factoryId])]
    // Immutable historical data is outside this transformation's owner scope.
    const frozen = { id: 'closed-run', closedAt: '2026-11-08', ownerIdSnapshot: admin.id, ownerNameSnapshot: admin.name, snapshot: { ownerIdSnapshot: admin.id, owner: admin.name } }
    w.productionRuns = [frozen] as unknown as NonNullable<typeof w.productionRuns>
    const before = structuredClone(w), next = syncFactoryOwnerStylesInWorkspace(w, admin, [style.factoryId], '담당 공장 연결')
    expect(next.styles[0]).toMatchObject({ ownerId: internal.id, version: style.version + 1, updatedBy: admin.id })
    expect(next.styles[0].production.every(line => line.ownerId === internal.id)).toBe(true)
    expect(next.productionRuns).toEqual(before.productionRuns)
    expect(next.audits[0]).toMatchObject({ styleId: style.id, action: '공장 배정 담당자 자동 연결', before: { ownerId: admin.id }, after: { ownerId: internal.id } })
    expect(w).toEqual(before)
    const again = syncFactoryOwnerStylesInWorkspace(next, admin, [style.factoryId], '같은 배정 확인')
    expect(again.styles[0].version).toBe(next.styles[0].version)
    expect(again.audits).toEqual(next.audits)
  })
  it('배정이 없는 공장·삭제한 스타일은 변경하지 않으며 저장 actor는 현재 프로필로 판단한다', () => {
    const { w, style, admin, internal } = fixture()
    w.operations!.employeeFactoryAssignments = [assignment(internal.id, [style.factoryId])]
    style.deletedAt = '2026-11-08T00:00:00Z'
    expect(syncFactoryOwnerStylesInWorkspace(w, admin, [style.factoryId], '담당 공장 연결').styles).toEqual(w.styles)
    expect(syncFactoryOwnerStylesInWorkspace(w, admin, [], '담당 공장 연결').audits).toEqual(w.audits)
    admin.active = false
    expect(() => syncFactoryOwnerStylesInWorkspace(w, { ...admin, active: true }, [style.factoryId], '담당 공장 연결')).toThrow('본사 계정')
  })
})
