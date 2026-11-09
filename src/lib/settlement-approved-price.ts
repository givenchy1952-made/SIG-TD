import type { ProductionRun } from './production-ledger'
import type { SettlementItemType } from './settlement-types'
import type { Workspace } from './types'

export interface SettlementPriceSelection { projectId?: string; runId?: string }
export interface ApprovedSettlementPrice {
  managed: boolean;
  status: 'manual' | 'approved' | 'closed' | 'legacy' | 'pending' | 'ambiguous' | 'missing' | 'inconsistent';
  candidates: ProductionRun[];
  run: ProductionRun | null;
  unitCost: number | null;
  projectId: string;
  projectCode: string;
  itemType: SettlementItemType;
}
const validCost = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000 && /^\d+(?:\.\d{1,2})?$/.test(String(value))

/** Prices are a live, read-only projection of the exact production order. A
 * line-level manual price never overrides an approved order or frozen close. */
export function resolveApprovedSettlementPrice(workspace: Workspace, styleId: string, lineId: string, selection: SettlementPriceSelection = {}): ApprovedSettlementPrice {
  const style = workspace.styles.find(item => item.id === styleId)
  const projectId = selection.projectId || style?.projectId || ''
  const all = (workspace.productionRuns || []).filter(run => run.styleId === styleId && run.lineId === lineId)
  const candidates = all.filter(run => (run.closedAt && run.snapshot ? run.snapshot.projectId : run.projectId) === projectId)
  const result: ApprovedSettlementPrice = { managed: all.length > 0, status: all.length ? 'missing' : 'manual', candidates, run: null, unitCost: null, projectId, projectCode: '', itemType: 'product' }
  if (!all.length) return result
  const run = selection.runId ? candidates.find(run => run.id === selection.runId) : candidates.length === 1 ? candidates[0] : undefined
  if (!run) return { ...result, status: !selection.runId && candidates.length > 1 ? 'ambiguous' : 'missing' }
  const context = { ...result, run, projectId: run.projectId, projectCode: run.projectCode, itemType: run.itemType }
  if (run.closedAt) {
    return run.snapshot && validCost(run.snapshot.unitCost)
      ? { ...context, status: 'closed', unitCost: run.snapshot.unitCost, projectId: run.snapshot.projectId, projectCode: run.snapshot.projectCode, itemType: run.snapshot.itemType }
      : { ...context, status: 'inconsistent' }
  }
  const condition = workspace.productionConditions?.find(item => item.runId === run.id)
  if (!condition?.approval || !['approved', 'closed', 'assignment_changed'].includes(condition.status)) return { ...context, status: condition?.legacy ? 'legacy' : 'pending' }
  const approval = condition.approval
  const identity = approval.termsSnapshot
  const matchesIdentity = Object.entries({ runId: run.id, styleId, lineId, projectId: run.projectId }).every(([key, value]) => identity[key] === undefined || identity[key] === value)
  if (!matchesIdentity || !validCost(approval.unitCost) || approval.unitCost !== run.unitCost) return { ...context, status: 'inconsistent' }
  return { ...context, status: 'approved', unitCost: approval.unitCost }
}
