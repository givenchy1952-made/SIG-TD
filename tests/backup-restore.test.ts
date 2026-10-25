import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'
import { PGlite } from '@electric-sql/pglite'
import {
  assertRestoreTarget, backupWorkspace, decryptBytes, encryptBytes, listStorage,
  platformDefinitionsSQL, postgresEnvironment, projectEndpoint, readArchive, redact, restoreWorkspace, sha256, storageName, validateManifest,
} from '../scripts/backup-workspace.mjs'

const password = 'test-only-random-backup-passphrase-32-characters'
const sourceRef = 'source123'
const targetRef = 'target456'
const sourceURL = `https://${sourceRef}.supabase.co`
const targetURL = `https://${targetRef}.supabase.co`
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function directory() { const path = await mkdtemp(join(tmpdir(), 'sig-backup-test-')); temporary.push(path); return path }
function fixture() {
  const files = new Map([
    ['db/full.dump', Buffer.from('full custom dump')],
    ['db/public-schema.dump', Buffer.from('public schema dump')],
    ['db/public-data.dump', Buffer.from('public data dump')],
    ['db/auth-accounts.dump', Buffer.from('auth accounts dump')],
    ['db/platform-app.json', Buffer.from(JSON.stringify({ authTriggers: [], storagePolicies: [] }))],
  ])
  const manifest = {
    format: 'sig-workspace-backup', version: 1, source: { projectRef: sourceRef },
    counts: { public: { profiles: 1 }, auth: { users: 1, identities: 1, mfa_factors: 0 } },
    storage: { buckets: [], objects: [] },
    files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha256(bytes) })),
  }
  return { files, manifest }
}
async function archiveFile(edit?: (zip: JSZip, manifest: ReturnType<typeof fixture>['manifest']) => void) {
  const zip = new JSZip(), { files, manifest } = fixture()
  files.forEach((bytes, name) => zip.file(name, bytes))
  edit?.(zip, manifest)
  zip.file('manifest.json', JSON.stringify(manifest))
  const path = join(await directory(), 'backup.sigbackup')
  await writeFile(path, encryptBytes(await zip.generateAsync({ type: 'nodebuffer' }), password))
  return path
}

describe('encrypted backup boundary', () => {
  it('encrypts with fresh salt/nonce and authenticates both header and payload', () => {
    const plain = Buffer.from('database + private photo + PDF'), first = encryptBytes(plain, password), second = encryptBytes(plain, password)
    expect(first.equals(second)).toBe(false)
    expect(first.includes(plain)).toBe(false)
    expect(decryptBytes(first, password)).toEqual(plain)
    expect(() => decryptBytes(first, `${password}-wrong`)).toThrow(/암호|손상/)
    for (const index of [20, first.length - 20, first.length - 1]) {
      const changed = Buffer.from(first); changed[index] ^= 1
      expect(() => decryptBytes(changed, password)).toThrow()
    }
  })
  it('rejects weak encryption keys and malformed envelopes', () => {
    expect(() => encryptBytes(Buffer.from('x'), 'short')).toThrow(/32자/)
    expect(() => decryptBytes(Buffer.from('not encrypted'), password)).toThrow(/형식/)
  })
  it('checks every declared file and retains platform policies/signup trigger definitions', async () => {
    const { manifest, files } = await readArchive(await archiveFile(), password)
    expect(manifest.files).toHaveLength(5)
    expect(files.get('db/platform-app.json')).toEqual(fixture().files.get('db/platform-app.json'))
  })
  it('rejects a changed dump even when the container was encrypted again', async () => {
    const path = await archiveFile(zip => zip.file('db/full.dump', Buffer.from('FULL custom dump')))
    await expect(readArchive(path, password)).rejects.toThrow(/체크섬/)
  })
  it('rejects missing files, undeclared entries, and ZIP traversal', async () => {
    for (const edit of [
      (zip: JSZip) => zip.remove('db/full.dump'),
      (zip: JSZip) => zip.file('unknown.sql', 'DROP DATABASE'),
      (zip: JSZip) => zip.file('../escape', 'outside'),
    ]) await expect(readArchive(await archiveFile(edit), password)).rejects.toThrow(/누락|허용되지 않은/)
  })
  it('bounds decompressed contents and validates limits', async () => {
    const path = await archiveFile((zip, manifest) => {
      const bytes = Buffer.alloc(4096, 65)
      zip.file('db/full.dump', bytes)
      manifest.files[0] = { path: 'db/full.dump', size: bytes.length, sha256: sha256(bytes) }
    })
    await expect(readArchive(path, password, 1024)).rejects.toThrow(/크기 제한/)
    await expect(readArchive(path, password, -1)).rejects.toThrow(/크기 제한/)
  })
  it('rejects duplicate/orphan storage metadata and missing policy definitions', () => {
    const { manifest } = fixture()
    expect(validateManifest(manifest)).toBe(manifest)
    expect(() => validateManifest({ ...manifest, files: [...manifest.files, manifest.files[0]] })).toThrow()
    expect(() => validateManifest({ ...manifest, files: manifest.files.filter(file => file.path !== 'db/platform-app.json') })).toThrow(/권한/)
    expect(() => validateManifest({ ...manifest, storage: { buckets: [], objects: [{ bucket: 'missing', name: 'x', path: 'storage/' + '0'.repeat(64) + '.bin' }] } })).toThrow()
  })
})

