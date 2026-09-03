#!/usr/bin/env node
/**
 * Replay the mechanical cavity selection against the two production runs whose
 * fitCheck was wrong (⌀6 mount hole chosen for a 30×24 board; 34×22 display
 * window chosen over a round puck cavity).
 *
 * The plan was never persisted for those runs (that is what this fix adds:
 * mechanical/plan.json), so the stored inputs alone cannot be replayed. This
 * script reads the REAL board geometry + the stored (wrong) fitCheck +
 * opsRendered names from the run dirs (READ-ONLY), rebuilds a synthetic plan
 * that mirrors those op names/shapes, verifies the OLD picker reproduces the
 * stored wrong cavity, then shows what the NEW selectCavity/evaluateFit return.
 *
 *   node scripts/replay-cavity.mjs [runsRoot]
 *   runsRoot defaults to the T9 backup runs dir.
 *
 * Requires Node ≥ 23.6 (native TypeScript type stripping for the lib import).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { selectCavity, evaluateFit, shapeStr, profileToShape, shapeArea } from '../lib/mechanical-plan.ts'

const RUNS_ROOT = process.argv[2] || '/Volumes/T9 Backup/EE-lab/software/prompt-to-pcb-ui/public/runs'
const WALL = 1.5, CLEARANCE = 1.0, SLACK = 0.5

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
function findRun(prefix) {
  if (!existsSync(RUNS_ROOT)) return null
  const d = readdirSync(RUNS_ROOT).find((n) => n.startsWith(prefix))
  return d ? path.join(RUNS_ROOT, d) : null
}

/** the OLD picker, verbatim logic from app/api/mechanical/route.ts (pre-fix) */
function oldPickCavity(plan) {
  const sketchProf = (name) => plan.operations.find((o) => o.op === 'sketch' && o.name === name)?.profile ?? null
  const firstExtrude = plan.operations.find((o) => o.op === 'extrude')
  const baseTop = firstExtrude ? (firstExtrude.offset ?? 0) + (firstExtrude.depth ?? 0) : Infinity
  const basePockets = plan.operations.filter((o) => o.op === 'pocket')
    .filter((p) => (p.offset ?? 0) < baseTop - 0.01)
    .map((p) => ({ shape: profileToShape(sketchProf(p.sketch)), depth: p.depth ?? 0, op: p.name }))
    .filter((p) => !!p.shape)
  const maxDepth = basePockets.reduce((m, p) => Math.max(m, p.depth), 0)
  return basePockets.filter((p) => p.depth >= maxDepth * 0.5).sort((a, b) => shapeArea(b.shape) - shapeArea(a.shape))[0] ?? null
}

function outerOf(plan) {
  const firstExtrude = plan.operations.find((o) => o.op === 'extrude')
  const prof = plan.operations.find((o) => o.op === 'sketch' && o.name === firstExtrude?.sketch)?.profile
    ?? plan.operations.find((o) => o.op === 'sketch')?.profile
  return profileToShape(prof ?? null)
}

function boardShape(cs) {
  const bs = cs?.boardShape
  if (bs?.type === 'circle' && bs.diameterMm > 0) return { kind: 'circle', d: bs.diameterMm }
  return { kind: 'rect', w: cs.boardMm.w, h: cs.boardMm.h }
}

const sk = (name, profile) => ({ op: 'sketch', name, plane: 'top', profile })
const rect = (w, h, cx = 0, cy = 0) => ({ kind: 'roundedRect', cx, cy, w, h, r: 1 })
const circ = (d, cx = 0, cy = 0) => ({ kind: 'circle', cx, cy, d })
const ring = (dOuter, dInner) => ({ kind: 'ring', cx: 0, cy: 0, dOuter, dInner })
const ex = (name, sketch, depth, offset) => ({ op: 'extrude', name, sketch, depth, ...(offset != null ? { offset } : {}) })
const pk = (name, sketch, depth, offset) => ({ op: 'pocket', name, sketch, depth, ...(offset != null ? { offset } : {}) })

/** run-530f17f3: bare PCB assembly (ID: "no consumer enclosure"), outer 220×160,
 *  opsRendered: boardOutline, board, mountHole1..4(Sk), analogGuardZoneSk,
 *  analogGuardScore, frontEdgeCableAccess, conn*, led*, resetBtnSk, resetBtnRecess,
 *  resetButton, relayMatrixBank, stepperDriverHeatsink, controllerIC — NO cavity. */
