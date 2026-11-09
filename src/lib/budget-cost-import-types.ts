import type { BudgetCostData, BudgetOrderSource } from './budget-types'

export type BudgetCostImportCell = string | number | boolean | null | { error: string }
export type BudgetCostSourceValues = Pick<BudgetCostData, 'category' | 'supplierName' | 'description' | 'position' | 'specification' | 'itemName' | 'composition' | 'color' | 'unitCost' | 'variableUnitCost' | 'consumption' | 'unit'>
export interface BudgetCostParsedRow {
  sheetName: string; rowNumber: number; projectCode: string; styleCode: string;
  values: BudgetCostSourceValues | null; errors: string[];
}
export interface BudgetCostImportSheet { name: string; supported: boolean; rows: BudgetCostParsedRow[]; ignoredRows: number }
export interface BudgetCostImportWorkbook { fileName: string; sheets: BudgetCostImportSheet[] }
export interface BudgetCostImportSource {
  fileName: string; sheetName: string; rowNumber: number; sourceKey: string; rowFingerprint: string; contentHash: string;
}
export interface BudgetCostImportProvenance extends BudgetCostImportSource {
  recordId: string; projectId: string; styleCode: string; updatedAt: string; updatedBy: string;
}
export interface BudgetCostImportAlias {
  contentHash: string; sheetName: string; rowNumber: number; projectId: string; styleCode: string; recordId: string;
}
export interface BudgetCostImportReceipt { importId: string; requestSignature: string; result: BudgetCostImportResult }
export interface BudgetCostImportsFields {
  budgetCostImports?: BudgetCostImportProvenance[]; budgetCostImportAliases?: BudgetCostImportAlias[]; budgetCostImportReceipts?: BudgetCostImportReceipt[]; budgetCostImportAvailable?: boolean;
}
export interface BudgetCostImportOptions {
  sheetNames?: readonly string[];
  /** Key is budgetCostMatchKey(projectCode, fullSKU); value is the explicitly selected existing project ID. */
  projectIds?: Record<string, string>;
}
export interface BudgetCostImportWriteRow {
  recordId: string; expectedVersion: number; projectCode: string; styleCode: string;
  data: BudgetCostData; source: BudgetCostImportSource; action: 'insert' | 'update' | 'skip';
}
export interface BudgetCostImportPreviewRow extends BudgetCostParsedRow {
  key: string; action: 'insert' | 'update' | 'skip' | 'error'; warnings: string[];
  candidates: BudgetOrderSource[]; order: BudgetOrderSource | null; write: BudgetCostImportWriteRow | null;
}
export interface BudgetCostImportPreview {
  fileName: string; contentHash: string; rows: BudgetCostImportPreviewRow[];
  errors: string[]; warnings: string[]; inserted: number; updated: number; skipped: number; ignoredRows: number;
}
export interface BudgetCostImportRequest { importId: string; fileName: string; contentHash: string; rows: BudgetCostImportWriteRow[] }
export interface BudgetCostImportResult { inserted: number; updated: number; skipped: number }
