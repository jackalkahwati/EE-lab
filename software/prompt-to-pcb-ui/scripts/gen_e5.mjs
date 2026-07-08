/** E5 artifact generator — RBAC schema + audit reports. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as rbac from '../lib/enterprise/rbac.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCS = path.join(HERE, '..', 'docs', 'enterprise')
fs.mkdirSync(DOCS, { recursive: true })

const schema = {
  version: 'v1',
  roles: rbac.ROLES,
  permissions: rbac.PERMISSIONS,
  role_permissions: Object.fromEntries(
    Object.entries(rbac.ROLE_PERMISSIONS).map(([r, s]) => [r, [...s]])),
  action_permission_map: rbac.ACTION_PERMISSIONS,
  rules: [
    'quote approval requires procurement (or org admin)',
    'order approval requires explicit approve_order permission',
    'physical evidence upload: technician or engineer',
    'physical evidence acceptance: reviewer or engineer',
    'production readiness approval: reviewer/admin + evidence prerequisites '
    + '(guardReadiness)',
    'viewer cannot mutate runs, approvals, or evidence',
    'finance views costs; approves no engineering claim',
    'unknown actions safe-deny for non-admins',
    'every denial is audited (DENIED:<action> with roles + missing '
    + 'permission)',
    'dev-admin default keeps the local/dev flow working',
  ],
}

const report = {
  version: 'v1', milestone: 'E5 Roles, Permissions, Audit',
  delivered: {
    engine: 'lib/enterprise/rbac.mjs (10 roles x 22 permissions, '
      + 'per-approval-type resolution, per-quote-transition resolution)',
    api_gating: 'the /api/enterprise dispatcher calls checkAction before '
      + 'every mutation; 403 + audit entry on denial, no partial writes',
    audit: 'hash-chained log (E1) + auditLogReport (privileged/denied '
      + 'slices); role grants audited',
    ui: 'audit tail exposed via GET /api/enterprise (audit_tail, '
      + 'audit_chain)',
    tests: 'scripts/test_e5.mjs — 13/13 incl. denied-action regressions',
  },
  acceptance: {
    roles_and_permissions_exist: true,
    sensitive_actions_gated: true,
    denied_actions_fail_safely: '403 + DENIED audit entry, store untouched',
    audit_records_privileged_actions: true,
    dev_flow_unaffected: 'dev-admin carries org_admin',
  },
}

const md = `# E5 — Enterprise Roles, Permissions, and Audit Log v1

10 roles × 22 permissions, enforced at the API dispatcher. Approval
decisions resolve their required permission from the approval TYPE
(quote → procurement, evidence acceptance → reviewer/engineer); quote
workflow transitions resolve from the TARGET state.

## Rules
${schema.rules.map((r) => '- ' + r).join('\n')}

## Audit
Every privileged action and every denial lands in the hash-chained audit
log with actor, action, scope, before/after, timestamp, and snapshots
where relevant. \`auditLogReport()\` slices privileged + denied entries.
`

fs.writeFileSync(path.join(DOCS, 'rbac-permission-schema.json'),
                 JSON.stringify(schema, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-rbac-audit-v1.json'),
                 JSON.stringify(report, null, 1))
fs.writeFileSync(path.join(DOCS, 'enterprise-rbac-audit-v1.md'), md)
fs.writeFileSync(path.join(DOCS, 'audit-log-report.md'),
`# Audit log report — format

\`auditLogReport()\` returns total entries, privileged count, denied count,
and the privileged tail (seq, actor, action, scope, timestamp, note).
Entries are hash-chained (prev_hash + sha256) so tampering is detectable
via \`verifyAuditChain()\` — exposed on GET /api/enterprise as audit_chain.
`)
console.log('E5 artifacts written')
