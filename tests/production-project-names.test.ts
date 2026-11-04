import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadProductionProjectNames } from '../src/lib/production-project-names-repository'
import { getProjectIdentity } from '../src/lib/project-identity'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { EMPTY_OPERATIONS, ORDER_SOURCE_COLUMNS } from '../src/lib/operations-types'
import type { OrderSourceCell, OrderSourceColumn } from '../src/lib/operations-types'
import { scopeWorkspace } from '../src/lib/utils'

const id = 'project-existing', code = 'SIGNIFICANT-2026FY-MPQ-46093', name = '시그니피컨트 2026 3Q'
function client(pages: unknown[][], error: unknown = null) {
  const rpc = vi.fn(() => ({ range: async (offset: number) => ({ data: pages[offset / 500] || [], error }) }))
  return { value: { rpc } as unknown as SupabaseClient, rpc }
}
describe('업체용 읽기 전용 프로젝트 명칭', () => {
  it('019 미설치는 기존 업무를 유지하며 명칭을 추측하지 않는다', async () => {
    expect(await loadProductionProjectNames(client([], { code: 'PGRST202' }).value)).toEqual({ productionProjectNames: [] })
    const failure = { code: '42501', message: 'permission denied' }
    await expect(loadProductionProjectNames(client([], failure).value)).rejects.toEqual(failure)
  })
  it('허용된 명칭의 전체 페이지를 읽고 원본·A열 조회를 요청하지 않는다', async () => {
    const row = { projectId: id, name, season: '2026FY' }, c = client([Array.from({ length: 500 }, () => row), [row]])
    const result = await loadProductionProjectNames(c.value)
    expect(result.productionProjectNames).toHaveLength(501)
    expect(c.rpc.mock.calls.every(args => args[0] === 'get_production_project_names')).toBe(true)
  })
  it('업체가 원본을 볼 수 없어도 같은 기존 ID의 검증된 M명칭을 표시하며 쓰지 않는다', () => {
    const workspace = { projects: [{ id, code, name: code, season: '2026FY' }], productionProjectNames: [{ projectId: id, name, season: '2026FY' }] }, before = structuredClone(workspace)
    expect(getProjectIdentity(workspace, id)).toMatchObject({ id, code, name, hasOfficialName: true })
    expect(workspace).toEqual(before)
  })
  it('등록된 공식 명칭을 투영값으로 바꾸거나 다른 ID를 프로젝트 목록에 추가하지 않는다', () => {
    const workspace = { projects: [{ id, code, name: '기존 공식 명칭', season: '2026FY' }], productionProjectNames: [{ projectId: id, name, season: '2026FY' }, { projectId: 'foreign', name: '다른 프로젝트', season: '2026FY' }] }
    expect(getProjectIdentity(workspace, id).name).toBe('기존 공식 명칭')
    expect(getProjectIdentity(workspace, 'foreign').hasOfficialName).toBe(false)
  })
  it('공장 화면 범위를 만들 때 원본을 숨기면서 배정 프로젝트 M명칭만 보존한다', () => {
    const workspace = createSeed(), factory = workspace.profiles.find(item => item.id === DEMO_IDS.factory)!, style = workspace.styles.find(item => item.factoryId === factory.factoryId)!
    workspace.styles = [style]
    const project = workspace.projects.find(item => item.id === style.projectId)!
    project.name = code; project.code = code; project.season = '2026FY'
    workspace.operations = structuredClone(EMPTY_OPERATIONS)
    workspace.operations.orderSourceRecords.push({ styleId: style.id, lineId: style.production[0].id, fileName: '가상.csv', sheetName: 'CSV', headers: Object.fromEntries(ORDER_SOURCE_COLUMNS.map(column => [column, column])) as Record<OrderSourceColumn, string>, rows: [{ rowNumber: 2, columns: Object.fromEntries(ORDER_SOURCE_COLUMNS.map(column => [column, column === 'A' ? code : column === 'M' ? name : column === 'L' ? '2026FY' : null])) as Record<OrderSourceColumn, OrderSourceCell> }], version: 1, createdAt: '', updatedAt: '', updatedBy: DEMO_IDS.admin })
    const before = structuredClone(workspace), scoped = scopeWorkspace(workspace, factory)
    expect(scoped.operations?.orderSourceRecords).toEqual([])
    expect(scoped.productionProjectNames).toEqual([{ projectId: project.id, name, season: '2026FY' }])
    expect(getProjectIdentity(scoped, project.id).name).toBe(name)
    expect(workspace).toEqual(before)
  })
  it.each([{ name: code, season: '2026FY' }, { name: 'SIGNIFICANT-2026FY-RPQ-99999', season: '2026FY' }, { name: '잘못\n명칭', season: '2026FY' }, { name: '#REF!', season: '2026FY' }, { name, season: '2027FY' }])('예산 코드·잘못된 명칭·시즌 충돌은 표시용 복원에 사용하지 않는다: %j', projected => {
    const workspace = { projects: [{ id, code, name: code, season: '2026FY' }], productionProjectNames: [{ projectId: id, ...projected }] }
    expect(getProjectIdentity(workspace, id)).toMatchObject({ name: '프로젝트 명칭 미등록', hasOfficialName: false })
  })
})
