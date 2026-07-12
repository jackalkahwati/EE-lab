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
import { runTscircuitCode } from '@tscircuit/eval'

// approx footprint sizes [w,h] mm — for deterministic placement
const FP = {
  qfn32: [5, 5], qfn24: [4, 4], qfn20: [4, 4], qfn16: [3, 3], qfn12: [2.5, 2.5],
  qfn8: [2, 2], qfn6: [1.6, 1.6], qfn4: [1.2, 1.2],
  '0603': [1.6, 0.8], '0402': [1.0, 0.5], '0201': [0.6, 0.3],
}
const fpSize = (f) => FP[f] || FP[(String(f).match(/qfn\d+|0\d{3}/) || [])[0]] || [3, 3]

/** Deterministic double-sided shelf-pack: alternate top/bottom so adjacent parts
 *  never share a layer, guaranteeing no same-layer courtyard overlap. Returns
 *  placed parts with pcbX/pcbY/layer. Tight but leaves routing channels. */
function place(parts, maxW = 15, gap = 2.1) {
  const sorted = [...parts].sort((a, b) => {
    const [aw, ah] = fpSize(a.footprint), [bw, bh] = fpSize(b.footprint)
    return bw * bh - aw * ah
  })
  let x = 0, y = 0, rowH = 0, i = 0
  const placed = []
  for (const p of sorted) {
    const [w, h] = fpSize(p.footprint)
    if (x > 0 && x + w > maxW) { x = 0; y += rowH + gap; rowH = 0 }
    placed.push({ ...p, pcbX: +(x + w / 2).toFixed(2), pcbY: +(-(y + h / 2)).toFixed(2), layer: i % 2 ? 'bottom' : 'top' })
    i++; x += w + gap; rowH = Math.max(rowH, h)
  }
  return placed
}

/** parts + nets -> tscircuit code (positions computed here, not by the LLM). */
function buildCode(parts, nets) {
  const placed = place(parts)
  const comps = placed.map((p) => {
    const kind = p.kind === 'resistor' ? 'resistor' : p.kind === 'capacitor' ? 'capacitor' : 'chip'
    const val = kind === 'resistor' ? ' resistance="10k"' : kind === 'capacitor' ? ' capacitance="100nF"' : ''
    return `    <${kind} name="${p.name}" footprint="${p.footprint}"${val} pcbX={${p.pcbX}} pcbY={${p.pcbY}} layer="${p.layer}" />`
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
  process.stdout.write(JSON.stringify({
    ok: !!board && traces.length > 0 && errorCount === 0,
    boardMm: board ? { w: Math.round(board.width * 10) / 10, h: Math.round(board.height * 10) / 10 } : null,
    areaMm2: board ? Math.round(board.width * board.height) : null,
    components: comps.length,
    routedTraces: traces.length,
    errors,
    svg,
    code,
  }))
}

main().catch((e) => { process.stdout.write(JSON.stringify({ ok: false, error: String(e).slice(0, 300) })); process.exit(1) })
