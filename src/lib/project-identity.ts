import type { Project, Style, Workspace } from './types'

export type ProjectSelection = readonly string[] | null
type ProjectWorkspace = Pick<Workspace, 'projects'>

export interface ProjectIdentity {
  id: string
  /** The official project name, with its existing code as the legacy fallback. */
  name: string
  code: string
  season: string
  label: string
  searchText: string
}

const clean = (value: string | null | undefined) => (value || '').trim()
const codeKey = (value: string) => clean(value).toLocaleUpperCase('en-US')

/** Read-only identity lookup. Style names and imported free text never become
 * display names until an administrator explicitly saves project metadata. */
export function getProjectIdentity(workspace: ProjectWorkspace, projectId: string): ProjectIdentity {
  const project = workspace.projects.find(item => item.id === projectId)
  const code = clean(project?.code), officialName = clean(project?.name), season = clean(project?.season)
  const name = officialName || code || '프로젝트 미지정'
  const label = code && codeKey(code) !== codeKey(name) ? `${name} · ${code}` : name
  return { id: projectId, name, code, season, label, searchText: `${officialName} ${code} ${season}`.toLocaleLowerCase() }
}

/** A scoped historical order can already contain its official project name and
 * frozen code even when that project's metadata is outside the current list.
 * Reuse only those existing fields; never expand the workspace's project scope. */
export function getHistoricalProjectIdentity(workspace: ProjectWorkspace, projectId: string, snapshot: { name?: string; code?: string; season?: string }): ProjectIdentity {
  const current = workspace.projects.find(project => project.id === projectId)
  if (current) return getProjectIdentity({ projects: [{ ...current, code: clean(current.code) || clean(snapshot.code) }] }, projectId)
  return getProjectIdentity({ projects: [{ id: projectId, name: clean(snapshot.name), code: clean(snapshot.code), season: clean(snapshot.season) }] }, projectId)
}

/** IDs are the selection key even when names and codes happen to be equal. */
export function projectFilterOptions(workspace: ProjectWorkspace, projects: readonly Project[] = workspace.projects): { value: string; label: string }[] {
  const choices = [...new Map(projects.map(project => [project.id, project])).values()]
    .map(project => getProjectIdentity(workspace, project.id))
  const labelCounts = new Map<string, number>()
  choices.forEach(item => labelCounts.set(item.label, (labelCounts.get(item.label) || 0) + 1))
  const collator = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' })
  return choices.map(item => ({
    value: item.id,
    // An entire ID is intentionally retained when metadata cannot distinguish
    // projects; a shared UUID suffix would otherwise still be ambiguous.
    label: (labelCounts.get(item.label) || 0) > 1 ? `${item.label} · ID ${item.id}` : item.label,
  })).sort((left, right) => collator.compare(left.label, right.label) || left.value.localeCompare(right.value))
}

export function matchesProjectSelection(projectId: string, selection: ProjectSelection): boolean {
  return selection === null || selection.includes(projectId)
}

export function filterStylesByProjects<T extends Pick<Style, 'projectId'>>(styles: readonly T[], selection: ProjectSelection): T[] {
  return styles.filter(style => matchesProjectSelection(style.projectId, selection))
}

export function compareProjectIds(workspace: ProjectWorkspace, leftId: string, rightId: string): number {
  const left = getProjectIdentity(workspace, leftId), right = getProjectIdentity(workspace, rightId)
  return left.name.localeCompare(right.name, 'ko-KR', { numeric: true }) || left.code.localeCompare(right.code, 'ko-KR', { numeric: true }) || left.id.localeCompare(right.id)
}

export interface ProjectMappingSource { styleId: string; lineId: string; rowNumber: number; fileName: string }
export interface ProjectMappingSuggestion {
  projectId: string
  status: 'ready' | 'unchanged' | 'conflict' | 'no_source'
  expected: { code: string; name: string; season: string }
  proposed: Project
  sources: ProjectMappingSource[]
  reasons: string[]
}
interface SourceMetadata { code: string; name: string; season: string; source: ProjectMappingSource; error?: string }
const excelError = /^#(?:REF!|NAME\?|VALUE!|DIV\/0!|N\/A|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$/i

