import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const lib = new URL('../lib/', import.meta.url)
function load(name, dependencies = {}) {
  const source = fs.readFileSync(new URL(name, lib), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const loadedModule = { exports: {} }
  new Function('require', 'module', 'exports', compiled)(
    name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name), loadedModule, loadedModule.exports,
  )
  return loadedModule.exports
}
const execution = load('astra-execution.ts')
const success = (text = 'Astra response') => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text })
function context(maxCalls = 3) {
  return execution.createAstraExecution({ id: 'fake-test', owner: 'operator', maxCalls, timeoutMs: 60_000 })
}
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'astra-transport-test-')))
  const home = path.join(root, '.astra-home')
  fs.mkdirSync(home, { mode: 0o700 })
  return { root, home, remove: () => fs.rmSync(root, { recursive: true, force: true }) }
}
function env(t, values) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}
function transport(runner = async () => { throw new Error('No real subprocess permitted') }, probe) {
  let adapter
  const fakeRunner = async (ctx, command, args, options) => {
    if (args.length === 1 && ['--version', '--help'].includes(args[0])) {
      assert.equal(options.input, undefined)
      assert.equal(options.timeoutMs, 10_000)
      assert.equal(options.maxOutputBytes, 128 * 1024)
      if (probe) return probe(ctx, command, args, options)
      return {
        stdout: args[0] === '--version' ? '2.1.270 (Claude Code)' : adapter.ASTRA_NATIVE_FLAGS.join('\n') + '\nmanual none\n',
        stderr: '', code: 0,
      }
    }
    return runner(ctx, command, args, options)
  }
  adapter = load('astra-transport.ts', { './astra-execution': { ...execution, runAstraProcess: fakeRunner } })
  return adapter
}
function configured(t) {
  // This native executable is inspected as a file only, never executed.
  env(t, { FL_ASTRA_CLI: process.execPath, FL_ASTRA_PROXY_URL: 'http://127.0.0.1:18766' })
}

