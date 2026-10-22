import { useEffect, useId, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { AlertCircle, Check, ChevronDown, FileImage, ImagePlus, Images, LockKeyhole, Maximize2, RefreshCw, Save, Trash2, Upload, X } from 'lucide-react'
import type { Attachment, Profile, Style, Workspace } from '../lib/types'
import { resolveStyleImage } from '../lib/style-images'
import { message } from '../lib/utils'
import PrivateImage from './PrivateImage'
import './style-images.css'

interface Props {
  style: Style
  workspace: Workspace
  profile: Profile
  onSetImage: (styleId: string, color: string, attachmentId: string | null, expectedVersion: number, reason: string) => Promise<void>
  onUploadImage: (styleId: string, color: string, file: File, expectedVersion: number, reason: string) => Promise<void>
}
const imageMimes = ['image/png', 'image/webp', 'image/jpeg']
const maxSize = 10 * 1024 * 1024
const mappingFor = (workspace: Workspace, styleId: string, color: string) => workspace.styleImages?.find(image => image.styleId === styleId && image.color === color)

export default function StyleImageManager({ style, workspace, profile, onSetImage, onUploadImage }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [color, setColor] = useState('')
  const initial = mappingFor(workspace, style.id, '')
  const [baseVersion, setBaseVersion] = useState(initial?.version || 0)
  const [baseAttachmentId, setBaseAttachmentId] = useState<string | null>(initial?.attachmentId || null)
  const [chosenId, setChosenId] = useState<string | null>(initial?.attachmentId || null)
  const [file, setFile] = useState<File | null>(null)
  const [fileUrl, setFileUrl] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [choosing, setChoosing] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [clearReason, setClearReason] = useState('')
  const [conflicted, setConflicted] = useState(false)
  const [viewer, setViewer] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const viewerRef = useRef<HTMLElement>(null)
  const titleId = useId()
  const hq = profile.role !== 'factory'
  const available = workspace.styleImagesAvailable !== false
  const mapping = mappingFor(workspace, style.id, color)
  const version = mapping?.version || 0
  const pendingChange = !!file || chosenId !== baseAttachmentId
  const dirty = pendingChange || !!reason.trim()
  const stale = version !== baseVersion || conflicted
  const image = resolveStyleImage(workspace, style.id, color)
  const defaultImage = resolveStyleImage(workspace, style.id)
  const chosenImage = chosenId ? workspace.attachments.find(attachment => attachment.id === chosenId && attachment.styleId === style.id) : undefined
  const previewImage = pendingChange && !file ? chosenImage : image
  const existing = workspace.attachments.filter(attachment => attachment.styleId === style.id && !attachment.sampleId && imageMimes.includes(attachment.mime)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const inherited = !!color && !mapping?.attachmentId && !!defaultImage
  const scope = `${profile.id}:${profile.role}:${profile.factoryId || ''}:${style.id}`

  useEffect(() => {
    if (!dirty && !clearOpen && !busy && version !== baseVersion) {
      setBaseVersion(version)
      setBaseAttachmentId(mapping?.attachmentId || null)
      setChosenId(mapping?.attachmentId || null)
      setConflicted(false)
    }
  }, [dirty, clearOpen, busy, version, baseVersion, mapping?.attachmentId])
  useEffect(() => {
    if (!file) { setFileUrl(''); return }
    const url = URL.createObjectURL(file)
    setFileUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  useEffect(() => {
    if (!viewer) return
    const previous = document.activeElement as HTMLElement | null
    viewerRef.current?.focus()
    return () => previous?.focus()
  }, [viewer])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function loadLatest(nextColor = color) {
    const current = mappingFor(workspace, style.id, nextColor)
    setBaseVersion(current?.version || 0)
    setBaseAttachmentId(current?.attachmentId || null)
    setChosenId(current?.attachmentId || null)
    setFile(null); setReason(''); setError(''); setConflicted(false); setChoosing(false); setClearOpen(false)
  }
  function rebaseLatest() {
    const current = mappingFor(workspace, style.id, color)
    setBaseVersion(current?.version || 0)
    setBaseAttachmentId(current?.attachmentId || null)
    if (!pendingChange || file) setChosenId(current?.attachmentId || null)
    setConflicted(false); setError(''); setChoosing(false); setClearOpen(false)
    setSuccess('최신 이미지 버전을 확인했습니다. 선택한 파일과 사유는 유지됩니다. 변경 내용을 확인한 뒤 저장해 주세요.')
  }
  function selectColor(nextColor: string) { setColor(nextColor); loadLatest(nextColor); setSuccess('') }
  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0]
    event.target.value = ''
    if (!selected) return
    setError(''); setSuccess('')
    if (!imageMimes.includes(selected.type)) { setError('대표 이미지는 PNG, WEBP, JPG 사진만 사용할 수 있습니다. PDF는 코멘트·파일에서 첨부해 주세요.'); return }
    if (!selected.size || selected.size > maxSize) { setError('이미지는 비어 있지 않은 10MB 이하 파일로 선택해 주세요.'); return }
    setFile(selected); setChoosing(false)
  }
  function selectExisting(attachment: Attachment) { setChosenId(attachment.id); setFile(null); setChoosing(false); setError(''); setSuccess('') }
  function finishSave() {
    setFile(null); setReason(''); setChosenId(baseAttachmentId); setChoosing(false); setConflicted(false)
    setSuccess('대표 이미지를 저장했습니다. 스타일 목록에도 반영됩니다.')
  }
  async function save() {
    if (!pendingChange) return
    if (reason.trim().length < 2) { setError('이미지 변경 사유를 두 글자 이상 입력해 주세요.'); return }
    if (stale) { setError('최신 이미지를 불러온 뒤 변경 내용을 다시 확인해 주세요.'); return }
    setBusy(true); setError(''); setSuccess('')
    try {
      if (file) await onUploadImage(style.id, color, file, baseVersion, reason.trim())
      else await onSetImage(style.id, color, chosenId, baseVersion, reason.trim())
      finishSave()
    } catch (err) {
      const text = message(err)
      setError(text)
      if (/conflict|version|다른 사용자가|최신/i.test(text)) setConflicted(true)
    } finally { setBusy(false) }
  }
  async function clear() {
    if (clearReason.trim().length < 2) { setError('이미지 해제 사유를 두 글자 이상 입력해 주세요.'); return }
    if (stale) { setError('최신 이미지를 불러온 뒤 다시 확인해 주세요.'); return }
    setBusy(true); setError(''); setSuccess('')
    try {
      await onSetImage(style.id, color, null, baseVersion, clearReason.trim())
      setChosenId(baseAttachmentId); setReason(''); setClearOpen(false); setClearReason(''); setConflicted(false)
      setSuccess('대표 이미지 연결을 해제했습니다. 원본 파일은 코멘트·파일에 보관됩니다.')
    } catch (err) {
      const text = message(err)
      setError(text)
      if (/conflict|version|다른 사용자가|최신/i.test(text)) setConflicted(true)
    } finally { setBusy(false) }
  }

  return <section className="style-image-manager" role="region" aria-label="대표 이미지">
    <div className="style-image-manager-header">
      <div className="style-image-header-preview">{defaultImage ? <PrivateImage attachment={defaultImage} scope={scope} alt={`${style.code} 스타일 대표 이미지`} className="style-image-mini" onClick={() => { setExpanded(true); if (!dirty && !clearOpen) selectColor(''); setViewer(true) }} /> : <FileImage size={25} strokeWidth={1.2} />}</div>
      <div className="style-image-intro"><h2>대표 이미지 <span>STYLE PHOTO</span></h2><p>{defaultImage ? '스타일 목록과 컬러별 생산 현황에 표시되는 사진입니다.' : '누끼 PNG를 등록해 스타일을 사진으로 구분하세요.'}</p><small>투명 배경 보존 · 비율 유지 · JPG / PNG / WEBP</small></div>
      <button type="button" className="button button-ghost" aria-expanded={expanded} aria-controls={`${titleId}-content`} onClick={() => setExpanded(!expanded)}>{hq ? <ImagePlus size={15} /> : <FileImage size={15} />}{hq ? '대표 이미지 관리' : '대표 이미지 보기'}<ChevronDown size={14} className={expanded ? 'image-chevron-open' : ''} /></button>
    </div>
    {expanded && <div className="style-image-manager-content" id={`${titleId}-content`}>
      {!available ? <div className="style-image-unavailable"><AlertCircle size={17} /><div><strong>대표 이미지 기능 설정이 필요합니다.</strong>{hq && <p>관리자가 데이터베이스에 <code>002_style_images.sql</code> 마이그레이션을 적용한 뒤 다시 접속해 주세요.</p>}</div></div> : <>
        <div className="style-image-target"><label className="field"><span className="field-label">적용 범위</span><select className="select" aria-label="대표 이미지 컬러" value={color} disabled={busy || dirty || clearOpen} onChange={event => selectColor(event.target.value)}><option value="">스타일 공통</option>{style.colors.map(value => <option key={value} value={value}>{value} · {style.code}{value}</option>)}</select></label><p>{color ? '선택한 컬러에만 적용합니다. 별도 사진이 없으면 스타일 공통 사진을 표시합니다.' : '별도 이미지가 없는 모든 컬러에 공통으로 표시합니다.'}{dirty && <span>다른 컬러는 편집 취소 후 선택할 수 있습니다.</span>}</p><span className="style-image-version">이미지 버전 {baseVersion}</span></div>
        {stale && <div className="style-image-warning" role="status"><RefreshCw size={15} /><div><strong>다른 사용자가 이 대표 이미지를 변경했습니다.</strong><p>선택한 파일과 사유는 유지됩니다. 최신 이미지를 불러와 변경 내용을 확인한 뒤 저장해 주세요.</p></div><button className="button" type="button" disabled={busy} onClick={rebaseLatest}>최신 이미지 불러오기</button></div>}
        {error && <div className="style-image-error" role="alert"><AlertCircle size={15} /><span>{error}</span><button className="icon-button" type="button" aria-label="이미지 오류 안내 닫기" onClick={() => setError('')}><X size={14} /></button></div>}
        {success && <div className="style-image-success" role="status"><Check size={14} />{success}</div>}
        <div className="style-image-workarea"><div className="style-image-preview-wrap"><div className="style-image-preview">
          {file && fileUrl ? <button type="button" className="style-image-local-preview" aria-label="선택한 대표 이미지 크게 보기" onClick={() => setViewer(true)}><img src={fileUrl} alt={`${style.code}${color} 새 대표 이미지 미리보기`} /><span><Maximize2 size={13} /></span></button> : previewImage ? <PrivateImage attachment={previewImage} scope={scope} alt={`${style.code}${color} 대표 이미지`} className="style-image-main" onClick={() => setViewer(true)} /> : <div className="style-image-empty"><FileImage size={41} strokeWidth={1} /><strong>등록된 사진이 없습니다.</strong><span>제품 전체가 보이는 누끼 PNG 권장</span></div>}
          {file ? <span className="style-image-preview-caption">선택한 파일 · 저장 전</span> : inherited ? <span className="style-image-preview-caption">스타일 공통 이미지 적용 중</span> : previewImage ? <span className="style-image-preview-caption">{color || '스타일 공통'} 대표 이미지</span> : null}
        </div><div className="style-image-file-caption">{file ? <span className="style-image-selected-file">{file.name}<small>{(file.size / 1024 / 1024).toFixed(2)} MB · 원본 그대로 업로드</small></span> : previewImage ? <span>{previewImage.name}</span> : <span>등록한 이미지는 비율을 유지해 표시합니다.</span>}</div></div>
        {hq ? <div className="style-image-controls"><div className="style-image-upload-buttons"><button className="button" type="button" disabled={busy} onClick={() => inputRef.current?.click()}><Upload size={14} />대표 이미지 업로드</button><input ref={inputRef} className="sr-only" type="file" aria-label="대표 이미지 파일" accept="image/png,image/webp,image/jpeg" onChange={selectFile} /><button className="button button-ghost" type="button" disabled={busy} aria-expanded={choosing} onClick={() => setChoosing(!choosing)}><Images size={15} />기존 사진 선택</button></div><p className="style-image-upload-note">PNG · WEBP · JPG / 최대 10MB<br />배경이 제거된 PNG는 투명도를 유지하며, 사진을 자르거나 변환하지 않습니다.</p>
          {choosing && <div className="style-image-existing-list" aria-label="보관된 스타일 사진">{existing.length ? existing.map(attachment => <button type="button" key={attachment.id} className={`style-image-existing-item ${chosenId === attachment.id && !file ? 'selected' : ''}`} aria-label={`${attachment.name} 대표 이미지로 선택`} onClick={() => selectExisting(attachment)}><PrivateImage attachment={attachment} scope={scope} alt={attachment.name} className="style-image-existing-thumb" /><span>{attachment.name}</span>{chosenId === attachment.id && !file && <Check size={13} />}</button>) : <div className="style-image-existing-empty">선택할 스타일 공통 사진이 없습니다.<br />사진을 업로드하거나 코멘트·파일의 스타일 공통에 첨부해 주세요.</div>}</div>}
          <label className="field"><span className="field-label">이미지 변경 사유</span><input className="input" aria-label="이미지 변경 사유" value={reason} disabled={busy} maxLength={500} placeholder="예: 최종 누끼 이미지로 교체" onChange={event => { setReason(event.target.value); setSuccess('') }} /></label>
          <div className="style-image-edit-actions">{dirty && <button className="button button-ghost" type="button" disabled={busy} onClick={() => { loadLatest(); setSuccess('') }}>편집 취소</button>}<button className="button button-primary" type="button" disabled={busy || stale || !pendingChange} onClick={() => void save()}><Save size={14} />{busy ? '이미지 저장 중…' : '대표 이미지 저장'}</button></div>
          <div className="style-image-clear-area"><button className="button button-ghost" type="button" disabled={busy || stale || pendingChange || !mapping?.attachmentId} onClick={() => { setClearOpen(true); setClearReason(reason); setError('') }}><Trash2 size={13} />대표 이미지 해제</button><p>연결을 해제해도 원본 첨부파일과 변경 이력은 보존됩니다.</p></div>
          {clearOpen && <section className="style-image-clear-confirm" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setClearOpen(false) }; if (event.key === 'Tab') { event.stopPropagation(); const nodes = event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)'); const first = nodes[0], last = nodes[nodes.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } } }} role="alertdialog" aria-label="대표 이미지 연결을 해제할까요?"><h3>대표 이미지 연결을 해제할까요?</h3><p>{color && defaultImage ? '이 컬러는 스타일 공통 이미지를 표시하게 됩니다.' : '스타일 목록에서 이 대표 이미지가 표시되지 않습니다.'} 원본 파일은 계속 보관됩니다.</p><label className="field"><span className="field-label">이미지 해제 사유</span><input autoFocus className="input" aria-label="이미지 해제 사유" value={clearReason} disabled={busy} maxLength={500} placeholder="해제 사유를 입력하세요" onChange={event => setClearReason(event.target.value)} /></label><div><button type="button" className="button button-ghost" disabled={busy} onClick={() => setClearOpen(false)}>취소</button><button type="button" className="button button-primary" disabled={busy || stale || clearReason.trim().length < 2} onClick={() => void clear()}>연결 해제</button></div></section>}
        </div> : <div className="style-image-readonly"><LockKeyhole size={17} /><strong>본사에서 등록한 대표 이미지입니다.</strong><p>공장은 사진을 조회할 수 있습니다.<br />대표 이미지 등록·교체·해제는 본사에서 관리합니다.</p></div>}
        </div>
      </>}
    </div>}
    {viewer && (fileUrl || previewImage) && <div className="style-image-viewer-shade" onMouseDown={event => { if (event.target === event.currentTarget) setViewer(false) }}><section ref={viewerRef} tabIndex={-1} className="style-image-viewer" role="dialog" aria-modal="true" aria-label="대표 이미지 크게 보기" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setViewer(false) }; if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); viewerRef.current?.querySelector('button')?.focus() } }}><header><div><strong>{style.code}{color}</strong><span>{file?.name || previewImage?.name}</span></div><button className="icon-button" type="button" aria-label="대표 이미지 크게 보기 닫기" onClick={() => setViewer(false)}><X size={21} /></button></header><div className="style-image-viewer-canvas">{file && fileUrl ? <img src={fileUrl} alt={`${style.code}${color} 새 대표 이미지 확대`} /> : previewImage && <PrivateImage attachment={previewImage} scope={scope} alt={`${style.code}${color} 대표 이미지 확대`} className="style-image-enlarged" />}</div><footer>원본 비율로 표시 · 투명 배경 유지</footer></section></div>}
  </section>
}
