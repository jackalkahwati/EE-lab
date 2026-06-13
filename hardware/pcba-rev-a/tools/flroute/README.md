# flroute — FirstLight PCB autorouter (v1)

Drop-in replacement for freerouting in the FL-1 EDA pipeline. Rust, zero
dependencies, headless. Reads a KiCad-exported Specctra DSN, routes with
PathFinder negotiated congestion on a rule-derived grid, emits a Specctra
SES that `pcbnew.ImportSpecctraSES` accepts.

## Rev A benchmark (200x175 mm 4-layer, 180 parts, 174 signal nets)

| | flroute v1 | flroute v0 | freerouting 1.9 |
|---|---|---|---|
| completion | **174/174 (100%)** | 145/174 (83%) | ~93% first pass |
| copper DRC defects | 2 clearance (0.16 vs 0.20 mm) | 0 (at 83%) | 7 (shorts/clearance/dangling) |
| signal nets connected | **174/174** | 145/174 | ~162/174 |
| wall time | ~170 s | 35 s | ~16 min |
| headless | yes | yes | GUI required |

Remaining unconnected items after import are all on the two zone-served
rails (lv on In1/B.Cu, coil rail on In2): SMD pads on F.Cu need stitching
vias to reach the pours. That is pipeline work (`import_route.py`), not a
router defect.

## v1 routing pipeline

1. **Fanout escape stubs** — fine-pitch pads (0.5 mm VSON, 0.65 mm MSOP)
   can be walled in by neighbor pads' clearance halos at cell granularity
   even though a straight outward escape is DRC-legal in exact geometry.
   Emit an exact-coordinate stub wire to the first free cell (legality
   checked against true pad boxes), route from the stub end. Iterated to
   fixpoint; a corridor that would orphan any nearby pin's escape is
   rejected and re-tried in another direction.
2. **PathFinder negotiation** (McMurchie & Ebeling 1995) — soft sharing
   with present-cost (pres_fac x1.25/iter from 1, cap 256) + history
   (+2 per hot cell per iter) penalties; stall detection arms only once
   pres_fac >= 64. Split congestion model: track cells / via rings / via
   centers priced and conflicted separately (legal ring-ring overlap is
   not a conflict).
3. **Hard consolidation** — remaining conflicted nets are ripped all at
   once and re-routed sequentially with sharing disabled, ordered by pin
   pocket tightness (tightest first: once someone's copper bricks up a
   pocket's only exit, that net can never route).
4. **Transactional swaps** — for each still-failed net: BFS its pin
   pockets (pads AND committed copper as walls, layer hops only where a
   via could legally sit; foreign via centers and ring-blocking tracks
   are recorded as rippable sealers), rip the sealers, route the failed
   net alone (re-scanning up to 3 rounds — seals can be layered), then
   route the ripped nets back. Roll back on any failure: the routed
   total is monotone. Nets whose pockets opened up are retried directly.
5. **Emission gate** — only conflict-free nets ship copper; terminal
   points snap the minimum distance toward the pad center that
   guarantees copper overlap (inscribed-shape aware: circle pads don't
   have copper in their bbox corners), never moving tree junctions.

## Architecture / correctness model

- Grid pitch derived from rules: `(width + clearance) * 1.15` — adjacent
  tracks rule-safe by construction.
- Pads rasterized as true rectangles in continuous coordinates (rotation
  of component AND pin applied; grid-snap of obstacle boxes caused
  20-90 um clearance undershoots until rasterization went continuous).
- Vias claim a radius-1 (3x3) neighborhood on all layers; at rule-safe
  pitch this satisfies via-via (0.92 >= 0.8 mm) and via-track spacing.
- Zone-served nets (GND, coil rail: the two largest) are skipped; pours
  own them, matching the freerouting flow.
- 4-layer aware: the board must declare 4 copper layers or KiCad exports
  a 2-layer DSN (this single fix took completion from 150 to 169).
- Validation is differential: KiCad DRC is the referee on every change.

## Usage

```
cargo build --release
./target/release/flroute board.dsn out.ses [--skip-net NAME]...
```

Then in KiCad python: `pcbnew.ImportSpecctraSES(board, "out.ses")`,
fill zones, run `kicad-cli pcb drc`.
