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
  // Authorized /runs/* requests are rewritten to the dynamic file route (proxy.ts)
  // so artifacts written after a deploy are served live from disk.
  const rewrite = sharedDemo.headers.get('x-middleware-rewrite')
  assert.ok(rewrite, 'expected an x-middleware-rewrite header')
  assert.ok(
    new URL(rewrite).pathname.endsWith('/api/run-file/runs/golden-demo/data/board.json'),
    `unexpected rewrite target: ${rewrite}`,
  )

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

test('a corrupt user store fails closed instead of being treated as empty', () => {
  fs.writeFileSync(path.join(tmp, 'data', 'users.json'), '{not-json')
  assert.throws(() => auth.getUser('alice@example.test'), /user store is unreadable/)
})
