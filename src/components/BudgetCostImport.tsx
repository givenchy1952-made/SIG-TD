import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, FileSpreadsheet, LoaderCircle, Upload } from 'lucide-react'
import type { Profile, Workspace } from '../lib/types'
import type { BudgetCostImportPreview, BudgetCostImportRequest, BudgetCostImportResult, BudgetCostImportWorkbook } from '../lib/budget-cost-import-types'
import { budgetCostMatchKey, buildBudgetCostImportPreview, parseBudgetCostWorkbook } from '../lib/budget-cost-import'
import { importBudgetCosts } from '../lib/budget-cost-import-repository'
import { message } from '../lib/utils'
import { multiplyBudgetCost } from '../lib/budget-money'
import { Modal } from './ui'
import './budget-cost-import.css'

interface Props {
  workspace: Workspace; profile: Profile; onChanged: () => Promise<unknown>;
  onImported?: (result: BudgetCostImportResult) => void; onClose: () => void;
}
const number = (value: number | null | undefined) => value === null || value === undefined ? '미등록' : value.toLocaleString('ko-KR', { maximumFractionDigits: 6 })
function calculatedAmount(values: { unitCost: number | null; consumption: number | null } | null): number | null {
  if (values?.unitCost === null || values?.unitCost === undefined || values?.consumption === null || values?.consumption === undefined) return null
  try { return multiplyBudgetCost(values.unitCost, values.consumption) } catch { return null }
}
const actionLabel = { insert: '신규', update: '수정', skip: '중복 제외', error: '확인 필요' }

