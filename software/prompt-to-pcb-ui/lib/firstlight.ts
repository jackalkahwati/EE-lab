export type StageId = 'design' | 'placement' | 'routing' | 'validation'
export type StageState = 'pending' | 'running' | 'passed' | 'failed' | 'blocked'
export type RunStatus = 'RUNNING' | 'PASSED' | 'GATE FAILED'

export interface StageStatus {
  id: StageId
  state: StageState
  elapsedMs: number
  failReason?: string
}

export interface RunMetrics {
  netsRouted: number
  netsTotal: number
  copperDefects: number
  hpwl: number
  hpwlHistory: number[]
  components: number
  bomLines: number
  boardSize: string
  layers: number
  routeTimeSec: number
}

export interface Run {
  id: string
  name: string
  timestamp: string
  status: RunStatus
  prompt: string
  stages: StageStatus[]
  metrics: RunMetrics
  logs: LogLine[]
  /** true when this run is backed by real KiCad artifacts in public/ */
  real?: boolean
}

export interface LogLine {
  stage: StageId
  prefix: string
  text: string
  level?: 'info' | 'ok' | 'warn' | 'err'
}

export interface StageDef {
  id: StageId
  label: string
  tool: string
  gate: string
  substeps: string[]
  durationMs: number
}

export const STAGE_DEFS: StageDef[] = [
  {
    id: 'design',
    label: 'Design',
    tool: 'atopile',
    gate: 'BUILD GREEN',
    substeps: ['.ato modules', 'parts bound (LCSC)', 'ato build'],
    durationMs: 4000,
  },
  {
    id: 'placement',
    label: 'Placement',
    tool: 'place_and_zone',
    gate: 'PLACEMENT GATE',
    substeps: ['place_and_zone', 'courtyards', 'zones'],
    durationMs: 6000,
  },
  {
    id: 'routing',
    label: 'Routing',
    tool: 'flroute',
    gate: 'EMISSION GATE',
    substeps: ['DSN export', 'A* + PathFinder', 'consolidation'],
    durationMs: 35000,
  },
  {
    id: 'validation',
    label: 'Validation',
    tool: 'KiCad referee',
    gate: 'DRC = 0',
    substeps: ['SES import', 'zone fill', 'kicad-cli DRC'],
    durationMs: 8000,
  },
]

export const STAGE_PREFIX: Record<StageId, string> = {
  design: 'ato',
  placement: 'place',
  routing: 'route',
  validation: 'drc',
}

/* ------------------------------------------------------------------ */
/* Seeded runs                                                         */
/* ------------------------------------------------------------------ */

const passedLogs: LogLine[] = [
  { stage: 'design', prefix: 'ato', text: 'compiling 6 modules: main, power, matrix, protection, mcu, cartridge' },
  { stage: 'design', prefix: 'ato', text: 'resolving picker: 29 parts bound to LCSC stock' },
  { stage: 'design', prefix: 'ato', text: 'C25804 RP2040 ✓ · C165948 USB-C ✓ · C115008 HFD3/5 x88 ✓' },
  { stage: 'design', prefix: 'ato', text: 'ato build → netlist: 174 nets, 172 components', level: 'ok' },
  { stage: 'design', prefix: 'ato', text: 'GATE design: BUILD GREEN — PASS', level: 'ok' },
  { stage: 'placement', prefix: 'place', text: 'place_and_zone: seeding 8x11 relay lattice, pitch 16.5 x 13.0 mm' },
  { stage: 'placement', prefix: 'place', text: 'courtyard sweep: 0 overlaps, 0 off-board' },
  { stage: 'placement', prefix: 'place', text: 'zones: GND pour F.Cu/B.Cu, 24V pour In2.Cu' },
  { stage: 'placement', prefix: 'place', text: 'HPWL = 14,302 mm (prev best 15,887)', level: 'ok' },
  { stage: 'placement', prefix: 'place', text: 'GATE placement: overlaps=0 off-board=0 — PASS', level: 'ok' },
  { stage: 'routing', prefix: 'route', text: 'DSN export → 174 nets, 4 layers, grid 0.05mm' },
  { stage: 'routing', prefix: 'route', text: 'A* + PathFinder: pass 1 — 121/174 routed' },
  { stage: 'routing', prefix: 'route', text: 'A* + PathFinder: pass 2 — 150/174 routed' },
  { stage: 'routing', prefix: 'route', text: 'consolidation: 24 nets failed DRC pre-check, withheld from emission', level: 'warn' },
  { stage: 'routing', prefix: 'route', text: 'GATE emission: 150 DRC-clean nets shipped, 0 dirty nets emitted — PASS', level: 'ok' },
  { stage: 'validation', prefix: 'drc', text: 'SES import → board.kicad_pcb' },
  { stage: 'validation', prefix: 'drc', text: 'zone fill: 3 zones, 2.41s' },
  { stage: 'validation', prefix: 'drc', text: 'kicad-cli pcb drc --severity-error → 0 violations', level: 'ok' },
  { stage: 'validation', prefix: 'drc', text: 'GATE validation: DRC = 0 — PASS', level: 'ok' },
  { stage: 'validation', prefix: 'drc', text: 'artifacts: gerbers.zip bom.csv pick_and_place.csv board.step drc.json', level: 'ok' },
]

