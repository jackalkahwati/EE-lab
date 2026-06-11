# EVT Roadmap — Autonomous Electronics Bring-Up Station

Status as of June 10, 2026. The v4 STEP export (`Part Studio 1_v4.step`) completed
the packaging/industrial-design phase. Independent geometry review
(`Part_Studio_1_v4_review.md`) places the design at:

- ~60–70% of system architecture
- ~30–35% of mechanical engineering required for EVT
- ~10–15% of detailed DFM
- **~30% of the overall path to a completed EVT unit**

The next milestone is an **EVT-intent prototype**, not a DVT machine and not more
cosmetic CAD. EVT proves the engineering works reliably; it does not need volume
manufacturing optimization.

## What EVT must prove

1. Locates and probes test points accurately.
2. Probe contact is repeatable and does not damage the PCB.
3. Measurements stay accurate despite motion, cabling, and electrical noise.
4. Custom PCBA works across all required interfaces.
5. Full software workflow operates automatically.
6. Machine detects/diagnoses the target faults.
7. Thermal performance stable over extended operation.
8. Safety systems fail correctly.
9. Workflow repeats across multiple boards and operators.
10. Design can be serviced and calibrated.

## EVT unit content (production-intent where it matters)

- Final or near-final XY and Z motion architecture
- Production-intent probe mechanism
- Custom PCBA Rev A (relay/probe matrix, probe protection, cartridge interface)
- Full firmware/software workflow
- Real measurement instruments (PicoScope 5444D, Saleae Logic Pro 16,
  MCC USB-2416, LabJack T7-OEM, Siglent stand-ins per locked BOM)
- Final electrical power architecture
- Representative wiring and connectors
- Calibration system
- E-stop, interlocks, basic guarding
- Representative PCB fixture
- Cooling sufficient for real operating conditions

Enclosure can be modifiable/removable/low-cost-process. Defer to DVT: final sheet
metal, paint, volume suppliers, production tooling, assembly instructions,
fastener-count optimization, packaging, regulatory cert, full DFM/DFA, cost-down.

## Key decision (recommended)

**Park the appliance enclosure (white shells, smoked glass) at v4.** It has done
its job for renders and positioning. The EVT build should use an open-frame /
extrusion-and-polycarbonate guard approach so the motion, probe, PCBA, and cabling
work stays easy to modify. The cosmetic enclosure design returns at DVT,
informed by EVT cable routing, cooling, and service-access learnings.

## Build sequence (phases reuse the same expensive components)

- **Phase 1 — bench:** custom PCBA Rev A, instruments, power system, software.
- **Phase 2 — motion:** motion system, probe head, fixture, camera, calibration.
- **Phase 3 — integration:** open-frame full-system integration.
- **Phase 4 — protect:** enclosure, safety, cooling, user interface.
- **Phase 5 — EVT test:** formal testing and failure correction.

## CAD pass plan (maps the v4 review findings to EVT passes)

### CAD Pass EVT-1: Motion architecture detail (next — prompt in
`adam-cad-evt-pass-1-motion.prompt.md`)

Resolves review collision items 5, 6, 8 and the missing-motion-hardware list:

- Replace rail/ballscrew/motor envelopes with vendor-true geometry (HIWIN-class
  profile rails + carriage blocks, SFU-class ballscrews with nuts, BK/BF end
  supports, couplings, motor mount plates).
- Fix: X servo intersecting base frame (11%), Y servo intersecting moving beam
  (36%), Z-stage slide fully embedded in beam.
- Add travel limit definition, homing/limit sensors, and swept-volume check bodies.

### CAD Pass EVT-2: Probe head + fixture engineering

Resolves review items 3, 4, 9:

- Probe preload, compliant travel, anti-rotation, hard stops as real mechanics.
- Cartridge interface with real bores/clearances (currently solid intersections).
- Fixture plate lifted off the instrument deck (57% volume intersection today) on
  standoffs or with a deck cutout; relocate PicoScope out of the fixture-plate
  intrusion zone.
- Real clamping mechanism and adjustment hardware; tooling-pin and vacuum detail.

### CAD Pass EVT-3: Open-frame guarding, safety, cooling

- Replaces the cosmetic enclosure for the EVT build: extrusion frame +
  polycarbonate panels, interlocked access door, E-stop relocated into operator
  reach/sightline (review: currently 252 mm above floor plane, too low).
- Real vent openings, fans, filters, and an airflow path (rear vent field is
  currently a solid block).
- If the cosmetic shells are kept in the model, fix review items 1 and 2 (glass
  has no window cutout in surround; posts embedded in solid 70 mm shells).

### Outside Adam CAD (parallel workstreams, higher EVT leverage than CAD)

- True Onshape Assembly with subassemblies and mates (Adam works in the Part
  Studio only — assembly build is manual or other tooling).
- Custom PCBA Rev A schematics/layout (relay matrix, protection, cartridge AFE).
- Software workflow: vision, board import, sequencing, reports.
- Calibration concept: reference targets on fixture plate, camera-to-probe
  offset calibration routine, probe-force calibration.
- Thermal budget: instrument + PSU dissipation vs. plinth airflow.

## Review headline numbers to retire by EVT-2

- 134 solid-body intersections (9 critical) → 0 unintended.
- 118 of 169 bodies are plain rectangular envelopes → motion + probe + fixture
  bodies become engineering geometry; enclosure may stay simplified.
- No materials/tolerances/fasteners defined → materials and fastener specs on
  all load-path parts.
