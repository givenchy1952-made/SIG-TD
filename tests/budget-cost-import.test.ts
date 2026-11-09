import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import type { BudgetCostData, BudgetOrderSource, BudgetRecord } from '../src/lib/budget-types'
import type { Workspace, Profile } from '../src/lib/types'
import type { BudgetCostImportPreview, BudgetCostImportRequest, BudgetCostImportsFields } from '../src/lib/budget-cost-import-types'
import { applyBudgetCostImportInWorkspace, BUDGET_COST_HEADERS, budgetCostMatchKey, buildBudgetCostImportPreview, parseBudgetCostWorkbook } from '../src/lib/budget-cost-import'

const id = (value: number) => `99890000-0000-4000-8000-${String(value).padStart(12, '0')}`
const actor: Profile = { id: id(1), role: 'admin', name: '본사', email: 'hq@example.test', active: true, approved: true, factoryId: null }
const finance: Profile = { ...actor, id: id(2), role: 'finance' }
const factory: Profile = { ...actor, id: id(3), role: 'factory', factoryId: id(10) }
const order: BudgetOrderSource = { projectId: id(20), projectCode: 'SIGNIFICANT-2027FY-RPQ-99001', projectName: '시그니피컨트 공식 프로젝트', budgetCode: 'SIGNIFICANT-2027FY-RPQ-99001BP09FYJK0001BK', styleId: id(30), lineId: id(31), styleCode: 'BP09FYJK0001BK', color: 'BK', season: '2027FY', factoryId: id(10), factoryName: '봉제 공장', sourceKey: `production:${id(40)}`, brand: 'SIGNIFICANT', productionType: 'RPQ', orderCode: '99001', orderDate: '2026-11-01', quantity: 1000, receivedQuantity: 0, joorQuantity: 400, aderQuantity: 600 }
const defaultCells: ExcelJS.CellValue[] = ['원단', '원가 업체', '명시 원가', '몸판', '원가 규격', '원가 품명', '면 100%', 'BK', 1234.5, null, 0.1234, 'YDS']
function workspace(): Workspace & BudgetCostImportsFields { return { profiles: [actor, finance, factory], styles: [], projects: [], factories: [{ id: id(10), name: '원가 업체', country: '대한민국' }], comments: [], attachments: [], audits: [], budgetSources: { orders: [order], settlements: [], warnings: [] }, budgetRecords: [], budgetAvailable: true, budgetCostImports: [], budgetCostImportAliases: [], budgetCostImportAvailable: true } }
async function file(options: { name?: string; cells?: ExcelJS.CellValue[]; second?: ExcelJS.CellValue[]; keys?: ExcelJS.CellValue[]; secondKeys?: ExcelJS.CellValue[]; blankTemplate?: boolean; merge?: boolean; headerRow?: number; extraSheet?: boolean } = {}) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('원가 업로드')
  BUDGET_COST_HEADERS.forEach((value, index) => { sheet.getCell(options.headerRow || 15, index + 2).value = value })
  const row = (number: number, cells: ExcelJS.CellValue[], keys = [order.projectCode, order.styleCode] as ExcelJS.CellValue[]) => {
    sheet.getCell(number, 2).value = keys[0]; sheet.getCell(number, 3).value = keys[1]
    cells.forEach((value, index) => { sheet.getCell(number, index + 4).value = value })
  }
  row(16, options.cells || defaultCells, options.keys)
  if (options.second) row(17, options.second, options.secondKeys)
  if (options.merge) { sheet.mergeCells('B16:B17'); sheet.mergeCells('C16:C17') }
  if (options.blankTemplate) { sheet.getCell('B19').value = { formula: 'C8' }; sheet.getCell('C19').value = { formula: 'C4' } }
  if (options.extraSheet) { const extra = book.addWorksheet('참조 목록'); extra.getCell('B16').value = '직접 가져오면 안 되는 참조 목록'; extra.getCell('D16').value = 100 }
  const buffer = new Uint8Array(await book.xlsx.writeBuffer())
  return { name: options.name || 'QA-원가.xlsx', size: buffer.length, arrayBuffer: async () => Uint8Array.from(buffer).buffer }
}
const request = (preview: BudgetCostImportPreview, importId = id(90)): BudgetCostImportRequest => ({ importId, fileName: preview.fileName, contentHash: preview.contentHash, rows: preview.rows.flatMap(row => row.write ? [row.write] : []) })
const apply = (w: Workspace & BudgetCostImportsFields, preview: BudgetCostImportPreview, importId = id(90)) => applyBudgetCostImportInWorkspace(w, actor, request(preview, importId), '원가 파일 내용 확인 후 적용').workspace

