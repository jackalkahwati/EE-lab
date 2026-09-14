import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

// Source-only I/O. Providers, native adapters, persistence and legacy tools are
// explicit mocks. No scratch/native board or saved run is created by these tests.
const root = new URL('../', import.meta.url)
const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText
class AstraError extends Error {
  constructor(category, message) { super(message); this.category = category }
}
const load = (source, deps, globals = {}) => {
  const exports = {}
  vm.runInNewContext(compile(source), { exports, require: name => {
    if (!(name in deps)) throw Error(`Unmocked dependency ${name}`)
    return deps[name]
  }, Request, Response, URL, AbortController, structuredClone, console, ...globals })
  return exports
}
const localSource = fs.readFileSync(new URL('lib/astra-local-parts.ts', root), 'utf8')
const catalog = JSON.parse(fs.readFileSync(new URL('lib/astra-catalog.json', root), 'utf8'))
const readinessReason = 'Fixture qualification manifest is missing; native containment remains unverified.'
const localModule = (readAstraReadiness = async () => ({ ready: false, reason: readinessReason })) => load(localSource, {
  '@/lib/astra-execution': { AstraError }, './astra-catalog.json': catalog,
  './astra-readiness': { readAstraReadiness },
})
const local = localModule()
const body = load(fs.readFileSync(new URL('lib/astra-body.ts', root), 'utf8'), {
  './astra-execution': { AstraError },
}, { Buffer, setTimeout, clearTimeout })
const routeSource = fs.readFileSync(new URL('app/api/electronics-cs/route.ts', root), 'utf8')
const design = load(fs.readFileSync(new URL('lib/astra-design-contract.ts', root), 'utf8'), {})
const plain = value => JSON.parse(JSON.stringify(value))
function specificationFixture() {
  return {
    product: 'BME280 3.3V I2C breakout', description: 'External host environmental sensor board.', budgets: {},
    disciplines: {
      electronics: { status: 'defined', summary: 'I2C sensor breakout.', boardIntent: 'Externally powered BME280 breakout.', layers: 2, maxBoardMm: { x: 24, y: 18 }, contract: plain(design.ASTRA_DESIGN_TEMPLATE.electricalContract) },
      ...Object.fromEntries(['mechanical', 'firmware', 'manufacturing', 'supplyChain', 'validation'].map(name => [name, { status: 'not_applicable', summary: 'Not requested; not run.', requirements: [] }])),
    },
  }
}
function proposalFixture() {
  const contract = JSON.parse(local.astraLocalPartsPrompt().split('\n').at(-1))
  return {
    parts: contract.parts,
    nets: contract.contract.canonicalNets.filter(net => net.name !== 'GND').flatMap(net => net.pins.slice(1).map((pin, i) => [net.pins[i], pin])),
    gnd: contract.contract.canonicalNets.find(net => net.name === 'GND').pins,
  }
}

