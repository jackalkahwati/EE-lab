/**
 * Thermal judge — the ONE place a thermal solver result is scored against the
 * product's requirement. Used by the simulation router (/api/simulate via
 * lib/sim-router.ts) and by the redesign feedback loop (/api/redesign), so the
 * stage verdict and the loop's violation list can never disagree.
 *
 * Why this exists: the solver (tools/sim/run_sim.py) runs at a benign ~22°C
 * ambient and knows nothing about the application. It used to hard-code the
 * 43°C IEC touch-temperature as its pass/fail limit for EVERY product, and the
 * router then shifted the absolute peak to the application ambient — which made
 * the thermal gate un-passable (a 5°C rise at 55°C industrial ambient "failed"
 * a 43°C limit). The judge instead works in RISE:
 *
 *   Tj = ambientC(app) + riseC(solver) + powerW × rjcKperW
 *   limitC = junction rating of the product's reliability class
 *   margin = limitC − Tj ; pass ≥ 10°C, tight ≥ 0, fail < 0
 *
 * The 43°C skin limit is applied ONLY when the product is handheld / wearable /
 * skin-contact, and then against the SURFACE (ambient + rise), never the junction.
 *
 * Runtime-import-free on purpose (type-only imports) so a plain Node script can
 * load it for replay/acceptance tests without the Next.js `@/` alias.
 */
import type { ProductSpec } from '@/lib/product-spec'

export type ThermalVerdict = 'pass' | 'tight' | 'fail' | 'model_invalid' | 'unknown'
export type ReliabilityClass = 'consumer' | 'industrial' | 'automotive' | 'defense'
export type PowerSource = 'rails' | 'board_fraction' | 'budget'

/** Junction rating by reliability class (component temperature grade). */
export const JUNCTION_RATING_C: Record<ReliabilityClass, number> = {
  consumer: 85, industrial: 105, automotive: 125, defense: 125,
}
/** Margin below the rating needed for a clean 'pass'. */
export const MIN_MARGIN_C = 10
/** IEC 62368-1 / 60950 touch-temperature limit for a worn/handled surface. */
export const SKIN_LIMIT_C = 43
/** Skin check margin: 43°C with a 10°C margin at a 40°C ambient can never pass,
 *  so the touch limit is judged with a small margin of its own. */
export const SKIN_MIN_MARGIN_C = 3
/** Junction→case resistance assumed when the result carries none (small QFN/module). */
export const DEFAULT_RJC_KPERW = 8
/** Fraction of the product's activeMw budget assumed to be dissipated ON the board
 *  when no rail data exists (the rest is motors/LEDs/radio/loads off-board).
 *  MUST match BOARD_DISSIPATION_FRACTION in tools/sim/run_sim.py. */
export const BOARD_DISSIPATION_FRACTION = 0.25
/** Any solver peak above this is a broken model (no board runs at 200°C), not a design fail. */
export const MODEL_INVALID_PEAK_C = 200
/** Ambient the solver runs at when the result doesn't say (run_sim.py SOLVER_AMBIENT_C). */
export const LEGACY_SOLVER_AMBIENT_C = 22

export interface ThermalEnv {
  /** reliability class → junction rating */
  reliabilityClass: ReliabilityClass
  /** application ambient the product must survive, °C */
  ambientC: number
  /** handheld / wearable / skin-contact → the 43°C surface limit also applies */
  skinContact: boolean
}

export interface ThermalJudgement {
  verdict: ThermalVerdict
  /** which limit produced the verdict */
  limitBasis: 'junction' | 'skin' | 'none'
  reliabilityClass: ReliabilityClass
  ambientC: number
  /** rating used for the junction check */
  limitC: number
  /** surface limit, only enforced when skinContact */
  skinLimitC: number
  skinContact: boolean
  /** normalized solver numbers (after any legacy power correction) */
  riseC: number | null
  powerW: number | null
  rjcKperW: number
  powerSource: PowerSource | 'unknown'
  confidence: 'low' | 'normal'
  /** derived temperatures at the application ambient */
  surfaceC: number | null
  junctionC: number | null
  /** margin to the governing limit (negative = over) */
  marginC: number | null
  /** raw solver peak at the solver ambient (before any normalization) */
  solverPeakC: number | null
  modelInvalid: boolean
  assumptions: string[]
  detail: string
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined)
const r1 = (n: number) => Math.round(n * 10) / 10

const has = (s: string, ...words: string[]) => words.some((w) => s.includes(w))

/** Reliability class from the spec's free-text reliability string + description.
 *  Mirrors the keyword families in lib/sim-router.ts classifyEnv (rugged/mil → defense). */
