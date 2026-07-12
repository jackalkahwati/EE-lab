/**
 * Evaluator registry — the GENERIC scoring layer. An evaluator scores one
 * objective for a candidate and declares its fidelity + confidence. The
 * optimizer calls whatever evaluator an objective resolves to; an objective
 * with no matching evaluator is reported "unscored" and NEVER fabricated.
 *
 * SCALE PRINCIPLE: to search hundreds/thousands of candidates, the built-in
 * evaluators are cheap ANALYTIC functions of the candidate's variable values —
 * transparent formulas, labeled `analytic`, not physics sims. Higher-fidelity
 * evaluators (surrogate models, real board builds, EM/thermal sims) are plugins
 * added later and reserved for the Pareto finalists. Domain-specific evaluators
 * (antenna, acoustics, …) register here without touching the optimizer.
 */
import type { ProductSpec } from '@/lib/product-spec'
import type { DesignProblem } from '@/lib/design-problem'

export type Fidelity = 'analytic' | 'surrogate' | 'sim' | 'real'

/** A concrete design point: an assignment of the problem's variables. Artifacts
 *  (a built board, CAD) can be attached later for real-fidelity evaluators. */
export interface Candidate {
  id: string
  values: Record<string, string | number>
}

export interface EvalContext {
  problem: DesignProblem
  spec?: ProductSpec
}

export interface ScoredObjective {
  objective: string
  value: number
  confidence: number // 0..1
  fidelity: Fidelity
  evaluatorId: string
  note?: string
}

export interface Evaluator {
  id: string
  handles: string[] // canonical objective names this can score
  fidelity: Fidelity
  /** Return the raw metric value, or null if it cannot score this candidate. */
  run: (c: Candidate, ctx: EvalContext) => { value: number; confidence: number; note?: string } | null
}

// ---- helpers ---------------------------------------------------------------

/** First numeric value found among candidate variables named in `names`. */
function fromVars(c: Candidate, names: string[]): number | undefined {
  for (const n of names) {
    const v = c.values[n]
    if (typeof v === 'number' && isFinite(v)) return v
  }
  return undefined
}

function pick(c: Candidate, names: string[], specFallback: number | undefined, dflt: number): number {
  return fromVars(c, names) ?? (specFallback != null && isFinite(specFallback) ? specFallback : dflt)
}

// ---- the three universal analytic evaluators -------------------------------
// Transparent formulas over the variable values, so they scale to thousands of
// candidates. Every product can be scored on cost / size / battery this way; the
// numbers are estimates (fidelity: analytic) and get replaced by a real board
// build for the selected finalist.

const costAnalytic: Evaluator = {
  id: 'cost-analytic',
  handles: ['unitCostUsd', 'bomCostUsd', 'cost'],
  fidelity: 'analytic',
  run: (c, ctx) => {
    const b = ctx.spec?.budgets
    const areaMm2 = pick(c, ['boardAreaMm2', 'areaMm2'], (b?.sizeMm?.x ?? 0) * (b?.sizeMm?.y ?? 0), 400)
    const layers = pick(c, ['layers'], undefined, 2)
    const comps = pick(c, ['componentCount', 'components'], undefined, 30)
    const mah = pick(c, ['batteryMah'], b?.power?.batteryMah, 0)
    // rough at-scale cost: PCB ~ $0.05/cm² per layer, ~$0.06 avg per component,
    // battery ~ $0.004/mAh. Transparent, not a quote.
    const pcb = (areaMm2 / 100) * layers * 0.05
    const bom = comps * 0.06 + mah * 0.004
    return { value: +(pcb + bom).toFixed(3), confidence: 0.4, note: 'analytic cost model (not a quote)' }
  },
}

const sizeAnalytic: Evaluator = {
  id: 'size-analytic',
  handles: ['boardAreaMm2', 'areaMm2', 'volumeMm3', 'sizeMm'],
  fidelity: 'analytic',
  run: (c, ctx) => {
    const b = ctx.spec?.budgets
    const area = fromVars(c, ['boardAreaMm2', 'areaMm2'])
    if (area != null) return { value: +area.toFixed(1), confidence: 0.6, note: 'board area from variables' }
    // fall back to an envelope-derived area if the product carries a size budget
    const x = b?.sizeMm?.x
    const y = b?.sizeMm?.y
    if (x && y) return { value: +(x * y).toFixed(1), confidence: 0.3, note: 'from size budget' }
    return null
  },
}

