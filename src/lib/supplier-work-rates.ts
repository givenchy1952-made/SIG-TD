import type { Factory, Profile, Workspace } from './types'
import type { OperationCatalog, StyleOperationInput, StyleOperationKind } from './operations-types'
import { assertActive, canViewStyle } from './permissions'
import { saveOperationInWorkspace, validateOperationReason } from './operations-domain'
import { QUALITY_CATEGORIES } from './workflow-refinements'
import { findProcessingUnitPrice, validateProcessingUnitCost, type ProcessingPriceKind, type ProcessingUnitPrice } from './processing-prices'

export interface SupplierWorkRate {
  factoryId: string; kind: ProcessingPriceKind; itemKey: string; unitCost: number | null;
  version: number; createdAt: string; updatedAt: string; updatedBy: string;
}
export interface SupplierWorkRateAudit { id: string; factoryId: string; kind: ProcessingPriceKind; itemKey: string; actorId: string; actorName: string; reason: string; before: SupplierWorkRate | null; after: SupplierWorkRate; createdAt: string }
export interface SupplierWorkRatesFields { supplierWorkRates?: SupplierWorkRate[]; supplierWorkRateAudits?: SupplierWorkRateAudit[]; supplierWorkRatesAvailable?: boolean }
export interface SupplierWorkItemInput { name: string; specification: string; active: boolean; unitCost: number | null }
type SupplierWorkspace = Workspace & SupplierWorkRatesFields
type SupplierFactory = Factory & { serviceType?: 'production' | 'label' | 'embroidery' | 'inspection'; inspectionProvider?: 'able' | 'kotiti' | null; active?: boolean }
type SupplierCatalog = OperationCatalog & { supplierFactoryId?: string | null; specification?: string }
type SupplierPrice = ProcessingUnitPrice & { supplierFactoryId?: string | null; masterRateVersion?: number | null }
const rateKey = (factoryId: string, kind: ProcessingPriceKind, itemKey: string) => JSON.stringify([factoryId, kind, itemKey])
const badControl = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/

