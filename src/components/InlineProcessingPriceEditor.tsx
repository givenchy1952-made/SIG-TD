import { useEffect, useState } from 'react'
import { RefreshCw, Save } from 'lucide-react'
import type { Profile, Style, Workspace } from '../lib/types'
import type { ProcessingPriceKind } from '../lib/processing-prices'
import { canViewStyle } from '../lib/permissions'
import { fullStyleSku } from '../lib/style-identity'
import { saveProcessingUnitPrice } from '../lib/processing-prices-repository'
import { message } from '../lib/utils'
import './processing-unit-prices.css'

interface Props {
  workspace: Workspace
  style: Style
  profile: Profile
  kind: ProcessingPriceKind
  itemKey: string
  itemName: string
  lineId?: string
  blocked?: boolean
  onChanged?: () => Promise<unknown>
  onDirtyChange?: (key: string, dirty: boolean) => void
}
interface Draft { lineId: string; version: number; value: string; context: string }
const labels: Record<ProcessingPriceKind, string> = { label: '라벨', embroidery: '자수', quality: '품질 검사' }

/** This is the saved order quotation. Supplier master prices remain separate. */
export default function InlineProcessingPriceEditor({ workspace, style, profile, kind, itemKey, itemName, lineId, blocked = false, onChanged, onDirtyChange }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null), [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false), [refreshRequired, setRefreshRequired] = useState(false)
  const [conflicted, setConflicted] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const actor = workspace.profiles.find(person => person.id === profile.id)
  const allowed = !!actor && canViewStyle(actor, style)
  const dirty = !!draft || busy || refreshRequired
  const lines = style.production.filter(line => !lineId || line.id === lineId)
  const operation = kind === 'quality' ? undefined : workspace.operations?.styleOperations.find(record => record.styleId === style.id && record.kind === kind && !record.voided && record.rows.some(row => row.id === itemKey))
  const storedRow = operation?.rows.find(row => row.id === itemKey)
  const quoteFor = (id: string) => workspace.processingUnitPrices?.find(price => price.styleId === style.id && price.lineId === id && price.kind === kind && price.itemKey === itemKey)
  const contextFor = (id: string) => {
    const assignment = workspace.inspectionAssignments?.find(assignment => assignment.styleId === style.id && assignment.lineId === id)
    const supplier = kind === 'quality'
      ? assignment?.provider ? workspace.factories.find(factory => factory.serviceType === 'inspection' && factory.inspectionProvider === assignment.provider && factory.active !== false) : undefined
      : workspace.factories.find(factory => factory.id === operation?.supplierFactoryId)
    const quality = workspace.productionDetails?.find(record => record.styleId === style.id && record.lineId === id)?.quality
    const stored = kind === 'quality' ? !!itemKey && quality?.category === itemKey : !!storedRow
    return { supplier, assignment, stored, identity: [kind, style.id, id, itemKey, operation?.supplierFactoryId || '', storedRow?.catalogId || '', assignment?.provider || '', assignment?.version || 0, quality?.category || ''].join(':') }
  }
  const current = draft ? quoteFor(draft.lineId) : undefined
  const stale = !!draft && (conflicted || (current?.version || 0) !== draft.version || !lines.some(line => line.id === draft.lineId) || contextFor(draft.lineId).identity !== draft.context)
  useEffect(() => { onDirtyChange?.(itemKey, dirty); return () => onDirtyChange?.(itemKey, false) }, [itemKey, dirty, onDirtyChange])
  if (!allowed) return null

  function unavailable(id: string): string {
    const context = contextFor(id), quote = quoteFor(id), line = lines.find(line => line.id === id)
    if (workspace.processingPricesAvailable !== true || !onChanged) return '단가 저장 기능 설정을 완료한 뒤 입력할 수 있습니다.'
    if (!context.stored) return kind === 'quality' ? '품질 검사 대상 품목을 먼저 저장해 주세요.' : '작업 내역을 먼저 저장하면 컬러별 단가를 입력할 수 있습니다.'
    if (kind === 'quality' && (!context.assignment?.provider || !context.supplier)) return '검사 업체를 에이블 또는 KOTITI로 지정한 뒤 단가를 입력해 주세요.'
    if (context.supplier && workspace.supplierWorkRatesAvailable !== true) return '업체별 단가 저장 설정을 완료한 뒤 입력할 수 있습니다.'
    if (context.supplier && quote && quote.supplierFactoryId !== context.supplier.id) return kind === 'quality' ? '이전 업체의 단가는 보존됩니다. 검사 업체 지정에서 현재 업체의 기준 단가를 먼저 적용해 주세요.' : '저장된 단가의 업체가 다릅니다. 담당 업체와 작업을 확인해 주세요.'
    if (actor?.role === 'factory' && (context.supplier || quote?.supplierFactoryId)) return '업체 공통 기준 단가는 내 업체 공통 작업·단가에서 입력하고, 이 오더의 합의 단가는 본사에서 저장합니다.'
    if ((context.supplier || quote?.supplierFactoryId) && line && ['done', 'approved'].includes(line.paymentStatus)) return '결제 마감된 단가는 보관되며 변경할 수 없습니다.'
    if (blocked) return '작업·검사 정보 또는 다른 단가의 편집을 먼저 저장하거나 취소해 주세요.'
    return ''
  }
  function change(id: string, value: string) {
    if (busy || refreshRequired || unavailable(id) || draft && draft.lineId !== id) return
    if (!draft) { setReason(''); setNotice(''); setError(''); setConflicted(false) }
    setDraft(prior => prior ? { ...prior, value } : { lineId: id, version: quoteFor(id)?.version || 0, value, context: contextFor(id).identity })
  }
  async function refresh() {
    if (busy || !onChanged) return
    setBusy(true); setError('')
    try { await onChanged(); setRefreshRequired(false) } catch { setError('최신 단가를 다시 불러오지 못했습니다. 연결을 확인해 주세요.') } finally { setBusy(false) }
  }
  async function save() {
    if (!draft || !actor || busy || stale || refreshRequired || unavailable(draft.lineId)) return
    const value = draft.value.trim()
    if (value && (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) > 1_000_000_000)) { setError('단가는 빈칸 또는 0~1,000,000,000원의 소수 둘째 자리까지 입력해 주세요.'); return }
    if (reason.trim().length < 2 || reason.length > 1000) { setError('단가 변경 사유를 두 글자 이상 입력해 주세요.'); return }
    setBusy(true); setError(''); setNotice('')
    let saved = false
    try {
      await saveProcessingUnitPrice(style.id, draft.lineId, kind, itemKey, value === '' ? null : Number(value), draft.version, reason.trim(), actor)
      saved = true; setDraft(null); setReason(''); await onChanged!(); setRefreshRequired(false)
      setNotice('작업 단가를 저장했습니다. 직접 수정하기 전까지 이 스타일·컬러의 을지에 적용합니다.')
    } catch (failure) { if (saved) { setRefreshRequired(true); setError('단가는 저장됐지만 최신 화면을 불러오지 못했습니다. 다시 불러온 뒤 확인해 주세요.') } else { const text = message(failure); setError(text); if (/version|conflict|다른 사용자가/i.test(text)) setConflicted(true) } }
    finally { setBusy(false) }
  }
  return <section className="inline-processing-prices" aria-label={`${labels[kind]} 작업 단가 입력`}>
    <header><strong>{kind === 'quality' ? '검사 단가' : '작업 단가'} <small>원 · 부가세 제외</small></strong><span>컬러별 저장 단가 · 빈칸은 미입력</span></header>
    {!lines.length ? <p className="inline-price-note">생산 컬러를 먼저 저장하면 단가를 입력할 수 있습니다.</p> : <div className="inline-price-lines">{lines.map(line => {
      const quote = quoteFor(line.id), context = contextFor(line.id), unavailableReason = unavailable(line.id)
      const editing = draft?.lineId === line.id, value = editing ? draft.value : quote?.unitCost ?? ''
      return <div className="inline-price-line" key={line.id}>
        <label className="field"><span className="field-label">{context.supplier?.name || (kind === 'quality' ? '에이블 / KOTITI · 미지정' : '업체 미지정')} · {line.color} 단가</span><input className="input" type="number" min="0" max="1000000000" step="0.01" inputMode="decimal" aria-label={`${labels[kind]} ${itemName || '미등록 작업'} ${fullStyleSku(style.code, line.color)} 단가 직접 입력`} placeholder="단가 입력" value={value} disabled={!!unavailableReason || busy || refreshRequired || !!draft && !editing} onChange={event => change(line.id, event.target.value)}/></label>
        {unavailableReason && <p className="inline-price-note">{unavailableReason}</p>}
      </div>
    })}</div>}
    {stale && <p className="processing-price-conflict" role="status">다른 사용자가 단가 또는 담당 업체·작업을 변경했습니다. 입력값은 유지됩니다. 편집을 취소하고 최신 내용을 확인해 주세요.</p>}
    {error && <p className="error-message" role="alert">{error}</p>}{notice && <p className="success-message" role="status">{notice}</p>}
    {refreshRequired && <button className="button" type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={13}/>작업 단가 다시 불러오기</button>}
    {draft && <div className="inline-price-footer"><label className="field"><span className="field-label">단가 변경 사유</span><input className="input" aria-label="직접 단가 변경 사유" value={reason} maxLength={1000} disabled={busy} onChange={event => setReason(event.target.value)}/></label><div><button className="button" type="button" disabled={busy} onClick={() => { setDraft(null); setReason(''); setError(''); setConflicted(false); if (stale) void refresh() }}>작업 단가 편집 취소</button><button className="button button-primary" type="button" disabled={busy || stale || !!unavailable(draft.lineId) || reason.trim().length < 2} onClick={() => void save()}><Save size={13}/>{busy ? '단가 저장 중…' : '작업 단가 저장'}</button></div></div>}
  </section>
}
