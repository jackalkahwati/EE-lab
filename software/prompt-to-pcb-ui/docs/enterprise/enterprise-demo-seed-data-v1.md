# E11 — Enterprise Demo Seed Data v1

Synthetic org **Acme Robotics Labs (SYNTHETIC DEMO)** (demo-flagged; the /enterprise UI shows a
SYNTHETIC DEMO DATA chip). Five programs wired to REAL run artifacts:

- **Sensor Controller Pilot** (quote_ready, 1 board(s))
- **FL-1 DUT Power Board Review** (review_required, 1 board(s))
- **BGA Architecture Study** (architecture, 1 board(s)) — blocked: BGA board emission (no ball-grid escape emitter); HDI/microvia/via-in-pad support
- **RF Architecture Study** (blocked, 1 board(s)) — blocked: RF performance; antenna performance; EMC
- **Validation Campaign Example** (validation_in_progress, 1 board(s))

Honesty: 0 fake physical evidence
items, 0 fake orders,
0 boards beyond review states.
The demo's approved_for_quote is backed by a real (synthetic-actor)
approval record; the validation session is planned with zero measurements.

Seed: `node scripts/seed_enterprise_demo.mjs` · Reset: `node scripts/seed_enterprise_demo.mjs --reset`
