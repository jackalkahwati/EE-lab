import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, constants } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

// Pure in-memory qualification fixtures. No real receipt is ever minted and no
// host qualification, native binary, private store or network endpoint is read.
const ROOT = '/virtual/readiness-app', HOME = `${ROOT}/.astra-home`, BUNDLE = `${HOME}/qualifications/fixture-qualification`
const UID = 501, NOW = Date.parse('2026-09-14T12:00:00.000Z')
const hash = data => createHash('sha256').update(data).digest('hex')
const plain = value => JSON.parse(JSON.stringify(value))
const catalog = JSON.parse(readFileSync(new URL('../lib/astra-catalog.json', import.meta.url), 'utf8'))
const names = ['astra-readiness', 'astra-project-policy', 'astra-ground-evidence', 'astra-drc', 'astra-validator-evidence', 'astra-validator-containment']
const compiled = new Map(names.map(name => [name, ts.transpileModule(readFileSync(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText]))
class AstraError extends Error { constructor(category, message) { super(message); this.category = category } }
const policyError = error => ['policy', 'output'].includes(error?.category)
const project = () => ({ board: { design_settings: {
  rule_severities: Object.fromEntries(['missing_courtyard', 'track_not_centered_on_via', 'tuning_profile_track_geometries', 'footprint_filters_mismatch', 'footprint_type_mismatch'].map(name => [name, 'error'])),
  rules: { min_resolved_spokes: 2, min_clearance: 0.15, min_track_width: 0.15, min_via_diameter: 0.6, min_through_hole_diameter: 0.3, min_via_annular_width: 0.15, min_hole_clearance: 0.25, min_hole_to_hole: 0.25, min_copper_edge_clearance: 0.5 }, drc_exclusions: [],
} } })
function fixture() {
  const files = new Map(), modes = new Map(), links = new Map(), calls = []
  const state = { now: NOW, glbInvalid: false, renameFailure: false, oversized: null, readMutation: null, opened: 0, closed: 0 }
  const put = (name, value) => files.set(name, Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)))
  const stat = name => ({ uid: UID, mode: modes.get(name) ?? (files.has(name) ? 0o600 : 0o700), dev: 1, ino: name,
    size: state.oversized === name ? 1024 ** 3 : files.get(name)?.length ?? 0, nlink: 1, mtimeMs: 1, ctimeMs: 1,
    isFile: () => files.has(name), isDirectory: () => !files.has(name), isSymbolicLink: () => links.has(name) })
  const io = {
    realpath: async name => { calls.push(['realpath', name]); return links.get(name) || name },
    lstat: async name => {
      calls.push(['lstat', name])
      if (name === `${HOME}/astra-readiness.json` && !files.has(name)) throw Object.assign(new Error('fixture missing'), { code: 'ENOENT' })
      return stat(name)
    },
    open: async (name, flags) => {
      calls.push(['open', name, flags])
      assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      if (!files.has(name)) throw Object.assign(new Error('fixture missing'), { code: 'ENOENT' })
      const snapshot = Buffer.from(files.get(name)); let reads = 0
      state.opened++
      return {
        stat: async () => ({ ...stat(name), ctimeMs: state.readMutation === name && reads ? 2 : 1 }),
        read: async (buffer, offset, length, position) => {
          reads++
          assert.ok(buffer.length <= Math.max(snapshot.length + 1, 65536))
          const bytesRead = Math.max(0, Math.min(length, snapshot.length - position))
          snapshot.copy(buffer, offset, position, position + bytesRead)
          return { bytesRead }
        }, close: async () => { state.closed++ },
      }
    },
    writeFile: async (name, data, options) => {
      calls.push(['write', name, options])
      assert.ok(name.startsWith(`${HOME}/.astra-readiness-`))
      assert.deepEqual(plain(options), { flag: 'wx', mode: 0o600 })
      assert.equal(files.has(name), false)
      put(name, data)
    },
    rename: async (from, to) => {
      calls.push(['rename', from, to])
      assert.equal(to, `${HOME}/astra-readiness.json`)
      if (state.renameFailure) throw new Error('fixture rename failure')
      files.set(to, files.get(from)); files.delete(from)
    },
    rm: async name => { calls.push(['remove', name]); assert.ok(name.startsWith(`${HOME}/.astra-readiness-`)); files.delete(name) },
  }
  const testCatalog = plain(catalog)
  for (const asset of Object.values(testCatalog.assets)) {
    for (const entry of [asset.footprint, ...asset.models]) { put(entry.path, entry.path); entry.sha256 = hash(entry.path) }
  }
  const pins = { scripts: { native: hash('source:scripts/astra-native.py'), probe: hash('source:scripts/astra-sandbox-probe.py') },
    tools: { native: { path: '/virtual/tool', sha256: hash('tool') } }, libraries: { pcb: { path: '/virtual/plugin', sha256: hash('plugin') } }, assetRoots: ['/virtual/reviewed-assets'] }
  put('/virtual/tool', 'tool'); put('/virtual/plugin', 'plugin')
  class Clock extends Date { static now() { return state.now } }
  let serial = 0
  const context = vm.createContext({ Buffer, Error, Date: Clock, process: { getuid: () => UID } })
  function load(name, dependencies) {
    const loaded = { exports: {} }
    const require = dependency => { assert.ok(Object.hasOwn(dependencies, dependency), `Unmocked import ${dependency}`); return dependencies[dependency] }
    vm.runInContext(`(function(require,module,exports){${compiled.get(name)}\n})`, context, { filename: `${name}.ts` })(require, loaded, loaded.exports)
    return loaded.exports
  }
  const execution = { AstraError }, parts = { ASTRA_CATALOG: testCatalog }
  const policy = load('astra-project-policy', { './astra-execution': execution, './astra-local-parts': parts })
  const ground = load('astra-ground-evidence', { './astra-execution': execution })
  const drc = load('astra-drc', {})
  const containment = load('astra-validator-containment', {})
  const validator = load('astra-validator-evidence', { 'node:crypto': { createHash }, './astra-execution': execution, './astra-drc': drc, './astra-validator-containment': containment })
  const api = load('astra-readiness', {
    'node:fs/promises': io, 'node:fs': { constants }, 'node:path': path,
    'node:crypto': { createHash, randomUUID: () => `fixture-${++serial}` },
    './astra-beta': { astraWorkspace: () => ({ root: ROOT, home: HOME }) }, './astra-execution': execution,
    './astra-local-parts': parts, './astra-native-pins.json': pins,
    './astra-project-policy': policy, './astra-ground-evidence': ground, './astra-validator-evidence': validator,
    './astra-export-evidence': { validateAstraGlb: (bytes, options) => {
      calls.push(['validateGlb'])
      assert.equal(bytes.toString(), 'fixture GLB validator input')
      assert.equal(options.engineVersion, '10.0.1')
      assert.equal(options.nativeEvidence.boardSha256, hash(options.boardText))
      assert.deepEqual(plain(options.catalog), testCatalog)
      if (state.glbInvalid) throw new Error('fixture semantic geometry rejection')
      return { identityPreserved: true, componentCount: 6 }
    } },
  })
  const sourceHashes = {}
  for (const name of api.ASTRA_READINESS_SOURCES) { put(`${ROOT}/${name}`, `source:${name}`); sourceHashes[name] = hash(`source:${name}`) }
  const make = (name, value) => put(`${BUNDLE}/${name}`, value)
  for (const name of Object.keys(api.ASTRA_QUALIFICATION_FILES).filter(name => name.endsWith('-process.json'))) make(name, { stdout: 'raw fixture only', stderr: '', code: 0 })
  make('native-input.json', { catalog: testCatalog.assets })
  make('final-board.kicad_pcb', '(kicad_pcb fixture)')
  make('final-board.kicad_pro', project())
  make('fp-lib-table', policy.expectedAstraFootprintTable())
  const groundPads = ['C1.2', 'C2.2', 'J1.2', 'U1.1', 'U1.5', 'U1.7']
  const fileHash = name => hash(files.get(`${BUNDLE}/${name}`))
  const evidence = { version: 1, stage: 'finished', routeAttempts: 1, identityPreserved: true,
    inputSha256: fileHash('native-input.json'), boardSha256: fileHash('final-board.kicad_pcb'), projectSha256: fileHash('final-board.kicad_pro'), tableSha256: fileHash('fp-lib-table'),
    connectivity: { available: true, unrouted: 0 }, groundConnectivity: { available: true, anchor: 'J1.2', method: 'native-effective-shape-polygon-components-v1', reachedPads: groundPads, unreachedPads: [], padComponents: [groundPads] },
    preparedBoardSha256: hash('prepared board'), preparedProjectSha256: hash('prepared project'), dsnSha256: hash('dsn'), sesSha256: hash('ses'),
    reservedCopperPreserved: true, reservedCopper: [{ uuid: 'fixture-locked-copper', locked: true }], identity: { fixture: 'same prepared and inspected identity' } }
  make('native-evidence.json', evidence)
  const auth = { schema: 'astra-linux-job/v1', jobId: 'astra-linux-job-12345678', image: 'kicad/kicad@sha256:fdcfa0e8d41f640d16edfb28e027fe8862ab31af9e45dcacbc662cec5c916e4c',
    boardSha256: fileHash('final-board.kicad_pcb'), nativeInputSha256: fileHash('native-input.json'), nativeEvidenceSha256: fileHash('native-evidence.json'), catalogSha256: sourceHashes['lib/astra-catalog.json'],
    inputHashes: Object.fromEntries(['final-board.kicad_pcb', 'final-board.kicad_pro', 'fp-lib-table'].map(name => [name, fileHash(name)])),
    assetHashes: Object.fromEntries(Object.values(testCatalog.assets).flatMap(asset => [asset.footprint, ...asset.models]).map(pin => [path.relative('/Applications/KiCad/KiCad.app/Contents/SharedSupport', pin.path), pin.sha256])),
    policy: { schematicParity: 'not-run', includedSeverities: ['error', 'warning', 'exclusion'], ignoredChecksAllowed: false, excludedAllowed: false } }
  make('linux-authorization.json', auth)
  const report = { $schema: 'https://schemas.kicad.org/drc.v1.json', source: 'final-board.kicad_pcb', date: '2026-09-14T10:00:00', kicad_version: '10.0.5',
    coordinate_units: 'mm', included_severities: ['error', 'warning', 'exclusion'], ignored_checks: [],
    violations: [{ type: 'fixture_warning', description: 'disclosed fixture warning', severity: 'warning', items: [] }], unconnected_items: [], schematic_parity: [] }
  make('drc.json', report)
  const receipt = { schema: 'astra-linux-job-runtime/v1', jobId: auth.jobId, image: auth.image,
    boardSha256: auth.boardSha256, nativeInputSha256: auth.nativeInputSha256, nativeEvidenceSha256: auth.nativeEvidenceSha256, catalogSha256: auth.catalogSha256,
    authorizationSha256: fileHash('linux-authorization.json'), controllerSha256: sourceHashes['scripts/astra-linux-runtime.mjs'], reportSha256: fileHash('drc.json'),
    startedAt: '2026-09-14T10:00:00.000Z', finishedAt: '2026-09-14T10:01:00.000Z',
    executionComplete: true, checksComplete: true, boardPassed: true, inputsUnchanged: true,
    process: { code: 0, reason: null, signal: null }, finalState: { Running: false, OOMKilled: false, ExitCode: 0 }, cleanup: { confirmedAbsent: true },
    schematicParity: 'not-run', nativeConnectivity: evidence.connectivity, groundConnectivity: evidence.groundConnectivity,
    findings: plain(drc.parseAstraDrcReport(report, { engineVersion: '10.0.5', source: 'final-board.kicad_pcb', schematicParity: 'not-run' })) }
  // Explicit recorded-control fixture; the real containment validator checks all
  // values. This is not a mocked pass or an actual Docker observation.
  const jobRoot = `${containment.ASTRA_VALIDATOR_JOB_ROOT}/${auth.jobId}`
  const mounts = [
    { source: `${jobRoot}/input`, destination: '/input', writable: false },
    { source: `${jobRoot}/assets`, destination: '/Applications/KiCad/KiCad.app/Contents/SharedSupport', writable: false },
    { source: `${jobRoot}/output`, destination: '/output', writable: true },
  ]
  receipt.imageId = containment.ASTRA_VALIDATOR_IMAGE_ID
  receipt.engine = { ID: 'fixture-engine', Name: 'docker-desktop', OSType: 'linux', Architecture: 'aarch64' }
  receipt.createArgs = plain(containment.expectedAstraValidatorCreateArgs(auth.jobId, 'astra-drc-12345678-0123456789abcdef'))
  receipt.container = { id: 'a'.repeat(64), image: containment.ASTRA_VALIDATOR_IMAGE_ID,
    hostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges=true'],
      NanoCpus: 2000000000, Memory: 2147483648, MemorySwap: 2147483648, PidsLimit: 128, ShmSize: 16777216, OomKillDisable: false,
      CpuPeriod: 0, CpuQuota: 0, CpuRealtimePeriod: 0, CpuRealtimeRuntime: 0, CpusetCpus: '', CpusetMems: '',
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=134217728,mode=1777' }, LogConfig: { Type: 'none', Config: {} },
      Ulimits: [{ Name: 'core', Hard: 0, Soft: 0 }, { Name: 'fsize', Hard: 33554432, Soft: 33554432 }],
      Binds: null, VolumesFrom: null, Devices: [], DeviceCgroupRules: null, DeviceRequests: null, Links: null, ExtraHosts: null, GroupAdd: null,
      PortBindings: {}, PublishAllPorts: false, PidMode: '', IpcMode: 'private', CgroupnsMode: 'private', UTSMode: '', UsernsMode: '',
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, AutoRemove: false,
      Mounts: mounts.map(mount => ({ Type: 'bind', Source: mount.source, Target: mount.destination, ReadOnly: !mount.writable })),
    }, mounts: mounts.map(mount => ({ Type: 'bind', Source: mount.source, Destination: mount.destination, RW: mount.writable, Propagation: 'rprivate', Mode: '' })),
  }
  make('linux-runtime-receipt.json', receipt)
  for (const side of ['top', 'bottom']) { make(`${side}.png`, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); make(`${side}.svg`, '<svg><path/></svg>') }
  make('board.glb', 'fixture GLB validator input')
  const historicalTools = { schema: 'astra-native-tools/v1', platform: 'darwin', tools: pins.tools,
    scripts: { native: { path: '/virtual/historical/astra-native.py', sha256: pins.scripts.native }, probe: { path: '/virtual/historical/astra-sandbox-probe.py', sha256: pins.scripts.probe } },
    assetRoots: pins.assetRoots, containment: 'verified', capabilities: ['python-version', 'pcbnew', 'kicad-version', 'router-help', 'render-help', 'glb-help', 'svg-help', 'drc-help'] }
  for (const name of ['native-tools.json', 'continued-native-tools.json', 'export-tools.json']) make(name, historicalTools)
  make('native-test-provenance.json', { sourceSha256: pins.scripts.native, inputSha256: fileHash('native-input.json'), maximumRouteAttempts: 1 })
  const prepared = { version: 1, stage: 'prepared', routeAttempts: 0, inputSha256: evidence.inputSha256, tableSha256: evidence.tableSha256,
    boardSha256: evidence.preparedBoardSha256, projectSha256: evidence.preparedProjectSha256, dsnSha256: evidence.dsnSha256,
    reservedCopper: evidence.reservedCopper, identity: evidence.identity }
  const imported = { version: 1, stage: 'imported', inputSha256: evidence.inputSha256, tableSha256: evidence.tableSha256,
    preparedBoardSha256: evidence.preparedBoardSha256, preparedProjectSha256: evidence.preparedProjectSha256,
    dsnSha256: evidence.dsnSha256, sesSha256: evidence.sesSha256, importedBoardSha256: hash('imported board'), importedProjectSha256: hash('imported project') }
  make('prepared-evidence.json', prepared)
  make('import-evidence.json', imported)
  make('fill-evidence.json', { ...imported, stage: 'filled', boardSha256: evidence.boardSha256, projectSha256: evidence.projectSha256 })
  const phaseNames = ['prepare-postexit-policy.json', 'route-continued-postexit-policy.json', 'import-continued-postexit-policy.json', 'finish-continued-postexit-policy.json', 'inspect-continued-postexit-policy.json']
  const projects = { 'board.kicad_pro': prepared.projectSha256 }
  for (let i = 0; i < phaseNames.length; i++) {
    if (i === 2) projects['imported-board.kicad_pro'] = imported.importedProjectSha256
    if (i === 3) projects['final-board.kicad_pro'] = evidence.projectSha256
    make(phaseNames[i], { verified: true, projects, tableSha256: evidence.tableSha256 })
  }
  const exportSources = Object.fromEntries(['final-board.kicad_pcb', 'final-board.kicad_pro', 'native-input.json', 'native-evidence.json', 'fill-evidence.json', 'fp-lib-table'].map(name => [name, fileHash(name)]))
  make('export-source-provenance.json', { source: '/virtual/actual-qualification-source', sourceSha256: exportSources })
  for (const name of Object.keys(api.ASTRA_QUALIFICATION_FILES).filter(name => name.endsWith('-hash-guard.json'))) make(name, { verified: true, sourceSha256: exportSources })
  make('export-inspection.json', { schema: 'native-export-inspection/v1', sourceBoardSha256: fileHash('final-board.kicad_pcb'), glbSha256: fileHash('board.glb') })
  const index = { version: 1, qualificationScope: 'native-backend', provenanceTrust: 'operator-assembled-local-evidence', sourceHashesRole: 'current-verifier-baseline', qualifiedAt: '2026-09-14T11:00:00.000Z', sourceHashes, files: {} }
  const reindex = () => { index.files = Object.fromEntries(Object.keys(api.ASTRA_QUALIFICATION_FILES).map(name => [name, fileHash(name)])); make('qualification.json', index) }
  reindex()
  const mutate = (name, edit, updateIndex = true) => { const value = JSON.parse(files.get(`${BUNDLE}/${name}`)); edit(value); make(name, value); if (updateIndex) reindex() }
  return { api, files, modes, links, calls, state, make, mutate, index, reindex, fileHash, put, bundle: BUNDLE,
    verify: () => api.verifyAstraQualification(BUNDLE), handlesClosed: () => assert.equal(state.opened, state.closed) }
}

