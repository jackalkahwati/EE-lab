/** E11 regression: demo seed data (runs the real seed into a temp store). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e11-store-'))
execSync(`node "${path.join(HERE, 'seed_enterprise_demo.mjs')}"`, {
  env: { ...process.env, ENTERPRISE_STORE_DIR: tmp } })
const db = JSON.parse(fs.readFileSync(path.join(tmp, 'store.json'), 'utf8'))
process.env.ENTERPRISE_STORE_DIR = tmp
const ent = await import('../lib/enterprise/store.mjs')

const checks = []
function check(name, ok, detail = '') {
  checks.push(ok)
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  -> ' + detail : ''}`)
}

check('1 seed loads reliably: 5 programs, 5 boards, 3 real runs',
  db.programs.length === 5 && db.boards.length === 5 && db.runs.length === 3)
check('2 org clearly synthetic + demo-flagged',
  db.organizations[0].name.includes('SYNTHETIC DEMO')
  && db.organizations[0].security_settings.demo === true)
check('3 demo covers approvals/usage/quotes/sessions/pilots',
  db.approvals.length >= 2 && db.usage.length >= 10
  && db.quotes.length === 1 && db.validation_sessions.length === 1
  && db.pilots.length === 1)
check('4 blocked claims visible on BGA + RF studies',
  db.boards.some((b) => b.blocked_claims.includes('BGA routing support'))
  && db.programs.some((p) => p.blocked_claims.includes('RF performance')))
check('5 NO fake physical evidence (zero accepted physical items)',
  db.evidence.every((e) => e.status !== 'accepted'))
check('6 NO fake orders (quote state stops at approved_for_quote)',
  db.quotes[0].state === 'approved_for_quote'
  && db.quotes[0].manual_entries.length === 0)
check('7 no board beyond package_ready_with_review readiness',
  db.boards.every((b) => !['physically_validated', 'production_ready',
                           'physical_evidence_pending'].includes(b.readiness)))
check('8 validation session planned, zero measurements (no fake data)',
  db.validation_sessions[0].status === 'planned'
  && db.validation_sessions[0].measurements.length === 0)
check('9 approved_for_quote in demo is backed by a real approval record',
  db.approvals.some((a) => a.approval_type === 'approved_for_quote'
    && a.status === 'approved' && a.approver))
check('10 audit chain intact after seeding',
  ent.verifyAuditChain(db).ok)

// reset works
execSync(`node "${path.join(HERE, 'seed_enterprise_demo.mjs')}" --reset`, {
  env: { ...process.env, ENTERPRISE_STORE_DIR: tmp } })
const empty = JSON.parse(fs.readFileSync(path.join(tmp, 'store.json'),
                                         'utf8'))
check('11 reset script empties the store', empty.programs.length === 0)

const n = checks.filter(Boolean).length
console.log(`${n}/${checks.length} E11 checks pass`)
process.exit(n === checks.length ? 0 : 1)
