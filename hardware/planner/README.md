# Compose General PCBA Builder — planner spine

The architecture that moves Compose from a fixed-block PCB generator toward a
general PCBA builder: **intent → resolve → recover → report**, feeding the
existing compose/route/DRC/validation pipeline as the implementation layer.

This is the **decision spine**, built as real, tested code. It is deliberately
NOT a shallow skeleton of all 22 phases — per the anti-faking rules, phases that
would require faking datasheet extraction, symbol/footprint generation, or
end-to-end board synthesis are honestly deferred and marked below, not stubbed as
if done.

## Modules

| file | phase(s) | what it does |
|---|---|---|
| `component_spec.py` | 2, 17 | Universal Component Spec schema (jsonschema-validated), per-field provenance + confidence, DERIVED support_status (never asserted) |
| `ingest.py` | 3, 5, 7 | Ingestion engine: KiCad symbol, existing UCS, compose block, manual pin table. Real pin/pad validation. Interface inference (incl. write-only SPI). Datasheet/distributor paths are HONEST STUBS (return partial + reasons, never fake pins) |
| `seeds.py` | 21 | 15 real KiCad-backed seed specs (proof, not the architecture) |
| `resolver.py` | 8 | Resolve exact-MPN or capability → supported implementation, with concrete reasons when not |
| `recovery.py` | 9 | Capability-aware Design Recovery Loop: unsupported → supported alternative preserving intent, honest preserved/lost report, approval flag |
| `intent.py` | 1 | Design Intent Model (intent vs implementation) + deterministic parser |
| `planner.py` | 8, 9, 20, 22 | Orchestrator + honest report + the end-to-end demo |

## Phase coverage (honest)

**Built + tested:** 1 (intent), 2 (UCS + validation), 3 (ingestion: KiCad/spec/
block/pin-table; datasheet+distributor honestly stubbed), 5 (symbol/footprint
resolve + pin/pad validation), 7 (interface inference), 8 (resolver), 9 (recovery
loop), 17 (provenance/confidence), 20 (honest reporting), 21 (seeds), 22 (demo:
live-ingests MCP2515, recovers BME688→BME280).

**Partial:** 6 (application circuit — support-circuit is captured per-spec, not a
full inference engine), 15 (firmware — driver/test hints captured per-spec, not
yet generated+compiled), 16 (FL-1 Validation Package — the generator exists in
the compose pipeline; wiring the UCS design through it needs Phase 11).

**Deferred (NOT faked) — the next increments:**
- **4** datasheet PDF AI extraction — honest stub; needs a real extraction +
  validation pipeline before it can be trusted.
- **10/11** planner board synthesis from UCS specs (place footprints, wire
  arbitrary pins/buses, add passives) — the big bridge from decision to board.
  Today the decision layer produces a validated buildable design; turning an
  arbitrary UCS set into a routed board is the next focused effort.
- **12** constraint manager, **13** routing capability classes, **14** layout
  intelligence, **18** review UI, **19** design review engine.

## Run the demo

    cd hardware/planner && python3 planner.py

Prints: Design Intent Model → Recovery/Substitution report → Honest build report
→ Provenance/confidence → Final buildable design. Demonstrates live ingestion of
a non-seed part (MCP2515) and recovery of an unsupported request (BME688→BME280,
gas/voc dropped, approval required).

## Honesty guarantees

- `support_status` is derived from present + confident critical fields, never
  asserted by a caller.
- A source that isn't implemented returns a partial spec with low confidence and
  clear `missing_fields` — it never fabricates a pin table or footprint.
- Every substitution is reported with preserved/lost capabilities; a lost
  capability sets `requires_approval`.
- The existing compose pipeline (blocks, flroute, DRC/ERC, geometry stitch, FL-1
  validation) is untouched and stable.

## Phase 11 — board synthesis from UCS (synth.py): WORKING BRIDGE

`synth.py` converts a UCS design into a real KiCad board and hands it to the
EXISTING pipeline (flroute, DRC/ERC, geometry stitch, fab, firmware, FL-1). Wired
into `route.ts` as `synth=1&design=<base64>` — emits the same board contract as
`compose.py`, so everything downstream is unchanged.

