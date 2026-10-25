import { describe, expect, it } from 'vitest'
import { Workbook } from 'exceljs'
import { readFile } from 'node:fs/promises'
import { createSeed } from '../src/lib/seed'
import { SIZES, quantityTotal } from '../src/lib/types'
import { EMPTY_OPERATIONS } from '../src/lib/operations-types'
import { MAX_ORDER_IMPORT_FILE, autoMapOrderColumns, buildOrderImportPreview, detectOrderHeaderRow, detectSigOrderHeaderRow, orderImportCell, orderImportDefaults, parseOrderCSV, parseOrderWorkbook, sigOrderColumnMapping, SIG_ORDER_SOURCE_COLUMNS } from '../src/lib/order-import'
import type { ImportCell, ImportSheet, OrderImportOptions } from '../src/lib/order-import'

function fixture() {
  const workspace = createSeed()
  const style = workspace.styles[0], line = style.production[0]
  const headers: ImportCell[] = ['품번', '색상', ...SIZES, '합계']
  const { mapping } = autoMapOrderColumns(headers)
  const options: OrderImportOptions = { mapping, headerRow: 1, layout: 'wide', duplicateMode: 'reject', missingSizes: 'reject', mode: 'replace' }
  const row = (quantities = [1, 2, 3, 4, 5, 6], sku = `${style.code}${line.color}`, color = line.color): ImportCell[] => [sku, color, ...quantities, quantities.reduce((sum, value) => sum + value, 0)]
  const build = (rows: ImportCell[][], overrides: Partial<OrderImportOptions> = {}) => buildOrderImportPreview(workspace, { name: '오더', rows: [headers, ...rows] }, { ...options, ...overrides })
  return { workspace, style, line, headers, options, row, build }
}
const messages = (preview: ReturnType<typeof buildOrderImportPreview>) => [...preview.errors, ...preview.rows.flatMap(row => row.errors)].join(' ')

describe('실제 xlsx 파일 및 제목 행 인식', () => {
  it('제목 위에 안내 문구가 있는 실제 xlsx의 헤더와 사이즈 수량을 읽는다', async () => {
    const { style, row } = fixture()
    const workbook = new Workbook(), sheet = workbook.addWorksheet('ORDER')
    sheet.addRow(['업체 전달용 오더'])
    sheet.addRow(['확정 수량을 확인해 주세요.'])
    sheet.addRow(['품번', '색상', ...SIZES, '합계'])
    sheet.addRow(row())
    const bytes = await workbook.xlsx.writeBuffer()
    const file = new File([new Uint8Array(bytes)], 'order.xlsx')
    const parsed = await parseOrderWorkbook(file)
    expect(parsed.sheets).toHaveLength(1)
    expect(detectOrderHeaderRow(parsed.sheets[0])).toBe(3)
    expect(parsed.sheets[0].rows[3][0]).toBe(`${style.code}BK`)
    expect(autoMapOrderColumns(parsed.sheets[0].rows[2]).mapping.sizes.XL).toBe(7)
  })

  it('병합형 제목·공백 및 영문 열 별칭을 인식한다', () => {
    const sheet: ImportSheet = { name: '수량', rows: [['SIG ORDERS'], ['STYLE CODE', 'COLOUR', 'ORDER XXS', 'ORDER XS', 'ORDER S', 'ORDER M', 'ORDER L', 'ORDER XL'], ['A', 'BK', 1, 2, 3, 4, 5, 6]] }
    expect(detectOrderHeaderRow(sheet)).toBe(2)
    const { mapping, layout } = autoMapOrderColumns(sheet.rows[1])
    expect(layout).toBe('wide')
    expect(mapping.sku).toBe(0); expect(mapping.color).toBe(1)
    expect(SIZES.map(size => mapping.sizes[size])).toEqual([2, 3, 4, 5, 6, 7])
  })

  it('구형 xls·빈 파일·10MB 초과 파일을 읽기 전에 거부한다', async () => {
    const fake = { name: 'orders.xls', size: 50, arrayBuffer: async () => { throw new Error('읽으면 안 됨') } }
    await expect(parseOrderWorkbook(fake)).rejects.toThrow('.xlsx')
    await expect(parseOrderWorkbook({ ...fake, name: 'orders.xlsx', size: 0 })).rejects.toThrow('10MB')
    await expect(parseOrderWorkbook({ ...fake, name: 'orders.xlsx', size: MAX_ORDER_IMPORT_FILE + 1 })).rejects.toThrow('10MB')
  })

  it('수식은 실행하지 않고 저장된 값 또는 명확한 오류로 읽는다', () => {
    expect(orderImportCell({ formula: 'SUM(A1:B1)', result: 7 })).toBe(7)
    expect(orderImportCell({ sharedFormula: 'C2', result: 9 })).toBe(9)
    expect(orderImportCell({ formula: 'HYPERLINK("https://example.test")' })).toEqual({ error: expect.stringContaining('저장된 결과') })
    expect(orderImportCell({ error: '#DIV/0!' })).toEqual({ error: expect.stringContaining('#DIV/0!') })
    expect(orderImportCell({ richText: [{ text: '스타일' }, { text: ' 코드' }] })).toBe('스타일 코드')
  })
})

