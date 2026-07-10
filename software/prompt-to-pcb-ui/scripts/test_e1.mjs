/** E1 regression: enterprise program workspace. Runs against an isolated
 *  temp store; never touches dev/demo state. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.ENTERPRISE_STORE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'e1-store-'))
const ent = await import('../lib/enterprise/store.mjs')

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

// attach REAL existing run artifacts
const r1 = ent.attachRun(db, { board_id: b1.board_id,
  run_dir: 'power-entry-header-v1', actor })
const r2 = ent.attachRun(db, { board_id: b2.board_id,
  run_dir: 'fl1-core6-bare-rp2040-combination-v1', actor })
const r2b = ent.attachRun(db, { board_id: b2.board_id,
  run_dir: 'fl1-core6-mono-bare', actor })
const unsafeRun = ent.attachRun(db, { board_id: b2.board_id,
  run_dir: '..', actor })
check('2 real run artifacts attach; board carries multiple runs',
  r1.route_evidence_state === 'routed_in_sandbox'
  && db.runs.filter((r) => r.board_id === b2.board_id).length === 2)
const expectedDrcState = (runDir) => {
  const drc = JSON.parse(fs.readFileSync(path.join(
    ent.APP_ROOT, 'public', 'runs', runDir, 'data', 'drc.json'), 'utf8'))
  const hard = (drc.violations ?? [])
    .filter((v) => v.type !== 'solder_mask_bridge').length
  return hard === 0 ? 'drc_clean' : `drc_violations:${hard}`
}
check('3 run states match the current real DRC artifacts',
  r1.drc_state === expectedDrcState('power-entry-header-v1')
  && r2.drc_state === expectedDrcState('fl1-core6-bare-rp2040-combination-v1')
  && r2b.drc_state === expectedDrcState('fl1-core6-mono-bare'))
check('3b run attachment rejects parent-directory traversal',
  unsafeRun.error === 'invalid run_dir')
check('4 honest warnings inherited as blocked claims (FL-1 usb pair)',
  db.boards.find((b) => b.board_id === b2.board_id)
    .blocked_claims.some((c) => c.includes('unsupported')))

// evidence rules
const evOk = ent.addEvidence(db, { scope_type: 'board_id',
  scope_id: b1.board_id, evidence_type: 'drc_report', source: 'pipeline',
  artifact_path: 'public/runs/power-entry-header-v1/data/drc.json', actor })
check('5 non-physical evidence records against a real artifact',
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
process.exit(n === checks.length ? 0 : 1)
