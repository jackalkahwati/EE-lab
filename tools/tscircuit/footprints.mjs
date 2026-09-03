/**
 * Synthetic footprint generator.
 *
 * Why this exists. The board runner only ever accepted two things natively:
 * `qfn4`..`qfn64` and 0402-class passives. Everything else had to arrive with a
 * real `.kicad_mod` fetched from a supplier, so a netlist containing something
 * as ordinary as a 17-pin header was rejected outright before placement ever
 * ran. That is the single biggest reason the pipeline could not take on a more
 * complicated product: not routing, not placement, just "I don't know what that
 * part looks like."
 *
 * Rather than teach the emitter about new part shapes, this generates the
 * `.kicad_mod` text for the common families and hands it to the SAME
 * `kicadModToFootprint()` path a supplier part goes through. Downstream —
 * tscircuit, KiCad, DRC, the router — is untouched.
 *
 * Dimensions are IPC-7351 nominal (density level B, "medium") land patterns,
 * matching what the KiCad standard library ships. They are deliberately
 * GENERIC: a real part's datasheet may differ, so a synthesized footprint is
 * marked `synthetic: true` and a supplier `kicadMod` always wins when present.
 *
 * Coordinates are KiCad convention (y grows downward); the caller's parser
 * flips y, so do not pre-flip here.
 */

/** IPC-nominal two-terminal chip lands: [padW, padH, centreOffsetX]. */
const CHIP = {
  '0201': [0.46, 0.42, 0.26],
  '0402': [0.59, 0.64, 0.51],
  '0603': [0.90, 0.95, 0.78],
  '0805': [1.00, 1.45, 0.95],
  '1206': [1.15, 1.80, 1.48],
  '1210': [1.15, 2.70, 1.48],
  '1812': [1.30, 3.40, 1.98],
  '2010': [1.25, 2.65, 2.30],
  '2512': [1.60, 3.35, 2.90],
}

/** Gull-wing dual-row families: [pitch, padW, padH, rowSpan (pad centre to pad centre)]. */
const DUAL = {
  soic: [1.27, 0.60, 1.55, 5.40],
  soicw: [1.27, 0.60, 1.55, 9.40],
  sop: [1.27, 0.60, 1.55, 5.40],
  ssop: [0.65, 0.45, 1.45, 5.60],
  tssop: [0.65, 0.45, 1.45, 6.40],
  msop: [0.65, 0.40, 1.15, 4.40],
  qsop: [0.635, 0.40, 1.55, 5.60],
  sois: [1.27, 0.60, 1.55, 5.40],
}

/** No-lead dual-row families (DFN/SON): [pitch, padW, padH, rowSpan]. */
const NOLEAD = {
  dfn: [0.50, 0.30, 0.75, 2.40],
  son: [0.50, 0.30, 0.75, 2.40],
}

/** Small-outline transistor packages, explicit pad lists. */
const SOT = {
  // [name]: { pads: [[pin, x, y, w, h], ...] }
  sot23: [['1', -0.95, 1.10, 0.90, 1.00], ['2', 0.95, 1.10, 0.90, 1.00], ['3', 0, -1.10, 0.90, 1.00]],
  'sot23-3': [['1', -0.95, 1.10, 0.90, 1.00], ['2', 0.95, 1.10, 0.90, 1.00], ['3', 0, -1.10, 0.90, 1.00]],
  'sot23-5': [
    ['1', -0.95, 1.10, 0.60, 1.00], ['2', 0, 1.10, 0.60, 1.00], ['3', 0.95, 1.10, 0.60, 1.00],
    ['4', 0.95, -1.10, 0.60, 1.00], ['5', -0.95, -1.10, 0.60, 1.00],
  ],
  'sot23-6': [
    ['1', -0.95, 1.10, 0.60, 1.00], ['2', 0, 1.10, 0.60, 1.00], ['3', 0.95, 1.10, 0.60, 1.00],
    ['4', 0.95, -1.10, 0.60, 1.00], ['5', 0, -1.10, 0.60, 1.00], ['6', -0.95, -1.10, 0.60, 1.00],
  ],
  sot223: [
    ['1', -2.30, 3.15, 1.20, 2.20], ['2', 0, 3.15, 1.20, 2.20], ['3', 2.30, 3.15, 1.20, 2.20],
    ['4', 0, -3.15, 3.80, 2.20],
  ],
  sot89: [
    ['1', -1.50, 1.60, 1.00, 1.40], ['2', 0, 1.60, 1.00, 1.40], ['3', 1.50, 1.60, 1.00, 1.40],
    ['4', 0, -1.20, 1.80, 1.20],
  ],
  sod123: [['1', -1.65, 0, 1.00, 1.20], ['2', 1.65, 0, 1.00, 1.20]],
  sod323: [['1', -1.20, 0, 0.80, 0.80], ['2', 1.20, 0, 0.80, 0.80]],
  sod523: [['1', -0.85, 0, 0.60, 0.60], ['2', 0.85, 0, 0.60, 0.60]],
  sma: [['1', -2.15, 0, 1.50, 2.50], ['2', 2.15, 0, 1.50, 2.50]],
  smb: [['1', -2.60, 0, 2.00, 2.60], ['2', 2.60, 0, 2.00, 2.60]],
  smc: [['1', -3.60, 0, 2.20, 3.20], ['2', 3.60, 0, 2.20, 3.20]],
  dpak: [['1', -2.30, 2.75, 1.30, 1.60], ['2', 0, 2.75, 1.30, 1.60], ['3', 2.30, 2.75, 1.30, 1.60], ['4', 0, -2.10, 5.40, 3.20]],
}

