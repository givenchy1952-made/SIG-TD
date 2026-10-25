import JSZip from 'jszip'
import type { Profile, Style, Workspace } from './types'
import { quantityTotal, STATUS_LABEL } from './types'

export type SigEuljiKind = 'product' | 'label' | 'embroidery' | 'quality'

export interface SigEuljiRow {
  projectCode: string; receivedAtISO: string; factory: string; colorStyleCode: string;
  unitCost: number | null; orderQuantity: number; receivedQuantity: number | null; unit: 'EA' | 'YDS';
  netAmount: number | null; owner: string;
  kind?: Exclude<SigEuljiKind, 'product'>; itemName?: string; note?: string;
}
export interface SigEuljiPreview { rows: SigEuljiRow[]; errors: string[] }
export const MAX_SIG_EULJI_ROWS = 10000
export const SIG_EULJI_COLUMNS = { A: '프로젝트 코드', C: '입고일자', D: '업체명', I: '컬러 포함 품번', N: '장당 원가', O: '장수 (1)', P: 'PO 오더 수량', Q: '발주 수량 (P와 동일)', R: '실제 입고 수량', S: '단위', T: '금액 (부가세 제외)', W: '담당자' } as const
const TEMPLATE_URL = new URL('../assets/sig-eulji-template.xlsx', import.meta.url).href
const MAX_AMOUNT = 1_000_000_000_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const XML_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/
function text(value: unknown, max = 120): value is string { return typeof value === 'string' && !!value.trim() && value.length <= max && !XML_CONTROL.test(value) }
function projectCode(value: unknown): value is string { return text(value) && !UUID.test(value.trim()) && !/^(?:-|#(?:REF!|NAME\?|VALUE!|N\/A|DIV\/0!|NUM!|NULL!))$/i.test(value.trim()) }
function validDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value }
function cents(value: number): bigint {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000 || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) throw new Error('장당 원가는 0~1,000,000,000의 소수 둘째 자리까지 입력해 주세요.')
  return BigInt(Math.round(value * 100))
}
export function sigEuljiNetAmount(unitCost: number, receivedQuantity: number): number {
  if (!Number.isSafeInteger(receivedQuantity) || receivedQuantity < 0 || receivedQuantity > 60_000_000) throw new Error('실제 입고 수량이 올바르지 않습니다.')
  const amount = cents(unitCost) * BigInt(receivedQuantity)
  if (amount > BigInt(MAX_AMOUNT) * 100n) throw new Error('한 행의 결제 금액은 1조 원 이하여야 합니다.')
  return Number(amount) / 100
}
/** Use literal source A values only when every nonblank value agrees. */
export function sigEuljiSourceProjectCode(workspace: Workspace, styleId: string, lineId: string): string {
  const source = workspace.operations?.orderSourceRecords.find(row => row.styleId === styleId && row.lineId === lineId)
  const values = source?.rows.map(row => row.columns.A).filter(value => value !== null && value !== '').map(value => String(value).trim()).filter(Boolean) || []
  const unique = [...new Set(values)]
  return unique.length === 1 && projectCode(unique[0]) ? unique[0] : ''
}
/** Resolve canonical current styles, factories and employees; imported names never override assignments. */
export function buildSigEuljiRows(workspace: Workspace, styles: Style[], suppliedProfile: Profile, kind: SigEuljiKind = 'product'): SigEuljiPreview {
  if (kind !== 'product') return buildProcessingSigEuljiRows(workspace, styles, suppliedProfile, kind)
  const rows: SigEuljiRow[] = [], errors: string[] = []
  const profile = workspace.profiles.find(item => item.id === suppliedProfile.id)
  if (!profile?.approved || !profile.active || profile.role === 'factory') return { rows, errors: ['을지 자동 다운로드는 승인된 관리자·본사 직원만 사용할 수 있습니다.'] }
  if (workspace.settlementTermsAvailable !== true) errors.push('을지 단가·프로젝트 코드 저장 기능을 먼저 설정해 주세요. 관리자에게 004_settlement_terms.sql 적용을 요청하세요.')
  const selectedIds = new Set<string>()
  for (const selected of styles) {
    if (selectedIds.has(selected.id)) { errors.push('내보낼 스타일이 중복되었습니다.'); continue }
    selectedIds.add(selected.id)
    const style = workspace.styles.find(item => item.id === selected.id && !item.deletedAt)
    if (!style) { errors.push('선택한 스타일이 삭제되었거나 현재 조회 범위에 없습니다.'); continue }
    const factory = workspace.factories.find(item => item.id === style.factoryId)?.name
    const owner = workspace.profiles.find(item => item.id === style.ownerId)?.name
    const selectedLineIds = new Set<string>()
    for (const selection of selected.production) {
      const line = style.production.find(item => item.id === selection.id && item.color === selection.color)
      if (!line || selectedLineIds.has(selection.id)) { errors.push(`${style.code}: 선택한 컬러가 중복되었거나 변경되었습니다. 최신 필터 결과를 확인해 주세요.`); continue }
      selectedLineIds.add(selection.id)
      const label = `${style.code}${line.color}`
      const terms = workspace.settlementTerms?.find(item => item.styleId === style.id && item.lineId === line.id)
      const code = terms?.projectCode?.trim() || workspace.projects.find(project => project.id === style.projectId)?.code?.trim() || sigEuljiSourceProjectCode(workspace, style.id, line.id)
      const problems: string[] = []
      if (!projectCode(code)) problems.push('프로젝트 코드')
      if (terms?.unitCost === null || terms?.unitCost === undefined) problems.push('장당 원가')
      if (!validDate(line.receivedAt)) problems.push('실 입고일')
      if (!text(factory)) problems.push('업체명')
      if (!text(owner)) problems.push('본사 담당자')
      if (!text(label, 62) || !/^[A-Z]{2}$/.test(line.color)) problems.push('컬러 포함 품번')
      if (terms && !['product', 'fabric', 'label'].includes(terms.itemType)) problems.push('품목 구분')
      if (problems.length) { errors.push(`${label}: ${problems.join('·')}을 확인해 주세요.`); continue }
      try {
        const orderQuantity = quantityTotal(line.order), receivedQuantity = quantityTotal(line.received)
        if (!Number.isSafeInteger(orderQuantity) || orderQuantity < 0 || orderQuantity > 60_000_000) throw new Error('PO 오더 수량이 올바르지 않습니다.')
        const unitCost = terms!.unitCost!, netAmount = sigEuljiNetAmount(unitCost, receivedQuantity)
        rows.push({ projectCode: code, receivedAtISO: line.receivedAt, factory: factory!.trim(), colorStyleCode: label, unitCost, orderQuantity, receivedQuantity, unit: terms!.itemType === 'fabric' ? 'YDS' : 'EA', netAmount, owner: owner!.trim() })
      } catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }
  if (!styles.length || !styles.some(style => style.production.length)) errors.push('내보낼 스타일·컬러가 없습니다.')
  if (rows.length > MAX_SIG_EULJI_ROWS) errors.push('한 번에 최대 10,000개 컬러까지 다운로드할 수 있습니다.')
  return { rows, errors }
}

/** Service work has its own quantities and never inherits a garment's price or receipts. */
function buildProcessingSigEuljiRows(workspace: Workspace, styles: Style[], suppliedProfile: Profile, kind: Exclude<SigEuljiKind, 'product'>): SigEuljiPreview {
  const rows: SigEuljiRow[] = [], errors: string[] = []
  const actor = workspace.profiles.find(item => item.id === suppliedProfile.id)
  if (!actor?.approved || !actor.active || actor.role === 'factory') return { rows, errors: ['을지 자동 다운로드는 승인된 관리자·본사 직원만 사용할 수 있습니다.'] }
  if (kind === 'quality' ? workspace.refinementsAvailable !== true : workspace.operationsAvailable !== true) return { rows, errors: ['가공·품질 관리의 저장 기능을 먼저 설정해 주세요.'] }
  const kindLabel = kind === 'label' ? '중화라벨' : kind === 'embroidery' ? '비와이 자수' : '품질검사'
  const seenStyles = new Set<string>()
  const resolveProject = (style: Style, lineIds: string[]): string => {
    const values: unknown[] = [workspace.projects.find(item => item.id === style.projectId)?.code]
    for (const lineId of lineIds) {
      values.push(workspace.settlementTerms?.find(item => item.styleId === style.id && item.lineId === lineId)?.projectCode)
      for (const source of workspace.operations?.orderSourceRecords.filter(item => item.styleId === style.id && item.lineId === lineId) || []) values.push(...source.rows.map(row => row.columns.A))
    }
    const nonblank = values.filter(value => value !== undefined && value !== null && value !== '')
    if (nonblank.some(value => !projectCode(value))) return ''
    const unique = [...new Set(nonblank.map(value => String(value).trim()))]
    return unique.length === 1 ? unique[0] : ''
  }
  for (const selected of styles) {
    if (seenStyles.has(selected.id)) { errors.push('내보낼 스타일이 중복되었습니다.'); continue }
    seenStyles.add(selected.id)
    const style = workspace.styles.find(item => item.id === selected.id && !item.deletedAt)
    if (!style) { errors.push('선택한 스타일이 삭제되었거나 현재 조회 범위에 없습니다.'); continue }
    const seenLines = new Set<string>(), selectedLines: typeof style.production = []
    for (const selection of selected.production) {
      const line = style.production.find(item => item.id === selection.id && item.color === selection.color)
      if (!line || seenLines.has(selection.id)) errors.push(`${style.code}: 선택한 컬러가 중복되었거나 변경되었습니다. 최신 필터 결과를 확인해 주세요.`)
      else { seenLines.add(selection.id); selectedLines.push(line) }
    }
    if (!selectedLines.length || selectedLines.length !== selected.production.length) continue
    const owner = workspace.profiles.find(item => item.id === style.ownerId && item.role !== 'factory')?.name
    if (!text(owner)) { errors.push(`${style.code}: 본사 담당자를 확인해 주세요.`); continue }
    if (kind === 'quality') {
      for (const line of selectedLines) {
        const quality = workspace.productionDetails?.find(item => item.styleId === style.id && item.lineId === line.id)?.quality
        if (!quality?.category) continue
        const complete = ['done', 'approved'].includes(quality.status) && validDate(quality.completedAt)
        rows.push({ kind, projectCode: resolveProject(style, [line.id]), receivedAtISO: validDate(quality.completedAt) ? quality.completedAt : '', factory: '', colorStyleCode: `${style.code}${line.color}`, unitCost: null, orderQuantity: quality.quantity, receivedQuantity: complete ? quality.quantity : null, unit: 'EA', netAmount: null, owner: owner.trim(), itemName: `품질검사 · ${quality.category}`, note: `${STATUS_LABEL[quality.status]}${quality.note ? ` / ${quality.note}` : ''}` })
      }
    } else {
      const records = workspace.operations?.styleOperations.filter(item => item.styleId === style.id && item.kind === kind && !item.voided) || []
      for (const record of records) for (const item of record.rows) {
        rows.push({ kind, projectCode: resolveProject(style, style.production.map(line => line.id)), receivedAtISO: validDate(item.completedAt) ? item.completedAt : '', factory: kind === 'label' ? '주식회사 중화라벨' : 'BY컴퓨터자수', colorStyleCode: style.code, unitCost: null, orderQuantity: item.quantity, receivedQuantity: kind === 'label' ? null : item.completedQuantity, unit: 'EA', netAmount: null, owner: owner.trim(), itemName: item.name, note: [item.specification, `로스 수량 ${item.lossQuantity}개`, STATUS_LABEL[item.status], kind === 'label' ? '입고 수량 직접 입력' : '', item.note, record.note].filter(Boolean).join(' / ') })
      }
    }
  }
  for (const row of rows) try { validateRow(row) } catch (error) { errors.push(`${row.colorStyleCode} ${row.itemName}: ${error instanceof Error ? error.message : String(error)}`) }
  if (!rows.length && !errors.length) errors.push(`선택한 범위에 등록된 ${kindLabel} 내역이 없습니다.`)
  if (rows.length > MAX_SIG_EULJI_ROWS) errors.push('한 번에 최대 10,000개 작업까지 다운로드할 수 있습니다.')
  return { rows, errors }
}

export async function loadBundledSigEuljiTemplate(): Promise<Uint8Array> {
  const response = await fetch(TEMPLATE_URL)
  if (!response.ok) throw new Error('SIG 을지 원본 양식을 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요.')
  return new Uint8Array(await response.arrayBuffer())
}
const escapeXML = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
function excelDate(iso: string): number { return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000) }
function literalCell(column: string, row: number, value: string | number, style?: string): string {
  const attributes = `r="${column}${row}"${style === undefined ? '' : ` s="${style}"`}`
  return typeof value === 'number' ? `<c ${attributes}><v>${value}</v></c>` : `<c ${attributes} t="inlineStr"><is><t xml:space="preserve">${escapeXML(value)}</t></is></c>`
}
function formulaCell(column: string, row: number, formula: string, cached: string | number, style?: string): string {
  return `<c r="${column}${row}"${style === undefined ? '' : ` s="${style}"`}${typeof cached === 'string' ? ' t="str"' : ''}><f>${escapeXML(formula)}</f><v>${typeof cached === 'string' ? escapeXML(cached) : cached}</v></c>`
}
function validateRow(row: SigEuljiRow): void {
  const quantity = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 60_000_000
  if (row.kind) {
    if (!['label', 'embroidery', 'quality'].includes(row.kind) || row.projectCode !== '' && !projectCode(row.projectCode) || !text(row.owner) || !text(row.colorStyleCode, 62) || row.receivedAtISO !== '' && !validDate(row.receivedAtISO) || row.unit !== 'EA' || !quantity(row.orderQuantity) || row.receivedQuantity !== null && !quantity(row.receivedQuantity) || !text(row.itemName, 4000) || row.note !== undefined && (typeof row.note !== 'string' || row.note.length > 32767 || XML_CONTROL.test(row.note))) throw new Error('가공·품질 을지의 품번·작업명·수량·담당자·날짜를 확인해 주세요.')
    if (row.kind === 'quality' ? row.factory !== '' : row.factory !== (row.kind === 'label' ? '주식회사 중화라벨' : 'BY컴퓨터자수')) throw new Error('가공·품질 을지의 업체명을 확인해 주세요.')
    if (row.unitCost !== null) cents(row.unitCost)
    if (row.netAmount !== (row.unitCost === null || row.receivedQuantity === null ? null : sigEuljiNetAmount(row.unitCost, row.receivedQuantity))) throw new Error('가공·품질 을지의 단가·수량·금액을 확인해 주세요.')
    return
  }
  if (!projectCode(row.projectCode) || !text(row.factory) || !text(row.owner) || !text(row.colorStyleCode, 62) || !/[A-Z]{2}$/.test(row.colorStyleCode) || !validDate(row.receivedAtISO) || !['EA', 'YDS'].includes(row.unit) || !quantity(row.orderQuantity) || row.unitCost === null || row.receivedQuantity === null || row.netAmount !== sigEuljiNetAmount(row.unitCost, row.receivedQuantity)) throw new Error('을지의 프로젝트·업체·품번·단가·수량·금액·입고일을 확인해 주세요.')
}
async function xml(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path)
  if (!file) throw new Error('SIG 을지 원본 양식의 필수 구성을 찾을 수 없습니다.')
  const result = await file.async('string')
  if (/<!DOCTYPE|<!ENTITY/i.test(result)) throw new Error('지원하지 않는 XML 양식입니다.')
  return result
}
/** Preserve the original OOXML package, printer settings, table styles and custom XML.
 * This writer targets the supplied SIG template only; it is not a general XLSX editor.
 */
