// Trusted launcher only. Never import into the sandboxed web process. Importing
// this module starts nothing; the launcher passes its already verified snapshot.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { JOB_ROOT, readQualificationReport } from './astra-linux-drc.mjs';
import { createAppNativeValidationScope, stageAppNativeValidation } from './astra-stage-validator.mjs';
import { authorizeStagedDrcJob, runValidatedDrcJob } from './astra-linux-runtime.mjs';

const BODY_LIMIT = 4096;
const READ_MS = 2000;
// Abort deadline, not a cleanup deadline. The fixed runtime's 120s CLI budget
// is followed by bounded inspect/remove/absence verification. Never release an
// active slot or close the controller merely because the client stopped waiting.
const JOB_MS = 150000;
const MAX_JOBS = 32;
const MAX_CONNECTIONS = 8;
const SHA = /^[a-f0-9]{64}$/;
const JOB = /^job-[A-Za-z0-9]{6}$/;
const WORKFLOW = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const record = x => !!x && typeof x === 'object' && !Array.isArray(x);
class Rejection extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function reject(status, code) { throw new Rejection(status, code); }
function exact(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function identity(value) { return { dev: value.dev, ino: value.ino }; }
async function directory(dir) {
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) || await fs.realpath(dir) !== dir) throw Error('Invalid private controller directory');
  return identity(st);
}
function same(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function send(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  let bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > 5 * 1024 * 1024) { status = 502; bytes = JSON.stringify({ error: 'response_limit' }); }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close', 'Content-Length': Buffer.byteLength(bytes) });
  res.end(bytes);
}
function authenticated(req, secret) {
  const actual = req.headers.authorization;
  const expected = `Bearer ${secret}`;
  return typeof actual === 'string' && Buffer.byteLength(actual) === Buffer.byteLength(expected)
    && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
async function body(req) {
  if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding'] || req.headers.expect) reject(400, 'invalid_content');
  if (req.headers['content-length'] !== undefined && (!/^[0-9]+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > BODY_LIMIT)) reject(413, 'body_limit');
  return new Promise((resolve, fail) => {
    let length = 0, settled = false;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      req.removeListener('data', data); req.removeListener('end', end);
      req.removeListener('aborted', aborted); req.removeListener('error', aborted);
      if (error) { req.pause(); fail(error); } else resolve(value);
    };
    const data = chunk => {
      length += chunk.length;
      if (length > BODY_LIMIT) finish(new Rejection(413, 'body_limit'));
      else chunks.push(chunk);
    };
    const aborted = () => finish(new Rejection(400, 'request_aborted'));
    const end = () => {
      try {
        const bytes = Buffer.concat(chunks);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        finish(null, JSON.parse(text));
      } catch { finish(new Rejection(400, 'invalid_json')); }
    };
    const timer = setTimeout(() => finish(new Rejection(408, 'read_deadline')), READ_MS);
    req.on('data', data); req.once('end', end); req.once('aborted', aborted); req.once('error', aborted);
  });
}

/**
 * Exactly one launch-owned HOME. There is no executable, image, root, mount,
 * environment, filesystem path, or registration operation in the wire API.
 * Returned credentials belong only in the launcher's private child channel.
 */
