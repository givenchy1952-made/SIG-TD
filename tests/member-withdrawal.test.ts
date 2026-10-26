import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { canViewStyle } from '../src/lib/permissions'
import { withdrawMemberInWorkspace } from '../src/lib/member-withdrawal'

function fixture() {
  const workspace = createSeed()
  const admin = workspace.profiles.find(item => item.id === DEMO_IDS.admin)!
  const internal = workspace.profiles.find(item => item.id === DEMO_IDS.internal)!
  const factory = workspace.profiles.find(item => item.id === DEMO_IDS.factory)!
  return { workspace, admin, internal, factory }
}

describe('관리자 구성원 탈퇴', () => {
  it.each(['internal', 'factory'] as const)('관리자는 %s 계정의 접근을 차단하고 업무 원본과 담당자 참조를 보존한다', role => {
    const { workspace, admin } = fixture(), target = workspace.profiles.find(item => item.role === role)!
    const original = structuredClone(workspace)
    const next = withdrawMemberInWorkspace(workspace, admin, target.id, '  퇴사에 따른 계정 회수  ')
    const withdrawn = next.profiles.find(item => item.id === target.id)!
    expect(withdrawn).toMatchObject({ ...target, active: false, approved: false, withdrawnBy: admin.id })
    expect(withdrawn.withdrawnAt).toEqual(expect.any(String))
    expect(next.profiles).toHaveLength(workspace.profiles.length)
    for (const field of ['styles', 'comments', 'attachments', 'factories', 'projects', 'operations', 'productionRuns', 'productionReceipts', 'settlementTerms'] as const) expect(next[field]).toEqual(workspace[field])
    expect(next.audits[0]).toMatchObject({ actorId: admin.id, action: '구성원 탈퇴', reason: '퇴사에 따른 계정 회수', before: target, after: withdrawn, createdAt: withdrawn.withdrawnAt })
    expect(workspace).toEqual(original)
    expect(workspace.styles.some(style => canViewStyle(withdrawn, style))).toBe(false)
  })
  it('미승인 가입자도 공장 배정을 만들거나 원래 이름·이메일을 변경하지 않고 탈퇴 처리한다', () => {
    const { workspace, admin } = fixture(), pending = workspace.profiles.find(item => !item.approved)!
    const next = withdrawMemberInWorkspace(workspace, admin, pending.id, '가입 요청 철회')
    expect(next.profiles.find(item => item.id === pending.id)).toMatchObject({ id: pending.id, name: pending.name, email: pending.email, factoryId: pending.factoryId, active: false, approved: false })
  })
  it('본사 직원과 공장 계정은 관리자 역할을 주장해도 탈퇴 처리할 수 없다', () => {
    const { workspace, admin, internal, factory } = fixture()
    for (const actor of [internal, factory]) expect(() => withdrawMemberInWorkspace(workspace, { ...actor, role: 'admin' }, admin.id, '권한 우회 시도')).toThrow('관리자만')
  })
  it('승인이 취소되거나 비활성화된 관리자의 오래된 객체를 거부한다', () => {
    for (const field of ['active', 'approved'] as const) {
      const { workspace, admin, internal } = fixture(), stale = structuredClone(admin)
      admin[field] = false
      expect(() => withdrawMemberInWorkspace(workspace, stale, internal.id, '접근 회수')).toThrow('관리자만')
    }
  })
  it('현재 관리자 자신의 탈퇴와 알 수 없는 계정을 차단한다', () => {
    const { workspace, admin } = fixture()
    expect(() => withdrawMemberInWorkspace(workspace, admin, admin.id, '본인 탈퇴')).toThrow('본인은')
    expect(() => withdrawMemberInWorkspace(workspace, admin, crypto.randomUUID(), '없는 계정')).toThrow('찾을 수 없습니다')
  })
  it.each(['', ' ', 'a', 'a'.repeat(1001)])('유효하지 않은 탈퇴 사유를 거부한다', reason => {
    const { workspace, admin, internal } = fixture()
    expect(() => withdrawMemberInWorkspace(workspace, admin, internal.id, reason)).toThrow('탈퇴 사유')
  })
  it('이미 탈퇴한 계정은 중복 처리하거나 새로운 감사 기록을 만들지 않는다', () => {
    const { workspace, admin, internal } = fixture()
    const next = withdrawMemberInWorkspace(workspace, admin, internal.id, '퇴사 처리')
    const auditCount = next.audits.length
    expect(() => withdrawMemberInWorkspace(next, admin, internal.id, '중복 요청')).toThrow('이미 탈퇴')
    expect(next.audits).toHaveLength(auditCount)
  })
  it('다른 관리자를 탈퇴 처리해도 요청한 관리자는 활성 상태로 유지한다', () => {
    const { workspace, admin, internal } = fixture()
    internal.role = 'admin'
    const next = withdrawMemberInWorkspace(workspace, admin, internal.id, '관리자 퇴사')
    expect(next.profiles.find(item => item.id === admin.id)).toEqual(admin)
    expect(next.profiles.filter(item => item.role === 'admin' && item.active && item.approved)).toHaveLength(1)
  })
})
