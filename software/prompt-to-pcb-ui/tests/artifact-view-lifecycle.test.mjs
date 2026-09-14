import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { boardVerdict } from '../lib/verdict.ts'
import { workspaceProgress } from '../lib/workspace-state.ts'

// Safety: only these four client sources are read and transpiled in memory.
// Every runtime import is explicitly stubbed below. No app routes, stores,
// provider helpers, browser/network APIs, environment files, or subprocesses run.
// This small hook driver tests effect cleanup and callbacks, not browser layout.
const sources = new Map(['discipline-stage', 'chipscale-stage', 'run-overview', 'status-bar'].map((name) => [name,
  ts.transpileModule(readFileSync(new URL(`../components/${name}.tsx`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText,
]))
const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
const icon = () => null

function setup(name, exportName, initialProps) {
  const calls = []
  let host
  const hooks = {
    useState(initial) {
      const index = host.index++
      const owner = host
      if (!(index in owner.slots)) owner.slots[index] = typeof initial === 'function' ? initial() : initial
      return [owner.slots[index], (next) => {
        if (!owner.live) return
        owner.slots[index] = typeof next === 'function' ? next(owner.slots[index]) : next
      }]
    },
    useRef(initial) {
      const index = host.index++
      if (!(index in host.slots)) host.slots[index] = { current: initial }
      return host.slots[index]
    },
    useEffect(fn, deps) {
      const index = host.index++
      const old = host.effects[index]
      if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) {
        host.pending.push(() => { old?.cleanup?.(); host.effects[index] = { deps, cleanup: fn() } })
      }
    },
  }
  const imports = {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': new Proxy({}, { get: () => icon }),
    '@/lib/utils': { cn: (...parts) => parts.filter(Boolean).join(' ') },
    '@/lib/verdict': { boardVerdict },
    '@/lib/workspace-state': { workspaceProgress },
    '@/lib/describe-board': { describeBoard: () => 'Synthetic board' },
    '@/components/llm-settings': { llmHeaders: () => ({}) },
    '@/lib/discipline-artifact': { DISCIPLINE_MODULES: { firmware: { label: 'Firmware', fidelity: 'generated architecture' }, manufacturing: { label: 'Manufacturing', fidelity: 'generated plan' } } },
    '@/components/board-schematic': { BoardSchematic: icon },
    '@/components/board-3d': { Board3D: icon },
  }
  const exports = {}
  vm.runInNewContext(sources.get(name), {
    exports, AbortController,
    require(id) { assert.ok(Object.hasOwn(imports, id), `Unsafe import: ${id}`); return imports[id] },
    fetch(url, options = {}) {
      return new Promise((resolve, reject) => calls.push({ url, options, resolve, reject }))
    },
  })
  const Component = exports[exportName]
  let props = initialProps
  let wrapper
  let tree
  const fresh = () => ({ slots: [], effects: [], pending: [], index: 0, live: true })
  const unmount = () => {
    if (!host) return
    host.live = false
    host.effects.forEach((effect) => effect?.cleanup?.())
  }
  const render = (nextProps = props) => {
    props = nextProps
    if (name === 'status-bar') {
      host ??= fresh()
      host.index = 0
      tree = Component(props)
    } else {
      const next = Component(props)
      if (!wrapper || wrapper.key !== next.key) { unmount(); host = fresh() }
      wrapper = next
      host.index = 0
      tree = next.type(next.props)
    }
    const pending = host.pending.splice(0)
    pending.forEach((commit) => commit())
    return tree
  }
  render()
  return { calls, render, unmount, get tree() { return tree } }
}

function text(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return String(node)
  if (Array.isArray(node)) return node.map(text).join(' ').replace(/\s+/g, ' ').trim()
  return text(node.props.children)
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) return node.map((n) => find(n, predicate)).find(Boolean)
  return predicate(node) ? node : find(node.props.children, predicate)
}
function click(h, label) {
  const button = find(h.tree, (n) => n.type === 'button' && text(n) === label)
  assert.ok(button, `Missing button ${label}: ${text(h.tree)}`)
  button.props.onClick()
  h.render()
}
const settle = async (h) => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  h.render()
}
function respond(call, status, data) {
  call.resolve({ status, ok: status >= 200 && status < 300, json: async () => data })
}
const artifact = (discipline, title) => ({ discipline, title, summary: '', fidelity: 'generated plan', sections: [{ title: 'Plan', items: ['Synthetic item'] }] })
const board = { ok: true, components: 3, boardMm: { w: 10, h: 20 }, drc: { available: false, errors: 0 } }

