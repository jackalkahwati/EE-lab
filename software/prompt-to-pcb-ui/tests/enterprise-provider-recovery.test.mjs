import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { promptFromFragment } from '../lib/start-draft.ts'

// Explicit client-only evaluation. No server modules, real fetch, browser storage,
// private artifacts or provider calls can be loaded by this harness.
const pages = ['approvals', 'quotes', 'validation', 'budgets', 'audit', 'integrations', 'iam']
const allowed = new Set([
  ...pages.map(name => `app/enterprise/${name}/page.tsx`),
  'app/enterprise/catalog/page.tsx', 'components/enterprise-sidebar.tsx', 'components/llm-settings.tsx',
])
const jsx = (type, props) => ({ type, props: props ?? {} })
const nodes = (node, predicate) => Array.isArray(node) ? node.flatMap(n => nodes(n, predicate))
  : !node || typeof node !== 'object' ? []
    : [...(predicate(node) ? [node] : []), ...nodes(node.props?.children, predicate)]
const ofType = (tree, type) => nodes(tree, n => n.type === type)
const text = node => Array.isArray(node) ? node.map(text).join('')
  : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const button = (tree, label) => ofType(tree, 'button').find(n => text(n) === label || n.props['aria-label'] === label)
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)) }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const accountKey = { provider: 'anthropic', last4: '1234', addedAt: '2026-09-13T00:00:00Z' }

function harness(file, options = {}) {
  assert.ok(allowed.has(file), `Blocked client file: ${file}`)
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  })
  assert.equal(compiled.diagnostics?.length ?? 0, 0)
  const slots = [], pending = [], timers = new Map(), calls = []
  const storage = new Map(options.storage ?? [])
  const storageApi = options.storageApi ?? {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  }
  let cursor = 0, timerId = 0
  const parts = Object.fromEntries(['Root', 'Portal', 'Popup', 'Title', 'Close', 'Trigger', 'Positioner'].map(p => [p, `Popover.${p}`]))
  const read = options.read ?? { db: {}, error: null, refresh() {} }
  const modules = {
    react: {
      useState(initial) {
        const index = cursor++
        if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
        return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value }]
      },
      useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
      useEffect(fn, deps) {
        const index = cursor++
        const old = slots[index]
        if (!old || !deps || deps.some((v, i) => !Object.is(v, old.deps[i]))) {
          pending.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: fn() } })
        }
      },
      useId: () => 'provider-test', useMemo: fn => fn(), useCallback: fn => fn,
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'next/link': { default: 'a' },
    'next/navigation': { usePathname: () => options.path ?? '/enterprise' },
    '@/lib/utils': { cn: (...args) => args.filter(Boolean).join(' ') },
    '@/components/enterprise-read-state': { useEnterpriseRead: () => read, EnterpriseReadState: 'EnterpriseReadState' },
    '@/lib/enterprise-actions': { currentActor: async () => 'synthetic@example.test', enterpriseAction: options.action ?? (() => { throw new Error('Unstubbed action blocked') }) },
    '@base-ui/react/popover': { Popover: parts },
    'lucide-react': Object.fromEntries(['KeyRound', 'Check', 'Trash2', 'X', 'Activity', 'BarChart3', 'Boxes', 'CheckSquare', 'Coins', 'LayoutDashboard', 'PanelLeftClose', 'PanelLeftOpen', 'Plug', 'Receipt', 'ScrollText', 'Settings', 'Users'].map(n => [n, n])),
  }
  const exports = {}
  const context = {
    exports, require(name) { assert.ok(name in modules, `Blocked import: ${name}`); return modules[name] },
    window: {}, localStorage: storageApi, AbortController,
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id },
    clearTimeout(id) { timers.delete(id) },
    fetch(url, init = {}) {
      calls.push({ url, init })
      assert.ok(options.fetch, `Unstubbed fetch blocked: ${url}`)
      return options.fetch(url, init)
    },
  }
  if (options.storageGetterDenied) Object.defineProperty(context, 'localStorage', { get() { throw new Error('Storage denied') } })
  vm.runInNewContext(compiled.outputText, context, { filename: file })
  const name = options.exportName ?? (file.endsWith('llm-settings.tsx') ? 'LLMSettings' : file.endsWith('enterprise-sidebar.tsx') ? 'EnterpriseSidebar' : 'default')
  return {
    exports, storage, calls, timers, read,
    render() { cursor = 0; const tree = exports[name](); while (pending.length) pending.shift()(); return tree },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
  }
}
function openProvider(h) {
  ofType(h.render(), 'Popover.Root')[0].props.onOpenChange(true)
  return h.render()
}
function draft(h, scope = 'account', value = 'synthetic-key-never-sent', provider = 'anthropic') {
  let tree = h.render()
  ofType(tree, 'select')[0].props.onChange({ target: { value: provider } })
  ofType(tree, 'input').find(n => n.props.type === 'password').props.onChange({ target: { value } })
  ofType(tree, 'input').filter(n => n.props.type === 'radio')[scope === 'account' ? 1 : 0].props.onChange()
  return h.render()
}
const secretInput = tree => ofType(tree, 'input').find(n => n.props.type === 'password')

