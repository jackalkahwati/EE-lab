import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Evaluate only the client explorer, in memory, with an allowlist of stubs.
// No routes, stores, browser, network, private artifacts, or subprocesses run.
// The keyed hook driver checks lifecycle/handlers, not browser layout or focus.
const compiled = ts.transpileModule(readFileSync(new URL('../components/artifact-explorer.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
})
assert.equal(compiled.diagnostics.length, 0)
const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
const icon = () => null

function setup(exportName, initialProps, { cachedImage } = {}) {
  const calls = []
  const timers = new Map()
  const instances = new Map()
  let host
  let timerId = 0
  let tree
  let props = initialProps
  let deadUpdates = 0
  const changed = (old, deps) => !old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))
  const memo = (fn, deps) => {
    const i = host.index++
    if (changed(host.slots[i], deps)) host.slots[i] = { deps, value: fn() }
    return host.slots[i].value
  }
  const hooks = {
    useState(initial) {
      const owner = host
      const i = owner.index++
      if (!(i in owner.slots)) owner.slots[i] = typeof initial === 'function' ? initial() : initial
      return [owner.slots[i], (next) => {
        if (!owner.live) { deadUpdates++; return }
        owner.slots[i] = typeof next === 'function' ? next(owner.slots[i]) : next
      }]
    },
    useRef(initial) {
      const i = host.index++
      if (!(i in host.slots)) host.slots[i] = { current: initial }
      return host.slots[i]
    },
    useMemo: memo,
    useCallback: (fn, deps) => memo(() => fn, deps),
    useEffect(fn, deps) {
      const owner = host
      const i = owner.index++
      const old = owner.effects[i]
      if (changed(old, deps)) owner.pending.push(() => {
        old?.cleanup?.()
        owner.effects[i] = { deps, cleanup: fn() }
      })
    },
  }
  const imports = {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': new Proxy({}, { get: () => icon }),
  }
  const exports = {}
  vm.runInNewContext(compiled.outputText, {
    exports, AbortController, TextDecoder, Error,
    require(id) { assert.ok(Object.hasOwn(imports, id), `Blocked import: ${id}`); return imports[id] },
    fetch(url, options = {}) { return new Promise((resolve, reject) => calls.push({ url, options, resolve, reject })) },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
  })
  const dispose = (instance) => {
    instance.live = false
    instance.effects.forEach((effect) => effect?.cleanup?.())
  }
  const render = (nextProps = props) => {
    props = nextProps
    const seen = new Set()
    const expand = (node, path) => {
      if (Array.isArray(node)) return node.map((child, i) => expand(child, `${path}/${i}`))
      if (!node || typeof node !== 'object') return node
      if (typeof node.type === 'function') {
        const id = `${path}:${node.key ?? ''}:${node.type.name}`
        seen.add(id)
        let instance = instances.get(id)
        if (!instance) {
          instance = { slots: [], effects: [], pending: [], index: 0, live: true }
          instances.set(id, instance)
        }
        host = instance
        host.index = 0
        return expand(node.type(node.props), id)
      }
      if (node.type === 'img' && node.props.ref && cachedImage) node.props.ref.current = cachedImage
      return { ...node, props: { ...node.props, children: expand(node.props.children, `${path}/children`) } }
    }
    tree = expand(jsx(exports[exportName], props), 'root')
    for (const [id, instance] of instances) {
      if (!seen.has(id)) { dispose(instance); instances.delete(id) }
    }
    for (const instance of instances.values()) instance.pending.splice(0).forEach((commit) => commit())
    return tree
  }
  const unmount = () => {
    for (const instance of instances.values()) dispose(instance)
    instances.clear()
    assert.equal(timers.size, 0, 'unmount clears deadlines')
  }
  render()
  return {
    calls, render, unmount, get tree() { return tree }, get deadUpdates() { return deadUpdates },
    expire() {
      for (const [id, timer] of [...timers]) {
        timers.delete(id)
        assert.equal(timer.delay, 15_000)
        timer.fn()
      }
      render()
    },
  }
}
function nodes(node, predicate) {
  if (Array.isArray(node)) return node.flatMap((n) => nodes(n, predicate))
  if (!node || typeof node !== 'object') return []
  return [...(predicate(node) ? [node] : []), ...nodes(node.props.children, predicate)]
}
const ofType = (h, type) => nodes(h.tree, (n) => n.type === type)
function text(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(text).join(' ').replace(/\s+/g, ' ').trim()
  return typeof node === 'object' ? text(node.props.children) : String(node)
}
function click(h, label) {
  const button = ofType(h, 'button').find((n) => (n.props['aria-label'] ?? text(n)) === label)
  assert.ok(button, `Missing button ${label}: ${text(h.tree)}`)
  assert.equal(button.props.type, 'button')
  button.props.onClick()
  h.render()
}
async function settle(h) {
  for (let i = 0; i < 30; i++) await Promise.resolve()
  h.render()
}
const preview = (runId = 'a', path = 'report.txt', size) => ({ runId, file: { name: path.split('/').pop(), path, size } })
const fileNode = (path = 'report.txt') => ({ name: path.split('/').pop(), path, dir: false, size: 32 })
const listing = (runId = 'a', tree = [fileNode()], files = 1) => ({ runId, tree, files })
function respond(call, body = '', status = 200, headers) { call.resolve(new Response(body, { status, headers })) }
function respondTree(call, data = listing(), status = 200) { respond(call, JSON.stringify(data), status) }
function html(h) { return nodes(h.tree, (n) => n.props.dangerouslySetInnerHTML).map((n) => n.props.dangerouslySetInnerHTML.__html).join('') }

