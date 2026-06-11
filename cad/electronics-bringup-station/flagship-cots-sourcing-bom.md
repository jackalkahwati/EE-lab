# Flagship Autonomous NPI Bring-Up Cell BOM

This is the single canonical BOM for the flagship machine: an enclosed autonomous electronics bring-up cell with a 500 mm x 400 mm x 100 mm work envelope, Cartesian gantry, multi-probe head, cameras, fixture, internal instrumentation, internal computer, and industrial enclosure.

## Product Rule

The production machine should not contain screened benchtop instruments inside the enclosure. Anything inside the box should be one of:

- A screenless COTS module.
- A PCB/OEM board version.
- A custom internal board.
- A hidden service-bay module only if there is no reasonable screenless alternative.

Screened instruments such as Keysight DAQ970A, Keysight 34465A, Siglent SPD1305X, Siglent SDL1030X, and similar bench instruments are allowed as external lab references or early bench-prototype stand-ins, but they are not production internal parts.

## Locked Build Decisions (June 2026)

Decision: COTS for every precision instrument, custom only for the switching/probe-interface layer. We do not rebuild instruments whose value is in calibrated analog front-ends (scope, DMM, logic analyzer) — the NRE is 12-18 months each and the result would be uncalibrated and untrusted. The custom boards are the parts that cannot be bought and that carry the product IP.

| Subsystem | V1 Prototype | Production (V2) |
|---|---|---|
| Oscilloscope | BUY: PicoScope 5444D MSO | Same. Never custom. |
| Logic analyzer | BUY: Saleae Logic Pro 16 | Same. Never custom. |
| Precision DC / DMM role | BUY: MCC USB-2416-4AO | Same. Never custom. |
| Utility I/O | BUY: LabJack T7-OEM | Same or fold into interlock/utility board. |
| DUT power | BUY: Siglent SPD1305X (service-bay stand-in, screen hidden) | BUILD: custom protected programmable power board. |
| Electronic load | BUY: Siglent SDL1030X (service-bay stand-in, screen hidden) | BUILD: custom internal e-load board. |
| Relay/probe matrix | BUILD: custom protected reed-relay matrix PCB | Same board, revised. Core IP. |
| Probe protection | BUILD: custom (may share PCB with matrix in v1) | Same. |
| Probe cartridge / head interface | BUILD: custom cartridge PCB/flex with force-sensor AFE | Same. |
| Calibration/self-test board | Defer (pull into v1 if schedule allows) | BUILD. |
| PXI/PXIe modules (NI 4112/4110/4051, Pickering matrix) | Not used | Enterprise/defense configuration only. |

The custom-vs-COTS migration rule: an instrument goes custom only when volume justifies the NRE, the COTS module is the BOM cost driver, and we use only a narrow slice of its capability. DUT power and e-load meet that test at production volume; the scope and DMM likely never do.

## Recommended Production Architecture

- Internal control computer runs the machine application, vision, board import, test sequencing, reports, and AI workflow.
- Motion controller owns coordinated gantry motion.
- Safety relay owns E-stop and door interlock shutdown.
- Screenless scope, logic analyzer, DAQ, and I/O modules connect to the internal computer.
- DUT power, electronic load, relay matrix, probe protection, and calibration should become custom internal boards for the commercial product.
- COTS PXI/PXIe power/load modules are acceptable for a flagship prototype or enterprise configuration when true screenless COTS is required.

## Cost Summary

| Build | Estimated Hardware / COTS Cost | Notes |
|---|---:|---|
| Budget integration prototype | $25k-$45k | Uses COTS modules where possible, custom boards still rough, simpler enclosure. |
| Credible flagship prototype | $45k-$85k | Good customer-demo target with real motion, vision, instrumentation, computer, safety, and fixture. |
| Enterprise/PXI prototype | $85k-$175k+ | Uses NI/PXI/Pickering-class instrumentation for source/load/switching. |
| Production COGS target | $35k-$75k | Requires custom power/load/relay/protection boards and designed-for-assembly enclosure. |

## BOM Line Items

### 1. Internal Compute and Control

