# E2 — Enterprise Approval Workflow and Governance v1

11 approval types · 6 statuses · immutable history · snapshot-carrying
requests · policy-driven requirements · cascade invalidation.

## Rules (all tested)
- approved_for_quote cannot be inferred — explicit human decision only
- approved_for_order cannot be inferred — explicit human decision only
- physical_evidence_acceptance requires evidence files (store refuses physical items without a real file)
- production_readiness_approval requires physical + yield/manufacturing evidence AND explicit human approval (guardReadiness)
- rejected approvals block downstream states
- revoked approvals invalidate dependent states (visible downgrade + audit entry)
- approval history is immutable — decided approvals cannot be re-decided

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
