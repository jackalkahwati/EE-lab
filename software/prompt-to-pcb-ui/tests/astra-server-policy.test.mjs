import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import vm from 'node:vm'
import ts from 'typescript'
import { NextRequest } from 'next/server.js'

// Only source text is read from disk. Every app import is explicitly injected;
// no auth store, output directory, native executable, provider or network is used.
const compiled = new Map()
const ROOT = '/virtual/astra-app'
const ORIGIN = 'http://127.0.0.1:18765'
const category = name => error => error?.category === name
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const json = value => JSON.parse(JSON.stringify(value))

function fixture(t, envOverrides = {}) {
  const effects = []
  const env = {
    NODE_ENV: 'development', FL_ASTRA_BETA: '1', FL_ASTRA_ROOT: ROOT,
    FL_ASTRA_BIND: '127.0.0.1', FL_ASTRA_ORIGIN: ORIGIN, ...envOverrides,
  }
  const state = {
    cwd: ROOT, owner: 'operator@example.test', admin: true, user: {},
    links: new Map(), notDirectories: new Set(), missing: new Set(),
    marker: { version: 1, root: ROOT, purpose: 'isolated-astra-beta' },
    preflightError: null, nativeError: null,
    cliReply: { enough: true, spec: { product: 'Test resistor board' } },
  }
  const files = new Map()
  const directories = new Set()
  const blocked = name => (...args) => {
    effects.push([name, ...args])
    throw new Error(`Unexpected side effect: ${name}`)
  }
  const fakeFs = {
    constants: { X_OK: 1 },
    realpathSync: p => {
      if (state.missing.has(p)) throw new Error('private filesystem diagnostic')
      return state.links.get(p) || p
    },
    lstatSync: p => {
      if (state.missing.has(p)) throw new Error('private filesystem diagnostic')
      return {
        isDirectory: () => !state.notDirectories.has(p),
        isFile: () => p === `${ROOT}/.astra-workspace.json` && !state.notDirectories.has(p),
        isSymbolicLink: () => state.links.has(p),
        size: Buffer.byteLength(typeof state.marker === 'string' ? state.marker : JSON.stringify(state.marker)),
      }
    },
    readFileSync: p => {
      assert.equal(p, `${ROOT}/.astra-workspace.json`, 'never read a private store')
      return typeof state.marker === 'string' ? state.marker : JSON.stringify(state.marker)
    },
    existsSync: blocked('legacy filesystem probe'),
    accessSync: blocked('native filesystem access'), statSync: blocked('native stat'),
  }
  const fakeAsyncFs = {
    mkdir: async (p, options) => {
      effects.push(['mkdir', p, options])
      assert.ok(p.startsWith(`${ROOT}/public/runs/run-`))
      if (directories.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      directories.add(p)
    },
    writeFile: async (p, value) => {
      effects.push(['write', p])
      assert.ok(p.startsWith(`${ROOT}/public/runs/run-`))
      files.set(p, String(value))
    },
    readFile: async p => {
      effects.push(['read', p])
      if (!files.has(p)) throw Object.assign(new Error('missing fake artifact'), { code: 'ENOENT' })
      return files.get(p)
    },
    rename: async (from, to) => {
      effects.push(['rename', from, to])
      assert.ok(files.has(from))
      files.set(to, files.get(from))
      files.delete(from)
    },
    rm: async p => { effects.push(['rm', p]); files.delete(p) },
  }
  fakeFs.promises = fakeAsyncFs
  const context = vm.createContext({
    Request, Response, Headers, URL, URLSearchParams, ReadableStream,
    TextEncoder, TextDecoder, Buffer, AbortController, AbortSignal, Error, structuredClone,
    setTimeout, clearTimeout, setInterval: blocked('interval'), clearInterval,
    console, process: { env, cwd: () => state.cwd, execPath: '/virtual/node', platform: process.platform },
    fetch: blocked('network'),
  })
  function load(relative, dependencies = {}) {
    if (!compiled.has(relative)) {
      const source = fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
      compiled.set(relative, ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      }).outputText)
    }
    const loadedModule = { exports: {} }
    const safeRequire = name => {
      assert.ok(Object.hasOwn(dependencies, name), `Unmocked import ${name} from ${relative}`)
      return dependencies[name]
    }
    vm.runInContext(`(function(require,module,exports){${compiled.get(relative)}\n})`, context, { filename: relative })(safeRequire, loadedModule, loadedModule.exports)
    return loadedModule.exports
  }
  const children = { spawn: blocked('spawn'), spawnSync: blocked('spawnSync') }
  const execution = load('lib/astra-execution.ts', {
    'node:async_hooks': { AsyncLocalStorage }, 'node:child_process': children,
    'node:fs': fakeFs, 'node:path': path, 'node:os': { userInfo: blocked('userInfo') },
  })
  const executions = []
  const executionApi = {
    ...execution,
    createAstraExecution: options => {
      const result = execution.createAstraExecution(options)
      executions.push(result)
      return result
    },
  }
  t.after(() => executions.forEach(e => e.cancel()))
  const auth = {
    sessionEmail: () => state.owner, isAdminRequest: () => state.admin, getUser: () => state.user,
    isValidRunId: id => /^run-[A-Za-z0-9._-]{1,128}$/.test(id),
    recordRun: (...args) => effects.push(['recordRun', ...args]),
    runAccess: blocked('legacy run access'), canRun: blocked('legacy quota'),
    chargeCredits: blocked('legacy credits'), creditsAvailable: blocked('legacy credits'), creditsForRun: blocked('legacy credits'),
  }
  let serial = 0
  const originPolicy = load('lib/astra-origin.ts')
  const beta = load('lib/astra-beta.ts', {
    './astra-origin': originPolicy,
    'node:fs': fakeFs, 'node:path': path, 'node:crypto': { randomUUID: () => `workflow-${++serial}` },
    './auth': auth, './astra-execution': executionApi,
  })
  const local = {
    preflightAstraElectronics: async () => {
      effects.push(['preflight'])
      if (state.preflightError) throw state.preflightError
    },
  }
  const transport = {
    astraNativeConfig: () => {
      effects.push(['nativeConfig'])
      if (state.nativeError) throw state.nativeError
      return { cli: '/virtual/astra', proxy: 'http://127.0.0.1:18766' }
    },
  }
  const llm = {
    callLLMText: async () => {
      const active = execution.currentAstraExecution()
      effects.push([active ? 'fakeCLI' : 'alternateProvider'])
      assert.ok(active, 'Astra request must never enter an alternate provider')
      execution.claimAstraCall(active)
      if (state.cliError) throw state.cliError
      return { text: JSON.stringify(state.cliReply), provider: 'astra-beta (Bedrock)' }
    },
    extractRust: blocked('legacy code generation'),
  }
  const design = load('lib/astra-design-contract.ts')
  const template = design.ASTRA_DESIGN_TEMPLATE
  const designRequest = { templateId: template.id, request: template.prompt, answers: [] }
  const validSpec = {
    product: 'BME280 test breakout', description: 'External 3.3V I2C breakout', budgets: {},
    disciplines: {
      electronics: {
        status: 'defined', summary: 'BME280 electronics', boardIntent: 'External host sensor breakout',
        maxBoardMm: { x: 24, y: 18 }, layers: 2, contract: json(template.electricalContract),
      },
      ...Object.fromEntries(['mechanical', 'firmware', 'manufacturing', 'supplyChain', 'validation'].map(name => [name, { status: 'not_applicable', summary: 'Not run', requirements: [] }])),
    },
  }
  state.cliReply = { enough: true, spec: json(validSpec) }
  const body = load('lib/astra-body.ts', { './astra-execution': executionApi })
  const common = {
    '@/lib/astra-design-contract': design,
    '@/lib/astra-body': body,
    '@/lib/astra-beta': beta, '@/lib/astra-execution': executionApi,
    '@/lib/astra-local-parts': local, '@/lib/llm': llm,
    '@/lib/byok': { overrideForRequest: () => undefined, hasByok: blocked('legacy BYOK') },
    '@/lib/spend-gate': { assertCanSpend: () => null },
    '@/lib/model-tiers': { MODEL: { design: 'unused-default' } },
    '@/lib/product-spec': { PRODUCT_SPEC_SCHEMA: {}, normalizeSpec: blocked('legacy spec normalization') },
    '@/lib/id-brief': { normalizeIdBrief: value => value, idBriefSummary: () => '' },
    '@/lib/keepalive': { withKeepalive: promise => promise },
  }
  const api = () => load('app/api/astra/route.ts', { ...common, '@/lib/astra-transport': transport })
  const architect = () => load('app/api/architect/route.ts', common)
  const artifacts = load('lib/astra-artifacts.ts', {
    'node:fs/promises': fakeAsyncFs, 'node:fs': fakeFs, 'node:path': path,
    'node:crypto': { createHash: blocked('artifact hash') },
    './auth': auth, './astra-beta': beta, './astra-execution': executionApi,
  })
  const saveManifest = (runId, overrides = {}) => {
    const manifest = {
      version: 1, runId, scope: 'electronics-only', status: 'passed', native: true,
      routeAttempts: 1, createdAt: '2026-09-13T00:00:00Z', proposalSha256: 'a'.repeat(64),
      tools: { kicad: 'fake-version' },
      checks: { drcAvailable: true, drcErrors: 0, unrouted: 0, identityPreserved: true, exportsComplete: true },
      artifacts: Object.keys(artifacts.ASTRA_OUTPUTS).map(name => ({ path: name, bytes: 1, sha256: 'b'.repeat(64) })),
      ...overrides,
    }
    files.set(`${ROOT}/public/runs/${runId}/${artifacts.ASTRA_MANIFEST}`, JSON.stringify(manifest))
  }
  const pipeline = load('lib/astra-pipeline.ts', {
    'node:fs/promises': fakeAsyncFs, 'node:path': path, './auth': auth,
    './astra-beta': beta, './astra-execution': executionApi, './astra-local-parts': local,
    './astra-design-contract': design,
    './astra-artifacts': {
      ASTRA_MANIFEST: artifacts.ASTRA_MANIFEST,
      parseAstraManifest: artifacts.parseAstraManifest,
      readAstraManifest: async (root, runId) => {
        assert.equal(root, ROOT)
        // Exercise the actual strict schema against fake persisted bytes. File-handle
        // isolation and hashes belong to artifact tests, not this orchestration fixture.
        const text = await fakeAsyncFs.readFile(`${root}/public/runs/${runId}/${artifacts.ASTRA_MANIFEST}`)
        return artifacts.parseAstraManifest(JSON.parse(text), runId)
      },
    },
  })
  const pipelineRoute = electronics => load('app/api/pipeline/run/route.ts', {
    ...common, 'node:child_process': children, 'node:fs': fakeFs, 'node:path': path,
    'node:os': { tmpdir: blocked('legacy scratch') }, '@/lib/auth': auth,
    '@/app/api/electronics-cs/route': { POST: electronics }, '@/lib/astra-pipeline': pipeline,
    '@/app/api/v1/_lib': { v1Auth: blocked('legacy API auth') },
    '@/lib/design-gate': { runDesignGate: blocked('design gate'), runFunctionalWire: blocked('functional wire') },
    '@/lib/plan-llm': { resolvePlanModel: blocked('alternate model resolution') },
    '@/lib/toolchain': { kicadCli: () => '/virtual/kicad-cli', kicadPython: () => '/virtual/python' },
  })
  function request(route = '/api/astra', { method = 'GET', headers = {}, body, workflow, signal } = {}) {
    return new Request(`${ORIGIN}${route}`, {
      method, signal,
      headers: { host: new URL(ORIGIN).host, 'sec-fetch-site': 'same-origin', cookie: 'fake-session', ...(workflow === undefined ? {} : { 'x-fl-astra-workflow': workflow }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
  }
  const ready = () => {
    const id = beta.beginAstraWorkflow(request())
    const req = request('/api/astra', { workflow: id })
    const workflow = beta.astraWorkflow(req)
    workflow.spec = json(validSpec)
    workflow.templateId = template.id
    workflow.phase = 'ready'
    return { id, workflow, req }
  }
  return { load, beta, execution, state, effects, env, files, directories, saveManifest, designRequest, validSpec, request, ready, api, architect, pipeline, pipelineRoute, fakeFs, blocked }
}

test('API allowlist denies unknown POST and mutation-bearing GET endpoints', t => {
  const f = fixture(t)
  const { astraApiAllowed } = f.load('lib/astra-request-policy.ts')
  const reads = ['/api/astra', '/api/auth/me', '/api/admin/me', '/api/runs', '/api/runs/files', '/api/runs/work-items', '/api/runs/stage-hash', '/api/pipeline/run']
  for (const route of reads) assert.equal(astraApiAllowed(route, 'GET'), true, route)
  for (const route of ['/api/astra', '/api/architect', '/api/electronics-cs', '/api/auth/login', '/api/auth/logout']) assert.equal(astraApiAllowed(route, 'POST'), true, route)
  for (const route of ['/api/auth/login', '/api/auth/logout']) {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'post']) assert.equal(astraApiAllowed(route, method), false, `${method} ${route}`)
  }
  for (const route of ['/api/interview', '/api/firmware', '/api/mechanical', '/api/simulate', '/api/billing/webhook', '/api/auth/signup', '/api/auth/google', '/api/auth/oauth', '/api/auth/callback', '/api/auth/login/', '/api/auth/logout/', '/api/auth/login/extra', '/api/runs/delete', '/api/v1/jobs', '/api/unknown', '/api/astra/']) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) assert.equal(astraApiAllowed(route, method), false, `${method} ${route}`)
  }
  for (const method of ['POST', 'DELETE', 'PUT']) assert.equal(astraApiAllowed('/api/pipeline/run', method), false)
})

