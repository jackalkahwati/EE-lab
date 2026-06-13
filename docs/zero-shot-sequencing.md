# Zero-Shot Sequencing — status and findings (2026-06-12)

Goal: prompt → fab-ready PCBA in one unattended run. Strategy: don't
eliminate iteration — relocate it inside the machine. Every defect class
found downstream becomes an upstream gate check; every gate failure gets a
bounded automated repair before a human sees anything.

## UPDATE 2 — flroute v2 (#1+#2): edge + hole classes eliminated natively

Three flroute changes were attempted to drive the full unattended pipeline
to 0 DRC violations. Two landed, one was reverted after controlled testing.

**#1 boundary clamp (LANDED).** flroute built its grid `ceil(span/pitch)+2`
cells, overshooting the boundary bbox by ~2 cells, so far-edge routing put
copper <0.5mm from the real edge. Fix: block every cell whose center falls
outside `[bx0,bx1]x[by0,by1]`. Pairs with the DSN boundary inset
(export_dsn.py, 0.65mm = edge_clearance + width/2 + guard).

**#2 keepout rasterization (LANDED).** flroute parsed no `(keepout)` from
the DSN, ignoring the 20 mounting-hole keepouts pcbnew exports. Fix: parse
each keepout polygon, rasterize bbox + (clearance + width/2) halo, block on
all layers.

**Result (#1+#2): full pipeline 24 -> 4 violations.** All edge-clearance
(was 5-17) and hole-clearance classes ELIMINATED. Beats the hand-converged
committed v1 board (15 violations). The residual 4 are all fine-pitch
`clearance` (sub-0.2mm).

**#3 clearance-aware terminal snap (ATTEMPTED, REVERTED).** Hypothesis: the
residual clearance defects came from the terminal snap moving wire ends
off-grid into foreign pads; back off the snap toward the (rule-safe) grid
cell. Controlled A/B on identical input DSN: #1+#2 = 11 violations, #1+#2+#3
= 11 violations, and the EN/PG-pad clearance got WORSE (0.16 -> 0.075mm).
Reverted. Root cause was misdiagnosed.

**The real clearance class = fanout-stub-vs-foreign-copper.** The residual
defects are track-segment-vs-pad (EN seg vs U16 PG) and track-vs-track
(tip-6/tip-7 @ 0.08mm, sel_kfn/dmm_lo @ 0.096mm). The grid pitch
`(width+clearance)*1.15` makes grid-routed tracks rule-safe by construction,
so these come from OFF-GRID geometry: the fanout escape stubs (main.rs
~485-660), which the README states are "legality-checked against true pad
boxes" — i.e. against PADS, not against other nets' stubs/tracks. Two stubs
from adjacent fine-pitch pads run parallel <0.2mm apart.

**Spec for the real #3 (owning session's lane — the stub generator):**
when placing a fanout stub, check its swept corridor for `clearance + width`
against (a) all other nets' already-placed stubs and (b) committed track
cells, not just pad boxes. If the straight escape violates, dogleg the stub
to an adjacent free lane or withhold via the emission gate. This is the
documented "smarter dogleg snap / stub clearance" future work; it sits in
the stub geometry the owning session built and understands.

## UPDATE — flroute v1 (commit 74949ad) closed the referee gap natively

The pad-entry undershoot diagnosed below was fixed in the router:
"pad-shape-aware terminal snapping (circle pads have no copper in bbox
corners)". Verified against the neutral referee — kicad-cli DRC on the
committed board shows **all 174 signal nets connected, zero open**. flroute
v1: 174/174 in ~170s.

Consequences for this pipeline:
- `stitch_pads.py` is now a thin safety net, not the fix. It skips
  zone-served nets and only catches residual near-misses. Remove entirely
  once a v1 run confirms 0 stitches needed.
- Referee on the committed v1 board: **15 violations**, split as:
  - 2 copper-copper clearance (scope_a vs sel_ksn-com) — flroute's
    converging-dogleg pair, documented in the flroute README. NB: referee
    measures 0.026mm, author reported 0.16mm — confirm same zone-fill state.
  - 13 edge/hole clearance on J7 + U2 — the PLACEMENT keepout class. These
    exist because v1 routed from a placement predating the gate upgrade
    below. The upgraded placement gate catches them; the fix must run
    PRE-route (can't move a footprint on a routed board without orphaning
    its copper).
