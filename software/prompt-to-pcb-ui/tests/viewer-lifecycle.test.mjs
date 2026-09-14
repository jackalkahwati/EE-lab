import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import * as THREE from 'three'

// Execute the actual TSX effect bodies with real three.js scene objects. Only
// React hooks, browser/GPU APIs, imports and fetch are instrumented. This is not
// a DOM, rasterization or browser interaction acceptance test. No real fetch.
const files = { Board3D: 'board-3d', CadViewer: 'cad-viewer', MechanicalAssembly: 'mechanical-assembly' }
const compiled = new Map()
for (const [name, file] of Object.entries(files)) {
  const source = fs.readFileSync(new URL(`../components/${file}.tsx`, import.meta.url), 'utf8')
  const esm = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText
  compiled.set(name, ts.transpileModule(esm.replaceAll('import(', '__import('), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, allowJs: true } }).outputText)
}
const mechanicalStageSource = fs.readFileSync(new URL('../components/mechanical-stage.tsx', import.meta.url), 'utf8')
const mechanicalStageCode = ts.transpileModule(mechanicalStageSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

function stageHarness() {
  const state = [], refs = [], requests = [], effects = []
  let stateIndex = 0, refIndex = 0, cleanup, tree, key, component
  const exports = {}
  const jsx = (type, props, key) => ({ type, props, key })
  const react = {
    useState(initial) {
      const index = stateIndex++
      if (!(index in state)) state[index] = initial
      return [state[index], (value) => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
    },
    useRef(initial) { const index = refIndex++; return refs[index] ?? (refs[index] = { current: initial }) },
    useEffect(effect) { effects.push(effect) },
  }
  vm.runInNewContext(mechanicalStageCode, {
    exports, AbortController,
    fetch(url, options) { const pending = deferred(); requests.push({ url, options, pending }); return pending.promise },
    require(specifier) {
      if (specifier === 'react') return react
      if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (specifier === '@/components/llm-settings') return { llmHeaders: () => ({}) }
      if (specifier === '@/lib/utils') return { cn: () => '' }
      if (['lucide-react', '@/components/mechanical-assembly', '@/components/cad-viewer'].includes(specifier)) return {}
      throw new Error(`Unexpected stage require: ${specifier}`)
    },
  })
  const buttons = (node, result = []) => {
    if (Array.isArray(node)) node.forEach((child) => buttons(child, result))
    else if (node && typeof node === 'object') {
      if (node.type === 'button') result.push(node)
      buttons(node.props?.children, result)
    }
    return result
  }
  const render = (props = {}, restartRead = false) => {
    const wrapper = exports.MechanicalStage({ runId: 'A', spec: {}, ...props })
    const changed = key !== wrapper.key
    if (changed) { cleanup?.(); state.length = 0; refs.length = 0; key = wrapper.key }
    component = wrapper.type
    stateIndex = 0; refIndex = 0; effects.length = 0
    tree = component(wrapper.props)
    if (changed || restartRead) { if (!changed) cleanup?.(); cleanup = effects[0]() }
    return tree
  }
  return { state, requests, render, buttons: () => buttons(tree), stop: () => cleanup?.() }
}

function harness(name, options = {}) {
  const events = { fetches: [], parses: [], renderers: [], controls: [], observers: [], pmrems: [], rooms: [], targets: [], states: [] }
  const frames = new Map()
  let nextFrame = 0
  const effects = []
  const refs = []
  let refIndex = 0
  const mount = { clientWidth: 600, clientHeight: 400, children: [], appendChild(canvas) { this.children.push(canvas) } }
  const imports = deferred()
  const environment = deferred()
  let cleanup
  const track = (object) => {
    object.disposals = 0
    object.addEventListener('dispose', () => object.disposals++)
    return object
  }
  const model = () => {
    const scene = new THREE.Group()
    const geometry = track(new THREE.BoxGeometry(0.04, 0.002, 0.03))
    const texture = track(new THREE.Texture())
    const material = track(new THREE.MeshStandardMaterial({ map: texture }))
    scene.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material))
    const otherGeometry = track(new THREE.BoxGeometry(0.01, 0.01, 0.01))
    const otherScene = new THREE.Group()
    otherScene.add(new THREE.Mesh(otherGeometry, material))
    return { scene, scenes: [scene, otherScene], resources: [geometry, material, texture, otherGeometry] }
  }
  class Renderer {
    constructor() {
      if (options.webglFailure) throw new Error('WebGL unavailable')
      this.disposals = 0
      this.sizes = []
      this.renders = []
      this.shadowMap = {}
      this.domElement = { listeners: new Map(),
        addEventListener(type, fn) { this.listeners.set(type, fn) },
        removeEventListener(type, fn) { assert.equal(this.listeners.get(type), fn); this.listeners.delete(type) },
        remove() { mount.children = mount.children.filter((canvas) => canvas !== this) },
      }
      events.renderers.push(this)
    }
    setPixelRatio() {}
    setSize(w, h) { assert.equal(this.disposals, 0); this.sizes.push([w, h]) }
    render(scene, camera) { assert.equal(this.disposals, 0); this.renders.push({ scene, camera }) }
    dispose() { this.disposals++ }
  }
  class Controls {
    constructor(camera) { this.camera = camera; this.target = new THREE.Vector3(); this.disposals = 0; events.controls.push(this) }
    update() { assert.equal(this.disposals, 0) }
    dispose() { this.disposals++ }
  }
  class PMREM {
    constructor(renderer) { assert.equal(renderer.disposals, 0); this.disposals = 0; events.pmrems.push(this) }
    fromScene() {
      if (options.environmentFailure) throw new Error('environment failed')
      const target = track(new THREE.WebGLRenderTarget(1, 1))
      events.targets.push(target)
      return target
    }
    dispose() { this.disposals++ }
  }
  class Room extends THREE.Scene {
    constructor() { super(); this.disposals = 0; events.rooms.push(this) }
    dispose() { this.disposals++ }
  }
  class Observer {
    constructor(callback) { this.callback = callback; this.disconnections = 0; events.observers.push(this) }
    observe(element) { assert.equal(element, mount) }
    disconnect() { this.disconnections++ }
  }
  const react = {
    useRef() { return refs[refIndex++] ?? (refs[refIndex - 1] = { current: refIndex === 1 ? mount : null }) },
    useState(initial) { return [initial, (value) => events.states.push(value)] },
    useEffect(callback) { effects.push(callback) },
  }
  const modules = {}
  const context = vm.createContext({
    console, AbortController, ResizeObserver: Observer,
    window: { devicePixelRatio: 1 },
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
    fetch(url, { signal }) {
      const response = deferred(), buffer = deferred()
      const request = { url, signal, response, buffer }
      events.fetches.push(request)
      if (!options.delayFetch) response.resolve({ ok: !options.httpFailure, status: 404, json: async () => ({ error: 'missing model' }), arrayBuffer: () => buffer.promise })
      if (!options.delayBuffer) buffer.resolve(new ArrayBuffer(4))
      return response.promise
    },
    async __import(specifier) {
      if (specifier === 'three') { if (options.delayImport) await imports.promise; return { ...THREE, WebGLRenderer: Renderer, PMREMGenerator: PMREM } }
      if (specifier.includes('GLTFLoader')) return { GLTFLoader: class {
        parseAsync() {
          const result = model(), pending = deferred()
          events.parses.push({ result, pending })
          if (!options.delayParse) options.corrupt ? pending.reject(new Error('corrupt GLB')) : pending.resolve(result)
          return pending.promise
        }
      } }
      if (specifier.includes('OrbitControls')) return { OrbitControls: Controls }
      if (specifier.includes('RoomEnvironment')) { if (options.delayEnvironment) await environment.promise; return { RoomEnvironment: Room } }
      throw new Error(`Unexpected import: ${specifier}`)
    },
    require(specifier) {
      if (specifier === 'react') return react
      if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
      if (specifier === 'lucide-react') return {}
      if (specifier === '@/lib/utils') return { cn: () => '' }
      if (specifier === './board-3d') return modules.Board3D
      throw new Error(`Unexpected require: ${specifier}`)
    },
  })
  for (const component of ['Board3D', ...(name === 'Board3D' ? [] : [name])]) {
    const exports = {}
    context.exports = exports
    vm.runInContext(`(function () { ${compiled.get(component)}\n })()`, context)
    modules[component] = exports
  }
  const start = (variant = 'A', extra = {}) => {
    refIndex = 0
    effects.length = 0
    modules[name][name]({ basePath: `/synthetic/${variant}`, url: `/synthetic/${variant}.glb`, ...extra })
    cleanup = effects[0]()
  }
  return { events, frames, refs, mount, imports, environment, start, stop: () => cleanup(), lifetime: modules.Board3D.createViewerLifetime }
}

