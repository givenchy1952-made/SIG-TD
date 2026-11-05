import { useEffect, useState } from 'react'
import { Check, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { Profile, Quantities, Workspace } from '../lib/types'
import { emptyQuantities, quantityTotal, SIZES } from '../lib/types'
import type { SupplierOrder } from '../lib/supplier-orders'
import { savePartialDeliveryPlan } from '../lib/partial-deliveries-repository'
import { totalPlanned, totalPlannedBySize, validatePartialDeliveries, type PartialDeliveryInstallment } from '../lib/partial-deliveries'
import { message } from '../lib/utils'
import './partial-deliveries.css'

interface Props {
  workspace: Workspace
  profile: Profile
  order: SupplierOrder
  onChanged: () => Promise<unknown>
  onDirtyChange?: (value: boolean) => void
  poDraftOpen?: boolean
}
const number = (value: number) => value.toLocaleString('ko-KR')

export default function PartialDeliveryPanel({ workspace, profile, order, onChanged, onDirtyChange, poDraftOpen = false }: Props) {
  const plan = workspace.partialDeliveryPlans?.find(item => item.runId === order.runId)
  const condition = workspace.productionConditions?.find(item => item.runId === order.runId)
  const run = workspace.productionRuns?.find(item => item.id === order.runId)
  const actor = workspace.profiles.find(item => item.id === profile.id)
  const hq = actor?.active && actor.approved && actor.role !== 'factory'
  const frozen = !!condition?.proposal || !!condition?.approval || !!condition?.legacy || condition?.status === 'rejected' || !!order.startedAt || !!run?.closedAt || !!workspace.productionReceipts?.some(item => item.runId === order.runId)
  const canEdit = hq && !frozen && !poDraftOpen && workspace.partialDeliveryAvailable === true
  const sizesReady = workspace.partialDeliverySizesAvailable === true
  const [draft, setDraft] = useState<PartialDeliveryInstallment[] | null>(null)
  const [version, setVersion] = useState(0), [runVersion, setRunVersion] = useState(0)
  const [reason, setReason] = useState(''), [mailConfirmed, setMailConfirmed] = useState(false)
  const [busy, setBusy] = useState(false), [refreshRequired, setRefreshRequired] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const dirty = !!draft || refreshRequired
  useEffect(() => { onDirtyChange?.(dirty || busy); return () => onDirtyChange?.(false) }, [dirty, busy, onDirtyChange])
  const quantity = quantityTotal(order.order), items = draft || plan?.items || []
  const sum = totalPlanned(items), sizeTotals = totalPlannedBySize(items)
  const hasSizes = items.some(item => !!item.quantities), hasLegacy = items.some(item => !item.quantities)
  const stale = !!draft && ((plan?.version || 0) !== version || (run?.version || order.runVersion) !== runVersion)
  const mailed = !!order.sentAt
  let validationError = ''
  if (draft) { try { validatePartialDeliveries(draft, order.order) } catch (failure) { validationError = message(failure) } }

  function begin() {
    if (!canEdit || busy || refreshRequired) return
    setDraft(plan ? structuredClone(plan.items) : [{ id: crypto.randomUUID(), dueDate: order.requestedDue || order.expectedDue || '', quantity, note: '', ...(sizesReady ? { quantities: { ...order.order } } : {}) }])
    setVersion(plan?.version || 0); setRunVersion(run?.version || order.runVersion)
    setMailConfirmed(false); setReason(''); setError(''); setNotice('')
  }
  function update(index: number, patch: Partial<PartialDeliveryInstallment>) {
    setDraft(current => current?.map((item, idx) => idx === index ? { ...item, ...patch } : item) || null)
    setError('')
  }
  function updateSize(index: number, size: keyof Quantities, value: string) {
    const quantities = { ...draft![index].quantities!, [size]: value === '' ? 0 : Number(value) }
    update(index, { quantities, quantity: quantityTotal(quantities) })
  }
  async function refresh() {
    if (busy) return
    setBusy(true); setError('')
    try { await onChanged(); setRefreshRequired(false) } catch { setError('최신 부분 납기 계획을 불러오지 못했습니다. 다시 불러와 주세요.') } finally { setBusy(false) }
  }
  async function save() {
    if (!draft || busy || !canEdit || stale || refreshRequired) return
    let saved = false
    try {
      validatePartialDeliveries(draft, order.order)
      if (draft.some(item => item.quantities) && !sizesReady) throw new Error('사이즈별 부분 납기 설정을 적용한 후 저장해 주세요.')
      if (mailed && !mailConfirmed) throw new Error('이미 발송한 PO의 부분 납기 변경 사항을 업체에 별도로 전달·확인할 필요가 있음을 확인해 주세요.')
      setBusy(true); setError('')
      await savePartialDeliveryPlan(order.runId, version, draft, reason, profile)
      saved = true; setDraft(null)
      await onChanged(); setRefreshRequired(false)
      setNotice('부분 납기 일정을 저장했습니다. 차수별 납기와 사이즈별 예정 수량을 확인해 주세요.')
    } catch (failure) {
      if (saved) { setRefreshRequired(true); setError('부분 납기 계획은 저장됐지만 최신 화면을 불러오지 못했습니다. 다시 불러온 뒤 확인해 주세요.') }
      else setError(message(failure))
    } finally { setBusy(false) }
  }
  return <section className="panel partial-delivery-panel" aria-label="분할 납기 계획">
    <div className="section-heading">
      <div><h3>부분 납기 · 파샬 입고 계획</h3><p className="muted">생산 오더 {number(quantity)}장을 차수별 납기와 XXS~XL 예정 수량으로 나눕니다. 실제 입고는 별도 기록입니다.</p></div>
      {canEdit && !draft && <button type="button" className="button" disabled={busy || refreshRequired} onClick={begin}>{plan ? '부분 납기 수정' : '부분 납기 등록'}</button>}
    </div>
    {poDraftOpen && <p className="muted">PO 초안 작성 중에는 부분 납기를 변경할 수 없습니다. 초안을 먼저 취소하거나 발송한 후 다시 수정해 주세요.</p>}
    {workspace.partialDeliveryAvailable !== true && <p className="muted">부분 납기 설정을 적용한 후 사용할 수 있습니다. 기존 생산 기록은 그대로 유지됩니다.</p>}
    {workspace.partialDeliveryAvailable === true && !sizesReady && <p className="partial-delivery-note" role="status">사이즈별 예정 수량 입력은 추가 설정(018) 적용 후 사용할 수 있습니다. 기존 총수량 계획은 유지됩니다.</p>}
    {hasLegacy && <p className="partial-delivery-note">기존 총수량 계획의 사이즈별 수량은 미등록입니다. 사이즈별 수량을 임의로 배분하지 않습니다.{draft && sizesReady ? ' 각 차수에서 사이즈 수량을 직접 입력한 뒤 저장하세요.' : ''}</p>}
    {stale && <p className="error-message" role="status">생산 차수 또는 부분 납기 계획이 변경되었습니다. 작성값은 유지됩니다. 취소한 뒤 최신 계획에서 다시 입력해 주세요.</p>}
    {draft && frozen && <p className="error-message" role="status">업체 회신·생산 시작·입고가 확인되어 저장할 수 없습니다. 작성값은 유지됩니다.</p>}
    {!!items.length && <div className="partial-delivery-table-wrap"><table className="partial-delivery-table" aria-label="차수별 부분 납기 일정"><thead><tr><th>납기 차수</th><th>납기일</th>{SIZES.map(size => <th key={size}>{size}</th>)}<th>예정 합계 (pcs)</th><th>비고</th>{draft && <th>관리</th>}</tr></thead><tbody>
      {items.map((item, index) => <tr key={item.id}><th>{index + 1}차</th><td>{draft ? <input className="input" aria-label={`${index + 1}차 납기일`} type="date" disabled={busy} value={item.dueDate} onChange={e => update(index, { dueDate: e.target.value })}/> : item.dueDate}</td>
        {SIZES.map(size => <td key={size}>{draft && item.quantities ? <input className="input" aria-label={`${index + 1}차 예정 수량 ${size}`} type="number" min="0" max="10000000" step="1" disabled={busy || !sizesReady} value={item.quantities[size]} onChange={e => updateSize(index, size, e.target.value)}/> : item.quantities ? number(item.quantities[size]) : <span className="muted" title="기존 계획의 사이즈별 수량 미등록">—</span>}</td>)}
        <td>{draft && !item.quantities && !sizesReady ? <input className="input" aria-label={`${index + 1}차 수량`} type="number" min="1" max="10000000" step="1" disabled={busy} value={item.quantity} onChange={e => update(index, { quantity: Number(e.target.value) })}/> : <output aria-label={`${index + 1}차 예정 수량 합계`}>{number(item.quantity)}</output>}</td>
        <td>{draft ? <input className="input" aria-label={`${index + 1}차 비고`} maxLength={500} disabled={busy} value={item.note} onChange={e => update(index, { note: e.target.value })}/> : item.note || '—'}</td>
        {draft && <td><div className="partial-delivery-row-actions">{!item.quantities && sizesReady && <button type="button" className="button" disabled={busy} onClick={() => update(index, { quantities: emptyQuantities(), quantity: 0 })}>{index + 1}차 사이즈별 수량 입력</button>}<button type="button" className="button button-ghost" aria-label={`${index + 1}차 납기 삭제`} disabled={busy || draft.length === 1} onClick={() => setDraft(current => current?.filter((_, idx) => idx !== index) || null)}><Trash2 size={14}/>삭제</button></div></td>}
      </tr>)}
    </tbody><tfoot><tr aria-label="사이즈별 전체 오더"><th colSpan={2}>전체 오더</th>{SIZES.map(size => <td key={size}>{number(order.order[size])}</td>)}<td>{number(quantity)}</td><td colSpan={draft ? 2 : 1}/></tr><tr aria-label="사이즈별 계획 합계"><th colSpan={2}>계획 합계</th>{SIZES.map(size => <td key={size} className={hasSizes && !hasLegacy && sizeTotals[size] !== order.order[size] ? 'partial-delivery-difference' : ''}>{hasSizes ? number(sizeTotals[size]) : '—'}</td>)}<td>{number(sum)}</td><td colSpan={draft ? 2 : 1}>{hasLegacy ? '사이즈 미등록 차수 포함' : '사이즈별 합계 확인'}</td></tr></tfoot></table></div>}
    {!!items.length && <p className={sum === quantity ? 'muted' : 'error-message'} role="status">부분 납기 합계: {number(sum)} / 전체 오더: {number(quantity)} pcs {sum === quantity ? '· 총수량 일치' : `· 차이 ${number(quantity - sum)}장`}</p>}
    {draft && <>
      <button type="button" className="button" disabled={busy || draft.length >= 24} onClick={() => setDraft(current => current ? [...current, { id: crypto.randomUUID(), dueDate: current.at(-1)?.dueDate || '', quantity: 0, note: '', ...(sizesReady ? { quantities: emptyQuantities() } : {}) }] : null)}><Plus size={14}/>납기 차수 추가</button>
      {validationError && <p className="error-message" role="status">{validationError}</p>}
      {mailed && <label className="partial-delivery-mail-confirm"><input type="checkbox" checked={mailConfirmed} disabled={busy} onChange={e => setMailConfirmed(e.target.checked)}/><span>발송된 PO 원본은 변경되지 않습니다. 부분 납기 변경 내용을 업체에 별도 고지하고 확인할 필요가 있음을 이해했습니다.</span></label>}
      <label className="field"><span className="field-label">부분 납기 등록·변경 사유</span><input className="input" aria-label="부분 납기 등록·변경 사유" value={reason} disabled={busy} maxLength={1000} onChange={e => setReason(e.target.value)} placeholder="변경 사유를 두 글자 이상 입력하세요"/></label>
      <div className="supplier-order-actions"><button type="button" className="button" disabled={busy} onClick={() => { setDraft(null); setError('') }}>취소</button><button type="button" className="button button-primary" disabled={busy || !canEdit || stale || refreshRequired || !!validationError || reason.trim().length < 2 || mailed && !mailConfirmed} onClick={() => void save()}><Check size={14}/>{busy ? '저장 중…' : '부분 납기 저장'}</button></div>
    </>}
    {refreshRequired && <button type="button" className="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14}/>최신 부분 납기 다시 불러오기</button>}
    {frozen && !!plan && <p className="muted">업체 생산 조건 회신 이후에는 기존 부분 납기 계획을 변경할 수 없습니다. 조건 변경은 별도 재협의 절차를 이용해 주세요.</p>}
    {error && <p className="error-message" role="alert">{error}</p>}
    {notice && <p className="success-message" role="status">{notice}</p>}
  </section>
}
