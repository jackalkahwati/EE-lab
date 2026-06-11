# Adam CAD Master Prompt: v4 Packaging Model → DVT-Intent CAD

Continue the existing Onshape Part Studio. This master prompt supersedes the
EVT Pass 1 motion prompt (Phase D1 absorbs it). The freeze rules change: every
body in the studio is now editable, because the goal is no longer packaging or
renders — it is converting the v4 layout into DVT-intent geometry where every
body is either an orderable vendor part number or a manufacturable part with a
defined material and process.

Run the phases IN ORDER, one phase per session. At the end of each phase,
regenerate with zero errors, run the phase's verification step, and STOP —
do not start the next phase in the same session. If a phase's verification
fails, fix it before moving on.

Global rules for all phases:

- Preserve the coordinate system and travels: X 500 mm, Y 400 mm, Z 100 mm,
  fixture centered at origin, frame top at Z = 80 mm.
- Permitted solid containments are ONLY: rail-through-carriage-block bores,
  screw-through-nut bores, pins/dowels in holes, and fasteners in holes.
  Everything else is a defect. The v4 review found 134 intersections (9
  critical); the running target is zero unintended by end of D2 for the
  mechanism and zero overall by end of D3.
- Every new or rebuilt body gets a descriptive name and a material assignment
  (6061-T6 plate, 5052-H32 sheet, ground steel, PC, POM, etc.). Zero "Part NNN"
  names at any checkpoint.
- Standardize fasteners to M3 / M4 / M5 only. Counterbores and clearance holes
  modeled on all load-path joints; cosmetic screw-head bodies are no longer
  acceptable on structural connections.
- Do not attempt drawings, tolerances, or assembly mates in the Part Studio —
  those are manual follow-ups outside this prompt.

---

## Phase D1: Motion System to Procurement Grade

Reference components (dimensionally-true simplified geometry, correct interface
dims and hole patterns; ball tracks/seals not needed):

- X: 2x HIWIN HGR20-class rails (M5 holes at 60 mm pitch), 4x HGH20CA-class
  blocks (77.5 x 44.4 x 30 mm, 4x M5 at 32 x 36 mm). SFU1605 ballscrew with
  flanged nut + nut housing, BK12 fixed / BF12 floating supports, jaw coupling
  Ø25 x 30.
- Y: 2x HGR15-class rails, 4x HGH15CA-class blocks (61.4 x 34 x 24 mm).
  SFU1204, BK10/BF10, coupling Ø20 x 25.
- Z: 2x MGN12 rails, 2x MGN12H blocks, SFU1204 (or 1004), BK10 top support,
  bushing at bottom.
- Motors: NEMA 23 closed-loop steppers (57 x 57 flange, Ø38.1 pilot, 4x M4 on
  Ø47.14 BC, Ø8 x 20 shaft) on all axes, driven by the Galil DMC-4133.

Tasks:

1. Fix the three structural collisions with real mounts: X motor mount plate
   (10 mm 6061) on the frame end face beyond the BK12 — motor fully outside the
   frame solid. Y offset L-bracket at the beam +Y end — zero overlap with the
   beam. Rebuild the Z stack: Y carriage on its 4 blocks on top of the beam, Z
   plate on the carriage front (-Y) face fully clear of the beam, Z rails/slide
   on the plate front.
2. Replace all rail envelopes with vendor-true sections including counterbored
   mounting holes at catalog pitch; add all 10 carriage blocks; moving members
   sit on their blocks via bolted adapter plates where heights need
   reconciling.
3. Replace all three bare screw cylinders with full ballscrew assemblies:
   journaled shaft, flanged nut + bolted nut housing on the moving member,
   BK/BF blocks, coupling.
4. Add limit-switch bodies (min/max/home per axis) on brackets.
5. Add three transparent swept-volume bodies (Swept Volume X/Y/Z) covering full
   travel of each moving group.

Verify D1: zero unintended intersections among motion bodies; no static body
intersects a swept volume; report per-axis stack heights, coupling coaxiality,
and minimum clearance of the Y-motor bracket to the shells at X = ±250 mm.

---

## Phase D2: Probe Head, Fixture, and Calibration Engineering

1. Probe mechanics: rebuild the probe stack with real bores and clearances —
   pogo cartridge receivers (press-fit bushing bores through the cartridge
   plate), 2-3 mm compliant Z travel via a spring-preloaded sliding sub-plate
   with two guide pins and an anti-rotation flat, hard stops that bottom before
   the housing can reach the PCB, and the load-cell flexure as the working
   force path (probe loads route through it).
2. Tool-changer interface: finish the rear pad as a real interface — two Ø6
   dowels, two M5 threads, one electrical blind-mate connector body.
3. Fixture/deck conflict (57% volume intersection): raise the fixture plate
   onto six Ø20 standoffs above the instrument deck with a deck cutout for the
   cable pass-through, OR pocket the deck — pick one and execute. Relocate the
   PicoScope out of the fixture-plate intrusion zone; re-verify the measurement
   bay layout afterward.
