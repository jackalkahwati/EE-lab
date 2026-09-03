#!/usr/bin/env node
/**
 * Replay stored simulation results through the thermal judge (lib/sim-judge.ts
 * via lib/sim-router.ts) — the acceptance test for the thermal gate.
 *
 * Reads <runsDir>/<runId>/disciplines/simulation.json + product-spec.json
 * READ-ONLY, re-plans the simulations from the spec (so the judge sees the
 * reliability class / skin-contact flags), judges the stored solver results, and
 * prints the thermal verdict next to the ORIGINAL stored verdict.
 *
 * Legacy results carry no riseC/powerSource: the judge derives riseC = peak − 22
 * and rescales rise + power by the on-board dissipation fraction (the stored
 * solve dumped the full activeMw into the board). Both the raw formula and the
 * normalized numbers are printed so the correction is visible, not hidden.
 *
 *   node scripts/replay-sim-judge.mjs [runsDir] [runId ...]
 *
 * Node ≥ 23.6 (type stripping on by default); on 22.x add --experimental-strip-types.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { planSimulations, judge, thermalEnvFromPlan } from '../lib/sim-router.ts'
import { judgeThermal, JUNCTION_RATING_C, DEFAULT_RJC_KPERW, LEGACY_SOLVER_AMBIENT_C } from '../lib/sim-judge.ts'

const DEFAULT_RUNS = '/Volumes/T9 Backup/EE-lab/software/prompt-to-pcb-ui/public/runs'
const DEFAULT_IDS = [
  { id: 'run-901d519c-6eff-43ca-b455-1575160b6c03', expect: ['pass'], why: '5°C rise, industrial 55°C ambient' },
  { id: 'run-6b186c10-1efb-4bc0-a684-5dd5a60c3667', expect: ['pass', 'tight'], why: '74°C peak (0.6 W budget), consumer 40°C ambient' },
  { id: 'run-88c6728f', expect: ['model_invalid'], why: '761°C peak — broken model, not a design fail' },
]

const [, , argDir, ...argIds] = process.argv
const runsDir = argDir && !argDir.startsWith('run-') ? argDir : DEFAULT_RUNS
const wanted = (argDir?.startsWith('run-') ? [argDir, ...argIds] : argIds)
const cases = wanted.length ? wanted.map((id) => ({ id, expect: null, why: '' })) : DEFAULT_IDS

const resolveId = (prefix) => {
  const hit = readdirSync(runsDir).find((n) => n === prefix || n.startsWith(prefix))
  if (!hit) throw new Error(`no run matching ${prefix} under ${runsDir}`)
  return hit
}
const r1 = (n) => Math.round(n * 10) / 10

let failures = 0
for (const c of cases) {
  const id = resolveId(c.id)
  const dir = path.join(runsDir, id)
  const sim = JSON.parse(readFileSync(path.join(dir, 'disciplines', 'simulation.json'), 'utf8'))
  const spec = JSON.parse(readFileSync(path.join(dir, 'product-spec.json'), 'utf8'))
  const results = sim.results ?? []
  const thermal = results.find((r) => r?.sim === 'thermal')
  const stored = (sim.assessment?.assessments ?? []).find((a) => a.kind === 'thermal')

  const plan = planSimulations(spec, {
    hasBattery: !!spec.budgets?.power?.batteryMah,
    rails: Array.isArray(sim.inputs?.pdn?.rails) ? sim.inputs.pdn.rails.length : 0,
  })
  const env = thermalEnvFromPlan(plan)
  const assessment = judge(plan, results)
  const a = assessment.assessments.find((x) => x.kind === 'thermal')
  const j = judgeThermal(thermal, env)

  // raw formula for legacy results (no normalization) — shown for transparency
  const peak = thermal?.peakC ?? thermal?.value
  const P = thermal?.powerW ?? thermal?.detail?.powerW ?? 0
  const rawRise = thermal?.riseC ?? (peak - (thermal?.solverAmbientC ?? LEGACY_SOLVER_AMBIENT_C))
  const rawTj = env.ambientC + rawRise + P * DEFAULT_RJC_KPERW
  const rating = JUNCTION_RATING_C[env.reliabilityClass]

  console.log(`\n=== ${id}${c.why ? `  (${c.why})` : ''}`)
  console.log(`  spec: ${spec.product} | reliability="${spec.budgets?.reliability ?? ''}"`)
  console.log(`  env:  class=${plan.environment.class} reliability=${env.reliabilityClass} ambient=${env.ambientC}°C rating=${rating}°C skinContact=${env.skinContact}`)
  console.log(`  stored solver: peak=${peak}°C powerW=${P} powerSource=${thermal?.powerSource ?? '(legacy: full activeMw)'} limit=${thermal?.limit} pass=${thermal?.pass}`)
  console.log(`  stored verdict (old router): ${stored?.verdict ?? '—'} — ${stored?.detail ?? ''}`)
  console.log(`  raw formula (no power correction): rise=${r1(rawRise)} → Tj=${r1(rawTj)}°C vs ${rating}°C → margin ${r1(rating - rawTj)}°C`)
  console.log(`  judge: verdict=${j.verdict} basis=${j.limitBasis} rise=${j.riseC} P=${j.powerW} Tj=${j.junctionC} surface=${j.surfaceC} margin=${j.marginC} source=${j.powerSource} confidence=${j.confidence} modelInvalid=${j.modelInvalid}`)
  for (const s of j.assumptions) console.log(`    assumption: ${s}`)
  console.log(`  router: applicability=${a?.applicability} verdict=${a?.verdict}`)
  console.log(`  router summary: ${JSON.stringify(assessment.summary)}`)
  if (c.expect) {
    const ok = c.expect.includes(j.verdict) && a?.verdict === j.verdict
    console.log(`  EXPECT ${c.expect.join('|')} → ${ok ? 'OK' : 'MISMATCH'}`)
    if (!ok) failures++
  }
}
console.log(failures ? `\n${failures} case(s) MISMATCHED` : '\nall cases OK')
process.exit(failures ? 1 : 0)