test('readiness verifies existing evidence read-only, publishes only opaque capability and discloses warning', async () => {
  const f = fixture()
  assert.equal((await f.api.readAstraReadiness()).ready, false)
  const capability = await f.verify()
  assert.equal(Object.isFrozen(capability), true)
  assert.deepEqual(Object.keys(capability), [])
  assert.equal(f.calls.some(([name]) => ['write', 'rename', 'remove'].includes(name)), false)
  await f.api.publishAstraReadiness(capability)
  assert.equal((await f.api.readAstraReadiness()).ready, true)
  const status = await f.api.readAstraReadiness()
  assert.equal(status.warnings, 1)
  assert.equal(status.physicalFunctionVerified, false)
  assert.equal(status.expiresAt, '2026-09-15T10:01:00.000Z')
  await assert.rejects(f.api.publishAstraReadiness(capability), policyError)
  await assert.rejects(f.api.publishAstraReadiness({}), policyError)
  f.handlesClosed()
})

test('status performs no writes or native work and forged receipt fields never bypass verification', async () => {
  const f = fixture()
  await f.api.publishAstraReadiness(await f.verify())
  f.calls.length = 0
  assert.equal((await f.api.readAstraReadiness()).ready, true)
  assert.equal(f.calls.some(([name]) => ['write', 'rename', 'remove'].includes(name)), false)
  const receipt = JSON.parse(f.files.get(`${HOME}/astra-readiness.json`))
  receipt.warnings = 0
  f.put(`${HOME}/astra-readiness.json`, receipt)
  assert.equal((await f.api.readAstraReadiness()).ready, false)
})

