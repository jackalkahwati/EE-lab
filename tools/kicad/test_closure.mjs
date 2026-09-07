// Regression: the DRC closure repairs the four residual clearance faults on the
// board run 0b84f5be shipped (2026-09-06) to zero, with no new opens. Needs
// KiCad (pcbnew python + kicad-cli); skips honestly without them.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const KPY = process.env.FL_KICAD_PYTHON || '/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3'
const KC = process.env.FL_KICAD_CLI || '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
if (!fs.existsSync(KPY) || !fs.existsSync(KC)) { console.log('SKIP: KiCad not installed'); process.exit(0) }

const fx = path.join(here, 'tests/fixtures/closure-run0b84f5be')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-closure-test-'))
const inPcb = path.join(dir, 'in.kicad_pcb'), outPcb = path.join(dir, 'out.kicad_pcb'), outJson = path.join(dir, 'out.json')
fs.copyFileSync(path.join(fx, 'board.kicad_pcb'), inPcb)
fs.copyFileSync(path.join(fx, 'board.kicad_dru'), path.join(dir, 'out.kicad_dru'))

const before = JSON.parse(fs.readFileSync(path.join(fx, 'board.drc.json'), 'utf8'))
if (before.violations.length !== 4) { console.error(`fixture drifted: ${before.violations.length} violations`); process.exit(1) }

const r = spawnSync(KPY, [path.join(here, 'drc_closure.py'), inPcb, outPcb, path.join(fx, 'board.drc.json'), '0.09', '0.35'], { encoding: 'utf8' })
const info = JSON.parse(r.stdout.trim().split('\n').pop())
const d = spawnSync(KC, ['pcb', 'drc', '--format', 'json', '--severity-error', '--output', outJson, outPcb], { encoding: 'utf8' })
if (!fs.existsSync(outJson)) { console.error('kicad-cli drc produced no report', d.stderr); process.exit(1) }
const after = JSON.parse(fs.readFileSync(outJson, 'utf8'))
const opens = after.unconnected_items?.length ?? 0
let fails = 0
const check = (ok, msg) => { console.log(`${ok ? 'ok' : 'FAIL'} - ${msg}`); if (!ok) fails++ }
check(info.attempted === 4, `closure attempted all 4 violations (${info.attempted})`)
check(after.violations.length === 0, `shipped board repaired to 0 violations (${after.violations.length})`)
check(opens === 0, `no open nets introduced (${opens})`)
check((info.unreachedPads || []).length === 0, 'no ground pad stranded')
check(Object.values(info.fixed).reduce((a, b) => a + b, 0) >= 3, `repairs were edits, not deletions: ${JSON.stringify(info.fixed)}`)
fs.rmSync(dir, { recursive: true, force: true })
process.exit(fails ? 1 : 0)
