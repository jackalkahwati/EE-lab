/** E8 regression: FL-1 bundle + validation sessions (isolated temp store). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.ENTERPRISE_STORE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'e8-store-'))
const ent = await import('../lib/enterprise/store.mjs')
const fl1 = await import('../lib/enterprise/fl1.mjs')

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
  name: 'P', actor })
const b = ent.createBoard(db, { program_id: prog.program_id, name: 'B',
  actor })
ent.attachRun(db, { board_id: b.board_id,
  run_dir: 'fl1-core6-bare-rp2040-combination-v1', actor })

const asset = fl1.registerFl1Asset(db, { org_id: org.org_id,
  serial_placeholder: 'FL1-DEMO-001', actor })
check('1 FL-1 asset registered; calibration honestly placeholder',
  asset.asset_id.startsWith('fl1')
  && asset.calibration_state.includes('require calibration evidence'))

const s = fl1.planValidationSession(db, { asset_id: asset.asset_id,
  board_id: b.board_id, operator: 'tess', actor })
check('2 session planned with REAL validation plan from run artifacts',
  s.status === 'planned'
  && s.validation_plan.includes('fl1-testplan.json'))
check('3 operator required',
  fl1.planValidationSession(db, { asset_id: asset.asset_id,
    board_id: b.board_id, operator: null, actor }).error !== undefined)

// state machine
fl1.advanceSession(db, { session_id: s.session_id, to: 'ready', actor })
fl1.advanceSession(db, { session_id: s.session_id, to: 'running', actor })
const skip = fl1.advanceSession(db, { session_id: s.session_id,
  to: 'accepted', actor })
check('4 running -> accepted is an illegal jump', skip.error !== undefined)
fl1.advanceSession(db, { session_id: s.session_id,
  to: 'completed_pending_review', actor })
check('5 completion lands as completed_pending_review (never pass)',
  db.validation_sessions[0].status === 'completed_pending_review')

// acceptance requires REVIEWED evidence
const acc1 = fl1.advanceSession(db, { session_id: s.session_id,
  to: 'accepted', actor })
check('6 acceptance refused without reviewed evidence',
  acc1.error !== undefined && acc1.error.includes('never implies pass'))

// fake evidence refused (no real file)
const fake = fl1.attachSessionEvidence(db, { session_id: s.session_id,
  evidence_type: 'physical_measurement', artifact_path: 'nope.csv',
  source: 'bench', actor })
check('7 measurement without a real artifact file refused',
  fake.error !== undefined)

// real evidence file (use a real repo file as stand-in artifact)
const real = fl1.attachSessionEvidence(db, { session_id: s.session_id,
  evidence_type: 'operator_notes',
  artifact_path: 'public/runs/fl1-core6-bare-rp2040-combination-v1/data/fl1-testplan.json',
  source: 'operator', notes: 'continuity sweep complete',
  measurements: [{ name: '3V3_rail', value: 3.31, units: 'V' }], actor })
check('8 evidence attaches with labeled measurements',
  real.session.measurements[0].units === 'V')
const badM = fl1.attachSessionEvidence(db, { session_id: s.session_id,
  evidence_type: 'operator_notes',
  artifact_path: 'public/runs/fl1-core6-bare-rp2040-combination-v1/data/fl1-testplan.json',
  source: 'operator', measurements: [{ name: 'x', value: 5 }], actor })
check('9 unlabeled measurement (no units) refused',
  badM.error !== undefined)

// still refused: evidence is pending review
const acc2 = fl1.advanceSession(db, { session_id: s.session_id,
  to: 'accepted', actor })
check('10 acceptance still refused while evidence is UNREVIEWED',
  acc2.error !== undefined)

// review, then accept
const evId = db.validation_sessions[0].evidence_ids[0]
ent.reviewEvidence(db, { evidence_id: evId, decision: 'accepted',
  reviewer: 'rev', notes: 'checked against plan', actor })
const acc3 = fl1.advanceSession(db, { session_id: s.session_id,
  to: 'accepted', actor })
check('11 acceptance unlocks only after named-reviewer acceptance',
  acc3.status === 'accepted'
  && acc3.review_state === 'reviewed_accepted')

const impact = fl1.claimImpactReport(db, { session_id: s.session_id })
check('12 claim impact: calibration + production stay blocked',
  impact.claims_blocked.some((c) => c.includes('calibration'))
  && impact.claims_blocked.some((c) => c.includes('production_ready')))

const bundle = fl1.bundleStatusReport(db)
check('13 bundle report: asset presence explicitly validates nothing',
  bundle.honesty.includes('validates nothing'))
ent.saveDb(db)
check('14 audit chain intact incl. refused acceptance',
  ent.verifyAuditChain(ent.loadDb()).ok
  && db.audit.some((e) => e.action === 'session_accept_REFUSED'))

const n = checks.filter(Boolean).length
console.log(`${n}/${checks.length} E8 checks pass`)
process.exit(n === checks.length ? 0 : 1)
