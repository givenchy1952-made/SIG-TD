/** A production selection is the stored color line and project, optionally a
 * particular run. Display names and SKU suffixes are never identity keys. */
export interface ProductionSelectionContext { lineId: string; projectId: string; runId?: string }

export function selectProductionContext<T extends { lineId: string; projectId: string }>(items: readonly T[], context: Partial<ProductionSelectionContext>, runId: (item: T) => string): T | undefined {
  const matches = (item: T) => (!context.lineId || item.lineId === context.lineId) && (!context.projectId || item.projectId === context.projectId)
  if (context.runId) {
    const exact = items.find(item => runId(item) === context.runId && matches(item))
    if (exact) return exact
    if (!context.lineId && !context.projectId) return undefined
  }
  if (context.lineId || context.projectId) {
    const matching = items.filter(matches)
    return matching.length === 1 ? matching[0] : undefined
  }
  return items[0]
}

export function productionContextKey(context: Partial<ProductionSelectionContext>): string {
  return JSON.stringify([context.lineId || '', context.projectId || '', context.runId || ''])
}