for (const page of pages) {
  test(`${page} delegates loading/access/error to shared state and keeps empty reads usable`, () => {
    let refreshed = 0
    const read = { db: null, error: null, refresh: () => refreshed++ }
    const h = harness(`app/enterprise/${page}/page.tsx`, { read })
    for (const error of [null, { kind: 'auth', message: 'Sign in required' }, { kind: 'membership', message: 'Membership required' }, { kind: 'network', message: 'Offline' }]) {
      read.error = error
      const state = ofType(h.render(), 'EnterpriseReadState')[0]
      assert.equal(state.props.error, error)
      state.props.retry()
    }
    assert.equal(refreshed, 4)
    read.db = {}
    assert.equal(ofType(h.render(), 'EnterpriseReadState').length, 0)
    read.db = {
      organizations: [{ name: 'Synthetic org', integrations: { eda_connectors: [{ name: 'Synthetic connector', status: 'planned' }] } }],
      boards: [{ board_id: 'synthetic-board', name: 'Synthetic board', readiness: 'architecture_only' }],
      approvals: [{ approval_id: 'synthetic-approval', status: 'requested', scope: { board_id: 'synthetic-board' } }],
      quotes: [{ quote_id: 'synthetic-quote', board_id: 'synthetic-board', state: 'quote_packet_ready' }],
      validation_sessions: [{ session_id: 'synthetic-session', board_id: 'synthetic-board', status: 'planned' }],
      programs: [{ program_id: 'synthetic-program', name: 'Synthetic program', budget: { credits_allocated: 100, credits_consumed: 10 } }],
      audit_tail: [{ actor: 'synthetic@example.test', action: 'DENIED_fixture', note: 'Synthetic audit entry' }],
      audit_chain: { ok: true },
      members: [{ actor: 'synthetic@example.test', role: 'viewer' }],
      rbac: { roles: ['viewer'] },
    }
    const populated = h.render()
    assert.equal(ofType(populated, 'EnterpriseReadState').length, 0)
    assert.ok(ofType(populated, 'h1').length)
    h.unmount()
  })
}

test('sidebar labels every collapsed link, guards storage and matches route segments', () => {
  for (const [path, current] of [['/enterprise/audit', 'Audit'], ['/enterprise/iam/detail', 'IAM'], ['/enterprise/audit-extra', undefined]]) {
    const h = harness('components/enterprise-sidebar.tsx', { path, storageGetterDenied: true })
    let tree = h.render()
    assert.equal(ofType(tree, 'a').length, 11)
    assert.ok(ofType(tree, 'a').every(n => n.props['aria-label']))
    assert.equal(ofType(tree, 'a').find(n => n.props['aria-current'])?.props['aria-label'], current)
    button(tree, 'Expand sidebar').props.onClick()
    tree = h.render()
    assert.equal(button(tree, 'Collapse sidebar').props['aria-expanded'], true)
  }
})

test('IAM rejected member action retains email/role and clears only after successful explicit retry', async () => {
  let count = 0, refreshes = 0
  const h = harness('app/enterprise/iam/page.tsx', {
    read: { db: { rbac: { roles: ['viewer'] } }, error: null, refresh: () => refreshes++ },
    action: async (action, params) => {
      assert.equal(action, 'set_member_role')
      assert.equal(params.actor_name, 'synthetic@example.test')
      return ++count === 1 ? { error: 'permission denied' } : { ok: true }
    },
  })
  ofType(h.render(), 'input')[0].props.onChange({ target: { value: 'synthetic@example.test' } })
  await button(h.render(), 'Add').props.onClick()
  assert.equal(ofType(h.render(), 'input')[0].props.value, 'synthetic@example.test')
  assert.match(text(h.render()), /permission denied/)
  assert.equal(refreshes, 0)
  await button(h.render(), 'Add').props.onClick()
  assert.equal(ofType(h.render(), 'input')[0].props.value, '')
  assert.equal(refreshes, 1)
})

