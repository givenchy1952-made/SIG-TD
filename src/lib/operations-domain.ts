import { SIZES, emptyQuantities, quantityTotal, type Profile, type Quantities, type Style, type Workspace } from './types'
import { assertActive, assertStyleSave, canViewStyle } from './permissions'
import type { CalendarEvent, CalendarEventInput, OperationRow, OperationsWorkspace, OrderImportChange, OrderSourceData, OrderSourceRecord, PoDispatchInput, ShipmentBatchInput, StyleOperationInput, StyleOperationKind } from './operations-types'
import { EMPTY_OPERATIONS, ORDER_SOURCE_COLUMNS } from './operations-types'
import { validateLeave } from './workflow-refinements'

export function freshOperations(value?: Partial<OperationsWorkspace>): OperationsWorkspace {
  return Object.fromEntries(Object.keys(EMPTY_OPERATIONS).map(key => [key, [...(value?.[key as keyof OperationsWorkspace] || [])]])) as unknown as OperationsWorkspace
}
export function canReadCalendarEvent(event: CalendarEvent, profile: Profile): boolean {
  if (!profile.approved || !profile.active) return false
  if (event.kind === 'factory_holiday') return profile.role !== 'factory'
  if (event.kind === 'launch') return true
  if (event.kind !== 'personal_leave') return false
  return event.visibility === 'private' && event.ownerId === profile.id || event.visibility === 'hq' && profile.role !== 'factory'
}
function eventSnapshot(value: unknown): CalendarEvent | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  return { ...row, ownerId: row.ownerId ?? row.owner_id } as unknown as CalendarEvent
}
export function scopeOperations(workspace: Workspace, profile: Profile): OperationsWorkspace {
  const ops = freshOperations(workspace.operations)
  if (!profile.approved || !profile.active) return freshOperations()
  const ids = new Set(workspace.styles.filter(style => canViewStyle(profile, style)).map(style => style.id))
  const poDispatches = ops.poDispatches.filter(item => ids.has(item.styleId))
  const poIds = new Set(poDispatches.map(item => item.id))
  const events = ops.calendarEvents.filter(event => canReadCalendarEvent(event, profile))
  const eventIds = new Set(events.map(event => event.id))
  return {
    poDispatches, poDispatchAttempts: ops.poDispatchAttempts.filter(item => poIds.has(item.dispatchId)),
    shipmentLedgers: ops.shipmentLedgers.filter(item => ids.has(item.styleId)), shipmentBatches: ops.shipmentBatches.filter(item => ids.has(item.styleId)),
    styleOperations: ops.styleOperations.filter(item => ids.has(item.styleId)), calendarEvents: events,
    calendarEventAudits: ops.calendarEventAudits.filter(audit => eventIds.has(audit.eventId) && [audit.before, audit.after].every(snapshot => { const event = eventSnapshot(snapshot); return !event || canReadCalendarEvent(event, profile) })),
    employeeFactoryAssignments: profile.role === 'factory' ? [] : ops.employeeFactoryAssignments.filter(item => profile.role === 'admin' || item.employeeId === profile.id),
    operationCatalogs: profile.role === 'factory' ? [] : ops.operationCatalogs,
    orderSourceRecords: profile.role === 'factory' ? [] : ops.orderSourceRecords.filter(item => ids.has(item.styleId)),
  }
}
export function validateOperationDate(value: string, required = false): void {
  if (value === '' && !required) return
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error('유효한 날짜를 YYYY-MM-DD 형식으로 입력해 주세요.')
}
export function validateOperationReason(reason: string): void { if (reason.trim().length < 2 || reason.trim().length > 1000) throw new Error('변경 사유를 2~1,000자로 입력해 주세요.') }
export function validateOperationQuantities(quantities: Quantities): void {
  if (!quantities || Object.keys(quantities).length !== SIZES.length || SIZES.some(size => !Number.isSafeInteger(quantities[size]) || quantities[size] < 0 || quantities[size] > 10000000)) throw new Error('XXS~XL 수량은 각각 0~10,000,000 사이의 정수여야 합니다.')
}
function actorFor(workspace: Workspace, supplied: Profile): Profile {
  const actor = workspace.profiles.find(item => item.id === supplied.id)
  if (!actor) throw new Error('사용자 계정을 확인할 수 없습니다.')
  assertActive(actor); return actor
}
function hqActor(workspace: Workspace, supplied: Profile): Profile { const actor = actorFor(workspace, supplied); if (actor.role === 'factory') throw new Error('관리자·본사 직원만 변경할 수 있습니다.'); return actor }
function existingStyle(workspace: Workspace, id: string, actor: Profile): Style { const style = workspace.styles.find(item => item.id === id); if (!style || !canViewStyle(actor, style)) throw new Error('이 스타일에 접근할 수 없습니다.'); return style }
function checkVersion(before: { version: number } | undefined, expected: number): void { if (!Number.isSafeInteger(expected) || expected < 0 || (before?.version || 0) !== expected) throw new Error('VERSION_CONFLICT: 다른 사용자가 먼저 수정했습니다. 최신 내용을 확인해 주세요.') }
function stamp(before: { version: number; createdAt: string } | undefined, actor: Profile) { const now = new Date().toISOString(); return { version: (before?.version || 0) + 1, createdAt: before?.createdAt || now, updatedAt: now, updatedBy: actor.id } }
function start(workspace: Workspace, reason: string): Workspace { validateOperationReason(reason); const next = structuredClone(workspace); next.operations = freshOperations(next.operations); next.operationsAvailable = true; return next }
function audit(next: Workspace, styleId: string | null, actor: Profile, action: string, reason: string, before: unknown, after: unknown): void { next.audits.unshift({ id: crypto.randomUUID(), styleId, actorId: actor.id, actorName: actor.name, action, reason: reason.trim(), before: before ?? null, after, createdAt: new Date().toISOString() }) }
function replace<T>(items: T[], next: T, same: (value: T) => boolean): T[] { return [...items.filter(item => !same(item)), next] }
const quantityKeys = ['unset', 'todo', 'progress', 'done', 'approved', 'delayed']

