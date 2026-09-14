import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import test, { after } from 'node:test'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, linkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAstraExecution, isAstraError } from '../lib/astra-execution.ts'
import { ASTRA_NATIVE_TOOL_PINS, ASTRA_NATIVE_SCRIPT_PINS, createAstraNativeTools, astraNativeToolManifest, inspectAstraNativeReadiness, runAstraNativeTool } from '../lib/astra-native-tools.ts'

const scratch = mkdtempSync('/Volumes/T9 Backup/compose-ux-tmp-bQ4c59/astra-native-tools-')
chmodSync(scratch, 0o700)
const job = join(scratch, 'job')
mkdirSync(job, { mode: 0o700 })
const scriptRoot = realpathSync(new URL('../scripts/', import.meta.url).pathname)
const contexts = []
const context = () => {
  const ctx = createAstraExecution({ id: 'native-tool-test', owner: 'owned-test', maxCalls: 1, timeoutMs: 120_000 })
  contexts.push(ctx)
  return ctx
}
const policy = error => isAstraError(error) && error.category === 'policy'
after(() => { contexts.forEach(ctx => ctx.cancel()); rmSync(scratch, { recursive: true, force: true }) })

// Normal regressions never launch a native binary. Real probes are separately explicit.
test('native pins contain exact canonical Python symlink target and immutable fixed tools', () => {
  assert.equal(ASTRA_NATIVE_TOOL_PINS.bundledPython.canonicalPath, '/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3.9')
  assert.equal(realpathSync(ASTRA_NATIVE_TOOL_PINS.bundledPython.path), ASTRA_NATIVE_TOOL_PINS.bundledPython.canonicalPath)
  assert.equal(Object.isFrozen(ASTRA_NATIVE_TOOL_PINS.bundledPython), true)
  assert.equal(ASTRA_NATIVE_SCRIPT_PINS.probe.length, 64)
})

test('manifest is detached and readiness fails closed before real containment and CLI probes', () => {
  const tools = createAstraNativeTools({ jobRoot: job, scriptRoot })
  const manifest = astraNativeToolManifest(tools)
  assert.equal(manifest.schema, 'astra-native-tools/v1')
  assert.equal(manifest.containment, 'unverified')
  manifest.containment = 'verified'
  assert.equal(astraNativeToolManifest(tools).containment, 'unverified')
  assert.equal(inspectAstraNativeReadiness(tools).ready, false)
  assert.ok(inspectAstraNativeReadiness(tools).blockers.length >= 8)
  assert.throws(() => astraNativeToolManifest({ ...tools }), policy)
  assert.deepEqual(Object.keys(tools).sort(), ['home', 'jobRoot', 'temp'])
})

test('paths, permissive job roots, copied tool drift and symlinks fail closed', () => {
  assert.throws(() => createAstraNativeTools({ jobRoot: '.', scriptRoot }), policy)
  const link = join(scratch, 'linked-job')
  symlinkSync(job, link)
  assert.throws(() => createAstraNativeTools({ jobRoot: link, scriptRoot }), policy)
  assert.throws(() => createAstraNativeTools({ jobRoot: job, scriptRoot: job }), policy)
  chmodSync(job, 0o755)
  assert.throws(() => createAstraNativeTools({ jobRoot: job, scriptRoot }), policy)
  chmodSync(job, 0o700)
  const fake = join(scratch, 'flroute')
  writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  assert.throws(() => createAstraNativeTools({ jobRoot: job, scriptRoot, flroutePath: fake }), policy)
  rmSync(fake)
  symlinkSync(ASTRA_NATIVE_TOOL_PINS.flroute.path, fake)
  assert.throws(() => createAstraNativeTools({ jobRoot: job, scriptRoot, flroutePath: fake }), policy)
  rmSync(fake)
  copyFileSync(ASTRA_NATIVE_TOOL_PINS.flroute.path, fake)
  chmodSync(fake, 0o700)
  assert.equal(astraNativeToolManifest(createAstraNativeTools({ jobRoot: job, scriptRoot, flroutePath: fake })).tools.flroute.path, fake)
})

