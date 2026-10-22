import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Attachment, Profile, Style, Workspace, Factory, Project } from './types'
import { createSeed } from './seed'
import { assertActive, assertStyleSave, canViewStyle } from './permissions'
export const demoAllowed = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO === 'true' || ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
const url = import.meta.env.VITE_SUPABASE_URL?.trim(), key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()
let configurationError = ''
if (!!url !== !!key) configurationError = 'Supabase URL과 공개 키를 모두 설정해 주세요.'
if (url && !/^https:\/\/[^\s]+$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(url)) configurationError = 'Supabase URL 형식이 올바르지 않습니다.'
if (key?.startsWith('sb_secret_')) configurationError = 'Supabase secret 키는 브라우저에서 사용할 수 없습니다. 공개 anon 또는 publishable 키를 사용해 주세요.'
if (key) { try { if (JSON.parse(atob(key.split('.')[1] || '')).role === 'service_role') configurationError = '관리자 service_role 키는 브라우저에서 사용할 수 없습니다. 공개 anon 또는 publishable 키로 변경해 주세요.' } catch { /* publishable keys are not JWTs */ } }
let supabase: SupabaseClient | null = null
if (url && key && !configurationError) { try { supabase = createClient(url, key) } catch { configurationError = 'Supabase 연결 정보를 초기화할 수 없습니다. URL과 공개 키 형식을 확인해 주세요.' } }
export { configurationError, supabase }
const STORAGE_KEY = 'sig-workspace-demo-v1'
export function getDemoWorkspace(): Workspace { const raw = localStorage.getItem(STORAGE_KEY); if (raw) { try { const parsed = JSON.parse(raw); if (parsed.styles && parsed.profiles && parsed.factories && parsed.projects && parsed.comments && parsed.attachments && parsed.audits) return parsed } catch { throw new Error('브라우저 체험 데이터가 손상되었습니다. 설정에서 체험 데이터를 초기화해 주세요.') } } const seed = createSeed(); localStorage.setItem(STORAGE_KEY, JSON.stringify(seed)); return seed }
function persist(workspace: Workspace) { localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace)); window.dispatchEvent(new Event('sig-workspace-change')) }
async function locked<T>(fn: () => T | Promise<T>): Promise<T> { if (!navigator.locks) throw new Error('안전한 동시 저장을 위해 최신 Chrome, Edge 또는 Safari를 사용해 주세요.'); return navigator.locks.request('sig-workspace-write', fn) }
function check<T extends { error: unknown; data: unknown }>(result: T): T['data'] { if (result.error) throw result.error; return result.data }
export function cloudStyle(row: Record<string, unknown>): Style { return { ...(row.data as Style), id: String(row.id), version: Number(row.version), updatedAt: String(row.updated_at), updatedBy: String(row.updated_by), deletedAt: row.deleted_at as string | null } }
function cloudProfile(row: Record<string, unknown>): Profile { return { id: String(row.id), name: String(row.name), email: String(row.email), role: row.role as Profile['role'], approved: !!row.approved, active: !!row.active, factoryId: row.factory_id as string | null } }
export async function loadWorkspace(): Promise<Workspace> {
  if (!supabase) return getDemoWorkspace()
  const tables = ['styles', 'profiles', 'factories', 'projects', 'comments', 'attachments', 'audits'] as const
  const results = await Promise.all(tables.map(async table => {
    const rows: Record<string, any>[] = []
    for (let from = 0; ; from += 500) {
      const result = await supabase!.from(table).select('*').order('id').range(from, from + 499)
      check(result); const page = result.data || []; rows.push(...page)
      if (page.length < 500) return rows
    }
  }))
  const rows = Object.fromEntries(tables.map((t, i) => [t, results[i]]))
  const owners = await supabase.rpc('visible_style_owners')
  check(owners)
  for (const owner of owners.data || []) if (!rows.profiles.some(p => p.id === owner.id)) rows.profiles.push({ ...owner, email: '', approved: true, active: true, factory_id: null })
  return {
    styles: rows.styles.filter(r => !r.deleted_at).map(cloudStyle), profiles: rows.profiles.map(cloudProfile), factories: rows.factories as Factory[], projects: rows.projects as Project[],
    comments: rows.comments.map(r => ({ id: r.id, styleId: r.style_id, sampleId: r.sample_id, authorId: r.author_id, authorName: r.author_name, body: r.body, createdAt: r.created_at })),
    attachments: rows.attachments.map(r => ({ id: r.id, styleId: r.style_id, sampleId: r.sample_id, name: r.name, path: r.path, mime: r.mime, size: r.size, uploadedBy: r.uploaded_by, createdAt: r.created_at })),
    audits: rows.audits.map(r => ({ id: r.id, styleId: r.style_id, actorId: r.actor_id, actorName: r.actor_name, action: r.action, reason: r.reason, before: r.before, after: r.after, createdAt: r.created_at })),
  }
}
export async function saveStyle(style: Style, reason: string, profile: Profile) {
  if (supabase) { check(await supabase.rpc('save_style', { p_id: style.id, p_data: style, p_expected_version: style.version, p_reason: reason })); return }
  await locked(() => { const w = getDemoWorkspace(), before = w.styles.find(s => s.id === style.id); if ((before?.version || 0) !== style.version) throw new Error('version conflict'); assertStyleSave(profile, before, style, reason)
    if (w.styles.some(s => s.id !== style.id && !s.deletedAt && s.code.toLowerCase() === style.code.toLowerCase())) throw new Error('같은 스타일 코드가 이미 있습니다.')
    const now = new Date().toISOString()
    const samples = style.samples.map(sample => { const old = before?.samples.find(s => s.id === sample.id); const changed = !old || JSON.stringify({ ...old, updatedAt: '' }) !== JSON.stringify({ ...sample, updatedAt: '' }); return { ...sample, updatedAt: changed ? now : old!.updatedAt } })
    const after = { ...structuredClone(style), samples, version: style.version + 1, updatedAt: now, updatedBy: profile.id, deletedAt: null }
    if (before) w.styles = w.styles.map(s => s.id === style.id ? after : s); else w.styles.unshift(after)
    w.audits.unshift({ id: crypto.randomUUID(), styleId: style.id, actorId: profile.id, actorName: profile.name, action: before ? '스타일 수정' : '스타일 등록', reason, before: before || null, after, createdAt: after.updatedAt }); persist(w)
  })
}
export async function deleteStyle(style: Style, reason: string, profile: Profile) {
  if (supabase) { check(await supabase.rpc('soft_delete_style', { p_id: style.id, p_expected_version: style.version, p_reason: reason })); return }
  await locked(() => { assertActive(profile); if (profile.role !== 'admin') throw new Error('관리자만 삭제할 수 있습니다.'); if (reason.trim().length < 2) throw new Error('삭제 사유를 두 글자 이상 입력해 주세요.'); const w = getDemoWorkspace(), old = w.styles.find(s => s.id === style.id); if (!old || old.version !== style.version) throw new Error('version conflict'); const after = { ...old, deletedAt: new Date().toISOString(), version: old.version + 1 }; w.styles = w.styles.map(s => s.id === style.id ? after : s); w.audits.unshift({ id: crypto.randomUUID(), styleId: style.id, actorId: profile.id, actorName: profile.name, action: '스타일 삭제(보존)', reason, before: old, after, createdAt: new Date().toISOString() }); persist(w) })
}
export async function saveProfile(target: Profile, profile: Profile) {
  if (supabase) { check(await supabase.rpc('manage_profile', { p_id: target.id, p_name: target.name, p_role: target.role, p_approved: target.approved, p_active: target.active, p_factory_id: target.factoryId })); return }
  await locked(() => { assertActive(profile); if (profile.role !== 'admin') throw new Error('관리자만 계정을 관리할 수 있습니다.'); if (target.id === profile.id && (!target.active || !target.approved || target.role !== 'admin')) throw new Error('본인의 관리자 권한은 해제할 수 없습니다.'); if (target.role === 'factory' && target.approved && !target.factoryId) throw new Error('공장을 지정해 주세요.'); const w = getDemoWorkspace(), before = w.profiles.find(p => p.id === target.id); w.profiles = before ? w.profiles.map(p => p.id === target.id ? target : p) : [...w.profiles, target]; w.audits.unshift({ id: crypto.randomUUID(), styleId: null, actorId: profile.id, actorName: profile.name, action: '사용자 권한 변경', reason: '관리자 계정 관리', before, after: target, createdAt: new Date().toISOString() }); persist(w) })
}
export async function saveMetadata<T extends Factory | Project>(table: 'factories' | 'projects', target: T, profile: Profile) {
  if (supabase) { check(await supabase.from(table).upsert(target)); return }
  await locked(() => { assertActive(profile); if (profile.role !== 'admin') throw new Error('관리자만 설정할 수 있습니다.'); const w = getDemoWorkspace(); if (table === 'factories') w.factories = w.factories.some(f => f.id === target.id) ? w.factories.map(f => f.id === target.id ? target as Factory : f) : [...w.factories, target as Factory]; else w.projects = w.projects.some(p => p.id === target.id) ? w.projects.map(p => p.id === target.id ? target as Project : p) : [...w.projects, target as Project]; persist(w) })
}
export async function addComment(styleId: string, body: string, profile: Profile, sampleId?: string) {
  if (!body.trim() || body.length > 5000) throw new Error('코멘트를 1~5,000자로 입력해 주세요.')
  if (supabase) { check(await supabase.from('comments').insert({ style_id: styleId, sample_id: sampleId || null, body: body.trim(), author_id: profile.id, author_name: profile.name })); return }
  await locked(() => { assertActive(profile); const w = getDemoWorkspace(), s = w.styles.find(s => s.id === styleId); if (!s || !canViewStyle(profile, s)) throw new Error('접근할 수 없습니다.'); if (sampleId && !s.samples.some(sample => sample.id === sampleId)) throw new Error('샘플 차수를 먼저 저장해 주세요.'); w.comments.push({ id: crypto.randomUUID(), styleId, sampleId: sampleId || null, body: body.trim(), authorId: profile.id, authorName: profile.name, createdAt: new Date().toISOString() }); persist(w) })
}
const messageForUpload = (error: { message: string }) => error.message
const MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
async function blobDb(): Promise<IDBDatabase> { return new Promise((resolve, reject) => { const request = indexedDB.open('sig-demo-files', 1); request.onupgradeneeded = () => request.result.createObjectStore('files'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) }) }
async function putBlob(path: string, file: File) { const db = await blobDb(); try { await new Promise<void>((resolve, reject) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put(file, path); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) }) } finally { db.close() } }
export async function uploadFile(styleId: string, file: File, profile: Profile, sampleId?: string) {
  if (!MIME.includes(file.type) || file.size <= 0 || file.size > 10 * 1024 * 1024) throw new Error('JPG·PNG·WEBP·PDF 파일만 10MB까지 첨부할 수 있습니다.')
  const path = `${styleId}/${crypto.randomUUID()}.${file.type === 'application/pdf' ? 'pdf' : file.type.split('/')[1]}`
  if (supabase) { check(await supabase.storage.from('sig-files').upload(path, file, { contentType: file.type, upsert: false })); const result = await supabase.from('attachments').insert({ style_id: styleId, sample_id: sampleId || null, name: file.name, path, mime: file.type, size: file.size, uploaded_by: profile.id }); if (result.error) { throw new Error(`파일은 업로드되었지만 목록 등록에 실패했습니다. 다시 첨부하기 전에 관리자에게 저장소 정리를 요청해 주세요. ${messageForUpload(result.error)}`) }; return }
  await locked(async () => { assertActive(profile); const w = getDemoWorkspace(), s = w.styles.find(s => s.id === styleId); if (!s || !canViewStyle(profile, s)) throw new Error('접근할 수 없습니다.'); if (sampleId && !s.samples.some(sample => sample.id === sampleId)) throw new Error('샘플 차수를 먼저 저장해 주세요.'); await putBlob(path, file); w.attachments.push({ id: crypto.randomUUID(), styleId, sampleId: sampleId || null, name: file.name, path, mime: file.type, size: file.size, uploadedBy: profile.id, createdAt: new Date().toISOString() }); persist(w) })
}
export async function downloadFile(attachment: Attachment) {
  let blob: Blob
  if (supabase) { const { data, error } = await supabase.storage.from('sig-files').download(attachment.path); if (error) throw error; blob = data }
  else { const db = await blobDb(); try { blob = await new Promise<Blob>((resolve, reject) => { const req = db.transaction('files').objectStore('files').get(attachment.path); req.onsuccess = () => req.result ? resolve(req.result) : reject(new Error('이 브라우저에 첨부파일이 없습니다.')); req.onerror = () => reject(req.error) }) } finally { db.close() } }
  const href = URL.createObjectURL(blob), a = document.createElement('a'); a.href = href; a.download = attachment.name; a.click(); setTimeout(() => URL.revokeObjectURL(href), 10000)
}
export async function resetDemo() { if (supabase) throw new Error('실제 데이터는 초기화할 수 없습니다.'); await locked(() => persist(createSeed())) }
