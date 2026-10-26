import { useEffect, useState } from 'react'
import { Download, FileCheck2, History, LockKeyhole, Pencil, Plus, Save, X } from 'lucide-react'
import { emptyQuantities, quantityTotal, SIZES, type Profile, type Quantities, type Style } from '../lib/types'
import type { ProductionLedgerWorkspace, ProductionRun, ProductionRunInput } from '../lib/production-ledger'
import { allocateProductionReceipt, finalizeProductionRun, saveProductionRun, voidProductionReceipt } from '../lib/production-ledger-repository'
import { buildProductionRunEuljiRows } from '../lib/production-ledger-export'
import { fillSigEuljiTemplate, loadBundledSigEuljiTemplate } from '../lib/sig-eulji'
import { message } from '../lib/utils'
import { hasProductionRunStartProof, type SupplierOrderFields } from '../lib/supplier-orders'
import './production-ledger.css'

export interface ProductionLedgerPanelProps {
  workspace: ProductionLedgerWorkspace & SupplierOrderFields
  style: Style
  actor: Profile
  onChanged: () => Promise<unknown>
  onDirtyChange?: (dirty: boolean) => void
}
interface Draft { id: string; lineId: string; version: number; data: ProductionRunInput; cost: string }
interface ReceiptDraft { receivedAt: string; quantities: Quantities; runVersion: number }
const money = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 3 })
const time = (value: string) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' })
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })

function SizeInputs({ value, onChange, disabled, label }: { value: Quantities; onChange: (next: Quantities) => void; disabled?: boolean; label: string }) {
  return <div className="ledger-quantity-table"><table><thead><tr><th>구분</th>{SIZES.map(size => <th key={size}>{size}</th>)}<th>합계</th></tr></thead><tbody><tr><th>{label}</th>{SIZES.map(size => <td key={size}><input className="input" aria-label={`${label} ${size}`} type="number" min="0" max="10000000" step="1" value={value[size]} disabled={disabled} onChange={event => onChange({ ...value, [size]: event.target.value === '' ? 0 : Number(event.target.value) })} /></td>)}<td><strong>{money(quantityTotal(value))}</strong></td></tr></tbody></table></div>
}