test('file and run changes hide content before effects and reject stale completions', async () => {
  const h = setup('FilePreview', preview())
  assert.match(text(h.tree), /Loading preview/)
  assert.doesNotMatch(text(h.tree), /Binary/)
  respond(h.calls[0], 'Run A content')
  await settle(h)
  assert.match(text(h.tree), /Run A content/)
  h.render(preview('b'))
  assert.equal(h.calls[0].options.signal.aborted, true)
  assert.doesNotMatch(text(h.tree), /Run A content/)
  assert.match(text(h.tree), /Loading preview/)
  h.render(preview('b', 'different.txt'))
  assert.equal(h.calls[1].options.signal.aborted, true)
  respond(h.calls[1], 'Late B content')
  await settle(h)
  assert.match(text(h.tree), /Loading preview/)
  assert.doesNotMatch(text(h.tree), /Late B content/)
  respond(h.calls[2], 'Current B file')
  await settle(h)
  assert.match(text(h.tree), /Current B file/)
  h.unmount()
  assert.equal(h.deadUpdates, 0)
})

test('HTTP and transport failures are separate from rendered Markdown and retry succeeds', async () => {
  const h = setup('FilePreview', preview('a', 'report.md'))
  respond(h.calls[0], '# must not render', 503)
  await settle(h)
  assert.match(text(h.tree), /Could not load preview: HTTP 503/)
  assert.equal(html(h), '')
  assert.ok(nodes(h.tree, (n) => n.props.role === 'alert').length)
  assert.equal(ofType(h, 'a')[0].props.download, true)
  click(h, 'Retry preview')
  assert.equal(h.calls[0].options.signal.aborted, true)
  assert.match(text(h.tree), /Loading preview/)
  h.calls[1].reject(new Error('synthetic offline'))
  await settle(h)
  assert.match(text(h.tree), /synthetic offline/)
  click(h, 'Retry preview')
  respond(h.calls[2], '# Recovered\n**bold** and `code`')
  await settle(h)
  assert.match(html(h), /<h3 class="ae-h">Recovered<\/h3>/)
  assert.match(html(h), /<strong>bold<\/strong>/)
  assert.match(html(h), /<code class="ae-inline">code<\/code>/)
  assert.equal(h.calls.length, 3, 'no automatic retry loop')
  assert.ok(h.calls.every((c) => c.options.cache === 'no-store' && c.options.method === undefined))
  h.unmount()
})

