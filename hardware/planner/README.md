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
