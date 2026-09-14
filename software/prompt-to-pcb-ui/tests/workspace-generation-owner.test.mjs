import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { canSubmitCompose } from '../lib/compose-session.ts'
import { astraGenerationBlocker } from '../lib/astra-client.ts'

const page = readFileSync(new URL('../app/compose/page.tsx', import.meta.url), 'utf8')
const chat = readFileSync(new URL('../components/compose-chat.tsx', import.meta.url), 'utf8')
function extract(source, name) {
  const ast = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let result
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) result = node.initializer.getText(ast)
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(result, `Missing ${name}`)
  return ts.transpileModule(`const extracted = ${result};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}
function owner() {
  const state = { pipeline: {}, generating: false, stage: null, artifact: 0, built: {}, facts: {}, board: {} }
  const setter = key => value => { state[key] = typeof value === 'function' ? value(state[key]) : value }
  const context = {
    legacyMode: true, nativeMode: false,
    beginManualTiming: async () => async () => {},
    Symbol, selectedId: 'run-a', selectedIdRef: { current: 'run-a' }, pageAliveRef: { current: true },
    manualOwnerRef: { current: null }, boardBusyRef: { current: false }, pipeAbort: { current: null },
    chatBusyRef: { current: false }, importBusyRef: { current: false },
    metadataReady: true, metadataReadyRef: { current: true },
    pipeRunning: false, boardGenerating: false, importBusy: false,
    pipeStatus: { electronics: { status: 'passed' }, mechanical: { status: 'passed' } },
    setBoardGenerating: setter('generating'), setManualStage: setter('stage'), setPipeStatusByRun: setter('pipeline'),
    setBoardFacts: setter('facts'), setRealBoard: setter('board'), setBusyMessage: setter('message'),
    setArtifactRevision: setter('artifact'), setBuiltDisc: setter('built'),
  }
  return { state, context, props: vm.runInNewContext(`${extract(page, 'generationProps')} extracted`, context) }
}
test('beta or unverified mode cannot start legacy manual attempts or saved-board exports', async () => {
  const { props, state, context } = owner()
  context.legacyMode = false
  context.beginManualTiming = () => assert.fail('Native mode must not write legacy timing')
  for (const stage of ['electronics', 'mechanical', 'firmware']) {
    assert.equal(props(stage).generationDisabled, true)
    assert.equal(await props(stage).onBuildStart(), false)
  }
  assert.equal(state.generating, false)
  const read = vm.runInNewContext(`${extract(page, 'readSavedBoard')} extracted`, {
    legacyMode: false, loadRealBoard: () => assert.fail('Native mode must not enter legacy artifact loader'),
  })
  assert.equal(await read('/runs/run-native', 'run-native', 0), null)
})

test('native failure retains local run identity and refreshes evidence without legacy gates', () => {
  let runs = [{ id: 'run-native', transport: 'astra-beta', status: 'PASSED' }]
  let reads = 0, revision = 0
  const failed = vm.runInNewContext(`${extract(page, 'onRunFailed')} extracted`, {
    nativeMode: true, localRunsRef: { current: new Set() },
    setRuns: update => { runs = update(runs) },
    setArtifactRevision: update => { revision = update(revision) },
    refreshRuns: () => { reads++; return Promise.resolve([]) },
    workspaceInitialPipeline: () => assert.fail('Native failure cannot infer legacy stage gates'),
  })
  failed('run-native', 'Inspect cancelled partial artifacts')
  assert.equal(runs[0].id, 'run-native')
  assert.equal(runs[0].status, 'UNKNOWN')
  assert.equal(reads, 1)
  assert.equal(revision, 1)
})

test('manual attempt replaces restored success and late history cannot own settlement', async () => {
  const { props, state, context } = owner()
  const first = props('electronics')
  assert.equal(await first.onBuildStart(), true)
  assert.equal(state.pipeline['run-a'].electronics.status, 'running')
  assert.equal(state.facts, null)
  context.pipeStatus = { electronics: { status: 'passed' } }
  const rerender = props('electronics')
  await rerender.onBuildSettled({ status: 'passed' })
  assert.equal(state.generating, true)
  await first.onBuildSettled({ status: 'failed', detail: 'Explicit check failed', artifactAvailable: true })
  assert.equal(state.pipeline['run-a'].electronics.status, 'failed')
  assert.equal(state.generating, false)
  assert.equal(state.built.electronics, true)
  assert.equal(state.artifact, 1)
  await first.onBuildSettled({ status: 'passed' })
  assert.equal(state.pipeline['run-a'].electronics.status, 'failed')
})
test('all conflicting starts are synchronous while browsing does not release ownership', async () => {
  const { props, state, context } = owner()
  const mechanical = props('mechanical')
  assert.equal(await mechanical.onBuildStart(), true)
  assert.equal(await props('electronics').onBuildStart(), false)
  assert.equal(await props('simulation').onBuildStart(), false)
  assert.equal(state.stage, 'mechanical')
  await mechanical.onBuildSettled({ status: 'unknown' })
  assert.equal(state.pipeline['run-a'].mechanical.status, 'unknown')
  for (const ref of ['pipeAbort', 'chatBusyRef', 'importBusyRef']) {
    context[ref].current = true
    assert.equal(await props('electronics').onBuildStart(), false)
    context[ref].current = false
  }
  context.pageAliveRef.current = false
  assert.equal(await props('electronics').onBuildStart(), false)
})
test('obsolete page and operation cannot clear a later generation owner', async () => {
  const { props, state, context } = owner()
  const first = props('mechanical')
  await first.onBuildStart()
  await first.onBuildSettled({ status: 'unknown' })
  const second = props('firmware')
  await second.onBuildStart()
  await first.onBuildSettled({ status: 'passed' })
  assert.equal(state.generating, true)
  context.pageAliveRef.current = false
  await second.onBuildSettled({ status: 'passed' })
  assert.equal(state.pipeline['run-a'].firmware.status, 'running')
})
test('manual panels have stable keys, retained hidden hosts and separate shared guards', () => {
  assert.doesNotMatch(page, /key=\{`[^`]*pipeStatus[^`]*`\}/)
  for (const stage of ['electronics', 'mechanical', 'simulation', 'id']) {
    assert.ok(page.includes(`stage === '${stage}' || manualStage === '${stage}'`))
    assert.ok(page.includes(`hidden={stage !== '${stage}'} inert={stage !== '${stage}'}`))
    assert.ok(page.includes(`{...generationProps('${stage}')}`))
  }
  assert.match(page, /hidden=\{!selectedRun \|\| followBuild \|\| !!activeDocTab\}/)
  assert.match(page, /pageAliveRef\.current = false\s+pipeAbort\.current\?\.abort\(\)/)
  assert.match(page, /\(!runIdArg && chatBusyRef\.current\)/)
  assert.match(chat, /latest\.current\.canStartGeneration\?\.\(\) === false/)
  assert.match(page, /selectedRun\?\.real && specResolvedRun !== selectedId/)
  assert.match(page, /response\.status === 404 && !importedRunsRef\.current\.has\(id\)/)
  assert.match(page, /Retry metadata/)
})
test('targeted fork clears ancestor spec and adopts persisted patched budgets without resubmission', async () => {
  let localSpec = { product: 'ancestor', budgets: { unitCostUsd: 1 } }
  let parentSpec = localSpec
  let alive = true
  const calls = [], promoted = [], timers = []
  const patched = { product: 'fork', budgets: { unitCostUsd: 23 }, disciplines: {} }
  const context = {
    AbortSignal,
    beta: false, allowGeneration: () => astraGenerationBlocker({ state: 'loaded', status: { enabled: false } }, null) === null,
    editPlan: { message: 'Change budget' }, activeRunId: 'parent', isBusy: () => false,
    operations: { begin: () => ({ signal: new AbortController().signal, current: () => alive, finish() {} }) },
    fetch: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, json: async () => url === '/api/runs/targeted' ? { runId: 'fork', scope: [], note: 'Synthetic change' } : patched }
    },
    llmHeaders: () => ({}), logLine() {}, setEditBusy() {}, setErr() {}, setRetry() {}, setEditPlan() {}, setPhase() {},
    setProductSpec: value => { localSpec = value }, setLiveUpdates() {},
    latest: { current: { onProductSpec: value => { parentSpec = value }, onRunComplete: (dir, id) => { promoted.push({ dir, id, parentSpec, localSpec }) } } },
    observedRunRef: { current: null }, pollCleanup: { current: null },
    setTimeout: callback => { timers.push(callback); return timers.length }, clearTimeout() {}, Date,
  }
  await vm.runInNewContext(`${extract(chat, 'runTargeted')} extracted()`, context)
  assert.equal(promoted[0].parentSpec, null)
  assert.equal(promoted[0].localSpec, null)
  assert.equal(promoted[0].dir, '/runs/fork')
  assert.equal(localSpec.budgets.unitCostUsd, 23)
  assert.equal(parentSpec.budgets.unitCostUsd, 23)
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1)
  assert.equal(calls[1].url, '/runs/fork/product-spec.json')
  alive = false
})

const astraReady = { enabled: true, transport: 'astra-beta', model: 'gpt-6-astra', billing: 'Bedrock', scope: 'electronics-only', ready: true, blockers: [] }
for (const scenario of [
  { name: 'ready beta', beta: true, availability: { state: 'loaded', status: astraReady } },
  { name: 'blocked beta', beta: true, availability: { state: 'loaded', status: { ...astraReady, ready: false, blockers: ['Native geometry unavailable'] } } },
  { name: 'unknown mode', beta: false, availability: { state: 'loading' } },
  { name: 'unavailable mode', beta: false, availability: { state: 'error', error: 'Status lookup failed' } },
]) {
  test(`targeted revision with ${scenario.name} cannot claim ownership or submit requests`, async () => {
    const actions = []
    const context = {
      beta: scenario.beta,
      allowGeneration: () => astraGenerationBlocker(scenario.availability, null) === null,
      editPlan: { message: 'Synthetic revision' }, activeRunId: 'ancestor', isBusy: () => false,
      operations: { begin: () => { actions.push('begin'); assert.fail('Blocked generation must not claim ownership') } },
      fetch: () => { actions.push('fetch'); assert.fail('Blocked generation must not submit requests') },
      setEditBusy: () => actions.push('busy'), setErr: () => actions.push('error'), setRetry: () => actions.push('retry'),
      setPhase: () => actions.push('phase'), setEditPlan: () => actions.push('plan'),
    }
    await vm.runInNewContext(`${extract(chat, 'runTargeted')} extracted()`, context)
    assert.deepEqual(actions, [], 'no mutations or automatic retry when targeted generation is blocked')
  })
}

function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
test('pending history claims ownership synchronously and rejected persistence releases it', async () => {
  const { props, context, state } = owner()
  const wait = deferred()
  context.beginManualTiming = () => wait.promise
  const first = props('mechanical')
  const started = first.onBuildStart()
  assert.equal(context.boardBusyRef.current, true)
  assert.equal(await props('electronics').onBuildStart(), false)
  wait.resolve(async () => { throw Error('save failed') })
  assert.equal(await started, true)
  await first.onBuildSettled({ status: 'passed' })
  assert.equal(state.pipeline['run-a'].mechanical.status, 'unknown')
  assert.equal(context.boardBusyRef.current, false)
  context.beginManualTiming = async () => { throw Error('read failed') }
  assert.equal(await props('electronics').onBuildStart(), false)
  assert.equal(state.generating, false)
  assert.match(state.message, /not started/)
})
test('navigation during prerequisite persistence records unknown and submits nothing', async () => {
  const { props, context } = owner()
  const wait = deferred(), outcomes = []
  context.beginManualTiming = () => wait.promise
  const started = props('mechanical').onBuildStart()
  context.pageAliveRef.current = false
  wait.resolve(async result => outcomes.push(result))
  assert.equal(await started, false)
  assert.equal(outcomes[0].status, 'unknown')
  assert.match(outcomes[0].detail, /no new work was submitted/)
})
for (const terminal of ['complete', 'failed']) for (const failure of ['valid', 'invalid', 'timeout']) {
  test(`targeted ${terminal} with ${failure} metadata settles and retries only a read`, async () => {
    const timers = [], calls = [], invalidated = []
    let current = true, finished = 0, retry, live, phase, metadataReads = 0, readRetries = 0
    const op = { signal: new AbortController().signal, current: () => current, finish() { finished++; current = false } }
    const context = {
      AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: () => AbortSignal.timeout(5) },
      beta: false, allowGeneration: () => astraGenerationBlocker({ state: 'loaded', status: { enabled: false } }, null) === null,
      editPlan: { message: 'Synthetic revision' }, activeRunId: 'ancestor', isBusy: () => false,
      operations: { begin: () => op, busy: false },
      fetch: async (url, options) => {
        calls.push({ url, options })
        if (url === '/api/runs/targeted') return { ok: true, json: async () => ({ runId: 'fork' }) }
        if (url.endsWith('v1-job.json')) return { ok: true, json: async () => ({ status: terminal }) }
        metadataReads++
        if (metadataReads === 1 || failure === 'valid') return { ok: true, json: async () => ({ product: 'patched', disciplines: {} }) }
        if (failure === 'timeout') return new Promise((resolve, reject) => {
          const keepalive = setTimeout(() => reject(Error('deadline not enforced')), 1000)
          options.signal.addEventListener('abort', () => { clearTimeout(keepalive); reject(options.signal.reason) }, { once: true })
        })
        return { ok: true, json: async () => ({ product: 17 }) }
      },
      llmHeaders: () => ({}), logLine() {}, setEditBusy() {}, setErr() {}, setRetry: v => { retry = v }, setEditPlan() {},
      setPhase: v => { phase = v }, setProductSpec() {}, setLiveUpdates: v => { live = v },
      latest: { current: { onProductSpec() {}, onRunComplete() {}, onRunFailed() {}, onArtifactsChanged: id => invalidated.push(id), onRetryMetadata: () => { readRetries++ } } },
      observedRunRef: { current: null }, pollCleanup: { current: null },
      setTimeout: callback => { timers.push(callback); return timers.length }, clearTimeout() {}, Date,
    }
    await vm.runInNewContext(`${extract(chat, 'runTargeted')} extracted()`, context)
    assert.equal(live, true)
    await timers.shift()()
    assert.equal(finished, 1)
    assert.equal(live, false)
    assert.equal(phase, terminal === 'complete' ? 'done' : 'idle')
    assert.equal(canSubmitCompose(phase, true, false), true, 'terminal failure accepts a fresh explicit correction')
    if (failure === 'valid') assert.equal(retry, null)
    else assert.equal(retry.kind, 'metadata')
    assert.deepEqual(invalidated, ['fork'])
    assert.equal(timers.length, 0, 'terminal job must not be polled again')
    if (failure !== 'valid') {
    context.retry = retry; context.retryingRef = { current: false }; context.isBusy = () => true
    vm.runInNewContext(`{ ${extract(chat, 'retryFailed')} extracted() }`, context)
    assert.equal(readRetries, 1, 'metadata recovery remains possible with generation disabled')
    }
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1)
  })
}
test('chat generation requires resolved metadata and document viewers invalidate on revision', () => {
  assert.match(page, /generationDisabled=\{boardGenerating \|\| importBusy \|\| !metadataReady \|\| !!astraMode\.generationBlocker \|\| \(selectedNative && !astraMode\.beta\)\}/)
  assert.match(page, /canStartGeneration=\{\(\) => .*metadataReadyRef\.current/)
  assert.match(page, /if \(metadataRequired\) importedRunsRef\.current\.add\(id\)/)
  assert.match(page, /activeDocTab\.id\}:\$\{artifactRevision/)
  assert.match(chat, /retry\.kind === 'metadata' \? operations\.busy : busy/)
})

test('saved board metadata errors remain read failures, not failed imports', async () => {
  let error = ''
  const context = { legacyMode: true, loadRealBoard: async () => { throw Error('missing placement') }, pageAliveRef: { current: true }, selectedIdRef: { current: 'saved' }, selectionEpochRef: { current: 1 }, setBoardReadError: value => { error = value } }
  const read = vm.runInNewContext(`${extract(page, 'readSavedBoard')} extracted`, context)
  assert.equal(await read('/runs/saved', 'saved', 1), null)
  assert.match(error, /run is saved/)
  error = ''
  context.selectedIdRef.current = 'other'
  assert.equal(await read('/runs/saved', 'saved', 1), null)
  assert.equal(error, '')
  assert.equal((page.match(/await loadRealBoard\(/g) ?? []).length, 1, 'all awaited reads use the recovery wrapper')
  assert.match(page, /readSavedBoard\(runDir, runId, epoch\)/)
  assert.match(page, /Retry board metadata/)
})
test('delayed URL restoration preserves the user-selected Files surface', () => {
  assert.match(page, /selectThreadRef\.current\(want, true\)/)
  assert.match(page, /changeSession\(key, id, preserveBrowsing\)/)
  assert.match(page, /if \(!preserveBrowsing\) setLeftView\('chat'\)/)
})

test('targeted failure restores actual discipline evidence instead of initial electronics failure', () => {
  const state = { initial: { fork: { electronics: { status: 'running' } } }, live: { fork: { electronics: { status: 'passed' } } }, history: {}, revision: 0, runs: [{ id: 'fork' }] }
  const setter = key => next => { state[key] = typeof next === 'function' ? next(state[key]) : next }
  const context = { nativeMode: false, localRunsRef: { current: new Set() }, setInitialPipelineByRun: setter('initial'), setPipeStatusByRun: setter('live'), setTimingHistory: setter('history'), setHistoryRevision: setter('revision'), setRuns: setter('runs'), logLine() {}, workspaceInitialPipeline() { assert.fail('targeted work is not an initial electronics attempt') } }
  const failed = vm.runInNewContext(`${extract(page, 'onRunFailed')} extracted`, context)
  failed('fork', 'Simulation failed', 'failed', 'targeted')
  assert.equal(state.initial.fork, undefined)
  assert.equal(state.live.fork, undefined)
  assert.equal(state.history, null)
  assert.equal(state.revision, 1)
  assert.equal(state.runs[0].failure, 'Simulation failed')
  assert.match(chat, /onRunFailed\?\.\(d\.runId, j\.error \|\| 'Targeted revision failed', 'failed', 'targeted'\)/)
  assert.equal((page.match(/<ArtifactExplorer revision=\{artifactRevision\}/g) ?? []).length, 2)
})
test('read-only loader callback ignores stale selection failures', async () => {
  let emit, error = ''
  const context = { legacyMode: true, loadRealBoard: async (base, report) => { emit = report; return null }, pageAliveRef: { current: true }, selectedIdRef: { current: 'a' }, selectionEpochRef: { current: 1 }, setBoardReadError: value => { error = value } }
  const read = vm.runInNewContext(`${extract(page, 'readSavedBoard')} extracted`, context)
  assert.equal(await read('/runs/a', 'a', 1), null)
  assert.equal(error, '', 'sparse null is not a read failure')
  context.selectedIdRef.current = 'b'
  emit()
  assert.equal(error, '')
  context.selectedIdRef.current = 'a'; context.selectionEpochRef.current = 2
  emit()
  assert.equal(error, '', 'A to B to A cannot revive stale error')
})

test('retained import metadata opens artifact views but cannot authorize a generation', async () => {
  const { props, context, state } = owner()
  context.metadataReady = false
  context.metadataReadyRef.current = false
  assert.equal(props('electronics').generationDisabled, true)
  assert.equal(await props('electronics').onBuildStart(), false)
  assert.equal(await props('mechanical').onBuildStart(), false)
  assert.equal(state.generating, false)
  assert.match(page, /productSpec \|\| retainedImportRun === selectedId \? \(/)
  assert.match(page, /else if \(workspaceImportedMetadata\(value\)\) \{\s+setRetainedImportRun\(id\)/)
  assert.match(page, /Generation and chat revisions require a complete product specification/)
})