export function reliabilityClassOf(spec: Pick<ProductSpec, 'description' | 'audience' | 'philosophy' | 'budgets'> | undefined): ReliabilityClass {
  if (!spec) return 'consumer'
  const rel = String(spec.budgets?.reliability ?? '').toLowerCase()
  const desc = `${spec.description ?? ''} ${spec.audience ?? ''} ${spec.philosophy ?? ''}`.toLowerCase()
  const both = `${rel} ${desc}`
  if (has(both, 'automotive', 'vehicle', 'ecu', 'can bus', 'e-mark', 'aec-q')) return 'automotive'
  // no bare 'space' — it would match "workspace"/"spacer"; aerospace/satellite cover the real cases
  if (has(both, 'rugged', 'mil-', 'military', 'defense', 'defence', 'aerospace', 'satellite', 'drone', 'uav')) return 'defense'
  if (has(both, 'industrial', 'din rail', 'factory', 'machine', 'outdoor', 'ip6', 'ip5', 'medical')) return 'industrial'
  return 'consumer'
}

/** Map the router's service-environment class onto a reliability class. */
export function reliabilityClassFromEnv(envClass: string | undefined): ReliabilityClass {
  switch (envClass) {
    case 'automotive': return 'automotive'
    case 'rugged': return 'defense'
    case 'industrial': return 'industrial'
    default: return 'consumer'
  }
}

/** Does the product touch skin (handheld / wearable / worn)? Read from the spec's
 *  text + the mechanical discipline's enclosureKind ("earbud-shell" | "handheld" …). */
export function isSkinContact(spec: Pick<ProductSpec, 'product' | 'description' | 'audience' | 'philosophy' | 'disciplines'> | undefined): boolean {
  if (!spec) return false
  const mech = (spec.disciplines as any)?.mechanical ?? {}
  const text = [
    spec.product, spec.description, spec.audience, spec.philosophy,
    mech.enclosureKind, mech.summary, ...(Array.isArray(mech.requirements) ? mech.requirements : []),
  ].filter(Boolean).join(' ').toLowerCase()
  // word-bounded: a plain substring match on e.g. 'ring' hits "engineering"
  return SKIN_CONTACT_RE.test(text)
}
const SKIN_CONTACT_RE = /\b(wearables?|body-worn|worn on|skin|wrist|earbuds?|hearables?|headphones?|headsets?|hand-?held|hand held|held in the hand|in-hand|gloves?|smart ring|implant(?:able|ed)?)\b/

/** Build the judge's environment straight from a product spec. */
export function thermalEnvOf(spec: ProductSpec | undefined, ambientC?: number): ThermalEnv {
  const reliabilityClass = reliabilityClassOf(spec)
  const defaultAmb = reliabilityClass === 'automotive' ? 85 : reliabilityClass === 'defense' ? 70 : reliabilityClass === 'industrial' ? 55 : 40
  return { reliabilityClass, ambientC: num(ambientC) ?? defaultAmb, skinContact: isSkinContact(spec) }
}

/**
 * Judge one thermal solver result against the application environment.
 * Accepts the NEW solver shape (riseC/peakC/powerW/powerSource top-level) and the
 * LEGACY shape (value = peak at 22°C, detail.powerW, detail.junctionTempC).
 */
