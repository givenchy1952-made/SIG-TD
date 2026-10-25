import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Check, Eye, History, LockKeyhole, Save, ShieldCheck, Trash2, X } from 'lucide-react'
import type { Profile, Workspace } from '../lib/types'
import type { CalendarEvent, CalendarEventKind } from '../lib/operations-types'
import { localDate, message } from '../lib/utils'
import { LEAVE_LABELS, validateLeave, type LeaveType } from '../lib/workflow-refinements'
import './calendar-events.css'

export const CALENDAR_KIND_LABEL: Record<CalendarEventKind, string> = { personal_leave: '개인 휴가', launch: '제품 런칭', factory_holiday: '협력업체 휴가' }
export function canViewCalendarEvent(event: CalendarEvent, profile: Profile): boolean {
  if (!profile.approved || !profile.active || event.deletedAt) return false
  if (event.kind === 'factory_holiday') return profile.role !== 'factory'
  if (event.kind === 'launch') return true
  return event.visibility === 'private' && event.ownerId === profile.id || event.visibility === 'hq' && profile.role !== 'factory'
}
export function canEditCalendarEvent(event: CalendarEvent, profile: Profile): boolean {
  if (!canViewCalendarEvent(event, profile)) return false
  if (event.kind !== 'personal_leave') return profile.role !== 'factory'
  return event.ownerId === profile.id || event.visibility === 'hq' && profile.role === 'admin'
}
type CalendarWorkspace = Workspace
interface Props { event: CalendarEvent | null; initialDate: string; workspace: CalendarWorkspace; profile: Profile; onClose: () => void; onSave: (event: CalendarEvent, reason: string) => Promise<void>; onDelete: (event: CalendarEvent, reason: string) => Promise<void> }
const createEvent = (profile: Profile, date: string, refinements: boolean): CalendarEvent => ({ ...(refinements ? { leaveType: 'full' as const, startTime: '', endTime: '' } : {}), id: crypto.randomUUID(), kind: 'personal_leave', title: '', startDate: date, endDate: date, ownerId: profile.id, factoryId: null, visibility: 'private', note: '', deletedAt: null, version: 0, createdAt: '', updatedAt: '', updatedBy: profile.id })
const twoHoursAfter = (value: string): string => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return ''
  const end = Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) + 120
  return end < 1440 ? `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}` : ''
}
const formatTime = (date: string) => date ? new Date(date).toLocaleString('ko-KR') : '아직 저장 전'

