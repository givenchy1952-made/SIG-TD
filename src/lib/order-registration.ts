import { blankProduction, type Project, type Style, type Workspace } from './types'
import { resolveSigOrderIdentity, type ImportCell, type ImportSheet } from './order-import'

export interface RegistrationProject extends Project { code: string; expected: { code: string; name: string; season: string } | null }
export interface RegistrationDefaults { factoryId: string; ownerId: string; dueDate: string; allowMissingDueDate?: boolean; ownerMappings?: Record<string, string> }
export interface OrderRegistrationPlan { style: Style | null; project: RegistrationProject | null; isNewProject: boolean; isNewStyle: boolean; isNewColor: boolean; fullSku: string; color: string; errors: string[]; sourceFactory: string; sourceOwner: string; dueDateSource?: string }
const key = (value: string) => value.trim().toLocaleUpperCase('en-US')
const companyKey = (value: string) => key(value).replace(/\s+/g, '').replaceAll('㈜', '(주)')
const excelError = /^#(?:REF!|NAME\?|VALUE!|DIV\/0!|N\/A|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$/i
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value
}
function expectedArrivalDate(sheet: ImportSheet, headerRow: number, row: ImportCell[]): string | null {
  const header = sheet.rows[headerRow - 1]?.[40]
  if (typeof header !== 'string' || header.replace(/[\s_\-./()\[\]]/g, '') !== '입고예정일') return null
  const value = typeof row[40] === 'string' ? row[40].trim() : ''
  return validDate(value) ? value : null
}
function literal(cell: ImportCell | undefined, label: string): string {
  if (cell == null) return ''
  if (typeof cell === 'object' || typeof cell === 'boolean') throw new Error(`${label} 값을 확인해 주세요.`)
  const value = String(cell).trim()
  if (excelError.test(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label}의 오류·제어 문자를 수정해 주세요.`)
  return value
}
/** F is the style identity. A base-only F may use an explicit user-selected
 * color or its sole registered production color. Column I is never read. */
export function planRegistrationFromRow(workspace: Workspace, sheet: ImportSheet, headerRow: number, rowNumber: number, defaults: RegistrationDefaults, makeId = () => crypto.randomUUID(), selectedColor?: string, fullSkuOverride?: string): OrderRegistrationPlan {
  const result: OrderRegistrationPlan = { style: null, project: null, isNewProject: false, isNewStyle: false, isNewColor: false, fullSku: '', color: '', errors: [], sourceFactory: '', sourceOwner: '' }
  try {
    if (!Number.isInteger(headerRow) || !Number.isInteger(rowNumber) || headerRow < 1 || rowNumber <= headerRow || rowNumber > sheet.rows.length) throw new Error('등록할 원본 데이터 행을 확인해 주세요.')
    const row = sheet.rows[rowNumber - 1]
    if (typeof row[5] !== 'string') throw new Error('F열 품번은 문자로 입력해 주세요.')
    const rawSku = literal(row[5], 'F열 품번').toUpperCase()
    const { base: code, color, fullSku } = resolveSigOrderIdentity(workspace, fullSkuOverride ?? rawSku, selectedColor)
    result.fullSku = fullSku; result.color = color
    const projectCode = literal(row[0], 'A열 프로젝트 코드'), projectName = literal(row[12], 'M열 프로젝트 명칭'), season = literal(row[11], 'L열 시즌')
    if (!projectCode || projectCode.length > 120 || !projectName || projectName.length > 160 || !season || season.length > 30) throw new Error('A열 프로젝트 코드·M열 프로젝트 명칭·L열 시즌을 확인해 주세요.')
    result.sourceFactory = literal(row[22], 'W열 생산처'); result.sourceOwner = literal(row[24], 'Y열 담당자')
    // Y is authoritative. Blank cells remain unassigned; neither the uploader
    // nor a bulk default may silently become the owner.
    const eligibleOwners = workspace.profiles.filter(item => item.role !== 'factory' && item.approved && item.active && !item.withdrawnAt)
    const ownerMatches = result.sourceOwner ? eligibleOwners.filter(item => key(item.name) === key(result.sourceOwner) || key(item.email) === key(result.sourceOwner)) : []
    const mappedOwner = result.sourceOwner && Object.hasOwn(defaults.ownerMappings || {}, result.sourceOwner) ? defaults.ownerMappings![result.sourceOwner] : undefined
    const ownerId = !result.sourceOwner ? '' : mappedOwner !== undefined ? mappedOwner : ownerMatches.length === 1 ? ownerMatches[0].id : ''
    if (result.sourceOwner && !eligibleOwners.some(item => item.id === ownerId)) result.errors.push(`Y열 담당자 '${result.sourceOwner}'를 승인된 본사 구성원 한 명과 연결해 주세요.`)
    const codeMatches = workspace.projects.filter(project => !!project.code?.trim() && key(project.code) === key(projectCode))
    if (codeMatches.length > 1) throw new Error('동일 프로젝트 코드가 여러 번 등록되어 있습니다. 프로젝트 관리에서 확인해 주세요.')
    let project: Project | undefined = codeMatches[0]
    if (project && (project.name.trim() !== projectName || project.season.trim() !== season)) throw new Error('A열 프로젝트 코드에 등록된 명칭·시즌이 M·L열과 다릅니다. 기존 프로젝트를 먼저 확인해 주세요.')
    if (!project) {
      // Separate MPQ/RPQ project codes may share a descriptive M name.
      // Only a uniquely matching legacy project with no code can be adopted.
      const matches = workspace.projects.filter(item => !item.code?.trim() && item.name.trim() === projectName && item.season.trim() === season)
      if (matches.length > 1) throw new Error('코드가 없는 동일 명칭·시즌 프로젝트가 여러 개입니다. 프로젝트 관리에서 먼저 구분해 주세요.')
      project = matches[0]
    }
    const plannedProject: RegistrationProject = { id: project?.id || makeId(), code: projectCode, name: projectName, season, expected: project ? { code: project.code || '', name: project.name, season: project.season } : null }
    result.project = plannedProject; result.isNewProject = !project
    const matches = workspace.styles.filter(style => !style.deletedAt && key(style.code) === key(code))
    if (matches.length > 1) throw new Error('F열 기본 품번과 일치하는 스타일이 여러 개입니다. 기본 품번을 확인해 주세요.')
    const existing = matches[0]
    if (existing) {
      const style = structuredClone(existing)
      style.projectId = plannedProject.id; style.season = plannedProject.season
      result.isNewColor = !style.production.some(line => line.color === color)
      if (result.isNewColor) { style.colors.push(color); style.production.push(blankProduction(color)) }
      style.production.find(line => line.color === color)!.ownerId = ownerId
      result.style = style
    } else {
      result.isNewStyle = true; result.isNewColor = true
      const factories = workspace.factories.filter(item => companyKey(item.name) === companyKey(result.sourceFactory))
      const factoryId = factories.length === 1 ? factories[0].id : defaults.factoryId
      const arrivalDate = expectedArrivalDate(sheet, headerRow, row)
      const dueDate = arrivalDate ?? defaults.dueDate
      if (arrivalDate) result.dueDateSource = 'AO열 입고예정일'
      result.style = { id: makeId(), code, name: code, category: '', season, projectId: plannedProject.id, factoryId, ownerId, colors: [color], dueDate, stage: 'registered', ppApproved: false, notes: '', samples: [], production: [{ ...blankProduction(color), ownerId }], version: 0, updatedAt: '', updatedBy: ownerId, deletedAt: null }
      if (!workspace.factories.some(item => item.id === factoryId)) result.errors.push('등록된 담당 공장을 선택해 주세요. 파일의 생산처를 임의로 새 공장으로 만들지 않습니다.')
      if (!validDate(dueDate) && !(defaults.allowMissingDueDate === true && dueDate === '')) result.errors.push('신규 스타일의 기준 납기일을 직접 선택해 주세요. 발주 요청일을 납기로 대신 사용하지 않습니다.')
    }
  } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); result.style = null }
  return result
}
