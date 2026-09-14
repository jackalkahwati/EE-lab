import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  AstraError, isAstraError, createAstraExecution, currentAstraExecution,
  withAstraExecution, claimAstraCall, assertAstraActive, runAstraProcess, buildAstraNativeEnv,
} from '../lib/astra-execution.ts'

// All temporary data stays in the approved external scratch directory. No providers/native tools.
const root = mkdtempSync('/Volumes/T9 Backup/compose-ux-tmp-bQ4c59/astra-execution-')
chmodSync(root, 0o700)
const env = buildAstraNativeEnv({ home: root, toolPaths: [process.execPath] })
const contexts = []
const ctx = (options = {}) => {
  const value = createAstraExecution({ id: 'fake-run', owner: 'test-owner', maxCalls: 3, timeoutMs: 5_000, ...options })
  contexts.push(value)
  return value
}
const options = (overrides = {}) => ({ cwd: root, env, ...overrides })
const run = (execution, code, overrides) => runAstraProcess(execution, process.execPath, ['-e', code], options(overrides))
const category = (value) => error => isAstraError(error) && error.category === value
const waitFile = async path => {
  for (let i = 0; i < 200 && !existsSync(path); i += 1) await delay(10)
  assert.ok(existsSync(path), 'fake child should become ready')
}
const alive = pid => {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
const waitDead = async pid => {
  for (let i = 0; i < 200 && alive(pid); i += 1) await delay(10)
  assert.equal(alive(pid), false, `owned child ${pid} must be reaped`)
}
after(() => {
  for (const execution of contexts) execution.cancel()
  rmSync(root, { recursive: true, force: true })
})

test('typed errors and immutable server-owned execution reject forged contexts and bounds', () => {
  assert.ok(new AstraError('policy') instanceof Error)
  assert.equal(isAstraError({ category: 'policy' }), false)
  const execution = ctx()
  assert.equal(Object.isFrozen(execution), true)
  assert.throws(() => { execution.calls = 0 }, TypeError)
  assert.throws(() => { execution.deadline = Date.now() + 99_999 }, TypeError)
  assert.throws(() => assertAstraActive({ ...execution }), category('policy'))
  for (const overrides of [
    { id: '' }, { owner: ' ' }, { id: 'x'.repeat(257) },
    { maxCalls: 0 }, { maxCalls: 13 }, { maxCalls: 1.1 }, { maxCalls: NaN },
    { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 1_200_001 },
  ]) assert.throws(() => ctx(overrides), category('policy'))
  assert.equal(ctx({ maxCalls: 12, timeoutMs: 1_200_000 }).maxCalls, 12)
})

test('ALS follows async work, restores nesting, and uses one atomic budget for all stages', async () => {
  const execution = ctx({ maxCalls: 3 })
  const nested = ctx()
  assert.equal(currentAstraExecution(), undefined)
  await withAstraExecution(execution, async () => {
    await delay(1)
    assert.equal(currentAstraExecution(), execution)
    withAstraExecution(nested, () => assert.equal(currentAstraExecution(), nested))
    assert.equal(currentAstraExecution(), execution)
    const result = await Promise.allSettled(Array.from({ length: 10 }, async () => claimAstraCall(currentAstraExecution())))
    assert.deepEqual(result.filter(r => r.status === 'fulfilled').map(r => r.value), [1, 2, 3])
    assert.equal(result.filter(r => r.status === 'rejected' && category('budget')(r.reason)).length, 7)
  })
  await withAstraExecution(execution, async () => assert.throws(() => claimAstraCall(execution), category('budget')))
  assert.equal(currentAstraExecution(), undefined)
  assert.equal(execution.calls, 3)
  assert.equal(nested.calls, 0)
})

test('deadline and cancellation cannot be reset or consume further calls', async () => {
  const cancelled = ctx()
  cancelled.cancel()
  assert.throws(() => claimAstraCall(cancelled), category('cancelled'))
  assert.throws(() => withAstraExecution(cancelled, () => {}), category('cancelled'))
  assert.equal(cancelled.calls, 0)
  const expired = ctx({ timeoutMs: 10 })
  await delay(20)
  assert.equal(expired.signal.aborted, true)
  expired.cancel()
  assert.throws(() => assertAstraActive(expired), category('timeout'))
})

test('native environment is explicit and excludes provider credentials, hooks and routing', () => {
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LC_ALL', 'NODE_ENV', 'PATH'])
  assert.equal(env.NODE_ENV, 'development')
  assert.equal(env.HOME, root)
  assert.ok(env.PATH.split(':').includes(dirname(process.execPath)))
  assert.equal(Object.isFrozen(env), true)
  for (const bad of [
    { home: root, toolPaths: [] }, { home: root, toolPaths: ['node'] },
    { home: root, toolPaths: [join(root, 'not-found')] }, { home: '.', toolPaths: [process.execPath] },
  ]) assert.throws(() => buildAstraNativeEnv(bad), category('policy'))
  const nonExecutable = join(root, 'non-executable')
  writeFileSync(nonExecutable, 'fake')
  chmodSync(nonExecutable, 0o600)
  assert.throws(() => buildAstraNativeEnv({ home: root, toolPaths: [nonExecutable] }), category('policy'))
})

test('normal native processes need no Astra flags and preserve bounded parsing output', async () => {
  const execution = ctx()
  const result = await run(execution, `let s=''; process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>{process.stdout.write(s);process.stderr.write('native-warning')})`, { input: 'board-data' })
  assert.deepEqual(result, { stdout: 'board-data', stderr: 'native-warning', code: 0 })
  assert.equal(execution.calls, 0, 'native execution is not an inference call')
  const argsResult = await runAstraProcess(execution, process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'literal;$(no-shell)'], options())
  assert.equal(argsResult.stdout, 'literal;$(no-shell)')
  const childEnv = JSON.parse((await run(execution, 'process.stdout.write(JSON.stringify(process.env))')).stdout)
  // macOS may add its CoreFoundation locale marker after exec; it is not an inherited key.
  if (process.platform === 'darwin') delete childEnv.__CF_USER_TEXT_ENCODING
  assert.deepEqual(childEnv, env)
})