export default function BudgetCostImport({ workspace, profile, onChanged, onImported, onClose }: Props) {
  const [book, setBook] = useState<BudgetCostImportWorkbook | null>(null), [sheets, setSheets] = useState<string[]>([])
  const [projectIds, setProjectIds] = useState<Record<string, string>>({}), [preview, setPreview] = useState<BudgetCostImportPreview | null>(null)
  const [importId, setImportId] = useState(() => crypto.randomUUID()), [reason, setReason] = useState('')
  const [reading, setReading] = useState(false), [validating, setValidating] = useState(false), [saving, setSaving] = useState(false)
  const [error, setError] = useState(''), [result, setResult] = useState<BudgetCostImportResult | null>(null)
  const readGeneration = useRef(0), sent = useRef<{ request: BudgetCostImportRequest; reason: string } | null>(null)
  const actor = workspace.profiles.find(person => person.id === profile.id)
  const allowed = !!actor?.approved && actor.active && ['admin', 'internal'].includes(actor.role)
  const available = workspace.budgetAvailable === true && workspace.budgetCostImportAvailable === true
  const busy = reading || validating || saving
  const hasErrors = !!preview && (preview.errors.length > 0 || preview.rows.some(row => row.errors.length > 0 || row.action === 'error'))
  const changed = (preview?.inserted || 0) + (preview?.updated || 0)
  const pending = !!book && !result && (changed > 0 || !!reason.trim() || !preview || hasErrors)

  useEffect(() => {
    if (!book) { setPreview(null); return }
    let active = true
    setValidating(true)
    void buildBudgetCostImportPreview(workspace, book, { sheetNames: sheets, projectIds }).then(next => {
      if (active) setPreview(next)
    }).catch(failure => { if (active) { setPreview(null); setError(message(failure)) } }).finally(() => { if (active) setValidating(false) })
    return () => { active = false }
  }, [workspace, book, sheets, projectIds])
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (pending || saving) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [pending, saving])
  function close() {
    if (saving || reading || validating) return
    if (pending && !window.confirm('적용 전 원가 미리보기를 닫을까요? 입력한 변경 사유는 저장되지 않습니다.')) return
    onClose()
  }
  async function read(file: File | undefined) {
    if (!file || saving || reading) return
    if (pending && !window.confirm('현재 원가 미리보기를 새 파일로 바꿀까요?')) return
    const generation = ++readGeneration.current
    setReading(true); sent.current = null; setError(''); setResult(null); setPreview(null); setReason('')
    try {
      const next = await parseBudgetCostWorkbook(file)
      if (generation !== readGeneration.current) return
      setBook(next); setSheets(next.sheets.filter(sheet => sheet.supported).map(sheet => sheet.name)); setProjectIds({}); setImportId(crypto.randomUUID())
    } catch (failure) { if (generation === readGeneration.current) { setBook(null); setSheets([]); setError(message(failure)) } }
    finally { if (generation === readGeneration.current) setReading(false) }
  }
  function selectSheet(name: string, checked: boolean) {
    setSheets(current => checked ? [...current, name] : current.filter(value => value !== name))
    sent.current = null; setResult(null); setError(''); setImportId(crypto.randomUUID())
  }
  function selectProject(key: string, projectId: string) {
    sent.current = null; setProjectIds(current => ({ ...current, [key]: projectId })); setResult(null); setError(''); setImportId(crypto.randomUUID())
  }
  async function apply() {
    if (!preview || !allowed || !available || busy || result || !sent.current && (hasErrors || !changed || reason.trim().length < 2)) return
    setSaving(true); setError('')
    try {
      if (!sent.current) sent.current = { request: { importId, fileName: preview.fileName, contentHash: preview.contentHash, rows: preview.rows.flatMap(row => row.write ? [row.write] : []) }, reason }
      const saved = await importBudgetCosts(sent.current.request, sent.current.reason, profile)
      setResult(saved)
      try { await onChanged(); onImported?.(saved) }
      catch { setError('원가는 저장됐지만 최신 목록을 불러오지 못했습니다. 창을 닫고 새로고침해 확인해 주세요.') }
    } catch (failure) { setError(message(failure)) }
    finally { setSaving(false) }
  }
  async function reviewAgain() {
    if (busy || result) return
    setValidating(true); setError('')
    try {
      await onChanged()
      sent.current = null; setImportId(crypto.randomUUID()); setProjectIds(current => ({ ...current }))
    } catch (failure) { setError(message(failure)) }
    finally { setValidating(false) }
  }
  const retrying = !!sent.current && !result
  const choices = preview ? [...new Map(preview.rows.filter(row => new Set(row.candidates.map(order => order.projectId)).size > 1).map(row => [budgetCostMatchKey(row.projectCode, row.styleCode), row])).values()] : []
  return <Modal title="원가계산서 가져오기" wide onClose={close}>
    <div className="modal-body budget-cost-import">
      <div className="cost-import-intro"><FileSpreadsheet size={25}/><div><h3>프로젝트 코드와 SKU를 확인하고 원가를 연결합니다.</h3><p>15행 제목을 기준으로 값이 있는 항목을 가져옵니다. B·C열로 발주를 찾고 D~O열을 원가표 I~T열에 연결합니다. U열 금액은 단가(Q) × 요척량(S)입니다.</p></div></div>
      {!allowed && <p className="error-message" role="alert">원가 업로드는 승인된 본사 관리자·직원만 사용할 수 있습니다.</p>}
      {!available && <p className="cost-import-alert" role="status"><AlertCircle size={16}/>원가 업로드 저장 설정이 적용되지 않았습니다. 파일을 먼저 확인할 수 있으며 설정 후 적용할 수 있습니다.</p>}
      <label className="cost-import-file"><input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="원가계산서 Excel 파일" disabled={!allowed || reading || saving} onChange={event => { void read(event.target.files?.[0]); event.currentTarget.value = '' }}/>{reading ? <LoaderCircle size={23} className="loader"/> : <Upload size={23}/>}<strong>{reading ? '원가 파일을 읽고 있습니다…' : book?.fileName || '원가계산서 Excel 파일 선택'}</strong><span>.xlsx · 최대 10MB · 적용 전 프로젝트·SKU·금액을 확인하세요.</span></label>
      {error && <div><p className="error-message" role="alert">{error}</p>{retrying && <button type="button" className="button button-ghost" disabled={busy} onClick={() => void reviewAgain()}>최신 자료로 다시 검증</button>}</div>}
      {book && <>
        <fieldset className="cost-import-sheets" disabled={busy || !!result}><legend>가져올 원가 시트</legend>{book.sheets.filter(sheet => sheet.supported).map(sheet => <label key={sheet.name}><input type="checkbox" aria-label={`원가 시트 ${sheet.name}`} checked={sheets.includes(sheet.name)} onChange={event => selectSheet(sheet.name, event.target.checked)}/><span>{sheet.name}</span><small>{sheet.rows.length}행</small></label>)}{!book.sheets.some(sheet => sheet.supported) && <p className="error-message">15행에 지정된 원가 제목이 있는 시트를 찾지 못했습니다.</p>}<p>카테고리·업체리스트 등 참조 시트는 원가 항목으로 가져오지 않습니다.</p></fieldset>
        <p className="cost-import-scope-note">현재 화면의 필터와 관계없이 선택한 시트의 전체 원가 항목을 확인합니다. 적용 후에는 전체 원가 목록을 표시합니다.</p>
        {choices.length > 0 && <section className="cost-import-projects" aria-label="중복 프로젝트 연결"><h3>동일 코드·SKU의 프로젝트를 선택하세요.</h3>{choices.map(row => { const key = budgetCostMatchKey(row.projectCode, row.styleCode); return <label key={key}><span>{row.projectCode} / {row.styleCode}</span><select className="select" aria-label={`원가 프로젝트 연결 ${row.projectCode} ${row.styleCode}`} disabled={busy || !!result} value={projectIds[key] || ''} onChange={event => selectProject(key, event.target.value)}><option value="">프로젝트 선택</option>{[...new Map(row.candidates.map(order => [order.projectId, order])).values()].map(order => <option key={order.projectId} value={order.projectId}>{order.projectName || '명칭 미등록'} · {order.season} · {order.projectId}</option>)}</select></label> })}</section>}
        {validating && <p className="cost-import-validating" role="status"><LoaderCircle size={15} className="loader"/>발주와 저장된 원가를 대조하고 있습니다.</p>}
        {preview && <section className="cost-import-preview"><header><h3>적용 전 원가 미리보기</h3><span>신규 {preview.inserted} · 수정 {preview.updated} · 중복 제외 {preview.skipped} · 빈 행 제외 {preview.ignoredRows}</span></header>{preview.errors.length > 0 && <ul className="cost-import-errors" role="alert">{preview.errors.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}</ul>}
          {preview.warnings.length > 0 && <details className="cost-import-warnings"><summary>확인 사항 {preview.warnings.length}건</summary><ul>{preview.warnings.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}</ul></details>}
          <div className="cost-import-table-scroll" tabIndex={0} aria-label="원가 업로드 미리보기 가로 스크롤"><table aria-label="원가 업로드 미리보기"><thead><tr><th>시트 / 행</th><th>프로젝트 코드</th><th>프로젝트 명칭</th><th>SKU</th><th>종류</th><th>업체</th><th>내역</th><th>단가 Q</th><th>요척량 S</th><th>단위</th><th>금액 Q×S</th><th>처리</th><th>확인 사항</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.key} className={row.action === 'error' ? 'cost-import-row-error' : ''}><td>{row.sheetName}<small>{row.rowNumber}행</small></td><td>{row.projectCode || '미등록'}</td><td>{row.order?.projectName || '연결 전'}</td><td>{row.styleCode || '미등록'}</td><td>{row.values?.category || '—'}</td><td>{row.values?.supplierName || '—'}</td><td>{row.values?.description || '—'}</td><td className="cost-import-number">{number(row.values?.unitCost)}</td><td className="cost-import-number">{number(row.values?.consumption)}</td><td>{row.values?.unit || '—'}</td><td className="cost-import-number">{number(row.write?.data.amount ?? calculatedAmount(row.values))}</td><td><span className={`cost-import-action ${row.action}`}>{actionLabel[row.action]}</span></td><td>{row.errors.map((value, index) => <p className="error-message" key={`e-${index}`}>{value}</p>)}{row.warnings.map((value, index) => <p className="cost-import-warning" key={`w-${index}`}>{value}</p>)}</td></tr>)}{!preview.rows.length && <tr><td colSpan={13}>선택한 시트에 가져올 원가 항목이 없습니다.</td></tr>}</tbody></table></div>
          {hasErrors && <p className="error-message" role="alert">확인이 필요한 행이 있어 적용할 수 없습니다. 연결을 선택하거나 원본 파일을 수정해 다시 확인해 주세요.</p>}
          {!hasErrors && !changed && preview.rows.length > 0 && <p className="cost-import-duplicate" role="status">모든 항목이 이미 등록되어 있습니다. 같은 원가를 추가로 누적하지 않습니다.</p>}
        </section>}
        {result && <p className="success-message" role="status"><CheckCircle2 size={16}/>원가 업로드 완료 · 신규 {result.inserted} · 수정 {result.updated} · 중복 제외 {result.skipped}</p>}
        {!result && <label className="cost-import-reason"><span>원가 업로드 사유</span><input className="input" aria-label="원가 업로드 사유" value={reason} minLength={2} maxLength={1000} disabled={saving || retrying} onChange={event => setReason(event.target.value)} placeholder="예: 사전 원가계산서 등록"/></label>}
      </>}
      <div className="modal-footer"><button type="button" className="button" onClick={close} disabled={busy}>닫기</button><button type="button" className="button button-primary" onClick={() => void apply()} disabled={!allowed || !available || busy || !preview || !!result || !retrying && (hasErrors || !changed || reason.trim().length < 2)}>{saving ? '원가 적용 중…' : result ? '적용 완료' : retrying ? '동일 요청 다시 확인' : '검증된 원가 적용'}</button></div>
    </div>
  </Modal>
}
