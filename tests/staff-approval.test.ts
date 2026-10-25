import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { manageProfileInWorkspace } from '../src/lib/staff-approval'
import { saveAssignmentInWorkspace, freshOperations } from '../src/lib/operations-domain'

function fixture() {
  const workspace = createSeed()
  workspace.operations = freshOperations()
  const admin = workspace.profiles.find(row => row.id === DEMO_IDS.admin)!
  const internal = workspace.profiles.find(row => row.id === DEMO_IDS.internal)!
  const pending = workspace.profiles.find(row => !row.approved)!
  return { workspace, admin, internal, pending }
}
describe('본사 승인 체험 모드와 서버 규칙 일치', () => {
  it('본사 직원이 공장을 지정하고 승인하면 공장 계정으로 저장한다', () => {
    const { workspace, internal, pending } = fixture()
    const next = manageProfileInWorkspace(workspace, internal, { ...pending, approved: true, factoryId: DEMO_IDS.china })
    expect(next.profiles.find(row => row.id === pending.id)).toMatchObject({ approved: true, role: 'factory', factoryId: DEMO_IDS.china })
    expect(workspace.profiles.find(row => row.id === pending.id)?.approved).toBe(false)
    expect(next.audits[0]).toMatchObject({ actorId: internal.id, reason: '본사 승인 및 공장 배정' })
  })
  it('공장 없는 승인과 존재하지 않는 공장 배정은 거부한다', () => {
    const { workspace, internal, pending } = fixture()
    for (const factoryId of [null, 'unknown']) expect(() => manageProfileInWorkspace(workspace, internal, { ...pending, approved: true, factoryId })).toThrow('등록된 공장')
  })
  it('본사 직원은 관리자·본인·기존 승인 본사의 권한을 변경할 수 없다', () => {
    const { workspace, internal, admin, pending } = fixture()
    expect(() => manageProfileInWorkspace(workspace, internal, { ...pending, role: 'admin', approved: true })).toThrow('관리자 권한')
    expect(() => manageProfileInWorkspace(workspace, internal, { ...admin, active: false })).toThrow('관리자 권한')
    expect(() => manageProfileInWorkspace(workspace, internal, { ...internal, active: false })).toThrow('관리자 권한')
    const colleague = workspace.profiles.find(row => row.role === 'internal' && row.id !== internal.id)!
    expect(() => manageProfileInWorkspace(workspace, internal, { ...colleague, active: false })).toThrow('승인된 본사')
  })
  it('새 본사 가입자를 명시적으로 승인하고 공장 소속 정보는 제거한다', () => {
    const { workspace, internal, pending } = fixture()
    const next = manageProfileInWorkspace(workspace, internal, { ...pending, role: 'internal', approved: true, factoryId: DEMO_IDS.china })
    expect(next.profiles.find(row => row.id === pending.id)).toMatchObject({ role: 'internal', approved: true, factoryId: null })
  })
  it('비활성화된 본사의 오래된 관리자 객체로 승인을 우회하지 못한다', () => {
    const { workspace, internal, pending } = fixture()
    internal.active = false
    expect(() => manageProfileInWorkspace(workspace, { ...internal, role: 'admin', active: true }, { ...pending, approved: true, factoryId: DEMO_IDS.china })).toThrow('승인 후')
  })
  it('본사 직원이 동료 담당 공장을 변경하되 관리자 배정은 변경하지 못한다', () => {
    const { workspace, internal, admin } = fixture()
    const next = saveAssignmentInWorkspace(workspace, internal, internal.id, [DEMO_IDS.china], 0, '담당 공장 배정')
    expect(next.operations!.employeeFactoryAssignments[0].factoryIds).toEqual([DEMO_IDS.china])
    expect(() => saveAssignmentInWorkspace(workspace, internal, admin.id, [DEMO_IDS.china], 0, '담당 공장 배정')).toThrow('관리자만')
  })
})
