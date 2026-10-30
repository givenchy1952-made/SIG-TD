import type { SupabaseClient } from '@supabase/supabase-js'
import type { Profile, Project } from './types'
import type { ProjectMappingSuggestion } from './project-identity'
import { assertActive } from './permissions'
import { getDemoWorkspace, locked, persist, supabase } from './repository'

export type ProjectMappingExpected = ProjectMappingSuggestion['expected']
const conflict = () => new Error('프로젝트 정보가 변경되었습니다. 최신 프로젝트와 오더 원본을 다시 확인해 주세요.')

function mappingValues(project: Project) {
  const values = { code: (project.code || '').trim(), name: project.name.trim(), season: project.season.trim() }
  if (!project.id || !values.code || values.code.length > 120 || !values.name || values.name.length > 160 || !values.season || values.season.length > 30 || Object.values(values).some(value => /[\x00-\x1f\x7f]/.test(value))) throw new Error('오더 원본의 프로젝트 코드·명칭·시즌을 확인해 주세요.')
  return values
}

/** Conditional update only: this path can neither create a project nor change
 * its ID, and refuses a concurrent administrator's metadata change. RLS keeps
 * the existing administrator-only write permission authoritative. */
export async function updateProjectMapping(client: SupabaseClient, project: Project, expected: ProjectMappingExpected): Promise<void> {
  const result = await client.from('projects').update(mappingValues(project)).eq('id', project.id)
    .eq('code', expected.code).eq('name', expected.name).eq('season', expected.season).select('id')
  if (result.error) throw result.error
  if (!result.data || result.data.length !== 1 || result.data[0].id !== project.id) throw conflict()
}

export async function saveProjectMapping(project: Project, expected: ProjectMappingExpected, profile: Profile): Promise<void> {
  assertActive(profile)
  if (profile.role !== 'admin') throw new Error('프로젝트 매핑은 관리자만 보완할 수 있습니다.')
  const values = mappingValues(project)
  if (supabase) { await updateProjectMapping(supabase, project, expected); return }
  await locked(() => {
    const workspace = getDemoWorkspace(), actor = workspace.profiles.find(item => item.id === profile.id)
    if (!actor?.active || !actor.approved || actor.role !== 'admin') throw new Error('프로젝트 매핑은 승인된 관리자만 보완할 수 있습니다.')
    const before = workspace.projects.find(item => item.id === project.id)
    if (!before || (before.code || '') !== expected.code || before.name !== expected.name || before.season !== expected.season) throw conflict()
    workspace.projects = workspace.projects.map(item => item.id === before.id ? { ...item, ...values } : item)
    persist(workspace)
  })
}
