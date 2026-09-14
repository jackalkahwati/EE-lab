import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Only these client sources run, transpiled in memory with every import allowed
// explicitly. Fetch and timers are intercepted. No routes, provider code, private
// artifacts, environment files, browser, subprocesses, or real network are used.
const sources = new Map(['simulation-stage', 'work-queue'].map(name => [name,
  ts.transpileModule(readFileSync(new URL(`../components/${name}.tsx`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText,
]))
const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
function setup(name, initialProps) {
  const calls = [], timers = new Map()
  let host, wrapper, tree, timerId = 0, staleWrites = 0
  const hooks = {
    useState(initial) {
      const owner = host, index = owner.index++
      if (!(index in owner.slots)) owner.slots[index] = typeof initial === 'function' ? initial() : initial
      return [owner.slots[index], next => {
        if (!owner.live) { staleWrites++; return }
        owner.slots[index] = typeof next === 'function' ? next(owner.slots[index]) : next
      }]
    },
    useRef(initial) {
      const index = host.index++
      if (!(index in host.slots)) host.slots[index] = { current: initial }
      return host.slots[index]
    },
    useEffect(fn, deps) {
      const owner = host, index = owner.index++, old = owner.effects[index]
      if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) {
        owner.pending.push(() => { old?.cleanup?.(); owner.effects[index] = { deps, cleanup: fn() } })
      }
    },
  }
  const imports = {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    '@/lib/utils': { cn: (...parts) => parts.filter(Boolean).join(' ') },
  }
  const exports = {}
  vm.runInNewContext(sources.get(name), {
    exports, AbortController, Error,
    require(id) { assert.ok(Object.hasOwn(imports, id), `Unsafe import: ${id}`); return imports[id] },
    fetch(url, options = {}) { return new Promise((resolve, reject) => calls.push({ url, options, resolve, reject })) },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
  })
  const Component = exports[name === 'simulation-stage' ? 'SimulationStage' : 'WorkQueue']
  let props = initialProps
  const unmount = () => {
    if (!host) return
    host.live = false
    host.effects.forEach(effect => effect?.cleanup?.())
  }
  const render = (nextProps = props) => {
    props = nextProps
    const next = Component(props)
    if (!next) { unmount(); host = undefined; wrapper = undefined; tree = null; return tree }
    if (!wrapper || wrapper.key !== next.key) {
      unmount()
      host = { index: 0, slots: [], effects: [], pending: [], live: true }
    }
    wrapper = next
    host.index = 0
    tree = next.type(next.props)
    host.pending.splice(0).forEach(commit => commit())
    return tree
  }
  render()
  return { calls, timers, render, unmount, get tree() { return tree }, get staleWrites() { return staleWrites } }
}
function text(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return String(node)
  if (Array.isArray(node)) return node.map(text).join(' ').replace(/\s+/g, ' ').trim()
  return text(node.props.children)
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean)
  return predicate(node) ? node : find(node.props.children, predicate)
}
function button(h, label) {
  const result = find(h.tree, n => n.type === 'button' && (text(n) === label || n.props['aria-label'] === label))
  assert.ok(result, `Missing ${label}: ${text(h.tree)}`)
  return result
}
function click(h, label) { button(h, label).props.onClick(); h.render() }
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
const settle = async h => { await flush(); h.render() }
const respond = (call, status, data) => call.resolve({ status, ok: status >= 200 && status < 300, json: async () => data })
const noFalseClearance = h => assert.doesNotMatch(text(h.tree), /No items reported|every flag the pipeline raised has been resolved/)
const item = (text = 'Synthetic thermal gap', severity = 'blocking') => ({ id: text, text, severity, source: 'synthetic.json', area: 'simulation' })

for (const assessments of [undefined, []]) {
  test(`simulation displays actual gaps without ${assessments ? 'populated' : 'present'} assessments`, async () => {
    const h = setup('simulation-stage', { runId: 'synthetic', spec: {} })
    respond(h.calls[0], 200, { results: [], assessment: { assessments, gaps: ['Thermal inputs unavailable', 'Drop solver unavailable'] } })
    await settle(h)
    assert.match(text(h.tree), /Application requirements/)
    assert.match(text(h.tree), /Thermal inputs unavailable/)
    assert.match(text(h.tree), /Drop solver unavailable/)
    assert.match(text(h.tree), /2 required check\(s\) could not run/)
    assert.match(text(h.tree), /No simulation results are available\. This is not a passing result/)
    assert.equal(h.calls.length, 1)
    h.unmount()
  })
}

test('simulation gaps coexist with passing metrics, applicable assessments, and unavailable outcomes', async () => {
  const outcomes = []
  const h = setup('simulation-stage', { runId: 'synthetic', spec: {}, onBuildSettled: result => outcomes.push(result) })
  click(h, 'Run simulations')
  respond(h.calls[1], 200, {
    results: [{ sim: 'thermal', pass: true }],
    assessment: {
      assessments: [
        { kind: 'thermal', applicability: 'required', verdict: 'pass', detail: 'Synthetic thermal pass' },
        { kind: 'rf', applicability: 'not_applicable', verdict: 'no_data', detail: 'Hidden inapplicable RF' },
      ],
      gaps: ['Required drop result unavailable'],
    },
  })
  await settle(h)
  assert.match(text(h.tree), /Synthetic thermal pass/)
  assert.match(text(h.tree), /Required drop result unavailable/)
  assert.doesNotMatch(text(h.tree), /Hidden inapplicable RF/)
  assert.equal(outcomes[0].status, 'unknown')
  assert.equal(outcomes[0].artifactAvailable, true)
  h.unmount()
})

for (const [description, data, status] of [
  ['empty results with gaps', { results: [], assessment: { gaps: ['No usable inputs'] } }, 'unknown'],
  ['empty results alone', { results: [] }, 'unknown'],
  ['unreported metric', { results: [{ sim: 'thermal', pass: null }] }, 'unknown'],
  ['explicit failed metric', { results: [{ sim: 'thermal', pass: false }] }, 'failed'],
  ['failed assessment', { results: [{ sim: 'thermal', pass: true }], assessment: { assessments: [{ kind: 'drop', applicability: 'required', verdict: 'fail', detail: 'Synthetic failure' }] } }, 'failed'],
  ['passing result', { results: [{ sim: 'thermal', pass: true }] }, 'passed'],
]) {
  test(`simulation preserves settlement for ${description}`, async () => {
    const outcomes = []
    const h = setup('simulation-stage', { runId: 'synthetic', spec: {}, onBuildSettled: result => outcomes.push(result) })
    click(h, 'Run simulations')
    respond(h.calls[1], 200, data)
    await settle(h)
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].status, status)
    assert.equal(outcomes[0].artifactAvailable, true)
    h.unmount()
  })
}

