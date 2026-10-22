import { quantityTotal, type Style, type Workspace } from './types'
export function localDate(date = new Date()): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
export function addDays(days: number, from = new Date()): string { const d = new Date(from); d.setDate(d.getDate() + days); return localDate(d) }
export function isOverdue(style: Style): boolean { return !!style.dueDate && style.dueDate < localDate() && style.stage !== 'approved' && !(style.stage === 'production' && style.production.length > 0 && style.production.every(p => quantityTotal(p.order) > 0 && quantityTotal(p.received) >= quantityTotal(p.order))) }
export function scopeWorkspace(workspace: Workspace, profile: import('./types').Profile): Workspace {
  if (!profile.approved || !profile.active) return { styles: [], profiles: [profile], factories: [], projects: [], comments: [], attachments: [], audits: [], styleImages: [], styleImagesAvailable: workspace.styleImagesAvailable }
  if (profile.role !== 'factory') { const styles = workspace.styles.filter(s => !s.deletedAt); const ids = new Set(styles.map(s => s.id)); return { ...workspace, styles, styleImages: (workspace.styleImages || []).filter(image => ids.has(image.styleId)) } }
  const styles = workspace.styles.filter(s => s.factoryId === profile.factoryId && !s.deletedAt)
  const ids = new Set(styles.map(s => s.id)); const projectIds = new Set(styles.map(s => s.projectId))
  const ownerIds = new Set(styles.flatMap(s => [s.ownerId, ...s.samples.map(sample => sample.ownerId)]))
  const directory = workspace.profiles.filter(p => ownerIds.has(p.id) && p.id !== profile.id).map(p => ({ ...p, email: '', factoryId: null }))
  return { styles, profiles: [profile, ...directory], factories: workspace.factories.filter(f => f.id === profile.factoryId), projects: workspace.projects.filter(p => projectIds.has(p.id)), comments: workspace.comments.filter(c => ids.has(c.styleId)), attachments: workspace.attachments.filter(a => ids.has(a.styleId)), audits: workspace.audits.filter(a => a.styleId && ids.has(a.styleId)), styleImages: (workspace.styleImages || []).filter(image => ids.has(image.styleId)), styleImagesAvailable: workspace.styleImagesAvailable }
}
export function message(error: unknown): string { const text = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String(error.message) : String(error); if (/conflict|version|409/i.test(text)) return '다른 사용자가 먼저 수정했습니다. 입력 내용을 보관한 뒤 최신 정보를 다시 열어 확인해 주세요.'; if (/REASON_REQUIRED/.test(text)) return '변경 사유를 두 글자 이상 입력해 주세요.';
  if (/Invalid path specified in request URL/i.test(text)) return '서비스 연결 주소가 올바르지 않습니다. Supabase 프로젝트 기본 주소 설정과 앱 재배포를 확인해 주세요.';
  if (/FORBIDDEN_FIELD|permission denied|FORBIDDEN/.test(text)) return '이 항목을 수정할 권한이 없습니다. 관리자 승인과 담당 공장 배정을 확인해 주세요.';
  if (/DUPLICATE_STYLE|duplicate key/.test(text)) return '같은 스타일 코드가 이미 등록되어 있습니다.';
  if (/HISTORY_PROTECTED/.test(text)) return '기존 샘플 및 컬러별 생산 이력은 삭제하거나 차수를 변경할 수 없습니다.';
  if (/INVALID_STYLE/.test(text)) return '입력한 데이터 형식을 확인해 주세요. 필수 항목·수량·날짜·담당자 설정이 올바르지 않습니다.';
  return text }
export const formatDate = (s: string) => s ? new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit' }).format(new Date(`${s.slice(0, 10)}T12:00:00`)) : '—'
