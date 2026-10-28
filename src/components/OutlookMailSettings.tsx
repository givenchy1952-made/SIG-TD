import { useEffect, useState } from 'react'
import { AlertCircle, Check, ChevronDown, Link, Mail, RefreshCw, Settings, Unlink } from 'lucide-react'
import type { Profile } from '../lib/types'
import type { OutlookMailState } from '../lib/outlook-mail'
import { connectOutlook, connectedOutlookIdentity, disconnectOutlook, isOutlookCloudAvailable, loadOutlookConfiguration, outlookCallbackUrl, outlookConnectionError, saveOutlookConfiguration } from '../lib/outlook-mail'

export const INITIAL_OUTLOOK_STATE: OutlookMailState = { mode: 'loading', configuration: null, identity: null }

export default function OutlookMailSettings({ profile, disabled = false, onStateChange, onDirtyChange }: { profile: Profile; disabled?: boolean; onStateChange: (state: OutlookMailState) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const [state, setState] = useState<OutlookMailState>(INITIAL_OUTLOOK_STATE)
  const [clientId, setClientId] = useState(''), [tenantId, setTenantId] = useState(''), [reason, setReason] = useState('')
  const [error, setError] = useState(''), [success, setSuccess] = useState(''), [busy, setBusy] = useState(false)
  const dirty = clientId.trim() !== (state.configuration?.clientId || '') || tenantId.trim() !== (state.configuration?.tenantId || '') || !!reason.trim()
  useEffect(() => { onStateChange(state) }, [state, onStateChange])
  useEffect(() => { onDirtyChange?.(dirty || busy) }, [dirty, busy, onDirtyChange])
  useEffect(() => {
    let active = true
    setState(INITIAL_OUTLOOK_STATE); setClientId(''); setTenantId(''); setReason(''); setError(''); setSuccess('')
    async function load() {
      if (!isOutlookCloudAvailable()) { if (active) setState({ mode: 'demo', configuration: null, identity: null }); return }
      try {
        const configuration = await loadOutlookConfiguration()
        if (!active) return
        setClientId(configuration?.clientId || ''); setTenantId(configuration?.tenantId || '')
        const identity = configuration ? await connectedOutlookIdentity(configuration, profile.email) : null
        if (active) { setState({ mode: configuration ? 'configured' : 'unconfigured', configuration, identity }); setError('') }
      } catch (err) { if (active) { setState({ mode: 'unavailable', configuration: null, identity: null }); setError(outlookConnectionError(err)) } }
    }
    void load()
    return () => { active = false }
  }, [profile.id, profile.email])

  async function reload() {
    setBusy(true); setError(''); setSuccess('')
    try {
      const configuration = await loadOutlookConfiguration()
      const identity = configuration ? await connectedOutlookIdentity(configuration, profile.email) : null
      setClientId(configuration?.clientId || ''); setTenantId(configuration?.tenantId || ''); setReason(''); setState({ mode: configuration ? 'configured' : 'unconfigured', configuration, identity })
    } catch (err) { setError(outlookConnectionError(err)) }
    finally { setBusy(false) }
  }
  async function connect() {
    if (!state.configuration) return
    setBusy(true); setError(''); setSuccess('')
    try { const identity = await connectOutlook(state.configuration, profile.email); setState(current => ({ ...current, identity })); setSuccess('본인의 Outlook 계정을 연결했습니다. 메일은 발송하지 않았습니다.') }
    catch (err) { setError(outlookConnectionError(err)) }
    finally { setBusy(false) }
  }
  async function disconnect() {
    if (!state.configuration) return
    setBusy(true); setError(''); setSuccess('')
    try { await disconnectOutlook(state.configuration, profile.email); setState(current => ({ ...current, identity: null })); setSuccess('이 브라우저의 Outlook 연결을 해제했습니다.') }
    catch (err) { setError(outlookConnectionError(err)) }
    finally { setBusy(false) }
  }
  async function save() {
    setBusy(true); setError(''); setSuccess('')
    try {
      const configuration = await saveOutlookConfiguration(clientId, tenantId, state.configuration?.version || 0, reason)
      setState({ mode: 'configured', configuration, identity: null }); setClientId(configuration.clientId); setTenantId(configuration.tenantId); setReason(''); setSuccess('회사 Microsoft 365 앱 설정을 저장했습니다. 각 담당자가 자신의 Outlook 계정을 연결해 주세요.')
    } catch (err) { setError(outlookConnectionError(err)) }
    finally { setBusy(false) }
  }
  return <section className="outlook-mail-settings" aria-label="Microsoft 365 Outlook 발송 설정">
    <div className="outlook-connection-row"><Mail size={18} /><div><strong>Microsoft 365 Outlook</strong>{state.mode === 'loading' ? <p>회사 메일 연결 상태를 확인하고 있습니다.</p> : state.mode === 'demo' ? <p>실제 Outlook 연결과 발송은 운영 사이트에서 사용할 수 있습니다.</p> : state.mode === 'configured' ? <p>{state.identity ? <><Check size={12} /> 연결됨 · {state.identity.email}</> : <>사이트 가입 이메일과 같은 회사 계정을 연결해 주세요: {profile.email}</>}</p> : <p>관리자가 회사 Microsoft 앱을 설정하면 담당자별 Outlook 메일로 PO를 보낼 수 있습니다.</p>}</div>
      {state.mode === 'configured' && <button className="button" type="button" disabled={disabled || busy} onClick={() => void (state.identity ? disconnect() : connect())}>{state.identity ? <Unlink size={13} /> : <Link size={13} />}{busy ? '연결 확인 중…' : state.identity ? 'Outlook 연결 해제' : 'Outlook 연결'}</button>}
      {state.mode === 'unavailable' && <button className="button" type="button" disabled={disabled || busy} onClick={() => void reload()}><RefreshCw size={12} />연결 설정 다시 확인</button>}
    </div>
    {error && <div className="ops-error" role="alert"><AlertCircle size={14} />{error}</div>}{success && <div className="ops-success" role="status"><Check size={14} />{success}</div>}
    {state.mode === 'configured' && <p className="outlook-connection-note">연결한 본인의 메일함에서 발송하며 Outlook 보낸 편지함에도 저장합니다. 사진·PDF 첨부는 최대 2MB입니다.</p>}
    {profile.role === 'admin' && state.mode !== 'demo' && <details className="outlook-admin-settings"><summary><Settings size={13} />회사 Microsoft 365 설정<ChevronDown size={13} /></summary><p>Microsoft Entra 앱 등록에서 SPA 리디렉션 주소와 위임 권한 User.Read·Mail.Send를 등록한 뒤 앱 ID와 테넌트 ID를 입력합니다. 회사 정책에 따라 관리자 동의가 필요할 수 있습니다.</p><label className="field"><span className="field-label">Microsoft SPA 리디렉션 주소</span><input className="input" aria-label="Microsoft SPA 리디렉션 주소" readOnly value={outlookCallbackUrl()} /></label><div className="form-grid"><label className="field"><span className="field-label">애플리케이션(클라이언트) ID</span><input className="input" aria-label="Microsoft 애플리케이션 ID" value={clientId} maxLength={36} disabled={disabled || busy || state.mode === 'loading'} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" onChange={event => { setClientId(event.target.value); setSuccess('') }} /></label><label className="field"><span className="field-label">디렉터리(테넌트) ID</span><input className="input" aria-label="Microsoft 테넌트 ID" value={tenantId} maxLength={36} disabled={disabled || busy || state.mode === 'loading'} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" onChange={event => { setTenantId(event.target.value); setSuccess('') }} /></label></div><label className="field"><span className="field-label">Microsoft 설정 변경 사유</span><input className="input" aria-label="Microsoft 설정 변경 사유" value={reason} maxLength={1000} disabled={disabled || busy} placeholder="설정 변경 사유를 입력하세요" onChange={event => setReason(event.target.value)} /></label><div className="outlook-admin-actions"><button className="button" type="button" disabled={disabled || busy || state.mode === 'loading'} onClick={() => void reload()}><RefreshCw size={12} />최신 설정 불러오기</button><button className="button button-primary" type="button" disabled={disabled || busy || state.mode === 'loading' || !dirty || reason.trim().length < 2 || !clientId.trim() || !tenantId.trim()} onClick={() => void save()}>Microsoft 설정 저장</button></div></details>}
  </section>
}