export function supplierSupportsKind(factory: Factory | undefined, kind: ProcessingPriceKind): boolean {
  const value = factory as SupplierFactory | undefined
  return !!value && value.active !== false && (kind === 'quality' ? value.serviceType === 'inspection' && ['able', 'kotiti'].includes(value.inspectionProvider || '') : value.serviceType === kind)
}
export function supplierCatalogOptions(workspace: Pick<Workspace, 'operations'>, factoryId: string | null, kind: StyleOperationKind): OperationCatalog[] {
  return (workspace.operations?.operationCatalogs || []).filter(catalog => catalog.kind === kind && ((catalog as SupplierCatalog).supplierFactoryId || null) === factoryId)
}
export function findSupplierWorkRate(workspace: SupplierWorkRatesFields, factoryId: string, kind: ProcessingPriceKind, itemKey: string): SupplierWorkRate | undefined {
  return workspace.supplierWorkRates?.find(rate => rate.factoryId === factoryId && rate.kind === kind && rate.itemKey === itemKey)
}
function actorFor(workspace: Workspace, supplied: Profile): Profile {
  const actor = workspace.profiles.find(profile => profile.id === supplied.id)
  if (!actor) throw new Error('사용자 계정을 확인해 주세요.')
  assertActive(actor); return actor
}
function supplierFor(workspace: Workspace, actor: Profile, factoryId: string, kind: ProcessingPriceKind): SupplierFactory {
  const factory = workspace.factories.find(item => item.id === factoryId)
  if (!supplierSupportsKind(factory, kind) || actor.role === 'factory' && actor.factoryId !== factoryId) throw new Error('담당 업체의 업무 구분과 수정 권한을 확인해 주세요.')
  return factory as SupplierFactory
}
function checkVersion(before: { version: number } | undefined, expected: number) {
  if (!Number.isSafeInteger(expected) || expected < 0 || (before?.version || 0) !== expected) throw new Error('VERSION_CONFLICT: 다른 사용자가 먼저 변경했습니다. 최신 기준을 확인해 주세요.')
}
function putRate(next: SupplierWorkspace, actor: Profile, factoryId: string, kind: ProcessingPriceKind, itemKey: string, unitCost: number | null, reason: string): void {
  const before = findSupplierWorkRate(next, factoryId, kind, itemKey), now = new Date().toISOString()
  const after: SupplierWorkRate = { factoryId, kind, itemKey, unitCost, version: (before?.version || 0) + 1, createdAt: before?.createdAt || now, updatedAt: now, updatedBy: actor.id }
  const key = rateKey(factoryId, kind, itemKey)
  next.supplierWorkRates = [...(next.supplierWorkRates || []).filter(row => rateKey(row.factoryId, row.kind, row.itemKey) !== key), after]
  next.supplierWorkRateAudits = [...(next.supplierWorkRateAudits || []), { id: crypto.randomUUID(), factoryId, kind, itemKey, actorId: actor.id, actorName: actor.name, reason: reason.trim(), before: before || null, after, createdAt: now }]
  next.supplierWorkRatesAvailable = true
}
function checkRateItem(workspace: Workspace, factoryId: string, kind: ProcessingPriceKind, itemKey: string) {
  if (kind === 'quality') {
    if (!QUALITY_CATEGORIES.includes(itemKey as typeof QUALITY_CATEGORIES[number])) throw new Error('등록된 품질 검사 품목을 선택해 주세요.')
  } else if (!workspace.operations?.operationCatalogs.some(item => item.id === itemKey && item.kind === kind && (item as SupplierCatalog).supplierFactoryId === factoryId)) throw new Error('이 업체에 등록된 작업 종류를 선택해 주세요.')
}
export function scopeSupplierWorkRates(workspace: SupplierWorkspace, supplied: Profile): SupplierWorkRatesFields {
  const actor = workspace.profiles.find(profile => profile.id === supplied.id)
  const allowed = actor?.active && actor.approved
  const visible = (row: { factoryId: string; kind: ProcessingPriceKind }) => !!allowed && supplierSupportsKind(workspace.factories.find(factory => factory.id === row.factoryId), row.kind) && (actor.role !== 'factory' || actor.factoryId === row.factoryId)
  return { supplierWorkRatesAvailable: workspace.supplierWorkRatesAvailable, supplierWorkRates: (workspace.supplierWorkRates || []).filter(visible), supplierWorkRateAudits: (workspace.supplierWorkRateAudits || []).filter(visible) }
}
export function saveSupplierWorkRateInWorkspace(workspace: SupplierWorkspace, supplied: Profile, factoryId: string, kind: ProcessingPriceKind, itemKey: string, unitCost: number | null, expectedVersion: number, reason: string): SupplierWorkspace {
  const actor = actorFor(workspace, supplied); supplierFor(workspace, actor, factoryId, kind)
  validateOperationReason(reason); validateProcessingUnitCost(unitCost); checkRateItem(workspace, factoryId, kind, itemKey)
  checkVersion(findSupplierWorkRate(workspace, factoryId, kind, itemKey), expectedVersion)
  const next = structuredClone(workspace); putRate(next, actor, factoryId, kind, itemKey, unitCost, reason); return next
}
export function saveSupplierWorkItemInWorkspace(workspace: SupplierWorkspace, supplied: Profile, id: string, factoryId: string, kind: StyleOperationKind, data: SupplierWorkItemInput, catalogVersion: number, rateVersion: number, reason: string): SupplierWorkspace {
  const actor = actorFor(workspace, supplied); supplierFor(workspace, actor, factoryId, kind)
  validateOperationReason(reason); validateProcessingUnitCost(data.unitCost)
  if (!id || !['label', 'embroidery'].includes(kind) || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 120 || badControl.test(data.name) || typeof data.specification !== 'string' || data.specification.length > 1000 || badControl.test(data.specification) || typeof data.active !== 'boolean') throw new Error('작업명·기본 규격·사용 여부를 확인해 주세요.')
  const before = workspace.operations?.operationCatalogs.find(item => item.id === id) as SupplierCatalog | undefined
  if (before && (before.kind !== kind || before.supplierFactoryId !== factoryId)) throw new Error('기존 작업의 업체·업무 구분은 변경할 수 없습니다.')
  checkVersion(before, catalogVersion); checkVersion(findSupplierWorkRate(workspace, factoryId, kind, id), rateVersion)
  if (workspace.operations?.operationCatalogs.some(item => item.id !== id && item.kind === kind && (item as SupplierCatalog).supplierFactoryId === factoryId && item.name.trim().toLocaleLowerCase() === data.name.trim().toLocaleLowerCase())) throw new Error('이 업체에 같은 작업명이 이미 등록되어 있습니다.')
  const next = structuredClone(workspace), now = new Date().toISOString()
  if (!next.operations) throw new Error('작업 종류 설정을 먼저 불러와 주세요.')
  const after: SupplierCatalog = { id, kind, supplierFactoryId: factoryId, name: data.name.trim(), specification: data.specification.trim(), active: data.active, version: catalogVersion + 1, createdAt: before?.createdAt || now, updatedAt: now, updatedBy: actor.id }
  next.operations.operationCatalogs = [...next.operations.operationCatalogs.filter(item => item.id !== id), after]
  putRate(next, actor, factoryId, kind, id, data.unitCost, reason)
  return next
}

