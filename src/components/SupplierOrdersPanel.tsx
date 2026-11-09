import { useEffect, useRef, useState } from 'react'
import { ClipboardCheck, FileText } from 'lucide-react'
import type { Profile, Style, Workspace } from '../lib/types'
import { quantityTotal, SIZES } from '../lib/types'
import type { SupplierOrderFields } from '../lib/supplier-orders'
import type { PoDispatchInput } from '../lib/operations-types'
import { createProductionOrderPo } from '../lib/supplier-orders-repository'
import { getProductionCondition } from '../lib/production-conditions'
import { fullStyleSku } from '../lib/style-identity'
import ProductionConditionsReviewPanel from './ProductionConditionsReviewPanel'
import PartialDeliveryPanel from './PartialDeliveryPanel'
import { message } from '../lib/utils'
import { getHistoricalProjectIdentity } from '../lib/project-identity'
import { getPublicAppUrl } from '../lib/public-app-url'
import { validatePartialDeliveries } from '../lib/partial-deliveries'
import { PoPanel, type PoPanelProps } from './OperationsPanel'
import { productionContextKey, selectProductionContext, type ProductionSelectionContext } from '../lib/production-selection'
import './supplier-orders.css'

export interface SupplierOrdersPanelProps extends Pick<PoPanelProps, 'onSavePO' | 'onSendPO' | 'onDownload'> {
  workspace: Workspace & SupplierOrderFields
  style: Style
  profile: Profile
  onChanged: () => Promise<unknown>
  onDirtyChange?: (dirty: boolean) => void
  onOpenProductionRuns?: () => void
  parentDirty?: boolean
  activeLineId?: string
  activeProjectId?: string
  activeRunId?: string
  onSelectContext?: (context: ProductionSelectionContext) => void
}
const STATUS_LABEL: Record<string, string> = { awaiting_po: 'PO 발송 대기', awaiting_supplier: '업체 회신 대기', awaiting_approval: '본사 최종 승인 대기', revision_requested: '업체 재협의 요청', approved: '생산 승인 완료 / 생산 진행 중', rejected: '발주 거절', closed: '마감 확정', assignment_changed: '공장 배정 변경 · 확인 필요' }
const time = (value: string | null) => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }) : '—'
interface PoDraft { runId: string; runVersion: number; poId: string; data: PoDispatchInput; reason: string }

