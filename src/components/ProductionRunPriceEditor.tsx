import { useEffect, useState } from 'react'
import type { Profile, Workspace } from '../lib/types'
import type { ProductionRun } from '../lib/production-ledger'
import { getProductionCondition, type ProductionMode } from '../lib/production-conditions'
import { configureProductionConditions } from '../lib/production-conditions-repository'
import { message } from '../lib/utils'
import './production-run-price.css'

interface Props {
  workspace: Workspace
  run: ProductionRun
  profile: Profile
  blocked?: boolean
  onChanged: () => Promise<unknown>
  onSaved?: () => void
  onDirtyChange?: (dirty: boolean) => void
}
const priceLabel = (value: number | null | undefined) => value == null ? '미입력' : `${value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원`

/** HQ's shared preapproval price reference. Final approved prices and financial
 * snapshots are never changed by this editor. */
export default function ProductionRunPriceEditor({ workspace, run, profile, blocked = false, onChanged, onSaved, onDirtyChange }: Props) {
  const actor = workspace.profiles.find(item => item.id === profile.id)
  const condition = getProductionCondition(workspace, run.id)
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [refreshRequired, setRefreshRequired] = useState(false)
  const [mode, setMode] = useState<ProductionMode | ''>(''), [price, setPrice] = useState(''), [reason, setReason] = useState('')
  const [versions, setVersions] = useState({ run: run.version, condition: condition.version })
  const [error, setError] = useState(''), [success, setSuccess] = useState('')
  const stale = editing && (run.version !== versions.run || condition.version !== versions.condition)
  const final = !!run.closedAt || !!condition.approval || condition.status === 'approved' || condition.status === 'closed'
  const eligible = !final && !condition.legacy && !['rejected', 'assignment_changed'].includes(condition.status)
  const modeLocked = !!condition.productionMode
  useEffect(() => { onDirtyChange?.(editing || busy || refreshRequired); return () => onDirtyChange?.(false) }, [editing, busy, refreshRequired, onDirtyChange])
  if (!actor?.active || !actor.approved || actor.role === 'factory' || workspace.productionConditionsAvailable !== true || condition.legacy) return null

  function begin() {
    if (blocked || busy || !eligible || refreshRequired) return
    setVersions({ run: run.version, condition: condition.version })
    setMode(condition.productionMode || ''); setPrice(condition.internalUnitCost == null ? '' : String(condition.internalUnitCost))
    setReason(''); setError(''); setSuccess(''); setEditing(true)
  }
  async function refresh() {
    if (busy) return
    setBusy(true); setError('')
    try { await onChanged(); setRefreshRequired(false); onSaved?.() } catch { setError('최신 단가 정보를 불러오지 못했습니다. 다시 불러와 주세요.') } finally { setBusy(false) }
  }
  async function save() {
    if (!editing || busy || stale || blocked || !eligible || !mode || reason.trim().length < 2 || reason.length > 1000) return
    const clean = price.trim()
    if (clean && (!/^\d+(?:\.\d{1,2})?$/.test(clean) || Number(clean) > 1_000_000_000)) { setError('검토 단가는 빈칸 또는 0~1,000,000,000원 범위에서 소수 둘째 자리까지 입력해 주세요.'); return }
    setBusy(true); setError(''); setSuccess('')
    let saved = false
    try {
      await configureProductionConditions(run.id, versions.run, versions.condition, mode, clean === '' ? null : Number(clean), reason.trim(), actor!)
      saved = true; setEditing(false)
      await onChanged(); setRefreshRequired(false)
      setSuccess('본사 검토 단가를 저장했습니다. 최종 승인 시 생산 단가가 확정됩니다.'); onSaved?.()
    } catch (failure) {
      if (saved) { setRefreshRequired(true); setError('검토 단가는 저장됐지만 최신 화면을 불러오지 못했습니다. 다시 불러온 뒤 확인해 주세요.') }
      else setError(message(failure))
    } finally { setBusy(false) }
  }
  return <section className="production-run-price" aria-label="생산 차수 본사 검토 단가">
    <div className="production-run-price-heading"><div><strong>{final ? '최종 승인 단가' : '차수 단가 · 본사 검토'}</strong><p>{final ? '승인·마감된 단가는 이 화면에서 수정하지 않습니다.' : '업체에 공개하지 않는 본사 검토 기준입니다. 본사 최종 승인 전에는 마감 금액에 적용되지 않습니다.'}</p></div><span>{priceLabel(final ? run.snapshot?.unitCost ?? run.unitCost : condition.internalUnitCost)}</span></div>
    {blocked && eligible && <p className="ledger-help">차수명·프로젝트·수량 등의 변경 내용을 먼저 저장한 뒤 이 화면에서 검토 단가를 입력해 주세요.</p>}
    {!editing && eligible && !refreshRequired && <button type="button" className="button" disabled={blocked || busy} onClick={begin}>본사 검토 단가 입력·수정</button>}
    {error && <div className="error-message" role="alert">{error}</div>}{success && <p className="success-message" role="status">{success}</p>}
    {refreshRequired && <button type="button" className="button" disabled={busy} onClick={() => void refresh()}>최신 차수 단가 다시 불러오기</button>}
    {editing && <div className="production-run-price-form">
      {stale && <div className="error-message" role="status">생산 차수나 검토 조건이 변경되었습니다. 입력 내용은 유지됩니다. 취소한 뒤 최신 조건에서 다시 입력해 주세요.</div>}
      <div className="form-grid"><label className="field"><span className="field-label">생산 방식</span><select className="select" aria-label="차수 단가 생산 방식" value={mode} disabled={busy || modeLocked} onChange={event => setMode(event.target.value as ProductionMode | '')}><option value="">생산 방식 선택</option><option value="full_package">완사입</option><option value="cmt">임가공 (CMT)</option></select></label><label className="field"><span className="field-label">차수 단가 · 본사 검토 (KRW)</span><input className="input" type="number" aria-label="차수 본사 검토 단가" min="0" max="1000000000" step="0.01" placeholder="빈칸은 미입력 · 0원은 0" value={price} disabled={busy} onChange={event => setPrice(event.target.value)}/></label></div>
      {modeLocked && <p className="ledger-help">이미 설정된 생산 방식을 유지하고 검토 단가만 저장합니다. 생산 방식 변경은 생산 조건 협의에서 확인해 주세요.</p>}
      <label className="field"><span className="field-label">단가 검토 사유</span><input className="input" aria-label="차수 단가 검토 사유" minLength={2} maxLength={1000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)}/></label>
      <div className="ledger-actions"><button type="button" className="button" disabled={busy} onClick={() => { setEditing(false); setError('') }}>차수 단가 입력 취소</button><button type="button" className="button button-primary" disabled={busy || blocked || stale || !eligible || !mode || reason.trim().length < 2 || reason.length > 1000} onClick={() => void save()}>{busy ? '저장 중…' : '본사 검토 단가 저장'}</button></div>
    </div>}
  </section>
}
