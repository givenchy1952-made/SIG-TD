import { describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { APPROVAL_PENDING_MESSAGE, assertApprovedLogin, signInAfterApproval, signupForApproval, isApprovalAuthFlowPending, subscribeApprovalAuthFlow } from '../src/lib/approval-login'

const USER = '10000000-0000-4000-8000-000000000006'
const profile = { id: USER, role: 'factory', approved: true, active: true, factory_id: '20000000-0000-4000-8000-000000000001' }
const user = { id: USER, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-10-26T00:00:00Z' }
function fixture(options: { row?: unknown; queryError?: boolean; authError?: boolean; confirmEmail?: boolean; signoutError?: boolean } = {}) {
  const requests: { url: URL; method: string; body: Record<string, unknown> }[] = []
  const payload = { sub: USER, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' }
  const token = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify(payload))}.fixture-only-signature`
  const authResponse = { access_token: token, token_type: 'bearer', expires_in: 3600, refresh_token: 'fixture-refresh', user }
  const client = createClient('https://approval-fixture.supabase.co', 'sb_publishable_fixture_only', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(href)
      requests.push({ url, method: init?.method || 'GET', body: JSON.parse(String(init?.body || '{}')) })
      let status = 200, body: unknown
      if (url.pathname.endsWith('/token')) {
        if (options.authError) { status = 400; body = { error_code: 'invalid_credentials', msg: 'Invalid login credentials' } }
        else body = authResponse
      } else if (url.pathname.endsWith('/signup')) body = options.confirmEmail ? user : authResponse
      else if (url.pathname.endsWith('/profiles')) {
        if (options.queryError) { status = 503; body = { code: 'FIXTURE_OFFLINE', message: 'fixture query failure' } }
        else body = options.row === undefined ? profile : options.row
      } else if (url.pathname.endsWith('/logout')) {
        if (options.signoutError) { status = 500; body = { msg: 'fixture logout failure' } }
        else { status = 204; body = null }
      } else throw new Error(`Unexpected fixture request: ${url.pathname}`)
      return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    } },
  })
  return { client, requests }
}

describe('승인과 공장 배정 후 로그인 — 실제 Supabase SDK의 메모리 mock', () => {
  it('승인된 공장 계정은 자신의 승인·배정 정보를 확인한 뒤 로그인한다', async () => {
    const { client, requests } = fixture()
    await signInAfterApproval(client, ' fixture@example.test ', 'fixture-password-only')
    const lookup = requests.find(request => request.url.pathname.endsWith('/profiles'))!
    expect(lookup.url.searchParams.get('id')).toBe(`eq.${USER}`)
    expect(lookup.url.searchParams.get('select')).toBe('id,role,approved,active,factory_id')
    expect((await client.auth.getSession()).data.session?.user.id).toBe(USER)
    expect(requests.filter(request => request.url.pathname.endsWith('/logout'))).toHaveLength(0)
  })
  it.each(['admin', 'internal'])('승인된 %s는 공장 소속이 없어도 본사 권한으로 로그인한다', async role => {
    const { client } = fixture({ row: { ...profile, role, factory_id: null } })
    await expect(signInAfterApproval(client, 'fixture@example.test', 'fixture-password-only')).resolves.toBeUndefined()
    expect((await client.auth.getSession()).data.session?.user.id).toBe(USER)
  })
  it.each([
    { row: { ...profile, approved: false }, expected: APPROVAL_PENDING_MESSAGE },
    { row: { ...profile, active: false }, expected: '사용 중지' },
    { row: { ...profile, factory_id: null }, expected: '담당 공장' },
    { row: { ...profile, factory_id: ' ' }, expected: '담당 공장' },
    { row: { ...profile, approved: 'true' }, expected: '승인' },
    { row: { ...profile, active: 'true' }, expected: '사용 중지' },
    { row: { ...profile, id: 'another-user' }, expected: '계정 정보' },
    { row: { ...profile, role: 'owner' }, expected: '계정 정보' },
    { row: null, expected: '가입 정보' },
  ])('허용되지 않은 계정은 승인 정보를 확인하고 로컬 로그아웃한다: $expected', async ({ row, expected }) => {
    const { client, requests } = fixture({ row })
    await expect(signInAfterApproval(client, 'fixture@example.test', 'fixture-password-only')).rejects.toThrow(expected)
    const logouts = requests.filter(request => request.url.pathname.endsWith('/logout'))
    expect(logouts).toHaveLength(1); expect(logouts[0].url.searchParams.get('scope')).toBe('local')
    expect((await client.auth.getSession()).data.session).toBeNull()
  })
  it('승인 정보 조회 실패를 로그인 성공으로 처리하지 않고 접속을 종료한다', async () => {
    const { client } = fixture({ queryError: true })
    await expect(signInAfterApproval(client, 'fixture@example.test', 'fixture-password-only')).rejects.toThrow('승인 정보를 확인하지 못했습니다')
    expect((await client.auth.getSession()).data.session).toBeNull()
  })
  it('비밀번호 오류에서는 승인 정보나 다른 사용자 데이터 조회를 시도하지 않는다', async () => {
    const { client, requests } = fixture({ authError: true })
    await expect(signInAfterApproval(client, 'fixture@example.test', 'bad-password')).rejects.toThrow('Invalid login credentials')
    expect(requests).toHaveLength(1)
    expect((await client.auth.getSession()).data.session).toBeNull()
  })
})

describe('메일 인증 없는 가입 요청', () => {
  it('자동 발급된 세션을 바로 종료하고 본사 승인·배정 안내를 표시한다', async () => {
    const { client, requests } = fixture()
    const result = await signupForApproval(client, ' fixture@example.test ', 'fixture-password-only', ' QA 신규 담당자 ')
    expect(result.requiresProviderSetting).toBe(false)
    expect(result.message).toContain('승인·공장 배정')
    expect(result.message).not.toContain('이메일을 인증')
    expect((await client.auth.getSession()).data.session).toBeNull()
    const signup = requests.find(request => request.url.pathname.endsWith('/signup'))!
    expect(signup.body).toMatchObject({ email: 'fixture@example.test', data: { name: 'QA 신규 담당자' } })
    expect(signup.body.data).not.toHaveProperty('role')
    expect(signup.body.data).not.toHaveProperty('approved')
    expect(requests.some(request => request.url.pathname.endsWith('/resend'))).toBe(false)
    expect(requests.some(request => request.url.pathname.endsWith('/profiles'))).toBe(false)
  })
  it('서버가 세션을 발급하지 않으면 메일 인증이 꺼졌다고 단정하지 않고 설정 확인을 안내한다', async () => {
    const { client, requests } = fixture({ confirmEmail: true })
    const result = await signupForApproval(client, 'fixture@example.test', 'fixture-password-only', 'QA 담당자')
    expect(result.requiresProviderSetting).toBe(true)
    expect(result.message).toContain('가입 설정')
    expect((await client.auth.getSession()).data.session).toBeNull()
    expect(requests.some(request => request.url.pathname.endsWith('/logout'))).toBe(false)
  })
})

describe('승인 상태 검증', () => {
  it('로그인 사용자와 다른 프로필이나 알 수 없는 역할을 거부한다', () => {
    expect(() => assertApprovedLogin({ ...profile, id: 'wrong-id' }, USER)).toThrow('계정 정보')
    expect(() => assertApprovedLogin({ ...profile, role: 'unknown' }, USER)).toThrow('계정 정보')
    expect(() => assertApprovedLogin({}, USER)).toThrow('계정 정보')
  })
})


describe('SDK 자동 로그인 중 업무 화면 전환 보호', () => {
  it('승인 조회가 끝나기 전 SIGNED_IN을 보류할 수 있고 실패 후에도 흐름 상태를 해제한다', async () => {
    const { client } = fixture({ row: { ...profile, approved: false } })
    const states: boolean[] = [], signInStates: boolean[] = []
    const stop = subscribeApprovalAuthFlow(() => states.push(isApprovalAuthFlowPending()))
    const { data } = client.auth.onAuthStateChange(event => { if (event === 'SIGNED_IN') signInStates.push(isApprovalAuthFlowPending()) })
    try {
      await expect(signInAfterApproval(client, 'fixture@example.test', 'fixture-password-only')).rejects.toThrow(APPROVAL_PENDING_MESSAGE)
      expect(states).toEqual([true, false])
      expect(signInStates).toEqual([true])
      expect(isApprovalAuthFlowPending()).toBe(false)
    } finally { stop(); data.subscription.unsubscribe() }
  })
  it('메일 인증 없는 가입의 자동 세션과 종료가 모두 가입 안내를 가리지 않게 보류 상태를 제공한다', async () => {
    const { client } = fixture(), events: [string, boolean][] = []
    const { data } = client.auth.onAuthStateChange(event => { if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') events.push([event, isApprovalAuthFlowPending()]) })
    try {
      await signupForApproval(client, 'fixture@example.test', 'fixture-password-only', 'QA 담당자')
      expect(events).toEqual([['SIGNED_IN', true], ['SIGNED_OUT', true]])
      expect(isApprovalAuthFlowPending()).toBe(false)
    } finally { data.subscription.unsubscribe() }
  })
})
