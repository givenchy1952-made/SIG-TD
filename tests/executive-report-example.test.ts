import { describe, expect, it } from 'vitest'
import { buildExecutiveProductionReport } from '../src/lib/executive-production'
import { blankProduction, type Style, type Workspace } from '../src/lib/types'

const manager = '91000000-0000-4000-8000-000000000001'
const project = '91000000-0000-4000-8000-000000000002'
const budget = 'SIGNIFICANT-2026FY-RPQ-REPORT-INTERNAL'

/** The screenshot is a test case, not application seed or report constants. */
function example(): Workspace {
  const factories = [
    { id: 'kr', name: '국내 생산처', country: '대한민국' },
    { id: 'vn', name: '베트남 생산처', country: '베트남' },
    { id: 'cn', name: '중국 생산처', country: '중국' },
  ]
  const quantities: [string, string, number][] = [
    ['2026-11-30', 'kr', 6716], ['2026-11-30', 'vn', 13876],
    ['2026-12-31', 'kr', 1967], ['2026-12-31', 'vn', 1780], ['2026-12-31', 'cn', 200],
    ['2027-02-28', 'kr', 3200], ['2027-03-31', 'kr', 11650], ['2027-03-31', 'cn', 300],
  ]
  const styles: Style[] = quantities.map(([dueDate, factoryId, count], index) => {
    const line = blankProduction('BK'); line.order.M = count
    return { id: `style-${index}`, code: `REPORT${index}`, name: '보고 집계 시험용', category: '상의', season: '2026FY', projectId: project, factoryId, ownerId: manager,
      colors: ['BK'], dueDate, stage: 'production', ppApproved: false, notes: '', samples: [], production: [line],
      version: 1, updatedAt: '2026-11-05T00:00:00Z', updatedBy: manager, deletedAt: null }
  })
  return { profiles: [{ id: manager, name: '본사 보고 담당', email: 'report@example.test', role: 'internal', approved: true, active: true, factoryId: null }], factories,
    projects: [{ id: project, name: '시그니피컨트 2026 11M-2', code: budget, season: '2026FY' }], styles, comments: [], attachments: [], audits: [], productionRuns: [], productionReceipts: [] }
}
const options = { profileId: manager, fromMonth: '2026-11', toMonth: '2027-03', asOf: '2026-11-05' }

describe('대표 보고 예시의 월별·국가별 합계', () => {
  it('등록 수량으로 39,689장과 국내·해외·국가 합계를 재현하며 1월 0장도 표시한다', () => {
    const workspace = example(), before = structuredClone(workspace)
    const report = buildExecutiveProductionReport(workspace, options)
    expect(report.authorized).toBe(true)
    expect(report.months.map(row => [row.month, row.expected.total, row.expected.domestic, row.expected.overseas])).toEqual([
      ['2026-11', 20592, 6716, 13876], ['2026-12', 3947, 1967, 1980], ['2027-01', 0, 0, 0],
      ['2027-02', 3200, 3200, 0], ['2027-03', 11950, 11650, 300],
    ])
    expect(report.totals.expected).toEqual({ total: 39689, domestic: 23533, overseas: 16156, unclassified: 0 })
    expect(Object.fromEntries(report.countries.map(row => [row.country, row.current]))).toEqual({ 대한민국: 23533, 베트남: 15656, 중국: 500 })
    expect(report.totals.received.total).toBe(0)
    expect(JSON.stringify(report)).not.toContain(budget)
    expect(workspace).toEqual(before)
  })

  it('실입고가 추가되면 확인된 입고와 남은 예정 수량을 분리하고 원래 계획은 유지한다', () => {
    const workspace = example(), line = workspace.styles[0].production[0]
    line.received.M = 100; line.receivedAt = '2026-11-04'
    const report = buildExecutiveProductionReport(workspace, options)
    expect(report.totals.planned.total).toBe(39689)
    expect(report.totals.expected.total).toBe(39589)
    expect(report.totals.received).toEqual({ total: 100, domestic: 100, overseas: 0, unclassified: 0 })
    expect(report.months[0].expected.domestic).toBe(6616)
    expect(report.months[0].received.total).toBe(100)
  })
})
