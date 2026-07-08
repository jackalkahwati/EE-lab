/** E5 regression: roles, permissions, audit (isolated temp store). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.ENTERPRISE_STORE_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'e5-store-'))
const ent = await import('../lib/enterprise/store.mjs')
const apr = await import('../lib/enterprise/approvals.mjs')
const rbac = await import('../lib/enterprise/rbac.mjs')

const checks = []
function check(name, ok, detail = '') {
  checks.push(ok)
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  -> ' + detail : ''}`)
}

const db = ent.resetDb()
const admin = 'dev-admin'
const org = ent.createOrganization(db, { name: 'T', actor: admin })
const ws = ent.createWorkspace(db, { org_id: org.org_id, name: 'W',
  actor: admin })
const prog = ent.createProgram(db, { workspace_id: ws.workspace_id,
  name: 'P', actor: admin })
const b = ent.createBoard(db, { program_id: prog.program_id, name: 'B',
  actor: admin })

check('1 ten roles, twenty-two permissions',
  rbac.ROLES.length === 10 && rbac.PERMISSIONS.length === 22)
check('2 dev-admin default keeps local flow working',
  rbac.checkAction(db, 'dev-admin', 'create_program', {}).ok === true)
check('3 anonymous mutation denied',
  rbac.checkAction(db, 'anonymous', 'create_program', {}).ok === false)

// role assignment
rbac.setMemberRole(db, { actor_name: 'vera', role: 'viewer', actor: admin })
rbac.setMemberRole(db, { actor_name: 'pat', role: 'procurement',
  actor: admin })
rbac.setMemberRole(db, { actor_name: 'tess', role: 'technician',
  actor: admin })
rbac.setMemberRole(db, { actor_name: 'finn', role: 'finance_viewer',
  actor: admin })
rbac.setMemberRole(db, { actor_name: 'rev', role: 'reviewer', actor: admin })
check('4 unknown role refused',
  rbac.setMemberRole(db, { actor_name: 'x', role: 'root',
    actor: admin }).error !== undefined)

// viewer: read-only
check('5 viewer cannot mutate runs/evidence/approvals',
  !rbac.checkAction(db, 'vera', 'attach_run', {}).ok
  && !rbac.checkAction(db, 'vera', 'add_evidence', {}).ok
  && !rbac.checkAction(db, 'vera', 'request_approval', {}).ok)

// quote approval requires procurement
const req = apr.requestApproval(db, { approval_type: 'approved_for_quote',
  scope: { board_id: b.board_id }, requested_by: 'pm', actor: admin })
check('6 reviewer canNOT decide a quote approval; procurement CAN',
  !rbac.checkAction(db, 'rev', 'decide_approval',
    { approval_id: req.approval_id }).ok
  && rbac.checkAction(db, 'pat', 'decide_approval',
    { approval_id: req.approval_id }).ok)

// physical evidence: technician uploads, reviewer accepts, tech cannot accept
check('7 technician uploads physical evidence; cannot accept it',
  rbac.checkAction(db, 'tess', 'add_evidence', {}).ok
  && !rbac.checkAction(db, 'tess', 'review_evidence', {}).ok)
check('8 reviewer accepts evidence + marks validation passed',
  rbac.checkAction(db, 'rev', 'review_evidence', {}).ok
  && rbac.hasPermission(db, 'rev', 'mark_validation_passed'))

// finance: costs yes, engineering approvals no
check('9 finance sees costs but approves nothing',
  rbac.checkAction(db, 'finn', 'usage_report', {}).ok
  && !rbac.checkAction(db, 'finn', 'decide_approval',
    { approval_id: req.approval_id }).ok
  && !rbac.checkAction(db, 'finn', 'adjust_credits', {}).ok)

// denied actions fail safely + are auditable (mirror the API dispatcher)
const denial = rbac.checkAction(db, 'vera', 'set_readiness', {})
ent.appendAudit(db, { actor: 'vera', action: 'DENIED:set_readiness',
  scope: { board_id: b.board_id }, note: denial.reason })
check('10 denial carries actor roles + missing permission',
  denial.reason.includes('vera') && denial.reason.includes('edit_program'))

// unknown action safe-denies for non-admins
check('11 unmapped action denied for non-admin, allowed for org admin',
  !rbac.checkAction(db, 'pat', 'mystery_action', {}).ok
  && rbac.checkAction(db, 'dev-admin', 'mystery_action', {}).ok)

const rep = rbac.auditLogReport(db)
check('12 audit log report: privileged + denied actions recorded',
  rep.denied_actions >= 1 && rep.privileged_entries >= 1
  && rep.tail.some((e) => e.action === 'DENIED:set_readiness'))
ent.saveDb(db)
check('13 audit chain intact', ent.verifyAuditChain(ent.loadDb()).ok)

const n = checks.filter(Boolean).length
console.log(`${n}/${checks.length} E5 checks pass`)
process.exit(n === checks.length ? 0 : 1)