for (const name of Object.keys(files)) {
  for (const window of ['Import', 'Fetch', 'Buffer', 'Parse', 'Environment']) {
    test(`${name}: unmount during ${window.toLowerCase()} rejects late installation and disposes owned resources`, async () => {
      const h = harness(name, { [`delay${window}`]: true })
      h.start()
      await flush()
      h.stop()
      const stateCount = h.events.states.length
      h.imports.resolve()
      for (const request of h.events.fetches) {
        assert.equal(request.signal.aborted, true)
        request.response.resolve({ ok: true, arrayBuffer: () => request.buffer.promise })
        request.buffer.resolve(new ArrayBuffer(4))
      }
      for (const parse of h.events.parses) parse.pending.resolve(parse.result)
      h.environment.resolve()
      await flush()
      assert.equal(h.events.states.length, stateCount)
      assert.equal(h.mount.children.length, 0)
      assert.equal(h.frames.size, 0)
      assert.equal(h.events.controls.length, 0)
      assert.equal(h.events.pmrems.length, 0)
      if (window === 'Import') assert.equal(h.events.fetches.length, 0)
      if (['Fetch', 'Buffer'].includes(window)) assert.equal(h.events.parses.length, 0)
      for (const parse of h.events.parses) for (const resource of parse.result.resources) assert.equal(resource.disposals, 1)
      for (const renderer of h.events.renderers) assert.equal(renderer.disposals, 1)
    })
  }

  test(`${name}: late A parse cannot replace or clear ready B API/canvas`, async () => {
    const h = harness(name, { delayParse: true })
    h.start('A'); await flush(); h.stop()
    h.start('B'); await flush()
    h.events.parses[1].pending.resolve(h.events.parses[1].result)
    await flush()
    const api = h.refs[1].current
    assert.ok(api)
    const canvas = h.mount.children[0]
    const stateCount = h.events.states.length
    h.events.parses[0].pending.resolve(h.events.parses[0].result)
    await flush()
    assert.equal(h.refs[1].current, api)
    assert.equal(h.mount.children[0], canvas)
    assert.equal(h.mount.children.length, 1)
    assert.equal(h.events.states.length, stateCount)
    for (const resource of h.events.parses[0].result.resources) assert.equal(resource.disposals, 1)
    h.stop()
    assert.equal(h.refs[1].current, null)
    assert.equal(h.frames.size, 0)
  })

  test(`${name}: ready teardown, pane resize, preserved controls and idempotent cleanup`, async () => {
    const h = harness(name)
    h.start(); await flush()
    assert.equal(h.events.states.at(-1), 'ready')
    const renderer = h.events.renderers[0]
    const controls = h.events.controls[0]
    const { scene, camera } = renderer.renders[0]
    const resources = new Set()
    scene.traverse((object) => {
      if (object.geometry) resources.add(object.geometry)
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material) resources.add(material)
      if (object.shadow) {
        const original = object.shadow.dispose.bind(object.shadow)
        object.shadow.dispose = () => { object.shadow.disposals = (object.shadow.disposals ?? 0) + 1; original() }
      }
    })
    const disposalCounts = new Map()
    for (const resource of resources) resource.addEventListener('dispose', () => disposalCounts.set(resource, (disposalCounts.get(resource) ?? 0) + 1))
    h.mount.clientWidth = 333; h.mount.clientHeight = 222
    h.events.observers[0].callback()
    assert.deepEqual(renderer.sizes.at(-1), [333, 222])
    assert.equal(camera.aspect, 1.5)
    h.mount.clientWidth = 0
    const sizeCount = renderer.sizes.length
    h.events.observers[0].callback()
    assert.equal(renderer.sizes.length, sizeCount)
    const api = h.refs[1].current
    if (name === 'Board3D') {
      api.setSide('bottom'); assert.ok(camera.position.y < controls.target.y)
      api.reset(); assert.ok(camera.position.y > controls.target.y)
    } else {
      assert.equal(controls.enableZoom, false)
      renderer.domElement.listeners.get('pointerdown')(); assert.equal(controls.enableZoom, true)
      renderer.domElement.listeners.get('mouseleave')(); assert.equal(controls.enableZoom, false)
      const before = camera.position.distanceTo(controls.target)
      api.zoom(0.8); assert.ok(camera.position.distanceTo(controls.target) < before)
      api.fit(); assert.ok(Math.abs(camera.position.distanceTo(controls.target) - before) < 1e-9)
      if (name === 'CadViewer') {
        api.setClip(true, 0.5, 0)
        const part = scene.children[0].children[0]
        assert.equal(part.material.clippingPlanes.length, 1)
        api.setClip(false, 0.5, 0); assert.equal(part.material.clippingPlanes.length, 0)
      }
    }
    const queuedFrame = [...h.frames.values()][0]
    h.stop(); h.stop()
    queuedFrame(); h.events.observers[0].callback()
    assert.equal(h.frames.size, 0)
    assert.equal(h.mount.children.length, 0)
    assert.equal(h.refs[1].current, null)
    assert.equal(renderer.domElement.listeners.size, 0)
    assert.equal(renderer.disposals, 1)
    assert.equal(controls.disposals, 1)
    assert.equal(h.events.observers[0].disconnections, 1)
    for (const resource of resources) assert.equal(disposalCounts.get(resource), 1)
    for (const parse of h.events.parses) for (const resource of parse.result.resources) assert.equal(resource.disposals, 1)
    for (const resource of [...h.events.pmrems, ...h.events.rooms, ...h.events.targets]) assert.equal(resource.disposals, 1)
    assert.equal(scene.environment, null)
    scene.traverse((object) => { if (object.shadow) assert.equal(object.shadow.disposals, 1) })
  })

  for (const failure of ['httpFailure', 'corrupt', 'webglFailure']) {
    test(`${name}: ${failure} reports error without canvas/frame/API`, async () => {
      const h = harness(name, { [failure]: true })
      h.start(); await flush()
      assert.equal(h.events.states.at(-1), 'error')
      assert.equal(h.mount.children.length, 0)
      assert.equal(h.frames.size, 0)
      assert.equal(h.refs[1].current, null)
      if (failure === 'webglFailure') for (const resource of h.events.parses[0].result.resources) assert.equal(resource.disposals, 1)
      h.stop()
    })
  }

  test(`${name}: failed optional environment releases PMREM/room and retains analytic lighting`, async () => {
    const h = harness(name, { environmentFailure: true })
    h.start(); await flush()
    assert.equal(h.events.states.at(-1), 'ready')
    assert.equal(h.events.pmrems[0].disposals, 1)
    assert.equal(h.events.rooms[0].disposals, 1)
    h.stop()
  })
}