function fixture(options = {}) {
  const ctx = { cancelled: false }
  const spec = specificationFixture()
  const workflow = { execution: ctx, busy: true, phase: 'building', runId: 'run-test', templateId: design.ASTRA_DESIGN_TEMPLATE.id, spec }
  const calls = { llm: 0, native: 0, prepare: 0, validate: 0, body: 0, legacy: 0, reads: 0, writes: 0, credit: 0, order: [], userPrompt: null, proposal: null }
  const preflightModule = localModule(async () => {
    calls.order.push('readiness')
    if (options.readinessError) throw options.readinessError
    return { ready: options.readinessReady === true, reason: readinessReason }
  })
  const active = execution => { if (execution.cancelled) throw new AstraError('cancelled', 'cancelled') }
  const netlist = proposalFixture()
  const denied = () => { calls.legacy++; throw Error('forbidden legacy dependency reached') }
  const fakeFs = {
    readFile: () => { calls.reads++; return denied() },
    writeFile: () => { calls.writes++; return denied() },
    mkdir: denied, access: denied, readdir: denied, copyFile: denied, rename: denied, rm: denied,
  }
  const tools = { fixture: 'prepared tool capability token, not native proof' }
  const nativeResult = options.result ?? { ok: false, status: 'failed', detail: 'mock native gate failed' }
  const execution = {
    AstraError, currentAstraExecution: () => options.noContext ? undefined : ctx,
    assertAstraActive: active, isAstraError: e => e instanceof AstraError,
    buildAstraNativeEnv: denied, runAstraProcess: denied,
  }
  const api = load(routeSource + '\nexport const __test = { emitPartsNets, emitPartsNetsHierarchical };', {
    'node:fs': { promises: fakeFs }, 'node:path': path, 'node:child_process': { spawn: denied },
    '@/lib/llm': { callLLMText: async (_system, userPrompt) => {
      calls.llm++; calls.order.push('llm'); calls.userPrompt = userPrompt
      if (options.llmError) throw options.llmError
      if (options.cancelOnLlm) ctx.cancelled = true
      return { text: options.text ?? JSON.stringify(netlist) }
    } },
    '@/lib/plan-llm': { resolvePlanModel: () => ({ override: {} }) },
    '@/lib/auth': { isAdminRequest: () => true, runAccess: () => ({ access: options.access ?? 'owner' }) },
    '@/lib/spend-gate': { assertCanSpend: () => { calls.credit++; return null } },
    '@/lib/design-state': { pinsPromptFor: denied, partPinsFor: denied },
    '@/lib/model-tiers': { MODEL: { design: 'default', replan: 'default' } },
    '@/lib/id-brief': { normalizeIdBrief: denied },
    '@/lib/parts-registry': { registryFootprint: denied, registrySaveFootprint: denied },
    '@/lib/subsystem-compose.mjs': { composeSubsystems: denied, splitForGeneration: denied },
    '@/lib/keepalive': { withKeepalive: promise => promise },
    '@/lib/astra-execution': execution,
    '@/lib/astra-design-contract': design,
    '@/lib/astra-body': { readAstraBody: async req => { calls.body++; calls.order.push('body'); return body.readAstraBody(req) } },
    '@/lib/astra-native': {
      prepareAstraNativeJob: async execution => {
        assert.equal(execution, ctx); calls.prepare++; calls.order.push('prepare')
        if (options.prepareError) throw options.prepareError
        if (options.cancelOnPrepare) ctx.cancelled = true
        return tools
      },
      buildAstraNative: async (execution, runId, proposal, prepared) => {
        assert.equal(execution, ctx); assert.equal(runId, workflow.runId); assert.equal(prepared, tools)
        calls.native++; calls.order.push('native'); calls.proposal = proposal
        assert.equal(proposal.catalogId, local.ASTRA_CATALOG_ID)
        assert.deepEqual(plain(proposal.canonicalNets), plain(local.ASTRA_CATALOG.contract.canonicalNets))
        if (options.cancelOnNative) ctx.cancelled = true
        if (options.nativeError) throw options.nativeError
        return nativeResult
      },
    },
    '@/lib/astra-beta': {
      astraConfigured: () => options.configured !== false,
      astraWorkflow: () => workflow,
      astraWorkspace: () => { throw Error('legacy workspace access forbidden') },
      astraErrorResponse: e => Response.json({ error: e.message, category: e.category }, { status: 403 }),
    },
    '@/lib/astra-local-parts': {
      ...local,
      // Pure topology tests may bypass readiness; actualPreflight exercises the
      // real read-only preflight using an explicit status fixture, never a mint.
      preflightAstraElectronics: async () => {
        calls.order.push('preflight')
        if (options.actualPreflight) await preflightModule.preflightAstraElectronics()
      },
      validateAstraLocalNetlist: value => {
        calls.validate++; calls.order.push('validate')
        return local.validateAstraLocalNetlist(value)
      },
    },
  }, { process: { cwd: () => '/mock-owned-workspace', execPath: '/mock-node', env: { ANTHROPIC_API_KEY: 'must-not-reach-native', FL_HIERARCHICAL: 'on' } } })
  const request = (payload = {}, headers = { 'x-fl-astra-workflow': 'test' }) => new Request('http://127.0.0.1:3210/api/electronics-cs', {
    method: 'POST', headers, body: JSON.stringify({ spec, runId: 'run-test', ...payload }),
  })
  return { api, calls, ctx, workflow, request, netlist, nativeResult }
}

function noSideEffects(f) {
  assert.deepEqual([f.calls.llm, f.calls.prepare, f.calls.native, f.calls.reads, f.calls.writes, f.calls.credit, f.calls.legacy], [0, 0, 0, 0, 0, 0, 0])
}

test('preflight fails closed on missing readiness proof rather than trusting the reviewed catalog', async () => {
  await assert.rejects(local.preflightAstraElectronics(), e => e.category === 'policy' && e.message === readinessReason)
  assert.match(local.ASTRA_ELECTRONICS_BLOCKER, /unverified/)
  assert.match(local.ASTRA_ELECTRONICS_BLOCKER, /rotation\/shape/)
  assert.match(local.ASTRA_ELECTRONICS_BLOCKER, /containment/)
  const reviewed = JSON.parse(local.astraLocalPartsPrompt().split('\n').at(-1))
  assert.equal(reviewed.parts.length, 6)
  assert.equal(reviewed.parts.find(part => part.name === 'U1').mpn, 'BME280')
  assert.equal(reviewed.contract.i2cAddress, '0x76')
  assert.match(local.ASTRA_ELECTRONICS_BLOCKER, /catalog does not establish native runner readiness/)
  assert.ok(Object.isFrozen(local.ASTRA_CATALOG))
})

