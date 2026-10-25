import { useEffect, useState } from 'react'
import { CheckCircle2, ClipboardCheck, FileText, Play, ShieldCheck } from 'lucide-react'
import type { Profile, Style, Workspace } from '../lib/types'
import { quantityTotal, SIZES } from '../lib/types'
import type { SupplierOrder, SupplierOrderFields } from '../lib/supplier-orders'
import type { PoDispatchInput } from '../lib/operations-types'
import { acceptSupplierProductionOrder, createProductionOrderPo, startProductionRun } from '../lib/supplier-orders-repository'
import { message } from '../lib/utils'
import './supplier-orders.css'

export interface SupplierOrdersPanelProps {
  workspace: Workspace & SupplierOrderFields
  style: Style
  profile: Profile
  onChanged: () => Promise<unknown>
  onDirtyChange?: (dirty: boolean) => void
  onOpenPO?: () => void
}
const STATUS_LABEL: Record<SupplierOrder['status'], string> = {
  awaiting_po: 'PO 발송 대기', awaiting_acceptance: '업체 납기·동의 대기', accepted: '업체 생산 동의 완료',
  in_progress: '생산 진행 중', closed: '마감 확정', assignment_changed: '공장 배정 변경 · 확인 필요',
}
const time = (value: string | null) => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }) : '—'
interface PoDraft { runId: string; runVersion: number; poId: string; data: PoDispatchInput; reason: string }