test('actual proxy export blocks unsupported APIs before auth, stores or handlers', async t => {
  const f = fixture(t)
  const policy = f.load('lib/astra-request-policy.ts')
  const { proxy } = f.load('proxy.ts', {
    'next/server.js': { NextResponse: { json: Response.json.bind(Response), next: f.blocked('proxy pass-through') } },
    'node:fs': f.fakeFs, 'node:path': path, './lib/astra-request-policy.ts': policy,
    './lib/astra-beta': f.beta,
    './lib/astra-origin': f.load('lib/astra-origin.ts'),
    './lib/rate-limit.ts': { checkRateLimit: f.blocked('rate limit'), clientIpFromHeaders: f.blocked('client IP'), envInt: f.blocked('rate config'), rateLimitDisabled: f.blocked('rate config') },
  })
  for (const route of ['/api/interview', '/api/firmware', '/api/runs/delete', '/api/v1/jobs']) {
    for (const method of ['GET', 'POST']) {
      const req = f.request(route, { method })
      req.nextUrl = new URL(req.url)
      const response = await proxy(req)
      assert.equal(response.status, 409)
      assert.match((await response.json()).error, /unsupported/i)
    }
  }
  f.env.NODE_ENV = 'production'
  const req = f.request('/api/astra'); req.nextUrl = new URL(req.url)
  assert.equal((await proxy(req)).status, 403)
  assert.deepEqual(f.effects, [])
})

