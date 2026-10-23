import { useEffect, useId, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, ChevronRight, Clock3, FileImage, FileText, History, LockKeyhole, MessageSquare, Package, Paperclip, Plus, Save, Send, ShieldCheck, Trash2, X } from 'lucide-react'
import type { Attachment, Audit, ProductionLine, Profile, Quantities, Sample, Stage, Status, Style, Workspace } from '../lib/types'
import { blankProduction, blankSample, CHECKS, quantityTotal, ROLE_LABEL, SIZES, STAGE_LABEL, STATUS_LABEL } from '../lib/types'
import StyleImageManager from './StyleImageManager'
import OperationsPanel, { type OperationsPanelProps } from './OperationsPanel'
import OrderSourcePanel, { type OrderSourcePanelProps } from './OrderSourcePanel'
import './style-detail.css'

interface Props extends Pick<OperationsPanelProps, 'onSavePO' | 'onSendPO' | 'onSaveShipment' | 'onSaveOperation'>, Pick<OrderSourcePanelProps, 'onSaveOrderSource'> {
  style: Style
  workspace: Workspace
  profile: Profile
  onClose: () => void
  onSave: (style: Style, reason: string) => Promise<void>
  onDelete: (style: Style, reason: string) => Promise<void>
  onComment: (styleId: string, body: string, sampleId?: string) => Promise<void>
  onUpload: (styleId: string, file: File, sampleId?: string) => Promise<void>
  onDownload: (attachment: Attachment) => Promise<void>
  onSetImage: (styleId: string, color: string, attachmentId: string | null, expectedVersion: number, reason: string) => Promise<void>
  onUploadImage: (styleId: string, color: string, file: File, expectedVersion: number, reason: string) => Promise<void>
}
const copy = <T,>(value: T): T => structuredClone(value)
const timeLabel = (value: string) => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
const sampleLabel = (sample: Sample) => sample.isPP ? 'PP 샘플' : `${sample.round}차 샘플`
const errorText = (error: unknown) => error instanceof Error ? error.message : '처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'
const sampleDates: [keyof Sample, string, boolean][] = [ ['requestedAt', '샘플 요청일', true], ['plannedAt', '제작 예정일', false], ['completedAt', '실제 제작 완료일', false], ['shippedAt', '샘플 발송일', false], ['receivedAt', '본사 입고일', true], ['reviewedAt', '리뷰·컨펌 일자', true] ]
const fieldLabels: Record<string, string> = { code: '품번', name: '스타일명', season: '시즌', category: '카테고리', projectId: '프로젝트', factoryId: '담당 공장', ownerId: '담당자', colors: '컬러', dueDate: '기준 납기', stage: '진행 단계', ppApproved: 'PP 승인', notes: '본사 요청사항', samples: '샘플 이력', production: '메인 생산', deletedAt: '삭제', requestedAt: '요청일', plannedAt: '제작 예정일', completedAt: '제작 완료일', shippedAt: '발송일', receivedAt: '입고일', reviewedAt: '리뷰 일자', status: '상태', request: '수정 요청', factoryComment: '공장 코멘트', tracking: '운송장', order: '오더 수량', packing: '패킹리스트', shipped: '실 출고 수량', received: '실 입고 수량', checks: '공정 체크', confirmDue: '컨펌 예정일', invoice: '세금계산서', invoiceAmount: '정산 금액', paymentDue: '결제 예정일', paymentStatus: '결제 상태', measurements: '사이즈 측정' }

