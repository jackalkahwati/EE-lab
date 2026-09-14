import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import {
  parseAstraStatus, fetchAstraStatus, astraPreferenceBlocker, astraGenerationBlocker,
  astraWorkflowHeaders, beginAstraWorkflow, cancelAstraWorkflow, astraBuildUrl, astraTemplateRequest,
} from '../lib/astra-client.ts'
import { createComposeOperations } from '../lib/compose-session.ts'
import { ASTRA_DESIGN_TEMPLATE } from '../lib/astra-design-contract.ts'

const ready = { enabled: true, transport: 'astra-beta', model: 'gpt-6-astra', billing: 'Bedrock', scope: 'electronics-only', ready: true, blockers: [] }
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const source = fs.readFileSync(new URL('../components/compose-chat.tsx', import.meta.url), 'utf8')
const statusSource = fs.readFileSync(new URL('../components/astra-beta-status.tsx', import.meta.url), 'utf8')

// All transports below are injected fakes. No network, provider, native execution or browser.
test('status checks are GET-only, fresh, and never begin workflows', async () => {
  const calls = []
  const controller = new AbortController()
  const status = await fetchAstraStatus(async (...args) => { calls.push(args); return response(ready) }, controller.signal)
  assert.deepEqual(status, ready)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], '/api/astra')
  assert.equal(calls[0][1].method, undefined)
  assert.equal(calls[0][1].body, undefined)
  assert.equal(calls[0][1].cache, 'no-store')
  assert.equal(calls[0][1].signal, controller.signal)
  assert.doesNotMatch(statusSource, /beginAstraWorkflow|action: 'begin'/)
})

test('only exact disabled or validated beta contracts enable generation', () => {
  assert.deepEqual(parseAstraStatus({ enabled: false }), { enabled: false })
  for (const invalid of [null, {}, { ...ready, enabled: 'true' }, { ...ready, billing: 'OpenAI' }, { ...ready, scope: 'all' }, { ...ready, ready: undefined }, { ...ready, blockers: [42] }]) {
    assert.throws(() => parseAstraStatus(invalid), /Invalid Astra status/)
  }
  assert.equal(astraGenerationBlocker({ state: 'loaded', status: { enabled: false } }, 'unrelated stored provider'), null)
  assert.equal(astraGenerationBlocker({ state: 'loaded', status: ready }, null), null)
  assert.match(astraGenerationBlocker({ state: 'loading' }, null), /Checking/)
  assert.equal(astraGenerationBlocker({ state: 'error', error: 'Unavailable' }, null), 'Unavailable')
  assert.equal(astraGenerationBlocker({ state: 'loaded', status: { ...ready, ready: false, blockers: ['Exact geometry unavailable'] } }, null), 'Exact geometry unavailable')
  assert.ok(astraGenerationBlocker({ state: 'loaded', status: { ...ready, ready: false } }, null))
  assert.ok(astraGenerationBlocker({ state: 'loaded', status: { ...ready, blockers: ['Native blocked'] } }, null))
})

test('status authentication and malformed errors remain fail-closed', async () => {
  await assert.rejects(fetchAstraStatus(async () => response({ enabled: false }, 401)), /HTTP 401/)
  await assert.rejects(fetchAstraStatus(async () => response({})), /Invalid Astra/)
  await assert.rejects(fetchAstraStatus(async () => { throw new Error('offline') }), /offline/)
})

test('browser preferences are checked without mutation or exposing keys', () => {
  const store = (data) => ({ getItem: (key) => data[key] ?? null })
  assert.equal(astraPreferenceBlocker(store({})), null)
  assert.match(astraPreferenceBlocker(store({ 'fl-model': 'some-other-model' })), /Select Auto/)
  for (const data of [{ 'fl-llm-key': 'do-not-print-key' }, { 'fl-llm-provider': 'openai' }]) {
    const blocker = astraPreferenceBlocker(store(data))
    assert.match(blocker, /Bedrock/)
    assert.doesNotMatch(blocker, /do-not-print-key/)
  }
  assert.match(astraPreferenceBlocker({ getItem() { throw new Error('security error') } }), /blocked/)
})

test('explicit begin returns only owned identity and propagates blocked preflight', async () => {
  const calls = []
  const id = await beginAstraWorkflow(async (...args) => { calls.push(args); return response({ workflowId: 'workflow-owned' }) })
  assert.equal(id, 'workflow-owned')
  assert.deepEqual(calls[0][1].headers, { 'content-type': 'application/json' })
  assert.deepEqual(JSON.parse(calls[0][1].body), { action: 'begin' })
  await assert.rejects(beginAstraWorkflow(async () => response({ error: 'Native exact geometry blocked', category: 'preflight' }, 409)), /exact geometry blocked/)
  await assert.rejects(beginAstraWorkflow(async () => response({ workflowId: '' })), /identity/)
})

