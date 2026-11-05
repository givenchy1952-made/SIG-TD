import { describe, expect, it, vi } from 'vitest'
import { loadPoProjectContext, poProjectPolicyError, samePoProjectContext } from '../supabase/functions/_shared/po-project-policy'

const PROJECT = '30000000-0000-4000-8000-000000000001', OTHER = '30000000-0000-4000-8000-000000000002'
const NAME = '시그니피컨트 2026 3Q', BUDGET = 'SIGNIFICANT-2026FY-MPQ-46093'
const ok = <T>(data: T) => ({ data, error: null })
function lookup() {
  return {
    linkedRuns: vi.fn(async () => ok([{ project_id: PROJECT, project_code: BUDGET, snapshot: null }])),
    capturedContext: vi.fn(async () => ok({ snapshot: { projectId: PROJECT, projectCode: BUDGET } })),
    style: vi.fn(async () => ok({ data: { projectId: OTHER } })),
    project: vi.fn(async (id: string) => ok({ id, name: NAME, code: BUDGET, season: '2026FY' })),
    orderSources: vi.fn(async () => ok([{ rows_data: [{ columns: { A: BUDGET, M: NAME, L: '2026FY' } }] }])),
  }
}

describe('공급업체용 PO의 서버 프로젝트 명칭 정책', () => {
  it('현재 스타일 프로젝트가 달라도 실제로 연결된 차수와 PO 원본의 프로젝트를 사용한다', async () => {
    const source = lookup(), result = await loadPoProjectContext(source, 'po', 'style')
    expect(result).toEqual({ projectId: PROJECT, name: NAME, budgetCodes: [BUDGET] })
    expect(source.project).toHaveBeenCalledWith(PROJECT); expect(source.style).not.toHaveBeenCalled()
  })
  it('과거 고정 코드와 새 코드를 모두 차단할 예산 코드로 보존한다', async () => {
    const source = lookup()
    source.linkedRuns.mockResolvedValueOnce(ok([{ project_id: PROJECT, project_code: 'BUDGET-NEW', snapshot: { projectId: PROJECT, projectCode: 'BUDGET-FROZEN' } }]) as never)
    const context = await loadPoProjectContext(source, 'po', 'style')
    expect(context?.budgetCodes).toEqual([BUDGET, 'BUDGET-FROZEN', 'BUDGET-NEW'].sort())
    expect(poProjectPolicyError(context, `${NAME} / BUDGET-FROZEN`, NAME)).toContain('예산 관리 코드')
  })
  it('여러 프로젝트가 연결됐거나 저장된 PO 비교 원본과 다르면 이름을 추정하지 않는다', async () => {
    const source = lookup()
    source.linkedRuns.mockResolvedValueOnce(ok([{ project_id: PROJECT, project_code: BUDGET }, { project_id: OTHER, project_code: 'BUDGET-OTHER' }]) as never)
    expect(await loadPoProjectContext(source, 'po', 'style')).toBeNull()
    source.capturedContext.mockResolvedValueOnce(ok({ snapshot: { projectId: OTHER } }) as never)
    expect(await loadPoProjectContext(source, 'po', 'style')).toBeNull()
  })
  it('총수량 PO라도 저장된 비교 원본 프로젝트가 있으면 바뀐 스타일 프로젝트를 대신 쓰지 않는다', async () => {
    const source = lookup(); source.linkedRuns.mockResolvedValueOnce(ok([]))
    expect((await loadPoProjectContext(source, 'po', 'style'))?.projectId).toBe(PROJECT)
    expect(source.style).not.toHaveBeenCalled()
  })
  it('차수·비교 원본이 없는 기존 일반 PO만 접근 가능한 스타일의 프로젝트를 조회한다', async () => {
    const source = lookup(); source.linkedRuns.mockResolvedValueOnce(ok([])); source.capturedContext.mockResolvedValueOnce({ data: null, error: { code: '42P01' } } as never)
    expect((await loadPoProjectContext(source, 'po', 'style'))?.projectId).toBe(OTHER)
    expect(source.style).toHaveBeenCalledWith('style')
  })
  it('A열 코드가 이름에 저장된 예전 프로젝트는 같은 A와 일치하는 M/L 원본 하나로만 보완한다', async () => {
    const source = lookup(); source.project.mockResolvedValueOnce(ok({ id: PROJECT, name: BUDGET, code: BUDGET, season: '2026FY' }))
    const result = await loadPoProjectContext(source, 'po', 'style')
    expect(result?.name).toBe(NAME); expect(result?.budgetCodes).toContain(BUDGET)
    expect(poProjectPolicyError(result, `[PO] ${NAME}`, `프로젝트 명칭: ${NAME}`)).toBeNull()
  })
  it('다른 스타일에만 M 원본이 있어도 019의 같은 프로젝트 조회로 예전 A 이름을 보완한다', async () => {
    const source = { ...lookup(), productionName: vi.fn(async () => ok({ projectId: PROJECT, name: NAME, season: '2026FY' })) }
    source.project.mockResolvedValueOnce(ok({ id: PROJECT, name: BUDGET, code: BUDGET, season: '2026FY' }))
    source.orderSources.mockResolvedValueOnce(ok([]))
    const result = await loadPoProjectContext(source, 'po', 'style')
    expect(source.productionName).toHaveBeenCalledWith(PROJECT)
    expect(result).toEqual({ projectId: PROJECT, name: NAME, budgetCodes: [BUDGET] })
    expect(poProjectPolicyError(result, NAME, NAME)).toBeNull()
    expect(poProjectPolicyError(result, NAME, `${NAME} ${BUDGET}`)).toContain('예산 관리 코드')
  })
  it('019가 아직 없으면 동일 스타일의 원본 확인을 유지하며 유효한 공식 명칭은 대체하지 않는다', async () => {
    const source = { ...lookup(), productionName: vi.fn(async () => ({ data: null, error: null })) }
    source.project.mockResolvedValueOnce(ok({ id: PROJECT, name: BUDGET, code: BUDGET, season: '2026FY' }))
    expect((await loadPoProjectContext(source, 'po', 'style'))?.name).toBe(NAME)
    source.productionName.mockClear()
    expect((await loadPoProjectContext(source, 'po', 'style'))?.name).toBe(NAME)
    expect(source.productionName).not.toHaveBeenCalled()
  })
  it.each(['project', 'season', 'budget'])('019의 다른 프로젝트·시즌·예산 코드 명칭은 사용하지 않는다: %s', async kind => {
    const source = { ...lookup(), productionName: vi.fn(async () => ok({ projectId: kind === 'project' ? OTHER : PROJECT, name: kind === 'budget' ? BUDGET : NAME, season: kind === 'season' ? '2027FY' : '2026FY' })) }
    source.project.mockResolvedValueOnce(ok({ id: PROJECT, name: BUDGET, code: BUDGET, season: '2026FY' }))
    source.orderSources.mockResolvedValueOnce(ok([]))
    expect(await loadPoProjectContext(source, 'po', 'style')).toBeNull()
  })
  it('019 권한·연결 오류는 같은 스타일 조회로 숨기지 않고 발송 전에 실패한다', async () => {
    const source = { ...lookup(), productionName: vi.fn(async () => ({ data: null, error: { code: '42501' } })) }
    source.project.mockResolvedValueOnce(ok({ id: PROJECT, name: BUDGET, code: BUDGET, season: '2026FY' }))
    await expect(loadPoProjectContext(source, 'po', 'style')).rejects.toThrow('PROJECT_LOOKUP_UNAVAILABLE')
  })
  it.each(['conflict', 'season', 'missing'])('M열 후보가 충돌하거나 시즌이 다르거나 없으면 코드를 이름으로 쓰지 않는다: %s', async mode => {
    const source = lookup(); source.project.mockResolvedValueOnce(ok({ id: PROJECT, name: BUDGET, code: BUDGET, season: '2026FY' }))
    source.orderSources.mockResolvedValueOnce(ok([{ rows_data: mode === 'missing' ? [] : [{ columns: { A: BUDGET, M: NAME, L: mode === 'season' ? '2027FY' : '2026FY' } }, ...(mode === 'conflict' ? [{ columns: { A: BUDGET, M: '다른 명칭', L: '2026FY' } }] : [])] }]))
    expect(await loadPoProjectContext(source, 'po', 'style')).toBeNull()
  })
  it('조회 권한·연결 실패를 공식 명칭 없는 데이터로 숨기지 않는다', async () => {
    const source = lookup(); source.linkedRuns.mockResolvedValueOnce({ data: null, error: { code: '42501' } } as never)
    await expect(loadPoProjectContext(source, 'po', 'style')).rejects.toThrow('PROJECT_LOOKUP_UNAVAILABLE')
  })
  it.each(['#REF!', '#N/A', '#VALUE!', '#NAME?'])('원본 M열의 Excel 오류를 생산 명칭으로 전송하지 않는다: %s', async error => {
    const source = lookup(); source.project.mockResolvedValueOnce(ok({ id: PROJECT, name: BUDGET, code: BUDGET, season: '2026FY' }))
    source.orderSources.mockResolvedValueOnce(ok([{ rows_data: [{ columns: { A: BUDGET, M: error, L: '2026FY' } }] }]))
    expect(await loadPoProjectContext(source, 'po', 'style')).toBeNull()
    expect(poProjectPolicyError({ projectId: PROJECT, name: error, budgetCodes: [BUDGET] }, error, error)).toContain('프로젝트 명칭')
  })
  it.each(['subject', 'body'])('새 PO의 %s에 A열 코드가 있으면 M이 함께 있어도 발송을 거부한다', field => {
    const context = { projectId: PROJECT, name: NAME, budgetCodes: [BUDGET] }
    expect(poProjectPolicyError(context, `${NAME}${field === 'subject' ? ` ${BUDGET.toLowerCase()}` : ''}`, `${NAME}${field === 'body' ? ` ${BUDGET}` : ''}`)).toContain('예산 관리 코드')
  })
  it('다른 프로젝트의 표준 예산 코드도 본문에 포함하지 않는다', () => {
    expect(poProjectPolicyError({ projectId: PROJECT, name: NAME, budgetCodes: [BUDGET] }, NAME, `${NAME}\nSIGNIFICANT-2027FY-RPQ-99999`)).toContain('예산 관리 코드')
  })
  it.each([null, { projectId: PROJECT, name: BUDGET, budgetCodes: [BUDGET] }])('명칭 미등록·A를 이름으로 표시하는 PO는 거부한다: %j', context => {
    expect(poProjectPolicyError(context, NAME, NAME)).toContain('프로젝트 명칭')
  })
  it('M은 제목과 본문 모두에 있어야 하며 실제 발송한 저장 문서는 재작성하지 않는다', () => {
    const context = { projectId: PROJECT, name: NAME, budgetCodes: [BUDGET] }
    expect(poProjectPolicyError(context, '작업 요청', NAME)).toContain('제목과 본문')
    expect(poProjectPolicyError(context, NAME, '작업 요청')).toContain('제목과 본문')
    expect(poProjectPolicyError(context, NAME, NAME)).toBeNull()
    expect(context).toEqual({ projectId: PROJECT, name: NAME, budgetCodes: [BUDGET] })
  })
  it('발송 직전 프로젝트 이름·ID·확인한 예산 코드가 같을 때만 진행한다', () => {
    const context = { projectId: PROJECT, name: NAME, budgetCodes: [BUDGET] }
    expect(samePoProjectContext(context, structuredClone(context))).toBe(true)
    expect(samePoProjectContext(context, { ...context, name: '변경된 이름' })).toBe(false)
    expect(samePoProjectContext(context, { ...context, projectId: OTHER })).toBe(false)
    expect(samePoProjectContext(context, { ...context, budgetCodes: [...context.budgetCodes, 'BUDGET-OLD'] })).toBe(false)
    expect(samePoProjectContext(context, null)).toBe(false)
  })
})