test('native transport uses fixed isolated flags, bounded stdin, clean env and fake runner only', async t => {
  configured(t)
  env(t, { AWS_SECRET_ACCESS_KEY: 'private-secret', ANTHROPIC_AUTH_TOKEN: 'private-auth', NODE_OPTIONS: '--trace-warnings' })
  const workspace = fixture(); t.after(workspace.remove)
  const ctx = context(); t.after(() => ctx.cancel())
  let observed
  const adapter = transport(async (...args) => {
    observed = args
    return { stdout: success(), stderr: 'not surfaced', code: 0 }
  })
  const text = await execution.withAstraExecution(ctx, () => adapter.astraTextCall('task instructions', 'private prompt', workspace))
  assert.equal(text, 'Astra response')
  assert.equal(ctx.calls, 1)
  const [passedCtx, command, args, options] = observed
  assert.equal(passedCtx, ctx)
  assert.equal(command, fs.realpathSync(process.execPath))
  const value = flag => args[args.indexOf(flag) + 1]
  assert.equal(value('--model'), 'gpt-6-astra')
  assert.equal(value('--tools'), '')
  assert.equal(value('--setting-sources'), '')
  assert.equal(value('--mcp-config'), '{"mcpServers":{}}')
  assert.equal(value('--permission-mode'), 'manual')
  assert.equal(value('--permission-prompts'), 'none')
  for (const flag of ['--bare', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--no-chrome']) assert.ok(args.includes(flag))
  assert.ok(!args.includes('--json-schema'))
  assert.ok(!args.includes('--dangerously-skip-permissions'))
  assert.ok(!args.join(' ').includes('private prompt'))
  assert.deepEqual(JSON.parse(options.input), { instructions: 'task instructions', input: 'private prompt' })
  assert.equal(options.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18766')
  assert.equal(options.env.ANTHROPIC_API_KEY, 'sk-astra-local')
  assert.equal(options.env.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, undefined)
  assert.equal(options.env.NODE_OPTIONS, undefined)
  assert.equal(options.env.HOME, workspace.home)
  assert.ok(options.cwd.startsWith(workspace.home + path.sep))
  assert.equal(options.env.CLAUDE_CONFIG_DIR, path.join(options.cwd, 'config'))
  assert.equal(options.timeoutMs, 300_000)
  assert.equal(options.maxOutputBytes, 1024 * 1024)
  assert.ok(!fs.existsSync(options.cwd), 'owned scratch directory cleaned after call')
})

test('read-only configuration rejects missing, remote, ambiguous, wrapper and script paths', t => {
  configured(t)
  const adapter = transport()
  const workspace = fixture(); t.after(workspace.remove)
  const fakeScript = path.join(workspace.root, 'renamed-cli')
  fs.writeFileSync(fakeScript, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  for (const cli of ['', 'claude', '/tmp/claude-astra', fakeScript]) {
    process.env.FL_ASTRA_CLI = cli
    assert.throws(() => adapter.astraNativeConfig(), error => error.category === 'policy')
  }
  process.env.FL_ASTRA_CLI = process.execPath
  for (const proxy of ['', 'http://localhost:18766', 'https://127.0.0.1:18766', 'http://127.0.0.1:80', 'http://127.0.0.1:65536', 'http://127.0.0.1:018766', 'http://127.0.0.1:18766/', 'http://user@127.0.0.1:18766', 'http://127.0.0.1:18766?x=1']) {
    process.env.FL_ASTRA_PROXY_URL = proxy
    assert.throws(() => adapter.astraNativeConfig(), error => error.category === 'policy')
  }
})

test('capability helper rejects version drift or missing isolation flag without probing anything', () => {
  const adapter = transport()
  const help = adapter.ASTRA_NATIVE_FLAGS.join('\n') + '\nmanual none\n'
  assert.doesNotThrow(() => adapter.validateAstraNativeCapabilities('2.1.270 (Claude Code)', help))
  assert.throws(() => adapter.validateAstraNativeCapabilities('2.1.269 (Claude Code)', help))
  assert.throws(() => adapter.validateAstraNativeCapabilities('2.1.270 (Claude Code)', help.replace('--bare', '--other')))
})

test('every invocation verifies bounded help/version before claiming inference; failed preflight spends zero calls', async t => {
  configured(t)
  const workspace = fixture(); t.after(workspace.remove)
  const cases = ['valid', 'version-drift', 'missing-flag', 'version-exit', 'help-exit', 'probe-timeout']
  for (const scenario of cases) {
    const ctx = context(); t.after(() => ctx.cancel())
    const sequence = []
    let adapter
    adapter = transport(async () => {
      sequence.push('inference')
      assert.equal(ctx.calls, 1)
      return { stdout: success(), stderr: '', code: 0 }
    }, async (received, command, args) => {
      assert.equal(received, ctx)
      assert.equal(ctx.calls, 0)
      sequence.push(args[0])
      if (scenario === 'probe-timeout') throw new execution.AstraError('timeout')
      if (args[0] === '--version') return {
        stdout: scenario === 'version-drift' ? '2.1.271 (Claude Code)' : '2.1.270 (Claude Code)',
        stderr: 'private-preflight-stderr', code: scenario === 'version-exit' ? 1 : 0,
      }
      return {
        stdout: scenario === 'missing-flag' ? '--print' : adapter.ASTRA_NATIVE_FLAGS.join('\n') + '\nmanual none\n',
        stderr: 'private-preflight-stderr', code: scenario === 'help-exit' ? 1 : 0,
      }
    })
    await execution.withAstraExecution(ctx, async () => {
      if (scenario === 'valid') {
        assert.equal(await adapter.astraTextCall('s', 'u', workspace), 'Astra response')
        assert.deepEqual(sequence, ['--version', '--help', 'inference'])
      } else {
        await assert.rejects(adapter.astraTextCall('s', 'u', workspace), error =>
          error.category === (scenario === 'probe-timeout' ? 'timeout' : 'policy') && !error.message.includes('private'))
        assert.ok(!sequence.includes('inference'))
        assert.equal(ctx.calls, 0)
      }
    })
    assert.deepEqual(fs.readdirSync(workspace.home), [])
  }
})

test('malformed, failed, oversized and nontext envelopes fail without leaking content', () => {
  const adapter = transport()
  for (const stdout of ['private-raw-error', 'null', '[]', '{}', success(''),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: { private: 'secret' } }),
    JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'private-provider-error' }),
    success('x'.repeat(512 * 1024 + 1)), 'x'.repeat(1024 * 1024 + 1)]) {
    assert.throws(() => adapter.parseAstraResult(stdout), error => error.category === 'output' && !/private/.test(error.message))
  }
})

test('missing context, exhausted budget, cancellation and oversized input never reach runner', async t => {
  configured(t)
  const workspace = fixture(); t.after(workspace.remove)
  let calls = 0
  const adapter = transport(async () => { calls++; return { stdout: success(), stderr: '', code: 0 } })
  await assert.rejects(adapter.astraTextCall('s', 'u', workspace), error => error.category === 'policy')
  const ctx = context(1); t.after(() => ctx.cancel())
  await execution.withAstraExecution(ctx, async () => {
    await assert.rejects(adapter.astraTextCall('s', 'x'.repeat(512 * 1024), workspace), error => error.category === 'policy')
    assert.equal(ctx.calls, 0)
    execution.claimAstraCall(ctx)
    await assert.rejects(adapter.astraTextCall('s', 'u', workspace), error => error.category === 'budget')
    ctx.cancel()
    await assert.rejects(adapter.astraTextCall('s', 'u', workspace), error => error.category === 'cancelled')
  })
  assert.equal(calls, 0)
})

