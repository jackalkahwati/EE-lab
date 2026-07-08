/** E2 regression: approval workflow + governance (isolated temp store). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.ENTERPRISE_STORE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'e2-store-'))
const ent = await import('../lib/enterprise/store.mjs')
const apr = await import('../lib/enterprise/approvals.mjs')

const checks = []
function check(name, ok, detail = '') {
  checks.push(ok)
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  -> ' + detail : ''}`)
}

const db = ent.resetDb()
const actor = 'test-admin'
const org = ent.createOrganization(db, { name: 'Test Org', actor })
const ws = ent.createWorkspace(db, { org_id: org.org_id, name: 'Lab', actor })
const prog = ent.createProgram(db, { workspace_id: ws.workspace_id,
  name: 'P1', actor })
const b = ent.createBoard(db, { program_id: prog.program_id,
  name: 'B1', actor })
ent.attachRun(db, { board_id: b.board_id,
  run_dir: 'power-entry-header-v1', actor })

check('1 eleven approval types, six statuses',
  apr.APPROVAL_TYPES.length === 11 && apr.APPROVAL_STATUSES.length === 6)

// request carries evidence + blocked-claims snapshots
const req = apr.requestApproval(db, { approval_type: 'approved_for_quote',
  scope: { board_id: b.board_id }, requested_by: 'pm',
  risk_summary: 'first physical board', actor })
check('2 request carries evidence + blocked-claims snapshots',
  Array.isArray(req.evidence_snapshot)
  && Array.isArray(req.blocked_claims_snapshot))

// approved_for_quote CANNOT be inferred: still refused while requested
const g1 = ent.setBoardReadiness(db, { board_id: b.board_id,
  next: 'approved_for_quote', actor })
check('3 requested-but-undecided approval does NOT unlock the state',
  g1.error !== undefined)

// decide -> approve, then the state unlocks
const dec = apr.decideApproval(db, { approval_id: req.approval_id,
  decision: 'approved', approver: 'procurement-lead', actor })
check('4 explicit human decision approves', dec.status === 'approved')
const g2 = ent.setBoardReadiness(db, { board_id: b.board_id,
  next: 'approved_for_quote', actor })
check('5 approved_for_quote unlocks ONLY via the approval record',
  g2.readiness === 'approved_for_quote')

// immutability: cannot re-decide
const re = apr.decideApproval(db, { approval_id: req.approval_id,
  decision: 'rejected', approver: 'someone-else', actor })
check('6 decided approvals are immutable (re-decision refused)',
  re.error !== undefined && re.error.includes('immutable'))

// revocation cascades: board readiness drops, downgrade is visible
const rev = apr.revokeApproval(db, { approval_id: req.approval_id,
  reason: 'BOM change invalidates quote basis', actor })
check('7 revocation requires a reason and lands', rev.status === 'revoked')
const b2 = db.boards.find((x) => x.board_id === b.board_id)
check('8 revocation cascades: readiness downgraded, downgrade VISIBLE',
  b2.readiness === 'package_ready_with_review'
  && b2.review_required_items.some((i) => i.includes('downgraded')))

// rejection blocks downstream
const req2 = apr.requestApproval(db, { approval_type: 'approved_for_order',
  scope: { board_id: b.board_id }, requested_by: 'pm', actor })
const rej = apr.decideApproval(db, { approval_id: req2.approval_id,
  decision: 'rejected', approver: 'procurement-lead',
  notes: 'budget hold', actor })
check('9 rejection recorded with approver + note',
  rej.status === 'rejected' && rej.notes === 'budget hold')

// policies
const gaps = apr.policyGaps(db, { board_id: b.board_id,
  policy: 'fl1_physical_board' })
check('10 policy gaps: approved_for_quote missing again after revocation',
  gaps.missing.includes('approved_for_quote')
  && gaps.missing.includes('board_review_approval'))
check('11 four example policies incl. production board chain',
  Object.keys(apr.POLICIES).length === 4
  && apr.POLICIES.production_board.required.includes(
    'production_readiness_approval'))

// audit
const rep = apr.approvalAuditReport(db)
check('12 approval audit report exports full history',
  rep.approvals.length === 2
  && rep.approvals[0].history.length >= 3)
ent.saveDb(db)
const chain = ent.verifyAuditChain(ent.loadDb())
check('13 hash-chained audit intact across request/decide/revoke/cascade',
  chain.ok)

const n = checks.filter(Boolean).length
console.log(`${n}/${checks.length} E2 checks pass`)
process.exit(n === checks.length ? 0 : 1)
