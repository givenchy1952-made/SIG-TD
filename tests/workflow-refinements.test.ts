import { describe, expect, it, vi } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { blankProduction } from '../src/lib/types'
import {
  blankProductionDetails, leaveLabel, MEASUREMENT_SIZES, QUALITY_CATEGORIES,
  saveProductionDetailsInWorkspace, scopeProductionDetails, validateLeave, validateProductionDetails,
} from '../src/lib/workflow-refinements'
vi.mock('../src/lib/repository', () => ({ supabase: null, getDemoWorkspace: vi.fn(), locked: vi.fn(), persist: vi.fn() }))
import { registerOrderStyleInWorkspace } from '../src/lib/workflow-repository'

function fixture() {
  const workspace = createSeed(), admin = workspace.profiles.find(p => p.id === DEMO_IDS.admin)!, internal = workspace.profiles.find(p => p.id === DEMO_IDS.internal)!, factory = workspace.profiles.find(p => p.id === DEMO_IDS.factory)!
  const style = workspace.styles.find(s => s.factoryId === factory.factoryId)!, line = style.production[0]
  return { workspace, admin, internal, factory, style, line }
}
const personal = { kind: 'personal_leave', startDate: '2026-11-01', endDate: '2026-11-01' }
const reason = '테스트 변경 사유'

describe('개인 반차·2시간 휴가 검증', () => {
  it.each(['full', 'am', 'pm'] as const)('%s 구분과 표시를 지원한다', leaveType => {
    expect(() => validateLeave({ ...personal, leaveType, startTime: '', endTime: '' })).not.toThrow()
    expect(leaveLabel({ kind: personal.kind, leaveType })).toBe({ full: '종일', am: '오전 반차', pm: '오후 반차' }[leaveType])
  })
  it('기존 종일 일정은 추가 필드 없이 계속 유효하다', () => {
    expect(() => validateLeave(personal)).not.toThrow()
    expect(() => validateLeave({ ...personal, endDate: '2026-11-05' })).not.toThrow()
    expect(leaveLabel({ kind: 'launch' })).toBe('')
  })
  it('반반차는 정확히 2시간이며 표시에도 시간을 포함한다', () => {
    const event = { ...personal, leaveType: 'two_hours' as const, startTime: '10:30', endTime: '12:30' }
    expect(() => validateLeave(event)).not.toThrow()
    expect(leaveLabel(event)).toBe('반반차 (2시간) 10:30–12:30')
  })
  it.each([
    { leaveType: 'am', endDate: '2026-11-02' }, { leaveType: 'pm', startTime: '14:00' },
    { leaveType: 'two_hours', startTime: '10:00', endTime: '11:59' },
    { leaveType: 'two_hours', startTime: '22:00', endTime: '00:00' },
    { leaveType: 'two_hours', startTime: '9:00', endTime: '11:00' },
    { kind: 'launch', leaveType: 'am' }, { kind: 'factory_holiday', leaveType: 'two_hours', startTime: '09:00', endTime: '11:00' },
  ])('잘못된 구간이나 다른 일정의 휴가 세부 구분을 거부한다: %j', overrides => {
    expect(() => validateLeave({ ...personal, ...overrides } as Parameters<typeof validateLeave>[0])).toThrow()
  })
})

