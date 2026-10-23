import { SIZES, emptyQuantities, quantityTotal } from './types'
import type { Quantities, Size, Style, Workspace } from './types'
import { ORDER_SOURCE_COLUMNS, type OrderImportChange, type OrderSourceData } from './operations-types'

export type ImportCell = string | number | boolean | null | { error: string }
export interface ImportSheet { name: string; rows: ImportCell[][] }
export interface ImportWorkbook { name: string; sheets: ImportSheet[]; kind?: 'xlsx' | 'csv' }
export type ImportLayout = 'wide' | 'long'
export type OrderImportPreset = 'generic' | 'sig-order-qty'
export const SIG_ORDER_SOURCE_COLUMNS = ORDER_SOURCE_COLUMNS
export interface OrderSourceMetadata { rowNumber: number; columns: Record<string, ImportCell> }
export interface OrderColumnMapping { sku: number | null; color: number | null; size: number | null; quantity: number | null; total: number | null; sizes: Partial<Record<Size, number | null>> }
export interface OrderImportOptions { fileName?: string; preset?: OrderImportPreset; layout: ImportLayout; mapping: OrderColumnMapping; headerRow: number; duplicateMode: 'reject' | 'sum'; missingSizes: 'reject' | 'zero'; mode: 'replace' | 'add' }
export interface OrderImportPreviewRow {
  rowNumbers: number[]; sku: string; color: string; styleId: string | null; lineId: string | null; styleName: string;
  sourceMetadata?: OrderSourceMetadata[]; source?: OrderSourceData & { expectedVersion: number }; sourceChanged?: boolean; before: Quantities; imported: Quantities; after: Quantities; changed: boolean; errors: string[]; warnings: string[];
}
export interface OrderImportPreview { rows: OrderImportPreviewRow[]; changes: OrderImportChange[]; errors: string[]; warnings: string[]; sourceRows: number; matchedLines: number; changedLines: number; sourceChangedLines: number; changedStyles: number }
const MAX_QUANTITY = 10_000_000
const MAX_ROWS = 10_000
export const MAX_ORDER_IMPORT_FILE = 10 * 1024 * 1024

