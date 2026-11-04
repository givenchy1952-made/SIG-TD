import { describe, expect, it } from 'vitest'
import { createSeed } from '../src/lib/seed'
import { freshOperations, scopeOperations } from '../src/lib/operations-domain'
import { scopeWorkspace } from '../src/lib/utils'
import type { OperationCatalog } from '../src/lib/operations-types'

function fixture(kind: 'label' | 'embroidery') {
  const workspace = createSeed(), actor = workspace.profiles.find(person => person.role === 'factory')!
  const supplier = { id: 'own-supplier', name: '자기 업체', country: '대한민국', active: true, serviceType: kind }
  workspace.factories.push(supplier, { ...supplier, id: 'other-supplier', name: '다른 업체' }); actor.factoryId = supplier.id
  workspace.operations = freshOperations()
  const catalog = (id: string, supplierFactoryId: string | null, itemKind = kind): OperationCatalog => ({ id, supplierFactoryId, kind: itemKind, name: id, specification: '업체 공통 규격', active: true, version: 1, createdAt: '2026-11-04', updatedAt: '2026-11-04', updatedBy: actor.id })
  workspace.operations.operationCatalogs = [catalog('own-active', supplier.id), { ...catalog('own-inactive', supplier.id), active: false }, catalog('other-private', 'other-supplier'), catalog('legacy-global', null), catalog('wrong-service', supplier.id, kind === 'label' ? 'embroidery' : 'label')]
  return { workspace, actor, supplier }
}
describe('업체 공통 작업 라이브러리의 조회 범위', () => {
  it.each(['label', 'embroidery'] as const)('%s 업체는 생산 스타일 배정 없이도 자기 업무의 공통 작업만 확인한다', kind => {
    const { workspace, actor } = fixture(kind)
    const scoped = scopeWorkspace(workspace, actor)
    expect(scoped.styles).toEqual([])
    expect(scoped.operations?.operationCatalogs.map(item => item.id)).toEqual(['own-active', 'own-inactive'])
    expect(scoped.operations?.styleOperations).toEqual([]); expect(scoped.operations?.poDispatches).toEqual([])
    expect(scoped.operations?.orderSourceRecords).toEqual([])
    expect(JSON.stringify(scoped)).not.toContain('other-private')
  })
  it('공급자와 역할을 위조해도 저장된 자기 업체로만 조회한다', () => {
    const { workspace, actor } = fixture('label')
    expect(scopeOperations(workspace, { ...actor, role: 'admin', factoryId: 'other-supplier' }).operationCatalogs.map(item => item.id)).toEqual(['own-active', 'own-inactive'])
  })
  it('일반 생산 공장과 비활성·검사 업체는 작업 라이브러리를 받지 않는다', () => {
    const { workspace, actor, supplier } = fixture('label')
    supplier.active = false
    expect(scopeOperations(workspace, actor).operationCatalogs).toEqual([])
    supplier.active = true; workspace.factories.find(factory => factory.id === supplier.id)!.serviceType = 'production'
    expect(scopeOperations(workspace, actor).operationCatalogs).toEqual([])
    workspace.factories.find(factory => factory.id === supplier.id)!.serviceType = 'inspection'
    expect(scopeOperations(workspace, actor).operationCatalogs).toEqual([])
  })
  it('본사 작업 목록을 보존하며 승인 해제된 자기 계정은 위조해도 빈 목록이다', () => {
    const { workspace, actor } = fixture('label')
    const hq = workspace.profiles.find(person => person.role === 'admin')!
    expect(scopeOperations(workspace, hq).operationCatalogs).toHaveLength(5)
    actor.approved = false
    expect(scopeOperations(workspace, { ...actor, approved: true }).operationCatalogs).toEqual([])
  })
})
