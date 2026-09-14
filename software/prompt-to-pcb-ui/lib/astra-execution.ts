import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { constants, accessSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { userInfo } from 'node:os'

export type AstraErrorCategory =
  | 'policy' | 'budget' | 'timeout' | 'cancelled' | 'spawn' | 'process' | 'output' | 'busy'

const SAFE_MESSAGES: Record<AstraErrorCategory, string> = {
  policy: 'Astra execution policy rejected this operation.',
  budget: 'Astra execution call budget exhausted.',
  timeout: 'Astra execution deadline exceeded.',
  cancelled: 'Astra execution cancelled. Remote inference may still be billed.',
  spawn: 'Astra subprocess could not start.',
  process: 'Astra subprocess failed.',
  output: 'Astra subprocess exceeded an input or output bound.',
  busy: 'Astra execution subprocess concurrency limit reached.',
}

export class AstraError extends Error {
  readonly category: AstraErrorCategory
  /** Safe native termination metadata only; never argv, paths, stdout or stderr. */
  readonly exitCode?: number | null
  readonly signal?: string | null

  constructor(category: AstraErrorCategory, message?: string, termination?: { exitCode: number | null; signal: string | null }) {
    super(message ?? SAFE_MESSAGES[category])
    this.name = 'AstraError'
    this.category = category
    if (category === 'process' && termination) {
      this.exitCode = Number.isInteger(termination.exitCode) && termination.exitCode! >= 0 && termination.exitCode! <= 255 ? termination.exitCode : null
      this.signal = typeof termination.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(termination.signal) ? termination.signal : null
    }
  }
}

export function isAstraError(error: unknown): error is AstraError {
  return error instanceof AstraError
}

export interface AstraExecution {
  readonly owner: string
  readonly id: string
  /** Absolute Unix milliseconds, selected by the server, not a stage request. */
  readonly deadline: number
  readonly maxCalls: number
  readonly calls: number
  readonly signal: AbortSignal
  cancel(): void
}

interface ExecutionState {
  controller: AbortController
  calls: number
  processes: number
  timeout: ReturnType<typeof setTimeout>
}

const executions = new WeakMap<AstraExecution, ExecutionState>()
const storage = new AsyncLocalStorage<AstraExecution>()
const MAX_CALLS = 12
const MAX_TIMEOUT_MS = 20 * 60_000
const MAX_PROCESSES = 2
const MAX_INPUT_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const TERM_GRACE_MS = 150
const KILL_GRACE_MS = 150

function boundedInteger(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max
}

function stateFor(ctx: AstraExecution): ExecutionState {
  const state = executions.get(ctx)
  if (!state) throw new AstraError('policy')
  return state
}

/** The parent registry must retain this object across stages and enforce one active workflow. */
export function createAstraExecution(options: {
  id: string
  owner: string
  maxCalls: number
  timeoutMs: number
}): AstraExecution {
  const { id, owner, maxCalls, timeoutMs } = options
  if (typeof id !== 'string' || !id.trim() || id.length > 256 ||
      typeof owner !== 'string' || !owner.trim() || owner.length > 256 ||
      !boundedInteger(maxCalls, MAX_CALLS) || !boundedInteger(timeoutMs, MAX_TIMEOUT_MS)) {
    throw new AstraError('policy')
  }
  const controller = new AbortController()
  const deadline = Date.now() + timeoutMs
  const state: ExecutionState = {
    controller, calls: 0, processes: 0,
    timeout: setTimeout(() => controller.abort(new AstraError('timeout')), timeoutMs),
  }
  state.timeout.unref()
  const ctx: AstraExecution = Object.freeze({
    id, owner, deadline, maxCalls,
    get calls() { return state.calls },
    get signal() { return controller.signal },
    cancel() {
      clearTimeout(state.timeout)
      controller.abort(new AstraError('cancelled'))
    },
  })
  executions.set(ctx, state)
  return ctx
}

export function assertAstraActive(ctx: AstraExecution): void {
  const state = stateFor(ctx)
  if (state.controller.signal.aborted) {
    // The reason is server-created; never copy an arbitrary external AbortSignal reason.
    throw state.controller.signal.reason as AstraError
  }
  if (Date.now() >= ctx.deadline) {
    clearTimeout(state.timeout)
    state.controller.abort(new AstraError('timeout'))
    throw state.controller.signal.reason as AstraError
  }
}

export function withAstraExecution<T>(ctx: AstraExecution, fn: () => T): T {
  assertAstraActive(ctx)
  return storage.run(ctx, fn)
}

export function currentAstraExecution(): AstraExecution | undefined {
  return storage.getStore()
}

/** Synchronous check/increment is atomic in the owning Node event loop. Python must use its broker. */
export function claimAstraCall(ctx: AstraExecution): number {
  assertAstraActive(ctx)
  const state = stateFor(ctx)
  if (state.calls >= ctx.maxCalls) throw new AstraError('budget')
  state.calls += 1
  return state.calls
}

/**
 * Server-supplied, preflight-verified native executables only. Never pass user paths.
 * PATH necessarily exposes siblings in these trusted tool directories. This is not a sandbox.
 * HOME must be an existing, private, current-user-owned directory, never the real user home.
 * No process.env reads: provider credentials, routing, loader hooks and Python/Node options
 * are intentionally absent. Inference gets a separate audited environment at its boundary.
 */
export function buildAstraNativeEnv(options: {
  home: string
  toolPaths: readonly string[]
}): NodeJS.ProcessEnv {
  try {
    const { home, toolPaths } = options
    if (!isAbsolute(home) || realpathSync(home) !== resolve(home) ||
        resolve(home) === resolve(userInfo().homedir) ||
        !Array.isArray(toolPaths) || !toolPaths.length || toolPaths.length > 32) {
      throw new AstraError('policy')
    }
    const homeStat = lstatSync(home)
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink() ||
        typeof process.getuid !== 'function' || homeStat.uid !== process.getuid() ||
        (homeStat.mode & 0o077) !== 0) throw new AstraError('policy')
    const paths = new Set<string>()
    for (const tool of toolPaths) {
      if (typeof tool !== 'string' || !isAbsolute(tool) || tool.includes('\0')) {
        throw new AstraError('policy')
      }
      const canonical = realpathSync(tool)
      if (!statSync(canonical).isFile()) throw new AstraError('policy')
      accessSync(canonical, constants.X_OK)
      // ':' cannot be represented safely in a POSIX PATH element.
      if (dirname(tool).includes(':') || dirname(canonical).includes(':')) throw new AstraError('policy')
      paths.add(dirname(resolve(tool)))
      paths.add(dirname(canonical))
    }
    return Object.freeze({ HOME: home, PATH: [...paths].join(':'), LANG: 'C', LC_ALL: 'C', NODE_ENV: 'development' })
  } catch {
    throw new AstraError('policy')
  }
}

