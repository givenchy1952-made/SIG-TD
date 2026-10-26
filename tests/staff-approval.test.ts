import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { manageProfileInWorkspace } from '../src/lib/staff-approval'
import { saveAssignmentInWorkspace, freshOperations } from '../src/lib/operations-domain'
import { withdrawMemberInWorkspace } from '../src/lib/member-withdrawal'

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
  it('본사 직원은 탈퇴 공장 계정을 재승인하거나 소속·이름을 수정할 수 없다', () => {
    const { workspace, admin, internal } = fixture()
    const next = withdrawMemberInWorkspace(workspace, admin, DEMO_IDS.factory, '계약 종료')
    const former = next.profiles.find(row => row.id === DEMO_IDS.factory)!
    for (const changes of [
      { active: true, approved: true },
      { name: '변경한 담당자' },
      { factoryId: DEMO_IDS.korea },
    ]) expect(() => manageProfileInWorkspace(next, internal, { ...former, ...changes })).toThrow('탈퇴한 구성원')
    expect(next.profiles.find(row => row.id === former.id)).toEqual(former)
  })
  it('관리자가 승인과 활성을 함께 복구하면 탈퇴 표식을 지우고 기존 공장을 보존한다', () => {
    const { workspace, admin } = fixture()
    const withdrawn = withdrawMemberInWorkspace(workspace, admin, DEMO_IDS.factory, '계약 종료')
    const former = withdrawn.profiles.find(row => row.id === DEMO_IDS.factory)!
    const restored = manageProfileInWorkspace(withdrawn, admin, { ...former, active: true, approved: true })
    expect(restored.profiles.find(row => row.id === former.id)).toMatchObject({ active: true, approved: true, withdrawnAt: null, withdrawnBy: null, factoryId: former.factoryId, email: former.email })
    expect(restored.audits[0]).toMatchObject({ action: '사용자 권한 변경', actorId: admin.id, before: { withdrawnAt: former.withdrawnAt, withdrawnBy: admin.id }, after: { withdrawnAt: null, withdrawnBy: null } })
    expect(withdrawn.profiles.find(row => row.id === former.id)).toEqual(former)
  })
  it('관리자의 비활성 계정 정보 수정은 탈퇴 시각·처리자를 보존한다', () => {
    const { workspace, admin } = fixture()
    const withdrawn = withdrawMemberInWorkspace(workspace, admin, DEMO_IDS.factory, '계약 종료')
    const former = withdrawn.profiles.find(row => row.id === DEMO_IDS.factory)!
    const next = manageProfileInWorkspace(withdrawn, admin, { ...former, name: '기록 정정', withdrawnAt: null, withdrawnBy: null })
    expect(next.profiles.find(row => row.id === former.id)).toMatchObject({ name: '기록 정정', active: false, approved: false, withdrawnAt: former.withdrawnAt, withdrawnBy: former.withdrawnBy })
  })
  it('탈퇴 계정의 승인 또는 활성만 복구하는 변경은 거부한다', () => {
    const { workspace, admin } = fixture()
    const withdrawn = withdrawMemberInWorkspace(workspace, admin, DEMO_IDS.factory, '계약 종료')
    const former = withdrawn.profiles.find(row => row.id === DEMO_IDS.factory)!
    for (const changes of [{ active: true }, { approved: true }]) expect(() => manageProfileInWorkspace(withdrawn, admin, { ...former, ...changes })).toThrow('함께 복구')
  })
  it('일반 계정 변경으로 탈퇴 표식을 위조하지 못한다', () => {
    const { workspace, admin } = fixture()
    const target = workspace.profiles.find(row => row.id === DEMO_IDS.factory)!
    expect(() => manageProfileInWorkspace(workspace, admin, { ...target, active: false, approved: false, withdrawnAt: new Date().toISOString(), withdrawnBy: admin.id })).toThrow('구성원 탈퇴 버튼')
  })
  it('탈퇴한 관리자의 오래된 로그인 객체로 계정을 복구하지 못한다', () => {
    const { workspace, admin } = fixture()
    const former = workspace.profiles.find(row => row.id === DEMO_IDS.factory)!
    former.active = false; former.approved = false; former.withdrawnAt = new Date().toISOString(); former.withdrawnBy = admin.id
    admin.active = false; admin.approved = false
    expect(() => manageProfileInWorkspace(workspace, { ...admin, active: true, approved: true }, { ...former, active: true, approved: true })).toThrow('승인 후')
  })
})