test('preview deadlines recover; timed-out success/failure cannot overwrite retry', async () => {
  const h = setup('FilePreview', preview())
  h.expire()
  assert.match(text(h.tree), /timed out/)
  assert.equal(h.calls[0].options.signal.aborted, true)
  click(h, 'Retry preview')
  respond(h.calls[0], 'obsolete')
  await settle(h)
  assert.match(text(h.tree), /Loading preview/)
  h.expire()
  click(h, 'Retry preview')
  h.calls[1].reject(new Error('late failure'))
  respond(h.calls[2], 'recovered')
  await settle(h)
  assert.match(text(h.tree), /recovered/)
  assert.doesNotMatch(text(h.tree), /obsolete|late failure/)
  h.unmount()
  assert.equal(h.deadUpdates, 0)
})

test('switching a pending text file to binary or oversized image never leaves a spinner', async () => {
  const h = setup('FilePreview', preview())
  h.render(preview('a', 'board.kicad_pcb', 10))
  assert.match(text(h.tree), /Binary or unsupported file/)
  assert.doesNotMatch(text(h.tree), /Loading preview/)
  assert.equal(h.calls[0].options.signal.aborted, true)
  h.calls[0].reject(new Error('obsolete failure'))
  await settle(h)
  assert.doesNotMatch(text(h.tree), /obsolete failure/)
  for (const path of ['large.txt', 'large.png', 'large.svg']) {
    h.render(preview('a', path, 1_500_001))
    assert.match(text(h.tree), /Too large to preview inline/)
    assert.equal(ofType(h, 'img').length, 0)
    assert.equal(ofType(h, 'a').length, 1)
  }
  assert.equal(h.calls.length, 1)
  h.unmount()
  assert.equal(h.deadUpdates, 0)
})

test('actual response bytes are capped and oversized streams are cancelled', async () => {
  const h = setup('FilePreview', preview('a', 'unknown-size.txt'))
  let cancelled = false
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1_500_001)) },
    cancel() { cancelled = true },
  })
  h.calls[0].resolve(new Response(stream))
  await settle(h)
  assert.match(text(h.tree), /Too large to preview inline/)
  assert.equal(cancelled, true)
  h.render(preview('a', 'stale-size.txt', 1))
  respond(h.calls[1], 'small', 200, { 'content-length': '1500001' })
  await settle(h)
  assert.match(text(h.tree), /Too large to preview inline/)
  h.unmount()
})

test('empty text and binary data mislabeled as text have honest states', async () => {
  const h = setup('FilePreview', preview())
  respond(h.calls[0], '')
  await settle(h)
  assert.match(text(h.tree), /This file is empty/)
  assert.doesNotMatch(text(h.tree), /Binary|Loading preview/)
  h.render(preview('a', 'binary.txt'))
  respond(h.calls[1], 'binary\0data')
  await settle(h)
  assert.match(text(h.tree), /Binary or unsupported file/)
  assert.equal(ofType(h, 'pre').length, 0)
  h.unmount()
})

test('image and SVG load/error/timeout have recovery and no redundant text fetch', () => {
  for (const path of ['image.png', 'image.svg']) {
    const h = setup('FilePreview', preview('a', path))
    assert.match(text(h.tree), /Loading preview/)
    const obsoleteImage = ofType(h, 'img')[0]
    obsoleteImage.props.onError()
    h.render()
    assert.match(text(h.tree), /Image could not be loaded/)
    assert.equal(ofType(h, 'img').length, 0)
    click(h, 'Retry preview')
    assert.match(ofType(h, 'img')[0].props.src, /\?previewRetry=1$/)
    obsoleteImage.props.onLoad()
    h.render()
    assert.match(text(h.tree), /Loading preview/)
    ofType(h, 'img')[0].props.onLoad()
    h.render()
    assert.doesNotMatch(text(h.tree), /Loading preview|Could not load/)
    assert.ok(!ofType(h, 'img')[0].props.className.includes('invisible'))
    h.render(preview('b', path))
    assert.match(text(h.tree), /Loading preview/)
    h.expire()
    assert.match(text(h.tree), /timed out/)
    click(h, 'Retry preview')
    const pendingImage = ofType(h, 'img')[0]
    h.unmount()
    pendingImage.props.onLoad()
    pendingImage.props.onError()
    assert.equal(h.deadUpdates, 0)
    assert.equal(h.calls.length, 0)
  }
})

