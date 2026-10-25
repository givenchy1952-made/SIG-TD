import type { Profile, Status, Workspace } from './types'
import { assertActive, canViewStyle } from './permissions'
import { validateOperationDate, validateOperationReason } from './operations-domain'
import type { OperationStamp } from './operations-types'

export const MEASUREMENT_SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL'] as const
export const QUALITY_CATEGORIES = ['아우터', '니트', '티셔츠', '바지', '가방', '악세사리', '모자'] as const
export type LeaveType = 'full' | 'am' | 'pm' | 'two_hours'
export const LEAVE_LABELS: Record<LeaveType, string> = { full: '종일', am: '오전 반차', pm: '오후 반차', two_hours: '반반차 (2시간)' }
export interface MeasurementRow { id: string; label: string; grade: number | null; values: Record<typeof MEASUREMENT_SIZES[number], number | null> }
export interface ProductionDetailsInput {
  quality: { category: typeof QUALITY_CATEGORIES[number] | ''; quantity: number; status: Status; requestedAt: string; completedAt: string; note: string }
  measurements: { upper: MeasurementRow[]; lower: MeasurementRow[] }
}
export interface ProductionDetails extends ProductionDetailsInput, OperationStamp { styleId: string; lineId: string }
export function blankMeasurements(part: 'upper' | 'lower'): MeasurementRow[] {
  const labels = part === 'upper' ? ['총장 (옆목)', '가슴 (단면)', '허리 (단면)', '밑단 (단면)', '어깨 (너비)', '목 (너비)', '목 (깊이)', '암홀 (단면)', '소매 (기장)', '소매통 (단면)', '소매입구 (단면)', '화장'] : ['허리 (단면)', '총장', '엉덩이 (단면)', '밑단 (단면)', '앞 밑위', '뒷 밑위', '허벅지 (단면)', '인심']
  return labels.map((label, i) => ({ id: `${part}-${i + 1}`, label, grade: null, values: Object.fromEntries(MEASUREMENT_SIZES.map(size => [size, null])) as MeasurementRow['values'] }))
}
export function blankProductionDetails(): ProductionDetailsInput { return { quality: { category: '', quantity: 0, status: 'unset', requestedAt: '', completedAt: '', note: '' }, measurements: { upper: blankMeasurements('upper'), lower: blankMeasurements('lower') } } }
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => key in value)
export function validateProductionDetails(data: ProductionDetailsInput): void {
  if (!exact(data, ['quality', 'measurements']) || !exact(data.quality, ['category', 'quantity', 'status', 'requestedAt', 'completedAt', 'note']) || !exact(data.measurements, ['upper', 'lower'])) throw new Error('품질 검사·사이즈 측정 항목을 확인해 주세요.')
  const q = data.quality
  if (q.category !== '' && !QUALITY_CATEGORIES.includes(q.category) || !Number.isSafeInteger(q.quantity) || q.quantity < 0 || q.quantity > 10000000 || !['unset', 'todo', 'progress', 'done', 'approved', 'delayed'].includes(q.status) || typeof q.note !== 'string' || q.note.length > 5000) throw new Error('품질 검사 종류·수량·상태·메모를 확인해 주세요.')
  validateOperationDate(q.requestedAt); validateOperationDate(q.completedAt)
  for (const rows of [data.measurements.upper, data.measurements.lower]) {
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 30 || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('측정 위치는 구분별로 중복 없이 1~30개 입력해 주세요.')
    for (const row of rows) {
      if (!exact(row, ['id', 'label', 'grade', 'values']) || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.id) || typeof row.label !== 'string' || !row.label.trim() || row.label.length > 80 || !exact(row.values, MEASUREMENT_SIZES)) throw new Error('측정 위치와 사이즈 항목을 확인해 주세요.')
      for (const value of [row.grade, ...Object.values(row.values)]) if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000 || !/^\d+(\.\d{1,2})?$/.test(String(value)))) throw new Error('치수와 편차는 0~1,000cm, 소수 둘째 자리까지 입력해 주세요. 미입력은 빈칸으로 남겨 주세요.')
    }
  }
}
export function validateLeave(event: { kind: string; startDate: string; endDate: string; leaveType?: LeaveType; startTime?: string; endTime?: string }): void {
  if (event.leaveType !== undefined && typeof event.leaveType !== 'string' || event.startTime !== undefined && typeof event.startTime !== 'string' || event.endTime !== undefined && typeof event.endTime !== 'string') throw new Error('휴가 구분과 시간 형식을 확인해 주세요.')
  const kind = event.leaveType || 'full', start = event.startTime || '', end = event.endTime || ''
  if (!Object.keys(LEAVE_LABELS).includes(kind)) throw new Error('휴가 구분을 확인해 주세요.')
  if (event.kind !== 'personal_leave' && (kind !== 'full' || start || end)) throw new Error('반차·반반차는 개인 휴가에서만 등록할 수 있습니다.')
  if (kind !== 'full' && event.startDate !== event.endDate) throw new Error('반차·반반차는 당일 일정으로 등록해 주세요.')
  if (kind === 'two_hours') {
    const minutes = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN
    if (minutes(end) - minutes(start) !== 120) throw new Error('반반차 시작·종료 시간은 정확히 2시간이어야 합니다.')
  } else if (start || end) throw new Error('시간 입력은 2시간 반반차에만 사용합니다.')
}
export function leaveLabel(event: { kind: string; leaveType?: LeaveType; startTime?: string; endTime?: string }): string { return event.kind === 'personal_leave' ? `${LEAVE_LABELS[event.leaveType || 'full']}${event.leaveType === 'two_hours' ? ` ${event.startTime}–${event.endTime}` : ''}` : '' }
export function scopeProductionDetails(workspace: Workspace, profile: Profile): ProductionDetails[] { return (workspace.productionDetails || []).filter(row => workspace.styles.some(style => style.id === row.styleId && canViewStyle(profile, style))) }
export function saveProductionDetailsInWorkspace(workspace: Workspace, supplied: Profile, styleId: string, lineId: string, data: ProductionDetailsInput, expected: number, reason: string): Workspace {
  const actor = workspace.profiles.find(p => p.id === supplied.id); if (!actor) throw new Error('사용자 계정을 확인해 주세요.'); assertActive(actor)
  const style = workspace.styles.find(s => s.id === styleId && canViewStyle(actor, s)); if (!style?.production.some(line => line.id === lineId)) throw new Error('저장된 스타일·컬러를 선택해 주세요.')
  validateOperationReason(reason); validateProductionDetails(data)
  const before = workspace.productionDetails?.find(row => row.styleId === styleId && row.lineId === lineId)
  if (!Number.isSafeInteger(expected) || expected < 0 || (before?.version || 0) !== expected) throw new Error('VERSION_CONFLICT')
  if (actor.role === 'factory' && JSON.stringify(data.quality) !== JSON.stringify(before?.quality || blankProductionDetails().quality)) throw new Error('품질 검사는 본사에서 관리합니다.')
  const next = structuredClone(workspace), now = new Date().toISOString()
  const after: ProductionDetails = { ...structuredClone(data), styleId, lineId, version: expected + 1, createdAt: before?.createdAt || now, updatedAt: now, updatedBy: actor.id }
  next.productionDetails = [...(next.productionDetails || []).filter(row => row.styleId !== styleId || row.lineId !== lineId), after]
  next.audits.unshift({ id: crypto.randomUUID(), styleId, actorId: actor.id, actorName: actor.name, action: '품질 검사·사이즈 측정 저장', reason, before: before || null, after, createdAt: now }); return next
}