describe('project and restore safety', () => {
  it('extracts restorable signup triggers and Storage RLS definitions from real PostgreSQL catalogs', async () => {
    const source = new PGlite(), target = new PGlite()
    const base = `CREATE ROLE authenticated; CREATE SCHEMA auth; CREATE SCHEMA storage;
      CREATE TABLE auth.users(id uuid); CREATE TABLE storage.objects(name text, bucket_id text);
      CREATE TABLE storage.buckets(id text);
      CREATE FUNCTION public.on_auth_signup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`
    try {
      await source.exec(base)
      await source.exec(`CREATE TRIGGER sig_auth_signup AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.on_auth_signup();
        CREATE POLICY "file read" ON storage.objects FOR SELECT TO authenticated USING (bucket_id='sig-files');
        CREATE POLICY "bucket insert" ON storage.buckets AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (id='sig-files');`)
      const result = await source.query<{ definitions: string }>(platformDefinitionsSQL)
      const definitions = JSON.parse(result.rows[0].definitions)
      expect(definitions.authTriggers).toHaveLength(1)
      expect(definitions.storagePolicies).toHaveLength(2)
      await target.exec(base)
      await target.exec([...definitions.authTriggers, ...definitions.storagePolicies].join('\n'))
      const restored = await target.query<{ definitions: string }>(platformDefinitionsSQL)
      expect(JSON.parse(restored.rows[0].definitions)).toEqual(definitions)
    } finally { await source.close(); await target.close() }
  })
  it.each(['http://source123.supabase.co', `${sourceURL}/rest/v1`, `${sourceURL}?key=secret`, 'https://attacker.example', 'https://user:password@source123.supabase.co'])('rejects unsupported API endpoint %s', value => {
    expect(() => projectEndpoint(value)).toThrow()
  })
  it('matches API project to direct or session-pooler DB without credentials in arguments', () => {
    const direct = postgresEnvironment('postgresql://postgres:p%40ssword@db.source123.supabase.co:5432/postgres', sourceRef)
    expect(direct).toMatchObject({ PGHOST: 'db.source123.supabase.co', PGPASSWORD: 'p@ssword', PGDATABASE: 'postgres', PGSSLMODE: 'verify-full', PGHOSTADDR: '', PGSERVICE: '' })
    expect(postgresEnvironment('postgresql://postgres.source123:password@aws-0.pooler.supabase.com:5432/postgres', sourceRef).PGUSER).toBe('postgres.source123')
    expect(() => postgresEnvironment('postgresql://postgres:password@db.other123.supabase.co/postgres', sourceRef)).toThrow(/일치/)
    expect(() => postgresEnvironment('postgresql://postgres.source123:password@aws-0.pooler.supabase.com:6543/postgres', sourceRef)).toThrow(/6543/)
    expect(() => postgresEnvironment('postgresql://postgres@db.source123.supabase.co/postgres', sourceRef)).toThrow(/비밀번호/)
  })
  it('refuses source/protected projects and requires exact typed target', () => {
    const { manifest } = fixture()
    expect(() => assertRestoreTarget(manifest, sourceRef, sourceRef)).toThrow(/운영/)
    expect(() => assertRestoreTarget(manifest, targetRef, 'typo')).toThrow(/일치/)
    expect(() => assertRestoreTarget(manifest, targetRef, targetRef, [targetRef])).toThrow(/운영/)
    expect(() => assertRestoreTarget(manifest, targetRef, targetRef)).not.toThrow()
  })
  it.each(['../x', '/x', 'a//b', 'a/../b', 'a\u0000b', 'a/'])('rejects unsafe storage name %s', value => expect(() => storageName(value)).toThrow())
  it('redacts postgres URLs, bearer credentials and supplied secrets', () => {
    const result = redact('postgresql://user:database-password@db.example/postgres Bearer private-token api-secret passphrase-secret', ['api-secret', 'passphrase-secret'])
    expect(result).not.toMatch(/database-password|private-token|api-secret|passphrase-secret/)
  })
  it('never accepts a failed Storage request as an empty successful backup', async () => {
    await expect(listStorage(sourceURL, 'wrong-key', async () => new Response('not authorized', { status: 403 }))).rejects.toThrow(/403/)
  })
})

