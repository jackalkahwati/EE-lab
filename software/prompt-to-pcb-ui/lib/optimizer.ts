/**
 * Generic multi-objective optimizer. Operates purely on the abstract Design
 * Problem (variables + objectives) via the evaluator registry — it has no idea
 * whether the product is an earbud, a bracket, or a bare PCB.
 *
 * Pipeline: enumerate/sample candidates over the variables -> score each with
 * the registered evaluators -> compute the Pareto frontier over the SCORED
 * objectives -> select the highest scalarized score. Objectives with no
 * evaluator are carried through as honest "unscored" gaps, never invented.
 *
 * MVP fidelity: the built-in evaluators are cheap analytic models, so thousands
 * of candidates are feasible. Real board builds / sims are reserved for the
 * selected finalist (a later step upgrades its fidelity).
 */
import type { DesignProblem, Objective } from '@/lib/design-problem'
import { evaluateCandidate, type Candidate, type EvalContext, type ScoredObjective } from '@/lib/evaluators'

export interface Evaluated {
  candidate: Candidate
  scores: ScoredObjective[]
  scoreMap: Record<string, number>
  unscored: string[]
}

export interface OptimizeResult {
  scoredObjectives: Objective[] // axes actually used for Pareto/selection
  unscoredObjectives: string[] // honest gaps (union across candidates)
  totalCombinations: number // size of the full grid (may exceed sampled count)
  sampledCount: number
  evaluated: Evaluated[]
  pareto: Evaluated[]
  selected: Evaluated | null
}

/** Concrete values a single variable can take (enum options, or sampled range). */
function valuesOf(v: {
  type: 'enum' | 'range'
  options?: (string | number)[]
  min?: number
  max?: number
  step?: number
}): (string | number)[] {
  if (v.type === 'enum') return v.options?.length ? v.options : []
  if (v.min != null && v.max != null && v.max >= v.min) {
    const step = v.step && v.step > 0 ? v.step : (v.max - v.min) / 4 || 1
    const out: number[] = []
    for (let x = v.min; x <= v.max + 1e-9 && out.length < 64; x += step) out.push(+x.toFixed(6))
    return out.length ? out : [v.min]
  }
  return []
}

/** Generate candidates over the variable grid, capped at `cap`. Full cartesian
 *  when small; deterministic-ish strided sampling when the grid is huge (avoids
 *  Math.random so results are reproducible for a given problem). */
function generate(problem: DesignProblem, cap: number): { candidates: Candidate[]; total: number } {
  const vars = problem.variables.map((v) => ({ name: v.name, vals: valuesOf(v) })).filter((v) => v.vals.length > 0)
  if (vars.length === 0) return { candidates: [], total: 0 }
  const total = vars.reduce((n, v) => n * v.vals.length, 1)
  const count = Math.min(total, cap)
  const candidates: Candidate[] = []
  // stride through the mixed-radix index space so samples spread across the grid
  const stride = Math.max(1, Math.floor(total / count))
  for (let k = 0, idx = 0; k < count; k++, idx += stride) {
    let rem = idx % total
    const values: Record<string, string | number> = {}
    for (const v of vars) {
      values[v.name] = v.vals[rem % v.vals.length]
      rem = Math.floor(rem / v.vals.length)
    }
    candidates.push({ id: `cand-${k}`, values })
  }
  return { candidates, total }
}

function directionOf(problem: DesignProblem, name: string): 'min' | 'max' {
  return problem.objectives.find((o) => o.name === name)?.direction ?? 'min'
}

/** a dominates b iff a is no worse on every shared scored axis and better on ≥1. */
function dominates(a: Evaluated, b: Evaluated, axes: Objective[]): boolean {
  let strictlyBetter = false
  for (const o of axes) {
    const av = a.scoreMap[o.name]
    const bv = b.scoreMap[o.name]
    if (av == null || bv == null) continue
    const aBetter = o.direction === 'min' ? av < bv : av > bv
    const aWorse = o.direction === 'min' ? av > bv : av < bv
    if (aWorse) return false
    if (aBetter) strictlyBetter = true
  }
  return strictlyBetter
}

/** Scalarized score in [0,1]: min-max normalize each axis across the set, orient
 *  so higher is better, weight, average. Used to pick one design off the front. */
function scalarize(evaluated: Evaluated[], axes: Objective[]): Map<Evaluated, number> {
  const ranges = new Map<string, { lo: number; hi: number }>()
  for (const o of axes) {
    let lo = Infinity
    let hi = -Infinity
    for (const e of evaluated) {
      const v = e.scoreMap[o.name]
      if (v == null) continue
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
    ranges.set(o.name, { lo, hi })
  }
  const totalW = axes.reduce((s, o) => s + (o.weight ?? 1), 0) || 1
  const out = new Map<Evaluated, number>()
  for (const e of evaluated) {
    let acc = 0
    for (const o of axes) {
      const v = e.scoreMap[o.name]
      const r = ranges.get(o.name)!
      if (v == null || r.hi === r.lo) continue
      let norm = (v - r.lo) / (r.hi - r.lo) // 0..1, higher = larger value
      if (o.direction === 'min') norm = 1 - norm // higher = better
      acc += norm * (o.weight ?? 1)
    }
    out.set(e, acc / totalW)
  }
  return out
}

export function optimize(problem: DesignProblem, ctx: EvalContext, cap = 500): OptimizeResult {
  const { candidates, total } = generate(problem, cap)
  const evaluated: Evaluated[] = candidates.map((c) => {
    const { scores, unscored } = evaluateCandidate(c, ctx)
    const scoreMap: Record<string, number> = {}
    for (const s of scores) scoreMap[s.objective] = s.value
    return { candidate: c, scores, scoreMap, unscored }
  })

  // axes we could actually score on at least one candidate
  const scoredNames = new Set<string>()
  for (const e of evaluated) for (const s of e.scores) scoredNames.add(s.objective)
  const scoredObjectives = problem.objectives.filter((o) => scoredNames.has(o.name))
  const unscoredObjectives = problem.objectives.filter((o) => !scoredNames.has(o.name)).map((o) => o.name)

  // Pareto frontier over the scored axes
  const pareto = evaluated.filter((a) => !evaluated.some((b) => b !== a && dominates(b, a, scoredObjectives)))

  // select the best scalarized design from the frontier (fall back to all)
  const pool = pareto.length ? pareto : evaluated
  const scalar = scalarize(pool, scoredObjectives)
  let selected: Evaluated | null = null
  let best = -Infinity
  for (const e of pool) {
    const s = scalar.get(e) ?? -Infinity
    if (s > best) { best = s; selected = e }
  }

  return {
    scoredObjectives,
    unscoredObjectives,
    totalCombinations: total,
    sampledCount: evaluated.length,
    evaluated,
    pareto,
    selected,
  }
}
