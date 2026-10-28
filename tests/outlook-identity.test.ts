import { beforeAll, describe, expect, it } from 'vitest'
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose'
import { verifyMicrosoftIdentityToken, type MicrosoftJwtOptions, type VerifyMicrosoftJwt } from '../supabase/functions/send-po-outlook/identity'

const CLIENT = '81000000-0000-4000-8000-000000000001'
const TENANT = '82000000-0000-4000-8000-000000000001'
const OBJECT = '10000000-0000-4000-8000-000000000001'
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`
const CONFIG = { clientId: CLIENT, tenantId: TENANT }
let key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
let otherKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
let keys: ReturnType<typeof createLocalJWKSet>

beforeAll(async () => {
  const trusted = await generateKeyPair('RS256', { extractable: true })
  const untrusted = await generateKeyPair('RS256', { extractable: true })
  key = trusted.privateKey; otherKey = untrusted.privateKey
  keys = createLocalJWKSet({ keys: [{ ...await exportJWK(trusted.publicKey), kid: 'trusted-microsoft-key', alg: 'RS256', use: 'sig' }] })
})

async function token(options: { issuer?: string; audience?: string; claims?: Record<string, unknown>; omit?: string[]; signingKey?: typeof key; header?: Record<string, unknown> } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const claims: Record<string, unknown> = { iss: options.issuer ?? ISSUER, aud: options.audience ?? CLIENT, iat: now - 5, exp: now + 3600, tid: TENANT, oid: OBJECT, ...options.claims }
  for (const name of options.omit ?? []) delete claims[name]
  return await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'trusted-microsoft-key', ...options.header }).sign(options.signingKey ?? key)
}

const verify: VerifyMicrosoftJwt = async (proof, options, jwksUrl) => {
  expect(jwksUrl.toString()).toBe(`https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`)
  const result = await jwtVerify(proof, keys, options)
  return result.payload
}

describe('Microsoft ID 토큰: 실제 JOSE 서명·회사·앱·만료 검증', () => {
  it('신뢰한 키가 서명한 해당 회사·앱의 유효한 토큰만 인증한다', async () => {
    expect(await verifyMicrosoftIdentityToken(await token(), CONFIG, verify)).toEqual({ tenantId: TENANT, objectId: OBJECT })
  })

  it('공격자가 같은 kid로 서명한 토큰을 거절한다', async () => {
    await expect(verifyMicrosoftIdentityToken(await token({ signingKey: otherKey }), CONFIG, verify)).rejects.toThrow()
  })

  it('서명 후 바꾼 객체 ID를 거절한다', async () => {
    const signed = await token(), segments = signed.split('.')
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString())
    payload.oid = CLIENT; segments[1] = Buffer.from(JSON.stringify(payload)).toString('base64url')
    await expect(verifyMicrosoftIdentityToken(segments.join('.'), CONFIG, verify)).rejects.toThrow()
  })

  it('다른 Microsoft 앱 audience는 올바른 키로 서명해도 거절한다', async () => {
    await expect(verifyMicrosoftIdentityToken(await token({ audience: TENANT }), CONFIG, verify)).rejects.toThrow()
  })

  it.each([`https://login.microsoftonline.com/${CLIENT}/v2.0`, 'https://attacker.example/issuer', `https://sts.windows.net/${TENANT}/`])('다른 issuer를 거절한다: %s', async issuer => {
    await expect(verifyMicrosoftIdentityToken(await token({ issuer }), CONFIG, verify)).rejects.toThrow()
  })

  it('서명과 issuer가 맞아도 tid가 다른 회사를 가리키면 거절한다', async () => {
    await expect(verifyMicrosoftIdentityToken(await token({ claims: { tid: CLIENT } }), CONFIG, verify)).rejects.toThrow()
  })

  it('만료 시각과 60초 허용 범위를 넘은 토큰을 거절한다', async () => {
    const now = Math.floor(Date.now() / 1000)
    await expect(verifyMicrosoftIdentityToken(await token({ claims: { iat: now - 3600, exp: now - 120 } }), CONFIG, verify)).rejects.toThrow()
  })

  it('60초 이내의 서버 시계 차이는 허용한다', async () => {
    const now = Math.floor(Date.now() / 1000)
    expect(await verifyMicrosoftIdentityToken(await token({ claims: { iat: now - 3600, exp: now - 20 } }), CONFIG, verify)).toEqual({ tenantId: TENANT, objectId: OBJECT })
  })

  it('미래 발급 iat 또는 아직 사용 불가한 nbf를 거절한다', async () => {
    const now = Math.floor(Date.now() / 1000)
    await expect(verifyMicrosoftIdentityToken(await token({ claims: { iat: now + 120 } }), CONFIG, verify)).rejects.toThrow()
    await expect(verifyMicrosoftIdentityToken(await token({ claims: { nbf: now + 120 } }), CONFIG, verify)).rejects.toThrow()
  })

  it.each(['exp', 'iat', 'tid', 'oid', 'iss', 'aud'])('필수 인증 claim이 없으면 거절한다: %s', async missing => {
    await expect(verifyMicrosoftIdentityToken(await token({ omit: [missing] }), CONFIG, verify)).rejects.toThrow()
  })

  it.each([{ oid: 'not-a-guid' }, { tid: 123 }, { iat: 'yesterday' }, { exp: 'tomorrow' }])('잘못된 claim 형식을 거절한다: %j', async claims => {
    await expect(verifyMicrosoftIdentityToken(await token({ claims }), CONFIG, verify)).rejects.toThrow()
  })

  it('RS256 이외 알고리즘을 허용하지 않는다', async () => {
    const now = Math.floor(Date.now() / 1000)
    const proof = await new SignJWT({ tid: TENANT, oid: OBJECT, iat: now, exp: now + 3600 }).setIssuer(ISSUER).setAudience(CLIENT).setProtectedHeader({ alg: 'HS256', kid: 'trusted-microsoft-key' }).sign(new Uint8Array(32).fill(7))
    await expect(verifyMicrosoftIdentityToken(proof, CONFIG, verify)).rejects.toThrow()
  })

  it('토큰 헤더의 외부 jku를 키 조회 주소로 사용하지 않는다', async () => {
    const proof = await token({ header: { jku: 'https://attacker.example/keys' } })
    expect(await verifyMicrosoftIdentityToken(proof, CONFIG, verify)).toEqual({ tenantId: TENANT, objectId: OBJECT })
  })

  it('잘못된 설정 ID는 키 조회 전에 거절하고 고정 Microsoft 검증 옵션을 사용한다', async () => {
    let options: MicrosoftJwtOptions | undefined
    const capture: VerifyMicrosoftJwt = async (proof, expected, url) => { options = expected; return await verify(proof, expected, url) }
    expect(await verifyMicrosoftIdentityToken(await token(), CONFIG, capture)).toEqual({ tenantId: TENANT, objectId: OBJECT })
    expect(options).toEqual({ algorithms: ['RS256'], issuer: ISSUER, audience: CLIENT, requiredClaims: ['exp', 'iat', 'tid', 'oid'], clockTolerance: 60 })
    await expect(verifyMicrosoftIdentityToken(await token(), { ...CONFIG, tenantId: 'https://attacker.example' }, capture)).rejects.toThrow()
  })
})
