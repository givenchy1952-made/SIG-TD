import type { Style, Workspace } from './types'
import { validateStyle } from './permissions'
import { planRegistrationFromRow, type RegistrationProject } from './order-registration'
import { buildOrderImportPreview, readSigRowSku, type ImportCell, type ImportSheet, type OrderImportOptions, type OrderImportPreview } from './order-import'

export interface BulkRegistrationOptions {
  defaults: { ownerId: string; dueDate: string }
  factoryMappings: Record<string, string>
  ownerMappings?: Record<string, string>
  automatic?: boolean
}
export interface BulkRegistrationEntry { style: Style; project: RegistrationProject }
export interface BulkRegistrationPlan {
  entries: BulkRegistrationEntry[]; prepared: Workspace; preview: OrderImportPreview; errors: string[]
  newStyleCount: number; newColorCount: number; projectCount: number
}
export interface SourceOwnerGroup { source: string; count: number; ownerId: string }
export interface SourceFactoryGroup { source: string; count: number; factoryId: string }
const text = (value: ImportCell | undefined) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
const companyKey = (value: string) => value.trim().toLocaleUpperCase('en-US').replace(/주식회사|\(\s*주\s*\)|㈜|\s+/g, '')
const projectState = (project: { code?: string; name: string; season: string }) => ({ code: project.code || '', name: project.name, season: project.season })
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

/** Names are suggestions only: unknown or ambiguous vendors remain unassigned. */
export function sourceFactoryGroups(workspace: Workspace, sheet: ImportSheet, headerRow: number, sigSkus?: Record<number, string>): SourceFactoryGroup[] {
  const groups = new Map<string, SourceFactoryGroup>()
  for (let index = headerRow; index < sheet.rows.length; index++) {
    const row = sheet.rows[index]
    if (!text(row[5]) && !sigSkus?.[index + 1]?.trim()) continue
    const source = text(row[22])
    const group = groups.get(source)
    if (group) group.count += 1
    else {
      const normalized = companyKey(source)
      const matches = normalized ? workspace.factories.filter(factory => companyKey(factory.name) === normalized) : []
      groups.set(source, { source, count: 1, factoryId: matches.length === 1 ? matches[0].id : '' })
    }
  }
  return [...groups.values()]
}

/** Each nonempty Y value must resolve to one approved HQ account. Empty Y
 * is intentionally omitted from mapping controls and remains unassigned. */
export function sourceOwnerGroups(workspace: Workspace, sheet: ImportSheet, headerRow: number, sigSkus?: Record<number, string>): SourceOwnerGroup[] {
  const groups = new Map<string, SourceOwnerGroup>()
  for (let index = headerRow; index < sheet.rows.length; index++) {
    const row = sheet.rows[index]
    if (!text(row[5]) && !sigSkus?.[index + 1]?.trim()) continue
    const source = text(row[24])
    if (!source) continue
    const group = groups.get(source)
    if (group) group.count += 1
    else {
      const normalized = source.toLocaleUpperCase('en-US')
      const matches = workspace.profiles.filter(profile => profile.role !== 'factory' && profile.active && profile.approved && !profile.withdrawnAt && [profile.name, profile.email].some(value => value.trim().toLocaleUpperCase('en-US') === normalized))
      groups.set(source, { source, count: 1, ownerId: matches.length === 1 ? matches[0].id : '' })
    }
  }
  return [...groups.values()]
}

/** Plan all metadata first. Persist each entry through the existing 005 RPC,
 * then rebuild quantity changes using the returned versions before 009 import.
 * This function never writes quantities, files, workspace storage, or accounts. */