describe('기존 스타일 및 컬러의 정확한 매칭', () => {
  it('컬러 포함 품번을 매칭하고 기존 수량·교체 후 수량과 원본 버전을 보관한다', () => {
    const { style, line, row, build } = fixture()
    const preview = build([row()])
    expect(messages(preview)).toBe('')
    expect(preview.rows[0].before).toEqual(line.order)
    expect(preview.rows[0].after).toEqual({ XXS: 1, XS: 2, S: 3, M: 4, L: 5, XL: 6 })
    expect(preview.changes).toEqual([{ styleId: style.id, expectedVersion: style.version, lines: [{ lineId: line.id, color: 'BK', quantities: preview.rows[0].imported }] }])
  })

  it('미리보기는 원본을 바꾸지 않고 분석 시점의 버전을 유지한다', () => {
    const { workspace, style, row, build } = fixture()
    const original = structuredClone(workspace)
    const expectedVersion = style.version
    const preview = build([row()], { mode: 'add' })
    expect(workspace).toEqual(original)
    style.version += 1
    style.production[0].order.S += 100
    expect(preview.changes[0].expectedVersion).toBe(expectedVersion)
    expect(preview.rows[0].before.S).toBe(original.styles[0].production[0].order.S)
  })

  it('기본 품번과 명시한 컬러를 조합하고 공백과 대소문자를 정규화한다', () => {
    const { style, line, row, build } = fixture()
    const preview = build([row([1, 2, 3, 4, 5, 6], ` ${style.code.toLowerCase()} `, ` ${line.color.toLowerCase()} `)])
    expect(messages(preview)).toBe('')
    expect(preview.rows[0].lineId).toBe(line.id)
  })

  it('기본 품번에 컬러가 없으면 임의로 컬러를 선택하지 않는다', () => {
    const { style, row, build } = fixture()
    const preview = build([row(undefined, style.code, '')])
    expect(messages(preview)).toContain('색상 열')
    expect(preview.changes).toHaveLength(0)
  })

  it('품번 끝 컬러와 별도 컬러 열이 충돌하면 전체 적용을 차단한다', () => {
    const { row, build } = fixture()
    const preview = build([row(undefined, undefined, 'OT')])
    expect(messages(preview)).toContain('컬러와 색상 열이 다릅니다')
    expect(preview.changes).toHaveLength(0)
  })

  it('미등록·일부만 일치·삭제된 스타일을 자동 생성하거나 가져오지 않는다', () => {
    const { style, workspace, row, build } = fixture()
    for (const sku of ['UNKNOWN-BK', style.code.slice(0, -1), `${style.code}ZZ`]) {
      expect(build([row(undefined, sku, '')]).changes).toHaveLength(0)
      expect(messages(build([row(undefined, sku, '')]))).toContain('일치하는 품번이 없습니다')
    }
    workspace.styles[0].deletedAt = new Date().toISOString()
    expect(build([row()]).changes).toHaveLength(0)
  })

  it('품번이 둘 이상과 매칭되면 모호한 후보를 임의로 고르지 않는다', () => {
    const { style, workspace, row, build } = fixture()
    workspace.styles.push({ ...structuredClone(style), id: crypto.randomUUID() })
    const preview = build([row()])
    expect(messages(preview)).toContain('여러 스타일')
    expect(preview.changes).toHaveLength(0)
  })
})

