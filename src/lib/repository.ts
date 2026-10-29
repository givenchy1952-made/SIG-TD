import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Attachment, Profile, Style, Workspace, Factory, Project, StyleImage } from './types'
import { createSeed } from './seed'
import { assertActive, assertStyleSave, canViewStyle } from './permissions'
import { STYLE_IMAGE_MIME } from './style-images'
import { resolveSupabaseConfiguration } from './configuration'
import { readAuthCallbackError } from './auth-flow'
import { assertManagedShipmentTotals, freshOperations } from './operations-domain'
import { createDefaultOperationCatalogs } from './default-operation-catalogs'
import { loadOperationsWorkspace } from './operations-cloud'
import { loadSettlementTermsWorkspace } from './settlement-cloud'
import { loadWorkflowRefinements } from './workflow-repository'
import { manageProfileInWorkspace } from './staff-approval'
import { loadProductionLedgerWorkspace } from './production-ledger-repository'
import { loadSupplierProductionOrders } from './supplier-orders-repository'
import { getDemoSupplierProductionOrders } from './supplier-orders'
import { assertProductionLedgerTotals } from './production-ledger'
import { loadMemberWithdrawalCapability } from './member-withdrawal-repository'
import { loadProcessingUnitPrices } from './processing-prices-repository'
import { loadProductionConditions } from './production-conditions-repository'
import { getDemoProductionConditions } from './production-conditions'
import { loadProductionPoLinks } from './production-po-links-repository'
import { loadPartialDeliveryPlans } from './partial-deliveries-repository'
export const demoAllowed = import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO === 'true' || ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
// Capture before the SDK consumes/removes the callback hash during startup.
export const authCallbackError = readAuthCallbackError(window.location.href)
const config = resolveSupabaseConfiguration(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY)
const { url, key } = config
let configurationError = config.error
let supabase: SupabaseClient | null = null
if (url && key && !configurationError) { try { supabase = createClient(url, key) } catch { configurationError = 'Supabase 연결 정보를 초기화할 수 없습니다. URL과 공개 키 형식을 확인해 주세요.' } }
export { configurationError, supabase }
const STORAGE_KEY = 'sig-workspace-demo-v1'
function withProductionDefaults(workspace: Workspace): Workspace {
  const next = { ...workspace, processingUnitPrices: workspace.processingUnitPrices || [], processingPricesAvailable: true, importColorOwnersAvailable: true, memberWithdrawalAvailable: true, partialDeliveryPlans: workspace.partialDeliveryPlans || [], partialDeliveryAvailable: true, productionRuns: workspace.productionRuns || [], productionReceipts: workspace.productionReceipts || [], productionRunAudits: workspace.productionRunAudits || [], productionLedgerAvailable: true, supplierOrdersAvailable: true }
  const withOrders = { ...next, productionPoContexts: workspace.productionPoContexts || [], productionPoLinksAvailable: true, supplierProductionOrders: getDemoSupplierProductionOrders(next) }
  return { ...withOrders, productionConditions: getDemoProductionConditions(withOrders), productionConditionsAvailable: true }
}
export function getDemoWorkspace(): Workspace { const raw = localStorage.getItem(STORAGE_KEY); if (raw) { try { const parsed = JSON.parse(raw); if (parsed.styles && parsed.profiles && parsed.factories && parsed.projects && parsed.comments && parsed.attachments && parsed.audits) { const operations = freshOperations(parsed.operations); if (!parsed.operations?.operationCatalogs) operations.operationCatalogs = createDefaultOperationCatalogs(); return withProductionDefaults({ ...parsed, staffApprovalsAvailable: true, settlementTerms: parsed.settlementTerms || [], settlementTermsAudits: parsed.settlementTermsAudits || [], settlementTermsAvailable: true, productionDetails: parsed.productionDetails || [], refinementsAvailable: true, styleImages: parsed.styleImages || [], styleImagesAvailable: true, operations, operationsAvailable: true }) } } catch { throw new Error('브라우저 체험 데이터가 손상되었습니다. 설정에서 체험 데이터를 초기화해 주세요.') } } const operations = freshOperations(); operations.operationCatalogs = createDefaultOperationCatalogs(); const seed = withProductionDefaults({ ...createSeed(), staffApprovalsAvailable: true, productionDetails: [], refinementsAvailable: true, settlementTerms: [], settlementTermsAudits: [], settlementTermsAvailable: true, styleImages: [], styleImagesAvailable: true, operations, operationsAvailable: true }); localStorage.setItem(STORAGE_KEY, JSON.stringify(seed)); return seed }
export function persist(workspace: Workspace) { localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace)); window.dispatchEvent(new Event('sig-workspace-change')) }
export async function locked<T>(fn: () => T | Promise<T>): Promise<T> { if (!navigator.locks) throw new Error('안전한 동시 저장을 위해 최신 Chrome, Edge 또는 Safari를 사용해 주세요.'); return navigator.locks.request('sig-workspace-write', fn) }
function check<T extends { error: unknown; data: unknown }>(result: T): T['data'] { if (result.error) throw result.error; return result.data }
export function cloudStyle(row: Record<string, unknown>): Style { return { ...(row.data as Style), id: String(row.id), version: Number(row.version), updatedAt: String(row.updated_at), updatedBy: String(row.updated_by), deletedAt: row.deleted_at as string | null } }
function cloudProfile(row: Record<string, unknown>): Profile { return { id: String(row.id), name: String(row.name), email: String(row.email), role: row.role as Profile['role'], approved: !!row.approved, active: !!row.active, factoryId: row.factory_id as string | null, ...('withdrawn_at' in row ? { withdrawnAt: row.withdrawn_at as string | null, withdrawnBy: row.withdrawn_by as string | null } : {}) } }
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
  const styleImages: StyleImage[] = []
  let styleImagesAvailable = true
  for (let from = 0; ; from += 500) {
    const result = await supabase.from('style_images').select('*').order('style_id').order('color').range(from, from + 499)
    if (result.error && ['PGRST205', '42P01'].includes(result.error.code)) { styleImagesAvailable = false; break }
    check(result)
    const page = result.data || []
    styleImages.push(...page.map(r => ({ styleId: r.style_id, color: r.color, attachmentId: r.attachment_id, version: r.version, updatedAt: r.updated_at, updatedBy: r.updated_by })))
    if (page.length < 500) break
  }
  const [operations, settlement, workflow, approvals, productionLedger, supplierOrders, memberWithdrawalAvailable, importColorOwners, processingPrices, productionConditions, productionPoLinks, partialDeliveryPlans] = await Promise.all([loadOperationsWorkspace(supabase), loadSettlementTermsWorkspace(supabase), loadWorkflowRefinements(supabase), supabase.rpc('get_staff_approvals_capability'), loadProductionLedgerWorkspace(supabase), loadSupplierProductionOrders(supabase), loadMemberWithdrawalCapability(supabase), supabase.rpc('get_import_color_owners_capability'), loadProcessingUnitPrices(supabase), loadProductionConditions(supabase), loadProductionPoLinks(supabase), loadPartialDeliveryPlans(supabase)])
  if (approvals.error && !['PGRST202', '42883'].includes(approvals.error.code)) throw approvals.error
  if (importColorOwners.error && !['PGRST202', '42883'].includes(importColorOwners.error.code)) throw importColorOwners.error
  return {
    ...operations, ...settlement, ...workflow, ...productionLedger, ...supplierOrders, ...processingPrices, ...productionConditions, ...productionPoLinks, ...partialDeliveryPlans,
    styleImages, styleImagesAvailable, memberWithdrawalAvailable, importColorOwnersAvailable: !importColorOwners.error && importColorOwners.data === true, staffApprovalsAvailable: !approvals.error && approvals.data === true,
    styles: rows.styles.filter(r => !r.deleted_at).map(cloudStyle), profiles: rows.profiles.map(cloudProfile), factories: rows.factories as Factory[], projects: rows.projects as Project[],
    comments: rows.comments.map(r => ({ id: r.id, styleId: r.style_id, sampleId: r.sample_id, authorId: r.author_id, authorName: r.author_name, body: r.body, createdAt: r.created_at })),
    attachments: rows.attachments.map(r => ({ id: r.id, styleId: r.style_id, sampleId: r.sample_id, name: r.name, path: r.path, mime: r.mime, size: r.size, uploadedBy: r.uploaded_by, createdAt: r.created_at })),
    audits: rows.audits.map(r => ({ id: r.id, styleId: r.style_id, actorId: r.actor_id, actorName: r.actor_name, action: r.action, reason: r.reason, before: r.before, after: r.after, createdAt: r.created_at })),
  }
}
export async function saveStyle(style: Style, reason: string, profile: Profile) {
  if (supabase) { check(await supabase.rpc('save_style', { p_id: style.id, p_data: style, p_expected_version: style.version, p_reason: reason })); return }
  await locked(() => { const w = getDemoWorkspace(), before = w.styles.find(s => s.id === style.id); if ((before?.version || 0) !== style.version) throw new Error('version conflict'); assertManagedShipmentTotals(w, style); assertProductionLedgerTotals(w, style); assertStyleSave(profile, before, style, reason)
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
  await locked(() => persist(manageProfileInWorkspace(getDemoWorkspace(), profile, target)))
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
export async function uploadFile(styleId: string, file: File, profile: Profile, sampleId?: string): Promise<Attachment> {
  if (!MIME.includes(file.type) || file.size <= 0 || file.size > 10 * 1024 * 1024) throw new Error('JPG·PNG·WEBP·PDF 파일만 10MB까지 첨부할 수 있습니다.')
  const path = `${styleId}/${crypto.randomUUID()}.${file.type === 'application/pdf' ? 'pdf' : file.type.split('/')[1]}`
  if (supabase) {
    check(await supabase.storage.from('sig-files').upload(path, file, { contentType: file.type, upsert: false }))
    const result = await supabase.from('attachments').insert({ style_id: styleId, sample_id: sampleId || null, name: file.name, path, mime: file.type, size: file.size, uploaded_by: profile.id }).select('*').single()
    if (result.error) throw new Error(`파일은 업로드되었지만 목록 등록에 실패했습니다. 관리자에게 저장소 정리를 요청해 주세요. ${messageForUpload(result.error)}`)
    const r = result.data
    return { id: r.id, styleId: r.style_id, sampleId: r.sample_id, name: r.name, path: r.path, mime: r.mime, size: r.size, uploadedBy: r.uploaded_by, createdAt: r.created_at }
  }
  return locked(async () => {
    assertActive(profile)
    const w = getDemoWorkspace(), style = w.styles.find(s => s.id === styleId)
    if (!style || !canViewStyle(profile, style)) throw new Error('접근할 수 없습니다.')
    if (sampleId && !style.samples.some(sample => sample.id === sampleId)) throw new Error('샘플 차수를 먼저 저장해 주세요.')
    await putBlob(path, file)
    const attachment: Attachment = { id: crypto.randomUUID(), styleId, sampleId: sampleId || null, name: file.name, path, mime: file.type, size: file.size, uploadedBy: profile.id, createdAt: new Date().toISOString() }
    w.attachments.push(attachment); persist(w); return attachment
  })
}
export async function loadAttachmentBlob(attachment: Attachment): Promise<Blob> {
  if (supabase) { const { data, error } = await supabase.storage.from('sig-files').download(attachment.path); if (error) throw error; return data }
  const db = await blobDb()
  try { return await new Promise<Blob>((resolve, reject) => {
    const req = db.transaction('files').objectStore('files').get(attachment.path)
    req.onsuccess = () => req.result ? resolve(req.result) : reject(new Error('이 브라우저에 첨부파일이 없습니다.'))
    req.onerror = () => reject(req.error)
  }) } finally { db.close() }
}
export async function downloadFile(attachment: Attachment) {
  const blob = await loadAttachmentBlob(attachment)
  const href = URL.createObjectURL(blob), a = document.createElement('a'); a.href = href; a.download = attachment.name; a.click(); setTimeout(() => URL.revokeObjectURL(href), 10000)
}
export async function setStyleImage(styleId: string, color: string, attachmentId: string | null, expectedVersion: number, reason: string, profile: Profile) {
  assertActive(profile)
  if (profile.role === 'factory') throw new Error('대표 이미지는 관리자·본사 직원만 변경할 수 있습니다.')
  if (reason.trim().length < 2 || reason.trim().length > 1000) throw new Error('이미지 변경 사유를 2~1,000자로 입력해 주세요.')
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new Error('이미지 버전을 확인해 주세요.')
  if (supabase) {
    const result = await supabase.rpc('set_style_image', { p_style_id: styleId, p_color: color, p_attachment_id: attachmentId, p_expected_version: expectedVersion, p_reason: reason.trim() })
    if (result.error && ['PGRST202', 'PGRST205', '42P01'].includes(result.error.code)) throw new Error('대표 이미지 기능 설정이 필요합니다. Supabase에서 002_style_images.sql을 적용해 주세요.')
    check(result); return
  }
  await locked(() => {
    const w = getDemoWorkspace(), style = w.styles.find(s => s.id === styleId)
    if (!style || !canViewStyle(profile, style)) throw new Error('접근할 수 없습니다.')
    if (color !== '' && !style.colors.includes(color)) throw new Error('먼저 저장된 컬러를 선택해 주세요.')
    const before = w.styleImages?.find(i => i.styleId === styleId && i.color === color)
    if ((before?.version || 0) !== expectedVersion) throw new Error('image version conflict')
    if (attachmentId) {
      const file = w.attachments.find(a => a.id === attachmentId)
      if (!file || file.styleId !== styleId || file.sampleId !== null || !STYLE_IMAGE_MIME.some(m => m === file.mime)) throw new Error('이 스타일에 첨부한 JPG·PNG·WEBP 사진만 대표 이미지로 지정할 수 있습니다.')
    }
    const after: StyleImage = { styleId, color, attachmentId, version: expectedVersion + 1, updatedAt: new Date().toISOString(), updatedBy: profile.id }
    w.styleImages = [...(w.styleImages || []).filter(i => i.styleId !== styleId || i.color !== color), after]
    w.audits.unshift({ id: crypto.randomUUID(), styleId, actorId: profile.id, actorName: profile.name, action: attachmentId ? before?.attachmentId ? '대표 이미지 변경' : '대표 이미지 등록' : '대표 이미지 해제', reason: reason.trim(), before: before || null, after, createdAt: after.updatedAt })
    persist(w)
  })
}
export async function uploadStyleImage(styleId: string, color: string, file: File, expectedVersion: number, reason: string, profile: Profile) {
  assertActive(profile)
  if (profile.role === 'factory') throw new Error('대표 이미지는 관리자·본사 직원만 변경할 수 있습니다.')
  if (!STYLE_IMAGE_MIME.some(m => m === file.type) || file.size <= 0 || file.size > 10 * 1024 * 1024) throw new Error('대표 이미지는 10MB 이하의 PNG·WEBP·JPG 파일을 선택해 주세요.')
  if (reason.trim().length < 2 || reason.trim().length > 1000) throw new Error('이미지 변경 사유를 2~1,000자로 입력해 주세요.')
  let image: ImageBitmap
  try { image = await createImageBitmap(file) } catch { throw new Error('이미지 파일을 읽을 수 없습니다. PNG·WEBP·JPG 파일을 확인해 주세요.') }
  image.close()
  // Files are immutable. A stale image selection keeps the uploaded file in the
  // attachment list, where the user can select it after reviewing the conflict.
  const attachment = await uploadFile(styleId, file, profile)
  await setStyleImage(styleId, color, attachment.id, expectedVersion, reason, profile)
}
export async function resetDemo() { if (supabase) throw new Error('실제 데이터는 초기화할 수 없습니다.'); await locked(() => persist(createSeed())) }