export function buildBulkOrderRegistrationPlan(workspace: Workspace, sheet: ImportSheet, options: OrderImportOptions, settings: BulkRegistrationOptions, makeId = () => crypto.randomUUID()): BulkRegistrationPlan {
  const prepared = structuredClone(workspace), initial = buildOrderImportPreview(workspace, sheet, options)
  const errors: string[] = [], pending = new Map<string, { style: Style; project: RegistrationProject }>()
  const originalStyles = new Map(workspace.styles.map(style => [style.id, style]))
  const sourceFactories = new Map(sourceFactoryGroups(workspace, sheet, options.headerRow, options.sigSkus).map(group => [group.source, group.factoryId]))
  const selectedFactories = new Map<string, string>(), selectedProjects = new Map<string, string>()
  const finish = (): BulkRegistrationPlan => {
    const entries: BulkRegistrationEntry[] = []
    const expectedProjects = new Map(workspace.projects.map(project => [project.id, projectState(project)]))
    for (const item of pending.values()) {
      const expected = expectedProjects.get(item.project.id) || null
      const project = { ...item.project, expected }
      entries.push({ style: structuredClone(item.style), project })
      // 005 fills a missing code but otherwise leaves an existing project's
      // stored spelling/whitespace unchanged. Match that exact next snapshot.
      expectedProjects.set(project.id, expected ? { ...expected, code: expected.code.trim() ? expected.code : project.code.trim() } : { code: project.code.trim(), name: project.name.trim(), season: project.season.trim() })
    }
    const preview = buildOrderImportPreview(prepared, sheet, options)
    if (preview.changes.length > 500 || preview.changes.reduce((count, change) => count + change.lines.length, 0) > 1000) errors.push('한 번에 스타일 500개·컬러 1,000개 이하로 나누어 업로드해 주세요.')
    return {
      entries, prepared, preview, errors: [...new Set([...errors, ...preview.errors, ...preview.rows.flatMap(row => row.errors)])],
      newStyleCount: entries.filter(entry => !originalStyles.has(entry.style.id)).length,
      newColorCount: entries.reduce((count, entry) => count + entry.style.production.filter(line => !originalStyles.get(entry.style.id)?.production.some(old => old.id === line.id)).length, 0),
      projectCount: new Set(entries.map(entry => entry.project.id)).size,
    }
  }
  if (options.preset !== 'sig-order-qty') { errors.push('일괄 품번 등록은 SIG ORDER QTY 형식에서 사용할 수 있습니다.'); return finish() }
  if (initial.errors.length) { errors.push(...initial.errors); return finish() }
  const rowNumbers = [...new Set(initial.rows.flatMap(row => row.rowNumbers))].sort((left, right) => left - right)
  for (const rowNumber of rowNumbers) {
    const source = sheet.rows[rowNumber - 1], sourceFactory = text(source[22])
    const factoryId = Object.hasOwn(settings.factoryMappings, sourceFactory) ? settings.factoryMappings[sourceFactory] : sourceFactories.get(sourceFactory) || ''
    let fullSku: string
    try { fullSku = readSigRowSku(source, options.sigSkus?.[rowNumber], options.sigBudgetFallback) }
    catch (failure) { errors.push(`${rowNumber}행: ${failure instanceof Error ? failure.message : String(failure)}`); continue }
    const plan = planRegistrationFromRow(prepared, sheet, options.headerRow, rowNumber, { factoryId, ...settings.defaults, ownerMappings: settings.ownerMappings, allowMissingDueDate: settings.automatic === true }, makeId, options.sigColors?.[rowNumber], fullSku)
    if (!plan.style || !plan.project) { errors.push(...plan.errors.map(error => `${rowNumber}행: ${error}`)); continue }
    const style = plan.style, matchedProject = prepared.projects.find(project => project.id === plan.project!.id)
    const project = matchedProject?.code?.trim() ? { ...plan.project, code: matchedProject.code } : plan.project
    const original = originalStyles.get(style.id)
    // A staged style already exists in prepared on its second color, but it is
    // still a new registration and each source vendor must agree with its ACL.
    if (!original) {
      style.factoryId = factoryId
      if (!prepared.factories.some(factory => factory.id === factoryId)) errors.push(`${rowNumber}행 ${fullSku}: W열 생산처에 등록된 담당 공장을 선택해 주세요.`)
      const previous = selectedFactories.get(style.id)
      if (previous && previous !== factoryId) errors.push(`${rowNumber}행 ${fullSku}: 같은 기본 품번의 컬러별 담당 공장이 다릅니다. 생산처 배정을 확인해 주세요.`)
      selectedFactories.set(style.id, previous || factoryId)
      if (!validDate(style.dueDate) && !(settings.automatic === true && style.dueDate === '')) errors.push(`${rowNumber}행 ${fullSku}: 파일에 입고예정일이 없으므로 신규 품번의 기준 납기일을 선택해 주세요.`)
    }
    const previousProject = selectedProjects.get(style.id)
    if (previousProject && previousProject !== project.id) errors.push(`${rowNumber}행 ${fullSku}: 같은 기본 품번에 서로 다른 프로젝트가 있습니다. 프로젝트별로 나누어 업로드해 주세요.`)
    selectedProjects.set(style.id, previousProject || project.id)
    try { validateStyle(style) } catch (failure) { errors.push(`${rowNumber}행 ${fullSku}: ${failure instanceof Error ? failure.message : String(failure)}`) }
    // Preserve valid row-level errors (for example an invalid source owner or
    // date). Our explicit factory mapping supersedes only its original lookup.
    errors.push(...plan.errors.filter(error => !error.includes('등록된 담당 공장을 선택')).map(error => `${rowNumber}행 ${fullSku}: ${error}`))
    const { expected: _expected, ...plainProject } = project
    prepared.projects = [...prepared.projects.filter(item => item.id !== project.id), plainProject]
    prepared.styles = [...prepared.styles.filter(item => item.id !== style.id), style]
    if (!original || JSON.stringify(style) !== JSON.stringify(original)) pending.set(style.id, { style, project })
  }
  return finish()
}
