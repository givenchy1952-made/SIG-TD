import { describe, expect, it } from 'vitest'
import { createSeed } from '../src/lib/seed'
import { fullStyleSku, styleColorRows } from '../src/lib/style-identity'
import { quantityTotal } from '../src/lib/types'

describe('color-inclusive style identity', () => {
  it('shows the complete F-column SKU and keeps different colors distinct', () => {
    expect(fullStyleSku('BP06FYHD0402', 'BL')).toBe('BP06FYHD0402BL')
    expect(fullStyleSku('BP06FYHD0402', 'BK')).toBe('BP06FYHD0402BK')
    expect(fullStyleSku('BP06FYHD0402')).toBe('BP06FYHD0402')
  })

  it('does not append the same suffix twice to legacy complete SKUs', () => {
    expect(fullStyleSku('BP06FYHD0402BL', 'BL')).toBe('BP06FYHD0402BL')
    expect(fullStyleSku('bp06fyhd0402bl', 'BL')).toBe('bp06fyhd0402bl')
    expect(fullStyleSku('LABEL', 'EL')).toBe('LABELEL')
  })

  it('returns independent color rows without duplicating stored styles or quantities', () => {
    const style = createSeed().styles[0]
    const before = structuredClone(style)
    style.production[0].order.M = 13
    style.production[1].order.M = 29
    const expected = style.production.reduce((total, line) => total + quantityTotal(line.order), 0)
    const rows = styleColorRows(style)
    expect(rows).toHaveLength(2)
    expect(rows.map(row => fullStyleSku(row.style.code, row.color))).toEqual([`${style.code}BK`, `${style.code}OT`])
    expect(rows.map(row => row.line?.order.M)).toEqual([13, 29])
    expect(rows.reduce((total, row) => total + quantityTotal(row.line!.order), 0)).toBe(expected)
    expect(new Set(rows.map(row => row.style.id)).size).toBe(1)
    expect(style.samples).toEqual(before.samples)
  })

  it('retains zero-quantity colors and styles with no production lines', () => {
    const style = createSeed().styles[0]
    style.production = []
    expect(styleColorRows(style).map(row => row.color)).toEqual(['BK', 'OT'])
    style.colors = []
    expect(styleColorRows(style)).toEqual([{ style, color: '' }])
  })
})