export function savePoInWorkspace(workspace: Workspace, profile: Profile, id: string, styleId: string, data: PoDispatchInput, expected: number, reason: string): Workspace {
  const actor = hqActor(workspace, profile), style = existingStyle(workspace, styleId, actor)
  const next = start(workspace, reason), ops = next.operations!
  const before = ops.poDispatches.find(item => item.id === id); checkVersion(before, expected)
  if (before && (before.styleId !== styleId || before.status !== 'draft' || before.attempts > 0)) throw new Error('발송을 시도한 PO 내용은 수정할 수 없습니다. 새 PO를 작성해 주세요.')
  validateOperationDate(data.dueDate, true)
  if (!/^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.test(data.recipient) || !data.subject.trim() || data.subject.length > 500 || /[\r\n]/.test(data.subject) || !data.body.trim() || data.body.length > 20000) throw new Error('수신 이메일·제목·본문과 납기일을 확인해 주세요.')
  if (data.evidenceAttachmentId && !next.attachments.some(file => file.id === data.evidenceAttachmentId && file.styleId === styleId)) throw new Error('이 스타일의 첨부파일만 근거자료로 연결할 수 있습니다.')
  const after = { id, styleId, dueDate: data.dueDate, recipient: data.recipient.trim(), subject: data.subject.trim(), body: data.body, evidenceAttachmentId: data.evidenceAttachmentId, voided: !!data.voided, status: 'draft' as const, sentAt: '', providerMessageId: null, lastError: null, attempts: 0, idempotencyKey: `sig-po-${id}`, factoryIdSnapshot: style.factoryId, styleCodeSnapshot: style.code, ...stamp(before, actor) }
  ops.poDispatches = replace(ops.poDispatches, after, item => item.id === id); audit(next, styleId, actor, 'PO 초안 저장', reason, before, after); return next
}

