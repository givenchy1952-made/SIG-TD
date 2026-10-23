/** Server-only PO sender. Never import this module into the browser bundle.
 * JWT verification is performed by the Auth server on every POST; begin RPC
 * rechecks approved HQ privileges and atomically claims the database snapshot.
 */
export interface PoDispatchRecord {
  id: string; style_id: string; due_date: string; recipient: string; subject: string; body: string;
  evidence_attachment_id: string | null; status: string; version: number; voided: boolean;
  idempotency_key: string; style_code_snapshot: string; factory_id_snapshot: string;
  attempts: number; provider_message_id: string | null; sent_at: string | null;
}
export interface PoAttachmentRecord { id: string; style_id: string; path: string; name: string; mime: string; size: number }
export interface PoEmailError { code?: string; message?: string }
export interface PoEmailResult<T> { data: T | null; error: PoEmailError | null }
export interface PoEmailUserClient {
  getUser(): Promise<PoEmailResult<{ id: string }>>
  getDispatch(id: string): Promise<PoEmailResult<PoDispatchRecord>>
  getAttachment(id: string): Promise<PoEmailResult<PoAttachmentRecord>>
  downloadAttachment(path: string): Promise<PoEmailResult<Blob>>
  beginDispatch(id: string, expectedVersion: number): Promise<PoEmailResult<PoDispatchRecord>>
}
export interface PoFinalizeInput { id: string; providerMessageId: string | null; error: string | null; outcome: 'sent' | 'failed' | 'unknown' }
export interface PoEmailServiceClient { finalizeDispatch(input: PoFinalizeInput): Promise<PoEmailResult<PoDispatchRecord>> }
export interface PoEmailDependencies {
  env(name: string): string | undefined
  createUserClient(url: string, anonKey: string, bearerToken: string): PoEmailUserClient
  createServiceClient(url: string, serviceRoleKey: string): PoEmailServiceClient
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}
const MAX_FILE = 10 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
const email = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/u.test(value)
function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
function validRecord(row: PoDispatchRecord | null, id: string): row is PoDispatchRecord {
  return !!row && row.id === id && UUID.test(row.style_id) && date(row.due_date) && email(row.recipient)
    && typeof row.subject === 'string' && row.subject.trim().length > 0 && row.subject.length <= 500 && !/[\r\n\x00]/.test(row.subject)
    && typeof row.body === 'string' && row.body.trim().length > 0 && row.body.length <= 20000
    && typeof row.style_code_snapshot === 'string' && row.style_code_snapshot.trim().length > 0 && !/[\r\n\x00]/.test(row.style_code_snapshot)
    && typeof row.idempotency_key === 'string' && /^[a-z0-9_-]{1,256}$/i.test(row.idempotency_key)
    && (row.evidence_attachment_id === null || UUID.test(row.evidence_attachment_id))
    && Number.isInteger(row.version) && row.version > 0 && row.voided === false
}
function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}
function databaseFailure(error: PoEmailError | null): { status: number; code: string; message: string } {
  if (error?.code === '42501') return { status: 403, code: 'FORBIDDEN', message: '승인된 본사 계정만 PO를 발송할 수 있습니다.' }
  if (error?.code === '40001') return { status: 409, code: 'VERSION_CONFLICT', message: '다른 사용자가 먼저 수정했습니다. 최신 PO를 다시 확인해 주세요.' }
  if (/PO_ASSIGNMENT_CHANGED/.test(error?.message || '')) return { status: 409, code: 'PO_ASSIGNMENT_CHANGED', message: '담당 공장 또는 품번이 변경되었습니다. 초안을 검토해 다시 저장하거나 새 PO를 작성해 주세요.' }
  if (/PO_SEND_BLOCKED|HISTORY_PROTECTED/.test(error?.message || '')) return { status: 409, code: 'PO_SEND_BLOCKED', message: '이미 처리 중이거나 결과 확인이 필요한 PO입니다. 발송 이력을 확인해 주세요.' }
  return { status: 503, code: 'DATABASE_UNAVAILABLE', message: 'PO 발송 기록을 확인할 수 없습니다. 새로고침 후 발송 이력을 먼저 확인해 주세요.' }
}

