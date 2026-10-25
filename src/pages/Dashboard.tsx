import { lazy, Suspense, useEffect, useState } from 'react'
import {
  ArrowDown, ArrowDownToLine, ArrowRight, ArrowUpRight, CalendarDays, Check,
  ChevronDown, ChevronLeft, ChevronRight, CircleCheck, Clock3, Factory as FactoryIcon,
  Filter, Layers3, PackageCheck, Plus, Search, Shirt, SlidersHorizontal, X,
} from 'lucide-react'
import { Badge, Modal } from '../components/ui'
import PrivateImage from '../components/PrivateImage'
import { resolveStyleImage } from '../lib/style-images'
import { CHECKS, ROLE_LABEL, STAGE_LABEL, STATUS_LABEL, quantityTotal } from '../lib/types'
import type { Attachment, CheckKey, ProductionLine, Profile, Stage, Status, Style, Workspace } from '../lib/types'
import { exportWorkspace } from '../lib/export'
import { isSampleStyle } from '../lib/utils'
import type { OrderImportChange } from '../lib/operations-types'
import type { RegistrationProject } from '../lib/order-registration'
import './dashboard.css'
const OrderImport = lazy(() => import('../components/OrderImport'))
const SettlementTemplateExport = lazy(() => import('../components/SettlementTemplateExport'))

type View = 'overview' | 'samples' | 'production' | 'settlement'
type QuickFilter = 'all' | 'delayed' | 'upcoming' | 'approved' | 'samples' | 'unpaid'
type Sort = 'dueAsc' | 'dueDesc' | 'updated' | 'code'
type DateField = 'dueDate' | 'samplePlanned' | 'sampleReceived' | 'sampleShipped' | 'productionShipped' | 'productionReceived' | 'confirmDue' | 'paymentDue'
interface Props { onRegisterStyle?: (style: Style, project: RegistrationProject, reason: string) => Promise<Workspace>; workspace: Workspace; profile: Profile; view: View; onOpenStyle: (id: string) => void; onCreate: () => void; query: string; onQueryChange: (s: string) => void; onImport: (changes: OrderImportChange[], mode: 'replace' | 'add', reason: string) => Promise<void> }
interface Row { style: Style; line?: ProductionLine }
const formatter = new Intl.NumberFormat('ko-KR')
const number = (value: number) => formatter.format(value)
const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const shortDate = (date: string) => date ? date.slice(2).replaceAll('-', '.') : '—'
const complete = (s: Style) => s.stage === 'approved' || (s.stage === 'production' && s.production.length > 0 && s.production.every(p => quantityTotal(p.order) > 0 && quantityTotal(p.received) >= quantityTotal(p.order)))
const overdue = (s: Style, today: string) => !!s.dueDate && s.dueDate < today && !complete(s)
const stageStatus = (stage: Stage): Status => stage === 'approved' ? 'approved' : stage === 'registered' ? 'unset' : stage === 'revision' ? 'todo' : 'progress'
const viewTitles: Record<View, [string, string, string]> = {
  overview: ['WORKSPACE OVERVIEW', '샘플 & 생산 대시보드', '스타일의 시작부터 최종 입고까지, 모든 진행 상황을 한곳에서 확인하세요.'],
  samples: ['SAMPLE DEVELOPMENT', '샘플 관리', '첫 패턴부터 PP 컨펌까지, 차수별 이력과 수정 요청을 함께 관리합니다.'],
  production: ['PRODUCTION CONTROL', '메인 생산 관리', '컬러별 오더, 생산 체크리스트와 출고·입고 수량을 확인하세요.'],
  settlement: ['PAYMENT & CLOSING', '업체 결제 마감', '프로젝트와 공장별 세금계산서, 결제 예정일 및 마감 현황을 확인하세요.'],
}
const dateLabels: Record<DateField, string> = { dueDate: '기준 납기일', samplePlanned: '샘플 제작 예정일', sampleReceived: '샘플 본사 입고일', sampleShipped: '샘플 발송일', productionShipped: '메인 출고일', productionReceived: '메인 입고일', confirmDue: '메인 컨펌 예정일', paymentDue: '결제 예정일' }
function datesFor(style: Style, field: DateField): string[] {
  switch (field) {
    case 'dueDate': return [style.dueDate]
    case 'samplePlanned': return style.samples.map(s => s.plannedAt)
    case 'sampleReceived': return style.samples.map(s => s.receivedAt)
    case 'sampleShipped': return style.samples.map(s => s.shippedAt)
    case 'productionShipped': return style.production.map(p => p.shippedAt)
    case 'productionReceived': return style.production.map(p => p.receivedAt)
    case 'confirmDue': return style.production.map(p => p.confirmDue)
    case 'paymentDue': return style.production.map(p => p.paymentDue)
  }
}

