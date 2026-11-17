#!/usr/bin/env node
/** Real client/snapshot test on synthetic data. Linux/WSL + Docker only. */
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { reviewDI, backupDI, decryptDI } from './backup-di.mjs'
import { readArchive } from './backup-workspace.mjs'

if (process.platform === 'win32') throw new Error('이 격리 Docker 검증 스크립트는 Linux/WSL에서 실행하세요. Windows 도구는 backup-di.ps1입니다.')
const container = `sig-di-test-${randomUUID()}`, directory = await mkdtemp(join(tmpdir(), 'sig-di-postgres-test-'))
function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 120_000 })
  if (result.error || result.status !== 0) throw new Error(`Synthetic Docker test failed: ${result.error?.message || result.stderr}`)
  return result.stdout
}
try {
  docker(['run', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=synthetic-local-only', 'postgres:17'])
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres']).status === 0) { ready = true; break }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert(ready, 'isolated PostgreSQL did not start')
  docker(['exec', '-i', container, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], await readFile(new URL('../tests/fixtures/di-backup-postgres.sql', import.meta.url)))
  // Client wrappers bridge local files/stdin to real PostgreSQL clients in the container.
  const wrapper = `#!/usr/bin/env node
const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const kind=path.basename(process.argv[1]),args=process.argv.slice(2),index=args.indexOf('--file');let file;
if(kind==='pg_dump'&&index>=0){file=args[index+1];args.splice(index,2)}
const child=spawn('docker',['exec','-i','-e','PGOPTIONS='+process.env.PGOPTIONS,${JSON.stringify(container)},kind,'-U','postgres',...args],{stdio:['pipe','pipe','pipe']});
process.stdin.pipe(child.stdin);child.stdin.on('error',()=>{});child.stderr.pipe(process.stderr);const chunks=[];
child.stdout.on('data',bytes=>file?chunks.push(bytes):process.stdout.write(bytes));
child.on('close',code=>{if(file&&code===0)fs.writeFileSync(file,Buffer.concat(chunks));process.exit(code||0)});
`
  for (const name of ['psql', 'pg_dump']) { await writeFile(join(directory, name), wrapper); await chmod(join(directory, name), 0o700) }
  // Never inherit production credentials or use their endpoints.
  const env = { SUPABASE_URL: 'https://source123.supabase.co', SUPABASE_DB_URL: 'postgresql://postgres:synthetic-password@db.source123.supabase.co/postgres', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-api-secret-only', SIG_BACKUP_PASSPHRASE: 'synthetic-isolated-integration-password-48-characters', SIG_DI_REVIEW_DIRECTORY: join(directory, 'review'), SIG_DI_POLICY_FILE: join(directory, 'review', 'policy.json'), SIG_BACKUP_DIRECTORY: join(directory, 'backups'), PSQL_BIN: join(directory, 'psql'), PG_DUMP_BIN: join(directory, 'pg_dump'), GITHUB_ACTIONS: '' }
  await reviewDI(env)
  const policy = JSON.parse(await readFile(env.SIG_DI_POLICY_FILE)); policy.reviewed = true; policy.storageReviewed = true
  await writeFile(env.SIG_DI_POLICY_FILE, JSON.stringify(policy))
  const result = await backupDI(env, async () => Response.json([])), { manifest, files } = await readArchive(result.file, env.SIG_BACKUP_PASSPHRASE)
  const all = [...files.values()].map(bytes => bytes.toString()).join('\n')
  for (const sentinel of ['SYNTHETIC_AUTH_MUST_NOT_EXPORT', 'SYNTHETIC_NESTED_MUST_NOT_EXPORT', 'SYNTHETIC_COLUMN_MUST_NOT_EXPORT']) assert(!all.includes(sentinel))
  assert(all.includes('9007199254740993.1234')); assert(all.includes('11111111-1111-1111-1111-111111111111')); assert.equal(manifest.counts.public.profiles, 1)
  const schema = files.get('db/public-schema.sql').toString()
  for (const expected of ['CREATE POLICY read_profiles', 'CREATE TRIGGER keep_profile', 'REFERENCES auth.users', 'CREATE FUNCTION public.keep_profile']) assert(schema.includes(expected))
  await decryptDI(result.file, join(directory, 'decrypted'), env)
  console.log('PASS: real PostgreSQL 17 snapshot/pg_dump/review/export/decrypt; FK/RLS/function/trigger, exact numeric/UUID values, secret exclusions')
} finally {
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' })
  await rm(directory, { recursive: true, force: true })
}
