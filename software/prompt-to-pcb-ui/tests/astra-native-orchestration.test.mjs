import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, constants } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

// Only repository source and reviewed catalog JSON are read. Every runtime import,
// native capability and filesystem operation is explicitly injected and in memory.
const ROOT = '/virtual/astra-native'
const HOME = `${ROOT}/home`
const JOB = `${HOME}/native-jobs/job-owned`
const RUN = 'run-owned-fixture'
const RUNROOT = `${ROOT}/public/runs/${RUN}`
const catalog = JSON.parse(readFileSync(new URL('../lib/astra-catalog.json', import.meta.url), 'utf8'))
const compiled = new Map(['astra-native', 'astra-artifacts', 'astra-project-policy', 'astra-ground-evidence', 'astra-drc', 'astra-validator-evidence', 'astra-validator-client', 'astra-validator-containment'].map(name => [name, ts.transpileModule(
  readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } },
).outputText]))
const json = value => JSON.parse(JSON.stringify(value))
const hash = value => createHash('sha256').update(value).digest('hex')
const category = expected => error => error?.category === expected
const blocked = name => () => { throw new Error(`Unexpected side effect: ${name}`) }
class AstraError extends Error {
  constructor(category, message) { super(message); this.category = category }
}
function glb(scene = { meshes: [{}] }) {
  const data = Buffer.from(JSON.stringify(scene))
  const bytes = Buffer.alloc(20 + data.length)
  bytes.writeUInt32LE(0x46546c67, 0)
  bytes.writeUInt32LE(2, 4)
  bytes.writeUInt32LE(bytes.length, 8)
  bytes.writeUInt32LE(data.length, 12)
  bytes.writeUInt32LE(0x4e4f534a, 16)
  data.copy(bytes, 20)
  return bytes
}
const validProject = () => ({ board: { design_settings: {
  rule_severities: Object.fromEntries(['missing_courtyard', 'track_not_centered_on_via', 'tuning_profile_track_geometries', 'footprint_filters_mismatch', 'footprint_type_mismatch'].map(name => [name, 'error'])),
  drc_exclusions: [],
  rules: { min_resolved_spokes: 2, min_clearance: 0.15, min_track_width: 0.15, min_via_diameter: 0.6, min_through_hole_diameter: 0.3, min_via_annular_width: 0.15, min_hole_clearance: 0.25, min_hole_to_hole: 0.25, min_copper_edge_clearance: 0.5 },
} } })
const groundPads = ['C1.2', 'C2.2', 'J1.2', 'U1.1', 'U1.5', 'U1.7']
const groundEvidence = (islands = false) => ({
  available: true, anchor: 'J1.2', method: 'native-effective-shape-polygon-components-v1',
  reachedPads: islands ? ['J1.2'] : [...groundPads],
  unreachedPads: islands ? groundPads.filter(pad => pad !== 'J1.2') : [],
  padComponents: islands ? [['J1.2'], groundPads.filter(pad => pad !== 'J1.2')] : [[...groundPads]],
})
const drcEntry = (severity = 'error') => ({ type: 'fixture', description: 'Synthetic DRC finding', severity, items: [] })
function containmentReceipt(containment) {
  const jobId = 'astra-linux-job-' + 'a'.repeat(32)
  const dir = `${containment.ASTRA_VALIDATOR_JOB_ROOT}/${jobId}`
  const mounts = [['input', '/input', false], ['assets', '/Applications/KiCad/KiCad.app/Contents/SharedSupport', false], ['output', '/output', true]]
  return {
    jobId, imageId: containment.ASTRA_VALIDATOR_IMAGE_ID,
    engine: { Name: 'docker-desktop', OSType: 'linux', Architecture: 'aarch64', ID: 'explicit-fixture-engine' },
    createArgs: containment.expectedAstraValidatorCreateArgs(jobId, 'astra-drc-' + 'a'.repeat(32) + '-' + 'b'.repeat(16)),
    container: {
      id: 'c'.repeat(64), image: containment.ASTRA_VALIDATOR_IMAGE_ID, user: '65532:65532',
      mounts: mounts.map(([relative, destination, writable]) => ({ Type: 'bind', Source: `${dir}/${relative}`, Destination: destination, RW: writable, Propagation: 'rprivate', Mode: '' })),
      hostConfig: {
        NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges=true'],
        NanoCpus: 2000000000, Memory: 2147483648, MemorySwap: 2147483648, PidsLimit: 128, ShmSize: 16777216, OomKillDisable: false,
        CpuPeriod: 0, CpuQuota: 0, CpuRealtimePeriod: 0, CpuRealtimeRuntime: 0, CpusetCpus: '', CpusetMems: '',
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=134217728,mode=1777' }, LogConfig: { Type: 'none', Config: {} },
        Ulimits: [{ Name: 'core', Hard: 0, Soft: 0 }, { Name: 'fsize', Hard: 33554432, Soft: 33554432 }],
        Binds: null, VolumesFrom: null, Devices: [], DeviceCgroupRules: null, DeviceRequests: null, Links: null, ExtraHosts: null, GroupAdd: null,
        PortBindings: {}, PublishAllPorts: false, PidMode: '', IpcMode: 'private', CgroupnsMode: 'private', UTSMode: '', UsernsMode: '',
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, AutoRemove: false,
        Mounts: mounts.map(([relative, destination, writable]) => ({ Type: 'bind', Source: `${dir}/${relative}`, Target: destination, ...(writable ? {} : { ReadOnly: true }) })),
      },
    },
  }
}
const fullDrc = (overrides = {}) => ({
  $schema: 'https://schemas.kicad.org/drc.v1.json', source: 'final-board.kicad_pcb',
  date: '2026-09-14T12:00:00', kicad_version: '10.0.5', coordinate_units: 'mm',
  violations: [], unconnected_items: [], schematic_parity: [],
  included_severities: ['error', 'warning', 'exclusion'], ignored_checks: [], ...overrides,
})
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
const proposal = {
  catalogId: catalog.id,
  parts: [{ name: 'U1', catalogId: 'bme280', kind: 'chip', mpn: 'BME280', value: 'BME280', footprint: 'fixture:preserve-this', kicadMod: 'reviewed fixture source' }],
  nets: [['U1.1', 'J1.1']], gnd: ['U1.8'],
  canonicalNets: [{ name: '3V3', pins: ['U1.1', 'J1.1'] }, { name: 'GND', pins: ['U1.8'] }],
  layoutConstraints: { marker: 'preserve proposal' },
}

