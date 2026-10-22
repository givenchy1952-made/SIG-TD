import { Buffer } from 'node:buffer'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { resolveSupabaseConfiguration } from '../src/lib/configuration'
import { message } from '../src/lib/utils'

const PUBLIC_KEY = 'sb_publishable_unit_test_public_key'
const PROJECT = 'https://sig-project.supabase.co'
function jwt(role: string, extra: Record<string, unknown> = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role, ...extra })}.unit-test-signature`
}
function expectHelpfulError(url: string | undefined, key: string | undefined = PUBLIC_KEY) {
  const configuration = resolveSupabaseConfiguration(url, key)
  expect(configuration.error.length).toBeGreaterThan(5)
  expect(configuration.error).toMatch(/[가-힣]/)
  if (key) expect(configuration.error).not.toContain(key)
  return configuration
}

describe('Supabase 공개 설정의 URL 정규화', () => {
  it('설정이 모두 없으면 체험 모드를 위한 빈 결과를 반환한다', () => {
    expect(resolveSupabaseConfiguration()).toEqual({ url: '', key: '', error: '' })
    expect(resolveSupabaseConfiguration(' \n ', '\t ')).toEqual({ url: '', key: '', error: '' })
  })

  it('URL과 키의 앞뒤 공백을 제거한다', () => {
    expect(resolveSupabaseConfiguration(`  ${PROJECT} \n`, `\t${PUBLIC_KEY} `)).toEqual({ url: PROJECT, key: PUBLIC_KEY, error: '' })
  })

  it.each([
    [PROJECT, undefined], [undefined, PUBLIC_KEY], ['', PUBLIC_KEY], [PROJECT, '  '],
  ])('한쪽 설정이 빠지면 올바른 설정 방법을 안내한다 (%s)', (url, key) => {
    expectHelpfulError(url, key ?? '')
  })

  it.each([
    [PROJECT, PROJECT], [`${PROJECT}/`, PROJECT],
    ['https://auth.company.example', 'https://auth.company.example'],
    ['https://AUTH.company.example/', 'https://auth.company.example'],
    ['https://custom.example:8443/', 'https://custom.example:8443'],
    ['http://localhost:54321', 'http://localhost:54321'],
    ['http://127.0.0.1:54321/', 'http://127.0.0.1:54321'],
    ['http://[::1]:54321/', 'http://[::1]:54321'],
  ])('프로젝트 루트 또는 지원하는 로컬 URL %s을 허용한다', (url, origin) => {
    const configuration = resolveSupabaseConfiguration(url, PUBLIC_KEY)
    expect(configuration.error).toBe('')
    expect(configuration.url).toBe(origin)
  })

  it.each(['rest', 'auth', 'storage', 'functions', 'realtime'])('%s/v1 서비스 주소를 프로젝트 루트로 정규화한다', service => {
    for (const suffix of ['', '/']) {
      const configuration = resolveSupabaseConfiguration(`${PROJECT}/${service}/v1${suffix}`, PUBLIC_KEY)
      expect(configuration).toEqual({ url: PROJECT, key: PUBLIC_KEY, error: '' })
    }
  })

  it.each([
    `${PROJECT}/rest/v1/styles`, `${PROJECT}/auth/v1/signup`, `${PROJECT}/storage/v1/object`,
    `${PROJECT}/unknown`, `${PROJECT}/dashboard/project/abc`, `${PROJECT}/rest/v2`,
    `${PROJECT}/?apikey=not-allowed`, `${PROJECT}/#project`,
    'https://user:password@sig-project.supabase.co', 'https://user@sig-project.supabase.co',
    'http://sig-project.supabase.co', 'http://custom.company.example', 'http://localhost.evil.example:54321',
    'ftp://sig-project.supabase.co', 'file:///tmp/supabase', 'javascript:alert(1)', 'not-a-valid-url',
  ])('잘못된 경로·접속 정보·프로토콜을 허용하지 않는다: %s', url => {
    expectHelpfulError(url)
  })
})