export function judgeThermal(result: Record<string, any> | null | undefined, env: ThermalEnv, opts?: { minMarginC?: number }): ThermalJudgement {
  const minMargin = num(opts?.minMarginC) ?? MIN_MARGIN_C
  const limitC = JUNCTION_RATING_C[env.reliabilityClass] ?? JUNCTION_RATING_C.consumer
  const assumptions: string[] = []
  const base = {
    limitBasis: 'none' as const, reliabilityClass: env.reliabilityClass, ambientC: env.ambientC, limitC,
    skinLimitC: SKIN_LIMIT_C, skinContact: env.skinContact, rjcKperW: DEFAULT_RJC_KPERW,
    powerSource: 'unknown' as const, confidence: 'low' as const, riseC: null, powerW: null,
    surfaceC: null, junctionC: null, marginC: null, solverPeakC: null, modelInvalid: false, assumptions,
  }
  if (!result || typeof result !== 'object' || result.error) {
    return { ...base, verdict: 'unknown', detail: result?.error ? `thermal solver error: ${String(result.error).slice(0, 120)}` : 'no thermal result' }
  }
  const d = (result.detail && typeof result.detail === 'object' ? result.detail : {}) as Record<string, any>
  const solverAmb = num(result.solverAmbientC) ?? LEGACY_SOLVER_AMBIENT_C
  // peak at the solver ambient: new field, else the legacy top-level value
  // (FEM peak / lumped case temp). detail.junctionTempC already includes rjc, so
  // it is the last resort only and is corrected back to a case value below.
  let peak = num(result.peakC) ?? num(result.value)
  let rjc = num(result.rjcKperW) ?? num(d.R_jc_KperW) ?? DEFAULT_RJC_KPERW
  if (num(result.rjcKperW) == null && num(d.R_jc_KperW) == null) assumptions.push(`junction-to-case ${DEFAULT_RJC_KPERW} K/W assumed (no package data)`)
  let powerW = num(result.powerW) ?? num(d.powerW) ?? null
  if (peak == null && num(d.junctionTempC) != null && powerW != null) peak = num(d.junctionTempC)! - powerW * rjc
  if (peak == null) return { ...base, verdict: 'unknown', detail: 'thermal solver returned no peak temperature' }

  const modelInvalid = result.modelInvalid === true || peak > MODEL_INVALID_PEAK_C
  let riseC = num(result.riseC) ?? num(d.riseC) ?? (peak - solverAmb)
  if (num(result.riseC) == null && num(d.riseC) == null) assumptions.push(`riseC derived as peak − solver ambient ${solverAmb}°C (legacy result)`)

  // Legacy normalization: results with no powerSource (or 'budget') dumped the
  // FULL activeMw into the board. Both solver paths are linear in P, so rescale
  // rise + power by the same fraction the solver now uses. Stated, low confidence.
  let powerSource: PowerSource | 'unknown' = (['rails', 'board_fraction', 'budget'] as const).includes(result.powerSource) ? result.powerSource : 'unknown'
  let confidence: 'low' | 'normal' = result.confidence === 'low' ? 'low' : 'normal'
  if (powerSource === 'unknown' || powerSource === 'budget') {
    riseC = riseC * BOARD_DISSIPATION_FRACTION
    if (powerW != null) powerW = powerW * BOARD_DISSIPATION_FRACTION
    confidence = 'low'
    assumptions.push(`legacy result used the full activeMw as board heat — rise and power rescaled by the ${BOARD_DISSIPATION_FRACTION} on-board dissipation fraction`)
    powerSource = 'board_fraction'
  } else if (powerSource === 'board_fraction') {
    confidence = 'low'
  }
  if (powerW == null) { powerW = 0; assumptions.push('solver reported no power — junction rise over case taken as 0') }

  const surfaceC = env.ambientC + riseC
  const junctionC = surfaceC + powerW * rjc
  const jMargin = limitC - junctionC
  let verdict: ThermalVerdict = jMargin >= minMargin ? 'pass' : jMargin >= 0 ? 'tight' : 'fail'
  let limitBasis: ThermalJudgement['limitBasis'] = 'junction'
  let marginC = jMargin
  let detail = `rise ${r1(riseC)}°C over ambient (${powerSource}, P=${r1(powerW * 1000) / 1000} W) → Tj ≈ ${r1(junctionC)}°C at the ${env.ambientC}°C ${env.reliabilityClass} ambient vs ${limitC}°C rating → ${r1(jMargin)}°C margin (need ≥${minMargin})`
  if (env.skinContact) {
    const sMargin = SKIN_LIMIT_C - surfaceC
    const sVerdict: ThermalVerdict = sMargin >= SKIN_MIN_MARGIN_C ? 'pass' : sMargin >= 0 ? 'tight' : 'fail'
    const rank = { pass: 0, tight: 1, fail: 2, model_invalid: 3, unknown: 3 }
    if (rank[sVerdict] > rank[verdict]) { verdict = sVerdict; limitBasis = 'skin'; marginC = sMargin }
    detail += `; skin-contact surface ≈ ${r1(surfaceC)}°C vs ${SKIN_LIMIT_C}°C touch limit → ${r1(sMargin)}°C margin (need ≥${SKIN_MIN_MARGIN_C})`
  }
  if (modelInvalid) {
    verdict = 'model_invalid'
    detail = `solver peak ${r1(peak)}°C at ${solverAmb}°C ambient exceeds ${MODEL_INVALID_PEAK_C}°C — the thermal model is invalid for this input (power/area), not a design verdict; ` + detail
  }
  return {
    ...base, verdict, limitBasis, riseC: r1(riseC), powerW, rjcKperW: rjc, powerSource, confidence,
    surfaceC: r1(surfaceC), junctionC: r1(junctionC), marginC: r1(marginC), solverPeakC: peak, modelInvalid, detail,
  }
}
