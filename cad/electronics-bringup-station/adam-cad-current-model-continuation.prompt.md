# Adam CAD Prompt: Continue Current Mechanism Model

Continue the existing Onshape Part Studio mechanism model. Do not restart the assembly and do not delete the existing variables or features.

The current model already contains:

- Global variables for `X_travel`, `Y_travel`, `Z_travel`, `margin`, `frame_L`, `frame_W`, `ext`, `rail_w`, `rail_h`, and `screw_d`.
- Welded-style base frame.
- Sheet metal instrument deck.
- X-axis rails, central X ballscrew, bearing blocks, and X servo.
- Moving X beam.
- Y-axis rails, Y ballscrew, and Y servo on the moving beam.
- Y carriage.
- Vertical Z mounting plate.
- Z rail, Z ballscrew, Z slide, and Z servo.
- Probe head housing.
- A started sketch for the four pogo probes.

Your task is to finish the internal mechanism assembly as a clean, production-intent master model.

## Important Constraints

- Preserve the existing coordinate system and work envelope.
- Preserve X travel = 500 mm, Y travel = 400 mm, Z travel = 100 mm.
- Keep the fixed PCB fixture centered at the origin.
- Do not model the external enclosure yet.
- Do not add doors, side panels, smoked glass, screens, branding, or outer covers.
- Keep all geometry manufacturable and serviceable.

## Step 1: Finish Pogo Probe Cluster

Complete the four spring-loaded pogo probes under the existing probe head housing.

Requirements:

- Four thin cylindrical pogo probes arranged in a compact 2 x 2 cluster.
- Probe identities:
  - main signal probe
  - ground probe
  - differential positive probe
  - differential negative probe
- Tips should extend downward below the probe housing toward the fixture plane.
- Use realistic proportions:
  - Probe body diameter: 3-4 mm.
  - Probe tip diameter: 1-2 mm.
  - Exposed length below housing: 30-40 mm.
- Add small collars or cartridge bushings at the probe head lower face.
- Keep the probe cluster centered under the Z axis.

## Step 2: Add Probe Head Details

Add production-intent details to the probe head:

- Replaceable lower probe cartridge plate.
- Small downward-facing miniature camera pocket with lens bezel.
- Thin internal force-sensor plate or load-cell flexure between Z slide and probe housing.
- Cable exit boss at upper rear of probe head.
- Future tool-changer interface: two dowel-pin holes and a rectangular mounting pad on the rear or upper face.
- Mechanical hard stops or limit tabs to prevent overtravel.

Keep the probe head compact and machined-looking.

## Step 3: Add PCB Fixture Assembly

Create the fixed universal PCB fixture centered at the origin on the machine floor.

Requirements:

- Aluminum fixture plate approximately 520 mm x 420 mm x 18 mm.
- Top surface near the machine origin plane.
- 25 mm grid of small threaded/tooling holes represented by shallow circular features or visual holes.
- Adjustable low-profile clamps on all four sides.
- Removable tooling pins.
- Four small vacuum hold-down ports.
- A sample populated PCB board on top of the fixture, centered and clamped.

PCB visual requirements:

- Green rectangular PCB, approximately 320 mm x 220 mm x 1.6 mm.
- Add simple component placeholders: IC blocks, connectors, capacitors, and headers.
- Keep components low enough to clear the probe head.
- Do not over-detail electronics.

## Step 4: Add Fixed Overhead Camera

Add a fixed overhead camera above the work area.

Requirements:

- Downward-facing industrial camera centered over the fixture.
- Mounted to an upper crossmember or bracket.
- Adjustable slotted bracket.
- Clear line of sight to the entire fixture area.
- Cable routed into the fixed frame.

## Step 5: Add Cable Management

Add realistic drag chains and cable routes:

- Drag chain from fixed base frame to moving X beam.
- Drag chain along moving beam to the Y carriage.
- Compact cable loop or mini drag chain from Y carriage/Z slide to probe head.
- Route probe signal wires, camera cables, force sensor wiring, and motor cables through these cable paths.

Use black cable-chain geometry with segmented rectangular links. It can be simplified but should be visually clear.

## Step 6: Add Instrument Bay Placeholders

Populate the instrument deck below the fixture with clean internal module placeholders.

Required internal modules:

- Relay matrix.
- 4-channel oscilloscope module.
- 16-channel logic analyzer.
- Precision DMM module.
- 0-30 V programmable power supply module.
- Electronic load module.

Represent these as clean rectangular industrial modules mounted inside the lower deck. Do not model displays, knobs, exposed test equipment, or front panels.

Add cable pass-throughs from the probe harness region to the relay matrix area.

## Step 7: Add Realistic Hardware

Add simplified but believable manufacturing details:

- Rail mounting screw patterns.
- Bearing block mounting screws.
- Motor mount screws.
- Fixture plate screws.
- Clamp screws.
- Dowel pins on fixture/tooling locations.
- Small brackets and gussets where visually needed.

Keep fasteners simplified. Do not spend features on fully threaded screws.

## Step 8: Apply Visual Materials

Apply CAD colors/materials so the mechanism reads clearly:

- Main frame: matte black or dark charcoal.
- Moving beam and carriages: dark gray anodized aluminum.
- Fixture plate: bead-blasted aluminum.
- Probe head: matte black machined aluminum.
- Pogo probes: metallic steel/gold tips.
- PCB: green solder mask.
- Cable chains: black.
- Instrument modules: dark gray.
- Cameras: black housing with glass lens.

## Step 9: Rename and Organize

Rename the major bodies/subassemblies clearly:

- Base Frame
- Instrument Deck
- X Rails
- X Ballscrew
- X Servo
- Moving X Beam
- Y Rails
- Y Ballscrew
- Y Servo
- Y Carriage
- Z Stage
- Probe Head
- Pogo Probe Cluster
- Fixed Overhead Camera
- PCB Fixture Plate
- Adjustable Clamps
- Sample PCB
- Cable Chains
- Instrument Bay Modules

## Step 10: Verify

Before stopping:

- Confirm all features regenerate without errors.
- Confirm the probe head can visually reach the sample PCB.
- Confirm the fixture is centered.
- Confirm the overhead camera has line of sight.
- Confirm cable chains do not cross the probing work envelope.
- Confirm no external enclosure geometry was added.

End with a clean internal mechanism assembly suitable for wrapping the final enclosure around it later.
