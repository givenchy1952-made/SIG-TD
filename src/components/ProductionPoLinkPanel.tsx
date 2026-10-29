import { useEffect, useState } from 'react'
import type { PoDispatch } from '../lib/operations-types'
import type { Profile, Style, Workspace } from '../lib/types'
import { SIZES, quantityTotal } from '../lib/types'
import { getArchivedProductionPoCandidate, type ProductionPoLinkFields } from '../lib/production-po-links'
import { linkProductionPo, replaceArchivedProductionPoLink } from '../lib/production-po-links-repository'
import { message } from '../lib/utils'
import './production-po-links.css'

interface Props { po: PoDispatch; style: Style; workspace: Workspace & ProductionPoLinkFields; profile: Profile; onRefresh?: () => Promise<unknown>; onLinkDirty?: (poId: string, dirty: boolean) => void }
export default function ProductionPoLinkPanel({ po, style, workspace, profile, onRefresh, onLinkDirty }: Props) {
  const [open, setOpen] = useState(false), [runId, setRunId] = useState(''), [documentConfirmed, setDocumentConfirmed] = useState(false)
  const [scopeConfirmed, setScopeConfirmed] = useState(false), [legacyConfirmed, setLegacyConfirmed] = useState(false)
  const [replacementConfirmed, setReplacementConfirmed] = useState(false)
  const [reason, setReason] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [refreshRequired, setRefreshRequired] = useState(false)
  const actor = workspace.profiles.find(item => item.id === profile.id)
  const hq = !!actor?.active && actor.approved && actor.role !== 'factory'
  const linked = workspace.productionRuns?.find(item => item.poId === po.id)
  const runs = (workspace.productionRuns || []).filter(item => item.styleId === style.id && item.factoryIdSnapshot === po.factoryIdSnapshot && !item.closedAt && (!item.poId || workspace.productionPoRecoveryAvailable === true && getArchivedProductionPoCandidate(workspace, item)))
  const run = runs.find(item => item.id === runId), line = style.production.find(item => item.id === run?.lineId)
  const previousPo = run?.poId ? getArchivedProductionPoCandidate(workspace, run) : null
  const context = workspace.productionPoContexts?.find(item => item.poId === po.id)
  const sourceLine = context?.snapshot.lines.find(item => item.lineId === run?.lineId)
  const differs = !!run && !!line && SIZES.some(size => line.order[size] !== run.order[size] || sourceLine && sourceLine.order[size] !== run.order[size])
  const editable = hq && workspace.productionPoLinksAvailable === true && po.status === 'sent' && !po.voided && !linked
  useEffect(() => { onLinkDirty?.(po.id, open || busy || refreshRequired); return () => onLinkDirty?.(po.id, false) }, [po.id, open, busy, refreshRequired, onLinkDirty])
  if (!hq || workspace.productionPoLinksAvailable !== true) return null

  function select(id: string) { setRunId(id); setDocumentConfirmed(false); setScopeConfirmed(false); setLegacyConfirmed(false); setReplacementConfirmed(false); setError('') }
  async function save() {
    if (!run || !line || busy || !documentConfirmed || differs && !scopeConfirmed || !context && !legacyConfirmed || previousPo && !replacementConfirmed || reason.trim().length < 2) return
    setBusy(true); setError('')
    try {
      const confirmation = { documentConfirmed, scopeDifferenceConfirmed: scopeConfirmed, sourceSnapshotMissingConfirmed: legacyConfirmed, projectId: run.projectId, styleCode: run.styleCodeSnapshot, color: line.color, factoryId: run.factoryIdSnapshot, order: { ...run.order } }
      if (previousPo) await replaceArchivedProductionPoLink(run.id, previousPo.id, po.id, run.version, previousPo.version, po.version, confirmation, reason.trim(), actor!)
      else await linkProductionPo(run.id, po.id, run.version, po.version, confirmation, reason.trim(), actor!)
      setOpen(false)
      try { if (!onRefresh) throw new Error(); await onRefresh(); setRefreshRequired(false) } catch { setRefreshRequired(true); setError('연결은 저장됐지만 최신 목록을 불러오지 못했습니다. 다시 불러와 주세요.') }
    } catch (failure) { setError(message(failure)) }
    finally { setBusy(false) }
  }
  async function refresh() { if (!onRefresh || busy) return; setBusy(true); try { await onRefresh(); setRefreshRequired(false); setError('') } catch { setError('최신 연결 상태를 불러오지 못했습니다.') } finally { setBusy(false) } }
  return <section className="production-po-link" aria-label="생산 차수 PO 연결">
    {linked ? <p className="production-po-link-status">{po.voided ? '보관된 초안이 생산 차수에 연결되어 있습니다' : '생산 차수 연결됨'} · {linked.projectCode} / {linked.styleCodeSnapshot} / {linked.round}차</p> : <>
      {po.status === 'sent' && <p className="production-po-unlinked">생산 차수 미연결 · 메일은 발송됐지만 생산 조건 협의에는 아직 연결되지 않았습니다.</p>}
      {editable && !open && !refreshRequired && <button type="button" className="button" onClick={() => setOpen(true)}>기존 생산 차수에 연결</button>}
    </>}
    {error && <div className="ops-error" role="alert">{error}</div>}
    {refreshRequired && <button type="button" className="button" disabled={busy} onClick={() => void refresh()}>최신 PO 연결 다시 불러오기</button>}
    {open && <div className="production-po-link-editor">
      <p>실제 발송한 메일과 첨부 발주서를 확인한 뒤 연결하세요. 제목이 비슷한 PO를 자동으로 선택하거나 다시 발송하지 않습니다.</p>
      <label className="field"><span className="field-label">연결할 기존 생산 차수</span><select className="select" aria-label="연결할 기존 생산 차수" value={runId} disabled={busy} onChange={event => select(event.target.value)}><option value="">생산 차수 선택</option>{runs.map(item => <option key={item.id} value={item.id}>{item.projectCode || workspace.projects.find(project => project.id === item.projectId)?.name} / {item.styleCodeSnapshot} / {item.round}차 · {quantityTotal(item.order)}개{item.poId ? ' · 보관된 초안 연결 교체' : ''}</option>)}</select></label>
      {!runs.length && <p>연결 가능한 차수가 없습니다. 생산 차수·마감에서 PO 미연결 상태로 차수를 먼저 등록해 주세요.</p>}
      {run && line && <>
        <dl className="production-po-link-facts"><div><dt>프로젝트</dt><dd>{run.projectCode || workspace.projects.find(project => project.id === run.projectId)?.name}</dd></div><div><dt>품번·컬러</dt><dd>{run.styleCodeSnapshot} · {line.color}</dd></div><div><dt>업체</dt><dd>{run.factoryNameSnapshot}</dd></div></dl>
        {previousPo && <>
          <p className="production-po-unlinked">현재 연결: {previousPo.subject} · 보관된 미발송 초안. 아래 확인을 마치면 이 발송 PO로 연결을 교체합니다. 기존 초안과 발송 기록은 보존됩니다.</p>
          <label className="production-po-link-check"><input type="checkbox" aria-label="보관된 미발송 초안 연결 교체 확인" checked={replacementConfirmed} disabled={busy} onChange={event => setReplacementConfirmed(event.target.checked)}/>보관된 미발송 초안의 연결을 해제하고, 확인한 발송 PO로 교체합니다. 메일을 다시 발송하지 않습니다.</label>
        </>}
        <div className="production-po-link-table"><table aria-label="PO 연결 수량 비교"><thead><tr><th>집계 기준</th>{SIZES.map(size => <th key={size}>{size}</th>)}<th>합계</th></tr></thead><tbody>{[['메인 생산 현재 누적', line.order], ['연결할 생산 차수', run.order], ...(sourceLine ? [['PO 작성 당시 메인 누적', sourceLine.order]] : [])].map(([name, quantities]) => <tr key={String(name)}><th>{String(name)}</th>{SIZES.map(size => <td key={size}>{(quantities as typeof line.order)[size].toLocaleString()}</td>)}<td>{quantityTotal(quantities as typeof line.order).toLocaleString()}</td></tr>)}</tbody></table></div>
        {differs && <label className="production-po-link-check"><input type="checkbox" aria-label="수량 집계 범위 차이 확인" checked={scopeConfirmed} disabled={busy} onChange={event => setScopeConfirmed(event.target.checked)}/>메인 누적 수량과 이번 차수 수량의 집계 범위가 다름을 확인했습니다. 수량을 자동 변경하지 않습니다.</label>}
        {!context && <label className="production-po-link-check"><input type="checkbox" aria-label="기존 PO 비교 정보 미등록 확인" checked={legacyConfirmed} disabled={busy} onChange={event => setLegacyConfirmed(event.target.checked)}/>이전 PO에는 비교용 원본 정보가 없어 실제 발송 문서로 직접 확인했습니다.</label>}
        <label className="production-po-link-check"><input type="checkbox" aria-label="발송 문서 생산 조건 확인" checked={documentConfirmed} disabled={busy} onChange={event => setDocumentConfirmed(event.target.checked)}/>실제 발송 문서의 프로젝트·전체 품번·컬러·업체·사이즈별 수량이 이 차수와 일치함을 확인했습니다.</label>
        <label className="field"><span className="field-label">PO 연결 확인 사유</span><input className="input" aria-label="PO 연결 확인 사유" value={reason} minLength={2} maxLength={1000} disabled={busy} onChange={event => setReason(event.target.value)}/></label>
      </>}
      <div className="production-po-link-actions"><button type="button" className="button" disabled={busy} onClick={() => setOpen(false)}>PO 연결 취소</button><button type="button" className="button button-primary" disabled={busy || !run || !documentConfirmed || differs && !scopeConfirmed || !context && !legacyConfirmed || !!previousPo && !replacementConfirmed || reason.trim().length < 2} onClick={() => void save()}>{busy ? '연결 저장 중…' : previousPo ? '확인한 발송 PO로 연결 교체' : '확인한 생산 차수에 연결'}</button></div>
    </div>}
  </section>
}
