import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { assertStyleSave, validateStyle } from '../src/lib/permissions'

describe('스타일 기준 납기의 데이터베이스 형식 일치', () => {
  it('기준 납기 미정은 빈 값으로 보존해 자동 등록과 이후 수량 적용을 허용한다', () => {
    const workspace = createSeed(), style = structuredClone(workspace.styles[0])
    const actor = workspace.profiles.find(profile => profile.id === DEMO_IDS.internal)!
    style.dueDate = ''
    expect(() => validateStyle(style)).not.toThrow()
    const after = structuredClone(style); after.production[0].order.S += 1
    expect(() => assertStyleSave(actor, style, after, 'CSV 오더 수량 적용')).not.toThrow()
    expect(after.dueDate).toBe('')
  })
  it.each(['2026-02-30', '2026-2-03', '2026-13-01', '0000-01-01', '일정 없음', ' ', null, undefined])('명시한 잘못된 납기 %j는 차단한다', value => {
    const style = structuredClone(createSeed().styles[0]); style.dueDate = value as string
    expect(() => validateStyle(style)).toThrow('납기일')
  })
  it('윤년을 포함한 유효한 ISO 날짜는 유지한다', () => {
    const style = structuredClone(createSeed().styles[0]); style.dueDate = '2028-02-29'
    expect(() => validateStyle(style)).not.toThrow()
    expect(style.dueDate).toBe('2028-02-29')
  })
})