export default function Dashboard({ workspace, profile, view, onOpenStyle, onCreate, query, onQueryChange, onImport, onRegisterStyle }: Props) {
  const [orderImportOpen, setOrderImportOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [imagePreview, setImagePreview] = useState<{ attachment: Attachment; styleId: string; alt: string } | null>(null)
  const imageScope = `${profile.id}:${profile.role}:${profile.factoryId || ''}`
  const [season, setSeason] = useState('')
  const [project, setProject] = useState('')
  const [factory, setFactory] = useState('')
  const [owner, setOwner] = useState('')
  const [stage, setStage] = useState('')
  const [color, setColor] = useState('')
  const [category, setCategory] = useState('')
  const [sampleStatus, setSampleStatus] = useState('')
  const [round, setRound] = useState('')
  const [pp, setPp] = useState('')
  const [statuses, setStatuses] = useState<Partial<Record<CheckKey | 'invoice' | 'paymentStatus', string>>>({})
  const [dateField, setDateField] = useState<DateField>('dueDate')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [sort, setSort] = useState<Sort>('dueAsc')
  const [quick, setQuick] = useState<QuickFilter>('all')
  const [tableMode, setTableMode] = useState<'styles' | 'samples' | 'production'>(view === 'production' || view === 'settlement' ? 'production' : view === 'samples' ? 'samples' : 'styles')
  useEffect(() => { setTableMode(view === 'production' || view === 'settlement' ? 'production' : view === 'samples' ? 'samples' : 'styles'); setQuick('all'); setPage(1) }, [view])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(15)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState('')
  const today = localDate(new Date())
  const weekEndDate = new Date(); weekEndDate.setDate(weekEndDate.getDate() + 7)
  const weekEnd = localDate(weekEndDate)
  const visibleStyles = workspace.styles.filter(style => !style.deletedAt && (!(view === 'samples' || tableMode === 'samples') || isSampleStyle(style)))
  const factoryName = (id: string) => workspace.factories.find(f => f.id === id)?.name || '미배정'
  const projectName = (id: string) => { const item = workspace.projects.find(p => p.id === id); return item ? [item.code, item.name].filter(Boolean).join(' · ') : '미배정' }
  const ownerName = (id: string) => workspace.profiles.find(p => p.id === id)?.name || '담당자'
  const upcoming = (style: Style) => !complete(style) && ([style.dueDate, ...style.samples.filter(s => s.status !== 'done' && s.status !== 'approved').map(s => s.plannedAt), ...style.production.map(p => p.confirmDue)]).some(date => !!date && date >= today && date <= weekEnd)
  const totalOrders = visibleStyles.reduce((sum, s) => sum + s.production.reduce((n, p) => n + quantityTotal(p.order), 0), 0)
  const totalReceived = visibleStyles.reduce((sum, s) => sum + s.production.reduce((n, p) => n + quantityTotal(p.received), 0), 0)
  const invoiceTotal = visibleStyles.reduce((sum, s) => sum + s.production.reduce((n, p) => n + p.invoiceAmount, 0), 0)
  const invoicePaid = visibleStyles.reduce((sum, s) => sum + s.production.reduce((n, p) => n + (p.paymentStatus === 'done' || p.paymentStatus === 'approved' ? p.invoiceAmount : 0), 0), 0)
  const overdueCount = visibleStyles.filter(s => overdue(s, today)).length
  const upcomingCount = visibleStyles.filter(upcoming).length
  const approvedCount = visibleStyles.filter(s => s.stage === 'approved' || s.stage === 'production').length
  const sampleCount = visibleStyles.filter(s => ['pattern', 'sample1', 'sampleN', 'review', 'revision'].includes(s.stage)).length
  const productionMode = view === 'settlement' || tableMode === 'production'
  const activeStatuses = Object.entries(statuses).filter(([, v]) => v)
  const activeFilterCount = [season, project, factory, owner, stage, color, category, sampleStatus, round, pp, dateFrom, dateTo, ...activeStatuses.map(([, v]) => v)].filter(Boolean).length
  const resetPage = () => setPage(1)
  const changeFilter = (fn: (v: string) => void, value: string) => { fn(value); resetPage() }
  const lineMatches = (line: ProductionLine, style?: Style) => {
    if (color && line.color !== color) return false
    if (!activeStatuses.every(([key, value]) => (key === 'invoice' || key === 'paymentStatus' ? line[key] : line.checks[key as CheckKey]) === value)) return false
    if (productionMode && (dateFrom || dateTo)) {
      const lineDate = dateField === 'productionShipped' ? line.shippedAt : dateField === 'productionReceived' ? line.receivedAt : dateField === 'confirmDue' ? line.confirmDue : dateField === 'paymentDue' ? line.paymentDue : null
      if (lineDate !== null && (!lineDate || dateFrom && lineDate < dateFrom || dateTo && lineDate > dateTo)) return false
    }
    if (productionMode && style && query.trim()) {
      const exactSkuTerms = query.trim().toLocaleLowerCase().split(/\s+/).filter(term => style.colors.some(c => `${style.code}${c}`.toLocaleLowerCase() === term))
      if (exactSkuTerms.length && !exactSkuTerms.includes(`${style.code}${line.color}`.toLocaleLowerCase())) return false
    }
    return true
  }
  const filteredStyles = visibleStyles.filter(style => {
    if (season && style.season !== season || project && style.projectId !== project || factory && style.factoryId !== factory || owner && style.ownerId !== owner || stage && style.stage !== stage || category && style.category !== category) return false
    if (pp && style.ppApproved !== (pp === 'yes')) return false
    if ((color || activeStatuses.length) && !style.production.some(line => lineMatches(line, style))) return false
    if ((sampleStatus || round) && !style.samples.some(sample => {
      const matchesStatus = !sampleStatus || sample.status === sampleStatus
      const matchesRound = !round || (round === 'pp' ? sample.isPP : !sample.isPP && (round === '3+' ? sample.round >= 3 : sample.round === Number(round)))
      return matchesStatus && matchesRound
    })) return false
    if (quick === 'delayed' && !overdue(style, today) || quick === 'upcoming' && !upcoming(style) || quick === 'approved' && style.stage !== 'approved' && style.stage !== 'production') return false
    if (quick === 'samples' && !['pattern', 'sample1', 'sampleN', 'review', 'revision'].includes(style.stage)) return false
    if (quick === 'unpaid' && !style.production.some(p => p.invoiceAmount > 0 && p.paymentStatus !== 'done' && p.paymentStatus !== 'approved')) return false
    if ((dateFrom || dateTo) && !datesFor(style, dateField).some(date => !!date && (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo))) return false
    if (query.trim()) {
      const text = `${JSON.stringify(style)} ${style.colors.map(c => `${style.code}${c}`).join(' ')} ${projectName(style.projectId)} ${factoryName(style.factoryId)} ${ownerName(style.ownerId)} ${STAGE_LABEL[style.stage]} ${style.samples.map(s => STATUS_LABEL[s.status]).join(' ')} ${style.production.map(p => [...Object.values(p.checks), p.invoice, p.paymentStatus].map(s => STATUS_LABEL[s]).join(' ')).join(' ')} ${workspace.comments.filter(c => c.styleId === style.id).map(c => c.body).join(' ')}`.toLocaleLowerCase()
      if (!query.trim().toLocaleLowerCase().split(/\s+/).every(word => text.includes(word))) return false
    }
    return true
  }).sort((a, b) => sort === 'dueAsc' ? (a.dueDate || '9999').localeCompare(b.dueDate || '9999') : sort === 'dueDesc' ? (b.dueDate || '').localeCompare(a.dueDate || '') : sort === 'updated' ? b.updatedAt.localeCompare(a.updatedAt) : a.code.localeCompare(b.code))
  const rows: Row[] = filteredStyles.flatMap(style => productionMode ? style.production.filter(line => lineMatches(line, style)).map(line => ({ style, line })) : [{ style }])
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pagedRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const exportStyles = filteredStyles.map(s => productionMode ? { ...s, production: s.production.filter(line => lineMatches(line, s)) } : s)
  const projectSummary = workspace.projects.map(p => {
    const styles = visibleStyles.filter(s => s.projectId === p.id)
    return { ...p, count: styles.length, order: styles.reduce((sum, s) => sum + s.production.reduce((n, line) => n + quantityTotal(line.order), 0), 0), received: styles.reduce((sum, s) => sum + s.production.reduce((n, line) => n + quantityTotal(line.received), 0), 0) }
  }).filter(p => p.count)
  const seasons = [...new Set([...workspace.projects.map(p => p.season), ...visibleStyles.map(s => s.season)])].filter(Boolean).sort().reverse()
  const categories = [...new Set(visibleStyles.map(s => s.category))].filter(Boolean).sort()
  const colors = [...new Set(visibleStyles.flatMap(s => s.colors))].sort()
  const [eyebrow, title, subtitle] = viewTitles[view]
  const clearFilters = () => { setSeason(''); setProject(''); setFactory(''); setOwner(''); setStage(''); setColor(''); setCategory(''); setSampleStatus(''); setRound(''); setPp(''); setStatuses({}); setDateFrom(''); setDateTo(''); setQuick('all'); onQueryChange(''); resetPage() }
  const doExport = async (format: 'csv' | 'xlsx') => {
    setExportBusy(true); setExportOpen(false); setExportError('')
    try { await exportWorkspace(workspace, exportStyles, format, view === 'settlement' ? 'settlement' : tableMode === 'samples' ? 'samples' : tableMode === 'production' ? 'production' : 'overview') } catch (error) { setExportError(error instanceof Error ? error.message : '파일을 다운로드하지 못했습니다.') } finally { setExportBusy(false) }
  }
  const quickClick = (value: QuickFilter) => { setQuick(quick === value ? 'all' : value); resetPage() }
  const filteredOrders = rows.reduce((sum, { style, line }) => sum + (line ? quantityTotal(line.order) : style.production.reduce((n, l) => n + quantityTotal(l.order), 0)), 0)
  const pageLabel = productionMode ? '컬러' : '스타일'

  function thumbnail(style: Style, line?: ProductionLine) {
    const attachment = resolveStyleImage(workspace, style.id, line?.color)
    const alt = `${style.code}${line?.color || ''} 대표 이미지`
    return <button type="button" className={`garment-icon ${attachment ? 'garment-photo cutout-background' : ''}`} aria-label={attachment ? `${alt} 크게 보기` : `${style.code} 대표 이미지 등록`} title={attachment ? '대표 이미지 크게 보기' : '스타일 상세에서 대표 이미지 등록'} onClick={event => { event.stopPropagation(); if (attachment) setImagePreview({ attachment, styleId: style.id, alt }); else onOpenStyle(style.id) }}>{attachment ? <PrivateImage attachment={attachment} scope={imageScope} alt={alt}/> : <Shirt size={21} strokeWidth={1.15}/>}</button>
  }
  return <div className="dashboard-page">
    {orderImportOpen && <Suspense fallback={<p className="muted" role="status">엑셀 가져오기를 준비하고 있습니다.</p>}><OrderImport workspace={workspace} profile={profile} onClose={() => setOrderImportOpen(false)} onImport={onImport} onRegisterStyle={onRegisterStyle} /></Suspense>}
    {templateOpen && <Suspense fallback={<p className="muted" role="status">마감 양식을 준비하고 있습니다.</p>}><SettlementTemplateExport workspace={workspace} profile={profile} styles={exportStyles} onClose={() => setTemplateOpen(false)} /></Suspense>}
    {imagePreview && <Modal title={imagePreview.alt} wide onClose={() => setImagePreview(null)}><div className="modal-body"><div className="style-image-zoom cutout-background"><PrivateImage attachment={imagePreview.attachment} scope={imageScope} alt={imagePreview.alt}/></div><div className="modal-footer"><button className="button" onClick={() => { onOpenStyle(imagePreview.styleId); setImagePreview(null) }}>{profile.role === 'factory' ? '스타일 상세' : '이미지 관리'}</button><button className="button button-primary" onClick={() => setImagePreview(null)}>닫기</button></div></div></Modal>}

    <div className="dashboard-page-heading">
      <div><div className="page-eyebrow">{eyebrow}</div><h1>{title}<span className="heading-period">.</span></h1><p>{subtitle}</p></div>
      <div className="page-heading-actions"><span className="today-chip"><CalendarDays size={14} />{today.replaceAll('-', '.')}</span>{profile.role !== 'factory' && view !== 'settlement' && <button className="button" onClick={() => setOrderImportOpen(true)}><ArrowDownToLine size={15} />오더 엑셀 업로드</button>}{profile.role !== 'factory' && <button className="button" disabled={!exportStyles.length} onClick={() => setTemplateOpen(true)}><ArrowDownToLine size={15} />을지 양식 다운로드</button>}{profile.role !== 'factory' && <button className="button button-primary" onClick={onCreate}><Plus size={16} />스타일 등록</button>}</div>
    </div>

    <div className="dashboard-kpis">
      <button className={`kpi-card ${quick === 'all' ? 'kpi-selected' : ''}`} onClick={() => { setQuick('all'); resetPage() }}>
        <div className="kpi-title">{view === 'settlement' ? '전체 청구 금액' : '전체 진행 스타일'}<Layers3 size={17}/></div>
        <div className="kpi-number">{view === 'settlement' ? number(invoiceTotal) : number(visibleStyles.length)}<span>{view === 'settlement' ? '원' : '스타일'}</span></div>
        <div className="kpi-note">{view === 'settlement' ? `결제 완료 ${number(invoicePaid)}원` : `전체 오더 ${number(totalOrders)} pcs`}<ArrowUpRight size={15}/></div>
      </button>
      <button className={`kpi-card ${quick === 'samples' || quick === 'unpaid' ? 'kpi-selected' : ''}`} onClick={() => { if (view !== 'settlement') setTableMode('samples'); setStage(''); quickClick(view === 'settlement' ? 'unpaid' : 'samples') }}>
        <div className="kpi-title">{view === 'settlement' ? '미결제 금액' : '샘플 진행 중'}<Shirt size={18}/></div>
        <div className="kpi-number">{view === 'settlement' ? number(invoiceTotal - invoicePaid) : number(sampleCount)}<span>{view === 'settlement' ? '원' : '스타일'}</span></div>
        <div className="kpi-note">{view === 'settlement' ? '청구 금액 − 결제 완료 금액' : `패턴 ${visibleStyles.filter(s => s.stage === 'pattern').length} · 1차 ${visibleStyles.filter(s => s.stage === 'sample1').length} · 2차+ ${visibleStyles.filter(s => s.stage === 'sampleN').length}`}<ArrowUpRight size={15}/></div>
      </button>
      <button className={`kpi-card ${quick === 'approved' ? 'kpi-selected' : ''}`} onClick={() => quickClick('approved')}>
        <div className="kpi-title">컨펌 완료<CircleCheck size={18}/></div>
        <div className="kpi-number">{number(approvedCount)}<span>스타일</span></div>
        <div className="kpi-note"><span className="kpi-dot green"/>PP 승인 {visibleStyles.filter(s => s.ppApproved).length} · 입고 {number(totalReceived)} pcs<ArrowUpRight size={15}/></div>
      </button>
      <button className={`kpi-card kpi-alert ${quick === 'delayed' ? 'kpi-selected' : ''}`} onClick={() => quickClick('delayed')}>
        <div className="kpi-title">납기 지연<Clock3 size={18}/></div>
        <div className="kpi-number">{number(overdueCount)}<span>스타일</span></div>
        <div className="kpi-note"><span className="kpi-dot red"/>기준 납기일 경과 · 확인 필요<ArrowUpRight size={15}/></div>
      </button>
    </div>

    <div className="dashboard-progress-line">
      <div><span className="subtle-dot"/><strong>워크플로</strong><span className="progress-separator"/>{(['pattern', 'sample1', 'sampleN', 'review', 'production'] as Stage[]).map((key, index) => <span className="workflow-count" key={key}>{index > 0 && <ChevronRight size={12}/>}<span>{STAGE_LABEL[key]}</span><b>{visibleStyles.filter(s => s.stage === key).length}</b></span>)}</div>
      <button onClick={() => quickClick('upcoming')} className={`upcoming-link ${quick === 'upcoming' ? 'active' : ''}`}><CalendarDays size={14}/>7일 이내 예정 <strong>{upcomingCount}</strong><ArrowRight size={13}/></button>
    </div>

    {view === 'overview' && projectSummary.length > 0 && <div className="project-overview">
      <div className="section-caption"><span>PROJECT AT A GLANCE</span><span>프로젝트별 입고 현황</span></div>
      <div className="project-cards">{projectSummary.slice(0, 4).map(p => <button className={`project-card ${project === p.id ? 'selected' : ''}`} key={p.id} onClick={() => changeFilter(setProject, project === p.id ? '' : p.id)}>
        <div className="project-card-top"><span>{p.code ? `${p.code} · ${p.season}` : p.season}</span><ArrowUpRight size={15}/></div><h3>{p.name}</h3><div className="project-card-numbers"><span>{p.count} 스타일</span><strong>{number(p.received)}<small> / {number(p.order)} pcs</small></strong></div><div className="project-progress"><i style={{ width: `${p.order ? Math.min(100, p.received / p.order * 100) : 0}%` }}/></div>
      </button>)}</div>
    </div>}

    <section className="panel dashboard-table-panel">
      <div className="dashboard-table-header">
        <div className="table-heading"><h2>{view === 'settlement' ? '결제 마감 현황' : '스타일 현황'}</h2><span className="count-pill">{number(filteredStyles.length)}</span><span className="table-heading-sub">{ROLE_LABEL[profile.role]} 조회 범위</span></div>
        <div className="table-actions">{view !== 'settlement' && <div className="view-switch" role="group" aria-label="테이블 보기">{([['styles', '전체'], ['samples', '샘플'], ['production', '메인 생산']] as const).map(([key, label]) => <button key={key} className={tableMode === key ? 'active' : ''} onClick={() => { setTableMode(key); resetPage() }}>{label}</button>)}</div>}
          <div className="export-menu"><button className="button button-ghost button-small" disabled={exportBusy || !filteredStyles.length} onClick={() => setExportOpen(!exportOpen)} aria-expanded={exportOpen}><ArrowDownToLine size={14}/>{exportBusy ? '파일 생성 중' : '다운로드'}<ChevronDown size={12}/></button>{exportOpen && <div className="dropdown-menu"><button onClick={() => doExport('xlsx')}>Excel 통합 문서 (.xlsx)</button><button onClick={() => doExport('csv')}>CSV 파일 (.csv)</button><p>필터 결과 전체를 내려받습니다.</p></div>}</div>
        </div>
      </div>
      <div className="dashboard-filter-bar">
        <label className="dashboard-search"><Search size={16}/><input aria-label="스타일 검색" placeholder="스타일, 제품명, 요청사항 검색" value={query} onChange={e => { onQueryChange(e.target.value); resetPage() }}/>{query && <button onClick={() => { onQueryChange(''); resetPage() }} aria-label="검색 초기화"><X size={13}/></button>}</label>
        <select className="select" aria-label="시즌 필터" value={season} onChange={e => changeFilter(setSeason, e.target.value)}><option value="">전체 시즌</option>{seasons.map(s => <option key={s}>{s}</option>)}</select>
        <select className="select project-select" aria-label="프로젝트 필터" value={project} onChange={e => changeFilter(setProject, e.target.value)}><option value="">전체 프로젝트</option>{workspace.projects.map(p => <option key={p.id} value={p.id}>{p.code ? `${p.code} · ${p.name}` : p.name}</option>)}</select>
        <select className="select" aria-label="공장 필터" value={factory} onChange={e => changeFilter(setFactory, e.target.value)}><option value="">전체 공장</option>{workspace.factories.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
        <button className={`button button-ghost button-small filter-toggle ${expanded ? 'active' : ''}`} onClick={() => setExpanded(!expanded)} aria-expanded={expanded}><SlidersHorizontal size={14}/>상세 필터{activeFilterCount > 0 && <span>{activeFilterCount}</span>}</button>
      </div>
      {expanded && <div className="advanced-filters">
        <div className="advanced-filter-title"><span><Filter size={14}/>모든 항목 필터</span><button onClick={clearFilters}>필터 초기화</button></div>
        <div className="advanced-filter-grid">
          <label className="field"><span className="field-label">담당자</span><select className="select" value={owner} onChange={e => changeFilter(setOwner, e.target.value)}><option value="">전체 담당자</option>{workspace.profiles.filter(p => p.role !== 'factory').map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
          <label className="field"><span className="field-label">진행 단계</span><select className="select" value={stage} onChange={e => changeFilter(setStage, e.target.value)}><option value="">전체 단계</option>{Object.entries(STAGE_LABEL).map(([k, v]) => <option value={k} key={k}>{v}</option>)}</select></label>
          <label className="field"><span className="field-label">컬러</span><select className="select" value={color} onChange={e => changeFilter(setColor, e.target.value)}><option value="">전체 컬러</option>{colors.map(c => <option key={c}>{c}</option>)}</select></label>
          <label className="field"><span className="field-label">카테고리</span><select className="select" value={category} onChange={e => changeFilter(setCategory, e.target.value)}><option value="">전체 카테고리</option>{categories.map(c => <option key={c}>{c}</option>)}</select></label>
          <label className="field"><span className="field-label">샘플 차수</span><select className="select" value={round} onChange={e => changeFilter(setRound, e.target.value)}><option value="">전체 차수</option><option value="1">1차</option><option value="2">2차</option><option value="3+">3차 이상</option><option value="pp">PP 샘플</option></select></label>
          <label className="field"><span className="field-label">샘플 상태</span><select className="select" value={sampleStatus} onChange={e => changeFilter(setSampleStatus, e.target.value)}><option value="">전체 상태</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field"><span className="field-label">PP 최종 승인</span><select className="select" value={pp} onChange={e => changeFilter(setPp, e.target.value)}><option value="">전체</option><option value="yes">승인</option><option value="no">미승인</option></select></label>
          {[...CHECKS, ['invoice', '세금계산서 발행'], ['paymentStatus', '결제 마감 상태']].map(([key, label]) => <label key={key} className="field"><span className="field-label">{label}</span><select className="select" value={statuses[key as keyof typeof statuses] || ''} onChange={e => { setStatuses({ ...statuses, [key]: e.target.value }); resetPage() }}><option value="">전체 상태</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>)}
        </div>
        <div className="date-filter-row"><label className="field"><span className="field-label">날짜 기준</span><select className="select" value={dateField} onChange={e => { setDateField(e.target.value as DateField); resetPage() }}>{Object.entries(dateLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="field"><span className="field-label">시작일</span><input className="input" type="date" value={dateFrom} onChange={e => changeFilter(setDateFrom, e.target.value)}/></label><span className="date-filter-divider">—</span><label className="field"><span className="field-label">종료일</span><input className="input" type="date" value={dateTo} min={dateFrom} onChange={e => changeFilter(setDateTo, e.target.value)}/></label><p>검색창에서 운송장, 코멘트, 수량 등 모든 내용도 검색할 수 있습니다.</p></div>
      </div>}
      {(quick !== 'all' || activeFilterCount > 0 || query) && <div className="active-filter-row"><span><Check size={12}/>{quick === 'delayed' ? '납기 지연' : quick === 'upcoming' ? '7일 이내 예정' : quick === 'approved' ? '컨펌 완료' : quick === 'samples' ? '샘플 진행 중' : quick === 'unpaid' ? '결제 미완료' : '필터 적용 중'}</span><span>{number(filteredStyles.length)}개 스타일 · 오더 {number(filteredOrders)} pcs</span><button onClick={clearFilters}><X size={12}/>초기화</button></div>}
      {exportError && <div className="error-message" role="alert">{exportError}</div>}
      <div className="table-sort-bar"><div className="status-legend"><span><i className="green"/>완료</span><span><i className="blue"/>진행 중</span><span><i className="purple"/>미완료</span><span><i className="red"/>지연</span><span><i className="gray"/>미기재</span><span><i className="dark"/>최종 컨펌</span></div><label className="sort-control"><ArrowDown size={12}/><select aria-label="정렬 기준" value={sort} onChange={e => { setSort(e.target.value as Sort); resetPage() }}><option value="dueAsc">납기 빠른순</option><option value="dueDesc">납기 늦은순</option><option value="updated">최근 수정순</option><option value="code">스타일 품번순</option></select></label></div>
      <div className="table-wrap"><table className={`data-table styles-table ${productionMode ? 'production-table' : ''}`}><thead><tr><th className="number-cell">NO.</th><th className="style-cell">스타일 / 제품명</th><th>프로젝트 / 시즌</th><th>담당 공장</th>{productionMode ? view === 'settlement' ? <><th>컬러</th><th>세금계산서</th><th className="numeric">청구 금액 (원)</th><th>결제 예정일</th><th>결제 상태</th><th className="numeric">출고 / 입고</th></> : <><th>컬러</th><th className="numeric">오더 수량</th><th>원·부자재</th><th>GB 테스트</th><th>라벨 발주</th><th>패킹 부자재</th><th>메인 수납</th><th>에이블 검사</th><th className="numeric">실 출고</th><th className="numeric">실 입고</th><th>세금계산서</th></> : <><th>진행 단계</th><th>{tableMode === 'samples' ? '샘플 차수 / 상태' : '샘플 진행'}</th><th>PP 승인</th>{tableMode === 'samples' ? <><th>제작 예정일</th><th>본사 입고일</th></> : <><th className="numeric">오더 수량</th><th className="numeric">입고 수량</th></>}</>}<th>기준 납기일</th><th>담당자</th><th className="arrow-cell"/></tr></thead>
      <tbody>{pagedRows.map(({ style, line }, index) => {
        const latest = style.samples.at(-1)
        const isLate = overdue(style, today)
        const order = line ? quantityTotal(line.order) : style.production.reduce((sum, p) => sum + quantityTotal(p.order), 0)
        const received = line ? quantityTotal(line.received) : style.production.reduce((sum, p) => sum + quantityTotal(p.received), 0)
        const shipment = line ? quantityTotal(line.shipped) : 0
        return <tr key={line?.id || style.id} onClick={() => onOpenStyle(style.id)} className={isLate ? 'row-overdue' : ''}>
          <td className="number-cell">{String((currentPage - 1) * pageSize + index + 1).padStart(2, '0')}</td>
          <td className="style-cell"><div className="style-identity">{thumbnail(style, line)}<div><button className="style-code" onClick={e => { e.stopPropagation(); onOpenStyle(style.id) }}>{style.code}{line?.color || ''}</button><span className="style-name">{style.name}</span></div></div></td>
          <td><span className="cell-main project-cell" title={projectName(style.projectId)}>{projectName(style.projectId)}</span><span className="cell-sub">{style.season}</span></td>
          <td><span className="cell-main">{factoryName(style.factoryId)}</span><span className="cell-sub">{workspace.factories.find(f => f.id === style.factoryId)?.country || '미배정'}</span></td>
          {productionMode && line ? view === 'settlement' ? <><td><span className="color-tag"><i style={{ background: colorHex(line.color) }}/>{line.color}</span></td><td><Badge status={line.invoice}/></td><td className="numeric amount">{number(line.invoiceAmount)}</td><td className={line.paymentDue && line.paymentDue < today && line.paymentStatus !== 'done' ? 'text-danger' : ''}>{shortDate(line.paymentDue)}</td><td><Badge status={line.paymentStatus}/></td><td className="numeric">{number(shipment)}<span className="muted"> / {number(received)}</span></td></> : <><td><span className="color-tag"><i style={{ background: colorHex(line.color) }}/>{line.color}</span></td><td className="numeric amount">{number(order)}<span className="quantity-unit">pcs</span></td>{(['materials', 'gb', 'labels', 'packing', 'main', 'quality'] as CheckKey[]).map(key => <td key={key}><Badge status={line.checks[key]}/></td>)}<td className="numeric">{number(shipment)}</td><td className="numeric">{number(received)}</td><td><Badge status={line.invoice}/></td></> : <>
            <td><Badge status={isLate ? 'delayed' : stageStatus(style.stage)} label={isLate ? '일정 지연' : STAGE_LABEL[style.stage]}/></td>
            <td>{latest ? <div className="sample-cell"><span className="sample-round">{latest.isPP ? 'PP' : `${latest.round}차`}</span><span className={`sample-status-dot status-dot-${latest.status}`}/><span>{STATUS_LABEL[latest.status]}</span>{style.samples.length > 1 && <span className="sample-history-count">+{style.samples.length - 1}</span>}</div> : <span className="muted">미등록</span>}</td>
            <td>{style.ppApproved ? <span className="pp-approved"><Check size={12}/>승인</span> : <span className="muted">미승인</span>}</td>
            {tableMode === 'samples' ? <><td className={latest?.plannedAt && latest.plannedAt < today && latest.status !== 'done' && latest.status !== 'approved' ? 'text-danger' : ''}>{shortDate(latest?.plannedAt || '')}</td><td>{shortDate(latest?.receivedAt || '')}</td></> : <><td className="numeric amount">{number(order)}<span className="quantity-unit">pcs</span></td><td className="numeric">{number(received)}<span className="quantity-unit">pcs</span></td></>}
          </>}
          <td><span className={`due-date ${isLate ? 'late' : ''}`}>{shortDate(style.dueDate)}{isLate && <span className="delay-indicator"/>}</span></td><td><span className="owner-cell"><span className="owner-avatar">{ownerName(style.ownerId).slice(0, 1)}</span>{ownerName(style.ownerId)}</span></td><td className="arrow-cell"><ArrowUpRight size={15}/></td>
        </tr>
      })}</tbody></table></div>
      {!rows.length && <div className="dashboard-empty"><div><Search size={25} strokeWidth={1.2}/></div><h3>{visibleStyles.length ? '조건에 맞는 스타일이 없습니다.' : '첫 번째 스타일을 등록해 보세요.'}</h3><p>{visibleStyles.length ? '검색어나 필터 조건을 조정해 주세요.' : '스타일을 등록하면 샘플부터 메인 생산까지 함께 관리할 수 있습니다.'}</p>{visibleStyles.length ? <button className="button button-ghost" onClick={clearFilters}>필터 초기화</button> : profile.role !== 'factory' && <button className="button button-primary" onClick={onCreate}><Plus size={15}/>스타일 등록</button>}</div>}
      <div className="table-pagination"><span>전체 <strong>{number(rows.length)}</strong>개 {pageLabel}{rows.length > 0 && <span className="pagination-range">{(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, rows.length)} 표시</span>}</span><div><select aria-label="페이지당 항목 수" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); resetPage() }}><option value={15}>15개씩 보기</option><option value={25}>25개씩 보기</option><option value={50}>50개씩 보기</option></select><button className="icon-button" aria-label="이전 페이지" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={15}/></button>{Array.from({ length: Math.min(5, totalPages) }, (_, i) => Math.max(1, Math.min(currentPage - 2, totalPages - 4)) + i).map(n => <button className={`page-number ${n === currentPage ? 'active' : ''}`} key={n} onClick={() => setPage(n)}>{n}</button>)}<button className="icon-button" aria-label="다음 페이지" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={15}/></button></div></div>
    </section>

    <div className="dashboard-bottom-grid">
      <section className="panel factory-overview"><div className="section-heading"><div><h3><FactoryIcon size={15}/>공장별 진행 현황</h3><p>배정 스타일과 오더 / 입고 수량</p></div><span className="subtle-label">{workspace.factories.filter(f => visibleStyles.some(s => s.factoryId === f.id)).length} PARTNERS</span></div><div className="factory-summary-list">{workspace.factories.filter(f => visibleStyles.some(s => s.factoryId === f.id)).map(f => {
        const styles = visibleStyles.filter(s => s.factoryId === f.id)
        const order = styles.reduce((sum, s) => sum + s.production.reduce((n, p) => n + quantityTotal(p.order), 0), 0)
        const received = styles.reduce((sum, s) => sum + s.production.reduce((n, p) => n + quantityTotal(p.received), 0), 0)
        return <button key={f.id} onClick={() => { changeFilter(setFactory, factory === f.id ? '' : f.id) }} className={factory === f.id ? 'selected' : ''}><span className="factory-monogram">{f.country === '중국' ? 'CN' : f.country === '베트남' ? 'VN' : f.country === '대한민국' || f.country === '한국' || f.country === '국내' ? 'KR' : f.country.slice(0, 2)}</span><span className="factory-summary-name"><strong>{f.name}</strong><small>{f.country} · {styles.length} 스타일</small></span><span className="factory-summary-count"><strong>{number(order)}<small> pcs</small></strong><small>입고 {number(received)}</small></span><ChevronRight size={14}/></button>
      })}{!visibleStyles.length && <p className="muted">스타일을 등록하면 공장별 현황이 표시됩니다.</p>}</div></section>
      <section className="panel next-schedule"><div className="section-heading"><div><h3><CalendarDays size={15}/>다가오는 일정</h3><p>오늘부터 7일 이내 예정된 업무</p></div><button className="subtle-label" onClick={() => quickClick('upcoming')}>{upcomingCount} STYLES<ArrowUpRight size={13}/></button></div><div className="next-schedule-list">{visibleStyles.filter(upcoming).sort((a, b) => nearestDate(a, today).localeCompare(nearestDate(b, today))).slice(0, 4).map(s => <button key={s.id} onClick={() => onOpenStyle(s.id)}><span className="schedule-date"><strong>{nearestDate(s, today).slice(8)}</strong><small>{nearestDate(s, today).slice(5, 7)}월</small></span><span><strong>{s.code}</strong><small>{s.name} · {factoryName(s.factoryId)}</small></span><Badge status="progress" label={s.dueDate === nearestDate(s, today) ? '기준 납기' : '샘플·컨펌 예정'}/><ChevronRight size={14}/></button>)}{!upcomingCount && <div className="schedule-clear"><PackageCheck size={26} strokeWidth={1.2}/><span>7일 이내 예정된 일정이 없습니다.</span></div>}</div></section>
    </div>
    <footer className="dashboard-footer"><span>FIVE SPACE / SIG</span><span>SAMPLE MANAGEMENT WORKSPACE</span><span>조회 데이터 기준 · 변경 사항은 저장 후 반영됩니다.</span></footer>
  </div>
}
function colorHex(color: string) { return ({ BK: '#25272c', WH: '#fff', OW: '#f0ece4', OT: '#bdb4a1', NV: '#25324b', GR: '#8a8c8c', GY: '#b1b4b8', BG: '#c9b99c', BR: '#82634d', BL: '#8ca6be', PK: '#dab3b8' } as Record<string, string>)[color] || '#dfdfdd' }
function nearestDate(style: Style, today: string) { return [style.dueDate, ...style.samples.filter(s => s.status !== 'done' && s.status !== 'approved').map(s => s.plannedAt), ...style.production.map(p => p.confirmDue)].filter(date => !!date && date >= today).sort()[0] || style.dueDate }
