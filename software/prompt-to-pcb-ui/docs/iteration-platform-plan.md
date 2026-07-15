# Compose Iteration Platform — Phased Build Plan

**North star:** engineers live in Compose all day, the way developers live in
Cursor. Zero-shot stays the on-ramp; the product becomes the loop — edit, see
the delta, keep what's good, resolve what the machine flagged, repeat — across
electrical, mechanical, firmware, sourcing, and test.

**Design principles (non-negotiable, carried from the current system):**
1. Honest gates survive every phase. A pinned-but-dirty board is still dirty.
2. The run directory stays the artifact store; new state lives BESIDE runs,
   never inside a format that breaks existing readers.
3. Every phase ships usable on its own. No big-bang rewrite.
4. Determinism before features: iteration is only trustworthy when the same
   inputs reproduce the same board.

Current anchors this builds on: `lib/run-pipeline.ts` (orchestrator),
`lib/ground-board.ts` (grounding pattern = implicit dependency DAG),
`app/api/revise/route.ts` (already records `parentId`), staleness marking in
the pipeline, `lib/v1-jobs.ts` (server-side orchestration), Programs bridge
(`lib/programs-sync.ts`), run ownership (`lib/auth.ts`).

---

## Phase 1 — Product & design state (the "repo")

**Goal:** a product is a durable thing with an evolving design state and a
revision lineage; runs become *builds of* a product instead of the product
itself. Diffs make iteration reviewable.

### 1a. Design state document

New: **`lib/design-state.ts`**
- Schema + load/save/migrate for `public/products/<productId>/design-state.json`:
  `{ productId, name, prompt, spec, idBrief, decisions: Decision[], pins: Pin[]
     (empty until Phase 2), revisions: [{ runId, parentRunId, createdAt, note,
     summary }], activeRunId }`
- `Decision` = `{ id, area: 'electronics'|'mechanical'|…, text, source:
  'engineer'|'pipeline'|'redesign-loop', createdAt }` — the durable "why" log
  the chat and future regenerations read.
- Content-hash helpers (`hashSpec`, `hashBoard`) — shared with Phase 2.

New: **`app/api/products/route.ts`** (list/create) and
**`app/api/products/[productId]/route.ts`** (get/update name, decisions).
Session-authed; ownership mirrors `runAccess` (add `productIds` to the user
record in `lib/auth.ts`, alongside `runIds`).

Modified:
- **`components/compose-chat.tsx`** + **`app/compose/page.tsx`** — a fresh
  build creates a product first, then a run attached to it; selecting a
  product loads its `activeRunId`. URL becomes `/compose?product=<id>`
  (keep `?run=` working — resolve run → product).
- **`lib/v1-jobs.ts`** — API builds create/attach to a product too
  (`productId` optional in `POST /api/v1/boards` body; a new build of an
  existing product becomes a revision).
- **`lib/programs-sync.ts`** — one enterprise board per PRODUCT (upsert), not
  per run; `latest_run_id` advances with revisions. Kills the current
  duplicate "Desk Presence Puck ×6" clutter honestly.

### 1b. Revision lineage + diff

New: **`lib/design-diff.ts`** — pure functions producing a structured delta
between two runs, computed from artifacts that already exist:
- BOM delta (`data/bom.json` / `chipscale-board.json` components): added,
  removed, swapped parts.
- Board delta: outline w×h/shape, layer count, component count, DRC errors,
  unrouted (from `chipscale-board.json`).
- Enclosure delta: outer dims, features list, fitCheck (from
  `mechanical/mechanical.json`).
- Budget/spec delta: deep-diff of `product-spec.json` budgets.
- Sim delta: per-domain value changes (from `disciplines/simulation.json`).

New: **`app/api/products/[productId]/diff/route.ts`** — `?from=<runId>&to=<runId>`
returns the structured delta.

New: **`components/revision-rail.tsx`** — left-pane strip on `/compose`:
lineage list (rev n ← rev n-1…), click to load any revision read-only,
"compare" opens **`components/design-diff-view.tsx`** (two-column delta with
the same pass/fail color semantics as the rest of the app).

Modified:
- **`app/api/revise/route.ts`** — write the new run into the product's
  `revisions[]` (it already knows `parentId`); same for the chat revise path
  in `compose-chat.tsx`.
- **`components/run-history.tsx`** — group by product, newest revision on top.

**Acceptance:** build a product; revise it twice from chat; the rail shows a
3-node lineage; the diff view shows the real BOM/board/enclosure deltas; the
enterprise console shows ONE board whose evidence tracks the newest revision.

**Size:** ~1 week. **Risk:** low — additive, no pipeline changes.

---

## Phase 2 — Pins + dependency graph + selective invalidation (the speed layer)

**Goal:** an edit invalidates only what it touches; pinned decisions survive
regeneration; a small change lands in ~30–60 s, not 7 minutes.