describe('원가 파일 15행 제목과 B/C·D:O 고정 매핑', () => {
  it('저장된 B/C 수식 결과를 공백 정리해 연결하고 D:O를 I:T, U를 Q×S로 가져온다', async () => {
    const book = await parseBudgetCostWorkbook(await file({ keys: [{ formula: 'C8', result: `${order.projectCode} ` }, { formula: 'C4', result: order.styleCode }], extraSheet: true }))
    const preview = await buildBudgetCostImportPreview(workspace(), book), row = preview.rows[0]
    expect(book.sheets.filter(sheet => sheet.supported)).toHaveLength(1)
    expect(row.rowNumber).toBe(16); expect(row.action).toBe('insert'); expect(preview.errors).toEqual([])
    expect(row.order).toMatchObject({ projectName: order.projectName, brand: 'SIGNIFICANT', season: '2027FY', productionType: 'RPQ', orderCode: '99001' })
    expect(row.write?.data).toMatchObject({ projectId: order.projectId, budgetCode: order.budgetCode, styleCode: order.styleCode, category: '원단', supplierId: id(10), supplierName: '원가 업체', description: '명시 원가', position: '몸판', specification: '원가 규격', itemName: '원가 품명', composition: '면 100%', color: 'BK', unitCost: 1234.5, variableUnitCost: null, consumption: 0.1234, unit: 'YDS', amount: 152.3373, stage: 'pre' })
    expect(row.write?.data.amount).not.toBe(152337.3)
  })
  it('빈 D:O 템플릿은 B/C 미계산 수식이 있어도 제외한다', async () => {
    const book = await parseBudgetCostWorkbook(await file({ blankTemplate: true })), preview = await buildBudgetCostImportPreview(workspace(), book)
    expect(preview.rows).toHaveLength(1); expect(preview.ignoredRows).toBe(3); expect(preview.errors).toEqual([])
  })
  it('실제 병합된 키는 읽지만 임의로 이전 행 키를 내려 채우지 않는다', async () => {
    const merged = await parseBudgetCostWorkbook(await file({ second: [...defaultCells], merge: true }))
    expect((await buildBudgetCostImportPreview(workspace(), merged)).inserted).toBe(2)
    const blank = await parseBudgetCostWorkbook(await file({ second: [...defaultCells], secondKeys: [null, null] }))
    const preview = await buildBudgetCostImportPreview(workspace(), blank)
    expect(preview.errors.some(error => error.includes('17행') && error.includes('프로젝트 코드'))).toBe(true)
    expect(preview.rows[1].write).toBeNull()
  })
  it('15행 헤더 불일치·확장자·크기와 채워진 행의 미계산 수식을 거부한다', async () => {
    await expect(parseBudgetCostWorkbook(await file({ headerRow: 14 }))).rejects.toThrow('15행')
    const source = await file(); await expect(parseBudgetCostWorkbook({ ...source, name: 'QA.csv' })).rejects.toThrow('.xlsx')
    await expect(parseBudgetCostWorkbook({ ...source, size: 10 * 1024 * 1024 + 1 })).rejects.toThrow('10MB')
    const book = await parseBudgetCostWorkbook(await file({ keys: [{ formula: 'C8' }, order.styleCode] }))
    expect((await buildBudgetCostImportPreview(workspace(), book)).errors.some(error => error.includes('계산 결과'))).toBe(true)
  })
  it('숫자 품명과 빈 단위를 보존하고 필수 단가·요척 빈칸은 0으로 바꾸지 않는다', async () => {
    const cells = [...defaultCells]; cells[5] = 15; cells[11] = null; cells[8] = 0; cells[10] = 2
    const valid = await buildBudgetCostImportPreview(workspace(), await parseBudgetCostWorkbook(await file({ cells })))
    expect(valid.rows[0].write?.data).toMatchObject({ itemName: '15', unit: '', unitCost: 0, amount: 0 })
    for (const index of [8, 10]) { const missing = [...defaultCells]; missing[index] = null; const preview = await buildBudgetCostImportPreview(workspace(), await parseBudgetCostWorkbook(await file({ cells: missing }))); expect(preview.errors.some(error => error.includes('빈칸을 0'))).toBe(true) }
  })
  it('음수·잘못된 천 단위·Excel 오류·허용 소수 초과를 행 오류로 표시한다', async () => {
    for (const value of [-1, '12,34', { error: '#REF!' } as ExcelJS.CellErrorValue, 1.001]) {
      const cells = [...defaultCells]; cells[8] = value
      const preview = await buildBudgetCostImportPreview(workspace(), await parseBudgetCostWorkbook(await file({ cells })))
      expect(preview.errors.length).toBeGreaterThan(0); expect(preview.rows[0].write).toBeNull()
    }
  })
})