export async function fillSigEuljiTemplate(source: Uint8Array, rows: SigEuljiRow[]): Promise<Uint8Array> {
  if (!rows.length || rows.length > MAX_SIG_EULJI_ROWS) throw new Error('을지 데이터는 1~10,000개 컬러로 준비해 주세요.')
  rows.forEach(validateRow)
  if (!source.length || source.length > 1024 * 1024) throw new Error('SIG 을지 원본 양식이 올바르지 않습니다.')
  let zip: JSZip
  try { zip = await JSZip.loadAsync(source) } catch { throw new Error('SIG 을지 원본 양식을 읽을 수 없습니다.') }
  let sheet = await xml(zip, 'xl/worksheets/sheet1.xml')
  let table = await xml(zip, 'xl/tables/table1.xml')
  let workbook = await xml(zip, 'xl/workbook.xml')
  const prototype = sheet.match(/<row\b[^>]*\br="3"[^>]*>[\s\S]*?<\/row>/)?.[0]
  if (!prototype || !/name="대금지급\(을\)"/.test(workbook) || !/name="거래명세표"/.test(table) || !/\bref="A2:X3"/.test(table) || !/<dimension\b[^>]*ref="A1:X3"/.test(sheet)) throw new Error('제공된 SIG 을지 원본과 양식 구조가 다릅니다.')
  const prototypeCells = [...prototype.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
  const styleFor = (column: string) => prototypeCells.find(match => new RegExp(`\\br="${column}3"`).test(match[1]))?.[1].match(/\bs="(\d+)"/)?.[1]
  const lastRow = rows.length + 2
  const dataRows = rows.map((row, index) => {
    const n = index + 3
    const amountCents = row.unitCost === null || row.receivedQuantity === null ? null : cents(row.unitCost) * BigInt(row.receivedQuantity)
    const literal: Record<string, string | number | null> = { A: row.projectCode || null, C: row.receivedAtISO ? excelDate(row.receivedAtISO) : null, D: row.factory || null, I: row.colorStyleCode, N: row.unitCost, O: 1, P: row.orderQuantity, Q: row.orderQuantity, R: row.receivedQuantity, S: row.unit, T: row.netAmount, W: row.owner }
    if (row.kind) { literal.L = row.itemName || null; literal.X = row.note || null; delete literal.T }
    // Exact original table formulas: only the explicit A3 reference is advanced.
    const formulas: Record<string, [string, string | number]> = {
      E: [`MID(A${n},1,11)`, row.projectCode.slice(0, 11)],
      F: ['MID(거래명세표[[#This Row],[프로젝트 코드]],13,6)', row.projectCode.slice(12, 18)],
      G: ['MID(거래명세표[[#This Row],[프로젝트 코드]],20,3)', row.projectCode.slice(19, 22)],
      H: ['MID(거래명세표[[#This Row],[프로젝트 코드]],24,1)', row.projectCode.slice(23, 24)],
      M: ['MID(거래명세표[[#This Row],[스타일코드]],13,2)', row.colorStyleCode.slice(12, 14)],
      U: ['거래명세표[[#This Row],[금액]]*0.1', amountCents === null ? '' : Number(amountCents) / 1000],
      V: ['거래명세표[[#This Row],[VAT]]+거래명세표[[#This Row],[금액]]', amountCents === null ? '' : Number(amountCents * 11n) / 1000],
    }
    if (row.kind) {
      formulas.T = [`IF(OR(N${n}="",R${n}=""),"",N${n}*R${n})`, row.netAmount ?? '']
      formulas.U = [`IF(T${n}="","",T${n}*0.1)`, amountCents === null ? '' : Number(amountCents) / 1000]
      formulas.V = [`IF(T${n}="","",T${n}+U${n})`, amountCents === null ? '' : Number(amountCents * 11n) / 1000]
      if (row.kind !== 'quality') delete formulas.M
    }
    const cells = Array.from({ length: 24 }, (_, i) => String.fromCharCode(65 + i)).map(column => {
      const cellStyle = styleFor(column)
      if (column in literal && literal[column] !== null) return literalCell(column, n, literal[column]!, cellStyle)
      if (column in formulas) return formulaCell(column, n, ...formulas[column], cellStyle)
      // Blank user-entered columns remain blank, with their original cell style.
      return `<c r="${column}${n}"${cellStyle === undefined ? '' : ` s="${cellStyle}"`}/>`
    }).join('')
    return prototype.replace(/\br="3"/, `r="${n}"`).replace(/>[\s\S]*<\/row>$/, `>${cells}</row>`)
  }).join('')
  sheet = sheet.replace(prototype, dataRows).replace(/(<dimension\b[^>]*\bref=")A1:X3("[^>]*\/?>)/, `$1A1:X${lastRow}$2`)
  const totalCents = rows.reduce((sum, row) => sum + (row.unitCost === null || row.receivedQuantity === null ? 0n : cents(row.unitCost) * BigInt(row.receivedQuantity)), 0n)
  if (totalCents > BigInt(MAX_AMOUNT) * 100n) throw new Error('을지 전체 결제 금액은 1조 원 이하여야 합니다. 프로젝트·업체별로 나눠 다운로드해 주세요.')
  const incomplete = rows.some(row => row.netAmount === null)
  const processing = rows.some(row => !!row.kind)
  for (const [column, cached] of [['T', Number(totalCents) / 100], ['U', Number(totalCents) / 1000], ['V', Number(totalCents * 11n) / 1000]] as const) {
    const formula = processing ? `IF(COUNT(${column}3:${column}${lastRow})&lt;ROWS(${column}3:${column}${lastRow}),"",SUM(${column}3:${column}${lastRow}))` : `SUM(${column}3:${column}${lastRow})`
    sheet = sheet.replace(new RegExp(`<c\\b[^>]*\\br="${column}1"[^>]*>[\\s\\S]*?<\\/c>`), original => {
      const cell = original.replace(/<f>[\s\S]*?<\/f>/, `<f>${formula}</f>`).replace(/<v>[\s\S]*?<\/v>/, `<v>${incomplete ? '' : cached}</v>`)
      return incomplete ? cell.replace(/<c\b/, '<c t="str"') : cell
    })
  }
  sheet = sheet.replace(/(<dataValidation\b[^>]*\bsqref=")J3("[^>]*>)/, `$1J3:J${lastRow}$2`)
  table = table.replace(/\bref="A2:X3"/g, `ref="A2:X${lastRow}"`)
  // Drop the stale explicit calculation order and request normal recalculation.
  workbook = workbook.replace(/<calcPr\b([^>]*?)(?:\/>|>[\s\S]*?<\/calcPr>)/, (_match, attributes: string) => `<calcPr${attributes.replace(/\s(?:calcMode|fullCalcOnLoad|forceFullCalc)="[^"]*"/g, '')} calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>`)
  let relationships = await xml(zip, 'xl/_rels/workbook.xml.rels')
  relationships = relationships.replace(/<Relationship\b[^>]*\bType="[^"]*\/calcChain"[^>]*\/>/g, '')
  let contentTypes = await xml(zip, '[Content_Types].xml')
  contentTypes = contentTypes.replace(/<Override\b[^>]*\bPartName="\/xl\/calcChain\.xml"[^>]*\/>/g, '')
  zip.remove('xl/calcChain.xml')
  zip.file('xl/worksheets/sheet1.xml', sheet); zip.file('xl/tables/table1.xml', table); zip.file('xl/workbook.xml', workbook)
  zip.file('xl/_rels/workbook.xml.rels', relationships); zip.file('[Content_Types].xml', contentTypes)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
