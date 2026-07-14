// Chip-scale engine stress battery — runs diverse + edge-case netlists through
// tools/tscircuit/run_board.mjs, capturing crashes / errors / timeouts / DRC.
// TMPDIR is forced onto the T9 so freerouting/DRC temp can't fill the root disk.
// The goal is BUGS (crashes, wrong handling, non-JSON output), not the known
// density-routing limits.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const RUNNER = '/Volumes/T9 Backup/EE-lab/tools/tscircuit/run_board.mjs'
const OUT = '/Volumes/T9 Backup/EE-lab/.stress/out'
const TMPDIR = '/Volumes/T9 Backup/.fl-tmp'
fs.mkdirSync(OUT, { recursive: true })

// helpers to build parts/nets tersely
const chip = (name, fp) => ({ name, footprint: fp, kind: 'chip' })
const cap = (name, lcsc) => ({ name, footprint: '0402', kind: 'capacitor', ...(lcsc ? { lcsc } : {}) })

const cases = [
  // ---- realistic designs (routing/DRC/perf) ----
  { name: '01-minimal-1chip', parts: [chip('U1', 'qfn16')], nets: [], gnd: ['U1.16', 'U1.8'] },
  { name: '02-passive-only', parts: [cap('C1'), cap('C2'), { name: 'R1', footprint: '0402', kind: 'resistor' }],
    nets: [['C1.1', 'R1.1']], gnd: ['C1.2', 'C2.2', 'R1.2'] },
  { name: '03-tiny-wireless', parts: [chip('U1', 'qfn32'), cap('C1', 'C1525'), cap('C2'), chip('L1', '0402'), cap('C3'), chip('ANT1', '0402')],
    nets: [['U1.1', 'C1.1'], ['U1.1', 'C2.1'], ['U1.28', 'L1.1'], ['L1.2', 'C3.1'], ['C3.1', 'ANT1.1']],
    gnd: ['U1.32', 'U1.31', 'C1.2', 'C2.2', 'C3.2', 'ANT1.2'] },
  { name: '04-i2c-4sensors', parts: [chip('U1', 'qfn32'), chip('U2', 'qfn16'), chip('U3', 'qfn16'), chip('U4', 'qfn8'), chip('U5', 'qfn8'), cap('C1', 'C1525'), cap('C2'), cap('C3')],
    nets: [['U1.1', 'C1.1'], ['U2.4', 'C2.1'], ['U3.4', 'C3.1'],
      ['U1.20', 'U2.1'], ['U2.1', 'U3.1'], ['U3.1', 'U4.1'], ['U4.1', 'U5.1'],
      ['U1.21', 'U2.2'], ['U2.2', 'U3.2'], ['U3.2', 'U4.2'], ['U4.2', 'U5.2'],
      ['U1.22', 'U2.3'], ['U1.23', 'U3.3']],
    gnd: ['U1.32', 'U1.31', 'U2.16', 'U3.16', 'U4.8', 'U5.8', 'C1.2', 'C2.2', 'C3.2'] },
  { name: '05-dense-mixed', parts: [chip('U1', 'qfn48'), chip('U2', 'qfn24'), chip('U3', 'qfn16'), chip('U4', 'qfn16'), chip('U5', 'qfn32'), cap('C1', 'C1525'), cap('C2'), cap('C3'), cap('C4'), cap('C5'), cap('C6'), cap('C7'), cap('C8')],
    nets: [['U1.1', 'C1.1'], ['U2.5', 'C2.1'], ['U3.4', 'C3.1'], ['U4.4', 'C4.1'], ['U5.3', 'C5.1'],
      ['U1.10', 'U2.1'], ['U1.11', 'U2.2'], ['U1.12', 'U2.3'], ['U1.13', 'U2.4'],
      ['U1.20', 'U3.1'], ['U3.1', 'U4.1'], ['U4.1', 'U5.1'],
      ['U1.21', 'U3.2'], ['U3.2', 'U4.2'], ['U4.2', 'U5.2'],
      ['U1.22', 'U3.3'], ['U1.23', 'U4.3'], ['U5.4', 'U1.5']],
    gnd: ['U1.48', 'U1.47', 'U2.24', 'U3.16', 'U4.16', 'U5.32', 'C1.2', 'C2.2', 'C3.2', 'C4.2', 'C5.2', 'C6.2', 'C7.2', 'C8.2'] },
  { name: '06-high-pin-qfn48', parts: [chip('U1', 'qfn48'), chip('U2', 'qfn48'), cap('C1'), cap('C2')],
    nets: Array.from({ length: 16 }, (_, i) => [`U1.${i + 1}`, `U2.${i + 1}`]).concat([['U1.1', 'C1.1'], ['U2.1', 'C2.1']]),
    gnd: ['U1.48', 'U1.47', 'U2.48', 'U2.47', 'C1.2', 'C2.2'] },

  // ---- edge cases (where crashes / bad handling hide) ----
  { name: '07-empty', parts: [], nets: [], gnd: [] },
  { name: '08-bad-pin', parts: [chip('U1', 'qfn8'), cap('C1')], nets: [['U1.99', 'C1.1']], gnd: ['U1.8', 'C1.2'] }, // pin 99 doesn't exist on qfn8
  { name: '09-all-ground', parts: [chip('U1', 'qfn16'), cap('C1'), cap('C2')], nets: [], gnd: ['U1.1', 'U1.2', 'U1.16', 'C1.1', 'C1.2', 'C2.1', 'C2.2'] },
  { name: '10-self-net', parts: [chip('U1', 'qfn16')], nets: [['U1.1', 'U1.1']], gnd: ['U1.16'] }, // net from a pin to itself
  { name: '11-dup-nets', parts: [chip('U1', 'qfn8'), chip('U2', 'qfn8')], nets: [['U1.1', 'U2.1'], ['U1.1', 'U2.1'], ['U1.1', 'U2.1']], gnd: ['U1.8', 'U2.8'] },
  { name: '12-missing-part', parts: [chip('U1', 'qfn8')], nets: [['U1.1', 'U9.1']], gnd: ['U1.8'] }, // U9 not in parts
  { name: '13-no-gnd', parts: [chip('U1', 'qfn8'), cap('C1')], nets: [['U1.1', 'C1.1']], gnd: [] }, // no ground net at all
  { name: '14-weird-footprint', parts: [{ name: 'U1', footprint: 'qfn999', kind: 'chip' }, cap('C1')], nets: [['U1.1', 'C1.1']], gnd: ['C1.2'] }, // nonsense footprint
]

