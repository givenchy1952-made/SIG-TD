import type { AccountInfo, AuthenticationResult, IPublicClientApplication } from '@azure/msal-browser'
import { supabase } from './repository'

export interface OutlookConfiguration { clientId: string; tenantId: string; version: number; updatedAt?: string }
export interface OutlookIdentity { email: string; name: string }
export interface OutlookAuthorization { accessToken: string; idToken: string }
export type OutlookMailState = { mode: 'loading' | 'demo' | 'unavailable' | 'unconfigured' | 'configured'; configuration: OutlookConfiguration | null; identity: OutlookIdentity | null }
export const OUTLOOK_ATTACHMENT_LIMIT = 2 * 1024 * 1024
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SCOPES = ['User.Read', 'Mail.Send']
const clients = new Map<string, Promise<IPublicClientApplication>>()
const verifiedAccounts = new Map<string, string>()
const normalizedEmail = (email: string) => email.trim().toLowerCase()

export function outlookCallbackUrl(origin = window.location.origin): string {
  const url = new URL(origin)
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error('Outlook 연결 주소를 확인해 주세요.')
  return new URL('/outlook-callback.html', url).href
}

export function readOutlookConfiguration(value: unknown): OutlookConfiguration | null {
  if (value === null) return null
  if (!value || typeof value !== 'object') throw new Error('Microsoft 365 설정을 확인할 수 없습니다.')
  const row = value as Record<string, unknown>
  if (typeof row.clientId !== 'string' || !GUID.test(row.clientId) || typeof row.tenantId !== 'string' || !GUID.test(row.tenantId) || !Number.isSafeInteger(row.version) || Number(row.version) < 1) throw new Error('Microsoft 365 앱 ID와 테넌트 ID 설정을 확인해 주세요.')
  return { clientId: row.clientId, tenantId: row.tenantId, version: Number(row.version), ...(typeof row.updatedAt === 'string' ? { updatedAt: row.updatedAt } : {}) }
}

function configurationError(error: { code?: string; message?: string }): Error {
  if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(error.code || '')) return new Error('Outlook 발송 기능 설정이 필요합니다. 관리자에게 문의해 주세요.')
  if (error.code === '42501') return new Error('승인된 본사 계정만 Microsoft 365 발송 설정을 사용할 수 있습니다.')
  if (error.code === '40001') return new Error('다른 관리자가 먼저 설정을 바꿨습니다. 최신 설정을 다시 불러온 뒤 저장해 주세요.')
  return new Error('Microsoft 365 설정을 저장하거나 불러오지 못했습니다. 연결 상태를 확인해 주세요.')
}

export async function loadOutlookConfiguration(): Promise<OutlookConfiguration | null> {
  if (!supabase) return null
  const result = await supabase.rpc('get_outlook_configuration')
  if (result.error) throw configurationError(result.error)
  return readOutlookConfiguration(result.data)
}

export async function saveOutlookConfiguration(clientId: string, tenantId: string, expectedVersion: number, reason: string): Promise<OutlookConfiguration> {
  if (!supabase) throw new Error('체험 모드에서는 회사 Microsoft 365 설정을 저장하지 않습니다.')
  if (!GUID.test(clientId.trim()) || !GUID.test(tenantId.trim())) throw new Error('Microsoft 앱 ID와 테넌트 ID는 각각 올바른 UUID를 입력해 주세요.')
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || reason.trim().length < 2 || reason.trim().length > 1000) throw new Error('설정 버전과 변경 사유를 확인해 주세요.')
  const result = await supabase.rpc('save_outlook_configuration', { p_client_id: clientId.trim(), p_tenant_id: tenantId.trim(), p_expected_version: expectedVersion, p_reason: reason.trim() })
  if (result.error) throw configurationError(result.error)
  const saved = readOutlookConfiguration(result.data)
  if (!saved) throw new Error('Microsoft 365 설정 저장 결과를 확인할 수 없습니다. 최신 설정을 다시 불러와 주세요.')
  return saved
}

export function isOutlookCloudAvailable(): boolean { return !!supabase }

