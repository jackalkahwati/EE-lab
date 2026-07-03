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

## 3b. Phase F front-panel rework (2026-07-03, same day — design feedback)

Version **PROD-PASS-2** (`c32a72992ab0f82024124c7c`), STEP export
`Part_Studio_1_v7.step`.

- **E-stop relocated** (superseded — see PROD-PASS-3 below) from the
  right shell (Z +300) to the front fascia beside the display cluster;
  housing (bezel + stem) black (22,22,25), mushroom cap **red per
  ISO 13850** (a fully black E-stop is non-compliant). Bodies moved by
  transform so partIds — and the Motion Check instances — carried over
  untouched.
- **Display upsized 10.1in → 15.6in** (1920×1080): bezel 370×220 at
  X 28..398, Z −225..−5, glass 344×194 16:9, UI mock layers rebuilt to
  match. Display bodies were never in the assembly, so delete + rebuild
  was safe. RFQ updated (bezel EE-FAB-DSPBZL now 370×220, COTS line to
  15.6in panel).
- **Wordmark R fixed** — the R's bowl counter had solidified (the
  enclosed sketch region extruded with the strokes). Counter cut through
  Glyph 03; render-verified: "FIRSTLIGHT FL-1" reads correctly.

## 3c. PROD-PASS-3: E-stop to the rear panel (2026-07-03, design direction)

Version **PROD-PASS-3** (`aff7b7a2b28902d0b12100a5`), STEP
`Part_Studio_1_v8.step`. E-stop moved to the rear panel upper-left,
center (X −300, Z +300) — clear of the IEC/connector column, fans, vent
field, DUT bulkhead, and screw rows. Front fascia hole feature deleted
(fascia restored); new Ø22 hole through the rear panel. The bodies are
Y-axis cylinders, so the front→rear mirror was done with per-body
translations (partIds preserved; Motion Check instances followed).
Colors unchanged (black housing, red cap).

**Safety finding (open):** a single rear-mounted E-stop is not readily
accessible from the operator position at the front (ISO 13850 §4.4 /
IEC 60204-1). Accepted as design direction for now; recommendation:
add a second E-stop head at the front (or a wireless/foot alternative)
in the DVT safety-circuit workstream. Both heads wire in series into
the same G9SE safety-relay loop.

## 3d. ID-PASS-1: Formlabs / Fuse 1+ design language (2026-07-03)

Version **ID-PASS-1** (`6068c367ee405cb8efc69338`), STEP
`Part_Studio_1_v9.step`. Appearance + fillets only — no body deletions,
partIds and assembly instances untouched.

- **Amber window** — front glass to transparent amber PMMA
  (245,115,15 @ opacity 220, Formlabs signature) with **R60 corner
  fillets** (Fuse-style rounded-square window). Fillets scoped via
  qCreatedBy to the glass's creating feature because the frame edges
  share the corner points.
- **Graphite top slab** (52,54,58) wrapping the dark face over the top
  like the Fuse 1+; shells stay warm silver; front already black.
- **Formlabs-orange accents** (255,110,0): full-width accent light
  strip, power LED bar + indicator dot, probe-head logo emblem. Glass
  frames to near-black so the window floats in the dark face.
- RFQ updated: amber PMMA + R60 note, graphite Class A top, black
  frames.
- Toolchain lesson: the front glass has been **hidden in the studio
  view state** since the interior passes — part-studio `shadedviews`
  silently omits it. Pass `showAllParts=true` when rendering, or every
  glass appearance change looks like a no-op.

## 3e. ID-PASS-2: panel breaks and shadow gaps (2026-07-03)

Version **ID-PASS-2** (`d497d8a754a22e2f00ceac64`), STEP
`Part_Studio_1_v10.step`. All scoped REMOVE cuts — no deletions,
partIds/assembly untouched.

- **Window shadow gap** — 6 mm wide, 2 mm deep rounded recess ring in
  the glass-frame front faces around the amber window (inner outline
  inset 1 mm into the opening to dodge the coincident-face ERROR mode).
- **Display shadow gap** — same treatment around the 15.6in bezel, cut
  into the fascia.
- **Body seam** — 3 mm × 1.5 mm groove at Z = 0 (plinth line) wrapping
  shell sides, shell front columns, and the full rear (shells + rear
  trims + rear panel); the front center already breaks at the
  fascia/sill joint. Reads as the Fuse-style body/base panel split.
- Cosmetic machining features; drawings are MBD "per 3D model" so the
  drawing set inherits them.

## 3f. ID-PASS-3: proper window corners + real interior colors (2026-07-03)

Version **ID-PASS-3** (`e9aaaf81bf2d69904d54f3c3`), STEP
`Part_Studio_1_v11.step`.

- **Window corners fixed** — the R60 glass fillet left bright untinted
  notches at the corners (square aperture, rounded pane: sightline hit
  the white shell interior with no glass in the path). Reworked the way
  the Fuse does it: fillet deleted (square pane fills the aperture
  completely) + four near-black **corner gussets** behind the glass
  (quarter-concave R60, Y −456..−450, EE-FAB-GLZ family, RFQ line 61)
  so the aperture reads rounded through the amber with no gaps.