export default function SupplierOrdersPanel({ workspace, style, profile, onChanged, onDirtyChange, onSavePO, onSendPO, onDownload, onOpenProductionRuns, parentDirty = false, activeLineId, activeProjectId, activeRunId, onSelectContext }: SupplierOrdersPanelProps) {
  const actor = workspace.profiles.find(person => person.id === profile.id)
  const hq = !!actor && actor.role !== 'factory'
  const orders = (workspace.supplierProductionOrders || []).filter(order => order.styleId === style.id && (hq || !!actor?.factoryId && order.factoryId === actor.factoryId && style.factoryId === actor.factoryId))
    .sort((a, b) => getHistoricalProjectIdentity(workspace, a.projectId, { name: a.projectName, code: a.projectCode }).name.localeCompare(getHistoricalProjectIdentity(workspace, b.projectId, { name: b.projectName, code: b.projectCode }).name, 'ko-KR') || b.round - a.round || a.runId.localeCompare(b.runId))
  const initialContext = { lineId: activeLineId, projectId: activeProjectId, runId: activeRunId }
  const [selectedId, setSelectedId] = useState(() => selectProductionContext(orders, initialContext, order => order.runId)?.runId || ''), [conditionsDirty, setConditionsDirty] = useState(false), [deliveryDirty, setDeliveryDirty] = useState(false)
  const [poDraft, setPoDraft] = useState<PoDraft | null>(null)
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [busy, setBusy] = useState(false)
  const [refreshRequired, setRefreshRequired] = useState(false)
  const [poPanelDirty, setPoPanelDirty] = useState(false)
  const selected = orders.find(order => order.runId === selectedId) || (!selectedId ? selectProductionContext(orders, initialContext, order => order.runId) : undefined)
  const projectIdentity = (order: typeof orders[number]) => getHistoricalProjectIdentity(workspace, order.projectId, { name: order.projectName, code: order.projectCode })
  const workflowDirty = conditionsDirty || deliveryDirty || !!poDraft || refreshRequired
  const dirty = workflowDirty || poPanelDirty
  const orderColor = (order: typeof orders[number]) => style.production.find(line => line.id === order.lineId)?.color || ''
  const orderCode = (order: typeof orders[number]) => { const color = orderColor(order), fullCode = fullStyleSku(order.styleCode, color); return color ? fullCode.slice(0, -color.length) : fullCode }
  const orderSummary = (order: typeof orders[number]) => `${projectIdentity(order).name} / ${orderCode(order)} / ${orderColor(order) || '미등록'} / ${quantityTotal(order.order).toLocaleString('ko-KR')} pcs`
  const duplicateSummary = (order: typeof orders[number]) => orders.filter(item => orderSummary(item) === orderSummary(order)).length > 1
  const currentCondition = selected ? getProductionCondition(workspace, selected.runId) : null
  const poStale = !!poDraft && (!selected || poDraft.runId !== selected.runId || poDraft.runVersion !== selected.runVersion || selected.poId !== null || selected.status !== 'awaiting_po')
  const incomingContextKey = productionContextKey(initialContext), appliedContextKey = useRef(incomingContextKey)
  useEffect(() => {
    if (appliedContextKey.current === incomingContextKey || dirty || busy || parentDirty) return
    appliedContextKey.current = incomingContextKey
    setSelectedId(selectProductionContext(orders, initialContext, order => order.runId)?.runId || '')
    setError(''); setSuccess('')
  }, [incomingContextKey, dirty, busy, parentDirty, orders])
  useEffect(() => { if (!selectedId && selected && !dirty && !busy && !parentDirty) setSelectedId(selected.runId) }, [selectedId, selected?.runId, dirty, busy, parentDirty])
  useEffect(() => { onDirtyChange?.(dirty || busy); return () => onDirtyChange?.(false) }, [dirty, busy, onDirtyChange])
  if (!actor?.active || !actor.approved) return null

  function choose(id: string) { if (dirty || busy || parentDirty) return; const order = orders.find(item => item.runId === id); if (!order) return; setSelectedId(id); onSelectContext?.({ lineId: order.lineId, projectId: order.projectId, runId: order.runId }); setError(''); setSuccess('') }
  async function refresh() {
    if (busy) return
    setBusy(true); setError('')
    try { await onChanged(); setRefreshRequired(false) } catch { setError('최신 발주 정보를 불러오지 못했습니다. 연결을 확인하고 다시 불러와 주세요.'); setRefreshRequired(true) }
    finally { setBusy(false) }
  }
  function beginPo() {
    if (!selected || !hq || busy || dirty || parentDirty || selected.poId || selected.status !== 'awaiting_po') return
    if (workspace.productionConditionsAvailable === true && !currentCondition?.productionMode) { setError('생산 방식·검토 기준을 먼저 설정해 주세요.'); return }
    const fullCode = fullStyleSku(selected.styleCode, style.production.find(line => line.id === selected.lineId)?.color)
    const recipients = [...new Set(workspace.profiles.filter(person => person.role === 'factory' && person.approved && person.active && person.factoryId === selected.factoryId && person.email.trim()).map(person => person.email.trim()))]
    const dueDate = selected.expectedDue || style.dueDate
    const identity = projectIdentity(selected)
    if (!identity.hasOfficialName) { setError('PO를 작성하려면 M열의 프로젝트 명칭을 먼저 등록·확인해 주세요. 본사 예산 관리 코드는 생산 프로젝트 명칭으로 사용하지 않습니다.'); return }
    const project = identity.name
    const installments = workspace.partialDeliveryPlans?.find(item => item.runId === selected.runId)?.items || []
    if (installments.length) { try { validatePartialDeliveries(installments, selected.order) } catch (failure) { setError(`PO 작성 전에 부분 납기 계획을 확인해 주세요. ${message(failure)}`); return } }
    const partialDates = installments.length ? `\n분할 납기 계획:\n${installments.map((item, index) => `${index + 1}차: ${item.dueDate} / ${item.quantity} pcs${item.quantities ? `\n  ${SIZES.map(size => `${size}: ${item.quantities![size].toLocaleString('ko-KR')} pcs`).join(' / ')}` : '\n  사이즈별 예정 수량 미등록'}${item.note ? ` · ${item.note}` : ''}`).join('\n')}\n` : ''
    const productionMode = currentCondition?.productionMode ? `생산 방식: ${currentCondition.productionMode === 'cmt' ? '임가공 (CMT)' : '완사입'}\n` : ''
    const body = `안녕하세요. 아래 생산 발주 내용을 확인해 주세요.\n\n프로젝트 명칭: ${project}\n품번: ${fullCode}\n생산 차수: ${selected.round}차 / ${selected.name}\n담당 업체: ${selected.factoryName}\n${productionMode}본사 요청 납기: ${dueDate}\n${partialDates}\n${SIZES.map(size => `${size}: ${selected.order[size].toLocaleString('ko-KR')} pcs`).join(' / ')}\n총 오더 수량: ${quantityTotal(selected.order).toLocaleString('ko-KR')} pcs\n\n${getPublicAppUrl()}/ 에 업체 계정으로 로그인한 뒤, 해당 프로젝트 명칭과 생산 차수를 선택해 예상 납기일과 제안 단가·생산 가능 여부를 입력하고 생산 조건을 회신해 주세요.\n업체 회신 후 본사가 최종 납기·단가·수량을 승인해야 생산이 시작됩니다. PO와 협의·승인 이력은 차수별로 보관됩니다.`
    setPoDraft({ runId: selected.runId, runVersion: selected.runVersion, poId: crypto.randomUUID(), reason: '프로젝트 생산 차수 PO 작성', data: { recipient: recipients.length === 1 ? recipients[0] : '', dueDate, subject: `[PO] ${project} / ${fullCode} / ${selected.round}차`, body, evidenceAttachmentId: null, voided: false } })
    setError(''); setSuccess('')
  }
  function updatePo<K extends keyof PoDispatchInput>(key: K, value: PoDispatchInput[K]) {
    setPoDraft(current => {
      if (!current) return current
      const data = { ...current.data, [key]: value }
      if (key === 'dueDate') data.body = data.body.replace(`본사 요청 납기: ${current.data.dueDate}`, `본사 요청 납기: ${String(value)}`)
      return { ...current, data }
    })
  }
  async function savePo() {
    if (!poDraft || busy || parentDirty || poPanelDirty) return
    if (poStale) { setError('생산 차수 또는 PO 연결이 변경되었습니다. 초안을 보관한 뒤 취소하고 최신 발주를 확인해 주세요.'); return }
    const data = { ...poDraft.data, recipient: poDraft.data.recipient.trim(), subject: poDraft.data.subject.trim(), body: poDraft.data.body.trim() }
    if (!data.dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(data.dueDate) || !/^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.test(data.recipient) || !data.subject || /[\r\n]/.test(data.subject) || !data.body) { setError('PO 수신 이메일·납기일·제목·본문을 확인해 주세요.'); return }
    const identity = projectIdentity(selected!), budgetCode = (selected?.projectCode || identity.code).trim().toLocaleUpperCase('en-US')
    if (!identity.hasOfficialName || !data.subject.includes(identity.name) || !data.body.includes(identity.name)) { setError('PO 제목과 본문에는 선택한 M열 프로젝트 명칭을 유지해 주세요.'); return }
    if (budgetCode && `${data.subject}\n${data.body}`.toLocaleUpperCase('en-US').includes(budgetCode)) { setError('A열 본사 예산 관리 코드는 업체 발송 PO에 포함할 수 없습니다. 프로젝트 명칭으로 확인해 주세요.'); return }
    if (poDraft.reason.trim().length < 2) { setError('PO 작성 사유를 두 글자 이상 입력해 주세요.'); return }
    setBusy(true); setError(''); setSuccess('')
    let saved = false
    try {
      await createProductionOrderPo(poDraft.runId, poDraft.runVersion, poDraft.poId, data, poDraft.reason.trim(), profile)
      saved = true
      setPoDraft(null)
      await onChanged()
      setRefreshRequired(false)
      setSuccess('이 생산 차수에 PO 초안을 연결했습니다. 아래에서 수신인과 내용을 확인한 뒤 메일 발송을 확인해 주세요. 메일은 아직 발송되지 않았습니다.')
    } catch (failure) {
      if (saved) { setRefreshRequired(true); setError('PO 초안은 저장·연결됐지만 최신 화면을 불러오지 못했습니다. 다시 불러온 뒤 발송해 주세요.') }
      else { setError(message(failure)); await onChanged().catch(() => {}) }
    }
    finally { setBusy(false) }
  }
  return <section className="supplier-orders" aria-label="생산 조건 협의·승인">
    <div className="section-heading"><div><h2><ClipboardCheck size={18} />생산 조건 협의·승인</h2><p className="muted">업체가 회신한 납기·단가·수량을 검토하고 본사 최종 승인 후 생산을 시작합니다.</p></div></div>
    {error && <div className="error-message" role="alert">{error}</div>}{success && <div className="success-message" role="status">{success}</div>}
    {refreshRequired && <button className="button" type="button" disabled={busy} onClick={() => void refresh()}>최신 발주 다시 불러오기</button>}
    {workspace.supplierOrdersAvailable !== true ? <div className="error-message" role="status">생산 발주 설정을 준비 중입니다. 기존 기록은 유지됩니다.</div> : !orders.length ? <div className="empty-state"><ClipboardCheck size={30} /><h3>등록된 생산 발주가 없습니다.</h3><p>{hq ? '오더를 업로드하거나 생산 차수를 등록한 뒤 PO를 연결하고 발송해 주세요.' : '본사에서 담당 공장의 생산 발주와 PO를 등록하면 이곳에서 확인할 수 있습니다.'}</p>{hq && onOpenProductionRuns && <button className="button button-primary" type="button" onClick={onOpenProductionRuns}>생산 차수 등록으로 이동</button>}</div> : <>
      <section className="supplier-order-selection" aria-label="생산 오더 선택">
        <h3>생산 오더 선택</h3>
        <div className="supplier-order-choice-wrap"><table className="supplier-order-choice-table" aria-label="생산 오더 목록"><thead><tr><th>프로젝트 명칭</th><th>품번</th><th>컬러</th><th>총수량</th></tr></thead><tbody>{orders.map(order => {
          const condition = getProductionCondition(workspace, order.runId), duplicate = duplicateSummary(order)
          const reference = `납기 ${order.requestedDue || order.expectedDue || '미정'} · ${STATUS_LABEL[condition.status] || STATUS_LABEL[order.status]}`
          return <tr key={order.runId} className={selected?.runId === order.runId ? 'selected' : ''} title={`${reference}${duplicate ? ` · 발주 기록 ${order.runId}` : ''}`}>
            <td><label className="supplier-order-radio"><input type="radio" name={`supplier-order-${style.id}`} aria-label={`생산 오더 ${orderSummary(order)}${duplicate ? ` / 발주 기록 ${order.runId}` : ''}`} aria-describedby={duplicate ? `supplier-order-reference-${order.runId}` : undefined} data-run-id={order.runId} data-project-id={order.projectId} value={order.runId} checked={selected?.runId === order.runId} disabled={dirty || busy || parentDirty} onChange={() => choose(order.runId)}/><span>{projectIdentity(order).name}</span></label>{duplicate && <small id={`supplier-order-reference-${order.runId}`} className="supplier-order-reference" title={`발주 기록 ${order.runId}`}>{reference}</small>}</td>
            <td>{orderCode(order)}</td><td>{orderColor(order) || '미등록'}</td><td>{quantityTotal(order.order).toLocaleString('ko-KR')} pcs</td>
          </tr>
        })}</tbody></table></div>
      </section>
      {selected ? <>
      {poStale && <div className="error-message" role="status">생산 차수 또는 PO 연결이 변경되었습니다. 작성한 초안은 유지됩니다. 초안을 취소하고 최신 발주를 다시 확인해 주세요.</div>}
      <fieldset disabled={parentDirty || poPanelDirty || busy || refreshRequired} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><article className="panel supplier-order-card">
        <header><div><h3>선택한 생산 오더</h3><p className="muted">시즌: {projectIdentity(selected).season || '미등록'}</p></div><span className={`pill supplier-state-${currentCondition?.status}`}>{STATUS_LABEL[currentCondition?.status || selected.status]}</span></header>
        <dl className="supplier-order-summary" aria-label="선택한 생산 오더 정보"><div><dt>프로젝트 명칭</dt><dd>{projectIdentity(selected).name}</dd></div><div><dt>품번</dt><dd>{orderCode(selected)}</dd></div><div><dt>컬러</dt><dd>{orderColor(selected) || '미등록'}</dd></div><div><dt>총수량</dt><dd>{quantityTotal(selected.order).toLocaleString('ko-KR')} pcs</dd></div></dl>
        <dl className="supplier-order-facts"><div><dt>본사 요청 납기</dt><dd>{selected.requestedDue || selected.expectedDue || '미입력'}</dd></div><div><dt>PO 발송 접수</dt><dd>{time(selected.sentAt)}</dd></div></dl>
        <div className="supplier-order-table"><table aria-label="생산 발주 사이즈별 수량"><thead><tr>{SIZES.map(size => <th key={size}>{size}</th>)}<th>합계</th></tr></thead><tbody><tr>{SIZES.map(size => <td key={size}>{selected.order[size].toLocaleString('ko-KR')}</td>)}<td>{quantityTotal(selected.order).toLocaleString('ko-KR')}</td></tr></tbody></table></div>
        <PartialDeliveryPanel key={`partial-${selected.runId}`} workspace={workspace} profile={actor} order={selected} onChanged={onChanged} onDirtyChange={setDeliveryDirty} poDraftOpen={!!poDraft}/>
        {selected.poId && <details className="supplier-po-content"><summary><FileText size={14} />{selected.subject || '연결된 PO 내용 확인'}</summary><p className="muted">아래 PO 내용과 본사 요청 납기를 확인해 주세요.</p><pre>{selected.body}</pre></details>}
        {selected.status === 'awaiting_po' && <p className="supplier-order-note">{hq ? selected.poId ? '이 생산 차수에 PO가 연결되어 있습니다. 아래 PO 발송 영역에서 수신인과 내용을 확인한 뒤 메일을 발송해 주세요.' : '프로젝트 명칭·품번·컬러·총수량으로 생산 오더를 선택한 뒤 이 차수 PO 작성으로 수신인과 본사 요청 납기를 입력해 주세요. 연결된 초안을 이 화면에서 확인하고 메일을 발송합니다.' : '본사에서 PO를 발송하면 생산 조건을 회신할 수 있습니다.'}</p>}
        {hq && selected.status === 'awaiting_po' && selected.poId === null && !poDraft && <div className="supplier-order-actions"><button className="button" type="button" disabled={busy || dirty} onClick={beginPo}><FileText size={14} />이 차수 PO 작성</button></div>}
        {hq && poDraft && <section className="supplier-po-draft" aria-label="생산 차수 PO 초안">
          <h4>이 생산 차수의 PO 초안</h4><p className="muted">프로젝트·품번·차수·사이즈별 수량을 미리 채웠습니다. 초안 저장 후 수신인과 내용을 확인하고 메일을 발송합니다.</p>
          <div className="form-grid"><label className="field"><span className="field-label">차수 PO 수신 이메일</span><input className="input" type="email" required aria-label="차수 PO 수신 이메일" maxLength={254} value={poDraft.data.recipient} disabled={busy || poStale} onChange={event => updatePo('recipient', event.target.value)} /></label><label className="field"><span className="field-label">차수 PO 납기일</span><input className="input" type="date" required aria-label="차수 PO 납기일" value={poDraft.data.dueDate} disabled={busy || poStale} onChange={event => updatePo('dueDate', event.target.value)} /></label></div>
          <label className="field"><span className="field-label">차수 PO 제목</span><input className="input" required aria-label="차수 PO 제목" maxLength={500} value={poDraft.data.subject} disabled={busy || poStale} onChange={event => updatePo('subject', event.target.value)} /></label>
          <label className="field"><span className="field-label">차수 PO 내용</span><textarea className="textarea" rows={12} required aria-label="차수 PO 내용" maxLength={20000} value={poDraft.data.body} disabled={busy || poStale} onChange={event => updatePo('body', event.target.value)} /></label>
<label className="field"><span className="field-label">발주 관련 첨부파일</span><select className="select" aria-label="차수 PO 첨부파일" value={poDraft.data.evidenceAttachmentId || ''} disabled={busy || poStale} onChange={event => updatePo('evidenceAttachmentId', event.target.value || null)}><option value="">첨부파일 없음</option>{workspace.attachments.filter(file => file.styleId === style.id).map(file => <option key={file.id} value={file.id}>{file.name}</option>)}</select></label>
          <label className="field"><span className="field-label">차수 PO 작성 사유</span><input className="input" required aria-label="차수 PO 작성 사유" minLength={2} maxLength={1000} value={poDraft.reason} disabled={busy || poStale} onChange={event => setPoDraft(current => current ? { ...current, reason: event.target.value } : current)} /></label>
          <div className="supplier-order-actions"><button className="button" type="button" disabled={busy} onClick={() => { setPoDraft(null); setError('') }}>차수 PO 초안 취소</button><button className="button button-primary" type="button" disabled={busy || poStale} onClick={() => void savePo()}><FileText size={14} />{busy ? '저장 중…' : '차수 PO 초안 저장 및 연결'}</button></div>
        </section>}
        {selected.status === 'assignment_changed' && <div className="error-message" role="status">이 발주의 공장 배정이 변경되었습니다. 본사에서 발주와 PO를 확인해야 합니다. 이전 동의 이력은 보존됩니다.</div>}
        <ProductionConditionsReviewPanel key={`conditions-${selected.runId}`} workspace={workspace} style={style} order={selected} profile={actor} onChanged={onChanged} onDirtyChange={setConditionsDirty} onOpenProductionRuns={onOpenProductionRuns}/>
      </article></fieldset>
      </> : <div className="empty-state"><p>선택한 컬러·프로젝트의 생산 오더를 위 목록에서 선택해 주세요. 다른 컬러의 생산 내용으로 자동 전환하지 않습니다.</p></div>}
    </>}
    {workspace.operationsAvailable === false ? <div className="ops-unavailable" role="status">PO 관리 설정을 준비 중입니다. 기존 기록은 유지됩니다.</div> : <section aria-label="PO 작성·발송 및 이력"><PoPanel style={style} workspace={workspace} profile={profile} onSavePO={onSavePO} onSendPO={onSendPO} onDownload={onDownload} onDirtyChange={setPoPanelDirty} onRefresh={onChanged} featuredPoId={selected?.poId} collapsibleHistory allowCreate={!orders.length || workspace.supplierOrdersAvailable !== true || workspace.productionConditionsAvailable !== true} parentDirty={parentDirty || workflowDirty || busy}/></section>}
  </section>
}