test('MechanicalAssembly: unmount during enclosure parsing disposes board, battery and late enclosure', async () => {
  const h = harness('MechanicalAssembly', { delayParse: true })
  h.start('A', { enclosureUrl: '/synthetic/enclosure.glb', hasBattery: true }); await flush()
  h.events.parses[0].pending.resolve(h.events.parses[0].result); await flush()
  assert.equal(h.events.parses.length, 2)
  h.stop()
  assert.ok(h.events.fetches.every((request) => request.signal.aborted))
  h.events.parses[1].pending.resolve(h.events.parses[1].result); await flush()
  for (const parse of h.events.parses) for (const resource of parse.result.resources) assert.equal(resource.disposals, 1)
  assert.equal(h.events.renderers.length, 0)
  assert.equal(h.frames.size, 0)
})

test('MechanicalAssembly: corrupt supplied enclosure reports failure rather than inventing shell', async () => {
  const h = harness('MechanicalAssembly', { delayParse: true })
  h.start('A', { enclosureUrl: '/synthetic/enclosure.glb' }); await flush()
  h.events.parses[0].pending.resolve(h.events.parses[0].result); await flush()
  h.events.parses[1].pending.reject(new Error('corrupt enclosure')); await flush()
  assert.equal(h.events.states.at(-1), 'error')
  assert.equal(h.events.renderers.length, 0)
  for (const resource of h.events.parses[0].result.resources) assert.equal(resource.disposals, 1)
  h.stop()
})

