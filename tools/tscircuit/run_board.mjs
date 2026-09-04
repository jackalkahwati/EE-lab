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

// ---- per-phase timing instrumentation ----------------------------------------
// Additive observability: every expensive phase (tscircuit build, freerouting JVM
// pass, KiCad DRC, ground plane) logs a `[t] phase: Xs` stderr line and accumulates
// into a `timings` object emitted in the output JSON. No schema change — new field.
const T_RUN0 = Date.now()
const TIMINGS = {
  phases: {}, // name -> { ms, n }
  counters: { tscircuitBuilds: 0, freeroutingPasses: 0, jvmStarts: 0, kicadDrcRuns: 0, kicadVersionCalls: 0, groundPlanePasses: 0, tscircuitBuildCacheHits: 0, freerouteCacheHits: 0 },
}
function tAdd(phase, ms, note) {
  const p = (TIMINGS.phases[phase] = TIMINGS.phases[phase] || { ms: 0, n: 0 })
  p.ms += ms; p.n++
  process.stderr.write(`[t] ${phase}: ${(ms / 1000).toFixed(1)}s${note ? ` (${note})` : ''}\n`)
}
// FL_BASELINE=1 disables every wall-clock optimization (caches, routingDisabled
// pre-route skip, JVM startup flags) so a before/after A-B on the SAME file is
// one env var away. Results (routing, DRC) are identical either way — the
// optimizations only skip provably redundant work.
const OPT = process.env.FL_BASELINE !== '1'

/** All tscircuit evaluations go through here so they're timed + cached. The cache
 *  is exact-code-string keyed and stores the circuit JSON as a STRING, re-parsed
 *  per hit — callers mutate their cj (fabRepair, board margins, features), so a
 *  shared object would alias state across strategies; a parse is ~ms and safe. */
const CJ_CACHE = new Map()
async function buildCircuit(code, note) {
  const t0 = Date.now()
  const hit = OPT ? CJ_CACHE.get(code) : null
  if (hit) {
    TIMINGS.counters.tscircuitBuildCacheHits++
    const cj = JSON.parse(hit)
    tAdd('tscircuitBuild', Date.now() - t0, `${note ? note + ', ' : ''}cache hit`)
    return cj
  }
  TIMINGS.counters.tscircuitBuilds++
  const cj = await runTscircuitCode(code)
  try { CJ_CACHE.set(code, JSON.stringify(cj)) } catch { /* cache best-effort */ }
  tAdd('tscircuitBuild', Date.now() - t0, note)
  return cj
}

// Real KiCad DRC — the honesty upgrade over tscircuit's own router check. We
// convert the routed board to a real .kicad_pcb and run `kicad-cli pcb drc`
// against realistic fab rules (JLCPCB 4-layer, 0.09mm), so "clean" means it
// passes the same design-rule check a fab runs, not just our own. Gated on
// kicad-cli being installed; absent -> honestly reported unavailable.
// FL_KICAD_CLI override first (Linux/cloud), else probe the local installs.
const KICAD_CLI = process.env.FL_KICAD_CLI
  || ['/opt/homebrew/bin/kicad-cli', '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli']
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
// FL_KICAD_PYTHON override first (Linux/cloud), else probe the local installs.
const KICAD_PY = process.env.FL_KICAD_PYTHON
  || ['/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3', '/usr/bin/python3']
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
    const hcNum = (FAB_PROFILES[profileKey] || FAB_PROFILES.standard).holeClearance ?? 0.5
    fs.writeFileSync(inPcb, decorateMountingHoles(conv.getOutputString(), hcNum))
    fs.writeFileSync(gndJson, JSON.stringify(gndPins))
    const hc = String(hcNum)
    const r = spawnSync(KICAD_PY, [GROUND_PLANE_PY, inPcb, outPcb, gndJson, hc], { encoding: 'utf8', timeout: 120000 })
    if (!fs.existsSync(outPcb)) return { available: false, reason: 'ground plane pass produced no board', stderr: (r.stderr || '').slice(0, 200) }
    let gp = {}; try { gp = JSON.parse((r.stdout || '').trim().split('\n').pop() || '{}') } catch { /* keep defaults */ }
    fs.writeFileSync(path.join(dir, 'g.kicad_dru'), (FAB_PROFILES[profileKey] || FAB_PROFILES.standard).rules)
    spawnSync(KICAD_CLI, ['pcb', 'drc', '--format', 'json', '--output', drcJson, outPcb], { encoding: 'utf8', timeout: 120000 })
    let errors = null
    // same electrical/non-electrical split as realDrc so gp.errors and drc.errors agree
    if (fs.existsSync(drcJson)) { const rep = JSON.parse(fs.readFileSync(drcJson, 'utf8')); errors = classifyDrcErrors(rep.violations || []).errs.length }
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
/** Rewrite a 2-layer DSN as an N-layer board (N ∈ {4,6,8}) with through-vias
 *  spanning all layers. A chip-scale board is genuinely multi-layer HDI, and the
 *  inner copper gives the router the room to complete dense nets a 2-layer board
 *  leaves stranded (congestion, not geometry). Adding LAYERS (z-axis) is the right
 *  relief for a dense or precision board — more routing channels without sprawling
 *  the outline out in xy — so the ladder escalates 4→6→8 when 4 still won't close. */
function dsnToNLayer(d, n = 4) {
  n = [4, 6, 8].includes(n) ? n : 4
  const f = d.structure.layers.find((l) => l.name === 'F.Cu')
  const b = d.structure.layers.find((l) => l.name === 'B.Cu')
  if (!f || !b) return d
  const innerNames = []
  const inner = []
  for (let i = 0; i < n - 2; i++) {
    const name = `In${i + 1}.Cu`
    innerNames.push(name)
    inner.push({ name, type: 'signal', property: { index: i + 1 } })
  }
  f.property = { index: 0 }; b.property = { index: n - 1 }
  d.structure.layers = [f, ...inner, b]
  const all = ['F.Cu', ...innerNames, 'B.Cu']
  for (const ps of (d.library?.padstacks || [])) {
    if (/via/i.test(ps.name)) {
      const dia = ps.shapes?.[0]?.diameter || 600
      ps.shapes = all.map((layer) => ({ shapeType: 'circle', layer, diameter: dia }))
    }
  }
  return d
}
// back-compat thin alias — some call sites still name the 4-layer case directly.
function dsnTo4Layer(d) { return dsnToNLayer(d, 4) }

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

/** Timing + dedupe wrapper around the real freerouting pass. The redesign ladder
 *  legitimately asks for the SAME route twice (4-layer standard fab vs 4-layer HDI
 *  fab differ only in DRC rules — the DSN handed to freerouting is byte-identical),
 *  so identical-DSN calls are served from an in-process cache instead of paying a
 *  second JVM start + route. The cache key is the exact DSN text: same input, same
 *  routed copper — result quality is unchanged by construction. */
async function freeroute(cj, opts = {}) {
  const t0 = Date.now()
  TIMINGS.counters.freeroutingPasses++
  const r = await freerouteReal(cj, opts)
  tAdd('freeroute', Date.now() - t0, `layers=${opts.layers ?? 2}, ${r ? `unrouted=${r.unrouted}${r.cached ? ', dsn cache hit' : ''}` : 'failed'}`)
  return r
}
const FR_CACHE = new Map() // dsn text -> { wires: JSON string of routed traces+vias, unrouted }
/**
 * Which DSN nets correspond to source traces the router failed to complete.
 *
 * A source trace names its endpoints as ".U1 > .pin39 to .C3 > .pin1"; a DSN
 * net names its pins as "U1_source_component_0-39". Match on the (component
 * ref, pin) pairs, which is the only thing both spellings agree on.
 */
function dsnNetsForUnrouted(dsnPcb, unroutedNets) {
  const wanted = []
  for (const n of unroutedNets || []) {
    const pairs = [...String(n?.name || '').matchAll(/\.([A-Za-z]+\d+)\s*>\s*\.pin(\d+)/g)].map((m) => [m[1], m[2]])
    if (pairs.length >= 2) wanted.push(pairs)
  }
  if (!wanted.length) return new Set()
  const hit = (pin, ref, num) => {
    const i = String(pin).lastIndexOf('-')
    if (i < 0) return false
    return String(pin).slice(i + 1) === num && String(pin).slice(0, i).startsWith(`${ref}_`)
  }
  const names = new Set()
  for (const net of dsnPcb?.network?.nets || []) {
    for (const pairs of wanted) {
      if (pairs.every(([ref, num]) => (net.pins || []).some((p) => hit(p, ref, num)))) { names.add(net.name); break }
    }
  }
  return names
}

/**
 * Route the named nets FIRST.
 *
 * Net order is the single cheapest lever on an autorouter's result. The DSN
 * comes out alphabetical, which is arbitrary with respect to difficulty: nets
 * routed early get open space, nets routed last fight for whatever is left, and
 * the ones that lose are exactly the ones reported unrouted. Re-presenting the
 * board with those nets at the front is deterministic, costs one more pass, and
 * is the standard fix for this failure. Both the net array and the class's
 * net_names list are permuted so the file stays self-consistent.
 */
function reorderDsnNets(dsnPcb, firstNames) {
  if (!firstNames?.size || !dsnPcb?.network?.nets) return false
  const nets = dsnPcb.network.nets
  const head = nets.filter((n) => firstNames.has(n.name))
  if (!head.length || head.length === nets.length) return false
  dsnPcb.network.nets = [...head, ...nets.filter((n) => !firstNames.has(n.name))]
  const order = new Map(dsnPcb.network.nets.map((n, i) => [n.name, i]))
  for (const cls of dsnPcb.network.classes || []) {
    if (Array.isArray(cls.net_names)) {
      cls.net_names = [...cls.net_names].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9))
    }
  }
  return true
}