function synth530(outer) {
  const ops = [sk('boardOutline', rect(outer.w, outer.h)), ex('board', 'boardOutline', 35)]
  const hp = [[-100, 70], [100, 70], [100, -70], [-100, -70]]
  hp.forEach(([x, y], i) => {
    ops.push(sk(`mountHole${i + 1}Sk`, circ(6, x, y)), pk(`mountHole${i + 1}`, `mountHole${i + 1}Sk`, 35, 0))
  })
  ops.push(sk('analogGuardZoneSk', rect(60, 0.6, -40, 20)), pk('analogGuardScore', 'analogGuardZoneSk', 0.3, 34.7))
  ops.push({ op: 'cutout', name: 'frontEdgeCableAccess', face: 'front', cx: 0, cy: 5, w: 30, h: 6, depth: 3, offsetMm: 78 })
  ops.push(sk('resetBtnSk', circ(8, 90, -60)), pk('resetBtnRecess', 'resetBtnSk', 2, 33))
  ops.push({ op: 'component', name: 'resetButton', kind: 'generic', shape: 'cyl', cx: 90, cy: -60, cz: 33, w: 6, h: 6, thickness: 2 })
  ops.push({ op: 'component', name: 'controllerIC', kind: 'generic', shape: 'box', cx: 0, cy: 0, cz: 35, w: 12, h: 12, thickness: 1 })
  return { part: 'FL-1 Mainboard v1', units: 'mm', operations: ops }
}

/** run-e5631ea3: round puck, skirt extruded first, named cavity/innerCavity,
 *  34×22 displayWindow pocket in the fascia, ring pockets, pad recess, lid. */
function synth563(outer) {
  const ops = [
    sk('skirtOutline', circ(outer.d)), ex('skirtBody', 'skirtOutline', 20),
    sk('baseOutline', circ(58)), ex('body', 'baseOutline', 24, 0),
    sk('cavity', circ(27)), pk('innerCavity', 'cavity', 16, 2),
    { op: 'standoff', name: 'mount1', x: 2.87, y: -7.9, height: 3, od: 4.5, holeDia: 1.7, baseZ: 2 },
    { op: 'standoff', name: 'mount2', x: 5.4, y: 6.44, height: 3, od: 4.5, holeDia: 1.7, baseZ: 2 },
    { op: 'standoff', name: 'mount3', x: -8.28, y: 1.46, height: 3, od: 4.5, holeDia: 1.7, baseZ: 2 },
    sk('fasciaTiltCut', rect(58, 30, 0, 20)), pk('fasciaTilt', 'fasciaTiltCut', 6, 18),
    sk('displayWindow', rect(34, 22)), pk('displayWindowCut', 'displayWindow', 8, 12),
    sk('bezelStep', rect(36, 24)), pk('bezelStepCut', 'bezelStep', 1, 19),
    { op: 'cutout', name: 'usbPort', face: 'front', cx: 0, cy: 6.9, w: 10, h: 4, depth: 3, offsetMm: 12.5 },
    sk('regLip', ring(60, 27.5)), pk('regLipCut', 'regLip', 1.3, 18.8),
    { op: 'fillet', name: 'skirtBottomRound', body: 'skirtBody', radiusMm: 0.8, scope: 'outer-bottom' },
    sk('padRecess', circ(56)), pk('padRecessCut', 'padRecess', 0.5, 0),
    sk('lidOutline', circ(58)), ex('lid', 'lidOutline', 3, 24),
    sk('lidGroove', ring(58, 26)), pk('lidGrooveCut', 'lidGroove', 1.4, 24),
    sk('touchPad', circ(20)), sk('touchPadRing', ring(22, 20)),
    { op: 'fillet', name: 'lidTopRound', body: 'lid', radiusMm: 1.5, scope: 'outer-top' },
    { op: 'component', name: 'PCB', kind: 'pcb', shape: 'cyl', cx: 0, cy: 0, cz: 5, w: 25, h: 25, thickness: 1.6 },
    { op: 'component', name: 'battery', kind: 'battery', shape: 'cyl', cx: 0, cy: 0, cz: 8, w: 20, h: 20, thickness: 3 },
    { op: 'component', name: 'antenna', kind: 'antenna', shape: 'box', cx: 0, cy: 9, cz: 7, w: 8, h: 3, thickness: 0.5 },
  ]
  return { part: 'Puck Desk Thermometer', units: 'mm', operations: ops }
}

let failures = 0
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++ }

