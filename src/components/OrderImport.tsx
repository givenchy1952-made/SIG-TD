import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, CheckCircle2, ChevronDown, FileSpreadsheet, RefreshCw, Upload, X } from 'lucide-react'
import { Modal } from './ui'
import { SIZES, quantityTotal } from '../lib/types'
import type { Profile, Style, Workspace } from '../lib/types'
import { validateStyle } from '../lib/permissions'
import { planRegistrationFromRow, type OrderRegistrationPlan, type RegistrationProject } from '../lib/order-registration'
import type { OrderImportChange } from '../lib/operations-types'
import { autoMapOrderColumns, buildOrderImportPreview, detectOrderHeaderRow, detectSigOrderHeaderRow, orderImportDefaults, parseOrderWorkbook, resolveSigOrderIdentity, sigOrderColumnMapping, SIG_ORDER_SOURCE_COLUMNS } from '../lib/order-import'
import type { ImportCell, ImportLayout, ImportWorkbook, OrderColumnMapping, OrderImportPreset } from '../lib/order-import'
import { message } from '../lib/utils'
import './order-import.css'
interface Props { workspace: Workspace; profile: Profile; onClose: () => void; onImport: (changes: OrderImportChange[], mode: 'replace' | 'add', reason: string) => Promise<void>; onRegisterStyle?: (style: Style, project: RegistrationProject, reason: string) => Promise<void> }
const emptyMapping = (): OrderColumnMapping => ({ sku: null, color: null, size: null, quantity: null, total: null, sizes: {} })
const cellLabel = (cell: ImportCell | undefined) => cell == null ? '' : typeof cell === 'object' ? '⚠ 셀 오류' : String(cell)
const columnLetter = (index: number) => { let value = index + 1, label = ''; while (value > 0) { value -= 1; label = String.fromCharCode(65 + value % 26) + label; value = Math.floor(value / 26) } return label }
const formatNumber = (value: number) => value.toLocaleString('ko-KR')
export default function OrderImport({ workspace, profile, onClose, onImport, onRegisterStyle }: Props) {
  const [book, setBook] = useState<ImportWorkbook | null>(null)
  const [snapshot, setSnapshot] = useState<Workspace | null>(null)
  const [sheetIndex, setSheetIndex] = useState(0)
  const [headerRow, setHeaderRow] = useState(1)
  const [mapping, setMapping] = useState<OrderColumnMapping>(emptyMapping)
  const [preset, setPreset] = useState<OrderImportPreset>('generic')
  const [sigColors, setSigColors] = useState<Record<number, string>>({})
  const [layout, setLayout] = useState<ImportLayout>('wide')
  const [mode, setMode] = useState<'replace' | 'add'>('replace')
  const [duplicateMode, setDuplicateMode] = useState<'reject' | 'sum'>('reject')
  const [missingSizes, setMissingSizes] = useState<'reject' | 'zero'>('reject')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [applied, setApplied] = useState(false)
  const [visibleRows, setVisibleRows] = useState(25)
  const [registration, setRegistration] = useState<OrderRegistrationPlan | null>(null)
  const [registrationReason, setRegistrationReason] = useState('')
  const [registrationError, setRegistrationError] = useState('')
  const [awaitingRegistration, setAwaitingRegistration] = useState<{ id: string; color: string; version: number } | null>(null)
  const sequence = useRef(0)
  useEffect(() => () => { sequence.current += 1 }, [])
  const allowed = profile.approved && profile.active && profile.role !== 'factory'
  const available = (workspace as Workspace & { operationsAvailable?: boolean }).operationsAvailable === true
  const sheet = book?.sheets[sheetIndex]
  const headers = sheet?.rows[headerRow - 1] || []
  const rawColumns = Array.from({ length: Math.min(15, headers.length) }, (_, index) => index).filter(index => preset !== 'sig-order-qty' || index !== 8)
  const preview = useMemo(() => snapshot && sheet ? buildOrderImportPreview(snapshot, sheet, { fileName: book?.name, preset, sigColors, mapping, layout, headerRow, duplicateMode, missingSizes, mode }) : null, [snapshot, sheet, book?.name, preset, sigColors, mapping, layout, headerRow, duplicateMode, missingSizes, mode])
  const baseColorRows = preset === 'sig-order-qty' && sheet ? sheet.rows.slice(headerRow).flatMap((source, index) => {
    const sku = cellLabel(source[5]).trim().toUpperCase(), rowNumber = headerRow + index + 1
    if (!/^[A-Z0-9_-]{1,60}$/.test(sku) || !/[A-Z]/.test(sku) || /[A-Z]{2}$/.test(sku)) return []
    let inferred = ''
    try { inferred = resolveSigOrderIdentity(snapshot || workspace, sku).color } catch { /* User must supply the color. */ }
    return [{ rowNumber, sku, color: sigColors[rowNumber] ?? inferred, inferred }]
  }) : []
  const errorCount = preview ? preview.errors.length + preview.rows.reduce((sum, row) => sum + row.errors.length, 0) : 0
  const warningCount = preview ? preview.warnings.length + preview.rows.reduce((sum, row) => sum + row.warnings.length, 0) : 0
  const stale = !applied && (preview?.changes.some(change => { const current = workspace.styles.find(style => style.id === change.styleId); return !current || current.deletedAt || current.version !== change.expectedVersion || change.lines.some(line => line.source && (workspace.operations?.orderSourceRecords?.find(source => source.styleId === change.styleId && source.lineId === line.lineId)?.version || 0) !== line.source.expectedVersion) }) || false)
  useEffect(() => {
    if (!awaitingRegistration) return
    const saved = workspace.styles.find(style => style.id === awaitingRegistration.id && style.version >= awaitingRegistration.version && style.colors.includes(awaitingRegistration.color))
    if (saved) { setSnapshot(structuredClone(workspace)); setRegistration(null); setAwaitingRegistration(null); setRegistrationReason(''); setError(''); setApplied(false); setSuccess('스타일·컬러와 프로젝트를 등록했습니다. 아래 수량 미리보기를 다시 확인한 뒤 오더를 적용해 주세요.') }
  }, [workspace, awaitingRegistration])
  function beginRegistration(rowNumber: number) {
    if (!sheet) return
    const plan = planRegistrationFromRow(workspace, sheet, headerRow, rowNumber, { factoryId: '', ownerId: profile.id, dueDate: '' }, undefined, sigColors[rowNumber])
    if (!plan.style || !plan.project) { setError(plan.errors.join(' ')); return }
    setRegistration(plan); setRegistrationReason(''); setRegistrationError(''); setError('')
  }
  async function registerStyle() {
    if (!registration?.style || !registration.project || !onRegisterStyle || !allowed || workspace.refinementsAvailable !== true || busy) return
    const style = registration.style, project = registration.project
    try {
      validateStyle(style)
      if (!workspace.factories.some(factory => factory.id === style.factoryId) || !workspace.profiles.some(owner => owner.id === style.ownerId && owner.active && owner.approved && owner.role !== 'factory')) throw new Error('등록된 공장과 승인된 본사 담당자를 선택해 주세요.')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(style.dueDate) || new Date(`${style.dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== style.dueDate) throw new Error('유효한 기준 납기일을 직접 선택해 주세요.')
      if (registrationReason.trim().length < 2) throw new Error('스타일 등록 사유를 두 글자 이상 입력해 주세요.')
      setBusy(true); setRegistrationError('')
      await onRegisterStyle(style, project, registrationReason.trim())
      setAwaitingRegistration({ id: style.id, color: registration.color, version: style.version + 1 })
    } catch (failure) { setRegistrationError(message(failure)) } finally { setBusy(false) }
  }
  function editRegistration(key: 'factoryId' | 'ownerId' | 'dueDate', value: string) { setRegistration(current => current?.style ? { ...current, style: { ...current.style, [key]: value } } : current) }
  const projectValue = (row: NonNullable<typeof preview>['rows'][number], column: 'A' | 'M' | 'L') => cellLabel(row.sourceMetadata?.[0]?.columns[column] ?? row.source?.rows[0]?.columns[column])
  const needsProjectLink = (row: NonNullable<typeof preview>['rows'][number]) => {
    const style = workspace.styles.find(item => item.id === row.styleId)
    const project = workspace.projects.find(item => item.id === style?.projectId)
    return !project || (project.code || '').trim().toUpperCase() !== projectValue(row, 'A').trim().toUpperCase() || project.name.trim() !== projectValue(row, 'M').trim() || project.season.trim() !== projectValue(row, 'L').trim()
  }
  const changed = () => { setError(''); setSuccess(''); setApplied(false); setVisibleRows(25) }
  async function readFile(file?: File) {
    if (!file || !allowed || busy) return
    const ticket = ++sequence.current
    setLoading(true); setError(''); setSuccess(''); setApplied(false); setBook(null); setSnapshot(null); setSigColors({})
    try {
      const loaded = await parseOrderWorkbook(file)
      if (ticket !== sequence.current) return
      const defaults = orderImportDefaults(loaded)
      setBook(loaded); setSnapshot(structuredClone(workspace)); setSheetIndex(defaults.sheetIndex); setPreset(defaults.preset); setHeaderRow(defaults.headerRow); setMapping(defaults.mapping); setLayout(defaults.layout); setVisibleRows(25)
    } catch (e) { if (ticket === sequence.current) setError(message(e)) } finally { if (ticket === sequence.current) setLoading(false) }
  }
  function chooseSheet(index: number) {
    if (!book) return
    const defaults = orderImportDefaults(book, index)
    setSheetIndex(index); setPreset(defaults.preset); setHeaderRow(defaults.headerRow); setMapping(defaults.mapping); setLayout(defaults.layout); setSigColors({}); changed()
  }
  function chooseHeader(row: number) {
    if (!sheet) return
    const next = Math.max(1, Math.min(Math.max(1, sheet.rows.length - 1), Math.floor(row) || 1))
    setHeaderRow(next); const detected = autoMapOrderColumns(sheet.rows[next - 1] || []); setMapping(preset === 'sig-order-qty' ? sigOrderColumnMapping() : detected.mapping); setLayout(preset === 'sig-order-qty' ? 'wide' : detected.layout); setSigColors({}); changed()
  }
  function choosePreset(value: OrderImportPreset) {
    if (!sheet) return
    const header = value === 'sig-order-qty' ? detectSigOrderHeaderRow(sheet) : detectOrderHeaderRow(sheet)
    const detected = autoMapOrderColumns(sheet.rows[header - 1] || [])
    setPreset(value); setHeaderRow(header); setMapping(value === 'sig-order-qty' ? sigOrderColumnMapping() : detected.mapping); setLayout(value === 'sig-order-qty' ? 'wide' : detected.layout); setSigColors({}); changed()
  }
  function columnSelect(label: string, value: number | null | undefined, onChange: (value: number | null) => void) {
    return <label className="field"><span className="field-label">{label}</span><select aria-label={`${label} 열`} className="select" value={value ?? ''} onChange={e => { onChange(e.target.value === '' ? null : Number(e.target.value)); changed() }} disabled={busy || preset === 'sig-order-qty'}><option value="">지정하지 않음</option>{headers.map((header, i) => <option key={i} value={i}>{columnLetter(i)} · {cellLabel(header) || '(제목 없음)'}</option>)}</select></label>
  }
  async function apply() {
    if (!preview || !allowed || !available || errorCount || stale || busy || applied || !preview.changes.length || reason.trim().length < 2) return
    setBusy(true); setError(''); setSuccess('')
    try { await onImport(preview.changes, mode, reason.trim()); setApplied(true); setSuccess(`${preview.changedStyles}개 스타일에 적용했습니다. 오더 수량 ${preview.changedLines}개 컬러 · 원본 참조 정보 ${preview.sourceChangedLines}개 컬러.`) } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  return <Modal title="Excel 오더 수량 가져오기" wide onClose={() => { if (!busy) onClose() }}>
    <div className="order-import">
      <div className="order-import-intro"><FileSpreadsheet size={25} strokeWidth={1.4}/><div><h3>파일을 확인하고, 변경 수량을 비교한 뒤 적용하세요.</h3><p>등록된 스타일·컬러의 XXS~XL 오더 수량을 반영합니다. SIG 형식의 원본 참조 열도 함께 저장합니다. 미등록 품번은 아래에서 공장·담당자·납기를 확인해 먼저 등록한 뒤 수량을 적용할 수 있습니다.</p></div></div>
      {!allowed && <div className="error-message" role="alert">오더 가져오기는 승인된 관리자·본사 직원만 사용할 수 있습니다.</div>}
      {!available && <div className="error-message" role="alert">추가 업무 기능 데이터베이스 설정이 필요합니다. 관리자가 003 마이그레이션을 적용한 뒤 다시 열어 주세요. 파일 검증은 먼저 진행할 수 있습니다.</div>}
      <label className={`order-file-drop ${loading ? 'loading' : ''}`}><input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="오더 Excel 파일" disabled={!allowed || loading || busy || !!registration} onChange={e => { void readFile(e.target.files?.[0]); e.currentTarget.value = '' }}/><Upload size={20}/><strong>{loading ? '오더 파일을 읽고 있습니다…' : book ? book.name : 'Excel · CSV 오더 파일 선택'}</strong><span>.xlsx · UTF-8/CP949 CSV · 최대 10MB · 파일은 브라우저에서 분석됩니다.</span>{book && <span className="order-selected-file"><CheckCircle2 size={12}/>{book.sheets.length}개 시트 확인{book.encoding && <> · 문자 인코딩 {book.encoding === 'cp949' ? 'CP949 (한국어 Excel CSV)' : 'UTF-8'}</>}</span>}</label>
      <p className="import-large-file-note">큰 Excel 파일은 첫 탭 ORDER QTY만 선택해 ‘CSV UTF-8’로 저장한 후 가져오세요. 이미지와 다른 시트는 CSV에 포함되지 않습니다.</p>
      {error && <div className="error-message" role="alert">{error}</div>}
      {book && sheet && <>
        <section className="import-step"><div className="import-step-heading"><span>01</span><h3>시트와 제목 행 확인</h3><p>자동 인식 결과를 확인해 주세요.</p></div><div className="import-sheet-settings"><label className="field"><span className="field-label">파일 형식</span><select className="select" aria-label="오더 파일 형식" value={preset} onChange={e => choosePreset(e.target.value as OrderImportPreset)} disabled={busy}><option value="generic">일반 열 연결</option><option value="sig-order-qty">SIG ORDER QTY</option></select></label><label className="field"><span className="field-label">데이터 시트</span><select className="select" aria-label="Excel 시트" value={sheetIndex} onChange={e => chooseSheet(Number(e.target.value))} disabled={busy}>{book.sheets.map((s, i) => <option key={i} value={i}>{s.name} · {Math.max(0, s.rows.length - 1).toLocaleString()}행</option>)}</select></label><label className="field"><span className="field-label">제목 행 번호</span><input type="number" className="input" aria-label="Excel 제목 행" min={1} max={Math.max(1, sheet.rows.length - 1)} value={headerRow} onChange={e => chooseHeader(Number(e.target.value))} disabled={busy}/></label><span>제목 행 아래 데이터만 분석합니다.</span></div>
          <details className="import-raw-preview"><summary>원본 상단 5행 보기<ChevronDown size={13}/></summary><div className="table-wrap"><table className="data-table"><thead><tr><th>행</th>{rawColumns.map(i => <th key={i}>{columnLetter(i)}</th>)}</tr></thead><tbody>{sheet.rows.slice(Math.max(0, headerRow - 2), headerRow + 4).map((row, i) => <tr key={i} className={Math.max(0, headerRow - 2) + i + 1 === headerRow ? 'header-highlight' : ''}><td>{Math.max(0, headerRow - 2) + i + 1}</td>{rawColumns.map(col => <td key={col} title={cellLabel(row[col])}>{cellLabel(row[col])}</td>)}</tr>)}</tbody></table></div></details>
        </section>
        <section className="import-step">{preset === 'sig-order-qty' && <div className="import-sig-profile"><strong>SIG ORDER QTY</strong><span>F열 품번 기준 · I열은 사용하지 않음 · AQ~AV = XXS~XL · AY = 총수량</span><small>A열은 프로젝트 코드, M열은 프로젝트 명칭입니다. F열에 컬러가 붙어 있으면 끝 두 자리를 분리하고, 기본 품번만 있으면 아래에서 컬러를 지정합니다.</small></div>}<div className="import-step-heading"><span>02</span><h3>열 연결</h3><p>품번은 컬러 포함 전체 품번 또는 기본 품번 + 색상으로 정확히 일치해야 합니다.</p></div>
          <div className="import-layout-options"><label><input type="radio" name="order-layout" checked={layout === 'wide'} onChange={() => { setLayout('wide'); changed() }} disabled={busy || preset === 'sig-order-qty'}/>가로 형식 · 사이즈별 열</label><label><input type="radio" name="order-layout" checked={layout === 'long'} onChange={() => { setLayout('long'); changed() }} disabled={busy || preset === 'sig-order-qty'}/>세로 형식 · 사이즈 / 수량</label></div>
          <div className="import-column-grid">{columnSelect('품번', mapping.sku, v => setMapping({ ...mapping, sku: v }))}{preset !== 'sig-order-qty' && columnSelect('색상', mapping.color, v => setMapping({ ...mapping, color: v }))}{layout === 'wide' ? <>{SIZES.map(size => <div key={size}>{columnSelect(`${size} 수량`, mapping.sizes[size], v => setMapping({ ...mapping, sizes: { ...mapping.sizes, [size]: v } }))}</div>)}{columnSelect('합계 검증 (선택)', mapping.total, v => setMapping({ ...mapping, total: v }))}</> : <>{columnSelect('사이즈', mapping.size, v => setMapping({ ...mapping, size: v }))}{columnSelect('수량', mapping.quantity, v => setMapping({ ...mapping, quantity: v }))}</>}</div>
          <p className="import-formula-note">수식은 실행하지 않고 Excel에 저장된 계산 결과만 읽습니다. 합계만 있는 파일은 사이즈별 수량 파일로 다시 저장해 주세요.</p>
        </section>
        <section className="import-step"><div className="import-step-heading"><span>03</span><h3>적용 방식</h3><p>미리보기는 선택한 방식에 따라 즉시 다시 계산됩니다.</p></div>
          <div className="import-mode-options"><label className={mode === 'replace' ? 'selected' : ''}><input type="radio" name="order-mode" aria-label="기존 오더 교체" checked={mode === 'replace'} onChange={() => { setMode('replace'); changed() }} disabled={busy}/><span><strong>기존 오더 교체</strong><small>파일의 사이즈별 수량으로 바꿉니다.</small></span></label><label className={mode === 'add' ? 'selected' : ''}><input type="radio" name="order-mode" aria-label="기존 오더에 추가" checked={mode === 'add'} onChange={() => { setMode('add'); changed() }} disabled={busy}/><span><strong>기존 오더에 추가</strong><small>리오더 수량을 현재 오더에 더합니다.</small></span></label></div>
          <div className="import-check-options"><label><input type="checkbox" checked={duplicateMode === 'sum'} onChange={e => { setDuplicateMode(e.target.checked ? 'sum' : 'reject'); changed() }} disabled={busy}/>중복 품번·사이즈 수량 합산 허용</label><label><input type="checkbox" checked={missingSizes === 'zero'} onChange={e => { setMissingSizes(e.target.checked ? 'zero' : 'reject'); changed() }} disabled={busy}/>누락 사이즈를 0으로 처리</label></div><p className="import-option-warning">기본값은 중복·누락을 오류로 처리합니다. 교체 모드에서 누락 사이즈를 0으로 처리하면 해당 사이즈의 기존 오더가 0으로 바뀝니다. 지정한 사이즈 열의 빈 셀은 0으로 읽습니다.</p>
        </section>
        {preview && <section className="import-step import-preview"><div className="import-step-heading"><span>04</span><h3>적용 전 미리보기</h3><p>전체 데이터에 오류가 없어야 적용할 수 있습니다.</p></div>
          <div className="import-preview-summary"><span>분석 <b>{formatNumber(preview.sourceRows)}</b>행</span><span>매칭 <b>{formatNumber(preview.matchedLines)}</b>컬러</span><span>적용 <b>{formatNumber(preview.changedStyles)}</b>스타일 · 수량 <b>{formatNumber(preview.changedLines)}</b>컬러{preview.sourceChangedLines > 0 && <> · 원본 정보 <b>{formatNumber(preview.sourceChangedLines)}</b>컬러</>}</span><span className={errorCount ? 'has-error' : 'no-error'}>오류 <b>{errorCount}</b></span>{warningCount > 0 && <span className="has-warning">확인사항 <b>{warningCount}</b></span>}</div>
          {preview.errors.map((item, i) => <p className="import-validation-error" key={i}><AlertCircle size={14}/>{item}</p>)}
          {baseColorRows.length > 0 && <section className="import-base-colors" aria-label="기본 품번 컬러 지정"><h4>F열 기본 품번의 컬러 확인</h4><p>I열은 읽지 않습니다. 등록된 컬러가 하나면 자동 연결하며, 여러 컬러이거나 미등록 품번이면 가져올 컬러를 직접 입력하세요.</p>{baseColorRows.slice(0, visibleRows).map(item => <label className="import-base-color-row" key={item.rowNumber}><span>{item.rowNumber}행 · <strong>{item.sku}</strong></span><input className="input" aria-label={`원본 ${item.rowNumber}행 컬러`} value={item.color} placeholder="예: BK" maxLength={2} disabled={busy || applied || !!registration} onChange={event => { setSigColors(current => ({ ...current, [item.rowNumber]: event.target.value.toUpperCase() })); setError(''); setSuccess(''); setApplied(false) }}/><small>{item.inferred && sigColors[item.rowNumber] === undefined ? '등록된 단일 컬러 연결' : '영문 두 자리 컬러'}</small></label>)}{baseColorRows.length > visibleRows && <button className="button button-ghost" onClick={() => setVisibleRows(value => value + 50)}>컬러 지정 행 더 보기</button>}</section>}
          {preview.rows.some(row => !row.lineId) && <p className="import-formula-note">미등록·컬러 미지정 행에도 파일에서 읽은 수량을 표시합니다. 스타일·컬러를 확인하기 전에는 수량을 저장하지 않습니다.</p>}
          <div className="table-wrap import-preview-table"><table className="data-table"><thead><tr><th>원본 행</th><th>{preset === 'sig-order-qty' ? 'F열 품번 / 제품명' : '품번 / 제품명'}</th>{preset === 'sig-order-qty' && <><th>A · 프로젝트 코드</th><th>M · 프로젝트 명칭</th></>}{SIZES.map(size => <th key={size}>{size}</th>)}<th>총수량</th><th>검증 결과</th></tr></thead><tbody>{preview.rows.slice(0, visibleRows).map((row, i) => <tr key={row.lineId || `error-${i}`} className={row.errors.length ? 'import-error-row' : row.changed ? 'import-changed-row' : ''}><td title={row.rowNumbers.join(', ')}>{row.rowNumbers.length > 3 ? `${row.rowNumbers[0]} 외 ${row.rowNumbers.length - 1}` : row.rowNumbers.join(', ')}</td><td><strong>{row.sku || '품번 없음'}</strong><small>{row.styleName || row.color || '미등록 품번·컬러'}</small></td>{preset === 'sig-order-qty' && <><td>{projectValue(row, 'A') || '—'}</td><td>{projectValue(row, 'M') || '—'}</td></>}{SIZES.map(size => <td key={size} className={row.before[size] !== row.after[size] ? 'changed-quantity' : ''}>{row.lineId ? <><span>{formatNumber(row.before[size])}</span><ArrowRight size={10}/><b>{formatNumber(row.after[size])}</b></> : <><span>파일 </span><b>{formatNumber(row.imported[size])}</b></>}</td>)}<td className="import-total-cell">{row.lineId ? <><span>{formatNumber(quantityTotal(row.before))}</span><ArrowRight size={10}/><b>{formatNumber(quantityTotal(row.after))}</b></> : <><span>파일 </span><b>{formatNumber(quantityTotal(row.imported))}</b></>}</td><td>{row.errors.length ? <details open={preview.rows.length <= 5}><summary className="import-row-error"><X size={12}/>오류 {row.errors.length}건</summary>{row.errors.map((item, n) => <p key={n}>{item}</p>)}</details> : <span className={row.changed || row.sourceChanged ? 'import-row-ok' : 'muted'}><CheckCircle2 size={12}/>{row.changed ? '수량 변경 예정' : row.sourceChanged ? '원본 정보 저장' : '변경 없음'}</span>}{preset === 'sig-order-qty' && (!row.lineId || needsProjectLink(row)) && !!onRegisterStyle && <button type="button" className="button import-register-row" disabled={!allowed || busy || workspace.refinementsAvailable !== true || !!registration} onClick={() => beginRegistration(row.rowNumbers[0])}>{row.lineId ? '프로젝트 연결' : '스타일·프로젝트 등록'}</button>}{row.warnings.length > 0 && <details><summary className="import-row-warning">확인 {row.warnings.length}건</summary>{row.warnings.map((item, n) => <p key={n}>{item}</p>)}</details>}</td></tr>)}</tbody></table></div>
          {preset === 'sig-order-qty' && preview.rows.some(row => !row.lineId || needsProjectLink(row)) && !!onRegisterStyle && workspace.refinementsAvailable !== true && <p className="import-validation-error">미등록 스타일·프로젝트 등록은 005 업데이트 적용 후 사용할 수 있습니다. 기존 등록 품번의 수량 적용은 계속 사용할 수 있습니다.</p>}
          {registration?.style && registration.project && <section className="import-registration" aria-label="미등록 스타일 등록"><div className="section-heading"><div><h3>{registration.isNewStyle ? '신규 스타일·프로젝트 등록' : registration.isNewColor ? '기존 스타일에 컬러 등록' : '기존 스타일 프로젝트 연결'}</h3><p className="muted">이 단계는 기본 정보만 등록합니다. 오더 수량은 등록 후 미리보기를 확인하고 별도로 적용합니다.</p></div></div><div className="form-grid">
            <label className="field"><span className="field-label">F열 기본 품번</span><input className="input" aria-label="등록 기본 품번" readOnly value={registration.style.code}/></label>
            <label className="field"><span className="field-label">가져올 컬러</span><input className="input" aria-label="등록 컬러" readOnly value={registration.color}/></label>
            <label className="field"><span className="field-label">A열 프로젝트 코드</span><input className="input" aria-label="등록 프로젝트 코드" readOnly value={registration.project.code}/></label>
            <label className="field"><span className="field-label">M열 프로젝트 명칭</span><input className="input" aria-label="등록 프로젝트 명칭" readOnly value={registration.project.name}/></label>
            <label className="field"><span className="field-label">L열 시즌</span><input className="input" readOnly value={registration.project.season}/></label>
            <label className="field"><span className="field-label">담당 공장</span><select className="select" aria-label="등록 담당 공장" value={registration.style.factoryId} disabled={busy || !registration.isNewStyle} onChange={event => editRegistration('factoryId', event.target.value)}><option value="">등록된 공장 선택</option>{workspace.factories.map(factory => <option key={factory.id} value={factory.id}>{factory.name}</option>)}</select>{registration.sourceFactory && <small>W열 생산처: {registration.sourceFactory}</small>}</label>
            <label className="field"><span className="field-label">본사 담당자</span><select className="select" aria-label="등록 본사 담당자" value={registration.style.ownerId} disabled={busy || !registration.isNewStyle} onChange={event => editRegistration('ownerId', event.target.value)}><option value="">담당자 선택</option>{workspace.profiles.filter(owner => owner.role !== 'factory' && owner.approved && owner.active).map(owner => <option key={owner.id} value={owner.id}>{owner.name}</option>)}</select>{registration.sourceOwner && <small>Y열 담당자: {registration.sourceOwner}</small>}</label>
            <label className="field"><span className="field-label">기준 납기일 · 직접 지정</span><input className="input" aria-label="등록 기준 납기일" type="date" value={registration.style.dueDate} disabled={busy || !registration.isNewStyle} onChange={event => editRegistration('dueDate', event.target.value)}/><small>발주 요청일을 납기일로 임의 사용하지 않습니다.</small></label>
          </div>{registration.isNewProject ? <p className="muted">A·M열로 새 프로젝트를 함께 등록합니다.</p> : <p className="muted">등록된 프로젝트를 연결합니다. 프로젝트 코드와 명칭을 서로 바꾸지 않습니다.</p>}{!registration.isNewStyle && workspace.styles.find(style => style.id === registration.style!.id)?.projectId !== registration.project.id && <p className="import-option-warning">기존 스타일의 프로젝트를 위 A·M열 프로젝트로 변경합니다. 해당 스타일의 모든 컬러가 같은 프로젝트를 사용합니다.</p>}
            <label className="field"><span className="field-label">스타일 등록 사유</span><input className="input" aria-label="스타일 등록 사유" maxLength={1000} value={registrationReason} disabled={busy} onChange={event => setRegistrationReason(event.target.value)}/></label>{registrationError && <div className="error-message" role="alert">{registrationError}</div>}<div className="import-registration-actions"><button type="button" className="button" disabled={busy} onClick={() => { setRegistration(null); setRegistrationError('') }}>스타일 등록 취소</button><button type="button" className="button button-primary" disabled={busy || !!awaitingRegistration} onClick={() => void registerStyle()}>{busy || awaitingRegistration ? '등록 중…' : '스타일·프로젝트 등록 저장'}</button></div>
          </section>}
          {preview.rows.length > visibleRows && <button className="button button-ghost import-more" onClick={() => setVisibleRows(v => v + 50)}>미리보기 더 보기 ({visibleRows} / {preview.rows.length})<ChevronDown size={13}/></button>}
          {stale && <div className="import-stale" role="alert"><AlertCircle size={16}/><span>미리보기 이후 원본 스타일이 변경되었습니다. 최신 오더와 버전을 다시 확인해 주세요.</span></div>}
          {preset === 'sig-order-qty' && preview.rows.some(row => row.sourceMetadata?.length) && <details className="import-source-metadata"><summary>원본 참조 열 확인 · A / F / L / M / S / V / W / X / Y / AQ~AV / AY<ChevronDown size={13}/></summary><p>추가 열 이름과 의미를 임의로 바꾸지 않습니다. 아래 16개 열의 제목·원본 값, 파일명·시트명·행 번호를 오더 수량과 함께 저장합니다. 수량이 같아도 원본 참조 정보가 달라지면 적용 대상에 포함됩니다.</p><div className="table-wrap"><table className="data-table"><thead><tr><th>원본 행</th>{SIG_ORDER_SOURCE_COLUMNS.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{preview.rows.flatMap(row => row.sourceMetadata || []).slice(0, 10).map(source => <tr key={source.rowNumber}><td>{source.rowNumber}</td>{SIG_ORDER_SOURCE_COLUMNS.map(column => <td key={column} title={cellLabel(source.columns[column])}>{cellLabel(source.columns[column])}</td>)}</tr>)}</tbody></table></div></details>}
          <div className="import-revalidate"><span>파일 분석 시점의 버전을 보관합니다. 다른 사용자가 먼저 저장하면 전체 적용이 취소됩니다.</span><button className="button button-ghost" onClick={() => { setSnapshot(structuredClone(workspace)); changed() }} disabled={busy}><RefreshCw size={13}/>최신 데이터로 다시 검증</button></div>
          <label className="field import-reason"><span className="field-label">변경 사유</span><textarea className="textarea" aria-label="오더 변경 사유" placeholder="예: 확정 오더 반영 / 추가 오더 수량 반영" value={reason} maxLength={1000} onChange={e => setReason(e.target.value)} disabled={busy || applied}/></label>
          {success && <div className="success-message" role="status"><CheckCircle2 size={15}/>{success}</div>}
          <div className="import-apply-footer"><p>출고·입고 수량과 생산 체크리스트는 변경하지 않습니다.<br/>SIG 형식은 원본 참조 열과 오더 수량을 함께 저장하며, 변경 사유도 보관합니다.</p><button className="button button-primary" onClick={() => void apply()} disabled={!allowed || !available || busy || loading || !!errorCount || stale || !preview.changes.length || reason.trim().length < 2 || applied}>{busy ? '전체 오더 적용 중…' : applied ? '적용 완료' : '검증된 오더 적용'}<ArrowRight size={15}/></button></div>
        </section>}
      </>}
      <footer className="order-import-close"><span>FIVE SPACE / SIG · ORDER IMPORT</span><button className="button button-ghost" disabled={busy} onClick={onClose}>닫기</button></footer>
    </div>
  </Modal>
}
