# E1 — Enterprise Program Workspace v1

Organization → Workspace → Program → Board → Run → Evidence → Approval →
Quote/Fab/Validation state → Learning.

## What exists
- **Data model** `lib/enterprise/store.mjs`: 8 entities, 13 program
  statuses, 8 readiness states, 17 evidence types; file-backed JSON store
  with an append-only, hash-chained audit log.
- **API** `/api/enterprise`: GET full state; POST action dispatch. Every
  mutation writes an audit entry; refused promotions are audited too.
- **UI** `/enterprise`: workspace selector, program list, program detail,
  board detail with Runs / Evidence / Approvals / Usage / Risks tabs.
  Readiness renders verbatim; blocked claims and review-required items are
  always visible.

## Gate preservation (load-bearing)
- production_ready structurally unreachable without accepted physical + yield + manufacturing evidence AND production_readiness_approval
- approved_for_quote requires an explicit approved approval record
- physically_validated requires an ACCEPTED physical evidence item whose artifact file exists on disk
- physical evidence items cannot be created without a real file
- blocked claims and review-required items are inherited from run artifacts and never hidden by state changes

## Evidence
13/13 E1 checks: hierarchy, multi-board programs, multi-run boards, REAL
artifact attachment (power-entry-header-v1, FL-1 Core-6), physical-evidence
file requirement, refused promotions (approved_for_quote, physically_
validated, production_ready), audit chain integrity.
