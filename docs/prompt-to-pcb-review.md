# Prompt-to-PCB Stack — Review (2026-07-03)

Scope: the AI-driven design pipeline (prompt → atopile → placement →
flroute → KiCad referee → fab package) — `docs/prompt-to-pcba.md`,
`software/prompt-to-pcb-ui`, `hardware/pcba-rev-a` reference, and the
flroute router. Method: full code map, then **reproduce the headline
claim from source** and improve what the reproduction exposed.

## Verdict

The architecture is sound and unusually honest: hard gates between
stages, KiCad demoted to a neutral referee, every claim traced to a
gate artifact, and a clean GPL boundary (file exchange only). The
weak spot the reproduction found was real: the router's headline
number didn't reproduce, and the cause was two correctness holes plus
a missing recovery pass — all three now fixed.

## Reproduction (before)

Exported a fresh DSN from the placed reference board and ran the
committed flroute with the pipeline's true zone skips
(`--skip-net lv --skip-net sel_p4-coil_bus-hv`):

- Header claimed **174/174 (~170 s)**; the binary delivered
  **173/174 in ~46 s** — the 14-pin `nG` net failed.
- Failure chain: `nG` rips 7 sealer tracks, routes, but then `hv`
  cannot re-route (nG's new path seals hv's pocket) → phase-2
  transaction fails → rollback → `nG` marked dead. A classic pairwise
  swap deadlock, abandoned *before* four later transactions (RCK, EN,
  ctl-SERIN-10, FB) reshaped the board.

## Fixes shipped (flroute v4)

1. **Exact escape test** (walled-pin detection): the old
   `visited > 1500` BFS shortcut declared any large region
   "escapable", so pins inside big sealed pockets never got escape
   stubs and their nets failed after full-grid expansion. Now a pin
   escapes iff its reachable free/own region touches the main
   free-field component — computed from the connected-component
   labels already built in the same round.
2. **Exact orphan test** (stub corridor placement): same
   `>1500` flaw let a corridor seal a large pocket around a foreign
   pin and still pass its no-orphan check. Same main-field criterion
   applied.
3. **8-way escape stubs**: corner pins often have only a diagonal
   DRC-legal escape lane; axis-only stubs walled them. The exact
   legality check is bbox-conservative for diagonals (can reject a
   legal stub, never admits an illegal one).
4. **Second-chance sweep**: after all transactional swaps settle,
   dead candidates get one more direct attempt against the reshaped
   board. This resolved the nG↔hv deadlock: on retry nG needed a
   single sealer rip and swapped in cleanly.

## Result (after)

- **174/174 routed, 0 emission defects, ~44 s** (header previously
  claimed ~170 s; the second-chance sweep costs nothing when unused).
- Terminal snaps relaxed: 2 → 1.
- Differential referee run (same KiCad DRC on both boards):

| Board | DRC violations | Unconnected (signal nets) |
|---|---|---|
| Shipped `rev-a-routed` | 15 (12 edge, 2 clearance, 1 hole) | 24 |
| flroute v4 + stitch/repair | 6 (5 edge, 1 clearance) | 1 (`matrix.sel_ksn-com`) |

  Notes: the harness (strip tracks → route → import) drops the
  reference board's zone-stitching vias, so zone-net (`lv`/coil)
  unconnected items are a harness artifact, excluded above for both.
  Edge-clearance items appear on both boards (12 on shipped) — they
  come from pour-to-edge config, not routing. The one open signal net
  is the single relaxed terminal snap; it's the same class the
  pipeline's `local_reroute`/manual-completion step exists for.

## Small fixes shipped alongside

- `lib/firstlight.ts` seed narrative said "A* + PathFinder …150/174"
  — misdescribed the algorithm and understated the result; updated.
- `scripts/dfm_check.py` default board path pointed at the stale
  `rev-a/rev-a.kicad_pcb`; now the working `rev-a-routed.kicad_pcb`.
- `repair/route.ts` doc comment omitted the `stitch-plane` op.
- flroute header + `docs/prompt-to-pcba.md` metrics brought current.

## Open items (not fixed, prioritized)

1. **No regression harness for flroute** — the biggest structural
   gap. The DSN export → route → import → DRC loop I ran by hand
   should be a committed script with the golden DSN, asserting
   completion=100% and referee deltas. (2444-line zero-dep Rust with
   no tests survives on discipline alone.)
2. `main.rs` is a single 2444-line file — fine for a hot prototype,
   but the stub/negotiation/consolidation/emission stages want
   modules before the next contributor arrives.
3. LLM-written `src/app.rs` firmware degrades silently to BSP-only on
   failure — the run report should carry a visible flag.
4. `erc_check.py` multi-rail check is a placeholder.
5. `place_and_zone.py` is declared as a pipeline stage in the UI but
   deliberately bypassed in the live path (gen_board places variants)
   — either wire it in or relabel the stage.
