import { blankProduction, type Project, type Style, type Workspace } from './types'
import type { ImportCell, ImportSheet } from './order-import'

export interface RegistrationProject extends Project { code: string; expected: { code: string; name: string; season: string } | null }
export interface RegistrationDefaults { factoryId: string; ownerId: string; dueDate: string }
export interface OrderRegistrationPlan { style: Style | null; project: RegistrationProject | null; isNewProject: boolean; isNewStyle: boolean; isNewColor: boolean; fullSku: string; color: string; errors: string[]; sourceFactory: string; sourceOwner: string }
const key = (value: string) => value.trim().toLocaleUpperCase('en-US')
const excelError = /^#(?:REF!|NAME\?|VALUE!|DIV\/0!|N\/A|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$/i
function literal(cell: ImportCell | undefined, label: string): string {
  if (cell == null) return ''
  if (typeof cell === 'object' || typeof cell === 'boolean') throw new Error(`${label} 값을 확인해 주세요.`)
  const value = String(cell).trim()
  if (excelError.test(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label}의 오류·제어 문자를 수정해 주세요.`)
  return value
}
/** F is the only style/color identity. Column I is deliberately never read. */
export function planRegistrationFromRow(workspace: Workspace, sheet: ImportSheet, headerRow: number, rowNumber: number, defaults: RegistrationDefaults, makeId = () => crypto.randomUUID()): OrderRegistrationPlan {
  const result: OrderRegistrationPlan = { style: null, project: null, isNewProject: false, isNewStyle: false, isNewColor: false, fullSku: '', color: '', errors: [], sourceFactory: '', sourceOwner: '' }
  try {
    if (!Number.isInteger(headerRow) || !Number.isInteger(rowNumber) || headerRow < 1 || rowNumber <= headerRow || rowNumber > sheet.rows.length) throw new Error('등록할 원본 데이터 행을 확인해 주세요.')
    const row = sheet.rows[rowNumber - 1]
    const fullSku = literal(row[5], 'F열 품번').toUpperCase()
    if (!/^[A-Z0-9_-]{1,60}[A-Z]{2}$/.test(fullSku)) throw new Error('F열에는 기본 품번과 영문 두 자리 컬러가 붙은 품번을 입력해 주세요.')
    const code = fullSku.slice(0, -2), color = fullSku.slice(-2)
    result.fullSku = fullSku; result.color = color
    const projectCode = literal(row[0], 'A열 프로젝트 코드'), projectName = literal(row[12], 'M열 프로젝트 명칭'), season = literal(row[11], 'L열 시즌')
    if (!projectCode || projectCode.length > 120 || !projectName || projectName.length > 160 || !season || season.length > 30) throw new Error('A열 프로젝트 코드·M열 프로젝트 명칭·L열 시즌을 확인해 주세요.')
    result.sourceFactory = literal(row[22], 'W열 생산처'); result.sourceOwner = literal(row[24], 'Y열 담당자')
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
    if (!matches.length && workspace.styles.some(style => !style.deletedAt && key(style.code) === key(fullSku))) throw new Error(`이미 등록된 스타일 품번에 컬러 ${color}가 포함되어 있습니다. 해당 스타일의 기본 품번을 ${code}로 먼저 수정해 주세요.`)
    const existing = matches[0]
    if (existing) {
      const style = structuredClone(existing)
      style.projectId = plannedProject.id; style.season = plannedProject.season
      result.isNewColor = !style.production.some(line => line.color === color)
      if (result.isNewColor) { style.colors.push(color); style.production.push(blankProduction(color)) }
      result.style = style
    } else {
      result.isNewStyle = true; result.isNewColor = true
      const factories = workspace.factories.filter(item => key(item.name) === key(result.sourceFactory))
      const owners = workspace.profiles.filter(item => item.role !== 'factory' && item.approved && item.active && key(item.name) === key(result.sourceOwner))
      const factoryId = factories.length === 1 ? factories[0].id : defaults.factoryId
      const ownerId = owners.length === 1 ? owners[0].id : defaults.ownerId
      result.style = { id: makeId(), code, name: code, category: '', season, projectId: plannedProject.id, factoryId, ownerId, colors: [color], dueDate: defaults.dueDate, stage: 'registered', ppApproved: false, notes: '', samples: [], production: [blankProduction(color)], version: 0, updatedAt: '', updatedBy: ownerId, deletedAt: null }
      if (!workspace.factories.some(item => item.id === factoryId)) result.errors.push('등록된 담당 공장을 선택해 주세요. 파일의 생산처를 임의로 새 공장으로 만들지 않습니다.')
      if (!workspace.profiles.some(item => item.id === ownerId && item.role !== 'factory' && item.approved && item.active)) result.errors.push('승인된 본사 담당자를 선택해 주세요.')
      const due = defaults.dueDate
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(`${due}T00:00:00Z`)) || new Date(`${due}T00:00:00Z`).toISOString().slice(0, 10) !== due) result.errors.push('신규 스타일의 기준 납기일을 직접 선택해 주세요. 발주 요청일을 납기로 대신 사용하지 않습니다.')
    }
  } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); result.style = null }
  return result
}