const failedLogs: LogLine[] = [
  { stage: 'design', prefix: 'ato', text: 'compiling 6 modules: main, power, matrix, protection, mcu, cartridge' },
  { stage: 'design', prefix: 'ato', text: 'resolving picker: 29 parts bound to LCSC stock' },
  { stage: 'design', prefix: 'ato', text: 'ato build → netlist: 174 nets, 172 components', level: 'ok' },
  { stage: 'design', prefix: 'ato', text: 'GATE design: BUILD GREEN — PASS', level: 'ok' },
  { stage: 'placement', prefix: 'place', text: 'place_and_zone: seeding 8x11 relay lattice, pitch 16.0 x 12.6 mm' },
  { stage: 'placement', prefix: 'place', text: 'courtyard sweep: 1 overlap detected', level: 'warn' },
  { stage: 'placement', prefix: 'place', text: 'courtyard overlap: K12 ↔ K13 (Δ 0.42mm on x-axis)', level: 'err' },
  { stage: 'placement', prefix: 'place', text: 'GATE placement: overlaps=1 — FAIL. Pipeline halted.', level: 'err' },
]

export const SEED_RUNS: Run[] = [
  {
    id: 'run-fl1',
    name: 'FL-1 Relay Matrix Rev A',
    timestamp: '2026-06-12 09:14',
    status: 'PASSED',
    prompt:
      '8x11 relay probe matrix, 4-layer, RP2040 control, USB-C, 24V input',
    stages: [
      { id: 'design', state: 'passed', elapsedMs: 4100 },
      { id: 'placement', state: 'passed', elapsedMs: 6300 },
      { id: 'routing', state: 'passed', elapsedMs: 35000 },
      { id: 'validation', state: 'passed', elapsedMs: 7800 },
    ],
    metrics: {
      netsRouted: 150,
      netsTotal: 174,
      copperDefects: 0,
      hpwl: 14302,
      hpwlHistory: [18934, 17211, 15887, 14302],
      components: 172,
      bomLines: 29,
      boardSize: '200 × 175 mm',
      layers: 4,
      routeTimeSec: 35,
    },
    logs: passedLogs,
  },
  {
    id: 'run-fl2',
    name: 'FL-1 Relay Matrix Rev B',
    timestamp: '2026-06-12 11:02',
    status: 'GATE FAILED',
    prompt:
      '8x11 relay probe matrix, tighter pitch, 4-layer, RP2040, USB-C, 24V',
    stages: [
      { id: 'design', state: 'passed', elapsedMs: 3900 },
      {
        id: 'placement',
        state: 'failed',
        elapsedMs: 5100,
        failReason: 'courtyard overlap: K12 ↔ K13',
      },
      { id: 'routing', state: 'blocked', elapsedMs: 0 },
      { id: 'validation', state: 'blocked', elapsedMs: 0 },
    ],
    metrics: {
      netsRouted: 0,
      netsTotal: 174,
      copperDefects: 0,
      hpwl: 13871,
      hpwlHistory: [18934, 17211, 15887, 14302, 13871],
      components: 172,
      bomLines: 29,
      boardSize: '195 × 168 mm',
      layers: 4,
      routeTimeSec: 0,
    },
    logs: failedLogs,
  },
]

/* ------------------------------------------------------------------ */
/* BOM                                                                 */
/* ------------------------------------------------------------------ */

export interface BomLine {
  ref: string
  part: string
  lcsc: string
  qty: number
  unitPrice: number
  lineType: 'ordered' | 'buyer-furnished'
}

