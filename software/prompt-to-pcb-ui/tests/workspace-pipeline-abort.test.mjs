import assert from 'node:assert/strict'
import test from 'node:test'
import { runFullPipeline } from '../lib/run-pipeline.ts'
import { restoreWorkspaceTiming } from '../lib/workspace-state.ts'

// This unit test replaces fetch completely. No API routes, private stores,
// native toolchain or providers are executed.
test('aborted submitted generation persists unfinished history, not skipped', async () => {
  const original = globalThis.fetch
  const controller = new AbortController()
  const calls = [], snapshots = [], events = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push(url)
    if (url === '/api/runs/timing') { snapshots.push(JSON.parse(options.body)); return new Response('{}') }
    if (url === '/api/electronics-cs') {
      controller.abort()
      throw new DOMException('Observation stopped', 'AbortError')
    }
    throw new Error(`Unexpected fixture request ${url}`)
  }
  try {
    await runFullPipeline({ runId: 'synthetic-abort', spec: { disciplines: {} }, signal: controller.signal,
      reuseElectronics: false, onStage: event => events.push(event) })
    const final = snapshots.at(-1)
    assert.equal(final.stages[0].status, 'running')
    assert.equal(final.stages[0].unfinished, true)
    assert.ok(final.finishedAt)
    assert.equal(restoreWorkspaceTiming(final, 'synthetic-abort').pipeline.electronics.status, 'unknown')
    assert.equal(events.some(event => ['skipped', 'passed', 'failed'].includes(event.status)), false)
    assert.equal(calls.filter(url => url !== '/api/runs/timing').length, 1)
  } finally { globalThis.fetch = original }
})
test('a pre-aborted pipeline schedules no engineering stages', async () => {
  const original = globalThis.fetch
  const controller = new AbortController()
  controller.abort()
  const calls = [], events = []
  globalThis.fetch = async url => { calls.push(url); assert.equal(url, '/api/runs/timing'); return new Response('{}') }
  try {
    await runFullPipeline({ runId: 'synthetic-abort', spec: { disciplines: {} }, signal: controller.signal, onStage: event => events.push(event) })
    assert.deepEqual(events, [])
    assert.equal(calls.length, 1)
  } finally { globalThis.fetch = original }
})
