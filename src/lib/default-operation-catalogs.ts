import lists from './default-operation-catalogs.json'
import type { OperationCatalog, StyleOperationKind } from './operations-types'

/** The exact approved list supplied by the user on 2026-10-23. No work orders. */
export function createDefaultOperationCatalogs(): OperationCatalog[] {
  const now = new Date().toISOString()
  return (['label', 'embroidery'] as StyleOperationKind[]).flatMap(kind => lists[kind].map((name, index) => ({
    id: `${kind === 'label' ? '61000000' : '62000000'}-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    kind, name, active: true, version: 1, createdAt: now, updatedAt: now, updatedBy: '',
  })))
}