describe('오더 수량 교체·리오더 및 오류 처리', () => {
  it('추가 모드는 파일 값을 원본 오더에 더하고 RPC에는 증가분을 전달한다', () => {
    const { line, row, build } = fixture()
    const preview = build([row()], { mode: 'add' })
    expect(preview.rows[0].after.S).toBe(line.order.S + 3)
    expect(preview.changes[0].lines[0].quantities.S).toBe(3)
  })

  it('중복 컬러 행은 기본 거부하고 명시적 합산 옵션에서만 합친다', () => {
    const { row, build } = fixture()
    const rejected = build([row(), row()])
    expect(messages(rejected)).toContain('중복')
    expect(rejected.changes).toHaveLength(0)
    const accepted = build([row(), row()], { duplicateMode: 'sum' })
    expect(messages(accepted)).toBe('')
    expect(accepted.rows).toHaveLength(1)
    expect(accepted.rows[0].after).toEqual({ XXS: 2, XS: 4, S: 6, M: 8, L: 10, XL: 12 })
    expect(accepted.rows[0].warnings.length).toBeGreaterThan(0)
  })

  it('한 스타일의 여러 컬러는 하나의 버전 검사 단위로 묶는다', () => {
    const { style, row, build } = fixture()
    const preview = build([row(), row(undefined, `${style.code}OT`, 'OT')])
    expect(preview.changes).toHaveLength(1)
    expect(preview.changes[0].lines).toHaveLength(2)
    expect(preview.changedLines).toBe(2)
  })

  it('하나라도 오류가 있으면 정상 행을 포함해 적용할 changes를 비운다', () => {
    const { row, build } = fixture()
    const preview = build([row(), row(undefined, 'UNKNOWN', '')])
    expect(preview.rows.some(r => r.changed && !r.errors.length)).toBe(true)
    expect(preview.changes).toHaveLength(0)
  })

  it.each([-1, 1.2, Number.NaN, Number.POSITIVE_INFINITY, 10000001, '-2', '1.2', true])('잘못된 사이즈 수량 %s은 전체 적용을 차단한다', invalid => {
    const { row, build } = fixture()
    const values = row(); values[2] = invalid
    const preview = build([values])
    expect(messages(preview)).toContain('정수')
    expect(preview.changes).toHaveLength(0)
  })

  it('천 단위 구분 수량은 읽고 사이즈 합계와 총합계가 다르면 거부한다', () => {
    const { row, build } = fixture()
    const values = row(); values[2] = '1,200'; values[8] = 1220
    expect(messages(build([values]))).toBe('')
    values[8] = 1200
    expect(messages(build([values]))).toContain('파일 합계')
  })

  it('리오더 적용 후 사이즈별 상한이 넘으면 차단한다', () => {
    const { line, row, build } = fixture()
    line.order.S = 10000000
    const preview = build([row()], { mode: 'add' })
    expect(messages(preview)).toContain('적용 후 수량')
    expect(preview.changes).toHaveLength(0)
  })

  it('파일 값이 기존 오더와 같으면 변경 이력을 불필요하게 생성하지 않는다', () => {
    const { line, row, build } = fixture()
    const preview = build([row(SIZES.map(size => line.order[size]))])
    expect(preview.changedLines).toBe(0)
    expect(preview.changes).toHaveLength(0)
  })

  it('총수량만 있는 파일은 사이즈 수량을 임의로 분배하지 않는다', () => {
    const { workspace, style } = fixture()
    const sheet = { name: '합계', rows: [['품번', '색상', '총수량'], [style.code, 'BK', 300]] }
    const { mapping } = autoMapOrderColumns(sheet.rows[0])
    const preview = buildOrderImportPreview(workspace, sheet, { mapping, layout: 'wide', headerRow: 1, duplicateMode: 'reject', missingSizes: 'zero', mode: 'replace' })
    expect(messages(preview)).toContain('총수량만으로')
    expect(preview.changes).toHaveLength(0)
  })
})

describe('세로형 사이즈·수량 데이터와 누락 처리', () => {
  function longFixture() {
    const base = fixture()
    const headers = ['품번', '색상', '사이즈', '수량']
    const { mapping, layout } = autoMapOrderColumns(headers)
    const rows: ImportCell[][] = SIZES.map((size, i) => [base.style.code, 'BK', size, i + 1])
    const build = (data = rows, overrides: Partial<OrderImportOptions> = {}) => buildOrderImportPreview(base.workspace, { name: '세로', rows: [headers, ...data] }, { ...base.options, mapping, layout, ...overrides })
    return { ...base, rows, build }
  }
  it('여섯 사이즈의 별도 행은 중복으로 보지 않고 한 컬러로 묶는다', () => {
    const { build } = longFixture()
    const preview = build()
    expect(messages(preview)).toBe('')
    expect(preview.sourceRows).toBe(6)
    expect(preview.rows).toHaveLength(1)
    expect(quantityTotal(preview.rows[0].after)).toBe(21)
  })

  it('같은 사이즈 중복은 거부하며 합산은 명시적으로 선택해야 한다', () => {
    const { rows, build } = longFixture()
    expect(messages(build([...rows, rows[0]]))).toContain('사이즈가 중복')
    const preview = build([...rows, rows[0]], { duplicateMode: 'sum' })
    expect(messages(preview)).toBe('')
    expect(preview.rows[0].after.XXS).toBe(2)
  })

  it('누락 사이즈를 기본 거부하고 명시적 0 처리 시 경고와 변동 수량을 표시한다', () => {
    const { rows, build } = longFixture()
    expect(build(rows.slice(2)).changes).toHaveLength(0)
    const accepted = build(rows.slice(2), { missingSizes: 'zero' })
    expect(messages(accepted)).toBe('')
    expect(accepted.rows[0].after.XXS).toBe(0)
    expect(accepted.rows[0].warnings.join(' ')).toContain('기존 오더는 0')
  })

  it('지원하지 않는 사이즈와 계산 결과 없는 수식을 거부한다', () => {
    const { rows, build } = longFixture()
    const invalid = [...rows, [rows[0][0], 'BK', 'XXL', 4]] as ImportCell[][]
    expect(messages(build(invalid))).toContain('지원하지 않는 사이즈')
    const formula = structuredClone(rows)
    formula[0][3] = orderImportCell({ formula: '=1+1' })
    expect(messages(build(formula))).toContain('저장된 결과')
  })
})


