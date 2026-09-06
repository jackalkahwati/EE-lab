// Pure test: the via geometry the router is TOLD must actually reach the DSN.
// Two edits to it went out unchanged (a guard that skipped every shape), and the
// only way that was noticed was byte-identical copper across runs. No KiCad, no JVM.
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('./run_board.mjs', import.meta.url), 'utf8')
const cut = (start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)))
const ns = {}
new Function('exports',
  cut('const FAB_PROFILES', '\n}\n') + '\n}\n' +
  cut('function setDsnTraceRules', '\n}\n') + '\n}\n' +
  cut('function setViaClearance', 'function viaClearanceUm') +
  cut('function viaClearanceUm', '\n}\n') + '\n}\n' +
  cut('function emitBoardCode', '\n}\n') + '\n}\n' +
  cut('function mergeStackedVias', '\n}\n') + '\n}\n' +
  'exports.FAB_PROFILES=FAB_PROFILES;exports.setViaClearance=setViaClearance;exports.viaClearanceUm=viaClearanceUm;exports.viaPadstackUm=viaPadstackUm;exports.setDsnTraceRules=setDsnTraceRules;exports.routerViaPadMm=routerViaPadMm;exports.emitBoardCode=emitBoardCode;exports.mergeStackedVias=mergeStackedVias;exports.setViaPadstack=setViaPadstack;'
)(ns)

const dsn = () => ({
  structure: { rule: { clearances: [{ value: 150 }, { value: 50, type: 'smd_smd' }] } },
  library: { padstacks: [
    { name: 'Via[0-1]_600:300_um', shapes: [{ shapeType: 'circle', layer: 'F.Cu', diameter: 600 }, { shapeType: 'circle', layer: 'B.Cu', diameter: 600 }] },
    { name: 'RoundRect[T]Pad_875x250_um', shapes: [{ shapeType: 'polygon', layer: 'F.Cu' }] },
  ] },
})

let pass = 0
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name) }

t('viaPadstackUm is sized from the STRICTEST profile hole rule, not a constant', () => {
  const um = ns.viaPadstackUm(dsn())
  // standard: H 0.5, hole 0.2 -> 2*(500+100-150)+50 = 950
  assert.equal(um, 950)
  // a tighter default clearance in the DSN makes the padstack LARGER, never smaller
  const d = dsn(); d.structure.rule.clearances[0].value = 100
  assert.equal(ns.viaPadstackUm(d), 1050)
})

t('setViaPadstack inflates EVERY copper shape of the via and nothing else', () => {
  const d = dsn(); ns.setViaPadstack(d, 950)
  const via = d.library.padstacks[0]
  assert.deepEqual(via.shapes.map((s) => s.diameter), [950, 950], 'both copper layers')
  assert.equal(d.library.padstacks[1].shapes[0].diameter, undefined, 'pads untouched')
})

t('a padstack whose shapes are ALL the same size is still inflated (the no-op bug)', () => {
  // the hole is not a shape -- it lives in the name -- so a "skip the smallest"
  // guard skipped everything. This is the exact failure that shipped 600 twice.
  const d = dsn(); ns.setViaPadstack(d, 950)
  assert.ok(d.library.padstacks[0].shapes.every((s) => s.diameter === 950))
})

t('an explicit hole-sized shape, if present, is left alone', () => {
  const d = dsn(); d.library.padstacks[0].shapes.push({ shapeType: 'circle', layer: 'hole', diameter: 300 })
  ns.setViaPadstack(d, 950)
  assert.deepEqual(d.library.padstacks[0].shapes.map((s) => s.diameter), [950, 950, 300])
})

t('setViaClearance sets the pair types freerouting honours and NOT the ones it ignores', () => {
  const d = dsn(); ns.setViaClearance(d, ns.viaClearanceUm())
  const types = Object.fromEntries(d.structure.rule.clearances.filter((c) => c.type).map((c) => [c.type, c.value]))
  for (const k of ['via_via', 'via_pin', 'via_smd']) assert.equal(types[k], 400, k)
  for (const k of ['via_wire', 'wire_via']) assert.equal(types[k], undefined, k + ' measured as ignored by freerouting; must not be re-added')
  assert.equal(types.smd_smd, 50, 'pre-existing rules kept')
})

t('viaClearanceUm derives from the profiles (standard H0.5 pad0.5 hole0.2 -> 350 + 50 margin)', () => {
  assert.equal(ns.viaClearanceUm(), 400)
})

t('routerViaPadMm: the pad the built-in router sees keeps a 0.1mm-clearance trace outside the SHIPPED hole rule', () => {
  for (const [key, p] of Object.entries(ns.FAB_PROFILES)) {
    const pad = ns.routerViaPadMm(key)
    const hole = p.via?.hole ?? 0.2, hc = p.holeClearance ?? 0.5
    assert.ok(pad / 2 + 0.1 >= hole / 2 + hc - 1e-9, `${key}: router pad ${pad} leaves hole edge→track ${(pad / 2 + 0.1 - hole / 2).toFixed(3)} < rule ${hc}`)
    assert.ok(pad >= 0.5, `${key}: ${pad} is under the 0.5mm annular floor the pinned via was chosen for`)
  }
  assert.equal(ns.routerViaPadMm('hdi'), 0.8) // 2·(0.2/2 + 0.4 − 0.1): the number measured against
  assert.equal(ns.routerViaPadMm('no-such-profile'), 1)  // falls to the 0.2/0.5 defaults, never to 0.5 blind
})

