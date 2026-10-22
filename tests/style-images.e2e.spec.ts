import { test, expect, type Page, type Locator } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

const ADMIN = '10000000-0000-4000-8000-000000000001'
const FACTORY = '10000000-0000-4000-8000-000000000004'
const STORAGE = 'sig-workspace-demo-v1'
const CODE = 'BO42FYJK0101'
const FACTORY_CODE = 'BO42FYHD0102'

// Synthetic RGBA fixtures, not edited customer images. Pixel 0 is transparent;
// pixel 3 is opaque so browser rendering and original-byte preservation can be checked.
function rgbaPng(red: number, green: number, blue: number): Buffer {
  const crc32 = (bytes: Buffer) => {
    let value = 0xffffffff
    for (const byte of bytes) {
      value ^= byte
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
    }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, bytes: Buffer) => {
    const tag = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4)
    size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([tag, bytes])))
    return Buffer.concat([size, tag, bytes, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6
  const raw = Buffer.from([0, red, green, blue, 0, red, green, blue, 128, 0, red, green, blue, 255, red, green, blue, 255])
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const commonPng = rgbaPng(25, 50, 75)
const colorPng = rgbaPng(190, 20, 50)

async function ready(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /샘플 & 생산 대시보드/ })).toBeVisible()
  await expect(page.getByLabel('체험 역할')).toHaveValue(ADMIN)
}
async function openStyle(page: Page, code = CODE) {
  await page.getByLabel('스타일 검색', { exact: true }).fill(code)
  await page.locator('.style-code').filter({ hasText: code }).first().click()
  const detail = page.getByRole('dialog')
  await expect(detail.getByRole('heading', { level: 1 })).toContainText(code)
  return detail
}
async function openManager(detail: Locator, factory = false) {
  await detail.getByRole('button', { name: factory ? '대표 이미지 보기' : '대표 이미지 관리', exact: true }).click()
  const manager = detail.getByRole('region', { name: '대표 이미지', exact: true })
  await expect(manager).toBeVisible()
  return manager
}
async function stored(page: Page) { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), STORAGE) }
async function selectAndSave(manager: Locator, name: string, bytes: Buffer, reason: string) {
  await manager.getByLabel('대표 이미지 파일', { exact: true }).setInputFiles({ name, mimeType: 'image/png', buffer: bytes })
  await expect(manager.locator('.style-image-selected-file')).toContainText(name)
  await manager.getByLabel('이미지 변경 사유', { exact: true }).fill(reason)
  await manager.getByRole('button', { name: '대표 이미지 저장', exact: true }).click()
  await expect(manager.locator('.style-image-local-preview')).toHaveCount(0)
}
async function expectPixels(image: Locator, expected: [number, number, number]) {
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth)).toBe(2)
  const pixels = await image.evaluate(node => {
    const image = node as HTMLImageElement, canvas = document.createElement('canvas')
    canvas.width = 2; canvas.height = 2
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    return Array.from(context.getImageData(0, 0, 2, 2).data)
  })
  expect(pixels[3]).toBe(0)
  expect(pixels[7]).toBe(128)
  expect(pixels.slice(12, 16)).toEqual([...expected, 255])
}
async function unlink(page: Page, manager: Locator, reason: string) {
  await manager.getByRole('button', { name: '대표 이미지 해제', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm.getByRole('heading')).toContainText('대표 이미지 연결을 해제할까요?')
  await confirm.getByLabel('이미지 해제 사유', { exact: true }).fill(reason)
  await confirm.getByRole('button', { name: '연결 해제', exact: true }).click()
  await expect(confirm).toHaveCount(0)
}

test('투명 PNG 대표 이미지가 원본 그대로 저장되고 목록·새로고침에 표시된다', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await ready(page)
  const before = await stored(page)
  const detail = await openStyle(page)
  const manager = await openManager(detail)
  await selectAndSave(manager, 'common-transparent.png', commonPng, '공통 대표 이미지 등록 검증')
  await expectPixels(manager.locator('.style-image-preview img'), [25, 50, 75])
  await manager.screenshot({ path: testInfo.outputPath('style-image-manager-desktop.png') })
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await expectPixels(page.locator('tbody tr').filter({ has: page.getByRole('button', { name: CODE, exact: true }) }).locator('img'), [25, 50, 75])
  await page.screenshot({ path: testInfo.outputPath('style-image-dashboard-desktop.png') })
  await page.reload()
  await page.getByLabel('스타일 검색', { exact: true }).fill(CODE)
  await expectPixels(page.locator('tbody tr').filter({ has: page.getByRole('button', { name: CODE, exact: true }) }).locator('img'), [25, 50, 75])
  const after = await stored(page)
  expect(after.styles.find((style: { code: string }) => style.code === CODE)).toEqual(before.styles.find((style: { code: string }) => style.code === CODE))
  expect(after.attachments).toHaveLength(1)
  expect(after.styleImages).toHaveLength(1)
  expect(after.styleImages[0].attachmentId).toBe(after.attachments[0].id)
  expect(after.styleImages[0].version).toBe(1)
  expect(errors).toEqual([])
})

