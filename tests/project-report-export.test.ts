import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { buildExportSheets, safeCSVCell } from '../src/lib/export'
import { scopeWorkspace } from '../src/lib/utils'

function fixture() {
  const workspace = createSeed()
  const [first, second] = workspace.projects
  first.name = second.name = '시그니피컨트 공식 명칭'
  first.code = 'SIGNIFICANT-2026FY-RPQ-46318'; second.code = 'SIGNIFICANT-2026FY-RPQ-46319'
  workspace.styles[0].projectId = first.id
  workspace.styles[1].projectId = second.id
  return { workspace, first, second }
}
describe('프로젝트 명칭 기반 공통 보고서 범위', () => {
  it('프로젝트 ID 단일·복수 OR 및 선택 없음 범위를 모든 시트에 적용한다', () => {
    const { workspace, first, second } = fixture(), before = structuredClone(workspace)
    for (const ids of [[first.id], [second.id], [first.id, second.id], []]) {
      const sheets = buildExportSheets(workspace, workspace.styles, { projectIds: ids })
      for (const sheet of sheets) {
        const projectColumn = sheet.headers.indexOf('프로젝트 ID')
        expect(projectColumn).toBeGreaterThanOrEqual(0)
        expect(sheet.rows.every(row => ids.includes(String(row[projectColumn])))).toBe(true)
      }
      const styles = sheets[0]
      expect(styles.rows).toHaveLength(workspace.styles.filter(style => ids.includes(style.projectId)).length)
    }
    expect(workspace).toEqual(before)
  })
  it('스타일·샘플·생산 보고서에 공식 명칭과 코드를 모두 출력하고 기존 수량 열 위치를 유지한다', () => {
    const { workspace } = fixture()
    const sheets = buildExportSheets(workspace, workspace.styles)
    for (const sheet of sheets) {
      expect(sheet.headers).toContain('프로젝트 명칭')
      expect(sheet.headers).toContain('프로젝트 코드')
      for (const row of sheet.rows) expect(row).toHaveLength(sheet.headers.length)
    }
    const styleSheet = sheets[0]
    expect(styleSheet.headers[12]).toBe('오더 수량')
    const row = styleSheet.rows[0]
    expect(row[styleSheet.headers.indexOf('프로젝트 명칭')]).toBe('시그니피컨트 공식 명칭')
    expect(row[styleSheet.headers.indexOf('프로젝트 코드')]).toBe(workspace.projects[0].code)
  })
  it('명칭 누락은 코드로 표시하고 선택한 컬러를 다시 확대하지 않는다', () => {
    const { workspace, first } = fixture()
    first.name = ''
    const style = workspace.styles[0], line = style.production[0]
    const sheets = buildExportSheets(workspace, [{ ...style, production: [line], colors: [line.color] }], { projectIds: [first.id] })
    expect(sheets[0].rows[0][sheets[0].headers.indexOf('프로젝트 명칭')]).toBe(first.code)
    expect(sheets[2].rows).toHaveLength(1)
    expect(sheets[2].rows[0][sheets[2].headers.indexOf('컬러')]).toBe(line.color)
  })
  it('공장 범위의 프로젝트·스타일을 그대로 사용하고 다른 공장 데이터는 내보내지 않는다', () => {
    const { workspace } = fixture()
    const factory = workspace.profiles.find(item => item.id === DEMO_IDS.factory)!
    const scoped = scopeWorkspace(workspace, factory)
    const sheets = buildExportSheets(scoped, scoped.styles)
    expect(sheets[0].rows).toHaveLength(scoped.styles.length)
    expect(scoped.styles.every(style => style.factoryId === factory.factoryId)).toBe(true)
    for (const hidden of workspace.styles.filter(style => style.factoryId !== factory.factoryId)) expect(JSON.stringify(sheets)).not.toContain(hidden.code)
  })
  it('CSV 수식 문자열 방어를 프로젝트 명칭과 코드에도 유지한다', () => {
    expect(safeCSVCell('=위험명칭')).toBe('"\'=위험명칭"')
    expect(safeCSVCell('+프로젝트')).toBe('"\'+프로젝트"')
  })
})
