import type { OperationStamp } from './operations-types'
import type { Workspace } from './types'

export type SettlementItemType = 'product' | 'fabric' | 'label'
export interface SettlementTermsInput { projectCode: string; unitCost: number | null; itemType: SettlementItemType }
/** Unset price is null; an explicitly agreed zero price remains zero. */
export interface SettlementTerms extends SettlementTermsInput, OperationStamp { styleId: string; lineId: string }
export interface SettlementTermsAudit {
  id: string; styleId: string; lineId: string; actorId: string; actorName: string; reason: string;
  before: SettlementTerms | null; after: SettlementTerms; createdAt: string;
}
export interface SettlementWorkspaceFields {
  settlementTerms?: SettlementTerms[];
  settlementTermsAudits?: SettlementTermsAudit[];
  settlementTermsAvailable?: boolean;
}
export type SettlementWorkspace = Workspace & SettlementWorkspaceFields
