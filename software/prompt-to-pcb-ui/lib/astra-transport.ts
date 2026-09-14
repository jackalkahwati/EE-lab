import fs from 'node:fs'
import path from 'node:path'
import {
  AstraError, assertAstraActive, buildAstraNativeEnv, claimAstraCall,
  currentAstraExecution, runAstraProcess,
} from './astra-execution'

/** This contract was inspected locally, not inferred from a model/version alias. */
export const ASTRA_NATIVE_VERSION = '2.1.270'
export const ASTRA_NATIVE_FLAGS = [
  '--print', '--input-format', '--output-format', '--model', '--bare', '--safe-mode',
  '--setting-sources', '--strict-mcp-config', '--mcp-config', '--disable-slash-commands',
  '--tools', '--permission-mode', '--permission-prompts', '--no-chrome',
  '--no-session-persistence', '--prompt-suggestions', '--system-prompt',
] as const
const MAX_INPUT_BYTES = 512 * 1024
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_RESULT_BYTES = 512 * 1024
const SYSTEM = 'You are the text-only electronics assistant for FirstLight Compose. The input is a JSON object containing application task instructions and user input. Follow the task instructions and return the requested response. You cannot use tools or access files, services, or prior sessions.'

type Workspace = { root: string; home: string }

/** Read-only preflight helper. No process, authentication, or proxy lifecycle calls. */
export function astraNativeConfig(): { cli: string; proxyUrl: string } {
  const cli = process.env.FL_ASTRA_CLI
  const proxyUrl = process.env.FL_ASTRA_PROXY_URL
  if (!cli || !path.isAbsolute(cli) || cli.includes('\0') || /(?:^|\/)claude-astra$/.test(cli)) {
    throw new AstraError('policy', 'Astra beta requires an explicit absolute native CLI executable, not the global launcher.')
  }
  const match = proxyUrl?.match(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/)
  if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) {
    throw new AstraError('policy', 'Astra beta requires an explicit loopback proxy URL and unprivileged port.')
  }
  try {
    const resolved = fs.realpathSync(cli)
    if (!fs.statSync(resolved).isFile()) throw new Error('not a file')
    fs.accessSync(resolved, fs.constants.X_OK)
    // Reject shell/Python launchers even when renamed: they can decrypt secrets or
    // start shared services before the native isolation flags take effect.
    const fd = fs.openSync(resolved, 'r')
    const magic = Buffer.alloc(4)
    try { fs.readSync(fd, magic, 0, 4, 0) } finally { fs.closeSync(fd) }
    if (!['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', '7f454c46'].includes(magic.toString('hex'))) {
      throw new Error('not native')
    }
    return { cli: resolved, proxyUrl: proxyUrl! }
  } catch {
    throw new AstraError('policy', 'Astra beta native CLI is unavailable or is not a native executable.')
  }
}

/** Call only with help/version obtained by an explicitly approved preflight. */
export function validateAstraNativeCapabilities(version: string, help: string): void {
  if (version.trim() !== `${ASTRA_NATIVE_VERSION} (Claude Code)` ||
      !ASTRA_NATIVE_FLAGS.every(flag => new RegExp(`${flag}(?:[\\s,]|$)`).test(help)) ||
      !help.includes('manual') || !help.includes('none')) {
    throw new AstraError('policy', 'Astra beta native CLI does not match the reviewed isolation contract.')
  }
}

export function astraNativeArgs(): string[] {
  return [
    '--print', '--input-format', 'text', '--output-format', 'json', '--model', 'gpt-6-astra',
    '--bare', '--safe-mode', '--setting-sources', '', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--tools', '',
    '--permission-mode', 'manual', '--permission-prompts', 'none', '--no-chrome',
    '--no-session-persistence', '--prompt-suggestions', 'false', '--system-prompt', SYSTEM,
  ]
}

/** The CLI JSON envelope is not API structured output (unsupported by the proxy). */
export function parseAstraResult(stdout: string): string {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new AstraError('output', 'Astra beta response exceeded the output limit.')
  }
  let result: unknown
  try { result = JSON.parse(stdout) } catch {
    throw new AstraError('output', 'Astra beta returned an invalid response envelope.')
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new AstraError('output', 'Astra beta returned an invalid response envelope.')
  }
  const envelope = result as Record<string, unknown>
  if (envelope.type !== 'result' || envelope.subtype !== 'success' || envelope.is_error !== false ||
      typeof envelope.result !== 'string' || !envelope.result.trim() ||
      Buffer.byteLength(envelope.result, 'utf8') > MAX_RESULT_BYTES) {
    throw new AstraError('output', 'Astra beta did not return a successful bounded text response.')
  }
  return envelope.result
}