### 2a. Pins

Extend **`lib/design-state.ts`**: `Pin = { id, area, kind, value, label }`,
kinds initially: `part` (canonical MPN stays), `board-outline` (shape + w×h),
`connector-position`, `enclosure-dim` (wall/height/diameter), `budget`
(a spec budget field is engineer-set, redesign loop may not move it).

Injection points (each gets a `PINNED CONSTRAINTS (hard)` block built by a new
`pinsPrompt(area)` helper in design-state):
- **`app/api/electronics-cs/route.ts`** — planner prompt: pinned parts MUST
  appear with the pinned MPN; pinned outline is the board shape.
- **`app/api/mechanical/route.ts`** — plan LLM: pinned enclosure dims are hard
  inputs (it already treats ID brief as a hard form constraint — same pattern).
- **`app/api/redesign/route.ts`** — pinned budgets are immovable; if the loop
  can't converge without moving one, that's a capability gap, reported as such
  (never silently unpin).
- **`app/api/discipline/route.ts`** — docs mention pins as requirements.

Enforcement is verified, not trusted: after electronics builds, check pinned
MPNs actually appear in the BOM (extend the existing honest-gate block in
`lib/run-pipeline.ts` `electronicsVerdict` call site); a violated pin fails
the stage with "pin violated: <label>".

UI: **`components/pin-chip.tsx`** — a small pin toggle rendered next to
pinnable facts where they already display (BOM rows in the electronics report,
fitCheck dims in `mechanical-stage.tsx`, budget rows in `run-overview.tsx`).
Pins list + remove in a new section of `run-overview.tsx`.

### 2b. Dependency graph + content hashes

New: **`lib/design-graph.ts`**
- Static discipline DAG (encodes what `run-pipeline.ts` implies today):
  `spec → electronics → {mechanical, firmware, manufacturing, supplyChain,
  validation}`, `mechanical → simulation(enclosure domains)`,
  `electronics → simulation(board domains)`, `idBrief → mechanical`.
- `inputsHash(stage, runDir)`: content hash of each stage's REAL inputs
  (electronics: spec.electronics + pins(electronics); mechanical: ground board
  dims + idBrief + pins(mechanical); …). Persist per-stage
  `{ inputsHash, outputsHash, at }` to `public/runs/<id>/stage-hashes.json`.
  This is the durable spec-hash currency marker from the backlog, generalized.

Modified: **`lib/run-pipeline.ts`**
- New opt `dirtyOnly?: boolean`: before running a stage, compare
  `inputsHash` to the recorded one; unchanged → reuse artifact, report
  `passed (current)` with zero cost. The existing `reuseElectronics` special
  case folds into this general mechanism.
- Revisions copy-forward unchanged artifacts from the parent run (hardlink or
  copy in a new `lib/run-fork.ts`) so a revision starts warm instead of empty.

**Acceptance:** swap one passive via revise → electronics + firmware + docs
re-run, mechanical and enclosure sim are reused as `current`; wall-thickness
edit → only mechanical + enclosure-sim re-run; pinned RP2040 survives five
consecutive revisions; total wall-clock for a part swap ≤ 90 s.

**Size:** ~1.5–2 weeks. **Risk:** medium — hashing the true inputs per stage
is where correctness lives; get it wrong and you serve stale artifacts. Ship
behind `FL_INCREMENTAL=1` until trusted, with the diff view (Phase 1) as the
review net.

---

## Phase 3 — Targeted edits (cmd-K) + the work queue (the daily habit)

**Goal:** small intents route to small actions, and Compose tells the engineer
what needs doing next.

### 3a. Edit router

New: **`lib/edit-intent.ts`** + wire into **`components/compose-chat.tsx`**:
classify a revise message (cheap tier, `MODEL.interviewQuestion`) into
`{ scope: stage[], pins?: Pin[], patch?: spec-patch }` before doing anything.
"make the wall 2.5 mm" → patch mechanical plan input + `dirtyOnly` rerun of
`mechanical→simulation`; "swap to STM32" → electronics scope; free-form/vague
→ today's full revise path (fallback unchanged). Render the plan as a one-line
preview ("will re-run: mechanical, simulation · ~60 s") with a confirm, like
Cursor's diff preview.

### 3b. Work queue from the honest flags

New: **`lib/work-items.ts`** — harvest actionable gaps from artifacts already
produced: `assumptions[]` + `capabilityGaps` (redesign), doc sections whose
text carries `unspecified / not specified / incomplete / verify manually`
(manufacturing/supplyChain/validation JSONs), sim `gated` rows, mechanical
`opsFailed`, pin violations. Persist `public/runs/<id>/work-items.json` at
pipeline end (`lib/run-pipeline.ts` finally block).

