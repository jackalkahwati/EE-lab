# flroute — FirstLight PCB autorouter (v0)

Drop-in replacement for freerouting in the FL-1 EDA pipeline. Rust, zero
dependencies, headless. Reads a KiCad-exported Specctra DSN, routes with
multi-source A* on a rule-derived grid, emits a Specctra SES that
`pcbnew.ImportSpecctraSES` accepts.

## Rev A benchmark (200x175 mm, 180 parts, 174 signal nets)

| | flroute v0 | freerouting 1.9 |
|---|---|---|
| completion | 145/174 (83%) | ~93% first pass |
| copper DRC defects | **0** | 7 (shorts/clearance/dangling) |
| wall time | **35 s** | ~16 min |
| headless | yes | GUI required |

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
- Net order: HPWL ascending; failures retried up to 3 rounds.
- Validation is differential: KiCad DRC is the referee on every change.

## Known gaps (v1 roadmap)

- No rip-up & reroute: ~17% of nets fail in claimed corridors. Hybrid
  flow today: flroute bulk pass -> freerouting for the residue. Rip-up
  makes it native.
- Rectilinear only (no 45s); no track-width classes; no length tuning.
- SES import requires the placement echo + library_out via padstack
  (discovered: KiCad's importer silently returns False without them).

## Usage

    cargo build --release
    ./target/release/flroute board.dsn board.ses [--skip-net NAME]...