export async function astraTextCall(system: string, user: string, workspace: Workspace): Promise<string> {
  const ctx = currentAstraExecution()
  if (!ctx) throw new AstraError('policy', 'Astra beta requires an active authorized workflow.')
  assertAstraActive(ctx)
  if (ctx.calls >= ctx.maxCalls) throw new AstraError('budget')
  const { cli, proxyUrl } = astraNativeConfig()
  if (typeof system !== 'string' || typeof user !== 'string' ||
      Buffer.byteLength(system, 'utf8') + Buffer.byteLength(user, 'utf8') > MAX_INPUT_BYTES) {
    throw new AstraError('policy', 'Astra beta input exceeds the text-only request limit.')
  }
  let cwd: string | undefined
  try {
    if (!path.isAbsolute(workspace.root) || !path.isAbsolute(workspace.home) ||
        workspace.home !== path.join(workspace.root, '.astra-home') ||
        fs.realpathSync(workspace.root) !== workspace.root ||
        fs.realpathSync(workspace.home) !== workspace.home ||
        !fs.lstatSync(workspace.home).isDirectory()) {
      throw new AstraError('policy', 'Astra beta requires an isolated application workspace.')
    }
    // Never use the application repository as the native CLI working directory.
    cwd = fs.mkdtempSync(path.join(workspace.home, 'call-'))
    fs.chmodSync(cwd, 0o700)
    const env = {
      ...buildAstraNativeEnv({ home: workspace.home, toolPaths: [cli] }),
      CLAUDE_CONFIG_DIR: path.join(cwd, 'config'),
      XDG_CONFIG_HOME: path.join(cwd, 'xdg-config'),
      XDG_CACHE_HOME: path.join(cwd, 'xdg-cache'),
      XDG_STATE_HOME: path.join(cwd, 'xdg-state'),
      TMPDIR: cwd,
      ANTHROPIC_BASE_URL: proxyUrl,
      ANTHROPIC_API_KEY: 'sk-astra-local', // Nonsecret placeholder; proxy has no local auth.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    }
    const input = JSON.stringify({ instructions: system, input: user })
    if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
      throw new AstraError('policy', 'Astra beta input exceeds the text-only request limit.')
    }
    // Check the actual resolved executable on every invocation. These bounded,
    // context-owned probes never submit input and do not consume an inference
    // call. A changed CLI must fail closed before any generation is claimed.
    const probeOptions = { cwd, env, timeoutMs: 10_000, maxOutputBytes: 128 * 1024 }
    const version = await runAstraProcess(ctx, cli, ['--version'], probeOptions)
    if (version.code !== 0) throw new AstraError('policy', 'Astra beta native CLI version preflight failed.')
    const help = await runAstraProcess(ctx, cli, ['--help'], probeOptions)
    if (help.code !== 0) throw new AstraError('policy', 'Astra beta native CLI capability preflight failed.')
    validateAstraNativeCapabilities(version.stdout, help.stdout)
    claimAstraCall(ctx)
    // Do not use claude-astra: it derives paths from HOME and starts/decrypts the
    // shared proxy. Compose only owns this child and never starts/stops the proxy.
    const result = await runAstraProcess(ctx, cli, astraNativeArgs(), {
      cwd, env, input,
      timeoutMs: 300_000, maxOutputBytes: MAX_OUTPUT_BYTES,
    })
    assertAstraActive(ctx)
    if (result.code !== 0) throw new AstraError('process', 'Astra beta native inference process failed.')
    return parseAstraResult(result.stdout)
  } catch (error) {
    if (error instanceof AstraError) throw error
    throw new AstraError('process', 'Astra beta transport could not complete the request.')
  } finally {
    if (cwd) {
      try { fs.rmSync(cwd, { recursive: true, force: true }) } catch { /* Only our own scratch directory. */ }
    }
  }
}
