import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { createAstraExecution, withAstraExecution, AstraError, assertAstraActive } from '../lib/astra-execution.ts'

const source = fs.readFileSync(new URL('../lib/astra-pipeline.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText

const designSource = ts.transpileModule(fs.readFileSync(new URL('../lib/astra-design-contract.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const designModule = { exports: {} }
new Function('exports', designSource)(designModule.exports)
const design = designModule.exports
const template = design.ASTRA_DESIGN_TEMPLATE
const validSpec = {
  product: 'BME280 test breakout', description: 'External 3.3V I2C sensor board', budgets: {},
  disciplines: {
    electronics: {
      status: 'defined', summary: 'BME280 electronics', boardIntent: 'External host breakout',
      maxBoardMm: { x: 24, y: 18 }, layers: 2, contract: structuredClone(template.electricalContract),
    },
    ...Object.fromEntries(['mechanical', 'firmware', 'manufacturing', 'supplyChain', 'validation'].map(name => [name, { status: 'not_applicable', summary: 'Not run', requirements: [] }])),
  },
}

// Real pipeline orchestration, fake storage, fake native preflight and no inference/network.
function fixture(t, fault) {
  const execution = createAstraExecution({ id: 'workflow', owner: 'test-owner', maxCalls: 2, timeoutMs: 5000 })
  t.after(() => execution.cancel())
  const workflow = { execution, busy: false, phase: 'ready', templateId: template.id, spec: structuredClone(validSpec) }
  const writes = []
  const records = []
  const files = new Map()
  const removed = []
  const root = '/mock-owned-astra-root'
  const manifestPath = `${root}/public/runs/run-fake/astra-manifest.json`
  const nativeManifest = {
    version: 1, runId: 'run-fake', scope: 'electronics-only', status: 'passed', native: true,
    routeAttempts: 1, createdAt: '2026-09-13T00:00:00Z', proposalSha256: 'a'.repeat(64), tools: {},
    checks: { drcAvailable: true, drcErrors: 0, unrouted: 0, identityPreserved: true, exportsComplete: true },
    artifacts: [{ path: 'electronics/chipscale.kicad_pcb', bytes: 4, sha256: 'b'.repeat(64) }],
  }
  let electronicsCalls = 0
  const filesystem = {
    async mkdir() {
      if (fault === 'existing') throw new Error('private raw EEXIST detail')
      if (fault === 'mkdir') execution.cancel()
    },
    async writeFile(file, text) {
      const name = path.basename(file)
      const value = JSON.parse(text)
      if (fault === 'policy-failure' && name === 'astra-policy.json') throw new Error('private raw disk error')
      if (fault === 'all-writes-fail') throw new Error('private raw storage error')
      writes.push({ name, value })
      files.set(file, text)
      if (fault === name || (fault === 'success-timing' && name === 'timing.json' && value.stages[0].status === 'passed') ||
        (fault === 'success-policy' && name === 'astra-policy.json' && value.status === 'passed')) execution.cancel()
    },
    async rename(from, to) {
      if (fault === 'rename-failure') throw Object.assign(new Error('mock rename ENOENT'), { code: 'ENOENT' })
      assert.ok(files.has(from))
      files.set(to, files.get(from))
      files.delete(from)
    },
    async rm(file) { removed.push(file); files.delete(file) },
  }
  const deps = {
    'node:fs/promises': filesystem,
    'node:path': path,
    './auth': { recordRun: (...args) => records.push(args), isValidRunId: () => true },
    './astra-beta': {
      ASTRA_NOT_RUN: ['mechanical', 'firmware'], ASTRA_SCOPE: 'electronics-only',
      astraWorkflow: () => workflow,
      astraWorkspace: () => ({ root: '/mock-owned-astra-root', origin: 'http://127.0.0.1:3000' }),
      astraErrorResponse: () => { throw new Error('unexpected outer failure') },
      inAstraWorkflow: async (_req, _phase, operation) => {
        workflow.phase = 'building'
        workflow.busy = true
        try { return await withAstraExecution(execution, () => operation(workflow)) }
        finally { workflow.busy = false; workflow.phase = 'finished' }
      },
    },
    './astra-execution': { AstraError, assertAstraActive },
    './astra-local-parts': { preflightAstraElectronics: async () => {} },
    './astra-design-contract': design,
    './astra-artifacts': {
      ASTRA_MANIFEST: 'astra-manifest.json',
      // This fixture isolates allocation/cancellation; strict schema validation is
      // exercised with the actual parser in astra-server-policy.test.mjs.
      parseAstraManifest: value => {
        assert.equal(value.runId, 'run-fake')
        assert.equal(value.proposalSha256, nativeManifest.proposalSha256)
        assert.deepEqual(value.artifacts, nativeManifest.artifacts)
        return value
      },
      readAstraManifest: async (readRoot, runId) => {
        assert.equal(readRoot, root)
        assert.equal(runId, 'run-fake')
        if (!files.has(manifestPath)) throw Object.assign(new Error('no native manifest'), { code: 'ENOENT' })
        return JSON.parse(files.get(manifestPath))
      },
    },
  }
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', compiled)(
    name => {
      assert.ok(Object.hasOwn(deps, name), `Unmocked pipeline dependency: ${name}`)
      return deps[name]
    }, loaded, loaded.exports,
  )
  return {
    writes, records, workflow, files, removed, manifestPath, nativeManifest,
    get electronicsCalls() { return electronicsCalls },
    async run() {
      const response = await loaded.exports.astraPipeline(new Request('http://127.0.0.1:3000/api/pipeline/run?runId=run-fake'), async () => {
        electronicsCalls += 1
        assertAstraActive(execution)
        files.set(manifestPath, JSON.stringify(nativeManifest))
        files.set(`${root}/public/runs/run-fake/electronics/chipscale.kicad_pcb`, 'pcb!')
        if (fault === 'electronics-return' || fault === 'rename-failure') execution.cancel()
        return Response.json({ ok: true })
      })
      return response.text()
    },
  }
}

for (const boundary of ['mkdir', 'astra-policy.json', 'product-spec.json', 'timing.json']) {
  test(`cancellation during ${boundary} stops subsequent allocation work and persists only failure`, async t => {
    const f = fixture(t, boundary)
    const events = await f.run()
    assert.equal(f.electronicsCalls, 0)
    assert.equal(f.workflow.execution.calls, 0)
    assert.equal(f.workflow.busy, false)
    assert.ok(!events.includes('"state":"running"'))
    assert.ok(!events.includes('"type":"done"'))
    assert.ok(events.includes('"type":"error"'))
    assert.equal(f.writes.at(-1).name, 'timing.json')
    assert.equal(f.writes.at(-1).value.stages[0].status, 'failed')
    assert.deepEqual(f.records, [['test-owner', 'run-fake']], 'every allocated partial run retains its owner')
    assert.equal(f.workflow.runId, 'run-fake')
    assert.equal(f.files.has(f.manifestPath), false, 'pre-native cancellation never fabricates a native manifest')
    assert.deepEqual(f.removed, [])
    const policy = f.writes.filter(w => w.name === 'astra-policy.json').at(-1).value
    assert.equal(policy.status, 'cancelled')
    assert.equal(policy.outcome.category, 'cancelled')
    assert.equal('proposalSha256' in policy, false)
    if (boundary === 'mkdir') {
      assert.deepEqual(f.writes.map(w => w.name), ['astra-policy.json', 'timing.json'])
    }
    if (boundary === 'astra-policy.json') assert.ok(!f.writes.some(w => w.name === 'product-spec.json'))
  })
}

test('initial persistence failure marks outcome unknown without exposing storage details', async t => {
  const f = fixture(t, 'policy-failure')
  const events = await f.run()
  assert.equal(f.electronicsCalls, 0)
  assert.equal(f.writes.at(-1).value.stages[0].status, 'failed')
  assert.match(f.writes.at(-1).value.stages[0].detail, /unknown/)
  assert.ok(!events.includes('private raw'))
  assert.ok(events.includes('"type":"error"'))
})

test('existing allocation is never overwritten and failure-marker write errors remain safe', async t => {
  for (const fault of ['existing', 'all-writes-fail']) {
    const f = fixture(t, fault)
    const events = await f.run()
    assert.equal(f.electronicsCalls, 0)
    assert.equal(f.writes.length, 0)
    assert.ok(!events.includes('private raw'))
    assert.ok(events.includes('"type":"error"'))
    if (fault === 'existing') assert.equal(f.records.length, 0)
  }
})

for (const boundary of ['electronics-return', 'success-timing', 'success-policy']) {
  test(`cancellation during ${boundary} downgrades persisted native pass without deleting artifacts`, async t => {
    const f = fixture(t, boundary)
    const events = await f.run()
    assert.equal(f.electronicsCalls, 1)
    assert.equal(f.writes.at(-1).value.stages[0].status, 'failed')
    assert.ok(events.includes('"type":"error"'))
    assert.ok(!events.includes('"type":"done"'))
    const manifest = JSON.parse(f.files.get(f.manifestPath))
    assert.equal(manifest.status, 'cancelled')
    assert.equal(manifest.checks.exportsComplete, false)
    assert.equal(manifest.proposalSha256, f.nativeManifest.proposalSha256)
    assert.deepEqual(manifest.artifacts, f.nativeManifest.artifacts)
    assert.equal(f.files.get('/mock-owned-astra-root/public/runs/run-fake/electronics/chipscale.kicad_pcb'), 'pcb!')
    assert.deepEqual(f.removed, [])
    const policy = f.writes.filter(w => w.name === 'astra-policy.json').at(-1).value
    assert.equal(policy.status, 'cancelled')
    assert.equal(policy.outcome.category, 'cancelled')
  })
}

test('failed manifest downgrade removes stale success marker only, preserving native artifacts', async t => {
  const f = fixture(t, 'rename-failure')
  const events = await f.run()
  assert.match(events, /"type":"error"/)
  assert.doesNotMatch(events, /"type":"done"/)
  assert.equal(f.files.has(f.manifestPath), false)
  assert.equal(f.files.get('/mock-owned-astra-root/public/runs/run-fake/electronics/chipscale.kicad_pcb'), 'pcb!')
  assert.deepEqual(f.removed.sort(), [
    '/mock-owned-astra-root/public/runs/run-fake/.astra-pipeline-manifest.pending.json',
    f.manifestPath,
  ].sort())
  assert.equal(f.writes.filter(w => w.name === 'astra-policy.json').at(-1).value.status, 'cancelled')
  assert.equal(f.writes.at(-1).value.stages[0].status, 'failed')
})
