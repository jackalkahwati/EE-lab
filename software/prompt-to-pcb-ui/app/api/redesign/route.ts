/**
 * Redesign loop — the generic feedback controller that makes the pipeline
 * CONVERGE (or honestly fail). Each iteration: gather violations (PCB doesn't
 * fit the envelope, simulation FAILs), ask a design controller for fixes —
 * classified ACHIEVABLE (adjust budgets/constraints) vs CAPABILITY-GAP (a module
 * can't do it, e.g. chip-down electronics) — apply the achievable ones, re-run
 * the checks, and repeat. Converges when no violations remain, or stops and
 * reports the capability gaps honestly. Nothing is faked to force convergence.
 *
 * Generic: it operates on the product spec + evaluators/sims, not on any domain.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { callLLMText, overrideFromHeaders } from '@/lib/llm'
import { MODEL } from '@/lib/model-tiers'
import type { ProductSpec } from '@/lib/product-spec'

export const dynamic = 'force-dynamic'
export const maxDuration = 200

const RUN_ID = /^run-[A-Za-z0-9._-]{1,128}$/
const MAX_ITERS = 3

type Budgets = ProductSpec['budgets']

/**
 * Run the sim checker. A runner failure resolves an {error} SENTINEL, never
 * `{results: []}` — an empty result set is indistinguishable from "all sims
 * pass", so a broken checker used to let the loop report 'converged' with zero
 * evidence. The sentinel becomes a first-class 'sim-unavailable' violation that
 * no budget change can clear (see violations()).
 */
function runSim(reqObj: Record<string, unknown>): Promise<any> {
  const script = path.join(process.cwd(), '..', '..', 'tools', 'sim', 'run_sim.py')
  return new Promise((resolve) => {
    const py = spawn('python3', [script], { timeout: 90_000 })
    let out = ''
    py.stdout.on('data', (d) => (out += d))
    py.on('error', (e) => resolve({ error: `sim runner failed to spawn: ${String(e)}` }))
    py.on('close', (code) => {
      const raw = out.trim().split('\n').pop() || ''
      if (!raw) return resolve({ error: `sim runner produced no output (exit ${code})` })
      try { resolve(JSON.parse(raw)) }
      catch { resolve({ error: `sim runner output was not JSON (exit ${code}): ${raw.slice(0, 120)}` }) }
    })
    py.stdin.write(JSON.stringify(reqObj)); py.stdin.end()
  })
}

const DEFAULT_DUTY = 0.02

function simInputs(b: Budgets, boardAreaMm2?: number) {
  const p = b?.power ?? {}
  // Mirror the /api/simulate duty model so the loop scores runtime the same way:
  // a specified sleep power implies a duty-cycled device → average, not peak, draw.
  const dutyCycle = p.dutyCycle ?? (p.sleepUw != null ? DEFAULT_DUTY : undefined)
  return {
    activeMw: p.activeMw, batteryMah: p.batteryMah, boardAreaMm2, massG: b?.massG,
    envelopeMm: b?.sizeMm, runtimeTargetHours: p.runtimeHours,
    sleepUw: p.sleepUw, dutyCycle,
  }
}

/** Board plate area the thermal sim should use THIS iteration. When the controller
 *  enlarges the enclosure (sizeMm x/y), the board can grow to fill it, so thermal
 *  responds; otherwise fall back to the original real board area. */
function effectiveArea(b: Budgets, fallback?: number): number | undefined {
  const s = b?.sizeMm
  if (s?.x && s?.y) return s.x * s.y
  return fallback
}

/** Read the mechanical stage's REAL fit result (does the real PCB fit the real
 *  enclosure cavity) — the honest fit signal, more accurate than the board-vs-
 *  envelope estimate. Null if the mechanical stage hasn't run for this run. */
async function realMechFit(runId?: string): Promise<{ fits: boolean; enclosureMm: { w: number; h: number }; pcbMm: { w: number; h: number } } | null> {
  if (!runId || !RUN_ID.test(runId)) return null
  try {
    const m = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'mechanical', 'mechanical.json'), 'utf8'))
    return m?.fitCheck ?? null
  } catch { return null }
}

// Same wall model as /api/mechanical's fitCheck: cavity = enclosure − 2 walls,
// with the same +0.5mm fit tolerance. Used for the post-budget-change local fit
// re-evaluation below.
const WALL_MM = 1.5

/** Collect the current violations from fit + simulations. Prefers the mechanical
 *  stage's real cavity fitCheck; falls back to the board-vs-envelope estimate.
 *
 *  `sizeChanged`: mechanical/mechanical.json was computed against the ORIGINAL
 *  enclosure budget and NOTHING inside this loop rewrites it — so once the
 *  controller enlarges sizeMm the file is frozen-stale and a fit violation read
 *  from it could never clear (it just burned all 3 iterations). When the loop
 *  has changed sizeMm, skip the stale file and re-evaluate fit LOCALLY against
 *  the UPDATED budgets: real board dims vs (envelope − 2×wall) cavity, the same
 *  comparison the mechanical stage makes. */
