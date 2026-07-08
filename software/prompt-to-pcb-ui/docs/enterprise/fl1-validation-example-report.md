# FL-1 validation session — example flow (synthetic)

1. Asset FL1-DEMO-001 registered (calibration: placeholder, claims blocked).
2. Session planned against the FL-1 Core-6 board's real test plan;
   operator assigned.
3. planned -> ready -> running -> completed_pending_review.
4. Acceptance REFUSED: no reviewed evidence ("a completed session never
   implies pass").
5. Operator attaches evidence (real artifact file required; measurement
   3V3_rail = 3.31 V, units mandatory).
6. Acceptance still refused — evidence pending review.
7. Named reviewer accepts the evidence; session acceptance unlocks.
8. Claim impact: physically_validated may now be REQUESTED (the readiness
   guard re-verifies); calibration and production_ready remain blocked.
