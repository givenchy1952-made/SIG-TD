import { SIZES, quantityTotal, type Profile, type Workspace } from './types'
import { getProjectIdentity } from './project-identity'
import { fullStyleSku } from './style-identity'
import { sigEuljiNetAmount } from './sig-eulji'
import { isBudgetAmount, multiplyBudgetCost, multiplyBudgetQuantity, roundBudgetMoney, sumBudgetMoney } from './budget-money'
import type { BudgetAudit, BudgetCostData, BudgetDataByKind, BudgetException, BudgetFAEntry, BudgetFARow, BudgetFilters, BudgetGroup, BudgetGroupBy, BudgetIdentity, BudgetOrderRow, BudgetOrderSource, BudgetPaymentData, BudgetRecord, BudgetRecordKind, BudgetReport, BudgetSources, BudgetSummary, BudgetWorkspaceFields } from './budget-types'

type BudgetWorkspace = Workspace & BudgetWorkspaceFields
const blankSources = (): BudgetSources => ({ orders: [], settlements: [], warnings: [] })
const isHQ = (profile: Profile | undefined) => !!profile?.approved && profile.active && ['admin', 'internal'].includes(profile.role)
const isReader = (profile: Profile | undefined) => !!profile?.approved && profile.active && ['admin', 'internal', 'finance'].includes(profile.role)
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const match = (value: string, selection: readonly string[] | null | undefined) => selection == null || selection.includes(value)
const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const stampDate = (value: string) => date(value.slice(0, 10)) ? value.slice(0, 10) : ''
const validQuantity = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 60_000_000
const completeLine = (line: Workspace['styles'][number]['production'][number]) => quantityTotal(line.order) > 0 && SIZES.every(size => line.received[size] >= line.order[size])
const numeric = (value: unknown): number | null => {
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.0+)?$/.test(text)) return null
    value = Number(text.replaceAll(',', ''))
  }
  return typeof value === 'number' && validQuantity(value) ? value : null
}
/** The order importer serializes Excel Date cells as ISO timestamps. Numeric
 * serials are accepted only here, after matching an explicit date header. */
function orderSourceDate(value: unknown): string {
  if (typeof value === 'string') {
    const text = value.trim()
    if (date(text)) return text
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text) && Number.isFinite(Date.parse(text)) && date(text.slice(0, 10))) return text.slice(0, 10)
    const parts = /^(\d{4})[./-]\s*(\d{1,2})[./-]\s*(\d{1,2})\.?$/.exec(text)
    if (parts) { const normalized = `${parts[1]}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')}`; return date(normalized) ? normalized : '' }
    if (!/^\d{1,7}(?:\.\d+)?$/.test(text)) return ''
    value = Number(text)
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value >= 2_958_466 || Math.floor(value) === 60) return ''
  const day = Math.floor(value), normalized = new Date(Date.UTC(1899, 11, 31) + (day - (day > 60 ? 1 : 0)) * 86_400_000).toISOString().slice(0, 10)
  return date(normalized) ? normalized : ''
}
const errorLiteral = /^#(?:REF!|NAME\?|VALUE!|N\/A|DIV\/0!|NUM!|NULL!|SPILL!|CALC!)$/i
const validCode = (value: string) => !!value && !errorLiteral.test(value) && !/[\x00-\x1f\x7f]/.test(value)
export const budgetCode = (projectCode: string, styleCode: string) => `${projectCode}${styleCode}`.replace(/\s/g, '')
export function budgetSourceFingerprint(source: Pick<BudgetFAEntry, 'sourceKey' | 'sourceVersion'>): string { return `${source.sourceKey}@${source.sourceVersion}` }
export function defaultBudgetPayment(entry: BudgetFAEntry): BudgetPaymentData {
  const { payment: _payment, paymentRecord: _record, paymentStale: _stale, ...source } = entry as BudgetFARow
  return { sourceKey: entry.sourceKey, sourceFingerprint: entry.sourceFingerprint, sourceSnapshot: structuredClone(source), status: 'unpaid', paidAt: '', voucherNo: '', account: '', description: '', splitPayment: '' }
}
/** Budget financial source fields are flat scalars; compare values rather than
 * JSON property order, which PostgreSQL JSONB does not preserve. */
function sameBudgetSource(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) return false
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>, fields = Object.keys(a)
  return fields.length === Object.keys(b).length && fields.every(field => Object.hasOwn(b, field) && a[field] === b[field])
}
const moneySum = sumBudgetMoney
const safeMoney = isBudgetAmount

/** Derive only explicit order identities, quantities and financial snapshots. The
 * cloud finance loader calls this on a narrowly projected private source input. */
