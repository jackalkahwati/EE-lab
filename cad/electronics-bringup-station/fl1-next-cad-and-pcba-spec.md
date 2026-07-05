# FL-1 Next: CAD Changes + PCBA Portfolio (designed in Compose)

Date: 2026-07-05. Driven by two decisions:
1. **Platform + modules vision** — one machine with a tool changer from day one,
   a right-wall tool dock, swappable heads, and expansion packs.
2. **Target BOM** (`fl1-target-bom.md`) — integrated instrument PCBAs instead of
   COTS instrument boxes, right-sized motion, SBC compute.

Both change the mechanical design and both create a portfolio of custom boards.
The strategic move: **design every FL-1 board in FirstLight Compose.** It is the
ultimate proof point, it stress-tests Compose on real hardware, and each board
Compose cannot yet build becomes a ranked Compose roadmap item.

Keep the appliance ID (the amber-canopy renders are the reservation face). These
are internal-mechanism and interface changes; the external enclosure largely
stays, gaining the wall dock on the right shell.

---

## Part A — CAD change passes

### CAD-NEXT-1: Tool-changer carriage (load-bearing, do first)
The current Z carriage is a **fixed probe head** with a noted "future
tool-change interface." Convert it to a real tool changer:
- Kinematic 3-point coupling on the Z carriage + magnetic or pneumatic lock
  (E3D-toolchanger / Voron-tap class).
- Common **tool interface**: mechanical seat + a single blind-mate connector
  carrying power, signal, vacuum, and a **tool-ID line** (so the machine knows
  which head is mounted). This connector is a small PCBA (see B-7).
- Pick/place motion budget: verify the carriage can approach, lock, and lift a
  head from the dock within the existing travel envelope
  (X [-165,+215], Y [-240,+180], Z from `MOTION-SAFE-1`).

### CAD-NEXT-2: Right-wall tool dock
- Passive dock with **5 seats** for the standard heads + room for 3–4 future
  pack heads. Locating pins + seat geometry matching the coupling.
- Integrate into the **right shell** (currently solid with the stadium-slot vent
  field). The dock must not block the vent path or the service door.
- Cable strategy: heads either park clean (fully picked) or keep a service loop.
  Prefer **fully-picked** (no dangling cables) so the work area stays clear and
  moving mass stays low.

### CAD-NEXT-3: Standard tool heads as modules
Five head assemblies sharing the coupling, each = coupling interface + head
hardware + a small head PCBA:
- **Vision** (localization/fiducials) — camera + lens + ring light.
- **Probe** (the current pogo/Kelvin/force head, re-based onto the coupling).
- **Communications** (JTAG/SWD/UART/SPI/I2C/CAN/USB/Ethernet driver head).
- **Manipulation** (button/switch/connector actuator).
- **Microscope** shares the vision camera via a liquid lens, or is a 6th seat.
Model each docked and on-carriage; confirm no collision with the gantry sweep.

### CAD-NEXT-4: Integrated instrument bay
Replace the COTS instrument envelopes in the plinth/measurement bay with card
mounting for the **custom instrument PCBAs**:
- Capture board, DC-measure/supply/load board, relay-matrix board (Part B).
- **E-load thermal:** dedicated heatsink + ducted fan for the load-board FETs
  (per `thermal-analysis.md` — the e-load is the dominant concentrated heat
  source). Duct to the rear exhaust.
- Relay-matrix board mounts **close to the fixture** for short probe paths.
- Service access + connector breakout on the rear/side.

### CAD-NEXT-5: Motion right-sizing
- Replace ballscrew + servo envelopes with **belt XY + closed-loop stepper**
  geometry (target ≤50 µm at the probe). Keep the **Z lead-screw + force
  sensor** for controlled touchdown.
- Re-run the swept-volume / collision audit (`motion_collision_audit.py`) after
  the drive change; lighter moving mass (tools off-head) helps speed/accuracy.

### CAD-NEXT-6: Module-expansion reservation
- Reserve **bay volume** and a documented mechanical + electrical interface for
  future packs (dock seats they add heads to, plus instrument-bay slots for pack
  hardware like an RF front-end or battery cycler).
- Publish the interface as an ICD so packs are designed against a fixed contract.

### CAD-NEXT-7: Compute / UI
- Swap the "embedded AI computer" envelope for a **single SBC** mount (Jetson
  Orin Nano or x86 mini-PC). Heavy AI is cloud-side; onboard runs
  motion/vision/UI only.
