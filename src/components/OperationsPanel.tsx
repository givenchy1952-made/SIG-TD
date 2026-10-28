import { useCallback, useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertCircle, ArrowDownToLine, Check, ChevronDown, FileText, History, Mail, Plus, Save, Scissors, Send, Tags, Truck, ShieldCheck, X } from 'lucide-react'
import type { Attachment, Profile, Quantities, Style, Workspace } from '../lib/types'
import { emptyQuantities, quantityTotal, SIZES, STATUS_LABEL } from '../lib/types'
import type { OperationRow, OperationsWorkspace, PoDispatch, PoDispatchInput, ShipmentBatchInput, StyleOperationInput, StyleOperationKind } from '../lib/operations-types'
import { EMPTY_OPERATIONS } from '../lib/operations-types'
import { localDate, message } from '../lib/utils'
import OutlookMailSettings, { INITIAL_OUTLOOK_STATE } from './OutlookMailSettings'
import { acquireOutlookAuthorization, OUTLOOK_ATTACHMENT_LIMIT, outlookConnectionError } from '../lib/outlook-mail'
import type { OutlookMailState } from '../lib/outlook-mail'
import './operations.css'

export interface OperationsPanelProps {
  style: Style
  workspace: Workspace & { operations?: OperationsWorkspace; operationsAvailable?: boolean }
  profile: Profile
  onSavePO: (id: string, styleId: string, data: PoDispatchInput, expectedVersion: number, reason: string) => Promise<void>
  onSendPO: (id: string, expectedVersion: number, outlookAccessToken?: string, outlookIdToken?: string) => Promise<void>
  onSaveShipment: (id: string, styleId: string, lineId: string, data: ShipmentBatchInput, expectedVersion: number, expectedStyleVersion: number, reason: string) => Promise<void>
  onSaveOperation: (id: string, styleId: string, kind: StyleOperationKind, data: StyleOperationInput, expectedVersion: number, reason: string) => Promise<void>
  onDownload: (attachment: Attachment) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  mode?: 'all' | 'po' | 'processing'
  qualityContent?: ReactNode
}
const amount = (value: number) => value.toLocaleString('ko-KR')
const dateTime = (value: string) => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
const today = () => localDate()
const clone = <T,>(value: T): T => structuredClone(value)
const asNumber = (raw: string) => raw === '' ? 0 : Math.max(0, Math.floor(Number(raw) || 0))
const addQuantities = (...items: Quantities[]): Quantities => Object.fromEntries(SIZES.map(size => [size, items.reduce((sum, quantities) => sum + quantities[size], 0)])) as Quantities
const poPayload = (record: PoDispatch): PoDispatchInput => ({ dueDate: record.dueDate, recipient: record.recipient, subject: record.subject, body: record.body, evidenceAttachmentId: record.evidenceAttachmentId, voided: record.voided })
const rowName = (kind: StyleOperationKind) => kind === 'label' ? '라벨' : '자수'
const newOperationRow = (): OperationRow => ({ id: crypto.randomUUID(), catalogId: '', name: '', specification: '', quantity: 0, lossQuantity: 0, completedQuantity: 0, status: 'todo', orderedAt: '', requestedAt: '', completedAt: '', dueDate: '', note: '' })

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field"><span className="field-label">{label}</span>{children}</label> }
function ErrorNotice({ error }: { error: string }) { return error ? <div className="ops-error" role="alert"><AlertCircle size={15} /><span>{error}</span></div> : null }
function SuccessNotice({ text }: { text: string }) { return text ? <div className="ops-success" role="status"><Check size={14} />{text}</div> : null }
function ConflictNotice({ text, onCancel }: { text: string; onCancel: () => void }) { return <div className="ops-conflict" role="status"><History size={16} /><div><strong>다른 사용자가 먼저 수정했습니다.</strong><p>{text} 입력 내용은 유지됩니다. 필요한 내용을 보관한 뒤 최신 내역에서 다시 편집해 주세요.</p></div><button type="button" className="button" onClick={onCancel}>편집 취소 · 최신 내역</button></div> }
function ReasonField({ name, value, onChange, disabled = false }: { name: string; value: string; onChange: (value: string) => void; disabled?: boolean }) { return <Field label={`${name} 변경 사유`}><input className="input" aria-label={`${name} 변경 사유`} value={value} maxLength={1000} minLength={2} disabled={disabled} placeholder="변경 사유를 두 글자 이상 입력하세요" onChange={event => onChange(event.target.value)} /></Field> }

