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
  cut('function dsnToNLayer', '\n}\n') + '\n}\n' +
  cut('function groundChainNets', '\n}\n') + '\n}\n' +
  cut('function portPos', '\n}\n') + '\n}\n' +
  cut('function gndStubNets', '\n}\n') + '\n}\n' +
  cut('function setDsnTraceRules', '\n}\n') + '\n}\n' +
  cut('function setViaClearance', 'function viaClearanceUm') +
  cut('function inflateThtPadstacks', '\n}\n') + '\n}\n' +
  cut('function kicadModToFootprint', '\n}\n') + '\n}\n' +
  cut('function viaClearanceUm', '\n}\n') + '\n}\n' +
  cut('function emitBoardCode', '\n}\n') + '\n}\n' +
  cut('function mergeStackedVias', '\n}\n') + '\n}\n' +
  'exports.FAB_PROFILES=FAB_PROFILES;exports.setViaClearance=setViaClearance;exports.viaClearanceUm=viaClearanceUm;exports.viaPadstackUm=viaPadstackUm;exports.setDsnTraceRules=setDsnTraceRules;exports.dsnToNLayer=dsnToNLayer;exports.groundChainNets=groundChainNets;exports.gndStubNets=gndStubNets;exports.portPos=portPos;exports.routerViaPadMm=routerViaPadMm;exports.emitBoardCode=emitBoardCode;exports.mergeStackedVias=mergeStackedVias;exports.setViaPadstack=setViaPadstack;exports.inflateThtPadstacks=inflateThtPadstacks;exports.kicadModToFootprint=kicadModToFootprint;'
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

t('viaPadstackUm derives from the PROFILE: hole/2 + holeClearance - the trace clearance the DSN carries, +20um', () => {
  // JLCPCB rule (capabilities page, 2026-09-06): PTH hole to track 0.35 recommended / inner 0.3
  // hdi: 2*(100 + 300 - 70) + 20 = 680 ; standard: 2*(100 + 350 - 100) + 20 = 720
  assert.equal(ns.viaPadstackUm(dsn(), 'hdi'), 680)
  assert.equal(ns.viaPadstackUm(dsn(), 'standard'), 720)
  assert.equal(ns.viaPadstackUm(dsn()), 720, 'no profile named -> the strictest')
  assert.equal(ns.viaPadstackUm(dsn(), 'no-such-profile'), 720, 'unknown profile -> the strictest, never smaller')
  for (const [k, p] of Object.entries(ns.FAB_PROFILES)) {
    const r = ns.viaPadstackUm(dsn(), k) / 2 / 1000, rh = p.via.hole / 2, hc = p.holeClearance, tc = p.trace.clearance
    assert.ok(r + tc >= rh + hc, `${k}: copper radius ${r} + clearance ${tc} must reach hole edge ${rh} + rule ${hc}`)
  }
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
  for (const k of ['via_via', 'via_pin', 'via_smd']) assert.equal(types[k], 250, k)
  for (const k of ['via_wire', 'wire_via']) assert.equal(types[k], undefined, k + ' measured as ignored by freerouting; must not be re-added')
  assert.equal(types.smd_smd, 50, 'pre-existing rules kept')
})

t('viaClearanceUm derives from the profiles (standard hc0.35 pad0.5 hole0.2 -> 200 + 50 margin; hdi hc0.3 pad0.4 -> the same 200)', () => {
  assert.equal(ns.viaClearanceUm(), 250)
})