test('catalog template fragments use the existing private draft decoder without auto-submit', () => {
  const h = harness('app/enterprise/catalog/page.tsx', { fetch: async () => Response.json({ entries: [] }) })
  const links = ofType(h.render(), 'a')
  assert.equal(links.length, 8)
  for (const link of links) {
    const url = new URL(link.props.href, 'https://synthetic.invalid')
    assert.equal(url.pathname, '/start')
    assert.equal(url.search, '')
    assert.ok(promptFromFragment(url.hash))
    assert.equal(link.props.prefetch, false)
  }
  assert.match(text(h.render()), /Nothing is submitted/)
  h.unmount()
})

for (const [label, response, expected] of [
  ['missing', () => new Response('', { status: 404 }), /not available/],
  ['server failure', () => new Response('', { status: 500 }), /Could not load/],
  ['malformed', () => Response.json({ entries: [{}] }), /Could not load/],
  ['invalid JSON', () => new Response('not json'), /Could not load/],
  ['offline', () => { throw new Error('synthetic offline') }, /Could not load/],
]) {
  test(`catalog ${label} differs from loading/empty and supports retry`, async () => {
    let count = 0
    const h = harness('app/enterprise/catalog/page.tsx', { fetch: async () => ++count === 1 ? response() : Response.json({ entries: [] }) })
    assert.match(text(h.render()), /Loading capability registry/)
    await settle()
    assert.match(text(h.render()), expected)
    button(h.render(), 'Try again').props.onClick()
    h.render()
    assert.match(text(h.render()), /Loading capability registry/)
    await settle()
    assert.match(text(h.render()), /No capability families/)
    h.unmount()
  })
}

test('catalog preserves capability evidence states and ignores reads after unmount', async () => {
  const wait = deferred()
  const h = harness('app/enterprise/catalog/page.tsx', { fetch: () => wait.promise })
  h.render(); h.unmount()
  assert.equal(h.calls[0].init.signal.aborted, true)
  wait.resolve(Response.json({ entries: [{ family: 'Synthetic component', tier: 1, evidence_state: 'architecture_only' }] }))
  await settle()
  assert.doesNotMatch(text(h.render()), /Synthetic component/)
  const loaded = harness('app/enterprise/catalog/page.tsx', { fetch: async () => Response.json({ entries: [{ family: 'Synthetic component', tier: 1, evidence_state: 'architecture_only' }] }) })
  loaded.render(); await settle()
  assert.match(text(loaded.render()), /Synthetic componentarchitecture only/)
  loaded.unmount()
})

test('header helpers tolerate denied storage getters without inventing browser overrides', () => {
  const h = harness('components/llm-settings.tsx', { storageGetterDenied: true })
  assert.deepEqual(Object.keys(h.exports.llmHeaders()), [])
  assert.equal(h.exports.selectedModelId(), '')
  h.render()
  assert.match(text(h.render()), /Browser storage is unavailable/)
  assert.doesNotMatch(text(h.render()), /Browser settings saved/)
})

test('header helpers preserve browser provider/key/model routing and avoid partial key reads', () => {
  const h = harness('components/llm-settings.tsx', { storage: [['fl-llm-key', ' synthetic-key '], ['fl-llm-provider', ' openai '], ['fl-model', ' synthetic-model ']] })
  assert.equal(JSON.stringify(h.exports.llmHeaders()), JSON.stringify({ 'x-llm-key': 'synthetic-key', 'x-llm-provider': 'openai', 'x-fl-model': 'synthetic-model' }))
  const partial = harness('components/llm-settings.tsx', { storageApi: { getItem(name) { if (name === 'fl-llm-provider') throw new Error('denied'); return name === 'fl-llm-key' ? 'synthetic-key' : null } } })
  assert.deepEqual(Object.keys(partial.exports.llmHeaders()), [])
})

