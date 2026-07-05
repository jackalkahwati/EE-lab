# FL-1 Base — Target BOM and Cost-Down Spec

Date: 2026-07-05. Companion to `flagship-bom-and-scope-options.md` (the
first-unit / COTS estimate) and `flagship-cots-sourcing-bom.md`.

**Purpose.** Hit a **$49,500 base sell price with a healthy gross margin** by
driving COGS from the first-unit ~$35–60K down to a **volume target of ~$23K**
(then ~$20K with purchasing power). The single biggest lever is replacing
discrete COTS instruments with an integrated measurement PCBA. The second is
right-sizing precision to bring-up (25–50 µm) instead of metrology (1 µm).

This is a sourcing checklist, not a locked BOM. Every custom line trades NRE +
first-unit cost for per-unit cost at volume, so **first units use more COTS
(price them nearer $69,500), then integrate for the volume version.**

---

## Target cost roll-up

| Subsystem | First-unit (COTS) | Volume target | Primary cost-down move |
|---|---:|---:|---|
| Integrated instrument PCBA | $8,000–18,000 | **$4,000** | own capture board vs discrete boxes |
| Motion (XY/Z) | $4,000–8,000 | **$3,000** | belt + closed-loop stepper vs ballscrew + servo |
| Tool changer + wall dock | $2,000–5,000 | **$1,500** | kinematic magnetic coupling vs ATC |
| Vision + inspection | $1,500–4,000 | **$1,200** | one camera, swappable/liquid lens |
| Probe / comms / manip heads | $3,000–7,000 | **$3,000** | shared carriage, custom head PCBAs |
| Compute + touchscreen | $2,000–5,000 | **$1,300** | SBC (cloud does the AI) + COTS panel |
| Enclosure / frame / window | $2,500–5,000 | **$2,500** | extrusion + folded sheet metal |
| PCB fixture / cabling / harness | $1,500–4,000 | **$2,000** | modular nests, harness kitting |
| Assembly / calibration / QA | $4,000–8,000 | **$3,000** | DFA + automated self-calibration |
| Packaging / spares | $1,000–2,500 | **$1,500** | — |
| **COGS** | **$35,000–60,000** | **~$23,000** | |

At $49,500 / $23,000 COGS = **~54% gross margin**; volume purchasing → ~$20K
COGS → **~60%**. Recurring software ($1,500/mo target) carries the rest.

---

## 1. Integrated instrument PCBA — the big lever ($8–18K → ~$4K)

Do not put bench instruments inside the machine. Design one or two custom
measurement boards (a good FirstLight-Compose showcase, and a moat: a
competitor gluing COTS instruments together cannot match this cost).

### Capture front-end (scope + logic + AWG + spectrum, one board)
- **SoC:** Xilinx Zynq-7010/7020 (Red Pitaya STEMlab architecture). Dual
  125 MS/s 14-bit ADC + dual 125 MS/s DAC. ~$300–500 in parts at volume.
  - Gives: 2–4 ch scope (~50–60 MHz usable), 16-ch logic, AWG/function gen,
    FFT/spectrum — replacing PicoScope + Saleae + AWG (~$5K of boxes).
  - Candidate ADC if building discrete instead of Pitaya module: **LTC2158-14**
    (dual 14-bit 310 MS/s) or **AD9648** (dual 14-bit 125 MS/s).
- **First-unit fallback:** Digilent **Analog Discovery Pro ADP3450** ($1.2–1.8K)
  or **Analog Discovery 3** — one USB box covers scope/logic/AWG while the
  custom board is in development.

### Precision DC front-end (DMM role, 4.5–5.5 digit)
- **ADC:** **TI ADS1263** (32-bit, 38.4 kSPS, PGA) or **MAX11410** (24-bit) —
  ~$8–15. With a **ADR4525 / LTC6655** reference (~$5). 4.5–5.5 digit accuracy,
  which is plenty for rail/leakage/continuity. Total front-end < $50.
- Reserve true **6.5-digit** (Keithley-class, $1–3K) for a **Precision/Cal Pack**,
  not the base.

### Programmable multi-rail supply
- DAC-controlled buck/LDO rails: **DAC7565/DAC8564** + adjustable regulators
  (**LT3081** current-programmable, or **TPS7A** for low-noise). Per-rail parts
  ~$8–20. INA-class current sense (**INA228**, 20-bit, ~$2) per rail.
- Replaces a bench programmable supply ($500–3K).

### Electronic load
- FET-based constant-current/constant-power load: power MOSFETs + op-amp loop +
  DAC setpoint + thermal (heatsink/fan). 60–150 W custom load < $60 in parts vs
  a $500–3K bench e-load. Thermal is the design work, not the cost.

### Relay / instrument-routing matrix (keep custom)
- Reed or solid-state relays sourced in volume (**Coto 9007**, or SSR
  **AQY212** for signal paths). Multiplex the shared instruments to probe
  points. This is already the custom architecture in the current BOM.

**Subsystem target: ~$4,000** (capture board ~$0.8–1.2K assembled, DC front-end
+ supply + load ~$1.5–2K, matrix ~$1K, connectors/shielding ~$0.5K).

---

## 2. Motion — right-size to 25–50 µm ($4–8K → ~$3K)

