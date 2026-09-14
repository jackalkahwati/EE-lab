import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';

// All filesystem, HTTP sockets, staging and runtime operations are replaced.
// These tests never bind a socket or invoke Docker/native/model/app processes.
const source = await fs.readFile(new URL('../scripts/astra-validator-controller.mjs', import.meta.url), 'utf8');
const ROOT = '/Volumes/T9 Backup/compose-ux-tmp-bQ4c59';
const launchRoot = `${ROOT}/astra-app-owned-ABC123`;
const HASH = 'a'.repeat(64), TOKEN = 'b'.repeat(64), AUTH = 'c'.repeat(64);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(options = {}) {
  const calls = [], timers = new Map(); let server, timerId = 0, runtimeSignal, currentReceipt;
  const paths = new Map([[launchRoot, { ino: 1, mode: 0o700, kind: 'dir' }]]);
  const control = '/private/tmp/astra-v-XYZ123', socketPath = `${control}/control.sock`;
  const io = {
    lstat: async p => { const item = paths.get(p); if (!item) throw Error('Unknown file'); return { ...item, uid: process.getuid(), dev: 1, isDirectory: () => item.kind === 'dir', isSymbolicLink: () => false, isSocket: () => item.kind === 'socket' }; },
    realpath: async p => p,
    mkdtemp: async p => { assert.equal(p, '/private/tmp/astra-v-'); paths.set(control, { ino: 2, mode: 0o700, kind: 'dir' }); return control; },
    chmod: async (p, mode) => { paths.get(p).mode = mode; },
    rmdir: async p => { assert.equal(p, control); assert.ok(!paths.has(socketPath)); paths.delete(p); },
  };
  class Server extends EventEmitter {
    constructor(config, handler) { super(); this.config = config; this.handler = handler; }
    listen(p, cb) { assert.equal(p, socketPath); paths.set(p, { ino: 3, mode: 0o700, kind: 'socket' }); cb(); }
    close(cb) { calls.push('server.close'); paths.delete(socketPath); cb?.(); }
  }
  const raw = '{"fixture":"raw report, not native evidence"}';
  const deps = {
    'node:fs/promises': io, 'node:path': path, 'node:crypto': { ...crypto, randomBytes: () => Buffer.from(AUTH, 'hex') },
    'node:http': { createServer: (config, handler) => (server = new Server(config, handler)) },
    './astra-linux-drc.mjs': { JOB_ROOT: ROOT, readQualificationReport: async p => { assert.equal(p, `${ROOT}/astra-linux-job-${'d'.repeat(32)}`); calls.push('report'); return Buffer.from(options.mutatedReport ? 'changed' : raw); } },
    './astra-stage-validator.mjs': {
      createAppNativeValidationScope: async root => { assert.equal(root, launchRoot); calls.push('scope'); return Object.freeze({ launch: 'fixture' }); },
      stageAppNativeValidation: async (scope, jobId, boardSha256) => { assert.equal(scope.launch, 'fixture'); calls.push(['stage', jobId, boardSha256]); if (options.stageGate) await options.stageGate.promise; if (options.stageFailure) throw Error('PRIVATE PATH SECRET'); return { jobId: `astra-linux-job-${'d'.repeat(32)}`, boardSha256, authorizationSha256: HASH }; },
    },
    './astra-linux-runtime.mjs': {
      authorizeStagedDrcJob: async id => { calls.push(['authorize', id]); return Object.freeze({ runtime: true }); },
      runValidatedDrcJob: async ({ capability, signal }) => {
        assert.equal(capability.runtime, true); runtimeSignal = signal; calls.push('runtime');
        if (options.runtimeGate) await options.runtimeGate.promise;
        currentReceipt = { schema: 'astra-linux-job-runtime/v1', jobId: `astra-linux-job-${'d'.repeat(32)}`, boardSha256: HASH,
          authorizationSha256: HASH, reportSha256: hash(raw), cleanup: { confirmedAbsent: !options.cleanupFailure }, cancelled: signal.aborted };
        if (options.runtimeThrow) throw Error('unknown Docker state');
        return currentReceipt;
      },
    },
  };
  const api = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
    { exports: api, require: name => { assert.ok(name in deps, name); return deps[name]; }, Buffer, TextDecoder, process: { getuid: () => process.getuid() }, AbortController,
      setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: id => timers.delete(id) });
  const controller = await api.startAstraValidatorController({ launchRoot });
  function invoke(operation, value, extra = {}) {
    const req = new EventEmitter(); req.pause = () => {}; req.socket = {};
    req.method = extra.method ?? 'POST'; req.url = operation;
    req.headers = { authorization: `Bearer ${controller.authSecret}`, 'content-type': 'application/json', 'x-astra-job-token': extra.token ?? TOKEN, ...extra.headers };
    const res = new EventEmitter(); res.writableEnded = false; res.destroyed = false;
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
    res.end = bytes => { res.value = JSON.parse(bytes); res.writableEnded = true; };
    const done = server.handler(req, res);
    if (!extra.noBody) {
      req.emit('data', Buffer.from(extra.raw ?? JSON.stringify(value)));
      req.emit('end');
    }
    return { req, res, done };
  }
  const validate = (extra = {}) => invoke('/validate', { jobId: 'job-ABC123', boardSha256: HASH, workflowId: 'workflow_123', ...extra });
  return { api, controller, calls, server, timers, paths, invoke, validate, runtimeSignal: () => runtimeSignal, receipt: () => currentReceipt };
}

