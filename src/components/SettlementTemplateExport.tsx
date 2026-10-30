import { useMemo, useState, type ChangeEvent } from 'react'
import { Download, FileSpreadsheet, Upload } from 'lucide-react'
import type { Profile, Style, Workspace } from '../lib/types'
import { message } from '../lib/utils'
import { getProjectIdentity, projectFilterOptions, compareProjectIds } from '../lib/project-identity'
import { settlementProjectOptions, settlementSkuOptions, selectSettlementStyles, sortEuljiRowsByProject, type EuljiProjectSort } from '../lib/settlement-export-scope'
import { MAX_SETTLEMENT_TEMPLATE_BYTES, SETTLEMENT_FIELDS, autoMapSettlementColumns, buildSettlementRows, fillSettlementTemplate, inspectSettlementSheet, loadSettlementTemplate, preflightSettlementTemplate, type SettlementFieldKey, type SettlementTemplate, type SettlementTemplateOptions } from '../lib/settlement-template'
import { buildSigEuljiRows, fillSigEuljiTemplate, loadBundledSigEuljiTemplate, type SigEuljiRow, type SigEuljiKind } from '../lib/sig-eulji'
import { buildFrozenProductionEuljiRows, type ProductionExportScope } from '../lib/production-ledger-export'
import { Modal } from './ui'
import './settlement-template.css'

