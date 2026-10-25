import { useEffect, useState } from 'react'
import { AlertCircle, Check, ClipboardCheck, History, Pencil, Plus, Ruler, Save, Trash2 } from 'lucide-react'
import type { Profile, Status, Style, Workspace } from '../lib/types'
import { STATUS_LABEL } from '../lib/types'
import { canViewStyle } from '../lib/permissions'
import { blankProductionDetails, MEASUREMENT_SIZES, QUALITY_CATEGORIES, validateProductionDetails, type MeasurementRow, type ProductionDetailsInput } from '../lib/workflow-refinements'
import { message } from '../lib/utils'
import './production-details.css'

export interface ProductionDetailsPanelProps {
  style: Style
  workspace: Workspace
  profile: Profile
  lineId?: string
  mode: 'quality' | 'measurements'
  onSave: (styleId: string, lineId: string, data: ProductionDetailsInput, expectedVersion: number, reason: string) => Promise<void>
  onDirtyChange?: (dirty: boolean) => void
}
interface Draft { lineId: string; version: number; data: ProductionDetailsInput }
type MeasurementPart = 'upper' | 'lower'
const partLabel: Record<MeasurementPart, string> = { upper: '상의', lower: '하의' }
const clone = <T,>(value: T): T => structuredClone(value)
const numeric = (value: string): number | null => value.trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value)
const show = (value: number | null) => value === null ? '—' : value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })
const payload = (record: { quality: ProductionDetailsInput['quality']; measurements: ProductionDetailsInput['measurements'] } | undefined) => record ? clone({ quality: record.quality, measurements: record.measurements }) : blankProductionDetails()

