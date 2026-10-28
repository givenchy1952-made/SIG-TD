import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), constructor: vi.fn(), initialize: vi.fn(), getAllAccounts: vi.fn(), loginPopup: vi.fn(), acquireTokenSilent: vi.fn(), acquireTokenPopup: vi.fn(), clearCache: vi.fn(), setActiveAccount: vi.fn() }))
vi.mock('../src/lib/repository', () => ({ supabase: { rpc: mocks.rpc } }))
vi.mock('@azure/msal-browser', () => ({
  InteractionRequiredAuthError: class extends Error { errorCode = 'interaction_required' },
  PublicClientApplication: class {
    constructor(configuration: unknown) { mocks.constructor(configuration) }
    initialize = mocks.initialize
    getAllAccounts = mocks.getAllAccounts
    loginPopup = mocks.loginPopup
    acquireTokenSilent = mocks.acquireTokenSilent
    acquireTokenPopup = mocks.acquireTokenPopup
    clearCache = mocks.clearCache
    setActiveAccount = mocks.setActiveAccount
  },
}))

const configuration = { clientId: '11111111-1111-4111-8111-111111111111', tenantId: '22222222-2222-4222-8222-222222222222', version: 1 }
const account = { homeAccountId: 'own-account', localAccountId: '33333333-3333-4333-8333-333333333333', username: 'staff@example.test', name: '본사 담당자' }
const other = { homeAccountId: 'other-account', localAccountId: '44444444-4444-4444-8444-444444444444', username: 'other@example.test', name: '다른 담당자' }
let mail: typeof import('../src/lib/outlook-mail')

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks()
  vi.stubGlobal('window', { location: { origin: 'https://workspace.example.test' } })
  mocks.initialize.mockResolvedValue(undefined); mocks.getAllAccounts.mockReturnValue([other, account]); mocks.clearCache.mockResolvedValue(undefined)
  mocks.rpc.mockResolvedValue({ data: configuration, error: null })
  mocks.loginPopup.mockResolvedValue({ account, accessToken: 'private-test-token', idToken: 'private-test-id-token' }); mocks.acquireTokenSilent.mockResolvedValue({ account, accessToken: 'private-test-token', idToken: 'private-test-id-token', expiresOn: new Date(Date.now() + 60000) })
  const values = new Map<string, string>()
  vi.stubGlobal('sessionStorage', { getItem: vi.fn((key: string) => values.get(key) || null), setItem: vi.fn((key: string, value: string) => values.set(key, value)), removeItem: vi.fn((key: string) => values.delete(key)) })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: account.localAccountId, mail: account.username, displayName: account.name, userPrincipalName: account.username })))
  mail = await import('../src/lib/outlook-mail')
})

