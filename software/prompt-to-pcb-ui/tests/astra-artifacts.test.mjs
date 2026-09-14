import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { constants, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

// Explicit VM dependencies prevent loading real auth, runlinks, providers or native tools.
// Real filesystem cases create and clean up only their own external mkdtemp directory.
const source = readFileSync(new URL('../lib/astra-artifacts.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText
const RUN = 'run-owned-fixture'
const ROOT = '/virtual/astra-artifacts'
const sha256 = value => createHash('sha256').update(value).digest('hex')
const category = name => error => error?.category === name
const blocked = name => () => { throw new Error(`Unexpected side effect: ${name}`) }

class AstraError extends Error {
  constructor(category, message) {
    super(message)
    this.category = category
  }
}

function fixture({ io, root = ROOT } = {}) {
  const calls = []
  const state = { access: 'owner', authorizationError: null }
  const dependencies = {
    'node:fs/promises': io || new Proxy({}, { get: (_, name) => name === '__esModule' ? false : blocked(`fs.${String(name)}`) }),
    'node:fs': { constants },
    'node:path': path,
    'node:crypto': { createHash },
    './auth': {
      isValidRunId: id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id),
      runAccess: (req, id) => { calls.push(['access', req, id]); return { access: state.access } },
    },
    './astra-beta': {
      authorizeAstra: req => {
        calls.push(['authorize', req])
        if (state.authorizationError) throw state.authorizationError
      },
      astraWorkspace: () => { calls.push(['workspace']); return { root } },
    },
    './astra-execution': { AstraError },
  }
  const context = vm.createContext({ Buffer, Error, fetch: blocked('network') })
  const loaded = { exports: {} }
  const safeRequire = name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unmocked dependency: ${name}`)
    return dependencies[name]
  }
  vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename: 'lib/astra-artifacts.ts' })(safeRequire, loaded, loaded.exports)
  return { api: loaded.exports, calls, state }
}

function manifest(api, overrides = {}) {
  return {
    version: 1, runId: RUN, scope: 'electronics-only', status: 'passed', native: true,
    routeAttempts: 1, createdAt: '2026-09-13T12:00:00.000Z', proposalSha256: sha256('proposal'),
    tools: { kicad: '9.0.0', router: 'fixture-version' },
    checks: { drcAvailable: true, drcErrors: 0, unrouted: 0, identityPreserved: true, exportsComplete: true },
    artifacts: Object.keys(api.ASTRA_OUTPUTS).map(name => ({ path: name, bytes: 1, sha256: sha256('x') })),
    ...overrides,
  }
}

function partial(api, overrides = {}) {
  return manifest(api, {
    status: 'failed', routeAttempts: 0,
    checks: { drcAvailable: false, drcErrors: null, unrouted: null, identityPreserved: false, exportsComplete: false },
    artifacts: [], ...overrides,
  })
}

async function diskFixture(t) {
  const owned = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'astra-artifacts-test-')))
  t.after(() => fs.rm(owned, { recursive: true, force: true }))
  const root = path.join(owned, 'workspace')
  const run = path.join(root, 'public/runs', RUN)
  await fs.mkdir(path.join(run, 'electronics'), { recursive: true })
  await fs.mkdir(path.join(run, 'board'))
  const io = Object.fromEntries(['lstat', 'realpath', 'open'].map(name => [name, (file, ...args) => {
    assert.ok(file.startsWith(`${owned}${path.sep}`), `filesystem access must stay in owned scratch: ${file}`)
    return fs[name](file, ...args)
  }]))
  return { ...fixture({ io, root }), owned, root, run }
}

function memoryIo({ size = 4, content = Buffer.from('data'), chunk = Infinity, change, readError } = {}) {
  const calls = []
  const visits = new Map()
  const directory = { dev: 1, ino: 1, isDirectory: () => true, isSymbolicLink: () => false }
  const leaf = { dev: 1, ino: 2, size, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
  const io = {
    realpath: async file => { calls.push(['realpath', file]); return file },
    lstat: async file => {
      const visit = (visits.get(file) || 0) + 1
      visits.set(file, visit)
      calls.push(['lstat', file, visit])
      const stat = file.endsWith('.json') ? leaf : directory
      return { ...stat, ...change?.(file, visit) }
    },
    open: async (file, flags) => {
      calls.push(['open', file, flags])
      return {
        stat: async () => leaf,
        read: async (buffer, offset, length, position) => {
          calls.push(['read', buffer.length, offset, length, position])
          if (readError) throw readError
          const bytesRead = Math.max(0, Math.min(length, chunk, content.length - position))
          content.copy(buffer, offset, position, position + bytesRead)
          return { bytesRead, buffer }
        },
        close: async () => { calls.push(['close']) },
      }
    },
  }
  return { io, calls, leaf }
}

test('strict native manifest accepts complete evidence and every exact output size bound', () => {
  const { api } = fixture()
  const valid = manifest(api)
  assert.equal(api.parseAstraManifest(valid, RUN), valid)
  assert.equal(Object.isFrozen(api.ASTRA_OUTPUTS), true)
  assert.equal(Object.keys(api.ASTRA_OUTPUTS).length, 11)
  for (const artifact of valid.artifacts) artifact.bytes = api.ASTRA_OUTPUTS[artifact.path]
  assert.equal(api.parseAstraManifest(valid, RUN), valid)
})

test('partial failed, cancelled and unknown manifests preserve missing evidence as explicit null', () => {
  const { api } = fixture()
  for (const status of ['failed', 'cancelled', 'unknown']) {
    for (const artifacts of [[], [manifest(api).artifacts[0]]]) {
      const value = partial(api, { status, artifacts })
      assert.equal(api.parseAstraManifest(value, RUN), value)
      assert.equal(value.checks.drcErrors, null)
      assert.equal(value.checks.unrouted, null)
    }
  }
})

test('manifest rejects absent, coerced or malformed top-level evidence', () => {
  const { api } = fixture()
  for (const value of [null, [], '', 0, true]) assert.throws(() => api.parseAstraManifest(value, RUN), category('output'))
  for (const key of Object.keys(manifest(api))) {
    const value = manifest(api)
    delete value[key]
    assert.throws(() => api.parseAstraManifest(value, RUN), category('output'), `missing ${key}`)
  }
  const bad = {
    version: [0, '1', null], runId: ['run-other', null], scope: ['full-pipeline', null], native: [false, 'true', 1],
    status: ['complete', '', null, ['passed'], ['failed'], { toString: () => 'passed' }],
    routeAttempts: [-1, 2, 0.5, '1', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1],
    createdAt: [0, null, '', 'not a date'], proposalSha256: [null, 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)],
    tools: [null, [], 'kicad', { kicad: 9 }, { kicad: 'x'.repeat(257) }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`tool${i}`, 'v1']))],
    checks: [null, [], 'passed'], artifacts: [null, {}, 'artifacts'],
  }
  for (const [key, values] of Object.entries(bad)) {
    for (const value of values) {
      assert.throws(() => api.parseAstraManifest(manifest(api, { [key]: value }), RUN), category('output'), `invalid ${key}: ${String(value)}`)
    }
  }
})

test('no missing check, null count or failed check can be turned into passing zero evidence', () => {
  const { api } = fixture()
  for (const key of Object.keys(manifest(api).checks)) {
    const value = manifest(api)
    delete value.checks[key]
    assert.throws(() => api.parseAstraManifest(value, RUN), category('output'), `missing ${key}`)
    const incomplete = partial(api)
    delete incomplete.checks[key]
    assert.throws(() => api.parseAstraManifest(incomplete, RUN), category('output'), `partial missing ${key}`)
  }
  for (const key of ['drcErrors', 'unrouted']) {
    for (const number of [null, 1, -1, 0.5, false, '', '0', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const value = manifest(api)
      value.checks[key] = number
      assert.throws(() => api.parseAstraManifest(value, RUN), category('output'), `${key}: ${String(number)}`)
    }
  }
  for (const key of ['drcAvailable', 'identityPreserved', 'exportsComplete']) {
    for (const boolean of [false, null, 0, 1, 'true']) {
      const value = manifest(api)
      value.checks[key] = boolean
      assert.throws(() => api.parseAstraManifest(value, RUN), category('output'), `${key}: ${String(boolean)}`)
    }
  }
  assert.throws(() => api.parseAstraManifest(manifest(api, { routeAttempts: 0 }), RUN), category('output'))
})

test('passed and exportsComplete require every output, not merely one convincing artifact', () => {
  const { api } = fixture()
  for (const output of Object.keys(api.ASTRA_OUTPUTS)) {
    const value = manifest(api)
    value.artifacts = value.artifacts.filter(item => item.path !== output)
    assert.throws(() => api.parseAstraManifest(value, RUN), category('output'), `missing ${output}`)
    value.status = 'failed'
    assert.throws(() => api.parseAstraManifest(value, RUN), category('output'), `false exportsComplete without ${output}`)
    value.checks.exportsComplete = false
    assert.equal(api.parseAstraManifest(value, RUN), value)
  }
})

test('artifact entries enforce exact paths, uniqueness, positive bounded byte counts and lowercase hashes', () => {
  const { api } = fixture()
  const entry = manifest(api).artifacts[0]
  const invalidPaths = ['../secret', '/electronics/chipscale-board.json', 'electronics/../electronics/chipscale-board.json', 'electronics//chipscale-board.json', 'electronics\\chipscale-board.json', '%2e%2e/secret', 'electronics/chipscale-board.json\0', 'astra-manifest.json', '__proto__', 'toString', '', null, [entry.path]]
  const invalidEntries = [null, [], {}, ...invalidPaths.map(name => ({ ...entry, path: name }))]
  for (const key of ['path', 'bytes', 'sha256']) {
    const missing = { ...entry }
    delete missing[key]
    invalidEntries.push(missing)
  }
  for (const bytes of [0, -1, 1.5, '1', false, null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) invalidEntries.push({ ...entry, bytes })
  for (const hash of [null, '', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), ['a'.repeat(64)]]) invalidEntries.push({ ...entry, sha256: hash })
  for (const [name, max] of Object.entries(api.ASTRA_OUTPUTS)) invalidEntries.push({ ...entry, path: name, bytes: max + 1 })
  for (const artifact of invalidEntries) {
    assert.throws(() => api.parseAstraManifest(partial(api, { artifacts: [artifact] }), RUN), category('output'))
  }
  assert.throws(() => api.parseAstraManifest(partial(api, { artifacts: [entry, entry] }), RUN), category('output'))
  assert.throws(() => api.parseAstraManifest(partial(api, { artifacts: Array(12).fill(entry) }), RUN), category('output'))
})

test('owner authorization runs beta policy first, rejects all other access, then resolves workspace', () => {
  const { api, calls, state } = fixture()
  const request = { marker: 'request identity' }
  assert.equal(api.authorizeAstraRun(request, RUN), ROOT)
  assert.deepEqual(calls, [['authorize', request], ['access', request, RUN], ['workspace']])
  for (const access of ['public', 'shared', 'viewer', 'admin', 'denied', 'none', undefined, null]) {
    calls.length = 0
    state.access = access
    assert.throws(() => api.authorizeAstraRun(request, RUN), category('policy'))
    assert.deepEqual(calls, [['authorize', request], ['access', request, RUN]])
  }
  state.access = 'owner'
  for (const id of ['legacy-run', '../run-owned', 'run-../secret', '/run-owned', '', null]) {
    calls.length = 0
    assert.throws(() => api.authorizeAstraRun(request, id), category('policy'))
    assert.deepEqual(calls, [['authorize', request]])
  }
  calls.length = 0
  state.authorizationError = new AstraError('policy', 'Beta disabled')
  assert.throws(() => api.authorizeAstraRun(request, RUN), error => error === state.authorizationError)
  assert.deepEqual(calls, [['authorize', request]])
})

test('published file authorization blocks filesystem reads even for metadata', async () => {
  const { api, state, calls } = fixture()
  state.access = 'public'
  for (const name of [api.ASTRA_MANIFEST, 'product-spec.json', 'electronics/netlist.json']) {
    await assert.rejects(api.publishedAstraFile({}, RUN, name), category('policy'))
  }
  assert.equal(calls.some(([name]) => name === 'workspace'), false)
})

test('real canonical owned files read successfully and path/run aliases reject before filesystem access', async t => {
  const { api, root, run } = await diskFixture(t)
  const payload = Buffer.from('owned artifact')
  await fs.writeFile(path.join(run, 'electronics/netlist.json'), payload)
  assert.deepEqual(await api.readAstraFile(root, RUN, 'electronics/netlist.json'), payload)
  const pure = fixture().api
  for (const relative of ['../secret', '/etc/passwd', 'electronics/../netlist.json', 'electronics\\netlist.json', 'electronics//netlist.json', 'unknown.json', '__proto__']) {
    await assert.rejects(pure.readAstraFile(root, RUN, relative), category('policy'))
  }
  for (const id of ['not-a-run', '../run-owned', 'run-other/child', '', null]) {
    await assert.rejects(pure.readAstraFile(root, id, 'electronics/netlist.json'), category('policy'))
  }
})

for (const level of ['root', 'public', 'runs', 'run', 'descendant', 'leaf']) {
  test(`real ${level} symlink is rejected even when its target stays inside owned scratch`, async t => {
    const { api, owned, root, run } = await diskFixture(t)
    const relative = 'electronics/netlist.json'
    await fs.writeFile(path.join(run, relative), 'private target fixture')
    const candidates = { root, public: path.join(root, 'public'), runs: path.join(root, 'public/runs'), run, descendant: path.join(run, 'electronics'), leaf: path.join(run, relative) }
    const source = candidates[level]
    const target = path.join(owned, `moved-${level}`)
    await fs.rename(source, target)
    await fs.symlink(target, source, level === 'leaf' ? 'file' : 'dir')
    await assert.rejects(api.readAstraFile(root, RUN, relative), error => level === 'leaf' ? error.code === 'ELOOP' || category('policy')(error) : category('policy')(error))
  })
}

test('real missing, empty and oversized files reject without inventing output', async t => {
  const { api, root, run } = await diskFixture(t)
  const name = 'electronics/netlist.json'
  const file = path.join(run, name)
  await assert.rejects(api.readAstraFile(root, RUN, name), { code: 'ENOENT' })
  await fs.writeFile(file, '')
  await assert.rejects(api.readAstraFile(root, RUN, name), category('output'))
  await fs.truncate(file, api.ASTRA_OUTPUTS[name] + 1)
  await assert.rejects(api.readAstraFile(root, RUN, name), category('output'))
  await fs.writeFile(file, Buffer.alloc(api.ASTRA_OUTPUTS[name], 120))
  assert.equal((await api.readAstraFile(root, RUN, name)).length, api.ASTRA_OUTPUTS[name])
})

test('every output and metadata cap is checked before any bounded read, and handles close on rejection', async () => {
  const definitions = fixture().api
  const limits = { ...definitions.ASTRA_OUTPUTS, [definitions.ASTRA_MANIFEST]: 64 * 1024, 'astra-policy.json': 256 * 1024, 'product-spec.json': 256 * 1024, 'timing.json': 256 * 1024 }
  for (const [name, cap] of Object.entries(limits)) {
    const { io, calls } = memoryIo({ size: cap + 1 })
    const { api } = fixture({ io })
    await assert.rejects(api.readAstraFile(ROOT, RUN, name), category('output'), name)
    assert.equal(calls.some(([name]) => name === 'read'), false)
    assert.equal(calls.filter(([name]) => name === 'close').length, 1)
  }
  const { io, calls, leaf } = memoryIo()
  leaf.isFile = () => false
  await assert.rejects(fixture({ io }).api.readAstraFile(ROOT, RUN, 'electronics/netlist.json'), category('output'))
  assert.equal(calls.some(([name]) => name === 'read'), false)
  assert.equal(calls.filter(([name]) => name === 'close').length, 1)
})

test('bounded reads handle short chunks and one-byte growth detection without readFile or unbounded buffers', async () => {
  const { io, calls } = memoryIo({ chunk: 2 })
  const { api } = fixture({ io })
  assert.equal((await api.readAstraFile(ROOT, RUN, 'electronics/netlist.json')).toString(), 'data')
  const reads = calls.filter(([name]) => name === 'read')
  assert.deepEqual(reads, [['read', 5, 0, 5, 0], ['read', 5, 2, 3, 2], ['read', 5, 4, 1, 4]])
  assert.equal(calls.find(([name]) => name === 'open')[2], constants.O_RDONLY | constants.O_NOFOLLOW)
  assert.equal(calls.filter(([name]) => name === 'close').length, 1)
  for (const content of [Buffer.from('dat'), Buffer.from('data grew well beyond the stat snapshot')]) {
    const changed = memoryIo({ content })
    await assert.rejects(fixture({ io: changed.io }).api.readAstraFile(ROOT, RUN, 'electronics/netlist.json'), category('output'))
    assert.ok(changed.calls.filter(([name]) => name === 'read').every(([, allocated, offset, length]) => allocated === 5 && offset + length <= 5))
    assert.equal(changed.calls.filter(([name]) => name === 'close').length, 1)
  }
  const readError = new Error('owned fake read failed')
  const broken = memoryIo({ readError })
  await assert.rejects(fixture({ io: broken.io }).api.readAstraFile(ROOT, RUN, 'electronics/netlist.json'), error => error === readError)
  assert.equal(broken.calls.filter(([name]) => name === 'close').length, 1)
})

test('directory and leaf replacement checks run before and after reading and always close handles', async () => {
  const file = path.join(ROOT, 'public/runs', RUN, 'electronics/netlist.json')
  const directories = [ROOT, path.join(ROOT, 'public'), path.join(ROOT, 'public/runs'), path.join(ROOT, 'public/runs', RUN), path.join(ROOT, 'public/runs', RUN, 'electronics')]
  for (const target of [...directories, file]) {
    for (const phase of ['before', 'after']) {
      for (const replacement of [{ ino: 999 }, { dev: 999 }, { isSymbolicLink: () => true }]) {
        const visit = target === file ? (phase === 'before' ? 1 : 2) : (phase === 'before' ? 2 : 3)
        const value = memoryIo({ change: (name, n) => name === target && n === visit ? replacement : undefined })
        await assert.rejects(fixture({ io: value.io }).api.readAstraFile(ROOT, RUN, 'electronics/netlist.json'), category('policy'), `${target} ${phase}`)
        assert.equal(value.calls.some(([name]) => name === 'read'), phase === 'after')
        assert.equal(value.calls.filter(([name]) => name === 'close').length, 1)
      }
    }
  }
})

test('published partial artifacts require matching byte length and SHA-256; metadata needs no manifest', async t => {
  const { api, root, run } = await diskFixture(t)
  const req = { marker: 'owner' }
  await fs.writeFile(path.join(run, 'timing.json'), '{"elapsed":1}')
  assert.equal((await api.publishedAstraFile(req, RUN, 'timing.json')).toString(), '{"elapsed":1}')
  const relative = 'electronics/netlist.json'
  const content = Buffer.from('{"nets":[]}')
  const value = partial(api, { artifacts: [{ path: relative, bytes: content.length, sha256: sha256(content) }] })
  const writeManifest = () => fs.writeFile(path.join(run, api.ASTRA_MANIFEST), JSON.stringify(value))
  await fs.writeFile(path.join(run, relative), content)
  await writeManifest()
  assert.deepEqual(await api.publishedAstraFile(req, RUN, relative), content)
  const parsed = await api.readAstraManifest(root, RUN)
  assert.equal(parsed.checks.drcErrors, null)
  assert.equal(parsed.status, 'failed')
  await fs.writeFile(path.join(run, 'electronics/drc.json'), '{}')
  await assert.rejects(api.publishedAstraFile(req, RUN, 'electronics/drc.json'), category('policy'))
  await assert.rejects(api.publishedAstraFile(req, RUN, '../secret'), category('policy'))
  await fs.writeFile(path.join(run, relative), Buffer.alloc(content.length, 120))
  await assert.rejects(api.publishedAstraFile(req, RUN, relative), category('output'))
  await fs.writeFile(path.join(run, relative), content)
  value.artifacts[0].bytes += 1
  await writeManifest()
  await assert.rejects(api.publishedAstraFile(req, RUN, relative), category('output'))
  value.artifacts = []
  await writeManifest()
  await assert.rejects(api.publishedAstraFile(req, RUN, relative), category('policy'))
})

test('invalid manifest JSON, missing check evidence and forged passed manifests never publish artifacts', async t => {
  const { api, root, run } = await diskFixture(t)
  const relative = 'electronics/netlist.json'
  await fs.writeFile(path.join(run, relative), '{}')
  const incomplete = partial(api, { status: 'passed' })
  const missing = partial(api)
  delete missing.checks.drcErrors
  for (const content of ['{', 'null', JSON.stringify(incomplete), JSON.stringify(missing)]) {
    await fs.writeFile(path.join(run, api.ASTRA_MANIFEST), content)
    await assert.rejects(api.readAstraManifest(root, RUN))
    await assert.rejects(api.publishedAstraFile({}, RUN, relative))
  }
})
