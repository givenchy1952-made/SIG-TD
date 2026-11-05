import { useEffect, useState, type ReactNode } from 'react'
import { ClipboardCheck, LogOut, RefreshCw, Search } from 'lucide-react'
import type { Profile, Workspace } from '../lib/types'
import { quantityTotal, SIZES, STATUS_LABEL } from '../lib/types'
import { getInspectionOrders, INSPECTION_PROVIDER_LABEL, isInspectionProfile } from '../lib/inspection-assignments'
import { QUALITY_CATEGORIES } from '../lib/workflow-refinements'
import { message } from '../lib/utils'
import { InspectionSupplierRateEditor } from './InspectionAssignmentPanel'
import './inspection-orders.css'

interface Props {
  workspace: Workspace
  profile: Profile
  onChanged: () => Promise<unknown>
  onLogout: () => void | Promise<void>
  demoRoleControls?: ReactNode
  onDirtyChange?: (dirty: boolean) => void
}
export default function InspectionOrdersPortal({ workspace, profile, onChanged, onLogout, demoRoleControls, onDirtyChange }: Props) {
  const actor = workspace.profiles.find(person => person.id === profile.id)
  const factory = workspace.factories.find(item => item.id === actor?.factoryId)
  const [query, setQuery] = useState(''), [category, setCategory] = useState<string>(QUALITY_CATEGORIES[0]), [busy, setBusy] = useState(false), [rateDirty, setRateDirty] = useState(false), [error, setError] = useState('')
  const allowed = !!actor?.approved && actor.active && isInspectionProfile(workspace, actor)
  const orders = allowed ? getInspectionOrders(workspace, actor) : []
  const visible = orders.filter(order => `${order.projectName} ${order.styleCode} ${order.color}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  useEffect(() => { onDirtyChange?.(rateDirty || busy); return () => onDirtyChange?.(false) }, [rateDirty, busy, onDirtyChange])
  useEffect(() => { const protect = (event: BeforeUnloadEvent) => { if (rateDirty) { event.preventDefault(); event.returnValue = '' } }; window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect) }, [rateDirty])
  async function refresh() {
    if (busy || rateDirty) return
    setBusy(true); setError('')
    try { await onChanged() } catch (failure) { setError(message(failure)) } finally { setBusy(false) }
  }
  return <main className="inspection-portal" aria-label="검사 업체 전용 오더">
    <header className="inspection-portal-heading"><div><span className="eyebrow">QUALITY INSPECTION</span><h1>품질 검사 오더</h1><p>{factory?.name || '검사 업체'}{factory?.inspectionProvider ? ` · ${INSPECTION_PROVIDER_LABEL[factory.inspectionProvider]}` : ''}</p></div><div className="inspection-actions"><button type="button" className="button" disabled={busy || rateDirty} onClick={() => void refresh()}><RefreshCw size={14}/>검사 오더 새로고침</button><button type="button" className="button" disabled={busy || rateDirty} onClick={() => void onLogout()}><LogOut size={14}/>로그아웃</button></div></header>
    {demoRoleControls}
    {error && <div className="error-message" role="alert">{error}</div>}
    {!allowed ? <section className="panel inspection-empty"><h2>검사 업체 설정을 확인해 주세요.</h2><p>승인된 검사 업체 계정만 이 화면을 사용할 수 있습니다.</p></section> : <>
      <p className="inspection-scope-note">본사가 현재 업체로 지정한 검사 오더만 표시합니다. 미지정 오더와 다른 검사 업체의 오더는 조회할 수 없습니다.</p>
      <label className="inspection-search"><Search size={16}/><input className="input" type="search" aria-label="검사 오더 검색" placeholder="프로젝트 명칭, 품번, 컬러 검색" value={query} onChange={event => setQuery(event.target.value)}/></label>
      {workspace.inspectionAssignmentsAvailable !== true ? <section className="panel inspection-empty" role="status"><h2>검사 오더 조회를 준비 중입니다.</h2><p>본사에 검사 업체 설정을 문의해 주세요.</p></section> : !visible.length ? <section className="panel inspection-empty" aria-label="지정된 검사 오더 없음"><ClipboardCheck size={30}/><h2>지정된 검사 오더가 없습니다.</h2><p>{query ? '검색 조건을 확인해 주세요.' : '본사가 검사 업체를 지정하면 이곳에서 확인할 수 있습니다.'}</p></section> : <section className="inspection-order-list" aria-label="지정된 검사 오더 목록">{visible.map(order => <article className="panel inspection-order-card" key={`${order.styleId}:${order.lineId}`} aria-label={`${order.styleCode} ${order.color} 검사 오더`}>
        <dl className="inspection-order-summary"><div><dt>프로젝트 명칭</dt><dd>{order.projectName}</dd></div><div><dt>품번</dt><dd>{order.styleCode}</dd></div><div><dt>컬러</dt><dd>{order.color}</dd></div><div><dt>총 수량</dt><dd>{order.orderQuantity.toLocaleString('ko-KR')} pcs</dd></div></dl>
        <div className="inspection-order-facts"><span>시즌 · {order.season || '미등록'}</span><span>본사 요청 납기 · {order.dueDate || '미입력'}</span><span>검사 품목 · {order.quality.category || '미지정'}</span><span>검사 요청 수량 · {order.quality.quantity.toLocaleString('ko-KR')} pcs</span><span>진행 · {STATUS_LABEL[order.quality.status]}</span></div>
        <div className="inspection-size-table"><table aria-label={`${order.styleCode} ${order.color} 사이즈별 오더`}><thead><tr>{SIZES.map(size => <th key={size}>{size}</th>)}<th>합계</th></tr></thead><tbody><tr>{SIZES.map(size => <td key={size}>{order.order[size].toLocaleString('ko-KR')}</td>)}<td>{quantityTotal(order.order).toLocaleString('ko-KR')}</td></tr></tbody></table></div>
        {order.quality.note && <p className="inspection-quality-note">{order.quality.note}</p>}
      </article>)}</section>}
      {factory?.inspectionProvider && factory.active !== false && <section className="panel inspection-portal-rates" aria-label="검사 업체 기준 단가 관리"><h2>검사 품목별 기준 단가</h2><label className="field"><span className="field-label">검사 품목</span><select className="select" aria-label="검사 기준 단가 품목" value={category} disabled={rateDirty || busy} onChange={event => setCategory(event.target.value)}>{QUALITY_CATEGORIES.map(item => <option key={item}>{item}</option>)}</select></label><InspectionSupplierRateEditor key={`${factory.id}:${category}`} workspace={workspace} profile={profile} factoryId={factory.id} category={category} onChanged={onChanged} onDirtyChange={setRateDirty}/></section>}
    </>}
  </main>
}