4. Real workholding: replace the cosmetic clamp blocks with low-profile edge
   clamps (sliding body, M5 clamp screw, serrated grip lip) in T-slots or a
   25 mm grid; tooling pins become Ø8 shoulder pins in bushed receiver holes;
   vacuum ports become through-drilled fittings with O-ring grooves connected
   to a manifold groove on the plate underside.
5. Calibration features: a fiducial target plate (3 dots + checkerboard patch)
   bolted at a fixture corner for camera calibration, a probe touch-off pad
   (hardened insert) for Z reference, and a force-calibration reference post.
   These are DVT test assets — model and name them.

Verify D2: zero unintended intersections anywhere in the mechanism (motion +
probe + fixture + deck). Probe tips reach PCB top (Z = 59.6 mm) within Z
travel with the compliance window stated. Report remaining measurement-bay
clearances around the relocated PicoScope.

---

## Phase D3: Enclosure to Manufacturable Construction

1. Side shells: replace the 70 mm solid slabs with 3.5 mm wall hollow shells
   (RIM-molded or thermoformed intent), with internal bosses and ribs that pick
   up the four enclosure posts — resolving the embedded-post conflict. Keep the
   outer cosmetic surfaces (rounding per the approved renders).
2. Front surround/glass: cut the window opening in the surround (the glass is
   currently fully embedded in a solid), add a 6 mm recess gasket land, model
   the glass retained by six clips + an EPDM gasket body. The door becomes
   buildable: two concealed hinge bodies in the left shell wrap with real screw
   bosses, a magnetic latch + striker, and a door interlock switch + striker
   (safety circuit, wired in D4).
3. Panels: top and base panels become 2 mm 5052 sheet with 15 mm flanges on
   all edges, two stiffening beads each (the review flagged 940 x 800 flat
   panels), and M5 + rivnut fastening to the skeleton at ~150 mm pitch. Rear
   panel gets its true vent slot field cut through (stadium slots ~25 x 4 mm,
   6 staggered rows in a 300 x 80 mm field) plus real connector cutouts behind
   the IEC/RJ45/USB-C bodies, and 8 perimeter screws into rivnuts.
4. Service access: the rear panel and the plinth front fascia become removable
   panels (screw pattern + part split modeled); the equipment tray gets slide
   support rails so the instrument tray can be serviced.

Verify D3: zero unintended intersections in the entire studio. Confirm glass
sightline to probe and fixture through the actual cutout. Report shell wall
thickness, panel flange dims, and total fastener count by size.

---

## Phase D4: Thermal, Safety, and Cable Architecture

1. Cooling: two 80 mm fan bodies — intake low on the left shell with a filter
   frame, exhaust on the rear panel behind the vent field — plus a baffle that
   separates plinth airflow from the chamber. State the intended airflow path
   in the final report. Add a finger-guard body on each fan.
2. Safety: relocate the E-stop to the upper-right shell front edge (target
   center ~600 mm above the bench plane — the review flagged 252 mm as too
   low), modeled recessed with its black bezel. Door interlock switch from D3
   wired into a safety-relay zone note. Add an interior grounding stud pattern
   (M5 studs) on the frame and each removable panel.
3. Cable management: replace the cosmetic chain-link rows with real drag-chain
   geometry — linked segments with 28 mm inner width, R38 bend radius, both
   ends anchored to machined brackets (frame→beam, beam→carriage), and a
   continuous-flex service loop to the probe head with strain reliefs at both
   ends. Add cable glands at the plinth bulkhead and rear panel, and a Y/Z
   harness route that stays inside the swept-volume clearances.

Verify D4: drag chains and loops clear all swept volumes through full travel;
fans and filters don't intersect anything; E-stop and interlock reachable and
proud of surfaces correctly.

---

## Phase D5: Materials, Mass, and DVT Release Audit

1. Confirm every body has a material; assign the stragglers.
2. Report total machine mass and center of gravity; report mass per major
   group (base+frame, gantry moving mass per axis, enclosure, plinth).
3. Full interference audit: list every intersecting pair; the only acceptable
   entries are the permitted containment classes. Target: zero defects.
4. Swept-volume re-check at all four XY corner extremes with Z at both ends.
5. Naming audit: zero "Part NNN", every vendor part named with its part-number
   family (e.g., "HGH20CA Block X1", "BK12 Fixed Support X").
6. Screenshot set: front three-quarter, direct rear, door-open service view,
   plinth tray pulled, gantry close-ups (each motor mount, one carriage block,
   Z stack, probe head section), and fixture/calibration close-up.

End state: a CAD package where the motion system is procurement-ready, the
probe and fixture are engineering geometry with real bores and compliance,
the enclosure is buildable as molded shells + folded sheet metal with real
hardware, cooling and safety are physically defined, and the studio passes a
zero-defect interference audit — the geometry baseline a DVT build and vendor
quotation can start from.

Manual follow-ups outside this prompt (not Adam's job): Onshape Assembly with
mates and motion limits, 2D drawings with tolerances, sheet-metal flat
patterns, DFM quotes, and the regulatory/labeling pass.
