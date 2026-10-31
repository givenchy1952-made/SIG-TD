import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSeed } from '../src/lib/seed'
const storage = vi.hoisted(() => ({ workspace: null as unknown, persisted: null as unknown }))
vi.mock('../src/lib/repository', () => ({ supabase: null, getDemoWorkspace: () => structuredClone(storage.workspace), locked: async (fn: () => unknown) => fn(), persist: (workspace: unknown) => { storage.persisted = workspace } }))
import { saveProjectMapping, updateProjectMapping } from '../src/lib/project-mapping-repository'

const expected = { code: '', name: 'PROJECT-CODE', season: '2026FY' }
const project = { id: 'existing-project-id', code: 'PROJECT-CODE', name: '시그니피컨트 공식 명칭', season: '2026FY' }
function client(data: { id: string }[] | null, error: unknown = null) {
  const eq = vi.fn().mockReturnThis(), update = vi.fn().mockReturnThis(), select = vi.fn(async () => ({ data, error }))
  const from = vi.fn(() => ({ eq, update, select }))
  return { value: { from } as unknown as SupabaseClient, from, eq, update, select }
}

describe('기존 프로젝트 매핑의 조건부 보완', () => {
  beforeEach(() => { storage.workspace = createSeed(); storage.persisted = null })
  it('같은 ID와 이전 코드·명칭·시즌을 모두 조건에 넣고 세 메타데이터만 갱신한다', async () => {
    const mock = client([{ id: project.id }])
    await updateProjectMapping(mock.value, project, expected)
    expect(mock.from).toHaveBeenCalledWith('projects')
    expect(mock.update).toHaveBeenCalledWith({ code: project.code, name: project.name, season: project.season })
    expect(mock.eq.mock.calls).toEqual([['id', project.id], ['code', expected.code], ['name', expected.name], ['season', expected.season]])
    expect(mock.select).toHaveBeenCalledWith('id')
  })
  it('일치하는 기존 행이 없으면 새 프로젝트를 생성하지 않고 충돌로 안내한다', async () => {
    await expect(updateProjectMapping(client([]).value, project, expected)).rejects.toThrow(/변경되었습니다/)
  })
  it('RLS 접근 거부를 충돌이나 성공으로 숨기지 않는다', async () => {
    const denied = { code: '42501', message: 'permission denied' }
    await expect(updateProjectMapping(client(null, denied).value, project, expected)).rejects.toEqual(denied)
  })
  it('체험 저장도 기존 ID만 보완하고 스타일 연결·생산·사용자·변경 이력은 보존한다', async () => {
    const workspace = createSeed(), before = structuredClone(workspace), target = workspace.projects[0], admin = workspace.profiles.find(item => item.role === 'admin')!
    storage.workspace = workspace
    await saveProjectMapping({ ...target, code: 'QA-PROJECT-CODE', name: '보완한 공식 프로젝트 명칭' }, { code: target.code || '', name: target.name, season: target.season }, admin)
    const after = storage.persisted as typeof workspace
    expect(after.projects).toHaveLength(before.projects.length)
    expect(after.projects[0]).toMatchObject({ id: target.id, code: 'QA-PROJECT-CODE', name: '보완한 공식 프로젝트 명칭' })
    expect({ ...after, projects: before.projects }).toEqual(before)
  })
  it('체험 저장에서 메타데이터 충돌과 실제 공장 계정의 역할 위조를 차단한다', async () => {
    const workspace = createSeed(), target = workspace.projects[0], factory = workspace.profiles.find(item => item.role === 'factory')!
    storage.workspace = workspace
    await expect(saveProjectMapping({ ...target, code: 'QA-PROJECT-CODE' }, { code: '', name: '오래된 명칭', season: target.season }, workspace.profiles.find(item => item.role === 'admin')!)).rejects.toThrow(/변경되었습니다/)
    await expect(saveProjectMapping({ ...target, code: 'QA-PROJECT-CODE' }, { code: target.code || '', name: target.name, season: target.season }, { ...factory, role: 'admin' })).rejects.toThrow(/승인된 관리자/)
    expect(storage.persisted).toBeNull()
  })
})
