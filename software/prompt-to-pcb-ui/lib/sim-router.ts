/**
 * Simulation router — the engineering-intelligence layer over the solvers.
 *
 * The solvers in tools/sim/run_sim.py (thermal FEM, modal FEM, 3D CalculiX FEA,
 * CFD, RF FDTD, PDN, acoustic, battery) already RUN and each self-skips when it
 * lacks inputs. What was missing is the judgement a real engineer applies:
 *
 *   1. WHICH analyses does THIS application actually require? (a rugged vehicle
 *      unit MUST clear vibration; a desk gadget need not.) Availability of inputs
 *      is not the same as relevance to the product.
 *   2. Does each result MEET the application's requirement? A natural frequency
 *      is just a number until you compare it to the vibration environment.
 *   3. If a REQUIRED analysis did not run, that is a GAP to surface — never a
 *      silent pass.
 *
 * planSimulations() reads the product spec and emits that plan; judge() scores
 * the solver results against it. Requirements are derived transparently from the
 * spec (power, mass, size, and the `reliability`/description environment string)
 * with stated assumptions — never invented silently.
 */
import type { ProductSpec } from '@/lib/product-spec'
// relative import with the .ts extension (not '@/') so a plain Node replay script
// (scripts/replay-sim-judge.mjs) can load this module; tsconfig allows it.
import { judgeThermal, reliabilityClassFromEnv, reliabilityClassOf, isSkinContact, JUNCTION_RATING_C, type ReliabilityClass } from './sim-judge.ts'

export type SimKind =
  | 'thermal' | 'drop' | 'structural3d' | 'enclosure_fea' | 'cfd_thermal'
  | 'pdn' | 'antenna_fdtd' | 'rf' | 'cavity_acoustic' | 'acoustic' | 'battery'

export type Applicability = 'required' | 'recommended' | 'optional' | 'not_applicable'
/** 'no_data'      — the analysis did not run (a GAP when required)
 *  'unknown'      — it ran but returned nothing scoreable
 *  'model_invalid'— it ran but the number is physically absurd (thermal peak >200°C):
 *                   a modelling problem to surface, never a design fail */
export type Verdict = 'pass' | 'tight' | 'fail' | 'no_data' | 'not_run' | 'unknown' | 'model_invalid'

export interface SimRequirement {
  kind: SimKind
  applicability: Applicability
  reason: string            // why this analysis matters (or not) for this product
  requirement?: string      // the threshold the result must meet, in words
  target?: Record<string, number> // machine-checkable thresholds where they exist
}

export interface SimPlan {
  environment: {
    class: 'benign' | 'consumer' | 'industrial' | 'rugged' | 'automotive'
    ambientC: number
    /** reliability class → component junction rating (lib/sim-judge.ts) */
    reliabilityClass?: ReliabilityClass
    ratingC?: number
    /** handheld / wearable / skin-contact → 43°C touch limit also applies */
    skinContact?: boolean
    vibration: boolean
    vibHint: string
    ip?: string
    sealed: boolean
  }
  requirements: SimRequirement[]
  assumptions: string[]
}

const kw = (s: string, ...words: string[]) => words.some((w) => s.includes(w))

