import assert from 'node:assert/strict'
import test from 'node:test'

const { boardVerdict, isClean, runStatusFor } = await import(`../lib/verdict.ts?t=${Date.now()}`)

const clean = {
  ok: true, components: 12, boardMm: { w: 24, h: 24 },
  drc: { available: true, errors: 0, errorTypes: {}, ruleProfile: 'JLCPCB standard' },
  drcRepair: { unrouted: 0, unroutedSignal: 0, converged: true },
}

test('a board that was really checked and really passed', () => {
  const v = boardVerdict(clean)
  assert.equal(v.state, 'passed')
  assert.equal(v.electrical, 0)
  assert.deepEqual(v.reasons, [])
  assert.equal(isClean(clean), true)
  assert.equal(runStatusFor(clean), 'PASSED')
})

test('a board nobody checked is UNVERIFIED — not passed, not failed', () => {
  const v = boardVerdict({ ...clean, drc: { available: false } })
  assert.equal(v.state, 'unverified')
  assert.equal(v.drcErrors, null, 'never report 0 errors for a check that did not run')
  assert.equal(v.electrical, null)
  assert.match(v.detail, /never checked/)
  assert.equal(isClean({ ...clean, drc: { available: false } }), false)
  // the run list has no third value, so it must not show a green check
  assert.equal(runStatusFor({ ...clean, drc: { available: false } }), 'GATE FAILED')
})

test('no artifact at all is not_built', () => {
  assert.equal(boardVerdict(null).state, 'not_built')
  assert.equal(boardVerdict(undefined).state, 'not_built')
  assert.equal(boardVerdict({}).state, 'not_built')
})

test('DRC errors fail, and the reason names the dominant class', () => {
  const v = boardVerdict({ ...clean, ok: false,
    drc: { available: true, errors: 3, errorTypes: { hole_clearance: 1, clearance: 1, courtyards_overlap: 1 } } })
  assert.equal(v.state, 'failed')
  assert.equal(v.drcErrors, 3)
  assert.ok(v.reasons.some((r) => /3 DRC error/.test(r)), v.reasons.join('|'))
})

test('a stranded ground pad fails the board — it is an open net', () => {
  const v = boardVerdict({
    ...clean, ok: false,
    drc: { available: true, errors: 1, errorTypes: { unconnected_items: 1 } },
    drcRepair: { unrouted: 1, unroutedSignal: 0, converged: false, groundPlane: { available: true, unconnected: 1, errors: 1 } },
  })
  assert.equal(v.state, 'failed')
  assert.equal(v.unrouted, 1)
  assert.equal(v.electrical, 1)
})

test('a ground pass that never ran is called out by name', () => {
  const v = boardVerdict({
    ...clean,
    drcRepair: { unrouted: 0, groundPlane: { available: false, unconnected: 6 } },
  })
  assert.equal(v.state, 'failed')
  assert.ok(v.reasons.some((r) => /ground plane pass did not run/.test(r)), v.reasons.join('|'))
})

test('a violated pinned part fails the board', () => {
  const v = boardVerdict({ ...clean, pinViolations: ['U1 pinned to STM32L071 but STM32F103 was used'] })
  assert.equal(v.state, 'failed')
  assert.ok(v.reasons.some((r) => /pinned/.test(r)))
})

test('electrical faults count shorts, crossings and open nets — never double', () => {
  const v = boardVerdict({ ...clean, ok: false,
    drc: { available: true, errors: 9, errorTypes: { shorting_items: 2, tracks_crossing: 1, unconnected_items: 3 } },
    drcRepair: { unrouted: 3 } })
  // 2 + 1 + max(3 open, 3 unrouted) = 6, not 9
  assert.equal(v.electrical, 6)
})

test('every state produces a headline and a non-empty detail', () => {
  for (const b of [clean, { ...clean, drc: { available: false } }, null,
                   { ...clean, ok: false, drc: { available: true, errors: 2, errorTypes: {} } }]) {
    const v = boardVerdict(b)
    assert.ok(v.headline.length > 0, JSON.stringify(v))
    assert.ok(v.detail.length > 0, JSON.stringify(v))
  }
})
