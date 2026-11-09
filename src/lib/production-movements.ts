import { SIZES, emptyQuantities, quantityTotal, type Profile, type Style, type Workspace } from './types'
import { assertProductionAccess, assertStyleSave, canViewStyle } from './permissions'
import { assertManagedShipmentTotals, freshOperations, shipmentTotals, validateOperationDate, validateOperationReason } from './operations-domain'
import { allocateProductionReceiptInWorkspace, assertProductionLedgerTotals, validateRunQuantities } from './production-ledger'
import { assertProductionRunStarted } from './supplier-orders'
import { applyFactoryOwnerDefaults } from './factory-owner-defaults'
import type { ConfirmMainProductionReceiptRequest, ConfirmMainProductionReceiptResult, ProductionMovementFields } from './production-movements-types'

type MovementWorkspace = Workspace & ProductionMovementFields
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sameQuantities = (a: Style['production'][number]['shipped'], b: Style['production'][number]['shipped']) => SIZES.every(size => a[size] === b[size])
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function actor(workspace: MovementWorkspace, supplied: Profile): Profile {
  const person = workspace.profiles.find(item => item.id === supplied.id)
  if (!person || person.withdrawnAt) throw new Error('현재 계정을 확인해 주세요.')
  assertProductionAccess(person)
  if (person.role === 'factory' && workspace.factories.some(factory => factory.id === person.factoryId && factory.serviceType === 'inspection')) throw new Error('검사 업체는 생산 출입고를 수정할 수 없습니다.')
  return person
}
function available(workspace: MovementWorkspace) {
  if (workspace.mainProductionSyncAvailable !== true) throw new Error('메인 생산 출입고 연동 설정이 필요합니다. 설정 적용 후 다시 접속해 주세요.')
}
function cloneSavedStyle(workspace: MovementWorkspace, person: Profile, input: Style, reason: string, confirmedLineId?: string): MovementWorkspace {
  const style = person.role === 'factory' ? input : applyFactoryOwnerDefaults(workspace, input)
  available(workspace); validateOperationReason(reason)
  if (!uuid.test(style.id) || !Number.isSafeInteger(style.version) || style.version < 0) throw new Error('스타일 식별자와 저장 버전을 확인해 주세요.')
  const before = workspace.styles.find(item => item.id === style.id)
  if ((before?.version || 0) !== style.version) throw new Error('VERSION_CONFLICT: 다른 사용자가 스타일을 먼저 수정했습니다.')
  assertStyleSave(person, before, style, reason)
  if (workspace.styles.some(item => item.id !== style.id && !item.deletedAt && item.code.toLocaleLowerCase() === style.code.toLocaleLowerCase())) throw new Error('같은 스타일 코드가 이미 있습니다.')
  for (const line of style.production) {
    const old = before?.production.find(item => item.id === line.id)
    if (!old) continue
    const changedReceipt = !sameQuantities(old.received, line.received) || old.receivedAt !== line.receivedAt
    if (changedReceipt && confirmedLineId && line.id !== confirmedLineId) throw new Error('다른 컬러의 실입고는 해당 컬러에서 각각 입고 확정해 주세요.')
    if (changedReceipt && workspace.productionRuns?.some(run => run.styleId === style.id && run.lineId === line.id) && line.id !== confirmedLineId) throw new Error('RECEIPT_CONFIRMATION_REQUIRED: 실입고 수량과 일자는 메인 생산의 입고 확정으로 저장해 주세요.')
    if (changedReceipt && line.id === confirmedLineId) {
      for (const size of SIZES) {
        const allocated = (workspace.productionReceipts || []).filter(receipt => receipt.styleId === style.id && receipt.lineId === line.id && !receipt.voided).reduce((total, receipt) => total + receipt.quantities[size], 0)
        if (line.received[size] < allocated) throw new Error('입고 확정 수량을 기존 차수별 실입고보다 줄일 수 없습니다. 입고 내역을 먼저 확인해 주세요.')
      }
    }
  }
  const next = structuredClone(workspace), now = new Date().toISOString()
  next.operations = freshOperations(next.operations)
  for (const line of style.production) {
    const old = before?.production.find(item => item.id === line.id)
    if (!old || sameQuantities(old.shipped, line.shipped) && old.shippedAt === line.shippedAt) continue
    if (person.role !== 'admin' && person.role !== 'factory') throw new Error('출고 수량은 관리자 또는 배정된 공장만 입력할 수 있습니다.')
    validateOperationDate(line.shippedAt, quantityTotal(line.shipped) > 0)
    if (!next.operations.shipmentLedgers.some(ledger => ledger.styleId === style.id && ledger.lineId === line.id)) next.operations.shipmentLedgers.push({ styleId: style.id, lineId: line.id, baselineQuantities: { ...old.shipped }, baselineDate: old.shippedAt, createdAt: now, createdBy: person.id })
    const current = shipmentTotals(next, style.id, line.id)!
    const delta = emptyQuantities()
    for (const size of SIZES) delta[size] = line.shipped[size] - current.quantities[size]
    const lastStamp = Math.max(0, ...(next.shipmentAdjustments || []).filter(item => item.styleId === style.id && item.lineId === line.id).map(item => Date.parse(item.createdAt) || 0))
    const createdAt = new Date(Math.max(Date.now(), lastStamp + 1)).toISOString()
    next.shipmentAdjustments = [...(next.shipmentAdjustments || []), { id: crypto.randomUUID(), styleId: style.id, lineId: line.id, delta, shippedAt: line.shippedAt, createdAt, createdBy: person.id, reason: reason.trim() }]
  }
  assertManagedShipmentTotals(next, style)
  assertProductionLedgerTotals(next, style)
  const samples = style.samples.map(sample => {
    const old = before?.samples.find(item => item.id === sample.id)
    const changed = !old || canonical({ ...old, updatedAt: '' }) !== canonical({ ...sample, updatedAt: '' })
    return { ...sample, updatedAt: changed ? now : old!.updatedAt }
  })
  const after: Style = { ...structuredClone(style), samples, version: style.version + 1, updatedAt: now, updatedBy: person.id, deletedAt: null }
  next.styles = before ? next.styles.map(item => item.id === style.id ? after : item) : [after, ...next.styles]
  next.audits.unshift({ id: crypto.randomUUID(), styleId: style.id, actorId: person.id, actorName: person.name, action: before ? '메인 생산 수량·스타일 저장' : '스타일 등록', reason: reason.trim(), before: before ? structuredClone(before) : null, after: structuredClone(after), createdAt: now })
  return next
}

