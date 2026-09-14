import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { archiveComposeTurns, canSubmitCompose, createComposeOperations, createComposeSessionCache, settleComposeStages } from '../lib/compose-session.ts'

const source = fs.readFileSync(new URL('../components/compose-chat.tsx', import.meta.url), 'utf8')

test('conversation snapshots restore input and interviews without sharing specifications', () => {
  const cache = createComposeSessionCache()
  const draft = { typed: 'battery powered', current: { question: 'Power source?' }, answers: [], productSpec: null }
  const run = { typed: 'change enclosure', productSpec: { product: 'Sensor' } }
  cache.set('draft:initial', draft)
  cache.set('run:selected', run)
  assert.deepEqual(cache.get('draft:initial'), draft)
  assert.deepEqual(cache.get('run:selected'), run)
  assert.equal(cache.get('run:other'), undefined)
  assert.equal(createComposeSessionCache().get('draft:initial'), undefined, 'private state must not outlive its workspace')
})

test('session snapshots have a bounded least-recently-used lifetime', () => {
  const cache = createComposeSessionCache(2)
  cache.set('draft', { typed: 'retained draft' })
  cache.set('first', { typed: 'first run' })
  cache.get('draft')
  cache.set('second', { typed: 'second run' })
  assert.equal(cache.size, 2)
  assert.equal(cache.get('first'), undefined)
  assert.equal(cache.get('draft').typed, 'retained draft')
  cache.delete('draft')
  assert.equal(cache.get('draft'), undefined)
})

test('busy is synchronous and stays true across nested paid handoffs and ID reads', () => {
  const busy = []
  const scope = createComposeOperations((value) => busy.push(value))
  scope.activate()
  const architect = scope.begin()
  assert.equal(busy.at(-1), true)
  const board = scope.begin()
  architect.finish()
  assert.equal(scope.busy, true)
  assert.equal(busy.at(-1), true)
  const idRead = scope.begin()
  board.finish()
  assert.equal(busy.at(-1), true)
  idRead.finish()
  assert.equal(scope.busy, false)
  assert.equal(busy.at(-1), false)
  const count = busy.length
  idRead.finish()
  assert.equal(busy.length, count, 'finish is idempotent')
})

test('unmount invalidates queued events and aborts requests without invoking followons', async () => {
  const scope = createComposeOperations(() => {})
  scope.activate()
  const operation = scope.begin()
  let resolve
  const read = new Promise((r) => { resolve = r })
  let followons = 0
  const pending = read.then(() => { if (operation.current()) followons += 1 })
  scope.dispose()
  assert.equal(operation.signal.aborted, true)
  resolve()
  await pending
  assert.equal(followons, 0)
  assert.equal(operation.current(), false)
  assert.equal(scope.busy, false)
})

test('effect reactivation never revives an old operation or lets it clear new busy state', () => {
  const busy = []
  const scope = createComposeOperations((value) => busy.push(value))
  scope.activate()
  const old = scope.begin()
  scope.dispose()
  scope.activate()
  const fresh = scope.begin()
  old.finish()
  assert.equal(old.current(), false)
  assert.equal(fresh.current(), true)
  assert.equal(busy.at(-1), true)
  fresh.finish()
  assert.equal(busy.at(-1), false)
})

