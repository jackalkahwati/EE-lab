# Hardware Expansion Spec — Bring-Up & Diagnosis Capability

Addendum to `flagship-cots-sourcing-bom.md` (June 2026). Expands the locked BOM
to cover the eight capability gaps between "automated probe station" and
"automated bring-up and diagnosis system." Same decision rule as the lock:
COTS for calibrated instruments, custom only for the switching/interface layer
that carries product IP.

## 1. Firmware programming and debug

Many "hardware" failures are bootloader/config/firmware/pin-mapping issues, so
the machine must program and talk to the DUT.

| Item | V1 selection | Notes |
|---|---|---|
| SWD/JTAG programmer | Segger J-Link BASE Compact | Broadest MCU coverage; scriptable (pylink) |
| Programming adapters | Tag-Connect TC2030/TC2050 + plug-of-nails kit | Manifest declares the footprint per board |
| SPI flash programmer | FlashcatUSB Mach1 (or DediProg SF100) | Off-MCU boot flash |
| UART/USB DUT link | FTDI quad-channel (FT4232H) breakout | UART/I2C/SPI bridging to DUT |
| Interface switching | Custom DUT interface board (BUILD, joins custom PCBA family) | Routes programmer/UART/USB to the DUT connector field, relay-isolated |
| Boundary scan | Defer to v2 | J-Link covers basic JTAG chains; full boundary-scan (XJTAG) only if customers demand |

## 2. Power instrumentation

One supply cannot distinguish dead board vs leakage vs sequencing vs
firmware-dependent draw.

| Item | V1 selection | Notes |
|---|---|---|
| Multi-channel sequenced supply | Rigol DP832 (3 ch, SCPI) | Replaces single SPD1305X as primary DUT power; programmable sequencing |
| Precision current / inrush | Joulescope JS220 inline | nA-to-A dynamic range, inrush capture, leakage measurement |
| Battery simulation | Qoitech Otii Ace Pro (defer to v1.5 if budget-gated) | Battery profiles + source-measure |
| Fast overcurrent shutdown | Custom protected DUT power board (already BUILD, v2) | Spec now includes <10 µs electronic trip + per-channel sequencing |
| Electronic load | Siglent SDL1030X (unchanged) | |

SPD1305X moves to auxiliary/bias supply duty.

## 3. Pre-power safety testing

Pre-power gate before any DUT power: resistance-to-ground, diode-mode,
continuity, capacitance, rail-to-rail isolation.

| Item | V1 selection | Notes |
|---|---|---|
| Precision DMM/SMU-lite | Keithley DMM6500 | 4-wire resistance, diode mode, capacitance, 6.5 digit |
| Protection | Probe protection board (already BUILD) | Spec now includes DMM path: series PTC + clamp, relay-selected Kelvin pair |
| Matrix routing | Relay matrix board (already BUILD) | Adds a dedicated "smu" resource lane (Kelvin pair) |

The MCC USB-2416 stays as the multi-channel DAQ; the DMM6500 takes the
precision/diode/4-wire role.

## 4. Thermal inspection

| Item | V1 selection | Notes |
|---|---|---|
| IR camera | FLIR Lepton 3.5 (160x120) on PureThermal 3 board | Mounted beside the overhead camera, full-fixture view |
| Upgrade path | FLIR Boson 640 or A35 | Only if Lepton resolution proves limiting |

CAD impact: second camera pocket on the overhead bracket arm; unobstructed
IR sightline to the fixture (no glass in path — IR does not pass the window).

## 5. Probe head flexibility

The DVT-pass tool-changer interface (2 dowels + 2x M5 + blind-mate connector)
becomes the cartridge contract. Cartridge family:

1. Pogo cluster cartridge (current 4-pin, DC/low-speed)
2. Kelvin pair cartridge (4-wire resistance, force/sense pogos)
3. Shielded scope cartridge (single sprung coax tip, 200 MHz class, to
   PicoScope via direct coax — bypasses the relay matrix)
4. Differential cartridge (v2; two matched shielded tips)
5. Ground-clip / grabber tasks stay manual-fixture items in v1

Current measurement is inline (Joulescope/DP832), not a probe cartridge.
CAD impact: cartridge park rack (3 positions) on the fixture deck edge,
within gantry reach.

## 6. Signal-integrity envelope (v1 published limits)

- Through relay matrix + pogo cartridge: DC–1 MHz measurement bandwidth.
- Through shielded scope cartridge (direct coax): to 200 MHz.
- Buses supported: I2C, SPI (≤20 MHz), UART, CAN/CAN-FD, USB-FS (12 Mbps,
  connector-level only).
- Explicitly excluded in v1: USB-HS/SS signal quality, Ethernet PHY
  compliance, DDR, PCIe, RF front ends. These connect at connector level
  for functional (not parametric) test only.

## 7. Connector-level interaction — DUT interface panel

A modular bulkhead in the chamber rear corner, fed from the plinth. Per-board
personality is a passive harness; switching is the custom DUT interface board.

| Channel | V1 hardware |
|---|---|
| USB host/device + power switching | Acroname USBHub3+ (programmable per-port) |
| Ethernet | existing DIN switch port, relay-isolated |
| CAN/CAN-FD | PEAK PCAN-USB FD |
| UART/I2C/SPI/GPIO | FT4232H + LabJack T7 DIO (existing) |
| Motor/sensor simulation, external loads | SDL1030X channel + LabJack DAC, expandable |
| Programming pass-through | J-Link via interface board |

## 8. Visual inspection upgrade

- Overhead camera → 12–20 MP fixed-focus machine-vision camera (e.g. Basler
  a2A4504 class) + diffuse dome ring light with switchable angled bar
  segments (controlled lighting is the bigger win over resolution).
- Probe-head camera unchanged (close-up verification + fiducials).
- Component-height awareness via probe Z touch-off (exists); laser
  profilometer deferred.
- Full AOI-grade inspection (angled views, autofocus) is explicitly out of
  v1 scope; v1 targets presence/absence, gross orientation, fiducials, and
  thermal anomaly localization.

## Custom PCBA family (updated)

BUILD items now: relay/probe matrix, probe protection (+DMM Kelvin path),
probe cartridge PCB/flex, **DUT interface board**, custom DUT power board (v2),
calibration/self-test board.

## CAD actions generated by this spec

1. Overhead bracket: add IR camera pocket beside the vision camera.
2. Fixture deck: cartridge park rack (3 stations) within gantry reach.
3. Chamber rear corner: DUT interface panel cutouts + harness route.
4. Plinth re-layout: DP832 (rack-width) + DMM6500 + Joulescope + USB hub —
   re-run the plinth packing check from the v4 review.
5. Window/IR: confirm thermal camera sightline bypasses the glass.