const pad = (n, x, y, w, h) =>
  `  (pad "${n}" smd rect (at ${x.toFixed(3)} ${y.toFixed(3)}) (size ${w.toFixed(3)} ${h.toFixed(3)}) (layers "F.Cu" "F.Paste" "F.Mask"))`

const thtPad = (n, x, y, dia, drill) =>
  `  (pad "${n}" thru_hole ${n === '1' ? 'rect' : 'circle'} (at ${x.toFixed(3)} ${y.toFixed(3)}) (size ${dia.toFixed(3)} ${dia.toFixed(3)}) (drill ${drill.toFixed(3)}) (layers "*.Cu" "*.Mask"))`

const wrap = (name, lines) => `(footprint "${name}" (layer "F.Cu")\n${lines.join('\n')}\n)`

/** Two rows of gull-wing pads, pin 1 top-left, counting counter-clockwise. */
function dualRow(name, pins, [pitch, pw, ph, span]) {
  if (pins < 4 || pins % 2) return null
  const perSide = pins / 2
  const y = span / 2
  const x0 = -((perSide - 1) * pitch) / 2
  const lines = []
  for (let i = 0; i < perSide; i++) lines.push(pad(String(i + 1), x0 + i * pitch, y, pw, ph))
  for (let i = 0; i < perSide; i++) lines.push(pad(String(pins - i), x0 + i * pitch, -y, pw, ph))
  return wrap(name, lines)
}

/** Four sides of gull-wing pads (QFP family), pin 1 top-left, counter-clockwise. */
function quadRow(name, pins, pitch) {
  if (pins < 8 || pins % 4) return null
  const perSide = pins / 4
  // Body span derived from the pad count so a 144-pin part isn't drawn at 32-pin size.
  const span = (perSide + 1) * pitch + 1.6
  const pw = Math.min(0.30, pitch * 0.55)
  const ph = 1.2
  const start = -((perSide - 1) * pitch) / 2
  const lines = []
  let n = 1
  // left side, top -> bottom
  for (let i = 0; i < perSide; i++) lines.push(pad(String(n++), -span / 2, start + i * pitch, ph, pw))
  // bottom, left -> right
  for (let i = 0; i < perSide; i++) lines.push(pad(String(n++), start + i * pitch, span / 2, pw, ph))
  // right side, bottom -> top
  for (let i = 0; i < perSide; i++) lines.push(pad(String(n++), span / 2, start + (perSide - 1 - i) * pitch, ph, pw))
  // top, right -> left
  for (let i = 0; i < perSide; i++) lines.push(pad(String(n++), start + (perSide - 1 - i) * pitch, -span / 2, pw, ph))
  return wrap(name, lines)
}

/** Pin headers / receptacles, through-hole, pin 1 at top-left. */
function header(name, rows, cols, pitch) {
  const drill = pitch >= 2.5 ? 1.0 : pitch >= 1.9 ? 0.8 : 0.65
  const dia = pitch >= 2.5 ? 1.7 : pitch >= 1.9 ? 1.35 : 1.05
  const x0 = -((cols - 1) * pitch) / 2
  const y0 = -((rows - 1) * pitch) / 2
  const lines = []
  let n = 1
  // KiCad convention for 2xN: pins alternate between rows down each column.
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) lines.push(thtPad(String(n++), x0 + c * pitch, y0 + r * pitch, dia, drill))
  }
  return wrap(name, lines)
}

