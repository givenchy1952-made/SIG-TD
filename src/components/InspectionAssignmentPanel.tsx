import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Pencil, RefreshCw, Save, ShieldCheck } from 'lucide-react'
import type { Profile, Style, Workspace } from '../lib/types'
import { fullStyleSku } from '../lib/style-identity'
import { INSPECTION_PROVIDER_LABEL, type InspectionProvider } from '../lib/inspection-assignments'
import { saveInspectionAssignment } from '../lib/inspection-assignments-repository'
import { findSupplierWorkRate, supplierSupportsKind } from '../lib/supplier-work-rates'
import { applySupplierQualityRate, saveSupplierWorkRate } from '../lib/supplier-work-rates-repository'
import { findProcessingUnitPrice } from '../lib/processing-prices'
import { QUALITY_CATEGORIES } from '../lib/workflow-refinements'
import { message } from '../lib/utils'
import './inspection-orders.css'

const money = (value: number | null | undefined) => value == null ? '미입력' : `${value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원`

interface RateProps {
  workspace: Workspace
  profile: Profile
  factoryId: string
  category: string
  onChanged: () => Promise<unknown>
  onDirtyChange?: (dirty: boolean) => void
  contextStale?: boolean
}

/** Supplier's reusable benchmark; saved order quotations remain separate. */
export function InspectionSupplierRateEditor({ workspace, profile, factoryId, category, onChanged, onDirtyChange, contextStale = false }: RateProps) {
  const actor = workspace.profiles.find(person => person.id === profile.id)
  const factory = workspace.factories.find(item => item.id === factoryId)
  const record = findSupplierWorkRate(workspace, factoryId, 'quality', category)
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [refreshRequired, setRefreshRequired] = useState(false)
  const [value, setValue] = useState(''), [reason, setReason] = useState(''), [version, setVersion] = useState(0)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const stale = editing && (record?.version || 0) !== version
  const dirty = editing || busy || refreshRequired
  const allowed = !!actor?.active && actor.approved && (actor.role !== 'factory' || actor.factoryId === factoryId) && supplierSupportsKind(factory, 'quality') && QUALITY_CATEGORIES.includes(category as typeof QUALITY_CATEGORIES[number])
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])
  if (!allowed) return null
  async function refresh() {
    if (busy) return
    setBusy(true); setError('')
    try { await onChanged(); setRefreshRequired(false) } catch { setError('최신 기준 단가를 불러오지 못했습니다. 다시 확인해 주세요.') } finally { setBusy(false) }
  }
  async function save() {
    if (!allowed || contextStale || busy || stale || !editing || reason.trim().length < 2) return
    const clean = value.trim()
    if (clean && (!/^\d+(?:\.\d{1,2})?$/.test(clean) || Number(clean) > 1_000_000_000)) { setError('단가는 빈칸 또는 0~1,000,000,000원 범위에서 소수 둘째 자리까지 입력해 주세요.'); return }
    setBusy(true); setError(''); setNotice('')
    let saved = false
    try {
      await saveSupplierWorkRate(factoryId, 'quality', category, clean === '' ? null : Number(clean), version, reason.trim(), actor!)
      saved = true; setEditing(false); await onChanged(); setRefreshRequired(false)
      setNotice('검사 기준 단가를 저장했습니다. 기존 오더의 저장 단가는 유지됩니다.')
    } catch (failure) {
      if (saved) { setRefreshRequired(true); setError('기준 단가는 저장됐지만 최신 화면을 불러오지 못했습니다. 다시 불러온 뒤 확인해 주세요.') }
      else setError(message(failure))
    } finally { setBusy(false) }
  }
  return <section className="inspection-rate-editor" aria-label={`${category} 검사 기준 단가`}>
    <div className="section-heading"><div><strong>{factory!.name} · {category} 기준 단가</strong><p className="muted">한 번 저장한 단가를 다음 검사 오더의 기준으로 사용합니다. 기존 오더 단가는 본사에서 별도로 확인합니다.</p></div><span className="inspection-money">{money(record?.unitCost)}</span></div>
    {workspace.supplierWorkRatesAvailable !== true ? <p className="muted" role="status">업체별 기준 단가 설정을 준비 중입니다.</p> : <>
      {error && <div className="error-message" role="alert">{error}</div>}{notice && <p className="success-message" role="status">{notice}</p>}
      {contextStale && <p className="error-message" role="status">검사 업체 또는 품목이 변경되었습니다. 입력값은 유지됩니다. 편집을 취소한 뒤 현재 업체·품목을 확인해 주세요.</p>}
      {refreshRequired && <button type="button" className="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={13}/>검사 기준 단가 다시 불러오기</button>}
      {!editing && !refreshRequired && <button type="button" className="button" disabled={busy} onClick={() => { setEditing(true); setValue(record?.unitCost == null ? '' : String(record.unitCost)); setVersion(record?.version || 0); setReason(''); setError(''); setNotice('') }}><Pencil size={13}/>{record ? '검사 기준 단가 수정' : '검사 기준 단가 등록'}</button>}
      {editing && <div className="inspection-rate-form">
        {stale && <p className="error-message" role="status">다른 사용자가 기준 단가를 변경했습니다. 입력값은 유지됩니다. 취소 후 최신 단가를 확인하세요.</p>}
        <label className="field"><span className="field-label">기준 단가 (원 · 부가세 제외)</span><input className="input" aria-label="검사 기준 단가" type="number" min="0" max="1000000000" step="0.01" value={value} disabled={busy} placeholder="빈칸은 미입력 · 0원과 구분" onChange={event => setValue(event.target.value)}/></label>
        <label className="field"><span className="field-label">단가 등록·변경 사유</span><input className="input" aria-label="검사 기준 단가 변경 사유" maxLength={1000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)}/></label>
        <div className="inspection-actions"><button type="button" className="button" disabled={busy} onClick={() => { setEditing(false); setError('') }}>검사 단가 편집 취소</button><button type="button" className="button button-primary" disabled={contextStale || busy || stale || reason.trim().length < 2} onClick={() => void save()}><Save size={13}/>{busy ? '저장 중…' : '검사 기준 단가 저장'}</button></div>
      </div>}
    </>}
  </section>
}