| Item | Recommended Part / Vendor | Qty | Est. Unit Cost | Est. Ext. Cost | Production Role | Notes |
|---|---|---:|---:|---:|---|---|
| Internal control computer | AAEON BOXER, Advantech ARK, OnLogic fanless industrial PC | 1 | $1,200-$3,000 | $1,200-$3,000 | Main automation controller | No screen. Linux preferred. i5/i7 or equivalent, 32 GB RAM, 1 TB NVMe, dual Ethernet, USB 3, 24 VDC input preferred. |
| System SSD | Industrial NVMe SSD | 1 | $100-$300 | $100-$300 | OS, logs, reports, local cache | Use high-endurance drive if storing waveform/video data locally. |
| Internal Ethernet switch | Moxa / Advantech / Phoenix Contact industrial Ethernet switch | 1 | $150-$600 | $150-$600 | Connect cameras, motion controller, service port, instruments | Prefer DIN-rail, 24 VDC, unmanaged for prototype. |
| Industrial USB hub | StarTech industrial / Advantech USB hub | 1-2 | $100-$400 | $100-$800 | Connect USB instruments/cameras | Powered USB 3 hub recommended. |
| 24 V control PSU | Mean Well / TDK-Lambda / Phoenix Contact DIN rail 24 V supply | 1-2 | $100-$400 | $100-$800 | Power controls, sensors, lights, relays | Size after current budget. |
| Main AC input/filter/fuse | Schurter / Corcom / TE Connectivity | 1 | $50-$250 | $50-$250 | IEC input, EMI filter, fusing | Rear panel integration. |
| Internal wiring terminals | Phoenix Contact / Wago terminal blocks | 1 lot | $200-$800 | $200-$800 | Serviceable wiring | Use labeled terminal blocks and ferrules. |

### 2. Instrumentation and Measurement

| Item | Recommended Part / Vendor | Qty | Est. Unit Cost | Est. Ext. Cost | Production Role | Notes |
|---|---|---:|---:|---:|---|---|
| Oscilloscope module | PicoScope 5444D MSO | 1 | $3,000-$4,000 | $3,000-$4,000 | 4-channel waveform capture | Screenless PC-based scope. PicoSDK. 200 MHz, FlexRes 8-16 bit. |
| Oscilloscope fallback | PicoScope 2408B | 1 | $1,000-$1,700 | $1,000-$1,700 | Lower-cost waveform capture | 4-channel, 100 MHz, 8-bit. |
| Enterprise oscilloscope | NI PXIe-5170 / PXIe-5172 class | 1 | $16,000-$25,000+ | $16,000-$25,000+ | Enterprise/PXI scope option | Requires PXIe chassis/controller. |
| Logic/protocol analyzer | Saleae Logic Pro 16 | 1 | $1,499 | $1,499 | Digital buses, protocol decode, regression capture | Screenless hardware. Python automation API. |
| Precision DAQ | MCC USB-2416-4AO | 1 | $1,499 | $1,499 | Low-speed precision measurements | Screenless. 24-bit, 32 SE / 16 DIFF analog inputs, 4 analog outputs. |
| Precision DAQ fallback | MCC USB-2408-2AO | 1 | $809 | $809 | Lower channel-count precision measurement | Screenless. 24-bit, 16 SE / 8 DIFF analog inputs. |
| Utility DAQ / I/O board | LabJack T7-OEM or T7-Pro-OEM | 1 | $500-$900 | $500-$900 | Sensors, interlocks, LEDs, vacuum, utility I/O | PCB-only/OEM preferred. Avoid cased T7 in production. |
| External calibration DMM | Keysight 34465A or DAQ970A | 0-1 | $2,100-$5,000 | $0 production | External calibration/reference only | Do not embed. Useful on the engineering bench. |

### 3. DUT Power, Electronic Load, Switching, and Protection

