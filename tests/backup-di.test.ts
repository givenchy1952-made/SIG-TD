import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import JSZip from 'jszip'

import { backupDI, catalogSQL, decryptDI, reviewPolicy, rowQuery, sanitizeJSON, sanitizeJSONText, secretName, assertNoCredentials, validatePolicy } from '../scripts/backup-di.mjs'
import { encryptBytes, readArchive, restoreWorkspace, sha256, validateManifest } from '../scripts/backup-workspace.mjs'
const password = 'synthetic-only-passphrase-with-48-characters-123456'
const bucket = { id: 'files', name: 'files', public: false, file_size_limit: null, allowed_mime_types: null }
const bytes = Buffer.from('synthetic-pdf-bytes')
const object = { bucket: 'files', name: 'sample.pdf', id: 'object-1', updatedAt: '2026-01-01T00:00:00.000Z', metadata: { size: bytes.length, mimetype: 'application/pdf' }, databaseMetadata: { owner_id: 'original-uuid', user_metadata: { description: 'business', refresh_token: 'must-remove' } } }
const catalog = { tables: [{ name: 'profiles', rls: true, columns: [{ name: 'id', type: 'bigint', generated: '', identity: '' }, { name: 'data', type: 'jsonb', generated: '', identity: '' }, { name: 'access_token', type: 'text', generated: '', identity: '' }] }], foreignKeys: [] as any[], sequences: [] as any[] }
const state = { calls: [] as string[], reads: [] as string[], schema: 'CREATE TABLE public.profiles(id uuid, name text, access_token text);\n', rows: [['9007199254740993', '{"userId":"original-uuid","nested":{"refresh_token":"hidden","business":3}}']], changed: false, closed: false }
// Dependency injection keeps process orchestration tests portable without transforming CLI modules.
const clients = {
  openDatabaseSnapshot: async () => ({ snapshot: '00000001-00000002-1', assertOpen() {}, close: async () => { state.closed = true } }),
  run: async (_command: string, args: string[], env: Record<string, string>) => {
    state.calls.push(JSON.stringify(args)); expect(env.PGOPTIONS).toContain('default_transaction_read_only=on')
    await writeFile(args[args.indexOf('--file') + 1], state.schema); return ''
  },
  queryJSON: async (_env: unknown, _command: unknown, sql: string) => {
    state.reads.push(sql)
    if (sql.includes("'foreignKeys'")) return catalog
    if (sql.includes('query_to_xml')) return { profiles: 1 }
    if (sql.includes('as storage_snapshot')) return { buckets: [bucket], objects: [object] }
    return structuredClone(state.rows)
  },
}
const temporary: string[] = []
async function directory() { const path = await mkdtemp(join(tmpdir(), 'sig-di-test-')); temporary.push(path); return path }
beforeEach(() => { state.calls = []; state.reads = []; state.changed = false; state.closed = false; state.rows = [['9007199254740993', '{"userId":"original-uuid","nested":{"refresh_token":"hidden","business":3}}']] })
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const path = await directory(), policy = { ...reviewPolicy(state.schema, catalog), reviewed: true, storageReviewed: true }
  await writeFile(join(path, 'policy.json'), JSON.stringify(policy))
  await writeFile(join(path, 'public-schema.sql'), state.schema)
  let listings = 0
  const fetcher = async (url: string, options: RequestInit = {}) => {
    if (url.endsWith('/bucket')) return Response.json([bucket])
    if (url.includes('/object/list/')) { listings++; return Response.json([{ name: object.name, id: object.id, updated_at: state.changed && listings > 1 ? '2026-02-01' : object.updatedAt, metadata: object.metadata }]) }
    expect(options.method).toBeUndefined()
    return new Response(bytes)
  }
  const env = { SUPABASE_URL: 'https://source123.supabase.co', SUPABASE_DB_URL: 'postgresql://postgres:synthetic-db-password@db.source123.supabase.co/postgres', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-secret-key', SIG_BACKUP_PASSPHRASE: password, SIG_DI_POLICY_FILE: join(path, 'policy.json'), SIG_BACKUP_DIRECTORY: join(path, 'backups'), GITHUB_ACTIONS: '' }
  return { path, policy, env, fetcher }
}
describe('DI export security and compatibility', () => {
  it('exports public only, preserves precision and IDs, excludes secret columns/nested keys, verifies and decrypts exact files', async () => {
    const test = await fixture(), result = await backupDI(test.env, test.fetcher, clients)
    const { manifest, files } = await readArchive(result.file, password)
    expect(manifest.format).toBe('sig-di-backup'); expect(manifest.counts).toEqual({ public: { profiles: 1 } })
    expect([...files.keys()]).toEqual(['db/public-schema.sql', 'db/public-data.json', 'db/catalog.json', expect.stringMatching(/^storage\//)])
    const data = JSON.parse(files.get('db/public-data.json')!.toString())
    expect(data.tables[0].rows).toEqual([['9007199254740993', '{"userId":"original-uuid","nested":{"business":3}}']])
    expect(data.tables[0].excludedColumns).toEqual(['access_token'])
    expect(manifest.storage.objects[0].databaseMetadata).toEqual({ owner_id: 'original-uuid', user_metadata: { description: 'business' } })
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]).toContain('--schema-only'); expect(state.calls[0]).toContain('--schema=public'); expect(state.calls[0]).toContain('--snapshot=')
    expect(state.reads.join('\n')).not.toMatch(/from auth\.|count\(\*\) from auth/i)
    expect(state.closed).toBe(true)
    await expect(restoreWorkspace(result.file, test.env)).rejects.toThrow(/DI/)
    const target = join(test.path, 'decrypted')
    expect(await decryptDI(result.file, target, test.env)).toMatchObject({ checksumsVerified: true })
    expect(await readFile(join(target, manifest.storage.objects[0].path))).toEqual(bytes)
    await expect(decryptDI(result.file, target, test.env)).rejects.toThrow()
  })
  it.skipIf(process.platform !== 'win32')('runs the PowerShell decrypt wrapper with a private env file on Windows', async () => {
    const test = await fixture(), result = await backupDI(test.env, test.fetcher, clients)
    const envFile = join(test.path, 'decrypt.env'), target = join(test.path, 'powershell-decrypted')
    await writeFile(envFile, `SIG_BACKUP_PASSPHRASE=${password}\n`)
    const child = spawnSync('pwsh', ['-NoProfile', '-File', fileURLToPath(new URL('../scripts/backup-di.ps1', import.meta.url)), '-Mode', 'Decrypt', '-EnvironmentFile', envFile, '-BackupFile', result.file, '-OutputDirectory', target], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } })
    expect(child.stderr).toBe(''); expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout)).toMatchObject({ checksumsVerified: true, mode: 'di' })
  })
  it('refuses unreviewed policy and drift before exporting any rows', async () => {
    const test = await fixture(); test.policy.reviewed = false
    await writeFile(test.env.SIG_DI_POLICY_FILE, JSON.stringify(test.policy))
    await expect(backupDI(test.env, test.fetcher, clients)).rejects.toThrow(/검토/)
    expect(state.reads.some(sql => sql.includes('row_values'))).toBe(false)
    expect(() => validatePolicy({ ...test.policy, reviewed: true, schemaSha256: 'bad' }, state.schema, catalog)).toThrow()
    expect(() => validatePolicy({ ...test.policy, reviewed: true, tables: { profiles: { include: ['id', 'data', 'access_token'], exclude: [] } } }, state.schema, catalog)).toThrow()
  })
  it('requires reviewed export SQL checksum and rejects credentials in reviewed DDL', async () => {
    const test = await fixture(), file = join(test.path, 'public-schema.sql')
    await writeFile(file, state.schema + '-- local edit')
    await expect(backupDI(test.env, test.fetcher, clients)).rejects.toThrow(/체크섬/)
    const badSchema = state.schema + "-- Bearer forbidden-token"
    test.policy.exportSchemaSha256 = sha256(Buffer.from(badSchema))
    await writeFile(test.env.SIG_DI_POLICY_FILE, JSON.stringify(test.policy)); await writeFile(file, badSchema)
    await expect(backupDI(test.env, test.fetcher, clients)).rejects.toThrow(/비밀값/)
  })
  it('rejects known/embedded credentials rather than exporting them', async () => {
    const test = await fixture(); state.rows[0][1] = '{"note":"Bearer abc-secret"}'
    await expect(backupDI(test.env, test.fetcher, clients)).rejects.toThrow(/비밀값/)
    for (const value of ['postgresql://user:password@host/db', 'Bearer private', 'sb_secret_private', '-----BEGIN PRIVATE KEY-----', 'eyJhbGciOi.xxxxx.yyyyy']) expect(() => assertNoCredentials(value)).toThrow()
    expect(() => assertNoCredentials('my synthetic-server-secret-key', ['synthetic-server-secret-key'])).toThrow()
  })
  it('fails on Storage mutation and size bounds; blocks Actions before any source calls', async () => {
    const test = await fixture(); state.changed = true
    await expect(backupDI(test.env, test.fetcher, clients)).rejects.toThrow(/변경/)
    await expect(backupDI({ ...test.env, GITHUB_ACTIONS: 'true' }, test.fetcher, clients)).rejects.toThrow(/Actions/)
    state.changed = false
    await expect(backupDI({ ...test.env, SIG_BACKUP_MAX_BYTES: '1024' }, test.fetcher, clients)).rejects.toThrow(/크기/)
  })
  it('authenticates corrupted encrypted files before creating a plaintext directory', async () => {
    const test = await fixture(), result = await backupDI(test.env, test.fetcher, clients)
    const data = await readFile(result.file); data[data.length - 1] ^= 1; await writeFile(result.file, data)
    const target = join(test.path, 'must-not-exist')
    await expect(decryptDI(result.file, target, test.env)).rejects.toThrow(/손상/)
    await expect(access(target)).rejects.toThrow()
  })
  it('DI manifests cannot declare auth/full files or auth counts', async () => {
    const test = await fixture(), result = await backupDI(test.env, test.fetcher, clients), archive = await readArchive(result.file, password)
    for (const path of ['db/full.dump', 'db/auth-accounts.dump']) expect(() => validateManifest({ ...archive.manifest, files: [...archive.manifest.files, { path, size: 0, sha256: sha256(Buffer.alloc(0)) }] })).toThrow()
    expect(() => validateManifest({ ...archive.manifest, counts: { ...archive.manifest.counts, auth: {} } })).toThrow()
    const zip = new JSZip(); archive.files.forEach((bytes, name) => zip.file(name, bytes)); zip.file('db/public-data.json', 'tampered'); zip.file('manifest.json', JSON.stringify(archive.manifest))
    const path = join(test.path, 'tampered.sigbackup'); await writeFile(path, encryptBytes(await zip.generateAsync({ type: 'nodebuffer' }), password))
    await expect(readArchive(path, password)).rejects.toThrow()
  })
  it('filters secret keys recursively without changing business UUID references', () => {
    expect(sanitizeJSONText('{"amount":9007199254740993.1234,"secret":"remove","nested":[{"count":9007199254740995,"token":"remove"},[],{}]}')).toBe('{"amount":9007199254740993.1234,"nested":[{"count":9007199254740995},[],{}]}')
    expect(secretName('user_id')).toBe(false)
    expect(sanitizeJSON({ user_id: 'uuid', audits: [{ password_hash: 'x', child: { apiKey: 'x', ownerId: 'uuid' } }] })).toEqual({ user_id: 'uuid', audits: [{ child: { ownerId: 'uuid' } }] })
  })
})

