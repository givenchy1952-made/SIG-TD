import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Profile } from '../src/lib/types'

const mock = vi.hoisted(() => ({ invoke: vi.fn(), cloud: true }))
vi.mock('../src/lib/repository', () => ({
  get supabase() { return mock.cloud ? { functions: { invoke: mock.invoke } } : null },
  getDemoWorkspace: vi.fn(), locked: vi.fn(), persist: vi.fn(),
}))
import { sendPoEmail } from '../src/lib/operations-repository'

const staff: Profile = { id: '10000000-0000-4000-8000-000000000002', name: '시험 본사', email: 'staff@example.test', role: 'internal', active: true, approved: true, factoryId: null }
const id = '10000000-0000-4000-8000-000000000010'

beforeEach(() => { mock.cloud = true; mock.invoke.mockReset() })

describe('PO Microsoft 365 client dispatch routing', () => {
  it('sends the delegated token only to the Outlook function and verifies its separate request receipt', async () => {
    mock.invoke.mockResolvedValue({ data: { status: 'sent', provider: 'outlook', providerRequestId: 'request-fixture' }, error: null })
    await sendPoEmail(id, 2, staff, 'fixture-delegated-access', 'fixture-signed-identity')
    expect(mock.invoke).toHaveBeenCalledExactlyOnceWith('send-po-outlook', { body: { id, expectedVersion: 2, outlookAccessToken: 'fixture-delegated-access', outlookIdToken: 'fixture-signed-identity' } })
  })
  it('does not mistake a Resend message ID for an Outlook request receipt', async () => {
    mock.invoke.mockResolvedValue({ data: { status: 'sent', providerMessageId: 'message-fixture' }, error: null })
    await expect(sendPoEmail(id, 2, staff, 'fixture-delegated-access', 'fixture-signed-identity')).rejects.toThrow('접수 근거')
  })
  it('does not mark uncertain or unconfirmed Microsoft responses as success', async () => {
    for (const data of [{ status: 'unknown', provider: 'outlook', providerRequestId: 'fixture' }, { status: 'sent', provider: 'outlook' }, { status: 'sent', provider: 'resend', providerRequestId: 'fixture' }]) {
      mock.invoke.mockResolvedValue({ data, error: null })
      await expect(sendPoEmail(id, 2, staff, 'fixture-delegated-access', 'fixture-signed-identity')).rejects.toThrow('접수 근거')
    }
  })
  it('does not fall back to a different sender when an Outlook token is empty', async () => {
    await expect(sendPoEmail(id, 2, staff, '')).rejects.toThrow('다시 연결')
    expect(mock.invoke).not.toHaveBeenCalled()
  })
  it('preserves the existing mail provider route when no Outlook connection was chosen', async () => {
    mock.invoke.mockResolvedValue({ data: { status: 'sent', providerMessageId: 'message-fixture' }, error: null })
    await sendPoEmail(id, 2, staff)
    expect(mock.invoke).toHaveBeenCalledExactlyOnceWith('send-po-email', { body: { id, expectedVersion: 2 } })
  })
  it('shows a server diagnostic without silently retrying a different provider', async () => {
    mock.invoke.mockResolvedValue({ data: null, error: { context: new Response(JSON.stringify({ message: '사이트 계정과 같은 Outlook 계정을 연결해 주세요.' }), { status: 403 }) } })
    await expect(sendPoEmail(id, 2, staff, 'fixture-delegated-access', 'fixture-signed-identity')).rejects.toThrow('같은 Outlook 계정')
    expect(mock.invoke).toHaveBeenCalledTimes(1)
  })
  it('never sends from demo mode or an unapproved/factory profile', async () => {
    mock.cloud = false
    await expect(sendPoEmail(id, 2, staff, 'fixture-delegated-access', 'fixture-signed-identity')).rejects.toThrow('체험 모드')
    mock.cloud = true
    for (const profile of [{ ...staff, approved: false }, { ...staff, active: false }, { ...staff, role: 'factory' as const }]) await expect(sendPoEmail(id, 2, profile, 'fixture-delegated-access')).rejects.toThrow()
    expect(mock.invoke).not.toHaveBeenCalled()
  })
})