function fixture(options = {}) {
  const files = new Map()
  const directories = new Set([ROOT, HOME, RUNROOT])
  const calls = []
  const controller = new AbortController()
  const ctx = { id: 'workflow-owned', signal: controller.signal }
  const tools = Object.freeze({ jobRoot: JOB })
  let opened = 0, closed = 0, publicationAttempts = 0
  const toolManifest = { tools: { kicad: { sha256: hash('pinned kicad') }, router: { sha256: hash('pinned router') } }, assetRoots: ['/virtual/reviewed-assets'] }
  const assertAstraActive = actual => {
    assert.equal(actual, ctx)
    if (ctx.signal.aborted) throw new AstraError('cancelled', 'Fixture cancelled')
  }
  const checkPath = name => assert.ok(name.startsWith(`${ROOT}/`), `Nonfixture filesystem path: ${name}`)
  const put = (name, content) => files.set(`${JOB}/${name}`, Buffer.isBuffer(content) ? content : Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)))
  const io = {
    mkdir: async (name, opts) => {
      checkPath(name); calls.push(['mkdir', name, opts])
      if (directories.has(name) && !opts?.recursive) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      directories.add(name)
    },
    lstat: async name => {
      checkPath(name)
      return { isSymbolicLink: () => options.jobsSymlink === true, isDirectory: () => directories.has(name) }
    },
    realpath: async name => { checkPath(name); return options.aliasPath === name ? `${ROOT}/aliased` : name },
    mkdtemp: async name => { checkPath(name); assert.equal(name, `${HOME}/native-jobs/job-`); directories.add(JOB); return JOB },
    writeFile: async (name, data, opts) => {
      checkPath(name); calls.push(['write', name, opts])
      if (opts?.flag === 'wx' && files.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      if (name === options.failWrite) throw new Error('fixture write failure')
      files.set(name, Buffer.from(data))
      if (name === `${JOB}/chipscale-board.json` && options.mutateBeforePublication) {
        const target = `${JOB}/${options.mutateBeforePublication}`
        files.set(target, Buffer.from('x'.repeat(files.get(target).length)))
      }
      if (name === options.cancelWrite) controller.abort()
    },
    rename: async (from, to) => {
      checkPath(from); checkPath(to); calls.push(['rename', from, to])
      if (to.endsWith('/astra-manifest.json')) {
        publicationAttempts++
        if (options.failFirstPublication && publicationAttempts === 1) throw new Error('fixture publication failure')
      }
      assert.ok(files.has(from))
      files.set(to, files.get(from)); files.delete(from)
      if (options.cancelAfterPublication && publicationAttempts === 1) controller.abort()
    },
    rm: async name => { checkPath(name); calls.push(['remove', name]); files.delete(name) },
    open: async (name, flags) => {
      checkPath(name); calls.push(['open', name, flags])
      assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW)
      if (!files.has(name)) throw Object.assign(new Error('fixture missing'), { code: 'ENOENT' })
      opened++
      const bytes = files.get(name)
      let reads = 0
      return {
        stat: async () => ({ isFile: () => true, nlink: options.hardlink === name ? 2 : 1, size: bytes.length, mtimeMs: 1 + (options.changeDuringRead === name && reads > 0 ? 1 : 0) }),
        read: async (buffer, offset, length, position) => {
          reads++
          assert.equal(buffer.length, bytes.length + 1)
          const bytesRead = Math.min(length, Math.max(0, bytes.length - position))
          bytes.copy(buffer, offset, position, position + bytesRead)
          return { bytesRead, buffer }
        },
        close: async () => { closed++ },
      }
    },
  }
  function mutatePolicy(key) {
    if (options.policyMutation?.operation !== key) return
    const projectName = ['prepare', 'route'].includes(key) ? 'board.kicad_pro' : key === 'import' ? 'imported-board.kicad_pro' : 'final-board.kicad_pro'
    const evidenceName = ['prepare', 'route'].includes(key) ? 'prepared-evidence.json' : key === 'import' ? 'import-evidence.json' : key === 'finish' ? 'fill-evidence.json' : 'native-evidence.json'
    const policy = JSON.parse(files.get(`${JOB}/${projectName}`))
    if (options.policyMutation.kind === 'ignore') policy.board.design_settings.rule_severities.missing_courtyard = 'ignore'
    if (options.policyMutation.kind === 'spokes') policy.board.design_settings.rules.min_resolved_spokes = 0
    if (options.policyMutation.kind === 'limits') policy.board.design_settings.rules.min_clearance = 0.1
    if (options.policyMutation.kind === 'rewrite') policy.meta = { rewrittenAfterExit: true }
    put(projectName, policy)
    if (options.policyMutation.kind === 'table') put('fp-lib-table', projectPolicy.expectedAstraFootprintTable().replace('(uri "', '(uri "/unreviewed'))
    if (options.policyMutation.updateHashes) {
      const evidence = JSON.parse(files.get(`${JOB}/${evidenceName}`))
      evidence[key === 'import' ? 'importedProjectSha256' : 'projectSha256'] = hash(files.get(`${JOB}/${projectName}`))
      evidence.tableSha256 = hash(files.get(`${JOB}/fp-lib-table`))
      put(evidenceName, evidence)
    }
  }
  const nativeTools = {
    createAstraNativeTools: args => { calls.push(['create-tools', json(args)]); assert.equal(args.jobRoot, JOB); return tools },
    inspectAstraNativeReadiness: actual => { assert.equal(actual, tools); return { ready: options.ready !== false } },
    astraNativeToolManifest: actual => { assert.equal(actual, tools); return toolManifest },
    runAstraNativeTool: async (actualCtx, actualTools, operation, limits) => {
      assertAstraActive(actualCtx); assert.equal(actualTools, tools)
      calls.push(['native', json(operation), limits && json(limits)])
      const key = operation.operation + (operation.side ? `:${operation.side}` : operation.capability ? `:${operation.capability}` : '')
      if (options.failOperation === key) throw new AstraError('process', 'Fixture native operation failed')
      const emitPolicy = (projectName, evidenceName, hashField) => {
        put(projectName, validProject())
        put('fp-lib-table', projectPolicy.expectedAstraFootprintTable())
        put(evidenceName, { [hashField]: hash(files.get(`${JOB}/${projectName}`)), tableSha256: hash(files.get(`${JOB}/fp-lib-table`)) })
      }
      if (operation.operation === 'prepare') emitPolicy('board.kicad_pro', 'prepared-evidence.json', 'projectSha256')
      if (operation.operation === 'import') emitPolicy('imported-board.kicad_pro', 'import-evidence.json', 'importedProjectSha256')
      if (operation.operation === 'finish') {
        put('final-board.kicad_pcb', '(kicad_pcb (fixture-final-native-board))')
        emitPolicy('final-board.kicad_pro', 'fill-evidence.json', 'projectSha256')
      }
      if (operation.operation === 'inspect') {
        const board = files.get(`${JOB}/final-board.kicad_pcb`)
        assert.ok(board, 'inspection requires the prior finish output')
        const evidence = { version: 1, stage: 'finished', routeAttempts: 1, identityPreserved: true,
          boardSha256: hash(board), inputSha256: hash(files.get(`${JOB}/native-input.json`)),
          projectSha256: hash(files.get(`${JOB}/final-board.kicad_pro`)), tableSha256: hash(files.get(`${JOB}/fp-lib-table`)),
          connectivity: { available: true, unrouted: options.nativeUnrouted ?? 0 }, groundConnectivity: groundEvidence(options.groundIslands), trackSegments: 17 }
        options.mutateEvidence?.(evidence)
        put('native-evidence.json', evidence)
      }
      assert.notEqual(operation.operation, 'drc', 'DRC must run only through the isolated validator client')
      if (operation.operation === 'render') put(`${operation.side}.png`, options.png ?? png)
      if (operation.operation === 'svg') put(`${operation.side}.svg`, options.svg ?? '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')
      if (operation.operation === 'glb') put('board.glb', options.glb ?? glb())
      if (options.mutateBoardOperation === key) put('final-board.kicad_pcb', '(kicad_pcb (mutated-after-finish))')
      if (options.mutateDrcOperation === key) put('drc.json', { violations: [{ severity: 'error', type: 'post-check-mutation' }], unconnected_items: [] })
      mutatePolicy(key)
      if (options.cancelOperation === key) controller.abort()
      return { stdout: 'fixture only', stderr: '', code: 0 }
    },
  }
  const execution = { AstraError, assertAstraActive }
  const beta = {
    astraWorkspace: () => ({ root: ROOT, home: HOME }), authorizeAstra: blocked('authorization'),
    blockAstraForUnconfirmedCleanup: actual => {
      assert.equal(actual, ctx)
      calls.push(['cleanup-block'])
      controller.abort()
    },
  }
  const context = vm.createContext({ Buffer, Error, console, fetch: blocked('network') })
  const load = (name, dependencies) => {
    const loaded = { exports: {} }
    const safeRequire = dependency => {
      assert.ok(Object.hasOwn(dependencies, dependency), `Unmocked import ${dependency}`)
      return dependencies[dependency]
    }
    vm.runInContext(`(function(require,module,exports){${compiled.get(name)}\n})`, context, { filename: `lib/${name}.ts` })(safeRequire, loaded, loaded.exports)
    return loaded.exports
  }
  const common = { 'node:fs/promises': io, 'node:fs': { constants }, 'node:path': path, 'node:crypto': { createHash }, './astra-execution': execution, './astra-beta': beta }
  const artifacts = load('astra-artifacts', { ...common, './auth': { isValidRunId: blocked('auth validation'), runAccess: blocked('private ownership store') } })
  const projectPolicy = load('astra-project-policy', { './astra-execution': execution, './astra-local-parts': { ASTRA_CATALOG: catalog } })
  const ground = load('astra-ground-evidence', { './astra-execution': execution })
  const drc = load('astra-drc', {})
  const containment = load('astra-validator-containment', {})
  const validatorEvidence = load('astra-validator-evidence', {
    'node:crypto': { createHash }, './astra-execution': execution, './astra-drc': drc, './astra-validator-containment': containment,
  })
  const validatorClient = load('astra-validator-client', {
    'node:http': { request: blocked('real validator IPC') },
    'node:crypto': { randomBytes: blocked('real validator nonce') },
    'node:fs/promises': new Proxy({}, { get: () => blocked('real validator filesystem') }), 'node:path': path,
  })
  const validator = {
    AstraValidatorError: validatorClient.AstraValidatorError,
    validateAstraNativeJob: async args => {
      calls.push(['validator', { jobId: args.jobId, workflowId: args.workflowId, boardSha256: args.boardSha256 }])
      assert.equal(args.jobId, path.basename(JOB))
      assert.equal(args.workflowId, ctx.id)
      assert.equal(args.signal, ctx.signal)
      assert.equal(args.boardSha256, hash(files.get(`${JOB}/final-board.kicad_pcb`)))
      if (options.failOperation === 'validator') throw new AstraError('process', 'Fixture validator failed')
      if (options.cleanupUnconfirmed) throw new validatorClient.AstraValidatorError('cleanup', false)
      if (options.confirmedValidatorFailure) throw new validatorClient.AstraValidatorError('validation', true)
      const report = options.drc ?? fullDrc()
      const rawDrc = JSON.stringify(report)
      let checksComplete = true
      try { checksComplete = drc.parseAstraDrcReport(report, { engineVersion: '10.0.5', source: 'final-board.kicad_pcb', schematicParity: 'not-run' }).checksComplete } catch { /* actual wrapper must reject malformed report */ }
      const result = {
        schema: 'astra-validator-result/v1', jobId: args.jobId, workflowId: args.workflowId, boardSha256: args.boardSha256, rawDrc,
        accounting: { requestedAt: '2026-09-14T12:00:00Z', finishedAt: '2026-09-14T12:00:01Z', stageMs: 100, runtimeMs: 800, totalMs: 1000, cancelled: false, cleanupConfirmed: true },
        receipt: {
          ...containmentReceipt(containment),
          schema: 'astra-linux-job-runtime/v1', image: validatorEvidence.ASTRA_VALIDATOR_IMAGE,
          boardSha256: hash(files.get(`${JOB}/final-board.kicad_pcb`)), nativeInputSha256: hash(files.get(`${JOB}/native-input.json`)),
          nativeEvidenceSha256: hash(files.get(`${JOB}/native-evidence.json`)), reportSha256: hash(rawDrc),
          executionComplete: true, inputsUnchanged: true, schematicParity: 'not-run', checksComplete,
          cleanup: { confirmedAbsent: true }, process: { code: 0, reason: null, signal: null },
          finalState: { Running: false, OOMKilled: false, ExitCode: 0 },
        },
      }
      options.mutateValidator?.(result)
      mutatePolicy('validator')
      if (options.mutateBoardOperation === 'validator') put('final-board.kicad_pcb', '(kicad_pcb (validator-mutated-board))')
      if (options.cancelOperation === 'validator') controller.abort()
      return result
    },
  }
  const api = load('astra-native', {
    ...common, './astra-local-parts': { ASTRA_CATALOG: catalog }, './astra-artifacts': artifacts,
    './astra-native-tools': nativeTools, './astra-project-policy': projectPolicy,
    './astra-ground-evidence': ground, './astra-validator-client': validator, './astra-validator-evidence': validatorEvidence,
    './astra-export-evidence': { validateAstraGlb: (_bytes, expected) => {
      calls.push(['glb-evidence'])
      assert.equal(expected.engineVersion, '10.0.1')
      assert.equal(expected.nativeEvidence.stage, 'finished')
      if (options.failGlbEvidence) throw new AstraError('output', 'Fixture GLB evidence invalid')
    } },
  })
  return {
    api, artifacts, drc, tools, ctx, calls, files, controller, toolManifest,
    build: () => api.buildAstraNative(ctx, RUN, json(proposal), tools),
    manifest: () => JSON.parse(files.get(`${RUNROOT}/astra-manifest.json`).toString()),
    operations: () => calls.filter(([type]) => type === 'native').map(([, operation]) => operation),
    phases: () => calls.filter(([type]) => type === 'native' || type === 'validator').map(([type, operation]) => type === 'validator' ? 'validator' : operation.operation + (operation.side ? `:${operation.side}` : '')),
    handlesClosed: () => assert.equal(opened, closed),
  }
}

