import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import MainProductionContextSummary from '../src/components/MainProductionContextSummary'
import type { ProductionRun, ProductionSettlementSnapshot } from '../src/lib/production-ledger'
import { createSeed } from '../src/lib/seed'
import { getDemoSupplierProductionOrders } from '../src/lib/supplier-orders'
import { emptyQuantities, type Workspace } from '../src/lib/types'

function fixture() {
  const workspace: Workspace = { ...createSeed(), productionLedgerAvailable: true, productionRuns: [], productionReceipts: [], productionConditions: [] }
  const style = workspace.styles[0], line = style.production[0]
  const projectA = style.projectId, projectB = crypto.randomUUID()
  workspace.projects = [{ id: projectA, code: 'QA-PRIVATE-A', name: 'QA 프로젝트 A', season: '2026FY' }, { id: projectB, code: 'QA-PRIVATE-B', name: 'QA 프로젝트 B', season: '2026FY' }]
  line.received = { ...emptyQuantities(), M: 999 }
  const run = (projectId: string, quantity: number, round: number): ProductionRun => ({
    id: crypto.randomUUID(), styleId: style.id, lineId: line.id, projectId, projectCode: 'QA-PRIVATE-CODE', name: `QA 생산 ${round}`, round,
    expectedDue: '2026-11-25', poId: null, unitCost: 991234, itemType: 'product', order: { ...emptyQuantities(), M: quantity }, correctsRunId: null,
    factoryIdSnapshot: style.factoryId, factoryNameSnapshot: 'QA 공장', ownerIdSnapshot: style.ownerId, ownerNameSnapshot: 'QA 담당', styleCodeSnapshot: `${style.code}${line.color}`,
    version: 1, createdAt: '', updatedAt: '', updatedBy: style.ownerId, closedAt: null, snapshot: null,
  })
  const a = run(projectA, 10, 1), b = run(projectB, 90, 2)
  workspace.productionRuns = [a, b]
  workspace.productionReceipts = [a, b].map((item, index) => ({ id: crypto.randomUUID(), runId: item.id, styleId: style.id, lineId: line.id, receivedAt: '2026-11-09', quantities: { ...emptyQuantities(), M: index ? 30 : 4 }, unitCost: item.unitCost!, netAmount: 1, voided: false, version: 1, createdAt: '', createdBy: style.ownerId }))
  return { workspace, style, line, projectA, projectB, a, b }
}
const render = (f: ReturnType<typeof fixture>, projectId: string, runId?: string) => renderToStaticMarkup(createElement(MainProductionContextSummary, { workspace: f.workspace, style: f.style, lineId: f.line.id, projectId, runId }))

describe('메인 생산 프로젝트별 읽기 전용 현황', () => {
  it('같은 컬러의 다른 프로젝트와 전체 누적 수량을 섞지 않는다', () => {
    const f = fixture(), before = structuredClone(f.workspace), html = render(f, f.projectB, f.b.id)
    expect(html).toContain('QA 프로젝트 B')
    expect(html).toContain('90장'); expect(html).toContain('30장'); expect(html).toContain('60장')
    expect(html).not.toContain('999장'); expect(html).not.toContain('10장'); expect(html).not.toContain('QA-PRIVATE')
    expect(f.workspace).toEqual(before)
  })
  it('복수 차수나 다른 프로젝트의 명시 차수를 임의의 첫 차수로 대신하지 않는다', () => {
    const f = fixture()
    f.workspace.productionRuns!.push({ ...structuredClone(f.a), id: crypto.randomUUID(), round: 3 })
    const ambiguous = render(f, f.projectA)
    expect(ambiguous).toContain('메인 생산 현황 차수'); expect(ambiguous).toContain('생산 차수를 선택해 주세요.')
    expect(ambiguous).not.toContain('<dt>오더 수량</dt>')
    const wrongRun = render(f, f.projectA, f.b.id)
    expect(wrongRun).not.toContain('<dt>오더 수량</dt>'); expect(wrongRun).not.toContain('90장')
  })
  it('마감된 차수는 현재 수량보다 확정 스냅샷을 우선한다', () => {
    const f = fixture()
    f.b.closedAt = '2026-11-09T00:00:00Z'
    f.b.snapshot = { ...f.b, styleCode: f.b.styleCodeSnapshot, factory: 'QA 확정 공장', owner: 'QA 확정 담당', unitCost: 991234, orderQuantity: 70, receivedQuantity: 55, netAmount: 1, vatAmount: 0.1, grossAmount: 1.1, lastReceivedAt: '2026-11-09', receipts: [], expectedDue: '2026-11-24', finalizedAt: f.b.closedAt, finalizedBy: f.style.ownerId } as ProductionSettlementSnapshot
    const html = render(f, f.projectB, f.b.id)
    expect(html).toContain('70장'); expect(html).toContain('55장'); expect(html).toContain('15장'); expect(html).toContain('마감 확정'); expect(html).toContain('2026-11-24')
    expect(html).not.toContain('90장'); expect(html).not.toContain('991234')
  })
  it('업체용 공개 오더만 있을 때 비공개 차수 입고를 전체 누적 수량으로 추정하지 않는다', () => {
    const f = fixture()
    f.workspace.supplierProductionOrders = getDemoSupplierProductionOrders(f.workspace)
    f.workspace.productionRuns = []; f.workspace.productionReceipts = []
    const html = render(f, f.projectB, f.b.id)
    expect(html).toContain('QA 프로젝트 B'); expect(html).toContain('90장'); expect(html).toContain('확인 기록 없음')
    expect(html).not.toContain('999장'); expect(html).not.toContain('30장'); expect(html).not.toContain('991234'); expect(html).not.toContain('QA-PRIVATE')
  })
})
