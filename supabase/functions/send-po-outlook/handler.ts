/** Microsoft Graph PO sender. The two access tokens are request-local only.
 * Supabase Auth verifies the application user; Graph /me verifies the mailbox.
 * A Graph 202/request-id is an acceptance receipt, never an email message ID.
 */
import type { PoAttachmentRecord, PoDispatchRecord, PoEmailError, PoEmailResult } from '../send-po-email/handler.ts'

export interface OutlookDispatchRecord extends PoDispatchRecord {
  provider?: string
  sender_email_snapshot?: string | null
  provider_request_id?: string | null
}
export interface OutlookProfile { id: string; email: string; role: string; approved: boolean; active: boolean }
export interface OutlookConfiguration { clientId: string; tenantId: string }
export interface OutlookUserClient {
  getUser(): Promise<PoEmailResult<{ id: string }>>
  getProfile(id: string): Promise<PoEmailResult<OutlookProfile>>
  getConfiguration(): Promise<PoEmailResult<OutlookConfiguration>>
  getDispatch(id: string): Promise<PoEmailResult<OutlookDispatchRecord>>
  getAttachment(id: string): Promise<PoEmailResult<PoAttachmentRecord>>
  downloadAttachment(path: string): Promise<PoEmailResult<Blob>>
  beginDispatch(id: string, expectedVersion: number): Promise<PoEmailResult<OutlookDispatchRecord>>
}
export interface OutlookFinalizeInput { id: string; requestId: string | null; error: string | null; outcome: 'sent' | 'failed' | 'unknown' }
export interface OutlookServiceClient { finalizeDispatch(input: OutlookFinalizeInput): Promise<PoEmailResult<OutlookDispatchRecord>> }
export interface OutlookDependencies {
  env(name: string): string | undefined
  createUserClient(url: string, anonKey: string, bearerToken: string): OutlookUserClient
  createServiceClient(url: string, serviceRoleKey: string): OutlookServiceClient
  verifyIdentityToken(token: string, configuration: OutlookConfiguration): Promise<{ tenantId: string; objectId: string }>
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

const MAX_FILE = 2 * 1024 * 1024
const MAX_BODY = 65536
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
const email = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/u.test(value)
const sameEmail = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase()
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
function validRecord(row: OutlookDispatchRecord | null, id: string): row is OutlookDispatchRecord {
  return !!row && row.id === id && UUID.test(row.style_id) && validDate(row.due_date) && email(row.recipient)
    && typeof row.subject === 'string' && row.subject.trim().length > 0 && row.subject.length <= 500 && !/[\r\n\x00]/.test(row.subject)
    && typeof row.body === 'string' && row.body.trim().length > 0 && row.body.length <= 20000
    && typeof row.style_code_snapshot === 'string' && row.style_code_snapshot.trim().length > 0 && !/[\r\n\x00]/.test(row.style_code_snapshot)
    && typeof row.idempotency_key === 'string' && /^[a-z0-9_-]{1,256}$/i.test(row.idempotency_key)
    && (row.evidence_attachment_id === null || UUID.test(row.evidence_attachment_id))
    && Number.isInteger(row.version) && row.version > 0 && Number.isInteger(row.attempts) && row.attempts >= 0 && row.voided === false
}
function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}
function databaseFailure(error: PoEmailError | null) {
  if (error?.code === '42501') return { status: 403, code: 'FORBIDDEN', message: '승인된 본사 계정만 PO를 발송할 수 있습니다.' }
  if (error?.code === '40001') return { status: 409, code: 'VERSION_CONFLICT', message: '다른 사용자가 먼저 수정했습니다. 최신 PO를 다시 확인해 주세요.' }
  if (/PO_ASSIGNMENT_CHANGED/.test(error?.message || '')) return { status: 409, code: 'PO_ASSIGNMENT_CHANGED', message: '담당 공장 또는 품번이 변경되었습니다. 초안을 검토해 주세요.' }
  if (/PO_PROVIDER_MISMATCH/.test(error?.message || '')) return { status: 409, code: 'PO_PROVIDER_MISMATCH', message: '이전에 사용한 메일 발송 방식이 다릅니다. 새 PO로 작성해 주세요.' }
  if (/PO_SENDER_MISMATCH/.test(error?.message || '')) return { status: 409, code: 'PO_SENDER_CHANGED', message: '이 PO를 처음 발송한 담당자의 Outlook으로 다시 확인하거나 새 PO로 작성해 주세요.' }
  if (/PO_SEND_BLOCKED|HISTORY_PROTECTED/.test(error?.message || '')) return { status: 409, code: 'PO_SEND_BLOCKED', message: '이미 처리 중이거나 결과 확인이 필요한 PO입니다. 발송 이력을 확인해 주세요.' }
  return { status: 503, code: 'DATABASE_UNAVAILABLE', message: 'PO 발송 기록을 확인할 수 없습니다. 발송 이력을 먼저 확인해 주세요.' }
}

