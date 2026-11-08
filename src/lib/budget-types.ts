/** The finance workspace carries this projection, never raw production records. */
export interface BudgetIdentity {
  projectId: string; projectCode: string; projectName: string; budgetCode: string;
  styleId: string; lineId: string; styleCode: string; color: string; season: string;
  factoryId: string; factoryName: string;
}
export interface BudgetOrderSource extends BudgetIdentity {
  sourceKey: string; brand: string; productionType: string; orderCode: string; orderDate: string;
  quantity: number; receivedQuantity: number; joorQuantity: number | null; aderQuantity: number | null;
}
/** A:U financial fields. Stable sourceKey and fingerprint bind a payment to its exact financial source. */
export interface BudgetFAEntry extends BudgetIdentity {
  sourceKey: string; sourceVersion: number; sourceFingerprint: string;
  orderDate: string; receivedAt: string; unitCost: number; consumption: number | null;
  orderQuantity: number; receivedQuantity: number; unit: string;
  netAmount: number; vatAmount: number; grossAmount: number; owner: string; item: string; evidence: string;
}
export interface BudgetSources { orders: BudgetOrderSource[]; settlements: BudgetFAEntry[]; warnings: string[] }
export interface BudgetCostData {
  projectId: string; budgetCode: string; styleCode: string; supplierId: string; supplierName: string;
  stage: 'pre' | 'post'; category: string; description: string; position: string; specification: string;
  itemName: string; composition: string; color: string; unitCost: number | null; variableUnitCost: number | null;
  consumption: number | null; unit: string; amount: number | null; voided: boolean;
}
export interface BudgetLimitData { season: string; amount: number | null }
export interface BudgetPaymentData {
  sourceKey: string; sourceFingerprint: string; sourceSnapshot: BudgetFAEntry | null; status: 'paid' | 'unpaid'; paidAt: string;
  voucherNo: string; account: string; description: string; splitPayment: string;
}
export interface BudgetNoteData { key: string; kind: 'excess' | 'unclosed'; reason: string }
export interface BudgetDataByKind { cost: BudgetCostData; limit: BudgetLimitData; payment: BudgetPaymentData; note: BudgetNoteData }
export type BudgetRecordKind = keyof BudgetDataByKind
export type BudgetRecord = { [K in BudgetRecordKind]: { id: string; kind: K; data: BudgetDataByKind[K]; version: number; createdAt: string; updatedAt: string; updatedBy: string } }[BudgetRecordKind]
export interface BudgetAudit { id: string; recordId: string; kind: BudgetRecordKind; actorId: string; actorName: string; reason: string; before: BudgetRecord | null; after: BudgetRecord; createdAt: string }
export interface BudgetWorkspaceFields { budgetSources?: BudgetSources; budgetRecords?: BudgetRecord[]; budgetAudits?: BudgetAudit[]; budgetAvailable?: boolean }
export interface BudgetFilters { projectIds?: readonly string[] | null; projectCodes?: readonly string[] | null; styleCodes?: readonly string[] | null; seasons?: readonly string[] | null; factoryIds?: readonly string[] | null; groupBy?: BudgetGroupBy }
export type BudgetGroupBy = 'project' | 'projectCode' | 'style' | 'season' | 'factory'
export interface BudgetOrderRow extends BudgetOrderSource { productionBudget: number | null; costMatched: string; productionUnitCost: number | null; postCost: number | null }
export interface BudgetFARow extends BudgetFAEntry { payment: BudgetPaymentData; paymentRecord: Extract<BudgetRecord, { kind: 'payment' }> | null; paymentStale: boolean }
export interface BudgetSummary {
  budget: number; paid: number; unpaid: number; confirmed: number; remaining: number; overage: number;
  paidVat: number; paidGross: number; missingCostCount: number; orderQuantity: number; receivedQuantity: number;
  annualLimit: number | null; unallocated: number | null; progress: number | null;
}
export interface BudgetGroup { key: string; label: string; projectCode: string; season: string; budgetCodes: string[]; totals: BudgetSummary; closed: boolean }
export interface BudgetException { key: string; kind: 'excess' | 'unclosed'; projectName: string; projectCode: string; styleCode: string; season: string; factoryName: string; budget: number | null; paid: number; unpaid: number; overage: number; explanation: string; reason: string; noteRecord: Extract<BudgetRecord, { kind: 'note' }> | null }
export interface BudgetReport {
  authorized: boolean; readOnly: boolean; orders: BudgetOrderRow[]; settlements: BudgetFARow[];
  costs: Extract<BudgetRecord, { kind: 'cost' }>[]; limits: Extract<BudgetRecord, { kind: 'limit' }>[];
  groups: BudgetGroup[]; totals: BudgetSummary; excess: BudgetException[]; unclosed: BudgetException[]; warnings: string[];
  sources: BudgetSources;
}
