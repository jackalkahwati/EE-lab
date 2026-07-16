# Board-density program

The chip-scale engine historically got fragile around ~14 parts (freerouting
timeouts, residual shorts, hole-clearance breaks — see the chip-scale stress
findings). This document tracks the program to raise that ceiling. Every
routing change gets a **number** from the standing benchmark, not vibes.

## Standing benchmark

```
cd tools/tscircuit
node bench_density.mjs 12 16 20 24        # part counts to test
FL_DENSE_4L=0 node bench_density.mjs 16   # A/B against the pre-2026-07 ladder
```

Generates a parametric synthetic board (MCU + shared-I2C peripherals with
per-IC decoupling) and runs it through `run_board.mjs` exactly as the
pipeline does. Reports routed / DRC / layers / dominant error types / wall
time per size. Record results here when the routing stack changes.

**Read the numbers as RELATIVE, not absolute.** The synthetic netlist is
deliberately adversarial (star buses split into two-point nets on shared
pads), and fails DRC at sizes where real LLM-designed netlists pass — the
same day this baseline was taken, a real 7-part product board passed with 0
errors. The benchmark's value is that the workload is frozen: any routing
change moves these rows, or it didn't do anything.

### Baseline (2026-07-16, quick-wins ladder)

| parts | nets | ok | drcErrors | layers | dominant errors | time |
|---|---|---|---|---|---|---|
| 8  | 13 | ✗ | 59  | 2 | hole_clearance:30 annular:13 via_dia:13 | 55s |
| 12 | 21 | ✗ | 25  | 2 | hole_clearance:24 | 61s |
| 16 | 29 | ✗ | 257 | 4 | hole_clearance:162 annular:43 via_dia:43 | 49s |
| 20 | 37 | ✗ | 310 | 4 | (same signature) | 42s |

The dominant failure is **via geometry / hole clearance** — matching the
original stress findings — which is precisely what the pre-routed-blocks bet
(below) and a via-geometry pass in the DSN export should attack next.

## Shipped quick wins (2026-07-15)

1. **Dense boards skip the 2-layer rung.** Above 10 parts the 2-layer
   freerouting pass is a ~1–2 min near-certain failure; the ladder now opens
   at 4-layer standard for dense boards (`FL_DENSE_4L=0` restores the old
   ladder for A/B).
2. **Roomier final rung before the re-plan.** A `spread placement` strategy
   (bigger gap, wider board, genuine re-place — not a reuse of the tight
   placement) runs before the ladder is exhausted, so a routable-but-tight
   board grows honestly instead of triggering the part-shedding density
   re-plan.

## The structural bet: pre-routed blocks (not yet started)

The compose engine's blocks are pre-**placed** but not pre-**routed**: every
run re-routes each block's internal nets globally, so global routing
complexity grows with total pin count instead of inter-block net count.

Design sketch:

- Each library block ships a **verified internal routing** (tracks + vias in
  block-local coordinates), produced once per block revision by running the
  block in isolation through the full route + DRC gate and freezing the
  result.
- `place()` transposes the frozen copper with the footprints; block-internal
  nets are marked routed before the global pass.
- The global router then handles ONLY inter-block nets (buses, power spine) —
  on a typical composed board that is ~20% of the nets.
- DRC still runs on the whole merged board (frozen copper is re-verified in
  context, never trusted blindly) — the honesty gate is unchanged.
- Catalog-sourced parts (single IC + decoupling) get the same treatment per
  (footprint, binding) pair, cached in the shared registry next to the
  binding.

Expected effect: ceiling moves from ~14 parts toward 40+, because human
layout scales exactly this way — routed modules, then interconnect.

Prerequisite plumbing that already exists: block-local coordinates in
`place()`, the registry for caching, the DRC gate, and this benchmark to
prove the gain.