function sourceText(value: unknown, limit: number): string | null {
  if (value == null) return ''
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).trim()
  return text.length > limit || /[\x00-\x1f\x7f]/.test(text) || excelError.test(text) ? null : text
}

/** Propose existing-ID metadata repairs from authoritative A/M/L source cells.
 * Merely reading this plan never renames projects or changes style links. */
export function buildProjectMappingSuggestions(workspace: Pick<Workspace, 'projects' | 'styles' | 'operations'>): ProjectMappingSuggestion[] {
  const sourcesByProject = new Map<string, SourceMetadata[]>()
  for (const record of workspace.operations?.orderSourceRecords || []) {
    const style = workspace.styles.find(item => item.id === record.styleId && !item.deletedAt)
    if (!style || !style.production.some(line => line.id === record.lineId) || !workspace.projects.some(project => project.id === style.projectId)) continue
    for (const row of record.rows) {
      const code = sourceText(row.columns.A, 120), name = sourceText(row.columns.M, 160), season = sourceText(row.columns.L, 30)
      if (code === '' && name === '' && season === '') continue
      const item: SourceMetadata = {
        code: code || '', name: name || '', season: season || '',
        source: { styleId: style.id, lineId: record.lineId, rowNumber: row.rowNumber, fileName: record.fileName },
        ...(!code || !name || !season ? { error: '오더 원본의 A열 코드·M열 명칭·L열 시즌을 모두 확인해 주세요.' } : {}),
      }
      const group = sourcesByProject.get(style.projectId) || []
      group.push(item); sourcesByProject.set(style.projectId, group)
    }
  }
  return workspace.projects.map(project => {
    const expected = { code: project.code || '', name: project.name, season: project.season }
    const items = sourcesByProject.get(project.id) || []
    const suggestion: ProjectMappingSuggestion = { projectId: project.id, status: 'no_source', expected, proposed: { ...project }, sources: items.map(item => item.source), reasons: [] }
    if (!items.length) return suggestion
    const reasons = new Set(items.flatMap(item => item.error ? [item.error] : []))
    const unique = new Map(items.filter(item => !item.error).map(item => [JSON.stringify([codeKey(item.code), item.name, item.season]), item]))
    if (unique.size !== 1) reasons.add('같은 프로젝트에 연결된 오더 원본의 코드·명칭·시즌이 서로 다릅니다.')
    const original = unique.values().next().value as SourceMetadata | undefined
    if (original) {
      const code = clean(project.code), name = clean(project.name), season = clean(project.season)
      if (code && codeKey(code) !== codeKey(original.code)) reasons.add('기존 프로젝트 코드와 오더 원본 A열 코드가 다릅니다.')
      const placeholder = !!name && (codeKey(name) === codeKey(code || original.code))
      if (name && !placeholder && name !== original.name) reasons.add('등록된 공식 프로젝트 명칭과 오더 원본 M열 명칭이 다릅니다.')
      if (season && season !== original.season) reasons.add('기존 프로젝트 시즌과 오더 원본 L열 시즌이 다릅니다.')
      if (workspace.projects.some(item => item.id !== project.id && clean(item.code) && codeKey(item.code!) === codeKey(original.code))) reasons.add('원본 A열 코드가 다른 프로젝트 ID에도 등록되어 있습니다.')
      if (!reasons.size) {
        suggestion.proposed = { ...project, code: code || original.code, name: !name || placeholder ? original.name : project.name, season: season || original.season }
        suggestion.status = ['code', 'name', 'season'].some(key => (suggestion.proposed[key as keyof Project] || '') !== expected[key as keyof typeof expected]) ? 'ready' : 'unchanged'
      }
    }
    if (reasons.size) { suggestion.status = 'conflict'; suggestion.reasons = [...reasons] }
    return suggestion
  })
}
