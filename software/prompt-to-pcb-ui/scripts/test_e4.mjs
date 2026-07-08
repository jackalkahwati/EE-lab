/** E4 regression: usage/credit ledger (isolated temp store). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.ENTERPRISE_STORE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'e4-store-'))
const ent = await import('../lib/enterprise/store.mjs')
const cr = await import('../lib/enterprise/credits.mjs')

const checks = []
function check(name, ok, detail = '') {
  checks.push(ok)
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  -> ' + detail : ''}`)
}

const db = ent.resetDb()
const actor = 't'
const org = ent.createOrganization(db, { name: 'T', actor })
const ws = ent.createWorkspace(db, { org_id: org.org_id, name: 'W', actor })
const prog = ent.createProgram(db, { workspace_id: ws.workspace_id,
  name: 'P', budget_credits: 20, actor })
const b = ent.createBoard(db, { program_id: prog.program_id, name: 'B',
  actor })

check('1 fifteen usage categories; config-driven costs + tiers',
  cr.USAGE_CATEGORIES.length === 15
  && Object.keys(cr.DEFAULT_CREDIT_COSTS).length === 15
  && Object.keys(cr.TIERS).length === 4)

// record events across stages
for (const t of ['architecture_run', 'board_synthesis_run', 'routing_run',
                 'drc_erc_gate_run', 'evidence_pack_generation']) {
  cr.recordUsage(db, { org_id: org.org_id, program_id: prog.program_id,
    board_id: b.board_id, usage_type: t, user: 'eng-1', actor })
}
check('2 usage events recorded (5 stages)', db.usage.length === 5)
check('3 program budget accumulates consumption',
  db.programs[0].budget.credits_consumed === 11)

const bs = cr.budgetState(db, prog.program_id)
check('4 budget state: consumed 11/20, ok', bs.consumed === 11
  && bs.remaining === 9 && bs.state === 'ok')

// drive into warning + overage
cr.recordUsage(db, { org_id: org.org_id, program_id: prog.program_id,
  usage_type: 'fl1_validation_session', user: 'tech-1', actor })
const bs2 = cr.budgetState(db, prog.program_id)
check('5 overage flags review, never blocks engineering',
  bs2.state === 'overage_review_required'
  && bs2.note.includes('never priced'))

// unknown category refused
const bad = cr.recordUsage(db, { org_id: org.org_id,
  usage_type: 'mystery_fee', actor })
check('6 unknown usage category refused', bad.error !== undefined)

// manual adjustment requires reason + audit
const adjBad = cr.adjustCredits(db, { org_id: org.org_id, delta: 100,
  reason: '', actor })
check('7 manual adjustment without reason refused',
  adjBad.error !== undefined)
cr.adjustCredits(db, { org_id: org.org_id, program_id: prog.program_id,
  delta: 10, reason: 'pilot extension approved by sales', actor })
check('8 audited adjustment lands; audit entry carries the reason',
  db.programs[0].budget.credits_allocated === 30
  && db.audit.some((e) => e.action === 'adjust_credits'
    && e.note.includes('pilot extension')))

// report
const rep = cr.usageReport(db, { org_id: org.org_id })
check('9 usage report: by program/board/user/stage + no-billing statement',
  rep.total_credits === 21
  && rep.by_user['eng-1'] === 11 && rep.by_user['tech-1'] === 10
  && rep.by_stage.routing_run === 3
  && rep.no_billing.includes('no money moved'))

// pricing alignment
const pa = cr.pricingAlignmentReport([
  { file: 'app/api/billing (existing)', note: 'existing billing surface '
    + 'untouched this sprint; reconcile before publishing tiers' }])
check('10 pricing alignment report flags reconciliation, homepage out of '
      + 'scope', pa.homepage_out_of_scope === true && pa.findings.length === 1)

// auditability: chain intact
ent.saveDb(db)
check('11 ledger auditable: hash chain intact',
  ent.verifyAuditChain(ent.loadDb()).ok)
// no billing integration: module must not import network/payment libs
const src = fs.readFileSync(
  new URL('../lib/enterprise/credits.mjs', import.meta.url), 'utf8')
check('12 no billing integration (no stripe/fetch/http in module)',
  !/stripe|fetch\(|axios|XMLHttpRequest|api\.stripe/i.test(src))

const n = checks.filter(Boolean).length
console.log(`${n}/${checks.length} E4 checks pass`)
process.exit(n === checks.length ? 0 : 1)
