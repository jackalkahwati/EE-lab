# E9 — Customer-Facing Program Report Export v1

Seven report types (pilot_summary, program_status, board_review_packet,
quote_ready_packet, validation_summary, roi_summary, executive_summary) in
Markdown + JSON, built from the enterprise store + real run artifacts.

Honesty is enforced in code:
- architecture_only -> "architecture defined — no board has been generated" (never "built")
- routed_in_sandbox -> "...not built, not physically validated" (never "validated")
- ROI carries basis=ESTIMATED until measured evidence exists
- local absolute paths scrubbed; no secrets; no debug noise unless a technical appendix is requested

Blocked claims and the physical-evidence state are mandatory sections —
a customer report cannot be generated without them.
