#!/usr/bin/env node
/**
 * Golden board regression for the tscircuit runner.
 *
 * Why this exists. The Aug-2026 clearance/nudge work (legalizeVias margin over
 * the fab hole rule, legalizeTraces, the targeted residual pass) was validated
 * on ONE board. One board proves the path runs; it does not prove a change to
 * the router or the ground-plane step didn't quietly make dense boards worse.
 * These five fixtures are real production netlists spanning the range the
 * pipeline actually sees, and four of the five FAILED in production before the
 * fix — so a regression shows up as a board that stops converging.
 *
 * Each fixture is the {parts, nets, gnd} triple lifted verbatim from a run's
 * data/chipscale-spec.json. No prompts, no LLM, no network: the same input
 * always drives the same router path, which is what makes it a regression test.
 *
 *   tiny      6 parts / 11 nets   fast smoke
 *   baseline 13 parts / 19 nets   the board the fix was first proven on
 *   residual 12 parts / 38 nets   shipped with 1 residual DRC error (the exact
 *                                 1-5 error case the nudge pass targets)
 *   short    16 parts / 27 nets   shipped with 6 errors including a short
 *   dense    25 parts / 43 nets   densest real board on record
 *
 * Requires KiCad's kicad-cli, a JVM for freerouting, and tools/tscircuit
 * dependencies installed (npm install here). Roughly 2-4 minutes per board, so
 * this is an opt-in suite, not a per-commit CI gate.
 *
 * Usage:
 *   node golden/run-golden.mjs                 # every fixture
 *   node golden/run-golden.mjs tiny baseline   # a subset
 *   FL_GOLDEN_UPDATE=1 node golden/run-golden.mjs   # re-record baseline.json
 *
 * Exit 0 when every board meets its recorded bar, 1 otherwise.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNNER = path.join(HERE, '..', 'run_board.mjs')
const EXPECTED_PATH = path.join(HERE, 'expected.json')
const UPDATE = process.env.FL_GOLDEN_UPDATE === '1'
const TIMEOUT_MS = Number(process.env.FL_GOLDEN_TIMEOUT_MS || 480_000)

const ALL = ['tiny', 'baseline', 'residual', 'short', 'dense']
const want = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const fixtures = want.length ? want : ALL

const expected = fs.existsSync(EXPECTED_PATH)
  ? JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'))
  : {}

/** Drive run_board.mjs exactly the way the app does: JSON on stdin, JSON out. */
function runBoard(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER], { timeout: TIMEOUT_MS })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (!out.trim()) return reject(new Error(`no output (exit ${code}): ${err.slice(-400)}`))
      try {
        resolve(JSON.parse(out))
      } catch {
        reject(new Error(`unparseable output (exit ${code}): ${out.slice(0, 300)}`))
      }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

const results = []
let failed = 0

for (const name of fixtures) {
  const fx = path.join(HERE, `${name}.json`)
  if (!fs.existsSync(fx)) {
    console.error(`✗ ${name}: no fixture at ${fx}`)
    failed += 1
    continue
  }
  const spec = JSON.parse(fs.readFileSync(fx, 'utf8'))
  const started = Date.now()
  process.stdout.write(`· ${name} (${spec.parts.length} parts / ${spec.nets.length} nets) ... `)

  let r
  try {
    r = await runBoard({ ...spec, svgPath: path.join(HERE, `.out-${name}.svg`) })
  } catch (e) {
    console.log(`ERROR\n  ${e.message}`)
    failed += 1
    continue
  }

  const secs = Math.round((Date.now() - started) / 1000)
  const drc = r.drc ?? {}
  const rep = r.drcRepair ?? {}
  const got = {
    errors: drc.errors ?? null,
    unrouted: rep.unrouted ?? null,
    converged: rep.converged ?? null,
    traces: r.routedTraces ?? null,
  }
  results.push({ name, ...got, secs })

  if (UPDATE) {
    console.log(`recorded (errors ${got.errors}, unrouted ${got.unrouted}, ${secs}s)`)
    expected[name] = { maxErrors: got.errors, maxUnrouted: got.unrouted, mustConverge: got.converged === true }
    continue
  }

  // Bars, not exact equality: the router has non-deterministic timing, so a
  // board may legitimately land on a different-but-equally-clean layout. A
  // regression is MORE errors or LOST convergence, never a different route.
  const bar = expected[name] ?? { maxErrors: 0, maxUnrouted: 0, mustConverge: true }
  const problems = []
  if (got.errors === null) problems.push('no DRC result')
  else if (got.errors > bar.maxErrors) problems.push(`DRC errors ${got.errors} > ${bar.maxErrors}`)
  if (got.unrouted !== null && got.unrouted > bar.maxUnrouted) {
    problems.push(`unrouted ${got.unrouted} > ${bar.maxUnrouted}`)
  }
  if (bar.mustConverge && got.converged !== true) problems.push('did not converge')

  if (problems.length) {
    console.log(`FAIL (${secs}s)\n  ${problems.join('\n  ')}`)
    failed += 1
  } else {
    console.log(`ok (${got.errors} DRC, ${got.unrouted} unrouted, ${got.traces} traces, ${secs}s)`)
  }
}

if (UPDATE) {
  fs.writeFileSync(EXPECTED_PATH, `${JSON.stringify(expected, null, 2)}\n`)
  console.log(`\nrecorded ${Object.keys(expected).length} bars -> ${path.relative(process.cwd(), EXPECTED_PATH)}`)
  process.exit(0)
}

console.log(`\n${results.length - failed}/${fixtures.length} boards met their bar`)
for (const r of results) {
  console.log(`  ${r.name.padEnd(9)} ${String(r.errors).padStart(3)} DRC  ${String(r.unrouted).padStart(2)} unrouted  ${r.secs}s`)
}
process.exit(failed ? 1 : 0)