export function buildBudgetSources(workspace: Workspace): BudgetSources {
  const result = blankSources(), warnings = new Set<string>()
  const styles = workspace.styles.filter(style => !style.deletedAt || workspace.productionRuns?.some(run => run.styleId === style.id && run.closedAt && run.snapshot))
  for (const style of styles) for (const line of style.production) {
    const runs = (workspace.productionRuns || []).filter(run => run.styleId === style.id && run.lineId === line.id)
    const source = workspace.operations?.orderSourceRecords.find(record => record.styleId === style.id && record.lineId === line.id)
    const identity = (projectId: string, code: string, factoryId: string, factoryName: string, sku = fullStyleSku(style.code, line.color)): BudgetIdentity => {
      const project = getProjectIdentity(workspace, projectId)
      return { projectId, projectCode: code, projectName: project.name, budgetCode: budgetCode(code, sku), styleId: style.id, lineId: line.id, styleCode: sku, color: line.color, season: project.season || style.season, factoryId, factoryName }
    }
    const metadata = (code: string, quantity: number, allowQuantity: boolean) => {
      const matching = source?.rows.filter(row => clean(String(row.columns.A ?? '')) === code) || []
      const values = (pattern: RegExp): unknown[] => {
        const columns = Object.keys(source?.headers || {}).filter(column => pattern.test((source?.headers as Record<string, string>)[column].normalize('NFKC').replace(/\s/g, '')))
        return matching.flatMap(row => columns.map(column => row.columns[column as keyof typeof row.columns]))
      }
      const literal = (pattern: RegExp): string => { const unique = [...new Set(values(pattern).map(value => String(value ?? '').trim()).filter(value => validCode(value)))]; return unique.length === 1 ? unique[0] : '' }
      const total = (pattern: RegExp): number | null => { const raw = values(pattern), parsed = raw.map(numeric); return allowQuantity && raw.length && parsed.every(value => value !== null) ? moneySum(parsed as number[]) : null }
      const parts = code.split('-')
      const rawDates = values(/발주요청일|발주날짜|발주일자|오더요청일|ORDERDATE/i).filter(value => value !== null && value !== undefined && String(value).trim() !== '')
      const dates = [...new Set(rawDates.map(orderSourceDate).filter(Boolean))]
      const orderDate = dates.length === 1 && rawDates.every(value => !!orderSourceDate(value)) ? dates[0] : ''
      if (rawDates.length && !orderDate) warnings.add(`${code}: 원본 발주 요청일 형식을 확인해 주세요.`)
      const joor = total(/JOOR(?:GB)?|GB(?:QTY|수량)/i), ader = total(/ADER(?:KOR)?|KOR(?:QTY|수량)/i)
      if ((joor !== null || ader !== null) && (joor ?? 0) + (ader ?? 0) !== quantity) warnings.add(`${code}: JOOR·ADER 배분과 발주 수량이 달라 확인이 필요합니다.`)
      return { brand: literal(/^브랜드$|^BRAND$/i) || (parts.length === 4 ? parts[0] : ''), productionType: literal(/생산구분|오더구분/i) || (parts.length === 4 ? parts[2] : ''), orderCode: literal(/^발주코드$|^오더코드$/i) || (parts.length === 4 ? parts[3] : ''), orderDate: date(orderDate) ? orderDate : '', joorQuantity: joor, aderQuantity: ader }
    }
    const addOrder = (value: BudgetOrderSource) => {
      if (!validCode(value.projectCode)) warnings.add(`${value.styleCode}: 본사 프로젝트 코드가 미등록되어 예산 코드 연결을 확인해야 합니다.`)
      if (validQuantity(value.quantity) && validQuantity(value.receivedQuantity)) result.orders.push(value)
      else warnings.add(`${value.styleCode}: 올바르지 않은 수량은 예산 집계에서 제외했습니다.`)
    }
    for (const run of runs) {
      if (style.deletedAt && (!run.closedAt || !run.snapshot)) continue
      const snapshot = run.snapshot, code = snapshot?.projectCode || run.projectCode || getProjectIdentity(workspace, run.projectId).code
      const sku = snapshot?.styleCode || run.styleCodeSnapshot || fullStyleSku(style.code, line.color)
      const quantity = snapshot?.orderQuantity ?? quantityTotal(run.order)
      const receipts = (workspace.productionReceipts || []).filter(receipt => receipt.runId === run.id && !receipt.voided)
      const receivedQuantity = snapshot?.receivedQuantity ?? moneySum(receipts.map(receipt => quantityTotal(receipt.quantities)))
      const base = identity(run.projectId, code, snapshot?.factoryIdSnapshot || run.factoryIdSnapshot || style.factoryId, snapshot?.factory || snapshot?.factoryNameSnapshot || run.factoryNameSnapshot || workspace.factories.find(factory => factory.id === style.factoryId)?.name || '', sku)
      addOrder({ ...base, sourceKey: `production:${run.id}`, ...metadata(code, quantity, runs.length === 1), quantity, receivedQuantity })
      if (run.closedAt && snapshot) {
        const valid = validCode(code) && validQuantity(snapshot.orderQuantity) && validQuantity(snapshot.receivedQuantity) && safeMoney(snapshot.netAmount, 3) && safeMoney(snapshot.vatAmount, 3) && safeMoney(snapshot.grossAmount, 3) && safeMoney(snapshot.unitCost, 2)
        if (!valid) { warnings.add(`${sku}: 마감 스냅샷의 금액·수량을 확인해야 합니다.`); continue }
        const sourceKey = `production:${run.id}`
        result.settlements.push({ ...base, sourceKey, sourceVersion: run.version, sourceFingerprint: `${sourceKey}@${run.version}`, orderDate: metadata(code, quantity, false).orderDate, receivedAt: snapshot.lastReceivedAt || '', unitCost: snapshot.unitCost, consumption: null, orderQuantity: snapshot.orderQuantity, receivedQuantity: snapshot.receivedQuantity, unit: snapshot.itemType === 'fabric' ? 'YDS' : 'EA', netAmount: snapshot.netAmount, vatAmount: snapshot.vatAmount, grossAmount: snapshot.grossAmount, owner: snapshot.owner || snapshot.ownerNameSnapshot || '', item: snapshot.itemType === 'fabric' ? '원단' : snapshot.itemType === 'label' ? '라벨' : '제품', evidence: `생산 ${snapshot.round}차 마감 확정 ${stampDate(snapshot.finalizedAt)}` })
      } else if (quantity > 0 && receivedQuantity >= quantity) warnings.add(`${sku}: 입고 완료 차수는 마감을 확정하면 FA 을지에 누적됩니다.`)
    }
    if (!runs.length && !style.deletedAt) {
      const project = getProjectIdentity(workspace, style.projectId), quantity = quantityTotal(line.order)
      addOrder({ ...identity(style.projectId, project.code, style.factoryId, workspace.factories.find(factory => factory.id === style.factoryId)?.name || ''), sourceKey: `legacy:${style.id}:${line.id}`, ...metadata(project.code, quantity, true), quantity, receivedQuantity: quantityTotal(line.received) })
      if (completeLine(line)) warnings.add(`${fullStyleSku(style.code, line.color)}: 기존 누적 입고는 생산 차수 마감과 연결해야 FA 을지에 누적됩니다.`)
    }
    // A service record's garment-level movements cannot be allocated to different
    // historical projects safely. Never spread that same amount across runs.
    if (runs.some(run => run.projectId !== style.projectId)) {
      if (completeLine(line)) warnings.add(`${fullStyleSku(style.code, line.color)}: 여러 프로젝트의 가공 수량은 원본 배분 확인이 필요해 FA 자동 누적에서 제외했습니다.`)
      continue
    }
    const runIds = new Set(runs.map(run => run.id))
    const lineReceipts = (workspace.productionReceipts || []).filter(receipt => runIds.has(receipt.runId) && !receipt.voided)
    // A short receipt may be deliberately finalized. Accept it only when the
    // complete, closed run ledger is provably this parent's whole order and
    // receipt scope; never assign a historical project's garment movements.
    const finalizedShortLine = runs.length > 0 && quantityTotal(line.received) > 0
      && runs.every(run => !!run.closedAt && !!run.snapshot && run.snapshot.orderQuantity === quantityTotal(run.order))
      && moneySum(runs.map(run => run.snapshot!.receivedQuantity)) === quantityTotal(line.received)
      && SIZES.every(size => moneySum(runs.map(run => run.order[size])) === line.order[size]
        && moneySum(lineReceipts.map(receipt => receipt.quantities[size])) === line.received[size])
    if (style.deletedAt || !(completeLine(line) || finalizedShortLine) || !date(line.receivedAt)) {
      if (!style.deletedAt && !completeLine(line) && runs.some(run => run.closedAt && run.snapshot)) warnings.add(`${fullStyleSku(style.code, line.color)}: 부분 입고 마감의 가공 수량 배분을 확인해야 FA 을지에 누적됩니다.`)
      continue
    }
    const project = getProjectIdentity(workspace, style.projectId)
    if (!validCode(project.code)) continue
    const addService = (kind: 'label' | 'embroidery' | 'quality', itemKey: string, workVersion: number, item: string, supplierId: string, supplierName: string, assignmentVersion: number, note: string) => {
      const quote = workspace.processingUnitPrices?.find(price => price.styleId === style.id && price.lineId === line.id && price.kind === kind && price.itemKey === itemKey)
      if (!quote || quote.unitCost === null || quote.supplierFactoryId !== supplierId || !safeMoney(quote.unitCost)) { warnings.add(`${fullStyleSku(style.code, line.color)} ${item}: 저장된 업체 단가를 확인해야 FA 을지에 누적됩니다.`); return }
      const quantity = quantityTotal(kind === 'label' ? line.shipped : line.received)
      if (!quantity) return
      try {
        const sourceKey = `processing:${kind}:${style.id}:${line.id}:${itemKey}`, net = sigEuljiNetAmount(quote.unitCost, quantity), vat = roundBudgetMoney(net / 10, 3)
        result.settlements.push({ ...identity(style.projectId, project.code, supplierId, quote.supplierNameSnapshot || supplierName), sourceKey, sourceVersion: quote.version, sourceFingerprint: `${sourceKey}@${style.version}:${workVersion}:${quote.version}:${assignmentVersion}:${supplierId}`, orderDate: metadata(project.code, quantityTotal(line.order), false).orderDate, receivedAt: line.receivedAt, unitCost: quote.unitCost, consumption: null, orderQuantity: quantityTotal(line.order), receivedQuantity: quantity, unit: 'EA', netAmount: net, vatAmount: vat, grossAmount: moneySum([net, vat]), owner: workspace.profiles.find(person => person.id === (line.ownerId ?? style.ownerId))?.name || '', item, evidence: note })
      } catch { warnings.add(`${fullStyleSku(style.code, line.color)} ${item}: 가공 금액을 확인해 주세요.`) }
    }
    for (const record of workspace.operations?.styleOperations.filter(record => record.styleId === style.id && !record.voided) || []) for (const item of record.rows) {
      if (!['done', 'approved'].includes(item.status)) continue
      const supplier = workspace.factories.find(factory => factory.id === record.supplierFactoryId)
      if (!supplier || supplier.active === false) continue
      const quote = workspace.processingUnitPrices?.find(price => price.styleId === style.id && price.lineId === line.id && price.kind === record.kind && price.itemKey === item.id)
      if (quote?.supplierCatalogId && quote.supplierCatalogId !== item.catalogId) continue
      addService(record.kind, item.id, record.version, item.name, supplier.id, record.supplierNameSnapshot || supplier.name, 0, item.specification || '')
    }
    const detail = workspace.productionDetails?.find(detail => detail.styleId === style.id && detail.lineId === line.id)
    const assignment = workspace.inspectionAssignments?.find(assignment => assignment.styleId === style.id && assignment.lineId === line.id)
    const inspector = assignment?.provider ? workspace.factories.find(factory => factory.serviceType === 'inspection' && factory.inspectionProvider === assignment.provider && factory.active !== false) : undefined
    if (detail?.quality.category && ['done', 'approved'].includes(detail.quality.status) && inspector) addService('quality', detail.quality.category, detail.version, `품질검사 · ${detail.quality.category}`, inspector.id, inspector.name, assignment!.version, '')
  }
  result.warnings = [...warnings]
  return result
}

