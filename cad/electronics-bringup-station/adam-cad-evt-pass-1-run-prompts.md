# EVT Pass 1 — Non-Destructive Motion Grouping, Split Into 5 Adam Runs

Replaces `adam-cad-evt-pass-1-motion.prompt.md` as the thing you actually paste.
One block per Adam chat, in order. Each block is self-contained (Adam starts
fresh each session) and ends with verify-and-stop. If a run stalls, start a new
chat and re-paste the same block — it begins by checking current state.

Token guards for every run (learned from the 2026-06-11 stall): the studio has
~195 parts — never fetch the full feature tree and never enumerate all parts.
One part-metadata listing per session is allowed. All needed coordinates are
given in the run text — build by dead reckoning, do not measure legacy bodies.
Take only the single screenshot each run requests, at the end. If a run cannot
proceed without full-tree inspection, reply BLOCKED and stop.

Critical rule for every run: do not delete, suppress, or overwrite existing
bodies. This pass is for grouping systems and adding vendor-true detail so each
subsystem can be worked on separately. Keep simplified/original bodies as
reference geometry. If Adam needs to distinguish old from new, rename old bodies
with a `Legacy -` or `Reference -` prefix and create new bodies with clear
subsystem prefixes such as `X Axis -`, `Y Axis -`, `Z Axis -`, `Motion Sensors -`,
or `Analysis -`. If Onshape supports Composite Parts or folders in this context,
group the related bodies into subsystem groups. If not, use naming prefixes only.

---

## Run 1 of 5 — X Axis

```
Continue the existing Onshape Part Studio (autonomous bring-up station). This
session: add and organize the X axis only with vendor-true motion components,
non-destructively. Do not delete, suppress, overwrite, or remove any existing
body. Do not touch anything else — no enclosure, fixture, probe head, Y or Z
parts.
Preserve the coordinate system: fixture at origin, frame top at Z = 80 mm,
X travel ±250 mm.

Token rules: do not fetch the full feature tree; do not enumerate all parts;
at most one part-metadata listing; build from the coordinates below without
measuring legacy bodies; only the one screenshot requested at the end.

The bodies named X Rail Front, X Rail Rear, X Ballscrew, X Servo, X Bearing
Block Left, X Bearing Block Right are legacy/reference envelopes — keep them,
do not delete or modify them.

Known coordinates (build by dead reckoning): frame top face Z = 80; legacy X
rails run along X at Y = +300 and Y = -300, X from -300 to +300; legacy
ballscrew centerline at Y = 0, Z = 90, spanning X ±280; Moving X Beam spans
X -45 to +45, Z 98 to 168, Y -310 to +310; frame +X end face at X = 370.

1. Add two new vendor-true HIWIN HGR20-class rail bodies alongside the legacy
   rail envelopes: 20 mm wide x 17.5 mm tall profile, counterbored M5 mounting
   holes at 60 mm pitch, same positions and length as the current rails.
2. Add 4x HGH20CA-class carriage blocks (77.5 x 44.4 x 30 mm, 4x M5 holes at
   32 x 36 mm pattern), two per rail, under the Moving X Beam at ±150 mm in X
   from beam center. The rail passes through the block bore — no other
   overlap. The beam now sits ON the block top surfaces; add a 10 mm adapter
   plate between blocks and beam if heights need reconciling.
3. Add a new SFU1605 ballscrew assembly while keeping the legacy bare
   ballscrew cylinder as reference: 16 mm shaft with turned-down journal ends,
   flanged ballnut (Ø28 body, Ø48 flange) in a nut housing block bolted to the
   beam underside, BK12 fixed support at the motor end, BF12 floating support
   at the far end.
4. Fix the known X-motor collision (motor currently intersects the base frame
   ~11%): build a 10 mm aluminum motor mount plate on the frame end face
   beyond the BK12. Add a new NEMA 23 motor body (57 x 57 mm flange, Ø38.1
   pilot, 4x M4 on Ø47.14 bolt circle, Ø8 x 20 mm shaft) mounted on that
   plate, fully outside the frame solid, with a Ø25 x 30 mm jaw coupling
   spanning motor shaft to screw journal, coaxial. Keep the old oversized X
   servo as `Legacy - X Servo Envelope`.

Verify and stop: regenerate with zero errors; confirm the only containments
among new X-axis bodies are rail-through-block and screw-through-nut; rename
all new bodies descriptively with `X Axis -` prefixes (X Axis - HGR20 Rail
Front/Rear, X Axis - Carriage Block 1-4, X Axis - Ballnut, X Axis - Nut
Housing, X Axis - BK12 Support, X Axis - BF12 Support, X Axis - Motor Mount
Plate, X Axis - Motor, X Axis - Coupling). If possible, group these into an
`X Axis EVT` composite/folder while preserving every legacy body. Take one
screenshot of the X axis. Then stop — do not start the Y axis.
```