- 15.6" touchscreen already modeled — keep.

**Recommended order:** 1 → 2 → 3 (the changer trio is the platform), then 4
(instrument bay, gated on the Part B board outlines), then 5, 6, 7.

---

## Part B — FL-1 PCBA portfolio, designed in Compose

Every board FL-1 needs, with an honest read on what Compose can build **today**
(its current block library: power, MCU, radio, GNSS, sensors, relay/probe
matrix) vs. what needs a new block (a **datasheet-learning** target) vs. what is
a COTS module Compose only needs to carrier-board.

| # | Board | Function | Compose today | Action |
|---|---|---|---|---|
| B-1 | **Tool-ID coupling** (per head) | blind-mate connector + ID EEPROM + power/signal/vacuum passthrough | **Yes** | build now — trivial, do first |
| B-2 | **Manipulation head** | small MCU + servo/solenoid driver | **Yes** | build now |
| B-3 | **Probe head** | pogo/Kelvin interface, force-sensor amp, camera connector | **Yes** | build now |
| B-4 | **Relay / instrument matrix** | relay array + drivers + probe-point connectors | **Yes** (Compose's original domain) | build now |
| B-5 | **Backplane / interconnect** | board-to-board power + signal distribution | **Yes** | build now |
| B-6 | **Power distribution + safety** | IEC inlet, PSU distribution, E-stop/interlock, G9SE loop, PE monitor | **Partial** | power dist now; safety-relay logic reviewed by hand |
| B-7 | **Motion controller** | step generation, stepper drivers, encoder inputs, limits, E-stop | **Partial** | needs a **stepper-driver block** (TMC5160 / DRV8825) → datasheet learning |
| B-8 | **Comms head** | FT2232H/RP2040 + level translators + CAN/USB/Ethernet PHY | **Partial** | needs **transceiver blocks** (SN65HVD CAN, LAN8720 PHY, level shifters) |
| B-9 | **DC measure + supply + e-load** | DAC-controlled rails, INA228 sense, ADS1263 front-end, FET load | **Partial** | needs **ADS1263 / INA228 / DAC / prog-regulator blocks** |
| B-10 | **Vision head** | IMX camera interface, liquid-lens driver, lighting | **No** | MIPI/high-speed beyond Compose → COTS camera module + a simple carrier |
| B-11 | **Capture front-end** (scope/logic/AWG) | Zynq SoC + fast ADC + DDR | **No** | use a **Red Pitaya module**; Compose designs the carrier only |

### Build sequence (the dogfooding flywheel)

**Phase 1 — buildable in Compose today (proves the dogfooding immediately):**
B-1 tool-ID, B-2 manipulation, B-3 probe, B-4 relay matrix, B-5 backplane,
B-6 power distribution. Six real FL-1 boards, designed by FirstLight's own AI,
each shipping with its FL-1 test plan.

**Phase 2 — drives the Compose roadmap:** B-7 motion (stepper-driver block),
B-8 comms (transceiver blocks), B-9 measurement (ADS1263/INA228/DAC blocks).
Each missing part is a **datasheet-learning** task — upload the datasheet,
Compose learns the symbol/footprint/pinout/decoupling, the block library grows,
and the board it unblocks is the immediate test case. FL-1's own boards become
the forcing function for Compose's most valuable roadmap feature.

**Phase 3 — COTS modules, Compose does the carrier:** B-10 vision (IMX module),
B-11 capture (Red Pitaya module). Compose designs the interface/carrier board;
the high-speed silicon stays a bought module until Compose's high-speed
capability matures.

### Why this is the right first dogfood target
- Every Phase-1 board is genuinely useful and genuinely within Compose's
  current wheelhouse (the relay matrix literally *is* the domain Compose was
  built around).
- Phase 2 turns "Compose can't do part X" from a limitation into a **prioritized,
  demand-driven roadmap** — you build exactly the blocks your own machine needs,
  in the order it needs them.
- The whole exercise is the closed-loop story made literal: **Compose designs
  FL-1's boards, FL-1 will validate them.** The founding demo writes itself.

---

## Immediate next actions
1. **CAD-NEXT-1/2/3** (tool changer + dock + heads) — the platform-defining
   mechanical work; nothing else in the vision is credible without it.
2. **Run Phase-1 boards through Compose** (B-1 first — tool-ID coupling — then
   B-4 relay matrix). Confirm each produces a clean fab package + test plan, and
   feed the board outlines back to CAD-NEXT-4 for bay mounting.
3. **Open the Phase-2 datasheet-learning list** (stepper driver, CAN/Ethernet
   PHY, ADS1263) as the concrete Compose backlog.

---

## Phase-1 block backlog (from the 2026-07-05 dogfooding run)

Running the Phase-1 boards through Compose surfaced the exact blocks needed to
finish FL-1's own board set. Ranked by how many FL-1 boards each unblocks:

1. **No-MCU / passive-board support** — `classify()` force-adds an MCU baseline,
   so Compose cannot represent a passive board. Blocks B-1 (tool-ID) and B-5
   (backplane). Fix: allow an empty/passive spec (connector + passive parts, no
   MCU).
2. **Connector-array / interconnect block** — a parametric bank of headers or
   board-to-board connectors with a pass-through net map. Unblocks B-1, B-5, and
   improves every head board.
3. **EEPROM / I2C-ID primitive** — a tiny I2C EEPROM (24xx class) block for the
   tool-ID coupling (B-1) and general config storage.
4. **Relay-bank block** — a parametric array of signal/power relays + drivers,
   wiring the existing `matrix` generator into the block-composition flow.
   Unblocks B-4 (relay/instrument matrix), Compose's native domain.
5. **Safety-relay / interlock block** — E-stop + guard interlock into a G9SE-class
   loop for B-6's safety half (reviewed by hand until trusted).

Each is small and datasheet-learning-adjacent. Completing 1–4 finishes the
Phase-1 FL-1 board set; then Phase-2 (stepper driver, CAN/Ethernet PHY,
ADS1263) unblocks the measurement and motion boards.

---

## Progress — 2026-07-05: part-resolution contracts generalized

**Done.** `hardware/blocks/resolve_part.py` went from **1 contract** (`i2c_sensor`)
to **7 interface archetypes**, all verified resolving against real KiCad symbols
(`resolve_part.py --selftest`, 7/7):

| Contract | Real part tested | Footprint resolved |
|---|---|---|
| `i2c_sensor` | LM75B | SOIC-8 |
| `i2c_device` (EEPROM/expander) | 24LC256, MCP23017 | SOIC-10 / QFN-28 |
| `spi_device` | TMC5160 | TQFP-48 |
| `stepper_driver` | TMC2209 | VQFN-28 |
| `can_transceiver` | SN65HVD230 | SOIC-8 |
| `current_sense` | INA228 | TSSOP-10 |
| `regulator` | (LDO/adjustable archetype) | — |

Also: **multiplexed-pin binding** (a `SCK/CFG2`-style pin now binds its SPI role
by token-splitting on `/`) and **source_part.py fallbacks** for each new
interface, so the full DigiKey→datasheet→resolve chain works offline for them
(verified: "stepper motor driver" → TMC2209-LA + VQFN-28).

**Unlocks (resolution layer):** the ICs for the Tier-1 FL-1 boards — motion
controller (stepper driver), comms head (CAN transceiver), relay matrix (I2C
GPIO expander), instrument board (current sense, SPI ADC) — now resolve to real
footprints with correct pin→net binding.

**Next (block layer, not yet done):** compose.py needs block wrappers that call
these interfaces, supply the per-board net keys, and add the part-specific
support passives (charge-pump caps, sense resistors, decoupling) the contract
deliberately leaves to the block. That block layer is what turns "a part
resolves" into "a complete, routable FL-1 board."

---

## Progress — 2026-07-05: block layer proven (first Tier-1 board)

**Done.** Built the block-layer core on top of the generalized contracts and
shipped the first real FL-1 board through it:

- **`sourced_ic()`** in `compose.py` — the reusable core: resolve ANY IC via a
  contract, place it, report it; the calling block adds board-level support
  (decoupling, connectors, termination, sense resistors).
- **`block_comms_can()`** — FL-1 board **B-8 (comms head)**, first board built on
  the resolution + block layer. An MCU-driven **SN65HVD230 CAN transceiver**
  (resolved from the `can_transceiver` contract, not hardcoded) on a 3-pin bus
  header with 120-ohm termination.
- Wired into `classify()` / `BLOCK_TABLE` / floorplan; a "CAN bus comms" prompt
  now builds it.

**Verified end-to-end** through the full pipeline: PASSED, 12 components, 0 DRC
violations, 0 unconnected, with a correct netlist —
`CAN_TXD: U1.24→U7.1`, `CAN_RXD: U7.4→U1.25`,
`CANH: U7.7→R20→J7`, `CANL: U7.6→R20→J7`. A genuinely functional CAN board, not a
generic Pico.

**The pattern now extends to the rest of Tier 1:** the same `sourced_ic()` call,
with a different contract and support passives, builds the motion controller
(`stepper_driver` + charge-pump caps + sense resistors + motor connector), the
relay-matrix driver (`i2c_device` GPIO expander + relay bank), and the
instrument DC board (`current_sense` + shunt). Each is a block wrapper around
the proven core.

---

## Progress — 2026-07-05: three Tier-1 wrappers + the fine-pitch fanout finding

Built three block wrappers on the `sourced_ic()` core and ran each through the
full pipeline. All three produce **correct netlists** (verified pin-by-pin); DRC
outcome splits cleanly by package pitch:

| Board | Part | Package | Netlist | Pipeline |
|---|---|---|---|---|
| Comms head (B-8) | SN65HVD230 | SOIC-8 (1.27mm) | correct | **PASSED, 0/0** |
| Motion controller (B-7) | TMC2209 | VQFN-28 (0.5mm) | correct | GATE FAILED (8 unconnected, 3 DRC) |
| DC-measure (B-9) | INA228 | TSSOP-10 (0.5mm) | correct | GATE FAILED (0 unconnected, 3 DRC) |

**BOM labeling fixed:** resolved ICs now carry their real names through the
`devices.json` manifest (verified: U8 reads "INA228", not "Regulator TSSOP-10").

### The finding: fine-pitch fanout is a router limitation, not a block-layer one

Every failure is the same root cause — the auto-router / plane-stitch heal places
**vias and tracks inside the clearance of an adjacent 0.5mm-pitch pad**
(e.g. `Via [+3V3]` 0.075mm from `Pad [STEP]`, need 0.13mm). Coarse leaded parts
(SOIC/SOT, ≥1.27mm) route clean; fine-pitch parts (QFN/TSSOP, 0.5mm) do not.
Leaded 0.5mm (TSSOP) at least routes all connections (0 unconnected); leadless
0.5mm (QFN) also fails to route (8 unconnected).

This blocks essentially every real IC beyond SOIC/SOT — the single most important
thing standing between "correct netlist" and "fab-clean board."

**Attempted heal patch (pad-aware via placement + escape tracks) regressed a
passing board (comms → 1 unconnected), so it was reverted.** Proper fine-pitch
**escape/fanout routing** is a scoped `flroute` task that must be gated by the
174/174 regression harness before it ships — not a quick heal tweak. That is now
the #1 Compose router priority.

### Where Tier-1 stands
- **Comms head (B-8): done** — real, DRC-clean FL-1 board off the new layer.
- **Motion (B-7) / DC-measure (B-9): correct designs, blocked on fanout routing.**
  They become fab-clean the moment the router escapes fine-pitch pads properly.

---

## Fanout routing investigation — 2026-07-05 (root-caused, not yet fixed)

Goal: make the fine-pitch boards (motion TMC2209 VQFN, DC-measure INA228 TSSOP)
DRC-clean. Baseline confirmed first: flroute regression harness **174/174 in 47s**.

**Four experiments, all reverted, each ruling out a heal-level fix:**
1. Global pad-aware via blocking → regressed the comms board (skipped a needed via).
2. "Never worse" fine-pitch escape (escape outward, fall back to via-in-pad) →
   comms protected (0/0) but escaped vias landed in the zone antipad gap and
   **lost the plane connection** (more unconnected).
3. Zone-verified escape (`HitTestFilledArea` requires the escaped via to sit on
   the pour) → comms stayed 0/0, but on cramped 0.5mm parts there is **no
   on-plane spot to escape to** — the pour is carved back around the pads — so
   nothing changed.
4. Finer via class (shrink stitch vias to 0.4/0.2) → the board **min-via (0.5mm)
   lives in the KiCad project file, not the bare .kicad_pcb**, so `pcbnew` can't
   persist a relaxed value and `kicad-cli` DRC still enforces 0.5mm.

**Root cause (definitive):** via-in-pad on a 0.5mm-pitch part needs a via
≤0.44mm to clear the neighbour pad (0.13mm fab clearance), but the board's
minimum via is 0.5mm, and the plane pour is carved back around fine-pitch pads
so there is no nearby on-plane spot to escape to. **This is not a heal-level
problem.** The stitch heal physically cannot place a clean plane connection on a
0.5mm-pitch pad under the current via rules.

**The two real fixes (either works; both are scoped multi-part changes):**
- **A — finer via class threaded through the pipeline.** compose emits a
  `.kicad_pro` (or the DRC step carries design settings) that relaxes min-via to
  0.35mm / 0.2mm drill for fine-pitch boards; the stitch heal uses a 0.4/0.2 via
  for fine-pitch pads; zones refilled before DRC. Declares the board a finer fab
  class (a real, correct decision for 0.5mm-pitch work).
- **B — flroute fanout for power/gnd.** Route fine-pitch power/gnd pads with an
  escape stub to an open-area via during routing (flroute already does fanout
  escape for signal pads — extend it to the zone-served rails) so no via-in-pad
  stitch is needed.

**State:** baseline restored (stitch heal unchanged, comms head still PASSES
0/0, regression 174/174). The fine-pitch boards remain correct-netlist,
blocked-on-DRC. Fix A is the smaller lift and the recommended next step.

### Refinement: the .kicad_pro relaxation works, but there are TWO failure sources

Fifth experiment (a `.kicad_pro` sidecar, which experiment 4 never actually
tried) confirmed a **working building block for Fix A**: writing
`{"board":{"design_settings":{"rules":{"min_via_diameter":0.35,
"min_through_hole_diameter":0.2}}}}` next to the board makes `kicad-cli` DRC
accept 0.4mm vias — **no "via too small" violations appear.** So the min-via
relaxation is real and pipeline-deliverable.

But it also showed the fine-pitch DRC failures split into **two independent
sources**, and the via class only addresses one:
1. **Stitch vias** near a neighbour pad → fixed by the finer via class
   (shrink the fine-pitch stitch via to 0.4/0.2 under the relaxed min). Needs
   the via-detection tightened (the neighbour-proximity test under-selected).
2. **flroute-routed tracks** running inside a fine-pitch pad's clearance
   (`Track [VIN_BUS]` vs `Pad [VOUT_LOAD]`) → **not a via problem**; flroute
   must route those rails with the pad clearance the fine-pitch class demands.
   This is Fix B and is required in addition to Fix A.

**Net:** a fab-clean fine-pitch board needs BOTH the finer via class (compose
emits the `.kicad_pro` + stitch uses small vias, detection tuned) AND flroute
honouring fine-pitch pad clearance while routing. Each is a scoped task; the
`.kicad_pro` mechanism is proven, so Fix A is the tractable half to build first.

---

## Fanout Fix A attempt — 2026-07-06 (mechanism validated, integration reverted)

Built Fix A end-to-end: compose emits a complete `.kicad_pro` (finer via class,
min-via 0.35 / drill 0.2) for fine-pitch boards, the stitch heal uses a 0.4/0.2
via for fine-pitch pads, and the pipeline hides the `.kicad_pro` for the
stitch-driving DRC then restores it for the gate.

**Mechanism validated:** on DC-measure the 0.5mm-pitch stitch-via clearance
violations **cleared (3 → 1)** — the remaining 1 is the separate flroute-track
issue (Fix B). So a finer via class does make via-in-pad legal on 0.5mm pitch,
as intended, and the `.kicad_pro` min-via relaxation is confirmed to work through
kicad-cli.

**Integration destabilised the shared heal — reverted.** The stitch heal is
DRC-driven: it stitches only pads the intermediate DRC reports as unconnected
(the "false routed via zone" case). Introducing the finer via class + the
post-stitch zone refill shifted KiCad's zone-connection **crediting**, so
power/gnd pads that used to be credited (or reported for stitching) no longer
were — DC-measure ended with 5 unconnected, and even the **coarse comms board
regressed** (3 unconnected) despite taking none of the fine-pitch paths. That
last part means the perturbation reaches beyond the fine-pitch code, so it is not
safe. All three changes (compose.py, stitch_to_plane.py, route.ts) reverted;
comms confirmed back to **0/0**.

**What the real fix now needs (clearer than before):** the stitch heal must
stitch by **geometry** — every power/gnd SMD pad sitting over its plane without a
via — instead of by DRC report, so it is robust to zone-crediting changes. Then
the finer via class can be applied without the DRC-driven flow under-stitching.
That is a focused rework of `stitch_to_plane.py`'s site selection, plus the
finer via class (proven), plus Fix B (flroute pad clearance) for the routed-track
violations. Baseline remains protected: comms head PASSES 0/0, regression 174/174.

---

## Breadth — 2026-07-06: relay/instrument matrix (B-4) built and PASSES

After setting fanout aside, built the FL-1 relay matrix (B-4) — Compose's native
domain — entirely on the block layer with **coarse resolved parts**, and it
routes 100% clean:

- Two new contracts: `shift_register` (74HC595, SOIC-16) and `darlington_array`
  (ULN2803, SOIC-18W), both resolved + fallback-sourced.
- `block_relay_matrix`: MCU → 74HC595 (SPI shift) → ULN2803 (coil driver) → 4
  Omron G6K DPDT signal relays multiplexing probe points onto a shared 2-wire
  Kelvin instrument bus, with probe + bus connectors.
- **Full pipeline: 18/18 routed, 0 DRC, 0 unconnected, 0 ERC — PASSED.**
  Netlist verified: `SR_Q0 U7.15→U8.1`, `COIL0 K1.1→U8.18`,
  `INSTR_BUS J7.1→K1.3,K2.3,K3.3,K4.3`, `PROBE0→K1.4,K1.5`.
- Fixed a false ERC error: the SPI-completeness check demanded MISO, but
  write-only SPI devices (shift registers, DACs, LED drivers) legitimately have
  none. MISO is now optional; only a genuinely broken bus (clock without data,
  or data without clock) errors.

**Tier-1 boards that now PASS clean off the block layer: comms head (CAN) and
relay matrix (B-4).** This confirms the breadth thesis — coarse-part FL-1 boards
route cleanly today; the fine-pitch boards (motion, DC-measure) wait on the
scoped fanout rework.

---

## Geometry-based stitch heal — 2026-07-06 (done)

Reworked `stitch_to_plane.py` from DRC-report-driven to **geometry-driven**: it
now iterates every footprint pad and stitches a via into any power/gnd SMD pad
(outer layer, net has a plane zone) that lacks a same-net via — decided from
geometry alone, no DRC report. Idempotent (skips already-stitched pads), refills
zones, and the pipeline runs it **unconditionally** (a 0-unconnected first DRC
can still hide via-less pads via KiCad's false "zone-served" credit).

Verified no regression: comms 0/0, relay matrix 0/0 (STITCHED 6), DC-measure 0
unconnected. On DC-measure the geometry check found **13 of 14** zone-net SMD
pads via-connected and correctly flagged the **1** that is not (U8.7 GND on the
0.5mm-pitch INA228) — a pad DRC credits as connected but that physically has no
via. The 0.6mm via can't clear its neighbour, so it's skipped: exactly the
fine-pitch case Fix A (finer via class) addresses.

**Why this matters:** the heal is now robust to design-rule / via-class changes,
which is what broke the earlier Fix A attempt (DRC-driven stitch under-stitched
when the project relaxed min-via). With geometry-based selection, a Fix A retry
(0.4mm via on the fine-pitch pad + the proven `.kicad_pro` min-via relaxation)
can be layered on cleanly without the under-stitching regression. flroute
regression harness unaffected (it never runs the stitch heal): still 174/174.

---

## FL-1 Validation Package artifact — 2026-07-06 (done)

Compose now emits a new artifact beyond gerbers/BOM/STEP/firmware: the
**FL-1 Validation Package** (`fl1-validation.json`) — the executable bring-up +
test spec FL-1 runs. `scripts/gen_validation.py` composes the test plan + device
manifest + power budget (no invented data — every entry traces to a real net,
pad, or part) into one package containing exactly the requested sections:

- **probe_map** — probe locations + test-point map (net → pad + XY + size)
- **power_sequence** — pre-power short screen, power-up steps, **expected
  currents** (per rail, from the power budget, with over-current trip),
  **timing requirements** (rail rise, sequencing, reset width, bus periods)
- **measurements** — **expected voltages** + **pass/fail limits** per point
- **firmware_programming** — target, interface (SWD/UF2), program + verify steps
- **bus_protocols** — every bus auto-detected from the nets + manifest, with
  signals, speed, and the devices on it (SPI write-only + 74HC595 for the relay
  matrix; CAN 500kbps + 120R term + SN65HVD230 for the comms head)
- **functional_tests** — the ordered 6-step sequence (short screen → power-up →
  quiescent current → firmware → bus discovery → measurements) with pass_if
- **calibration** — gantry XY (against fiducials), probe force/Z-zero, DMM
  reference check

Wired into the pipeline after the test plan; shipped inside `fab-package.zip`
next to `fl1-testplan.json`. Verified end-to-end on the relay matrix (PASSED,
package present + zipped) and the comms head (CAN bus correctly characterized).
This makes the closed loop literal: **Compose emits the spec; FL-1 executes it.**
