# Custom PCBA Rev A — Relay/Probe Matrix + Protection + Cartridge Interface

Date: 2026-06-11. First engineering release spec for the EVT custom board
set (evt-roadmap.md "Custom PCBA Rev A"). Three functions, one board where
practical: probe routing matrix, probe protection, and the probe-cartridge
electrical interface. Grounded in `flagship-cots-sourcing-bom.md` and
`hardware-expansion-spec.md` (signal-integrity envelope, cartridge family,
DMM Kelvin lane).

## 1. What this board must do

Route any probe contact to any instrument resource with known impedance and
calibrated leakage, survive probing a live/charged/faulted DUT, and identify
which cartridge is mounted. Published v1 envelope: DC-1 MHz through the
matrix (the 200 MHz shielded scope cartridge bypasses this board entirely
via direct coax — design the bypass path, don't try to switch it).

## 2. Resources and topology

Probe-side resources (8):

| # | Resource | Source |
|---|---|---|
| P1-P4 | Pogo cluster pins 1-4 | Pogo cluster cartridge |
| KF+/KF- | Kelvin force pair | Kelvin cartridge |
| KS+/KS- | Kelvin sense pair | Kelvin cartridge |

Instrument lanes (10):

| Lane | Instrument | Connector class |
|---|---|---|
| SCOPE_A, SCOPE_B | PicoScope 5444D ch A/B | BNC bulkhead, 50R-aware |
| DMM_HI, DMM_LO | Keithley DMM6500 (4-wire capable) | Low-thermal-EMF pair |
| DAQ_1, DAQ_2 | MCC USB-2416 analog in | Screw terminal |
| LOGIC_1, LOGIC_2 | Saleae Logic Pro 16 ch | Header to Saleae harness |
| PWR_INJ | DP832 ch (rail injection / bias) | Mini-Fit Jr |
| GND_REF | Star ground / discharge path | Bus bar |

**Topology: per-probe lane tree, not a full crosspoint.** Each probe
resource gets a 1-of-10 relay selector tree (1:2 then 1:5, or 1:10 ladder).
8 trees x ~11 relays = ~88 relays vs 160 for a full crosspoint, with
shorter stubs and one defined path per probe. Constraint accepted: a probe
connects to at most one lane at a time (the sequencer already works this
way). Any-probe-to-any-lane is preserved; probe-to-probe shorting goes
through the GND_REF bus deliberately, never incidentally.

Relay selection:

- **General lanes**: Omron G6K-2F-Y telecom relays (2 Form C, low
  capacitance, proven to 1 MHz envelope).
- **DMM/Kelvin lanes**: Pickering/Coto dry-reed with mu-metal shield,
  thermal-EMF-matched pairs (<1 uV class) — the leakage and diode-mode
  pre-power gate runs through these. Target path leakage <100 pA at 10 V.
- All relays default-open (de-energized = disconnected); a watchdog drops
  all coil power if the control link goes silent >250 ms.

## 3. Protection (per probe resource, in order from the tip)

1. Series PTC (50 mA hold, 0805) — current-limits a probe-to-rail hit.
2. Bidirectional TVS + steering diodes to +/-15 V clamp rails (rails sized
   to sink a 25 V transient without lifting).
3. **Pre-connect voltage check**: window comparator on each probe node
   (+/-30 V dividers, always connected, 1 Mohm class) readable by the MCU
   BEFORE any instrument relay closes. The sequencer's pre-power gate uses
   this: probe down -> read voltage -> only then route to an instrument.
4. Discharge path: 1 kohm/2 W bleed to GND_REF behind its own relay, for
   draining charged caps before DMM/diode tests.
5. Relay isolation: an instrument lane never sees the probe until the MCU
   has validated the node. Software interlock mirrored in firmware.

## 4. Cartridge interface (the contract)

Mechanical contract comes from the DVT tool-changer pass: 2 dowels + 2x M5
+ blind-mate connector. Electrical contract (this board's J10):

- Blind-mate: Samtec PEM/SEAF class or Harwin Datamate guided, rated for
  the tool-change cycle count (>=10k mates).
- 8 signal contacts (P1-P4, KF+/-, KS+/-) + 2 shield/guard + chassis.
- **Cartridge ID**: I2C EEPROM (24AA025UID class, unique ID + calibration
  page) on every cartridge PCB. 2 contacts (SCL/SDA) + presence-detect
  contact (grounded loop on cartridge side).
- Per-cartridge calibration data lives ON the cartridge: contact
  resistance per pin, last-calibrated date, mate count.
- The shielded scope cartridge's coax does NOT enter this connector — it
  mates to a bulkhead MMCX that runs as direct coax to the PicoScope
  (bypass lane, envelope to 200 MHz).

## 5. Calibration / self-test

- On-board reference block behind a dedicated relay: 0.01% 1 kohm and
  100 kohm + a dead short + an open, each routable to any lane. The
  station's calibration routine walks every probe x lane path against the
  DMM and logs contact/path resistance and leakage into the knowledge DB.
- Board-level cal EEPROM (same 24AA025UID) holding per-lane path constants.
- Loopback: any two probe trees can land on the reference short to verify
  a full probe->matrix->instrument->matrix->probe chain.

## 6. Control electronics

- **MCU: RP2040** (USB CDC to the station controller; firmware joins the
  station software repo). Rationale: trivial USB, 3v3 GPIO count, already
  in the team's toolchain.
- Relay drive: TPIC6B595 shift-register sink drivers, daisy-chained, with
  readback; coil rail 5 V from an on-board buck off 24 V control power.
- Telemetry: INA219 on the coil rail (stuck-relay detection by current
  signature), board temperature sensor, all on the MCU's I2C.
- Interfaces to station software: USB CDC, simple line protocol
  (`ROUTE P2 SCOPE_A`, `OPEN ALL`, `CHECK P1`, `CAL SHORT DMM`), mirrors
  the HAL resource-lane model already in `software/station`.

## 7. Connectors (Rev A pinout freeze)

| Ref | Function | Type |
|---|---|---|
| J1 | Control: USB-C (CDC) | USB-C receptacle |
| J2 | 24 V control power in | Molex Mini-Fit Jr 2p |
| J10 | Cartridge blind-mate (8 sig + 2 guard + I2C + presence + chassis) | Samtec SEAF class |
| J11 | MMCX bulkhead pass-through (scope bypass, not switched) | MMCX |
| J20/J21 | SCOPE_A/B out | BNC |
| J22 | DMM 4-wire out (HI/LO/SHI/SLO) | low-EMF 4p |
| J23 | DAQ_1/2 + LOGIC_1/2 out | latching header |
| J24 | PWR_INJ in (DP832) | Mini-Fit Jr 2p |
| J25 | GND_REF / chassis stud | M4 stud |

J10 contact map (cartridge side mirrors):

| Pin | Net | Pin | Net |
|---|---|---|---|
| 1 | P1 | 7 | KS+ |
| 2 | P2 | 8 | KS- |
| 3 | P3 | 9 | GUARD |
| 4 | P4 | 10 | GUARD |
| 5 | KF+ | 11 | CART_SDA |
| 6 | KF- | 12 | CART_SCL |
| 13 | CART_PRESENT_L | 14 | GND |

## 8. Block diagram

```
                     +--------------------------------------+
 cartridge           |  RELAY/PROBE MATRIX REV A            |
 (pogo / Kelvin)     |                                      |
  J10 ===============|  per-probe:                          |   J20/21 BNC --> PicoScope
   P1..P4,KF,KS      |   PTC -> TVS clamp -> node           |   J22 4-wire --> DMM6500
   + ID EEPROM       |          |        \-> V-check (MCU)  |   J23 hdr    --> USB-2416,
   + presence        |          v                           |                  Saleae
                     |   1:10 relay tree ---- lane bus -----|   J24        <-- DP832
  J11 MMCX ====coax==|== (unswitched bypass) ===============|== MMCX      --> PicoScope
   (scope cartridge) |                                      |
                     |  ref block: 1k / 100k / short / open |
                     |  discharge: 1k 2W -> GND_REF         |
                     |  RP2040 + TPIC6B595 chain + INA219   |-- J1 USB-C --> station PC
                     +--------------------------------------+
                          J2 24V in        J25 GND stud
```

## 9. Board outline / placement

4-layer, FR-4, ~160 x 100 mm, analog lane region partitioned from relay
coil/digital region with a moat; guard rings around the DMM/Kelvin lanes.
Mounts in the plinth instrument bay near the existing Probe Protection
Board envelope (X 190..350, Y +/-50 — the Rev A board REPLACES that
stand-in volume); cartridge harness exits up through the deck pass-through
to the probe head drag chain.

## 10. Rev A risks / open items

- Reed relay thermal EMF vs the uV-level diode-mode measurements — mitigate
  with matched pairs and a zero-offset cal step; validate at bring-up.
- Pogo contact resistance drift over cycles — the per-cartridge EEPROM mate
  counter + cal routine is the mitigation; define replacement threshold.
- USB-FS connector-level test (envelope) is at the DUT interface board, NOT
  this board — keep scope creep out of Rev A.
- Decide Samtec vs Harwin blind-mate by quoted lead time at order date.
- Clamp rail sizing assumes worst case 25 V DUT; revisit if 48 V DUTs enter
  scope (automotive) — that's a Rev B parameter, leave footprints.

## 11. Bring-up plan (board alone, Phase 1 bench)

1. Power + MCU enumerate, watchdog drops coils.
2. Relay census: walk all relays, INA219 signature per coil.
3. Leakage qualification: every probe x DMM path vs the 100 kohm and open
   references; record to knowledge DB; pass <100 pA.
4. Path resistance: every probe x lane vs the short reference; pass <250
   mohm excluding pogo.
5. Clamp test: 25 V source into each probe through 1 kohm; verify clamp +
   PTC + no instrument-side excursion.
6. Cartridge ID: mate cycle test on J10 + EEPROM read + presence detect.
