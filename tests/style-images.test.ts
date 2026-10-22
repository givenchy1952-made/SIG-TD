import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { resolveStyleImage } from '../src/lib/style-images'
import { scopeWorkspace } from '../src/lib/utils'
import type { Attachment, StyleImage, Workspace } from '../src/lib/types'

function fixture() {
  const workspace = createSeed()
  const style = workspace.styles.find(s => s.factoryId === DEMO_IDS.china)!
  const other = workspace.styles.find(s => s.factoryId !== style.factoryId)!
  const factory = workspace.profiles.find(p => p.id === DEMO_IDS.factory)!
  const admin = workspace.profiles.find(p => p.id === DEMO_IDS.admin)!
  workspace.attachments = []
  workspace.styleImages = []
  workspace.styleImagesAvailable = true
  const attach = (id: string, options: Partial<Attachment> = {}): Attachment => {
    const attachment: Attachment = { id, styleId: style.id, sampleId: null, name: `${id}.png`, path: `${style.id}/${id}.png`, mime: 'image/png', size: 2084, uploadedBy: admin.id, createdAt: new Date().toISOString(), ...options }
    workspace.attachments.push(attachment)
    return attachment
  }
  const map = (color: string, attachmentId: string | null, options: Partial<StyleImage> = {}): StyleImage => {
    const mapping = { styleId: style.id, color, attachmentId, version: 1, updatedAt: new Date().toISOString(), updatedBy: admin.id, ...options }
    workspace.styleImages!.push(mapping)
    return mapping
  }
  return { workspace, style, other, factory, admin, attach, map }
}

describe('품번 및 컬러 대표 이미지 선택', () => {
  it('컬러 이미지가 없으면 스타일 기본 대표 이미지를 사용한다', () => {
    const { workspace, style, attach, map } = fixture()
    const image = attach('default-cutout')
    map('', image.id)
    expect(resolveStyleImage(workspace, style.id)).toEqual(image)
    expect(resolveStyleImage(workspace, style.id, 'BK')).toEqual(image)
    expect(resolveStyleImage(workspace, style.id, 'OW')).toEqual(image)
  })

  it('유효한 컬러별 누끼 이미지는 기본 대표 이미지보다 우선한다', () => {
    const { workspace, style, attach, map } = fixture()
    const fallback = attach('default-cutout')
    const black = attach('black-cutout')
    const navy = attach('navy-cutout')
    map('', fallback.id); map('BK', black.id); map('NV', navy.id)
    expect(resolveStyleImage(workspace, style.id, 'BK')).toEqual(black)
    expect(resolveStyleImage(workspace, style.id, 'NV')).toEqual(navy)
    expect(resolveStyleImage(workspace, style.id, 'OW')).toEqual(fallback)
    expect(resolveStyleImage(workspace, style.id)).toEqual(fallback)
  })

  it('컬러 이미지 선택을 해제한 tombstone은 기본 이미지로 되돌아간다', () => {
    const { workspace, style, attach, map } = fixture()
    const fallback = attach('default-cutout')
    map('', fallback.id); map('BK', null, { version: 2 })
    expect(resolveStyleImage(workspace, style.id, 'BK')).toEqual(fallback)
  })

  it('기본 이미지도 선택 해제되었으면 다른 첨부파일을 임의로 대표 이미지로 사용하지 않는다', () => {
    const { workspace, style, attach, map } = fixture()
    attach('unselected-style-photo')
    map('', null, { version: 2 }); map('BK', null, { version: 2 })
    expect(resolveStyleImage(workspace, style.id)).toBeUndefined()
    expect(resolveStyleImage(workspace, style.id, 'BK')).toBeUndefined()
  })

  it('참조한 컬러 파일이 사라져도 유효한 기본 이미지로 안전하게 대체한다', () => {
    const { workspace, style, attach, map } = fixture()
    const fallback = attach('default-cutout')
    map('', fallback.id); map('BK', 'deleted-attachment-id')
    expect(resolveStyleImage(workspace, style.id, 'BK')).toEqual(fallback)
    workspace.attachments = []
    expect(resolveStyleImage(workspace, style.id, 'BK')).toBeUndefined()
  })

  it.each(['image/png', 'image/jpeg', 'image/webp'])('지원하는 %s 이미지 첨부파일을 표시한다', mime => {
    const { workspace, style, attach, map } = fixture()
    const image = attach('supported-image', { mime })
    map('', image.id)
    expect(resolveStyleImage(workspace, style.id)).toEqual(image)
  })

  it.each(['application/pdf', 'image/svg+xml', 'image/gif', 'text/html'])('대표 이미지로 사용할 수 없는 MIME %s을 표시하지 않는다', mime => {
    const { workspace, style, attach, map } = fixture()
    const image = attach('unsupported-file', { mime })
    map('', image.id)
    expect(resolveStyleImage(workspace, style.id)).toBeUndefined()
  })

  it('PDF나 잘못된 컬러 참조는 기본 이미지를 가리지 않는다', () => {
    const { workspace, style, attach, map } = fixture()
    const fallback = attach('default-cutout')
    const pdf = attach('specification', { mime: 'application/pdf', name: 'specification.pdf' })
    map('', fallback.id); map('BK', pdf.id)
    expect(resolveStyleImage(workspace, style.id, 'BK')).toEqual(fallback)
  })

  it('다른 스타일의 첨부파일을 참조하는 잘못된 이미지 매핑은 표시하지 않는다', () => {
    const { workspace, style, other, attach, map } = fixture()
    const foreign = attach('other-style-secret', { styleId: other.id, path: `${other.id}/cutout.png` })
    map('', foreign.id)
    expect(resolveStyleImage(workspace, style.id)).toBeUndefined()
    const fallback = attach('own-cutout')
    workspace.styleImages = workspace.styleImages?.filter(m => m.color !== '')
    map('', fallback.id); map('BK', foreign.id)
    expect(resolveStyleImage(workspace, style.id, 'BK')).toEqual(fallback)
  })

  it('샘플 차수에 첨부한 작업 사진을 스타일 대표 이미지로 자동 노출하지 않는다', () => {
    const { workspace, style, attach, map } = fixture()
    const sample = attach('sample-only-photo', { sampleId: style.samples[0]?.id || 'sample-round-id' })
    map('', sample.id)
    expect(resolveStyleImage(workspace, style.id)).toBeUndefined()
    const fallback = attach('style-cutout')
    workspace.styleImages = workspace.styleImages?.filter(m => m.color !== '')
    map('', fallback.id); map('BK', sample.id)
    expect(resolveStyleImage(workspace, style.id, 'BK')).toEqual(fallback)
  })

  it('이미지 기능을 사용할 수 없는 환경에서는 저장된 매핑이 있어도 노출하지 않는다', () => {
    const { workspace, style, attach, map } = fixture()
    map('', attach('unavailable-feature-image').id)
    workspace.styleImagesAvailable = false
    expect(resolveStyleImage(workspace, style.id)).toBeUndefined()
  })

  it('해당 스타일에 없는 컬러의 오래된 매핑은 기본 이미지를 대체하지 않는다', () => {
    const { workspace, style, attach, map } = fixture()
    const fallback = attach('default-cutout')
    const obsolete = attach('obsolete-color-cutout')
    map('', fallback.id); map('ZZ', obsolete.id)
    expect(style.colors).not.toContain('ZZ')
    expect(resolveStyleImage(workspace, style.id, 'ZZ')).toEqual(fallback)
  })

  it('존재하지 않거나 삭제된 스타일의 오래된 이미지 매핑을 반환하지 않는다', () => {
    const { workspace, style, attach, map } = fixture()
    map('', attach('removed-style-cutout').id)
    style.deletedAt = new Date().toISOString()
    expect(resolveStyleImage(workspace, style.id)).toBeUndefined()
    workspace.styles = workspace.styles.filter(s => s.id !== style.id)
    expect(resolveStyleImage(workspace, style.id)).toBeUndefined()
  })

  it('이전 체험 데이터처럼 이미지 필드가 없어도 오류 없이 빈 이미지를 반환한다', () => {
    const workspace: Workspace = createSeed()
    delete workspace.styleImages
    delete workspace.styleImagesAvailable
    expect(() => resolveStyleImage(workspace, workspace.styles[0].id, 'BK')).not.toThrow()
    expect(resolveStyleImage(workspace, workspace.styles[0].id, 'BK')).toBeUndefined()
  })
})

