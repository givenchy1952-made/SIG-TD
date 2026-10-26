import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { buildExportSheets, safeCSVCell } from '../src/lib/export'

describe('컬러별 품번·담당자 일반 다운로드', () => {
  it('같은 기본 품번의 컬러마다 전체 품번과 자체 담당자를 내보내고 빈 담당자는 유지한다', () => {
    const workspace = createSeed(), style = workspace.styles[0]
    style.production = style.production.slice(0, 2)
    style.production[0].ownerId = DEMO_IDS.admin
    style.production[1].ownerId = ''
    const result = buildExportSheets(workspace, [style]).find(sheet => sheet.name === '메인 생산')!
    expect(result.rows).toHaveLength(2)
    expect(result.rows.map(row => row[result.headers.indexOf('컬러 품번')])).toEqual(style.production.map(line => `${style.code}${line.color}`))
    const ownerColumn = result.headers.indexOf('담당자')
    expect(result.rows.map(row => row[ownerColumn])).toEqual([workspace.profiles.find(profile => profile.id === DEMO_IDS.admin)!.name, ''])
    expect(safeCSVCell(result.rows[1][ownerColumn])).toBe('""')
  })

  it('컬러 담당자 값이 없는 과거 내역은 스타일 담당자를 유지하며 전체 품번 접미사는 중복하지 않는다', () => {
    const workspace = createSeed(), style = workspace.styles[0], line = style.production[0]
    style.code = 'BP06FYHD0402BL'; line.color = 'BL'; delete line.ownerId
    style.production = [line]
    const result = buildExportSheets(workspace, [style]).find(sheet => sheet.name === '메인 생산')!
    expect(result.rows[0][result.headers.indexOf('컬러 품번')]).toBe('BP06FYHD0402BL')
    expect(result.rows[0][result.headers.indexOf('담당자')]).toBe(workspace.profiles.find(profile => profile.id === style.ownerId)!.name)
  })
})