function run(label, plan, pcb, expect) {
  console.log(`\n=== ${label}`)
  const outer = outerOf(plan)
  const old = oldPickCavity(plan)
  console.log(`  OLD picker  → cavity ${old ? `${shapeStr(old.shape)} (${old.op})` : 'null'}`)
  const sel = selectCavity(plan, pcb, CLEARANCE)
  const ev = evaluateFit({ pcb, cavity: sel.shape, outer, wall: WALL, slack: SLACK, cavitySelection: sel })
  console.log(`  NEW picker  → cavity ${sel.shape ? shapeStr(sel.shape) : 'null'} source=${sel.source} op=${sel.op} depth=${sel.depth}`)
  console.log(`  NEW verdict → ${ev.verdict}  fits=${ev.fits}`)
  for (const p of ev.problems) console.log(`    problem: ${p}`)
  console.log('  candidates:')
  for (const c of sel.candidates) console.log(`    - ${c.op.padEnd(18)} ${c.shape ? shapeStr(c.shape).padEnd(9) : '(ring)'.padEnd(9)} z=${c.offset}+${c.depth}  ${c.rejected ? 'rejected: ' + c.rejected : '<< CHOSEN'}`)
  if (expect.oldCavity !== undefined) check((old ? shapeStr(old.shape) : null) === expect.oldCavity, `old picker reproduces the stored wrong cavity (${expect.oldCavity})`)
  check(sel.source === expect.source, `cavitySource === '${expect.source}'`)
  if (expect.cavity !== undefined) check((sel.shape ? shapeStr(sel.shape) : null) === expect.cavity, `cavity === ${expect.cavity}`)
  check(ev.verdict === expect.verdict, `verdict === '${expect.verdict}'`)
  check(ev.fits === expect.fits, `fits === ${expect.fits}`)
  if (expect.problemRe) check(ev.problems.some((p) => expect.problemRe.test(p)), `problem matches ${expect.problemRe}`)
}

// ---- production run 1: 30×24 rect board, bare assembly, ⌀6 was chosen ----
{
  const dir = findRun('run-530f17f3')
  let pcb = { kind: 'rect', w: 29.9, h: 24.1 }, stored = { cavityMm: { w: 6, h: 6 }, enclosureMm: { w: 220, h: 160 } }
  if (dir) {
    pcb = boardShape(readJson(path.join(dir, 'electronics', 'chipscale-board.json')))
    stored = readJson(path.join(dir, 'mechanical', 'mechanical.json')).fitCheck
    console.log(`\nloaded ${dir}\n  stored fitCheck: fits=${stored.fits} cavityMm=${JSON.stringify(stored.cavityMm)} enclosureMm=${JSON.stringify(stored.enclosureMm)} pcb=${shapeStr(pcb)}`)
  } else console.log('\n(run-530f17f3 not found under runsRoot — using values copied from the stored mechanical.json)')
  run('run-530f17f3 — 30×24 board, bare PCB assembly (no cavity in plan)', synth530(stored.enclosureMm), pcb,
    { oldCavity: `⌀${stored.cavityMm.w}`, source: 'none', cavity: null, verdict: 'unknown', fits: true, problemRe: /no board cavity identified/ })
}

// ---- production run 2: ⌀25 round board, puck with named cavity; 34×22 window won ----
{
  const dir = findRun('run-e5631ea3')
  let pcb = { kind: 'circle', d: 25.21 }, stored = { cavityMm: { w: 34, h: 22 }, enclosureMm: { w: 62, h: 62 } }
  if (dir) {
    pcb = boardShape(readJson(path.join(dir, 'electronics', 'chipscale-board.json')))
    stored = readJson(path.join(dir, 'mechanical', 'mechanical.json')).fitCheck
    console.log(`\nloaded ${dir}\n  stored fitCheck: fits=${stored.fits} cavityMm=${JSON.stringify(stored.cavityMm)} enclosureMm=${JSON.stringify(stored.enclosureMm)} pcb=${shapeStr(pcb)}`)
  } else console.log('\n(run-e5631ea3 not found under runsRoot — using values copied from the stored mechanical.json)')
  run('run-e5631ea3 — ⌀25 board, puck with named cavity + 34×22 display window', synth563({ kind: 'circle', d: stored.enclosureMm.w }), pcb,
    { oldCavity: `${stored.cavityMm.w}×${stored.cavityMm.h}`, source: 'named', cavity: '⌀27', verdict: 'fits', fits: true })
}

