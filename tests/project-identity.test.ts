import { describe, expect, it } from 'vitest'
import { createSeed } from '../src/lib/seed'
import { EMPTY_OPERATIONS, ORDER_SOURCE_COLUMNS } from '../src/lib/operations-types'
import type { OrderSourceColumn, OrderSourceRecord } from '../src/lib/operations-types'
import type { Project, Workspace } from '../src/lib/types'
import { buildProjectMappingSuggestions, compareProjectIds, filterStylesByProjects, getHistoricalProjectIdentity, getProjectIdentity, matchesProjectSelection, projectFilterOptions } from '../src/lib/project-identity'

const CODE = 'SIGNIFICANT-2026FY-RPQ-46318', NAME = '시그니피컨트 2026 11M-1'
function source(workspace: Workspace, values = [CODE, NAME, '2026FY']): OrderSourceRecord {
  const style = workspace.styles[0]
  const columns = Object.fromEntries(ORDER_SOURCE_COLUMNS.map(column => [column, null])) as Record<OrderSourceColumn, string | null>
  columns.A = values[0]; columns.M = values[1]; columns.L = values[2]
  return { styleId: style.id, lineId: style.production[0].id, fileName: '오더.xlsx', sheetName: 'ORDER', headers: { ...columns }, rows: [{ rowNumber: 2, columns }], version: 1, createdAt: '', updatedAt: '', updatedBy: workspace.profiles[0].id }
}
function fixture(metadata: Partial<Project> = {}) {
  const workspace = createSeed(), style = workspace.styles[0]
  const project = { ...workspace.projects.find(item => item.id === style.projectId)!, code: CODE, name: NAME, season: '2026FY', ...metadata }
  workspace.projects = [project]; workspace.styles = [style]
  workspace.operations = structuredClone(EMPTY_OPERATIONS)
  workspace.operations.orderSourceRecords.push(source(workspace))
  return { workspace, style, project }
}

describe('공식 프로젝트 명칭·코드 및 ID 선택', () => {
  it('공식 명칭을 먼저 표시하고 코드와 시즌을 함께 검색하며 스타일명으로 대체하지 않는다', () => {
    const { workspace, style, project } = fixture()
    style.name = '프로젝트명으로 사용하면 안 되는 스타일명'
    expect(getProjectIdentity(workspace, project.id)).toEqual({ id: project.id, name: NAME, code: CODE, season: '2026FY', label: `${NAME} · ${CODE}`, searchText: `${NAME} ${CODE} 2026FY`.toLowerCase() })
  })
  it('명칭이 없는 기존 프로젝트는 코드로 표시하고 조회 중 데이터를 수정하지 않는다', () => {
    const { workspace, project } = fixture({ name: '  ' }), before = structuredClone(workspace)
    expect(getProjectIdentity(workspace, project.id).name).toBe(CODE)
    expect(projectFilterOptions(workspace)).toEqual([{ value: project.id, label: CODE }])
    expect(workspace).toEqual(before)
    expect(getProjectIdentity(workspace, 'missing').name).toBe('프로젝트 미지정')
  })
  it('동일 명칭을 가진 다른 프로젝트는 코드와 기존 ID로 구분한다', () => {
    const { workspace, project } = fixture()
    workspace.projects.push({ ...project, id: 'different-project', code: 'SIGNIFICANT-2026FY-MPQ-46318' })
    const options = projectFilterOptions(workspace)
    expect(options).toHaveLength(2)
    expect(options.every(item => item.label.startsWith(NAME))).toBe(true)
    expect(new Set(options.map(item => item.label)).size).toBe(2)
    expect(new Set(options.map(item => item.value)).size).toBe(2)
  })
  it('코드까지 같거나 빠진 동명 프로젝트도 ID가 구분되며 옵션을 합치지 않는다', () => {
    const { workspace, project } = fixture({ code: '' })
    workspace.projects.push({ ...project, id: 'same-name-project' })
    const options = projectFilterOptions(workspace)
    expect(options.map(item => item.value)).toContain('same-name-project')
    expect(new Set(options.map(item => item.label)).size).toBe(2)
    expect(options.every(item => item.label.includes('ID '))).toBe(true)
    expect(projectFilterOptions(workspace, [project, project])).toHaveLength(1)
  })
  it('동일 필터 내 프로젝트는 OR이며 null 전체·빈 배열 전체 해제를 구분한다', () => {
    const styles = [{ id: 'a', projectId: 'A' }, { id: 'b', projectId: 'B' }, { id: 'c', projectId: 'C' }]
    expect(filterStylesByProjects(styles, ['A', 'B']).map(item => item.id)).toEqual(['a', 'b'])
    expect(filterStylesByProjects(styles, null)).toEqual(styles)
    expect(filterStylesByProjects(styles, [])).toEqual([])
    expect(matchesProjectSelection('A', ['B'])).toBe(false)
    expect(styles).toHaveLength(3)
  })
  it('명칭·코드·ID 기준 정렬은 기존 객체를 변경하지 않는다', () => {
    const { workspace, project } = fixture()
    workspace.projects.push({ ...project, id: 'second', name: '가나다 프로젝트' })
    expect(compareProjectIds(workspace, 'second', project.id)).toBeLessThan(0)
    expect(projectFilterOptions(workspace)[0].value).toBe('second')
  })
})

