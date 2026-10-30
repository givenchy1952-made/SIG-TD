import { CHECKS, SIZES, STAGE_LABEL, STATUS_LABEL, quantityTotal } from './types'
import type { Style, Workspace } from './types'
import { fullStyleSku } from './style-identity'
import { filterStylesByProjects, getProjectIdentity } from './project-identity'

export type ExportView = 'overview' | 'samples' | 'production' | 'settlement'
type Cell = string | number | boolean | null | undefined
export interface ExportSheet { name: string; headers: string[]; rows: Cell[][] }
export interface WorkspaceExportScope { projectIds?: readonly string[] | null }

/** CSV cells are quoted and dangerous spreadsheet formulas are made literal. */
export function safeCSVCell(value: Cell): string {
  const text = value == null ? '' : String(value)
  const literal = typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text
  return `"${literal.replaceAll('"', '""')}"`
}

function snapshot(value: unknown): string {
  if (value == null) return ''
  const result = JSON.stringify(value)
  return result.length > 32000 ? `${result.slice(0, 31950)}… (전체 내역은 시스템에서 확인)` : result
}

/** Receives only the caller's currently accessible, filtered records. */
export function buildExportSheets(workspace: Workspace, selectedStyles: Style[], scope: WorkspaceExportScope = {}): ExportSheet[] {
  const styles = filterStylesByProjects(selectedStyles, scope.projectIds ?? null)
  const ids = new Set(styles.map(style => style.id))
  const factoryName = (id: string) => workspace.factories.find(factory => factory.id === id)?.name ?? id
  const ownerName = (id: string) => workspace.profiles.find(profile => profile.id === id)?.name ?? id
  const projectName = (id: string) => getProjectIdentity(workspace, id).name
  const styleCode = (id: string) => styles.find(style => style.id === id)?.code ?? id
  const sum = (style: Style, key: 'order' | 'packing' | 'shipped' | 'received') => style.production.reduce((total, line) => total + quantityTotal(line[key]), 0)
  const styleSheet: ExportSheet = {
    name: '스타일',
    headers: ['스타일 ID', '시즌', '프로젝트', '스타일 코드', '스타일명', '분류', '공장', '담당자', '컬러', '기준 납기', '진행 단계', 'PP 승인', '오더 수량', '패킹 수량', '실 출고 수량', '실 입고 수량', '샘플 차수 수', '본사 요청·메모', '최종 수정일', '수정자', '버전'],
    rows: styles.map(style => [style.id, style.season, projectName(style.projectId), style.code, style.name, style.category, factoryName(style.factoryId), ownerName(style.ownerId), style.colors.join(', '), style.dueDate, STAGE_LABEL[style.stage], style.ppApproved ? '승인' : '미승인', sum(style, 'order'), sum(style, 'packing'), sum(style, 'shipped'), sum(style, 'received'), style.samples.length, style.notes, style.updatedAt, ownerName(style.updatedBy), style.version]),
  }
  const sampleSheet: ExportSheet = {
    name: '샘플 이력',
    headers: ['시즌', '프로젝트', '스타일 코드', '스타일명', '샘플 ID', '샘플 차수', 'PP 샘플', '상태', '공장', '담당자', '요청일', '제작 예정일', '제작 완료일', '발송일', '본사 입고일', '리뷰·컨펌일', '운송장 번호', '수정 요청사항', '공장 코멘트', '샘플 최종 수정일'],
    rows: styles.flatMap(style => style.samples.map(sample => [style.season, projectName(style.projectId), style.code, style.name, sample.id, sample.round, sample.isPP ? 'PP' : '일반', STATUS_LABEL[sample.status], factoryName(sample.factoryId), ownerName(sample.ownerId), sample.requestedAt, sample.plannedAt, sample.completedAt, sample.shippedAt, sample.receivedAt, sample.reviewedAt, sample.tracking, sample.request, sample.factoryComment, sample.updatedAt])),
  }
  const productionSheet: ExportSheet = {
    name: '메인 생산',
    headers: ['시즌', '프로젝트', '공장', '담당자', '스타일 코드', '스타일명', '컬러 품번', '컬러', '기준 납기', 'PP 승인', ...CHECKS.map(([, label]) => label), ...(['order', 'packing', 'shipped', 'received'] as const).flatMap(key => {
      const label = { order: '오더', packing: '패킹리스트', shipped: '실 출고', received: '실 입고' }[key]
      return [...SIZES.map(size => `${label} ${size}`), `${label} 합계`]
    }), '컨펌 예정일', '실 출고일', '실 입고일', '세금계산서 발행', '정산 금액(KRW)', '결제 마감일', '결제 상태', '사이즈 측정', '공장 코멘트', '최종 수정일'],
    rows: styles.flatMap(style => style.production.map(line => [style.season, projectName(style.projectId), factoryName(style.factoryId), ownerName(line.ownerId ?? style.ownerId), style.code, style.name, fullStyleSku(style.code, line.color), line.color, style.dueDate, style.ppApproved ? '승인' : '미승인', ...CHECKS.map(([key]) => STATUS_LABEL[line.checks[key]]), ...(['order', 'packing', 'shipped', 'received'] as const).flatMap(key => [...SIZES.map(size => line[key][size]), quantityTotal(line[key])]), line.confirmDue, line.shippedAt, line.receivedAt, STATUS_LABEL[line.invoice], line.invoiceAmount, line.paymentDue, STATUS_LABEL[line.paymentStatus], line.measurements, line.factoryComment, style.updatedAt])),
  }
  const auditSheet: ExportSheet = {
    name: '변경 이력',
    headers: ['스타일 코드', '작업', '수정자', '변경 사유', '변경일', '이전 값(JSON)', '변경 값(JSON)'],
    rows: workspace.audits.filter(audit => audit.styleId && ids.has(audit.styleId)).map(audit => [styleCode(audit.styleId!), audit.action, audit.actorName || ownerName(audit.actorId), audit.reason, audit.createdAt, snapshot(audit.before), snapshot(audit.after)]),
  }
  const commentsSheet: ExportSheet = {
    name: '협업 코멘트',
    headers: ['스타일 코드', '샘플 ID', '작성자', '내용', '작성일'],
    rows: workspace.comments.filter(comment => ids.has(comment.styleId)).map(comment => [styleCode(comment.styleId), comment.sampleId ?? '', comment.authorName || ownerName(comment.authorId), comment.body, comment.createdAt]),
  }
  const attachmentSheet: ExportSheet = {
    name: '첨부파일 목록',
    headers: ['스타일 코드', '샘플 ID', '파일명', '종류', '크기(bytes)', '업로드 담당자', '업로드일'],
    rows: workspace.attachments.filter(attachment => ids.has(attachment.styleId)).map(attachment => [styleCode(attachment.styleId), attachment.sampleId ?? '', attachment.name, attachment.mime, attachment.size, ownerName(attachment.uploadedBy), attachment.createdAt]),
  }
  // Append project keys so existing quantity/status/owner column positions stay
  // compatible with consumers of these non-fixed-layout reports.
  for (const sheet of [styleSheet, sampleSheet, productionSheet]) {
    sheet.headers[sheet.headers.indexOf('프로젝트')] = '프로젝트 명칭'
    sheet.headers.push('프로젝트 코드', '프로젝트 ID')
  }
  const appendProjectKeys = (sheet: ExportSheet, rowStyles: Style[]) => sheet.rows.forEach((row, index) => { const style = rowStyles[index]; row.push(getProjectIdentity(workspace, style.projectId).code, style.projectId) })
  appendProjectKeys(styleSheet, styles)
  appendProjectKeys(sampleSheet, styles.flatMap(style => style.samples.map(() => style)))
  appendProjectKeys(productionSheet, styles.flatMap(style => style.production.map(() => style)))
  const styleProjects = new Map(styles.map(style => [style.code, getProjectIdentity(workspace, style.projectId)]))
  for (const sheet of [auditSheet, commentsSheet, attachmentSheet]) {
    sheet.headers.push('프로젝트 명칭', '프로젝트 코드', '프로젝트 ID')
    sheet.rows.forEach(row => { const project = styleProjects.get(String(row[0])); row.push(project?.name || '', project?.code || '', project?.id || '') })
  }
  return [styleSheet, sampleSheet, productionSheet, auditSheet, commentsSheet, attachmentSheet]
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function exportWorkspace(workspace: Workspace, styles: Style[], format: 'csv' | 'xlsx', view: ExportView = 'overview', scope: WorkspaceExportScope = {}): Promise<void> {
  const sheets = buildExportSheets(workspace, styles, scope)
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }).replaceAll('-', '')
  const name = { overview: '스타일', samples: '샘플현황', production: '메인생산', settlement: '업체정산' }[view]
  const filename = `SIG_${name}_${date}.${format}`
  if (format === 'csv') {
    const sheet = sheets[view === 'samples' ? 1 : view === 'production' || view === 'settlement' ? 2 : 0]
    const csv = '\uFEFF' + [sheet.headers, ...sheet.rows].map(row => row.map(safeCSVCell).join(',')).join('\r\n') + '\r\n'
    download(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), filename)
    return
  }
  const module = await import('exceljs')
  const ExcelJS = module.default ?? module
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'FIVE SPACE / SIG'
  workbook.created = new Date()
  workbook.subject = 'SIG SAMPLE MANAGEMENT 업무 데이터'
  for (const data of sheets) {
    const sheet = workbook.addWorksheet(data.name, { views: [{ state: 'frozen', ySplit: 1 }], properties: { defaultRowHeight: 22 } })
    sheet.addRow(data.headers)
    sheet.addRows(data.rows.map(row => row.map(value => value ?? '')))
    sheet.columns = data.headers.map(header => ({ width: /JSON|메모|요청|코멘트|내용|사이즈 측정/.test(header) ? 42 : /프로젝트|스타일명|파일명/.test(header) ? 28 : 18 }))
    const header = sheet.getRow(1)
    header.height = 30
    header.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17202E' } }
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }
      cell.alignment = { vertical: 'middle', wrapText: true }
    })
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: data.headers.length } }
    sheet.eachRow((row, index) => {
      if (index === 1) return
      row.eachCell(cell => {
        cell.alignment = { vertical: 'top', wrapText: true }
        if (index % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F6F8' } }
      })
    })
  }
  const bytes = await workbook.xlsx.writeBuffer()
  download(new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename)
}