/** Screw / pluggable terminal blocks. */
function terminal(name, ways, pitch) {
  const x0 = -((ways - 1) * pitch) / 2
  const lines = []
  for (let i = 0; i < ways; i++) lines.push(thtPad(String(i + 1), x0 + i * pitch, 0, pitch * 0.55, 1.2))
  return wrap(name, lines)
}

/**
 * Build a `.kicad_mod` for a footprint name, or null when the family is unknown.
 * Names are matched case-insensitively and tolerate `_`, `-` and spaces.
 */
export function synthFootprint(raw) {
  const fp = String(raw ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-')
  if (!fp) return null

  // Two-terminal chip passives: 0402, r0603, c1206, 0805-cap ...
  const chip = fp.match(/(^|[^0-9])(0201|0402|0603|0805|1206|1210|1812|2010|2512)([^0-9]|$)/)
  if (chip) {
    const [pw, ph, dx] = CHIP[chip[2]]
    return wrap(fp, [pad('1', -dx, 0, pw, ph), pad('2', dx, 0, pw, ph)])
  }

  // Explicit small-outline / diode / power packages.
  const sotKey = fp.replace(/^(sot|sod|sma|smb|smc|dpak)-?/, (m) => m.replace('-', ''))
  for (const key of Object.keys(SOT)) {
    if (sotKey === key || fp === key) {
      return wrap(fp, SOT[key].map((p) => pad(...p)))
    }
  }

  // Headers: header-1x17, hdr-2x10, conn-1x4-p200, pinheader-2x5 ...
  const hdr = fp.match(/^(?:header|hdr|conn|connector|pinheader|pinsocket|socket)-?(\d+)x(\d+)(?:-p?(\d+))?$/)
  if (hdr) {
    const rows = +hdr[1]
    const cols = +hdr[2]
    // Optional pitch suffix in hundredths of a mm: -p127 => 1.27 mm.
    const pitch = hdr[3] ? +hdr[3] / 100 : 2.54
    if (rows >= 1 && rows <= 4 && cols >= 1 && cols <= 64) return header(fp, rows, cols, pitch)
    return null
  }

  // Terminal blocks: screwterminal-3, terminal-2-p508
  const term = fp.match(/^(?:screwterminal|terminal|tblock)-?(\d+)(?:-p?(\d+))?$/)
  if (term) {
    const ways = +term[1]
    const pitch = term[2] ? +term[2] / 100 : 5.08
    if (ways >= 2 && ways <= 16) return terminal(fp, ways, pitch)
    return null
  }

  // Quad flat packs: tqfp32, lqfp-100, qfp144, tqfp64-p50
  const qfp = fp.match(/^(?:t|l|m|p)?qfp-?(\d+)(?:-p?(\d+))?$/)
  if (qfp) {
    const pins = +qfp[1]
    const pitch = qfp[2] ? +qfp[2] / 100 : pins <= 44 ? 0.8 : 0.5
    if (pins >= 8 && pins <= 208) return quadRow(fp, pins, pitch)
    return null
  }

  // Dual-row gull-wing and no-lead: soic8, tssop-20, msop10, dfn8, son-6
  const dual = fp.match(/^([a-z]+)-?(\d+)(?:-?w)?$/)
  if (dual) {
    const fam = dual[1]
    const pins = +dual[2]
    const wide = /w$/.test(fp) || fam === 'soicw'
    const table = DUAL[wide && fam === 'soic' ? 'soicw' : fam] ?? NOLEAD[fam]
    if (table && pins >= 4 && pins <= 64) return dualRow(fp, pins, table)
  }

  return null
}

/** Families this generator understands, for error messages and docs. */
export const SYNTH_FAMILIES = [
  'chip passives 0201..2512',
  'soic/soicw/sop/ssop/tssop/msop/qsop 4..64',
  'dfn/son 4..64',
  'sot23, sot23-3/5/6, sot223, sot89, dpak',
  'sod123/sod323/sod523, sma/smb/smc',
  'qfp/tqfp/lqfp/mqfp 8..208 (optional -pNNN pitch)',
  'header/hdr/conn/pinheader/socket RxC (optional -pNNN pitch, default 2.54)',
  'screwterminal/terminal N (optional -pNNN pitch, default 5.08)',
]
