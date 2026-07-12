#!/usr/bin/env node
/**
 * tscircuit board runner — the chip-scale electronics executor.
 *
 * Reads {code, svgPath?} JSON on stdin, evaluates the product-engine-emitted
 * tscircuit board code (@tscircuit/eval), autoroutes it in-process, and prints
 * JSON metrics: real board size (mm), routed trace count, per-type error counts.
 * Optionally renders the routed PCB to an SVG. Honest: a board only counts as
 * routed when there are traces AND zero errors — never faked.
 *
 * Usage: node run_board.mjs   < {"code":"...","svgPath":"/abs/board.svg"}
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { runTscircuitCode } from '@tscircuit/eval'

// Real KiCad DRC — the honesty upgrade over tscircuit's own router check. We
// convert the routed board to a real .kicad_pcb and run `kicad-cli pcb drc`
// against realistic fab rules (JLCPCB 4-layer, 0.09mm), so "clean" means it
// passes the same design-rule check a fab runs, not just our own. Gated on
// kicad-cli being installed; absent -> honestly reported unavailable.
const KICAD_CLI = ['/opt/homebrew/bin/kicad-cli', '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli']
  .find((p) => { try { return fs.existsSync(p) } catch { return false } })

// JLCPCB 4-layer standard capability, published: min track/space 0.09mm, min
// drill 0.2mm, min via 0.45mm dia / 0.13mm annular ring. One consistent fab
// profile so every reported violation is measured against the same real fab.
const FAB_RULES = `(version 1)
(rule "min_track_width" (constraint track_width (min 0.09mm)))
(rule "min_clearance" (constraint clearance (min 0.09mm)))
(rule "min_hole" (constraint hole_size (min 0.2mm)))
(rule "min_via_diameter" (constraint via_diameter (min 0.45mm)))
(rule "min_annular_width" (constraint annular_width (min 0.13mm)))`

async function realDrc(cj) {
  if (!KICAD_CLI) return { available: false, reason: 'kicad-cli not installed' }
  let dir
  try {
    const ver = spawnSync(KICAD_CLI, ['version'], { encoding: 'utf8', timeout: 15000 }).stdout?.trim() || '?'
    const { CircuitJsonToKicadPcbConverter } = await import('circuit-json-to-kicad')
    const conv = new CircuitJsonToKicadPcbConverter(cj)
    conv.runUntilFinished()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-drc-'))
    const pcbPath = path.join(dir, 'board.kicad_pcb')
    const drcPath = path.join(dir, 'drc.json')
    fs.writeFileSync(pcbPath, conv.getOutputString())
    fs.writeFileSync(path.join(dir, 'board.kicad_dru'), FAB_RULES)
    const r = spawnSync(KICAD_CLI, ['pcb', 'drc', '--format', 'json', '--output', drcPath, pcbPath], { encoding: 'utf8', timeout: 120000 })
    if (!fs.existsSync(drcPath)) return { available: false, reason: 'drc produced no report', stderr: (r.stderr || '').slice(0, 200) }
    const rep = JSON.parse(fs.readFileSync(drcPath, 'utf8'))
    const all = [...(rep.violations || []), ...(rep.unconnected_items || []), ...(rep.schematic_parity || [])]
    const errs = all.filter((v) => v.severity === 'error')
    const warns = all.filter((v) => v.severity === 'warning')
    const byType = {}
    for (const v of errs) byType[v.type] = (byType[v.type] || 0) + 1
    return {
      available: true,
      kicadVersion: ver,
      ruleProfile: 'JLCPCB 4-layer (0.09mm track/space)',
      errors: errs.length,
      warnings: warns.length,
      errorTypes: byType,
      sample: errs.slice(0, 6).map((v) => `${v.type}: ${(v.description || '').slice(0, 90)}`),
    }
  } catch (e) {
    return { available: false, reason: String(e).slice(0, 160) }
  } finally {
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

// approx footprint sizes [w,h] mm — for deterministic placement
const FP = {
  qfn32: [5, 5], qfn24: [4, 4], qfn20: [4, 4], qfn16: [3, 3], qfn12: [2.5, 2.5],
  qfn8: [2, 2], qfn6: [1.6, 1.6], qfn4: [1.2, 1.2],
  '0603': [1.6, 0.8], '0402': [1.0, 0.5], '0201': [0.6, 0.3],
}
const fpSize = (f) => FP[f] || FP[(String(f).match(/qfn\d+|0\d{3}/) || [])[0]] || [3, 3]

/** Parse a real KiCad .kicad_mod (from easyeda2kicad / LCSC) into a tscircuit
 *  <footprint> with the REAL pad geometry, plus its bounding-box size (mm) for
 *  placement. Returns null if it has no usable SMD pads. */
