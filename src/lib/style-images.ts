import type { Attachment, Workspace } from './types'
export const STYLE_IMAGE_MIME = ['image/png', 'image/webp', 'image/jpeg'] as const
export function resolveStyleImage(workspace: Workspace, styleId: string, color = ''): Attachment | undefined {
  const style = workspace.styles.find(s => s.id === styleId && !s.deletedAt)
  if (!style || workspace.styleImagesAvailable === false) return undefined
  const resolve = (targetColor: string) => {
    const mapping = workspace.styleImages?.find(image => image.styleId === styleId && image.color === targetColor)
    return mapping?.attachmentId ? workspace.attachments.find(a => a.id === mapping.attachmentId && a.styleId === styleId && a.sampleId === null && STYLE_IMAGE_MIME.some(mime => mime === a.mime)) : undefined
  }
  return (color && style.colors.includes(color) ? resolve(color) : undefined) || resolve('')
}
