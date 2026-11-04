import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { blankProductionDetails } from '../src/lib/workflow-refinements'
import type { Profile, Workspace } from '../src/lib/types'
import { getInspectionOrders, isInspectionProfile, saveFactoryServiceSettingsInWorkspace, saveInspectionAssignmentInWorkspace, scopeInspectionWorkspace, type InspectionAssignmentFields, type InspectionFactory, type InspectionOrder } from '../src/lib/inspection-assignments'

function fixture() {
  const workspace = createSeed() as Workspace & InspectionAssignmentFields
  workspace.inspectionAssignmentsAvailable = true; workspace.inspectionAssignments = []
  const admin = workspace.profiles.find(row => row.id === DEMO_IDS.admin)!, internal = workspace.profiles.find(row => row.id === DEMO_IDS.internal)!, production = workspace.profiles.find(row => row.id === DEMO_IDS.factory)!
  const ableFactory: InspectionFactory = { id: crypto.randomUUID(), name: '검사 파트너 A', country: '대한민국', serviceType: 'inspection', inspectionProvider: 'able', serviceSettingsVersion: 1, active: true }
  const kotitiFactory: InspectionFactory = { ...ableFactory, id: crypto.randomUUID(), name: '검사 파트너 B', inspectionProvider: 'kotiti' }
  workspace.factories.push(ableFactory, kotitiFactory)
  const able: Profile = { ...production, id: crypto.randomUUID(), name: '에이블 담당자', factoryId: ableFactory.id }, kotiti: Profile = { ...production, id: crypto.randomUUID(), name: 'KOTITI 담당자', factoryId: kotitiFactory.id }
  workspace.profiles.push(able, kotiti)
  const style = workspace.styles[0], line = style.production[0], project = workspace.projects.find(row => row.id === style.projectId)!
  workspace.styles = [style]; style.notes = '본사 내부 메모'; line.invoiceAmount = 987654
  project.name = '생산 일정용 명칭'; project.code = 'HQ-BUDGET-PRIVATE'
  const detail = blankProductionDetails(); detail.quality = { ...detail.quality, category: '아우터', status: 'progress', quantity: 7, note: '검사 대상 안내' }
  workspace.productionDetails = [{ ...detail, styleId: style.id, lineId: line.id, version: 1, createdAt: '', updatedAt: '', updatedBy: admin.id }]
  return { workspace, admin, internal, production, ableFactory, kotitiFactory, able, kotiti, style, line }
}