test('discipline identity clears saved output, aborts reads, and retries GET only', async () => {
  const h = setup('discipline-stage', 'DisciplineStage', { runId: 'a', discipline: 'firmware', spec: {} })
  assert.match(text(h.tree), /Loading saved artifact/)
  assert.equal(h.calls.length, 1)
  respond(h.calls[0], 200, artifact('firmware', 'Run A secret'))
  await settle(h)
  assert.match(text(h.tree), /Run A secret/)
  h.render({ runId: 'b', discipline: 'manufacturing', spec: {} })
  assert.ok(h.calls[0].options.signal.aborted)
  assert.doesNotMatch(text(h.tree), /Run A secret/)
  respond(h.calls[1], 404)
  await settle(h)
  assert.match(text(h.tree), /No saved manufacturing artifact/)
  click(h, 'Retry loading artifact')
  assert.equal(h.calls[2].options.method, undefined)
  h.calls[2].reject(new Error('offline'))
  await settle(h)
  assert.match(text(h.tree), /offline/)
  h.unmount()
})

test('late discipline generation cannot invoke onBuilt after selection changes', async () => {
  let built = 0
  const h = setup('discipline-stage', 'DisciplineStage', { runId: 'a', discipline: 'firmware', spec: {}, onBuilt: () => built++ })
  click(h, 'Generate firmware')
  assert.ok(h.calls[0].options.signal.aborted)
  const generation = h.calls[1]
  assert.equal(generation.options.method, 'POST')
  assert.equal(generation.options.signal, undefined, 'closing a view is not generation cancellation')
  h.render({ runId: 'b', discipline: 'firmware', spec: {} })
  respond(generation, 200, { artifact: artifact('firmware', 'Late result') })
  respond(h.calls[0], 200, artifact('firmware', 'Late read'))
  await settle(h)
  assert.equal(built, 0)
  assert.doesNotMatch(text(h.tree), /Late result|Late read/)
  h.unmount()
})

test('current explicit generation succeeds once and rejects malformed artifacts', async () => {
  let built = 0
  const h = setup('discipline-stage', 'DisciplineStage', { runId: 'a', discipline: 'firmware', spec: {}, onBuilt: () => built++ })
  click(h, 'Generate firmware')
  respond(h.calls[1], 200, { artifact: artifact('firmware', 'Generated output') })
  await settle(h)
  assert.equal(built, 1)
  assert.match(text(h.tree), /Generated output/)
  respond(h.calls[0], 200, artifact('firmware', 'Obsolete persisted output'))
  await settle(h)
  assert.doesNotMatch(text(h.tree), /Obsolete persisted output/)
  click(h, 'Regenerate')
  respond(h.calls[2], 200, { artifact: { sections: [{}] } })
  await settle(h)
  assert.match(text(h.tree), /generated artifact is invalid/)
  assert.equal(built, 1)
  h.unmount()
})

test('chip-scale loading never generates and unverified board never reports clean', async () => {
  const h = setup('chipscale-stage', 'ChipScaleStage', { runId: 'a', spec: {} })
  assert.match(text(h.tree), /Loading saved board/)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].options.method, undefined)
  respond(h.calls[0], 200, board)
  await settle(h)
  click(h, 'Report')
  assert.match(text(h.tree), /unverified/)
  assert.doesNotMatch(text(h.tree), /routed clean/)
  h.render({ runId: 'b', spec: {} })
  assert.doesNotMatch(text(h.tree), /unverified/)
  respond(h.calls[1], 503)
  await settle(h)
  assert.match(text(h.tree), /Could not load board/)
  click(h, 'Retry loading board')
  respond(h.calls[2], 404)
  await settle(h)
  assert.match(text(h.tree), /No saved chip-scale board/)
  h.unmount()
})

test('obsolete chip-scale generation is ignored and a missing run resets output', async () => {
  const h = setup('chipscale-stage', 'ChipScaleStage', { runId: 'a', spec: {} })
  click(h, 'Generate chip-scale board')
  assert.deepEqual(JSON.parse(h.calls[1].options.body), { spec: {}, runId: 'a', keepCapabilities: false })
  assert.ok(h.calls[0].options.signal.aborted)
  h.render({ runId: undefined, spec: null })
  respond(h.calls[1], 200, board)
  await settle(h)
  assert.doesNotMatch(text(h.tree), /Regenerate|PCBA|Report/)
  assert.equal(h.calls.length, 2)
  h.unmount()
})