test('initialization is explicit fixed launch root; private short socket and secret stay out of response', async () => {
  const f = await fixture();
  assert.equal(f.controller.socketPath, '/private/tmp/astra-v-XYZ123/control.sock');
  assert.equal(f.paths.get(f.controller.socketPath).mode, 0o600);
  for (const root of ['/tmp/arbitrary', `${launchRoot}/../other`, ROOT, undefined]) await assert.rejects(f.api.startAstraValidatorController({ launchRoot: root }));
  assert.deepEqual(f.calls, ['scope']);
  const r = f.validate(); await r.done;
  assert.equal(r.res.status, 200); assert.equal(r.res.value.receipt.schema, 'astra-linux-job-runtime/v1');
  assert.equal(r.res.value.rawDrc, '{"fixture":"raw report, not native evidence"}');
  assert.equal(r.res.value.accounting.cleanupConfirmed, true);
  assert.ok(!JSON.stringify(r.res.value).includes(AUTH));
  assert.deepEqual(f.calls.slice(1, 4).map(x => Array.isArray(x) ? x[0] : x), ['stage', 'authorize', 'runtime']);
  assert.equal((await f.controller.close()).cleanupConfirmed, true);
});

test('GET, query strings, unknown operations, bad auth and hostile inputs never stage', async () => {
  const f = await fixture();
  const requests = [
    f.invoke('/validate', {}, { method: 'GET' }), f.invoke('/validate?root=/tmp', {}), f.invoke('/exec', {}),
    f.invoke('/validate', {}, { headers: { authorization: 'Bearer wrong' } }),
    f.invoke('/validate', {}, { raw: '{bad' }), f.invoke('/validate', {}, { raw: '"text"' }),
    f.invoke('/validate', { jobId: '../job-ABC123', workflowId: 'wf', boardSha256: HASH }),
    f.invoke('/validate', { jobId: ['job-ABC123'], workflowId: 'wf', boardSha256: HASH }),
    f.invoke('/validate', { jobId: 'job-ABC123', workflowId: 'wf', boardSha256: HASH, root: '/tmp' }),
    f.invoke('/validate', { jobId: 'job-ABC123', workflowId: ['wf'], boardSha256: HASH }),
    f.invoke('/validate', { jobId: 'job-ABC123', workflowId: 'wf', boardSha256: HASH }, { token: 'short' }),
  ];
  await Promise.all(requests.map(r => r.done));
  assert.ok(requests.every(r => r.res.status >= 400)); assert.deepEqual(f.calls, ['scope']);
  await f.controller.close();
});