test('MechanicalStage: keyed A to B selection hides A immediately and rejects late read', async () => {
  const h = stageHarness()
  h.render({ runId: 'A' })
  assert.equal(h.state[0], 'loading')
  assert.equal(h.requests.length, 1)
  h.render({ runId: 'B' })
  assert.equal(h.requests[0].options.signal.aborted, true)
  assert.equal(h.state[1], null)
  h.requests[1].pending.resolve({ ok: true, status: 200, json: async () => ({ part: 'B enclosure' }) })
  await flush()
  assert.equal(h.state[0], 'done')
  h.requests[0].pending.resolve({ ok: true, status: 200, json: async () => ({ part: 'A enclosure' }) })
  await flush()
  assert.equal(h.state[1].part, 'B enclosure')
  assert.ok(h.requests.every((r) => r.options.method !== 'POST'))
  h.stop()
})

for (const [label, response, expected] of [
  ['missing', { ok: false, status: 404 }, 'missing'],
  ['denied', { ok: false, status: 403 }, 'error'],
  ['malformed JSON', { ok: true, status: 200, json: async () => { throw new SyntaxError('invalid JSON') } }, 'error'],
  ['malformed artifact', { ok: true, status: 200, json: async () => ({ part: 'bad', fitCheck: {} }) }, 'error'],
]) {
  test(`MechanicalStage: ${label} is an honest saved read state with read-only retry`, async () => {
    const h = stageHarness()
    h.render()
    h.requests[0].pending.resolve(response); await flush(); h.render()
    assert.equal(h.state[0], expected)
    const retry = h.buttons().find((button) => button.props.children === 'Retry loading enclosure')
    assert.ok(retry)
    retry.props.onClick(); h.render({}, true)
    assert.equal(h.requests.length, 2)
    assert.equal(h.requests[1].options.method, undefined)
    h.requests[1].pending.resolve({ ok: true, status: 200, json: async () => ({ part: 'recovered' }) })
    await flush()
    assert.equal(h.state[0], 'done')
    h.stop()
  })
}