function Field({ label, children, locked = false }: { label: string; children: ReactNode; locked?: boolean }) {
  return <label className="field"><span className="field-label">{label}{locked && <LockKeyhole size={11} aria-label="읽기 전용" />}</span>{children}</label>
}
function StatusSelect({ value, onChange, disabled = false, factory = false, label }: { value: Status; onChange: (value: Status) => void; disabled?: boolean; factory?: boolean; label: string }) {
  return <select aria-label={label} className={`select status-select status-${value}`} value={value} onChange={event => onChange(event.target.value as Status)} disabled={disabled}>
    {Object.entries(STATUS_LABEL).map(([status, text]) => <option key={status} value={status} disabled={factory && status === 'approved'}>{text}</option>)}
  </select>
}
function diffSummary(audit: Audit): string[] {
  const before = audit.before as Record<string, unknown> | null
  const after = audit.after as Record<string, unknown> | null
  if (!after || typeof after !== 'object') return []
  const cleanValue = (value: unknown): string => {
    if (value === null || value === undefined || value === '') return '미기재'
    if (typeof value === 'boolean') return value ? '예' : '아니요'
    if (typeof value === 'object') return '수정됨'
    return String(value)
  }
  const changes: string[] = []
  for (const [key, next] of Object.entries(after)) {
    if (['version', 'updatedAt', 'updatedBy', 'id'].includes(key) || JSON.stringify(before?.[key]) === JSON.stringify(next)) continue
    if ((key === 'samples' || key === 'production') && Array.isArray(next)) {
      const oldItems = Array.isArray(before?.[key]) ? before[key] as Record<string, unknown>[] : []
      for (const item of next as Record<string, unknown>[]) {
        const prior = oldItems.find(old => old.id === item.id)
        const prefix = key === 'samples' ? (item.isPP ? 'PP 샘플' : `${item.round}차 샘플`) : `${item.color} 생산`
        if (!prior) { changes.push(`${prefix} 추가`); continue }
        for (const [childKey, value] of Object.entries(item)) {
          if (childKey === 'updatedAt' || JSON.stringify(prior[childKey]) === JSON.stringify(value)) continue
          changes.push(`${prefix} · ${fieldLabels[childKey] || childKey}: ${cleanValue(prior[childKey])} → ${cleanValue(value)}`)
        }
      }
    } else changes.push(`${fieldLabels[key] || key}: ${cleanValue(before?.[key])} → ${cleanValue(next)}`)
  }
  return changes.slice(0, 20)
}