test('expiry, future timestamps and source/tool/asset drift block readiness and do not refresh it', async () => {
  for (const drift of ['expiry', 'source', 'tool', 'asset']) {
    const f = fixture()
    await f.api.publishAstraReadiness(await f.verify())
    if (drift === 'expiry') f.state.now += 24 * 60 * 60 * 1000
    if (drift === 'source') f.put(`${ROOT}/scripts/astra-native.py`, 'changed source')
    if (drift === 'tool') f.put('/virtual/tool', 'changed executable')
    if (drift === 'asset') f.put(catalog.assets.bme280.footprint.path, 'changed footprint')
    f.calls.length = 0
    assert.equal((await f.api.readAstraReadiness()).ready, false)
    assert.equal(f.calls.some(([name]) => ['write', 'rename', 'remove'].includes(name)), false)
  }
  const f = fixture()
  f.index.qualifiedAt = '2026-09-15T11:00:00.000Z'; f.reindex()
  await assert.rejects(f.verify(), policyError)
})

test('electrical validation, execution, workspace, origin and IPC policy drift invalidate current readiness', async () => {
  for (const name of ['lib/astra-local-parts.ts', 'lib/astra-execution.ts', 'lib/astra-beta.ts', 'lib/astra-origin.ts', 'lib/astra-validator-client.ts']) {
    const f = fixture()
    assert.ok(f.api.ASTRA_READINESS_SOURCES.includes(name))
    await f.api.publishAstraReadiness(await f.verify())
    f.put(`${ROOT}/${name}`, `modified policy: ${name}`)
    f.calls.length = 0
    assert.equal((await f.api.readAstraReadiness()).ready, false, name)
    assert.equal(f.calls.some(([operation]) => ['write', 'rename', 'remove'].includes(operation)), false)
  }
})

