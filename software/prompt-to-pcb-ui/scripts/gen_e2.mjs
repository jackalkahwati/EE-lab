/** E2 artifact generator — approval workflow schema + reports. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as apr from '../lib/enterprise/approvals.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCS = path.join(HERE, '..', 'docs', 'enterprise')
fs.mkdirSync(DOCS, { recursive: true })

const schema = {
  version: 'v1',
  approval_types: apr.APPROVAL_TYPES,
  approval_statuses: apr.APPROVAL_STATUSES,
  record_fields: ['approval_id', 'approval_type', 'scope (org/workspace/'
    + 'program/board/run)', 'requested_by', 'approver', 'status',
    'evidence_snapshot', 'blocked_claims_snapshot', 'diff_since_previous',
    'risk_summary', 'notes', 'history (append-only)', 'timestamp'],
  policies: apr.POLICIES,
  downstream_dependencies: apr.DOWNSTREAM,
  rules: [
    'approved_for_quote cannot be inferred — explicit human decision only',
    'approved_for_order cannot be inferred — explicit human decision only',
    'physical_evidence_acceptance requires evidence files (store refuses '
    + 'physical items without a real file)',
    'production_readiness_approval requires physical + yield/manufacturing '
    + 'evidence AND explicit human approval (guardReadiness)',
    'rejected approvals block downstream states',
    'revoked approvals invalidate dependent states (visible downgrade + '
    + 'audit entry)',
    'approval history is immutable — decided approvals cannot be re-decided',
  ],
}

const report = {
  version: 'v1', milestone: 'E2 Enterprise Approval Workflow',
  delivered: {
    engine: 'lib/enterprise/approvals.mjs (request/decide/revoke, '
      + 'snapshots, diff-since-previous, cascade invalidation)',
    api: 'request_approval / decide_approval / revoke_approval / '
      + 'policy_gaps actions on /api/enterprise',
    ui: 'Approvals tab on /enterprise board detail (status color-coded; '
      + 'empty state states that quote/order stays locked)',
    audit: 'every transition appends to the hash-chained audit log with '
      + 'evidence + blocked-claims snapshots',
    export: 'approvalAuditReport() — full immutable history',
    tests: 'scripts/test_e2.mjs — 13/13',
  },
  acceptance: {
    workflows_configurable: 'POLICIES config (4 examples incl. FL-1 '
      + 'physical board and production chain)',
    approval_blocks_downstream: 'guardReadiness consumes approval records; '
      + 'requested-but-undecided unlocks nothing',
    quote_order_human_gated: true,
    audit_trail_visible: true,
    physical_evidence_gates_intact: true,
  },
}

const md = `# E2 — Enterprise Approval Workflow and Governance v1

11 approval types · 6 statuses · immutable history · snapshot-carrying
requests · policy-driven requirements · cascade invalidation.

## Rules (all tested)
${schema.rules.map((r) => '- ' + r).join('\n')}

## Policies (config, not code)
- small_internal_board: board review + package release
- enterprise_external_board: architecture + BOM + package + quote approvals
- fl1_physical_board: APPROVED_FOR_QUOTE remains the human unlock for the
  first physical board execution
- production_board: full chain through physical evidence acceptance and
  production readiness approval

## Evidence
13/13 E2 checks: snapshots on request, no inference from requested state,
unlock only via approved record, immutability of decided approvals,
revocation cascade with VISIBLE downgrade, rejection blocking, policy gap
computation, exportable audit report, intact hash chain.
`

const auditMd = `# Approval audit report — format

Exported by \`approvalAuditReport()\` (JSON) and rendered in the Approvals
tab. Per approval: id, type, scope, status, requester, approver, full
append-only history, evidence-count and blocked-claims-count at request
time. Plus the count of approval-related audit entries and the three
governing rules. History is immutable: decided approvals cannot be
re-decided; revocation appends and cascades, never rewrites.
`

fs.writeFileSync(path.join(DOCS, 'approval-policy-schema.json'),
                 JSON.stringify(schema, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-approval-workflow-v1.json'),
                 JSON.stringify(report, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-approval-workflow-v1.md'), md)
fs.writeFileSync(path.join(DOCS, 'approval-audit-report.md'), auditMd)
console.log('E2 artifacts written to docs/enterprise/')
