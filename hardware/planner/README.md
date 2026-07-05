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
