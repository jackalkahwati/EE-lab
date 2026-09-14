import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { boardVerdict } from '../lib/verdict.ts'
import { workspaceProgress } from '../lib/workspace-state.ts'

// Safety: only these six owned client sources are transpiled in memory.
// Every runtime import is explicitly stubbed below. No app routes, stores,
// provider helpers, browser/network APIs, environment files, or subprocesses run.
// This small hook driver tests effect cleanup and callbacks, not browser layout.
const sources = new Map(['discipline-stage', 'chipscale-stage', 'mechanical-stage', 'simulation-stage', 'id-stage', 'id-stage-view'].map((name) => [name,
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
    '@/components/mechanical-assembly': { MechanicalAssembly: icon },
    '@/components/cad-viewer': { CadViewer: icon },
    '@/components/id-stage-view': { IdStageView: icon },
    '@/lib/product-spec': { boardIntentOf: () => 'Synthetic intent' },
    '@/components/id-scaffold': { IdScaffold: icon, ID_SCAFFOLD_SVG_ID: 'synthetic' },
    '@/components/board-schematic': { BoardSchematic: icon },
    '@/components/board-3d': { Board3D: 'board-3d' },
  }
  const exports = {}
  vm.runInNewContext(sources.get(name), {
    exports, AbortController,
    document: { getElementById: () => null },
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
    if (name === 'id-stage' || name === 'id-stage-view') {
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
  call.resolve({ status, ok: status >= 200 && status < 300, json: async () => data, text: async () => JSON.stringify(data) })
}
const artifact = (discipline, title) => ({ discipline, title, summary: '', fidelity: 'generated plan', sections: [{ title: 'Plan', items: ['Synthetic item'] }] })
const board = { ok: true, components: 3, boardMm: { w: 10, h: 20 }, drc: { available: false, errors: 0 } }
const stages = [
  ['chipscale-stage', 'ChipScaleStage', 'Generate chip-scale board', board],
  ['mechanical-stage', 'MechanicalStage', 'Generate enclosure', { ok: true, part: 'Synthetic enclosure' }],
  ['simulation-stage', 'SimulationStage', 'Run simulations', { results: [{ sim: 'synthetic', pass: true }] }],
  ['discipline-stage', 'DisciplineStage', 'Generate firmware', { artifact: artifact('firmware', 'Synthetic generated') }],
  ['id-stage', 'IdStage', 'Generate design brief', { type: 'brief', brief: { product: 'Synthetic brief' } }],
  ['id-stage-view', 'IdStageView', 'Generate render', { ok: true, url: '/runs/a/id/render.png' }],
]
for (const [name, component, label, response] of stages) {
  const base = { runId: 'a', spec: {}, discipline: 'firmware', brief: name === 'id-stage-view' ? { product: 'Synthetic' } : null }
  test(`${name}: deferred permission gates POST and settlement holds duplicate guard`, async () => {
    let allow, finish, starts = 0, completed = false
    const permission = new Promise(resolve => { allow = resolve })
    const persistence = new Promise(resolve => { finish = resolve })
    const outcomes = []
    const h = setup(name, component, { ...base, onBuildStart: () => { starts++; return permission }, onBuildSettled: async outcome => { outcomes.push(outcome); await persistence } })
    const handler = find(h.tree, n => n.type === 'button' && text(n) === label).props.onClick
    const operation = handler().then(() => { completed = true })
    handler(); await settle(h)
    assert.equal(starts, 1)
    assert.equal(h.calls.length, 1, 'generation waits for timing persistence')
    allow(true); await settle(h)
    assert.equal(h.calls.length, 2)
    respond(h.calls[1], 200, response); await settle(h)
    assert.equal(outcomes.length, 1)
    assert.equal(completed, false, 'handler waits for final persistence')
    handler(); await settle(h)
    assert.equal(starts, 1, 'settlement still owns local guard')
    h.unmount(); finish(); await operation
    assert.equal(completed, true)
  })
  test(`${name}: rejected and false async permission release owner without submission`, async () => {
    for (const rejects of [false, true]) {
      let starts = 0; const outcomes = []
      const h = setup(name, component, { ...base, onBuildStart: async () => { starts++; if (rejects) throw new Error('timing unavailable'); return false }, onBuildSettled: async outcome => outcomes.push(outcome) })
      const handler = find(h.tree, n => n.type === 'button' && text(n) === label).props.onClick
      await handler(); await settle(h)
      assert.equal(h.calls.length, 1)
      assert.equal(outcomes.length, 1)
      assert.equal(outcomes[0].status, 'unknown')
      assert.match(outcomes[0].detail, /not submitted/)
      await handler()
      assert.equal(starts, 2, 'failed start releases local guard')
      h.unmount()
    }
  })
  test(`${name}: central rejection never starts a request`, async () => {
    const h = setup(name, component, { ...base, onBuildStart: () => false })
    click(h, label); await settle(h)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].options.method, undefined)
    h.unmount()
  })
  test(`${name}: synchronous duplicate prevention and unmounted settlement retain owner`, async () => {
    const outcomes = []; let built = 0
    const h = setup(name, component, { ...base, onBuildStart: () => true, onBuildSettled: value => outcomes.push(value), onBuilt: () => built++ })
    const handler = find(h.tree, n => n.type === 'button' && text(n) === label).props.onClick
    handler(); handler(); await settle(h)
    assert.equal(h.calls.length, 2)
    assert.equal(h.calls[0].options.signal.aborted, true)
    h.unmount()
    respond(h.calls[1], 200, response)
    for (let i = 0; i < 12; i++) await Promise.resolve()
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].artifactAvailable, true)
    assert.equal(built, 0)
    if (name === 'chipscale-stage' || name === 'discipline-stage') assert.equal(outcomes[0].status, 'unknown')
  })
  test(`${name}: transport loss reports unknown, explicit service error reports failed`, async () => {
    for (const explicit of [false, true]) {
      const outcomes = []
      const h = setup(name, component, { ...base, onBuildSettled: value => outcomes.push(value) })
      click(h, label); await settle(h)
      if (explicit) respond(h.calls[1], 500, { ok: false, error: 'Synthetic failure', message: 'Synthetic failure' })
      else h.calls[1].reject(new Error('connection lost'))
      await settle(h)
      assert.equal(outcomes.length, 1)
      assert.equal(outcomes[0].status, explicit ? 'failed' : 'unknown')
      h.unmount()
    }
  })
}