test('컬러별 대표 이미지가 공통 이미지보다 우선하며 해제하면 공통 이미지로 돌아간다', async ({ page }) => {
  await ready(page)
  const detail = await openStyle(page)
  const manager = await openManager(detail)
  await selectAndSave(manager, 'shared.png', commonPng, '스타일 공통 이미지 등록')
  await manager.getByLabel('대표 이미지 컬러', { exact: true }).selectOption('BK')
  await expectPixels(manager.locator('.style-image-preview img'), [25, 50, 75])
  await selectAndSave(manager, 'black-override.png', colorPng, 'BK 컬러 전용 대표 이미지 등록')
  await expectPixels(manager.locator('.style-image-preview img'), [190, 20, 50])
  await manager.getByLabel('대표 이미지 컬러', { exact: true }).selectOption('OT')
  await expectPixels(manager.locator('.style-image-preview img'), [25, 50, 75])
  await manager.getByLabel('대표 이미지 컬러', { exact: true }).selectOption('BK')
  await unlink(page, manager, 'BK 전용 연결 해제 및 공통 이미지 사용')
  await expectPixels(manager.locator('.style-image-preview img'), [25, 50, 75])
  const workspace = await stored(page)
  expect(workspace.attachments).toHaveLength(2)
  const style = workspace.styles.find((item: { code: string }) => item.code === CODE)
  const override = workspace.styleImages.find((item: { styleId: string; color: string }) => item.styleId === style.id && item.color === 'BK')
  expect(override.attachmentId).toBeNull()
  expect(override.version).toBe(2)
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '메인 생산', exact: true }).click()
  await page.getByLabel('스타일 검색', { exact: true }).fill(CODE)
  for (const color of ['BK', 'OT']) await expectPixels(page.locator('tbody tr').filter({ has: page.getByRole('button', { name: `${CODE}${color}`, exact: true }) }).locator('img'), [25, 50, 75])
})

test('대표 이미지 연결 해제 후에도 첨부 원본과 다운로드·변경 이력을 보존한다', async ({ page }) => {
  await ready(page)
  const detail = await openStyle(page)
  const manager = await openManager(detail)
  await selectAndSave(manager, 'retained-original.png', commonPng, '보존 대상 대표 이미지 최초 등록')
  await unlink(page, manager, '대표 이미지 연결만 해제하고 원본 보존')
  await expect(manager.locator('.style-image-preview img')).toHaveCount(0)
  const workspace = await stored(page)
  expect(workspace.attachments).toHaveLength(1)
  expect(workspace.styleImages[0].attachmentId).toBeNull()
  expect(workspace.audits.some((audit: { reason: string }) => audit.reason === '대표 이미지 연결만 해제하고 원본 보존')).toBe(true)
  await detail.getByRole('tab', { name: /코멘트·파일/ }).click()
  const file = detail.locator('.file-item').filter({ hasText: 'retained-original.png' })
  await expect(file).toBeVisible()
  const pending = page.waitForEvent('download')
  await file.click()
  const download = await pending
  expect(await readFile((await download.path())!)).toEqual(commonPng)
  await manager.getByRole('button', { name: '기존 사진 선택', exact: true }).click()
  await manager.getByRole('button', { name: 'retained-original.png 대표 이미지로 선택', exact: true }).click()
  await manager.getByLabel('이미지 변경 사유', { exact: true }).fill('보관된 원본 사진을 다시 대표 이미지로 연결')
  await manager.getByRole('button', { name: '대표 이미지 저장', exact: true }).click()
  await expectPixels(manager.locator('.style-image-preview img'), [25, 50, 75])
  const relinked = await stored(page)
  expect(relinked.attachments).toHaveLength(1)
  expect(relinked.styleImages[0].attachmentId).toBe(relinked.attachments[0].id)
  expect(relinked.styleImages[0].version).toBe(3)
})

test('대표 이미지에 PDF를 강제로 선택해도 파일과 연결을 생성하지 않는다', async ({ page }) => {
  await ready(page)
  const manager = await openManager(await openStyle(page))
  await manager.getByLabel('대표 이미지 파일', { exact: true }).setInputFiles({ name: 'not-an-image.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') })
  await expect(manager.locator('[role="alert"], .error-message').first()).toContainText(/PNG|JPG|WEBP/)
  await expect(manager.locator('.style-image-local-preview')).toHaveCount(0)
  expect((await stored(page)).attachments).toHaveLength(0)
  expect((await stored(page)).styleImages || []).toHaveLength(0)
  await manager.getByLabel('대표 이미지 파일', { exact: true }).setInputFiles({ name: 'spoofed.png', mimeType: 'image/png', buffer: Buffer.from('%PDF-1.4 disguised as PNG') })
  await manager.getByLabel('이미지 변경 사유', { exact: true }).fill('위장된 이미지 내용 검증')
  await manager.getByRole('button', { name: '대표 이미지 저장', exact: true }).click()
  await expect(manager.getByRole('alert')).toContainText('이미지 파일을 읽을 수 없습니다.')
  expect((await stored(page)).attachments).toHaveLength(0)
  expect((await stored(page)).styleImages || []).toHaveLength(0)
})

