import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import type { Workspace } from '../src/lib/types'
import { appendMaterialReviewRoundInWorkspace, decideMaterialReviewRoundInWorkspace, latestMaterialReviewRound, materialReviewItemChangedSinceRound, saveMaterialReviewItemInWorkspace, scopeMaterialReviewsWorkspace, type MaterialReviewRoundInput } from '../src/lib/material-reviews'

function fixture() {
  let workspace: Workspace = { ...createSeed(), materialReviewsAvailable: true, materialReviewItems: [], materialReviewRounds: [] }
  const style = workspace.styles[1], line = style.production[0], itemId = crypto.randomUUID()
  const admin = workspace.profiles.find(profile => profile.id === DEMO_IDS.admin)!
  const factory = workspace.profiles.find(profile => profile.role === 'factory' && profile.factoryId === style.factoryId)!
  workspace = saveMaterialReviewItemInWorkspace(workspace, admin, itemId, style.id, line.id, 0, { kind: 'fabric', name: '겉감 데님', specification: '13oz / DB' }, '겉감 품목 등록')
  const imageId = crypto.randomUUID(), otherImage = crypto.randomUUID()
  workspace.attachments.push({ id: imageId, styleId: style.id, sampleId: null, name: '확인.png', path: `${style.id}/check.png`, mime: 'image/png', size: 20, uploadedBy: admin.id, createdAt: new Date().toISOString() }, { id: otherImage, styleId: workspace.styles[0].id, sampleId: null, name: '다른 품번.png', path: 'other/check.png', mime: 'image/png', size: 20, uploadedBy: admin.id, createdAt: new Date().toISOString() })
  return { workspace, style, line, itemId, admin, factory, imageId, otherImage }
}
const submission = (overrides: Partial<MaterialReviewRoundInput> = {}): MaterialReviewRoundInput => ({ status: 'pending', comment: '겉감 1차 확인 요청', attachmentIds: [], ...overrides })