test('unsupported Send never accepts error, finished, or plan-ready text', () => {
  for (const phase of ['error', 'done', 'ready', 'revReady', 'building']) assert.equal(canSubmitCompose(phase, false, false), false)
  assert.equal(canSubmitCompose('idle', false, false), true)
  assert.equal(canSubmitCompose('done', true, false), true)
  for (const phase of ['id', 'architect', 'interview']) {
    assert.equal(canSubmitCompose(phase, false, true), true)
    assert.equal(canSubmitCompose(phase, false, false), false)
  }
  const submit = source.slice(source.indexOf('  function submit()'), source.indexOf('  function startRev()'))
  assert.doesNotMatch(submit, /setTyped\(''\)/)
  assert.match(submit, /isBusy\(\)/)
  assert.match(submit, /canSubmitCompose\(/)
})

test('stable session identity is separate from run promotion and never uses persistent storage', () => {
  assert.match(source, /const key = props\.sessionKey \?\?/)
  assert.match(source, /<ComposeSession key=\{key\}/)
  assert.doesNotMatch(source, /key=\{activeRunId\}|localStorage|sessionStorage/)
  assert.match(source, /initial\?\.current/)
  assert.match(source, /initial\?\.productSpec/)
  assert.match(source, /if \(productSpec\) latest\.current\.onProductSpec/)
})

test('both stream failures report to parent and do not hide downstream errors', () => {
  assert.equal((source.match(/else if \(ev\.type === 'error'\) failBuild/g) ?? []).length, 2)
  const failure = source.slice(source.indexOf('  function failBuild'), source.indexOf('  function stop'))
  assert.match(failure, /onRunFailed\?\.\(id, detail, outcome\)/)
  assert.doesNotMatch(source, /err && !boardBuilt/)
  assert.match(source, /role="alert"/)
  assert.match(source, /This does not cancel server execution/)
  assert.match(source, /onClick=\{retryFailed\}/)
  assert.match(source, /aria-label=\{current \?/)
  assert.match(source, /ThreadMenu\.Trigger disabled=\{busy\}/)
})

test('explicit failures settle live indicators without changing completed stage evidence', () => {
  const stages = { design: 'passed', placement: 'running', routing: 'pending', validation: 'blocked' }
  const settled = settleComposeStages(stages, 'failed')
  assert.deepEqual(settled, { design: 'passed', placement: 'failed', routing: 'pending', validation: 'blocked' })
  assert.equal(stages.placement, 'running', 'previous snapshots remain immutable')
  assert.equal(Object.values(settled).includes('running'), false)
  assert.match(source, /outcome: 'failed' \| 'disconnected' = 'failed'/)
  assert.match(source, /setStages\(\(previous\) => settleComposeStages\(previous, outcome\)\)/)
})

test('disconnected observation removes spinners without claiming cancellation or failure', () => {
  assert.deepEqual(settleComposeStages({ design: 'passed', placement: 'running' }, 'disconnected'), {
    design: 'passed', placement: 'disconnected',
  })
  const stop = source.slice(source.indexOf('  function stop()'), source.indexOf('  const retryLabel'))
  assert.match(stop, /settleComposeStages\(previous, 'disconnected'\)/)
  assert.match(stop, /This does not cancel server execution/)
  assert.match(stop, /onRunFailed\?\.\(observedRunRef\.current, detail, 'disconnected'\)/)
  const page = fs.readFileSync(new URL('../app/compose/page.tsx', import.meta.url), 'utf8')
  assert.match(page, /const connectionLost = outcome === 'disconnected'/)
  assert.doesNotMatch(page, /connection\|stream\|disconnect/)
  assert.equal((source.match(/Connection lost before the build finished\.[^\n]+, 'disconnected'\)/g) ?? []).length, 2)
  assert.match(source, /st === 'disconnected'.+Updates disconnected/)
})

test('archived interview turns survive ID handoff but never enter ID protocol answers', () => {
  const architectAnswers = [{ question: 'Power source?', answer: 'Battery' }]
  const archive = archiveComposeTurns([], 'Product Architect', architectAnswers)
  architectAnswers.length = 0
  assert.deepEqual(archive, [{ label: 'Product Architect', turns: [{ question: 'Power source?', answer: 'Battery' }] }])
  assert.equal(archiveComposeTurns(archive, 'Industrial Design', []), archive)
  const handoff = source.slice(source.indexOf('  async function startIdFromBoard'), source.indexOf('  /** Product-tier interview'))
  assert.match(handoff, /setAnswers\(\[\]\)/)
  assert.match(handoff, /askIndustrialDesign\(intent, \[\], ground, runId\)/)
  assert.doesNotMatch(handoff, /setHistory|setLogs/)
  assert.match(source, /archiveComposeTurns\(previous, 'Product Architect', acc\)/)
  assert.match(source, /archiveComposeTurns\(previous, 'Industrial Design', acc\)/)
  assert.match(source, /history\.map\(\(section, index\)/)
  assert.match(source, /initial\?\.history/)
})

test('completion clears leftover live indicators without inventing stage success', () => {
  assert.deepEqual(settleComposeStages({ design: 'passed', placement: 'running', routing: 'pending' }, 'unreported'), {
    design: 'passed', placement: 'unreported', routing: 'pending',
  })
  assert.equal((source.match(/settleComposeStages\(previous, 'unreported'\)/g) ?? []).length, 2)
  assert.match(source, /st === 'unreported'.+Result not reported/)
})

test('discipline completion uses shared attempt evidence, not artifact existence', () => {
  assert.match(source, /pipelineStatus\?: WorkspacePipeline/)
  assert.match(source, /pipelineHistoryState\?: WorkspaceHistoryState/)
  assert.match(source, /workspaceStageLabel\(pipe, pipelineHistoryState\)/)
  const rows = source.slice(source.indexOf('{disciplineRows(prodSpec)'), source.indexOf('{/* feedback-loop outcome'))
  assert.doesNotMatch(rows, /builtDisciplines\?\.[^\n]+\n\s*\? 'built'/)
  assert.match(rows, /artifact available/)
})

test('display history remains bounded over repeated product revisions', () => {
  let history = []
  const turns = Array.from({ length: 40 }, (_, i) => ({ question: `Q${i}`, answer: `A${i}` }))
  for (let i = 0; i < 12; i++) history = archiveComposeTurns(history, `Revision ${i}`, turns)
  assert.equal(history.length, 8)
  assert.equal(history[0].label, 'Revision 4')
  assert.equal(history[0].turns.length, 30)
  assert.equal(history[0].turns[0].question, 'Q10')
})

test('every paid fetch uses an abortable operation and targeted errors cannot replay full redesign', () => {
  const paid = [...source.matchAll(/await fetch\('(\/api\/[^']+)', \{\s+signal: op\.signal/g)]
  assert.equal(paid.length, 7)
  const route = source.slice(source.indexOf('  async function routeEdit'), source.indexOf('  async function runTargeted'))
  const caught = route.slice(route.indexOf('} catch'))
  assert.doesNotMatch(caught, /reviseProduct\(/)
  assert.match(caught, /setRetry/)
  assert.match(source, /startIdFromBoard\(ev\.runDir, id, opts\.intent \|\| req\)/)
})