function kicadModToFootprint(mod) {
  const re = /\(pad\s+(\S+)\s+smd\s+\w+\s+\(at\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+-?[\d.]+)?\)\s+\(size\s+([\d.]+)\s+([\d.]+)\)/g
  const pads = []
  let m
  while ((m = re.exec(mod))) pads.push({ n: m[1], x: +m[2], y: -+m[3], w: +m[4], h: +m[5] })
  if (!pads.length) return null
  const ext = (sel, half) => pads.map((p) => sel(p) + half(p))
  const maxX = Math.max(...ext((p) => p.x, (p) => p.w / 2))
  const minX = Math.min(...pads.map((p) => p.x - p.w / 2))
  const maxY = Math.max(...ext((p) => p.y, (p) => p.h / 2))
  const minY = Math.min(...pads.map((p) => p.y - p.h / 2))
  const jsx = '<footprint>' + pads.map((p) =>
    `<smtpad portHints={["${p.n}","pin${p.n}"]} pcbX="${p.x.toFixed(3)}mm" pcbY="${p.y.toFixed(3)}mm" width="${p.w}mm" height="${p.h}mm" shape="rect" />`).join('') + '</footprint>'
  return { jsx, w: +(maxX - minX).toFixed(2), h: +(maxY - minY).toFixed(2) }
}

/** Deterministic double-sided shelf-pack: alternate top/bottom so adjacent parts
 *  never share a layer, guaranteeing no same-layer courtyard overlap. Returns
 *  placed parts with pcbX/pcbY/layer. Tight but leaves routing channels. */
// real footprint size (from LCSC) when present, else the generic table
const partSize = (p) => (p._fp ? [p._fp.w, p._fp.h] : fpSize(p.footprint))

function place(parts, maxW = 15, gap = 2.1) {
  const sorted = [...parts].sort((a, b) => {
    const [aw, ah] = partSize(a), [bw, bh] = partSize(b)
    return bw * bh - aw * ah
  })
  let x = 0, y = 0, rowH = 0, i = 0
  const placed = []
  for (const p of sorted) {
    const [w, h] = partSize(p)
    if (x > 0 && x + w > maxW) { x = 0; y += rowH + gap; rowH = 0 }
    placed.push({ ...p, pcbX: +(x + w / 2).toFixed(2), pcbY: +(-(y + h / 2)).toFixed(2), layer: i % 2 ? 'bottom' : 'top' })
    i++; x += w + gap; rowH = Math.max(rowH, h)
  }
  return placed
}

/** parts + nets -> tscircuit code (positions computed here, not by the LLM). */
function buildCode(parts, nets) {
  // resolve real LCSC footprints (from part.kicadMod) before placement/sizing
  for (const p of parts) p._fp = p.kicadMod ? kicadModToFootprint(p.kicadMod) : null
  const placed = place(parts)
  const comps = placed.map((p) => {
    const kind = p.kind === 'resistor' ? 'resistor' : p.kind === 'capacitor' ? 'capacitor' : 'chip'
    const val = kind === 'resistor' ? ' resistance="10k"' : kind === 'capacitor' ? ' capacitance="100nF"' : ''
    const fp = p._fp ? `{${p._fp.jsx}}` : `"${p.footprint}"`
    return `    <${kind} name="${p.name}" footprint=${fp}${val} pcbX={${p.pcbX}} pcbY={${p.pcbY}} layer="${p.layer}" />`
  })
  const pin = (ref) => { const [c, ...r] = String(ref).split('.'); return `.${c} > .pin${r.join('') || '1'}` }
  const traces = (nets || []).map((n) => `    <trace from="${pin(n[0])}" to="${pin(n[1])}" />`)
  return `export default () => (\n  <board autorouter="auto">\n${comps.join('\n')}\n${traces.join('\n')}\n  </board>\n)`
}

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'))
  const code = input.code || (input.parts ? buildCode(input.parts, input.nets) : '')
  const cj = await runTscircuitCode(code)

  const board = cj.find((e) => e.type === 'pcb_board')
  const traces = cj.filter((e) => e.type === 'pcb_trace')
  const comps = cj.filter((e) => e.type === 'pcb_component')
  const errors = {}
  for (const e of cj) if (/error/.test(e.type)) errors[e.type] = (errors[e.type] || 0) + 1

  let svg = false
  if (input.svgPath && board) {
    try {
      const { convertCircuitJsonToPcbSvg } = await import('circuit-to-svg')
      fs.writeFileSync(input.svgPath, convertCircuitJsonToPcbSvg(cj))
      svg = true
    } catch { /* svg optional */ }
  }

  const errorCount = Object.values(errors).reduce((a, b) => a + b, 0)
  // real KiCad DRC on the actual routed board (unless explicitly skipped)
  const drc = input.drc === false || !board ? { available: false, reason: 'skipped' } : await realDrc(cj)
  process.stdout.write(JSON.stringify({
    ok: !!board && traces.length > 0 && errorCount === 0,
    boardMm: board ? { w: Math.round(board.width * 10) / 10, h: Math.round(board.height * 10) / 10 } : null,
    areaMm2: board ? Math.round(board.width * board.height) : null,
    components: comps.length,
    routedTraces: traces.length,
    errors,
    drc,
    svg,
    code,
  }))
}

main().catch((e) => { process.stdout.write(JSON.stringify({ ok: false, error: String(e).slice(0, 300) })); process.exit(1) })