- Unowned remaining: **157 zone-rail unconnected items** (lv / coil_bus
  SMD pads on F.Cu needing fanout vias to In1/In2 pours). Belongs in
  import_route.py as a via-drop pass — different operation than lateral
  stitch.

## The referee gap — ROOT-CAUSED (now fixed in flroute v1, see above)

flroute claimed 171/174 routed; kicad-cli connectivity saw only 128/176.
Differential diagnosis (`software/prompt-to-pcb-ui/scripts/diagnose_gap.py`
+ `probe_open_nets.py`) on the run-4 board:

- **Pad-entry undershoot, 100–400 µm.** Routed chains are fully connected
  (1 component at exact endpoint tolerance — NO micro-gaps from SES
  rounding), but the terminal endpoint stops short of the pad polygon:
  flroute's target rasterization accepts grid cells whose center is inside
  the pad's bounding region but outside the actual pad copper.
- 32 two-pad nets: chain complete, one end 100–400 µm short.
- 14 multi-pin nets: same defect per subpath (e.g. RCK: 13 pads, 150
  segments, 7 disconnected subchains, each ending at/near a pad).
- 3 nets honestly failed by flroute (hv ×33 pads, nG, one coil_n).

**Interim fix (glue layer, shipped):** `stitch_pads.py` adds a short
same-net segment from each near-miss endpoint (≤0.6 mm) to the pad center
after SES import. Result on run-4 board: open signal nets 48 → 7.

**Native fix (flroute, main.rs — other session's lane):** emit a final
pad-entry segment from the terminal grid point to the pad anchor, or only
accept target cells whose center lies inside the pad polygon. Once native,
delete stitch_pads.py from the runner.

**Known stitch caveat:** stitching added 1 new clearance violation (a
stitch passing near foreign copper). Refinement: post-stitch DRC → remove
any stitch implicated in a new violation, leave that net honestly open.

## Placement gate upgraded (defects promoted upstream)

`hardware/pcba-rev-a/scripts/placement_score.py` now also gates:
- courtyard-to-board-edge ≥ 3.0 mm
- courtyard-to-mounting-hole ≥ 3.5 mm radial

This catches at placement time what previously surfaced as kicad-cli
`copper_edge_clearance` / `hole_clearance` violations after routing
(J7 at 0.18 mm from a hole, L1 at 3.13 mm, SEAF14 1.93 mm from edge).

## Automated repair (runner retry policy)

`/api/pipeline/run` no longer stops at a placement gate failure:
gate → `repair_placement.py` (bounded nudge toward board center, courtyard
overlap-aware) → re-gate, up to 2 repair rounds. Verified: run-4 placement
fails the new gate, repair moves L1 1.0 mm / SEAF 1.5 mm / J7 5.0 mm, gate
passes, HPWL unchanged (18862 → 18830).

## KiCad 10.0.1 headless swig — institutional knowledge

Standalone pcbnew python in this build:
- container accessors (`GetNetsByName`, `b.Zones()`, `Pads()` post-mutation,
  `GetRatsnestForNet`) return dead proxies or segfault → capture everything
  needed BEFORE any Remove/Add mutation
- interpreter may segfault at teardown AFTER a clean SaveBoard → callers
  key on output sentinels (`v3:`, `IMPORT_OK`, `STITCHED n`, `REPAIRED n`),
  never on exit codes
- per-net connectivity verdicts: use kicad-cli DRC JSON, not the API

## Remaining for true zero-shot (in order)

1. flroute native pad-entry fix + the via-center pocket patch + commit v1
   (other session).
2. Dirty-stitch removal (post-stitch DRC scrub).
3. hv (33-pad power net) — candidate for zone/pour treatment instead of
   track routing; nG likely needs the pocket via fix.
4. Escape-feasibility check in the placement gate (kills the sealed-pocket
   class before routing).
5. Schematic layer: verified .ato module library + ERC + asserts. No
   software referee exists for schematic correctness — composition of
   bring-up-verified blocks is the zero-shot path; FL-1 itself is the
   referee that verifies new blocks.
