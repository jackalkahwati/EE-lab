import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

// Only these client source files are evaluated. Imports, effects, storage and
// fetch are stubbed: this test cannot load server modules, APIs or run artifacts.
const FILES = new Set([
  'components/top-nav.tsx', 'components/programs/run-row.tsx',
  'components/model-selector.tsx', 'app/login/page.tsx',
  'components/command-palette.tsx', 'components/profile-menu.tsx',
  'components/llm-settings.tsx', 'components/run-history.tsx',
])
function harness(file, initial = [], options = {}) {
  assert.ok(FILES.has(file))
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  })
  assert.equal(compiled.diagnostics?.length ?? 0, 0, file)
  const state = [...initial]
  let cursor = 0
  const jsx = (type, props) => ({ type, props: props ?? {} })
  const parts = (name) => Object.fromEntries(['Root', 'Portal', 'Backdrop', 'Popup', 'Title', 'Description', 'Close', 'Trigger', 'Positioner'].map(p => [p, `${name}.${p}`]))
  const location = { href: '', search: '?next=%2Fcompose%3Frun%3Dfixture' }
  const storage = new Map()
  const modules = {
    react: {
      useState(value) {
        const index = cursor++
        if (!(index in state)) state[index] = typeof value === 'function' ? value() : value
        return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
      },
      useEffect() {}, useMemo: f => f(), useCallback: f => f,
      useRef: value => ({ current: value }), useId: () => 'fixture-field',
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'next/link': { default: 'a' },
    'next/navigation': { usePathname: () => options.path ?? '/compose', useRouter: () => ({ push: options.push ?? (() => {}) }) },
    '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') },
    '@/components/profile-menu': { ProfileMenu: 'ProfileMenu' },
    '@/components/llm-settings': { LS_MODEL: 'fl-model' },
    '@/components/programs/chips': { Chip: 'Chip', DisciplinesChip: 'DisciplinesChip', DrcChip: 'DrcChip', TimingChip: 'TimingChip' },
    '@/lib/start-draft': { readStartDraft: () => null, sessionDraftStorage: () => null, safeLoginNext: next => next },
    '@base-ui/react/dialog': { Dialog: parts('Dialog') },
    '@base-ui/react/popover': { Popover: parts('Popover') },
    'lucide-react': Object.fromEntries(['X', 'CircleUserRound', 'Settings', 'Zap', 'KeyRound', 'Check', 'Trash2', 'PanelLeftClose', 'PanelLeftOpen', 'CircuitBoard', 'GitBranch', 'Search'].map(n => [n, n])),
  }
  const exports = {}
  vm.runInNewContext(compiled.outputText, {
    exports, require(name) { assert.ok(name in modules, `Blocked import: ${name}`); return modules[name] },
    window: { location }, URLSearchParams, encodeURIComponent,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    fetch: options.fetch ?? (() => { throw new Error('Unstubbed fetch blocked') }),
    setTimeout: () => {},
  }, { filename: file })
  return { state, location, storage, render(name, props) { cursor = 0; return exports[name](props) } }
}
function nodes(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(n => nodes(n, predicate))
  if (!node || typeof node !== 'object') return []
  return [...(predicate(node) ? [node] : []), ...nodes(node.props?.children, predicate)]
}
const type = (tree, name) => nodes(tree, node => node.type === name)
const text = node => Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' && node ? text(node.props?.children) : node ?? ''

test('Programs has a canonical route and only exact route segments become current', () => {
  for (const [path, current] of [['/compose', 'Compose'], ['/enterprise/settings', 'Programs'], ['/programs/fixture', 'Programs'], ['/pricing', null], ['/enterprise-other', null]]) {
    const h = harness('components/top-nav.tsx', [true], { path })
    const links = type(h.render('TopNav'), 'a')
    assert.equal(links.find(n => text(n) === 'Programs').props.href, '/enterprise')
    assert.deepEqual(links.filter(n => n.props['aria-current']).map(text), current ? [current] : [])
  }
  assert.equal(type(harness('components/top-nav.tsx', [false]).render('TopNav'), 'a').some(n => text(n) === 'Programs'), false)
})

test('program run links encode the full directory identifier, not short id', () => {
  const h = harness('components/programs/run-row.tsx')
  const run = { dir: 'run fixture&second', shortId: 'short', links: [], disciplines: [] }
  const link = type(h.render('RunRow', { run }), 'a').find(n => text(n) === 'Open in Compose')
  assert.equal(link.props.href, '/compose?run=run%20fixture%26second')
})

test('model picker has an associated label, public plans link and unchanged locked options', () => {
  const h = harness('components/model-selector.tsx', [[{ id: 'locked', label: 'Restricted model', allowed: false, minPlan: 'pro' }], '', 'free'])
  const tree = h.render('ModelSelector')
  assert.equal(type(tree, 'label')[0].props.htmlFor, type(tree, 'select')[0].props.id)
  assert.equal(type(tree, 'a')[0].props.href, '/pricing')
  assert.equal(type(tree, 'option')[1].props.disabled, true)
  type(tree, 'select')[0].props.onChange({ target: { value: 'fixture' } })
  assert.equal(h.storage.get('fl-model'), 'fixture')
})

