import { useMemo, useState } from 'react'
import { ArrowRight, CalendarDays, ChevronLeft, ChevronRight, Clock3, Filter, LockKeyhole, Plus } from 'lucide-react'
import type { Profile, Style, Workspace } from '../lib/types'
import type { CalendarEvent, CalendarEventKind } from '../lib/operations-types'
import { EMPTY_OPERATIONS } from '../lib/operations-types'
import { quantityTotal } from '../lib/types'
import { leaveLabel } from '../lib/workflow-refinements'
import CalendarEventEditor, { CALENDAR_KIND_LABEL, canViewCalendarEvent } from '../components/CalendarEventEditor'
import './support.css'

type CalendarWorkspace = Workspace
interface Props { workspace: CalendarWorkspace; profile: Profile; onOpenStyle: (id: string) => void; onSaveCalendarEvent: (event: CalendarEvent, reason: string) => Promise<void>; onDeleteCalendarEvent: (event: CalendarEvent, reason: string) => Promise<void> }
type ScheduleKind = 'due' | 'sample' | 'production' | 'payment' | CalendarEventKind
interface ScheduleItem { id: string; date: string; endDate: string; title: string; label: string; style?: Style; custom?: CalendarEvent; complete: boolean; kind: ScheduleKind }
const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const asDate = (value: string) => new Date(`${value}T12:00:00`)
const shift = (date: Date, amount: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount, 12)
const itemClass = (item: ScheduleItem, today: string) => item.custom ? item.kind : item.complete ? 'complete' : item.date < today ? 'overdue' : item.kind
const itemState = (item: ScheduleItem, today: string) => item.custom ? item.endDate < today ? '지난 일정' : item.date <= today ? '진행 중' : '예정' : item.complete ? '완료 기록' : item.date < today ? '일정 지연' : '예정'
const dayLabel = (value: string) => asDate(value).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })
const dateRange = (start: string, end: string) => start === end ? start.slice(5).replace('-', '.') : `${start.slice(5).replace('-', '.')} – ${end.slice(5).replace('-', '.')}`

