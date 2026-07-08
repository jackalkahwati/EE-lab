/**
 * E2 — Enterprise approval workflow and governance.
 *
 * Formal approvals with immutable history: an approval record is never
 * edited in place — every transition appends a new immutable audit entry
 * and decision snapshot. Rejected approvals block downstream states;
 * revoking an approval invalidates every state that depended on it.
 * approved_for_quote / approved_for_order can NEVER be inferred:
 * only an explicit human decision creates them.
 */
import { newId, appendAudit } from './store.mjs'

export const APPROVAL_TYPES = [
  'architecture_approval', 'part_selection_approval', 'bom_approval',
  'board_review_approval', 'package_release_approval',
  'quote_request_approval', 'approved_for_quote', 'approved_for_order',
  'validation_plan_approval', 'physical_evidence_acceptance',
  'production_readiness_approval',
]

export const APPROVAL_STATUSES = [
  'not_requested', 'requested', 'approved', 'rejected', 'expired', 'revoked',
]

// which readiness/workflow states each approval unlocks (used for
// revocation cascade + downstream blocking)
export const DOWNSTREAM = {
  approved_for_quote: ['approved_for_quote', 'quote_packet_ready',
                       'quote_approval_requested'],
  approved_for_order: ['approved_for_order', 'order_submitted_manually',
                       'fab_in_progress'],
  physical_evidence_acceptance: ['physically_validated'],
  production_readiness_approval: ['production_ready'],
  package_release_approval: ['package_ready_with_review'],
}

// example approval policies (config, not code): which approvals a board
// class requires before quote/order paths open
export const POLICIES = {
  small_internal_board: {
    required: ['board_review_approval', 'package_release_approval'] },
  enterprise_external_board: {
    required: ['architecture_approval', 'bom_approval',
               'package_release_approval', 'approved_for_quote'] },
  fl1_physical_board: {
    required: ['board_review_approval', 'package_release_approval',
               'approved_for_quote'],
    note: 'APPROVED_FOR_QUOTE remains the human unlock for first physical '
          + 'board execution' },
  production_board: {
    required: ['architecture_approval', 'bom_approval',
               'package_release_approval', 'approved_for_quote',
               'approved_for_order', 'physical_evidence_acceptance',
               'production_readiness_approval'] },
}

function snapshotEvidence(db, scope) {
  const ids = [scope.board_id, scope.run_id, scope.program_id].filter(Boolean)
  return db.evidence
    .filter((e) => ids.includes(e.scope_id))
    .map((e) => ({ evidence_id: e.evidence_id, type: e.evidence_type,
                   status: e.status }))
}

function snapshotBlockedClaims(db, scope) {
  const b = db.boards.find((x) => x.board_id === scope.board_id)
  const p = db.programs.find((x) => x.program_id === scope.program_id)
  return [...new Set([...(b?.blocked_claims ?? []),
                      ...(p?.blocked_claims ?? [])])]
}

export function requestApproval(db, { approval_type, scope, requested_by,
                                      risk_summary = '', notes = '', actor }) {
  if (!APPROVAL_TYPES.includes(approval_type)) {
    return { error: `unknown approval_type ${approval_type}` }
  }
  // diff vs previous approval of same type+scope
  const prev = db.approvals.filter(
    (a) => a.approval_type === approval_type
      && JSON.stringify(a.scope) === JSON.stringify(scope)).pop()
  const evidence_snapshot = snapshotEvidence(db, scope)
  const blocked = snapshotBlockedClaims(db, scope)
  const a = {
    approval_id: newId('apr'), approval_type, scope,
    requested_by, approver: null,
    status: 'requested',
    evidence_snapshot,
    blocked_claims_snapshot: blocked,
    diff_since_previous: prev ? {
      previous_approval_id: prev.approval_id,
      previous_status: prev.status,
      evidence_delta: evidence_snapshot.length
        - (prev.evidence_snapshot?.length ?? 0),
      blocked_claims_delta: blocked.length
        - (prev.blocked_claims_snapshot?.length ?? 0),
    } : null,
    risk_summary, notes,
    history: [{ status: 'requested', by: requested_by,
                at: new Date().toISOString() }],
    timestamp: new Date().toISOString(),
  }
  db.approvals.push(a)
  appendAudit(db, { actor, action: 'request_approval',
                    scope, after: { approval_type, status: 'requested' },
                    evidence_snapshot, note: risk_summary })
  return a
}