---

## Run 2 of 5 — Y Axis

```
Continue the existing Onshape Part Studio (autonomous bring-up station). This
session: add and organize the Y axis only, on the Moving X Beam,
non-destructively. Do not delete, suppress, overwrite, or remove any existing
body. Do not touch the X axis (already grouped with NEMA 23 + HGR20 rails),
enclosure, fixture, probe head, or Z parts. Preserve the coordinate system:
fixture at origin, Y travel ±200 mm.

Token rules: do not fetch the full feature tree; do not enumerate all parts;
at most one part-metadata listing; build from the coordinates below without
measuring legacy bodies; only the one screenshot requested at the end.

The bodies named Y Rail Left, Y Rail Right, Y Ballscrew, Y Servo, Y Carriage
are legacy/reference envelopes or existing structure — keep them, do not
delete or modify them.

Known coordinates (build by dead reckoning): Moving X Beam top face Z = 168,
beam spans X -45 to +45, Y -310 to +310; legacy Y rails on the beam top at
X = ±28, Y from -240 to +240, Z 168-186; legacy Y ballscrew centerline at
X = 0, Z = 177, spanning Y ±230; Y Carriage spans X ±50, Y ±60, Z 168-218.

1. Add two new vendor-true HGR15-class rail bodies on top of the beam while
   keeping the old rail envelopes: 15 mm wide profile, counterbored M4 holes
   at 60 mm pitch, same positions and length as current.
2. Add 4x HGH15CA-class carriage blocks (61.4 x 34 x 24 mm), two per rail,
   under a new or duplicated Y carriage mounting interface. Rail passes
   through the block bore only. Do not delete the existing Y Carriage; if the
   original intersects rails, keep it as reference and add an `Y Axis - Carriage
   Adapter Plate` or `Y Axis - Carriage EVT` body that sits ON the block tops.
3. Add a new SFU1204 ballscrew assembly while keeping the legacy bare
   ballscrew: journaled shaft, flanged ballnut in a nut housing bolted to the
   carriage underside, BK10 fixed support at the +Y end of the beam, BF10
   floating support at the -Y end, jaw coupling Ø20 x 25 mm.
4. Fix the known Y-motor collision (motor currently intersects the beam
   ~36%): build an offset L-bracket at the +Y end of the beam that hangs a
   NEMA 23 motor (57 x 57 flange, 4x M4 on Ø47.14 BC, Ø8 shaft) beside/below
   the beam section, coupling inline and coaxial with the Y screw, zero
   overlap with the beam solid. Keep the old Y Servo as `Legacy - Y Servo
   Envelope`.

Verify and stop: regenerate with zero errors; only rail-through-block and
screw-through-nut containments among new Y bodies; rename new bodies with
`Y Axis -` prefixes (Y Axis - HGR15 Rail Left/Right, Y Axis - Carriage Block
1-4, Y Axis - Ballnut, Y Axis - Nut Housing, Y Axis - BK10 Support, Y Axis -
BF10 Support, Y Axis - Motor Bracket, Y Axis - Motor, Y Axis - Coupling). If
possible, group these into a `Y Axis EVT` composite/folder while preserving
every legacy body. One screenshot of the beam assembly. Then stop — do not
start the Z axis.
```

---

## Run 3 of 5 — Z Stack Grouping

