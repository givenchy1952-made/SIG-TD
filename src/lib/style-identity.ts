import type { ProductionLine, Style } from './types'

/** Keep the stored base style and color separate, while showing the complete
 * source SKU. Older records may already contain the two-letter color suffix. */
export function fullStyleSku(code: string, color?: string): string {
  if (!color) return code
  const normalizedCode = code.toUpperCase(), normalizedColor = color.toUpperCase()
  if (/\d[A-Z]{2}$/.test(normalizedCode) && normalizedCode.endsWith(normalizedColor)) return code
  return `${code}${color}`
}

export interface StyleColorRow { style: Style; line?: ProductionLine; color: string }

/** One visible row per color, including zero-quantity colors. No stored style,
 * production line, order quantity, or sample history is duplicated. */
export function styleColorRows(style: Style): StyleColorRow[] {
  if (style.production.length) return style.production.map(line => ({ style, line, color: line.color }))
  return style.colors.length ? style.colors.map(color => ({ style, color })) : [{ style, color: '' }]
}
