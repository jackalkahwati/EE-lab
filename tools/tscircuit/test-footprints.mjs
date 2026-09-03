#!/usr/bin/env node
/**
 * Geometry regression for the synthetic footprint generator.
 *
 * Fast and dependency-free on purpose: no KiCad, no JVM, no tscircuit build, so
 * this can run on every commit while the full golden board suite stays opt-in.
 * It checks the things that silently ruin a board if they drift — pad COUNT,
 * pad PITCH, and that no two pads on a part overlap — rather than exact
 * coordinates, which would make every dimension tweak a test failure.
 *
 *   node test-footprints.mjs
 */
import { synthFootprint } from './footprints.mjs'

let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) return
  console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`)
  failed += 1
}

/** Pull [{n,x,y,w,h,drill}] out of generated .kicad_mod text. */
function pads(mod) {
  const out = []
  const re = /\(pad\s+"([^"]+)"\s+(smd|thru_hole)\s+\w+\s+\(at\s+(-?[\d.]+)\s+(-?[\d.]+)\)\s+\(size\s+([\d.]+)\s+([\d.]+)\)(?:\s+\(drill\s+([\d.]+)\))?/g
  let m
  while ((m = re.exec(mod))) {
    out.push({ n: m[1], tht: m[2] === 'thru_hole', x: +m[3], y: +m[4], w: +m[5], h: +m[6], drill: m[7] ? +m[7] : 0 })
  }
  return out
}

const nearest = (ps) => {
  let best = Infinity
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      best = Math.min(best, Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y))
    }
  }
  return best
}

const overlaps = (ps) => {
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i]
      const b = ps[j]
      if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 1e-6 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 - 1e-6) return `${a.n}/${b.n}`
    }
  }
  return null
}

// name -> [expected pad count, expected nearest-neighbour pitch (or null to skip)]
const CASES = [
  ['0402', 2, null], ['0603', 2, null], ['1206', 2, null], ['2512', 2, null],
  ['soic8', 8, 1.27], ['soic16', 16, 1.27], ['tssop20', 20, 0.65], ['msop10', 10, 0.65],
  ['ssop28', 28, 0.65], ['dfn8', 8, 0.5], ['son6', 6, 0.5],
  ['sot23', 3, null], ['sot23-5', 5, null], ['sot23-6', 6, null], ['sot223', 4, null],
  ['sod123', 2, null], ['sma', 2, null], ['dpak', 4, null],
  ['tqfp32', 32, 0.8], ['lqfp64', 64, 0.5], ['qfp144', 144, 0.5],
  ['header_1x2', 2, 2.54], ['header_1x8', 8, 2.54], ['header_1x17', 17, 2.54],
  ['header_2x10', 20, 2.54], ['hdr-1x4-p200', 4, 2.0], ['pinheader-2x5-p127', 10, 1.27],
  ['screwterminal-3', 3, 5.08], ['terminal-2-p350', 2, 3.5],
]

console.log(`synthetic footprints — ${CASES.length} families`)
for (const [name, count, pitch] of CASES) {
  const mod = synthFootprint(name)
  if (!mod) {
    check(name, false, 'generator returned null')
    continue
  }
  const ps = pads(mod)
  check(name, ps.length === count, `expected ${count} pads, got ${ps.length}`)
  if (pitch && ps.length > 1) {
    const got = nearest(ps)
    check(name, Math.abs(got - pitch) < 0.02, `pitch ${got.toFixed(3)} != ${pitch}`)
  }
  const ov = overlaps(ps)
  check(name, !ov, `pads overlap (${ov})`)
  // Pin numbering must be dense 1..N — a gap means a net silently lands nowhere.
  const nums = ps.map((p) => +p.n).sort((a, b) => a - b)
  check(name, nums[0] === 1 && nums[nums.length - 1] === ps.length, `pin numbers not 1..${ps.length}`)
  // Through-hole pads must carry a drill smaller than the pad, or KiCad rejects them.
  for (const p of ps.filter((q) => q.tht)) {
    check(name, p.drill > 0 && p.drill < p.w, `bad drill ${p.drill} vs pad ${p.w}`)
  }
}

// Things that must stay unsupported, so a typo fails loudly instead of
// silently producing a wrong-shaped part.
for (const bad of ['nonsense-xyz', 'usb_c_16', 'header_9x9', 'qfp999', 'soic3', '']) {
  check(`reject ${bad || '(empty)'}`, synthFootprint(bad) === null, 'should be unsupported')
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
