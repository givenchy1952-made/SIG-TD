import { useEffect, useState } from 'react'
import { CheckCircle2, Clock3, History, Pencil, ShieldCheck } from 'lucide-react'
import type { Profile, Style, Workspace } from '../lib/types'
import { quantityTotal, SIZES } from '../lib/types'
import type { SupplierOrder } from '../lib/supplier-orders'
import { getProductionCondition, productionDelayDays, productionPriceDifference } from '../lib/production-conditions'
import type { ProductionConditionTimeline, ProductionConditionsInput } from '../lib/production-conditions'
import { configureProductionConditions, submitProductionConditions, reviewProductionConditions, requestProductionConditionChange, linkProductionConditionChange } from '../lib/production-conditions-repository'
import { message } from '../lib/utils'

interface Props {
  workspace: Workspace
  style: Style
  order: SupplierOrder
  profile: Profile
  onChanged: () => Promise<unknown>
  onDirtyChange?: (dirty: boolean) => void
  onOpenProductionRuns?: () => void
}
type Editor = 'setup' | 'proposal' | 'review' | 'change' | 'link_change'
type Decision = 'approve' | 'request_revision' | 'reject'
const money = (value: number | null | undefined) => value == null ? '미입력' : `${value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원`
const time = (value: string | null | undefined) => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }) : '—'
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
function cost(value: string, optional = false): number | null {
  const clean = value.trim()
  if (optional && clean === '') return null
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean) || Number(clean) > 1_000_000_000) throw new Error('단가는 0~1,000,000,000원 범위에서 소수 둘째 자리까지 입력해 주세요.')
  return Number(clean)
}
const timelineLabels: Record<string, string> = {
  configured: '본사 생산 방식·검토 기준 등록', proposal_submitted: '업체 생산 조건 제출', proposal_resubmitted: '업체 수정 조건 재제출',
  request_revision: '본사 수정 요청', revision_requested: '본사 수정 요청', approved: '본사 최종 승인', rejected: '발주 거절',
  change_requested: '승인 조건 변경 요청', production_started: '생산 시작', legacy_started: '기존 프로세스 승인 기록',
}
function timelineDetails(event: ProductionConditionTimeline, hq: boolean): string[] {
  const raw = event.after || event.data
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const data = raw as Record<string, unknown>, result: string[] = []
  if (typeof data.expectedDeliveryDate === 'string') result.push(`제안 납기 ${data.expectedDeliveryDate}`)
  if (typeof data.finalDeliveryDate === 'string') result.push(`승인 납기 ${data.finalDeliveryDate}`)
  if (typeof data.unitCost === 'number' && Number.isFinite(data.unitCost)) result.push(`${typeof data.finalDeliveryDate === 'string' ? '승인' : '제안'} 단가 ${money(data.unitCost)}`)
  if (typeof data.canProduce === 'boolean') result.push(data.canProduce ? '생산 가능' : '생산 불가')
  if (hq && typeof data.internalUnitCost === 'number' && Number.isFinite(data.internalUnitCost)) result.push(`본사 내부 검토 단가 ${money(data.internalUnitCost)}`)
  const terms = data.termsSnapshot && typeof data.termsSnapshot === 'object' && !Array.isArray(data.termsSnapshot) ? data.termsSnapshot as Record<string, unknown> : undefined
  const productionMode = data.productionMode ?? terms?.productionMode
  if (productionMode === 'full_package' || productionMode === 'cmt') result.push(`생산 방식 ${productionMode === 'cmt' ? '임가공 (CMT)' : '완사입'}`)
  const quantities = data.confirmedQuantities ?? data.order ?? terms?.order
  if (quantities && typeof quantities === 'object' && !Array.isArray(quantities)) {
    const values = quantities as Record<string, unknown>
    if (SIZES.every(size => typeof values[size] === 'number' && Number.isSafeInteger(values[size]) && Number(values[size]) >= 0)) {
      result.push(`사이즈별 수량 ${SIZES.map(size => `${size} ${Number(values[size]).toLocaleString('ko-KR')}`).join(' / ')} · 합계 ${SIZES.reduce((sum, size) => sum + Number(values[size]), 0).toLocaleString('ko-KR')}개`)
    }
  }
  return result
}

