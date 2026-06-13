# v0.dev Prompt — FirstLight Prompt-to-PCBA UI

Paste the block below into v0.dev to generate the v0 UI for the
prompt-to-PCBA product (pipeline spec: `docs/prompt-to-pcba.md`).

---

Build a dark, engineering-grade web app called "FirstLight — Prompt to PCBA".
It turns a natural-language hardware request into a fabrication-ready PCB
through a fixed 4-stage pipeline with hard quality gates. Think Vercel
deploy dashboard meets an EDA tool: dense, monospace-friendly, zero
marketing fluff. Desktop-first.

LAYOUT
Three-column app shell:
- Left rail (collapsible, 280px): run history. Each run shows board name,
  timestamp, status pill (RUNNING / PASSED / GATE FAILED), and a tiny
  4-segment progress bar (one segment per stage).
- Center: main work area (described below).
- Right rail (320px): live metrics panel for the selected run.

CENTER — top
A large prompt composer: textarea with placeholder "Describe the board…
e.g. 8x11 relay probe matrix, 4-layer, RP2040 control, USB-C, 24V input"
and a primary button "Generate Board". Below it, the pipeline tracker: a
horizontal stepper with 4 stages, each with a gate badge:

1. Design (atopile) — substep chips: ".ato modules", "parts bound
   (LCSC)", "ato build". Gate: BUILD GREEN.
2. Placement — substep chips: "place_and_zone", "courtyards", "zones".
   Gate: PLACEMENT GATE (overlaps=0, off-board=0, HPWL score).
3. Routing (flroute) — substep chips: "DSN export", "A* + PathFinder",
   "consolidation". Gate: EMISSION GATE (only DRC-clean nets ship).
4. Validation (KiCad referee) — substep chips: "SES import", "zone fill",
   "kicad-cli DRC". Gate: DRC = 0 violations.

Stage states: pending (dim), running (animated pulse + elapsed timer),
passed (green check), gate-failed (red, shows failing rule, pipeline halts
— downstream stages grey out with a "blocked by gate" tooltip).

CENTER — main
Tabbed viewport below the tracker:
- "Board" tab: a board canvas placeholder (dark substrate, copper-amber
  traces) rendered as an SVG mock of a 200x175mm PCB with a grid of relay
  footprints, with layer toggle chips (F.Cu, In1.Cu, In2.Cu, B.Cu) and a
  ratsnest toggle. Overlay badge: "150/174 nets · 0 copper defects".
- "Schematic / Code" tab: read-only code viewer showing .ato modules in a
  file tree (main.ato, power.ato, matrix.ato, protection.ato, mcu.ato,
  cartridge.ato) with syntax-highlighted content pane.
- "BOM" tab: data table — Ref, Part, LCSC #, Qty, Unit $, line type
  (ordered vs buyer-furnished badge). Footer row: "172 components · 29 BOM
  lines · all real parts". Search + CSV export button.
- "Gates & Logs" tab: terminal-style streaming log with stage-colored
  prefixes, plus gate report cards (placement_score.json, dfm_check.json,
  drc.json) rendered as pass/fail checklists with the measured values
  (e.g. "courtyard-to-edge ≥ 3.0mm — PASS, min 3.2mm").

RIGHT RAIL — live metrics
- Routing completion radial: 150/174 nets (86%).
- "0 copper DRC defects" stat with a comparison row: "flroute 35s · 0
  defects" vs muted "freerouting 16min · 7 defects".
- HPWL placement score with sparkline vs previous runs.
- Component count, board size, layer count.
- Artifacts list with download icons: gerbers.zip, bom.csv,
  pick_and_place.csv, board.step, drc.json.

STYLE
Near-black background (#0a0c10), one accent: copper/amber (#e8a33d) for
traces, progress, and primary actions; green/red strictly for gate
pass/fail. Monospace (JetBrains Mono) for refs, net names, logs, metrics;
Inter for UI chrome. Subtle 1px borders, no glassmorphism, no gradients.
Density over whitespace — this is a tool for engineers.

Include realistic seeded data for one completed run ("FL-1 Relay Matrix
Rev A") and one run failing the placement gate ("courtyard overlap:
K12 ↔ K13") so both states are visible. Make the prompt composer →
pipeline animation work with simulated stage timing (atopile 4s,
placement 6s, routing 35s with net counter ticking up, validation 8s).
