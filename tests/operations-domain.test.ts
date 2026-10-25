import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { emptyQuantities, type Quantities, type Workspace } from '../src/lib/types'
import {
  assertManagedShipmentTotals, canReadCalendarEvent, freshOperations, importOrdersInWorkspace,
  saveAssignmentInWorkspace, saveCalendarInWorkspace, saveCatalogInWorkspace, saveOperationInWorkspace,
  saveOrderSourceInWorkspace, savePoInWorkspace, saveShipmentInWorkspace, scopeOperations, shipmentTotals,
  validateOperationDate, validateOperationQuantities, validateOperationReason, validateOrderSourceData,
} from '../src/lib/operations-domain'
import type { CalendarEventInput, OperationRow, OrderImportChange, OrderSourceData, PoDispatchInput, ShipmentBatchInput, StyleOperationInput } from '../src/lib/operations-types'
import { ORDER_SOURCE_COLUMNS } from '../src/lib/operations-types'
import { canViewStyle } from '../src/lib/permissions'

const reason = '테스트 작업 변경'
const uuid = () => crypto.randomUUID()
const quantities = (s = 10, m = 0): Quantities => ({ ...emptyQuantities(), S: s, M: m })
const stamp = { version: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', updatedBy: DEMO_IDS.admin }
function fixture() {
  const workspace = createSeed()
  workspace.operations = freshOperations()
  workspace.operationsAvailable = true
  const admin = workspace.profiles.find(p => p.id === DEMO_IDS.admin)!
  const internal = workspace.profiles.find(p => p.id === DEMO_IDS.internal)!
  const factory = workspace.profiles.find(p => p.id === DEMO_IDS.factory)!
  const pending = workspace.profiles.find(p => !p.approved)!
  const secondInternal = workspace.profiles.find(p => p.role === 'internal' && p.id !== internal.id)!
  const style = workspace.styles.find(s => s.factoryId === factory.factoryId)!
  const line = style.production[0]
  line.shipped = quantities(3, 2); line.shippedAt = '2026-10-05'
  workspace.operations.operationCatalogs = [
    { ...stamp, id: '70000000-0000-4000-8000-000000000001', kind: 'label', name: '테스트 전용 라벨 A', active: true },
    { ...stamp, id: '70000000-0000-4000-8000-000000000002', kind: 'embroidery', name: '테스트 전용 자수 A', active: true },
  ]
  return { workspace, admin, internal, factory, pending, secondInternal, style, line }
}
const poData = (overrides: Partial<PoDispatchInput> = {}): PoDispatchInput => ({ dueDate: '2026-11-30', recipient: 'factory@example.test', subject: '테스트 전용 생산 발주', body: '실제 발송용 메일이 아닌 단위 테스트 자료입니다.', evidenceAttachmentId: null, voided: false, ...overrides })
const shipmentData = (overrides: Partial<ShipmentBatchInput> = {}): ShipmentBatchInput => ({ shippedAt: '2026-11-01', quantities: quantities(), tracking: 'TEST-TRACKING', note: '테스트 전용 출고', voided: false, ...overrides })
const calendarData = (ownerId: string, overrides: Partial<CalendarEventInput> = {}): CalendarEventInput => ({ kind: 'personal_leave', visibility: 'private', title: '테스트 개인 휴가', startDate: '2026-11-01', endDate: '2026-11-02', ownerId, factoryId: null, note: '테스트 일정', deleted: false, ...overrides })
function operationData(workspace: Workspace, overrides: Partial<OperationRow> = {}): StyleOperationInput {
  return { rows: [{ id: uuid(), catalogId: workspace.operations!.operationCatalogs[0].id, name: '클라이언트가 임의 입력한 이름', specification: '테스트 규격', quantity: 100, lossQuantity: 5, completedQuantity: 20, status: 'progress', orderedAt: '2026-10-20', requestedAt: '2026-10-21', completedAt: '', dueDate: '2026-11-01', note: '검증 전용', ...overrides }], note: '테스트 작업', voided: false }
}
function orderChange(workspace: Workspace, index = 0, q = quantities()): OrderImportChange {
  const style = workspace.styles[index], line = style.production[0]
  return { styleId: style.id, expectedVersion: style.version, lines: [{ lineId: line.id, color: line.color, quantities: q }] }
}
function sourceData(overrides: Partial<OrderSourceData> = {}): OrderSourceData {
  return {
    fileName: '테스트-ORDER.csv', sheetName: 'ORDER QTY',
    headers: Object.fromEntries(ORDER_SOURCE_COLUMNS.map(column => [column, `원본 ${column}`])),
    rows: [{ rowNumber: 4, columns: Object.fromEntries(ORDER_SOURCE_COLUMNS.map((column, index) => [column, column === 'F' ? 'TEST-STYLEBK' : index])) }],
    ...overrides,
  }
}

describe('업무 확장 상태 정규화·기본 검증', () => {
  it('이전 체험 데이터의 없는 업무 배열을 독립된 빈 배열로 보완한다', () => {
    const first = freshOperations(), second = freshOperations()
    for (const key of Object.keys(first) as (keyof typeof first)[]) { expect(first[key]).toEqual([]); expect(first[key]).not.toBe(second[key]) }
    const partial = freshOperations({ shipmentBatches: [] })
    expect(partial.operationCatalogs).toEqual([])
  })

  it.each(['2026-02-30', '2026-13-01', '26-01-01', '2026-1-01', '2026-01-01T00:00:00Z'])('잘못된 날짜 %s을 거부한다', value => expect(() => validateOperationDate(value)).toThrow('날짜'))
  it('빈 선택 날짜와 윤년 날짜를 허용하되 필수 빈 날짜를 거부한다', () => {
    expect(() => validateOperationDate('')).not.toThrow()
    expect(() => validateOperationDate('2028-02-29')).not.toThrow()
    expect(() => validateOperationDate('', true)).toThrow()
    expect(() => validateOperationDate('2027-02-29')).toThrow()
  })
  it('사유 길이와 여섯 사이즈의 정수·상한을 검증한다', () => {
    for (const value of ['', '가', 'x'.repeat(1001)]) expect(() => validateOperationReason(value)).toThrow()
    expect(() => validateOperationReason('  확인  ')).not.toThrow()
    expect(() => validateOperationQuantities(quantities())).not.toThrow()
    expect(() => validateOperationQuantities({ ...quantities(), S: -1 })).toThrow()
    expect(() => validateOperationQuantities({ ...quantities(), S: 1.5 })).toThrow()
    expect(() => validateOperationQuantities({ ...quantities(), S: 10000001 })).toThrow()
    const missing = { S: 10, M: 0 } as Quantities
    expect(() => validateOperationQuantities(missing)).toThrow()
  })

  it('전달한 역할을 위조해도 저장된 프로필 권한을 기준으로 검증한다', () => {
    const { workspace, factory, style } = fixture()
    expect(() => savePoInWorkspace(workspace, { ...factory, role: 'admin' }, uuid(), style.id, poData(), 0, reason)).toThrow('본사')
  })

  it('승인 전·비활성 계정의 변경은 모두 거부하고 조회 데이터도 비운다', () => {
    const { workspace, pending, admin, style, line } = fixture()
    expect(() => saveShipmentInWorkspace(workspace, pending, uuid(), style.id, line.id, shipmentData(), 0, style.version, reason)).toThrow('승인')
    const inactive = { ...admin, active: false }; workspace.profiles = workspace.profiles.map(p => p.id === inactive.id ? inactive : p)
    expect(() => savePoInWorkspace(workspace, inactive, uuid(), style.id, poData(), 0, reason)).toThrow('승인')
    for (const profile of [pending, inactive]) Object.values(scopeOperations(workspace, profile)).forEach(collection => expect(collection).toHaveLength(0))
  })
})

describe('PO 초안과 실제 발송 상태의 구분', () => {
  it('본사 초안은 draft·시도0으로 저장하고 원본은 변경하지 않는다', () => {
    const { workspace, internal, style } = fixture()
    const original = structuredClone(workspace), id = uuid()
    const next = savePoInWorkspace(workspace, internal, id, style.id, poData(), 0, reason)
    expect(workspace).toEqual(original)
    const po = next.operations!.poDispatches[0]
    expect(po).toMatchObject({ id, status: 'draft', sentAt: '', attempts: 0, providerMessageId: null, factoryIdSnapshot: style.factoryId, styleCodeSnapshot: style.code, version: 1 })
    expect(po.idempotencyKey).toBe(`sig-po-${id}`)
    expect(next.audits[0].action).toContain('초안')
  })

  it('공장은 PO를 만들거나 본사 초안을 수정할 수 없다', () => {
    const { workspace, admin, factory, style } = fixture()
    const id = uuid(), next = savePoInWorkspace(workspace, admin, id, style.id, poData(), 0, reason)
    expect(() => savePoInWorkspace(workspace, factory, uuid(), style.id, poData(), 0, reason)).toThrow('본사')
    expect(() => savePoInWorkspace(next, factory, id, style.id, poData(), 1, reason)).toThrow('본사')
  })

  it('PO 내용 수정에는 버전 일치가 필요하고 발송 시도 후에는 초안을 덮어쓰지 않는다', () => {
    const { workspace, admin, style } = fixture()
    const id = uuid(), next = savePoInWorkspace(workspace, admin, id, style.id, poData(), 0, reason)
    expect(() => savePoInWorkspace(next, admin, id, style.id, poData(), 0, reason)).toThrow('VERSION_CONFLICT')
    next.operations!.poDispatches[0].attempts = 1
    next.operations!.poDispatches[0].status = 'failed'
    expect(() => savePoInWorkspace(next, admin, id, style.id, poData({ body: '다르게 바꾼 본문' }), 1, reason)).toThrow('발송을 시도')
  })

  it('잘못된 메일·헤더 주입·타 스타일 첨부 근거자료를 거부한다', () => {
    const { workspace, admin, style } = fixture()
    for (const data of [poData({ recipient: 'bad-address' }), poData({ subject: '발주\r\nBcc: leak@example.test' }), poData({ dueDate: '2026-02-30' })]) expect(() => savePoInWorkspace(workspace, admin, uuid(), style.id, data, 0, reason)).toThrow()
    const attachmentId = uuid()
    workspace.attachments.push({ id: attachmentId, styleId: workspace.styles.find(s => s.id !== style.id)!.id, sampleId: null, name: '타 스타일.pdf', path: 'private/file.pdf', mime: 'application/pdf', size: 3, uploadedBy: admin.id, createdAt: stamp.createdAt })
    expect(() => savePoInWorkspace(workspace, admin, uuid(), style.id, poData({ evidenceAttachmentId: attachmentId }), 0, reason)).toThrow('이 스타일')
  })
})

describe('누적 차수 출고와 기존 출고 수량 보존', () => {
  it('첫 차수 등록 시 기존 집계 수량을 기준값으로 캡처하고 부모 집계를 원자적으로 갱신한다', () => {
    const { workspace, factory, style, line } = fixture()
    const original = structuredClone(workspace)
    const next = saveShipmentInWorkspace(workspace, factory, uuid(), style.id, line.id, shipmentData({ quantities: quantities(10, 4) }), 0, style.version, reason)
    expect(workspace).toEqual(original)
    expect(next.operations!.shipmentLedgers[0].baselineQuantities).toEqual(quantities(3, 2))
    expect(next.operations!.shipmentLedgers[0].baselineDate).toBe('2026-10-05')
    expect(next.operations!.shipmentBatches[0].round).toBe(1)
    const updated = next.styles.find(s => s.id === style.id)!
    expect(updated.production[0].shipped).toEqual(quantities(13, 6))
    expect(updated.production[0].shippedAt).toBe('2026-11-01')
    expect(updated.version).toBe(style.version + 1)
    expect(updated.updatedBy).toBe(factory.id)
    expect(next.audits[0].styleId).toBe(style.id)
  })

  it('2차 이후 출고는 원래 기준값에 누적되고 수정해도 차수·기준값은 보존한다', () => {
    const { workspace, factory, style, line } = fixture()
    const firstId = uuid(), secondId = uuid()
    const first = saveShipmentInWorkspace(workspace, factory, firstId, style.id, line.id, shipmentData(), 0, style.version, reason)
    const second = saveShipmentInWorkspace(first, factory, secondId, style.id, line.id, shipmentData({ quantities: quantities(5), shippedAt: '2026-11-03' }), 0, style.version + 1, reason)
    expect(second.operations!.shipmentBatches.map(b => b.round).sort()).toEqual([1, 2])
    expect(shipmentTotals(second, style.id, line.id)).toEqual({ quantities: quantities(18, 2), date: '2026-11-03' })
    const edited = saveShipmentInWorkspace(second, factory, firstId, style.id, line.id, shipmentData({ quantities: quantities(7), shippedAt: '2026-11-02' }), 1, style.version + 2, reason)
    expect(edited.operations!.shipmentBatches.find(b => b.id === firstId)?.round).toBe(1)
    expect(edited.operations!.shipmentLedgers).toEqual(first.operations!.shipmentLedgers)
    expect(shipmentTotals(edited, style.id, line.id)?.quantities.S).toBe(15)
  })

  it('취소는 관리자만 가능하며 취소 차수는 집계에서 제외하고 다음 차수 번호를 재사용하지 않는다', () => {
    const { workspace, factory, admin, style, line } = fixture()
    const id = uuid(), first = saveShipmentInWorkspace(workspace, factory, id, style.id, line.id, shipmentData(), 0, style.version, reason)
    expect(() => saveShipmentInWorkspace(first, factory, id, style.id, line.id, shipmentData({ voided: true }), 1, style.version + 1, reason)).toThrow('관리자')
    const voided = saveShipmentInWorkspace(first, admin, id, style.id, line.id, shipmentData({ voided: true }), 1, style.version + 1, reason)
    expect(shipmentTotals(voided, style.id, line.id)).toEqual({ quantities: quantities(3, 2), date: '2026-10-05' })
    const next = saveShipmentInWorkspace(voided, factory, uuid(), style.id, line.id, shipmentData(), 0, style.version + 2, reason)
    expect(next.operations!.shipmentBatches.some(b => b.round === 2)).toBe(true)
    expect(next.operations!.shipmentBatches.find(b => b.id === id)?.voided).toBe(true)
  })

  it('공장은 관리자가 취소한 차수를 임의로 복원할 수 없다', () => {
    const { workspace, factory, admin, style, line } = fixture()
    const id = uuid(), first = saveShipmentInWorkspace(workspace, factory, id, style.id, line.id, shipmentData(), 0, style.version, reason)
    const voided = saveShipmentInWorkspace(first, admin, id, style.id, line.id, shipmentData({ voided: true }), 1, style.version + 1, reason)
    expect(() => saveShipmentInWorkspace(voided, factory, id, style.id, line.id, shipmentData({ voided: false }), 2, style.version + 2, reason)).toThrow('관리자')
  })

  it('본사 직원·미배정 공장·타 공장에는 출고 입력 권한이 없다', () => {
    const { workspace, internal, factory, style, line } = fixture()
    expect(() => saveShipmentInWorkspace(workspace, internal, uuid(), style.id, line.id, shipmentData(), 0, style.version, reason)).toThrow('출고 수량')
    const unassigned = { ...factory, factoryId: null }; workspace.profiles = workspace.profiles.map(p => p.id === factory.id ? unassigned : p)
    expect(() => saveShipmentInWorkspace(workspace, unassigned, uuid(), style.id, line.id, shipmentData(), 0, style.version, reason)).toThrow('접근')
    workspace.profiles = workspace.profiles.map(p => p.id === factory.id ? { ...factory, factoryId: DEMO_IDS.vietnam } : p)
    expect(() => saveShipmentInWorkspace(workspace, factory, uuid(), style.id, line.id, shipmentData(), 0, style.version, reason)).toThrow('접근')
  })

  it('출고 차수와 부모 스타일 양쪽의 오래된 버전 및 잘못된 수량·날짜를 거부한다', () => {
    const { workspace, factory, style, line } = fixture()
    const id = uuid(), next = saveShipmentInWorkspace(workspace, factory, id, style.id, line.id, shipmentData(), 0, style.version, reason)
    expect(() => saveShipmentInWorkspace(next, factory, id, style.id, line.id, shipmentData(), 0, style.version + 1, reason)).toThrow('VERSION_CONFLICT')
    expect(() => saveShipmentInWorkspace(next, factory, uuid(), style.id, line.id, shipmentData(), 0, style.version, reason)).toThrow('VERSION_CONFLICT')
    for (const data of [shipmentData({ quantities: quantities(-1) }), shipmentData({ quantities: emptyQuantities() }), shipmentData({ shippedAt: '2026-02-30' })]) expect(() => saveShipmentInWorkspace(workspace, factory, uuid(), style.id, line.id, data, 0, style.version, reason)).toThrow()
  })

  it('기존 출고와 새 차수 합계가 한도를 넘으면 원본·기준값·감사 이력을 전혀 변경하지 않는다', () => {
    const { workspace, admin, style, line } = fixture()
    line.shipped.S = 10000000
    const original = structuredClone(workspace)
    expect(() => saveShipmentInWorkspace(workspace, admin, uuid(), style.id, line.id, shipmentData({ quantities: quantities(1) }), 0, style.version, reason)).toThrow('정수')
    expect(workspace).toEqual(original)
  })

  it('같은 출고 id를 다른 스타일·컬러로 이동시킬 수 없고 관리자는 취소 차수를 복원할 수 있다', () => {
    const { workspace, admin, factory, style, line } = fixture()
    const id = uuid(), first = saveShipmentInWorkspace(workspace, factory, id, style.id, line.id, shipmentData(), 0, style.version, reason)
    expect(() => saveShipmentInWorkspace(first, admin, id, style.id, style.production[1].id, shipmentData(), 1, style.version + 1, reason)).toThrow('스타일·컬러')
    const voided = saveShipmentInWorkspace(first, admin, id, style.id, line.id, shipmentData({ voided: true }), 1, style.version + 1, reason)
    const restored = saveShipmentInWorkspace(voided, admin, id, style.id, line.id, shipmentData({ voided: false }), 2, style.version + 2, reason)
    expect(restored.operations!.shipmentBatches[0].round).toBe(1)
    expect(shipmentTotals(restored, style.id, line.id)?.quantities.S).toBe(13)
  })

  it('이전 스타일 수정 화면으로 차수 관리 집계나 출고일을 덮어쓸 수 없다', () => {
    const { workspace, admin, style, line } = fixture()
    const next = saveShipmentInWorkspace(workspace, admin, uuid(), style.id, line.id, shipmentData(), 0, style.version, reason)
    const aggregate = structuredClone(next.styles.find(s => s.id === style.id)!)
    expect(() => assertManagedShipmentTotals(next, aggregate)).not.toThrow()
    aggregate.production[0].shipped.S += 1
    expect(() => assertManagedShipmentTotals(next, aggregate)).toThrow('부분 출고')
    aggregate.production[0].shipped = shipmentTotals(next, style.id, line.id)!.quantities
    aggregate.production[0].shippedAt = '2026-12-01'
    expect(() => assertManagedShipmentTotals(next, aggregate)).toThrow('부분 출고')
  })
})

describe('고정 카탈로그 기반 라벨·자수 업무', () => {
  it('새 id로 같은 스타일·종류의 작업을 중복 생성하거나 긴 메모를 저장할 수 없다', () => {
    const { workspace, admin, style } = fixture()
    const first = saveOperationInWorkspace(workspace, admin, uuid(), style.id, 'label', operationData(workspace), 0, reason)
    expect(() => saveOperationInWorkspace(first, admin, uuid(), style.id, 'label', operationData(workspace), 0, reason)).toThrow('이미 있습니다')
    expect(() => saveOperationInWorkspace(workspace, admin, uuid(), style.id, 'label', { ...operationData(workspace), note: 'x'.repeat(10001) }, 0, reason)).toThrow('10,000')
  })
  it('허용된 종류 id로 항목을 저장하며 임의 이름을 카탈로그 이름으로 고정한다', () => {
    const { workspace, internal, style } = fixture()
    const data = operationData(workspace)
    const next = saveOperationInWorkspace(workspace, internal, uuid(), style.id, 'label', data, 0, reason)
    expect(next.operations!.styleOperations[0].rows[0].name).toBe('테스트 전용 라벨 A')
    expect(next.operations!.styleOperations[0].rows[0].catalogId).toBe(data.rows[0].catalogId)
    expect(next.operations!.styleOperations[0].rows[0].quantity).toBe(100)
    expect(workspace.operations!.styleOperations).toHaveLength(0)
  })

  it('없는 종류·다른 작업의 종류·비활성 신규 종류는 거부한다', () => {
    const { workspace, admin, style } = fixture()
    for (const catalogId of [uuid(), workspace.operations!.operationCatalogs[1].id]) expect(() => saveOperationInWorkspace(workspace, admin, uuid(), style.id, 'label', operationData(workspace, { catalogId }), 0, reason)).toThrow('목록')
    workspace.operations!.operationCatalogs[0].active = false
    expect(() => saveOperationInWorkspace(workspace, admin, uuid(), style.id, 'label', operationData(workspace), 0, reason)).toThrow('목록')
  })

  it('기존 이력의 비활성 종류는 유지하며 새 항목에 몰래 재사용할 수 없다', () => {
    const { workspace, admin, style } = fixture()
    const id = uuid(), data = operationData(workspace)
    const first = saveOperationInWorkspace(workspace, admin, id, style.id, 'label', data, 0, reason)
    first.operations!.operationCatalogs[0].active = false
    expect(() => saveOperationInWorkspace(first, admin, id, style.id, 'label', { ...data, rows: [{ ...data.rows[0], completedQuantity: 30 }] }, 1, reason)).not.toThrow()
    expect(() => saveOperationInWorkspace(first, admin, id, style.id, 'label', { ...data, rows: [{ ...data.rows[0], id: uuid() }] }, 1, reason)).toThrow('목록')
  })

  it('공장 수정·오래된 버전·로스 초과 완료·잘못된 수량·날짜를 거부한다', () => {
    const { workspace, factory, admin, style } = fixture()
    expect(() => saveOperationInWorkspace(workspace, factory, uuid(), style.id, 'label', operationData(workspace), 0, reason)).toThrow('본사')
    const id = uuid(), data = operationData(workspace)
    const next = saveOperationInWorkspace(workspace, admin, id, style.id, 'label', data, 0, reason)
    expect(() => saveOperationInWorkspace(next, admin, id, style.id, 'label', data, 0, reason)).toThrow('VERSION_CONFLICT')
    for (const row of [{ quantity: -1 }, { lossQuantity: 1.5 }, { completedQuantity: 106 }, { orderedAt: '2026-02-30' }]) expect(() => saveOperationInWorkspace(workspace, admin, uuid(), style.id, 'label', operationData(workspace, row), 0, reason)).toThrow()
  })

  it('고정 종류 추가·이름 변경·종류 변경을 거부하고 사용 여부는 관리자만 변경한다', () => {
    const { workspace, admin, internal, factory } = fixture()
    const { id, name } = workspace.operations!.operationCatalogs[0]
    expect(() => saveCatalogInWorkspace(workspace, internal, id, 'label', name, false, 1, reason)).toThrow('관리자')
    expect(() => saveCatalogInWorkspace(workspace, factory, id, 'label', name, false, 1, reason)).toThrow('본사')
    expect(() => saveCatalogInWorkspace(workspace, admin, uuid(), 'label', '임의 추가 라벨', true, 0, reason)).toThrow('정해진 목록')
    expect(() => saveCatalogInWorkspace(workspace, admin, id, 'label', '변경 이름', true, 1, reason)).toThrow('정해진 목록')
    expect(() => saveCatalogInWorkspace(workspace, admin, id, 'label', ` ${name} `, true, 1, reason)).toThrow('정해진 목록')
    expect(() => saveCatalogInWorkspace(workspace, admin, id, 'embroidery', name, true, 1, reason)).toThrow('정해진 목록')
    const inactive = saveCatalogInWorkspace(workspace, admin, id, 'label', name, false, 1, reason)
    expect(inactive.operations!.operationCatalogs.find(c => c.id === id)?.active).toBe(false)
    expect(inactive.operations!.operationCatalogs.find(c => c.id === id)?.version).toBe(2)
    expect(workspace.operations!.operationCatalogs.find(c => c.id === id)?.active).toBe(true)
    expect(() => saveCatalogInWorkspace(inactive, admin, id, 'label', name, true, 1, reason)).toThrow('VERSION_CONFLICT')
    const active = saveCatalogInWorkspace(inactive, admin, id, 'label', name, true, 2, reason)
    expect(active.operations!.operationCatalogs.find(c => c.id === id)).toMatchObject({ active: true, name, kind: 'label', version: 3 })
  })
})

describe('개인 휴가·본사 일정·협력업체 휴무와 이력 개인정보', () => {
  it('개인 휴가 private는 관리자에게도 보이지 않고 HQ 휴가는 본사에만 공유한다', () => {
    const { workspace, admin, internal, factory } = fixture()
    const privateId = uuid(), hqId = uuid()
    const first = saveCalendarInWorkspace(workspace, internal, privateId, calendarData(internal.id), 0, reason)
    const next = saveCalendarInWorkspace(first, internal, hqId, calendarData(internal.id, { visibility: 'hq', title: '테스트 본사 공유 휴가' }), 0, reason)
    expect(scopeOperations(next, internal).calendarEvents.map(e => e.id)).toEqual(expect.arrayContaining([privateId, hqId]))
    expect(scopeOperations(next, admin).calendarEvents.map(e => e.id)).toEqual([hqId])
    expect(scopeOperations(next, factory).calendarEvents).toHaveLength(0)
    expect(canReadCalendarEvent(next.operations!.calendarEvents.find(e => e.id === privateId)!, admin)).toBe(false)
  })

  it('공장은 자기 개인 휴가만 비공개로 만들 수 있고 런칭·업체 휴무를 변경할 수 없다', () => {
    const { workspace, factory } = fixture()
    expect(() => saveCalendarInWorkspace(workspace, factory, uuid(), calendarData(factory.id), 0, reason)).not.toThrow()
    for (const data of [calendarData(factory.id, { visibility: 'hq' }), calendarData(factory.id, { kind: 'launch', visibility: 'all' }), calendarData(factory.id, { kind: 'factory_holiday', visibility: 'hq', factoryId: factory.factoryId })]) expect(() => saveCalendarInWorkspace(workspace, factory, uuid(), data, 0, reason)).toThrow()
  })

  it('본사 직원이 공장 역할로 바뀌면 자신의 HQ 휴가와 이력도 숨기고 개인 비공개 휴가는 유지한다', () => {
    const { workspace, internal, factory } = fixture()
    const privateId = uuid(), hqId = uuid()
    const first = saveCalendarInWorkspace(workspace, internal, privateId, calendarData(internal.id), 0, reason)
    const next = saveCalendarInWorkspace(first, internal, hqId, calendarData(internal.id, { visibility: 'hq', note: '이전 본사 권한 전용 정보-881' }), 0, reason)
    const demoted = { ...internal, role: 'factory' as const, factoryId: factory.factoryId }
    next.profiles = next.profiles.map(profile => profile.id === internal.id ? demoted : profile)
    const ownHQ = next.operations!.calendarEvents.find(event => event.id === hqId)!
    expect(canReadCalendarEvent(ownHQ, demoted)).toBe(false)
    expect(canReadCalendarEvent({ ...ownHQ, visibility: 'all' }, demoted)).toBe(false)
    const scoped = scopeOperations(next, demoted)
    expect(scoped.calendarEvents.map(event => event.id)).toEqual([privateId])
    expect(scoped.calendarEventAudits.map(event => event.eventId)).toEqual([privateId])
    expect(JSON.stringify(scoped)).not.toContain('이전 본사 권한 전용 정보-881')
  })

  it('제품 런칭은 공장에 보이고 협력업체 휴가는 HQ에만 보인다', () => {
    const { workspace, internal, factory, admin } = fixture()
    const launchId = uuid(), holidayId = uuid()
    const first = saveCalendarInWorkspace(workspace, internal, launchId, calendarData(internal.id, { kind: 'launch', visibility: 'all', title: '테스트 런칭' }), 0, reason)
    const next = saveCalendarInWorkspace(first, internal, holidayId, calendarData(internal.id, { kind: 'factory_holiday', visibility: 'hq', factoryId: factory.factoryId }), 0, reason)
    expect(scopeOperations(next, factory).calendarEvents.map(e => e.id)).toEqual([launchId])
    expect(scopeOperations(next, admin).calendarEvents.map(e => e.id)).toEqual(expect.arrayContaining([launchId, holidayId]))
  })

  it('private→HQ 공개로 바뀌어도 과거 비공개 내용의 변경 스냅샷은 다른 본사 직원에게 노출하지 않는다', () => {
    const { workspace, internal, admin } = fixture()
    const id = uuid(), secret = '개인사유비공개-4477'
    const first = saveCalendarInWorkspace(workspace, internal, id, calendarData(internal.id, { note: secret }), 0, reason)
    const next = saveCalendarInWorkspace(first, internal, id, calendarData(internal.id, { visibility: 'hq', title: '본사 공유 일정', note: '공유 가능한 메모' }), 1, reason)
    const owner = scopeOperations(next, internal), hq = scopeOperations(next, admin)
    expect(owner.calendarEventAudits).toHaveLength(2)
    expect(hq.calendarEvents).toHaveLength(1)
    expect(hq.calendarEventAudits).toHaveLength(0)
    expect(JSON.stringify(hq)).not.toContain(secret)
    const third = saveCalendarInWorkspace(next, internal, id, calendarData(internal.id, { visibility: 'hq', title: '본사 공유 일정 수정', note: '공유 메모' }), 2, reason)
    expect(scopeOperations(third, admin).calendarEventAudits).toHaveLength(1)
    expect(JSON.stringify(scopeOperations(third, admin))).not.toContain(secret)
  })

  it('서버 감사 JSON의 owner_id 형식에도 과거 비공개 메모의 접근 제한이 적용된다', () => {
    const { workspace, internal, admin } = fixture()
    const id = uuid(), secret = '서버비공개스냅샷-7799'
    const first = saveCalendarInWorkspace(workspace, internal, id, calendarData(internal.id, { note: secret }), 0, reason)
    const next = saveCalendarInWorkspace(first, internal, id, calendarData(internal.id, { visibility: 'hq', note: '공개 메모' }), 1, reason)
    const snakeCaseSnapshot = (value: unknown) => {
      if (!value || typeof value !== 'object') return value
      const { ownerId, ...rest } = value as Record<string, unknown>
      return { ...rest, owner_id: ownerId }
    }
    next.operations!.calendarEventAudits = next.operations!.calendarEventAudits.map(audit => ({ ...audit, before: snakeCaseSnapshot(audit.before), after: snakeCaseSnapshot(audit.after) }))
    expect(scopeOperations(next, internal).calendarEventAudits).toHaveLength(2)
    expect(JSON.stringify(scopeOperations(next, admin))).not.toContain(secret)
    expect(scopeOperations(next, admin).calendarEventAudits).toHaveLength(0)
  })

  it('일정 작성자·종류를 바꾸거나 다른 직원 개인 휴가를 수정할 수 없다', () => {
    const { workspace, internal, secondInternal, admin } = fixture()
    const id = uuid(), first = saveCalendarInWorkspace(workspace, internal, id, calendarData(internal.id), 0, reason)
    expect(() => saveCalendarInWorkspace(first, secondInternal, id, calendarData(internal.id, { title: '무단 변경' }), 1, reason)).toThrow()
    expect(() => saveCalendarInWorkspace(first, admin, id, calendarData(internal.id, { title: '관리자 무단 변경' }), 1, reason)).toThrow()
    expect(() => saveCalendarInWorkspace(first, internal, id, calendarData(secondInternal.id), 1, reason)).toThrow('작성자')
    expect(() => saveCalendarInWorkspace(first, internal, id, calendarData(internal.id, { kind: 'launch', visibility: 'all' }), 1, reason)).toThrow('종류')
  })

  it('일정 기간·공장·CAS를 검증하고 삭제 이력을 보관한다', () => {
    const { workspace, internal } = fixture()
    for (const data of [calendarData(internal.id, { endDate: '2026-10-01' }), calendarData(internal.id, { kind: 'factory_holiday', visibility: 'hq', factoryId: null })]) expect(() => saveCalendarInWorkspace(workspace, internal, uuid(), data, 0, reason)).toThrow()
    const id = uuid(), first = saveCalendarInWorkspace(workspace, internal, id, calendarData(internal.id), 0, reason)
    expect(() => saveCalendarInWorkspace(first, internal, id, calendarData(internal.id), 0, reason)).toThrow('VERSION_CONFLICT')
    const deleted = saveCalendarInWorkspace(first, internal, id, calendarData(internal.id, { deleted: true }), 1, reason)
    expect(deleted.operations!.calendarEvents[0].deletedAt).not.toBeNull()
    expect(deleted.operations!.calendarEventAudits[0].action).toContain('삭제')
    expect(first.operations!.calendarEvents[0].deletedAt).toBeNull()
  })
})

describe('담당자 복수 공장 배정과 업무 조회 범위', () => {
  it('관리자는 본사 담당자에게 여러 공장을 배정하고 해제할 수 있다', () => {
    const { workspace, admin, internal } = fixture()
    const ids = [DEMO_IDS.vietnam, DEMO_IDS.china]
    const next = saveAssignmentInWorkspace(workspace, admin, internal.id, ids, 0, reason)
    expect(next.operations!.employeeFactoryAssignments[0].factoryIds).toEqual([...ids].sort())
    expect(workspace.operations!.employeeFactoryAssignments).toHaveLength(0)
    const cleared = saveAssignmentInWorkspace(next, admin, internal.id, [], 1, reason)
    expect(cleared.operations!.employeeFactoryAssignments[0].factoryIds).toEqual([])
    expect(cleared.operations!.employeeFactoryAssignments[0].version).toBe(2)
  })

  it('복수 담당 공장 목록은 내부 직원의 전체 스타일 조회를 제한하지 않는다', () => {
    const { workspace, admin, internal } = fixture()
    const next = saveAssignmentInWorkspace(workspace, admin, internal.id, [DEMO_IDS.china], 0, reason)
    expect(next.styles.filter(style => canViewStyle(internal, style))).toHaveLength(next.styles.length)
    expect(next.styles.some(style => style.factoryId !== DEMO_IDS.china && canViewStyle(internal, style))).toBe(true)
  })

  it('본사 직원은 본사 동료만 배정하며 공장 사용자·미등록·중복 공장·오래된 버전은 거부한다', () => {
    const { workspace, admin, internal, factory } = fixture()
    expect(saveAssignmentInWorkspace(workspace, internal, internal.id, [], 0, reason).operations!.employeeFactoryAssignments[0].employeeId).toBe(internal.id)
    expect(() => saveAssignmentInWorkspace(workspace, internal, admin.id, [], 0, reason)).toThrow('관리자')
    expect(() => saveAssignmentInWorkspace(workspace, factory, internal.id, [], 0, reason)).toThrow('본사')
    for (const ids of [[DEMO_IDS.china, DEMO_IDS.china], [uuid()]]) expect(() => saveAssignmentInWorkspace(workspace, admin, internal.id, ids, 0, reason)).toThrow()
    expect(() => saveAssignmentInWorkspace(workspace, admin, factory.id, [], 0, reason)).toThrow('본사 담당자')
    const next = saveAssignmentInWorkspace(workspace, admin, internal.id, [], 0, reason)
    expect(() => saveAssignmentInWorkspace(next, admin, internal.id, [DEMO_IDS.china], 0, reason)).toThrow('VERSION_CONFLICT')
  })

  it('공장 scope는 자기 스타일의 업무·PO 시도만 남기고 담당자 배정·카탈로그를 숨긴다', () => {
    const { workspace, admin, factory, style } = fixture()
    const other = workspace.styles.find(s => s.factoryId !== factory.factoryId)!
    const ownPo = uuid(), otherPo = uuid()
    let next = savePoInWorkspace(workspace, admin, ownPo, style.id, poData(), 0, reason)
    next = savePoInWorkspace(next, admin, otherPo, other.id, poData(), 0, reason)
    next.operations!.poDispatches = next.operations!.poDispatches.map(po => ({ ...po, status: 'sent', sentAt: stamp.createdAt, providerMessageId: `fixture-${po.id}` }))
    next.operations!.poDispatchAttempts = [ownPo, otherPo].map((dispatchId, index) => ({ id: uuid(), dispatchId, attempt: 1, status: 'failed', snapshot: { private: index ? 'foreign-only-4477' : 'own-only' }, providerMessageId: null, error: 'test', startedAt: stamp.createdAt, finishedAt: stamp.createdAt, actorId: admin.id }))
    next = saveAssignmentInWorkspace(next, admin, admin.id, [DEMO_IDS.china], 0, reason)
    const scoped = scopeOperations(next, factory)
    expect(scoped.poDispatches.map(p => p.id)).toEqual([ownPo])
    expect(scoped.poDispatchAttempts).toHaveLength(1)
    expect(scoped.operationCatalogs).toHaveLength(0)
    expect(scoped.employeeFactoryAssignments).toHaveLength(0)
    expect(JSON.stringify(scoped)).not.toContain('foreign-only-4477')
    next.operations!.poDispatches.find(po => po.id === ownPo)!.status = 'draft'
    expect(scopeOperations(next, factory).poDispatches).toHaveLength(0)
  })
})

describe('일괄 오더 적용 원자성 및 버전 충돌', () => {
  it('여러 스타일의 수량을 함께 적용하고 각 스타일 버전·사유를 기록한다', () => {
    const { workspace, internal } = fixture()
    const changes = [orderChange(workspace, 0, quantities(40)), orderChange(workspace, 1, quantities(70))]
    const original = structuredClone(workspace)
    const next = importOrdersInWorkspace(workspace, internal, changes, 'replace', reason)
    expect(workspace).toEqual(original)
    changes.forEach(change => { const style = next.styles.find(s => s.id === change.styleId)!; expect(style.version).toBe(change.expectedVersion + 1); expect(style.production[0].order.S).toBe(change.lines[0].quantities.S) })
    expect(next.audits.filter(a => a.action === '오더 엑셀 일괄 적용')).toHaveLength(2)
    expect(next.audits[0].reason).toBe(reason)
  })

  it('추가 적용은 오더에만 합산하고 출고·입고 및 다른 체크리스트는 보존한다', () => {
    const { workspace, admin } = fixture()
    const before = structuredClone(workspace.styles[0]), change = orderChange(workspace, 0, quantities(10))
    const next = importOrdersInWorkspace(workspace, admin, [change], 'add', reason)
    const after = next.styles.find(s => s.id === before.id)!
    expect(after.production[0].order.S).toBe(before.production[0].order.S + 10)
    expect(after.production[0].shipped).toEqual(before.production[0].shipped)
    expect(after.production[0].received).toEqual(before.production[0].received)
    expect(after.production[0].checks).toEqual(before.production[0].checks)
  })

  it('두 번째 행이 잘못되어도 첫 번째 정상 스타일·버전·감사 이력까지 원본에 반영되지 않는다', () => {
    const { workspace, admin } = fixture()
    const original = structuredClone(workspace)
    const good = orderChange(workspace, 0), bad = orderChange(workspace, 1)
    bad.lines[0].color = 'ZZ'
    expect(() => importOrdersInWorkspace(workspace, admin, [good, bad], 'replace', reason)).toThrow('일치하지 않는')
    expect(workspace).toEqual(original)
  })

  it('첫 번째 정상 스타일 뒤에 오래된 버전이 있으면 전체 변경이 취소된다', () => {
    const { workspace, admin } = fixture()
    const original = structuredClone(workspace)
    const first = orderChange(workspace, 0), stale = orderChange(workspace, 1)
    stale.expectedVersion -= 1
    expect(() => importOrdersInWorkspace(workspace, admin, [first, stale], 'add', reason)).toThrow('VERSION_CONFLICT')
    expect(workspace).toEqual(original)
  })

  it('공장 가져오기·중복 스타일·중복 컬러·음수·합산 상한 초과를 거부한다', () => {
    const { workspace, admin, factory } = fixture()
    const change = orderChange(workspace, 0)
    expect(() => importOrdersInWorkspace(workspace, factory, [change], 'replace', reason)).toThrow('본사')
    expect(() => importOrdersInWorkspace(workspace, admin, [change, change], 'replace', reason)).toThrow('범위')
    const duplicate = { ...change, lines: [change.lines[0], change.lines[0]] }
    expect(() => importOrdersInWorkspace(workspace, admin, [duplicate], 'replace', reason)).toThrow('중복')
    expect(() => importOrdersInWorkspace(workspace, admin, [orderChange(workspace, 0, quantities(-1))], 'replace', reason)).toThrow('정수')
    expect(() => importOrdersInWorkspace(workspace, admin, [orderChange(workspace, 0, quantities(10000000))], 'add', reason)).toThrow('정수')
  })
})

describe('ORDER QTY 지정 열 저장·본사 수동 수정·일괄 적용 원자성', () => {
  it('16개 원본 열을 손실 없이 저장하며 수량과 별개 버전으로 본사가 수정한다', () => {
    const { workspace, internal, style, line } = fixture()
    const data = sourceData(), before = structuredClone(workspace)
    data.rows[0].columns.A = '개인적인 원본값-출력금지-901'
    data.rows[0].columns.L = null; data.rows[0].columns.M = true
    data.rows[0].columns.S = '=SUM(A1:A2)'
    const first = saveOrderSourceInWorkspace(workspace, internal, style.id, line.id, data, 0, reason)
    expect(workspace).toEqual(before)
    expect(first.operations!.orderSourceRecords[0]).toMatchObject({ styleId: style.id, lineId: line.id, version: 1, ...data })
    expect(first.styles).toEqual(workspace.styles)
    const changed = structuredClone(data); changed.rows[0].columns.L = '본사 수동 변경'
    const second = saveOrderSourceInWorkspace(first, internal, style.id, line.id, changed, 1, reason)
    expect(second.operations!.orderSourceRecords[0].version).toBe(2)
    expect(second.operations!.orderSourceRecords[0].rows[0].columns.L).toBe('본사 수동 변경')
    expect(JSON.stringify(second.audits)).not.toContain('개인적인 원본값-출력금지-901')
    expect(second.audits[0].after).toEqual({ styleId: style.id, lineId: line.id, version: 2, rowCount: 1 })
  })

  it('공장에 원본정보를 숨기고 변경을 거부하며 위조한 본사 역할도 거부한다', () => {
    const { workspace, admin, factory, internal, style, line } = fixture()
    const first = saveOrderSourceInWorkspace(workspace, admin, style.id, line.id, sourceData(), 0, reason)
    expect(scopeOperations(first, internal).orderSourceRecords).toHaveLength(1)
    expect(scopeOperations(first, factory).orderSourceRecords).toEqual([])
    expect(() => saveOrderSourceInWorkspace(first, factory, style.id, line.id, sourceData(), 1, reason)).toThrow('본사')
    expect(() => saveOrderSourceInWorkspace(first, { ...factory, role: 'admin' }, style.id, line.id, sourceData(), 1, reason)).toThrow('본사')
  })

  it('누락·추가 열, 수식 객체, 무한 수·과도한 문자열, 중복·잘못된 행번호를 거부한다', () => {
    const missing = sourceData(); delete missing.rows[0].columns.A
    const extra = sourceData(); extra.rows[0].columns.UNKNOWN = 'x'
    const missingHeader = sourceData(); delete missingHeader.headers.A
    const object = sourceData(); object.rows[0].columns.F = { formula: 'SECRET()' } as never
    const infinite = sourceData(); infinite.rows[0].columns.A = Number.POSITIVE_INFINITY
    const huge = sourceData(); huge.rows[0].columns.A = 1e15 + 1
    const long = sourceData(); long.rows[0].columns.A = 'x'.repeat(4001)
    const repeatedRow = sourceData(); repeatedRow.rows.push(structuredClone(repeatedRow.rows[0]))
    const row = sourceData(); row.rows[0].rowNumber = 10001
    const blank = sourceData({ fileName: ' ' })
    const many = sourceData(); many.rows = Array.from({ length: 101 }, (_, index) => ({ ...structuredClone(many.rows[0]), rowNumber: index + 1 }))
    for (const invalid of [missing, extra, missingHeader, object, infinite, huge, long, repeatedRow, row, blank, many]) expect(() => validateOrderSourceData(invalid)).toThrow('ORDER QTY')
  })

  it('한글 데이터를 포함한 총 UTF-8 크기가 1MB를 넘으면 저장을 거부한다', () => {
    const data = sourceData()
    const columns = Object.fromEntries(ORDER_SOURCE_COLUMNS.map(column => [column, '가'.repeat(4000)]))
    data.rows = Array.from({ length: 6 }, (_, index) => ({ rowNumber: index + 1, columns: { ...columns } }))
    expect(() => validateOrderSourceData(data)).toThrow('1MB')
  })

  it('원본정보 CAS와 생산 컬러 연결을 검증하며 실패 시 원본을 보존한다', () => {
    const { workspace, admin, style, line } = fixture()
    const first = saveOrderSourceInWorkspace(workspace, admin, style.id, line.id, sourceData(), 0, reason)
    const before = structuredClone(first)
    expect(() => saveOrderSourceInWorkspace(first, admin, style.id, line.id, sourceData(), 0, reason)).toThrow('VERSION_CONFLICT')
    expect(() => saveOrderSourceInWorkspace(first, admin, style.id, uuid(), sourceData(), 0, reason)).toThrow('생산 컬러')
    expect(first).toEqual(before)
  })

  it('수량이 같아도 최초 원본을 함께 저장하며 이후 수량 변경과 원본 갱신을 함께 반영한다', () => {
    const { workspace, internal } = fixture()
    const change = orderChange(workspace, 0, workspace.styles[0].production[0].order)
    change.lines[0].source = { ...sourceData(), expectedVersion: 0 }
    const first = importOrdersInWorkspace(workspace, internal, [change], 'replace', reason)
    expect(first.operations!.orderSourceRecords[0].version).toBe(1)
    expect(first.styles.find(item => item.id === change.styleId)!.production[0].order).toEqual(workspace.styles[0].production[0].order)
    const nextChange = orderChange(first, first.styles.findIndex(item => item.id === change.styleId), quantities(45))
    nextChange.lines[0].source = { ...sourceData({ fileName: '새 원본.csv' }), expectedVersion: 1 }
    const second = importOrdersInWorkspace(first, internal, [nextChange], 'replace', reason)
    expect(second.styles.find(item => item.id === change.styleId)!.production[0].order.S).toBe(45)
    expect(second.operations!.orderSourceRecords[0]).toMatchObject({ fileName: '새 원본.csv', version: 2 })
  })

  it('원본정보 충돌이나 후속 스타일 실패는 수량·원본·버전·감사 기록을 전부 취소한다', () => {
    const { workspace, admin } = fixture()
    const style = workspace.styles[0], line = style.production[0]
    const first = saveOrderSourceInWorkspace(workspace, admin, style.id, line.id, sourceData(), 0, reason)
    const before = structuredClone(first)
    const change = orderChange(first, 0, quantities(456))
    change.lines[0].source = { ...sourceData(), expectedVersion: 0 }
    expect(() => importOrdersInWorkspace(first, admin, [change], 'replace', reason)).toThrow('VERSION_CONFLICT')
    expect(first).toEqual(before)
    change.lines[0].source.expectedVersion = 1
    const bad = orderChange(first, 1); bad.expectedVersion -= 1
    expect(() => importOrdersInWorkspace(first, admin, [change, bad], 'replace', reason)).toThrow('VERSION_CONFLICT')
    expect(first).toEqual(before)
  })
})