test('bundle paths, symlinks, permissions, missing bytes, oversize and changed reads reject', async () => {
  for (const root of ['/outside/fixture', `${HOME}/qualifications/../fixture`, `${HOME}/qualifications/short`]) {
    await assert.rejects(fixture().api.verifyAstraQualification(root), policyError)
  }
  for (const target of [HOME, `${HOME}/qualifications`, BUNDLE, `${BUNDLE}/drc.json`]) {
    const f = fixture(); f.links.set(target, '/virtual/alias')
    await assert.rejects(f.verify(), policyError)
  }
  for (const target of [HOME, BUNDLE, `${BUNDLE}/drc.json`]) {
    const f = fixture(); f.modes.set(target, 0o755)
    await assert.rejects(f.verify(), policyError)
  }
  for (const condition of ['missing', 'oversized', 'mutation']) {
    const f = fixture(), target = `${BUNDLE}/drc.json`
    if (condition === 'missing') f.files.delete(target)
    if (condition === 'oversized') f.state.oversized = target
    if (condition === 'mutation') f.state.readMutation = target
    await assert.rejects(f.verify())
    f.handlesClosed()
  }
})

test('every raw native/export process record is required and failed exits cannot be replaced by claimed readiness', async () => {
  const prototype = fixture()
  const processNames = Object.keys(prototype.api.ASTRA_QUALIFICATION_FILES).filter(name => name.endsWith('-process.json'))
  assert.equal(processNames.length, 10)
  for (const name of processNames) {
    const f = fixture()
    f.mutate(name, process => { process.code = -11 })
    await assert.rejects(f.verify(), policyError)
  }
  for (const field of ['stdout', 'stderr', 'code']) {
    const f = fixture(); f.mutate('prepare-process.json', process => { delete process[field] })
    await assert.rejects(f.verify(), policyError)
  }
  const f = fixture(); f.mutate('glb-process.json', process => { process.signal = 'SIGSEGV' })
  await assert.rejects(f.verify(), policyError)
})