test('공장은 배정 스타일의 대표 이미지만 보고 등록·해제 권한을 갖지 않는다', async ({ page }) => {
  await ready(page)
  const detail = await openStyle(page, FACTORY_CODE)
  await selectAndSave(await openManager(detail), 'factory-visible.png', commonPng, '배정 공장 조회용 대표 이미지 등록')
  await detail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await page.getByLabel('체험 역할').selectOption(FACTORY)
  const factoryDetail = await openStyle(page, FACTORY_CODE)
  const manager = await openManager(factoryDetail, true)
  await expectPixels(manager.locator('.style-image-preview img'), [25, 50, 75])
  await expect(factoryDetail.getByRole('button', { name: '대표 이미지 관리', exact: true })).toHaveCount(0)
  await expect(manager.getByLabel('대표 이미지 파일', { exact: true })).toHaveCount(0)
  await expect(manager.getByLabel('이미지 변경 사유', { exact: true })).toHaveCount(0)
  await expect(manager.getByRole('button', { name: '대표 이미지 해제', exact: true })).toHaveCount(0)
  await factoryDetail.getByRole('button', { name: '상세 화면 닫기', exact: true }).click()
  await page.getByLabel('스타일 검색', { exact: true }).fill(CODE)
  await expect(page.locator('.style-code')).toHaveCount(0)
})

test('두 탭의 대표 이미지 변경 충돌을 알리고 미저장 파일과 사유를 유지한다', async ({ page, context }) => {
  await ready(page)
  const managerA = await openManager(await openStyle(page))
  const tabB = await context.newPage()
  await ready(tabB)
  const managerB = await openManager(await openStyle(tabB))
  await managerB.getByLabel('대표 이미지 파일', { exact: true }).setInputFiles({ name: 'tab-b-draft.png', mimeType: 'image/png', buffer: colorPng })
  await managerB.getByLabel('이미지 변경 사유', { exact: true }).fill('다른 탭에서 작성 중이던 변경 사유')
  await expect(managerB.getByRole('button', { name: '대표 이미지 저장', exact: true })).toBeEnabled()
  await selectAndSave(managerA, 'tab-a-first.png', commonPng, '첫 번째 탭의 먼저 저장한 대표 이미지')
  await expect(managerB.getByText('다른 사용자가 이 대표 이미지를 변경했습니다.', { exact: true })).toBeVisible()
  const saveB = managerB.getByRole('button', { name: '대표 이미지 저장', exact: true })
  if (await saveB.isEnabled()) {
    await saveB.click()
    await expect(managerB.locator('[role="alert"], .error-message').first()).toContainText(/다른 사용자|충돌|최신/)
  }
  await expect(managerB.locator('.style-image-selected-file')).toContainText('tab-b-draft.png')
  await expect(managerB.getByLabel('이미지 변경 사유', { exact: true })).toHaveValue('다른 탭에서 작성 중이던 변경 사유')
  await expectPixels(managerB.locator('.style-image-local-preview img'), [190, 20, 50])
  const workspace = await stored(page)
  const selected = workspace.attachments.find((item: { id: string }) => item.id === workspace.styleImages[0].attachmentId)
  expect(selected.name).toBe('tab-a-first.png')
  expect(workspace.styleImages[0].version).toBe(1)
  await managerB.getByRole('button', { name: '최신 이미지 불러오기', exact: true }).click()
  await expect(managerB.locator('.style-image-selected-file')).toContainText('tab-b-draft.png')
  await expect(managerB.getByLabel('이미지 변경 사유', { exact: true })).toHaveValue('다른 탭에서 작성 중이던 변경 사유')
  await expect(saveB).toBeEnabled()
})

test('모바일 대표 이미지 편집과 투명 미리보기가 페이지 밖으로 넘치지 않는다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await ready(page)
  const manager = await openManager(await openStyle(page))
  await selectAndSave(manager, 'mobile-transparent.png', commonPng, '모바일 대표 이미지 등록 검증')
  await expectPixels(manager.locator('.style-image-preview img'), [25, 50, 75])
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width)
  const box = await manager.boundingBox()
  expect(box?.width).toBeLessThanOrEqual(390)
  const imageBox = await manager.locator('.style-image-preview img').boundingBox()
  expect(imageBox?.width).toBeLessThanOrEqual(box!.width)
  await manager.locator('.style-image-preview').scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('style-image-mobile.png') })
})