export function shipmentTotals(workspace: Workspace, styleId: string, lineId: string): { quantities: Quantities; date: string } | null {
  const ops = freshOperations(workspace.operations), ledger = ops.shipmentLedgers.find(item => item.styleId === styleId && item.lineId === lineId)
  if (!ledger) return null
  const quantities = { ...ledger.baselineQuantities }, dates = [ledger.baselineDate]
  for (const batch of ops.shipmentBatches.filter(item => item.styleId === styleId && item.lineId === lineId && !item.voided)) { for (const size of SIZES) quantities[size] += batch.quantities[size]; dates.push(batch.shippedAt) }
  validateOperationQuantities(quantities); return { quantities, date: dates.filter(Boolean).sort().at(-1) || '' }
}
export function assertManagedShipmentTotals(workspace: Workspace, style: Style): void {
  for (const line of style.production) { const total = shipmentTotals(workspace, style.id, line.id); if (total && (SIZES.some(size => total.quantities[size] !== line.shipped[size]) || total.date !== line.shippedAt)) throw new Error('차수별 출고가 등록된 수량·출고일은 발주·출고·가공의 부분 출고에서 수정해 주세요.') }
}
export function saveShipmentInWorkspace(workspace: Workspace, profile: Profile, id: string, styleId: string, lineId: string, data: ShipmentBatchInput, expected: number, expectedStyleVersion: number, reason: string): Workspace {
  const actor = actorFor(workspace, profile), style = existingStyle(workspace, styleId, actor)
  if (actor.role === 'internal') throw new Error('출고 수량은 관리자 또는 배정된 공장만 입력할 수 있습니다.')
  checkVersion(style, expectedStyleVersion)
  const line = style.production.find(item => item.id === lineId); if (!line) throw new Error('저장된 생산 컬러를 선택해 주세요.')
  const next = start(workspace, reason), ops = next.operations!, before = ops.shipmentBatches.find(item => item.id === id); checkVersion(before, expected)
  if (before && (before.styleId !== styleId || before.lineId !== lineId)) throw new Error('기존 출고의 스타일·컬러는 변경할 수 없습니다.')
  if ((data.voided || before?.voided) && actor.role !== 'admin') throw new Error('출고 취소·복원은 관리자만 처리할 수 있습니다.')
  validateOperationDate(data.shippedAt, true); validateOperationQuantities(data.quantities)
  if (!data.voided && quantityTotal(data.quantities) <= 0) throw new Error('출고 수량을 한 개 이상 입력해 주세요.')
  if (data.tracking.length > 200 || data.note.length > 10000) throw new Error('운송장 번호·메모 길이를 확인해 주세요.')
  if (!ops.shipmentLedgers.some(item => item.styleId === styleId && item.lineId === lineId)) ops.shipmentLedgers.push({ styleId, lineId, baselineQuantities: { ...line.shipped }, baselineDate: line.shippedAt, createdAt: new Date().toISOString(), createdBy: actor.id })
  const round = before?.round || Math.max(0, ...ops.shipmentBatches.filter(item => item.styleId === styleId && item.lineId === lineId).map(item => item.round)) + 1
  const after = { id, styleId, lineId, round, shippedAt: data.shippedAt, quantities: { ...data.quantities }, tracking: data.tracking, note: data.note, voided: !!data.voided, ...stamp(before, actor) }
  ops.shipmentBatches = replace(ops.shipmentBatches, after, item => item.id === id)
  const totals = shipmentTotals(next, styleId, lineId)!
  const updated = { ...next.styles.find(item => item.id === styleId)!, version: style.version + 1, updatedAt: after.updatedAt, updatedBy: actor.id }
  updated.production = updated.production.map(item => item.id === lineId ? { ...item, shipped: totals.quantities, shippedAt: totals.date } : item)
  next.styles = replace(next.styles, updated, item => item.id === styleId)
  audit(next, styleId, actor, `${round}차 출고 ${before ? '수정' : '등록'}`, reason, before, after); return next
}