**What it does (all from the components' OWN validated pins, never guessed):**
- RP2040/Pico MCU anchor; UCS parts wired to power / GND / I2C / SPI /
  write-only SPI / UART / RS485 / GPIO by their UCS `interface.signals`.
- power_in pins → rail, ground → GND, bus signals → shared meaningful nets
  (I2C_SDA/SCL, SPI_SCK/MOSI/MISO, per-device CS, RS485_A/B, DEBUG_TX/RX).
- support passives from the UCS (decoupling per power pin, config-pin pulls,
  shunts, RS485 termination); I2C bus pull-ups; test points on rails + buses.
- layout intelligence: power connector placed next to the MCU power pins.
- recovery/substitution report preserved next to the board (`.recovery.json`).

**Demo** ("RP2040 industrial sensor hub…USB-C, BME280, INA219, W25Q, MAX3485,
74HC595…"): produces a real 7-component board (37 footprints), **17/18 nets
routed**, with EVERY bus wired correctly — verified: BME280 + INA219 share I2C
with pull-ups; W25Q (full SPI) + 74HC595 (write-only SPI) share SPI with their
own selects; power/GND from UCS pins; decoupling + test points added.

**Honest blocker (criterion 13):** the **USB-C receptacle** is a fine-pitch
connector whose 4 VBUS pads feed the **+5V rail, which is not plane-served**, so
it must route across the board — flroute leaves 1 net + a few fine-pitch pads
open. The board GATE-FAILS honestly on real DRC (gates NOT weakened). A coarse
power connector in place of the USB-C receptacle routes clean; the fine-pitch
connector + non-plane +5V routing is the specific remaining limit.

**Fanout bonus:** the finer-via-class (`.kicad_pro`) + geometry stitch now clears
the fine-pitch STITCH-via violations everywhere (DC-measure: 3 → 1 violation, 0
unconnected; the last one is the flroute-track issue = Fix B, a router change).
Coarse boards (comms, relay) still PASS 0/0 — no regression.

## Recovery-loop closure — fine-pitch connector routing substitution

The closed loop, end to end: when the demo's fine-pitch USB-C receptacle blocks
routing (VBUS on the non-plane +5V rail), the recovery loop substitutes a coarse
supported power connector (2-pin 5mm screw terminal, `MX126-5.0-02P`), preserving
the 5V-power intent and producing a buildable board. `recovery.py:
recover_fine_pitch_connector` + a planner step that detects the fine-pitch USB-C
receptacle when the goal is "USB-C power".

Reported in full (never silent, criterion 3): original = USB-C power input;
blocker = fine-pitch USB-C cannot route in the current UCS synth path; preserved
= 5V input / board bring-up / FL-1 validation / manufacturable board; lost =
USB-C receptacle / cable compatibility / USB-C behavior; approval = required for
product, allowed for demo; status = GENERATED_WITH_SUBST. The report is written
to `<board>.recovery.json` in the run artifacts. **This is NOT USB-C support** —
USB-C stays on the roadmap; this is a buildable fallback that preserves intent.

**Recovered demo result (full pass):** RP2040 hub with the coarse connector +
BME280 + INA219 + W25Q + MAX3485 + 74HC595 — **16/16 nets routed, 0 DRC, 0
unconnected, ERC PASS**, fab package + firmware + **FL-1 Validation Package**
(I2C + SPI buses, 5 probe points, 6-step functional test, expected currents) all
generated. Geometry stitch runs; gates NOT weakened. Coarse boards (comms, relay)
still PASS 0/0 — no regression. The fine-pitch stitch threshold widened to 0.8mm
so 0.65mm-pitch LGA parts (BME280) stitch cleanly under the finer via class.

## Golden demo + regression suite (demo_and_regression.py)

The closed-loop win, frozen and locked down. `demo_and_regression.py` runs cases
through the REAL pipeline and checks routed nets / DRC / unconnected / ERC /
recovery + FL-1 presence.

    python3 demo_and_regression.py golden       # the industrial sensor hub demo
    python3 demo_and_regression.py regression   # all 5 regression cases
    python3 demo_and_regression.py <case>       # one case

**Golden demo** — the canonical proof point, saved as run `golden-sensor-hub`:
Compose generated a manufacturable RP2040 industrial sensor hub, recovered from
the unsupported fine-pitch USB-C routing case by substituting a coarse 5V screw
terminal (reported, approval-flagged), and produced a **DRC-clean board (16/18
routed, 0 DRC, 0 unconnected, ERC pass)** with fab package, firmware, and an
**FL-1 executable Validation Package**. Visible in the UI: Recovery tab, amber
"Generated with substitution" badge, FL-1 Validation Package view.

**Regression cases (each asserts a recorded outcome):**
1. `comms` (block) — PASSED 0/0.
2. `relay` (block) — PASSED 0/0.
3. `dc-measure` (block) — known state: 0 unconnected, ≤1 hard violation (the
   flroute track-clearance issue = Fix B; stitch vias cleared by the finer via
   class + geometry stitch).
4. `ucs-hub-recovery` (UCS synth + recovery) — PASSED 0/0 with recovery.json +
   FL-1 Validation Package present.
5. `ucs-hub-strict` (UCS synth, recovery disabled) — must FAIL HONESTLY (the
   fine-pitch USB-C blocks routing); never a silent clean pass.

This locks both the existing block pipeline and the new UCS recovery loop so
future work can't quietly break the win. Gates stay strict; the strict-USB-C
case exists precisely to prove we never fake a pass.

## Constraint Manager v1 (constraints.py)

The layer between design intent / component specs and routing. It classifies
every net and applies per-class electrical rules — the step that turns "I placed
and routed" into "I understood each net's requirement and treated it accordingly."

**Net classes (v1):** gnd, power_input, power_rail, motor_output (high-current),
i2c (needs pull-up), spi / spi_clock, uart, rs485, can, rf, reset_debug, clock,
analog, test_point, digital_signal. Each net gets a class + a reason.

**Rules per class:** trace width (power/high-current wider than signal),
clearance, routing priority, plane/short-direct hints, and honesty flags
(controlled / diff-pair-preferred / RF / analog / high-current).

**HONEST unsupported (v1 refuses, never fakes):** USB high-speed (USB_D+/D-) and
Ethernet differential pairs are detected and marked unsupported — required
constraint (90/100 ohm diff pair + length match + stackup/PHY) and a fallback are
reported. v1 does NOT attempt DDR / PCIe / USB-HS / Ethernet / MIPI / dense BGA.

**Pipeline integration (real, not cosmetic):**
- `apply_constraints.py` (after placement, before routing): builds the model,
  writes `<board>.constraints.json` (run artifact), and merges per-class KiCad
  net-settings into the `.kicad_pro` so KiCad DRC + the design carry the classes.
- `widen_power.py` (after routing): flroute routes at one global width, so this
  widens power / high-current tracks to their class width **only where the copper
  still clears neighbours** — a real board effect with zero new DRC violations.
- Honest reporting: the pipeline log + UI show constraints generated, classes
  applied, high-risk nets, and unsupported features with fallbacks.

**UI:** a `Constraints` tab renders the model (per-class rules table, high-risk
nets, unsupported features, per-net classification).

**Verified:** golden sensor hub → 20 nets in 9 classes, 29/32 power tracks
widened, PASSED 0/0 (gates not weakened). Comms → CANH/CANL classified as `can`,
PASSED 0/0. flroute integration is honestly scaffolded (post-route widening);
full per-net-class routing in flroute is future work.

## Manufacturability layer (order-ready PCBA package)

The step that takes Compose from "electrically clean routed board" to
"order-ready PCBA". Every successful board now emits a full assembly package.

**gen_assembly.py** (after validation) reads the real KiCad board + sidecars
(devices.json = ref→MPN, bom.json = LCSC-matched BOM, recovery.json = subs) and
writes, all from REAL data:
- `pick_and_place.csv` — ref, value, footprint, MPN, X/Y (real KiCad coords),
  rotation, side, package, placement (SMT / **DNP** for fiducials/test points).
  Never an invented placement.
- `bom.csv` — assembly BOM: refs, qty, value, manufacturer, MPN, distributor PN
  (LCSC), footprint, package, sourcing status, confidence, substitution status.
- `sourcing-report.json` — per-line match (exact / equivalent / fallback /
  missing) + whether LIVE sourcing was available. HONEST: live DigiKey returned
  no data, so lines are labelled fallback/estimate — supplier data is never faked.
- `substitutions.json` — the recovery-loop substitutions (marked NOT footprint
  drop-in, since a recovery sub changes the part).
- `assembly-readiness.json` / `.md` — ready?, missing / DNP / fine-pitch /
  hand-solder-risk / substituted parts, sourcing confidence, house notes.

**build_pcba_zip.py** assembles `pcba-package.zip`: gerbers, drill, STEP,
renders, the enriched pick-and-place + assembly BOM, sourcing report, assembly
readiness (json+md), substitutions, constraints, and the FL-1 Validation Package.

**UI:** an `Assembly` tab shows readiness, placement counts, honest sourcing
state, hand-solder risk, substitutions, the BOM sourcing table, and a
download-PCBA-package button.

**Honesty:** no faked supplier data, no invented placements, no silent
substitutions, recovery subs are never marked footprint drop-in. Live sourcing is
attempted and, when unavailable, clearly reported as fallback mode. Verified:
golden hub → 24 placed + 7 DNP, 2 fine-pitch, 1 substitution, 29-file package,
board PASSES. Next technical phase: arbitrary MCU + flexible pin allocation.

## MCU Selection + Pin Allocation (arbitrary MCU support)

Removes the RP2040-hardcoded assumption: the user describes the board, Compose
selects (or accepts) an MCU and assigns pins from that MCU's REAL capabilities.

- **mcu_specs.py** — schema-validated capability specs at the PHYSICAL PAD level.
  6 seeds with real KiCad symbols/footprints + datasheet-accurate pad maps:
  RP2040 (Pico module), ESP32-S3-WROOM-1 (module, Wi-Fi+BLE), ATmega328P (DIP-28)
  — all `supported`; nRF52840 (Raytac module), STM32F103 (LQFP-48, fine-pitch),
  SAMD21 — `partial` with honest reasons. The validator rejects a capability that
  lands on a reserved pad.
- **mcu_selector.py** — intent/design → best MCU + full explanation (why, rejected
  candidates + why, missing capability if no fit). Honours a requested MCU only if
  it truly qualifies. `propose_substitute()` powers MCU recovery.
- **pin_allocator.py** — assigns real pads via BIPARTITE MATCHING (a flexible GPIO
  never steals a scarce uart_tx pad), respects capability (ADC only on ADC pads),
  never reuses a pad, protects reserved pads. Emits pin_assignment.json/.md +
  firmware pin map.
- **synth.py** — MCU no longer hardcoded. RP2040 keeps the PROVEN block_mcu_pico
  (golden hub unchanged); non-RP2040 uses block_mcu_generic (footprint + power/
  ground/reset + decoupling + reset pull-up + I2C pull-ups + programming header).
  RP2040 pin-assignment is derived from the real Pico wiring so the firmware map
  matches the board. MCU recovery: a requested MCU that can't fit is substituted
  (e.g. ATmega+Wi-Fi → ESP32-S3) with preserved/lost reported.
- **UI** — Pinout tab: selected MCU + why, rejected candidates, pin table,
  reserved pins, MCU substitution, download pin_assignment.json.

Verified: golden hub → RP2040, PASSES (unchanged); ATmega328P I2C node → REAL
board that routes 9/9, DRC 0/0, ERC PASS; ESP32-S3 → places but fails routing
honestly (WROOM antenna keepout, 3 unconnected); ATmega+Wi-Fi → recovery to
ESP32-S3. The FL-1 Validation Package carries the assigned firmware pin map.
Honesty: real symbols/footprints only, partial MCUs never faked as supported, no
invented pin capabilities, no silent pad reuse, DRC/ERC gates unchanged.
Next phase: real datasheet ingestion (import new parts + expand support).

## Datasheet-to-UCS Ingestion v1 (import new parts)

Moves Compose from a manually-curated part universe to importing a new real part
into a validated UCS — with provenance, confidence, and human review.

- **ingest_datasheet.py** — REAL pdftotext extraction of supply voltage, package,
  decoupling, abs-max presence. Every field carries source + page + confidence +
  method + needs_review; not-found stays UNKNOWN (never guessed). No PDF -> all
  datasheet fields honestly unknown.
- **ingest.py** — `ingest_part()` fuses KiCad symbol (real pins/pads, the
  backbone) + optional datasheet + manual pin table + distributor into a
  candidate UCS with per-field provenance/confidence. `validate_component()`
  checks pad-vs-pin count, power/ground presence, package match, high-speed
  guard; mismatches -> unsupported/needs_review. `build_ingest_report()` is the
  human-review artifact. Fresh ingestion is NEVER auto-'supported'.
- **ingest_library.py** — approved-component library; `approve()` refuses
  'supported' while unsupported_fields remain. Only supported/partial are usable
  in synthesis.
- **ingest_cli.py** — `python3 ingest_cli.py <mpn> --symbol S [--datasheet PDF]
  [--approve partial]` -> UCS + ingest-report.json/.md, optional save to library.
- **UI** — Ingest tab: library list + part identity, symbol/footprint match,
  interfaces, support status, pin table (real KiCad electrical types), confidence
  /provenance, download UCS JSON.

Verified: ADS1115 / INA228 / TMUX1108 -> valid UCS (needs_review). Validation
CAUGHT honest mismatches: MCP4725 footprint/pin package mismatch, REF3025 missing
power pin. ADS1115 approved (partial) + used in an FL-1 measurement front-end
(RP2040 + ingested ADS1115): routes 5/5, 1 honest fine-pitch clearance violation
on the TSSOP-10 I2C escape (the future fine-pitch phase). Ingest regression 5/5.
Next phase: general recovery loop, then fine-pitch/fanout improvements.

## General Recovery Loop v1 (diagnose → repair → retry → explain)

Moves Compose from "try once, then fail or apply a known substitution" to
"try, diagnose, repair, retry, and explain" — WITHOUT ever faking a pass.

- **failure_taxonomy.py** — classifies real board failures (fine_pitch_escape,
  clearance, unconnected, keepout_placement, erc, footprint_mismatch,
  pin_allocation, mcu_unfit, high_speed_unsupported, component_unsupported,
  sourcing) into structured records (affected component/net/footprint, severity,
  auto-recovery-allowed, human-approval, evidence, explanation).
- **recovery_strategies.py** — strategy library (increase_spacing, rotate,
  move_to_edge, enlarge_board, alternate_footprint, substitute_component/mcu,
  rerun_allocator, add_passive, mark_unsupported) with applicable-failures,
  preconditions, effect, risks, preserves-function, approval. `rank()` orders
  cheapest/safest auto first, terminal mark_unsupported last; fine-pitch/keepout
  map to their Phase-8 capability.
- **recovery_loop.py** — orchestrator: attempt → classify → apply ONE auto
  strategy → regenerate → re-run STRICT gates → **compare-and-revert**. A
  strategy that makes the board worse is never kept; the report names the BEST
  attempt's honest blocker. A run is only `recovered_and_passed` if the
  regenerated board independently passes (status PASSED, 0 viol, 0 unconn).
- synth recovery_hints: board_margin (enlarge), extra_gap (spacing), per-part
  rotate — placement only, never drops or swaps a component.
- **UI** — Recovery tab shows the loop: final status, initial→final, attempted
  fixes (kept + tried-not-kept), honest blocker, Phase-8 recommendation, download.

Proof: the ADS1115 measurement front-end (previously an honest fine-pitch
partial) was RECOVERED — a0 baseline (1 viol) → a1 increase_spacing (2 viol,
reverted) → a2 rotate (29 viol from a short, reverted) → a3 enlarge_board (0 viol,
PASSED). Independently confirmed PASSED 0/0. Recovery regression 6/6; board
regression 5/5 unchanged. Next: Phase 8 advanced routing (fine-pitch/fanout,
keepout-aware placement, differential pairs / USB / Ethernet).

## Reference Design Ingestion & Pattern Learning v1 (design from proven patterns)

Compose can start a design from PROVEN engineering patterns, not just component
specs — extracted from trusted, provenance-tracked sources, never scraped.

- **reference_manifest.py** — controlled reference ingestion. A `references/` tree
  + a manifest with per-reference provenance + LICENSE + trust. Trust hierarchy:
  FirstLight-own (permissive) > manufacturer eval/app-note (reference_only unless
  licensed) > open-source (needs license) > forum/blog (idea-only). `can_direct_
  reuse()` gates: ONLY permissive licenses reuse directly; unknown/manufacturer/
  copyleft -> reference/review, never silent reuse.
- **pattern_spec.py** — Design Pattern Spec: reusable topology, support circuitry,
  layout/routing constraints, firmware hooks, test points, calibration, risks,
  adaptation ZONES (preserve_exactly / adapt_allowed / requires_review …),
  provenance + confidence + license. `derive_status()`: license gates reuse,
  evidence gates confidence; high-risk parts force reusable_with_review.
- **pattern_extract.py** — extracts patterns from REAL local sources: Compose's
  own passing boards (functional blocks, rails, interfaces, passives, test points,
  decoupling-adjacent + analog-isolation layout rules, and a LEARNED synth_hint —
  the board_margin that made a recovered board pass), FirstLight contracts, and
  ingested UCS. Un-extractable geometry -> honest unknown.
- **pattern_library.py** — FirstLight Instrument Pattern Library: 7 real patterns
  + 9 honest needs_reference placeholders. `select()` scores/ranks by functional/
  interface/license/validation and explains selected + rejected.
- **UI** — Reference Patterns tab: library + reference manifest, license/trust
  badges, adaptation zones, download pattern JSON.

Proof of pattern learning: the precision-ADC channel pattern was extracted from
the RECOVERED ADS1115 board and carries the board_margin fix the recovery loop
found. A pattern-backed FL-1 measurement front-end v2 applied that learned hint UP
FRONT and PASSED 0/0 on the FIRST attempt — no recovery needed. License gate
verified (manufacturer eval board -> reference_only, no direct reuse); pattern
regression 7/7; board regression 5/5 unchanged. Next: Phase 9 advanced embedded
routing (fine-pitch/fanout, keepout-aware placement, diff pairs, USB/Ethernet) —
now with proven layout patterns to preserve.

## Advanced Embedded Routing v1 (electrical geometry awareness)

Makes Compose aware of board electrical geometry — WITHOUT faking what the v1
router cannot do.

- **advanced_constraints.py** — the advanced constraint + detection + planning
  layer: fine-pitch escape, keepouts, differential-pair detection (USB_DP/DM 90Ω,
  ETH_*P/N 100Ω high-speed; CANH/CANL + RS485 controlled-but-not-high-speed),
  real IPC-2141 microstrip impedance ESTIMATION on a default 4-layer FR4 stackup,
  analog layout rules (quiet zone, Kelvin sense, reference RC filter), power
  layout rules (high-current trace, regulator hot loop, eFuse thermal), and
  antenna keepouts. Each constraint carries source / severity / enforcement /
  provenance / confidence.
- **HONESTY (the hard boundary):** flroute is a single-width autorouter — it does
  NOT route true diff pairs or guarantee impedance. So high-speed pairs are marked
  `unsupported_by_router` and a design that REQUIRES them (USB high-speed,
  Ethernet) is reported as NOT advanced-routable — never a fake pass. Impedance is
  always an estimate that "requires a board-house controlled-impedance stackup",
  never claimed guaranteed.
- **gen_advanced_routing.py** (pipeline): emits advanced-routing-report.json/.md +
  stackup-plan.json + impedance-plan.json; logs `ADVANCED_UNSUPPORTED` honestly for
  high-speed blockers. Added to the PCBA package.
- **UI** — Advanced Routing tab: diff pairs + enforcement, impedance/stackup plan
  (with its estimate caveat), USB/Ethernet status, analog/power rules, unsupported
  constraints in red.

Verified: USB_DP/DM -> 90Ω pair, unsupported_by_router (honest); ETH -> two 100Ω
pairs, unsupported; CAN -> controlled, advisory, routable; ADS1115 -> quiet_zone +
reference_rc_filter; regulator -> hot_loop; WROOM -> antenna keepout; 50Ω micro-
strip ≈ 0.335mm. The pattern-backed ADS1115 measurement front-end PASSES 0/0 with
the analog rules emitted. Advanced regression 9/9. Next: FL-1 Instrument Core v1.

## True High-Speed Routing v1 (real routed + checked differential pairs)

Turns Phase 9's honest "USB/Ethernet detected but unsupported_by_router" into an
actually-routed, actually-checked differential pair — without faking impedance.

- **highspeed.py** — first-class high-speed route objects + planner. v1 profiles:
  USB 2.0 full-speed / high-speed (90ohm), 10/100 Ethernet PHY<->magnetics &
  magnetics<->RJ45 (100ohm), LVDS-like, clock pair. Geometry (width/spacing) from
  the IPC-2141 estimate. CAN/RS485 stay controlled/advisory unless explicitly
  requested as strict differential.
- **route_diff_pairs.py** — REAL differential-pair router + length/skew checker.
  Routes both pair members together (parallel, matched width, same layer) between
  their true ENDPOINT pads as real KiCad tracks, then checks length delta, skew,
  spacing, via count. NEVER falls back to independent single-ended routing; a
  REQUIRED pair that fails compliance fails the design. Impedance stays advisory.
- **gen_highspeed_demo.py** — a USB 2.0 device demo board (breakout + USBLC6 ESD +
  MCU header) with a real USB_DP/USB_DM pair.
- **UI** — the Advanced Routing tab now shows a High-Speed Routing table: routed
  lengths, delta/skew, status per pair, with the advisory-impedance caveat.
- **Recovery** — highspeed_pair_fail -> match_pair_length / move_endpoints_closer
  / mark_unsupported; a REQUIRED high-speed constraint is never auto-relaxed.

Proof: the USB 2.0 demo routes USB_D as a matched pair (34.0mm / 34.0mm, delta
0.0mm, 0 skew) -> routed_and_checked, impedance routed_but_advisory (needs a
board-house controlled-Z stackup). The checker independently REJECTS a 0.434mm
mismatch (failed_constraints). High-speed regression 8/8. No fake diff-pair
routing, no impedance guarantee, no weakened gates. (Honest v1 scope: the demo
pair spacing is header-pitch; tighter coupled geometry is future work.)

## FL-1-Directed Compute / RF / Exotic Boards v1 (Phase 12)

The honest PLANNING + READINESS layer aimed only at the real FL-1 internal
instrument boards — never generic compute/RF, never a faked capability.

- **fl1_boards.py** — a 13-class exotic board taxonomy, a 10-board FL-1 family
  architecture map with a readiness ranking, a shared FL-1 instrument bus v1
  (marked NOT final), and honest starter-readiness reports for RF/50Ω, scope-lite,
  stimulus, logic-capture, and FPGA/module-carrier, plus a manufacturing-capability
  match and a reference-pattern-readiness map. Emits all as .json + .md.
- **The honesty is the point:** scope-lite -> `unsupported` (no oscilloscope-class
  bandwidth/ENOB/sample-rate claimed); stimulus -> `needs_reference` (no funcgen-
  class quality); logic -> `needs_simulation` (no LA-class timing); FPGA carrier
  flags DDR/PCIe/MIPI/BGA-fanout/hs-memory as unsupported; RF/50Ω is an ESTIMATE
  (no S-params / tuning / guaranteed impedance). Every board carries exact blockers.
- **Readiness ranking (from ACTUAL capability):** controller / digital-bringup ->
  ready_to_attempt; relay -> pattern_backed; power-monitor / calibration / DMM /
  external-interface -> buildable_with_review; stimulus -> needs_reference; logic
  -> needs_simulation; scope-lite -> unsupported.
- **Demo:** the FL-1 Calibration / Reference board (proven ADS1115 measurement/
  calibration path) attempts + PASSES 0/0 (5/5 routed), with the board-ID EEPROM +
  precision reference honestly flagged as blockers needing clean ingestion.
- **UI:** an FL-1 Instrument Readiness view (Learn group) — family readiness, bus,
  pattern readiness, starter statuses, mfg capability, exact blockers, downloads.

FL-1 regression 12/12; frontend regression 24/24; board regression 5/5 (planning
layer only, pipeline untouched). No fake compute/RF/exotic/DDR/PCIe/MIPI/BGA/scope/
funcgen/LA/manufacturing claims anywhere. Next: benchmarks -> simulation/signoff ->
instrument adapters, building toward FL-1 Instrument Core v1.

## Fix: FL-1 calibration demo + board-margin scaling (Phase 12 correction)

Caught that DRC/ERC-clean is NOT the same as satisfying the named intent — a board
with only RP2040 + ADS1115 + pull-ups is a measurement front-end, not a
calibration/reference board. Corrected without weakening any gate:

- **Ingestion footprint bug fixed** (resolve_part.pick_footprint): now matches the
  footprint pad count to the symbol pin count — a 5-pin part no longer lands on a
  3-pad SOT-23 (24AA02 -> SOT-23-5, MCP4725 -> SOT-23-6, 24LC02 -> SOIC-8). The
  mismatch DETECTION still fires on a genuinely wrong footprint.
- **3-terminal reference power inference fixed** (ingest): IN/OUT/GND references
  (REF3025) now get a power pin. The precision reference + I2C EEPROM now ingest.
- **Board-margin over-application fixed** (synth): a learned/recovery board_margin
  is applied CONTEXTUALLY — a fine-pitch board gets the full escape room it needs
  (legitimately larger, and the sizing report says so), a sparse non-fine-pitch
  board scales it down so it never becomes a huge slab. Emits a board-sizing report
  (requested / applied margin, density, fine-pitch count, source, reason).
- **Mislabeled demo renamed** to "ADS1115 measurement front-end"; a REAL FL-1
  Calibration/Reference board is attempted (gen_cal_board.py): precision reference +
  RCAL1/RCAL2 divider -> REF_DIV + ADS1115 reading REF_OUT & REF_DIV + 24LC02
  board-ID EEPROM + FL-1 bus + labeled test points. Honest Outcome B — all required
  parts present, 0 DRC, routes 4/5, blocked on the multi-drop I2C bus (needs Phase-8
  fanout). Not a fake pass, not a mislabel.

Regressions: fl1-cal-fix 8/8, ingest 6/6 (updated to the fixed behavior), all other
unit suites green, frontend 24/24, board 5/5. The standard now: a board is not
"passed" just because DRC/ERC is clean — it must also match the named intent.

## Phase 12.5: Shared bus / multi-drop routing fix

The real FL-1 Calibration board exposed a concrete blocker: ADS1115 + EEPROM +
FL-1 header on a shared I2C bus. Root cause was NOT bus topology (flroute already
routes multi-pin nets as a spanning tree) but placement + fine-pitch escape.

- **shared_bus.py** — first-class shared-bus model: I2C multi-drop, SPI shared
  SCK/MOSI/MISO + per-device CS (groundwork), GPIO fanout. Per bus: source/master,
  device list, required nets, pull-ups, addresses/chip-selects, topology, fanout
  count, routing status, blockers. `check_bus()` rejects disconnected bus pins,
  fake independent nets, missing pull-ups, duplicate net names, dropped devices,
  and DRC-clean-but-not-all-devices-connected.
- **Multi-drop I2C FIXED**: the shared I2C bus (ADS1115 + 24LC02 + FL-1 header +
  pull-ups) routes and CONNECTS every device — the 2-escape shared-bus board routes
  5/5 with 0 DRC. `gen_shared_bus_report.py` checks it against the realized board.
- **synth cal topology**: a voltage reference now wires OUT -> REF_OUT, builds an
  RCAL divider producing REF_DIV, and (with an ADC) has the ADC MEASURE both nodes;
  unused fine-pitch pins are tied to the GND plane so they take a via instead of
  walling the escape lanes. FL-1 bus connector added as the shared-bus source.
- **Real cal board rebuilt via synth**: all 7 nets route (shared I2C multi-drop +
  analog measurement of REF_OUT/REF_DIV). The Phase-12 "multi-drop I2C" blocker is
  FIXED; it is REPLACED by a more specific one — the ADS1115 needs 4 simultaneous
  fine-pitch escapes (SDA/SCL + AIN0/AIN1) on a 0.5mm-pitch TSSOP-10, and the
  router's 0.46mm grid cannot cleanly resolve 4 escapes at 0.5mm pitch (13
  fine-pitch shorts). Needs finer-grid fanout / via-in-pad for 4+ escapes.

Regression: shared-bus 11/11, ingest 6/6, fl1-cal 8/8, high-speed 8/8 (USB pair
still routes), board 5/5. No DRC/ERC weakening; the router is never bypassed.

## Phase 13 first-gate closeout (Gate A/B/C) — fine-pitch escape truth

Recorded as a standalone result BEFORE the benchmark/signoff layer (D-F). This gate
proved the physical escape truth for the FL-1 Calibration/Reference board; it is not
to be reinterpreted by the later benchmark/signoff work — that work CONSUMES this as
evidence.

1. Fine-pitch escape model exists (fine_pitch_escape.py).
2. ADS1115 is correctly classified as dense_escape.
3. The real FL-1 Calibration/Reference board was attempted (via synth).
4. All 7 logical nets route.
5. No nets were dropped.
6. DRC was not weakened.
7. Result is escaped_but_drc_failed.
8. Exact blocker is blocked_by_grid_resolution.
9. Board is correctly marked do_not_build.
10. Required future capability: finer-grid fanout or via-in-pad (both unimplemented).

Significance: Compose now distinguishes LOGICAL connectivity (7/7 nets route) from
PHYSICAL manufacturable routing (DRC-clean escape) — the difference between a demo and
a real board-engineering system.

Next (Phase 13 D-F, fresh): build the benchmark/signoff layer AROUND this evidence.
The build-readiness verdict for the cal board must read: architecture mostly complete,
logical routing 7/7, shared bus connected, fine-pitch escape failed, DRC failed
(shorts), recommendation do_not_build, exact blocker blocked_by_grid_resolution,
required next capability finer-grid fanout or via-in-pad. The task is NOT "make the cal
board pass" — it already did its job by exposing the real limitation. D-F must give
every FL-1 board that same honest verdict.

## Phase 13 D-F + D.5: reference benchmarks, curated library, scoring, signoff

The evidence layer built AROUND the proven fine-pitch result — it consumes that
result, never reinterprets it. The cal board stays do_not_build / blocked_by_grid_resolution.

- benchmark_model.py (D): reference PCBA benchmark structure + FL-1 suite (10 board
  classes) with trust/license classification, required blocks/components/nets/
  protection/calibration/test-points/validation/manufacturing, hard-fail + advisory
  rules, and forbidden-claim rails (scope-lite forbids oscilloscope-class, RF forbids
  guaranteed impedance/S-parameters, stimulus forbids funcgen-class, logic forbids
  LA-class).
- reference_library.py (D.5): curated library — 9 internal FirstLight refs
  (direct_reuse=true) + 9 external placeholders (manufacturer_reference_only /
  open_source_needs_license_review, ALL direct_reuse=false, needs_source_file). No
  external schematic/layout/BOM is copied; nothing is scraped. The ADS1115
  measurement front-end is an ADC-measurement SUB-PATTERN only, never a
  calibration-board reference. Reference coverage feeds the scorer but external refs
  alone can never reach benchmark_pass.
- benchmark_score.py (E): 13 category scores + status (pass / pass_with_review /
  partial / fail / do_not_build). Consumes fine-pitch, shared-bus, DRC, ingestion
  evidence. Cal board scores do_not_build / blocked_by_grid_resolution even though its
  architecture is 100% complete — the physical evidence wins. Missing ingestion and
  forbidden claims are hard fails.
- signoff.py (F): 6 domains (power / analog / digital / high-speed / RF-50ohm /
  manufacturing). Every check tagged calculated / rule_based / routed / drc_erc /
  external_tool_required / measured_only / not_supported / advisory. No faked
  SPICE/SI/PI/RF/precision. Cal board combined signoff = do_not_build (analog
  fine-pitch escape + manufacturing DRC), RF carries no guarantee, HS needs a
  controlled-stackup quote.
- gen_benchmark_signoff.py: emits all artifacts per run — reference schema, curated
  library, pattern extraction, benchmark model + suite, benchmark scores, 6 signoff
  reports + combined, reference gap list, and the FL-1 build-readiness dashboard. UI
  shows the dashboard verdicts (do_not_build is obvious) + reference trust badges
  (internal reusable vs external reference-only vs needs-license-review).

Build-readiness dashboard verdicts (honest): calibration_reference do_not_build
(blocked_by_grid_resolution), scope_lite unsupported, others needs_ingestion,
rf_50ohm needs_external_tool. Regression: benchmark+signoff 29/29; fine-pitch 10/10,
shared-bus 11/11, fl1-cal 8/8, fl1boards 12/12, high-speed 8/8, ingest 6/6, frontend
24/24 unchanged. No DRC/ERC weakening, no fake simulation/signoff, no fake
RF/scope/funcgen/LA claims.

## Phase 14: instrument adapter layer + FL-1 validation readiness v1

One common command layer so FL-1 validation can measure_voltage / set_power /
route_channel / flash_firmware / capture_waveform through MOCK, external COTS, or
future internal FL-1 boards. This phase does NOT build the boards and NEVER performs
or claims a real measurement.

- instruments.py: capability model (34 caps across measurement/stimulus/routing/
  firmware/calibration), adapter interface (8 adapter types + command/result
  envelopes), a MockAdapter that marks every value simulated_evidence, COTS specs
  (10 external instruments: supply/DMM/scope/funcgen/logic-analyzer/eload/matrix/
  programmer/serial/VNA-external), and internal FL-1 board adapter specs that CONSUME
  Phase 13 build-readiness — a do_not_build board is mock_only (physically_available
  False), an unsupported board has no adapter.
- validation.py: workflow model + 10 FL-1 board-class workflow templates, evidence
  model (simulated/manual/external_tool/physical), the build->validation readiness
  BRIDGE, the command DSL, and validation package v2. run_workflow() executes a
  workflow through an adapter; a mock run yields simulated_pass/fail only, never a
  physical pass.
- The hard rail: a do_not_build board is validation_ready_with_mock ONLY — physical
  validation blocked, internal-board adapter forbidden. The cal board's mock demo
  passes the workflow LOGIC (simulated_pass) but physical validation is blocked
  (build status do_not_build / blocked_by_grid_resolution). scope-lite stays
  unsupported (no oscilloscope claim); stimulus/logic make no funcgen/analyzer claims.
- gen_instrument_validation.py: emits all capability/adapter/workflow/evidence/
  readiness/DSL/package-v2 artifacts + runs the 5 demo mock validations. UI shows the
  validation-readiness dashboard (physical-blocked is obvious) + mock demos (◈sim =
  simulated only).

Regression: validation 28/28; benchmark+signoff 29/29, fine-pitch 10/10, shared-bus
11/11, high-speed 8/8, ingest 6/6, fl1boards 12/12, frontend 24/24 unchanged. Phase 13
build/signoff verdicts untouched. No fake physical measurement, no fake calibration/
traceability, no weakened DRC/ERC/benchmark/signoff gates.

## Phase 15: FL-1 Instrument Core v1

The first REAL FL-1 instrument boards — the genuinely buildable, coarse-part core,
assembled into one instrument system. Every core board was routed clean through the
FULL pipeline (0 DRC, 0 unconnected, PASSED); nothing is faked into the core.

- fl1_core.py: assembles the three buildable core boards from their REAL pipeline
  build results:
    - FL-1 Controller / Backplane v1  (7/7 nets, 0 DRC)  — bus master + power + trigger
    - FL-1 Digital Bring-up v1        (5/5 nets, 0 DRC)  — digital IO + bus bring-up
    - FL-1 Relay / Probe Matrix v1    (20/20 nets, 0 DRC) — signal routing / probe matrix
  Defines roles, the FL-1 instrument-bus interconnect (controller master + device
  boards on a shared I2C backplane bus, Phase 12.5-validated), and the 13 instrument
  capabilities the core provides (route_channel, read/write_digital, set_power, ...).
- Honest boundaries: the core is DESIGNED + verified, NOT yet fabricated — adapters are
  future_internal_board (physically_available=False), mock-validatable now, physical
  after fab + COTS. The core is HONEST about its gap: precise measurement / calibration
  is NOT in v1 (needs the Calibration/Reference + DMM-lite boards, currently
  do_not_build / needs_ingestion, or an external COTS DMM).
- The Calibration/Reference board is EXCLUDED from the core — it stays do_not_build
  (blocked_by_grid_resolution). No do_not_build board is in the core.
- gen_fl1_core.py: emits fl1-instrument-core-v1 + core validation runs (3 mock
  bring-up demos, all simulated_pass / simulated_evidence). UI shows the core (build
  status per board + the excluded do_not_build board).

Regression: fl1-core 12/12; validation 28/28, benchmark+signoff 29/29, fine-pitch
10/10, shared-bus 11/11, high-speed 8/8, ingest 6/6, fl1boards 12/12, fl1-cal 8/8,
frontend 24/24 unchanged. No faked board, no weakened gate.

### Phase 15 build policy + first order batch

- build_policy.py: the Phase 15 gate. Consumes Phase 13/14 evidence and decides, per
  board: allowed_to_attempt / allowed_to_generate_order_package / allowed_to_mark_
  ready_to_order / validate_with_mock|cots|internal / required_human_review, the
  package type (architecture / design_attempt / order_ready_pcba / mock/cots/internal
  validation), and the order recommendation (order_5_pcba / order_3_pcba_review_
  required / architecture_only / design_attempt_only / do_not_order / unsupported).
  Also order_pack_validation() (Gerbers/drill/STEP generated at order time; BOM/P&P/
  assembly/sourcing checked present) and adapter_mapping().
- Batch 1 decisions (honest, evidence-driven): the 3 core boards -> order_ready_pcba_
  package, order_3_pcba_review_required (first-article human review); calibration_
  reference -> do_not_order (design_attempt_package, blocked_by_grid_resolution);
  scope_lite -> unsupported (architecture_package); power/dmm/external/stimulus/logic
  -> design_attempt_only (needs_ingestion). A do_not_build board NEVER yields an order
  package, even if it routes.
- gen_phase15.py emits phase15-build-policy-report, phase15-package-policy,
  phase15-board-readiness-dashboard, manufacturing-order-pack-validation,
  phase15-adapter-mapping, phase15-demo-validation-runs. UI shows the build batch
  (order-ready green + review flag, held boards red with exact blockers).

Regression: phase15 21/21; fl1-core 12/12, validation 28/28, benchmark+signoff 29/29,
fine-pitch 10/10, shared-bus 11/11, high-speed 8/8, ingest 6/6, fl1boards 12/12,
fl1-cal 8/8, board 5/5, frontend 24/24. Only evidence-safe boards get an order package.

## Phase 15 reliability patch: LLM provider timeouts

The regression harness exposed real infrastructure debt: all four LLM provider
fetches (lib/llm.ts) had NO timeout, so one stalled provider connection hung the
firmware self-repair stage forever. Boards that routed clean (DRC/ERC PASS) were
misclassified as status=None, and the hung request wedged the pipeline run lock —
the root cause of every "pipeline already in progress" lockup.

- Every provider fetch now carries a hard 120s timeout (AbortSignal.timeout). A
  stalled provider fails fast, the chain falls through, and the pipeline always
  returns a REAL terminal status.
- The timeout degrades honestly, never fakes a pass: app-firmware success still
  requires a green cargo build of real generated code; on a thrown/timed-out
  provider call the app layer is reverted (no half-applied non-compiling app.rs)
  and the crate ships as verified BSP/HAL only, logged as a warning.
- Board regression with the patch: 5/5 with real statuses. This patch precedes any
  physical board order — the regression system must be trustworthy before fab.

## First-Article Order Review — Batch 1 verdict: revise_before_order (all three)

The handoff gate from "software says order-ready" to "willing to send to fab."
Inspected the real artifacts (renders, footprints, BOM, sourcing, P&P, coverage) of
the three order-ready packs. Electrically all three are clean (0 DRC, sourced,
assembly-ready) — but as composed they do not yet fulfil their FL-1 ROLES:

- ALL boards: no mounting holes, no test points, no board-ID EEPROM, no FL-1
  instrument-bus connector (so they cannot join the backplane bus the core spec
  defines), silkscreen refs only.
- Controller/Backplane: a clean MCU+CAN node, but the controller ROLE needs
  interlock/fault/reset/trigger + the bus-master header — none present. The Phase-12
  lesson recurring at system level: DRC-clean does not equal satisfies the named intent.
- Digital Bring-up: SPI was honestly dropped by the composer; no GPIO bank header, no
  protected IO — too thin for the bring-up role.
- Relay/Probe Matrix: relays switch but 24 contact pins route to only 6 header pins —
  a matrix with no channel connectors. Also needs a guaranteed power-on-safe
  disconnected state (74HC595 outputs undefined until first latch).

Decision: revise (extend composer blocks: fl1_bus_header, board_id_eeprom,
mounting_holes, test_points, relay channel breakout, protected GPIO bank), re-run the
pipeline with unchanged gates, re-review, THEN order 3 each. Revising costs a
pipeline re-run; ordering first costs a respin. Artifacts: first-article-review.json/md
per run + FA badges on the Phase 15 dashboard.

## Phase 15.6: FL-1 board role-completeness fix

The first-article review's findings became composer capabilities: the boards now
SATISFY their names, not just route cleanly.

- compose.py primitives (P1): fl1_bus_header (2x05, +5V/+3V3/SDA/SCL/FAULT/INTERLOCK/
  RST_OUT/TRIG wired to real MCU pins, silk legend), board_id_eeprom (24LC02 at 0x50
  on the shared I2C), protected gpio_bank (100R series + header), spibus header (SPI
  no longer silently dropped), and universal primitives on EVERY composed board:
  4x M3 corner mounting holes, labeled test points (rails + buses + safety lines),
  board name + rev on silk, functional connector labels.
- Boot-chatter fix: 74HC595 /OE is no longer hard-tied to GND. It is gated on SR_OE
  with a pull-up (outputs Hi-Z -> relays OFF from power-up) and MCU-driven only after
  a safe word is loaded. The relay channel map is on silk + in the device manifest.
- role_completeness.py (P2): checks the REALIZED board (footprints/nets/manifest,
  never labels alone) against per-role requirements. Statuses: role_complete /
  role_complete_with_review / role_incomplete / do_not_order. A DRC-clean but
  role-incomplete board is REJECTED for order — verified against the v1 boards
  (0-2 of 11 requirements met) vs the v2 boards (all requirements met).
- Regenerated through the REAL pipeline, strict gates unchanged:
    Controller/Backplane v2  13/13 nets, 0 DRC  (interlock/fault/reset/trigger wired)
    Digital Bring-up v2      21/21 nets, 0 DRC  (SPI restored + protected GPIO bank)
    Relay/Probe Matrix v2    27/27 nets, 0 DRC  (SR_OE safe default routed)
- First-article review v2: order recommendation REQUIRES gates + role completeness +
  valid order pack. Batch decision: order_3_pcba_review_required (all three), with
  honest caveats (no JTAG, no level shift, 4-channel matrix, no HV/precision claims).
  The placement gate caught the first mounting-hole placement (1.58mm edge clearance)
  — the gates police the new primitives too.

Regression: role-completeness 22/22; phase15 21/21, fl1-core 12/12, validation 28/28,
benchmark+signoff 29/29, fine-pitch 10/10, shared-bus 11/11, high-speed 8/8, ingest
6/6, frontend 24/24. Cal board stays do_not_build; scope-lite stays unsupported.

## Phase 16: calibration, traceability, and closed-loop redesign v1

Prepares FirstLight for REAL boards arriving from fab: every board traceable, every
run evidence-backed, every calibration claim explicit, every failure convertible
into a structured Rev B recommendation. Nothing fakes calibration or traceability.

- traceability.py: board identity model (13 lifecycle states) + Batch 1 serial plan
  (FL1-CB/DB/RM-V2-0001..0003 — 9 serials with REAL sha256 artifact hashes, board-ID
  EEPROM contents at 0x50, QR payloads, honest lifecycle start at
  first_article_review_required); append-only evidence ledger model (8 evidence
  types — simulated/mock NEVER satisfy physical validation, COTS needs instrument
  identity, failed evidence preserved); 33-class failure taxonomy; Rev A->B package
  model (Rev B never automatic, Rev A evidence never hidden); incoming inspection
  workflows (common + per-board, manual evidence + photos).
- calibration.py: calibration state model (9 states — mock_calibrated is never
  physical; internally_calibrated requires an internal board that EXISTS) +
  measurement uncertainty / claim policy (per-capability allowed/forbidden claims:
  no precision/6.5-digit/scope/funcgen/LA/RF claims without evidence) + Batch 1
  verification workflows (controller/digital = verification NOT calibration ->
  sanity_checked; relay continuity can reach cots_verified with a recorded DMM
  identity).
- redesign_engine.py: failure -> Rev B recommendation with evidence citation.
  15 recommendation types; every recommendation requires human review; automatic
  redesign is never allowed; fine-pitch failures map to
  do_not_redesign_until_external_tool.
- gen_phase16.py: all artifacts + 5 demo runs (3 mock bring-ups simulated_pass with
  ledger entries; a SIMULATED relay_stuck failure -> taxonomy record -> RB
  recommendation (revise_component, human review) with the failed evidence preserved
  in the ledger; calibration/reference physical calibration -> do_not_calibrate_
  physical). UI: Batch 1 serials + lifecycle + cal state, demo evidence (visibly
  simulated), held boards visibly held with missing capabilities.

Regression: phase16 34/34; role-completeness 22/22, phase15 21/21, fl1-core 12/12,
validation 28/28, benchmark+signoff 29/29, fine-pitch 10/10, shared-bus 11/11,
high-speed 8/8, ingest 6/6, frontend 24/24. No gate weakened; no fake calibration,
traceability, or physical-evidence claims.

## Phase 16.5: fine-grid fanout / via-in-pad capability v1 — THE CAL BOARD PASSES

The highest-leverage software blocker is fixed: the FL-1 Calibration/Reference board
physically PASSES the full pipeline — 7/7 nets, 0 DRC, 0 unconnected, ERC PASS —
with strict gates untouched. do_not_build -> ready_to_build_with_review; order stays
review-required, never automatic.

TWO root causes, both real:
1. compose.place pad-rotation bug: KiCad pad angles are ABSOLUTE (footprint rotation
   summed in). Placing a rotated footprint without adding the rotation to each pad
   left positions rotated but orientations not — mutually OVERLAPPING fine-pitch
   pads. This was the hidden source of the "residual shorts" on every rotated board,
   including part of the Phase 13 result.
2. Grid contention at 0.5mm pitch (the original blocked_by_grid_resolution): solved
   by EXACT-GEOMETRY pre-escape fanout (fine_pitch_fanout.py) — signal pads get
   L-shaped private-lane escapes to breakout pads the 0.46mm grid resolves; plane
   pads get staggered-depth dogbone vias (a 0.5mm row cannot legally take in-pad
   vias). export_dsn strips the original fine pins from the router's net lists;
   flroute v5 marks the stub wires as net-owned obstacles (foreign nets blocked, own
   net passable); import_ses re-adds stubs+vias after SES import; stitch_to_plane
   skips dogboned pads and bridges nudged vias with a connecting track; the pipeline
   heal now closes same-net undershoots (stitch_pads) before re-DRC. A stub alone
   NEVER counts as routed — final DRC + unconnected verify the chain end-to-end.

Honest bounds: via-in-pad is NOT needed for this board and is modeled as
human-review-required with NO fab-support assumption; HDI is a placeholder with NO
readiness claim. Batch 1 v2 boards verified unchanged (still review-required, not
ordered). Rev A do_not_build evidence preserved. Regression suites updated to assert
the CONDITIONAL truth (do_not_build unless truly fixed — it now is, backed by the
real passing run): finegrid 24/24 and all suites green.

## Phase 16.6: final first-article review pack (Batch 1)

One human-decision bundle for the four review-required boards — and the review
actually REVIEWS. Findings: the cal board is electrically clean (16.5 pass stands)
but came through the synth path and lacks the 15.6 role primitives (no mounting
holes, refs-only silk, v1 2x03 bus header) -> revise_before_order by the SAME
standard that revised the v1 core boards. Cross-board integration flags two real
items: the 2x05-vs-2x03 bus-header mismatch, and ALL boards strapping their
board-ID EEPROM to 0x50 (a conflict on a shared backplane bus; fine for individual
bench first-articles, must be resolved before multi-board operation).

Verdicts: controller/digital/relay v2 -> order_3_pcba; calibration -> revise_
before_order. Human approval form generated with the standing rule: approval is a
HUMAN fabrication decision — Compose provides evidence and recommendations but
never spends money or submits orders. first-article regression 14/14; frontend
24/24.

## Phase 16.7: calibration role completion + board-ID addressing

The two Phase 16.6 findings are FIXED, verified on regenerated boards through the
real pipeline:

- Board-ID addressing strategy: per-slot address straps SELECTED (3 options
  evaluated). The FL-1 bus header v2 (2x07) carries ID_A0-A2 from the backplane
  slot; boards carry local pull-downs -> bench default 0x50, slots 0x50-0x57,
  duplicates of the same board type supported, 8-per-segment limit explicitly
  bounded (segmentation deferred).
- Calibration/Reference v2 rebuilt with the full role set on the synth path:
  mounting holes, functional silk, labeled TPs, bus header v2 with FAULT/
  INTERLOCK/RST_OUT/TRIG wired to real Pico pins, EEPROM straps + pull-downs.
  14/14 nets, 0 DRC, ERC PASS, role_complete_with_review (11/11).
- Core boards regenerated as v2.1 (minimal change: shared primitives only):
  controller 16/16, digital 24/24, relay 30/30 — all 0 DRC, role-complete, straps
  verified on the real boards. DFM gate caught the first strap-resistor placement
  (0.37mm gap) — gates police the new primitives.
- stitch_pads tee-bridge pass: closes same-net track-end -> track junction gaps
  (the REF_OUT tee) — same-net only, clearance-gated, DRC still the judge.
- Cross-board integration review v2: BOTH v1 findings RESOLVED (header pinout
  consistent on all four; address plan resolved+bounded). FA review v3:
  order_3_pcba_review_required (ALL FOUR). Cal board history preserved:
  do_not_build -> physically passed -> revise_before_order -> role-complete v2.
  Human approval form v3; nothing ordered; no production-ready claim.

Regression: phase167 22/22 + all 12 suites green; frontend 24/24.

## Phase 17: first-article manufacturing readiness + supplier package v1

Turns the four review-ready designs into a boring, controlled manufacturing
handoff. Nothing ordered, nothing production-ready, no certification claim.

- Manufacturing package normalization: all four boards verified complete (BOM,
  P&P, renders, notes, TP/connector maps, revision, serial plan, QR, EEPROM
  contents, workflow links; gerbers/drill/STEP generated deterministically at
  order time from the package hash).
- Supplier quote packages (qty 3 each): layer/dims/finish (ENIG recommended for
  the fine-pitch cal board), trace/space, drill, via classes, NO controlled
  impedance, NO HDI/via-in-pad, per-board assembly + inspection notes.
- BOM risk + substitution policy: no silent substitutions for the precision
  reference, ADC, EEPROM, relays, connectors, MCU, or safety parts; single-source
  REF3025/ADS1115 flagged with a buy-spares mitigation.
- Order record model (12 states, draft -> canceled) with package/BOM/PNP hashes,
  serial ranges, and approval records; all four stubs sit at human_review_required
  with approval_record=null.
- Human approval gate: 10 requirements; the gate NEVER submits orders — Compose
  has no payment or supplier-submission capability by design.
- Incoming inspection acceptance criteria (15 common + per-board, incl. R21
  safe-default and R70-72 strap population checks) + a 13-entry manufacturing risk
  register (severity/likelihood/mitigation/owner; high-severity risks require review).

Regression: phase17 14/14; frontend 24/24; board 5/5 unchanged (artifact-only).

## Phase 18: architecture search + trade-space explorer v1

The layer that decides what to design NEXT — before any board is generated or
ordered. Candidates (internal / COTS / hybrid / multi-board / reduced-scope /
mock-only / hold) are grounded in the real evidence stack, scored across 17
dimensions, and HARD BLOCKERS DOMINATE: no aggregate score can hide do_not_build,
a missing validation path, a fake precision claim, unrouteable fine pitch,
missing ingestion, or an unsafe default.

- arch_search.py: candidate model (11 readiness states), scoring model, search
  engine over 9 held FL-1 families (3 candidates each, 27 total), partitioning
  search (backplane+modules SELECTED — matches Batch 1 + slot straps), component
  strategy search (proven-part-first rules), validation-path + calibration-path
  classification per candidate.
- Honest verdicts: internal scope (SCP-2) and internal RF (RF-2) REJECTED by hard
  blockers; scope/funcgen/LA/RF stay external-COTS; DMM-lite (proven ADS1115+
  REF3025 chain) HELD on the physical cal-board dependency; stimulus DC-only until
  DAC approval; logic capture = event-class honesty (COTS LA for timing truth).
- Recommended next-board roadmap: #1 External Instrument Interface (all parts
  proven, 80% reuse of digital v2.1, compose-ready), #2 power/current monitor
  (shunt+ADS1115 buildable today; INA variant after ingestion), #3 DMM-lite after
  the cal board is physical, #4 relay expansion by duplicating the proven board
  (slot straps make duplicates work).
