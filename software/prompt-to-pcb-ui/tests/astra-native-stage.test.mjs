import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import * as view from '../lib/astra-run-view.ts'

// Actual component/functions with instrumented hooks and transport only. No browser,
// server, private run artifacts, provider calls or native programs are used.
const source = fs.readFileSync(new URL('../components/astra-native-stage.tsx', import.meta.url), 'utf8')
const boardSource = fs.readFileSync(new URL('../components/board-3d.tsx', import.meta.url), 'utf8')
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const RUN = 'run-native-fixture'
const sha = 'a'.repeat(64)
const entry = path => ({ path, bytes: 1, sha256: sha })
const manifest = (overrides = {}) => ({ version: 1, runId: RUN, native: true, scope: 'electronics-only', status: 'failed', routeAttempts: 1, createdAt: '2026-09-13T00:00:00Z', proposalSha256: sha, tools: { kicad: '9' }, checks: { drcAvailable: true, drcErrors: 2, unrouted: 3, identityPreserved: true, exportsComplete: false }, artifacts: [entry('board/render-top.png'), entry('electronics/chipscale.svg')], ...overrides })
const response = (value, status = 200) => new Response(JSON.stringify(value), { status })
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const walk = (node, predicate, found = []) => {
  if (Array.isArray(node)) node.forEach(child => walk(child, predicate, found))
  else if (node && typeof node === 'object') { if (predicate(node)) found.push(node); walk(node.props?.children, predicate, found) }
  return found
}
const text = node => {
  if (Array.isArray(node)) return node.map(text).join(' ')
  if (node && typeof node === 'object') return text(node.props?.children)
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}

function harness(transport = async () => { throw new Error('Unmocked network call') }) {
  const state = [], refs = [], effects = []
  let stateIndex, refIndex, tree, cleanup, key, savedProps
  const jsx = (type, props, key) => ({ type, props, key })
  const react = {
    useState(initial) { const i = stateIndex++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }] },
    useRef(initial) { const i = refIndex++; return refs[i] ?? (refs[i] = { current: initial }) },
    useEffect(effect) { effects.push(effect) },
  }
  const exports = {}
  vm.runInNewContext(compile(source), { exports, AbortController, Error, fetch: transport, require(name) {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (name === '@/lib/astra-run-view') return view
    if (name === '@/components/board-3d') return { Board3D: 'SavedBoard3D' }
    throw new Error(`Forbidden component import: ${name}`)
  } })
  const render = (props = savedProps ?? { runId: RUN }, runEffect = false) => {
    savedProps = props
    const wrapper = exports.AstraNativeStage(props)
    const changed = wrapper.key !== key
    if (changed) { cleanup?.(); state.length = 0; refs.length = 0; key = wrapper.key }
    stateIndex = 0; refIndex = 0; effects.length = 0
    tree = wrapper.type(wrapper.props)
    if (changed || runEffect) { if (!changed) cleanup?.(); cleanup = effects[0]() }
    return tree
  }
  return { api: exports, render, text: () => text(tree), nodes: type => walk(tree, node => node.type === type), stop: () => cleanup?.() }
}

function boardApi() {
  const exports = {}
  vm.runInNewContext(compile(boardSource), { exports, require(name) {
    if (['react', 'react/jsx-runtime', 'lucide-react'].includes(name)) return {}
    throw new Error(`Unexpected board import ${name}`)
  } })
  return exports
}

test('reads only fixed manifest/policy/timing URLs with cancellation, freshness and no redirects', async () => {
  const calls = []
  const controller = new AbortController()
  const result = await harness().api.readAstraNativeSnapshot(RUN, controller.signal, async (url, options) => {
    calls.push([url, options]); return response(url.endsWith(view.ASTRA_MANIFEST) ? manifest() : {})
  })
  assert.equal(result.manifest.status, 'failed')
  assert.deepEqual(calls.map(([url]) => url), [`/runs/${RUN}/astra-manifest.json`, `/runs/${RUN}/astra-policy.json`, `/runs/${RUN}/timing.json`])
  for (const [, options] of calls) {
    assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error'); assert.equal(options.signal, controller.signal)
    assert.equal(options.method, undefined); assert.equal(options.body, undefined)
  }
})

test('invalid run identity makes no read, and invalid native evidence never creates a snapshot', async () => {
  const api = harness().api
  let calls = 0
  await assert.rejects(api.readAstraNativeSnapshot('../run-owned', new AbortController().signal, async () => { calls++; return response({}) }))
  assert.equal(calls, 0)
  for (const count of [undefined, null, '', '0', false, -1, 0.5]) {
    const bad = manifest({ status: 'passed', checks: { drcAvailable: true, drcErrors: count, unrouted: 0, identityPreserved: true, exportsComplete: false } })
    await assert.rejects(api.readAstraNativeSnapshot(RUN, new AbortController().signal, async url => response(url.endsWith(view.ASTRA_MANIFEST) ? bad : {})))
  }
})

