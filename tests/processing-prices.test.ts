import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { freshOperations } from '../src/lib/operations-domain'
import { blankProductionDetails } from '../src/lib/workflow-refinements'
import {
  findProcessingUnitPrice, saveProcessingUnitPriceInWorkspace,
  scopeProcessingPricesWorkspace, type ProcessingPriceKind,
  type ProcessingPricesWorkspaceFields,
} from '../src/lib/processing-prices'
import type { OperationRow } from '../src/lib/operations-types'
import type { Profile, Workspace } from '../src/lib/types'

type PricingWorkspace = Workspace & ProcessingPricesWorkspaceFields
const LABEL = '71000000-0000-4000-8000-000000000001'
const LABEL_SECOND = '71000000-0000-4000-8000-000000000002'
const EMBROIDERY = '71000000-0000-4000-8000-000000000003'
const stamp = { version: 1, createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z', updatedBy: DEMO_IDS.admin }
const row = (id: string): OperationRow => ({ id, catalogId: id, name: `QA ${id}`, specification: 'QA 단가 검증', quantity: 290, lossQuantity: 3, completedQuantity: 277, status: 'done', orderedAt: '', requestedAt: '', completedAt: '2026-10-28', dueDate: '', note: '' })

function fixture() {
  const workspace: PricingWorkspace = createSeed()
  const admin = workspace.profiles.find(profile => profile.id === DEMO_IDS.admin)!
  const internal = workspace.profiles.find(profile => profile.id === DEMO_IDS.internal)!
  const factory = workspace.profiles.find(profile => profile.id === DEMO_IDS.factory)!
  const style = workspace.styles.find(item => item.factoryId === factory.factoryId && item.production.length > 1)!
  const otherStyle = workspace.styles.find(item => item.factoryId !== factory.factoryId)!
  const line = style.production[0], otherLine = style.production[1]
  workspace.processingPricesAvailable = true
  workspace.processingUnitPrices = []
  workspace.operations = freshOperations()
  workspace.operations.styleOperations = [
    { ...stamp, id: crypto.randomUUID(), styleId: style.id, kind: 'label', rows: [row(LABEL), row(LABEL_SECOND)], note: '', voided: false },
    { ...stamp, id: crypto.randomUUID(), styleId: style.id, kind: 'embroidery', rows: [row(EMBROIDERY)], note: '', voided: false },
    { ...stamp, id: crypto.randomUUID(), styleId: otherStyle.id, kind: 'label', rows: [row(LABEL)], note: '', voided: false },
  ]
  workspace.productionDetails = style.production.map(item => ({ ...stamp, ...blankProductionDetails(), styleId: style.id, lineId: item.id, quality: { category: '아우터', quantity: 277, status: 'done', requestedAt: '', completedAt: '2026-10-28', note: '' } }))
  return { workspace, admin, internal, factory, style, line, otherLine, otherStyle }
}

function save(workspace: PricingWorkspace, actor: Profile, styleId: string, lineId: string, kind: ProcessingPriceKind = 'label', itemKey = LABEL, unitCost: number | null = 1234.56, expected = 0, reason = 'QA 작업 단가 등록') {
  return saveProcessingUnitPriceInWorkspace(workspace, actor, styleId, lineId, kind, itemKey, unitCost, expected, reason)
}

describe('가공·품질 단가 저장과 유지', () => {
  it('본사·배정 공장은 단가만 저장하고 원본 수량·작업·원장·승인 자료를 그대로 보존한다', () => {
    for (const role of ['admin', 'internal', 'factory'] as const) {
      const { workspace, style, line, ...actors } = fixture(), before = structuredClone(workspace)
      const result = save(workspace, actors[role], style.id, line.id)
      expect(workspace).toEqual(before)
      expect(result.styles).toEqual(before.styles)
      expect(result.operations).toEqual(before.operations)
      expect(result.productionDetails).toEqual(before.productionDetails)
      expect(result.settlementTerms).toEqual(before.settlementTerms)
      expect(result.productionRuns).toEqual(before.productionRuns)
      expect(result.productionReceipts).toEqual(before.productionReceipts)
      expect(result.processingUnitPrices).toHaveLength(1)
      expect(findProcessingUnitPrice(result, style.id, line.id, 'label', LABEL)).toMatchObject({ styleId: style.id, lineId: line.id, kind: 'label', itemKey: LABEL, unitCost: 1234.56, version: 1, updatedBy: actors[role].id })
    }
  })

  it('저장된 단가는 조회를 반복해도 유지하고 명시적으로 수정할 때에만 값과 버전이 바뀐다', () => {
    const { workspace, factory, style, line } = fixture()
    const first = save(workspace, factory, style.id, line.id), before = structuredClone(first)
    for (let i = 0; i < 3; i++) expect(findProcessingUnitPrice(first, style.id, line.id, 'label', LABEL)?.unitCost).toBe(1234.56)
    expect(first).toEqual(before)
    const second = save(first, factory, style.id, line.id, 'label', LABEL, 2345.67, 1, 'QA 명시적 단가 수정')
    const record = findProcessingUnitPrice(second, style.id, line.id, 'label', LABEL)!
    expect(record).toMatchObject({ unitCost: 2345.67, version: 2, createdAt: first.processingUnitPrices![0].createdAt })
    expect(first).toEqual(before)
  })

  it('컬러·작업 행·작업 종류가 다르면 단가를 별도로 보존하고 제품 원가를 상속하지 않는다', () => {
    const { workspace, admin, style, line, otherLine } = fixture()
    let next = save(workspace, admin, style.id, line.id, 'label', LABEL, 100)
    next = save(next, admin, style.id, otherLine.id, 'label', LABEL, 200)
    next = save(next, admin, style.id, line.id, 'label', LABEL_SECOND, 300)
    next = save(next, admin, style.id, line.id, 'embroidery', EMBROIDERY, 400)
    next = save(next, admin, style.id, line.id, 'quality', '아우터', 500)
    expect(next.processingUnitPrices).toHaveLength(5)
    expect(findProcessingUnitPrice(next, style.id, line.id, 'label', LABEL)?.unitCost).toBe(100)
    expect(findProcessingUnitPrice(next, style.id, otherLine.id, 'label', LABEL)?.unitCost).toBe(200)
    expect(findProcessingUnitPrice(next, style.id, otherLine.id, 'quality', '아우터')).toBeUndefined()
  })

  it('미기재 null과 합의한 0원 및 소수 둘째 자리 단가를 구분한다', () => {
    for (const unitCost of [null, 0, 0.01, 50.5, 1_000_000_000]) {
      const { workspace, admin, style, line } = fixture()
      expect(findProcessingUnitPrice(save(workspace, admin, style.id, line.id, 'label', LABEL, unitCost), style.id, line.id, 'label', LABEL)?.unitCost).toBe(unitCost)
    }
  })

  it.each([-1, 1_000_000_000.01, 1.001, Infinity, -Infinity, NaN, '1500', '', true, {}, []])('잘못된 가격 %j를 숫자로 강제 변환하지 않고 거부한다', value => {
    const { workspace, admin, style, line } = fixture(), before = structuredClone(workspace)
    expect(() => save(workspace, admin, style.id, line.id, 'label', LABEL, value as number)).toThrow()
    expect(workspace).toEqual(before)
  })

  it('현재 버전이 다르거나 유효하지 않으면 덮어쓰지 않는다', () => {
    const { workspace, admin, style, line } = fixture(), saved = save(workspace, admin, style.id, line.id)
    for (const expected of [0, -1, 1.5, NaN, Infinity]) expect(() => save(saved, admin, style.id, line.id, 'label', LABEL, 900, expected)).toThrow()
    expect(findProcessingUnitPrice(saved, style.id, line.id, 'label', LABEL)?.unitCost).toBe(1234.56)
  })

  it.each(['', ' ', '한', 'x'.repeat(1001)])('변경 사유 %j를 거부한다', reason => {
    const { workspace, admin, style, line } = fixture()
    expect(() => save(workspace, admin, style.id, line.id, 'label', LABEL, 100, 0, reason)).toThrow()
  })
})

describe('가공·품질 단가의 권한과 대상 검사', () => {
  it('존재하지 않는 계정·미승인·비활성 계정과 타 공장은 저장할 수 없다', () => {
    const { workspace, factory, style, line, otherStyle } = fixture()
    expect(() => save(workspace, { ...factory, id: crypto.randomUUID() }, style.id, line.id)).toThrow()
    for (const field of ['approved', 'active'] as const) {
      const modified = structuredClone(workspace)
      modified.profiles.find(item => item.id === factory.id)![field] = false
      expect(() => save(modified, factory, style.id, line.id)).toThrow()
    }
    expect(() => save(workspace, factory, otherStyle.id, otherStyle.production[0].id)).toThrow()
  })

  it('전달한 역할을 관리자로 위조해도 저장된 공장 배정과 활성 상태를 따른다', () => {
    const { workspace, factory, style, line, otherStyle } = fixture()
    expect(() => save(workspace, { ...factory, role: 'admin', factoryId: null }, otherStyle.id, otherStyle.production[0].id)).toThrow()
    workspace.profiles.find(item => item.id === factory.id)!.active = false
    expect(() => save(workspace, { ...factory, role: 'admin', active: true }, style.id, line.id)).toThrow()
  })

  it('접근 가능한 현재 스타일·컬러에 연결된 실제 작업 또는 현재 검사 대상만 저장한다', () => {
    const { workspace, admin, style, line } = fixture()
    expect(() => save(workspace, admin, crypto.randomUUID(), line.id)).toThrow()
    expect(() => save(workspace, admin, style.id, crypto.randomUUID())).toThrow()
    expect(() => save(workspace, admin, style.id, line.id, 'unknown' as ProcessingPriceKind)).toThrow()
    expect(() => save(workspace, admin, style.id, line.id, 'label', EMBROIDERY)).toThrow()
    expect(() => save(workspace, admin, style.id, line.id, 'label', crypto.randomUUID())).toThrow()
    expect(() => save(workspace, admin, style.id, line.id, 'quality', '바지')).toThrow()
    workspace.operations!.styleOperations[0].voided = true
    expect(() => save(workspace, admin, style.id, line.id)).toThrow()
    workspace.styles.find(item => item.id === style.id)!.deletedAt = '2026-10-28T10:00:00Z'
    expect(() => save(workspace, admin, style.id, line.id, 'quality', '아우터')).toThrow()
  })

  it('현재 공장 배정 범위만 조회하고 탈퇴·비활성 계정은 모든 단가를 숨긴다', () => {
    const { workspace, admin, factory, style, line, otherStyle } = fixture()
    let saved = save(workspace, admin, style.id, line.id)
    saved = save(saved, admin, otherStyle.id, otherStyle.production[0].id)
    expect(scopeProcessingPricesWorkspace(saved, admin).processingUnitPrices).toHaveLength(2)
    expect(scopeProcessingPricesWorkspace(saved, factory).processingUnitPrices).toHaveLength(1)
    expect(scopeProcessingPricesWorkspace(saved, { ...factory, role: 'admin' }).processingUnitPrices).toHaveLength(1)
    saved.profiles.find(item => item.id === factory.id)!.active = false
    expect(scopeProcessingPricesWorkspace(saved, { ...factory, active: true }).processingUnitPrices).toEqual([])
  })

  it('공개 스타일 변경 이력에는 원문 단가를 넣지 않는다', () => {
    const { workspace, factory, style, line } = fixture(), saved = save(workspace, factory, style.id, line.id, 'label', LABEL, 98765.43, 0, 'QA 업체 합의 단가 98765.43원 등록')
    const added = saved.audits.slice(0, saved.audits.length - workspace.audits.length)
    expect(added).toHaveLength(1)
    expect(JSON.stringify(added)).not.toContain('98765.43')
    expect(JSON.stringify(added)).not.toContain('unitCost')
  })
})
