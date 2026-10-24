import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { saveSettlementTermsInWorkspace, scopeSettlementTermsWorkspace, validateSettlementTerms } from '../src/lib/settlement-domain'
import type { SettlementTermsInput, SettlementWorkspace } from '../src/lib/settlement-types'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadSettlementTermsWorkspace } from '../src/lib/settlement-cloud'

const input = (overrides: Partial<SettlementTermsInput> = {}): SettlementTermsInput => ({ projectCode: 'TEST-PROJECT-2026', unitCost: 1234.56, itemType: 'product', ...overrides })
function fixture() {
  const workspace: SettlementWorkspace = { ...createSeed(), settlementTerms: [], settlementTermsAudits: [], settlementTermsAvailable: true }
  return { workspace, admin: workspace.profiles.find(item => item.id === DEMO_IDS.admin)!, internal: workspace.profiles.find(item => item.id === DEMO_IDS.internal)!, factory: workspace.profiles.find(item => item.id === DEMO_IDS.factory)!, pending: workspace.profiles.find(item => !item.approved)!, style: workspace.styles[0], line: workspace.styles[0].production[0] }
}
describe('을지 정산 정보 도메인', () => {
  it.each([null, 0, 0.01, 7.12, 1000000000])('단가 %s를 미기재와 0을 구분하여 허용한다', unitCost => expect(() => validateSettlementTerms(input({ unitCost }))).not.toThrow())
  it.each([-1, 0.001, 1000000000.01, NaN, Infinity, '10'])('잘못된 단가 %s를 거부한다', unitCost => expect(() => validateSettlementTerms(input({ unitCost: unitCost as number }))).toThrow('장당 원가'))
  it('알 수 없는 키·프로젝트 제어문자·너무 긴 코드·종류를 거부한다', () => {
    expect(() => validateSettlementTerms({ ...input(), invoiceAmount: 500 } as SettlementTermsInput)).toThrow()
    expect(() => validateSettlementTerms(input({ projectCode: 'A\nB' }))).toThrow()
    expect(() => validateSettlementTerms(input({ projectCode: 'a'.repeat(121) }))).toThrow()
    expect(() => validateSettlementTerms(input({ itemType: 'other' as SettlementTermsInput['itemType'] }))).toThrow()
  })
  it('본사에서 단가를 저장해도 기존 오더·입고·마감 금액은 바뀌지 않는다', () => {
    const { workspace, internal, style, line } = fixture(), original = structuredClone(workspace)
    const next = saveSettlementTermsInWorkspace(workspace, internal, style.id, line.id, input({ projectCode: '  TEST-PROJECT  ' }), 0, '단가 확정')
    expect(workspace).toEqual(original)
    expect(next.styles).toEqual(workspace.styles)
    expect(next.settlementTerms![0]).toMatchObject({ projectCode: 'TEST-PROJECT', unitCost: 1234.56, itemType: 'product', version: 1, updatedBy: internal.id })
    expect(next.settlementTermsAudits![0].before).toBeNull()
    expect(next.settlementTermsAudits![0].after.unitCost).toBe(1234.56)
  })
  it('수정 전후 값·사유를 본사 이력에 보존하고 오래된 버전을 거부한다', () => {
    const { workspace, admin, style, line } = fixture()
    const first = saveSettlementTermsInWorkspace(workspace, admin, style.id, line.id, input(), 0, '첫 단가')
    const second = saveSettlementTermsInWorkspace(first, admin, style.id, line.id, input({ unitCost: 0, itemType: 'fabric' }), 1, '무상 원단')
    expect(second.settlementTerms![0].version).toBe(2)
    expect(second.settlementTerms![0].createdAt).toBe(first.settlementTerms![0].createdAt)
    expect(second.settlementTermsAudits![0]).toMatchObject({ before: { unitCost: 1234.56 }, after: { unitCost: 0 }, reason: '무상 원단' })
    expect(() => saveSettlementTermsInWorkspace(second, admin, style.id, line.id, input(), 1, '충돌 변경')).toThrow('VERSION_CONFLICT')
  })
  it('일반 감사 기록에는 단가·프로젝트 코드·민감한 변경 사유를 노출하지 않는다', () => {
    const { workspace, admin, style, line } = fixture()
    const next = saveSettlementTermsInWorkspace(workspace, admin, style.id, line.id, input({ projectCode: 'CONFIDENTIAL-CODE', unitCost: 987654.32 }), 0, '비밀 단가 987654.32')
    expect(JSON.stringify(next.audits[0])).not.toMatch(/987654|CONFIDENTIAL|비밀/)
    expect(next.settlementTermsAudits![0].reason).toBe('비밀 단가 987654.32')
  })
  it('본사·관리자만 단가와 전체 감사 이력을 보고 공장·승인 전·삭제 후에는 숨긴다', () => {
    const { workspace, admin, internal, factory, pending, style, line } = fixture()
    const next = saveSettlementTermsInWorkspace(workspace, admin, style.id, line.id, input(), 0, '단가 확정')
    for (const profile of [admin, internal]) {
      expect(scopeSettlementTermsWorkspace(next, profile).settlementTerms).toHaveLength(1)
      expect(scopeSettlementTermsWorkspace(next, profile).settlementTermsAudits).toHaveLength(1)
    }
    for (const profile of [factory, pending, { ...admin, active: false }]) {
      expect(scopeSettlementTermsWorkspace(next, profile)).toEqual({ settlementTerms: [], settlementTermsAudits: [], settlementTermsAvailable: true })
    }
    next.styles[0].deletedAt = new Date().toISOString()
    expect(scopeSettlementTermsWorkspace(next, admin).settlementTerms).toHaveLength(0)
    expect(scopeSettlementTermsWorkspace(next, admin).settlementTermsAudits).toHaveLength(0)
  })
  it('공장·승인 전·비활성 계정과 전달한 위조 역할을 거부한다', () => {
    const { workspace, admin, factory, pending, style, line } = fixture()
    for (const profile of [factory, pending, { ...factory, role: 'admin' as const }]) expect(() => saveSettlementTermsInWorkspace(workspace, profile, style.id, line.id, input(), 0, '권한 검사')).toThrow()
    workspace.profiles = workspace.profiles.map(profile => profile.id === admin.id ? { ...profile, active: false } : profile)
    expect(() => saveSettlementTermsInWorkspace(workspace, admin, style.id, line.id, input(), 0, '권한 검사')).toThrow()
  })
  it('삭제된 스타일·없는 컬러·짧은 사유·비정상 버전에서 원본을 보존한다', () => {
    const { workspace, admin, style, line } = fixture()
    expect(() => saveSettlementTermsInWorkspace(workspace, admin, style.id, crypto.randomUUID(), input(), 0, '컬러 검사')).toThrow()
    expect(() => saveSettlementTermsInWorkspace(workspace, admin, style.id, line.id, input(), 0, 'a')).toThrow()
    expect(() => saveSettlementTermsInWorkspace(workspace, admin, style.id, line.id, input(), -1, '버전 검사')).toThrow()
    workspace.styles[0].deletedAt = new Date().toISOString()
    expect(() => saveSettlementTermsInWorkspace(workspace, admin, style.id, line.id, input(), 0, '삭제 검사')).toThrow()
    expect(workspace.settlementTerms).toEqual([])
    expect(workspace.settlementTermsAudits).toEqual([])
  })
})

