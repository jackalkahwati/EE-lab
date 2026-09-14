import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

// Real GET exports, explicit VM dependencies, in-memory published bytes only.
// No auth module, private run store, native tool, recursive walk or network loads.
const compiled = new Map()
const ROOT = '/virtual/owned-astra'
const ORIGIN = 'http://127.0.0.1:18765'
const missing = () => Object.assign(new Error('private filesystem path'), { code: 'ENOENT' })
const policyError = () => Object.assign(new Error('private owner detail'), { category: 'policy' })
function fixture() {
  const calls = []
  const bytes = new Map()
  const manifests = new Map()
  const denied = new Set()
  const state = { authorized: true, runIds: ['run-test'] }
  const blocked = name => () => { calls.push([`BLOCKED ${name}`]); throw new Error(`Unexpected ${name}`) }
  const filesystem = new Proxy({}, { get: (_target, name) => blocked(`legacy fs.${String(name)}`) })
  const context = vm.createContext({
    Request, Response, Headers, URL, Buffer, Uint8Array, Error,
    process: { env: { FL_ASTRA_BETA: '1' }, cwd: blocked('legacy cwd') },
    fetch: blocked('network'),
  })
  function load(relative, dependencies = {}) {
    if (!compiled.has(relative)) {
      compiled.set(relative, ts.transpileModule(fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      }).outputText)
    }
    const loaded = { exports: {} }
    vm.runInContext(`(function(require,module,exports){${compiled.get(relative)}\n})`, context, { filename: relative })(name => {
      assert.ok(Object.hasOwn(dependencies, name), `Unmocked ${name} in ${relative}`)
      return dependencies[name]
    }, loaded, loaded.exports)
    return loaded.exports
  }
  const view = load('lib/astra-run-view.ts')
  const authorize = runId => {
    if (!state.authorized || denied.has(runId)) throw policyError()
  }
  const beta = {
    astraConfigured: () => true,
    authorizeAstra: () => { calls.push(['authorize']); authorize(); return 'operator@test.invalid' },
    astraWorkspace: () => ({ root: ROOT, origin: ORIGIN }),
    astraErrorResponse: error => Response.json({ error: 'Astra artifact request rejected.', category: error.category ?? 'policy' }, { status: error.category === 'output' ? 502 : 403 }),
  }
  const artifacts = {
    ASTRA_MANIFEST: 'astra-manifest.json',
    authorizeAstraRun: (_req, runId) => { calls.push(['authorizeRun', runId]); authorize(runId); return ROOT },
    readAstraFile: async (root, runId, relative) => {
      assert.equal(root, ROOT)
      calls.push(['read', runId, relative])
      if (!bytes.has(`${runId}/${relative}`)) throw missing()
      return bytes.get(`${runId}/${relative}`)
    },
    readAstraManifest: async (root, runId) => {
      assert.equal(root, ROOT)
      calls.push(['manifest', runId])
      if (!manifests.has(runId)) throw missing()
      // Strict parser prevents arbitrary status-only fixtures from masquerading
      // as published native evidence while keeping filesystem access mocked.
      try { return view.parseAstraManifest(manifests.get(runId), runId) }
      catch { throw Object.assign(new Error('invalid manifest'), { category: 'output' }) }
    },
    publishedAstraFile: async (_req, runId, relative) => {
      calls.push(['published', runId, relative])
      authorize(runId)
      if (!bytes.has(`${runId}/${relative}`)) throw missing()
      return bytes.get(`${runId}/${relative}`)
    },
  }
  const auth = {
    getUser: () => { calls.push(['getUser']); return { runIds: state.runIds } },
    sessionEmail: blocked('legacy session lookup'),
    isValidRunId: value => typeof value === 'string' && /^run-[A-Za-z0-9._-]{1,120}$/.test(value),
    runAccess: (_req, id) => { calls.push(['runAccess', id]); return { access: denied.has(id) ? 'other' : 'owner' } },
  }
  const common = {
    'node:fs': { promises: filesystem }, 'node:path': path,
    '@/lib/astra-beta': beta, '@/lib/astra-artifacts': artifacts,
  }
  // Default imports must also receive traps for synchronous filesystem calls.
  common['node:fs'] = new Proxy({ promises: filesystem }, { get: (target, key) => key === 'promises' ? target.promises : blocked(`legacy fs.${String(key)}`) })
  const download = load('app/runs/[...p]/route.ts', common)
  const files = load('app/api/runs/files/route.ts', common)
  const runs = load('app/api/runs/route.ts', {
    ...common, '@/lib/auth': auth, '@/lib/astra-run-view': view,
    '@/lib/runs-cache': Object.fromEntries(['cacheRun', 'cachedRun', 'persistRunsIndex', 'retainRuns'].map(name => [name, blocked(`legacy cache ${name}`)])),
  })
  const request = route => new Request(`${ORIGIN}${route}`)
  const getDownload = segments => download.GET(request(`/runs/${segments.join('/')}`), { params: Promise.resolve({ p: segments }) })
  const put = (runId, relative, value) => bytes.set(`${runId}/${relative}`, Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)))
  const publish = (runId, overrides = {}) => {
    const manifest = {
      version: 1, runId, scope: 'electronics-only', native: true, status: 'passed', routeAttempts: 1,
      createdAt: '2026-09-13T12:00:00Z', proposalSha256: 'a'.repeat(64), tools: { kicad: 'fake' },
      checks: { drcAvailable: true, drcErrors: 0, unrouted: 0, identityPreserved: true, exportsComplete: true },
      artifacts: Object.keys(view.ASTRA_OUTPUTS).map(relative => ({ path: relative, bytes: 4, sha256: 'b'.repeat(64) })),
      ...overrides,
    }
    manifests.set(runId, manifest)
    put(runId, 'astra-manifest.json', manifest)
    for (const artifact of manifest.artifacts) put(runId, artifact.path, 'fake')
  }
  return { calls, bytes, manifests, denied, state, request, getDownload, files, runs, put, publish }
}

