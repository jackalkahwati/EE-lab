# E1 — Enterprise workspace UI report

Route: `/enterprise` (behind the existing session auth middleware).

| Required view | Where |
|---|---|
| Organizations / workspace selector | header select, org name + plan chip |
| Program list | left column cards (status, board count, credits) |
| Program detail | main panel (owner, objective, blocked claims) |
| Board list inside program | board chips with readiness badges |
| Board detail | bordered panel with tab bar |
| Run history | Runs tab (route/DRC/ERC states from real artifacts) |
| Evidence tab | Evidence tab (status color-coded; empty state says the physical ledger is EMPTY) |
| Approval tab | Approvals tab (empty state says quote/order stays locked) |
| Usage tab | Usage tab (credits per event) |
| Risk/blocker tab | Risks tab (program risks + board blocked claims) |

Honesty notes: architecture_only and routed_in_sandbox render as their own
badges — no styling implies built or validated hardware; SYNTHETIC DEMO
DATA chip appears when the org is flagged demo.
