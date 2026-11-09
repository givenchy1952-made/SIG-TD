import type { CellValue } from 'exceljs'
import type { Profile, Workspace } from './types'
import type { BudgetCostData, BudgetOrderSource, BudgetRecord } from './budget-types'
import type { BudgetCostImportCell, BudgetCostImportOptions, BudgetCostImportPreview, BudgetCostImportPreviewRow, BudgetCostImportProvenance, BudgetCostImportRequest, BudgetCostImportResult, BudgetCostImportSheet, BudgetCostImportSource, BudgetCostImportWorkbook, BudgetCostImportsFields, BudgetCostParsedRow } from './budget-cost-import-types'
import { buildBudgetSources, saveBudgetRecordInWorkspace, validateBudgetRecordData } from './budget-domain'
import { multiplyBudgetCost } from './budget-money'

export const MAX_BUDGET_COST_FILE_BYTES = 10 * 1024 * 1024
export const MAX_BUDGET_COST_ROWS = 10000
export const BUDGET_COST_HEADER_ROW = 15
export const BUDGET_COST_HEADERS = ['프로젝트코드', 'SKU NO.', '종류', '업체', '내역', '위치', '규격', '품명', '혼용율', '컬러', '단가', '변동단가', '요척량', '단위'] as const
type CostWorkspace = Workspace & BudgetCostImportsFields
const sourceFields = ['category', 'supplierName', 'description', 'position', 'specification', 'itemName', 'composition', 'color', 'unitCost', 'variableUnitCost', 'consumption', 'unit'] as const
const costFields: (keyof BudgetCostData)[] = ['projectId', 'budgetCode', 'styleCode', 'supplierId', 'supplierName', 'stage', 'category', 'description', 'position', 'specification', 'itemName', 'composition', 'color', 'unitCost', 'variableUnitCost', 'consumption', 'unit', 'amount', 'voided']
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i
const sha = /^[a-f\d]{64}$/
const cleanKey = (value: string) => value.normalize('NFKC').trim()
const cleanText = (value: string) => value.normalize('NFKC').replace(/[\r\n\t]+/g, ' ').trim()
const header = (value: string) => value.normalize('NFKC').toUpperCase().replace(/[\s._]/g, '').replace('혼용률', '혼용율')
export const budgetCostMatchKey = (projectCode: string, styleCode: string) => JSON.stringify([cleanKey(projectCode), cleanKey(styleCode)])
export const normalizeBudgetCostFileName = (fileName: string) => fileName.normalize('NFKC').trim().toLowerCase().replace(/\.xlsx$/i, '')
export const budgetCostSourceKey = (fileName: string, sheetName: string, rowNumber: number, projectId: string, styleCode: string) => JSON.stringify([normalizeBudgetCostFileName(fileName), sheetName.trim(), rowNumber, projectId, styleCode])
const canonicalCost = (value: BudgetCostData) => costFields.map(field => value[field])
const sameCost = (left: BudgetCostData, right: BudgetCostData) => JSON.stringify(canonicalCost(left)) === JSON.stringify(canonicalCost(right))
const sourceOrders = (workspace: Workspace) => workspace.budgetSources?.orders || buildBudgetSources(workspace).orders
const location = (row: Pick<BudgetCostParsedRow, 'sheetName' | 'rowNumber'>) => `${row.sheetName} ${row.rowNumber}행`

