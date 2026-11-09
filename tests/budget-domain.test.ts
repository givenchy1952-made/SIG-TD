import { describe, expect, it } from 'vitest'
import { budgetCode, budgetCostSupplierKey, buildBudgetReport, buildBudgetSources, defaultBudgetPayment, groupBudgetReport, saveBudgetRecordInWorkspace } from '../src/lib/budget-domain'
import type { BudgetCostData, BudgetFAEntry, BudgetOrderSource, BudgetRecord, BudgetSources } from '../src/lib/budget-types'
import { createSeed } from '../src/lib/seed'
import { emptyQuantities, type Profile, type Workspace } from '../src/lib/types'

const id = (number: number) => `90100000-0000-4000-8000-${String(number).padStart(12, '0')}`
const admin: Profile = { id: id(1), role: 'admin', name: '본사', email: 'hq@example.test', approved: true, active: true, factoryId: null }
const finance: Profile = { ...admin, id: id(2), role: 'finance', name: 'FA' }
const internal: Profile = { ...admin, id: id(3), role: 'internal' }
const factory: Profile = { ...admin, id: id(4), role: 'factory', factoryId: id(21) }
const identity = (n = 1) => ({ projectId: id(10 + n), projectCode: `SIGNIFICANT-2027FY-RPQ-${100 + n}`, projectName: '동일한 공식 프로젝트', styleId: id(30 + n), lineId: id(40 + n), styleCode: `BP07FYKT070${n}OT`, color: 'OT', season: n === 3 ? '2028FY' : '2027FY', factoryId: id(20 + n), factoryName: `생산업체 ${n}` })
function order(n = 1): BudgetOrderSource { const value = identity(n); return { ...value, budgetCode: budgetCode(value.projectCode, value.styleCode), sourceKey: `production:${id(50 + n)}`, brand: 'SIGNIFICANT', productionType: 'RPQ', orderCode: String(100 + n), orderDate: '2026-11-05', quantity: 100, receivedQuantity: 100, joorQuantity: 40, aderQuantity: 60 } }
function entry(n = 1, netAmount = 12000): BudgetFAEntry { const value = order(n); return { ...value, sourceKey: `production:${id(50 + n)}`, sourceVersion: 3, sourceFingerprint: `production:${id(50 + n)}@3`, receivedAt: '2026-11-07', unitCost: netAmount / 100, consumption: null, orderQuantity: 100, receivedQuantity: 100, unit: 'EA', netAmount, vatAmount: netAmount / 10, grossAmount: netAmount * 1.1, owner: '본사 담당자', item: '제품', evidence: '생산 1차 마감 확정' } }
function cost(n = 1, amount: number | null = 10000, stage: 'pre' | 'post' = 'pre', supplierId = id(20 + n)): BudgetCostData { const value = order(n); return { projectId: value.projectId, budgetCode: value.budgetCode, styleCode: value.styleCode, supplierId, supplierName: `업체 ${supplierId.slice(-2)}`, stage, category: '봉제', description: '직접 확인한 원가', position: '', specification: '', itemName: '제품', composition: '', color: 'OT', unitCost: null, variableUnitCost: null, consumption: null, unit: 'EA', amount, voided: false } }
function record<K extends BudgetRecord['kind']>(kind: K, data: Extract<BudgetRecord, { kind: K }>['data'], n: number): BudgetRecord { return { id: id(n), kind, data, version: 1, createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z', updatedBy: admin.id } as BudgetRecord }
function workspace(sources: BudgetSources = { orders: [order()], settlements: [entry()], warnings: [] }): Workspace { return { profiles: [admin, finance, internal, factory], factories: [1, 2, 3].map(n => ({ id: id(20 + n), name: `업체 ${n}`, country: '대한민국' })), styles: [], projects: [], comments: [], attachments: [], audits: [], budgetSources: sources, budgetRecords: [], budgetAvailable: true } }
function saved(workspace: Workspace, kind: BudgetRecord['kind'], data: BudgetRecord['data'], n = 60, version = 0): Workspace { return saveBudgetRecordInWorkspace(workspace, admin, id(n), kind, data, version, '확인 후 저장') }
function paid(workspace: Workspace, value = entry(), n = 70): Workspace { return saved(workspace, 'payment', { ...defaultBudgetPayment(value), status: 'paid', paidAt: '2026-11-07' }, n) }

describe('예산·FA 누적 도메인', () => {
  it('업로드 원가를 직접 수정해도 Q×S 금액을 유지하고 수동 금액은 별도로 보존한다', () => {
    const original = { ...cost(), unitCost: 12.34, consumption: 0.125, amount: 1.5425 }
    const w = saved(workspace(), 'cost', original)
    w.budgetCostImports = [{ recordId: id(60), projectId: original.projectId, styleCode: original.styleCode, fileName: 'QA.xlsx', sheetName: '원가', rowNumber: 16, sourceKey: 'source', rowFingerprint: 'hash', contentHash: 'hash', updatedAt: '', updatedBy: admin.id }]
    expect(() => saved(w, 'cost', { ...original, unitCost: 20 }, 60, 1)).toThrow('단가(Q열)')
    expect(saved(w, 'cost', { ...original, unitCost: 20, amount: 2.5 }, 60, 1).budgetRecords?.[0].data).toMatchObject({ amount: 2.5 })
    expect(() => saved(w, 'cost', { ...original, unitCost: null }, 60, 1)).toThrow('단가(Q열)')
    expect(saved(w, 'cost', { ...original, unitCost: null, amount: null }, 60, 1).budgetRecords?.[0].data).toMatchObject({ amount: null })
    expect(saved(workspace(), 'cost', { ...original, amount: 999 }).budgetRecords?.[0].data).toMatchObject({ amount: 999 })
  })
  it('미연결 원가 업체의 예산을 생산 공장에 대신 배정하지 않고 해당 업체로 조회한다', () => {
    const data = { ...cost(1, 2000), supplierId: '', supplierName: '신규 원단 업체' }
    const w = saved(workspace(), 'cost', data)
    const groups = groupBudgetReport(buildBudgetReport(w, admin), 'factory')
    expect(groups.find(group => group.key === budgetCostSupplierKey(data))?.totals.budget).toBe(2000)
    expect(groups.find(group => group.key === order().factoryId)?.totals.budget).toBe(0)
    const filtered = buildBudgetReport(w, admin, { factoryIds: [budgetCostSupplierKey(data)] })
    expect(filtered.orders).toHaveLength(1)
    expect(filtered.totals.budget).toBe(2000)
    expect(filtered.costs[0].data.supplierName).toBe('신규 원단 업체')
  })
  it('예산 코드는 A열과 컬러 포함 D열을 공백 없이 연결한다', () => {
    expect(budgetCode(' SIGNIFICANT-2026FY-RPQ-46024 ', ' BP06FYKT0703OT ')).toBe('SIGNIFICANT-2026FY-RPQ-46024BP06FYKT0703OT')
  })
  it('원가가 없으면 미등록과 null이며 0원으로 지출 가능액을 만들지 않는다', () => {
    const report = buildBudgetReport(workspace(), admin)
    expect(report.orders[0].productionBudget).toBeNull(); expect(report.orders[0].productionUnitCost).toBeNull(); expect(report.orders[0].costMatched).toBe('')
    expect(report.totals.missingCostCount).toBe(1); expect(report.excess).toHaveLength(0); expect(report.totals.overage).toBe(0)
    expect(report.unclosed[0].explanation).toContain('사전 원가 미등록')
  })
  it('사전 원가 합계 M과 장당 O, 사후 원가 매칭 N을 구분하며 요척 계산을 추정하지 않는다', () => {
    let w = saved(workspace(), 'cost', { ...cost(), unitCost: 5, consumption: 2, amount: 12345 })
    w = saved(w, 'cost', cost(1, 9000, 'post'), 61)
    const row = buildBudgetReport(w, admin).orders[0]
    expect(row.productionBudget).toBe(12345); expect(row.productionUnitCost).toBe(123.45); expect(row.postCost).toBe(9000); expect(row.costMatched).toBe(order().budgetCode)
  })
  it('명시적 0원은 등록된 예산이며 미등록과 구분한다', () => {
    const w = saved(workspace(), 'cost', cost(1, 0))
    expect(buildBudgetReport(w, admin).excess).toHaveLength(0)
    const report = buildBudgetReport(paid(w), admin)
    expect(report.orders[0].productionBudget).toBe(0); expect(report.totals.missingCostCount).toBe(0); expect(report.excess[0].overage).toBe(12000)
  })
  it('결제 전 확정 을지는 미결제이며 지급 후 공급가·VAT·합계가 각각 집계된다', () => {
    const w = saved(workspace(), 'cost', cost())
    expect(buildBudgetReport(w, admin).totals).toMatchObject({ paid: 0, unpaid: 12000, budget: 10000 })
    const report = buildBudgetReport(paid(w), admin)
    expect(report.totals).toMatchObject({ paid: 12000, unpaid: 0, paidVat: 1200, paidGross: 13200, remaining: 0, overage: 2000, progress: 1.2 })
    expect(report.excess[0].overage).toBe(2000)
  })
  it('동일 프로젝트 명칭도 ID로 구분하며 같은 필터 OR, 서로 다른 필터 AND를 적용한다', () => {
    const w = workspace({ orders: [order(1), order(2), order(3)], settlements: [entry(1), entry(2), entry(3)], warnings: [] })
    expect(buildBudgetReport(w, admin, { projectIds: [order(1).projectId] }).orders).toHaveLength(1)
    expect(buildBudgetReport(w, admin, { projectIds: [order(1).projectId, order(3).projectId], seasons: ['2027FY'] }).orders.map(row => row.projectId)).toEqual([order(1).projectId])
    expect(buildBudgetReport(w, admin, { projectIds: [] }).orders).toHaveLength(0)
    expect(buildBudgetReport(w, admin).groups).toHaveLength(3)
  })
  it('시즌·프로젝트 코드·컬러 품번을 조합해 같은 다운로드 범위를 반환한다', () => {
    const w = workspace({ orders: [order(1), order(2)], settlements: [entry(1), entry(2)], warnings: [] })
    const report = buildBudgetReport(w, admin, { projectCodes: [order(2).projectCode], styleCodes: [order(2).styleCode], seasons: ['2027FY'] })
    expect(report.orders.map(row => row.styleCode)).toEqual([order(2).styleCode]); expect(report.settlements.map(row => row.styleCode)).toEqual([order(2).styleCode])
    expect(buildBudgetReport(w, admin, { styleCodes: [] }).totals.paid).toBe(0)
  })
  it('시즌 예산 한도 잔액은 프로젝트 필터로 다른 프로젝트 예산을 미사용으로 되돌리지 않는다', () => {
    let w = workspace({ orders: [order(1), order(2)], settlements: [], warnings: [] })
    w = saved(w, 'cost', cost(1, 10000)); w = saved(w, 'cost', cost(2, 20000), 61); w = saved(w, 'limit', { season: '2027FY', amount: 50000 }, 62)
    const report = buildBudgetReport(w, admin, { projectIds: [order(1).projectId], seasons: ['2027FY'] })
    expect(report.totals).toMatchObject({ budget: 10000, annualLimit: 50000, unallocated: 20000 })
  })
  it('공급업체별 원가를 해당 업체에 배분하고 가공 업체 필터에서 관련 예산을 잃지 않는다', () => {
    let w = workspace({ orders: [order()], settlements: [{ ...entry(), factoryId: id(22), factoryName: '자수업체' }], warnings: [] })
    w = saved(w, 'cost', cost(1, 8000)); w = saved(w, 'cost', cost(1, 2000, 'pre', id(22)), 61)
    const groups = groupBudgetReport(buildBudgetReport(w, admin), 'factory')
    expect(groups.find(group => group.key === id(21))!.totals.budget).toBe(8000); expect(groups.find(group => group.key === id(22))!.totals.budget).toBe(2000)
    w = paid(w, w.budgetSources!.settlements[0])
    const filtered = buildBudgetReport(w, admin, { factoryIds: [id(22)] })
    expect(filtered.orders).toHaveLength(1); expect(filtered.totals.budget).toBe(2000); expect(filtered.settlements).toHaveLength(1); expect(filtered.excess[0].overage).toBe(10000)
  })
  it('미종결 사유는 자동 설명과 본사 작성 사유를 따로 보존한다', () => {
    let w = saved(workspace(), 'cost', cost())
    const initial = buildBudgetReport(w, admin).unclosed[0]
    w = saved(w, 'note', { key: initial.key, kind: 'unclosed', reason: '담당자 계산서 확인 중' }, 80)
    expect(buildBudgetReport(w, admin).unclosed[0]).toMatchObject({ reason: '담당자 계산서 확인 중', explanation: initial.explanation })
    expect(w.budgetAudits?.[0].reason).toBe('확인 후 저장')
  })
  it('FA는 전용 투영 자료만 열람하며 원가·결제·사유를 수정할 수 없다', () => {
    const w = workspace(), report = buildBudgetReport(w, finance)
    expect(report.authorized).toBe(true); expect(report.readOnly).toBe(true)
    expect(() => saveBudgetRecordInWorkspace(w, finance, id(60), 'cost', cost(), 0, '수정 시도')).toThrow('본사')
    expect(buildBudgetReport({ ...w, budgetSources: undefined }, finance).authorized).toBe(false)
  })
  it('협력업체·비활성·미승인·조작된 호출자 역할은 예산 접근을 열지 않는다', () => {
    const w = workspace()
    expect(buildBudgetReport(w, factory).authorized).toBe(false)
    expect(buildBudgetReport(w, { ...factory, role: 'admin' }).authorized).toBe(false)
    expect(buildBudgetReport({ ...w, profiles: [{ ...admin, approved: false }] }, admin).authorized).toBe(false)
    expect(buildBudgetReport({ ...w, profiles: [{ ...admin, active: false }] }, admin).authorized).toBe(false)
  })
  it('잘못된 원가 연결·추가 필드·음수·소수 금액과 오래된 버전을 거부한다', () => {
    const w = workspace()
    expect(() => saved(w, 'cost', { ...cost(), budgetCode: '임의 코드' })).toThrow('일치')
    expect(() => saved(w, 'cost', { ...cost(), amount: -1 })).toThrow('금액')
    expect(() => saved(w, 'cost', { ...cost(), amount: 1.0000001 })).toThrow('금액')
    expect(() => saved(w, 'cost', { ...cost(), arbitrary: 'x' } as BudgetCostData)).toThrow('저장 항목')
    const first = saved(w, 'cost', cost())
    expect(() => saved(first, 'cost', cost(1, 200), 60, 0)).toThrow('VERSION_CONFLICT')
  })
  it('같은 결제·시즌 한도를 중복 ID로 생성하지 않고 기존 이력을 유지한다', () => {
    const w = saved(workspace(), 'limit', { season: '2027FY', amount: 50000 })
    expect(() => saved(w, 'limit', { season: '2027FY', amount: 100000 }, 61)).toThrow('이미')
    const next = saved(w, 'limit', { season: '2027FY', amount: 60000 }, 60, 1)
    expect(next.budgetRecords?.[0].version).toBe(2); expect(next.budgetAudits).toHaveLength(2); expect(w.budgetRecords?.[0].version).toBe(1)
  })
  it('미래 지급일과 미결제에 남긴 지급일, 변조한 결제 스냅샷을 거부한다', () => {
    const w = workspace(), payment = defaultBudgetPayment(entry())
    expect(() => saved(w, 'payment', { ...payment, status: 'paid', paidAt: '2099-01-01' })).toThrow('미래')
    expect(() => saved(w, 'payment', { ...payment, status: 'unpaid', paidAt: '2026-11-07' })).toThrow('지급일')
    expect(() => saved(w, 'payment', { ...payment, status: 'paid', paidAt: '2026-11-07', sourceSnapshot: { ...entry(), netAmount: 1 } })).toThrow('VERSION_CONFLICT')
  })
  it('결제 후 원본 금액 변경은 과거 지급액을 변경하거나 새 금액까지 중복 계산하지 않는다', () => {
    const w = paid(workspace()), changed = { ...entry(), sourceVersion: 4, sourceFingerprint: `${entry().sourceKey}@4`, netAmount: 15000, vatAmount: 1500, grossAmount: 16500 }
    const report = buildBudgetReport({ ...w, budgetSources: { orders: [order()], settlements: [changed], warnings: [] } }, admin)
    expect(report.settlements).toHaveLength(1); expect(report.settlements[0]).toMatchObject({ netAmount: 12000, paymentStale: true }); expect(report.totals.paid).toBe(12000); expect(report.totals.unpaid).toBe(0)
    expect(report.unclosed[0].explanation).toContain('결제 원본 재확인')
  })
  it('버전 토큰이 같아도 명칭 등 근거가 달라지면 과거 지급을 유지하며 재확인을 표시한다', () => {
    const w = paid(workspace()), changed = { ...entry(), projectName: '변경된 공식 명칭' }
    const report = buildBudgetReport({ ...w, budgetSources: { orders: [order()], settlements: [changed], warnings: [] } }, admin)
    expect(report.totals.paid).toBe(12000)
    expect(report.settlements[0]).toMatchObject({ projectName: entry().projectName, paymentStale: true })
    expect(report.unclosed[0].explanation).toContain('결제 원본 재확인')
  })
  it('JSONB 속성 순서만 다른 결제 당시 스냅샷은 같은 재무 근거로 취급한다', () => {
    const w = paid(workspace()), stored = w.budgetRecords!.find(record => record.kind === 'payment')!
    if (stored.kind !== 'payment') throw new Error('결제 기록 필요')
    stored.data.sourceSnapshot = Object.fromEntries(Object.entries(stored.data.sourceSnapshot!).reverse()) as unknown as BudgetFAEntry
    const report = buildBudgetReport(w, admin)
    expect(report.settlements[0].paymentStale).toBe(false)
    const updated = saved(w, 'payment', { ...stored.data, voucherNo: '확인된 품의서' }, 70, 1)
    expect(updated.budgetRecords!.find(record => record.kind === 'payment')!.version).toBe(2)
  })
  it('결제된 가공 원본이 사라져도 지출은 남으며 명시적 미결제 정정만 되돌린다', () => {
    const w = paid(workspace()), removed = { ...w, budgetSources: { orders: [order()], settlements: [], warnings: [] } }
    const report = buildBudgetReport(removed, admin)
    expect(report.totals.paid).toBe(12000); expect(report.settlements[0].paymentStale).toBe(true)
    const reversed = saved(removed, 'payment', { ...defaultBudgetPayment(report.settlements[0]), status: 'unpaid' }, 70, 1)
    expect(buildBudgetReport(reversed, admin).totals.paid).toBe(0); expect(reversed.budgetAudits?.[0].before).toMatchObject({ data: { status: 'paid' } })
  })
  it('원본 공급업체·프로젝트가 변경돼도 과거 지출은 원래 필터에만 남는다', () => {
    const w = paid(workspace()), changed = { ...entry(), ...identity(2), budgetCode: order(2).budgetCode, sourceVersion: 4, sourceFingerprint: `${entry().sourceKey}@4` }
    const state = { ...w, budgetSources: { orders: [order(1), order(2)], settlements: [changed], warnings: [] } }
    expect(buildBudgetReport(state, admin, { factoryIds: [order(1).factoryId], projectIds: [order(1).projectId] }).totals.paid).toBe(12000)
    expect(buildBudgetReport(state, admin, { factoryIds: [order(2).factoryId], projectIds: [order(2).projectId] }).totals.paid).toBe(0)
  })
  it('조회·그룹·내보내기용 보고서를 만들 때 원본 업무와 재무 자료를 변경하지 않는다', () => {
    const w = paid(saved(workspace(), 'cost', cost())), before = structuredClone(w)
    const report = buildBudgetReport(w, admin); groupBudgetReport(report, 'factory'); groupBudgetReport(report, 'style')
    expect(w).toEqual(before)
  })
  it('사후 원가 확인과 결제 원본 검토가 남아 있으면 그룹도 미종결을 유지한다', () => {
    const preOnly = paid(saved(workspace(), 'cost', cost()))
    const pending = buildBudgetReport(preOnly, admin)
    expect(pending.unclosed[0].explanation).toContain('사후 원가 미등록')
    expect(pending.groups[0].closed).toBe(false)
    const complete = saved(preOnly, 'cost', cost(1, 12000, 'post'), 61)
    expect(buildBudgetReport(complete, admin).groups[0].closed).toBe(true)
    const changed = { ...entry(), sourceVersion: 4, sourceFingerprint: `${entry().sourceKey}@4`, netAmount: 15000, vatAmount: 1500, grossAmount: 16500 }
    const stale = buildBudgetReport({ ...complete, budgetSources: { orders: [order()], settlements: [changed], warnings: [] } }, admin)
    expect(stale.groups[0].closed).toBe(false)
    expect(stale.unclosed[0].explanation).toContain('결제 원본 재확인')
  })
  it('같은 프로젝트의 한 품번을 결제해도 을지 근거가 없는 다른 품번까지 종결하지 않는다', () => {
    const second = { ...order(2), projectId: order().projectId, projectCode: order().projectCode, budgetCode: budgetCode(order().projectCode, order(2).styleCode) }
    let w = workspace({ orders: [order(), second], settlements: [entry()], warnings: [] })
    w = saved(w, 'cost', cost()); w = saved(w, 'cost', cost(1, 12000, 'post'), 61)
    w = saved(w, 'cost', { ...cost(2), projectId: second.projectId, budgetCode: second.budgetCode }, 62)
    w = saved(w, 'cost', { ...cost(2, 5000, 'post'), projectId: second.projectId, budgetCode: second.budgetCode }, 63)
    const report = buildBudgetReport(paid(w), admin)
    expect(report.groups).toHaveLength(1)
    expect(report.groups[0].closed).toBe(false)
    expect(report.unclosed.some(row => row.styleCode === second.styleCode && row.explanation.includes('FA 마감 누적 대기'))).toBe(true)
  })
  it('원가 소수 합계는 부동소수 오차를 잔액에 남기지 않는다', () => {
    let w = workspace({ orders: [order()], settlements: [], warnings: [] }); w = saved(w, 'cost', cost(1, 0.1)); w = saved(w, 'cost', cost(1, 0.2), 61)
    expect(buildBudgetReport(w, admin).totals.budget).toBe(0.3)
  })
  it('원가 금액의 여섯째 소수 자리까지 검증·누적하며 기존 한도와 지급 금액 정밀도는 유지한다', () => {
    let w = workspace({ orders: [order()], settlements: [], warnings: [] })
    w = saved(w, 'cost', cost(1, 0.099999)); w = saved(w, 'cost', cost(1, 0.000001), 61)
    expect(buildBudgetReport(w, admin).totals).toMatchObject({ budget: 0.1, remaining: 0.1 })
    expect(() => saved(w, 'limit', { season: '2027FY', amount: 1.001 }, 62)).toThrow('예산 한도')
    expect(() => saved(w, 'cost', { ...cost(), unitCost: 1.001 }, 63)).toThrow('원가 단가')
  })
})

describe('기존 생산 자료에서 안전한 예산 투영', () => {
  function raw() { const w = createSeed(), style = w.styles.find(style => style.production.length)!, line = style.production[0], project = w.projects.find(project => project.id === style.projectId)!; w.styles = [style]; style.production = [line]; style.colors = [line.color]; project.code = 'SIGNIFICANT-2027FY-RPQ-10001'; project.name = '2027 공식 프로젝트'; project.season = '2027FY'; line.order = { ...emptyQuantities(), M: 100 }; line.received = { ...emptyQuantities(), M: 100 }; line.shipped = { ...emptyQuantities(), M: 100 }; line.receivedAt = '2026-11-07'; return { w, style, line, project } }
  it('생산 차수가 있으면 부모 누적 오더를 중복 합산하지 않는다', () => {
    const { w, style, line, project } = raw(), source = { id: id(55), styleId: style.id, lineId: line.id, projectId: project.id, projectCode: project.code!, order: { ...emptyQuantities(), M: 100 }, factoryIdSnapshot: style.factoryId, factoryNameSnapshot: '원래 공장', styleCodeSnapshot: fullSku(style.code, line.color), ownerIdSnapshot: style.ownerId, ownerNameSnapshot: '원래 담당자', name: '신규 생산', round: 1, expectedDue: '', poId: null, unitCost: 100, itemType: 'product' as const, correctsRunId: null, version: 3, createdAt: '2026-11-01', updatedAt: '2026-11-01', updatedBy: w.profiles[0].id, closedAt: null, snapshot: null }
    w.productionRuns = [source, { ...source, id: id(56), order: { ...emptyQuantities(), M: 25 }, round: 2 }]
    const result = buildBudgetSources(w)
    expect(result.orders.reduce((sum, row) => sum + row.quantity, 0)).toBe(125); expect(result.orders).toHaveLength(2); expect(result.settlements).toHaveLength(0)
  })
  it('부모를 삭제한 후에도 확정 마감 스냅샷 금액은 원래 업체·단가로 보존한다', () => {
    const { w, style, line, project } = raw(), identity = { factoryIdSnapshot: style.factoryId, factoryNameSnapshot: '원래 공장', styleCodeSnapshot: fullSku(style.code, line.color), ownerIdSnapshot: style.ownerId, ownerNameSnapshot: '원래 담당자' }
    style.deletedAt = '2026-11-08T00:00:00Z'
    w.productionRuns = [{ ...identity, id: id(55), styleId: style.id, lineId: line.id, projectId: project.id, projectCode: project.code!, order: { ...emptyQuantities(), M: 100 }, name: '생산', round: 1, expectedDue: '', poId: null, unitCost: 100, itemType: 'product', correctsRunId: null, version: 4, createdAt: '2026-11-01', updatedAt: '2026-11-07', updatedBy: w.profiles[0].id, closedAt: '2026-11-07', snapshot: { ...identity, projectId: project.id, projectCode: project.code!, styleCode: fullSku(style.code, line.color), factory: '원래 공장', owner: '원래 담당자', expectedDue: '', name: '생산', round: 1, poId: null, itemType: 'product', unitCost: 100, orderQuantity: 100, receivedQuantity: 100, netAmount: 10000, vatAmount: 1000, grossAmount: 11000, lastReceivedAt: '2026-11-07', receipts: [], finalizedAt: '2026-11-07T00:00:00Z', finalizedBy: w.profiles[0].id } }]
    const result = buildBudgetSources(w)
    expect(result.orders).toHaveLength(1); expect(result.settlements).toHaveLength(1); expect(result.settlements[0]).toMatchObject({ factoryName: '원래 공장', unitCost: 100, netAmount: 10000, sourceFingerprint: `production:${id(55)}@4` })
  })
  it('Excel 날짜·직렬 날짜와 CSV 천 단위 수량을 원본 날짜·배분으로 복원한다', () => {
    const expected = '2026-11-07', serial = (Date.UTC(2026, 10, 7) - Date.UTC(1899, 11, 30)) / 86_400_000
    for (const dateValue of [expected, `${expected}T00:00:00.000Z`, '2026/11/7', serial]) {
      const { w, style, line, project } = raw()
      line.order.M = 4138
      w.operations = { poDispatches: [], poDispatchAttempts: [], operationCatalogs: [], shipmentLedgers: [], shipmentBatches: [], styleOperations: [], calendarEvents: [], calendarEventAudits: [], employeeFactoryAssignments: [], orderSourceRecords: [{ styleId: style.id, lineId: line.id, version: 1, createdAt: '', updatedAt: '', updatedBy: '', fileName: 'QA.csv', sheetName: 'ORDER', headers: { A: '프로젝트 코드', K: '브랜드', S: '발주 요청일', BH: 'JOOR GB', BZ: 'ADER KOR' }, rows: [{ rowNumber: 2, columns: { A: project.code, K: '공식 브랜드', S: dateValue, BH: '268', BZ: '3,870' } }] } as unknown as import('../src/lib/operations-types').OrderSourceRecord] }
      const row = buildBudgetSources(w).orders[0]
      expect(row).toMatchObject({ brand: '공식 브랜드', orderDate: expected, joorQuantity: 268, aderQuantity: 3870 })
    }
  })
  it('잘못된 날짜와 분수·잘못 구분한 원본 수량은 숫자를 추정하지 않는다', () => {
    const { w, style, line, project } = raw()
    const source = { styleId: style.id, lineId: line.id, version: 1, createdAt: '', updatedAt: '', updatedBy: '', fileName: 'QA.csv', sheetName: 'ORDER', headers: { A: '프로젝트 코드', S: '발주 요청일', BH: 'JOOR GB', BZ: 'ADER KOR' }, rows: [{ rowNumber: 2, columns: { A: project.code, S: '2026-11-31T00:00:00.000Z', BH: '12,34', BZ: '3.5' } }] } as unknown as import('../src/lib/operations-types').OrderSourceRecord
    w.operations = { poDispatches: [], poDispatchAttempts: [], operationCatalogs: [], shipmentLedgers: [], shipmentBatches: [], styleOperations: [], calendarEvents: [], calendarEventAudits: [], employeeFactoryAssignments: [], orderSourceRecords: [source] }
    const result = buildBudgetSources(w)
    expect(result.orders[0]).toMatchObject({ orderDate: '', joorQuantity: null, aderQuantity: null })
    expect(result.warnings.some(warning => warning.includes('원본 발주 요청일 형식'))).toBe(true)
    source.rows[0].columns.S = 60
    expect(buildBudgetSources(w).orders[0].orderDate).toBe('')
  })
  it('290장 오더를 277장 입고로 마감한 경우 원장 배분이 일치하는 가공 실수량을 누적한다', () => {
    const { w, style, line, project } = raw(), runId = id(55), supplier = w.factories[1], itemId = id(90)
    line.order.M = 290; line.received.M = 277; line.shipped.M = 277
    const identity = { factoryIdSnapshot: style.factoryId, factoryNameSnapshot: '원래 공장', styleCodeSnapshot: fullSku(style.code, line.color), ownerIdSnapshot: style.ownerId, ownerNameSnapshot: '원래 담당자' }
    w.productionRuns = [{ ...identity, id: runId, styleId: style.id, lineId: line.id, projectId: project.id, projectCode: project.code!, order: { ...line.order }, name: '생산', round: 1, expectedDue: '', poId: null, unitCost: 100, itemType: 'product', correctsRunId: null, version: 4, createdAt: '2026-11-01', updatedAt: '2026-11-07', updatedBy: w.profiles[0].id, closedAt: '2026-11-07', snapshot: { ...identity, projectId: project.id, projectCode: project.code!, styleCode: fullSku(style.code, line.color), factory: '원래 공장', owner: '원래 담당자', expectedDue: '', name: '생산', round: 1, poId: null, itemType: 'product', unitCost: 100, orderQuantity: 290, receivedQuantity: 277, netAmount: 27700, vatAmount: 2770, grossAmount: 30470, lastReceivedAt: '2026-11-07', receipts: [], finalizedAt: '2026-11-07T00:00:00Z', finalizedBy: w.profiles[0].id } }]
    w.productionReceipts = [{ id: id(91), runId, styleId: style.id, lineId: line.id, receivedAt: '2026-11-07', quantities: { ...line.received }, unitCost: 100, netAmount: 27700, voided: false, version: 1, createdAt: '2026-11-07', createdBy: w.profiles[0].id }]
    const stamp = { version: 1, createdAt: '2026-11-07', updatedAt: '2026-11-07', updatedBy: w.profiles[0].id }
    w.operations = { poDispatches: [], poDispatchAttempts: [], operationCatalogs: [], shipmentLedgers: [], shipmentBatches: [], calendarEvents: [], calendarEventAudits: [], employeeFactoryAssignments: [], orderSourceRecords: [], styleOperations: [{ ...stamp, id: id(92), styleId: style.id, kind: 'label', supplierFactoryId: supplier.id, supplierNameSnapshot: supplier.name, note: '', voided: false, rows: [{ id: itemId, catalogId: id(93), name: '완료 라벨', specification: '예산 산출용 라벨 규격', quantity: 290, lossQuantity: 0, completedQuantity: 277, status: 'done', orderedAt: '', requestedAt: '', completedAt: '2026-11-07', dueDate: '', note: '생산 전용 비공개 작업 코멘트' }] }] }
    w.processingUnitPrices = [{ ...stamp, styleId: style.id, lineId: line.id, kind: 'label', itemKey: itemId, unitCost: 2, supplierFactoryId: supplier.id, supplierNameSnapshot: supplier.name }]
    const safe = buildBudgetSources(w).settlements.find(row => row.sourceKey.startsWith('processing:label:'))
    expect(safe).toMatchObject({ receivedQuantity: 277, netAmount: 554, evidence: '예산 산출용 라벨 규격' })
    expect(JSON.stringify(safe)).not.toContain('생산 전용 비공개 작업 코멘트')
    // A latest-only parent order cannot stand in for a different run ledger.
    line.order.M = 291
    const unclear = buildBudgetSources(w)
    expect(unclear.settlements.some(row => row.sourceKey.startsWith('processing:label:'))).toBe(false)
    expect(unclear.warnings.some(warning => warning.includes('부분 입고 마감의 가공 수량 배분'))).toBe(true)
  })
  it('원본에 저장되지 않은 JOOR·ADER 배분은 임의 추정하지 않는다', () => {
    const { w } = raw(), source = buildBudgetSources(w)
    expect(source.orders[0].joorQuantity).toBeNull(); expect(source.orders[0].aderQuantity).toBeNull()
  })
})
function fullSku(code: string, color: string) { return /^[A-Z0-9]{12}[A-Z]{2}$/.test(code) && code.endsWith(color) ? code : `${code}${color}` }
