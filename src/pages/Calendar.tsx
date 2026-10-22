import { useMemo, useState } from 'react'
import { ArrowRight, CalendarDays, ChevronLeft, ChevronRight, Clock3, Filter } from 'lucide-react'
import type { Style, Workspace } from '../lib/types'
import { quantityTotal } from '../lib/types'
import './support.css'

interface Props { workspace: Workspace; onOpenStyle: (id: string) => void }
interface CalendarEvent { id: string; date: string; label: string; style: Style; complete: boolean; kind: 'due' | 'sample' | 'production' | 'payment' }
const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const asDate = (value: string) => new Date(`${value}T12:00:00`)
const shift = (date: Date, amount: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount, 12)
const eventClass = (event: CalendarEvent, today: string) => event.complete ? 'complete' : event.date < today ? 'overdue' : event.kind
const dayLabel = (value: string) => asDate(value).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })

export default function Calendar({ workspace, onOpenStyle }: Props) {
  const [anchor, setAnchor] = useState(() => new Date())
  const [view, setView] = useState<'month' | 'week'>('month')
  const [factory, setFactory] = useState('')
  const [project, setProject] = useState('')
  const [selected, setSelected] = useState(dayKey(new Date()))
  const today = dayKey(new Date())
  const events = useMemo(() => {
    const result: CalendarEvent[] = []
    const add = (style: Style, id: string, date: string, label: string, kind: CalendarEvent['kind'], complete = false) => {
      if (date) result.push({ id: `${style.id}-${id}`, style, date, label, kind, complete })
    }
    workspace.styles.filter(style => !style.deletedAt && (!factory || style.factoryId === factory) && (!project || style.projectId === project)).forEach(style => {
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
    return result.sort((a, b) => a.date.localeCompare(b.date) || a.style.code.localeCompare(b.style.code))
  }, [workspace.styles, factory, project])
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12)
  const weekStart = shift(anchor, -((anchor.getDay() + 6) % 7))
  const start = view === 'month' ? shift(first, -((first.getDay() + 6) % 7)) : weekStart
  const cells = Array.from({ length: view === 'month' ? 42 : 7 }, (_, i) => shift(start, i))
  const selectedEvents = events.filter(event => event.date === selected)
  const upcoming = events.filter(event => !event.complete && event.date >= today && event.date <= dayKey(shift(new Date(), 7)))
  const overdue = events.filter(event => !event.complete && event.date < today)
  const navigate = (direction: number) => setAnchor(view === 'month' ? new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1, 12) : shift(anchor, direction * 7))

  return <div className="calendar-page">
    <div className="page-heading"><div><div className="eyebrow">SCHEDULE OVERVIEW</div><h1>프로젝트 캘린더</h1><p className="muted">샘플부터 메인 생산, 업체 결제까지 한눈에 확인하세요.</p></div><div className="calendar-legend"><span><i className="legend-dot sample"/>샘플</span><span><i className="legend-dot production"/>생산·납기</span><span><i className="legend-dot payment"/>결제</span></div></div>
    <div className="calendar-summary"><div><CalendarDays size={17}/><span>7일 이내 예정</span><strong>{upcoming.length}</strong><small>건</small></div><div className="danger-text"><Clock3 size={17}/><span>미완료 지연 일정</span><strong>{overdue.length}</strong><small>건</small></div><p>일정 변경은 스타일 상세에서 사유와 함께 저장됩니다.</p></div>
    <div className="panel calendar-panel">
      <div className="calendar-toolbar"><div className="calendar-period"><button className="icon-button" onClick={() => navigate(-1)} aria-label="이전 기간"><ChevronLeft size={18}/></button><h2>{anchor.getFullYear()}년 {anchor.getMonth() + 1}월{view === 'week' ? ` · ${weekStart.getDate()}일 주간` : ''}</h2><button className="icon-button" onClick={() => navigate(1)} aria-label="다음 기간"><ChevronRight size={18}/></button><button className="button button-ghost" onClick={() => { setAnchor(new Date()); setSelected(today) }}>오늘</button></div><div className="calendar-controls"><Filter size={15}/><select className="select" aria-label="일정 공장 필터" value={factory} onChange={e => setFactory(e.target.value)}><option value="">전체 공장</option>{workspace.factories.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select><select className="select" aria-label="일정 프로젝트 필터" value={project} onChange={e => setProject(e.target.value)}><option value="">전체 프로젝트</option>{workspace.projects.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select><div className="segmented"><button className={view === 'month' ? 'active' : ''} onClick={() => setView('month')}>월간</button><button className={view === 'week' ? 'active' : ''} onClick={() => setView('week')}>주간</button></div></div></div>
      <div className="calendar-scroll"><div className={`calendar-grid ${view === 'week' ? 'week-view' : ''}`}>
        {['월', '화', '수', '목', '금', '토', '일'].map((day, i) => <div className={`calendar-weekday ${i === 6 ? 'sunday' : ''}`} key={day}>{day}</div>)}
        {cells.map(date => { const key = dayKey(date); const dayEvents = events.filter(event => event.date === key); return <div key={key} className={`calendar-cell ${date.getMonth() !== anchor.getMonth() && view === 'month' ? 'outside' : ''} ${key === selected ? 'selected' : ''} ${date.getDay() === 0 ? 'sunday' : ''}`}><button className={`calendar-day ${key === today ? 'today' : ''}`} onClick={() => setSelected(key)} aria-label={`${key} 일정 확인`}>{date.getDate()}</button>{dayEvents.slice(0, view === 'week' ? 20 : 3).map(event => <button key={event.id} className={`calendar-event ${eventClass(event, today)}`} onClick={() => onOpenStyle(event.style.id)} title={`${event.style.code} · ${event.label}`}><span className="calendar-event-code">{event.style.code}</span><span>{event.label}</span></button>)}{dayEvents.length > 3 && view === 'month' && <button className="calendar-more" onClick={() => setSelected(key)}>+{dayEvents.length - 3}개 일정</button>}</div>})}
      </div></div>
    </div>
    <div className="calendar-bottom"><section className="panel"><div className="section-heading"><h2>{dayLabel(selected)} 일정</h2><span className="pill">{selectedEvents.length}건</span></div>{selectedEvents.length ? <div className="schedule-list">{selectedEvents.map(event => <button key={event.id} onClick={() => onOpenStyle(event.style.id)}><i className={`legend-dot ${event.complete ? 'complete' : event.date < today ? 'overdue' : event.kind}`}/><div><strong>{event.style.code}</strong><p>{event.label} · {workspace.factories.find(item => item.id === event.style.factoryId)?.name || '공장 미지정'}</p></div><span className={`schedule-state ${event.complete ? 'complete' : event.date < today ? 'overdue' : ''}`}>{event.complete ? '완료 기록' : event.date < today ? '일정 지연' : '예정'}</span><ArrowRight size={15}/></button>)}</div> : <div className="empty-state">등록된 일정이 없습니다.</div>}</section>
    <section className="panel"><div className="section-heading"><h2>다가오는 7일</h2><span className="muted">{upcoming.length}건의 일정</span></div>{upcoming.length ? <div className="schedule-list">{upcoming.slice(0, 8).map(event => <button key={event.id} onClick={() => onOpenStyle(event.style.id)}><span className="schedule-date">{event.date.slice(5).replace('-', '.')}</span><div><strong>{event.style.code}</strong><p>{event.label}</p></div><ArrowRight size={15}/></button>)}</div> : <div className="empty-state">7일 이내 예정된 일정이 없습니다.</div>}</section></div>
  </div>
}