test('unverified operations and forged requests never start processes', async () => {
  const tools = createAstraNativeTools({ jobRoot: job, scriptRoot })
  const ctx = context()
  for (const request of [{ operation: 'prepare' }, { operation: 'route' }, { operation: 'arbitrary', command: '/bin/sh' }, { operation: 'probe', capability: '-c' }]) {
    await assert.rejects(runAstraNativeTool(ctx, tools, request), policy)
  }
  assert.equal(ctx.calls, 0)
  ctx.cancel()
  await assert.rejects(runAstraNativeTool(ctx, tools, { operation: 'probe', capability: 'python-version' }), error => isAstraError(error) && error.category === 'cancelled')
})

test('nested symlinks and hardlinks in the owned job tree reject before any process', async () => {
  const tools = createAstraNativeTools({ jobRoot: job, scriptRoot })
  const outside = join(scratch, 'outside-owned-fixture')
  writeFileSync(outside, 'unrelated', { mode: 0o600 })
  const linked = join(job, 'tmp', 'nested-link')
  for (const makeLink of [symlinkSync, linkSync]) {
    makeLink(outside, linked)
    await assert.rejects(runAstraNativeTool(context(), tools, { operation: 'probe', capability: 'python-version' }), policy)
    rmSync(linked)
  }
  assert.equal(readFileSync(outside, 'utf8'), 'unrelated')
})

test('private root protects native-created permissive child directories but root drift fails', () => {
  const runtimeDir = join(job, 'tmp', 'org.kicad.kicad', 'instances')
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  chmodSync(runtimeDir, 0o777)
  // Admission checks the non-traversable 0700 root, not a runtime library's child umask.
  const tools = createAstraNativeTools({ jobRoot: job, scriptRoot })
  assert.equal(inspectAstraNativeReadiness(tools).blockers.some(b => b.includes('owned storage')), false)
  chmodSync(job, 0o755)
  assert.equal(inspectAstraNativeReadiness(tools).blockers.some(b => b.includes('owned storage')), true)
  assert.throws(() => createAstraNativeTools({ jobRoot: job, scriptRoot }), policy)
  chmodSync(job, 0o700)
})

test('every operation fails closed on low or invalid root/job filesystem space without native execution', async () => {
  const tools = createAstraNativeTools({ jobRoot: job, scriptRoot })
  const original = fs.statfsSync
  const enough = { bavail: 524288, bsize: 4096 } // Exactly 2 GiB is admitted.
  try {
    const checked = []
    fs.statfsSync = path => { checked.push(path); return enough }
    syncBuiltinESMExports()
    assert.ok(createAstraNativeTools({ jobRoot: job, scriptRoot }))
    assert.deepEqual(checked, ['/', job])
    const invalid = [
      { bavail: 524287, bsize: 4096 }, { bavail: -1, bsize: 4096 },
      { bavail: NaN, bsize: 4096 }, { bavail: Infinity, bsize: 4096 },
      { bavail: 524288.5, bsize: 4096 }, { bavail: 524288, bsize: 0 },
      { bavail: 524288, bsize: NaN }, { bavail: Number.MAX_SAFE_INTEGER, bsize: 4096 },
      { bavail: 524288n, bsize: 4096n }, null,
    ]
    for (const target of ['/', job]) for (const value of invalid) {
      fs.statfsSync = path => path === target ? value : enough
      syncBuiltinESMExports()
      await assert.rejects(runAstraNativeTool(context(), tools, { operation: 'probe', capability: 'python-version' }), policy)
      assert.equal(inspectAstraNativeReadiness(tools).ready, false)
    }
    for (const target of ['/', job]) {
      fs.statfsSync = path => { if (path === target) throw new Error('disk unavailable'); return enough }
      syncBuiltinESMExports()
      await assert.rejects(runAstraNativeTool(context(), tools, { operation: 'probe', capability: 'python-version' }), policy)
      assert.throws(() => createAstraNativeTools({ jobRoot: job, scriptRoot }), policy)
    }
  } finally {
    fs.statfsSync = original
    syncBuiltinESMExports()
  }
})

