#!/usr/bin/env node
/** DI exports are deliberately incompatible with the account-restoring full mode. */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import {
  api, byteLimit, countSQL, encryptBytes, limitedBytes, listStorage, openDatabaseSnapshot,
  postgresEnvironment, projectEndpoint, queryJSON, readArchive, redact, required, run,
  sha256, storageFingerprint, storageName, validateManifest,
} from './backup-workspace.mjs'

const ident = value => `"${value.replaceAll('"', '""')}"`
// Match keys, never user IDs. Nested JSON/audit snapshots need the same boundary.
export const secretName = value => /password|passwd|pwd|secret|token|credential|authorization|api.?key|private.?key|mfa|totp|session|cookie|recovery.?code|connection.?string/i.test(value)
const credentialValue = /(?:postgres(?:ql)?:\/\/\S+|\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\bsb_secret_[A-Za-z0-9_-]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i
export function assertNoCredentials(value, secrets = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (credentialValue.test(text) || secrets.some(secret => secret?.length >= 4 && text.includes(secret))) throw new Error('DI 내보내기에서 인증 비밀값이 발견되었습니다. 원본을 변경하지 말고 검토 정책으로 제외하세요.')
  let parsed
  try { parsed = JSON.parse(text) } catch { return }
  const walk = item => {
    if (typeof item === 'string') { if (credentialValue.test(item) || secrets.some(secret => secret?.length >= 4 && item.includes(secret))) throw new Error('DI JSON에 인증 비밀값이 있습니다.') }
    else if (item && typeof item === 'object') for (const child of Object.values(item)) walk(child)
  }
  walk(parsed)
}
export function sanitizeJSON(value) {
  if (Array.isArray(value)) return value.map(sanitizeJSON)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !secretName(key)).map(([key, item]) => [key, sanitizeJSON(item)]))
  return value
}
/** Tokenize valid PostgreSQL JSON text without coercing numeric literals to JS numbers. */
export function sanitizeJSONText(text) {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null|[{}\[\]:,]/g)
  JSON.parse(text) // reject invalid syntax; numeric results are deliberately discarded
  let index = 0
  function value() {
    const token = tokens[index++]
    if (token === '{') {
      const fields = []
      while (tokens[index] !== '}') {
        const key = tokens[index++]; index++ // colon
        const item = value()
        if (!secretName(JSON.parse(key))) fields.push(`${key}:${item}`)
        if (tokens[index] !== ',') break
        index++
      }
      index++; return `{${fields.join(',')}}`
    }
    if (token === '[') {
      const items = []
      while (tokens[index] !== ']') { items.push(value()); if (tokens[index] !== ',') break; index++ }
      index++; return `[${items.join(',')}]`
    }
    return token
  }
  return value()
}
export const catalogSQL = `select jsonb_build_object(
 'tables',coalesce((select jsonb_agg(jsonb_build_object('name',c.relname,'rls',c.relrowsecurity,'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'generated',a.attgenerated,'identity',a.attidentity) order by a.attnum) from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not c.relispartition and not exists(select 1 from pg_depend d where d.objid=c.oid and d.deptype='e')),'[]'::jsonb),
 'foreignKeys',coalesce((select jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,'targetSchema',tn.nspname,'targetTable',tc.relname,'definition',pg_get_constraintdef(k.oid),'columns',(select jsonb_agg(a.attname order by x.ord) from unnest(k.conkey) with ordinality x(num,ord) join pg_attribute a on a.attrelid=k.conrelid and a.attnum=x.num),'targetColumns',(select jsonb_agg(a.attname order by x.ord) from unnest(k.confkey) with ordinality x(num,ord) join pg_attribute a on a.attrelid=k.confrelid and a.attnum=x.num)) order by c.relname,k.conname) from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace join pg_class tc on tc.oid=k.confrelid join pg_namespace tn on tn.oid=tc.relnamespace where k.contype='f' and n.nspname='public'),'[]'::jsonb),
 'sequences',coalesce((select jsonb_agg(jsonb_build_object('name',sequencename,'type',data_type,'start',start_value::text,'increment',increment_by::text,'lastValue',last_value::text) order by sequencename) from pg_sequences where schemaname='public'),'[]'::jsonb))::text`
