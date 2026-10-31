import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { buildSigEuljiRows, fillSigEuljiTemplate, type SigEuljiRow } from '../src/lib/sig-eulji'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { emptyQuantities } from '../src/lib/types'

const source = async () => new Uint8Array(await readFile(new URL('../src/assets/sig-eulji-template.xlsx', import.meta.url)))
const row = (overrides: Partial<SigEuljiRow> = {}): SigEuljiRow => ({ projectId: 'project-a', projectName: '시그니피컨트 2026 11M-1', season: '2026FY', projectCode: 'SIGNIFICANT-2026FY-RPQ-46318', receivedAtISO: '2026-10-30', factory: '시험 업체', colorStyleCode: 'BP08FYJK1606DB', unitCost: 100.25, orderQuantity: 290, receivedQuantity: 277, unit: 'EA', netAmount: 27769.25, owner: '시험 담당자', ...overrides })
const withoutMetadata = ({ projectId: _id, projectName: _name, season: _season, ...financial }: SigEuljiRow) => financial
async function open(bytes: Uint8Array) { const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes); return workbook }

describe('프로젝트 명칭 안내 시트를 통한 SIG 고정 을지 보존', () => {
  it('프로젝트 명칭·코드·시즌·ID와 고정 을지 행 번호를 별도 시트에 표시한다', async () => {
    const rows = [row(), row({ projectId: 'project-b', projectCode: 'SIGNIFICANT-2026FY-RPQ-46319', colorStyleCode: 'BP08FYJK1606BK' })]
    const workbook = await open(await fillSigEuljiTemplate(await source(), rows))
    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['대금지급(을)', '프로젝트 안내'])
    const guide = workbook.getWorksheet('프로젝트 안내')!
    expect(guide.getRow(1).values).toEqual([, '을지 행', '프로젝트 명칭', '프로젝트 코드', '시즌', '스타일코드', '프로젝트 ID'])
    expect(guide.getRow(2).values).toEqual([, 3, rows[0].projectName, rows[0].projectCode, '2026FY', rows[0].colorStyleCode, 'project-a'])
    expect(guide.getRow(3).values).toEqual([, 4, rows[1].projectName, rows[1].projectCode, '2026FY', rows[1].colorStyleCode, 'project-b'])
    expect(guide.autoFilter).toBe('A1:F3')
  })

  it('명칭 메타데이터 유무와 관계없이 고정 을지 XML·표·수식·금액은 완전히 동일하다', async () => {
    const original = await source(), rows = [row(), row({ unitCost: 0, netAmount: 0, projectId: 'project-b' })]
    const plain = await JSZip.loadAsync(await fillSigEuljiTemplate(original, rows.map(withoutMetadata)))
    const named = await JSZip.loadAsync(await fillSigEuljiTemplate(original, rows))
    for (const path of ['xl/worksheets/sheet1.xml', 'xl/tables/table1.xml']) expect(await named.file(path)!.async('string'), path).toBe(await plain.file(path)!.async('string'))
    const allowed = new Set(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', '[Content_Types].xml'])
    for (const [path, part] of Object.entries(plain.files)) {
      if (part.dir || allowed.has(path)) continue
      expect(await named.file(path)!.async('uint8array'), path).toEqual(await part.async('uint8array'))
    }
    const sheet = (await open(await fillSigEuljiTemplate(original, rows))).getWorksheet('대금지급(을)')!
    expect(sheet.getCell('T3').value).toBe(27769.25)
    expect(sheet.getCell('U3').value).toMatchObject({ formula: '거래명세표[[#This Row],[금액]]*0.1', result: 2776.925 })
    expect(sheet.getCell('V3').value).toMatchObject({ formula: '거래명세표[[#This Row],[VAT]]+거래명세표[[#This Row],[금액]]', result: 30546.175 })
    expect(sheet.getCell('T1').value).toMatchObject({ formula: 'SUM(T3:T4)', result: 27769.25 })
    expect(original).toEqual(await source())
  })

  it('프로젝트 안내에는 선택한 다운로드 행만 포함하고 미선택 프로젝트를 만들지 않는다', async () => {
    const workbook = await open(await fillSigEuljiTemplate(await source(), [row({ projectId: 'selected', projectName: '선택 프로젝트' })]))
    const guide = workbook.getWorksheet('프로젝트 안내')!
    expect(guide.rowCount).toBe(2)
    expect(guide.getCell('B2').value).toBe('선택 프로젝트')
    expect(guide.getCell('F2').value).toBe('selected')
  })

  it('명칭이 비어 있으면 기존 프로젝트 코드를 쓰고 Excel 수식·XML 기호는 문자열로 보존한다', async () => {
    const malicious = '=HYPERLINK("https://example.test","공식 & <명칭>")'
    const workbook = await open(await fillSigEuljiTemplate(await source(), [row({ projectName: '' }), row({ projectName: malicious })]))
    const guide = workbook.getWorksheet('프로젝트 안내')!
    expect(guide.getCell('B2').value).toBe(row().projectCode)
    expect(guide.getCell('B3').value).toBe(malicious)
    expect(guide.getCell('B3').type).toBe(ExcelJS.ValueType.String)
  })

  it('이전 호출의 메타데이터 없는 행은 안내 시트를 강제로 추가하지 않는다', async () => {
    const workbook = await open(await fillSigEuljiTemplate(await source(), [withoutMetadata(row())]))
    expect(workbook.worksheets).toHaveLength(1)
  })

  it.each([{ projectName: '불가\u0000문자' }, { season: '시즌'.repeat(20) }, { projectId: 'x'.repeat(201) }])('잘못된 안내 메타데이터를 거부한다: %j', async override => {
    await expect(fillSigEuljiTemplate(await source(), [row(override)])).rejects.toThrow('프로젝트 안내')
  })

  it('실제 을지 빌더는 스타일명이 아닌 기존 공식 프로젝트 명칭을 사용하고 ID를 유지한다', () => {
    const workspace = createSeed(), style = workspace.styles[0], line = style.production[0], profile = workspace.profiles.find(item => item.id === DEMO_IDS.admin)!
    const project = workspace.projects.find(item => item.id === style.projectId)!
    project.code = 'SIGNIFICANT-2026FY-RPQ-46318'; project.name = '공식 프로젝트 명칭'; project.season = '2026FY'
    style.name = '프로젝트 명칭이 아닌 제품명'; style.production = [line]
    line.receivedAt = '2026-10-30'; line.received = { ...emptyQuantities(), M: 2 }
    workspace.settlementTermsAvailable = true
    workspace.settlementTerms = [{ styleId: style.id, lineId: line.id, projectCode: project.code, unitCost: 100, itemType: 'product', version: 1, createdAt: '', updatedAt: '', updatedBy: profile.id }]
    const before = structuredClone(workspace)
    const result = buildSigEuljiRows(workspace, [style], profile)
    expect(result.errors).toEqual([])
    expect(result.rows[0]).toMatchObject({ projectId: project.id, projectName: '공식 프로젝트 명칭', projectCode: project.code, season: '2026FY', netAmount: 200 })
    expect(workspace).toEqual(before)
    project.name = ''
    expect(buildSigEuljiRows(workspace, [style], profile).rows[0].projectName).toBe(project.code)
  })
})