| Item | Recommended Part / Vendor | Qty | Est. Unit Cost | Est. Ext. Cost | Production Role | Notes |
|---|---|---:|---:|---:|---|---|
| Production DUT power board | Custom internal protected programmable power board | 1 | $1,000-$5,000 prototype | $1,000-$5,000 | Source DUT power | Recommended commercial path. CV/CC, remote sense, current measurement, eFuse, OVP/OCP, output relay, discharge path, calibration EEPROM. |
| Screenless COTS DUT power | NI PXIe-4112 | 1 | Quote | Quote | COTS prototype / enterprise path | No local display. 2 isolated channels, 0-60 V, 1 A, 120 W total. Requires PXIe chassis and 48 V auxiliary power. |
| Lower-power COTS DUT power | NI PXI-4110 | 1 | Quote | Quote | Low-power rail source | No local display. 3 channels, +/-20 V class, 1 A with auxiliary power. |
| Bench PSU stand-in | Siglent SPD1305X or similar | 0-1 | $300-$500 | $0 production | Bench prototype only | Has a screen. Do not embed in production. |
| Production electronic load board | Custom internal electronic load board | 1 | $1,000-$5,000 prototype | $1,000-$5,000 | Sink/load DUT outputs | Recommended commercial path. CC/CV/CR/CP, thermal management, protection, calibration. |
| Screenless COTS electronic load | NI PXIe-4051 | 1 | Quote | Quote | COTS prototype / enterprise path | No local display. 60 V, 40 A, 300 W. Requires PXIe chassis. |
| Bench electronic load stand-in | Siglent SDL1030X or similar | 0-1 | $1,000-$1,300 | $0 production | Bench prototype only | Has a screen. Do not embed in production. |
| Relay/probe matrix | Custom protected reed-relay matrix PCB | 1 | $1,000-$5,000 prototype | $1,000-$5,000 | Route probes to instruments | Core product IP. Include protection, guarded paths, relay cycle counting, calibration paths. |
| Enterprise relay matrix | Pickering 40-533C 64x4 PXI matrix | 0-1 | $5,000-$8,000+ | $5,000-$8,000+ | Enterprise/PXI switching option | Requires PXI/PXIe chassis. Useful reference standard. |
| PXI/PXIe chassis | NI PXIe chassis + controller/MXI path | 0-1 | $5,000-$20,000+ | $5,000-$20,000+ | Required if using NI PXI source/load/scope/switch modules | Avoid unless enterprise-grade screenless COTS instrumentation is required. |
| Probe protection PCB | Custom board | 1 | $500-$3,000 prototype | $500-$3,000 | Protect instruments and DUT | TVS, current limit, relay isolation, fusing, controlled discharge, signal conditioning. |
| Calibration/verification PCB | Custom board | 1 | $200-$1,500 prototype | $200-$1,500 | Built-in self-test and calibration | Include precision references, known loads, loopback paths, probe-contact targets. |

### 4. Motion System

| Item | Recommended Part / Vendor | Qty | Est. Unit Cost | Est. Ext. Cost | Production Role | Notes |
|---|---|---:|---:|---:|---|---|
| Motion controller | Galil DMC-4133 | 1 | $1,510 | $1,510 | 3-axis coordinated gantry control | Industrial credibility, Ethernet/USB, stepper/servo compatible. |
| Servo motors | Teknic ClearPath-SD NEMA 23 class | 3 | $315-$800 | $945-$2,400 | X/Y/Z motion | Integrated motor/encoder/drive simplifies wiring. |
| Servo alternative | DMM DYN4 drive + motor kits | 3 | $400-$700 | $1,200-$2,100 | Lower-cost servo option | More wiring and integration. |
| Motor power supply | Teknic IPC-5 / 75 VDC bus supply or equivalent | 1 | $300-$900 | $300-$900 | Servo bus power | Match motor/controller selection. |
| X/Y linear rails | Genuine Hiwin MGN15 / MGN15H, Misumi, or THK | 4 | $75-$200 | $300-$800 | Precision guided motion | Use genuine rails for flagship. |
| Z linear rails | Hiwin MGN12/MGN15 class | 2 | $50-$150 | $100-$300 | Probe Z axis | Size to stiffness and head weight. |
| X/Y ballscrews | SFU/RM1605 C7 or C5 with BK/BF supports | 2 | $100-$500 | $200-$1,000 | X/Y drive | C7 prototype; C5 if repeatability requires it. |
| Z ballscrew | SFU/RM1204 or 1605 compact screw | 1 | $80-$300 | $80-$300 | Z drive | Compact, low backlash. |
| Couplers and bearing blocks | BK/BF supports, flexible couplers | 3 sets | $30-$150 | $90-$450 | Drive coupling | Match screw and motor shafts. |
| Limit/home sensors | Omron / Panasonic / SICK prox or optical sensors | 6-9 | $20-$100 | $120-$900 | Homing and overtravel | Use redundant hard stops for Z/probe protection. |
| Cable chains | Igus / generic cable carriers | 3 | $50-$300 | $150-$900 | Clean moving cable routing | X, Y, and Z/probe loops. |
| Motion harnesses | Custom shielded harnesses | 1 lot | $500-$2,500 | $500-$2,500 | Motors, encoders, sensors | Use drag-chain-rated cable. |