/** Classify the service environment from the reliability string + description. */
function classifyEnv(spec: ProductSpec) {
  const rel = String(spec.budgets?.reliability ?? '').toLowerCase()
  const desc = `${spec.description ?? ''} ${spec.audience ?? ''} ${spec.philosophy ?? ''}`.toLowerCase()
  const both = `${rel} ${desc}`
  const ipMatch = both.match(/ip[\s-]?(\d\d)/)
  const ip = ipMatch ? `IP${ipMatch[1]}` : undefined
  let cls: SimPlan['environment']['class'] = 'consumer'
  if (kw(both, 'automotive', 'vehicle', 'ecu', 'can bus', 'e-mark')) cls = 'automotive'
  else if (kw(both, 'rugged', 'mil-', 'military', 'defense', 'field', 'drone', 'uav', 'handheld tool')) cls = 'rugged'
  else if (kw(both, 'industrial', 'din rail', 'factory', 'machine', 'outdoor', 'ip6', 'ip5')) cls = 'industrial'
  else if (kw(both, 'desk', 'indoor', 'ambient', 'home', 'wearable', 'consumer')) cls = 'consumer'
  else cls = 'consumer'
  const vibration = kw(both, 'vibrat', 'shock', 'drop', 'vehicle', 'automotive', 'rugged', 'motor', 'gantry', 'moving', 'portable', 'handheld', 'drone', 'uav')
  const sealed = kw(both, 'sealed', 'potted', 'waterproof', 'ip6', 'ip5', 'outdoor') || (!!ip && Number(ip.slice(2, 3)) >= 5)
  const ambientC = cls === 'automotive' ? 85 : cls === 'rugged' ? 70 : cls === 'industrial' ? 55 : cls === 'consumer' ? 40 : 25
  const vibHint = cls === 'automotive' ? 'ISO 16750 / broadband to ~2 kHz'
    : cls === 'rugged' ? 'MIL-STD-810 random vibe / drop'
    : vibration ? 'motor/handling excitation to a few hundred Hz' : 'benign (desktop)'
  // consumer is the catch-all class: let the finer reliability-string read decide the rating there
  const reliabilityClass = cls === 'consumer' ? reliabilityClassOf(spec) : reliabilityClassFromEnv(cls)
  return {
    class: cls, ambientC, vibration, vibHint, ip, sealed,
    reliabilityClass, ratingC: JUNCTION_RATING_C[reliabilityClass], skinContact: isSkinContact(spec),
  }
}

/** Thermal environment for the judge from a plan (legacy stored plans lack the
 *  reliability fields — fall back from the service class). */
export function thermalEnvFromPlan(plan: SimPlan) {
  const e = plan.environment
  const reliabilityClass = e.reliabilityClass ?? reliabilityClassFromEnv(e.class)
  return { reliabilityClass, ambientC: e.ambientC, skinContact: e.skinContact ?? false }
}

