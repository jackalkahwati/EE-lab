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
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runTscircuitCode } from '@tscircuit/eval'

// Resolve sibling tools relative to THIS script, not the cwd — the Next server
// spawns this runner with its own (app) working directory, so a cwd-relative
// path finds nothing and silently drops freerouting.
const HERE = path.dirname(fileURLToPath(import.meta.url))

// Real KiCad DRC — the honesty upgrade over tscircuit's own router check. We
// convert the routed board to a real .kicad_pcb and run `kicad-cli pcb drc`
// against realistic fab rules (JLCPCB 4-layer, 0.09mm), so "clean" means it
// passes the same design-rule check a fab runs, not just our own. Gated on
// kicad-cli being installed; absent -> honestly reported unavailable.
const KICAD_CLI = ['/opt/homebrew/bin/kicad-cli', '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli']
  .find((p) => { try { return fs.existsSync(p) } catch { return false } })

// freerouting — a real push-and-shove autorouter (Java). It routes far cleaner
// than tscircuit's built-in router (fewer vias, passes fab DRC), so the loop
// prefers it. Gated on Java + the jar existing; absent -> loop falls back to
// the built-in router + geometry repair.
const JAVA = ['/opt/homebrew/opt/openjdk/bin/java', '/usr/bin/java', '/usr/local/bin/java']
  .find((p) => { try { return fs.existsSync(p) } catch { return false } }) || (process.env.JAVA_HOME ? `${process.env.JAVA_HOME}/bin/java` : null)
const FR_JAR = (() => {
  const p = path.join(HERE, '..', 'freerouting', 'freerouting-2.2.4.jar')
  try { return fs.existsSync(p) ? p : null } catch { return null }
})()

// KiCad's own python (ships with the app) + the ground-plane pass. pcbnew carries
// a real net model, so it can assign nets and lay a DRC-verified ground plane the
// net-less circuit-json-to-kicad export can't.
const KICAD_PY = ['/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3', '/usr/bin/python3']
  .find((p) => { try { return fs.existsSync(p) } catch { return false } })
const GROUND_PLANE_PY = (() => {
  const p = path.join(HERE, '..', 'kicad', 'ground_plane.py')
  try { return fs.existsSync(p) ? p : null } catch { return null }
})()
const ADD_MODELS_PY = (() => {
  const p = path.join(HERE, '..', 'kicad', 'add_models.py')
  try { return fs.existsSync(p) ? p : null } catch { return null }
})()

/** Attach stock KiCad 3D models to the board's footprints (pcbnew) so it renders
 *  as a populated PCBA, not a bare PCB. Returns the model-augmented .kicad_pcb
 *  string, or the original if the pass is unavailable/fails. */
function attachModels(pcbString, parts) {
  if (!KICAD_PY || !ADD_MODELS_PY || !Array.isArray(parts) || !parts.length) return pcbString
  let dir
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-mdl-'))
    const inPcb = path.join(dir, 'b.kicad_pcb'), outPcb = path.join(dir, 'm.kicad_pcb'), pj = path.join(dir, 'parts.json')
    fs.writeFileSync(inPcb, pcbString)
    fs.writeFileSync(pj, JSON.stringify(parts.map((p) => ({ name: p.name, footprint: p.footprint, kind: p.kind }))))
    spawnSync(KICAD_PY, [ADD_MODELS_PY, inPcb, outPcb, pj], { encoding: 'utf8', timeout: 60000 })
    return fs.existsSync(outPcb) ? fs.readFileSync(outPcb, 'utf8') : pcbString
  } catch { return pcbString } finally {
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** Add a real ground plane to the routed board (via pcbnew) and DRC-verify it:
 *  assign the GND net to every ground pin, fill a bonded GND zone, then run real
 *  KiCad DRC on the grounded board. Returns { assigned, unconnected, errors } —
 *  unconnected = ground pins the plane didn't reach (0 = every ground pin on the
 *  plane), reported honestly. Null if pcbnew/gnd pins are unavailable. */