test('explicit bounded CLI usage exit compatibility preserves strict defaults and raw exit code', async () => {
  const execution = ctx()
  const code = "process.stderr.write('usage: fixed-tool');process.exit(2)"
  await assert.rejects(run(execution, code), error => {
    assert.ok(category('process')(error))
    assert.equal(error.exitCode, 2)
    assert.equal(error.signal, null)
    assert.equal('stderr' in error, false)
    assert.equal(error.message.includes('fixed-tool'), false)
    return true
  })
  await assert.rejects(run(execution, "process.kill(process.pid, 'SIGTERM')"), error => {
    assert.ok(category('process')(error))
    assert.equal(error.exitCode, null)
    assert.equal(error.signal, 'SIGTERM')
    return true
  })
  const result = await run(execution, code, { acceptedExitCodes: [0, 2] })
  assert.deepEqual(result, { stdout: '', stderr: 'usage: fixed-tool', code: 2 })
  for (const acceptedExitCodes of [[], [0, 1, 2], [-1], [256], [1.5], ['2'], '2']) {
    await assert.rejects(run(execution, code, { acceptedExitCodes }), category('policy'))
  }
  const cancelled = ctx()
  cancelled.cancel()
  await assert.rejects(run(cancelled, code, { acceptedExitCodes: [0, 2] }), category('cancelled'))
})

test('spawn, process, output and policy errors never leak raw stderr or command paths', async () => {
  const execution = ctx()
  await assert.rejects(runAstraProcess(execution, join(root, 'missing-secret-path'), [], options()), category('spawn'))
  await assert.rejects(run(execution, `process.stderr.write('SECRET_TOKEN raw prompt');process.exit(9)`), error => {
    assert.ok(category('process')(error))
    assert.equal(error.message.includes('SECRET'), false)
    assert.equal(error.message.includes(root), false)
    assert.equal('stderr' in error, false)
    return true
  })
  await assert.rejects(run(execution, `process.stdout.write('a'.repeat(200)); process.stderr.write('b'.repeat(200))`, { maxOutputBytes: 300 }), category('output'))
  await assert.rejects(run(execution, '', { input: 'x'.repeat(1_048_577) }), category('output'))
  for (const override of [{ maxOutputBytes: 8_388_609 }, { timeoutMs: 1_200_001 }, { shell: true }]) {
    await assert.rejects(run(execution, '', override), category('policy'))
  }
  await assert.rejects(runAstraProcess(execution, '/bin/sh', ['-c', 'true'], options()), category('policy'))
  await assert.rejects(runAstraProcess(execution, 'node', [], options()), category('policy'))
})

