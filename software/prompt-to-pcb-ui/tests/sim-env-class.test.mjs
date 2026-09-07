// The simulation router classifies the service environment from the product
// spec's own words. "bench/field tool, informal use" must not become a
// rugged/defense environment with a REQUIRED drop test (run 0fce3670 did).
import assert from 'node:assert/strict'
import test from 'node:test'

const { planSimulations } = await import(`../lib/sim-router.ts?t=${Date.now()}`)
const base = { product: 'Handheld environmental monitor', description: 'A handheld wand-style field instrument with an STM32F103 MCU and BME280 sensor', audience: 'Field technician or bench engineer', budgets: { power: { activeMw: 300 }, reliability: 'bench/field tool, hand-assembled, 1-2yr informal use' } }

test('a bench/field tool is consumer-class: drop is recommended, not required', () => {
  const plan = planSimulations(base, { hasEnclosure: true })
  assert.equal(plan.environment.class, 'consumer')
  const drop = plan.requirements.find((r) => r.kind === 'drop')
  assert.ok(drop, 'handheld → vibration → a drop/modal requirement exists')
  assert.notEqual(drop.applicability, 'required')
  assert.ok(plan.environment.ambientC <= 40, `ambient ${plan.environment.ambientC}`)
})

test('an explicit rugged/defense spec still classes rugged with drop required', () => {
  const plan = planSimulations({ ...base, budgets: { ...base.budgets, reliability: 'MIL-STD-810 rugged field-deployed unit' } }, { hasEnclosure: true })
  assert.equal(plan.environment.class, 'rugged')
  assert.equal(plan.requirements.find((r) => r.kind === 'drop').applicability, 'required')
})

test('the simulate route estimates a board mass when none is stated, and labels it', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../app/api/simulate/route.ts', import.meta.url), 'utf8')
  assert.match(src, /massG: num\(design\.massG\) \?\? spec\.budgets\?\.massG \?\? massEstimateG/)
  assert.match(src, /board mass \$\{massEstimateG\} g ESTIMATED/)
})