describe('검사 업체 배정과 최소 조회 범위', () => {
  it('본사 명시 배정 전에는 에이블과 KOTITI 어느 계정에도 오더가 보이지 않는다', () => {
    const { workspace, able, kotiti, admin } = fixture(), before = structuredClone(workspace)
    expect(isInspectionProfile(workspace, able)).toBe(true)
    expect(getInspectionOrders(workspace, able)).toEqual([]); expect(getInspectionOrders(workspace, kotiti)).toEqual([])
    expect(getInspectionOrders(workspace, admin).every(row => row.provider === null)).toBe(true)
    expect(workspace).toEqual(before)
  })
  it('본사 배정은 같은 스타일·컬러만 검사자에게 공개하며 예산·PO·가격·내부 정보를 넘기지 않는다', () => {
    const { workspace, internal, able, kotiti, style, line } = fixture(), before = structuredClone(workspace)
    const next = saveInspectionAssignmentInWorkspace(workspace, internal, style.id, line.id, 'able', 0, '에이블 검사를 요청합니다')
    const orders = getInspectionOrders(next, able)
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({ styleId: style.id, lineId: line.id, provider: 'able', projectName: '생산 일정용 명칭', quality: { category: '아우터', quantity: 7, note: '검사 대상 안내' } })
    expect(Object.keys(orders[0]).sort()).toEqual(['styleId', 'lineId', 'projectId', 'projectName', 'season', 'styleCode', 'color', 'order', 'orderQuantity', 'dueDate', 'provider', 'quality'].sort())
    expect(JSON.stringify(orders)).not.toContain('HQ-BUDGET-PRIVATE'); expect(JSON.stringify(orders)).not.toContain('본사 내부 메모'); expect(JSON.stringify(orders)).not.toContain('987654')
    expect(getInspectionOrders(next, kotiti)).toEqual([])
    expect(next.styles).toEqual(before.styles); expect(next.projects).toEqual(before.projects); expect(next.productionDetails).toEqual(before.productionDetails)
    expect(workspace).toEqual(before)
  })
  it('다른 검사 업체로 재배정하거나 미배정으로 바꾸면 이전 검사자의 조회가 즉시 사라진다', () => {
    const { workspace, admin, able, kotiti, style, line } = fixture()
    const first = saveInspectionAssignmentInWorkspace(workspace, admin, style.id, line.id, 'able', 0, '에이블 최초 배정')
    const second = saveInspectionAssignmentInWorkspace(first, admin, style.id, line.id, 'kotiti', 1, 'KOTITI로 검사 변경')
    expect(getInspectionOrders(second, able)).toEqual([]); expect(getInspectionOrders(second, kotiti)).toHaveLength(1)
    const unassigned = saveInspectionAssignmentInWorkspace(second, admin, style.id, line.id, null, 2, '검사 배정을 해제합니다')
    expect(getInspectionOrders(unassigned, able)).toEqual([]); expect(getInspectionOrders(unassigned, kotiti)).toEqual([])
    expect(unassigned.audits.slice(0, 3).map(row => (row.after as { provider: unknown }).provider)).toEqual([null, 'kotiti', 'able'])
    expect(second.inspectionAssignments?.[0].provider).toBe('kotiti')
  })
  it('검사 업체는 배정 변경을 할 수 없으며 위조한 공급자·본사 역할을 신뢰하지 않는다', () => {
    const { workspace, admin, able, style, line } = fixture()
    expect(() => saveInspectionAssignmentInWorkspace(workspace, { ...able, role: 'admin' }, style.id, line.id, 'able', 0, '위조 역할 시도')).toThrow(/본사/)
    expect(() => saveInspectionAssignmentInWorkspace(workspace, { ...admin, id: 'unknown' }, style.id, line.id, 'able', 0, '등록 안 된 계정')).toThrow(/본사/)
    expect(getInspectionOrders(workspace, { ...able, factoryId: DEMO_IDS.china })).toEqual([])
  })
  it('오래된 배정 버전·없는 컬러·삭제 스타일과 잘못된 제공자를 거부한다', () => {
    const { workspace, admin, style, line } = fixture()
    const first = saveInspectionAssignmentInWorkspace(workspace, admin, style.id, line.id, 'able', 0, '검사 배정 시험')
    expect(() => saveInspectionAssignmentInWorkspace(first, admin, style.id, line.id, 'kotiti', 0, '오래된 변경')).toThrow(/VERSION_CONFLICT/)
    expect(() => saveInspectionAssignmentInWorkspace(workspace, admin, style.id, 'foreign-line', 'able', 0, '없는 컬러')).toThrow(/스타일과 컬러/)
    expect(() => saveInspectionAssignmentInWorkspace(workspace, admin, style.id, line.id, 'unknown' as 'able', 0, '허용되지 않는 업체')).toThrow(/미배정/)
    style.deletedAt = new Date().toISOString()
    expect(() => saveInspectionAssignmentInWorkspace(workspace, admin, style.id, line.id, 'able', 0, '삭제 스타일')).toThrow(/스타일과 컬러/)
  })
  it('검사 서비스·제공자 미지정과 비활성 업체는 생산 계정으로 우회되지 않는다', () => {
    const { workspace, admin, able, ableFactory, production, style, line } = fixture()
    const assigned = saveInspectionAssignmentInWorkspace(workspace, admin, style.id, line.id, 'able', 0, '검사 업체 배정')
    const factory = assigned.factories.find(row => row.id === ableFactory.id) as InspectionFactory
    factory.inspectionProvider = null
    expect(isInspectionProfile(assigned, able)).toBe(true); expect(getInspectionOrders(assigned, able)).toEqual([])
    factory.inspectionProvider = 'able'; factory.active = false
    expect(isInspectionProfile(assigned, able)).toBe(true); expect(getInspectionOrders(assigned, able)).toEqual([])
    expect(getInspectionOrders(assigned, production)).toEqual([])
    expect(() => saveInspectionAssignmentInWorkspace(assigned, admin, style.id, line.id, 'able', 1, '비활성 검사 업체')).toThrow(/활성화/)
  })
  it('클라우드 검사자에게 원본 스타일이 없어도 서버 투영값의 자기 제공자만 최소 필드로 조회한다', () => {
    const { workspace, admin, able, style, line } = fixture()
    const assigned = saveInspectionAssignmentInWorkspace(workspace, admin, style.id, line.id, 'able', 0, '검사 조회 시험')
    const row = getInspectionOrders(assigned, able)[0]
    assigned.styles = []; assigned.inspectionAssignments = []
    assigned.inspectionOrders = [{ ...row, internalPrice: 999, poBody: '비공개' } as InspectionOrder, { ...row, provider: 'kotiti' }, { ...row, provider: null }]
    const scoped = scopeInspectionWorkspace(assigned, able)
    expect(scoped.inspectionOrders).toEqual([row]); expect(scoped.inspectionAssignments).toEqual([])
    expect(JSON.stringify(scoped)).not.toContain('비공개'); expect(JSON.stringify(scoped)).not.toContain('internalPrice')
  })
  it('미승인·비활성 계정 또는 미설치 기능은 빈 범위를 반환하며 저장하지 않는다', () => {
    const { workspace, admin, able, style, line } = fixture()
    workspace.profiles.find(row => row.id === able.id)!.approved = false
    expect(scopeInspectionWorkspace(workspace, able).inspectionOrders).toEqual([])
    workspace.profiles.find(row => row.id === admin.id)!.active = false
    expect(() => saveInspectionAssignmentInWorkspace(workspace, admin, style.id, line.id, 'able', 0, '차단 확인')).toThrow(/본사/)
    workspace.profiles.find(row => row.id === admin.id)!.active = true; workspace.inspectionAssignmentsAvailable = false
    expect(getInspectionOrders(workspace, admin)).toEqual([])
    expect(() => saveInspectionAssignmentInWorkspace(workspace, admin, style.id, line.id, null, 0, '설정 확인')).toThrow(/020/)
  })
})

