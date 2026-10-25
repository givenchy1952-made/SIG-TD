#!/usr/bin/env node
/** Server/CLI only. No service-role key is bundled with the website. */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const MAGIC = Buffer.from('SIGBACKUP1\n')
const HASH = /^[a-f0-9]{64}$/
const MAX_FILES = 100_000
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024
const DUMPS = ['db/full.dump', 'db/public-schema.dump', 'db/public-data.dump', 'db/auth-accounts.dump']
const PLATFORM_DEFINITIONS = 'db/platform-app.json'
const SNAPSHOT = /^[A-Fa-f0-9]+-[A-Fa-f0-9]+-[0-9]+$/
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
function required(env, key) { const value = env[key]?.trim(); if (!value) throw new Error(`${key} 설정이 필요합니다.`); return value }
export function projectEndpoint(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('Supabase 기본 HTTPS 주소를 확인하세요.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) || !/^[a-z0-9]{6,64}\.supabase\.co$/.test(url.hostname)) throw new Error('Supabase 기본 HTTPS 주소를 확인하세요.')
  return { url: url.origin, ref: url.hostname.split('.')[0] }
}
export function postgresEnvironment(value, projectRef, extra = {}) {
  let url
  try { url = new URL(value) } catch { throw new Error('DB 연결 주소를 확인하세요.') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname.slice(1) || url.hash) throw new Error('비밀번호가 포함된 DB 연결 주소를 확인하세요.')
  const user = decodeURIComponent(url.username)
  const matchesProject = url.hostname === `db.${projectRef}.supabase.co` || (url.hostname.endsWith('.pooler.supabase.com') && user.endsWith(`.${projectRef}`))
  if (!matchesProject) throw new Error('DB 연결 주소와 Supabase 프로젝트가 일치하지 않습니다.')
  if (url.port === '6543') throw new Error('pg_dump에는 transaction pooler(6543) 대신 direct 또는 session pooler 주소를 사용하세요.')
  return { ...process.env, ...extra, PGHOSTADDR: '', PGSERVICE: '', PGSERVICEFILE: '', PGOPTIONS: '', PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: user, PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGSSLMODE: 'verify-full', PGSSLROOTCERT: extra.PGSSLROOTCERT || process.env.SUPABASE_DB_SSL_ROOT_CERT || 'system', PGCONNECT_TIMEOUT: '20' }
}
export function storageName(value, bucket = false) {
  if (typeof value !== 'string' || !value || value.length > (bucket ? 100 : 2048) || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || value.endsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..') || bucket && value.includes('/')) throw new Error('지원하지 않는 Storage 경로입니다.')
  return value
}
const objectURL = (base, bucket, name) => `${base}/storage/v1/object/${encodeURIComponent(storageName(bucket, true))}/${storageName(name).split('/').map(encodeURIComponent).join('/')}`
function passphrase(value) { if (typeof value !== 'string' || value.length < 32) throw new Error('백업 암호는 32자 이상으로 별도 보관해야 합니다.'); return value }
function byteLimit(value) { const limit = Number(value === undefined || value === '' ? DEFAULT_MAX_BYTES : value); if (!Number.isSafeInteger(limit) || limit < 1024 || limit > 2 * 1024 ** 3) throw new Error('백업 크기 제한은 1KiB~2GiB 범위여야 합니다.'); return limit }
async function limitedBytes(response, limit) {
  if (Number(response.headers.get('content-length') || 0) > limit) throw new Error('백업 크기 제한을 초과했습니다.')
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks = []; let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) { await reader.cancel(); throw new Error('백업 크기 제한을 초과했습니다.') }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}
export function redact(value, secrets = []) {
  let text = String(value).replace(/postgres(?:ql)?:\/\/\S+/gi, '[DB 주소 숨김]').replace(/Bearer\s+\S+/gi, 'Bearer [숨김]')
  for (const secret of secrets) if (secret && secret.length >= 4) text = text.split(secret).join('[숨김]')
  return text
}
export async function run(command, args, env, secrets = []) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 10_000_000) child.kill() })
    child.stderr.on('data', data => { stderr = `${stderr}${data}`.slice(-20_000) })
    child.on('error', error => reject(new Error(error.code === 'ENOENT' ? `${command} 실행 파일이 없습니다. PostgreSQL client tools를 설치하세요.` : `${command} 실행 실패`)))
    child.on('close', code => code === 0 ? resolveResult(stdout.trim()) : reject(new Error(`${command} 실패 (${code}): ${redact(stderr.split('\n').filter(line => /ERROR|FATAL|error:/.test(line)).slice(0, 2).join(' ') || '연결·권한·도구 버전을 확인하세요.', secrets)}`)))
  })
}
/** Keep one read-only transaction open while every pg_dump imports its snapshot. */
export async function openDatabaseSnapshot(env, command = 'psql', secrets = []) {
  const child = spawn(command, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = '', stdout = '', ended = false
  const completion = new Promise((resolveDone, reject) => {
    child.once('error', error => reject(new Error(error.code === 'ENOENT' ? `${command} 실행 파일이 없습니다. PostgreSQL client tools를 설치하세요.` : 'DB snapshot 실행 실패')))
    child.once('close', code => { ended = true; code === 0 ? resolveDone() : reject(new Error(`DB snapshot 유지 실패: ${redact(stderr, secrets)}`)) })
  })
  // A rejection must stay observed while other dump commands are running.
  completion.catch(() => {})
  child.stderr.on('data', data => { stderr = `${stderr}${data}`.slice(-4000) })
  const snapshot = await new Promise((resolveSnapshot, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('DB snapshot 연결 시간이 초과되었습니다.')) }, 30_000)
    child.stdout.on('data', data => {
      stdout += data
      const match = stdout.match(/SIG_SNAPSHOT:([^\r\n]+)/)
      if (match && SNAPSHOT.test(match[1])) { clearTimeout(timer); resolveSnapshot(match[1]) }
    })
    completion.then(() => { clearTimeout(timer); reject(new Error('DB snapshot이 조기에 종료되었습니다.')) }, error => { clearTimeout(timer); reject(error) })
    child.stdin.on('error', () => {})
    child.stdin.write("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT 'SIG_SNAPSHOT:' || pg_export_snapshot();\n")
  })
  return {
    snapshot,
    assertOpen() { if (ended) throw new Error('DB snapshot 연결이 종료되어 백업을 중단합니다.') },
    async close() { if (!ended) child.stdin.end('ROLLBACK;\n\\q\n'); await completion },
  }
}
async function api(fetcher, url, key, options = {}) {
  const response = await fetcher(url, { ...options, headers: { apikey: key, Authorization: `Bearer ${key}`, ...options.headers }, signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`Storage 요청 실패 (${response.status}). 연결·서버 키·권한을 확인하세요.`)
  return response
}
export async function listStorage(base, key, fetcher = fetch) {
  const response = await api(fetcher, `${base}/storage/v1/bucket`, key)
  const buckets = await response.json()
  if (!Array.isArray(buckets)) throw new Error('Storage 버킷 응답을 확인하세요.')
  const objects = [], seen = new Set()
  for (const bucket of buckets) {
    storageName(bucket.id, true)
    const queue = [''], visited = new Set()
    while (queue.length) {
      const prefix = queue.shift()
      if (visited.has(prefix)) throw new Error('Storage 경로가 중복됩니다.')
      visited.add(prefix)
      for (let offset = 0; ; offset += 1000) {
        const page = await (await api(fetcher, `${base}/storage/v1/object/list/${encodeURIComponent(bucket.id)}`, key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }) })).json()
        if (!Array.isArray(page)) throw new Error('Storage 목록 응답을 확인하세요.')
        for (const item of page) {
          const name = storageName(prefix ? `${prefix}/${item.name}` : item.name)
          if (item.id == null && item.metadata == null) queue.push(name)
          else {
            const identity = `${bucket.id}/${name}`
            if (seen.has(identity)) throw new Error('Storage 객체가 중복됩니다.')
            seen.add(identity); objects.push({ bucket: bucket.id, name, id: item.id, updatedAt: item.updated_at ?? null, metadata: item.metadata || {} })
            if (objects.length > MAX_FILES) throw new Error('한 백업은 최대 100,000개 파일까지 지원합니다.')
          }
        }
        if (page.length < 1000) break
      }
    }
  }
  return { buckets, objects }
}
const countSQL = `select coalesce(jsonb_object_agg(c.relname,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from public.%I',c.relname),false,true,'')))[1]::text::bigint),'{}'::jsonb)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not exists(select 1 from pg_depend d where d.objid=c.oid and d.deptype='e')`
const authCountSQL = `select jsonb_build_object('users',(select count(*) from auth.users),'identities',(select count(*) from auth.identities),'mfa_factors',(select count(*) from auth.mfa_factors))::text`
const storageSnapshotSQL = `select jsonb_build_object('buckets',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'public',public,'file_size_limit',file_size_limit,'allowed_mime_types',allowed_mime_types)) from storage.buckets),'[]'::jsonb),'objects',coalesce((select jsonb_agg(jsonb_build_object('bucket',bucket_id,'name',name,'id',id,'updatedAt',updated_at,'metadata',metadata)) from (select * from storage.objects order by bucket_id,name limit 100001) o),'[]'::jsonb))::text as storage_snapshot`
function storageFingerprint(storage) {
  return canonical({
    buckets: storage.buckets.map(bucket => ({ id: bucket.id, name: bucket.name, public: !!bucket.public, file_size_limit: bucket.file_size_limit == null ? null : Number(bucket.file_size_limit), allowed_mime_types: bucket.allowed_mime_types == null ? null : [...bucket.allowed_mime_types].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
    objects: storage.objects.map(item => ({ bucket: item.bucket, name: item.name, id: item.id, updatedAt: item.updatedAt && !Number.isNaN(Date.parse(item.updatedAt)) ? new Date(item.updatedAt).toISOString() : item.updatedAt, metadata: item.metadata || {} })).sort((a, b) => `${a.bucket}/${a.name}`.localeCompare(`${b.bucket}/${b.name}`)),
  })
}
const freshTargetSQL = `select ((select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not exists(select 1 from pg_depend d where d.objid=c.oid and d.deptype='e'))+(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and not exists(select 1 from pg_depend d where d.objid=p.oid and d.deptype='e'))+(select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typtype in ('d','e') and not exists(select 1 from pg_depend d where d.objid=t.oid and d.deptype='e')))::text`
// pg_dump --schema=public omits app triggers on auth.users and Storage policies.
export const platformDefinitionsSQL = `select jsonb_build_object('authTriggers',coalesce((select jsonb_agg(pg_get_triggerdef(t.oid)||';'||case t.tgenabled when 'D' then format(' ALTER TABLE auth.users DISABLE TRIGGER %I;',t.tgname) when 'A' then format(' ALTER TABLE auth.users ENABLE ALWAYS TRIGGER %I;',t.tgname) when 'R' then format(' ALTER TABLE auth.users ENABLE REPLICA TRIGGER %I;',t.tgname) else '' end order by t.tgname) from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace where t.tgrelid='auth.users'::regclass and not t.tgisinternal and n.nspname='public'),'[]'::jsonb),'storagePolicies',coalesce((select jsonb_agg(format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s;',policyname,schemaname,tablename,permissive,cmd,(select string_agg(quote_ident(role_name),', ') from unnest(roles) role_name),case when qual is null then '' else ' USING ('||qual||')' end,case when with_check is null then '' else ' WITH CHECK ('||with_check||')' end) order by tablename,policyname) from pg_policies where schemaname='storage' and tablename in ('objects','buckets')),'[]'::jsonb))::text as definitions`
async function queryJSON(env, command, sql, snapshot) {
  if (snapshot && !SNAPSHOT.test(snapshot)) throw new Error('DB snapshot 값이 올바르지 않습니다.')
  const statement = snapshot ? `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '${snapshot}'; ${sql}; COMMIT;` : sql
  return JSON.parse(await run(command, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement], env, [env.PGPASSWORD]))
}
async function databaseCounts(env, command = 'psql', snapshot) {
  return { public: await queryJSON(env, command, countSQL, snapshot), auth: await queryJSON(env, command, authCountSQL, snapshot) }
}
export function validateManifest(manifest) {
  if (!manifest || manifest.format !== 'sig-workspace-backup' || manifest.version !== 1 || !/^[a-z0-9]{6,64}$/.test(manifest.source?.projectRef || '') || !Array.isArray(manifest.files) || !Array.isArray(manifest.storage?.buckets) || !Array.isArray(manifest.storage?.objects) || manifest.storage.objects.length > MAX_FILES) throw new Error('지원하지 않는 백업 manifest입니다.')
  const paths = new Set()
  for (const file of manifest.files) {
    if (!(DUMPS.includes(file.path) || file.path === PLATFORM_DEFINITIONS || /^storage\/[a-f0-9]{64}\.bin$/.test(file.path)) || paths.has(file.path) || !HASH.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('백업 파일 경로·체크섬이 올바르지 않습니다.')
    paths.add(file.path)
  }
  if (DUMPS.some(path => !paths.has(path))) throw new Error('데이터베이스 덤프가 누락되었습니다.')
  if (!paths.has(PLATFORM_DEFINITIONS)) throw new Error('가입 트리거·Storage 권한 백업이 누락되었습니다.')
  const names = new Set(), bucketIds = new Set()
  for (const bucket of manifest.storage.buckets) { storageName(bucket.id, true); if (bucketIds.has(bucket.id)) throw new Error('버킷이 중복됩니다.'); bucketIds.add(bucket.id) }
  for (const item of manifest.storage.objects) {
    storageName(item.bucket, true); storageName(item.name)
    const key = `${item.bucket}/${item.name}`
    if (names.has(key) || !bucketIds.has(item.bucket) || !paths.has(item.path) || !/^storage\/[a-f0-9]{64}\.bin$/.test(item.path)) throw new Error('Storage manifest가 올바르지 않습니다.')
    names.add(key)
  }
  if (!manifest.counts || !manifest.counts.public || !manifest.counts.auth || typeof manifest.counts.public !== 'object' || typeof manifest.counts.auth !== 'object' || [manifest.counts.public, manifest.counts.auth].some(counts => Object.values(counts).some(count => !Number.isSafeInteger(count) || count < 0))) throw new Error('DB 검증 정보가 없습니다.')
  return manifest
}
export function assertRestoreTarget(manifest, targetRef, confirmation, protectedRefs = []) {
  if (targetRef === manifest.source.projectRef || protectedRefs.includes(targetRef)) throw new Error('원본·보호된 운영 프로젝트로 복구할 수 없습니다. 별도 복구 프로젝트를 사용하세요.')
  if (targetRef !== confirmation) throw new Error('복구 대상 프로젝트 확인 값이 일치하지 않습니다.')
}
export function encryptBytes(bytes, password) {
  const header = Buffer.from(JSON.stringify({ version: 1, salt: randomBytes(16).toString('base64'), iv: randomBytes(12).toString('base64') }))
  const data = JSON.parse(header), cipher = createCipheriv('aes-256-gcm', scryptSync(passphrase(password), Buffer.from(data.salt, 'base64'), 32), Buffer.from(data.iv, 'base64'))
  cipher.setAAD(header)
  const size = Buffer.alloc(4); size.writeUInt32BE(header.length)
  return Buffer.concat([MAGIC, size, header, cipher.update(bytes), cipher.final(), cipher.getAuthTag()])
}
export function decryptBytes(bytes, password) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes)
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC) || bytes.length < MAGIC.length + 4 + 16) throw new Error('암호화 백업 형식이 올바르지 않습니다.')
  const length = bytes.readUInt32BE(MAGIC.length), start = MAGIC.length + 4
  if (length < 1 || length > 4096 || start + length + 16 >= bytes.length) throw new Error('백업 헤더가 올바르지 않습니다.')
  try {
    const header = bytes.subarray(start, start + length), data = JSON.parse(header)
    if (data.version !== 1 || Buffer.from(data.salt, 'base64').length !== 16 || Buffer.from(data.iv, 'base64').length !== 12) throw new Error()
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(passphrase(password), Buffer.from(data.salt, 'base64'), 32), Buffer.from(data.iv, 'base64'))
    decipher.setAAD(header); decipher.setAuthTag(bytes.subarray(-16))
    return Buffer.concat([decipher.update(bytes.subarray(start + length, -16)), decipher.final()])
  } catch { throw new Error('백업 암호가 다르거나 파일이 손상되었습니다.') }
}
export async function readArchive(path, password, maxBytes = DEFAULT_MAX_BYTES) {
  byteLimit(maxBytes)
  const info = await stat(path)
  if (info.size > maxBytes + 1024 * 1024 || info.size <= 0) throw new Error('백업 파일 크기 제한을 확인하세요.')
  const zip = await JSZip.loadAsync(decryptBytes(await readFile(path), password))
  const manifestFile = zip.file('manifest.json')
  if (!manifestFile || manifestFile._data.uncompressedSize > Math.min(maxBytes, 64 * 1024 * 1024) || Object.keys(zip.files).length > MAX_FILES + 20) throw new Error('백업 manifest가 없거나 크기 제한을 초과했습니다.')
  const manifest = validateManifest(JSON.parse(await manifestFile.async('string')))
  const allowed = new Set(['manifest.json', ...manifest.files.map(item => item.path)])
  let total = manifestFile._data.uncompressedSize
  const files = new Map()
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue
    if (!allowed.has(name) || file.unsafeOriginalName && file.unsafeOriginalName !== name) throw new Error('백업에 허용되지 않은 파일 경로가 있습니다.')
    if (name === 'manifest.json') continue
    const declared = manifest.files.find(item => item.path === name)
    if (file._data.uncompressedSize !== declared.size) throw new Error('압축된 파일의 실제 크기와 manifest가 다릅니다.')
    total += declared.size
    if (total > maxBytes) throw new Error('압축 해제 크기 제한을 초과했습니다.')
    const bytes = await file.async('nodebuffer')
    if (bytes.length !== declared.size || sha256(bytes) !== declared.sha256) throw new Error('백업 체크섬 검증에 실패했습니다.')
    files.set(name, bytes)
  }
  if (files.size !== manifest.files.length) throw new Error('백업 파일이 누락되었습니다.')
  return { manifest, files }
}
export async function backupWorkspace(env = process.env, fetcher = fetch) {
  const source = projectEndpoint(required(env, 'SUPABASE_URL')), key = required(env, 'SUPABASE_SERVICE_ROLE_KEY'), password = passphrase(required(env, 'SIG_BACKUP_PASSPHRASE'))
  const dbEnv = postgresEnvironment(required(env, 'SUPABASE_DB_URL'), source.ref, env.SUPABASE_DB_SSL_ROOT_CERT ? { PGSSLROOTCERT: env.SUPABASE_DB_SSL_ROOT_CERT } : {})
  const maxBytes = byteLimit(env.SIG_BACKUP_MAX_BYTES)
  const directory = await mkdtemp(join(tmpdir(), 'sig-backup-')); await chmod(directory, 0o700)
  let snapshotConnection
  try {
    const storage = await listStorage(source.url, key, fetcher)
    snapshotConnection = await openDatabaseSnapshot(dbEnv, env.PSQL_BIN || 'psql', [key, dbEnv.PGPASSWORD, password])
    const before = await databaseCounts(dbEnv, env.PSQL_BIN || 'psql', snapshotConnection.snapshot)
    const snapshotStorage = await queryJSON(dbEnv, env.PSQL_BIN || 'psql', storageSnapshotSQL, snapshotConnection.snapshot)
    if (storageFingerprint(snapshotStorage) !== storageFingerprint(storage)) throw new Error('DB snapshot과 Storage 파일 목록이 다릅니다. 파일 쓰기를 중지한 시간에 다시 실행하세요.')
    const versions = await run(env.PG_DUMP_BIN || 'pg_dump', ['--version'], dbEnv)
    const archive = new JSZip(), files = [], secrets = [key, dbEnv.PGPASSWORD, password]
    const variants = [[], ['--schema-only', '--schema=public'], ['--data-only', '--schema=public'], ['--data-only', '--table=auth.users', '--table=auth.identities', '--table=auth.mfa_factors']]
    let total = 0
    for (let index = 0; index < DUMPS.length; index++) {
      const path = join(directory, `${index}.dump`)
      snapshotConnection.assertOpen()
      await run(env.PG_DUMP_BIN || 'pg_dump', ['--format=custom', '--no-owner', `--snapshot=${snapshotConnection.snapshot}`, ...variants[index], '--file', path], dbEnv, secrets)
      const bytes = await readFile(path); total += bytes.length
      if (total > maxBytes) throw new Error('백업 크기 제한을 초과했습니다.')
      files.push({ path: DUMPS[index], size: bytes.length, sha256: sha256(bytes) }); archive.file(DUMPS[index], bytes)
    }
    const platform = Buffer.from(JSON.stringify(await queryJSON(dbEnv, env.PSQL_BIN || 'psql', platformDefinitionsSQL, snapshotConnection.snapshot)))
    total += platform.length
    files.push({ path: PLATFORM_DEFINITIONS, size: platform.length, sha256: sha256(platform) }); archive.file(PLATFORM_DEFINITIONS, platform)
    snapshotConnection.assertOpen()
    await snapshotConnection.close(); snapshotConnection = undefined
    for (const object of storage.objects) {
      const bytes = await limitedBytes(await api(fetcher, objectURL(source.url, object.bucket, object.name), key), maxBytes - total)
      if (Number.isFinite(object.metadata.size) && bytes.length !== object.metadata.size) throw new Error('Storage 파일 크기가 변경되었습니다. 백업을 다시 실행하세요.')
      total += bytes.length
      if (total > maxBytes) throw new Error('백업 크기 제한을 초과했습니다.')
      const path = `storage/${sha256(Buffer.from(`${object.bucket}/${object.name}`))}.bin`
      object.path = path; files.push({ path, size: bytes.length, sha256: sha256(bytes) }); archive.file(path, bytes)
    }
    const storageAfter = await listStorage(source.url, key, fetcher)
    if (storageFingerprint(storage) !== storageFingerprint(storageAfter)) throw new Error('백업 도중 파일이 바뀌었습니다. 파일 쓰기를 중지한 시간에 다시 실행하세요.')
    const manifest = validateManifest({ format: 'sig-workspace-backup', version: 1, createdAt: new Date().toISOString(), source: { projectRef: source.ref }, postgres: versions, counts: before, storage, files, consistency: { database: 'exported-repeatable-read-snapshot', storage: 'stable-listing-before-after', crossServiceAtomic: false } })
    const manifestJSON = JSON.stringify(manifest, null, 2)
    if (total + Buffer.byteLength(manifestJSON) > maxBytes) throw new Error('manifest를 포함한 백업 크기 제한을 초과했습니다.')
    archive.file('manifest.json', manifestJSON)
    const bytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    const outputDirectory = resolve(env.SIG_BACKUP_DIRECTORY || join(tmpdir(), 'sig-backups')); await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
    const filename = join(outputDirectory, `SIG-${source.ref}-${manifest.createdAt.replace(/[:.]/g, '-')}.sigbackup`)
    await writeFile(filename, encryptBytes(bytes, password), { mode: 0o600, flag: 'wx' })
    await writeFile(`${filename}.sha256`, `${sha256(await readFile(filename))}  ${filename.split('/').at(-1)}\n`, { mode: 0o600 })
    await readArchive(filename, password, maxBytes)
    return { file: filename, objects: storage.objects.length, tables: Object.keys(before.public).length, projectRef: source.ref, sha256: sha256(await readFile(filename)) }
  } finally { if (snapshotConnection) await snapshotConnection.close().catch(() => {}); await rm(directory, { recursive: true, force: true }) }
}
export async function restoreWorkspace(path, env = process.env, { apply = false, confirmTarget = '' } = {}, fetcher = fetch) {
  const maxBytes = byteLimit(env.SIG_BACKUP_MAX_BYTES)
  const { manifest, files } = await readArchive(resolve(path), required(env, 'SIG_BACKUP_PASSPHRASE'), maxBytes)
  let platform
  try { platform = JSON.parse(files.get(PLATFORM_DEFINITIONS).toString('utf8')) } catch { throw new Error('가입 트리거·Storage 권한 정의가 올바르지 않습니다.') }
  if (!Array.isArray(platform.authTriggers) || !Array.isArray(platform.storagePolicies) || [...platform.authTriggers, ...platform.storagePolicies].some(sql => typeof sql !== 'string' || sql.length > 1024 * 1024)) throw new Error('가입 트리거·Storage 권한 정의가 올바르지 않습니다.')
  const target = projectEndpoint(required(env, 'TARGET_SUPABASE_URL'))
  const protectedRefs = (env.SIG_PROTECTED_PROJECT_REFS || '').split(',').map(value => value.trim()).filter(Boolean)
  if (env.SUPABASE_URL) protectedRefs.push(projectEndpoint(env.SUPABASE_URL).ref)
  assertRestoreTarget(manifest, target.ref, confirmTarget, protectedRefs)
  const dbEnv = postgresEnvironment(required(env, 'TARGET_SUPABASE_DB_URL'), target.ref, env.TARGET_SUPABASE_DB_SSL_ROOT_CERT ? { PGSSLROOTCERT: env.TARGET_SUPABASE_DB_SSL_ROOT_CERT } : {}), key = required(env, 'TARGET_SUPABASE_SERVICE_ROLE_KEY')
  const current = await databaseCounts(dbEnv, env.PSQL_BIN || 'psql')
  const storage = await listStorage(target.url, key, fetcher)
  const publicObjects = await queryJSON(dbEnv, env.PSQL_BIN || 'psql', freshTargetSQL)
  if (publicObjects !== 0 || Object.keys(current.public).length || Object.values(current.auth).some(count => count !== 0) || storage.objects.length || storage.buckets.length) throw new Error('복구 대상은 앱 테이블·함수·가입 사용자·버킷·파일이 없는 새 프로젝트여야 합니다.')
  const report = { mode: apply ? 'apply' : 'dry-run', sourceProject: manifest.source.projectRef, targetProject: target.ref, tables: Object.keys(manifest.counts.public).length, objects: manifest.storage.objects.length, checksumsVerified: true }
  if (!apply) return report
  const directory = await mkdtemp(join(tmpdir(), 'sig-restore-')); await chmod(directory, 0o700)
  try {
    for (const name of DUMPS) await writeFile(join(directory, name.split('/').at(-1)), files.get(name), { mode: 0o600 })
    const command = env.PG_RESTORE_BIN || 'pg_restore'
    const schemaPath = join(directory, 'public-schema.dump')
    const toc = await run(command, ['--list', schemaPath], dbEnv)
    const tocPath = join(directory, 'schema.list')
    await writeFile(tocPath, toc.split('\n').filter(line => !/\bSCHEMA - public\b/.test(line)).join('\n'), { mode: 0o600 })
    const secrets = [key, dbEnv.PGPASSWORD, env.SIG_BACKUP_PASSPHRASE]
    // Load rows before app triggers/FKs are installed: importing comments and
    // attachments must not execute normal authenticated write/audit triggers.
    await run(command, ['--dbname', dbEnv.PGDATABASE, '--single-transaction', '--exit-on-error', '--no-owner', '--section=pre-data', '--use-list', tocPath, schemaPath], dbEnv, secrets)
    await run(command, ['--dbname', dbEnv.PGDATABASE, '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', join(directory, 'auth-accounts.dump')], dbEnv, secrets)
    await run(command, ['--dbname', dbEnv.PGDATABASE, '--single-transaction', '--exit-on-error', '--no-owner', join(directory, 'public-data.dump')], dbEnv, secrets)
    await run(command, ['--dbname', dbEnv.PGDATABASE, '--single-transaction', '--exit-on-error', '--no-owner', '--section=post-data', '--use-list', tocPath, schemaPath], dbEnv, secrets)
    for (const bucket of manifest.storage.buckets) {
      const exists = storage.buckets.some(item => item.id === bucket.id)
      const body = { id: bucket.id, name: bucket.name || bucket.id, public: !!bucket.public, file_size_limit: bucket.file_size_limit ?? null, allowed_mime_types: bucket.allowed_mime_types ?? null }
      await api(fetcher, `${target.url}/storage/v1/bucket${exists ? `/${encodeURIComponent(bucket.id)}` : ''}`, key, { method: exists ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    }
    for (const object of manifest.storage.objects) {
      const bytes = files.get(object.path), contentType = object.metadata?.mimetype || 'application/octet-stream'
      await api(fetcher, objectURL(target.url, object.bucket, object.name), key, { method: 'POST', headers: { 'Content-Type': contentType, 'x-upsert': 'false' }, body: bytes })
      const restored = await limitedBytes(await api(fetcher, objectURL(target.url, object.bucket, object.name), key), bytes.length)
      if (sha256(restored) !== sha256(bytes)) throw new Error('복구된 Storage 파일의 체크섬이 다릅니다.')
    }
    const platformPath = join(directory, 'platform-app.sql')
    await writeFile(platformPath, `BEGIN;\n${[...platform.authTriggers, ...platform.storagePolicies].join('\n')}\nCOMMIT;\n`, { mode: 0o600 })
    await run(env.PSQL_BIN || 'psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--file', platformPath], dbEnv, secrets)
    if (canonical(await queryJSON(dbEnv, env.PSQL_BIN || 'psql', platformDefinitionsSQL)) !== canonical(platform)) throw new Error('복구된 가입 트리거·Storage 권한 정책이 다릅니다.')
    if (canonical(await databaseCounts(dbEnv, env.PSQL_BIN || 'psql')) !== canonical(manifest.counts)) throw new Error('복구된 DB의 테이블별 행 수가 다릅니다.')
    const restoredStorage = await listStorage(target.url, key, fetcher)
    if (canonical(restoredStorage.objects.map(item => `${item.bucket}/${item.name}`).sort()) !== canonical(manifest.storage.objects.map(item => `${item.bucket}/${item.name}`).sort())) throw new Error('복구된 Storage 파일 목록이 다릅니다.')
    return { ...report, databaseCountsVerified: true, storageBytesVerified: true }
  } finally { await rm(directory, { recursive: true, force: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  backupWorkspace().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(redact(error.message, [process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.SIG_BACKUP_PASSPHRASE])); process.exitCode = 1 })
}
