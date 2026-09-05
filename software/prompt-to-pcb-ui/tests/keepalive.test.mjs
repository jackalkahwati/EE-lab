import assert from 'node:assert/strict'
import test from 'node:test'
const { withKeepalive } = await import(`../lib/keepalive.ts?t=${Date.now()}`)

test('a fast handler is returned completely untouched', async () => {
  const inner = Response.json({ error: 'run belongs to another account' }, { status: 403 })
  const out = await withKeepalive(Promise.resolve(inner), { afterMs: 200 })
  assert.equal(out, inner, 'must be the SAME Response object, not a copy')
  assert.equal(out.status, 403)
  assert.deepEqual(await out.json(), { error: 'run belongs to another account' })
})

test('a slow handler streams keepalive bytes and still parses as JSON', async () => {
  const slow = new Promise((r) => setTimeout(() => r(Response.json({ ok: true, boardMm: { w: 24, h: 24 } })), 320))
  const out = await withKeepalive(slow, { afterMs: 60, everyMs: 20 })
  assert.equal(out.status, 200)
  const text = await out.text()
  assert.ok(text.startsWith(' '), 'must emit filler before the body')
  assert.ok(text.trimStart().startsWith('{'), text.slice(0, 40))
  assert.deepEqual(JSON.parse(text), { ok: true, boardMm: { w: 24, h: 24 } })
})

test('res.json() on the streamed response works — the client changes nothing', async () => {
  const slow = new Promise((r) => setTimeout(() => r(Response.json({ components: 12 })), 300))
  const out = await withKeepalive(slow, { afterMs: 50, everyMs: 20 })
  assert.deepEqual(await out.json(), { components: 12 })
})

test('a late failure arrives as a body error rather than a dead connection', async () => {
  const slow = new Promise((_r, rej) => setTimeout(() => rej(new Error('router died')), 250))
  const out = await withKeepalive(slow, { afterMs: 50, everyMs: 20 })
  assert.equal(out.status, 200)
  const j = await out.json()
  assert.match(j.error, /router died/)
})

test('a fast rejection still throws, so the route can 500 as before', async () => {
  await assert.rejects(
    () => withKeepalive(Promise.reject(new Error('bad json body')), { afterMs: 500 }),
    /bad json body/,
  )
})
