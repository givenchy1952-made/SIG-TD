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
  if (code === 'otp_expired') return '이메일 인증 링크가 만료되었거나 이미 사용되었습니다. 아래에 가입한 이메일을 입력하고 인증 메일 다시 받기를 눌러 주세요.'
  return '이메일 인증을 완료하지 못했습니다. 가입한 이메일로 인증 메일을 다시 받아 가장 최근 링크를 열어 주세요.'
}
