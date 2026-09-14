import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import ts from 'typescript'

// Source-only reads; no client/runtime/controller import, Docker, native process,
// private filesystem or network. Actual strict DRC parser, in-memory report bytes.
const loadedImports = []
function load(relative, dependencies = {}) {
  const output = ts.transpileModule(fs.readFileSync(new URL(`../lib/${relative}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const loaded = { exports: {} }
  vm.runInNewContext(`(function(require,exports){${output}\n})`, { Buffer, Error, Date })(name => {
    loadedImports.push(name)
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected import ${name}`)
    return dependencies[name]
  }, loaded.exports)
  return loaded.exports
}
class AstraError extends Error {
  constructor(category, message) { super(message); this.category = category }
}
const drc = load('astra-drc.ts')
const containment = load('astra-validator-containment.ts')
const evidence = load('astra-validator-evidence.ts', {
  './astra-validator-containment': containment,
  'node:crypto': { createHash }, './astra-execution': { AstraError }, './astra-drc': drc,
})
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const denied = error => {
  assert.equal(error.category, 'output')
  assert.equal(error.message, 'Linux native validation evidence is incomplete or mismatched.')
  return true
}
const violation = (severity = 'warning', overrides = {}) => ({
  type: 'clearance', description: 'Synthetic clearance report', severity,
  items: [{ uuid: '12345678-1234-1234-1234-123456789abc', description: 'Synthetic pad', pos: { x: 1, y: 2 } }],
  ...overrides,
})
function containmentReceipt() {
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
function fixture(reportOverrides = {}) {
  const expected = {
    jobId: 'job-Ab1234', workflowId: 'workflow-test',
    board: Buffer.from('synthetic final board'), input: '{"synthetic":"native input"}', evidence: Buffer.from('synthetic native evidence'),
  }
  const report = {
    $schema: drc.ASTRA_DRC_SCHEMA, source: 'final-board.kicad_pcb', date: '2026-09-14T12:00:00',
    kicad_version: '10.0.5', violations: [], unconnected_items: [], schematic_parity: [],
    coordinate_units: 'mm', included_severities: ['error', 'warning', 'exclusion'], ignored_checks: [],
    ...reportOverrides,
  }
  const rawDrc = JSON.stringify(report)
  const result = {
    schema: 'astra-validator-result/v1', jobId: expected.jobId, workflowId: expected.workflowId,
    boardSha256: hash(expected.board), rawDrc,
    accounting: { requestedAt: '2026-09-14T12:00:00Z', finishedAt: '2026-09-14T12:00:01Z', stageMs: 100, runtimeMs: 800, totalMs: 1000, cancelled: false, cleanupConfirmed: true },
    receipt: {
      ...containmentReceipt(),
      schema: 'astra-linux-job-runtime/v1', image: evidence.ASTRA_VALIDATOR_IMAGE,
      boardSha256: hash(expected.board), nativeInputSha256: hash(expected.input), nativeEvidenceSha256: hash(expected.evidence), reportSha256: hash(rawDrc),
      executionComplete: true, inputsUnchanged: true, schematicParity: 'not-run', cancelled: false,
      cleanup: { confirmedAbsent: true }, process: { code: 0, reason: null, signal: null },
      finalState: { Running: false, OOMKilled: false, ExitCode: 0 }, checksComplete: true,
    },
  }
  return { expected, report, result, validate: () => evidence.validateAstraValidatorEvidence(result, expected) }
}

test('evidence loads the strict parser without loading erased client type or runtime modules', () => {
  assert.deepEqual(loadedImports, ['node:crypto', './astra-execution', './astra-drc', './astra-validator-containment'])
})

test('matching receipt preserves exact report bytes and verified clean counts', () => {
  const f = fixture()
  const verified = f.validate()
  assert.deepEqual(verified.bytes, Buffer.from(f.result.rawDrc))
  assert.equal(verified.parsed.available, true)
  assert.equal(verified.parsed.passed, true)
  assert.equal(verified.parsed.checksComplete, true)
  assert.equal(verified.parsed.errors, 0)
  assert.equal(verified.parsed.unrouted, 0)
  assert.equal(verified.parsed.schematicParity, 'not-run')
})

test('warning-bearing valid report is accepted with real warning count, never invented zeros', () => {
  const f = fixture({ violations: [violation(), violation()] })
  const { parsed } = f.validate()
  assert.equal(parsed.passed, true)
  assert.equal(parsed.warnings, 2)
  assert.equal(parsed.rawCounts.violations.total, 2)
  assert.equal(parsed.rawCounts.violations.warnings, 2)
  assert.equal(parsed.errors, 0)
})

test('board, input, native evidence and raw report hashes bind the exact operation', () => {
  for (const field of ['jobId', 'workflowId', 'boardSha256', 'schema']) {
    const f = fixture(); f.result[field] = 'wrong'
    assert.throws(f.validate, denied, field)
  }
  for (const field of ['boardSha256', 'nativeInputSha256', 'nativeEvidenceSha256', 'reportSha256', 'image', 'schema']) {
    const f = fixture(); f.result.receipt[field] = 'wrong'
    assert.throws(f.validate, denied, field)
  }
  for (const field of ['board', 'input', 'evidence']) {
    const f = fixture(); f.expected[field] = field === 'input' ? 'changed input' : Buffer.from('changed bytes')
    assert.throws(f.validate, denied, field)
  }
  const whitespace = fixture()
  whitespace.result.rawDrc += '\n'
  assert.throws(whitespace.validate, denied, 'even semantically equivalent JSON requires matching exact byte hash')
})

test('cleanup, completion, input integrity and parity cannot be omitted or spoofed', () => {
  for (const [target, key, values] of [
    ['accounting', 'cancelled', [true, undefined, 'false']],
    ['accounting', 'cleanupConfirmed', [false, undefined, 'true']],
    ['receipt', 'executionComplete', [false, undefined, 'true']],
    ['receipt', 'inputsUnchanged', [false, undefined, 'true']],
    ['receipt', 'schematicParity', ['passed', undefined]],
  ]) {
    for (const value of values) {
      const f = fixture(); f.result[target][key] = value
      assert.throws(f.validate, denied, `${target}.${key}=${value}`)
    }
  }
  for (const cleanup of [undefined, null, [], {}, { confirmedAbsent: false }, { confirmedAbsent: 'true' }]) {
    const f = fixture(); f.result.receipt.cleanup = cleanup
    assert.throws(f.validate, denied)
  }
  const cancelled = fixture(); cancelled.result.receipt.cancelled = true
  assert.throws(cancelled.validate, denied)
})

test('nonzero process, termination reason, signals and nonterminal container states reject', () => {
  for (const process of [null, {}, { code: 1 }, { code: '0' }, { code: 0, reason: 'timeout' }, { code: 0, reason: '' }, { code: 0, signal: 'SIGTERM' }]) {
    const f = fixture(); f.result.receipt.process = process
    assert.throws(f.validate, denied)
  }
  for (const finalState of [null, {}, { Running: true, OOMKilled: false, ExitCode: 0 }, { Running: false, OOMKilled: true, ExitCode: 0 }, { Running: false, OOMKilled: false, ExitCode: 137 }, { Running: false, OOMKilled: false, ExitCode: '0' }]) {
    const f = fixture(); f.result.receipt.finalState = finalState
    assert.throws(f.validate, denied)
  }
})

test('reported failures including storage failure reject even with zero exit and complete checks', () => {
  for (const field of ['failure', 'cleanupFailure', 'integrityFailure', 'storageFailure']) {
    for (const value of ['private runtime diagnostics', null, false, '']) {
      const f = fixture(); f.result.receipt[field] = value
      assert.throws(f.validate, denied, `${field}=${value}`)
    }
  }
})

test('malformed, absent and oversized raw reports cannot be replaced with receipt success claims', () => {
  for (const rawDrc of [null, undefined, 0, {}, 'not JSON', 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    const f = fixture(); f.result.rawDrc = rawDrc
    if (typeof rawDrc === 'string') f.result.receipt.reportSha256 = hash(rawDrc)
    assert.throws(f.validate, denied)
  }
  for (const raw of [null, [], {}, { errors: 0, unrouted: 0 }, { ...fixture().report, kicad_version: '9.0.0' }, { ...fixture().report, source: 'another-board.kicad_pcb' }, { ...fixture().report, ignored_checks: undefined }]) {
    const f = fixture(); f.result.rawDrc = JSON.stringify(raw); f.result.receipt.reportSha256 = hash(f.result.rawDrc)
    assert.throws(f.validate, denied)
  }
})

test('matching report hashes cannot hide missing or contradictory observed containment', () => {
  for (const mutate of [
    receipt => { delete receipt.container.hostConfig.NetworkMode },
    receipt => { receipt.container.hostConfig.NetworkMode = 'host' },
    receipt => { receipt.imageId = 'sha256:' + '0'.repeat(64) },
    receipt => { delete receipt.container.image },
    receipt => { delete receipt.container.mounts },
    receipt => { receipt.container.mounts[0].RW = true },
    receipt => { receipt.container.mounts[0].Source = '/private/unreviewed' },
    receipt => { receipt.container.hostConfig.Mounts.pop() },
  ]) {
    const f = fixture()
    mutate(f.result.receipt)
    assert.throws(f.validate, denied)
  }
})

test('checksComplete receipt cannot contradict ignored, excluded or parity report evidence', () => {
  for (const report of [
    { ignored_checks: [{ key: 'clearance', description: 'Ignored synthetic check' }] },
    { violations: [violation('warning', { excluded: true })] },
    { schematic_parity: [violation('warning')] },
  ]) {
    const f = fixture(report)
    assert.throws(f.validate, denied, 'receipt cannot claim complete native coverage')
    f.result.receipt.checksComplete = false
    const { parsed } = f.validate()
    assert.equal(parsed.checksComplete, false)
    assert.equal(parsed.passed, false)
  }
  for (const claimed of [false, undefined, 'true']) {
    const f = fixture(); f.result.receipt.checksComplete = claimed
    assert.throws(f.validate, denied)
  }
})

test('valid error and connectivity evidence remains nonpassing despite successful runtime receipt', () => {
  const f = fixture({ violations: [violation('error')], unconnected_items: [violation('warning')] })
  const { parsed } = f.validate()
  assert.equal(parsed.checksComplete, true)
  assert.equal(parsed.passed, false)
  assert.equal(parsed.errors, 1)
  assert.equal(parsed.unrouted, 1)
  assert.equal(parsed.rawCounts.unconnected_items.warnings, 1)
})
