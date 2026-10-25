import { describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { readAuthCallbackError } from '../src/lib/auth-flow'

const expiredHash = 'http://localhost:3000/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb='

function expectExpiredGuidance(message: string) {
  expect(message).toMatch(/인증|링크/)
  expect(message).toMatch(/만료|유효/)
  expect(message).toMatch(/다시|새로|재발송/)
  expect(message).toContain('본사 담당자')
  expect(message).not.toContain('인증 메일 다시 받기')
  expect(message).not.toContain('Email link is invalid')
}

describe('이메일 인증 콜백 오류 해석', () => {
  it('이전 localhost otp_expired fragment를 본사 설정 확인과 재접속 안내로 바꾼다', () => {
    expectExpiredGuidance(readAuthCallbackError(expiredHash))
  })
  it('배포 주소 query의 otp_expired도 같은 안내로 처리한다', () => {
    const query = 'https://sig-td.vercel.app/?error=access_denied&error_code=otp_expired&error_description=Email%20link%20is%20invalid%20or%20has%20expired'
    expect(readAuthCallbackError(query)).toBe(readAuthCallbackError(expiredHash))
  })
  it('일반 인증 실패는 임의의 서버 설명·HTML·민감 문자열을 노출하지 않는다', () => {
    const marker = '<script>fixture-sensitive-description</script>'
    const href = `https://sig-td.vercel.app/#error=access_denied&error_code=unexpected_fixture_error&error_description=${encodeURIComponent(marker)}`
    const message = readAuthCallbackError(href)
    expect(message).toMatch(/인증|로그인|오류|실패/)
    expect(message).not.toContain(marker)
    expect(message).not.toContain('fixture-sensitive-description')
    expect(message).not.toContain('<script>')
  })
  it.each([
    'https://sig-td.vercel.app/',
    'https://sig-td.vercel.app/?project=2026FW',
    'https://sig-td.vercel.app/#calendar',
    'https://sig-td.vercel.app/#access_token=fixture-access&refresh_token=fixture-refresh&token_type=bearer&expires_in=3600',
    'https://sig-td.vercel.app/?code=fixture-pkce-code',
    'https://sig-td.vercel.app/#access_token=fixture-access&type=recovery',
  ])('정상 주소·세션 토큰·recovery 콜백을 오류로 취급하지 않는다: %s', href => {
    expect(readAuthCallbackError(href)).toBe('')
  })
  it.each(['', 'not a URL', '::::', 'https://'])('잘못된 URL에서도 예외를 내지 않는다: %s', href => {
    expect(() => readAuthCallbackError(href)).not.toThrow()
    expect(readAuthCallbackError(href)).toBe('')
  })
  it('손상된 percent encoding이 있어도 임의 설명을 그대로 출력하지 않는다', () => {
    const href = 'https://sig-td.vercel.app/#error=access_denied&error_description=%E0%A4%A'
    expect(() => readAuthCallbackError(href)).not.toThrow()
    expect(readAuthCallbackError(href)).toMatch(/인증|로그인|오류|실패/)
  })
})

interface CapturedRequest { url: URL; method: string; body: Record<string, unknown> }
function mockClient(status = 200, response: Record<string, unknown> = {}) {
  const requests: CapturedRequest[] = []
  const client = createClient('https://auth-fixture.supabase.co', 'sb_publishable_test_fixture_only', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requests.push({ url: new URL(href), method: init?.method || 'GET', body: JSON.parse(String(init?.body || '{}')) })
      return new Response(JSON.stringify(response), { status, headers: { 'Content-Type': 'application/json' } })
    } },
  })
  return { client, requests }
}

describe('SDK 인증 메일 재발송 요청 — 메모리 mock, 실제 계정·메일 발송 없음', () => {
  it('회원가입을 새로 호출하지 않고 resend에 signup 타입·이메일·배포 redirect를 보낸다', async () => {
    const { client, requests } = mockClient()
    const result = await client.auth.resend({ type: 'signup', email: 'fixture@example.test', options: { emailRedirectTo: 'https://sig-td.vercel.app' } })
    expect(result.error).toBeNull()
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('POST')
    expect(requests[0].url.pathname).toBe('/auth/v1/resend')
    expect(requests[0].url.searchParams.get('redirect_to')).toBe('https://sig-td.vercel.app')
    expect(requests[0].body).toMatchObject({ type: 'signup', email: 'fixture@example.test' })
    expect(requests[0].body).not.toHaveProperty('password')
    expect(requests.some(request => request.url.pathname.endsWith('/signup'))).toBe(false)
  })
  it('재발송 제한은 오류로 반환하고 반복 요청이나 가입 성공으로 처리하지 않는다', async () => {
    const { client, requests } = mockClient(429, { msg: 'Fixture rate limit', error_code: 'over_email_send_rate_limit' })
    const result = await client.auth.resend({ type: 'signup', email: 'fixture@example.test', options: { emailRedirectTo: 'https://sig-td.vercel.app' } })
    expect(result.error).not.toBeNull()
    expect(result.error?.status).toBe(429)
    expect(requests).toHaveLength(1)
    expect(requests[0].url.pathname).toBe('/auth/v1/resend')
  })
})