export default function Calendar({ workspace, profile, onOpenStyle, onSaveCalendarEvent, onDeleteCalendarEvent }: Props) {
  const [anchor, setAnchor] = useState(() => new Date())
  const [view, setView] = useState<'month' | 'week'>('month')
  const [factory, setFactory] = useState('')
  const [project, setProject] = useState('')
  const [kindFilter, setKindFilter] = useState('')
  const [selected, setSelected] = useState(dayKey(new Date()))
  const [editorTarget, setEditorTarget] = useState<CalendarEvent | null | undefined>(undefined)
  const today = dayKey(new Date())
  const operationsAvailable = workspace.operationsAvailable === true
  const operations = workspace.operations || EMPTY_OPERATIONS
  const events = useMemo(() => {
    const result: ScheduleItem[] = []
    const add = (style: Style, id: string, date: string, label: string, kind: ScheduleKind, complete = false) => {
      if (date) result.push({ id: `${style.id}-${id}`, style, date, endDate: date, title: style.code, label, kind, complete })
    }
    if (!kindFilter || kindFilter === 'workflow') workspace.styles.filter(style => !style.deletedAt && (!factory || style.factoryId === factory) && (!project || style.projectId === project)).forEach(style => {
      const ordered = style.production.reduce((n, line) => n + quantityTotal(line.order), 0)
      const received = style.production.reduce((n, line) => n + quantityTotal(line.received), 0)
      add(style, 'due', style.dueDate, '기준 납기', 'due', ordered > 0 ? received >= ordered : style.stage === 'approved')
      style.samples.forEach(sample => {
        const name = sample.isPP ? 'PP 샘플' : `${sample.round}차 샘플`
        add(style, `${sample.id}-plan`, sample.plannedAt, `${name} 제작 예정`, 'sample', Boolean(sample.completedAt || sample.receivedAt || sample.status === 'done' || sample.status === 'approved'))
        add(style, `${sample.id}-ship`, sample.shippedAt, `${name} 발송`, 'sample', true)
        add(style, `${sample.id}-receive`, sample.receivedAt, `${name} 본사 입고`, 'sample', true)
        add(style, `${sample.id}-review`, sample.reviewedAt, `${name} 리뷰`, 'sample', true)
      })
      style.production.forEach(line => {
        add(style, `${line.id}-confirm`, line.confirmDue, `${line.color} 메인 컨펌 예정`, 'production', line.checks.main === 'done' || line.checks.main === 'approved')
        add(style, `${line.id}-ship`, line.shippedAt, `${line.color} 실제 출고`, 'production', true)
        add(style, `${line.id}-receive`, line.receivedAt, `${line.color} 실제 입고`, 'production', true)
        add(style, `${line.id}-payment`, line.paymentDue, `${line.color} 업체 결제 마감`, 'payment', line.paymentStatus === 'done' || line.paymentStatus === 'approved')
      })
    })
    if (operationsAvailable && kindFilter !== 'workflow') operations.calendarEvents.filter(event => canViewCalendarEvent(event, profile) && (!kindFilter || event.kind === kindFilter) && (!factory || !event.factoryId || event.factoryId === factory)).forEach(event => {
      result.push({ id: event.id, date: event.startDate, endDate: event.endDate, title: event.title, label: `${CALENDAR_KIND_LABEL[event.kind]}${event.kind === 'personal_leave' ? ` · ${leaveLabel(event)}` : ''}`, custom: event, complete: false, kind: event.kind })
    })
    return result.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title))
  }, [workspace.styles, operations.calendarEvents, profile, factory, project, kindFilter, operationsAvailable])
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12)
  const weekStart = shift(anchor, -((anchor.getDay() + 6) % 7))
  const start = view === 'month' ? shift(first, -((first.getDay() + 6) % 7)) : weekStart
  const cells = Array.from({ length: view === 'month' ? 42 : 7 }, (_, i) => shift(start, i))
  const selectedEvents = events.filter(event => event.date <= selected && event.endDate >= selected)
  const upcoming = events.filter(event => event.custom ? event.endDate >= today && event.date <= dayKey(shift(new Date(), 7)) : !event.complete && event.date >= today && event.date <= dayKey(shift(new Date(), 7)))
  const overdue = events.filter(event => !event.custom && !event.complete && event.date < today)
  const navigate = (direction: number) => setAnchor(view === 'month' ? new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1, 12) : shift(anchor, direction * 7))
  const openItem = (item: ScheduleItem) => { if (item.custom) setEditorTarget(item.custom); else if (item.style) onOpenStyle(item.style.id) }
  const latestEditorEvent = editorTarget ? operations.calendarEvents.find(event => event.id === editorTarget.id) || editorTarget : null

  return <div className="calendar-page">
    <div className="page-heading"><div><div className="eyebrow">SCHEDULE OVERVIEW</div><h1>프로젝트 캘린더</h1><p className="muted">샘플·메인 생산 일정과 휴가·제품 런칭을 함께 확인하세요.</p></div><button className="button button-primary" disabled={!operationsAvailable} onClick={() => setEditorTarget(null)}><Plus size={16}/>일정 등록</button></div>
    {!operationsAvailable && <div className="calendar-migration-notice" role="status">{profile.role === 'factory' ? '추가 일정 등록은 관리자 설정 후 사용할 수 있습니다. 기존 샘플·생산 일정은 계속 표시됩니다.' : '휴가·제품 런칭 등록은 추가 설정 후 사용할 수 있습니다. 기존 샘플·생산 일정은 계속 표시됩니다. 관리자는 003 업무 확장 SQL 적용 여부를 확인해 주세요.'}</div>}
    <div className="calendar-summary"><div><CalendarDays size={17}/><span>7일 이내 예정</span><strong>{upcoming.length}</strong><small>건</small></div><div className="danger-text"><Clock3 size={17}/><span>미완료 지연 일정</span><strong>{overdue.length}</strong><small>건</small></div><p>여러 날의 휴가·런칭은 기간 전체에 표시됩니다.</p></div>
    <div className="calendar-top-legend"><div className="calendar-legend"><span><i className="legend-dot sample"/>샘플</span><span><i className="legend-dot production"/>생산·납기</span><span><i className="legend-dot payment"/>결제</span><span><i className="legend-dot personal_leave"/>개인 휴가</span><span><i className="legend-dot launch"/>제품 런칭</span>{profile.role !== 'factory' && <span><i className="legend-dot factory_holiday"/>협력업체 휴가 <LockKeyhole size={11}/></span>}</div><span className="calendar-filter-note">휴가·런칭은 프로젝트와 독립된 일정입니다.</span></div>
    <div className="panel calendar-panel">
      <div className="calendar-toolbar"><div className="calendar-period"><button className="icon-button" onClick={() => navigate(-1)} aria-label="이전 기간"><ChevronLeft size={18}/></button><h2>{anchor.getFullYear()}년 {anchor.getMonth() + 1}월{view === 'week' ? ` · ${weekStart.getDate()}일 주간` : ''}</h2><button className="icon-button" onClick={() => navigate(1)} aria-label="다음 기간"><ChevronRight size={18}/></button><button className="button button-ghost" onClick={() => { setAnchor(new Date()); setSelected(today) }}>오늘</button></div><div className="calendar-controls"><Filter size={15}/><select className="select" aria-label="일정 유형 필터" value={kindFilter} onChange={event => setKindFilter(event.target.value)}><option value="">전체 일정</option><option value="workflow">샘플·생산·결제</option><option value="personal_leave">개인 휴가</option><option value="launch">제품 런칭</option>{profile.role !== 'factory' && <option value="factory_holiday">협력업체 휴가</option>}</select><select className="select" aria-label="일정 공장 필터" value={factory} onChange={e => setFactory(e.target.value)}><option value="">전체 공장</option>{workspace.factories.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select><select className="select" aria-label="일정 프로젝트 필터" value={project} onChange={e => setProject(e.target.value)}><option value="">전체 프로젝트</option>{workspace.projects.map(item => <option value={item.id} key={item.id}>{item.code ? `${item.code} · ${item.name}` : item.name}</option>)}</select><div className="segmented"><button className={view === 'month' ? 'active' : ''} onClick={() => setView('month')}>월간</button><button className={view === 'week' ? 'active' : ''} onClick={() => setView('week')}>주간</button></div></div></div>
      <div className="calendar-scroll"><div className={`calendar-grid ${view === 'week' ? 'week-view' : ''}`}>
        {['월', '화', '수', '목', '금', '토', '일'].map((day, i) => <div className={`calendar-weekday ${i === 6 ? 'sunday' : ''}`} key={day}>{day}</div>)}
        {cells.map(date => { const key = dayKey(date); const dayEvents = events.filter(event => event.date <= key && event.endDate >= key); return <div key={key} className={`calendar-cell ${date.getMonth() !== anchor.getMonth() && view === 'month' ? 'outside' : ''} ${key === selected ? 'selected' : ''} ${date.getDay() === 0 ? 'sunday' : ''}`}><button className={`calendar-day ${key === today ? 'today' : ''}`} onClick={() => setSelected(key)} aria-label={`${key} 일정 확인`}>{date.getDate()}</button>{dayEvents.slice(0, view === 'week' ? 20 : 3).map(event => <button key={event.id} className={`calendar-event ${itemClass(event, today)} ${event.custom && event.date !== event.endDate ? 'multi-day-event' : ''} ${event.date === key ? 'range-start' : ''} ${event.endDate === key ? 'range-end' : ''}`} onClick={() => openItem(event)} title={`${event.title} · ${event.label} · ${dateRange(event.date, event.endDate)}`}><span className="calendar-event-code">{event.title}</span><span>{event.custom?.visibility === 'private' && <LockKeyhole size={9}/>} {event.label}{event.custom && event.date !== event.endDate ? ` · ${dateRange(event.date, event.endDate)}` : ''}</span></button>)}{dayEvents.length > 3 && view === 'month' && <button className="calendar-more" onClick={() => setSelected(key)}>+{dayEvents.length - 3}개 일정</button>}</div>})}
      </div></div>
    </div>
    <div className="calendar-bottom"><section className="panel"><div className="section-heading"><h2>{dayLabel(selected)} 일정</h2><span className="pill">{selectedEvents.length}건</span></div>{selectedEvents.length ? <div className="schedule-list">{selectedEvents.map(event => <button key={event.id} onClick={() => openItem(event)}><i className={`legend-dot ${itemClass(event, today)}`}/><div><strong>{event.title}</strong><p>{event.label} · {event.custom ? dateRange(event.date, event.endDate) : workspace.factories.find(item => item.id === event.style?.factoryId)?.name || '공장 미지정'}{event.custom?.factoryId && ` · ${workspace.factories.find(factory => factory.id === event.custom?.factoryId)?.name || ''}`}</p></div><span className={`schedule-state ${event.custom ? '' : event.complete ? 'complete' : event.date < today ? 'overdue' : ''}`}>{itemState(event, today)}</span><ArrowRight size={15}/></button>)}</div> : <div className="empty-state">등록된 일정이 없습니다.<button className="button button-ghost" disabled={!operationsAvailable} onClick={() => setEditorTarget(null)}><Plus size={14}/>이 날짜에 일정 추가</button></div>}</section>
    <section className="panel"><div className="section-heading"><h2>다가오는 7일</h2><span className="muted">{upcoming.length}건의 일정</span></div>{upcoming.length ? <div className="schedule-list">{upcoming.slice(0, 8).map(event => <button key={event.id} onClick={() => openItem(event)}><span className="schedule-date">{event.date.slice(5).replace('-', '.')}</span><div><strong>{event.title}</strong><p>{event.label}{event.custom && event.date !== event.endDate ? ` · ${dateRange(event.date, event.endDate)}` : ''}</p></div><ArrowRight size={15}/></button>)}</div> : <div className="empty-state">7일 이내 예정된 일정이 없습니다.</div>}</section></div>
    {editorTarget !== undefined && <CalendarEventEditor key={editorTarget?.id || 'new-event'} event={latestEditorEvent} initialDate={selected} workspace={workspace} profile={profile} onClose={() => setEditorTarget(undefined)} onSave={onSaveCalendarEvent} onDelete={onDeleteCalendarEvent}/>}
  </div>
}
