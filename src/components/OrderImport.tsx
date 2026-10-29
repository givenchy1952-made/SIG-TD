import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, CheckCircle2, ChevronDown, FileSpreadsheet, RefreshCw, Upload, X } from 'lucide-react'
import { Modal } from './ui'
import { SIZES, quantityTotal } from '../lib/types'
import type { Profile, Style, Workspace } from '../lib/types'
import type { RegistrationProject } from '../lib/order-registration'
import { buildBulkOrderRegistrationPlan, sourceFactoryGroups, sourceOwnerGroups } from '../lib/bulk-order-registration'
import type { OrderImportChange } from '../lib/operations-types'
import { autoMapOrderColumns, buildOrderImportPreview, detectOrderHeaderRow, detectSigOrderHeaderRow, orderImportDefaults, parseOrderWorkbook, readSigRowSku, sigOrderColumnMapping, SIG_ORDER_SOURCE_COLUMNS } from '../lib/order-import'
import type { ImportCell, ImportLayout, ImportWorkbook, OrderColumnMapping, OrderImportPreset } from '../lib/order-import'
import { message } from '../lib/utils'
import './order-import.css'
interface Props { workspace: Workspace; profile: Profile; onClose: () => void; onImport: (changes: OrderImportChange[], mode: 'replace' | 'add', reason: string) => Promise<void>; onRegisterStyle?: (style: Style, project: RegistrationProject, reason: string) => Promise<Workspace> }
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
  const [sigSkus, setSigSkus] = useState<Record<number, string>>({})
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [skuDetailsOpen, setSkuDetailsOpen] = useState(false)
  const [bulkOwners, setBulkOwners] = useState<Record<string, string>>({})
  const [bulkDueDate, setBulkDueDate] = useState('')
  const [bulkFactories, setBulkFactories] = useState<Record<string, string>>({})
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)
  const sequence = useRef(0)
  useEffect(() => () => { sequence.current += 1 }, [])
  const allowed = profile.approved && profile.active && profile.role !== 'factory'
  const available = (workspace as Workspace & { operationsAvailable?: boolean }).operationsAvailable === true
  const productionOrdersAvailable = available && workspace.productionLedgerAvailable === true && workspace.supplierOrdersAvailable === true
  const sheet = book?.sheets[sheetIndex]
  const headers = sheet?.rows[headerRow - 1] || []
  const rawColumns = Array.from({ length: Math.min(15, headers.length) }, (_, index) => index).filter(index => preset !== 'sig-order-qty' || index !== 8)
  const bulkOptions = useMemo(() => ({ createProductionRounds: true, fileName: book?.name, preset, sigSkus, sigBudgetFallback: true, mapping, layout, headerRow, duplicateMode, missingSizes, mode }), [book?.name, preset, sigSkus, mapping, layout, headerRow, duplicateMode, missingSizes, mode])
  const automatic = preset === 'sig-order-qty' && !!onRegisterStyle && workspace.refinementsAvailable === true
  const ownerSetupRequired = automatic && workspace.importColorOwnersAvailable === false
  const filePreview = useMemo(() => snapshot && sheet ? buildOrderImportPreview(snapshot, sheet, bulkOptions) : null, [snapshot, sheet, bulkOptions])
  const bulkPlan = useMemo(() => automatic && snapshot && sheet ? buildBulkOrderRegistrationPlan(snapshot, sheet, bulkOptions, { defaults: { ownerId: '', dueDate: bulkDueDate }, factoryMappings: bulkFactories, ownerMappings: bulkOwners, automatic: true }) : null, [automatic, snapshot, sheet, bulkOptions, bulkOwners, bulkDueDate, bulkFactories])
  const preview = bulkPlan?.preview || filePreview
  const bulkGroups = useMemo(() => sheet && preset === 'sig-order-qty' ? sourceFactoryGroups(snapshot || workspace, sheet, headerRow, sigSkus) : [], [snapshot, workspace, sheet, preset, headerRow, sigSkus])
  const ownerGroups = useMemo(() => sheet && preset === 'sig-order-qty' ? sourceOwnerGroups(snapshot || workspace, sheet, headerRow, sigSkus) : [], [snapshot, workspace, sheet, preset, headerRow, sigSkus])
  const needsOwnerSelection = ownerGroups.some(group => !(bulkOwners[group.source] ?? group.ownerId))
  const automaticIds = new Set(bulkPlan?.entries.map(entry => entry.style.id) || [])
  const needsFactorySelection = bulkPlan?.entries.some(entry => !snapshot?.styles.some(style => style.id === entry.style.id) && !workspace.factories.some(factory => factory.id === entry.style.factoryId)) || false
  const needsSkuCorrection = filePreview?.rows.some(row => row.errors.some(error => error.includes('F열에 기본 품번만') || error.includes('가져올 컬러') || error.includes('전체 품번이 여러') || error.includes('생산 내역이 여러') || error.includes('F열 품번은'))) || false
  const skuRows = preset === 'sig-order-qty' && sheet ? sheet.rows.slice(headerRow).flatMap((source, index) => {
    if (!cellLabel(source[5]).trim()) return []
    const rowNumber = headerRow + index + 1
    let original = cellLabel(source[5]).trim().toUpperCase()
    try { original = readSigRowSku(source, undefined, true) } catch { /* Preview reports invalid identities. */ }
    return [{ rowNumber, sku: sigSkus[rowNumber] ?? original, fromBudget: original !== cellLabel(source[5]).trim().toUpperCase() }]
  }) : []
  const errorCount = preview ? preview.errors.length + preview.rows.reduce((sum, row) => sum + row.errors.length, 0) : 0
  const warningCount = preview ? preview.warnings.length + preview.rows.reduce((sum, row) => sum + row.warnings.length, 0) : 0
  const isRegistrationPending = (row: NonNullable<typeof preview>['rows'][number]) => !row.errors.length && !!row.styleId && automaticIds.has(row.styleId)
  const projectValue = (row: NonNullable<typeof preview>['rows'][number], column: 'A' | 'M' | 'L') => cellLabel(row.sourceMetadata?.[0]?.columns[column] ?? row.source?.rows[0]?.columns[column])
  const registrationPendingCount = preview?.rows.filter(isRegistrationPending).length || 0
  const visibleErrorCount = errorCount - (preview?.rows.filter(isRegistrationPending).reduce((sum, row) => sum + row.errors.length, 0) || 0)
  const stale = !applied && (preview?.changes.some(change => { const before = snapshot?.styles.find(style => style.id === change.styleId); if (!before) return false; const current = workspace.styles.find(style => style.id === change.styleId); return !current || current.deletedAt || current.version !== change.expectedVersion || change.lines.some(line => line.source && (workspace.operations?.orderSourceRecords?.find(source => source.styleId === change.styleId && source.lineId === line.lineId)?.version || 0) !== line.source.expectedVersion) }) || false)
  async function registerAll() {
    if (!bulkPlan || !snapshot || !sheet || !onRegisterStyle || !allowed || !productionOrdersAvailable || ownerSetupRequired || busy || applied || stale || bulkPlan.errors.length || !bulkPlan.entries.length || reason.trim().length < 2) return
    const plan = bulkPlan, basis = snapshot, options = bulkOptions, targetSheet = sheet
    for (const entry of plan.entries) {
      const before = basis.styles.find(style => style.id === entry.style.id)
      const current = workspace.styles.find(style => style.id === entry.style.id)
      if (before && (!current || current.deletedAt || current.version !== before.version)) { setError('파일 분석 이후 품번이 변경되었습니다. 최신 데이터로 다시 검증해 주세요.'); return }
    }
    setBusy(true); setError(''); setSuccess(''); setBulkProgress({ done: 0, total: plan.entries.length })
    let prepared = structuredClone(basis), registered = 0, applying = false
    try {
      for (const entry of plan.entries) {
        const fresh = await onRegisterStyle(entry.style, entry.project, reason.trim())
        registered += 1
        const saved = fresh.styles.find(style => style.id === entry.style.id)
        const project = fresh.projects.find(project => project.id === entry.project.id)
        if (!saved || !project || saved.version !== entry.style.version + 1) throw new Error('등록 직후 품번이나 프로젝트가 변경됐습니다. 최신 정보를 확인한 뒤 다시 시도해 주세요.')
        // Rebase only records written by this batch; unrelated snapshot versions
        // stay unchanged so the final importer still detects concurrent edits.
        prepared = { ...prepared, styles: [...prepared.styles.filter(style => style.id !== saved.id), saved], projects: [...prepared.projects.filter(item => item.id !== project.id), project] }
        setSnapshot(structuredClone(prepared)); setBulkProgress({ done: registered, total: plan.entries.length })
      }
      const checked = buildOrderImportPreview(prepared, targetSheet, options)
      const failures = [...checked.errors, ...checked.rows.flatMap(row => row.errors)]
      if (failures.length || !checked.changes.length) throw new Error(failures[0] || '적용할 오더 수량을 확인하지 못했습니다.')
      applying = true
      await onImport(checked.changes, options.mode, reason.trim())
      setApplied(true); setSettingsOpen(false); setSuccess(`프로젝트·품번 자동 등록과 수량 적용을 완료했습니다. ${checked.rows.length}개 품번 · 새 생산 차수 ${checked.changes.reduce((sum, change) => sum + change.lines.length, 0)}개 · 총 ${formatNumber(checked.rows.reduce((sum, row) => sum + quantityTotal(row.imported), 0))}개`)
    } catch (failure) {
      setError(applying ? `품번 기본 정보 ${registered}개를 등록했습니다. 수량 적용 결과는 최신 데이터로 확인해 주세요. ${message(failure)}` : `품번 기본 정보 ${registered}개를 등록했고, 오더 수량은 아직 적용하지 않았습니다. 안내를 확인하고 남은 품번을 다시 등록해 주세요. ${message(failure)}`)
    } finally { setBusy(false); setBulkProgress(null) }
  }
  const changed = () => { setSettingsOpen(false); setError(''); setSuccess(''); setApplied(false); setVisibleRows(25) }
  async function readFile(file?: File) {
    if (!file || !allowed || busy) return
    const ticket = ++sequence.current
    setLoading(true); setSettingsOpen(false); setSkuDetailsOpen(false); setBulkFactories({}); setBulkDueDate(''); setBulkOwners({}); setError(''); setSuccess(''); setApplied(false); setBook(null); setSnapshot(null); setSigSkus({})
    try {
      const loaded = await parseOrderWorkbook(file)
      if (ticket !== sequence.current) return
      const defaults = orderImportDefaults(loaded)
      setBook(loaded); setSnapshot(structuredClone(workspace)); setSheetIndex(defaults.sheetIndex); setPreset(defaults.preset); setHeaderRow(defaults.headerRow); setMapping(defaults.mapping); setLayout(defaults.layout); setVisibleRows(25); setReason('오더 파일 수량 반영')
    } catch (e) { if (ticket === sequence.current) setError(message(e)) } finally { if (ticket === sequence.current) setLoading(false) }
  }
  function chooseSheet(index: number) {
    if (!book) return
    const defaults = orderImportDefaults(book, index)
    setSheetIndex(index); setPreset(defaults.preset); setHeaderRow(defaults.headerRow); setMapping(defaults.mapping); setLayout(defaults.layout); setSigSkus({}); changed()
  }
  function chooseHeader(row: number) {
    if (!sheet) return
    const next = Math.max(1, Math.min(Math.max(1, sheet.rows.length - 1), Math.floor(row) || 1))
    setHeaderRow(next); const detected = autoMapOrderColumns(sheet.rows[next - 1] || []); setMapping(preset === 'sig-order-qty' ? sigOrderColumnMapping() : detected.mapping); setLayout(preset === 'sig-order-qty' ? 'wide' : detected.layout); setSigSkus({}); changed()
  }
  function choosePreset(value: OrderImportPreset) {
    if (!sheet) return
    const header = value === 'sig-order-qty' ? detectSigOrderHeaderRow(sheet) : detectOrderHeaderRow(sheet)
    const detected = autoMapOrderColumns(sheet.rows[header - 1] || [])
    setPreset(value); setHeaderRow(header); setMapping(value === 'sig-order-qty' ? sigOrderColumnMapping() : detected.mapping); setLayout(value === 'sig-order-qty' ? 'wide' : detected.layout); setSigSkus({}); changed()
  }
  function columnSelect(label: string, value: number | null | undefined, onChange: (value: number | null) => void) {
    return <label className="field"><span className="field-label">{label}</span><select aria-label={`${label} 열`} className="select" value={value ?? ''} onChange={e => { onChange(e.target.value === '' ? null : Number(e.target.value)); changed() }} disabled={busy || preset === 'sig-order-qty'}><option value="">지정하지 않음</option>{headers.map((header, i) => <option key={i} value={i}>{columnLetter(i)} · {cellLabel(header) || '(제목 없음)'}</option>)}</select></label>
  }
  async function apply() {
    if (!preview || !allowed || !available || ownerSetupRequired || errorCount || stale || busy || applied || !preview.changes.length || reason.trim().length < 2 || bulkPlan?.errors.length) return
    if (bulkPlan?.entries.length) { await registerAll(); return }
    setBusy(true); setError(''); setSuccess('')
    try { await onImport(preview.changes, mode, reason.trim()); setApplied(true); setSuccess(`${preview.changedStyles}개 스타일에 적용하고 새 생산 차수 ${preview.changes.reduce((sum, change) => sum + change.lines.length, 0)}개를 만들었습니다. 오더 수량 변경 ${preview.changedLines}개 컬러 · 원본 참조 정보 ${preview.sourceChangedLines}개 컬러.`) } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  return <Modal title="Excel 오더 수량 가져오기" wide onClose={() => { if (!busy) onClose() }}>
    <div className="order-import">
      <div className="order-import-intro"><FileSpreadsheet size={25} strokeWidth={1.4}/><div><h3>파일을 확인하고, 변경 수량을 비교한 뒤 적용하세요.</h3><p>파일의 전체 품번과 XXS~XL 오더 수량을 가져옵니다. SIG 형식의 원본 참조 열도 함께 저장합니다. SIG 파일의 A열 프로젝트와 F열 품번은 오더 적용 시 자동 등록합니다.</p></div></div>
      {!allowed && <div className="error-message" role="alert">오더 가져오기는 승인된 관리자·본사 직원만 사용할 수 있습니다.</div>}
      {!available && <div className="error-message" role="alert">추가 업무 기능 데이터베이스 설정이 필요합니다. 관리자가 003 마이그레이션을 적용한 뒤 다시 열어 주세요. 파일 검증은 먼저 진행할 수 있습니다.</div>}
      <label className={`order-file-drop ${loading ? 'loading' : ''}`}><input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="오더 Excel 파일" disabled={!allowed || loading || busy} onChange={e => { void readFile(e.target.files?.[0]); e.currentTarget.value = '' }}/><Upload size={20}/><strong>{loading ? '오더 파일을 읽고 있습니다…' : book ? book.name : 'Excel · CSV 오더 파일 선택'}</strong><span>.xlsx · UTF-8/CP949 CSV · 최대 10MB · 파일은 브라우저에서 분석됩니다.</span>{book && <span className="order-selected-file"><CheckCircle2 size={12}/>{book.sheets.length}개 시트 확인{book.encoding && <> · 문자 인코딩 {book.encoding === 'cp949' ? 'CP949 (한국어 Excel CSV)' : 'UTF-8'}</>}</span>}</label>
      <p className="import-large-file-note">큰 Excel 파일은 첫 탭 ORDER QTY만 선택해 ‘CSV UTF-8’로 저장한 후 가져오세요. 이미지와 다른 시트는 CSV에 포함되지 않습니다.</p>
      {error && <div className="error-message" role="alert">{error}</div>}
      {book && sheet && <>
        <section className="import-step"><div className="import-step-heading"><span>01</span><h3>시트와 제목 행 확인</h3><p>자동 인식 결과를 확인해 주세요.</p></div><div className="import-sheet-settings"><label className="field"><span className="field-label">파일 형식</span><select className="select" aria-label="오더 파일 형식" value={preset} onChange={e => choosePreset(e.target.value as OrderImportPreset)} disabled={busy}><option value="generic">일반 열 연결</option><option value="sig-order-qty">SIG ORDER QTY</option></select></label><label className="field"><span className="field-label">데이터 시트</span><select className="select" aria-label="Excel 시트" value={sheetIndex} onChange={e => chooseSheet(Number(e.target.value))} disabled={busy}>{book.sheets.map((s, i) => <option key={i} value={i}>{s.name} · {Math.max(0, s.rows.length - 1).toLocaleString()}행</option>)}</select></label><label className="field"><span className="field-label">제목 행 번호</span><input type="number" className="input" aria-label="Excel 제목 행" min={1} max={Math.max(1, sheet.rows.length - 1)} value={headerRow} onChange={e => chooseHeader(Number(e.target.value))} disabled={busy}/></label><span>제목 행 아래 데이터만 분석합니다.</span></div>
          <details className="import-raw-preview"><summary>원본 상단 5행 보기<ChevronDown size={13}/></summary><div className="table-wrap"><table className="data-table"><thead><tr><th>행</th>{rawColumns.map(i => <th key={i}>{columnLetter(i)}</th>)}</tr></thead><tbody>{sheet.rows.slice(Math.max(0, headerRow - 2), headerRow + 4).map((row, i) => <tr key={i} className={Math.max(0, headerRow - 2) + i + 1 === headerRow ? 'header-highlight' : ''}><td>{Math.max(0, headerRow - 2) + i + 1}</td>{rawColumns.map(col => <td key={col} title={cellLabel(row[col])}>{cellLabel(row[col])}</td>)}</tr>)}</tbody></table></div></details>
        </section>
        <section className="import-step">{preset === 'sig-order-qty' && <div className="import-sig-profile"><strong>SIG ORDER QTY</strong><span>전체 품번 기준 · I열은 사용하지 않음 · AQ~AV = XXS~XL · AY = 총수량</span><small>A열은 프로젝트 코드, M열은 프로젝트 명칭입니다. 전체 품번을 자동으로 가져오며 컬러를 따로 입력하지 않습니다.</small></div>}<div className="import-step-heading"><span>02</span><h3>열 연결</h3><p>품번은 컬러 포함 전체 품번 또는 기본 품번 + 색상으로 정확히 일치해야 합니다.</p></div>
          <div className="import-layout-options"><label><input type="radio" name="order-layout" checked={layout === 'wide'} onChange={() => { setLayout('wide'); changed() }} disabled={busy || preset === 'sig-order-qty'}/>가로 형식 · 사이즈별 열</label><label><input type="radio" name="order-layout" checked={layout === 'long'} onChange={() => { setLayout('long'); changed() }} disabled={busy || preset === 'sig-order-qty'}/>세로 형식 · 사이즈 / 수량</label></div>
          <div className="import-column-grid">{columnSelect('품번', mapping.sku, v => setMapping({ ...mapping, sku: v }))}{preset !== 'sig-order-qty' && columnSelect('색상', mapping.color, v => setMapping({ ...mapping, color: v }))}{layout === 'wide' ? <>{SIZES.map(size => <div key={size}>{columnSelect(`${size} 수량`, mapping.sizes[size], v => setMapping({ ...mapping, sizes: { ...mapping.sizes, [size]: v } }))}</div>)}{columnSelect('합계 검증 (선택)', mapping.total, v => setMapping({ ...mapping, total: v }))}</> : <>{columnSelect('사이즈', mapping.size, v => setMapping({ ...mapping, size: v }))}{columnSelect('수량', mapping.quantity, v => setMapping({ ...mapping, quantity: v }))}</>}</div>
          <p className="import-formula-note">수식은 실행하지 않고 Excel에 저장된 계산 결과만 읽습니다. 합계만 있는 파일은 사이즈별 수량 파일로 다시 저장해 주세요.</p>
        </section>
        <section className="import-step"><div className="import-step-heading"><span>03</span><h3>적용 방식</h3><p>미리보기는 선택한 방식에 따라 즉시 다시 계산됩니다.</p></div><p className="import-option-warning">업로드할 때마다 파일 수량으로 프로젝트별 새 생산 차수를 만듭니다. 아래 선택은 기존 컬러 합계에만 적용됩니다. PO를 작성·발송하고 업체가 납기·단가를 회신하면, 본사 최종 승인 후 생산을 시작할 수 있습니다.</p>
          <div className="import-mode-options"><label className={mode === 'replace' ? 'selected' : ''}><input type="radio" name="order-mode" aria-label="기존 오더 교체" checked={mode === 'replace'} onChange={() => { setMode('replace'); changed() }} disabled={busy}/><span><strong>기존 오더 교체</strong><small>파일의 사이즈별 수량으로 바꿉니다.</small></span></label><label className={mode === 'add' ? 'selected' : ''}><input type="radio" name="order-mode" aria-label="기존 오더에 추가" checked={mode === 'add'} onChange={() => { setMode('add'); changed() }} disabled={busy}/><span><strong>기존 오더에 추가</strong><small>리오더 수량을 현재 오더에 더합니다.</small></span></label></div>
          <div className="import-check-options"><label><input type="checkbox" checked={duplicateMode === 'sum'} onChange={e => { setDuplicateMode(e.target.checked ? 'sum' : 'reject'); changed() }} disabled={busy}/>중복 품번·사이즈 수량 합산 허용</label><label><input type="checkbox" checked={missingSizes === 'zero'} onChange={e => { setMissingSizes(e.target.checked ? 'zero' : 'reject'); changed() }} disabled={busy}/>누락 사이즈를 0으로 처리</label></div><p className="import-option-warning">기본값은 중복·누락을 오류로 처리합니다. 교체 모드에서 누락 사이즈를 0으로 처리하면 해당 사이즈의 기존 오더가 0으로 바뀝니다. 지정한 사이즈 열의 빈 셀은 0으로 읽습니다.</p>
        </section>
        {preview && <section className="import-step import-preview"><div className="import-step-heading"><span>04</span><h3>적용 전 미리보기</h3><p>전체 데이터에 오류가 없어야 적용할 수 있습니다.</p></div>
          {bulkPlan && !applied && !!bulkPlan.entries.length && <div className="import-auto-summary"><CheckCircle2 size={16}/><div><strong>프로젝트·품번 자동 등록</strong><p>A열 프로젝트 {bulkPlan.projectCount}개 · F열 신규 기본 스타일 {bulkPlan.newStyleCount}개 · 새 컬러 품번 {bulkPlan.newColorCount}개를 오더 수량과 함께 등록합니다. 아래 오더 적용 버튼을 한 번만 눌러 주세요.</p></div></div>}
          {automatic && <details className="import-registration import-auto-settings" open={settingsOpen || needsFactorySelection || needsOwnerSelection} onToggle={event => setSettingsOpen(event.currentTarget.open)}><summary>업로드 기본 설정 (선택)</summary><section aria-label="업로드 기본 설정">
            <p className="muted">공장은 W열, 담당자는 Y열의 본사 구성원 이름·이메일로 연결합니다. Y열이 비어 있으면 담당자 미지정으로 등록하며 나중에 선택할 수 있습니다. 파일에 납기가 없으면 미정으로 등록합니다.</p>
            <div className="form-grid"><label className="field"><span className="field-label">기준 납기일 (선택)</span><input className="input" type="date" aria-label="일괄 등록 기준 납기일" value={bulkDueDate} disabled={busy} onChange={event => setBulkDueDate(event.target.value)}/><small>미입력 시 납기 미정으로 등록하고, PO 발송 때 요청 납기를 입력합니다.</small></label></div>
            {needsOwnerSelection && <p className="import-validation-error" role="status">Y열의 담당자를 자동 연결하지 못했습니다. 아래에서 해당 본사 구성원을 한 번만 선택해 주세요.</p>}
            {!!ownerGroups.length && <div className="form-grid">{ownerGroups.map(group => <label className="field" key={group.source}><span className="field-label">Y열 {group.source} · {group.count}개 품번</span><select className="select" aria-label={`Y열 담당자 연결 ${group.source}`} value={bulkOwners[group.source] ?? group.ownerId} disabled={busy} onChange={event => setBulkOwners(current => ({ ...current, [group.source]: event.target.value }))}><option value="">본사 구성원 선택</option>{workspace.profiles.filter(owner => owner.active && owner.approved && owner.role !== 'factory' && !owner.withdrawnAt).map(owner => <option key={owner.id} value={owner.id}>{owner.name} · {owner.email}</option>)}</select></label>)}</div>}
            {needsFactorySelection && <p className="import-validation-error" role="status">자동 연결되지 않은 생산처가 있습니다. 아래에서 해당 생산처의 공장을 한 번만 선택해 주세요.</p>}
            <div className="form-grid">{bulkGroups.map(group => <label className="field" key={group.source}><span className="field-label">{group.source || '생산처 미기재'} · {group.count}개 품번</span><select className="select" aria-label={`일괄 등록 공장 ${group.source}`} value={bulkFactories[group.source] ?? group.factoryId} disabled={busy} onChange={event => setBulkFactories(current => ({ ...current, [group.source]: event.target.value }))}><option value="">등록된 공장 선택</option>{workspace.factories.map(factory => <option key={factory.id} value={factory.id}>{factory.name}</option>)}</select></label>)}</div>
          </section></details>}
          {bulkPlan && !!bulkPlan.errors.length && <div className="import-validation-error" role="status"><AlertCircle size={14}/><div><strong>파일 또는 업로드 기본 설정을 확인해 주세요.</strong><ul>{bulkPlan.errors.slice(0, 8).map((item, index) => <li key={index}>{item}</li>)}</ul>{bulkPlan.errors.length > 8 && <p>외 {bulkPlan.errors.length - 8}건</p>}</div></div>}
          {ownerSetupRequired && <div className="import-validation-error" role="status">컬러별 담당자와 담당자 미지정 등록을 사용하려면 새 SQL 011 설정을 먼저 적용해 주세요.</div>}
          {bulkPlan && !!bulkPlan.entries.length && !productionOrdersAvailable && <div className="import-validation-error" role="status">프로젝트·생산 차수 설정이 필요합니다. 기존 SQL 007~009 적용을 완료한 뒤 업로드해 주세요.</div>}
          {bulkProgress && <p role="status">프로젝트·품번 자동 등록 {bulkProgress.done} / {bulkProgress.total} · 수량 적용 준비 중</p>}
          <div className="import-preview-summary"><span>분석 <b>{formatNumber(preview.sourceRows)}</b>행</span><span>매칭 <b>{formatNumber(preview.matchedLines)}</b>컬러</span><span>적용 <b>{formatNumber(preview.changedStyles)}</b>스타일 · 수량 <b>{formatNumber(preview.changedLines)}</b>컬러{preview.sourceChangedLines > 0 && <> · 원본 정보 <b>{formatNumber(preview.sourceChangedLines)}</b>컬러</>}</span><span className={visibleErrorCount ? 'has-error' : 'no-error'}>오류 <b>{visibleErrorCount}</b></span>{registrationPendingCount > 0 && <span>자동 등록 예정 <b>{registrationPendingCount}</b></span>}{warningCount > 0 && <span className="has-warning">확인사항 <b>{warningCount}</b></span>}</div>
          {preview.errors.map((item, i) => <p className="import-validation-error" key={i}><AlertCircle size={14}/>{item}</p>)}
          {skuRows.length > 0 && <details className="import-base-colors" open={skuDetailsOpen || needsSkuCorrection} onToggle={event => setSkuDetailsOpen(event.currentTarget.open)}><summary>품번 판독값 수정 (선택)</summary><h4>가져올 품번 확인</h4><p>품번을 그대로 확인합니다. F열이 기본 품번이면 B열 예산코드에서 프로젝트 코드와 정확히 일치하는 전체 품번을 자동으로 가져옵니다. I열은 읽지 않습니다.</p>{skuRows.slice(0, visibleRows).map(item => <label className="import-base-color-row import-sku-row" key={item.rowNumber}><span>{item.rowNumber}행</span><input className="input" aria-label={`원본 ${item.rowNumber}행 품번`} value={item.sku} maxLength={62} disabled={busy || applied} onChange={event => { setSigSkus(current => ({ ...current, [item.rowNumber]: event.target.value.toUpperCase() })); setError(''); setSuccess(''); setApplied(false) }}/><small>{item.fromBudget ? '예산코드에서 전체 품번 인식' : 'F열 품번'}</small></label>)}{skuRows.length > visibleRows && <button className="button button-ghost" onClick={() => setVisibleRows(value => value + 50)}>품번 행 더 보기</button>}</details>}
          {preview.rows.some(row => !row.lineId) && <p className="import-formula-note">새 품번도 파일 수량을 표시하며 오더 적용 시 프로젝트와 함께 자동 등록합니다.</p>}
          <div className="table-wrap import-preview-table"><table className="data-table"><thead><tr><th>원본 행</th><th>{'품번 / 제품명'}</th>{preset === 'sig-order-qty' && <><th>A · 프로젝트 코드</th><th>M · 프로젝트 명칭</th></>}{SIZES.map(size => <th key={size}>{size}</th>)}<th>총수량</th><th>검증 결과</th></tr></thead><tbody>{preview.rows.slice(0, visibleRows).map((row, i) => <tr key={row.lineId || `error-${i}`} className={row.errors.length && !isRegistrationPending(row) ? 'import-error-row' : row.changed ? 'import-changed-row' : ''}><td title={row.rowNumbers.join(', ')}>{row.rowNumbers.length > 3 ? `${row.rowNumbers[0]} 외 ${row.rowNumbers.length - 1}` : row.rowNumbers.join(', ')}</td><td><strong>{row.sku || '품번 없음'}</strong><small>{row.styleName || row.color || '미등록 품번·컬러'}</small></td>{preset === 'sig-order-qty' && <><td>{projectValue(row, 'A') || '—'}</td><td>{projectValue(row, 'M') || '—'}</td></>}{SIZES.map(size => <td key={size} className={row.before[size] !== row.after[size] ? 'changed-quantity' : ''}>{row.lineId ? <><span>{formatNumber(row.before[size])}</span><ArrowRight size={10}/><b>{formatNumber(row.after[size])}</b></> : <><span>파일 </span><b>{formatNumber(row.imported[size])}</b></>}</td>)}<td className="import-total-cell">{row.lineId ? <><span>{formatNumber(quantityTotal(row.before))}</span><ArrowRight size={10}/><b>{formatNumber(quantityTotal(row.after))}</b></> : <><span>파일 </span><b>{formatNumber(quantityTotal(row.imported))}</b></>}</td><td>{isRegistrationPending(row) ? <span className="import-row-warning">자동 등록 예정</span> : row.errors.length ? <details open={preview.rows.length <= 5}><summary className="import-row-error"><X size={12}/>오류 {row.errors.length}건</summary>{row.errors.map((item, n) => <p key={n}>{item}</p>)}</details> : <span className={row.changed || row.sourceChanged ? 'import-row-ok' : 'muted'}><CheckCircle2 size={12}/>{row.changed ? '수량 변경 예정' : row.sourceChanged ? '원본 정보 저장' : '변경 없음'}</span>}{row.warnings.length > 0 && <details><summary className="import-row-warning">확인 {row.warnings.length}건</summary>{row.warnings.map((item, n) => <p key={n}>{item}</p>)}</details>}</td></tr>)}</tbody></table></div>
          {preset === 'sig-order-qty' && !automatic && !!onRegisterStyle && <p className="import-validation-error">프로젝트·품번 자동 등록은 기존 005 설정 적용 후 사용할 수 있습니다.</p>}
          {preview.rows.length > visibleRows && <button className="button button-ghost import-more" onClick={() => setVisibleRows(v => v + 50)}>미리보기 더 보기 ({visibleRows} / {preview.rows.length})<ChevronDown size={13}/></button>}
          {stale && <div className="import-stale" role="alert"><AlertCircle size={16}/><span>미리보기 이후 원본 스타일이 변경되었습니다. 최신 오더와 버전을 다시 확인해 주세요.</span></div>}
          {preset === 'sig-order-qty' && preview.rows.some(row => row.sourceMetadata?.length) && <details className="import-source-metadata"><summary>원본 참조 열 확인 · A / F / L / M / S / V / W / X / Y / AQ~AV / AY<ChevronDown size={13}/></summary><p>추가 열 이름과 의미를 임의로 바꾸지 않습니다. 아래 16개 열의 제목·원본 값, 파일명·시트명·행 번호를 오더 수량과 함께 저장합니다. 수량이 같아도 원본 참조 정보가 달라지면 적용 대상에 포함됩니다.</p><div className="table-wrap"><table className="data-table"><thead><tr><th>원본 행</th>{SIG_ORDER_SOURCE_COLUMNS.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{preview.rows.flatMap(row => row.sourceMetadata || []).slice(0, 10).map(source => <tr key={source.rowNumber}><td>{source.rowNumber}</td>{SIG_ORDER_SOURCE_COLUMNS.map(column => <td key={column} title={cellLabel(source.columns[column])}>{cellLabel(source.columns[column])}</td>)}</tr>)}</tbody></table></div></details>}
          <div className="import-revalidate"><span>파일 분석 시점의 버전을 보관합니다. 다른 사용자가 먼저 저장하면 전체 적용이 취소됩니다.</span><button className="button button-ghost" onClick={() => { setSnapshot(structuredClone(workspace)); changed() }} disabled={busy}><RefreshCw size={13}/>최신 데이터로 다시 검증</button></div>
          <label className="field import-reason"><span className="field-label">변경 사유</span><textarea className="textarea" aria-label="오더 변경 사유" placeholder="예: 확정 오더 반영 / 추가 오더 수량 반영" value={reason} maxLength={1000} onChange={e => setReason(e.target.value)} disabled={busy || applied}/></label>
          {success && <div className="success-message" role="status"><CheckCircle2 size={15}/>{success}</div>}
          <div className="import-apply-footer"><p>SIG 파일의 A열 프로젝트·F열 품번을 자동 등록하고 오더 수량을 함께 적용합니다.<br/>기존 출고·입고·체크리스트와 변경 이력은 보존합니다.</p><button className="button button-primary" onClick={() => void apply()} disabled={!allowed || !available || ownerSetupRequired || busy || loading || !!errorCount || !!bulkPlan?.errors.length || (!!bulkPlan?.entries.length && !productionOrdersAvailable) || stale || !preview.changes.length || reason.trim().length < 2 || applied}>{busy ? '전체 오더 적용 중…' : applied ? '적용 완료' : '검증된 오더 적용'}<ArrowRight size={15}/></button></div>
        </section>}
      </>}
      <footer className="order-import-close"><span>FIVE SPACE / SIG · ORDER IMPORT</span><button className="button button-ghost" disabled={busy} onClick={onClose}>닫기</button></footer>
    </div>
  </Modal>
}
