import { useEffect, useState } from 'react'
import { FileSpreadsheet, Pencil, Save } from 'lucide-react'
import type { Profile, Style, Workspace } from '../lib/types'
import { quantityTotal } from '../lib/types'
import type { OrderSourceData, OrderSourceRecord } from '../lib/operations-types'
import { message } from '../lib/utils'
import './order-source.css'

export interface OrderSourcePanelProps {
  style: Style
  workspace: Workspace
  profile: Profile
  onSaveOrderSource: (styleId: string, lineId: string, data: OrderSourceData, expectedVersion: number, reason: string) => Promise<void>
  onEditQuantities: (lineId: string) => void
  onDirtyChange?: (dirty: boolean) => void
}
const COLUMNS = ['A', 'F', 'L', 'M', 'S', 'V', 'W', 'X', 'Y', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AV', 'AY'] as const
const lockedColumns = new Set(['F', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AV', 'AY'])
const values = (record: OrderSourceRecord): OrderSourceData => ({ fileName: record.fileName, sheetName: record.sheetName, headers: structuredClone(record.headers), rows: structuredClone(record.rows) })

export default function OrderSourcePanel({ style, workspace, profile, onSaveOrderSource, onEditQuantities, onDirtyChange }: OrderSourcePanelProps) {
  const [lineId, setLineId] = useState(style.production[0]?.id || '')
  const [draft, setDraft] = useState<{ data: OrderSourceData; version: number } | null>(null)
  const [reason, setReason] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false)
  const line = style.production.find(item => item.id === lineId) || style.production[0]
  const record = workspace.operations?.orderSourceRecords.find(item => item.styleId === style.id && item.lineId === line?.id)
  const conflict = !!draft && record?.version !== draft.version
  useEffect(() => { onDirtyChange?.(!!draft); return () => onDirtyChange?.(false) }, [!!draft, onDirtyChange])
  if (profile.role === 'factory') return null
  async function save() {
    if (!line || !draft) return
    setBusy(true); setError(''); setSaved(false)
    try { await onSaveOrderSource(style.id, line.id, draft.data, draft.version, reason.trim()); setDraft(null); setReason(''); setSaved(true) }
    catch (error) { setError(message(error)) } finally { setBusy(false) }
  }
  return <section className="order-source-panel" aria-label="ORDER QTY 원본 정보">
    <div className="section-heading"><div><h2><FileSpreadsheet size={18} />ORDER QTY 원본 정보</h2><p className="muted">가져온 엑셀의 지정 열을 품번·컬러별로 보관합니다.</p></div></div>
    <div className="production-colors">{style.production.map(item => <button type="button" className={`production-color ${line?.id === item.id ? 'active' : ''}`} key={item.id} disabled={!!draft || busy} onClick={() => { setLineId(item.id); setError(''); setSaved(false) }}><strong>{item.color}</strong><span>{style.code}{item.color}</span><small>{quantityTotal(item.order).toLocaleString()} pcs</small></button>)}</div>
    {workspace.operationsAvailable !== true ? <p className="ops-error" role="status">관리자가 003_operations.sql을 적용하면 원본 정보를 저장할 수 있습니다.</p> : !record ? <div className="empty-state"><FileSpreadsheet size={26} /><p>이 컬러에 저장된 ORDER QTY 원본이 없습니다.</p><span className="muted">오더 엑셀 업로드에서 SIG ORDER QTY 형식으로 가져오면 표시됩니다.</span></div> : <>
      <div className="order-source-info"><div><strong>{record.fileName}</strong><span>{record.sheetName} · 원본 {record.rows.map(row => row.rowNumber).join(', ')}행</span></div>{!draft && <button className="button" type="button" onClick={() => { setDraft({ data: values(record), version: record.version }); setSaved(false); setError('') }}><Pencil size={13} />원본 참조 정보 수정</button>}</div>
      <p className="order-source-note">A·L·M·S·V·W·X·Y열의 참조 정보는 아래에서 수정할 수 있습니다. F열은 품번 연결 기준이며, AQ~AV·AY열은 가져온 당시 수량입니다. 실제 오더 수량은 메인 생산에서 수정하세요.</p>
      {conflict && <div className="ops-conflict" role="status">다른 사용자가 원본 정보를 변경했습니다. 입력한 값은 유지됩니다. 편집을 취소한 뒤 최신 내용을 확인해 주세요.</div>}
      {error && <div className="ops-error" role="alert">{error}</div>}{saved && <div className="ops-success" role="status">원본 참조 정보를 저장했습니다.</div>}
      <div className="order-source-table"><table><thead><tr><th>열</th><th>엑셀 항목명</th>{(draft?.data.rows || record.rows).map((row, index) => <th key={index}>원본 {row.rowNumber}행</th>)}</tr></thead><tbody>{COLUMNS.map(column => <tr key={column}><th>{column}</th><td>{record.headers[column] || '항목명 없음'}</td>{(draft?.data.rows || record.rows).map((row, index) => <td key={index}>{draft && !lockedColumns.has(column) ? <input className="input" aria-label={`원본 ${row.rowNumber}행 ${column}열`} maxLength={4000} value={row.columns[column] == null ? '' : String(row.columns[column])} disabled={busy} onChange={event => setDraft(current => current ? { ...current, data: { ...current.data, rows: current.data.rows.map((item, i) => i === index ? { ...item, columns: { ...item.columns, [column]: event.target.value } } : item) } } : current)} /> : <span>{row.columns[column] == null ? '—' : String(row.columns[column])}</span>}</td>)}</tr>)}</tbody></table></div>
      <div className="order-source-current"><span>현재 오더 수량 <strong>{line ? quantityTotal(line.order).toLocaleString() : 0} pcs</strong></span>{line && <button type="button" className="button" disabled={!!draft || busy} onClick={() => onEditQuantities(line.id)}>메인 생산에서 수량 수정</button>}</div>
      {draft && <div className="order-source-footer"><label className="field"><span className="field-label">원본 정보 변경 사유</span><input className="input" aria-label="원본 정보 변경 사유" value={reason} maxLength={1000} disabled={busy} onChange={event => setReason(event.target.value)} /></label><div><button className="button" type="button" disabled={busy} onClick={() => { setDraft(null); setReason(''); setError('') }}>원본 편집 취소</button><button className="button button-primary" type="button" disabled={busy || conflict || reason.trim().length < 2} onClick={() => void save()}><Save size={13} />{busy ? '저장 중…' : '원본 정보 저장'}</button></div></div>}
    </>}
  </section>
}