test('nonzero and thrown runner errors are safe and never retry', async t => {
  configured(t)
  const workspace = fixture(); t.after(workspace.remove)
  for (const runner of [async () => ({ stdout: success('private-response'), stderr: 'private-stderr', code: 1 }), async () => { throw new Error('private-process-error') }]) {
    const ctx = context(); t.after(() => ctx.cancel())
    let calls = 0
    const adapter = transport(async (...args) => { calls++; return runner(...args) })
    await execution.withAstraExecution(ctx, async () => {
      await assert.rejects(adapter.astraTextCall('s', 'u', workspace), error => error.category === 'process' && !error.message.includes('private'))
    })
    assert.equal(calls, 1)
    assert.deepEqual(fs.readdirSync(workspace.home), [])
  }
})

test('LLM beta guard precedes all provider overrides and fails closed without context', async t => {
  env(t, { FL_ASTRA_BETA: '1', USE_CLAUDE_CODE_CLI: '1' })
  let calls = 0, workspaces = 0
  const llm = load('llm.ts', {
    './astra-execution': execution,
    './astra-beta': {
      astraConfigured: () => process.env.FL_ASTRA_BETA !== undefined && process.env.FL_ASTRA_BETA !== '0',
      astraWorkspace: () => { workspaces++; return { root: '/isolated', home: '/isolated/.astra-home' } },
    },
    './astra-transport': { astraTextCall: async () => { calls++; return 'fixed-model-result' } },
  })
  await assert.rejects(llm.callLLMText('s', 'u', { apiKey: 'secret', provider: 'openai' }), error => error.category === 'policy')
  assert.equal(calls, 0)
  assert.equal(workspaces, 0)
  const ctx = context(); t.after(() => ctx.cancel())
  await execution.withAstraExecution(ctx, async () => {
    const result = await llm.callLLMText('s', 'u', { apiKey: 'internal-platform-key', provider: 'openai', model: 'internal-default' })
    assert.deepEqual(result, { text: 'fixed-model-result', provider: 'astra-beta (Bedrock)' })
  })
  assert.equal(calls, 1)
})

test('LLM context cannot escape to provider chain when beta disabled', async t => {
  env(t, { FL_ASTRA_BETA: undefined })
  const ctx = context(); t.after(() => ctx.cancel())
  let attempts = 0
  const llm = load('llm.ts', {
    './astra-execution': execution,
    './astra-beta': { astraConfigured: () => false, astraWorkspace: () => { throw new execution.AstraError('policy') } },
    './astra-transport': { astraTextCall: async () => { attempts++; throw new execution.AstraError('process') } },
  })
  await execution.withAstraExecution(ctx, async () => {
    await assert.rejects(llm.callLLMText('s', 'u', { provider: 'openai', apiKey: 'key' }), error => error.category === 'policy')
  })
  assert.equal(attempts, 0)
})

test('LLM adapter failures propagate without entering a provider fallback', async t => {
  env(t, { FL_ASTRA_BETA: '1', USE_CLAUDE_CODE_CLI: '1' })
  const oldFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = oldFetch })
  let fetches = 0, attempts = 0
  globalThis.fetch = async () => { fetches++; throw new Error('forbidden provider fetch') }
  const llm = load('llm.ts', {
    './astra-execution': execution,
    './astra-beta': { astraConfigured: () => true, astraWorkspace: () => ({ root: '/isolated', home: '/isolated/.astra-home' }) },
    './astra-transport': { astraTextCall: async () => { attempts++; throw new execution.AstraError('timeout') } },
  })
  const ctx = context(); t.after(() => ctx.cancel())
  await execution.withAstraExecution(ctx, async () => {
    await assert.rejects(llm.callLLMText('s', 'u'), error => error.category === 'timeout')
  })
  assert.equal(attempts, 1)
  assert.equal(fetches, 0)
})

test('non-beta LLM retains normal BYOK route with fake fetch only', async t => {
  env(t, { FL_ASTRA_BETA: undefined, USE_CLAUDE_CODE_CLI: '0' })
  const oldFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = oldFetch })
  let requested
  globalThis.fetch = async (url, options) => { requested = { url, options }; return { ok: true, json: async () => ({ choices: [{ message: { content: 'normal result' } }] }) } }
  const llm = load('llm.ts', {
    './astra-execution': execution,
    './astra-beta': { astraConfigured: () => false, astraWorkspace: () => { throw new Error('should not run') } },
    './astra-transport': { astraTextCall: async () => { throw new Error('should not run') } },
  })
  assert.deepEqual(await llm.callLLMText('s', 'u', { provider: 'openai', apiKey: 'fake-key', model: 'chosen' }), { text: 'normal result', provider: 'openai (user key)' })
  assert.equal(requested.url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(JSON.parse(requested.options.body).model, 'chosen')
})