test('anchored ground evidence accepts exact reordered partitions and returns false for legitimate islands', () => {
  const { api } = fixture()
  assert.equal(api.astraGroundConnected(groundEvidence()), true)
  const reordered = groundEvidence()
  reordered.padComponents[0].reverse()
  reordered.reachedPads.reverse()
  assert.equal(api.astraGroundConnected(reordered), true)
  const island = groundEvidence(true)
  assert.equal(api.astraGroundConnected(island), false)
  island.padComponents.reverse()
  island.unreachedPads.reverse()
  assert.equal(api.astraGroundConnected(island), false)
  const singles = groundEvidence(true)
  singles.padComponents = groundPads.map(pad => [pad])
  assert.equal(api.astraGroundConnected(singles), false)
})

test('ground evidence rejects missing, duplicate, foreign and malformed entries in every partition section', () => {
  const { api } = fixture()
  for (const value of [undefined, null, false, 0, [], {}, 'connected']) {
    assert.throws(() => api.astraGroundConnected(value), category('output'))
  }
  for (const key of Object.keys(groundEvidence())) {
    const value = groundEvidence()
    delete value[key]
    assert.throws(() => api.astraGroundConnected(value), category('output'), `missing ${key}`)
  }
  for (const overrides of [{ available: false }, { available: 'true' }, { anchor: 'U1.1' }, { anchor: ['J1.2'] }, { method: 'approximate' }]) {
    assert.throws(() => api.astraGroundConnected({ ...groundEvidence(), ...overrides }), category('output'))
  }
  for (const section of ['padComponents', 'reachedPads', 'unreachedPads']) {
    for (const malformed of [null, 0, false, '0', {}, 'J1.2']) {
      assert.throws(() => api.astraGroundConnected({ ...groundEvidence(), [section]: malformed }), category('output'), `${section} malformed`)
    }
    for (const mutation of ['duplicate', 'missing', 'foreign', 'wrong-type']) {
      const value = groundEvidence(section === 'unreachedPads')
      const target = section === 'padComponents' ? value.padComponents[0] : value[section]
      if (mutation === 'duplicate') target.push(target[0])
      if (mutation === 'missing') target.pop()
      if (mutation === 'foreign') target[0] = 'R999.1'
      if (mutation === 'wrong-type') target[0] = 0
      assert.throws(() => api.astraGroundConnected(value), category('output'), `${section} ${mutation}`)
    }
  }
  for (const group of [[], null, 'J1.2', 0, {}]) {
    const value = groundEvidence()
    value.padComponents.push(group)
    assert.throws(() => api.astraGroundConnected(value), category('output'))
  }
  const duplicateAcrossGroups = groundEvidence(true)
  duplicateAcrossGroups.padComponents[1].push('J1.2')
  assert.throws(() => api.astraGroundConnected(duplicateAcrossGroups), category('output'))
  const falseZero = groundEvidence(true)
  falseZero.unreachedPads = []
  assert.throws(() => api.astraGroundConnected(falseZero), category('output'))
  const falseAllReached = groundEvidence(true)
  falseAllReached.reachedPads = [...groundPads]
  falseAllReached.unreachedPads = []
  assert.throws(() => api.astraGroundConnected(falseAllReached), category('output'))
  const falsePartition = groundEvidence(true)
  falsePartition.padComponents = [[...groundPads]]
  assert.throws(() => api.astraGroundConnected(falsePartition), category('output'))
})