async function applyGroundPlane(cj, gndPins, profileKey = 'standard') {
  if (!KICAD_CLI || !KICAD_PY || !GROUND_PLANE_PY || !gndPins?.length) return null
  let dir
  try {
    const { CircuitJsonToKicadPcbConverter } = await import('circuit-json-to-kicad')
    const conv = new CircuitJsonToKicadPcbConverter(cj); conv.runUntilFinished()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-gp-'))
    const inPcb = path.join(dir, 'b.kicad_pcb'), outPcb = path.join(dir, 'g.kicad_pcb')
    const gndJson = path.join(dir, 'gnd.json'), drcJson = path.join(dir, 'g.json')
    fs.writeFileSync(inPcb, conv.getOutputString())
    fs.writeFileSync(gndJson, JSON.stringify(gndPins))
    const hc = String((FAB_PROFILES[profileKey] || FAB_PROFILES.standard).holeClearance ?? 0.5)
    const r = spawnSync(KICAD_PY, [GROUND_PLANE_PY, inPcb, outPcb, gndJson, hc], { encoding: 'utf8', timeout: 120000 })
    if (!fs.existsSync(outPcb)) return { available: false, reason: 'ground plane pass produced no board', stderr: (r.stderr || '').slice(0, 200) }
    let gp = {}; try { gp = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}') } catch { /* keep defaults */ }
    fs.writeFileSync(path.join(dir, 'g.kicad_dru'), (FAB_PROFILES[profileKey] || FAB_PROFILES.standard).rules)
    spawnSync(KICAD_CLI, ['pcb', 'drc', '--format', 'json', '--output', drcJson, outPcb], { encoding: 'utf8', timeout: 120000 })
    let errors = null
    if (fs.existsSync(drcJson)) { const rep = JSON.parse(fs.readFileSync(drcJson, 'utf8')); errors = (rep.violations || []).filter((v) => v.severity === 'error').length }
    // return the grounded .kicad_pcb too (read before the temp dir is cleaned) so
    // the caller can persist it for the 3D render — the real chip-down board.
    const pcb = fs.readFileSync(outPcb, 'utf8')
    return { available: true, assigned: gp.assigned ?? 0, unconnected: gp.unconnected ?? null, stitched: gp.stitched ?? 0, skipped: gp.skipped ?? 0, errors, pcb }
  } catch (e) {
    return { available: false, reason: String(e).slice(0, 160) }
  } finally {
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** Route a placed board with freerouting: strip any existing routing, export a
 *  Specctra DSN, run the autorouter, merge the routed session back to circuit
 *  JSON. Returns { cj, unrouted } (unrouted = nets it couldn't complete, an
 *  honest incompleteness signal), or null if freerouting is unavailable/failed
 *  so the caller can fall back to the built-in router. */
/** Rewrite a 2-layer DSN as a 4-layer board with through-vias spanning all
 *  layers. A chip-scale board is genuinely 4-layer HDI, and the inner copper
 *  gives the router the room to complete dense nets a 2-layer board leaves
 *  stranded (congestion, not geometry). */
function dsnTo4Layer(d) {
  const f = d.structure.layers.find((l) => l.name === 'F.Cu')
  const b = d.structure.layers.find((l) => l.name === 'B.Cu')
  if (!f || !b) return d
  f.property = { index: 0 }; b.property = { index: 3 }
  d.structure.layers = [f, { name: 'In1.Cu', type: 'signal', property: { index: 1 } }, { name: 'In2.Cu', type: 'signal', property: { index: 2 } }, b]
  for (const ps of (d.library?.padstacks || [])) {
    if (/via/i.test(ps.name)) {
      const dia = ps.shapes?.[0]?.diameter || 600
      ps.shapes = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'].map((layer) => ({ shapeType: 'circle', layer, diameter: dia }))
    }
  }
  return d
}

/** Force freerouting to space vias so their drilled holes clear JLCPCB's 0.5mm
 *  hole_clearance. Without this the router packs vias at the general clearance
 *  (0.15mm), leaving via holes only ~0.4mm apart — a residual hole_clearance DRC
 *  error we could only enlarge-and-hope-in post. A typed via_via / via_pin
 *  clearance in the DSN structure rule makes the router keep via COPPER >= this
 *  far apart, so with a 0.6mm via pad the holes end up ~0.55mm apart and pass by
 *  construction. value is in DSN units (this converter emits um: 1 unit = 1um).
 *  freerouting reads these Specctra typed clearances natively — config, not a
 *  new router. */
function setViaClearance(dsnPcb, um) {
  const rule = dsnPcb.structure && dsnPcb.structure.rule
  if (!rule) return
  const cl = (rule.clearances = rule.clearances || [])
  // via_via / via_pin: hole-to-hole spacing. via_smd: push vias off SMD pad
  // copper so the drilled hole clears the fab's hole-to-copper rule (a via
  // dropped beside a 0.5mm-pitch QFN pin otherwise trips hole_clearance to the
  // neighbour's copper — the dominant residual on dense boards).
  const set = (type, val) => { const ex = cl.find((c) => c.type === type); if (ex) ex.value = val; else cl.push({ value: val, type }) }
  set('via_via', um)
  set('via_pin', um)
  set('via_smd', Math.round(um * 1.4))
}

async function freeroute(cj, { layers = 2 } = {}) {
  if (!JAVA || !FR_JAR) return null
  let dir
  try {
    const { convertCircuitJsonToDsnJson, stringifyDsnJson, parseDsnToDsnJson, convertDsnSessionToCircuitJson } = await import('dsn-converter')
    const unrouted = cj.filter((e) => e.type !== 'pcb_trace' && e.type !== 'pcb_via')
    let dsnPcb = convertCircuitJsonToDsnJson(unrouted)
    if (layers === 4) dsnPcb = dsnTo4Layer(dsnPcb)
    // 0.25mm via_via clearance -> 0.6mm via pads stay >=0.85mm center-to-center,
    // so 0.3mm holes clear the 0.5mm hole_clearance with margin (was the residual
    // fab-DRC error on dense boards). freerouting honours this from the DSN.
    setViaClearance(dsnPcb, 250)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-fr-'))
    const dsnPath = path.join(dir, 'b.dsn'), sesPath = path.join(dir, 'b.ses')
    fs.writeFileSync(dsnPath, stringifyDsnJson(dsnPcb))
    // -Djava.awt.headless=true: run with NO GUI window (freerouting otherwise
    //   pops its editor app on -de/-do) — pure backend subprocess.
    // Network timeouts: its startup "check for updates" call otherwise stalls
    //   ~2min on the socket; routing itself is sub-second.
    // Together these take a run from ~120s (+ a GUI window) to ~3s, headless.
    const r = spawnSync(JAVA, [
      '-Djava.awt.headless=true',
      '-Dsun.net.client.defaultConnectTimeout=1500',
      '-Dsun.net.client.defaultReadTimeout=1500',
      '-jar', FR_JAR, '-de', dsnPath, '-do', sesPath, '-mp', '10',
    ], { encoding: 'utf8', timeout: 45000 })
    if (!fs.existsSync(sesPath)) return null
    const m = [...(r.stdout || '').matchAll(/\((\d+) unrouted\)/g)]
    const unroutedN = m.length ? Number(m[m.length - 1][1]) : 0
    const session = parseDsnToDsnJson(fs.readFileSync(sesPath, 'utf8'))
    const routed = convertDsnSessionToCircuitJson(dsnPcb, session, unrouted)
    // Take ONLY the routed copper (traces + vias) from the session and graft it
    // onto the ORIGINAL placed board. The session's own pcb_smtpad records carry
    // no pcb_component container, so grafting them (as an earlier version did)
    // left circuit-json-to-kicad with hollow footprints — orphaned pads, lost
    // references — which broke DRC's pad checks and the ground-plane match. The
    // original `unrouted` cj has fully-linked footprints (pcb_component + pads +
    // source refs); routing never moves pads, and the session traces share the
    // DSN coordinate space, so they land on the original pads exactly.
    const routedWires = routed.filter((e) => e.type === 'pcb_trace' || e.type === 'pcb_via')
    return { cj: [...unrouted, ...routedWires], unrouted: unroutedN, layers }
  } catch { return null } finally {
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

// Two REAL fab processes the redesign loop can target, from published JLCPCB
// capabilities. Standard (cheapest) vs HDI/advanced (finer, pricier). A
// chip-scale earbud board is genuinely an HDI board, so converging under the
// HDI profile is a real, buildable answer — not a cop-out.
const FAB_PROFILES = {
  standard: {
    label: 'JLCPCB standard (0.09mm track/space, 0.45mm via)',
    via: { pad: 0.5, hole: 0.2 },
    holeClearance: 0.5,
    rules: `(version 1)
(rule "t" (constraint track_width (min 0.09mm)))
(rule "c" (constraint clearance (min 0.09mm)))
(rule "h" (constraint hole_size (min 0.2mm)))
(rule "v" (constraint via_diameter (min 0.45mm)))
(rule "a" (constraint annular_width (min 0.13mm)))
(rule "hc" (constraint hole_clearance (min 0.5mm)))`,
  },
  hdi: {
    label: 'JLCPCB HDI/advanced (0.0635mm track/space, 0.3mm via)',
    via: { pad: 0.4, hole: 0.2 },
    holeClearance: 0.4,
    rules: `(version 1)
(rule "t" (constraint track_width (min 0.0635mm)))
(rule "c" (constraint clearance (min 0.0635mm)))
(rule "h" (constraint hole_size (min 0.15mm)))
(rule "v" (constraint via_diameter (min 0.3mm)))
(rule "a" (constraint annular_width (min 0.075mm)))
(rule "hc" (constraint hole_clearance (min 0.4mm)))`,
  },
}

async function realDrc(cj, profileKey = 'standard') {
  if (!KICAD_CLI) return { available: false, reason: 'kicad-cli not installed' }
  const profile = FAB_PROFILES[profileKey] || FAB_PROFILES.standard
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
    fs.writeFileSync(path.join(dir, 'board.kicad_dru'), profile.rules)
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
      ruleProfile: profile.label,
      profileKey,
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
  qfn48: [7, 7], qfn32: [5, 5], qfn24: [4, 4], qfn20: [4, 4], qfn16: [3, 3], qfn12: [2.5, 2.5],
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

/** Order parts so connected ones are adjacent in the pack (BFS from the highest-
 *  degree node — usually the SoC hub). This keeps net lengths short so the
 *  autorouter can actually complete every connection; a size-only sort scatters
 *  wired parts and strands nets. Falls back to size order for unconnected parts
 *  and when there are no nets. */
function connectivityOrder(parts, nets) {
  if (!nets?.length) return [...parts].sort((a, b) => { const [aw, ah] = partSize(a), [bw, bh] = partSize(b); return bw * bh - aw * ah })
  const deg = {}, adj = {}
  for (const n of nets) {
    const ca = String(n[0]).split('.')[0], cb = String(n[1]).split('.')[0]
    deg[ca] = (deg[ca] || 0) + 1; deg[cb] = (deg[cb] || 0) + 1
    ;(adj[ca] = adj[ca] || []).push(cb); (adj[cb] = adj[cb] || []).push(ca)
  }
  const start = Object.entries(deg).sort((a, b) => b[1] - a[1])[0]?.[0]
  const seen = new Set(), order = [], q = start ? [start] : []
  while (q.length) { const n = q.shift(); if (seen.has(n)) continue; seen.add(n); order.push(n); for (const m of (adj[n] || [])) if (!seen.has(m)) q.push(m) }
  const byName = new Map(parts.map((p) => [p.name, p]))
  const result = order.map((n) => byName.get(n)).filter(Boolean)
  for (const p of parts) if (!seen.has(p.name)) result.push(p) // unconnected parts last
  return result
}

function place(parts, maxW = 15, gap = 2.1, singleSided = false, nets = null) {
  const sorted = connectivityOrder(parts, nets)
  let x = 0, y = 0, rowH = 0, i = 0
  const placed = []
  for (const p of sorted) {
    const [w, h] = partSize(p)
    if (x > 0 && x + w > maxW) { x = 0; y += rowH + gap; rowH = 0 }
    // single-sided (all top) keeps the router's layers clean so dense nets
    // complete; the shelf-pack spacing already prevents courtyard overlap, so
    // we no longer need the alternating-layer trick for that.
    placed.push({ ...p, pcbX: +(x + w / 2).toFixed(2), pcbY: +(-(y + h / 2)).toFixed(2), layer: singleSided ? 'top' : (i % 2 ? 'bottom' : 'top') })
    i++; x += w + gap; rowH = Math.max(rowH, h)
  }
  return placed
}

/** placed parts (with pcbX/pcbY/layer/pcbRotation/_fp) + nets -> tscircuit code.
 *  NOTE: circuit-json-to-kicad silently DROPS <capacitor> elements (chips and
 *  resistors render, capacitors don't), which would leave cap pads out of the
 *  KiCad board that DRC checks. So emit capacitors as <chip> — same 2-pad
 *  geometry/footprint, but it actually lands in the board so DRC/nets/planes
 *  see it. (The cap's electrical role lives in the netlist/BOM, not here.) */
function emitBoardCode(placed, nets, { clearance = null } = {}) {
  const comps = placed.map((p) => {
    const kind = p.kind === 'resistor' ? 'resistor' : 'chip'
    const val = kind === 'resistor' ? ' resistance="10k"' : ''
    const fp = p._fp ? `{${p._fp.jsx}}` : `"${p.footprint}"`
    const rot = p.pcbRotation ? ` pcbRotation={${p.pcbRotation}}` : ''
    return `    <${kind} name="${p.name}" footprint=${fp}${val} pcbX={${p.pcbX}} pcbY={${p.pcbY}}${rot} layer="${p.layer}" />`
  })
  const pin = (ref) => { const [c, ...r] = String(ref).split('.'); return `.${c} > .pin${r.join('') || '1'}` }
  const traces = (nets || []).map((n) => `    <trace from="${pin(n[0])}" to="${pin(n[1])}" />`)
  // The built-in router otherwise packs vias right against nearby traces/pads,
  // tripping the fab's hole-to-copper rule (its holes end up 0.17-0.28mm from
  // copper, under the 0.4-0.5mm min). tscircuit's board takes RoutingTolerances;
  // a via's hole sits inside its pad, so widening the edge clearances the router
  // keeps pushes the holes out far enough to clear the rule by construction.
  const tol = clearance
    ? ` minViaHoleEdgeToViaHoleEdgeClearance="${clearance}mm" minPlatedHoleDrillEdgeToDrillEdgeClearance="${clearance}mm" minViaEdgeToPadEdgeClearance="${clearance}mm" minTraceToPadEdgeClearance="${clearance}mm"`
    : ''
  return `export default () => (\n  <board autorouter="auto"${tol}>\n${comps.join('\n')}\n${traces.join('\n')}\n  </board>\n)`
}

/** parts + nets -> tscircuit code (positions computed here, not by the LLM). */
function buildCode(parts, nets, { maxW = 15, gap = 2.1, singleSided = false, clearance = null } = {}) {
  // resolve real LCSC footprints (from part.kicadMod) before placement/sizing
  for (const p of parts) p._fp = p.kicadMod ? kicadModToFootprint(p.kicadMod) : null
  return emitBoardCode(place(parts, maxW, gap, singleSided, nets), nets, { clearance })
}

/** Read each part's pin -> [dx,dy] offset (pad position relative to its
 *  component center) from a routed circuit-json, so placement can optimize real
 *  pin-to-pin distances rather than component centers. */
function extractPinOffsets(cj) {
  const offsets = {}
  for (const c of cj.filter((e) => e.type === 'pcb_component')) {
    const src = cj.find((e) => e.type === 'source_component' && e.source_component_id === c.source_component_id)
    if (!src?.name || !c.center) continue
    offsets[src.name] = {}
    for (const pad of cj.filter((e) => e.type === 'pcb_smtpad' && e.pcb_component_id === c.pcb_component_id)) {
      const port = cj.find((e) => e.type === 'pcb_port' && e.pcb_port_id === pad.pcb_port_id)
      const sp = port && cj.find((e) => e.type === 'source_port' && e.source_port_id === port.source_port_id)
      const num = sp?.port_hints?.find((h) => /^\d+$/.test(h))
      if (num != null && pad.x != null) offsets[src.name][num] = [pad.x - c.center.x, pad.y - c.center.y]
    }
  }
  return offsets
}

/** Read each part's true courtyard extent (w,h) from a rendered board, keyed by
 *  component name. The courtyard is the fab keep-out KiCad's courtyards_overlap
 *  check enforces — larger than the part body — so placement must separate parts
 *  by this, not by the body box. Sizes are at rotation 0; callers swap w/h for
 *  90/270. */
function extractCourtyardSizes(cj) {
  const nameOf = {}
  for (const e of cj) {
    if (e.type !== 'pcb_component') continue
    const sc = cj.find((x) => x.type === 'source_component' && x.source_component_id === e.source_component_id)
    if (sc?.name) nameOf[e.pcb_component_id] = sc.name
  }
  const out = {}
  for (const e of cj) {
    let w, h
    if (e.type === 'pcb_courtyard_outline' && e.outline?.length) {
      const xs = e.outline.map((p) => p.x), ys = e.outline.map((p) => p.y)
      w = Math.max(...xs) - Math.min(...xs); h = Math.max(...ys) - Math.min(...ys)
    } else if (e.type === 'pcb_courtyard_rect') { w = e.width; h = e.height } else continue
    const nm = nameOf[e.pcb_component_id]
    if (nm && w > 0 && h > 0) out[nm] = [w, h]
  }
  return out
}

/**
 * Net-aware placement: minimize pin-to-pin wirelength (so connected pins sit
 * close, with parts rotated to face each other) while keeping ~1mm routing
 * channels between courtyards, via simulated annealing over positions +
 * rotations. Connected pins ending up adjacent is what lets the autorouter
 * complete every net; a connectivity shelf-pack keeps parts near but doesn't
 * orient their pins. Returns the winning PLACEMENT (placed parts), so any router
 * can re-emit it with its own board props, or null if pin offsets can't be read
 * (falls back to shelf-pack). Deterministic (seeded) so a re-run is stable.
 */
async function netAwarePlace(parts, nets, { maxW = 15, gap = 2.1 } = {}) {
  if (!nets?.length) return null
  for (const p of parts) p._fp = p.kicadMod ? kicadModToFootprint(p.kicadMod) : null
  const initPlaced = place(parts, maxW, gap, true, nets)
  let cj0
  try { cj0 = await runTscircuitCode(emitBoardCode(initPlaced, nets)) } catch { return null }
  const offsets = extractPinOffsets(cj0)
  if (Object.keys(offsets).length < parts.length) return null
  // True courtyard extent per part (what KiCad's courtyards_overlap check sees) —
  // read from the rendered board, since a footprint's courtyard is larger than
  // its part body. Legalization and the SA spacing term both use this so parts
  // are separated by their real keep-out, not an undersized body box.
  const courtyard = extractCourtyardSizes(cj0)

  const rot = (o, deg) => { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [o[0] * c - o[1] * s, o[0] * s + o[1] * c] }
  const size = (st) => { const [w, h] = courtyard[st.name] || partSize(st); return (st.rot % 180) ? [h, w] : [w, h] }
  const aabb = (st) => { const [w, h] = size(st); return [st.x - w / 2, st.y - h / 2, st.x + w / 2, st.y + h / 2] }
  const gapBetween = (a, b) => Math.max(Math.max(a[0] - b[2], b[0] - a[2]), Math.max(a[1] - b[3], b[1] - a[3]))
  const pinPos = (st, pinNum) => { const o = offsets[st.name]?.[pinNum] || [0, 0]; const ro = rot(o, st.rot); return [st.x + ro[0], st.y + ro[1]] }
  const TARGET = 1.0
  // Courtyard legalization: SA's spacing term is only a SOFT penalty, so when a
  // net's wirelength pull beats it the annealer settles two parts into overlap —
  // which downstream becomes overlapping pads, shorts, and mask bridges. This
  // pass GUARANTEES a fab-legal result: iteratively push any pair whose AABBs are
  // closer than MIN_CLEAR apart along their least-penetration axis until every
  // courtyard clears. It's the "legalization" stage a real placer (e.g. OpenROAD
  // SA-PCB) runs after global placement; here it's a few hundred deterministic
  // relaxation sweeps. The board may grow — honest — but courtyards never overlap.
  const MIN_CLEAR = 0.5
  const legalize = (statesIn) => {
    const states = statesIn.map((p) => ({ ...p }))
    for (let iter = 0; iter < 400; iter++) {
      let moved = false
      for (let i = 0; i < states.length; i++) {
        for (let j = i + 1; j < states.length; j++) {
          const [wi, hi] = size(states[i]), [wj, hj] = size(states[j])
          const dx = states[j].x - states[i].x, dy = states[j].y - states[i].y
          const ox = (wi + wj) / 2 + MIN_CLEAR - Math.abs(dx)
          const oy = (hi + hj) / 2 + MIN_CLEAR - Math.abs(dy)
          if (ox > 0 && oy > 0) { // courtyards overlap or sit inside the clearance
            moved = true
            if (ox <= oy) { const push = ox / 2 + 1e-3, s = dx >= 0 ? 1 : -1; states[i].x -= s * push; states[j].x += s * push }
            else { const push = oy / 2 + 1e-3, s = dy >= 0 ? 1 : -1; states[i].y -= s * push; states[j].y += s * push }
          }
        }
      }
      if (!moved) break
    }
    return states
  }
  // Compaction: legalize only ever PUSHES overlapping parts apart, so for a dense
  // board it leaves a sprawl (a 13-part board spread to ~55mm). Pull every part
  // back toward the centroid in small steps, reverting any move that would break
  // the MIN_CLEAR courtyard gap. Shrink-wraps the legal placement back to compact
  // (~25mm) without reintroducing overlaps.
  const compact = (statesIn) => {
    const states = statesIn.map((p) => ({ ...p }))
    if (states.length < 3) return states
    // Leave MORE routing channel on net-dense boards: the router needs room for
    // traces + vias, and a too-tight board trips hole_clearance (62mm→drc20 vs
    // 27mm→drc45 showed space buys clean routing). Scale the target gap with net
    // count — sparse boards stay tight, dense boards get up to +1.2mm of channel.
    const routeClear = MIN_CLEAR + Math.min(1.2, Math.max(0, ((nets?.length || 0) - 13) * 0.2))
    const cx = states.reduce((a, p) => a + p.x, 0) / states.length
    const cy = states.reduce((a, p) => a + p.y, 0) / states.length
    const clashes = (s) => states.some((o) => o !== s && gapBetween(aabb(s), aabb(o)) < routeClear)
    for (let iter = 0; iter < 120; iter++) {
      let moved = false
      for (const s of states) {
        const ox = s.x, oy = s.y
        s.x += (cx - s.x) * 0.12; s.y += (cy - s.y) * 0.12
        if (clashes(s)) { s.x = ox; s.y = oy } else if (Math.abs(s.x - ox) + Math.abs(s.y - oy) > 0.02) moved = true
      }
      if (!moved) break
    }
    return states
  }
  const byName = (states, n) => states.find((s) => s.name === n)
  const cost = (states) => {
    let wl = 0
    for (const [a, b] of nets) { const [ca, pa] = String(a).split('.'), [cb, pb] = String(b).split('.'); const A = byName(states, ca), B = byName(states, cb); if (!A || !B) continue; const pA = pinPos(A, pa || '1'), pB = pinPos(B, pb || '1'); wl += Math.hypot(pA[0] - pB[0], pA[1] - pB[1]) }
    let sp = 0
    for (let i = 0; i < states.length; i++) for (let j = i + 1; j < states.length; j++) { const g = gapBetween(aabb(states[i]), aabb(states[j])); if (g < TARGET) sp += (TARGET - g) ** 2 }
    return wl + sp * 20
  }
  // One SA run from a given seed (positions + rotations); returns placed parts.
  const saOptimize = (seedInit) => {
    let seed = seedInit
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    let cur = initPlaced.map((p) => ({ ...p, x: p.pcbX, y: p.pcbY, rot: 0 }))
    let curCost = cost(cur), best = cur.map((p) => ({ ...p })), bestCost = curCost
    const STEPS = 6000
    for (let step = 0; step < STEPS; step++) {
      const T = 8 * (1 - step / STEPS) + 0.05
      const cand = cur.map((p) => ({ ...p }))
      const i = Math.floor(rnd() * cand.length)
      if (rnd() < 0.3) cand[i].rot = [0, 90, 180, 270][Math.floor(rnd() * 4)]
      else { cand[i].x += (rnd() - 0.5) * T; cand[i].y += (rnd() - 0.5) * T }
      const cc = cost(cand)
      if (cc < curCost || rnd() < Math.exp((curCost - cc) / (T * 0.3))) { cur = cand; curCost = cc; if (cc < bestCost) { best = cand.map((p) => ({ ...p })); bestCost = cc } }
    }
    best = compact(legalize(best)) // resolve overlaps, then shrink-wrap back to compact
    // Score the FINAL (legalized) placement so seeds are ranked on what actually
    // gets routed — legalization can move parts and shift the real wirelength.
    const finalCost = cost(best)
    const minX = Math.min(...best.map((p) => aabb(p)[0])), minY = Math.min(...best.map((p) => aabb(p)[1]))
    const placed = best.map((p) => ({ ...p, pcbX: +(p.x - minX).toFixed(2), pcbY: +(p.y - minY).toFixed(2), pcbRotation: p.rot || 0, layer: 'top' }))
    return { placed, cost: finalCost }
  }

  // SA is stochastic, so run it for several seeds and keep the lowest-cost
  // (wirelength + spacing) placement. We DELIBERATELY do NOT freeroute candidates
  // here to rank them: SA cost is a strong routability proxy, and the redesign
  // ladder freeroutes the chosen placement anyway — confirming here just repeated
  // 1-2 ~15-120s JVM passes the ladder then redid, which is what pushed real
  // boards past the timeout. Rank cheaply in-process; let the ladder do the one
  // real routing pass.
  const SEEDS = [0x2545f491, 101, 5551, 31337, 8]
  const candidates = SEEDS.map((s) => saOptimize(s)).sort((a, b) => a.cost - b.cost)
  return candidates[0]?.placed ?? null
}

/** DRC-driven redesign: apply the real geometry fixes the platform CAN make to
 *  a routed board — enlarge the autorouter's sub-spec vias to JLCPCB minimums
 *  (0.5mm pad / 0.2mm hole -> 0.15mm annular) and add a board-edge margin so
 *  copper clears the outline. Mutates cj in place; returns the list of fixes.
 *  What it can't fix (e.g. vias the router packs too close) stays in the re-run
 *  DRC and is reported honestly, never hidden. */
function fabRepair(cj, { pad = 0.5, hole = 0.2 } = {}) {
  const fixes = []
  let vias = 0
  for (const e of cj) {
    if (e.type === 'pcb_via') {
      if ((e.outer_diameter ?? 0) < pad) { e.outer_diameter = pad; vias++ }
      if ((e.hole_diameter ?? 1) > hole) e.hole_diameter = hole
    }
  }
  if (vias) fixes.push(`enlarged ${vias} via${vias === 1 ? '' : 's'} to ${pad}mm pad / ${hole}mm hole`)
  const board = cj.find((e) => e.type === 'pcb_board')
  if (board) { board.width += 1.2; board.height += 1.2; fixes.push('added 0.6mm board-edge copper margin') }
  return fixes
}

/** Last-net completion: for each net freerouting left unrouted, route it on an
 *  otherwise-empty inner layer (top pad -> via -> straight inner trace -> via ->
 *  top pad) so it becomes real, continuous copper. Mutates cj (adds the traces +
 *  makes the board 4-layer); returns the count added. The CALLER must re-run real
 *  DRC and only accept the result if it stays clean — a completion that crosses
 *  an existing via trips via/trace clearance and is rejected, so we never fake a
 *  connection that isn't verifiably clean. */
function completeUnroutedNets(cj) {
  const routedSt = new Set(cj.filter((e) => e.type === 'pcb_trace').map((t) => t.source_trace_id))
  const unrouted = cj.filter((e) => e.type === 'source_trace' && !routedSt.has(e.source_trace_id))
  const padOf = (spid) => { const port = cj.find((e) => e.type === 'pcb_port' && e.source_port_id === spid); return cj.find((e) => e.type === 'pcb_smtpad' && e.pcb_port_id === port?.pcb_port_id) }
  let n = 0
  for (const st of unrouted) {
    const pads = (st.connected_source_port_ids || []).map(padOf).filter(Boolean)
    if (pads.length !== 2) continue // only simple 2-pin nets
    const [A, B] = pads, W = 0.15
    cj.push({
      type: 'pcb_trace', pcb_trace_id: `pcb_trace_completed_${st.source_trace_id}`, source_trace_id: st.source_trace_id,
      route: [
        { route_type: 'wire', x: A.x, y: A.y, width: W, layer: A.layer },
        { route_type: 'via', x: A.x, y: A.y, from_layer: A.layer, to_layer: 'inner1', hole_diameter: 0.2, outer_diameter: 0.5 },
        { route_type: 'wire', x: A.x, y: A.y, width: W, layer: 'inner1' },
        { route_type: 'wire', x: B.x, y: B.y, width: W, layer: 'inner1' },
        { route_type: 'via', x: B.x, y: B.y, from_layer: 'inner1', to_layer: B.layer, hole_diameter: 0.2, outer_diameter: 0.5 },
        { route_type: 'wire', x: B.x, y: B.y, width: W, layer: B.layer },
      ],
    })
    n++
  }
  if (n) { const board = cj.find((e) => e.type === 'pcb_board'); if (board) board.num_layers = Math.max(4, board.num_layers || 2) }
  return n
}

/** Via-legalization post-pass (spike). The autorouter packs layer-transition vias
 *  too close to OTHER-net copper (other vias, QFN pads), which KiCad flags as
 *  hole_clearance / *_clearance. Nudge each via away from nearby different-net
 *  copper, moving its matching trace route-via-point in lockstep so the net stays
 *  connected (the adjacent wire segments just stretch). Displacement is capped so a
 *  via can't wander off its own connection; the caller re-runs REAL DRC and keeps
 *  the result only if errors drop without adding unconnected nets. Same-net copper
 *  is never pushed apart — that IS the connection. Mutates cj in place. */
function legalizeVias(cj, { minClear = 0.4, maxDisp = 0.4, iters = 80 } = {}) {
  const vias = cj.filter((e) => e.type === 'pcb_via')
  if (!vias.length) return { moved: 0 }
  const pads = cj.filter((e) => e.type === 'pcb_smtpad')
  const traces = cj.filter((e) => e.type === 'pcb_trace')
  const net = (v) => v.subcircuit_connectivity_map_key
  // link each via to its route-via-point (same trace, same x/y) so both move together
  const rvp = new Map()
  for (const v of vias) {
    const t = traces.find((t) => t.pcb_trace_id === v.pcb_trace_id)
    const p = t?.route?.find((q) => q.route_type === 'via' && Math.abs(q.x - v.x) < 1e-3 && Math.abs(q.y - v.y) < 1e-3)
    if (p) rvp.set(v, p)
  }
  const orig = new Map(vias.map((v) => [v, { x: v.x, y: v.y }]))
  const padBox = (p) => [p.x - (p.width || 0) / 2, p.y - (p.height || 0) / 2, p.x + (p.width || 0) / 2, p.y + (p.height || 0) / 2]
  const gapToBox = (x, y, r, b) => Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3])) - r
  for (let it = 0; it < iters; it++) {
    let any = false
    for (const v of vias) {
      const r = (v.outer_diameter || 0.4) / 2
      let px = 0, py = 0
      for (const o of vias) { // other-net via copper
        if (o === v || net(o) === net(v)) continue
        const dx = v.x - o.x, dy = v.y - o.y, d = Math.hypot(dx, dy) || 1e-6
        const need = r + (o.outer_diameter || 0.4) / 2 + minClear
        if (d < need) { const f = need - d; px += (dx / d) * f; py += (dy / d) * f }
      }
      for (const p of pads) { // nearby pad copper (capped disp + re-DRC guard keep own net)
        const g = gapToBox(v.x, v.y, r, padBox(p))
        if (g < minClear) { const dx = v.x - p.x, dy = v.y - p.y, d = Math.hypot(dx, dy) || 1e-6; const f = (minClear - g); px += (dx / d) * f; py += (dy / d) * f }
      }
      if (!px && !py) continue
      let nx = v.x + px * 0.5, ny = v.y + py * 0.5
      const o = orig.get(v), ddx = nx - o.x, ddy = ny - o.y, disp = Math.hypot(ddx, ddy)
      if (disp > maxDisp) { nx = o.x + (ddx / disp) * maxDisp; ny = o.y + (ddy / disp) * maxDisp }
      if (Math.abs(nx - v.x) + Math.abs(ny - v.y) > 1e-4) { v.x = nx; v.y = ny; const q = rvp.get(v); if (q) { q.x = nx; q.y = ny }; any = true }
    }
    if (!any) break
  }
  return { moved: vias.filter((v) => { const o = orig.get(v); return Math.hypot(v.x - o.x, v.y - o.y) > 0.01 }).length }
}

/** The iterative DRC-driven redesign loop. Escalates through a ladder of real
 *  strategies — spread the board out, then step up to a finer (HDI) fab process
 *  — re-routing and re-checking each time. STOPS the instant a strategy passes
 *  DRC clean (a real, buildable solution). If the ladder is exhausted without
 *  converging, returns the BEST board found plus an honest verdict naming the
 *  residual and the capability wall. Never fakes convergence. */
async function iterativeRedesign(parts, nets, { gap = 2.1, maxW = 15 } = {}) {
  // Prefer freerouting (real push-and-shove router) when available; fall back to
  // the built-in router + geometry repair. Escalate the fab process (standard ->
  // HDI) within each router. A board only truly converges when DRC is clean AND
  // every net is routed.
  // `gap` is the component-to-component spacing the placement uses: the outer
  // design<->routing convergence loop (see main) re-invokes this with a WIDER gap
  // when the board still won't route, so the routing risk is relieved by giving
  // the router more channel room — the real lever, not just more layers.
  // A board with no signal nets has nothing to route — the freerouting ladder
  // would spawn ~3 JVMs that route zero traces (~60s wasted, as the 1-chip profile
  // showed). Skip straight to a single placement+DRC pass.
  const noNets = !nets?.length
  const spread = +(gap + 1.3).toFixed(2) // the fallback ladder's roomier variant, relative to the base gap
  const ladder = noNets
    ? [{ name: 'placement only (no signal nets)', router: 'tsci', place: { gap, maxW, clearance: 0.5 }, profile: 'standard' }]
    : FR_JAR && JAVA
    ? [
        { name: 'freerouting 2-layer, standard fab', router: 'fr', layers: 2, place: { gap, maxW, singleSided: true }, profile: 'standard' },
        { name: 'freerouting 4-layer, standard fab', router: 'fr', layers: 4, place: { gap, maxW, singleSided: true }, profile: 'standard' },
        { name: 'freerouting 4-layer, HDI fab',      router: 'fr', layers: 4, place: { gap, maxW, singleSided: true }, profile: 'hdi' },
        { name: 'built-in router, HDI fab',          router: 'tsci', place: { gap, maxW, clearance: 0.45 }, profile: 'hdi' },
      ]
    : [
        { name: 'built-in router, standard', router: 'tsci', place: { gap, maxW, clearance: 0.5 }, profile: 'standard' },
        { name: 'built-in router, spread',   router: 'tsci', place: { gap: spread, maxW: maxW + 3, clearance: 0.5 }, profile: 'standard' },
        { name: 'built-in router, HDI fab',  router: 'tsci', place: { gap, maxW, clearance: 0.45 }, profile: 'hdi' },
      ]
  // Net-aware placement (min pin-to-pin wirelength + routing channels) once, up
  // front — it's what lets the router complete every net. Reused across the
  // freerouting passes (they differ only in layers/fab profile). Null -> the
  // strategies fall back to the connectivity shelf-pack.
  const netAwarePlaced = FR_JAR && JAVA ? await netAwarePlace(parts, nets, { gap, maxW }) : null

  const trail = []
  let best = null
  for (let i = 0; i < ladder.length; i++) {
    const s = ladder[i]
    // Net-aware placement (pin-facing, min-wirelength) helps BOTH routers: it puts
    // connected pins adjacent so the router has short, uncrossed channels. Re-emit
    // it per strategy so the built-in router still gets its fab-aware clearances.
    // Falls back to the connectivity shelf-pack when net-aware isn't available.
    const code = netAwarePlaced
      ? emitBoardCode(netAwarePlaced, nets, { clearance: s.router === 'tsci' ? s.place.clearance : null })
      : buildCode(parts, nets, s.place)
    let cj = await runTscircuitCode(code)
    let fixes = [], unrouted = 0
    if (s.router === 'fr') {
      const fr = await freeroute(cj, { layers: s.layers })
      if (!fr) continue // freerouting failed this pass; try the next strategy
      cj = fr.cj; unrouted = fr.unrouted
      // freerouting can route copper right to the outline; give the board the
      // same edge margin the built-in path gets so copper clears the edge.
      const board = cj.find((e) => e.type === 'pcb_board')
      if (board) { board.width += 1.2; board.height += 1.2 }
      fixes = [
        netAwarePlaced ? 'net-aware placement (min pin-to-pin wirelength)' : 'connectivity placement',
        `routed with freerouting (push & shove, ${s.layers}-layer)`,
        'added 0.6mm board-edge copper margin',
      ]
      if (unrouted) fixes.push(`${unrouted} net(s) left unrouted`)
    } else {
      fixes = fabRepair(cj, FAB_PROFILES[s.profile].via)
    }
    const drc = await realDrc(cj, s.profile)
    if (!drc.available) return { available: false, drc, trail, best: null }
    const score = drc.errors + unrouted * 5 // unrouted nets are worse than a DRC nit
    trail.push({ iter: i + 1, strategy: s.name, profile: FAB_PROFILES[s.profile].label, errors: drc.errors, errorTypes: drc.errorTypes, unrouted })
    if (!best || score < best.score) best = { cj, drc, fixes, unrouted, score, strategy: s.name }
    if (drc.errors === 0 && unrouted === 0) break // fully routed AND fab-clean — done
  }
  if (!best) return { available: false, drc: { available: false, reason: 'all routing strategies failed' }, trail }

  // Last-net completion: if the best board is DRC-clean but freerouting left a
  // net or two stranded, route them on an empty inner layer and re-check. Accept
  // ONLY if real DRC stays clean (a completion that crosses a via trips
  // clearance and is rejected) — so a completed net is verified copper, not
  // faked. This is the deterministic closer the autorouter alone can't give.
  if (best.drc.errors === 0 && best.unrouted > 0) {
    const cjTry = JSON.parse(JSON.stringify(best.cj))
    const n = completeUnroutedNets(cjTry)
    if (n > 0) {
      const drcTry = await realDrc(cjTry, best.drc.profileKey || 'standard')
      if (drcTry.available && drcTry.errors === 0) {
        best = {
          ...best, cj: cjTry, drc: drcTry, unrouted: 0,
          fixes: [...best.fixes.filter((f) => !/left unrouted/.test(f)), `completed ${n} stranded net${n === 1 ? '' : 's'} on an inner layer (DRC-verified copper)`],
          strategy: best.strategy + ' + inner-layer completion',
        }
      }
    }
  }
  const converged = best.drc.errors === 0 && best.unrouted === 0
  let verdict = null
  if (!converged) {
    if (best.unrouted > 0) {
      verdict = `iterated ${trail.length} strateg${trail.length === 1 ? 'y' : 'ies'}; best board has ${best.drc.errors} DRC error(s) and ${best.unrouted} net(s) the autorouter couldn't complete — needs manual routing or a simpler netlist.`
    } else {
      const top = Object.entries(best.drc.errorTypes || {}).sort((a, b) => b[1] - a[1])[0]?.[0]
      verdict = `iterated ${trail.length} strateg${trail.length === 1 ? 'y' : 'ies'}; best ${best.drc.errors} error(s) (${top || 'DRC'}) under ${best.drc.ruleProfile} — beyond the loop's current levers.`
    }
  }
  return { available: true, converged, best, trail, verdict }
}

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'))

  // Validate footprints up front. tscircuit expands "qfn999" into a literal
  // 999-pad part that hangs placement/routing for minutes — reject an absurd or
  // unknown footprint with a clean error instead of spinning. Parts carrying a
  // real LCSC kicadMod skip this (their geometry is explicit).
  if (Array.isArray(input.parts)) {
    for (const p of input.parts) {
      if (p?.kicadMod) continue
      const fp = String(p?.footprint ?? '')
      const m = fp.match(/^qfn(\d+)$/)
      const ok = m ? (+m[1] >= 4 && +m[1] <= 64) : /^0\d{3}$/.test(fp)
      if (!ok) {
        process.stdout.write(JSON.stringify({ ok: false, error: `unsupported footprint "${fp}" on ${p?.name ?? '?'} — use qfn4..qfn64 or an 0402-class passive (or supply a real LCSC kicadMod)` }))
        return
      }
    }
  }

  const iterative = input.parts && input.repair !== false && input.drc !== false && KICAD_CLI

  // Iterative DRC-driven redesign: search the strategy ladder for a real
  // fab-clean board; use the best one it finds as the reported result.
  let cj, drc, drcRepair = null, code, kicadPcb = null
  if (iterative) {
    // Design<->routing convergence: run the routing ladder at the TIGHTEST gap
    // first; if the best board still won't route clean (DRC errors or stranded
    // nets), re-engineer the DESIGN — spread the placement so the router gets
    // wider channels — and re-run. Stop at the FIRST gap that converges (the
    // smallest board that routes clean), or, if none do, keep the loosest
    // attempt and report the density limit honestly. This is the real lever the
    // reviewer's "2 unconnected pads, stopping" run never got to pull.
    // Each looser attempt re-runs the whole routing ladder, so a board that never
    // converges could run 3x and blow the runner's hard wall (a 14-part board
    // already spends ~210s on one pass). Budget it: a slow board spends its whole
    // budget on the tight pass (no loosen, but it finishes and reports honestly);
    // a fast-failing dense board has time left to loosen. We only START a looser
    // attempt if the elapsed time plus an estimate of the next attempt (~the last
    // attempt's cost) still fits under the wall.
    const GAP_LADDER = [2.1, 3.2, 4.6]
    const T_START = Date.now()
    const BUDGET_MS = 255_000 // under the electronics-cs runner's 285s hard wall, leaving margin for post-processing
    let res = null, gapTrail = [], usedGap = GAP_LADDER[0], lastMs = 0
    const scoreOf = (a) => a?.available ? (a.best.drc.errors + a.best.unrouted * 5) : Infinity
    for (const g of GAP_LADDER) {
      if (g !== GAP_LADDER[0]) {
        const elapsed = Date.now() - T_START
        if (elapsed + lastMs * 1.1 > BUDGET_MS) {
          gapTrail.push({ gap: g, skipped: 'time budget', elapsedMs: elapsed })
          break // out of time to try a looser board — keep the best so far, report honestly
        }
      }
      const tA = Date.now()
      const attempt = await iterativeRedesign(input.parts, input.nets, { gap: g, maxW: 15 })
      lastMs = Date.now() - tA
      gapTrail.push({ gap: g, available: attempt.available,
        errors: attempt.best?.drc?.errors ?? null, unrouted: attempt.best?.unrouted ?? null,
        converged: !!attempt.converged, ms: lastMs })
      // keep the best attempt so far: converged beats not; fewer (errors+5*unrouted) wins
      if (!res || (attempt.available && (attempt.converged && !res.converged || scoreOf(attempt) < scoreOf(res)))) {
        res = attempt; usedGap = g
      }
      if (attempt.available && attempt.converged) break // smallest board that routes clean — done
    }
    if (res && res.available) {
      cj = res.best.cj
      drc = res.best.drc
      code = buildCode(input.parts, input.nets, { gap: usedGap, maxW: 15 }) // representative source
      const loosened = gapTrail.length > 1 && usedGap > GAP_LADDER[0]
      drcRepair = {
        converged: res.converged,
        iterations: res.trail,
        winningStrategy: res.best.strategy,
        errorsFirst: res.trail[0]?.errors ?? null,
        errorsBest: res.best.drc.errors,
        unrouted: res.best.unrouted,
        fixes: loosened
          ? [...res.best.fixes, `spread placement to ${usedGap}mm component gap so the router could close (design↔routing convergence)`]
          : res.best.fixes,
        verdict: res.verdict,
        gapConvergence: { ladder: gapTrail, chosenGap: usedGap, loosened },
      }
      // Via-legalization post-pass: if the best board has DRC errors, try nudging
      // over-packed vias off nearby other-net copper, then re-DRC. Keep it ONLY if
      // total errors drop and no new unconnected nets appear (a via that wandered
      // off its connection would show up as unconnected). Real geometry, re-checked.
      if ((drc?.errors ?? 0) > 0) {
        const cjTry = JSON.parse(JSON.stringify(cj))
        const { moved } = legalizeVias(cjTry, { minClear: 0.4, maxDisp: 0.8, iters: 200 })
        if (moved > 0) {
          const drc2 = await realDrc(cjTry, res.best.drc.profileKey || 'standard')
          const unbefore = drc.errorTypes?.unconnected_items || 0
          const unafter = drc2.errorTypes?.unconnected_items || 0
          if (drc2.available && drc2.errors < drc.errors && unafter <= unbefore) {
            cj = cjTry; drc = drc2
            drcRepair.viaLegalization = { moved, errorsBefore: drcRepair.errorsBest, errorsAfter: drc2.errors }
            drcRepair.errorsBest = drc2.errors
            drcRepair.fixes = [...drcRepair.fixes, `via-legalization: nudged ${moved} via(s) off other-net copper → ${drc2.errors} DRC error(s)`]
          }
        }
      }
      // Real ground plane (pcbnew): assign GND to the ground pins and lay a
      // DRC-verified GND zone that bonds them. Signals stay freerouting-routed;
      // ground becomes a plane, the way a real board does it.
      if (input.gnd?.length) {
        const gp = await applyGroundPlane(res.best.cj, input.gnd, res.best.drc.profileKey || 'standard')
        if (gp?.available) {
          if (gp.pcb) kicadPcb = gp.pcb // grounded board (with the GND plane) for the 3D render
          drcRepair.groundPlane = { assigned: gp.assigned, unconnected: gp.unconnected, stitched: gp.stitched, skipped: gp.skipped, errors: gp.errors }
          const stitchNote = gp.stitched ? `, ${gp.stitched} bonded down via tented via-in-pad` : ''
          drcRepair.fixes = [...res.best.fixes, `ground plane: ${gp.assigned} pins on a DRC-verified GND zone${stitchNote}${gp.unconnected ? ` (${gp.unconnected} still unreached)` : ''}`]
          // `converged` stays the SIGNAL verdict (routing clean). The ground plane
          // is a best-effort overlay reported on its own. Tented via-in-pad now
          // stitches stranded pads down to a reference plane; a via we must skip
          // to protect the 0.5mm hole_clearance leaves its pad unreached, and we
          // surface that honestly rather than fail the whole board over it.
          const planeClean = (gp.unconnected ?? 0) === 0 && (gp.errors ?? 0) === 0
          if (!planeClean) {
            const bits = []
            if (gp.unconnected) bits.push(`${gp.unconnected} ground pin(s) unreached${gp.skipped ? ` (${gp.skipped} via-in-pad skipped to hold hole_clearance)` : ''}`)
            if (gp.errors) bits.push(`${gp.errors} zone DRC error(s) amid the dense routing`)
            drcRepair.verdict = `${res.verdict ? res.verdict + ' ' : ''}Ground plane: ${bits.join(' + ')} — a real chip-scale density limit, reported not hidden.`
          }
        }
      }
    }
  }
  // Fallbacks: explicit code input, or iterative unavailable/failed.
  if (!cj) {
    code = input.code || (input.parts ? buildCode(input.parts, input.nets) : '')
    cj = await runTscircuitCode(code)
    drc = input.drc !== false && cj.find((e) => e.type === 'pcb_board') ? await realDrc(cj) : { available: false, reason: 'skipped' }
  }

  if (process.env.FL_DUMP_CJ && cj) { try { fs.writeFileSync(process.env.FL_DUMP_CJ, JSON.stringify(cj)) } catch { /* dump best-effort */ } }
  const board = cj.find((e) => e.type === 'pcb_board')
  const traces = cj.filter((e) => e.type === 'pcb_trace')
  const comps = cj.filter((e) => e.type === 'pcb_component')
  const errors = {}
  for (const e of cj) if (/error/.test(e.type)) errors[e.type] = (errors[e.type] || 0) + 1

  let svg = false
  if (input.svgPath && board) {
    try {
      const { convertCircuitJsonToPcbSvg, convertCircuitJsonToSchematicSvg } = await import('circuit-to-svg')
      fs.writeFileSync(input.svgPath, convertCircuitJsonToPcbSvg(cj))
      svg = true
      // also a schematic SVG so the Layout/Schematic views show THIS board, not
      // the flroute reference schematic.
      try { fs.writeFileSync(input.svgPath.replace(/\.svg$/, '-schematic.svg'), convertCircuitJsonToSchematicSvg(cj)) } catch { /* schematic optional */ }
    } catch { /* svg optional */ }
  }

  // Persist the routed board as a .kicad_pcb for the 3D render. Prefer the
  // grounded board (captured above); else convert the best cj now. This is the
  // real chip-down board — small, the one that belongs in the enclosure.
  if (!kicadPcb && board) {
    try {
      const { CircuitJsonToKicadPcbConverter } = await import('circuit-json-to-kicad')
      const conv = new CircuitJsonToKicadPcbConverter(cj); conv.runUntilFinished()
      kicadPcb = conv.getOutputString()
    } catch { /* 3D export optional */ }
  }
  // Populate the board with 3D component bodies so it renders as a PCBA, not a
  // bare PCB.
  if (kicadPcb && input.parts) kicadPcb = attachModels(kicadPcb, input.parts)

  const errorCount = Object.values(errors).reduce((a, b) => a + b, 0)
  process.stdout.write(JSON.stringify({
    ok: !!board && traces.length > 0 && errorCount === 0,
    kicadPcb,
    boardMm: board ? { w: Math.round(board.width * 10) / 10, h: Math.round(board.height * 10) / 10 } : null,
    areaMm2: board ? Math.round(board.width * board.height) : null,
    // freerouting's DSN round-trip drops pcb_component records; fall back to the
    // real part count so the UI never shows "0 components" for a routed board.
    components: comps.length || (Array.isArray(input.parts) ? input.parts.length : 0),
    routedTraces: traces.length,
    errors,
    drc,
    drcRepair,
    svg,
    code,
  }))
}

main().catch((e) => { process.stdout.write(JSON.stringify({ ok: false, error: String(e).slice(0, 300) })); process.exit(1) })
