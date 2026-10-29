import { useEffect, useState } from 'react'
import { Pencil, RefreshCw, Save } from 'lucide-react'
import type { Profile, Style, Workspace } from '../lib/types'
import { quantityTotal } from '../lib/types'
import { canViewStyle } from '../lib/permissions'
import type { ProcessingPriceKind } from '../lib/processing-prices'
import { saveProcessingUnitPrice } from '../lib/processing-prices-repository'
import { fullStyleSku } from '../lib/style-identity'
import { message } from '../lib/utils'
import './processing-unit-prices.css'

interface Props {
  style: Style
  workspace: Workspace
  profile: Profile
  onRefresh: () => Promise<unknown>
  onDirtyChange?: (dirty: boolean) => void
  parentDirty?: boolean
}
interface PriceItem { lineId: string; itemKey: string; sku: string; name: string; receivedAt: string; quantity: number }
interface Draft { lineId: string; itemKey: string; kind: ProcessingPriceKind; version: number; value: string }
const labels: Record<ProcessingPriceKind, string> = { label: '중화 라벨', embroidery: '비와이 자수', quality: '에이블 품질 검사' }
const money = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })

export default function ProcessingUnitPricePanel({ style, workspace, profile, onRefresh, onDirtyChange, parentDirty = false }: Props) {
  const [kind, setKind] = useState<ProcessingPriceKind>('label')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [reason, setReason] = useState(''), [error, setError] = useState(''), [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false), [refreshRequired, setRefreshRequired] = useState(false)
  const actor = workspace.profiles.find(item => item.id === profile.id)
  const allowed = !!actor && canViewStyle(actor, style)
  const ready = workspace.processingPricesAvailable === true
  const items: PriceItem[] = style.production.flatMap(line => {
    const common = { lineId: line.id, sku: fullStyleSku(style.code, line.color), receivedAt: line.receivedAt, quantity: quantityTotal(kind === 'label' ? line.shipped : line.received) }
    if (kind === 'quality') {
      const quality = workspace.productionDetails?.find(item => item.styleId === style.id && item.lineId === line.id)?.quality
      return quality?.category ? [{ ...common, itemKey: quality.category, name: quality.category }] : []
    }
    return (workspace.operations?.styleOperations.filter(item => item.styleId === style.id && item.kind === kind && !item.voided) || [])
      .flatMap(record => record.rows.map(row => ({ ...common, itemKey: row.id, name: [row.name, row.specification].filter(Boolean).join(' · ') })))
  })
  const recordFor = (lineId: string, itemKey: string, recordKind = kind) => workspace.processingUnitPrices?.find(item => item.styleId === style.id && item.lineId === lineId && item.kind === recordKind && item.itemKey === itemKey)
  const currentRecord = draft ? recordFor(draft.lineId, draft.itemKey, draft.kind) : undefined
  const stale = !!draft && ((currentRecord?.version || 0) !== draft.version || !items.some(item => item.lineId === draft.lineId && item.itemKey === draft.itemKey))
  useEffect(() => { onDirtyChange?.(!!draft || busy || refreshRequired); return () => onDirtyChange?.(false) }, [!!draft, busy, refreshRequired, onDirtyChange])
  if (!allowed) return null

  function begin(item: PriceItem) {
    if (!ready || busy || refreshRequired) return
    if (parentDirty) { setError('스타일에서 편집 중인 내용을 먼저 저장하거나 취소한 뒤 단가를 수정해 주세요.'); return }
    const record = recordFor(item.lineId, item.itemKey)
    setDraft({ lineId: item.lineId, itemKey: item.itemKey, kind, version: record?.version || 0, value: record?.unitCost == null ? '' : String(record.unitCost) })
    setReason(''); setError(''); setSuccess('')
  }
  async function refresh() {
    if (busy) return
    setBusy(true); setError('')
    try { await onRefresh(); setRefreshRequired(false) } catch { setError('최신 단가를 불러오지 못했습니다. 연결을 확인하고 다시 불러와 주세요.'); setRefreshRequired(true) }
    finally { setBusy(false) }
  }
  async function save() {
    if (!draft || busy || stale || !ready || !actor) return
    setError(''); setSuccess('')
    if (parentDirty) { setError('스타일에서 편집 중인 내용을 먼저 저장하거나 취소해 주세요.'); return }
    const value = draft.value.trim()
    if (value !== '' && (!/^\d+(?:\.\d{1,2})?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > 1_000_000_000)) { setError('단가는 0~1,000,000,000원 사이에서 소수 둘째 자리까지 입력해 주세요. 빈칸은 미입력으로 저장합니다.'); return }
    if (reason.trim().length < 2 || reason.length > 1000) { setError('단가 변경 사유를 2~1,000자로 입력해 주세요.'); return }
    setBusy(true)
    try {
      await saveProcessingUnitPrice(style.id, draft.lineId, draft.kind, draft.itemKey, value === '' ? null : Number(value), draft.version, reason.trim(), actor)
      setDraft(null); setReason(''); setSuccess('단가를 저장했습니다. 직접 수정하기 전까지 을지에 계속 적용됩니다.')
      try { await onRefresh(); setRefreshRequired(false) } catch { setError('단가는 저장됐지만 최신 화면을 불러오지 못했습니다. 다시 불러와 주세요.'); setRefreshRequired(true) }
    } catch (failure) { setError(message(failure)) }
    finally { setBusy(false) }
  }
  function cancel() { setDraft(null); setReason(''); setError('') }

  return <section className="processing-unit-prices" aria-label="가공·품질 단가 관리">
    <div className="section-heading"><div><h3>가공·품질 단가</h3><p className="muted">컬러와 작업별 단가를 저장하면 을지 N열에 계속 적용됩니다. 배정된 업체와 본사가 입력할 수 있습니다.</p></div><span className="pill">원 · 부가세 제외</span></div>
    <div className="processing-price-toolbar"><label className="field"><span className="field-label">단가 작업 구분</span><select className="select" aria-label="단가 작업 구분" value={kind} disabled={!!draft || busy} onChange={event => { setKind(event.target.value as ProcessingPriceKind); setError(''); setSuccess('') }}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><p>C열은 메인 생산의 실 입고일, R열은 {kind === 'label' ? '실 출고' : '실 입고'} 수량을 사용합니다.</p></div>
    {!ready ? <p className="processing-price-notice" role="status">단가 저장 기능을 준비 중입니다. 관리자가 설정을 완료하면 이곳에서 입력할 수 있습니다.</p> : <>
      <p className="processing-price-note">미입력 단가는 빈칸으로 유지합니다. 0원을 입력한 경우와 구분하며, 수량과 입고일은 메인 생산에서 관리합니다.</p>
      {stale && <div className="processing-price-conflict" role="status">다른 사용자가 이 단가나 작업을 변경했습니다. 입력한 내용은 유지됩니다. 편집을 취소하고 최신 내용을 다시 불러와 주세요.</div>}
      {error && <div className="error-message" role="alert">{error}</div>}{success && <div className="success-message" role="status">{success}</div>}
      {refreshRequired && <button className="button" type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={13}/>최신 단가 다시 불러오기</button>}
      {!items.length ? <div className="processing-price-empty">등록된 {labels[kind]} 작업이 없습니다. 본사에서 작업 내역을 등록하면 단가를 입력할 수 있습니다.</div> : <div className="processing-price-table-wrap"><table className="processing-price-table"><thead><tr><th>컬러 포함 품번</th><th>작업</th><th>실 입고일 · C</th><th>{kind === 'label' ? '실 출고' : '실 입고'} 수량 · R</th><th>단가 (원) · N</th><th>수정</th></tr></thead><tbody>{items.map(item => {
        const record = recordFor(item.lineId, item.itemKey), editing = !!draft && draft.lineId === item.lineId && draft.itemKey === item.itemKey
        const name = `${item.sku} ${item.name}`
        return <tr key={`${item.lineId}:${item.itemKey}`}><th scope="row">{item.sku}</th><td>{item.name}</td><td>{item.receivedAt || '미입력'}</td><td>{item.quantity.toLocaleString('ko-KR')}</td><td>{editing ? <input className="input" type="number" inputMode="decimal" aria-label={`${name} 단가`} min="0" max="1000000000" step="0.01" value={draft.value} disabled={busy} placeholder="미입력" onChange={event => setDraft(current => current ? { ...current, value: event.target.value } : current)}/> : <span>{record?.unitCost == null ? '미입력' : money(record.unitCost)}</span>}</td><td>{editing ? <span className="pill">편집 중</span> : <button type="button" className="button button-ghost" aria-label={`${name} 단가 수정`} disabled={!!draft || busy || refreshRequired} onClick={() => begin(item)}><Pencil size={12}/>단가 수정</button>}</td></tr>
      })}</tbody></table></div>}
      {draft && <div className="processing-price-footer"><label className="field"><span className="field-label">단가 변경 사유</span><input className="input" aria-label="가공·품질 단가 변경 사유" value={reason} maxLength={1000} disabled={busy} onChange={event => setReason(event.target.value)} placeholder="변경 사유를 두 글자 이상 입력하세요"/></label><div><button className="button" type="button" disabled={busy} onClick={cancel}>단가 편집 취소</button>{stale && <button className="button" type="button" disabled={busy} onClick={() => { cancel(); void refresh() }}>편집 취소 후 최신 단가 조회</button>}<button className="button button-primary" type="button" disabled={busy || stale || reason.trim().length < 2} onClick={() => void save()}><Save size={13}/>{busy ? '단가 저장 중…' : '단가 저장'}</button></div></div>}
    </>}
  </section>
}
