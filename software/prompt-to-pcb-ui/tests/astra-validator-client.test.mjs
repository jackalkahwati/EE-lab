import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';

const source = await fs.readFile(new URL('../lib/astra-validator-client.ts', import.meta.url), 'utf8');
const HASH = 'a'.repeat(64), SECRET = 'b'.repeat(64), TOKEN = 'c'.repeat(64);
const socketPath = '/private/tmp/astra-v-ABC123/control.sock';
const options = signal => ({ jobId: 'job-AbC123', workflowId: 'workflow_123', boardSha256: HASH, signal });
const success = () => ({ schema: 'astra-validator-result/v1', jobId: 'job-AbC123', workflowId: 'workflow_123', boardSha256: HASH,
  receipt: { schema: 'astra-linux-job-runtime/v1' }, rawDrc: '{"raw":"fixture"}', accounting: { requestedAt: 'fixture', finishedAt: 'fixture', stageMs: 1, runtimeMs: 2, totalMs: 3, cleanupConfirmed: true, cancelled: false } });
function fixture(config = {}) {
  const calls = [], pending = [], timers = new Map(); let timerId = 0;
  const env = { ASTRA_VALIDATOR_SOCKET: socketPath, ASTRA_VALIDATOR_SECRET: SECRET, ...config.env };
  const dependencies = {
    'node:path': path, 'node:crypto': { randomBytes: () => Buffer.from(TOKEN, 'hex') },
    'node:fs/promises': {
      lstat: async file => ({ isDirectory: () => file === path.dirname(socketPath), isSocket: () => file === socketPath, isSymbolicLink: () => !!config.linked,
        uid: process.getuid(), mode: file === socketPath ? config.socketMode ?? 0o600 : 0o700 }),
      realpath: async file => file,
    },
    'node:http': { request: requestOptions => {
      const req = new EventEmitter(); let destroyed = false;
      req.destroy = () => { destroyed = true; };
      req.end = bytes => {
        const value = JSON.parse(bytes); calls.push({ options: requestOptions, value, destroyed: () => destroyed });
        const respond = (body, status = 200, headers = {}) => {
          if (destroyed) return;
          const res = new EventEmitter(); res.statusCode = status; res.complete = !config.truncated;
          res.headers = { 'content-type': 'application/json', ...headers }; res.destroy = () => {};
          req.emit('response', res);
          res.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))); res.emit('end');
        };
        if (requestOptions.path === '/cancel') {
          if (config.cancelHolds) { pending.push(() => respond({ schema: 'astra-validator-cancel/v1', jobId: value.jobId, workflowId: value.workflowId, cleanupConfirmed: true })); return; }
          if (config.cancelTransportFailure) { queueMicrotask(() => req.emit('error', Error('private credentials'))); return; }
          queueMicrotask(() => respond({ schema: 'astra-validator-cancel/v1', jobId: value.jobId, workflowId: value.workflowId, cleanupConfirmed: !config.cleanupFailure }, config.cleanupFailure ? 503 : 200));
        } else {
          if (config.hold) { pending.push(() => respond(success())); return; }
          if (config.transportFailure) { queueMicrotask(() => req.emit('error', Error('PRIVATE SECRET'))); return; }
          queueMicrotask(() => respond(config.value ?? success(), config.status ?? 200, config.headers));
        }
      };
      return req;
    } },
  };
  const api = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
    { exports: api, require: name => { assert.ok(name in dependencies, name); return dependencies[name]; }, Buffer, TextDecoder, process: { env, getuid: () => process.getuid() },
      setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: id => timers.delete(id) });
  return { api, calls, pending, timers };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('client calls only private fixed POST with preselected cancel token and returns exact report', async () => {
  const f = fixture(), controller = new AbortController();
  const result = await f.api.validateAstraNativeJob(options(controller.signal));
  assert.equal(result.rawDrc, '{"raw":"fixture"}'); assert.equal(f.calls.length, 1);
  const { options: wire, value } = f.calls[0];
  assert.equal(wire.socketPath, socketPath); assert.equal(wire.path, '/validate'); assert.equal(wire.method, 'POST'); assert.equal(wire.agent, false);
  assert.equal(wire.headers.Authorization, `Bearer ${SECRET}`); assert.equal(wire.headers['X-Astra-Job-Token'], TOKEN);
  assert.deepEqual(value, { jobId: 'job-AbC123', workflowId: 'workflow_123', boardSha256: HASH });
  assert.equal(f.timers.size, 0);
});