describe('기존 ID를 보존하는 오더 A/M/L 프로젝트 매핑 검토', () => {
  it('A열 코드가 명칭에 들어 있던 기존 프로젝트를 같은 ID로 복구 제안한다', () => {
    const { workspace, project, style } = fixture({ code: '', name: CODE }), before = structuredClone(workspace)
    const suggestion = buildProjectMappingSuggestions(workspace)[0]
    expect(suggestion).toMatchObject({ projectId: project.id, status: 'ready', expected: { code: '', name: CODE, season: '2026FY' }, proposed: { id: project.id, code: CODE, name: NAME, season: '2026FY' }, sources: [{ styleId: style.id, lineId: style.production[0].id, rowNumber: 2, fileName: '오더.xlsx' }] })
    expect(suggestion.reasons).toEqual([])
    expect(workspace).toEqual(before)
  })
  it('공식 명칭이 이미 있으면 유지하고 누락된 코드·시즌만 원본으로 제안한다', () => {
    const { workspace, project } = fixture({ code: '', season: '' })
    expect(buildProjectMappingSuggestions(workspace)[0]).toMatchObject({ status: 'ready', proposed: { id: project.id, code: CODE, name: NAME, season: '2026FY' } })
  })
  it('명칭이 비어 있어도 M열 공식 명칭을 명시적인 저장 후보로만 제공한다', () => {
    const { workspace, project } = fixture({ name: '' })
    expect(getProjectIdentity(workspace, project.id).name).toBe(CODE)
    expect(buildProjectMappingSuggestions(workspace)[0]).toMatchObject({ status: 'ready', proposed: { name: NAME } })
    expect(project.name).toBe('')
  })
  it('이미 정확한 매핑과 원본이 없는 프로젝트는 저장을 제안하지 않는다', () => {
    const { workspace } = fixture()
    expect(buildProjectMappingSuggestions(workspace)[0].status).toBe('unchanged')
    workspace.operations!.orderSourceRecords = []
    expect(buildProjectMappingSuggestions(workspace)[0].status).toBe('no_source')
  })
  it.each([
    { field: 'code', value: 'OTHER-PROJECT', reason: 'A열 코드가 다릅니다' },
    { field: 'name', value: '기존 공식 프로젝트 이름', reason: '공식 프로젝트 명칭' },
    { field: 'season', value: '2025FY', reason: 'L열 시즌이 다릅니다' },
  ])('기존 공식 $field 값과 원본이 충돌하면 이름을 바꾸지 않는다', ({ field, value, reason }) => {
    const { workspace, project } = fixture({ [field]: value })
    const result = buildProjectMappingSuggestions(workspace)[0]
    expect(result.status).toBe('conflict')
    expect(result.reasons.join(' ')).toContain(reason)
    expect(result.proposed).toEqual(project)
  })
  it('같은 프로젝트의 여러 원본이 다른 M열 명칭을 주장하면 임의로 선택하지 않는다', () => {
    const { workspace } = fixture({ code: '', name: CODE })
    workspace.operations!.orderSourceRecords.push(source(workspace, [CODE, '다른 프로젝트 명칭', '2026FY']))
    const result = buildProjectMappingSuggestions(workspace)[0]
    expect(result.status).toBe('conflict')
    expect(result.reasons.join()).toContain('서로 다릅니다')
  })
  it('다른 ID에 이미 같은 코드가 있으면 중복 프로젝트 코드를 제안하지 않는다', () => {
    const { workspace, project } = fixture({ code: '', name: CODE })
    workspace.projects.push({ ...project, id: 'other-id', code: CODE, name: NAME })
    const result = buildProjectMappingSuggestions(workspace).find(item => item.projectId === project.id)!
    expect(result.status).toBe('conflict')
    expect(result.reasons.join()).toContain('다른 프로젝트 ID')
  })
  it.each([null, '#REF!', true, '잘못된\n명칭'])('M열 누락·오류·비문자 값은 매핑하지 않는다: %j', value => {
    const { workspace } = fixture({ name: '' })
    workspace.operations!.orderSourceRecords[0].rows[0].columns.M = value
    expect(buildProjectMappingSuggestions(workspace)[0].status).toBe('conflict')
  })
  it('삭제된 스타일·다른 컬러·존재하지 않는 스타일의 원본을 현재 프로젝트에 연결하지 않는다', () => {
    const { workspace, style } = fixture({ name: '' })
    const original = workspace.operations!.orderSourceRecords[0]
    original.lineId = 'unregistered-line'
    expect(buildProjectMappingSuggestions(workspace)[0].status).toBe('no_source')
    original.lineId = style.production[0].id; original.styleId = 'unknown-style'
    expect(buildProjectMappingSuggestions(workspace)[0].status).toBe('no_source')
    original.styleId = style.id; style.deletedAt = '2026-10-30T00:00:00Z'
    expect(buildProjectMappingSuggestions(workspace)[0].status).toBe('no_source')
  })
})


