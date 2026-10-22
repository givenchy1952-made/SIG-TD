import { describe, expect, it } from 'vitest'
import { buildExportSheets, safeCSVCell } from '../src/lib/export'
import { assertStyleSave, canViewStyle, validateStyle } from '../src/lib/permissions'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { scopeWorkspace } from '../src/lib/utils'
import { SIZES, blankProduction, blankSample, quantityTotal, type Profile, type Style } from '../src/lib/types'

function fixture() {
  const workspace = createSeed()
  const admin = workspace.profiles.find(p => p.id === DEMO_IDS.admin)!
  const internal = workspace.profiles.find(p => p.id === DEMO_IDS.internal)!
  const factory = workspace.profiles.find(p => p.id === DEMO_IDS.factory)!
  const before = structuredClone(workspace.styles[0])
  before.factoryId = factory.factoryId!
  before.samples.forEach(s => { s.factoryId = before.factoryId; s.status = 'progress' })
  return { workspace, admin, internal, factory, before }
}
function edit(before: Style, mutate: (after: Style) => void): Style { const after = structuredClone(before); mutate(after); return after }
function assertChange(profile: Profile, before: Style, mutate: (after: Style) => void) { return () => assertStyleSave(profile, before, edit(before, mutate), '업무 진행 수정') }


describe('체험 데이터와 사용자별 내보내기 범위', () => {
  it('예시 데이터는 서로 다른 공장·프로젝트 및 누적 PP 샘플을 포함한다', () => {
    const workspace = createSeed()
    expect(workspace.styles.length).toBeGreaterThan(10)
    expect(new Set(workspace.styles.map(s => s.factoryId)).size).toBe(3)
    expect(new Set(workspace.styles.map(s => s.projectId)).size).toBe(3)
    expect(workspace.styles.some(s => s.samples.some(sample => sample.isPP))).toBe(true)
    expect(workspace.styles.some(s => s.samples.length >= 3)).toBe(true)
    workspace.styles.forEach(style => {
      expect(() => validateStyle(style)).not.toThrow()
      expect(style.notes).toContain('예시 데이터')
      expect(style.production.map(p => p.color)).toEqual(style.colors)
    })
  })

  it('공장에는 본인 스타일과 연결된 코멘트·첨부·변경 이력만 제공한다', () => {
    const { workspace, factory } = fixture()
    const own = workspace.styles.find(s => s.factoryId === factory.factoryId)!
    const other = workspace.styles.find(s => s.factoryId !== factory.factoryId)!
    const marker = '타공장비공개자료-4477'
    workspace.comments = [own, other].map((style, i) => ({ id: `comment-${i}`, styleId: style.id, sampleId: null, authorId: factory.id, authorName: factory.name, body: i ? marker : '담당 스타일 코멘트', createdAt: new Date().toISOString() }))
    workspace.attachments = [own, other].map((style, i) => ({ id: `attachment-${i}`, styleId: style.id, sampleId: null, name: i ? `${marker}.pdf` : '작업지시서.pdf', path: `${style.id}/sample.pdf`, mime: 'application/pdf', size: 100, uploadedBy: factory.id, createdAt: new Date().toISOString() }))
    workspace.audits = [own, other].map((style, i) => ({ id: `audit-${i}`, styleId: style.id, actorId: factory.id, actorName: factory.name, action: '수정', reason: i ? marker : '업무 수정', before: { ...style, notes: i ? marker : '수정 이전' }, after: { ...style, notes: i ? marker : '수정 이후' }, createdAt: new Date().toISOString() }))
    workspace.audits.push({ ...workspace.audits[1], id: 'profile-audit', styleId: null, action: marker })
    const scoped = scopeWorkspace(workspace, factory)
    expect(scoped.styles.length).toBeGreaterThan(0)
    expect(scoped.styles.every(s => s.factoryId === factory.factoryId)).toBe(true)
    expect(scoped.comments).toHaveLength(1)
    expect(scoped.attachments).toHaveLength(1)
    expect(scoped.audits).toHaveLength(1)
    expect(scoped.profiles).toContainEqual(factory)
    const assignedOwnerIds = new Set(scoped.styles.flatMap(s => [s.ownerId, ...s.samples.map(sample => sample.ownerId)]))
    scoped.profiles.filter(p => p.id !== factory.id).forEach(p => { expect(assignedOwnerIds.has(p.id)).toBe(true); expect(p.email).toBe(''); expect(p.factoryId).toBeNull() })
    expect(scoped.factories.map(f => f.id)).toEqual([factory.factoryId])
    const sheets = buildExportSheets(scoped, scoped.styles)
    expect(JSON.stringify(sheets)).not.toContain(marker)
    expect(sheets.find(s => s.name === '변경 이력')?.rows).toHaveLength(1)
  })

  it.each([{ approved: false, active: true }, { approved: true, active: false }])('승인 전 또는 비활성 계정에는 업무 데이터가 없다: %j', flags => {
    const { workspace, factory } = fixture()
    const profile = { ...factory, ...flags }
    const scoped = scopeWorkspace(workspace, profile)
    const collections = ['styles', 'factories', 'projects', 'comments', 'attachments', 'audits'] as const
    collections.forEach(key => expect(scoped[key]).toHaveLength(0))
    expect(buildExportSheets(scoped, scoped.styles).every(s => s.rows.length === 0)).toBe(true)
    expect(canViewStyle(profile, workspace.styles[0])).toBe(false)
  })

  it('소프트 삭제 스타일은 모든 역할의 기본 조회 결과에서 제외된다', () => {
    const { workspace, admin, factory } = fixture()
    workspace.styles[0].deletedAt = new Date().toISOString()
    expect(scopeWorkspace(workspace, admin).styles).not.toContainEqual(workspace.styles[0])
    expect(canViewStyle(factory, workspace.styles[0])).toBe(false)
  })
})