describe('품목별 원부자재 반복 확인 아카이브', () => {
  it('원단·부자재는 품목별 독립 이력이며 기존 스타일·생산·금융 기록을 변경하지 않는다', () => {
    const { workspace, admin, style, line, itemId } = fixture(), before = structuredClone(workspace)
    const next = saveMaterialReviewItemInWorkspace(workspace, admin, crypto.randomUUID(), style.id, line.id, 0, { kind: 'trim', name: '단추', specification: '18mm / 실버' }, '단추 품목 등록')
    expect(next.materialReviewItems).toHaveLength(2)
    expect(next.materialReviewItems!.find(item => item.id === itemId)).toEqual(before.materialReviewItems![0])
    expect(next.styles).toEqual(before.styles)
    expect(next.productionRuns).toEqual(before.productionRuns)
    expect(next.productionConditions).toEqual(before.productionConditions)
    expect(next.operations).toEqual(before.operations)
    expect(workspace).toEqual(before)
  })
  it('반려1→재제출2→승인2로 진행하고 제출 사진·코멘트와 본사 결정 사진·코멘트를 각각 보존한다', () => {
    const { workspace, factory, admin, itemId, imageId } = fixture(), firstId = crypto.randomUUID()
    const first = appendMaterialReviewRoundInWorkspace(workspace, factory, firstId, itemId, 1, submission({ attachmentIds: [imageId] }), '겉감 1차 제출')
    const submissionBefore = structuredClone(first.materialReviewRounds![0])
    const rejected = decideMaterialReviewRoundInWorkspace(first, admin, firstId, 1, { status: 'rejected', comment: '농도가 다르니 재확인', attachmentIds: [imageId] }, '겉감 반려 기록')
    expect(rejected.materialReviewRounds![0]).toMatchObject({ ...submissionBefore, status: 'rejected', version: 2, reviewerComment: '농도가 다르니 재확인', reviewAttachmentIds: [imageId], reviewedBy: admin.id, reviewedByName: admin.name, reviewedAt: expect.any(String) })
    const secondId = crypto.randomUUID()
    const second = appendMaterialReviewRoundInWorkspace(rejected, factory, secondId, itemId, 3, submission({ comment: '수정된 2차 겉감', attachmentIds: [imageId] }), '겉감 2차 제출')
    const approved = decideMaterialReviewRoundInWorkspace(second, admin, secondId, 1, { status: 'approved', comment: '색상 확인 완료', attachmentIds: [] }, '겉감 2차 승인')
    expect(approved.materialReviewRounds).toHaveLength(2)
    expect(approved.materialReviewRounds![0]).toEqual(rejected.materialReviewRounds![0])
    expect(latestMaterialReviewRound(approved, itemId)).toMatchObject({ round: 2, status: 'approved', version: 2, comment: '수정된 2차 겉감', reviewerComment: '색상 확인 완료' })
    expect(approved.materialReviewItems![0].version).toBe(5)
    expect(approved.styles).toEqual(workspace.styles)
  })
  it('품목을 나중에 수정해도 이전 제출 당시 명칭·사양·컬러 스냅샷은 그대로 남는다', () => {
    const { workspace, admin, itemId, style, line } = fixture()
    const next = appendMaterialReviewRoundInWorkspace(workspace, admin, crypto.randomUUID(), itemId, 1, submission(), '원단 확인 요청')
    const snapshot = structuredClone(next.materialReviewRounds![0].itemSnapshot)
    const changed = saveMaterialReviewItemInWorkspace(next, admin, itemId, style.id, line.id, 2, { kind: 'fabric', name: '수정된 겉감', specification: '14oz' }, '품목 사양 수정')
    expect(changed.materialReviewRounds![0].itemSnapshot).toEqual(snapshot)
    expect(snapshot).toMatchObject({ name: '겉감 데님', specification: '13oz / DB', color: line.color, styleCode: style.code })
  })
  it('확정 후 항목 구분·명칭·사양이 바뀌면 기존 승인이 현재 정보의 승인이 아님을 구분한다', () => {
    const { workspace, admin, itemId, style, line } = fixture()
    const approved = appendMaterialReviewRoundInWorkspace(workspace, admin, crypto.randomUUID(), itemId, 1, submission({ status: 'approved' }), '본사 원단 확정')
    const round = latestMaterialReviewRound(approved, itemId)!, item = approved.materialReviewItems![0]
    expect(materialReviewItemChangedSinceRound(item, undefined)).toBe(false)
    expect(materialReviewItemChangedSinceRound(item, round)).toBe(false)
    for (const changed of [{ kind: 'trim' as const }, { name: '새 겉감' }, { specification: '14oz' }]) {
      const next = saveMaterialReviewItemInWorkspace(approved, admin, itemId, style.id, line.id, item.version, { kind: item.kind, name: item.name, specification: item.specification, ...changed }, '확정 후 사양 변경')
      expect(materialReviewItemChangedSinceRound(next.materialReviewItems![0], latestMaterialReviewRound(next, itemId))).toBe(true)
      expect(next.materialReviewRounds).toEqual(approved.materialReviewRounds)
      expect(latestMaterialReviewRound(next, itemId)?.status).toBe('approved')
    }
  })
  it('공장은 품목 등록이나 승인·반려를 할 수 없고 승인 후 무단 재제출도 할 수 없다', () => {
    const { workspace, factory, admin, itemId, style, line } = fixture()
    expect(() => saveMaterialReviewItemInWorkspace(workspace, factory, crypto.randomUUID(), style.id, line.id, 0, { kind: 'trim', name: '단추', specification: '' }, '무단 품목 등록')).toThrow(/본사/)
    expect(() => appendMaterialReviewRoundInWorkspace(workspace, factory, crypto.randomUUID(), itemId, 1, submission({ status: 'approved' }), '무단 승인')).toThrow(/본사/)
    const pending = appendMaterialReviewRoundInWorkspace(workspace, factory, crypto.randomUUID(), itemId, 1, submission(), '겉감 제출')
    expect(() => decideMaterialReviewRoundInWorkspace(pending, factory, pending.materialReviewRounds![0].id, 1, { status: 'rejected', comment: '무단 결정', attachmentIds: [] }, '무단 결정')).toThrow(/본사/)
    const approved = decideMaterialReviewRoundInWorkspace(pending, admin, pending.materialReviewRounds![0].id, 1, { status: 'approved', comment: '본사 확인', attachmentIds: [] }, '본사 승인')
    expect(() => appendMaterialReviewRoundInWorkspace(approved, factory, crypto.randomUUID(), itemId, 3, submission(), '무단 재제출')).toThrow(/본사/)
    expect(appendMaterialReviewRoundInWorkspace(approved, admin, crypto.randomUUID(), itemId, 3, submission(), '본사 추가 검토 요청').materialReviewRounds).toHaveLength(2)
  })
  it('현재 대기 차수가 있으면 중복 재제출을 막고 오래된 품목·결정 버전은 거부한다', () => {
    const { workspace, admin, itemId } = fixture(), rid = crypto.randomUUID()
    const pending = appendMaterialReviewRoundInWorkspace(workspace, admin, rid, itemId, 1, submission(), '겉감 제출')
    expect(() => appendMaterialReviewRoundInWorkspace(pending, admin, crypto.randomUUID(), itemId, 1, submission(), '오래된 제출')).toThrow(/VERSION_CONFLICT/)
    expect(() => appendMaterialReviewRoundInWorkspace(pending, admin, crypto.randomUUID(), itemId, 2, submission(), '대기 중 제출')).toThrow(/대기 중/)
    expect(() => decideMaterialReviewRoundInWorkspace(pending, admin, rid, 0, { status: 'approved', comment: '확인', attachmentIds: [] }, '오래된 승인')).toThrow(/VERSION_CONFLICT/)
    const decided = decideMaterialReviewRoundInWorkspace(pending, admin, rid, 1, { status: 'approved', comment: '확인', attachmentIds: [] }, '본사 승인')
    expect(() => decideMaterialReviewRoundInWorkspace(decided, admin, rid, 2, { status: 'rejected', comment: '이력 변경', attachmentIds: [] }, '이력 변경')).toThrow(/이미 결정/)
  })
  it('다른 스타일·PDF·중복 이미지와 빈 제출·잘못된 상태를 거부한다', () => {
    const { workspace, admin, itemId, imageId, otherImage } = fixture()
    for (const data of [submission({ attachmentIds: [otherImage] }), submission({ attachmentIds: [imageId, imageId] }), submission({ comment: '', attachmentIds: [] }), submission({ comment: 'a'.repeat(4001) })]) expect(() => appendMaterialReviewRoundInWorkspace(workspace, admin, crypto.randomUUID(), itemId, 1, data, '이미지 확인')).toThrow()
    workspace.attachments.find(image => image.id === imageId)!.mime = 'application/pdf'
    expect(() => appendMaterialReviewRoundInWorkspace(workspace, admin, crypto.randomUUID(), itemId, 1, submission({ attachmentIds: [imageId] }), 'PDF 보관 시도')).toThrow(/JPG/)
  })
  it('실제 계정의 현재 배정·활성·승인을 사용하고 위조 역할로 접근을 넓히지 않는다', () => {
    const { workspace, factory, admin, itemId } = fixture()
    expect(() => appendMaterialReviewRoundInWorkspace(workspace, { ...factory, role: 'admin' }, crypto.randomUUID(), itemId, 1, submission({ status: 'approved' }), '위조 역할')).toThrow()
    workspace.profiles.find(profile => profile.id === factory.id)!.active = false
    expect(scopeMaterialReviewsWorkspace(workspace, factory).materialReviewItems).toHaveLength(0)
    expect(() => appendMaterialReviewRoundInWorkspace(workspace, factory, crypto.randomUUID(), itemId, 1, submission(), '비활성 제출')).toThrow(/활성 계정/)
    expect(scopeMaterialReviewsWorkspace(workspace, admin).materialReviewItems).toHaveLength(1)
  })
})