export default function SupplierOrdersPanel({ workspace, style, profile, onChanged, onDirtyChange, onOpenPO }: SupplierOrdersPanelProps) {
  const [selectedId, setSelectedId] = useState(''), [date, setDate] = useState(''), [agreed, setAgreed] = useState(false)
  const [draftVersion, setDraftVersion] = useState<{ run: number; po: number | null } | null>(null)
  const [poDraft, setPoDraft] = useState<PoDraft | null>(null)
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [busy, setBusy] = useState(false)
  const hq = profile.role !== 'factory'
  const orders = (workspace.supplierProductionOrders || []).filter(order => order.styleId === style.id && (hq || !!profile.factoryId && order.factoryId === profile.factoryId && style.factoryId === profile.factoryId))
    .sort((a, b) => a.projectCode.localeCompare(b.projectCode) || b.round - a.round || a.runId.localeCompare(b.runId))
  const selected = orders.find(order => order.runId === selectedId) || orders[0]
  const agreementDirty = !!date || agreed
  const dirty = agreementDirty || !!poDraft
  const stale = !!selected && agreementDirty && !!draftVersion && (draftVersion.run !== selected.runVersion || draftVersion.po !== selected.poVersion)
  const poStale = !!poDraft && (!selected || poDraft.runId !== selected.runId || poDraft.runVersion !== selected.runVersion || selected.poId !== null || selected.status !== 'awaiting_po')
  useEffect(() => { onDirtyChange?.(dirty || busy); return () => onDirtyChange?.(false) }, [dirty, busy, onDirtyChange])
  if (!profile.active || !profile.approved) return null

  function choose(id: string) { if (dirty || busy) return; setSelectedId(id); setDraftVersion(null); setError(''); setSuccess('') }
  function beginDraft() { if (selected && (!agreementDirty || !draftVersion)) setDraftVersion({ run: selected.runVersion, po: selected.poVersion }) }
  function cancelDraft() { setDate(''); setAgreed(false); setDraftVersion(null); setError('') }
  async function accept() {
    if (!selected || busy) return
    if (stale || selected.status !== 'awaiting_acceptance') { setError('발주 또는 동의 상태가 변경되었습니다. 입력을 취소하고 최신 PO를 다시 확인해 주세요.'); return }
    if (selected.poVersion === null) { setError('발송된 PO 정보를 다시 확인해 주세요.'); return }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { setError('업체 예상 납기일을 입력해 주세요.'); return }
    if (!agreed) { setError('PO 내용과 예상 납기일을 확인하고 생산 동의에 체크해 주세요.'); return }
    setBusy(true); setError(''); setSuccess('')
    try {
      await acceptSupplierProductionOrder(selected.runId, draftVersion?.run ?? selected.runVersion, selected.poVersion, date, agreed, profile)
      cancelDraft()
      await onChanged()
      setSuccess('예상 납기일과 생산 동의를 기록하고 생산 진행을 시작했습니다.')
    } catch (failure) { setError(message(failure)); await onChanged().catch(() => {}) }
    finally { setBusy(false) }
  }
  async function start() {
    if (!selected || busy) return
    setBusy(true); setError(''); setSuccess('')
    try { await startProductionRun(selected.runId, selected.runVersion, profile); await onChanged(); setSuccess('업체가 동의한 발주를 생산 진행으로 전환했습니다.') }
    catch (failure) { setError(message(failure)); await onChanged().catch(() => {}) }
    finally { setBusy(false) }
  }
  function beginPo() {
    if (!selected || !hq || busy || dirty || selected.poId || selected.status !== 'awaiting_po') return
    const recipients = [...new Set(workspace.profiles.filter(person => person.role === 'factory' && person.approved && person.active && person.factoryId === selected.factoryId && person.email.trim()).map(person => person.email.trim()))]
    const dueDate = selected.expectedDue || style.dueDate
    const project = selected.projectCode || selected.projectName
    const body = `안녕하세요. 아래 생산 발주 내용을 확인해 주세요.\n\n프로젝트: ${project}\n품번: ${selected.styleCode}\n생산 차수: ${selected.round}차 / ${selected.name}\n담당 업체: ${selected.factoryName}\n본사 요청 납기: ${dueDate}\n\n${SIZES.map(size => `${size}: ${selected.order[size].toLocaleString('ko-KR')} pcs`).join(' / ')}\n총 오더 수량: ${quantityTotal(selected.order).toLocaleString('ko-KR')} pcs\n\n${window.location.origin}/ 에 업체 계정으로 로그인한 뒤, 해당 프로젝트와 생산 차수를 선택해 예상 납기일을 입력하고 생산 동의를 제출해 주세요.\n생산 동의를 제출하면 생산 진행이 시작되며, PO 내용과 납기·동의 계정·시각이 이력으로 보관됩니다.`
    setPoDraft({ runId: selected.runId, runVersion: selected.runVersion, poId: crypto.randomUUID(), reason: '프로젝트 생산 차수 PO 작성', data: { recipient: recipients.length === 1 ? recipients[0] : '', dueDate, subject: `[PO] ${project} / ${selected.styleCode} / ${selected.round}차`, body, evidenceAttachmentId: null, voided: false } })
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
    if (!poDraft || busy) return
    if (poStale) { setError('생산 차수 또는 PO 연결이 변경되었습니다. 초안을 보관한 뒤 취소하고 최신 발주를 확인해 주세요.'); return }
    const data = { ...poDraft.data, recipient: poDraft.data.recipient.trim(), subject: poDraft.data.subject.trim(), body: poDraft.data.body.trim() }
    if (!data.dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(data.dueDate) || !/^[^\s@\r\n]+@[^\s@\r\n]+\.[^\s@\r\n]+$/.test(data.recipient) || !data.subject || /[\r\n]/.test(data.subject) || !data.body) { setError('PO 수신 이메일·납기일·제목·본문을 확인해 주세요.'); return }
    if (poDraft.reason.trim().length < 2) { setError('PO 작성 사유를 두 글자 이상 입력해 주세요.'); return }
    setBusy(true); setError(''); setSuccess('')
    try {
      await createProductionOrderPo(poDraft.runId, poDraft.runVersion, poDraft.poId, data, poDraft.reason.trim(), profile)
      setPoDraft(null)
      await onChanged()
      setSuccess('이 생산 차수에 PO 초안을 연결했습니다. 수신인과 내용을 확인한 뒤 PO 탭에서 메일을 발송해 주세요.')
      onOpenPO?.()
    } catch (failure) { setError(message(failure)); await onChanged().catch(() => {}) }
    finally { setBusy(false) }
  }
  return <section className="supplier-orders" aria-label="업체 납기 및 생산 동의">
    <div className="section-heading"><div><h2><ClipboardCheck size={18} />업체 납기·생산 동의</h2><p className="muted">프로젝트·생산 차수별 PO를 확인하고 업체의 예상 납기와 동의를 기록합니다.</p></div>{hq && onOpenPO && <button className="button" type="button" onClick={onOpenPO} disabled={busy || dirty}><FileText size={14} />PO 작성·발송으로 이동</button>}</div>
    {workspace.supplierOrdersAvailable !== true ? <div className="error-message" role="status">업체 생산 동의 기능은 007 생산 차수와 008 업체 동의 설정을 적용한 뒤 사용할 수 있습니다.</div> : !orders.length ? <div className="empty-state"><ClipboardCheck size={30} /><h3>등록된 생산 발주가 없습니다.</h3><p>{hq ? '오더를 업로드하거나 생산 차수를 등록한 뒤 PO를 연결하고 발송해 주세요.' : '본사에서 담당 공장의 생산 발주와 PO를 등록하면 이곳에서 확인할 수 있습니다.'}</p></div> : selected && <>
      <label className="field supplier-order-picker"><span className="field-label">프로젝트 · 생산 차수</span><select className="select" aria-label="업체 동의 생산 차수" value={selected.runId} disabled={dirty || busy} onChange={event => choose(event.target.value)}>{orders.map(order => <option key={order.runId} value={order.runId}>{order.projectCode || workspace.projects.find(project => project.id === order.projectId)?.name || '프로젝트'} / {order.styleCode} / {order.round}차 · {order.name} · {STATUS_LABEL[order.status]}</option>)}</select></label>
      {error && <div className="error-message" role="alert">{error}</div>}{success && <div className="success-message" role="status">{success}</div>}
      {stale && <div className="error-message" role="status">발주 또는 동의 상태가 변경되었습니다. 작성한 납기는 유지됩니다. 동의 입력을 취소하고 최신 PO를 다시 확인해 주세요.</div>}
      {poStale && <div className="error-message" role="status">생산 차수 또는 PO 연결이 변경되었습니다. 작성한 초안은 유지됩니다. 초안을 취소하고 최신 발주를 다시 확인해 주세요.</div>}
      <article className="panel supplier-order-card">
        <header><div><strong>{selected.projectCode || '프로젝트 코드 미입력'} · {selected.round}차</strong><h3>{selected.styleCode} / {selected.name}</h3></div><span className={`pill supplier-state-${selected.status}`}>{STATUS_LABEL[selected.status]}</span></header>
        <dl className="supplier-order-facts"><div><dt>본사 요청 납기</dt><dd>{selected.requestedDue || selected.expectedDue || '미입력'}</dd></div><div><dt>PO 발송 접수</dt><dd>{time(selected.sentAt)}</dd></div><div><dt>오더 수량</dt><dd>{quantityTotal(selected.order).toLocaleString('ko-KR')} pcs</dd></div></dl>
        <div className="supplier-order-table"><table aria-label="생산 발주 사이즈별 수량"><thead><tr>{SIZES.map(size => <th key={size}>{size}</th>)}<th>합계</th></tr></thead><tbody><tr>{SIZES.map(size => <td key={size}>{selected.order[size].toLocaleString('ko-KR')}</td>)}<td>{quantityTotal(selected.order).toLocaleString('ko-KR')}</td></tr></tbody></table></div>
        {selected.poId && <details className="supplier-po-content"><summary><FileText size={14} />{selected.subject || '연결된 PO 내용 확인'}</summary><p className="muted">아래 PO 내용과 본사 요청 납기를 확인해 주세요.</p><pre>{selected.body}</pre></details>}
        {selected.status === 'awaiting_po' && <p className="supplier-order-note">{hq ? selected.poId ? '이 생산 차수에 PO가 연결되어 있습니다. PO 탭에서 수신인과 내용을 확인한 뒤 메일을 발송해 주세요.' : '이 차수 PO 작성으로 수신인과 본사 요청 납기를 입력해 주세요. 초안을 연결한 뒤 PO 탭에서 내용을 확인하고 메일을 발송합니다.' : '본사에서 PO를 발송하면 예상 납기일을 입력하고 생산에 동의할 수 있습니다.'}</p>}
        {hq && selected.status === 'awaiting_po' && selected.poId === null && !poDraft && <div className="supplier-order-actions"><button className="button" type="button" disabled={busy || dirty} onClick={beginPo}><FileText size={14} />이 차수 PO 작성</button></div>}
        {hq && poDraft && <section className="supplier-po-draft" aria-label="생산 차수 PO 초안">
          <h4>이 생산 차수의 PO 초안</h4><p className="muted">프로젝트·품번·차수·사이즈별 수량을 미리 채웠습니다. 초안 저장 후 수신인과 내용을 확인하고 메일을 발송합니다.</p>
          <div className="form-grid"><label className="field"><span className="field-label">차수 PO 수신 이메일</span><input className="input" type="email" required aria-label="차수 PO 수신 이메일" maxLength={254} value={poDraft.data.recipient} disabled={busy || poStale} onChange={event => updatePo('recipient', event.target.value)} /></label><label className="field"><span className="field-label">차수 PO 납기일</span><input className="input" type="date" required aria-label="차수 PO 납기일" value={poDraft.data.dueDate} disabled={busy || poStale} onChange={event => updatePo('dueDate', event.target.value)} /></label></div>
          <label className="field"><span className="field-label">차수 PO 제목</span><input className="input" required aria-label="차수 PO 제목" maxLength={500} value={poDraft.data.subject} disabled={busy || poStale} onChange={event => updatePo('subject', event.target.value)} /></label>
          <label className="field"><span className="field-label">차수 PO 내용</span><textarea className="textarea" rows={12} required aria-label="차수 PO 내용" maxLength={20000} value={poDraft.data.body} disabled={busy || poStale} onChange={event => updatePo('body', event.target.value)} /></label>
          <label className="field"><span className="field-label">차수 PO 작성 사유</span><input className="input" required aria-label="차수 PO 작성 사유" minLength={2} maxLength={1000} value={poDraft.reason} disabled={busy || poStale} onChange={event => setPoDraft(current => current ? { ...current, reason: event.target.value } : current)} /></label>
          <div className="supplier-order-actions"><button className="button" type="button" disabled={busy} onClick={() => { setPoDraft(null); setError('') }}>차수 PO 초안 취소</button><button className="button button-primary" type="button" disabled={busy || poStale} onClick={() => void savePo()}><FileText size={14} />{busy ? '저장 중…' : '차수 PO 초안 저장 및 연결'}</button></div>
        </section>}
        {selected.status === 'assignment_changed' && <div className="error-message" role="status">이 발주의 공장 배정이 변경되었습니다. 본사에서 발주와 PO를 확인해야 합니다. 이전 동의 이력은 보존됩니다.</div>}
        {!hq && (selected.status === 'awaiting_acceptance' || dirty) && <div className="supplier-accept-form">
          <label className="field"><span className="field-label">업체 예상 납기일</span><input className="input" aria-label="업체 예상 납기일" type="date" required value={date} disabled={busy || stale} onChange={event => { beginDraft(); setDate(event.target.value) }} /></label>
          <label className="supplier-agreement"><input type="checkbox" aria-label="PO 확인 및 생산 동의" checked={agreed} disabled={busy || stale} onChange={event => { beginDraft(); setAgreed(event.target.checked) }} /><span>위 PO 내용과 수량을 확인했으며, 입력한 예상 납기일을 기준으로 생산 진행에 동의합니다.</span></label>
          <p className="muted"><ShieldCheck size={13} />동의하면 이 차수의 생산 진행이 시작됩니다. 동의한 PO 내용·수량·납기와 계정·공장·동의 시각이 이력으로 보관됩니다.</p>
          <div className="supplier-order-actions"><button className="button" type="button" disabled={busy || !dirty} onClick={cancelDraft}>동의 입력 취소</button><button className="button button-primary" type="button" disabled={busy || stale || selected.status !== 'awaiting_acceptance' || !date || !agreed} onClick={() => void accept()}><CheckCircle2 size={14} />{busy ? '기록 중…' : '예상 납기 등록 및 생산 동의'}</button></div>
        </div>}
        {selected.acceptance && <section className="supplier-acceptance-record" aria-label="생산 동의 기록"><h4><CheckCircle2 size={15} />생산 동의 기록</h4><dl><div><dt>업체 확약 예상 납기</dt><dd>{selected.acceptance.expectedDeliveryDate}</dd></div><div><dt>동의 담당자</dt><dd>{selected.acceptance.actorName}</dd></div><div><dt>동의 시각</dt><dd>{time(selected.acceptance.acceptedAt)}</dd></div></dl><p className="muted">동의 후에는 이 기록을 덮어쓰지 않습니다. 발주 조건을 바꾸려면 본사에서 새 PO와 생산 차수를 등록해 주세요.</p></section>}
        {hq && selected.status === 'awaiting_acceptance' && <p className="supplier-order-note">배정된 업체 계정으로 로그인해 예상 납기와 생산 동의를 제출하면 이 차수의 생산 진행이 자동으로 시작됩니다.</p>}
        {hq && selected.status === 'accepted' && <div className="supplier-order-actions"><button className="button button-primary" type="button" disabled={busy} onClick={() => void start()}><Play size={14} />{busy ? '전환 중…' : '동의 확인 후 생산 시작'}</button></div>}
        {selected.startedAt && <p className="supplier-order-note">생산 시작 기록: {time(selected.startedAt)}</p>}
      </article>
    </>}
  </section>
}
