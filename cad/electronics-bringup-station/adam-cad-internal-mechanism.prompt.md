# Adam CAD Prompt: Internal Mechanism Assembly

Create a production-ready CAD assembly for the internal mechanism of an autonomous AI-powered electronics bring-up and debugging station.

Model only the internal mechanism assembly. Do not model external covers, doors, smoked glass, side panels, branding, displays, labels, or enclosure skins.

## Purpose

The machine automatically probes populated printed circuit boards for bring-up, debugging, voltage measurement, continuity checks, digital logic capture, differential signal probing, and vision-assisted test alignment.

The CAD should look like a real industrial machine mechanism that could be manufactured and assembled, not a concept rendering.

## Coordinate System

Use this coordinate system:

- X axis: left-right across the machine front.
- Y axis: front-back depth.
- Z axis: vertical.
- Origin: center of PCB fixture top surface.
- Positive X: user right when facing the front.
- Positive Y: toward the rear.
- Positive Z: upward.

## Overall Internal Envelope

Design the internal assembly to fit inside a future external enclosure approximately 750 mm wide x 650 mm deep x 700 mm tall.

The internal mechanism should stay within this approximate envelope:

- Width: 680 mm maximum
- Depth: 560 mm maximum
- Height: 560 mm maximum above bench/floor plane

Leave clear space around the mechanism for future sheet metal panels, front glass door, side service panels, rear I/O, lighting, and ventilation.

## Work Envelope

- X travel: 500 mm
- Y travel: 400 mm
- Z travel: 100 mm
- Nominal reachable PCB probing area: 450 mm x 350 mm
- Fixture deck clear area: at least 520 mm x 420 mm
- Minimum probe clearance above fixture deck at max Z: 120 mm

## Architecture

Use a Cartesian gantry with a fixed base and fixed PCB fixture.

Layout:

- Fixed aluminum base frame.
- Fixed machined PCB fixture plate centered on the machine floor.
- Left and right Y-axis linear rails running front-back on side frame members.
- Moving crossbeam that travels in Y.
- X-axis carriage moving left-right across the crossbeam.
- Z-axis probe assembly mounted to the X carriage.
- Compact probe head at the bottom of the Z stage.

Do not use a robot arm.

## Motion System

### Y Axis

Model paired Y-axis rail assemblies on the left and right sides of the machine:

- 400 mm travel.
- MGN15-class precision linear rails or equivalent.
- Moving gantry crossbeam spanning across the width.
- Ballscrew-driven motion.
- Dual synchronized ballscrews or a single motor with belt/torsion-shaft synchronization.
- Industrial servo motor or closed-loop stepper mounted near the rear of the frame.
- Realistic bearing blocks, motor mount, coupler, and rail fasteners.
- Side-mounted drag chain from fixed frame to moving crossbeam.

### X Axis

Model the X axis on the moving crossbeam:

- 500 mm travel.
- Dual MGN15-class linear rails mounted to the crossbeam.
- Ballscrew drive, nominal 1605 class or visually similar.
- Compact industrial servo motor or closed-loop stepper mounted at one end of the crossbeam.
- Realistic fixed and floating ballscrew support blocks.
- X carriage plate riding on four rail blocks.
- Drag chain routed cleanly along the rear or top of the crossbeam.

### Z Axis

Model a vertical Z stage on the X carriage:

- 100 mm travel.
- Dual MGN12-class linear rails.
- Compact ballscrew, nominal 1204 class or visually similar.
- Compact servo or closed-loop stepper above or behind the Z carriage.
- Rigid machined carriage plate.
- Probe head mounted below the Z carriage.
- Mechanical travel stops.

## Probe Head

Create a compact rectangular machined aluminum probe head.

Required features:

- Premium machined aluminum housing.
- Replaceable lower probe cartridge plate.
- Four independent spring-loaded pogo probes visible beneath the head.
- Probe identities represented visually as:
  - main signal probe
  - local ground probe
  - differential positive probe
  - differential negative probe
- Integrated miniature downward-facing camera near the probe cluster.
- Protective camera lens bezel.
- Internal force sensor or load-cell stack between the Z carriage and probe cartridge.
- Mechanical overtravel stop features.
- Cable exit upward and rearward into the drag chain.
- Dowel-pin or kinematic-style tool changer interface on the upper/rear face for future automatic tool changing.
- Small illuminated logo badge centered on the probe head front face.

