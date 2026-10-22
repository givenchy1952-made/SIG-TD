import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'

const dist = resolve('dist-offline')
let html = await readFile(join(dist, 'index.html'), 'utf8')
const files = await readdir(dist)

function cleanPath(url) {
  if (/^(https?:|\/\/|data:)/i.test(url)) throw new Error('External or data script/style link: ' + url)
  return basename(url.split('?')[0].replace(/^\.\//, '').replace(/^\//, ''))
}
const escapeStyle = text => text.replace(/<\/style/gi, '<\\/style')
const escapeScript = text => text.replace(/<\/script/gi, '<\\/script')

let styles = 0
html = await replaceAsync(html, /<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi, async tag => {
  const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1]
  if (!href) throw new Error('Missing CSS href')
  const css = await readFile(join(dist, cleanPath(href)), 'utf8')
  styles++
  return '<style>\n' + escapeStyle(css) + '\n</style>'
})

let scripts = 0
html = await replaceAsync(html, /<script\b[^>]*\bsrc=["'][^"']+["'][^>]*><\/script>/gi, async tag => {
  const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1]
  if (!src) throw new Error('Missing JS src')
  const js = await readFile(join(dist, cleanPath(src)), 'utf8')
  scripts++
  return '<script type="module">\n' + escapeScript(js) + '\n</script>'
})
// Inlined JS only: modulepreload resource fetches are never appropriate for offline.
html = html.replace(/<link\b[^>]*\brel=["']modulepreload["'][^>]*>/gi, '')
if (scripts !== 1 || styles < 1) throw new Error('Expected one JS and at least one CSS asset. Got ' + scripts + ', ' + styles)
if (/<script\b[^>]*\bsrc=/i.test(html) || /<link\b[^>]*\brel=["']stylesheet["']/i.test(html)) throw new Error('HTML still uses external assets')
if (!html.includes('SIG') || html.length < 100_000) throw new Error('Output seems incomplete')
const file = join(dist, 'SIG_TD_Offline_Demo.html')
await writeFile(file, html, 'utf8')
console.log('Single offline file created:', file)
console.log('Bytes:', Buffer.byteLength(html), 'Files bundled:', files.join(', '))

async function replaceAsync(input, regex, fn) {
  const matches = [...input.matchAll(regex)]
  const replacements = await Promise.all(matches.map(m => fn(m[0])))
  let index = 0
  return input.replace(regex, () => replacements[index++])
}