test('SES import, filling and inspection are distinct fixed Python processes with hash-bound SES input', () => {
  const source = readFileSync(new URL('../lib/astra-native-tools.ts', import.meta.url), 'utf8')
  const nativeCases = source.slice(source.indexOf("case 'prepare':"), source.indexOf("case 'route':"))
  assert.match(nativeCases, /case 'prepare': case 'import': case 'finish': case 'inspect':/)
  assert.match(nativeCases, /args = \['-I', '-B', state\.manifest\.scripts\.native\.path, request\.operation, '--input', file\('native-input\.json'\), '--output-dir', config\.jobRoot\]/)
  assert.match(nativeCases, /if \(request\.operation !== 'prepare'\) args\.push\('--ses', file\('board\.ses'\)\)/)
  assert.match(source, /acceptedExitCodes: request\.operation === 'probe' && request\.capability === 'router-help' \? \[0, 2\] : \[0\]/)
})

test('router fixed argv skips only the actual GND pour and never heuristically skips 3V3', () => {
  const source = readFileSync(new URL('../lib/astra-native-tools.ts', import.meta.url), 'utf8')
  const routeCase = source.slice(source.indexOf("case 'route':"), source.indexOf("case 'drc':"))
  assert.match(routeCase, /args = \[file\('board\.dsn'\), file\('board\.ses'\), '--skip-net', 'GND'\]; break/)
  assert.equal((routeCase.match(/--skip-net/g) ?? []).length, 1)
  assert.ok(!routeCase.includes("'3V3'"))
})

test('native API DRC remains a fixed bounded diagnostic distinct from normal CLI DRC', () => {
  const source = readFileSync(new URL('../lib/astra-native-tools.ts', import.meta.url), 'utf8')
  const branch = source.slice(source.indexOf("case 'drc-api':"), source.indexOf("case 'drc':"))
  assert.match(branch, /args = \['-I', '-B', state.manifest.scripts.native.path, 'drc-api', '--input', file\('native-input.json'\), '--output-dir', config.jobRoot\]/)
  assert.ok(branch.includes("file('drc-api.txt')"))
  assert.ok(source.includes('const profile = apiDrc ? `${state.profile}\\n(deny file-write*'))
  assert.ok(source.includes("'final-board.kicad_dru'"))
  assert.ok(!branch.includes('--ses'))
  assert.match(source, /apiDrc \? Math.min\(limits.timeoutMs \?\? 30_000, 30_000\)/)
  assert.match(source, /apiDrc \? Math.min\(limits.maxOutputBytes \?\? 1024 \* 1024, 1024 \* 1024\)/)
  const readiness = source.slice(source.indexOf('export function inspectAstraNativeReadiness'), source.indexOf('/** Only fixed operation argv'))
  assert.ok(!readiness.includes('drc-api'))
  assert.match(source, /acceptedExitCodes: request.operation === 'probe' && request.capability === 'router-help' \? \[0, 2\] : \[0\]/)
})

