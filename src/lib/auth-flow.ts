// Authentication errors can arrive in either the hash (implicit flow) or query.
// Return fixed messages only; never render arbitrary callback descriptions or
// display/record access tokens from the URL.
export function readAuthCallbackError(href: string): string {
  let url: URL
  try { url = new URL(href) } catch { return '' }
  const hash = new URLSearchParams(url.hash.slice(1))
  const query = url.searchParams
  const code = hash.get('error_code') || query.get('error_code') || ''
  const error = hash.get('error') || query.get('error') || ''
  if (!code && !error) return ''
  if (code === 'otp_expired') return '이전 이메일 인증 링크가 만료되었거나 이미 사용되었습니다. 사이트에 다시 접속해 로그인해 주세요. 메일 인증을 요구하면 본사 담당자에게 가입 설정 확인을 요청해 주세요.'
  return '이전 이메일 인증을 완료하지 못했습니다. 사이트에 다시 접속해 로그인하고, 문제가 계속되면 본사 담당자에게 가입 설정 확인을 요청해 주세요.'
}
