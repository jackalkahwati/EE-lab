import { createHash } from 'node:crypto'
import { accessSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statfsSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { AstraError, assertAstraActive, runAstraProcess } from './astra-execution.ts'
import type { AstraExecution, AstraProcessResult } from './astra-execution.ts'

import nativePins from './astra-native-pins.json' with { type: 'json' }

const APP = '/Applications/KiCad/KiCad.app/Contents'
export const ASTRA_NATIVE_TOOL_PINS = Object.freeze(Object.fromEntries(Object.entries(nativePins.tools).map(([key, value]) => [key, Object.freeze({ ...value })]))) as Readonly<typeof nativePins.tools>
// Updated only after review, never from request data or environment variables.
export const ASTRA_NATIVE_SCRIPT_PINS = Object.freeze({ ...nativePins.scripts })
export const ASTRA_NATIVE_ASSET_ROOTS = Object.freeze([...nativePins.assetRoots])
const RUNTIME_ROOTS = Object.freeze([...nativePins.runtimeRoots])
export interface AstraNativeTools { readonly jobRoot: string; readonly home: string; readonly temp: string }
export interface AstraNativeToolManifest {
  schema: 'astra-native-tools/v1'
  platform: 'darwin'
  tools: Record<string, { path: string; sha256: string }>
  scripts: { native: { path: string; sha256: string }; probe: { path: string; sha256: string } }
  assetRoots: readonly string[]
  containment: 'unverified' | 'verified'
  capabilities: readonly string[]
}
interface State { manifest: AstraNativeToolManifest; profile: string; env: NodeJS.ProcessEnv; busy: boolean }
const states = new WeakMap<AstraNativeTools, State>()
const deny = (): never => { throw new AstraError('policy') }
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

function checkedFile(path: string, expectedHash: string, executable = false, canonicalPath = path): string {
  if (!isAbsolute(path) || path.includes('\0') || !/^[a-f0-9]{64}$/.test(expectedHash)) return deny()
  const canonical = realpathSync(path)
  if (canonical !== canonicalPath || !statSync(canonical).isFile() || statSync(canonical).nlink !== 1 ||
      (statSync(canonical).mode & 0o022) !== 0 || hash(canonical) !== expectedHash) return deny()
  if (executable) accessSync(canonical, constants.X_OK)
  return canonical
}
function privateDirectory(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path || path === userInfo().homedir) return deny()
  const st = lstatSync(path)
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) return deny()
  return path
}
/** Prevent pre-existing hard links from turning job-scoped writes into writes to external inodes. */
function auditJobTree(root: string): void {
  const pending = [root]
  let entries = 0, bytes = 0
  while (pending.length) {
    const directory = pending.pop()!
    for (const name of readdirSync(directory)) {
      if (++entries > 4096) return deny()
      const path = join(directory, name), st = lstatSync(path)
      // The root (and HOME/temp entry points) is checked 0700 on every call. Other users
      // cannot traverse it even when a native library creates a 0777 child directory.
      // Link and ownership checks still apply at every depth; no external inode is admitted.
      if (st.isSymbolicLink() || st.uid !== process.getuid?.()) return deny()
      if (st.isDirectory()) pending.push(path)
      else if (st.isFile() && st.nlink === 1) {
        bytes += st.size
        if (bytes > 256 * 1024 * 1024) return deny()
      } else return deny()
    }
  }
}
function verifyNativeDiskSpace(jobRoot: string): void {
  try {
    for (const path of ['/', jobRoot]) {
      const { bavail, bsize } = statfsSync(path)
      if (!Number.isSafeInteger(bavail) || bavail < 0 || !Number.isSafeInteger(bsize) || bsize <= 0 ||
          !Number.isSafeInteger(bavail * bsize) || bavail * bsize < 2 * 1024 * 1024 * 1024) return deny()
    }
  } catch { return deny() }
}