// ---- edge cases ----
run('named cavity TOO SMALL (28×20 for 30×24) → does_not_fit with shortfall', {
  part: 'x', units: 'mm', operations: [
    sk('baseOutline', rect(40, 34)), ex('body', 'baseOutline', 12),
    sk('cavity', rect(28, 20)), pk('innerCavity', 'cavity', 9, 1.5),
    { op: 'component', name: 'PCB', kind: 'pcb', shape: 'box', cx: 0, cy: 0, cz: 3, w: 30, h: 24, thickness: 1.6 },
  ],
}, { kind: 'rect', w: 30, h: 24 }, { source: 'named', cavity: '28×20', verdict: 'does_not_fit', fits: false, problemRe: /short by 1\.5 mm in X, 3\.5 mm in Y/ })

run('round ⌀25 board vs unnamed 34×22 rect pocket (narrow-side rule)', {
  part: 'x', units: 'mm', operations: [
    sk('baseOutline', circ(62)), ex('body', 'baseOutline', 20),
    sk('pocketSk', rect(34, 22)), pk('mainPocket', 'pocketSk', 12, 2),
    { op: 'component', name: 'PCB', kind: 'pcb', shape: 'cyl', cx: 0, cy: 0, cz: 5, w: 25, h: 25, thickness: 1.6 },
  ],
}, { kind: 'circle', d: 25 }, { source: 'none', cavity: null, verdict: 'unknown', fits: true, problemRe: /no board cavity identified/ })

run('round ⌀25 board vs unnamed ⌀27 pocket enclosing the PCB op → encloses_pcb', {
  part: 'x', units: 'mm', operations: [
    sk('baseOutline', circ(62)), ex('body', 'baseOutline', 20),
    sk('pocketSk', circ(27)), pk('mainPocket', 'pocketSk', 12, 2),
    { op: 'component', name: 'PCB', kind: 'pcb', shape: 'cyl', cx: 0, cy: 0, cz: 5, w: 25, h: 25, thickness: 1.6 },
  ],
}, { kind: 'circle', d: 25 }, { source: 'encloses_pcb', cavity: '⌀27', verdict: 'fits', fits: true })

run('unnamed 32×26 pocket, no PCB op → largest_qualifying; 30×24 fits', {
  part: 'x', units: 'mm', operations: [
    sk('baseOutline', rect(40, 34)), ex('body', 'baseOutline', 12),
    sk('bigSk', rect(32, 26)), pk('mainPocket', 'bigSk', 9, 1.5),
    sk('holeSk', circ(6)), pk('screwHole1', 'holeSk', 12, 0),
  ],
}, { kind: 'rect', w: 30, h: 24 }, { source: 'largest_qualifying', cavity: '32×26', verdict: 'fits', fits: true })

run('round board ⌀25 vs named rect cavity 34×22 → does_not_fit (spec item 4)', {
  part: 'x', units: 'mm', operations: [
    sk('baseOutline', circ(62)), ex('body', 'baseOutline', 20),
    sk('cavity', rect(34, 22)), pk('innerCavity', 'cavity', 12, 2),
  ],
}, { kind: 'circle', d: 25 }, { source: 'named', cavity: '34×22', verdict: 'does_not_fit', fits: false, problemRe: /narrow side 22 mm by 2\.5 mm/ })

run("'cavityVent' 10×3 beside a 'pcbCavity' → exact name wins, vent ignored", {
  part: 'x', units: 'mm', operations: [
    sk('baseOutline', rect(40, 34)), ex('body', 'baseOutline', 12),
    sk('cavityVentSk', rect(10, 3, 0, 15)), pk('cavityVent', 'cavityVentSk', 12, 0),
    sk('pcbCavity', rect(32, 26)), pk('cavityPocket', 'pcbCavity', 9, 1.5),
  ],
}, { kind: 'rect', w: 30, h: 24 }, { source: 'named', cavity: '32×26', verdict: 'fits', fits: true })

run("only a 'cavityVent' 10×3 pocket → NOT a named cavity → unknown, never does_not_fit", {
  part: 'x', units: 'mm', operations: [
    sk('baseOutline', rect(40, 34)), ex('body', 'baseOutline', 12),
    sk('cavityVentSk', rect(10, 3, 0, 15)), pk('cavityVent', 'cavityVentSk', 12, 0),
  ],
}, { kind: 'rect', w: 30, h: 24 }, { source: 'none', cavity: null, verdict: 'unknown', fits: true })

console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all checks passed'}`)
process.exit(failures ? 1 : 0)
