import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../src/lib/operations-types'
import { blankProduction, type Profile, type Workspace } from '../src/lib/types'
import { assertActive, assertProductionAccess, assertStyleSave, canViewStyle } from '../src/lib/permissions'
import { manageProfileInWorkspace } from '../src/lib/staff-approval'
import { canReadCalendarEvent, freshOperations, saveAssignmentInWorkspace, saveCatalogInWorkspace, scopeOperations } from '../src/lib/operations-domain'
import { saveSupplierWorkItemInWorkspace, scopeSupplierWorkRates } from '../src/lib/supplier-work-rates'
import { getInspectionOrders, scopeInspectionWorkspace } from '../src/lib/inspection-assignments'
import { scopeProductionConditionsWorkspace } from '../src/lib/production-conditions'
import { scopeSupplierOrders } from '../src/lib/supplier-orders'
import { buildSigEuljiRows } from '../src/lib/sig-eulji'
import { buildSettlementRows } from '../src/lib/settlement-template'

const id = () => crypto.randomUUID()
function fixture() {
  const admin: Profile = { id: id(), name: '본사 관리자', email: 'admin@example.test', role: 'admin', active: true, approved: true, factoryId: null }
  const internal: Profile = { ...admin, id: id(), name: '본사 직원', role: 'internal' }
  const finance: Profile = { ...admin, id: id(), name: '자금팀', role: 'finance' }
  const factory = { id: id(), name: '라벨 업체', country: '대한민국', serviceType: 'label' as const }
  const pending: Profile = { ...admin, id: id(), name: '가입자', role: 'internal', approved: false }
  const project = { id: id(), name: '공식 명칭', code: 'SIGNIFICANT-2027FY-RPQ-00001', season: '2027FY' }
  const style = { id: id(), code: 'BP07FYJK0001', name: '업무 자료', category: '', season: '2027FY', projectId: project.id, factoryId: factory.id, ownerId: admin.id, colors: ['BK'], dueDate: '', stage: 'production' as const, ppApproved: false, notes: '', samples: [], production: [blankProduction('BK')], version: 1, updatedAt: '', updatedBy: admin.id, deletedAt: null }
  const workspace: Workspace = { profiles: [admin, internal, finance, pending], factories: [factory], projects: [project], styles: [style], comments: [], attachments: [], audits: [], operations: freshOperations(), supplierWorkRatesAvailable: true, supplierWorkRates: [], inspectionAssignmentsAvailable: true }
  return { workspace, admin, internal, finance, pending, factory, style }
}

