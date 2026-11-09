import type { Quantities, Style } from './types'

/** A signed correction to the cumulative shipment total. Existing baseline and
 * partial-shipment records stay unchanged and remain available as history. */
export interface ShipmentTotalAdjustment {
  id: string; styleId: string; lineId: string; delta: Quantities;
  shippedAt: string; createdAt: string; createdBy: string; reason: string;
}
export interface ConfirmMainProductionReceiptRequest {
  requestId: string; styleId: string; lineId: string; runId: string;
  expectedStyleVersion: number; expectedRunVersion: number; style: Style;
}
export interface ConfirmMainProductionReceiptResult {
  style: Style; receiptId: string | null; added: Quantities; runVersion: number;
}
export interface ProductionMovementRequestReceipt {
  requestId: string; actorId: string; signature: string;
  result: ConfirmMainProductionReceiptResult;
}
export interface ProductionMovementFields {
  shipmentAdjustments?: ShipmentTotalAdjustment[];
  mainProductionSyncAvailable?: boolean;
  /** Browser demo retry receipts. Never included in factory/FA projections. */
  productionMovementRequests?: ProductionMovementRequestReceipt[];
}