test('actual artifact GET serves PNG, GLB, SVG and native PCB with restrictive headers', async () => {
  const f = fixture()
  for (const [relative, mime] of [
    ['board/render-top.png', 'image/png'], ['board/chipscale.glb', 'model/gltf-binary'],
    ['electronics/layer-top.svg', 'image/svg+xml'], ['electronics/chipscale.kicad_pcb', 'application/octet-stream'],
  ]) {
    const buffer = Buffer.from([0, 1, 127, 255])
    f.put('run-test', relative, buffer)
    const response = await f.getDownload(['run-test', ...relative.split('/')])
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), mime)
    assert.equal(response.headers.get('content-length'), '4')
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'; sandbox/)
    assert.equal(response.headers.get('content-disposition'), relative.endsWith('.kicad_pcb') ? 'attachment; filename="chipscale.kicad_pcb"' : null)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), buffer)
  }
  assert.equal(f.calls.length, 4)
  assert.ok(f.calls.every(call => call[0] === 'published'))
})

test('actual artifact GET distinguishes missing publication from wrong owner without filesystem fallback', async () => {
  const f = fixture()
  const segments = ['run-test', 'board', 'render-top.png']
  const missingResponse = await f.getDownload(segments)
  assert.equal(missingResponse.status, 404)
  assert.doesNotMatch(await missingResponse.text(), /private/)
  f.denied.add('run-test')
  const forbidden = await f.getDownload(segments)
  assert.equal(forbidden.status, 403)
  assert.doesNotMatch(await forbidden.text(), /private/)
  assert.deepEqual(f.calls.map(call => call[0]), ['published', 'published'])
})

test('actual artifact GET rejects traversal and malformed segments before publication reader', async () => {
  const f = fixture()
  for (const segments of [['run-test', '..', 'users.json'], ['run-test', 'a/b'], ['run-test', 'a\\b'], ['run-test', '\0'], ['run-test', '.'], ['run-test', '']]) {
    assert.equal((await f.getDownload(segments)).status, 400)
  }
  assert.equal((await f.getDownload([])).status, 404)
  assert.deepEqual(f.calls, [])
})

