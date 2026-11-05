import type { Profile, Workspace } from './types'
import { EMPTY_OPERATIONS } from './operations-types'
import { scopeInspectionWorkspace } from './inspection-assignments'
import { scopeSupplierWorkRates } from './supplier-work-rates'

/** Inspectors receive a separate, minimal workspace, including in demo mode.
 * No regular style, PO, file, production-cost or raw-import state is carried. */
export function inspectionOnlyWorkspace(workspace: Workspace, supplied: Profile): Workspace {
  const actor = workspace.profiles.find(profile => profile.id === supplied.id)
  return {
    profiles: actor ? [{ ...actor }] : [], factories: actor?.factoryId ? workspace.factories.filter(factory => factory.id === actor.factoryId).map(factory => ({ ...factory })) : [],
    styles: [], projects: [], comments: [], attachments: [], audits: [], productionProjectNames: [],
    operations: structuredClone(EMPTY_OPERATIONS), operationsAvailable: false,
    productionRuns: [], productionReceipts: [], productionRunAudits: [], productionLedgerAvailable: false,
    supplierProductionOrders: [], supplierOrdersAvailable: false, productionConditions: [], productionConditionsAvailable: false,
    styleImages: [], styleImagesAvailable: false, materialReviewItems: [], materialReviewRounds: [], materialReviewsAvailable: false,
    processingUnitPrices: [], processingPricesAvailable: false, settlementTerms: [], settlementTermsAudits: [], settlementTermsAvailable: false,
    productionDetails: [], refinementsAvailable: false, partialDeliveryPlans: [], partialDeliveryAvailable: false, partialDeliverySizesAvailable: false,
    ...scopeInspectionWorkspace(workspace, supplied), ...scopeSupplierWorkRates(workspace, supplied),
  }
}