export default function ProductionConditionsReviewPanel({ workspace, style, order, profile, onChanged, onDirtyChange, onOpenProductionRuns }: Props) {
  const actor = workspace.profiles.find(person => person.id === profile.id)
  const hq = !!actor && actor.role !== 'factory'
  const condition = getProductionCondition(workspace, order.runId)!
  const [editor, setEditor] = useState<Editor | null>(null)
  const [versions, setVersions] = useState({ run: order.runVersion, condition: condition.version, po: order.poVersion })
  const [mode, setMode] = useState<'full_package' | 'cmt'>('full_package'), [internalCost, setInternalCost] = useState('')
  const [date, setDate] = useState(''), [price, setPrice] = useState(''), [canProduce, setCanProduce] = useState('')
  const [confirmed, setConfirmed] = useState(false), [agreed, setAgreed] = useState(false)
  const [comment, setComment] = useState(''), [delayReason, setDelayReason] = useState(''), [priceReason, setPriceReason] = useState('')
  const [decision, setDecision] = useState<Decision>('approve'), [reason, setReason] = useState('')
  const [requestId, setRequestId] = useState(''), [replacementRunId, setReplacementRunId] = useState(''), [confirmedNewScope, setConfirmedNewScope] = useState(false)
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [busy, setBusy] = useState(false), [refreshRequired, setRefreshRequired] = useState(false)
  const stale = !!editor && (versions.run !== order.runVersion || versions.condition !== condition.version || versions.po !== order.poVersion)
  const dirty = !!editor || busy || refreshRequired
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])
  const allowed = !!actor?.approved && actor.active && (hq || !!actor.factoryId && actor.factoryId === order.factoryId && actor.factoryId === style.factoryId)
  if (!allowed) return null
  const ready = workspace.productionConditionsAvailable === true
  const proposal = condition.proposal, approval = condition.approval
  const requestedDate = order.requestedDue || order.expectedDue
  const delay = proposal ? productionDelayDays(requestedDate, proposal.expectedDeliveryDate) : null
  const difference = hq && proposal ? productionPriceDifference(condition.internalUnitCost ?? null, proposal.unitCost) : null
  const modeLabel = condition.productionMode === 'cmt' ? '임가공 (CMT)' : condition.productionMode === 'full_package' ? '완사입' : '미지정'
  const canConfigure = hq && !condition.legacy && !proposal && !approval && ['awaiting_po', 'awaiting_supplier'].includes(condition.status)
  const canPropose = !hq && !!condition.productionMode && ['awaiting_supplier', 'revision_requested'].includes(condition.status)
  const pendingChanges = condition.changeRequests.filter(request => !request.correctingRunId)
  const replacementRuns = (workspace.productionRuns || []).filter(run => {
    const candidate = getProductionCondition(workspace, run.id)
    return run.id !== order.runId && run.styleId === order.styleId && run.lineId === order.lineId && run.projectId === order.projectId && run.factoryIdSnapshot === order.factoryId && !run.closedAt && !candidate?.legacy && !candidate?.proposal && !candidate?.approval && candidate?.status !== 'rejected' && !candidate?.changeRequestId && !workspace.productionReceipts?.some(receipt => receipt.runId === run.id)
  })
  const replacementRun = replacementRuns.find(run => run.id === replacementRunId)
  const mainLine = style.production.find(line => line.id === order.lineId)

  function begin(next: Editor, nextDecision: Decision = 'approve') {
    if (busy || refreshRequired || editor || !ready) return
    setVersions({ run: order.runVersion, condition: condition.version, po: order.poVersion })
    setMode(condition.productionMode || 'full_package'); setInternalCost(condition.internalUnitCost == null ? '' : String(condition.internalUnitCost))
    setDate(proposal?.expectedDeliveryDate || requestedDate); setPrice(proposal ? String(proposal.unitCost) : '')
    setCanProduce(proposal ? proposal.canProduce ? 'yes' : 'no' : ''); setConfirmed(false); setAgreed(false)
    setComment(proposal?.comment || ''); setDelayReason(proposal?.delayReason || ''); setPriceReason(proposal?.priceReason || '')
    setDecision(nextDecision); setReason(''); setError(''); setSuccess(''); setEditor(next)
    setRequestId(pendingChanges[0]?.id || ''); setReplacementRunId(''); setConfirmedNewScope(false)
  }
  function cancel() { if (!busy) { setEditor(null); setReason(''); setError('') } }
  async function refresh() {
    if (busy) return
    setBusy(true); setError('')
    try { await onChanged(); setRefreshRequired(false) } catch { setError('최신 생산 조건을 불러오지 못했습니다. 연결을 확인하고 다시 불러와 주세요.'); setRefreshRequired(true) }
    finally { setBusy(false) }
  }
  async function save() {
    if (!actor || !editor || busy || stale || !ready) return
    setError(''); setSuccess('')
    try {
      if (editor !== 'proposal' && (reason.trim().length < 2 || reason.length > 1000)) throw new Error('변경·검토 사유를 2~1,000자로 입력해 주세요.')
      let action: () => Promise<void>
      let notice: string
      if (editor === 'setup') {
        const value = cost(internalCost, true)
        action = () => configureProductionConditions(order.runId, versions.run, versions.condition, mode, value, reason.trim(), actor)
        notice = '생산 방식과 본사 검토 기준을 저장했습니다.'
      } else if (editor === 'proposal') {
        if (!validDate(date)) throw new Error('업체 예상 납기일을 입력해 주세요.')
        if (canProduce !== 'yes' && canProduce !== 'no') throw new Error('생산 가능 여부를 선택해 주세요.')
        if (!confirmed || !agreed) throw new Error('PO 수량 확인과 생산 조건 동의에 모두 체크해 주세요.')
        if (versions.po === null) throw new Error('발송된 PO를 확인해 주세요.')
        const value = cost(price)!
        const data: ProductionConditionsInput = { expectedDeliveryDate: date, unitCost: value, canProduce: canProduce === 'yes', quantityConfirmed: confirmed, agreed, comment: comment.trim(), delayReason: delayReason.trim(), priceReason: priceReason.trim(), confirmedQuantities: { ...order.order } }
        action = () => submitProductionConditions(order.runId, versions.run, versions.po!, versions.condition, data, actor)
        notice = '생산 조건을 제출했습니다. 본사 최종 승인 대기 상태이며 생산은 아직 시작되지 않았습니다.'
      } else if (editor === 'review') {
        if (decision === 'approve' && !validDate(date)) throw new Error('최종 승인 납기일을 입력해 주세요.')
        const value = decision === 'approve' ? cost(price) : null
        action = () => reviewProductionConditions(order.runId, versions.run, versions.condition, decision, decision === 'approve' ? date : '', value, reason.trim(), actor)
        notice = decision === 'approve' ? '최종 납기와 단가를 승인하고 생산 진행을 시작했습니다.' : decision === 'request_revision' ? '업체에 생산 조건 수정을 요청했습니다. 재제출 후 다시 검토해 주세요.' : '발주를 거절했습니다. 협의 기록은 보존되며 생산 시작은 차단됩니다.'
      } else if (editor === 'change') {
        action = () => requestProductionConditionChange(order.runId, versions.run, versions.condition, reason.trim(), actor)
        notice = '조건 변경 요청을 기록했습니다. 기존 승인 조건은 보존됩니다. 정정 생산 차수를 등록하고 다시 승인받아 주세요.'
      } else {
        if (!requestId || !replacementRun || !confirmedNewScope) throw new Error('변경 요청과 새 생산 차수를 선택하고 오더 수량·집계 범위를 확인해 주세요.')
        action = () => linkProductionConditionChange(requestId, replacementRun.id, replacementRun.version, reason.trim(), confirmedNewScope, actor)
        notice = '변경 요청에 새 생산 차수를 연결했습니다. 새 차수에서 업체 회신과 본사 최종 승인을 진행해 주세요. 기존 승인·입고·마감은 유지됩니다.'
      }
      setBusy(true)
      await action(); setEditor(null); setReason(''); setSuccess(notice)
      try { await onChanged(); setRefreshRequired(false) } catch { setRefreshRequired(true); setError('저장은 완료됐지만 최신 화면을 불러오지 못했습니다. 다시 불러온 뒤 계속해 주세요.') }
    } catch (failure) { setError(message(failure)) }
    finally { setBusy(false) }
  }
  const actionsDisabled = busy || !!editor || refreshRequired || !ready
  const timeline = [...condition.timeline].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const hasPoTimeline = timeline.some(event => event.action.includes('PO') && event.action.includes('발송'))
  return <section className="production-conditions-review" aria-label="생산 조건 검토 및 승인">
    {!ready && <p className="supplier-order-note" role="status">생산 조건 협의·승인 설정을 준비 중입니다. 기존 생산·입고·마감 기록은 유지됩니다.</p>}
    {condition.legacy && <p className="supplier-order-note conditions-legacy"><ShieldCheck size={14}/>기존 프로세스 승인 기록 · 이미 시작한 생산과 입고·마감 이력을 그대로 유지합니다.</p>}
    {error && <div className="error-message" role="alert">{error}</div>}{success && <div className="success-message" role="status">{success}</div>}
    {stale && <div className="error-message" role="status">다른 사용자가 발주나 생산 조건을 변경했습니다. 작성한 내용은 유지됩니다. 입력을 취소하고 최신 내용을 확인해 주세요.</div>}
    {refreshRequired && <button className="button" type="button" disabled={busy} onClick={() => void refresh()}>최신 생산 조건 다시 불러오기</button>}
    <div className="conditions-mode"><span>생산 방식</span><strong>{modeLabel}</strong>{canConfigure && <button className="button button-ghost" type="button" disabled={actionsDisabled} onClick={() => begin('setup')}><Pencil size={13}/>생산 방식·검토 기준 설정</button>}</div>
    {editor === 'setup' && <section className="conditions-editor" aria-label="본사 생산 조건 설정">
      <h4>본사 생산 방식·검토 기준</h4><p className="muted">내부 검토 단가는 본사에만 표시됩니다. 업체 제안 및 최종 승인 단가와 별도로 관리합니다.</p>
      <div className="form-grid"><label className="field"><span>생산 방식</span><select className="select" aria-label="생산 방식" value={mode} disabled={busy || stale} onChange={event => setMode(event.target.value as typeof mode)}><option value="full_package">완사입</option><option value="cmt">임가공 (CMT)</option></select></label>
        <label className="field"><span>본사 내부 검토 단가</span><input className="input" type="number" aria-label="본사 내부 검토 단가" min="0" max="1000000000" step="0.01" value={internalCost} disabled={busy || stale} placeholder="미입력" onChange={event => setInternalCost(event.target.value)}/></label></div>
    </section>}
    <div className="conditions-comparison-wrap"><table className="conditions-comparison" aria-label="본사 업체 생산 조건 비교"><thead><tr><th>항목</th><th>{hq ? '본사 요청·검토' : '발주 정보'}</th><th>업체 제안</th><th>최종 승인</th></tr></thead><tbody>
      <tr><th>납기일</th><td>{requestedDate || '미입력'}</td><td>{proposal?.expectedDeliveryDate || '회신 대기'}{delay !== null && <small className={delay > 0 ? 'conditions-delay' : ''}>{delay > 0 ? `${delay}일 지연` : delay < 0 ? `${Math.abs(delay)}일 빠름` : '요청 납기와 동일'}</small>}</td><td>{approval?.finalDeliveryDate || '미승인'}</td></tr>
      <tr><th>{condition.productionMode === 'cmt' ? '임가공 단가 (CMT)' : '완제품 단가'}</th><td>{hq ? <><span className="conditions-internal-label">본사 내부 검토 단가</span>{money(condition.internalUnitCost)}</> : '—'}</td><td>{money(proposal?.unitCost)}{hq && difference !== null && <small>검토 기준 대비 {difference > 0 ? '+' : ''}{difference.toLocaleString('ko-KR')}원</small>}</td><td>{money(approval?.unitCost)}</td></tr>
      <tr><th>발주 수량</th><td>{quantityTotal(order.order).toLocaleString('ko-KR')} pcs</td><td>{proposal?.quantityConfirmed ? `${quantityTotal(proposal.confirmedQuantities).toLocaleString('ko-KR')} pcs · 확인` : '미확인'}</td><td>{approval ? `${quantityTotal(order.order).toLocaleString('ko-KR')} pcs` : '미승인'}</td></tr>
      <tr><th>생산 가능 여부</th><td>업체 회신 확인</td><td>{proposal ? proposal.canProduce ? '생산 가능' : '생산 불가' : '회신 대기'}</td><td>{approval ? '생산 승인 완료' : '미승인'}</td></tr>
    </tbody></table></div>
    {proposal && <section className="conditions-proposal-record" aria-label="업체 생산 조건 회신"><h4>업체 회신</h4><p>{proposal.actorName} · {time(proposal.submittedAt)}</p>{proposal.comment && <p>업체 의견: {proposal.comment}</p>}{proposal.delayReason && <p>납기 지연 사유: {proposal.delayReason}</p>}{proposal.priceReason && <p>단가 변경 사유: {proposal.priceReason}</p>}</section>}
    {canPropose && !editor && <div className="supplier-order-actions"><button className="button button-primary" type="button" disabled={actionsDisabled} onClick={() => begin('proposal')}>{condition.status === 'revision_requested' ? '수정 조건 재제출' : '생산 조건 회신'}</button></div>}
    {!hq && !condition.productionMode && !condition.legacy && <p className="supplier-order-note">본사에서 생산 방식과 발주 정보를 확인하면 생산 조건을 회신할 수 있습니다.</p>}
    {!hq && condition.status === 'awaiting_approval' && <p className="supplier-order-note"><Clock3 size={14}/>본사 최종 승인 대기 · 제출한 조건을 본사가 검토하고 있습니다. 아직 생산을 시작할 수 없습니다.</p>}
    {editor === 'proposal' && <section className="conditions-editor" aria-label="업체 생산 조건 회신 입력"><h4>업체 생산 조건 회신</h4><p className="muted">제출한 납기와 단가는 제안입니다. 본사가 최종 승인한 뒤 생산이 시작됩니다.</p><div className="form-grid">
      <label className="field"><span>업체 예상 납기일</span><input className="input" type="date" aria-label="업체 예상 납기일" value={date} disabled={busy || stale} onChange={event => setDate(event.target.value)}/></label>
      <label className="field"><span>{condition.productionMode === 'cmt' ? '임가공 제안 단가 (CMT)' : '완제품 제안 단가'}</span><input className="input" type="number" aria-label="업체 제안 생산 단가" min="0" max="1000000000" step="0.01" value={price} disabled={busy || stale} placeholder="미입력" onChange={event => setPrice(event.target.value)}/></label>
      <label className="field"><span>생산 가능 여부</span><select className="select" aria-label="업체 생산 가능 여부" value={canProduce} disabled={busy || stale} onChange={event => setCanProduce(event.target.value)}><option value="">선택해 주세요</option><option value="yes">생산 가능</option><option value="no">생산 불가</option></select></label>
      <label className="field"><span>납기 지연 사유 (선택)</span><textarea className="textarea" aria-label="납기 지연 사유" value={delayReason} maxLength={5000} disabled={busy || stale} onChange={event => setDelayReason(event.target.value)}/></label>
      <label className="field"><span>단가 변경 사유 (선택)</span><textarea className="textarea" aria-label="단가 변경 사유" value={priceReason} maxLength={5000} disabled={busy || stale} onChange={event => setPriceReason(event.target.value)}/></label>
      <label className="field"><span>업체 의견 (선택)</span><textarea className="textarea" aria-label="업체 생산 의견" value={comment} maxLength={5000} disabled={busy || stale} onChange={event => setComment(event.target.value)}/></label>
    </div><label className="supplier-agreement"><input type="checkbox" aria-label="PO 수량 확인" checked={confirmed} disabled={busy || stale} onChange={event => setConfirmed(event.target.checked)}/><span>위 PO의 컬러와 사이즈별 발주 수량 {quantityTotal(order.order).toLocaleString('ko-KR')}개를 확인했습니다.</span></label><label className="supplier-agreement"><input type="checkbox" aria-label="생산 조건 동의" checked={agreed} disabled={busy || stale} onChange={event => setAgreed(event.target.checked)}/><span>입력한 생산 조건을 제출하고 본사 최종 승인 후 생산을 진행하는 데 동의합니다.</span></label></section>}
    {hq && condition.status === 'awaiting_approval' && !editor && <div className="supplier-order-actions conditions-review-actions"><button className="button" type="button" disabled={actionsDisabled} onClick={() => begin('review', 'reject')}>발주 거절</button><button className="button" type="button" disabled={actionsDisabled} onClick={() => begin('review', 'request_revision')}>수정 요청</button><button className="button button-primary" type="button" disabled={actionsDisabled || !proposal?.canProduce} onClick={() => begin('review', 'approve')}><CheckCircle2 size={14}/>최종 승인 검토</button></div>}
    {editor === 'review' && <section className="conditions-editor" aria-label="본사 최종 생산 조건 검토"><h4>{decision === 'approve' ? '본사 최종 승인' : decision === 'request_revision' ? '업체 수정 요청' : '발주 거절'}</h4>{decision === 'approve' ? <><p className="muted">확정한 납기·단가와 사이즈별 발주 수량을 기록하고 생산을 시작합니다. 승인 후 일반 수정으로 덮어쓸 수 없습니다.</p><div className="form-grid"><label className="field"><span>최종 승인 납기일</span><input className="input" type="date" aria-label="최종 승인 납기일" value={date} disabled={busy || stale} onChange={event => setDate(event.target.value)}/></label><label className="field"><span>최종 승인 생산 단가</span><input className="input" type="number" aria-label="최종 승인 생산 단가" min="0" max="1000000000" step="0.01" value={price} disabled={busy || stale} onChange={event => setPrice(event.target.value)}/></label></div></> : <p className="muted">{decision === 'request_revision' ? '납기 또는 단가의 수정 요청 내용을 사유에 입력해 주세요. 업체가 재제출하면 본사에서 다시 검토합니다.' : '거절 사유를 기록하고 이 발주의 생산 시작을 차단합니다. 기존 PO와 협의 기록은 보존됩니다.'}</p>}</section>}
    {approval && <section className="supplier-acceptance-record" aria-label="본사 최종 승인 기록"><h4><ShieldCheck size={15}/>본사 최종 승인 기록</h4><dl><div><dt>최종 승인 납기</dt><dd>{approval.finalDeliveryDate}</dd></div><div><dt>최종 승인 단가</dt><dd>{money(approval.unitCost)}</dd></div><div><dt>승인 담당자·시각</dt><dd>{approval.approvedByName} · {time(approval.approvedAt)}</dd></div></dl><p className="muted">이 승인 조건과 당시 PO·발주 수량을 확정 이력으로 보존합니다. 실제 입고·마감은 해당 생산 차수에 기록합니다.</p></section>}
    {(approval || condition.legacy) && <div className="supplier-order-actions"><button className="button" type="button" disabled={actionsDisabled || pendingChanges.length > 0} onClick={() => begin('change')}>승인 조건 변경 요청</button>{hq && onOpenProductionRuns && <button className="button" type="button" disabled={actionsDisabled} onClick={onOpenProductionRuns}>생산 차수·마감으로 이동</button>}</div>}
    {editor === 'change' && <section className="conditions-editor" aria-label="승인 조건 변경 요청"><h4>승인 조건 변경 요청</h4><p className="muted">기존 승인 납기·단가와 입고·마감 금액은 유지합니다. 변경 사유를 기록한 뒤 본사에서 정정 생산 차수를 등록하고 업체 회신과 최종 승인을 다시 진행해 주세요.</p></section>}
    {!!condition.changeRequests.length && <section className="conditions-change-requests" aria-label="승인 조건 변경 요청 기록"><h4>조건 변경 요청</h4>{condition.changeRequests.map(request => <article key={request.id}><p>{request.reason}</p><small>{request.actorName} · {time(request.requestedAt)}</small><p>{request.correctingRunId ? `재승인 차수: ${workspace.productionRuns?.find(run => run.id === request.correctingRunId)?.name || '새 생산 차수에 연결됨'}` : '본사의 새 생산 차수 연결 대기'}</p></article>)}{hq && pendingChanges.length > 0 && !editor && <div className="supplier-order-actions"><button className="button" type="button" disabled={actionsDisabled} onClick={() => begin('link_change')}>변경 요청에 새 차수 연결</button></div>}</section>}
    {editor === 'link_change' && <section className="conditions-editor" aria-label="변경 요청 재승인 차수 연결"><h4>재승인할 새 생산 차수 연결</h4><p className="muted">같은 프로젝트·품번·컬러·업체의 미시작 차수만 연결합니다. 기존 승인 차수와 메인 누적 오더는 변경하지 않습니다.</p><div className="form-grid"><label className="field"><span>연결할 변경 요청</span><select className="select" aria-label="연결할 생산 조건 변경 요청" value={requestId} disabled={busy || stale} onChange={event => setRequestId(event.target.value)}>{pendingChanges.map(request => <option key={request.id} value={request.id}>{request.reason}</option>)}</select></label><label className="field"><span>새 생산 차수</span><select className="select" aria-label="재승인할 새 생산 차수" value={replacementRunId} disabled={busy || stale} onChange={event => { setReplacementRunId(event.target.value); setConfirmedNewScope(false) }}><option value="">차수 선택</option>{replacementRuns.map(run => <option key={run.id} value={run.id}>{run.round}차 · {run.name} · 오더 {quantityTotal(run.order)}개</option>)}</select></label></div>{!replacementRuns.length && <p className="muted">연결할 차수가 없습니다. 본사에서 생산 차수·마감의 생산 차수 추가로 새 차수를 등록한 뒤 돌아와 연결해 주세요.</p>}{replacementRun && <><div className="supplier-order-table"><table aria-label="변경 전후 오더 집계 범위 비교"><thead><tr><th>집계 기준</th>{SIZES.map(size => <th key={size}>{size}</th>)}<th>합계</th></tr></thead><tbody>{[{ label: '기존 승인 차수', quantities: order.order }, { label: '재승인할 새 차수', quantities: replacementRun.order }, ...(mainLine ? [{ label: '메인 생산 누적 오더', quantities: mainLine.order }] : [])].map(row => <tr key={row.label}><th>{row.label}</th>{SIZES.map(size => <td key={size}>{row.quantities[size].toLocaleString('ko-KR')}</td>)}<td>{quantityTotal(row.quantities).toLocaleString('ko-KR')}</td></tr>)}</tbody></table></div><label className="supplier-agreement"><input type="checkbox" aria-label="새 차수 오더 수량 및 집계 범위 확인" checked={confirmedNewScope} disabled={busy || stale} onChange={event => setConfirmedNewScope(event.target.checked)}/><span>메인 누적 오더와 차수별 오더는 집계 범위가 다를 수 있음을 확인했으며, 선택한 새 차수의 수량을 재승인 대상으로 연결합니다.</span></label></>}</section>}
    {editor && <div className="conditions-edit-footer">{editor !== 'proposal' && <label className="field"><span>{editor === 'review' ? '본사 검토 사유' : '변경 사유'}</span><textarea className="textarea" aria-label="생산 조건 변경 사유" value={reason} minLength={2} maxLength={1000} disabled={busy} onChange={event => setReason(event.target.value)} placeholder="사유를 두 글자 이상 입력해 주세요"/>{hq && editor !== 'setup' && <small className="muted">이 사유는 업체에도 표시됩니다. 내부 검토 단가·목표 원가·마진은 입력하지 마세요.</small>}</label>}<div className="supplier-order-actions"><button className="button" type="button" disabled={busy} onClick={cancel}>생산 조건 입력 취소</button>{stale && <button className="button" type="button" disabled={busy} onClick={() => { cancel(); void refresh() }}>입력 취소 후 최신 조건 조회</button>}<button className="button button-primary" type="button" disabled={busy || stale || (editor !== 'proposal' && reason.trim().length < 2)} onClick={() => void save()}>{busy ? '기록 중…' : editor === 'setup' ? '생산 조건 기준 저장' : editor === 'proposal' ? '생산 조건 제출' : editor === 'change' ? '조건 변경 요청 기록' : editor === 'link_change' ? '변경 요청과 새 차수 연결' : decision === 'approve' ? '최종 승인 및 생산 시작' : decision === 'request_revision' ? '수정 요청 전달' : '발주 거절 확정'}</button></div></div>}
    <section className="conditions-timeline" aria-label="생산 조건 협의 승인 이력"><h4><History size={15}/>협의·승인 이력</h4><ol>{order.sentAt && !hasPoTimeline && <li><strong>본사 PO 발송</strong><span>{time(order.sentAt)}</span><p>이 차수에 연결한 PO의 발송 접수 기록입니다.</p></li>}{timeline.map(event => <li key={event.id}><strong>{timelineLabels[event.action] || event.action}</strong><span>{event.actorName} · {time(event.createdAt)}</span>{timelineDetails(event, hq).map(detail => <p key={detail}>{detail}</p>)}{event.reason && <p>{event.reason}</p>}</li>)}{condition.legacy && order.startedAt && <li><strong>기존 프로세스 생산 시작</strong><span>{order.startedByName || order.acceptance?.actorName || '기존 기록'} · {time(order.startedAt)}</span></li>}{!order.sentAt && !timeline.length && <li><p>PO 발송과 조건 회신·검토 이력을 차수별로 보관합니다.</p></li>}</ol></section>
  </section>
}