function verifyBundleDirectoryData(): void {
  for (const path of nativePins.runtimeDirectoryData) {
    const st = lstatSync(path)
    if (realpathSync(path) !== path || !st.isDirectory() || st.isSymbolicLink() ||
        (st.uid !== 0 && st.uid !== process.getuid?.()) || (st.mode & 0o022) !== 0) return deny()
  }
}
const quoted = (value: string) => JSON.stringify(value)
function profileFor(jobRoot: string, files: string[]): string {
  const roots = [...RUNTIME_ROOTS, ...ASTRA_NATIVE_ASSET_ROOTS, jobRoot]
  const literals = [...files, ...nativePins.runtimeFiles]
  const ancestors = new Set<string>(['/'])
  for (const path of [...roots, ...literals]) for (let p = dirname(path); p !== '/'; p = dirname(p)) ancestors.add(p)
  return [
    '(version 1)', '(deny default)', '(deny network*)',
    '(allow process-fork)', `(allow process-exec ${files.filter(p => !p.endsWith('.py')).map(p => `(literal ${quoted(p)})`).join(' ')})`,
    '(allow signal (target self))', '(allow sysctl-read)',
    `(allow file-read* ${roots.map(p => `(subpath ${quoted(p)})`).join(' ')} ${literals.map(p => `(literal ${quoted(p)})`).join(' ')})`,
    `(allow file-read-metadata ${[...ancestors].map(p => `(literal ${quoted(p)})`).join(' ')})`,
    // NSBundle needs to open the app directory itself to resolve its executable path.
    // This is directory-data only, not recursive access to the application bundle.
    `(allow file-read-data ${nativePins.runtimeDirectoryData.map(p => `(literal ${quoted(p)})`).join(' ')})`,
    `(allow file-write* (subpath ${quoted(jobRoot)}))`,
  ].join('\n')
}