export function saveOperationInWorkspace(workspace: Workspace, profile: Profile, id: string, styleId: string, kind: StyleOperationKind, data: StyleOperationInput, expected: number, reason: string): Workspace {
  const actor = hqActor(workspace, profile); existingStyle(workspace, styleId, actor)
  const next = start(workspace, reason), ops = next.operations!, before = ops.styleOperations.find(item => item.id === id); checkVersion(before, expected)
  if (!['label', 'embroidery'].includes(kind) || before && (before.styleId !== styleId || before.kind !== kind)) throw new Error('작업 종류와 스타일을 확인해 주세요.')
  if (ops.styleOperations.some(item => item.id !== id && item.styleId === styleId && item.kind === kind)) throw new Error('이 스타일의 작업 내역이 이미 있습니다. 최신 내역을 열어 수정해 주세요.')
  if (!data.rows.length || data.rows.length > 200 || new Set(data.rows.map(row => row.id)).size !== data.rows.length) throw new Error('중복 없는 작업 항목을 1~200개 입력해 주세요.')
  if (data.note.length > 10000) throw new Error('작업 메모는 10,000자 이하로 입력해 주세요.')
  const rows: OperationRow[] = data.rows.map(row => {
    const catalog = ops.operationCatalogs.find(item => item.id === row.catalogId && item.kind === kind)
    if (!catalog || !catalog.active && !before?.rows.some(old => old.id === row.id && old.catalogId === row.catalogId)) throw new Error('등록된 작업 종류 목록에서 항목을 선택해 주세요.')
    for (const value of [row.quantity, row.lossQuantity, row.completedQuantity]) if (!Number.isSafeInteger(value) || value < 0 || value > 10000000) throw new Error('작업·로스·완료 수량은 0~10,000,000의 정수여야 합니다.')
    if (row.completedQuantity > row.quantity + row.lossQuantity || !quantityKeys.includes(row.status)) throw new Error('완료 수량과 진행 상태를 확인해 주세요.')
    for (const date of [row.orderedAt, row.requestedAt, row.completedAt, row.dueDate]) validateOperationDate(date)
    if (row.note.length > 5000 || row.specification.length > 1000) throw new Error('작업 규격·메모 길이를 확인해 주세요.')
    const old = before?.rows.find(item => item.id === row.id && item.catalogId === row.catalogId)
    return { ...row, name: !catalog.active && old ? old.name : catalog.name }
  })
  const after = { id, styleId, kind, rows, note: data.note, voided: !!data.voided, ...stamp(before, actor) }
  ops.styleOperations = replace(ops.styleOperations, after, item => item.id === id); audit(next, styleId, actor, kind === 'label' ? '중화라벨 발주 저장' : '비와이 자수 작업 저장', reason, before, after); return next
}