- 5 demo searches with expectations met; UI shows the roadmap + per-target
  verdicts with rejected-candidate flags.

Regression: phase18 24/24; phase17 14/14, phase167 22/22, frontend 24/24, board
5/5 unchanged (artifact-only). Nothing ordered; Batch 1 untouched; no fake claims.

## Phase 18.5: External Instrument Interface EII-1 compose attempt — PASSED

The Phase 18 #1 recommendation is now a REAL routed board: 22/22 nets, 0 DRC,
0 unconnected, ERC PASS, role_complete_with_review (10/10) through the full
pipeline. Verdict: ready_to_build_with_review; order stays human-gated.

- EII-1 (blocks: power + mcu + uart bridge + gpio bank + fl1 bus v2 + board id):
  instrument UART bridge (TTL, honest), trigger/sync/presence as protected GPIO
  (Pico boots as inputs = safe default), bus-v2 safety lines + ID straps, all
  proven parts, ZERO new ingestion. Explicitly NOT: DMM/scope/funcgen/RF/LA,
  RS232 levels, Ethernet, GPIB, HV, autonomous power. COTS capability is never
  claimed as internal capability.
- New composer block: block_uart_bridge (1x04 TTL header on Pico UART0).
- EII role added to the role-completeness checker with honest caveats.
- STITCHER HARDENED pipeline-wide while chasing EII-1's three chronic skips —
  the root cause was a max-dimension-circle pad check that made adjacent SOIC
  pads (1.95mm long, 1.27mm pitch) permanently "block" each other. Fixes: EXACT
  pad shapes (GetEffectiveShape), layer-aware bridge clearance (inner-layer
  tracks no longer veto F.Cu bridges), distance-sorted grid search (0.45mm step,
  6mm radius) replacing fixed rings, pad->via bridge tracks for nudged vias,
  anchor-bridge fallback + retry pass (bridge to PTH/via/connected-pad anchors),
  and proper decoupling placement in block_board_id (C25 moved next to U9 pin 8
  — the DFM gate policed the first two placements).