async function freerouteReal(cj, { layers = 2, routeFirst = null } = {}) {
  if (!JAVA || !FR_JAR) return null
  let dir
  try {
    const { convertCircuitJsonToDsnJson, stringifyDsnJson, parseDsnToDsnJson, convertDsnSessionToCircuitJson } = await import('dsn-converter')
    const unrouted = cj.filter((e) => e.type !== 'pcb_trace' && e.type !== 'pcb_via')
    let dsnPcb = convertCircuitJsonToDsnJson(unrouted)
    if (layers > 2) dsnPcb = dsnToNLayer(dsnPcb, layers)
    // 0.25mm via_via clearance -> 0.6mm via pads stay >=0.85mm center-to-center,
    // so 0.3mm holes clear the 0.5mm hole_clearance with margin (was the residual
    // fab-DRC error on dense boards). freerouting honours this from the DSN.
    setViaClearance(dsnPcb, 250)
    // Retry ordering: put previously-unrouted nets at the front. Changing the
    // net order changes the DSN text, so this also misses the route cache by
    // construction — which is what makes the retry a genuinely different pass
    // rather than a replay of the same deterministic result.
    let reordered = false
    if (routeFirst?.length) reordered = reorderDsnNets(dsnPcb, dsnNetsForUnrouted(dsnPcb, routeFirst))
    const dsnText = stringifyDsnJson(dsnPcb)
    // Identical DSN already routed this run? Reuse its copper — the second JVM
    // pass would route the exact same input (see wrapper docstring).
    const cached = OPT ? FR_CACHE.get(dsnText) : null
    if (cached) {
      TIMINGS.counters.freerouteCacheHits++
      return { cj: [...unrouted, ...JSON.parse(cached.wires)], unrouted: cached.unrouted, unroutedNets: cached.unroutedNets ?? [], layers, cached: true }
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-fr-'))
    const dsnPath = path.join(dir, 'b.dsn'), sesPath = path.join(dir, 'b.ses')
    fs.writeFileSync(dsnPath, dsnText)
    if (process.env.FL_FR_DEBUG) { try { fs.mkdirSync(process.env.FL_FR_DEBUG, { recursive: true }); fs.writeFileSync(path.join(process.env.FL_FR_DEBUG, `dsn-pass-${TIMINGS.counters.freeroutingPasses}-l${layers}.dsn`), dsnText) } catch { /* debug only */ } }
    // -Djava.awt.headless=true: run with NO GUI window (freerouting otherwise
    //   pops its editor app on -de/-do) — pure backend subprocess.
    // Network timeouts: its startup "check for updates" call otherwise stalls
    //   ~2min on the socket; routing itself is sub-second.
    // Together these take a run from ~120s (+ a GUI window) to ~3s, headless.
    // -XX:TieredStopAtLevel=1: C1-only JIT — a short-lived batch route never earns
    //   back C2 compile time. Measured on this jar: ~0.5s faster per JVM start in
    //   isolation (3.15s → 2.63s avg init), and per-pass routed results (unrouted
    //   count, DRC errors) matched the C2 runs on the A/B board.
    // A warm/daemon JVM was evaluated and REJECTED: freerouting's CLI is strictly
    //   one-shot (-de/-do), so batching would require its HTTP API server — a
    //   long-lived service this self-contained runner (which also runs headless)
    //   shouldn't own for the ~2.6s/start it would save. The DSN cache below
    //   already removes the fully redundant starts.
    const tJvm = Date.now()
    TIMINGS.counters.jvmStarts++
    // -mp is the router's MAX pass ceiling (route + rip-up-reroute + optimize).
    // It was 10 — unusually low (freerouting's own default is ~100). On a SPARSE
    // board the router completes in a handful of passes and never approaches the
    // cap, so this stayed ~3s; but a DENSE/congested board needs many rip-up-and-
    // reroute passes just to COMPLETE every net before it can optimize, and a cap
    // of 10 stranded 5-6 nets (the "freerouting mangles dense boards" symptom that
    // forced 2-layer fallbacks). Raise the ceiling to 100 and give the JVM room to
    // spend those passes (45s -> 150s). Both are caps: sparse boards are unchanged;
    // only a genuinely congested board uses the extra passes/time. The gap-ladder's
    // own BUDGET_MS and the route wall still bound the total, and the ladder stops
    // at the first CLEAN route — so a board that now completes 4-layer stops early.
    const r = spawnSync(JAVA, [
      '-Djava.awt.headless=true',
      '-Dsun.net.client.defaultConnectTimeout=1500',
      '-Dsun.net.client.defaultReadTimeout=1500',
      ...(OPT ? ['-XX:TieredStopAtLevel=1'] : []),
      '-jar', FR_JAR, '-de', dsnPath, '-do', sesPath, '-mp', '100',
    ], { encoding: 'utf8', timeout: 150000 })
    tAdd('freeroute.jvm', Date.now() - tJvm)
    if (!fs.existsSync(sesPath)) return null
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
    // Net-assign the session's vias. dsn-converter emits pcb_via records with NO
    // usable net linkage — no subcircuit_connectivity_map_key, and a pcb_trace_id
    // ("pcb_trace_<netName>") that names no real record — so circuit-json-to-kicad
    // exports them as net-0 copper and KiCad DRC flags each one as foreign metal
    // against its OWN track: phantom shorting_items + hole_clearance by the dozens
    // (measured: ~200 of the ~230 "freerouting mangles dense boards" errors were
    // exactly this, not bad routing). A via always sits ON its own net's wire, so
    // link each via to the grafted trace whose route passes through it and copy
    // that trace's net linkage (key directly when present, else via source_trace).
    // Also un-breaks legalizeVias for these boards: netless vias all compared as
    // "same net" (undefined === undefined) and were never pushed apart.
    let viasLinked = 0, viasOrphan = 0
    for (const v of routedWires) {
      if (v.type !== 'pcb_via') continue
      let best = null, bestD = 0.05 // mm — via centers coincide with a wire joint within rounding
      for (const t of routedWires) {
        if (t.type !== 'pcb_trace' || !Array.isArray(t.route)) continue
        for (const q of t.route) {
          const d = Math.hypot((q.x ?? 1e9) - v.x, (q.y ?? 1e9) - v.y)
          if (d < bestD) { best = t; bestD = d }
        }
      }
      if (best) {
        v.pcb_trace_id = best.pcb_trace_id
        let key = best.subcircuit_connectivity_map_key
        if (!key && best.source_trace_id) {
          const st = unrouted.find((e) => e.type === 'source_trace' && e.source_trace_id === best.source_trace_id)
          key = st?.subcircuit_connectivity_map_key
        }
        if (key) v.subcircuit_connectivity_map_key = key
        viasLinked++
      } else viasOrphan++
    }
    if (viasLinked || viasOrphan) tAdd('viaNetLink', 0, `${viasLinked} linked${viasOrphan ? `, ${viasOrphan} orphan` : ''}`)
    // Structural unrouted count: input nets (source_trace) minus the nets that
    // came back with routed copper (distinct source_trace_id on the session's
    // pcb_traces — the same linkage completeUnroutedNets already relies on).
    // The old stdout regex parse ("(N unrouted)") silently reads "fully routed"
    // the day freerouting changes its log format, so it is demoted to a
    // cross-check fallback, used only in the one degenerate case where the
    // converter returned traces that carry no source ids at all (which would
    // otherwise make the structural count claim EVERY net unrouted).
    const sourceTraces = unrouted.filter((e) => e.type === 'source_trace')
    const routedIds = new Set(routedWires.filter((e) => e.type === 'pcb_trace').map((t) => t.source_trace_id).filter(Boolean))
    const structuralUnrouted = sourceTraces.filter((st) => !routedIds.has(st.source_trace_id)).length
    const m = [...(r.stdout || '').matchAll(/\((\d+) unrouted\)/g)]
    const stdoutUnrouted = m.length ? Number(m[m.length - 1][1]) : null
    const idsMissing = routedIds.size === 0 && routedWires.some((e) => e.type === 'pcb_trace')
    const unroutedN = idsMissing ? (stdoutUnrouted ?? sourceTraces.length) : structuralUnrouted
    // WHICH nets failed, not just how many. The count alone tells a user their
    // board is incomplete but not what to fix, and rip-up-and-reroute needs the
    // identities to re-present just those nets to the router.
    const unroutedNets = idsMissing ? [] : sourceTraces
      .filter((st) => !routedIds.has(st.source_trace_id))
      .map((st) => ({
        id: st.source_trace_id,
        name: st.display_name ?? st.name ?? null,
        pins: Array.isArray(st.connected_source_port_ids) ? st.connected_source_port_ids.length : null,
      }))
    // Cache the routed copper as a STRING keyed by the exact DSN text; a hit
    // re-parses so callers can freely mutate their copy (no aliasing).
    try { FR_CACHE.set(dsnText, { wires: JSON.stringify(routedWires), unrouted: unroutedN, unroutedNets }) } catch { /* cache best-effort */ }
    return { cj: [...unrouted, ...routedWires], unrouted: unroutedN, unroutedNets, layers, reordered }
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

// ---- legalizer / residual-nudge tuning ---------------------------------------
// The via/trace legalizers used to push copper apart to EXACTLY the fab's
// hole_clearance rule (a hardcoded 0.4 — which was also UNDER the standard
// profile's 0.5mm rule). Zero margin means float rounding + the converter's
// coordinate rounding leaves items at 0.354-0.388mm against a 0.4mm rule — the
// exact residual seen on production drc.json files. Legalize to rule + margin.
const LEGALIZE_MARGIN_MM = 0.05
// Residual nudge (post-ladder): a board that ends the whole strategy ladder with
// only a handful of hole_clearance/clearance nits gets ONE more targeted
// legalization pass at a slightly larger displacement. Above this count (or with
// an unrouted net) the density is real and the caller re-plans/grows instead.
const RESIDUAL_NUDGE_MAX = 5
const RESIDUAL_NUDGE_DISP_BOOST = 0.1 // mm over the last accepted legalizer displacement
const RESIDUAL_NUDGE_TARGET_R = 1.0 // mm — only copper this close to a violation moves
/**
 * How bad each DRC class actually is, for ranking candidate boards.
 *
 * ELECTRICAL faults (a short, a crossing, a connection that isn't there) mean
 * the board is WRONG — it will not do what the netlist says. FAB faults
 * (clearance, hole clearance, mask bridge, edge clearance) mean the board works
 * but the fab may flag or refuse it. Ranking on a raw error count treats those
 * as interchangeable and will happily choose a non-functional board because it
 * has a smaller number next to it.
 */
const DRC_SEVERITY = {
  shorting_items: 25,
  tracks_crossing: 25,
  unconnected_items: 25,
  starved_thermal: 2,
  solder_mask_bridge: 2,
  copper_edge_clearance: 2,
}
const DRC_SEVERITY_DEFAULT = 1
/** Weighted badness of a routed board: lower is better. */
function drcScore(drc, unrouted = 0) {
  const types = drc?.errorTypes || {}
  let n = 0
  for (const [t, c] of Object.entries(types)) n += c * (DRC_SEVERITY[t] ?? DRC_SEVERITY_DEFAULT)
  // A net the router never completed is the same class of wrong as one it
  // shorted — the netlist is not honoured either way. But once the count has
  // been reconciled against KiCad it IS `unconnected_items`, already weighted
  // in the loop above; adding it again would penalise the same fault twice.
  const already = types.unconnected_items ?? 0
  const extra = Math.max(0, (unrouted || 0) - already)
  return n + extra * DRC_SEVERITY.unconnected_items
}

const RESIDUAL_NUDGE_TYPES = new Set(['hole_clearance', 'clearance'])
// How many times the residual pass may re-sweep an already-improved board.
const RESIDUAL_NUDGE_SWEEPS = Number(process.env.FL_RESIDUAL_SWEEPS || 3)
// DRC classes that are NOT copper/electrical: library-vs-board footprint drift,
// text sizes, silkscreen. They are reported separately (drc.nonElectrical) and
// do not count toward `errors` / `converged` unless strict mode is on
// (input.strictDrc === true or FL_DRC_STRICT=1). Copper, hole, mask, courtyard
// and connectivity classes all stay electrical.
const NON_ELECTRICAL_DRC = /^(lib_footprint_issues|lib_footprint_mismatch|text_height|text_thickness|footprint_type_mismatch|silk_.*)$/
let STRICT_NON_ELECTRICAL = process.env.FL_DRC_STRICT === '1'

/** Split a KiCad DRC item list into the errors that count and the
 *  non-electrical ones reported separately. Returns { errs, nonElectrical }. */
function classifyDrcErrors(all) {
  const errs = [], nonElectrical = []
  for (const v of all) {
    if (v?.severity !== 'error') continue
    if (!STRICT_NON_ELECTRICAL && NON_ELECTRICAL_DRC.test(String(v.type || ''))) nonElectrical.push(v)
    else errs.push(v)
  }
  return { errs, nonElectrical }
}

/** Extract the Edge.Cuts bounding box from a .kicad_pcb string (gr_line /
 *  gr_poly / gr_circle / gr_arc / gr_rect blocks on Edge.Cuts). Returns
 *  [minX, minY, maxX, maxY] or null. Coordinates are KiCad mm (y down). */
function edgeCutsBbox(pcbText) {
  const xs = [], ys = []
  let i = 0
  while ((i = pcbText.indexOf('(gr_', i)) !== -1) {
    // paren-match the block so a gr_ block on another layer never bleeds in
    let depth = 0, j = i
    for (; j < pcbText.length; j++) {
      const ch = pcbText[j]
      if (ch === '(') depth++
      else if (ch === ')') { depth--; if (depth === 0) { j++; break } }
    }
    const block = pcbText.slice(i, j)
    i = j
    // KiCad writes the layer name UNQUOTED in board files it generates
    // ((layer Edge.Cuts)) but QUOTED in library/footprint contexts. Requiring
    // the quotes skipped every outline segment, so this returned null, so
    // mapDrcPositions could never map a violation, so the residual repair pass
    // fell back to moving the WHOLE board instead of the handful of offending
    // points — which regressed connectivity and was rejected every time.
    // Accept both spellings.
    if (!/\(layer\s+"?Edge\.Cuts"?\)/.test(block)) continue
    if (block.startsWith('(gr_circle')) {
      const c = block.match(/\(center\s+(-?[\d.]+)\s+(-?[\d.]+)\)/), e = block.match(/\(end\s+(-?[\d.]+)\s+(-?[\d.]+)\)/)
      if (c && e) { const r = Math.hypot(+e[1] - +c[1], +e[2] - +c[2]); xs.push(+c[1] - r, +c[1] + r); ys.push(+c[2] - r, +c[2] + r) }
      continue
    }
    for (const m of block.matchAll(/\((?:start|end|xy|mid)\s+(-?[\d.]+)\s+(-?[\d.]+)\)/g)) { xs.push(+m[1]); ys.push(+m[2]) }
  }
  if (!xs.length) return null
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/** Map KiCad-space DRC item positions back into circuit-json coordinates so the
 *  residual nudge can target JUST the offending copper. The converter's
 *  transform is a translation (board centred somewhere on the sheet) plus a
 *  possible y flip (KiCad is y-down, circuit-json y-up); the package is not
 *  introspected — instead both flips are tried against the Edge.Cuts bbox
 *  centre and VALIDATED: a mapped item position must land on real cj copper
 *  (via / track / pad / hole). The flip that validates wins; a tie (symmetric
 *  board) keeps the union — targeting only restricts which items move, so a
 *  superset is a safe fallback. Returns { mapped: boolean, points: [{type,x,y}] }. */
function mapDrcPositions(pcbText, cj, errs) {
  const board = cj.find((e) => e.type === 'pcb_board')
  const bbox = board ? edgeCutsBbox(pcbText) : null
  if (!bbox) return { mapped: false, points: [] }
  const ex = (bbox[0] + bbox[2]) / 2, ey = (bbox[1] + bbox[3]) / 2
  const bx = board.center?.x ?? 0, by = board.center?.y ?? 0
  // cj copper to validate against
  const pts = [] // vias + holes (x, y, r)
  const segs = []
  const boxes = []
  for (const e of cj) {
    if (e.type === 'pcb_via' && e.x != null) pts.push({ x: e.x, y: e.y, r: (e.outer_diameter ?? 0.4) / 2 })
    else if (e.type === 'pcb_hole' && e.x != null) pts.push({ x: e.x, y: e.y, r: (e.hole_diameter ?? 2.2) / 2 })
    else if (e.type === 'pcb_plated_hole' && e.x != null) pts.push({ x: e.x, y: e.y, r: (e.outer_diameter ?? e.hole_diameter ?? 0.6) / 2 })
    else if (e.type === 'pcb_smtpad' && e.x != null) boxes.push([e.x - (e.width || 0) / 2, e.y - (e.height || 0) / 2, e.x + (e.width || 0) / 2, e.y + (e.height || 0) / 2])
    else if (e.type === 'pcb_trace' && Array.isArray(e.route)) {
      for (let i = 0; i + 1 < e.route.length; i++) {
        const a = e.route[i], b = e.route[i + 1]
        if (a?.x == null || b?.x == null) continue
        segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, hw: Math.max(a.width || 0.15, b.width || 0.15) / 2 })
        if (a.route_type === 'via') pts.push({ x: a.x, y: a.y, r: (a.outer_diameter ?? 0.4) / 2 })
      }
    }
  }
  const TOL = 0.35
  const onCopper = (x, y) => {
    for (const p of pts) if (Math.hypot(x - p.x, y - p.y) <= p.r + TOL) return true
    for (const b of boxes) if (Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3])) <= TOL) return true
    for (const s of segs) {
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1, L2 = dx * dx + dy * dy
      const t = L2 ? Math.max(0, Math.min(1, ((x - s.x1) * dx + (y - s.y1) * dy) / L2)) : 0
      if (Math.hypot(x - (s.x1 + t * dx), y - (s.y1 + t * dy)) <= s.hw + TOL) return true
    }
    return false
  }
  // How far SHORT each violation falls, straight out of KiCad's own text
  // ("clearance 0.4000 mm; actual 0.3701 mm" -> 0.0299). The repair pass sizes
  // its first displacement from this: these are hundredths-of-a-millimetre
  // misses, and moving copper by a tenth of a millimetre to close a
  // three-hundredths gap is what used to break connectivity.
  const shortfallOf = (desc) => {
    const m = /clearance\s+([\d.]+)\s*mm;\s*actual\s+([\d.]+)\s*mm/i.exec(String(desc || ''))
    if (!m) return null
    const gap = +m[1] - +m[2]
    return Number.isFinite(gap) && gap > 0 ? +gap.toFixed(4) : null
  }
  const items = []
  for (const v of errs) for (const it of (v.items || [])) if (it?.pos && Number.isFinite(+it.pos.x) && Number.isFinite(+it.pos.y)) items.push({ type: v.type, kx: +it.pos.x, ky: +it.pos.y, shortfallMm: shortfallOf(v.description) })
  if (!items.length) return { mapped: false, points: [] }
  const tryFlip = (s) => {
    const out = items.map((it) => ({ type: it.type, x: +(it.kx - ex + bx).toFixed(4), y: +(s * (it.ky - ey) + by).toFixed(4), shortfallMm: it.shortfallMm }))
    return { out, hits: out.filter((p) => onCopper(p.x, p.y)).length }
  }
  const down = tryFlip(-1), up = tryFlip(1)
  const need = Math.max(1, Math.ceil(items.length * 0.6))
  const okDown = down.hits >= need, okUp = up.hits >= need
  if (!okDown && !okUp) return { mapped: false, points: [] }
  if (okDown && okUp && down.hits === up.hits) return { mapped: true, flip: 'both', points: [...down.out, ...up.out] }
  const win = (okDown && (!okUp || down.hits >= up.hits)) ? down : up
  return { mapped: true, flip: win === down ? 'y-down' : 'y-up', points: win.out }
}