New: **`components/work-queue.tsx`** — right-rail panel on `/compose`:
each item = one line + a "resolve" affordance that seeds the chat with a
focused prompt ("Specify the 60 GHz radar module. Candidates: …") whose
completion routes through the edit router → targeted re-run → item closes
(re-harvest on artifact change). Counter chip in `components/status-bar.tsx`.

Modified: **`app/api/discipline/route.ts`** — ask the doc models to emit a
structured `gaps: [{ area, text, blocking }]` field alongside prose (schema
addition, backward compatible) so harvesting gets cleaner over time.

**Acceptance:** after a fresh build the queue lists ≥ the BOM-gap and
undefined-target items visible today as prose; clicking one, answering one
question, and confirming lands a targeted re-run; the item disappears without
a full-pipeline click.

**Size:** ~1 week. **Risk:** low; harvesting quality improves incrementally.

---

## Phase 4 — Sourcing/BOM workspace (real work, not advisory prose)

**Goal:** the BOM is an editable, live-priced surface whose choices persist as
pins.

New: **`lib/sourcing.ts`** — distributor client (Octopart or Digi-Key +
Mouser APIs; keys in `.env.local`, gated like image-gen: absent keys → honest
"not live-sourced" exactly as today). Cache quotes per MPN in
`data/sourcing-cache.json` (TTL 24 h).

New: **`app/api/sourcing/route.ts`** — `?mpn=` live lookup;
`POST { runId, ref, mpn }` = select an alternate → writes a `part` pin +
triggers the edit router (electronics scope only when footprint changes,
else BOM/doc scope).

New: **`components/bom-workspace.tsx`** — replaces the read-only BOM view in
the Mfg tab: per-line stock, price breaks, lead time, alternates dropdown,
risk chip; unspecified lines (today's amber "8 of 10") render as work-queue
items inline. The existing `components/bom-table.tsx` is the base.

Modified: **`app/api/discipline/route.ts`** (supplyChain) — when live data
exists, the sourcing doc quotes it and drops the "not live-sourced" caveat;
fidelity labels stay exact either way.

**Acceptance:** every canonical part shows live stock/price; selecting an
alternate persists across revisions; the sourcing doc's numbers match the
workspace.

**Size:** ~1 week (+ API-key signup latency). **Risk:** external API quality;
mitigated by the honest-gating pattern already used everywhere.

---

## Phase 5 — Multiplayer: review, comments, approvals

**Goal:** the ME, the EE, and the firmware engineer work the SAME product.

- Extend product ownership to members: `sharedWith[]` in design-state +
  `runAccessByEmail` union in **`lib/auth.ts`**; share UI in
  **`components/profile-menu.tsx`** or run-overview.
- Comments anchored to artifacts: new **`app/api/products/[id]/comments/route.ts`**
  + `data/comments/<productId>.json`; render in a thread panel keyed by
  `{ runId, anchor: 'bom:C3' | 'mech:fitCheck' | 'sim:thermal' | … }`.
- Wire the EXISTING enterprise approvals (`app/enterprise/approvals`,
  `lib/enterprise/store.mjs`) to revisions: "request approval on rev N" from
  the revision rail; approval state shows on the enterprise board via the
  Programs bridge, which already carries evidence.

**Acceptance:** a shared user opens the product, comments on a BOM line, the
owner resolves it via the work queue, requests approval, and the enterprise
console reflects it — no email, no screenshots.

**Size:** ~1–1.5 weeks. **Risk:** low, mostly UI; auth model already fails
closed.

---

## Phase 6 — Close the physical loop (directional)

Not scoped to files yet; the order of investigation:
1. **Round-trip imports:** accept an engineer-edited `.kicad_pcb` / STEP back
   into a revision (`app/api/ingest` exists as a stub surface to grow);
   reconcile → new revision with `source: 'manual-edit'`, diffs make it
   reviewable, pins auto-derive from what the human changed.
2. **FL-1 results ingestion:** validation plan items get measured results
   (`disciplines/validation-results.json`), failures become work-queue items —
   the plan → test → fix → re-test loop inside one tool.
3. **Determinism audit:** seed control for freerouting/placement so unchanged
   stages are bit-reproducible, not just hash-reused.

---

## Sequencing and effort

| Phase | What it buys | Size |
|---|---|---|
| 1. Product + lineage + diffs | Trust: iterations are reviewable | ~1 wk |
| 2. Pins + incremental rebuild | Speed + stability: edits are safe and fast | ~2 wk |
| 3. Edit router + work queue | The daily-return habit | ~1 wk |
| 4. Live BOM/sourcing | Real sourcing work happens in-app | ~1 wk |
| 5. Sharing + approvals | The team moves in | ~1.5 wk |
| 6. Round-trip + FL-1 | The moat | open-ended |

Phases 1→3 are the Cursor-parity core (~4 weeks of focused work) and each is
independently shippable. Phase 2 is the only one with real technical risk
(input hashing correctness) — it ships feature-flagged with Phase 1's diff
view as the safety net.
