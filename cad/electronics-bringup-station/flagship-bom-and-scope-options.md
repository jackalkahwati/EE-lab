# Flagship BOM and COTS Oscilloscope Options

This estimate is for the flagship Autonomous NPI Bring-Up Cell, not the sub-$25k prosumer derivative.

Target commercial price:

- Base flagship: $149k-$249k.
- Enterprise/defense configuration: $300k-$500k.
- Annual software/support: $25k-$75k.

Recommended hardware COGS target:

- Early prototype / low volume: $60k-$110k.
- Mature low-volume production: $40k-$75k.
- Scaled production with better purchasing: $30k-$55k.

## BOM Estimate

### Mechanical Structure and Enclosure

- Welded or bolted aluminum frame: $1.5k-$5k.
- Machined fixture deck and instrument deck: $1k-$4k.
- Sheet-metal enclosure panels: $2k-$8k low volume; lower at scale.
- Smoked glass/polycarbonate front door: $500-$2k.
- Hinges, latches, gaskets, feet, service hardware: $500-$2.5k.
- Internal lighting and chamber finishing: $200-$1k.

Estimated subtotal: $5.7k-$22.5k.

### Motion System

- Precision linear rails and carriages: $1k-$4k.
- Ballscrews, bearing blocks, couplers: $1k-$4k.
- Servo or closed-loop stepper motors: $1.5k-$6k.
- Motor drives and motion controller: $1.5k-$6k.
- Limit switches, encoders, E-stop/safety interlocks: $500-$2k.
- Cable chains and motion harnessing: $500-$2k.

Estimated subtotal: $6k-$24k.

### Probe Head and Fixture

- Machined probe head housing: $500-$2.5k.
- Pogo probes, coax probe contacts, cartridges: $500-$3k.
- Force/load sensor stack: $200-$1.5k.
- Probe-mounted camera and optics: $150-$1.5k.
- Tool changer/probe cartridge interface: $500-$3k.
- Universal PCB fixture/clamps/tooling pins: $500-$3k.
- Vacuum hold-down components: $200-$1.5k.

Estimated subtotal: $2.6k-$16k.

### Vision, Compute, and Control

- Overhead industrial camera: $300-$2k.
- Lens, lighting, brackets: $300-$1.5k.
- Embedded PC or industrial mini PC: $800-$3k.
- Safety controller / I/O controller / DAQ support: $500-$3k.
- Internal networking, USB hubs, cabling: $300-$1.5k.

Estimated subtotal: $2.2k-$11k.

### Integrated Instruments

- Programmable power supply module: $500-$3k.
- Precision DMM or measurement front-end: $300-$2.5k.
- Logic analyzer / digital capture: $300-$2k.
- Relay matrix and switching: $2k-$12k.
- Oscilloscope module: $1k-$25k depending bandwidth/resolution/vendor.
- Electronic load: $500-$3k.
- Protection, isolation, calibration, signal conditioning: $1k-$8k.

Estimated subtotal: $5.6k-$55.5k.

### Manufacturing, Assembly, and Calibration

- Wiring harnesses and shielded signal cables: $1k-$5k.
- Assembly labor: $4k-$15k.
- Calibration and verification: $2k-$10k.
- Packaging and shipping hardware: $500-$3k.
- Quality margin / rework reserve: $2k-$10k.

Estimated subtotal: $9.5k-$43k.

## COTS Oscilloscope Hardware Options

### Best First Flagship Choice: PicoScope 3000 or 5000 Series

Use when:

- You want real API control.
- You need 4 analog channels.
- You want 100-200 MHz class bandwidth.
- You need a practical integration path without PXI cost.

Candidate models:

- PicoScope 2408B: 4 channels, 100 MHz, 8-bit, about $1k-$1.7k class.
- PicoScope 3405D / 3406D: 4 channels, 100-200 MHz, 8-bit, about $1.5k-$2.5k class.
- PicoScope 5443D / 5444D: 4 channels, 100-200 MHz, flexible 8-16 bit resolution, about $2k-$3.5k class.

Why it fits:

- USB controlled.
- Published SDK/API.
- Compact.
- Good enough for many board bring-up waveforms.
- Much cheaper than PXI.

Main concern:

- Front-panel BNC style modules need internal mounting, proper shielding, and careful probe/relay-matrix signal integrity.

### Best Integrated Multi-Instrument Choice: Digilent Analog Discovery Pro ADP3450

Use when:

- You want scope, logic analyzer, AWG, protocol analysis, and scripting in one COTS unit.
- 55 MHz analog bandwidth is acceptable.
- The machine focuses on first-pass bring-up, rails, buses, clocks, resets, and basic mixed-signal workflows.

Specs:

- 4 analog channels.
- 55 MHz bandwidth.
- 14-bit ADC.
- 16 digital channels.
- WaveForms SDK/API.
- USB/Ethernet.
- Around $1.2k-$1.8k class depending kit.

Why it fits:

- Very strong for MVP and early flagship prototypes.
- One module covers multiple instrument roles.
- Good software integration story.

Main concern:

- 55 MHz bandwidth is not enough for serious high-speed debug.
- Single-ended inputs and grounding need careful relay/probe design.

### Enterprise Option: NI PXIe

Use when:

- Customer wants enterprise-grade modular instrumentation.
- Budget supports a PXIe chassis.
- Synchronization, calibration, and supportability matter more than COGS.

Candidate class:

- NI PXIe 100 MHz, 4-channel, 14-bit modules.
- PXIe oscilloscope bundles.

Expected cost:

- Often $16k-$25k+ for the scope module alone.
- More once chassis/controller are included.

Why it fits:

- Enterprise credibility.
- Strong driver support.
- Easier to sell to large labs already using NI.

Main concern:

- Cost explodes quickly.
- Not appropriate for the standard flagship base unit unless priced high.

### Cost-Optimized Option: Red Pitaya

Use when:

- You need low-cost embedded scope/signal generation.
- 2 channels and 50 MHz class bandwidth are acceptable.
- You are building a lower-cost derivative or internal prototype.

Specs:

- 2 analog inputs.
- 14-bit, 125 MS/s.
- 50 MHz class oscilloscope use.
- Ethernet remote control.
- Python/SCPI/API support.
- Roughly sub-$1k class depending kit.

Why it fits:

- Cheap.
- Hackable.
- Good for prototype/software development.

Main concern:

- Not a flagship-quality scope module by itself.
- Only 2 channels.
- More engineering burden to make it feel like a product.

## Recommendation

For the first flagship prototype, use a COTS instrument stack:

- PicoScope 5444D or 3406D for oscilloscope.
- Saleae Logic Pro or Digilent ADP3450 for logic/protocol capture, depending desired integration.
- Korad/TDK/Keysight/EA class programmable PSU for prototype, then replace with an embedded module.
- COTS DMM module or precision ADC front-end.
- Custom relay matrix, protection board, and probe interface.

For the commercial flagship, keep the scope COTS for the first 50-100 units unless a customer requirement forces custom instrumentation. The proprietary value should be in the automation software, probe head, fixture workflow, relay/protection architecture, calibration process, and AI-guided bring-up sequence.
