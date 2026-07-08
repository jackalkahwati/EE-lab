# Approval audit report — format

Exported by `approvalAuditReport()` (JSON) and rendered in the Approvals
tab. Per approval: id, type, scope, status, requester, approver, full
append-only history, evidence-count and blocked-claims-count at request
time. Plus the count of approval-related audit entries and the three
governing rules. History is immutable: decided approvals cannot be
re-decided; revocation appends and cascades, never rewrites.
