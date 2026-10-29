import type { OperationsWorkspace } from './operations-types'
import type { SettlementWorkspaceFields } from './settlement-types'
import type { ProductionDetails } from './workflow-refinements'
import type { ProductionLedgerFields } from './production-ledger'
import type { SupplierOrderFields } from './supplier-orders'
import type { ProcessingPricesWorkspaceFields } from './processing-prices'
import type { ProductionConditionsFields } from './production-conditions'
import type { ProductionPoLinkFields } from './production-po-links'
import type { PartialDeliveryFields } from './partial-deliveries'
export type Role = 'admin' | 'internal' | 'factory'
export type Status = 'unset' | 'todo' | 'progress' | 'done' | 'approved' | 'delayed'
export type Stage = 'registered' | 'pattern' | 'sample1' | 'sampleN' | 'review' | 'revision' | 'approved' | 'production'
export interface Profile { id: string; name: string; email: string; role: Role; approved: boolean; active: boolean; factoryId: string | null; withdrawnAt?: string | null; withdrawnBy?: string | null }
export interface Factory { id: string; name: string; country: string }
export interface Project { code?: string; id: string; name: string; season: string }
export const SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL'] as const
export type Size = typeof SIZES[number]
export type Quantities = Record<Size, number>
export const CHECKS = [
  ['tp', 'TP 발송'], ['pp', 'PP·견본 전달'], ['gb', 'GB 혼용률 테스트'], ['labels', '라벨 발주'],
  ['care', '케어라벨 검수'], ['materials', '원·부자재 컨펌'], ['packing', '패킹 부자재 출고'],
  ['main', '메인 제품 수납'], ['quality', '에이블 품질 검사'], ['packingList', '패킹리스트 확인'],
] as const
export type CheckKey = typeof CHECKS[number][0]
export interface Sample {
  id: string; round: number; isPP: boolean; status: Status; factoryId: string; ownerId: string;
  requestedAt: string; plannedAt: string; completedAt: string; shippedAt: string; receivedAt: string; reviewedAt: string;
  tracking: string; request: string; factoryComment: string; updatedAt: string;
}
export interface ProductionLine {
  id: string; color: string; ownerId?: string; order: Quantities; shipped: Quantities; received: Quantities; packing: Quantities;
  checks: Record<CheckKey, Status>; confirmDue: string; shippedAt: string; receivedAt: string;
  invoice: Status; invoiceAmount: number; paymentDue: string; paymentStatus: Status; measurements: string; factoryComment: string;
}
export interface Style {
  id: string; code: string; name: string; category: string; season: string; projectId: string; factoryId: string; ownerId: string;
  colors: string[]; dueDate: string; stage: Stage; ppApproved: boolean; notes: string;
  samples: Sample[]; production: ProductionLine[]; version: number; updatedAt: string; updatedBy: string; deletedAt: string | null;
}
export interface Comment { id: string; styleId: string; sampleId: string | null; authorId: string; authorName: string; body: string; createdAt: string }
export interface Attachment { id: string; styleId: string; sampleId: string | null; name: string; path: string; mime: string; size: number; uploadedBy: string; createdAt: string }
export interface Audit { id: string; styleId: string | null; actorId: string; actorName: string; action: string; reason: string; before: unknown; after: unknown; createdAt: string }
export interface StyleImage { styleId: string; color: string; attachmentId: string | null; version: number; updatedAt: string; updatedBy: string }
export interface Workspace extends SettlementWorkspaceFields, ProductionLedgerFields, SupplierOrderFields, ProcessingPricesWorkspaceFields, ProductionConditionsFields, ProductionPoLinkFields, PartialDeliveryFields { importColorOwnersAvailable?: boolean; memberWithdrawalAvailable?: boolean; staffApprovalsAvailable?: boolean; productionDetails?: ProductionDetails[]; refinementsAvailable?: boolean; styles: Style[]; profiles: Profile[]; factories: Factory[]; projects: Project[]; comments: Comment[]; attachments: Attachment[]; audits: Audit[]; styleImages?: StyleImage[]; styleImagesAvailable?: boolean; operations?: OperationsWorkspace; operationsAvailable?: boolean }
export interface StyleSave { (style: Style, reason: string): Promise<void> }
export const STATUS_LABEL: Record<Status, string> = { unset: '미기재', todo: '미완료', progress: '진행 중', done: '완료', approved: '최종 컨펌', delayed: '일정 지연' }
export const STAGE_LABEL: Record<Stage, string> = { registered: '스타일 등록', pattern: '패턴 진행', sample1: '1차 샘플', sampleN: '2차 이상 샘플', review: '샘플 리뷰', revision: '수정 요청', approved: '최종 컨펌', production: '메인 생산' }
export const ROLE_LABEL: Record<Role, string> = { admin: '관리자', internal: '본사 직원', factory: '외부 공장' }
export const emptyQuantities = (): Quantities => ({ XXS: 0, XS: 0, S: 0, M: 0, L: 0, XL: 0 })
export const quantityTotal = (q: Quantities) => SIZES.reduce((sum, size) => sum + (Number(q[size]) || 0), 0)
export const blankProduction = (color: string): ProductionLine => ({ id: crypto.randomUUID(), color, order: emptyQuantities(), shipped: emptyQuantities(), received: emptyQuantities(), packing: emptyQuantities(), checks: Object.fromEntries(CHECKS.map(([key]) => [key, 'unset'])) as Record<CheckKey, Status>, confirmDue: '', shippedAt: '', receivedAt: '', invoice: 'unset', invoiceAmount: 0, paymentDue: '', paymentStatus: 'unset', measurements: '', factoryComment: '' })
export const blankSample = (round: number, factoryId: string, ownerId: string, isPP = false): Sample => ({ id: crypto.randomUUID(), round, isPP, status: 'todo', factoryId, ownerId, requestedAt: new Date().toLocaleDateString('en-CA'), plannedAt: '', completedAt: '', shippedAt: '', receivedAt: '', reviewedAt: '', tracking: '', request: '', factoryComment: '', updatedAt: new Date().toISOString() })
