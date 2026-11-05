import { emptyQuantities, quantityTotal, SIZES, type Profile, type Quantities, type Style, type Workspace } from './types'
import type { ProductionRun } from './production-ledger'
import type { PartialDeliveryInstallment } from './partial-deliveries'
import { validatePartialDeliveries } from './partial-deliveries'
import { getProjectIdentity } from './project-identity'

export type ProductionRegion = 'domestic' | 'overseas' | 'unclassified'
export interface QuantitySplit { total: number; domestic: number; overseas: number; unclassified: number }
export interface ExecutiveMonth { month: string; planned: QuantitySplit; expected: QuantitySplit; received: QuantitySplit }
export interface ExecutiveProductionOptions {
  profileId: string
  fromMonth: string
  toMonth: string
  asOf?: string
  projectIds?: readonly string[] | null
  factoryIds?: readonly string[] | null
  seasons?: readonly string[] | null
}
export interface ExecutiveCurrent { ordered: number; received: number; outstanding: number; producing: number; awaiting: number; statusUnknown: number }
export interface ExecutiveCountry { country: string; region: ProductionRegion; planned: number; expected: number; received: number; current: number; producing: number; awaiting: number; statusUnknown: number; orderCount: number }
export interface ExecutiveCoverage {
  undatedExpected: number
  undatedPlanned: number
  undatedReceived: number
  unclassifiedCurrent: number
  invalidPartialPlans: number
  legacyScalarPlans: number
  legacyReceiptQuantity: number
  unallocatedLegacyReceived: number
  overReceived: number
  orphanReceipts: number
  invalidQuantityRows: number
  futureReceiptQuantity: number
}
export interface ExecutiveOrder {
  id: string; source: 'run' | 'legacy'; runId: string | null; styleId: string; lineId: string
  projectId: string; projectName: string; season: string; factoryId: string; factoryName: string
  styleCode: string; color: string; country: string; region: ProductionRegion
  orderQuantity: number; receivedQuantity: number; outstandingQuantity: number
  status: 'producing' | 'awaiting' | 'unknown' | 'closed' | 'rejected'
  deliveries: { date: string; planned: number; expected: number }[]
}
export interface ExecutiveProductionReport {
  authorized: boolean; asOf: string; fromMonth: string; toMonth: string
  months: ExecutiveMonth[]
  totals: { planned: QuantitySplit; expected: QuantitySplit; received: QuantitySplit }
  current: ExecutiveCurrent
  countries: ExecutiveCountry[]
  coverage: ExecutiveCoverage
  orders: ExecutiveOrder[]
}