test('independent raw DRC report, controller completion, cleanup and native bindings are mandatory', async () => {
  for (const change of [
    x => { x.boardPassed = false }, x => { x.executionComplete = false }, x => { x.checksComplete = false }, x => { x.inputsUnchanged = false },
    x => { x.cleanup.confirmedAbsent = false }, x => { x.process.signal = 'SIGSEGV' }, x => { x.process.code = 1 },
    x => { x.finalState.OOMKilled = true }, x => { x.finalState.Running = true }, x => { x.cancelled = true },
    x => { x.reportSha256 = hash('other report') }, x => { x.controllerSha256 = hash('other controller') }, x => { x.failure = 'failed' },
  ]) {
    const f = fixture(); f.mutate('linux-runtime-receipt.json', change)
    await assert.rejects(f.verify(), policyError)
  }
  const f = fixture()
  f.mutate('drc.json', report => { delete report.unconnected_items })
  f.mutate('linux-runtime-receipt.json', receipt => { receipt.reportSha256 = f.fileHash('drc.json') })
  await assert.rejects(f.verify())
  const changed = fixture()
  changed.mutate('native-evidence.json', evidence => { evidence.boardSha256 = hash('other board') })
  await assert.rejects(changed.verify(), policyError)
})

test('actual containment observations must agree with pinned image and requested native sandbox', async () => {
  for (const change of [
    x => { delete x.container }, x => { delete x.createArgs }, x => { delete x.imageId },
    x => { x.imageId = 'sha256:' + 'b'.repeat(64) }, x => { x.container.image = 'sha256:' + 'b'.repeat(64) },
    x => { x.container.hostConfig.NetworkMode = 'host' }, x => { x.container.hostConfig.ReadonlyRootfs = false },
    x => { x.container.hostConfig.Privileged = true }, x => { x.container.hostConfig.CapDrop = [] },
    x => { x.container.hostConfig.SecurityOpt = [] }, x => { x.container.hostConfig.PidsLimit = 1024 },
    x => { x.container.mounts[0].RW = true }, x => { x.container.mounts[0].Source = '/private/user-data' },
    x => { x.container.hostConfig.Mounts.push({ Type: 'bind', Source: '/etc', Target: '/extra' }) },
    x => { x.createArgs[x.createArgs.indexOf('--network') + 1] = 'host' }, x => { x.container.user = '0:0' },
  ]) {
    const f = fixture(); f.mutate('linux-runtime-receipt.json', change)
    await assert.rejects(f.verify(), policyError)
  }
})