export default function CalendarEventEditor({ event, initialDate, workspace, profile, onClose, onSave, onDelete }: Props) {
  const refinementsAvailable = workspace.refinementsAvailable === true
  const normalize = (value: CalendarEvent): CalendarEvent => refinementsAvailable ? { ...structuredClone(value), leaveType: value.leaveType || 'full', startTime: value.startTime || '', endTime: value.endTime || '' } : structuredClone(value)
  const [draft, setDraft] = useState(() => event ? normalize(event) : createEvent(profile, initialDate || localDate(), refinementsAvailable))
  const originalDraft = useRef(draft)
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [discardConfirm, setDiscardConfirm] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const isNew = draft.version === 0
  const canEdit = !event || canEditCalendarEvent(event, profile)
  const stale = !!event && event.version !== draft.version
  const deleted = !!event?.deletedAt
  const dirty = JSON.stringify(draft) !== JSON.stringify(originalDraft.current) || !!reason
  const close = () => { if (busy) return; if (canEdit && dirty) setDiscardConfirm(true); else onClose() }
  useEffect(() => { if (canEdit) titleRef.current?.focus(); else dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [canEdit])
  useEffect(() => {
    const handle = (key: KeyboardEvent) => {
      if (key.key === 'Escape') { key.preventDefault(); if (busy) return; if (discardConfirm) setDiscardConfirm(false); else if (deleteConfirm) setDeleteConfirm(false); else if (canEdit && dirty) setDiscardConfirm(true); else onClose() }
      if (key.key === 'Tab' && dialogRef.current) { const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter(item => item.offsetParent !== null); const first = items[0], last = items[items.length - 1]; if (key.shiftKey && document.activeElement === first) { key.preventDefault(); last?.focus() } else if (!key.shiftKey && document.activeElement === last) { key.preventDefault(); first?.focus() } }
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [busy, canEdit, dirty, discardConfirm, deleteConfirm, onClose])
  const updateKind = (kind: CalendarEventKind) => setDraft(current => ({ ...current, ...(refinementsAvailable ? { leaveType: 'full' as const, startTime: '', endTime: '' } : {}), kind, factoryId: kind === 'factory_holiday' ? current.factoryId : null, visibility: kind === 'launch' ? 'all' : kind === 'factory_holiday' ? 'hq' : 'private' }))
  const updateLeave = (leaveType: LeaveType) => setDraft(current => ({ ...current, leaveType, endDate: leaveType === 'full' ? current.endDate : current.startDate, startTime: leaveType === 'two_hours' ? current.startTime || '' : '', endTime: leaveType === 'two_hours' ? twoHoursAfter(current.startTime || '') : '' }))
  const partialLeave = draft.kind === 'personal_leave' && !!draft.leaveType && draft.leaveType !== 'full'
  const submit = async (remove = false) => {
    setError('')
    if (!canEdit || deleted) { setError('이 일정을 변경할 권한이 없습니다.'); return }
    if (!reason.trim() || reason.trim().length < 2) { setError('변경 사유를 두 글자 이상 입력해 주세요.'); return }
    if (reason.length > 1000) { setError('변경 사유는 1,000자까지 입력할 수 있습니다.'); return }
    if (!remove && (!draft.title.trim() || !draft.startDate || !draft.endDate)) { setError('일정명과 시작일·종료일을 입력해 주세요.'); return }
    if (draft.startDate > draft.endDate) { setError('종료일은 시작일 이후로 선택해 주세요.'); return }
    if (draft.kind === 'factory_holiday' && !draft.factoryId) { setError('휴가에 해당하는 협력 공장을 선택해 주세요.'); return }
    if (!remove) { try { validateLeave(draft) } catch (error) { setError(message(error)); return } }
    setBusy(true)
    try {
      if (remove) await onDelete(draft, reason.trim())
      else await onSave({ ...draft, title: draft.title.trim(), note: draft.note.trim() }, reason.trim())
      onClose()
    } catch (err) { setError(message(err)); setDeleteConfirm(false) } finally { setBusy(false) }
  }
  const owner = workspace.profiles.find(item => item.id === draft.ownerId)
  const audits = (workspace.operations?.calendarEventAudits || []).filter(audit => audit.eventId === draft.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const visibilityLabel = draft.visibility === 'private' ? '나만 보기' : draft.visibility === 'hq' ? '본사 공유 · 외부 공장 비공개' : '전체 공유 · 승인된 구성원'
  return <div className="calendar-editor-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}><section className="calendar-editor" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="calendar-event-heading"><header><div className="calendar-editor-title"><CalendarDays size={20}/><div><p className="eyebrow">WORKSPACE SCHEDULE</p><h2 id="calendar-event-heading">{isNew ? '일정 등록' : canEdit ? '일정 상세 및 수정' : '일정 상세'}</h2></div></div><button className="icon-button" aria-label="일정 창 닫기" disabled={busy} onClick={close}><X size={19}/></button></header>
    <form onSubmit={event => { event.preventDefault(); void submit() }}>
      <div className="calendar-editor-body">
        {deleted && <div className="error-message" role="alert">이 일정은 다른 사용자가 삭제했습니다. 과거 편집 내용은 저장할 수 없습니다.</div>}
        {stale && !deleted && <div className="calendar-version-warning" role="status"><strong>다른 사용자가 이 일정을 변경했습니다.</strong><p>내 편집 내용을 복사해 둔 뒤 최신 일정을 불러와 다시 반영하세요. 현재 초안은 자동으로 덮어쓰지 않습니다.</p><button type="button" className="button button-ghost" disabled={busy} onClick={() => { if (event) { const latest = normalize(event); originalDraft.current = latest; setDraft(latest); setError(''); setReason('') } }}>내 편집을 버리고 최신 일정 불러오기</button></div>}
        <div className="calendar-event-type-bar"><span className={`calendar-kind-badge kind-${draft.kind}`}>{CALENDAR_KIND_LABEL[draft.kind]}</span><span className="calendar-privacy"><LockKeyhole size={12}/>{visibilityLabel}</span></div>
        <fieldset disabled={!canEdit || busy || deleted} className="calendar-editor-fields">
          <label className="field"><span className="field-label">일정 유형</span><select className="select" aria-label="일정 유형" value={draft.kind} disabled={!isNew || busy || !canEdit} onChange={event => updateKind(event.target.value as CalendarEventKind)}><option value="personal_leave">개인 휴가</option>{profile.role !== 'factory' && <><option value="launch">제품 런칭</option><option value="factory_holiday">협력업체 휴가</option></>}</select>{!isNew && <small className="muted">유형과 일정 소유자는 등록 후 변경할 수 없습니다.</small>}</label>
          <label className="field"><span className="field-label">일정명</span><input ref={titleRef} className="input" aria-label="일정명" required maxLength={160} placeholder={draft.kind === 'personal_leave' ? '예: 연차 휴가' : draft.kind === 'launch' ? '예: 27SS 컬렉션 런칭' : '예: 설 연휴 공장 휴무'} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })}/></label>
          {draft.kind === 'personal_leave' && <div className="calendar-leave-section"><label className="field"><span className="field-label">휴가 구분</span><select className="select" aria-label="휴가 구분" value={draft.leaveType || 'full'} disabled={!refinementsAvailable || !canEdit || busy || deleted} onChange={event => updateLeave(event.target.value as LeaveType)}>{Object.entries(LEAVE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{!refinementsAvailable && <p className="calendar-leave-help">반차·반반차는 관리자가 005 추가 SQL을 적용한 뒤 사용할 수 있습니다. 종일 휴가는 기존대로 등록할 수 있습니다.</p>}{partialLeave && <p className="calendar-leave-help">반차·반반차는 시작일 하루에 등록합니다.{draft.leaveType !== 'two_hours' && ' 회사의 오전·오후 구분으로 기록하며 고정 근무시간을 임의로 지정하지 않습니다.'}</p>}</div>}
          <div className="calendar-date-fields"><label className="field"><span className="field-label">시작일</span><input className="input" type="date" aria-label="일정 시작일" required value={draft.startDate} onChange={event => setDraft({ ...draft, startDate: event.target.value, endDate: partialLeave || !draft.endDate || draft.endDate < event.target.value ? event.target.value : draft.endDate })}/></label><label className="field"><span className="field-label">종료일 (당일 포함)</span><input className="input" type="date" aria-label="일정 종료일" required min={draft.startDate} value={draft.endDate} disabled={partialLeave} onChange={event => setDraft({ ...draft, endDate: event.target.value })}/></label></div>
          {draft.kind === 'personal_leave' && draft.leaveType === 'two_hours' && <div className="calendar-leave-section"><div className="calendar-date-fields"><label className="field"><span className="field-label">반반차 시작 시간</span><input className="input" type="time" aria-label="반반차 시작 시간" required max="21:59" step="60" value={draft.startTime || ''} onChange={event => setDraft({ ...draft, startTime: event.target.value, endTime: twoHoursAfter(event.target.value) })}/></label><label className="field"><span className="field-label">반반차 종료 시간 · 2시간 후</span><input className="input" type="time" aria-label="반반차 종료 시간" value={draft.endTime || ''} readOnly /></label></div><p className="calendar-leave-help">시작 시간을 선택하면 종료 시간이 정확히 2시간 뒤로 계산됩니다. 자정을 넘기는 일정은 등록할 수 없습니다.</p></div>}
          {draft.kind === 'factory_holiday' && <label className="field"><span className="field-label">협력 공장</span><select className="select" aria-label="휴가 공장" required value={draft.factoryId || ''} onChange={event => setDraft({ ...draft, factoryId: event.target.value || null })}><option value="">공장 선택</option>{workspace.factories.map(factory => <option key={factory.id} value={factory.id}>{factory.name}</option>)}</select></label>}
          {draft.kind === 'personal_leave' && profile.role !== 'factory' && <label className="field"><span className="field-label">공개 범위</span><select className="select" aria-label="휴가 공개 범위" value={draft.visibility} onChange={event => setDraft({ ...draft, visibility: event.target.value as CalendarEvent['visibility'] })}><option value="private">나만 보기</option><option value="hq">본사 구성원과 공유</option></select></label>}
          <label className="field"><span className="field-label">메모</span><textarea className="textarea" aria-label="일정 메모" rows={3} maxLength={5000} placeholder="일정에 필요한 내용을 기록하세요." value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })}/></label>
        </fieldset>
        {draft.kind === 'factory_holiday' ? <div className="calendar-access-note"><ShieldCheck size={15}/><p>협력업체 휴가 일정과 메모는 본사 구성원만 볼 수 있습니다. 외부 공장의 캘린더와 알림에는 표시되지 않습니다.</p></div> : draft.kind === 'personal_leave' ? <div className="calendar-access-note"><LockKeyhole size={15}/><p>{draft.visibility === 'private' ? '비공개 개인 휴가는 본인에게만 표시됩니다. 관리자도 다른 사람의 비공개 휴가를 열람할 수 없습니다.' : '본사 공유 휴가는 본사 구성원만 조회합니다. 수정·삭제는 본인 또는 관리자가 처리합니다.'}</p></div> : <div className="calendar-access-note"><Eye size={15}/><p>제품 런칭 일정은 승인된 본사·공장 구성원에게 공유됩니다. 본사 구성원만 수정할 수 있습니다.</p></div>}
        <div className="calendar-editor-meta"><span>등록자 {owner?.name || (draft.ownerId === profile.id ? profile.name : '구성원')}</span><span>버전 {draft.version} · {formatTime(draft.updatedAt)}</span></div>
        {canEdit && !deleted && <label className="field calendar-reason-field"><span className="field-label">{isNew ? '등록' : '변경·삭제'} 사유 <span className="required">*</span></span><input className="input" aria-label="일정 변경 사유" required minLength={2} maxLength={1000} placeholder="예: 런칭 확정 / 공장 휴무 일정 변경" value={reason} disabled={busy} onChange={event => setReason(event.target.value)}/></label>}
        {!isNew && <details className="calendar-event-history"><summary><History size={14}/>변경 이력 <span>{audits.length}건</span></summary><p className="muted">현재 일정 공개 범위에 따라 조회할 수 있는 이력만 표시합니다.</p>{audits.length ? audits.map(audit => <article key={audit.id}><strong>{audit.actorName} · {audit.action}</strong><time>{formatTime(audit.createdAt)}</time><p>{audit.reason}</p><details><summary>변경 전후 확인</summary><div className="calendar-audit-snapshots"><pre>{JSON.stringify(audit.before, null, 2)}</pre><pre>{JSON.stringify(audit.after, null, 2)}</pre></div></details></article>) : <div className="calendar-history-note">아직 표시할 변경 이력이 없습니다.</div>}</details>}
        {deleteConfirm && <div className="calendar-delete-confirm" role="alert"><strong>이 일정을 삭제하시겠습니까?</strong><p>캘린더에서 제외되며 변경 이력은 보존됩니다. 위에 입력한 사유로 삭제합니다.</p><div><button type="button" className="button" disabled={busy} onClick={() => setDeleteConfirm(false)}>계속 편집</button><button type="button" className="button calendar-danger-button" disabled={busy || reason.trim().length < 2} onClick={() => void submit(true)}><Trash2 size={14}/>사유를 기록하고 삭제</button></div></div>}
        {discardConfirm && <div className="calendar-discard-confirm" role="alert"><strong>저장하지 않은 편집 내용이 있습니다.</strong><div><button type="button" className="button" onClick={() => setDiscardConfirm(false)}>계속 작성</button><button type="button" className="button button-primary" onClick={onClose}>편집을 버리고 닫기</button></div></div>}
        {error && <div className="error-message" role="alert">{error}</div>}
      </div>
      <footer>{!isNew && canEdit && !deleted && <button type="button" className="button button-ghost calendar-delete-button" disabled={busy || stale} onClick={() => { setDeleteConfirm(true); setDiscardConfirm(false) }}><Trash2 size={14}/>일정 삭제</button>}<span/>{canEdit && !deleted ? <><button type="button" className="button" disabled={busy} onClick={close}>취소</button><button className="button button-primary" disabled={busy || stale || deleteConfirm} type="submit"><Save size={14}/>{busy ? '저장 중…' : isNew ? '일정 등록' : '변경 저장'}</button></> : <button type="button" className="button button-primary" onClick={onClose}><Check size={14}/>확인</button>}</footer>
    </form>
  </section></div>
}