test('PCB import writer array and unavailable dimensions render retained board, never invoke 3D export', async () => {
  for (const boardMm of [[40, 30], null]) {
    const h = setup('chipscale-stage', 'ChipScaleStage', { runId: 'a', spec: { imported: true } })
    respond(h.calls[0], 200, { boardMm, components: null, drc: null, boardSource: 'manual-import', imported: true, manualImport: { kind: 'pcb' } })
    await settle(h)
    assert.match(text(h.tree), /Imported PCB/)
    assert.doesNotMatch(text(h.tree), /artifact is invalid/)
    assert.ok(find(h.tree, n => n.type === 'a' && n.props.href === '/runs/a/variant.kicad_pcb'))
    assert.equal(h.calls.length, 1)
    assert.ok(!find(h.tree, n => n.type === 'board-3d'), 'no model child is mounted')
    h.unmount()
  }
})

test('STEP and Onshape import writer artifact exposes STEP without fabricated enclosure or fit', async () => {
  const h = setup('mechanical-stage', 'MechanicalStage', { runId: 'a', spec: { imported: true } })
  respond(h.calls[0], 200, { source: 'manual-import', imported: true, fitCheck: null, manualImport: { kind: 'step' } })
  await settle(h)
  assert.match(text(h.tree), /Imported CAD assembly/)
  assert.match(text(h.tree), /rendered preview and fit analysis are not available/)
  assert.ok(find(h.tree, n => n.type === 'a' && n.props.href === '/runs/a/mechanical/enclosure.step'))
  assert.doesNotMatch(text(h.tree), /approximate shell|PCB fits|artifact is invalid/)
  assert.equal(h.calls.length, 1)
  h.unmount()
})

test('mechanical fit failures and simulation gaps never become passed attempts', async () => {
  for (const [name, component, label, response, status] of [
    ['mechanical-stage', 'MechanicalStage', 'Generate enclosure', { ok: true, part: 'Synthetic', fitCheck: { fits: false, enclosureMm: { w: 1, h: 1 }, pcbMm: { w: 2, h: 2 } } }, 'failed'],
    ['simulation-stage', 'SimulationStage', 'Run simulations', { results: [{ sim: 'synthetic', pass: null }] }, 'unknown'],
    ['simulation-stage', 'SimulationStage', 'Run simulations', { results: [{ sim: 'synthetic', pass: false }] }, 'failed'],
  ]) {
    const outcomes = []
    const h = setup(name, component, { runId: 'a', spec: {}, onBuildSettled: outcome => outcomes.push(outcome) })
    click(h, label); respond(h.calls[1], 200, response); await settle(h)
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].status, status)
    assert.equal(outcomes[0].artifactAvailable, true)
    h.unmount()
  }
})

test('simulation late A read cannot populate B; missing/error retry remains read-only', async () => {
  const h = setup('simulation-stage', 'SimulationStage', { runId: 'a', spec: {} })
  h.render({ runId: 'b', spec: {} })
  assert.equal(h.calls[0].options.signal.aborted, true)
  respond(h.calls[0], 200, { results: [{ sim: 'Secret A' }] })
  respond(h.calls[1], 404, null); await settle(h)
  assert.doesNotMatch(text(h.tree), /Secret A/)
  assert.match(text(h.tree), /No saved simulation/)
  click(h, 'Retry loading simulation')
  assert.equal(h.calls[2].options.method, undefined)
  respond(h.calls[2], 200, { results: [null] }); await settle(h)
  assert.match(text(h.tree), /artifact is invalid/)
  h.unmount()
})