function run(c) {
  return new Promise((resolve) => {
    const svgPath = path.join(OUT, c.name + '.svg')
    const input = JSON.stringify({ parts: c.parts, nets: c.nets, gnd: c.gnd, svgPath })
    const t0 = Date.now()
    const py = spawn('node', [RUNNER], { timeout: 300000, env: { ...process.env, TMPDIR } })
    let out = '', err = ''
    py.stdout.on('data', (d) => (out += d))
    py.stderr.on('data', (d) => (err += d))
    py.on('error', (e) => resolve({ name: c.name, verdict: 'SPAWN-ERROR', error: String(e) }))
    py.on('close', (code, signal) => {
      const ms = Date.now() - t0
      let result = null
      try { result = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || 'null') } catch { /* non-json */ }
      // classify: CRASH = non-zero exit + no clean JSON error; ERROR = clean {error}; TIMEOUT = killed by signal;
      // OK/DRC = produced a board. Malformed-input cases SHOULD produce a clean {error}, not crash.
      let verdict
      if (signal === 'SIGTERM') verdict = 'TIMEOUT'
      else if (!result) verdict = 'CRASH-NO-JSON'
      else if (result.error) verdict = 'CLEAN-ERROR'
      else if (result.boardMm) verdict = result.ok ? 'ROUTED-CLEAN' : 'BUILT-WITH-DRC'
      else verdict = 'UNKNOWN'
      resolve({
        name: c.name, verdict, code, signal, ms,
        ok: result?.ok ?? null, error: result?.error ?? null,
        boardMm: result?.boardMm ?? null, components: result?.components ?? null,
        drcErrors: result?.drc?.errors ?? null,
        stderrTail: (verdict === 'CRASH-NO-JSON' || verdict === 'SPAWN-ERROR') ? err.slice(-500) : undefined,
      })
    })
    py.stdin.write(input)
    py.stdin.end()
  })
}

const report = []
for (const c of cases) {
  const r = await run(c)
  report.push(r)
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${r.name}: ${r.verdict}${r.error ? ' — ' + String(r.error).slice(0, 80) : ''}${r.boardMm ? ` (${r.boardMm.w}x${r.boardMm.h}mm, drc=${r.drcErrors})` : ''} ${Math.round(r.ms / 1000)}s`)
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
}
const crashes = report.filter((r) => r.verdict === 'CRASH-NO-JSON' || r.verdict === 'SPAWN-ERROR' || r.verdict === 'UNKNOWN')
console.log(`\nDONE ${report.length} cases. Crashes/unknowns: ${crashes.length} — ${crashes.map((c) => c.name).join(', ') || 'none'}`)
