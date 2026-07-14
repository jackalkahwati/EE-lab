// Extended stress battery — new designs that exercise paths the first battery
// didn't: high fan-out hubs, freerouting-favorable sparse boards, many-passive
// placement, wide shared buses, two-hub topologies, rotation-needing parts.
// Same classification + T9-temp discipline as stress-run.mjs.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const RUNNER = '/Volumes/T9 Backup/EE-lab/tools/tscircuit/run_board.mjs'
const OUT = '/Volumes/T9 Backup/EE-lab/.stress/out2'
const TMPDIR = '/Volumes/T9 Backup/.fl-tmp'
fs.mkdirSync(OUT, { recursive: true })

const chip = (name, fp) => ({ name, footprint: fp, kind: 'chip' })
const cap = (name) => ({ name, footprint: '0402', kind: 'capacitor' })

const cases = [
  // A) star hub: one SoC fanning out to 10 small peripherals (high fan-out routing)
  {
    name: 'A-star-hub',
    parts: [chip('U1', 'qfn48'), ...Array.from({ length: 10 }, (_, i) => chip(`U${i + 2}`, 'qfn8')), cap('C1')],
    nets: Array.from({ length: 10 }, (_, i) => [`U1.${i + 1}`, `U${i + 2}.1`])
      .concat(Array.from({ length: 10 }, (_, i) => [`U1.${i + 11}`, `U${i + 2}.2`]))
      .concat([['U1.1', 'C1.1']]),
    gnd: ['U1.48', 'C1.2', ...Array.from({ length: 10 }, (_, i) => `U${i + 2}.8`)],
  },
  // B) sparse + spread: 4 chips, few long nets — the case freerouting SHOULD win
  {
    name: 'B-sparse-long',
    parts: [chip('U1', 'qfn16'), chip('U2', 'qfn16'), chip('U3', 'qfn16'), chip('U4', 'qfn16')],
    nets: [['U1.1', 'U4.1'], ['U2.1', 'U3.1'], ['U1.8', 'U3.8']],
    gnd: ['U1.16', 'U2.16', 'U3.16', 'U4.16'],
  },
  // C) many passives: 20x 0402 in a decoupling swarm on one SoC rail
  {
    name: 'C-20-passives',
    parts: [chip('U1', 'qfn32'), ...Array.from({ length: 20 }, (_, i) => cap(`C${i + 1}`))],
    nets: Array.from({ length: 20 }, (_, i) => [`U1.${(i % 30) + 1}`, `C${i + 1}.1`]),
    gnd: ['U1.32', 'U1.31', ...Array.from({ length: 20 }, (_, i) => `C${i + 1}.2`)],
  },
  // D) wide shared bus: SDA + SCL daisy-chained across 8 sensors
  {
    name: 'D-wide-bus',
    parts: [chip('U1', 'qfn24'), ...Array.from({ length: 8 }, (_, i) => chip(`U${i + 2}`, 'qfn8'))],
    nets: [
      ['U1.1', 'U2.1'], ...Array.from({ length: 7 }, (_, i) => [`U${i + 2}.1`, `U${i + 3}.1`]),
      ['U1.2', 'U2.2'], ...Array.from({ length: 7 }, (_, i) => [`U${i + 2}.2`, `U${i + 3}.2`]),
    ],
    gnd: ['U1.24', ...Array.from({ length: 8 }, (_, i) => `U${i + 2}.8`)],
  },
  // E) two hubs: two SoCs cross-connected by a bus + each with local peripherals
  {
    name: 'E-two-hub',
    parts: [chip('U1', 'qfn32'), chip('U2', 'qfn32'), chip('U3', 'qfn8'), chip('U4', 'qfn8'), chip('U5', 'qfn8'), chip('U6', 'qfn8'), cap('C1'), cap('C2')],
    nets: [
      ['U1.10', 'U2.10'], ['U1.11', 'U2.11'], ['U1.12', 'U2.12'], ['U1.13', 'U2.13'],
      ['U1.1', 'U3.1'], ['U1.2', 'U4.1'], ['U2.1', 'U5.1'], ['U2.2', 'U6.1'],
      ['U1.20', 'C1.1'], ['U2.20', 'C2.1'],
    ],
    gnd: ['U1.32', 'U2.32', 'U3.8', 'U4.8', 'U5.8', 'U6.8', 'C1.2', 'C2.2'],
  },
  // F) rotation-needing: several qfn8 in a tight row (packer must rotate to fit)
  {
    name: 'F-rotate-row',
    parts: Array.from({ length: 6 }, (_, i) => chip(`U${i + 1}`, 'qfn8')),
    nets: Array.from({ length: 5 }, (_, i) => [`U${i + 1}.4`, `U${i + 2}.5`]),
    gnd: Array.from({ length: 6 }, (_, i) => `U${i + 1}.8`),
  },
]

function run(c) {
  return new Promise((resolve) => {
    const svgPath = path.join(OUT, c.name + '.svg')
    const input = JSON.stringify({ parts: c.parts, nets: c.nets, gnd: c.gnd, svgPath })
    const t0 = Date.now()
    const py = spawn('node', [RUNNER], { timeout: 350000, env: { ...process.env, TMPDIR } })
    let out = '', err = ''
    py.stdout.on('data', (d) => (out += d))
    py.stderr.on('data', (d) => (err += d))
    py.on('error', (e) => resolve({ name: c.name, verdict: 'SPAWN-ERROR', error: String(e) }))
    py.on('close', (code, signal) => {
      const ms = Date.now() - t0
      let r = null
      try { r = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || 'null') } catch { /* non-json */ }
      let verdict
      if (signal === 'SIGTERM') verdict = 'TIMEOUT'
      else if (!r) verdict = 'CRASH-NO-JSON'
      else if (r.error) verdict = 'CLEAN-ERROR'
      else if (r.boardMm) verdict = r.ok ? 'ROUTED-CLEAN' : 'BUILT-WITH-DRC'
      else verdict = 'UNKNOWN'
      resolve({ name: c.name, verdict, parts: c.parts.length, nets: c.nets.length, ms, boardMm: r?.boardMm, drc: r?.drc?.errors, viaLegal: r?.drcRepair?.viaLegalization, stderrTail: (verdict === 'CRASH-NO-JSON') ? err.slice(-400) : undefined })
    })
    py.stdin.write(input); py.stdin.end()
  })
}

const report = []
for (const c of cases) {
  const r = await run(c)
  report.push(r)
  console.log(`${r.name} (${r.parts}p/${r.nets}n): ${r.verdict}${r.boardMm ? ` ${r.boardMm.w}x${r.boardMm.h}mm drc=${r.drc}` : ''}${r.viaLegal ? ` [vlegal ${r.viaLegal.errorsBefore}->${r.viaLegal.errorsAfter}]` : ''} ${Math.round(r.ms / 1000)}s`)
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
}
const bad = report.filter((r) => ['CRASH-NO-JSON', 'SPAWN-ERROR', 'UNKNOWN', 'TIMEOUT'].includes(r.verdict))
console.log(`\nDONE ${report.length}. Crashes/timeouts: ${bad.length} — ${bad.map((b) => `${b.name}:${b.verdict}`).join(', ') || 'none'}`)