test('numeric checks require actual nonnegative safe integers; missing evidence is not zero', () => {
  const { nativeCountLabel } = harness().api
  for (const value of [undefined, null, '', '0', false, true, NaN, Infinity, -1, 0.1, Number.MAX_SAFE_INTEGER + 1]) assert.equal(nativeCountLabel(value), 'Unknown')
  assert.equal(nativeCountLabel(0, false), 'Unknown')
  assert.equal(nativeCountLabel(0), 'Passed (0)')
  assert.equal(nativeCountLabel(7), 'Failed (7)')
})

test('metadata failure preserves partial cancelled outputs and warning, never fabricates files', async () => {
  const { api } = harness()
  const result = await api.readAstraNativeSnapshot(RUN, new AbortController().signal, async url => response(url.endsWith(view.ASTRA_MANIFEST) ? manifest({ status: 'cancelled' }) : {}, url.endsWith('timing.json') ? 500 : 200))
  assert.equal(result.manifest.status, 'cancelled')
  assert.equal(result.manifest.artifacts.length, 2)
  assert.match(result.warnings[0], /timing.json/)
  assert.equal(api.nativeManifestUrl(result.manifest, 'board/chipscale.glb'), null)
  assert.equal(api.nativeManifestUrl(result.manifest, '../private.json'), null)
  assert.equal(api.nativeManifestUrl(result.manifest, 'board/render-top.png'), `/runs/${RUN}/board/render-top.png?v=${sha}`)
})

test('404 manifest means unknown, while unavailable manifest read is an error', async () => {
  const api = harness().api
  const missing = await api.readAstraNativeSnapshot(RUN, new AbortController().signal, async () => response({}, 404))
  assert.equal(missing.manifest, null)
  await assert.rejects(api.readAstraNativeSnapshot(RUN, new AbortController().signal, async () => response({}, 403)), /HTTP 403/)
})

test('identity switch aborts stale requests and cannot show the old manifest or links', async () => {
  const calls = []
  const h = harness((url, options) => new Promise(resolve => calls.push({ url, options, resolve })))
  h.render({ runId: RUN }); assert.equal(calls.length, 3)
  const other = 'run-other-fixture'
  h.render({ runId: other }); assert.equal(calls.length, 6)
  for (const call of calls.slice(0, 3)) { assert.equal(call.options.signal.aborted, true); call.resolve(response(call.url.endsWith(view.ASTRA_MANIFEST) ? manifest() : {})) }
  for (const call of calls.slice(3)) call.resolve(response(call.url.endsWith(view.ASTRA_MANIFEST) ? manifest({ runId: other, status: 'cancelled', artifacts: [] }) : {}))
  await flush(); h.render()
  assert.match(h.text(), /Cancelled/)
  assert.doesNotMatch(h.text(), /Failed \(2\)/)
  assert.equal(h.nodes('a').length, 0)
  h.stop()
})

test('unmount aborts reads and refresh failures retain labelled previous snapshot', async () => {
  let fail = false
  const calls = []
  const h = harness(async (url, options) => { calls.push(options); return response(url.endsWith(view.ASTRA_MANIFEST) ? manifest({ status: 'cancelled' }) : {}, fail ? 500 : 200) })
  h.render(); await flush(); h.render()
  assert.match(h.text(), /cancelled/)
  fail = true
  h.render({ runId: RUN, refreshKey: 1 }, true); await flush(); h.render()
  assert.match(h.text(), /previous saved snapshot is retained/)
  assert.match(h.text(), /current freshness is unknown/)
  const retry = h.nodes('button').find(button => text(button) === 'Retry saved reads')
  assert.ok(retry)
  retry.props.onClick()
  h.stop()
  assert.ok(calls.every(call => call.signal.aborted))
})

