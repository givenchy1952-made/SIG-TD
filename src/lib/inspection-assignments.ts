import type { Factory, Profile, Quantities, Status, Workspace } from './types'
import { emptyQuantities, quantityTotal, SIZES } from './types'
import { getProjectIdentity } from './project-identity'
import { validateOperationReason } from './operations-domain'

export type InspectionProvider = 'able' | 'kotiti'
export type FactoryServiceType = 'production' | 'label' | 'embroidery' | 'inspection'
export interface FactoryServiceSettingsInput { serviceType: FactoryServiceType; inspectionProvider: InspectionProvider | null }
export interface InspectionFactoryFields { active?: boolean; serviceType?: FactoryServiceType; inspectionProvider?: InspectionProvider | null; serviceSettingsVersion?: number }
export type InspectionFactory = Factory & InspectionFactoryFields
export interface InspectionAssignment { styleId: string; lineId: string; provider: InspectionProvider | null; version: number; updatedAt: string; updatedBy: string }
export interface InspectionOrder {
  styleId: string; lineId: string; projectId: string; projectName: string; season: string;
  styleCode: string; color: string; order: Quantities; orderQuantity: number; dueDate: string;
  provider: InspectionProvider | null;
  quality: { category: string; status: Status; quantity: number; note: string }
}
export interface InspectionAssignmentFields { inspectionAssignments?: InspectionAssignment[]; inspectionOrders?: InspectionOrder[]; inspectionAssignmentsAvailable?: boolean }
type InspectionWorkspace = Workspace & InspectionAssignmentFields
export const INSPECTION_PROVIDER_LABEL: Record<InspectionProvider, string> = { able: '에이블', kotiti: 'KOTITI' }
export const FACTORY_SERVICE_LABEL: Record<FactoryServiceType, string> = { production: '생산', label: '라벨', embroidery: '자수', inspection: '품질 검사' }
const providerValid = (value: unknown): value is InspectionProvider | null => value === null || value === 'able' || value === 'kotiti'
const activeActor = (workspace: InspectionWorkspace, supplied: Profile) => workspace.profiles.find(profile => profile.id === supplied.id)
function actorFactory(workspace: InspectionWorkspace, actor: Profile | undefined): InspectionFactory | undefined { return actor?.factoryId ? workspace.factories.find(factory => factory.id === actor.factoryId) : undefined }

/** Service classification is canonical. A provider-less inspector remains an
 * inspector with no orders, rather than falling through to production access. */
export function isInspectionProfile(workspace: InspectionWorkspace, supplied: Profile): boolean {
  const actor = activeActor(workspace, supplied)
  return actor?.role === 'factory' && actorFactory(workspace, actor)?.serviceType === 'inspection'
}

function minimalOrder(row: InspectionOrder): InspectionOrder {
  // Deliberately enumerate every public field. Raw style/PO/price/source data
  // are never spread into an inspector's workspace.
  const order = emptyQuantities()
  for (const size of SIZES) order[size] = row.order[size]
  return { styleId: row.styleId, lineId: row.lineId, projectId: row.projectId, projectName: row.projectName, season: row.season,
    styleCode: row.styleCode, color: row.color, order, orderQuantity: quantityTotal(order), dueDate: row.dueDate, provider: row.provider,
    quality: { category: row.quality.category, status: row.quality.status, quantity: row.quality.quantity, note: row.quality.note } }
}

/** HQ derives a minimal list from accessible styles; cloud inspectors receive
 * only the server projection because raw styles remain closed by RLS. */
export function getInspectionOrders(workspace: InspectionWorkspace, supplied: Profile): InspectionOrder[] {
  const actor = activeActor(workspace, supplied)
  if (!actor?.active || !actor.approved || workspace.inspectionAssignmentsAvailable !== true) return []
  const inspector = isInspectionProfile(workspace, actor), factory = actorFactory(workspace, actor)
  if (actor.role === 'factory' && (!inspector || factory?.active === false || !factory?.inspectionProvider)) return []
  const provider = inspector ? factory!.inspectionProvider : undefined
  if (!workspace.styles.length && workspace.inspectionOrders) return workspace.inspectionOrders
    .filter(row => actor.role !== 'factory' || row.provider === provider)
    .map(minimalOrder)
  const assignments = new Map((workspace.inspectionAssignments || []).map(row => [`${row.styleId}:${row.lineId}`, row]))
  return workspace.styles.filter(style => !style.deletedAt).flatMap(style => style.production.flatMap(line => {
    const assignment = assignments.get(`${style.id}:${line.id}`)
    if (inspector && (!assignment || assignment.provider !== provider)) return []
    const identity = getProjectIdentity(workspace, style.projectId)
    const quality = workspace.productionDetails?.find(detail => detail.styleId === style.id && detail.lineId === line.id)?.quality
    return [minimalOrder({ styleId: style.id, lineId: line.id, projectId: style.projectId, projectName: identity.name, season: identity.season || style.season,
      styleCode: style.code, color: line.color, order: line.order, orderQuantity: quantityTotal(line.order), dueDate: style.dueDate, provider: assignment?.provider || null,
      quality: { category: quality?.category || '', status: quality?.status || 'unset', quantity: quality?.quantity || 0, note: quality?.note || '' } })]
  })).sort((left, right) => left.projectName.localeCompare(right.projectName, 'ko-KR') || left.styleCode.localeCompare(right.styleCode) || left.color.localeCompare(right.color))
}

