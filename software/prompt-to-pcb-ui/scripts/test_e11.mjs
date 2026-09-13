/** E11 regression: real demo seed against synthetic artifacts in a temp tree. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { withEnterpriseFixture } from './enterprise_test_fixture.mjs'

await withEnterpriseFixture('e11',
  ['approvals', 'credits', 'quotes', 'fl1', 'pilots', 'rbac'], async (fixture) => {
  const { root } = fixture
  for (const runDir of ['power-entry-header-v1',
    'fl1-core6-bare-rp2040-combination-v1', 'power-entry-header-2l']) {
    fixture.routedRun(runDir)
  }
  fixture.artifact('fl1-core6-bare-rp2040-combination-v1',
    'advanced-routing-report.json', {
      unsupported_constraints: [{ pair: 'USB_D+/USB_D-' }],
    })
  const planPath = fixture.artifact('power-entry-header-2l', 'fl1-testplan.json', {
    title: 'Synthetic E11 validation plan', steps: [],
  })
  const seed = (...args) => execFileSync(process.execPath,
    [path.join(root, 'scripts', 'seed_enterprise_demo.mjs'), ...args], {
      cwd: root, env: { ...process.env },
    })
  seed()
  const ent = await fixture.importModule('store')
  const db = ent.loadDb()

  const checks = []
  function check(name, ok, detail = '') {
    checks.push(ok)
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  -> ' + detail : ''}`)
  }

  check('1 seed loads reliably: 5 programs, 5 boards, 3 fixture runs',
    db.programs.length === 5 && db.boards.length === 5 && db.runs.length === 3)
  check('1b seed reads routed/DRC fixture artifacts and inherits USB blocker',
    db.runs.every((r) => r.route_evidence_state === 'routed_in_sandbox'
      && r.drc_state === 'drc_clean')
    && db.boards.some((b) => b.blocked_claims.includes(
      'advanced routing: USB_D+/USB_D- unsupported by v1 router')))
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
  check('8 validation session planned from fixture, zero measurements (no fake data)',
    db.validation_sessions[0].status === 'planned'
    && db.validation_sessions[0].validation_plan ===
      'public/runs/power-entry-header-2l/data/fl1-testplan.json'
    && db.validation_sessions[0].measurements.length === 0
    && db.validation_sessions[0].evidence_ids.length === 0)
  check('9 approved_for_quote in demo is backed by a real approval record',
    db.approvals.some((a) => a.approval_type === 'approved_for_quote'
      && a.status === 'approved' && a.approver))
  check('10 audit chain intact after seeding',
    ent.verifyAuditChain(db).ok)

  // A genuinely missing plan must still block validation, not fabricate one.
  fs.unlinkSync(planPath)
  seed()
  const withoutPlan = ent.loadDb()
  check('10b missing validation plan leaves seeded session blocked and empty',
    withoutPlan.validation_sessions.length === 1
    && withoutPlan.validation_sessions[0].status === 'blocked'
    && withoutPlan.validation_sessions[0].validation_plan === null
    && withoutPlan.validation_sessions[0].measurements.length === 0
    && withoutPlan.validation_sessions[0].evidence_ids.length === 0
    && ent.verifyAuditChain(withoutPlan).ok)

  // reset works
  seed('--reset')
  check('11 reset script empties the store', ent.loadDb().programs.length === 0)

  const n = checks.filter(Boolean).length
  console.log(`${n}/${checks.length} E11 checks pass`)
  process.exitCode = n === checks.length ? 0 : 1
}, ['seed_enterprise_demo.mjs'])
