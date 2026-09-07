// The mechanical stage closes on the measured fit the way the board closes on
// DRC: a plan that does not hold the real board is regenerated from its
// measured problems before the picture judge ever sees it, and a board that
// fits rotated 90° counts as a fit (run 47acb0ae shipped a 66×41 cavity for a
// 32×50 board with standoffs on nothing).
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../app/api/mechanical/route.ts', import.meta.url), 'utf8')

test('the plan is measured and regenerated from fit problems before rendering', () => {
  assert.match(src, /const FIT_ROUNDS = 2/)
  assert.match(src, /let fit = measureFit\(plan\)/)
  assert.match(src, /for \(let round = 1; round <= FIT_ROUNDS && fitFails\(fit\); round\+\+\)/)
  assert.match(src, /callLLM\(userMsg \+ fitBlock\(round, fit\), override\)/)
  // a regenerated plan is adopted only when it fits or has fewer problems
  assert.match(src, /const better = !fitFails\(m2\) \|\| m2\.problems\.length < fit\.problems\.length/)
})

test('a board that fits rotated 90° is a fit, and says so', () => {
  assert.match(src, /measureFitAs\(plan, true\)/)
  assert.match(src, /board sits rotated 90° in the cavity/)
  assert.match(src, /x: -h\.y, y: h\.x/)
})

test('the fidelity re-plans cannot ship a plan that broke the fit unchecked', () => {
  const i = src.indexOf('fit = measureFit(plan)\n    if (fitFails(fit))')
  assert.ok(i > 0, 'the shipped plan is re-measured after the fidelity loop')
  assert.match(src, /fitClosure, boardRotated: fit\.rotated, mountingAligned/)
})