describe('브라우저용 Supabase 키 제한', () => {
  it('공개 publishable 키와 anon JWT를 허용한다', () => {
    expect(resolveSupabaseConfiguration(PROJECT, PUBLIC_KEY).error).toBe('')
    const anon = jwt('anon')
    expect(resolveSupabaseConfiguration(PROJECT, anon)).toEqual({ url: PROJECT, key: anon, error: '' })
  })

  it('새 형식 서버 비밀 키를 거부하고 오류에 값을 노출하지 않는다', () => {
    expectHelpfulError(PROJECT, 'sb_secret_do_not_print_this_private_key')
  })

  it('padding 없는 base64url service_role JWT를 거부한다', () => {
    const secret = jwt('service_role', { ref: 'sig-test', description: '권한 테스트 🧥' })
    expect(secret.split('.')[1]).not.toContain('=')
    expectHelpfulError(PROJECT, secret)
  })
})

describe('정규화된 설정에서 실제 SDK 회원가입 요청 경로', () => {
  it.each([PROJECT, `${PROJECT}/`, `${PROJECT}/rest/v1`, `${PROJECT}/auth/v1/`])('%s 설정으로 가입하면 /auth/v1/signup에 요청한다', async rawUrl => {
    const configuration = resolveSupabaseConfiguration(rawUrl, PUBLIC_KEY)
    expect(configuration.error).toBe('')
    const requests: { url: string; method: string }[] = []
    const client = createClient(configuration.url, configuration.key, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: async (input, init) => {
        requests.push({ url: input instanceof Request ? input.url : String(input), method: init?.method || (input instanceof Request ? input.method : 'GET') })
        return new Response(JSON.stringify({ user: { id: '20000000-0000-4000-8000-000000000001', email: 'signup@example.test', identities: [] }, session: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      } },
    })
    const result = await client.auth.signUp({ email: 'signup@example.test', password: 'unit-test-only-password-4477' })
    expect(result.error).toBeNull()
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('POST')
    const requestUrl = new URL(requests[0].url)
    expect(requestUrl.origin).toBe(PROJECT)
    expect(requestUrl.pathname).toBe('/auth/v1/signup')
    expect(requestUrl.pathname).not.toContain('/rest/v1/auth')
  })

  it.each(['login', 'reset'] as const)('REST URL 설정으로 %s 요청도 올바른 Auth 경로를 사용한다', async operation => {
    const configuration = resolveSupabaseConfiguration(`${PROJECT}/rest/v1/`, PUBLIC_KEY)
    const requests: { url: string; method: string }[] = []
    const client = createClient(configuration.url, configuration.key, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: async (input, init) => {
        requests.push({ url: input instanceof Request ? input.url : String(input), method: init?.method || 'GET' })
        return new Response(JSON.stringify(operation === 'login' ? { code: 'invalid_credentials', msg: 'Invalid login credentials' } : {}), { status: operation === 'login' ? 400 : 200, headers: { 'Content-Type': 'application/json' } })
      } },
    })
    const result = operation === 'login'
      ? await client.auth.signInWithPassword({ email: 'login@example.test', password: 'test-only-not-a-real-account' })
      : await client.auth.resetPasswordForEmail('reset@example.test', { redirectTo: 'https://app.example.test' })
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('POST')
    const url = new URL(requests[0].url)
    expect(url.origin).toBe(PROJECT)
    expect(url.pathname).toBe(operation === 'login' ? '/auth/v1/token' : '/auth/v1/recover')
    if (operation === 'login') {
      expect(url.searchParams.get('grant_type')).toBe('password')
      expect(result.error).not.toBeNull()
    } else expect(result.error).toBeNull()
  })

  it('서버의 경로 오류를 연결 설정 안내로 표시한다', () => {
    const text = message({ message: 'Invalid path specified in request URL' })
    expect(text).toContain('Supabase 프로젝트 기본 주소')
    expect(text).not.toContain('Invalid path')
  })
})
