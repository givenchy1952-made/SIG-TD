import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { ORDER_SOURCE_COLUMNS, type OrderImportChange, type OrderSourceData } from '../src/lib/operations-types'
import { importProductionOrdersInWorkspace, projectForImportLine, type RoundImportWorkspace } from '../src/lib/round-import'
import { emptyQuantities } from '../src/lib/types'
import { autoMapOrderColumns, buildOrderImportPreview } from '../src/lib/order-import'

function fixture() {
  const workspace = createSeed() as RoundImportWorkspace
  workspace.projects[0].code = 'PROJECT-A'; workspace.projects[1].code = 'PROJECT-B'
  workspace.styles[0].projectId = workspace.projects[0].id
  const actor = workspace.profiles.find(person => person.id === DEMO_IDS.internal)!, style = workspace.styles[0], line = style.production[0]
  return { workspace, actor, style, line }
}
function source(project: { code?: string; name: string; season: string }): OrderSourceData & { expectedVersion: number } {
  return { expectedVersion: 0, fileName: 'orders.csv', sheetName: 'ORDER QTY', headers: Object.fromEntries(ORDER_SOURCE_COLUMNS.map(column => [column, column])) as OrderSourceData['headers'], rows: [{ rowNumber: 2, columns: { A: project.code || '', F: 'BP06FYDW0101BK', L: project.season, M: project.name, S: '', V: '', W: '', X: '', Y: '', AQ: 1, AR: 2, AS: 3, AT: 4, AU: 5, AV: 6, AY: 21 } }] }
}
describe('프로젝트·생산 차수별 오더 업로드', () => {
  it('기존과 수량이 같은 리오더도 새 차수 생성 대상으로 미리보기에 포함한다', () => {
    const { workspace, style, line } = fixture()
    const headers = ['스타일코드', '컬러', 'XXS', 'XS', 'S', 'M', 'L', 'XL']
    const sheet = { name: 'orders', rows: [headers, [style.code, line.color, ...Object.values(line.order)]] }
    const mapping = autoMapOrderColumns(headers).mapping
    const options = { createProductionRounds: true, mapping, layout: 'wide' as const, headerRow: 1, duplicateMode: 'reject' as const, missingSizes: 'reject' as const, mode: 'replace' as const }
    const preview = buildOrderImportPreview(workspace, sheet, options)
    expect(preview.errors).toEqual([]); expect(preview.rows[0].errors).toEqual([])
    expect(preview.changedLines).toBe(0); expect(preview.changes).toHaveLength(1)
    expect(preview.changes[0].lines[0].quantities).toEqual(line.order)
  })
  it('파일 수량으로 새 차수를 만들고 이전 차수·실입고·단가는 바꾸지 않는다', () => {
    const { workspace, actor, style, line } = fixture(), quantities = { XXS: 1, XS: 2, S: 3, M: 4, L: 5, XL: 6 }
    const changes: OrderImportChange[] = [{ styleId: style.id, expectedVersion: style.version, lines: [{ lineId: line.id, color: line.color, quantities, source: source(workspace.projects[0]) }] }]
    const first = importProductionOrdersInWorkspace(workspace, actor, crypto.randomUUID(), changes, 'replace', '최초 발주 수량')
    expect(first.productionRuns).toHaveLength(1); expect(first.productionRuns![0]).toMatchObject({ round: 1, projectId: workspace.projects[0].id, order: quantities, unitCost: null, poId: null })
    const initialRun = structuredClone(first.productionRuns![0])
    changes[0].expectedVersion += 1; changes[0].lines[0].source!.expectedVersion += 1
    changes[0].lines[0].quantities = { ...emptyQuantities(), S: 10 }
    const second = importProductionOrdersInWorkspace(first, actor, crypto.randomUUID(), changes, 'add', '긴급 리오더 수량')
    expect(second.productionRuns).toHaveLength(2)
    expect(second.productionRuns![0]).toEqual(initialRun)
    expect(second.productionRuns![1]).toMatchObject({ round: 2, order: { ...emptyQuantities(), S: 10 } })
    expect(second.styles.find(item => item.id === style.id)!.production[0].order.S).toBe(13)
  })
  it('같은 품번의 다른 A열 프로젝트는 별도 프로젝트의 1차로 기록한다', () => {
    const { workspace, actor, style, line } = fixture()
    const changes: OrderImportChange[] = [{ styleId: style.id, expectedVersion: style.version, lines: [{ lineId: line.id, color: line.color, quantities: { ...emptyQuantities(), M: 20 }, source: source(workspace.projects[1]) }] }]
    const next = importProductionOrdersInWorkspace(workspace, actor, crypto.randomUUID(), changes, 'replace', '프로젝트 B 오더')
    expect(next.productionRuns![0]).toMatchObject({ projectId: workspace.projects[1].id, projectCode: 'PROJECT-B', round: 1 })
    expect(next.styles.find(item => item.id === style.id)!.projectId).toBe(workspace.projects[0].id)
  })
  it('같은 요청을 다시 적용해도 새 차수를 중복 생성하지 않는다', () => {
    const { workspace, actor, style, line } = fixture(), id = crypto.randomUUID()
    const changes: OrderImportChange[] = [{ styleId: style.id, expectedVersion: style.version, lines: [{ lineId: line.id, color: line.color, quantities: { ...emptyQuantities(), L: 4 } }] }]
    const first = importProductionOrdersInWorkspace(workspace, actor, id, changes, 'replace', '중복 방지 오더')
    const retried = importProductionOrdersInWorkspace(first, actor, id, changes, 'replace', '중복 방지 오더')
    expect(retried).toEqual(first)
    expect(() => importProductionOrdersInWorkspace(first, actor, id, changes, 'add', '중복 방지 오더')).toThrow('다른 내용')
  })
  it('등록되지 않은 A열 프로젝트는 기존 스타일 프로젝트로 대체하지 않고 전체 실패한다', () => {
    const { workspace, actor, style, line } = fixture(), before = structuredClone(workspace)
    const changes: OrderImportChange[] = [{ styleId: style.id, expectedVersion: style.version, lines: [{ lineId: line.id, color: line.color, quantities: { ...emptyQuantities(), S: 4 }, source: source({ ...workspace.projects[0], code: 'UNKNOWN-PROJECT' }) }] }]
    expect(() => importProductionOrdersInWorkspace(workspace, actor, crypto.randomUUID(), changes, 'replace', '알 수 없는 프로젝트')).toThrow('A열 프로젝트')
    expect(workspace).toEqual(before)
  })
  it('같은 품번·컬러에 섞인 프로젝트와 등록된 명칭·시즌 불일치를 거부한다', () => {
    const { workspace, style, line } = fixture(), data = source(workspace.projects[0])
    const update = { lineId: line.id, color: line.color, quantities: emptyQuantities(), source: data }
    data.rows.push({ ...structuredClone(data.rows[0]), rowNumber: 3, columns: { ...data.rows[0].columns, A: 'PROJECT-B' } })
    expect(() => projectForImportLine(workspace, style.id, update)).toThrow('서로 다른 프로젝트')
    data.rows.pop(); data.rows[0].columns.M = '변경된 명칭'
    expect(() => projectForImportLine(workspace, style.id, update)).toThrow('명칭·시즌')
  })
  it('공장 계정 및 승인 취소된 계정은 업로드할 수 없다', () => {
    const { workspace, actor, style, line } = fixture()
    const changes: OrderImportChange[] = [{ styleId: style.id, expectedVersion: style.version, lines: [{ lineId: line.id, color: line.color, quantities: emptyQuantities() }] }]
    expect(() => importProductionOrdersInWorkspace(workspace, workspace.profiles.find(person => person.role === 'factory')!, crypto.randomUUID(), changes, 'replace', '공장 오더 변경')).toThrow('본사')
    workspace.profiles.find(person => person.id === actor.id)!.approved = false
    expect(() => importProductionOrdersInWorkspace(workspace, actor, crypto.randomUUID(), changes, 'replace', '권한 취소 후 변경')).toThrow('본사')
  })
})