test('ground islands cannot pass even with native unrouted zero and zero DRC errors', async () => {
  const f = fixture({ groundIslands: true, nativeUnrouted: 0 })
  const result = await f.build()
  assert.equal(result.ok, false)
  assert.equal(result.groundConnected, false)
  const manifest = f.manifest()
  assert.equal(manifest.status, 'failed')
  assert.equal(manifest.checks.drcAvailable, true)
  assert.equal(manifest.checks.drcErrors, 0)
  assert.equal(manifest.checks.unrouted, 0)
  assert.equal(manifest.checks.exportsComplete, true)
  assert.equal(manifest.artifacts.length, 11)
  assert.equal(f.operations().filter(op => op.operation === 'route').length, 1)
  assert.equal(JSON.parse(f.files.get(`${RUNROOT}/electronics/chipscale-board.json`)).groundConnected, false)
  f.artifacts.parseAstraManifest(manifest, RUN)
  f.handlesClosed()
})

test('missing or inconsistent ground evidence stops before DRC without an automatic retry', async () => {
  for (const mutateEvidence of [
    value => { delete value.groundConnectivity },
    value => { value.groundConnectivity = groundEvidence(true); value.groundConnectivity.unreachedPads = [] },
  ]) {
    const f = fixture({ mutateEvidence })
    await assert.rejects(f.build(), category('output'))
    assert.equal(f.manifest().status, 'failed')
    assert.equal(f.manifest().checks.drcAvailable, false)
    assert.equal(f.operations().at(-1).operation, 'inspect')
    assert.equal(f.operations().filter(op => op.operation === 'route').length, 1)
    f.handlesClosed()
  }
})