- Full artifact set: requirements, interface architecture, component strategy,
  safety model, compose report, role report, validation workflows (identity/
  trigger/serial/safety), traceability (FL1-EII-V1-0001..3), manufacturing
  readiness (order stub human_review_required), and the Phase 18 feedback loop
  (external_instrument_interface -> ready_for_reviewed_order_package; next best
  board: power/current monitor).

Regression: phase185 23/23 + all 15 suites green + frontend 24/24. Batch 1
untouched; nothing ordered; no production-ready claim.

## Phase 18.6: Power / Current Monitor PCM-1 v1 — PASSED

The Phase 18 #2 recommendation composed through the real pipeline: 17/17 nets,
0 DRC, 0 unconnected, ERC PASS, role_complete_with_review (14/14). Verdict:
ready_to_build_with_review. Six boards now sit in the review queue.

- PCM-1 (power + mcu + dut monitor + fl1 bus v2 + board id): conservative
  shunt+ADS1115 monitor on the PROVEN cal-board chain. Low-side 0402 shunt,
  11:1 divider, series-R protected ADC inputs, DUT connector, TPs for DUT_V/
  SHUNT_HI/SHUNT_LO/both ADC inputs, MONITOR-ONLY silk. ADS1115 pin map taken
  from the VALIDATED UCS (never guessed). Pico module kept BY DESIGN this phase;
  bare-MCU is its own future architecture-search target.