test('bundle discovery permits exact app directory data only, never recursive app access', () => {
  const pins = JSON.parse(readFileSync(new URL('../lib/astra-native-pins.json', import.meta.url), 'utf8'))
  const source = readFileSync(new URL('../lib/astra-native-tools.ts', import.meta.url), 'utf8')
  assert.deepEqual(pins.runtimeDirectoryData, ['/Applications/KiCad/KiCad.app'])
  assert.equal(pins.runtimeRoots.includes('/Applications/KiCad/KiCad.app'), false)
  assert.equal(pins.runtimeRoots.includes('/Applications/KiCad/KiCad.app/Contents'), false)
  assert.ok(source.includes('(allow file-read-data ${nativePins.runtimeDirectoryData.map(p => `(literal ${quoted(p)})`).join(\' \')})'))
  assert.equal(source.includes('subpath ${quoted(APP)}'), false)
  const validation = source.slice(source.indexOf('function verifyBundleDirectoryData'), source.indexOf('const quoted'))
  assert.ok(validation.includes('realpathSync(path) !== path'))
  assert.ok(validation.includes('st.isSymbolicLink()'))
  assert.ok(validation.includes('(st.uid !== 0 && st.uid !== process.getuid?.())'))
  assert.ok(validation.includes('(st.mode & 0o022) !== 0'))
})

test('dyld trace is a fixed bounded diagnostic without loader overrides or readiness promotion', () => {
  const source = readFileSync(new URL('../lib/astra-native-tools.ts', import.meta.url), 'utf8')
  assert.match(source, /case 'drc':\s+args = \['pcb', 'drc', '--format', 'json', '--output', file\('drc.json'\), file\('final-board.kicad_pcb'\)\]/)
  assert.match(source, /args = \['-I', '-B', state.manifest.scripts.probe.path, config.jobRoot, 'drc-dyld-trace'\]/)
  assert.match(source, /env = Object\.freeze\(\{ \.\.\.state\.env, DYLD_PRINT_APIS: '1', DYLD_PRINT_TO_FILE: tracePath \}\)/)
  assert.equal(source.includes('DYLD_INSERT_LIBRARIES'), false)
  assert.equal(source.includes('DYLD_LIBRARY_PATH'), false)
  assert.equal(source.includes('process.env'), false)
  assert.match(source, /O_WRONLY \| constants.O_CREAT \| constants.O_EXCL \| constants.O_NOFOLLOW, 0o600/)
  assert.match(source, /st\.size > \(apiDrc \? 1024 \* 1024 : 2 \* 1024 \* 1024\)/)
  assert.match(source, /setInterval\(checkTrace, 10\)/)
  assert.match(source, /ctx\.cancel\(\)/)
  assert.match(source, /Math\.min\(limits\.timeoutMs \?\? 15_000, 15_000\)/)
  assert.match(source, /Math\.min\(limits\.maxOutputBytes \?\? 32_768, 32_768\)/)
  assert.match(source, /clearInterval\(traceMonitor\)/)
  const readiness = source.slice(source.indexOf('export function inspectAstraNativeReadiness'), source.indexOf('/** Only fixed operation argv'))
  assert.equal(readiness.includes('drc-dyld-trace'), false)
})

test('inside-sandbox trace execve uses fixed pinned CLI and environment and cannot mask exec failure', () => {
  const source = readFileSync(new URL('../scripts/astra-sandbox-probe.py', import.meta.url), 'utf8')
  const branch = source.slice(source.indexOf("if len(sys.argv) == 3 and sys.argv[2] == 'drc-dyld-trace':"), source.indexOf("if len(sys.argv) == 3 and sys.argv[2] == 'dyld-env-presence':"))
  assert.ok(branch.includes("cli = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'"))
  assert.ok(branch.includes("expected = '04d9e61cad2e80cf7ad6c3da06417a6d7e8e2cdd23efc99957a1184e604d6657'"))
  assert.ok(branch.includes("os.execve(cli, [cli, 'pcb', 'drc', '--format', 'json', '--output', output, board], environment)"))
  assert.ok(branch.includes("'DYLD_PRINT_APIS': '1', 'DYLD_PRINT_TO_FILE': trace"))
  assert.ok(branch.includes("raise RuntimeError('execve unexpectedly returned')"))
  assert.equal(branch.includes('except'), false)
  assert.equal(branch.includes('os.environ.get'), false)
  assert.equal(branch.includes('os.environ.copy'), false)
  assert.equal(branch.includes('DYLD_INSERT_LIBRARIES'), false)
  assert.equal(branch.includes('DYLD_LIBRARY_PATH'), false)
})