test('cached images that settle before the effect do not wait until timeout', () => {
  for (const naturalWidth of [0, 128]) {
    const h = setup('FilePreview', preview('a', 'cached.png'), { cachedImage: { complete: true, naturalWidth } })
    h.render()
    assert.doesNotMatch(text(h.tree), /Loading preview/)
    if (naturalWidth === 0) assert.match(text(h.tree), /Image could not be loaded/)
    else assert.equal(ofType(h, 'img').length, 1)
    h.expire()
    assert.doesNotMatch(text(h.tree), /timed out/)
    h.unmount()
  }
})

test('late body reads and unmounted fetches do not update state', async () => {
  const h = setup('FilePreview', preview())
  let streamController
  h.calls[0].resolve(new Response(new ReadableStream({ start(controller) { streamController = controller } })))
  await settle(h)
  assert.match(text(h.tree), /Loading preview/)
  h.render(preview('b'))
  streamController.enqueue(new TextEncoder().encode('late body'))
  streamController.close()
  await settle(h)
  assert.doesNotMatch(text(h.tree), /late body/)
  h.unmount()
  h.calls[1].reject(new Error('unmounted failure'))
  for (let i = 0; i < 30; i++) await Promise.resolve()
  assert.equal(h.deadUpdates, 0)
})

test('JSON, CSV, plain text and Markdown renderers remain available', async () => {
  const h = setup('FilePreview', preview('a', 'report.json'))
  respond(h.calls[0], '{"value":1}')
  await settle(h)
  assert.equal(ofType(h, 'pre')[0].props.children, '{\n  "value": 1\n}')
  h.render(preview('a', 'invalid.json'))
  respond(h.calls[1], '{unfinished')
  await settle(h)
  assert.equal(text(ofType(h, 'pre')[0]), '{unfinished')
  h.render(preview('a', 'report.csv'))
  respond(h.calls[2], 'name,value\npart,2')
  await settle(h)
  assert.equal(ofType(h, 'tr').length, 2)
  assert.equal(ofType(h, 'td').length, 4)
  h.render(preview('a', 'code.py'))
  respond(h.calls[3], '<script>literal</script>')
  await settle(h)
  assert.equal(text(ofType(h, 'pre')[0]), '<script>literal</script>')
  assert.equal(html(h), '')
  h.render(preview('a', 'report.md'))
  respond(h.calls[4], '## Heading\n- first\n- second\n\n```js\n<script>x</script>\n```\n| a | b |')
  await settle(h)
  assert.match(html(h), /<h4 class="ae-h">Heading<\/h4>/)
  assert.match(html(h), /<ul class="ae-ul"><li>first<\/li><li>second<\/li><\/ul>/)
  assert.match(html(h), /&lt;script&gt;x&lt;\/script&gt;/)
  assert.match(html(h), /class="ae-row"/)
  h.unmount()
})