describe('프로젝트·업체 연결과 중복/수정 미리보기', () => {
  it('코드와 전체 SKU를 함께 사용하며 스타일명이나 부분 SKU로 추측하지 않는다', async () => {
    const book = await parseBudgetCostWorkbook(await file({ keys: [order.projectCode, order.styleCode.slice(0, -2)] }))
    const preview = await buildBudgetCostImportPreview(workspace(), book)
    expect(preview.errors.some(error => error.includes('모두 일치'))).toBe(true)
    expect(workspace().budgetRecords).toEqual([])
  })
  it('동일 코드·SKU를 가진 서로 다른 프로젝트는 명시 선택한 ID로만 연결한다', async () => {
    const w = workspace(), other = { ...order, projectId: id(21), projectName: '같은 코드의 다른 프로젝트' }; w.budgetSources!.orders.push(other)
    const book = await parseBudgetCostWorkbook(await file()), ambiguous = await buildBudgetCostImportPreview(w, book)
    expect(ambiguous.rows[0].candidates).toHaveLength(2); expect(ambiguous.errors.some(error => error.includes('여러 개'))).toBe(true)
    const selected = await buildBudgetCostImportPreview(w, book, { projectIds: { [budgetCostMatchKey(order.projectCode, order.styleCode)]: other.projectId } })
    expect(selected.rows[0].write?.data.projectId).toBe(other.projectId)
  })
  it('미등록 업체명은 보존하고 업체를 중복 생성하거나 임의 배정하지 않는다', async () => {
    const w = workspace(); w.factories = []
    const preview = await buildBudgetCostImportPreview(w, await parseBudgetCostWorkbook(await file()))
    expect(preview.rows[0].write?.data).toMatchObject({ supplierName: '원가 업체', supplierId: '' })
    expect(preview.rows[0].warnings[0]).toContain('업체 미지정'); expect(w.factories).toEqual([])
  })
  it('미리보기 재계산·같은 파일·이름만 바꾼 동일 파일은 신규 원가를 늘리지 않는다', async () => {
    const w = workspace(), book = await parseBudgetCostWorkbook(await file()), first = await buildBudgetCostImportPreview(w, book), rebuilt = await buildBudgetCostImportPreview(w, book)
    expect(first.rows[0].write?.recordId).toBe(rebuilt.rows[0].write?.recordId)
    const saved = apply(w, first), repeated = await buildBudgetCostImportPreview(saved, book)
    expect(repeated).toMatchObject({ inserted: 0, updated: 0, skipped: 1 })
    const renamed = await buildBudgetCostImportPreview(saved, { ...book, fileName: '이름만 바꾼 파일.xlsx' })
    expect(renamed.contentHash).toBe(first.contentHash); expect(renamed.skipped).toBe(1)
    expect(apply(saved, renamed, id(91)).budgetRecords).toHaveLength(1)
  })
  it('같은 파일의 변경 행만 기존 ID와 버전으로 수정하고 과거 내용의 이름 변경은 수정으로 확인한다', async () => {
    const w = workspace(), originalBook = await parseBudgetCostWorkbook(await file({ second: [...defaultCells] })), original = await buildBudgetCostImportPreview(w, originalBook), saved = apply(w, original)
    const changedCells = [...defaultCells]; changedCells[8] = 2000
    const changedBook = await parseBudgetCostWorkbook(await file({ cells: changedCells, second: [...defaultCells] })), changed = await buildBudgetCostImportPreview(saved, changedBook)
    expect(changed).toMatchObject({ inserted: 0, updated: 1, skipped: 1 })
    expect(changed.rows[0].write?.recordId).toBe(original.rows[0].write?.recordId)
    const updated = apply(saved, changed, id(91))
    expect(updated.budgetRecords).toHaveLength(2)
    expect(updated.budgetRecords?.find(record => record.id === original.rows[0].write?.recordId)?.version).toBe(2)
    const oldRenamed = await buildBudgetCostImportPreview(updated, { ...originalBook, fileName: '과거 파일 이름 변경.xlsx' })
    expect(oldRenamed).toMatchObject({ inserted: 0, updated: 1, skipped: 1 })
    expect(oldRenamed.rows[0].write?.data.amount).toBe(152.3373)
  })
  it('이름을 바꾼 뒤 금액도 수정한 파일은 기존 원가를 중복 누적하지 않고 원래 파일명을 안내한다', async () => {
    const w = workspace(), originalBook = await parseBudgetCostWorkbook(await file()), original = await buildBudgetCostImportPreview(w, originalBook), saved = apply(w, original)
    const renamed = await buildBudgetCostImportPreview(saved, { ...originalBook, fileName: '이름 변경.xlsx' })
    expect(renamed.skipped).toBe(1)
    const cells = [...defaultCells]; cells[8] = 2000
    const editedRename = await buildBudgetCostImportPreview(saved, await parseBudgetCostWorkbook(await file({ name: '이름 변경.xlsx', cells })))
    expect(editedRename.inserted).toBe(0); expect(editedRename.errors.some(error => error.includes('QA-원가.xlsx') && error.includes('기존 파일명'))).toBe(true)
    expect(saved.budgetRecords).toHaveLength(1)
  })
  it('파일에서 빠진 행과 기존 수기 원가는 자동 삭제하거나 덮어쓰지 않는다', async () => {
    const book = await parseBudgetCostWorkbook(await file({ second: [...defaultCells] })), first = await buildBudgetCostImportPreview(workspace(), book), saved = apply(workspace(), first)
    const manual: BudgetRecord = { ...saved.budgetRecords![0], id: id(99) }
    saved.budgetRecords!.push(manual)
    const shorter = await parseBudgetCostWorkbook(await file()), preview = await buildBudgetCostImportPreview(saved, shorter)
    expect(preview.warnings.some(warning => warning.includes('이번 파일에 없습니다'))).toBe(true)
    expect(preview.warnings.some(warning => warning.includes('수기로 등록'))).toBe(true)
    expect(apply(saved, preview, id(92)).budgetRecords).toHaveLength(3)
  })
})