interface Props {
  workspace: Workspace
  style: Style
  profile: Profile
  lineId?: string
  onChanged: () => Promise<unknown>
  onDirtyChange?: (dirty: boolean) => void
}
interface RateContext { lineId: string; factoryId: string; provider: InspectionProvider; category: string }

export default function InspectionAssignmentPanel({ workspace, style, profile, lineId, onChanged, onDirtyChange }: Props) {
  const actor = workspace.profiles.find(person => person.id === profile.id)
  const [selectedLineId, setSelectedLineId] = useState(lineId || style.production[0]?.id || '')
  const line = style.production.find(item => item.id === (lineId || selectedLineId))
  const assignment = workspace.inspectionAssignments?.find(item => item.styleId === style.id && item.lineId === line?.id)
  const quality = workspace.productionDetails?.find(item => item.styleId === style.id && item.lineId === line?.id)?.quality
  const [editor, setEditor] = useState<{ provider: InspectionProvider | null; version: number; lineId: string } | null>(null)
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [rateDirty, setRateDirty] = useState(false), [refreshRequired, setRefreshRequired] = useState(false)
  const [pinnedRateContext, setPinnedRateContext] = useState<RateContext | null>(null)
  const liveRateContextRef = useRef<RateContext | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const provider = assignment?.provider || null
  const supplier = provider ? workspace.factories.find(factory => factory.active !== false && factory.serviceType === 'inspection' && factory.inspectionProvider === provider) : undefined
  const liveRateContext: RateContext | null = line && provider && supplier && quality?.category ? { lineId: line.id, factoryId: supplier.id, provider, category: quality.category } : null
  liveRateContextRef.current = liveRateContext
  const rateEditorContext = pinnedRateContext || liveRateContext
  const rateContextStale = !!pinnedRateContext && (!liveRateContext || pinnedRateContext.lineId !== liveRateContext.lineId || pinnedRateContext.factoryId !== liveRateContext.factoryId || pinnedRateContext.provider !== liveRateContext.provider || pinnedRateContext.category !== liveRateContext.category)
  const reportRateDirty = useCallback((dirty: boolean) => {
    setRateDirty(dirty)
    setPinnedRateContext(previous => dirty ? previous || liveRateContextRef.current : null)
  }, [])
  const rate = supplier && quality?.category ? findSupplierWorkRate(workspace, supplier.id, 'quality', quality.category) : undefined
  const quote = line && quality?.category ? findProcessingUnitPrice(workspace, style.id, line.id, 'quality', quality.category) : undefined
  const quoteSupplier = (quote as typeof quote & { supplierFactoryId?: string | null })?.supplierFactoryId
  const stale = !!editor && ((assignment?.version || 0) !== editor.version || line?.id !== editor.lineId)
  const providerReady = !editor?.provider || workspace.factories.some(factory => factory.active !== false && factory.serviceType === 'inspection' && factory.inspectionProvider === editor.provider)
  const changing = !!editor || busy || rateDirty || refreshRequired
  useEffect(() => { onDirtyChange?.(changing); return () => onDirtyChange?.(false) }, [changing, onDirtyChange])
  if (!actor?.active || !actor.approved || actor.role === 'factory') return null
  async function refresh() {
    if (busy || rateDirty) return
    setBusy(true); setError('')
    try { await onChanged(); setRefreshRequired(false) } catch { setError('검사 업체·단가 정보를 불러오지 못했습니다. 다시 확인해 주세요.') } finally { setBusy(false) }
  }
  async function save() {
    if (!line || !editor || busy || stale || !providerReady || reason.trim().length < 2) return
    setBusy(true); setError(''); setNotice('')
    let saved = false
    try {
      await saveInspectionAssignment(style.id, line.id, editor.provider, editor.version, reason.trim(), actor!)
      saved = true; setEditor(null); await onChanged(); setRefreshRequired(false)
      setNotice('검사 업체 지정을 저장했습니다. 지정된 업체만 이 검사 오더를 조회합니다.')
    } catch (failure) {
      if (saved) { setRefreshRequired(true); setError('업체 지정은 저장됐지만 최신 화면을 불러오지 못했습니다. 다시 불러와 주세요.') }
      else setError(message(failure))
    } finally { setBusy(false) }
  }
  async function applyRate() {
    if (!line || !supplier || !quality?.category || !assignment || !rate || changing || rateContextStale) return
    if (reason.trim().length < 2) { setError('기준 단가를 적용하는 사유를 두 글자 이상 입력해 주세요.'); return }
    setBusy(true); setError(''); setNotice('')
    let saved = false
    try {
      await applySupplierQualityRate(style.id, line.id, supplier.id, quality.category, assignment.version, quote?.version || 0, reason.trim(), actor!)
      saved = true; await onChanged(); setRefreshRequired(false)
      setNotice('이 검사 오더의 단가를 확인·적용했습니다. 같은 업체의 기존 저장 단가는 유지됩니다.')
    } catch (failure) {
      if (saved) { setRefreshRequired(true); setError('단가는 적용됐지만 최신 화면을 불러오지 못했습니다. 다시 불러와 주세요.') }
      else setError(message(failure))
    } finally { setBusy(false) }
  }
  return <section className="inspection-assignment" aria-label="품질 검사 업체 지정">
    <div className="section-heading"><div><h3><ShieldCheck size={16}/>검사 업체 지정</h3><p className="muted">에이블·KOTITI 중 업체를 지정하기 전에는 검사 업체가 이 오더를 볼 수 없습니다.</p></div><span className="pill">{provider ? INSPECTION_PROVIDER_LABEL[provider] : '미지정'}</span></div>
    {!lineId && <label className="field"><span className="field-label">검사 컬러</span><select className="select" aria-label="검사 업체 지정 컬러" value={line?.id || ''} disabled={changing} onChange={event => { setSelectedLineId(event.target.value); setError(''); setNotice(''); setReason('') }}>{style.production.map(item => <option key={item.id} value={item.id}>{fullStyleSku(style.code, item.color)}</option>)}</select></label>}
    {workspace.inspectionAssignmentsAvailable !== true ? <p className="inspection-empty" role="status">검사 업체 지정 기능을 준비 중입니다. 현재는 검사 업체에 오더를 공개하지 않습니다.</p> : !line ? <p className="inspection-empty">저장된 생산 컬러를 먼저 선택해 주세요.</p> : <>
      {error && <div className="error-message" role="alert">{error}</div>}{notice && <p className="success-message" role="status">{notice}</p>}
      {refreshRequired && <button type="button" className="button" disabled={busy || rateDirty} onClick={() => void refresh()}><RefreshCw size={13}/>검사 업체 정보 다시 불러오기</button>}
      {!editor && <button type="button" className="button" disabled={changing} onClick={() => { setEditor({ provider, version: assignment?.version || 0, lineId: line.id }); setReason(''); setError(''); setNotice('') }}><Pencil size={13}/>{assignment ? '검사 업체 지정 수정' : '검사 업체 지정'}</button>}
      {editor && <div className="inspection-assignment-editor">
        <fieldset disabled={busy} className="inspection-provider-options"><legend>검사 업체</legend>{([null, 'able', 'kotiti'] as const).map(value => <label key={value || 'none'}><input type="radio" name={`inspection-provider-${style.id}-${line.id}`} aria-label={`검사 업체 ${value ? INSPECTION_PROVIDER_LABEL[value] : '미지정'}`} checked={editor.provider === value} onChange={() => setEditor({ ...editor, provider: value })}/>{value ? INSPECTION_PROVIDER_LABEL[value] : '미지정'}</label>)}</fieldset>
        {editor.provider && !workspace.factories.some(factory => factory.active !== false && factory.serviceType === 'inspection' && factory.inspectionProvider === editor.provider) && <p className="inspection-empty">관리자의 공장 관리에서 선택한 업체를 품질 검사·{INSPECTION_PROVIDER_LABEL[editor.provider]}로 먼저 설정해 주세요.</p>}
        {stale && <p className="error-message" role="status">검사 업체 지정이 변경되었습니다. 입력값은 유지됩니다. 취소 후 최신 지정을 확인하세요.</p>}
        <label className="field"><span className="field-label">지정·변경 사유</span><input className="input" aria-label="검사 업체 지정 사유" maxLength={1000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)}/></label>
        <div className="inspection-actions"><button type="button" className="button" disabled={busy} onClick={() => { setEditor(null); setError('') }}>검사 업체 지정 취소</button><button type="button" className="button button-primary" disabled={busy || stale || !providerReady || reason.trim().length < 2} onClick={() => void save()}><Check size={13}/>{busy ? '저장 중…' : '검사 업체 지정 저장'}</button></div>
      </div>}
      {rateEditorContext && !editor && <InspectionSupplierRateEditor key={`${rateEditorContext.lineId}:${rateEditorContext.factoryId}:${rateEditorContext.category}`} workspace={workspace} profile={profile} factoryId={rateEditorContext.factoryId} category={rateEditorContext.category} onChanged={onChanged} onDirtyChange={reportRateDirty} contextStale={rateContextStale}/>}
      {provider && supplier && quality?.category && !editor && <div className="inspection-order-price"><strong>이 오더 저장 단가: {quoteSupplier === supplier.id ? money(quote?.unitCost) : '업체 단가 확인 필요'}</strong><p className="muted">기준 단가 수정만으로 기존 오더 금액을 바꾸지 않습니다. 현재 지정 업체·품목에 적용할 단가를 본사에서 확인하세요.</p><label className="field"><span className="field-label">단가 적용 사유</span><input className="input" aria-label="검사 오더 단가 적용 사유" value={reason} maxLength={1000} disabled={changing || rateContextStale} onChange={event => setReason(event.target.value)}/></label><button type="button" className="button" disabled={changing || rateContextStale || !rate || reason.trim().length < 2} onClick={() => void applyRate()}>이 오더에 기준 단가 적용</button></div>}
      {provider && !quality?.category && <p className="muted">품질 검사 대상 품목을 먼저 저장하면 해당 업체의 기준 단가를 등록·적용할 수 있습니다.</p>}
    </>}
  </section>
}
