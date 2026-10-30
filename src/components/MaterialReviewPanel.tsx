import { useEffect, useState, type ChangeEvent } from 'react'
import { Download, History, ImagePlus, Pencil, Plus, RefreshCw, Save } from 'lucide-react'
import type { Attachment, ProductionLine, Profile, Style, Workspace } from '../lib/types'
import { canViewStyle } from '../lib/permissions'
import { fullStyleSku } from '../lib/style-identity'
import { materialReviewItemChangedSinceRound, type MaterialReviewItem, type MaterialReviewRound } from '../lib/material-reviews'
import { appendMaterialReviewRound, decideMaterialReviewRound, saveMaterialReviewItem } from '../lib/material-reviews-repository'
import { message } from '../lib/utils'
import PrivateImage from './PrivateImage'
import './material-reviews.css'

interface Props {
  workspace: Workspace
  style: Style
  line: ProductionLine
  profile: Profile
  onChanged: () => Promise<unknown>
  onDirtyChange?: (dirty: boolean) => void
  onUpload: (styleId: string, file: File) => Promise<void>
  onDownload: (attachment: Attachment) => Promise<void>
  parentDirty?: boolean
}
interface Editor {
  mode: 'item' | 'append' | 'decision'
  itemId: string
  itemVersion: number
  roundId?: string
  roundVersion?: number
  kind: 'fabric' | 'trim'
  name: string
  specification: string
  status: 'pending' | 'approved' | 'rejected'
  comment: string
  attachmentIds: string[]
  reason: string
}
const labels = { fabric: '원단', trim: '부자재' }
const statuses = { pending: '컨펌 대기', approved: '확정', rejected: '리젝' }
const imageMimes = ['image/jpeg', 'image/png', 'image/webp']
const time = (value: string | null) => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }) : '—'

