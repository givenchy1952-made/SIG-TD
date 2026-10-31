import type { Workbook, Worksheet } from 'exceljs'
import { CHECKS, SIZES, STATUS_LABEL, quantityTotal, type Profile, type Style, type Workspace } from './types'
import { getProjectIdentity } from './project-identity'

export const MAX_SETTLEMENT_TEMPLATE_BYTES = 10 * 1024 * 1024
export const MAX_SETTLEMENT_DATA_ROWS = 10000
type QuantityGroup = 'order' | 'packing' | 'shipped' | 'received'
type BasicField = 'rowNumber' | 'season' | 'project' | 'projectCode' | 'projectId' | 'factory' | 'owner' | 'styleCode' | 'styleName' | 'colorCode' | 'color' | 'dueDate' | 'confirmDue' | 'shippedAt' | 'receivedAt' | 'invoice' | 'invoiceAmount' | 'paymentDue' | 'paymentStatus' | 'factoryComment' | 'notes'
export type SettlementFieldKey = BasicField | `${QuantityGroup}.${typeof SIZES[number] | 'total'}` | `check.${typeof CHECKS[number][0]}`
export type SettlementRow = Record<SettlementFieldKey, string | number>
interface SettlementField { key: SettlementFieldKey; label: string; aliases: string[] }
const baseFields: SettlementField[] = [
  { key: 'rowNumber', label: '순번', aliases: ['NO', 'NO.', '번호'] },
  { key: 'season', label: '시즌', aliases: ['시즌년도', '연도', '년도'] },
  { key: 'project', label: '프로젝트 명칭', aliases: ['프로젝트', '프로젝트명'] },
  { key: 'projectCode', label: '프로젝트 코드', aliases: ['프로젝트코드', 'PROJECT CODE'] },
  { key: 'projectId', label: '프로젝트 ID', aliases: ['프로젝트ID', 'PROJECT ID'] },
  { key: 'factory', label: '공장', aliases: ['공장명', '업체', '업체명', '거래처', '거래처명'] },
  { key: 'owner', label: '담당자', aliases: ['본사담당자'] },
  { key: 'styleCode', label: '스타일 코드 (컬러 제외)', aliases: ['스타일코드', '스타일품번', '모품번'] },
  { key: 'styleName', label: '제품명', aliases: ['스타일명', '상품명', '품명'] },
  { key: 'colorCode', label: '컬러 품번 (스타일+컬러)', aliases: ['품번', '컬러품번', '제품코드', '상품코드'] },
  { key: 'color', label: '컬러', aliases: ['색상', '색상코드', '컬러코드', 'COLOR'] },
  { key: 'dueDate', label: '기준 납기', aliases: ['기준납기일', '납기', '납기일'] },
  { key: 'confirmDue', label: '컨펌 예정일', aliases: [] },
  { key: 'shippedAt', label: '실 출고일', aliases: ['출고일', '출고일자'] },
  { key: 'receivedAt', label: '실 입고일', aliases: ['입고일', '입고일자'] },
  { key: 'invoice', label: '세금계산서 발행', aliases: ['세금계산서', '계산서발행', '세금계산서발행여부'] },
  { key: 'invoiceAmount', label: '정산 금액 (KRW)', aliases: ['정산금액', '마감금액', '금액', '합계금액', '정산금액KRW'] },
  { key: 'paymentDue', label: '결제 마감일', aliases: ['결제예정일', '결제일', '지급예정일'] },
  { key: 'paymentStatus', label: '결제 상태', aliases: ['결제여부', '지급상태'] },
  { key: 'factoryComment', label: '공장 코멘트', aliases: ['업체코멘트'] },
  { key: 'notes', label: '본사 메모', aliases: ['요청사항'] },
]
const quantityLabels: Record<QuantityGroup, string[]> = { order: ['오더', '발주'], packing: ['패킹리스트', '패킹'], shipped: ['실 출고', '출고'], received: ['실 입고', '입고'] }
export const SETTLEMENT_FIELDS: SettlementField[] = [
  ...baseFields,
  ...(['order', 'packing', 'shipped', 'received'] as const).flatMap(group => [...SIZES, 'total' as const].map(size => ({
    key: `${group}.${size}` as SettlementFieldKey,
    label: `${quantityLabels[group][0]} ${size === 'total' ? '합계' : size}`,
    aliases: quantityLabels[group].flatMap(label => size === 'total' ? [`${label}합계`, `${label}수량`, `${label}총수량`] : [`${label}${size}`, `${label}수량${size}`]),
  }))),
  ...CHECKS.map(([key, label]) => ({ key: `check.${key}` as SettlementFieldKey, label, aliases: [] })),
]
export interface SettlementTemplate { workbook: Workbook; source: Uint8Array; filename: string; sheets: { name: string; suggestedHeaderRow: number; columns: number }[] }
export interface SettlementTemplateColumn { column: number; letter: string; header: string }
export interface SettlementTemplateOptions { sheetName: string; headerRow: number; startRow: number; endRow: number; mapping: Record<number, SettlementFieldKey>; overwriteExisting: boolean }

