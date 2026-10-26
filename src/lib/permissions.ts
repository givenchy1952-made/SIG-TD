import { SIZES, type Profile, type Style } from './types'
export function assertActive(profile: Profile) { if (!profile.approved || !profile.active) throw new Error('관리자 승인 후 사용할 수 있습니다.') }
export function canViewStyle(profile: Profile, style: Style) { return profile.approved && profile.active && !style.deletedAt && (profile.role !== 'factory' || !!profile.factoryId && style.factoryId === profile.factoryId) }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function unchangedKeys(a: object, b: object, except: string[]) { for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!except.includes(key) && !same(a[key as keyof typeof a], b[key as keyof typeof b])) throw new Error(`이 항목을 변경할 권한이 없습니다: ${key}`) }
export function validateStyle(style: Style) {
  if (!style.code.trim() || !style.name.trim() || !style.factoryId || !style.projectId) throw new Error('스타일 코드, 이름, 공장, 프로젝트를 입력해 주세요.')
  if (typeof style.ownerId !== 'string' || style.production.some(line => line.ownerId !== undefined && typeof line.ownerId !== 'string') || style.samples.some(sample => typeof sample.ownerId !== 'string')) throw new Error('담당자는 미지정 또는 본사 구성원으로 선택해 주세요.')
  // The database permits an unknown baseline date as an empty string. Imported
  // order drafts can therefore wait for the PO delivery date without inventing
  // one; an explicitly supplied baseline date must still be a real ISO date.
  if (typeof style.dueDate !== 'string' || style.dueDate !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(style.dueDate) || !Number.isFinite(Date.parse(`${style.dueDate}T00:00:00Z`)) || new Date(`${style.dueDate}T00:00:00Z`).getUTCFullYear() < 1 || new Date(`${style.dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== style.dueDate)) throw new Error('기준 납기일은 미정 또는 유효한 연-월-일 형식으로 입력해 주세요.')
  if (!style.colors.length || style.colors.some(c => !/^[A-Z]{2}$/.test(c)) || new Set(style.colors).size !== style.colors.length) throw new Error('컬러는 중복 없는 영문 대문자 두 자리로 입력해 주세요.')
  if (new Set(style.samples.map(s => s.id)).size !== style.samples.length || new Set(style.production.map(p => p.id)).size !== style.production.length) throw new Error('중복 이력이 있습니다.')
  for (const p of style.production) for (const key of ['order', 'shipped', 'received', 'packing'] as const) for (const size of SIZES) { const v = p[key][size]; if (!Number.isSafeInteger(v) || v < 0 || v > 10000000) throw new Error('수량은 0~10,000,000 사이의 정수로 입력해 주세요.') }
  for (const p of style.production) if (!Number.isFinite(p.invoiceAmount) || p.invoiceAmount < 0) throw new Error('금액을 확인해 주세요.')
}
export function assertStyleSave(profile: Profile, before: Style | undefined, after: Style, reason: string) {
  assertActive(profile); validateStyle(after)
  if (reason.trim().length < 2) throw new Error('변경 사유를 두 글자 이상 입력해 주세요.')
  if (before && !canViewStyle(profile, before)) throw new Error('이 스타일에 접근할 수 없습니다.')
  if (!before && profile.role === 'factory') throw new Error('스타일 등록은 본사 담당자만 가능합니다.')
  if (before) {
    if (before.samples.some(s => !after.samples.some(n => n.id === s.id))) throw new Error('기존 샘플 이력은 삭제할 수 없습니다.')
    if (before.production.some(p => !after.production.some(n => n.id === p.id))) throw new Error('기존 컬러 생산 이력은 삭제할 수 없습니다.')
    for (const p of after.production) { const old = before.production.find(n => n.id === p.id); if (!old) { if (profile.role !== 'admin' && SIZES.some(size => p.shipped[size] || p.received[size])) throw new Error('새 생산 라인의 출고·입고 수량은 0으로 시작해야 합니다.'); continue }; if (profile.role !== 'admin' && !same(old.received, p.received)) throw new Error('입고 수량은 관리자만 입력할 수 있습니다.'); if (profile.role === 'internal' && !same(old.shipped, p.shipped)) throw new Error('출고 수량은 공장 또는 관리자만 입력할 수 있습니다.') }
  } else if (profile.role !== 'admin' && after.production.some(p => SIZES.some(s => p.received[s] || p.shipped[s]))) throw new Error('출고·입고 수량은 권한에 맞는 담당자가 입력해야 합니다.')
  if (profile.role === 'factory' && before) {
    unchangedKeys(before, after, ['samples', 'production', 'updatedAt', 'updatedBy', 'version'])
    if (after.samples.length !== before.samples.length || after.production.length !== before.production.length) throw new Error('샘플 및 생산 라인 추가는 본사만 가능합니다.')
    after.samples.forEach(sample => { const old = before.samples.find(s => s.id === sample.id); if (!old) throw new Error('샘플을 확인해 주세요.'); if (!same(old, sample) && sample.factoryId !== profile.factoryId) throw new Error('이전 공장이 담당한 샘플은 본사만 변경할 수 있습니다.'); unchangedKeys(old, sample, ['status', 'plannedAt', 'completedAt', 'shippedAt', 'tracking', 'factoryComment', 'updatedAt']); if (sample.status !== old.status && sample.status === 'approved') throw new Error('최종 컨펌은 본사만 가능합니다.'); if (old.status === 'approved' && sample.status !== old.status) throw new Error('승인된 샘플 상태는 공장에서 변경할 수 없습니다.') })
    after.production.forEach(line => { const old = before.production.find(p => p.id === line.id); if (!old) throw new Error('생산 라인을 확인해 주세요.'); unchangedKeys(old, line, ['shipped', 'confirmDue', 'shippedAt', 'receivedAt', 'invoice', 'measurements', 'factoryComment']) })
  }
}