export default function ProductionDetailsPanel({ style, workspace, profile, lineId, mode, onSave, onDirtyChange }: ProductionDetailsPanelProps) {
  const [selectedLineId, setSelectedLineId] = useState(lineId || style.production[0]?.id || '')
  const [part, setPart] = useState<MeasurementPart>('upper')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [reason, setReason] = useState(''), [error, setError] = useState(''), [success, setSuccess] = useState(''), [busy, setBusy] = useState(false)
  const currentLineId = draft?.lineId || lineId || selectedLineId
  const line = style.production.find(item => item.id === currentLineId)
  const record = workspace.productionDetails?.find(item => item.styleId === style.id && item.lineId === currentLineId)
  const data = draft?.data || payload(record)
  const quality = mode === 'quality', title = quality ? '품질 검사' : '메인 제품 사이즈 측정'
  const editable = profile.approved && profile.active && (!quality || profile.role !== 'factory')
  const selectionChanged = !!draft && !!lineId && lineId !== draft.lineId
  const stale = !!draft && ((record?.version || 0) !== draft.version || !line || selectionChanged)
  const ready = workspace.refinementsAvailable === true
  useEffect(() => { onDirtyChange?.(!!draft || busy); return () => onDirtyChange?.(false) }, [!!draft, busy, onDirtyChange])
  if (!canViewStyle(profile, style)) return null

  function begin() {
    if (!line || !ready || !editable) return
    setDraft({ lineId: line.id, version: record?.version || 0, data: payload(record) }); setReason(''); setError(''); setSuccess('')
  }
  function updateQuality<K extends keyof ProductionDetailsInput['quality']>(key: K, value: ProductionDetailsInput['quality'][K]) {
    setDraft(current => current ? { ...current, data: { ...current.data, quality: { ...current.data.quality, [key]: value } } } : current); setSuccess('')
  }
  function updateRow(id: string, update: (row: MeasurementRow) => MeasurementRow) {
    setDraft(current => current ? { ...current, data: { ...current.data, measurements: { ...current.data.measurements, [part]: current.data.measurements[part].map(row => row.id === id ? update(row) : row) } } } : current); setSuccess('')
  }
  function addRow() {
    const row: MeasurementRow = { id: `custom-${crypto.randomUUID()}`, label: '추가 측정 위치', grade: null, values: Object.fromEntries(MEASUREMENT_SIZES.map(size => [size, null])) as MeasurementRow['values'] }
    setDraft(current => current && current.data.measurements[part].length < 30 ? { ...current, data: { ...current.data, measurements: { ...current.data.measurements, [part]: [...current.data.measurements[part], row] } } } : current)
  }
  function removeRow(id: string) {
    setDraft(current => current && current.data.measurements[part].length > 1 ? { ...current, data: { ...current.data, measurements: { ...current.data.measurements, [part]: current.data.measurements[part].filter(row => row.id !== id) } } } : current)
  }
  async function save() {
    if (!draft || busy || stale || !editable) return
    setError(''); setSuccess('')
    try {
      validateProductionDetails(draft.data)
      if (quality && !draft.data.quality.category) throw new Error('품질 검사 대상을 선택해 주세요.')
      if (reason.trim().length < 2 || reason.length > 1000) throw new Error('변경 사유를 2~1,000자로 입력해 주세요.')
      setBusy(true)
      await onSave(style.id, draft.lineId, draft.data, draft.version, reason.trim())
      setDraft(null); setReason(''); setSuccess(`${quality ? '품질 검사' : '사이즈 측정'} 내용을 저장했습니다.`)
    } catch (failure) { setError(message(failure)) } finally { setBusy(false) }
  }
  function cancel() { setDraft(null); setReason(''); setError(''); setSuccess('') }

  return <section className={`production-details ${quality ? 'production-quality' : 'production-measurements'}`} aria-label={title}>
    <div className="section-heading"><div><h3>{quality ? <ClipboardCheck size={17} /> : <Ruler size={17} />}{title}</h3><p className="muted">{quality ? '품목별 검사 수량·진행 상태와 결과를 확인합니다.' : '상의·하의 측정 위치별로 편차와 사이즈 치수를 입력합니다. 단위는 cm입니다.'}</p></div>{!draft && ready && editable && line && <button className="button" type="button" onClick={begin}><Pencil size={13} />{quality ? '품질 검사 수정' : '사이즈 측정 수정'}</button>}</div>
    {!lineId && <label className="field production-details-color"><span className="field-label">생산 컬러</span><select className="select" aria-label={`${quality ? '품질 검사' : '사이즈 측정'} 컬러`} value={line?.id || ''} disabled={!!draft || busy} onChange={event => { setSelectedLineId(event.target.value); setError(''); setSuccess('') }}><option value="">컬러 선택</option>{style.production.map(item => <option key={item.id} value={item.id}>{item.color} · {style.code}{item.color}</option>)}</select></label>}
    {!ready ? <div className="production-details-notice" role="status"><AlertCircle size={16} /><span>{profile.role === 'factory' ? '관리자에게 품질 검사·치수표 기능 설정을 요청해 주세요.' : '품질 검사·치수표 저장은 005 업무 업데이트 SQL을 적용한 뒤 사용할 수 있습니다.'}</span></div> : !line ? <div className="empty-state">생산 컬러를 먼저 저장해 주세요.</div> : <>
      {stale && <div className="production-details-conflict" role="status"><History size={16} /><div><strong>{selectionChanged ? '선택한 컬러가 변경되었습니다.' : '다른 사용자가 먼저 수정했습니다.'}</strong><p>입력 내용은 유지됩니다. 편집을 취소하고 최신 품질 검사·치수표를 확인한 뒤 다시 입력해 주세요.</p></div><button className="button" type="button" disabled={busy} onClick={cancel}>편집 취소 · 최신 내역</button></div>}
      {error && <div className="error-message" role="alert">{error}</div>}{success && <div className="success-message" role="status"><Check size={14} />{success}</div>}
      {quality ? <div className="production-quality-fields"><div className="form-grid">
        <label className="field"><span className="field-label">품질 검사 대상</span><select className="select" aria-label="품질 검사 대상" value={data.quality.category} disabled={!draft || busy} onChange={event => updateQuality('category', event.target.value as ProductionDetailsInput['quality']['category'])}><option value="">품목 선택</option>{QUALITY_CATEGORIES.map(category => <option key={category}>{category}</option>)}</select></label>
        <label className="field"><span className="field-label">검사 수량</span><input className="input" type="number" aria-label="품질 검사 수량" min="0" max="10000000" step="1" value={data.quality.quantity} disabled={!draft || busy} onChange={event => updateQuality('quantity', event.target.value === '' ? 0 : Number(event.target.value))} /></label>
        <label className="field"><span className="field-label">진행 상태</span><select className="select" aria-label="품질 검사 상태" value={data.quality.status} disabled={!draft || busy} onChange={event => updateQuality('status', event.target.value as Status)}>{Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field"><span className="field-label">검사 요청일</span><input className="input" type="date" aria-label="품질 검사 요청일" value={data.quality.requestedAt} disabled={!draft || busy} onChange={event => updateQuality('requestedAt', event.target.value)} /></label>
        <label className="field"><span className="field-label">검사 완료일</span><input className="input" type="date" aria-label="품질 검사 완료일" value={data.quality.completedAt} disabled={!draft || busy} onChange={event => updateQuality('completedAt', event.target.value)} /></label>
      </div><label className="field"><span className="field-label">품질 검사 결과·메모</span><textarea className="textarea" aria-label="품질 검사 메모" rows={3} maxLength={5000} value={data.quality.note} disabled={!draft || busy} placeholder="검사 결과와 보완이 필요한 내용을 기록하세요." onChange={event => updateQuality('note', event.target.value)} /></label>{!editable && <p className="muted">품질 검사는 본사에서 관리합니다.</p>}</div> : <>
        <div className="production-measurement-toolbar"><div className="segmented" role="tablist" aria-label="치수표 구분">{(['upper', 'lower'] as const).map(section => <button key={section} type="button" role="tab" aria-selected={part === section} onClick={() => setPart(section)} className={part === section ? 'active' : ''}>{partLabel[section]}</button>)}</div><span>단위 cm · 빈칸은 미측정, 0은 측정값 0</span></div>
        <div className="production-measurement-scroll"><table className="production-measurement-table" aria-label={`${partLabel[part]} 사이즈 측정표`}><thead><tr><th scope="col">위치</th><th scope="col">편차</th>{MEASUREMENT_SIZES.map(size => <th scope="col" key={size}>{size}</th>)}{draft && <th scope="col"><span className="sr-only">행 관리</span></th>}</tr></thead><tbody>{data.measurements[part].map((row, index) => <tr key={row.id}><th scope="row">{draft ? <input className="input measurement-position" aria-label={`${partLabel[part]} 측정 위치 ${index + 1}`} value={row.label} maxLength={80} disabled={busy} onChange={event => updateRow(row.id, current => ({ ...current, label: event.target.value }))} /> : row.label}</th><td>{draft ? <input className="input" type="number" aria-label={`${partLabel[part]} ${row.label} 편차`} min="0" max="1000" step="0.01" value={row.grade ?? ''} disabled={busy} onChange={event => updateRow(row.id, current => ({ ...current, grade: numeric(event.target.value) }))} /> : show(row.grade)}</td>{MEASUREMENT_SIZES.map(size => <td key={size}>{draft ? <input className="input" type="number" aria-label={`${partLabel[part]} ${row.label} ${size}`} min="0" max="1000" step="0.01" value={row.values[size] ?? ''} disabled={busy} onChange={event => updateRow(row.id, current => ({ ...current, values: { ...current.values, [size]: numeric(event.target.value) } }))} /> : show(row.values[size])}</td>)}{draft && <td><button className="icon-button" type="button" aria-label={`${partLabel[part]} ${row.label} 측정 위치 삭제`} disabled={busy || data.measurements[part].length <= 1} onClick={() => removeRow(row.id)}><Trash2 size={13} /></button></td>}</tr>)}</tbody></table></div>
        {draft && <button className="button production-measurement-add" type="button" disabled={busy || data.measurements[part].length >= 30} onClick={addRow}><Plus size={13} />{partLabel[part]} 측정 위치 추가</button>}
        {line.measurements && <details className="production-measurement-legacy"><summary>기존 측정 기록 (보관)</summary><pre>{line.measurements}</pre></details>}
      </>}
      {draft && <div className="production-details-footer"><label className="field"><span className="field-label">{quality ? '품질 검사' : '사이즈 측정'} 변경 사유</span><input className="input" aria-label={`${quality ? '품질 검사' : '사이즈 측정'} 변경 사유`} value={reason} maxLength={1000} disabled={busy} placeholder="변경 사유를 두 글자 이상 입력하세요" onChange={event => setReason(event.target.value)} /></label><div><button className="button" type="button" disabled={busy} onClick={cancel}>{quality ? '품질 검사' : '사이즈 측정'} 편집 취소</button><button className="button button-primary" type="button" disabled={busy || stale || reason.trim().length < 2} onClick={() => void save()}><Save size={13} />{busy ? '저장 중…' : `${quality ? '품질 검사' : '사이즈 측정'} 저장`}</button></div></div>}
      <div className="production-details-stamp"><History size={12} />{record ? `버전 ${record.version} · ${new Date(record.updatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}` : '아직 저장된 내역이 없습니다.'}<span>검사·치수표는 별도로 저장하며 변경 이력을 보존합니다.</span></div>
    </>}
  </section>
}
