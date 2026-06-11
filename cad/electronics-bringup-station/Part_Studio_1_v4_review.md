# STEP Geometry Review: Part Studio 1_v4

## Executive assessment

This is a strong system-layout and packaging model, but it is not yet fabrication-ready CAD. The file imports cleanly and the architecture is understandable, but most components are simplified envelopes and there are numerous intentional or unresolved solid-body intersections.

## File health

- Format: STEP AP242 Edition 2, exported from Onshape.
- Bodies: 169 named solids.
- Geometry validity: all 169 solids pass topology validation.
- Structure: all 169 bodies are independent top-level shapes. There is no assembly or subassembly hierarchy and no mate or motion information.
- Modeling detail: 118 bodies are six-face rectangular solids and 45 are simple cylindrical solids. Only six bodies have other face counts. This confirms that the file is primarily a packaging model.

## Overall envelope

- Full envelope including feet and protruding E-stop: approximately 1,075 x 920 x 834 mm.
- Main enclosure width excluding the E-stop projection: approximately 1,010 mm.
- Side-shell body height: approximately 782 mm.
- Work/instrument deck: 670 x 570 x 3 mm.
- Fixture plate: 520 x 420 x 18 mm.
- Sample PCB: 320 x 220 x 1.6 mm.
- Front smoked-glass area: 720 x 360 x 4 mm.

## What is working well

- The machine architecture is easy to understand.
- The lower electronics bay is separated from the upper work area.
- The X, Y, and Z motion axes are laid out logically.
- The overhead camera is centered over the fixture area.
- The power button and E-stop project through the right shell rather than being buried inside it.
- The model includes major electronics, safety relay, power supplies, controller, DAQ, oscilloscope, load, network switch, lighting, vacuum ports, PCB fixture, clamps, and cable-chain concepts.

## Critical geometry conflicts

These intersections should be resolved before detailed mechanical design or fabrication:

1. **Front surround and smoked glass**: the smoked-glass panel is completely contained inside the solid front surround. The surround needs a window cutout, recess, gasket land, and retention method.
2. **Side shells and enclosure posts**: all four enclosure posts are completely embedded within the side-shell solids. This may be intentional packaging, but it is not buildable as separate parts without hollow shells or defined pockets.
3. **Instrument deck and PCB fixture plate**: approximately 57% of the fixture plate volume intersects the instrument deck. The deck likely needs a cutout or the fixture plate needs to sit above it.
4. **PCB fixture plate and PicoScope**: the fixture plate intrudes into the PicoScope envelope by approximately 221,000 mm³.
5. **Y servo and moving X beam**: approximately 36% of the Y-servo volume intersects the moving beam. A motor pocket, offset bracket, or revised beam section is needed.
6. **Z-stage slide and moving X beam**: the Z-stage slide is fully embedded in the moving beam. The Z-stage plate also intersects the beam by approximately 40%.
7. **Cable trunk and DIN Ethernet switch**: the switch intersects the cable trunk by approximately 18.5% of the switch volume.
8. **X servo and base frame**: the X servo intersects the base frame by approximately 11% of the motor envelope.
9. **Probe stack**: the probe head, cartridge PCB, cartridge plate, bushings, and fixture plate contain several large solid intersections. Some are likely intended pass-through relationships, but the required bores and clearances are not modeled.

The file contains 134 solid-body intersections overall. Many are expected in a simplified packaging model, such as rails through carriages, dowels through parts, and DIN components on rails, but they prevent the file from serving as fabrication or interference-checking geometry in its current form.

## Missing mechanical definition

The following items are not represented or are represented only as simple envelopes:

- Linear-guide carriage blocks for the X-axis beam.
- Ballscrew nuts and nut mounts.
- Motor couplers, fixed and floating bearing supports, and end brackets.
- Motor mounting patterns and structural brackets.
- Rail mounting holes, fasteners, dowels, and serviceable joints.
- Real drag-chain links, bend radius, anchor points, and cable routing.
- Probe preload, compliant travel, anti-rotation, and hard-stop details.
- Fixture clamping mechanisms and adjustment hardware.
- Sheet-metal bends, hems, flanges, corner joints, door hardware, hinges, latches, and gasketing.
- Actual vent openings, fans, filters, ducts, and airflow paths.
- Connector access, strain relief, grounding, and cable-service loops.

## Structural and manufacturability concerns

- The 940 x 800 mm top and base panels are modeled as flat 2 mm plates with no bends or stiffening features. Large flat panels will need flanges, beads, ribs, or supporting rails depending on material and load.
- The side shells are modeled as 70 mm thick solid slabs. They should be converted into hollow sheet-metal, molded, or assembled shell geometry.
- The equipment tray and instrument deck are 3 mm flat plates. Their supports and deflection under instrument and fixture loads need to be defined.
- The rear vent field is a solid block rather than a vent pattern.
- No material assignments, tolerances, surface finishes, or fastener specifications are included, so mass, stiffness, thermal, and tolerance-stack assessment is not yet possible.

## Functional observations

- The overhead camera is approximately 225 mm above the PCB surface. This can work, but the lens field of view, focus distance, lighting, and obstruction from the moving probe head must be checked.
- The E-stop center is roughly 252 mm above the lowest foot plane and sits in the lower-right portion of the cabinet. Consider moving it higher and more directly into the operator's normal reach and sightline.
- Internal margins around the gantry are generally generous, but dynamic motion envelopes are not encoded in the file and cannot be verified from the static STEP alone.
- The front glass cannot currently provide visibility because the surrounding body has no opening.

## Recommended next steps

1. Create a true Onshape Assembly with subassemblies for enclosure, X-axis, Y-axis, Z/probe head, fixture, camera, and electronics bay.
2. Resolve the eight major packaging collisions listed above.
3. Replace the motion-system envelopes with actual vendor rail, carriage, ballscrew, nut, coupling, and motor-mount geometry.
4. Model the enclosure as manufacturable sheet metal or molded panels, including doors, seams, vents, and hardware.
5. Add fasteners, mounting holes, cable paths, service clearances, and cooling architecture.
6. Define axis travel limits and run swept-volume interference checks at all motion extremes.
7. Add materials and perform deck deflection, frame stiffness, thermal, and center-of-gravity checks.

## Bottom line

The concept and packaging are strong enough to communicate the product and guide component placement. The model should not yet be released for machining, sheet-metal fabrication, vendor quotation, or motion-system procurement without a substantial mechanical-detail pass.
