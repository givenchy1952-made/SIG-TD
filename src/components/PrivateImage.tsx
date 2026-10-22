import { useEffect, useState } from 'react'
import { Shirt } from 'lucide-react'
import type { Attachment } from '../lib/types'
import { loadAttachmentBlob } from '../lib/repository'
import { createImageUrlCache } from '../lib/image-cache'
const images = createImageUrlCache(loadAttachmentBlob)
export default function PrivateImage({ attachment, scope, alt, className = '', onClick }: { attachment: Attachment; scope: string; alt: string; className?: string; onClick?: () => void }) {
  const key = `${scope}:${attachment.id}:${attachment.path}`
  const [state, setState] = useState<{ key: string; url?: string; failed?: boolean }>({ key })
  useEffect(() => {
    let active = true
    const lease = images.acquire(attachment, scope)
    lease.url.then(url => { if (active) setState({ key, url }) }).catch(() => { if (active) setState({ key, failed: true }) })
    return () => { active = false; lease.release() }
  }, [key, attachment.id, attachment.path, scope])
  const current = state.key === key ? state : { key }
  const content = current.url && !current.failed ? <img src={current.url} alt={alt} loading="lazy" decoding="async" onError={() => setState({ key, failed: true })} /> : <Shirt size={22} strokeWidth={1.15} aria-label={current.failed ? '이미지를 불러오지 못했습니다' : '이미지를 불러오는 중입니다'} />
  return onClick ? <button type="button" className={`private-image ${className}`} onClick={onClick} aria-label={`${alt} 크게 보기`} aria-busy={!current.url && !current.failed}>{content}</button> : <span className={`private-image ${className}`} aria-busy={!current.url && !current.failed}>{content}</span>
}