export async function prepareOutlookClient(configuration: OutlookConfiguration): Promise<IPublicClientApplication> {
  // Configuration is editable public application metadata; credentials are never
  // accepted here. All token exchange/state/PKCE handling belongs to MSAL.
  readOutlookConfiguration(configuration)
  const redirectUri = outlookCallbackUrl()
  const key = `${configuration.tenantId}:${configuration.clientId}:${redirectUri}`
  let client = clients.get(key)
  if (!client) {
    client = (async () => {
      const { PublicClientApplication } = await import('@azure/msal-browser')
      const instance = new PublicClientApplication({ auth: { clientId: configuration.clientId, authority: `https://login.microsoftonline.com/${configuration.tenantId}`, redirectUri, navigateToLoginRequestUrl: false }, cache: { cacheLocation: 'sessionStorage' }, system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => undefined } } })
      await instance.initialize()
      return instance
    })()
    clients.set(key, client)
    void client.catch(() => { clients.delete(key) })
  }
  return client
}

function mappingKey(configuration: OutlookConfiguration, email: string): string { return `sig-outlook-account:${configuration.tenantId}:${configuration.clientId}:${normalizedEmail(email)}` }
function verifiedAccount(configuration: OutlookConfiguration, email: string): string | null {
  const key = mappingKey(configuration, email)
  if (verifiedAccounts.has(key)) return verifiedAccounts.get(key) || null
  try { const value = sessionStorage.getItem(key); if (value && value.length <= 1024) { verifiedAccounts.set(key, value); return value } } catch { /* Memory-only fallback when session storage is unavailable. */ }
  return null
}
function rememberAccount(configuration: OutlookConfiguration, email: string, accountId: string | null): void {
  const key = mappingKey(configuration, email)
  if (accountId) verifiedAccounts.set(key, accountId); else verifiedAccounts.delete(key)
  // Only the public account mapping is saved here. MSAL owns every token.
  try { if (accountId) sessionStorage.setItem(key, accountId); else sessionStorage.removeItem(key) } catch { /* The current tab still has the mapping. */ }
}
function accountFor(instance: IPublicClientApplication, configuration: OutlookConfiguration, email: string): AccountInfo | null {
  const accounts = instance.getAllAccounts(), mapped = verifiedAccount(configuration, email)
  if (mapped) {
    const account = accounts.find(item => item.homeAccountId === mapped)
    if (account) return account
    rememberAccount(configuration, email, null)
  }
  return accounts.find(account => normalizedEmail(account.username) === normalizedEmail(email)) || null
}
async function verifyMailbox(configuration: OutlookConfiguration, expectedEmail: string, account: AccountInfo, accessToken: string): Promise<OutlookIdentity> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000)
  try {
    if (!accessToken) throw new Error('Outlook 연결이 만료되었습니다. 계정을 다시 연결해 주세요.')
    const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName', { headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: controller.signal })
    if (!response.ok) throw new Error('Outlook 메일함 주소를 확인하지 못했습니다. 회사 계정을 다시 연결해 주세요.')
    const row: unknown = await response.json()
    if (!row || typeof row !== 'object') throw new Error('Outlook 메일함 주소를 확인하지 못했습니다.')
    const mailbox = row as Record<string, unknown>
    if (typeof mailbox.id !== 'string' || mailbox.id !== account.localAccountId || typeof mailbox.mail !== 'string' || normalizedEmail(mailbox.mail) !== normalizedEmail(expectedEmail)) throw new Error('사이트 가입 이메일과 같은 메일함의 회사 Microsoft 365 계정으로 연결해 주세요.')
    rememberAccount(configuration, expectedEmail, account.homeAccountId)
    return { email: normalizedEmail(mailbox.mail), name: typeof mailbox.displayName === 'string' && mailbox.displayName ? mailbox.displayName : account.name || mailbox.mail }
  } catch (error) { rememberAccount(configuration, expectedEmail, null); throw error }
  finally { clearTimeout(timer) }
}

export async function connectedOutlookIdentity(configuration: OutlookConfiguration, email: string): Promise<OutlookIdentity | null> {
  const client = await prepareOutlookClient(configuration)
  const mapped = verifiedAccount(configuration, email), account = accountFor(client, configuration, email)
  if (!account) return null
  if (mapped === account.homeAccountId) return { email: normalizedEmail(email), name: account.name || email }
  // An account cached by MSAL is not proof that its primary mailbox matches the
  // site profile. Restore silently; never open an account popup on page load.
  try {
    const result = await client.acquireTokenSilent({ scopes: SCOPES, account })
    if (!result.account || result.account.homeAccountId !== account.homeAccountId) return null
    return await verifyMailbox(configuration, email, result.account, result.accessToken)
  } catch { rememberAccount(configuration, email, null); return null }
}