test('dyld environment-presence probe reports two booleans only and has a five-second bound', () => {
  const source = readFileSync(new URL('../scripts/astra-sandbox-probe.py', import.meta.url), 'utf8')
  const wrapper = readFileSync(new URL('../lib/astra-native-tools.ts', import.meta.url), 'utf8')
  const branch = source.slice(source.indexOf("if len(sys.argv) == 3 and sys.argv[2] == 'dyld-env-presence':"), source.indexOf("if len(sys.argv) == 3 and sys.argv[2] == 'kiface-load':"))
  assert.ok(branch.includes("'printApisPresent': os.environ.get('DYLD_PRINT_APIS') == '1'"))
  assert.ok(branch.includes("'tracePathPresent': os.environ.get('DYLD_PRINT_TO_FILE') == os.path.join(root, 'dyld.log')"))
  assert.ok(!branch.includes('dict(os.environ)'))
  assert.match(wrapper, /presenceProbe \? Math.min\(limits.timeoutMs \?\? 5_000, 5_000\)/)
  assert.match(wrapper, /presenceProbe \? Math.min\(limits.maxOutputBytes \?\? 4096, 4096\)/)
  const readiness = wrapper.slice(wrapper.indexOf('export function inspectAstraNativeReadiness'), wrapper.indexOf('/** Only fixed operation argv'))
  assert.ok(!readiness.includes('dyld-env-presence'))
})

test('plugin loader diagnostic has one pinned target and never promotes readiness', () => {
  const source = readFileSync(new URL('../scripts/astra-sandbox-probe.py', import.meta.url), 'utf8')
  const wrapper = readFileSync(new URL('../lib/astra-native-tools.ts', import.meta.url), 'utf8')
  assert.ok(source.includes("plugin = '/Applications/KiCad/KiCad.app/Contents/PlugIns/_pcbnew.kiface'"))
  assert.ok(source.includes('ctypes.CDLL(plugin, mode=os.RTLD_NOW | os.RTLD_GLOBAL)'))
  assert.ok(source.includes("if key != 'loaderError'"))
  assert.ok(source.includes("'bundled-python-not-kicad-cli'"))
  const readiness = wrapper.slice(wrapper.indexOf('export function inspectAstraNativeReadiness'), wrapper.indexOf('/** Only fixed operation argv'))
  assert.equal(readiness.includes('kiface-load'), false)
  assert.match(wrapper, /if \(request\.capability === 'kiface-load'\)[\s\S]*?return result/)
})

test('fixed probe verifies own IO plus ancestor denial and descendant containment', () => {
  const source = readFileSync(new URL('../scripts/astra-sandbox-probe.py', import.meta.url), 'utf8')
  assert.ok(source.includes('os.fork()'))
  assert.ok(source.includes('192.0.2.1'))
  assert.ok(source.includes("sock.bind(('127.0.0.1', 0))"))
  assert.ok(!source.includes('sendto('))
  assert.ok(!source.includes('requests'))
})

test('real bounded native probes, explicitly opted in, run sequentially without inference', { skip: process.env.ASTRA_NATIVE_PROBE !== '1' }, async () => {
  const tools = createAstraNativeTools({ jobRoot: job, scriptRoot })
  const ctx = context()
  for (const capability of ['containment', 'python-version', 'pcbnew', 'kicad-version', 'router-help', 'render-help', 'glb-help', 'svg-help', 'drc-help']) {
    const output = await runAstraNativeTool(ctx, tools, { operation: 'probe', capability }, { timeoutMs: 15_000, maxOutputBytes: 32_768 })
    console.log(JSON.stringify({ capability, stdout: output.stdout, stderr: output.stderr }))
  }
  assert.equal(astraNativeToolManifest(tools).containment, 'verified')
  assert.equal(ctx.calls, 0)
})
