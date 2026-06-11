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
      manifest/schema.py   design manifest v0 — the design<->machine contract
      manifest/compile.py  manifest -> executable bring-up plan
      motion/gantry.py     homing, soft limits, safe moves, force-guarded probing
      safety/interlocks.py e-stop/door state machine gating all motion
      switching/matrix.py  relay matrix routing with exclusivity rules
      measure/waveforms.py waveform analysis (frequency, peak; growing library)
      vision/registration.py  fiducial-based board-to-machine transform
      boardio/testpoints.py   test point import (CSV/JSON), board model
      sequencer/plan.py    test plan model (steps, limits, safety gates)
      sequencer/engine.py  plan execution, results, gate/abort handling
      api/server.py        FastAPI control API (incl. /manifests/run)
      sim.py               one-call fully wired simulated machine
    tests/                 unit tests (run with no hardware)
```

## Hardware abstraction layer

Every device the locked BOM names has one interface in `hal/interfaces.py`,
one mock in `hal/mocks.py`, and (eventually) one real driver in `hal/drivers/`:

| Interface        | Hardware (locked BOM + expansion spec) | Real backend (planned)  |
|------------------|------------------------------|---------------------------------|
| MotionController | Galil DMC-4133               | `gclib` (Galil Python API)      |
| Oscilloscope     | PicoScope 5444D MSO          | `picosdk` Python wrappers       |
| LogicAnalyzer    | Saleae Logic Pro 16          | `saleae` automation API (gRPC)  |
| Daq              | MCC USB-2416                 | `uldaq` / `mcculw`              |
| UtilityIO        | LabJack T7-OEM               | `labjack-ljm`                   |
| PowerSystem      | Rigol DP832 + Joulescope JS220 (v1); custom power board (v2) | SCPI + `pyjoulescope` |
| PowerSupply (aux)| Siglent SPD1305X             | `pyvisa` SCPI over USB/LAN      |
| ElectronicLoad   | Siglent SDL1030X (v1)        | `pyvisa` SCPI over USB/LAN      |
| Smu              | Keithley DMM6500 + protection board Kelvin path | SCPI       |
| Programmer       | Segger J-Link + Tag-Connect; SPI flash programmer | `pylink`   |
| DutLink          | FT4232H via DUT interface board | `pyserial` / `pyftdi`        |
| ThermalCamera    | FLIR Lepton 3.5 (PureThermal) | `pythermalcamera` / UVC        |
| InterfacePanel   | custom DUT interface board + Acroname USB hub + PCAN | serial + vendor APIs |
| RelayMatrix      | custom relay matrix PCBA     | serial protocol (Rev A defines) |
| ForceSensor      | probe-head load cell AFE     | via cartridge PCBA / DAQ chan   |
| Camera           | overhead + probe cameras     | OpenCV UVC capture              |
| SafetyIO         | Omron G9SE inputs, door, e-stop | LabJack/DAQ digital inputs   |

See `cad/electronics-bringup-station/hardware-expansion-spec.md` for the
hardware side of this table and the v1 signal-integrity envelope (matrix path
DC-1 MHz; shielded scope cartridge to 200 MHz; high-speed/RF excluded in v1).

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

## Design manifest (the product contract)

`manifest/schema.py` defines the machine-readable design package that
connects schematic net → PCB coordinate → expected behavior → instrument
configuration → diagnostic meaning. With it the machine is an automated
bring-up system; without it, an automated probe station. v0 covers
fiducials/test points, pre-power safety checks, sequenced power inputs with
inrush limits, firmware spec, rail expectations, clock checks, and a thermal
limit. Enterprise mode compiles manifests from EDA exports; AI-native mode
receives them from the design tool. `manifest/compile.py` turns a manifest
into an executable plan in fixed safety order: pre-power gate → sequenced
power → firmware → rails → clocks → thermal → power off.

## Test sequencing

A `TestPlan` is data (JSON-serializable): an ordered list of steps —
pre-power resistance/diode checks, sequenced power with inrush capture,
firmware programming, probe a test point, measure (DAQ voltage, frequency via
scope), thermal checks, limits, delays. Steps marked `gate=True` abort the
run on failure — a board that fails its short-circuit check never receives
power. `sequencer/engine.py` executes plans: transforms each test point
through the board registration, routes the relay matrix, probes with force
guarding, measures, evaluates limits, and emits a `RunReport` with per-step
results. Aborts cleanly on safety events: outputs off, matrix open, probe
retracted.

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

- **S1 (done):** core skeleton — HAL, mocks, gantry, safety, matrix,
  registration, plan engine, API, tests. Runs fully simulated.
- **S1.5 (done):** bring-up capability — design manifest v0 + compiler,
  pre-power safety gate, multi-channel sequenced power with inrush limits,
  SMU pre-power measurements, firmware programming step, clock frequency
  checks, thermal checks; HAL + mocks for programmer, DUT link, thermal
  camera, interface panel.
- **S2:** instrument depth — scope/logic capture storage, measurement library
  growth (ripple, edge timing, bus exercisers: I2C scan, SPI/UART
  transactions via DutLink), report generation (JSON + HTML).
- **S3:** vision — fiducial detection on real images, camera calibration,
  probe-camera offset routine; manifest compiler from KiCad/centroid exports
  (enterprise mode entry point).
- **S4 (hardware arrives):** real drivers one device at a time, each validated
  against its mock's contract tests on the bench (EVT Phase 1/2).
- **S5:** diagnosis engine — decision trees from the manifest, automatic
  follow-up measurements, fault library coverage (the 14 EVT seeded faults),
  AI-assisted root-cause narration ("U7 drawing 420 mA above range: likely
  reversed orientation, wrong footprint, or enable-pin error").
- **S6:** workflow/UI — web frontend, operator flow, run history,
  calibration UX, Rev B recommendation export to the design tool.
