import type { Style, Workspace } from './types'
import { getHistoricalProjectIdentity, type ProjectIdentity } from './project-identity'

export interface PoProductionProjectContext { identity: ProjectIdentity; budgetCodes: string[] }
const clean = (value: string | null | undefined) => (value || '').trim()
const key = (value: string) => value.normalize('NFKC').toLocaleUpperCase('en-US')

/** Existing PO documents belong to their captured/linked project, even after
 * the current style moves to another project. New generic copies use the
 * current style's project and create their own capture when saved. */
export function resolvePoProductionProject(workspace: Workspace, style: Style, poId?: string): PoProductionProjectContext | null {
  const po = poId ? workspace.operations?.poDispatches.find(record => record.id === poId) : undefined
  if (poId && (!po || po.styleId !== style.id)) return null
  const allRuns = (workspace.productionRuns || []).filter(run => poId && run.poId === poId)
  const captures = (workspace.productionPoContexts || []).filter(context => poId && context.poId === poId)
  if (allRuns.some(run => run.styleId !== style.id) || captures.some(context => context.snapshot.styleId !== style.id)) return null
  const ids = new Set([
    ...allRuns.map(run => clean(run.snapshot?.projectId) || run.projectId),
    ...captures.map(context => context.snapshot.projectId),
  ].filter(Boolean))
  if (ids.size > 1) return null
  const projectId = [...ids][0] || style.projectId
  const order = workspace.supplierProductionOrders?.find(item => item.projectId === projectId && allRuns.some(run => run.id === item.runId))
  const identity = getHistoricalProjectIdentity(workspace, projectId, { name: order?.projectName, code: order?.projectCode || allRuns[0]?.snapshot?.projectCode || allRuns[0]?.projectCode || captures[0]?.snapshot.projectCode })
  const codes = new Set([
    identity.code,
    workspace.projects.find(project => project.id === style.projectId)?.code,
    ...allRuns.flatMap(run => [run.projectCode, run.snapshot?.projectCode]),
    ...captures.map(context => context.snapshot.projectCode),
    ...(workspace.operations?.orderSourceRecords || []).filter(record => record.styleId === style.id).flatMap(record => record.rows.map(row => typeof row.columns.A === 'string' ? row.columns.A : '')),
  ].map(clean).filter(Boolean))
  return { identity, budgetCodes: [...codes] }
}

export function poContainsBudgetCode(data: { subject: string; body: string }, context: PoProductionProjectContext | null): boolean {
  const text = key(`${data.subject}\n${data.body}`)
  return /SIGNIFICANT-\d{4}[A-Z]*-(?:MPQ|RPQ|MOQ|OPQ)-\d+/i.test(text) || !!context?.budgetCodes.some(code => text.includes(key(code)))
}

export function poUsesProductionName(data: { subject: string; body: string }, context: PoProductionProjectContext | null): boolean {
  return !!context?.identity.hasOfficialName && data.subject.includes(context.identity.name) && data.body.includes(context.identity.name) && !poContainsBudgetCode(data, context)
}