/** Existing manual quotes stay authoritative. Selecting a fresh work row takes
 * a private snapshot of the supplier's current default; master edits do not
 * traverse or recalculate any already stored style or financial record. */
export function saveStyleOperationWithSupplierInWorkspace(workspace: SupplierWorkspace, supplied: Profile, id: string, styleId: string, kind: StyleOperationKind, factoryId: string | null, expectedVersion: number, data: StyleOperationInput, reason: string, catalogVersions: Record<string, number> = {}): SupplierWorkspace {
  const actor = actorFor(workspace, supplied)
  if (actor.role === 'factory') throw new Error('스타일 작업 배정은 본사에서 관리합니다.')
  const style = workspace.styles.find(item => item.id === styleId && canViewStyle(actor, item))
  if (!style) throw new Error('접근 가능한 스타일을 선택해 주세요.')
  if (factoryId) supplierFor(workspace, actor, factoryId, kind)
  const before = workspace.operations?.styleOperations.find(record => record.id === id)
  const oldSupplier = (before as { supplierFactoryId?: string | null } | undefined)?.supplierFactoryId || null
  const freshRows = new Set<string>()
  for (const row of data.rows) {
    const catalog = workspace.operations?.operationCatalogs.find(item => item.id === row.catalogId) as SupplierCatalog | undefined
    if (!catalog || catalog.kind !== kind || (catalog.supplierFactoryId || null) !== factoryId) throw new Error('선택한 업체에 등록된 작업 종류만 배정할 수 있습니다.')
    const old = before?.rows.find(item => item.id === row.id && item.catalogId === row.catalogId)
    const fresh = !old || oldSupplier !== factoryId
    if (fresh) freshRows.add(row.id)
    if (factoryId && fresh && (catalogVersions[catalog.id] !== catalog.version || row.name !== catalog.name)) throw new Error('VERSION_CONFLICT: 작업 종류의 이름·규격이 변경되었습니다. 최신 작업을 다시 선택해 주세요.')
    if ((factoryId || oldSupplier) && fresh && style.production.some(line => !!findProcessingUnitPrice(workspace, styleId, line.id, kind, row.id))) throw new Error('SUPPLIER_PRICE_SCOPE_CHANGED: 이전 단가를 보존하려면 새 작업 행으로 등록해 주세요.')
  }
  const next = saveOperationInWorkspace(workspace, actor, id, styleId, kind, { rows: data.rows, note: data.note, voided: data.voided }, expectedVersion, reason) as SupplierWorkspace
  const record = next.operations!.styleOperations.find(item => item.id === id)!
  ;(record as { supplierFactoryId?: string | null }).supplierFactoryId = factoryId
  ;(record as { supplierNameSnapshot?: string }).supplierNameSnapshot = factoryId ? oldSupplier === factoryId && (before as { supplierNameSnapshot?: string } | undefined)?.supplierNameSnapshot || workspace.factories.find(factory => factory.id === factoryId)!.name : ''
  record.rows = record.rows.map(row => {
    const old = before?.rows.find(item => item.id === row.id && item.catalogId === row.catalogId)
    return old && oldSupplier === factoryId ? { ...row, name: old.name } : row
  })
  const audit = next.audits.find(item => item.styleId === styleId && (item.after as { id?: string })?.id === id)
  if (audit) audit.after = structuredClone(record)
  if (factoryId && !data.voided) for (const row of record.rows.filter(row => freshRows.has(row.id))) {
    const rate = findSupplierWorkRate(next, factoryId, kind, row.catalogId)
    if (!rate) continue
    for (const line of style.production) {
      if (['done', 'approved'].includes(line.paymentStatus)) continue
      if (findProcessingUnitPrice(next, styleId, line.id, kind, row.id)) continue
      const now = new Date().toISOString()
      const price: SupplierPrice = { styleId, lineId: line.id, kind, itemKey: row.id, unitCost: rate.unitCost, supplierFactoryId: factoryId, supplierNameSnapshot: (record as { supplierNameSnapshot?: string }).supplierNameSnapshot || '', supplierCatalogId: row.catalogId, masterRateVersion: rate.version, version: 1, createdAt: now, updatedAt: now, updatedBy: actor.id }
      next.processingUnitPrices = [...(next.processingUnitPrices || []), price]
    }
  }
  return next
}