test('strict DRC parser requires complete pinned serializer fields and typed entries', () => {
  const { drc } = fixture()
  const parse = value => drc.parseAstraDrcReport(value, { engineVersion: '10.0.5', source: 'final-board.kicad_pcb', schematicParity: 'not-run' })
  assert.equal(parse(fullDrc()).passed, true)
  const evidence = parse(fullDrc({ violations: [drcEntry('error'), drcEntry('warning')], unconnected_items: [drcEntry(), drcEntry('warning')] }))
  assert.equal(evidence.errors, 1)
  assert.equal(evidence.warnings, 1)
  assert.equal(evidence.unrouted, 2)
  assert.equal(evidence.passed, false)
  for (const value of [null, [], {}, { violations: [] }, { unconnected_items: [] }, fullDrc({ violations: null }), fullDrc({ unconnected_items: 0 })]) assert.throws(() => parse(value))
  for (const violation of [null, [], {}, { severity: 'error' }, drcEntry('ignore'), drcEntry('exclusion'), { severity: 'ERROR', type: 'x' }]) {
    assert.throws(() => parse(fullDrc({ violations: [violation] })))
  }
  for (const item of [null, [], {}, { items: null }, { items: {} }]) assert.throws(() => parse(fullDrc({ unconnected_items: [item] })))
})

test('post-exit project policy and exact library table are verified at each native stage', async () => {
  for (const operation of ['prepare', 'route', 'import', 'finish', 'inspect', 'validator', 'render:top']) {
    for (const kind of ['rewrite', 'ignore', 'spokes', 'limits', 'table']) {
      const f = fixture({ policyMutation: { operation, kind, updateHashes: kind !== 'rewrite' } })
      await assert.rejects(f.build(), category('output'), `${operation}: ${kind}`)
      const manifest = f.manifest()
      assert.equal(manifest.status, 'failed')
      assert.equal(manifest.checks.exportsComplete, false)
      assert.ok(f.operations().filter(op => op.operation === 'route').length <= 1)
      if (operation !== 'render:top') {
        assert.equal(f.phases().at(-1), operation)
      }
      f.artifacts.parseAstraManifest(manifest, RUN)
      f.handlesClosed()
    }
  }
})

test('native inspection requires matching project and table digests, not merely valid policy bytes', async () => {
  for (const field of ['projectSha256', 'tableSha256']) {
    for (const replacement of [undefined, null, '', hash('different bytes')]) {
      const f = fixture({ mutateEvidence: evidence => {
        if (replacement === undefined) delete evidence[field]
        else evidence[field] = replacement
      } })
      await assert.rejects(f.build(), category('output'))
      assert.equal(f.manifest().status, 'failed')
      assert.equal(f.operations().at(-1).operation, 'inspect')
      assert.equal(f.operations().filter(op => op.operation === 'route').length, 1)
      f.handlesClosed()
    }
  }
})

test('valid policy changes cannot evade final invariance by rewriting evidence digests', async () => {
  for (const operation of ['inspect', 'validator', 'render:top']) {
    const f = fixture({ policyMutation: { operation, kind: 'rewrite', updateHashes: true } })
    await assert.rejects(f.build(), category('output'))
    assert.equal(f.manifest().status, 'failed')
    assert.equal(f.manifest().checks.exportsComplete, false)
    assert.equal(f.operations().filter(op => op.operation === 'route').length, 1)
    f.handlesClosed()
  }
})

test('preparation probes every opaque native capability once with explicit resource limits', async () => {
  const f = fixture()
  assert.equal(await f.api.prepareAstraNativeJob(f.ctx), f.tools)
  assert.deepEqual(f.operations(), ['containment', 'kicad-version', 'python-version', 'pcbnew', 'router-help', 'render-help', 'glb-help', 'svg-help', 'drc-help'].map(capability => ({ operation: 'probe', capability })))
  for (const [, , limits] of f.calls.filter(([type]) => type === 'native')) assert.deepEqual(limits, { timeoutMs: 15_000, maxOutputBytes: 256 * 1024 })
  assert.deepEqual(f.calls.find(([type]) => type === 'create-tools')[1], { jobRoot: JOB, scriptRoot: `${ROOT}/scripts` })
})

test('preparation refuses aliases, symlinks, missing readiness and cancelled or failed probes', async () => {
  for (const options of [{ jobsSymlink: true }, { aliasPath: `${HOME}/native-jobs` }, { ready: false }, { failOperation: 'probe:router-help' }, { cancelOperation: 'probe:containment' }]) {
    const f = fixture(options)
    await assert.rejects(f.api.prepareAstraNativeJob(f.ctx))
    assert.equal(f.operations().some(op => op.operation !== 'probe'), false)
    if (options.cancelOperation) assert.equal(f.operations().length, 1)
  }
  const f = fixture()
  f.controller.abort()
  await assert.rejects(f.api.prepareAstraNativeJob(f.ctx), category('cancelled'))
  assert.equal(f.calls.length, 0)
})

