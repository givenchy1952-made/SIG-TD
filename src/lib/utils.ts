import { quantityTotal, type Style, type Workspace } from './types'
import { scopeOperations } from './operations-domain'
import { scopeSettlementTermsWorkspace } from './settlement-domain'
import { scopeProductionDetails } from './workflow-refinements'
import { scopeProductionLedgerWorkspace } from './production-ledger'
import { scopeSupplierOrders } from './supplier-orders'
import { scopeProcessingPricesWorkspace } from './processing-prices'
import { scopeProductionConditionsWorkspace } from './production-conditions'
import { scopeProductionPoLinks } from './production-po-links'
import { scopeMaterialReviewsWorkspace } from './material-reviews'
export function localDate(date = new Date()): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
export function addDays(days: number, from = new Date()): string { const d = new Date(from); d.setDate(d.getDate() + days); return localDate(d) }
export function isOverdue(style: Style): boolean { return !!style.dueDate && style.dueDate < localDate() && style.stage !== 'approved' && !(style.stage === 'production' && style.production.length > 0 && style.production.every(p => quantityTotal(p.order) > 0 && quantityTotal(p.received) >= quantityTotal(p.order))) }
export function isSampleStyle(style: Style): boolean {
  if (style.deletedAt || style.stage === 'production') return false
  if (['pattern', 'sample1', 'sampleN', 'review', 'revision'].includes(style.stage)) return true
  return style.stage === 'registered' && !style.production.some(line => quantityTotal(line.order) > 0 || quantityTotal(line.shipped) > 0 || quantityTotal(line.received) > 0)
}
export function isMainProductionStyle(style: Style): boolean {
  if (style.deletedAt) return false
  return style.stage === 'production' || ['registered', 'approved'].includes(style.stage) && style.production.some(line => quantityTotal(line.order) > 0 || quantityTotal(line.shipped) > 0 || quantityTotal(line.received) > 0)
}
export function scopeWorkspace(workspace: Workspace, profile: import('./types').Profile): Workspace {
  const operations = scopeOperations(workspace, profile)
  const settlement = { ...scopeMaterialReviewsWorkspace(workspace, profile), ...scopeSettlementTermsWorkspace(workspace, profile), ...scopeProductionLedgerWorkspace(workspace, profile), ...scopeSupplierOrders(workspace, profile), ...scopeProcessingPricesWorkspace(workspace, profile), ...scopeProductionConditionsWorkspace(workspace, profile), ...scopeProductionPoLinks(workspace, profile), productionDetails: scopeProductionDetails(workspace, profile), refinementsAvailable: workspace.refinementsAvailable }
  if (!profile.approved || !profile.active) return { ...settlement, styles: [], profiles: [profile], factories: [], projects: [], comments: [], attachments: [], audits: [], styleImages: [], styleImagesAvailable: workspace.styleImagesAvailable, operations, operationsAvailable: workspace.operationsAvailable }
  if (profile.role !== 'factory') { const styles = workspace.styles.filter(s => !s.deletedAt); const ids = new Set(styles.map(s => s.id)); return { ...workspace, ...settlement, styles, styleImages: (workspace.styleImages || []).filter(image => ids.has(image.styleId)), operations } }
  const styles = workspace.styles.filter(s => s.factoryId === profile.factoryId && !s.deletedAt)
  const ids = new Set(styles.map(s => s.id)); const projectIds = new Set(styles.map(s => s.projectId))
  const ownerIds = new Set(styles.flatMap(s => [s.ownerId, ...s.samples.map(sample => sample.ownerId)]))
  const directory = workspace.profiles.filter(p => ownerIds.has(p.id) && p.id !== profile.id).map(p => ({ ...p, email: '', factoryId: null }))
  return { ...settlement, styles, profiles: [profile, ...directory], factories: workspace.factories.filter(f => f.id === profile.factoryId), projects: workspace.projects.filter(p => projectIds.has(p.id)), comments: workspace.comments.filter(c => ids.has(c.styleId)), attachments: workspace.attachments.filter(a => ids.has(a.styleId)), audits: workspace.audits.filter(a => a.styleId && ids.has(a.styleId) && !a.action.startsWith('PO ')), styleImages: (workspace.styleImages || []).filter(image => ids.has(image.styleId)), styleImagesAvailable: workspace.styleImagesAvailable, operations, operationsAvailable: workspace.operationsAvailable }
}
export function message(error: unknown): string { const text = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String(error.message) : String(error); if (/conflict|version|409/i.test(text)) return '다른 사용자가 먼저 수정했습니다. 입력 내용을 보관한 뒤 최신 정보를 다시 열어 확인해 주세요.'; if (/REASON_REQUIRED/.test(text)) return '변경 사유를 두 글자 이상 입력해 주세요.';
  if (/HQ_(?:FINAL_)?APPROVAL_REQUIRED/.test(text)) return '본사가 생산 조건을 최종 승인해야 생산 시작·실입고·마감을 진행할 수 있습니다.';
  if (/PRODUCTION_MODE_REQUIRED/.test(text)) return '생산 조건 협의·승인에서 완사입 또는 임가공 생산 방식을 먼저 설정해 주세요.';
  if (/PO_LINK_CONFIRMATION_REQUIRED/.test(text)) return '생산 차수를 저장한 뒤 생산 조건 협의·승인에서 발송 문서와 수량을 확인하고 연결해 주세요.';
  if (/SUPPLIER_CONDITIONS_UNCONFIRMED/.test(text)) return '업체의 생산 가능 여부·사이즈별 수량 확인·생산 조건 동의를 확인한 뒤 승인해 주세요.';
  if (/PRODUCTION_CONDITIONS_NOT_REVIEWABLE/.test(text)) return '본사 검토 대기 중인 업체 회신을 선택해 주세요. 최신 상태를 다시 확인해 주세요.';
  if (/PROPOSAL_TERMS_CHANGED|PRODUCTION_TERMS_CHANGED|PRODUCTION_CONDITIONS_CHANGED|QUANTITY_CONFIRMATION_MISMATCH/.test(text)) return '회신 당시 발주 조건과 현재 정보가 다릅니다. 수정 요청을 통해 업체의 조건을 다시 확인해 주세요.';
  if (/PO_DOCUMENT_CONFIRMATION_REQUIRED|LEGACY_PO_DOCUMENT_CONFIRMATION_REQUIRED|ORDER_SCOPE_CONFIRMATION_REQUIRED/.test(text)) return '실제 발송 문서와 생산 차수의 품번·컬러·수량 및 집계 범위를 확인하고 동의해 주세요.';
  if (/PRODUCTION_NOT_STARTED|SUPPLIER_ACCEPTANCE_REQUIRED/.test(text)) return '생산 조건 협의·승인에서 업체 회신과 본사 최종 승인 상태를 확인해 주세요. 승인 후에 실입고와 마감을 진행할 수 있습니다.';
  if (/PO_NOT_SENT/.test(text)) return '이 차수에 연결된 PO가 아직 발송되지 않았습니다. PO 발송 이력을 확인해 주세요.';
  if (/AGREEMENT_REQUIRED/.test(text)) return 'PO 내용과 예상 납기일을 확인하고 생산 동의에 체크해 주세요.';
  if (/INVALID_DELIVERY_DATE/.test(text)) return '올바른 업체 예상 납기일을 입력해 주세요.';
  if (/ASSIGNMENT_CHANGED/.test(text)) return '이 발주 이후 담당 공장이 변경되었습니다. 새 공장에는 새 생산 차수와 PO를 작성해 주세요.';
  if (/IMPORT_PROJECT_REQUIRED|IMPORT_PROJECT_MISMATCH|IMPORT_MIXED_PROJECTS/.test(text)) return 'A열 프로젝트 코드와 M열 명칭·L열 시즌을 프로젝트 기본 정보에서 확인해 주세요. 다른 프로젝트의 행은 나누어 업로드해 주세요.';
  if (/IMPORT_ID_REUSED/.test(text)) return '이 업로드 요청이 다른 내용에 사용되었습니다. 파일 미리보기를 다시 열어 주세요.';
  if (/Invalid path specified in request URL/i.test(text)) return '서비스 연결 주소가 올바르지 않습니다. Supabase 프로젝트 기본 주소 설정과 앱 재배포를 확인해 주세요.';
  if (/SHIPMENT_LEDGER_PROTECTED|SHIPMENT_AGGREGATE/.test(text)) return '차수별 출고 수량·출고일은 발주·출고·가공의 부분 출고에서 수정해 주세요.';
  if (/PO_IMMUTABLE|PO_STATE|PO_UNKNOWN|PO_RETRY/.test(text)) return '이 PO는 발송을 시도했거나 결과 확인 중입니다. 기존 내용은 변경하지 말고 발송 이력을 확인해 주세요.';
  if (/INVALID_CATALOG/.test(text)) return '정해진 작업 종류 목록에서 항목을 선택해 주세요.';
  if (/FORBIDDEN_FIELD|permission denied|FORBIDDEN/.test(text)) return '이 항목을 수정할 권한이 없습니다. 관리자 승인과 담당 공장 배정을 확인해 주세요.';
  if (/DUPLICATE_STYLE|duplicate key/.test(text)) return '같은 스타일 코드가 이미 등록되어 있습니다.';
  if (/HISTORY_PROTECTED/.test(text)) return '기존 샘플 및 컬러별 생산 이력은 삭제하거나 차수를 변경할 수 없습니다.';
  if (/INVALID_STYLE/.test(text)) return '입력한 데이터 형식을 확인해 주세요. 필수 항목·수량·날짜·담당자 설정이 올바르지 않습니다.';
  return text }
export const formatDate = (s: string) => s ? new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit' }).format(new Date(`${s.slice(0, 10)}T12:00:00`)) : '—'
