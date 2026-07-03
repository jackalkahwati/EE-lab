# Production-Readiness Pass (Phase E) — Full Design Review + Fixes

Date: 2026-07-03. Executed directly against the live Onshape document
("EE lab", pro-owned, did `02ed72e43f8d925e0c7aa678`) via the REST
toolchain in `tools/onshape/` (`prod_probe.py` read-only review,
`phase_e_production.py` fix pass). Release artifacts: Onshape Version
**PROD-PASS-1** (`c586bc3cb46c8a7e6b9b75f3`), STEP export
`Part_Studio_1_v6.step` (4.1 MB, 341 solids).

## 1. Full-design review results (before the pass)

Ran the complete Run-5 audit plus targeted true-distance (evDistance)
checks and bulk mass properties. 327 solids + 4 composites, all named,
all with part numbers.

| Check | Result |
|---|---|
| Naming audit | clean — zero generic names |
| Drive-line coaxiality X/Y/Z | 0.0000 mm deviation, PASS all axes |
| Park-position interference | 1 bbox flag: X ballnut flange vs front rail saddle — **0.849 mm true clearance** (evDistance), the known freeze watch item; parts are co-moving so this is an assembly-fit tolerance, not an operating clearance. Unchanged. |
| X motor body vs right shell "-1.0 mm" (audit §6) | **false positive** — bbox artifact of the hollow shell; true distance 64 mm |
| Swept-body flags (audit §4) | all bbox-conservative noise (statics inside the aggregate travel box); spot-checked clean |
| Materials | 18 stragglers without material (display + wordmark bodies added after Phase C) |
| Mass / CoG | not previously reported (D5 item 2) |

Real defects found by the review:

1. **Zero axial float at X and Z couplings.** Motor shaft end faces butted
   hard against the screw journal end faces (evDistance 0.000 mm) inside
   the jaw couplings; Y axis already had the correct 2 mm gap. Shafts must
   never butt in a jaw coupling (thermal growth / axial tolerance).
2. **No E-stop anywhere in the model** (v4 review had flagged a low
   E-stop; it was lost in the enclosure rebuild — the safety relay exists
   in the plinth but no operator control).
3. **No access-door hardware** — the front smoked glass had no hinges,
   latch, or interlock, i.e. no way to load a DUT with guarding intact.
4. **No PE/grounding provision** on frame, panels, or pan (D4.2).
5. **No calibration assets** (D2.5: fiducial target, probe touch-off,
   force reference).

## 2. Changes made (Phase E, all verified in-session)

| # | Change | Verification |
|---|---|---|
| 1 | X and Z screw journals (EE-FAB-JNL) shortened 2 mm at the coupling end via scoped REMOVE cuts | evDistance now **2.000 mm** shaft-to-journal on both axes (matches Y) |
| 2 | Panel-mount E-stop added on right shell front face at Z +300 (~600 mm above bench, D4.2 target): Ø22 panel hole cut through the 5 mm wall + bezel Ø60 / stem Ø22 / mushroom cap Ø45 (IDEC XW1E-BV411MR) | bodies at intended coords, zero interference |
| 3 | Front glass converted to interlocked access door: 2 concealed hinges (Sugatsune HES3D-90BL) left edge, guard-lock interlock switch (Omron D4NS-4CF, doubles as latch) + operation key (D4DS-K3) right edge | zero interference; outside gantry sweep (Y ≥ −339) |
| 4 | 4× M5 grounding studs (DIN 46234 lug points): base pan front-left/right, base frame rear-left top, rear panel inner face | zero interference; clear of equipment tray (Y ±365) and instrument envelopes |
| 5 | Calibration assets on the fixture plate, inside probe sweep (X ±280, Y −339..91): fiducial target plate 40×40×3 (EE-CAL-FID), probe touch-off pad Ø16 hardened (EE-CAL-TOP), force calibration post Ø12×15 (EE-CAL-FCP) | zero interference (bbox flags vs Base Frame measured 90–124 mm true clearance) |
| 6 | Materials assigned to all 18 stragglers (Touch Display Bezel → 6061-T6; display module → electronics envelope; UI layers + 14 wordmark glyphs → ABS/PC) | bulk metadata verified; zero solids without material |
| 7 | All 14 new bodies named, with vendor, part number, material, description, BOM-included | 14/14 matched and written in one bulk call |

RFQ package updated: `docs/rfq/fl1-evt-fab-rfq.csv` +3 fab items
(EE-CAL-FID/TOP/FCP), `docs/rfq/fl1-evt-cots-buy.csv` +5 COTS lines
(E-stop, hinges, interlock switch + key, ground studs).

## 3. D5 release-audit status (after the pass)

- Naming: **clean** (341/341 named)
- Materials: **complete** (every solid has a material with density)
- Interference: **zero unintended** (one documented watch item: ballnut
  flange 0.849 mm, co-moving pair, carry to DVT tolerance analysis)
- Coaxiality: 0.0000 mm all axes; axial float now 2 mm on all three
- **Total mass 353.15 kg, CoG (X −6.8, Y −3.1, Z +155.0) mm.** Caveat:
  instruments are solid envelope bodies at approximated density and the
  cosmetic slabs are solid-modeled — treat as an upper bound. CoG is
  essentially centered and low (Z +155 with the machine spanning −302 to
  +482), which is favorable for bench stability.

## 4. Remaining work to true production (not CAD-scriptable, tracked)

1. ~~Motion Check assembly~~ **DONE (same session)**: all 14 bodies
   instanced and added to the Static Frame mate group
   (`mc_add_prod_instances.py`). Note: the assembly's static group solves
   at a gauge offset of (0, +320, −62.5) mm from modeled coordinates, so
   fresh instances land 320 mm away from the machine; `mc_fix_gauge_offset.py`
   removes them from the group, moves them onto Base Frame's occurrence
   transform, and re-adds them. Park verified unchanged
   (X 0.020, Y 0.000, Z 0.075); render checkpoint clean.
2. Ballnut-flange 0.849 mm watch item → DVT tolerance stack analysis.
3. Fastener-level detail on load-path joints (counterbores + hardware)
   remains at EVT level per the freeze decision; full DFM/DFA at DVT.
4. Safety circuit wiring: E-stop + interlock + Omron G9SE relay are all
   physically present; the wiring/logic definition lives in the
   electrical workstream, not the CAD.
5. Sheet-metal flat patterns, final drawing tolerances beyond ISO
   2768-mK MBD sheets, regulatory/labeling pass, packaging.