/** The caller supplies its filtered rows. Recheck approval, deletion and factory scope. */
export function buildSettlementRows(workspace: Workspace, styles: Style[], profile: Profile): SettlementRow[] {
  if (!profile.approved || !profile.active) return []
  return styles.filter(style => !style.deletedAt && (profile.role !== 'factory' || !!profile.factoryId && style.factoryId === profile.factoryId)).flatMap(style => style.production.map(line => {
    const row = {
      season: style.season, project: getProjectIdentity(workspace, style.projectId).name, projectCode: getProjectIdentity(workspace, style.projectId).code, projectId: style.projectId,
      factory: workspace.factories.find(factory => factory.id === style.factoryId)?.name || style.factoryId,
      owner: workspace.profiles.find(owner => owner.id === style.ownerId)?.name || style.ownerId,
      styleCode: style.code, styleName: style.name, colorCode: `${style.code}${line.color}`, color: line.color,
      dueDate: style.dueDate, confirmDue: line.confirmDue, shippedAt: line.shippedAt, receivedAt: line.receivedAt,
      invoice: STATUS_LABEL[line.invoice], invoiceAmount: line.invoiceAmount, paymentDue: line.paymentDue,
      paymentStatus: STATUS_LABEL[line.paymentStatus], factoryComment: line.factoryComment, notes: style.notes,
    } as SettlementRow
    for (const group of ['order', 'packing', 'shipped', 'received'] as const) {
      for (const size of SIZES) row[`${group}.${size}`] = line[group][size]
      row[`${group}.total`] = quantityTotal(line[group])
    }
    for (const [key] of CHECKS) row[`check.${key}`] = STATUS_LABEL[line.checks[key]]
    return row
  })).map((row, index) => ({ ...row, rowNumber: index + 1 }))
}

function normalizeHeader(value: string): string { return value.normalize('NFKC').toUpperCase().replace(/[\s\p{P}\p{S}]/gu, '') }
export function settlementColumnLetter(column: number): string {
  let label = ''
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label
  return label
}
function getSheet(template: SettlementTemplate, name: string): Worksheet {
  const sheet = template.workbook.getWorksheet(name)
  if (!sheet) throw new Error('선택한 시트를 찾을 수 없습니다.')
  return sheet
}
export function inspectSettlementSheet(template: SettlementTemplate, sheetName: string, headerRow: number): SettlementTemplateColumn[] {
  if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > 1048576) return []
  const sheet = getSheet(template, sheetName)
  return Array.from({ length: Math.min(256, Math.max(1, sheet.columnCount)) }, (_, index) => {
    const candidate = sheet.findCell(headerRow, index + 1)
    const cell = candidate?.isMerged ? candidate.master : candidate
    return { column: index + 1, letter: settlementColumnLetter(index + 1), header: cell?.value == null ? '' : cell.text }
  })
}
/** Only unambiguous exact normalized aliases are selected; user mapping always wins. */
export function autoMapSettlementColumns(columns: SettlementTemplateColumn[]): Record<number, SettlementFieldKey> {
  const result: Record<number, SettlementFieldKey> = {}
  for (const column of columns) {
    const normalized = normalizeHeader(column.header)
    if (!normalized) continue
    const matches = SETTLEMENT_FIELDS.filter(field => [field.label, ...field.aliases].some(alias => normalizeHeader(alias) === normalized))
    if (matches.length === 1) result[column.column] = matches[0].key
  }
  return result
}