describe('이미지 매핑의 역할별 조회 범위', () => {
  it('공장에 배정된 활성 스타일 이미지 매핑과 첨부파일만 남긴다', () => {
    const { workspace, style, other, factory, attach, map } = fixture()
    const ownImage = attach('own-cutout')
    const foreignImage = attach('foreign-cutout', { styleId: other.id })
    map('', ownImage.id)
    map('BK', ownImage.id)
    map('', foreignImage.id, { styleId: other.id })
    const scoped = scopeWorkspace(workspace, factory)
    expect(scoped.styleImages).toHaveLength(2)
    expect(scoped.styleImages?.every(m => m.styleId === style.id)).toBe(true)
    expect(scoped.attachments.map(a => a.id)).toEqual([ownImage.id])
    expect(resolveStyleImage(scoped, other.id)).toBeUndefined()
    expect(resolveStyleImage(scoped, style.id, 'BK')).toEqual(ownImage)
  })

  it.each([{ approved: false, active: true }, { approved: true, active: false }])('승인 전·비활성 사용자에게 이미지 매핑이 노출되지 않는다: %j', flags => {
    const { workspace, factory, attach, map } = fixture()
    map('', attach('private-cutout').id)
    const scoped = scopeWorkspace(workspace, { ...factory, ...flags })
    expect(scoped.styles).toHaveLength(0)
    expect(scoped.attachments).toHaveLength(0)
    expect(scoped.styleImages || []).toHaveLength(0)
  })

  it('관리자의 활성 스타일 조회에서도 삭제된 스타일의 이미지 매핑을 제외한다', () => {
    const { workspace, style, other, admin, attach, map } = fixture()
    map('', attach('removed-cutout').id)
    const keep = attach('active-cutout', { styleId: other.id })
    map('', keep.id, { styleId: other.id })
    style.deletedAt = new Date().toISOString()
    const scoped = scopeWorkspace(workspace, admin)
    expect(scoped.styleImages).toHaveLength(1)
    expect(scoped.styleImages?.[0].styleId).toBe(other.id)
  })

  it('삭제된 스타일은 이미지 매핑을 통해 공장에 다시 노출되지 않는다', () => {
    const { workspace, style, factory, attach, map } = fixture()
    map('', attach('deleted-style-cutout').id)
    style.deletedAt = new Date().toISOString()
    const scoped = scopeWorkspace(workspace, factory)
    expect(scoped.styleImages || []).toHaveLength(0)
    expect(resolveStyleImage(scoped, style.id)).toBeUndefined()
  })
})