export function applySupplierQualityRateInWorkspace(workspace: SupplierWorkspace, supplied: Profile, styleId: string, lineId: string, factoryId: string, category: string, assignmentVersion: number, priceVersion: number, reason: string): SupplierWorkspace {
  const actor = actorFor(workspace, supplied)
  if (actor.role === 'factory') throw new Error('검사 업체의 스타일 단가 적용은 본사에서 관리합니다.')
  const factory = supplierFor(workspace, actor, factoryId, 'quality')
  const style = workspace.styles.find(item => item.id === styleId && canViewStyle(actor, item)), line = style?.production.find(item => item.id === lineId)
  if (!style || !line) throw new Error('저장된 스타일·컬러를 선택해 주세요.')
  validateOperationReason(reason); checkRateItem(workspace, factoryId, 'quality', category)
  const assignments = (workspace as Workspace & { inspectionAssignments?: { styleId: string; lineId: string; provider: string | null; version: number }[] }).inspectionAssignments || []
  const assignment = assignments.find(item => item.styleId === styleId && item.lineId === lineId)
  if (!assignment || assignment.version !== assignmentVersion || assignment.provider !== factory.inspectionProvider) throw new Error('VERSION_CONFLICT: 검사 업체 배정이 변경되었습니다. 최신 배정을 확인해 주세요.')
  if (!workspace.productionDetails?.some(item => item.styleId === styleId && item.lineId === lineId && item.quality.category === category)) throw new Error('저장된 검사 품목을 먼저 선택해 주세요.')
  const before = findProcessingUnitPrice(workspace, styleId, lineId, 'quality', category) as SupplierPrice | undefined
  checkVersion(before, priceVersion)
  if (before?.supplierFactoryId === factoryId) return structuredClone(workspace)
  if (['done', 'approved'].includes(line.paymentStatus)) throw new Error('HISTORY_PROTECTED: 결제 마감된 검사 단가는 변경할 수 없습니다.')
  const rate = findSupplierWorkRate(workspace, factoryId, 'quality', category)
  if (!rate) throw new Error('선택한 검사 업체의 품목별 기본 단가를 먼저 등록해 주세요.')
  const next = structuredClone(workspace), now = new Date().toISOString()
  const after: SupplierPrice = { styleId, lineId, kind: 'quality', itemKey: category, unitCost: rate.unitCost, supplierFactoryId: factoryId, supplierNameSnapshot: factory.name, masterRateVersion: rate.version, version: priceVersion + 1, createdAt: before?.createdAt || now, updatedAt: now, updatedBy: actor.id }
  next.processingUnitPrices = [...(next.processingUnitPrices || []).filter(row => !(row.styleId === styleId && row.lineId === lineId && row.kind === 'quality' && row.itemKey === category)), after]
  next.audits.unshift({ id: crypto.randomUUID(), styleId, actorId: actor.id, actorName: actor.name, action: '검사 업체 기본 단가 적용', reason: '검사 업체 기본 단가 적용', before: before ? { styleId, lineId, version: before.version, supplierFactoryId: before.supplierFactoryId || null } : null, after: { styleId, lineId, version: after.version, supplierFactoryId: factoryId }, createdAt: now })
  return next
}