export function saveCalendarInWorkspace(workspace: Workspace, profile: Profile, id: string, data: CalendarEventInput, expected: number, reason: string): Workspace {
  const actor = actorFor(workspace, profile), next = start(workspace, reason), ops = next.operations!
  const before = ops.calendarEvents.find(item => item.id === id); checkVersion(before, expected)
  validateLeave({ ...before, ...data })
  if (before && (before.kind !== data.kind || before.ownerId !== data.ownerId || !canReadCalendarEvent(before, actor))) throw new Error('일정 종류·작성자는 변경할 수 없습니다.')
  if (!before && data.ownerId !== actor.id) throw new Error('일정 작성자는 로그인한 사용자여야 합니다.')
  if (!['personal_leave', 'launch', 'factory_holiday'].includes(data.kind)) throw new Error('일정 종류를 선택해 주세요.')
  if (data.kind === 'personal_leave') {
    if (actor.id !== data.ownerId && !(actor.role === 'admin' && before?.visibility === 'hq')) throw new Error('개인 일정은 작성자만 수정할 수 있습니다.')
    if (!['private', 'hq'].includes(data.visibility) || actor.role === 'factory' && data.visibility !== 'private') throw new Error('개인 일정 공개 범위를 확인해 주세요.')
  } else if (actor.role === 'factory' || data.visibility !== (data.kind === 'launch' ? 'all' : 'hq')) throw new Error('제품 런칭·협력업체 휴가는 본사에서 관리합니다.')
  validateOperationDate(data.startDate, true); validateOperationDate(data.endDate, true)
  if (data.startDate > data.endDate || !data.title.trim() || data.title.length > 200 || data.note.length > 10000) throw new Error('일정 제목·기간·메모를 확인해 주세요.')
  if (data.kind === 'factory_holiday' && !data.factoryId || data.factoryId && !next.factories.some(factory => factory.id === data.factoryId)) throw new Error('협력업체 휴가의 공장을 선택해 주세요.')
  const after: CalendarEvent = { ...(data.leaveType !== undefined ? { leaveType: data.leaveType, startTime: data.startTime || '', endTime: data.endTime || '' } : before?.leaveType !== undefined ? { leaveType: before.leaveType, startTime: before.startTime || '', endTime: before.endTime || '' } : {}), id, kind: data.kind, visibility: data.visibility, title: data.title.trim(), startDate: data.startDate, endDate: data.endDate, ownerId: data.ownerId, factoryId: data.factoryId, note: data.note, deletedAt: data.deleted ? before?.deletedAt || new Date().toISOString() : null, ...stamp(before, actor) }
  ops.calendarEvents = replace(ops.calendarEvents, after, item => item.id === id)
  ops.calendarEventAudits.unshift({ id: crypto.randomUUID(), eventId: id, actorId: actor.id, actorName: actor.name, action: data.deleted ? '일정 삭제' : before ? '일정 수정' : '일정 등록', reason: reason.trim(), before: before || null, after, createdAt: after.updatedAt }); return next
}
export function saveAssignmentInWorkspace(workspace: Workspace, profile: Profile, employeeId: string, factoryIds: string[], expected: number, reason: string): Workspace {
  const actor = hqActor(workspace, profile); if (actor.role !== 'admin') throw new Error('담당 공장 배정은 관리자만 변경할 수 있습니다.')
  const employee = workspace.profiles.find(item => item.id === employeeId && item.role !== 'factory' && item.approved && item.active)
  if (!employee || new Set(factoryIds).size !== factoryIds.length || factoryIds.some(id => !workspace.factories.some(item => item.id === id))) throw new Error('활성 본사 담당자와 등록된 공장을 선택해 주세요.')
  const next = start(workspace, reason), ops = next.operations!, before = ops.employeeFactoryAssignments.find(item => item.employeeId === employeeId); checkVersion(before, expected)
  const after = { employeeId, factoryIds: [...factoryIds].sort(), ...stamp(before, actor) }
  ops.employeeFactoryAssignments = replace(ops.employeeFactoryAssignments, after, item => item.employeeId === employeeId); audit(next, null, actor, '본사 담당 공장 배정', reason, before, after); return next
}
export function saveCatalogInWorkspace(workspace: Workspace, profile: Profile, id: string, kind: StyleOperationKind, name: string, active: boolean, expected: number, reason: string): Workspace {
  const actor = hqActor(workspace, profile); if (actor.role !== 'admin') throw new Error('작업 종류는 관리자만 관리할 수 있습니다.')
  if (!['label', 'embroidery'].includes(kind) || !name.trim() || name.trim().length > 120) throw new Error('작업 종류와 이름을 확인해 주세요.')
  const next = start(workspace, reason), ops = next.operations!, before = ops.operationCatalogs.find(item => item.id === id)
  if (!before) throw new Error('작업 종류는 정해진 목록만 사용할 수 있습니다. 기존 항목의 사용 여부만 변경해 주세요.')
  checkVersion(before, expected)
  if (before.kind !== kind || before.name !== name) throw new Error('작업 종류는 정해진 목록만 사용할 수 있습니다. 기존 항목의 사용 여부만 변경해 주세요.')
  const after = { ...before, active, ...stamp(before, actor) }
  ops.operationCatalogs = replace(ops.operationCatalogs, after, item => item.id === id); audit(next, null, actor, '작업 종류 목록 저장', reason, before, after); return next
}
export function importOrdersInWorkspace(workspace: Workspace, profile: Profile, changes: OrderImportChange[], mode: 'replace' | 'add', reason: string): Workspace {
  const actor = hqActor(workspace, profile), next = start(workspace, reason)
  if (!['replace', 'add'].includes(mode) || !changes.length || changes.length > 500 || new Set(changes.map(item => item.styleId)).size !== changes.length || changes.reduce((sum, change) => sum + change.lines.length, 0) > 1000) throw new Error('오더 적용 범위를 확인해 주세요. 한 번에 스타일 500개·컬러 1,000개까지 적용할 수 있습니다.')
  for (const change of changes) {
    const before = existingStyle(next, change.styleId, actor); checkVersion(before, change.expectedVersion)
    if (!change.lines.length || new Set(change.lines.map(item => item.lineId)).size !== change.lines.length) throw new Error('오더 컬러가 중복되거나 비어 있습니다.')
    const after = structuredClone(before)
    for (const update of change.lines) {
      const line = after.production.find(item => item.id === update.lineId && item.color === update.color)
      if (!line) throw new Error('등록된 스타일·컬러와 일치하지 않는 행이 있습니다.')
      validateOperationQuantities(update.quantities)
      const quantities = emptyQuantities()
      for (const size of SIZES) quantities[size] = update.quantities[size] + (mode === 'add' ? line.order[size] : 0)
      validateOperationQuantities(quantities); line.order = quantities
      if (update.source !== undefined) {
        const { expectedVersion, ...source } = update.source
        applyOrderSource(next, actor, before.id, line.id, source, expectedVersion, reason)
      }
    }
    assertStyleSave(actor, before, after, reason); assertManagedShipmentTotals(next, after)
    after.version += 1; after.updatedAt = new Date().toISOString(); after.updatedBy = actor.id
    next.styles = replace(next.styles, after, item => item.id === after.id); audit(next, after.id, actor, '오더 엑셀 일괄 적용', reason, before, after)
  }
  return next
}

