export interface SupabaseConfiguration { url: string; key: string; error: string }

// The Supabase client appends /auth/v1, /rest/v1 and /storage/v1 itself.
// The dashboard's Data API URL is also commonly copied during setup; reduce
// only known service roots to the project origin, never arbitrary proxy paths.
export function resolveSupabaseConfiguration(rawUrl?: string, rawKey?: string): SupabaseConfiguration {
  const inputUrl = rawUrl?.trim() || '', key = rawKey?.trim() || ''
  const invalid = (error: string): SupabaseConfiguration => ({ url: '', key, error })
  if (!inputUrl && !key) return { url: '', key: '', error: '' }
  if (!inputUrl || !key) return invalid('Supabase URL과 공개 키를 모두 설정해 주세요.')
  let parsed: URL
  try { parsed = new URL(inputUrl) } catch { return invalid('Supabase URL 형식이 올바르지 않습니다. https://프로젝트주소.supabase.co 형식의 프로젝트 기본 주소를 입력해 주세요.') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) return invalid('Supabase URL은 HTTPS 프로젝트 주소를 사용해 주세요. HTTP는 로컬 개발 주소에서만 사용할 수 있습니다.')
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return invalid('Supabase URL에는 로그인 정보, 물음표 뒤의 값 또는 #을 포함하지 않은 프로젝트 기본 주소를 입력해 주세요.')
  const path = parsed.pathname.replace(/\/+$/, '')
  if (path && !/^\/(rest|auth|storage|functions|realtime)\/v1$/.test(path)) return invalid('Supabase URL에는 경로가 없는 프로젝트 기본 주소를 입력해 주세요. 예: https://프로젝트주소.supabase.co')
  if (key.startsWith('sb_secret_')) return invalid('Supabase secret 키는 브라우저에서 사용할 수 없습니다. 공개 anon 또는 publishable 키를 사용해 주세요.')
  try {
    const payload = key.split('.')[1] || ''
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const role = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))).role
    if (role === 'service_role') return invalid('관리자 service_role 키는 브라우저에서 사용할 수 없습니다. 공개 anon 또는 publishable 키로 변경해 주세요.')
  } catch { /* Publishable keys are not JWTs. The server validates public keys. */ }
  return { url: parsed.origin, key, error: '' }
}