t('routerViaPadMm: the pad the built-in router sees keeps a 0.1mm-clearance trace outside the SHIPPED hole rule', () => {
  for (const [key, p] of Object.entries(ns.FAB_PROFILES)) {
    const pad = ns.routerViaPadMm(key)
    const hole = p.via?.hole ?? 0.2, hc = p.holeClearance ?? 0.5
    assert.ok(pad / 2 + 0.1 >= hole / 2 + hc - 1e-9, `${key}: router pad ${pad} leaves hole edge→track ${(pad / 2 + 0.1 - hole / 2).toFixed(3)} < rule ${hc}`)
    assert.ok(pad >= 0.5, `${key}: ${pad} is under the 0.5mm annular floor the pinned via was chosen for`)
  }
  assert.equal(ns.routerViaPadMm('hdi'), 0.6) // 2·(0.2/2 + 0.3 − 0.1) under the fab's 0.3mm inner-layer PTH rule
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
  assert.match(code, /minViaPadDiameter="0\.6mm" minViaHoleDiameter="0\.25mm"/)
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

t('dsnToNLayer: a through-hole PAD gets copper on every inner layer; an SMD pad stays single-layer', () => {
  const d = { structure: { layers: [{ name: 'F.Cu', type: 'signal' }, { name: 'B.Cu', type: 'signal' }] }, library: { padstacks: [
    { name: 'Round[A]Pad_1000_1700_um', shapes: [{ shapeType: 'circle', layer: 'F.Cu', diameter: 1700 }, { shapeType: 'circle', layer: 'B.Cu', diameter: 1700 }] },
    { name: 'RoundRect[T]Pad_540x640_um', shapes: [{ shapeType: 'polygon', layer: 'F.Cu' }] },
    { name: 'Via[0-1]_600:300_um', shapes: [{ shapeType: 'circle', layer: 'F.Cu', diameter: 600 }, { shapeType: 'circle', layer: 'B.Cu', diameter: 600 }] },
  ] } }
  const out = ns.dsnToNLayer(d, 4)
  const layers = (n) => out.library.padstacks.find((p) => p.name === n).shapes.map((s) => s.layer).sort()
  assert.deepEqual(layers('Round[A]Pad_1000_1700_um'), ['B.Cu', 'F.Cu', 'In1.Cu', 'In2.Cu'])
  assert.equal(out.library.padstacks.find((p) => p.name === 'Round[A]Pad_1000_1700_um').shapes.find((s) => s.layer === 'In1.Cu').diameter, 1700)
  assert.deepEqual(layers('RoundRect[T]Pad_540x640_um'), ['F.Cu'])
  assert.deepEqual(layers('Via[0-1]_600:300_um'), ['B.Cu', 'F.Cu', 'In1.Cu', 'In2.Cu'])
})

t('groundChainNets: the ground pins become one connected chain of 2-pin traces; junk pins are ignored', () => {
  assert.deepEqual(ns.groundChainNets(['U1.23', 'U1.35', 'C2.2']), [['U1.23', 'U1.35'], ['U1.35', 'C2.2']])
  assert.deepEqual(ns.groundChainNets(['U1.23']), [])
  assert.deepEqual(ns.groundChainNets(['U1.23', 14, 'GND', 'C2.2']), [['U1.23', 'C2.2']])
  assert.match(src, /input\.nets = \[\.\.\.input\.nets, \.\.\.chain\]/, 'main() must actually append the chain to the nets the router sees')
})

t('a wall kill ships the best rung so far: SIGTERM is handled, the ladder registers its best, the flush carries a board and says so', () => {
  assert.match(src, /process\.on\('SIGTERM', \(\) => \{ flushCheckpoint\(/)
  assert.match(src, /if \(best && !only\) CHECKPOINT = \(\) => \(\{ best, trail \}\)/, 'the ladder must register every new best rung (but never a retry rung)')
  const flush = cut('async function flushCheckpoint', '\n}\n')
  for (const must of ['wallHit: true', 'kicadPcb', 'drcScore(best.drc, unrouted)', "verdict: 'wall hit", 'process.exit(0)']) assert.ok(flush.includes(must), `flush must carry ${must}`)
  assert.match(src, /WALL_MS - 150_000/, 'the ladder must leave 150s of the wall for post-processing')
})

t('targeted GND retry: one stub per unreached pad to its NEAREST reached ground pad; winner-only rung on the original placement; kept only if the shipped score drops', () => {
  const cj = []
  const comp = (name, id) => cj.push({ type: 'source_component', name, source_component_id: id })
  const port = (cid, pin, spid, x, y) => { cj.push({ type: 'source_port', source_component_id: cid, pin_number: pin, name: `pin${pin}`, source_port_id: spid }); cj.push({ type: 'pcb_port', source_port_id: spid, x, y }) }
  comp('U1', 'c1'); comp('C2', 'c2'); comp('C5', 'c5')
  port('c1', 8, 'p1', 0, 0); port('c1', 47, 'p2', 10, 0); port('c2', 2, 'p3', 1, 1); port('c5', 2, 'p4', 9, 1)
  assert.deepEqual(ns.portPos(cj, 'U1.47'), { x: 10, y: 0 })
  assert.equal(ns.portPos(cj, 'U9.1'), null)
  assert.deepEqual(ns.gndStubNets(cj, ['U1.8', 'U1.47', 'C2.2', 'C5.2'], ['U1.8', 'U1.47']), [['U1.8', 'C2.2'], ['U1.47', 'C5.2']])
  assert.deepEqual(ns.gndStubNets(cj, ['U1.8', 'U1.47'], ['U1.8', 'U1.47']), [], 'no reached pad to stub to → no retry nets')
  assert.match(src, /only: strat, placeNets: input\.nets/, 'the retry re-runs the winning rung on the original placement')
  assert.match(src, /if \(after < before && sigOpen\(gp2\) <= sigOpen\(gp\)\) \{/, "the retry is accepted only when the shipped-board score improves AND no signal net opens")
  assert.match(src, /unreachedPads: Array\.isArray\(gp\.unreachedPads\)/, 'the pour must hand the runner the names of the pads it could not reach')
})

t('through-hole padstacks are inflated so copper stays hole_clearance from the HOLE: a 150um ring → +120um at standard, a 2.54mm header (350um ring) already clears the fab rule, SMD pads untouched, rule wired into freerouteReal', () => {
  const d = { library: { padstacks: [
    { name: 'Round[A]Pad_1000_1300_um', shapes: [{ shapeType: 'circle', layer: 'F.Cu', diameter: 1300 }, { shapeType: 'circle', layer: 'B.Cu', diameter: 1300 }], hole: { shape: 'circle', diameter: 1300 } },
    { name: 'Rect[A]Pad_1300x1300_um', shapes: [{ shapeType: 'polygon', layer: 'F.Cu', width: 0, coordinates: [-650, 650, 650, 650, 650, -650, -650, -650, -650, 650] }], hole: { shape: 'circle', diameter: 1000 } },
    { name: 'Oval[A]Pad_1000x1600_um', shapes: [{ shapeType: 'path', layer: 'F.Cu', width: 1300, coordinates: [0, -300, 0, 300] }], hole: { shape: 'oval', width: 1000, height: 1600 } },
    { name: 'Round[A]Pad_1000_1700_um', shapes: [{ shapeType: 'circle', layer: 'F.Cu', diameter: 1700 }], hole: { shape: 'circle', diameter: 1700 } },
    { name: 'RoundRect[T]Pad_875x250_um', shapes: [{ shapeType: 'polygon', layer: 'F.Cu', coordinates: [-437, 125, 437, 125, 437, -125, -437, -125, -437, 125] }] },
  ] } }
  const r = ns.inflateThtPadstacks(d, 'standard') // hc 350, tc 100: ring 150 → 350-100-150 = 100 + 20 margin = 120
  assert.equal(r.count, 3, 'the three thin-ring pads inflate; the 2.54mm header pad and the SMD pad do not')
  assert.equal(r.maxUm, 120)
  assert.equal(d.library.padstacks[0].shapes[0].diameter, 1540); assert.equal(d.library.padstacks[0].shapes[1].diameter, 1540)
  assert.deepEqual(d.library.padstacks[1].shapes[0].coordinates, [-770, 770, 770, 770, 770, -770, -770, -770, -770, 770])
  assert.equal(d.library.padstacks[2].shapes[0].width, 1540)
  assert.equal(d.library.padstacks[3].shapes[0].diameter, 1700, 'a 2.54mm header ring (350um) already clears the fab rule → untouched')
  assert.deepEqual(d.library.padstacks[4].shapes[0].coordinates, [-437, 125, 437, 125, 437, -125, -437, -125, -437, 125], 'SMD pad untouched')
  assert.match(src, /if \(process\.env\.FL_THT_PADSTACK !== '0'\) \{ const th = inflateThtPadstacks\(dsnPcb, profile\)/, 'freerouteReal must apply it per rung profile')
})

t('a real footprint is sized by its COURTYARD, not its pad box (terminal block: pads 7.6x2.6 → body 10x7.5); the placer takes the larger of courtyard and box', () => {
  const mod = `(footprint "TerminalBlock_2P" (layer "F.Cu")
  (fp_line (start -5 -3.75) (end 5 -3.75) (stroke (width 0.05) (type solid)) (layer "F.CrtYd"))
  (fp_line (start 5 -3.75) (end 5 3.75) (stroke (width 0.05) (type solid)) (layer "F.CrtYd"))
  (fp_line (start -2 -1) (end 2 -1) (stroke (width 0.1) (type solid)) (layer "F.SilkS"))
  (pad "1" thru_hole circle (at -2.5 0) (size 2.6 2.6) (drill 1.3) (layers "*.Cu" "*.Mask"))
  (pad "2" thru_hole circle (at 2.5 0) (size 2.6 2.6) (drill 1.3) (layers "*.Cu" "*.Mask")))`
  const fp = ns.kicadModToFootprint(mod)
  assert.equal(fp.w, 10); assert.equal(fp.h, 7.5)
  assert.match(fp.jsx, /platedhole[^>]*holeDiameter="1.3mm" outerDiameter="2.6mm"/)
  const smd = ns.kicadModToFootprint(`(footprint "R" (pad "1" smd rect (at -0.5 0) (size 0.6 0.5)) (pad "2" smd rect (at 0.5 0) (size 0.6 0.5)))`)
  assert.equal(smd.w, 1.6, 'no courtyard → pad box, as before')
  assert.match(src, /const c = courtyard\[st\.name\], p = partSize\(st\); const \[w, h\] = c \? \[Math\.max\(c\[0\], p\[0\]\), Math\.max\(c\[1\], p\[1\]\)\] : p/, 'the placer must take the larger of rendered courtyard and footprint box')
})

t('a TO-92 with `(drill 0.75 (offset …))` and rectangular THT pads parses: three plated holes as rect-pad holes, not a dropped part', () => {
  const mod = `(footprint "TO-92_HandSolder" (layer "F.Cu")
	(pad "1" thru_hole rect
		(at 0 0)
		(size 1.1 1.8)
		(drill 0.75
			(offset 0 0.4)
		)
		(layers "*.Cu" "*.Mask")
	)
	(pad "2" thru_hole roundrect
		(at 1.27 -1.27)
		(size 1.1 1.8)
		(drill 0.75
			(offset 0 -0.4)
		)
	)
	(pad "3" thru_hole oval (at 2.54 0) (size 1.1 1.8) (drill oval 0.75 1.0))
)`
  const fp = ns.kicadModToFootprint(mod)
  assert.ok(fp, 'must parse')
  assert.equal((fp.jsx.match(/<platedhole/g) || []).length, 3)
  assert.equal((fp.jsx.match(/circular_hole_with_rect_pad/g) || []).length, 3)
  assert.match(fp.jsx, /rectPadWidth="1.1mm" rectPadHeight="1.8mm"/)
  assert.equal(fp.h, 3.07, 'height spans the rect pads, not a circle of the narrow side')
})

t('a pin-1-origin footprint (2x3 header) is re-centred so its copper sits inside the box the placer keeps clear', () => {
  const mod = `(footprint "PinHeader_2x03" (layer "F.Cu")
  (fp_line (start -1.27 -1.27) (end 3.81 -1.27) (stroke (width 0.05) (type solid)) (layer "F.CrtYd"))
  (fp_line (start 3.81 6.35) (end -1.27 6.35) (stroke (width 0.05) (type solid)) (layer "F.CrtYd"))
  (pad "1" thru_hole rect (at 0 0) (size 1.7 1.7) (drill 1))
  (pad "2" thru_hole oval (at 2.54 0) (size 1.7 1.7) (drill 1))
  (pad "5" thru_hole oval (at 0 5.08) (size 1.7 1.7) (drill 1))
  (pad "6" thru_hole oval (at 2.54 5.08) (size 1.7 1.7) (drill 1)))`
  const fp = ns.kicadModToFootprint(mod)
  assert.equal(fp.w, 5.08); assert.equal(fp.h, 7.62)
  const xs = [...fp.jsx.matchAll(/pcbX="(-?[\d.]+)mm" pcbY="(-?[\d.]+)mm"/g)].map((m) => [+m[1], +m[2]])
  assert.deepEqual(xs, [[-1.27, 2.54], [1.27, 2.54], [-1.27, -2.54], [1.27, -2.54]], 'pads symmetric about the box centre (y flipped)')
})

console.log(`${pass} passed`)