test('4KiB bytes/content encoding/read deadline and incomplete headers are bounded', async () => {
  const f = await fixture();
  for (const extra of [{ raw: 'x'.repeat(4097) }, { headers: { 'content-length': '4097' } }, { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-type': 'text/plain' } }]) {
    const r = f.invoke('/validate', {}, extra); await r.done; assert.ok(r.res.status >= 400);
  }
  const slow = f.invoke('/validate', {}, { noBody: true });
  [...f.timers.values()].find(t => t.ms === 2000).fn(); await slow.done; assert.equal(slow.res.status, 408);
  const socket = new EventEmitter(); let destroyed = false; socket.destroy = () => { destroyed = true; socket.emit('close'); };
  f.server.emit('connection', socket);
  [...f.timers.values()].find(t => t.ms === 2000).fn(); assert.equal(destroyed, true);
  assert.deepEqual(f.calls, ['scope']); await f.controller.close();
});

test('one active job, owned cancel awaits runtime cleanup, replay cannot launch again', async () => {
  const gate = deferred(), f = await fixture({ runtimeGate: gate });
  const r = f.validate(); await tick(); assert.equal(f.runtimeSignal().aborted, false);
  const busy = f.validate({ jobId: 'job-XYZ789' }); await busy.done; assert.equal(busy.res.value.error, 'validator_busy');
  const foreign = f.invoke('/cancel', { jobId: 'job-ABC123', workflowId: 'foreign', jobToken: TOKEN }); await foreign.done; assert.equal(foreign.res.status, 403);
  assert.equal(f.runtimeSignal().aborted, false);
  const cancel = f.invoke('/cancel', { jobId: 'job-ABC123', workflowId: 'workflow_123', jobToken: TOKEN });
  await tick(); assert.equal(f.runtimeSignal().aborted, true); assert.equal(cancel.res.writableEnded, false);
  gate.resolve(); await Promise.all([r.done, cancel.done]);
  assert.equal(cancel.res.value.cleanupConfirmed, true); assert.equal(r.res.value.accounting.cancelled, true);
  const replay = f.validate(); await replay.done; assert.equal(replay.res.value.error, 'job_consumed');
  await f.controller.close();
});

test('cancel before accept is tombstoned and consumes the bounded launch budget', async () => {
  const f = await fixture();
  for (let i = 0; i < 32; i++) {
    const r = f.invoke('/cancel', { jobId: `job-${String(i).padStart(6, '0')}`, workflowId: 'wf', jobToken: TOKEN });
    await r.done; assert.equal(r.res.status, 200);
  }
  const r = f.invoke('/validate', { jobId: 'job-000000', workflowId: 'wf', boardSha256: HASH }); await r.done;
  assert.equal(r.res.value.error, 'job_consumed');
  const budget = f.validate(); await budget.done; assert.equal(budget.res.value.error, 'launch_budget');
  assert.deepEqual(f.calls, ['scope']); await f.controller.close();
});

test('disconnect during staging cancels before runtime; raw private exceptions are redacted', async () => {
  const gate = deferred(), f = await fixture({ stageGate: gate });
  const r = f.validate(); await tick(); r.res.emit('close'); gate.resolve(); await r.done;
  assert.equal(r.res.value.error, 'cancelled'); assert.ok(!f.calls.includes('runtime')); await f.controller.close();
  const broken = await fixture({ stageFailure: true }), failure = broken.validate(); await failure.done;
  assert.equal(failure.res.value.error, 'validation_failed'); assert.ok(!JSON.stringify(failure.res.value).includes('PRIVATE')); await broken.controller.close();
});

test('cleanup failure or unknown runtime state poisons launch and close reports unconfirmed', async () => {
  for (const options of [{ cleanupFailure: true }, { runtimeThrow: true }]) {
    const f = await fixture(options), r = f.validate(); await r.done;
    assert.equal(r.res.value.receipt, null); assert.equal(r.res.value.rawDrc, null); assert.equal(r.res.value.accounting.cleanupConfirmed, false);
    const another = f.validate({ jobId: 'job-XYZ789' }); await another.done; assert.equal(another.res.value.error, 'cleanup_unconfirmed');
    assert.equal((await f.controller.close()).cleanupConfirmed, false);
  }
});

test('deadline and launcher shutdown wait for owned termination, not just client kill', async () => {
  const gate = deferred(), f = await fixture({ runtimeGate: gate });
  const r = f.validate(); await tick();
  [...f.timers.values()].find(t => t.ms === 150000).fn(); assert.equal(f.runtimeSignal().aborted, true);
  let closed = false;
  const close = f.controller.close().then(result => { closed = true; return result; });
  await tick(); assert.equal(closed, false); gate.resolve(); await r.done;
  assert.equal((await close).cleanupConfirmed, true);
});

test('shutdown while request body is pending never starts work after close', async () => {
  const f = await fixture(), r = f.invoke('/validate', {}, { noBody: true });
  assert.equal((await f.controller.close()).cleanupConfirmed, true);
  r.req.emit('data', Buffer.from(JSON.stringify({ jobId: 'job-ABC123', boardSha256: HASH, workflowId: 'workflow_123' })));
  r.req.emit('end'); await r.done;
  assert.equal(r.res.value.error, 'controller_closing'); assert.ok(!f.calls.some(call => Array.isArray(call) && call[0] === 'stage'));
});

test('completed jobs preserve owned cancellation ack without rerunning or retaining report', async () => {
  const f = await fixture(), r = f.validate(); await r.done;
  const wrong = f.invoke('/cancel', { jobId: 'job-ABC123', workflowId: 'workflow_123', jobToken: 'f'.repeat(64) }); await wrong.done;
  assert.equal(wrong.res.status, 403);
  const cancel = f.invoke('/cancel', { jobId: 'job-ABC123', workflowId: 'workflow_123', jobToken: TOKEN }); await cancel.done;
  assert.equal(cancel.res.value.cleanupConfirmed, true); assert.equal(f.calls.filter(call => call === 'runtime').length, 1);
  await f.controller.close();
});

test('runtime report mutation and socket replacement fail closed', async () => {
  const mutated = await fixture({ mutatedReport: true }), r = mutated.validate(); await r.done;
  assert.equal(r.res.value.error, 'report_identity'); assert.equal(r.res.value.rawDrc, null); await mutated.controller.close();
  const replaced = await fixture(); replaced.paths.get(replaced.controller.socketPath).ino++;
  const bad = replaced.validate(); await bad.done; assert.equal(bad.res.value.error, 'validation_failed'); assert.deepEqual(replaced.calls, ['scope']); await replaced.controller.close();
});