describe('품질 검사 및 상의·하의 측정 구조', () => {
  it('빈 치수는 null이며 상의·하의와 XXL을 독립적으로 준비한다', () => {
    const a = blankProductionDetails(), b = blankProductionDetails()
    expect(MEASUREMENT_SIZES).toEqual(['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL'])
    expect(a.measurements.upper).toHaveLength(12); expect(a.measurements.lower).toHaveLength(8)
    expect(a.measurements.upper[0].grade).toBeNull()
    expect(Object.values(a.measurements.upper[0].values)).toEqual(Array(7).fill(null))
    a.measurements.upper[0].values.S = 0
    expect(b.measurements.upper[0].values.S).toBeNull()
    expect(() => validateProductionDetails(a)).not.toThrow()
  })
  it.each(QUALITY_CATEGORIES)('고정 품질 검사 %s를 지원한다', category => {
    const data = blankProductionDetails(); data.quality.category = category; data.quality.quantity = 125; data.quality.status = 'progress'
    expect(() => validateProductionDetails(data)).not.toThrow()
  })
  it('cm 두 자리 소수·0·최댓값과 미입력을 구분한다', () => {
    const data = blankProductionDetails()
    data.measurements.upper[0].grade = 0; data.measurements.upper[0].values.XXS = 0
    data.measurements.upper[0].values.XXL = 1000; data.measurements.lower[0].values.S = 32.55
    expect(() => validateProductionDetails(data)).not.toThrow()
  })
  it.each([-1, 1000.01, .001, NaN, Infinity])('유효하지 않은 치수 %s를 거부한다', value => {
    const data = blankProductionDetails(); data.measurements.upper[0].values.M = value
    expect(() => validateProductionDetails(data)).toThrow()
  })
  it('중복 위치·없는 사이즈·빈 표·과다 행·비정상 검사 구분을 거부한다', () => {
    for (const mutate of [(d: any) => d.measurements.upper.push(d.measurements.upper[0]), (d: any) => delete d.measurements.lower[0].values.XXL, (d: any) => { d.measurements.upper = [] }, (d: any) => { d.measurements.lower = Array.from({ length: 31 }, (_, i) => ({ ...d.measurements.lower[0], id: `row-${i}` })) }, (d: any) => { d.quality.category = '기타' }, (d: any) => { d.quality.quantity = 1.5 }]) {
      const data = blankProductionDetails(); mutate(data); expect(() => validateProductionDetails(data)).toThrow()
    }
  })
})

describe('본사·공장 품질 및 치수 저장·범위·충돌', () => {
  it('본사 품질과 치수를 저장해도 기존 스타일·수량과 원본 workspace는 변경하지 않는다', () => {
    const { workspace, internal, style, line } = fixture(), before = structuredClone(workspace)
    const data = blankProductionDetails(); data.quality.category = '니트'; data.measurements.upper[0].values.M = 55.5
    const next = saveProductionDetailsInWorkspace(workspace, internal, style.id, line.id, data, 0, reason)
    expect(workspace).toEqual(before); expect(next.styles).toEqual(before.styles)
    expect(next.productionDetails?.[0]).toMatchObject({ styleId: style.id, lineId: line.id, version: 1, updatedBy: internal.id })
    expect(next.audits[0].after).toMatchObject({ measurements: data.measurements })
  })
  it('배정 공장의 치수 수정은 허용하지만 품질 지시 수정은 거부한다', () => {
    const { workspace, internal, factory, style, line } = fixture()
    const data = blankProductionDetails(); data.quality.category = '바지'
    const first = saveProductionDetailsInWorkspace(workspace, internal, style.id, line.id, data, 0, reason)
    data.measurements.lower[0].values.L = 40
    const second = saveProductionDetailsInWorkspace(first, factory, style.id, line.id, data, 1, reason)
    expect(second.productionDetails?.[0].measurements.lower[0].values.L).toBe(40)
    data.quality.quantity = 100
    expect(() => saveProductionDetailsInWorkspace(second, factory, style.id, line.id, data, 2, reason)).toThrow('품질 검사')
  })
  it('오래된 버전·미승인·역할 위조·다른 공장·삭제 스타일을 차단한다', () => {
    const { workspace, internal, factory, style, line } = fixture(), data = blankProductionDetails()
    const first = saveProductionDetailsInWorkspace(workspace, internal, style.id, line.id, data, 0, reason)
    expect(() => saveProductionDetailsInWorkspace(first, internal, style.id, line.id, data, 0, reason)).toThrow('VERSION_CONFLICT')
    const pending = workspace.profiles.find(p => !p.approved)!
    expect(() => saveProductionDetailsInWorkspace(workspace, { ...pending, role: 'admin', approved: true }, style.id, line.id, data, 0, reason)).toThrow()
    const otherStyle = workspace.styles.find(s => s.factoryId !== factory.factoryId)!
    expect(() => saveProductionDetailsInWorkspace(workspace, factory, otherStyle.id, otherStyle.production[0].id, data, 0, reason)).toThrow()
    first.styles.find(s => s.id === style.id)!.deletedAt = '2026-11-01'
    expect(scopeProductionDetails(first, internal)).toHaveLength(0)
  })
  it('공장에는 본인 배정 스타일만 표시되고 비활성·미승인 계정은 비운다', () => {
    const { workspace, internal, factory, style, line } = fixture()
    const first = saveProductionDetailsInWorkspace(workspace, internal, style.id, line.id, blankProductionDetails(), 0, reason)
    expect(scopeProductionDetails(first, factory)).toHaveLength(1)
    const another = { ...factory, factoryId: workspace.factories.find(f => f.id !== factory.factoryId)!.id }
    expect(scopeProductionDetails(first, another)).toHaveLength(0)
    expect(scopeProductionDetails(first, { ...internal, active: false })).toHaveLength(0)
    expect(scopeProductionDetails(first, { ...internal, approved: false })).toHaveLength(0)
  })
})

