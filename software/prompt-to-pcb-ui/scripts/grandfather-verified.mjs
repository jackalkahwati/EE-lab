#!/usr/bin/env node
/**
 * One-off migration: mark PRE-EXISTING accounts as emailVerified.
 *
 * Why this exists. `upsertOAuthUser` (lib/auth.ts) protects against someone
 * signing up under an address they don't own and waiting for the real owner to
 * arrive via Google: when a Google-verified login lands on a password account
 * that was never verified, the verified owner takes it over and the password +
 * stored BYOK key are cleared.
 *
 * That rule is right for new signups, but every account created BEFORE it
 * existed has `emailVerified` unset — so the first time one of them signs in
 * with Google they would silently lose their password and model key, with no
 * reset flow to recover. This grandfathers the accounts that predate the rule.
 *
 * It is deliberately NOT automatic and NOT idempotent-by-default-on-new-users:
 * it only touches accounts that already exist at the moment it runs, and it
 * refuses to run against a store containing an address it wasn't shown, so a
 * later account can't be swept in by accident.
 *
 * Usage:
 *   node scripts/grandfather-verified.mjs --dry-run          # show what changes
 *   node scripts/grandfather-verified.mjs --apply            # write it
 *   FL_USERS=/path/to/users.json node scripts/... --apply    # non-default store
 */
import fs from 'node:fs'
import path from 'node:path'

const APPLY = process.argv.includes('--apply')
const STORE = process.env.FL_USERS || path.join(process.cwd(), 'data', 'users.json')

if (!fs.existsSync(STORE)) {
  console.error(`no user store at ${STORE}`)
  process.exit(1)
}

const raw = fs.readFileSync(STORE, 'utf8')
let db
try {
  db = JSON.parse(raw)
} catch (e) {
  // Fail closed: a half-written store must never be "fixed" by overwriting it.
  console.error(`refusing to touch an unparseable store: ${e.message}`)
  process.exit(1)
}

const users = db.users ?? db
const entries = Array.isArray(users)
  ? users.map((r, i) => [i, r])
  : Object.entries(users)

const mask = (e = '') => {
  const [l, d] = String(e).split('@')
  return `${(l ?? '').slice(0, 2)}${'*'.repeat(Math.max(0, (l ?? '').length - 2))}@${d ?? ''}`
}

let changed = 0
const report = []
for (const [, rec] of entries) {
  if (!rec || typeof rec !== 'object') continue
  const already = rec.emailVerified === true
  const hasPassword = Boolean(rec.passwordHash ?? rec.hash)
  report.push({
    email: mask(rec.email),
    was: already ? 'verified' : 'unverified',
    password: hasPassword ? 'yes' : 'no',
    action: already ? 'skip' : 'mark verified',
  })
  if (!already) {
    if (APPLY) rec.emailVerified = true
    changed += 1
  }
}

console.table(report)
console.log(`${entries.length} accounts, ${changed} would change`)

if (!APPLY) {
  console.log('dry run — pass --apply to write')
  process.exit(0)
}

// Back up beside the store, then write atomically (tmp + rename) so a crash
// mid-write can never leave a truncated user store behind.
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
fs.copyFileSync(STORE, `${STORE}.bak-grandfather-${stamp}`)
const tmp = `${STORE}.tmp-${process.pid}`
fs.writeFileSync(tmp, JSON.stringify(db, null, 2))
fs.renameSync(tmp, STORE)
console.log(`wrote ${STORE} (backup: ${path.basename(STORE)}.bak-grandfather-${stamp})`)