function downloadEml(data: PoDispatchInput) {
  const cleanHeader = (text: string) => text.replace(/[\r\n]/g, ' ').trim()
  const subject = btoa(Array.from(new TextEncoder().encode(data.subject), value => String.fromCharCode(value)).join(''))
  const content = [`To: ${cleanHeader(data.recipient)}`, `Subject: =?UTF-8?B?${subject}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', data.body, '', `PO 납기일: ${data.dueDate}`].join('\r\n')
  const url = URL.createObjectURL(new Blob([content], { type: 'message/rfc822' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'SIG_PO_메일초안.eml'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function OperationsPanel(props: OperationsPanelProps) {
  const mode = props.mode || 'all'
  const [tab, setTab] = useState<'po' | 'shipments' | 'label' | 'embroidery' | 'quality'>(mode === 'processing' ? 'label' : 'po')
  const [dirtyPanels, setDirtyPanels] = useState({ po: false, shipments: false, label: false, embroidery: false })
  const reportPO = useCallback((dirty: boolean) => setDirtyPanels(current => current.po === dirty ? current : { ...current, po: dirty }), [])
  const reportShipments = useCallback((dirty: boolean) => setDirtyPanels(current => current.shipments === dirty ? current : { ...current, shipments: dirty }), [])
  const reportLabels = useCallback((dirty: boolean) => setDirtyPanels(current => current.label === dirty ? current : { ...current, label: dirty }), [])
  const reportEmbroidery = useCallback((dirty: boolean) => setDirtyPanels(current => current.embroidery === dirty ? current : { ...current, embroidery: dirty }), [])
  useEffect(() => { props.onDirtyChange?.(props.workspace.operationsAvailable !== false && Object.values(dirtyPanels).some(Boolean)) }, [dirtyPanels, props.onDirtyChange, props.workspace.operationsAvailable])
  const operations = props.workspace.operations || EMPTY_OPERATIONS
  const allTabs = [ ['po', 'PO 발송 이력', Mail, operations.poDispatches.filter(record => record.styleId === props.style.id).length], ['shipments', '부분 출고', Truck, operations.shipmentBatches.filter(record => record.styleId === props.style.id && !record.voided).length], ['label', '중화 라벨', Tags, operations.styleOperations.filter(record => record.styleId === props.style.id && record.kind === 'label').flatMap(record => record.rows).length], ['embroidery', '비와이 자수', Scissors, operations.styleOperations.filter(record => record.styleId === props.style.id && record.kind === 'embroidery').flatMap(record => record.rows).length], ['quality', '품질 검사', ShieldCheck, 0] ] as const
  const tabs = allTabs.filter(([key]) => mode === 'all' ? key !== 'quality' || props.qualityContent : mode === 'processing' && ['label', 'embroidery', 'quality'].includes(key))
  const id = useId()
  return <section className="operations-panel" aria-label={mode === 'po' ? 'PO 관리' : mode === 'processing' ? '가공·품질 관리' : '발주·출고·가공 관리'}>
    <div className="ops-heading"><div><h2>{mode === 'po' ? 'PO 관리' : mode === 'processing' ? '가공·품질 관리' : '발주부터 출고, 가공까지'}</h2><p>{mode === 'po' ? '납기와 수신인을 확인하고 PO를 발송하며 이력을 보관합니다.' : mode === 'processing' ? '중화 라벨·비와이 자수 작업과 품질 검사를 함께 관리합니다.' : 'PO 발송 근거와 차수별 출고, 협력업체 작업 내역을 함께 관리합니다.'}</p></div><span className="pill"><History size={12} /> 수정 이력 보존</span></div>
    {mode !== 'po' && <div className="ops-tabs" role="tablist" aria-label="스타일 추가 업무">{tabs.map(([key, label, Icon, count]) => <button type="button" role="tab" id={`${id}-${key}-tab`} aria-controls={`${id}-${key}-panel`} aria-selected={tab === key} className={tab === key ? 'active' : ''} key={key} onClick={() => setTab(key)}><Icon size={14} />{label}<span>{count}</span></button>)}</div>}
    {props.workspace.operationsAvailable === false ? <div className="ops-unavailable"><AlertCircle size={21} /><div><strong>추가 업무 기능 설정이 필요합니다.</strong><p>{props.profile.role === 'factory' ? '관리자에게 기능 설정을 요청해 주세요.' : <>관리자가 데이터베이스에 <code>003_operations.sql</code> 마이그레이션을 적용한 뒤 다시 접속해 주세요.</>}</p></div></div> : <>
      {mode !== 'processing' && <div role="tabpanel" id={`${id}-po-panel`} aria-label="PO 발송 이력" hidden={mode !== 'po' && tab !== 'po'}><PoPanel {...props} onDirtyChange={reportPO} /></div>}
      {mode === 'all' && <div role="tabpanel" id={`${id}-shipments-panel`} aria-labelledby={`${id}-shipments-tab`} hidden={tab !== 'shipments'}><ShipmentPanel {...props} onDirtyChange={reportShipments} /></div>}
      {mode !== 'po' && <><div role="tabpanel" id={`${id}-label-panel`} aria-labelledby={`${id}-label-tab`} hidden={tab !== 'label'}><ProcessingPanel {...props} onDirtyChange={reportLabels} kind="label" /></div>
      <div role="tabpanel" id={`${id}-embroidery-panel`} aria-labelledby={`${id}-embroidery-tab`} hidden={tab !== 'embroidery'}><ProcessingPanel {...props} onDirtyChange={reportEmbroidery} kind="embroidery" /></div>
      {props.qualityContent && <div role="tabpanel" id={`${id}-quality-panel`} aria-labelledby={`${id}-quality-tab`} hidden={tab !== 'quality'}>{props.qualityContent}</div>}</>}
    </>}
  </section>
}

function PoPanel({ style, workspace, profile, onSavePO, onSendPO, onDownload, onDirtyChange }: OperationsPanelProps) {
  const records = (workspace.operations?.poDispatches || []).filter(record => record.styleId === style.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const [draft, setDraft] = useState<{ id: string; version: number; data: PoDispatchInput } | null>(null)
  const [reason, setReason] = useState(''), [error, setError] = useState(''), [success, setSuccess] = useState(''), [busy, setBusy] = useState(false)
  const [voidTarget, setVoidTarget] = useState<PoDispatch | null>(null), [voidReason, setVoidReason] = useState('')
  const [sendTarget, setSendTarget] = useState<PoDispatch | null>(null)
  const [outlook, setOutlook] = useState<OutlookMailState>(INITIAL_OUTLOOK_STATE)
  const [outlookDirty, setOutlookDirty] = useState(false), [sendViaOutlook, setSendViaOutlook] = useState(false)
  const reportOutlook = useCallback((value: OutlookMailState) => setOutlook(value), [])
  const reportOutlookDirty = useCallback((value: boolean) => setOutlookDirty(value), [])
  useEffect(() => { onDirtyChange?.(!!draft || !!voidTarget || busy || outlookDirty) }, [draft, voidTarget, busy, outlookDirty, onDirtyChange])
  const hq = profile.role !== 'factory'
  const attachments = workspace.attachments.filter(file => file.styleId === style.id)
  const conflict = !!draft && draft.version > 0 && records.find(record => record.id === draft.id)?.version !== draft.version
  const sendConflict = !!sendTarget && records.find(record => record.id === sendTarget.id)?.version !== sendTarget.version
  const factory = workspace.factories.find(item => item.id === style.factoryId)
  const statusLabel = { draft: '초안 · 미발송', sending: '발송 요청 중', sent: '발송 접수', failed: '발송 실패', unknown: '접수 여부 확인 필요' }
  const statusColor = { draft: 'unset', sending: 'progress', sent: 'done', failed: 'delayed', unknown: 'todo' }
  const useOutlookFor = (record: PoDispatch) => record.attempts > 0 ? record.provider === 'outlook' : outlook.mode === 'configured'
  const outlookUnavailable = (record: PoDispatch) => (record.attempts > 0 && record.provider === 'outlook' || record.attempts === 0) && ['loading', 'unavailable'].includes(outlook.mode)
  function begin(record?: PoDispatch, copyAsNew = false) {
    setDraft({ id: record && !copyAsNew ? record.id : crypto.randomUUID(), version: record && !copyAsNew ? record.version : 0, data: record ? { ...poPayload(record), voided: false } : { dueDate: style.dueDate, recipient: '', subject: `[PO] ${style.code} / 납기 ${style.dueDate}`, body: `안녕하세요.\n\n${style.code} / ${style.name}의 PO 관련 내용을 전달드립니다.\n기준 납기: ${style.dueDate}\n담당 공장: ${factory?.name || '미배정'}\n\n오더 수량과 납기를 확인해 회신 부탁드립니다.`, evidenceAttachmentId: null, voided: false } }); setReason(''); setError(''); setSuccess('')
  }
  function update<K extends keyof PoDispatchInput>(key: K, value: PoDispatchInput[K]) { setDraft(current => { if (!current) return current; const data = { ...current.data, [key]: value }; if (key === 'dueDate') { if (current.data.subject === `[PO] ${style.code} / 납기 ${current.data.dueDate}`) data.subject = `[PO] ${style.code} / 납기 ${String(value)}`; data.body = current.data.body.replace(`기준 납기: ${current.data.dueDate}`, `기준 납기: ${String(value)}`) }; return { ...current, data } }); setSuccess('') }
  async function save() {
    if (!draft) return
    if (!draft.data.dueDate || !draft.data.recipient.trim() || !draft.data.subject.trim() || !draft.data.body.trim()) { setError('납기일, 수신 이메일, 제목과 메일 내용을 모두 입력해 주세요.'); return }
    if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(draft.data.recipient.trim())) { setError('수신 이메일 한 개를 올바른 형식으로 입력해 주세요.'); return }
    if (reason.trim().length < 2) { setError('PO 변경 사유를 두 글자 이상 입력해 주세요.'); return }
    setBusy(true); setError('')
    try { await onSavePO(draft.id, style.id, { ...draft.data, recipient: draft.data.recipient.trim(), subject: draft.data.subject.trim(), body: draft.data.body.trim() }, draft.version, reason.trim()); setDraft(null); setReason(''); setSuccess('PO 초안을 저장했습니다. 메일은 아직 발송되지 않았습니다.') } catch (err) { setError(message(err)) } finally { setBusy(false) }
  }
  async function send() {
    if (!sendTarget) return
    setBusy(true); setError(''); setSuccess('')
    try {
      let accessToken: string | undefined, idToken: string | undefined
      if (sendViaOutlook) {
        if (!outlook.configuration || !outlook.identity) throw new Error('먼저 본인의 Outlook 계정을 연결해 주세요.')
        const file = attachments.find(item => item.id === sendTarget.evidenceAttachmentId)
        if (file && file.size > OUTLOOK_ATTACHMENT_LIMIT) throw new Error('Outlook 첨부파일은 최대 2MB입니다. 작은 사진·PDF로 새 PO를 작성해 주세요.')
        const authorization = await acquireOutlookAuthorization(outlook.configuration, profile.email)
        accessToken = authorization.accessToken; idToken = authorization.idToken
      }
      await onSendPO(sendTarget.id, sendTarget.version, accessToken, idToken)
      setSuccess(sendViaOutlook ? 'Microsoft 365가 발송 요청을 접수했습니다. Outlook 보낸 편지함과 발송 이력을 확인해 주세요. 수신자 배달·열람 확인은 별도입니다.' : '메일 서비스가 발송 요청을 접수했습니다. 수신자 배달 또는 열람 확인을 의미하지 않습니다.')
    } catch (err) { setError(sendViaOutlook ? outlookConnectionError(err) : message(err)) }
    finally { setBusy(false); setSendTarget(null) }
  }
  async function markVoid() {
    if (!voidTarget || voidReason.trim().length < 2) return
    setBusy(true); setError('')
    try { await onSavePO(voidTarget.id, style.id, { ...poPayload(voidTarget), voided: true }, voidTarget.version, voidReason.trim()); setVoidTarget(null); setVoidReason(''); setSuccess('미발송 초안을 보관 처리했습니다. 원본과 변경 이력은 유지됩니다.') } catch (err) { setError(message(err)) } finally { setBusy(false) }
  }
  return <div className="ops-section"><div className="section-heading"><div><h3><Mail size={16} />PO 메일 및 발송 이력</h3><p className="muted">수신인과 납기를 확인하고 프로그램에서 PO 메일을 발송합니다.</p></div>{hq && !draft && <button className="button" type="button" onClick={() => begin()}><Plus size={14} />PO 작성</button>}</div>{hq && <OutlookMailSettings profile={profile} disabled={busy || !!sendTarget} onStateChange={reportOutlook} onDirtyChange={reportOutlookDirty} />}<div className="ops-manual-note"><Send size={15} /><div><strong>PO 초안 저장 → 내용 확인 → 메일 발송</strong><p>초안을 저장해도 메일이 발송되지 않습니다. 실제 발송 결과와 메일 서비스 접수 근거를 별도로 기록합니다. 발송 접수는 수신자 배달·열람 확인을 뜻하지 않습니다.</p></div></div><ErrorNotice error={error} /><SuccessNotice text={success} />
    {draft && <section className="ops-editor"><div className="section-heading"><h3>PO 메일 작성</h3><span className="pill">납기일 필수</span></div>{conflict && <ConflictNotice text="PO 초안이 변경되었습니다." onCancel={() => setDraft(null)} />}<div className="form-grid">
      <Field label="PO 납기일"><input className="input" aria-label="PO 납기일" type="date" required value={draft.data.dueDate} disabled={busy} onChange={event => update('dueDate', event.target.value)} /></Field><Field label="PO 수신 이메일"><input className="input" type="email" aria-label="PO 수신 이메일" required placeholder="factory@example.com" maxLength={254} value={draft.data.recipient} disabled={busy} onChange={event => update('recipient', event.target.value)} /></Field>
      <Field label="현재 담당 공장"><input className="input" readOnly value={factory?.name || '미배정'} /></Field><Field label="PO 참고 근거"><select className="select" aria-label="PO 근거 첨부파일" value={draft.data.evidenceAttachmentId || ''} disabled={busy} onChange={event => update('evidenceAttachmentId', event.target.value || null)}><option value="">참고 근거 없음</option>{attachments.map(file => <option key={file.id} value={file.id}>{file.name}</option>)}</select></Field>
    </div><Field label="PO 메일 제목"><input className="input" aria-label="PO 메일 제목" required maxLength={500} value={draft.data.subject} disabled={busy} onChange={event => update('subject', event.target.value)} /></Field><Field label="PO 메일 내용"><textarea className="textarea" aria-label="PO 메일 내용" required rows={7} maxLength={20000} value={draft.data.body} disabled={busy} onChange={event => update('body', event.target.value)} /></Field><div className="ops-compose-actions"><button className="button button-ghost" type="button" onClick={() => downloadEml(draft.data)}><ArrowDownToLine size={13} />메일 초안 다운로드 (.eml)</button><span className="ops-sender-hint">선택한 사진·PDF는 프로그램에서 보내는 메일에 첨부됩니다. Outlook은 최대 2MB, 기존 메일 서비스는 최대 10MB입니다. .eml 초안에는 파일이 포함되지 않습니다.</span></div><ReasonField name="PO" value={reason} onChange={setReason} disabled={busy} /><div className="ops-edit-footer"><span>발송을 시도한 메일은 내용을 바꿀 수 없습니다. 정정 시 새 PO로 복사하세요.</span><button className="button button-ghost" type="button" disabled={busy} onClick={() => setDraft(null)}>PO 편집 취소</button><button className="button button-primary" type="button" disabled={busy || conflict} onClick={() => void save()}><Save size={14} />{busy ? '저장 중…' : 'PO 초안 저장'}</button></div></section>}
    {!records.length && !draft ? <div className="ops-empty"><Mail size={29} strokeWidth={1.2} /><strong>아직 PO 메일이 없습니다.</strong><p>PO를 작성하고 납기를 확인한 뒤 메일을 발송하세요.</p></div> : <div className="ops-po-list">{records.map(record => { const evidence = attachments.find(file => file.id === record.evidenceAttachmentId); const attempts = workspace.operations?.poDispatchAttempts.filter(attempt => attempt.dispatchId === record.id).sort((a, b) => b.attempt - a.attempt) || []; return <article className={`ops-po-card ${record.voided ? 'voided' : ''}`} key={record.id}><header><span className="ops-po-icon"><Mail size={17} /></span><div><h4>{record.subject}</h4><p>{record.recipient}<span>·</span>{record.sentAt ? `발송 접수 ${dateTime(record.sentAt)}` : '발송 접수 일시 없음'}</p></div><span className={`badge status-${record.voided ? 'unset' : statusColor[record.status]}`}>{record.voided ? '보관된 초안' : statusLabel[record.status]}</span></header><div className="ops-po-deadline"><span>PO 기준 납기</span><strong>{record.dueDate}</strong><small>{record.styleCodeSnapshot || style.code} · {workspace.factories.find(item => item.id === record.factoryIdSnapshot)?.name || '발송 기준 공장 기록'}</small></div><details><summary>메일 내용 및 발송 근거 확인<ChevronDown size={13} /></summary><pre>{record.body}</pre><div className="ops-evidence"><FileText size={14} /><span>{record.provider === 'outlook' ? record.providerRequestId ? `Microsoft 접수 추적 ID: ${record.providerRequestId}` : 'Microsoft 접수 추적 ID 없음' : record.providerMessageId ? `메일 서비스 접수 ID: ${record.providerMessageId}` : '메일 서비스 접수 ID 없음 · 발송 성공 근거 없음'}{record.senderEmailSnapshot && ` · 발신자: ${record.senderEmailSnapshot}`}</span>{evidence && <button className="button button-ghost" type="button" onClick={() => void onDownload(evidence).catch(err => setError(message(err)))}>{evidence.name}<ArrowDownToLine size={12} /></button>}</div>{attempts.length > 0 && <div className="ops-attempt-list">{attempts.map(attempt => <div key={attempt.id}><strong>{attempt.attempt}차 시도 · {statusLabel[attempt.status]}</strong><time>{dateTime(attempt.startedAt)}</time>{attempt.providerRequestId ? <span>Microsoft 접수 추적 ID {attempt.providerRequestId}</span> : attempt.providerMessageId && <span>접수 ID {attempt.providerMessageId}</span>}{attempt.senderEmailSnapshot && <span>발신자 {attempt.senderEmailSnapshot}</span>}{attempt.error && <p>{attempt.error}</p>}</div>)}</div>}</details>{record.lastError && <p className="ops-delivery-error">{record.lastError}</p>}{(record.status === 'sending' || record.status === 'unknown') && <p className="ops-sender-hint">중복 발송을 방지하기 위해 재전송이 차단됩니다. 관리자가 메일 서비스의 실제 접수 여부를 확인해야 합니다.</p>}{hq && !record.voided && <div className="ops-po-actions">{!draft && <><button className="button button-ghost" type="button" onClick={() => begin(record, true)}>새 PO로 복사</button>{record.status === 'draft' && record.attempts === 0 && <button className="button button-ghost" type="button" onClick={() => begin(record)}>PO 초안 수정</button>}{profile.role === 'admin' && record.status === 'draft' && record.attempts === 0 && <button className="button button-ghost" type="button" onClick={() => { setVoidTarget(record); setVoidReason(''); setError('') }}>미발송 초안 보관</button>}</>}{(record.status === 'draft' || record.status === 'failed') && <button className="button button-primary" type="button" disabled={busy || outlookDirty || outlookUnavailable(record)} onClick={() => { setSendViaOutlook(useOutlookFor(record)); setSendTarget(record); setError(''); setSuccess('') }}><Send size={13} />{record.status === 'failed' ? '동일 내용 재발송' : 'PO 메일 발송'}</button>}</div>}</article> })}</div>}
    {sendTarget && <div className="ops-inline-confirm" role="alertdialog" aria-label="PO 메일 발송 확인"><h3>이 PO 메일을 발송할까요?</h3><p>발송 방법: {sendViaOutlook ? 'Microsoft 365 Outlook' : '기존 메일 서비스'}<br />{sendViaOutlook && <>보낸 사람: {outlook.identity?.email || 'Outlook 연결 필요'}<br /></>}수신인: {sendTarget.recipient}<br />제목: {sendTarget.subject}<br />PO 기준 납기: {sendTarget.dueDate}<br />{sendViaOutlook && <>첨부파일: 사진·PDF 최대 2MB<br /></>}발송 시도 후에는 내용을 수정할 수 없습니다.</p>{sendViaOutlook && !outlook.identity && <div className="ops-error" role="alert">이 창을 닫고 먼저 본인의 Outlook 계정을 연결해 주세요.</div>}{sendConflict && <div className="ops-error" role="alert">다른 사용자가 이 PO를 수정했습니다. 창을 닫고 최신 내역을 확인해 주세요.</div>}<div><button className="button" type="button" disabled={busy} onClick={() => setSendTarget(null)}>취소</button><button className="button button-primary" type="button" disabled={busy || sendConflict || sendViaOutlook && (!outlook.configuration || !outlook.identity)} onClick={() => void send()}>{busy ? '발송 요청 중…' : '발송 확인'}</button></div></div>}
    {voidTarget && <div className="ops-inline-confirm" role="alertdialog" aria-label="미발송 PO 초안 보관"><h3>이 초안을 보관 처리할까요?</h3><p>발송되지 않은 초안만 보관할 수 있습니다. 원본과 변경 이력은 보존됩니다.</p><Field label="PO 보관 사유"><input autoFocus className="input" aria-label="PO 보관 사유" value={voidReason} maxLength={1000} onChange={event => setVoidReason(event.target.value)} /></Field><div><button className="button" type="button" disabled={busy} onClick={() => setVoidTarget(null)}>취소</button><button className="button button-primary" type="button" disabled={busy || voidReason.trim().length < 2} onClick={() => void markVoid()}>미발송 초안 보관 확인</button></div></div>}
  </div>
}

export function ShipmentPanel({ style, workspace, profile, onSaveShipment, onDirtyChange, fixedLineId, parentDirty = false }: OperationsPanelProps & { fixedLineId?: string; parentDirty?: boolean }) {
  const [lineId, setLineId] = useState(style.production[0]?.id || '')
  const line = style.production.find(item => item.id === (fixedLineId || lineId)) || (!fixedLineId ? style.production[0] : undefined)
  const records = (workspace.operations?.shipmentBatches || []).filter(record => record.styleId === style.id && record.lineId === line?.id).sort((a, b) => a.round - b.round)
  const ledger = workspace.operations?.shipmentLedgers.find(record => record.styleId === style.id && record.lineId === line?.id)
  const baseline = ledger?.baselineQuantities || line?.shipped || emptyQuantities()
  const baselineDate = ledger ? ledger.baselineDate : line?.shippedAt || ''
  const batchesTotal = addQuantities(...records.filter(record => !record.voided).map(record => record.quantities))
  const [selectedId, setSelectedId] = useState('')
  const selected = records.find(record => record.id === selectedId) || records.at(-1)
  const [draft, setDraft] = useState<{ id: string; version: number; styleVersion: number; lineId: string; round: number; data: ShipmentBatchInput } | null>(null)
  const [reason, setReason] = useState(''), [error, setError] = useState(''), [success, setSuccess] = useState(''), [busy, setBusy] = useState(false), [conflicted, setConflicted] = useState(false)
  useEffect(() => { onDirtyChange?.(!!draft || busy) }, [draft, busy, onDirtyChange])
  const canEdit = profile.role === 'admin' || profile.role === 'factory'
  const stale = !!draft && (conflicted || draft.styleVersion !== style.version || draft.version > 0 && (workspace.operations?.shipmentBatches || []).find(record => record.id === draft.id)?.version !== draft.version)
  const current = draft?.data || selected
  function begin(existing = false) {
    if (parentDirty) { setError('메인 생산의 변경 내용을 먼저 저장한 뒤 출고 차수를 입력해 주세요.'); return }
    if (!line) return
    const record = existing ? selected : undefined
    setDraft({ id: record?.id || crypto.randomUUID(), version: record?.version || 0, styleVersion: style.version, lineId: line.id, round: record?.round || Math.max(0, ...records.map(item => item.round)) + 1, data: record ? { shippedAt: record.shippedAt, quantities: clone(record.quantities), tracking: record.tracking, note: record.note, voided: record.voided } : { shippedAt: today(), quantities: emptyQuantities(), tracking: '', note: '', voided: false } }); setReason(''); setError(''); setSuccess(''); setConflicted(false)
  }
  function update<K extends keyof ShipmentBatchInput>(key: K, value: ShipmentBatchInput[K]) { setDraft(item => item ? { ...item, data: { ...item.data, [key]: value } } : item); setSuccess('') }
  async function save() {
    if (!draft) return
    if (parentDirty) { setError('메인 생산의 변경 내용을 먼저 저장한 뒤 출고 차수를 저장해 주세요.'); return }
    if (!draft.data.shippedAt) { setError('실제 출고일을 입력해 주세요.'); return }
    if (quantityTotal(draft.data.quantities) < 1 && !draft.data.voided) { setError('출고 수량을 하나 이상 입력해 주세요.'); return }
    if (reason.trim().length < 2) { setError('출고 변경 사유를 두 글자 이상 입력해 주세요.'); return }
    setBusy(true); setError('')
    try { await onSaveShipment(draft.id, style.id, draft.lineId, draft.data, draft.version, draft.styleVersion, reason.trim()); setSelectedId(draft.id); setDraft(null); setReason(''); setSuccess('출고 차수를 저장하고 누적 실 출고 수량을 반영했습니다.') } catch (err) { const text = message(err); setError(text); if (/conflict|version|다른 사용자가/i.test(text)) setConflicted(true) } finally { setBusy(false) }
  }
  return <div className="ops-section">{parentDirty && <p className="muted">메인 생산의 변경 내용을 먼저 저장하면 차수별 출고를 입력할 수 있습니다.</p>}<div className="section-heading"><div><h3><Truck size={17} />{fixedLineId ? '실 출고 차수' : '차수별 부분 출고'}</h3><p className="muted">컬러별로 1차, 2차 등 실제 출고 내역을 누적합니다.</p></div>{!fixedLineId ? <select className="select ops-line-select" aria-label="출고 컬러" value={line?.id || ''} disabled={!!draft || busy} onChange={event => { setLineId(event.target.value); setSelectedId(''); setSuccess(''); setError('') }}>{style.production.map(item => <option key={item.id} value={item.id}>{item.color} · {style.code}{item.color}</option>)}</select> : <span className="pill">{line?.color} · 실 출고 합산</span>}</div><ErrorNotice error={error} /><SuccessNotice text={success} />
    {!line ? <div className="ops-empty">생산 컬러를 먼저 등록해 주세요.</div> : <>{!fixedLineId && <><div className="ops-shipment-summary"><div><span>오더 수량</span><strong>{amount(quantityTotal(line.order))}<small>pcs</small></strong></div><div><span>이전 입력 수량</span><strong>{amount(quantityTotal(baseline))}<small>pcs</small></strong></div><div><span>차수별 출고 합계</span><strong>{amount(quantityTotal(batchesTotal))}<small>pcs</small></strong></div><div><span>누적 실 출고</span><strong>{amount(quantityTotal(addQuantities(baseline, batchesTotal)))}<small>pcs</small></strong></div></div></>}<div className="ops-baseline-note"><History size={13} /><p>이전 입력 수량은 기존 화면에 입력되어 있던 수량입니다. 차수별 내역과 중복 합산하지 않도록 별도 기준으로 보관됩니다. {baselineDate ? `기존 기록 일자: ${baselineDate}` : '이전 출고일 미기재'}</p></div>
      {!fixedLineId && <><div className="ops-quantity-scroll"><table className="data-table ops-ledger-table"><thead><tr><th>출고 구분</th>{SIZES.map(size => <th key={size}>{size}</th>)}<th>합계</th></tr></thead><tbody><tr><th>이전 입력 수량</th>{SIZES.map(size => <td key={size}>{amount(baseline[size])}</td>)}<td>{amount(quantityTotal(baseline))}</td></tr>{records.map(record => <tr key={record.id} className={record.voided ? 'ops-voided-row' : ''}><th>{record.round}차 출고 {record.voided && <small>무효</small>}</th>{SIZES.map(size => <td key={size}>{amount(record.quantities[size])}</td>)}<td>{amount(quantityTotal(record.quantities))}</td></tr>)}<tr className="ops-ledger-total"><th>누적 실 출고</th>{SIZES.map(size => <td key={size}>{amount(baseline[size] + batchesTotal[size])}</td>)}<td>{amount(quantityTotal(addQuantities(baseline, batchesTotal)))}</td></tr></tbody></table></div></>}
      <div className="ops-round-toolbar"><div className="ops-round-tabs" aria-label="출고 차수">{records.map(record => <button type="button" key={record.id} disabled={!!draft} className={(draft ? draft.id : selected?.id) === record.id ? 'active' : ''} onClick={() => setSelectedId(record.id)}>{record.round}차{record.voided && <span>무효</span>}</button>)}</div>{canEdit && !draft && <button className="button" type="button" onClick={() => begin()}><Plus size={14} />출고 차수 추가</button>}</div>
      {stale && <ConflictNotice text="스타일 또는 출고 차수의 최신 버전이 바뀌었습니다." onCancel={() => { setDraft(null); setReason(''); setConflicted(false); setError('') }} />}
      {current ? <section className="ops-editor"><div className="section-heading"><h3>{draft?.round || selected?.round}차 출고 내역 {current.voided && <span className="pill">무효 기록</span>}</h3>{canEdit && !draft && (profile.role === 'admin' || !current.voided) && <button className="button button-ghost" type="button" onClick={() => begin(true)}>출고 내역 수정</button>}</div><div className="form-grid"><Field label="출고일"><input className="input" type="date" aria-label="출고일" value={current.shippedAt} disabled={!draft || busy} onChange={event => update('shippedAt', event.target.value)} /></Field><Field label="운송장 번호"><input className="input" aria-label="운송장 번호" maxLength={120} value={current.tracking} disabled={!draft || busy} onChange={event => update('tracking', event.target.value)} /></Field></div><div className="ops-size-inputs">{SIZES.map(size => <Field key={size} label={size}><input className="input" type="number" min="0" max="10000000" step="1" aria-label={`${size} 출고 수량`} value={current.quantities[size]} disabled={!draft || busy} onChange={event => update('quantities', { ...current.quantities, [size]: asNumber(event.target.value) })} /></Field>)}<div className="ops-size-total"><span>합계</span><strong>{amount(quantityTotal(current.quantities))}</strong></div></div><Field label="출고 메모"><textarea className="textarea" aria-label="출고 메모" rows={3} maxLength={10000} value={current.note} disabled={!draft || busy} onChange={event => update('note', event.target.value)} /></Field>
      {draft && <>{draft.version > 0 && profile.role === 'admin' && <label className="ops-checkbox"><input type="checkbox" checked={draft.data.voided} disabled={busy} onChange={event => update('voided', event.target.checked)} />무효 처리 · 원본 및 변경 이력 보존</label>}<ReasonField name="출고" value={reason} onChange={setReason} disabled={busy} /><div className="ops-edit-footer"><span>누적 출고 수량은 저장 시 자동 계산됩니다.</span><button className="button button-ghost" type="button" disabled={busy} onClick={() => { setDraft(null); setReason(''); setConflicted(false) }}>출고 편집 취소</button><button className="button button-primary" type="button" disabled={busy || stale} onClick={() => void save()}><Save size={14} />{busy ? '출고 저장 중…' : '출고 차수 저장'}</button></div></>}
      </section> : <div className="ops-empty"><Truck size={27} strokeWidth={1.2} /><strong>아직 차수별 출고 내역이 없습니다.</strong><p>{canEdit ? '출고 차수를 추가해 실제 출고일과 사이즈별 수량을 기록하세요.' : '외부 공장 또는 관리자가 출고 차수를 등록합니다.'}</p></div>}
    </>}
  </div>
}

function ProcessingPanel({ style, workspace, profile, onSaveOperation, onDirtyChange, kind }: OperationsPanelProps & { kind: StyleOperationKind }) {
  const record = (workspace.operations?.styleOperations || []).filter(item => item.styleId === style.id && item.kind === kind).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  const label = rowName(kind)
  const [draft, setDraft] = useState<{ id: string; version: number; data: StyleOperationInput } | null>(null)
  const [reason, setReason] = useState(''), [error, setError] = useState(''), [success, setSuccess] = useState(''), [busy, setBusy] = useState(false), [conflicted, setConflicted] = useState(false)
  useEffect(() => { onDirtyChange?.(!!draft || busy) }, [draft, busy, onDirtyChange])
  const hq = profile.role !== 'factory'
  const stale = !!draft && (conflicted || (record?.version || 0) !== draft.version)
  const rows = draft?.data.rows || record?.rows || []
  const catalogs = (workspace.operations?.operationCatalogs || []).filter(item => item.kind === kind)
  const activeCatalogs = catalogs.filter(item => item.active)
  function begin() { setDraft({ id: record?.id || crypto.randomUUID(), version: record?.version || 0, data: record ? { rows: clone(record.rows), note: record.note, voided: record.voided } : { rows: [newOperationRow()], note: '', voided: false } }); setReason(''); setError(''); setSuccess(''); setConflicted(false) }
  function updateRow<K extends keyof OperationRow>(id: string, key: K, value: OperationRow[K]) { setDraft(item => item ? { ...item, data: { ...item.data, rows: item.data.rows.map(row => row.id === id ? { ...row, [key]: value } : row) } } : item); setSuccess('') }
  function addRow() { setDraft(item => item ? { ...item, data: { ...item.data, rows: [...item.data.rows, newOperationRow()] } } : item) }
  function removeRow(id: string) { setDraft(item => item ? { ...item, data: { ...item.data, rows: item.data.rows.filter(row => row.id !== id) } } : item) }
  async function save() {
    if (!draft) return
    if (!draft.data.rows.length || draft.data.rows.some(row => !row.catalogId || !row.name.trim())) { setError(`${label} 종류 또는 작업명을 모두 입력해 주세요.`); return }
    if (kind === 'embroidery' && draft.data.rows.some(row => row.completedQuantity > row.quantity + row.lossQuantity)) { setError('자수 완료 수량은 요청 수량과 로스 수량의 합계를 초과할 수 없습니다.'); return }
    if (reason.trim().length < 2) { setError(`${label} 변경 사유를 두 글자 이상 입력해 주세요.`); return }
    setBusy(true); setError('')
    try { await onSaveOperation(draft.id, style.id, kind, { ...draft.data, rows: draft.data.rows.map(row => ({ ...row, name: row.name.trim() })) }, draft.version, reason.trim()); setDraft(null); setReason(''); setSuccess(`${label} 내역을 저장했습니다.`) } catch (err) { const text = message(err); setError(text); if (/conflict|version|다른 사용자가/i.test(text)) setConflicted(true) } finally { setBusy(false) }
  }
  return <div className="ops-section"><div className="section-heading"><div><h3>{kind === 'label' ? <Tags size={17} /> : <Scissors size={17} />}{kind === 'label' ? '중화 라벨 발주 관리' : '비와이 자수 작업 관리'}</h3><p className="muted">{kind === 'label' ? '등록된 라벨 종류를 선택하고 발주 수량과 로스 수량을 구분합니다.' : '등록된 자수 작업별 요청·완료 수량과 일정을 누적 관리합니다.'}</p></div>{hq && !draft && <button className="button" type="button" disabled={!record && !activeCatalogs.length} onClick={begin}><Plus size={14} />{label} 관리 {record ? '수정' : '시작'}</button>}</div><ErrorNotice error={error} /><SuccessNotice text={success} />{stale && <ConflictNotice text={`${label} 작업 내역이 변경되었습니다.`} onCancel={() => { setDraft(null); setReason(''); setConflicted(false); setError('') }} />}
    {!activeCatalogs.length && <div className="ops-catalog-note"><AlertCircle size={15} /><p>선택할 {label} 종류가 없습니다. {hq ? '관리자에게 고정 종류 목록의 사용 상태를 확인해 달라고 요청해 주세요.' : '본사에서 작업 내역을 등록하면 이곳에서 확인할 수 있습니다.'}</p></div>}
    <div className="ops-process-summary"><div><span>{kind === 'label' ? '라벨 종류' : '자수 작업'}</span><strong>{rows.length}<small>건</small></strong></div><div><span>{kind === 'label' ? '발주 수량' : '요청 수량'}</span><strong>{amount(rows.reduce((sum, row) => sum + row.quantity, 0))}<small>개</small></strong></div><div><span>{kind === 'label' ? '로스 수량' : '완료 수량'}</span><strong>{amount(rows.reduce((sum, row) => sum + (kind === 'label' ? row.lossQuantity : row.completedQuantity), 0))}<small>개</small></strong></div><div><span>{kind === 'label' ? '총 필요 수량' : '잔여 수량'}</span><strong>{amount(rows.reduce((sum, row) => sum + (kind === 'label' ? row.quantity + row.lossQuantity : row.quantity + row.lossQuantity - row.completedQuantity), 0))}<small>개</small></strong></div></div>
    {!rows.length && !draft ? <div className="ops-empty">{kind === 'label' ? <Tags size={28} strokeWidth={1.2} /> : <Scissors size={28} strokeWidth={1.2} />}<strong>아직 등록된 {label} 내역이 없습니다.</strong><p>{hq ? '관리 시작 버튼을 눌러 필요한 종류와 수량을 입력하세요.' : '본사에서 등록한 내역을 이곳에서 확인할 수 있습니다.'}</p></div> : <div className="ops-processing-rows">{rows.map((row, index) => <section className="ops-processing-row" key={row.id}><div className="ops-processing-row-header"><span className="ops-row-number">{String(index + 1).padStart(2, '0')}</span><h4>{row.name || `${label} ${index + 1}`}</h4>{!draft && <span className={`badge status-${row.status}`}>{STATUS_LABEL[row.status]}</span>}{draft && <button className="icon-button" type="button" aria-label={`${label} 행 ${index + 1} 제거`} disabled={busy} onClick={() => removeRow(row.id)}><X size={15} /></button>}</div><div className="form-grid"><Field label={kind === 'label' ? '라벨 종류' : '자수 작업명'}><select className="select" aria-label={`${kind === 'label' ? '라벨 종류' : '자수 작업명'} ${index + 1}`} value={row.catalogId} disabled={!draft || busy} onChange={event => { const catalog = catalogs.find(item => item.id === event.target.value); setDraft(current => current ? { ...current, data: { ...current.data, rows: current.data.rows.map(item => item.id === row.id ? { ...item, catalogId: event.target.value, name: catalog?.name || '' } : item) } } : current) }}><option value="">등록된 종류 선택</option>{activeCatalogs.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}{row.catalogId && !activeCatalogs.some(item => item.id === row.catalogId) && <option value={row.catalogId}>{row.name} · 사용 중지</option>}</select></Field><Field label="규격 / 작업 사양"><input className="input" aria-label={`${label} 사양 ${index + 1}`} value={row.specification} maxLength={1000} disabled={!draft || busy} placeholder={kind === 'label' ? '예: 40 × 20 mm / 블랙' : '예: 5cm / 실버 실'} onChange={event => updateRow(row.id, 'specification', event.target.value)} /></Field><Field label="진행 상태"><select className="select" aria-label={`${label} 상태 ${index + 1}`} value={row.status} disabled={!draft || busy} onChange={event => updateRow(row.id, 'status', event.target.value as OperationRow['status'])}>{Object.entries(STATUS_LABEL).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></Field>
      <Field label={kind === 'label' ? '발주 수량' : '요청 수량'}><input className="input" type="number" aria-label={`${label} ${kind === 'label' ? '발주' : '요청'} 수량 ${index + 1}`} min="0" max="10000000" value={row.quantity} disabled={!draft || busy} onChange={event => updateRow(row.id, 'quantity', asNumber(event.target.value))} /></Field><Field label={kind === 'label' ? '로스 수량' : '완료 수량'}><input className="input" type="number" aria-label={`${label} ${kind === 'label' ? '로스' : '완료'} 수량 ${index + 1}`} min="0" max="10000000" value={kind === 'label' ? row.lossQuantity : row.completedQuantity} disabled={!draft || busy} onChange={event => updateRow(row.id, kind === 'label' ? 'lossQuantity' : 'completedQuantity', asNumber(event.target.value))} /></Field><Field label={kind === 'label' ? '총 필요 수량 (자동)' : '잔여 수량 (자동)'}><input className="input" aria-label={`${label} ${kind === 'label' ? '총 필요' : '잔여'} 수량 ${index + 1}`} readOnly value={kind === 'label' ? row.quantity + row.lossQuantity : row.quantity + row.lossQuantity - row.completedQuantity} /></Field>
      {kind === 'label' ? <><Field label="라벨 발주일"><input className="input" type="date" aria-label={`라벨 발주일 ${index + 1}`} value={row.orderedAt} disabled={!draft || busy} onChange={event => updateRow(row.id, 'orderedAt', event.target.value)} /></Field><Field label="라벨 입고 예정일"><input className="input" type="date" aria-label={`라벨 입고 예정일 ${index + 1}`} value={row.dueDate} disabled={!draft || busy} onChange={event => updateRow(row.id, 'dueDate', event.target.value)} /></Field></> : <><Field label="자수 요청일"><input className="input" type="date" aria-label={`자수 요청일 ${index + 1}`} value={row.requestedAt} disabled={!draft || busy} onChange={event => updateRow(row.id, 'requestedAt', event.target.value)} /></Field><Field label="자수 예정일"><input className="input" type="date" aria-label={`자수 예정일 ${index + 1}`} value={row.dueDate} disabled={!draft || busy} onChange={event => updateRow(row.id, 'dueDate', event.target.value)} /></Field><Field label="자수 완료일"><input className="input" type="date" aria-label={`자수 완료일 ${index + 1}`} value={row.completedAt} disabled={!draft || busy} onChange={event => updateRow(row.id, 'completedAt', event.target.value)} /></Field></>}
    </div><Field label={`${label} 메모`}><textarea className="textarea" aria-label={`${label} 메모 ${index + 1}`} rows={2} maxLength={5000} value={row.note} disabled={!draft || busy} onChange={event => updateRow(row.id, 'note', event.target.value)} /></Field></section>)}</div>}
    {draft && <><button className="button ops-add-row" type="button" disabled={busy} onClick={addRow}><Plus size={14} />{kind === 'label' ? '라벨 종류 추가' : '자수 작업 추가'}</button><Field label={`${label} 공통 메모`}><textarea className="textarea" rows={2} aria-label={`${label} 공통 메모`} maxLength={10000} disabled={busy} value={draft.data.note} onChange={event => setDraft(current => current ? { ...current, data: { ...current.data, note: event.target.value } } : current)} /></Field><ReasonField name={label} value={reason} onChange={setReason} disabled={busy} /><div className="ops-edit-footer"><span>종류를 제거하거나 수정해도 이전 값은 변경 이력에 보관됩니다.</span><button className="button button-ghost" type="button" disabled={busy} onClick={() => { setDraft(null); setReason(''); setConflicted(false) }}>{label} 편집 취소</button><button className="button button-primary" type="button" disabled={busy || stale} onClick={() => void save()}><Save size={14} />{busy ? '저장 중…' : `${label} 내역 저장`}</button></div></>}
    {!draft && record && <div className="ops-record-meta"><History size={12} />버전 {record.version} · {dateTime(record.updatedAt)} 업데이트{record.note && <p>{record.note}</p>}</div>}
  </div>
}