export function decideApproval(db, { approval_id, decision, approver,
                                     notes = '', actor }) {
  const a = db.approvals.find((x) => x.approval_id === approval_id)
  if (!a) return { error: 'no such approval' }
  if (!['approved', 'rejected'].includes(decision)) {
    return { error: 'decision must be approved|rejected' }
  }
  if (a.status !== 'requested') {
    return { error: `approval is ${a.status}; only requested approvals can `
                    + 'be decided (history is immutable)' }
  }
  if (!approver) return { error: 'decision requires a named approver' }
  a.status = decision
  a.approver = approver
  a.notes = notes
  a.history.push({ status: decision, by: approver,
                   at: new Date().toISOString() })
  appendAudit(db, { actor, action: 'decide_approval',
                    scope: a.scope,
                    before: { status: 'requested' },
                    after: { approval_type: a.approval_type,
                             status: decision, approver },
                    approval_snapshot: {
                      approval_id, evidence: a.evidence_snapshot,
                      blocked_claims: a.blocked_claims_snapshot },
                    note: notes })
  // a rejection blocks the downstream states it would have unlocked
  if (decision === 'rejected') {
    cascadeInvalidate(db, a, 'rejected', actor)
  }
  return a
}

export function revokeApproval(db, { approval_id, reason, actor }) {
  const a = db.approvals.find((x) => x.approval_id === approval_id)
  if (!a) return { error: 'no such approval' }
  if (a.status !== 'approved') {
    return { error: 'only approved approvals can be revoked' }
  }
  if (!reason) return { error: 'revocation requires a reason' }
  a.status = 'revoked'
  a.history.push({ status: 'revoked', reason, at: new Date().toISOString() })
  appendAudit(db, { actor, action: 'revoke_approval', scope: a.scope,
                    before: { status: 'approved' },
                    after: { approval_type: a.approval_type,
                             status: 'revoked' },
                    note: reason })
  cascadeInvalidate(db, a, 'revoked', actor)
  return a
}

/** rejected/revoked approvals invalidate every dependent state */
function cascadeInvalidate(db, approval, cause, actor) {
  const downstream = DOWNSTREAM[approval.approval_type] ?? []
  const b = db.boards.find((x) => x.board_id === approval.scope?.board_id)
  if (b && downstream.includes(b.readiness)) {
    const before = b.readiness
    b.readiness = 'package_ready_with_review'
    b.review_required_items.push(
      `readiness downgraded from ${before}: ${approval.approval_type} ${cause}`)
    appendAudit(db, { actor, action: 'cascade_invalidate_readiness',
                      scope: approval.scope,
                      before: { readiness: before },
                      after: { readiness: b.readiness },
                      note: `${approval.approval_type} ${cause}` })
  }
  const q = db.quotes.find((x) => x.board_id === approval.scope?.board_id)
  if (q && downstream.includes(q.state)) {
    const before = q.state
    q.state = 'blocked'
    q.history = q.history ?? []
    q.history.push({ state: 'blocked', at: new Date().toISOString(),
                     note: `${approval.approval_type} ${cause}` })
    appendAudit(db, { actor, action: 'cascade_invalidate_quote',
                      scope: approval.scope,
                      before: { state: before }, after: { state: 'blocked' },
                      note: `${approval.approval_type} ${cause}` })
  }
}

/** which required approvals (per policy) are still missing for a board */
export function policyGaps(db, { board_id, policy = 'enterprise_external_board' }) {
  const pol = POLICIES[policy]
  if (!pol) return { error: `unknown policy ${policy}` }
  const approved = new Set(db.approvals
    .filter((a) => a.scope?.board_id === board_id && a.status === 'approved')
    .map((a) => a.approval_type))
  return {
    policy, required: pol.required,
    missing: pol.required.filter((r) => !approved.has(r)),
    satisfied: pol.required.filter((r) => approved.has(r)),
  }
}

/** approval audit report (exportable) */
export function approvalAuditReport(db) {
  return {
    generated_at: new Date().toISOString(),
    approvals: db.approvals.map((a) => ({
      approval_id: a.approval_id, type: a.approval_type, scope: a.scope,
      status: a.status, requested_by: a.requested_by, approver: a.approver,
      history: a.history,
      evidence_items_at_request: a.evidence_snapshot?.length ?? 0,
      blocked_claims_at_request: a.blocked_claims_snapshot?.length ?? 0,
    })),
    audit_entries: db.audit.filter(
      (e) => e.action.includes('approval')).length,
    rules: ['approval history is immutable (decided approvals cannot be '
            + 're-decided; transitions append, never rewrite)',
            'approved_for_quote / approved_for_order cannot be inferred',
            'rejection and revocation cascade to dependent states'],
  }
}

// dispatcher handlers ---------------------------------------------------------
export function handlers(db, actor) {
  return {
    request_approval: (p) => requestApproval(db, { ...p, actor }),
    decide_approval: (p) => decideApproval(db, { ...p, actor }),
    revoke_approval: (p) => revokeApproval(db, { ...p, actor }),
    policy_gaps: (p) => policyGaps(db, p),
  }
}
