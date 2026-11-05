import { describe, expect, it } from 'vitest'
import { createSeed } from '../src/lib/seed'
import type { ProductionRun } from '../src/lib/production-ledger'
import type { PoDispatch } from '../src/lib/operations-types'
import { EMPTY_OPERATIONS } from '../src/lib/operations-types'
import { poUsesProductionName, resolvePoProductionProject } from '../src/lib/po-project-context'

function fixture() {
  const workspace = createSeed(), style = workspace.styles[0], [current, previous] = workspace.projects
  current.name = '현재 생산 명칭'; current.code = 'BUDGET-CURRENT'; previous.name = '이전 생산 명칭'; previous.code = 'BUDGET-PREVIOUS'
  style.projectId = current.id
  const po = { id: 'po', styleId: style.id } as PoDispatch
  workspace.operations = structuredClone(EMPTY_OPERATIONS)
  workspace.operations!.poDispatches = [po]
  workspace.operations!.orderSourceRecords = []
  workspace.productionRuns = [{ id: 'run', poId: po.id, styleId: style.id, projectId: previous.id, projectCode: previous.code, snapshot: null } as ProductionRun]
  workspace.productionPoContexts = []
  return { workspace, style, current, previous, po }
}

describe('PO별 생산 명칭 문맥', () => {
  it('현재 스타일의 프로젝트가 바뀌어도 연결된 차수의 M을 사용하고 원본을 바꾸지 않는다', () => {
    const { workspace, style, current, previous, po } = fixture(), before = structuredClone(workspace)
    const context = resolvePoProductionProject(workspace, style, po.id)
    expect(context?.identity.id).toBe(previous.id)
    expect(poUsesProductionName({ subject: `[PO] ${previous.name}`, body: `${previous.name} 생산 요청` }, context)).toBe(true)
    expect(poUsesProductionName({ subject: `[PO] ${current.name}`, body: `${current.name} 생산 요청` }, context)).toBe(false)
    expect(workspace).toEqual(before)
  })
  it('새 복사용 문맥은 현재 프로젝트를 사용하고 이전 캡처의 문맥을 재사용하지 않는다', () => {
    const { workspace, style, current, previous, po } = fixture()
    expect(resolvePoProductionProject(workspace, style)?.identity.id).toBe(current.id)
    expect(resolvePoProductionProject(workspace, style, po.id)?.identity.id).toBe(previous.id)
  })
  it('차수와 캡처된 프로젝트가 다르면 현재 프로젝트로 추정하지 않는다', () => {
    const { workspace, style, current, po } = fixture()
    workspace.productionPoContexts = [{ poId: po.id, source: 'style', capturedAt: '', snapshot: { styleId: style.id, projectId: current.id, projectCode: current.code!, factoryId: style.factoryId, runId: null, lineId: null, styleCode: style.code, color: null, order: null, lines: [], productionMode: null } }]
    expect(resolvePoProductionProject(workspace, style, po.id)).toBeNull()
  })
  it('연결 차수가 없는 이전 일반 PO도 작성 당시 캡처의 프로젝트를 사용한다', () => {
    const { workspace, style, previous, po } = fixture()
    workspace.productionRuns = []
    workspace.productionPoContexts = [{ poId: po.id, source: 'style', capturedAt: '', snapshot: { styleId: style.id, projectId: previous.id, projectCode: previous.code!, factoryId: style.factoryId, runId: null, lineId: null, styleCode: style.code, color: null, order: null, lines: [], productionMode: null } }]
    expect(resolvePoProductionProject(workspace, style, po.id)?.identity.id).toBe(previous.id)
  })
  it('현재·과거·고정 예산 코드와 M 미등록 자료는 발송 문맥으로 사용하지 않는다', () => {
    const { workspace, style, current, previous, po } = fixture()
    const context = resolvePoProductionProject(workspace, style, po.id)
    for (const code of [current.code!, previous.code!, 'SIGNIFICANT-2026FY-RPQ-46318']) {
      expect(poUsesProductionName({ subject: `[PO] ${previous.name}`, body: `${previous.name} ${code}` }, context)).toBe(false)
    }
    previous.name = previous.code!
    expect(poUsesProductionName({ subject: `[PO] ${previous.code}`, body: previous.code! }, resolvePoProductionProject(workspace, style, po.id))).toBe(false)
  })
  it('소속 스타일이 다른 차수나 문서는 조회 범위를 넓혀 해석하지 않는다', () => {
    const { workspace, style, po } = fixture()
    workspace.productionRuns![0].styleId = 'another-style'
    expect(resolvePoProductionProject(workspace, style, po.id)).toBeNull()
    expect(resolvePoProductionProject(workspace, style, 'missing-po')).toBeNull()
  })
})