export const BOM_LINES: BomLine[] = [
  { ref: 'K1–K88', part: 'HFD3/5-L2 signal relay, DPDT 5V latching', lcsc: 'C115008', qty: 88, unitPrice: 1.82, lineType: 'ordered' },
  { ref: 'U1', part: 'RP2040 dual Cortex-M0+ MCU', lcsc: 'C2040', qty: 1, unitPrice: 0.96, lineType: 'ordered' },
  { ref: 'U2', part: 'W25Q128JVS 16MB QSPI flash', lcsc: 'C97521', qty: 1, unitPrice: 0.84, lineType: 'ordered' },
  { ref: 'U3–U13', part: 'TPIC6B595 8-bit power shift register', lcsc: 'C16133', qty: 11, unitPrice: 0.92, lineType: 'ordered' },
  { ref: 'U14', part: 'AP63357 24V→5V 3.5A buck converter', lcsc: 'C2071917', qty: 1, unitPrice: 0.78, lineType: 'ordered' },
  { ref: 'U15', part: 'AMS1117-3.3 LDO regulator', lcsc: 'C6186', qty: 1, unitPrice: 0.12, lineType: 'ordered' },
  { ref: 'U16', part: 'USBLC6-2SC6 USB ESD protection', lcsc: 'C7519', qty: 1, unitPrice: 0.21, lineType: 'ordered' },
  { ref: 'J1', part: 'USB-C 16-pin receptacle, mid-mount', lcsc: 'C165948', qty: 1, unitPrice: 0.34, lineType: 'ordered' },
  { ref: 'J2', part: 'Phoenix 5.08mm 2-pos terminal block, 24V in', lcsc: 'C475125', qty: 1, unitPrice: 0.56, lineType: 'ordered' },
  { ref: 'J3–J10', part: '2x11 2.54mm probe header, gold flash', lcsc: 'C2899727', qty: 8, unitPrice: 0.48, lineType: 'buyer-furnished' },
  { ref: 'J11', part: 'Cartridge edge connector, 2x20', lcsc: 'C9690', qty: 1, unitPrice: 1.14, lineType: 'buyer-furnished' },
  { ref: 'D1–D88', part: '1N4148WS flyback diode, SOD-323', lcsc: 'C2128', qty: 88, unitPrice: 0.01, lineType: 'ordered' },
  { ref: 'D89', part: 'SMBJ24A TVS, 24V line', lcsc: 'C113996', qty: 1, unitPrice: 0.11, lineType: 'ordered' },
  { ref: 'D90', part: 'SS54 Schottky, reverse polarity', lcsc: 'C22452', qty: 1, unitPrice: 0.08, lineType: 'ordered' },
  { ref: 'Q1–Q11', part: 'AO3400A N-MOSFET, coil drive', lcsc: 'C20917', qty: 11, unitPrice: 0.04, lineType: 'ordered' },
  { ref: 'Y1', part: '12MHz crystal, 3225', lcsc: 'C9002', qty: 1, unitPrice: 0.14, lineType: 'ordered' },
  { ref: 'F1', part: '2A resettable fuse, 1206', lcsc: 'C70069', qty: 1, unitPrice: 0.06, lineType: 'ordered' },
  { ref: 'SW1', part: 'BOOT tactile switch, 3x4mm', lcsc: 'C318884', qty: 1, unitPrice: 0.03, lineType: 'ordered' },
  { ref: 'LED1–LED4', part: 'Status LED amber, 0603', lcsc: 'C72038', qty: 4, unitPrice: 0.01, lineType: 'ordered' },
  { ref: 'R1–R16', part: '27Ω 1% 0402, USB / QSPI series', lcsc: 'C25190', qty: 16, unitPrice: 0.002, lineType: 'ordered' },
  { ref: 'R17–R30', part: '10kΩ 1% 0402 pull-up', lcsc: 'C25744', qty: 14, unitPrice: 0.002, lineType: 'ordered' },
  { ref: 'R31–R34', part: '1kΩ 1% 0603 LED series', lcsc: 'C21190', qty: 4, unitPrice: 0.002, lineType: 'ordered' },
  { ref: 'R35–R45', part: '100Ω gate resistor 0402', lcsc: 'C25076', qty: 11, unitPrice: 0.002, lineType: 'ordered' },
  { ref: 'C1–C24', part: '100nF X7R 0402 decoupling', lcsc: 'C1525', qty: 24, unitPrice: 0.003, lineType: 'ordered' },
  { ref: 'C25–C28', part: '10µF X5R 0805 bulk', lcsc: 'C15850', qty: 4, unitPrice: 0.02, lineType: 'ordered' },
  { ref: 'C29–C30', part: '22µF 35V electrolytic, 24V rail', lcsc: 'C134802', qty: 2, unitPrice: 0.05, lineType: 'ordered' },
  { ref: 'C31–C32', part: '15pF C0G 0402, crystal load', lcsc: 'C1548', qty: 2, unitPrice: 0.003, lineType: 'ordered' },
  { ref: 'FB1–FB2', part: 'Ferrite bead 600Ω@100MHz 0603', lcsc: 'C1017', qty: 2, unitPrice: 0.01, lineType: 'ordered' },
  { ref: 'TP1–TP6', part: 'Test point, 1mm pad', lcsc: '—', qty: 6, unitPrice: 0, lineType: 'buyer-furnished' },
]