export function planSimulations(spec: ProductSpec, ctx?: { hasRadio?: boolean; isAudio?: boolean; hasBattery?: boolean; hasEnclosure?: boolean; rails?: number }): SimPlan {
  const env = classifyEnv(spec)
  const power = spec.budgets?.power ?? {}
  const activeMw = Number(power.activeMw ?? 0)
  const massG = Number(spec.budgets?.massG ?? 0)
  const assumptions: string[] = [
    `service environment classed '${env.class}' from reliability="${spec.budgets?.reliability ?? '—'}"; ambient assumed ${env.ambientC}°C`,
  ]
  const reqs: SimRequirement[] = []

  // THERMAL — required whenever meaningful power is dissipated or the box is sealed
  if (activeMw >= 500 || env.sealed || env.class !== 'consumer') {
    reqs.push({
      kind: 'thermal', applicability: activeMw >= 2000 || env.sealed ? 'required' : 'recommended',
      reason: `${activeMw} mW dissipated${env.sealed ? ' in a sealed enclosure' : ''} at up to ${env.ambientC}°C ambient`,
      requirement: `all junctions below the ${env.ratingC}°C ${env.reliabilityClass} rating with ≥10°C margin at ${env.ambientC}°C ambient${env.skinContact ? '; surface ≤43°C (skin contact)' : ''}`,
      target: { ambientC: env.ambientC, minMarginC: 10 },
    })
    if (env.sealed && activeMw >= 2000) reqs.push({
      kind: 'cfd_thermal', applicability: 'recommended',
      reason: 'sealed box + high power — natural-convection detail affects the margin',
      requirement: 'CFD confirms the lumped/FEM convection assumption',
    })
  } else {
    reqs.push({ kind: 'thermal', applicability: 'optional', reason: `low power (${activeMw} mW), open/consumer use` })
  }

  // VIBRATION / MODAL — required for anything that moves or mounts to something that vibrates
  if (env.vibration) {
    reqs.push({
      kind: 'drop', applicability: env.class === 'automotive' || env.class === 'rugged' ? 'required' : 'recommended',
      reason: `${env.class} service with vibration exposure (${env.vibHint})`,
      requirement: 'board fundamental frequency clears the excitation band (aim >2× top forcing freq; ≥100 Hz min) so it does not resonate',
      target: { minF0Hz: env.class === 'automotive' ? 400 : env.class === 'rugged' ? 300 : 100 },
    })
    if (ctx?.hasEnclosure) reqs.push({
      kind: 'structural3d', applicability: 'recommended',
      reason: 'enclosure/mount must survive vibration + handling loads',
      requirement: 'peak stress below yield with a safety factor ≥2; mount deflection small',
    })
  } else {
    reqs.push({ kind: 'drop', applicability: 'optional', reason: 'benign/static service — resonance unlikely to matter' })
  }

  // enclosure 3D FEA available when there is real CAD
  if (ctx?.hasEnclosure && !env.vibration) reqs.push({
    kind: 'enclosure_fea', applicability: 'optional', reason: 'CAD present; run if a structural load is specified',
  })

  // RF — required if the product carries a radio
  if (ctx?.hasRadio) reqs.push({
    kind: 'antenna_fdtd', applicability: 'required',
    reason: 'product carries a radio; enclosure/board detune the antenna',
    requirement: 'link margin positive with the enclosure in place',
  })

  // PDN — required with multiple/fast rails
  if ((ctx?.rails ?? 0) >= 2) reqs.push({
    kind: 'pdn', applicability: 'recommended', reason: `${ctx?.rails} power rails — check rail impedance/decoupling`,
    requirement: 'rail impedance below target across the load band',
  })

  // battery runtime
  if (ctx?.hasBattery || power.batteryMah) reqs.push({
    kind: 'battery', applicability: 'required', reason: 'battery-powered; runtime is a spec',
    requirement: power.runtimeHours ? `meets ${power.runtimeHours} h runtime target` : 'runtime characterised',
    target: power.runtimeHours ? { runtimeHours: power.runtimeHours } : undefined,
  })

  // audio
  if (ctx?.isAudio) reqs.push({
    kind: 'acoustic', applicability: 'required', reason: 'audio product — back-volume/cavity response matters',
  })

  return { environment: env, requirements: reqs, assumptions }
}

/** Score the solver results against the plan. Any REQUIRED analysis that did not
 *  run is reported as a gap (no_data), never a silent pass. */
export function judge(plan: SimPlan, results: Array<Record<string, any>>): {
  assessments: Array<{ kind: SimKind; applicability: Applicability; verdict: Verdict; requirement?: string; detail: string }>
  gaps: string[]
  summary: { required: number; passed: number; tight: number; failed: number; gaps: number; modelInvalid: number; unknown: number }
} {
  const byKind = new Map<string, Record<string, any>>()
  for (const r of results) if (r && typeof r.sim === 'string') byKind.set(r.sim, r)

  const assessments = plan.requirements.map((req) => {
    const r = byKind.get(req.kind)
    let verdict: Verdict = 'no_data'
    let detail = 'no solver result for this analysis'
    if (!r) {
      verdict = req.applicability === 'required' ? 'no_data' : 'not_run'
      detail = req.applicability === 'required'
        ? 'REQUIRED for this application but did not run (missing inputs) — gap'
        : 'not run (not required for this application, or inputs absent)'
    } else {
      const j = scoreOne(req, r, plan)
      verdict = j.verdict; detail = j.detail
    }
    return { kind: req.kind, applicability: req.applicability, verdict, requirement: req.requirement, detail }
  })

  const gaps = assessments
    .filter((a) => a.applicability === 'required' && (a.verdict === 'no_data'))
    .map((a) => `${a.kind}: ${a.detail}`)
  const req = assessments.filter((a) => a.applicability === 'required')
  return {
    assessments, gaps,
    summary: {
      required: req.length,
      passed: assessments.filter((a) => a.verdict === 'pass').length,
      tight: assessments.filter((a) => a.verdict === 'tight').length,
      failed: assessments.filter((a) => a.verdict === 'fail').length,
      gaps: gaps.length,
      modelInvalid: assessments.filter((a) => a.verdict === 'model_invalid').length,
      unknown: assessments.filter((a) => a.verdict === 'unknown').length,
    },
  }
}

