# E5 — Enterprise Roles, Permissions, and Audit Log v1

10 roles × 22 permissions, enforced at the API dispatcher. Approval
decisions resolve their required permission from the approval TYPE
(quote → procurement, evidence acceptance → reviewer/engineer); quote
workflow transitions resolve from the TARGET state.

## Rules
- quote approval requires procurement (or org admin)
- order approval requires explicit approve_order permission
- physical evidence upload: technician or engineer
- physical evidence acceptance: reviewer or engineer
- production readiness approval: reviewer/admin + evidence prerequisites (guardReadiness)
- viewer cannot mutate runs, approvals, or evidence
- finance views costs; approves no engineering claim
- unknown actions safe-deny for non-admins
- every denial is audited (DENIED:<action> with roles + missing permission)
- dev-admin default keeps the local/dev flow working

## Audit
Every privileged action and every denial lands in the hash-chained audit
log with actor, action, scope, before/after, timestamp, and snapshots
where relevant. `auditLogReport()` slices privileged + denied entries.
