import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { INITIAL_WORKSPACE_SESSION, clampWorkspacePanes, pipelineSignature, promoteWorkspaceSession, rememberWorkspaceSession, workspaceBoardStatus, workspaceInitialPipeline, workspaceMode, workspaceProgress, restoreWorkspaceTiming, readWorkspaceTiming, workspacePipelineState, interruptWorkspacePipeline, workspaceStageLabel, workspaceRunId, workspaceOnshapeUrl, workspaceImportFileError } from '../lib/workspace-state.ts'

const source = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')

test('responsive surface breakpoints include mobile, 768 tablet and desktop', () => {
  assert.equal(workspaceMode(390), 'mobile')
  assert.equal(workspaceMode(720), 'mobile')
  assert.equal(workspaceMode(768), 'tablet')
  assert.equal(workspaceMode(1024), 'tablet')
  assert.equal(workspaceMode(1440), 'desktop')
})
test('restored pane widths reserve center and reject bad storage values', () => {
  for (const width of [768, 1024, 1200, 1440]) {
    const panes = clampWorkspacePanes(width, 99999, 99999, true, true)
    assert.ok(panes.left + panes.right + 420 + 10 <= width)
  }
  assert.deepEqual(clampWorkspacePanes(1440, NaN, Infinity), { left: 320, right: 360 })
  assert.deepEqual(clampWorkspacePanes(1440, -1, 0), { left: 320, right: 360 })
  assert.ok(clampWorkspacePanes(768, 440, 460, false, true).right <= 343)
})
test('pipeline signature is stable and refreshes on status not log text', () => {
  assert.equal(pipelineSignature({ b: { status: 'pending' }, a: { status: 'running' } }), pipelineSignature({ a: { status: 'running', detail: 'different log' }, b: { status: 'pending' } }))
  assert.notEqual(pipelineSignature({ a: { status: 'running' } }), pipelineSignature({ a: { status: 'passed' } }))
})
test('progress distinguishes pending, skipped and concurrent running stages', () => {
  assert.equal(workspaceProgress({ a: { status: 'pending' } }, false).label, 'Build incomplete')
  assert.equal(workspaceProgress({ a: { status: 'skipped' } }, false).label, 'Stages skipped')
  const concurrent = workspaceProgress({ a: { status: 'running' }, b: { status: 'running' }, c: { status: 'passed' } }, true)
  assert.equal(concurrent.running, 2)
  assert.equal(concurrent.passed, 1)
  assert.equal(workspaceProgress({ a: { status: 'failed' } }, false).label, 'Build needs attention')
})
test('initial board failure blocks discipline progress without inventing completed stages', () => {
  const failed = workspaceInitialPipeline('GATE FAILED', 'Synthetic placement failed')
  assert.equal(failed.electronics.status, 'blocked')
  assert.match(failed.electronics.detail, /Synthetic placement failed/)
  assert.equal(workspaceProgress(failed, false).label, 'Build needs attention')
  assert.equal(workspaceProgress(failed, false).passed, 0)
  const disconnected = workspaceInitialPipeline('NEEDS ATTENTION', 'Connection lost')
  assert.equal(disconnected.electronics.status, 'unknown')
  assert.match(disconnected.electronics.detail, /outcome is unknown/)
  assert.doesNotMatch(disconnected.electronics.detail, /cancelled|canceled/)
  assert.equal(workspaceProgress(workspaceInitialPipeline('RUNNING'), false).label, 'Build in progress')
  assert.deepEqual(workspaceInitialPipeline('PASSED'), {})
  assert.deepEqual(workspaceInitialPipeline(), {})
  assert.match(source('../app/compose/page.tsx'), /pipeStatusByRun\[selectedId\] \?\? initialPipelineByRun\[selectedId\], timingHistory/)
  assert.doesNotMatch(source('../app/compose/page.tsx'), /workspaceInitialPipeline\(selectedRun\?\.status/)
})
test('only authoritative board facts support passed header, never readiness', () => {
  assert.equal(workspaceBoardStatus(null, true, false).label, 'Review required')
  assert.equal(workspaceBoardStatus({ components: 8 }, true, false).label, 'Board unverified')
  const passed = workspaceBoardStatus({ components: 8, ok: true, drc: { available: true, errors: 0 }, drcRepair: { unrouted: 0 } }, true, false)
  assert.equal(passed.label, 'Board checks passed')
  assert.equal(passed.action, 'Review manufacturing')
  assert.match(passed.detail, /not physical or manufacturing approval/)
  assert.equal(workspaceBoardStatus({ components: 8, drc: { available: true, errors: 2 } }, true, false).label, 'Needs review')
})
test('draft promotion preserves same key and parent context cache is bounded', () => {
  const runs = new Map()
  assert.equal(promoteWorkspaceSession(runs, 'run-a', INITIAL_WORKSPACE_SESSION), INITIAL_WORKSPACE_SESSION)
  promoteWorkspaceSession(runs, 'revision-a', INITIAL_WORKSPACE_SESSION)
  assert.equal(runs.get('revision-a'), INITIAL_WORKSPACE_SESSION)
  assert.equal(runs.has('run-a'), false, 'ancestor selection must restore a distinct saved-run session')
  const contexts = new Map()
  for (let n = 0; n < 12; n++) rememberWorkspaceSession(contexts, `draft:${n}`, { prompt: String(n) })
  assert.equal(contexts.size, 8)
  rememberWorkspaceSession(contexts, 'draft:4', { prompt: 'preserved' })
  rememberWorkspaceSession(contexts, 'draft:12', { prompt: 'new' })
  assert.equal(contexts.get('draft:4').prompt, 'preserved')
  assert.equal(contexts.has('draft:5'), false)
})
test('one chat stays mounted across utility surfaces and selection uses canonical callbacks', () => {
  const page = source('../app/compose/page.tsx')
  assert.equal((page.match(/<ComposeChat\b/g) ?? []).length, 1)
  assert.match(page, /hidden=\{leftView !== 'chat'\}/)
  assert.match(page, /onSelectThread=\{selectThreadFromList\}/)
  assert.match(page, /onSelectRun=\{selectThreadFromList\}/)
  assert.match(page, /onBusyChange=\{onBusyChange\}/)
  assert.match(page, /key === sessionKeyRef\.current && id === selectedIdRef\.current/)
  assert.match(page, /const generationProps = \(discipline: Stage\)/)
  assert.match(page, /onBuildStart: async \(\) =>/)
  assert.match(page, /\.\.\.generationProps\('electronics'\)/)
  assert.match(page, /onBuildSettled:/)
  assert.match(page, /manualOwnerRef\.current\?\.token !== token/)
  assert.match(page, /artifactRevision.*pipelineSignature\(pipeStatus\)/)
  assert.match(page, /setSurface\('conversation'\); setDocTabs\(\[\]\)/)
  assert.match(page, /workspaceProgress\(legacyMode \? pipeStatus : \{\}, legacyMode && liveRunning, historyState\)/)
  assert.match(page, /const canChangeSelection = \(\) =>/)
  assert.match(page, /Finish or stop the current operation/)
  assert.match(page, /runId=\{selectedId \|\| null\}/)
  assert.doesNotMatch(page, /anyPassedGate|pipelineRunId \? pipeStatusByRun/)
})
const startedAt = '2026-09-13T10:00:00.000Z'
const endedAt = '2026-09-13T10:01:00.000Z'
const attempt = (stage, status, extra = {}) => ({ stage, status, startedAt, endedAt, ...extra })
const timing = (stages, extra = {}) => ({ runId: 'run-a', startedAt, stages, ...extra })

test('timing restoration validates identity/schema and never maps legacy EDA or artifacts', () => {
  const valid = timing([attempt('electronics', 'passed')])
  for (const value of [null, {}, [], { ...valid, runId: 'run-b' }, { ...valid, startedAt: 'bad' },
    { ...valid, totalMs: -1 }, { ...valid, finishedAt: 'bad' }, timing([]),
    timing([attempt('placement', 'passed')]), timing([attempt('electronics', 'success')]),
    timing([attempt('electronics', 'passed', { startedAt: 'bad' })]),
    timing([attempt('electronics', 'passed', { endedAt: '2020-01-01' })]),
    timing([attempt('electronics', 'passed', { ms: Infinity })]),
    timing([attempt('electronics', 'passed', { unfinished: 'true' })]),
    timing([attempt('electronics', 'passed'), { stage: 'electronics', status: 'failed' }]),
    { ...valid, stages: undefined, artifacts: { electronics: true } }]) {
    assert.deepEqual(restoreWorkspaceTiming(value, 'run-a'), { runId: 'run-a', state: 'unavailable', pipeline: {} })
  }
  const restored = restoreWorkspaceTiming(valid, 'run-a')
  assert.equal(restored.state, 'available')
  assert.equal(restored.pipeline.electronics.status, 'passed')
  assert.equal(restored.pipeline.mechanical.status, 'unknown')
  assert.equal(workspaceProgress(restored.pipeline, false, restored.state).label, 'Build outcome unknown')
})
test('latest attempts win by timestamp with append order breaking equal-time ties', () => {
  const restored = restoreWorkspaceTiming(timing([
    attempt('mechanical', 'passed'),
    attempt('mechanical', 'failed', { startedAt: endedAt, endedAt: '2026-09-13T10:02:00Z' }),
    attempt('mechanical', 'passed'), // older entry arriving out of order cannot hide failure
    attempt('simulation', 'passed'), attempt('simulation', 'blocked'),
  ], { finishedAt: '2026-09-13T10:03:00Z' }), 'run-a')
  assert.equal(restored.pipeline.mechanical.status, 'failed')
  assert.equal(restored.pipeline.simulation.status, 'blocked')
  assert.equal(workspaceProgress(restored.pipeline, false).label, 'Build needs attention')
})
test('finishedAt never proves success; historical running and unfinished are unknown', () => {
  const restored = restoreWorkspaceTiming(timing([
    attempt('electronics', 'running', { endedAt: undefined }),
    attempt('mechanical', 'passed', { unfinished: true }),
    attempt('simulation', 'passed', { endedAt: undefined }),
    attempt('firmware', 'failed'), attempt('manufacturing', 'blocked'),
    attempt('supplyChain', 'pending'), attempt('validation', 'skipped'),
  ], { finishedAt: endedAt }), 'run-a')
  assert.deepEqual(Object.values(restored.pipeline).map((value) => value.status), ['unknown', 'unknown', 'unknown', 'failed', 'blocked', 'pending', 'skipped'])
  assert.equal(workspaceProgress(restored.pipeline, false).running, 0)
  assert.equal(workspaceProgress(restored.pipeline, false).passed, 0)
  assert.match(restored.pipeline.electronics.detail, /Server outcome is unknown/)
  assert.equal(workspaceStageLabel('unknown'), 'Outcome unknown')
})
test('matching history is separate from live state and missing history is never not started', () => {
  const history = restoreWorkspaceTiming(timing([attempt('electronics', 'passed')]), 'run-a')
  assert.equal(workspacePipelineState('run-a', undefined, history).pipeline.electronics.status, 'passed')
  for (const live of [{}, { electronics: { status: 'running' } }, { electronics: { status: 'failed' } }]) {
    const selected = workspacePipelineState('run-a', live, history)
    assert.equal(selected.pipeline, live)
    assert.equal(selected.historyState, 'none')
  }
  assert.equal(workspacePipelineState('run-b', undefined, history).historyState, 'loading')
  assert.equal(workspacePipelineState('', undefined, history).historyState, 'none')
  assert.equal(workspaceProgress({}, false, 'unavailable').label, 'History unavailable')
  assert.equal(workspaceProgress({}, false, 'loading').label, 'Loading history')
  assert.equal(workspaceProgress({}, true, 'unavailable').label, 'Build in progress')
  assert.equal(workspaceStageLabel(undefined, 'unavailable'), 'History unavailable')
})
test('timing reader uses only the exact artifact, rejects unsafe IDs and handles unavailable reads', async () => {
  const signal = new AbortController().signal
  const result = await readWorkspaceTiming('run-a', signal, async (url, options) => {
    assert.equal(url, '/runs/run-a/timing.json')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.signal, signal)
    assert.equal(options.method, undefined)
    return { ok: true, json: async () => timing([attempt('electronics', 'failed')]) }
  })
  assert.equal(result.pipeline.electronics.status, 'failed')
  for (const read of [async () => ({ ok: false }), async () => { throw new Error('offline') },
    async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON') } })]) {
    assert.equal((await readWorkspaceTiming('run-a', signal, read)).state, 'unavailable')
  }
  await readWorkspaceTiming('../run-a', signal, async () => { assert.fail('unsafe path fetched') })
})
test('aborted delayed A response and delayed JSON cannot replace selected B history', async () => {
  const controller = new AbortController()
  let release
  const a = readWorkspaceTiming('run-a', controller.signal, async () => new Promise((resolve) => { release = resolve }))
  controller.abort()
  const b = await readWorkspaceTiming('run-b', new AbortController().signal, async () => ({ ok: true, json: async () => timing([attempt('electronics', 'failed')], { runId: 'run-b' }) }))
  release({ ok: true, json: async () => { assert.fail('aborted response parsed') } })
  assert.equal(await a, null)
  assert.equal(b.runId, 'run-b')
  const delayed = new AbortController()
  let releaseJson
  const parsed = readWorkspaceTiming('run-a', delayed.signal, async () => ({ ok: true, json: () => new Promise((resolve) => { releaseJson = resolve }) }))
  await Promise.resolve()
  delayed.abort()
  releaseJson(timing([attempt('electronics', 'passed')]))
  assert.equal(await parsed, null)
  await readWorkspaceTiming('run-a', delayed.signal, async () => { assert.fail('aborted request fetched') })
})
test('stop observation removes live spinners without inventing cancellation or passes', () => {
  const live = { electronics: { status: 'passed' }, mechanical: { status: 'running' }, simulation: { status: 'pending' } }
  const stopped = interruptWorkspacePipeline(live)
  assert.equal(stopped.electronics.status, 'passed')
  assert.equal(stopped.mechanical.status, 'unknown')
  assert.equal(stopped.simulation.status, 'pending')
  assert.equal(live.mechanical.status, 'running')
  assert.match(stopped.mechanical.detail, /Server outcome is unknown/)
  assert.doesNotMatch(stopped.mechanical.detail, /cancelled|canceled/)
  assert.equal(workspaceProgress(stopped, false).label, 'Build outcome unknown')
})
test('page restores history outside product cache guards and shares wording across surfaces', () => {
  const page = source('../app/compose/page.tsx')
  const restoreEffect = page.slice(page.indexOf('// Independent of product/spec caches.'), page.indexOf('// A tab close'))
  assert.match(restoreEffect, /readWorkspaceTiming\(id, controller.signal\)/)
  assert.match(restoreEffect, /selectionEpochRef.current === epoch/)
  assert.match(restoreEffect, /selectedIdRef.current === id/)
  assert.match(restoreEffect, /return \(\) => controller.abort\(\)/)
  assert.doesNotMatch(restoreEffect, /productSpecRef.current/)
  assert.match(page, /pipelineHistoryState=\{legacyMode \? historyState : 'unavailable'\}/)
  assert.match(restoreEffect, /if \(!legacyMode \|\| !selectedId\) return/)
  assert.match(page, /<RunTimeline[^\n]*historyState=\{historyState\}/)
  assert.match(page, /<StatusBar[^\n]*running=\{liveRunning\} historyState=\{historyState\}/)
  assert.match(source('../components/status-bar.tsx'), /workspaceProgress\(pipeline \?\? \{\}, !!running, historyState\)/)
  assert.match(source('../components/run-timeline.tsx'), /workspaceStageLabel\(stage.state, historyState\)/)
  assert.doesNotMatch(page, /<PipelineLoader|selectedRun\?\.status === 'RUNNING'/)
  assert.match(page, /Retry history/)
  assert.match(page, /<LLMSettings \/>/)
})
test('import file validation rejects empty, oversized and wrong-extension uploads', () => {
  assert.equal(workspaceImportFileError(null, 'pcb'), null)
  assert.equal(workspaceImportFileError({ name: 'board.KICAD_PCB', size: 10 }, 'pcb'), null)
  assert.equal(workspaceImportFileError({ name: 'case.stp', size: 50 * 1024 * 1024 }, 'step'), null)
  assert.match(workspaceImportFileError({ name: 'board.kicad_pcb', size: 0 }, 'pcb'), /empty/)
  assert.match(workspaceImportFileError({ name: 'case.step', size: 50 * 1024 * 1024 + 1 }, 'step'), /50 MiB/)
  assert.match(workspaceImportFileError({ name: 'board.txt', size: 10 }, 'pcb'), /Choose a .kicad_pcb/)
  assert.match(workspaceImportFileError({ name: 'case.step.exe', size: 10 }, 'step'), /Choose a .step/)
})

test('import response and Onshape URL validation rejects malformed IDs and deceptive hosts', () => {
  for (const value of ['', null, undefined, 123, '../run', 'run/a', 'run?x', 'run#x', 'run a']) assert.equal(workspaceRunId(value), false)
  assert.equal(workspaceRunId('run-a_12'), true)
  assert.equal(workspaceOnshapeUrl('https://cad.onshape.com/documents/abc/w/def/e/ghi'), true)
  for (const value of ['https://evil.test/cad.onshape.com/documents/a/w/b/e/c',
    'https://cad.onshape.com.evil.test/documents/a/w/b/e/c', 'http://cad.onshape.com/documents/a/w/b/e/c',
    'https://user@cad.onshape.com/documents/a/w/b/e/c', 'https://cad.onshape.com/documents/a', 'not a url']) assert.equal(workspaceOnshapeUrl(value), false)
  const page = source('../app/compose/page.tsx')
  assert.equal((page.match(/if \(!workspaceRunId\(d\?\.runId\)\)/g) ?? []).length, 2)
})

test('inspecting industrial design only fetches persisted artifacts, never generates', () => {
  for (const file of ['../components/id-stage.tsx', '../components/id-stage-view.tsx']) {
    const component = source(file)
    const effect = component.slice(component.indexOf('  useEffect('), component.indexOf('  async function'))
    assert.doesNotMatch(effect, /\brun\(\)|\bgenerate\(\)|method:\s*'POST'/)
    assert.match(component, /generationDisabled/)
    assert.match(component, /onClick=\{(?:run|generate)\}/)
  }
})
