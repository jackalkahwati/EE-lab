/** E11 artifact generator — demo seed data report. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCS = path.join(HERE, '..', 'docs', 'enterprise')
fs.mkdirSync(DOCS, { recursive: true })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e11-gen-'))
execSync(`node "${path.join(HERE, 'seed_enterprise_demo.mjs')}"`, {
  env: { ...process.env, ENTERPRISE_STORE_DIR: tmp } })
const db = JSON.parse(fs.readFileSync(path.join(tmp, 'store.json'), 'utf8'))

const report = {
  version: 'v1', milestone: 'E11 Demo Seed Data',
  org: db.organizations[0].name,
  demo_flag: db.organizations[0].security_settings.demo,
  programs: db.programs.map((p) => ({ name: p.name, status: p.status,
    boards: p.board_list.length, blocked_claims: p.blocked_claims })),
  coverage: {
    runs_attached: db.runs.length,
    approvals: db.approvals.length,
    usage_entries: db.usage.length,
    quote_flows: db.quotes.length,
    validation_sessions: db.validation_sessions.length,
    pilots: db.pilots.length,
  },
  honesty: {
    fake_physical_evidence: db.evidence.filter(
      (e) => e.status === 'accepted').length,
    fake_orders: db.quotes.reduce(
      (s, q) => s + q.manual_entries.length, 0),
    boards_beyond_review: db.boards.filter(
      (b) => ['physically_validated', 'production_ready'].includes(
        b.readiness)).length,
  },
  scripts: {
    seed: 'node scripts/seed_enterprise_demo.mjs',
    reset: 'node scripts/seed_enterprise_demo.mjs --reset',
    toggle: 'org.security_settings.demo drives the SYNTHETIC DEMO DATA '
      + 'chip in /enterprise',
  },
}

fs.writeFileSync(path.join(DOCS, 'enterprise-demo-seed-data-v1.json'),
                 JSON.stringify(report, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-demo-seed-data-v1.md'),
`# E11 — Enterprise Demo Seed Data v1

Synthetic org **${report.org}** (demo-flagged; the /enterprise UI shows a
SYNTHETIC DEMO DATA chip). Five programs wired to REAL run artifacts:

${report.programs.map((p) => `- **${p.name}** (${p.status}, ${p.boards} `
  + `board(s))${p.blocked_claims.length
    ? ' — blocked: ' + p.blocked_claims.join('; ') : ''}`).join('\n')}

Honesty: ${report.honesty.fake_physical_evidence} fake physical evidence
items, ${report.honesty.fake_orders} fake orders,
${report.honesty.boards_beyond_review} boards beyond review states.
The demo's approved_for_quote is backed by a real (synthetic-actor)
approval record; the validation session is planned with zero measurements.

Seed: \`${report.scripts.seed}\` · Reset: \`${report.scripts.reset}\`
`)
fs.writeFileSync(path.join(DOCS, 'demo-data-report.md'),
`# Demo data report

Load state: ${report.coverage.runs_attached} runs, `
  + `${report.coverage.approvals} approvals, `
  + `${report.coverage.usage_entries} usage entries, `
  + `${report.coverage.quote_flows} quote flow, `
  + `${report.coverage.validation_sessions} validation session, `
  + `${report.coverage.pilots} pilot.

All data clearly synthetic; no real customer names; no secrets; no fake
physical evidence; no fake orders; blocked claims visible on the BGA and
RF study programs.
`)
console.log('E11 artifacts written')
