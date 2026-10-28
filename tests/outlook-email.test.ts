import { describe, expect, it, vi } from 'vitest'
import { createOutlookPoHandler, type OutlookDependencies, type OutlookDispatchRecord, type OutlookFinalizeInput, type OutlookProfile } from '../supabase/functions/send-po-outlook/handler'

const ID = '90000000-0000-4000-8000-000000000001'
const STYLE = '40000000-0000-4000-8000-000000000001'
const USER = '10000000-0000-4000-8000-000000000001'
const FILE = '70000000-0000-4000-8000-000000000001'
const CLIENT = '81000000-0000-4000-8000-000000000001'
const TENANT = '82000000-0000-4000-8000-000000000001'
const RECEIPT = '83000000-0000-4000-8000-000000000001'
const ORIGIN = 'https://sig-test.example'
const TOKEN = 'private-opaque-microsoft-token'
const ID_TOKEN = 'private-signed-microsoft-id-token'
const success = <T>(data: T) => ({ data, error: null })

function setup() {
  const environment: Record<string, string> = { PO_ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`, SUPABASE_URL: 'https://db-test.supabase.co', SUPABASE_ANON_KEY: 'public-test-key', SUPABASE_SERVICE_ROLE_KEY: 'private-service-key' }
  const draft: OutlookDispatchRecord = {
    id: ID, style_id: STYLE, due_date: '2026-11-30', recipient: 'factory@example.test', subject: '작업 요청 PO', body: '저장된 PO 본문',
    evidence_attachment_id: null, status: 'draft', version: 3, voided: false, attempts: 0,
    idempotency_key: `sig-po-${ID}`, factory_id_snapshot: '20000000-0000-4000-8000-000000000002', style_code_snapshot: 'BO42FYHD0101',
    provider: 'resend', sender_email_snapshot: null, provider_request_id: null, provider_message_id: null, sent_at: null,
  }
  const profile: OutlookProfile = { id: USER, email: 'staff@example.test', role: 'internal', approved: true, active: true }
  const user = {
    getUser: vi.fn(async () => success({ id: USER })),
    getProfile: vi.fn(async (_id: string) => success({ ...profile })),
    getConfiguration: vi.fn(async () => success({ clientId: CLIENT, tenantId: TENANT })),
    getDispatch: vi.fn(async (_id: string) => success({ ...draft })),
    getAttachment: vi.fn(async (_id: string) => success({ id: FILE, style_id: STYLE, path: `${STYLE}/PO.pdf`, name: 'PO\r\n명세서.pdf', mime: 'application/pdf', size: 3 })),
    downloadAttachment: vi.fn(async (_path: string) => success(new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }))),
    beginDispatch: vi.fn(async (_id: string, _version: number) => success({ ...draft, status: 'sending', version: 4, attempts: draft.attempts + 1, provider: 'outlook', sender_email_snapshot: profile.email })),
  }
  const service = {
    finalizeDispatch: vi.fn(async (input: OutlookFinalizeInput) => success({ ...draft, version: 5, status: input.outcome, provider: 'outlook', sender_email_snapshot: profile.email, provider_request_id: input.requestId, provider_message_id: null, sent_at: input.outcome === 'sent' ? '2026-10-28T00:00:00Z' : null })),
  }
  const graph = vi.fn<typeof globalThis.fetch>(async url => String(url).includes('/me?')
    ? new Response(JSON.stringify({ id: USER, mail: profile.email, userPrincipalName: profile.email }), { status: 200 })
    : new Response(null, { status: 202, headers: { 'request-id': RECEIPT } }))
  const createUserClient = vi.fn(() => user), createServiceClient = vi.fn(() => service)
  const verifyIdentityToken = vi.fn(async (_token: string, _configuration: { clientId: string; tenantId: string }) => ({ tenantId: TENANT, objectId: USER }))
  const dependencies: OutlookDependencies = { env: name => environment[name], createUserClient, createServiceClient, verifyIdentityToken, fetch: graph, timeoutMs: 20 }
  const handler = createOutlookPoHandler(dependencies)
  const input = { id: ID, expectedVersion: 3, outlookAccessToken: TOKEN, outlookIdToken: ID_TOKEN }
  function request(body: unknown = input, headers: Record<string, string> = {}, method = 'POST') {
    return new Request('https://functions-test.example/send-po-outlook', { method, headers: { origin: ORIGIN, authorization: 'Bearer valid-app-token', 'content-type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
  }
  const sendCalls = () => graph.mock.calls.filter(call => String(call[0]).endsWith('/me/sendMail'))
  return { environment, draft, profile, user, service, graph, createUserClient, createServiceClient, verifyIdentityToken, handler, request, input, sendCalls }
}

describe('Outlook PO: 본인 Microsoft 365 메일함의 명시적 직접 발송', () => {
  it('허용된 CORS 사전 요청은 인증·Microsoft 호출을 시작하지 않는다', async () => {
    const f = setup(), response = await f.handler(f.request(undefined, {}, 'OPTIONS'))
    expect(response.status).toBe(204); expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(f.createUserClient).not.toHaveBeenCalled(); expect(f.graph).not.toHaveBeenCalled()
  })

  it.each(['https://attacker.example', '', 'null', `${ORIGIN}.attacker.example`])('다른 Origin으로 토큰을 전달하지 않는다: %s', async origin => {
    const f = setup(), response = await f.handler(f.request(undefined, { origin }))
    expect(response.status).toBe(403); expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(f.createUserClient).not.toHaveBeenCalled(); expect(f.graph).not.toHaveBeenCalled()
  })

  it.each(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'PO_ALLOWED_ORIGINS'])('필수 서버 설정 누락 시 보내지 않는다: %s', async name => {
    const f = setup(); delete f.environment[name]
    expect((await f.handler(f.request())).status).toBe(503)
    expect(f.user.beginDispatch).not.toHaveBeenCalled(); expect(f.graph).not.toHaveBeenCalled()
  })

  it('메일 발송은 POST만 받고 와일드카드 Origin 설정은 거절한다', async () => {
    const f = setup()
    expect((await f.handler(f.request(undefined, {}, 'GET'))).status).toBe(405)
    f.environment.PO_ALLOWED_ORIGINS = '*'
    expect((await f.handler(f.request())).status).toBe(503)
    expect(f.graph).not.toHaveBeenCalled()
  })

  it('앱 Bearer와 실제 Auth 서버의 사용자 확인이 모두 필요하다', async () => {
    const f = setup()
    expect((await f.handler(f.request(undefined, { authorization: '' }))).status).toBe(403)
    expect(f.user.getUser).not.toHaveBeenCalled()
    f.user.getUser.mockResolvedValueOnce({ data: null, error: { message: 'expired' } } as never)
    expect((await f.handler(f.request())).status).toBe(403)
    expect(f.user.getProfile).not.toHaveBeenCalled(); expect(f.graph).not.toHaveBeenCalled()
  })

  it.each([{ role: 'factory' }, { approved: false }, { active: false }, { id: FILE }, { email: 'invalid' }])('현재 승인된 본사 프로필만 사용한다: %j', async change => {
    const f = setup(); Object.assign(f.profile, change)
    expect((await f.handler(f.request())).status).toBe(403)
    expect(f.graph).not.toHaveBeenCalled(); expect(f.user.beginDispatch).not.toHaveBeenCalled()
  })

  it.each([
    { id: ID, expectedVersion: 3, outlookAccessToken: TOKEN, from: 'other@example.test' },
    { id: ID, expectedVersion: 3 }, { id: ID, expectedVersion: 3, outlookAccessToken: '' },
    { id: ID, expectedVersion: 3, outlookAccessToken: 'token\r\nInjected' },
    { id: ID, expectedVersion: 3, outlookAccessToken: 'x'.repeat(24577) },
    { id: ID, expectedVersion: 0, outlookAccessToken: TOKEN },
    { id: ID, expectedVersion: '3', outlookAccessToken: TOKEN },
    { id: 'invalid', expectedVersion: 3, outlookAccessToken: TOKEN }, null, [],
  ])('발신자·수신자·내용을 요청에서 임의 변경할 수 없다: %j', async input => {
    const f = setup()
    expect((await f.handler(f.request(input))).status).toBe(400)
    expect(f.user.getConfiguration).not.toHaveBeenCalled(); expect(f.graph).not.toHaveBeenCalled()
  })

  it.each([null, { clientId: 'invalid', tenantId: TENANT }, { clientId: CLIENT, tenantId: 'https://attacker.example' }])('설정된 Microsoft 앱이 있어야 한다: %j', async config => {
    const f = setup(); f.user.getConfiguration.mockResolvedValueOnce(success(config) as never)
    expect((await f.handler(f.request())).status).toBe(503)
    expect(f.graph).not.toHaveBeenCalled(); expect(f.user.beginDispatch).not.toHaveBeenCalled()
  })

  it.each(['', 'bad token', 'x'.repeat(24577), undefined])('별도의 Microsoft ID 인증값이 반드시 필요하다: %j', async token => {
    const f = setup(), input: Record<string, unknown> = { ...f.input, outlookIdToken: token }
    if (token === undefined) delete input.outlookIdToken
    expect((await f.handler(f.request(input))).status).toBe(400)
    expect(f.verifyIdentityToken).not.toHaveBeenCalled(); expect(f.graph).not.toHaveBeenCalled()
  })

  it('ID 토큰의 서명·만료·앱 검증 실패는 Microsoft 발송 전에 거절한다', async () => {
    const f = setup(); f.verifyIdentityToken.mockRejectedValueOnce(new Error(ID_TOKEN))
    const response = await f.handler(f.request()), body = await response.json()
    expect(response.status).toBe(403); expect(body.code).toBe('OUTLOOK_AUTH_REQUIRED')
    expect(JSON.stringify(body)).not.toContain(ID_TOKEN)
    expect(f.graph).not.toHaveBeenCalled(); expect(f.user.beginDispatch).not.toHaveBeenCalled()
  })

  it.each([{ tenantId: CLIENT, objectId: USER }, { tenantId: TENANT, objectId: 'not-a-guid' }])('인증한 회사·객체 ID가 설정과 맞아야 한다: %j', async proof => {
    const f = setup(); f.verifyIdentityToken.mockResolvedValueOnce(proof)
    expect((await f.handler(f.request())).status).toBe(403)
    expect(f.graph).not.toHaveBeenCalled(); expect(f.user.beginDispatch).not.toHaveBeenCalled()
  })

  it('이메일이 같아도 Graph 계정의 객체 ID가 ID 토큰과 다르면 거절한다', async () => {
    const f = setup(); f.graph.mockResolvedValueOnce(new Response(JSON.stringify({ id: FILE, mail: f.profile.email, userPrincipalName: f.profile.email }), { status: 200 }))
    const response = await f.handler(f.request())
    expect(response.status).toBe(403); expect((await response.json()).code).toBe('OUTLOOK_ACCOUNT_MISMATCH')
    expect(f.user.beginDispatch).not.toHaveBeenCalled(); expect(f.sendCalls()).toHaveLength(0)
  })

  it('서버가 Microsoft /me에서 메일함을 확인하고 본인 메일로만 보낸다', async () => {
    const f = setup(), response = await f.handler(f.request())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'sent', provider: 'outlook', providerRequestId: RECEIPT, senderEmail: f.profile.email, version: 5 })
    expect(f.user.getProfile).toHaveBeenCalledWith(USER)
    expect(f.verifyIdentityToken).toHaveBeenCalledWith(ID_TOKEN, { clientId: CLIENT, tenantId: TENANT })
    expect(f.graph.mock.calls[0]).toMatchObject(['https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName', { method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${TOKEN}` } }])
    expect(f.user.beginDispatch).toHaveBeenCalledWith(ID, 3)
    const [url, init] = f.sendCalls()[0], payload = JSON.parse(String(init?.body))
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail')
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` })
    expect(payload.saveToSentItems).toBe(true)
    expect(payload.message.from).toBeUndefined()
    expect(payload.message.toRecipients).toEqual([{ emailAddress: { address: f.draft.recipient } }])
    expect(payload.message.replyTo).toEqual([{ emailAddress: { address: f.profile.email } }])
    expect(payload.message.subject).toBe('[납기 2026-11-30] 작업 요청 PO')
    expect(payload.message.body.content).toContain(f.draft.body)
    expect(payload.message.body.content).toContain(f.draft.style_code_snapshot)
    expect(f.service.finalizeDispatch).toHaveBeenCalledWith({ id: ID, requestId: RECEIPT, error: null, outcome: 'sent' })
    expect(f.service.finalizeDispatch.mock.calls[0][0]).not.toHaveProperty('providerMessageId')
  })

  it.each([
    { id: USER, mail: 'someone-else@example.test', userPrincipalName: 'someone-else@example.test' },
    { id: USER, mail: 'someone-else@example.test', userPrincipalName: 'staff@example.test' },
    { id: USER, mail: null, userPrincipalName: null },
    { mail: 'staff@example.test' },
  ])('다른 Microsoft 메일함은 발송 시도 전에 차단한다: %j', async mailbox => {
    const f = setup(); f.graph.mockResolvedValueOnce(new Response(JSON.stringify(mailbox), { status: 200 }))
    const response = await f.handler(f.request())
    expect(response.status).toBe(403); expect((await response.json()).code).toBe('OUTLOOK_ACCOUNT_MISMATCH')
    expect(f.user.getDispatch).not.toHaveBeenCalled(); expect(f.user.beginDispatch).not.toHaveBeenCalled(); expect(f.sendCalls()).toHaveLength(0)
  })

  it('mail이 없는 계정은 실제 UPN으로 확인하고 이메일 대소문자를 구분하지 않는다', async () => {
    const f = setup(); f.graph.mockResolvedValueOnce(new Response(JSON.stringify({ id: USER, mail: null, userPrincipalName: 'STAFF@EXAMPLE.TEST' }), { status: 200 }))
    expect((await f.handler(f.request())).status).toBe(200)
  })

  it.each([401, 403, 429, 503])('Microsoft 계정 확인 실패는 초안을 발송 상태로 바꾸지 않는다: %s', async status => {
    const f = setup(); f.graph.mockResolvedValueOnce(new Response('secret-debug', { status }))
    const response = await f.handler(f.request())
    expect(response.status).toBe(status === 401 || status === 403 ? 403 : 503)
    expect(JSON.stringify(await response.json())).not.toContain('secret-debug')
    expect(f.user.beginDispatch).not.toHaveBeenCalled(); expect(f.service.finalizeDispatch).not.toHaveBeenCalled()
  })

  it('계정 확인 네트워크 실패·시간 초과도 발송을 시작하지 않는다', async () => {
    for (const kind of ['network', 'timeout']) {
      const f = setup()
      if (kind === 'network') f.graph.mockRejectedValueOnce(new Error(TOKEN))
      else f.graph.mockImplementationOnce(() => new Promise(() => {}))
      const response = await f.handler(f.request())
      expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain(TOKEN)
      expect(f.user.beginDispatch).not.toHaveBeenCalled(); expect(f.sendCalls()).toHaveLength(0)
    }
  })

  it('Microsoft 계정 확인 응답 본문이 멈춰도 제한 시간 후 발송 전 종료한다', async () => {
    const f = setup(), response = new Response('{}', { status: 200 })
    vi.spyOn(response, 'json').mockImplementation(() => new Promise(() => {}))
    f.graph.mockResolvedValueOnce(response)
    expect((await f.handler(f.request())).status).toBe(503)
    expect(f.user.beginDispatch).not.toHaveBeenCalled(); expect(f.sendCalls()).toHaveLength(0)
  })

  it.each([{ due_date: '2026-02-30' }, { recipient: 'one@example.test,two@example.test' }, { subject: 'PO\r\nBcc: x@example.test' }, { body: '' }, { voided: true }])('잘못된 저장 문서는 발송하지 않는다: %j', async change => {
    const f = setup(); Object.assign(f.draft, change)
    expect((await f.handler(f.request())).status).toBe(422)
    expect(f.user.beginDispatch).not.toHaveBeenCalled(); expect(f.sendCalls()).toHaveLength(0)
  })

  it.each(['sending', 'sent', 'unknown'])('중복·불확실한 상태는 다시 보내지 않는다: %s', async status => {
    const f = setup(); f.draft.status = status
    expect((await f.handler(f.request())).status).toBe(409)
    expect(f.user.beginDispatch).not.toHaveBeenCalled(); expect(f.sendCalls()).toHaveLength(0)
  })

  it('오래된 버전·다른 공급자·다른 최초 발신자는 새 PO를 확인하게 한다', async () => {
    for (const kind of ['version', 'provider', 'sender']) {
      const f = setup()
      if (kind === 'version') f.draft.version++
      else { f.draft.attempts = 1; f.draft.status = 'failed'; if (kind === 'sender') { f.draft.provider = 'outlook'; f.draft.sender_email_snapshot = 'other@example.test' } }
      expect((await f.handler(f.request())).status).toBe(409)
      expect(f.user.beginDispatch).not.toHaveBeenCalled(); expect(f.sendCalls()).toHaveLength(0)
    }
  })

  it('CAS 또는 현재 권한 검사가 실패하면 Microsoft 발송을 호출하지 않는다', async () => {
    for (const code of ['42501', '40001']) {
      const f = setup(); f.user.beginDispatch.mockResolvedValueOnce({ data: null, error: { code } } as never)
      expect((await f.handler(f.request())).status).toBe(code === '42501' ? 403 : 409)
      expect(f.sendCalls()).toHaveLength(0); expect(f.service.finalizeDispatch).not.toHaveBeenCalled()
    }
  })

  it('같은 스타일의 비공개 PDF만 서버에서 읽어 Microsoft 파일 첨부로 보낸다', async () => {
    const f = setup(); f.draft.evidence_attachment_id = FILE
    expect((await f.handler(f.request())).status).toBe(200)
    expect(f.user.downloadAttachment).toHaveBeenCalledWith(`${STYLE}/PO.pdf`)
    expect(f.user.downloadAttachment.mock.invocationCallOrder[0]).toBeLessThan(f.user.beginDispatch.mock.invocationCallOrder[0])
    const payload = JSON.parse(String(f.sendCalls()[0][1]?.body))
    expect(payload.message.attachments).toEqual([{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'PO명세서.pdf', contentType: 'application/pdf', contentBytes: 'AQID' }])
    expect(JSON.stringify(payload)).not.toContain('supabase.co/storage')
  })

  it.each(['foreign', 'oversize', 'download', 'size-mismatch', 'mime', 'path'])('안전하지 않은 첨부는 발송 시도 전 차단한다: %s', async kind => {
    const f = setup(); f.draft.evidence_attachment_id = FILE
    const file = { id: FILE, style_id: STYLE, path: `${STYLE}/PO.pdf`, name: 'PO.pdf', mime: 'application/pdf', size: 3 }
    if (kind === 'foreign') file.style_id = 'other'
    if (kind === 'oversize') file.size = 2 * 1024 * 1024 + 1
    if (kind === 'mime') file.mime = 'text/html'
    if (kind === 'path') file.path = `${FILE}/foreign.pdf`
    f.user.getAttachment.mockResolvedValueOnce(success(file))
    if (kind === 'download') f.user.downloadAttachment.mockResolvedValueOnce({ data: null, error: { message: 'unavailable' } } as never)
    if (kind === 'size-mismatch') f.user.downloadAttachment.mockResolvedValueOnce(success(new Blob(['different'])))
    expect((await f.handler(f.request())).status).toBe(422)
    expect(f.user.beginDispatch).not.toHaveBeenCalled(); expect(f.sendCalls()).toHaveLength(0)
  })

  it.each([{ body: 'changed' }, { recipient: 'other@example.test' }, { sender_email_snapshot: 'other@example.test' }, { provider: 'resend' }, { attempts: 9 }])('원문 또는 발신자 스냅샷이 달라지면 보내지 않고 unknown을 기록한다: %j', async change => {
    const f = setup(); f.user.beginDispatch.mockResolvedValueOnce(success({ ...f.draft, status: 'sending', version: 4, attempts: 1, provider: 'outlook', sender_email_snapshot: f.profile.email, ...change }))
    expect(await (await f.handler(f.request())).json()).toMatchObject({ status: 'unknown' })
    expect(f.sendCalls()).toHaveLength(0)
    expect(f.service.finalizeDispatch.mock.calls[0][0]).toMatchObject({ outcome: 'unknown', requestId: null })
  })

  it.each([400, 401, 403, 422, 429])('Microsoft 발송 4xx 확정 거절은 failed로 남긴다: %s', async status => {
    const f = setup(); f.graph.mockImplementation(async url => String(url).includes('/me?') ? new Response(JSON.stringify({ id: USER, mail: f.profile.email }), { status: 200 }) : new Response('private-provider-debug', { status }))
    const response = await f.handler(f.request()), result = await response.json()
    expect(response.status).toBe(502); expect(result).toMatchObject({ status: 'failed', code: 'PROVIDER_REJECTED' })
    expect(JSON.stringify(result)).not.toContain('private-provider-debug')
    expect(f.service.finalizeDispatch.mock.calls[0][0]).toMatchObject({ outcome: 'failed', requestId: null })
  })

  it.each([200, 204, 409, 500, 503])('202 접수 이외의 불확실 응답을 성공 처리하지 않는다: %s', async status => {
    const f = setup(); f.graph.mockImplementation(async url => String(url).includes('/me?') ? new Response(JSON.stringify({ id: USER, mail: f.profile.email }), { status: 200 }) : new Response(null, { status }))
    expect(await (await f.handler(f.request())).json()).toMatchObject({ status: 'unknown' })
    expect(f.service.finalizeDispatch.mock.calls[0][0].outcome).toBe('unknown')
    expect(f.sendCalls()).toHaveLength(1)
  })

  it.each([null, '', 'bad\ttrace', 'arbitrary-not-a-guid'])('202라도 실제 Microsoft 추적 ID가 없으면 unknown이다: %j', async receipt => {
    const f = setup(); f.graph.mockImplementation(async url => String(url).includes('/me?') ? new Response(JSON.stringify({ id: USER, mail: f.profile.email }), { status: 200 }) : new Response(null, { status: 202, headers: receipt === null ? {} : { 'request-id': receipt } }))
    expect(await (await f.handler(f.request())).json()).toMatchObject({ status: 'unknown' })
    expect(f.service.finalizeDispatch.mock.calls[0][0]).toMatchObject({ outcome: 'unknown', requestId: null })
  })

  it('발송 시간 초과와 네트워크 예외는 자동 재시도하지 않는다', async () => {
    for (const kind of ['network', 'timeout']) {
      const f = setup(); f.graph.mockImplementation(async url => {
        if (String(url).includes('/me?')) return new Response(JSON.stringify({ id: USER, mail: f.profile.email }), { status: 200 })
        if (kind === 'network') throw new Error(TOKEN)
        return await new Promise<Response>(() => {})
      })
      const response = await f.handler(f.request()), body = await response.json()
      expect(body.status).toBe('unknown'); expect(JSON.stringify(body)).not.toContain(TOKEN)
      expect(f.sendCalls()).toHaveLength(1)
      expect(f.service.finalizeDispatch.mock.calls[0][0]).toMatchObject({ outcome: 'unknown', requestId: null })
    }
  })

  it.each(['database', 'trace', 'message-id', 'provider'])('접수 결과가 정확히 저장된 경우만 성공으로 응답한다: %s', async kind => {
    const f = setup()
    if (kind === 'database') f.service.finalizeDispatch.mockResolvedValueOnce({ data: null, error: { message: 'private-service-key' } } as never)
    else f.service.finalizeDispatch.mockResolvedValueOnce(success({ ...f.draft, version: 5, status: 'sent', provider: kind === 'provider' ? 'resend' : 'outlook', provider_message_id: kind === 'message-id' ? RECEIPT : null, provider_request_id: kind === 'trace' ? FILE : RECEIPT, sent_at: '2026-10-28T00:00:00Z' }))
    const response = await f.handler(f.request()), body = await response.json()
    expect(response.status).toBe(503); expect(body).toMatchObject({ status: 'unknown', code: 'UNCERTAIN_SYNC_FAILURE' })
    expect(JSON.stringify(body)).not.toContain('private-service-key')
    expect(f.sendCalls()).toHaveLength(1)
  })
})