test('successful build routes once and publishes exactly eleven byte-and-hash-verified outputs', async () => {
  const f = fixture()
  const result = await f.build()
  const manifest = f.manifest()
  assert.equal(result.ok, true)
  assert.equal(result.native, true)
  assert.equal(result.boardSource, 'astra-native')
  assert.equal(result.routedTraces, 17)
  assert.deepEqual(f.operations(), [
    { operation: 'prepare' }, { operation: 'route' }, { operation: 'import' }, { operation: 'finish' }, { operation: 'inspect' },
    { operation: 'render', side: 'top' }, { operation: 'render', side: 'bottom' },
    { operation: 'svg', side: 'top' }, { operation: 'svg', side: 'bottom' }, { operation: 'glb' },
  ])
  assert.equal(f.calls.filter(([type]) => type === 'validator').length, 1)
  assert.equal(f.phases().indexOf('validator'), f.phases().indexOf('inspect') + 1)
  assert.equal(f.phases().indexOf('render:top'), f.phases().indexOf('validator') + 1)
  assert.equal(f.calls.filter(([type]) => type === 'glb-evidence').length, 1)
  assert.equal(manifest.status, 'passed')
  assert.equal(manifest.routeAttempts, 1)
  assert.deepEqual(manifest.checks, { drcAvailable: true, drcErrors: 0, unrouted: 0, identityPreserved: true, exportsComplete: true })
  assert.deepEqual(manifest.artifacts.map(entry => entry.path).sort(), Object.keys(f.artifacts.ASTRA_OUTPUTS).sort())
  assert.equal(manifest.artifacts.length, 11)
  assert.equal(manifest.proposalSha256, hash(JSON.stringify(proposal)))
  assert.deepEqual(manifest.tools, Object.fromEntries(Object.entries(f.toolManifest.tools).map(([name, tool]) => [name, tool.sha256])))
  for (const entry of manifest.artifacts) {
    const bytes = f.files.get(`${RUNROOT}/${entry.path}`)
    assert.equal(entry.bytes, bytes.length)
    assert.equal(entry.sha256, hash(bytes))
  }
  assert.deepEqual(JSON.parse(f.files.get(`${JOB}/proposal.json`)), proposal)
  assert.deepEqual(JSON.parse(f.files.get(`${RUNROOT}/electronics/netlist.json`)), proposal)
  const input = JSON.parse(f.files.get(`${JOB}/native-input.json`))
  assert.deepEqual(input.parts, proposal.parts.map(part => ({ ref: part.name, catalogId: part.catalogId, value: part.value })))
  assert.deepEqual(input.nets, proposal.canonicalNets.map(net => ({ name: net.name, pins: net.pins.map(pin => { const [ref, pad] = pin.split('.'); return { ref, pad } }) })))
  assert.deepEqual(input.catalog, catalog.assets)
  assert.deepEqual(input.assetRoots, f.toolManifest.assetRoots)
  assert.equal(f.files.has(`${RUNROOT}/.astra-manifest.pending.json`), false)
  f.artifacts.parseAstraManifest(manifest, RUN)
  f.handlesClosed()
})

test('identity, board digest, input digest and explicit final native connectivity are mandatory', async () => {
  const mutations = [
    value => { delete value.version }, value => { value.stage = 'prepared' }, value => { value.routeAttempts = 0 },
    value => { value.identityPreserved = false }, value => { value.identityPreserved = 'true' },
    value => { value.boardSha256 = hash('other board') }, value => { value.inputSha256 = hash('other proposal') },
    value => { delete value.connectivity }, value => { value.connectivity = {} },
    value => { value.connectivity.available = false }, value => { delete value.connectivity.unrouted },
    ...[null, '0', -1, 0.1, Number.MAX_SAFE_INTEGER + 1].map(unrouted => value => { value.connectivity.unrouted = unrouted }),
  ]
  for (const mutateEvidence of mutations) {
    const f = fixture({ mutateEvidence })
    await assert.rejects(f.build(), category('output'))
    const manifest = f.manifest()
    assert.equal(manifest.status, 'failed')
    assert.equal(manifest.checks.identityPreserved, false)
    assert.equal(manifest.checks.drcErrors, null)
    assert.equal(manifest.checks.unrouted, null)
    assert.equal(manifest.routeAttempts, 1)
    assert.equal(f.operations().filter(op => op.operation === 'route').length, 1)
    assert.equal(f.calls.some(([type]) => type === 'validator'), false)
    f.handlesClosed()
  }
})

test('DRC errors and either connectivity measurement fail quality without discarding complete diagnostic exports', async () => {
  for (const options of [
    { drc: fullDrc({ violations: [drcEntry()] }) },
    { drc: fullDrc({ unconnected_items: [drcEntry(), drcEntry()] }) },
    { nativeUnrouted: 3 },
    { nativeUnrouted: 3, drc: fullDrc({ unconnected_items: [drcEntry()] }) },
  ]) {
    const f = fixture(options)
    assert.equal((await f.build()).ok, false)
    const manifest = f.manifest()
    assert.equal(manifest.status, 'failed')
    assert.equal(manifest.checks.exportsComplete, true)
    assert.equal(manifest.artifacts.length, 11)
    assert.equal(manifest.checks.unrouted, Math.max(options.nativeUnrouted ?? 0, options.drc?.unconnected_items.length ?? 0))
    assert.equal(f.operations().filter(op => op.operation === 'route').length, 1)
    f.artifacts.parseAstraManifest(manifest, RUN)
  }
})

test('missing DRC connectivity never passes and does not erase known native connectivity or start exports', async () => {
  const f = fixture({ nativeUnrouted: 2, drc: { violations: [] } })
  await assert.rejects(f.build(), category('output'))
  const manifest = f.manifest()
  assert.equal(manifest.status, 'failed')
  assert.equal(manifest.checks.drcAvailable, false)
  assert.equal(manifest.checks.drcErrors, null)
  assert.equal(manifest.checks.unrouted, 2)
  assert.equal(f.operations().some(op => ['render', 'svg', 'glb'].includes(op.operation)), false)
})

test('native unrouted measurement survives a later DRC failure without inventing DRC evidence', async () => {
  const f = fixture({ nativeUnrouted: 4, failOperation: 'validator' })
  await assert.rejects(f.build(), category('process'))
  const manifest = f.manifest()
  assert.equal(manifest.status, 'failed')
  assert.equal(manifest.checks.identityPreserved, true)
  assert.equal(manifest.checks.unrouted, 4)
  assert.equal(manifest.checks.drcAvailable, false)
  assert.equal(manifest.checks.drcErrors, null)
  assert.equal(manifest.checks.exportsComplete, false)
  assert.equal(f.phases().at(-1), 'validator')
  assert.equal(f.operations().filter(op => op.operation === 'route').length, 1)
  f.artifacts.parseAstraManifest(manifest, RUN)
  f.handlesClosed()
})

test('uncertain validator cleanup and mismatched receipt stop publication and all export work', async () => {
  for (const options of [
    { cleanupUnconfirmed: true },
    { mutateValidator: result => { result.accounting.cleanupConfirmed = false } },
    { mutateValidator: result => { result.receipt.cleanup.confirmedAbsent = false } },
    { mutateValidator: result => { result.receipt.boardSha256 = hash('different board') } },
    { mutateValidator: result => { result.receipt.nativeInputSha256 = hash('different input') } },
    { mutateValidator: result => { result.receipt.nativeEvidenceSha256 = hash('different inspection') } },
    { mutateValidator: result => { result.receipt.reportSha256 = hash('different report') } },
    { mutateValidator: result => { result.receipt.process.code = 1 } },
  ]) {
    const f = fixture(options)
    await assert.rejects(f.build(), category(options.cleanupUnconfirmed ? 'policy' : 'output'))
    assert.equal(f.manifest().status, options.cleanupUnconfirmed ? 'cancelled' : 'failed')
    assert.equal(f.calls.filter(([type]) => type === 'cleanup-block').length, options.cleanupUnconfirmed ? 1 : 0)
    assert.equal(f.manifest().checks.drcAvailable, false)
    assert.equal(f.manifest().checks.exportsComplete, false)
    assert.equal(f.manifest().artifacts.length, 0)
    assert.equal(f.calls.filter(([type]) => type === 'validator').length, 1)
    assert.equal(f.phases().at(-1), 'validator')
    assert.equal(f.operations().filter(operation => operation.operation === 'route').length, 1)
    f.handlesClosed()
  }
})

