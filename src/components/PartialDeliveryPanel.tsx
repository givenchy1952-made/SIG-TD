import { useEffect, useState } from 'react'
import { Check, Plus, Trash2 } from 'lucide-react'
import type { Profile, Workspace } from '../lib/types'
import { quantityTotal } from '../lib/types'
import type { SupplierOrder } from '../lib/supplier-orders'
import { savePartialDeliveryPlan } from '../lib/partial-deliveries-repository'
import { totalPlanned, validatePartialDeliveries, type PartialDeliveryInstallment } from '../lib/partial-deliveries'
import { message } from '../lib/utils'

interface Props {
  workspace: Workspace
  profile: Profile
  order: SupplierOrder
  onChanged: () => Promise<unknown>
  onDirtyChange?: (value: boolean) => void
}
const number = (value: number) => value.toLocaleString('ko-KR')

export default function PartialDeliveryPanel({ workspace, profile, order, onChanged, onDirtyChange }: Props) {
  const plan = workspace.partialDeliveryPlans?.find(item => item.runId === order.runId)
  const condition = workspace.productionConditions?.find(item => item.runId === order.runId)
  const run = workspace.productionRuns?.find(item => item.id === order.runId)
  const actor = workspace.profiles.find(item => item.id === profile.id)
  const hq = actor?.active && actor.approved && actor.role !== 'factory'
  const frozen = !!condition?.proposal || !!condition?.approval || !!condition?.legacy || condition?.status === 'rejected' || !!order.startedAt || !!run?.closedAt || !!workspace.productionReceipts?.some(item => item.runId === order.runId)
  const canEdit = hq && !frozen && workspace.partialDeliveryAvailable === true
  const [draft, setDraft] = useState<PartialDeliveryInstallment[] | null>(null)
  const [version, setVersion] = useState(0)
  const [reason, setReason] = useState('')
  const [mailConfirmed, setMailConfirmed] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const dirty = !!draft
  useEffect(() => { onDirtyChange?.(dirty || busy); return () => onDirtyChange?.(false) }, [dirty, busy, onDirtyChange])
  const quantity = quantityTotal(order.order)
  const items = draft || plan?.items || []
  const sum = totalPlanned(items)
  const mailed = !!order.sentAt
  function begin() {
    if (!canEdit) return
    setDraft(plan ? structuredClone(plan.items) : [{
      id: crypto.randomUUID(), dueDate: order.requestedDue || order.expectedDue || '', quantity, note: '',
    }])
    setVersion(plan?.version || 0)
    setMailConfirmed(false); setReason(''); setError(''); setNotice('')
  }
  function update(index: number, patch: Partial<PartialDeliveryInstallment>) {
    setDraft(current => current?.map((item, idx) => idx === index ? { ...item, ...patch } : item) || null)
    setError('')
  }
  async function save() {
    if (!draft || busy || !canEdit) return
    try {
      validatePartialDeliveries(draft, quantity)
      if (mailed && !mailConfirmed) throw new Error('이미 발송한 PO의 부분 납기 변경 사항을 업체에 별도로 전달·확인할 필요가 있음을 확인해 주세요.')
      setBusy(true); setError('')
      await savePartialDeliveryPlan(order.runId, version, draft, reason, profile)
      setDraft(null)
      await onChanged()
      setNotice('부분 납기 일정을 저장했습니다. 업체 회신 전에 1·2차 납기와 수량을 확인해 주세요.')
    } catch (failure) { setError(message(failure)) }
    finally { setBusy(false) }
  }
  return <section className="panel" aria-label="분할 납기 계획" style={{ marginTop: 14, padding: 16 }}>
    <div className="section-heading">
      <div><h3>부분 납기 · 파샬 입고 계획</h3><p className="muted">생산 오더는 {number(quantity)}장 그대로 유지하고, 납기 일정만 1차·2차 등으로 분리합니다. 실제 입고는 별도 기록입니다.</p></div>
      {canEdit && !draft && <button type="button" className="button" onClick={begin}>{plan ? '부분 납기 수정' : '부분 납기 등록'}</button>}
    </div>
    {workspace.partialDeliveryAvailable !== true && <p className="muted">분할 납기 설정을 적용한 후 사용할 수 있습니다. 기존 생산 기록은 그대로 유지됩니다.</p>}
    {!!items.length && <div className="table-wrap"><table className="data-table" aria-label="차수별 부분 납기 일정"><thead><tr><th>납기 차수</th><th>납기일</th><th>예정 수량 (pcs)</th><th>비고</th>{draft && <th>관리</th>}</tr></thead><tbody>
      {items.map((item, index) => <tr key={item.id}><th>{index + 1}차</th><td>{draft ? <input className="input" aria-label={`${index + 1}차 납기일`} type="date" disabled={busy} value={item.dueDate} onChange={e => update(index, { dueDate: e.target.value })}/> : item.dueDate}</td>
      <td>{draft ? <input className="input" aria-label={`${index + 1}차 수량`} type="number" min="1" step="1" disabled={busy} value={item.quantity} onChange={e => update(index, { quantity: Number(e.target.value) })}/> : number(item.quantity)}</td>
      <td>{draft ? <input className="input" aria-label={`${index + 1}차 비고`} maxLength={500} disabled={busy} value={item.note} onChange={e => update(index, { note: e.target.value })}/> : item.note || '—'}</td>
      {draft && <td><button type="button" className="button button-ghost" disabled={busy || draft.length === 1} onClick={() => setDraft(current => current?.filter((_, idx) => idx !== index) || null)}><Trash2 size={14}/>삭제</button></td>}</tr>)}
    </tbody></table></div>}
    {!!items.length && <p className={sum === quantity ? 'muted' : 'error-message'} role="status">부분 납기 합계: {number(sum)} / 전체 오더: {number(quantity)} pcs {sum === quantity ? '· 수량 일치' : `· 차이 ${number(quantity - sum)}장`}</p>}
    {draft && <>
      <button type="button" className="button" disabled={busy || draft.length >= 24} onClick={() => setDraft(current => current ? [...current, { id: crypto.randomUUID(), dueDate: current.at(-1)?.dueDate || '', quantity: 0, note: '' }] : null)}><Plus size={14}/>납기 차수 추가</button>
      {mailed && <label style={{ display: 'flex', gap: 8, margin: '10px 0' }}><input type="checkbox" checked={mailConfirmed} disabled={busy} onChange={e => setMailConfirmed(e.target.checked)}/><span>발송된 PO 원본은 변경되지 않습니다. 분할 납기 변경 내용을 업체에 별도 고지하고 확인할 필요가 있음을 이해했습니다.</span></label>}
      <label className="field"><span className="field-label">부분 납기 등록·변경 사유</span><input className="input" value={reason} disabled={busy} maxLength={1000} onChange={e => setReason(e.target.value)} placeholder="변경 사유를 두 글자 이상 입력하세요"/></label>
      <div className="supplier-order-actions"><button type="button" className="button" disabled={busy} onClick={() => { setDraft(null); setError('') }}>취소</button><button type="button" className="button button-primary" disabled={busy || sum !== quantity || reason.trim().length < 2 || mailed && !mailConfirmed} onClick={() => void save()}><Check size={14}/>{busy ? '저장 중…' : '부분 납기 저장'}</button></div>
    </>}
    {frozen && !!plan && <p className="muted">업체 생산 조건 회신 이후에는 기존 부분 납기 계획을 변경할 수 없습니다. 조건 변경은 별도 재협의 절차를 이용해 주세요.</p>}
    {error && <p className="error-message" role="alert">{error}</p>}
    {notice && <p className="success-message" role="status">{notice}</p>}
  </section>
}