describe('Excel 및 CSV 업무 데이터 내보내기', () => {
  it.each(['=HYPERLINK("https://example.test")', '+SUM(1,2)', '-1+2', '@SUM(A1)', '   =1+1', '\t+1', '\n@cmd', '\uFEFF=cmd'])('수식처럼 시작하는 텍스트를 안전한 리터럴로 만든다: %j', value => {
    const cell = safeCSVCell(value)
    expect(cell.startsWith('"\'')).toBe(true)
    expect(cell.endsWith('"')).toBe(true)
  })

  it('CSV 쉼표·따옴표·줄바꿈을 보존하고 실제 숫자는 변환하지 않는다', () => {
    expect(safeCSVCell('수정 "확인", 다음\n줄')).toBe('"수정 ""확인"", 다음\n줄"')
    expect(safeCSVCell(1200)).toBe('"1200"')
    expect(safeCSVCell(-2)).toBe('"-2"')
    expect(safeCSVCell(null)).toBe('""')
  })

  it('모든 누적 샘플 차수와 PP 이력을 포함하고 각 행의 열 수가 일치한다', () => {
    const { workspace } = fixture()
    const sheets = buildExportSheets(workspace, workspace.styles)
    const sample = sheets.find(s => s.name === '샘플 이력')!
    expect(sample.rows).toHaveLength(workspace.styles.reduce((sum, s) => sum + s.samples.length, 0))
    expect(sample.rows.some(row => row[sample.headers.indexOf('PP 샘플')] === 'PP')).toBe(true)
    sheets.forEach(sheet => sheet.rows.forEach(row => expect(row).toHaveLength(sheet.headers.length)))
  })

  it('모든 6사이즈의 오더·패킹·출고·입고 수량과 합계를 내보낸다', () => {
    const { workspace } = fixture()
    const sheet = buildExportSheets(workspace, workspace.styles).find(s => s.name === '메인 생산')!
    const line = workspace.styles[0].production[0]
    const row = sheet.rows[0]
    for (const [key, label] of [['order', '오더'], ['packing', '패킹리스트'], ['shipped', '실 출고'], ['received', '실 입고']] as const) {
      SIZES.forEach(size => expect(row[sheet.headers.indexOf(`${label} ${size}`)]).toBe(line[key][size]))
      expect(row[sheet.headers.indexOf(`${label} 합계`)]).toBe(quantityTotal(line[key]))
    }
  })

  it('선택된 스타일과 컬러만 내보내고 타 스타일 변경 이력을 포함하지 않는다', () => {
    const { workspace } = fixture()
    const style = workspace.styles[0]
    const narrowed = { ...style, production: [style.production[0]] }
    const sheets = buildExportSheets(workspace, [narrowed])
    const production = sheets.find(s => s.name === '메인 생산')!
    expect(production.rows).toHaveLength(1)
    expect(production.rows[0][production.headers.indexOf('컬러 품번')]).toBe(`${style.code}${style.production[0].color}`)
    expect(production.rows[0][production.headers.indexOf('컬러')]).toBe(style.production[0].color)
    expect(sheets.find(s => s.name === '스타일')?.rows).toHaveLength(1)
  })
})