### 5. Vision and Lighting

| Item | Recommended Part / Vendor | Qty | Est. Unit Cost | Est. Ext. Cost | Production Role | Notes |
|---|---|---:|---:|---:|---|---|
| Overhead camera | Basler ace USB3/GigE 5 MP global-shutter class | 1 | $500-$1,800 | $500-$1,800 | Board detection and coarse fiducials | Prefer C-mount lens ecosystem. |
| Overhead lens | C-mount low-distortion lens | 1 | $100-$600 | $100-$600 | Overhead vision optics | Focal length depends on chamber height and field of view. |
| Probe camera | Arducam 5 MP OG05B10 global shutter USB3 or board-level equivalent | 1 | $100-$415 | $100-$415 | Fine alignment at probe head | Packaging matters more than brand prestige. |
| Probe lens/illumination | M12 lens, coax/ring light if needed | 1 lot | $50-$400 | $50-$400 | Fine probing vision | Add diffuser to reduce glare on solder mask. |
| Chamber lighting | 24 V LED strips with diffuser | 2-4 | $25-$150 | $50-$600 | Internal illumination | Prototype baseline. |
| Industrial vision lighting | Banner WLS27 / Banner linear vision array | 0-2 | $300-$700 | $0-$1,400 | Higher repeatability lighting | Upgrade if vision repeatability demands it. |

### 6. Probe Head and Contact System

| Item | Recommended Part / Vendor | Qty | Est. Unit Cost | Est. Ext. Cost | Production Role | Notes |
|---|---|---:|---:|---:|---|---|
| Probe head housing | Custom machined aluminum | 1 | $500-$2,500 prototype | $500-$2,500 | Holds probes, camera, force sensor, cartridge | Core mechanical subsystem. |
| Replaceable probe cartridge | Custom machined/PCB hybrid cartridge | 1-3 | $200-$1,500 | $200-$4,500 | Serviceable probe interface | Design for quick swap and calibration. |
| Pogo probes | QA Technology / Everett Charles ICT/FCT probes | 20-100 | $2-$15 each typical, varies | $200-$1,500 | Signal/ground/differential contact | Buy an assortment of tip styles and spring forces. |
| Coax / high-frequency probe contacts | QA / ECT / custom coax pogo | 4-16 | $20-$150 each | $80-$2,400 | Scope and fast-signal probing | Needed for serious waveform integrity. |
| Force sensor | Honeywell FSS015WNGB / FSS-SMT series | 1-2 | $100-$150 | $100-$300 | Probe contact detection | Use with electrical contact detection. |
| Mechanical hard stops | Custom machined features | 1 set | $50-$500 | $50-$500 | Overtravel protection | Must protect DUT pads and probes. |
| Probe head flex PCB/harness | Custom flex/rigid-flex or micro-coax harness | 1 | $300-$2,500 | $300-$2,500 | Dense signal breakout | Keep analog/scope paths shielded and short. |
| Tool changer interface | Custom kinematic/dowel interface | 1 | $200-$2,000 | $200-$2,000 | Future cartridges/tools | Include repeatable locating features. |

### 7. Fixture, Vacuum, and Workholding

