/** Build the fixed-tenant Microsoft ID-token verification contract. JOSE's
 * signature verifier is supplied by the Deno adapter and exercised with real
 * signing keys in tests. The Graph access token is never decoded or trusted as
 * an unsigned JWT. Neither key URLs nor issuers come from token headers.
 */
import type { OutlookConfiguration } from './handler.ts'

export interface MicrosoftJwtOptions {
  algorithms: ['RS256']
  issuer: string
  audience: string
  requiredClaims: string[]
  clockTolerance: number
}
export type VerifyMicrosoftJwt = (token: string, options: MicrosoftJwtOptions, jwksUrl: URL) => Promise<Record<string, unknown>>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function verifyMicrosoftIdentityToken(token: string, configuration: OutlookConfiguration, verifyJwt: VerifyMicrosoftJwt): Promise<{ tenantId: string; objectId: string }> {
  if (!UUID.test(configuration.clientId) || !UUID.test(configuration.tenantId)) throw new Error('invalid Microsoft configuration')
  const tenant = configuration.tenantId.toLowerCase()
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`
  const jwksUrl = new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`)
  const payload = await verifyJwt(token, {
    algorithms: ['RS256'], issuer, audience: configuration.clientId,
    requiredClaims: ['exp', 'iat', 'tid', 'oid'], clockTolerance: 60,
  }, jwksUrl)
  if (typeof payload.tid !== 'string' || !UUID.test(payload.tid) || payload.tid.toLowerCase() !== tenant
    || typeof payload.oid !== 'string' || !UUID.test(payload.oid)
    || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)
    || typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)
    || payload.iat > Date.now() / 1000 + 60 || payload.iat >= payload.exp) throw new Error('invalid Microsoft identity claims')
  return { tenantId: payload.tid.toLowerCase(), objectId: payload.oid }
}