export async function startAstraValidatorController({ launchRoot }) {
  if (typeof launchRoot !== 'string' || path.dirname(launchRoot) !== JOB_ROOT || !/^astra-app-owned-[A-Za-z0-9]{6}$/.test(path.basename(launchRoot))) throw Error('Invalid launcher root');
  const rootIdentity = await directory(launchRoot);
  const scope = await createAppNativeValidationScope(launchRoot);
  // macOS cannot address a socket beneath the long external snapshot path.
  // This one newly owned directory is the ONLY added sandbox socket allowance.
  const controlRoot = await fs.mkdtemp('/private/tmp/astra-v-');
  await fs.chmod(controlRoot, 0o700);
  const controlIdentity = await directory(controlRoot);
  const socketPath = path.join(controlRoot, 'control.sock');
  // macOS sockaddr_un is limited to 104 bytes including its terminating NUL.
  if (Buffer.byteLength(socketPath) > 103) throw Error('Controller Unix socket path exceeds platform bound');
  const authSecret = crypto.randomBytes(32).toString('hex');
  const jobs = new Map(), sockets = new Set();
  let active = null, closing = false, poisoned = false, ready = false, socketIdentity;
  async function removeEmptyEndpointDirectory() {
    // Never recursively remove an endpoint directory or unlink a replacement.
    const current = await directory(controlRoot);
    if (!same(current, controlIdentity)) throw Error('Controller endpoint directory changed');
    await fs.rmdir(controlRoot);
  }
  async function intact() {
    if (!same(await directory(launchRoot), rootIdentity) || !same(await directory(controlRoot), controlIdentity)) throw Error('Controller root changed');
    const socket = await fs.lstat(socketPath);
    if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== process.getuid() || (socket.mode & 0o777) !== 0o600 || !same(identity(socket), socketIdentity)) throw Error('Controller socket changed');
  }
  async function execute(entry) {
    let receipt = null, rawDrc = null;
    const started = Date.now();
    const accounting = { requestedAt: new Date(started).toISOString(), stageMs: 0, runtimeMs: 0, totalMs: 0, cancelled: false, cleanupConfirmed: true };
    const timer = setTimeout(() => entry.aborter.abort('deadline'), JOB_MS);
    let runtimeEntered = false;
    try {
      await intact();
      if (entry.aborter.signal.aborted) reject(409, 'cancelled');
      const staged = await stageAppNativeValidation(scope, entry.jobId, entry.boardSha256);
      entry.linuxJobId = staged.jobId;
      accounting.stageMs = Date.now() - started;
      if (entry.aborter.signal.aborted) reject(409, 'cancelled');
      const capability = await authorizeStagedDrcJob(staged.jobId);
      if (entry.aborter.signal.aborted) reject(409, 'cancelled');
      const runtimeStart = Date.now();
      runtimeEntered = true; accounting.cleanupConfirmed = false;
      receipt = await runValidatedDrcJob({ capability, signal: entry.aborter.signal });
      accounting.runtimeMs = Date.now() - runtimeStart;
      accounting.cleanupConfirmed = receipt.cleanup?.confirmedAbsent === true && !receipt.cleanupFailure;
      // Absence is required even when the CLI produced an otherwise good report.
      // A pre-container runtime failure is also fail-closed, never a green result.
      if (!accounting.cleanupConfirmed) { poisoned = true; reject(503, 'cleanup_unconfirmed'); }
      if (receipt.jobId !== staged.jobId || receipt.boardSha256 !== entry.boardSha256 || receipt.authorizationSha256 !== staged.authorizationSha256) reject(502, 'receipt_identity');
      if (receipt.reportSha256) {
        const bytes = await readQualificationReport(path.join(JOB_ROOT, staged.jobId));
        if (sha(bytes) !== receipt.reportSha256) reject(502, 'report_identity');
        rawDrc = bytes.toString('utf8');
      }
      await intact();
      return { schema: 'astra-validator-result/v1', jobId: entry.jobId, workflowId: entry.workflowId, boardSha256: entry.boardSha256, receipt, rawDrc, accounting };
    } catch (error) {
      if (runtimeEntered && !accounting.cleanupConfirmed) poisoned = true;
      return { schema: 'astra-validator-result/v1', jobId: entry.jobId, workflowId: entry.workflowId, boardSha256: entry.boardSha256,
        error: error instanceof Rejection ? error.code : 'validation_failed', receipt: null, rawDrc: null, accounting };
    } finally {
      clearTimeout(timer);
      accounting.cancelled = entry.aborter.signal.aborted;
      accounting.totalMs = Date.now() - started;
      accounting.finishedAt = new Date().toISOString();
    }
  }
  async function handle(req, res) {
    try {
      if (!authenticated(req, authSecret)) reject(401, 'unauthorized');
      if (req.method !== 'POST' || !['/validate', '/cancel'].includes(req.url)) reject(404, 'not_found');
      if (closing || !ready) reject(503, 'controller_closing');
      const value = await body(req);
      // Shutdown may start while an authenticated client is still reading a body.
      if (closing || !ready) reject(503, 'controller_closing');
      if (req.url === '/cancel') {
        if (!exact(value, ['jobId', 'workflowId', 'jobToken']) || !matches(JOB, value.jobId) || !matches(WORKFLOW, value.workflowId) || !matches(SHA, value.jobToken)) reject(400, 'invalid_cancel');
        let entry = jobs.get(value.jobId);
        if (entry && (entry.workflowId !== value.workflowId || entry.jobToken !== value.jobToken)) reject(403, 'job_ownership');
        if (!entry) {
          if (jobs.size >= MAX_JOBS) reject(429, 'launch_budget');
          entry = { ...value, cancelledBeforeStart: true }; jobs.set(value.jobId, entry);
        }
        entry.aborter?.abort('cancelled');
        const result = entry.done ? await entry.done : null;
        const confirmed = result ? result.accounting.cleanupConfirmed : true;
        send(res, confirmed ? 200 : 503, { schema: 'astra-validator-cancel/v1', jobId: value.jobId, workflowId: value.workflowId, cleanupConfirmed: confirmed });
        return;
      }
      const jobToken = req.headers['x-astra-job-token'];
      if (!exact(value, ['jobId', 'boardSha256', 'workflowId']) || !matches(JOB, value.jobId) || !matches(SHA, value.boardSha256) || !matches(WORKFLOW, value.workflowId) || !matches(SHA, jobToken)) reject(400, 'invalid_validate');
      if (poisoned) reject(503, 'cleanup_unconfirmed');
      if (jobs.has(value.jobId)) reject(409, 'job_consumed');
      if (active) reject(409, 'validator_busy');
      if (jobs.size >= MAX_JOBS) reject(429, 'launch_budget');
      const entry = { ...value, jobToken, aborter: new AbortController(), done: null };
      jobs.set(value.jobId, entry); active = entry;
      // A lost transport cancels the job too; the explicit cancel operation lets
      // the caller wait for cleanup rather than guessing that a disconnect did it.
      const disconnected = () => { if (!res.writableEnded) entry.aborter.abort('disconnected'); };
      res.once('close', disconnected);
      entry.done = execute(entry);
      const result = await entry.done;
      active = null;
      res.removeListener('close', disconnected);
      // Do not retain the potentially multi-MiB report in the bounded replay map.
      entry.done = Promise.resolve({ accounting: result.accounting });
      send(res, result.error ? (result.error === 'cleanup_unconfirmed' ? 503 : 502) : 200, result);
    } catch (error) {
      send(res, error instanceof Rejection ? error.status : 500, { error: error instanceof Rejection ? error.code : 'controller_failed' });
    }
  }
  const server = http.createServer({ maxHeaderSize: 4096, headersTimeout: READ_MS, requestTimeout: READ_MS, connectionsCheckingInterval: 250 }, handle);
  server.maxHeadersCount = 16;
  server.maxConnections = MAX_CONNECTIONS;
  server.keepAliveTimeout = 1;
  const headerTimers = new WeakMap();
  server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    // Bound sockets that never even complete their HTTP headers.
    const timer = setTimeout(() => socket.destroy(), READ_MS);
    socket.once('close', () => clearTimeout(timer));
    headerTimers.set(socket, timer);
  });
  server.prependListener('request', req => clearTimeout(headerTimers.get(req.socket)));
  server.on('checkContinue', (_req, res) => send(res, 400, { error: 'invalid_content' }));
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  try {
    await new Promise((resolve, fail) => { server.once('error', fail); server.listen(socketPath, () => { server.removeListener('error', fail); resolve(); }); });
    await fs.chmod(socketPath, 0o600);
    socketIdentity = identity(await fs.lstat(socketPath));
    await intact();
    ready = true;
  } catch {
    closing = true;
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    try { await removeEmptyEndpointDirectory(); } catch { /* Retain unknown endpoint state; never delete another inode. */ }
    throw Error('Astra validator controller startup failed');
  }
  server.on('error', () => { poisoned = true; closing = true; active?.aborter.abort('controller_error'); });
  let closePromise;
  return Object.freeze({ socketPath, authSecret, close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const pending = active;
      pending?.aborter.abort('launcher_shutdown');
      const stopped = new Promise(resolve => server.close(resolve));
      const result = pending?.done ? await pending.done : null;
      for (const socket of sockets) socket.destroy();
      await stopped;
      // Node removes its own Unix socket on close. Never unlink a replacement.
      try { await removeEmptyEndpointDirectory(); } catch { poisoned = true; }
      return { cleanupConfirmed: !poisoned && (!result || result.accounting.cleanupConfirmed) };
    })();
    return closePromise;
  } });
}
