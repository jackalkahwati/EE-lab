/**
 * E11 — enterprise demo seed. CLEARLY SYNTHETIC data for demos:
 * Acme Robotics Labs (SYNTHETIC DEMO) with five programs wired to REAL
 * existing run artifacts. No fake physical evidence, no fake orders, no
 * fake measurements — blocked claims stay visible everywhere.
 *
 *   node scripts/seed_enterprise_demo.mjs         # seed (idempotent reset)
 *   node scripts/seed_enterprise_demo.mjs --reset # wipe only
 */
const ent = await import('../lib/enterprise/store.mjs')
const apr = await import('../lib/enterprise/approvals.mjs')
const cr = await import('../lib/enterprise/credits.mjs')
const qt = await import('../lib/enterprise/quotes.mjs')
const fl1 = await import('../lib/enterprise/fl1.mjs')
const pil = await import('../lib/enterprise/pilots.mjs')

const actor = 'demo-seed'
const db = ent.resetDb()
if (process.argv.includes('--reset')) {
  console.log('enterprise store reset (empty)')
  process.exit(0)
}

const org = ent.createOrganization(db, {
  name: 'Acme Robotics Labs (SYNTHETIC DEMO)', plan: 'enterprise_fl1_bundle',
  actor })
org.security_settings.demo = true
const ws = ent.createWorkspace(db, { org_id: org.org_id,
  name: 'Hardware Programs (demo)', description: 'synthetic demo workspace',
  actor })

function program(name, objective, credits) {
  return ent.createProgram(db, { workspace_id: ws.workspace_id, name,
    owner: 'demo PM', objective, budget_credits: credits, actor })
}
function board(prog, name, run_dir, cls) {
  const b = ent.createBoard(db, { program_id: prog.program_id, name,
    board_class: cls, actor })
  if (run_dir) ent.attachRun(db, { board_id: b.board_id, run_dir, actor })
  for (const t of ['board_synthesis_run', 'routing_run', 'drc_erc_gate_run']) {
    if (run_dir) cr.recordUsage(db, { org_id: org.org_id,
      program_id: prog.program_id, board_id: b.board_id, usage_type: t,
      user: 'demo-eng', actor })
  }
  return b
}

// 1. Sensor Controller Pilot — routed board + quote path to approved_for_quote
const p1 = program('Sensor Controller Pilot',
  'evidence-gated bench controller boards (synthetic pilot)', 60)
p1.status = 'quote_ready'
const b1 = board(p1, 'Power Entry Header', 'power-entry-header-v1',
  'power-entry')
qt.generateQuotePacket(db, { board_id: b1.board_id, actor })
qt.advanceQuote(db, { board_id: b1.board_id,
  to: 'quote_approval_requested', actor })
const rq1 = apr.requestApproval(db, { approval_type: 'approved_for_quote',
  scope: { board_id: b1.board_id }, requested_by: 'demo PM',
  risk_summary: 'first synthetic pilot board', actor })
apr.decideApproval(db, { approval_id: rq1.approval_id, decision: 'approved',
  approver: 'demo procurement lead', actor })
qt.advanceQuote(db, { board_id: b1.board_id, to: 'approved_for_quote',
  actor })
ent.setBoardReadiness(db, { board_id: b1.board_id,
  next: 'package_ready_with_review', actor })
cr.recordUsage(db, { org_id: org.org_id, program_id: p1.program_id,
  board_id: b1.board_id, usage_type: 'quote_packet_generation',
  user: 'demo-eng', actor })

// 2. FL-1 DUT Power Board Review — routed FL-1 board + review approval req
const p2 = program('FL-1 DUT Power Board Review',
  'review package for the FL-1 Core-6 combination board', 80)
p2.status = 'review_required'
const b2 = board(p2, 'FL-1 Core-6 Bare-RP2040',
  'fl1-core6-bare-rp2040-combination-v1', 'fl1-core')
apr.requestApproval(db, { approval_type: 'board_review_approval',
  scope: { board_id: b2.board_id }, requested_by: 'demo PM',
  risk_summary: 'USB pair unsupported by v1 router — visible blocked claim',
  actor })

// 3. BGA Architecture Study — architecture_only, honest blockers
const p3 = program('BGA Architecture Study',
  'iCE40 BGA-121 feasibility (fixture-proven escape gap)', 20)
p3.status = 'architecture'
p3.blocked_claims.push('BGA board emission (no ball-grid escape emitter)',
                       'HDI/microvia/via-in-pad support')
const b3 = board(p3, 'iCE40HX4K-BG121 study', null, 'bga-study')
b3.blocked_claims.push('BGA routing support', 'FPGA board support')
b3.review_required_items.push('ring-1 balls trapped at proven fab class '
  + '(M7R fixture evidence)')

// 4. RF Architecture Study — blocked RF claims
const p4 = program('RF Architecture Study',
  'SMA adapter request — RF gates return architecture_only', 20)
p4.status = 'blocked'
p4.blocked_claims.push('RF performance', 'antenna performance', 'EMC')
const b4 = board(p4, 'SMA RF adapter concept', null, 'rf-study')
b4.blocked_claims.push('impedance_correctness (no stackup/solver/'
  + 'S-parameters/measurement)')

// 5. Validation Campaign Example — FL-1 asset + planned session (no results)
const p5 = program('Validation Campaign Example',
  'FL-1 validation session planning for the pilot boards', 40)
p5.status = 'validation_in_progress'
const b5 = board(p5, 'Power Entry (validation candidate)',
  'power-entry-header-2l', 'power-entry')
const asset = fl1.registerFl1Asset(db, { org_id: org.org_id,
  serial_placeholder: 'FL1-DEMO-001', actor })
fl1.planValidationSession(db, { asset_id: asset.asset_id,
  board_id: b5.board_id, operator: 'demo technician', actor })

// pilot + ROI for program 1
pil.createPilot(db, { org_id: org.org_id, workspace_id: ws.workspace_id,
  program_ids: [p1.program_id], customer_segment: 'robotics OEM (synthetic)',
  use_case: 'bench sensor controllers',
  baseline_process: 'manual EDA + contractor layout, 3 revisions typical',
  actor })

ent.saveDb(db)
const chain = ent.verifyAuditChain(db)
console.log('demo seed complete:',
  db.programs.length, 'programs |', db.boards.length, 'boards |',
  db.runs.length, 'runs |', db.approvals.length, 'approvals |',
  db.usage.length, 'usage entries |', db.quotes.length, 'quote flows |',
  db.validation_sessions.length, 'sessions | audit chain ok:', chain.ok)
