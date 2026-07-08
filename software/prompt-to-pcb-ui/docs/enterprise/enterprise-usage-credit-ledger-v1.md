# E4 — Board-Program Credits and Usage Ledger v1

15 usage categories, config-driven costs, 4 internal modeling tiers
(pilot / team / enterprise / enterprise+FL-1). Program budgets accumulate
consumption; overage flags `overage_review_required` — a commercial
review state that never blocks an engineering gate.

Not billing: no money moves, no payment integration, no external calls.
Manual credit adjustments require a reason and are hash-chain audited.

Pricing alignment: existing app surfaces with price-like strings are
reported (below) for human reconciliation — this sprint does not modify
the homepage or the existing billing API.

- `app/page.tsx`: Pro, pro
- `components/profile-menu.tsx`: Pro, pro, credits, Credits, $49