// Catalog row metadata includes owner IDs, created_at, user_metadata and version fields.
// This does not copy the storage schema or query auth accounts.
export const diStorageSQL = `select jsonb_build_object('buckets',coalesce((select jsonb_agg(to_jsonb(b)) from storage.buckets b),'[]'::jsonb),'objects',coalesce((select jsonb_agg(jsonb_build_object('bucket',bucket_id,'name',name,'id',id,'updatedAt',updated_at,'metadata',metadata,'databaseMetadata',to_jsonb(o))) from (select * from storage.objects order by bucket_id,name limit 100001) o),'[]'::jsonb))::text as storage_snapshot`
function configuration(env) {
  if (env.GITHUB_ACTIONS === 'true') throw new Error('실제 DI 백업은 GitHub Actions에서 실행할 수 없습니다. 비공개 로컬 환경을 사용하세요.')
  const source = projectEndpoint(required(env, 'SUPABASE_URL'))
  const dbEnv = postgresEnvironment(required(env, 'SUPABASE_DB_URL'), source.ref, { PGOPTIONS: '-c default_transaction_read_only=on', ...(env.SUPABASE_DB_SSL_ROOT_CERT ? { PGSSLROOTCERT: env.SUPABASE_DB_SSL_ROOT_CERT } : {}) })
  dbEnv.PGOPTIONS = '-c default_transaction_read_only=on -c row_security=off -c DateStyle=ISO -c TimeZone=UTC -c IntervalStyle=postgres -c bytea_output=hex -c extra_float_digits=3'
  return { run, queryJSON, openDatabaseSnapshot, source, dbEnv, psql: env.PSQL_BIN || 'psql', dump: env.PG_DUMP_BIN || 'pg_dump', secrets: [env.SUPABASE_SERVICE_ROLE_KEY, dbEnv.PGPASSWORD, env.SIG_BACKUP_PASSPHRASE] }
}
async function schemaAndCatalog(config, directory, snapshot) {
  const path = join(directory, 'schema.sql')
  await config.run(config.dump, ['--format=plain', '--schema-only', '--schema=public', '--no-owner', `--snapshot=${snapshot}`, '--file', path], config.dbEnv, config.secrets)
  // pg_dump emits random restriction keys on recent clients; do not hash those comments/guards.
  const schema = (await readFile(path, 'utf8')).replace(/^\\(?:un)?restrict .*\r?\n/gm, '').replace(/\r\n/g, '\n')
  const catalog = await config.queryJSON(config.dbEnv, config.psql, catalogSQL, snapshot)
  return { schema, catalog }
}
export function reviewPolicy(schema, catalog) {
  return { version: 1, reviewed: false, schemaSha256: sha256(Buffer.from(schema)), exportSchemaSha256: sha256(Buffer.from(schema)), catalogSha256: sha256(Buffer.from(JSON.stringify({ ...catalog, sequences: catalog.sequences.map(({ lastValue, ...definition }) => definition) }))),
    // Lists are explicit: new/renamed columns cannot silently cross the security boundary.
    tables: Object.fromEntries(catalog.tables.map(table => [table.name, { include: table.columns.filter(column => !secretName(column.name)).map(column => column.name), exclude: table.columns.filter(column => secretName(column.name)).map(column => column.name) }])),
    storageReviewed: false,
  }
}
export function validatePolicy(policy, schema, catalog) {
  const expected = reviewPolicy(schema, catalog)
  if (policy.version !== 1 || policy.reviewed !== true || policy.storageReviewed !== true || policy.schemaSha256 !== expected.schemaSha256 || policy.catalogSha256 !== expected.catalogSha256) throw new Error('스키마·컬럼·Storage 검토가 필요하거나 검토 후 구조가 변경되었습니다. DI review를 다시 실행하세요.')
  if (!policy.tables || Object.keys(policy.tables).sort().join('\0') !== catalog.tables.map(table => table.name).sort().join('\0')) throw new Error('검토 정책의 테이블 목록이 다릅니다.')
  for (const table of catalog.tables) {
    const rule = policy.tables[table.name]
    if (!Array.isArray(rule?.include) || !Array.isArray(rule?.exclude)) throw new Error('컬럼 포함/제외 정책이 필요합니다.')
    const all = [...rule.include, ...rule.exclude]
    if (new Set(all).size !== all.length || all.length !== table.columns.length || table.columns.some(column => !all.includes(column.name)) || rule.include.some(secretName)) throw new Error('검토되지 않거나 인증 비밀정보 이름을 가진 컬럼입니다.')
    // Dropping business IDs breaks migration. Refuse rather than quietly destroy relationships.
    for (const fk of catalog.foreignKeys.filter(fk => fk.table === table.name)) if (fk.columns.some(column => !rule.include.includes(column))) throw new Error('외래키 컬럼은 제외할 수 없습니다.')
  }
}
/** Local-only review material may itself contain secrets: never publish it. */
export async function reviewDI(env = process.env) {
  const config = configuration(env), output = resolve(required(env, 'SIG_DI_REVIEW_DIRECTORY'))
  await mkdir(output, { recursive: true, mode: 0o700 })
  let connection
  const directory = await mkdtemp(join(tmpdir(), 'sig-di-review-')); await chmod(directory, 0o700)
  try {
    connection = await config.openDatabaseSnapshot(config.dbEnv, config.psql, config.secrets)
    const { schema, catalog } = await schemaAndCatalog(config, directory, connection.snapshot)
    connection.assertOpen()
    for (const [name, value] of [['public-schema.sql', schema], ['catalog.json', JSON.stringify(catalog, null, 2)], ['policy.json', JSON.stringify(reviewPolicy(schema, catalog), null, 2)]]) await writeFile(join(output, name), value, { mode: 0o600, flag: 'wx' })
    return { reviewDirectory: output, reviewed: false }
  } finally { if (connection) await connection.close().catch(() => {}); await rm(directory, { recursive: true, force: true }) }
}
export function rowQuery(table, included) {
  const columns = table.columns.filter(column => included.includes(column.name))
  // Every SQL value travels as text, so bigint/numeric/bytea never lose precision.
  const values = columns.map(column => `${ident(column.name)}::text`).join(',')
  return `select coalesce(jsonb_agg(row_values),'[]'::jsonb)::text from (select jsonb_build_array(${values}) as row_values from public.${ident(table.name)}) rows`
}
export async function backupDI(env = process.env, fetcher = fetch, clients = {}) {
  const config = { ...configuration(env), ...clients }, key = required(env, 'SUPABASE_SERVICE_ROLE_KEY'), password = required(env, 'SIG_BACKUP_PASSPHRASE'), max = byteLimit(env.SIG_BACKUP_MAX_BYTES)
  // Validate the key before opening a source connection.
  encryptBytes(Buffer.from('key validation'), password)
  const policy = JSON.parse(await readFile(resolve(required(env, 'SIG_DI_POLICY_FILE')), 'utf8'))
  const directory = await mkdtemp(join(tmpdir(), 'sig-di-')); await chmod(directory, 0o700)
  let connection
  try {
    const storage = await listStorage(config.source.url, key, fetcher)
    connection = await config.openDatabaseSnapshot(config.dbEnv, config.psql, config.secrets)
    const { schema, catalog } = await schemaAndCatalog(config, directory, connection.snapshot)
    validatePolicy(policy, schema, catalog)
    const exportSchema = await readFile(join(dirname(resolve(env.SIG_DI_POLICY_FILE)), 'public-schema.sql'))
    if (sha256(exportSchema) !== policy.exportSchemaSha256) throw new Error('검토된 내보내기 스키마 체크섬이 다릅니다.')
    assertNoCredentials(exportSchema.toString('utf8'), config.secrets)
    const counts = { public: await config.queryJSON(config.dbEnv, config.psql, countSQL, connection.snapshot) }
    const snapshotStorage = await config.queryJSON(config.dbEnv, config.psql, diStorageSQL, connection.snapshot)
    if (storageFingerprint(storage) !== storageFingerprint(snapshotStorage)) throw new Error('DB snapshot과 Storage가 다릅니다. 업로드·삭제를 멈춘 시간에 다시 실행하세요.')
    const archive = new JSZip(), files = []; let total = 0
    function add(path, bytes) {
      total += bytes.length
      if (total > max) throw new Error('백업 크기 제한을 초과했습니다.')
      files.push({ path, size: bytes.length, sha256: sha256(bytes) }); archive.file(path, bytes)
    }
    add('db/public-schema.sql', exportSchema)
    const tables = []
    for (const table of catalog.tables) {
      const included = policy.tables[table.name].include
      const columns = table.columns.filter(column => included.includes(column.name))
      const rows = await config.queryJSON(config.dbEnv, config.psql, rowQuery(table, included), connection.snapshot)
      for (const row of rows) for (let index = 0; index < columns.length; index++) {
        if (row[index] !== null && ['json', 'jsonb'].includes(columns[index].type)) row[index] = sanitizeJSONText(row[index])
        if (row[index] !== null) assertNoCredentials(row[index], config.secrets)
      }
      if (rows.length !== counts.public[table.name]) throw new Error('테이블 행 수 검증에 실패했습니다.')
      tables.push({ name: table.name, columns, excludedColumns: policy.tables[table.name].exclude, rows })
      if (Buffer.byteLength(JSON.stringify(tables)) + total > max) throw new Error('백업 크기 제한을 초과했습니다.')
    }
    add('db/public-data.json', Buffer.from(JSON.stringify({ encoding: 'postgres-text-v1', tables })))
    add('db/catalog.json', Buffer.from(JSON.stringify(catalog)))
    connection.assertOpen(); await connection.close(); connection = undefined
    const objectDetails = new Map(snapshotStorage.objects.map(object => [`${object.bucket}/${object.name}`, object.databaseMetadata]))
    for (const object of storage.objects) {
      storageName(object.bucket, true); storageName(object.name)
      const bytes = await limitedBytes(await api(fetcher, `${config.source.url}/storage/v1/object/${encodeURIComponent(object.bucket)}/${object.name.split('/').map(encodeURIComponent).join('/')}`, key), max - total)
      if (Number.isFinite(object.metadata.size) && bytes.length !== object.metadata.size) throw new Error('Storage 파일 크기가 변경되었습니다.')
      // Files remain byte-for-byte exact. Suspected credentials cause failure, not corruption.
      assertNoCredentials(bytes.toString('utf8'), config.secrets)
      object.databaseMetadata = sanitizeJSON(objectDetails.get(`${object.bucket}/${object.name}`))
      object.metadata = sanitizeJSON(object.metadata)
      object.path = `storage/${sha256(Buffer.from(`${object.bucket}/${object.name}`))}.bin`
      add(object.path, bytes)
    }
    const after = await listStorage(config.source.url, key, fetcher)
    // Compare raw metadata to the DB snapshot; sanitized archive metadata is separate.
    if (storageFingerprint(snapshotStorage) !== storageFingerprint(after)) throw new Error('백업 도중 Storage가 변경되었습니다.')
    storage.buckets = sanitizeJSON(snapshotStorage.buckets)
    assertNoCredentials(storage, config.secrets)
    const manifest = validateManifest({ format: 'sig-di-backup', version: 1, excludesAuth: true, createdAt: new Date().toISOString(), source: { projectRef: config.source.ref }, counts, storage, files,
      review: { schemaSha256: policy.schemaSha256, catalogSha256: policy.catalogSha256 },
      consistency: { database: 'exported-repeatable-read-snapshot', storage: 'stable-listing-before-after', crossServiceAtomic: false },
      exclusions: { columns: Object.fromEntries(tables.filter(table => table.excludedColumns.length).map(table => [table.name, table.excludedColumns])), nestedJSON: 'authentication-key names removed recursively', auth: 'no auth schema reads or data' },
    })
    const manifestJSON = JSON.stringify(manifest, null, 2)
    if (total + Buffer.byteLength(manifestJSON) > max) throw new Error('백업 크기 제한을 초과했습니다.')
    archive.file('manifest.json', manifestJSON)
    const output = resolve(required(env, 'SIG_BACKUP_DIRECTORY')); await mkdir(output, { recursive: true, mode: 0o700 })
    const filename = join(output, `SIG-DI-${config.source.ref}-${manifest.createdAt.replace(/[:.]/g, '-')}.sigbackup`)
    try {
      const encrypted = encryptBytes(await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), password)
      await writeFile(filename, encrypted, { mode: 0o600, flag: 'wx' })
      await readArchive(filename, password, max)
      const checksum = sha256(encrypted)
      await writeFile(`${filename}.sha256`, `${checksum}  ${basename(filename)}\n`, { mode: 0o600, flag: 'wx' })
      return { file: filename, sha256: checksum, tables: tables.length, objects: storage.objects.length, mode: 'di', verified: true }
    } catch (error) { await rm(filename, { force: true }); await rm(`${filename}.sha256`, { force: true }); throw error }
  } finally { if (connection) await connection.close().catch(() => {}); await rm(directory, { recursive: true, force: true }) }
}
/** Authentication and every checksum are verified before creating any plaintext output. */
export async function decryptDI(path, output, env = process.env) {
  if (env.GITHUB_ACTIONS === 'true') throw new Error('DI 복호화는 비공개 로컬 환경에서만 실행하세요.')
  const { manifest, files } = await readArchive(resolve(path), required(env, 'SIG_BACKUP_PASSPHRASE'), byteLimit(env.SIG_BACKUP_MAX_BYTES))
  if (manifest.format !== 'sig-di-backup') throw new Error('DI 형식이 아닙니다. 전체 백업을 DI팀에 전달하지 마세요.')
  const target = resolve(output)
  await mkdir(target, { mode: 0o700 }) // must not exist; no overwrite of unrelated files
  try {
    for (const [name, bytes] of files) { const file = join(target, name); await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 }); await writeFile(file, bytes, { mode: 0o600, flag: 'wx' }) }
    await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' })
    return { directory: target, checksumsVerified: true, mode: 'di' }
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const task = args.length === 1 && args[0] === 'review' ? reviewDI() : args.length === 1 && args[0] === 'backup' ? backupDI() : args.length === 3 && args[0] === 'decrypt' ? decryptDI(args[1], args[2]) : Promise.reject(new Error('사용법: node scripts/backup-di.mjs review | backup | decrypt FILE NEW_PRIVATE_DIRECTORY'))
  task.then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(redact(error.message, [process.env.SUPABASE_DB_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.SIG_BACKUP_PASSPHRASE])); process.exitCode = 1 })
}