test('proxy permits only same-origin local login/logout POST before session authentication', async t => {
  const f = fixture(t)
  const policy = f.load('lib/astra-request-policy.ts')
  const { proxy } = f.load('proxy.ts', {
    'next/server.js': { NextResponse: {
      json: Response.json.bind(Response),
      next: () => { f.effects.push(['next']); return new Response(null, { status: 204 }) },
    } },
    'node:fs': f.fakeFs, 'node:path': path, './lib/astra-request-policy.ts': policy,
    './lib/astra-beta': f.beta,
    './lib/astra-origin': f.load('lib/astra-origin.ts'),
    './lib/rate-limit.ts': {
      rateLimitDisabled: () => { f.effects.push(['rate-limit']); return false },
      clientIpFromHeaders: () => '127.0.0.1', envInt: (_key, fallback) => fallback,
      checkRateLimit: () => ({ ok: true }),
    },
  })
  const request = (route, headers = {}, method = 'POST') => {
    const req = f.request(route, { method, headers })
    req.nextUrl = new URL(req.url)
    req.cookies = { get: f.blocked('session authentication') }
    return req
  }
  for (const route of ['/api/auth/login', '/api/auth/logout']) {
    const normalized = new NextRequest(`${ORIGIN}${route}`, {
      method: 'POST', headers: { host: new URL(ORIGIN).host, origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    })
    assert.equal(new URL(normalized.url).hostname, 'localhost')
    f.effects.length = 0
    assert.equal((await proxy(normalized)).status, 204, 'actual NextRequest normalization must not block local login/logout')
    assert.deepEqual(f.effects.map(e => e[0]), ['rate-limit', 'next'])
    for (const headers of [{ origin: ORIGIN }, {}]) {
      f.effects.length = 0
      assert.equal((await proxy(request(route, headers))).status, 204)
      assert.deepEqual(f.effects.map(e => e[0]), ['rate-limit', 'next'])
    }
    for (const headers of [
      { origin: 'http://evil.test' }, { origin: 'null' },
      { origin: ORIGIN, 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'cross-site' },
    ]) {
      f.effects.length = 0
      const response = await proxy(request(route, headers))
      assert.equal(response.status, 403)
      assert.match((await response.json()).error, /same-origin/)
      assert.deepEqual(f.effects, [], 'cross-origin login/logout stops before rate limiting or authentication')
    }
    f.effects.length = 0
    assert.equal((await proxy(request(route, {}, 'GET'))).status, 409)
    assert.deepEqual(f.effects, [])
  }
  for (const route of ['/api/auth/signup', '/api/auth/google', '/api/auth/oauth', '/api/auth/callback', '/api/auth/login/', '/api/auth/logout/']) {
    f.effects.length = 0
    assert.equal((await proxy(request(route, { origin: ORIGIN }))).status, 409)
    assert.deepEqual(f.effects, [], 'other auth/provider entrypoints remain blocked before public-route bypass')
  }
})

test('workspace is opt-in, canonical, loopback-only, and disabled in production', t => {
  const f = fixture(t)
  assert.equal(f.beta.astraConfigured(), true)
  assert.deepEqual(json(f.beta.astraWorkspace()), { root: ROOT, home: `${ROOT}/.astra-home`, origin: ORIGIN })
  for (const overrides of [
    { FL_ASTRA_BETA: undefined, FL_ASTRA_ROOT: undefined }, { FL_ASTRA_BETA: '0', FL_ASTRA_ROOT: undefined },
    { FL_ASTRA_BETA: 'true' }, { NODE_ENV: 'production' }, { FL_ASTRA_BIND: '0.0.0.0' },
    { FL_ASTRA_ROOT: 'relative' }, { FL_ASTRA_ROOT: undefined }, { FL_ASTRA_ORIGIN: 'https://example.test' },
  ]) {
    const before = { ...f.env }
    Object.assign(f.env, overrides)
    assert.throws(() => f.beta.astraWorkspace(), category('policy'), JSON.stringify(overrides))
    if (!f.env.FL_ASTRA_ROOT && (!f.env.FL_ASTRA_BETA || f.env.FL_ASTRA_BETA === '0')) assert.equal(f.beta.astraConfigured(), false)
    Object.assign(f.env, before)
  }
  f.state.cwd = '/virtual/other-app'
  assert.throws(() => f.beta.astraWorkspace(), category('policy'))
  assert.deepEqual(f.effects, [])
})

test('root and each storage directory reject symlinks, files, missing paths and invalid marker', t => {
  const f = fixture(t)
  for (const relative of ['', '/public', '/public/runs', '/data', '/.astra-home']) {
    const dir = `${ROOT}${relative}`
    f.state.links.set(dir, '/private/shared-store')
    assert.throws(() => f.beta.astraWorkspace(), category('policy'), relative)
    f.state.links.clear()
    if (relative) {
      f.state.notDirectories.add(dir)
      assert.throws(() => f.beta.astraWorkspace(), category('policy'), relative)
      f.state.notDirectories.clear()
    }
    f.state.missing.add(dir)
    assert.throws(() => f.beta.astraWorkspace())
    f.state.missing.clear()
  }
  for (const marker of [{ version: 2, root: ROOT, purpose: 'isolated-astra-beta' }, { version: 1, root: '/other', purpose: 'isolated-astra-beta' }, { version: 1, root: ROOT, purpose: 'production' }, 'invalid JSON']) {
    f.state.marker = marker
    assert.throws(() => f.beta.astraWorkspace())
  }
  const markerPath = `${ROOT}/.astra-workspace.json`
  f.state.links.set(markerPath, '/private/marker.json')
  assert.throws(() => f.beta.astraWorkspace(), category('policy'))
  f.state.links.clear()
  f.state.marker = { version: 1, root: ROOT, purpose: 'isolated-astra-beta', padding: 'x'.repeat(1025) }
  assert.throws(() => f.beta.astraWorkspace(), category('policy'))
  assert.deepEqual(f.effects, [])
})

test('authorization requires local signed-in operator without header or saved BYOK', t => {
  const f = fixture(t)
  assert.equal(f.beta.authorizeAstra(f.request()), f.state.owner)
  const normalized = new NextRequest(`${ORIGIN}/api/astra`, {
    headers: { host: new URL(ORIGIN).host, origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(new URL(normalized.url).hostname, 'localhost')
  assert.equal(f.beta.authorizeAstra(normalized), f.state.owner, 'actual authorization accepts normalized NextRequest with exact numeric Host')
  const wrongHost = new NextRequest(`${ORIGIN}/api/astra`, { headers: { host: 'localhost:18765' } })
  assert.throws(() => f.beta.authorizeAstra(wrongHost), category('policy'))
  for (const overrides of [{ owner: null }, { admin: false }, { user: null }, { user: { llmKey: { provider: 'openai', key: 'not-a-real-key' } } }]) {
    const before = { ...f.state }; Object.assign(f.state, overrides)
    assert.throws(() => f.beta.authorizeAstra(f.request()), category('policy'))
    Object.assign(f.state, before)
  }
  for (const headers of [{ origin: 'http://evil.test' }, { 'sec-fetch-site': 'cross-site' }, { 'x-llm-key': '' }, { 'x-llm-provider': 'openai' }, { 'x-fl-model': 'another-model' }]) {
    assert.throws(() => f.beta.authorizeAstra(f.request('/api/astra', { headers })), category('policy'))
  }
  assert.throws(() => f.beta.authorizeAstra(new Request('http://localhost:18765/api/astra')), category('policy'))
  assert.deepEqual(f.effects, [])
})

test('all model selectors are validated, including masked and duplicate query values', t => {
  const f = fixture(t)
  for (const [route, headers] of [
    ['/api/astra?model=other', {}],
    ['/api/astra?model=other', { 'x-fl-model': 'gpt-6-astra' }],
    ['/api/astra?model=gpt-6-astra&model=other', {}],
    ['/api/astra?model=gpt-6-astra', { 'x-fl-model': 'other' }],
  ]) assert.throws(() => f.beta.authorizeAstra(f.request(route, { headers })), category('policy'))
  assert.equal(f.beta.authorizeAstra(f.request('/api/astra?model=gpt-6-astra', { headers: { 'x-fl-model': 'gpt-6-astra' } })), f.state.owner)
})

test('workflow identity rejects another owner, missing ID and conflicting selectors', t => {
  const f = fixture(t)
  const id = f.beta.beginAstraWorkflow(f.request())
  assert.equal(f.beta.astraWorkflow(f.request(`/api/astra?astraWorkflow=${id}`)).execution.id, id)
  for (const req of [
    f.request(), f.request('/api/astra', { workflow: 'wrong' }),
    f.request('/api/astra?astraWorkflow=wrong', { workflow: id }),
    f.request(`/api/astra?astraWorkflow=${id}&astraWorkflow=wrong`),
  ]) assert.throws(() => f.beta.astraWorkflow(req), category('policy'))
  f.state.owner = 'another@example.test'
  assert.throws(() => f.beta.astraWorkflow(f.request('/api/astra', { workflow: id })), category('policy'))
  assert.throws(() => f.beta.cancelAstraWorkflow(f.request('/api/astra', { workflow: id })), category('policy'))
})

test('one workflow owns the total call budget across interview and build phases', async t => {
  const f = fixture(t)
  const id = f.beta.beginAstraWorkflow(f.request())
  const req = f.request('/api/astra', { workflow: id })
  const workflow = f.beta.astraWorkflow(req)
  assert.equal(workflow.execution.maxCalls, 8)
  assert.ok(workflow.execution.deadline - Date.now() <= 20 * 60_000)
  assert.throws(() => f.beta.beginAstraWorkflow(f.request()), category('busy'))
  await assert.rejects(f.beta.inAstraWorkflow(req, 'building', async () => {}), category('busy'))
  await f.beta.inAstraWorkflow(req, 'interview', async active => {
    assert.equal(f.execution.currentAstraExecution(), active.execution)
    for (let i = 0; i < 3; i++) f.execution.claimAstraCall(active.execution)
  })
  assert.equal(workflow.execution.calls, 3)
  workflow.phase = 'ready'
  await assert.rejects(f.beta.inAstraWorkflow(req, 'interview', async () => {}), category('busy'))
  await f.beta.inAstraWorkflow(req, 'building', async active => {
    for (let i = 0; i < 5; i++) f.execution.claimAstraCall(active.execution)
    assert.throws(() => f.execution.claimAstraCall(active.execution), category('budget'))
  })
  assert.equal(workflow.execution.calls, 8)
  assert.equal(workflow.phase, 'finished')
  assert.equal(workflow.busy, false)
  assert.equal(f.execution.currentAstraExecution(), undefined)
  await assert.rejects(f.beta.inAstraWorkflow(req, 'building', async () => {}), category('busy'))
  assert.notEqual(f.beta.beginAstraWorkflow(f.request()), id)
  assert.equal(workflow.execution.signal.aborted, true)
})

test('cancel does not release busy lock until owned cleanup settles', async t => {
  const f = fixture(t)
  const { id, workflow, req } = f.ready()
  const cleanup = deferred()
  const pending = f.beta.inAstraWorkflow(req, 'building', async active => {
    await cleanup.promise
    f.execution.assertAstraActive(active.execution)
  })
  const rejected = assert.rejects(pending, category('cancelled'))
  try {
    assert.equal(workflow.busy, true)
    await assert.rejects(f.beta.inAstraWorkflow(req, 'building', async () => {}), category('busy'))
    const result = f.beta.cancelAstraWorkflow(req)
    assert.equal(result.cancelled, true)
    assert.match(result.detail, /billing may continue/i)
    assert.equal(workflow.execution.signal.aborted, true)
    assert.throws(() => f.beta.beginAstraWorkflow(f.request()), category('busy'))
    assert.throws(() => f.execution.claimAstraCall(workflow.execution), category('cancelled'))
  } finally { cleanup.resolve(); await rejected }
  assert.equal(workflow.busy, false)
  assert.notEqual(f.beta.beginAstraWorkflow(f.request()), id)
})

test('unconfirmed cleanup permanently blocks new workflows and inference even after cancel and operation settlement', async t => {
  const f = fixture(t)
  const id = f.beta.beginAstraWorkflow(f.request())
  const req = f.request('/api/astra', { workflow: id })
  const active = f.beta.astraWorkflow(req)
  await f.beta.inAstraWorkflow(req, 'interview', async workflow => {
    f.beta.blockAstraForUnconfirmedCleanup(workflow.execution)
  })
  assert.equal(active.busy, false)
  assert.equal(active.execution.signal.aborted, true)
  assert.throws(() => f.beta.assertAstraCleanupConfirmed(), category('policy'))
  assert.throws(() => f.beta.beginAstraWorkflow(f.request()), category('policy'))
  assert.throws(() => f.beta.astraWorkflow(req), category('policy'))
  f.beta.cancelAstraWorkflow(req)
  assert.throws(() => f.beta.beginAstraWorkflow(f.request()), category('policy'), 'explicit cancel cannot reset unsafe cleanup latch')
  f.effects.length = 0
  const response = await f.architect().POST(f.request('/api/architect', { method: 'POST', workflow: id, body: f.designRequest }))
  assert.equal(response.status, 403)
  assert.equal(active.execution.calls, 0)
  assert.deepEqual(f.effects, [], 'latch blocks even preflight and inference after busy is released')
  const status = await (await f.api().GET(f.request())).json()
  assert.equal(status.ready, false)
  assert.ok(status.blockers.some(message => /cleanup is unconfirmed/i.test(message)))
  assert.throws(() => f.beta.beginAstraWorkflow(f.request()), category('policy'), 'readiness inspection cannot clear latch')
})

test('ordinary failed workflow with confirmed cleanup remains recoverable without global latch', async t => {
  const f = fixture(t)
  const { id, req } = f.ready()
  await assert.rejects(f.beta.inAstraWorkflow(req, 'building', async () => {
    throw new f.execution.AstraError('process', 'Confirmed-cleanup operation failed')
  }), category('process'))
  assert.doesNotThrow(() => f.beta.assertAstraCleanupConfirmed())
  assert.notEqual(f.beta.beginAstraWorkflow(f.request()), id)
})

test('Astra status and begin are inert when default-disabled or production-configured', async t => {
  const f = fixture(t, { FL_ASTRA_BETA: undefined, FL_ASTRA_ROOT: undefined })
  const route = f.api()
  assert.deepEqual(await (await route.GET(f.request())).json(), { enabled: false })
  assert.equal((await route.POST(f.request('/api/astra', { method: 'POST', body: { action: 'begin' } }))).status, 404)
  assert.deepEqual(f.effects, [])
  Object.assign(f.env, { FL_ASTRA_BETA: '1', FL_ASTRA_ROOT: ROOT, NODE_ENV: 'production' })
  assert.equal((await route.GET(f.request())).status, 403)
  assert.equal((await route.POST(f.request('/api/astra', { method: 'POST', body: { action: 'begin' } }))).status, 403)
  assert.deepEqual(f.effects, [])
})

test('Astra status reports readiness blockers; begin fails preflight before workflow allocation', async t => {
  const f = fixture(t)
  const route = f.api()
  f.state.preflightError = new f.execution.AstraError('policy', 'Missing approved local footprints.')
  const status = await (await route.GET(f.request())).json()
  assert.equal(status.enabled, true)
  assert.equal(status.ready, false)
  assert.ok(status.blockers.some(s => /footprints/.test(s)))
  const response = await route.POST(f.request('/api/astra', { method: 'POST', body: { action: 'begin' } }))
  assert.equal(response.status, 403)
  assert.deepEqual(f.effects.map(e => e[0]), ['nativeConfig', 'preflight', 'nativeConfig', 'preflight'])
  assert.equal(f.beta.beginAstraWorkflow(f.request()), 'workflow-1', 'failed preflight allocated no workflow ID')
})

test('invalid action, malformed/oversized body and failed native config never execute generation', async t => {
  const f = fixture(t)
  const route = f.api()
  for (const [body, status] of [[{ action: 'unknown' }, 400], ['{', 403], [{ action: 'begin', padding: 'x'.repeat(257) }, 403]]) {
    assert.equal((await route.POST(f.request('/api/astra', { method: 'POST', body }))).status, status)
  }
  assert.deepEqual(f.effects, [])
  f.state.nativeError = new f.execution.AstraError('policy')
  assert.equal((await route.POST(f.request('/api/astra', { method: 'POST', body: { action: 'begin' } }))).status, 403)
  assert.deepEqual(f.effects.map(e => e[0]), ['nativeConfig'])
})

test('chunked oversized Astra body is cancelled before preflight without trusting Content-Length', async t => {
  const f = fixture(t)
  let cancelled = 0
  let pulled = 0
  const body = new ReadableStream({
    pull(controller) { pulled++; controller.enqueue(new TextEncoder().encode('x'.repeat(300))) },
    cancel() { cancelled++ },
  })
  const req = new Request(`${ORIGIN}/api/astra`, {
    method: 'POST', body, duplex: 'half',
    headers: { 'content-length': '1', 'sec-fetch-site': 'same-origin' },
  })
  const response = await f.api().POST(req)
  assert.equal(response.status, 403)
  assert.equal(cancelled, 1)
  assert.ok(pulled <= 2, 'body reader stops as soon as the byte budget is crossed')
  assert.deepEqual(f.effects, [])
})

test('oversized body rejects promptly when stream cancellation never settles', { timeout: 1000 }, async t => {
  const f = fixture(t)
  const { readAstraBody } = f.load('lib/astra-body.ts', { './astra-execution': f.execution })
  let cancelled = 0
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(257)) },
    cancel() { cancelled++; return new Promise(() => {}) },
  })
  const req = new Request(`${ORIGIN}/api/astra`, { method: 'POST', body, duplex: 'half' })
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Body rejection waited for stream cancellation')), 250)
  })
  try {
    await assert.rejects(Promise.race([readAstraBody(req, 256), timeout]), error => {
      assert.equal(error.category, 'policy')
      assert.match(error.message, /size limit/)
      return true
    })
  } finally { clearTimeout(timer) }
  assert.equal(cancelled, 1)
  assert.equal(body.locked, false, 'reader lock is released despite pending underlying cancellation')
  assert.deepEqual(f.effects, [])
})

