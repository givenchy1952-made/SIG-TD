import { describe, expect, it, vi } from 'vitest'
import { createPoEmailHandler, type PoDispatchRecord, type PoEmailDependencies, type PoFinalizeInput } from '../supabase/functions/send-po-email/handler'

const ID = '90000000-0000-4000-8000-000000000001'
const STYLE = '40000000-0000-4000-8000-000000000001'
const FILE = '70000000-0000-4000-8000-000000000001'
const ORIGIN = 'https://sig-test.example'
const success = <T>(data: T) => ({ data, error: null })
function setup() {
  const environment: Record<string, string> = {
    PO_ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`, SUPABASE_URL: 'https://db-test.supabase.co',
    SUPABASE_ANON_KEY: 'public-test-key', SUPABASE_SERVICE_ROLE_KEY: 'private-service-test-key',
    RESEND_API_KEY: 'private-resend-test-key', PO_FROM_EMAIL: 'SIG <po@verified-test.example>',
  }
  const draft: PoDispatchRecord = {
    id: ID, style_id: STYLE, due_date: '2026-11-30', recipient: 'factory@example.test', subject: '작업 요청 PO', body: '저장된 실제 PO 본문',
    evidence_attachment_id: null, status: 'draft', version: 3, voided: false, attempts: 0,
    idempotency_key: `sig-po-${ID}`, factory_id_snapshot: '20000000-0000-4000-8000-000000000002', style_code_snapshot: 'BO42FYHD0101', provider_message_id: null, sent_at: null,
  }
  const user = {
    getUser: vi.fn(async () => success({ id: '10000000-0000-4000-8000-000000000001' })),
    getDispatch: vi.fn(async (_id: string) => success({ ...draft })),
    getAttachment: vi.fn(async (_id: string) => success({ id: FILE, style_id: STYLE, path: `${STYLE}/PO.pdf`, name: 'PO\r\n명세서.pdf', mime: 'application/pdf', size: 3 })),
    downloadAttachment: vi.fn(async (_path: string) => success(new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }))),
    beginDispatch: vi.fn(async (_id: string, _version: number) => success({ ...draft, status: 'sending', version: 4, attempts: 1 })),
  }
  const service = {
    finalizeDispatch: vi.fn(async (input: PoFinalizeInput) => success({ ...draft, version: 5, status: input.outcome, provider_message_id: input.providerMessageId, sent_at: input.outcome === 'sent' ? '2026-10-23T12:00:00Z' : null })),
  }
  const provider = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ id: 'resend-receipt-001' }), { status: 200 }))
  const createUserClient = vi.fn(() => user), createServiceClient = vi.fn(() => service)
  const dependencies: PoEmailDependencies = { env: name => environment[name], createUserClient, createServiceClient, fetch: provider, timeoutMs: 20 }
  const handler = createPoEmailHandler(dependencies)
  function request(body: unknown = { id: ID, expectedVersion: 3 }, headers: Record<string, string> = {}, method = 'POST') {
    return new Request('https://functions-test.example/send-po-email', { method, headers: { origin: ORIGIN, authorization: 'Bearer valid-user-token', 'content-type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
  }
  return { environment, draft, user, service, provider, handler, request, createUserClient, createServiceClient, dependencies }
}

describe('PO 이메일: 인증된 본사 사용자의 명시적 직접 발송', () => {
  it('허용된 브라우저의 CORS 사전 요청만 허용하고 인증·발송을 시작하지 않는다', async () => {
    const fixture = setup(), response = await fixture.handler(fixture.request(undefined, {}, 'OPTIONS'))
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(fixture.createUserClient).not.toHaveBeenCalled()
    expect(fixture.provider).not.toHaveBeenCalled()
  })

  it.each(['https://attacker.example', '', 'null', `${ORIGIN}.attacker.example`])('알 수 없는 Origin은 데이터 조회 전에 거절한다: %s', async origin => {
    const fixture = setup(), response = await fixture.handler(fixture.request(undefined, { origin }))
    expect(response.status).toBe(403)
    expect(fixture.createUserClient).not.toHaveBeenCalled()
    expect(fixture.provider).not.toHaveBeenCalled()
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it.each(['RESEND_API_KEY', 'PO_FROM_EMAIL', 'SUPABASE_SERVICE_ROLE_KEY', 'PO_ALLOWED_ORIGINS'])('서버 설정 누락은 시도 횟수 증가 없이 503으로 알린다: %s', async name => {
    const fixture = setup(); delete fixture.environment[name]
    const response = await fixture.handler(fixture.request())
    expect(response.status).toBe(503)
    expect((await response.json()).code).toBe('CONFIGURATION_REQUIRED')
    expect(fixture.user.beginDispatch).not.toHaveBeenCalled()
    expect(fixture.provider).not.toHaveBeenCalled()
  })

  it('와일드카드 CORS 및 줄바꿈이 든 발신 주소는 설정 오류로 거절한다', async () => {
    const fixture = setup(); fixture.environment.PO_ALLOWED_ORIGINS = '*'
    expect((await fixture.handler(fixture.request())).status).toBe(503)
    fixture.environment.PO_ALLOWED_ORIGINS = ORIGIN
    fixture.environment.PO_FROM_EMAIL = 'SIG\r\nBcc: x@example.test <po@example.test>'
    expect((await fixture.handler(fixture.request())).status).toBe(503)
    expect(fixture.provider).not.toHaveBeenCalled()
  })

  it('Bearer가 없으면 거절하고, 존재해도 Auth 서버의 getUser 확인을 통과해야 한다', async () => {
    const fixture = setup()
    expect((await fixture.handler(fixture.request(undefined, { authorization: '' }))).status).toBe(403)
    expect(fixture.user.getUser).not.toHaveBeenCalled()
    fixture.user.getUser.mockResolvedValueOnce({ data: null, error: { message: 'JWT expired' } } as never)
    expect((await fixture.handler(fixture.request())).status).toBe(403)
    expect(fixture.createUserClient).toHaveBeenCalledWith(fixture.environment.SUPABASE_URL, 'public-test-key', 'valid-user-token')
    expect(fixture.user.getDispatch).not.toHaveBeenCalled()
    expect(fixture.user.beginDispatch).not.toHaveBeenCalled()
  })

  it.each([
    { id: ID, expectedVersion: 3, recipient: 'attacker@example.test' },
    { id: ID, expectedVersion: 0 }, { id: ID, expectedVersion: 1.5 }, { id: 'invalid', expectedVersion: 3 },
    { id: ID, expectedVersion: '3' }, { id: ID }, null, [],
  ])('요청은 저장된 PO ID와 양의 정수 버전만 받는다: %j', async input => {
    const fixture = setup(), response = await fixture.handler(fixture.request(input))
    expect(response.status).toBe(400)
    expect(fixture.user.getDispatch).not.toHaveBeenCalled()
    expect(fixture.provider).not.toHaveBeenCalled()
  })

  it('DB 스냅샷의 수신자·제목·본문만 사용하고 제목과 본문에 기준 납기를 반드시 넣는다', async () => {
    const fixture = setup(), response = await fixture.handler(fixture.request())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'sent', providerMessageId: 'resend-receipt-001', version: 5 })
    expect(fixture.user.getUser).toHaveBeenCalledTimes(1)
    expect(fixture.user.beginDispatch).toHaveBeenCalledWith(ID, 3)
    const [url, init] = fixture.provider.mock.calls[0], payload = JSON.parse(String(init?.body))
    expect(url).toBe('https://api.resend.com/emails')
    expect(init?.headers).toMatchObject({ 'idempotency-key': fixture.draft.idempotency_key })
    expect(payload.to).toEqual([fixture.draft.recipient])
    expect(payload.subject).toBe('[납기 2026-11-30] 작업 요청 PO')
    expect(payload.text).toContain('기준 납기: 2026-11-30')
    expect(payload.text).toContain(fixture.draft.style_code_snapshot)
    expect(payload.text).toContain(fixture.draft.body)
    expect(fixture.createServiceClient).toHaveBeenCalledWith(fixture.environment.SUPABASE_URL, 'private-service-test-key')
    expect(fixture.service.finalizeDispatch).toHaveBeenCalledWith({ id: ID, outcome: 'sent', providerMessageId: 'resend-receipt-001', error: null })
  })

  it.each(['', '2026-02-30', '11/30/2026', '2026-13-01'])('납기가 잘못된 PO는 begin·공급자를 호출하지 않는다: %s', async due_date => {
    const fixture = setup(); fixture.draft.due_date = due_date
    expect((await fixture.handler(fixture.request())).status).toBe(422)
    expect(fixture.user.beginDispatch).not.toHaveBeenCalled()
    expect(fixture.provider).not.toHaveBeenCalled()
  })

  it('화면·DB와 같은 제목 500자, 본문 20,000자 경계까지 전송한다', async () => {
    const fixture = setup()
    fixture.draft.subject = '제'.repeat(500)
    fixture.draft.body = '본'.repeat(20000)
    expect((await fixture.handler(fixture.request())).status).toBe(200)
    const payload = JSON.parse(String(fixture.provider.mock.calls[0][1]?.body))
    expect(payload.subject).toBe(`[납기 2026-11-30] ${fixture.draft.subject}`)
    expect(payload.text.endsWith(fixture.draft.body)).toBe(true)
  })

  it.each([
    { subject: '제'.repeat(501) }, { body: '본'.repeat(20001) },
    { subject: 'PO\r\nBcc: other@example.test' }, { recipient: 'one@example.test,two@example.test' },
    { recipient: 'one@example.test;two@example.test' }, { voided: true },
  ])('저장된 문서의 잘못된 주소·내용은 시도 전 거절한다: %j', async change => {
    const fixture = setup(); Object.assign(fixture.draft, change)
    expect((await fixture.handler(fixture.request())).status).toBe(422)
    expect(fixture.user.beginDispatch).not.toHaveBeenCalled()
    expect(fixture.provider).not.toHaveBeenCalled()
  })

  it('새 요청마다 Auth 서버를 재확인하여 이전에 성공한 JWT도 취소되면 차단한다', async () => {
    const fixture = setup()
    expect((await fixture.handler(fixture.request())).status).toBe(200)
    fixture.user.getUser.mockResolvedValueOnce({ data: null, error: { message: 'revoked session' } } as never)
    expect((await fixture.handler(fixture.request())).status).toBe(403)
    expect(fixture.user.getUser).toHaveBeenCalledTimes(2)
    expect(fixture.user.beginDispatch).toHaveBeenCalledTimes(1)
    expect(fixture.provider).toHaveBeenCalledTimes(1)
  })

  it.each(['sending', 'sent', 'unknown'])('중복 또는 불확실한 PO 상태를 자동 재시도하지 않는다: %s', async status => {
    const fixture = setup(); fixture.draft.status = status
    expect((await fixture.handler(fixture.request())).status).toBe(409)
    expect(fixture.user.beginDispatch).not.toHaveBeenCalled()
    expect(fixture.provider).not.toHaveBeenCalled()
  })

  it('공장·미승인 계정에 대한 DB 권한 거절 후에는 공급자를 호출하지 않는다', async () => {
    const fixture = setup()
    fixture.user.beginDispatch.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'FORBIDDEN' } } as never)
    const response = await fixture.handler(fixture.request())
    expect(response.status).toBe(403)
    expect(fixture.provider).not.toHaveBeenCalled()
    expect(fixture.service.finalizeDispatch).not.toHaveBeenCalled()
  })

  it('CAS가 동시 발송 중 한 건만 승인하면 공급자 호출도 한 번만 실행한다', async () => {
    const fixture = setup()
    fixture.user.beginDispatch.mockResolvedValueOnce(success({ ...fixture.draft, status: 'sending', version: 4, attempts: 1 }))
    fixture.user.beginDispatch.mockResolvedValueOnce({ data: null, error: { code: '40001', message: 'VERSION_CONFLICT' } } as never)
    const responses = await Promise.all([fixture.handler(fixture.request()), fixture.handler(fixture.request())])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    expect(fixture.provider).toHaveBeenCalledTimes(1)
  })

  it('RLS로 비공개 파일을 먼저 읽고 같은 스타일의 내용만 base64 첨부한다', async () => {
    const fixture = setup(); fixture.draft.evidence_attachment_id = FILE
    const response = await fixture.handler(fixture.request())
    expect(response.status).toBe(200)
    expect(fixture.user.getAttachment).toHaveBeenCalledWith(FILE)
    expect(fixture.user.downloadAttachment).toHaveBeenCalledWith(`${STYLE}/PO.pdf`)
    expect(fixture.user.downloadAttachment.mock.invocationCallOrder[0]).toBeLessThan(fixture.user.beginDispatch.mock.invocationCallOrder[0])
    const payload = JSON.parse(String(fixture.provider.mock.calls[0][1]?.body))
    expect(payload.attachments).toEqual([{ filename: 'PO명세서.pdf', content: 'AQID', content_type: 'application/pdf' }])
    expect(JSON.stringify(payload)).not.toContain('supabase.co/storage')
  })

  it('타 스타일 첨부·10MB 초과·다운로드 실패는 발송 시도 전에 차단한다', async () => {
    for (const change of ['foreign', 'oversize', 'download']) {
      const fixture = setup(); fixture.draft.evidence_attachment_id = FILE
      if (change === 'foreign') fixture.user.getAttachment.mockResolvedValueOnce(success({ id: FILE, style_id: 'other-style', path: `${STYLE}/PO.pdf`, name: 'file.pdf', mime: 'application/pdf', size: 3 }))
      if (change === 'oversize') fixture.user.getAttachment.mockResolvedValueOnce(success({ id: FILE, style_id: STYLE, path: `${STYLE}/PO.pdf`, name: 'file.pdf', mime: 'application/pdf', size: 10 * 1024 * 1024 + 1 }))
      if (change === 'download') fixture.user.downloadAttachment.mockResolvedValueOnce({ data: null, error: { message: 'not allowed' } } as never)
      expect((await fixture.handler(fixture.request())).status).toBe(422)
      expect(fixture.user.beginDispatch).not.toHaveBeenCalled()
      expect(fixture.provider).not.toHaveBeenCalled()
    }
  })

  it.each([400, 401, 403, 422, 429])('확정적인 공급자 4xx 거절은 sent가 아닌 failed로 기록한다: %s', async status => {
    const fixture = setup(); fixture.provider.mockResolvedValueOnce(new Response('secret-provider-debug', { status }))
    const response = await fixture.handler(fixture.request()), body = await response.json()
    expect(response.status).toBe(502)
    expect(body).toMatchObject({ code: 'PROVIDER_REJECTED', status: 'failed' })
    expect(fixture.service.finalizeDispatch.mock.calls[0][0]).toMatchObject({ outcome: 'failed', providerMessageId: null })
    expect(JSON.stringify(body)).not.toContain('secret-provider-debug')
  })

  it.each([409, 500, 503])('중복 응답과 공급자 5xx는 성공으로 기록하지 않고 unknown으로 남긴다: %s', async status => {
    const fixture = setup(); fixture.provider.mockResolvedValueOnce(new Response('{}', { status }))
    const response = await fixture.handler(fixture.request())
    expect(await response.json()).toMatchObject({ code: 'PROVIDER_RESULT_UNKNOWN', status: 'unknown' })
    expect(fixture.service.finalizeDispatch.mock.calls[0][0]).toMatchObject({ outcome: 'unknown', providerMessageId: null })
  })

  it.each(['not-json', '{}', '{"id":null}', '{"id":""}'])('2xx라도 공급자 영수증 ID가 없으면 unknown이다: %s', async text => {
    const fixture = setup(); fixture.provider.mockResolvedValueOnce(new Response(text, { status: 200 }))
    expect(await (await fixture.handler(fixture.request())).json()).toMatchObject({ status: 'unknown' })
    expect(fixture.service.finalizeDispatch.mock.calls[0][0].outcome).toBe('unknown')
  })

  it('네트워크 실패·시간 초과 시 unknown으로 기록하고 공급자를 자동 재시도하지 않는다', async () => {
    const network = setup(); network.provider.mockRejectedValueOnce(new Error('private-resend-test-key'))
    const response = await network.handler(network.request()), body = await response.json()
    expect(body.status).toBe('unknown')
    expect(JSON.stringify(body)).not.toContain('private-resend-test-key')
    const timeout = setup(); timeout.provider.mockImplementationOnce(() => new Promise(() => {}))
    expect(await (await timeout.handler(timeout.request())).json()).toMatchObject({ status: 'unknown' })
    expect(timeout.provider).toHaveBeenCalledTimes(1)
    expect(timeout.service.finalizeDispatch.mock.calls[0][0].outcome).toBe('unknown')
  })

  it('확정 실패의 재시도는 변경되지 않은 DB idempotency key를 다시 사용한다', async () => {
    const fixture = setup()
    fixture.provider.mockResolvedValueOnce(new Response('{}', { status: 429 }))
    await fixture.handler(fixture.request())
    fixture.draft.status = 'failed'; fixture.draft.attempts = 1
    await fixture.handler(fixture.request())
    expect(fixture.provider).toHaveBeenCalledTimes(2)
    expect(fixture.provider.mock.calls.map(call => (call[1]?.headers as Record<string, string>)['idempotency-key'])).toEqual([fixture.draft.idempotency_key, fixture.draft.idempotency_key])
  })

  it('공급자 접수 후 DB 최종 기록에 실패하면 성공으로 응답하지 않는다', async () => {
    const fixture = setup()
    fixture.service.finalizeDispatch.mockResolvedValueOnce({ data: null, error: { message: 'private-service-test-key database failure' } } as never)
    const response = await fixture.handler(fixture.request()), body = await response.json()
    expect(response.status).toBe(503)
    expect(body).toMatchObject({ code: 'UNCERTAIN_SYNC_FAILURE', status: 'unknown' })
    expect(body.providerMessageId).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('private-service-test-key')
    expect(fixture.provider).toHaveBeenCalledTimes(1)
  })

  it('begin 결과가 다른 스냅샷이면 메일을 보내지 않고 불확실 상태로 종료한다', async () => {
    const fixture = setup()
    fixture.user.beginDispatch.mockResolvedValueOnce(success({ ...fixture.draft, status: 'sending', version: 4, recipient: 'changed@example.test' }))
    expect(await (await fixture.handler(fixture.request())).json()).toMatchObject({ status: 'unknown' })
    expect(fixture.provider).not.toHaveBeenCalled()
    expect(fixture.service.finalizeDispatch.mock.calls[0][0].outcome).toBe('unknown')
  })
})