const batteryAnalytic: Evaluator = {
  id: 'battery-analytic',
  handles: ['batteryHours', 'runtimeHours'],
  fidelity: 'analytic',
  run: (c, ctx) => {
    const b = ctx.spec?.budgets
    const mah = pick(c, ['batteryMah'], b?.power?.batteryMah, 0)
    const activeMw = pick(c, ['activeMw'], b?.power?.activeMw, 0)
    if (!mah || !activeMw) return null
    // energy(mWh) = mAh * nominal 3.7 V; runtime(h) = energy / active power(mW)
    const hours = (mah * 3.7) / activeMw
    return { value: +hours.toFixed(2), confidence: 0.4, note: 'analytic: mAh·3.7V / activeMw' }
  },
}

// ---- mass + surrogate evaluators (close the common gaps honestly) ----------
// mass is a genuine analytic model (geometry + material density); comfort / RF /
// audio are transparent SURROGATE proxies with low confidence — they move an
// objective from "unscored" to "surrogate", never claiming a validated sim.

const MAT_DENSITY: Record<string, number> = {
  abs: 1.05, pc: 1.2, 'pc/abs': 1.1, nylon: 1.15, silicone: 1.2, tpe: 1.0, rubber: 1.2,
  aluminum: 2.7, aluminium: 2.7, metal: 2.7, steel: 7.8, titanium: 4.5,
}
function materialDensity(v: unknown): number {
  const s = String(v ?? '').toLowerCase()
  for (const k of Object.keys(MAT_DENSITY)) if (s.includes(k)) return MAT_DENSITY[k]
  return 1.15 // generic engineering plastic
}

