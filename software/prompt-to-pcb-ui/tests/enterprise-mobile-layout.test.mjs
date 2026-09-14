import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

// Client-only structural/hook checks. No real API, storage or browser executes;
// actual 390px containment and keyboard scrolling require the browser harness.
const files = ['components/enterprise-sidebar.tsx', 'app/enterprise/layout.tsx', 'app/enterprise/settings/page.tsx']
const jsx = (type, props) => ({ type, props: props ?? {} })
const nodes = (node, predicate) => Array.isArray(node) ? node.flatMap(n => nodes(n, predicate))
  : !node || typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...nodes(node.props?.children, predicate)]
const text = node => Array.isArray(node) ? node.map(text).join('')
  : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
const classes = node => node.props.className ?? ''

function mount(file, { stored = null, denied = false, db = {} } = {}) {
  assert.ok(files.includes(file))
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  const slots = [], pending = [], writes = []
  let cursor = 0
  const modules = {
    react: {
      useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }] },
      useEffect(fn) { const index = cursor++; if (!(index in slots)) { slots[index] = true; pending.push(fn) } },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'next/link': { default: 'a' },
    'next/navigation': { usePathname: () => '/enterprise/settings' },
    '@/lib/utils': { cn: (...args) => args.filter(Boolean).join(' ') },
    '@/components/enterprise-sidebar': { EnterpriseSidebar: 'sidebar' },
    '@/components/enterprise-read-state': { useEnterpriseRead: () => ({ db, error: null, refresh() {} }), EnterpriseReadState: 'read-state' },
    'lucide-react': new Proxy({}, { get: (_, key) => String(key) }),
  }
  const exports = {}
  vm.runInNewContext(compiled, {
    exports,
    require(name) { assert.ok(Object.hasOwn(modules, name), `Blocked import: ${name}`); return modules[name] },
    localStorage: {
      getItem() { if (denied) throw new Error('Storage unavailable'); return stored },
      setItem(key, value) { if (denied) throw new Error('Storage unavailable'); writes.push([key, value]); stored = value },
    },
  })
  const component = exports.EnterpriseSidebar ?? exports.default
  const render = () => { cursor = 0; const tree = component({ children: 'content' }); while (pending.length) pending.shift()(); return tree }
  render()
  return { render, writes }
}

test('mobile navigation is a horizontal strip even when saved desktop labels are expanded', () => {
  const h = mount(files[0], { stored: '1' })
  let tree = h.render()
  assert.match(classes(tree), /\bw-full\b/)
  assert.match(classes(tree), /\boverflow-x-auto\b/)
  assert.match(classes(tree), /\bsm:flex-col\b/)
  assert.match(classes(tree), /\bsm:w-48\b/)
  assert.equal(classes(tree).split(' ').includes('w-48'), false)
  assert.equal(classes(tree).split(' ').includes('flex-col'), false)
  const links = nodes(tree, n => n.type === 'a')
  assert.equal(links.length, 11)
  assert.ok(links.every(link => link.props['aria-label'] && /shrink-0/.test(classes(link))))
  assert.equal(links.find(link => link.props['aria-current'])?.props.href, '/enterprise/settings')
  assert.ok(links.every(link => link.props.tabIndex === undefined), 'Native links stay keyboard reachable')
  nodes(tree, n => n.type === 'button')[0].props.onClick()
  tree = h.render()
  assert.match(classes(tree), /\bsm:w-14\b/)
  assert.equal(nodes(tree, n => n.type === 'button')[0].props['aria-expanded'], false)
  assert.deepEqual(h.writes, [['ent-sidebar-expanded', '0']])
})

test('storage denial does not prevent expanding mobile labels or selecting a section', () => {
  const h = mount(files[0], { denied: true })
  let tree = h.render()
  nodes(tree, n => n.type === 'button')[0].props.onClick()
  tree = h.render()
  assert.equal(nodes(tree, n => n.type === 'button')[0].props['aria-expanded'], true)
  assert.equal(nodes(tree, n => n.type === 'a' && n.props.href === '/enterprise/settings').length, 1)
  assert.match(classes(tree), /w-full/)
})

test('enterprise shell stacks navigation above full-width content below the desktop breakpoint', () => {
  const tree = mount(files[1]).render()
  assert.match(classes(tree), /\bflex-col\b/)
  assert.match(classes(tree), /\bsm:flex-row\b/)
  assert.match(classes(nodes(tree, n => n.type === 'main')[0]), /\bmin-w-0\b/)
})

test('Settings wraps headings, member grids, billing ledger and security identifiers without hiding content', () => {
  const db = {
    organizations: [{ name: 'Synthetic organization with a long name', plan: 'enterprise', security_settings: { demo: true } }],
    members: [{ actor: 'long-synthetic-member@example.invalid', role: 'workspace_admin' }],
    rbac: { roles: ['workspace_admin'], role_permissions: { workspace_admin: ['manage_members'] } },
    usage: [{ user: 'long-synthetic-member@example.invalid', usage_type: 'synthetic_type', credits: 3, timestamp: '2026-09-13T00:00:00Z' }],
    audit_tail: [{ action: 'SYNTHETIC_ACTION', actor: 'long-synthetic-member@example.invalid' }],
  }
  const h = mount(files[2], { db })
  let tree = h.render()
  const heading = nodes(tree, n => n.type === 'div' && nodes(n.props.children, child => child.type === 'h1').length && classes(n).includes('mb-4'))[0]
  assert.match(classes(heading), /flex-wrap/)
  assert.ok(nodes(tree, n => /lg:grid-cols-\[minmax\(0,1fr\)_360px\]/.test(classes(n))).length)
  for (const tab of ['Billing & Usage', 'Security']) {
    nodes(tree, n => n.type === 'button' && text(n) === tab)[0].props.onClick()
    tree = h.render()
    const rows = nodes(tree, n => n.type === 'div' && /flex-wrap/.test(classes(n)) && text(n).includes('long-synthetic-member@example.invalid'))
    assert.ok(rows.length, `${tab} identifiers must wrap inside their own rows`)
    assert.ok(nodes(tree, n => /\[overflow-wrap:anywhere\]/.test(classes(n))).length)
    assert.equal(nodes(tree, n => classes(n).split(' ').includes('overflow-hidden')).length, 0, 'Do not conceal overflow instead of reflowing')
  }
})