test('abort before spawn creates no child and abort while running settles safely', async () => {
  const marker = join(root, 'must-not-exist')
  const cancelled = ctx()
  cancelled.cancel()
  await assert.rejects(run(cancelled, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`), category('cancelled'))
  assert.equal(existsSync(marker), false)
  const execution = ctx()
  const started = join(root, 'cancel-started')
  const promise = run(execution, `require('fs').writeFileSync(${JSON.stringify(started)}, String(process.pid));setInterval(()=>{},1000)`)
  const rejected = assert.rejects(promise, category('cancelled'))
  await waitFile(started)
  const pid = Number(readFileSync(started, 'utf8'))
  execution.cancel()
  await rejected
  await waitDead(pid)
})

test('stage and whole execution deadlines reject and late root success cannot override timeout', async () => {
  const start = Date.now()
  await assert.rejects(run(ctx(), `setTimeout(()=>process.exit(0),1000)`, { timeoutMs: 30 }), category('timeout'))
  await assert.rejects(run(ctx({ timeoutMs: 30 }), `setTimeout(()=>process.exit(0),1000)`), category('timeout'))
  assert.ok(Date.now() - start < 2_000)
})

test('blocked stdin and continuous stderr remain bounded by deadline and output cap', async () => {
  await assert.rejects(run(ctx(), 'setInterval(()=>{},1000)', {
    input: new Uint8Array(1_048_576), timeoutMs: 100,
  }), category('timeout'))
  await assert.rejects(run(ctx(), `setInterval(()=>process.stderr.write('x'.repeat(4096)),1)`, {
    maxOutputBytes: 4096,
  }), category('output'))
})

test('only two owned processes may run concurrently and slots release after settlement', async () => {
  const execution = ctx()
  const a = run(execution, 'setTimeout(()=>{},100)')
  const b = run(execution, 'setTimeout(()=>{},100)')
  await assert.rejects(run(execution, ''), category('busy'))
  await Promise.all([a, b])
  assert.equal((await run(execution, `process.stdout.write('released')`)).stdout, 'released')
})

test('TERM-resistant descendants holding pipes get KILL after root success, unrelated service survives', async () => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env, cwd: root, stdio: 'ignore' })
  const descendantFile = join(root, 'descendant-pid')
  const childCode = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(descendantFile)},String(process.pid));setInterval(()=>{},1000)`
  const rootCode = `const {spawn}=require('child_process');const fs=require('fs');spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit',env:process.env});const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(descendantFile)})){clearInterval(t);process.exit(0)}},5)`
  try {
    const started = Date.now()
    const result = await run(ctx(), rootCode)
    assert.equal(result.code, 0)
    assert.ok(Date.now() - started < 2_000, 'held pipes must not stall settlement')
    await waitDead(Number(readFileSync(descendantFile, 'utf8')))
    assert.equal(alive(unrelated.pid), true)
  } finally {
    unrelated.kill('SIGKILL')
    await new Promise(resolve => unrelated.once('close', resolve))
  }
})

test('cancellation kills an owned parent and descendant, and cannot publish root success', async () => {
  const descendantFile = join(root, 'cancel-descendant-pid')
  const parentFile = join(root, 'cancel-parent-pid')
  const childCode = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(descendantFile)},String(process.pid));setInterval(()=>{},1000)`
  const rootCode = `const {spawn}=require('child_process');require('fs').writeFileSync(${JSON.stringify(parentFile)},String(process.pid));spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit',env:process.env});process.on('SIGTERM',()=>{process.stdout.write('late success');process.exit(0)});setInterval(()=>{},1000)`
  const execution = ctx()
  const pending = run(execution, rootCode)
  const rejected = assert.rejects(pending, category('cancelled'))
  await waitFile(descendantFile)
  execution.cancel()
  await rejected
  await waitDead(Number(readFileSync(parentFile, 'utf8')))
  await waitDead(Number(readFileSync(descendantFile, 'utf8')))
})
