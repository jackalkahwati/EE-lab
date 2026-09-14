import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

// Evaluate only the picker source. React, the catalog and storage are synthetic;
// no browser, server imports, credentials, run artifacts or real fetch are used.
const source = fs.readFileSync(new URL('../components/model-selector.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
})
assert.equal(compiled.diagnostics?.length ?? 0, 0)

const KEY = 'synthetic-model-key'
const catalog = [
  { id: 'saved', label: 'Saved model', allowed: true, minPlan: 'free', creditMult: 1 },
  { id: 'other', label: 'Other model', allowed: true, minPlan: 'free', creditMult: 1 },
  { id: 'locked', label: 'Locked model', allowed: false, minPlan: 'enterprise', creditMult: 2 },
]

function harness(initial = null, failures = {}) {
  const state = []
  const effects = []
  const storage = new Map(initial === null ? [] : [[KEY, initial]])
  const calls = []
  let cursor = 0
  let mounted = false
  let fetches = 0
  let beforePersist = () => {}
  const jsx = (type, props) => ({ type, props: props ?? {} })
  const modules = {
    react: {
      useId: () => 'synthetic-model-picker',
      useState(initialValue) {
        const index = cursor++
        if (!(index in state)) state[index] = initialValue
        return [state[index], value => { state[index] = value }]
      },
      useEffect(effect) { if (!mounted) effects.push(effect) },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@/components/llm-settings': { LS_MODEL: KEY },
  }
  function check(method) {
    calls.push(method)
    if (failures[method]) throw new Error(`Synthetic ${method} denial`)
  }
  const methods = {
    getItem(key) { assert.equal(key, KEY); check('getItem'); return storage.get(key) ?? null },
    setItem(key, value) {
      assert.equal(key, KEY)
      beforePersist()
      check('setItem')
      storage.set(key, value)
    },
    removeItem(key) {
      assert.equal(key, KEY)
      beforePersist()
      check('removeItem')
      storage.delete(key)
    },
  }
  const exports = {}
  const sandbox = {
    exports,
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `Blocked import: ${name}`)
      return modules[name]
    },
    fetch: async url => {
      assert.equal(url, '/api/auth/me')
      fetches++
      return { json: async () => ({ models: catalog, user: { plan: 'pro' } }) }
    },
  }
  Object.defineProperty(sandbox, 'localStorage', {
    get() { check('getter'); return methods },
  })
  vm.runInNewContext(compiled.outputText, sandbox, { filename: 'model-selector.tsx' })
  function render() {
    cursor = 0
    const tree = exports.ModelSelector()
    mounted = true
    return tree
  }
  return {
    storage, calls, failures, render,
    get fetches() { return fetches },
    set beforePersist(callback) { beforePersist = callback },
    async mount() {
      assert.equal(render(), null, 'the picker waits for its catalog')
      for (const effect of effects) assert.doesNotThrow(effect)
      await new Promise(resolve => setImmediate(resolve))
      return render()
    },
    pick(value) {
      const select = nodes(render(), node => node.type === 'select')[0]
      assert.doesNotThrow(() => select.props.onChange({ target: { value } }))
      return render()
    },
  }
}

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(node => nodes(node, predicate))
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)]
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('')
  return tree && typeof tree === 'object' ? text(tree.props?.children) : tree ?? ''
}
const select = tree => nodes(tree, node => node.type === 'select')[0]
const note = tree => nodes(tree, node => node.props.role === 'status')[0]
function assertNote(tree, pattern) {
  assert.match(text(note(tree)), pattern)
  assert.equal(select(tree).props['aria-describedby'], note(tree).props.id)
}

for (const [initial, expected] of [[null, ''], ['', ''], ['   ', ''], [' saved ', 'saved']]) {
  test(`normal storage read ${JSON.stringify(initial)} restores the persisted selection`, async () => {
    const h = harness(initial)
    const tree = await h.mount()
    assert.equal(select(tree).props.value, expected)
    assert.equal(note(tree), undefined)
    assert.equal(h.fetches, 1)
    assert.deepEqual(h.calls, ['getter', 'getItem'])
    assert.match(text(tree), /Auto \(pro default\)/)
    assert.equal(nodes(tree, node => node.type === 'option' && node.props.value === 'locked')[0].props.disabled, true)
  })
}

