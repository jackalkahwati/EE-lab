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