/** Uses the supplied profile ID only: current workspace identity grants rights. */
export function saveMainProductionStyleInWorkspace(workspace: MovementWorkspace, supplied: Profile, style: Style, reason: string): MovementWorkspace {
  return cloneSavedStyle(workspace, actor(workspace, supplied), style, reason)
}

/** Main production receives cumulative totals once. Only the unallocated delta
 * becomes a receipt, preserving the existing run price and finalized history. */
export function confirmMainProductionReceiptInWorkspace(workspace: MovementWorkspace, supplied: Profile, request: ConfirmMainProductionReceiptRequest, reason: string): { workspace: MovementWorkspace; result: ConfirmMainProductionReceiptResult } {
  const person = actor(workspace, supplied)
  if (person.role !== 'admin') throw new Error('입고 확정은 관리자만 가능합니다.')
  available(workspace); validateOperationReason(reason)
  const fields = ['requestId', 'styleId', 'lineId', 'runId', 'expectedStyleVersion', 'expectedRunVersion', 'style']
  if (!request || Object.keys(request).length !== fields.length || !fields.every(key => Object.hasOwn(request, key)) || ![request.requestId, request.styleId, request.lineId, request.runId].every(value => typeof value === 'string' && uuid.test(value)) || !Number.isSafeInteger(request.expectedStyleVersion) || request.expectedStyleVersion < 1 || !Number.isSafeInteger(request.expectedRunVersion) || request.expectedRunVersion < 1 || !request.style || request.style.id !== request.styleId || request.style.version !== request.expectedStyleVersion) throw new Error('입고 확정 대상과 저장 버전을 확인해 주세요.')
  const signature = canonical({ request, reason: reason.trim() })
  const retry = workspace.productionMovementRequests?.find(item => item.requestId === request.requestId)
  if (retry) {
    if (retry.actorId !== person.id || retry.signature !== signature) throw new Error('VERSION_CONFLICT: 같은 입고 요청 ID를 다른 내용으로 다시 사용할 수 없습니다.')
    return { workspace, result: structuredClone(retry.result) }
  }
  const before = workspace.styles.find(style => style.id === request.styleId && canViewStyle(person, style))
  if (!before || !before.production.some(line => line.id === request.lineId)) throw new Error('접근 가능한 스타일과 생산 컬러를 확인해 주세요.')
  if (before.version !== request.expectedStyleVersion) throw new Error('VERSION_CONFLICT: 스타일이 변경되었습니다.')
  const run = workspace.productionRuns?.find(item => item.id === request.runId && item.styleId === request.styleId && item.lineId === request.lineId)
  if (!run || run.closedAt) throw new Error('입고할 수 있는 미마감 생산 차수를 선택해 주세요.')
  if (run.version !== request.expectedRunVersion) throw new Error('VERSION_CONFLICT: 생산 차수가 변경되었습니다.')
  assertProductionRunStarted(workspace, run.id)
  if (run.unitCost === null || !run.projectCode.trim()) throw new Error('최종 승인 단가와 생산 차수의 예산 관리 코드를 확인해 주세요.')
  const target = request.style.production.find(line => line.id === request.lineId)
  if (!target) throw new Error('입고할 생산 컬러를 확인해 주세요.')
  validateRunQuantities(target.received); validateOperationDate(target.receivedAt, true)
  const added = emptyQuantities()
  for (const size of SIZES) {
    const total = (workspace.productionReceipts || []).filter(receipt => receipt.styleId === request.styleId && receipt.lineId === request.lineId && !receipt.voided).reduce((sum, receipt) => sum + receipt.quantities[size], 0)
    added[size] = target.received[size] - total
    if (added[size] < 0) throw new Error('입고 수량이 차수별로 이미 기록된 수량보다 적습니다. 기존 입고 내역을 먼저 확인해 주세요.')
  }
  let next = workspace
  const receiptId = quantityTotal(added) > 0 ? request.requestId : null
  if (receiptId) next = allocateProductionReceiptInWorkspace(next, person, receiptId, request.runId, { receivedAt: target.receivedAt, quantities: added }, request.expectedRunVersion, reason)
  next = cloneSavedStyle(next, person, request.style, reason, request.lineId)
  const result: ConfirmMainProductionReceiptResult = { style: structuredClone(next.styles.find(style => style.id === request.styleId)!), receiptId, added, runVersion: next.productionRuns!.find(item => item.id === request.runId)!.version }
  next.productionMovementRequests = [...(next.productionMovementRequests || []).slice(-99), { requestId: request.requestId, actorId: person.id, signature, result: structuredClone(result) }]
  return { workspace: next, result }
}

export function scopeProductionMovementsWorkspace(workspace: MovementWorkspace, supplied: Profile): ProductionMovementFields {
  const person = workspace.profiles.find(item => item.id === supplied.id)
  const allowed = !!person && person.approved && person.active && !person.withdrawnAt && ['admin', 'internal', 'factory'].includes(person.role)
  const visible = new Set(allowed ? workspace.styles.filter(style => canViewStyle(person!, style)).map(style => style.id) : [])
  return { mainProductionSyncAvailable: allowed && workspace.mainProductionSyncAvailable === true, shipmentAdjustments: (workspace.shipmentAdjustments || []).filter(item => visible.has(item.styleId)) }
}