- **Real interior colors** — 249 bodies painted by name-pattern rules:
  steel rails/screws/blocks, black NEMA motors, clear-anodize plates and
  stages, green PCBs with dark ICs, brass pogos, black cameras/chains,
  vendor-true instruments (PicoScope blue, LabJack red, Omron safety
  relay yellow, Keithley graphite), yellow interlock, matte-black deck.
- **Window unhidden in the document view state** (driven through the
  Onshape UI via CDP — the REST API does not expose per-part
  show/hide). Note: the glass had been hidden since the interior CAD
  passes; renders needed showAllParts until now.
- New renders: front, hero, FIRSTLIGHT FL-1 wordmark + LCD close-up,
  interior detail, probe-station detail.

## 3g. PROD-PASS-4/4b: fixture drawer + universal M5 grid (2026-07-03)

Versions **PROD-PASS-4** + **PROD-PASS-4b** (`3ec42e9e6ca7e141831fc4fc`),
STEP `Part_Studio_1_v12.step`. Closes the two CAD items from the
serviceability review.

**Slide-out fixture drawer** — the fixture plate itself is the drawer:
- Accuride DZ9301-class full-extension slides clamp the plate side
  faces at Z 44..54 — above the measurement-bay stack (relay matrix,
  blind-mate pogos, protection board, Saleae; tallest 43) and 1 mm
  under the deck. Support rails on four posts at verified-clear spots.
- The fixture standoffs stay full height as **closed-position kinematic
  seats**: slides carry travel, the plate settles onto standoffs + the
  Southco latch when closed — probing loads bypass the slides and the Z
  datum repeats. Blind-mate bay pogos re-engage on close.
- **Frame tunnel** X ±290, Z 36..72 through the Base Frame front member
  (8 mm top chord — X limit-switch mounts untouched; 36 mm bottom web;
  reinforce chord at DVT). Front aperture through sill + glass-frame
  bottom, filled by a black fascia panel + handle with 2 mm reveal,
  connected by two arms through the tunnel (8 mm true clearance).
- Constraint (documented): drawer ride-through headroom is ~12 mm above
  board top (force-cal post trimmed to Z 68 to comply); taller
  assemblies top-load through the door as before. Drawer-open breaks
  the same G9SE guard circuit as the door.
- v1 lesson: the first tray-under-standoffs architecture collided with
  the bay stack and ignored the solid frame front member — caught by
  the overlap scan, removed, re-architected (phase_g2_drawer_fix.py).

**Universal fixture grid** — 269 Ø4.2 (M5 tap) holes at 25 mm pitch,
X ±225 / Y ±175, keep-outs auto-skipped around vacuum ports/bosses and
calibration assets. With the locating pins this enables per-board
3D-printed nest plates → any outline/panel within the plate becomes
fixturable. RFQ updated (lines 62–68 + FIXP note).

## 3h. PROD-PASS-5: ESD kit, powered door-exit drawer, warp laser (2026-07-03)

Version **PROD-PASS-5** (`410245a964af6a9febb9b5ba`), STEP
`Part_Studio_1_v13.step`.

**Drawer, reworked to the door-exit concept** — fascia panel/handle/arms
deleted; the **amber door extends down over the drawer exit** (boolean
ADD into the glass body — partId preserved; stepped 750×360 + 576×64
leaf, 2 mm reveals). Workflow: open window → **electric drive** slides
the fixture out (igus drylin SAW + NEMA17 under the plate, torque-
limited, enabled only door-open via the G9SE circuit) → load → drive in
→ close window. Physics note kept honest: the internal frame pass-under
remains — the frame front member (Z 0..80) and front X rail (Z 80..97.5)
cross the exit path and lifting over them collides with the beam; none
of it is visible externally.

**ESD control (S20.20 / IEC 61340-5-1)**
- Fixture plate + standoffs finish changed **anodize → chem-film**
  (MIL-DTL-5541 Cl 3, conductive) — anodize was an insulator under the DUT
- **Drawer ground braid** (plate → chassis, travel-rated service loop)
- **Wrist-strap jack** (Desco, 1 MΩ) on the fascia at the loading position
- **Ionizer bar** (SMC IZS31) on the camera bracket beside the IR camera
  — neutralizes the PMMA window, chains, and DUT; extend coverage at DVT
- Drag chains / cable loop → **igus ESD dissipative** PN swap
- Printed grid nests specced carbon-filled dissipative (procedure note)
- Machine self-check: DMM6500 + relay matrix can verify fixture-to-
  chassis resistance (10⁶–10⁹ Ω window) as a calibration step

**450 nm laser warp scanner** (Micro-Epsilon scanCONTROL class) on the
Z slide, offset off the ballscrew centerline (first placement clashed
with the Z screw — caught by the scan, moved −65 mm in Y, zero overlaps).
Pre-probe warp mapping feeds probe Z-planning; Class 3R contained, and
the amber PMMA attenuates 405–450 nm — **the window is now a functional
laser viewing guard, not just brand language.**

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
