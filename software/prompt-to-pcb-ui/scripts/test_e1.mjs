/** E1 regression: enterprise program workspace. Runs against synthetic
 *  artifacts and a store in an isolated temp module tree, never dev/demo state. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e1-test-'))
const previousStoreDir = process.env.ENTERPRISE_STORE_DIR
try {
  // APP_ROOT is derived from store.mjs's location, not ENTERPRISE_STORE_DIR.
  // Copy only the module under test, never the checkout's public/runs symlink.
  const storeModule = path.join(root, 'lib', 'enterprise', 'store.mjs')
  fs.mkdirSync(path.dirname(storeModule), { recursive: true })
  fs.copyFileSync(new URL('../lib/enterprise/store.mjs', import.meta.url), storeModule)
  process.env.ENTERPRISE_STORE_DIR = path.join(root, 'data', 'enterprise')
  const ent = await import(pathToFileURL(storeModule).href)

  function artifact(runDir, relativePath, data) {
    const file = path.join(root, 'public', 'runs', runDir, relativePath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data))
  }
  artifact('e1-routed-clean', 'data/last-run.json', {
    status: 'PASSED', board: { unroutedNets: [] },
  })
  artifact('e1-routed-clean', 'data/drc.json', {
    violations: [{ type: 'solder_mask_bridge' }],
  })
  artifact('e1-open-hard-drc', 'data/last-run.json', {
    status: 'FAILED', board: { unroutedNets: ['USB_D+'] },
  })
  artifact('e1-open-hard-drc', 'data/drc.json', {
    violations: [
      { type: 'clearance' }, { type: 'shorting_items' },
      { type: 'solder_mask_bridge' },
    ],
  })
  artifact('e1-open-hard-drc', 'data/constraints.json', {
    unsupported: [{ feature: 'USB differential-pair impedance' }],
  })
  artifact('e1-open-hard-drc', 'data/advanced-routing-report.json', {
    unsupported_constraints: [{ pair: 'USB_D+/USB_D-' }],
  })
  // The shipped chip-scale board must outrank a clean legacy variant.
  artifact('e1-chipscale', 'data/last-run.json', {
    status: 'PASSED', board: { unroutedNets: [] },
  })
  artifact('e1-chipscale', 'data/drc.json', { violations: [] })
  artifact('e1-chipscale', 'electronics/chipscale-board.json', {
    drc: { errors: 1 }, drcRepair: { unrouted: 1 },
  })

  const checks = []
  function check(name, ok, detail = '') {
    checks.push(ok)
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  -> ' + detail : ''}`)
  }

  const db = ent.resetDb()
  const actor = 'test-admin'

  // hierarchy: org -> workspace -> program -> boards -> runs
  const org = ent.createOrganization(db, { name: 'Test Org', actor })
  const ws = ent.createWorkspace(db, { org_id: org.org_id, name: 'HW Lab', actor })
  const prog = ent.createProgram(db, {
    workspace_id: ws.workspace_id, name: 'Bench Instrumentation',
    objective: 'test program', budget_credits: 100, actor })
  const b1 = ent.createBoard(db, { program_id: prog.program_id,
    name: 'Power Entry', board_class: 'power-entry', actor })
  const b2 = ent.createBoard(db, { program_id: prog.program_id,
    name: 'FL-1 Core-6', board_class: 'fl1-core', actor })
  check('1 hierarchy exists (org -> ws -> program -> 2 boards)',
    db.organizations.length === 1 && db.workspaces.length === 1
    && db.programs.length === 1 && prog.board_list.length === 2)

  // Attach synthetic artifacts through the real production reader.
  const r1 = ent.attachRun(db, { board_id: b1.board_id,
    run_dir: 'e1-routed-clean', actor })
  const r2 = ent.attachRun(db, { board_id: b2.board_id,
    run_dir: 'e1-open-hard-drc', actor })
  const r2b = ent.attachRun(db, { board_id: b2.board_id,
    run_dir: 'e1-chipscale', actor })
  const unsafeRun = ent.attachRun(db, { board_id: b2.board_id,
    run_dir: '..', actor })
  check('2 fixture run artifacts attach; board carries multiple runs',
    r1.route_evidence_state === 'routed_in_sandbox'
    && db.runs.filter((r) => r.board_id === b2.board_id).length === 2)
  check('2b open nets and shipped chip-scale evidence keep runs blocked',
    r1.readiness_state === 'routed_in_sandbox'
    && r2.route_evidence_state === 'routed_with_open_nets'
    && r2.readiness_state === 'blocked'
    && r2b.route_evidence_state === 'routed_with_open_nets'
    && r2b.readiness_state === 'blocked')
  check('3 DRC excludes mask bridges, counts hard errors, prefers chip-scale',
    r1.drc_state === 'drc_clean'
    && r2.drc_state === 'drc_violations:2'
    && r2b.drc_state === 'drc_violations:1')
  check('3b run attachment rejects parent-directory traversal',
    unsafeRun.error === 'invalid run_dir')
  // Use a separate empty DB so the missing run does not affect the summary.
  const missing = ent.attachRun(ent.loadDb(), { board_id: b1.board_id,
    run_dir: 'e1-missing-artifacts', actor })
  check('3c absent artifacts remain unknown, never inferred clean or routed',
    missing.route_evidence_state === 'unknown' && missing.drc_state === 'unknown'
    && missing.readiness_state === 'architecture_only')
  check('4 unsupported constraints remain explicit review items and blocked claims',
    b2.review_required_items.includes(
      'unsupported constraint: USB differential-pair impedance')
    && b2.blocked_claims.includes(
      'advanced routing: USB_D+/USB_D- unsupported by v1 router'))

  // evidence rules
  const evOk = ent.addEvidence(db, { scope_type: 'board_id',
    scope_id: b1.board_id, evidence_type: 'drc_report', source: 'pipeline',
    artifact_path: 'public/runs/e1-routed-clean/data/drc.json', actor })
  check('5 non-physical evidence records against a fixture artifact',
    evOk.evidence_id !== undefined)
  const evFake = ent.addEvidence(db, { scope_type: 'board_id',
    scope_id: b1.board_id, evidence_type: 'physical_measurement',
    source: 'bench', artifact_path: 'does/not/exist.csv', actor })
  check('6 physical evidence WITHOUT a real file is REFUSED',
    evFake.error !== undefined && evFake.error.includes('REAL artifact'))

  // readiness gates
  const g1 = ent.setBoardReadiness(db, { board_id: b1.board_id,
    next: 'approved_for_quote', actor })
  check('7 approved_for_quote refused without approval record',
    g1.error !== undefined && g1.reasons[0].includes('cannot be inferred'))
  const g2 = ent.setBoardReadiness(db, { board_id: b1.board_id,
    next: 'physically_validated', actor })
  check('8 physically_validated refused without accepted physical evidence',
    g2.error !== undefined)
  const g3 = ent.setBoardReadiness(db, { board_id: b1.board_id,
    next: 'production_ready', actor })
  check('9 production_ready structurally unreachable (4 missing prerequisites)',
    g3.error !== undefined && g3.reasons.length === 4)
  const g4 = ent.setBoardReadiness(db, { board_id: b1.board_id,
    next: 'package_ready_with_review', actor })
  check('10 non-gated states still promote (package_ready_with_review)',
    g4.readiness === 'package_ready_with_review')

  // enums + summary + audit
  check('11 13 program statuses / 8 readiness states defined',
    ent.PROGRAM_STATUSES.length === 13 && ent.READINESS_STATES.length === 8)
  const sum = ent.programSummary(db, prog.program_id)
  check('12 program summary aggregates boards/runs/evidence/blocked claims',
    sum.boards.length === 2 && sum.runs.length === 3
    && sum.evidence.length >= 1 && sum.blocked_claims.length >= 1)
  ent.saveDb(db)
  const chain = ent.verifyAuditChain(ent.loadDb())
  check('13 audit chain intact incl. REFUSED promotions',
    chain.ok && ent.loadDb().audit.some(
      (e) => e.action === 'readiness_promotion_REFUSED'))

  const n = checks.filter(Boolean).length
  console.log(`${n}/${checks.length} E1 checks pass`)
  process.exitCode = n === checks.length ? 0 : 1
} finally {
  if (previousStoreDir === undefined) delete process.env.ENTERPRISE_STORE_DIR
  else process.env.ENTERPRISE_STORE_DIR = previousStoreDir
  fs.rmSync(root, { recursive: true, force: true })
}
