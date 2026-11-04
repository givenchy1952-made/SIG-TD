import { useEffect, useState } from 'react'
import { Pencil, Plus, RefreshCw, Save } from 'lucide-react'
import type { Profile, Workspace } from '../lib/types'
import type { StyleOperationKind } from '../lib/operations-types'
import { findSupplierWorkRate, supplierCatalogOptions, supplierSupportsKind } from '../lib/supplier-work-rates'
import { saveSupplierWorkItem } from '../lib/supplier-work-rates-repository'
import { message } from '../lib/utils'
import './supplier-work-catalog.css'

interface Props {
  workspace: Workspace
  profile: Profile
  kind: StyleOperationKind
  supplierFactoryId: string
  blocked?: boolean
  onChanged: () => Promise<unknown>
  onDirtyChange?: (dirty: boolean) => void
}
interface Draft { id: string; catalogVersion: number; rateVersion: number; name: string; specification: string; price: string; active: boolean }
const money = (cost: number | null | undefined) => cost == null ? '미입력' : `${cost.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원`

export default function SupplierWorkCatalogPanel({ workspace, profile, kind, supplierFactoryId, blocked = false, onChanged, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState(false), [refreshRequired, setRefreshRequired] = useState(false)
  const [reason, setReason] = useState(''), [error, setError] = useState(''), [success, setSuccess] = useState('')
  const supplier = workspace.factories.find(factory => factory.id === supplierFactoryId)
  const actor = workspace.profiles.find(person => person.id === profile.id)
  const allowed = !!actor?.approved && actor.active && !!supplier && supplierSupportsKind(supplier, kind) && (actor.role !== 'factory' || actor.factoryId === supplier.id)
  const catalogs = supplierCatalogOptions(workspace, supplierFactoryId, kind)
  const current = draft ? catalogs.find(item => item.id === draft.id) : undefined
  const rate = draft ? findSupplierWorkRate(workspace, supplierFactoryId, kind, draft.id) : undefined
  const stale = !!draft && ((current?.version || 0) !== draft.catalogVersion || (rate?.version || 0) !== draft.rateVersion)
  const label = kind === 'label' ? '라벨 종류' : '자수 작업'
  useEffect(() => { onDirtyChange?.(!!draft || busy || refreshRequired); return () => onDirtyChange?.(false) }, [!!draft, busy, refreshRequired, onDirtyChange])
  if (!allowed) return null
  function begin(id?: string) {
    if (busy || blocked || refreshRequired || workspace.supplierWorkRatesAvailable !== true) return
    const item = catalogs.find(catalog => catalog.id === id), price = item ? findSupplierWorkRate(workspace, supplierFactoryId, kind, item.id) : undefined
    setDraft({ id: item?.id || crypto.randomUUID(), catalogVersion: item?.version || 0, rateVersion: price?.version || 0, name: item?.name || '', specification: item?.specification || '', price: price?.unitCost == null ? '' : String(price.unitCost), active: item?.active ?? true })
    setReason(''); setError(''); setSuccess('')
  }
  async function refresh() {
    if (busy) return
    setBusy(true); setError('')
    try { await onChanged(); setRefreshRequired(false) } catch { setError('최신 업체 작업·단가를 불러오지 못했습니다. 다시 불러와 주세요.') } finally { setBusy(false) }
  }
  async function save() {
    if (!draft || !actor || busy || blocked || stale || refreshRequired || workspace.supplierWorkRatesAvailable !== true) return
    const value = draft.price.trim()
    if (!draft.name.trim() || draft.name.length > 120) { setError('작업명을 120자 이내로 입력해 주세요.'); return }
    if (value && (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) > 1_000_000_000)) { setError('기본 단가는 빈칸 또는 0~1,000,000,000원의 소수 둘째 자리까지 입력해 주세요.'); return }
    if (reason.trim().length < 2 || reason.length > 1000) { setError('등록·변경 사유를 두 글자 이상 입력해 주세요.'); return }
    let saved = false
    setBusy(true); setError(''); setSuccess('')
    try {
      await saveSupplierWorkItem(draft.id, supplierFactoryId, kind, { name: draft.name.trim(), specification: draft.specification.trim(), active: draft.active, unitCost: value === '' ? null : Number(value) }, draft.catalogVersion, draft.rateVersion, reason.trim(), actor)
      saved = true; setDraft(null); setReason('')
      await onChanged(); setRefreshRequired(false); setSuccess('업체 공통 작업과 기본 단가를 저장했습니다. 새 스타일에서도 같은 항목을 선택할 수 있습니다. 기존 스타일에 저장한 작업·단가는 유지됩니다.')
    } catch (failure) { if (saved) { setRefreshRequired(true); setError('업체 공통 작업은 저장됐지만 최신 목록을 불러오지 못했습니다. 다시 불러온 뒤 선택해 주세요.') } else setError(message(failure)) }
    finally { setBusy(false) }
  }
  return <section className="supplier-work-catalog" aria-label={`${label} 업체 공통 작업·단가`}>
    <div className="section-heading"><div><h4>{supplier?.name} · 공통 작업·기본 단가</h4><p className="muted">한 번 등록하면 다른 스타일에서도 사용합니다. 기본값 변경은 새로 선택하는 작업에 적용되며 기존 작업·단가는 유지됩니다.</p></div>{workspace.supplierWorkRatesAvailable === true && !draft && <button className="button" type="button" disabled={busy || blocked || refreshRequired} onClick={() => begin()}><Plus size={13}/>{label} 공통 등록</button>}</div>
    {workspace.supplierWorkRatesAvailable !== true ? <p className="supplier-work-note" role="status">업체별 공통 작업·단가 기능을 준비 중입니다. 기존 공통 작업 목록과 스타일별 단가는 계속 사용할 수 있습니다.</p> : <>
      {error && <p className="error-message" role="alert">{error}</p>}{success && <p className="success-message" role="status">{success}</p>}
      {stale && <p className="error-message" role="status">다른 사용자가 업체 작업이나 단가를 변경했습니다. 입력값은 유지됩니다. 취소 후 최신 목록에서 다시 수정해 주세요.</p>}
      {refreshRequired && <button type="button" className="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={13}/>업체 공통 작업 다시 불러오기</button>}
      {!catalogs.length && !draft ? <p className="supplier-work-note">이 업체에 등록된 {label}이 없습니다. 작업명·사양·기본 단가를 한 번 등록해 주세요.</p> : !!catalogs.length && <div className="supplier-work-table-wrap"><table><thead><tr><th>작업명</th><th>기본 사양</th><th>기본 단가</th><th>사용</th><th>관리</th></tr></thead><tbody>{catalogs.map(item => <tr key={item.id}><th>{item.name}</th><td>{item.specification || '—'}</td><td>{money(findSupplierWorkRate(workspace, supplierFactoryId, kind, item.id)?.unitCost)}</td><td>{item.active ? '사용 중' : '중지'}</td><td><button className="button button-ghost" type="button" aria-label={`${item.name} 공통 작업·단가 수정`} disabled={!!draft || busy || blocked || refreshRequired} onClick={() => begin(item.id)}><Pencil size={12}/>수정</button></td></tr>)}</tbody></table></div>}
      {draft && <div className="supplier-work-editor" aria-label={`${label} 업체 공통 편집`}>
        <div className="form-grid"><label className="field"><span>작업명</span><input className="input" aria-label="업체 공통 작업명" maxLength={120} value={draft.name} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })}/></label><label className="field"><span>기본 사양</span><input className="input" aria-label="업체 공통 작업 사양" maxLength={1000} value={draft.specification} disabled={busy} onChange={event => setDraft({ ...draft, specification: event.target.value })}/></label><label className="field"><span>기본 단가 · 원</span><input className="input" aria-label="업체 공통 기본 단가" type="number" min="0" max="1000000000" step="0.01" placeholder="빈칸은 미입력" value={draft.price} disabled={busy} onChange={event => setDraft({ ...draft, price: event.target.value })}/></label><label className="field"><span>사용 여부</span><select className="select" aria-label="업체 공통 작업 사용 여부" value={draft.active ? 'active' : 'inactive'} disabled={busy} onChange={event => setDraft({ ...draft, active: event.target.value === 'active' })}><option value="active">사용</option><option value="inactive">중지</option></select></label></div>
        <label className="field"><span>등록·변경 사유</span><input className="input" aria-label="업체 공통 작업 변경 사유" maxLength={1000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)}/></label>
        <div className="supplier-work-actions"><button type="button" className="button" disabled={busy} onClick={() => { setDraft(null); setError('') }}>업체 공통 작업 편집 취소</button><button type="button" className="button button-primary" disabled={busy || blocked || stale || !draft.name.trim() || reason.trim().length < 2} onClick={() => void save()}><Save size={13}/>{busy ? '저장 중…' : '업체 공통 작업·단가 저장'}</button></div>
      </div>}
    </>}
  </section>
}