test('browser save denial keeps input and never claims saved or cleared; explicit retry verifies persistence', async () => {
  const storage = new Map([['fl-llm-provider', 'anthropic'], ['fl-llm-key', 'synthetic-old']])
  let denied = true
  const h = harness('components/llm-settings.tsx', { storageApi: {
    getItem: name => storage.get(name) ?? null,
    setItem(name, value) { if (denied) throw new Error('quota'); storage.set(name, value) },
    removeItem(name) { if (denied) throw new Error('denied'); storage.delete(name) },
  } })
  h.render()
  await button(draft(h, 'browser'), 'Save').props.onClick()
  assert.equal(secretInput(h.render()).props.value, 'synthetic-key-never-sent')
  assert.match(text(h.render()), /save could not be confirmed/)
  assert.doesNotMatch(text(h.render()), /Browser settings saved/)
  assert.equal(storage.get('fl-llm-key'), 'synthetic-old')
  denied = false
  await button(h.render(), 'Save').props.onClick()
  assert.match(text(h.render()), /Browser settings saved/)
  assert.equal(storage.get('fl-llm-key'), 'synthetic-key-never-sent')
  await button(draft(h, 'browser', ''), 'Save').props.onClick()
  assert.equal(storage.get('fl-llm-key'), '')
})

test('browser partial write rolls back the previous key/provider without claiming saved', async () => {
  const storage = new Map([['fl-llm-provider', 'anthropic'], ['fl-llm-key', 'synthetic-old']])
  const h = harness('components/llm-settings.tsx', { storageApi: {
    getItem: name => storage.get(name) ?? null,
    removeItem: name => storage.delete(name),
    setItem(name, value) { if (value === 'synthetic-new') throw new Error('quota'); storage.set(name, value) },
  } })
  h.render()
  await button(draft(h, 'browser', 'synthetic-new', 'openai'), 'Save').props.onClick()
  assert.equal(storage.get('fl-llm-provider'), 'anthropic')
  assert.equal(storage.get('fl-llm-key'), 'synthetic-old')
  assert.doesNotMatch(text(h.render()), /Browser settings saved/)
})

for (const [label, first] of [
  ['unauthenticated', () => new Response('', { status: 401 })],
  ['HTTP failure', () => new Response('', { status: 503 })],
  ['malformed', () => Response.json({})],
  ['network failure', () => { throw new Error('synthetic offline') }],
]) {
  test(`account read ${label} shows unknown state and recovers on explicit retry`, async () => {
    let count = 0
    const h = harness('components/llm-settings.tsx', { fetch: async () => ++count === 1 ? first() : Response.json({ key: accountKey }) })
    openProvider(h)
    assert.match(text(h.render()), /Checking account key/)
    await settle()
    assert.ok(button(h.render(), 'Try again'))
    assert.doesNotMatch(text(h.render()), /No account key saved/)
    button(h.render(), 'Try again').props.onClick(); h.render(); await settle()
    assert.match(text(h.render()), /Account key: anthropic/)
    assert.equal(h.calls.every(c => c.init.method === undefined && c.init.cache === 'no-store'), true)
    h.unmount()
  })
}

for (const action of ['save', 'remove']) {
  for (const failure of ['http', 'network', 'malformed']) {
    test(`account ${action} ${failure} keeps last known state/input and releases busy for retry`, async () => {
      let attempts = 0
      const h = harness('components/llm-settings.tsx', { fetch: async (_url, init) => {
        if (!init.method) return Response.json({ key: accountKey })
        assert.equal(init.method, action === 'save' ? 'PUT' : 'DELETE')
        if (init.method === 'PUT') assert.deepEqual(JSON.parse(init.body), { provider: 'anthropic', key: 'synthetic-key-never-sent' })
        if (++attempts === 1) {
          if (failure === 'network') throw new Error('synthetic offline')
          return failure === 'http' ? new Response('', { status: 500 }) : Response.json({})
        }
        return Response.json(action === 'save' ? { ok: true, key: { ...accountKey, last4: '5678' } } : { ok: true })
      } })
      openProvider(h); await settle()
      let tree = draft(h)
      await button(tree, action === 'save' ? 'Save' : 'Remove account key').props.onClick()
      tree = h.render()
      assert.equal(secretInput(tree).props.value, 'synthetic-key-never-sent')
      assert.match(text(tree), /Account key: anthropic.*1234/)
      assert.match(text(tree), /Could not confirm account key/)
      assert.doesNotMatch(text(tree), /No account key saved|Account key saved\./)
      assert.equal(button(tree, 'Save').props.disabled, false)
      await button(tree, action === 'save' ? 'Save' : 'Remove account key').props.onClick()
      tree = h.render()
      if (action === 'save') {
        assert.equal(secretInput(tree).props.value, '')
        assert.match(text(tree), /5678/)
        assert.match(text(tree), /Account key saved\./)
      } else {
        assert.equal(secretInput(tree).props.value, 'synthetic-key-never-sent')
        assert.match(text(tree), /No account key saved/)
      }
      h.unmount()
    })
  }
}