test('Markdown link attributes escape quotes/entities and cannot contain generated markup', async () => {
  const h = setup('FilePreview', preview('a', 'report.md'))
  respond(h.calls[0], [
    '[quote](https://example.test/"onmouseover="alert)',
    "[single](https://example.test/'onfocus='alert)",
    '[entity](https://example.test/&quot;onclick=&quot;alert)',
    '[code](https://example.test/`x`)',
    '[bold](https://example.test/**x**)',
    '[**label**](https://example.test/?a=1&b=2)',
    '[unsafe](javascript:alert)',
    '[unsafe](data:text/html,bad)',
    '<img src=x onerror=alert(1)>',
    '`[literal](https://example.test/)`',
  ].join('\n'))
  await settle(h)
  const output = html(h)
  const anchors = [...output.matchAll(/<a href="([^"]*)" target="_blank" rel="noreferrer" class="underline">/g)]
  assert.equal(anchors.length, 6, 'every link has exactly the intended fixed attributes')
  assert.match(anchors[0][1], /&quot;onmouseover=&quot;alert/)
  assert.match(anchors[1][1], /&#39;onfocus=&#39;alert/)
  assert.match(anchors[2][1], /&amp;quot;onclick=&amp;quot;alert/)
  assert.equal(anchors[3][1], 'https://example.test/`x`')
  assert.equal(anchors[4][1], 'https://example.test/**x**')
  assert.equal(anchors[5][1], 'https://example.test/?a=1&amp;b=2')
  assert.match(output, /<strong>label<\/strong><\/a>/)
  assert.doesNotMatch(output, /href="(?:javascript|data):|<img|<script/)
  assert.match(output, /<code class="ae-inline">\[literal\]\(https:\/\/example.test\/\)<\/code>/)
  h.unmount()
})

test('download URLs encode each segment and close control has an accessible name', () => {
  let closed = 0
  const h = setup('FilePreview', { ...preview('run & name', 'data/quote"?#.txt'), onClose: () => closed++ })
  assert.equal(h.calls[0].url, '/runs/run%20%26%20name/data/quote%22%3F%23.txt')
  assert.equal(ofType(h, 'a')[0].props.href, h.calls[0].url)
  assert.equal(ofType(h, 'a')[0].props['aria-label'], 'Download data/quote"?#.txt')
  click(h, 'Close file preview')
  assert.equal(closed, 1)
  h.unmount()
})

test('explorer clears old tree/selection on run change and ignores late responses', async () => {
  const h = setup('ArtifactExplorer', { runId: 'a', compact: true })
  assert.match(text(h.tree), /Loading file tree/)
  respondTree(h.calls[0])
  await settle(h)
  click(h, 'Preview report.txt')
  respond(h.calls[1], 'Run A preview')
  await settle(h)
  assert.match(text(h.tree), /Run A preview/)
  h.render({ runId: 'b', compact: true })
  assert.equal(h.calls[0].options.signal.aborted, true)
  assert.equal(h.calls[1].options.signal.aborted, true)
  assert.doesNotMatch(text(h.tree), /Run A preview|report.txt/)
  h.render({ runId: 'c' })
  assert.equal(h.calls[2].options.signal.aborted, true)
  respondTree(h.calls[2], listing('b', [fileNode('obsolete.txt')]))
  respondTree(h.calls[3], listing('c', [fileNode('current.txt')]))
  await settle(h)
  assert.match(text(h.tree), /current.txt/)
  assert.doesNotMatch(text(h.tree), /obsolete.txt/)
  h.render({ runId: null })
  assert.match(text(h.tree), /No run selected/)
  assert.doesNotMatch(text(h.tree), /current.txt/)
  h.unmount()
  assert.equal(h.deadUpdates, 0)
})

test('listing HTTP, malformed JSON, shape, run identity and count errors allow retry', async () => {
  const h = setup('ArtifactExplorer', { runId: 'a' })
  respondTree(h.calls[0], listing(), 500)
  await settle(h)
  assert.match(text(h.tree), /Could not list files: HTTP 500/)
  const invalid = [null, {}, { error: 'synthetic listing error' }, listing('other'), listing('a', [{}]), listing('a', [], 1), listing('a', [{ name: 'folder', path: 'folder', dir: true, children: [{}] }]), listing('a', [fileNode('../escape')])]
  for (const data of invalid) {
    click(h, 'Retry file listing')
    assert.match(text(h.tree), /Loading file tree/)
    respondTree(h.calls.at(-1), data)
    await settle(h)
    assert.match(text(h.tree), /Could not list files/)
  }
  click(h, 'Retry file listing')
  respond(h.calls.at(-1), 'not json')
  await settle(h)
  assert.match(text(h.tree), /Could not list files/)
  click(h, 'Retry file listing')
  respondTree(h.calls.at(-1), listing('a', [], 0))
  await settle(h)
  assert.match(text(h.tree), /No files generated for this run yet/)
  assert.match(text(h.tree), /0 files/)
  assert.ok(h.calls.every((c) => c.options.method === undefined && c.options.cache === 'no-store'))
  h.unmount()
})

test('refresh clears stale tree and selection; failure and timeout recover without automatic retries', async () => {
  const h = setup('ArtifactExplorer', { runId: 'a' })
  respondTree(h.calls[0])
  await settle(h)
  click(h, 'Preview report.txt')
  respond(h.calls[1], 'stale body')
  await settle(h)
  click(h, 'Refresh file listing')
  assert.match(text(h.tree), /Loading file tree/)
  assert.doesNotMatch(text(h.tree), /report.txt|stale body/)
  h.calls[2].reject(new Error('offline'))
  await settle(h)
  assert.match(text(h.tree), /Could not list files: offline/)
  click(h, 'Retry file listing')
  h.expire()
  assert.match(text(h.tree), /File listing timed out/)
  assert.equal(h.calls[3].options.signal.aborted, true)
  assert.equal(h.calls.length, 4)
  click(h, 'Retry file listing')
  respondTree(h.calls[3], listing('a', [fileNode('obsolete.txt')]))
  respondTree(h.calls[4], listing('a', [fileNode('recovered.txt')]))
  await settle(h)
  assert.match(text(h.tree), /recovered.txt/)
  assert.doesNotMatch(text(h.tree), /obsolete.txt/)
  h.unmount()
  assert.equal(h.deadUpdates, 0)
})

test('tree folders and file selection expose native keyboard controls; host mode does not fetch preview', async () => {
  const opened = []
  const h = setup('ArtifactExplorer', { runId: 'a', onOpen: (file) => opened.push(file) })
  respondTree(h.calls[0], listing('a', [{ name: 'data', path: 'data', dir: true, children: [fileNode('data/report.txt')] }]))
  await settle(h)
  assert.equal(ofType(h, 'button').find((n) => n.props['aria-label'] === 'Collapse data').props['aria-expanded'], true)
  click(h, 'Collapse data')
  assert.equal(ofType(h, 'button').find((n) => n.props['aria-label'] === 'Expand data').props['aria-expanded'], false)
  assert.doesNotMatch(text(h.tree), /report.txt/)
  click(h, 'Expand data')
  click(h, 'Preview data/report.txt')
  assert.equal(ofType(h, 'button').find((n) => n.props['aria-label'] === 'Preview data/report.txt').props['aria-current'], 'true')
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ name: 'report.txt', path: 'data/report.txt', size: 32 }])
  assert.equal(h.calls.length, 1)
  h.unmount()
})

