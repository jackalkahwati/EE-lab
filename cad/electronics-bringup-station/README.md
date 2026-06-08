# Autonomous Electronics Bring-Up Station CAD Package

This folder converts the concept into CAD-ready inputs for Adam CAD / Onshape.

The recommended modeling order is:

1. Model the internal mechanism assembly first.
2. Lock the work envelope, datums, fixture deck, gantry clearance, service volumes, and cable paths.
3. Wrap the external enclosure around the mechanism in a later revision.

## Files

- `internal-mechanism-requirements.md` - Engineering requirements for the gantry, probe head, fixture, vision system, instrumentation deck, and manufacturability.
- `adam-cad-internal-mechanism.prompt.md` - Primary prompt to paste into Adam CAD for the internal mechanism assembly.
- `adam-cad-current-model-continuation.prompt.md` - Continuation prompt for the current Adam/Onshape mechanism model after the partial build.
- `mechanism-interface-control.md` - Datums, interface envelopes, reserved volumes, and constraints needed before enclosure CAD.
- `mechanism-bom-seed.csv` - Initial component list for CAD placeholders and procurement research.
- `adam-cad-enclosure-later.prompt.md` - Later prompt for the external industrial enclosure after the mechanism is modeled.
- `adam-cad-final-machine-image-reference.prompt.md` - Final enclosure prompt matched to the supplied front and rear reference images.
- `adam-cad-wrap-v2-mechanism-enclosure.prompt.md` - Current next-step prompt for wrapping the completed `Part Studio 1 (1)_v2.step` mechanism with the final enclosure.
- `visual-design-reference.md` - Visual design notes extracted from the supplied product reference images.
- `flagship-bom-and-scope-options.md` - Flagship BOM cost model and COTS oscilloscope options.
- `flagship-cots-sourcing-bom.md` - Sourced COTS part recommendations for instrumentation, motion, vision, probe, control, safety, and fixture subsystems.
- `flagship-cots-sourcing-bom.csv` - CSV-style line-item sourcing BOM for RFQ/procurement work.

## Intent

The first CAD pass should produce a realistic production-intent internal machine mechanism, not a sci-fi product rendering. It should look manufacturable using aluminum extrusion or welded aluminum frame members, machined plates, sheet metal decks, commercial linear rails, ballscrews, servo motors, cable chains, cameras, and realistic fasteners.

## High-Level Architecture

- Fixed PCB fixture and instrument deck.
- Cartesian gantry over the fixture.
- X travel: 500 mm left-right.
- Y travel: 400 mm front-back.
- Z travel: 100 mm vertical.
- Probe head with four spring-loaded pogo probes, head camera, force sensing, and future tool-change interface.
- Fixed overhead camera above the work area.
- Relay/instrumentation bay below the fixture deck.

Do not model external covers, front door, side panels, branding, screens, or enclosure surfaces in the first mechanism pass.

## Current Adam CAD Workflow

Adam first produced `Part Studio 1.step`, then the continuation pass produced `Part Studio 1 (1)_v2.step` with the completed internal mechanism.

Use `adam-cad-wrap-v2-mechanism-enclosure.prompt.md` next. It treats the completed v2 mechanism as locked and asks Adam to add only the final image-matched enclosure.