test('account pending mutation blocks repeat submissions, fields, scope and stale GET installation', async () => {
  const get = deferred(), put = deferred()
  const h = harness('components/llm-settings.tsx', { fetch: (_url, init) => init.method ? put.promise : get.promise })
  openProvider(h)
  const save = button(draft(h), 'Save').props.onClick
  const promise = save()
  await save()
  assert.equal(h.calls.length, 2)
  const busy = h.render()
  assert.equal(secretInput(busy).props.disabled, true)
  assert.equal(ofType(busy, 'select')[0].props.disabled, true)
  assert.equal(ofType(busy, 'fieldset')[0].props.disabled, true)
  assert.equal(button(busy, 'Saving…').props.disabled, true)
  put.resolve(Response.json({ ok: true, key: accountKey })); await promise
  get.resolve(Response.json({ key: null })); await settle()
  assert.match(text(h.render()), /Account key: anthropic/)
  assert.doesNotMatch(text(h.render()), /No account key saved/)
  h.unmount()
})

test('account close/reopen rejects old reads and unmount aborts pending mutation', async () => {
  const first = deferred(), second = deferred(), mutation = deferred()
  let reads = 0
  const h = harness('components/llm-settings.tsx', { fetch: (_url, init) => init.method ? mutation.promise : ++reads === 1 ? first.promise : second.promise })
  openProvider(h)
  ofType(h.render(), 'Popover.Root')[0].props.onOpenChange(false); h.render()
  openProvider(h)
  second.resolve(Response.json({ key: accountKey })); await settle()
  first.resolve(Response.json({ key: null })); await settle()
  assert.match(text(h.render()), /Account key: anthropic/)
  const promise = button(draft(h), 'Save').props.onClick()
  h.unmount()
  assert.equal(h.calls.at(-1).init.signal.aborted, true)
  mutation.resolve(Response.json({ ok: true, key: { ...accountKey, last4: '9999' } })); await promise
  assert.equal(secretInput(h.render()).props.value, 'synthetic-key-never-sent')
  assert.doesNotMatch(text(h.render()), /9999/)
})

for (const action of ['save', 'remove']) {
  test(`account ${action} timeout retains key/input and releases busy`, async () => {
    const h = harness('components/llm-settings.tsx', { fetch: (_url, { method, signal }) => method
      ? new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
      : Promise.resolve(Response.json({ key: accountKey })) })
    openProvider(h); await settle()
    const tree = draft(h)
    const promise = button(tree, action === 'save' ? 'Save' : 'Remove account key').props.onClick()
    for (const timer of h.timers.values()) timer()
    await promise
    assert.equal(secretInput(h.render()).props.value, 'synthetic-key-never-sent')
    assert.match(text(h.render()), /Account key: anthropic.*1234/)
    assert.match(text(h.render()), /Could not confirm/)
    assert.equal(button(h.render(), 'Save').props.disabled, false)
    h.unmount()
  })
}

test('account empty input never submits a PUT or pretends to clear a stored key', async () => {
  const h = harness('components/llm-settings.tsx', { fetch: async () => Response.json({ key: accountKey }) })
  openProvider(h); await settle()
  await button(draft(h, 'account', ''), 'Save').props.onClick()
  assert.equal(h.calls.length, 1)
  assert.match(text(h.render()), /Enter a key to save/)
  assert.match(text(h.render()), /Account key: anthropic/)
  h.unmount()
})

test('account read timeout is recoverable rather than an indefinite spinner', async () => {
  const h = harness('components/llm-settings.tsx', { fetch: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) })
  openProvider(h)
  for (const timer of h.timers.values()) timer()
  await settle()
  assert.match(text(h.render()), /lookup timed out/)
  assert.doesNotMatch(text(h.render()), /Checking account key/)
  assert.ok(button(h.render(), 'Try again'))
  h.unmount()
})
