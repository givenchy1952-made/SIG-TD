import { describe, expect, it } from 'vitest'
import { isBudgetAmount, multiplyBudgetCost, roundBudgetMoney, sumBudgetMoney } from '../src/lib/budget-money'

describe('원가 단가 × 요척의 소수 6자리 계산', () => {
  it('단가 2자리와 요척 4자리의 곱을 추가 수량 없이 정확하게 유지한다', () => {
    expect(multiplyBudgetCost(333.33, 0.0003)).toBe(0.099999)
    expect(multiplyBudgetCost(0.29, 0.1)).toBe(0.029)
    expect(multiplyBudgetCost(123.45, 1.2345)).toBe(152.399025)
    expect(multiplyBudgetCost(0, 0.0001)).toBe(0)
    expect(multiplyBudgetCost(123.45, 0)).toBe(0)
  })
  it('마이크로 단위 합계와 잔액에서 소수점을 버리거나 부동소수 오차를 남기지 않는다', () => {
    expect(sumBudgetMoney([0.099999, 0.000001])).toBe(0.1)
    expect(sumBudgetMoney([0.3, -0.099999])).toBe(0.200001)
    expect(sumBudgetMoney([0.1, 0.2])).toBe(0.3)
    expect(sumBudgetMoney([])).toBe(0)
  })
  it('마이크로 단위가 안전 정수보다 크더라도 실제 예산 한도와 억 단위 잔액을 유지한다', () => {
    expect(sumBudgetMoney([8_948_600_478, -6_252_231_098])).toBe(2_696_369_380)
    expect(sumBudgetMoney([500_000_000_000.01, 400_000_000_000.01])).toBe(900_000_000_000.02)
    expect(sumBudgetMoney([9_000_000_000, 0.12])).toBe(9_000_000_000.12)
  })
  it('정확히 표현하지 못하는 총액을 반올림해서 저장하지 않고 오류를 알린다', () => {
    expect(() => sumBudgetMoney([1_000_000_000_000, 0.000001])).toThrow('정확한 계산 범위')
    expect(() => sumBudgetMoney([Number.MAX_SAFE_INTEGER, 1])).toThrow('정확한 계산 범위')
    expect(() => multiplyBudgetCost(1_000_000_000_000, 2)).toThrow('정확한 계산 범위')
  })
  it('진짜 일곱째 자리 금액과 잘못된 단가·요척은 거부한다', () => {
    expect(isBudgetAmount(0.000001, 6)).toBe(true)
    expect(isBudgetAmount(0.0000001, 6)).toBe(false)
    expect(isBudgetAmount(1.001, 2)).toBe(false)
    for (const price of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.001]) expect(() => multiplyBudgetCost(price, 1)).toThrow()
    for (const consumption of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.00001]) expect(() => multiplyBudgetCost(1, consumption)).toThrow()
    expect(() => sumBudgetMoney([0.0000001])).toThrow('소수 자릿수')
  })
  it('기존 계산값의 한 비트 표현 오차와 기존 VAT 3자리는 보존한다', () => {
    expect(sumBudgetMoney([12_000 * 1.1])).toBe(13200)
    expect(sumBudgetMoney([0.1 + 0.2])).toBe(0.3)
    expect(roundBudgetMoney(0.29 / 10, 3)).toBe(0.029)
    expect(sumBudgetMoney([86.38, 8.638])).toBe(95.018)
  })
})