/** Read cached formula values only. No formula is evaluated or sent to an evaluator. */
export function orderImportCell(value: unknown): ImportCell {
  if (value == null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object') return { error: '지원하지 않는 셀 형식입니다.' }
  const cell = value as Record<string, unknown>
  if ('formula' in cell || 'sharedFormula' in cell) return cell.result === undefined || cell.result === null ? { error: '수식의 저장된 결과가 없습니다. Excel에서 계산 후 저장해 주세요.' } : orderImportCell(cell.result)
  if (typeof cell.error === 'string') return { error: `Excel 셀 오류: ${cell.error}` }
  if (Array.isArray(cell.richText)) return cell.richText.map(item => typeof item?.text === 'string' ? item.text : '').join('')
  if (typeof cell.text === 'string') return cell.text
  return { error: '지원하지 않는 셀 형식입니다.' }
}
/** UTF-8 CSV: RFC 4180 quotes, escaped quotes and embedded CR/LF are preserved. */
export function parseOrderCSV(input: string): ImportCell[][] {
  const text = input.replace(/^\uFEFF/, '')
  if (!text) return []
  const rows: ImportCell[][] = []
  let row: ImportCell[] = [], cell = '', quoted = false, closed = false, atBoundary = true, line = 1
  const pushCell = () => { row.push(cell); cell = ''; closed = false; if (row.length > 200) throw new Error('CSV는 최대 200열까지 지원합니다.') }
  const pushRow = () => { pushCell(); rows.push(row); row = []; atBoundary = true; if (rows.length > MAX_ROWS) throw new Error('CSV는 한 번에 10,000행 이하만 가져올 수 있습니다.') }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1 }
        else { quoted = false; closed = true }
      } else { cell += char; if (char === '\n' || char === '\r' && text[i + 1] !== '\n') line += 1 }
      continue
    }
    if (char === ',') { pushCell(); atBoundary = false; continue }
    if (char === '\r' || char === '\n') { if (char === '\r' && text[i + 1] === '\n') i += 1; pushRow(); line += 1; continue }
    if (closed) throw new Error(`CSV ${line}행: 닫는 따옴표 뒤에는 쉼표 또는 줄바꿈만 올 수 있습니다.`)
    if (char === '"') { if (cell) throw new Error(`CSV ${line}행: 따옴표가 포함된 셀은 전체를 큰따옴표로 감싸 주세요.`); quoted = true; atBoundary = false }
    else { cell += char; atBoundary = false }
  }
  if (quoted) throw new Error(`CSV ${line}행: 닫히지 않은 큰따옴표가 있습니다.`)
  if (!atBoundary || row.length || cell || closed) pushRow()
  return rows
}
export async function parseOrderWorkbook(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<ImportWorkbook> {
  if (!/\.(xlsx|csv)$/i.test(file.name)) throw new Error('Excel .xlsx 또는 UTF-8 CSV 파일을 선택해 주세요. 기존 .xls 파일은 .xlsx로 저장해 주세요.')
  if (!file.size || file.size > MAX_ORDER_IMPORT_FILE) throw new Error('비어 있지 않은 10MB 이하의 파일을 선택해 주세요. 큰 Excel 파일은 ORDER QTY 시트만 UTF-8 CSV로 저장해 주세요.')
  if (/\.csv$/i.test(file.name)) {
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) } catch { throw new Error('CSV를 UTF-8로 읽지 못했습니다. Excel에서 CSV UTF-8 형식으로 다시 저장해 주세요.') }
    const rows = parseOrderCSV(text)
    if (!rows.length) throw new Error('CSV 파일에 읽을 수 있는 행이 없습니다.')
    return { name: file.name, kind: 'csv', sheets: [{ name: file.name.replace(/\.csv$/i, ''), rows }] }
  }
  const module = await import('exceljs')
  const workbook = new (module.default ?? module).Workbook()
  try { await workbook.xlsx.load(await file.arrayBuffer()) } catch { throw new Error('Excel 파일을 읽지 못했습니다. 암호화되지 않은 .xlsx 파일인지 확인해 주세요.') }
  if (!workbook.worksheets.length) throw new Error('파일에 읽을 수 있는 시트가 없습니다.')
  if (workbook.worksheets.length > 30) throw new Error('30개 이하의 시트가 있는 파일을 사용해 주세요.')
  const sheets = workbook.worksheets.map(sheet => {
    if (sheet.rowCount > MAX_ROWS || sheet.columnCount > 200) throw new Error(`“${sheet.name}” 시트는 최대 ${MAX_ROWS.toLocaleString()}행, 200열까지 지원합니다. 필요한 영역만 별도 파일로 저장해 주세요.`)
    const rows: ImportCell[][] = []
    for (let i = 1; i <= sheet.rowCount; i++) {
      const values: ImportCell[] = []
      const row = sheet.getRow(i)
      for (let col = 1; col <= sheet.columnCount; col++) values.push(orderImportCell(row.getCell(col).value))
      rows.push(values)
    }
    return { name: sheet.name, rows }
  })
  return { name: file.name, sheets, kind: 'xlsx' }
}
const normalizedHeader = (cell: ImportCell) => typeof cell === 'string' || typeof cell === 'number' ? String(cell).toUpperCase().replace(/[\s_\-./()\[\]]/g, '') : ''
const aliases = {
  sku: ['SKU', '품번', '스타일', '스타일코드', 'STYLE', 'STYLECODE', 'ARTICLENO', 'ITEMCODE', '컬러품번', 'STYLE/COLOR'],
  color: ['COLOR', 'COLOUR', 'COL', '컬러', '칼라', '색상', '색상코드', '컬러코드'],
  size: ['SIZE', '사이즈', '규격'], quantity: ['QTY', 'QUANTITY', 'ORDERQTY', '수량', '오더수량', '주문수량', '생산수량'],
  total: ['TOTAL', 'TOTALQTY', '총수량', '합계', '총오더', '총오더수량', 'TOTALQUANTITY'],
}
export function autoMapOrderColumns(headers: ImportCell[]): { mapping: OrderColumnMapping; layout: ImportLayout } {
  const normalized = headers.map(normalizedHeader)
  const find = (list: string[]) => { const index = normalized.findIndex(h => list.map(normalizedHeader).includes(h)); return index < 0 ? null : index }
  const sizes: Partial<Record<Size, number | null>> = {}
  for (const size of SIZES) sizes[size] = find([size, `${size}수량`, `${size}오더`, `${size}QTY`, `오더${size}`, `ORDER${size}`, `수량${size}`])
  const mapping = { sku: find(aliases.sku), color: find(aliases.color), size: find(aliases.size), quantity: find(aliases.quantity), total: find(aliases.total), sizes }
  return { mapping, layout: Object.values(sizes).some(v => v !== null) ? 'wide' : mapping.size !== null && mapping.quantity !== null ? 'long' : 'wide' }
}
export function detectOrderHeaderRow(sheet: ImportSheet): number {
  let best = 1, bestScore = -1
  sheet.rows.slice(0, 30).forEach((row, index) => {
    const { mapping } = autoMapOrderColumns(row)
    const score = (mapping.sku === null ? 0 : 5) + (mapping.color === null ? 0 : 1) + Object.values(mapping.sizes).filter(v => v !== null).length * 2 + (mapping.size === null ? 0 : 3) + (mapping.quantity === null ? 0 : 3)
    if (score > bestScore) { bestScore = score; best = index + 1 }
  })
  return best
}
export function sigOrderColumnMapping(): OrderColumnMapping {
  return { sku: 5, color: null, size: null, quantity: null, total: 50, sizes: { XXS: 42, XS: 43, S: 44, M: 45, L: 46, XL: 47 } }
}
export function detectSigOrderHeaderRow(sheet: ImportSheet): number {
  const mapping = sigOrderColumnMapping()
  let best = -1, score = 0
  sheet.rows.slice(0, 50).forEach((row, index) => {
    const matches = SIZES.filter(size => normalizedHeader(row[mapping.sizes[size]!] ?? null) === size).length
    if (matches > score) { best = index; score = matches }
  })
  return score >= 3 ? best + 1 : detectOrderHeaderRow(sheet)
}
export function orderImportDefaults(book: ImportWorkbook, selectedSheet?: number): { sheetIndex: number; preset: OrderImportPreset; headerRow: number; mapping: OrderColumnMapping; layout: ImportLayout } {
  const exact = book.sheets.findIndex(sheet => sheet.name.trim().toUpperCase() === 'ORDER QTY')
  const sheetIndex = selectedSheet ?? (exact >= 0 ? exact : Math.max(0, book.sheets.findIndex(sheet => sheet.rows.length > 1)))
  const sheet = book.sheets[sheetIndex]
  const sigHeader = detectSigOrderHeaderRow(sheet)
  const sigMap = sigOrderColumnMapping()
  const hasFixedHeaders = SIZES.every(size => normalizedHeader(sheet.rows[sigHeader - 1]?.[sigMap.sizes[size]!] ?? null) === size)
  const preset: OrderImportPreset = sheet.name.trim().toUpperCase() === 'ORDER QTY' || hasFixedHeaders ? 'sig-order-qty' : 'generic'
  const headerRow = preset === 'sig-order-qty' ? sigHeader : detectOrderHeaderRow(sheet)
  const detected = autoMapOrderColumns(sheet.rows[headerRow - 1] || [])
  return { sheetIndex, preset, headerRow, mapping: preset === 'sig-order-qty' ? sigMap : detected.mapping, layout: preset === 'sig-order-qty' ? 'wide' : detected.layout }
}
const columnIndex = (name: string) => [...name].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1
function sourceMetadata(source: ImportCell[], rowNumber: number): OrderSourceMetadata {
  return { rowNumber, columns: Object.fromEntries(SIG_ORDER_SOURCE_COLUMNS.map(column => [column, source[columnIndex(column)] ?? null])) }
}
function matchSigOrderLine(workspace: Workspace, fullSku: string) {
  if (fullSku.length < 3 || !/[A-Z]{2}$/.test(fullSku)) throw new Error('F열 품번의 마지막 두 자리는 영문 컬러 코드여야 합니다.')
  const base = fullSku.slice(0, -2), color = fullSku.slice(-2)
  const candidates = workspace.styles.filter(style => !style.deletedAt && style.code.toUpperCase() === base).flatMap(style => style.production.filter(line => line.color === color).map(line => ({ style, line })))
  if (!candidates.length) throw new Error(`F열 기본 품번 ${base} / 컬러 ${color}와 정확히 일치하는 스타일이 없습니다. 스타일·컬러를 먼저 등록해 주세요.`)
  if (candidates.length > 1) throw new Error('F열 품번이 여러 스타일·컬러와 일치합니다. 시스템의 스타일 코드를 확인해 주세요.')
  return candidates[0]
}
function textCell(cell: ImportCell | undefined, label: string): string {
  if (typeof cell === 'object' && cell !== null) throw new Error(`${label}: ${cell.error}`)
  if (typeof cell === 'boolean') throw new Error(`${label}에 문자 값을 입력해 주세요.`)
  return cell == null ? '' : String(cell).trim().toUpperCase()
}
function quantityCell(cell: ImportCell | undefined, label: string, max = MAX_QUANTITY): number {
  if (typeof cell === 'object' && cell !== null) throw new Error(`${label}: ${cell.error}`)
  if (cell == null || typeof cell === 'string' && !cell.trim()) return 0
  let quantity: number
  if (typeof cell === 'number') quantity = cell
  else if (typeof cell === 'string' && /^(\d+|\d{1,3}(,\d{3})+)$/.test(cell.trim())) quantity = Number(cell.trim().replaceAll(',', ''))
  else throw new Error(`${label} 수량은 0~10,000,000 사이의 정수로 입력해 주세요.`)
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > max) throw new Error(`${label} 수량은 0~${max.toLocaleString()} 사이의 정수로 입력해 주세요.`)
  return quantity
}
function matchLine(workspace: Workspace, sku: string, color: string) {
  const styles = workspace.styles.filter(s => !s.deletedAt)
  const exact = styles.flatMap(style => style.production.filter(line => `${style.code}${line.color}`.toUpperCase() === sku).map(line => ({ style, line })))
  if (exact.length && color && !exact.some(candidate => candidate.line.color === color)) throw new Error(`품번 끝의 컬러와 색상 열이 다릅니다. (${sku} / ${color})`)
  const candidates = styles.flatMap(style => style.production.filter(line => (style.code.toUpperCase() === sku && !!color && line.color === color) || (`${style.code}${line.color}`.toUpperCase() === sku && (!color || line.color === color))).map(line => ({ style, line })))
  if (candidates.length > 1) throw new Error('동일한 품번이 여러 스타일·컬러와 일치합니다. 시스템의 스타일 코드를 확인해 주세요.')
  if (!candidates.length) {
    if (styles.some(s => s.code.toUpperCase() === sku)) throw new Error(color ? `이 스타일에 ${color} 컬러가 등록되어 있지 않습니다.` : '기본 스타일 품번에는 색상 열을 지정하거나 컬러가 붙은 전체 품번을 사용해 주세요.')
    throw new Error('등록된 스타일·컬러와 일치하는 품번이 없습니다. 스타일을 먼저 등록해 주세요.')
  }
  return candidates[0]
}
function sourceIdentity(data: OrderSourceData): string {
  return JSON.stringify([data.fileName, data.sheetName, ORDER_SOURCE_COLUMNS.map(column => data.headers[column]), data.rows.map(row => [row.rowNumber, ORDER_SOURCE_COLUMNS.map(column => row.columns[column])])])
}
const blankPreview = (row: number, sku = '', color = ''): OrderImportPreviewRow => ({ rowNumbers: [row], sku, color, styleId: null, lineId: null, styleName: '', before: emptyQuantities(), imported: emptyQuantities(), after: emptyQuantities(), changed: false, errors: [], warnings: [] })