test('project policy and exact URI mapping reject weakening even when bundle hashes are recomputed', async () => {
  for (const change of [x => { x.board.design_settings.rules.min_resolved_spokes = 0 }, x => { x.board.design_settings.rule_severities.missing_courtyard = 'ignore' }]) {
    const f = fixture(); f.mutate('final-board.kicad_pro', change)
    f.mutate('native-evidence.json', evidence => { evidence.projectSha256 = f.fileHash('final-board.kicad_pro') })
    await assert.rejects(f.verify())
  }
  const f = fixture(); f.make('fp-lib-table', 'unreviewed URI')
  f.mutate('native-evidence.json', evidence => { evidence.tableSha256 = f.fileHash('fp-lib-table') })
  await assert.rejects(f.verify(), policyError)
})

test('all five exports are required and geometry-validator rejection blocks a receipt', async () => {
  for (const name of ['top.png', 'bottom.png', 'top.svg', 'bottom.svg', 'board.glb']) {
    const f = fixture(); f.files.delete(`${BUNDLE}/${name}`)
    await assert.rejects(f.verify())
  }
  const f = fixture(); f.state.glbInvalid = true
  await assert.rejects(f.verify(), /geometry rejection/)
  for (const [name, content] of [['top.png', 'not PNG'], ['bottom.svg', '<svg><image href="https://example.test"/></svg>']]) {
    const f = fixture(); f.make(name, content); f.reindex()
    await assert.rejects(f.verify(), policyError)
  }
})

