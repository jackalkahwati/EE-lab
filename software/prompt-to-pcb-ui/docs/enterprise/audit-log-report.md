# Audit log report — format

`auditLogReport()` returns total entries, privileged count, denied count,
and the privileged tail (seq, actor, action, scope, timestamp, note).
Entries are hash-chained (prev_hash + sha256) so tampering is detectable
via `verifyAuditChain()` — exposed on GET /api/enterprise as audit_chain.
