import assert from 'node:assert/strict'
import test from 'node:test'

const { densityFailure, electronicsVerdict } = await import(`../lib/run-pipeline.ts?t=${Date.now()}`)

/** A board whose signal routing finished but whose ground pour stranded a pad. */
const strandedGroundPad = {
  boardMm: { w: 24, h: 24 },
  ok: false,
  drc: { available: true, errors: 1, errorTypes: { unconnected_items: 1 }, groundPlaneApplied: true },
  drcRepair: { unrouted: 1, unroutedSignal: 0, converged: false, groundPlane: { assigned: 5, unconnected: 1 } },
}

test('a stranded ground pad is a failure, but never a density failure', () => {
  // It must still fail — this is the whole point of scoring the shipped board.
  assert.equal(electronicsVerdict(strandedGroundPad).clean, false)
  // ...and it must NOT be told to split itself in two. The pad is just as
  // unreachable on both halves.
  assert.equal(densityFailure(strandedGroundPad), false)
})

test('the ground pour failing entirely is still not a density failure', () => {
  const noPour = {
    boardMm: { w: 20, h: 20 },
    ok: false,
    drc: { available: true, errors: 0, errorTypes: {} },
    drcRepair: { unrouted: 6, unroutedSignal: 0, converged: false, groundPlane: { available: false, unconnected: 6 } },
  }
  assert.equal(electronicsVerdict(noPour).clean, false)
  assert.equal(densityFailure(noPour), false)
})

test('signal nets the router could not complete ARE a density failure', () => {
  assert.equal(densityFailure({
    drc: { available: true, errors: 0, errorTypes: {} },
    drcRepair: { unrouted: 3, unroutedSignal: 3 },
  }), true)
})

test('copper and courtyards fighting for room IS a density failure', () => {
  for (const type of ['shorting_items', 'tracks_crossing', 'clearance', 'courtyards_overlap']) {
    assert.equal(
      densityFailure({ drc: { errorTypes: { [type]: 2 } }, drcRepair: { unrouted: 0, unroutedSignal: 0 } }),
      true,
      `${type} should read as overcrowding`,
    )
  }
})

test('older boards with no unroutedSignal fall back to subtracting the ground pins', () => {
  // Artifacts written before unroutedSignal existed still have to be judged.
  assert.equal(densityFailure({
    drc: { errorTypes: {} },
    drcRepair: { unrouted: 2, groundPlane: { unconnected: 2 } },
  }), false)
  assert.equal(densityFailure({
    drc: { errorTypes: {} },
    drcRepair: { unrouted: 3, groundPlane: { unconnected: 1 } },
  }), true)
})

test('a clean board is neither', () => {
  const clean = {
    boardMm: { w: 20, h: 20 },
    ok: true,
    drc: { available: true, errors: 0, errorTypes: {} },
    drcRepair: { unrouted: 0, unroutedSignal: 0, converged: true },
  }
  assert.equal(electronicsVerdict(clean).clean, true)
  assert.equal(densityFailure(clean), false)
})