test('file-tree GET exposes only strict manifest entries and present metadata without recursive walking', async () => {
  const f = fixture()
  f.publish('run-test')
  f.put('run-test', 'astra-policy.json', { status: 'passed' })
  f.put('run-test', 'product-spec.json', { product: 'Test board' })
  f.put('run-test', 'timing.json', {})
  f.put('run-test', 'private/unpublished.txt', 'must not list')
  const response = await f.files.GET(f.request('/api/runs/files?run=run-test'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const result = await response.json()
  const flatten = nodes => nodes.flatMap(node => node.dir ? flatten(node.children) : [node.path])
  const paths = flatten(result.tree)
  const expected = ['astra-policy.json', 'product-spec.json', 'timing.json', 'astra-manifest.json', ...f.manifests.get('run-test').artifacts.map(a => a.path)]
  assert.deepEqual(paths.sort(), expected.sort())
  assert.equal(result.files, expected.length)
  assert.ok(!f.calls.some(call => call.join(' ').includes('private/unpublished')))
  assert.ok(!f.calls.some(call => call[0].startsWith('BLOCKED')))
})

test('file-tree GET allows partial metadata but rejects malformed manifest and other-owner access', async () => {
  const f = fixture()
  f.put('run-test', 'astra-policy.json', { status: 'cancelled' })
  let response = await f.files.GET(f.request('/api/runs/files?run=run-test'))
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).tree.map(node => node.path), ['astra-policy.json'])
  f.manifests.set('run-test', { status: 'passed' })
  response = await f.files.GET(f.request('/api/runs/files?run=run-test'))
  assert.equal(response.status, 502)
  f.calls.length = 0
  f.denied.add('run-test')
  assert.equal((await f.files.GET(f.request('/api/runs/files?run=run-test'))).status, 403)
  assert.deepEqual(f.calls, [['authorizeRun', 'run-test']])
})

test('run-list GET uses owned IDs and strict manifests, never legacy stores or cache traversal', async () => {
  const f = fixture()
  f.state.runIds = ['run-native', 'run-partial', 'run-invalid', 'run-missing', 'run-other', 'run-native', '../bad', 'legacy-board']
  f.publish('run-native')
  f.put('run-native', 'product-spec.json', { product: 'Native resistor board' })
  f.put('run-partial', 'astra-policy.json', { version: 1, transport: 'astra-beta', model: 'gpt-6-astra', scope: 'electronics-only', status: 'cancelled' })
  f.put('run-invalid', 'product-spec.json', { product: 'Unverified board' })
  f.manifests.set('run-invalid', { status: 'passed' })
  f.denied.add('run-other')
  const response = await f.runs.GET(f.request('/api/runs'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const { runs } = await response.json()
  assert.deepEqual(runs.map(run => run.id).sort(), ['run-invalid', 'run-native', 'run-partial'])
  assert.equal(runs.find(run => run.id === 'run-native').status, 'PASSED')
  assert.equal(runs.find(run => run.id === 'run-partial').status, 'CANCELLED')
  assert.equal(runs.find(run => run.id === 'run-invalid').status, 'UNKNOWN')
  assert.ok(runs.every(run => run.transport === 'astra-beta' && run.scope === 'electronics-only'))
  assert.equal(f.calls.filter(call => call[0] === 'manifest' && call[1] === 'run-native').length, 1)
  assert.ok(!f.calls.some(call => ['read', 'manifest'].includes(call[0]) && call[1] === 'run-other'))
  assert.ok(!f.calls.some(call => call[0].startsWith('BLOCKED')))
})

test('run-list GET denies unauthenticated operator before reading account or artifact data', async () => {
  const f = fixture()
  f.state.authorized = false
  const response = await f.runs.GET(f.request('/api/runs'))
  assert.equal(response.status, 403)
  assert.deepEqual(f.calls, [['authorize']])
})
