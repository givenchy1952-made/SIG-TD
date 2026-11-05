import { describe, expect, it } from 'vitest'
import { blankProduction, emptyQuantities, type Quantities, type Style, type Workspace } from '../src/lib/types'
import type { ProductionRun, ProductionReceipt } from '../src/lib/production-ledger'
import type { ProductionCondition } from '../src/lib/production-conditions'
import { buildExecutiveProductionReport, executiveMonthRange, normalizeProductionCountry } from '../src/lib/executive-production'

const NOW = '2026-11-05T01:00:00Z'
const q = (S = 0, M = 0): Quantities => ({ ...emptyQuantities(), S, M })
function fixture(order = q(100), received = q(), dueDate = '2026-11-20'): Workspace {
  const line = { ...blankProduction('BK'), id: 'line', order, received }
  const style: Style = { id: 'style', code: 'QAEXEC01', name: '운영 집계 검증 스타일', category: '상의', projectId: 'p-a', season: '2026FY', factoryId: 'kr', ownerId: 'admin', colors: ['BK'], dueDate, stage: 'production', ppApproved: true, notes: '내부 원가 메모', samples: [], production: [line], version: 1, updatedAt: NOW, updatedBy: 'admin', deletedAt: null }
  return { profiles: [
    { id: 'admin', name: '본사 관리자', email: 'admin@example.test', role: 'admin', approved: true, active: true, factoryId: null },
    { id: 'internal', name: '본사 직원', email: 'internal@example.test', role: 'internal', approved: true, active: true, factoryId: null },
    { id: 'vendor', name: '외부 업체', email: 'vendor@example.test', role: 'factory', approved: true, active: true, factoryId: 'kr' },
  ], factories: [{ id: 'kr', name: '한국 공장', country: '대한민국' }, { id: 'vn', name: '베트남 공장', country: 'VN' }, { id: 'unknown', name: '국가 없는 공장', country: '-' }], projects: [{ id: 'p-a', name: '시그니피컨트 2026 11M-1', code: 'SIGNIFICANT-2026FY-RPQ-46318', season: '2026FY' }, { id: 'p-b', name: '시그니피컨트 2027 1M', code: 'SIGNIFICANT-2027FY-RPQ-99999', season: '2027FY' }], styles: [style], comments: [], attachments: [], audits: [], productionRuns: [], productionReceipts: [], partialDeliveryPlans: [], productionConditions: [] }
}
function run(id = 'run', order = q(100), overrides: Partial<ProductionRun> = {}): ProductionRun {
  return { id, styleId: 'style', lineId: 'line', round: 1, name: '검증 생산 차수', projectId: 'p-a', projectCode: 'SIGNIFICANT-2026FY-RPQ-46318', expectedDue: '2026-11-20', poId: null, unitCost: 999, itemType: 'product', order, correctsRunId: null, factoryIdSnapshot: 'kr', ownerIdSnapshot: 'admin', styleCodeSnapshot: 'QAEXEC01BK', factoryNameSnapshot: '당시 한국 공장', ownerNameSnapshot: '본사 관리자', version: 1, createdAt: NOW, updatedAt: NOW, updatedBy: 'admin', closedAt: null, snapshot: null, ...overrides }
}
function receipt(id: string, runId: string, quantities: Quantities, receivedAt = '2026-11-04', overrides: Partial<ProductionReceipt> = {}): ProductionReceipt {
  return { id, runId, styleId: 'style', lineId: 'line', quantities, receivedAt, unitCost: 999, netAmount: 999, voided: false, version: 1, createdAt: NOW, createdBy: 'admin', ...overrides }
}
function condition(runId: string, status: ProductionCondition['status']): ProductionCondition {
  return { runId, runVersion: 1, poVersion: null, version: 1, productionMode: 'full_package', status, legacy: false, proposal: null, approval: null, timeline: [], changeRequests: [] }
}
function report(workspace: Workspace, options: Partial<Parameters<typeof buildExecutiveProductionReport>[1]> = {}) {
  return buildExecutiveProductionReport(workspace, { profileId: 'admin', fromMonth: '2026-11', toMonth: '2027-03', asOf: '2026-11-05', ...options })
}
function sizedPlan(workspace: Workspace, runId: string, entries: [string, Quantities][]) {
  workspace.partialDeliveryPlans = [{ runId, version: 1, updatedAt: NOW, updatedBy: 'admin', items: entries.map(([dueDate, quantities], i) => ({ id: `installment-${i}`, dueDate, quantity: Object.values(quantities).reduce((sum, n) => sum + n, 0), quantities, note: '' })) }]
}

