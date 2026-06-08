# Internal Mechanism Requirements

## Product

Autonomous electronics bring-up and debugging station for probing populated PCBs under machine vision.

The first CAD model should cover only the internal mechanism assembly: structure, gantry, probe head, PCB fixture, cameras, cable routing, and instrument deck placeholders.

## External Product Envelope Reference

The later enclosure target is:

- Width: 750 mm
- Depth: 650 mm
- Height: 700 mm

The internal mechanism must leave clearance for enclosure panels, glass door, lighting, rear I/O, ventilation, and service access.

Recommended maximum internal mechanism envelope:

- Width: 680 mm
- Depth: 560 mm
- Height above bench/floor plane: 560 mm

## Coordinate System

- X axis: left-right across the front of the machine.
- Y axis: front-back depth.
- Z axis: vertical.
- Origin: center of the nominal PCB fixture work area on the fixture deck top surface.
- Positive X: user right when facing the machine.
- Positive Y: toward rear of machine.
- Positive Z: upward from fixture deck.

## Work Envelope

- X travel: 500 mm
- Y travel: 400 mm
- Z travel: 100 mm
- Nominal reachable PCB area: 450 mm x 350 mm
- Fixture deck clear area: at least 520 mm x 420 mm
- Minimum probe clearance above fixture deck at max Z: 120 mm
- Minimum under-deck instrument bay height: 120 mm

## Mechanism Architecture

Use a Cartesian gantry with a fixed base and fixed PCB fixture.

Recommended layout:

- Base frame supports the fixture deck and instrument deck.
- Two side Y rails run front-back on left and right frame members.
- A crossbeam spans left-right and moves along Y.
- X carriage moves left-right across the crossbeam.
- Z probe assembly rides on the X carriage.
- Probe head moves vertically on the Z stage.

This is preferred over a robot arm because it is easier to calibrate, easier to control, more repeatable for probing, and easier to manufacture.

## Motion System

### X Axis

- Travel: 500 mm
- Direction: left-right across crossbeam
- Rails: dual MGN15 or equivalent precision linear rails mounted to the crossbeam
- Drive: ballscrew, nominal 1605 class or similar
- Motor: compact industrial servo or closed-loop stepper mounted at one crossbeam end
- Bearing blocks: realistic fixed/floating ballscrew supports
- Cable path: drag chain along rear/top of crossbeam

### Y Axis

- Travel: 400 mm
- Direction: front-back
- Rails: paired MGN15 rails on left and right side frame members
- Drive: dual synchronized ballscrews or one ballscrew with torsion shaft/belt synchronization
- Motor: industrial servo or closed-loop stepper mounted at rear side of frame
- Crossbeam: stiff aluminum or machined/welded beam with gusseted end plates
- Cable path: side-mounted drag chain from fixed frame to moving crossbeam

### Z Axis

- Travel: 100 mm
- Direction: vertical
- Rails: dual MGN12 or equivalent compact linear rails
- Drive: compact ballscrew, nominal 1204 class or similar
- Motor: compact servo or closed-loop stepper mounted above or behind Z carriage
- Probe compliance: mechanical compliance is in probe head, not by flexing the Z stage

## Probe Head

The probe head is the critical subsystem and should be modeled as a compact machined aluminum assembly.

Required features:

- Rectangular machined aluminum housing.
- Four independent spring-loaded pogo probes visible beneath head.
- Probe functions represented as main probe, ground probe, differential positive probe, differential negative probe.
- Replaceable lower probe cartridge plate.
- Integrated miniature downward-facing camera near probe cluster.
- Internal force sensor or load cell stack represented inside the head.
- Cable exit upward/rearward into drag chain.
- Kinematic or dowel-pin style future tool-changer mounting interface on upper rear face.
- Small illuminated logo badge centered on the head front face for later industrial design continuity.

Probe geometry:

- Probe cluster should fit inside a 60 mm x 50 mm lower face.
- Pogo tips should extend 8-12 mm below the lower cartridge.
- Include visible compression travel allowance.
- Keep probe tips below the camera plane and centered under the Z axis.

## Contact Detection

