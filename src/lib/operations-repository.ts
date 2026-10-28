import type { CalendarEvent, CalendarEventInput, OrderImportChange, OrderSourceData, PoDispatchInput, ShipmentBatchInput, StyleOperationInput, StyleOperationKind } from './operations-types'
import type { Profile } from './types'
import { getDemoWorkspace, locked, persist, supabase } from './repository'
import { saveAssignmentInWorkspace, saveCalendarInWorkspace, saveCatalogInWorkspace, saveOperationInWorkspace, saveOrderSourceInWorkspace, savePoInWorkspace, saveShipmentInWorkspace } from './operations-domain'
import { importProductionOrdersInWorkspace } from './round-import'
import { assertActive } from './permissions'

async function rpc(name: string, args: Record<string, unknown>) {
  const result = await supabase!.rpc(name, args)
  if (result.error) {
    if (['PGRST202', 'PGRST205', '42P01'].includes(result.error.code)) throw new Error('새 업무 기능 설정이 필요합니다. Supabase에 003_operations.sql을 적용한 뒤 다시 접속해 주세요.')
    throw result.error
  }
  return result.data
}
export async function savePoDispatch(id: string, styleId: string, data: PoDispatchInput, expectedVersion: number, reason: string, profile: Profile): Promise<void> {
  if (supabase) { await rpc('save_po_dispatch', { p_id: id, p_style_id: styleId, p_expected_version: expectedVersion, p_data: data, p_reason: reason }); return }
  await locked(() => persist(savePoInWorkspace(getDemoWorkspace(), profile, id, styleId, data, expectedVersion, reason)))
}
export async function sendPoEmail(id: string, expectedVersion: number, profile: Profile, outlookAccessToken?: string, outlookIdToken?: string): Promise<void> {
  assertActive(profile)
  if (profile.role === 'factory') throw new Error('PO 메일은 관리자·본사 직원만 발송할 수 있습니다.')
  if (!supabase) throw new Error('체험 모드에서는 실제 메일을 발송하지 않습니다. Supabase 메일 함수와 발신 서비스 설정이 필요합니다.')
  const outlook = outlookAccessToken !== undefined
  if (outlook && (!outlookAccessToken.trim() || outlookAccessToken.length > 24576 || !outlookIdToken?.trim() || outlookIdToken.length > 24576)) throw new Error('Outlook 계정을 다시 연결한 뒤 발송해 주세요.')
  const result = await supabase.functions.invoke(outlook ? 'send-po-outlook' : 'send-po-email', { body: { id, expectedVersion, ...(outlook ? { outlookAccessToken, outlookIdToken } : {}) } })
  if (result.error) {
    let text = 'PO 메일 발송을 확인하지 못했습니다. 발송 이력의 상태를 확인하고, 발송 접수가 불확실하면 재발송하지 말고 관리자에게 확인해 주세요.'
    if ('context' in result.error && result.error.context instanceof Response) {
      try { const body = await result.error.context.clone().json(); if (typeof body.message === 'string') text = body.message } catch { /* Gateway failures may not be JSON. */ }
    }
    throw new Error(text)
  }
  const receipt = outlook ? result.data?.provider === 'outlook' && result.data?.providerRequestId : result.data?.providerMessageId
  if (result.data?.status !== 'sent' || !receipt) throw new Error('메일 서비스의 접수 근거를 확인하지 못했습니다. 발송 상태를 다시 확인해 주세요.')
}
export async function saveShipmentBatch(id: string, styleId: string, lineId: string, data: ShipmentBatchInput, expectedVersion: number, expectedStyleVersion: number, reason: string, profile: Profile): Promise<void> {
  if (supabase) { await rpc('save_shipment_batch', { p_id: id, p_style_id: styleId, p_line_id: lineId, p_expected_version: expectedVersion, p_expected_style_version: expectedStyleVersion, p_data: data, p_reason: reason }); return }
  await locked(() => persist(saveShipmentInWorkspace(getDemoWorkspace(), profile, id, styleId, lineId, data, expectedVersion, expectedStyleVersion, reason)))
}
export async function saveStyleOperation(id: string, styleId: string, kind: StyleOperationKind, data: StyleOperationInput, expectedVersion: number, reason: string, profile: Profile): Promise<void> {
  if (supabase) { await rpc('save_style_operation', { p_id: id, p_style_id: styleId, p_kind: kind, p_expected_version: expectedVersion, p_data: data, p_reason: reason }); return }
  await locked(() => persist(saveOperationInWorkspace(getDemoWorkspace(), profile, id, styleId, kind, data, expectedVersion, reason)))
}
export async function saveCalendarEvent(event: CalendarEvent, reason: string, profile: Profile): Promise<void> {
  const data: CalendarEventInput = { ...(event.leaveType !== undefined ? { leaveType: event.leaveType, startTime: event.startTime || '', endTime: event.endTime || '' } : {}), kind: event.kind, visibility: event.visibility, title: event.title, startDate: event.startDate, endDate: event.endDate, ownerId: event.ownerId, factoryId: event.factoryId, note: event.note, deleted: !!event.deletedAt }
  if (supabase) { await rpc('save_calendar_event', { p_id: event.id, p_expected_version: event.version, p_data: data, p_reason: reason }); return }
  await locked(() => persist(saveCalendarInWorkspace(getDemoWorkspace(), profile, event.id, data, event.version, reason)))
}
export async function saveEmployeeFactoryAssignment(employeeId: string, factoryIds: string[], expectedVersion: number, reason: string, profile: Profile): Promise<void> {
  if (supabase) { await rpc('save_employee_factory_assignment', { p_employee_id: employeeId, p_factory_ids: factoryIds, p_expected_version: expectedVersion, p_reason: reason }); return }
  await locked(() => persist(saveAssignmentInWorkspace(getDemoWorkspace(), profile, employeeId, factoryIds, expectedVersion, reason)))
}
export async function saveOperationCatalog(id: string, kind: StyleOperationKind, name: string, active: boolean, expectedVersion: number, reason: string, profile: Profile): Promise<void> {
  if (supabase) { await rpc('save_operation_catalog', { p_id: id, p_kind: kind, p_name: name, p_active: active, p_expected_version: expectedVersion, p_reason: reason }); return }
  await locked(() => persist(saveCatalogInWorkspace(getDemoWorkspace(), profile, id, kind, name, active, expectedVersion, reason)))
}
// Keep an uncertain response retry on the same request id. A fresh preview has
// newer expected versions, and therefore a different key and a new round.
const orderImportRequests = new Map<string, string>()
export async function importOrderQuantities(changes: OrderImportChange[], mode: 'replace' | 'add', reason: string, profile: Profile): Promise<void> {
  const key = JSON.stringify({ actorId: profile.id, changes, mode, reason })
  const importId = orderImportRequests.get(key) || crypto.randomUUID()
  orderImportRequests.set(key, importId)
  if (orderImportRequests.size > 20) orderImportRequests.delete(orderImportRequests.keys().next().value!)
  if (supabase) {
    const result = await supabase.rpc('bulk_import_production_orders', { p_import_id: importId, p_changes: changes, p_mode: mode, p_reason: reason })
    if (result.error) {
      if (['PGRST202', 'PGRST205', '42P01'].includes(result.error.code)) throw new Error('프로젝트·생산 차수별 오더 등록 설정이 필요합니다. Supabase에 006~009 SQL을 순서대로 적용한 뒤 다시 접속해 주세요.')
      if (/IMPORT_PROJECT_REQUIRED/.test(result.error.message)) throw new Error('A열 프로젝트 코드를 먼저 등록해 주세요. 스타일·프로젝트 등록에서 확인한 뒤 다시 업로드해 주세요.')
      if (/IMPORT_MIXED_PROJECTS/.test(result.error.message)) throw new Error('같은 품번·컬러에 서로 다른 프로젝트가 있습니다. 프로젝트별로 나누어 업로드해 주세요.')
      if (/IMPORT_PROJECT_MISMATCH/.test(result.error.message)) throw new Error('A열 프로젝트에 등록된 명칭·시즌이 M·L열과 다릅니다. 프로젝트 기본 정보를 확인해 주세요.')
      throw result.error
    }
    return
  }
  await locked(() => persist(importProductionOrdersInWorkspace(getDemoWorkspace(), profile, importId, changes, mode, reason)))
}
export async function saveOrderSourceRecord(styleId: string, lineId: string, data: OrderSourceData, expectedVersion: number, reason: string, profile: Profile): Promise<void> {
  if (supabase) { await rpc('save_order_source_record', { p_style_id: styleId, p_line_id: lineId, p_expected_version: expectedVersion, p_data: data, p_reason: reason }); return }
  await locked(() => persist(saveOrderSourceInWorkspace(getDemoWorkspace(), profile, styleId, lineId, data, expectedVersion, reason)))
}
