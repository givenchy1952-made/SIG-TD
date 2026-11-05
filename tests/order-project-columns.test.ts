import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { buildOrderImportPreview, orderImportDefaults, parseOrderWorkbook } from '../src/lib/order-import'
import { planRegistrationFromRow } from '../src/lib/order-registration'

// Privacy-safe 3×153 CP949 geometry matching the supplied file. Identities and
// quantities are synthetic; the user's uploaded CSV is never committed.
async function fixture() {
  const bytes = new Uint8Array(await readFile(new URL('./fixtures/sig-project-columns-cp949.csv', import.meta.url)))
  const book = await parseOrderWorkbook(new File([bytes], 'qa-project-columns.csv'))
  const defaults = orderImportDefaults(book), sheet = book.sheets[defaults.sheetIndex]
  const workspace = createSeed(), registration = { factoryId: DEMO_IDS.china, ownerId: '', dueDate: '', allowMissingDueDate: true }
  return { book, defaults, sheet, workspace, registration }
}

describe('A열 예산 관리 코드 · M열 생산 프로젝트 명칭 · L열 시즌', () => {
  it('CP949 153열 첫 행 머리글을 읽고 신규 스타일의 세 필드를 섞지 않는다', async () => {
    const { book, defaults, sheet, workspace, registration } = await fixture(), before = structuredClone(workspace)
    expect(book.encoding).toBe('cp949'); expect(defaults.headerRow).toBe(1); expect(defaults.preset).toBe('sig-order-qty')
    expect(sheet.rows[0]).toHaveLength(153)
    const plan = planRegistrationFromRow(workspace, sheet, defaults.headerRow, 2, registration)
    expect(plan.errors).toEqual([])
    expect(plan.project).toMatchObject({ code: 'QA-BUDGET-2026-0001', name: '검증용 2026 3차', season: '2026FY' })
    expect(plan.project!.name).not.toBe(plan.project!.code)
    expect(plan.project!.name).not.toBe(plan.project!.season)
    expect(plan.style).toMatchObject({ projectId: plan.project!.id, season: '2026FY', code: 'QAFYTS9300' })
    expect(workspace).toEqual(before)
    workspace.projects.push(plan.project!); workspace.styles.push({ ...plan.style!, version: 1 })
    const preview = buildOrderImportPreview(workspace, sheet, { ...defaults, duplicateMode: 'reject', missingSizes: 'reject', mode: 'replace', fileName: book.name })
    expect(preview.errors).toEqual([]); expect(preview.rows).toHaveLength(1); expect(preview.rows[0].errors).toEqual([])
    expect(preview.rows[0].imported).toEqual({ XXS: 7, XS: 11, S: 13, M: 17, L: 19, XL: 23 })
    expect(preview.rows[0].source!.rows[0].columns).toMatchObject({ A: ' QA-BUDGET-2026-0001 ', M: '검증용 2026 3차', L: '2026FY' })
  })

  it('M열이 비면 A열 코드나 L열 시즌을 프로젝트 명칭으로 대신 등록하지 않는다', async () => {
    const { defaults, sheet, workspace, registration } = await fixture(), before = structuredClone(workspace)
    sheet.rows[1][12] = ''
    const plan = planRegistrationFromRow(workspace, sheet, defaults.headerRow, 2, registration)
    expect(plan.style).toBeNull(); expect(plan.project).toBeNull()
    expect(plan.errors.join(' ')).toContain('M열 프로젝트 명칭')
    expect(workspace).toEqual(before)
  })

  it('M열에 A열 코드를 복사한 파일은 잘못된 생산 명칭을 만들기 전에 차단한다', async () => {
    const { defaults, sheet, workspace, registration } = await fixture(), before = structuredClone(workspace)
    sheet.rows[1][12] = String(sheet.rows[1][0]).trim().toLowerCase()
    const plan = planRegistrationFromRow(workspace, sheet, defaults.headerRow, 2, registration)
    expect(plan.style).toBeNull(); expect(plan.project).toBeNull()
    expect(plan.errors.join(' ')).toContain('M열 프로젝트 명칭에 A열 예산 관리 코드')
    expect(workspace).toEqual(before)
  })
})