export function scopeInspectionWorkspace(workspace: InspectionWorkspace, supplied: Profile): InspectionAssignmentFields {
  const actor = activeActor(workspace, supplied), available = workspace.inspectionAssignmentsAvailable === true
  if (!actor?.active || !actor.approved || !available) return { inspectionAssignmentsAvailable: available, inspectionAssignments: [], inspectionOrders: [] }
  const styleIds = new Set(workspace.styles.filter(style => !style.deletedAt).map(style => style.id))
  return { inspectionAssignmentsAvailable: true,
    inspectionAssignments: actor.role === 'factory' ? [] : (workspace.inspectionAssignments || []).filter(row => styleIds.has(row.styleId)).map(row => structuredClone(row)),
    inspectionOrders: getInspectionOrders(workspace, actor) }
}

export function saveInspectionAssignmentInWorkspace(workspace: InspectionWorkspace, supplied: Profile, styleId: string, lineId: string, provider: InspectionProvider | null, expectedVersion: number, reason: string): InspectionWorkspace {
  const actor = activeActor(workspace, supplied)
  if (!actor?.active || !actor.approved || actor.role === 'factory') throw new Error('승인된 본사 담당자만 검사 업체를 배정할 수 있습니다.')
  if (workspace.inspectionAssignmentsAvailable !== true) throw new Error('검사 업체 배정 설정(020)을 먼저 적용해 주세요.')
  validateOperationReason(reason)
  if (!providerValid(provider)) throw new Error('검사 업체는 미배정·에이블·KOTITI 중 선택해 주세요.')
  const style = workspace.styles.find(style => style.id === styleId && !style.deletedAt)
  if (!style?.production.some(line => line.id === lineId)) throw new Error('검사 업체를 배정할 저장된 스타일과 컬러를 확인해 주세요.')
  if (provider && !workspace.factories.some(raw => { const factory = raw as InspectionFactory; return factory.serviceType === 'inspection' && factory.inspectionProvider === provider && factory.active !== false }))
    throw new Error('선택한 검사 업체를 관리자 업체 설정에서 먼저 등록·활성화해 주세요.')
  const before = workspace.inspectionAssignments?.find(row => row.styleId === styleId && row.lineId === lineId)
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || (before?.version || 0) !== expectedVersion) throw new Error('VERSION_CONFLICT')
  const next: InspectionWorkspace = structuredClone(workspace), now = new Date().toISOString()
  const after: InspectionAssignment = { styleId, lineId, provider, version: expectedVersion + 1, updatedAt: now, updatedBy: actor.id }
  next.inspectionAssignments = [...(next.inspectionAssignments || []).filter(row => row.styleId !== styleId || row.lineId !== lineId), after]
  delete next.inspectionOrders
  next.audits.unshift({ id: crypto.randomUUID(), styleId, actorId: actor.id, actorName: actor.name, action: '품질 검사 업체 배정', reason: reason.trim(), before: before || null, after, createdAt: now })
  return next
}

export function saveFactoryServiceSettingsInWorkspace(workspace: InspectionWorkspace, supplied: Profile, id: string, data: FactoryServiceSettingsInput, expectedVersion: number, reason: string): InspectionWorkspace {
  const actor = activeActor(workspace, supplied)
  if (!actor?.active || !actor.approved || actor.role !== 'admin') throw new Error('업체 서비스 구분은 승인된 관리자만 설정할 수 있습니다.')
  if (workspace.inspectionAssignmentsAvailable !== true) throw new Error('업체 서비스 구분 설정(020)을 먼저 적용해 주세요.')
  validateOperationReason(reason)
  if (!data || Object.keys(data).sort().join(',') !== 'inspectionProvider,serviceType' || !Object.hasOwn(FACTORY_SERVICE_LABEL, data.serviceType) || !providerValid(data.inspectionProvider) || data.serviceType !== 'inspection' && data.inspectionProvider !== null)
    throw new Error('업체 서비스 구분과 검사 업체를 확인해 주세요.')
  const before = workspace.factories.find(factory => factory.id === id) as InspectionFactory | undefined
  if (!before) throw new Error('등록된 업체를 선택해 주세요.')
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || (before.serviceSettingsVersion || 0) !== expectedVersion) throw new Error('VERSION_CONFLICT')
  // Match the database's unique provider identity, including inactive vendors.
  // Reassigning an identity requires explicitly clearing its previous owner.
  if (data.inspectionProvider && workspace.factories.some(factory => factory.id !== id && factory.serviceType === 'inspection' && factory.inspectionProvider === data.inspectionProvider))
    throw new Error('선택한 검사 업체는 다른 등록 업체에 연결되어 있습니다. 기존 연결을 먼저 해제해 주세요.')
  const next: InspectionWorkspace = structuredClone(workspace), now = new Date().toISOString()
  const after: InspectionFactory = { ...before, ...data, serviceSettingsVersion: expectedVersion + 1 }
  next.factories = next.factories.map(factory => factory.id === id ? after : factory)
  delete next.inspectionOrders
  next.audits.unshift({ id: crypto.randomUUID(), styleId: null, actorId: actor.id, actorName: actor.name, action: '업체 서비스 구분 설정', reason: reason.trim(), before, after, createdAt: now })
  return next
}