// Fake client executables record orchestration. They do not emulate PostgreSQL
// data restoration; real pg_dump/pg_restore + hosted restore drills remain separate.
async function integration() {
  const path = await directory()
  const tool = `#!/usr/bin/env node
const fs=require('node:fs'),p=require('node:path'); const d=p.dirname(process.argv[1]),a=process.argv.slice(2),kind=p.basename(process.argv[1]);
const stateFile=p.join(d,'state.json'),log=p.join(d,'events.jsonl'); let s=JSON.parse(fs.readFileSync(stateFile));
fs.appendFileSync(log,JSON.stringify({kind,args:a,host:process.env.PGHOST})+'\\n');
const write=()=>fs.writeFileSync(stateFile,JSON.stringify(s)); const source=process.env.PGHOST.includes('source123');
if(kind==='psql'){
 if(a.includes('--file')){s.platform=fs.readFileSync(a[a.indexOf('--file')+1],'utf8');write();process.exit(0)}
 if(!a.includes('-c')){process.stdin.on('data',b=>{if(String(b).includes('pg_export_snapshot'))console.log('SIG_SNAPSHOT:00000001-00000002-1'); if(String(b).includes('ROLLBACK'))process.exit(0)});}
 else {const q=a[a.indexOf('-c')+1];
  if(q.includes("'authTriggers'"))console.log(JSON.stringify({authTriggers:['CREATE TRIGGER sig_auth_signup AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.on_auth_signup();'],storagePolicies:['CREATE POLICY sig_files_read ON storage.objects FOR SELECT TO authenticated USING (true);']}));
  else if(q.includes('jsonb_object_agg'))console.log(JSON.stringify(source||s.public?{profiles:1,styles:1}:{}));
  else if(q.includes('as storage_snapshot'))console.log(JSON.stringify({buckets:[{id:'sig-files',name:'sig-files',public:false,file_size_limit:100000,allowed_mime_types:['image/png','application/pdf']}],objects:[{bucket:'sig-files',name:'style/photo.png',id:'object-id',updatedAt:'original',metadata:{size:27,mimetype:'image/png'}}]}));
  else if(q.includes("'mfa_factors'"))console.log(JSON.stringify({users:source||s.auth?1:0,identities:source||s.auth?1:0,mfa_factors:0}));
  else console.log(s.schema?1:0);
 }
} else if(kind==='pg_dump'){
 if(a.includes('--version'))console.log('pg_dump (PostgreSQL) 17.4');
 else fs.writeFileSync(a[a.indexOf('--file')+1],'PGDMP '+(a.includes('--schema-only')?'schema':a.some(v=>v==='--table=auth.users')?'auth':a.includes('--data-only')?'public':'full'));
} else if(kind==='pg_restore'){
 if(a.includes('--list'))console.log('5; 2615 2200 SCHEMA - public postgres\\n9; 1255 1 FUNCTION public on_auth_signup() postgres');
 else {if(a.includes('--section=pre-data'))s.schema=true; if(a.at(-1).endsWith('auth-accounts.dump'))s.auth=true; if(a.at(-1).endsWith('public-data.dump'))s.public=true; if(a.includes('--section=post-data'))s.post=true;write();}
}
`
  for (const name of ['psql', 'pg_dump', 'pg_restore']) { await writeFile(join(path, name), tool); await chmod(join(path, name), 0o700) }
  await writeFile(join(path, 'state.json'), '{}')
  const bytes = Buffer.from('private-photo-and-pdf-bytes'), objectName = 'style/photo.png'
  const bucket = { id: 'sig-files', name: 'sig-files', public: false, file_size_limit: 100000, allowed_mime_types: ['image/png', 'application/pdf'] }
  const targetBuckets: typeof bucket[] = [], targetObjects = new Map<string, Buffer>()
  let mutateSource = false, sourceListings = 0
  const fetcher = async (input: string, options: RequestInit = {}) => {
    const url = new URL(input), source = url.origin === sourceURL, key = source ? 'source-server-secret-key' : 'target-server-secret-key'
    expect(new Headers(options.headers).get('apikey')).toBe(key)
    if (url.pathname === '/storage/v1/bucket') {
      if (options.method === 'POST') { targetBuckets.push(JSON.parse(options.body as string)); return Response.json({}) }
      return Response.json(source ? [bucket] : targetBuckets)
    }
    if (url.pathname.startsWith('/storage/v1/object/list/')) {
      const { prefix } = JSON.parse(options.body as string)
      const names = source ? [objectName] : [...targetObjects.keys()]
      if (!prefix) { if (source) sourceListings++; return Response.json(names.length ? [{ name: 'style', id: null, metadata: null }] : []) }
      return Response.json(names.map(name => ({ id: 'object-id', name: name.slice(prefix.length + 1), updated_at: mutateSource && sourceListings > 1 ? 'changed' : 'original', metadata: { size: bytes.length, mimetype: 'image/png' } })))
    }
    const name = decodeURIComponent(url.pathname.slice('/storage/v1/object/sig-files/'.length))
    if (options.method === 'POST') { expect(new Headers(options.headers).get('x-upsert')).toBe('false'); targetObjects.set(name, Buffer.from(options.body as Uint8Array)); return Response.json({}) }
    const data = source ? bytes : targetObjects.get(name)
    return data ? new Response(data, { headers: { 'Content-Length': String(data.length) } }) : new Response('', { status: 404 })
  }
  const env = {
    SUPABASE_URL: sourceURL, SUPABASE_DB_URL: `postgresql://postgres:source-password@db.${sourceRef}.supabase.co/postgres`, SUPABASE_SERVICE_ROLE_KEY: 'source-server-secret-key',
    TARGET_SUPABASE_URL: targetURL, TARGET_SUPABASE_DB_URL: `postgresql://postgres:target-password@db.${targetRef}.supabase.co/postgres`, TARGET_SUPABASE_SERVICE_ROLE_KEY: 'target-server-secret-key',
    SIG_BACKUP_PASSPHRASE: password, SIG_BACKUP_DIRECTORY: join(path, 'backups'),
    PSQL_BIN: join(path, 'psql'), PG_DUMP_BIN: join(path, 'pg_dump'), PG_RESTORE_BIN: join(path, 'pg_restore'),
  }
  return { path, env, fetcher, targetObjects, targetBuckets, bytes, mutate: () => { mutateSource = true } }
}