const blankSplit = (): QuantitySplit => ({ total: 0, domestic: 0, overseas: 0, unclassified: 0 })
const blankCurrent = (): ExecutiveCurrent => ({ ordered: 0, received: 0, outstanding: 0, producing: 0, awaiting: 0, statusUnknown: 0 })
const blankCoverage = (): ExecutiveCoverage => ({ undatedExpected: 0, undatedPlanned: 0, undatedReceived: 0, unclassifiedCurrent: 0, invalidPartialPlans: 0, legacyScalarPlans: 0, legacyReceiptQuantity: 0, unallocatedLegacyReceived: 0, overReceived: 0, orphanReceipts: 0, invalidQuantityRows: 0, futureReceiptQuantity: 0 })
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const clean = (value: string | undefined | null) => typeof value === 'string' ? value.trim() : ''
const selected = (values: readonly string[] | null | undefined, value: string) => values == null || values.includes(value)
function koreanDate(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value)
  return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}-${parts.find(part => part.type === 'day')!.value}`
}
export const executiveToday = () => koreanDate(new Date())
export function executiveMonthRange(fromMonth: string, toMonth: string): string[] {
  const index = (value: string) => {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value) || Number(value.slice(0, 4)) < 1000) throw new Error('조회 월을 YYYY-MM 형식으로 입력해 주세요.')
    return Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1
  }
  const from = index(fromMonth), to = index(toMonth)
  if (to < from || to - from >= 36) throw new Error('조회 기간은 시작 월부터 최대 36개월까지 선택해 주세요.')
  return Array.from({ length: to - from + 1 }, (_, offset) => `${Math.floor((from + offset) / 12)}-${String((from + offset) % 12 + 1).padStart(2, '0')}`)
}
export function canViewExecutiveProduction(workspace: Workspace, supplied: Pick<Profile, 'id'> | string): boolean {
  const id = typeof supplied === 'string' ? supplied : supplied.id
  const actor = workspace.profiles.find(profile => profile.id === id)
  return !!actor?.approved && actor.active && (actor.role === 'admin' || actor.role === 'internal')
}
/** The country comes from the registered manufacturing factory, never a
 * company name, project season, shipping address or a missing-value guess. */
export function normalizeProductionCountry(value: string | null | undefined): { country: string; region: ProductionRegion } {
  const original = clean(value), key = original.toLocaleLowerCase().replace(/[\s._()\-]/g, '')
  if (!key || ['미지정', '미등록', '미정', '국가미지정', '국가미등록', 'unknown', 'unspecified', 'n/a', 'na', 'null', 'undefined'].includes(key)) return { country: '국가 미지정', region: 'unclassified' }
  if (['대한민국', '한국', 'kr', 'kor', 'korea', 'southkorea', 'republicofkorea', 'korearepublicof'].includes(key)) return { country: '대한민국', region: 'domestic' }
  const aliases: Record<string, string> = { cn: '중국', chn: '중국', china: '중국', 중국: '중국', vn: '베트남', vnm: '베트남', vietnam: '베트남', 베트남: '베트남', jp: '일본', jpn: '일본', japan: '일본', 일본: '일본' }
  return { country: aliases[key] || original, region: 'overseas' }
}
function quantities(value: Quantities | undefined): Quantities | null {
  if (!value || SIZES.some(size => !Number.isSafeInteger(value[size]) || value[size] < 0 || value[size] > 10_000_000)) return null
  return Object.fromEntries(SIZES.map(size => [size, value[size]])) as Quantities
}
const addQuantities = (target: Quantities, value: Quantities) => { for (const size of SIZES) target[size] += value[size] }
const difference = (left: Quantities, right: Quantities): Quantities => Object.fromEntries(SIZES.map(size => [size, Math.max(left[size] - right[size], 0)])) as Quantities
const minimum = (left: Quantities, right: Quantities): Quantities => Object.fromEntries(SIZES.map(size => [size, Math.min(left[size], right[size])])) as Quantities
const addSplit = (split: QuantitySplit, region: ProductionRegion, quantity: number) => { split.total += quantity; split[region] += quantity }
const parentIsProduction = (style: Style) => style.stage === 'production' || (style.stage === 'registered' || style.stage === 'approved') && style.production.some(line => quantityTotal(line.order) > 0 || quantityTotal(line.received) > 0 || quantityTotal(line.shipped) > 0)
const unique = <T extends { id: string }>(items: readonly T[]) => [...new Map(items.map(item => [item.id, item])).values()]
const beganBy = (value: string | null | undefined, asOf: string) => !!value && (validDate(value) ? value <= asOf : Number.isFinite(Date.parse(value)) && koreanDate(new Date(value)) <= asOf)

/** Read-only management aggregation. Ledger runs/receipts are authoritative;
 * uncovered parent quantities remain separate legacy sources. No saved
 * quantity, financial snapshot, approval, project or factory is modified. */
export function buildExecutiveProductionReport(workspace: Workspace, options: ExecutiveProductionOptions): ExecutiveProductionReport {
  const asOf = options.asOf || executiveToday()
  const report: ExecutiveProductionReport = { authorized: false, asOf, fromMonth: options.fromMonth, toMonth: options.toMonth, months: [], totals: { planned: blankSplit(), expected: blankSplit(), received: blankSplit() }, current: blankCurrent(), countries: [], coverage: blankCoverage(), orders: [] }
  if (!canViewExecutiveProduction(workspace, options.profileId)) return report
  if (!validDate(asOf)) throw new Error('집계 기준일을 확인해 주세요.')
  report.authorized = true
  report.months = executiveMonthRange(options.fromMonth, options.toMonth).map(month => ({ month, planned: blankSplit(), expected: blankSplit(), received: blankSplit() }))
  const monthMap = new Map(report.months.map(month => [month.month, month]))
  const countries = new Map<string, ExecutiveCountry>()
  const styles = new Map(workspace.styles.filter(style => !style.deletedAt).map(style => [style.id, style]))
  const allRuns = unique(workspace.productionRuns || []).filter(run => run.itemType === 'product' && styles.get(run.styleId)?.production.some(line => line.id === run.lineId))
  const runMap = new Map(allRuns.map(run => [run.id, run]))
  const allReceipts = unique(workspace.productionReceipts || []).filter(receipt => !receipt.voided)
  const metadata = (style: Style, projectId: string, factoryId: string) => {
    const project = getProjectIdentity(workspace, projectId), factory = workspace.factories.find(item => item.id === factoryId)
    return { projectId, projectName: project.name, season: project.season || (projectId === style.projectId ? style.season : ''), factoryId, factoryName: factory?.name || '공장 미지정', ...normalizeProductionCountry(factory?.country) }
  }
  const matches = (meta: ReturnType<typeof metadata>) => selected(options.projectIds, meta.projectId) && selected(options.factoryIds, meta.factoryId) && selected(options.seasons, meta.season)
  const countryFor = (meta: ReturnType<typeof metadata>) => {
    if (!countries.has(meta.country)) countries.set(meta.country, { country: meta.country, region: meta.region, planned: 0, expected: 0, received: 0, current: 0, producing: 0, awaiting: 0, statusUnknown: 0, orderCount: 0 })
    return countries.get(meta.country)!
  }
  const recordReceived = (meta: ReturnType<typeof metadata>, date: string, quantity: number, legacy = false) => {
    if (!quantity) return
    if (validDate(date) && date > asOf) { report.coverage.futureReceiptQuantity += quantity; return }
    if (legacy) report.coverage.legacyReceiptQuantity += quantity
    if (!validDate(date)) { report.coverage.undatedReceived += quantity; return }
    const month = monthMap.get(date.slice(0, 7))
    if (month) { addSplit(month.received, meta.region, quantity); countryFor(meta).received += quantity }
  }
  const register = (order: ExecutiveOrder, received: Quantities, meta: ReturnType<typeof metadata>) => {
    const country = countryFor(meta), active = order.status !== 'closed' && order.status !== 'rejected'
    country.orderCount += 1
    if (active) {
      report.current.ordered += order.orderQuantity; report.current.received += quantityTotal(received); report.current.outstanding += order.outstandingQuantity
      country.current += order.outstandingQuantity
      const key = order.status === 'producing' ? 'producing' : order.status === 'awaiting' ? 'awaiting' : 'statusUnknown'
      report.current[key] += order.outstandingQuantity; country[key] += order.outstandingQuantity
      if (meta.region === 'unclassified') report.coverage.unclassifiedCurrent += order.outstandingQuantity
    }
    for (const delivery of order.deliveries) {
      if (!validDate(delivery.date)) { report.coverage.undatedPlanned += delivery.planned; report.coverage.undatedExpected += delivery.expected; continue }
      const month = monthMap.get(delivery.date.slice(0, 7))
      if (month) { addSplit(month.planned, meta.region, delivery.planned); addSplit(month.expected, meta.region, delivery.expected); country.planned += delivery.planned; country.expected += delivery.expected }
    }
    report.orders.push(order)
  }
  const receiptsFor = (run: ProductionRun) => allReceipts.filter(receipt => receipt.runId === run.id && receipt.styleId === run.styleId && receipt.lineId === run.lineId)
  for (const run of allRuns) {
    const style = styles.get(run.styleId)!, line = style.production.find(item => item.id === run.lineId)!, meta = metadata(style, run.projectId, run.factoryIdSnapshot)
    if (!matches(meta)) continue
    const ordered = quantities(run.order)
    if (!ordered) { report.coverage.invalidQuantityRows += 1; continue }
    const received = emptyQuantities()
    for (const receipt of receiptsFor(run)) {
      const value = quantities(receipt.quantities)
      if (!value) { report.coverage.invalidQuantityRows += 1; continue }
      recordReceived(meta, receipt.receivedAt, quantityTotal(value))
      if (!validDate(receipt.receivedAt) || receipt.receivedAt <= asOf) addQuantities(received, value)
    }
    report.coverage.overReceived += quantityTotal(difference(received, ordered))
    const condition = workspace.productionConditions?.find(item => item.runId === run.id), supplierOrder = workspace.supplierProductionOrders?.find(item => item.runId === run.id)
    const closed = run.closedAt ? beganBy(run.closedAt, asOf) : condition?.status === 'closed', rejected = condition?.status === 'rejected'
    const approved = condition?.approval ? beganBy(condition.approval.approvedAt, asOf) : condition?.status === 'approved'
    const started = beganBy(supplierOrder?.startedAt, asOf) || approved
    const pending = !!condition && ['awaiting_po', 'awaiting_supplier', 'awaiting_approval', 'revision_requested'].includes(condition.status) || !!supplierOrder && ['awaiting_po', 'awaiting_acceptance', 'accepted'].includes(supplierOrder.status)
    const status: ExecutiveOrder['status'] = closed ? 'closed' : rejected ? 'rejected' : started ? 'producing' : pending ? 'awaiting' : 'unknown'
    const remaining = difference(ordered, received), current = closed || rejected ? 0 : quantityTotal(remaining)
    const dueDate = approved && validDate(condition?.approval?.finalDeliveryDate || '') ? condition!.approval!.finalDeliveryDate : run.expectedDue
    let installments: PartialDeliveryInstallment[] | null = null
    const plan = workspace.partialDeliveryPlans?.find(item => item.runId === run.id)
    if (plan?.items.length) { try { validatePartialDeliveries(plan.items, ordered); installments = plan.items } catch { report.coverage.invalidPartialPlans += 1 } }
    const deliveries: ExecutiveOrder['deliveries'] = []
    if (installments) {
      if (installments.every(item => !!item.quantities)) {
        const toAllocate = { ...received }
        for (const item of installments) {
          const rest = emptyQuantities()
          for (const size of SIZES) { const allocated = Math.min(item.quantities![size], toAllocate[size]); toAllocate[size] -= allocated; rest[size] = item.quantities![size] - allocated }
          deliveries.push({ date: item.dueDate, planned: rejected ? 0 : item.quantity, expected: closed || rejected ? 0 : quantityTotal(rest) })
        }
      } else {
        report.coverage.legacyScalarPlans += 1
        let completed = quantityTotal(ordered) - quantityTotal(remaining)
        for (const item of installments) { const allocated = Math.min(item.quantity, completed); completed -= allocated; deliveries.push({ date: item.dueDate, planned: rejected ? 0 : item.quantity, expected: closed || rejected ? 0 : item.quantity - allocated }) }
      }
    } else deliveries.push({ date: validDate(dueDate) ? dueDate : '', planned: rejected ? 0 : quantityTotal(ordered), expected: current })
    register({ id: run.id, source: 'run', runId: run.id, styleId: style.id, lineId: line.id, ...meta, factoryName: run.factoryNameSnapshot || meta.factoryName, styleCode: run.styleCodeSnapshot || style.code, color: line.color, orderQuantity: quantityTotal(ordered), receivedQuantity: quantityTotal(received), outstandingQuantity: current, status, deliveries }, received, meta)
  }
  for (const style of styles.values()) for (const line of style.production) {
    const lineRuns = allRuns.filter(run => run.styleId === style.id && run.lineId === line.id)
    if (!lineRuns.length && !parentIsProduction(style)) continue
    const meta = metadata(style, style.projectId, style.factoryId), legacySelected = matches(meta)
    const lineSelected = legacySelected || lineRuns.some(run => matches(metadata(style, run.projectId, run.factoryIdSnapshot)))
    if (!lineSelected) continue
    const parentOrder = quantities(line.order), parentReceived = quantities(line.received)
    if (!parentOrder || !parentReceived) { report.coverage.invalidQuantityRows += 1; continue }
    const coveredOrder = emptyQuantities(), coveredReceived = emptyQuantities()
    for (const run of lineRuns) {
      const value = quantities(run.order); if (value) addQuantities(coveredOrder, value)
      for (const receipt of receiptsFor(run)) {
        const receiptValue = quantities(receipt.quantities)
        // A known future ledger row cannot explain away a parent receipt that
        // was already recorded as past/undated actual stock. If both records
        // are future-dated, deduplicate their known quantity without counting
        // either as today's actual receipt.
        const futureLedger = validDate(receipt.receivedAt) && receipt.receivedAt > asOf
        const futureParent = validDate(line.receivedAt) && line.receivedAt > asOf
        if (receiptValue && (!futureLedger || futureParent)) addQuantities(coveredReceived, receiptValue)
      }
    }
    const legacyOrder = difference(parentOrder, coveredOrder), surplusReceived = difference(parentReceived, coveredReceived)
    const legacyReceived = lineRuns.length ? minimum(surplusReceived, legacyOrder) : surplusReceived
    // An unallocated parent receipt must not be guessed into another project's
    // production run or monthly installment. Keep it visible for reconciliation.
    report.coverage.unallocatedLegacyReceived += quantityTotal(difference(surplusReceived, legacyReceived))
    if (!legacySelected || !quantityTotal(legacyOrder) && !quantityTotal(legacyReceived)) continue
    const actualReceived = validDate(line.receivedAt) && line.receivedAt > asOf ? emptyQuantities() : legacyReceived
    recordReceived(meta, line.receivedAt, quantityTotal(legacyReceived), true)
    report.coverage.overReceived += quantityTotal(difference(actualReceived, legacyOrder))
    const remaining = quantityTotal(difference(legacyOrder, actualReceived))
    register({ id: `legacy:${style.id}:${line.id}`, source: 'legacy', runId: null, styleId: style.id, lineId: line.id, ...meta, styleCode: style.code, color: line.color, orderQuantity: quantityTotal(legacyOrder), receivedQuantity: quantityTotal(actualReceived), outstandingQuantity: remaining, status: 'unknown', deliveries: [{ date: validDate(style.dueDate) ? style.dueDate : '', planned: quantityTotal(legacyOrder), expected: remaining }] }, actualReceived, meta)
  }
  for (const receipt of allReceipts) {
    const knownRun = (workspace.productionRuns || []).find(run => run.id === receipt.runId)
    if (knownRun && knownRun.itemType !== 'product') continue
    const run = runMap.get(receipt.runId)
    if (run && run.styleId === receipt.styleId && run.lineId === receipt.lineId) continue
    const style = styles.get(knownRun?.styleId || receipt.styleId)
    if (style && matches(metadata(style, knownRun?.projectId || style.projectId, knownRun?.factoryIdSnapshot || style.factoryId))) report.coverage.orphanReceipts += 1
  }
  for (const month of report.months) for (const kind of ['planned', 'expected', 'received'] as const) for (const region of ['domestic', 'overseas', 'unclassified'] as const) addSplit(report.totals[kind], region, month[kind][region])
  report.countries = [...countries.values()].filter(country => country.current || country.planned || country.expected || country.received).sort((left, right) => right.current - left.current || left.country.localeCompare(right.country, 'ko-KR'))
  return report
}