test('observed validator containment contradictions fail before report publication and exports', async () => {
  for (const mutate of [
    receipt => { delete receipt.container.hostConfig.NetworkMode },
    receipt => { receipt.container.hostConfig.NetworkMode = 'bridge' },
    receipt => { receipt.imageId = 'sha256:' + '0'.repeat(64) },
    receipt => { delete receipt.container.image },
    receipt => { delete receipt.container.mounts },
    receipt => { receipt.container.mounts[0].RW = true },
  ]) {
    const f = fixture({ mutateValidator: result => mutate(result.receipt) })
    await assert.rejects(f.build(), category('output'))
    assert.equal(f.phases().at(-1), 'validator')
    assert.equal(f.manifest().status, 'failed')
    assert.equal(f.manifest().checks.drcAvailable, false)
    assert.equal(f.manifest().artifacts.length, 0)
    assert.equal(f.files.has(`${JOB}/drc.json`), false)
    f.handlesClosed()
  }
})

test('real validator cleanup error latches before persistence; confirmed cleanup failure does not latch', async () => {
  const unsafe = fixture({ cleanupUnconfirmed: true })
  await assert.rejects(unsafe.build(), error => error.category === 'policy' && /cleanup is unconfirmed/.test(error.message))
  const block = unsafe.calls.findIndex(([type]) => type === 'cleanup-block')
  const nextPersistence = unsafe.calls.findIndex(([type], index) => index > block && ['write', 'remove'].includes(type))
  assert.ok(block >= 0 && nextPersistence > block)
  assert.equal(unsafe.ctx.signal.aborted, true)
  const confirmed = fixture({ confirmedValidatorFailure: true })
  await assert.rejects(confirmed.build(), category('process'))
  assert.equal(confirmed.calls.some(([type]) => type === 'cleanup-block'), false)
  assert.equal(confirmed.ctx.signal.aborted, false)
  assert.equal(confirmed.manifest().status, 'failed')
})

test('ignored or excluded strict DRC checks cannot pass even with zero errors and connectivity', async () => {
  for (const drc of [
    fullDrc({ ignored_checks: [{ key: 'clearance', description: 'Synthetic ignored check' }] }),
    fullDrc({ violations: [{ ...drcEntry('warning'), excluded: true }] }),
  ]) {
    const f = fixture({ drc })
    const result = await f.build()
    assert.equal(result.ok, false)
    assert.equal(result.drc.checksComplete, false)
    assert.equal(result.drc.errors, 0)
    assert.equal(f.manifest().status, 'failed')
    assert.equal(f.manifest().checks.exportsComplete, true)
    assert.equal(f.manifest().artifacts.length, 11)
    assert.equal(f.calls.filter(([type]) => type === 'validator').length, 1)
    f.handlesClosed()
  }
  const spoof = fixture({
    drc: fullDrc({ ignored_checks: [{ key: 'clearance', description: 'Synthetic ignored check' }] }),
    mutateValidator: result => { result.receipt.checksComplete = true },
  })
  await assert.rejects(spoof.build(), category('output'))
  assert.equal(spoof.manifest().checks.drcAvailable, false)
  assert.equal(spoof.phases().at(-1), 'validator')
})

test('cancellation after validator and report persistence failure cannot start exports', async () => {
  for (const options of [{ cancelOperation: 'validator' }, { failWrite: `${JOB}/drc.json` }]) {
    const f = fixture(options)
    await assert.rejects(f.build(), category(options.cancelOperation ? 'cancelled' : 'process'))
    assert.equal(f.manifest().status, options.cancelOperation ? 'cancelled' : 'failed')
    assert.equal(f.manifest().checks.drcAvailable, false)
    assert.equal(f.manifest().artifacts.length, 0)
    assert.equal(f.phases().at(-1), 'validator')
    assert.equal(f.operations().filter(operation => operation.operation === 'route').length, 1)
    f.handlesClosed()
  }
})

test('independent GLB evidence gate failure cannot publish complete or passed', async () => {
  const f = fixture({ failGlbEvidence: true })
  await assert.rejects(f.build(), category('output'))
  assert.equal(f.calls.filter(([type]) => type === 'glb-evidence').length, 1)
  assert.equal(f.manifest().status, 'failed')
  assert.equal(f.manifest().checks.exportsComplete, false)
  assert.equal(f.manifest().artifacts.some(artifact => artifact.path === 'board/chipscale.glb'), false)
  f.handlesClosed()
})

test('DRC bytes changed during render or copying cannot be published as passed', async () => {
  for (const options of [{ mutateDrcOperation: 'render:top' }, { mutateBeforePublication: 'drc.json' }]) {
    const f = fixture(options)
    await assert.rejects(f.build(), category('output'))
    const manifest = f.manifest()
    assert.equal(manifest.status, 'failed')
    assert.equal(manifest.checks.exportsComplete, false)
    assert.equal(manifest.artifacts.some(entry => entry.path === 'electronics/drc.json'), false)
    assert.equal(f.files.has(`${RUNROOT}/electronics/drc.json`), false)
    assert.equal(f.operations().filter(op => op.operation === 'route').length, 1)
    for (const entry of manifest.artifacts) assert.equal(hash(f.files.get(`${RUNROOT}/${entry.path}`)), entry.sha256)
    f.artifacts.parseAstraManifest(manifest, RUN)
    f.handlesClosed()
  }
})

test('each native phase failure submits no retry or extra route and publishes only failure evidence', async () => {
  for (const failOperation of ['prepare', 'route', 'import', 'finish', 'inspect', 'validator', 'render:top', 'render:bottom', 'svg:top', 'svg:bottom', 'glb']) {
    const f = fixture({ failOperation })
    await assert.rejects(f.build(), category('process'))
    const manifest = f.manifest()
    assert.equal(manifest.status, 'failed')
    assert.equal(manifest.checks.exportsComplete, false)
    assert.equal(manifest.routeAttempts, failOperation === 'prepare' ? 0 : 1)
    assert.ok(f.operations().filter(op => op.operation === 'route').length <= 1)
    assert.equal(f.phases().at(-1), failOperation)
    f.artifacts.parseAstraManifest(manifest, RUN)
    f.handlesClosed()
  }
})