test('unsupported TMP112 and fabricated fields remain rejected by the narrow reviewed catalog', () => {
  const validShape = { parts: [{ name: 'U1', kind: 'chip', footprint: 'sot563', mpn: 'TMP112NAIDRLR' }], nets: [['U1.1', 'U1.6']], gnd: ['U1.2'] }
  for (const value of [validShape, { ...validShape, code: 'fetch()' }, { ...validShape, parts: [{ ...validShape.parts[0], lcsc: 'C1234' }] }, { ...validShape, parts: [{ ...validShape.parts[0], kicadMod: '(pad)' }] }, { ...validShape, parts: [{ ...validShape.parts[0], name: 'U1" />' }] }, { ...validShape, parts: Array(13).fill(validShape.parts[0]) }, null]) {
    assert.throws(() => local.validateAstraLocalNetlist(value), e => e.category === 'policy')
  }
})

test('actual POST preflight blocks before body, inference, storage and credits', async () => {
  const f = fixture({ actualPreflight: true })
  const response = await f.api.POST(f.request())
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error, readinessReason)
  assert.deepEqual(f.calls.order, ['preflight', 'readiness'])
  assert.equal(f.calls.body, 0)
  noSideEffects(f)
})

test('actual read-only preflight readiness errors propagate before body, provider or storage', async () => {
  const f = fixture({ actualPreflight: true, readinessError: new AstraError('policy', 'Fixture evidence verification failed') })
  const response = await f.api.POST(f.request())
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error, 'Fixture evidence verification failed')
  assert.deepEqual(f.calls.order, ['preflight', 'readiness'])
  assert.equal(f.calls.body, 0)
  noSideEffects(f)
})

test('explicit ready status permits only the mocked qualified electronics branch', async () => {
  const f = fixture({ actualPreflight: true, readinessReady: true })
  const response = await f.api.POST(f.request())
  assert.equal(response.status, 200)
  assert.deepEqual(f.calls.order, ['preflight', 'readiness', 'body', 'prepare', 'llm', 'validate', 'native'])
  assert.equal(f.calls.llm, 1)
  assert.equal(f.calls.native, 1)
  assert.equal(f.calls.reads, 0)
  assert.equal(f.calls.writes, 0)
  assert.equal(f.calls.legacy, 0)
})

test('direct, stale-context and mismatched run requests never reach provider fallback', async () => {
  for (const options of [{ noContext: true }, { configured: false }, { configured: false, noContext: true }]) {
    const f = fixture(options)
    assert.equal((await f.api.POST(f.request())).status, 403)
    noSideEffects(f)
  }
  const stale = fixture({ configured: false, noContext: true })
  assert.equal((await stale.api.POST(new Request('http://127.0.0.1:3210/api/electronics-cs?astraWorkflow=old', { method: 'POST', body: '{}' }))).status, 403)
  noSideEffects(stale)
  const f = fixture()
  assert.equal((await f.api.POST(f.request({ runId: 'run-other' }))).status, 403)
  noSideEffects(f)
})

test('inactive operation, mismatched execution, missing stored spec and cancelled context are denied', async () => {
  for (const mutate of [
    f => { f.workflow.busy = false }, f => { f.workflow.phase = 'ready' },
    f => { f.workflow.execution = {} }, f => { delete f.workflow.spec },
    f => { f.ctx.cancelled = true },
  ]) {
    const f = fixture(); mutate(f)
    assert.equal((await f.api.POST(f.request())).status, 403)
    noSideEffects(f)
  }
})

test('nonowners cannot enter native preparation even when admin helper returns true', async () => {
  for (const access of ['unauthenticated', 'none', 'shared', 'viewer']) {
    const f = fixture({ access })
    const response = await f.api.POST(f.request())
    assert.equal(response.status, 403)
    assert.match((await response.json()).error, /ownership mismatch/)
    noSideEffects(f)
  }
})

test('conflicting client specification and extra legacy flags cannot override stored workflow', async () => {
  for (const payload of [{ spec: { product: 'client replacement' } }, { spec: null }, { plannerOnly: true }, { keepCapabilities: true }, { hierarchical: true }, { runId: 42 }]) {
    const f = fixture()
    const response = await f.api.POST(f.request(payload))
    assert.equal(response.status, 403)
    assert.match((await response.json()).error, /stored specification/)
    noSideEffects(f)
  }
})

test('unsupported stored contract is rejected before preparation and electronics inference', async () => {
  for (const mutate of [
    f => { delete f.workflow.templateId },
    f => { f.workflow.spec.disciplines.electronics.contract.supply.nominalV = 5 },
    f => { f.workflow.spec.disciplines.electronics.maxBoardMm.x = 10 },
    f => { f.workflow.spec.disciplines.firmware.status = 'defined' },
    f => { delete f.workflow.spec.disciplines.electronics.contract },
  ]) {
    const f = fixture(); mutate(f)
    const response = await f.api.POST(f.request())
    assert.equal(response.status, 403)
    assert.equal((await response.json()).category, 'policy')
    noSideEffects(f)
  }
})