async function violations(b: Budgets, board: { wMm?: number; hMm?: number }, boardAreaMm2?: number, runId?: string, sizeChanged = false) {
  const v: { id: string; kind: string; detail: string }[] = []
  const mechFit = sizeChanged ? null : await realMechFit(runId)
  if (mechFit && mechFit.fits === false) {
    v.push({ id: 'fit', kind: 'fit', detail: `real PCB ${mechFit.pcbMm.w}×${mechFit.pcbMm.h}mm does not fit the enclosure cavity ${mechFit.enclosureMm.w}×${mechFit.enclosureMm.h}mm` })
  } else if (!mechFit) {
    const env = b?.sizeMm
    if (board.wMm && board.hMm && env?.x && env?.y) {
      const fits = sizeChanged
        ? board.wMm <= env.x - 2 * WALL_MM + 0.5 && board.hMm <= env.y - 2 * WALL_MM + 0.5
        : board.wMm <= env.x + 0.5 && board.hMm <= env.y + 0.5
      if (!fits) v.push({ id: 'fit', kind: 'fit', detail: `real board ${Math.round(board.wMm)}×${Math.round(board.hMm)}mm exceeds ${sizeChanged ? `the ${env.x}×${env.y}mm enclosure's cavity (−${2 * WALL_MM}mm walls)` : `envelope ${env.x}×${env.y}mm`}` })
    }
  }
  const sim = await runSim(simInputs(b, boardAreaMm2))
  if (sim?.error) {
    // First-class violation that NO budget change can ever clear: the checker
    // itself is down, so sim compliance is unknowable and convergence would be
    // a lie. Registered as a capability gap by the caller so the loop exits
    // 'blocked-capability-gap', never 'converged'.
    v.push({ id: 'sim-unavailable', kind: 'sim-unavailable', detail: `simulation checker unavailable: ${sim.error}` })
  } else {
    for (const r of sim.results ?? []) {
      if (r && r.pass === false) v.push({ id: `sim:${r.sim}`, kind: 'sim', detail: `${r.sim} ${r.metric} = ${r.value}${r.unit} vs limit ${r.limit}` })
    }
  }
  return v
}

const CONTROLLER_SYS = `detailed thinking off.
You are the redesign controller for an autonomous product-engineering platform.
Given current VIOLATIONS and the product's budgets, propose ONE fix per violation.
Classify each fix honestly:
- "achievable": true  -> the platform CAN apply it by changing a budget/target
  (e.g. increase batteryMah to fix runtime; enlarge enclosure; reduce activeMw;
  increase surface area for thermal). Provide concrete "budgetChanges".
- "achievable": false -> it needs a module CAPABILITY the platform does NOT have
  (e.g. shrinking the PCB to fit needs chip-down / rigid-flex EDA that isn't
  built). Do NOT invent budgetChanges for these — say what capability is missing.

A battery capacity (batteryMah) increase must physically fit the enclosure volume
(sizeMm x*y*z). A Li-po cell needs roughly 1 mm^3 per ~0.4 mWh (~0.1 mAh @ 3.7V),
so a bigger mAh needs either that volume free inside the enclosure OR a larger
sizeMm. If closing the runtime gap would need a cell that cannot fit the (even
enlarged) enclosure, classify that violation "achievable": false with the missing
capability (e.g. "energy density beyond available cell volume") rather than
ballooning batteryMah into a cell that doesn't exist. Do NOT fake runtime.

NEVER fake a fit by shrinking the real board. Output ONLY this JSON:
{"adjustments":[{"violation":"<id>","module":"<electronics|mechanical|battery|thermal|rf|...>","fix":"<one line>","achievable":<bool>,"capabilityGap":"<if not achievable, the missing capability, else empty>","budgetChanges":{"power":{"batteryMah":<n>,"activeMw":<n>,"runtimeHours":<n>},"sizeMm":{"x":<n>,"y":<n>,"z":<n>},"massG":<n>}}]}`

function deepMergeBudgets(b: Budgets, changes: any): Budgets {
  const out: any = JSON.parse(JSON.stringify(b ?? {}))
  if (!changes || typeof changes !== 'object') return out
  if (changes.sizeMm) out.sizeMm = { ...(out.sizeMm ?? {}), ...changes.sizeMm }
  if (changes.power) out.power = { ...(out.power ?? {}), ...changes.power }
  if (typeof changes.massG === 'number') out.massG = changes.massG
  if (typeof changes.unitCostUsd === 'number') out.unitCostUsd = changes.unitCostUsd
  return out
}

function firstJson(text: string): any {
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const i = t.indexOf('{')
  if (i < 0) throw new Error('no json')
  let depth = 0, inStr = false, esc = false
  for (let k = i; k < t.length; k++) {
    const ch = t[k]
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false }
    else if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return JSON.parse(t.slice(i, k + 1)) }
  }
  throw new Error('unbalanced json')
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const spec = body.spec as ProductSpec | undefined
    const runId = typeof body.runId === 'string' ? body.runId : undefined
    if (!spec?.product) return Response.json({ error: 'missing product spec' }, { status: 400 })

    let board: { wMm?: number; hMm?: number } = {}
    let boardAreaMm2: number | undefined
    if (runId && RUN_ID.test(runId)) {
      // prefer the chip-scale board (electronics-cs) if present
      try {
        const cs = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'electronics', 'chipscale-board.json'), 'utf8'))
        if (cs?.boardMm?.w && cs?.boardMm?.h) { board = { wMm: cs.boardMm.w, hMm: cs.boardMm.h }; boardAreaMm2 = cs.areaMm2 }
      } catch { /* none */ }
      if (!board.wMm) {
        try {
          const bj = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'data', 'board.json'), 'utf8'))
          board = { wMm: bj?.boardSize?.wMm, hMm: bj?.boardSize?.hMm }
          if (board.wMm && board.hMm) boardAreaMm2 = board.wMm * board.hMm
        } catch { /* no board */ }
      }
    }
    // BYOK override pattern unified with the other routes: `{ model, ...override }`
    // keeps the platform's tier choice (MODEL.design) while a caller-supplied
    // key/provider still takes precedence — the old `override?.apiKey ? override
    // : llmOpts` form dropped the model tier for BYOK callers.
    const override = overrideFromHeaders(req.headers)

    let budgets = spec.budgets
    const iterations: any[] = []
    const capabilityGaps: { violation: string; module: string; gap: string }[] = []
    // stale-fit guard (see violations()): once the loop changes sizeMm, the
    // persisted mechanical fitCheck no longer describes the current enclosure.
    const origSize = JSON.stringify(spec.budgets?.sizeMm ?? null)
    const sizeChanged = () => JSON.stringify(budgets?.sizeMm ?? null) !== origSize
    // a down sim checker is a capability gap, never a clean bill of health
    const registerSimGap = (rem: { id: string; kind: string; detail: string }[]) => {
      for (const viol of rem) {
        if (viol.kind === 'sim-unavailable' && !capabilityGaps.some((g) => g.violation === viol.id))
          capabilityGaps.push({ violation: viol.id, module: 'simulation', gap: viol.detail })
      }
    }
    let remaining = await violations(budgets, board, effectiveArea(budgets, boardAreaMm2), runId, sizeChanged())
    registerSimGap(remaining)

    for (let it = 0; it < MAX_ITERS && remaining.length > 0; it++) {
      // every remaining violation is already a known capability gap (e.g. only
      // 'sim-unavailable' left) — no budget change can help; don't burn an LLM
      // call proposing one.
      if (remaining.every((viol) => capabilityGaps.some((g) => g.violation === viol.id))) break
      const userMsg = `BUDGETS:\n${JSON.stringify(budgets)}\n\nVIOLATIONS:\n${JSON.stringify(remaining)}\n\nPropose fixes.`
      let adjustments: any[] = []
      try {
        const { text } = await callLLMText(CONTROLLER_SYS, userMsg, { model: MODEL.design, ...override })
        adjustments = firstJson(text).adjustments ?? []
      } catch { adjustments = [] }

      const applied: string[] = []
      for (const a of adjustments) {
        if (a?.achievable && a.budgetChanges) {
          budgets = deepMergeBudgets(budgets, a.budgetChanges)
          applied.push(`${a.violation}: ${a.fix}`)
        } else if (a && a.achievable === false) {
          if (!capabilityGaps.some((g) => g.violation === a.violation))
            capabilityGaps.push({ violation: a.violation, module: a.module ?? '?', gap: a.capabilityGap || a.fix || 'unspecified capability gap' })
        }
      }

      const before = remaining.map((v) => v.id)
      // re-evaluate against the UPDATED budgets — sizeChanged() makes the fit
      // check track the new enclosure instead of the frozen mechanical.json
      remaining = await violations(budgets, board, effectiveArea(budgets, boardAreaMm2), runId, sizeChanged())
      registerSimGap(remaining)
      const resolved = before.filter((id) => !remaining.some((v) => v.id === id))
      iterations.push({ iter: it + 1, applied, resolved, remaining: remaining.map((v) => v.detail), budgets })

      // if every remaining violation is a known capability gap, stop honestly
      if (remaining.length && remaining.every((v) => capabilityGaps.some((g) => g.violation === v.id))) break
      if (!applied.length) break
    }

    const converged = remaining.length === 0
    const out = {
      converged,
      status: converged ? 'converged' : (capabilityGaps.length ? 'blocked-capability-gap' : 'not-converged'),
      iterations,
      finalBudgets: budgets,
      remaining: remaining.map((v) => v.detail),
      capabilityGaps,
    }
    if (runId && RUN_ID.test(runId)) {
      try {
        const dir = path.join(process.cwd(), 'public', 'runs', runId, 'disciplines')
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, 'redesign.json'), JSON.stringify(out))
      } catch { /* best effort */ }
    }
    return Response.json(out)
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