test('pipeline generation guard preserves loaded discipline output and permits read retries', async () => {
  const props = { runId: 'a', discipline: 'firmware', spec: {}, generationDisabled: true }
  const h = setup('discipline-stage', 'DisciplineStage', props)
  const button = find(h.tree, (n) => n.type === 'button' && text(n) === 'Generate firmware')
  assert.equal(button.props.disabled, true)
  click(h, 'Generate firmware') // Invoke handler despite disabled DOM control.
  assert.equal(h.calls.length, 1)
  respond(h.calls[0], 404)
  await settle(h)
  click(h, 'Retry loading artifact')
  assert.equal(h.calls.length, 2)
  respond(h.calls[1], 200, artifact('firmware', 'Available during pipeline'))
  await settle(h)
  h.render({ ...props, generationDisabled: false })
  assert.match(text(h.tree), /Available during pipeline/)
  assert.equal(h.calls.length, 2, 'guard changes must not reset the artifact')
  click(h, 'Regenerate')
  assert.equal(h.calls[2].options.method, 'POST')
  h.unmount()
})

test('pipeline guard blocks chip-scale generate and capability rebuild without hiding report', async () => {
  const h = setup('chipscale-stage', 'ChipScaleStage', { runId: 'a', spec: {}, generationDisabled: true })
  assert.equal(find(h.tree, (n) => n.type === 'button' && text(n) === 'Generate chip-scale board').props.disabled, true)
  click(h, 'Generate chip-scale board')
  assert.equal(h.calls.length, 1)
  respond(h.calls[0], 200, { ...board, drc: { available: true, errors: 0 },
    drcRepair: { iterations: [], designConvergence: { droppedCapabilities: ['radio'] } } })
  await settle(h)
  click(h, 'Report')
  const rebuild = find(h.tree, (n) => n.type === 'button' && text(n) === 'Rebuild keeping it (larger board) →')
  assert.equal(rebuild.props.disabled, true)
  click(h, 'Rebuild keeping it (larger board) →')
  click(h, 'Regenerate')
  assert.equal(h.calls.length, 1)
  assert.match(text(h.tree), /routed clean/)
  h.unmount()
})

test('chip-scale explicit attempts invalidate parent facts at start and settlement only while current', async () => {
  let starts = 0
  let finishes = 0
  const props = { runId: 'a', spec: {},
    onBuildStart: () => { starts++; assert.equal(h.calls.length, starts, 'start precedes each POST') },
    onBuilt: () => finishes++,
  }
  const h = setup('chipscale-stage', 'ChipScaleStage', props)
  assert.equal(starts, 0, 'persisted artifact reads never signal generation')
  click(h, 'Generate chip-scale board')
  assert.equal(starts, 1)
  respond(h.calls[1], 503, { error: 'Synthetic failure' })
  await settle(h)
  assert.equal(finishes, 1, 'failure still invalidates parent facts')
  click(h, 'Retry generation')
  respond(h.calls[2], 200, board)
  await settle(h)
  assert.equal(finishes, 2)
  click(h, 'Regenerate')
  h.render({ runId: 'b', spec: {} })
  respond(h.calls[3], 200, board)
  await settle(h)
  assert.equal(starts, 3)
  assert.equal(finishes, 2, 'obsolete completion cannot refresh a different run')
  h.unmount()
})

test('chip-scale generation retry preserves explicit keep-capabilities option', async () => {
  const h = setup('chipscale-stage', 'ChipScaleStage', { runId: 'a', spec: {} })
  respond(h.calls[0], 200, { ...board, drc: { available: true, errors: 0 },
    drcRepair: { iterations: [], designConvergence: { droppedCapabilities: ['radio'] } } })
  await settle(h)
  click(h, 'Report')
  click(h, 'Rebuild keeping it (larger board) →')
  assert.equal(JSON.parse(h.calls[1].options.body).keepCapabilities, true)
  respond(h.calls[1], 500, { error: 'Synthetic failure' })
  await settle(h)
  assert.match(text(h.tree), /Synthetic failure/)
  click(h, 'Retry generation')
  assert.equal(JSON.parse(h.calls[2].options.body).keepCapabilities, true)
  h.unmount()
})