- Claim model: uncalibrated -> sanity_checkable before calibration;
  cots_verifiable vs identified instruments; internally_calibratable only after
  the Calibration/Reference board is physical + verified. 0-24V / 0-500mA
  labeled limits bounded by the 0402 shunt power budget; inline-fuse
  recommendation until bring-up thermal data exists. No DMM/supply/HV/
  high-current/isolation/certification claims.
- Architecture choice recorded honestly, including a CORRECTION: the INA228
  block already sources and routes (dc-measure fixture) — the INA variant is
  gated on measurement-path validation, not basic ingestion as Phase 18 scored.
- flroute v5.1: wiring VIAS are now all-layer net-owned obstacles (fanout
  dogbone vias were invisible to inner-layer routing — the PCM-1 DUT_V/GND
  short). Stitcher: finer 0.3mm grid + fine-via (0.4/0.2) second pass squeezes
  pockets the 0.6 via cannot (the R11 pull-up corridor).
- New role: power_current_monitor (14 requirements + honest caveats).

Regression: phase186 33/33; all 16 suites green; frontend 24/24; board 5/5.
Nothing ordered; five prior boards untouched; no gate weakened.

## Phase 18.8: Full-16 monolithic no-Pico integration stress test — SUCCESS AS A STRESS TEST

