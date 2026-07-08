/** E7 regression: fab/quote workflow (isolated temp store). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.ENTERPRISE_STORE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'e7-store-'))
const ent = await import('../lib/enterprise/store.mjs')
const apr = await import('../lib/enterprise/approvals.mjs')
const qt = await import('../lib/enterprise/quotes.mjs')

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

check('1 twelve quote states defined', qt.QUOTE_STATES.length === 12)

// packet requires a real attached run
const noRun = qt.generateQuotePacket(db, { board_id: b.board_id, actor })
check('2 packet refused without an attached run (package_not_ready)',
  noRun.error !== undefined)
ent.attachRun(db, { board_id: b.board_id, run_dir: 'power-entry-header-v1',
  actor })
const q = qt.generateQuotePacket(db, { board_id: b.board_id,
  special_requirements: ['lead-free HASL'], actor })
check('3 packet generated from REAL run artifacts (BOM + P&P + DRC/ERC)',
  q.packet.contents.bom !== null
  && q.packet.contents.pick_and_place !== null
  && q.packet.contents.drc_erc.drc === 'drc_clean')
check('4 packet carries review labels + blocked claims + approval snapshot '
      + '+ no-impedance stackup honesty',
  Array.isArray(q.packet.contents.blocked_claims)
  && q.packet.contents.stackup_assumptions.includes('NO controlled')
  && Array.isArray(q.packet.contents.human_approval_snapshot))

// approval gates at transition time
qt.advanceQuote(db, { board_id: b.board_id, to: 'quote_approval_requested',
  actor })
const g1 = qt.advanceQuote(db, { board_id: b.board_id,
  to: 'approved_for_quote', actor })
check('5 approved_for_quote transition REFUSED without approval record',
  g1.error !== undefined && g1.error.includes('cannot be inferred'))
const rq = apr.requestApproval(db, { approval_type: 'approved_for_quote',
  scope: { board_id: b.board_id }, requested_by: 'pm', actor })
apr.decideApproval(db, { approval_id: rq.approval_id, decision: 'approved',
  approver: 'procurement', actor })
const g2 = qt.advanceQuote(db, { board_id: b.board_id,
  to: 'approved_for_quote', actor })
check('6 transition unlocks only via approved record',
  g2.state === 'approved_for_quote')

// manual entries required for outward actions
const m1 = qt.advanceQuote(db, { board_id: b.board_id,
  to: 'quote_submitted_manually', actor })
check('7 quote submission requires MANUAL human entry (refused w/o note)',
  m1.error !== undefined && m1.error.includes('MANUAL'))
qt.advanceQuote(db, { board_id: b.board_id, to: 'quote_submitted_manually',
  note: 'sent to fab X by J. Human via email', actor })
qt.advanceQuote(db, { board_id: b.board_id, to: 'quote_received',
  note: 'quote #123 received, $840', actor })
check('8 manual entries recorded with notes',
  db.quotes[0].manual_entries.length === 2)

// order gate
const o1 = qt.advanceQuote(db, { board_id: b.board_id,
  to: 'approved_for_order', actor })
check('9 approved_for_order refused without its own approval record',
  o1.error !== undefined)
const rq2 = apr.requestApproval(db, { approval_type: 'approved_for_order',
  scope: { board_id: b.board_id }, requested_by: 'pm', actor })
apr.decideApproval(db, { approval_id: rq2.approval_id, decision: 'approved',
  approver: 'procurement', actor })
qt.advanceQuote(db, { board_id: b.board_id, to: 'approved_for_order', actor })
qt.advanceQuote(db, { board_id: b.board_id, to: 'order_submitted_manually',
  note: 'PO-778 placed by procurement via vendor portal', actor })
check('10 order path human-gated end to end',
  db.quotes[0].state === 'order_submitted_manually')

// illegal jumps blocked
const skip = qt.advanceQuote(db, { board_id: b.board_id,
  to: 'boards_received_pending_evidence', actor })
check('11 illegal transition refused (must pass fab_in_progress)',
  skip.error !== undefined)

// received boards are NOT physical validation
qt.advanceQuote(db, { board_id: b.board_id, to: 'fab_in_progress',
  note: 'vendor confirmed', actor })
qt.advanceQuote(db, { board_id: b.board_id,
  to: 'boards_received_pending_evidence', note: '5 boards received', actor })
const gv = ent.setBoardReadiness(db, { board_id: b.board_id,
  next: 'physically_validated', actor })
check('12 boards received != physically validated (still refused without '
      + 'accepted evidence)', gv.error !== undefined)

const rep = qt.quoteWorkflowReport(db)
check('13 workflow report: rules incl. no-auto-submission + '
      + 'quote != evidence',
  rep.rules.some((r) => r.includes('no automatic quote'))
  && rep.rules.some((r) => r.includes('not physical evidence')))
ent.saveDb(db)
check('14 audit chain intact incl. refused transitions',
  ent.verifyAuditChain(ent.loadDb()).ok
  && db.audit.some((e) => e.action === 'quote_transition_REFUSED'))

const n = checks.filter(Boolean).length
console.log(`${n}/${checks.length} E7 checks pass`)
process.exit(n === checks.length ? 0 : 1)