test('save and reset persist before updating the displayed selection', async () => {
  const h = harness('saved')
  await h.mount()
  h.beforePersist = () => assert.equal(select(h.render()).props.value, 'saved')
  let tree = h.pick('other')
  assert.equal(h.storage.get(KEY), 'other')
  assert.equal(select(tree).props.value, 'other')
  assert.equal(note(tree), undefined)
  h.beforePersist = () => assert.equal(select(h.render()).props.value, 'other')
  tree = h.pick('')
  assert.equal(h.storage.has(KEY), false)
  assert.equal(select(tree).props.value, '')
  assert.equal(note(tree), undefined)
})

for (const failure of ['getter', 'getItem']) {
  test(`${failure} denial does not crash mount or prevent the catalog and storage note`, async () => {
    const h = harness('saved', { [failure]: true })
    const tree = await h.mount()
    assert.equal(h.fetches, 1)
    assert.equal(select(tree).props.value, '')
    assertNote(tree, /Browser storage unavailable.*Showing Auto.*could not be read/)
    assert.equal(h.storage.get(KEY), 'saved', 'a failed read never clears storage')
  })
}

for (const choice of ['other', '']) {
  const method = choice ? 'setItem' : 'removeItem'
  test(`${method} failure restores the actual saved choice, not stale component state`, async () => {
    const h = harness('other')
    await h.mount()
    h.storage.set(KEY, ' saved ')
    h.failures[method] = true
    const tree = h.pick(choice)
    assert.equal(select(tree).props.value, 'saved')
    assert.equal(h.storage.get(KEY), ' saved ')
    assertNote(tree, /Model choice not saved.*showing the saved selection/)
    assert.deepEqual(h.calls.slice(-4), ['getter', method, 'getter', 'getItem'])
    h.failures[method] = false
    const recovered = h.pick(choice)
    assert.equal(select(recovered).props.value, choice)
    assert.equal(h.storage.get(KEY) ?? '', choice)
    assert.equal(note(recovered), undefined, 'successful persistence clears the warning')
    assert.equal(select(recovered).props['aria-describedby'], undefined)
  })

  test(`${method} failure with an unreadable saved choice falls back to Auto`, async () => {
    const h = harness('saved')
    await h.mount()
    h.failures[method] = true
    h.failures.getItem = true
    const tree = h.pick(choice)
    assert.equal(select(tree).props.value, '')
    assert.equal(h.storage.get(KEY), 'saved')
    assertNote(tree, /Model choice not saved.*storage unavailable.*showing Auto.*could not be read/)
  })

  test(`storage getter denial while picking ${JSON.stringify(choice)} cannot claim a saved change`, async () => {
    const h = harness('saved')
    await h.mount()
    h.failures.getter = true
    const tree = h.pick(choice)
    assert.equal(select(tree).props.value, '')
    assert.equal(h.storage.get(KEY), 'saved')
    assertNote(tree, /Model choice not saved.*storage unavailable.*showing Auto/)
    assert.deepEqual(h.calls.slice(-2), ['getter', 'getter'])
  })
}

test('failed write preserves Auto when no model was previously persisted', async () => {
  const h = harness(null, { setItem: true })
  await h.mount()
  const tree = h.pick('other')
  assert.equal(select(tree).props.value, '')
  assert.equal(h.storage.has(KEY), false)
  assertNote(tree, /Model choice not saved.*showing the saved selection/)
})

test('storage can recover after initial denial without remounting', async () => {
  const h = harness('saved', { getter: true })
  await h.mount()
  h.failures.getter = false
  const tree = h.pick('other')
  assert.equal(h.storage.get(KEY), 'other')
  assert.equal(select(tree).props.value, 'other')
  assert.equal(note(tree), undefined)
})
