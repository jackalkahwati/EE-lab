# Adam CAD Prompt: Wrap Completed V2 Mechanism With Final Enclosure

Continue from the completed internal mechanism model exported as `Part Studio 1 (1)_v2.step`.

The current Part Studio already contains a complete internal mechanism for the autonomous electronics bring-up station:

- Matte-black welded-style base frame.
- Sheet metal instrument deck.
- X-axis rails, ballscrew, bearing blocks, and servo.
- Moving X beam.
- Y-axis rails, ballscrew, and servo.
- Y carriage.
- Vertical Z stage with rail, ballscrew, slide, and servo.
- Compact probe head with four pogo probes.
- Probe-mounted camera detail.
- Load-cell/flexure plate.
- Tool-changer interface details.
- Centered 520 mm x 420 mm PCB fixture.
- Adjustable clamps, tooling pins, and vacuum ports.
- Sample populated PCB.
- Fixed overhead camera on a bracket.
- Drag chains and cable routing.
- Instrument bay module placeholders.
- Simplified fasteners and major material appearances.

## Primary Instruction

Do not rebuild, delete, resize, or reinterpret the internal mechanism.

Treat the current mechanism as locked. Add only the external enclosure, chamber finishing, feet, ventilation, lighting, rear I/O panel, and mounting brackets required to make the final machine match the reference product images.

## Final Exterior Target

Create a production-ready external enclosure that looks like a compact professional laboratory automation appliance.

It should visually match these reference traits:

- Large black smoked-glass front chamber door.
- Thick satin-black rounded rectangular front bezel.
- Light warm-gray or white rounded side shells.
- Matte black rear service panel.
- Recessed rear-right I/O column.
- Horizontal perforated rear ventilation band.
- Blue-white internal chamber lighting.
- Thin blue lower-front status LED strip.
- Small vertical front-right power button module.
- Four black vibration-isolation feet.

The result should feel like a high-end machine from Keysight, Applied Materials, ASML, Tesla Automation, or a premium desktop CNC vendor, but for electronics bring-up and debugging.

## Overall Product Envelope

Target external dimensions:

- Width: 750 mm.
- Depth: 650 mm.
- Height: 700 mm.

Use the current internal mechanism as the center reference. Preserve clearance around it:

- Left side clearance: approximately 35 mm.
- Right side clearance: approximately 35 mm.
- Front door/glass clearance: approximately 45 mm.
- Rear service/I/O clearance: approximately 45 mm.
- Top clearance: 80-100 mm for lighting, overhead camera clearance, and enclosure structure.
- Bottom clearance: 40-60 mm for base plinth and vibration feet.

If exact dimensions conflict with the already completed mechanism, prioritize preserving the mechanism and adjust enclosure wall thicknesses slightly.

## Locked Mechanism Constraints

Preserve:

- X travel: 500 mm.
- Y travel: 400 mm.
- Z travel: 100 mm.
- Centered PCB fixture.
- Sample PCB and clamps.
- Probe-head reach to the PCB.
- Overhead camera line of sight.
- Cable-chain motion paths.
- Rear access to instrument bay.
- Existing internal module placeholders.

Do not add any external geometry that collides with the gantry, probe head, overhead camera, cable chains, or fixture clamps.

## Front Door and Window

Create a single-piece front access door:

- Large smoked tempered-glass or dark tinted polycarbonate window.
- Window occupies about 70 percent of the front face.
- Thick black rounded rectangular bezel around the glass.
- Soft-radius corners matching the reference image.
- Hidden hinge or clean industrial hinge detail.
- Minimal recessed pull or edge-grip detail.
- No front screws on the primary visual surface.

The internal gantry, probe head, PCB fixture, and chamber lighting should be visible through the smoked front.

Do not add:

- Touchscreen.
- Labels.
- Keypad.
- Knobs.
- Front instrument readouts.
- Consumer-style trim.

## Front Controls and Status Lighting

Add only these front controls:

- One vertical rounded black power-button module integrated into the front-right edge.
- One small circular illuminated power button or power symbol.
- One slim blue status LED light bar near the lower front edge, centered or slightly right-weighted.

Keep this restrained and premium.

## Side Shells and Corners

Model the sides like the reference images:

- Smooth light warm-gray or white side panels.
- Large-radius vertical rounded side shells or corner covers.
- Black inner front bezel wraps around into the side slightly.
- Subtle horizontal panel gap near the top and bottom.
- Optional precision perforated side ventilation field on the right side.

Manufacturing interpretation:

- Use formed sheet metal panels plus molded/machined rounded corner covers.
- Keep panel gaps realistic.
- Hidden fasteners on primary side surfaces.
- Service screws only where necessary and preferably toward rear or underside.

## Rear Service Panel

Create a rear face matching the reference rear image:

- Large matte black rear service panel.
- Light rounded side shells visible at left and right edges.
- Horizontal perforated ventilation band across the lower-middle rear panel.
- Small perimeter service screws.
- Recessed vertical I/O column on the rear-right side.

Rear I/O column must include only:

- One RJ45 Ethernet port.
- One USB-C service port.
- One IEC AC inlet.
- One rocker power switch.

No other connectors.

Do not add labels except extremely small service markings if unavoidable. Prefer no text labels.

## Chamber Finishing

Add interior finishing around the existing mechanism:

- Dark matte inner chamber walls.
- Concealed LED light strips along the upper interior left and right edges.
- Cool white to blue-white LED appearance.
- Black inner frame surfaces.
- Clear view from the front glass to the mechanism and sample PCB.
- No loose exposed wiring.
- No exposed benchtop instruments.

The chamber should look clean but serviceable.

## Base and Feet

Add a black lower base/plinth:

- Slightly recessed relative to the front door face.
- Integrated slim blue status LED strip.
- Four black industrial vibration-isolation feet.
- Feet should be short, wide, and credible for bench-top lab equipment.

## Ventilation

Add filtered ventilation paths:

- Rear horizontal perforated band.
- Optional right-side precision perforated panel field.
- Keep airflow believable for the instrument bay and electronic load.
- Do not expose internal electronics.

Use small circular or rounded rectangular perforations in a clean grid.

## Materials and Appearances

Apply or represent these appearances:

- Front bezel: satin black anodized aluminum or black powder-coated metal.
- Window: dark translucent smoked glass.
- Side shells: light warm-gray or off-white powder-coated aluminum or molded polymer.
- Rear panel: matte black powder-coated sheet metal.
- Inner chamber: matte black.
- LED strips: subtle blue-white.
- Status LED: blue.
- Feet: black rubber over metal.
- Existing mechanism: keep current colors unless a minor appearance change improves readability.

## Manufacturing Requirements

Make the enclosure look production-ready:

- Sheet metal panels suitable for laser cutting and bending.
- Aluminum internal frame or brackets.
- Molded, machined, or extruded rounded corner covers.
- Realistic bend radii.
- Realistic panel gaps.
- Removable rear and side service panels.
- Hidden front fasteners.
- Rear screws only where serviceable.
- Access to rear I/O and ventilation filter.
- No impossible one-piece monolithic shell.
- No sci-fi styling.

## Enclosure Mounting

Add simple mounting brackets or tabs tying the enclosure to the existing internal base frame:

- Use base-frame tabs, rear brackets, and upper standoffs.
- Do not mount enclosure geometry to linear rails, ballscrews, probe head, fixture tooling holes, or cable chains.

## Organization

Name new major bodies/features clearly:

- Front Door Assembly.
- Smoked Viewing Window.
- Black Front Bezel.
- Front Power Button Module.
- Lower Status LED Strip.
- Left Rounded Side Shell.
- Right Rounded Side Shell.
- Top Cover.
- Rear Service Panel.
- Rear I/O Column.
- Rear Ventilation Band.
- Chamber LED Strips.
- Lower Base Plinth.
- Vibration Isolation Feet.
- Enclosure Mounting Brackets.

## Verification Before Stopping

Before finishing:

- Confirm all features regenerate without errors.
- Confirm the enclosure does not collide with gantry travel.
- Confirm the probe head still visually reaches the sample PCB.
- Confirm the overhead camera still has line of sight.
- Confirm the front glass gives a clear view of the internal mechanism.
- Confirm rear I/O contains only Ethernet, USB-C, IEC power, and rocker switch.
- Confirm no touchscreen, labels, exposed instruments, or extra connectors were added.

End with the completed mechanism enclosed in a reference-image-matched production exterior.