| Item | Recommended Part / Vendor | Qty | Est. Unit Cost | Est. Ext. Cost | Production Role | Notes |
|---|---|---:|---:|---:|---|---|
| Fixture plate | Custom machined aluminum, 520 mm x 420 mm class | 1 | $500-$2,500 | $500-$2,500 | Universal PCB workholding | Hole grid, tooling pins, clamp slots, vacuum ports. |
| Adjustable clamps | Custom or fixture clamp hardware | 8-16 | $20-$150 | $160-$2,400 | Board retention | Low profile to preserve probe clearance. |
| Tooling pins | Misumi / McMaster precision dowel pins | 1 lot | $50-$300 | $50-$300 | Repeatable board location | Include common board tooling-hole sizes. |
| Vacuum ejector | SMC ZH13BSA-08-10 or ZH series | 0-1 | $50-$80 | $0-$80 | Optional vacuum hold-down | Useful for thin/flex boards. |
| Vacuum valves/sensor/fittings | SMC / Festo fittings and pressure switch | 1 lot | $150-$800 | $150-$800 | Vacuum control and verification | Optional first flagship, but useful. |
| Sacrificial fixture mats | ESD-safe fixture surface | 1 lot | $50-$300 | $50-$300 | Protect boards and fixture | Replaceable consumable. |

### 8. Safety and Compliance

| Item | Recommended Part / Vendor | Qty | Est. Unit Cost | Est. Ext. Cost | Production Role | Notes |
|---|---|---:|---:|---:|---|---|
| Safety relay | Omron G9SE-201 or G9SE-401 | 1 | $110-$270 | $110-$270 | E-stop and door interlock chain | Use real safety relay from day one. |
| E-stop button | Omron / IDEC / Schneider | 1 | $30-$150 | $30-$150 | Operator emergency stop | Front/right accessible. |
| Door interlock switch | Omron / SICK / Banner safety switch | 1-2 | $50-$300 | $50-$600 | Disable motion/power when door open | Tie to safety relay. |
| Main contactor / safety cutoff | Schneider / Omron / Phoenix Contact | 1 | $100-$500 | $100-$500 | Cut motor/DUT hazardous power | Controlled by safety relay. |
| Fuses/breakers | Littelfuse / Phoenix / Eaton | 1 lot | $100-$500 | $100-$500 | Branch protection | Separate motion, controls, DUT power. |
| Grounding/ESD hardware | ESD straps, bonding lugs, ground bars | 1 lot | $100-$500 | $100-$500 | ESD and safety grounding | Important for board handling and measurements. |
| Door gasket / glass seal | McMaster / custom | 1 lot | $100-$500 | $100-$500 | Enclosure sealing | Also improves perceived quality. |

### 9. Enclosure and Mechanical Structure

| Item | Recommended Part / Vendor | Qty | Est. Unit Cost | Est. Ext. Cost | Production Role | Notes |
|---|---|---:|---:|---:|---|---|
| Structural frame | Custom welded/bolted aluminum frame | 1 | $1,500-$6,000 | $1,500-$6,000 | Machine structure | Stiffness matters more than speed. |
| Sheet metal enclosure | Custom laser-cut/bent panels | 1 set | $2,000-$10,000 prototype | $2,000-$10,000 | External shell and service panels | Cost drops at volume. |
| Front smoked window | Tempered smoked glass or tinted polycarbonate | 1 | $500-$2,000 | $500-$2,000 | Front chamber view | Include gasket and serviceability. |
| Door hinges/latch | Southco / Sugatsune / Misumi | 1 set | $200-$1,500 | $200-$1,500 | Front access door | Hidden hinge preferred. |
| Rounded side/corner covers | Custom machined/molded/extruded covers | 1 set | $1,000-$8,000 prototype | $1,000-$8,000 | Final product appearance | High visual leverage. |
| Rear I/O panel | Custom machined/sheet metal panel | 1 | $300-$2,000 | $300-$2,000 | Ethernet, USB-C, IEC, switch, ventilation | Keep connector count minimal. |
| Vent filters/fans | Orion / Delta / ebm-papst / 3M filters | 1 lot | $200-$1,000 | $200-$1,000 | Thermal management | Needed for electronics bay and load board. |
| Vibration isolation feet | Sorbothane / industrial leveling feet | 4 | $25-$150 | $100-$600 | Bench isolation and leveling | Must support machine mass. |
| Internal instrument tray | Custom sheet metal tray | 1 | $300-$2,000 | $300-$2,000 | Holds electronics bay modules | Design for service access. |

### 10. Cabling, Harnessing, and Connectors