test('bounded body reader rejects malformed, oversized and nonobject requests before preparation', async () => {
  for (const payload of ['{broken', JSON.stringify({ padding: 'x'.repeat(33 * 1024) }), 'null', '[]']) {
    const f = fixture()
    const response = await f.api.POST(new Request('http://127.0.0.1:3210/api/electronics-cs', {
      method: 'POST', headers: { 'x-fl-astra-workflow': 'test' }, body: payload,
    }))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).category, 'policy')
    noSideEffects(f)
  }
})

test('default non-beta malformed request retains normal validation response', async () => {
  const f = fixture({ configured: false, noContext: true })
  const response = await f.api.POST(f.request({ spec: {} }, {}))
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'missing product spec')
  noSideEffects(f)
})

test('native preparation precedes one inference and one validation; no legacy runner or persistence executes', async () => {
  for (const spec of [undefined, 'matching']) {
    const f = fixture()
    const response = await f.api.POST(f.request(spec === undefined ? { spec: undefined } : {}))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), f.nativeResult)
    assert.equal(f.calls.userPrompt, JSON.stringify(f.workflow.spec))
    assert.deepEqual(f.calls.order, ['preflight', 'body', 'prepare', 'llm', 'validate', 'native'])
    assert.deepEqual([f.calls.llm, f.calls.prepare, f.calls.validate, f.calls.native, f.calls.reads, f.calls.writes, f.calls.credit, f.calls.legacy], [1, 1, 1, 1, 0, 0, 0, 0])
    assert.deepEqual(plain(f.calls.proposal.nets), f.netlist.nets)
  }
})

test('failed native readiness prevents inference entirely and is not retried', async () => {
  const f = fixture({ prepareError: new AstraError('policy', 'mock containment failure') })
  const response = await f.api.POST(f.request())
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error, 'mock containment failure')
  assert.deepEqual([f.calls.prepare, f.calls.llm, f.calls.validate, f.calls.native, f.calls.legacy], [1, 0, 0, 0, 0])
})

test('transport and malformed JSON errors never trigger format or hierarchical fallback', async () => {
  for (const options of [{ llmError: new AstraError('timeout', 'timeout') }, { llmError: Error('transport failed') }, { text: '{broken' }]) {
    const f = fixture(options)
    assert.equal((await f.api.POST(f.request())).status, 403)
    assert.deepEqual([f.calls.prepare, f.calls.llm, f.calls.native, f.calls.legacy], [1, 1, 0, 0])
  }
  const f = fixture({ noContext: true, llmError: new AstraError('timeout', 'timeout') })
  await assert.rejects(f.api.__test.emitPartsNetsHierarchical('synthetic', {}, 0, () => {}), e => e.category === 'timeout')
  assert.equal(f.calls.llm, 1)
})

test('invalid proposed topology is rejected once without native execution or replacement', async () => {
  const netlist = proposalFixture(); netlist.nets.push(['J1.1', 'J1.2'])
  const f = fixture({ text: JSON.stringify(netlist) })
  const response = await f.api.POST(f.request())
  assert.equal(response.status, 403)
  assert.equal((await response.json()).category, 'policy')
  assert.deepEqual([f.calls.prepare, f.calls.llm, f.calls.validate, f.calls.native, f.calls.legacy], [1, 1, 1, 0, 0])
})

test('native fatal errors and publication failures are terminal with no reroute, repair or legacy fallback', async () => {
  for (const nativeError of [new AstraError('process', 'mock native nonzero exit'), new AstraError('output', 'mock publication failed'), Error('mock native failure')]) {
    const f = fixture({ nativeError })
    const response = await f.api.POST(f.request())
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error, nativeError.message)
    assert.deepEqual([f.calls.prepare, f.calls.llm, f.calls.validate, f.calls.native, f.calls.writes, f.calls.legacy], [1, 1, 1, 1, 0, 0])
  }
})

test('cancellation after preparation, inference or native completion prevents response success', async () => {
  for (const [options, expected] of [
    [{ cancelOnPrepare: true }, [1, 0, 0, 0]],
    [{ cancelOnLlm: true }, [1, 1, 0, 0]],
    [{ cancelOnNative: true }, [1, 1, 1, 1]],
  ]) {
    const f = fixture(options)
    const response = await f.api.POST(f.request())
    assert.equal(response.status, 403)
    assert.equal((await response.json()).category, 'cancelled')
    assert.deepEqual([f.calls.prepare, f.calls.llm, f.calls.validate, f.calls.native], expected)
    assert.deepEqual([f.calls.writes, f.calls.legacy], [0, 0])
  }
})