export default function MaterialReviewPanel({ workspace, style, line, profile, onChanged, onDirtyChange, onUpload, onDownload, parentDirty = false }: Props) {
  const [editor, setEditor] = useState<Editor | null>(null)
  const [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false), [refreshRequired, setRefreshRequired] = useState(false)
  const [error, setError] = useState(''), [success, setSuccess] = useState('')
  const actor = workspace.profiles.find(item => item.id === profile.id)
  const allowed = !!actor && canViewStyle(actor, style) && style.production.some(item => item.id === line.id)
  const hq = !!actor && actor.role !== 'factory'
  const ready = workspace.materialReviewsAvailable === true
  const items = (workspace.materialReviewItems || []).filter(item => item.styleId === style.id && item.lineId === line.id).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  const roundsFor = (id: string) => (workspace.materialReviewRounds || []).filter(round => round.itemId === id).sort((left, right) => left.round - right.round || left.createdAt.localeCompare(right.createdAt))
  const currentItem = editor ? items.find(item => item.id === editor.itemId) : undefined
  const currentRound = editor?.roundId ? roundsFor(editor.itemId).find(round => round.id === editor.roundId) : undefined
  const stale = !!editor && (editor.mode === 'item' ? (currentItem?.version || 0) !== editor.itemVersion : !currentItem || currentItem.version !== editor.itemVersion || editor.mode === 'decision' && (!currentRound || currentRound.version !== editor.roundVersion || currentRound.status !== 'pending'))
  const images = workspace.attachments.filter(file => file.styleId === style.id && imageMimes.includes(file.mime)).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const changing = !!editor || busy || uploading || refreshRequired
  const scope = `${profile.id}:${profile.role}:${profile.factoryId || ''}:${style.id}:materials`
  useEffect(() => { onDirtyChange?.(changing); return () => onDirtyChange?.(false) }, [changing, onDirtyChange])
  if (!allowed) return null

  function begin(mode: Editor['mode'], item?: MaterialReviewItem, round?: MaterialReviewRound, status: Editor['status'] = 'pending') {
    if (!ready || changing) return
    if (parentDirty) { setError('메인 생산에서 편집 중인 내용을 먼저 저장하거나 취소해 주세요.'); return }
    setEditor({ mode, itemId: item?.id || crypto.randomUUID(), itemVersion: item?.version || 0, roundId: round?.id, roundVersion: round?.version, kind: item?.kind || 'fabric', name: item?.name || '', specification: item?.specification || '', status, comment: '', attachmentIds: [], reason: '' })
    setError(''); setSuccess('')
  }
  function update<K extends keyof Editor>(key: K, value: Editor[K]) { setEditor(current => current ? { ...current, [key]: value } : current); setSuccess('') }
  async function refresh() {
    if (busy || uploading) return
    setBusy(true); setError('')
    try { await onChanged(); setRefreshRequired(false) } catch { setRefreshRequired(true); setError('최신 컨펌 이력을 불러오지 못했습니다. 다시 불러와 주세요.') }
    finally { setBusy(false) }
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file || busy || uploading || !editor || stale) return
    if (!imageMimes.includes(file.type) || file.size > 10 * 1024 * 1024) { setError('컨펌 사진은 10MB 이하의 JPG, PNG, WEBP만 사용할 수 있습니다.'); return }
    setUploading(true); setError(''); setSuccess('')
    try { await onUpload(style.id, file); setSuccess('이미지를 업로드했습니다. 아래 사진 목록에서 이번 회차에 첨부할 이미지를 선택해 주세요.') }
    catch (failure) { setError(message(failure)) }
    finally { setUploading(false) }
  }
  async function save() {
    if (!editor || !actor || busy || uploading || stale || parentDirty || !ready) return
    if (editor.reason.trim().length < 2) { setError('기록 사유를 두 글자 이상 입력해 주세요.'); return }
    if (editor.mode === 'item' && !editor.name.trim()) { setError('원단·부자재 항목명을 입력해 주세요.'); return }
    if (editor.mode !== 'item' && !editor.comment.trim() && !editor.attachmentIds.length) { setError('이번 회차의 코멘트 또는 사진을 하나 이상 입력해 주세요.'); return }
    setBusy(true); setError(''); setSuccess('')
    let saved = false
    try {
      if (editor.mode === 'item') await saveMaterialReviewItem(editor.itemId, style.id, line.id, editor.itemVersion, { kind: editor.kind, name: editor.name.trim(), specification: editor.specification.trim() }, editor.reason.trim(), actor)
      else if (editor.mode === 'decision') await decideMaterialReviewRound(editor.roundId!, editor.roundVersion!, { status: editor.status as 'approved' | 'rejected', comment: editor.comment.trim(), attachmentIds: [...editor.attachmentIds] }, editor.reason.trim(), actor)
      else await appendMaterialReviewRound(crypto.randomUUID(), editor.itemId, editor.itemVersion, { status: editor.status, comment: editor.comment.trim(), attachmentIds: [...editor.attachmentIds] }, editor.reason.trim(), actor)
      saved = true; setEditor(null); setSuccess('원·부자재 컨펌 기록을 저장했습니다. 이전 회차의 코멘트와 사진은 보존됩니다.')
      await onChanged(); setRefreshRequired(false)
    } catch (failure) {
      if (saved) { setRefreshRequired(true); setError('컨펌 기록은 저장됐지만 최신 화면을 불러오지 못했습니다. 다시 불러온 뒤 다음 작업을 진행해 주세요.') }
      else setError(message(failure))
    } finally { setBusy(false) }
  }
  function attachments(ids: string[], label: string) {
    return <div className="material-review-images">{ids.map(id => {
      const file = images.find(item => item.id === id)
      return file ? <figure key={id}><PrivateImage attachment={file} scope={scope} alt={`${label} ${file.name}`}/><figcaption>{file.name}</figcaption><button type="button" className="button button-ghost" aria-label={`${label} ${file.name} 다운로드`} onClick={() => void onDownload(file).catch(failure => setError(message(failure)))}><Download size={12}/>사진 다운로드</button></figure> : <p className="muted" key={id}>첨부 이미지의 조회 권한 또는 파일 상태를 확인해 주세요.</p>
    })}</div>
  }
  return <section className="material-reviews" aria-label="원·부자재 세부 컨펌">
    <div className="section-heading"><div><h3>원·부자재 세부 컨펌</h3><p className="muted">{fullStyleSku(style.code, line.color)} · 항목별 1차·2차·3차 검토와 코멘트·사진을 보관합니다.</p></div>{hq && ready && <button type="button" className="button" disabled={changing || parentDirty} onClick={() => begin('item')}><Plus size={13}/>원·부자재 항목 추가</button>}</div>
    <p className="material-review-note">기존 원·부자재 체크는 그대로 유지됩니다. 업체가 컨펌을 요청하면 본사가 같은 회차에서 확정·리젝하고, 리젝 후 다음 회차를 요청할 수 있습니다.</p>
    {!ready ? <p role="status" className="material-review-empty">원·부자재 컨펌 기록 기능을 준비 중입니다. 기존 생산 정보와 체크는 계속 사용할 수 있습니다.</p> : <>
      {error && <div className="error-message" role="alert">{error}</div>}{success && <div className="success-message" role="status">{success}</div>}
      {stale && <div className="error-message" role="status">다른 사용자가 이 항목이나 컨펌을 변경했습니다. 입력한 내용은 유지됩니다. 편집을 취소하고 최신 이력을 확인해 주세요.</div>}
      {refreshRequired && <button type="button" className="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={13}/>최신 컨펌 이력 다시 불러오기</button>}
      {!items.length && !editor && <p className="material-review-empty">등록된 원단·부자재 항목이 없습니다. 본사에서 항목과 사양을 등록하면 회차별 컨펌을 요청할 수 있습니다.</p>}
      <div className="material-review-items">{items.map(item => {
        const rounds = roundsFor(item.id), latest = rounds.at(-1), canAppend = (!latest || latest.status === 'rejected' || hq && latest.status === 'approved') && (latest?.round || 0) < 100
        const itemChanged = materialReviewItemChangedSinceRound(item, latest)
        return <article className="material-review-item" key={item.id} aria-label={`${labels[item.kind]} ${item.name} 컨펌`}>
          <header><div><span className="material-review-kind">{labels[item.kind]}</span><h4>{item.name}</h4><p>{item.specification || '사양 미입력'}</p></div><span className={`material-review-status material-review-${itemChanged ? 'pending' : latest?.status || 'unset'}`}>{itemChanged ? '항목 정보 변경 · 재컨펌 필요' : latest ? `${latest.round}차 · ${statuses[latest.status]}` : '컨펌 이력 없음'}</span></header>
          {itemChanged && <p className="material-review-note" role="status">아래 {latest!.round}차 이력은 변경 전 항목 정보 기준입니다. 현재 정보는 다음 회차에서 컨펌해 주세요.</p>}
          <div className="material-review-actions">{hq && <button type="button" className="button button-ghost" disabled={changing || parentDirty} onClick={() => begin('item', item)}><Pencil size={12}/>항목 정보 수정</button>}{canAppend && <button type="button" className="button" disabled={changing || parentDirty} onClick={() => begin('append', item)}>{(latest?.round || 0) + 1}차 컨펌 요청</button>}</div>
          {!!rounds.length && <details className="material-review-history" open><summary><History size={13}/>컨펌 이력 · {rounds.length}회</summary><ol>{rounds.map(round => <li key={round.id} aria-label={`${item.name} ${round.round}차 컨펌 이력`}>
            <div className="material-review-history-heading"><strong>{round.round}차 · {statuses[round.status]}</strong><time>{time(round.createdAt)}</time></div>
            <p className="material-review-history-identity">{round.itemSnapshot.name} · {round.itemSnapshot.specification || '사양 미입력'}</p>
            <p className="material-review-by">요청·기록: {round.actorName}</p><p className="material-review-comment">{round.comment || '요청 코멘트 없음'}</p>
            {attachments(round.attachmentIds, `${item.name} ${round.round}차 요청`)}
            {round.reviewedAt && <div className="material-review-decision"><strong>본사 검토 · {statuses[round.status]}</strong><small>{round.reviewedByName} · {time(round.reviewedAt)}</small><p className="material-review-comment">{round.reviewerComment || '검토 코멘트 없음'}</p>{attachments(round.reviewAttachmentIds, `${item.name} ${round.round}차 검토`)}</div>}
            {hq && round.status === 'pending' && <div className="material-review-actions"><button type="button" className="button" disabled={changing || parentDirty} onClick={() => begin('decision', item, round, 'approved')}>{round.round}차 확정</button><button type="button" className="button" disabled={changing || parentDirty} onClick={() => begin('decision', item, round, 'rejected')}>{round.round}차 리젝</button></div>}
          </li>)}</ol></details>}
        </article>
      })}</div>
      {editor && <section className="material-review-editor" aria-label={editor.mode === 'item' ? '원·부자재 항목 편집' : editor.mode === 'decision' ? '원·부자재 컨펌 검토' : '원·부자재 컨펌 요청'}>
        <h4>{editor.mode === 'item' ? '원·부자재 항목 정보' : editor.mode === 'decision' ? `${currentRound?.round || ''}차 ${statuses[editor.status]} 검토 · ${editor.name}` : `${(roundsFor(editor.itemId).at(-1)?.round || 0) + 1}차 컨펌 요청 · ${editor.name}`}</h4>
        {editor.mode === 'item' ? <div className="form-grid"><label className="field"><span className="field-label">구분</span><select className="select" aria-label="원·부자재 구분" value={editor.kind} disabled={busy} onChange={event => update('kind', event.target.value as Editor['kind'])}><option value="fabric">원단</option><option value="trim">부자재</option></select></label><label className="field"><span className="field-label">항목명</span><input className="input" aria-label="원·부자재 항목명" value={editor.name} maxLength={160} disabled={busy} onChange={event => update('name', event.target.value)}/></label><label className="field material-review-wide"><span className="field-label">사양</span><textarea className="textarea" aria-label="원·부자재 사양" value={editor.specification} maxLength={2000} disabled={busy} onChange={event => update('specification', event.target.value)}/></label></div> : <>
          {hq && editor.mode === 'append' && <label className="field"><span className="field-label">기록 상태</span><select className="select" aria-label="원·부자재 기록 상태" value={editor.status} disabled={busy || uploading} onChange={event => update('status', event.target.value as Editor['status'])}><option value="pending">컨펌 요청 · 대기</option><option value="approved">검토 완료 기록 · 확정</option><option value="rejected">검토 완료 기록 · 리젝</option></select></label>}
          <label className="field"><span className="field-label">{editor.mode === 'decision' ? '본사 검토 코멘트' : '요청 코멘트'}</span><textarea className="textarea" aria-label="원·부자재 컨펌 코멘트" value={editor.comment} maxLength={4000} rows={3} disabled={busy || uploading} onChange={event => update('comment', event.target.value)}/></label>
          <div className="material-review-image-picker"><div className="section-heading"><strong>이번 {editor.mode === 'decision' ? '검토' : '요청'}에 첨부할 사진</strong><label className="button"><ImagePlus size={13}/>{uploading ? '이미지 업로드 중…' : '이미지 업로드'}<input type="file" aria-label="원·부자재 컨펌 이미지 업로드" accept="image/jpeg,image/png,image/webp" disabled={busy || uploading || stale} onChange={event => void upload(event)}/></label></div><p className="muted">JPG·PNG·WEBP 사진을 업로드한 뒤 아래 목록에서 선택하세요. 이전 회차의 첨부 사진은 그대로 남습니다.</p><div className="material-review-image-options">{images.map(file => <label key={file.id}><input type="checkbox" aria-label={`컨펌 이미지 ${file.name}`} checked={editor.attachmentIds.includes(file.id)} disabled={busy || uploading || !editor.attachmentIds.includes(file.id) && editor.attachmentIds.length >= 12} onChange={event => update('attachmentIds', event.target.checked ? [...editor.attachmentIds, file.id] : editor.attachmentIds.filter(id => id !== file.id))}/><PrivateImage attachment={file} scope={scope} alt={file.name}/><span>{file.name}</span></label>)}{!images.length && <p className="muted">이 스타일에 등록된 사진이 없습니다.</p>}</div></div>
        </>}
        <label className="field"><span className="field-label">기록 사유</span><input className="input" aria-label="원·부자재 기록 사유" value={editor.reason} maxLength={1000} disabled={busy || uploading} onChange={event => update('reason', event.target.value)}/></label>
        <div className="material-review-editor-actions"><button type="button" className="button" disabled={busy || uploading} onClick={() => { setEditor(null); setError('') }}>원·부자재 편집 취소</button>{stale && <button type="button" className="button" disabled={busy || uploading} onClick={() => { setEditor(null); void refresh() }}>편집 취소 후 컨펌 다시 불러오기</button>}<button type="button" className="button button-primary" disabled={busy || uploading || stale || parentDirty || editor.reason.trim().length < 2 || editor.mode === 'item' && !editor.name.trim()} onClick={() => void save()}><Save size={13}/>{busy ? '저장 중…' : editor.mode === 'item' ? '원·부자재 항목 저장' : editor.mode === 'decision' ? '원·부자재 검토 확정' : '원·부자재 컨펌 요청 저장'}</button></div>
      </section>}
    </>}
  </section>
}