describe('FA팀의 예산 전용 열람 경계', () => {
  it('활성 FA는 일반 계정 확인을 통과해도 원본 스타일 조회·등록·수정을 할 수 없다', () => {
    const { finance, admin, style } = fixture()
    expect(() => assertActive(finance)).not.toThrow()
    expect(() => assertProductionAccess(finance)).toThrow('예산·을지 누적만 열람')
    expect(canViewStyle(finance, style)).toBe(false)
    expect(canViewStyle(admin, style)).toBe(true)
    for (const before of [undefined, style]) expect(() => assertStyleSave(finance, before, style, '권한 우회 시도')).toThrow('예산·을지 누적만 열람')
  })
  it('관리자가 FA를 지정하면 공장 소속을 제거하고 원래 계정과 권한 변경 이력을 보존한다', () => {
    const { workspace, admin, pending, factory } = fixture()
    const next = manageProfileInWorkspace(workspace, admin, { ...pending, role: 'finance', approved: true, factoryId: factory.id })
    expect(next.profiles.find(person => person.id === pending.id)).toMatchObject({ role: 'finance', approved: true, factoryId: null, email: pending.email })
    expect(workspace.profiles.find(person => person.id === pending.id)).toEqual(pending)
    expect(next.audits[0]).toMatchObject({ action: '사용자 권한 변경', actorId: admin.id, before: pending, after: { role: 'finance' } })
  })
  it('본사 직원은 FA 권한을 부여하거나 기존·대기 FA 계정을 다른 역할로 전환하지 못한다', () => {
    const { workspace, internal, finance, pending } = fixture()
    expect(() => manageProfileInWorkspace(workspace, internal, { ...pending, role: 'finance', approved: true })).toThrow('권한')
    for (const approved of [true, false]) {
      workspace.profiles = workspace.profiles.map(person => person.id === finance.id ? { ...finance, approved } : person)
      expect(() => manageProfileInWorkspace(workspace, internal, { ...finance, role: 'internal', approved: true })).toThrow('권한')
    }
  })
  it('FA의 오래된 관리자 객체로 계정 승인·공통 작업·단가·캘린더를 수정할 수 없다', () => {
    const { workspace, finance, pending, factory } = fixture(), forged = { ...finance, role: 'admin' as const }
    expect(() => manageProfileInWorkspace(workspace, forged, { ...pending, approved: true })).toThrow('본사 관리자')
    expect(() => saveCatalogInWorkspace(workspace, forged, id(), 'label', '권한 없는 라벨', true, 0, '권한 우회 시도')).toThrow('예산·을지 누적만 열람')
    expect(() => saveSupplierWorkItemInWorkspace(workspace, forged, id(), factory.id, 'label', { name: '공통 라벨', specification: '', unitCost: 5, active: true }, 0, 0, '권한 우회 시도')).toThrow('예산·을지 누적만 열람')
  })
  it('FA에게 출시·본인 휴가·공통 목록·본사 배정·원본 오더 메타데이터를 공개하지 않는다', () => {
    const { workspace, finance, admin, factory } = fixture()
    const event = { id: id(), kind: 'launch', title: '원본 일정', startDate: '2027-01-01', endDate: '2027-01-01', ownerId: finance.id, factoryId: null, visibility: 'all', note: '', deletedAt: null, version: 1, createdAt: '', updatedAt: '', updatedBy: admin.id } as CalendarEvent
    workspace.operations!.calendarEvents = [event, { ...event, id: id(), kind: 'personal_leave', visibility: 'private' }]
    workspace.operations!.employeeFactoryAssignments = [{ employeeId: admin.id, factoryIds: [factory.id], version: 1, createdAt: '', updatedAt: '', updatedBy: admin.id }]
    workspace.operations!.operationCatalogs = [{ id: id(), kind: 'label', name: '원본 목록', active: true, supplierFactoryId: factory.id, version: 1, createdAt: '', updatedAt: '', updatedBy: admin.id }]
    expect(canReadCalendarEvent(event, finance)).toBe(false)
    expect(canReadCalendarEvent(event, admin)).toBe(true)
    expect(scopeOperations(workspace, finance)).toEqual(freshOperations())
    expect(scopeSupplierWorkRates(workspace, finance).supplierWorkRates).toEqual([])
  })
  it('FA의 기존 생산·검사·PO 조회 및 고정 을지 생성 경로도 차단한다', () => {
    const { workspace, finance, style } = fixture()
    workspace.inspectionAssignments = [{ styleId: style.id, lineId: style.production[0].id, provider: 'able', version: 1, updatedAt: '', updatedBy: finance.id }]
    expect(getInspectionOrders(workspace, finance)).toEqual([])
    expect(scopeInspectionWorkspace(workspace, finance).inspectionAssignments).toEqual([])
    expect(scopeSupplierOrders(workspace, finance).supplierProductionOrders).toEqual([])
    expect(scopeProductionConditionsWorkspace(workspace, finance).productionConditions).toEqual([])
    for (const kind of ['product', 'label', 'embroidery', 'quality'] as const) expect(buildSigEuljiRows(workspace, [style], finance, kind)).toMatchObject({ rows: [], errors: [expect.stringContaining('본사 직원')] })
    expect(buildSettlementRows(workspace, [style], finance)).toEqual([])
  })
  it('FA를 본사 생산 담당자로 배정하지 못한다', () => {
    const { workspace, admin, finance, factory } = fixture()
    expect(() => saveAssignmentInWorkspace(workspace, admin, finance.id, [factory.id], 0, '본사 담당 공장 배정')).toThrow('활성 본사 담당자')
  })
})