const selected = (identity: BudgetIdentity, filters: BudgetFilters) => match(identity.projectId, filters.projectIds) && match(identity.projectCode, filters.projectCodes) && match(identity.styleCode, filters.styleCodes) && match(identity.season, filters.seasons) && match(identity.factoryId, filters.factoryIds)
function emptySummary(): BudgetSummary { return { budget: 0, paid: 0, unpaid: 0, confirmed: 0, remaining: 0, overage: 0, paidVat: 0, paidGross: 0, missingCostCount: 0, orderQuantity: 0, receivedQuantity: 0, annualLimit: null, unallocated: null, progress: null } }
const costKey = (value: { projectId: string; budgetCode: string }) => JSON.stringify([value.projectId, value.budgetCode])
function sumCost(costs: Extract<BudgetRecord, { kind: 'cost' }>[], stage: 'pre' | 'post'): number | null {
  const rows = costs.filter(record => record.data.stage === stage && !record.data.voided)
  return rows.length && rows.every(record => record.data.amount !== null) ? moneySum(rows.map(record => record.data.amount!)) : null
}
/** Every imported row belongs to the source workbook's final per-garment cost,
 * including common expenses. Only legacy manually entered totals are allocated.
 * No saved cost, production or payment record is rewritten by this projection. */
function productionCosts(costs: Extract<BudgetRecord, { kind: 'cost' }>[], importedIds: ReadonlySet<string>, quantity: number): { budget: number | null; unitCost: number | null } {
  const rows = costs.filter(record => record.data.stage === 'pre' && !record.data.voided)
  const unknown = { budget: null, unitCost: null }
  if (!rows.length || rows.some(record => record.data.amount === null)) return unknown
  const perUnit: number[] = [], fixed: number[] = []
  for (const record of rows) {
    const cost = record.data
    if (!importedIds.has(record.id)) fixed.push(cost.amount!)
    else {
      if (cost.unitCost === null || cost.consumption === null) return unknown
      perUnit.push(multiplyBudgetCost(cost.variableUnitCost ?? cost.unitCost, cost.consumption))
    }
  }
  const unit = moneySum(perUnit), totalFixed = moneySum(fixed)
  if (quantity === 0 && totalFixed !== 0) return unknown
  const budget = moneySum([multiplyBudgetQuantity(unit, quantity), totalFixed])
  return { budget, unitCost: totalFixed === 0 ? unit : budget / quantity }
}
function summarize(orders: BudgetOrderRow[], settlements: BudgetFARow[], limits: Extract<BudgetRecord, { kind: 'limit' }>[], selectedSeasons?: readonly string[] | null): BudgetSummary {
  const summary = emptySummary()
  summary.budget = moneySum(orders.map(order => order.productionBudget ?? 0)); summary.missingCostCount = orders.filter(order => order.productionBudget === null).length
  summary.paid = moneySum(settlements.filter(entry => entry.payment.status === 'paid').map(entry => entry.netAmount)); summary.unpaid = moneySum(settlements.filter(entry => entry.payment.status !== 'paid').map(entry => entry.netAmount)); summary.confirmed = moneySum([summary.paid, summary.unpaid])
  summary.paidVat = moneySum(settlements.filter(entry => entry.payment.status === 'paid').map(entry => entry.vatAmount)); summary.paidGross = moneySum(settlements.filter(entry => entry.payment.status === 'paid').map(entry => entry.grossAmount))
  summary.remaining = Math.max(0, moneySum([summary.budget, -summary.paid])); summary.overage = moneySum(orders.filter(order => order.productionBudget !== null).map(order => Math.max(0, moneySum([moneySum(settlements.filter(entry => entry.payment.status === 'paid' && costKey(entry) === costKey(order)).map(entry => entry.netAmount)), -order.productionBudget!])))); summary.progress = summary.budget > 0 ? summary.paid / summary.budget : null
  summary.orderQuantity = moneySum(orders.map(order => order.quantity)); summary.receivedQuantity = moneySum(orders.map(order => order.receivedQuantity))
  const seasons = selectedSeasons == null ? [...new Set(orders.map(order => order.season))] : [...selectedSeasons]
  const selectedLimits = seasons.map(season => limits.find(record => record.data.season === season))
  if (seasons.length && selectedLimits.every(record => record?.data.amount !== null && record?.data.amount !== undefined)) { summary.annualLimit = moneySum(selectedLimits.map(record => record!.data.amount!)); summary.unallocated = moneySum([summary.annualLimit, -summary.budget]) }
  return summary
}
/** Financial vendors can be named in a cost sheet before a site account exists. */
export function budgetCostSupplierKey(cost: Pick<BudgetCostData, 'supplierId' | 'supplierName'>): string {
  return cost.supplierId || (cost.supplierName.trim() ? `unlinked:${cost.supplierName.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR')}` : 'unassigned')
}
function groupIdentity(row: BudgetIdentity, groupBy: BudgetGroupBy): [string, string] {
  if (groupBy === 'project') return [row.projectId, row.projectName]
  if (groupBy === 'projectCode') return [JSON.stringify([row.projectId, row.projectCode]), row.projectCode || '프로젝트 코드 미등록']
  if (groupBy === 'style') return [JSON.stringify([row.projectId, row.styleCode]), row.styleCode]
  if (groupBy === 'season') return [row.season, row.season || '시즌 미등록']
  return [row.factoryId, row.factoryName || '업체 미등록']
}
export function groupBudgetReport(report: Pick<BudgetReport, 'orders' | 'settlements' | 'costs' | 'limits' | 'budgetCostImportRecordIds'>, groupBy: BudgetGroupBy): BudgetGroup[] {
  let orders = report.orders
  const importedIds = new Set(report.budgetCostImportRecordIds || [])
  if (groupBy === 'factory') {
    orders = report.orders.flatMap(order => {
      const costs = report.costs.filter(record => !record.data.voided && costKey(record.data) === costKey(order) && record.data.stage === 'pre')
      const supplierIds = [...new Set([order.factoryId, ...costs.map(record => budgetCostSupplierKey(record.data))])]
      return supplierIds.map(factoryId => {
        const allocated = costs.filter(record => budgetCostSupplierKey(record.data) === factoryId)
        const projected = productionCosts(allocated, importedIds, order.quantity)
        return { ...order, factoryId, factoryName: factoryId === order.factoryId ? order.factoryName : allocated[0]?.data.supplierName || '업체 미등록', productionBudget: allocated.length ? projected.budget : costs.length ? 0 : null, productionUnitCost: allocated.length ? projected.unitCost : costs.length ? 0 : null, quantity: factoryId === order.factoryId ? order.quantity : 0, receivedQuantity: factoryId === order.factoryId ? order.receivedQuantity : 0 }
      })
    })
  }
  const groups = new Map<string, { label: string; orders: BudgetOrderRow[]; settlements: BudgetFARow[] }>()
  for (const row of [...orders, ...report.settlements]) { const [key, label] = groupIdentity(row, groupBy); if (!groups.has(key)) groups.set(key, { label, orders: [], settlements: [] }) }
  for (const row of orders) groups.get(groupIdentity(row, groupBy)[0])!.orders.push(row)
  for (const row of report.settlements) groups.get(groupIdentity(row, groupBy)[0])!.settlements.push(row)
  return [...groups].map(([key, group]) => {
    const identities = [...group.orders, ...group.settlements], totals = summarize(group.orders, group.settlements, [])
    // Closure follows the same evidence as the unclosed detail list. One paid
    // style must not close another style that has no finalized FA evidence.
    const closed = group.orders.length > 0 && totals.missingCostCount === 0 && group.settlements.length > 0
      && group.settlements.every(entry => entry.payment.status === 'paid' && !entry.paymentStale)
      && group.orders.every(order => order.receivedQuantity >= order.quantity
        && group.settlements.some(entry => costKey(entry) === costKey(order)))
    return { key, label: group.label, projectCode: [...new Set(identities.map(row => row.projectCode))].join(', '), season: [...new Set(identities.map(row => row.season))].join(', '), budgetCodes: [...new Set(identities.map(row => row.budgetCode))], totals, closed }
  }).sort((a, b) => a.label.localeCompare(b.label, 'ko-KR', { numeric: true }) || a.key.localeCompare(b.key))
}