describe('backup/restore CLI orchestration with isolated fake tools and Storage', () => {
  it('takes all dumps from one DB snapshot and produces encrypted verified DB+file artifact', async () => {
    const test = await integration(), result = await backupWorkspace(test.env, test.fetcher)
    const { manifest, files } = await readArchive(result.file, password)
    expect(result).toMatchObject({ objects: 1, tables: 2, projectRef: sourceRef })
    expect(manifest.consistency).toMatchObject({ database: 'exported-repeatable-read-snapshot', crossServiceAtomic: false })
    expect(files.get(manifest.storage.objects[0].path)).toEqual(test.bytes)
    expect((await stat(result.file)).mode & 0o777).toBe(0o600)
    expect(await readFile(`${result.file}.sha256`, 'utf8')).toContain(result.sha256)
    const events = (await readFile(join(test.path, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const dumps = events.filter(event => event.kind === 'pg_dump' && !event.args.includes('--version'))
    expect(dumps).toHaveLength(4)
    expect(dumps.every(event => event.args.includes('--snapshot=00000001-00000002-1'))).toBe(true)
    expect(JSON.stringify(events)).not.toContain('source-password')
  })
  it('defaults to verified dry-run and restores rows before application triggers when explicitly applied', async () => {
    const test = await integration(), backup = await backupWorkspace(test.env, test.fetcher)
    expect(await restoreWorkspace(backup.file, test.env, { confirmTarget: targetRef }, test.fetcher)).toMatchObject({ mode: 'dry-run', checksumsVerified: true })
    expect(test.targetObjects.size).toBe(0)
    expect(JSON.parse(await readFile(join(test.path, 'state.json'), 'utf8'))).toEqual({})
    expect(await restoreWorkspace(backup.file, test.env, { apply: true, confirmTarget: targetRef }, test.fetcher)).toMatchObject({ mode: 'apply', databaseCountsVerified: true, storageBytesVerified: true })
    expect(test.targetObjects.get('style/photo.png')).toEqual(test.bytes)
    const state = JSON.parse(await readFile(join(test.path, 'state.json'), 'utf8'))
    expect(state).toMatchObject({ schema: true, auth: true, public: true, post: true })
    expect(state.platform).toContain('CREATE TRIGGER sig_auth_signup')
    expect(state.platform).toContain('CREATE POLICY sig_files_read')
    const events = (await readFile(join(test.path, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const restores = events.filter(event => event.kind === 'pg_restore' && !event.args.includes('--list'))
    expect(restores[0].args).toContain('--section=pre-data')
    expect(restores[1].args.at(-1)).toContain('auth-accounts.dump')
    expect(restores[2].args.at(-1)).toContain('public-data.dump')
    expect(restores[3].args).toContain('--section=post-data')
    await expect(restoreWorkspace(backup.file, test.env, { apply: true, confirmTarget: targetRef }, test.fetcher)).rejects.toThrow(/새 프로젝트/)
  })
  it('refuses a target that already contains user app objects even during dry-run', async () => {
    const test = await integration(), backup = await backupWorkspace(test.env, test.fetcher)
    await writeFile(join(test.path, 'state.json'), JSON.stringify({ schema: true }))
    await expect(restoreWorkspace(backup.file, test.env, { confirmTarget: targetRef }, test.fetcher)).rejects.toThrow(/새 프로젝트/)
    expect(test.targetObjects.size).toBe(0)
  })
  it('fails rather than publishing success when Storage changes during a backup', async () => {
    const test = await integration(); test.mutate()
    await expect(backupWorkspace(test.env, test.fetcher)).rejects.toThrow(/파일이 바뀌었습니다/)
  })
})
