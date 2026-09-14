import assert from 'node:assert/strict'
import test from 'node:test'
import { readEnterprise } from '../lib/enterprise-read.ts'

const signal = () => new AbortController().signal

test('enterprise read uses a read-only request and returns valid data', async () => {
  const s = signal()
  const data = await readEnterprise(s, async (url, init) => {
    assert.equal(url, '/api/enterprise')
    assert.equal(init.method, undefined)
    assert.equal(init.signal, s)
    assert.equal(init.cache, 'no-store')
    return Response.json({ workspaces: [] })
  })
  assert.deepEqual(data, { workspaces: [] })
})

test('authentication and membership failures stay distinct from connection errors', async () => {
  for (const [status, kind] of [[401, 'auth'], [403, 'membership'], [500, 'network'], [429, 'network']]) {
    await assert.rejects(() => readEnterprise(signal(), async () => Response.json({ error: 'server detail' }, { status })),
      error => error.kind === kind)
  }
})

test('malformed or failed success payload is not rendered as an empty workspace', async () => {
  for (const value of [null, [], 'bad', { error: 'not loaded' }]) {
    await assert.rejects(() => readEnterprise(signal(), async () => Response.json(value)), error => error.kind === 'network')
  }
  await assert.rejects(() => readEnterprise(signal(), async () => new Response('not JSON')), error => error.kind === 'network')
})

test('network rejection and cancellation propagate for recovery and stale-read handling', async () => {
  const failure = new Error('offline')
  await assert.rejects(() => readEnterprise(signal(), async () => { throw failure }), error => error === failure)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => readEnterprise(controller.signal, async (_url, { signal }) => {
    signal.throwIfAborted()
  }), error => error.name === 'AbortError')
})
