import assert from 'node:assert/strict'
import test, { after } from 'node:test'

const rl = await import(`../lib/rate-limit.ts?test=${Date.now()}`)
const originalMax = process.env.FL_RL_MAX_KEYS

after(() => {
  if (originalMax === undefined) delete process.env.FL_RL_MAX_KEYS
  else process.env.FL_RL_MAX_KEYS = originalMax
  rl.resetRateLimitState()
})

test('client ip keying prefers cf-connecting-ip, then the LAST x-forwarded-for hop', () => {
  const ip = (h) => rl.clientIpFromHeaders(new Headers(h))
  assert.equal(ip({}), 'unknown')
  assert.equal(ip({ 'x-real-ip': '10.0.0.9' }), '10.0.0.9')
  // the first XFF hop is client-supplied and forgeable; the last hop is what
  // the nearest proxy appended
  assert.equal(ip({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' }), '3.3.3.3')
  assert.equal(ip({ 'x-forwarded-for': ' 4.4.4.4 ' }), '4.4.4.4')
  assert.equal(ip({ 'x-forwarded-for': ',  ,' , 'x-real-ip': '5.5.5.5' }), '5.5.5.5')
  assert.equal(
    ip({ 'cf-connecting-ip': '6.6.6.6', 'x-forwarded-for': '1.1.1.1, 2.2.2.2', 'x-real-ip': '7.7.7.7' }),
    '6.6.6.6',
  )
})

test('sliding window blocks past the limit and reports retry-after', () => {
  rl.resetRateLimitState()
  const key = `t:window:${Date.now()}`
  for (let i = 0; i < 3; i += 1) {
    assert.equal(rl.checkRateLimit(key, { limit: 3, windowMs: 60_000 }).ok, true)
  }
  const blocked = rl.checkRateLimit(key, { limit: 3, windowMs: 60_000 })
  assert.equal(blocked.ok, false)
  assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 60)
  // limit 0 disables the tier
  assert.equal(rl.checkRateLimit(key, { limit: 0, windowMs: 60_000 }).ok, true)
})

test('tracked keys are capped (LRU eviction) so address rotation cannot grow memory', () => {
  process.env.FL_RL_MAX_KEYS = '5'
  rl.resetRateLimitState()
  const opts = { limit: 100, windowMs: 60_000 }
  for (let i = 0; i < 5; i += 1) rl.checkRateLimit(`t:cap:${i}`, opts)
  assert.equal(rl.trackedKeyCount(), 5)
  // touch key 0 so it becomes most-recently-used
  rl.checkRateLimit('t:cap:0', opts)
  // a 6th key evicts the least-recently-used one (key 1), not key 0
  rl.checkRateLimit('t:cap:5', opts)
  assert.equal(rl.trackedKeyCount(), 5)
  // key 1 was evicted: its counter restarts from a fresh bucket
  assert.equal(rl.checkRateLimit('t:cap:1', { limit: 1, windowMs: 60_000 }).ok, true)
  // key 0 survived: it already has 2 hits, so a limit of 2 blocks it
  assert.equal(rl.checkRateLimit('t:cap:0', { limit: 2, windowMs: 60_000 }).ok, false)
  assert.ok(rl.trackedKeyCount() <= 5)
  // a flood of unique keys never exceeds the cap
  for (let i = 0; i < 1000; i += 1) rl.checkRateLimit(`t:flood:${i}`, opts)
  assert.equal(rl.trackedKeyCount(), 5)
  delete process.env.FL_RL_MAX_KEYS
})