test('Astra cancel route remains available with failed preflight and makes no new CLI call', async t => {
  const f = fixture(t)
  const route = f.api()
  const begin = await route.POST(f.request('/api/astra', { method: 'POST', body: { action: 'begin' } }))
  const { workflowId } = await begin.json()
  f.state.nativeError = new f.execution.AstraError('policy')
  f.state.preflightError = new f.execution.AstraError('policy')
  f.effects.length = 0
  const cancelled = await route.POST(f.request('/api/astra', { method: 'POST', workflow: workflowId, body: { action: 'cancel' } }))
  assert.equal(cancelled.status, 200)
  assert.equal((await cancelled.json()).cancelled, true)
  assert.deepEqual(f.effects, [])
})

test('architect actual POST preflight error precedes inference and spec persistence', async t => {
  const f = fixture(t)
  const id = f.beta.beginAstraWorkflow(f.request())
  const req = f.request('/api/architect', { method: 'POST', workflow: id, body: f.designRequest })
  f.state.preflightError = new f.execution.AstraError('policy')
  const response = await f.architect().POST(req)
  assert.equal(response.status, 403)
  const workflow = f.beta.astraWorkflow(f.request('/api/astra', { workflow: id }))
  assert.equal(workflow.execution.calls, 0)
  assert.equal(workflow.spec, undefined)
  assert.equal(workflow.busy, false)
  assert.deepEqual(f.effects.map(e => e[0]), ['preflight'])
})

