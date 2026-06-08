# Adam CAD Prompt: External Enclosure Later Revision

Use this after the internal mechanism assembly has been modeled and approved.

Create a production-ready external enclosure for a commercial AI-powered electronics bring-up and debugging appliance. Wrap the enclosure around the provided internal mechanism assembly without changing the mechanism coordinate system, fixture location, gantry travel, or probe work envelope.

## Design Language

Design the product like premium industrial equipment from high-end semiconductor tools, desktop CNC machines, or professional laboratory automation systems.

Visual direction:

- Enterprise-grade industrial appearance.
- Minimal, clean, and manufacturable.
- No consumer styling.
- No exposed electronics.
- No exposed lab instruments.
- Matte black and dark gray anodized aluminum.
- Rounded vertical corner extrusions or molded corner covers.
- Flush-mounted panels.
- Hidden fasteners wherever possible.
- Product should feel credible next to equipment from Keysight, Applied Materials, ASML, or Tesla Automation.

## Overall Dimensions

Target external envelope:

- Width: 750 mm
- Depth: 650 mm
- Height: 700 mm

Maintain internal clearances around the previously modeled mechanism:

- Left clearance: approximately 35 mm.
- Right clearance: approximately 35 mm.
- Front door/window clearance: approximately 45 mm.
- Rear service/I/O clearance: approximately 45 mm.
- Top lighting/camera/enclosure clearance: 80-100 mm.
- Bottom foot/base clearance: 40-60 mm.

## Front

Create a single-piece front access door with:

- Large smoked tempered-glass viewing window occupying approximately 70 percent of the front face.
- Soft-radius window corners.
- Flush door frame.
- Hidden hinge or clean industrial hinge detail.
- Minimal door pull or recessed edge grip.
- Small illuminated logo badge centered visually on the internal gantry/probe head area, visible through the glass.
- Minimal status LED light bar near the lower front edge.
- Single power button integrated into the front-right corner.

Do not include screens, labels, knobs, exposed instrumentation, or decorative consumer UI elements.

## Internal Chamber Visibility

The enclosure should reveal the internal precision mechanism through the smoked glass:

- Cartesian gantry.
- Probe head.
- PCB fixture.
- Concealed internal LED light strips.

Do not change the internal mechanism geometry.

## Side Panels

Create smooth removable service panels:

- Flush-mounted sheet metal or aluminum panels.
- Hidden or minimized fasteners.
- Precision perforated ventilation patterns integrated into side panels where appropriate.
- Realistic panel gaps.
- Serviceable access to motors, cable chains, fixture deck, and instrument bay.

## Rear

Create a minimal rear service and I/O panel with:

- One IEC power connector.
- One RJ45 Ethernet port.
- One USB-C service port.
- One power switch.
- Large filtered ventilation section.
- Rear panel fasteners placed cleanly and realistically.

Do not add additional connectors.

## Base and Feet

Create a robust lower base:

- Hidden instrumentation compartment below fixture deck.
- Four industrial vibration-isolation feet.
- Feet should look rated for laboratory equipment.
- Base should provide airflow and service access without exposing electronics.

## Materials and Manufacturing

Use production-intent geometry:

- Sheet metal enclosure suitable for laser cutting and bending.
- Aluminum frame construction.
- Injection-molded or machined rounded corner covers.
- Realistic panel gaps.
- Realistic bend radii.
- Service panels removable for maintenance.
- Hidden fasteners on primary visible surfaces.
- Accessible fasteners on rear and underside service regions.

## Constraints

Preserve:

- Internal mechanism position.
- PCB fixture origin.
- X travel: 500 mm.
- Y travel: 400 mm.
- Z travel: 100 mm.
- Probe head clearance.
- Overhead camera line of sight.
- Cable chain motion clearance.
- Rear instrument bay access.

Do not model:

- Detailed electronics.
- Front-panel screens.
- Consumer buttons or labels.
- Sci-fi decorative surfaces.
- Exposed oscilloscopes or lab instruments.

## Output Expectations

Create clearly separated enclosure subassemblies:

- Aluminum structural frame.
- Front smoked-glass access door.
- Left service panel.
- Right service panel.
- Rear I/O and ventilation panel.
- Top cover.
- Base cover and foot mounts.
- Internal concealed LED strips.
- Panel fasteners and hinges.

The enclosure should make the machine look like a realistic product that could be manufactured and sold as professional industrial automation equipment.
