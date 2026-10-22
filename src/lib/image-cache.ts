import type { Attachment } from './types'
interface Entry { refs: number; promise: Promise<string>; url?: string }
export function createImageUrlCache(load: (attachment: Attachment) => Promise<Blob>, urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL) {
  const entries = new Map<string, Entry>()
  return {
    acquire(attachment: Attachment, scope: string) {
      const key = `${scope}:${attachment.id}:${attachment.path}`
      let entry = entries.get(key)
      if (!entry) {
        entry = { refs: 0, promise: Promise.resolve('') }
        const current = entry
        entry.promise = Promise.resolve().then(() => load(attachment)).then(blob => {
          const url = urls.createObjectURL(blob)
          if (current.refs > 0) current.url = url
          else urls.revokeObjectURL(url)
          return url
        }).catch(error => { if (entries.get(key) === current) entries.delete(key); throw error })
        entries.set(key, entry)
      }
      entry.refs += 1
      const current = entry
      let released = false
      return { url: current.promise, release() {
        if (released) return
        released = true; current.refs -= 1
        if (!current.refs) {
          if (entries.get(key) === current) entries.delete(key)
          if (current.url) { urls.revokeObjectURL(current.url); current.url = undefined }
        }
      } }
    },
  }
}