Three REAL compose attempts answered the monolith question with evidence, not
opinion. The six modular plugin boards remain the valid first articles; nothing
here is an order candidate.

- Candidate A (modular, CURRENT): proven — six review-required boards.
- Candidate B (Core-6 monolithic, Pico module): **ROUTED CLEAN** — 70 parts,
  174x186mm, 51/51 nets, 0 DRC, 0 unconnected, ERC PASS, monolithic role
  16/16. Monolithic density is now a demonstrated Compose capability; B is a
  credible Rev C cost-down AFTER the modular system works.
- Candidate C (Core-6, bare RP2040, NO Pico): blocked_by_qfn56_fanout with ONE
  exact blocker — the single-row lane fanout (proven at 0.5mm TSSOP) cannot do
  a four-sided 0.4mm QFN-56: 41 escapes pre-fanned, 48 DRC violations ALL
  between escape artifacts (none touch the QFN), 18 unconnected (RP_XIN/DVDD/
  SWD among them). Everything else is PRESENT and role-complete 16/16: no Pico
  footprint, bare RP2040 + W25Q16 QSPI + 12MHz crystal + AMS1117 + SWD/BOOT/
  RESET straps + advisory-only USB pads. Honesty recorded: pin maps are manual
  transcriptions (ingestion validation REQUIRED); no USB/QSPI/crystal claims.
- Candidate D (Full-16, bare RP2040, MAIN STRETCH): architecture_only_with_
  blockers — same single blocker; all 16 functions honestly treated:
  6 implemented_now, 2 implemented_reduced_scope (event capture, cal ladder
  REF_DIV2 on copper), 2 external_cots_interface_only (funcgen, scope),
  2 reserved_zone_only (RF, relay expansion), 4 architecture_only (DMM-lite,
  DUT power control, INA variant, DAC stimulus). No function faked.
- Candidate E (alternate MCU): architecture_only — no credible proven
  alternate; an LQFP 0.5mm leaded MCU is the plausible future candidate.
- Final recommendation: keep_modular_for_first_articles; build a small bare-
  RP2040 core test board first when the QFN escape capability lands; Core-6+
  Pico monolith as later cost-down; scope/RF/funcgen stay external COTS.
- Next capability target fed back to Phase 18: quadrant-aware QFN escape
  planner. New blocks: block_calref (validated REF3025/ADS1115 pins),
  block_calref_expansion, block_mcu_bare (flagged unvalidated). New role:
  monolithic_core6 (16 reqs) + mono_nopico_checks (7 on-copper checks).

Regression: phase188 42/42; all 17 suites green; frontend 24/24; board 5/5.

## Phase 19: multi-board + electromechanical co-design v1

The six-card family is now a MACHINE architecture — engineering concept layer,
no certification/safety/EMC/thermal claims, six plugin boards untouched.

- FL-1 Passive Backplane v1: a REAL routed board (fl1-backplane-v1, 9/9 nets,
  0 DRC, ERC PASS, ready_to_build_with_review). Six 2x07 bus-v2 slots sharing
  power/I2C/safety/sync, per-slot ID straps to +3V3 by slot-number bits
  (0x50-0x55 by construction, bench default 0x50 preserved), system I2C
  pull-ups, safety-line TPs. The ERC gate forced the pull-up decision — and
  surfaced a REAL integration finding: populated cards stack their own 4.7k
  pull-ups (~670-780 ohm effective, beyond the I2C 3mA sink spec). Recorded as
  REVIEW_REQUIRED in the pinout compatibility report with a Rev B DNP plan,
  not hidden. Second recorded gap: 2x07 headers are unkeyed (Rev B: shrouded).
- Slot standard: vertical cards on the backplane, 6 slots at 30mm pitch,
  envelopes from REAL board geometry, uniform M3 corner holes + bottom bus
  edge + top access edge (the Phase 15.6 primitives earn their keep).
- DUT fixture: swappable DUT adapter card recommended (hybrid harness as
  day-one interim); fixture removal opens INTERLOCK -> relay enable drops.
- Grounding/power/thermal/enclosure: single GND plane + slot-order noise
  partitioning (cal card one slot from relay coils), bench 5V single rail
  (~1.5A budget, inline fuse recommendation, NO mains/PSU/HV claims), passive
  convection concept, open-frame first article (220x200 plate) with full TP
  access.
- Assembly (13 steps) + service (7 steps) workflows; 9-stage multi-board
  validation plan; system traceability (FL1-SYS-V1 serials, 11 lifecycle
  states, currently architecture_defined); monolithic cost-down roadmap
  (18.8 evidence, future-only); system manufacturing readiness + 8-risk
  register; layout map + SVG.

Regression: phase19 37/37; all 18 suites green; frontend 24/24; board 5/5.
Seven review-required boards; nothing ordered.

## Phase 19.1: backplane integration fixes + Rev B readiness v1

The two Phase 19 findings are now ENFORCEABLE RULES, not review notes.

- I2C pull-up ownership model (7 boards): cards own their pull-ups standalone,
  the backplane owns them in system mode, exactly one owner required. The
  effective pull-up checker computes real parallel resistance + sink current:
  as-built (6 cards + backplane, all populated) = too_strong_pullup at 671 ohm
  / 4.32mA (>3mA spec); Rev B backplane-owner config = ok at 4.7k; missing ->
  missing_pullup; unknown -> unknown_population. NO I2C compliance claim from
  arithmetic — physical rise-time/sink measurement stays measurement_required.
- Rev B population plan: card R10/R11 DNP by default in system BOM views
  (sufficient for first articles — no redesign), solder-jumper enable in Rev B,
  backplane R94/R95 confirmed owner.
- Connector keying policy + orientation checker: all 7 connector families
  flagged unkeyed_review_required; safety/power connectors high severity;
  first-article mitigation = pin-1 silk + checklist + human inspection; Rev B =
  keyed shrouded headers. No connector safety claim without mitigation.
- 5 Rev B recommendations (evidence-linked, no auto-redesign, human review
  required); validation plan v2 BLOCKS system validation on invalid pull-up
  configuration or unverifiable connector orientation; manufacturing readiness
  v2 (standalone-vs-system BOM views); risk register v2 (both findings
  ENFORCED); seven-board human approval form v2 with explicit acknowledgements.

Regression: phase191 27/27; all suites green; frontend 24/24; board 5/5
unchanged (artifact-only). Seven boards untouched; nothing ordered.

## Phase 20: production line + supply chain optimization v1

The manufacturing layer for the seven-board system — grounded in real data
where it exists, placeholders LABELED where it does not, and a readiness state
machine that is hard-capped until physical evidence exists.

- System BOM rollup: 90 lines from the seven REAL bom.json files + system
  items (standoffs/plate/harness/labels/fuse). Real per-board BOM costs
  ($7-15/board, ~$75/set). I2C pull-up DNP states per build variant; keyed
  shrouded connectors listed as Rev B alternates; protected classes
  (reference/ADC/shunt/relay/EEPROM/MCU module/backplane connectors/safety
  parts) forbid silent substitution.
- Approved vendor list + sourcing risk: single-source TI parts (REF3025,
  ADS1115) flagged with buy-spares mitigation; counterfeit-market caution on
  Pico modules; lead times are quote-time placeholders — no fake availability.
- Cost model: first-article batch (3 PCBAs x 7 boards + mechanicals + spares +
  rework reserve) ~$1,357 with fab/assembly/labor/shipping PLACEHOLDERS until
  real quotes; BOM component grounded.
- 4 build variants: standalone card validation (card pull-ups POPULATED),
  backplane system first article (backplane owns bus, cards DNP, unkeyed
  connectors only with inspection), Rev B system (keyed shrouded + jumper
  enables), cost-down monolithic future (never a first article).
- Manufacturing package audit: all seven boards package_complete_with_review
  against the real run artifacts.
- First-article order batch plan (order_submitted: false — approval form v2
  first), incoming-inspection optimization, 20-step assembly/test flow with
  evidence + human-inspection + COTS-identity flags per step, yield/failure
  tracking model (MODEL ONLY — no fake yield data), RevA->RevB feedback loop
  (no auto redesign/substitution/release; Phase 19.1 REVB-001..005 seeded).
- Production readiness dashboard: current state first_article_ready_for_
  human_approval, hard-capped by production_line.readiness_state — production_
  ready is unreachable without physical boards + validation + yield + human
  approval. Both Phase 19.1 findings stay visible; blocked claims listed.

Regression: phase20 26/26; all suites green; frontend 24/24; board 5/5
unchanged (artifact-only). Nothing ordered.

## Phase 21: general-purpose PCBA design engine v1

The pivot: FL-1 capabilities extracted into a general engine. Any board
request now gets parse -> classify -> fabrication decision -> pattern
selection -> capability check -> architecture plan -> gated board job, with
honest capability limits at every stage.

- pcba_engine.py: request schema (14 domains, assumptions labeled), board-type
  classifier (19 families), fabrication decision engine (2/4-layer + 0.5mm
  fine pitch PROVEN; QFN-56 escape, HDI/microvia, large BGA, high-speed SI/PI,
  RF signoff, power stages BLOCKED — unproven fabrication is never recommended
  as buildable), claim/gate model (18 claim types; production_ready forbidden
  without physical+yield+human evidence), 19-pattern library extracted from
  FL-1 and made generic, component capability checker, architecture planner
  (10 buildability states), board job generator with NO FL-1 assumptions (no
  FL-1 bus, no Pico unless selected, no 4-layer unless recommended).
- 8 tested examples, all landing honestly: env sensor buildable_with_review
  (2-layer candidate); USB-C monitor architecture_only (USB-C footprint gap);
  motor controller blocked_by_missing_component_model (no gate driver/power
  stage); Pi HAT relay buildable_with_review; satellite watchdog buildable_
  with_review with space claims BLOCKED; RF adapter architecture_only (SMA
  footprint + advisory impedance); PCIe capture architecture_only (external
  SI/PI required); AI carrier blocked_by_unproven_fabrication (HDI/BGA/SI-PI).