export function buildOrderImportPreview(workspace: Workspace, sheet: ImportSheet, options: OrderImportOptions): OrderImportPreview {
  const { layout, headerRow, duplicateMode, missingSizes, mode } = options
  const fixed = options.preset === 'sig-order-qty'
  const mapping = fixed ? sigOrderColumnMapping() : options.mapping
  const errors: string[] = [], warnings: string[] = [], rows: OrderImportPreviewRow[] = []
  const result = (): OrderImportPreview => ({ rows, changes: [], errors, warnings, sourceRows: 0, matchedLines: 0, changedLines: 0, sourceChangedLines: 0, changedStyles: 0 })
  if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow >= sheet.rows.length) { errors.push('제목 행 아래에 수량 데이터가 있는지 확인해 주세요.'); return result() }
  if (sheet.rows.length > MAX_ROWS) { errors.push('한 번에 10,000행 이하만 가져올 수 있습니다.'); return result() }
  const sourceHeaders = {} as OrderSourceData['headers']
  if (fixed) {
    for (const column of SIG_ORDER_SOURCE_COLUMNS) {
      const value = sheet.rows[headerRow - 1]?.[columnIndex(column)] ?? null
      if (typeof value === 'object' && value !== null) errors.push(`원본 ${column}열 제목: ${value.error}`)
      else { sourceHeaders[column] = value == null ? '' : String(value); if (sourceHeaders[column].length > 4000) errors.push(`원본 ${column}열 제목은 4,000자 이내여야 합니다.`) }
    }
    if ((options.fileName?.trim() || '오더 가져오기').length > 255 || sheet.name.trim().length > 100) errors.push('원본 파일명은 255자, 시트명은 100자 이내여야 합니다.')
  }
  if (fixed && layout !== 'wide') errors.push('SIG ORDER QTY 형식은 AQ~AV 여섯 사이즈 열을 사용하는 가로 형식입니다.')
  if (mapping.sku === null) errors.push('품번 열을 지정해 주세요.')
  const sizeColumns = SIZES.filter(size => mapping.sizes[size] != null)
  if (layout === 'wide' && !sizeColumns.length) errors.push('사이즈별 수량 열이 없습니다. 총수량만으로 사이즈별 수량을 나눌 수 없습니다. XXS~XL 열을 지정하거나 사이즈·수량 세로 형식을 선택해 주세요.')
  if (layout === 'wide' && missingSizes === 'reject' && sizeColumns.length < SIZES.length) errors.push('XXS~XL 여섯 사이즈 열을 모두 지정해 주세요. 없는 사이즈를 0으로 처리하려면 옵션을 명시적으로 선택해 주세요.')
  if (layout === 'long' && (mapping.size === null || mapping.quantity === null)) errors.push('세로 형식에는 사이즈 열과 수량 열을 모두 지정해 주세요.')
  const activeColumns = [mapping.sku, mapping.color, ...(layout === 'wide' ? sizeColumns.map(s => mapping.sizes[s]) : [mapping.size, mapping.quantity]), ...(layout === 'wide' ? [mapping.total] : [])].filter((v): v is number => v != null)
  if (new Set(activeColumns).size !== activeColumns.length) errors.push('하나의 열을 여러 항목에 중복 지정할 수 없습니다.')
  if (activeColumns.some(index => !Number.isInteger(index) || index < 0 || index >= Math.max(...sheet.rows.map(row => row.length)))) errors.push('파일에 존재하는 열을 지정해 주세요.')
  if (errors.length) return result()
  const groups = new Map<string, { row: OrderImportPreviewRow; style: Style; seenSizes: Set<Size>; seenWide: boolean }>()
  let sourceRows = 0
  for (let index = headerRow; index < sheet.rows.length; index++) {
    const source = sheet.rows[index]
    if (activeColumns.every(col => source[col] == null || typeof source[col] === 'string' && !source[col].trim())) continue
    sourceRows += 1
    const rowNumber = index + 1
    let preview = blankPreview(rowNumber)
    if (fixed) preview.sourceMetadata = [sourceMetadata(source, rowNumber)]
    try {
      const sku = textCell(source[mapping.sku!], '품번'), color = mapping.color === null ? '' : textCell(source[mapping.color], '색상')
      preview.sku = sku; preview.color = color
      if (!sku) throw new Error('품번이 비어 있습니다.')
      const { style, line } = fixed ? matchSigOrderLine(workspace, sku) : matchLine(workspace, sku, color)
      const key = `${style.id}:${line.id}`
      let group = groups.get(key)
      if (!group) {
        preview = { ...preview, sku: `${style.code}${line.color}`, color: line.color, styleId: style.id, lineId: line.id, styleName: style.name, before: { ...line.order }, after: { ...line.order } }
        group = { row: preview, style, seenSizes: new Set(), seenWide: false }; groups.set(key, group); rows.push(preview)
      } else { if (fixed) group.row.sourceMetadata!.push(...preview.sourceMetadata!); preview = group.row; preview.rowNumbers.push(rowNumber) }
      const values = emptyQuantities()
      if (layout === 'wide') {
        if (group.seenWide && duplicateMode === 'reject') throw new Error('동일 품번·컬러가 여러 행에 있습니다. 중복 합산 옵션을 확인해 주세요.')
        if (group.seenWide) preview.warnings.push(`${rowNumber}행의 중복 수량을 합산했습니다.`)
        for (const size of sizeColumns) { values[size] = quantityCell(source[mapping.sizes[size]!], size); group.seenSizes.add(size) }
        if (mapping.total !== null && source[mapping.total] != null && source[mapping.total] !== '') {
          const total = quantityCell(source[mapping.total], '합계', MAX_QUANTITY * SIZES.length)
          if (total !== quantityTotal(values)) throw new Error(`사이즈 합계 ${quantityTotal(values).toLocaleString()}와 파일 합계 ${total.toLocaleString()}가 다릅니다.`)
        }
        group.seenWide = true
      } else {
        const size = textCell(source[mapping.size!], '사이즈') as Size
        if (!SIZES.includes(size)) throw new Error(`지원하지 않는 사이즈입니다: ${size || '(빈칸)'}. XXS~XL만 사용할 수 있습니다.`)
        if (group.seenSizes.has(size) && duplicateMode === 'reject') throw new Error(`동일 품번·컬러의 ${size} 사이즈가 중복되었습니다.`)
        if (group.seenSizes.has(size)) preview.warnings.push(`${rowNumber}행의 ${size} 중복 수량을 합산했습니다.`)
        values[size] = quantityCell(source[mapping.quantity!], size); group.seenSizes.add(size)
      }
      for (const size of SIZES) {
        preview.imported[size] += values[size]
        if (preview.imported[size] > MAX_QUANTITY) throw new Error(`${size} 합산 수량이 10,000,000을 초과합니다.`)
      }
    } catch (error) {
      preview.errors.push(`${rowNumber}행: ${error instanceof Error ? error.message : String(error)}`)
      if (!rows.includes(preview)) rows.push(preview)
    }
  }
  for (const { row, seenSizes } of groups.values()) {
    if (fixed) {
      const originals = row.sourceMetadata || []
      if (originals.length > 100) row.errors.push('동일 스타일·컬러의 원본 참조 행은 최대 100개까지 저장할 수 있습니다. 파일을 나누어 주세요.')
      const sourceRows: OrderSourceData['rows'] = []
      for (const original of originals) {
        const columns = {} as OrderSourceData['rows'][number]['columns']
        for (const column of SIG_ORDER_SOURCE_COLUMNS) {
          const value = original.columns[column]
          if (typeof value === 'object' && value !== null) row.errors.push(`${original.rowNumber}행 원본 ${column}열: ${value.error}`)
          else if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 1e15)) row.errors.push(`${original.rowNumber}행 원본 ${column}열의 숫자를 확인해 주세요.`)
          else if (typeof value === 'string' && value.length > 4000) row.errors.push(`${original.rowNumber}행 원본 ${column}열은 4,000자 이내여야 합니다.`)
          else columns[column] = value
        }
        sourceRows.push({ rowNumber: original.rowNumber, columns })
      }
      const data: OrderSourceData = { fileName: options.fileName?.trim() || '오더 가져오기', sheetName: sheet.name.trim(), headers: { ...sourceHeaders }, rows: sourceRows }
      if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 1024 * 1024) row.errors.push('한 스타일·컬러의 원본 참조 정보는 UTF-8 기준 1MB 이하로 나누어 주세요.')
      const beforeSource = workspace.operations?.orderSourceRecords?.find(source => source.styleId === row.styleId && source.lineId === row.lineId)
      row.source = { ...data, expectedVersion: beforeSource?.version || 0 }
      row.sourceChanged = !beforeSource || sourceIdentity(beforeSource) !== sourceIdentity(data)
    }
    const missing = SIZES.filter(size => !seenSizes.has(size))
    if (missing.length) {
      if (missingSizes === 'reject') row.errors.push(`${missing.join(', ')} 사이즈가 없습니다. 누락 사이즈 처리 옵션을 확인해 주세요.`)
      else row.warnings.push(`누락된 ${missing.join(', ')} 수량을 0으로 처리했습니다.${mode === 'replace' ? ' 해당 사이즈의 기존 오더는 0으로 바뀝니다.' : ''}`)
    }
    for (const size of SIZES) {
      row.after[size] = mode === 'replace' ? row.imported[size] : row.before[size] + row.imported[size]
      if (!Number.isSafeInteger(row.after[size]) || row.after[size] > MAX_QUANTITY) row.errors.push(`${size} 적용 후 수량이 10,000,000을 초과합니다.`)
    }
    row.changed = SIZES.some(size => row.before[size] !== row.after[size])
  }
  if (!sourceRows) errors.push('가져올 데이터 행이 없습니다.')
  const changed = rows.filter(row => row.styleId && row.lineId && (row.changed || row.sourceChanged) && !row.errors.length)
  const styleChanges = new Map<string, OrderImportChange>()
  for (const row of changed) {
    const style = groups.get(`${row.styleId}:${row.lineId}`)!.style
    let change = styleChanges.get(style.id)
    if (!change) { change = { styleId: style.id, expectedVersion: style.version, lines: [] }; styleChanges.set(style.id, change) }
    change.lines.push({ lineId: row.lineId!, color: row.color, quantities: { ...row.imported }, ...(row.source ? { source: row.source } : {}) })
  }
  if (styleChanges.size > 500 || changed.length > 1000) errors.push('한 번에 최대 500개 스타일·1,000개 컬러 라인까지 적용할 수 있습니다. 파일을 나누어 주세요.')
  return { rows, changes: errors.length || rows.some(row => row.errors.length) ? [] : [...styleChanges.values()], errors, warnings, sourceRows, matchedLines: groups.size, changedLines: changed.filter(row => row.changed).length, sourceChangedLines: changed.filter(row => row.sourceChanged).length, changedStyles: styleChanges.size }
}
