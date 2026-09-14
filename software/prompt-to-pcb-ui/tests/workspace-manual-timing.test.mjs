import assert from 'node:assert/strict'
import test from 'node:test'
import { beginManualTiming } from '../lib/run-pipeline.ts'
import { restoreWorkspaceTiming } from '../lib/workspace-state.ts'

const prior = () => ({ runId: 'fixture', startedAt: '2026-01-01T00:00:00Z', stages: [{ stage: 'mechanical', status: 'passed', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z', ms: 60000 }] })
function store(initial = prior(), failWrite = 0) {
  let saved = initial, writes = 0
  const calls = []
  return { calls, saved: () => saved, read: async (url, options) => {
    calls.push({ url, options })
    assert.ok(options.signal instanceof AbortSignal)
    if (options.method !== 'POST') {
      assert.equal(url, '/runs/fixture/timing.json')
      return { ok: saved !== null, status: saved === null ? 404 : 200, json: async () => structuredClone(saved) }
    }
    assert.equal(url, '/api/runs/timing')
    if (++writes === failWrite) return { ok: false }
    saved = JSON.parse(options.body)
    return { ok: true }
  } }
}
test('manual timing saves running before permission and preserves prior stages on failed reload', async () => {
  const io = store()
  const finish = await beginManualTiming('fixture', 'mechanical', io.read)
  assert.deepEqual(io.saved().stages[0], prior().stages[0])
  assert.equal(io.saved().stages[1].status, 'running')
  assert.equal(restoreWorkspaceTiming(io.saved(), 'fixture').pipeline.mechanical.status, 'unknown')
  await finish({ status: 'failed', detail: 'Explicit synthetic failure' })
  assert.equal(restoreWorkspaceTiming(io.saved(), 'fixture').pipeline.mechanical.status, 'failed')
  assert.equal(io.saved().stages.length, 2)
  await finish({ status: 'passed' })
  assert.equal(io.calls.length, 3, 'duplicate settlement cannot rewrite the failure')
})
test('failed final save leaves unfinished evidence instead of old pass', async () => {
  const io = store(prior(), 2)
  const finish = await beginManualTiming('fixture', 'mechanical', io.read)
  await assert.rejects(finish({ status: 'passed' }))
  assert.equal(restoreWorkspaceTiming(io.saved(), 'fixture').pipeline.mechanical.status, 'unknown')
})
test('404 permits fresh manual ID attempts, unknown remains an allowed saved status', async () => {
  const io = store(null)
  const finish = await beginManualTiming('fixture', 'id', io.read)
  await finish({ status: 'unknown' })
  assert.equal(io.saved().stages[0].status, 'running')
  assert.equal(io.saved().stages[0].unfinished, true)
  assert.equal(restoreWorkspaceTiming(io.saved(), 'fixture').pipeline.id.status, 'unknown')
  const pass = store(null)
  await (await beginManualTiming('fixture', 'id', pass.read))({ status: 'passed' })
  assert.equal(restoreWorkspaceTiming(pass.saved(), 'fixture').pipeline.id.status, 'passed')
  assert.equal(restoreWorkspaceTiming(prior(), 'fixture').pipeline.id, undefined)
})
test('malformed, full and unavailable history never overwrite or permit a start', async () => {
  for (const invalid of [null, {}, { ...prior(), totalMs: -1 }, { ...prior(), runId: 'other' }, { ...prior(), stages: Array(200).fill(prior().stages[0]) }, { ...prior(), stages: [{ ...prior().stages[0], endedAt: '2000-01-01' }] }]) {
    const calls = []
    await assert.rejects(beginManualTiming('fixture', 'mechanical', async (url, options) => {
      calls.push(options)
      return { ok: true, json: async () => invalid }
    }))
    assert.equal(calls.length, 1)
  }
  await assert.rejects(beginManualTiming('fixture', 'mechanical', async () => ({ ok: false, status: 503 })))
  await assert.rejects(beginManualTiming('../escape', 'mechanical', async () => assert.fail('no request')))
  await assert.rejects(beginManualTiming('fixture', 'fake', async () => assert.fail('no request')))
  await assert.rejects(beginManualTiming('fixture', 'mechanical', store(prior(), 1).read))
})
