import { useRef, useState } from 'react'
import { Check, PackageCheck } from 'lucide-react'
import type { Profile, Style, Workspace } from '../lib/types'
import { emptyQuantities, quantityTotal, SIZES } from '../lib/types'
import type { ConfirmMainProductionReceiptRequest } from '../lib/production-movements-types'
import { confirmMainProductionReceipt } from '../lib/production-movements-repository'
import { assertProductionRunStarted } from '../lib/supplier-orders'
import { getHistoricalProjectIdentity } from '../lib/project-identity'
import { message } from '../lib/utils'

interface Props {
  draft: Style; workspace: Workspace; profile: Profile; lineId: string;
  projectId?: string; runId?: string; reason: string; blocked: boolean;
  onSelectRun: (runId: string, projectId: string) => void;
  onConfirmed: (style: Style) => void; onChanged: () => Promise<unknown>;
  onBusyChange: (busy: boolean) => void;
}
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })

/** Uses the existing size grid as its only quantity input. The server saves
 * the cumulative target and its unallocated receipt delta in one transaction. */
export default function MainProductionReceiptConfirmation({ draft, workspace, profile, lineId, projectId, runId, reason, blocked, onSelectRun, onConfirmed, onChanged, onBusyChange }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const sent = useRef<{ signature: string; request: ConfirmMainProductionReceiptRequest; reason: string } | null>(null)
  const line = draft.production.find(item => item.id === lineId)!
  const runs = (workspace.productionRuns || []).filter(run => run.styleId === draft.id && run.lineId === lineId && run.projectId === (projectId || draft.projectId))
  const requested = runs.find(run => run.id === runId)
  const open = runs.filter(run => !run.closedAt)
  const run = requested || (open.length === 1 ? open[0] : undefined)
  const allocated = emptyQuantities()
  for (const receipt of workspace.productionReceipts || []) if (receipt.styleId === draft.id && receipt.lineId === lineId && !receipt.voided) for (const size of SIZES) allocated[size] += receipt.quantities[size]
  const delta = Object.fromEntries(SIZES.map(size => [size, line.received[size] - allocated[size]])) as typeof allocated
  let started = false
  if (run) { try { assertProductionRunStarted(workspace, run.id); started = true } catch { /* Show the same approval prerequisite before enabling confirmation. */ } }
  const person = workspace.profiles.find(person => person.id === profile.id)
  const allowed = person?.approved && person.active && person.role === 'admin'
  const invalidTarget = SIZES.some(size => delta[size] < 0)
  const available = workspace.mainProductionSyncAvailable === true

  async function confirm() {
    if (!allowed || !available || !run || run.closedAt || !started || run.unitCost === null || invalidTarget || busy || blocked || reason.trim().length < 2) return
    const proposed = structuredClone(draft)
    proposed.production = proposed.production.map(item => item.id === lineId ? { ...item, receivedAt: item.receivedAt || today() } : item)
    const signature = JSON.stringify([proposed, run.id, run.version, reason.trim()])
    if (!sent.current || sent.current.signature !== signature) sent.current = { signature, reason: reason.trim(), request: { requestId: crypto.randomUUID(), styleId: draft.id, lineId, runId: run.id, expectedStyleVersion: draft.version, expectedRunVersion: run.version, style: proposed } }
    setBusy(true); onBusyChange(true); setError(''); setNotice('')
    let saved = false
    try {
      const result = await confirmMainProductionReceipt(sent.current.request, sent.current.reason, profile)
      saved = true; onConfirmed(result.style); sent.current = null
      await onChanged()
      setNotice(result.receiptId ? '입고를 확정하고 생산 차수·마감에 자동 반영했습니다.' : '이미 반영된 입고 수량입니다. 같은 수량을 중복 기록하지 않았습니다.')
    } catch (failure) { setError(saved ? '입고 확정은 완료됐지만 최신 목록을 불러오지 못했습니다. 새로고침해 확인해 주세요.' : message(failure)) }
    finally { setBusy(false); onBusyChange(false) }
  }
  return <section className="main-receipt-confirmation" aria-label="메인 생산 입고 확정">
    <div className="section-heading"><div><h3><PackageCheck size={16}/>입고 확정</h3><p className="muted">위 사이즈별 실입고 수량을 확인하면 생산 차수·마감에 자동으로 기록합니다.</p></div></div>
    <div className="form-grid">
      <label className="field"><span className="field-label">입고 연결 생산 차수</span><select className="select" aria-label="입고 연결 생산 차수" value={run?.id || ''} disabled={busy || blocked} onChange={event => { const chosen = runs.find(item => item.id === event.target.value); if (chosen) onSelectRun(chosen.id, chosen.projectId); sent.current = null; setError(''); setNotice('') }}><option value="">생산 차수 선택</option>{runs.map(item => <option key={item.id} value={item.id}>{getHistoricalProjectIdentity(workspace, item.projectId, { code: item.projectCode }).name} / {line.color} / {item.round}차 · {item.name}{item.closedAt ? ' · 마감 확정' : ''}</option>)}</select></label>
      <div className="field"><span className="field-label">기록할 실입고일</span><span className="main-receipt-value">{line.receivedAt || `${today()} · 오늘`}</span><small>실입고일은 아래 출입고 및 정산에서 변경할 수 있습니다.</small></div>
    </div>
    <p className="main-receipt-totals">컬러 누적 실입고 <strong>{quantityTotal(line.received).toLocaleString()}장</strong> · 차수 기록 합계 {quantityTotal(allocated).toLocaleString()}장 · 이번 연결 {quantityTotal(delta).toLocaleString()}장</p>
    {!runs.length && <p className="muted">이 컬러·프로젝트의 생산 차수를 등록하고 생산 조건을 최종 승인한 뒤 입고를 확정해 주세요.</p>}
    {open.length > 1 && !run && <p className="muted">해당 컬러의 생산 차수가 여러 개입니다. 입고를 연결할 차수를 선택해 주세요.</p>}
    {run?.closedAt && <p className="muted">마감 확정된 차수의 입고는 변경할 수 없습니다. 입고를 기록할 미마감 차수를 선택해 주세요.</p>}
    {run && !run.closedAt && (!started || run.unitCost === null) && <p className="muted">생산 조건 협의·승인에서 최종 승인한 단가와 생산 시작 상태가 필요합니다.</p>}
    {invalidTarget && <p className="error-message" role="alert">이미 차수에 기록한 입고보다 누적 수량을 줄일 수 없습니다. 생산 차수·마감에서 해당 입고의 무효 여부를 먼저 확인해 주세요.</p>}
    {error && <p className="error-message" role="alert">{error}</p>}{notice && <p className="success-message" role="status"><Check size={14}/>{notice}</p>}
    {allowed && <div className="ledger-actions"><span className="muted">하단 변경 사유를 입력한 뒤 확정하세요.</span><button type="button" className="button button-primary" disabled={!available || blocked || busy || !run || !!run.closedAt || !started || run.unitCost === null || invalidTarget || reason.trim().length < 2} onClick={() => void confirm()}><PackageCheck size={14}/>{busy ? '입고 확정 중…' : '입고 확정'}</button></div>}
  </section>
}