Probe head approximate size:

- Width: 90 mm
- Depth: 70 mm
- Height: 75 mm
- Lower probe cluster within 60 mm x 50 mm
- Pogo tips extend 8-12 mm below the lower cartridge

The head should look like professional industrial test automation equipment, not hobby robotics.

## Contact Detection

Include a realistic modeled contact sensing feature:

- Thin load cell plate, strain-gauge flexure block, or force-sensor stack inside the probe head.
- Sensor cable route into the probe head harness.
- Mechanical hard stops to prevent pogo pin and PCB damage.

Purpose: detect actual pad contact and limit probing force.

## Vision System

Include two cameras.

### Fixed Overhead Camera

- Downward-facing camera above the work area.
- Mounted to a rigid frame crossmember.
- Centered above the fixture plate.
- Adjustable bracket with slotted holes.
- Clean cable route into fixed frame.

Purpose: locate PCB, fixture, board orientation, and fiducials.

### Probe-Mounted Camera

- Integrated into probe head.
- Downward-facing near pogo probes.
- Used for fine targeting of pads, fiducials, components, and silkscreen.

## PCB Fixture

Model a universal PCB fixture centered below the gantry.

Required features:

- Machined aluminum fixture plate, approximately 520 mm x 420 mm x 18 mm.
- 25 mm grid of threaded or tooling holes.
- Adjustable low-profile edge clamps on all four sides.
- Removable tooling pins.
- Vacuum hold-down ports and underside routing holes.
- Slots for clamp adjustment.
- Realistic fasteners.

The PCB fixture must remain fixed. The board does not move during probing.

## Instrument Deck

Below the fixture plate, model a sheet metal or machined tray that represents the internal instrument bay.

Include placeholder mounting zones for:

- 4-channel oscilloscope module.
- 16-channel logic analyzer.
- Precision DMM.
- Programmable power supply, 0-30 V class.
- Electronic load.
- Relay matrix that routes probes to instruments.

Do not model detailed electronic front panels, displays, knobs, or exposed lab instruments. Represent instrumentation as clean internal modules mounted below the deck with cable passthroughs.

## Cable Management

Add realistic cable management:

- Drag chain from fixed frame to moving Y gantry.
- Drag chain from moving gantry to X carriage.
- Compact cable loop or mini drag chain from X carriage to Z probe head.
- Clean routing for probe signals, camera cables, motor cables, force sensor wiring, and optional vacuum line.
- No loose wires across the work envelope.

## Structure and Materials

Use a production-intent structure:

- Welded aluminum or machined aluminum frame.
- Gusseted frame corners.
- Machined aluminum crossbeam.
- Sheet metal instrument deck.
- Realistic brackets, bearing blocks, standoffs, fasteners, dowel pins, cable brackets, and service clearances.

Use visual material choices:

- Matte black anodized aluminum for main structural plates.
- Dark gray anodized aluminum for crossbeam and probe head.
- Brushed or bead-blasted aluminum for fixture plate.
- Black cable chains.
- Stainless or black oxide fasteners.

## Manufacturing Rules

- Use manufacturable plate thicknesses: 3 mm sheet metal, 6-12 mm brackets, 15-20 mm fixture and structural plates.
- Use realistic fastener sizes: M3 for small brackets, M4/M5 for rails and probe head, M6/M8 for frame and base.
- Include rail mounting holes, motor mounting holes, bearing block mounting holes, and service-access fasteners.
- Make linear rails, ballscrews, motors, fixture clamps, and probe head serviceable.
- Avoid unsupported floating parts.
- Avoid decorative sci-fi surfaces.
- Avoid consumer 3D printer aesthetics.

## Output Expectations

Produce an assembly with clearly separated subassemblies:

- Base frame
- Fixture plate and clamps
- Y-axis rail and drive system
- Moving gantry crossbeam
- X-axis carriage and drive system
- Z-axis stage
- Probe head
- Fixed overhead camera
- Instrument deck placeholders
- Cable management

The result should be ready for later enclosure modeling around the internal mechanism.
