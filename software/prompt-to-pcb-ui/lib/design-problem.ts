/**
 * Design Problem — the GENERIC contract that makes the whole platform
 * domain-agnostic. The product engine (architect) turns ANY "build X" prompt
 * into one of these; the generic machinery (candidate generator, evaluator
 * registry, Pareto optimizer) consumes it without knowing what the product is.
 *
 * Specialization lives in DATA (this object + the evaluator plugins), never in
 * code. An earbud, a bracket, and a bare PCB all produce different variables /
 * objectives here and flow through the identical pipeline.
 *
 * See lib/product-spec (disciplines/routing) and the evaluator registry. An
 * objective whose `evaluator` is missing or unknown is scored "unscored" — the
 * platform never fabricates a number it cannot compute.
 */
import { DISCIPLINES, type Discipline } from '@/lib/product-spec'

/** A search-space knob. `enum` = pick from options; `range` = a numeric span. */
export interface DesignVariable {
  name: string // e.g. "batteryGeometry", "wallThicknessMm", "layers"
  discipline?: Discipline // which module owns this knob (for routing the value)
  type: 'enum' | 'range'
  options?: (string | number)[] // enum choices
  min?: number
  max?: number
  step?: number // range bounds (numeric)
  unit?: string
  note?: string
}

/** A thing to optimize. `evaluator` names a registry plugin; absent/unknown =>
 *  the objective is reported "unscored" (honest gap), never invented. */
export interface Objective {
  name: string // e.g. "unitCostUsd", "massG", "batteryHours"
  direction: 'min' | 'max'
  evaluator?: string // evaluator-registry id that scores this objective
  weight?: number // relative importance for scalarized selection (default 1)
  unit?: string
  target?: number // aspirational value, if any
}

/** A requirement the design must satisfy (hard) or prefer (soft). */
export interface DesignConstraint {
  requirement: string // human-readable
  hard?: boolean // hard = must hold; soft = preference
}

export interface DesignProblem {
  product: string
  description: string
  variables: DesignVariable[]
  objectives: Objective[]
  constraints: DesignConstraint[]
}

const isDiscipline = (v: unknown): v is Discipline =>
  typeof v === 'string' && (DISCIPLINES as readonly string[]).includes(v)

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && isFinite(v) ? v : undefined

/** Guarantee a well-formed problem from LLM output: drop malformed entries,
 *  default directions, so the optimizer never sees a broken field. */
export function normalizeDesignProblem(raw: Partial<DesignProblem> | undefined): DesignProblem {
  const s = (raw ?? {}) as DesignProblem
  const variables: DesignVariable[] = Array.isArray(s.variables)
    ? s.variables
        .filter((v) => v && typeof v.name === 'string')
        .map((v) => ({
          name: v.name,
          discipline: isDiscipline(v.discipline) ? v.discipline : undefined,
          type: v.type === 'range' ? 'range' : 'enum',
          options: Array.isArray(v.options) ? v.options.filter((o) => typeof o === 'string' || typeof o === 'number') : undefined,
          min: num(v.min),
          max: num(v.max),
          step: num(v.step),
          unit: typeof v.unit === 'string' ? v.unit : undefined,
          note: typeof v.note === 'string' ? v.note : undefined,
        }))
    : []
  const objectives: Objective[] = Array.isArray(s.objectives)
    ? s.objectives
        .filter((o) => o && typeof o.name === 'string')
        .map((o) => ({
          name: o.name,
          direction: o.direction === 'max' ? 'max' : 'min',
          evaluator: typeof o.evaluator === 'string' && o.evaluator ? o.evaluator : undefined,
          weight: num(o.weight) ?? 1,
          unit: typeof o.unit === 'string' ? o.unit : undefined,
          target: num(o.target),
        }))
    : []
  const constraints: DesignConstraint[] = (Array.isArray(s.constraints) ? s.constraints : [])
    .map((c): DesignConstraint | null =>
      typeof c === 'string'
        ? { requirement: c, hard: true }
        : c && typeof c.requirement === 'string'
          ? { requirement: c.requirement, hard: c.hard !== false }
          : null,
    )
    .filter((c): c is DesignConstraint => c !== null)
  return {
    product: s.product || 'Untitled product',
    description: s.description || '',
    variables,
    objectives,
    constraints,
  }
}

/** True once the problem is rich enough for a meaningful search. */
export function isSearchable(p: DesignProblem): boolean {
  return p.variables.length >= 1 && p.objectives.length >= 1
}

/** Objectives split into what we can score now vs. honest gaps, given the set of
 *  evaluator ids currently registered. */
export function scoreableSplit(
  p: DesignProblem,
  registeredEvaluators: Set<string>,
): { scored: Objective[]; unscored: Objective[] } {
  const scored: Objective[] = []
  const unscored: Objective[] = []
  for (const o of p.objectives) {
    if (o.evaluator && registeredEvaluators.has(o.evaluator)) scored.push(o)
    else unscored.push(o)
  }
  return { scored, unscored }
}

/** The exact JSON contract the product engine must emit for the design problem
 *  (embedded in the architect prompt). GENERAL across product categories. */
export const DESIGN_PROBLEM_SCHEMA = `{
  "variables": [
    { "name": "<knob, e.g. layers | batteryGeometry | wallThicknessMm>", "discipline": "<electronics|mechanical|... or omit>", "type": "<enum|range>", "options": ["<for enum>"], "min": <for range>, "max": <for range>, "unit": "<unit or omit>" }
  ],
  "objectives": [
    { "name": "<e.g. unitCostUsd | massG | batteryHours | boardAreaMm2>", "direction": "<min|max>", "evaluator": "<registry id that can score this, or omit if none exists yet>", "weight": <relative importance 0-1>, "unit": "<unit>" }
  ],
  "constraints": [
    { "requirement": "<must-hold requirement in plain language>", "hard": true }
  ]
}`