describe('체험 모드 원가 일괄 적용의 권한·원자성·재시도', () => {
  it('FA·공장·승인 해제·호출자 역할 위조와 설정 미적용을 차단한다', async () => {
    const w = workspace(), preview = await buildBudgetCostImportPreview(w, await parseBudgetCostWorkbook(await file())), batch = request(preview)
    for (const person of [finance, factory, { ...finance, role: 'admin' as const }]) expect(() => applyBudgetCostImportInWorkspace(w, person, batch, '권한 확인')).toThrow('본사')
    expect(() => applyBudgetCostImportInWorkspace({ ...w, profiles: [{ ...actor, active: false }] }, actor, batch, '권한 확인')).toThrow('본사')
    expect(() => applyBudgetCostImportInWorkspace({ ...w, budgetCostImportAvailable: false }, actor, batch, '설정 확인')).toThrow('설정')
  })
  it('마지막 행이 유효하지 않으면 앞 행도 저장하지 않고 기존 생산·결제와 원가를 보존한다', async () => {
    const w = workspace(), before = structuredClone(w), preview = await buildBudgetCostImportPreview(w, await parseBudgetCostWorkbook(await file({ second: [...defaultCells] }))), batch = request(preview)
    batch.rows[1].data.amount = 1
    expect(() => applyBudgetCostImportInWorkspace(w, actor, batch, '금액 확인')).toThrow('단가(Q열)')
    expect(w).toEqual(before)
  })
  it('오래된 버전과 수기 원가를 업로드 수정 대상으로 바꾼 요청을 거부한다', async () => {
    const w = workspace(), preview = await buildBudgetCostImportPreview(w, await parseBudgetCostWorkbook(await file())), saved = apply(w, preview)
    const stale = request(preview, id(91))
    expect(() => applyBudgetCostImportInWorkspace(saved, actor, stale, '버전 확인')).toThrow('VERSION_CONFLICT')
    const changed = await buildBudgetCostImportPreview(saved, await parseBudgetCostWorkbook(await file())), batch = request(changed, id(92))
    saved.budgetCostImports = []; saved.budgetCostImportAliases = []
    expect(() => applyBudgetCostImportInWorkspace(saved, actor, batch, '연결 확인')).toThrow('VERSION_CONFLICT')
  })
  it('동일 요청 ID의 네트워크 재시도는 기존 결과를 반환하고 다른 내용은 거부한다', async () => {
    const w = workspace(), preview = await buildBudgetCostImportPreview(w, await parseBudgetCostWorkbook(await file())), batch = request(preview)
    const first = applyBudgetCostImportInWorkspace(w, actor, batch, '일괄 적용')
    const retried = applyBudgetCostImportInWorkspace(first.workspace, actor, batch, '일괄 적용')
    expect(retried.result).toEqual(first.result); expect(retried.workspace.budgetRecords).toHaveLength(1)
    const changed = structuredClone(batch); changed.rows[0].data.amount = 0
    expect(() => applyBudgetCostImportInWorkspace(first.workspace, actor, changed, '일괄 적용')).toThrow('요청 ID')
  })
})