describe('클라이언트 업무 권한 및 데이터 손상 방지', () => {
  it('공장은 샘플 제작·발송 진행과 담당 출고 수량을 입력할 수 있다', () => {
    const { factory, before } = fixture()
    expect(assertChange(factory, before, after => {
      after.samples[0].status = 'done'
      after.samples[0].plannedAt = '2026-11-01'
      after.samples[0].completedAt = '2026-11-02'
      after.samples[0].shippedAt = '2026-11-03'
      after.samples[0].tracking = 'SF-443399'
      after.samples[0].factoryComment = '수정 완료 후 발송'
      after.production[0].shipped.S = 15
      after.production[0].confirmDue = '2026-11-04'
      after.production[0].receivedAt = '2026-11-05'
      after.production[0].measurements = 'S 가슴 55 / 총장 67'
    })).not.toThrow()
  })

  it.each(['notes', 'dueDate', 'stage', 'ppApproved', 'factoryId'] as const)('공장은 본사 보호 항목 %s을 변경할 수 없다', key => {
    const { factory, before } = fixture()
    const values = { notes: '변조한 요청', dueDate: '2099-01-01', stage: 'approved', ppApproved: true, factoryId: DEMO_IDS.vietnam }
    expect(assertChange(factory, before, after => { Object.assign(after, { [key]: values[key] }) })).toThrow()
  })

  it('공장은 본사 컨펌·수정 요청·실 입고 수량·결제 금액을 수정할 수 없다', () => {
    const { factory, before } = fixture()
    const changes: ((after: Style) => void)[] = [after => { after.samples[0].status = 'approved' }, after => { after.samples[0].request = '삭제된 수정 요청' }, after => { after.production[0].checks.materials = 'approved' }, after => { after.production[0].received.M += 1 }, after => { after.production[0].invoiceAmount += 10000 }]
    changes.forEach(change => expect(assertChange(factory, before, change)).toThrow())
  })

  it('공장은 이미 승인된 샘플의 상태를 되돌릴 수 없다', () => {
    const { factory, before } = fixture()
    before.samples[0].status = 'approved'
    expect(assertChange(factory, before, after => { after.samples[0].status = 'progress' })).toThrow()
  })

  it('공장은 타 공장 스타일의 유효한 진행 입력도 저장할 수 없다', () => {
    const { workspace, factory } = fixture()
    const other = workspace.styles.find(s => s.factoryId !== factory.factoryId)!
    expect(assertChange(factory, other, after => { after.production[0].factoryComment = '접근 시도' })).toThrow('접근')
  })

  it('본사 직원은 컨펌·일정을 변경할 수 있지만 출고·입고 수량은 입력할 수 없다', () => {
    const { internal, before } = fixture()
    expect(assertChange(internal, before, after => { after.notes = '수정 요청 전달'; after.samples[0].status = 'approved'; after.dueDate = '2026-12-01'; after.production[0].checks.materials = 'done' })).not.toThrow()
    expect(assertChange(internal, before, after => { after.production[0].shipped.M += 1 })).toThrow('출고 수량')
    expect(assertChange(internal, before, after => { after.production[0].received.M += 1 })).toThrow('입고 수량')
  })

  it('관리자는 출고·입고 수량과 승인 여부를 모두 입력할 수 있다', () => {
    const { admin, before } = fixture()
    expect(assertChange(admin, before, after => { after.production[0].shipped.M += 1; after.production[0].received.M += 1; after.ppApproved = true; after.samples[0].status = 'approved' })).not.toThrow()
  })

  it('관리자도 기존 샘플 차수와 컬러 생산 이력을 삭제할 수 없다', () => {
    const { admin, before } = fixture()
    expect(assertChange(admin, before, after => { after.samples.shift() })).toThrow('샘플 이력')
    expect(assertChange(admin, before, after => { after.production.pop() })).toThrow('생산 이력')
  })

  it('본사는 3차 이후 샘플을 누적하고 공장은 차수를 추가할 수 없다', () => {
    const { internal, factory, before } = fixture()
    const add = (after: Style) => { after.samples.push(blankSample(4, after.factoryId, after.ownerId)) }
    expect(assertChange(internal, before, add)).not.toThrow()
    expect(assertChange(factory, before, add)).toThrow()
  })

  it('새 컬러 라인을 통한 본사 직원의 출고·입고 수량 우회를 차단한다', () => {
    const { internal, before } = fixture()
    const after = edit(before, s => { const line = blankProduction('NV'); line.received.S = 20; s.colors.push('NV'); s.production.push(line) })
    expect(() => assertStyleSave(internal, before, after, '컬러 추가')).toThrow('0으로 시작')
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10000001])('잘못된 수량 %s을 거부한다', invalid => {
    const { admin, before } = fixture()
    expect(assertChange(admin, before, after => { after.production[0].order.XL = invalid })).toThrow('수량')
  })

  it('사유 없는 변경과 승인 전 사용자의 저장을 거부한다', () => {
    const { admin, before } = fixture()
    expect(() => assertStyleSave(admin, before, before, ' ')).toThrow('변경 사유')
    expect(() => assertStyleSave(admin, before, before, '가')).toThrow('변경 사유')
    expect(() => assertStyleSave({ ...admin, approved: false }, before, before, '정상 사유')).toThrow('승인')
    expect(() => assertStyleSave({ ...admin, active: false }, before, before, '정상 사유')).toThrow('승인')
  })
})
