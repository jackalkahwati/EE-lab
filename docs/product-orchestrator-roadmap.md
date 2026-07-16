# Product Orchestrator Roadmap — recursive, constraint-driven co-design

Adopts the universal product loop (Define → Decompose → Generate → Integrate →
Simulate → Diagnose → Revise → Validate) as FirstLight's architecture. The
governing principle:

> Generate the product, test the integrated product, identify the weakest
> constraint, revise the smallest necessary portion, propagate the change,
> and repeat.

**This is a roadmap, not an implementation plan.** Each stage gets its own
bite-sized plan (docs/superpowers/plans/) when it starts. Stages are ordered
so every one ships working, visible software and none requires a rewrite —
the audit (2026-07-15) confirmed the loop's organs mostly exist; what is
missing is the circulatory system connecting them.

## What already exists (do NOT rebuild)

- **Intent + decomposition**: `hardware/planner/intent.py`, `decompose.py`
  (subsystem tree), `subsystems.py` (design-of-N for power/compute with real
  tradeoffs), `evaluate.py` (`converge()` — a genuine electronics-level
  fixpoint with correctives).
- **One coherent electronics model**: `data/design.json` (board = design =
  BOM, verified), `data/design-tree.json`, `data/verification.json`.
- **Parallel discipline synthesis**: `lib/run-pipeline.ts` +
  `/api/discipline` (grounded on design.json), mechanical route + Onshape
  executor, six real sim solvers, DRC/ERC gates, firmware cargo-build gate.
- **Change machinery (built for user edits, reusable by the loop)**:
  edit-router, work queue, stage-hash pins + incremental rebuilds, product
  lineage/diffs.
- **Judges**: the ID self-consistency gate and mechanical ID-fidelity loop
  (plan: 2026-07-15-mech-id-fidelity-loop.md) — the pattern every discipline
  verdict follows: real artifact → scored verdict → actionable violations →
  targeted revision, persisted honestly incl. "unverified".
- **Orphaned optimization kernel**: `lib/design-problem.ts`,
  `lib/evaluators.ts`, `lib/optimizer.ts` (N-candidate + Pareto) — reachable
  only from the read-only Explore tab. The loop is its real consumer.

## The three graphs (the core abstraction)

1. **Functional graph** — what the product does. MISSING. Stage E.
2. **Physical architecture graph** — which subsystems perform the functions.
   EXISTS as design-tree.json (electronics); grows to whole-product.
3. **Constraint & dependency graph** — how a change propagates. MISSING as a
   first-class artifact (it lives implicitly in code today). Stage A makes it
   explicit and DECLARED (static, auditable), not learned.

---

## Stage A — Shared product state + declared dependency graph (keystone)

One canonical `product-state.json` per run, superseding the scatter:
design.json (electronics) + id-brief + mech plan/fidelity + sim results +
BOM-derived cost/mass + budgets, each section carrying `validationStatus` and
a content hash (reuse stage-hash). Alongside it, a DECLARED dependency map —
data, not inference:

```
edges: boardOutline -> [mechanical, id-render-scaffold]
       bom          -> [cost, mass, supply, thermal-budget]
       envelopeMm   -> [mechanical, id-render]
       mcu          -> [firmware, power-budget]
       powerBudget  -> [eps/power subsystem]
       ...
```

