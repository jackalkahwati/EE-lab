// SPIKE — net-aware KiCad export (scoping + feasibility, NOT yet integrated).
//
// PROBLEM the pipeline has: circuit-json-to-kicad emits NET-LESS geometry — no
// (net ...) declarations, pads carry no net. So kicad-cli DRC verifies copper
// shapes/clearances but not connectivity, and ground PLANES (zones that connect
// same-net pads) are impossible. "0 unrouted" today comes from freerouting's
// own model, not KiCad.
//
// PROVEN HERE:
//  1. kicad-cli pcb drc DOES compute connectivity — a hand-written board with 2
//     same-net pads and no copper reports "1 unconnected item". So net-aware DRC
//     is achievable via the CLI.
//  2. Building a net model from the netlist (union-find over the ["A.p","B.p"]
//     pairs + a GND group) is correct, and injecting (net id "name") into the
//     converter's .kicad_pcb makes KiCad SEE the connectivity: on a placed-but-
//     unrouted 6-net board, injected nets took DRC from unconnected=0 -> 2.
//
// REMAINING to finish the feature (next focused build):
//  - injectNets matches CHIP footprints (property "Reference") but not passives
//    yet (0402 caps use a different ref path) -> only 8/12 pads got nets, so 2/6
//    nets showed unconnected instead of 6. Handle every footprint's ref format.
//  - thread the net model through run_board.mjs (realDrc runs on net-aware kicad;
//    a `gnd` pin list from the electronics prompt feeds the GND net).
//  - GROUND PLANE: with nets real, emit a zone on the GND net; KiCad fills it
//    connecting the GND pads (thermal reliefs) and DRC verifies it, edge-inset to
//    stay clean. This is the payoff the net model unlocks.
//  - then: real Gerbers carry nets; the loop can verify EVERY net is truly
//    connected (not just freerouting's claim).
//
// Run: node netexport_probe.mjs
import { runTscircuitCode } from '@tscircuit/eval'
import { CircuitJsonToKicadPcbConverter } from 'circuit-json-to-kicad'
import { convertCircuitJsonToDsnJson, stringifyDsnJson, parseDsnToDsnJson, convertDsnSessionToCircuitJson } from 'dsn-converter'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process'
const JAR = '/Volumes/T9 Backup/EE-lab/tools/freerouting/freerouting-2.2.4.jar'

// ---- net model from the netlist (ground truth) ----
function buildNetModel(netList, gndPins = []) {
  const parent = {}; const find = (x) => { if (parent[x] == null) parent[x] = x; while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }; const union = (a, b) => { parent[find(a)] = find(b) }
  for (const [a, b] of netList) union(String(a), String(b))
  for (let i = 1; i < gndPins.length; i++) union(gndPins[0], gndPins[i])
  const gndRoot = gndPins.length ? find(gndPins[0]) : null
  const all = new Set([...netList.flat().map(String), ...gndPins])
  const groups = {}; for (const k of all) { const r = find(k); (groups[r] = groups[r] || []).push(k) }
  let id = 1; const padNet = {}; const nets = []
  for (const [root, keys] of Object.entries(groups)) {
    if (keys.length < 2) continue
    const name = root === gndRoot ? 'GND' : `Net-${keys[0]}`
    const n = { id: id++, name }; nets.push(n)
    for (const k of keys) padNet[k] = n
  }
  return { padNet, nets }
}

// ---- inject nets into the net-less .kicad_pcb ----
function injectNets(k, padNet, nets) {
  const decls = nets.map((n) => `  (net ${n.id} "${n.name}")`).join('\n')
  k = k.replace(/\(net 0 ""\)/, (m) => `${m}\n${decls}`)
  let hits = 0
  let out = '', i = 0
  while (i < k.length) {
    const fpAt = k.indexOf('(footprint', i)
    if (fpAt < 0) { out += k.slice(i); break }
    out += k.slice(i, fpAt)
    let depth = 0, j = fpAt
    for (; j < k.length; j++) { if (k[j] === '(') depth++; else if (k[j] === ')') { depth--; if (depth === 0) { j++; break } } }
    let block = k.slice(fpAt, j)
    const ref = (block.match(/\(property "Reference" "([^"]*)"/) || [])[1]
    if (ref) {
      // inject net right before each pad'\''s closing (uuid ...) — every converter pad ends with a uuid
      block = block.replace(/(\(pad "([^"]*)"[\s\S]*?)(\(uuid [^)]*\)\s*\))/g, (m, head, num, tail) => {
        const n = padNet[`${ref}.${num}`]
        if (!n) return m
        hits++
        return `${head}(net ${n.id} "${n.name}") ${tail}`
      })
    }
    out += block; i = j
  }
  process.stderr.write(`[inject] pad nets injected: ${hits}\n`)
  return out
}

function drc(k, label) {
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'd-'))
  fs.writeFileSync(path.join(dd, 'b.kicad_pcb'), k)
  fs.writeFileSync(path.join(dd, 'b.kicad_dru'), `(version 1)\n(rule "t" (constraint track_width (min 0.09mm)))(rule "c" (constraint clearance (min 0.09mm)))`)
  spawnSync(process.env.FL_KICAD_CLI || '/opt/homebrew/bin/kicad-cli', ['pcb', 'drc', '--format', 'json', '--output', path.join(dd, 'o.json'), path.join(dd, 'b.kicad_pcb')], { timeout: 60000 })
  const rep = JSON.parse(fs.readFileSync(path.join(dd, 'o.json'), 'utf8'))
  console.log(`${label}: errors=${(rep.violations || []).filter((x) => x.severity === 'error').length} unconnected=${(rep.unconnected_items || []).length}`)
  fs.rmSync(dd, { recursive: true, force: true })
}

// PLACED but NOT routed (clean refs, no DSN round-trip). With 6 nets and no
// copper, a working net-aware export must make KiCad report ~6 unconnected.
const code = `export default () => (<board autorouter="auto"><chip name="U1" footprint="qfn32" pcbX={0} pcbY={0} layer="top" /><chip name="M1" footprint="qfn6" pcbX={7} pcbY={0} layer="top" /><chip name="M2" footprint="qfn6" pcbX={7} pcbY={3} layer="top" /><capacitor name="C1" footprint="0402" pcbX={0} pcbY={5} layer="top" /><capacitor name="C2" footprint="0402" pcbX={3} pcbY={5} layer="top" /><capacitor name="C3" footprint="0402" pcbX={6} pcbY={5} layer="top" /></board>)`
const routed = await runTscircuitCode(code)
const NETLIST = [['U1.1', 'C1.1'], ['U1.2', 'C2.1'], ['U1.3', 'C3.1'], ['U1.13', 'M1.1'], ['U1.14', 'M2.1'], ['C1.2', 'M1.2']]
const conv = new CircuitJsonToKicadPcbConverter(routed); conv.runUntilFinished(); const kNetless = conv.getOutputString()
console.log('kicad refs:', [...new Set([...kNetless.matchAll(/\(property "Reference" "([^"]*)"/g)].map((m) => m[1]))].join(','))
drc(kNetless, 'net-less, unrouted  ')
const model = buildNetModel(NETLIST)
console.log('net model:', model.nets.length, 'nets')
const kNets = injectNets(kNetless, model.padNet, model.nets)
drc(kNets, 'net-aware, unrouted ')
console.log('(expect net-aware unconnected ~= 6 nets — proves KiCad now sees connectivity)')