export interface AstraProcessOptions {
  cwd: string
  /** Explicit server-owned environment. Never merge process.env or client options here. */
  env: NodeJS.ProcessEnv
  input?: string | Uint8Array
  timeoutMs?: number
  /** Combined stdout + stderr bytes; cannot exceed the server hard limit. */
  maxOutputBytes?: number
  /** Server-only compatibility for documented native CLI usage exits; default is strictly [0]. */
  acceptedExitCodes?: readonly number[]
}

export interface AstraProcessResult {
  /** Raw bounded output for native artifacts/parsers; never publish it as a safe error. */
  stdout: string
  stderr: string
  code: number
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'pwsh'])

/**
 * Runs a trusted native process without shell interpretation. Does not charge an LLM call.
 * Every child is an owned POSIX process-group leader. TERM then KILL also runs after a
 * successful root exit so background descendants cannot outlive a stage. Cleanup is
 * bounded even if an escaped descendant holds pipes; detached/setsid escape is outside
 * this trusted-tool contract. Never point this at a shared service or inference proxy.
 */
export async function runAstraProcess(
  ctx: AstraExecution,
  command: string,
  args: readonly string[],
  options: AstraProcessOptions,
): Promise<AstraProcessResult> {
  assertAstraActive(ctx)
  const state = stateFor(ctx)
  const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  const requestedExitCodes = options.acceptedExitCodes ?? [0]
  if (!Array.isArray(requestedExitCodes) || requestedExitCodes.length < 1 || requestedExitCodes.length > 2 ||
      requestedExitCodes.some(code => !Number.isSafeInteger(code) || code < 0 || code > 255)) throw new AstraError('policy')
  const acceptedExitCodes = new Set(requestedExitCodes)
  if (process.platform === 'win32' || typeof command !== 'string' || !isAbsolute(command) ||
      command.includes('\0') || SHELLS.has(basename(command).toLowerCase()) ||
      !Array.isArray(args) || args.length > 256 ||
      args.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
      args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > 64 * 1024 ||
      !options.cwd || !isAbsolute(options.cwd) || options.cwd.includes('\0') ||
      !options.env || typeof options.env !== 'object' ||
      'shell' in options || !boundedInteger(timeoutMs, MAX_TIMEOUT_MS) ||
      !boundedInteger(maxOutputBytes, MAX_OUTPUT_BYTES)) throw new AstraError('policy')
  try {
    if (SHELLS.has(basename(realpathSync(command)).toLowerCase())) throw new AstraError('policy')
  } catch (error) {
    if (isAstraError(error)) throw error
    throw new AstraError('spawn')
  }
  if (options.input !== undefined && typeof options.input !== 'string' && !(options.input instanceof Uint8Array)) {
    throw new AstraError('policy')
  }
  const inputSize = typeof options.input === 'string' ? Buffer.byteLength(options.input) : (options.input?.byteLength ?? 0)
  if (inputSize > MAX_INPUT_BYTES) throw new AstraError('output')
  const input = options.input === undefined ? undefined : Buffer.from(options.input)
  if (state.processes >= MAX_PROCESSES) throw new AstraError('busy')
  assertAstraActive(ctx)
  state.processes += 1

  try {
    return await new Promise<AstraProcessResult>((resolveResult, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(command, [...args], {
          cwd: options.cwd, env: { ...options.env }, shell: false,
          detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch {
        reject(new AstraError('spawn'))
        return
      }
      let finished = false
      let cleaning = false
      let failure: AstraError | undefined
      let exitCode: number | null = null
      let exited = false
      let closed = false
      let bytes = 0
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let settleTimer: ReturnType<typeof setTimeout> | undefined
      const processDeadline = Math.min(ctx.deadline, Date.now() + timeoutMs)
      const deadlineTimer = setTimeout(() => stop(new AstraError('timeout')),
        Math.max(1, processDeadline - Date.now()))

      function groupExists(): boolean {
        if (!child.pid) return false
        try { process.kill(-child.pid, 0); return true } catch (error) {
          return (error as NodeJS.ErrnoException).code !== 'ESRCH'
        }
      }
      function signalGroup(signal: NodeJS.Signals): void {
        if (!child.pid) return
        try { process.kill(-child.pid, signal) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= new AstraError('process')
        }
      }
      function settle(): void {
        if (finished) return
        finished = true
        clearTimeout(deadlineTimer)
        clearTimeout(killTimer)
        clearTimeout(settleTimer)
        ctx.signal.removeEventListener('abort', onAbort)
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        // Never leave a stubborn root handle keeping the server alive after bounded cleanup.
        child.unref()
        if (!closed || groupExists()) failure ??= new AstraError('process')
        if (Date.now() >= processDeadline) failure ??= new AstraError('timeout')
        try { assertAstraActive(ctx) } catch (error) { failure = error as AstraError }
        if (failure) reject(failure)
        else if (!exited || exitCode === null || !acceptedExitCodes.has(exitCode)) reject(new AstraError('process'))
        else resolveResult({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code: exitCode })
      }
      function stop(error?: AstraError): void {
        if (finished) return
        failure ??= error
        if (cleaning) return
        cleaning = true
        child.stdin?.destroy()
        signalGroup('SIGTERM')
        if (closed && !groupExists()) { settle(); return }
        killTimer = setTimeout(() => {
          signalGroup('SIGKILL')
          if (closed && !groupExists()) { settle(); return }
          settleTimer = setTimeout(settle, KILL_GRACE_MS)
        }, TERM_GRACE_MS)
      }
      function onAbort(): void {
        try { assertAstraActive(ctx) } catch (error) { stop(error as AstraError) }
      }
      function capture(target: Buffer[], chunk: Buffer): void {
        if (finished || failure) return
        bytes += chunk.length
        if (bytes > maxOutputBytes) { stop(new AstraError('output')); return }
        target.push(chunk)
      }
      child.stdout?.on('data', chunk => capture(stdout, chunk))
      child.stderr?.on('data', chunk => capture(stderr, chunk))
      child.stdout?.on('error', () => stop(new AstraError('process')))
      child.stderr?.on('error', () => stop(new AstraError('process')))
      child.stdin?.on('error', () => stop(new AstraError('process')))
      child.once('error', () => stop(new AstraError('spawn')))
      child.once('exit', (code, signal) => {
        exited = true
        exitCode = code
        stop(code !== null && acceptedExitCodes.has(code) ? undefined : new AstraError('process', undefined, { exitCode: code, signal }))
      })
      child.once('close', () => {
        closed = true
        if (cleaning && !groupExists()) settle()
      })
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      // Recheck after listener registration, even if cancellation raced the spawn boundary.
      if (ctx.signal.aborted || Date.now() >= ctx.deadline) onAbort()
      else child.stdin?.end(input)
    })
  } finally {
    state.processes -= 1
  }
}