test('simulation rejects malformed gap payloads instead of crashing or passing', async () => {
  for (const gaps of ['missing', [null], [{}]]) {
    const h = setup('simulation-stage', { runId: 'synthetic', spec: {} })
    respond(h.calls[0], 200, { results: [], assessment: { gaps } })
    await settle(h)
    assert.match(text(h.tree), /saved simulation artifact is invalid/)
    assert.ok(find(h.tree, n => n.props.role === 'alert'))
    h.unmount()
  }
})

test('queue shows loading, only successful empty reads show qualified empty state', async () => {
  const h = setup('work-queue', {})
  assert.equal(h.tree, null)
  assert.equal(h.calls.length, 0)
  h.render({ runId: 'synthetic / a' })
  assert.match(text(h.tree), /Loading work queue/)
  noFalseClearance(h)
  assert.equal(button(h, 'Refresh work queue').props.disabled, true)
  assert.equal(h.calls[0].url, '/api/runs/work-items?run=synthetic%20%2F%20a')
  respond(h.calls[0], 200, { items: [] })
  await settle(h)
  assert.match(text(h.tree), /No items reported by the work queue/)
  assert.match(text(h.tree), /Coverage is incomplete; this does not mean every engineering flag is resolved/)
  assert.equal(h.timers.size, 0)
  assert.equal(h.calls.length, 1)
  h.unmount()
})

