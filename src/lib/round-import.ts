import type { OrderImportChange } from './operations-types'
import type { Profile, Project, Workspace } from './types'
import { importOrdersInWorkspace } from './operations-domain'
import { saveProductionRunInWorkspace, type ProductionLedgerWorkspace } from './production-ledger'

export interface ProductionOrderImport { id: string; actorId: string; payload: string; runIds: string[] }
export type RoundImportWorkspace = ProductionLedgerWorkspace & { productionOrderImports?: ProductionOrderImport[] }
const key = (value: string) => value.trim().toUpperCase()
const literal = (value: unknown): string => {
  if (value == null) return ''
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('A·M·L열 프로젝트 코드·명칭·시즌 값을 확인해 주세요.')
  return String(value).trim()
}

/** Source A owns the project identity. A repeated SKU must never inherit the
 * style's latest project when the file explicitly names another project. */
export function projectForImportLine(workspace: Workspace, styleId: string, line: OrderImportChange['lines'][number]): Project {
  const style = workspace.styles.find(item => item.id === styleId)
  if (!style) throw new Error('업로드할 스타일을 확인해 주세요.')
  const codes = new Set((line.source?.rows || []).map(row => literal(row.columns.A)).filter(Boolean).map(key))
  if (codes.size > 1) throw new Error('같은 품번·컬러에 서로 다른 프로젝트가 있습니다. 프로젝트별로 나누어 업로드해 주세요.')
  const code = [...codes][0]
  const matches = code ? workspace.projects.filter(project => !!project.code?.trim() && key(project.code) === code) : workspace.projects.filter(project => project.id === style.projectId)
  if (matches.length !== 1) throw new Error('A열 프로젝트 코드를 먼저 등록해 주세요. 스타일·프로젝트 등록에서 해당 프로젝트를 확인한 뒤 다시 업로드해 주세요.')
  const project = matches[0]
  for (const row of line.source?.rows || []) {
    const name = literal(row.columns.M), season = literal(row.columns.L)
    if (name && name !== project.name.trim() || season && season !== project.season.trim()) throw new Error('A열 프로젝트에 등록된 명칭·시즌이 M·L열과 다릅니다. 프로젝트 기본 정보를 확인해 주세요.')
  }
  return project
}

/** Importing a file creates a fresh production round. The legacy color order
 * may still be replaced/added, but no previous run or actual receipt is edited. */
export function importProductionOrdersInWorkspace(workspace: RoundImportWorkspace, profile: Profile, importId: string, changes: OrderImportChange[], mode: 'replace' | 'add', reason: string, makeId = () => crypto.randomUUID()): RoundImportWorkspace {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(importId)) throw new Error('업로드 요청 식별자를 확인해 주세요.')
  const actor = workspace.profiles.find(item => item.id === profile.id)
  if (!actor?.active || !actor.approved || actor.role === 'factory') throw new Error('본사 관리자·직원만 오더를 업로드할 수 있습니다.')
  const payload = JSON.stringify({ changes, mode, reason })
  const previous = workspace.productionOrderImports?.find(item => item.id === importId)
  if (previous) {
    if (previous.actorId !== actor.id || previous.payload !== payload) throw new Error('업로드 요청 식별자가 다른 내용에 사용되었습니다. 새 미리보기로 다시 시도해 주세요.')
    return structuredClone(workspace)
  }
  // Resolve every project before changing even the in-memory legacy data.
  const planned = changes.flatMap(change => change.lines.map(line => ({ change, line, project: projectForImportLine(workspace, change.styleId, line) })))
  let next = importOrdersInWorkspace(workspace, actor, changes, mode, reason) as RoundImportWorkspace
  const runIds: string[] = []
  for (const { change, line, project } of planned) {
    const runId = makeId()
    next = saveProductionRunInWorkspace(next, actor, runId, change.styleId, line.lineId, {
      name: '오더 업로드', projectId: project.id, projectCode: project.code?.trim() || '', expectedDue: '',
      poId: null, unitCost: null, itemType: 'product', order: structuredClone(line.quantities), correctsRunId: null,
    }, 0, reason)
    runIds.push(runId)
  }
  next.productionOrderImports = [...(next.productionOrderImports || []), { id: importId, actorId: actor.id, payload, runIds }]
  return next
}