describe('관리자의 명시적 업체 서비스 설정', () => {
  it('업체 이름으로 추정하지 않고 관리자 설정만 변경하며 기존 이름·생산 자료를 유지한다', () => {
    const { workspace, admin, ableFactory } = fixture(), before = structuredClone(workspace)
    const next = saveFactoryServiceSettingsInWorkspace(workspace, admin, ableFactory.id, { serviceType: 'inspection', inspectionProvider: null }, 1, '검사 제공자 연결 해제')
    expect(next.factories.find(row => row.id === ableFactory.id)).toMatchObject({ name: ableFactory.name, serviceType: 'inspection', inspectionProvider: null, serviceSettingsVersion: 2 })
    expect(next.styles).toEqual(before.styles); expect(next.profiles).toEqual(before.profiles); expect(workspace).toEqual(before)
  })
  it('본사 직원·업체·오래된 버전·생산 업체의 검사 제공자 지정은 거부한다', () => {
    const { workspace, admin, internal, able, ableFactory } = fixture()
    const data = { serviceType: 'inspection' as const, inspectionProvider: 'able' as const }
    for (const actor of [internal, able]) expect(() => saveFactoryServiceSettingsInWorkspace(workspace, actor, ableFactory.id, data, 1, '권한 검증')).toThrow(/관리자/)
    expect(() => saveFactoryServiceSettingsInWorkspace(workspace, admin, ableFactory.id, data, 0, '오래된 버전')).toThrow(/VERSION_CONFLICT/)
    expect(() => saveFactoryServiceSettingsInWorkspace(workspace, admin, ableFactory.id, { serviceType: 'production', inspectionProvider: 'able' }, 1, '잘못된 제공자')).toThrow(/구분/)
  })
  it('검사 제공자의 중복 연결은 비활성 업체도 포함해 거부하고 기존 연결 해제 후에만 이전한다', () => {
    const { workspace, admin, ableFactory, kotitiFactory } = fixture(), before = structuredClone(workspace)
    const data = { serviceType: 'inspection' as const, inspectionProvider: 'able' as const }
    expect(() => saveFactoryServiceSettingsInWorkspace(workspace, admin, kotitiFactory.id, data, 1, '검사 업체 중복 연결')).toThrow(/기존 연결/)
    expect(workspace).toEqual(before)
    workspace.factories.find(factory => factory.id === ableFactory.id)!.active = false
    expect(() => saveFactoryServiceSettingsInWorkspace(workspace, admin, kotitiFactory.id, data, 1, '비활성 업체 연결 도용')).toThrow(/기존 연결/)
    const cleared = saveFactoryServiceSettingsInWorkspace(workspace, admin, ableFactory.id, { ...data, inspectionProvider: null }, 1, '기존 검사 업체 연결 해제')
    const moved = saveFactoryServiceSettingsInWorkspace(cleared, admin, kotitiFactory.id, data, 1, '검사 업체 명시적 이전')
    expect(moved.factories.find(factory => factory.id === kotitiFactory.id)).toMatchObject({ inspectionProvider: 'able', serviceSettingsVersion: 2 })
    expect(moved.audits[0].before).toMatchObject({ inspectionProvider: 'kotiti' })
    expect(moved.styles).toEqual(before.styles)
  })
})
