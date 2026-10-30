import { quantityTotal, type Profile, type Style } from './types'
import type { ProductionLedgerWorkspace } from './production-ledger'
import { buildSigEuljiRows, sigEuljiNetAmount, type SigEuljiPreview } from './sig-eulji'
import { getProjectIdentity } from './project-identity'

/** Global product export: managed colors use closed rounds only, other colors keep the legacy writer. */
export interface ProductionExportScope { projectIds?: readonly string[] | null; factoryIds?: readonly string[] | null; ownerIds?: readonly string[] | null; seasons?: readonly string[] | null }
export function buildFrozenProductionEuljiRows(workspace: ProductionLedgerWorkspace, selectedStyles: Style[], suppliedActor: Profile, scope: ProductionExportScope = {}): SigEuljiPreview {
  const actor = workspace.profiles.find(item => item.id === suppliedActor.id)
  if (!actor?.active || !actor.approved || actor.role === 'factory') return { rows: [], errors: ['생산 차수 마감 다운로드는 승인된 관리자·본사 직원만 가능합니다.'] }
  const runIds: string[] = [], legacy: Style[] = [], errors: string[] = []
  const includes = (values: readonly string[] | null | undefined, value: string) => values == null || values.includes(value)
  const inScope = (projectId: string, factoryId: string, ownerId: string, season: string) => includes(scope.projectIds, projectId) && includes(scope.factoryIds, factoryId) && includes(scope.ownerIds, ownerId) && includes(scope.seasons, season)
  const seen = new Set<string>()
  for (const selected of selectedStyles) {
    if (seen.has(selected.id)) { errors.push('내보낼 스타일이 중복되었습니다.'); continue }
    seen.add(selected.id)
    const style = workspace.styles.find(item => item.id === selected.id && !item.deletedAt)
    if (!style) { errors.push('선택한 스타일이 삭제되었거나 현재 조회 범위에 없습니다.'); continue }
    const legacyLines: Style['production'] = [], seenLines = new Set<string>()
    for (const selectedLine of selected.production) {
      const line = style.production.find(item => item.id === selectedLine.id && item.color === selectedLine.color)
      if (!line || seenLines.has(selectedLine.id)) { errors.push(`${style.code}: 선택한 컬러가 변경되었거나 중복되었습니다.`); continue }
      seenLines.add(line.id)
      const runs = (workspace.productionRuns || []).filter(run => run.styleId === style.id && run.lineId === line.id)
      if (!runs.length) { if (inScope(style.projectId, style.factoryId, line.ownerId ?? style.ownerId, style.season)) legacyLines.push(line) }
      else for (const run of runs.filter(item => {
        const identity = item.closedAt && item.snapshot ? item.snapshot : item
        return inScope(identity.projectId, identity.factoryIdSnapshot, identity.ownerIdSnapshot, workspace.projects.find(project => project.id === identity.projectId)?.season || style.season)
      })) {
        if (run.closedAt && run.snapshot) runIds.push(run.id)
        else errors.push(`${style.code} ${line.color} · ${run.projectCode} ${run.round}차: 마감 확정 후 다운로드해 주세요. 확정 차수 한 건은 스타일 상세에서 별도로 내려받을 수 있습니다.`)
      }
    }
    if (legacyLines.length) legacy.push({ ...style, production: legacyLines })
  }
  const frozen = runIds.length ? buildProductionRunEuljiRows(workspace, runIds, suppliedActor) : { rows: [], errors: [] }
  const old = legacy.length ? buildSigEuljiRows(workspace, legacy, suppliedActor) : { rows: [], errors: [] }
  if (!selectedStyles.length || !selectedStyles.some(style => style.production.length)) errors.push('내보낼 스타일·컬러가 없습니다.')
  if (!frozen.rows.length && !old.rows.length && !errors.length && !frozen.errors.length && !old.errors.length) errors.push('선택한 조건에 다운로드할 생산 차수가 없습니다.')
  return { rows: [...frozen.rows, ...old.rows], errors: [...errors, ...frozen.errors, ...old.errors] }
}

/** Financial exports use the frozen closing record, never today's style or price. */
export function buildProductionRunEuljiRows(workspace: ProductionLedgerWorkspace, runIds: string[], suppliedActor: Profile): SigEuljiPreview {
  const actor = workspace.profiles.find(item => item.id === suppliedActor.id)
  if (!actor?.active || !actor.approved || actor.role === 'factory') return { rows: [], errors: ['생산 차수 마감 다운로드는 승인된 관리자·본사 직원만 가능합니다.'] }
  const rows: SigEuljiPreview['rows'] = [], errors: string[] = []
  if (!runIds.length) return { rows, errors: ['다운로드할 마감 확정 차수를 선택해 주세요.'] }
  for (const id of new Set(runIds)) {
    const run = workspace.productionRuns?.find(item => item.id === id), snapshot = run?.snapshot
    if (!run?.closedAt || !snapshot) { errors.push('마감 확정된 생산 차수만 을지로 다운로드할 수 있습니다.'); continue }
    try {
      const received = snapshot.receipts.reduce((total, receipt) => total + quantityTotal(receipt.quantities), 0)
      if (received !== snapshot.receivedQuantity || snapshot.netAmount !== sigEuljiNetAmount(snapshot.unitCost, snapshot.receivedQuantity)) throw new Error('확정된 입고 수량과 마감 금액을 확인해 주세요.')
      const project = getProjectIdentity(workspace, snapshot.projectId)
      const hasProjectLabel = workspace.projects.some(item => item.id === snapshot.projectId && (item.name?.trim() || item.code?.trim()))
      rows.push({ projectId: snapshot.projectId, projectName: hasProjectLabel ? project.name : snapshot.projectCode, season: project.season, projectCode: snapshot.projectCode, receivedAtISO: snapshot.lastReceivedAt, factory: snapshot.factory, colorStyleCode: snapshot.styleCode, unitCost: snapshot.unitCost, orderQuantity: snapshot.orderQuantity, receivedQuantity: snapshot.receivedQuantity, unit: snapshot.itemType === 'fabric' ? 'YDS' : 'EA', netAmount: snapshot.netAmount, owner: snapshot.owner })
    } catch (error) { errors.push(`${run.name} · ${run.round}차: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return { rows, errors }
}