test('MechanicalStage: explicit generation supersedes saved read, deduplicates clicks, and ignores unmounted completion', async () => {
  const h = stageHarness()
  let started = 0, built = 0
  const props = { onBuildStart: () => started++, onBuilt: () => built++ }
  h.render(props)
  const run = h.buttons()[0].props.onClick
  void run(); void run()
  assert.equal(started, 1)
  assert.equal(h.state[0], 'generating')
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[0].options.signal.aborted, true)
  assert.equal(h.requests[1].options.method, 'POST')
  assert.equal(h.requests[1].options.signal, undefined)
  h.requests[0].pending.resolve({ ok: true, status: 200, json: async () => ({ part: 'old persisted' }) })
  await flush()
  assert.equal(h.state[0], 'generating')
  h.render({ runId: 'B' })
  h.requests[1].pending.resolve({ ok: true, status: 200, json: async () => ({ ok: true, part: 'late generated A' }) })
  await flush()
  assert.equal(h.state[0], 'loading')
  assert.equal(h.state[1], null)
  assert.equal(built, 0)
  h.stop()
})

test('MechanicalStage: pipeline generation lock blocks handler and button, not saved reads', () => {
  const h = stageHarness()
  h.render({ generationDisabled: true })
  assert.equal(h.buttons()[0].props.disabled, true)
  void h.buttons()[0].props.onClick()
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].options.method, undefined)
  h.stop()
})

test('MechanicalStage: current generation failure exposes explicit retry and invalidates persisted facts', async () => {
  const h = stageHarness()
  let built = 0
  const props = { onBuilt: () => built++ }
  h.render(props)
  void h.buttons()[0].props.onClick()
  h.requests[1].pending.resolve({ ok: false, status: 502, json: async () => ({ error: 'synthetic generation failed' }) })
  await flush(); h.render(props)
  assert.equal(h.state[0], 'error')
  assert.equal(built, 1)
  assert.equal(h.buttons()[0].props.children[1], 'Retry generation')
  assert.equal(h.buttons().some((button) => button.props.children === 'Retry loading enclosure'), false)
  void h.buttons()[0].props.onClick()
  assert.equal(h.requests[2].options.method, 'POST')
  h.requests[2].pending.resolve({ ok: true, status: 200, json: async () => ({ ok: true, part: 'recovered' }) })
  await flush()
  assert.equal(h.state[0], 'done')
  assert.equal(built, 2)
  h.stop()
})

test('Board3D: error rendering retains its mount for subsequent run recovery', () => {
  const source = fs.readFileSync(new URL('../components/board-3d.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /if \(phase === 'error'\)\s*return/)
  assert.match(source, /data-viewer-phase=\{phase\}/)
  assert.match(source, /ref=\{mountRef\}/)
})

test('viewer lifetime deduplicates resources, aborts, releases late claims and survives one failing disposer', () => {
  const h = harness('Board3D')
  const lifetime = h.lifetime()
  const resource = { count: 0, dispose() { this.count++ } }
  lifetime.own(resource); lifetime.own(resource)
  lifetime.defer(() => { throw new Error('cleanup failure') })
  lifetime.dispose(); lifetime.dispose()
  assert.equal(lifetime.abort.signal.aborted, true)
  assert.equal(resource.count, 1)
  lifetime.own(resource)
  assert.equal(resource.count, 1)
  const late = { count: 0, dispose() { this.count++ } }
  lifetime.own(late); lifetime.own(late)
  assert.equal(late.count, 1)
})
