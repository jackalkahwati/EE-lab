import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import ts from 'typescript'

// Read source only from checkout. Artifact access is mocked or restricted to new
// test-owned scratch. Never import runtime auth/providers or touch real run stores.
const root = new URL('../', import.meta.url)
const source = name => fs.readFileSync(new URL(name, root), 'utf8')
const browserSource = source('lib/astra-run-view.ts')
const serverSource = source('lib/astra-artifacts.ts')
const routeSource = source('app/api/runs/route.ts')
function load(sourceText, deps = {}, globals = {}) {
  const exports = {}
  const compiled = ts.transpileModule(sourceText, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  vm.runInNewContext(compiled, { exports, require: name => {
    if (!(name in deps)) throw Error(`Unmocked dependency: ${name}`)
    return deps[name]
  }, Request, Response, URL, Buffer, console, ...globals })
  return exports
}
class AstraError extends Error {
  constructor(category, message) { super(message); this.category = category }
}
const denied = () => { throw Error('Forbidden dependency reached') }
const validId = id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
const browser = load(browserSource)
const server = load(serverSource, {
  'node:fs/promises': new Proxy({}, { get: () => denied }), 'node:fs': { constants: fs.constants }, 'node:path': path, 'node:crypto': { createHash },
  './auth': { isValidRunId: validId, runAccess: denied }, './astra-beta': { astraWorkspace: denied, authorizeAstra: denied }, './astra-execution': { AstraError },
})
const plain = value => JSON.parse(JSON.stringify(value))
const runId = 'run-test'
const manifest = (changes = {}) => ({
  version: 1, runId, scope: 'electronics-only', status: 'passed', native: true, routeAttempts: 1,
  createdAt: '2026-09-13T11:00:00Z', proposalSha256: 'a'.repeat(64), tools: { kicad: 'fixture only' },
  checks: { drcAvailable: true, drcErrors: 0, unrouted: 0, identityPreserved: true, exportsComplete: true },
  artifacts: Object.keys(browser.ASTRA_OUTPUTS).map(path => ({ path, bytes: 1, sha256: 'b'.repeat(64) })), ...changes,
})

test('browser module executes without any runtime server imports', () => {
  assert.equal(typeof browser.buildAstraRunView, 'function')
  assert.deepEqual(plain(browser.ASTRA_OUTPUTS), plain(server.ASTRA_OUTPUTS))
  assert.equal(browser.ASTRA_MANIFEST, server.ASTRA_MANIFEST)
})

test('browser manifest validator agrees with authoritative server for valid and malformed evidence', () => {
  const samples = [manifest(), manifest({ status: 'failed', checks: { drcAvailable: false, drcErrors: null, unrouted: null, identityPreserved: false, exportsComplete: false }, artifacts: [] }),
    null, [], {}, manifest({ runId: 'run-other' }), manifest({ version: 2 }), manifest({ native: false }), manifest({ scope: 'all' }),
    manifest({ status: 'running' }), manifest({ routeAttempts: 0 }), manifest({ routeAttempts: 2 }), manifest({ routeAttempts: -1 }),
    manifest({ createdAt: 'bad' }), manifest({ proposalSha256: 'bad' }), manifest({ tools: { x: 'x'.repeat(257) } }), manifest({ artifacts: [] }),
    manifest({ artifacts: [{ path: '../secret', bytes: 1, sha256: 'a'.repeat(64) }] }),
    manifest({ artifacts: [...manifest().artifacts, manifest().artifacts[0]] }),
    ...Object.entries({ drcAvailable: false, drcErrors: null, unrouted: null, identityPreserved: false, exportsComplete: false }).map(([key, value]) => manifest({ checks: { ...manifest().checks, [key]: value } })),
    manifest({ checks: { ...manifest().checks, drcErrors: -1 } }), manifest({ checks: { ...manifest().checks, unrouted: '0' } }),
  ]
  for (const sample of samples) {
    let serverValue, browserValue, serverError, browserError
    try { serverValue = server.parseAstraManifest(sample, runId) } catch (e) { serverError = e }
    try { browserValue = browser.parseAstraManifest(sample, runId) } catch (e) { browserError = e }
    assert.equal(!!browserError, !!serverError, JSON.stringify(sample))
    if (!serverError) assert.deepEqual(plain(browserValue), plain(serverValue))
  }
})

test('artifact URLs accept only exact scoped files and safe bounded IDs', () => {
  for (const file of [...Object.keys(browser.ASTRA_OUTPUTS), 'astra-policy.json', 'timing.json', 'product-spec.json', 'astra-manifest.json']) {
    assert.equal(browser.astraArtifactUrl(runId, file), `/runs/${runId}/${file}`)
  }
  for (const id of ['../run-test', 'run-test/secret', 'run-%2e%2e', 'run-?x', 'run-' + 'a'.repeat(125), 'showcase']) assert.throws(() => browser.astraArtifactUrl(id, 'timing.json'))
  for (const file of ['board.json', 'data/board.json', '../private.json', '/timing.json', 'timing.json?x', 'electronics/%2e%2e/timing.json', 'constructor']) assert.throws(() => browser.astraArtifactUrl(runId, file))
})

test('missing publication cannot invent passing stages or numeric metrics', () => {
  const value = browser.buildAstraRunView({ runId, timing: { runId, finishedAt: '2026-09-13T11:00:00Z', stages: [{ stage: 'electronics', status: 'passed' }] } })
  assert.equal(value.transport, 'astra-beta')
  assert.equal(value.status, 'UNKNOWN')
  assert.equal(value.stages[0].state, 'unknown')
  assert.ok(value.stages.slice(1).every(stage => stage.state === 'not-run' && stage.elapsedMs === null))
  assert.deepEqual(plain(value.checks), { drcAvailable: null, drcErrors: null, unrouted: null, identityPreserved: null, exportsComplete: null })
  assert.ok(Object.entries(value.metrics).every(([key, v]) => key === 'hpwlHistory' ? v.length === 0 : v === null))
  assert.equal(value.manifest, null)
  assert.equal(value.artifacts.length, 0)
})

test('native pass requires manifest and preserves real zero evidence without synthetic nets', () => {
  const value = browser.buildAstraRunView({ runId, spec: { product: 'Fixture board' }, manifest: manifest() })
  assert.equal(value.name, 'Fixture board')
  assert.equal(value.status, 'PASSED')
  assert.equal(value.metrics.copperDefects, 0)
  assert.equal(value.metrics.netsRouted, null)
  assert.equal(value.checks.unrouted, 0)
  assert.equal(value.artifacts.length, Object.keys(browser.ASTRA_OUTPUTS).length)
})

test('partial failed and cancelled manifest statuses remain visible without required exports', () => {
  for (const [status, display] of [['failed', 'GATE FAILED'], ['cancelled', 'CANCELLED'], ['unknown', 'UNKNOWN']]) {
    const value = browser.buildAstraRunView({ runId, manifest: manifest({ status, artifacts: [], checks: { drcAvailable: false, drcErrors: null, unrouted: null, identityPreserved: false, exportsComplete: false } }) })
    assert.equal(value.status, display)
    assert.equal(value.metrics.copperDefects, null)
    assert.equal(value.artifacts.length, 0)
  }
})

test('timing restricts results but cannot turn unknown or malformed evidence into success', () => {
  const timing = status => ({ runId, startedAt: '2026-09-13T10:00:00Z', stages: [{ stage: 'electronics', status }] })
  assert.equal(browser.buildAstraRunView({ runId, timing: timing('running') }).status, 'UNKNOWN')
  assert.equal(browser.buildAstraRunView({ runId, timing: timing('running'), active: true }).status, 'RUNNING')
  assert.equal(browser.buildAstraRunView({ runId, timing: { ...timing('running'), finishedAt: '2026-09-13T10:01:00Z' }, active: true }).status, 'UNKNOWN')
  assert.equal(browser.buildAstraRunView({ runId, timing: timing('failed'), manifest: manifest() }).status, 'GATE FAILED')
  assert.equal(browser.buildAstraRunView({ runId, timing: timing('cancelled'), manifest: manifest() }).status, 'CANCELLED')
  assert.equal(browser.buildAstraRunView({ runId, timing: { ...timing('failed'), runId: 'run-other' } }).status, 'UNKNOWN')
  assert.equal(browser.buildAstraRunView({ runId, timing: timing('passed'), manifest: manifest({ artifacts: [] }) }).status, 'UNKNOWN')
  assert.equal(browser.buildAstraRunView({ runId, timing: { runId, stages: [{ stage: 'electronics', detail: 'cancelled?', status: 'unknown' }] } }).status, 'UNKNOWN')
})

test('unfinished historical timing after restart is unknown without a live workflow observation', async () => {
  const timing = { runId, startedAt: '2020-01-01T00:00:00Z', stages: [{ stage: 'electronics', status: 'running' }] }
  const f = routeFixture({ files: { 'run-test/timing.json': timing } })
  const { runs } = await (await f.api.GET(f.request)).json()
  assert.equal(runs[0].status, 'UNKNOWN')
  assert.equal(runs[0].stages[0].state, 'unknown')
  assert.equal(browser.buildAstraRunView({ runId, timing, active: false }).status, 'UNKNOWN')
  assert.equal(browser.buildAstraRunView({ runId, timing, active: true }).status, 'RUNNING')
  assert.equal(browser.buildAstraRunView({ runId, active: true, timing: { runId, stages: [{ stage: 'electronics', status: 'failed' }] } }).status, 'GATE FAILED')
})

test('explicit policy cancellation survives pre-native missing manifest and generic failed timing', () => {
  const policy = { version: 1, transport: 'astra-beta', model: 'gpt-6-astra', scope: 'electronics-only', workflowId: 'fixture-workflow', status: 'cancelled', outcome: { status: 'cancelled', category: 'cancelled', detail: 'Execution cancelled before pipeline completion.' } }
  const timing = { runId, stages: [{ stage: 'electronics', status: 'failed' }] }
  for (const input of [{ policy }, { policy, timing }, { policy, timing, manifest: manifest() }, { policy: { ...policy, status: 'running' }, timing }]) {
    const view = browser.buildAstraRunView({ runId, ...input })
    assert.equal(view.status, 'CANCELLED')
    assert.equal(view.stages[0].state, 'cancelled')
  }
  const failed = { ...policy, status: 'failed', outcome: { status: 'failed', category: 'process', detail: 'mentions cancellation but not cancelled' } }
  assert.equal(browser.buildAstraRunView({ runId, policy: failed }).status, 'GATE FAILED')
  assert.equal(browser.buildAstraRunView({ runId, policy: { ...policy, status: 'passed', outcome: undefined } }).status, 'UNKNOWN')
  for (const changes of [{ version: 2 }, { transport: 'other' }, { model: 'other' }, { scope: 'all' }, { runId: 'run-other' }]) {
    assert.equal(browser.buildAstraRunView({ runId, policy: { ...policy, ...changes } }).status, 'UNKNOWN')
  }
})

function routeFixture(options = {}) {
  const events = []
  const files = options.files ?? { 'run-test/astra-policy.json': { version: 1, transport: 'astra-beta' } }
  const authorization = () => { events.push('authorize'); if (options.deny) throw new AstraError('policy', 'denied'); return 'owner@example.test' }
  const assertAuthorized = () => assert.ok(events.includes('authorize'))
  const artifacts = options.artifacts ?? {
    readAstraFile: async (root, id, file) => {
      assertAuthorized(); assert.equal(root, '/test-owned'); events.push(`read:${id}/${file}`)
      const value = files[`${id}/${file}`]
      if (value === undefined) throw Error('missing fixture')
      return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
    },
    readAstraManifest: async (root, id) => {
      assertAuthorized(); events.push(`manifest:${id}`)
      const value = files[`${id}/astra-manifest.json`]
      return server.parseAstraManifest(value, id)
    },
  }
  const api = load(routeSource, {
    'node:fs': options.legacyFs ?? new Proxy({}, { get: () => denied }), 'node:path': path,
    '@/lib/auth': {
      getUser: () => { assertAuthorized(); events.push('getUser'); return { runIds: options.ids ?? [runId] } },
      sessionEmail: options.sessionEmail ?? denied,
      isValidRunId: validId,
      runAccess: (_req, id) => { assertAuthorized(); events.push(`access:${id}`); return { access: options.access?.[id] ?? 'owner' } },
    },
    '@/lib/runs-cache': { cacheRun: denied, cachedRun: denied, persistRunsIndex: denied, retainRuns: options.retainRuns ?? denied },
    '@/lib/astra-beta': {
      astraConfigured: () => options.configured !== false,
      authorizeAstra: authorization,
      astraWorkspace: () => { assertAuthorized(); events.push('workspace'); return { root: options.scratch ?? '/test-owned' } },
      astraErrorResponse: error => Response.json({ error: error.message }, { status: 403 }),
    },
    '@/lib/astra-artifacts': artifacts, '@/lib/astra-run-view': browser,
  }, { process: { cwd: () => '/test-owned' } })
  return { api, events, request: new Request('http://127.0.0.1:3210/api/runs') }
}

test('beta denies before any artifact reads or legacy disk/cache access', async () => {
  const f = routeFixture({ deny: true })
  assert.equal((await f.api.GET(f.request)).status, 403)
  assert.deepEqual(f.events, ['authorize'])
})

test('beta enumerates owner IDs only and excludes shared, invalid and duplicate ownership before file access', async () => {
  const f = routeFixture({ ids: [runId, runId, 'run-shared', 'run-private', '../private', 'demo'], access: { 'run-shared': 'shared', 'run-private': 'forbidden' } })
  const response = await f.api.GET(f.request)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const { runs } = await response.json()
  assert.deepEqual(runs.map(r => r.id), [runId])
  assert.equal(runs[0].status, 'UNKNOWN')
  assert.ok(f.events.filter(e => /^(read|manifest):/.test(e)).every(e => e.includes('run-test')))
  assert.deepEqual(f.events.slice(0, 3), ['authorize', 'workspace', 'getUser'])
})

test('run list includes partial failed/cancelled and manifest-only runs, excluding missing directories', async () => {
  const f = routeFixture({ ids: ['run-partial', 'run-failed', 'run-cancelled', 'run-missing', runId], files: {
    'run-partial/astra-policy.json': '{incomplete JSON',
    'run-failed/timing.json': { runId: 'run-failed', stages: [{ stage: 'electronics', status: 'failed' }] },
    'run-cancelled/astra-manifest.json': manifest({ runId: 'run-cancelled', status: 'cancelled' }),
    'run-test/astra-manifest.json': manifest(),
  } })
  const { runs } = await (await f.api.GET(f.request)).json()
  const statuses = Object.fromEntries(runs.map(r => [r.id, r.status]))
  assert.deepEqual(statuses, { 'run-test': 'PASSED', 'run-cancelled': 'CANCELLED', 'run-partial': 'UNKNOWN', 'run-failed': 'GATE FAILED' })
})

test('nonbeta empty-list contract remains unchanged and never calls beta authorization', async () => {
  const f = routeFixture({ configured: false, sessionEmail: () => null, legacyFs: {
    readFileSync: () => { throw Error('no fixture users') }, readdirSync: () => [],
  }, retainRuns: ids => assert.equal(ids.size, 0) })
  assert.deepEqual(await (await f.api.GET(f.request)).json(), { runs: [] })
  assert.deepEqual(f.events, [])
})

test('safe-reader integration rejects symlinked run directories, metadata files and parent roots in owned scratch', async t => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'astra-run-view-test-')))
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
  fs.mkdirSync(path.join(scratch, 'public/runs'), { recursive: true })
  fs.mkdirSync(path.join(scratch, 'fixture-private'))
  fs.writeFileSync(path.join(scratch, 'fixture-private/astra-policy.json'), JSON.stringify({ private: true }))
  fs.symlinkSync(path.join(scratch, 'fixture-private'), path.join(scratch, 'public/runs/run-symlink'))
  fs.mkdirSync(path.join(scratch, 'public/runs/run-file-link'))
  fs.symlinkSync(path.join(scratch, 'fixture-private/astra-policy.json'), path.join(scratch, 'public/runs/run-file-link/astra-policy.json'))
  fs.mkdirSync(path.join(scratch, 'public/runs/run-owned'))
  fs.writeFileSync(path.join(scratch, 'public/runs/run-owned/astra-policy.json'), JSON.stringify({ version: 1, transport: 'astra-beta' }))
  const safeFs = Object.fromEntries(['lstat', 'realpath', 'open'].map(method => [method, async (file, ...args) => {
    assert.ok(file === scratch || file.startsWith(scratch + path.sep))
    return fs.promises[method](file, ...args)
  }]))
  const actual = load(serverSource, {
    'node:fs/promises': safeFs, 'node:fs': { constants: fs.constants }, 'node:path': path, 'node:crypto': { createHash },
    './auth': { isValidRunId: validId, runAccess: denied }, './astra-beta': { astraWorkspace: denied, authorizeAstra: denied }, './astra-execution': { AstraError },
  })
  const f = routeFixture({ scratch, ids: ['run-symlink', 'run-file-link', 'run-owned'], artifacts: actual })
  assert.deepEqual((await (await f.api.GET(f.request)).json()).runs.map(r => r.id), ['run-owned'])
  await assert.rejects(actual.readAstraFile(scratch, 'run-owned', '../fixture-private/astra-policy.json'))
  fs.renameSync(path.join(scratch, 'public/runs'), path.join(scratch, 'owned-runs'))
  fs.symlinkSync(path.join(scratch, 'owned-runs'), path.join(scratch, 'public/runs'))
  assert.deepEqual((await (await f.api.GET(f.request)).json()).runs, [])
})
