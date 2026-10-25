#!/usr/bin/env node
import { restoreWorkspace, redact } from './backup-workspace.mjs'
const args = process.argv.slice(2)
const path = args.find(item => !item.startsWith('--') && args[args.indexOf(item) - 1] !== '--confirm-target')
const targetIndex = args.indexOf('--confirm-target')
if (!path || targetIndex < 0 || !args[targetIndex + 1]) {
  console.error('사용법: node scripts/restore-workspace.mjs BACKUP.sigbackup --confirm-target NEW_PROJECT_REF [--apply]')
  process.exitCode = 1
} else restoreWorkspace(path, process.env, { apply: args.includes('--apply'), confirmTarget: args[targetIndex + 1] }).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
  console.error(redact(error.message, [process.env.TARGET_SUPABASE_SERVICE_ROLE_KEY, process.env.SIG_BACKUP_PASSPHRASE])); process.exitCode = 1
})
