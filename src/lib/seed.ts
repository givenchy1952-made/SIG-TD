import { blankProduction, blankSample, type Workspace, type Style, type Stage, type Status } from './types'
import { addDays } from './utils'
export const DEMO_IDS = {
  admin: '10000000-0000-4000-8000-000000000001', internal: '10000000-0000-4000-8000-000000000002', factory: '10000000-0000-4000-8000-000000000004',
  korea: '20000000-0000-4000-8000-000000000001', china: '20000000-0000-4000-8000-000000000002', vietnam: '20000000-0000-4000-8000-000000000003',
}
export function createSeed(): Workspace {
  const factories = [{ id: DEMO_IDS.korea, name: '서울 성수 · 아틀리에', country: '대한민국' }, { id: DEMO_IDS.china, name: '칭다오 · A FACTORY', country: '중국' }, { id: DEMO_IDS.vietnam, name: '호치민 · V GARMENT', country: '베트남' }]
  const profiles = [
    { id: DEMO_IDS.admin, name: '남주현', email: 'admin@example.test', role: 'admin' as const, approved: true, active: true, factoryId: null },
    { id: DEMO_IDS.internal, name: '천민영', email: 'minyoung@example.test', role: 'internal' as const, approved: true, active: true, factoryId: null },
    { id: '10000000-0000-4000-8000-000000000003', name: '박인경', email: 'inkyoung@example.test', role: 'internal' as const, approved: true, active: true, factoryId: null },
    { id: DEMO_IDS.factory, name: '이준 · 칭다오', email: 'factory@example.test', role: 'factory' as const, approved: true, active: true, factoryId: DEMO_IDS.china },
    { id: '10000000-0000-4000-8000-000000000005', name: '신규 협력사', email: 'pending@example.test', role: 'factory' as const, approved: false, active: true, factoryId: null },
  ]
  const projects = [{ id: '30000000-0000-4000-8000-000000000001', name: 'SIGNIFICANT · 26 FALL / WINTER', season: '2026FW' }, { id: '30000000-0000-4000-8000-000000000002', name: 'SIG ESSENTIALS · 26 CORE', season: '2026FY' }, { id: '30000000-0000-4000-8000-000000000003', name: 'FIVE SPACE · 27 SPRING', season: '2027SS' }]
  const definitions: [string, string, string, Stage, number, string[]][] = [
    ['JK0101', 'STRUCTURED WOOL JACKET', 'OUTERWEAR', 'sampleN', 5, ['BK', 'OT']],
    ['HD0102', 'SIGNATURE ZIP-UP HOODIE', 'SWEATSHIRT', 'production', 12, ['BK', 'OW', 'NV']],
    ['PT0103', 'WIDE LEG DENIM PANTS', 'BOTTOMS', 'review', -2, ['ID', 'BK']],
    ['SH0104', 'RELAXED COTTON SHIRT', 'SHIRTS', 'sample1', 7, ['OW', 'BL']],
    ['CT0105', 'DOUBLE BREASTED COAT', 'OUTERWEAR', 'pattern', 18, ['CH', 'BK']],
    ['TS0106', 'ESSENTIAL LOGO T-SHIRT', 'JERSEY', 'approved', 2, ['OW', 'BK']],
    ['KN0107', 'MERINO WOOL CARDIGAN', 'KNITWEAR', 'sampleN', -1, ['OT', 'NV']],
    ['PT0108', 'CARGO PARACHUTE PANTS', 'BOTTOMS', 'production', 8, ['KH', 'BK']],
    ['VT0109', 'LIGHTWEIGHT PADDED VEST', 'OUTERWEAR', 'sample1', 6, ['BK']],
    ['SK0110', 'PLEATED MIDI SKIRT', 'BOTTOMS', 'revision', 14, ['CH', 'BK']],
    ['TS0111', 'HEAVYWEIGHT LONG SLEEVE', 'JERSEY', 'production', -4, ['OW', 'NV']],
    ['BG0112', 'UTILITY CROSSBODY BAG', 'ACCESSORIES', 'registered', 24, ['BK', 'KH']],
    ['JK0113', 'CROPPED DENIM JACKET', 'OUTERWEAR', 'sampleN', 3, ['ID']],
    ['KN0114', 'RIBBED KNIT POLO', 'KNITWEAR', 'pattern', 21, ['NV', 'OT']],
    ['PT0115', 'TAILORED STRAIGHT TROUSERS', 'BOTTOMS', 'approved', 10, ['BK', 'CH']],
    ['HD0116', 'BRUSHED COTTON SWEATSHIRT', 'SWEATSHIRT', 'production', 4, ['OT', 'BK']],
  ]
  const styles: Style[] = definitions.map(([code, name, category, stage, due, colors], i) => {
    const factoryId = factories[i % 3].id, ownerId = profiles[i % 3].id
    const advanced = ['production', 'approved'].includes(stage)
    const first = { ...blankSample(1, factoryId, ownerId), id: `50000000-0000-4000-8000-${String(i * 10 + 1).padStart(12, '0')}`, requestedAt: addDays(-20), plannedAt: addDays(-13), status: (advanced ? 'approved' : i % 2 ? 'progress' : 'done') as Status, request: i % 2 ? '봉제 사양과 전체 실루엣 확인 요청' : '암홀 1cm 조정, 포켓 위치와 워싱 컬러 재확인', receivedAt: i % 2 ? '' : addDays(-12), reviewedAt: i % 2 ? '' : addDays(-11), factoryComment: '예시 코멘트입니다. 패턴 수정 사항을 확인했습니다.' }
    const samples = stage === 'registered' || stage === 'pattern' ? [] : [first]
    if (stage === 'sampleN' || stage === 'revision' || advanced) samples.push({ ...blankSample(2, factoryId, ownerId), id: `50000000-0000-4000-8000-${String(i * 10 + 2).padStart(12, '0')}`, requestedAt: addDays(-8), plannedAt: addDays(due - 1), status: advanced ? 'approved' : 'progress' })
    if (advanced) samples.push({ ...blankSample(1, factoryId, ownerId, true), id: `50000000-0000-4000-8000-${String(i * 10 + 3).padStart(12, '0')}`, requestedAt: addDays(-6), plannedAt: addDays(-3), status: 'approved', receivedAt: addDays(-3), reviewedAt: addDays(-2) })
    const production = colors.map((color, j) => {
      const p = blankProduction(color); p.id = `60000000-0000-4000-8000-${String(i * 10 + j + 1).padStart(12, '0')}`
      p.order = { XXS: 20, XS: 40, S: 100 + i * 5, M: 120 + i * 5, L: 80, XL: 40 }
      Object.keys(p.checks).forEach((key, k) => { p.checks[key as keyof typeof p.checks] = (advanced ? k < 6 ? 'done' : 'progress' : k < i % 4 ? 'done' : k === i % 4 ? 'progress' : 'todo') })
      p.confirmDue = addDays(due - 3)
      if (stage === 'production') {
        p.packing = { ...p.order }; p.shipped = { XXS: 15, XS: 30, S: 80, M: 100, L: 60, XL: 30 }; p.shippedAt = addDays(-1)
        if (i % 2) { p.received = { XXS: 10, XS: 20, S: 60, M: 80, L: 40, XL: 20 }; p.receivedAt = addDays(0) }
        p.invoice = i % 2 ? 'done' : 'todo'; p.invoiceAmount = 8200000 + i * 200000; p.paymentDue = addDays(i % 2 ? 5 : -2); p.paymentStatus = i % 2 ? 'progress' : 'todo'
      }
      return p
    })
    return { id: `40000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, code: `BO42FY${code}`, name, category, season: projects[i < 8 ? 0 : i < 13 ? 1 : 2].season, projectId: projects[i < 8 ? 0 : i < 13 ? 1 : 2].id, factoryId, ownerId, colors, dueDate: addDays(due), stage, ppApproved: advanced, notes: '체험용 예시 데이터 · 실제 생산 및 결제 자료가 아닙니다.', samples, production, version: 1, updatedAt: new Date(Date.now() - i * 3600000).toISOString(), updatedBy: ownerId, deletedAt: null }
  })
  return { styles, profiles, factories, projects, comments: [{ id: crypto.randomUUID(), styleId: styles[0].id, sampleId: styles[0].samples[0].id, authorId: DEMO_IDS.internal, authorName: '천민영', body: '2차 샘플은 수정된 암홀 치수와 봉제 사양을 함께 확인해 주세요. (예시)', createdAt: new Date().toISOString() }], attachments: [], audits: [] }
}