/** Read saved values only; no workbook formula is evaluated. */
export function budgetCostImportCell(value: CellValue | undefined): BudgetCostImportCell {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return { error: '날짜는 원가 항목 값으로 사용할 수 없습니다.' }
  if ('formula' in value || 'sharedFormula' in value) return value.result === undefined ? { error: '수식의 저장된 계산 결과가 없습니다. Excel에서 계산 후 저장해 주세요.' } : budgetCostImportCell(value.result)
  if ('error' in value) return { error: `Excel 셀 오류: ${value.error}` }
  if ('richText' in value) return value.richText.map(item => item.text).join('')
  if ('text' in value && typeof value.text === 'string') return value.text
  return { error: '지원하지 않는 셀 형식입니다.' }
}
const isEmpty = (value: BudgetCostImportCell) => value === null || typeof value === 'string' && value.trim() === ''
const excelError = /^#(?:REF!|NAME\?|VALUE!|DIV\/0!|N\/A|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$/i
function cellText(value: BudgetCostImportCell, label: string, required = false): string {
  if (value && typeof value === 'object') throw new Error(`${label}: ${value.error}`)
  if (value === null || value === '') { if (required) throw new Error(`${label} 값이 없습니다.`); return '' }
  if (typeof value === 'boolean' || typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${label} 값의 형식을 확인해 주세요.`)
  const result = cleanText(String(value))
  if (excelError.test(result) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result)) throw new Error(`${label}에 Excel 오류 또는 지원하지 않는 제어 문자가 있습니다.`)
  if (result.length > (label === '업체' ? 160 : 1000)) throw new Error(`${label} 값이 너무 깁니다.`)
  if (required && !result) throw new Error(`${label} 값이 없습니다.`)
  return result
}
function cellNumber(value: BudgetCostImportCell, label: string, precision: number, required: boolean): number | null {
  if (isEmpty(value)) { if (required) throw new Error(`${label} 값이 없습니다. 빈칸을 0으로 대신하지 않습니다.`); return null }
  if (value && typeof value === 'object') throw new Error(`${label}: ${value.error}`)
  const text = typeof value === 'string' ? value.normalize('NFKC').trim() : String(value)
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) throw new Error(`${label}는 0 이상의 숫자로 입력해 주세요.`)
  const normalized = text.replaceAll(',', ''), [whole, fraction = ''] = normalized.split('.')
  if (fraction.replace(/0+$/, '').length > precision) throw new Error(`${label}는 소수 ${precision}자리까지 입력해 주세요.`)
  const result = Number(`${whole}.${fraction || '0'}`)
  if (!Number.isFinite(result) || result > 1_000_000_000_000) throw new Error(`${label}는 0~1조 범위로 입력해 주세요.`)
  return result
}

export async function parseBudgetCostWorkbook(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<BudgetCostImportWorkbook> {
  if (!/\.xlsx$/i.test(file.name) || !file.size || file.size > MAX_BUDGET_COST_FILE_BYTES) throw new Error('비어 있지 않은 10MB 이하의 원가 Excel .xlsx 파일을 선택해 주세요.')
  const ExcelJS = (await import('exceljs')).default, workbook = new ExcelJS.Workbook()
  try { await workbook.xlsx.load(await file.arrayBuffer()) } catch { throw new Error('원가 Excel 파일을 읽지 못했습니다. 암호가 없는 .xlsx 형식으로 저장해 주세요.') }
  const sheets: BudgetCostImportSheet[] = []
  for (const sheet of workbook.worksheets) {
    const headers = BUDGET_COST_HEADERS.map((_, index) => budgetCostImportCell(sheet.getCell(BUDGET_COST_HEADER_ROW, index + 2).value))
    const supported = headers.every((value, index) => typeof value === 'string' && header(value) === header(BUDGET_COST_HEADERS[index]))
    const parsed: BudgetCostImportSheet = { name: sheet.name, supported, rows: [], ignoredRows: 0 }
    sheets.push(parsed)
    if (!supported) continue
    if (sheet.rowCount - BUDGET_COST_HEADER_ROW > MAX_BUDGET_COST_ROWS) throw new Error('원가 파일은 시트별 10,000개 데이터 행까지 지원합니다.')
    for (let rowNumber = BUDGET_COST_HEADER_ROW + 1; rowNumber <= sheet.rowCount; rowNumber++) {
      // B/C template formulas can lack caches on unused rows. Inspect the work
      // fields before touching those keys so empty templates remain empty.
      const cells = Array.from({ length: 12 }, (_, index) => budgetCostImportCell(sheet.getCell(rowNumber, index + 4).value))
      if (cells.every(isEmpty)) { parsed.ignoredRows += 1; continue }
      const row: BudgetCostParsedRow = { sheetName: sheet.name, rowNumber, projectCode: '', styleCode: '', values: null, errors: [] }
      parsed.rows.push(row)
      try {
        row.projectCode = cleanKey(cellText(budgetCostImportCell(sheet.getCell(rowNumber, 2).value), '프로젝트 코드', true))
        row.styleCode = cleanKey(cellText(budgetCostImportCell(sheet.getCell(rowNumber, 3).value), 'SKU NO.', true))
        const strings = cells.map((value, index) => index >= 8 && index <= 10 ? '' : cellText(value, BUDGET_COST_HEADERS[index + 2]))
        row.values = {
          category: strings[0], supplierName: strings[1], description: strings[2], position: strings[3], specification: strings[4], itemName: strings[5], composition: strings[6], color: strings[7],
          unitCost: cellNumber(cells[8], '단가', 2, true), variableUnitCost: cellNumber(cells[9], '변동단가', 2, false), consumption: cellNumber(cells[10], '요척량', 4, true), unit: strings[11],
        }
        multiplyBudgetCost(row.values.unitCost!, row.values.consumption!)
      } catch (error) { row.errors.push(error instanceof Error ? error.message : '원가 행을 확인해 주세요.') }
    }
  }
  if (!sheets.some(sheet => sheet.supported)) throw new Error('15행 B~O열의 프로젝트코드·SKU NO.·원가 항목 제목이 일치하는 시트가 없습니다.')
  return { fileName: file.name.trim(), sheets }
}

async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value)), digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
async function sourceRecordId(sourceKey: string): Promise<string> {
  const value = await hash(['sig-budget-cost-record', sourceKey])
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`
}
const samePosition = (prior: Pick<BudgetCostImportProvenance, 'sheetName' | 'rowNumber' | 'projectId' | 'styleCode'>, row: BudgetCostParsedRow, order: BudgetOrderSource) => prior.sheetName === row.sheetName && prior.rowNumber === row.rowNumber && prior.projectId === order.projectId && prior.styleCode === order.styleCode
export async function buildBudgetCostImportPreview(workspace: CostWorkspace, book: BudgetCostImportWorkbook, options: BudgetCostImportOptions = {}): Promise<BudgetCostImportPreview> {
  const selected = book.sheets.filter(sheet => sheet.supported && (options.sheetNames == null || options.sheetNames.includes(sheet.name)))
  const inputRows = selected.flatMap(sheet => sheet.rows)
  if (inputRows.length > MAX_BUDGET_COST_ROWS) throw new Error('원가 업로드는 한 번에 10,000개 항목까지 지원합니다.')
  const contentHash = await hash(selected.map(sheet => [sheet.name, sheet.rows.map(row => [row.rowNumber, row.projectCode, row.styleCode, row.values ? sourceFields.map(field => row.values![field]) : row.errors])]))
  const preview: BudgetCostImportPreview = { fileName: book.fileName, contentHash, rows: [], errors: [], warnings: [], inserted: 0, updated: 0, skipped: 0, ignoredRows: selected.reduce((sum, sheet) => sum + sheet.ignoredRows, 0) }
  if (!selected.length) preview.errors.push('가져올 원가 시트를 선택해 주세요.')
  if (!inputRows.length) preview.errors.push('15행 제목 아래에 가져올 원가 항목이 없습니다.')
  const sources = sourceOrders(workspace), imports = workspace.budgetCostImports || [], records = workspace.budgetRecords || []
  for (const row of inputRows) {
    const seen = new Set<string>(), key = budgetCostMatchKey(row.projectCode, row.styleCode)
    const candidates = sources.filter(source => budgetCostMatchKey(source.projectCode, source.styleCode) === key).filter(source => !seen.has(source.projectId) && !!seen.add(source.projectId))
    const projectId = options.projectIds?.[key]
    const order = projectId ? candidates.find(candidate => candidate.projectId === projectId) || null : candidates.length === 1 ? candidates[0] : null
    const value: BudgetCostImportPreviewRow = { ...row, key: JSON.stringify([row.sheetName, row.rowNumber]), action: 'error', errors: [...row.errors], warnings: [], candidates, order, write: null }
    preview.rows.push(value)
    if (!candidates.length) value.errors.push('프로젝트 코드와 컬러 포함 SKU가 모두 일치하는 발주가 없습니다. 발주요청세부를 확인해 주세요.')
    else if (!order) value.errors.push(projectId ? '선택한 프로젝트는 해당 코드·SKU와 연결되어 있지 않습니다.' : '동일 코드·SKU를 사용하는 프로젝트가 여러 개입니다. 기존 프로젝트 ID를 선택해 주세요.')
    if (!order || !row.values || value.errors.length) continue
    const sourceKey = budgetCostSourceKey(book.fileName, row.sheetName, row.rowNumber, order.projectId, order.styleCode)
    const alias = workspace.budgetCostImportAliases?.find(alias => alias.contentHash === contentHash && samePosition(alias, row, order))
    const previous = imports.find(prior => prior.sourceKey === sourceKey) || (alias ? imports.find(prior => prior.recordId === alias.recordId) : undefined) || imports.find(prior => prior.contentHash === contentHash && samePosition(prior, row, order))
    const otherOrigin = !previous ? imports.find(prior => samePosition(prior, row, order)) : undefined
    if (otherOrigin) { value.errors.push(`같은 프로젝트·SKU의 해당 행은 '${otherOrigin.fileName}' 업로드와 연결되어 있습니다. 수정 파일을 기존 파일명으로 저장한 뒤 다시 업로드해 주세요.`); continue }
    const before = previous ? records.find((record): record is Extract<BudgetRecord, { kind: 'cost' }> => record.id === previous.recordId && record.kind === 'cost') : undefined
    if (previous && !before) { value.errors.push('이전 업로드의 원가 기록을 찾을 수 없습니다. 최신 자료를 다시 불러와 주세요.'); continue }
    const suppliers = workspace.factories.filter(factory => cleanKey(factory.name) === cleanKey(row.values!.supplierName))
    const supplierId = before?.data.supplierName === row.values.supplierName && workspace.factories.some(factory => factory.id === before.data.supplierId) ? before.data.supplierId : suppliers.length === 1 ? suppliers[0].id : ''
    if (!supplierId && row.values.supplierName) value.warnings.push('업체명은 원본대로 보관하며, 등록된 업체와 연결되지 않아 업체 미지정으로 가져옵니다.')
    const data: BudgetCostData = { projectId: order.projectId, budgetCode: order.budgetCode, styleCode: order.styleCode, supplierId, stage: 'pre', ...row.values, amount: multiplyBudgetCost(row.values.unitCost!, row.values.consumption!), voided: false }
    try { validateBudgetRecordData(workspace, 'cost', data) } catch (error) { value.errors.push(error instanceof Error ? error.message : '연결 원가를 확인해 주세요.'); continue }
    const action = before ? sameCost(before.data, data) ? 'skip' : 'update' : 'insert'
    const source: BudgetCostImportSource = { fileName: book.fileName, sheetName: row.sheetName, rowNumber: row.rowNumber, sourceKey, rowFingerprint: await hash(canonicalCost(data)), contentHash }
    value.action = action; value.write = { recordId: before?.id || await sourceRecordId(sourceKey), expectedVersion: before?.version || 0, projectCode: order.projectCode, styleCode: order.styleCode, data, source, action }
    if (action === 'insert') preview.inserted += 1
    else if (action === 'update') preview.updated += 1
    else preview.skipped += 1
  }
  for (const row of preview.rows) for (const error of row.errors) preview.errors.push(`${location(row)}: ${error}`)
  const positions = new Set(preview.rows.filter(row => row.write).map(row => row.write!.source.sourceKey))
  const missing = imports.filter(prior => normalizeBudgetCostFileName(prior.fileName) === normalizeBudgetCostFileName(book.fileName) && selected.some(sheet => sheet.name === prior.sheetName) && !positions.has(prior.sourceKey))
  if (missing.length) preview.warnings.push(`이전 업로드의 ${missing.length}개 항목은 이번 파일에 없습니다. 기존 원가를 자동 삭제하지 않으므로 사용 중지 여부를 확인해 주세요.`)
  const manual = records.filter(record => record.kind === 'cost' && !imports.some(prior => prior.recordId === record.id) && preview.rows.some(row => row.order?.projectId === record.data.projectId && row.order.budgetCode === record.data.budgetCode))
  if (manual.length) preview.warnings.push(`연결 예산에 수기로 등록한 원가 ${manual.length}건이 있습니다. 기존 수기 원가와 업로드 항목이 함께 합산되는지 확인해 주세요.`)
  return preview
}

function assertImportRequest(request: BudgetCostImportRequest, reason: string): void {
  if (!uuid.test(request.importId) || !request.fileName.trim() || request.fileName.length > 255 || /[\x00-\x1f\x7f]/.test(request.fileName) || !sha.test(request.contentHash) || request.rows.length < 1 || request.rows.length > MAX_BUDGET_COST_ROWS || reason.trim().length < 2 || reason.length > 1000) throw new Error('원가 파일·업로드 항목·변경 사유를 확인해 주세요.')
}
/** No persistence occurs here. A caller saves once, only after every row and
 * current version has passed validation, so late errors leave originals intact. */
export function applyBudgetCostImportInWorkspace(workspace: CostWorkspace, supplied: Profile, request: BudgetCostImportRequest, reason: string): { workspace: CostWorkspace; result: BudgetCostImportResult } {
  const actor = workspace.profiles.find(profile => profile.id === supplied.id)
  if (!actor?.active || !actor.approved || !['admin', 'internal'].includes(actor.role)) throw new Error('원가 업로드는 승인된 본사 관리자·직원만 할 수 있습니다.')
  if (workspace.budgetCostImportAvailable !== true || workspace.budgetAvailable !== true) throw new Error('원가 업로드 설정을 적용한 뒤 다시 접속해 주세요.')
  assertImportRequest(request, reason)
  const signature = JSON.stringify([request.fileName, request.contentHash, request.rows.map(row => [row.recordId, row.expectedVersion, row.projectCode, row.styleCode, canonicalCost(row.data), row.source, row.action]), reason])
  const receipt = workspace.budgetCostImportReceipts?.find(receipt => receipt.importId === request.importId)
  if (receipt) {
    if (receipt.requestSignature !== signature) throw new Error('같은 업로드 요청 ID가 다른 내용에 사용되었습니다. 미리보기를 다시 열어 주세요.')
    return { workspace, result: { ...receipt.result } }
  }
  const existing = workspace.budgetCostImports || [], orders = sourceOrders(workspace), seenKeys = new Set<string>(), seenIds = new Set<string>()
  for (const row of request.rows) {
    const source = row.source, order = orders.find(order => order.projectId === row.data.projectId && order.projectCode === row.projectCode && order.styleCode === row.styleCode && order.budgetCode === row.data.budgetCode)
    if (!order || row.data.stage !== 'pre' || row.data.styleCode !== row.styleCode || row.data.voided || !uuid.test(row.recordId) || !Number.isSafeInteger(row.expectedVersion) || row.expectedVersion < 0 || !['insert', 'update', 'skip'].includes(row.action) || !source.sheetName.trim() || source.sheetName.length > 100 || source.rowNumber <= BUDGET_COST_HEADER_ROW || !Number.isInteger(source.rowNumber) || source.rowNumber > MAX_BUDGET_COST_ROWS + BUDGET_COST_HEADER_ROW || source.fileName !== request.fileName || source.contentHash !== request.contentHash || !sha.test(source.rowFingerprint) || source.sourceKey !== budgetCostSourceKey(source.fileName, source.sheetName, source.rowNumber, row.data.projectId, row.styleCode)) throw new Error('원본 행과 현재 프로젝트·SKU의 원가 연결을 확인해 주세요.')
    if (seenKeys.has(source.sourceKey) || seenIds.has(row.recordId)) throw new Error('같은 원가 업로드 항목이 중복되어 있습니다.')
    seenKeys.add(source.sourceKey); seenIds.add(row.recordId)
    validateBudgetRecordData(workspace, 'cost', row.data)
    if (row.data.unitCost === null || row.data.consumption === null || row.data.amount !== multiplyBudgetCost(row.data.unitCost, row.data.consumption)) throw new Error('원가 금액은 단가(Q열) × 요척량(S열)과 같아야 합니다.')
    const before = workspace.budgetRecords?.find(record => record.id === row.recordId)
    if ((before?.version || 0) !== row.expectedVersion) throw new Error('VERSION_CONFLICT: 다른 사용자가 원가를 먼저 수정했습니다.')
    const alias = workspace.budgetCostImportAliases?.find(alias => alias.contentHash === request.contentHash && alias.sheetName === source.sheetName && alias.rowNumber === source.rowNumber && alias.projectId === row.data.projectId && alias.styleCode === row.styleCode)
    const prior = existing.find(prior => prior.sourceKey === source.sourceKey) || (alias ? existing.find(prior => prior.recordId === alias.recordId) : undefined) || existing.find(prior => prior.contentHash === request.contentHash && prior.sheetName === source.sheetName && prior.rowNumber === source.rowNumber && prior.projectId === row.data.projectId && prior.styleCode === row.styleCode)
    if (!prior && existing.some(prior => prior.sheetName === source.sheetName && prior.rowNumber === source.rowNumber && prior.projectId === row.data.projectId && prior.styleCode === row.styleCode)) throw new Error('같은 원가 행이 다른 파일명으로 등록되어 있습니다. 기존 파일명으로 수정 파일을 저장해 주세요.')
    if (row.action === 'insert' ? !!before || !!prior || row.expectedVersion !== 0 : !before || before.kind !== 'cost' || !prior || prior.recordId !== row.recordId) throw new Error('VERSION_CONFLICT: 기존 원가와 업로드 연결이 변경되었습니다. 미리보기를 다시 확인해 주세요.')
    if (row.action === 'skip' && before?.kind === 'cost' && !sameCost(before.data, row.data)) throw new Error('VERSION_CONFLICT: 동일 원가로 표시한 항목의 금액 또는 내용이 다릅니다.')
  }
  let next = structuredClone(workspace)
  const result: BudgetCostImportResult = { inserted: 0, updated: 0, skipped: 0 }, now = new Date().toISOString()
  for (const row of request.rows) {
    if (row.action !== 'skip') next = saveBudgetRecordInWorkspace(next, actor, row.recordId, 'cost', row.data, row.expectedVersion, reason)
    const prior = next.budgetCostImports?.find(prior => prior.recordId === row.recordId)
    const metadata: BudgetCostImportProvenance = { ...(prior || row.source), recordId: row.recordId, projectId: row.data.projectId, styleCode: row.styleCode, rowFingerprint: row.source.rowFingerprint, contentHash: request.contentHash, updatedAt: now, updatedBy: actor.id }
    next.budgetCostImports = [...(next.budgetCostImports || []).filter(prior => prior.recordId !== row.recordId), metadata]
    const alias = { contentHash: request.contentHash, sheetName: row.source.sheetName, rowNumber: row.source.rowNumber, projectId: row.data.projectId, styleCode: row.styleCode, recordId: row.recordId }
    if (!(next.budgetCostImportAliases || []).some(existing => existing.contentHash === alias.contentHash && existing.sheetName === alias.sheetName && existing.rowNumber === alias.rowNumber && existing.projectId === alias.projectId && existing.styleCode === alias.styleCode)) next.budgetCostImportAliases = [...(next.budgetCostImportAliases || []), alias]
    if (row.action === 'insert') result.inserted += 1
    else if (row.action === 'update') result.updated += 1
    else result.skipped += 1
  }
  next.budgetCostImportReceipts = [...(next.budgetCostImportReceipts || []).slice(-99), { importId: request.importId, requestSignature: signature, result: { ...result } }]
  return { workspace: next, result }
}