/** No redirect or automatic retry may forward a bearer token or duplicate mail. */
async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('provider timeout')) }, timeoutMs) })
    return await Promise.race([operation(controller.signal), deadline])
  } finally { if (timer) clearTimeout(timer) }
}
async function timedFetch(sendFetch: typeof globalThis.fetch, url: string, init: RequestInit, timeoutMs: number) {
  return await withDeadline(signal => sendFetch(url, { ...init, redirect: 'error', signal }), timeoutMs)
}

export function createOutlookPoHandler(dependencies: OutlookDependencies): (request: Request) => Promise<Response> {
  const sendFetch = dependencies.fetch ?? globalThis.fetch
  const timeoutMs = dependencies.timeoutMs ?? 12000
  return async request => {
    const origin = request.headers.get('origin')
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'Origin' }
    const respond = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
    const origins = (dependencies.env('PO_ALLOWED_ORIGINS') || '').split(',').map(value => value.trim()).filter(Boolean)
    const validOrigins = origins.length > 0 && origins.every(value => {
      try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && url.origin === value && !url.username && !url.password } catch { return false }
    })
    if (!validOrigins) return respond(503, { code: 'CONFIGURATION_REQUIRED', message: '메일 서버의 PO_ALLOWED_ORIGINS 설정이 필요합니다.' })
    if (!origin || !origins.includes(origin)) return respond(403, { code: 'ORIGIN_FORBIDDEN', message: '허용되지 않은 접속 주소입니다.' })
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-methods'] = 'POST, OPTIONS'
    headers['access-control-allow-headers'] = 'authorization, apikey, content-type, x-client-info'
    headers['access-control-max-age'] = '600'
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return respond(405, { code: 'METHOD_NOT_ALLOWED', message: 'POST 요청만 지원합니다.' })
    const environment = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].map(name => [name, dependencies.env(name)?.trim() || '']))
    if (Object.values(environment).some(value => !value)) return respond(503, { code: 'CONFIGURATION_REQUIRED', message: '메일 서버의 Supabase 연결 설정이 필요합니다.' })
    const appToken = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1]
    if (!appToken) return respond(403, { code: 'AUTH_REQUIRED', message: '로그인 후 다시 시도해 주세요.' })

    let user: OutlookUserClient, actor: OutlookProfile
    try {
      user = dependencies.createUserClient(environment.SUPABASE_URL, environment.SUPABASE_ANON_KEY, appToken)
      const authenticated = await user.getUser()
      if (authenticated.error || !authenticated.data?.id) return respond(403, { code: 'AUTH_REQUIRED', message: '로그인이 만료되었거나 계정을 확인할 수 없습니다.' })
      const profile = await user.getProfile(authenticated.data.id)
      if (profile.error || !profile.data || profile.data.id !== authenticated.data.id || !profile.data.approved || !profile.data.active || !['admin', 'internal'].includes(profile.data.role) || !email(profile.data.email)) return respond(403, { code: 'FORBIDDEN', message: '승인된 본사 계정만 PO를 발송할 수 있습니다.' })
      actor = profile.data
    } catch { return respond(503, { code: 'AUTH_UNAVAILABLE', message: '로그인 확인 서버에 연결할 수 없습니다.' }) }

    let input: { id: string; expectedVersion: number; outlookAccessToken: string; outlookIdToken: string }
    try {
      const text = await request.text()
      if (text.length > MAX_BODY) throw new Error('size')
      const value: unknown = JSON.parse(text)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape')
      const record = value as Record<string, unknown>
      if (Object.keys(record).length !== 4 || !('id' in record) || !('expectedVersion' in record) || !('outlookAccessToken' in record) || !('outlookIdToken' in record)
        || typeof record.id !== 'string' || !UUID.test(record.id) || !Number.isInteger(record.expectedVersion) || Number(record.expectedVersion) < 1 || Number(record.expectedVersion) > 2147483647
        || typeof record.outlookAccessToken !== 'string' || record.outlookAccessToken.length < 1 || record.outlookAccessToken.length > 24576 || /[\s\x00-\x1f\x7f]/.test(record.outlookAccessToken)
        || typeof record.outlookIdToken !== 'string' || record.outlookIdToken.length < 1 || record.outlookIdToken.length > 24576 || /[\s\x00-\x1f\x7f]/.test(record.outlookIdToken)) throw new Error('shape')
      input = { id: record.id, expectedVersion: Number(record.expectedVersion), outlookAccessToken: record.outlookAccessToken, outlookIdToken: record.outlookIdToken }
    } catch { return respond(400, { code: 'INVALID_REQUEST', message: 'PO ID·현재 버전과 Outlook 로그인 확인값을 전달해 주세요.' }) }

    let configuration: OutlookConfiguration
    try {
      const result = await user.getConfiguration()
      if (result.error || !result.data || !UUID.test(result.data.clientId) || !UUID.test(result.data.tenantId)) return respond(503, { code: 'OUTLOOK_CONFIGURATION_REQUIRED', message: '관리자가 Microsoft 365 연결 설정을 먼저 저장해야 합니다.' })
      configuration = result.data
    } catch { return respond(503, { code: 'OUTLOOK_CONFIGURATION_REQUIRED', message: 'Microsoft 365 연결 설정을 확인할 수 없습니다.' }) }

    let identity: { tenantId: string; objectId: string }
    try {
      identity = await dependencies.verifyIdentityToken(input.outlookIdToken, configuration)
      if (!UUID.test(identity.tenantId) || !UUID.test(identity.objectId) || identity.tenantId.toLowerCase() !== configuration.tenantId.toLowerCase()) throw new Error('identity mismatch')
    } catch { return respond(403, { code: 'OUTLOOK_AUTH_REQUIRED', message: '등록된 회사의 Microsoft 계정 인증을 확인할 수 없습니다. Outlook을 다시 연결해 주세요.' }) }

    // Graph validates its opaque access token. Only the application's own verified
    // email may send; the browser cannot choose a From address or another mailbox.
    try {
      const graphIdentity = await withDeadline(async signal => {
        const response = await sendFetch('https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName', { method: 'GET', redirect: 'error', signal, headers: { authorization: `Bearer ${input.outlookAccessToken}` } })
        return { response, mailbox: response.ok ? await response.json() as unknown : null }
      }, timeoutMs)
      const response = graphIdentity.response
      if (response.status === 401 || response.status === 403) return respond(403, { code: 'OUTLOOK_AUTH_REQUIRED', message: 'Outlook을 다시 연결하고 메일 발송 권한을 승인해 주세요.' })
      if (!response.ok) return respond(503, { code: 'OUTLOOK_UNAVAILABLE', message: 'Outlook 계정을 확인할 수 없습니다. 잠시 후 다시 연결해 주세요.' })
      const mailbox = graphIdentity.mailbox
      if (!mailbox || typeof mailbox !== 'object' || !('id' in mailbox) || typeof mailbox.id !== 'string' || !mailbox.id.trim()) return respond(403, { code: 'OUTLOOK_ACCOUNT_MISMATCH', message: '사이트에 등록한 본인 회사 이메일로 Outlook을 연결해 주세요.' })
      const record = mailbox as Record<string, unknown>
      if (typeof record.id !== 'string' || record.id.toLowerCase() !== identity.objectId.toLowerCase()) return respond(403, { code: 'OUTLOOK_ACCOUNT_MISMATCH', message: 'Microsoft 로그인 계정과 발송 메일함이 다릅니다. Outlook을 다시 연결해 주세요.' })
      const mailboxEmail = email(record.mail) ? record.mail : email(record.userPrincipalName) ? record.userPrincipalName : null
      if (!mailboxEmail || !sameEmail(mailboxEmail, actor.email)) return respond(403, { code: 'OUTLOOK_ACCOUNT_MISMATCH', message: '사이트에 등록한 본인 회사 이메일로 Outlook을 연결해 주세요.' })
    } catch { return respond(503, { code: 'OUTLOOK_UNAVAILABLE', message: 'Outlook 계정을 확인할 수 없습니다. 발송 시도는 시작하지 않았습니다.' }) }

    let before: OutlookDispatchRecord
    let attachments: { '@odata.type': string; name: string; contentType: string; contentBytes: string }[] | undefined
    try {
      const selected = await user.getDispatch(input.id)
      if (selected.error || !selected.data) return respond(403, { code: 'FORBIDDEN', message: '접근할 수 있는 PO를 찾을 수 없습니다.' })
      if (!validRecord(selected.data, input.id)) return respond(422, { code: 'INVALID_PO', message: 'PO의 납기일·수신자·제목·본문을 확인해 주세요.' })
      before = selected.data
      if (before.version !== input.expectedVersion) return respond(409, { code: 'VERSION_CONFLICT', message: 'PO가 변경되었습니다. 최신 내용을 확인해 주세요.' })
      if (!['draft', 'failed'].includes(before.status)) return respond(409, { code: 'PO_SEND_BLOCKED', message: '처리 중·접수 완료·결과 미확인 PO는 자동 재발송할 수 없습니다.' })
      if (before.attempts > 0 && before.provider !== 'outlook') return respond(409, { code: 'PO_PROVIDER_MISMATCH', message: '이전에 사용한 메일 발송 방식이 다릅니다. 새 PO로 작성해 주세요.' })
      if (before.attempts > 0 && before.sender_email_snapshot && !sameEmail(before.sender_email_snapshot, actor.email)) return respond(409, { code: 'PO_SENDER_CHANGED', message: '이 PO를 처음 발송한 담당자의 Outlook으로 다시 확인하거나 새 PO로 작성해 주세요.' })
      if (before.evidence_attachment_id) {
        const result = await user.getAttachment(before.evidence_attachment_id), file = result.data
        if (result.error || !file || file.id !== before.evidence_attachment_id || file.style_id !== before.style_id || typeof file.path !== 'string' || !file.path.startsWith(`${before.style_id}/`) || !MIMES.has(file.mime) || !Number.isInteger(file.size) || file.size < 1 || file.size > MAX_FILE) return respond(422, { code: 'INVALID_ATTACHMENT', message: '이 스타일의 PDF·이미지 첨부파일을 확인해 주세요. Outlook 첨부는 최대 2MB입니다.' })
        const downloaded = await user.downloadAttachment(file.path)
        if (downloaded.error || !downloaded.data || downloaded.data.size !== file.size || downloaded.data.size > MAX_FILE) return respond(422, { code: 'ATTACHMENT_UNAVAILABLE', message: '비공개 첨부파일을 읽을 수 없습니다. 발송 전에 파일을 확인해 주세요.' })
        attachments = [{ '@odata.type': '#microsoft.graph.fileAttachment', name: file.name.replace(/[\x00-\x1f\x7f]/g, '').replace(/[\\/]/g, '_').slice(0, 180) || 'PO_첨부파일', contentType: file.mime, contentBytes: base64(new Uint8Array(await downloaded.data.arrayBuffer())) }]
      }
    } catch { return respond(503, { code: 'PREFLIGHT_UNAVAILABLE', message: 'PO·첨부파일을 확인할 수 없습니다. 발송 시도는 시작하지 않았습니다.' }) }

    let claimed: OutlookDispatchRecord
    try {
      const result = await user.beginDispatch(input.id, input.expectedVersion)
      if (result.error) { const failure = databaseFailure(result.error); return respond(failure.status, { code: failure.code, message: failure.message }) }
      if (!result.data) return respond(503, { code: 'BEGIN_UNCERTAIN', message: '발송 요청 기록을 확인할 수 없습니다. 발송 이력을 먼저 확인해 주세요.' })
      claimed = result.data
    } catch { return respond(503, { code: 'BEGIN_UNCERTAIN', message: '발송 요청 기록을 확인할 수 없습니다. 발송 이력을 먼저 확인해 주세요.' }) }

    let outcome: OutlookFinalizeInput['outcome'] = 'unknown', requestId: string | null = null
    let providerError: string | null = 'Microsoft의 접수 결과를 확인하지 못했습니다. 보낸 편지함과 PO 발송 이력을 확인하고 자동 재발송하지 마세요.'
    const snapshotKeys = ['id', 'style_id', 'due_date', 'recipient', 'subject', 'body', 'evidence_attachment_id', 'idempotency_key', 'style_code_snapshot', 'factory_id_snapshot'] as const
    const snapshotMatches = validRecord(claimed, input.id) && claimed.status === 'sending' && claimed.provider === 'outlook'
      && claimed.version === input.expectedVersion + 1 && claimed.attempts === before.attempts + 1 && email(claimed.sender_email_snapshot) && sameEmail(claimed.sender_email_snapshot, actor.email)
      && snapshotKeys.every(key => claimed[key] === before[key])
    if (snapshotMatches) {
      try {
        const response = await timedFetch(sendFetch, 'https://graph.microsoft.com/v1.0/me/sendMail', {
          method: 'POST', headers: { authorization: `Bearer ${input.outlookAccessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ message: {
            subject: `[납기 ${claimed.due_date}] ${claimed.subject}`,
            body: { contentType: 'Text', content: `FIVE SPACE / SIG PO\n스타일: ${claimed.style_code_snapshot}\n기준 납기: ${claimed.due_date}\n\n${claimed.body}` },
            toRecipients: [{ emailAddress: { address: claimed.recipient } }],
            replyTo: [{ emailAddress: { address: actor.email } }],
            ...(attachments ? { attachments } : {}),
          }, saveToSentItems: true }),
        }, timeoutMs)
        if (response.status === 202) {
          const receipt = response.headers.get('request-id')
          if (receipt && UUID.test(receipt)) { outcome = 'sent'; requestId = receipt; providerError = null }
        } else if (response.status >= 400 && response.status < 500 && response.status !== 409) {
          outcome = 'failed'; providerError = `Microsoft가 발송 요청을 거절했습니다 (HTTP ${response.status}). Outlook 연결·권한과 메일함 상태를 확인해 주세요.`
        }
      } catch { /* An accepted mail may exist: never repeat the send request. */ }
    } else providerError = '저장된 발송 내용 또는 발신자 스냅샷이 달라 Microsoft에 보내지 않았습니다. 발송 이력을 확인해 주세요.'

    try {
      const service = dependencies.createServiceClient(environment.SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY)
      const finalized = await service.finalizeDispatch({ id: input.id, requestId, error: providerError, outcome })
      const row = finalized.data
      if (finalized.error || !row || row.id !== input.id || row.status !== outcome || row.provider !== 'outlook'
        || (outcome === 'sent' && (row.provider_request_id !== requestId || row.provider_message_id !== null || !row.sent_at))) throw new Error('finalize unavailable')
      if (outcome === 'sent') return respond(200, { status: 'sent', provider: 'outlook', providerRequestId: requestId, senderEmail: claimed.sender_email_snapshot, version: row.version, message: 'Microsoft가 PO를 접수했습니다. 실제 수신·열람을 보장하지는 않습니다.' })
      return respond(502, { code: outcome === 'failed' ? 'PROVIDER_REJECTED' : 'PROVIDER_RESULT_UNKNOWN', status: outcome, provider: 'outlook', version: row.version, message: providerError })
    } catch { return respond(503, { code: 'UNCERTAIN_SYNC_FAILURE', status: 'unknown', message: 'Microsoft 처리 결과의 저장 여부를 확인할 수 없습니다. 보낸 편지함과 PO 발송 이력을 확인하고 다시 보내지 마세요.' }) }
  }
}
