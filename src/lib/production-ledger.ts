import { SIZES, emptyQuantities, quantityTotal, type Profile, type Quantities, type Style, type Workspace } from './types'
import type { SettlementItemType } from './settlement-types'
import { assertActive, canViewStyle } from './permissions'
import { validateOperationReason } from './operations-domain'
import { assertAcceptedProductionTermsUnchanged, assertProductionRunStarted } from './supplier-orders'

export interface ProductionRunInput { name: string; projectId: string; projectCode: string; expectedDue: string; poId: string | null; unitCost: number | null; itemType: SettlementItemType; order: Quantities; correctsRunId: string | null }
export interface ProductionReceiptInput { receivedAt: string; quantities: Quantities }
export interface ProductionReceipt extends ProductionReceiptInput { id: string; runId: string; styleId: string; lineId: string; unitCost: number; netAmount: number; voided: boolean; version: number; createdAt: string; createdBy: string }
export interface ProductionRunIdentity { factoryIdSnapshot: string; ownerIdSnapshot: string; styleCodeSnapshot: string; factoryNameSnapshot: string; ownerNameSnapshot: string }
export interface ProductionSettlementSnapshot extends ProductionRunIdentity { projectId: string; projectCode: string; expectedDue: string; styleCode: string; factory: string; owner: string; name: string; round: number; poId: string | null; itemType: SettlementItemType; unitCost: number; orderQuantity: number; receivedQuantity: number; netAmount: number; vatAmount: number; grossAmount: number; lastReceivedAt: string; receipts: ProductionReceipt[]; finalizedAt: string; finalizedBy: string }
export interface ProductionRun extends ProductionRunInput, ProductionRunIdentity { id: string; styleId: string; lineId: string; round: number; version: number; createdAt: string; updatedAt: string; updatedBy: string; closedAt: string | null; snapshot: ProductionSettlementSnapshot | null }
export interface ProductionRunAudit { id: string; runId: string; styleId: string; lineId: string; actorId: string; actorName: string; action: string; reason: string; before: unknown; after: unknown; createdAt: string }
export interface ProductionLedgerFields { productionRuns?: ProductionRun[]; productionReceipts?: ProductionReceipt[]; productionRunAudits?: ProductionRunAudit[]; productionLedgerAvailable?: boolean }
export type ProductionLedgerWorkspace = Workspace & ProductionLedgerFields
export interface LineAllocation { ordered: Quantities; received: Quantities; availableOrder: Quantities; availableReceived: Quantities; inconsistent: boolean }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value)
const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const keys = (data: unknown, fields: string[]) => !!data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === fields.length && fields.every(key => Object.hasOwn(data, key))
function text(value: unknown, limit: number, required = false): value is string { return typeof value === 'string' && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value) && (!required || !!value.trim()) }
export function validateRunQuantities(value: unknown): asserts value is Quantities {
  if (!keys(value, [...SIZES]) || !SIZES.every(size => Number.isSafeInteger((value as Quantities)[size]) && (value as Quantities)[size] >= 0 && (value as Quantities)[size] <= 10_000_000)) throw new Error('XXS~XL 수량은 0~10,000,000의 정수여야 합니다.')
}
export function validateProductionRunInput(data: ProductionRunInput): void {
  if (!keys(data, ['name', 'projectId', 'projectCode', 'expectedDue', 'poId', 'unitCost', 'itemType', 'order', 'correctsRunId']) || !text(data.name, 120, true) || !isUuid(data.projectId) || !text(data.projectCode, 120) || !text(data.expectedDue, 10) || !!data.expectedDue && !date(data.expectedDue) || !['product', 'fabric', 'label'].includes(data.itemType) || data.poId !== null && !isUuid(data.poId) || data.correctsRunId !== null && !isUuid(data.correctsRunId)) throw new Error('생산 차수명·프로젝트·품목·PO를 확인해 주세요.')
  if (data.unitCost !== null && (typeof data.unitCost !== 'number' || !Number.isFinite(data.unitCost) || data.unitCost < 0 || data.unitCost > 1_000_000_000 || !/^\d+(?:\.\d{1,2})?$/.test(String(data.unitCost)))) throw new Error('차수 단가는 미기재 또는 0~1,000,000,000의 소수 둘째 자리까지 입력해 주세요.')
  validateRunQuantities(data.order)
}
export function productionAmounts(unitCost: number, quantity: number) {
  validateProductionRunInput({ name: '계산', projectId: '00000000-0000-4000-8000-000000000000', projectCode: '', expectedDue: '', poId: null, unitCost, itemType: 'product', order: emptyQuantities(), correctsRunId: null })
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 60_000_000) throw new Error('정산 수량을 확인해 주세요.')
  const cents = BigInt(Math.round(unitCost * 100)) * BigInt(quantity)
  if (cents > 100_000_000_000_000n) throw new Error('한 생산 차수의 금액은 1조 원 이하여야 합니다.')
  return { netAmount: Number(cents) / 100, vatAmount: Number(cents) / 1000, grossAmount: Number(cents * 11n) / 1000 }
}
export function getLineAllocation(workspace: ProductionLedgerWorkspace, styleId: string, lineId: string): LineAllocation {
  const ordered = emptyQuantities(), received = emptyQuantities(), availableOrder = emptyQuantities(), availableReceived = emptyQuantities()
  for (const run of workspace.productionRuns || []) if (run.styleId === styleId && run.lineId === lineId) for (const size of SIZES) ordered[size] += run.order[size]
  for (const receipt of workspace.productionReceipts || []) if (receipt.styleId === styleId && receipt.lineId === lineId && !receipt.voided) for (const size of SIZES) received[size] += receipt.quantities[size]
  for (const size of SIZES) availableOrder[size] = ordered[size] - received[size]
  return { ordered, received, availableOrder, availableReceived, inconsistent: SIZES.some(size => availableOrder[size] < 0) }
}
export function scopeProductionLedgerWorkspace(workspace: ProductionLedgerWorkspace, profile: Profile): ProductionLedgerFields {
  if (!profile.approved || !profile.active || profile.role === 'factory') return { productionRuns: [], productionReceipts: [], productionRunAudits: [], productionLedgerAvailable: workspace.productionLedgerAvailable }
  const ids = new Set(workspace.styles.filter(style => canViewStyle(profile, style)).map(style => style.id))
  return { productionRuns: (workspace.productionRuns || []).filter(run => ids.has(run.styleId)), productionReceipts: (workspace.productionReceipts || []).filter(receipt => ids.has(receipt.styleId)), productionRunAudits: (workspace.productionRunAudits || []).filter(audit => ids.has(audit.styleId)), productionLedgerAvailable: workspace.productionLedgerAvailable }
}
function actor(workspace: ProductionLedgerWorkspace, supplied: Profile): Profile { const person = workspace.profiles.find(profile => profile.id === supplied.id); if (!person) throw new Error('계정을 확인해 주세요.'); assertActive(person); if (person.role === 'factory') throw new Error('생산 차수별 단가·정산은 본사 전용입니다.'); return person }
function parent(workspace: ProductionLedgerWorkspace, person: Profile, styleId: string, lineId: string): Style { const style = workspace.styles.find(style => style.id === styleId && canViewStyle(person, style)); if (!style || !style.production.some(line => line.id === lineId)) throw new Error('접근 가능한 생산 컬러를 확인해 주세요.'); return style }
function openRun(workspace: ProductionLedgerWorkspace, runId: string, version: number): ProductionRun { const run = workspace.productionRuns?.find(run => run.id === runId); if (!run) throw new Error('생산 차수를 확인해 주세요.'); if (!Number.isSafeInteger(version) || version < 1 || run.version !== version) throw new Error('VERSION_CONFLICT'); if (run.closedAt) throw new Error('마감 확정된 생산 차수는 수정할 수 없습니다.'); return run }
function audit(workspace: ProductionLedgerWorkspace, person: Profile, run: ProductionRun, action: string, reason: string, before: unknown, after: unknown) {
  const now = new Date().toISOString()
  workspace.productionRunAudits = [{ id: crypto.randomUUID(), runId: run.id, styleId: run.styleId, lineId: run.lineId, actorId: person.id, actorName: person.name, action, reason: reason.trim(), before, after, createdAt: now }, ...(workspace.productionRunAudits || [])]
  workspace.audits.unshift({ id: crypto.randomUUID(), styleId: run.styleId, actorId: person.id, actorName: person.name, action, reason: '본사 전용 생산 차수 정산 변경', before: null, after: { runId: run.id, version: run.version }, createdAt: now })
}
function assertAllocations(workspace: ProductionLedgerWorkspace, styleId: string, lineId: string) { if (getLineAllocation(workspace, styleId, lineId).inconsistent) throw new Error('생산 차수의 오더보다 실입고 수량이 많습니다.') }
/** Guards parent quantity edits without rewriting historical run receipts or snapshots. */
export function assertProductionLedgerTotals(workspace: ProductionLedgerWorkspace, style: Style): void {
  const next = { ...workspace, styles: [...workspace.styles.filter(item => item.id !== style.id), style] }
  for (const run of workspace.productionRuns || []) if (run.styleId === style.id) { if (!style.production.some(line => line.id === run.lineId)) throw new Error('생산 차수에 연결된 컬러를 제거할 수 없습니다.'); assertAllocations(next, style.id, run.lineId) }
}
export function saveProductionRunInWorkspace(workspace: ProductionLedgerWorkspace, supplied: Profile, id: string, styleId: string, lineId: string, data: ProductionRunInput, expectedVersion: number, reason: string): ProductionLedgerWorkspace {
  const person = actor(workspace, supplied), style = parent(workspace, person, styleId, lineId); validateOperationReason(reason); validateProductionRunInput(data)
  const project = workspace.projects.find(item => item.id === data.projectId)
  if (!project || project.code?.trim() && project.code.trim() !== data.projectCode.trim()) throw new Error('등록된 프로젝트와 프로젝트 코드를 확인해 주세요.')
  if (!isUuid(id) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('생산 차수 버전을 확인해 주세요.')
  const prior = workspace.productionRuns?.find(run => run.id === id)
  if ((prior?.version || 0) !== expectedVersion) throw new Error('VERSION_CONFLICT')
  if (prior && (prior.closedAt || prior.styleId !== styleId || prior.lineId !== lineId)) throw new Error('마감 확정된 차수 또는 다른 생산 컬러는 수정할 수 없습니다.')
  const receipts = (workspace.productionReceipts || []).filter(receipt => receipt.runId === id && !receipt.voided)
  if (prior && data.projectId !== prior.projectId) throw new Error('차수의 프로젝트는 변경할 수 없습니다. 새 생산 차수를 만들어 주세요.')
  if (prior && receipts.length && (data.unitCost !== prior.unitCost || data.projectCode.trim() !== prior.projectCode || data.itemType !== prior.itemType || data.poId !== prior.poId || data.correctsRunId !== prior.correctsRunId)) throw new Error('실입고가 있는 차수의 단가·프로젝트·PO는 바꿀 수 없습니다. 새 생산 차수로 기록해 주세요.')
  const factoryId = prior?.factoryIdSnapshot || style.factoryId, ownerId = prior?.ownerIdSnapshot || style.ownerId
  if (data.poId && !workspace.operations?.poDispatches.some(po => po.id === data.poId && po.styleId === styleId && !po.voided && po.factoryIdSnapshot === factoryId)) throw new Error('같은 스타일·공장의 유효한 PO만 연결할 수 있습니다.')
  if (data.poId && workspace.productionRuns?.some(run => run.id !== id && run.lineId === lineId && run.poId === data.poId)) throw new Error('해당 컬러의 PO는 이미 다른 생산 차수에 연결되어 있습니다.')
  if (data.correctsRunId && !workspace.productionRuns?.some(run => run.id === data.correctsRunId && run.id !== id && run.styleId === styleId && run.lineId === lineId && run.projectId === data.projectId && !!run.closedAt)) throw new Error('같은 프로젝트·생산 컬러의 마감 확정 기록을 연결해 주세요.')
  for (const size of SIZES) if (receipts.reduce((sum, receipt) => sum + receipt.quantities[size], 0) > data.order[size]) throw new Error('차수 오더를 이미 배분한 입고 수량보다 줄일 수 없습니다.')
  const next = structuredClone(workspace), now = new Date().toISOString()
  const line = style.production.find(item => item.id === lineId)!, factoryName = workspace.factories.find(item => item.id === factoryId)?.name, ownerName = workspace.profiles.find(item => item.id === ownerId)?.name
  if (!factoryName?.trim() || !ownerName?.trim()) throw new Error('차수의 업체·담당자를 확인해 주세요.')
  if (data.unitCost !== null) productionAmounts(data.unitCost, quantityTotal(data.order))
  const fullCode = /^[A-Z0-9]{12}[A-Z]{2}$/.test(style.code) && style.code.endsWith(line.color) ? style.code : `${style.code}${line.color}`
  const run: ProductionRun = { ...structuredClone(data), factoryIdSnapshot: factoryId, ownerIdSnapshot: ownerId, styleCodeSnapshot: prior?.styleCodeSnapshot || fullCode, factoryNameSnapshot: prior?.factoryNameSnapshot || factoryName, ownerNameSnapshot: prior?.ownerNameSnapshot || ownerName, name: data.name.trim(), projectCode: data.projectCode.trim(), id, styleId, lineId, round: prior?.round || Math.max(0, ...(workspace.productionRuns || []).filter(run => run.styleId === styleId && run.lineId === lineId && run.projectId === data.projectId).map(run => run.round)) + 1, version: expectedVersion + 1, createdAt: prior?.createdAt || now, updatedAt: now, updatedBy: person.id, closedAt: null, snapshot: null }
  assertAcceptedProductionTermsUnchanged(workspace, prior, run)
  next.productionRuns = [...(next.productionRuns || []).filter(item => item.id !== id), run]
  assertAllocations(next, styleId, lineId); audit(next, person, run, '생산 차수 저장', reason, prior || null, run); return next
}
export function allocateProductionReceiptInWorkspace(workspace: ProductionLedgerWorkspace, supplied: Profile, id: string, runId: string, data: ProductionReceiptInput, expectedRunVersion: number, reason: string): ProductionLedgerWorkspace {
  const person = actor(workspace, supplied); if (person.role !== 'admin') throw new Error('실입고 수량 배분은 관리자만 가능합니다.'); validateOperationReason(reason)
  const run = openRun(workspace, runId, expectedRunVersion); parent(workspace, person, run.styleId, run.lineId)
  assertProductionRunStarted(workspace, runId)
  if (!isUuid(id) || workspace.productionReceipts?.some(receipt => receipt.id === id) || !keys(data, ['receivedAt', 'quantities']) || !text(data.receivedAt, 10, true) || !date(data.receivedAt)) throw new Error('입고 배분 식별자·일자를 확인해 주세요.')
  validateRunQuantities(data.quantities); if (!quantityTotal(data.quantities)) throw new Error('배분할 입고 수량을 입력해 주세요.'); if (run.unitCost === null || !run.projectCode.trim()) throw new Error('차수 단가와 프로젝트 코드를 먼저 입력해 주세요.')
  const prior = (workspace.productionReceipts || []).filter(receipt => receipt.runId === runId && !receipt.voided)
  for (const size of SIZES) if (prior.reduce((sum, receipt) => sum + receipt.quantities[size], 0) + data.quantities[size] > run.order[size]) throw new Error('입고 배분이 해당 생산 차수의 오더 수량을 초과합니다.')
  const next = structuredClone(workspace), now = new Date().toISOString(), amounts = productionAmounts(run.unitCost, quantityTotal(data.quantities))
  const receipt: ProductionReceipt = { ...structuredClone(data), id, runId, styleId: run.styleId, lineId: run.lineId, unitCost: run.unitCost, netAmount: amounts.netAmount, voided: false, version: 1, createdAt: now, createdBy: person.id }
  next.productionReceipts = [...(next.productionReceipts || []), receipt]
  const changed = { ...structuredClone(run), version: run.version + 1, updatedAt: now, updatedBy: person.id }; next.productionRuns = next.productionRuns!.map(item => item.id === runId ? changed : item)
  assertAllocations(next, run.styleId, run.lineId); audit(next, person, changed, '생산 차수 입고 배분', reason, null, receipt); return next
}
export function voidProductionReceiptInWorkspace(workspace: ProductionLedgerWorkspace, supplied: Profile, id: string, runId: string, expectedReceiptVersion: number, expectedRunVersion: number, reason: string): ProductionLedgerWorkspace {
  const person = actor(workspace, supplied); if (person.role !== 'admin') throw new Error('입고 배분 무효 처리는 관리자만 가능합니다.'); validateOperationReason(reason)
  const run = openRun(workspace, runId, expectedRunVersion); parent(workspace, person, run.styleId, run.lineId)
  const receipt = workspace.productionReceipts?.find(item => item.id === id && item.runId === runId)
  if (!receipt || receipt.voided || receipt.version !== expectedReceiptVersion) throw new Error('VERSION_CONFLICT')
  const next = structuredClone(workspace), now = new Date().toISOString(), after = { ...receipt, version: receipt.version + 1, voided: true }
  next.productionReceipts = next.productionReceipts!.map(item => item.id === id ? after : item)
  const changed = { ...run, version: run.version + 1, updatedAt: now, updatedBy: person.id }; next.productionRuns = next.productionRuns!.map(item => item.id === runId ? changed : item)
  audit(next, person, changed, '생산 입고 배분 무효', reason, receipt, after); return next
}
export function finalizeProductionRunInWorkspace(workspace: ProductionLedgerWorkspace, supplied: Profile, runId: string, expectedVersion: number, reason: string): ProductionLedgerWorkspace {
  const person = actor(workspace, supplied); validateOperationReason(reason); const run = openRun(workspace, runId, expectedVersion); parent(workspace, person, run.styleId, run.lineId)
  assertProductionRunStarted(workspace, runId)
  const receipts = (workspace.productionReceipts || []).filter(item => item.runId === runId && !item.voided)
  if (run.unitCost === null || !run.projectCode.trim() || !receipts.length) throw new Error('마감할 차수의 프로젝트·단가·입고 배분을 확인해 주세요.')
  assertAllocations(workspace, run.styleId, run.lineId)
  const receivedQuantity = receipts.reduce((sum, item) => sum + quantityTotal(item.quantities), 0), amounts = productionAmounts(run.unitCost, receivedQuantity)
  const factory = run.factoryNameSnapshot, owner = run.ownerNameSnapshot
  if (!factory?.trim() || !owner?.trim()) throw new Error('마감 시점의 업체·담당자를 확인해 주세요.')
  const now = new Date().toISOString()
  const snapshot: ProductionSettlementSnapshot = { projectId: run.projectId, projectCode: run.projectCode, expectedDue: run.expectedDue, factoryIdSnapshot: run.factoryIdSnapshot, ownerIdSnapshot: run.ownerIdSnapshot, styleCodeSnapshot: run.styleCodeSnapshot, factoryNameSnapshot: run.factoryNameSnapshot, ownerNameSnapshot: run.ownerNameSnapshot, styleCode: run.styleCodeSnapshot, factory, owner, name: run.name, round: run.round, poId: run.poId, itemType: run.itemType, unitCost: run.unitCost, orderQuantity: quantityTotal(run.order), receivedQuantity, ...amounts, lastReceivedAt: receipts.map(item => item.receivedAt).sort().at(-1)!, receipts: structuredClone(receipts), finalizedAt: now, finalizedBy: person.id }
  const next = structuredClone(workspace), closed = { ...structuredClone(run), version: run.version + 1, updatedAt: now, updatedBy: person.id, closedAt: now, snapshot }
  next.productionRuns = next.productionRuns!.map(item => item.id === runId ? closed : item)
  audit(next, person, closed, '생산 차수 마감 확정', reason, run, closed); return next
}