export function buildBudgetReport(workspace: BudgetWorkspace, supplied: Profile, filters: BudgetFilters = {}): BudgetReport {
  const actor = workspace.profiles.find(profile => profile.id === supplied.id), allowed = isReader(actor)
  const empty: BudgetReport = { authorized: false, readOnly: true, orders: [], settlements: [], costs: [], limits: [], groups: [], totals: emptySummary(), excess: [], unclosed: [], warnings: [], sources: blankSources() }
  if (!allowed || actor!.role === 'finance' && !workspace.budgetSources) return empty
  const sources = workspace.budgetSources || buildBudgetSources(workspace), records = workspace.budgetRecords || [], warnings = [...sources.warnings]
  const allCosts = records.filter((record): record is Extract<BudgetRecord, { kind: 'cost' }> => record.kind === 'cost')
  const importedIds = new Set((workspace.budgetCostImports || []).map(source => source.recordId))
  const limits = records.filter((record): record is Extract<BudgetRecord, { kind: 'limit' }> => record.kind === 'limit')
  const groupedOrders = new Map<string, BudgetOrderSource>()
  for (const source of sources.orders.filter(row => selected(row, { ...filters, factoryIds: null }) && (match(row.factoryId, filters.factoryIds) || allCosts.some(cost => !cost.data.voided && costKey(cost.data) === costKey(row) && match(budgetCostSupplierKey(cost.data), filters.factoryIds)) || sources.settlements.some(entry => costKey(entry) === costKey(row) && match(entry.factoryId, filters.factoryIds))))) {
    const key = costKey(source), previous = groupedOrders.get(key)
    if (!previous) groupedOrders.set(key, { ...source })
    else {
      previous.quantity += source.quantity; previous.receivedQuantity += source.receivedQuantity
      previous.joorQuantity = previous.joorQuantity !== null && source.joorQuantity !== null ? previous.joorQuantity + source.joorQuantity : null
      previous.aderQuantity = previous.aderQuantity !== null && source.aderQuantity !== null ? previous.aderQuantity + source.aderQuantity : null
      if (previous.factoryId !== source.factoryId) { previous.factoryId = ''; previous.factoryName = '복수 업체' }
      if (previous.orderDate !== source.orderDate) previous.orderDate = ''
    }
  }
  const costs = allCosts.filter(record => !record.data.voided && [...groupedOrders.values()].some(order => costKey(order) === costKey(record.data)) && match(budgetCostSupplierKey(record.data), filters.factoryIds))
  const orders: BudgetOrderRow[] = [...groupedOrders.values()].map(order => {
    const linked = costs.filter(record => costKey(record.data) === costKey(order)), pre = productionCosts(linked, importedIds, order.quantity), post = sumCost(linked, 'post')
    return { ...order, productionBudget: pre.budget, costMatched: post === null ? '' : order.budgetCode, productionUnitCost: pre.unitCost, postCost: post }
  }).sort((a, b) => a.projectName.localeCompare(b.projectName, 'ko-KR') || a.projectId.localeCompare(b.projectId) || a.styleCode.localeCompare(b.styleCode))
  const availableSettlements = [...sources.settlements]
  for (const record of records) if (record.kind === 'payment' && record.data.status === 'paid' && record.data.sourceSnapshot && !availableSettlements.some(entry => entry.sourceKey === record.data.sourceKey)) availableSettlements.push(record.data.sourceSnapshot)
  const settlements = availableSettlements.map((entry): BudgetFARow => {
    const record = records.find((record): record is Extract<BudgetRecord, { kind: 'payment' }> => record.kind === 'payment' && record.data.sourceKey === entry.sourceKey) || null
    const current = sources.settlements.find(source => source.sourceKey === entry.sourceKey)
    const paymentStale = !!record && (!current || !sameBudgetSource(record.data.sourceSnapshot, current))
    if (paymentStale) warnings.push(`${entry.styleCode} ${entry.factoryName}: 원본이 변경되어 이전 결제 상태의 재확인이 필요합니다.`)
    const frozen = record?.data.status === 'paid' && record.data.sourceSnapshot ? record.data.sourceSnapshot : entry
    return { ...frozen, payment: record && (!paymentStale || record.data.status === 'paid') ? record.data : defaultBudgetPayment(entry), paymentRecord: record, paymentStale }
  }).filter(row => selected(row, filters))
  const report: BudgetReport = { authorized: true, readOnly: actor!.role === 'finance', orders, settlements, costs, limits, totals: summarize(orders, settlements, limits, filters.seasons), groups: [], excess: [], unclosed: [], warnings, sources, budgetCostImportRecordIds: costs.filter(cost => importedIds.has(cost.id)).map(cost => cost.id) }
  // A season's limit is shared by every project/style/vendor in that season.
  // Narrowing the display must not make other committed budgets look available.
  const capSeasons = filters.seasons == null ? [...new Set([...orders, ...settlements].map(row => row.season))] : [...filters.seasons]
  const seasonOrders = new Map<string, number>()
  for (const order of sources.orders.filter(order => capSeasons.includes(order.season))) seasonOrders.set(costKey(order), (seasonOrders.get(costKey(order)) || 0) + order.quantity)
  const seasonBudgets = [...seasonOrders].map(([key, quantity]) => productionCosts(allCosts.filter(record => costKey(record.data) === key), importedIds, quantity).budget)
  const seasonAllocation = moneySum(seasonBudgets.map(amount => amount ?? 0))
  if (report.totals.annualLimit !== null) report.totals.unallocated = moneySum([report.totals.annualLimit, -seasonAllocation])
  if (report.totals.annualLimit !== null && seasonBudgets.some(amount => amount === null)) report.warnings.push('원가 미등록 항목이 있어 시즌 예산 잔액은 현재 등록된 생산 예산을 차감한 금액입니다.')
  report.groups = groupBudgetReport(report, filters.groupBy || 'project')
  for (const order of orders) {
    const entries = settlements.filter(entry => costKey(entry) === costKey(order)), paid = moneySum(entries.filter(entry => entry.payment.status === 'paid').map(entry => entry.netAmount)), unpaid = moneySum(entries.filter(entry => entry.payment.status !== 'paid').map(entry => entry.netAmount))
    const overage = order.productionBudget === null ? 0 : Math.max(0, moneySum([paid, -order.productionBudget]))
    const explanations = [order.productionBudget === null ? '사전 원가 미등록' : '', order.receivedQuantity < order.quantity ? `미입고 ${order.quantity - order.receivedQuantity}장` : '', !entries.length ? 'FA 마감 누적 대기' : '', unpaid > 0 || entries.some(entry => entry.payment.status !== 'paid') ? '미결제 을지' : '', entries.some(entry => entry.paymentStale) ? '결제 원본 재확인' : ''].filter(Boolean)
    const createException = (kind: 'excess' | 'unclosed', explanation: string): BudgetException => {
      const key = costKey(order), noteRecord = records.find((record): record is Extract<BudgetRecord, { kind: 'note' }> => record.kind === 'note' && record.data.key === key && record.data.kind === kind) || null
      return { key, kind, projectName: order.projectName, projectCode: order.projectCode, styleCode: order.styleCode, season: order.season, factoryName: order.factoryName, budget: order.productionBudget, paid, unpaid, overage, explanation, reason: noteRecord?.data.reason || '', noteRecord }
    }
    if (overage > 0) report.excess.push(createException('excess', '지급한 을지 공급가액이 사전 생산 예산을 초과했습니다.'))
    if (explanations.length) report.unclosed.push(createException('unclosed', explanations.join(' · ')))
  }
  if (orders.some(order => !order.projectCode)) report.warnings.push('본사 프로젝트 코드 미등록 오더는 코드를 확인한 뒤 원가를 연결해 주세요.')
  if (orders.some(order => order.joorQuantity === null || order.aderQuantity === null)) report.warnings.push('JOOR GB·ADER KOR 배분은 저장된 원본에 확인 가능한 열이 있을 때만 표시합니다. 현재 저장되지 않은 원본 열은 추정하지 않습니다.')
  return report
}

