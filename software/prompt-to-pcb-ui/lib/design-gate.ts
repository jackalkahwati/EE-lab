/**
 * Design-correctness gate + functional-wiring — the shared bridge to the Python
 * planner's `functional_wire.py` (adds the application signal chains per-IC bus
 * synthesis omits) and `design_check.py` (verifies the netlist is actually wired
 * to work, not just DRC-clean). Both the headless v1 jobs path (lib/v1-jobs.ts)
 * and the INTERACTIVE pipeline (app/api/pipeline/run/route.ts) call these, so a
 * board can't ship hollow from either entry point.
 *
 * CONTRACT (mirrors the Python scripts' stdout/exit-code contract exactly):
 *   design_check.py   last line `GATE PASS` (exit 0)  -> { pass: true }
 *                     `GATE FAIL <n>` (exit 1)        -> { pass: false, failCount: n, issues }
 *                     `GATE ERROR <why>` (exit 2), no GATE line at all, exit 2,
 *                     a timeout (25 s SIGTERM -> code === null), ENOENT / spawn
 *                     failure                          -> null  ("gate NOT RUN")
 *   functional_wire.py `FUNCWIRE <n>` (exit 0)        -> n
 *                     anything else                    -> null  ("not run")
 * Every null path also console.error()s ONE loud line
 *   `[design-gate] not run: <reason>`
 * and hands the same reason to opts.onNotRun so a caller can surface it in its
 * stage detail. Callers treat null as "the gate did not run" — they surface it
 * and NEVER block on it; only a true `GATE FAIL` (pass:false) blocks. A missing
 * verdict line is never read as a fail (that used to produce a hard block with
 * "FAIL — 0 issue(s)") and never as a pass (timeouts used to pass silently).
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

const TIMEOUT_MS = 25_000

export type GateRunOptions = {
  /** Receives the one-line reason whenever the tool did NOT run (result null). */
  onNotRun?: (reason: string) => void
}

export type DesignGateResult = {
  pass: boolean
  failCount: number
  warnCount: number
  /** The `✗ FAIL` finding lines (ref: message), in report order. */
  issues: string[]
  /** First three issues, joined — for a one-line stage detail. */
  summary: string
}

function plannerDir(): string {
  return path.join(process.cwd(), '..', '..', 'hardware', 'planner')
}

function notRun(tool: string, reason: string, opts?: GateRunOptions): null {
  const msg = `[design-gate] not run: ${tool}: ${reason}`
  console.error(msg)
  try { opts?.onNotRun?.(`${tool}: ${reason}`) } catch { /* caller's problem, never ours */ }
  return null
}

/** Spawn a planner script and collect stdout+stderr. Resolves to
 *  { code, signal, out } on close, or { error } when the process could not be
 *  started (ENOENT: python missing) / spawn threw. */
function runPlannerScript(
  script: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string } | { error: string }> {
  const dir = plannerDir()
  return new Promise((resolve) => {
    let py: ReturnType<typeof spawn>
    try {
      py = spawn(process.env.FL_PYTHON || 'python3', [path.join(dir, script), ...args], { timeout: timeoutMs })
    } catch (e) {
      resolve({ error: `spawn failed: ${String(e).slice(0, 160)}` }); return
    }
    let out = ''
    let settled = false
    py.stdout?.on('data', (d) => (out += d))
    py.stderr?.on('data', (d) => (out += d))
    py.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      resolve({ error: e.code === 'ENOENT' ? `python not found (${process.env.FL_PYTHON || 'python3'})` : String(e).slice(0, 160) })
    })
    py.on('close', (code, signal) => {
      if (settled) return
      settled = true
      resolve({ code, signal, out })
    })
  })
}

/** Functional-wiring synthesis: adds the application signal chains (mux->ADC,
 *  MCU drives mux select, reference->channel, input/host connectors, module
 *  flag) the per-IC bus/power synthesis omits. Mutates the spec file in place;
 *  idempotent (a re-run on an already-wired spec adds 0). Returns the number of
 *  connections/parts added, or null when the pass did NOT run (see CONTRACT). */
export async function runFunctionalWire(specPath: string, prompt: string, opts?: GateRunOptions): Promise<number | null> {
  const r = await runPlannerScript('functional_wire.py', [specPath, path.join(plannerDir(), 'design_rules.json'), prompt], TIMEOUT_MS)
  if ('error' in r) return notRun('functional_wire', r.error, opts)
  const err = r.out.match(/^FUNCWIRE ERROR (.*)$/m)
  if (err) return notRun('functional_wire', err[1].trim().slice(0, 200), opts)
  if (r.code === null) return notRun('functional_wire', `killed (${r.signal ?? 'timeout'} after ${TIMEOUT_MS / 1000}s)`, opts)
  const m = r.out.match(/^FUNCWIRE (\d+)\s*$/m)
  if (!m || r.code !== 0) return notRun('functional_wire', `exit ${r.code}, ${m ? 'unexpected exit' : 'no FUNCWIRE line'}`, opts)
  return Number(m[1])
}

/** The design-correctness gate (hardware/planner/design_check.py). Returns a
 *  DesignGateResult, or null when the gate did NOT run — see the CONTRACT at
 *  the top of this file. Callers block ONLY on `pass === false`. */
export async function runDesignGate(
  specPath: string,
  prompt: string,
  opts?: GateRunOptions,
): Promise<DesignGateResult | null> {
  const r = await runPlannerScript('design_check.py', [specPath, path.join(plannerDir(), 'design_rules.json'), prompt], TIMEOUT_MS)
  if ('error' in r) return notRun('design_check', r.error, opts)
  const { code, signal, out } = r
  const err = out.match(/^GATE ERROR (.*)$/m)
  if (err) return notRun('design_check', err[1].trim().slice(0, 200), opts)
  if (code === null) return notRun('design_check', `killed (${signal ?? 'timeout'} after ${TIMEOUT_MS / 1000}s)`, opts)
  if (code === 2) return notRun('design_check', `exit 2 without a GATE line: ${out.trim().split('\n').pop()?.slice(0, 160) || 'no output'}`, opts)
  const lines = out.split('\n')
  const issues = lines
    .filter((l) => l.includes('✗') && l.includes('FAIL'))
    .map((l) => l.replace(/^.*?✗\s*FAIL\s*/, '').trim())
  const warnCount = lines.filter((l) => l.includes('⚠') && l.includes('WARN')).length
  const fm = out.match(/^GATE FAIL (\d+)\s*$/m)
  if (fm) {
    const failCount = Number(fm[1])
    return {
      pass: false,
      failCount,
      warnCount,
      issues,
      summary: issues.slice(0, 3).join(' · ').slice(0, 240) || `${failCount} finding(s), see design-check log`,
    }
  }
  if (/^GATE PASS\s*$/m.test(out)) {
    return { pass: true, failCount: 0, warnCount, issues: [], summary: warnCount ? `${warnCount} advisory` : 'no findings' }
  }
  return notRun('design_check', `no GATE line (exit ${code}): ${out.trim().split('\n').pop()?.slice(0, 160) || 'no output'}`, opts)
}