for (const failure of ['403', 'network', 'json', 'missing items', 'null item', 'invalid severity']) {
  test(`queue ${failure} is unavailable, with one read-only retry and no false clearance`, async () => {
    const h = setup('work-queue', { runId: 'synthetic' })
    if (failure === '403') respond(h.calls[0], 403, { error: 'Forbidden' })
    else if (failure === 'network') h.calls[0].reject(new Error('Synthetic connection loss'))
    else if (failure === 'json') h.calls[0].resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('Synthetic invalid JSON') } })
    else respond(h.calls[0], 200, failure === 'missing items' ? {} : { items: failure === 'null item' ? [null] : [item('Invalid severity', 'unknown')] })
    await settle(h)
    assert.match(text(h.tree), /Work queue unavailable; open items are unknown/)
    assert.ok(find(h.tree, n => n.props.role === 'alert'))
    noFalseClearance(h)
    assert.equal(h.calls.length, 1, 'no automatic retry')
    const retry = button(h, 'Retry loading work queue').props.onClick
    retry(); retry(); h.render()
    assert.equal(h.calls.length, 2, 'double click schedules only one retry')
    assert.match(text(h.tree), /Loading work queue/)
    noFalseClearance(h)
    assert.equal(h.calls[1].options.method, undefined)
    assert.equal(h.calls[1].options.body, undefined)
    respond(h.calls[1], 200, { items: [item()] })
    await settle(h)
    assert.match(text(h.tree), /Synthetic thermal gap/)
    assert.doesNotMatch(text(h.tree), /unavailable; open items are unknown/)
    assert.equal(h.timers.size, 0)
    h.unmount()
  })
}

test('queue times out once, allows a read retry, and ignores a late timed-out response', async () => {
  const h = setup('work-queue', { runId: 'synthetic' })
  const timer = [...h.timers.values()][0]
  assert.equal(timer.delay, 15_000)
  timer.fn(); h.render()
  assert.match(text(h.tree), /timed out/)
  assert.equal(h.calls[0].options.signal.aborted, true)
  noFalseClearance(h)
  click(h, 'Retry loading work queue')
  respond(h.calls[1], 200, { items: [item('Current item')] })
  await settle(h)
  respond(h.calls[0], 200, { items: [] })
  await settle(h)
  assert.match(text(h.tree), /Current item/)
  noFalseClearance(h)
  assert.equal(h.calls.length, 2)
  h.unmount()
})

test('queue run identity, unmount, and delayed JSON cannot leak old items or errors', async () => {
  for (const late of ['success', 'failure', 'json']) {
    const h = setup('work-queue', { runId: 'a' })
    let resolveJson
    if (late === 'json') {
      h.calls[0].resolve({ ok: true, json: () => new Promise(resolve => { resolveJson = resolve }) })
      await flush()
    }
    h.render({ runId: 'b' })
    assert.equal(h.calls[0].options.signal.aborted, true)
    assert.match(text(h.tree), /Loading work queue/)
    respond(h.calls[1], 200, { items: [item('Current B')] })
    await settle(h)
    if (late === 'failure') h.calls[0].reject(new Error('Old A error'))
    else if (late === 'json') resolveJson({ items: [item('Old A item')] })
    else respond(h.calls[0], 200, { items: [item('Old A item')] })
    await settle(h)
    assert.match(text(h.tree), /Current B/)
    assert.doesNotMatch(text(h.tree), /Old A/)
    click(h, 'Refresh work queue')
    h.render({})
    assert.equal(h.tree, null)
    assert.equal(h.calls[2].options.signal.aborted, true)
    respond(h.calls[2], 200, { items: [item('Unmounted B')] })
    await flush()
    assert.equal(h.staleWrites, 0)
    assert.equal(h.timers.size, 0)
  }
})

test('queue refresh removes obsolete items while loading and retains scoped chat resolution', async () => {
  const prompts = []
  const h = setup('work-queue', { runId: 'synthetic', onResolve: prompt => prompts.push(prompt) })
  respond(h.calls[0], 200, { items: [item('Advisory item', 'advisory'), item('Blocking item')] })
  await settle(h)
  assert.ok(text(h.tree).indexOf('Blocking item') < text(h.tree).indexOf('Advisory item'))
  find(h.tree, n => n.type === 'button' && n.props.title === 'resolve in chat').props.onClick()
  assert.deepEqual(prompts, ['Resolve this open item on the current design: Blocking item'])
  click(h, 'Refresh work queue')
  assert.doesNotMatch(text(h.tree), /Blocking item|Advisory item/)
  assert.match(text(h.tree), /Loading work queue/)
  respond(h.calls[1], 403, {})
  await settle(h)
  noFalseClearance(h)
  assert.doesNotMatch(text(h.tree), /Blocking item|Advisory item/)
  assert.equal(h.calls.length, 2)
  h.unmount()
})
