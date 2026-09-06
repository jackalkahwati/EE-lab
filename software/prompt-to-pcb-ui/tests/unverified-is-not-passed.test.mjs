import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const { simStageVerdict, mechFitDetail } = await import(`../lib/run-pipeline.ts?t=${Date.now()}`)
const { evaluateFit } = await import(`../lib/mechanical-plan.ts?t=${Date.now()}`)

// A check that did not run is not a check that passed. Both of these reported
// success for work that never happened.

test('a required simulation that could not run FAILS the stage', () => {
  const v = simStageVerdict({ assessment: { assessments: [], gaps: ['thermal: no solver result for this analysis'] } })
  assert.equal(v.status, 'failed')
  assert.match(v.detail, /could not run/)
  assert.match(v.detail, /UNVERIFIED/)
  // and it must NOT claim what it used to claim
  assert.doesNotMatch(v.detail, /all required sims meet application requirements/)
  // gaps are not "fails": no budget change makes an absent solver run, so the
  // redesign controller must not be handed them as actionable.
  assert.deepEqual(v.fails, [])
  assert.equal(v.gaps.length, 1)
})

test('a genuinely clean simulation still passes', () => {
  const v = simStageVerdict({ assessment: { assessments: [
    { kind: 'thermal', applicability: 'required', verdict: 'pass', detail: '52C junction' },
  ], gaps: [] }, results: [] })
  assert.equal(v.status, 'passed')
  assert.match(v.detail, /all required sims meet application requirements/)
})

test('a required simulation judged fail still fails, and is still actionable', () => {
  const v = simStageVerdict({ assessment: { assessments: [
    { kind: 'thermal', applicability: 'required', verdict: 'fail', detail: '104C junction vs 85C rating' },
  ], gaps: [] } })
  assert.equal(v.status, 'failed')
  assert.equal(v.fails.length, 1)
})

test('an unidentified cavity reports fits: null, never true', () => {
  const ev = evaluateFit({
    pcb: { kind: 'rect', w: 24, h: 24 },
    cavity: null,
    outer: { kind: 'rect', w: 90, h: 90 },
    wall: 2, slack: 0.5,
    cavitySelection: { candidates: [] },
  })
  assert.equal(ev.verdict, 'unknown')
  assert.equal(ev.fits, null, 'an unverified fit must not read as true')
  assert.match(ev.problems.join(' '), /NOT verified/)
})

test('a real fit and a real misfit are unchanged', () => {
  const fits = evaluateFit({ pcb: { kind: 'rect', w: 24, h: 24 }, cavity: { kind: 'rect', w: 40, h: 40 }, outer: null, wall: 2, slack: 0.5 })
  assert.equal(fits.verdict, 'fits'); assert.equal(fits.fits, true)
  const no = evaluateFit({ pcb: { kind: 'rect', w: 50, h: 50 }, cavity: { kind: 'rect', w: 40, h: 40 }, outer: null, wall: 2, slack: 0.5 })
  assert.equal(no.verdict, 'does_not_fit'); assert.equal(no.fits, false)
})

test('the pipeline detail never prints "fits the cavity" for an unverified fit', () => {
  const d = mechFitDetail({ fitCheck: { fits: null, verdict: 'unknown', pcbMm: { w: 24, h: 24 }, cavityMm: null, enclosureMm: { w: 90, h: 90 }, problems: [] } })
  assert.doesNotMatch(d, /fits the cavity/)
  assert.match(d, /NOT verified/)
})

test('the product job\'s firmware stage follows the EDA firmware BUILD: no image, no pass', () => {
  const rp = fs.readFileSync(new URL('../lib/run-pipeline.ts', import.meta.url), 'utf8')
  assert.match(rp, /\/runs\/\$\{opts\.runId\}\/data\/last-run\.json/, 'reads the EDA run record')
  assert.match(rp, /if \(fw && fw\.state === 'failed'\) \{\s*set\('firmware', 'failed'/, 'a failed build fails the discipline stage')
  assert.match(rp, /fw\.state === 'passed' && !last\.fwZip/, 'a passed build with no persisted image is not a pass either')
})