export async function connectOutlook(configuration: OutlookConfiguration, email: string): Promise<OutlookIdentity> {
  const client = await prepareOutlookClient(configuration)
  rememberAccount(configuration, email, null)
  try {
    const result = await client.loginPopup({ scopes: SCOPES, loginHint: email, prompt: 'select_account' })
    if (!result.account) throw new Error('Microsoft 365 계정을 확인하지 못했습니다. 다시 연결해 주세요.')
    const identity = await verifyMailbox(configuration, email, result.account, result.accessToken)
    client.setActiveAccount(result.account)
    return identity
  } catch (error) { rememberAccount(configuration, email, null); throw error }
}

export async function acquireOutlookAuthorization(configuration: OutlookConfiguration, email: string): Promise<OutlookAuthorization> {
  const client = await prepareOutlookClient(configuration)
  const account = accountFor(client, configuration, email)
  if (!account) throw new Error('먼저 본인의 Outlook 계정을 연결해 주세요.')
  async function acquire(forceRefresh = false): Promise<AuthenticationResult> {
    try { return await client.acquireTokenSilent({ scopes: SCOPES, account: account!, ...(forceRefresh ? { forceRefresh: true } : {}) }) }
    catch (error) {
      const { InteractionRequiredAuthError } = await import('@azure/msal-browser')
      if (!(error instanceof InteractionRequiredAuthError)) throw error
      return await client.acquireTokenPopup({ scopes: SCOPES, account: account!, loginHint: email })
    }
  }
  let result = await acquire()
  const identityExpiry = (result.idTokenClaims as { exp?: unknown } | undefined)?.exp
  if (typeof identityExpiry === 'number' && identityExpiry <= Math.floor(Date.now() / 1000) + 60) result = await acquire(true)
  if (!result.account || result.account.homeAccountId !== account.homeAccountId) { rememberAccount(configuration, email, null); throw new Error('사이트 가입 이메일과 같은 메일함의 회사 Microsoft 365 계정으로 연결해 주세요.') }
  if (!result.accessToken || !result.idToken || result.expiresOn && result.expiresOn.getTime() <= Date.now()) throw new Error('Outlook 연결이 만료되었습니다. 계정을 다시 연결해 주세요.')
  // The server verifies the signed identity token's configured app/tenant/oid,
  // then compares the Graph mailbox for the access token. Neither token is
  // copied to application storage or included in logs or URLs.
  return { accessToken: result.accessToken, idToken: result.idToken }
}

export async function disconnectOutlook(configuration: OutlookConfiguration, email: string): Promise<void> {
  const client = await prepareOutlookClient(configuration)
  const account = accountFor(client, configuration, email)
  if (account) await client.clearCache({ account })
  rememberAccount(configuration, email, null)
  // Do not navigate to Microsoft logout: that would also sign out Outlook.
}

export function outlookConnectionError(error: unknown): string {
  const code = error && typeof error === 'object' && 'errorCode' in error ? String(error.errorCode) : ''
  if (['user_cancelled', 'user_canceled'].includes(code)) return 'Outlook 연결을 취소했습니다. 메일은 발송하지 않았습니다.'
  if (['popup_window_error', 'empty_window_error', 'popup_window_timeout', 'monitor_popup_timeout'].includes(code)) return '브라우저에서 이 사이트의 팝업을 허용한 뒤 Outlook을 다시 연결해 주세요.'
  if (['consent_required', 'interaction_required'].includes(code)) return 'Microsoft 365의 메일 발송 권한 승인이 필요합니다. 관리자에게 연결 승인을 요청해 주세요.'
  if (code) return 'Outlook 계정을 연결하지 못했습니다. 회사 계정과 Microsoft 앱 등록·승인 상태를 확인해 주세요.'
  return error instanceof Error ? error.message : 'Outlook 연결을 확인할 수 없습니다. 다시 시도해 주세요.'
}