test('historical native tool and export hash guards cannot be substituted with current index assertions', async () => {
  for (const name of ['native-tools.json', 'continued-native-tools.json', 'export-tools.json']) {
    for (const change of [x => { x.scripts.native.sha256 = hash('not the executed native script') }, x => { x.tools.native.sha256 = hash('not the executed tool') }, x => { x.capabilities = x.capabilities.filter(capability => capability !== 'pcbnew') }, x => { x.containment = 'unverified' }]) {
      const f = fixture(); f.mutate(name, change)
      await assert.rejects(f.verify(), policyError)
    }
  }
  for (const name of ['render-top-hash-guard.json', 'render-bottom-hash-guard.json', 'svg-top-hash-guard.json', 'svg-bottom-hash-guard.json', 'glb-hash-guard.json']) {
    const f = fixture(); f.mutate(name, guard => { guard.sourceSha256['final-board.kicad_pcb'] = hash('another source board') })
    await assert.rejects(f.verify(), policyError)
  }
  const f = fixture(); f.mutate('native-test-provenance.json', provenance => { provenance.maximumRouteAttempts = 2 })
  await assert.rejects(f.verify(), policyError)
})

test('prepared, imported, filled and inspected evidence must form one preserved historical hash chain', async () => {
  for (const [name, change] of [
    ['prepared-evidence.json', x => { x.boardSha256 = hash('different prepared board') }],
    ['prepared-evidence.json', x => { x.routeAttempts = 1 }],
    ['prepared-evidence.json', x => { x.identity = { changed: true } }],
    ['prepared-evidence.json', x => { x.reservedCopper = [] }],
    ['import-evidence.json', x => { x.preparedProjectSha256 = hash('other project') }],
    ['import-evidence.json', x => { x.sesSha256 = hash('other router output') }],
    ['import-evidence.json', x => { x.importedBoardSha256 = hash('other imported board') }],
    ['fill-evidence.json', x => { x.inputSha256 = hash('other input') }],
    ['fill-evidence.json', x => { x.boardSha256 = hash('other filled board') }],
    ['native-evidence.json', x => { x.reservedCopperPreserved = false }],
    ['prepare-postexit-policy.json', x => { x.verified = false }],
    ['route-continued-postexit-policy.json', x => { x.tableSha256 = hash('other table') }],
    ['import-continued-postexit-policy.json', x => { delete x.projects['imported-board.kicad_pro'] }],
    ['finish-continued-postexit-policy.json', x => { x.projects['final-board.kicad_pro'] = hash('other final project') }],
    ['inspect-continued-postexit-policy.json', x => { delete x.projects['board.kicad_pro'] }],
  ]) {
    const f = fixture(); f.mutate(name, change)
    await assert.rejects(f.verify(), policyError, name)
  }
})