test('verified manifest alone controls saved GLB, file links and non-electronics scope', async () => {
  const full = manifest({ artifacts: [entry('board/chipscale.glb'), entry('electronics/chipscale.kicad_pcb')] })
  const h = harness(async url => response(url.endsWith(view.ASTRA_MANIFEST) ? full : { status: 'PASSED' }))
  h.render(); await flush(); h.render()
  const model = h.nodes('SavedBoard3D')[0]
  assert.equal(model.props.glbUrl, `/runs/${RUN}/board/chipscale.glb?v=${sha}`)
  assert.match(h.text(), /Mechanical, thermal, firmware and system validation were not run/)
  h.nodes('button').find(button => text(button) === 'Files').props.onClick(); h.render()
  assert.deepEqual(h.nodes('a').map(link => link.props.href), full.artifacts.map(item => `/runs/${RUN}/${item.path}?v=${sha}`))
  assert.deepEqual(h.nodes('a').map(link => link.props.download), ['chipscale.glb', 'chipscale.kicad_pcb'])
  h.stop()
})

test('saved native Board3D only accepts exact run-scoped model URLs and embedded resources', () => {
  const { nativeBoardGlbUrl, nativeBoardResourceUrl } = boardApi()
  for (const url of [`/runs/${RUN}/board/chipscale.glb`, `/runs/${RUN}/board/chipscale.glb?v=${sha}`]) assert.equal(nativeBoardGlbUrl(url), url)
  for (const url of ['https://outside.invalid/model.glb', '//outside.invalid/model.glb', `/runs/${RUN}/board/other.glb`, '/api/board3d', '/runs/run-../../board/chipscale.glb', `/runs/${RUN}/board/chipscale.glb?next=evil`, `/runs/${RUN}/board/chipscale.glb#x`, '']) assert.throws(() => nativeBoardGlbUrl(url))
  for (const url of ['data:image/png;base64,AAAA', 'blob:https://local.invalid/fixture']) assert.equal(nativeBoardResourceUrl(url), url)
  for (const url of ['https://outside.invalid/texture.png', '/runs/run-other/texture.png', '../texture.png', 'file:///tmp/a', 'data:text/html;base64,AAAA']) assert.throws(() => nativeBoardResourceUrl(url))
})

test('compose routes beta and unknown modes away from legacy readers and panels', () => {
  const page = fs.readFileSync(new URL('../app/compose/page.tsx', import.meta.url), 'utf8')
  assert.match(page, /run\.transport === 'astra-beta'/)
  assert.match(page, /const nativeMode = astraMode\.beta \|\| selectedNative/)
  assert.match(page, /const legacyMode = astraMode\.availability\.state === 'loaded' && !astraMode\.availability\.status\.enabled && !selectedNative/)
  assert.match(page, /const readSavedBoard = [\s\S]*?if \(!legacyMode\) return null/)
  assert.match(page, /if \(!legacyMode \|\| !selectedReal\)/)
  assert.match(page, /if \(!legacyMode \|\| !selectedId \|\| boardGenerating\) return/)
  assert.match(page, /if \(nativeMode\) return \(\) =>/)
  assert.match(page, /const preview = !legacyMode \? \(/)
  assert.match(page, /<AstraNativeStage runId=\{selectedId\} refreshKey=/)
  assert.match(page, /const panelBody = \(tb: Tab\) => !legacyMode/)
  assert.match(page, /legacyMode \? <ArtifactExplorer/)
  assert.match(page, /legacyMode \? <StatusBar/)
  assert.match(page, /nativeMode \? buildAstraRunView\(\{ runId, spec:/)
  assert.match(page, /generationDisabled=\{[^\n]+astraMode\.generationBlocker/)
  assert.match(page, /onRunPipeline=\{legacyMode \?/)
})

test('explicit policy cancellation without a manifest remains cancelled, not absent run success', async () => {
  const h = harness(async url => url.endsWith(view.ASTRA_MANIFEST) ? response({}, 404) : response(url.endsWith('astra-policy.json') ? { version: 1, transport: 'astra-beta', model: 'gpt-6-astra', scope: 'electronics-only', runId: RUN, status: 'cancelled' } : {}))
  h.render(); await flush(); h.render()
  assert.match(h.text(), /Cancelled/)
  assert.match(h.text(), /This run was cancelled/)
  h.stop()
})

test('native stage and explicit model branch cannot enter legacy generation/export routes', () => {
  assert.doesNotMatch(source, /astra-artifacts|\/api\/|llmHeaders|beginAstraWorkflow|POST|dangerouslySetInnerHTML|<iframe|<object/)
  assert.match(source, /controller\.signal\.aborted \|\| version\.current !== token/)
  assert.match(source, /controller\.abort\(\)/)
  assert.match(boardSource, /savedNative \? nativeBoardGlbUrl\(glbUrl\) :/)
  assert.match(boardSource, /setURLModifier\(nativeBoardResourceUrl\)/)
  assert.match(boardSource, /\[basePath, glbUrl\]/)
  assert.match(boardSource, /Loading saved native 3D model/)
})
