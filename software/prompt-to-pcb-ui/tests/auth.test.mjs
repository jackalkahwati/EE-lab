import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { NextRequest } from 'next/server.js'

const originalCwd = process.cwd()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-to-pcb-auth-'))
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true })
process.chdir(tmp)

const auth = await import(`../lib/auth.ts?test=${Date.now()}`)
const { proxy } = await import(`../proxy.ts?test=${Date.now()}`)
const originalEnv = {
  AUTH_SECRET: process.env.AUTH_SECRET,
  FL_PASSWORD: process.env.FL_PASSWORD,
  NODE_ENV: process.env.NODE_ENV,
}

after(() => {
  process.chdir(originalCwd)
  fs.rmSync(tmp, { recursive: true, force: true })
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const b64url = (value) => Buffer.from(value).toString('base64url')

test('sessions validate signatures and reject malformed expirations', () => {
  process.env.NODE_ENV = 'test'
  process.env.AUTH_SECRET = 'test-secret-with-enough-entropy-1234567890'
  delete process.env.FL_PASSWORD

  const token = auth.makeSession('Alice@Example.test')
  assert.equal(auth.readSession(token), 'alice@example.test')
  assert.equal(auth.readSession(`${token}tampered`), null)

  // This token has a valid HMAC but a non-numeric expiry. Before the strict
  // expiry check, Number('NaN') < Date.now() was false and it was accepted.
  const payload = `${b64url('alice@example.test')}|NaN`
  const signature = createHmac('sha256', process.env.AUTH_SECRET)
    .update(payload)
    .digest('base64url')
  assert.equal(auth.readSession(`${payload}|${signature}`), null)
  assert.equal(auth.isValidRunId('run-safe_1.2'), true)
  assert.equal(auth.isValidRunId('..'), false)
  assert.equal(auth.isValidRunId('.'), false)
})

test('production refuses to issue or accept sessions without a configured secret', () => {
  process.env.NODE_ENV = 'production'
  delete process.env.AUTH_SECRET
  delete process.env.FL_PASSWORD

  assert.throws(() => auth.makeSession('alice@example.test'), /AUTH_SECRET/)
  assert.equal(auth.readSession('anything|9999999999999|signature'), null)
})

test('run access distinguishes owners, other accounts, and shared demos', async () => {
  process.env.NODE_ENV = 'test'
  process.env.AUTH_SECRET = 'test-secret-with-enough-entropy-1234567890'
  fs.writeFileSync(
    path.join(tmp, 'data', 'users.json'),
    JSON.stringify({
      'alice@example.test': { email: 'alice@example.test', runIds: ['run-alice'] },
      'bob@example.test': { email: 'bob@example.test', runIds: ['run-bob'] },
    }),
  )

  const req = new Request('https://compose.test/api', {
    headers: { cookie: `${auth.SESSION_COOKIE}=${auth.makeSession('alice@example.test')}` },
  })
  assert.equal(auth.runAccess(req, 'run-alice').access, 'owner')
  assert.equal(auth.runAccess(req, 'run-bob').access, 'forbidden')
  assert.equal(auth.runAccess(req, 'golden-demo').access, 'shared')
  assert.equal(
    auth.runAccess(new Request('https://compose.test/api'), 'run-alice').access,
    'unauthenticated',
  )

  const ownedByOther = await proxy(new NextRequest(
    'https://compose.test/runs/run-bob/data/board.json',
    { headers: req.headers },
  ))
  assert.equal(ownedByOther.status, 403)
  const sharedDemo = await proxy(new NextRequest(
    'https://compose.test/runs/golden-demo/data/board.json',
    { headers: req.headers },
  ))
  // Authorized /runs/* requests fall THROUGH to app/runs/[...p]/route.ts, which
  // reads the artifact off disk at request time. It must not be a rewrite: an
  // origin-mismatched rewrite target is proxied externally behind the tunnel
  // and 500s (see proxy.ts), so assert the request is passed on untouched.
  assert.equal(
    sharedDemo.headers.get('x-middleware-rewrite'),
    null,
    'run artifacts must not be rewritten — the route serves /runs directly',
  )
  assert.equal(sharedDemo.headers.get('x-middleware-next'), '1', 'expected pass-through')

  fs.mkdirSync(path.join(tmp, 'data', 'enterprise'), { recursive: true })
  fs.writeFileSync(
    path.join(tmp, 'data', 'enterprise', 'store.json'),
    JSON.stringify({ members: [{ actor: 'alice@example.test' }] }),
  )
  const memberHome = await proxy(new NextRequest(
    'https://compose.test/',
    { headers: req.headers },
  ))
  assert.equal(new URL(memberHome.headers.get('location')).pathname, '/enterprise')

  fs.writeFileSync(
    path.join(tmp, 'data', 'enterprise', 'store.json'),
    JSON.stringify({ members: [] }),
  )
  const personalHome = await proxy(new NextRequest(
    'https://compose.test/',
    { headers: req.headers },
  ))
  assert.equal(new URL(personalHome.headers.get('location')).pathname, '/compose')
})

test('paid credit sessions are idempotent', () => {
  assert.equal(auth.grantCreditsOnce('alice@example.test', 'cs_test_once', 25), true)
  assert.equal(auth.grantCreditsOnce('alice@example.test', 'cs_test_once', 25), false)
  assert.equal(auth.getUser('alice@example.test').extraCredits, 25)
})

test('legacy unversioned sessions stay valid until the account revokes them', async () => {
  // alice has no sessionVersion (pre-revocation account): a 3-segment token is version 0
  const payload = `${b64url('alice@example.test')}|${Date.now() + 60_000}`
  const signature = createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url')
  const legacy = `${payload}|${signature}`
  assert.equal(auth.readSession(legacy), 'alice@example.test')
  const viaProxy = await proxy(new NextRequest('https://compose.test/compose', {
    headers: { cookie: `${auth.SESSION_COOKIE}=${legacy}` },
  }))
  assert.equal(viaProxy.status, 200)

  assert.equal(auth.revokeSessions('alice@example.test'), 1)
  assert.equal(auth.readSession(legacy), null, 'revoked legacy token must be rejected')
  const revokedProxy = await proxy(new NextRequest('https://compose.test/api/anything', {
    headers: { cookie: `${auth.SESSION_COOKIE}=${legacy}` },
  }))
  assert.equal(revokedProxy.status, 401)

  const fresh = auth.makeSession('alice@example.test')
  assert.equal(fresh.split('|').length, 4)
  assert.equal(fresh.split('|')[2], 'v1')
  assert.equal(auth.readSession(fresh), 'alice@example.test')
  const freshProxy = await proxy(new NextRequest('https://compose.test/compose', {
    headers: { cookie: `${auth.SESSION_COOKIE}=${fresh}` },
  }))
  assert.equal(freshProxy.status, 200)
  // a token claiming a different version with a valid signature is still refused
  const forgedPayload = `${b64url('alice@example.test')}|${Date.now() + 60_000}|v0`
  const forgedSig = createHmac('sha256', process.env.AUTH_SECRET).update(forgedPayload).digest('base64url')
  assert.equal(auth.readSession(`${forgedPayload}|${forgedSig}`), null)
})

test('a verified Google identity takes over an unverified password account', async () => {
  const created = auth.createUser('carol@example.test', 'squatter-pass-123')
  assert.equal(created.email, 'carol@example.test')
  auth.recordRun('carol@example.test', 'run-carol')
  const squatterSession = auth.makeSession('carol@example.test')
  assert.equal(auth.readSession(squatterSession), 'carol@example.test')
  assert.ok(auth.verifyUser('carol@example.test', 'squatter-pass-123'))

  const taken = auth.upsertOAuthUser('Carol@Example.test', 'google')
  assert.equal(taken.provider, 'google')
  assert.equal(taken.emailVerified, true)
  assert.equal(taken.sessionVersion, 1)
  assert.deepEqual(taken.runIds, ['run-carol'], 'runs are kept for the verified owner')
  // password login is disabled and every prior session is dead
  assert.equal(auth.verifyUser('carol@example.test', 'squatter-pass-123'), null)
  assert.equal(auth.readSession(squatterSession), null)
  const proxied = await proxy(new NextRequest('https://compose.test/api/anything', {
    headers: { cookie: `${auth.SESSION_COOKIE}=${squatterSession}` },
  }))
  assert.equal(proxied.status, 401)
  // the owner's new session works, and a repeat Google login does not re-bump
  const ownerSession = auth.makeSession('carol@example.test')
  assert.equal(auth.readSession(ownerSession), 'carol@example.test')
  const again = auth.upsertOAuthUser('carol@example.test', 'google')
  assert.equal(again.sessionVersion, 1)
  assert.equal(auth.readSession(ownerSession), 'carol@example.test')
  // unknown addresses still pay for a hash (no early return) and are refused
  assert.equal(auth.verifyUser('nobody@example.test', 'whatever-123'), null)
})

test('a corrupt user store fails closed instead of being treated as empty', () => {
  fs.writeFileSync(path.join(tmp, 'data', 'users.json'), '{not-json')
  assert.throws(() => auth.getUser('alice@example.test'), /user store is unreadable/)
})