Bring-up probing does not need 1 µm ground ballscrews and servos.

- **XY drive:** belt (GT2/GT3) or lightweight lead-screw with **closed-loop
  NEMA 17/23 + encoder** (or Teknic ClearPath-SD if budget allows). Belt XY at
  20–50 µm repeatability is proven in quality desktop CNC / pick-and-place.
- **Rails:** standard-grade profiled linear rails (**HIWIN MGN/EGH** economy, or
  quality clones) — not the top precision class.
- **Z-axis:** this is where precision matters — lead-screw or fine ballscrew +
  the probe **force sensor** (load cell / strain gauge on the probe head) for
  controlled touchdown. Spend here.
- **Controller:** motion on the SBC + a real-time MCU (**RP2040 / STM32** step
  generation), or a low-cost dedicated controller. Avoid a $2–6K Galil-class
  controller in the base.

**Subsystem target: ~$3,000.**

---

## 3. Tool changer + wall dock ($2–5K → ~$1.5K)

- **Coupling:** kinematic 3-point seat + magnetic or pneumatic lock
  (E3D-toolchanger / Voron-tap style). $200–800 in parts, repeatable to the
  probe-accuracy budget. No CNC automatic tool changer.
- **Dock:** passive precision seats along the right wall — machined or printed
  fixtures + locating pins. Nearly free; the carriage picks/places.
- Keep **electrical/pneumatic pass-through** in the coupling so heads get
  power/signal/vacuum without a tool-side battery.

**Subsystem target: ~$1,500.**

---

## 4. Vision + inspection ($1.5–4K → ~$1.2K)

- **One camera** does localization and inspection: **Sony IMX** global-shutter
  sensor module (**IMX296 / IMX264**, $150–400) on the head.
- **Optics:** motorized-focus or **liquid lens** (Corning Varioptic, ~$40–80)
  to switch between board-overview and microscope-detail without a second
  camera. Telecentric lens option for a later Optical Inspection Pack.
- **Lighting:** LED ring + coaxial ($30–80). Cheap.

**Subsystem target: ~$1,200.** (A dedicated high-res microscope + thermal camera
move to the **Optical Inspection Pack**.)

---

## 5. Heads (probe / comms / manipulation) — ~$3,000

Mostly mechanical + connectors + small head PCBAs; the measurement smarts live
in the shared instrument board (Section 1).

- **Probe head:** spring pogo(s), Kelvin 4-wire pairs, force sensor, head camera
  feed. Pogo/coax contacts $5–40 each.
- **Comms head:** level-translated JTAG/SWD/UART/SPI/I2C/CAN/USB/Ethernet driven
  by an onboard **FT2232H / RP2040** + transceivers. < $60 in parts.
- **Manipulation head:** small servo/solenoid actuator + compliant tip for
  buttons/switches/connectors. Light gripper as a later Robotics Pack upgrade.

**Subsystem target: ~$3,000** across the standard head set.

---

## 6. Compute + touchscreen ($2–5K → ~$1.3K)

- **The heavy AI (Compose, diagnosis LLM) runs in the cloud.** Onboard compute
  orchestrates motion, vision, and UI only.
- **SBC:** NVIDIA **Jetson Orin Nano** ($250–500, if local vision inference is
  wanted) or an **x86 mini-PC** ($300–500) or **Raspberry Pi 5** + real-time MCU.
- **Touchscreen:** 10–15" capacitive panel, $80–200. Not a $1K industrial HMI.

**Subsystem target: ~$1,300.**

---

## 7. Enclosure / fixture / assembly

- **Enclosure ($2.5K):** aluminum extrusion frame + folded sheet-metal panels +
  PC/acrylic window (already the extrusion-friendly direction in the current
  CAD). Injection-molded cosmetic panels only once volume amortizes tooling.
- **Fixture / cabling ($2K):** modular 3D-printed nest plates on the universal
  M5 grid (already in CAD); kitted harnesses.
- **Assembly / cal / QA ($3K):** design-for-assembly (fewer parts from the
  integration above) + **automated self-calibration** against the fiducial /
  touch-off / force-reference targets already modeled (see
  `production-readiness-report.md` §2.5). Self-cal is the biggest labor cut.

---

## Sequencing (reconciles with pricing)

1. **First units (EVT/early access):** COTS-heavy — ADP3450 capture box, COTS
   supply/DMM, ClearPath motion. COGS $35–60K. Price early units nearer
   **$69,500**; do not sell below build cost.
2. **Integration pass (DVT → volume):** custom capture PCBA, custom
   supply/load, belt motion, kinematic changer, SBC compute. COGS → ~$23K.
   Drop price to the **$49,500** founding target with ~54% margin.
3. **Volume purchasing:** COGS → ~$20K, ~60% margin.

## Open items before locking the BOM

- Prototype the Zynq/Pitaya capture board vs ADP3450 on real bring-up waveforms
  to confirm 50–60 MHz + 14-bit is sufficient for the target board classes.
- Bandwidth check: if any target needs >100 MHz debug, the base stays COTS and
  high-speed moves to a pack.
- Motion repeatability test: confirm belt XY holds ≤50 µm at the probe over the
  full travel and thermal range.
- Reconcile against `flagship-cots-sourcing-bom.csv` line items and update the
  RFQ with the integrated-instrument direction.
