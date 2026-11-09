import { describe, expect, it } from 'vitest'
import { productionContextKey, selectProductionContext } from '../src/lib/production-selection'

const items = [
  { id: 'ot-latest', lineId: 'ot', projectId: 'project-a' },
  { id: 'bk-latest', lineId: 'bk', projectId: 'project-a' },
  { id: 'gr-project-b', lineId: 'gr', projectId: 'project-b' },
  { id: 'gr-latest', lineId: 'gr', projectId: 'project-a' },
  { id: 'gr-earlier', lineId: 'gr', projectId: 'project-a' },
]
const id = (item: typeof items[number]) => item.id

describe('생산 컬러·프로젝트·차수 선택', () => {
  it('GR를 열면 첫 OT나 BK 대신 해당 GR 프로젝트를 선택한다', () => {
    expect(selectProductionContext(items.filter(item => item.id !== 'gr-earlier'), { lineId: 'gr', projectId: 'project-a' }, id)?.id).toBe('gr-latest')
  })
  it('같은 컬러도 클릭한 프로젝트 ID와 정확한 차수로 선택한다', () => {
    expect(selectProductionContext(items, { lineId: 'gr', projectId: 'project-b' }, id)?.id).toBe('gr-project-b')
    expect(selectProductionContext(items, { lineId: 'gr', projectId: 'project-a', runId: 'gr-earlier' }, id)?.id).toBe('gr-earlier')
  })
  it('이전 컬러의 차수 ID가 남아도 다른 컬러 상세를 표시하지 않는다', () => {
    expect(selectProductionContext(items.filter(item => item.id !== 'gr-earlier'), { lineId: 'gr', projectId: 'project-a', runId: 'bk-latest' }, id)?.id).toBe('gr-latest')
  })
  it('같은 컬러·프로젝트에 복수 차수가 있으면 명시적으로 선택하도록 한다', () => {
    expect(selectProductionContext(items, { lineId: 'gr', projectId: 'project-a' }, id)).toBeUndefined()
  })
  it('해당 프로젝트·컬러가 없으면 무관한 첫 생산으로 대체하지 않는다', () => {
    expect(selectProductionContext(items, { lineId: 'gr', projectId: 'missing' }, id)).toBeUndefined()
    expect(selectProductionContext(items, { runId: 'missing' }, id)).toBeUndefined()
    expect(selectProductionContext([], { lineId: 'gr' }, id)).toBeUndefined()
  })
  it('컨텍스트가 없는 기존 호출은 정렬된 첫 항목을 유지한다', () => {
    expect(selectProductionContext(items, {}, id)?.id).toBe('ot-latest')
    expect(productionContextKey({ lineId: 'gr', projectId: 'project-a' })).toBe(productionContextKey({ projectId: 'project-a', lineId: 'gr', runId: '' }))
  })
})