export default function StyleDetail({ style, workspace, profile, onClose, onSave, onDelete, onComment, onUpload, onDownload, onSetImage, onUploadImage, onSavePO, onSendPO, onSaveShipment, onSaveOperation, onSaveOrderSource }: Props) {
  const [base, setBase] = useState(() => copy(style))
  const [draft, setDraft] = useState(() => copy(style))
  const [tab, setTab] = useState('samples')
  const [infoOpen, setInfoOpen] = useState(false)
  const [activeSample, setActiveSample] = useState(style.samples.at(-1)?.id || '')
  const [activeColor, setActiveColor] = useState(style.production[0]?.id || '')
  const [newColor, setNewColor] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [comment, setComment] = useState('')
  const [scope, setScope] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteReason, setDeleteReason] = useState('')
  const [closeOpen, setCloseOpen] = useState(false)
  const [operationsDirty, setOperationsDirty] = useState(false)
  const [sourceDirty, setSourceDirty] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const hq = profile.role !== 'factory'
  const admin = profile.role === 'admin'
  const dirty = JSON.stringify(draft) !== JSON.stringify(base)
  const hasUnsavedChanges = dirty || operationsDirty || sourceDirty
  const stale = style.version !== base.version
  const line = draft.production.find(item => item.id === activeColor) || draft.production[0]
  const shipmentManaged = !!line && !!workspace.operations?.shipmentLedgers.some(ledger => ledger.styleId === style.id && ledger.lineId === line.id)
  const sample = draft.samples.find(item => item.id === activeSample) || draft.samples.at(-1)
  const sampleEditable = hq || sample?.factoryId === profile.factoryId
  const factoryName = (id: string) => workspace.factories.find(item => item.id === id)?.name || '미배정'
  const ownerName = (id: string) => workspace.profiles.find(item => item.id === id)?.name || '담당자'
  const requestClose = () => hasUnsavedChanges ? setCloseOpen(true) : onClose()

  useEffect(() => {
    if (!hasUnsavedChanges) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [hasUnsavedChanges])

  useEffect(() => {
    if (!dirty && style.version !== base.version) { setBase(copy(style)); setDraft(copy(style)) }
  }, [style, dirty, base.version])
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow; prior?.focus() }
  }, [])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); if (deleteOpen) setDeleteOpen(false); else if (closeOpen) setCloseOpen(false); else requestClose() }
      if (event.key === 'Tab' && panelRef.current) {
        const focusRoot = panelRef.current.querySelector<HTMLElement>('.detail-confirm') || panelRef.current
        const nodes = Array.from(focusRoot.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter(node => node.getClientRects().length > 0 && !node.closest('[hidden], [aria-hidden="true"]'))
        const first = nodes[0], last = nodes[nodes.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  })

  useEffect(() => {
    if (deleteOpen || closeOpen) panelRef.current?.querySelector<HTMLElement>('.detail-confirm textarea, .detail-confirm button')?.focus()
  }, [deleteOpen, closeOpen])

  function update<K extends keyof Style>(key: K, value: Style[K]) {
    setDraft(current => ({ ...current, [key]: value }))
    setSuccess('')
  }
  function updateSample<K extends keyof Sample>(id: string, key: K, value: Sample[K]) {
    setDraft(current => ({ ...current, samples: current.samples.map(item => item.id === id ? { ...item, [key]: value, updatedAt: new Date().toISOString() } : item) }))
    setSuccess('')
  }
  function updateLine<K extends keyof ProductionLine>(key: K, value: ProductionLine[K]) {
    if (!line) return
    setDraft(current => ({ ...current, production: current.production.map(item => item.id === line.id ? { ...item, [key]: value } : item) }))
    setSuccess('')
  }
  function addSample(isPP: boolean) {
    const nextRound = Math.max(0, ...draft.samples.filter(item => !item.isPP).map(item => item.round)) + 1
    const item = blankSample(nextRound, draft.factoryId, draft.ownerId, isPP)
    setDraft(current => ({ ...current, samples: [...current.samples, item] }))
    setActiveSample(item.id); setTab('samples'); setSuccess('')
  }
  function addColor() {
    const color = newColor.trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(color)) { setError('컬러는 BK, OT처럼 영문 두 자리로 입력해 주세요.'); return }
    if (draft.colors.includes(color)) { setError('이미 등록된 컬러입니다.'); return }
    const item = blankProduction(color)
    setDraft(current => ({ ...current, colors: [...current.colors, color], production: [...current.production, item] }))
    setActiveColor(item.id); setNewColor(''); setError('')
  }
  async function save() {
    if (reason.trim().length < 2) { setError('변경 사유를 두 글자 이상 입력해 주세요. 일정 변경 사유도 이력에 보관됩니다.'); return }
    if (!draft.code.trim() || !draft.name.trim() || !draft.factoryId || !draft.projectId || !draft.ownerId || !draft.dueDate || !draft.season.trim()) { setError('품번·스타일명·시즌·프로젝트·공장·담당자·기준 납기를 확인해 주세요.'); setInfoOpen(true); return }
    setBusy(true); setError(''); setSuccess('')
    try { await onSave(draft, reason.trim()); setBase(copy(draft)); setReason(''); setSuccess('변경 내용을 저장했습니다.') }
    catch (err) { setError(errorText(err)) }
    finally { setBusy(false) }
  }
  async function sendComment() {
    if (!comment.trim()) return
    if (scope && !style.samples.some(item => item.id === scope)) { setError('새 샘플 차수를 먼저 변경 저장한 뒤 코멘트를 등록해 주세요.'); return }
    setActionBusy(true); setError('')
    try { await onComment(style.id, comment.trim(), scope || undefined); setComment(''); setSuccess('코멘트를 등록했습니다.') }
    catch (err) { setError(errorText(err)) }
    finally { setActionBusy(false) }
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    event.target.value = ''
    if (scope && !style.samples.some(item => item.id === scope)) { setError('새 샘플 차수를 먼저 변경 저장한 뒤 파일을 첨부해 주세요.'); return }
    if (file.size <= 0 || file.size > 10 * 1024 * 1024) { setError('파일은 10MB 이하로 첨부해 주세요.'); return }
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type)) { setError('JPG, PNG, WEBP 이미지 또는 PDF만 첨부할 수 있습니다.'); return }
    setActionBusy(true); setError('')
    try { await onUpload(style.id, file, scope || undefined); setSuccess('파일을 첨부했습니다.') }
    catch (err) { setError(errorText(err)) }
    finally { setActionBusy(false) }
  }
  async function download(item: Attachment) {
    setActionBusy(true); setError('')
    try { await onDownload(item) } catch (err) { setError(errorText(err)) } finally { setActionBusy(false) }
  }
  async function remove() {
    if (deleteReason.trim().length < 2) { setError('삭제 사유를 두 글자 이상 입력해 주세요.'); return }
    setBusy(true); setError('')
    try { await onDelete(style, deleteReason.trim()); onClose() } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }
  const comments = workspace.comments.filter(item => item.styleId === style.id && (!scope || item.sampleId === scope)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const attachments = workspace.attachments.filter(item => item.styleId === style.id && (!scope || item.sampleId === scope)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const audits = workspace.audits.filter(item => item.styleId === style.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const productionTotal = (key: 'order' | 'shipped' | 'received') => draft.production.reduce((sum, item) => sum + quantityTotal(item[key]), 0)
  const tabs = [ ['samples', '샘플 이력', draft.samples.length], ['production', '메인 생산', draft.production.length], ...(hq ? [['order-source', 'ORDER QTY 원본', workspace.operations?.orderSourceRecords.filter(item => item.styleId === style.id).length || 0] as const] : []), ['operations', '발주·출고·가공', workspace.operations?.shipmentBatches.filter(item => item.styleId === style.id && !item.voided).length || 0], ['comments', '코멘트·파일', workspace.comments.filter(item => item.styleId === style.id).length], ['history', '변경 이력', audits.length] ] as const

  return <div className="detail-overlay" onMouseDown={event => { if (event.target === event.currentTarget) requestClose() }}>
    <div className="detail-panel sig-detail" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={panelRef}>
      <header className="detail-topbar"><button className="button button-ghost" onClick={requestClose}><ArrowLeft size={16} /> 스타일 목록</button><span className="detail-version"><span className="live-dot" /> 버전 {base.version} · {timeLabel(style.updatedAt)} 업데이트</span><button className="icon-button" onClick={requestClose} aria-label="상세 화면 닫기"><X size={20} /></button></header>
      <div className="detail-heading"><div><div className="detail-eyebrow">{draft.season} <span>/</span> {workspace.projects.find(item => item.id === draft.projectId)?.name || '프로젝트 미지정'}</div><h1 id={titleId}>{draft.code}<span>{draft.name}</span></h1><div className="detail-meta"><span>{factoryName(draft.factoryId)}</span><span>담당 {ownerName(draft.ownerId)}</span><span>기준 납기 {draft.dueDate || '미기재'}</span></div></div><div className="detail-title-actions"><span className={`badge status-${draft.stage === 'approved' ? 'approved' : 'progress'}`}>{STAGE_LABEL[draft.stage]}</span><button className="button button-ghost" onClick={() => setInfoOpen(!infoOpen)} aria-expanded={infoOpen}>기본 정보<ChevronDown size={15} /></button></div></div>
      {stale && <div className="detail-notice warning" role="status"><History size={16} /><div><strong>다른 사용자가 이 스타일을 수정했습니다.</strong><p>현재 입력 내용은 유지됩니다. 최신 내용을 불러온 뒤 변경 사항을 다시 적용해 주세요.</p></div><button className="button" onClick={() => { setDraft(copy(style)); setBase(copy(style)); setError(''); setReason('') }}>최신 내용 불러오기</button></div>}
      {error && <div className="error-message" role="alert">{error}<button className="icon-button" onClick={() => setError('')} aria-label="오류 안내 닫기"><X size={14} /></button></div>}
      {success && <div className="success-message" role="status"><Check size={15} /> {success}</div>}
      <div className="detail-scroll">
        <StyleImageManager style={style} workspace={workspace} profile={profile} onSetImage={onSetImage} onUploadImage={onUploadImage} />
        {infoOpen && <section className="detail-info panel"><div className="section-heading"><h2>스타일 기본 정보</h2>{!hq && <span className="muted"><LockKeyhole size={12} /> 본사 관리 항목</span>}</div><div className="form-grid">
          <Field label="스타일 품번" locked={!hq}><input className="input" aria-label="스타일 품번" value={draft.code} maxLength={60} onChange={event => update('code', event.target.value.toUpperCase())} disabled={!hq} /></Field>
          <Field label="스타일명" locked={!hq}><input className="input" value={draft.name} maxLength={120} onChange={event => update('name', event.target.value)} disabled={!hq} /></Field>
          <Field label="시즌 / 연도" locked={!hq}><input className="input" value={draft.season} placeholder="2026FW" maxLength={30} onChange={event => update('season', event.target.value)} disabled={!hq} /></Field>
          <Field label="카테고리" locked={!hq}><input className="input" value={draft.category} maxLength={50} onChange={event => update('category', event.target.value)} disabled={!hq} /></Field>
          <Field label="프로젝트" locked={!hq}><select className="select" value={draft.projectId} onChange={event => update('projectId', event.target.value)} disabled={!hq}>{workspace.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label="담당 공장" locked={!hq}><select className="select" value={draft.factoryId} onChange={event => { const factoryId = event.target.value; setDraft(current => ({ ...current, factoryId })) }} disabled={!hq}>{workspace.factories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label="본사 담당자" locked={!hq}><select className="select" value={draft.ownerId} onChange={event => update('ownerId', event.target.value)} disabled={!hq}>{workspace.profiles.filter(item => item.role !== 'factory' && item.active && item.approved).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label="기준 납기" locked={!hq}><input className="input" type="date" value={draft.dueDate} onChange={event => update('dueDate', event.target.value)} disabled={!hq} /></Field>
          <Field label="전체 진행 단계" locked={!hq}><select className="select" value={draft.stage} onChange={event => update('stage', event.target.value as Stage)} disabled={!hq}>{Object.entries(STAGE_LABEL).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></Field>
          <Field label="PP 샘플 최종 승인" locked={!hq}><select className="select" value={draft.ppApproved ? 'yes' : 'no'} onChange={event => update('ppApproved', event.target.value === 'yes')} disabled={!hq}><option value="no">미승인</option><option value="yes">승인 완료</option></select></Field>
        </div><Field label="본사 요청사항" locked={!hq}><textarea className="textarea" rows={3} maxLength={10000} value={draft.notes} onChange={event => update('notes', event.target.value)} disabled={!hq} /></Field><div className="detail-colors"><span className="field-label">컬러 / 자동 품번</span>{draft.colors.map(color => <span className="pill" key={color}>{draft.code}{color}</span>)}{hq && <div className="color-add"><input className="input" aria-label="새 컬러 코드" value={newColor} maxLength={2} placeholder="BK" onChange={event => setNewColor(event.target.value.toUpperCase())} /><button className="button" onClick={addColor}><Plus size={13} /> 컬러 추가</button></div>}</div></section>}
        <div className="detail-summary-strip"><div><span>오더 수량</span><strong>{productionTotal('order').toLocaleString()}<small>pcs</small></strong></div><div><span>실 출고 수량</span><strong>{productionTotal('shipped').toLocaleString()}<small>pcs</small></strong></div><div><span>실 입고 수량</span><strong>{productionTotal('received').toLocaleString()}<small>pcs</small></strong></div><div><span>PP 샘플</span><strong className={draft.ppApproved ? 'text-green' : ''}>{draft.ppApproved ? '승인 완료' : '승인 대기'}</strong></div></div>
        <div className="tab-bar" role="tablist" aria-label="스타일 상세 메뉴">{tabs.map(([key, text, count]) => <button className={`tab ${tab === key ? 'active' : ''}`} key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{text}<span className="tab-count">{count}</span></button>)}</div>
        {tab === 'samples' && <section className="detail-section" role="tabpanel" aria-label="샘플 이력"><div className="section-heading"><div><h2>차수별 샘플 진행</h2><p className="muted">1차부터 최종 PP 샘플까지, 모든 이력이 누적됩니다.</p></div>{hq && <div className="inline-actions"><button className="button" onClick={() => addSample(false)}><Plus size={14} /> 차수 추가</button><button className="button" onClick={() => addSample(true)}><Plus size={14} /> PP 샘플</button></div>}</div>
          {!draft.samples.length ? <div className="empty-state"><Package size={30} /><strong>아직 등록된 샘플이 없습니다.</strong><span>샘플 차수를 추가해 제작 일정을 관리하세요.</span></div> : <div className="sample-layout"><nav className="sample-timeline" aria-label="샘플 차수">{draft.samples.map((item, index) => <button key={item.id} className={`sample-step ${sample?.id === item.id ? 'active' : ''}`} onClick={() => setActiveSample(item.id)}><span className={`step-number ${item.status === 'approved' || item.status === 'done' ? 'complete' : ''}`}>{item.status === 'approved' || item.status === 'done' ? <Check size={13} /> : String(index + 1).padStart(2, '0')}</span><span><strong>{sampleLabel(item)}</strong><small>{item.plannedAt || '예정일 미기재'}</small></span><span className={`sample-status-dot status-${item.status}`} /></button>)}</nav>
          {sample && <div className="sample-editor panel"><div className="section-heading"><h3>{sampleLabel(sample)}<span className={`badge status-${sample.status}`}>{STATUS_LABEL[sample.status]}</span></h3><button className="button button-ghost" onClick={() => { setScope(sample.id); setTab('comments') }}><MessageSquare size={14} /> 코멘트·사진<ArrowUpRight size={13} /></button></div><div className="form-grid">
            <Field label="진행 상태" locked={!sampleEditable || !hq && sample.status === 'approved'}><StatusSelect label={`${sampleLabel(sample)} 진행 상태`} value={sample.status} onChange={value => updateSample(sample.id, 'status', value)} factory={!hq} disabled={!sampleEditable || !hq && sample.status === 'approved'} /></Field>
            <Field label="담당 공장" locked={!hq}><select className="select" value={sample.factoryId} disabled={!hq} onChange={event => updateSample(sample.id, 'factoryId', event.target.value)}>{workspace.factories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}{!workspace.factories.some(item => item.id === sample.factoryId) && <option value={sample.factoryId}>이전 담당 공장</option>}</select></Field>
            <Field label="샘플 담당자" locked={!hq}><select className="select" value={sample.ownerId} disabled={!hq} onChange={event => updateSample(sample.id, 'ownerId', event.target.value)}>{workspace.profiles.filter(item => item.role !== 'factory' && item.active && item.approved).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
            {sampleDates.map(([key, text, restricted]) => <Field key={key} label={text} locked={!sampleEditable || restricted && !hq}><input className="input" type="date" value={String(sample[key])} disabled={!sampleEditable || restricted && !hq} onChange={event => updateSample(sample.id, key, event.target.value)} /></Field>)}
            <Field label="운송장 번호"><input className="input" value={sample.tracking} disabled={!sampleEditable} maxLength={120} placeholder="택배사 / 운송장 번호" onChange={event => updateSample(sample.id, 'tracking', event.target.value)} /></Field>
          </div><Field label="본사 리뷰·수정 요청사항" locked={!hq}><textarea className="textarea" rows={4} value={sample.request} maxLength={10000} disabled={!hq} placeholder="치수, 패턴, 컬러 등 수정 요청을 입력하세요." onChange={event => updateSample(sample.id, 'request', event.target.value)} /></Field><Field label="공장 진행 코멘트"><textarea className="textarea" rows={3} value={sample.factoryComment} disabled={!sampleEditable} maxLength={10000} placeholder="작업 진행 현황과 확인 사항을 기록하세요." onChange={event => updateSample(sample.id, 'factoryComment', event.target.value)} /></Field><div className="detail-small-note"><Clock3 size={12} /> 최종 수정 {timeLabel(sample.updatedAt)} · 승인 및 본사 요청은 본사 권한으로만 변경할 수 있습니다.</div></div>}</div>}
        </section>}
        {tab === 'production' && <section className="detail-section" role="tabpanel" aria-label="메인 생산"><div className="section-heading"><div><h2>컬러별 메인 생산</h2><p className="muted">공정 확인부터 수량·출입고·업체 결제 마감까지 관리합니다.</p></div><span className="detail-small-note"><ShieldCheck size={14} /> 출고: 공장·관리자 / 입고 수량: 관리자</span></div><div className="production-colors">{draft.production.map(item => <button key={item.id} className={`production-color ${line?.id === item.id ? 'active' : ''}`} onClick={() => setActiveColor(item.id)}><strong>{item.color}</strong><span>{draft.code}{item.color}</span><small>{quantityTotal(item.order).toLocaleString()} pcs</small></button>)}</div>
          {!line ? <div className="empty-state">기본 정보에서 컬러를 추가해 주세요.</div> : <><div className="panel production-checks"><div className="section-heading"><h3>생산 공정 체크리스트</h3><span className="muted">본사 컨펌 항목</span></div><div className="checklist-grid">{CHECKS.map(([key, text], index) => <Field key={key} label={`${String(index + 1).padStart(2, '0')}  ${text}`} locked={!hq}><StatusSelect label={`${line.color} ${text}`} value={line.checks[key]} disabled={!hq} onChange={value => updateLine('checks', { ...line.checks, [key]: value })} /></Field>)}</div></div>
          <div className="panel quantity-panel"><div className="section-heading"><h3>사이즈별 수량</h3><span className="muted">XXS — XL · 6 sizes</span></div><div className="table-wrap"><table className="data-table quantity-table"><thead><tr><th>구분</th>{SIZES.map(size => <th key={size}>{size}</th>)}<th>합계</th></tr></thead><tbody>{(['order', 'packing', 'shipped', 'received'] as const).map(key => {
            const editable = key === 'received' ? admin : key === 'shipped' ? !shipmentManaged && (admin || !hq) : hq
            const labels = { order: '오더 수량', packing: '패킹리스트', shipped: '실 출고 수량', received: '실 입고 수량' }
            return <tr key={key}><th>{labels[key]}{!editable && <LockKeyhole size={11} />}</th>{SIZES.map(size => <td key={size}><input className="input" type="number" min="0" max="10000000" step="1" aria-label={`${line.color} ${labels[key]} ${size}`} value={line[key][size]} disabled={!editable} onChange={event => { const value = event.target.valueAsNumber; updateLine(key, { ...line[key], [size]: Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0 } as Quantities) }} /></td>)}<td><strong>{quantityTotal(line[key]).toLocaleString()}</strong></td></tr>
          })}<tr className="variance-row"><th>출고 대비 미입고</th>{SIZES.map(size => <td key={size}>{(line.shipped[size] - line.received[size]).toLocaleString()}</td>)}<td><strong>{(quantityTotal(line.shipped) - quantityTotal(line.received)).toLocaleString()}</strong></td></tr></tbody></table></div></div>
          <div className="panel"><div className="section-heading"><h3>출입고 및 정산</h3><span className="muted">컬러별 일정과 업체 마감 내역</span></div><div className="form-grid">
            <Field label="메인 컨펌 예정일"><input className="input" type="date" value={line.confirmDue} onChange={event => updateLine('confirmDue', event.target.value)} /></Field>
            <Field label={shipmentManaged ? '실 출고 일자 · 차수 합산' : '실 출고 일자'} locked={shipmentManaged}><input className="input" type="date" value={line.shippedAt} disabled={shipmentManaged} onChange={event => updateLine('shippedAt', event.target.value)} /></Field>
            <Field label="실 입고 일자"><input className="input" type="date" value={line.receivedAt} onChange={event => updateLine('receivedAt', event.target.value)} /></Field>
            <Field label="세금계산서 발행"><StatusSelect label="세금계산서 발행" value={line.invoice} onChange={value => updateLine('invoice', value)} /></Field>
            {hq && <><Field label="업체 마감 금액 (KRW)"><input className="input" type="number" min="0" max="1000000000000" step="1" value={line.invoiceAmount} onChange={event => updateLine('invoiceAmount', Math.max(0, Math.floor(event.target.valueAsNumber || 0)))} /></Field><Field label="결제 예정일"><input className="input" type="date" value={line.paymentDue} onChange={event => updateLine('paymentDue', event.target.value)} /></Field><Field label="결제 상태"><StatusSelect label="결제 상태" value={line.paymentStatus} onChange={value => updateLine('paymentStatus', value)} /></Field></>}
          </div><Field label="메인 제품 사이즈 측정"><textarea className="textarea" rows={4} value={line.measurements} maxLength={10000} placeholder="예: M / 총장 68cm, 가슴 58cm, 소매 62cm" onChange={event => updateLine('measurements', event.target.value)} /></Field><Field label="공장 작업 코멘트"><textarea className="textarea" rows={3} value={line.factoryComment} maxLength={10000} placeholder="생산 및 출고 관련 확인 사항" onChange={event => updateLine('factoryComment', event.target.value)} /></Field></div></>}
        </section>}
        {hq && <div hidden={tab !== 'order-source'} role="tabpanel" aria-label="ORDER QTY 원본"><OrderSourcePanel style={style} workspace={workspace} profile={profile} onSaveOrderSource={onSaveOrderSource} onDirtyChange={setSourceDirty} onEditQuantities={lineId => { setActiveColor(lineId); setTab('production') }} /></div>}
        <div hidden={tab !== 'operations'} role="tabpanel" aria-label="발주·출고·가공"><OperationsPanel style={style} workspace={workspace} profile={profile} onDirtyChange={setOperationsDirty} onSavePO={onSavePO} onSendPO={onSendPO} onSaveShipment={onSaveShipment} onSaveOperation={onSaveOperation} onDownload={onDownload} /></div>
        {tab === 'comments' && <section className="detail-section" role="tabpanel" aria-label="코멘트 및 파일"><div className="section-heading"><div><h2>함께 확인하고 기록하세요</h2><p className="muted">본사와 담당 공장의 코멘트 및 첨부파일을 공유합니다.</p></div><select className="select comment-scope" aria-label="코멘트 차수 필터" value={scope} onChange={event => setScope(event.target.value)}><option value="">전체 / 스타일 공통</option>{draft.samples.map(item => <option key={item.id} value={item.id}>{sampleLabel(item)}</option>)}</select></div><div className="collaboration-grid"><div className="panel comment-panel"><h3><MessageSquare size={16} /> 코멘트 <span>{comments.length}</span></h3><div className="comment-list">{!comments.length && <div className="empty-state">아직 코멘트가 없습니다.<br />첫 진행 상황을 공유해 주세요.</div>}{comments.map(item => <article className="comment-item" key={item.id}><div className="comment-avatar">{item.authorName.slice(0, 1)}</div><div><header><strong>{item.authorName}</strong><time>{timeLabel(item.createdAt)}</time></header>{item.sampleId && <span className="comment-sample">{draft.samples.find(sample => sample.id === item.sampleId) ? sampleLabel(draft.samples.find(sample => sample.id === item.sampleId)!) : '샘플'}</span>}<p>{item.body}</p></div></article>)}</div><form className="comment-compose" onSubmit={event => { event.preventDefault(); void sendComment() }}><textarea className="textarea" aria-label="코멘트 작성" placeholder="전달할 내용이나 확인 사항을 남겨 주세요." rows={3} maxLength={5000} value={comment} onChange={event => setComment(event.target.value)} /><div><span className="muted">{profile.name} · {ROLE_LABEL[profile.role]}</span><button className="button button-primary" type="submit" disabled={actionBusy || !comment.trim()}><Send size={13} /> 등록</button></div></form></div><div className="panel file-panel"><div className="section-heading"><h3><Paperclip size={16} /> 첨부파일 <span>{attachments.length}</span></h3><button className="button" disabled={actionBusy} onClick={() => uploadRef.current?.click()}><Plus size={14} /> 파일 첨부</button><input ref={uploadRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" aria-label="샘플 사진 또는 PDF 첨부" onChange={event => void upload(event)} /></div><p className="detail-small-note">사진 JPG·PNG·WEBP / PDF · 파일당 최대 10MB<br /><LockKeyhole size={11} /> 이 스타일에 배정된 사용자만 열람할 수 있습니다.</p><div className="file-list">{!attachments.length && <div className="file-empty"><FileImage size={34} /><span>샘플 사진과 작업 파일을 첨부해 주세요.</span></div>}{attachments.map(item => <button key={item.id} className="file-item" disabled={actionBusy} onClick={() => void download(item)}>{item.mime.startsWith('image/') ? <FileImage size={22} /> : <FileText size={22} />}<span><strong>{item.name}</strong><small>{(item.size / 1024).toFixed(0)} KB · {timeLabel(item.createdAt)}</small></span><ArrowUpRight size={15} /></button>)}</div></div></div></section>}
        {tab === 'history' && <section className="detail-section" role="tabpanel" aria-label="변경 이력"><div className="section-heading"><div><h2>변경 이력</h2><p className="muted">변경 내용, 수정자, 일정 변경 사유가 원본과 함께 보관됩니다.</p></div><span className="pill"><History size={12} /> {audits.length}건</span></div>{!audits.length ? <div className="empty-state"><History size={28} /> 아직 변경 이력이 없습니다.</div> : <div className="audit-timeline">{audits.map(item => <article className="audit-item" key={item.id}><span className="audit-dot" /><header><strong>{item.actorName || '사용자'}</strong><span className="pill">{{ create: '스타일 등록', update: '스타일 수정', delete: '스타일 삭제' }[item.action] || item.action}</span><time>{timeLabel(item.createdAt)}</time></header>{item.reason && <p className="audit-reason">{item.reason}</p>}<ul>{diffSummary(item).map((text, index) => <li key={index}>{text}</li>)}</ul><details><summary>원본 변경 내역 보기 <ChevronRight size={12} /></summary><pre>{JSON.stringify({ before: item.before, after: item.after }, null, 2)}</pre></details></article>)}</div>}</section>}
      </div>
      <footer className="detail-footer">{admin && <button className="button button-ghost delete-button" onClick={() => setDeleteOpen(true)} disabled={busy}><Trash2 size={15} /> 삭제</button>}<div className="save-reason"><label htmlFor={`${titleId}-reason`}>변경 사유</label><input id={`${titleId}-reason`} className="input" aria-label="변경 사유" placeholder="변경 또는 일정 조정 사유를 기록하세요" maxLength={500} value={reason} onChange={event => setReason(event.target.value)} disabled={busy} /></div><button className="button button-primary" onClick={() => void save()} disabled={!dirty || busy || stale}><Save size={15} />{busy ? '저장 중…' : '변경 저장'}{dirty && <span className="unsaved-dot" />}</button></footer>
      {(deleteOpen || closeOpen) && <div className="detail-confirm-overlay"><section className="detail-confirm" role="alertdialog" aria-modal="true" aria-labelledby={`${titleId}-confirm`}><h2 id={`${titleId}-confirm`}>{deleteOpen ? '스타일을 삭제할까요?' : '저장하지 않은 변경 내용이 있습니다.'}</h2><p>{deleteOpen ? '목록에서 숨겨지며, 삭제 사유와 변경 이력은 계속 보관됩니다.' : '입력한 내용을 유지하려면 편집을 계속하고 저장해 주세요.'}</p>{deleteOpen && <Field label="삭제 사유"><textarea autoFocus className="textarea" rows={3} maxLength={500} value={deleteReason} onChange={event => setDeleteReason(event.target.value)} /></Field>}<div className="inline-actions"><button className="button" onClick={() => { setDeleteOpen(false); setCloseOpen(false) }}>편집 계속</button><button className="button button-primary" disabled={busy || (deleteOpen && deleteReason.trim().length < 2)} onClick={() => deleteOpen ? void remove() : onClose()}>{deleteOpen ? '삭제 및 이력 보관' : '저장하지 않고 닫기'}</button></div></section></div>}
    </div>
  </div>
}