test('overview ignores late old-run success and stage status changes trigger a fresh read', async () => {
  const h = setup('run-overview', 'RunOverview', { runId: 'a' })
  const oldCalls = [...h.calls]
  h.render({ runId: 'b', run: { stages: [{ id: 'electronics', state: 'running' }] } })
  for (const call of oldCalls) respond(call, 200, { prompt: 'Obsolete prompt', status: 'PASSED' })
  await settle(h)
  assert.doesNotMatch(text(h.tree), /Obsolete prompt/)
  assert.match(text(h.tree), /Loading overview artifacts/)
  h.render({ runId: 'b', run: { stages: [{ id: 'electronics', state: 'passed' }] } })
  assert.equal(h.calls.length, 33)
  assert.ok(h.calls.slice(11, 22).every((call) => call.options.signal.aborted))
  h.unmount()
})

test('overview refreshKey remounts stale state, aborts old reads, and does not loop', async () => {
  const h = setup('run-overview', 'RunOverview', { runId: 'a', refreshKey: 'pending' })
  assert.equal(h.calls.length, 11)
  for (const call of h.calls) respond(call, call.url.endsWith('last-run.json') ? 200 : 404,
    { prompt: 'Previous run prompt', status: 'PASSED' })
  await settle(h)
  assert.match(text(h.tree), /Previous run prompt/)
  h.render({ runId: 'a', refreshKey: 'passed' })
  assert.equal(h.calls.length, 22)
  assert.ok(h.calls.slice(0, 11).every((c) => c.options.signal.aborted))
  assert.doesNotMatch(text(h.tree), /Previous run prompt/)
  assert.match(text(h.tree), /Loading overview artifacts/)
  h.render({ runId: 'a', refreshKey: 'passed' })
  assert.equal(h.calls.length, 22)
  for (const call of h.calls.slice(11)) respond(call, 404)
  await settle(h)
  assert.match(text(h.tree), /No overview artifacts/)
  click(h, 'Retry loading overview')
  assert.equal(h.calls.length, 33)
  assert.ok(h.calls.every((c) => c.options.method === undefined))
  h.unmount()
})

test('overview distinguishes partial read errors from missing data and suppresses false legacy pass', async () => {
  const h = setup('run-overview', 'RunOverview', { runId: 'a' })
  for (const call of h.calls) {
    if (call.url.includes('chipscale-board')) call.reject(new Error('offline'))
    else respond(call, call.url.endsWith('last-run.json') ? 200 : 404, { status: 'PASSED', prompt: 'Partial run' })
  }
  await settle(h)
  assert.match(text(h.tree), /Partial overview/)
  assert.match(text(h.tree), /needs review/)
  assert.match(text(h.tree), /Could not load chipscale/)
  assert.doesNotMatch(text(h.tree), /clean build/)
  h.render({ runId: 'b' })
  assert.doesNotMatch(text(h.tree), /Partial run/)
  h.unmount()
})

test('all status unions retain truthful words, never false done for pending or skipped', () => {
  const cases = [
    [['pending', 'pending'], 'Build incomplete'],
    [['skipped', 'skipped'], 'Stages skipped'],
    [['passed', 'pending'], 'Build incomplete'],
    [['passed', 'skipped'], 'Build finished with skipped stages'],
    [['passed', 'failed'], 'Build needs attention'],
    [['failed', 'pending'], 'Build needs attention'],
    [['blocked', 'pending'], 'Build needs attention'],
    [['passed', 'passed'], 'Build finished'],
    [['running', 'skipped'], 'Build in progress · 1/2'],
    [['passed', 'unknown'], 'Build outcome unknown'],
  ]
  for (const [statuses, expected] of cases) {
    const h = setup('status-bar', 'StatusBar', { runId: 'a', pipeline: Object.fromEntries(statuses.map((status, i) => [i, { status }])) })
    assert.ok(text(h.tree).includes(expected), `${statuses}: ${text(h.tree)}`)
    assert.doesNotMatch(text(h.tree), /pipeline done|clean/)
    for (const status of new Set(statuses)) if (status !== 'running') {
      assert.ok(text(h.tree).includes(`${statuses.filter(value => value === status).length} ${status}`), `${status} count must remain visible`)
    }
    if (statuses.some(status => ['pending', 'failed', 'blocked', 'unknown'].includes(status))) assert.doesNotMatch(text(h.tree), /Build finished/)
    h.unmount()
  }
})
