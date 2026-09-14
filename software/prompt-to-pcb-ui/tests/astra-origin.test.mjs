import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { NextRequest } from 'next/server.js'

// NextRequest is the real URL-normalizing implementation, not a mock. Creating
// requests and evaluating this pure helper never starts a server or makes I/O.
const compiled = ts.transpileModule(fs.readFileSync(new URL('../lib/astra-origin.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const loaded = { exports: {} }
vm.runInNewContext(`(function(exports){${compiled}\n})`, { URL })(loaded.exports)
const { astraRequestOriginAllowed: allowed } = loaded.exports
const ORIGIN = 'http://127.0.0.1:18765'
const HOST = '127.0.0.1:18765'
const next = (url = `${ORIGIN}/api/astra`, headers = {}) => new NextRequest(url, { headers })

test('real NextRequest canonicalizes numeric loopback but exact numeric Host remains accepted', () => {
  const req = next(`${ORIGIN}/api/astra`, { host: HOST, origin: ORIGIN, 'sec-fetch-site': 'same-origin' })
  assert.equal(req.url, 'http://localhost:18765/api/astra')
  assert.equal(req.nextUrl.origin, 'http://localhost:18765')
  assert.equal(req.headers.get('host'), HOST)
  assert.equal(allowed(req, ORIGIN, true), true)
  assert.equal(allowed(req, ORIGIN), true)
})

test('proxy requires exact numeric Host, rejecting missing, localhost, IPv6 and alternate ports', () => {
  for (const host of [undefined, 'localhost:18765', '[::1]:18765', '127.0.0.2:18765', '127.0.0.1', '127.0.0.1:18766', '127.0.0.1:018765', '127.0.0.1:18765.', '127.0.0.1:18765, evil.test', 'evil.test']) {
    const req = next(`${ORIGIN}/api/astra`, host === undefined ? {} : { host })
    assert.equal(allowed(req, ORIGIN, true), false, String(host))
  }
})

test('direct numeric internal Request may omit Host; normalized localhost may not', () => {
  assert.equal(allowed(new Request(`${ORIGIN}/api/electronics-cs`), ORIGIN), true)
  assert.equal(allowed(new Request(`${ORIGIN}/api/electronics-cs`), ORIGIN, true), false)
  assert.equal(allowed(new Request('http://localhost:18765/api/astra'), ORIGIN), false)
  assert.equal(allowed(next(), ORIGIN), false)
  assert.equal(allowed(new Request('http://localhost:18765/api/astra', { headers: { host: HOST } }), ORIGIN, true), true)
})

test('request URL protocol, port, credentials and other hosts cannot be rescued by Host', () => {
  for (const url of [
    'https://127.0.0.1:18765/api/astra', 'http://127.0.0.1:18766/api/astra',
    'http://127.0.0.2:18765/api/astra', 'http://[::1]:18765/api/astra',
    'http://evil.test:18765/api/astra', 'http://127.0.0.1/api/astra',
  ]) assert.equal(allowed(new Request(url, { headers: { host: HOST } }), ORIGIN, true), false, url)
  // Fetch Request prohibits credential-bearing URLs before construction. The
  // helper must also reject an equivalent request-shaped server input itself.
  for (const url of ['http://user@127.0.0.1:18765/api/astra', 'http://user:password@localhost:18765/api/astra']) {
    assert.equal(allowed({ url, headers: new Headers({ host: HOST }) }, ORIGIN, true), false)
  }
})

test('forged forwarding headers grant no access and do not override valid direct authority', () => {
  const forwarded = {
    'x-forwarded-host': HOST, 'x-forwarded-proto': 'http',
    forwarded: `for=127.0.0.1;host=${HOST};proto=http`,
  }
  assert.equal(allowed(next(`${ORIGIN}/api/astra`, forwarded), ORIGIN, true), false)
  assert.equal(allowed(next(`${ORIGIN}/api/astra`, { ...forwarded, host: 'evil.test' }), ORIGIN, true), false)
  assert.equal(allowed(new Request('http://evil.test:18765/api/astra', { headers: { ...forwarded, host: HOST } }), ORIGIN, true), false)
  assert.equal(allowed(next(`${ORIGIN}/api/astra`, {
    host: HOST, 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https', forwarded: 'host=evil.test',
  }), ORIGIN, true), true)
})

test('Origin must match configured numeric endpoint exactly and cross-site is always denied', () => {
  for (const origin of ['null', 'http://localhost:18765', 'http://127.0.0.2:18765', 'http://[::1]:18765', 'http://127.0.0.1:18766', 'https://127.0.0.1:18765', `${ORIGIN}/`, 'http://evil.test', '']) {
    assert.equal(allowed(next(`${ORIGIN}/api/astra`, { host: HOST, origin }), ORIGIN, true), false, origin)
  }
  assert.equal(allowed(next(`${ORIGIN}/api/astra`, { host: HOST, origin: ORIGIN, 'sec-fetch-site': 'cross-site' }), ORIGIN, true), false)
  assert.equal(allowed(next(`${ORIGIN}/api/astra`, { host: HOST, origin: ORIGIN }), ORIGIN, true), true)
  assert.equal(allowed(next(`${ORIGIN}/api/astra`, { host: HOST }), ORIGIN, true), true)
})

test('invalid configured endpoints fail closed before request normalization exceptions', () => {
  const req = next(`${ORIGIN}/api/astra`, { host: HOST })
  for (const origin of ['', 'not a URL', 'https://127.0.0.1:18765', 'http://localhost:18765', 'http://127.0.0.2:18765', 'http://[::1]:18765', 'http://127.0.0.1:80', 'http://127.0.0.1:1023', 'http://127.0.0.1:65536', `${ORIGIN}/`, `${ORIGIN}?x=1`, `${ORIGIN}#fragment`, 'http://user@127.0.0.1:18765']) {
    assert.equal(allowed(req, origin, true), false, origin)
  }
  assert.equal(allowed({ url: 'not a URL', headers: new Headers() }, ORIGIN), false)
})
