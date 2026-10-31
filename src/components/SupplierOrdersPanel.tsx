import { useEffect, useState } from 'react'
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
import { PoPanel, type PoPanelProps } from './OperationsPanel'
import './supplier-orders.css'

export interface SupplierOrdersPanelProps extends Pick<PoPanelProps, 'onSavePO' | 'onSendPO' | 'onDownload'> {
  workspace: Workspace & SupplierOrderFields
  style: Style
  profile: Profile
  onChanged: () => Promise<unknown>
  onDirtyChange?: (dirty: boolean) => void
  onOpenProductionRuns?: () => void
  parentDirty?: boolean
}
const STATUS_LABEL: Record<string, string> = { awaiting_po: 'PO 발송 대기', awaiting_supplier: '업체 회신 대기', awaiting_approval: '본사 최종 승인 대기', revision_requested: '업체 재협의 요청', approved: '생산 승인 완료 / 생산 진행 중', rejected: '발주 거절', closed: '마감 확정', assignment_changed: '공장 배정 변경 · 확인 필요' }
const time = (value: string | null) => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }) : '—'
interface PoDraft { runId: string; runVersion: number; poId: string; data: PoDispatchInput; reason: string }

export default function SupplierOrdersPanel({ workspace, style, profile, onChanged, onDirtyChange, onSavePO, onSendPO, onDownload, onOpenProductionRuns, parentDirty = false }: SupplierOrdersPanelProps) {
  const [selectedId, setSelectedId] = useState(''), [conditionsDirty, setConditionsDirty] = useState(false), [deliveryDirty, setDeliveryDirty] = useState(false)
  const [poDraft, setPoDraft] = useState<PoDraft | null>(null)
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [busy, setBusy] = useState(false)
  const [refreshRequired, setRefreshRequired] = useState(false)
  const [poPanelDirty, setPoPanelDirty] = useState(false)
  const [projectId, setProjectId] = useState('')
  const actor = workspace.profiles.find(person => person.id === profile.id)
  const hq = !!actor && actor.role !== 'factory'
  const orders = (workspace.supplierProductionOrders || []).filter(order => order.styleId === style.id && (hq || !!actor?.factoryId && order.factoryId === actor.factoryId && style.factoryId === actor.factoryId))
    .sort((a, b) => a.projectCode.localeCompare(b.projectCode) || b.round - a.round || a.runId.localeCompare(b.runId))
  const selectedProjectId = orders.some(order => order.projectId === projectId) ? projectId : orders.find(order => order.runId === selectedId)?.projectId || orders[0]?.projectId || ''
  const projectOrders = orders.filter(order => order.projectId === selectedProjectId)
  const selected = projectOrders.find(order => order.runId === selectedId) || projectOrders[0]
  const projectIdentity = (order: typeof orders[number]) => getHistoricalProjectIdentity(workspace, order.projectId, { name: order.projectName, code: order.projectCode })
  const workflowDirty = conditionsDirty || deliveryDirty || !!poDraft || refreshRequired
  const dirty = workflowDirty || poPanelDirty
  const projectChoices = [...new Map(orders.map(order => [order.projectId, projectIdentity(order)])).values()]
  const projectLabel = (identity: typeof projectChoices[number]) => projectChoices.some(item => item.id !== identity.id && item.label === identity.label) ? `${identity.label} · ID ${identity.id}` : identity.label
  const currentCondition = selected ? getProductionCondition(workspace, selected.runId) : null
  const poStale = !!poDraft && (!selected || poDraft.runId !== selected.runId || poDraft.runVersion !== selected.runVersion || selected.poId !== null || selected.status !== 'awaiting_po')
  useEffect(() => { onDirtyChange?.(dirty || busy); return () => onDirtyChange?.(false) }, [dirty, busy, onDirtyChange])
  if (!actor?.active || !actor.approved) return null

  function choose(id: string) { if (dirty || busy || parentDirty) return; setSelectedId(id); setError(''); setSuccess('') }
  function chooseProject(id: string) { if (dirty || busy || parentDirty) return; setProjectId(id); setSelectedId(''); setError(''); setSuccess('') }
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
    const project = [selected.projectCode || identity.code, identity.name].filter((part, index, parts) => part && parts.indexOf(part) === index).join(' · ')
    const installments = workspace.partialDeliveryPlans?.find(item => item.runId === selected.runId)?.items || []
    const partialDates = installments.length ? `\n분할 납기 계획:\n${installments.map((item, index) => `${index + 1}차: ${item.dueDate} / ${item.quantity} pcs${item.note ? ` · ${item.note}` : ''}`).join('\n')}\n` : ''
    const productionMode = currentCondition?.productionMode ? `생산 방식: ${currentCondition.productionMode === 'cmt' ? '임가공 (CMT)' : '완사입'}\n` : ''
    const body = `안녕하세요. 아래 생산 발주 내용을 확인해 주세요.\n\n프로젝트: ${project}\n프로젝트 코드: ${selected.projectCode || identity.code || '미입력'}\n품번: ${fullCode}\n생산 차수: ${selected.round}차 / ${selected.name}\n담당 업체: ${selected.factoryName}\n${productionMode}본사 요청 납기: ${dueDate}\n${partialDates}\n${SIZES.map(size => `${size}: ${selected.order[size].toLocaleString('ko-KR')} pcs`).join(' / ')}\n총 오더 수량: ${quantityTotal(selected.order).toLocaleString('ko-KR')} pcs\n\n${getPublicAppUrl()}/ 에 업체 계정으로 로그인한 뒤, 해당 프로젝트와 생산 차수를 선택해 예상 납기일과 제안 단가·생산 가능 여부를 입력하고 생산 조건을 회신해 주세요.\n업체 회신 후 본사가 최종 납기·단가·수량을 승인해야 생산이 시작됩니다. PO와 협의·승인 이력은 차수별로 보관됩니다.`
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
    {workspace.supplierOrdersAvailable !== true ? <div className="error-message" role="status">생산 발주 설정을 준비 중입니다. 기존 기록은 유지됩니다.</div> : !orders.length ? <div className="empty-state"><ClipboardCheck size={30} /><h3>등록된 생산 발주가 없습니다.</h3><p>{hq ? '오더를 업로드하거나 생산 차수를 등록한 뒤 PO를 연결하고 발송해 주세요.' : '본사에서 담당 공장의 생산 발주와 PO를 등록하면 이곳에서 확인할 수 있습니다.'}</p>{hq && onOpenProductionRuns && <button className="button button-primary" type="button" onClick={onOpenProductionRuns}>생산 차수 등록으로 이동</button>}</div> : selected && <>
      <div className="form-grid"><label className="field supplier-order-picker"><span className="field-label">프로젝트 코드 · 공식 명칭</span><select className="select" aria-label="PO 프로젝트 코드" value={selectedProjectId} disabled={dirty || busy || parentDirty} onChange={event => chooseProject(event.target.value)}>{projectChoices.map(identity => <option key={identity.id} value={identity.id}>{projectLabel(identity)}</option>)}</select></label>
      <label className="field supplier-order-picker"><span className="field-label">생산 차수 · 품번·컬러·수량</span><select className="select" aria-label="생산 조건 협의 차수" value={selected.runId} disabled={dirty || busy || parentDirty} onChange={event => choose(event.target.value)}>{projectOrders.map(order => <option key={order.runId} value={order.runId}>{projectIdentity(order).label} / {fullStyleSku(order.styleCode, style.production.find(line => line.id === order.lineId)?.color)} / {order.round}차 · {order.name} · {quantityTotal(order.order).toLocaleString('ko-KR')} pcs · {STATUS_LABEL[getProductionCondition(workspace, order.runId).status]}</option>)}</select></label></div>
      {poStale && <div className="error-message" role="status">생산 차수 또는 PO 연결이 변경되었습니다. 작성한 초안은 유지됩니다. 초안을 취소하고 최신 발주를 다시 확인해 주세요.</div>}
      <fieldset disabled={parentDirty || poPanelDirty || busy || refreshRequired} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><article className="panel supplier-order-card">
        <header><div><strong>{projectIdentity(selected).name} · {selected.round}차</strong><p className="muted">{selected.projectCode || projectIdentity(selected).code || '프로젝트 코드 미입력'}</p><h3>{fullStyleSku(selected.styleCode, style.production.find(line => line.id === selected.lineId)?.color)} / {selected.name}</h3></div><span className={`pill supplier-state-${currentCondition?.status}`}>{STATUS_LABEL[currentCondition?.status || selected.status]}</span></header>
        <dl className="supplier-order-facts"><div><dt>본사 요청 납기</dt><dd>{selected.requestedDue || selected.expectedDue || '미입력'}</dd></div><div><dt>PO 발송 접수</dt><dd>{time(selected.sentAt)}</dd></div><div><dt>오더 수량</dt><dd>{quantityTotal(selected.order).toLocaleString('ko-KR')} pcs</dd></div></dl>
        <div className="supplier-order-table"><table aria-label="생산 발주 사이즈별 수량"><thead><tr>{SIZES.map(size => <th key={size}>{size}</th>)}<th>합계</th></tr></thead><tbody><tr>{SIZES.map(size => <td key={size}>{selected.order[size].toLocaleString('ko-KR')}</td>)}<td>{quantityTotal(selected.order).toLocaleString('ko-KR')}</td></tr></tbody></table></div>
        <PartialDeliveryPanel key={selected.runId} workspace={workspace} profile={actor} order={selected} onChanged={onChanged} onDirtyChange={setDeliveryDirty} poDraftOpen={!!poDraft}/>
        {selected.poId && <details className="supplier-po-content"><summary><FileText size={14} />{selected.subject || '연결된 PO 내용 확인'}</summary><p className="muted">아래 PO 내용과 본사 요청 납기를 확인해 주세요.</p><pre>{selected.body}</pre></details>}
        {selected.status === 'awaiting_po' && <p className="supplier-order-note">{hq ? selected.poId ? '이 생산 차수에 PO가 연결되어 있습니다. 아래 PO 발송 영역에서 수신인과 내용을 확인한 뒤 메일을 발송해 주세요.' : '프로젝트 코드와 생산 차수·수량을 선택한 뒤 이 차수 PO 작성으로 수신인과 본사 요청 납기를 입력해 주세요. 연결된 초안을 이 화면에서 확인하고 메일을 발송합니다.' : '본사에서 PO를 발송하면 생산 조건을 회신할 수 있습니다.'}</p>}
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
        <ProductionConditionsReviewPanel key={selected.runId} workspace={workspace} style={style} order={selected} profile={actor} onChanged={onChanged} onDirtyChange={setConditionsDirty} onOpenProductionRuns={onOpenProductionRuns}/>
      </article></fieldset>
    </>}
    {workspace.operationsAvailable === false ? <div className="ops-unavailable" role="status">PO 관리 설정을 준비 중입니다. 기존 기록은 유지됩니다.</div> : <section aria-label="PO 작성·발송 및 이력"><PoPanel style={style} workspace={workspace} profile={profile} onSavePO={onSavePO} onSendPO={onSendPO} onDownload={onDownload} onDirtyChange={setPoPanelDirty} onRefresh={onChanged} featuredPoId={selected?.poId} collapsibleHistory allowCreate={!orders.length || workspace.supplierOrdersAvailable !== true || workspace.productionConditionsAvailable !== true} parentDirty={parentDirty || workflowDirty || busy}/></section>}
  </section>
}