test('cancellation after import prevents finish and never submits another route', async () => {
  const f = fixture({ cancelOperation: 'import' })
  await assert.rejects(f.build(), category('cancelled'))
  assert.deepEqual(f.operations(), [{ operation: 'prepare' }, { operation: 'route' }, { operation: 'import' }])
  assert.equal(f.manifest().status, 'cancelled')
  assert.equal(f.manifest().routeAttempts, 1)
  assert.equal(f.manifest().checks.identityPreserved, false)
  assert.equal(f.manifest().checks.exportsComplete, false)
  f.handlesClosed()
})

test('cancellation after inspect prevents DRC and exports without retrying native operations', async () => {
  const f = fixture({ cancelOperation: 'inspect' })
  await assert.rejects(f.build(), category('cancelled'))
  assert.deepEqual(f.operations(), ['prepare', 'route', 'import', 'finish', 'inspect'].map(operation => ({ operation })))
  assert.equal(f.manifest().status, 'cancelled')
  assert.equal(f.manifest().routeAttempts, 1)
  assert.equal(f.manifest().checks.drcAvailable, false)
  assert.equal(f.manifest().checks.exportsComplete, false)
  assert.equal(f.manifest().artifacts.length, 0)
  f.handlesClosed()
})

test('invalid exports retain verified partial artifacts without claiming complete or passed', async () => {
  for (const options of [{ png: Buffer.from('not PNG') }, { svg: '<svg><script>bad()</script></svg>' }, { svg: '<svg><image href="https://example.test/x"/></svg>' }, { glb: Buffer.from('invalid') }, { glb: glb({ meshes: [] }) }, { glb: glb({ meshes: [{}], buffers: [{ uri: 'https://example.test/x' }] }) }]) {
    const f = fixture(options)
    await assert.rejects(f.build(), category('output'))
    const manifest = f.manifest()
    assert.equal(manifest.status, 'failed')
    assert.equal(manifest.checks.exportsComplete, false)
    assert.ok(manifest.artifacts.length >= 5 && manifest.artifacts.length < 11)
    for (const entry of manifest.artifacts) {
      const bytes = f.files.get(`${RUNROOT}/${entry.path}`)
      assert.equal(hash(bytes), entry.sha256)
      assert.equal(bytes.length, entry.bytes)
    }
    f.artifacts.parseAstraManifest(manifest, RUN)
    f.handlesClosed()
  }
})

test('job output hardlinks and mutation during bounded reads fail before native identity acceptance', async () => {
  for (const options of [{ hardlink: `${JOB}/final-board.kicad_pcb` }, { changeDuringRead: `${JOB}/final-board.kicad_pcb` }]) {
    const f = fixture(options)
    await assert.rejects(f.build(), category('output'))
    assert.equal(f.manifest().status, 'failed')
    assert.equal(f.manifest().checks.identityPreserved, false)
    f.handlesClosed()
  }
})

test('cancellation during exports and after success rename replaces the marker with cancelled partial evidence', async () => {
  for (const options of [{ cancelOperation: 'render:top' }, { cancelWrite: `${RUNROOT}/electronics/netlist.json` }, { cancelAfterPublication: true }]) {
    const f = fixture(options)
    await assert.rejects(f.build(), category('cancelled'))
    const manifest = f.manifest()
    assert.equal(manifest.status, 'cancelled')
    assert.equal(manifest.checks.exportsComplete, false)
    if (options.cancelWrite) assert.ok(manifest.artifacts.length >= 2)
    if (options.cancelAfterPublication) assert.equal(manifest.artifacts.length, 11)
    for (const entry of manifest.artifacts) assert.equal(hash(f.files.get(`${RUNROOT}/${entry.path}`)), entry.sha256)
    assert.equal(f.files.has(`${RUNROOT}/.astra-manifest.pending.json`), false)
    assert.equal(f.operations().filter(op => op.operation === 'route').length, 1)
    f.artifacts.parseAstraManifest(manifest, RUN)
    f.handlesClosed()
  }
})

test('DRC or render operations cannot mutate the board after finish and still publish passed', async () => {
  for (const mutateBoardOperation of ['validator', 'render:top', 'render:bottom', 'svg:top', 'svg:bottom', 'glb']) {
    const f = fixture({ mutateBoardOperation })
    await assert.rejects(f.build(), category('output'))
    assert.equal(f.manifest().status, 'failed')
    assert.equal(f.manifest().checks.exportsComplete, false)
    assert.equal(f.operations().filter(op => op.operation === 'route').length, 1)
    f.handlesClosed()
  }
})

test('publication cannot claim passed for board, proposal or evidence mutated after identity validation', async () => {
  for (const mutateBeforePublication of ['final-board.kicad_pcb', 'proposal.json', 'native-evidence.json']) {
    const f = fixture({ mutateBeforePublication })
    try { await f.build() } catch (error) {
      assert.ok(error instanceof AstraError)
      assert.notEqual(f.manifest().status, 'passed')
      continue
    }
    // Retaining verified buffers is also safe; publication must remain bound to them.
    const manifest = f.manifest()
    const native = JSON.parse(f.files.get(`${RUNROOT}/electronics/native-evidence.json`))
    const publishedBoard = f.files.get(`${RUNROOT}/electronics/chipscale.kicad_pcb`)
    const publishedProposal = f.files.get(`${RUNROOT}/electronics/netlist.json`)
    assert.equal(hash(publishedBoard), native.boardSha256)
    assert.equal(hash(publishedProposal), manifest.proposalSha256)
    assert.equal(native.inputSha256, hash(f.files.get(`${JOB}/native-input.json`)))
  }
})

test('publication rename failure cleans pending marker and publishes failed rather than stale success', async () => {
  const f = fixture({ failFirstPublication: true })
  await assert.rejects(f.build(), category('process'))
  const manifest = f.manifest()
  assert.equal(manifest.status, 'failed')
  assert.equal(manifest.checks.exportsComplete, false)
  assert.equal(manifest.artifacts.length, 11)
  assert.equal(f.files.has(`${RUNROOT}/.astra-manifest.pending.json`), false)
  assert.equal(f.operations().filter(op => op.operation === 'route').length, 1)
  f.artifacts.parseAstraManifest(manifest, RUN)
})
