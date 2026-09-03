/**
 * Design-correctness gate + functional-wiring — the shared bridge to the Python
 * planner's `functional_wire.py` (adds the application signal chains per-IC bus
 * synthesis omits) and `design_check.py` (verifies the netlist is actually wired
 * to work, not just DRC-clean). Both the headless v1 jobs path (lib/v1-jobs.ts)
 * and the INTERACTIVE pipeline (app/api/pipeline/run/route.ts) call these, so a
 * board can't ship hollow from either entry point.
 *
 * Everything here is fail-SAFE: if the Python can't run, callers get null and
 * treat it as "don't block" — a broken gate never wedges the pipeline. The HARD
 * block is only on an actual GATE FAIL verdict.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

function plannerDir(): string {
  return path.join(process.cwd(), '..', '..', 'hardware', 'planner')
}

/** Functional-wiring synthesis: adds the application signal chains (mux->ADC,
 *  MCU drives mux select, reference->channel, input/host connectors, module
 *  flag) the per-IC bus/power synthesis omits. Mutates the spec file in place;
 *  conservative (only wires patterns it matches, no-op otherwise). Best-effort. */
export async function runFunctionalWire(specPath: string, prompt: string): Promise<number> {
  const dir = plannerDir()
  return new Promise((resolve) => {
    let py
    try {
      py = spawn(process.env.FL_PYTHON || 'python3',
        [path.join(dir, 'functional_wire.py'), specPath, path.join(dir, 'design_rules.json'), prompt],
        { timeout: 25_000 })
    } catch { resolve(0); return }
    let out = ''
    py.stdout.on('data', (d) => (out += d))
    py.on('error', () => resolve(0))
    py.on('close', () => {
      const m = out.match(/FUNCWIRE (\d+)/)
      resolve(m ? Number(m[1]) : 0)
    })
  })
}

/** The design-correctness gate. Returns {pass, failCount, warnCount, summary},
 *  or null if the gate itself couldn't run (Python missing / script absent) —
 *  callers treat null as "don't block". */
export async function runDesignGate(
  specPath: string,
  prompt: string,
): Promise<{ pass: boolean; failCount: number; warnCount: number; summary: string } | null> {
  const dir = plannerDir()
  return new Promise((resolve) => {
    let py
    try {
      py = spawn(process.env.FL_PYTHON || 'python3',
        [path.join(dir, 'design_check.py'), specPath, path.join(dir, 'design_rules.json'), prompt],
        { timeout: 25_000 })
    } catch { resolve(null); return }
    let out = ''
    py.stdout.on('data', (d) => (out += d))
    py.stderr.on('data', (d) => (out += d))
    py.on('error', () => resolve(null))
    py.on('close', (code) => {
      if (code === null) { resolve(null); return }
      const fails = out.split('\n')
        .filter((l) => l.includes('FAIL ') && l.includes('✗'))
        .map((l) => l.replace(/^.*?✗\s*FAIL\s*/, '').trim())
      const warns = out.split('\n').filter((l) => l.includes('WARN') && l.includes('⚠')).length
      const fm = out.match(/GATE FAIL (\d+)/)
      const failCount = fm ? Number(fm[1]) : fails.length
      resolve({
        pass: /GATE PASS/.test(out) || (code === 0 && failCount === 0),
        failCount,
        warnCount: warns,
        summary: fails.slice(0, 3).join(' · ').slice(0, 240) || 'see design-check log',
      })
    })
  })
}