test('architect actual POST keeps typed inference failures single-attempt within owned budget', async t => {
  const f = fixture(t)
  const id = f.beta.beginAstraWorkflow(f.request())
  f.state.cliError = new f.execution.AstraError('process')
  const response = await f.architect().POST(f.request('/api/architect', { method: 'POST', workflow: id, body: f.designRequest }))
  assert.equal(response.status, 502)
  assert.deepEqual(f.effects.map(e => e[0]), ['preflight', 'fakeCLI'])
  assert.equal(f.beta.astraWorkflow(f.request('/api/astra', { workflow: id })).execution.calls, 1)
})

test('architect rejects unsupported intent before inference instead of converting it into the template', async t => {
  const f = fixture(t)
  const id = f.beta.beginAstraWorkflow(f.request())
  const route = f.architect()
  for (const body of [
    { request: 'Build a battery-powered motor controller', answers: [] },
    { ...f.designRequest, request: 'Build a battery-powered motor controller' },
    { ...f.designRequest, templateId: 'unreviewed-template' },
    { ...f.designRequest, answers: [{ question: 'Add firmware?', answer: 'yes' }] },
  ]) {
    f.effects.length = 0
    const response = await route.POST(f.request('/api/architect', { method: 'POST', workflow: id, body }))
    assert.equal(response.status, 403)
    const workflow = f.beta.astraWorkflow(f.request('/api/astra', { workflow: id }))
    assert.equal(workflow.execution.calls, 0)
    assert.equal(workflow.spec, undefined)
    assert.equal(workflow.templateId, undefined)
    assert.equal(workflow.phase, 'interview')
    assert.equal(workflow.busy, false)
    assert.deepEqual(f.effects.map(effect => effect[0]), ['preflight'])
  }
})