| Item | Recommended Part / Vendor | Qty | Est. Unit Cost | Est. Ext. Cost | Production Role | Notes |
|---|---|---:|---:|---:|---|---|
| Shielded probe coax harness | Custom micro-coax/coax harness | 1 lot | $1,000-$5,000 | $1,000-$5,000 | Probe-to-relay/scope paths | Critical for measurement quality. |
| Digital/protocol harness | Custom twisted-pair harness | 1 lot | $300-$1,500 | $300-$1,500 | Logic analyzer and bus probing | Include strain relief. |
| Motion cables | Drag-chain-rated motor/sensor cable | 1 lot | $500-$2,500 | $500-$2,500 | Moving axes | Keep separate from sensitive analog paths. |
| Internal USB/Ethernet cables | Industrial locking cables preferred | 1 lot | $200-$1,000 | $200-$1,000 | Computer-to-instruments | Locking connectors where possible. |
| Rear service ports | RJ45, USB-C, IEC inlet, rocker switch | 1 set | $100-$500 | $100-$500 | External interface | No extra connectors in final enclosure. |
| Cable labels/ferrules/sleeving | Brady labels, ferrules, braided sleeving | 1 lot | $100-$500 | $100-$500 | Serviceability | Cheap and important. |

### 11. Software and Firmware Deliverables

| Item | Recommended Implementation | Qty | Est. Cost | Production Role | Notes |
|---|---|---:|---:|---|---|
| Machine control service | Linux service on internal control computer | 1 | Engineering | Coordinates all subsystems | Owns state machine, safety state, job execution. |
| Motion integration | Galil API / controller layer | 1 | Engineering | Gantry moves and calibration | Keep hard safety outside app logic. |
| Vision pipeline | OpenCV / Basler pylon / UVC integration | 1 | Engineering | Fiducials, board registration, probe targeting | Must support calibration transforms. |
| Instrument abstraction | Python/C++ service wrappers | 1 | Engineering | Scope, logic, DAQ, power, load, relay matrix | Use common measurement schema. |
| Board import | KiCad/Altium/ODB++/Gerber/netlist ingestion | 1 | Engineering | Test point and net awareness | Start with KiCad + CSV test-point import. |
| Bring-up workflow engine | Test sequencing and report generation | 1 | Engineering | Automated board bring-up | This is the core value. |
| AI debug assistant | Local/cloud LLM workflow layer | 1 | Engineering | Suggests next tests and root causes | Gate hardware actions through deterministic safety checks. |
| Calibration software | Probe/camera/fixture/instrument calibration routines | 1 | Engineering | Repeatable operation | Include golden board and calibration fixture. |
| Web UI / service UI | Browser app served from internal computer | 1 | Engineering | Operator interface | User connects through Ethernet/USB-C service port. No built-in screen. |

## Prototype-Only Bench Instruments

These are useful during development but should not be embedded in the production enclosure:

| Instrument | Why Not Production Internal | Allowed Use |
|---|---|---|
| Keysight DAQ970A | Screen/front-panel mainframe | External calibration/reference. |
| Keysight 34465A | Screened benchtop DMM | External calibration/reference. |
| Siglent SPD1305X | Screened bench power supply | Bench prototype stand-in for DUT power. |
| Siglent SDL1030X | Screened bench electronic load | Bench prototype stand-in for load testing. |
| Keysight E36100B series | Screened bench supply | External lab use or hidden service-bay demo only. |
| Chroma/B&K modular load mainframes | Mainframes have front panels/displays | Enterprise lab configuration if hidden; not preferred production architecture. |
| Keysight N6700 mainframe | Mainframe has front panel/display | Enterprise ATE configuration if hidden; not preferred production architecture. |

## Custom Boards Required For The Real Product

These should be designed as product-specific internal electronics:

| Custom Board | Why It Is Needed |
|---|---|
| Probe protection board | Protects scope, logic analyzer, DAQ, DUT, and relay matrix from overvoltage, ESD, shorts, and mis-probes. |
| Relay/probe matrix board | Routes any probe to scope/DMM/DAQ/logic/power/load paths with known impedance and calibrated leakage. |
| DUT power board | Provides compact, screenless, protected, calibrated programmable power rails with remote sense and current measurement. |
| Electronic load board | Provides compact, thermally integrated, screenless load for output testing and discharge. |
| Probe cartridge PCB/flex | Makes probes replaceable and serviceable while preserving signal integrity. |
| Calibration/verification board | Enables self-test, probe calibration, contact verification, and measurement sanity checks. |
| Interlock/utility board | Aggregates door switches, E-stop status, lights, fans, vacuum, and low-risk I/O. |

