import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { freshOperations } from '../src/lib/operations-domain'
import { saveProductionRunInWorkspace } from '../src/lib/production-ledger'
import { emptyQuantities } from '../src/lib/types'
import type { PoDispatch } from '../src/lib/operations-types'
import { captureStylePoContextInWorkspace, captureRunPoContextInWorkspace, linkProductionPoInWorkspace, scopeProductionPoLinks, getArchivedProductionPoCandidate, replaceArchivedProductionPoLinkInWorkspace, type ProductionPoLinkConfirmation } from '../src/lib/production-po-links'

function fixture() {
  let workspace = { ...createSeed(), operations: freshOperations(), productionLedgerAvailable: true, productionPoLinksAvailable: true, productionPoRecoveryAvailable: true, productionRuns: [], productionReceipts: [] }
  const style = workspace.styles[1], line = style.production[0], admin = workspace.profiles.find(item => item.id === DEMO_IDS.admin)!, factory = workspace.profiles.find(item => item.id === DEMO_IDS.factory)!
  const runId = crypto.randomUUID(), poId = crypto.randomUUID()
  workspace = saveProductionRunInWorkspace(workspace, admin, runId, style.id, line.id, { name: 'QA 차수', projectId: style.projectId, projectCode: 'QA-PROJECT', expectedDue: '2026-12-01', poId: null, unitCost: null, itemType: 'product', order: { ...emptyQuantities(), S: 10 }, correctsRunId: null }, 0, 'QA 차수 등록') as typeof workspace
  const po: PoDispatch = { id: poId, styleId: style.id, dueDate: '2026-12-01', recipient: 'factory@example.test', subject: 'QA 실제 발송 문서', body: '원본 발송 내역 유지', evidenceAttachmentId: null, status: 'sent', sentAt: '2026-10-28T00:00:00Z', providerMessageId: null, provider: 'outlook', providerRequestId: crypto.randomUUID(), senderEmailSnapshot: 'hq@example.test', lastError: null, attempts: 1, idempotencyKey: 'qa-po', factoryIdSnapshot: style.factoryId, styleCodeSnapshot: style.code, voided: false, version: 3, createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z', updatedBy: admin.id }
  workspace.operations!.poDispatches.push(po)
  const run = workspace.productionRuns![0]
  const confirmation: ProductionPoLinkConfirmation = { documentConfirmed: true, scopeDifferenceConfirmed: true, sourceSnapshotMissingConfirmed: true, projectId: run.projectId, styleCode: run.styleCodeSnapshot, color: line.color, factoryId: run.factoryIdSnapshot, order: { ...run.order } }
  const link = (changes: Partial<ProductionPoLinkConfirmation> = {}, actor = admin, version = 1) => linkProductionPoInWorkspace(workspace, actor, runId, poId, version, 3, { ...confirmation, ...changes }, 'QA 발송 문서 확인 연결')
  return { workspace, style, line, admin, factory, run, runId, po, poId, confirmation, link }
}

describe('생산 차수 PO 명시적 연결', () => {
  it('기존 발송 PO를 확인 후 연결하되 발송 문서·추적 ID·가격·메인 수량은 그대로 유지한다', () => {
    const { workspace, link, poId } = fixture(), before = structuredClone(workspace), next = link()
    expect(next.productionRuns![0]).toMatchObject({ poId, version: 2, unitCost: null })
    expect(next.operations).toEqual(before.operations); expect(next.styles).toEqual(before.styles)
    expect(next.audits[0]).toMatchObject({ action: '생산 차수 PO 확인 연결', after: { verification: 'legacy_document_confirmed' } })
    expect(workspace).toEqual(before)
  })
  it('실제 발송 문서와 기존 원본 비교 정보 미등록 확인을 각각 요구한다', () => {
    const { link } = fixture()
    expect(() => link({ documentConfirmed: false })).toThrow(/발송 문서/)
    expect(() => link({ sourceSnapshotMissingConfirmed: false })).toThrow(/비교 정보 미등록/)
    expect(() => link({ scopeDifferenceConfirmed: false })).toThrow(/집계 범위 차이/)
  })
  it('프로젝트·전체 품번·컬러·공장·사이즈 수량 중 하나라도 다르면 거부한다', () => {
    const { link } = fixture()
    for (const override of [{ projectId: crypto.randomUUID() }, { styleCode: 'OTHERBK' }, { color: 'ZZ' }, { factoryId: crypto.randomUUID() }, { order: { ...emptyQuantities(), S: 11 } }]) expect(() => link(override)).toThrow(/프로젝트·품번·컬러·업체·차수 수량/)
  })
  it('공장·위조 역할·비활성 계정과 오래된 버전은 연결하지 못한다', () => {
    const { workspace, factory, admin, link } = fixture()
    expect(() => link({}, { ...factory, role: 'admin' })).toThrow(/본사/)
    expect(() => link({}, admin, 0)).toThrow(/VERSION_CONFLICT/)
    workspace.profiles.find(item => item.id === admin.id)!.active = false
    expect(() => link()).toThrow(/승인된 본사/)
  })
  it('이미 연결된 PO·마감·입고 이력은 재연결하지 못한다', () => {
    const { workspace, link, poId, run } = fixture()
    workspace.productionRuns!.push({ ...run, id: crypto.randomUUID(), poId })
    expect(() => link()).toThrow(/이미 연결/)
    workspace.productionRuns!.pop(); workspace.productionRuns![0].closedAt = '2026-10-28T00:00:00Z'
    expect(() => link()).toThrow(/마감/)
  })
  it('새 PO 작성 당시의 컬러별 누적 수량을 캡처하고 변경된 현재 값으로 대체하지 않는다', () => {
    const { workspace, poId, style } = fixture()
    const captured = captureStylePoContextInWorkspace(workspace, poId)
    expect(captured.productionPoContexts).toHaveLength(1)
    expect(captured.productionPoContexts![0].snapshot.lines[0].order).toEqual(style.production[0].order)
    const again = captureStylePoContextInWorkspace(captured, poId)
    expect(again.productionPoContexts).toEqual(captured.productionPoContexts)
    expect(scopeProductionPoLinks(captured, captured.profiles.find(item => item.id === DEMO_IDS.factory)!).productionPoContexts).toEqual([])
  })
  it('촬영된 원본 프로젝트가 다른 PO는 확인 체크로 우회하지 못한다', () => {
    const { workspace, poId, admin, runId, confirmation } = fixture()
    const captured = captureStylePoContextInWorkspace(workspace, poId)
    captured.productionPoContexts![0].snapshot.projectId = crypto.randomUUID()
    expect(() => linkProductionPoInWorkspace(captured, admin, runId, poId, 1, 3, confirmation, '원본 확인')).toThrow(/원본의 프로젝트/)
  })
  it('생산 차수 PO의 원본에는 내부 원가 없이 정확한 컬러·사이즈·생산 방식을 보존한다', () => {
    const { workspace, poId, runId, run } = fixture()
    workspace.productionRuns![0].poId = poId
    workspace.operations!.poDispatches[0].status = 'draft'; workspace.operations!.poDispatches[0].attempts = 0
    const result = captureRunPoContextInWorkspace(workspace, runId, 'cmt')
    expect(result.productionPoContexts![0]).toMatchObject({ source: 'run', snapshot: { runId, lineId: run.lineId, styleCode: run.styleCodeSnapshot, order: run.order, productionMode: 'cmt' } })
    expect(JSON.stringify(result.productionPoContexts)).not.toMatch(/unitCost|internal/)
  })
})

function recoveryFixture() {
  const fixtureData = fixture(), { workspace, po, run, admin, confirmation } = fixtureData
  const previous: PoDispatch = { ...structuredClone(po), id: crypto.randomUUID(), subject: '보관된 차수 PO 초안', body: '기존 초안 보존', status: 'draft', attempts: 0, voided: true, sentAt: '', providerRequestId: null, senderEmailSnapshot: null, version: 2 }
  workspace.operations!.poDispatches.push(previous)
  run.poId = previous.id
  const recover = (overrides: Partial<ProductionPoLinkConfirmation> = {}, actor = admin, oldVersion = previous.version) => replaceArchivedProductionPoLinkInWorkspace(workspace, actor, run.id, previous.id, po.id, run.version, oldVersion, po.version, { ...confirmation, ...overrides }, '보관 초안 연결을 확인한 발송 PO로 교체')
  return { ...fixtureData, previous, recover }
}

describe('보관된 생산 차수 PO 연결 복구', () => {
  it('보관된 초안 연결을 실제 발송 PO로 한 번만 교체하며 문서·접수·수량·단가를 보존한다', () => {
    const { workspace, recover, po, previous } = recoveryFixture(), before = structuredClone(workspace)
    const next = recover()
    expect(next.productionRuns![0]).toMatchObject({ poId: po.id, version: 2, order: before.productionRuns![0].order, unitCost: null })
    expect(next.operations).toEqual(before.operations)
    expect(next.styles).toEqual(before.styles)
    expect(next.audits[0]).toMatchObject({ action: '보관된 생산 차수 PO 연결 교체', before: { poId: previous.id, poVersion: 2 }, after: { poId: po.id, previousPoId: previous.id } })
    expect(workspace).toEqual(before)
  })
  it('문서 확인이나 신규 발송 PO 검증이 실패하면 기존 연결을 해제하지 않는다', () => {
    const { workspace, recover, po } = recoveryFixture(), before = structuredClone(workspace)
    expect(() => recover({ documentConfirmed: false })).toThrow(/발송 문서/)
    expect(workspace).toEqual(before)
    po.status = 'unknown'
    expect(() => recover()).toThrow(/발송된/)
    expect(workspace.productionRuns![0].poId).toBe(before.productionRuns![0].poId)
  })
  it('기존 초안의 발송 시도·접수 흔적·일반 미보관 상태와 버전 충돌을 거부한다', () => {
    const { workspace, run, previous, recover } = recoveryFixture()
    expect(getArchivedProductionPoCandidate(workspace, run)?.id).toBe(previous.id)
    expect(() => recover({}, undefined, 1)).toThrow(/VERSION_CONFLICT/)
    for (const change of [{ voided: false }, { attempts: 1 }, { sentAt: '2026-10-29T00:00:00Z' }, { providerMessageId: 'receipt' }, { providerRequestId: 'receipt' }, { senderEmailSnapshot: 'sender@example.test' }]) {
      const original = structuredClone(previous)
      Object.assign(previous, change)
      expect(getArchivedProductionPoCandidate(workspace, run)).toBeNull()
      expect(() => recover()).toThrow(/이력이 없는/)
      Object.assign(previous, original)
    }
  })
  it('실제 본사 권한과 적용된 서버 복구 기능이 필요하다', () => {
    const { workspace, recover, factory } = recoveryFixture()
    expect(() => recover({}, { ...factory, role: 'admin' })).toThrow(/본사/)
    workspace.productionPoRecoveryAvailable = false
    expect(() => recover()).toThrow(/복구 설정/)
  })
  it('입고 또는 협의·승인 이력이 있는 차수는 복구 후보가 아니다', () => {
    const { workspace, run, recover } = recoveryFixture()
    workspace.productionConditions = [{ runId: run.id, runVersion: 1, poVersion: 2, version: 1, productionMode: 'cmt', status: 'revision_requested', legacy: false, proposal: null, approval: null, timeline: [], changeRequests: [] }]
    expect(getArchivedProductionPoCandidate(workspace, run)).toBeNull()
    expect(() => recover()).toThrow(/협의/)
    workspace.productionConditions = []
    run.closedAt = '2026-10-29T00:00:00Z'
    expect(getArchivedProductionPoCandidate(workspace, run)).toBeNull()
  })
})