/* ------------------------------------------------------------------ */
/* .ato source files                                                   */
/* ------------------------------------------------------------------ */

export interface AtoFile {
  name: string
  content: string
}

export const ATO_FILES: AtoFile[] = [
  {
    name: 'main.ato',
    content: `# FL-1 Relay Matrix Rev A — top level
import Power from "power.ato"
import RelayMatrix from "matrix.ato"
import Protection from "protection.ato"
import Mcu from "mcu.ato"
import Cartridge from "cartridge.ato"

module Main:
    power = new Power
    matrix = new RelayMatrix
    protection = new Protection
    mcu = new Mcu
    cartridge = new Cartridge

    # rails
    power.v5 ~ matrix.v5
    power.v3v3 ~ mcu.v3v3
    power.v24_protected ~ protection.v24_out

    # control plane
    mcu.spi ~ matrix.shift_chain
    mcu.usb ~ protection.usb_filtered

    # probe plane
    matrix.rows ~ cartridge.rows
    matrix.cols ~ cartridge.cols`,
  },
  {
    name: 'power.ato',
    content: `# 24V in → 5V buck → 3.3V LDO
import Buck_AP63357 from "generics/regulators.ato"
import LDO_AMS1117 from "generics/regulators.ato"

module Power:
    signal v24_in
    signal v5
    signal v3v3
    signal gnd

    buck = new Buck_AP63357     # C2071917
    ldo = new LDO_AMS1117       # C6186

    v24_in ~ buck.vin
    buck.vout ~ v5
    v5 ~ ldo.vin
    ldo.vout ~ v3v3

    buck.fsw = 1.1MHz
    buck.iout_max = 3.5A
    assert buck.vout within 4.9V to 5.1V`,
  },
  {
    name: 'matrix.ato',
    content: `# 8x11 relay probe matrix — 88 channels
import Relay_HFD3 from "generics/relays.ato"
import TPIC6B595 from "generics/drivers.ato"

module RelayMatrix:
    signal v5
    signal gnd
    interface shift_chain
    signal rows[8]
    signal cols[11]

    # 88 DPDT latching relays, LCSC C115008
    relays = new Relay_HFD3[88]
    drivers = new TPIC6B595[11]

    for i in 0..87:
        relays[i].coil_p ~ drivers[i // 8].out[i % 8]
        relays[i].coil_n ~ gnd
        relays[i].com ~ rows[i % 8]
        relays[i].no ~ cols[i // 8]

    # daisy-chain shift registers
    for j in 0..9:
        drivers[j].ser_out ~ drivers[j + 1].ser_in`,
  },
  {
    name: 'protection.ato',
    content: `# Input protection: TVS, fuse, reverse polarity
import TVS_SMBJ24A from "generics/protection.ato"
import Schottky_SS54 from "generics/diodes.ato"
import Fuse_PTC from "generics/fuses.ato"
import USBLC6 from "generics/esd.ato"

module Protection:
    signal v24_raw
    signal v24_out
    interface usb_filtered

    fuse = new Fuse_PTC          # C70069, 2A hold
    tvs = new TVS_SMBJ24A        # C113996
    rp = new Schottky_SS54       # C22452
    esd = new USBLC6             # C7519

    v24_raw ~ fuse.in
    fuse.out ~ rp.anode
    rp.cathode ~ v24_out
    tvs.line ~ v24_out`,
  },
  {
    name: 'mcu.ato',
    content: `# RP2040 + QSPI flash + USB-C
import RP2040 from "generics/mcus.ato"
import W25Q128 from "generics/memory.ato"
import USBC_16P from "generics/connectors.ato"
import Crystal from "generics/passives.ato"

module Mcu:
    signal v3v3
    signal gnd
    interface spi
    interface usb

    mcu = new RP2040             # C2040
    flash = new W25Q128          # C97521
    usb_conn = new USBC_16P      # C165948
    xtal = new Crystal

    xtal.freq = 12MHz
    mcu.qspi ~ flash.qspi
    mcu.usb_dp ~ usb_conn.dp
    mcu.usb_dm ~ usb_conn.dm
    mcu.spi0 ~ spi`,
  },
  {
    name: 'cartridge.ato',
    content: `# Probe cartridge interface — 2x20 edge connector
import EdgeConn_2x20 from "generics/connectors.ato"
import ProbeHeader_2x11 from "generics/connectors.ato"

module Cartridge:
    signal rows[8]
    signal cols[11]

    edge = new EdgeConn_2x20      # C9690, buyer-furnished
    headers = new ProbeHeader_2x11[8]

    for r in 0..7:
        rows[r] ~ edge.pin[r + 1]
        headers[r].row ~ rows[r]
    for c in 0..10:
        cols[c] ~ edge.pin[c + 9]

    # mechanical: 3.0mm keep-out from board edge
    edge.courtyard_margin = 3.0mm`,
  },
]