export default function ProductionLedgerPanel({ workspace, style, actor, onChanged, onDirtyChange }: ProductionLedgerPanelProps) {
  const [selectedId, setSelectedId] = useState(''), [projectFilter, setProjectFilter] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null), [receiptDraft, setReceiptDraft] = useState<ReceiptDraft | null>(null)
  const [reason, setReason] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false), [confirmClose, setConfirmClose] = useState(false), [closingVersion, setClosingVersion] = useState(0)
  const allRuns = (workspace.productionRuns || []).filter(run => run.styleId === style.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.round - left.round)
  const filtered = allRuns.filter(run => !projectFilter || run.projectId === projectFilter)
  const selected = allRuns.find(run => run.id === selectedId) || (!selectedId ? filtered[0] : undefined)
  const line = style.production.find(item => item.id === (draft?.lineId || selected?.lineId))
  const receipts = (workspace.productionReceipts || []).filter(item => item.runId === selected?.id).sort((left, right) => right.receivedAt.localeCompare(left.receivedAt) || right.createdAt.localeCompare(left.createdAt))
  const activeReceipts = receipts.filter(item => !item.voided)
  const orderState = workspace.supplierProductionOrders?.find(item => item.runId === selected?.id)
  const started = workspace.supplierOrdersAvailable !== true || hasProductionRunStartProof(orderState)
  const received = activeReceipts.reduce((sum, item) => sum + quantityTotal(item.quantities), 0)
  const stale = !!draft && (allRuns.find(run => run.id === draft.id)?.version || 0) !== draft.version
  const receiptStale = !!receiptDraft && receiptDraft.runVersion !== selected?.version
  const closingStale = confirmClose && closingVersion !== selected?.version
  const changing = !!draft || !!receiptDraft || busy
  const person = workspace.profiles.find(profile => profile.id === actor.id)
  const canManage = !!person?.active && person.approved && person.role !== 'factory'
  const audits = (workspace.productionRunAudits || []).filter(item => item.runId === selected?.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  useEffect(() => { onDirtyChange?.(changing); return () => onDirtyChange?.(false) }, [changing, onDirtyChange])
  if (!canManage) return null

  function clearMessages() { setError(''); setNotice(''); setConfirmClose(false); setReason('') }
  function begin(run?: ProductionRun, corrects?: ProductionRun) {
    clearMessages(); setReceiptDraft(null)
    if (run) { setSelectedId(run.id); setDraft({ id: run.id, lineId: run.lineId, version: run.version, data: { name: run.name, projectId: run.projectId, projectCode: run.projectCode, expectedDue: run.expectedDue, poId: run.poId, unitCost: run.unitCost, itemType: run.itemType, order: { ...run.order }, correctsRunId: run.correctsRunId }, cost: run.unitCost === null ? '' : String(run.unitCost) }); return }
    const projectId = corrects?.projectId || style.projectId, project = workspace.projects.find(item => item.id === projectId)
    const target = style.production.find(item => item.id === corrects?.lineId) || style.production[0]
    setDraft({ id: crypto.randomUUID(), lineId: target?.id || '', version: 0, cost: '', data: { name: corrects ? `${corrects.name} 정정 생산` : '신규 생산', projectId, projectCode: project?.code || corrects?.projectCode || '', expectedDue: '', poId: null, unitCost: null, itemType: corrects?.itemType || 'product', order: emptyQuantities(), correctsRunId: corrects?.id || null } })
  }
  function update(data: Partial<ProductionRunInput>) { setDraft(current => current ? { ...current, data: { ...current.data, ...data } } : null) }
  async function perform(action: () => Promise<void>, success: string, after?: () => void) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    let saved = false
    try { await action(); saved = true; after?.(); setReason(''); setConfirmClose(false); await onChanged(); setNotice(success) }
    catch (failure) { setError(saved ? `저장은 완료되었으나 최신 목록을 불러오지 못했습니다. 다시 접속해 확인해 주세요. ${message(failure)}` : message(failure)) }
    finally { setBusy(false) }
  }
  async function save() {
    if (!draft || stale) return
    const value = draft.cost.trim()
    if (value && (!/^\d+(\.\d{1,2})?$/.test(value) || Number(value) > 1_000_000_000)) { setError('차수 단가는 미입력 또는 0~1,000,000,000의 소수 둘째 자리까지 입력해 주세요.'); return }
    const id = draft.id
    await perform(() => saveProductionRun(id, style.id, draft.lineId, { ...draft.data, unitCost: value === '' ? null : Number(value) }, draft.version, reason, actor), '생산 차수를 저장했습니다.', () => { setDraft(null); setSelectedId(id) })
  }
  async function download(run: ProductionRun) {
    const preview = buildProductionRunEuljiRows(workspace, [run.id], actor)
    if (preview.errors.length) { setError(preview.errors.join(' ')); return }
    setBusy(true); setError('')
    try {
      const bytes = await fillSigEuljiTemplate(await loadBundledSigEuljiTemplate(), preview.rows)
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })), anchor = document.createElement('a')
      anchor.href = url; anchor.download = `SIG_을지_${run.projectCode}_${run.round}차_확정.xlsx`.replace(/[\\/:*?"<>|]/g, '_'); document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice('확정 당시 단가·입고 수량·업체·담당자로 작성한 을지를 다운로드했습니다.')
    } catch (failure) { setError(message(failure)) } finally { setBusy(false) }
  }
  return <section className="production-ledger" aria-label="프로젝트별 생산 차수 및 마감">
    <div className="section-heading"><div><h2><FileCheck2 size={18} />프로젝트·차수별 생산과 마감</h2><p className="muted">같은 품번도 프로젝트와 생산 차수마다 오더·단가·실입고를 구분합니다.</p></div>{workspace.productionLedgerAvailable === true && <button type="button" className="button button-primary" disabled={changing || !style.production.length} onClick={() => begin()}><Plus size={14} />생산 차수 추가</button>}</div>
    {workspace.productionLedgerAvailable !== true ? <div className="error-message" role="status">관리자가 007_production_ledger.sql을 적용하면 생산 차수별 단가·입고·마감 확정을 사용할 수 있습니다.</div> : <>
      <p className="ledger-help">기존 메인 생산의 누적 수량과 별도로 기록합니다. 실제 입고를 차수에 한 번만 입력해 주세요. 마감 확정 후에는 해당 차수의 단가·입고·마감 금액을 변경할 수 없습니다.</p>
      {error && <div className="error-message" role="alert">{error}</div>}{notice && <div className="success-message" role="status">{notice}</div>}
      <div className="ledger-layout"><aside className="ledger-runs"><label className="field"><span className="field-label">생산 차수 프로젝트</span><select className="select" aria-label="생산 차수 프로젝트 필터" value={projectFilter} disabled={changing} onChange={event => { setProjectFilter(event.target.value); setSelectedId(''); clearMessages() }}><option value="">전체 프로젝트</option>{workspace.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
        {!filtered.length && <p className="ledger-empty">아직 등록된 생산 차수가 없습니다.</p>}
        {filtered.map(run => <button type="button" className={`ledger-run ${selected?.id === run.id && !draft ? 'active' : ''}`} key={run.id} disabled={changing} onClick={() => { setSelectedId(run.id); clearMessages() }}><span>{workspace.projects.find(item => item.id === run.projectId)?.name || run.projectCode}</span><strong>{run.round}차 · {run.name}</strong><small>{style.production.find(item => item.id === run.lineId)?.color || ''} / {money(quantityTotal(run.order))} {run.itemType === 'fabric' ? 'YDS' : 'EA'}</small><small>{run.closedAt ? '마감 확정' : '마감 전'} · 단가 {run.unitCost === null ? '미입력' : `${money(run.unitCost)}원`}</small></button>)}
      </aside><div className="ledger-content">
        {draft ? <section className="ledger-card" aria-label="생산 차수 편집"><h3>{draft.version ? '생산 차수 수정' : '생산 차수 등록'}</h3>{stale && <div className="error-message" role="alert">다른 사용자가 차수를 변경했습니다. 편집을 취소하고 최신 내용을 확인해 주세요.</div>}
          <div className="form-grid"><label className="field"><span className="field-label">차수명</span><input className="input" aria-label="생산 차수명" value={draft.data.name} maxLength={120} disabled={busy} onChange={event => update({ name: event.target.value })}/></label>
          <label className="field"><span className="field-label">생산 컬러</span><select className="select" aria-label="생산 차수 컬러" value={draft.lineId} disabled={busy || draft.version > 0} onChange={event => setDraft(current => current ? { ...current, lineId: event.target.value } : null)}>{style.production.map(item => <option key={item.id} value={item.id}>{item.color}</option>)}</select></label>
          <label className="field"><span className="field-label">프로젝트</span><select className="select" aria-label="생산 차수 프로젝트" value={draft.data.projectId} disabled={busy} onChange={event => update({ projectId: event.target.value, projectCode: workspace.projects.find(item => item.id === event.target.value)?.code || '' })}><option value="">프로젝트 선택</option>{workspace.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="field"><span className="field-label">프로젝트 코드</span><input className="input" aria-label="생산 차수 프로젝트 코드" value={draft.data.projectCode} maxLength={120} disabled={busy} onChange={event => update({ projectCode: event.target.value })}/></label>
          <label className="field"><span className="field-label">본사 요청 납기일</span><input className="input" type="date" aria-label="생산 차수 요청 납기일" value={draft.data.expectedDue} disabled={busy} onChange={event => update({ expectedDue: event.target.value })}/></label>
          <label className="field"><span className="field-label">연결 PO</span><select className="select" aria-label="생산 차수 PO" value={draft.data.poId || ''} disabled={busy} onChange={event => update({ poId: event.target.value || null })}><option value="">미연결 · PO 작성 후 연결</option>{(workspace.operations?.poDispatches || []).filter(po => po.styleId === style.id && !po.voided).map(po => <option key={po.id} value={po.id}>{po.subject} · {po.status === 'sent' ? '발송됨' : '미발송'}</option>)}</select></label>
          <label className="field"><span className="field-label">차수 단가 (KRW)</span><input className="input" type="number" aria-label="생산 차수 단가" min="0" max="1000000000" step="0.01" value={draft.cost} placeholder="빈칸은 미입력" disabled={busy} onChange={event => setDraft(current => current ? { ...current, cost: event.target.value } : null)}/></label>
          <label className="field"><span className="field-label">품목</span><select className="select" aria-label="생산 차수 품목" value={draft.data.itemType} disabled={busy} onChange={event => update({ itemType: event.target.value as ProductionRunInput['itemType'] })}><option value="product">제품 · EA</option><option value="fabric">원단 · YDS</option><option value="label">라벨 · EA</option></select></label></div>
          {draft.data.correctsRunId && <p className="ledger-help">확정된 이전 차수는 보존하고, 별도의 정정 생산 차수로 연결합니다.</p>}
          <SizeInputs label="차수 오더" value={draft.data.order} disabled={busy} onChange={order => update({ order })}/>
          <label className="field"><span className="field-label">생산 차수 변경 사유</span><input className="input" aria-label="생산 차수 변경 사유" value={reason} maxLength={1000} disabled={busy} onChange={event => setReason(event.target.value)}/></label>
          <div className="ledger-actions"><button type="button" className="button" disabled={busy} onClick={() => { setDraft(null); clearMessages() }}><X size={13}/>차수 편집 취소</button><button type="button" className="button button-primary" disabled={busy || stale || reason.trim().length < 2 || !draft.data.projectId || !draft.lineId || !draft.data.name.trim()} onClick={() => void save()}><Save size={13}/>차수 저장</button></div>
        </section> : selected ? <>
          <section className="ledger-card"><div className="section-heading"><div><h3>{selected.round}차 · {selected.name}{selected.closedAt && <LockKeyhole size={14}/>}</h3><p className="muted">{selected.projectCode} · {line?.color} · {selected.factoryNameSnapshot} · 담당 {selected.ownerNameSnapshot || '미지정'}</p></div><div className="ledger-actions">{selected.closedAt ? <><button type="button" className="button" disabled={changing} onClick={() => begin(undefined, selected)}><Plus size={13}/>정정 차수 추가</button><button type="button" className="button" disabled={changing} onClick={() => void download(selected)}><Download size={13}/>확정 을지 다운로드</button></> : <button type="button" className="button" disabled={changing} onClick={() => begin(selected)}><Pencil size={13}/>차수 수정</button>}</div></div>
            <div className="ledger-summary"><span>오더 수량<strong>{money(quantityTotal(selected.order))}</strong></span><span>차수 실입고<strong>{money(selected.snapshot?.receivedQuantity ?? received)}</strong></span><span>차수 단가<strong>{selected.unitCost === null ? '미입력' : `${money(selected.snapshot?.unitCost ?? selected.unitCost)}원`}</strong></span><span>금액 · 부가세 제외<strong>{selected.snapshot ? `${money(selected.snapshot.netAmount)}원` : selected.unitCost === null ? '미입력' : `${money(Math.round(selected.unitCost * 100) * received / 100)}원`}</strong></span></div>
            <p className="ledger-help">본사 요청 납기 {selected.expectedDue || '미입력'} · {selected.poId ? 'PO 연결됨' : 'PO 미연결'}{selected.closedAt ? ` · ${time(selected.closedAt)} 마감 확정` : ' · 마감 전'}</p>
            {!selected.closedAt && !started && <p className="ledger-help">PO를 발송하고 업체가 예상 납기일과 생산 동의를 제출하면 생산이 시작되며 실입고와 마감을 기록할 수 있습니다.</p>}
            {!selected.closedAt && started && orderState?.status === 'assignment_changed' && <p className="ledger-help">현재 담당 공장과 다른 이전 생산 차수입니다. 이 차수에 기록된 원래 업체의 PO·생산 동의와 단가를 기준으로 정산합니다.</p>}
            <SizeInputs label="차수 오더" value={selected.order} disabled onChange={() => undefined}/>
          </section>
          <section className="ledger-card" aria-label="생산 차수 실입고"><div className="section-heading"><div><h3>차수별 실제 입고</h3><p className="muted">단가와 실제 입고일·수량을 입고 건마다 보존합니다.</p></div>{person?.role === 'admin' && !selected.closedAt && !receiptDraft && <button type="button" className="button" disabled={busy || !started} onClick={() => { setReceiptDraft({ receivedAt: today(), quantities: emptyQuantities(), runVersion: selected.version }); clearMessages() }}><Plus size={13}/>실입고 추가</button>}</div>
            {receiptDraft && <div className="ledger-receipt-editor"><label className="field"><span className="field-label">실입고일</span><input className="input" aria-label="차수 실입고일" type="date" value={receiptDraft.receivedAt} disabled={busy} onChange={event => setReceiptDraft(current => current ? { ...current, receivedAt: event.target.value } : null)}/></label>{receiptStale && <div className="error-message" role="alert">생산 차수가 변경되었습니다. 입고 입력을 취소하고 최신 단가·수량을 확인해 주세요.</div>}<SizeInputs label="추가 실입고" value={receiptDraft.quantities} disabled={busy} onChange={quantities => setReceiptDraft(current => current ? { ...current, quantities } : null)}/><label className="field"><span className="field-label">실입고 등록 사유</span><input className="input" aria-label="실입고 등록 사유" value={reason} maxLength={1000} disabled={busy} onChange={event => setReason(event.target.value)}/></label><div className="ledger-actions"><button type="button" className="button" disabled={busy} onClick={() => { setReceiptDraft(null); clearMessages() }}>입고 입력 취소</button><button type="button" className="button button-primary" disabled={busy || receiptStale || reason.trim().length < 2 || !receiptDraft.receivedAt || quantityTotal(receiptDraft.quantities) <= 0} onClick={() => void perform(() => allocateProductionReceipt(crypto.randomUUID(), selected.id, { receivedAt: receiptDraft.receivedAt, quantities: receiptDraft.quantities }, receiptDraft.runVersion, reason, actor), '차수 실제 입고를 기록했습니다.', () => setReceiptDraft(null))}><Save size={13}/>실입고 저장</button></div></div>}
            {!receipts.length ? <p className="ledger-empty">기록된 실제 입고가 없습니다.</p> : <div className="ledger-quantity-table"><table><thead><tr><th>실입고일</th>{SIZES.map(size => <th key={size}>{size}</th>)}<th>합계</th><th>기록 단가</th><th>부가세 제외</th><th>상태</th></tr></thead><tbody>{receipts.map(receipt => <tr key={receipt.id} className={receipt.voided ? 'ledger-voided' : ''}><td>{receipt.receivedAt}</td>{SIZES.map(size => <td key={size}>{money(receipt.quantities[size])}</td>)}<td>{money(quantityTotal(receipt.quantities))}</td><td>{money(receipt.unitCost)}</td><td>{money(receipt.netAmount)}</td><td>{receipt.voided ? '무효' : '유효'}{person?.role === 'admin' && !selected.closedAt && !receipt.voided && <button type="button" className="button" disabled={changing || reason.trim().length < 2} onClick={() => void perform(() => voidProductionReceipt(receipt.id, selected.id, receipt.version, selected.version, reason, actor), '실입고 기록을 무효 처리했습니다. 이력은 보존됩니다.')}>입고 무효</button>}</td></tr>)}</tbody></table></div>}
          </section>
          {!selected.closedAt && !receiptDraft && <section className="ledger-card" aria-label="생산 마감 확정"><h3>마감 확정</h3><p className="ledger-help">확정 시 단가·실입고·프로젝트·업체·담당자와 금액을 보관합니다. 이후 단가를 변경하거나 새 프로젝트로 재생산해도 이 금액은 유지됩니다. 입고 기록을 무효 처리할 때도 아래 사유를 입력해 주세요.</p><label className="field"><span className="field-label">마감·입고 무효 사유</span><input className="input" aria-label="생산 마감 사유" value={reason} maxLength={1000} disabled={busy} onChange={event => setReason(event.target.value)}/></label><label className="ledger-confirm"><input type="checkbox" aria-label="생산 마감 확정 확인" checked={confirmClose} disabled={busy} onChange={event => { setConfirmClose(event.target.checked); setClosingVersion(selected.version) }}/>입고 수량과 단가를 확인했으며 이 차수를 확정합니다.</label>{closingStale && <div className="error-message" role="alert">생산 차수가 변경되었습니다. 최신 내용을 확인한 뒤 마감 확인을 다시 체크해 주세요.</div>}<div className="ledger-actions"><button type="button" className="button button-primary" disabled={busy || !started || closingStale || !confirmClose || reason.trim().length < 2 || !activeReceipts.length || selected.unitCost === null} onClick={() => void perform(() => finalizeProductionRun(selected.id, closingVersion, reason, actor), '생산 차수의 마감 금액을 확정했습니다.')}><LockKeyhole size={13}/>마감 확정</button></div></section>}
          {!!audits.length && <details className="ledger-history"><summary><History size={13}/>생산 차수 변경 이력 ({audits.length})</summary>{audits.slice(0, 50).map(audit => <div key={audit.id}><strong>{audit.action} · {audit.actorName} · {time(audit.createdAt)}</strong><p>{audit.reason}</p></div>)}</details>}
        </> : <div className="ledger-card ledger-empty">생산 차수를 추가해 프로젝트와 차수별로 관리하세요.</div>}
      </div></div>
    </>}
  </section>
}