describe('UTF-8 CSV와 인용부호·줄바꿈 보존', () => {
  it('BOM·쉼표·이스케이프 따옴표·셀 안 CRLF를 정확히 읽는다', () => {
    const rows = parseOrderCSV('\uFEFF품번,메모,수량\r\n"SKU-BK","포켓, 위치\r\n""수정"" 확인",12\r\n')
    expect(rows).toEqual([['품번', '메모', '수량'], ['SKU-BK', '포켓, 위치\r\n"수정" 확인', '12']])
  })

  it('마지막 빈 열·빈 인용 셀을 보존하고 마지막 줄바꿈은 추가 데이터 행으로 만들지 않는다', () => {
    expect(parseOrderCSV('a,b,')).toEqual([['a', 'b', '']])
    expect(parseOrderCSV('"",x\n')).toEqual([['', 'x']])
    expect(parseOrderCSV('a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseOrderCSV('')).toEqual([])
  })

  it.each(['"닫히지 않은 셀', 'a"잘못된 따옴표,b', '"닫은 셀"잘못된 문자,b'])('손상된 CSV %s는 잘못 나누지 않고 오류로 처리한다', csv => {
    expect(() => parseOrderCSV(csv)).toThrow('CSV')
  })

  it('CSV도 최대 행·열 제한을 적용한다', () => {
    expect(() => parseOrderCSV(Array(201).fill('x').join(','))).toThrow('200열')
    expect(() => parseOrderCSV(Array(10001).fill('x').join('\n'))).toThrow('10,000행')
  })

  it('실제 UTF-8 BOM CSV 파일을 읽고 일반 열 연결로 기존 오더를 미리보기 한다', async () => {
    const { workspace, style, row, options } = fixture()
    const cells = ['품번,색상,XXS,XS,S,M,L,XL,합계', row().join(',')]
    const file = new File(['\uFEFF' + cells.join('\r\n')], 'generic-orders.csv', { type: 'text/csv' })
    const parsed = await parseOrderWorkbook(file)
    expect(parsed.kind).toBe('csv')
    expect(parsed.encoding).toBe('utf-8')
    const defaults = orderImportDefaults(parsed)
    expect(defaults.preset).toBe('generic')
    const preview = buildOrderImportPreview(workspace, parsed.sheets[defaults.sheetIndex], { ...options, ...defaults })
    expect(messages(preview)).toBe('')
    expect(preview.changes[0].styleId).toBe(style.id)
  })

  it('지원하지 않는 UTF-16을 CP949로 잘못 읽지 않고 UTF-8 재저장을 안내한다', async () => {
    const file = new File([new Uint8Array([0xff, 0xfe, 0x82, 0xa0])], 'not-utf8.csv')
    await expect(parseOrderWorkbook(file)).rejects.toThrow('UTF-8')
  })

  it('UTF-8·CP949 모두에서 잘못된 바이트 또는 NUL 문자는 오류로 안내한다', async () => {
    for (const bytes of [new Uint8Array([0xff]), new Uint8Array([65, 0, 66])]) {
      await expect(parseOrderWorkbook(new File([bytes], 'invalid.csv'))).rejects.toThrow(/UTF-8|제어 문자/)
    }
  })
})

describe('다단 머리글·CP949 한국어 Excel CSV (별도 합성 자료)', () => {
  async function actualGeometry() {
    const bytes = await readFile(new URL('./fixtures/sig-order-geometry-cp949.csv', import.meta.url))
    const file = new File([bytes], '합성-발주요청서.csv', { type: 'text/csv' })
    const parsed = await parseOrderWorkbook(file)
    return { parsed, defaults: orderImportDefaults(parsed) }
  }

  it('일반 한국어 Excel CSV를 CP949로 읽고 상단 사이즈 요약 대신 7행 실제 제목을 선택한다', async () => {
    const { parsed, defaults } = await actualGeometry()
    expect(parsed.encoding).toBe('cp949')
    expect(parsed.sheets[0].rows).toHaveLength(33)
    expect(parsed.sheets[0].rows[6]).toHaveLength(153)
    expect(parsed.sheets[0].rows[6][5]).toBe('스타일코드')
    expect(defaults.preset).toBe('sig-order-qty')
    expect(defaults.headerRow).toBe(7)
    expect(defaults.mapping).toEqual(sigOrderColumnMapping())
    expect(detectSigOrderHeaderRow(parsed.sheets[0])).toBe(7)
  })

  it('8행 한 컬러의 수량·16열 원본만 보존하고 빈 행·선택 외 열의 Excel 오류는 가져오지 않는다', async () => {
    const { parsed, defaults } = await actualGeometry()
    const { workspace, options, style, line } = fixture()
    style.code = 'TESTSTYLE01'; line.color = 'BK'
    const preview = buildOrderImportPreview(workspace, parsed.sheets[0], { ...options, ...defaults, fileName: parsed.name })
    expect(messages(preview)).toBe('')
    expect(preview.sourceRows).toBe(1)
    expect(preview.rows).toHaveLength(1)
    expect(preview.rows[0].rowNumbers).toEqual([8])
    expect(preview.rows[0].after).toEqual({ XXS: 10, XS: 20, S: 30, M: 40, L: 50, XL: 60 })
    const source = preview.changes[0].lines[0].source!
    expect(Object.keys(source.headers)).toEqual([...SIG_ORDER_SOURCE_COLUMNS])
    expect(source.headers).toMatchObject({ A: '프로젝트 코드', F: '스타일코드', L: '년도/시즌', M: '프로젝트 명칭', S: '발주 요청일', V: '생산구분', W: '생산처', X: '제조국', Y: '생산 담당자', AQ: 'TTL 1', AV: 'TTL 6', AY: 'TOTAL QTY' })
    expect(source.rows).toHaveLength(1)
    expect(source.rows[0].columns).toMatchObject({ A: 'TEST-PROJECT-2026', F: 'TESTSTYLE01BK', M: '검증 프로젝트', W: '검증 업체', Y: '검증 담당자', AQ: '10', AV: '60', AY: ' 210 ' })
    expect(JSON.stringify(source)).not.toContain('#REF!')
    expect(JSON.stringify(source)).not.toContain('#NAME?')
  })

  it.each([' #ref! ', '#NAME?', '#VALUE!', '#DIV/0!', '#N/A', '#NUM!', '#NULL!', '#SPILL!', '#CALC!', '#GETTING_DATA'])('선택한 참조 열의 CSV Excel 오류 %s은 정상 행을 포함해 전체 적용을 차단한다', async error => {
    const { parsed, defaults } = await actualGeometry()
    const { workspace, options, style, line } = fixture()
    style.code = 'TESTSTYLE01'; line.color = 'BK'
    // Keep one valid row first, then an invalid duplicate; no valid subset is applied.
    parsed.sheets[0].rows[8] = [...parsed.sheets[0].rows[7]]
    parsed.sheets[0].rows[8][12] = error
    const preview = buildOrderImportPreview(workspace, parsed.sheets[0], { ...options, ...defaults, fileName: parsed.name, duplicateMode: 'sum' })
    expect(preview.changes).toHaveLength(0)
    expect(messages(preview)).toContain('9행 원본 M열: Excel 셀 오류')
  })

  it('선택한 A열 값이나 제목의 CSV 오류도 차단하되 제목 앞 A2·선택 외 E열 오류는 무시한다', async () => {
    const { parsed, defaults } = await actualGeometry()
    const { workspace, options, style, line } = fixture()
    style.code = 'TESTSTYLE01'; line.color = 'BK'
    const sheet = parsed.sheets[0]
    sheet.rows[1][0] = '#NAME?'; sheet.rows[7][4] = '#REF!'
    const build = () => buildOrderImportPreview(workspace, sheet, { ...options, ...defaults, fileName: parsed.name })
    expect(messages(build())).toBe('')
    sheet.rows[7][0] = '#REF!'
    expect(build().changes).toHaveLength(0)
    expect(messages(build())).toContain('8행 원본 A열: Excel 셀 오류 #REF!')
    sheet.rows[7][0] = 'TEST-PROJECT-2026'; sheet.rows[6][12] = ' #name? '
    expect(build().changes).toHaveLength(0)
    expect(messages(build())).toContain('원본 M열 제목: Excel 셀 오류 #NAME?')
  })

  it('해시가 있는 일반 참조값이나 오류 토큰을 포함한 설명을 Excel 오류로 오인하지 않는다', async () => {
    const { parsed, defaults } = await actualGeometry()
    const { workspace, options, style, line } = fixture()
    style.code = 'TESTSTYLE01'; line.color = 'BK'
    parsed.sheets[0].rows[7][0] = '#some'
    parsed.sheets[0].rows[7][12] = '메모: #REF! 수정 확인'
    parsed.sheets[0].rows[6][12] = '프로젝트 #1'
    const preview = buildOrderImportPreview(workspace, parsed.sheets[0], { ...options, ...defaults, fileName: parsed.name })
    expect(messages(preview)).toBe('')
    expect(preview.changes[0].lines[0].source?.rows[0].columns).toMatchObject({ A: '#some', M: '메모: #REF! 수정 확인' })
  })

  it('다단 제목 아래 미등록 품번이면 임의 등록·수량 적용을 하지 않는다', async () => {
    const { parsed, defaults } = await actualGeometry()
    const { workspace, options } = fixture()
    const preview = buildOrderImportPreview(workspace, parsed.sheets[0], { ...options, ...defaults, fileName: parsed.name })
    expect(preview.changes).toHaveLength(0)
    expect(messages(preview)).toContain('정확히 일치하는 스타일이 없습니다')
  })

  it('고정 위치의 품번·합계·TTL 여섯 열이 불완전하면 해당 구조만으로 SIG 형식을 제안하지 않는다', () => {
    const row: ImportCell[] = Array(51).fill('')
    row[5] = '스타일코드'; row[50] = 'TOTAL QTY'
    for (let i = 0; i < 5; i++) row[42 + i] = `TTL ${i + 1}`
    const defaults = orderImportDefaults({ name: '검증.csv', sheets: [{ name: '검증', rows: [row, []] }] })
    expect(defaults.preset).toBe('generic')
  })
})

describe('SIG ORDER QTY 고정 열 형식 (사용자 지정 위치의 합성 검증 자료)', () => {
  function sigFixture() {
    const base = fixture()
    const headers: ImportCell[] = Array(51).fill(null)
    headers[0] = '원본 A 제목'; headers[5] = '품번'; headers[11] = '원본 L 제목'; headers[50] = '합계'
    SIZES.forEach((size, i) => { headers[42 + i] = size })
    const row: ImportCell[] = Array(51).fill(null)
    SIG_ORDER_SOURCE_COLUMNS.forEach((column, i) => {
      const index = [...column].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1
      row[index] = `원본 참조 ${i}`
    })
    row[5] = `${base.style.code}BK`
    SIZES.forEach((_, i) => { row[42 + i] = i + 1 })
    row[50] = 21
    const sheet: ImportSheet = { name: 'ORDER QTY', rows: [['SIG 파일 안내'], headers, row] }
    const defaults = orderImportDefaults({ name: 'synthetic-order.xlsx', kind: 'xlsx', sheets: [sheet] })
    const options: OrderImportOptions = { ...base.options, ...defaults, fileName: 'synthetic-order.xlsx' }
    return { ...base, headers, source: row, sheet, defaults, sigOptions: options, buildSig: () => buildOrderImportPreview(base.workspace, sheet, options) }
  }

  it('다른 요약 시트보다 정확한 ORDER QTY 탭을 선택하고 F/AQ~AV/AY를 연결한다', () => {
    const { sheet } = sigFixture()
    const book = { name: 'synthetic.xlsx', sheets: [{ name: 'SUMMARY', rows: [['요약'], ['자료']] }, sheet] }
    const defaults = orderImportDefaults(book)
    expect(defaults.sheetIndex).toBe(1)
    expect(defaults.preset).toBe('sig-order-qty')
    expect(defaults.headerRow).toBe(2)
    expect(defaults.mapping).toEqual({ sku: 5, color: null, size: null, quantity: null, total: 50, sizes: { XXS: 42, XS: 43, S: 44, M: 45, L: 46, XL: 47 } })
  })

  it('고정 위치의 여섯 사이즈 제목을 가진 CSV에는 같은 형식을 제안한다', () => {
    const { sheet } = sigFixture()
    const defaults = orderImportDefaults({ name: 'exported.csv', kind: 'csv', sheets: [{ ...sheet, name: 'exported' }] })
    expect(defaults.preset).toBe('sig-order-qty')
    expect(detectSigOrderHeaderRow(sheet)).toBe(2)
    expect(defaults.layout).toBe('wide')
  })

  it('F열 전체 품번의 끝 두 자리를 컬러로 분리해 정확한 기존 스타일에 연결한다', () => {
    const { style, line, buildSig } = sigFixture()
    const preview = buildSig()
    expect(messages(preview)).toBe('')
    expect(preview.rows[0].styleId).toBe(style.id)
    expect(preview.rows[0].lineId).toBe(line.id)
    expect(preview.rows[0].color).toBe('BK')
    expect(preview.rows[0].after).toEqual({ XXS: 1, XS: 2, S: 3, M: 4, L: 5, XL: 6 })
  })

  it('이름이 확인되지 않은 16개 참조 열을 원본 값 그대로 source payload에 포함한다', () => {
    const { source, buildSig } = sigFixture()
    source[11] = '원본, 참조\n"줄바꿈"'
    const preview = buildSig()
    const metadata = preview.rows[0].sourceMetadata![0]
    expect(metadata.rowNumber).toBe(3)
    expect(Object.keys(metadata.columns)).toEqual([...SIG_ORDER_SOURCE_COLUMNS])
    expect(metadata.columns.L).toBe('원본, 참조\n"줄바꿈"')
    expect(metadata.columns.F).toBe(source[5])
    expect(metadata.columns.AQ).toBe(1)
    expect(metadata.columns.AY).toBe(21)
    expect(Object.keys(preview.changes[0]).sort()).toEqual(['expectedVersion', 'lines', 'styleId'])
    expect(Object.keys(preview.changes[0].lines[0]).sort()).toEqual(['color', 'lineId', 'quantities', 'source'])
  })

  it('파일·시트·실제 제목과 16개 열의 원본 행을 원자 적용 source payload에 포함한다', () => {
    const { headers, source, buildSig } = sigFixture()
    headers[12] = '사용자가 원본에 적은 제목'
    source[12] = '그대로 보관할 참조값'
    const preview = buildSig(), payload = preview.changes[0].lines[0].source!
    expect(payload.fileName).toBe('synthetic-order.xlsx')
    expect(payload.sheetName).toBe('ORDER QTY')
    expect(payload.expectedVersion).toBe(0)
    expect(payload.headers.M).toBe('사용자가 원본에 적은 제목')
    expect(payload.headers.S).toBe('')
    expect(Object.keys(payload.headers)).toEqual([...SIG_ORDER_SOURCE_COLUMNS])
    expect(payload.rows[0].columns.M).toBe('그대로 보관할 참조값')
    expect(payload.rows[0].rowNumber).toBe(3)
    expect(preview.sourceChangedLines).toBe(1)
  })

  it('오더 수량이 같아도 원본 정보가 새로 추가되거나 바뀌면 적용 대상으로 남긴다', () => {
    const fixed = sigFixture()
    SIZES.forEach((size, index) => { fixed.source[42 + index] = fixed.line.order[size] })
    fixed.source[50] = quantityTotal(fixed.line.order)
    const first = fixed.buildSig()
    expect(first.changedLines).toBe(0)
    expect(first.sourceChangedLines).toBe(1)
    expect(first.changes).toHaveLength(1)
    const { expectedVersion: _expected, ...data } = first.changes[0].lines[0].source!
    fixed.workspace.operations = structuredClone(EMPTY_OPERATIONS)
    fixed.workspace.operations.orderSourceRecords.push({ ...data, styleId: fixed.style.id, lineId: fixed.line.id, version: 7, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', updatedBy: fixed.style.ownerId })
    fixed.source[11] = '오더 수량은 그대로, L열 참조만 변경'
    const changed = fixed.buildSig()
    expect(changed.changedLines).toBe(0)
    expect(changed.sourceChangedLines).toBe(1)
    expect(changed.changes[0].lines[0].source?.expectedVersion).toBe(7)
  })

  it('수량과 원본 내용이 모두 같으면 JSON 키 순서가 달라도 변경으로 오인하지 않는다', () => {
    const fixed = sigFixture()
    SIZES.forEach((size, index) => { fixed.source[42 + index] = fixed.line.order[size] })
    fixed.source[50] = quantityTotal(fixed.line.order)
    const first = fixed.buildSig(), payload = first.changes[0].lines[0].source!
    const { expectedVersion: _expected, ...data } = payload
    const reverseObject = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).reverse()) as T
    fixed.workspace.operations = structuredClone(EMPTY_OPERATIONS)
    fixed.workspace.operations.orderSourceRecords.push({ ...data, headers: reverseObject(data.headers), rows: data.rows.map(row => ({ ...row, columns: reverseObject(row.columns) })), styleId: fixed.style.id, lineId: fixed.line.id, version: 3, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', updatedBy: fixed.style.ownerId })
    const unchanged = fixed.buildSig()
    expect(unchanged.changedLines).toBe(0)
    expect(unchanged.sourceChangedLines).toBe(0)
    expect(unchanged.changes).toHaveLength(0)
  })

  it('미리보기 후 원본 정보 버전이 달라져도 기존 CAS 번호를 보존한다', () => {
    const fixed = sigFixture(), preview = fixed.buildSig()
    expect(preview.changes[0].lines[0].source?.expectedVersion).toBe(0)
    const { expectedVersion: _expected, ...data } = preview.changes[0].lines[0].source!
    fixed.workspace.operations = structuredClone(EMPTY_OPERATIONS)
    fixed.workspace.operations.orderSourceRecords.push({ ...data, styleId: fixed.style.id, lineId: fixed.line.id, version: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', updatedBy: fixed.style.ownerId })
    expect(preview.changes[0].lines[0].source?.expectedVersion).toBe(0)
  })

  it('수량 이외의 원본 셀과 제목 셀에 계산 오류가 있어도 전체 적용을 차단한다', () => {
    const fixed = sigFixture()
    fixed.source[11] = orderImportCell({ formula: 'SOME_FORMULA()' })
    expect(messages(fixed.buildSig())).toContain('원본 L열')
    expect(fixed.buildSig().changes).toHaveLength(0)
    fixed.source[11] = '원본 참조'
    fixed.headers[12] = { error: '제목 수식 오류' }
    expect(messages(fixed.buildSig())).toContain('원본 M열 제목')
    expect(fixed.buildSig().changes).toHaveLength(0)
  })

  it('중복 합산 시 각 원본 행을 보존하되 100개를 넘으면 조용히 자르지 않고 거부한다', () => {
    const fixed = sigFixture()
    fixed.sheet.rows.push(structuredClone(fixed.source))
    const accepted = buildOrderImportPreview(fixed.workspace, fixed.sheet, { ...fixed.sigOptions, duplicateMode: 'sum' })
    expect(messages(accepted)).toBe('')
    expect(accepted.changes[0].lines[0].source?.rows.map(row => row.rowNumber)).toEqual([3, 4])
    fixed.sheet.rows = [fixed.sheet.rows[0], fixed.headers, ...Array.from({ length: 101 }, () => structuredClone(fixed.source))]
    const rejected = buildOrderImportPreview(fixed.workspace, fixed.sheet, { ...fixed.sigOptions, duplicateMode: 'sum' })
    expect(messages(rejected)).toContain('최대 100개')
    expect(rejected.changes).toHaveLength(0)
  })

  it('원본 문자열·숫자·전체 데이터 용량 한도를 적용 전에 검증한다', () => {
    const fixed = sigFixture()
    fixed.source[11] = 'x'.repeat(4001)
    expect(messages(fixed.buildSig())).toContain('4,000자')
    fixed.source[11] = Number.NaN
    expect(messages(fixed.buildSig())).toContain('원본 L열의 숫자')
    fixed.source[11] = 1e16
    expect(fixed.buildSig().changes).toHaveLength(0)
    fixed.source[11] = '가'.repeat(4000)
    fixed.source[12] = '나'.repeat(4000)
    fixed.sheet.rows = [fixed.sheet.rows[0], fixed.headers, ...Array.from({ length: 50 }, () => structuredClone(fixed.source))]
    const overLimit = buildOrderImportPreview(fixed.workspace, fixed.sheet, { ...fixed.sigOptions, duplicateMode: 'sum' })
    expect(messages(overLimit)).toContain('1MB')
    expect(overLimit.changes).toHaveLength(0)
  })

  it('여러 컬러의 F 기본 품번은 선택을 요청하고 잘못된 컬러를 자동 생성하지 않는다', () => {
    const { source, style, buildSig } = sigFixture()
    source[5] = style.code
    expect(messages(buildSig())).toContain('컬러를 영문 두 자리로 지정')
    source[5] = `${style.code}ZZ`
    expect(messages(buildSig())).toContain('정확히 일치하는 스타일이 없습니다')
    expect(buildSig().changes).toHaveLength(0)
  })

  it('미등록 기본 품번에도 실제 파일 수량을 표시하며 컬러 미지정 상태의 저장은 막는다', () => {
    const { source, buildSig } = sigFixture()
    source[5] = 'QAFYDW9901'; source[8] = '#REF!'
    const values = [60, 384, 626, '1,296', '1,162', 610]
    values.forEach((value, index) => { source[42 + index] = value }); source[50] = '4,138'
    const preview = buildSig()
    expect(preview.rows[0].imported).toEqual({ XXS: 60, XS: 384, S: 626, M: 1296, L: 1162, XL: 610 })
    expect(preview.rows[0].sourceMetadata![0].columns.F).toBe('QAFYDW9901')
    expect(messages(preview)).toContain('컬러를 영문 두 자리로 지정')
    expect(preview.changes).toEqual([])
  })

  it('기본 품번의 명시한 컬러만 연결하고 원본 F와 기존 다른 컬러는 유지한다', () => {
    const fixed = sigFixture(), before = structuredClone(fixed.workspace)
    fixed.source[5] = fixed.style.code; fixed.source[8] = { error: '읽지 않는 I열' }
    const preview = buildOrderImportPreview(fixed.workspace, fixed.sheet, { ...fixed.sigOptions, sigColors: { 3: 'bk' } })
    expect(messages(preview)).toBe('')
    expect(preview.changes[0].lines).toHaveLength(1)
    expect(preview.changes[0].lines[0]).toMatchObject({ lineId: fixed.line.id, color: 'BK', quantities: { XXS: 1, XS: 2, S: 3, M: 4, L: 5, XL: 6 } })
    expect(preview.changes[0].lines[0].source!.rows[0].columns.F).toBe(fixed.style.code)
    expect(fixed.workspace).toEqual(before)
  })

  it('같은 기본 품번의 서로 다른 행에서 지정한 컬러를 각각 매칭한다', () => {
    const fixed = sigFixture(); fixed.source[5] = fixed.style.code
    fixed.sheet.rows.push(structuredClone(fixed.source))
    const preview = buildOrderImportPreview(fixed.workspace, fixed.sheet, { ...fixed.sigOptions, sigColors: { 3: 'BK', 4: 'OT' } })
    expect(messages(preview)).toBe('')
    expect(preview.changes[0].lines.map(line => line.color)).toEqual(['BK', 'OT'])
    expect(preview.changes[0].lines.every(line => quantityTotal(line.quantities) === 21)).toBe(true)
  })

  it('기본 품번의 잘못된 수량·합계는 컬러를 지정해도 가져오지 않는다', () => {
    const fixed = sigFixture(); fixed.source[5] = fixed.style.code
    fixed.source[42] = -1
    const options = { ...fixed.sigOptions, sigColors: { 3: 'BK' } }
    expect(messages(buildOrderImportPreview(fixed.workspace, fixed.sheet, options))).toContain('정수')
    fixed.source[42] = 1; fixed.source[50] = 999
    expect(messages(buildOrderImportPreview(fixed.workspace, fixed.sheet, options))).toContain('파일 합계')
    expect(buildOrderImportPreview(fixed.workspace, fixed.sheet, options).changes).toEqual([])
  })

  it('AY 합계가 AQ~AV와 다르면 전체 적용을 차단한다', () => {
    const { source, buildSig } = sigFixture()
    source[50] = 999
    const preview = buildSig()
    expect(messages(preview)).toContain('파일 합계')
    expect(preview.changes).toHaveLength(0)
  })

  it('고정 위치는 다른 열 연결 설정으로 실수해도 바뀌지 않으며 세로 형식은 거부한다', () => {
    const { options } = fixture()
    const fixed = sigFixture()
    expect(sigOrderColumnMapping().sizes.XXS).toBe(42)
    const preview = buildOrderImportPreview(fixed.workspace, fixed.sheet, { ...options, preset: 'sig-order-qty', headerRow: 2, mapping: { ...options.mapping, sku: 0 } })
    expect(messages(preview)).toBe('')
    const invalid = buildOrderImportPreview(fixed.workspace, fixed.sheet, { ...options, preset: 'sig-order-qty', headerRow: 2, layout: 'long' })
    expect(messages(invalid)).toContain('가로 형식')
  })
})