/* ------------------------------------------------------------------ */
/* Gate reports                                                        */
/* ------------------------------------------------------------------ */

export interface GateCheck {
  rule: string
  measured: string
  pass: boolean
}

export interface GateReport {
  file: string
  stage: StageId
  checks: GateCheck[]
}

export const GATE_REPORTS_PASSED: GateReport[] = [
  {
    file: 'placement_score.json',
    stage: 'placement',
    checks: [
      { rule: 'courtyard overlaps = 0', measured: '0 overlaps', pass: true },
      { rule: 'off-board components = 0', measured: '0 off-board', pass: true },
      { rule: 'courtyard-to-edge ≥ 3.0mm', measured: 'min 3.2mm', pass: true },
      { rule: 'HPWL ≤ previous best', measured: '14,302 ≤ 15,887', pass: true },
    ],
  },
  {
    file: 'dfm_check.json',
    stage: 'routing',
    checks: [
      { rule: 'min trace width ≥ 0.15mm', measured: 'min 0.20mm', pass: true },
      { rule: 'min clearance ≥ 0.15mm', measured: 'min 0.18mm', pass: true },
      { rule: 'min via drill ≥ 0.30mm', measured: '0.30mm', pass: true },
      { rule: 'dirty nets emitted = 0', measured: '24 withheld, 0 emitted', pass: true },
    ],
  },
  {
    file: 'drc.json',
    stage: 'validation',
    checks: [
      { rule: 'copper DRC violations = 0', measured: '0 violations', pass: true },
      { rule: 'unconnected (withheld) tracked', measured: '24 known, 0 unknown', pass: true },
      { rule: 'zone fill integrity', measured: '3/3 zones filled', pass: true },
    ],
  },
]

export const GATE_REPORTS_FAILED: GateReport[] = [
  {
    file: 'placement_score.json',
    stage: 'placement',
    checks: [
      { rule: 'courtyard overlaps = 0', measured: 'K12 ↔ K13, Δ 0.42mm', pass: false },
      { rule: 'off-board components = 0', measured: '0 off-board', pass: true },
      { rule: 'courtyard-to-edge ≥ 3.0mm', measured: 'min 3.1mm', pass: true },
      { rule: 'HPWL ≤ previous best', measured: '13,871 ≤ 14,302', pass: true },
    ],
  },
]

export const ARTIFACTS = [
  { name: 'gerbers.zip', size: '1.4 MB' },
  { name: 'bom.csv', size: '4.2 KB' },
  { name: 'pick_and_place.csv', size: '11 KB' },
  { name: 'board.step', size: '8.7 MB' },
  { name: 'drc.json', size: '2.1 KB' },
]

/* Log lines emitted progressively during a simulated run */
export const SIM_LOGS: Record<StageId, string[]> = {
  design: [
    'compiling .ato modules: main, power, matrix, protection, mcu, cartridge',
    'resolving picker: binding parts to LCSC stock',
    'ato build → netlist: 174 nets, 172 components',
    'GATE design: BUILD GREEN — PASS',
  ],
  placement: [
    'place_and_zone: seeding relay lattice',
    'courtyard sweep: 0 overlaps, 0 off-board',
    'zones: GND pour F.Cu/B.Cu, 24V pour In2.Cu',
    'GATE placement: overlaps=0 off-board=0 — PASS',
  ],
  routing: [
    'DSN export → 174 nets, 4 layers, grid 0.05mm',
    'A* + PathFinder: routing…',
    'consolidation: withholding DRC-dirty nets from emission',
    'GATE emission: only DRC-clean nets shipped — PASS',
  ],
  validation: [
    'SES import → board.kicad_pcb',
    'zone fill: 3 zones',
    'kicad-cli pcb drc --severity-error → 0 violations',
    'GATE validation: DRC = 0 — PASS',
  ],
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
