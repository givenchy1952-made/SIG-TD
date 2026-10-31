import type { Project, Style, Workspace } from './types'
import { fullStyleSku } from './style-identity'
import { compareProjectIds, matchesProjectSelection, type ProjectSelection } from './project-identity'
import type { SigEuljiRow } from './sig-eulji'

export interface SettlementSkuOption { key: string; label: string; styleId: string; lineId: string }

/** Always intersect the supplied style/color selection with the current visible
 * workspace. Project IDs remain the scope key, including historical rounds. */
function canonicalSelectedStyles(workspace: Workspace, styles: readonly Style[]): Style[] {
  const seen = new Set<string>()
  return styles.flatMap(selected => {
    if (seen.has(selected.id)) return []
    seen.add(selected.id)
    const style = workspace.styles.find(item => item.id === selected.id && !item.deletedAt)
    if (!style) return []
    const keys = new Set(selected.production.map(line => `${line.id}:${line.color}`))
    return [{ ...style, production: style.production.filter(line => keys.has(`${line.id}:${line.color}`)) }]
  })
}

export function settlementProjectOptions(workspace: Workspace, styles: readonly Style[]): Project[] {
  const canonical = canonicalSelectedStyles(workspace, styles)
  const ids = new Set(canonical.map(style => style.projectId))
  for (const style of canonical) for (const run of workspace.productionRuns || []) {
    if (run.styleId === style.id && style.production.some(line => line.id === run.lineId)) ids.add(run.closedAt && run.snapshot ? run.snapshot.projectId : run.projectId)
  }
  return workspace.projects.filter(project => ids.has(project.id)).sort((a, b) => compareProjectIds(workspace, a.id, b.id))
}

function lineHasProject(workspace: Workspace, style: Style, lineId: string, projectIds: ProjectSelection, includeHistorical: boolean): boolean {
  return matchesProjectSelection(style.projectId, projectIds) || includeHistorical && (workspace.productionRuns || []).some(run => run.styleId === style.id && run.lineId === lineId && matchesProjectSelection(run.closedAt && run.snapshot ? run.snapshot.projectId : run.projectId, projectIds))
}

export function settlementSkuOptions(workspace: Workspace, styles: readonly Style[], projectIds: ProjectSelection, includeHistorical = true): SettlementSkuOption[] {
  return canonicalSelectedStyles(workspace, styles).flatMap(style => style.production
    .filter(line => lineHasProject(workspace, style, line.id, projectIds, includeHistorical))
    .map(line => ({ key: `${style.id}:${line.id}`, label: fullStyleSku(style.code, line.color), styleId: style.id, lineId: line.id })))
    .sort((a, b) => a.label.localeCompare(b.label, 'ko-KR', { numeric: true }) || a.key.localeCompare(b.key))
}

export function selectSettlementStyles(workspace: Workspace, styles: readonly Style[], projectIds: ProjectSelection, skuKeys: readonly string[], includeHistorical = true): Style[] {
  const selectedKeys = new Set(skuKeys)
  return canonicalSelectedStyles(workspace, styles).map(style => ({ ...style,
    production: style.production.filter(line => selectedKeys.has(`${style.id}:${line.id}`) && lineHasProject(workspace, style, line.id, projectIds, includeHistorical)),
  })).filter(style => style.production.length)
}

export type EuljiProjectSort = 'name' | 'code'
export function sortEuljiRowsByProject(rows: readonly SigEuljiRow[], by: EuljiProjectSort = 'name'): SigEuljiRow[] {
  const collator = new Intl.Collator('ko-KR', { numeric: true })
  return [...rows].sort((a, b) => {
    const nameA = a.projectName || a.projectCode, nameB = b.projectName || b.projectCode
    return (by === 'name' ? collator.compare(nameA, nameB) || collator.compare(a.projectCode, b.projectCode) : collator.compare(a.projectCode, b.projectCode) || collator.compare(nameA, nameB))
      || (a.projectId || '').localeCompare(b.projectId || '') || collator.compare(a.colorStyleCode, b.colorStyleCode)
  })
}