/** Estimate device mass in grams from geometry + battery + enclosure material. */
function estimateMassG(c: Candidate, ctx: EvalContext): number {
  const b = ctx.spec?.budgets
  const areaCm2 = pick(c, ['boardAreaMm2', 'areaMm2'], (b?.sizeMm?.x ?? 0) * (b?.sizeMm?.y ?? 0), 200) / 100
  const layers = pick(c, ['layers'], undefined, 2)
  const mah = pick(c, ['batteryMah'], b?.power?.batteryMah, 0)
  const comps = pick(c, ['componentCount', 'components'], undefined, 30)
  const wallMm = pick(c, ['enclosureWallThicknessMm', 'wallThicknessMm'], undefined, 0.8)
  const density = materialDensity(c.values['enclosureMaterial'] ?? c.values['material'])
  const pcbThicknessCm = (0.6 + 0.1 * layers) / 10
  const pcbMass = areaCm2 * pcbThicknessCm * 1.9 // FR4 ~1.9 g/cm³
  const batteryMass = mah * 0.025 // small Li-ion ~0.025 g/mAh
  const compsMass = comps * 0.03
  const shellAreaCm2 = areaCm2 * 2.5 // both faces + side walls
  const enclosureMass = shellAreaCm2 * (wallMm / 10) * density
  return pcbMass + batteryMass + compsMass + enclosureMass
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

const massAnalytic: Evaluator = {
  id: 'mass-analytic',
  handles: ['massG', 'mass', 'weightG'],
  fidelity: 'analytic',
  run: (c, ctx) => ({ value: +estimateMassG(c, ctx).toFixed(2), confidence: 0.45, note: 'analytic: PCB + battery + enclosure geometry × material density' }),
}

const comfortSurrogate: Evaluator = {
  id: 'comfort-surrogate',
  handles: ['wearComfort', 'comfort', 'comfortScore'],
  fidelity: 'surrogate',
  run: (c, ctx) => {
    const mass = estimateMassG(c, ctx)
    const areaMm2 = pick(c, ['boardAreaMm2', 'areaMm2'], (ctx.spec?.budgets?.sizeMm?.x ?? 0) * (ctx.spec?.budgets?.sizeMm?.y ?? 0), 200)
    const score = clamp(100 - mass * 9 - (areaMm2 / 100) * 6, 0, 100)
    return { value: +score.toFixed(1), confidence: 0.3, note: 'surrogate proxy from estimated mass + size (not an ergonomic fit study)' }
  },
}

const rfSurrogate: Evaluator = {
  id: 'rf-surrogate',
  handles: ['bluetoothReliability', 'wirelessReliability', 'rfPerformance', 'antennaEfficiency'],
  fidelity: 'surrogate',
  run: (c) => {
    const place = String(c.values['antennaPlacement'] ?? '').toLowerCase()
    let placeScore = 65
    if (/external|top|stalk|tail/.test(place)) placeScore = 85
    else if (/edge|tip/.test(place)) placeScore = 60
    else if (/in-ear|canal|deep|concha/.test(place)) placeScore = 42
    const mat = String(c.values['enclosureMaterial'] ?? c.values['material'] ?? '').toLowerCase()
    const matPenalty = /alum|metal|steel|titan/.test(mat) ? -35 : 0
    const areaMm2 = Number(c.values['boardAreaMm2'] ?? 0)
    const areaBonus = areaMm2 ? Math.min(10, areaMm2 / 20) : 0
    return { value: +clamp(placeScore + matPenalty + areaBonus, 0, 100).toFixed(1), confidence: 0.35, note: 'surrogate: antenna placement + enclosure material detuning (not an EM sim)' }
  },
}

const audioSurrogate: Evaluator = {
  id: 'audio-surrogate',
  handles: ['audioQuality', 'audio', 'acousticQuality'],
  fidelity: 'surrogate',
  run: (c, ctx) => {
    const areaMm2 = pick(c, ['boardAreaMm2', 'areaMm2'], (ctx.spec?.budgets?.sizeMm?.x ?? 0) * (ctx.spec?.budgets?.sizeMm?.y ?? 0), 120)
    // larger board/shell => larger acoustic back-volume + room for a better driver
    const score = clamp(35 + ((areaMm2 - 20) / (200 - 20)) * 45, 0, 100)
    return { value: +score.toFixed(1), confidence: 0.25, note: 'surrogate: rough proxy from back-volume/board area (not an acoustic sim)' }
  },
}

// ---- registry --------------------------------------------------------------

const REGISTRY: Evaluator[] = [
  costAnalytic, sizeAnalytic, batteryAnalytic,
  massAnalytic, comfortSurrogate, rfSurrogate, audioSurrogate,
]

export function registerEvaluator(e: Evaluator): void {
  const i = REGISTRY.findIndex((x) => x.id === e.id)
  if (i >= 0) REGISTRY[i] = e
  else REGISTRY.push(e)
}

export function registeredEvaluatorIds(): Set<string> {
  return new Set(REGISTRY.map((e) => e.id))
}

/** Resolve an objective to an evaluator: by explicit id first, else by an
 *  evaluator that declares it handles the objective name. */
function resolve(objectiveName: string, evaluatorId?: string): Evaluator | undefined {
  if (evaluatorId) {
    const byId = REGISTRY.find((e) => e.id === evaluatorId)
    if (byId) return byId
  }
  return REGISTRY.find((e) => e.handles.includes(objectiveName))
}

/** All objective names any registered evaluator can currently score. */
export function scorableObjectiveNames(): Set<string> {
  const s = new Set<string>()
  for (const e of REGISTRY) for (const h of e.handles) s.add(h)
  return s
}

/** Score a candidate against the problem's objectives. Returns per-objective
 *  scores plus the honest list of objectives nothing could score. */
export function evaluateCandidate(
  c: Candidate,
  ctx: EvalContext,
): { scores: ScoredObjective[]; unscored: string[] } {
  const scores: ScoredObjective[] = []
  const unscored: string[] = []
  for (const o of ctx.problem.objectives) {
    const ev = resolve(o.name, o.evaluator)
    const out = ev?.run(c, ctx) ?? null
    if (ev && out) {
      scores.push({
        objective: o.name,
        value: out.value,
        confidence: out.confidence,
        fidelity: ev.fidelity,
        evaluatorId: ev.id,
        note: out.note,
      })
    } else {
      unscored.push(o.name)
    }
  }
  return { scores, unscored }
}
