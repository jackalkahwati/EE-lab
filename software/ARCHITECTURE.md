# Bring-Up Station Software Architecture

Software for the autonomous electronics bring-up station. Per the EVT plan
(`cad/electronics-bringup-station/evt-roadmap.md`), software is EVT Phase 1 —
it gets built and proven on the bench before the machine exists. Everything in
this codebase runs against simulated hardware today and swaps to real drivers
by changing configuration, not code.

## Stack

- Python 3.9+ (station runtime), FastAPI (control API — the product has no
  built-in screen; the UI is a web app served from the machine).
- numpy for vision/registration math; OpenCV added when camera work starts.
- pytest for the test suite. Everything testable headless with mocks.

## Repository layout

```
software/
  ARCHITECTURE.md          this file
  station/                 the machine application (installable package)
    src/bringup_station/
      config.py            machine geometry, speeds, probe limits
      hal/                 hardware abstraction layer
        interfaces.py      abstract interfaces for every device
        mocks.py           full simulated bench (no hardware required)
        drivers/           real backends (added per-device as hardware arrives)
      motion/gantry.py     homing, soft limits, safe moves, force-guarded probing
      safety/interlocks.py e-stop/door state machine gating all motion
      switching/matrix.py  relay matrix routing with exclusivity rules
      vision/registration.py  fiducial-based board-to-machine transform
      boardio/testpoints.py   test point import (CSV/JSON), board model
      sequencer/plan.py    test plan model (steps, limits)
      sequencer/engine.py  plan execution, results, abort handling
      api/server.py        FastAPI control API
      sim.py               one-call fully wired simulated machine
    tests/                 unit tests (run with no hardware)
```

## Hardware abstraction layer

Every device the locked BOM names has one interface in `hal/interfaces.py`,
one mock in `hal/mocks.py`, and (eventually) one real driver in `hal/drivers/`:

| Interface        | Hardware (locked BOM)        | Real backend (planned)          |
|------------------|------------------------------|---------------------------------|
| MotionController | Galil DMC-4133               | `gclib` (Galil Python API)      |
| Oscilloscope     | PicoScope 5444D MSO          | `picosdk` Python wrappers       |
| LogicAnalyzer    | Saleae Logic Pro 16          | `saleae` automation API (gRPC)  |
| Daq              | MCC USB-2416 (DMM role)      | `uldaq` / `mcculw`              |
| UtilityIO        | LabJack T7-OEM               | `labjack-ljm`                   |
| PowerSupply      | Siglent SPD1305X (v1)        | `pyvisa` SCPI over USB/LAN      |
| ElectronicLoad   | Siglent SDL1030X (v1)        | `pyvisa` SCPI over USB/LAN      |
| RelayMatrix      | custom relay matrix PCBA     | serial protocol (Rev A defines) |
| ForceSensor      | probe-head load cell AFE     | via cartridge PCBA / DAQ chan   |
| Camera           | overhead + probe cameras     | OpenCV UVC capture              |
| SafetyIO         | Omron G9SE inputs, door, e-stop | LabJack/DAQ digital inputs   |

Rule: application code never imports a driver. It receives interfaces through
`MachineContext`. The simulated bench (`sim.py`) and the real bench are the
same application with different wiring. When the custom PCBA Rev A serial
protocol is defined, it lands in `hal/drivers/` without touching the sequencer.

## Coordinate frames and calibration

- Machine frame: X/Y in mm centered on the fixture origin (matches CAD), Z in
  axis coordinates 0–100 mm (0 = full up). `config.MachineConfig` carries soft
  limits, safe-Z, and probe force limits.
- Board frame: test points imported in board coordinates (from CAD/centroid
  export). `vision/registration.py` fits a similarity/affine transform from
  fiducial detections to map board → machine coordinates per loaded board.
- Calibration assets (DVT pass D2 adds the physical features): camera-to-stage
  transform, camera-to-probe offset, Z touch-off reference, force calibration.
  Each gets a stored calibration record consumed by `motion` and `vision`.

## Safety model (software layer)

Hardwired safety (Omron G9SE, e-stop chain) is authoritative; software is a
second, observing layer. `safety/interlocks.py` polls SafetyIO and gates every
motion call: no homing, jogging, or probing unless e-stop is clear and the
door is closed. Probe descent is force-guarded in `motion/gantry.py`: descent
proceeds in steps, aborts above the configured contact force, and always
retracts to safe-Z on any error.

## Test sequencing

A `TestPlan` is data (JSON-serializable): an ordered list of steps —
power setup, probe a test point, measure (DAQ voltage today; scope/logic
captures next), check limits, delays. `sequencer/engine.py` executes plans:
transforms each test point through the board registration, routes the relay
matrix, probes with force guarding, measures, evaluates limits, and emits a
`RunReport` with per-step results. Aborts cleanly on safety events: outputs
off, matrix open, probe retracted.

## EVT proof traceability

| EVT must prove                          | Where in software                    |
|-----------------------------------------|--------------------------------------|
| 1. Locate and probe accurately          | vision/registration + motion/gantry  |
| 2. Repeatable, non-damaging contact     | force-guarded probing, force logs    |
| 3. Measurement accuracy under noise     | measure pipeline + repeatability runs|
| 4. Custom PCBA across interfaces        | hal/drivers for matrix/protection    |
| 5. Full automatic workflow              | sequencer/engine + api               |
| 6. Detect/diagnose target faults        | plan limits + diagnosis layer (next) |
| 7. Thermal stability                    | long-run soak scripts + logging      |
| 8. Safety fails correctly               | safety/interlocks + fault injection  |
| 9. Repeat across boards/operators       | boardio + plan reuse + reports       |
| 10. Serviceable and calibratable        | calibration records + cal routines   |

## Roadmap

- **S1 (now):** core skeleton — HAL, mocks, gantry, safety, matrix,
  registration, plan engine, API, tests. Runs fully simulated.
- **S2:** instrument depth — scope/logic capture models, waveform storage,
  measurement library (rail check, ripple, continuity, diode drop), report
  generation (JSON + HTML).
- **S3:** vision — fiducial detection on real images, camera calibration,
  probe-camera offset routine; board import from KiCad/centroid exports.
- **S4 (hardware arrives):** real drivers one device at a time, each validated
  against its mock's contract tests on the bench (EVT Phase 1/2).
- **S5:** workflow/UI — web frontend, operator flow, run history, diagnosis
  layer (AI-assisted fault localization), calibration UX.
