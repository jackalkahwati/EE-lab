# Mechanism Interface Control

This file defines the constraints the internal mechanism should preserve so the external enclosure can be modeled cleanly later.

## Reference Enclosure Envelope

Target external product envelope:

- Width: 750 mm
- Depth: 650 mm
- Height: 700 mm

Recommended internal mechanism maximum:

- Width: 680 mm
- Depth: 560 mm
- Height: 560 mm

Recommended remaining clearance:

- Left side enclosure clearance: 35 mm
- Right side enclosure clearance: 35 mm
- Front door/window clearance: 45 mm
- Rear service/I/O clearance: 45 mm
- Top lighting/camera/enclosure clearance: 80-100 mm
- Bottom vibration feet/base clearance: 40-60 mm

## Primary Datums

Use these datums across all CAD files:

- Datum A: fixture plate top surface.
- Datum B: fixture plate centerline in X.
- Datum C: fixture plate centerline in Y.
- Datum D: rear face of internal base frame.
- Datum E: left side face of internal base frame.

The enclosure should reference the internal mechanism through base-frame mounting points, not through rail surfaces or probe head geometry.

## Fixture Mounting Interface

Fixture plate:

- Nominal size: 520 mm x 420 mm x 18 mm.
- Top surface is Datum A.
- Center of plate is machine origin.
- Include 25 mm grid of threaded/tooling holes.
- Include removable tooling pins.
- Include slots for adjustable clamps.

Reserved zones:

- Keep the central 450 mm x 350 mm work area clear for PCB placement and probing.
- Clamp adjustment can intrude outside the central work area.
- Vacuum ports may pass through the plate but should not interfere with clamp slots.

## Gantry Clearance

Probe head:

- Must reach all points inside 450 mm x 350 mm nominal PCB work area.
- Must maintain at least 120 mm clearance above fixture deck at max Z.
- Lower probe tips should be the lowest moving part during probing.

Gantry:

- Crossbeam and X carriage must clear fixture clamps at all Y positions.
- Cable chains must never cross the probing work envelope.
- Travel stops must be modeled at each axis end.

## Instrument Bay Interface

The instrument bay sits below the fixture deck and should be reserved as an internal service volume.

Minimum volume:

- Width: 600 mm
- Depth: 460 mm
- Height: 120 mm

Recommended module zones:

- Relay matrix: directly below or rear-below fixture center.
- Oscilloscope and logic analyzer: rear-left internal bay.
- DMM and power supply: rear-right internal bay.
- Electronic load: rear-right or low-rear bay with thermal clearance.

Cable pass-throughs:

- Probe harness down to relay matrix.
- Camera cables to controller bay.
- Force sensor wire to controller bay.
- Vacuum line to rear service area if included.

## Rear Service Interface

Keep the rear of the internal mechanism clear for later rear panel features:

- IEC power inlet.
- Power switch.
- RJ45 Ethernet.
- USB-C service port.
- Filtered ventilation section.
- Internal service access to instrumentation bay.

Do not place irreversible structural members across the rear I/O service zone.

## Ventilation and Thermal Keep-Outs

Reserve airflow paths:

- Rear filtered intake or exhaust section.
- Under-deck airflow across power supply, electronic load, and relay matrix.
- Side clearance for future perforated service panels.

Do not block the rear 45 mm clearance zone with motors, fixed brackets, or permanent cable bundles unless routing can be serviced.

## Camera and Lighting Interfaces

Fixed overhead camera:

- Mounted to upper internal crossmember.
- Centered above fixture.
- Requires clear optical path to entire fixture work area.

Future lighting:

- Reserve space inside the enclosure frame for concealed LED light strips.
- Avoid placing cable chains where they would shadow the entire fixture area.

## Enclosure Mounting Interface

The later enclosure should mount to:

- Base frame mounting bosses or tabs.
- Rear service bracket mounts.
- Upper frame standoffs.

Avoid using these as enclosure references:

- Linear rails.
- Ballscrews.
- Bearing blocks.
- Probe head.
- Fixture tooling holes.

## Serviceability Requirements

The mechanism CAD should preserve access to:

- Linear rail fasteners.
- Ballscrew bearing blocks.
- Motor mounts and couplers.
- Fixture clamp screws.
- Probe cartridge fasteners.
- Camera brackets.
- Cable chain anchor points.
- Instrument deck module screws.

## Later Enclosure Constraints

When enclosure CAD begins, maintain:

- Large smoked front viewing window.
- Single-piece front access door.
- Smooth removable side service panels.
- Rear I/O panel with minimal connectors.
- Filtered rear ventilation.
- Hidden or minimized primary-surface fasteners.
- Four industrial vibration-isolation feet.

The enclosure should wrap the mechanism without changing the machine coordinate system or probe work envelope.
