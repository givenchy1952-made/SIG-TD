/** Server-only production identity lookup. A-column budgeting identifiers never
 * become a supplier-facing name and stored PO content is never rewritten. */
export interface PoProjectContext { projectId: string; name: string; budgetCodes: string[] }
export interface ProjectLookupResult<T> { data: T | null; error: { code?: string; message?: string } | null }
export interface PoProjectLookup {
  linkedRuns(poId: string, styleId: string): Promise<ProjectLookupResult<Array<{ project_id: string; project_code: string; snapshot?: unknown }>>>
  capturedContext(poId: string, styleId: string): Promise<ProjectLookupResult<{ snapshot: unknown }>>
  style(styleId: string): Promise<ProjectLookupResult<{ data: unknown }>>
  project(projectId: string): Promise<ProjectLookupResult<{ id: string; name: string; code?: string | null; season: string }>>
  orderSources(styleId: string): Promise<ProjectLookupResult<Array<{ rows_data: unknown }>>>
  productionName?(projectId: string): Promise<ProjectLookupResult<{ projectId: string; name: string; season: string }>>
}
const clean = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const key = (value: string) => value.normalize('NFKC').toLocaleUpperCase('en-US')
const standardBudgetCode = /SIGNIFICANT-\d{4}[A-Z]*-(?:MPQ|RPQ|MOQ|OPQ)-\d+/i
const excelError = /^#(?:REF!|NAME\?|VALUE!|DIV\/0!|N\/A|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$/i
const validName = (name: string, codes: string[]) => !!name && name.length <= 160 && !/[\x00-\x1f\x7f]/.test(name) && !excelError.test(name) && !standardBudgetCode.test(name) && !codes.some(code => key(name) === key(code)) && name !== '프로젝트 명칭 미등록'
function required<T>(result: ProjectLookupResult<T>): T | null { if (result.error) throw new Error('PROJECT_LOOKUP_UNAVAILABLE'); return result.data }

export async function loadPoProjectContext(lookup: PoProjectLookup, poId: string, styleId: string): Promise<PoProjectContext | null> {
  const [runResult, capturedResult] = await Promise.all([lookup.linkedRuns(poId, styleId), lookup.capturedContext(poId, styleId)])
  const runs = required(runResult) || []
  // A pre-015 server has no captured contexts; existing linked runs still win.
  const captured = capturedResult.error && ['42P01', 'PGRST205'].includes(capturedResult.error.code || '') ? null : required(capturedResult)
  const snapshot = object(captured?.snapshot)
  const projectIds = [...new Set(runs.map(run => clean(object(run.snapshot).projectId) || clean(run.project_id)).filter(Boolean))]
  const capturedId = clean(snapshot.projectId)
  if (projectIds.length > 1 || projectIds.length && capturedId && projectIds[0] !== capturedId) return null
  let projectId = projectIds[0] || capturedId
  if (!projectId) projectId = clean(object(required(await lookup.style(styleId))?.data).projectId)
  if (!projectId) return null
  const project = required(await lookup.project(projectId))
  if (!project || project.id !== projectId) return null
  const codes = new Set([clean(project.code), clean(snapshot.projectCode), ...runs.flatMap(run => [clean(run.project_code), clean(object(run.snapshot).projectCode)])].filter(Boolean))
  const sources = required(await lookup.orderSources(styleId)) || []
  const sourceRows = sources.flatMap(source => Array.isArray(source.rows_data) ? source.rows_data.map(row => object(object(row).columns)) : [])
  let name = clean(project.name)
  const sourceCodePlaceholder = sourceRows.some(columns => clean(columns.A) && key(clean(columns.A)) === key(name))
  if (!validName(name, [...codes]) || sourceCodePlaceholder) {
    // 019 can resolve a legacy project's M from another correctly linked style
    // without giving the caller access to its original order rows. On older
    // servers the existing same-style source validation remains available.
    const projected = lookup.productionName ? required(await lookup.productionName(projectId)) : null
    if (projected?.projectId === projectId && validName(clean(projected.name), [...codes]) && (!clean(project.season) || clean(project.season) === clean(projected.season))) {
      if (name && (sourceCodePlaceholder || standardBudgetCode.test(name))) codes.add(name)
      name = clean(projected.name)
    } else {
      const candidates = sourceRows.filter(columns => {
        const code = clean(columns.A)
        return code && (codes.size ? [...codes].some(existing => key(existing) === key(code)) : key(code) === key(name))
      })
      const identities = new Map(candidates.map(columns => [JSON.stringify([key(clean(columns.A)), clean(columns.M), clean(columns.L)]), columns]))
      if (identities.size !== 1) return null
      const candidate = [...identities.values()][0]
      if (!candidate || !clean(candidate.M) || !clean(candidate.L) || clean(project.season) && clean(project.season) !== clean(candidate.L)) return null
      codes.add(clean(candidate.A)); name = clean(candidate.M)
    }
  }
  // Other A values on this same style are budgeting references as well. They
  // may belong to earlier projects but still must not leak into a new email.
  sourceRows.forEach(columns => { const code = clean(columns.A); if (code) codes.add(code) })
  if (!validName(name, [...codes])) return null
  return { projectId, name, budgetCodes: [...codes].sort() }
}

export function poProjectPolicyError(context: PoProjectContext | null, subject: string, body: string): string | null {
  if (!context || !validName(context.name, context.budgetCodes)) return '프로젝트 명칭(M열)을 확인할 수 없습니다. 본사에서 명칭을 확인한 뒤 새 PO를 작성해 주세요.'
  const content = key(`${subject}\n${body}`)
  if (standardBudgetCode.test(content) || context.budgetCodes.some(code => !!code && content.includes(key(code)))) return 'PO 제목·본문에는 본사 예산 관리 코드(A열)를 사용할 수 없습니다. 프로젝트 명칭(M열)으로 새 PO를 작성해 주세요.'
  if (!subject.includes(context.name) || !body.includes(context.name)) return 'PO 제목과 본문에 프로젝트 명칭(M열)을 모두 표시한 뒤 발송해 주세요.'
  return null
}
export function samePoProjectContext(left: PoProjectContext | null, right: PoProjectContext | null): boolean {
  return !!left && !!right && left.projectId === right.projectId && left.name === right.name && JSON.stringify([...left.budgetCodes].sort()) === JSON.stringify([...right.budgetCodes].sort())
}
