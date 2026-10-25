import type { Quantities } from './types'
import type { LeaveType } from './workflow-refinements'

export interface OperationStamp { version: number; createdAt: string; updatedAt: string; updatedBy: string }
export type PoDispatchStatus = 'draft' | 'sending' | 'sent' | 'failed' | 'unknown'
/** Sent status is assigned only after a confirmed provider response. */
export interface PoDispatch extends OperationStamp { id: string; styleId: string; dueDate: string; recipient: string; subject: string; body: string; evidenceAttachmentId: string | null; status: PoDispatchStatus; sentAt: string; providerMessageId: string | null; lastError: string | null; attempts: number; idempotencyKey: string; factoryIdSnapshot: string; styleCodeSnapshot: string; voided: boolean }
export interface PoDispatchInput { dueDate: string; recipient: string; subject: string; body: string; evidenceAttachmentId: string | null; voided: boolean }
export interface PoDispatchAttempt { id: string; dispatchId: string; attempt: number; status: 'sending' | 'sent' | 'failed' | 'unknown'; snapshot: unknown; providerMessageId: string | null; error: string | null; startedAt: string; finishedAt: string | null; actorId: string }
export interface ShipmentLedger { styleId: string; lineId: string; baselineQuantities: Quantities; baselineDate: string; createdAt: string; createdBy: string }
export interface ShipmentBatch extends OperationStamp { id: string; styleId: string; lineId: string; round: number; shippedAt: string; quantities: Quantities; tracking: string; note: string; voided: boolean }
export interface ShipmentBatchInput { shippedAt: string; quantities: Quantities; tracking: string; note: string; voided: boolean }
export type StyleOperationKind = 'label' | 'embroidery'
/** A checklist line for label/embroidery work. HQ owns these instructions. */
export interface OperationCatalog extends OperationStamp { id: string; kind: StyleOperationKind; name: string; active: boolean }
export interface OperationRow { id: string; catalogId: string; name: string; specification: string; quantity: number; lossQuantity: number; completedQuantity: number; status: 'unset' | 'todo' | 'progress' | 'done' | 'approved' | 'delayed'; orderedAt: string; requestedAt: string; completedAt: string; dueDate: string; note: string }
export interface StyleOperation extends OperationStamp { id: string; styleId: string; kind: StyleOperationKind; rows: OperationRow[]; note: string; voided: boolean }
export interface StyleOperationInput { rows: OperationRow[]; note: string; voided: boolean }
export type CalendarEventKind = 'personal_leave' | 'launch' | 'factory_holiday'
export interface CalendarEvent extends OperationStamp { leaveType?: LeaveType; startTime?: string; endTime?: string; id: string; kind: CalendarEventKind; visibility: 'private' | 'hq' | 'all'; title: string; startDate: string; endDate: string; ownerId: string; factoryId: string | null; note: string; deletedAt: string | null }
export interface CalendarEventInput { leaveType?: LeaveType; startTime?: string; endTime?: string; kind: CalendarEventKind; visibility: 'private' | 'hq' | 'all'; title: string; startDate: string; endDate: string; ownerId: string; factoryId: string | null; note: string; deleted: boolean }
export interface CalendarEventAudit { id: string; eventId: string; actorId: string; actorName: string; action: string; reason: string; before: unknown; after: unknown; createdAt: string }
export interface EmployeeFactoryAssignment extends OperationStamp { employeeId: string; factoryIds: string[] }
export const ORDER_SOURCE_COLUMNS = ['A', 'F', 'L', 'M', 'S', 'V', 'W', 'X', 'Y', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AV', 'AY'] as const
export type OrderSourceColumn = typeof ORDER_SOURCE_COLUMNS[number]
export type OrderSourceCell = string | number | boolean | null
export interface OrderSourceRow { rowNumber: number; columns: Record<OrderSourceColumn, OrderSourceCell> }
export interface OrderSourceData { fileName: string; sheetName: string; headers: Record<OrderSourceColumn, string>; rows: OrderSourceRow[] }
export interface OrderSourceRecord extends OrderSourceData, OperationStamp { styleId: string; lineId: string }
export interface OrderImportChange { styleId: string; expectedVersion: number; lines: { lineId: string; color: string; quantities: Quantities; source?: OrderSourceData & { expectedVersion: number } }[] }
export interface OperationsWorkspace { orderSourceRecords: OrderSourceRecord[]; poDispatches: PoDispatch[]; poDispatchAttempts: PoDispatchAttempt[]; operationCatalogs: OperationCatalog[]; shipmentLedgers: ShipmentLedger[]; shipmentBatches: ShipmentBatch[]; styleOperations: StyleOperation[]; calendarEvents: CalendarEvent[]; calendarEventAudits: CalendarEventAudit[]; employeeFactoryAssignments: EmployeeFactoryAssignment[] }
export const EMPTY_OPERATIONS: OperationsWorkspace = { orderSourceRecords: [], poDispatches: [], poDispatchAttempts: [], operationCatalogs: [], shipmentLedgers: [], shipmentBatches: [], styleOperations: [], calendarEvents: [], calendarEventAudits: [], employeeFactoryAssignments: [] }

/** RPCs; all input documents reject unknown/missing keys. New record version=0.
 * save_po_dispatch(p_id,p_style_id,p_expected_version,p_data:PoDispatchInput,p_reason) -> po_dispatches row
 * begin_po_dispatch(p_id,p_expected_version) -> po_dispatches row (HQ, draft/failed only)
 * finalize_po_dispatch(p_id,p_provider_message_id,p_error,p_outcome) -> row (service_role ONLY)
 * save_operation_catalog(p_id,p_kind,p_name,p_active,p_expected_version,p_reason) -> operation_catalogs row (admin)
 * save_shipment_batch(p_id,p_style_id,p_line_id,p_expected_version,p_expected_style_version,p_data:ShipmentBatchInput,p_reason) -> shipment_batches row
 * save_style_operation(p_id,p_style_id,p_kind,p_expected_version,p_data:StyleOperationInput,p_reason) -> style_operations row
 * save_calendar_event(p_id,p_expected_version,p_data:CalendarEventInput,p_reason) -> calendar_events row
 * save_employee_factory_assignment(p_employee_id,p_factory_ids:uuid[],p_expected_version,p_reason) -> employee_factory_assignments row
 * save_order_source_record(p_style_id,p_line_id,p_expected_version,p_data:OrderSourceData,p_reason) -> order_source_records row (HQ only)
 * bulk_import_order_quantities(p_changes:OrderImportChange[],p_mode:'replace'|'add',p_reason) -> {styleId,version}[]
 * Every RPC requires >=2-char reason and <=1000 chars; dates ISO YYYY-MM-DD.
 * Shipment RPC captures immutable legacy baseline on first save, assigns round,
 * and atomically updates parent style.shipped/shippedAt/version plus audit.
 * Table fields are snake_case equivalents except style_operations.rows_data -> rows,
 * calendar_events.deleted_at -> deletedAt; no direct DML privileges for clients.
 */
