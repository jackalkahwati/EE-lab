/**
 * E5 — Enterprise roles, permissions, and audit gating.
 *
 * 10 roles × 22 permissions. The API dispatcher calls checkAction() before
 * every mutation; denials fail safely (403 + audit entry, no partial
 * writes). Default dev flow: the 'dev-admin' actor carries Org Admin so
 * local development keeps working; every other actor must hold a role in
 * db.members. Viewer is read-only. Finance sees costs but approves no
 * engineering claim.
 */

export const ROLES = [
  'org_admin', 'workspace_admin', 'program_manager', 'electrical_engineer',
  'reviewer', 'procurement', 'technician', 'viewer', 'finance_viewer',
  'security_auditor',
]

export const PERMISSIONS = [
  'create_workspace', 'manage_members', 'create_program', 'edit_program',
  'create_board', 'run_architecture', 'run_board_synthesis', 'run_routing',
  'generate_package', 'request_approval', 'approve_architecture',
  'approve_bom', 'approve_package_release', 'approve_quote', 'approve_order',
  'upload_physical_evidence', 'accept_physical_evidence',
  'mark_validation_passed', 'view_costs', 'adjust_credits',
  'export_evidence_pack', 'manage_security_settings',
]

// role -> permission set. Deliberately conservative: quote/order approvals
// sit with procurement (+org admin); physical evidence acceptance with
// reviewer/engineer; validation-passed with reviewer only.
export const ROLE_PERMISSIONS = {
  org_admin: new Set(PERMISSIONS),
  workspace_admin: new Set([
    'create_workspace', 'manage_members', 'create_program', 'edit_program',
    'create_board', 'request_approval', 'view_costs',
    'export_evidence_pack']),
  program_manager: new Set([
    'create_program', 'edit_program', 'create_board', 'run_architecture',
    'request_approval', 'view_costs', 'export_evidence_pack']),
  electrical_engineer: new Set([
    'create_board', 'run_architecture', 'run_board_synthesis', 'run_routing',
    'generate_package', 'request_approval', 'upload_physical_evidence',
    'accept_physical_evidence', 'export_evidence_pack']),
  reviewer: new Set([
    'approve_architecture', 'approve_bom', 'approve_package_release',
    'accept_physical_evidence', 'mark_validation_passed',
    'export_evidence_pack']),
  procurement: new Set([
    'approve_quote', 'approve_order', 'view_costs',
    'export_evidence_pack']),
  technician: new Set([
    'upload_physical_evidence', 'export_evidence_pack']),
  viewer: new Set([]),
  finance_viewer: new Set(['view_costs']),
  security_auditor: new Set(['export_evidence_pack']),
}

// dispatcher action -> required permission
export const ACTION_PERMISSIONS = {
  create_organization: 'create_workspace',
  create_workspace: 'create_workspace',
  create_program: 'create_program',
  create_board: 'create_board',
  attach_run: 'run_board_synthesis',
  add_evidence: 'upload_physical_evidence',
  review_evidence: 'accept_physical_evidence',
  set_readiness: 'edit_program',
  request_approval: 'request_approval',
  decide_approval: null, // resolved per approval type below
  revoke_approval: null,
  policy_gaps: 'export_evidence_pack',
  record_usage: 'view_costs',
  adjust_credits: 'adjust_credits',
  budget_state: 'view_costs',
  usage_report: 'view_costs',
  generate_quote_packet: 'generate_package',
  advance_quote: null, // resolved per target state below
  manual_quote_entry: 'approve_quote',
  register_fl1_asset: 'manage_members',
  plan_validation_session: 'request_approval',
  advance_session: 'upload_physical_evidence',
  create_pilot: 'create_program',
  roi_report: 'view_costs',
  set_member_role: 'manage_members',
}

const APPROVAL_PERMISSION = {
  architecture_approval: 'approve_architecture',
  part_selection_approval: 'approve_bom',
  bom_approval: 'approve_bom',
  board_review_approval: 'approve_package_release',
  package_release_approval: 'approve_package_release',
  quote_request_approval: 'approve_quote',
  approved_for_quote: 'approve_quote',
  approved_for_order: 'approve_order',
  validation_plan_approval: 'approve_package_release',
  physical_evidence_acceptance: 'accept_physical_evidence',
  production_readiness_approval: 'approve_package_release',
}

export function rolesOf(db, actor) {
  if (actor === 'dev-admin') return ['org_admin'] // local/dev default
  db.members = db.members ?? []
  return db.members.filter((m) => m.actor === actor).map((m) => m.role)
}

export function hasPermission(db, actor, permission) {
  return rolesOf(db, actor).some(
    (r) => ROLE_PERMISSIONS[r]?.has(permission))
}

export function setMemberRole(db, { actor_name, role, workspace_id = null,
                                    actor }) {
  if (!ROLES.includes(role)) return { error: `unknown role ${role}` }
  db.members = db.members ?? []
  db.members.push({ actor: actor_name, role, workspace_id,
                    granted_by: actor, at: new Date().toISOString() })
  return { ok: true, actor_name, role }
}

/** the dispatcher gate. Returns {ok} or {ok:false, reason}. */
export function checkAction(db, actor, action, params = {}) {
  if (!actor || actor === 'anonymous') {
    return { ok: false, reason: 'anonymous actors cannot mutate' }
  }
  let required = ACTION_PERMISSIONS[action]
  if (action === 'decide_approval' || action === 'revoke_approval') {
    const a = (db.approvals ?? []).find(
      (x) => x.approval_id === params.approval_id)
    required = APPROVAL_PERMISSION[a?.approval_type] ?? 'approve_quote'
  }
  if (action === 'advance_quote') {
    required = ['approved_for_quote', 'quote_approval_requested']
      .includes(params.to) ? 'approve_quote'
      : ['approved_for_order', 'order_submitted_manually']
        .includes(params.to) ? 'approve_order'
        : 'generate_package'
  }
  if (required === undefined) {
    // unknown action: safe-deny for non-admins
    return hasPermission(db, actor, 'manage_security_settings')
      ? { ok: true }
      : { ok: false, reason: `no permission mapping for ${action}` }
  }
  if (required === null) return { ok: true }
  if (hasPermission(db, actor, required)) return { ok: true }
  return { ok: false,
           reason: `${actor} (roles: ${rolesOf(db, actor).join(',') || 'none'}) `
                   + `lacks ${required}` }
}

export function auditLogReport(db, { limit = 100 } = {}) {
  const privileged = db.audit.filter(
    (e) => /approval|evidence|readiness|credits|DENIED|role|quote|security/
      .test(e.action))
  return {
    generated_at: new Date().toISOString(),
    total_audit_entries: db.audit.length,
    privileged_entries: privileged.length,
    denied_actions: db.audit.filter(
      (e) => e.action.startsWith('DENIED:')).length,
    tail: privileged.slice(-limit).map((e) => ({
      seq: e.seq, actor: e.actor, action: e.action, scope: e.scope,
      at: e.at, note: e.note })),
    fields: ['actor', 'action', 'scope', 'before/after', 'timestamp',
             'session placeholder', 'evidence/approval snapshots', 'note'],
  }
}