/** Decorate every exported .kicad_pcb that carries our standalone mounting
 *  holes (NPTH, from pcb_hole elements) with the two things the raw converter
 *  output lacks:
 *   1. a local pad clearance (the fab's hole-to-copper rule + 0.05mm) — the NPTH
 *      pad is exactly hole-sized, and the ground-plane ZONE FILLER (pcbnew, which
 *      does NOT read the .kicad_dru) would otherwise pour GND copper to within
 *      its 0.2mm default of the hole, tripping the fab's hole_clearance rule at
 *      every mounting hole. The pad-local clearance makes the filler keep real
 *      hole-to-copper distance. Profile-aware (0.5mm standard / 0.4mm HDI): a
 *      fixed over-tight value would make DRC flag copper the REAL fab rule allows.
 *   2. a real F.CrtYd courtyard ring (hole radius + 0.5mm) so KiCad's courtyard
 *      DRC sees the screw-head keep-out and flags any part placed over it.
 *  Pure text pass on the exporter's output; a board with no NPTH holes is
 *  returned unchanged. */
function decorateMountingHoles(pcbString, holeClearanceMm = 0.5) {
  if (!/np_thru_hole/.test(pcbString)) return pcbString
  // Keepout margin over the fab's hole-to-copper rule. Measured: a +0.05mm margin
  // left the ground pour landing ~0.08mm INSIDE its target (fill honours the pad
  // clearance imperfectly), so an HDI board (0.4mm rule) came out at 0.37mm and
  // tripped hole_clearance by a hair — the single dominant residual across every
  // dense board. +0.2mm gives real headroom (0.6mm target → ~0.52mm actual on HDI)
  // so screw holes clear copper by construction. Pure keepout, post-routing: it
  // can only push fill AWAY from holes, never add a violation to a clean board.
  const cl = (holeClearanceMm + 0.2).toFixed(2)
  let out = pcbString.replace(
    /(\(pad "" np_thru_hole circle[\s\S]*?\(drill [\d.]+\))/g,
    (m) => (/\(clearance /.test(m) ? m : `${m}\n      (clearance ${cl})`),
  )
  out = out.replace(
    /(\(footprint\s*\n\s*"tscircuit:hole_circle_holeDiameter([\d.]+)mm"[\s\S]*?)(\n {2}\))/g,
    (m, body, dia, close) => {
      if (/F\.CrtYd/.test(body)) return m
      const r = +dia / 2 + 0.5
      const pts = []
      for (let i = 0; i < 32; i++) {
        const a = (2 * Math.PI * i) / 32
        pts.push(`(xy ${(r * Math.cos(a)).toFixed(3)} ${(r * Math.sin(a)).toFixed(3)})`)
      }
      const poly = `\n    (fp_poly\n      (pts ${pts.join(' ')})\n      (layer F.CrtYd)\n      (width 0.05)\n      (fill none)\n    )`
      return body + poly + close
    },
  )
  return out
}

/** kicad-cli's version can't change mid-run — probe it ONCE per process instead
 *  of spawning a whole `kicad-cli version` subprocess before every DRC. */
let KICAD_VER = null
function kicadVersion() {
  if (KICAD_VER && OPT) return KICAD_VER
  TIMINGS.counters.kicadVersionCalls++
  KICAD_VER = spawnSync(KICAD_CLI, ['version'], { encoding: 'utf8', timeout: 15000 }).stdout?.trim() || '?'
  return KICAD_VER
}

async function realDrc(cj, profileKey = 'standard') {
  const t0 = Date.now()
  TIMINGS.counters.kicadDrcRuns++
  const r = await realDrcInner(cj, profileKey)
  tAdd('realDrc', Date.now() - t0, r.available ? `${profileKey}, ${r.errors} errors` : 'unavailable')
  return r
}
async function realDrcInner(cj, profileKey = 'standard') {
  if (!KICAD_CLI) return { available: false, reason: 'kicad-cli not installed' }
  const profile = FAB_PROFILES[profileKey] || FAB_PROFILES.standard
  let dir
  try {
    const ver = kicadVersion()
    const { CircuitJsonToKicadPcbConverter } = await import('circuit-json-to-kicad')
    const conv = new CircuitJsonToKicadPcbConverter(cj)
    conv.runUntilFinished()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-drc-'))
    const pcbPath = path.join(dir, 'board.kicad_pcb')
    const drcPath = path.join(dir, 'drc.json')
    fs.writeFileSync(pcbPath, decorateMountingHoles(conv.getOutputString(), profile.holeClearance ?? 0.5))
    fs.writeFileSync(path.join(dir, 'board.kicad_dru'), profile.rules)
    const r = spawnSync(KICAD_CLI, ['pcb', 'drc', '--format', 'json', '--output', drcPath, pcbPath], { encoding: 'utf8', timeout: 120000 })
    if (!fs.existsSync(drcPath)) return { available: false, reason: 'drc produced no report', stderr: (r.stderr || '').slice(0, 200) }
    const rep = JSON.parse(fs.readFileSync(drcPath, 'utf8'))
    // FL_FR_DEBUG: keep each DRC run's board + report (numbered in call order,
    // correlate with the [t] realDrc stderr lines) for offline diagnosis of WHY
    // a strategy's copper fails DRC. Debug-only; no effect without the env var.
    if (process.env.FL_FR_DEBUG) {
      const dbg = path.join(process.env.FL_FR_DEBUG, `drc-run-${TIMINGS.counters.kicadDrcRuns}`)
      try { fs.mkdirSync(dbg, { recursive: true }); fs.copyFileSync(pcbPath, path.join(dbg, 'board.kicad_pcb')); fs.copyFileSync(drcPath, path.join(dbg, 'drc.json')) } catch { /* debug only */ }
    }
    const all = [...(rep.violations || []), ...(rep.unconnected_items || []), ...(rep.schematic_parity || [])]
    const { errs, nonElectrical } = classifyDrcErrors(all)
    const warns = all.filter((v) => v.severity === 'warning')
    const byType = {}
    for (const v of errs) byType[v.type] = (byType[v.type] || 0) + 1
    const neTypes = {}
    for (const v of nonElectrical) neTypes[v.type] = (neTypes[v.type] || 0) + 1
    // violation positions in cj coordinates (for the residual nudge); bounded
    // because this object is serialized to stdout and persisted with the board.
    const pos = mapDrcPositions(fs.readFileSync(pcbPath, 'utf8'), cj, errs)
    return {
      available: true,
      kicadVersion: ver,
      ruleProfile: profile.label,
      profileKey,
      // `errors` = the count that gates ok/converged: electrical + physical fab
      // classes only (see NON_ELECTRICAL_DRC). `errorsAll` is the raw KiCad
      // error count; `nonElectrical` is reported on its own. Additive fields —
      // consumers keyed on `errors` keep working.
      errors: errs.length,
      errorsAll: errs.length + nonElectrical.length,
      nonElectrical: { count: nonElectrical.length, types: neTypes, strict: STRICT_NON_ELECTRICAL },
      warnings: warns.length,
      errorTypes: byType,
      sample: errs.slice(0, 6).map((v) => `${v.type}: ${(v.description || '').slice(0, 90)}`),
      positionsMapped: pos.mapped,
      violations: pos.points.slice(0, 40),
    }
  } catch (e) {
    return { available: false, reason: String(e).slice(0, 160) }
  } finally {
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

import { synthFootprint, SYNTH_FAMILIES } from './footprints.mjs'

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
  // Through-hole pads too: headers, terminal blocks and TO-package tabs are
  // ordinary parts, and refusing them was the single most common reason a real
  // netlist bounced. These become <platedhole> rather than <smtpad>.
  const thtRe = /\(pad\s+(\S+)\s+thru_hole\s+\w+\s+\(at\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+-?[\d.]+)?\)\s+\(size\s+([\d.]+)\s+([\d.]+)\)\s+\(drill\s+([\d.]+)\)/g
  const holes = []
  let t
  while ((t = thtRe.exec(mod))) {
    holes.push({ n: t[1].replace(/"/g, ''), x: +t[2], y: -+t[3], d: +t[4], drill: +t[6] })
  }
  const pads = []
  let m
  // pad names are quoted in KiCad-library .kicad_mod (`(pad "1" smd ...)`) but
  // bare in easyeda2kicad output — strip quotes so BOTH parse (a quoted name left
  // in produced portHints={[""1""...]}, breaking the generated JSX).
  while ((m = re.exec(mod))) pads.push({ n: m[1].replace(/"/g, ''), x: +m[2], y: -+m[3], w: +m[4], h: +m[5] })
  if (!pads.length && !holes.length) return null
  // Bounding box spans BOTH pad kinds, so a header's board area is honest.
  const xs = [...pads.map((p) => [p.x - p.w / 2, p.x + p.w / 2]), ...holes.map((h) => [h.x - h.d / 2, h.x + h.d / 2])].flat()
  const ys = [...pads.map((p) => [p.y - p.h / 2, p.y + p.h / 2]), ...holes.map((h) => [h.y - h.d / 2, h.y + h.d / 2])].flat()
  const maxX = Math.max(...xs), minX = Math.min(...xs)
  const maxY = Math.max(...ys), minY = Math.min(...ys)
  const jsx = '<footprint>'
    + pads.map((p) =>
      `<smtpad portHints={["${p.n}","pin${p.n}"]} pcbX="${p.x.toFixed(3)}mm" pcbY="${p.y.toFixed(3)}mm" width="${p.w}mm" height="${p.h}mm" shape="rect" />`).join('')
    + holes.map((h) =>
      `<platedhole portHints={["${h.n}","pin${h.n}"]} pcbX="${h.x.toFixed(3)}mm" pcbY="${h.y.toFixed(3)}mm" shape="circle" holeDiameter="${h.drill}mm" outerDiameter="${h.d}mm" />`).join('')
    + '</footprint>'
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
function emitBoardCode(placed, nets, { clearance = null, routingDisabled = false, numLayers = 2 } = {}) {
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
  // routingDisabled: skip the built-in autorouter entirely. Used for boards whose
  // routing is thrown away anyway — the freerouting path strips every pcb_trace/
  // pcb_via before exporting the DSN, and the net-aware-placement probe only reads
  // pad offsets + courtyards. Pads, ports, source_traces and courtyards are all
  // still emitted (verified); only the discarded copper is skipped.
  const rd = routingDisabled ? ' routingDisabled={true}' : ''
  // Multi-layer for the BUILT-IN router. tscircuit's own autorouter routes on
  // inner copper (verified: layers={4} → traces land on inner1/inner2), and it
  // works entirely in circuit-json space, so its export carries NO DSN-converter
  // parity problem (unlike freerouting). Giving it 4/6 layers spreads the
  // via-to-track congestion that leaves a dense 2-layer board with residual
  // hole_clearance nits it can't nudge away. Only emitted when >2 so 2-layer
  // boards are byte-identical to before.
  // Multi-layer via geometry. tscircuit's default multi-layer via shrinks its
  // INNER-layer pads (measured: 0.4mm outer / 0.3mm inner over a 0.2mm drill =
  // 0.05mm inner annular, under the 0.075mm rule → annular_width errors). Pin the
  // via pad at 0.5mm / drill 0.25mm so every layer's annular is (0.5-0.25)/2 =
  // 0.125mm, clear by construction. Bigger PAD doesn't worsen hole_clearance
  // (that's drill-to-copper). Only for >2 layers so 2-layer boards are unchanged.
  const via = numLayers > 2 ? ' viaPadDiameter="0.5mm" viaHoleDiameter="0.25mm"' : ''
  const lyr = numLayers > 2 ? ` layers={${numLayers}}` : ''
  return `export default () => (\n  <board autorouter="auto"${lyr}${via}${tol}${rd}>\n${comps.join('\n')}\n${traces.join('\n')}\n  </board>\n)`
}

/** parts + nets -> tscircuit code (positions computed here, not by the LLM). */
function buildCode(parts, nets, { maxW = 15, gap = 2.1, singleSided = false, clearance = null, routingDisabled = false, numLayers = 2 } = {}) {
  // resolve real LCSC footprints (from part.kicadMod) before placement/sizing
  for (const p of parts) p._fp = p.kicadMod ? kicadModToFootprint(p.kicadMod) : null
  return emitBoardCode(place(parts, maxW, gap, singleSided, nets), nets, { clearance, routingDisabled, numLayers })
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
  // The probe board only feeds pin-offset + courtyard extraction — its routed
  // copper is never used, so skip the built-in autoroute (routingDisabled).
  try { cj0 = await buildCircuit(emitBoardCode(initPlaced, nets, { routingDisabled: OPT }), 'netAwarePlace probe') } catch { return null }
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

  // ---- exact spatial index -------------------------------------------------
  // The pairwise spacing / overlap sweeps below are O(parts^2), and SA runs them
  // 6000 times per seed — fine at 25 parts, fatal at 200. A uniform grid over
  // part CENTRES replaces the sweep, and it is EXACT, not a proximity heuristic:
  //   gapBetween() = max(sepX, sepY) with sepX = |dx| - (w_i + w_j)/2, so two
  //   parts can only be closer than `reach` when BOTH |dx| and |dy| are under
  //   (w_i + w_j)/2 + reach. Every part's courtyard is at most `maxExtent` on
  //   either side in EITHER orientation, so (w_i + w_j)/2 <= maxExtent and any
  //   interacting pair is within maxExtent + reach on both axes. Sizing a cell
  //   at exactly that bound puts such a pair in the same cell or an adjacent
  //   one, so scanning the 3x3 neighbourhood provably misses NOTHING. A smaller
  //   cell would NOT be safe; a larger one only adds no-op candidates.
  // maxExtent takes max(w, h) per part so it bounds all four rotations.
  let maxExtent = 0
  for (const p of initPlaced) { const [cw, ch] = courtyard[p.name] || partSize(p); maxExtent = Math.max(maxExtent, cw, ch) }
  // The ±1-cell proof is in exact arithmetic; Math.floor(x / cell) can straddle
  // an integer when |dx| sits within a few ulps of `cell`, so pad the cell by a
  // relative epsilon. Padding can only widen the candidate set, never shrink it.
  const gridCell = (reach) => (maxExtent + reach) * (1 + 1e-9) || 1
  // The grid only PAYS when it actually partitions. Because the cell has to
  // bound the largest courtyard, one outsized part (a 30mm connector among
  // 0402s) forces a cell as wide as the whole board and drops every part into
  // a handful of cells — the 3x3 scan then returns nearly everything and the
  // bookkeeping is pure overhead. Below this many occupied cells the sweeps
  // keep the plain pairwise loop. Both paths visit the same interacting pairs
  // in the same order; this only picks the cheaper one.
  // 36 = 4x the 9 cells a query touches, i.e. the grid must prune at least ~4x
  // before it's worth the bookkeeping (measured: below that it's a wash).
  const GRID_MIN_CELLS = 36
  // Grid over a LIVE states array: buckets hold indices and are updated in place
  // by move(i), so every query reads current positions (the legalize/compact
  // sweeps mutate parts mid-pass and must still see an exact neighbourhood).
  const makeGrid = (states, reach) => {
    const cell = gridCell(reach)
    const buckets = new Map()
    const keys = new Array(states.length)
    const add = (i) => {
      const k = `${Math.floor(states[i].x / cell)}|${Math.floor(states[i].y / cell)}`
      keys[i] = k
      let b = buckets.get(k); if (!b) buckets.set(k, b = []); b.push(i)
    }
    const del = (i) => { const b = buckets.get(keys[i]); if (b) { const at = b.indexOf(i); if (at >= 0) b.splice(at, 1) } }
    for (let i = 0; i < states.length; i++) add(i)
    return {
      cells: buckets.size,
      move: (i) => { del(i); add(i) }, // call AFTER the state's x/y is updated
      near: (x, y, out) => {
        out.length = 0
        const gx = Math.floor(x / cell), gy = Math.floor(y / cell)
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const b = buckets.get(`${gx + dx}|${gy + dy}`)
          if (b) for (let t = 0; t < b.length; t++) out.push(b[t])
        }
        return out
      },
    }
  }
  // Net adjacency index: for every part, the net endpoints that touch it
  // ([otherPartIndex, myPin, otherPin]), so an SA move can rescore just that
  // part's nets instead of every net on the board. Built from initPlaced, whose
  // ORDER every derived states array preserves (legalize/compact both .map()).
  // Map lookups mirror `states.find()` by keeping the FIRST part of a duplicate
  // name, and skip endpoints with no matching part exactly like cost() does.
  const nameIdx = new Map()
  initPlaced.forEach((p, i) => { if (!nameIdx.has(p.name)) nameIdx.set(p.name, i) })
  const netAdj = initPlaced.map(() => [])
  for (const [a, b] of nets) {
    const [ca, pa] = String(a).split('.'), [cb, pb] = String(b).split('.')
    const ia = nameIdx.get(ca), ib = nameIdx.get(cb)
    if (ia === undefined || ib === undefined) continue
    netAdj[ia].push([ib, pa || '1', pb || '1'])
    if (ib !== ia) netAdj[ib].push([ia, pb || '1', pa || '1']) // self-nets counted once
  }

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
    // A pair only pushes when |dx| < (wi+wj)/2 + MIN_CLEAR, so reach = MIN_CLEAR
    // is the exact grid bound for this sweep (see the spatial-index note above).
    const probe = makeGrid(states, MIN_CLEAR)
    const grid = probe.cells >= GRID_MIN_CELLS ? probe : null
    const nb = [], cands = []
    // Candidates > after, in ASCENDING index order, so the pair order and the
    // in-sweep mutations are identical to the original i<j double loop. Both
    // arrays are reused (this runs per part per sweep — no allocation here).
    const above = (i, after) => {
      const near = grid.near(states[i].x, states[i].y, nb)
      cands.length = 0
      for (let t = 0; t < near.length; t++) if (near[t] > after) cands.push(near[t])
      for (let a = 1; a < cands.length; a++) { const v = cands[a]; let b = a - 1; while (b >= 0 && cands[b] > v) { cands[b + 1] = cands[b]; b-- } cands[b + 1] = v }
      return cands
    }
    // One (i, j) pair: push them apart along the least-penetration axis if their
    // courtyards overlap or sit inside the clearance. Returns whether it pushed.
    const pushPair = (i, j) => {
      const [wi, hi] = size(states[i]), [wj, hj] = size(states[j])
      const dx = states[j].x - states[i].x, dy = states[j].y - states[i].y
      const ox = (wi + wj) / 2 + MIN_CLEAR - Math.abs(dx)
      const oy = (hi + hj) / 2 + MIN_CLEAR - Math.abs(dy)
      if (!(ox > 0 && oy > 0)) return false
      if (ox <= oy) { const push = ox / 2 + 1e-3, s = dx >= 0 ? 1 : -1; states[i].x -= s * push; states[j].x += s * push }
      else { const push = oy / 2 + 1e-3, s = dy >= 0 ? 1 : -1; states[i].y -= s * push; states[j].y += s * push }
      return true
    }
    for (let iter = 0; iter < 400; iter++) {
      let moved = false
      for (let i = 0; i < states.length; i++) {
        if (!grid) { // grid can't partition this layout — plain pairwise sweep
          for (let j = i + 1; j < states.length; j++) if (pushPair(i, j)) moved = true
          continue
        }
        above(i, i)
        let at = 0
        while (at < cands.length) {
          const j = cands[at]
          if (pushPair(i, j)) {
            moved = true
            grid.move(i); grid.move(j)
            // i just moved, so its neighbourhood changed — re-query it (still
            // only ahead of j, matching the brute-force loop's forward scan).
            above(i, j); at = 0
          } else at++
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
    // routeClear (not TARGET) is this sweep's reach — it can exceed TARGET on
    // net-dense boards, and the cell must bound the LARGEST interaction radius.
    const probe = makeGrid(states, routeClear)
    const grid = probe.cells >= GRID_MIN_CELLS ? probe : null
    const nb = []
    const clashes = (si) => {
      const box = aabb(states[si])
      if (!grid) return states.some((o, j) => j !== si && gapBetween(box, aabb(o)) < routeClear)
      const near = grid.near(states[si].x, states[si].y, nb)
      for (let t = 0; t < near.length; t++) { const j = near[t]; if (j !== si && gapBetween(box, aabb(states[j])) < routeClear) return true }
      return false
    }
    for (let iter = 0; iter < 120; iter++) {
      let moved = false
      for (let si = 0; si < states.length; si++) {
        const s = states[si]
        const ox = s.x, oy = s.y
        s.x += (cx - s.x) * 0.12; s.y += (cy - s.y) * 0.12
        grid?.move(si)
        if (clashes(si)) { s.x = ox; s.y = oy; grid?.move(si) } else if (Math.abs(s.x - ox) + Math.abs(s.y - oy) > 0.02) moved = true
      }
      if (!moved) break
    }
    return states
  }
  // name -> state, rebuilt per states array. Keeps the FIRST entry for a
  // duplicate name so it resolves exactly like the states.find() it replaces.
  const byNameMap = (states) => { const m = new Map(); for (const s of states) if (!m.has(s.name)) m.set(s.name, s); return m }
  const cost = (states) => {
    const byName = byNameMap(states)
    let wl = 0
    for (const [a, b] of nets) { const [ca, pa] = String(a).split('.'), [cb, pb] = String(b).split('.'); const A = byName.get(ca), B = byName.get(cb); if (!A || !B) continue; const pA = pinPos(A, pa || '1'), pB = pinPos(B, pb || '1'); wl += Math.hypot(pA[0] - pB[0], pA[1] - pB[1]) }
    let sp = 0
    // Grid-accelerated pairwise spacing. Neighbours are filtered to j > i and
    // sorted, so pairs accumulate in the SAME order as the old double loop and
    // the sum is bit-for-bit identical (skipped pairs have g >= TARGET, which
    // the old loop added nothing for either).
    const probe = makeGrid(states, TARGET), grid = probe.cells >= GRID_MIN_CELLS ? probe : null
    const nb = []
    for (let i = 0; i < states.length; i++) {
      const box = aabb(states[i])
      if (!grid) { for (let j = i + 1; j < states.length; j++) { const g = gapBetween(box, aabb(states[j])); if (g < TARGET) sp += (TARGET - g) ** 2 } ; continue }
      const near = grid.near(states[i].x, states[i].y, nb).filter((j) => j > i).sort((x, y) => x - y)
      for (const j of near) { const g = gapBetween(box, aabb(states[j])); if (g < TARGET) sp += (TARGET - g) ** 2 }
    }
    return wl + sp * 20
  }
  // One SA run from a given seed (positions + rotations); returns placed parts.
  const saOptimize = (seedInit) => {
    let seed = seedInit
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    // `cur` is never reassigned — the grid below indexes it by reference.
    const cur = initPlaced.map((p) => ({ ...p, x: p.pcbX, y: p.pcbY, rot: 0 }))
    let curCost = cost(cur), best = cur.map((p) => ({ ...p })), bestCost = curCost
    // Incremental scoring: a candidate move/rotation touches exactly ONE part,
    // so only that part's nets and its pairwise spacing terms change. Rescore
    // just those (grid-bounded, hence O(1) neighbours) instead of the whole
    // O(nets + parts^2) cost — the difference is what makes 200 parts tractable.
    const probe = makeGrid(cur, TARGET), grid = probe.cells >= GRID_MIN_CELLS ? probe : null
    const nb = []
    const wlOf = (i, sti) => { // sti stands in for cur[i]; self-nets use it for both ends
      let wl = 0
      for (const [j, mp, op] of netAdj[i]) {
        const pA = pinPos(sti, mp), pB = pinPos(j === i ? sti : cur[j], op)
        wl += Math.hypot(pA[0] - pB[0], pA[1] - pB[1])
      }
      return wl
    }
    const spOf = (i, sti) => { // every OTHER part is at its current position
      const box = aabb(sti)
      let sp = 0
      if (!grid) { // grid can't partition — still only ONE part's pairs, not all of them
        for (let j = 0; j < cur.length; j++) { if (j === i) continue; const g = gapBetween(box, aabb(cur[j])); if (g < TARGET) sp += (TARGET - g) ** 2 }
        return sp
      }
      const near = grid.near(sti.x, sti.y, nb)
      for (let t = 0; t < near.length; t++) {
        const j = near[t]; if (j === i) continue
        const g = gapBetween(box, aabb(cur[j])); if (g < TARGET) sp += (TARGET - g) ** 2
      }
      return sp
    }
    let accepted = 0
    const STEPS = 6000
    for (let step = 0; step < STEPS; step++) {
      const T = 8 * (1 - step / STEPS) + 0.05
      const i = Math.floor(rnd() * cur.length)
      const st = { ...cur[i] }
      if (rnd() < 0.3) st.rot = [0, 90, 180, 270][Math.floor(rnd() * 4)]
      else { st.x += (rnd() - 0.5) * T; st.y += (rnd() - 0.5) * T }
      const cc = curCost + (wlOf(i, st) - wlOf(i, cur[i])) + (spOf(i, st) - spOf(i, cur[i])) * 20
      if (cc < curCost || rnd() < Math.exp((curCost - cc) / (T * 0.3))) {
        cur[i] = st; grid?.move(i); curCost = cc
        if (cc < bestCost) { best = cur.map((p) => ({ ...p })); bestCost = cc }
        // Summing deltas accumulates float drift; resync off a full recompute
        // periodically so curCost can't wander away from the true cost.
        if (++accepted % 512 === 0) curCost = cost(cur)
      }
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
  const allVias = cj.filter((e) => e.type === 'pcb_via')
  if (process.env.FL_FR_DEBUG) process.stderr.write(`[fabRepair] ${allVias.length} pcb_via in cj; sizes: ${JSON.stringify(allVias.map((v) => v.outer_diameter))}\n`)
  for (const e of cj) {
    if (e.type === 'pcb_via') {
      if ((e.outer_diameter ?? 0) < pad) { e.outer_diameter = pad; vias++ }
      if ((e.hole_diameter ?? 1) > hole) e.hole_diameter = hole
    }
    // Multi-layer transition vias live INSIDE the trace route as route_type:'via'
    // points (circuit-json-to-kicad exports these separately from standalone
    // pcb_via). They default to 0.3mm pad → 0.05mm annular → annular_width DRC
    // failures on every multi-layer board. The standalone-via loop above never
    // sees them, so normalize them here to the same fab-profile geometry.
    else if (e.type === 'pcb_trace' && Array.isArray(e.route)) {
      for (const p of e.route) {
        if (p.route_type !== 'via') continue
        if ((p.outer_diameter ?? 0) < pad) { p.outer_diameter = pad; vias++ }
        if ((p.hole_diameter ?? 1) > hole) p.hole_diameter = hole
      }
    }
  }
  if (vias) fixes.push(`enlarged ${vias} via${vias === 1 ? '' : 's'} to ${pad}mm pad / ${hole}mm hole`)
  const board = cj.find((e) => e.type === 'pcb_board')
  if (board) {
    board.width += 1.2; board.height += 1.2; fixes.push('added 0.6mm board-edge copper margin')
    // circuit-json-to-kicad inserts a via wherever a routed trace changes layer,
    // sized from board.min_via_pad_diameter (DEFAULT 0.3mm → 0.05mm annular over a
    // 0.2mm drill → annular_width DRC failures on multi-layer boards). fabRepair's
    // loop can't catch these: they don't exist in the cj, only in the export. Pin
    // the board's min via geometry to the fab profile so the auto-vias clear the
    // annular rule by construction. Harmless on 2-layer boards (no transitions).
    board.min_via_pad_diameter = pad
    board.min_via_hole_diameter = hole
  }
  return fixes
}

/** Board features pass — circular outline + mounting provisions. Runs AFTER
 *  routing, on the final circuit JSON, and only ever mutates geometry the
 *  router never touches:
 *   - boardShape {type:'circle', marginMm?}: the board outline becomes a real
 *     64-segment circle whose diameter circumscribes the packed rectangular
 *     copper extent (diagonal + margin) — every courtyard/pad/trace/via is
 *     inside the circle BY CONSTRUCTION, so routing quality is unchanged (the
 *     copper simply lives in the circle's inscribed rectangle). Parts are never
 *     moved; if anything somehow sticks out the diameter GROWS (honest: the
 *     reported diameter is the as-built one). pcb_board.outline drives
 *     Edge.Cuts in every KiCad export, so real DRC runs against the circle.
 *   - mountingHoles {count, holeDiaMm, boltCircleDiaMm?}: N non-plated screw
 *     holes (pcb_hole -> NPTH pads in the KiCad export) evenly on a bolt circle
 *     (circle boards) or at the 4 corners (rect boards). Collision-checked
 *     against every courtyard, pad, via and routed trace segment; a colliding
 *     bolt pattern is rotated up to 45°, then the board grows — holes NEVER
 *     overlap parts or copper, and the final DRC re-runs with the holes in the
 *     board so hole_clearance is really checked.
 *  Returns { boardShape, mountingHoles, notes } (mounting holes in
 *  board-centered mm, +x right / +y up), or null when neither feature was
 *  requested (or there is no board). */
function applyBoardFeatures(cj, input, profileKey = 'standard') {
  const wantCircle = input.boardShape?.type === 'circle'
  const mhIn = input.mountingHoles
  const wantHoles = mhIn && Number(mhIn.count) > 0
  const board = cj.find((e) => e.type === 'pcb_board')
  if (!board || (!wantCircle && !wantHoles)) return null
  const notes = []

  // ---- obstacle geometry: everything a hole must clear / the circle must contain
  const boxes = [] // AABBs: courtyards, pads, vias, plated holes
  for (const e of cj) {
    if (e.type === 'pcb_courtyard_outline' && e.outline?.length) {
      const xs = e.outline.map((p) => p.x), ys = e.outline.map((p) => p.y)
      boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])
    } else if (e.type === 'pcb_courtyard_rect' && e.center) {
      boxes.push([e.center.x - e.width / 2, e.center.y - e.height / 2, e.center.x + e.width / 2, e.center.y + e.height / 2])
    } else if (e.type === 'pcb_smtpad' && e.x != null) {
      const w = e.width || 0, h = e.height || 0
      boxes.push([e.x - w / 2, e.y - h / 2, e.x + w / 2, e.y + h / 2])
    } else if ((e.type === 'pcb_via' || e.type === 'pcb_plated_hole') && e.x != null) {
      const r = (e.outer_diameter || e.hole_diameter || 0.6) / 2
      boxes.push([e.x - r, e.y - r, e.x + r, e.y + r])
    }
  }
  const segs = [] // routed copper segments [x1,y1,x2,y2,halfWidth]
  for (const t of cj) {
    if (t.type !== 'pcb_trace' || !Array.isArray(t.route)) continue
    for (let i = 0; i + 1 < t.route.length; i++) {
      const a = t.route[i], b = t.route[i + 1]
      if (a?.x == null || b?.x == null) continue
      segs.push([a.x, a.y, b.x, b.y, Math.max(a.width || 0.15, b.width || 0.15) / 2])
    }
  }
  const distToBox = (x, y, b) => Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3]))
  const distToSeg = (x, y, [x1, y1, x2, y2]) => {
    const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy
    const t = L2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / L2)) : 0
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
  }
  const clearAt = (x, y, need) => {
    for (const b of boxes) if (distToBox(x, y, b) < need) return false
    for (const s of segs) if (distToSeg(x, y, s) < need + s[4]) return false
    return true
  }

  // Packed copper extent (falls back to the board rect when the board is empty)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const b of boxes) { minX = Math.min(minX, b[0]); minY = Math.min(minY, b[1]); maxX = Math.max(maxX, b[2]); maxY = Math.max(maxY, b[3]) }
  for (const s of segs) {
    minX = Math.min(minX, s[0] - s[4], s[2] - s[4]); maxX = Math.max(maxX, s[0] + s[4], s[2] + s[4])
    minY = Math.min(minY, s[1] - s[4], s[3] - s[4]); maxY = Math.max(maxY, s[1] + s[4], s[3] + s[4])
  }
  if (!isFinite(minX)) {
    minX = (board.center?.x ?? 0) - board.width / 2; maxX = (board.center?.x ?? 0) + board.width / 2
    minY = (board.center?.y ?? 0) - board.height / 2; maxY = (board.center?.y ?? 0) + board.height / 2
  }

  const holeClearance = (FAB_PROFILES[profileKey] || FAB_PROFILES.standard).holeClearance ?? 0.5
  const holeDia = wantHoles ? (Number(mhIn.holeDiaMm) > 0 ? Number(mhIn.holeDiaMm) : 2.2) : 2.2
  const holeR = holeDia / 2
  const need = holeR + holeClearance + 0.1 // hole center -> nearest copper/courtyard
  const count = wantHoles ? Math.max(1, Math.min(12, Math.round(Number(mhIn.count)))) : 0

  let boardShape = { type: 'rect' }
  let holes = [] // absolute [x,y]
  let cx, cy

  if (wantCircle) {
    // circle center = center of the packed extent; diameter = its diagonal + margin
    cx = (minX + maxX) / 2; cy = (minY + maxY) / 2
    const margin = Number(input.boardShape?.marginMm) > 0 ? Number(input.boardShape.marginMm) : 2
    let dia = Math.hypot(maxX - minX, maxY - minY) + margin
    // guard: if any copper corner still sticks out (it can't, by construction,
    // but never trust construction over measurement), grow to the real max
    // radius + edge margin. The reported diameter is always the as-built one.
    let maxR = 0
    for (const b of boxes) for (const [px, py] of [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]]) maxR = Math.max(maxR, Math.hypot(px - cx, py - cy))
    for (const s of segs) maxR = Math.max(maxR, Math.hypot(s[0] - cx, s[1] - cy) + s[4], Math.hypot(s[2] - cx, s[3] - cy) + s[4])
    if (2 * (maxR + margin / 2) > dia) { dia = 2 * (maxR + margin / 2); notes.push('grew circle to contain all courtyards/copper') }

    if (count) {
      // bolt circle default: comfortably inside the rim (hole edge >=~2mm of board)
      let boltFixed = Number(mhIn.boltCircleDiaMm) > 0 ? Number(mhIn.boltCircleDiaMm) : null
      const RIM = holeR + 0.75 // min hole-center -> board-edge
      let placed = null
      for (let grow = 0; grow < 400 && !placed; grow++) {
        const d = dia + grow * 0.5
        const bolt = boltFixed ?? (d - 2 * (holeDia + 2)) // default bolt circle: board Ø − 2×(holeØ+2mm)
        if (bolt <= holeDia || bolt / 2 + RIM > d / 2) continue // holes wouldn't fit inside this board
        for (let rotDeg = 0; rotDeg <= 45 && !placed; rotDeg += 5) {
          const pos = []
          for (let k = 0; k < count; k++) {
            const a = ((-90 + rotDeg + (k * 360) / count) * Math.PI) / 180
            pos.push([cx + (bolt / 2) * Math.cos(a), cy + (bolt / 2) * Math.sin(a)])
          }
          if (pos.every(([x, y]) => clearAt(x, y, need))) placed = { pos, bolt, rotDeg, d }
        }
        // a FIXED bolt circle can never be relieved by growing the board —
        // fall back to the auto bolt circle (and say so) instead of looping.
        if (!placed && boltFixed != null) { notes.push(`requested bolt circle Ø${boltFixed}mm collides with parts — using auto bolt circle`); boltFixed = null }
      }
      if (placed) {
        if (placed.d > dia + 1e-9) notes.push(`grew board Ø${dia.toFixed(1)}→Ø${placed.d.toFixed(1)}mm so mounting holes clear all parts`)
        if (placed.rotDeg) notes.push(`rotated bolt pattern ${placed.rotDeg}° to clear parts`)
        dia = placed.d
        holes = placed.pos
        boardShape = { type: 'circle', diameterMm: +dia.toFixed(2), boltCircleDiaMm: +placed.bolt.toFixed(2) }
      } else {
        notes.push('mounting holes could NOT be placed without collision — omitted (reported, not faked)')
        boardShape = { type: 'circle', diameterMm: +dia.toFixed(2) }
      }
    } else {
      boardShape = { type: 'circle', diameterMm: +dia.toFixed(2) }
    }

    // commit the circle: honest square bbox (w=h=diameter) + real polygon outline
    const R = (boardShape.diameterMm) / 2
    board.center = { x: +cx.toFixed(3), y: +cy.toFixed(3) }
    board.width = boardShape.diameterMm
    board.height = boardShape.diameterMm
    const N = 64, outline = []
    for (let i = 0; i < N; i++) {
      const a = (2 * Math.PI * i) / N
      outline.push({ x: +(cx + R * Math.cos(a)).toFixed(3), y: +(cy + R * Math.sin(a)).toFixed(3) })
    }
    board.outline = outline
  } else {
    // rect board: mounting holes at the corners; grow the board if a corner collides
    cx = board.center?.x ?? (minX + maxX) / 2
    cy = board.center?.y ?? (minY + maxY) / 2
    if (count) {
      const inset = holeR + 1.5 // hole center in from each board edge (1.5mm rim)
      let placed = null
      for (let grow = 0; grow < 400 && !placed; grow++) {
        const w = board.width + grow * 0.5, h = board.height + grow * 0.5
        const corners = [
          [cx - w / 2 + inset, cy + h / 2 - inset], [cx + w / 2 - inset, cy + h / 2 - inset],
          [cx + w / 2 - inset, cy - h / 2 + inset], [cx - w / 2 + inset, cy - h / 2 + inset],
        ].slice(0, Math.min(count, 4))
        if (corners.every(([x, y]) => clearAt(x, y, need))) placed = { corners, w, h }
      }
      if (placed) {
        if (placed.w > board.width + 1e-9) notes.push(`grew board ${board.width.toFixed(1)}×${board.height.toFixed(1)}→${placed.w.toFixed(1)}×${placed.h.toFixed(1)}mm so corner mounting holes clear all parts`)
        if (count > 4) notes.push(`rect board carries 4 corner holes (requested ${count})`)
        board.width = +placed.w.toFixed(2)
        board.height = +placed.h.toFixed(2)
        holes = placed.corners
      } else {
        notes.push('mounting holes could NOT be placed without collision — omitted (reported, not faked)')
      }
    }
  }

  // real NPTH drills: standalone pcb_hole elements -> NPTH pads in every KiCad export
  holes.forEach(([x, y], i) => {
    cj.push({ type: 'pcb_hole', pcb_hole_id: `pcb_hole_mount_${i + 1}`, hole_shape: 'circle', hole_diameter: holeDia, x: +x.toFixed(3), y: +y.toFixed(3) })
  })

  return {
    boardShape,
    mountingHoles: holes.map(([x, y]) => ({ x: +(x - cx).toFixed(2), y: +(y - cy).toFixed(2), diaMm: holeDia })),
    notes,
  }
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
function legalizeVias(cj, { minClear = FAB_PROFILES.standard.holeClearance + LEGALIZE_MARGIN_MM, maxDisp = 0.4, iters = 80, targets = null, targetR = RESIDUAL_NUDGE_TARGET_R } = {}) {
  const standalone = cj.filter((e) => e.type === 'pcb_via')
  // optional targeting (residual nudge): only vias within targetR of a DRC
  // violation position are allowed to move; everything else stays put.
  const nearTarget = (x, y) => !targets || targets.some((t) => Math.hypot(x - t.x, y - t.y) <= targetR)
  const traces = cj.filter((e) => e.type === 'pcb_trace')
  // Unified MOVABLE via set. A via can live two ways: as a standalone pcb_via, OR
  // as a route_type:'via' POINT inside a trace's route (how tscircuit's multi-layer
  // router emits its layer transitions). The old pass only saw standalone vias, so
  // on a 4/6-layer built-in board — where every transition via is a route point —
  // it moved nothing and the via-to-track hole_clearance nits (the last residual on
  // an otherwise clean dense board) were untouchable. Each mover exposes position,
  // net, radius and a setter that moves the route point AND any co-located
  // standalone via together, so downstream copper stays consistent either way.
  const netOfTrace = (t) => t.subcircuit_connectivity_map_key
  const movers = []
  const claimed = new Set()
  for (const t of traces) {
    if (!Array.isArray(t.route)) continue
    for (const p of t.route) {
      if (p.route_type !== 'via') continue
      const sv = standalone.find((v) => Math.abs(v.x - p.x) < 1e-3 && Math.abs(v.y - p.y) < 1e-3)
      if (sv) claimed.add(sv)
      movers.push({ p, sv, net: netOfTrace(t), r: (p.outer_diameter ?? sv?.outer_diameter ?? 0.4) / 2, fixed: !nearTarget(p.x, p.y) })
    }
  }
  for (const v of standalone) {
    if (claimed.has(v)) continue
    movers.push({ p: v, sv: null, net: v.subcircuit_connectivity_map_key, r: (v.outer_diameter ?? 0.4) / 2, fixed: !nearTarget(v.x, v.y) })
  }
  if (!movers.length || movers.every((m) => m.fixed)) return { moved: 0 }
  const net = (m) => m.net
  // mounting holes (NPTH) count as pad copper keep-outs too, padded by the fab's
  // hole-to-copper rule — otherwise this pass could nudge a via INTO a hole it
  // was never near.
  const pads = [
    ...cj.filter((e) => e.type === 'pcb_smtpad'),
    ...cj.filter((e) => e.type === 'pcb_hole').map((h) => ({ x: h.x, y: h.y, width: (h.hole_diameter || 2.2) + 1.0, height: (h.hole_diameter || 2.2) + 1.0 })),
  ]
  const orig = new Map(movers.map((m) => [m, { x: m.p.x, y: m.p.y }]))
  const padBox = (p) => [p.x - (p.width || 0) / 2, p.y - (p.height || 0) / 2, p.x + (p.width || 0) / 2, p.y + (p.height || 0) / 2]
  const gapToBox = (x, y, r, b) => Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3])) - r
  // Other-net TRACE segments — the obstacle class this pass was missing. It nudged
  // vias off other-net vias and pads but never off other-net TRACKS, so a via could
  // sit inside the fab's hole_clearance of a neighbouring trace (measured: a via
  // 0.369mm from a track vs the 0.4mm HDI rule — the exact residual that left an
  // otherwise fully-routed board one error short). Same-net segments are never
  // pushed off (that copper is part of the via's own connection).
  const segs = []
  for (const t of traces) {
    if (!Array.isArray(t.route)) continue
    const tn = t.subcircuit_connectivity_map_key
    for (let i = 0; i + 1 < t.route.length; i++) {
      const a = t.route[i], b = t.route[i + 1]
      if (a?.x == null || b?.x == null) continue
      segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, hw: Math.max(a.width || 0.15, b.width || 0.15) / 2, net: tn })
    }
  }
  const closestOnSeg = (x, y, s) => {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1, L2 = dx * dx + dy * dy
    const t = L2 ? Math.max(0, Math.min(1, ((x - s.x1) * dx + (y - s.y1) * dy) / L2)) : 0
    return [s.x1 + t * dx, s.y1 + t * dy]
  }
  for (let it = 0; it < iters; it++) {
    let any = false
    for (const m of movers) {
      if (m.fixed) continue // outside the nudge target radius — still an obstacle, never a mover
      const r = m.r, vx = m.p.x, vy = m.p.y
      let px = 0, py = 0
      for (const o of movers) { // other-net via copper
        if (o === m || net(o) === net(m)) continue
        const dx = vx - o.p.x, dy = vy - o.p.y, d = Math.hypot(dx, dy) || 1e-6
        const need = r + o.r + minClear
        if (d < need) { const f = need - d; px += (dx / d) * f; py += (dy / d) * f }
      }
      for (const p of pads) { // nearby pad copper (capped disp + re-DRC guard keep own net)
        const g = gapToBox(vx, vy, r, padBox(p))
        if (g < minClear) { const dx = vx - p.x, dy = vy - p.y, d = Math.hypot(dx, dy) || 1e-6; const f = (minClear - g); px += (dx / d) * f; py += (dy / d) * f }
      }
      for (const s of segs) { // nearby OTHER-net trace copper
        if (s.net != null && s.net === net(m)) continue
        const [sx, sy] = closestOnSeg(vx, vy, s)
        const dx = vx - sx, dy = vy - sy, d = Math.hypot(dx, dy) || 1e-6
        const gap = d - r - s.hw
        if (gap < minClear) { const f = minClear - gap; px += (dx / d) * f; py += (dy / d) * f }
      }
      if (!px && !py) continue
      let nx = vx + px * 0.5, ny = vy + py * 0.5
      const o = orig.get(m), ddx = nx - o.x, ddy = ny - o.y, disp = Math.hypot(ddx, ddy)
      if (disp > maxDisp) { nx = o.x + (ddx / disp) * maxDisp; ny = o.y + (ddy / disp) * maxDisp }
      if (Math.abs(nx - vx) + Math.abs(ny - vy) > 1e-4) { m.p.x = nx; m.p.y = ny; if (m.sv) { m.sv.x = nx; m.sv.y = ny }; any = true }
    }
    if (!any) break
  }
  return { moved: movers.filter((m) => { const o = orig.get(m); return Math.hypot(m.p.x - o.x, m.p.y - o.y) > 0.01 }).length }
}

/** Complement of legalizeVias: nudge a TRACK's interior route points off other-net
 *  vias. When a via is boxed in and can't move (a dense multi-layer board's last
 *  residual is a via 0.2-0.37mm from a crossing track), the track has bending
 *  freedom the via doesn't — pushing the wire out clears the hole_clearance without
 *  disturbing the via's own connections. Endpoints (pad-anchored) never move; only
 *  interior wire points bend. Same-net track vs via is left alone (that's a real
 *  connection). Caller re-runs DRC and keeps only a strict improvement. */
function legalizeTraces(cj, { minClear = FAB_PROFILES.standard.holeClearance + LEGALIZE_MARGIN_MM, maxDisp = 0.3, iters = 120, targets = null, targetR = RESIDUAL_NUDGE_TARGET_R } = {}) {
  const traces = cj.filter((e) => e.type === 'pcb_trace')
  // optional targeting (residual nudge): an interior point may move only if it,
  // or one of its two adjacent segments, passes within targetR of a violation.
  // (A DRC track position is a point ON the track, not the closest point to the
  // offender, so the segment test is what actually catches the bend.)
  const segNear = (a, b, t) => {
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy
    const u = L2 ? Math.max(0, Math.min(1, ((t.x - a.x) * dx + (t.y - a.y) * dy) / L2)) : 0
    return Math.hypot(t.x - (a.x + u * dx), t.y - (a.y + u * dy)) <= targetR
  }
  const pointAllowed = (route, i) => !targets || targets.some((t) => segNear(route[i - 1], route[i], t) || segNear(route[i], route[i + 1], t))
  const vias = []
  for (const t of traces) for (const p of (t.route || [])) if (p.route_type === 'via') vias.push({ x: p.x, y: p.y, r: (p.outer_diameter ?? 0.4) / 2, net: t.subcircuit_connectivity_map_key })
  for (const v of cj.filter((e) => e.type === 'pcb_via')) vias.push({ x: v.x, y: v.y, r: (v.outer_diameter ?? 0.4) / 2, net: v.subcircuit_connectivity_map_key })
  if (!vias.length) return { moved: 0 }
  const orig = new Map()
  for (const t of traces) for (const p of (t.route || [])) orig.set(p, { x: p.x, y: p.y })
  for (let it = 0; it < iters; it++) {
    let any = false
    for (const t of traces) {
      const tn = t.subcircuit_connectivity_map_key
      const route = t.route || []
      for (let i = 1; i < route.length - 1; i++) { // interior wire points only
        const p = route[i]
        if (p.route_type === 'via') continue // vias are legalizeVias' job
        if (!pointAllowed(route, i)) continue // outside the nudge target radius
        const hw = (p.width ?? 0.15) / 2
        let px = 0, py = 0
        for (const v of vias) {
          if (v.net != null && v.net === tn) continue
          const dx = p.x - v.x, dy = p.y - v.y, d = Math.hypot(dx, dy) || 1e-6
          const need = v.r + hw + minClear
          if (d < need) { const f = need - d; px += (dx / d) * f; py += (dy / d) * f }
        }
        if (!px && !py) continue
        let nx = p.x + px * 0.5, ny = p.y + py * 0.5
        const o = orig.get(p), ddx = nx - o.x, ddy = ny - o.y, disp = Math.hypot(ddx, ddy)
        if (disp > maxDisp) { nx = o.x + (ddx / disp) * maxDisp; ny = o.y + (ddy / disp) * maxDisp }
        if (Math.abs(nx - p.x) + Math.abs(ny - p.y) > 1e-4) { p.x = nx; p.y = ny; any = true }
      }
    }
    if (!any) break
  }
  let moved = 0
  for (const t of traces) for (const p of (t.route || [])) { const o = orig.get(p); if (o && Math.hypot(p.x - o.x, p.y - o.y) > 0.01) moved++ }
  return { moved }
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
  // Density quick wins (opt out with FL_DENSE_4L=0):
  //  - dense boards (> 10 parts) skip the 2-layer rung: at that density the
  //    2-layer JVM pass is a ~1-2 min near-certain failure that also poisons
  //    the trail; inner-layer escape is what actually routes them
  //  - a final ROOMIER rung (bigger gap + wider board) runs before giving up,
  //    so a genuinely routable-but-tight board grows honestly instead of
  //    triggering the part-shedding density re-plan
  const dense = process.env.FL_DENSE_4L !== '0' && (parts?.length ?? 0) > 10
  const ladder = noNets
    ? [{ name: 'placement only (no signal nets)', router: 'tsci', place: { gap, maxW, clearance: 0.5 }, profile: 'standard' }]
    : FR_JAR && JAVA
    ? [
        ...(dense ? [] : [{ name: 'freerouting 2-layer, standard fab', router: 'fr', layers: 2, place: { gap, maxW, singleSided: true }, profile: 'standard' }]),
        { name: 'freerouting 4-layer, standard fab', router: 'fr', layers: 4, place: { gap, maxW, singleSided: true }, profile: 'standard' },
        { name: 'freerouting 4-layer, HDI fab',      router: 'fr', layers: 4, place: { gap, maxW, singleSided: true }, profile: 'hdi' },
        { name: 'freerouting 4-layer HDI, spread placement', router: 'fr', layers: 4, place: { gap: spread, maxW: maxW + 4, singleSided: true }, profile: 'hdi', respace: true },
        // Z-axis escalation: when 4 layers still won't close, add inner routing
        // layers (6 → 8) instead of sprawling the board out in xy. This is the
        // right relief for a genuinely dense or precision board — more channels,
        // same footprint — and the ladder still STOPS at the first clean route,
        // so 6/8 only run when 4 failed (exactly when they're needed).
        { name: 'freerouting 6-layer, HDI fab',      router: 'fr', layers: 6, place: { gap, maxW, singleSided: true }, profile: 'hdi' },
        { name: 'freerouting 8-layer, HDI fab',      router: 'fr', layers: 8, place: { gap, maxW, singleSided: true }, profile: 'hdi' },
        // BUILT-IN router, MULTI-LAYER. tscircuit's own autorouter routes on inner
        // copper and — unlike freerouting — stays in circuit-json space, so its
        // export has no DSN-converter parity problem (no phantom shorts). On a
        // dense board it routes every net; the only residual at 2-layer is via-to-
        // track congestion, which more layers relieve. These rungs are the honest
        // path to a clean dense board. 2-layer built-in stays LAST as the floor.
        { name: 'built-in router, 4-layer HDI', router: 'tsci', layers: 4, place: { gap, maxW, clearance: 0.45 }, profile: 'hdi' },
        { name: 'built-in router, 6-layer HDI', router: 'tsci', layers: 6, place: { gap, maxW, clearance: 0.45 }, profile: 'hdi' },
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
  const tNap = Date.now()
  const netAwarePlaced = FR_JAR && JAVA ? await netAwarePlace(parts, nets, { gap, maxW }) : null
  if (FR_JAR && JAVA) tAdd('netAwarePlace', Date.now() - tNap, `gap=${gap}, ${netAwarePlaced ? 'ok' : 'fallback to shelf-pack'}`)

  const trail = []
  let best = null
  // The built-in autorouter scales badly with part count: MEASURED, a 120-part
  // board spent 525s of a 527s run inside it, while the same board BUILDS in
  // 5.4s with routing off. The ladder puts freerouting rungs first, so on a
  // large board the tsci rungs are both the slowest option and the one we reach
  // only after better options failed — three of them in a row can blow straight
  // through the caller's hard wall. Skip them past a size threshold WHEN
  // freerouting is actually available; when it isn't, they are the only router
  // there is, so keep them and let the deadline below bound the damage.
  const TSCI_MAX_PARTS = Number(process.env.FL_TSCI_MAX_PARTS || 60)
  const frAvailable = Boolean(FR_JAR && JAVA)
  // Wall for the whole ladder. Leaves room for ground-plane + DRC afterwards.
  const LADDER_DEADLINE_MS = Number(process.env.FL_LADDER_BUDGET_MS || 240_000)
  const tLadder = Date.now()
  for (let i = 0; i < ladder.length; i++) {
    const s = ladder[i]
    const elapsedLadder = Date.now() - tLadder
    if (best && elapsedLadder > LADDER_DEADLINE_MS) {
      trail.push({ strategy: s.name, skipped: `ladder budget spent (${Math.round(elapsedLadder / 1000)}s)` })
      continue
    }
    if (s.router === 'tsci' && frAvailable && parts.length > TSCI_MAX_PARTS) {
      trail.push({ strategy: s.name, skipped: `built-in router skipped: ${parts.length} parts > ${TSCI_MAX_PARTS} (it scales superlinearly; freerouting rungs already covered this board)` })
      continue
    }
    // Net-aware placement (pin-facing, min-wirelength) helps BOTH routers: it puts
    // connected pins adjacent so the router has short, uncrossed channels. Re-emit
    // it per strategy so the built-in router still gets its fab-aware clearances.
    // Falls back to the connectivity shelf-pack when net-aware isn't available.
    // For freerouting strategies the built-in route is stripped before the DSN
    // export — skip computing it (routingDisabled). The tsci strategies keep it:
    // there the built-in router IS the router.
    const rd = OPT && s.router === 'fr'
    // the spread rung must actually RE-PLACE with the roomier gap/width —
    // reusing the tight net-aware placement would make it a no-op
    const placed = s.respace && FR_JAR && JAVA
      ? (await netAwarePlace(parts, nets, { gap: s.place.gap, maxW: s.place.maxW })) ?? netAwarePlaced
      : netAwarePlaced
    const code = placed
      ? emitBoardCode(placed, nets, { clearance: s.router === 'tsci' ? s.place.clearance : null, routingDisabled: rd, numLayers: s.router === 'tsci' ? (s.layers ?? 2) : 2 })
      : buildCode(parts, nets, { ...s.place, routingDisabled: rd, numLayers: s.router === 'tsci' ? (s.layers ?? 2) : 2 })
    let cj = await buildCircuit(code, s.name)
    let fixes = [], unrouted = 0, unroutedNets = []
    if (s.router === 'fr') {
      let fr = await freeroute(cj, { layers: s.layers })
      if (!fr) continue // freerouting failed this pass; try the next strategy
      // Rip-up-and-reorder: if the router left nets open, hand it the SAME board
      // once more with those nets moved to the front of the net order. Nets
      // routed first get open space; the ones that lost the race are precisely
      // the ones reported unrouted, so putting them first is the standard lever.
      // Keep the retry only if it completes MORE nets and does not add DRC
      // errors — otherwise the original stands.
      if (fr.unrouted > 0 && (fr.unroutedNets?.length ?? 0) > 0
          && (Date.now() - tLadder) + 25_000 < LADDER_DEADLINE_MS) {
        const retry = await freeroute(cj, { layers: s.layers, routeFirst: fr.unroutedNets })
        if (retry?.reordered && retry.unrouted < fr.unrouted) {
          const before = fr.unrouted
          fr = retry
          fixes.push(`re-routed with ${before - retry.unrouted} previously-open net(s) ordered first (${before} → ${retry.unrouted} unrouted)`)
        }
      }
      cj = fr.cj; unrouted = fr.unrouted; unroutedNets = fr.unroutedNets ?? []
      // freerouting can route copper right to the outline; give the board the
      // same edge margin the built-in path gets so copper clears the edge.
      const board = cj.find((e) => e.type === 'pcb_board')
      if (board) {
        board.width += 1.2; board.height += 1.2
        // Stamp the real copper-layer count so the KiCad converter emits a stackup
        // that matches the routed inner layers (In1..In(N-2)); without it a 6/8-layer
        // route would be checked against a 2-layer stackup and mis-flag inner traces.
        if (s.layers > 2) board.num_layers = s.layers
      }
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
    // Reconcile the open-net count against the REFEREE.
    //
    // The structural count (source traces whose id came back on no routed wire)
    // over-reports whenever the DSN -> SES -> circuit-json round trip drops a
    // source id from copper that WAS routed. Measured on the `residual` fixture:
    // structural said 5, freerouting's own log said 1, and KiCad DRC — the same
    // independent referee every other number here comes from — found exactly 1
    // unconnected item. Four of those five nets were physically connected on the
    // board while the product told the user to go route them by hand.
    //
    // KiCad wins. The structural number is kept as a diagnostic so a real
    // divergence is still visible rather than silently smoothed over.
    const unroutedStructural = unrouted
    const kicadOpen = drc.errorTypes?.unconnected_items
    if (Number.isFinite(kicadOpen)) unrouted = kicadOpen
    else if (drc.available) unrouted = 0
    if (unroutedStructural !== unrouted) {
      fixes = [...fixes, `open-net count reconciled against KiCad DRC: ${unroutedStructural} structural → ${unrouted} actual`]
    }
    // Severity-weighted score. Counting every error equally made the ladder
    // pick a BROKEN board over a manufacturable one: measured on the `dense`
    // fixture, it chose a 7-error board carrying a SHORT and 2 open nets over a
    // 13-error board with zero shorts and 1 open net. A short or a missing
    // connection means the board does not work; a hole/copper clearance nit
    // means the fab raises an eyebrow and the board still functions. Those are
    // not the same unit and must not be summed as if they were.
    const score = drcScore(drc, unrouted)
    trail.push({ iter: i + 1, strategy: s.name, profile: FAB_PROFILES[s.profile].label, errors: drc.errors, errorTypes: drc.errorTypes, unrouted })
    if (!best || score < best.score) best = { cj, drc, fixes, unrouted, unroutedStructural, unroutedNets, score, strategy: s.name, layers: s.layers ?? 2 }
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
          layers: Math.max(best.layers || 2, 4), // completion routes on an inner layer → 4-layer board
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
  // strict DRC: count non-electrical classes (footprint-lib drift, text, silk)
  // toward errors/converged too. Off by default; see NON_ELECTRICAL_DRC.
  if (input.strictDrc === true) STRICT_NON_ELECTRICAL = true

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
      if (ok) continue
      // Not one of the two natively-emitted shapes. Before rejecting the whole
      // board, try to SYNTHESIZE the land pattern: a header, SOIC, SOT, QFP or
      // terminal block is an ordinary part, and bouncing the netlist over one
      // was the main thing stopping a more complicated product from building.
      // A supplier-supplied kicadMod always wins (handled by the `continue`
      // above); this is the fallback, and it is marked so reports can say the
      // geometry is generic rather than from a datasheet.
      const synth = synthFootprint(fp)
      if (synth) {
        p.kicadMod = synth
        p.syntheticFootprint = true
        continue
      }
      process.stdout.write(JSON.stringify({ ok: false, error: `unsupported footprint "${fp}" on ${p?.name ?? '?'} — supply a real LCSC kicadMod, or use qfn4..qfn64, or one of: ${SYNTH_FAMILIES.join('; ')}` }))
      return
    }
  }

  const iterative = input.parts && input.repair !== false && input.drc !== false && KICAD_CLI

  // Iterative DRC-driven redesign: search the strategy ladder for a real
  // fab-clean board; use the best one it finds as the reported result.
  let cj, drc, drcRepair = null, code, kicadPcb = null, boardFeatures = null
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
    // Size budget. Defaults reproduce the tight chip-scale behaviour exactly
    // (maxW 15, gap ladder 2.1→3.2→4.6). A caller that already KNOWS the board is
    // too dense to route clean at chip-scale (the electronics-cs planner-grow
    // path) passes a wider maxW + a roomier gap ladder so the board GROWS honestly
    // — more channel room and space for the mounting-hole keepout — instead of
    // shedding parts. Guard-railed to sane ranges so a bad payload can't wedge it.
    const MAXW = Number.isFinite(+input.maxW) && +input.maxW >= 15 && +input.maxW <= 60 ? +input.maxW : 15
    const GAP_LADDER = Array.isArray(input.gapLadder) && input.gapLadder.length
      ? input.gapLadder.map(Number).filter((g) => g >= 1.5 && g <= 8).slice(0, 4)
      : [2.1, 3.2, 4.6]
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
      const attempt = await iterativeRedesign(input.parts, input.nets, { gap: g, maxW: MAXW })
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
      code = buildCode(input.parts, input.nets, { gap: usedGap, maxW: MAXW }) // representative source
      const loosened = gapTrail.length > 1 && usedGap > GAP_LADDER[0]
      drcRepair = {
        converged: res.converged,
        iterations: res.trail,
        winningStrategy: res.best.strategy,
        // explicit copper layer count of the winning board (2 or 4) — consumers
        // (lib/ground-board) previously had to regex winningStrategy for it.
        layers: res.best.layers ?? null,
        errorsFirst: res.trail[0]?.errors ?? null,
        errorsBest: res.best.drc.errors,
        unrouted: res.best.unrouted,
        // WHICH nets the router could not close. A bare count tells a user the
        // board is incomplete but not what to look at; these are the nets that
        // need a manual trace (or that rip-up-and-reroute must re-present).
        unroutedNets: res.best.unroutedNets ?? [],
        // What the id-linkage heuristic thought, kept beside the referee's
        // number so a genuine divergence stays visible.
        unroutedStructural: res.best.unroutedStructural ?? null,
        fixes: loosened
          ? [...res.best.fixes, `spread placement to ${usedGap}mm component gap so the router could close (design↔routing convergence)`]
          : res.best.fixes,
        verdict: res.verdict,
        gapConvergence: { ladder: gapTrail, chosenGap: usedGap, loosened },
      }
      // Board features (circular outline / mounting holes): applied to the REAL
      // routed geometry (res.best.cj — the same object the ground-plane pass and
      // final export read), then real DRC RE-RUNS against the new outline+holes
      // so hole_clearance / edge violations are caught, never hidden. Routing is
      // untouched: the circle circumscribes the routed rect, holes avoid parts.
      boardFeatures = applyBoardFeatures(cj, input, res.best.drc.profileKey || 'standard')
      if (boardFeatures) {
        const drcF = await realDrc(cj, res.best.drc.profileKey || 'standard')
        if (drcF.available) { drc = drcF; drcRepair.errorsBest = drcF.errors }
        const shapeBit = boardFeatures.boardShape.type === 'circle'
          ? `circular board outline Ø${boardFeatures.boardShape.diameterMm}mm (routing inside the inscribed rect)`
          : 'rect board outline'
        const holeBit = boardFeatures.mountingHoles.length
          ? `, ${boardFeatures.mountingHoles.length} NPTH mounting hole(s) ${boardFeatures.boardShape.type === 'circle' ? `on a Ø${boardFeatures.boardShape.boltCircleDiaMm}mm bolt circle` : 'at the corners'}`
          : ''
        drcRepair.fixes = [
          ...drcRepair.fixes,
          `${shapeBit}${holeBit} → re-ran real DRC: ${drcF.available ? `${drcF.errors} error(s)` : 'unavailable'}`,
          ...boardFeatures.notes,
        ]
      }
      // Legalizer clearance = the winning profile's hole_clearance RULE + margin
      // (the old hardcoded 0.4 had zero margin against the HDI rule and sat
      // UNDER the standard profile's 0.5mm rule).
      const holeClearanceMm = (FAB_PROFILES[res.best.drc.profileKey] || FAB_PROFILES.standard).holeClearance ?? 0.5
      const legalClear = +(holeClearanceMm + LEGALIZE_MARGIN_MM).toFixed(3)
      let lastMd = null // last accepted legalizer displacement (feeds the residual nudge)
      // Via-legalization post-pass: if the best board has DRC errors, try nudging
      // over-packed vias off nearby other-net copper, then re-DRC. Keep it ONLY if
      // total errors drop and no new unconnected nets appear (a via that wandered
      // off its connection would show up as unconnected). Real geometry, re-checked.
      if ((drc?.errors ?? 0) > 0) {
        const cjTry = JSON.parse(JSON.stringify(cj))
        // Escalating gentle nudge: a big all-at-once displacement (0.8mm) on a
        // dense multi-layer board clears a few via-to-track nits but shoves other
        // vias into new copper (measured 11→28). Sweep from a tiny displacement
        // up; the violations only need ~0.05-0.2mm. Keep the FIRST sweep that
        // strictly lowers total errors with no new unconnected nets, and re-run
        // from there so several rounds can each shave a via off.
        let curMoved = 0
        for (let round = 0; round < 8 && (drc?.errors ?? 0) > 0; round++) {
          let best2 = null
          for (const md of [0.12, 0.2, 0.3, 0.45]) {
            const cjTry = JSON.parse(JSON.stringify(cj))
            // Both directions: nudge over-packed vias off copper, then bend the
            // remaining crossing tracks off any via still too close. A boxed-in
            // via that can't move is cleared by moving the track instead.
            const vm = legalizeVias(cjTry, { minClear: legalClear, maxDisp: md, iters: 260 }).moved
            const tm = legalizeTraces(cjTry, { minClear: legalClear, maxDisp: md, iters: 200 }).moved
            const moved = vm + tm
            if (!moved) continue
            const drc2 = await realDrc(cjTry, res.best.drc.profileKey || 'standard')
            const unbefore = drc.errorTypes?.unconnected_items || 0
            const unafter = drc2.errorTypes?.unconnected_items || 0
            if (drc2.available && drc2.errors < drc.errors && unafter <= unbefore && (!best2 || drc2.errors < best2.drc.errors)) {
              best2 = { cj: cjTry, drc: drc2, moved, md }
            }
          }
          if (process.env.FL_FR_DEBUG) process.stderr.write(`[legalizeVias r${round}] before ${drc.errors} -> ${best2 ? best2.drc.errors + ' (md ' + best2.md + ')' : 'no improvement'}\n`)
          if (!best2) break
          cj = best2.cj; drc = best2.drc; curMoved += best2.moved; lastMd = best2.md
        }
        if (curMoved > 0) {
          drcRepair.viaLegalization = { moved: curMoved, errorsAfter: drc.errors, minClear: legalClear }
          drcRepair.errorsBest = drc.errors
          drcRepair.fixes = [...drcRepair.fixes, `via-legalization (${legalClear.toFixed(2)}mm = ${holeClearanceMm}mm rule + ${LEGALIZE_MARGIN_MM}mm margin): nudged vias off other-net copper → ${drc.errors} DRC error(s)`]
        }
      }
      // Residual nudge: the whole ladder is done and the board is a handful of
      // hole_clearance / clearance nits short of clean (≤ RESIDUAL_NUDGE_MAX, no
      // unrouted net, no other error class). Run both legalizers ONCE more at a
      // slightly larger displacement, but only on copper next to the reported
      // violation positions (drc.violations, mapped back into cj coordinates),
      // then re-run real DRC once. Accept only if the count did not increase and
      // no unconnected item appeared. This is the relief a 1-5-error board never
      // got: the caller's density re-plan only fires at ≥6 errors / an unrouted
      // net, so these boards used to end `converged:false` untouched.
      const nudgeCfg = input.residualNudge
      const nudgeMax = nudgeCfg === false ? 0
        : (Number.isFinite(+nudgeCfg?.maxErrors) && +nudgeCfg.maxErrors >= 1 && +nudgeCfg.maxErrors <= 10 ? +nudgeCfg.maxErrors : RESIDUAL_NUDGE_MAX)
      // Gate on the NUDGEABLE errors, not the total.
      //
      // The old gate required drc.errors <= max AND every error type to be
      // nudgeable, so a single unrelated error vetoed the whole pass. Measured
      // on the golden `short` board: 5 hole_clearance violations at 0.3701 mm
      // against a 0.4000 mm rule — short by three hundredths of a millimetre,
      // exactly what this pass exists to close — plus 1 unconnected_items. Six
      // errors and a non-nudgeable type, so the board was reported as a failure
      // untouched. `dense` was vetoed the same way by a short.
      //
      // Now: fire when there is a workable number of clearance-type violations,
      // whatever else is also wrong. The pass simply cannot fix a short or an
      // open net, and never claimed to; refusing to fix what it CAN because
      // something else is broken just leaves more errors on the board. The
      // acceptance test below is unchanged and still refuses any result that
      // raises the total or strands a net, so this can only help.
      const errTypes = Object.keys(drc?.errorTypes || {})
      const nudgeableCount = errTypes.reduce((n, t) => n + (RESIDUAL_NUDGE_TYPES.has(t) ? (drc.errorTypes[t] || 0) : 0), 0)
      if (drc?.available && drc.errors > 0 && nudgeableCount > 0 && nudgeableCount <= nudgeMax && (res.best.unrouted ?? 0) === 0
          && (Date.now() - T_START) + 20_000 < BUDGET_MS) {
        const targets = (drc.violations || []).filter((v) => RESIDUAL_NUDGE_TYPES.has(v.type)).map((v) => ({ x: v.x, y: v.y }))
        const targeted = !!drc.positionsMapped && targets.length > 0
        // Displacement ladder, smallest first.
        //
        // A single large step was the whole problem. These violations miss by
        // HUNDREDTHS of a millimetre (measured: 0.3701 mm against a 0.4000 mm
        // rule), and the pass was shoving copper up to 0.3 mm — ten times the
        // needed correction — which drags traces off their pads and regresses
        // connectivity, so every attempt was correctly rejected and the board
        // shipped dirty while sitting 0.03 mm from clean.
        //
        // Start at the size of the actual shortfall and only escalate if that
        // is not enough. The first attempt that improves the board without
        // regressing connectivity wins; if none does, nothing is applied. Each
        // rung costs one DRC run, so the ladder is short and bounded by the
        // remaining time budget.
        const shortfalls = (drc.violations || [])
          .map((v) => v.shortfallMm)
          .filter((n) => Number.isFinite(n) && n > 0)
        const worst = shortfalls.length ? Math.max(...shortfalls) : null
        const first = worst ? +Math.min(0.15, Math.max(0.03, worst * 1.6)).toFixed(3) : 0.05
        const ladderMd = [...new Set([first, 0.1, 0.2, +((lastMd ?? 0.3) + RESIDUAL_NUDGE_DISP_BOOST).toFixed(2)])]
          .filter((v) => v > 0)
          .sort((a, b) => a - b)

        const before = drc.errors
        let after = before, accepted = false, reason = 'nothing to move'
        let md = ladderMd[0], movedTotal = 0
        const rungs = []
        // Take the BEST rung, not the first that happens to help, and then run
        // the whole pass again on the improved board: closing one violation
        // changes what the neighbouring copper can do, so a second sweep often
        // reaches sites the first could not. Stops as soon as a sweep buys
        // nothing, and every sweep is bounded by the remaining time budget.
        for (let sweep = 0; sweep < RESIDUAL_NUDGE_SWEEPS; sweep++) {
          let bestCj = null, bestDrc = null, bestMd = null, bestMoved = 0
          for (const step of ladderMd) {
            if ((Date.now() - T_START) + 15_000 > BUDGET_MS) { rungs.push({ sweep, md: step, skipped: 'budget' }); break }
            const cjTry = JSON.parse(JSON.stringify(cj))
            const vm = legalizeVias(cjTry, { minClear: legalClear, maxDisp: step, iters: 260, targets: targeted ? targets : null }).moved
            const tm = legalizeTraces(cjTry, { minClear: legalClear, maxDisp: step, iters: 200, targets: targeted ? targets : null }).moved
            if (vm + tm === 0) { rungs.push({ sweep, md: step, moved: 0, result: 'nothing to move' }); continue }
            const drc2 = await realDrc(cjTry, res.best.drc.profileKey || 'standard')
            const unbefore = drc.errorTypes?.unconnected_items || 0
            const unafter = drc2.errorTypes?.unconnected_items || 0
            const ok = drc2.available && drc2.errors <= drc.errors && unafter <= unbefore
            rungs.push({ sweep, md: step, moved: vm + tm, errors: drc2.available ? drc2.errors : null,
              result: ok ? 'candidate' : (!drc2.available ? 'DRC unavailable' : unafter > unbefore ? 'connectivity regressed' : 'error count rose') })
            if (ok && (!bestDrc || drc2.errors < bestDrc.errors)) { bestCj = cjTry; bestDrc = drc2; bestMd = step; bestMoved = vm + tm }
          }
          if (!bestDrc || bestDrc.errors >= drc.errors) break
          cj = bestCj; drc = bestDrc; accepted = true
          after = bestDrc.errors; md = bestMd; movedTotal += bestMoved
          reason = 'fewer errors'
          if (drc.errors === 0) break
        }
        if (accepted && after === before) reason = 'no change in count'
        drcRepair.residualNudge = { attempted: true, targeted, targets: targets.length, moved: movedTotal, maxDisp: md, ladder: rungs, minClear: legalClear, before, after, accepted, reason }
        if (process.env.FL_FR_DEBUG) process.stderr.write(`[residualNudge] ${before} -> ${after} (${reason}; targeted=${targeted}, moved=${movedTotal}, md=${md}, sweeps=${rungs.length})\n`)
        drcRepair.fixes = [...drcRepair.fixes,
          `residual nudge (${targeted ? `${targets.length} violation site(s)` : 'untargeted — positions not mappable'}, ${md}mm): ${accepted ? `${before} → ${after} DRC error(s)` : `rejected (${reason}), kept ${before}`}`]
        if (accepted) drcRepair.errorsBest = drc.errors
      }
      // Post-pass verdict refresh: `converged` / `verdict` were computed by the
      // ladder BEFORE via-legalization and the residual nudge; they must reflect
      // the board actually being reported (the spec-level "post-nudge count").
      {
        const unroutedNow = res.best.unrouted ?? 0
        const convergedNow = !!(drc?.available && drc.errors === 0 && unroutedNow === 0)
        if (convergedNow !== drcRepair.converged || drc?.errors !== res.best.drc.errors) {
          drcRepair.converged = convergedNow
          const n = res.trail.length, sl = `iterated ${n} strateg${n === 1 ? 'y' : 'ies'} + legalization`
          if (convergedNow) drcRepair.verdict = null
          else if (unroutedNow > 0) {
            // Name nets only when the link heuristic AGREES with the referee.
            // When they disagree the heuristic's list is a superset (it flags
            // nets whose source id was lost in conversion but whose copper is
            // really there), so presenting it as the answer would send someone
            // to hand-route traces that already exist.
            const all = (drcRepair.unroutedNets ?? []).map((n) => n?.name).filter(Boolean)
            const trustworthy = drcRepair.unroutedStructural == null || drcRepair.unroutedStructural === unroutedNow
            let which = ''
            if (all.length && trustworthy) {
              const shown = all.slice(0, 4)
              which = ` (${shown.join(', ')}${all.length > shown.length ? ', …' : ''})`
            } else if (all.length) {
              which = ` (KiCad found ${unroutedNow}; link analysis flagged ${all.length} candidate(s) — open the board to see which)`
            }
            drcRepair.verdict = `${sl}; best board has ${drc.errors} DRC error(s) and ${unroutedNow} net(s) the autorouter couldn't complete${which} — needs manual routing or a simpler netlist.`
          } else {
            const top = Object.entries(drc?.errorTypes || {}).sort((a, b) => b[1] - a[1])[0]?.[0]
            drcRepair.verdict = `${sl}; best ${drc.errors} error(s) (${top || 'DRC'}) under ${drc.ruleProfile} — beyond the loop's current levers.`
          }
        }
        if (drc?.nonElectrical?.count) drcRepair.nonElectrical = drc.nonElectrical
      }
      // Real ground plane (pcbnew): assign GND to the ground pins and lay a
      // DRC-verified GND zone that bonds them. Signals stay freerouting-routed;
      // ground becomes a plane, the way a real board does it.
      // NOTE: uses `cj` (the legalized / nudged board), not res.best.cj — the
      // legalizers work on deep copies, so the old res.best.cj reference here
      // grounded and rendered the PRE-legalization geometry.
      if (input.gnd?.length) {
        const tGp = Date.now()
        TIMINGS.counters.groundPlanePasses++
        const gp = await applyGroundPlane(cj, input.gnd, res.best.drc.profileKey || 'standard')
        tAdd('groundPlane', Date.now() - tGp, gp?.available ? `${gp.assigned} pins, ${gp.errors} errors` : 'unavailable')
        if (gp?.available) {
          if (gp.pcb) kicadPcb = gp.pcb // grounded board (with the GND plane) for the 3D render
          drcRepair.groundPlane = { assigned: gp.assigned, unconnected: gp.unconnected, stitched: gp.stitched, skipped: gp.skipped, errors: gp.errors }
          const stitchNote = gp.stitched ? `, ${gp.stitched} bonded down via tented via-in-pad` : ''
          // append to the accumulated fixes (NOT res.best.fixes) so the loosen
          // note (design↔routing convergence) and any via-legalization note
          // survive to the UI instead of being clobbered by the ground-plane pass.
          drcRepair.fixes = [...drcRepair.fixes, `ground plane: ${gp.assigned} pins on a DRC-verified GND zone${stitchNote}${gp.unconnected ? ` (${gp.unconnected} still unreached)` : ''}`]
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
            // build on the REFRESHED (post-legalization / post-nudge) verdict, not
            // the ladder's original res.verdict, so the detail never quotes a stale count
            drcRepair.verdict = `${drcRepair.verdict ? drcRepair.verdict + ' ' : ''}Ground plane: ${bits.join(' + ')} — a real chip-scale density limit, reported not hidden.`
          }
        }
      }
    }
  }
  // Fallbacks: explicit code input, or iterative unavailable/failed.
  if (!cj) {
    // routingDisabled is honoured here so a caller can ask for a PLACED board
    // without paying for the built-in autorouter — the pipeline routes with
    // freerouting anyway, and on a large board the built-in route dominates
    // the whole run (a 120-part board spent 525s of 527s in it).
    code = input.code || (input.parts ? buildCode(input.parts, input.nets, { routingDisabled: input.routingDisabled === true }) : '')
    cj = await buildCircuit(code, 'fallback build')
    // board features BEFORE the DRC so the check runs against the real outline+holes
    boardFeatures = applyBoardFeatures(cj, input, 'standard')
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
      kicadPcb = decorateMountingHoles(conv.getOutputString(), (FAB_PROFILES[drc?.profileKey] || FAB_PROFILES.standard).holeClearance ?? 0.5)
    } catch { /* 3D export optional */ }
  }
  // Populate the board with 3D component bodies so it renders as a PCBA, not a
  // bare PCB.
  if (kicadPcb && input.parts) kicadPcb = attachModels(kicadPcb, input.parts)

  // `ok` means what the header docstring claims — the board is genuinely done:
  //   * routed copper exists (when there are nets to route),
  //   * REAL KiCad DRC ran and found zero errors,
  //   * the router left zero nets unrouted (when the iterative loop ran).
  // The old predicate (`traces>0 && cjErrorCount===0`) scored the DISCARDED
  // builtin-autoroute pass's error records and ignored both real DRC errors and
  // freerouting-unrouted nets — false positives (dirty board marked ok) and
  // false negatives (stale builtin errors failing a freerouted board) alike.
  // DRC unavailable (no kicad-cli) → ok is false: we cannot CLAIM clean unchecked.
  const drcClean = !!(drc && drc.available === true && drc.errors === 0)
  const unroutedNets = drcRepair ? (drcRepair.unrouted ?? 0) : 0
  const needsTraces = Array.isArray(input.nets) ? input.nets.length > 0 : true
  // circle boards report the honest square bbox (w = h = diameter) but the TRUE
  // area is the disc's, not the bbox's.
  const isCircle = boardFeatures?.boardShape?.type === 'circle'
  const totalMs = Date.now() - T_RUN0
  process.stderr.write(`[t] total: ${(totalMs / 1000).toFixed(1)}s (${TIMINGS.counters.freeroutingPasses} freerouting passes, ${TIMINGS.counters.jvmStarts} jvm starts, ${TIMINGS.counters.kicadDrcRuns} kicad drc runs, ${TIMINGS.counters.tscircuitBuilds} tscircuit builds)\n`)
  process.stdout.write(JSON.stringify({
    ok: !!board && (!needsTraces || traces.length > 0) && drcClean && unroutedNets === 0,
    layers: drcRepair?.layers ?? board?.num_layers ?? null,
    kicadPcb,
    boardMm: board ? { w: Math.round(board.width * 10) / 10, h: Math.round(board.height * 10) / 10 } : null,
    areaMm2: board ? Math.round((isCircle ? Math.PI / 4 : 1) * board.width * board.height) : null,
    // real board shape + mounting provisions (see applyBoardFeatures): the
    // diameter is the AS-BUILT one (post any grow-to-fit); hole coords are
    // board-centered mm (+x right, +y up), drilled as NPTH in kicadPcb.
    boardShape: boardFeatures?.boardShape ?? { type: 'rect' },
    mountingHoles: boardFeatures?.mountingHoles ?? [],
    // freerouting's DSN round-trip drops pcb_component records; fall back to the
    // real part count so the UI never shows "0 components" for a routed board.
    components: comps.length || (Array.isArray(input.parts) ? input.parts.length : 0),
    routedTraces: traces.length,
    errors,
    drc,
    drcRepair,
    svg,
    code,
    // additive observability: wall-clock per phase + process/pass counters. No
    // consumer depends on it; safe to extend.
    timings: { totalMs, phases: TIMINGS.phases, counters: TIMINGS.counters },
  }))
}

main().catch((e) => { process.stdout.write(JSON.stringify({ ok: false, error: String(e).slice(0, 300) })); process.exit(1) })
