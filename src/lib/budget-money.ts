/** Decimal arithmetic for cost amounts. Number values are interpreted as their
 * stored decimal text, matching PostgreSQL numeric and Excel cached values. */
interface Decimal { units: bigint; scale: number }
const precisionError = () => new Error('원가 금액의 소수 자릿수를 확인해 주세요. 단가는 2자리, 요척량은 4자리, 계산 금액은 6자리까지 지원합니다.')
const rangeError = () => new Error('예산 집계 금액이 정확한 계산 범위를 초과했습니다. 금액 또는 조회 범위를 나누어 확인해 주세요.')

function decimal(value: number): Decimal {
  if (!Number.isFinite(value)) throw precisionError()
  const parts = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value))
  if (!parts) throw precisionError()
  const fraction = parts[3] || ''
  let units = BigInt(parts[2] + fraction) * (parts[1] ? -1n : 1n), scale = fraction.length - Number(parts[4] || 0)
  if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0 }
  while (scale > 0 && units % 10n === 0n) { units /= 10n; scale -= 1 }
  return { units, scale }
}
function scaled(value: number, precision: number): bigint {
  const parsed = decimal(value)
  if (parsed.scale > precision) throw precisionError()
  return parsed.units * 10n ** BigInt(precision - parsed.scale)
}
function decimalText(units: bigint, precision: number): string {
  const sign = units < 0n ? '-' : '', digits = (units < 0n ? -units : units).toString().padStart(precision + 1, '0')
  if (precision === 0) return sign + digits
  const fraction = digits.slice(-precision).replace(/0+$/, '')
  return `${sign}${digits.slice(0, -precision)}${fraction ? `.${fraction}` : ''}`
}
function asNumber(units: bigint, precision: number): number {
  const value = Number(decimalText(units, precision))
  // Scaled units may exceed MAX_SAFE_INTEGER for ordinary billion-won totals.
  // Check the final decimal round trip instead of imposing a 9-billion cap.
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || scaled(value, precision) !== units) throw rangeError()
  return Object.is(value, -0) ? 0 : value
}

export function isBudgetAmount(value: unknown, precision = 2, maximum = 1_000_000_000_000): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum || !Number.isSafeInteger(precision) || precision < 0 || precision > 6) return false
  return decimal(value).scale <= precision
}

/** Exact source L × N / destination Q × S; no order quantity multiplier. */
export function multiplyBudgetCost(unitCost: number, consumption: number): number {
  if (!isBudgetAmount(unitCost, 2) || !isBudgetAmount(consumption, 4)) throw precisionError()
  const value = asNumber(scaled(unitCost, 2) * scaled(consumption, 4), 6)
  if (value > 1_000_000_000_000) throw rangeError()
  return value
}

/** A per-garment amount can already have six decimals after price × consumption.
 * Multiply by the actual whole order quantity without rounding that unit cost. */
export function multiplyBudgetQuantity(unitAmount: number, quantity: number): number {
  if (!Number.isFinite(unitAmount) || unitAmount < 0 || !Number.isSafeInteger(quantity) || quantity < 0) throw rangeError()
  return asNumber(scaled(unitAmount, 6) * BigInt(quantity), 6)
}

/** Signed inputs support exact remaining/overage calculations as well as sums. */
export function sumBudgetMoney(values: readonly number[]): number {
  return asNumber(values.reduce((total, value) => {
    let input = value
    // Old computed snapshot fixtures can carry one binary ULP (for example
    // 12000 * 1.1). Remove only that representation noise, never a genuine
    // seventh decimal supplied as a monetary amount.
    if (Number.isFinite(value) && decimal(value).scale > 6) {
      const rounded = roundBudgetMoney(value, 6)
      if (Math.abs(value - rounded) <= Math.abs(value) * Number.EPSILON) input = rounded
    }
    return total + scaled(input, 6)
  }, 0n), 6)
}

/** Used only for existing VAT derived from two-decimal finalized amounts. */
export function roundBudgetMoney(value: number, precision = 6): number {
  if (!Number.isFinite(value) || !Number.isSafeInteger(precision) || precision < 0 || precision > 6) throw precisionError()
  return Number(value.toFixed(precision))
}
