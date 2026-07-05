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