Every stage that writes state names what it produced; every stage that reads
names what it consumed (the stage-hash pins already encode half of this).
Deliverable: all existing stages read/write product-state without behavior
change — pure unification. This is Step 6-7 of the algorithm ("integrate into
a common system model") and the substrate for everything below.

## Stage B — Product scorecard + root-cause diagnosis

Aggregate what already exists into `scorecard.json`: requirements pass/fail
WITH MARGINS (DRC counts, sim results vs targets, verification.json checks,
fidelity/consistency verdicts, cost vs budget, mass estimate, coverage of
requested capabilities, per-check confidence/fidelity labels — analytic vs
surrogate vs real-sim vs measured, honestly distinguished).

Diagnosis turns a failure into an ACTIONABLE request, not a stage name: an
LLM diagnostician receives the failed check + the dependency graph slice
around it + each contributor's current value, and must output the SMALLEST
corrective: `{target: <state field or subsystem>, change, expectedEffect,
alsoAffects[] (from the graph), penaltyEstimate}`. Format enforced like every
other judge (schema + normalize + honest "no corrective found" state —
`converge()` in evaluate.py already models this contract at electronics
scope; Stage B lifts it to product scope).

UI: the scorecard is the run's front page (today the intelligence hides in
log lines — open item #3 from the run-video review).

## Stage C — Targeted propagation + product-level convergence

The loop itself. On an accepted corrective: apply the change to product
state → invalidate ONLY the dependent artifacts (walk the declared graph;
reuse the work queue + incremental rebuild machinery) → re-run those stages →
re-score → repeat until the scorecard converges or the iteration cap hits
(cap default 2 product-level rounds; every round's scorecard is kept — the
trajectory is the evidence). Plus a periodic FULL revalidation (local fixes
can create global problems): every Nth accepted product or on demand, all
pins are dropped and everything re-runs.

Honesty rule carried up from converge(): "converged" is claimed ONLY when no
requirement is failing; otherwise the run ships as `failed-threshold` with
the scorecard showing exactly what and why.

## Stage D — Hard/soft constraints in the envelope

`id-brief.json` gains constraint classes: every envelope/feature/control is
`hard` (regulatory clearance, human-hand dimension, connector access,
required battery volume) or `soft` (surface curvature, button position, vent
placement, styling lines). The mechanical planner may move soft constraints
with a logged justification; hard violations are scorecard failures routed
back to ID/architecture, never silently absorbed. The diagnostician's
"smallest change" search prefers soft-constraint moves and prices hard ones
as near-prohibitive. This stops ID from being either immutable or repeatedly
destroyed — the exact failure mode observed on current runs.

## Stage E — Functional graph + candidate architectures

Prepend functional decomposition to the planner: intent → functions (collect
light / convert / store / display / power / reject heat…), each with
inputs/outputs/performance/failure modes → THEN map functions to the physical
subsystem tree (decompose.py's tree becomes the mapping target, not the first
artifact). Wire the orphaned `lib/optimizer.ts` as the per-subsystem
design-of-N solver wherever alternatives exist (open item #6) — power/compute
already do this by hand; sensing/connectivity/storage follow. Candidate
architectures are scored by the SAME scorecard (Stage B), which is what makes
trade studies real rather than narrated.

## Stage F — Fidelity ladder (concept → detailed → prototype)

Same loop, increasing model fidelity, matching the framework's loops:
- **Concept**: analytic/surrogate evaluators only (lib/evaluators.ts as-is),
  seconds per candidate, wide search.
- **Preliminary**: real parts (planner KB), real packaging, cheap real checks
  (evaluate.py, rail/fit/coverage).
- **Detailed**: full routing + DRC, real sims (the 6 solvers), firmware
  builds, fab-class rules — today's pipeline IS this tier.
- **Prototype**: FL-1 measured results feed back — the registry's
  `hardware-verified` binding level is already reserved for exactly this;
  measured data corrects the surrogate evaluators (model correction).
The orchestrator picks the tier per loop iteration: broad cheap search first,
expensive verification on survivors only.

---

## Sequencing and effort

| Stage | Depends on | Size | Ships visibly |
|---|---|---|---|
| A state+graph | — | days | one product-state.json per run |
| B scorecard+diagnosis | A | days–week | scorecard front page per run |
| C propagation loop | A, B | week | products that self-correct across disciplines |
| D hard/soft ID | A (B helps) | days | envelope changes logged + justified |
| E functional graph + optimizer | A, B | week+ | trade studies with scored alternatives |
| F fidelity ladder | B, C | continuous | faster loops, cheaper search |

Already queued and complementary (run in any order vs Stage A):
- 2026-07-15-mech-id-fidelity-loop.md — the mech + ID judges (Stage B's
  discipline verdicts for the mechanical side).
- 2026-07-15-eps-battery-block.md — capability, orthogonal.

Compose's role in the end state, per the framework: Compose owns electronics
(architecture, parts, PCB, firmware, electrical sim, sourcing, validation) as
one solver attached to the graphs; mechanical/ID/thermal/etc. are peer
solvers; `run-pipeline.ts` grows into the orchestration layer that owns
requirements, shared state, change propagation, scheduling, trade studies,
and convergence. Grow the existing pipeline into the orchestrator — do not
spin a parallel one.