export default function SettlementTemplateExport({ workspace, profile, styles, productionScope, initialProjectIds, initialSkuKeys, onClose }: { workspace: Workspace; profile: Profile; styles: Style[]; productionScope?: ProductionExportScope; initialProjectIds?: readonly string[] | null; initialSkuKeys?: readonly string[] | null; onClose: () => void }) {
  // The screen's scope initializes the dialog, which can then be adjusted
  // without changing the parent filters or the underlying business records.
  const projectOptions = useMemo(() => settlementProjectOptions(workspace, styles), [workspace, styles])
  const projectLabels = useMemo(() => projectFilterOptions(workspace, projectOptions), [workspace, projectOptions])
  const allSkuOptions = useMemo(() => settlementSkuOptions(workspace, styles, null), [workspace, styles])
  const [checkedProjectIds, setCheckedProjectIds] = useState<string[]>(() => {
    const initial = initialProjectIds === undefined ? productionScope?.projectIds : initialProjectIds
    return projectOptions.filter(item => initial == null || initial.includes(item.id)).map(item => item.id)
  })
  const [checkedSkuKeys, setCheckedSkuKeys] = useState<string[]>(() => allSkuOptions.filter(item => initialSkuKeys == null || initialSkuKeys.includes(item.key)).map(item => item.key))
  const [projectSearch, setProjectSearch] = useState(''), [skuSearch, setSkuSearch] = useState('')
  const [projectSort, setProjectSort] = useState<EuljiProjectSort>('name')
  const [sigKind, setSigKind] = useState<SigEuljiKind>('product')
  const [mode, setMode] = useState<'sig' | 'generic'>(profile.role === 'factory' ? 'generic' : 'sig')
  const skuOptions = useMemo(() => settlementSkuOptions(workspace, styles, checkedProjectIds, mode === 'sig' && sigKind === 'product'), [workspace, styles, checkedProjectIds, mode, sigKind])
  const checkedVisibleSkus = skuOptions.filter(item => checkedSkuKeys.includes(item.key))
  const chosenStyles = useMemo(() => selectSettlementStyles(workspace, styles, checkedProjectIds, checkedSkuKeys), [workspace, styles, checkedProjectIds, checkedSkuKeys])
  const currentStyles = useMemo(() => selectSettlementStyles(workspace, styles, checkedProjectIds, checkedSkuKeys, false).sort((left, right) => projectSort === 'name' ? compareProjectIds(workspace, left.projectId, right.projectId) : getProjectIdentity(workspace, left.projectId).code.localeCompare(getProjectIdentity(workspace, right.projectId).code, 'ko-KR') || compareProjectIds(workspace, left.projectId, right.projectId)), [workspace, styles, checkedProjectIds, checkedSkuKeys, projectSort])
  const chosenScope: ProductionExportScope = useMemo(() => ({
    ...productionScope, projectIds: checkedProjectIds,
  }), [productionScope, checkedProjectIds])
  const productionProjectIds = checkedProjectIds
  const rows = useMemo(() => buildSettlementRows(workspace, currentStyles, profile), [workspace, currentStyles, profile])
  const sigKinds: { value: SigEuljiKind; label: string }[] = [{ value: 'product', label: '메인 제품' }, { value: 'label', label: '중화라벨' }, { value: 'embroidery', label: '비와이 자수' }, { value: 'quality', label: '품질검사' }]
  const sigKindLabel = sigKinds.find(item => item.value === sigKind)!.label
  const managed = chosenStyles.some(style => style.production.some(line => workspace.productionRuns?.some(run => run.styleId === style.id && run.lineId === line.id)))
  const sig = useMemo(() => {
    const result = sigKind === 'product' ? buildFrozenProductionEuljiRows(workspace, chosenStyles, profile, chosenScope) : buildSigEuljiRows(workspace, currentStyles, profile, sigKind)
    return { ...result, rows: sortEuljiRowsByProject(result.rows, projectSort) }
  }, [workspace, chosenStyles, currentStyles, profile, sigKind, chosenScope, projectSort])
  const sigReady = profile.role !== 'factory' && (sigKind === 'product' ? workspace.settlementTermsAvailable === true || managed && workspace.productionLedgerAvailable === true : sigKind === 'quality' ? workspace.refinementsAvailable === true : workspace.operationsAvailable === true)
  const [template, setTemplate] = useState<SettlementTemplate>()
  const [sheetName, setSheetName] = useState(''), [headerRow, setHeaderRow] = useState(1)
  const [startRow, setStartRow] = useState(2), [endRow, setEndRow] = useState(2)
  const [mapping, setMapping] = useState<Record<number, SettlementFieldKey>>({})
  const [overwriteExisting, setOverwriteExisting] = useState(false), [areaConfirmed, setAreaConfirmed] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState('')
  const columns = useMemo(() => template ? inspectSettlementSheet(template, sheetName, headerRow) : [], [template, sheetName, headerRow])
  const options: SettlementTemplateOptions = { sheetName, headerRow, startRow, endRow, mapping, overwriteExisting }
  const problems = [...(template ? preflightSettlementTemplate(template, options, rows.length) : []), ...(managed ? ['생산 차수가 있는 품번은 현재 합계로 마감하지 않습니다. SIG 을지 자동 작성 또는 생산 차수·마감에서 확정한 금액을 다운로드해 주세요.'] : [])]
  const connected = columns.filter(column => mapping[column.column])

  function initializeSheet(next: SettlementTemplate, name: string) {
    const header = next.sheets.find(sheet => sheet.name === name)?.suggestedHeaderRow || 1
    setSheetName(name); setHeaderRow(header); setStartRow(header + 1); setEndRow(header + Math.max(1, rows.length))
    setMapping(autoMapSettlementColumns(inspectSettlementSheet(next, name, header)))
    setAreaConfirmed(false); setOverwriteExisting(false); setError(''); setSuccess('')
  }
  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setMode('generic')
    setBusy(true); setError(''); setSuccess(''); setTemplate(undefined)
    try {
      if (file.size > MAX_SETTLEMENT_TEMPLATE_BYTES) throw new Error('양식 파일은 10MB 이하여야 합니다.')
      const next = await loadSettlementTemplate(await file.arrayBuffer(), file.name)
      setTemplate(next); initializeSheet(next, next.sheets[0].name)
    } catch (failure) { setError(message(failure)) } finally { setBusy(false) }
  }
  function changeHeader(value: number) {
    setHeaderRow(value); setAreaConfirmed(false); setSuccess('')
    if (template) setMapping(autoMapSettlementColumns(inspectSettlementSheet(template, sheetName, value)))
  }
  async function download() {
    if (!template || !areaConfirmed || problems.length || busy || managed) return
    setBusy(true); setError(''); setSuccess('')
    try {
      const bytes = await fillSettlementTemplate(template, options, rows)
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = `${template.filename.replace(/\.xlsx$/i, '')}_SIG마감.xlsx`
      document.body.append(anchor); anchor.click(); anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setSuccess(`${rows.length}행을 채운 파일을 다운로드했습니다. Excel에서 합계와 인쇄 미리보기를 확인해 주세요.`)
    } catch (failure) { setError(message(failure)) } finally { setBusy(false) }
  }

  async function downloadSig() {
    if (busy || !sigReady || !checkedProjectIds.length || !checkedSkuKeys.length || sig.errors.length || !sig.rows.length) return
    setBusy(true); setError(''); setSuccess('')
    try {
      const bytes = await fillSigEuljiTemplate(await loadBundledSigEuljiTemplate(), sig.rows)
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      const anchor = document.createElement('a')
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).replaceAll('-', '')
      anchor.href = url; anchor.download = `SIG_을지_${sigKind === 'product' ? '' : `${sigKindLabel}_`}${today}.xlsx`; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      setSuccess(`${sigKindLabel} ${sig.rows.length}행을 다운로드했습니다.${sigKind === 'product' ? ' T는 부가세 제외 금액이며 U·V는 원본 수식을 유지합니다.' : ' 저장된 가공·검사 단가와 메인 생산의 컬러별 수량을 반영했습니다.'}`)
    } catch (failure) { setError(message(failure)) } finally { setBusy(false) }
  }
  const sigColumns: { letter: string; label: string; value: (row: SigEuljiRow) => string | number | null | undefined }[] = [
    { letter: '안내', label: '프로젝트 명칭', value: row => row.projectName || row.projectCode }, { letter: 'A', label: '프로젝트 코드', value: row => row.projectCode }, { letter: 'C', label: '입고일자', value: row => row.receivedAtISO }, { letter: 'D', label: '업체명', value: row => row.factory }, { letter: 'I', label: '컬러 포함 품번', value: row => row.colorStyleCode },
    { letter: 'L', label: '품명·작업 종류', value: row => row.itemName || '' }, { letter: 'N', label: sigKind === 'product' ? '장당 원가' : '저장된 단가', value: row => row.unitCost }, { letter: 'O', label: '장수', value: () => 1 }, { letter: 'P', label: 'PO 오더 수량', value: row => row.orderQuantity }, { letter: 'Q', label: 'P와 동일', value: row => row.orderQuantity }, { letter: 'R', label: sigKind === 'label' ? '실 출고 수량' : '실 입고 수량', value: row => row.receivedQuantity },
    { letter: 'S', label: '단위', value: row => row.unit }, { letter: 'T', label: '금액 · 부가세 제외', value: row => row.netAmount }, { letter: 'U', label: '부가세', value: row => row.netAmount === null ? null : row.netAmount / 10 }, { letter: 'V', label: '합계', value: row => row.netAmount === null ? null : row.netAmount + row.netAmount / 10 }, { letter: 'W', label: '담당자', value: row => row.owner }, { letter: 'X', label: '산출근거·비고', value: row => row.note || '' },
  ]
  return <Modal title="마감 양식에 채워서 다운로드" onClose={onClose} wide><div className="modal-body settlement-template">
    <div className="settlement-export-modes" role="tablist" aria-label="마감 다운로드 방식"><button type="button" role="tab" aria-selected={mode === 'sig'} disabled={busy || profile.role === 'factory'} onClick={() => { setMode('sig'); setError(''); setSuccess('') }}>SIG 을지 자동 작성</button><button type="button" role="tab" aria-selected={mode === 'generic'} disabled={busy} onClick={() => { setMode('generic'); setError(''); setSuccess('') }}>다른 양식 · 직접 열 연결</button></div>
    {error && <div className="error-message" role="alert">{error}</div>}
    {success && <div className="settlement-template-success" role="status">{success}</div>}
    <section className="panel settlement-scope" aria-label="을지 다운로드 선택 범위">
      <strong>다운로드할 프로젝트 명칭 · 스타일코드 선택</strong>
      <p className="muted">화면에서 선택한 범위를 기본으로 표시합니다. 이 창에서 프로젝트와 품번을 다시 선택할 수 있으며, 두 조건에 모두 해당하는 내역만 다운로드합니다.</p>
      <div className="settlement-scope-grid">
        <div className="settlement-scope-column">
          <div className="settlement-scope-heading"><strong>프로젝트 명칭 ({checkedProjectIds.length}/{projectOptions.length})</strong><div><button className="button button-ghost" type="button" aria-label="을지 프로젝트 전체 선택" disabled={busy} onClick={() => setCheckedProjectIds(projectOptions.map(project => project.id))}>전체 선택</button><button className="button button-ghost" type="button" aria-label="을지 프로젝트 전체 해제" disabled={busy} onClick={() => setCheckedProjectIds([])}>전체 해제</button></div></div>
          <input className="input" type="search" aria-label="을지 프로젝트 명칭 검색" value={projectSearch} placeholder="프로젝트 명칭·코드 검색" onChange={event => setProjectSearch(event.target.value)} disabled={busy}/>
          <div className="settlement-scope-options">
            {projectLabels.filter(item => projectSearch.trim().toLocaleLowerCase().split(/\s+/).every(word => item.label.toLocaleLowerCase().includes(word))).map(item => <label key={item.value} title={item.label}><input type="checkbox" aria-label={`을지 프로젝트 ${item.value}`} disabled={busy} checked={checkedProjectIds.includes(item.value)} onChange={event => setCheckedProjectIds(current => event.target.checked ? [...current, item.value] : current.filter(id => id !== item.value))}/><span>{item.label}</span></label>)}
          </div>
          <p className="settlement-scope-selection" aria-label="선택한 을지 프로젝트 명칭">{checkedProjectIds.length ? projectLabels.filter(item => checkedProjectIds.includes(item.value)).map(item => item.label).join(', ') : '선택한 프로젝트 없음'}</p>
        </div>
        <div className="settlement-scope-column">
          <div className="settlement-scope-heading"><strong>스타일코드 ({checkedVisibleSkus.length}/{skuOptions.length})</strong><div><button className="button button-ghost" type="button" aria-label="을지 스타일 전체 선택" disabled={busy} onClick={() => setCheckedSkuKeys(current => [...new Set([...current, ...skuOptions.map(item => item.key)])])}>전체 선택</button><button className="button button-ghost" type="button" aria-label="을지 스타일 전체 해제" disabled={busy} onClick={() => setCheckedSkuKeys([])}>전체 해제</button></div></div>
          <input className="input" type="search" aria-label="을지 스타일코드 검색" value={skuSearch} placeholder="전체 품번·컬러 검색" onChange={event => setSkuSearch(event.target.value)} disabled={busy}/>
          <div className="settlement-scope-options">
            {skuOptions.filter(item => item.label.toLocaleLowerCase().includes(skuSearch.trim().toLocaleLowerCase())).map(item => <label key={item.key}><input type="checkbox" aria-label={`을지 스타일 ${item.key}`} disabled={busy} checked={checkedSkuKeys.includes(item.key)} onChange={event => setCheckedSkuKeys(current => event.target.checked ? [...current, item.key] : current.filter(key => key !== item.key))}/><span>{item.label}</span></label>)}
            {!skuOptions.length && <p>선택한 프로젝트에 해당하는 스타일이 없습니다.</p>}
          </div>
          <p className="muted">프로젝트를 바꾸면 해당 프로젝트의 품번만 표시합니다. 새 프로젝트의 품번도 출력하려면 해당 품번 또는 전체 선택을 눌러 주세요.</p>
        </div>
      </div>
      <label className="settlement-project-sort"><span>프로젝트별 구분·정렬</span><select className="select" aria-label="을지 프로젝트 정렬" value={projectSort} disabled={busy} onChange={event => setProjectSort(event.target.value as EuljiProjectSort)}><option value="name">프로젝트 명칭순</option><option value="code">프로젝트 코드순</option></select></label>
      <p className="settlement-template-help">SIG 고정 양식의 셀과 계산식은 유지하며, 프로젝트 명칭·코드·시즌은 별도 ‘프로젝트 안내’ 시트에서 행별로 확인할 수 있습니다.</p>
      {(!checkedProjectIds.length || !checkedVisibleSkus.length) && <p className="error-message" role="status">다운로드할 프로젝트와 스타일코드를 각각 하나 이상 선택해 주세요.</p>}
    </section>
    <div hidden={mode !== 'sig'} className="sig-eulji-export" role="tabpanel" aria-label="SIG 을지 자동 작성">
      <p className="settlement-template-intro">제공한 <strong>SIG_을지.xlsx · 대금지급(을)</strong> 양식에 지정한 열을 자동으로 채웁니다. 매번 양식을 업로드하거나 열을 연결할 필요가 없습니다.</p>
      <div className="settlement-export-modes" role="tablist" aria-label="을지 작성 항목">{sigKinds.map(item => <button key={item.value} type="button" role="tab" aria-selected={sigKind === item.value} disabled={busy} onClick={() => { setSigKind(item.value); setError(''); setSuccess('') }}>{item.label}</button>)}</div>
      {sigKind === 'product' && managed && <p className="settlement-template-help">차수 프로젝트 범위: {productionProjectIds === null ? '전체 프로젝트' : productionProjectIds.length ? productionProjectIds.map(id => getProjectIdentity(workspace, id).label).join(', ') : '선택 없음'}. 아래 미리보기의 프로젝트 코드와 금액을 확인해 주세요.</p>}
      <div className="settlement-template-summary"><FileSpreadsheet size={18}/><span>선택한 프로젝트·스타일 결과 <strong>{sig.rows.length}개 을지 행</strong><small>{sigKind === 'product' ? '생산 차수가 있으면 확정한 차수별 금액을, 기존 품번은 컬러별 입고 수량을 사용합니다.' : `${sigKindLabel}에 저장된 작업 내역 ${sig.rows.length}행을 작성합니다.`}</small></span></div>
      {sigKind === 'product' ? <div className="sig-eulji-rule"><strong>T = N(장당 원가) × R(실제 입고 수량)</strong><span>부가세 제외 금액입니다. O는 1, Q는 P와 같으며, S는 원단 YDS · 제품/라벨 EA로 작성합니다. U 부가세와 V 합계는 원본 수식을 유지합니다.</span></div> : <div className="sig-eulji-rule"><strong>{sigKind === 'label' ? '업체명: 주식회사 중화라벨' : sigKind === 'embroidery' ? '업체명: BY컴퓨터자수' : '품질검사 업체명은 빈칸으로 다운로드합니다.'}</strong><span>컬러별 입고일·전체 품번·저장한 단가를 채웁니다. R열은 {sigKind === 'label' ? '메인 생산의 실 출고 수량' : '메인 생산의 실 입고 수량'}이며, 단가와 곱해 금액·부가세·합계를 계산합니다. {sigKind === 'quality' ? '업체명은 담당자가 직접 작성해 주세요.' : '작업별로 선택한 컬러의 수량을 사용하고 공통 작업 요청 수량·로스는 비고에 보존합니다.'}</span></div>}
      {sigKind === 'product' && !sigReady && <div className="error-message" role="alert">추가 단가 데이터베이스 설정이 필요합니다. 관리자가 004_settlement_terms.sql을 적용한 뒤 다시 열어 주세요.</div>}
      {!!sig.errors.length && <div className="settlement-template-problems" role="alert"><strong>다운로드 전에 아래 정보를 확인해 주세요.</strong><p>{sigKind === 'product' ? '생산 차수가 있으면 스타일 상세 → 생산 차수·마감에서 단가·실제 입고를 저장하고 마감을 확정하세요. 기존 품번은 을지·단가와 메인 생산 입력값을 사용합니다.' : '스타일 상세 → 가공·품질 관리에서 해당 작업을 등록·저장한 뒤 다시 내려받아 주세요.'}</p><ul>{sig.errors.slice(0, 30).map((problem, index) => <li key={index}>{problem}</li>)}</ul>{sig.errors.length > 30 && <p>외 {sig.errors.length - 30}건 · 필터로 대상 범위를 좁혀 확인할 수 있습니다.</p>}</div>}
      {!!sig.rows.length && <section className="settlement-template-preview"><h3>을지 입력 미리보기 <small>처음 {Math.min(5, sig.rows.length)}행 / 준비된 {sig.rows.length}행</small></h3><div><table><thead><tr><th>Excel 행</th>{sigColumns.map(column => <th key={column.letter}>{column.letter} · {column.label}</th>)}</tr></thead><tbody>{sig.rows.slice(0, 5).map((row, index) => <tr key={index}><td>{index + 3}</td>{sigColumns.map(column => { const value = column.value(row); return <td key={column.letter}>{value === null || value === undefined || value === '' ? '—' : typeof value === 'number' ? value.toLocaleString('ko-KR', { maximumFractionDigits: 3 }) : value}</td> })}</tr>)}</tbody></table></div></section>}
      <p className="settlement-template-help">{sigKind === 'product' ? '현재 필터에 미확정 생산 차수가 있으면 전체 다운로드를 막습니다. 특정 확정 차수는 생산 차수·마감에서 별도로 다운로드하세요. 과거 차수에는 이후 변경한 단가를 적용하지 않습니다.' : '가공·품질 관리에서 저장한 작업·컬러별 단가는 직접 수정할 때까지 계속 적용됩니다. 저장하지 않은 단가와 미기재 입고일은 공란으로 남습니다. 가공·검사 단가는 메인 제품 원가와 별도로 관리합니다.'}</p>
      <div className="modal-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>닫기</button><button type="button" className="button button-primary" onClick={() => void downloadSig()} disabled={busy || !sigReady || !!sig.errors.length || !sig.rows.length}><Download size={15}/>{busy ? '처리 중…' : '을지 다운로드'}</button></div>
    </div>
    <div hidden={mode !== 'generic'} role="tabpanel" aria-label="다른 마감 양식 연결">{managed && <div className="error-message" role="alert">생산 차수가 있는 품번은 SIG 을지 자동 작성에서 확정 금액으로 다운로드해 주세요.</div>}
    <p className="settlement-template-intro">다른 <strong>.xlsx 마감 원본 양식</strong>을 사용할 때 각 열에 넣을 항목을 직접 연결하세요. 기본 SIG 을지는 위 자동 작성에서 다운로드할 수 있습니다.</p>
    <div className="settlement-template-summary"><FileSpreadsheet size={18}/><span>선택한 프로젝트·스타일 결과 <strong>{rows.length}개 컬러 행</strong><small>오더·출고·입고 수량과 정산 금액을 스타일+컬러 단위로 입력합니다.</small></span></div>
    <label className="settlement-template-upload"><Upload size={17}/><span>{busy ? '파일 처리 중…' : '마감 양식 파일 선택'}<small>.xlsx · 최대 10MB · 이 브라우저에서 처리</small></span><input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="마감 양식 파일" onChange={readFile} disabled={busy}/></label>
    {template && <>
      <p className="settlement-template-filename">선택한 양식: <strong>{template.filename}</strong></p>
      <div className="settlement-template-config">
        <label className="field"><span>시트</span><select className="select" value={sheetName} onChange={event => initializeSheet(template, event.target.value)} disabled={busy}>{template.sheets.map(sheet => <option key={sheet.name}>{sheet.name}</option>)}</select></label>
        <label className="field"><span>머리글 행</span><input className="input" type="number" min="1" max="1048575" value={headerRow || ''} onChange={event => changeHeader(event.target.valueAsNumber)} disabled={busy}/></label>
        <label className="field"><span>데이터 시작 행</span><input className="input" type="number" min="1" max="1048576" value={startRow || ''} onChange={event => { setStartRow(event.target.valueAsNumber); setAreaConfirmed(false); setSuccess('') }} disabled={busy}/></label>
        <label className="field"><span>데이터 마지막 행</span><input className="input" type="number" min="1" max="1048576" value={endRow || ''} onChange={event => { setEndRow(event.target.valueAsNumber); setAreaConfirmed(false); setSuccess('') }} disabled={busy}/></label>
      </div>
      <p className="settlement-template-help">마지막 행은 합계·서명란 바로 위까지 지정하세요. 행을 추가하지 않으며, 지정 범위 안에서 연결한 열만 채웁니다. 헤더 이름으로 자동 연결한 항목도 직접 확인해 주세요. 단가·부가세 등 원본 데이터에 없는 항목은 연결하지 않고 양식에서 작성하세요.</p>
      <div className="settlement-template-mappings"><table><thead><tr><th>양식 열</th><th>양식 머리글</th><th>SIG에서 가져올 항목</th></tr></thead><tbody>{columns.map(column => <tr key={column.column}><td>{column.letter}</td><td>{column.header || <span className="muted">빈 머리글</span>}</td><td><select className="select" aria-label={`${column.letter}열 연결`} value={mapping[column.column] || ''} disabled={busy} onChange={event => { const next = { ...mapping }; if (event.target.value) next[column.column] = event.target.value as SettlementFieldKey; else delete next[column.column]; setMapping(next); setAreaConfirmed(false); setSuccess('') }}><option value="">연결 안 함 · 원본 유지</option>{SETTLEMENT_FIELDS.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}</select></td></tr>)}</tbody></table></div>
      <div className="settlement-template-confirmations">
        <label><input type="checkbox" checked={overwriteExisting} onChange={event => { setOverwriteExisting(event.target.checked); setAreaConfirmed(false); setSuccess('') }} disabled={busy}/>연결한 열의 기존 값을 교체하고 남는 행의 값을 비웁니다.</label>
        <label><input type="checkbox" checked={areaConfirmed} onChange={event => setAreaConfirmed(event.target.checked)} disabled={busy}/>지정한 범위가 합계·서명란을 제외한 데이터 영역임을 확인했습니다.</label>
      </div>
      {!!problems.length && <div className="settlement-template-problems" role="alert"><strong>아래 항목을 확인해 주세요</strong><ul>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul></div>}
      {!!connected.length && !!rows.length && <section className="settlement-template-preview"><h3>입력 미리보기 <small>처음 {Math.min(5, rows.length)}행 / 총 {rows.length}행</small></h3><div><table><thead><tr><th>Excel 행</th>{connected.map(column => <th key={column.column}>{column.letter} · {column.header || SETTLEMENT_FIELDS.find(field => field.key === mapping[column.column])?.label}</th>)}</tr></thead><tbody>{rows.slice(0, 5).map((row, index) => <tr key={index}><td>{Number.isFinite(startRow) ? startRow + index : '—'}</td>{connected.map(column => <td key={column.column}>{row[mapping[column.column]] === '' ? '—' : row[mapping[column.column]]}</td>)}</tr>)}</tbody></table></div></section>}
      <p className="settlement-template-help">원본의 다른 시트·머리글·인쇄 설정과 ExcelJS가 지원하는 서식을 유지합니다. 데이터 영역의 병합 셀·연결된 열의 수식은 덮어쓰지 않고 중단합니다. 수식은 Excel에서 다시 계산되며, 특수 개체·외부 연결·고급 서식은 완전히 보존되지 않을 수 있습니다. 다운로드 후 원본과 비교해 주세요.</p>
    </>}
    <div className="modal-footer"><button type="button" className="button" onClick={onClose}>닫기</button><button type="button" className="button button-primary" onClick={download} disabled={!template || busy || !areaConfirmed || !!problems.length}><Download size={15}/>{busy ? '처리 중…' : '양식 채워서 다운로드'}</button></div>
    </div>
  </div></Modal>
}