export function MainShipmentHistory({ workspace, styleId, lineId }: { workspace: Workspace; styleId: string; lineId: string }) {
  const baseline = workspace.operations?.shipmentLedgers.find(row => row.styleId === styleId && row.lineId === lineId)
  const batches = (workspace.operations?.shipmentBatches || []).filter(row => row.styleId === styleId && row.lineId === lineId)
  const adjustments = (workspace.shipmentAdjustments || []).filter(row => row.styleId === styleId && row.lineId === lineId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  if (!baseline && !batches.length && !adjustments.length) return null
  return <details className="main-shipment-history"><summary>출고 변경 이력 · {batches.length + adjustments.length}건</summary><p className="muted">출고 수량은 위 사이즈별 수량에서 한 번만 입력합니다. 이전 기록과 정정 이력은 보존됩니다.</p><div className="table-wrap"><table className="data-table"><thead><tr><th>기록</th><th>일자</th>{SIZES.map(size => <th key={size}>{size}</th>)}<th>합계</th></tr></thead><tbody>{baseline && <tr><th>이전 출고</th><td>{baseline.baselineDate || '미기재'}</td>{SIZES.map(size => <td key={size}>{baseline.baselineQuantities[size]}</td>)}<td>{quantityTotal(baseline.baselineQuantities)}</td></tr>}{batches.map(row => <tr key={row.id}><th>{row.round}차 출고{row.voided ? ' · 무효' : ''}</th><td>{row.shippedAt}</td>{SIZES.map(size => <td key={size}>{row.quantities[size]}</td>)}<td>{quantityTotal(row.quantities)}</td></tr>)}{adjustments.map((row, index) => <tr key={row.id}><th>누적 수량 반영 {index + 1}</th><td>{row.shippedAt || '미기재'}</td>{SIZES.map(size => <td key={size}>{row.delta[size] > 0 ? '+' : ''}{row.delta[size]}</td>)}<td>{quantityTotal(row.delta)}</td></tr>)}</tbody></table></div></details>
}