describe('DI catalog and extraction SQL on isolated PostgreSQL', () => {
  it('discovers external FK mappings and preserves PostgreSQL text values without reading auth rows', async () => {
    const db = new PGlite()
    try {
      await db.exec(`create schema auth; create table auth.users(id uuid primary key, encrypted_password text); create table public.profiles(id uuid primary key references auth.users(id), amount numeric(30,4), data jsonb, access_token text); insert into auth.users values ('11111111-1111-1111-1111-111111111111','never-export'); insert into public.profiles values ('11111111-1111-1111-1111-111111111111',9007199254740993.1234,'{"userId":"11111111-1111-1111-1111-111111111111"}','never-export');`)
      const result = await db.query<{ jsonb_build_object: string }>(catalogSQL)
      const actualCatalog = JSON.parse(Object.values(result.rows[0])[0] as string)
      expect(actualCatalog.foreignKeys[0]).toMatchObject({ table: 'profiles', targetSchema: 'auth', targetTable: 'users', columns: ['id'], targetColumns: ['id'] })
      const resultRows = await db.query(rowQuery(actualCatalog.tables[0], ['id', 'amount', 'data']))
      const data = JSON.parse(Object.values(resultRows.rows[0])[0] as string)
      expect(data[0]).toContain('9007199254740993.1234')
      expect(JSON.stringify(data)).not.toContain('never-export')
      const policy = { ...reviewPolicy('schema', actualCatalog), reviewed: true, storageReviewed: true }
      expect(() => validatePolicy(policy, 'schema', actualCatalog)).not.toThrow()
      expect(() => validatePolicy({ ...policy, tables: { profiles: { include: ['amount', 'data'], exclude: ['id', 'access_token'] } } }, 'schema', actualCatalog)).toThrow(/외래키/)
    } finally { await db.close() }
  })
})