```
Continue the existing Onshape Part Studio (autonomous bring-up station). This
session: add and organize the Z stage only, non-destructively. Do not delete,
suppress, overwrite, or remove any existing body. Do not touch the X or Y axes
(already grouped with vendor components), enclosure, fixture, or the probe head
detail bodies. Z travel is 100 mm.

Token rules: do not fetch the full feature tree; do not enumerate all parts;
at most one part-metadata listing; build from the coordinates below without
measuring legacy bodies; only the one screenshot requested at the end.

Known problem being fixed: the Z Stage Slide is fully embedded inside the
Moving X Beam and the Z Stage Plate overlaps the beam ~40%.

Known coordinates (build by dead reckoning): Y Carriage spans X ±50, Y ±60,
Z 168-218; its front face is at Y = -60. Moving X Beam spans X ±45, Y ±310,
Z 98-168. Legacy Z plate at Y -60 to -72, Z 55-230. Probe head spans
X ±30, Y -139 to -109, Z 40-110; pogo tips reach down to Z = 0 at probe
location. Fixture/PCB top is at Z = 59.6 in front of the carriage.

1. Keep the existing Z Mounting Plate and Z Stage Slide as legacy/reference
   geometry. Add a new `Z Axis - Mounting Plate EVT` on the FRONT (-Y) face of
   the Y carriage, fully clear of the beam — no overlap with beam, carriage
   sits behind it.
2. Add 2x new MGN12-class miniature rails on the new plate front face, and add
   2x MGN12H carriage blocks behind the new Z slide. Rail through block bore
   only. Keep any old Z rail envelope as reference.
3. Add a new `Z Axis - Slide EVT` as a plate riding on those two blocks, fully
   in front of the mounting plate. Do not delete the existing Probe Head or
   detail bodies. If possible, create a copied/linked grouped position or
   adapter interface showing where the existing probe stack attaches to the new
   slide. If moving existing probe bodies is necessary, move them as a group
   without deleting any individual probe/detail part.
4. Add a new SFU1204 ballscrew assembly while keeping the legacy bare Z
   ballscrew: journaled shaft, flanged nut + housing bolted to the slide, BK10
   fixed support at the top of the plate, simple bushing support at the bottom.
   Add a new NEMA 23 motor body (57 x 57 flange, Ø8 shaft) on a top motor plate,
   jaw coupling Ø20 x 25 mm, coaxial with the screw. Keep the old Z servo as
   reference.

Verify and stop: regenerate with zero errors; zero solid overlap among beam,
carriage, new Z plate, new Z slide, probe head at park; probe tips must still
be able to reach Z = 60 mm above fixture origin within the 100 mm travel —
report the margin. Rename new bodies with `Z Axis -` prefixes (Z Axis - Rail
1/2, Z Axis - Carriage Block 1/2, Z Axis - Ballnut, Z Axis - Nut Housing,
Z Axis - BK10 Support, Z Axis - Bottom Bushing, Z Axis - Motor Plate, Z Axis -
Motor, Z Axis - Coupling). If possible, group these into a `Z Axis EVT`
composite/folder while preserving every legacy body. One screenshot of the Z
stack from the side. Then stop.
```

---

## Run 4 of 5 — Limit Switches and Swept Volumes

```
Continue the existing Onshape Part Studio (autonomous bring-up station). This
session: add travel sensors and swept-volume analysis bodies only. Do not
modify, delete, suppress, overwrite, or remove any existing body. Travels:
X ±250 mm, Y ±200 mm, Z 100 mm span.

Token rules: do not fetch the full feature tree; do not enumerate all parts;
at most one part-metadata listing; only the one screenshot requested at the
end.

1. Add simplified limit-switch bodies (20 x 10 x 7 mm with a small lever) on
   small brackets at both travel ends of each axis, plus one home-sensor body
   per axis near mid-travel: X switches on the base frame rail ends, Y
   switches on the beam ends, Z switches on the Z mounting plate. Nine small
   bodies total.
2. Add three transparent low-opacity swept-volume bodies named Swept Volume
   X, Swept Volume Y, Swept Volume Z: each is the full travel sweep of its
   moving group (X group: beam + everything riding on it swept ±250 mm; Y
   group: carriage + Z stack swept ±200 mm along the beam; Z group: slide +
   probe stack swept 100 mm vertically). Simple bounding-box sweeps are fine.

Verify and stop: regenerate with zero errors; report every static body
(frame, enclosure, camera posts, fixture, instruments) that intersects any
swept volume, with approximate overlap or minimum clearance in mm. Do not fix
anything found — just report. Rename all new bodies descriptively. One
screenshot showing the swept volumes. Then stop.
```

---

## Run 5 of 5 — Motion System Audit

```
Continue the existing Onshape Part Studio (autonomous bring-up station). This
session is audit-only: verify the grouped motion system. Do not delete,
suppress, overwrite, or remove any existing body. Create no new geometry except
non-destructive annotations/clearance bodies if needed. If you find problems,
report them and only add optional new helper/adapter bodies; do not modify or
delete existing parts unless explicitly instructed in a later session.

1. Regenerate all features; fix any errors.
2. Interference report across all new motion-system bodies and between motion
   bodies and everything else. Permitted containments: rail-through-block
   bores, screw-through-nut bores, fasteners in holes. List every other
   intersecting pair. Do not fix by deleting or replacing parts; report the
   required adjustment or add a clearly named helper/adapter body only if safe.
3. Report per-axis stack heights (rail + block + adapter plate), and confirm
   each motor shaft is coaxial with its screw journal within 0.1 mm.
4. Report clearance between the Y motor bracket and the enclosure side
   shells with the beam at X = +250 mm and X = -250 mm (use the Swept Volume
   bodies if present).
5. Naming audit: zero new bodies named "Part NNN" anywhere in the studio —
   rename any new stragglers descriptively. Do not rename unrelated legacy
   bodies unless they are part of the current motion grouping.

Token rules: do not fetch the full feature tree; do not enumerate all parts;
at most one part-metadata listing.

Finish with ONE screenshot: full gantry three-quarter view. Then
report: pass/fail per axis with the numbers above. End state: every motion
component maps to an orderable part number (HGR20/HGR15/MGN12 rails,
HGH20CA/HGH15CA/MGN12H blocks, SFU1605/SFU1204 screws, BK/BF supports,
NEMA 23 motors) or a machinable plate.
```