async function openWorkbook(bytes: Uint8Array): Promise<Workbook> {
  const module = await import('exceljs')
  const ExcelJS = module.default ?? module
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes as unknown as Parameters<Workbook['xlsx']['load']>[0])
  return workbook
}
export async function loadSettlementTemplate(bytes: ArrayBuffer | Uint8Array, filename: string): Promise<SettlementTemplate> {
  const source = new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).slice()
  if (!/\.xlsx$/i.test(filename)) throw new Error('.xlsx 형식의 실제 마감 양식을 선택해 주세요. .xls / .xlsm은 지원하지 않습니다.')
  if (!source.length || source.length > MAX_SETTLEMENT_TEMPLATE_BYTES) throw new Error('양식 파일은 10MB 이하의 .xlsx 파일이어야 합니다.')
  if (source[0] !== 0x50 || source[1] !== 0x4b) throw new Error('올바른 .xlsx 파일이 아닙니다. Excel에서 .xlsx로 다시 저장해 주세요.')
  let workbook: Workbook
  try { workbook = await openWorkbook(source) } catch { throw new Error('양식을 읽을 수 없습니다. 암호를 해제하고 Excel에서 .xlsx로 다시 저장해 주세요.') }
  const template: SettlementTemplate = { workbook, source, filename, sheets: [] }
  template.sheets = workbook.worksheets.filter(sheet => sheet.state === 'visible').map(sheet => {
    let suggestedHeaderRow = 1, highest = 0
    for (let row = 1; row <= Math.min(30, sheet.rowCount); row++) {
      const score = Object.keys(autoMapSettlementColumns(inspectSettlementSheet(template, sheet.name, row))).length
      if (score > highest) { highest = score; suggestedHeaderRow = row }
    }
    return { name: sheet.name, suggestedHeaderRow, columns: Math.min(256, Math.max(1, sheet.columnCount)) }
  })
  if (!template.sheets.length) throw new Error('사용할 수 있는 표시 상태의 시트가 없습니다.')
  return template
}

/** No insertion, formula rewriting or merging: all writes stay in an explicit bounded area. */
export function preflightSettlementTemplate(template: SettlementTemplate, options: SettlementTemplateOptions, rowCount: number): string[] {
  const errors: string[] = []
  const { sheetName, headerRow, startRow, endRow, mapping } = options
  const sheet = template.workbook.getWorksheet(sheetName)
  if (!sheet || sheet.state !== 'visible') return ['사용할 시트를 선택해 주세요.']
  if (![headerRow, startRow, endRow].every(value => Number.isInteger(value) && value >= 1 && value <= 1048576) || startRow <= headerRow || endRow < startRow) return ['머리글 다음 행부터 시작하는 올바른 데이터 범위를 입력해 주세요.']
  const capacity = endRow - startRow + 1
  if (capacity > MAX_SETTLEMENT_DATA_ROWS) return ['한 번에 채울 수 있는 데이터 범위는 최대 10,000행입니다.']
  if (!Number.isInteger(rowCount) || rowCount < 1) errors.push('내보낼 컬러별 생산 데이터가 없습니다.')
  if (rowCount > capacity) errors.push(`데이터 ${rowCount}행이 지정한 범위 ${capacity}행을 초과합니다. 합계·서명란 위의 빈 데이터 영역을 늘려 주세요.`)
  const entries = Object.entries(mapping)
  if (!entries.length) errors.push('채울 열을 하나 이상 연결해 주세요.')
  if (entries.some(([column, field]) => !Number.isInteger(Number(column)) || Number(column) < 1 || Number(column) > 256 || !SETTLEMENT_FIELDS.some(candidate => candidate.key === field))) return [...errors, '열 연결 정보가 올바르지 않습니다. A~IV열의 항목을 다시 선택해 주세요.']
  const model = sheet.model as typeof sheet.model & { sheetProtection?: { sheet?: boolean } }
  if (model.sheetProtection?.sheet) errors.push('보호된 시트에는 입력할 수 없습니다. 시트 보호를 해제한 양식을 사용해 주세요.')
  // Merged repeat rows need a format-specific implementation. Never guess geometry.
  const merged = (model.merges || []).find(range => {
    const bounds = range.match(/\$?[A-Z]+\$?(\d+):\$?[A-Z]+\$?(\d+)/i)
    return bounds && startRow <= Number(bounds[2]) && endRow >= Number(bounds[1])
  })
  if (merged) errors.push(`${merged}: 데이터 범위 안의 병합 셀은 지원하지 않습니다. 병합이 없는 데이터 범위를 지정해 주세요.`)
  const formulaCells: string[] = [], filledCells: string[] = []
  for (let row = startRow; row <= endRow; row++) for (const [column] of entries) {
    const cell = sheet.findCell(row, Number(column)), value = cell?.value
    if (!cell) continue
    if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) formulaCells.push(cell.address)
    else if (value !== null && value !== undefined && value !== '') filledCells.push(cell.address)
  }
  // Array/shared formula followers can look like numeric cells. Respect their entire ref.
  sheet.eachRow(row => row.eachCell(cell => {
    const value = cell.value
    // ExcelJS exposes array/shared-master ranges at runtime but omits `ref`
    // from its CellFormulaValue declarations. Narrow the runtime property.
    if (!value || typeof value !== 'object' || !('formula' in value) || !('ref' in value) || typeof value.ref !== 'string') return
    const bounds = value.ref.match(/^\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/i)
    if (!bounds) return
    const index = (letters: string) => [...letters.toUpperCase()].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0)
    if (startRow <= Number(bounds[4]) && endRow >= Number(bounds[2]) && entries.some(([column]) => Number(column) >= index(bounds[1]) && Number(column) <= index(bounds[3]))) formulaCells.push(value.ref)
  }))
  if (formulaCells.length) errors.push(`수식 보존을 위해 중단했습니다: ${formulaCells.slice(0, 6).join(', ')}${formulaCells.length > 6 ? ' 외' : ''}. 해당 열 연결을 해제하거나 데이터 범위를 바꿔 주세요.`)
  if (filledCells.length && !options.overwriteExisting) errors.push(`입력 영역에 기존 값이 있습니다: ${filledCells.slice(0, 6).join(', ')}${filledCells.length > 6 ? ' 외' : ''}. 확인 후 기존 값 교체에 동의해 주세요.`)
  return errors
}

