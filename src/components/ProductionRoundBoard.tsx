import { useState } from 'react'
import { ArrowUpRight, Layers3 } from 'lucide-react'
import type { SupplierOrderFields, SupplierOrderStatus } from '../lib/supplier-orders'
import { quantityTotal, type Workspace } from '../lib/types'
import { PRODUCTION_CONDITION_STATUS_LABEL } from '../lib/production-conditions'
import MultiSelectFilter from './MultiSelectFilter'
import { getHistoricalProjectIdentity, projectFilterOptions } from '../lib/project-identity'
import './production-round-board.css'

const labels: Record<SupplierOrderStatus, string> = {
  awaiting_po: 'PO 발송 대기', awaiting_acceptance: '업체 납기·동의 대기', accepted: '업체 동의 완료',
  in_progress: '생산 진행 중', closed: '마감 확정', assignment_changed: '공장 배정 확인 필요',
}
type Selection = string[] | null
const includes = (values: Selection, value: string) => values === null || values.includes(value)

/** Nonfinancial view: safe for both headquarters and its assigned supplier.
 * Every row is an immutable project/production-round identity, never a SKU sum. */
export default function ProductionRoundBoard({ workspace, onOpenStyle }: { workspace: Workspace & SupplierOrderFields; onOpenStyle: (id: string) => void }) {
  const [project, setProject] = useState<Selection>(null), [style, setStyle] = useState<Selection>(null), [status, setStatus] = useState<Selection>(null)
  const orders = workspace.supplierProductionOrders || []
  const conditions = new Map((workspace.productionConditions || []).map(condition => [condition.runId, condition]))
  const statusFor = (order: typeof orders[number]) => workspace.productionConditionsAvailable === true ? conditions.get(order.runId)?.status || (order.status === 'closed' || order.status === 'awaiting_po' ? order.status : 'awaiting_supplier') : order.status
  const stateLabels: Record<string, string> = workspace.productionConditionsAvailable === true ? PRODUCTION_CONDITION_STATUS_LABEL : labels
  if (workspace.supplierOrdersAvailable !== true) return null
  const projectIdentity = (order: typeof orders[number]) => getHistoricalProjectIdentity(workspace, order.projectId, { name: order.projectName, code: order.projectCode })
  const availableProjects = [...new Map(orders.map(order => { const identity = projectIdentity(order); return [order.projectId, { id: order.projectId, name: identity.name, code: identity.code, season: identity.season }] })).values()]
  const projectOptions = projectFilterOptions({ projects: availableProjects })
  const styleOptions = [...new Map(orders.map(order => [order.styleId, { value: order.styleId, label: workspace.styles.find(item => item.id === order.styleId)?.code || order.styleCode }])).values()]
  const filtered = orders.filter(order => includes(project, order.projectId) && includes(style, order.styleId) && includes(status, statusFor(order)))
    .sort((a, b) => a.projectCode.localeCompare(b.projectCode) || a.styleCode.localeCompare(b.styleCode) || b.round - a.round)
  return <section className="panel production-round-board" aria-label="프로젝트·생산 차수별 현황">
    <div className="production-round-board-heading"><div><h2><Layers3 size={17}/> 프로젝트·생산 차수별 현황 <span className="pill">{filtered.length}차수</span></h2><p className="muted">같은 품번도 프로젝트와 차수별로 구분합니다. PO 발송 → 업체 납기·단가 회신 → 본사 최종 승인 → 생산 시작 순서로 진행하세요.</p></div></div>
    <div className="production-round-board-filters">
      <MultiSelectFilter label="생산 차수 프로젝트" options={projectOptions} value={project} onChange={setProject} allLabel="전체 프로젝트 명칭"/>
      <MultiSelectFilter label="생산 차수 품번" options={styleOptions} value={style} onChange={setStyle} allLabel="전체 품번"/>
      <MultiSelectFilter label="생산 차수 상태" options={Object.entries(stateLabels).map(([value, label]) => ({ value, label }))} value={status} onChange={setStatus} allLabel="전체 상태"/>
    </div>
    {filtered.length ? <div className="table-wrap"><table><thead><tr><th>프로젝트 명칭·코드</th><th>품번</th><th>생산 차수</th><th>담당 공장</th><th>오더 수량</th><th>PO 요청 납기</th><th>업체 예상 납기</th><th>진행 상태</th><th><span className="sr-only">상세</span></th></tr></thead><tbody>{filtered.map(order => <tr key={order.runId}>
      <td><strong>{projectIdentity(order).name}</strong><small>{order.projectCode || projectIdentity(order).code || '코드 미기재'}</small></td><td>{order.styleCode}</td><td><strong>{order.round}차</strong><small>{order.name}</small></td><td>{order.factoryName}</td><td>{quantityTotal(order.order).toLocaleString('ko-KR')} pcs</td><td>{order.requestedDue || '—'}</td><td>{conditions.get(order.runId)?.proposal?.expectedDeliveryDate || order.acceptance?.expectedDeliveryDate || '—'}</td><td><span className={`pill production-order-${statusFor(order)}`}>{stateLabels[statusFor(order)]}</span>{conditions.get(order.runId)?.legacy && <small>기존 프로세스 승인 기록</small>}</td><td><button className="button button-ghost" aria-label={`${order.styleCode} ${order.projectCode} ${order.round}차 상세`} onClick={() => onOpenStyle(order.styleId)}>상세<ArrowUpRight size={13}/></button></td>
    </tr>)}</tbody></table></div> : <div className="empty-state"><p>{orders.length ? '선택한 조건에 해당하는 생산 차수가 없습니다.' : '등록된 생산 차수가 없습니다. 오더 엑셀을 업로드하면 프로젝트별 새 생산 차수가 만들어집니다.'}</p></div>}
  </section>
}
