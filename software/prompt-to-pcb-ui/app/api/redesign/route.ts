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
import { callLLMText } from '@/lib/llm'
import { overrideForRequest } from '@/lib/byok'
import { pinsPromptFor } from '@/lib/design-state'
import { MODEL } from '@/lib/model-tiers'
import type { ProductSpec } from '@/lib/product-spec'
import { planSimulations, judge, isRequiredFail, thermalEnvFromPlan, type SimPlan } from '@/lib/sim-router'
import { judgeThermal, MIN_MARGIN_C } from '@/lib/sim-judge'

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
    const py = spawn(process.env.FL_PYTHON || 'python3', [script], { timeout: 90_000 })
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

/** Extra solver inputs read once per request and held constant across iterations. */
type SimCtx = {
  /** the run's power-budget.json (rail currents → on-board dissipation), if any */
  powerBudget?: Record<string, unknown>
  /** real board w×h — sent only while the enclosure budget is unchanged (once the
   *  loop enlarges sizeMm the board may grow to fill it; see effectiveArea) */
  boardMm?: { w: number; h: number }
  layerCount?: number
}

function simInputs(b: Budgets, boardAreaMm2: number | undefined, plan: SimPlan, ctx: SimCtx, sizeChanged: boolean) {
  const p = b?.power ?? {}
  // Mirror the /api/simulate duty model so the loop scores runtime the same way:
  // a specified sleep power implies a duty-cycled device → average, not peak, draw.
  const dutyCycle = p.dutyCycle ?? (p.sleepUw != null ? DEFAULT_DUTY : undefined)
  return {
    activeMw: p.activeMw, batteryMah: p.batteryMah, boardAreaMm2, massG: b?.massG,
    envelopeMm: b?.sizeMm, runtimeTargetHours: p.runtimeHours,
    sleepUw: p.sleepUw, dutyCycle,
    // same thermal contract as /api/simulate: the reliability class's junction
    // rating is the solver limit; rail data gives on-board power (else a stated fraction)
    limitC: plan.environment.ratingC ?? 85,
    powerBudget: ctx.powerBudget,
    boardMm: sizeChanged ? undefined : ctx.boardMm,
    layerCount: ctx.layerCount,
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
type FitCheck = {
  fits: boolean
  enclosureMm: { w: number; h: number }
  /** the real pocket the board must fit (enclosure − walls); absent on legacy files */
  cavityMm?: { w: number; h: number } | null
  pcbMm: { w: number; h: number }
  problems?: string[]
}
async function realMechFit(runId?: string): Promise<FitCheck | null> {
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
type Violation = { id: string; kind: string; detail: string }

/** Simulation violations from the JUDGE (lib/sim-router.ts judge → lib/sim-judge.ts
 *  for thermal), never from the solver's raw pass flag: the raw flag knows nothing
 *  about the application ambient or the reliability class, so a router-only fail
 *  used to yield zero violations and a bogus 'converged'. Required + recommended
 *  fails become violations; 'model_invalid' / 'unknown' are not design fails and
 *  never block convergence. Solver results the plan does not cover (rf, acoustic…)
 *  keep the raw flag as the only signal there is. */
function simViolations(plan: SimPlan, results: Record<string, any>[]): { v: Violation[]; requiredFail: boolean; assessments: ReturnType<typeof judge>['assessments'] } {
  const v: Violation[] = []
  const { assessments } = judge(plan, results)
  const byKind = new Map(results.filter((r) => r && typeof r.sim === 'string').map((r) => [r.sim as string, r]))
  for (const a of assessments) {
    if (a.verdict !== 'fail' || a.applicability === 'optional' || a.applicability === 'not_applicable') continue
    let detail = `${a.kind} (${a.applicability}): ${a.detail}`
    if (a.kind === 'thermal') {
      // concrete lever for the controller: how much less board heat closes the gap
      const j = judgeThermal(byKind.get('thermal'), { ...thermalEnvFromPlan(plan), ambientC: plan.requirements.find((r) => r.kind === 'thermal')?.target?.ambientC ?? plan.environment.ambientC })
      if (j.junctionC != null && j.riseC != null && j.riseC > 0) {
        const over = j.junctionC + MIN_MARGIN_C - j.limitC
        const cut = Math.min(0.95, Math.max(0, over / (j.junctionC - j.ambientC)))
        detail += ` — needs ${Math.round(over)}°C less rise: cut on-board dissipation ~${Math.round(cut * 100)}% (activeMw) and/or enlarge board/enclosure area (sizeMm) for more convective surface`
      }
    }
    v.push({ id: `sim:${a.kind}`, kind: 'sim', detail })
  }
  const planned = new Set(plan.requirements.map((r) => r.kind as string))
  for (const r of results) {
    if (r && typeof r.sim === 'string' && !planned.has(r.sim) && r.pass === false)
      v.push({ id: `sim:${r.sim}`, kind: 'sim', detail: `${r.sim} ${r.metric} = ${r.value}${r.unit} vs limit ${r.limit}` })
  }
  return { v, requiredFail: assessments.some(isRequiredFail), assessments }
}

async function violations(spec: ProductSpec, b: Budgets, board: { wMm?: number; hMm?: number }, boardAreaMm2: number | undefined, runId: string | undefined, sizeChanged: boolean, ctx: SimCtx) {
  const v: Violation[] = []
  let requiredSimFail = false
  const mechFit = sizeChanged ? null : await realMechFit(runId)
  if (mechFit && mechFit.fits === false) {
    const cav = mechFit.cavityMm ?? mechFit.enclosureMm
    const probs = Array.isArray(mechFit.problems) && mechFit.problems.length ? ` — ${mechFit.problems.join('; ')}` : ''
    v.push({ id: 'fit', kind: 'fit', detail: `real PCB ${mechFit.pcbMm.w}×${mechFit.pcbMm.h}mm does not fit the enclosure cavity ${cav.w}×${cav.h}mm${probs}` })
  } else if (!mechFit) {
    const env = b?.sizeMm
    if (board.wMm && board.hMm && env?.x && env?.y) {
      const fits = sizeChanged
        ? board.wMm <= env.x - 2 * WALL_MM + 0.5 && board.hMm <= env.y - 2 * WALL_MM + 0.5
        : board.wMm <= env.x + 0.5 && board.hMm <= env.y + 0.5
      if (!fits) v.push({ id: 'fit', kind: 'fit', detail: `real board ${Math.round(board.wMm)}×${Math.round(board.hMm)}mm exceeds ${sizeChanged ? `the ${env.x}×${env.y}mm enclosure's cavity (−${2 * WALL_MM}mm walls)` : `envelope ${env.x}×${env.y}mm`}` })
    }
  }
  // re-plan against THIS iteration's budgets (activeMw / sizeMm move the requirements)
  const plan = planSimulations({ ...spec, budgets: b }, {
    hasBattery: !!b?.power?.batteryMah,
    rails: Object.keys((ctx.powerBudget as any)?.rails ?? {}).length,
  })
  const sim = await runSim(simInputs(b, boardAreaMm2, plan, ctx, sizeChanged))
  if (sim?.error) {
    // First-class violation that NO budget change can ever clear: the checker
    // itself is down, so sim compliance is unknowable and convergence would be
    // a lie. Registered as a capability gap by the caller so the loop exits
    // 'blocked-capability-gap', never 'converged'.
    v.push({ id: 'sim-unavailable', kind: 'sim-unavailable', detail: `simulation checker unavailable: ${sim.error}` })
  } else {
    const sv = simViolations(plan, Array.isArray(sim.results) ? sim.results : [])
    v.push(...sv.v)
    requiredSimFail = sv.requiredFail
  }
  return { v, requiredSimFail }
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
    const override = overrideForRequest(req)

    // held constant across iterations: the run's power budget (rail currents →
    // on-board dissipation) and the real board dims/layers (see SimCtx)
    const simCtx: SimCtx = {}
    if (runId && RUN_ID.test(runId)) {
      try {
        const pb = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'data', 'power-budget.json'), 'utf8'))
        if (pb && typeof pb === 'object') simCtx.powerBudget = pb
      } catch { /* no power budget for this run */ }
      try {
        const cs = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'electronics', 'chipscale-board.json'), 'utf8'))
        if (typeof cs?.layers === 'number' && cs.layers > 0) simCtx.layerCount = cs.layers
      } catch { /* none */ }
    }
    if (board.wMm && board.hMm) simCtx.boardMm = { w: board.wMm, h: board.hMm }

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
    let { v: remaining, requiredSimFail } = await violations(spec, budgets, board, effectiveArea(budgets, boardAreaMm2), runId, sizeChanged(), simCtx)
    registerSimGap(remaining)

    for (let it = 0; it < MAX_ITERS && remaining.length > 0; it++) {
      // every remaining violation is already a known capability gap (e.g. only
      // 'sim-unavailable' left) — no budget change can help; don't burn an LLM
      // call proposing one.
      if (remaining.every((viol) => capabilityGaps.some((g) => g.violation === viol.id))) break
      const userMsg = `BUDGETS:\n${JSON.stringify(budgets)}\n\nVIOLATIONS:\n${JSON.stringify(remaining)}\n\nPropose fixes.` +
        // Phase 2: pinned budgets are IMMOVABLE — a redesign that can only
        // converge by moving one must report a capability gap instead.
        pinsPromptFor(runId, ['budget']).replace('INVALID and will be rejected', 'IMMOVABLE: if convergence requires moving one, report a capability gap instead')
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
      ;({ v: remaining, requiredSimFail } = await violations(spec, budgets, board, effectiveArea(budgets, boardAreaMm2), runId, sizeChanged(), simCtx))
      registerSimGap(remaining)
      const resolved = before.filter((id) => !remaining.some((v) => v.id === id))
      iterations.push({ iter: it + 1, applied, resolved, remaining: remaining.map((v) => v.detail), budgets })

      // if every remaining violation is a known capability gap, stop honestly
      if (remaining.length && remaining.every((v) => capabilityGaps.some((g) => g.violation === v.id))) break
      if (!applied.length) break
    }

    // converged only when nothing remains AND no REQUIRED analysis still fails its
    // application requirement (a required judge fail is always in `remaining`, so
    // this is belt-and-braces against the two ever drifting apart)
    const converged = remaining.length === 0 && !requiredSimFail
    const out = {
      converged,
      requiredSimFail,
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
