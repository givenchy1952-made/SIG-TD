import type { ProductionRun } from '../lib/production-ledger'
import { PRODUCTION_CONDITION_STATUS_LABEL } from '../lib/production-conditions'
import { getHistoricalProjectIdentity } from '../lib/project-identity'
import { fullStyleSku } from '../lib/style-identity'
import type { SupplierOrder, SupplierOrderStatus } from '../lib/supplier-orders'
import { quantityTotal, type Style, type Workspace } from '../lib/types'

export interface MainProductionContextSummaryProps {
  workspace: Workspace
  style: Style
  lineId: string
  projectId: string
  runId?: string
  disabled?: boolean
  onSelectRun?: (runId: string, projectId: string) => void
}
interface Candidate {
  id: string
  lineId: string
  projectId: string
  round: number
  name: string
  run?: ProductionRun
  supplier?: SupplierOrder
}
const statusLabels: Record<SupplierOrderStatus, string> = {
  awaiting_po: 'PO 발송 대기', awaiting_acceptance: '업체 회신 대기', accepted: '업체 동의 완료',
  in_progress: '생산 진행 중', closed: '마감 확정', assignment_changed: '공장 배정 확인 필요',
}
const count = (value: number | null) => value === null ? '확인 기록 없음' : `${value.toLocaleString('ko-KR')}장`

/** Keeps project/run figures distinct from the existing colour-wide cumulative
 * editing grid. Supplier-only workspaces use their nonfinancial order projection
 * and never infer run receipts from a different project's cumulative line. */
export default function MainProductionContextSummary({ workspace, style, lineId, projectId, runId, disabled = false, onSelectRun }: MainProductionContextSummaryProps) {
  const line = style.production.find(item => item.id === lineId)
  if (!line) return null
  const candidates: Candidate[] = (workspace.productionRuns || [])
    .filter(run => run.styleId === style.id && run.lineId === lineId)
    .map(run => ({ id: run.id, lineId, projectId: run.closedAt && run.snapshot ? run.snapshot.projectId : run.projectId, round: run.snapshot?.round ?? run.round, name: run.snapshot?.name ?? run.name, run, supplier: workspace.supplierProductionOrders?.find(order => order.runId === run.id) }))
  for (const order of workspace.supplierProductionOrders || []) {
    if (order.styleId === style.id && order.lineId === lineId && !candidates.some(item => item.id === order.runId)) candidates.push({ id: order.runId, lineId, projectId: order.projectId, round: order.round, name: order.name, supplier: order })
  }
  if (!candidates.length) return null
  const options = candidates.filter(item => item.projectId === projectId).sort((a, b) => b.round - a.round || a.id.localeCompare(b.id))
  const selected = runId ? options.find(item => item.id === runId) : options.length === 1 ? options[0] : undefined
  const run = selected?.run, supplier = selected?.supplier
  const snapshot = run?.closedAt ? run.snapshot : null
  const project = getHistoricalProjectIdentity(workspace, projectId, { name: supplier?.projectName, code: snapshot?.projectCode || run?.projectCode, season: style.season })
  const condition = selected ? workspace.productionConditions?.find(item => item.runId === selected.id) : undefined
  const order = !selected ? null : snapshot ? snapshot.orderQuantity : run ? quantityTotal(run.order) : supplier ? quantityTotal(supplier.order) : null
  const received = !run ? null : run.closedAt ? snapshot?.receivedQuantity ?? null : workspace.productionReceipts ? workspace.productionReceipts.filter(item => item.runId === run.id && item.styleId === style.id && item.lineId === lineId && !item.voided).reduce((sum, item) => sum + quantityTotal(item.quantities), 0) : null
  const remaining = order === null || received === null ? null : Math.max(0, order - received)
  const due = snapshot?.expectedDue || condition?.approval?.finalDeliveryDate || run?.expectedDue || supplier?.expectedDue || supplier?.requestedDue || '미정'
  const status = run?.closedAt || supplier?.status === 'closed' ? '마감 확정' : condition ? PRODUCTION_CONDITION_STATUS_LABEL[condition.status] : supplier ? statusLabels[supplier.status] : '생산 조건 확인 필요'
  const sku = snapshot?.styleCode || run?.styleCodeSnapshot || supplier?.styleCode || fullStyleSku(style.code, line.color)
  return <section className="panel main-production-context" aria-label="선택한 프로젝트 생산 현황">
    <div className="section-heading"><div><h3>선택한 프로젝트 생산 현황</h3><p className="muted">{project.name} · {sku} · {line.color}</p></div>{selected && <span className="pill">{status}</span>}</div>
    {options.length > 1 && <label className="field"><span className="field-label">현황 생산 차수</span><select className="select" aria-label="메인 생산 현황 차수" value={selected?.id || ''} disabled={disabled || !onSelectRun} onChange={event => { const choice = options.find(item => item.id === event.target.value); if (choice) onSelectRun?.(choice.id, choice.projectId) }}><option value="">생산 차수 선택</option>{options.map(item => <option key={item.id} value={item.id}>{item.round}차 · {item.name}</option>)}</select></label>}
    {!selected ? <p className="muted">{options.length ? '선택한 프로젝트·컬러의 생산 차수를 선택해 주세요.' : '선택한 프로젝트·컬러에 연결된 생산 차수가 없습니다.'}</p> : <dl className="main-production-context-values">
      <div><dt>생산 차수</dt><dd>{selected.round}차 · {selected.name}</dd></div>
      <div><dt>오더 수량</dt><dd>{count(order)}</dd></div>
      <div><dt>확정 입고</dt><dd>{count(received)}</dd></div>
      <div><dt>미입고 잔량</dt><dd>{count(remaining)}</dd></div>
      <div><dt>납기</dt><dd>{due}</dd></div>
    </dl>}
  </section>
}
