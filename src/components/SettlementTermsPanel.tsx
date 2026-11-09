import { useEffect, useState } from 'react'
import { FileSpreadsheet, History, Pencil, Save } from 'lucide-react'
import type { Profile, Style, Workspace } from '../lib/types'
import { quantityTotal } from '../lib/types'
import type { SettlementTermsInput } from '../lib/settlement-types'
import { message } from '../lib/utils'
import { resolveApprovedSettlementPrice } from '../lib/settlement-approved-price'
import { fullStyleSku } from '../lib/style-identity'
import { getProjectIdentity } from '../lib/project-identity'
import './settlement-terms.css'

export interface SettlementTermsPanelProps {
  style: Style
  workspace: Workspace
  profile: Profile
  onSaveSettlementTerms: (styleId: string, lineId: string, data: SettlementTermsInput, expectedVersion: number, reason: string) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
  activeLineId?: string
  activeProjectId?: string
  activeRunId?: string
  selectionBlocked?: boolean
  onSelectLine?: (lineId: string) => void
  onSelectRun?: (runId: string, projectId: string) => void
}
interface Draft { version: number; projectCode: string; unitCost: string; itemType: SettlementTermsInput['itemType'] }
const amount = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 3 })
const dateTime = (value: string) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' })
const typeLabel = { product: '제품', fabric: '원단', label: '라벨' }