function validateText(value: unknown, limit: number, required = false): value is string { return typeof value === 'string' && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value) && (!required || !!value.trim()) }
function assertFields(data: unknown, fields: string[]): asserts data is Record<string, unknown> { if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== fields.length || !fields.every(field => Object.hasOwn(data, field))) throw new Error('예산 저장 항목을 확인해 주세요.') }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function validateBudgetRecordData<K extends BudgetRecordKind>(workspace: BudgetWorkspace, kind: K, data: BudgetDataByKind[K]): void {
  if (kind === 'cost') {
    assertFields(data, ['projectId', 'budgetCode', 'styleCode', 'supplierId', 'supplierName', 'stage', 'category', 'description', 'position', 'specification', 'itemName', 'composition', 'color', 'unitCost', 'variableUnitCost', 'consumption', 'unit', 'amount', 'voided'])
    const cost = data as unknown as BudgetCostData
    if (!uuid.test(cost.projectId) || !validateText(cost.budgetCode, 240, true) || !validateText(cost.styleCode, 80, true) || cost.supplierId !== '' && !uuid.test(cost.supplierId) || !validateText(cost.supplierName, 160) || !['pre', 'post'].includes(cost.stage) || typeof cost.voided !== 'boolean') throw new Error('원가의 프로젝트·스타일·업체를 확인해 주세요.')
    for (const field of ['category', 'description', 'position', 'specification', 'itemName', 'composition', 'color', 'unit'] as const) if (!validateText(cost[field], 1000)) throw new Error('원가 설명은 제어 문자 없이 1,000자 이내로 입력해 주세요.')
    if ([cost.unitCost, cost.variableUnitCost].some(value => value !== null && !safeMoney(value)) || cost.amount !== null && !safeMoney(cost.amount, 6) || cost.consumption !== null && !safeMoney(cost.consumption, 4)) throw new Error('원가 단가는 소수 2자리, 요척량은 4자리, 원가 금액은 6자리까지 0~1조 원으로 입력해 주세요.')
    const source = workspace.budgetSources || buildBudgetSources(workspace)
    if (!source.orders.some(order => order.projectId === cost.projectId && order.budgetCode === cost.budgetCode && order.styleCode === cost.styleCode)) throw new Error('현재 발주 오더와 예산 코드가 일치하는 원가만 등록할 수 있습니다.')
    if (cost.supplierId && !workspace.factories.some(factory => factory.id === cost.supplierId)) throw new Error('등록된 업체를 선택해 주세요.')
  } else if (kind === 'limit') {
    assertFields(data, ['season', 'amount'])
    if (!validateText(data.season, 40, true) || data.amount !== null && !safeMoney(data.amount)) throw new Error('시즌과 예산 한도를 확인해 주세요.')
  } else if (kind === 'payment') {
    assertFields(data, ['sourceKey', 'sourceFingerprint', 'sourceSnapshot', 'status', 'paidAt', 'voucherNo', 'account', 'description', 'splitPayment'])
    if (!validateText(data.sourceKey, 300, true) || !validateText(data.sourceFingerprint, 600, true) || !['paid', 'unpaid'].includes(String(data.status)) || !validateText(data.paidAt, 10) || data.status === 'paid' && !date(String(data.paidAt)) || data.status === 'unpaid' && data.paidAt !== '') throw new Error('결제 상태와 지급일을 확인해 주세요.')
    for (const field of ['voucherNo', 'account', 'description', 'splitPayment'] as const) if (!validateText(data[field], 1000)) throw new Error('결제 설명을 확인해 주세요.')
    const source = (workspace.budgetSources || buildBudgetSources(workspace)).settlements.find(source => source.sourceKey === data.sourceKey)
    const previous = workspace.budgetRecords?.find((record): record is Extract<BudgetRecord, { kind: 'payment' }> => record.kind === 'payment' && record.data.sourceKey === data.sourceKey)
    const reversingMissingSource = !source && previous?.data.status === 'paid' && data.status === 'unpaid' && previous.data.sourceFingerprint === data.sourceFingerprint && sameBudgetSource(previous.data.sourceSnapshot, data.sourceSnapshot)
    if (!reversingMissingSource && (!source || source.sourceFingerprint !== data.sourceFingerprint || !sameBudgetSource(source, data.sourceSnapshot))) throw new Error('VERSION_CONFLICT: 원본 을지가 변경되었습니다. 최신 금액을 확인한 뒤 결제 상태를 저장해 주세요.')
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    if (data.status === 'paid' && String(data.paidAt) > today) throw new Error('미래 날짜를 실제 지급일로 등록할 수 없습니다.')
  } else if (kind === 'note') {
    assertFields(data, ['key', 'kind', 'reason'])
    if (!validateText(data.key, 500, true) || !['excess', 'unclosed'].includes(String(data.kind)) || !validateText(data.reason, 1000, true)) throw new Error('초과·미종결 사유를 1~1,000자로 입력해 주세요.')
    const report = buildBudgetReport(workspace, workspace.profiles.find(profile => isHQ(profile))!)
    if (![...report.excess, ...report.unclosed].some(row => row.key === data.key && row.kind === data.kind)) throw new Error('현재 발생한 초과·미종결 항목만 사유를 등록할 수 있습니다.')
  } else throw new Error('지원하지 않는 예산 항목입니다.')
}
/** All mutations use canonical HQ identity, compare versions, and retain history.
 * They never rewrite production, PO, receipts or finalized settlement snapshots. */