describe('범위가 제한된 과거 발주의 프로젝트 표시', () => {
  it('현재 프로젝트 목록에 없는 과거 프로젝트는 이미 허용된 발주의 공식 명칭과 코드를 사용한다', () => {
    const workspace = { projects: [] }
    expect(getHistoricalProjectIdentity(workspace, 'historical-project', { name: '과거 공식 프로젝트 명칭', code: 'QA-PROJECT-B' })).toMatchObject({ id: 'historical-project', name: '과거 공식 프로젝트 명칭', code: 'QA-PROJECT-B', label: '과거 공식 프로젝트 명칭 · QA-PROJECT-B' })
    expect(workspace.projects).toEqual([])
    expect(getHistoricalProjectIdentity(workspace, 'historical-project', { code: 'QA-PROJECT-B' }).name).toBe('QA-PROJECT-B')
  })
  it('현재 공식 메타데이터가 있으면 발주 원본으로 덮어쓰지 않는다', () => {
    const workspace = { projects: [{ id: 'project', name: '현재 공식 명칭', code: 'CURRENT', season: '2026FY' }] }
    expect(getHistoricalProjectIdentity(workspace, 'project', { name: '과거 공식 명칭', code: 'OLD' })).toMatchObject({ name: '현재 공식 명칭', code: 'CURRENT' })
  })
  it('현재 명칭·코드가 누락된 경우 보존된 발주 코드로 표시하며 메타데이터를 저장하지 않는다', () => {
    const workspace = { projects: [{ id: 'project', name: '', code: '', season: '2026FY' }] }, before = structuredClone(workspace)
    expect(getHistoricalProjectIdentity(workspace, 'project', { name: '과거 명칭', code: 'FROZEN-CODE' })).toMatchObject({ name: 'FROZEN-CODE', code: 'FROZEN-CODE' })
    expect(workspace).toEqual(before)
  })
})