test('login rejection releases busy state and retains input for explicit retry', async () => {
  let calls = 0
  const h = harness('app/login/page.tsx', ['signin', 'fixture@example.test', 'synthetic-password', '', false], {
    fetch: async () => { calls++; if (calls === 1) throw new Error('synthetic offline'); return { ok: true } },
  })
  await type(h.render('default'), 'form')[0].props.onSubmit({ preventDefault() {} })
  assert.equal(h.state[4], false)
  assert.match(h.state[3], /Could not connect/)
  assert.equal(h.state[1], 'fixture@example.test')
  assert.equal(h.state[2], 'synthetic-password')
  assert.equal(h.location.href, '')
  await type(h.render('default'), 'form')[0].props.onSubmit({ preventDefault() {} })
  assert.equal(h.location.href, '/compose?run=fixture')
  assert.equal(h.state[4], false)
})

test('login HTTP rejection and invalid JSON are recoverable without clearing input', async () => {
  const h = harness('app/login/page.tsx', ['signup', 'fixture@example.test', 'synthetic-password', '', false], {
    fetch: async () => ({ ok: false, json: async () => { throw new Error('invalid json') } }),
  })
  await type(h.render('default'), 'form')[0].props.onSubmit({ preventDefault() {} })
  assert.equal(h.state[4], false)
  assert.match(h.state[3], /Please try again/)
  assert.equal(h.state[2], 'synthetic-password')
})

test('palette uses a named Base UI dialog with a labeled combobox and bounded empty selection', () => {
  const h = harness('components/command-palette.tsx', [true, 'no match fixture', null, 0, false])
  const tree = h.render('CommandPalette')
  assert.equal(type(tree, 'Dialog.Root').length, 1)
  assert.equal(type(tree, 'Dialog.Title').length, 1)
  assert.equal(type(tree, 'Dialog.Close')[0].props['aria-label'], 'Close search')
  const input = type(tree, 'input')[0]
  assert.equal(input.props.role, 'combobox')
  assert.equal(input.props['aria-controls'], type(tree, 'div').find(n => n.props.role === 'listbox').props.id)
  input.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} })
  assert.equal(h.state[3], 0)
  assert.equal(input.props['aria-activedescendant'], undefined)
})

test('palette and profile keep enterprise destinations out of non-enterprise navigation', () => {
  const palette = harness('components/command-palette.tsx', [true, '', null, 0, false]).render('CommandPalette')
  assert.doesNotMatch(text(palette), /Approvals|IAM|Budgets/)
  for (const [plan, href] of [['free', '/pricing'], ['enterprise', '/enterprise/settings']]) {
    const profile = harness('components/profile-menu.tsx', [{ email: 'fixture@example.test', plan, credits: 1 }, true]).render('ProfileMenu', {})
    assert.equal(type(profile, 'a')[0].props.href, href)
    assert.equal(type(profile, 'Popover.Title').length, 1)
    assert.equal(type(profile, 'Popover.Close').length, 1)
  }
})

test('provider popover labels sensitive inputs and groups storage scope without changing providers', () => {
  const tree = harness('components/llm-settings.tsx').render('LLMSettings')
  assert.equal(type(tree, 'Popover.Title').length, 1)
  assert.equal(type(tree, 'Popover.Close').length, 1)
  const inputs = [...type(tree, 'select'), ...type(tree, 'input').filter(n => n.props.type === 'password')]
  for (const input of inputs) assert.ok(type(tree, 'label').some(n => n.props.htmlFor === input.props.id))
  assert.equal(type(tree, 'fieldset').length, 1)
  assert.deepEqual(type(tree, 'option').map(n => n.props.value), ['', 'anthropic', 'openai', 'gemini', 'nemotron'])
})

test('run selection and delete are sibling native buttons; deleting does not select', () => {
  const calls = []
  const runs = ['one', 'two'].map(id => ({ id, name: id, status: 'PASSED', stages: [] }))
  const tree = harness('components/run-history.tsx').render('RunHistory', {
    runs, selectedId: 'one', collapsed: false, onSelect: id => calls.push(`select:${id}`), onDelete: id => calls.push(`delete:${id}`), onToggleCollapsed() {},
  })
  for (const button of type(tree, 'button')) assert.equal(type(button.props.children, 'button').length, 0)
  const deletion = type(tree, 'button').find(n => n.props['aria-label'] === 'Delete one')
  deletion.props.onClick()
  assert.deepEqual(calls, ['delete:one'])
  const selection = type(tree, 'button').find(n => n.props['aria-current'])
  assert.ok(selection)
  selection.props.onClick()
  assert.deepEqual(calls, ['delete:one', 'select:one'])
})
