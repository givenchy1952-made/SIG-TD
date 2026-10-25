import { blankProduction, type Project, type Profile, type Style, type Workspace } from './types'
import type { ProductionDetails, ProductionDetailsInput } from './workflow-refinements'
import { saveProductionDetailsInWorkspace } from './workflow-refinements'
import { getDemoWorkspace, locked, persist, supabase } from './repository'
import { assertActive, assertStyleSave } from './permissions'
import { assertManagedShipmentTotals, validateOperationReason } from './operations-domain'
import { assertProductionLedgerTotals } from './production-ledger'
import type { SupabaseClient } from '@supabase/supabase-js'
export interface RegistrationProject extends Project { code: string; expected?: { code: string; name: string; season: string } | null }
export async function loadWorkflowRefinements(client: SupabaseClient): Promise<{ refinementsAvailable: boolean; productionDetails: ProductionDetails[] }> {
  const capability = await client.rpc('get_workflow_refinements_capability')
  if (capability.error && ['PGRST202', '42883'].includes(capability.error.code)) return { refinementsAvailable: false, productionDetails: [] }
  if (capability.error) throw capability.error
  const rows: ProductionDetails[] = []
  for (let offset = 0; ; offset += 500) {
    const result = await client.from('production_details').select('*').order('style_id').order('line_id').range(offset, offset + 499)
    if (result.error) throw result.error
    rows.push(...(result.data || []).map(row => ({ ...row.data, styleId: row.style_id, lineId: row.line_id, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: row.updated_by })))
    if ((result.data || []).length < 500) return { refinementsAvailable: capability.data === true, productionDetails: rows }
  }
}
export async function saveProductionDetails(styleId: string, lineId: string, data: ProductionDetailsInput, expectedVersion: number, reason: string, profile: Profile): Promise<void> {
  if (supabase) {
    const result = await supabase.rpc('save_production_details', { p_style_id: styleId, p_line_id: lineId, p_data: data, p_expected_version: expectedVersion, p_reason: reason })
    if (result.error) throw result.error
  } else await locked(() => persist(saveProductionDetailsInWorkspace(getDemoWorkspace(), profile, styleId, lineId, data, expectedVersion, reason)))
}
export function registerOrderStyleInWorkspace(workspace: Workspace, supplied: Profile, style: Style, project: RegistrationProject, reason: string): Workspace {
  const actor = workspace.profiles.find(p => p.id === supplied.id); if (!actor) throw new Error('계정을 확인해 주세요.'); assertActive(actor)
  if (actor.role === 'factory') throw new Error('스타일·프로젝트 등록은 본사만 가능합니다.')
  validateOperationReason(reason)
  if (!project.code.trim() || project.code.length > 120 || /[\x00-\x1f\x7f]/.test(project.code) || !project.name.trim() || project.name.length > 160 || !project.season.trim() || project.season.length > 30) throw new Error('프로젝트 코드·명칭·시즌을 확인해 주세요.')
  const next = structuredClone(workspace), beforeProject = next.projects.find(p => p.id === project.id)
  if (beforeProject) {
    const snapshot = { code: beforeProject.code || '', name: beforeProject.name, season: beforeProject.season }
    if (JSON.stringify(snapshot) !== JSON.stringify(project.expected)) throw new Error('VERSION_CONFLICT: 프로젝트가 변경되었습니다.')
    if (snapshot.name !== project.name.trim() || snapshot.season !== project.season.trim() || snapshot.code && snapshot.code.toLowerCase() !== project.code.trim().toLowerCase()) throw new Error('프로젝트 코드·명칭이 기존 정보와 다릅니다.')
    if (!beforeProject.code?.trim()) beforeProject.code = project.code.trim()
  } else {
    if (project.expected != null || next.projects.some(p => p.code?.trim().toLowerCase() === project.code.trim().toLowerCase() || !p.code?.trim() && p.name === project.name.trim() && p.season === project.season.trim())) throw new Error('VERSION_CONFLICT: 프로젝트가 이미 등록되었거나 변경되었습니다.')
    next.projects.push({ id: project.id, code: project.code.trim(), name: project.name.trim(), season: project.season.trim() })
  }
  const before = next.styles.find(s => s.id === style.id)
  if ((before?.version || 0) !== style.version) throw new Error('VERSION_CONFLICT')
  const canonical = (value: unknown): string => JSON.stringify(value, function (_key, item) { return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item })
  const metadata = (item: Style) => Object.fromEntries(Object.entries(item).filter(([key]) => !['production', 'colors', 'projectId', 'season', 'version', 'updatedAt', 'updatedBy', 'deletedAt'].includes(key)))
  if (before && canonical(metadata(before)) !== canonical(metadata(style))) throw new Error('등록 중 기존 스타일 기본 정보를 변경할 수 없습니다.')
  for (const line of style.production) {
    const previous = before?.production.find(item => item.id === line.id)
    if (previous) { if (canonical(previous) !== canonical(line)) throw new Error('등록 중 기존 생산 수량·이력을 변경할 수 없습니다.') }
    else {
      const empty = blankProduction(line.color); empty.id = line.id
      if (canonical(empty) !== canonical(line)) throw new Error('새 컬러는 오더·출고·입고·패킹 수량과 체크가 비어 있어야 합니다.')
    }
  }
  if (!before && (style.samples.length || style.stage !== 'registered' || style.ppApproved || style.name !== style.code)) throw new Error('새 스타일은 기본 품번으로 등록하고 샘플·생산 진행을 비워 주세요.')

  if (style.projectId !== project.id || style.season !== project.season || !next.factories.some(f => f.id === style.factoryId) || !next.profiles.some(p => p.id === style.ownerId && p.active && p.approved && p.role !== 'factory')) throw new Error('프로젝트·등록 공장·본사 담당자를 확인해 주세요.')
  if (next.styles.some(s => s.id !== style.id && s.code.toUpperCase() === style.code.toUpperCase())) throw new Error('이미 등록된 품번입니다.')
  assertStyleSave(actor, before, style, reason); assertManagedShipmentTotals(next, style); assertProductionLedgerTotals(next, style)
  const now = new Date().toISOString(), after = { ...structuredClone(style), version: style.version + 1, updatedAt: now, updatedBy: actor.id }
  next.styles = [...next.styles.filter(s => s.id !== style.id), after]
  next.audits.unshift({ id: crypto.randomUUID(), styleId: style.id, actorId: actor.id, actorName: actor.name, action: '오더 스타일·프로젝트 등록', reason, before: before || null, after, createdAt: now }); return next
}
export async function registerOrderStyle(style: Style, project: RegistrationProject, reason: string, profile: Profile): Promise<void> {
  if (supabase) {
    const { error } = await supabase.rpc('register_order_style', { p_id: style.id, p_expected_version: style.version, p_data: style, p_project: { id: project.id, code: project.code, name: project.name, season: project.season, expected: project.expected ?? null }, p_reason: reason })
    if (error) throw error
  } else await locked(() => persist(registerOrderStyleInWorkspace(getDemoWorkspace(), profile, style, project, reason)))
}