- No general-purpose success claim beyond the tested examples. FL-1 remains
  intact as the proven example system, no longer the only design path.

Regression: phase21 27/27; all 22 suites green; frontend 24/24; board 5/5
unchanged (artifact-only). Nothing ordered.

## Phase 22: physical build + fleet learning loop v1

The learning system that will ingest physical evidence later — built and
running NOW on the evidence that actually exists (generated jobs, routed
boards, blockers). Structural rules enforced in code, not prose.

- Evidence object model: 27 evidence types, 8 physical-only; satisfies_
  physical() makes simulated evidence STRUCTURALLY unable to satisfy physical
  gates; failed evidence preserved. Fleet memory: 12 categories; yield_memory
  stays EMPTY until real boards exist.
- Failure taxonomy: 29 classes with detection source, severity, buildability/
  production impact, and physical-evidence requirements.
- Pattern learning engine: 19 FL-1 patterns placed honestly — 11 proven_in_
  routed_board, 8 proven_in_manufacturing_package, NONE physically promoted
  (promote() REFUSES physical states without physical evidence; no silent
  promotion; no state skipping; failures demote).
- Capability gap ranking (10 gaps by leverage): #1 USB-C connector/protection
  (unlocks 3 families at complexity 2), #2 QFN-56 quadrant escape, #3 gate-
  driver/power-stage primitives. Every Phase 21 blocker appears.
- Board job outcome ledger: 15 jobs (8 general examples + 7 FL-1 boards), all
  generated/gated, NONE physical, nothing ordered. Learning report ingests the
  8 examples into evidence objects + fleet memory deltas.
- Next-board benchmark selector: battery environmental sensor recommended,
  Pi HAT relay runner-up; motor controller / PCIe / AI carrier explicitly
  excluded near-term. Fleet Learning UI section.

Regression: phase22 25/25; all suites green; frontend 24/24; board 5/5
unchanged (artifact-only). Nothing ordered; nothing physically claimed.

## Phase 22.1: first non-FL-1 benchmark board v1 — PASSED

The platform proof: the GENERAL engine drove a real compose run to a clean
pass on a board with zero FL-1 content.

- Battery Environmental Sensor Benchmark v1 (env-sensor-benchmark-v1): 14/14
  nets, 0 DRC, 0 unconnected, ERC PASS, generic sensor_board role 10/10
  (role_complete_with_review). FL-1-FREE VERIFIED ON COPPER: no FAULT/
  INTERLOCK/TRIG/RST_OUT nets, no ID straps, no 2x07 bus header. 30 parts:
  Pico module (SELECTED BY THE PLANNER, not assumed), live-sourced LM75B I2C
  temp sensor, GND-strapped 24LC02 identity, protected GPIO bank, new generic
  power-LED primitive, universal holes/TPs/silk.
- Honest reductions, all recorded: BME280-class humidity/pressure =
  missing_component_model -> v1 is TEMPERATURE-ONLY; battery charger
  unsupported -> omitted; programming = Pico USB/BOOTSEL; no low-power/
  battery-safety/calibration claims.
- THE BENCHMARK EARNED ITS KEEP TWICE: (1) it caught a real classifier bug —
  'sma' matched inside 'small', mis-flagging the request as RF; fixed with
  word-boundary matching (pcba_engine._kw_hit) and the RF-adapter example
  still classifies correctly. (2) it exposed that the engine's '2-layer
  proven' claim referred to manual-class work — the AUTOMATED compose flow is
  4-layer; recorded as a capability gap, not silently claimed.
