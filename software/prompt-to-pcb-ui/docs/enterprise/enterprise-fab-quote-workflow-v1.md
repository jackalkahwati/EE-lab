# E7 — Fab/Quote Attach Workflow v1

12-state machine from package_not_ready to boards_received_pending_evidence.
Nothing outward is automatic: quote and order submission are MANUAL-entry
states requiring a human note describing the action performed outside the
platform. approved_for_quote / approved_for_order verify an approved
approval record AT TRANSITION TIME.

- no automatic quote submission — quote_submitted_manually requires human manual entry with a note
- no automatic order submission — same mechanism
- approved_for_quote / approved_for_order verify an approved approval record at transition time
- quote_received is not physical evidence
- order_submitted is not physical validation
- boards_received_pending_evidence still requires evidence upload + review before any physical claim
- fab attach is internal metadata only