/** Is this the verdict of a REQUIRED analysis that actually failed its requirement?
 *  'model_invalid' and 'unknown' are surfaced as warnings, never as fails;
 *  recommended/optional analyses never fail a stage. */
export function isRequiredFail(a: { applicability: Applicability; verdict: Verdict }): boolean {
  return a.applicability === 'required' && a.verdict === 'fail'
}

/** Judge one result against one requirement. run_sim.py results follow a common
 *  shape { sim, metric, value, unit, limit, pass, note, ... } with a few
 *  analysis-specific fields; we match those real names. */
function scoreOne(req: SimRequirement, r: Record<string, any>, plan: SimPlan): { verdict: Verdict; detail: string } {
  const t = req.target ?? {}
  if (req.kind === 'thermal') {
    // One judge for the stage AND the redesign loop (lib/sim-judge.ts): works in
    // RISE over the solver's ambient, re-based to the application ambient, plus
    // the junction-over-case term, against the reliability class's rating.
    const env = thermalEnvFromPlan(plan)
    const j = judgeThermal(r, { ...env, ambientC: num(t.ambientC) ?? env.ambientC }, { minMarginC: num(t.minMarginC) })
    return { verdict: j.verdict, detail: j.detail }
  }
  if (req.kind === 'drop') {
    // modal FEM fundamental frequency: `value` in Hz (unit==='Hz').
    const f0 = (String(r.unit).toLowerCase() === 'hz' || /freq/i.test(String(r.metric ?? '')))
      ? num(r.value) : num(r.value)
    const minF0 = num(t.minF0Hz) ?? 100
    if (f0 == null) return { verdict: 'no_data', detail: 'modal solver returned no fundamental frequency' }
    return {
      verdict: f0 >= minF0 ? 'pass' : f0 >= minF0 * 0.7 ? 'tight' : 'fail',
      detail: `fundamental ${round(f0)} Hz vs ≥${minF0} Hz for this vibration environment — ${f0 >= minF0 ? 'clears' : 'risks'} resonance`,
    }
  }
  if (req.kind === 'battery') {
    const hrs = num(r.runtimeHours ?? r.hours ?? (String(r.unit).toLowerCase().startsWith('h') ? r.value : undefined))
    const target = num(t.runtimeHours)
    if (hrs == null) return { verdict: 'no_data', detail: 'battery sim returned no runtime' }
    if (target == null) return { verdict: 'pass', detail: `runtime ${round(hrs)} h (no explicit target)` }
    return { verdict: hrs >= target ? 'pass' : hrs >= target * 0.9 ? 'tight' : 'fail', detail: `${round(hrs)} h vs ${target} h target` }
  }
  // generic: use the solver's own pass flag against its own limit
  const ok = r.pass ?? r.ok
  const vl = num(r.value) != null && num(r.limit) != null ? ` (${round(num(r.value)!)}${r.unit ?? ''} vs ${round(num(r.limit)!)} limit)` : ''
  return { verdict: ok === false ? 'fail' : 'pass', detail: (r.note ? String(r.note).slice(0, 120) : 'result produced') + vl }
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined)
const round = (n: number) => Math.round(n * 10) / 10