test('invalid credentials/socket metadata/job identifiers reject before transport', async () => {
  for (const config of [{ env: { ASTRA_VALIDATOR_SECRET: '' } }, { env: { ASTRA_VALIDATOR_SOCKET: '/tmp/arbitrary.sock' } }, { linked: true }, { socketMode: 0o666 }]) {
    const f = fixture(config); await assert.rejects(f.api.validateAstraNativeJob(options(new AbortController().signal)), error => error.category === 'configuration'); assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  for (const fields of [{ jobId: '../job-AbC123' }, { workflowId: ['wf'] }, { boardSha256: 'short' }]) await assert.rejects(f.api.validateAstraNativeJob({ ...options(new AbortController().signal), ...fields }));
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(f.api.validateAstraNativeJob(options(cancelled.signal)), error => error.category === 'cancelled' && error.cleanupConfirmed);
  assert.equal(f.calls.length, 0);
});

test('abort destroys validation then sends fresh cancel request and waits for owned cleanup', async () => {
  const f = fixture({ hold: true, cancelHolds: true }), controller = new AbortController();
  let settled = false;
  const result = f.api.validateAstraNativeJob(options(controller.signal)).catch(error => { settled = true; return error; });
  await tick(); controller.abort(); await tick();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].destroyed(), true); assert.equal(settled, false);
  assert.equal(f.calls[1].options.path, '/cancel');
  assert.deepEqual(f.calls[1].value, { jobId: 'job-AbC123', workflowId: 'workflow_123', jobToken: TOKEN });
  assert.ok([...f.timers.values()].some(timer => timer.ms === 90000));
  f.pending[1](); const error = await result;
  assert.equal(error.category, 'cancelled'); assert.equal(error.cleanupConfirmed, true); assert.equal(f.timers.size, 0);
});

test('transport failure and malformed/truncated/oversize response cannot skip cancellation', async () => {
  for (const config of [{ transportFailure: true }, { status: 500 }, { value: 'bad json' }, { value: { ...success(), boardSha256: '0'.repeat(64) } },
    { value: { ...success(), accounting: { ...success().accounting, stageMs: -1 } } }, { headers: { 'content-length': String(5 * 1024 * 1024 + 1) } },
    { value: 'x'.repeat(5 * 1024 * 1024 + 1) }, { value: { ...success(), rawDrc: 'x'.repeat(4 * 1024 * 1024 + 1) } }]) {
    const f = fixture(config);
    await assert.rejects(f.api.validateAstraNativeJob(options(new AbortController().signal)), error => error.category === 'validation' && error.cleanupConfirmed && !error.message.includes('PRIVATE'));
    assert.deepEqual(f.calls.map(call => call.options.path), ['/validate', '/cancel']);
  }
});

test('unconfirmed cancellation has explicit unsafe cleanup result and fresh deadline', async () => {
  for (const config of [{ cleanupFailure: true }, { cancelTransportFailure: true }]) {
    const f = fixture({ transportFailure: true, ...config });
    await assert.rejects(f.api.validateAstraNativeJob(options(new AbortController().signal)), error => error.category === 'cleanup' && error.cleanupConfirmed === false);
  }
  const f = fixture({ hold: true, cancelHolds: true });
  const result = f.api.validateAstraNativeJob(options(new AbortController().signal));
  const checked = assert.rejects(result, error => error.category === 'cleanup' && !error.cleanupConfirmed);
  await tick(); [...f.timers.values()].find(t => t.ms === 240000).fn(); await tick();
  [...f.timers.values()].find(t => t.ms === 90000).fn(); await checked;
});