test('template request requires separate explicit selection and never rewrites arbitrary draft', () => {
  assert.deepEqual(astraTemplateRequest(ASTRA_DESIGN_TEMPLATE.id, ASTRA_DESIGN_TEMPLATE.prompt), {
    templateId: ASTRA_DESIGN_TEMPLATE.id, request: ASTRA_DESIGN_TEMPLATE.prompt, answers: [],
  })
  for (const id of [null, '', 'unknown']) assert.throws(() => astraTemplateRequest(id, ASTRA_DESIGN_TEMPLATE.prompt), /Select/)
  for (const draft of ['A motor controller', '', `${ASTRA_DESIGN_TEMPLATE.prompt} Add USB`]) assert.throws(() => astraTemplateRequest(ASTRA_DESIGN_TEMPLATE.id, draft))
  const selection = source.slice(source.indexOf('<section aria-label="Supported native design template"'), source.indexOf('Selection does not submit or change your draft'))
  assert.match(selection, /ASTRA_DESIGN_TEMPLATE.prompt/)
  assert.match(selection, /setAstraTemplateId/)
  assert.doesNotMatch(selection, /setTyped|askArchitect|beginAstraWorkflow|submit\(/)
  assert.match(source, /const submitted = beta \|\| retryingRef.current \? undefined : typed/)
  assert.match(source, /body: JSON.stringify\(betaRequest \?\?/)
  assert.match(source, /readOnly=\{beta\}/)
  assert.match(source, /Your draft is preserved below and will not be sent/)
  assert.match(source, /Generate this BME280 breakout/)
  assert.match(source, /if \(!beta && e.key === 'Enter'/)
})

test('beta generation control stacks and wraps in narrow conversation panes without hiding model settings', () => {
  // Source contract only: real layout was observed by the coordinator. No DOM or browser here.
  const controls = source.slice(source.indexOf("<div className={cn('flex gap-2', beta ?"))
  assert.match(controls, /beta \? 'min-w-0 flex-col items-stretch' : 'items-center justify-between'/)
  assert.match(controls, /<ModelSelector \/>/)
  assert.match(controls, /beta \? 'w-full min-w-0 whitespace-normal' : 'shrink-0'/)
  assert.match(controls, /onClick=\{submit\}/)
  assert.match(controls, /disabled=\{\(beta \? astraTemplateId !== ASTRA_DESIGN_TEMPLATE.id \|\| phase !== 'idle' \|\| reviseMode/)
  assert.match(controls, /\|\| busy \|\| !!generationBlocker \|\| !!editPlan/)
  assert.match(controls, /'Generate this BME280 breakout' : 'Send ↵'/)
})

test('beta POST headers and build URL never carry model, credentials, planner or client spec', () => {
  assert.deepEqual(astraWorkflowHeaders('owned'), { 'content-type': 'application/json', 'x-fl-astra-workflow': 'owned' })
  assert.throws(() => astraWorkflowHeaders(''), /owned Astra workflow/)
  const url = new URL(astraBuildUrl('run-123', 'owned/&=1'), 'https://fixture.invalid')
  assert.deepEqual([...url.searchParams], [['runId', 'run-123'], ['astraWorkflow', 'owned/&=1'], ['beta', '1']])
  for (const key of ['model', 'plan', 'spec', 'compose', 'prompt', 'key']) assert.equal(url.searchParams.has(key), false)
})

test('cancel targets only owned workflow and does not release busy before acknowledgement', async () => {
  const changes = []
  const operations = createComposeOperations((busy) => changes.push(busy))
  operations.activate()
  const build = operations.begin()
  const cancel = operations.begin()
  let resolve
  let call
  const pending = cancelAstraWorkflow(async (...args) => { call = args; return new Promise((done) => { resolve = done }) }, 'owned-workflow', cancel.signal)
  assert.equal(operations.busy, true)
  build.finish() // terminal SSE wins while cancellation remains in flight
  assert.equal(operations.busy, true)
  assert.deepEqual(JSON.parse(call[1].body), { action: 'cancel' })
  assert.equal(call[1].headers['x-fl-astra-workflow'], 'owned-workflow')
  assert.equal(call[1].signal, cancel.signal)
  resolve(response({ cancelled: true, detail: 'Local cancellation acknowledged' }))
  assert.equal(await pending, 'Local cancellation acknowledged')
  cancel.finish()
  assert.equal(operations.busy, false)
  assert.equal(changes.at(-1), false)
})

test('failed cancellation cannot release original operation or trigger automatic retry', async () => {
  const operations = createComposeOperations(() => {})
  operations.activate()
  const build = operations.begin()
  const cancel = operations.begin()
  let requests = 0
  await assert.rejects(cancelAstraWorkflow(async () => { requests += 1; return response({ cancelled: false }) }, 'owned'), /not confirmed/)
  cancel.finish()
  assert.equal(requests, 1)
  assert.equal(operations.busy, true)
  assert.equal(build.current(), true)
  build.finish()
})

test('compose beta path is stored-spec only with gate-aware terminal status and no continuation', () => {
  assert.match(source, /if \(!beta && opts\?\.thenId/)
  assert.match(source, /beta \? astraBuildUrl\(id, astraWorkflowRef\.current!\)/)
  const dispatch = source.slice(source.indexOf('  async function dispatchProduct'), source.indexOf('  \/** Industrial Design:'))
  const betaBranch = dispatch.slice(dispatch.indexOf('if (beta)'), dispatch.indexOf('const elec'))
  assert.match(betaBranch, /buildBoard/)
  assert.doesNotMatch(betaBranch, /fetch\(|thenId|plan: true/)
  assert.match(source, /ev\.scope === 'electronics-only' && ev\.status === 'PASSED'/)
  assert.match(source, /'GATE FAILED'/)
  assert.match(source, /if \(!passed\).*onRunFailed/)
  assert.match(source, /ev\.text \?\? ev\.message/)
  assert.match(source, /Board artifacts are available for inspection/)
})

test('generation and cancellation controls remain distinct and identity-fenced', () => {
  assert.match(source, /\|\| !!generationBlocker \|\| !!editPlan/)
  assert.match(source, /if \(!isBusy\(\) && allowGeneration\(\)\) onRunPipeline/)
  assert.match(source, /astraWorkflowRef\.current !== workflowId/)
  assert.match(source, /astraCancelRequested: astraCancelRequested\.current/)
  assert.match(source, /Disconnect updates/)
  assert.match(statusSource, /Cancel Astra workflow/)
  assert.match(statusSource, /In-flight provider work may still incur charges/)
  assert.doesNotMatch(statusSource, /localStorage\.(setItem|removeItem)/)
})