export async function fillSettlementTemplate(template: SettlementTemplate, options: SettlementTemplateOptions, rows: SettlementRow[]): Promise<Uint8Array> {
  // Reopen original bytes so repeated downloads never mutate the uploaded template.
  const workbook = await openWorkbook(template.source)
  const errors = preflightSettlementTemplate({ ...template, workbook }, options, rows.length)
  if (errors.length) throw new Error(errors.join('\n'))
  const sheet = workbook.getWorksheet(options.sheetName)!
  for (let row = options.startRow; row <= options.endRow; row++) for (const [column, field] of Object.entries(options.mapping)) {
    const value = rows[row - options.startRow]?.[field]
    // Assign primitive strings, never {formula: ...}; spreadsheet-looking names stay literal.
    sheet.getCell(row, Number(column)).value = value === undefined || value === '' ? null : value
  }
  // Keep user-provided columns and their formulas untouched. The independent
  // guide retains both project identifiers even if the fixed form has one slot.
  if (rows.some(row => row.projectId || row.projectCode || row.project)) {
    let name = '프로젝트 안내', suffix = 2
    while (workbook.getWorksheet(name)) name = `프로젝트 안내 ${suffix++}`
    const guide = workbook.addWorksheet(name)
    guide.addRow(['양식 행', '프로젝트 명칭', '프로젝트 코드', '시즌', '스타일코드', '프로젝트 ID'])
    rows.forEach((row, index) => guide.addRow([options.startRow + index, row.project || row.projectCode || '', row.projectCode || '', row.season || '', row.colorCode || row.styleCode || '', row.projectId || '']))
    guide.columns.forEach((column, index) => { column.width = index === 0 ? 12 : index === 3 ? 18 : 36 })
    guide.views = [{ state: 'frozen', ySplit: 1 }]
    guide.autoFilter = `A1:F${rows.length + 1}`
  }
  workbook.calcProperties.fullCalcOnLoad = true
  // ExcelJS otherwise turns its parsed default firstPageNumber=1 into an enabled
  // manual page-number override, even when useFirstPageNumber was originally false.
  for (const worksheet of workbook.worksheets) {
    // Parsed by ExcelJS's PageSetupXform, but absent from its public typings.
    const pageSetup = worksheet.pageSetup as Worksheet['pageSetup'] & { useFirstPageNumber?: boolean }
    if (pageSetup.useFirstPageNumber === false) delete pageSetup.firstPageNumber
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}
