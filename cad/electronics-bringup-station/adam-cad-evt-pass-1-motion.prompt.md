# Adam CAD Prompt: EVT Pass 1 — Motion Architecture Detail

Continue the existing Onshape Part Studio. This pass changes the rules: the
mechanism freeze is lifted for the motion system only. The goal is no longer
packaging or appearance — it is resolving the motion-hardware interfaces so this
geometry can drive an EVT build and real component procurement. The independent
STEP review found the motion system is envelopes with major collisions; this pass
replaces it with vendor-true geometry.

Do not touch: enclosure bodies, plinth instruments, fixture plate, sample PCB,
overhead camera, probe head detail bodies (those are EVT Pass 2). Preserve the
coordinate system and travels: X 500 mm, Y 400 mm, Z 100 mm, fixture centered at
origin, frame top at Z = 80 mm.

Reference components (model dimensionally-true simplified geometry with correct
interface dimensions and mounting hole patterns — external cosmetic detail like
ball tracks and seals is not needed):

- X axis: 2x HIWIN HGR20-class rail (20 mm wide x 17.5 mm tall, M5 mounting
  holes at 60 mm pitch), 4x HGH20CA-class carriage blocks (77.5 x 44.4 x 30 mm,
  4x M5 mounting holes at 32 x 36 mm pattern). Ballscrew SFU1605 (16 mm dia,
  5 mm lead) with flanged nut (Ø28 body, Ø48 flange, bolt circle per catalog),
  BK12 fixed end support, BF12 floating end support, jaw coupling Ø25 x 30 mm.
- Y axis: 2x HGR15-class rail (15 mm wide, M4 holes at 60 mm pitch), 4x
  HGH15CA-class blocks (61.4 x 34 x 24 mm). Ballscrew SFU1204 with flanged nut,
  BK10/BF10 supports, jaw coupling Ø20 x 25 mm.
- Z axis: 2x MGN12-class miniature rails, 2x MGN12H blocks. Ballscrew SFU1204
  (or 1004), BK10 fixed support top, simple bushing at bottom.
- Motors: NEMA 23 closed-loop steppers (57 x 57 mm flange, Ø38.1 pilot, 4x M4
  on Ø47.14 bolt circle pattern, Ø8 shaft x 20 mm) for all three axes, driven by
  the Galil DMC-4133 already in the plinth. Replace the oversized servo
  envelopes with these.

## Step 1: Fix the three structural collisions first

The review found these; resolve them with real mounting geometry, not by nudging
envelopes:

1. X servo intersects the base frame (~11% of motor volume). Build an X motor
   mount plate (10 mm aluminum) bolted to the frame end face beyond the BK12
   support, with the NEMA 23 on its 4-hole pattern and pilot bore. The motor
   body must sit fully outside the frame solid with the coupling spanning the
   gap.
2. Y servo intersects the moving X beam (~36%). Build an offset motor bracket at
   the +Y end of the beam: an L-plate that hangs the motor beside/below the beam
   section, coupling inline with the Y ballscrew. Zero overlap with the beam
   solid.
3. Z-stage slide is fully embedded in the moving beam, and the Z-stage plate
   overlaps the beam ~40%. Rebuild the Z stack positions: Y carriage rides on
   top of the beam on its four HGH15 blocks; the Z mounting plate hangs on the
   FRONT (-Y) face of the carriage, fully clear of the beam; the Z slide and
   rails sit on the front of that plate. Verify zero solid overlap among beam,
   carriage, plate, slide at park.

## Step 2: Rails and carriage blocks

- Replace the four rail envelopes (X Rail Front/Rear, Y Rail Left/Right) and add
  the Z rails with vendor-true rail cross-sections including counterbored
  mounting hole representations at correct pitch.
- Add the carriage blocks the review found missing: 4x HGH20 under the moving X
  beam (two per X rail), 4x HGH15 under the Y carriage, 2x MGN12H behind the Z
  slide. Blocks wrap their rail with the catalog block cross-section — rail
  passes through the block bore, no other overlap.
- The moving X beam now sits ON its blocks (beam underside mates to block top
  surfaces, with a 10 mm adapter plate if heights need reconciling). Same
  pattern for Y carriage and Z slide.

## Step 3: Ballscrew assemblies

For each axis: screw shaft with turned-down journal ends, flanged ballnut at the
moving member with a nut housing block bolted to it (beam, carriage, or slide),
BK-class fixed bearing block at the motor end, BF-class floating block at the far
end, jaw coupling connecting motor shaft to screw journal. The existing bare
screw cylinders get replaced. Nut housings must transmit to the moving member
with a real bolted joint face — no floating nuts.

## Step 4: Travel definition and sensors

- Add small limit-switch bodies (simplified 20 x 10 x 7 mm with lever) at both
  ends of each axis travel plus a home sensor per axis, mounted on brackets.
- Add three transparent swept-volume check bodies (one per axis, low-opacity
  color) representing the full travel sweep of each moving group: X group
  ±250 mm, Y group ±200 mm, Z group 100 mm span. Name them Swept Volume X/Y/Z.
  These are analysis bodies — confirm no static body (frame, enclosure, camera
  posts, fixture, instruments) intersects them, and report minimum clearances.

## Step 5: Verify and report

- Regenerate with zero errors.
- Run an interference report across all motion-system bodies: the only permitted
  containments are rail-through-block bores and screw-through-nut bores. List
  any other intersecting pair; the target is zero.
- Report: per-axis stack heights (rail + block + plate), coupling alignment
  (motor shaft and screw journal coaxial within 0.1 mm in the model), and the
  clearance between the Y-motor bracket at X = ±250 mm travel extremes and the
  enclosure shells.
- Rename all new bodies descriptively (X Carriage Block 1–4, X Ballnut, X Nut
  Housing, BK12 Fixed Support, X Motor Mount Plate, X Limit Switch Min/Max, …).
  Zero "Part NNN" names.
- Screenshots: full gantry three-quarter view, close-up of each motor mount,
  close-up of one carriage block on rail, and the Z stack from the side.

End state: a motion system whose every component maps to an orderable part
number or a machinable plate, with zero unintended solid intersections, ready
for EVT Phase 2 procurement.