Include a modeled force-sensing stack between the Z carriage and lower probe cartridge.

Acceptable CAD representation:

- Thin load cell plate or strain-gauge flexure block.
- Mechanical stop features that prevent overtravel.
- Cable path from sensor into the probe head harness.

Purpose:

- Detect actual pad contact.
- Limit force on PCB pads.
- Support repeatable probing.

## Vision System

### Fixed Overhead Camera

- Mounted above the work area on a rigid crossmember.
- Downward-facing.
- Centered over the fixture work envelope.
- Include adjustable bracket with slotted mounting holes.
- Include cable routing into fixed frame.

Purpose:

- Locate PCB outline.
- Locate fixture.
- Detect PCB orientation.
- Support coarse fiducial alignment.

### Probe-Mounted Camera

- Integrated into the probe head.
- Downward-facing near the pogo probe cluster.
- Include protective lens bezel.
- Include cable route through probe head to drag chain.

Purpose:

- Fine pad alignment.
- Fiducial recognition.
- Component and silkscreen targeting.

## PCB Fixture

Model a universal fixture centered on the machine floor.

Required features:

- Machined aluminum baseplate.
- Grid of threaded holes or tooling holes.
- Adjustable edge clamps on at least four sides.
- Removable tooling pins.
- Vacuum hold-down ports as optional features.
- Cable/vacuum routing through underside of plate.
- Clearance slots for clamp adjustment.

Suggested dimensions:

- Fixture plate: 520 mm x 420 mm x 18 mm
- Hole grid pitch: 25 mm
- Tooling pin holes: 4 mm and 6 mm representative holes
- Clamp bodies: low-profile machined or anodized blocks

## Instrument Deck

Below the fixture deck, model an instrumentation compartment as placeholder volume only.

Include:

- Sheet metal deck or tray below fixture.
- Mounting provisions for oscilloscope module, logic analyzer, DMM, programmable power supply, electronic load, and relay matrix.
- Cable passthroughs from probe harness to relay matrix region.
- Rear-facing service access region.
- Ventilation clearance but no external enclosure panels.

Do not model detailed oscilloscope internals, front panels, displays, knobs, or exposed test equipment.

## Cable Management

Required:

- Drag chain from fixed frame to moving Y crossbeam.
- Drag chain from Y crossbeam to X carriage.
- Compact cable loop or mini drag chain from X carriage to Z head.
- Clean routing for probe signals, camera cables, force sensor wiring, motor cables, and vacuum line.
- No loose wires crossing the work envelope.

## Structure

Preferred production intent:

- Welded aluminum frame or machined aluminum plate-and-frame construction.
- Sheet metal instrument deck below fixture.
- Gusseted corners.
- Realistic fasteners, dowel pins, bearing blocks, motor mounts, and rail mounting holes.
- Serviceable subassemblies.

Avoid:

- Consumer 3D printer aesthetics.
- Exposed electronics.
- Decorative sci-fi surfaces.
- Unsupported floating parts.
- Unrealistic monolithic molded geometry.

## Manufacturing Requirements

- Use manufacturable plate thicknesses: 3 mm sheet metal, 6-12 mm brackets, 15-20 mm machined plates where stiffness matters.
- Use realistic fastener sizes: M3 for small brackets, M4/M5 for rails and probe head, M6/M8 for frame and base.
- Include realistic panel gaps and clearances where subassemblies meet.
- Make rails and ballscrews accessible for assembly and maintenance.
- Leave access to clamp screws, fixture plate hardware, and instrument deck fasteners.

## First-Pass CAD Exclusions

Do not model:

- External enclosure covers.
- Front smoked-glass door.
- Side panels.
- Brand labels.
- Screen or user interface.
- Detailed instrument electronics.
- Robot arm.
- Decorative concept-rendering surfaces.

## Open Engineering Questions

- Required probe positioning repeatability and absolute accuracy.
- Maximum PCB size and board thickness range.
- Maximum probing force per pin.
- Target instrument bandwidth and voltage/current limits.
- Whether differential probing needs adjustable probe spacing.
- Whether vacuum hold-down is required for the first prototype.
- Whether Y drive should use dual motors or mechanical synchronization.