t('the built-in rung is actually GIVEN that pad (a derived number nobody passes is a comment)', () => {
  assert.match(src, /minViaPadDiameter="\$\{viaPad\}mm" minViaHoleDiameter="\$\{viaHole\}mm"/, 'board string must template the min* props core actually copies into the route json')
  assert.doesNotMatch(src, /[^n]viaPadDiameter="\$/, 'plain viaPadDiameter is read only from pcbStyle — it never reaches the router')
  assert.match(src, /viaPad: s\.router === 'tsci' \? routerViaPadMm\(s\.profile\)/, 'ladder must pass routerViaPadMm(profile) to buildCode for tsci rungs')
  assert.doesNotMatch(src, /viaPadDiameter="0\.5mm"/, 'the old pinned literal must be gone')
})

t('emitBoardCode RUNS with the derived pad and puts it on the <board> (the first cut of this fix threw ReferenceError five minutes into a route)', () => {
  const code = ns.emitBoardCode([], [], { numLayers: 4, viaPad: ns.routerViaPadMm('hdi'), viaHole: 0.25 })
  assert.match(code, /minViaPadDiameter="0\.8mm" minViaHoleDiameter="0\.25mm"/)
  assert.match(code, /layers=\{4\}/)
  assert.doesNotMatch(ns.emitBoardCode([], [], { numLayers: 2 }), /ViaPadDiameter/, '2-layer boards stay byte-identical')
})

const twinBoard = (dx = 0.241, net2 = 'netA') => [
  { type: 'pcb_via', pcb_via_id: 'v1', pcb_trace_id: 't1', subcircuit_connectivity_map_key: 'netA', x: 1, y: 1, from_layer: 'top', to_layer: 'bottom' },
  { type: 'pcb_via', pcb_via_id: 'v2', pcb_trace_id: 't1', subcircuit_connectivity_map_key: net2, x: 1 + dx, y: 1, from_layer: 'top', to_layer: 'bottom' },
  { type: 'pcb_trace', pcb_trace_id: 't1', route: [
    { route_type: 'wire', x: 0, y: 1, layer: 'top' }, { route_type: 'wire', x: 1, y: 1, layer: 'top' },
    { route_type: 'via', x: 1, y: 1, from_layer: 'top', to_layer: 'bottom' },
    { route_type: 'wire', x: 1, y: 1, layer: 'inner1' }, { route_type: 'wire', x: 1 + dx, y: 1, layer: 'inner1' },
    { route_type: 'via', x: 1 + dx, y: 1, from_layer: 'top', to_layer: 'bottom' },
    { route_type: 'wire', x: 1 + dx, y: 1, layer: 'bottom' }, { route_type: 'wire', x: 3, y: 1, layer: 'bottom' },
  ] },
]
t('mergeStackedVias collapses a blind+buried twin into one via and re-points the route (no stub, no doubled via)', () => {
  const cj = twinBoard()
  assert.equal(ns.mergeStackedVias(cj, { maxDist: 0.6 }), 1)
  const vias = cj.filter((e) => e.type === 'pcb_via'); assert.equal(vias.length, 1); assert.equal(vias[0].x, 1)
  const r = cj.find((e) => e.type === 'pcb_trace').route
  assert.deepEqual(r.map((p) => `${p.route_type}:${p.layer || p.from_layer + '-' + p.to_layer}@${p.x}`),
    ['wire:top@0', 'wire:top@1', 'via:top-bottom@1', 'wire:bottom@1', 'wire:bottom@3'])
})
t('mergeStackedVias leaves different nets and well-separated vias alone', () => {
  const a = twinBoard(0.241, 'netB'); assert.equal(ns.mergeStackedVias(a, { maxDist: 0.6 }), 0); assert.equal(a.filter((e) => e.type === 'pcb_via').length, 2)
  const b = twinBoard(1.0); assert.equal(ns.mergeStackedVias(b, { maxDist: 0.6 }), 0); assert.equal(b.filter((e) => e.type === 'pcb_via').length, 2)
})

t('setDsnTraceRules: the DSN carries the PROFILE trace rules, in structure and net class, typed via clearances untouched', () => {
  const mk = () => ({ structure: { rule: { width: 200, clearances: [{ value: 150 }, { value: 50, type: 'smd_smd' }, { value: 400, type: 'via_via' }] } },
                      network: { classes: [{ name: 'kicad_default', rule: { width: 150, clearances: [{ value: 150 }] } }] } })
  const h = mk(); ns.setDsnTraceRules(h, 'hdi')
  assert.equal(h.structure.rule.width, 100); assert.equal(h.structure.rule.clearances.find((c) => !c.type).value, 70)
  assert.equal(h.network.classes[0].rule.width, 100); assert.equal(h.network.classes[0].rule.clearances.find((c) => !c.type).value, 70)
  assert.equal(h.structure.rule.clearances.find((c) => c.type === 'via_via').value, 400)
  assert.equal(h.structure.rule.clearances.find((c) => c.type === 'smd_smd').value, 50)
  const s = mk(); ns.setDsnTraceRules(s, 'standard'); assert.equal(s.structure.rule.width, 150); assert.equal(s.structure.rule.clearances[0].value, 100)
  for (const [k, p] of Object.entries(ns.FAB_PROFILES)) assert.ok(p.trace && p.trace.width + 2 * p.trace.clearance <= 0.25 + 1e-9 || k === 'standard', `${k}: must fit a 0.25mm LQFP pin gap`)
  const u = mk(); ns.setDsnTraceRules(u, 'no-such-profile'); assert.equal(u.structure.rule.width, 200, 'unknown profile leaves the DSN alone')
})
t('the ladder passes the rung profile to freerouting (a rule nobody passes is a comment)', () => {
  assert.match(src, /freeroute\(cj, \{ layers: s\.layers, profile: s\.profile \}\)/)
  assert.match(src, /setDsnTraceRules\(dsnPcb, profile\)/)
})

console.log(`${pass} passed`)