describe('본사 생산 경영 집계의 실제 기록과 예정 수량 분리', () => {
  it('기존 메인 수량은 한 번 집계하고 누적 입고의 마지막 기록일 한계를 표시한다', () => {
    const w = fixture(q(100), q(20)); w.styles[0].production[0].receivedAt = '2026-10-31'
    const before = structuredClone(w), result = report(w)
    expect(result.months.map(month => month.month)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02', '2027-03'])
    expect(result.months[0]).toMatchObject({ planned: { total: 100, domestic: 100 }, expected: { total: 80, domestic: 80 }, received: { total: 0 } })
    expect(result.current).toEqual({ ordered: 100, received: 20, outstanding: 80, producing: 0, awaiting: 0, statusUnknown: 80 })
    expect(result.coverage.legacyReceiptQuantity).toBe(20)
    expect(result.countries[0]).toMatchObject({ country: '대한민국', current: 80 })
    expect(w).toEqual(before)
    expect(JSON.stringify(result)).not.toContain('SIGNIFICANT-2026FY-RPQ-46318')
    expect(JSON.stringify(result)).not.toContain('999')
    expect(JSON.stringify(result)).not.toContain('내부 원가 메모')
  })
  it('사이즈별 파샬을 우선 사용하고 실제 입고를 사이즈별 선입선출로 예정 잔량에서 차감한다', () => {
    const w = fixture(q(30, 70), q(30, 10)); w.productionRuns = [run('r', q(30, 70))]; w.productionReceipts = [receipt('in', 'r', q(30, 10))]; w.productionConditions = [condition('r', 'approved')]
    sizedPlan(w, 'r', [['2026-11-10', q(30, 20)], ['2026-12-10', q(0, 50)]])
    const result = report(w)
    expect(result.months[0]).toMatchObject({ planned: { total: 50 }, expected: { total: 10 }, received: { total: 40 } })
    expect(result.months[1]).toMatchObject({ planned: { total: 50 }, expected: { total: 50 }, received: { total: 0 } })
    expect(result.totals.expected.total).toBe(60); expect(result.current.producing).toBe(60)
    expect(result.orders).toHaveLength(1); expect(result.orders[0].source).toBe('run')
  })
  it('한 사이즈의 초과 입고가 다른 사이즈의 미입고를 지우지 않는다', () => {
    const w = fixture(q(10, 10), q(20)); w.productionRuns = [run('r', q(10, 10))]; w.productionReceipts = [receipt('in', 'r', q(20))]
    const result = report(w)
    expect(result.current.outstanding).toBe(10); expect(result.totals.expected.total).toBe(10); expect(result.coverage.overReceived).toBe(10)
    expect(result.totals.received.total).toBe(20)
  })
  it('같은 품번의 과거 프로젝트·차수와 최신 부모 수량을 중복 합산하지 않는다', () => {
    const w = fixture(q(100), q(10)); w.styles[0].projectId = 'p-b'; w.styles[0].season = '2027FY'; w.styles[0].factoryId = 'vn'
    w.productionRuns = [run('a'), run('b', q(100), { projectId: 'p-b', factoryIdSnapshot: 'vn', expectedDue: '2026-12-20' })]
    w.productionReceipts = [receipt('a-in', 'a', q(10))]
    const all = report(w), a = report(w, { projectIds: ['p-a'] }), b = report(w, { projectIds: ['p-b'] })
    expect(all.totals.planned.total).toBe(200); expect(all.current.outstanding).toBe(190)
    expect(all.orders.map(order => order.source)).toEqual(['run', 'run'])
    expect(a.totals.expected).toMatchObject({ total: 90, domestic: 90, overseas: 0 }); expect(b.totals.expected).toMatchObject({ total: 100, domestic: 0, overseas: 100 })
    expect(a.orders[0].projectName).toBe('시그니피컨트 2026 11M-1'); expect(a.orders[0].season).toBe('2026FY')
    expect(report(w, { factoryIds: ['kr'], seasons: ['2026FY'] }).current.outstanding).toBe(90)
  })
  it('마감 잔량과 거절 오더는 생산 중으로 세지 않고 실제 입고는 원본 날짜대로 보존한다', () => {
    const w = fixture(q(100), q(85)); w.productionRuns = [run('closed', q(100), { closedAt: NOW }), run('rejected', q(50))]
    w.productionReceipts = [receipt('closed-in', 'closed', q(80)), receipt('rejected-in', 'rejected', q(5))]
    w.productionConditions = [condition('rejected', 'rejected')]
    const result = report(w)
    expect(result.current.outstanding).toBe(0); expect(result.totals.expected.total).toBe(0)
    expect(result.totals.received.total).toBe(85); expect(result.totals.planned.total).toBe(100)
    expect(result.orders.map(order => order.status)).toEqual(['closed', 'rejected'])
  })
  it('승인 대기와 상태 미확인을 실제 생산 중에서 구분한다', () => {
    const w = fixture(q(100)); w.productionRuns = [run('approved', q(30)), run('awaiting', q(40)), run('unknown', q(30))]
    w.productionConditions = [condition('approved', 'approved'), condition('awaiting', 'awaiting_po')]
    const result = report(w)
    expect(result.current).toMatchObject({ outstanding: 100, producing: 30, awaiting: 40, statusUnknown: 30 })
    expect(result.countries[0]).toMatchObject({ current: 100, producing: 30, awaiting: 40, statusUnknown: 30 })
  })
  it('미기재 납기·입고일·생산국은 특정 월이나 국내로 추정하지 않는다', () => {
    const w = fixture(q(50), q(10), ''); w.styles[0].factoryId = 'unknown'
    const result = report(w)
    expect(result.totals.expected.total).toBe(0); expect(result.totals.received.total).toBe(0)
    expect(result.current.outstanding).toBe(40)
    expect(result.coverage).toMatchObject({ undatedExpected: 40, undatedPlanned: 50, undatedReceived: 10, unclassifiedCurrent: 40 })
    expect(result.countries[0]).toMatchObject({ country: '국가 미지정', region: 'unclassified', current: 40 })
  })
  it('잘못된 파샬은 경고하고 원 차수 납기로 돌아가며 수량을 누락하지 않는다', () => {
    const w = fixture(); w.productionRuns = [run('r', q(100), { expectedDue: '2026-12-20' })]; sizedPlan(w, 'r', [['2026-11-20', q(99)]])
    const result = report(w)
    expect(result.coverage.invalidPartialPlans).toBe(1)
    expect(result.months[0].expected.total).toBe(0); expect(result.months[1].expected.total).toBe(100)
  })
  it('과거 총수량 파샬은 사이즈를 만들지 않고 날짜별 총량에서 입고를 차감한다', () => {
    const w = fixture(q(100), q(20)); w.productionRuns = [run('r')]; w.productionReceipts = [receipt('in', 'r', q(20))]
    w.partialDeliveryPlans = [{ runId: 'r', version: 1, updatedAt: NOW, updatedBy: 'admin', items: [{ id: 'one', dueDate: '2026-11-20', quantity: 30, note: '' }, { id: 'two', dueDate: '2026-12-20', quantity: 70, note: '' }] }]
    const result = report(w)
    expect(result.months.map(month => month.expected.total)).toEqual([10, 70, 0, 0, 0]); expect(result.coverage.legacyScalarPlans).toBe(1)
    expect(w.partialDeliveryPlans[0].items[0]).not.toHaveProperty('quantities')
  })
  it('원장이 덮는 부모 입고 잉여는 임의 프로젝트·부분 납기로 배분하지 않고 확인 수량으로 남긴다', () => {
    const w = fixture(q(100), q(20)); w.styles[0].production[0].receivedAt = '2026-11-04'; w.productionRuns = [run('r')]
    const result = report(w)
    expect(result.coverage.unallocatedLegacyReceived).toBe(20)
    expect(result.current.outstanding).toBe(100); expect(result.totals.received.total).toBe(0)
    expect(result.orders).toHaveLength(1)
  })
  it('원장 미포함 부모 잔량만 보완하고 그 잔량의 입고도 중복하지 않는다', () => {
    const w = fixture(q(150), q(30)); w.styles[0].production[0].receivedAt = '2026-11-04'; w.productionRuns = [run('r')]; w.productionReceipts = [receipt('in', 'r', q(20))]
    const result = report(w)
    expect(result.orders.map(order => [order.source, order.orderQuantity, order.receivedQuantity])).toEqual([['run', 100, 20], ['legacy', 50, 10]])
    expect(result.totals.planned.total).toBe(150); expect(result.totals.received.total).toBe(30); expect(result.current.outstanding).toBe(120)
    expect(result.coverage.unallocatedLegacyReceived).toBe(0)
  })
  it('조회 프로젝트를 줄여도 다른 프로젝트 차수가 부모 보완 수량으로 다시 생기지 않는다', () => {
    const w = fixture(q(150), q(20)); w.styles[0].projectId = 'p-b'; w.productionRuns = [run('a', q(100)), run('b', q(50), { projectId: 'p-b' })]; w.productionReceipts = [receipt('in', 'a', q(20))]
    const result = report(w, { projectIds: ['p-b'] })
    expect(result.totals.expected.total).toBe(50); expect(result.orders.map(order => order.id)).toEqual(['b'])
  })
  it('미래 일자로 기록한 입고는 현재 실적과 잔량 차감에서 제외하고 따로 알린다', () => {
    const w = fixture(q(100), q(20)); w.styles[0].production[0].receivedAt = '2026-12-01'; w.productionRuns = [run('r')]; w.productionReceipts = [receipt('future', 'r', q(20), '2026-12-01')]
    const result = report(w)
    expect(result.coverage.futureReceiptQuantity).toBe(20); expect(result.coverage.unallocatedLegacyReceived).toBe(0)
    expect(result.totals.received.total).toBe(0); expect(result.current.received).toBe(0); expect(result.current.outstanding).toBe(100)
    const legacy = fixture(q(100), q(20)); legacy.styles[0].production[0].receivedAt = '2026-12-01'
    expect(report(legacy).current.outstanding).toBe(100); expect(report(legacy).coverage.futureReceiptQuantity).toBe(20)
  })
  it('무효 입고와 다른 컬러·알 수 없는 차수의 기록은 실적으로 합산하지 않는다', () => {
    const w = fixture(); w.productionRuns = [run('r')]; w.productionReceipts = [receipt('void', 'r', q(10), '2026-11-04', { voided: true }), receipt('wrong', 'r', q(20), '2026-11-04', { lineId: 'other' }), receipt('orphan', 'missing', q(30))]
    const result = report(w)
    expect(result.totals.received.total).toBe(0); expect(result.current.outstanding).toBe(100); expect(result.coverage.orphanReceipts).toBe(2)
  })
  it('미래 원장 입고로 이미 기록된 과거 부모 입고의 확인 필요 수량을 숨기지 않는다', () => {
    const w = fixture(q(100), q(20)); w.styles[0].production[0].receivedAt = '2026-11-04'; w.productionRuns = [run('r')]; w.productionReceipts = [receipt('future', 'r', q(20), '2026-12-01')]
    const result = report(w)
    expect(result.coverage.futureReceiptQuantity).toBe(20); expect(result.coverage.unallocatedLegacyReceived).toBe(20)
    expect(result.totals.received.total).toBe(0); expect(result.current.outstanding).toBe(100)
  })
  it('미래 승인·마감 일자는 기준일에 이미 승인·마감된 것으로 집계하지 않는다', () => {
    const w = fixture(); w.productionRuns = [run('r', q(100), { closedAt: '2026-12-01T00:00:00Z' })]
    const c = condition('r', 'closed'); c.approval = { id: 'approval', finalDeliveryDate: '2026-12-10', unitCost: 999, approvedBy: 'admin', approvedByName: '관리자', approvedAt: '2026-11-10T00:00:00Z', termsSnapshot: {}, poSnapshot: {} }; w.productionConditions = [c]
    const current = report(w)
    expect(current.current.outstanding).toBe(100); expect(current.current.producing).toBe(0); expect(current.current.statusUnknown).toBe(100)
    expect(report(w, { asOf: '2026-11-20' }).current.producing).toBe(100)
    expect(report(w, { asOf: '2026-12-02' }).current.outstanding).toBe(0)
  })
  it('승인일 전에는 미래 최종 납기를 적용해 현재 월 입고 계획을 옮기지 않는다', () => {
    const w = fixture(); w.productionRuns = [run('r')]
    const c = condition('r', 'approved'); c.approval = { id: 'approval', finalDeliveryDate: '2026-12-10', unitCost: 999, approvedBy: 'admin', approvedByName: '관리자', approvedAt: '2026-11-10T00:00:00Z', termsSnapshot: {}, poSnapshot: {} }; w.productionConditions = [c]
    expect(report(w).months.map(month => month.expected.total)).toEqual([100, 0, 0, 0, 0])
    expect(report(w, { asOf: '2026-11-20' }).months.map(month => month.expected.total)).toEqual([0, 100, 0, 0, 0])
  })
  it('수량 스키마를 넘는 손상된 원장 값은 금액·수량 합계를 오염시키지 않는다', () => {
    const w = fixture(); w.productionRuns = [run('r', q(10_000_001))]
    const result = report(w)
    expect(result.coverage.invalidQuantityRows).toBe(1)
    expect(result.current.outstanding).toBe(100)
    expect(result.orders.every(order => Number.isSafeInteger(order.orderQuantity))).toBe(true)
  })
  it('같은 원장·입고 ID가 재조회돼도 한 번만 세고 고정 마감·감사 이력 값은 읽지 않는다', () => {
    const w = fixture(q(100), q(10)), r = run('r'), i = receipt('in', 'r', q(10)); w.productionRuns = [r, structuredClone(r)]; w.productionReceipts = [i, structuredClone(i)]
    w.audits.push({ id: 'old', styleId: 'style', actorId: 'admin', actorName: '관리자', action: '이전 입고 변경', reason: '', before: { quantity: 5000 }, after: { quantity: 99999 }, createdAt: NOW })
    const result = report(w)
    expect(result.totals.planned.total).toBe(100); expect(result.totals.received.total).toBe(10); expect(result.current.outstanding).toBe(90)
  })
  it('샘플만 있는 스타일이나 원단 YDS·라벨 EA 차수를 의류 장수에 섞지 않는다', () => {
    const w = fixture(); w.styles[0].stage = 'sample1'; w.productionRuns = [run('fabric', q(999), { itemType: 'fabric' })]; w.productionReceipts = [receipt('fabric-in', 'fabric', q(888))]
    expect(report(w).current.outstanding).toBe(0); expect(report(w).totals.received.total).toBe(0)
    w.productionRuns.push(run('product', q(100)))
    expect(report(w).current.outstanding).toBe(100)
  })
  it('승인 최종 납기는 미확정 본사 요청일보다 우선하지만 다른 프로젝트 현재 납기로 대체하지 않는다', () => {
    const w = fixture(); w.productionRuns = [run('r', q(100), { expectedDue: '' })]
    const c = condition('r', 'approved'); c.approval = { id: 'approval', finalDeliveryDate: '2027-02-10', unitCost: 999, approvedBy: 'admin', approvedByName: '관리자', approvedAt: NOW, termsSnapshot: {}, poSnapshot: {} }; w.productionConditions = [c]
    expect(report(w).months.map(month => month.expected.total)).toEqual([0, 0, 0, 100, 0])
    w.productionConditions = []
    expect(report(w).coverage.undatedExpected).toBe(100)
  })
})

describe('경영 보고 조회의 범위와 역할', () => {
  it('승인된 본사만 canonical 계정으로 조회하며 외부·비활성·미승인·모르는 계정은 빈 결과다', () => {
    const w = fixture()
    expect(report(w, { profileId: 'internal' }).authorized).toBe(true)
    for (const id of ['vendor', 'missing']) { const result = report(w, { profileId: id }); expect(result.authorized).toBe(false); expect(result.months).toEqual([]); expect(result.orders).toEqual([]); expect(result.current.outstanding).toBe(0) }
    w.profiles[0].active = false; expect(report(w).authorized).toBe(false)
    w.profiles[0].active = true; w.profiles[0].approved = false; expect(report(w).authorized).toBe(false)
  })
  it('빈 선택은 전체와 다르고 서로 다른 필터는 교집합이다', () => {
    const w = fixture()
    expect(report(w, { projectIds: null }).current.outstanding).toBe(100)
    expect(report(w, { projectIds: [] }).current.outstanding).toBe(0)
    expect(report(w, { projectIds: ['p-a'], factoryIds: ['vn'] }).current.outstanding).toBe(0)
    expect(report(w, { projectIds: ['p-a'], seasons: ['2026FY'] }).current.outstanding).toBe(100)
  })
  it('월 범위의 빈 달·연도 경계를 유지하고 역순·잘못된 월·과도한 범위를 거절한다', () => {
    expect(executiveMonthRange('2026-12', '2027-02')).toEqual(['2026-12', '2027-01', '2027-02'])
    for (const [from, to] of [['2026-13', '2027-01'], ['2027-01', '2026-12'], ['2026-01', '2029-01']]) expect(() => executiveMonthRange(from, to)).toThrow()
    expect(() => report(fixture(), { asOf: '2026-02-30' })).toThrow()
  })
  it('대한민국 표기는 통일하되 누락된 생산국을 국내나 해외로 추측하지 않는다', () => {
    for (const country of ['대한민국', '한국', 'KR', 'KOR', 'Korea', 'South Korea', 'Republic of Korea']) expect(normalizeProductionCountry(country)).toEqual({ country: '대한민국', region: 'domestic' })
    for (const country of ['', '-', '미정', '미지정', 'unknown', 'N/A']) expect(normalizeProductionCountry(country).region).toBe('unclassified')
    expect(normalizeProductionCountry('Vietnam')).toEqual({ country: '베트남', region: 'overseas' })
    expect(normalizeProductionCountry('중국')).toEqual({ country: '중국', region: 'overseas' })
    expect(normalizeProductionCountry('North Korea').region).toBe('overseas')
  })
})