test('qualification cannot refresh old actual execution by changing its index timestamp', async () => {
  const f = fixture()
  f.mutate('linux-runtime-receipt.json', receipt => { receipt.startedAt = '2026-09-12T10:00:00.000Z'; receipt.finishedAt = '2026-09-12T10:01:00.000Z' })
  await assert.rejects(f.verify(), policyError)
})

test('publisher refuses foreign existing files and only refreshes its own private receipt', async () => {
  for (const value of ['unrelated user data', { version: 1, root: '/other', home: '/other' }]) {
    const f = fixture(); f.put(`${HOME}/astra-readiness.json`, value)
    const before = Buffer.from(f.files.get(`${HOME}/astra-readiness.json`))
    await assert.rejects(f.api.publishAstraReadiness(await f.verify()))
    assert.deepEqual(f.files.get(`${HOME}/astra-readiness.json`), before)
    assert.equal(f.calls.some(([name]) => name === 'rename'), false)
  }
  const f = fixture()
  await f.api.publishAstraReadiness(await f.verify())
  await f.api.publishAstraReadiness(await f.verify())
  assert.equal((await f.api.readAstraReadiness()).ready, true)
})

test('publication rechecks capability evidence and cleans only its own pending file on rename failure', async () => {
  const f = fixture(), capability = await f.verify()
  f.make('top.svg', '<svg>changed</svg>'); f.reindex()
  await assert.rejects(f.api.publishAstraReadiness(capability), policyError)
  assert.equal(f.files.has(`${HOME}/astra-readiness.json`), false)
  await assert.rejects(f.api.publishAstraReadiness(capability), policyError)
  const broken = fixture()
  broken.state.renameFailure = true
  await assert.rejects(broken.api.publishAstraReadiness(await broken.verify()), /rename failure/)
  assert.equal([...broken.files.keys()].some(name => name.endsWith('.pending.json')), false)
  assert.equal(broken.calls.filter(([name]) => name === 'remove').length, 1)
  broken.handlesClosed()
})
