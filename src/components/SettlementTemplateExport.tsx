import { useMemo, useState, type ChangeEvent } from 'react'
import { Download, FileSpreadsheet, Upload } from 'lucide-react'
import type { Profile, Style, Workspace } from '../lib/types'
import { message } from '../lib/utils'
import { MAX_SETTLEMENT_TEMPLATE_BYTES, SETTLEMENT_FIELDS, autoMapSettlementColumns, buildSettlementRows, fillSettlementTemplate, inspectSettlementSheet, loadSettlementTemplate, preflightSettlementTemplate, type SettlementFieldKey, type SettlementTemplate, type SettlementTemplateOptions } from '../lib/settlement-template'
import { Modal } from './ui'
import './settlement-template.css'

export default function SettlementTemplateExport({ workspace, profile, styles, onClose }: { workspace: Workspace; profile: Profile; styles: Style[]; onClose: () => void }) {
  const rows = useMemo(() => buildSettlementRows(workspace, styles, profile), [workspace, styles, profile])
  const [template, setTemplate] = useState<SettlementTemplate>()
  const [sheetName, setSheetName] = useState(''), [headerRow, setHeaderRow] = useState(1)
  const [startRow, setStartRow] = useState(2), [endRow, setEndRow] = useState(2)
  const [mapping, setMapping] = useState<Record<number, SettlementFieldKey>>({})
  const [overwriteExisting, setOverwriteExisting] = useState(false), [areaConfirmed, setAreaConfirmed] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState('')
  const columns = useMemo(() => template ? inspectSettlementSheet(template, sheetName, headerRow) : [], [template, sheetName, headerRow])
  const options: SettlementTemplateOptions = { sheetName, headerRow, startRow, endRow, mapping, overwriteExisting }
  const problems = template ? preflightSettlementTemplate(template, options, rows.length) : []
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
    if (!template || !areaConfirmed || problems.length || busy) return
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

  return <Modal title="마감 양식에 채워서 다운로드" onClose={onClose} wide><div className="modal-body settlement-template">
    <p className="settlement-template-intro">실제 을지 마감 양식은 아직 제공되지 않았습니다. 사용하시는 <strong>.xlsx 원본 양식</strong>을 올리고, 각 열에 넣을 항목을 연결해 주세요. 임의 양식을 을지 양식으로 제공하지 않습니다.</p>
    <div className="settlement-template-summary"><FileSpreadsheet size={18}/><span>현재 검색·필터 결과 <strong>{rows.length}개 컬러 행</strong><small>오더·출고·입고 수량과 정산 금액을 스타일+컬러 단위로 입력합니다.</small></span></div>
    <label className="settlement-template-upload"><Upload size={17}/><span>{busy ? '파일 처리 중…' : '마감 양식 파일 선택'}<small>.xlsx · 최대 10MB · 이 브라우저에서 처리</small></span><input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="마감 양식 파일" onChange={readFile} disabled={busy}/></label>
    {error && <div className="error-message" role="alert">{error}</div>}
    {success && <div className="settlement-template-success" role="status">{success}</div>}
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
  </div></Modal>
}