/** Server initialization only. No environment overrides, arbitrary executable list, or client paths. */
export function createAstraNativeTools(options: { jobRoot: string; scriptRoot: string; flroutePath?: string }): AstraNativeTools {
  try {
    if (process.platform !== 'darwin') return deny()
    verifyBundleDirectoryData()
    const jobRoot = privateDirectory(options.jobRoot)
    verifyNativeDiskSpace(jobRoot)
    auditJobTree(jobRoot)
    const scriptRoot = realpathSync(options.scriptRoot)
    if (scriptRoot !== resolve(options.scriptRoot) || scriptRoot === jobRoot || scriptRoot.startsWith(`${jobRoot}/`)) return deny()
    const native = join(scriptRoot, 'astra-native.py'), probe = join(scriptRoot, 'astra-sandbox-probe.py')
    const tools: AstraNativeToolManifest['tools'] = {}
    for (const [name, pin] of Object.entries(ASTRA_NATIVE_TOOL_PINS)) {
      const path = name === 'flroute' ? (options.flroutePath ?? pin.path) : pin.path
      const canonical = name === 'flroute' ? path : ('canonicalPath' in pin ? pin.canonicalPath : path)
      tools[name] = { path: checkedFile(path, pin.sha256, true, canonical), sha256: pin.sha256 }
    }
    if (ASTRA_NATIVE_SCRIPT_PINS.native) checkedFile(native, ASTRA_NATIVE_SCRIPT_PINS.native)
    checkedFile(probe, ASTRA_NATIVE_SCRIPT_PINS.probe)
    for (const root of [...RUNTIME_ROOTS, ...ASTRA_NATIVE_ASSET_ROOTS]) {
      if (realpathSync(root) !== root || !statSync(root).isDirectory()) return deny()
    }
    const home = join(jobRoot, 'home'), temp = join(jobRoot, 'tmp')
    for (const path of [home, temp]) { mkdirSync(path, { mode: 0o700, recursive: true }); privateDirectory(path) }
    const env = Object.freeze({ HOME: home, TMPDIR: `${temp}/`, TMP: temp, TEMP: temp, PATH: dirname(tools.kicadCli.path), LANG: 'C', LC_ALL: 'C', NODE_ENV: 'development',
      PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', KICAD10_3DMODEL_DIR: `${APP}/SharedSupport/3dmodels`, KICAD10_FOOTPRINT_DIR: `${APP}/SharedSupport/footprints` })
    const config = Object.freeze({ jobRoot, home, temp })
    states.set(config, { manifest: { schema: 'astra-native-tools/v1', platform: 'darwin', tools, scripts: {
      native: { path: native, sha256: ASTRA_NATIVE_SCRIPT_PINS.native }, probe: { path: probe, sha256: ASTRA_NATIVE_SCRIPT_PINS.probe },
    }, assetRoots: ASTRA_NATIVE_ASSET_ROOTS, containment: 'unverified', capabilities: [] },
    profile: profileFor(jobRoot, [...Object.values(tools).map(v => v.path), ...(ASTRA_NATIVE_SCRIPT_PINS.native ? [native] : []), probe]), env, busy: false })
    return config
  } catch { return deny() }
}

export type AstraNativeRequest =
  | { operation: 'prepare' | 'import' | 'finish' | 'inspect' | 'route' | 'drc' | 'glb' | 'drc-dyld-trace' | 'drc-api' }
  | { operation: 'render'; side: 'top' | 'bottom' }
  | { operation: 'svg'; side: 'top' | 'bottom' }
  | { operation: 'probe'; capability: 'containment' | 'kicad-version' | 'python-version' | 'pcbnew' | 'kiface-load' | 'dyld-env-presence' | 'router-help' | 'render-help' | 'glb-help' | 'svg-help' | 'drc-help' }

export function astraNativeToolManifest(config: AstraNativeTools): AstraNativeToolManifest {
  const state = states.get(config) ?? deny()
  return structuredClone(state.manifest)
}
export function inspectAstraNativeReadiness(config: AstraNativeTools): { ready: boolean; blockers: string[] } {
  const state = states.get(config) ?? deny()
  const blockers: string[] = []
  try {
    verifyBundleDirectoryData()
    verifyNativeDiskSpace(config.jobRoot)
    privateDirectory(config.jobRoot); privateDirectory(config.home); privateDirectory(config.temp)
    for (const [name, tool] of Object.entries(state.manifest.tools)) {
      checkedFile(tool.path, tool.sha256, true)
      const pin = ASTRA_NATIVE_TOOL_PINS[name as keyof typeof ASTRA_NATIVE_TOOL_PINS]
      if ('canonicalPath' in pin && realpathSync(pin.path) !== pin.canonicalPath) return deny()
    }
    for (const script of Object.values(state.manifest.scripts)) checkedFile(script.path, script.sha256)
  } catch { blockers.push('Native tool or script provenance changed, or owned storage is unavailable.') }
  if (!ASTRA_NATIVE_SCRIPT_PINS.native) blockers.push('Reviewed native adapter hash is not pinned.')
  if (state.manifest.containment !== 'verified') blockers.push('Native containment has not passed its real probe.')
  for (const name of ['kicad-version', 'python-version', 'pcbnew', 'router-help', 'render-help', 'glb-help', 'svg-help', 'drc-help']) {
    if (!state.manifest.capabilities.includes(name)) blockers.push(`Native capability is unverified: ${name}.`)
  }
  return { ready: blockers.length === 0, blockers }
}

/** Only fixed operation argv and job-relative server filenames can reach a native process. */
export async function runAstraNativeTool(ctx: AstraExecution, config: AstraNativeTools, request: AstraNativeRequest,
  limits: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<AstraProcessResult> {
  assertAstraActive(ctx)
  const state = states.get(config) ?? deny()
  if (state.busy) throw new AstraError('busy')
  verifyBundleDirectoryData()
  verifyNativeDiskSpace(config.jobRoot)
  privateDirectory(config.jobRoot); privateDirectory(config.home); privateDirectory(config.temp)
  auditJobTree(config.jobRoot)
  for (const [name, tool] of Object.entries(state.manifest.tools)) {
    checkedFile(tool.path, tool.sha256, true)
    const pin = ASTRA_NATIVE_TOOL_PINS[name as keyof typeof ASTRA_NATIVE_TOOL_PINS]
    if ('canonicalPath' in pin && realpathSync(pin.path) !== pin.canonicalPath) return deny()
  }
  for (const script of Object.values(state.manifest.scripts)) {
    if (script.sha256) checkedFile(script.path, script.sha256)
    else if (request.operation !== 'probe') return deny()
  }
  const file = (name: string) => {
    const path = join(config.jobRoot, name)
    try { const st = lstatSync(path); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.()) return deny() }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    return path
  }
  const tools = state.manifest.tools
  let command = tools.kicadCli.path, args: string[]
  if (request.operation !== 'probe' && !inspectAstraNativeReadiness(config).ready) return deny()
  switch (request.operation) {
    case 'prepare': case 'import': case 'finish': case 'inspect':
      command = tools.bundledPython.path
      args = ['-I', '-B', state.manifest.scripts.native.path, request.operation, '--input', file('native-input.json'), '--output-dir', config.jobRoot]
      if (request.operation !== 'prepare') args.push('--ses', file('board.ses'))
      break
    case 'route':
      // Without an explicit zone net, flroute assumes its two largest nets are planes.
      // This contract pours GND only; the 3V3 rail must be routed, not silently skipped.
      command = tools.flroute.path; args = [file('board.dsn'), file('board.ses'), '--skip-net', 'GND']; break
    case 'drc-api':
      file('final-board.kicad_pcb'); file('drc-api.txt')
      command = tools.bundledPython.path
      args = ['-I', '-B', state.manifest.scripts.native.path, 'drc-api', '--input', file('native-input.json'), '--output-dir', config.jobRoot]; break
    case 'drc':
      args = ['pcb', 'drc', '--format', 'json', '--output', file('drc.json'), file('final-board.kicad_pcb')]; break
    case 'drc-dyld-trace':
      file('drc.json'); file('final-board.kicad_pcb')
      command = tools.bundledPython.path
      args = ['-I', '-B', state.manifest.scripts.probe.path, config.jobRoot, 'drc-dyld-trace']; break
    case 'glb': args = ['pcb', 'export', 'glb', '--include-tracks', '--include-pads', '--include-zones', '--include-silkscreen', '--include-soldermask', '--output', file('board.glb'), file('final-board.kicad_pcb')]; break
    case 'render':
      if (!['top', 'bottom'].includes(request.side)) return deny()
      args = ['pcb', 'render', '--side', request.side, '--output', file(`${request.side}.png`), file('final-board.kicad_pcb')]; break
    case 'svg':
      if (!['top', 'bottom'].includes(request.side)) return deny()
      args = ['pcb', 'export', 'svg', '--mode-single', '--fit-page-to-board', '--exclude-drawing-sheet', '--layers', request.side === 'top' ? 'F.Cu,F.Silkscreen,Edge.Cuts' : 'B.Cu,B.Silkscreen,Edge.Cuts', '--output', file(`${request.side}.svg`), file('final-board.kicad_pcb')]; break
    case 'probe':
      switch (request.capability) {
        case 'containment': command = tools.bundledPython.path; args = ['-I', '-B', state.manifest.scripts.probe.path, config.jobRoot]; break
        case 'pcbnew': command = tools.bundledPython.path; args = ['-I', '-B', state.manifest.scripts.probe.path, config.jobRoot, 'pcbnew']; break
        case 'dyld-env-presence':
          command = tools.bundledPython.path; args = ['-I', '-B', state.manifest.scripts.probe.path, config.jobRoot, 'dyld-env-presence']; break
        case 'kiface-load':
          checkedFile(nativePins.libraries.pcbPlugin.path, nativePins.libraries.pcbPlugin.sha256)
          file('kiface-load-diagnostic.json')
          command = tools.bundledPython.path; args = ['-I', '-B', state.manifest.scripts.probe.path, config.jobRoot, 'kiface-load']; break
        case 'kicad-version': args = ['--version']; break
        case 'python-version': command = tools.bundledPython.path; args = ['--version']; break
        case 'router-help': command = tools.flroute.path; args = ['--help']; break
        case 'render-help': args = ['pcb', 'render', '--help']; break
        case 'glb-help': args = ['pcb', 'export', 'glb', '--help']; break
        case 'svg-help': args = ['pcb', 'export', 'svg', '--help']; break
        case 'drc-help': args = ['pcb', 'drc', '--help']; break
        default: return deny()
      }
      break
    default: return deny()
  }
  const presenceProbe = request.operation === 'probe' && request.capability === 'dyld-env-presence'
  const tracing = request.operation === 'drc-dyld-trace' || presenceProbe
  const apiDrc = request.operation === 'drc-api'
  let env = state.env
  let tracePath: string | undefined
  let traceMonitor: ReturnType<typeof setInterval> | undefined
  let traceFailure: AstraError | undefined
  const checkTrace = () => {
    if (!tracePath) return
    try {
      const st = lstatSync(tracePath)
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.()) throw new AstraError('policy')
      if (st.size > (apiDrc ? 1024 * 1024 : 2 * 1024 * 1024)) throw new AstraError('output')
    } catch (error) {
      // The diagnostic report is created by KiCad, not pre-created by this parent.
      if (apiDrc && error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      traceFailure ??= error instanceof AstraError ? error : new AstraError('policy')
      // This is the caller's dedicated owned diagnostic workflow, never a shared service.
      // runAstraProcess handles its bounded process-group TERM/KILL cleanup on cancellation.
      ctx.cancel()
    }
  }
  if (tracing) {
    if ((limits.timeoutMs !== undefined && (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0)) ||
        (limits.maxOutputBytes !== undefined && (!Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes <= 0))) return deny()
    tracePath = join(config.jobRoot, 'dyld.log')
    // Exclusive creation refuses regular pre-existing files as well as symlinks/hardlinks.
    try { closeSync(openSync(tracePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)) }
    catch { return deny() }
    // The presence probe tests the outer launch chain; the DRC diagnostic sets these
    // exact values only after entering the sandbox, because sandbox-exec strips DYLD_*.
    if (presenceProbe) env = Object.freeze({ ...state.env, DYLD_PRINT_APIS: '1', DYLD_PRINT_TO_FILE: tracePath })
    // A polling stop threshold is not a kernel disk quota; any overshoot also fails the final check.
    traceMonitor = setInterval(checkTrace, 10)
    traceMonitor.unref()
  }
  if (apiDrc) {
    if ((limits.timeoutMs !== undefined && (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0)) ||
        (limits.maxOutputBytes !== undefined && (!Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes <= 0))) return deny()
    tracePath = join(config.jobRoot, 'drc-api.txt')
    try { lstatSync(tracePath); return deny() }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    traceMonitor = setInterval(checkTrace, 10)
    traceMonitor.unref()
  }
  state.busy = true
  try {
    const profile = apiDrc ? `${state.profile}\n(deny file-write* ${['final-board.kicad_pcb', 'final-board.kicad_pro', 'final-board.kicad_dru', 'board.kicad_pro', 'board.kicad_dru', 'native-input.json'].map(name => `(literal ${quoted(join(config.jobRoot, name))})`).join(' ')})` : state.profile
    const result = await runAstraProcess(ctx, tools.sandbox.path, ['-p', profile, command, ...args], {
      cwd: config.jobRoot, env,
      acceptedExitCodes: request.operation === 'probe' && request.capability === 'router-help' ? [0, 2] : [0],
      timeoutMs: apiDrc ? Math.min(limits.timeoutMs ?? 30_000, 30_000) : presenceProbe ? Math.min(limits.timeoutMs ?? 5_000, 5_000) : tracing ? Math.min(limits.timeoutMs ?? 15_000, 15_000) : limits.timeoutMs ?? (request.operation === 'probe' ? 15_000 : 120_000),
      maxOutputBytes: apiDrc ? Math.min(limits.maxOutputBytes ?? 1024 * 1024, 1024 * 1024) : presenceProbe ? Math.min(limits.maxOutputBytes ?? 4096, 4096) : tracing ? Math.min(limits.maxOutputBytes ?? 32_768, 32_768) : limits.maxOutputBytes ?? 256 * 1024,
    })
    checkTrace()
    if (traceFailure) throw traceFailure
    if (request.operation === 'probe') {
      if (request.capability === 'containment') {
        const report = JSON.parse(result.stdout)
        if (report.schema !== 'astra-sandbox-probe/v1' || report.passed !== true || report.checks !== 8 ||
            !Array.isArray(report.results) || report.results.length !== 8 || report.results.some((value: unknown) => value !== true)) return deny()
        state.manifest.containment = 'verified'
      } else {
        // This is a diagnostic observation, never readiness proof: Python's loader
        // context/rpaths are different from kicad-cli, whether dlopen succeeds or fails.
        if (request.capability === 'dyld-env-presence') {
          const report = JSON.parse(result.stdout)
          if (report.schema !== 'astra-dyld-env-presence/v1' || typeof report.printApisPresent !== 'boolean' || typeof report.tracePathPresent !== 'boolean') return deny()
          return result
        }
        if (request.capability === 'kiface-load') {
          const report = JSON.parse(result.stdout)
          if (report.schema !== 'astra-kiface-load-probe/v1' || report.context !== 'bundled-python-not-kicad-cli' ||
              typeof report.loaded !== 'boolean' || report.pluginSha256 !== nativePins.libraries.pcbPlugin.sha256) return deny()
          return result
        }
        switch (request.capability) {
          case 'router-help':
            if (result.code !== 2 || result.stdout.trim() || result.stderr.trim() !== 'usage: flroute <in.dsn> <out.ses> [--skip-net NAME]...') return deny()
            break
          case 'kicad-version': if (result.stdout.trim() !== '10.0.1') return deny(); break
          case 'python-version': if (result.stdout.trim() !== 'Python 3.9.13') return deny(); break
          case 'pcbnew': {
            const report = JSON.parse(result.stdout)
            if (report.schema !== 'astra-pcbnew-probe/v1' || report.version !== '10.0.1' ||
                report.footprintLoad !== true || report.exportSpecctraDSN !== true || report.importSpecctraSES !== true) return deny()
            break
          }
          case 'render-help': if (!['Usage: pcb render', '--side', '--output', '--width', '--height'].every(flag => result.stdout.includes(flag))) return deny(); break
          case 'glb-help': if (!['Usage: export glb', '--output', '--include-tracks', '--include-pads', '--include-zones', '--include-silkscreen', '--include-soldermask'].every(flag => result.stdout.includes(flag))) return deny(); break
          case 'svg-help': if (!['Usage: export svg', '--mode-single', '--layers', '--fit-page-to-board', '--exclude-drawing-sheet'].every(flag => result.stdout.includes(flag))) return deny(); break
          case 'drc-help': if (!['Usage: pcb drc', '--format', 'json', '--output'].every(flag => result.stdout.includes(flag))) return deny(); break
        }
        state.manifest.capabilities = [...new Set([...state.manifest.capabilities, request.capability])]
      }
    }
    return result
  } catch (error) {
    if (request.operation === 'probe') {
      if (request.capability === 'containment') state.manifest.containment = 'unverified'
      else state.manifest.capabilities = state.manifest.capabilities.filter(value => value !== request.capability)
    }
    checkTrace()
    throw traceFailure ?? error
  } finally {
    if (traceMonitor) clearInterval(traceMonitor)
    state.busy = false
  }
}
