import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { financeOnlyWorkspace } from '../src/lib/finance-workspace'
import { scopeWorkspace } from '../src/lib/utils'

describe('FA팀 최소 예산 워크스페이스', () => {
  it('생산 원본과 다른 사용자 정보를 전달하지 않고 예산 조회 자료만 유지한다', () => {
    const workspace = { ...createSeed({ includeFinance: true }), budgetAvailable: true, financeRoleAvailable: true,
      budgetSources: { orders: [], settlements: [], warnings: ['예산 확인 사항'] }, budgetRecords: [], budgetAudits: [] }
    const finance = workspace.profiles.find(person => person.id === DEMO_IDS.finance)!
    const before = structuredClone(workspace)
    const scoped = scopeWorkspace(workspace, finance)
    expect(scoped.profiles).toEqual([finance])
    for (const key of ['styles', 'projects', 'factories', 'comments', 'attachments', 'audits'] as const) expect(scoped[key]).toEqual([])
    expect(scoped.operations).toBeUndefined()
    expect(scoped.productionRuns).toBeUndefined()
    expect(scoped.budgetSources).toEqual(workspace.budgetSources)
    expect(scoped.budgetAvailable).toBe(true)
    expect(workspace).toEqual(before)
  })

  it('호출자가 관리자 역할을 주장해도 현재 FA 계정의 원본 권한은 늘지 않는다', () => {
    const workspace = { ...createSeed({ includeFinance: true }), budgetAvailable: true }
    const finance = workspace.profiles.find(person => person.id === DEMO_IDS.finance)!
    const scoped = scopeWorkspace(workspace, { ...finance, role: 'admin' })
    expect(scoped.styles).toEqual([])
    expect(scoped.profiles).toEqual([finance])
    expect(scoped.budgetSources?.orders.length).toBeGreaterThan(0)
    expect(JSON.stringify(scoped)).not.toContain('체험용 예시 데이터 · 실제 생산 및 결제 자료가 아닙니다.')
  })

  it('권한 회수 후 과거 재무 조회 자료를 반환하지 않는다', () => {
    const workspace = { ...createSeed({ includeFinance: true }), budgetAvailable: true,
      budgetSources: { orders: [], settlements: [], warnings: ['과거 정보'] } }
    const finance = workspace.profiles.find(person => person.id === DEMO_IDS.finance)!
    finance.active = false
    const scoped = financeOnlyWorkspace(workspace, { ...finance, active: true })
    expect(scoped.budgetAvailable).toBe(false)
    expect(scoped.budgetSources).toEqual({ orders: [], settlements: [], warnings: [] })
    expect(scoped.budgetRecords).toEqual([])
    expect(scoped.budgetAudits).toEqual([])
  })
})