export function createPoEmailHandler(dependencies: PoEmailDependencies): (request: Request) => Promise<Response> {
  const sendFetch = dependencies.fetch ?? globalThis.fetch
  return async request => {
    const origin = request.headers.get('origin')
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'Origin' }
    const respond = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
    const rawOrigins = dependencies.env('PO_ALLOWED_ORIGINS') || ''
    const origins = rawOrigins.split(',').map(value => value.trim()).filter(Boolean)
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
    const environment = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'PO_FROM_EMAIL'].map(name => [name, dependencies.env(name)?.trim() || '']))
    const missing = Object.entries(environment).filter(([, value]) => !value).map(([name]) => name)
    if (missing.length) return respond(503, { code: 'CONFIGURATION_REQUIRED', message: `메일 서버 설정이 필요합니다: ${missing.join(', ')}` })
    const from = environment.PO_FROM_EMAIL
    const sender = from.match(/<([^<>]+)>$/)?.[1] || from
    if (from.length > 320 || /[\r\n\x00]/.test(from) || !email(sender)) return respond(503, { code: 'CONFIGURATION_REQUIRED', message: '인증된 발신 주소로 PO_FROM_EMAIL을 설정해 주세요.' })
    const authorization = request.headers.get('authorization')
    const token = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1]
    if (!token) return respond(403, { code: 'AUTH_REQUIRED', message: '로그인 후 다시 시도해 주세요.' })

    let user: PoEmailUserClient
    try {
      user = dependencies.createUserClient(environment.SUPABASE_URL, environment.SUPABASE_ANON_KEY, token)
      const authenticated = await user.getUser()
      if (authenticated.error || !authenticated.data?.id) return respond(403, { code: 'AUTH_REQUIRED', message: '로그인이 만료되었거나 계정을 확인할 수 없습니다.' })
    } catch { return respond(503, { code: 'AUTH_UNAVAILABLE', message: '로그인 확인 서버에 연결할 수 없습니다.' }) }

    let input: { id: string; expectedVersion: number }
    try {
      const text = await request.text()
      if (text.length > 2048) throw new Error('size')
      const value: unknown = JSON.parse(text)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape')
      const record = value as Record<string, unknown>
      if (Object.keys(record).length !== 2 || !('id' in record) || !('expectedVersion' in record) || typeof record.id !== 'string' || !UUID.test(record.id) || !Number.isInteger(record.expectedVersion) || Number(record.expectedVersion) < 1 || Number(record.expectedVersion) > 2147483647) throw new Error('shape')
      input = { id: record.id, expectedVersion: Number(record.expectedVersion) }
    } catch { return respond(400, { code: 'INVALID_REQUEST', message: 'PO ID와 현재 버전만 전달해 주세요.' }) }

    let before: PoDispatchRecord
    let attachments: { filename: string; content: string; content_type: string }[] | undefined
    try {
      const selected = await user.getDispatch(input.id)
      if (selected.error || !selected.data) return respond(403, { code: 'FORBIDDEN', message: '접근할 수 있는 PO를 찾을 수 없습니다.' })
      if (!validRecord(selected.data, input.id)) return respond(422, { code: 'INVALID_PO', message: 'PO의 납기일·수신자·제목·본문을 확인해 주세요. 발송 시도는 기록하지 않았습니다.' })
      before = selected.data
      if (before.version !== input.expectedVersion) return respond(409, { code: 'VERSION_CONFLICT', message: 'PO가 변경되었습니다. 최신 내용을 확인해 주세요.' })
      if (!['draft', 'failed'].includes(before.status)) return respond(409, { code: 'PO_SEND_BLOCKED', message: '처리 중·접수 완료·결과 미확인 PO는 자동 재발송할 수 없습니다.' })
      if (before.evidence_attachment_id) {
        const result = await user.getAttachment(before.evidence_attachment_id), file = result.data
        if (result.error || !file || file.id !== before.evidence_attachment_id || file.style_id !== before.style_id || typeof file.path !== 'string' || !file.path.startsWith(`${before.style_id}/`) || !MIMES.has(file.mime) || !Number.isInteger(file.size) || file.size < 1 || file.size > MAX_FILE) return respond(422, { code: 'INVALID_ATTACHMENT', message: '이 스타일의 PDF·이미지 첨부파일(최대 10MB)을 확인해 주세요.' })
        const downloaded = await user.downloadAttachment(file.path)
        if (downloaded.error || !downloaded.data || downloaded.data.size !== file.size || downloaded.data.size > MAX_FILE) return respond(422, { code: 'ATTACHMENT_UNAVAILABLE', message: '비공개 첨부파일을 읽을 수 없습니다. 발송 전에 파일을 확인해 주세요.' })
        attachments = [{ filename: file.name.replace(/[\x00-\x1f\x7f]/g, '').replace(/[\\/]/g, '_').slice(0, 180) || 'PO_첨부파일', content: base64(new Uint8Array(await downloaded.data.arrayBuffer())), content_type: file.mime }]
      }
    } catch { return respond(503, { code: 'PREFLIGHT_UNAVAILABLE', message: 'PO·첨부파일을 확인할 수 없습니다. 발송 시도는 시작하지 않았습니다.' }) }

    let claimed: PoDispatchRecord
    try {
      const result = await user.beginDispatch(input.id, input.expectedVersion)
      if (result.error) { const failure = databaseFailure(result.error); return respond(failure.status, { code: failure.code, message: failure.message }) }
      if (!result.data) return respond(503, { code: 'BEGIN_UNCERTAIN', message: '발송 요청 기록을 확인할 수 없습니다. 발송 이력을 먼저 확인해 주세요.' })
      claimed = result.data
    } catch { return respond(503, { code: 'BEGIN_UNCERTAIN', message: '발송 요청 기록을 확인할 수 없습니다. 발송 이력을 먼저 확인해 주세요.' }) }

    let outcome: PoFinalizeInput['outcome'] = 'unknown', providerMessageId: string | null = null
    let providerError: string | null = '이메일 공급자 응답을 확인하지 못했습니다. 공급자 이력과 PO 발송 이력을 확인해 주세요.'
    const snapshotKeys = ['id', 'style_id', 'due_date', 'recipient', 'subject', 'body', 'evidence_attachment_id', 'idempotency_key', 'style_code_snapshot', 'factory_id_snapshot'] as const
    const snapshotMatches = validRecord(claimed, input.id) && claimed.status === 'sending' && claimed.version === input.expectedVersion + 1 && snapshotKeys.every(key => claimed[key] === before[key])
    if (snapshotMatches) {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('provider timeout')) }, dependencies.timeoutMs ?? 12000) })
        const call = (async () => {
          const response = await sendFetch('https://api.resend.com/emails', {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { authorization: `Bearer ${environment.RESEND_API_KEY}`, 'content-type': 'application/json', 'idempotency-key': claimed.idempotency_key },
            body: JSON.stringify({ from, to: [claimed.recipient], subject: `[납기 ${claimed.due_date}] ${claimed.subject}`, text: `FIVE SPACE / SIG PO\n스타일: ${claimed.style_code_snapshot}\n기준 납기: ${claimed.due_date}\n\n${claimed.body}`, ...(attachments ? { attachments } : {}) }),
          })
          return { response, text: await response.text() }
        })()
        const result = await Promise.race([call, deadline])
        if (result.response.status >= 200 && result.response.status < 300) {
          let receipt: unknown
          try { receipt = JSON.parse(result.text) } catch { receipt = null }
          const id = receipt && typeof receipt === 'object' && 'id' in receipt ? receipt.id : null
          if (typeof id === 'string' && /^[a-z0-9][a-z0-9._:-]{0,499}$/i.test(id)) { outcome = 'sent'; providerMessageId = id; providerError = null }
        } else if (result.response.status >= 400 && result.response.status < 500 && result.response.status !== 409) {
          outcome = 'failed'; providerError = `이메일 공급자가 요청을 거절했습니다 (HTTP ${result.response.status}). 발신 도메인·수신자·서비스 설정을 확인해 주세요.`
        }
      } catch { /* The provider may have accepted the email: never auto-retry. */ }
      finally { if (timer) clearTimeout(timer) }
    } else providerError = '발송 요청의 저장된 스냅샷을 확인할 수 없어 공급자를 호출하지 않았습니다. 발송 이력을 점검해 주세요.'

    try {
      const service = dependencies.createServiceClient(environment.SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY)
      const finalized = await service.finalizeDispatch({ id: input.id, providerMessageId, error: providerError, outcome })
      if (finalized.error || !finalized.data || finalized.data.id !== input.id || finalized.data.status !== outcome || (outcome === 'sent' && (finalized.data.provider_message_id !== providerMessageId || !finalized.data.sent_at))) throw new Error('finalize unavailable')
      if (outcome === 'sent') return respond(200, { status: 'sent', providerMessageId, version: finalized.data.version, message: '이메일 공급자가 PO를 접수했습니다. 실제 수신·열람을 보장하지는 않습니다.' })
      return respond(502, { code: outcome === 'failed' ? 'PROVIDER_REJECTED' : 'PROVIDER_RESULT_UNKNOWN', status: outcome, version: finalized.data.version, message: providerError })
    } catch { return respond(503, { code: 'UNCERTAIN_SYNC_FAILURE', status: 'unknown', message: '이메일 처리 결과를 DB에 저장했는지 확인할 수 없습니다. 다시 발송하지 말고 공급자와 PO 발송 이력을 먼저 대조해 주세요.' }) }
  }
}