test('architect rejects invalid raw model contract without normalization, storage or repair inference', async t => {
  for (const mutate of [
    spec => { spec.disciplines.electronics.contract.address = '0x77' },
    spec => { delete spec.disciplines.electronics.contract },
    spec => { delete spec.disciplines.firmware },
    spec => { spec.disciplines.mechanical.status = 'defined' },
  ]) {
    const f = fixture(t)
    const id = f.beta.beginAstraWorkflow(f.request())
    mutate(f.state.cliReply.spec)
    const response = await f.architect().POST(f.request('/api/architect', { method: 'POST', workflow: id, body: f.designRequest }))
    assert.equal(response.status, 403)
    const workflow = f.beta.astraWorkflow(f.request('/api/astra', { workflow: id }))
    assert.equal(workflow.execution.calls, 1, 'invalid raw output never triggers repair inference')
    assert.equal(workflow.spec, undefined)
    assert.equal(workflow.templateId, undefined)
    assert.equal(workflow.phase, 'interview')
    assert.equal(workflow.busy, false)
    assert.deepEqual(f.effects.map(effect => effect[0]), ['preflight', 'fakeCLI'])
    assert.equal(f.files.size, 0)
  }
})

test('pipeline actual GET rejects preflight before run allocation, recordRun or electronics invocation', async t => {
  const f = fixture(t)
  const { id, workflow } = f.ready()
  f.state.preflightError = new f.execution.AstraError('policy')
  const response = await f.pipelineRoute(f.blocked('electronics')).GET(f.request(`/api/pipeline/run?runId=run-preflight&astraWorkflow=${id}`))
  assert.equal(response.status, 403)
  assert.equal(workflow.phase, 'ready')
  assert.equal(workflow.runId, undefined)
  assert.equal(workflow.execution.calls, 0)
  assert.equal(f.files.size, 0)
  assert.equal(f.directories.size, 0)
  assert.deepEqual(f.effects.map(e => e[0]), ['preflight'])
})