## Initial Procurement Shortlist

For a serious flagship prototype, buy or build:

- 1x fanless industrial control computer.
- 1x industrial Ethernet switch.
- 1x powered industrial USB 3 hub.
- 1x PicoScope 5444D MSO.
- 1x Saleae Logic Pro 16.
- 1x MCC USB-2416-4AO or USB-2408-2AO.
- 1x LabJack T7-OEM or T7-Pro-OEM.
- 1x Siglent SPD1305X as v1 DUT power stand-in (service bay, screen hidden); custom protected DUT power board is the v2 production replacement.
- 1x Siglent SDL1030X as v1 electronic load stand-in (service bay, screen hidden); custom e-load board is the v2 production replacement.
- 1x custom relay/probe matrix board.
- 1x custom probe protection board.
- 1x Galil DMC-4133.
- 3x Teknic ClearPath-SD NEMA 23 servos.
- Hiwin/Misumi/THK linear rails and carriages for X/Y/Z.
- 3x ballscrew kits with bearing blocks and couplers.
- 1x Basler ace overhead camera and lens.
- 1x Arducam/probe-head camera and lens.
- 1x Omron G9SE safety relay.
- E-stop, door interlock, main contactor, fuses, grounding hardware.
- QA Technology / Everett Charles probe assortment.
- Honeywell FSS force sensors.
- Custom machined probe head and replaceable cartridge.
- Custom fixture plate, clamps, tooling pins, optional SMC vacuum system.
- Sheet-metal enclosure, smoked front glass, rounded side shells, rear I/O panel, feet, fans, filters.
- Shielded probe harnesses, drag-chain-rated motion cables, internal USB/Ethernet cables, terminals, labels.

## Key Sources

- PicoScope 5000D: https://www.picotech.com/oscilloscope/5000/flexible-resolution-oscilloscope
- Saleae Logic Pro 16: https://www.saleae.com/support/specifications-hardware/datasheets-and-compliance/saleae-part-numbers
- MCC USB-2416-4AO: https://digilent.com/shop/mcc-usb-2416-4ao-expandable-thermocouple-and-voltage-measurement-usb-daq-device/
- MCC USB-2408-2AO: https://digilent.com/shop/mcc-usb-2408-2ao-high-precision-thermocouple-and-voltage-measurement-usb-daq-device/
- LabJack T7-OEM: https://www.meilhaus.de/en/labjack-t7-oem.htm
- NI PXIe-4112: https://www.ni.com/en/shop/hardware/power-supplies/model-pxie-4112
- NI PXI-4110: https://www.ni.com/en/shop/hardware/power-supplies/model-pxi-4110
- NI PXIe-4051: https://www.ni.com/en/shop/hardware/electronic-load/model-pxie-4051
- Pickering matrix modules: https://www.pickeringtest.com/en-us/products/pxi/pxi-switching-modules/pxi-matrix-switch-modules/high-density-matrix
- Teknic ClearPath: https://teknic.com/products/clearpath-brushless-dc-servo-motors/
- Galil DMC-41x3: https://www.galil.com/motion-controllers/multi-axis/dmc-41x3
- Basler ace: https://www.baslerweb.com/en-us/cameras/ace/
- Arducam global shutter USB3: https://www.arducam.com/presalesarducam-5mp-og05b10-color-global-shutter-usb-3-0-camera.html
- QA Technology probes: https://www.qatech.com/en/products/conventional-probes/conventional-probes.html
- Honeywell FSS force sensor example: https://uk.rs-online.com/web/p/strain-gauges/2036947
- SMC ZH vacuum ejector example: https://uk.rs-online.com/web/p/vacuum-generators/2315359
- Omron G9SE safety relay: https://uk.rs-online.com/web/p/safety-relays/2655203

## Bottom Line

The flagship can use COTS for compute, motion, cameras, scope, logic, DAQ, safety, and many mechanical components. The parts that should become custom are the power/load/protection/switching/probe/fixture stack. That is where the product becomes compact, screenless, differentiated, and economically viable.