export default function SettlementTermsPanel({ style, workspace, profile, onSaveSettlementTerms, onDirtyChange, activeLineId, activeProjectId, activeRunId, selectionBlocked = false, onSelectLine, onSelectRun }: SettlementTermsPanelProps) {
  const [lineId, setLineId] = useState(activeLineId || style.production[0]?.id || '')
  const [selectedRunId, setSelectedRunId] = useState(activeRunId || '')
  const [selectedProjectId, setSelectedProjectId] = useState(activeProjectId || style.projectId)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [reason, setReason] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false)
  const line = style.production.find(item => item.id === lineId) || (!lineId ? style.production[0] : undefined)
  const price = resolveApprovedSettlementPrice(workspace, style.id, line?.id || '', { projectId: activeProjectId || selectedProjectId, runId: activeRunId || selectedRunId || undefined })
  const run = price.run
  const runOptions = (workspace.productionRuns || []).filter(item => item.styleId === style.id && item.lineId === line?.id && (!activeProjectId || (item.closedAt && item.snapshot ? item.snapshot.projectId : item.projectId) === activeProjectId))
  const record = workspace.settlementTerms?.find(item => item.styleId === style.id && item.lineId === line?.id)
  const source = workspace.operations?.orderSourceRecords.find(item => item.styleId === style.id && item.lineId === line?.id)
  const sourceCodes = [...new Set((source?.rows || []).map(row => row.columns.A == null ? '' : String(row.columns.A).trim()).filter(Boolean))]
  const sourceCode = workspace.projects.find(project => project.id === style.projectId)?.code?.trim() || (sourceCodes.length === 1 ? sourceCodes[0] : '')
  const projectCode = price.managed ? price.projectCode : draft?.projectCode ?? (record?.projectCode || sourceCode)
  const cost = price.managed ? price.unitCost : draft ? draft.unitCost.trim() === '' ? null : Number(draft.unitCost) : record?.unitCost ?? null
  const itemType = price.managed ? price.itemType : draft?.itemType ?? record?.itemType ?? 'product'
  const receipts = (workspace.productionReceipts || []).filter(item => item.runId === run?.id && !item.voided)
  const received = run ? run.snapshot?.receivedQuantity ?? receipts.reduce((sum, item) => sum + quantityTotal(item.quantities), 0) : price.managed ? 0 : line ? quantityTotal(line.received) : 0
  const order = run ? run.snapshot?.orderQuantity ?? quantityTotal(run.order) : price.managed ? 0 : line ? quantityTotal(line.order) : 0
  const receivedAt = run ? run.snapshot?.lastReceivedAt || receipts.map(item => item.receivedAt).sort().at(-1) || '' : price.managed ? '' : line?.receivedAt || ''
  const net = run?.snapshot ? run.snapshot.netAmount : cost !== null && Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 100) * received / 100 : null
  const referenceCode = price.managed ? price.projectCode : sourceCode
  const factory = run ? run.snapshot?.factory || run.factoryNameSnapshot : workspace.factories.find(item => item.id === style.factoryId)?.name || ''
  const owner = run ? run.snapshot?.owner || run.ownerNameSnapshot : workspace.profiles.find(item => item.id === (line?.ownerId ?? style.ownerId))?.name || ''
  const stale = !!draft && ((record?.version || 0) !== draft.version || price.managed)
  const audits = (workspace.settlementTermsAudits || []).filter(item => item.styleId === style.id && item.lineId === line?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  useEffect(() => { onDirtyChange?.(!!draft || busy); return () => onDirtyChange?.(false) }, [!!draft, busy, onDirtyChange])
  useEffect(() => {
    if (draft || busy) return
    if (activeLineId) setLineId(activeLineId)
    if (activeProjectId) setSelectedProjectId(activeProjectId)
    setSelectedRunId(activeRunId || '')
  }, [activeLineId, activeProjectId, activeRunId, !!draft, busy])
  const actor = workspace.profiles.find(item => item.id === profile.id)
  if (!actor?.active || !actor.approved || !['admin', 'internal'].includes(actor.role)) return null
  function begin() {
    if (price.managed) return
    setDraft({ version: record?.version || 0, projectCode: record?.projectCode || sourceCode, unitCost: record?.unitCost == null ? '' : String(record.unitCost), itemType: record?.itemType || 'product' })
    setReason(''); setError(''); setSaved(false)
  }
  async function save() {
    if (!draft || !line || busy || stale) return
    if (draft.unitCost.trim() && (!/^\d+(\.\d{1,2})?$/.test(draft.unitCost.trim()) || !Number.isFinite(Number(draft.unitCost)) || Number(draft.unitCost) > 1000000000)) { setError('장당 원가는 0~1,000,000,000 사이의 숫자로, 소수 둘째 자리까지 입력해 주세요. 비워 두면 미입력으로 보관합니다.'); return }
    if (reason.trim().length < 2) { setError('단가·을지 정보 변경 사유를 두 글자 이상 입력해 주세요.'); return }
    setBusy(true); setError(''); setSaved(false)
    try { await onSaveSettlementTerms(style.id, line.id, { projectCode: draft.projectCode.trim(), unitCost: draft.unitCost.trim() === '' ? null : Number(draft.unitCost), itemType: draft.itemType }, draft.version, reason.trim()); setDraft(null); setReason(''); setSaved(true) }
    catch (error) { setError(message(error)) } finally { setBusy(false) }
  }
  const preview: [string, string, string | number][] = [
    ['A', '예산 관리 코드 (A열)', projectCode || '입력 필요'], ['C', '입고일자', receivedAt || '메인 생산에서 입고 확정 필요'], ['D', '업체명', factory || '공장 정보 확인 필요'],
    ['I', '스타일 코드 · 컬러 포함', run?.snapshot?.styleCode || run?.styleCodeSnapshot || fullStyleSku(style.code, line?.color)], ['N', '장당 원가', cost === null ? '미입력' : amount(cost)], ['O', '장수', 1],
    ['P', 'PO 오더 수량', amount(order)], ['Q', '발주 수량 · P와 동일', amount(order)], ['R', '실제 입고 수량', amount(received)], ['S', '단위', itemType === 'fabric' ? 'YDS' : 'EA'],
    ['T', '금액 · 부가세 제외', net === null ? '단가 입력 필요' : amount(net)], ['U', '부가세 · T × 10%', net === null ? '—' : amount(run?.snapshot?.vatAmount ?? net / 10)], ['V', '부가세 포함 합계', net === null ? '—' : amount(run?.snapshot?.grossAmount ?? net + net / 10)], ['W', '담당자', owner || '담당자 확인 필요'],
  ]
  return <section className="settlement-terms" aria-label="을지 및 단가 관리">
    <div className="section-heading"><div><h2><FileSpreadsheet size={18} />을지·단가</h2><p className="muted">생산 조건 협의·승인의 최종 단가와 차수별 실제 입고로 을지를 확인합니다.</p></div>{!price.managed && !draft && workspace.settlementTermsAvailable === true && line && <button type="button" className="button" onClick={begin}><Pencil size={13} />단가·을지 정보 수정</button>}</div>
    <div className="production-colors">{style.production.map(item => <button type="button" className={`production-color ${line?.id === item.id ? 'active' : ''}`} key={item.id} disabled={!!draft || busy || selectionBlocked} onClick={() => { if (selectionBlocked) return; setLineId(item.id); setSelectedRunId(''); onSelectLine?.(item.id); setError(''); setSaved(false) }}><strong>{item.color}</strong><span>{fullStyleSku(style.code, item.color)}</span><small>실입고 {amount(quantityTotal(item.received))}</small></button>)}</div>
    {workspace.settlementTermsAvailable !== true && !price.managed ? <div className="error-message" role="status">관리자가 004_settlement_terms.sql을 적용하면 예산 관리 코드(A열)·원가를 저장할 수 있습니다. 기존 샘플·생산 업무는 계속 사용할 수 있습니다.</div> : !line ? <div className="empty-state">메인 생산 컬러를 먼저 등록해 주세요.</div> : <>
      {price.managed && <div className="form-grid"><label className="field"><span className="field-label">승인 단가 연결 생산 차수</span><select className="select" aria-label="을지 생산 차수 선택" value={run?.id || ''} disabled={!!draft || busy || selectionBlocked} onChange={event => { if (selectionBlocked) return; const selected = runOptions.find(item => item.id === event.target.value); setSelectedRunId(event.target.value); if (selected) { const projectId = selected.closedAt && selected.snapshot ? selected.snapshot.projectId : selected.projectId; setSelectedProjectId(projectId); onSelectRun?.(selected.id, projectId) }; setError(''); setSaved(false) }}><option value="">생산 차수 선택</option>{runOptions.map(item => <option key={item.id} value={item.id}>{getProjectIdentity(workspace, item.closedAt && item.snapshot ? item.snapshot.projectId : item.projectId).name} / {line.color} / {item.round}차 · {item.name}</option>)}</select></label><p className="settlement-terms-note" role="status">{price.status === 'approved' ? '생산 조건 협의·승인에서 본사가 최종 승인한 단가가 자동 연결됩니다.' : price.status === 'closed' ? '마감 확정 당시의 단가·입고·금액을 표시합니다.' : price.status === 'ambiguous' ? '여러 생산 차수가 있습니다. 사용할 차수를 선택해 주세요.' : price.status === 'inconsistent' ? '승인 단가와 생산 차수의 연결이 일치하지 않습니다. 생산 조건을 확인해 주세요.' : price.status === 'missing' ? '선택한 프로젝트·컬러에 연결할 생산 차수가 없습니다.' : '본사 최종 승인 후 단가가 자동으로 표시됩니다.'}</p></div>}
      <p className="settlement-terms-note">T열은 <strong>장당 원가 × 해당 컬러의 실제 입고 수량</strong>으로 계산한 부가세 제외 금액입니다. 기존 업체 마감 금액에서 단가를 역산하거나 오더 수량을 입고 수량으로 대체하지 않습니다.</p>
      {stale && <div className="ops-conflict" role="status">다른 사용자가 단가·을지 정보를 변경했습니다. 입력한 내용은 유지됩니다. 편집 취소 후 최신 내용을 확인해 주세요.</div>}
      {error && <div className="error-message" role="alert">{error}</div>}{saved && <div className="success-message" role="status">단가·을지 정보를 저장했습니다.</div>}
      <div className="form-grid">
        <label className="field"><span className="field-label">을지 예산 관리 코드</span><input className="input" aria-label="을지 예산 관리 코드" value={projectCode} maxLength={120} disabled={price.managed || !draft || busy} placeholder="예산 파일 A열의 관리 코드" onChange={event => setDraft(current => current ? { ...current, projectCode: event.target.value } : current)} />{referenceCode && <small>본사 예산 관리용 A열 참조: {referenceCode}</small>}{!price.managed && sourceCodes.length > 1 && <small>원본 A열에 서로 다른 예산 관리 코드가 있습니다. 사용할 코드를 직접 입력하세요.</small>}</label>
        <label className="field"><span className="field-label">장당 원가 (KRW)</span><input className="input" type="number" aria-label="장당 원가" min="0" max="1000000000" step="0.01" value={price.managed ? cost === null ? '' : String(cost) : draft?.unitCost ?? (record?.unitCost == null ? '' : String(record.unitCost))} disabled={price.managed || !draft || busy} placeholder="빈칸은 미입력 · 0원과 구분" onChange={event => setDraft(current => current ? { ...current, unitCost: event.target.value } : current)} /></label>
        <label className="field"><span className="field-label">을지 품목 구분</span><select className="select" aria-label="을지 품목 구분" value={itemType} disabled={price.managed || !draft || busy} onChange={event => setDraft(current => current ? { ...current, itemType: event.target.value as SettlementTermsInput['itemType'] } : current)}>{Object.entries(typeLabel).map(([value, label]) => <option key={value} value={value}>{label} · {value === 'fabric' ? 'YDS' : 'EA'}</option>)}</select></label>
        <label className="field"><span className="field-label">입고 수량·일자 기준</span><input className="input" readOnly value={`${amount(received)} ${itemType === 'fabric' ? 'YDS' : 'EA'} / ${receivedAt || '입고일 미입력'}`} /><small>메인 생산에서 확정한 입고와 연결된 차수의 기록을 사용합니다.</small></label>
      </div>
      <div className="settlement-terms-preview"><table><thead><tr><th>을지 열</th><th>항목</th><th>현재 값</th></tr></thead><tbody>{preview.map(([column, label, value]) => <tr key={column}><th>{column}</th><td>{label}</td><td>{value}</td></tr>)}</tbody></table></div>
      {!price.managed && !record && <p className="settlement-terms-note">현재 단가 정보가 저장되지 않았습니다. 수정 버튼으로 원가를 입력하고 저장한 뒤 결제·마감에서 을지를 다운로드하세요.</p>}
      {draft && <div className="settlement-terms-footer"><label className="field"><span className="field-label">단가·을지 변경 사유</span><input className="input" aria-label="단가·을지 변경 사유" value={reason} maxLength={1000} disabled={busy} onChange={event => setReason(event.target.value)} /></label><div><button className="button" type="button" disabled={busy} onClick={() => { setDraft(null); setReason(''); setError('') }}>단가 편집 취소</button><button className="button button-primary" type="button" disabled={busy || stale || reason.trim().length < 2} onClick={() => void save()}><Save size={13} />{busy ? '저장 중…' : '단가·을지 정보 저장'}</button></div></div>}
      {!!audits.length && <details className="settlement-terms-history"><summary><History size={13} />단가·을지 변경 이력 ({audits.length})</summary>{audits.slice(0, 30).map(audit => <div key={audit.id}><strong>{audit.actorName} · {dateTime(audit.createdAt)}</strong><p>{audit.reason}</p><small>단가 {audit.before?.unitCost == null ? '미입력' : amount(audit.before.unitCost)} → {audit.after.unitCost == null ? '미입력' : amount(audit.after.unitCost)} / 예산 관리 코드 {audit.before?.projectCode || '미입력'} → {audit.after.projectCode || '원본 참조'}</small></div>)}</details>}
    </>}
  </section>
}
