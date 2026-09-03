#!/usr/bin/env node
/**
 * Standing density benchmark for the chip-scale board engine.
 *
 * Generates a parametric synthetic board — one MCU + a realistic mix of I2C
 * peripherals with per-IC decoupling (the shape real products take) — at the
 * requested part counts and runs it through run_board.mjs exactly as the
 * pipeline does. Reports routed/DRC/strategy/time per size, so every routing
 * change gets a before/after NUMBER instead of vibes.
 *
 *   node bench_density.mjs 12 16 20          # part counts to test
 *   FL_DENSE_4L=0 node bench_density.mjs 16  # A/B the old ladder
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Synthetic-but-realistic board: U1 MCU (qfn32), I2C bus shared by k sensor
 *  ICs (qfn8), one INT line each, one 0402 decoupling cap per IC, one bulk
 *  cap. Total parts = 2 (MCU+bulk) + 2k (sensor + its cap). */
function makeBoard(nParts) {
  const k = Math.max(1, Math.floor((nParts - 2) / 2))
  const parts = [
    { name: 'U1', footprint: 'qfn32', kind: 'chip' },
    { name: 'C0', footprint: '0402', kind: 'capacitor' },
  ]
  const nets = [
    ['U1.1', 'C0.1'], // rail bulk
  ]
  const gnd = ['U1.17', 'C0.2']
  for (let i = 0; i < k; i++) {
    const u = `S${i + 1}`
    const c = `C${i + 1}`
    parts.push({ name: u, footprint: 'qfn8', kind: 'chip' })
    parts.push({ name: c, footprint: '0402', kind: 'capacitor' })
    // shared I2C bus back to the MCU (pins 2/3), per-device INT, power+cap
    nets.push([`U1.2`, `${u}.1`])          // SDA leg
    nets.push([`U1.3`, `${u}.2`])          // SCL leg
    nets.push([`U1.${4 + (i % 12)}`, `${u}.3`]) // INT to a distinct MCU pin
    nets.push([`${u}.4`, `${c}.1`])        // local rail to decoupling cap
    gnd.push(`${u}.5`, `${c}.2`)
  }
  return { parts, nets, gnd, boardShape: { type: 'rect' }, mountingHoles: { count: 0, holeDiaMm: 2.2 } }
}

function runBoard(payload) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(HERE, 'run_board.mjs')], { timeout: 600_000 })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', () => {})
    p.on('error', reject)
    p.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop() || '{}')) }
      catch { reject(new Error('runner produced no JSON')) }
    })
    p.stdin.write(JSON.stringify({ ...payload, svgPath: '/tmp/bench-density.svg' }))
    p.stdin.end()
  })
}

const sizes = process.argv.slice(2).map(Number).filter((n) => n >= 4)
if (!sizes.length) {
  console.error('usage: node bench_density.mjs <parts> [parts...]')
  process.exit(2)
}
console.log(`density benchmark (FL_DENSE_4L=${process.env.FL_DENSE_4L ?? '1(default)'})`)
for (const n of sizes) {
  const payload = makeBoard(n)
  const t0 = Date.now()
  try {
    const r = await runBoard(payload)
    const secs = ((Date.now() - t0) / 1000).toFixed(0)
    const et = Object.entries(r.drc?.errorTypes ?? {})
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k}:${v}`).join(' ') || '-'
    console.log(
      `parts=${payload.parts.length} nets=${payload.nets.length} | ` +
      `ok=${r.ok} drcErrors=${r.drc?.errors ?? '?'} layers=${r.layers ?? '?'} | ` +
      `${r.boardMm ? `${r.boardMm.w}x${r.boardMm.h}mm` : 'no board'} | ` +
      `top: ${et} | ${secs}s`)
  } catch (e) {
    console.log(`parts=${payload.parts.length} | FAILED: ${String(e).slice(0, 80)}`)
  }
}