const sourceError = () => new Error('ORDER QTY 원본 정보의 파일명·시트·16개 열과 값을 확인해 주세요.')
function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
/** Validate source values as literal data; formula objects never reach storage. */
export function validateOrderSourceData(data: OrderSourceData): void {
  if (!exactObject(data, ['fileName', 'sheetName', 'headers', 'rows']) || typeof data.fileName !== 'string' || !data.fileName.trim() || data.fileName.length > 255 || typeof data.sheetName !== 'string' || !data.sheetName.trim() || data.sheetName.length > 100 || !exactObject(data.headers, ORDER_SOURCE_COLUMNS) || Object.values(data.headers).some(value => typeof value !== 'string' || value.length > 4000) || !Array.isArray(data.rows) || data.rows.length < 1 || data.rows.length > 100) throw sourceError()
  const rowNumbers = new Set<number>()
  for (const row of data.rows) {
    if (!exactObject(row, ['rowNumber', 'columns']) || !Number.isSafeInteger(row.rowNumber) || row.rowNumber < 1 || row.rowNumber > 10000 || rowNumbers.has(row.rowNumber) || !exactObject(row.columns, ORDER_SOURCE_COLUMNS)) throw sourceError()
    rowNumbers.add(row.rowNumber)
    for (const cell of Object.values(row.columns)) {
      if (cell === null || typeof cell === 'boolean' || typeof cell === 'string' && cell.length <= 4000 || typeof cell === 'number' && Number.isFinite(cell) && Math.abs(cell) <= 1e15) continue
      throw sourceError()
    }
  }
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 1024 * 1024) throw new Error('ORDER QTY 원본 정보는 컬러당 1MB 이하로 저장해 주세요.')
}
function sourceAudit(record: OrderSourceRecord | undefined) {
  return record ? { styleId: record.styleId, lineId: record.lineId, version: record.version, rowCount: record.rows.length } : null
}
/** Mutates only an already isolated workspace, so bulk order changes stay atomic. */
function applyOrderSource(next: Workspace, actor: Profile, styleId: string, lineId: string, data: OrderSourceData, expected: number, reason: string): void {
  const style = existingStyle(next, styleId, actor)
  if (!style.production.some(line => line.id === lineId)) throw new Error('ORDER QTY 원본 정보를 연결할 생산 컬러가 없습니다.')
  validateOrderSourceData(data)
  const ops = next.operations!, before = ops.orderSourceRecords.find(item => item.styleId === styleId && item.lineId === lineId)
  checkVersion(before, expected)
  const after: OrderSourceRecord = { ...structuredClone(data), fileName: data.fileName.trim(), sheetName: data.sheetName.trim(), styleId, lineId, ...stamp(before, actor) }
  ops.orderSourceRecords = replace(ops.orderSourceRecords, after, item => item.styleId === styleId && item.lineId === lineId)
  // Global style audits are visible to assigned factories; preserve source privacy.
  audit(next, styleId, actor, 'ORDER QTY 원본 정보 저장', reason, sourceAudit(before), sourceAudit(after))
}
export function saveOrderSourceInWorkspace(workspace: Workspace, profile: Profile, styleId: string, lineId: string, data: OrderSourceData, expected: number, reason: string): Workspace {
  const actor = hqActor(workspace, profile), next = start(workspace, reason)
  applyOrderSource(next, actor, styleId, lineId, data, expected, reason)
  return next
}
