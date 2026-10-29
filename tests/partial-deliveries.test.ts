import { describe, expect, it } from 'vitest'
import { totalPlanned, validatePartialDeliveries, type PartialDeliveryInstallment } from '../src/lib/partial-deliveries'

const items: PartialDeliveryInstallment[] = [
  { id: 'a', dueDate: '2026-11-10', quantity: 200, note: '1차 입고 예정' },
  { id: 'b', dueDate: '2026-11-20', quantity: 200, note: '2차 입고 예정' },
]
describe('manual partial-delivery installments', () => {
  it('splits a 400-piece order into two dated installments without a new production round', () => {
    expect(() => validatePartialDeliveries(items, 400)).not.toThrow()
    expect(totalPlanned(items)).toBe(400)
  })
  it('rejects totals that disagree with the original order', () => {
    expect(() => validatePartialDeliveries(items, 450)).toThrow(/합계/)
  })
  it('rejects zero, fractional and negative quantities', () => {
    for (const quantity of [0, -10, 0.5, NaN]) {
      expect(() => validatePartialDeliveries([{ ...items[0], quantity }, items[1]], 400)).toThrow()
    }
  })
  it('prevents duplicate identifiers and out-of-order delivery dates', () => {
    expect(() => validatePartialDeliveries([items[0], { ...items[1], id: 'a' }], 400)).toThrow(/중복/)
    expect(() => validatePartialDeliveries([items[1], items[0]], 400)).toThrow(/순서/)
  })
  it('rejects invalid calendar dates', () => {
    expect(() => validatePartialDeliveries([{ ...items[0], dueDate: '2026-02-30' }, items[1]], 400)).toThrow(/납기일/)
  })
})