test('pipeline rejects missing spec, reused run, traversal and wrong phase before preflight', async t => {
  const f = fixture(t)
  const { id, workflow } = f.ready()
  const route = f.pipelineRoute(f.blocked('electronics'))
  for (const [runId, overrides] of [
    ['run-valid', { spec: undefined }], ['run-valid', { runId: 'run-used' }],
    ['run-valid', { phase: 'interview' }], ['../../private', {}], ['', {}], ['not-run', {}],
  ]) {
    const before = { ...workflow }; Object.assign(workflow, overrides)
    assert.equal((await route.GET(f.request(`/api/pipeline/run?runId=${encodeURIComponent(runId)}&astraWorkflow=${id}`))).status, 403)
    Object.assign(workflow, before)
  }
  assert.deepEqual(f.effects, [])
})

test('actual architect and pipeline exports share workflow and publish only persisted electronics evidence', async t => {
  const f = fixture(t)
  const id = f.beta.beginAstraWorkflow(f.request())
  const architect = await f.architect().POST(f.request('/api/architect', { method: 'POST', workflow: id, body: f.designRequest }))
  assert.equal(architect.status, 200)
  assert.equal((await architect.json()).type, 'spec')
  const workflow = f.beta.astraWorkflow(f.request('/api/astra', { workflow: id }))
  assert.equal(workflow.phase, 'ready')
  assert.equal(workflow.execution.calls, 1)
  let builds = 0
  const electronics = async req => {
    builds++
    assert.equal(new URL(req.url).origin, ORIGIN)
    assert.equal(req.headers.get('x-fl-astra-workflow'), id)
    assert.equal(req.headers.get('cookie'), 'fake-session')
    assert.equal(req.headers.get('x-llm-provider'), null)
    assert.equal(f.execution.currentAstraExecution(), workflow.execution)
    assert.equal(workflow.busy, true)
    assert.equal(workflow.phase, 'building')
    const body = await req.json()
    assert.equal(body.runId, 'run-success')
    assert.deepEqual(body.spec, json(workflow.spec))
    f.execution.claimAstraCall(workflow.execution)
    f.saveManifest('run-success')
    return Response.json({ ok: true })
  }
  const response = await f.pipelineRoute(electronics).GET(f.request(`/api/pipeline/run?runId=run-success&astraWorkflow=${id}`))
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const events = (await response.text()).trim().split('\n\n').map(line => JSON.parse(line.slice(6)))
  assert.ok(events.some(e => e.type === 'done' && e.status === 'PASSED' && e.scope === 'electronics-only'))
  const timing = JSON.parse(f.files.get(`${ROOT}/public/runs/run-success/timing.json`))
  assert.equal(timing.stages[0].status, 'passed')
  assert.deepEqual(timing.stages.slice(1).map(stage => [stage.stage, stage.status]), json(f.beta.ASTRA_NOT_RUN.map(stage => [stage, 'skipped'])))
  assert.equal(builds, 1)
  assert.equal(workflow.execution.calls, 2)
  assert.equal(workflow.phase, 'finished')
  assert.equal(workflow.busy, false)
  assert.deepEqual(f.effects.filter(e => e[0] === 'recordRun'), [['recordRun', f.state.owner, 'run-success']])
})

test('pipeline cancellation retains busy ownership until electronics settles and cannot publish success', async t => {
  const f = fixture(t)
  const { id, workflow, req } = f.ready()
  const entered = deferred(), cleanup = deferred()
  const route = f.pipelineRoute(async () => {
    entered.resolve()
    await cleanup.promise
    return Response.json({ ok: true })
  })
  const response = await route.GET(f.request(`/api/pipeline/run?runId=run-cancel&astraWorkflow=${id}`))
  const output = response.text()
  await entered.promise
  try {
    f.beta.cancelAstraWorkflow(req)
    assert.equal(workflow.busy, true)
    assert.throws(() => f.beta.beginAstraWorkflow(f.request()), category('busy'))
  } finally { cleanup.resolve() }
  const events = await output
  assert.match(events, /"type":"error"/)
  assert.doesNotMatch(events, /"type":"done"|"state":"passed"/)
  assert.equal(workflow.busy, false)
  assert.equal(JSON.parse(f.files.get(`${ROOT}/public/runs/run-cancel/timing.json`)).stages[0].status, 'failed')
  assert.notEqual(f.beta.beginAstraWorkflow(f.request()), id)
})

test('disconnecting pipeline observation does not cancel owned work or allow a second workflow', async t => {
  const f = fixture(t)
  const { id, workflow } = f.ready()
  const entered = deferred(), cleanup = deferred(), settled = deferred()
  const originalInWorkflow = f.beta.inAstraWorkflow
  f.beta.inAstraWorkflow = async (...args) => {
    try { return await originalInWorkflow(...args) } finally { settled.resolve() }
  }
  const route = f.pipelineRoute(async () => {
    entered.resolve()
    await cleanup.promise
    f.saveManifest('run-observe')
    return Response.json({ ok: true })
  })
  const response = await route.GET(f.request(`/api/pipeline/run?runId=run-observe&astraWorkflow=${id}`))
  await entered.promise
  try {
    await response.body.cancel()
    assert.equal(workflow.execution.signal.aborted, false)
    assert.equal(workflow.busy, true)
    assert.throws(() => f.beta.beginAstraWorkflow(f.request()), category('busy'))
  } finally { cleanup.resolve() }
  await settled.promise
  assert.equal(workflow.phase, 'finished')
  assert.equal(workflow.busy, false)
  assert.equal(JSON.parse(f.files.get(`${ROOT}/public/runs/run-observe/timing.json`)).stages[0].status, 'passed')
})