export function saveBudgetRecordInWorkspace<K extends BudgetRecordKind>(workspace: BudgetWorkspace, supplied: Profile, id: string, kind: K, data: BudgetDataByKind[K], expectedVersion: number, reason: string): BudgetWorkspace {
  const actor = workspace.profiles.find(profile => profile.id === supplied.id)
  if (!isHQ(actor)) throw new Error('예산·결제·사유 변경은 승인된 본사 관리자·직원만 할 수 있습니다.')
  if (workspace.budgetAvailable === false) throw new Error('예산·을지 누적 설정이 필요합니다.')
  if (!uuid.test(id) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !validateText(reason, 1000, true) || reason.trim().length < 2) throw new Error('저장 버전과 변경 사유 두 글자 이상을 확인해 주세요.')
  validateBudgetRecordData(workspace, kind, data)
  const before = workspace.budgetRecords?.find(record => record.id === id)
  if ((before?.version || 0) !== expectedVersion) throw new Error('VERSION_CONFLICT')
  if (before && before.kind !== kind) throw new Error('원가·예산·결제 기록 종류는 변경할 수 없습니다.')
  if (kind === 'cost' && workspace.budgetCostImports?.some(source => source.recordId === id)) {
    const cost = data as BudgetCostData
    const amount = cost.unitCost === null || cost.consumption === null ? null : multiplyBudgetCost(cost.unitCost, cost.consumption)
    if (cost.amount !== amount) throw new Error('원가 금액은 단가(Q열) × 요척량(S열)과 같아야 합니다.')
  }
  if (before?.kind === 'payment' && kind === 'payment' && before.data.status === 'paid') {
    const payment = data as BudgetPaymentData
    if (payment.status === 'paid' && (payment.sourceFingerprint !== before.data.sourceFingerprint || !sameBudgetSource(payment.sourceSnapshot, before.data.sourceSnapshot))) throw new Error('이미 결제한 금액은 미결제 정정을 먼저 기록한 뒤 새 금액으로 결제해 주세요.')
  }
  const identity = (record: BudgetRecord): string => record.kind === 'limit' ? record.data.season : record.kind === 'payment' ? record.data.sourceKey : record.kind === 'note' ? JSON.stringify([record.data.key, record.data.kind]) : record.id
  const now = new Date().toISOString(), after = { id, kind, data: structuredClone(data), version: expectedVersion + 1, createdAt: before?.createdAt || now, updatedAt: now, updatedBy: actor!.id } as BudgetRecord
  if (workspace.budgetRecords?.some(record => record.id !== id && record.kind === kind && identity(record) === identity(after))) throw new Error('같은 예산·결제·사유 항목이 이미 있습니다. 기존 항목을 수정해 주세요.')
  if (before && kind !== 'cost' && identity(before) !== identity(after)) throw new Error('기존 기록의 연결 항목은 변경할 수 없습니다.')
  const next = structuredClone(workspace), audit: BudgetAudit = { id: crypto.randomUUID(), recordId: id, kind, actorId: actor!.id, actorName: actor!.name, reason: reason.trim(), before: before || null, after, createdAt: now }
  next.budgetRecords = [...(next.budgetRecords || []).filter(record => record.id !== id), after]; next.budgetAudits = [audit, ...(next.budgetAudits || [])]; next.budgetAvailable = true
  return next
}
