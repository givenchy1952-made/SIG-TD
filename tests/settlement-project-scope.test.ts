import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import type { ProductionRun } from '../src/lib/production-ledger'
import { settlementProjectOptions, settlementSkuOptions, selectSettlementStyles, sortEuljiRowsByProject } from '../src/lib/settlement-export-scope'
import { buildSettlementRows, autoMapSettlementColumns } from '../src/lib/settlement-template'
import type { SigEuljiRow } from '../src/lib/sig-eulji'

function fixture() {
  const workspace = createSeed(), admin = workspace.profiles.find(item => item.id === DEMO_IDS.admin)!
  const [a, b, c] = workspace.projects
  a.name = b.name = '동일 공식 프로젝트 명칭'; a.code = 'PROJECT-A'; b.code = 'PROJECT-B'; c.name = '다른 프로젝트'; c.code = 'PROJECT-C'
  const styles = workspace.styles.slice(0, 3)
  styles.forEach((style, index) => { style.projectId = [a.id, b.id, c.id][index]; style.production = style.production.slice(0, 1) })
  workspace.styles = styles
  return { workspace, admin, styles, a, b, c }
}

describe('을지 프로젝트 명칭·품번 선택 범위', () => {
  it('같은 명칭이어도 ID로 단일·복수 선택하고 품번 조건과 AND 조합한다', () => {
    const { workspace, styles, a, b, c } = fixture()
    const keys = settlementSkuOptions(workspace, styles, null).map(item => item.key)
    expect(selectSettlementStyles(workspace, styles, [a.id], keys).map(item => item.id)).toEqual([styles[0].id])
    expect(selectSettlementStyles(workspace, styles, [a.id, b.id], keys).map(item => item.projectId)).toEqual([a.id, b.id])
    const bKey = `${styles[1].id}:${styles[1].production[0].id}`
    expect(selectSettlementStyles(workspace, styles, [a.id, b.id], [bKey]).map(item => item.projectId)).toEqual([b.id])
    expect(selectSettlementStyles(workspace, styles, [c.id], [bKey])).toEqual([])
    expect(selectSettlementStyles(workspace, styles, [], keys)).toEqual([])
    expect(selectSettlementStyles(workspace, styles, null, keys)).toHaveLength(3)
  })
  it('선택한 프로젝트에 속한 품번만 표시하고 숨겨진 프로젝트 데이터를 포함하지 않는다', () => {
    const { workspace, styles, a, b } = fixture(), before = structuredClone(workspace)
    const choices = settlementSkuOptions(workspace, styles, [b.id])
    expect(choices).toHaveLength(1); expect(choices[0].styleId).toBe(styles[1].id)
    const foreign = { ...structuredClone(styles[0]), id: crypto.randomUUID(), projectId: b.id }
    expect(settlementSkuOptions(workspace, [foreign], [b.id])).toEqual([])
    expect(settlementProjectOptions(workspace, [styles[0]]).map(item => item.id)).toEqual([a.id])
    expect(workspace).toEqual(before)
  })
  it('이전 프로젝트 생산 차수의 품번도 조회하되 일반·가공 양식에서는 현재 프로젝트로 제한한다', () => {
    const { workspace, styles, a, b } = fixture(), style = styles[0], line = style.production[0]
    workspace.productionRuns = [{ id: crypto.randomUUID(), styleId: style.id, lineId: line.id, projectId: b.id } as ProductionRun]
    expect(settlementProjectOptions(workspace, [style]).map(item => item.id).sort()).toEqual([a.id, b.id].sort())
    const choices = settlementSkuOptions(workspace, [style], [b.id])
    expect(choices).toHaveLength(1)
    expect(selectSettlementStyles(workspace, [style], [b.id], [choices[0].key])).toHaveLength(1)
    expect(settlementSkuOptions(workspace, [style], [b.id], false)).toEqual([])
    expect(selectSettlementStyles(workspace, [style], [b.id], [choices[0].key], false)).toEqual([])
  })
  it('확정 차수는 현재 차수 프로젝트가 바뀌어도 마감 스냅샷의 프로젝트 선택·품번 범위를 유지한다', () => {
    const { workspace, styles, a, b, c } = fixture(), style = styles[0], line = style.production[0]
    workspace.productionRuns = [{ id: crypto.randomUUID(), styleId: style.id, lineId: line.id, projectId: c.id, closedAt: '2026-10-30T00:00:00Z', snapshot: { projectId: b.id } } as ProductionRun]
    expect(settlementProjectOptions(workspace, [style]).map(item => item.id).sort()).toEqual([a.id, b.id].sort())
    const choices = settlementSkuOptions(workspace, [style], [b.id])
    expect(choices).toHaveLength(1)
    expect(selectSettlementStyles(workspace, [style], [b.id], [choices[0].key])).toHaveLength(1)
    expect(settlementSkuOptions(workspace, [style], [c.id])).toEqual([])
    expect(selectSettlementStyles(workspace, [style], [c.id], [choices[0].key])).toEqual([])
  })
  it('다른 양식의 명칭·코드·ID 열을 구분하고 명칭이 없으면 기존 코드로 표시한다', () => {
    const { workspace, admin, styles, a } = fixture()
    const before = structuredClone(workspace)
    const [row] = buildSettlementRows(workspace, [styles[0]], admin)
    expect(row).toMatchObject({ project: a.name, projectCode: a.code, projectId: a.id })
    expect(autoMapSettlementColumns([{ column: 1, letter: 'A', header: '프로젝트 명칭' }, { column: 2, letter: 'B', header: '프로젝트 코드' }, { column: 3, letter: 'C', header: '프로젝트 ID' }])).toEqual({ 1: 'project', 2: 'projectCode', 3: 'projectId' })
    expect(workspace).toEqual(before)
    a.name = ''
    expect(buildSettlementRows(workspace, [styles[0]], admin)[0].project).toBe(a.code)
  })
  it('프로젝트 명칭·코드 정렬은 원본 순서와 재무 값을 변경하지 않는다', () => {
    const rows = [{ projectId: 'b', projectName: '가 프로젝트', projectCode: 'Z-CODE', colorStyleCode: 'STYLEBK', netAmount: 125 }, { projectId: 'a', projectName: '나 프로젝트', projectCode: 'A-CODE', colorStyleCode: 'STYLEWH', netAmount: 50 }] as SigEuljiRow[]
    const before = structuredClone(rows)
    expect(sortEuljiRowsByProject(rows, 'name').map(row => row.projectId)).toEqual(['b', 'a'])
    expect(sortEuljiRowsByProject(rows, 'code').map(row => row.projectId)).toEqual(['a', 'b'])
    expect(sortEuljiRowsByProject(rows).reduce((sum, row) => sum + row.netAmount!, 0)).toBe(175)
    expect(rows).toEqual(before)
  })
})
