import { useMemo, useState } from 'react'
import { ArrowDownToLine, BarChart3, Check, ClipboardCopy, RotateCcw } from 'lucide-react'
import type { Profile, Workspace } from '../lib/types'
import { buildExecutiveProductionReport, executiveToday } from '../lib/executive-production'
import { getProjectIdentity, projectFilterOptions } from '../lib/project-identity'
import { safeCSVCell } from '../lib/export'
import MultiSelectFilter from './MultiSelectFilter'
import './executive-production.css'

interface Props { workspace: Workspace; profile: Profile }
type Report = ReturnType<typeof buildExecutiveProductionReport>
type Selection = string[] | null
const number = (value: number) => value.toLocaleString('ko-KR')
const percent = (value: number, total: number) => total > 0 ? `${(value / total * 100).toFixed(1)}%` : '0.0%'
const monthLabel = (month: string) => `${month.slice(0, 4)}.${month.slice(5, 7)}`
const longMonth = (month: string) => `${month.slice(0, 4)}년 ${Number(month.slice(5, 7))}월`
function followingMonth(month: string, offset: number) {
  const [year, value] = month.split('-').map(Number), date = new Date(Date.UTC(year, value - 1 + offset, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}
const regionLabel = (region: string) => region === 'domestic' ? '국내' : region === 'overseas' ? '해외' : '국가 미지정'
const splitText = (value: { domestic: number; overseas: number; unclassified: number }) => `국내 ${number(value.domestic)}장 · 해외 ${number(value.overseas)}장${value.unclassified ? ` · 국가 미지정 ${number(value.unclassified)}장` : ''}`
const choiceText = (selection: Selection, options: { value: string; label: string }[], all: string) => selection === null ? all : options.filter(option => selection.includes(option.value)).map(option => option.label).join(', ') || '선택 없음'

function coverageLines(report: Report): string[] {
  const value = report.coverage
  return [
    ...(value.undatedExpected ? [`납기일 미등록 입고 예정 ${number(value.undatedExpected)}장: 월별 집계 제외`] : []),
    ...(value.undatedPlanned ? [`납기일 미등록 계획 총수량 ${number(value.undatedPlanned)}장: 월별 집계 제외`] : []),
    ...(value.undatedReceived ? [`입고일 미등록 실입고 ${number(value.undatedReceived)}장: 월별 집계 제외`] : []),
    ...(value.unclassifiedCurrent ? [`생산국 미지정 미입고 ${number(value.unclassifiedCurrent)}장: 국내·해외로 추정하지 않음`] : []),
    ...(value.invalidPartialPlans ? [`오더와 맞지 않는 부분 납기 ${number(value.invalidPartialPlans)}건: 차수의 기본 납기로 집계`] : []),
    ...(value.legacyScalarPlans ? [`사이즈별 수량이 없는 기존 부분 납기 ${number(value.legacyScalarPlans)}건: 총수량 기준으로 집계`] : []),
    ...(value.legacyReceiptQuantity ? [`기존 누적 입고일 기준 ${number(value.legacyReceiptQuantity)}장: 과거 부분 입고 월은 원본 확인 필요`] : []),
    ...(value.unallocatedLegacyReceived ? [`차수 배분 확인 필요 ${number(value.unallocatedLegacyReceived)}장: 누적 입고를 확인된 차수 실적과 중복 합산하지 않음`] : []),
    ...(value.overReceived ? [`오더 초과 입고 ${number(value.overReceived)}장: 다른 사이즈의 미입고를 차감하지 않음`] : []),
    ...(value.orphanReceipts ? [`연결 오더를 확인할 수 없는 입고 ${number(value.orphanReceipts)}건: 집계 제외`] : []),
    ...(value.invalidQuantityRows ? [`유효하지 않은 수량 기록 ${number(value.invalidQuantityRows)}건: 집계 제외`] : []),
    ...(value.futureReceiptQuantity ? [`기준일 이후로 입력된 입고 ${number(value.futureReceiptQuantity)}장: 현재 실적에서 제외`] : []),
  ]
}

function reportText(report: Report, scope: string): string {
  return [
    `SIG 생산·입고 현황 (${report.asOf} 기준)`,
    `보고 기간: ${monthLabel(report.fromMonth)} ~ ${monthLabel(report.toMonth)}`,
    `보고 범위: ${scope}`,
    '',
    `기간 계획 총수량: ${number(report.totals.planned.total)}장`,
    `기간 입고 예정(잔량): ${number(report.totals.expected.total)}장 (${splitText(report.totals.expected)})`,
    `기간 확인된 입고 실적: ${number(report.totals.received.total)}장 (${splitText(report.totals.received)})`,
    '',
    ...report.months.map(month => `${longMonth(month.month)}: 계획 ${number(month.planned.total)}장 / 입고 예정 잔량 ${number(month.expected.total)}장 (${splitText(month.expected)}) / 입고 실적 ${number(month.received.total)}장`),
    '',
    `현재 미입고 잔량: ${number(report.current.outstanding)}장`,
    `생산 중 ${number(report.current.producing)}장 · 생산 대기 ${number(report.current.awaiting)}장 · 상태 확인 필요 ${number(report.current.statusUnknown)}장`,
    ...report.countries.map(country => `${country.country} (${regionLabel(country.region)}): 미입고 ${number(country.current)}장 / 생산 중 ${number(country.producing)}장 · 생산 대기 ${number(country.awaiting)}장 · 상태 확인 필요 ${number(country.statusUnknown)}장`),
    '',
    '집계 기준: 입고 예정은 실제 입고를 차감한 잔량이며, 입고 실적과 별도입니다. 부분 납기 잔량은 등록된 사이즈·총수량을 기준으로 빠른 납기부터 입고를 차감한 계획 잔량입니다. 현재 생산·대기·미입고는 월 기간과 무관한 선택 범위 전체 오더 기준입니다.',
    ...coverageLines(report),
  ].join('\n')
}

function downloadReport(report: Report, scope: { projects: string; seasons: string; factories: string }) {
  const headers = ['구분', '월', '생산국', '국내·해외', '계획 총수량', '입고 예정 잔량', '입고 실적', '현재 생산 중', '생산 대기', '상태 확인 필요', '현재 미입고 잔량', '기준일', '보고 기간', '프로젝트 명칭', '시즌', '공장', '집계 참고사항']
  const context = [report.asOf, `${report.fromMonth} ~ ${report.toMonth}`, scope.projects, scope.seasons, scope.factories]
  const rows: (string | number)[][] = []
  rows.push(['전체 요약', '', '', '전체', report.totals.planned.total, report.totals.expected.total, report.totals.received.total, report.current.producing, report.current.awaiting, report.current.statusUnknown, report.current.outstanding, ...context])
  for (const month of report.months) {
    for (const region of ['domestic', 'overseas', 'unclassified'] as const) rows.push(['월별 입고', month.month, '', regionLabel(region), month.planned[region], month.expected[region], month.received[region], '', '', '', '', ...context])
  }
  for (const country of report.countries) rows.push(['생산국별 현황', '', country.country, regionLabel(country.region), country.planned, country.expected, country.received, country.producing, country.awaiting, country.statusUnknown, country.current, ...context])
  rows.push(['집계 기준', '', '', '', '', '', '', '', '', '', '', ...context, '현재 생산·대기·미입고는 월 기간과 무관한 선택 범위 전체 오더 기준. 부분 납기 잔량은 실제 입고를 사이즈별로 빠른 납기부터 차감한 계획 잔량.'])
  for (const line of coverageLines(report)) rows.push(['집계 확인 사항', '', '', '', '', '', '', '', '', '', '', ...context, line])
  const csv = '\uFEFF' + [headers, ...rows.map(row => row.length < headers.length ? [...row, ''] : row)].map(row => row.map(safeCSVCell).join(',')).join('\r\n') + '\r\n'
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
  const link = document.createElement('a')
  link.href = url; link.download = `SIG_생산입고_보고_${report.fromMonth}_${report.toMonth}_${report.asOf}.csv`
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function ExecutiveProductionDashboard({ workspace, profile }: Props) {
  const asOf = executiveToday(), thisMonth = asOf.slice(0, 7)
  const [fromMonth, setFromMonth] = useState(thisMonth), [toMonth, setToMonth] = useState(followingMonth(thisMonth, 4))
  const [projectIds, setProjectIds] = useState<Selection>(null), [seasons, setSeasons] = useState<Selection>(null), [factoryIds, setFactoryIds] = useState<Selection>(null)
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [copyFallback, setCopyFallback] = useState(false)
  const actor = workspace.profiles.find(person => person.id === profile.id)
  const allowed = !!actor?.approved && actor.active && actor.role !== 'factory'
  const result = useMemo(() => {
    if (!allowed) return { report: null, error: '' }
    try { return { report: buildExecutiveProductionReport(workspace, { profileId: profile.id, fromMonth, toMonth, asOf, projectIds, seasons, factoryIds }), error: '' } }
    catch (failure) { return { report: null, error: failure instanceof Error ? failure.message : '보고 기간을 확인해 주세요.' } }
  }, [workspace, profile.id, allowed, fromMonth, toMonth, asOf, projectIds, seasons, factoryIds])
  if (!allowed) return null
  const report = result.report
  const projects = projectFilterOptions(workspace)
  const seasonOptions = [...new Set([...workspace.projects.map(project => getProjectIdentity(workspace, project.id).season), ...workspace.styles.map(style => style.season)])].filter(Boolean).sort().map(value => ({ value, label: value }))
  const factories = workspace.factories.filter(factory => !factory.serviceType || factory.serviceType === 'production').map(factory => ({ value: factory.id, label: factory.name }))
  const scope = { projects: choiceText(projectIds, projects, '전체 프로젝트 명칭'), seasons: choiceText(seasons, seasonOptions, '전체 시즌'), factories: choiceText(factoryIds, factories, '전체 생산 공장') }
  const scopeText = `${scope.projects} / ${scope.seasons} / ${scope.factories}`
  const text = report ? reportText(report, scopeText) : ''
  const hasFilters = projectIds !== null || seasons !== null || factoryIds !== null || fromMonth !== thisMonth || toMonth !== followingMonth(thisMonth, 4)
  function reset() { setFromMonth(thisMonth); setToMonth(followingMonth(thisMonth, 4)); setProjectIds(null); setSeasons(null); setFactoryIds(null); setNotice(''); setError(''); setCopyFallback(false) }
  async function copy() {
    if (!report?.authorized) return
    setNotice(''); setError('')
    try { await navigator.clipboard.writeText(text); setCopyFallback(false); setNotice('보고 내용을 복사했습니다. 메일이나 메신저에 붙여넣으세요.') }
    catch { setCopyFallback(true); setError('자동 복사를 사용할 수 없습니다. 아래 보고 내용을 전체 선택해 복사해 주세요.') }
  }
  const maximum = report ? Math.max(1, ...report.months.map(month => month.expected.total)) : 1
  const countryMaximum = report ? Math.max(1, ...report.countries.map(country => country.current)) : 1
  return <section className="executive-production panel" aria-label="생산·입고 경영 보고">
    <header className="executive-production-heading"><div><p className="eyebrow">PRODUCTION BRIEFING</p><h2><BarChart3 size={20}/>생산·입고 한눈에</h2><p>월별 입고와 생산국별 진행 수량을 대표 보고용으로 확인합니다.</p></div><div className="executive-production-actions"><span className="executive-asof">{asOf.replaceAll('-', '.')} 기준</span><button type="button" className="button" disabled={!report?.authorized} onClick={() => void copy()}><ClipboardCopy size={14}/>보고 내용 복사</button><button type="button" className="button" disabled={!report?.authorized} onClick={() => { if (report?.authorized) downloadReport(report, scope) }}><ArrowDownToLine size={14}/>보고 CSV 다운로드</button></div></header>
    <div className="executive-report-filters" role="group" aria-label="경영 보고 범위">
      <strong>보고 범위</strong><label><span>시작 월</span><input className="input" aria-label="경영 보고 시작 월" type="month" value={fromMonth} onChange={event => { setFromMonth(event.target.value); setNotice(''); setCopyFallback(false) }}/></label><span className="executive-month-divider">~</span><label><span>종료 월</span><input className="input" aria-label="경영 보고 종료 월" type="month" value={toMonth} onChange={event => { setToMonth(event.target.value); setNotice(''); setCopyFallback(false) }}/></label>
      <MultiSelectFilter label="경영 보고 프로젝트 명칭" allLabel="전체 프로젝트 명칭" value={projectIds} onChange={value => { setProjectIds(value); setNotice(''); setCopyFallback(false) }} options={projects}/>
      <MultiSelectFilter label="경영 보고 시즌" allLabel="전체 시즌" value={seasons} onChange={value => { setSeasons(value); setNotice(''); setCopyFallback(false) }} options={seasonOptions}/>
      <MultiSelectFilter label="경영 보고 생산 공장" allLabel="전체 생산 공장" value={factoryIds} onChange={value => { setFactoryIds(value); setNotice(''); setCopyFallback(false) }} options={factories}/>
      {hasFilters && <button className="button button-ghost" type="button" onClick={reset}><RotateCcw size={13}/>보고 범위 초기화</button>}
    </div>
    {(projectIds !== null || seasons !== null || factoryIds !== null) && <p className="executive-report-scope" aria-label="선택한 경영 보고 범위">{scopeText}</p>}
    {result.error && <p className="error-message" role="alert">보고 시작·종료 월을 확인해 주세요. 최대 36개월까지 한 번에 조회할 수 있습니다.</p>}
    {error && <p className="error-message" role="alert">{error}</p>}{notice && <p className="success-message" role="status"><Check size={14}/>{notice}</p>}
    {copyFallback && report && <label className="executive-copy-fallback"><span>보고 내용 · 전체 선택 후 복사</span><textarea className="textarea" aria-label="경영 보고 복사할 내용" readOnly value={text} rows={8} onFocus={event => event.target.select()}/></label>}
    {report?.authorized && <>
      <div className="executive-kpis">
        <article className="executive-kpi executive-kpi-primary" aria-label="보고 기간 입고 예정"><span>기간 입고 예정 <small>미입고 잔량</small></span><strong>{number(report.totals.expected.total)}<small>장</small></strong><p>{splitText(report.totals.expected)}</p></article>
        <article className="executive-kpi" aria-label="보고 기간 입고 실적"><span>기간 입고 실적</span><strong>{number(report.totals.received.total)}<small>장</small></strong><p>확인된 입고 기록 기준 · 예정 수량과 별도</p></article>
        <article className="executive-kpi" aria-label="현재 생산 중"><span>현재 생산 중</span><strong>{number(report.current.producing)}<small>장</small></strong><p>생산 승인·시작이 확인된 미입고 잔량</p></article>
        <article className="executive-kpi" aria-label="현재 생산 대기"><span>현재 생산 대기</span><strong>{number(report.current.awaiting)}<small>장</small></strong><p>PO·업체 회신·본사 승인 대기</p></article>
      </div>
      {(report.coverage.unallocatedLegacyReceived > 0 || report.coverage.undatedExpected > 0 || report.coverage.undatedReceived > 0) && <div className="executive-reconciliation" role="status">
        {report.coverage.unallocatedLegacyReceived > 0 && <p><strong>차수 배분 확인 필요 {number(report.coverage.unallocatedLegacyReceived)}장</strong>누적 입고에는 있으나 차수별 입고로 연결되지 않은 수량입니다. 확인된 차수 실적과 중복 합산하지 않았습니다.</p>}
        {report.coverage.undatedExpected > 0 && <p><strong>납기일 미등록 예정 {number(report.coverage.undatedExpected)}장</strong>현재 미입고 잔량에는 포함되며 월별 예정에서는 제외했습니다.</p>}
        {report.coverage.undatedReceived > 0 && <p><strong>입고일 미등록 실입고 {number(report.coverage.undatedReceived)}장</strong>입고 월을 확인할 수 없어 월별 실적에서 제외했습니다.</p>}
      </div>}
      <div className="executive-charts">
        <section className="executive-month-chart" aria-label="월별 입고 예정 및 실적"><div className="executive-chart-heading"><div><h3>월별 입고 예정</h3><p>{monthLabel(report.fromMonth)} — {monthLabel(report.toMonth)} · 실제 입고 차감 후 잔량</p></div><div className="executive-legend"><span><i className="executive-domestic"/>국내</span><span><i className="executive-overseas"/>해외</span><span><i className="executive-unclassified"/>미지정</span></div></div>
          <div className="executive-month-bars">{report.months.map(month => <article key={month.month} className="executive-month-row" aria-label={`${longMonth(month.month)} 입고 현황`}><header><strong>{monthLabel(month.month)}</strong><span>예정 <b>{number(month.expected.total)}</b>장</span></header><div className="executive-bar-track" role="img" aria-label={`${longMonth(month.month)} 입고 예정 ${number(month.expected.total)}장, ${splitText(month.expected)}`}>
            {(['domestic', 'overseas', 'unclassified'] as const).map(region => <span key={region} className={`executive-${region}`} style={{ width: `${month.expected[region] / maximum * 100}%` }} title={`${regionLabel(region)} ${number(month.expected[region])}장`}/>)}
          </div><footer><span>{splitText(month.expected)}</span><span>실적 <strong>{number(month.received.total)}</strong>장</span></footer></article>)}</div>
          <details className="executive-month-detail"><summary>월별 계획·예정·실적 상세</summary><div className="executive-table-scroll"><table aria-label="월별 생산 입고 상세"><thead><tr><th>월</th><th>계획 총수량</th><th>예정 잔량</th><th>국내 예정</th><th>해외 예정</th><th>미지정 예정</th><th>입고 실적</th></tr></thead><tbody>{report.months.map(month => <tr key={month.month}><th>{monthLabel(month.month)}</th><td>{number(month.planned.total)}</td><td>{number(month.expected.total)}</td><td>{number(month.expected.domestic)}</td><td>{number(month.expected.overseas)}</td><td>{number(month.expected.unclassified)}</td><td>{number(month.received.total)}</td></tr>)}</tbody><tfoot><tr><th>합계</th><td>{number(report.totals.planned.total)}</td><td>{number(report.totals.expected.total)}</td><td>{number(report.totals.expected.domestic)}</td><td>{number(report.totals.expected.overseas)}</td><td>{number(report.totals.expected.unclassified)}</td><td>{number(report.totals.received.total)}</td></tr></tfoot></table></div></details>
        </section>
        <section className="executive-country-chart" aria-label="생산국별 진행 현황"><div className="executive-chart-heading"><div><h3>생산국별 미입고 잔량</h3><p>선택 범위 전체 오더 · 보고 월 기간과 별도</p></div><strong className="executive-country-total">{number(report.current.outstanding)}<small>장</small></strong></div>
          {report.countries.some(country => country.current > 0) ? <div className="executive-country-bars">{report.countries.filter(country => country.current > 0).map(country => <article key={country.country} aria-label={`${country.country} 생산 현황`}><header><strong>{country.country}<small>{regionLabel(country.region)}</small></strong><span><b>{number(country.current)}</b>장 <small>{percent(country.current, report.current.outstanding)}</small></span></header><div className="executive-country-track" role="img" aria-label={`${country.country} 미입고 ${number(country.current)}장, 전체의 ${percent(country.current, report.current.outstanding)}`}><i className={`executive-${country.region}`} style={{ width: `${country.current / countryMaximum * 100}%` }}/></div><p>생산 중 {number(country.producing)} · 생산 대기 {number(country.awaiting)}{country.statusUnknown > 0 ? ` · 상태 확인 ${number(country.statusUnknown)}` : ''}</p></article>)}</div> : <p className="executive-empty">현재 선택 범위에 미입고 생산 오더가 없습니다.</p>}
          {report.current.statusUnknown > 0 && <p className="executive-data-note">생산 시작 상태 확인이 필요한 잔량 <strong>{number(report.current.statusUnknown)}장</strong>은 생산 중·대기와 구분했습니다.</p>}
        </section>
      </div>
      <div className="executive-report-basis"><strong>집계 기준</strong><p>납기 계획은 생산 차수·부분 납기를 우선 사용합니다. 부분 납기 잔량은 등록된 사이즈·총수량을 기준으로 빠른 납기부터 실제 입고를 차감한 계획 잔량이며, 입고 실적은 별도 기록입니다. 차수 기록과 메인 생산 누적 수량을 중복 합산하지 않습니다.</p></div>
      {coverageLines(report).length > 0 && <details className="executive-coverage"><summary>집계 확인 사항</summary><ul>{coverageLines(report).map(line => <li key={line}>{line}</li>)}</ul></details>}
    </>}
  </section>
}
