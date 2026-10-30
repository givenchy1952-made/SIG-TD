const PRODUCTION_APP_URL = 'https://sig-td.vercel.app'

/** Supplier-facing links use the configured public site, independent of the
 * current preview deployment. OAuth callbacks continue to use their own origin. */
export function getPublicAppUrl(configured: string | undefined = import.meta.env.VITE_PUBLIC_APP_URL): string {
  try {
    const url = new URL(configured?.trim() || PRODUCTION_APP_URL)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return PRODUCTION_APP_URL
    url.search = ''; url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch { return PRODUCTION_APP_URL }
}