describe('프로젝트 코드·명칭 및 스타일 등록 트랜잭션', () => {
  function registration(workspace: ReturnType<typeof createSeed>) {
    const p = { id: crypto.randomUUID(), code: 'QA-NEW-PROJECT', name: '새 프로젝트 명칭', season: '2026FY', expected: null }
    const style = { ...structuredClone(workspace.styles[0]), id: crypto.randomUUID(), code: 'QASTYLE01', name: 'QASTYLE01', projectId: p.id, season: p.season, version: 0, stage: 'registered' as const, ppApproved: false, samples: [], production: [blankProduction('BK')], colors: ['BK'], notes: '', category: '' }
    return { p, style }
  }
  it('A 코드·M 명칭을 분리해 새 프로젝트·빈 생산 스타일을 등록한다', () => {
    const { workspace, internal } = fixture(), { p, style } = registration(workspace), original = structuredClone(workspace)
    const next = registerOrderStyleInWorkspace(workspace, internal, style, p, reason)
    expect(workspace).toEqual(original)
    expect(next.projects.find(project => project.id === p.id)).toMatchObject({ code: p.code, name: p.name })
    expect(next.styles.find(s => s.id === style.id)?.production[0].order.S).toBe(0)
  })
  it('오래된 프로젝트 스냅샷이나 스타일 실패는 원본 프로젝트까지 보존한다', () => {
    const { workspace, internal } = fixture(), { p, style } = registration(workspace), original = structuredClone(workspace)
    style.factoryId = 'missing'
    expect(() => registerOrderStyleInWorkspace(workspace, internal, style, p, reason)).toThrow()
    expect(workspace).toEqual(original)
    const old = workspace.projects[0]
    expect(() => registerOrderStyleInWorkspace(workspace, internal, { ...style, factoryId: workspace.factories[0].id, projectId: old.id }, { ...old, code: 'QA-CODE', expected: { code: '', name: '낡은 이름', season: old.season } }, reason)).toThrow('VERSION_CONFLICT')
  })
  it('관리자도 가져오기용 신규 스타일에 실제 수량을 미리 넣을 수 없다', () => {
    const { workspace, admin } = fixture(), { p, style } = registration(workspace)
    style.production[0].received.S = 1
    expect(() => registerOrderStyleInWorkspace(workspace, admin, style, p, reason)).toThrow()
  })
  it('가져오기용 기존 스타일 등록은 이름 등 기존 기준 정보를 바꾸지 않는다', () => {
    const { workspace, admin, style } = fixture(), old = workspace.projects.find(p => p.id === style.projectId)!
    const p = { ...old, code: 'QA-EXISTING', expected: { code: old.code || '', name: old.name, season: old.season } }
    expect(() => registerOrderStyleInWorkspace(workspace, admin, { ...structuredClone(style), name: '다른 이름' }, p, reason)).toThrow()
  })
  it('공장 또는 위조한 관리자 역할은 등록할 수 없다', () => {
    const { workspace, factory } = fixture(), { p, style } = registration(workspace)
    expect(() => registerOrderStyleInWorkspace(workspace, { ...factory, role: 'admin' }, style, p, reason)).toThrow('본사')
  })
})