test('clean-looking response without persisted DRC and routing evidence never passes', async t => {
  const f = fixture(t)
  const { id } = f.ready()
  const route = f.pipelineRoute(async () => {
    f.files.set(`${ROOT}/public/runs/run-unverified/electronics/chipscale-board.json`, JSON.stringify({ ok: true }))
    return Response.json({ ok: true, status: 'PASSED' })
  })
  const response = await route.GET(f.request(`/api/pipeline/run?runId=run-unverified&astraWorkflow=${id}`))
  const events = await response.text()
  assert.match(events, /"type":"error"/)
  assert.doesNotMatch(events, /"status":"PASSED"|"type":"done"/)
})

test('strict persisted manifest rejects claimed pass with incomplete native evidence', async t => {
  for (const overrides of [
    { artifacts: [] }, { routeAttempts: 0 }, { native: false },
    { checks: { drcAvailable: false, drcErrors: null, unrouted: null, identityPreserved: true, exportsComplete: true } },
  ]) {
    const f = fixture(t)
    const { id } = f.ready()
    const route = f.pipelineRoute(async () => {
      f.saveManifest('run-invalid-manifest', overrides)
      return Response.json({ ok: true, status: 'PASSED' })
    })
    const response = await route.GET(f.request(`/api/pipeline/run?runId=run-invalid-manifest&astraWorkflow=${id}`))
    const events = await response.text()
    assert.match(events, /"type":"error"/)
    assert.doesNotMatch(events, /"status":"PASSED"|"type":"done"/)
    assert.equal(JSON.parse(f.files.get(`${ROOT}/public/runs/run-invalid-manifest/timing.json`)).stages[0].status, 'failed')
  }
})

test('strict nonpassing manifest publishes failed gate despite successful electronics response', async t => {
  const f = fixture(t)
  const { id } = f.ready()
  const route = f.pipelineRoute(async () => {
    f.saveManifest('run-failed-manifest', {
      status: 'failed', artifacts: [],
      checks: { drcAvailable: true, drcErrors: 2, unrouted: 1, identityPreserved: true, exportsComplete: false },
    })
    return Response.json({ ok: true, status: 'PASSED' })
  })
  const response = await route.GET(f.request(`/api/pipeline/run?runId=run-failed-manifest&astraWorkflow=${id}`))
  const events = await response.text()
  assert.match(events, /"status":"GATE FAILED"/)
  assert.doesNotMatch(events, /"status":"PASSED"/)
})

test('exclusive run allocation never overwrites existing artifacts or calls electronics', async t => {
  const f = fixture(t)
  const { id } = f.ready()
  const runRoot = `${ROOT}/public/runs/run-existing`
  f.directories.add(runRoot)
  f.files.set(`${runRoot}/keep.json`, 'original')
  const response = await f.pipelineRoute(f.blocked('electronics')).GET(f.request(`/api/pipeline/run?runId=run-existing&astraWorkflow=${id}`))
  const text = await response.text()
  assert.match(text, /"type":"error"/)
  assert.doesNotMatch(text, /"type":"done"/)
  assert.equal(f.files.get(`${runRoot}/keep.json`), 'original')
  assert.deepEqual(f.effects.map(e => e[0]), ['preflight', 'mkdir'])
})

test('stale beta header and query cannot reach alternate providers with default disabled', async t => {
  const f = fixture(t, { FL_ASTRA_ROOT: undefined, FL_ASTRA_BETA: undefined })
  const architect = f.architect()
  const pipeline = f.pipelineRoute(f.blocked('electronics'))
  for (const selector of ['header', 'query']) {
    const suffix = selector === 'query' ? '?astraWorkflow=stale' : ''
    const headers = selector === 'header' ? { 'x-fl-astra-workflow': 'stale' } : {}
    const response = await architect.POST(f.request(`/api/architect${suffix}`, { method: 'POST', headers, body: f.designRequest }))
    assert.equal(response.status, 409, `architect ${selector}`)
    const run = await pipeline.GET(f.request(`/api/pipeline/run${suffix}`, { headers }))
    assert.equal(run.status, 409, `pipeline ${selector}`)
  }
  assert.deepEqual(f.effects, [], 'no provider, native probe, legacy auth or allocation')
})

test('legacy interview actual POST rejects stale beta header and query with default disabled', async t => {
  const f = fixture(t, { FL_ASTRA_ROOT: undefined, FL_ASTRA_BETA: undefined })
  const { POST } = f.load('app/api/interview/route.ts', {
    '@/lib/llm': { callLLMText: f.blocked('alternate provider') },
    '@/lib/byok': { overrideForRequest: f.blocked('legacy BYOK') },
    '@/lib/spend-gate': { assertCanSpend: f.blocked('legacy spend gate') },
    '@/lib/model-tiers': { MODEL: { design: 'unused-default' } },
    '@/lib/block-capabilities.json': { blocks: [] },
    '@/lib/keepalive': { withKeepalive: f.blocked('legacy keepalive') },
  })
  for (const selector of ['header', 'query']) {
    const suffix = selector === 'query' ? '?astraWorkflow=stale' : ''
    const headers = selector === 'header' ? { 'x-fl-astra-workflow': 'stale' } : {}
    const response = await POST(f.request(`/api/interview${suffix}`, {
      method: 'POST', headers, body: f.designRequest,
    }))
    assert.equal(response.status, 409, selector)
    assert.match((await response.json()).error, /legacy board interview is not supported/)
  }
  assert.deepEqual(f.effects, [], 'stale beta intent never enters legacy execution')
})

test('unknown errors return sanitized policy responses without leaking filesystem details', async t => {
  const f = fixture(t)
  const response = f.beta.astraErrorResponse(new Error('/private/users.json secret-token'))
  assert.equal(response.status, 403)
  const text = await response.text()
  assert.doesNotMatch(text, /private|secret-token/)
  for (const [name, status] of [['busy', 409], ['timeout', 504], ['policy', 403], ['process', 502], ['budget', 502], ['cancelled', 502]]) {
    assert.equal(f.beta.astraErrorResponse(new f.execution.AstraError(name)).status, status)
  }
})