describe('Microsoft 365 client connection', () => {
  it('accepts configured public IDs, rejects malformed and unversioned data', () => {
    expect(mail.readOutlookConfiguration(null)).toBeNull()
    expect(mail.readOutlookConfiguration(configuration)).toEqual(configuration)
    for (const value of [undefined, [], {}, { ...configuration, tenantId: 'https://untrusted.example' }, { ...configuration, version: 0 }, { ...configuration, version: 1.5 }]) expect(() => mail.readOutlookConfiguration(value)).toThrow()
  })
  it('uses a fixed isolated callback page and rejects non-origin input', () => {
    expect(mail.outlookCallbackUrl()).toBe('https://workspace.example.test/outlook-callback.html')
    for (const origin of ['javascript:alert(1)', 'https://workspace.example.test/extra', 'https://user:password@workspace.example.test', 'https://workspace.example.test?token=private']) expect(() => mail.outlookCallbackUrl(origin)).toThrow()
  })
  it('loads public application configuration through the approved RPC', async () => {
    expect(await mail.loadOutlookConfiguration()).toEqual(configuration)
    expect(mocks.rpc).toHaveBeenCalledWith('get_outlook_configuration')
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'internal SQL error' } })
    await expect(mail.loadOutlookConfiguration()).rejects.toThrow('관리자에게 문의')
  })
  it('validates setup data and uses the expected configuration version', async () => {
    await expect(mail.saveOutlookConfiguration('wrong', configuration.tenantId, 0, '설정')).rejects.toThrow('UUID')
    await expect(mail.saveOutlookConfiguration(configuration.clientId, configuration.tenantId, 0, 'a')).rejects.toThrow('변경 사유')
    expect(mocks.rpc).not.toHaveBeenCalled()
    await mail.saveOutlookConfiguration(` ${configuration.clientId} `, configuration.tenantId, 0, ' 최초 설정 ')
    expect(mocks.rpc).toHaveBeenCalledWith('save_outlook_configuration', { p_client_id: configuration.clientId, p_tenant_id: configuration.tenantId, p_expected_version: 0, p_reason: '최초 설정' })
  })
  it('exposes a configuration conflict without overwriting it automatically', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '40001' } })
    await expect(mail.saveOutlookConfiguration(configuration.clientId, configuration.tenantId, 1, '설정 변경')).rejects.toThrow('다른 관리자')
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })
  it('caches initialization, uses a tenant-bound authority and limits browser caching to the session', async () => {
    expect(await mail.connectedOutlookIdentity(configuration, 'STAFF@example.test')).toEqual({ email: account.username, name: account.name })
    await mail.connectedOutlookIdentity(configuration, account.username)
    expect(mocks.initialize).toHaveBeenCalledTimes(1)
    const config = mocks.constructor.mock.calls[0][0]
    expect(config.auth.authority).toBe(`https://login.microsoftonline.com/${configuration.tenantId}`)
    expect(config.auth.redirectUri).toBe('https://workspace.example.test/outlook-callback.html')
    expect(config.cache.cacheLocation).toBe('sessionStorage')
    expect(config.system.loggerOptions.piiLoggingEnabled).toBe(false)
  })
  it('does not use another cached employee account', async () => {
    mocks.getAllAccounts.mockReturnValue([other])
    expect(await mail.connectedOutlookIdentity(configuration, account.username)).toBeNull()
    await expect(mail.acquireOutlookAuthorization(configuration, account.username)).rejects.toThrow('본인의 Outlook')
    expect(mocks.acquireTokenSilent).not.toHaveBeenCalled()
  })
  it('requests delegated User.Read and Mail.Send for the site account', async () => {
    await expect(mail.connectOutlook(configuration, account.username)).resolves.toEqual({ email: account.username, name: account.name })
    expect(mocks.loginPopup).toHaveBeenCalledWith({ scopes: ['User.Read', 'Mail.Send'], loginHint: account.username, prompt: 'select_account' })
    expect(mocks.setActiveAccount).toHaveBeenCalledWith(account)
  })
  it('rejects a popup account different from the authenticated site profile', async () => {
    mocks.loginPopup.mockResolvedValueOnce({ account: other, accessToken: 'private-other-test-token', idToken: 'private-other-id-token' })
    await expect(mail.connectOutlook(configuration, account.username)).rejects.toThrow('사이트 가입 이메일과 같은')
    expect(mocks.setActiveAccount).not.toHaveBeenCalled()
  })
  it('returns only a valid token belonging to the matching account', async () => {
    expect(await mail.acquireOutlookAuthorization(configuration, account.username)).toEqual({ accessToken: 'private-test-token', idToken: 'private-test-id-token' })
    expect(mocks.acquireTokenSilent).toHaveBeenCalledWith({ scopes: ['User.Read', 'Mail.Send'], account })
    expect(mocks.acquireTokenPopup).not.toHaveBeenCalled()
  })
  it('asks for interaction only when Microsoft requires it', async () => {
    const { InteractionRequiredAuthError } = await import('@azure/msal-browser')
    mocks.acquireTokenSilent.mockRejectedValueOnce(new InteractionRequiredAuthError())
    mocks.acquireTokenPopup.mockResolvedValueOnce({ account, accessToken: 'interactive-test-token', idToken: 'private-test-id-token', expiresOn: new Date(Date.now() + 60000) })
    expect(await mail.acquireOutlookAuthorization(configuration, account.username)).toEqual({ accessToken: 'interactive-test-token', idToken: 'private-test-id-token' })
    expect(mocks.acquireTokenPopup).toHaveBeenCalledWith({ scopes: ['User.Read', 'Mail.Send'], account, loginHint: account.username })
  })
  it('keeps network failures separate from interactive account consent', async () => {
    mocks.acquireTokenSilent.mockRejectedValueOnce(new Error('network unavailable'))
    await expect(mail.acquireOutlookAuthorization(configuration, account.username)).rejects.toThrow('network unavailable')
    expect(mocks.acquireTokenPopup).not.toHaveBeenCalled()
  })
  it('refreshes an expired identity proof even when the Graph access token is still valid', async () => {
    mocks.acquireTokenSilent.mockResolvedValueOnce({ account, accessToken: 'still-valid-access-token', idToken: 'expired-identity-proof', idTokenClaims: { exp: Math.floor(Date.now() / 1000) - 1 }, expiresOn: new Date(Date.now() + 60000) })
    mocks.acquireTokenSilent.mockResolvedValueOnce({ account, accessToken: 'fresh-access-token', idToken: 'fresh-identity-proof', idTokenClaims: { exp: Math.floor(Date.now() / 1000) + 3600 }, expiresOn: new Date(Date.now() + 60000) })
    expect(await mail.acquireOutlookAuthorization(configuration, account.username)).toEqual({ accessToken: 'fresh-access-token', idToken: 'fresh-identity-proof' })
    expect(mocks.acquireTokenSilent).toHaveBeenLastCalledWith({ scopes: ['User.Read', 'Mail.Send'], account, forceRefresh: true })
  })
  it('rejects account switching and empty or expired token results', async () => {
    mocks.acquireTokenSilent.mockResolvedValueOnce({ account: other, accessToken: 'wrong-account-token' })
    await expect(mail.acquireOutlookAuthorization(configuration, account.username)).rejects.toThrow('사이트 가입 이메일과 같은')
    mocks.acquireTokenSilent.mockResolvedValueOnce({ account, accessToken: '' })
    await expect(mail.acquireOutlookAuthorization(configuration, account.username)).rejects.toThrow('만료')
    mocks.acquireTokenSilent.mockResolvedValueOnce({ account, accessToken: 'access-without-identity-proof', idToken: '' })
    await expect(mail.acquireOutlookAuthorization(configuration, account.username)).rejects.toThrow('만료')
    mocks.acquireTokenSilent.mockResolvedValueOnce({ account, accessToken: 'expired-test-token', expiresOn: new Date(Date.now() - 1000) })
    await expect(mail.acquireOutlookAuthorization(configuration, account.username)).rejects.toThrow('만료')
  })
  it('connects a tenant UPN using the verified primary mailbox and restores that same account', async () => {
    const tenantAccount = { ...account, username: 'staff@tenant.onmicrosoft.com' }
    mocks.getAllAccounts.mockReturnValue([other, tenantAccount])
    mocks.loginPopup.mockResolvedValueOnce({ account: tenantAccount, accessToken: 'private-test-token', idToken: 'private-test-id-token' })
    expect(await mail.connectOutlook(configuration, account.username)).toEqual({ email: account.username, name: account.name })
    expect(fetch).toHaveBeenCalledWith('https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName', expect.objectContaining({ redirect: 'error', headers: { Authorization: 'Bearer private-test-token' } }))
    expect(await mail.connectedOutlookIdentity(configuration, account.username)).toEqual({ email: account.username, name: account.name })
    mocks.acquireTokenSilent.mockResolvedValueOnce({ account: tenantAccount, accessToken: 'private-test-token', idToken: 'private-test-id-token' })
    expect(await mail.acquireOutlookAuthorization(configuration, account.username)).toEqual({ accessToken: 'private-test-token', idToken: 'private-test-id-token' })
    expect(mocks.acquireTokenSilent).toHaveBeenLastCalledWith({ scopes: ['User.Read', 'Mail.Send'], account: tenantAccount })
    expect(sessionStorage.setItem).toHaveBeenCalledWith(expect.stringContaining(configuration.clientId), tenantAccount.homeAccountId)
    expect(vi.mocked(sessionStorage.setItem).mock.calls.flat().join(' ')).not.toContain('private-test-token')
    expect(vi.mocked(sessionStorage.setItem).mock.calls.flat().join(' ')).not.toContain('private-test-id-token')
  })
  it('restores a primary-mail mapping after reload and scopes it to the configured app', async () => {
    const tenantAccount = { ...account, username: 'staff@tenant.onmicrosoft.com' }
    mocks.getAllAccounts.mockReturnValue([tenantAccount])
    mocks.loginPopup.mockResolvedValueOnce({ account: tenantAccount, accessToken: 'private-test-token', idToken: 'private-test-id-token' })
    await mail.connectOutlook(configuration, account.username)
    vi.resetModules(); const restored = await import('../src/lib/outlook-mail')
    expect(await restored.connectedOutlookIdentity(configuration, account.username)).toEqual({ email: account.username, name: account.name })
    expect(await restored.connectedOutlookIdentity({ ...configuration, clientId: '55555555-5555-4555-8555-555555555555' }, account.username)).toBeNull()
  })
  it('does not keep an accepted mapping after a different mailbox is selected', async () => {
    await mail.connectOutlook(configuration, account.username)
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ id: account.localAccountId, mail: other.username, userPrincipalName: account.username }))
    await expect(mail.connectOutlook(configuration, account.username)).rejects.toThrow('같은 메일함')
    expect(sessionStorage.getItem(`sig-outlook-account:${configuration.tenantId}:${configuration.clientId}:${account.username}`)).toBeNull()
  })
  it('does not treat a matching sign-in UPN as proof of a different primary mailbox', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ id: account.localAccountId, mail: other.username, userPrincipalName: account.username }))
    expect(await mail.connectedOutlookIdentity(configuration, account.username)).toBeNull()
    expect(mocks.loginPopup).not.toHaveBeenCalled()
    expect(mocks.acquireTokenPopup).not.toHaveBeenCalled()
  })
  it('disconnects only the current browser account without calling Microsoft global logout or application logout', async () => {
    await mail.disconnectOutlook(configuration, account.username)
    expect(mocks.clearCache).toHaveBeenCalledWith({ account })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('shows actionable account/popup messages without leaking provider error descriptions', () => {
    expect(mail.outlookConnectionError({ errorCode: 'popup_window_error', errorMessage: 'secret raw trace' })).toContain('팝업')
    expect(mail.outlookConnectionError({ errorCode: 'user_cancelled' })).toContain('취소')
    expect(mail.outlookConnectionError({ errorCode: 'consent_required' })).toContain('관리자')
    expect(mail.outlookConnectionError({ errorCode: 'unknown_provider_error', errorMessage: 'secret raw trace' })).not.toContain('secret raw trace')
  })
})