describe('을지 단가 클라우드 읽기', () => {
  type Result = { data: Record<string, unknown>[] | null; error: { code: string; message: string } | null }
  function client(read: (table: string, from: number, to: number) => Result) {
    return { from(table: string) { const query = { select() { return query }, order() { return query }, async range(from: number, to: number) { return read(table, from, to) } }; return query } } as unknown as SupabaseClient
  }
  const row = { style_id: 'style-test', line_id: 'line-test', project_code: 'TEST', unit_cost: '7.12', item_type: 'product', version: 1, created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z', updated_by: DEMO_IDS.admin }
  it('이전 스키마에서 새 기능만 비활성화하며 일부 단가를 노출하지 않는다', async () => {
    const loaded = await loadSettlementTermsWorkspace(client(table => table === 'settlement_terms' ? { data: [row], error: null } : { data: null, error: { code: '42P01', message: 'missing table' } }))
    expect(loaded).toEqual({ settlementTerms: [], settlementTermsAudits: [], settlementTermsAvailable: false })
  })
  it('500행을 넘겨 읽고 단가 및 전후 감사 스냅샷을 변환한다', async () => {
    const calls: [string, number, number][] = []
    const loaded = await loadSettlementTermsWorkspace(client((table, from, to) => {
      calls.push([table, from, to])
      if (table === 'settlement_terms') return { data: from === 0 ? Array.from({ length: 500 }, (_, index) => ({ ...row, line_id: String(index) })) : [{ ...row, unit_cost: null }], error: null }
      return { data: [{ id: 'audit-test', style_id: row.style_id, line_id: row.line_id, actor_id: DEMO_IDS.admin, actor_name: '테스트 본사', reason: '단가 변경', before: null, after: row, created_at: row.created_at }], error: null }
    }))
    expect(loaded.settlementTermsAvailable).toBe(true)
    expect(loaded.settlementTerms).toHaveLength(501)
    expect(loaded.settlementTerms[0]).toMatchObject({ unitCost: 7.12, projectCode: 'TEST' })
    expect(loaded.settlementTerms[500].unitCost).toBeNull()
    expect(loaded.settlementTermsAudits[0]).toMatchObject({ actorName: '테스트 본사', before: null, after: { unitCost: 7.12, styleId: row.style_id } })
    expect(calls).toContainEqual(['settlement_terms', 500, 999])
  })
  it('권한·네트워크 오류를 미적용 스키마로 숨기지 않는다', async () => {
    await expect(loadSettlementTermsWorkspace(client(() => ({ data: null, error: { code: '42501', message: 'permission denied' } })))).rejects.toMatchObject({ code: '42501' })
  })
})