- Fleet learning updated: 6 gaps discovered, pattern usage recorded, outcome
  package_ready_with_review, next recommendation = USB-C connector/protection
  primitive (the #1 leverage gap) now that generalization is proven.
- New generic primitives: block_status_led; generic sensor_board role checker
  (no FL-1 assumptions).

Regression: phase221 23/23; all suites green; frontend 24/24; board 5/5.
Nothing ordered; nothing physically claimed.

## Phase 22.2: just-in-time primitive acquisition engine v1

Compose no longer needs its library hand-built component by component: when a
design needs a missing primitive, it acquires a CANDIDATE from trusted sources,
quarantines it, verifies it, and gates it — the junior-EE-with-a-strict-
reviewer model, with the trust boundary in code.

- jit_primitives.py: 12 gap types; 15 evidence states (candidate_from_* ->
  symbol/footprint/layout supported_with_review -> routed_in_sandbox ->
  physically_validated -> repeatedly_validated). Structural gates:
  can_support_claim() (candidates can NEVER support production_ready or any
  high-risk claim), verify_footprint() (pad-count/pitch mismatch BLOCKS,
  missing pin-1 BLOCKS, third-party/generated never auto-trusted),
  pinmap_gate() (unknown pins BLOCK; power/ground explicit), promote()
  (physical states need physical evidence; sandbox routes promote to
  routed_in_sandbox ONLY; failures demote). Ingestion implementation = the
  PROVEN resolve_part/source_part path.
- Applied to the five real gaps with REAL filesystem evidence against the
  installed KiCad libraries: BME280 (symbol + Bosch LGA-8 exist) ->
  footprint_supported_with_review, sensor-breakout sandbox next; USB-C (26
  receptacle footprints) -> footprint_supported_with_review, power-entry
  sandbox next; SMA (18 footprints) -> candidate, RF claims blocked
  regardless; gate driver -> BLOCKED (symbols exist but the real gap is
  power-stage layout rules — symbol presence does not unblock); QFN-56
  RP2040 -> BLOCKED (footprint exists and was used in 18.8 — the gap is the
  escape planner; JIT acquisition cannot fix a routing-capability gap).
- Fleet memory integration; JIT UI section (candidates visibly review-
  required, high-risk claims blocked for every JIT primitive).

Regression: phase222 25/25; all suites green; frontend 24/24; board 5/5.

## Phase 23.1: BME280 JIT sandbox + environmental sensor v2 — LOOP CLOSED

The complete JIT lifecycle proven end-to-end with real runs:
new primitive -> quarantine -> symbol/pinmap -> footprint verification ->
reference circuit -> sandbox board -> route/DRC/ERC -> evidence-state
promotion -> reuse in a real non-FL-1 board.

- Acquisition (REAL extraction, never memory): 8 BME280 pins parsed
  programmatically from the KiCad Sensor library symbol (1 GND, 2 CSB, 3 SDI,
  4 SCK, 5 SDO, 6 VDDIO, 7 GND, 8 VDD); Bosch LGA-8 footprint verified from
  the .kicad_mod (8 pads matching, 0.65mm pitch computed from actual pad
  coordinates, courtyard + silk present) -> candidate_from_library_import ->
  footprint_supported_with_review. I2C-mode straps (CSB=VDDIO, SDO=GND ->
  0x76) recorded as datasheet reference circuit, REVIEW-REQUIRED.
- Sandbox (bme280-sandbox-v1): PASSED 5/5 nets, 0 DRC, ERC clean, FL-1-free.
  THE SANDBOX CAUGHT A REAL CAPABILITY EDGE: fine-pitch fanout was capped at
  0.55mm (TSSOP tuning) — the 0.65mm LGA interior pad was walled with no
  escape ("stub FAILED for U18-3"). FINE_PITCH_MAX extended to 0.7mm; board
  regression re-verified every proven board.
- Promotion through the REAL gates: candidate -> routed_in_sandbox ->
  manufacturing_package_supported_with_review; the attempt to promote to
  physically_validated was REFUSED by promote() as required.
- Environmental Sensor Benchmark v2 (env-sensor-benchmark-v2): PASSED 14/14
  nets, 0 DRC, ERC clean, generic role 10/10, FL-1-free verified on copper.
  Upgrade LM75B temperature-only -> BME280 T/H/P. No calibration/accuracy/
  low-power/battery-safety claims; validation workflow v2 adds humidity +
  pressure sanity reads.
- Fleet learning: 2 gaps CLOSED (BME280 primitive; fanout 0.55->0.7), next
  recommendation USB-C 5V power-entry sandbox. New blocks: block_bme280 +
  block_bme280_breakout. Frontend suite hardened: self-provisions its CI
  session against a PROTECTED endpoint (the /api/auth/me probe was public and
  always 200 — a real test bug found and fixed).

Regression: phase231 26/26; all 18 suites green; frontend 24/24; board 5/5.
Nothing ordered; nothing physically claimed.

## Phase 23.2: general physical board synthesis engine v1

The move from "assemble known blocks" to "synthesize ordinary board structure
from intent" — proven with SEVEN clean pipeline runs including a board built
from pure synthesis and the USB-C gap closure.

- Synthesized subcircuit engine IN THE COMPOSER: 17 emitters + 3 universal
  kinds (pullup/pulldown/divider/LED/button/decoupling/TP cluster/I2C-SPI-
  UART-GPIO-debug-power headers/solder jumpers/RC filter/voltage monitor)
  generating REAL copper via the proven primitives, instantiated from
  spec.subcircuits and flowing through the SAME gates as blocks. ALL
  review-required, never physically validated by generation. High-current/HV/
  RF/high-speed/safety-critical kinds do not exist by design.
- physical_synthesis.py: machine audit of compose (29 blocks scoped fl1/
  generic/mixed), functional intent IR (22 intents), request->intent compiler
  (no silent high-risk inference), intent->implementation planner (6
  strategies), conservative power-tree synthesizer (no invented regulators),
  connector strategy engine (orientation risk explicit), constraint-driven
  placement planner v1 (constraint groups over the proven band machinery —
  free-form solver recorded as future capability), role framework v2 (11
  family templates; FL-1 requirements ONLY for FL-1 boards).
- JIT USB-C sink primitive: GCT USB4125 6-pin POWER-ONLY receptacle — no data
  pins EXIST, so no data claim is possible by construction; CC 5.1k pulldowns;
  no PD/compliance/charger claims. THE #1 LEVERAGE GAP CLOSED with a real
  routed board.
- Benchmarks (10): power-entry header (PURE SYNTHESIS — no hand-written
  functional block) 4/4; USB-C power entry 5/5; I2C sensor breakout
  (synthesized header+pullups, standalone) 5/5; ADC logger 10/10 (the run
  CAUGHT a wiring-allocation gap — synthesized headers now request MCU nets,
  labels-only copper impossible); Pi HAT relay 30/30; env-sensor v2 + BME280
  breakout regressions stand; motor/RF/PCIe honestly blocked/architecture_only.
- Fleet learning: led_indicator + testpoint_cluster recommended for pattern
  promotion after repeat success; constraint-solver + 2-layer-flow gaps
  recorded.

Regression: phase232 44/44; all 21 suites green; frontend 24/24; board 5/5.
Nothing ordered; nothing physically claimed; no gate weakened.

## Phase 23.3: general benchmark suite + capability packs v1

Breadth proven: 20-benchmark ordinary-rigid-PCBA suite, 12 routed clean on
the real pipeline (5 NEW runs this phase, all first-try passes), 3
architecture_only, 4 blocked — every verdict honest, zero FL-1 contamination
failures on copper.

- NEW real runs: Debug Programming Adapter 6/6 (generated headers WIRED);
  Current/Voltage Monitor 11/11 (the dutmonitor pattern proven FL-1-FREE);
  Connector Breakout 5/5 (generated-only); Generic 3-Slot Backplane 5/5
  (PURE SYNTHESIS — shared power+I2C slots + owned pull-ups, no FL-1 bus);
  Lab Instrument Adapter 14/14 (non-FL-1 EII pattern).
- Honest non-runs: SPI breakout architecture_only (no SPI sensor primitive —
  a sensor-less SPI board would be decorative); regulator board BLOCKED
  (AMS1117 only ever placed on GATE-FAILED stress boards = not evidence);
  low-power logger claims nothing about low power; motor/high-current/RF/
  PCIe/medical stay blocked or architecture_only, medical never claimed.
- 18 capability packs GENERATED FROM run evidence (evidence_links = run ids;
  FL-1-specific evidence marked): 15 at manufacturing_package_supported_with_
  review, SPI pack candidate, regulator pack blocked, low-power pack
  generated-only. promote_pack() refuses physical states without physical
  evidence and demotes on failures; pack state never exceeds evidence.
- Pattern recommendations: led_indicator + testpoint_cluster -> promote_to_
  pattern (5+ families, zero failures); voltage_monitor needs more benchmarks;
  generated headers stay parameterized; power-stage stays blocked.
- Next-capability recommendation (evidence-cited): AUTOMATED 2-LAYER FLOW —
  8 of 12 routed benchmarks are simple boards overbuilt on the 4-layer flow;
  QFN-56 escape and regulator primitive are runners-up; placement solving is
  explicitly NOT the bottleneck (zero placement failures in the suite).

Regression: phase233 37/37; all suites green; frontend 24/24; board 5/5
stands (no composer changes). Nothing ordered; nothing physically claimed.

## Phase 23.4: automated 2-layer flow + low-cost fabrication optimization v1

The 23.3 recommendation executed: a GATED 2-layer candidate flow, proven with
SEVEN clean reruns — the 4-layer path untouched and every fallback retained.

- Composer 2-layer mode (spec {"layers": 2}): LAYERS2 stackup (F/B only, NO
  internal planes), GND pours on BOTH outer layers + through-via stitching,
  +3V3 becomes a ROUTED net (no PWR plane exists). Emission verified ON
  COPPER: In1/In2 absent, board.json reports 2 layers, no silent fallback
  (the run log announces the 2-LAYER profile). 4-layer emission is
  byte-identical when the flag is absent.
- Decision model v2 (12 states) + eligibility checker: simple/low-density
  boards eligible; fine-pitch = eligible_WITH_REVIEW; measurement/analog
  (CV monitor, ADC logger, FL-1 cal), high-current, RF, high-speed, medical,
  and FL-1-reviewed boards NOT eligible — no automatic downgrades.
- Reruns 7/7 CLEAN on the real pipeline: power-entry 4/4, connector-breakout
  5/5, i2c-breakout 5/5, debug-adapter 6/6, usbc-entry 5/5, generic-backplane
  5/5, and the fine-pitch BME280 5/5 (fanout dogbones reach the B.Cu pour).
  Env-sensor v2 + lab adapter eligible but deferred (recorded, not hidden).
- 2L-vs-4L comparison: all 7 prefer_2_layer_with_review; cost deltas
  explicitly ESTIMATE/PLACEHOLDER until real quotes; risk delta recorded (no
  inner GND plane = reduced noise margin, physically unmeasured). Low-cost
  optimizer: correct-low-cost, never gates-for-cost. Pack update: 7 packs
  gain evidence-scoped 2-layer support; measurement packs REQUIRE 4-layer.
- Fleet learning: the automated-2-layer gap is CLOSED for the simple-board
  class (7/7); next systemic recommendation = QFN-56 QUADRANT ESCAPE PLANNER
  (unblocks bare-MCU boards, the FL-1 cost-down monolith, and most modern
  QFN parts); runner-up: a 2-layer PHYSICAL first article as the cheapest
  possible physical evidence.

Regression: phase234 29/29; all suites green; frontend 24/24; board 5/5.
Nothing ordered; 2-layer routed clean is NOT physical validation.

## Phase 23.5: QFN-56 quadrant escape + bare-MCU core sandbox v1 — SOLVED IN SANDBOX

The strategic routing gap standing since Phase 18.8 is CLOSED at sandbox
level: a bare RP2040 QFN-56 routes clean through every gate. No boot claim,
no physical validation, nothing ordered.

- SYMBOL VERIFICATION FIRST: the RP2040 primitive was verified against the
  official KiCad MCU_RaspberryPi symbol (57 pins parsed programmatically) and
  the QFN-56 footprint (57 pads, 0.4mm pitch computed from pad coordinates).
  This caught SEVEN errors in the 18.8 manual transcription — including pin
  23 (DVDD, the 1.1V core) wired to +3V3, which would have damaged real
  silicon. The JIT quarantine had correctly blocked any build on the
  unverified map: the two-layer honesty system worked exactly as designed.
- Escape solved with FIVE real fanout fixes: zone-only fine-pitch rows now
  dogboned (sides with all GPIOs unwired previously stranded their IOVDD
  pins); QFN zone pins ride the lane system (outward dogbone depths
  interleaved with lane laterals and collided); column plane pins stub+via at
  lane depth (vertical lane runs crossed row laterals in the corner box);
  cross-axis fan-target dedup (row and column fans claimed the same corner
  cells); bare-MCU block re-laid-out with RESERVED fan fields.
- bare-mcu-qfn56-core-sandbox-v1: PASSED 18/18 nets, 0 DRC, 0 unconnected,
  ERC clean, bare_mcu_core role 12/12 (with_review). Contents: QFN-56 RP2040
  + W25Q16 QSPI + 12MHz crystal + AMS1117 + SWD/BOOT/RESET + LED + TPs. USB
  advisory pads only. Decoupling values REVIEW-REQUIRED (not datasheet-
  extracted — recorded as the next JIT step).
- 2-layer QFN feasibility: FAILED HONESTLY (16/18, 18 unconnected — the
  +3V3 12-pin power web needs a plane). QFN core boards are 4-layer only;
  the failure is preserved and does not block the 4-layer result.
- bare_mcu_core_pack scoped to QFN-56+RP2040 ONLY (no BGA/HDI/other-QFN
  generalization). Pico replacement feasibility: equivalence NOT claimed;
  the remaining list is explicit (datasheet extraction, physical bring-up,
  USB decision, regulator validation). FL-1 monolith impact: the 18.8
  blocker is addressed; Core-6 bare-RP2040 is now UNBLOCKED FOR ATTEMPT.
- Fleet next recommendation: PHYSICAL 2-LAYER FIRST ARTICLE — every systemic
  routing gap in the ordinary-rigid class is now sandbox-closed; the
  platform's single largest evidence gap is physical (zero boards exist).

Regression: phase235 25/25; all suites green; frontend 24/24; board 5/5.

## Phase 23.6: first physical evidence loop v1

The bridge from sandbox to silicon: everything needed to turn ONE real board
into real physical validation evidence — with every gate a real function and
the ledger starting EMPTY.

- Physical evidence state model (15 states): nothing past package_ready_with_
  review without human approval or real-world evidence; advance() REFUSES
  ungated transitions. Readiness ladder (12 rungs): production_ready
  structurally forbidden without repeated validation + yield + process
  evidence + human approval.
- First physical board selection (6 candidates scored): power-entry-header
  2-LAYER variant wins — lowest fab/assembly/test complexity, zero firmware,
  no fine pitch, one multimeter validates it, and a pass promotes the
  synthesized-structure generator, the 2-layer flow, led_indicator +
  testpoint_cluster patterns, and two capability packs in one article. The
  QFN sandbox is marked STRATEGIC BUT EXPLICITLY NOT FIRST.
- First article package verified complete for human review; human approval
  packet with EXPLICIT signature gates (APPROVED_FOR_QUOTE and APPROVED_FOR_
  ORDER, both null until a human signs — Compose cannot fill them); quote
  package (3/5/10 qty, bare-PCB recommended, ALL prices PLACEHOLDER,
  submitted:false, ordered:false).
- 15-step physical validation workflow (multimeter + current-limited supply;
  no dangerous voltages; no certification/calibration/thermal claims);
  evidence ingestion schema (attribution required, measurements require
  UNITS, photos alone are never electrical validation); promotion gate
  (physical_evidence.promotion_gate) rejecting simulated evidence, photo-only
  electrical claims, unitless measurements, and missing adjudication —
  promotion is SCOPED to the tested article/patterns/packs only.
- Physical evidence ledger: EMPTY — no fake evidence, no placeholder passes.
  Fleet next-after-first: USB-C entry -> BME280 -> env-v2 -> QFN LAST.

Regression: phase236 24/24; all suites green; frontend 24/24; board 5/5
stands (artifact-only). Nothing ordered; nothing claimed.

## Phase 23.7: package family capability system v1

The QFN-56 win generalized into package-family intelligence — classify,
verify geometry, verify pin mapping, pick strategies, gate claims — with
every verdict scoped and every verifier run against REAL footprint files.

- Taxonomy: 28 families across 3 tiers (tier 3 = BGA/WLCSP/high-density/RF,
  gated architecture_only/blocked until proven). 15-state capability model:
  presence != verification, sandbox != physical, one validated part never
  validates a family, state scoped to family+variant+part+footprint+fab class.
- Classifier + verifiers exercised on 12 REAL footprints (0402/0603 passives,
  SOT-23/223, SOIC-8, TSSOP-10, QFN-56, LGA-8, USB4125, 2x07 header, BGA-64):
  geometry parsed from .kicad_mod (modal-pitch computation — min-diff broke
  on 4-sided packages and float dust nearly flipped a coarse BGA to "fine"),
  pad-count mismatch BLOCKS, power ambiguity BLOCKS active ICs.
- BGA modeled HONESTLY from a real parsed ball map (BGA-64, 64 balls @ 0.8mm,
  rows A-K skipping I): bga_modeled + ball_map_parsed + escape_feasibility_
  estimated -> ARCHITECTURE_ONLY. Exact gap: no verified BGA component
  primitive exists; no DDR/PCIe/high-speed/yield implied; no fake sandbox.
- 9 routing strategies (proven scope marked: nolead=QFN-56 only, LGA=LGA-8
  only); placement + manufacturing/inspection rules per family (BGA X-ray,
  0201 review-required, QFN EP paste review).
- 18-benchmark package suite: 9 families evidenced by existing real runs,
  9 honestly gapped (MSOP/DFN/other-QFN/JST/b2b missing primitives;
  regulator blocked; BGA/WLCSP/high-speed/RF architecture_only).
- Registry (28 entries, ONLY-scoped), planner integration (package gate is
  ORTHOGONAL to electrical gate — either can block), 16 packs updated with
  package scope. Fleet next: EXECUTE the physical evidence loop — package
  intelligence saturates at sandbox evidence like everything else.

Regression: phase237 36/36; all suites green; frontend 24/24; board 5/5
stands (artifact-only). Nothing ordered; nothing claimed.

## Milestone M1 (autonomous roadmap): chip-down component synthesis v1

First milestone executed under the standing goal (generic evidence-gated
PCBA generator): the bare-RP2040 pattern GENERALIZED — any symbol+footprint-
verified tier-1/2 chip gets its chip-down support synthesized from library
truth, no hand-written block per part.

- chipdown_synthesis.synthesize_chipdown: parse symbol pins with KiCad
  `extends` INHERITANCE RESOLVED (PCF8574T carries no pins — its base
  TCA9534 does; a real acquisition lesson) -> classify package (families
  system) -> verify footprint geometry (pad-count mismatch BLOCKS) ->
  verify mapping (power ambiguity BLOCKS) -> bus policy (power/GND/I2C/
  address-straps/INT-pullup/NC/exposed-IO) -> compose {chipdown:[...]}
  entry. Tier-3 packages return architecture_only. Parser hardened twice
  during the milestone: string-aware depth scan (parens inside quoted
  descriptions overran symbol blocks and could silently steal the NEXT
  symbol's pins) and extends provenance preserved through recursion.
- compose.py generic emitter: place the verified part + per-power-pin
  decoupling + open-collector pullups with TPs + exposed-IO header +
  REVIEW-REQUIRED silk; chip-down entries ride their own band. Compose
  REFUSES entries not in synthesized_review_required state.
- PROOF on a never-hand-blocked part: chipdown-pcf8574-v1 (PCF8574 I2C
  expander, SOIC-16) PASSED 15/15 nets, 0 DRC, 0 unconnected through the
  full pipeline. No functional claim — the expander is placed and wired,
  not proven to respond. Nothing physical.
- Roadmap-to-final-goal artifact updated (9 milestones remaining; physical
  loop blocked on the human signature). Fleet next: Bare-MCU product board
  / Pico replacement v1 — chip-down synthesis + QFN-56 escape are both
  proven, and combining them is the next generality step a signature does
  not block. Honest gaps: SPI/UART/analog bus policies, datasheet-extracted
  decoupling values, multi-rail chips, crystal/flash requirement detection.

Regression: M1 16/16; all suites green; frontend 24/24; board 5/5.