test('unmounted listing ignores deferred JSON parsing and aborts the read', async () => {
  const h = setup('ArtifactExplorer', { runId: 'a' })
  let resolveJson
  h.calls[0].resolve({ ok: true, json: () => new Promise((resolve) => { resolveJson = resolve }) })
  await settle(h)
  h.unmount()
  assert.equal(h.calls[0].options.signal.aborted, true)
  resolveJson(listing())
  for (let i = 0; i < 30; i++) await Promise.resolve()
  assert.equal(h.deadUpdates, 0)
})

test('artifact revision reloads listing and selected inline text, clearing removed files', async () => {
  const h = setup('ArtifactExplorer', { runId: 'a', revision: 0 })
  respondTree(h.calls[0]); await settle(h)
  click(h, 'Preview report.txt')
  respond(h.calls[1], 'ancestor output'); await settle(h)
  assert.match(text(h.tree), /ancestor output/)
  h.render({ runId: 'a', revision: 1 }); h.render()
  assert.doesNotMatch(text(h.tree), /ancestor output/)
  const firstRefresh = h.calls.findLast(call => call.url.includes('/api/runs/files'))
  respondTree(firstRefresh); await settle(h)
  const currentPreview = h.calls.findLast(call => call.url === '/runs/a/report.txt')
  respond(currentPreview, 'rebuilt output'); await settle(h)
  assert.match(text(h.tree), /rebuilt output/)
  h.render({ runId: 'a', revision: 2 }); h.render()
  respondTree(h.calls.findLast(call => call.url.includes('/api/runs/files')), listing('a', [], 0)); await settle(h)
  assert.doesNotMatch(text(h.tree), /rebuilt output/)
  assert.match(text(h.tree), /No files generated/)
  h.unmount()
})
test('revision cancels a stale listing and does not restore removed content', async () => {
  const h = setup('ArtifactExplorer', { runId: 'a', revision: 0 })
  const old = h.calls[0]
  h.render({ runId: 'a', revision: 1 })
  assert.equal(old.options.signal.aborted, true)
  respondTree(h.calls[1], listing('a', [], 0)); await settle(h)
  respondTree(old); await settle(h)
  assert.match(text(h.tree), /No files generated/)
  assert.doesNotMatch(text(h.tree), /report.txt/)
  h.unmount()
})
