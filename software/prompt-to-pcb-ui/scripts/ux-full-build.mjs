#!/usr/bin/env node
/** Source-only, LOCAL build staging. No action without an explicit mode.
 * --check                         inspect current sources, never writes/executes app
 * --prepare                       make an owned snapshot, never builds
 * --build <snapshot>              explicit later authorization required
 * --build <snapshot> --offline-rehearsal  mocked fonts, NOT a production gate
 * --self-test                     pure safety checks, never builds
 * All outputs stay under the existing approved scratch directory. No installs,
 * server, provider/native pipeline, production data, or original config edits.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

import { SOURCE, SCRATCH, LIMIT, EXCLUDED, hash, fail, cleanRelative, noLinks, safeRead,
  inventory, inspectImports, inspectDependencyLinks, writeNew, freeBytes, treeSize } from './source-snapshot.mjs';
const SELF = path.join(SOURCE, 'scripts/ux-full-build.mjs');
const require = createRequire(path.join(SOURCE, 'package.json'));

function cleanEnv(root, rehearsal = false) {
  return { PATH: path.dirname(fs.realpathSync(process.execPath)), HOME: path.join(root, 'home'),
    TMPDIR: path.join(root, 'tmp'), XDG_CACHE_HOME: path.join(root, 'home/cache'),
    NODE_ENV: 'production', NEXT_DIST_DIR: '.next-owned', NEXT_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1', CI: '1', TZ: 'UTC', RAYON_NUM_THREADS: '1', UV_THREADPOOL_SIZE: '2',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    AUTH_SECRET: 'owned-build-only-not-a-real-credential',
    ENTERPRISE_STORE_DIR: path.join(root, 'state/enterprise'),
    NODE_OPTIONS: `--max-old-space-size=${LIMIT.nodeHeapMiB} --require=${JSON.stringify(path.join(root, 'guard.cjs'))}`,
    ...(rehearsal ? { NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(root, 'font-rehearsal.cjs') } : {}) };
}
function guardCode(worker, node) {
  return `'use strict';
const fs = require('node:fs'), cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const fail = () => { throw new Error('OWNED_BUILD_GUARD: network/native process forbidden'); };
globalThis.fetch = async () => fail();
const os = require('node:os'), cpus = os.cpus;
os.availableParallelism = () => 2; os.cpus = () => cpus().slice(0, 2);
for (const name of ['node:http','node:https']) { const m = require(name); m.request = fail; m.get = fail; }
const net = require('node:net'); net.connect = fail; net.createConnection = fail;
net.Socket.prototype.connect = fail; net.Server.prototype.listen = fail;
const tls = require('node:tls'); tls.connect = fail;
const dns = require('node:dns'); for (const k of Object.keys(dns)) if (/^(resolve|lookup)/.test(k) && typeof dns[k] === 'function') dns[k] = fail;
for (const k of Object.keys(dns.promises)) if (typeof dns.promises[k] === 'function') dns.promises[k] = async () => fail();
const dgram = require('node:dgram'); dgram.createSocket = fail;
const fork = cp.fork;
cp.fork = function(modulePath, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  options = options || {};
  if (fs.realpathSync(modulePath) !== ${JSON.stringify(worker)} || args.length ||
      (options.execPath && fs.realpathSync(options.execPath) !== ${JSON.stringify(node)})) fail();
  // Next reformats NODE_OPTIONS and may move --require to execArgv. Pin our
  // preload/heap cap rather than rejecting harmless formatting or losing it.
  return fork.call(this, modulePath, [], { ...options, detached: false, execPath: ${JSON.stringify(node)},
    execArgv: [], env: { ...(options.env || process.env), NODE_OPTIONS: process.env.NODE_OPTIONS } });
};
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']) cp[name] = fail;
syncBuiltinESMExports();
`;
}
function sandbox(root, dependencies, node) {
  const q = JSON.stringify;
  // Default deny prevents reading real HOME, other scratch jobs, repository data,
  // or executing KiCad/Python/Cargo/provider CLIs. Worker pipes remain available;
  // no internet, localhost TCP or DNS exception. A sandbox error is a blocker.
  return `(version 1)\n(deny default)\n(allow process-fork process-info* sysctl-read mach* ipc-posix* signal)\n` +
    `(allow process-exec (literal ${q(node)}))\n` +
    `(allow file-read* (subpath ${q(root)}) (subpath ${q(dependencies)}) (subpath ${q(path.dirname(path.dirname(node)))})\n` +
    ` (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/private/var/db") (subpath "/dev") (literal "/"))\n` +
    `(allow file-write* (subpath ${q(root)}) (literal "/dev/null"))\n(deny network*)\n`;
}
const FONT_MOCK = `// OFFLINE REHEARSAL ONLY. No real font files or production font validation.
module.exports = {
  'https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap': '@font-face { font-family: Inter; src: local("Arial"); font-weight: 100 900; }',
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@100..800&display=swap': '@font-face { font-family: "JetBrains Mono"; src: local("Courier New"); font-weight: 100 800; }'
};
`;
function prepare(files, imports) {
  const dependencyLinks = inspectDependencyLinks();
  noLinks(SCRATCH);
  if (freeBytes(SCRATCH) < LIMIT.minFreeBytes) fail('Insufficient scratch free space');
  const root = fs.mkdtempSync(path.join(SCRATCH, 'full-app-owned-'));
  const app = path.join(root, 'app-source');
  fs.mkdirSync(app, { mode: 0o700 });
  const copied = [];
  for (const [relative, bytes] of files) {
    writeNew(app, relative, bytes); copied.push({ relative, bytes: bytes.length, sha256: hash(bytes) });
  }
  const dependencies = fs.realpathSync(path.join(SOURCE, 'node_modules'));
  if (dependencies !== path.join(SOURCE, 'node_modules')) fail('Unexpected dependency-root symlink');
  fs.symlinkSync(dependencies, path.join(app, 'node_modules'), 'dir');
  const node = fs.realpathSync(process.execPath);
  const worker = fs.realpathSync(require.resolve('next/dist/compiled/jest-worker/processChild.js'));
  const generated = {
    'app-source/next-env.d.ts': '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n',
    'guard.cjs': guardCode(worker, node), 'build.sb': sandbox(root, dependencies, node),
    'font-rehearsal.cjs': FONT_MOCK,
  };
  for (const [relative, bytes] of Object.entries(generated)) writeNew(root, relative, bytes);
  for (const d of ['home', 'tmp', 'state']) fs.mkdirSync(path.join(root, d), { mode: 0o700 });
  const manifest = { version: 1, createdAt: new Date().toISOString(), root, app, source: SOURCE,
    launcherSha256: hash(fs.readFileSync(SELF)), stagingSha256: hash(safeRead(SOURCE, 'scripts/source-snapshot.mjs')), node, nodeVersion: process.version, node22: 'not found; no downloads',
    dependencies, dependencyLinks, nextCli: fs.realpathSync(require.resolve('next/dist/bin/next')), copied,
    generated: Object.entries(generated).map(([relative, bytes]) => ({ relative, sha256: hash(bytes) })),
    imports, excluded: EXCLUDED, limits: LIMIT, env: cleanEnv(root),
    alterations: ['next-env.d.ts regenerated without existing .next-v9 cache reference',
      'NEXT_DIST_DIR points only at owned output; actual Next config copied unchanged'],
    caveats: ['No production data, runtime API test, hardware execution, or server.',
      'Plain build is offline and expected to fail uncached Google fonts. No network opt-in implemented.',
      'Optional font rehearsal is explicitly not a full production gate.',
      'Node25 is installed, Node22 not available in checked local runtime locations.',
      'Dependency tree is linked, not frozen. Source changes after prepare are rejected before build.',
      'Output and elapsed-time limits are sampled; not an OS filesystem quota. Per-process heap capped.'],
    tests: { e10: 'BLOCKED: gitless snapshot cannot faithfully run tracked-file secret scan; do not spoof git.',
      firmware: 'Separate pure-Python fixture needs tests/firmware-families.test.mjs, scripts/fw_families.py, hardware/planner/mcu_specs.py and pipeline route text; no native compile needed.' } };
  writeNew(root, 'manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
function validateSnapshot(input) {
  const root = path.resolve(input);
  if (path.dirname(root) !== SCRATCH || !path.basename(root).startsWith('full-app-owned-')) fail('Not an owned snapshot');
  noLinks(root);
  const manifest = JSON.parse(safeRead(root, 'manifest.json'));
  if (manifest.version !== 1 || manifest.root !== root || manifest.source !== SOURCE || manifest.app !== path.join(root, 'app-source')) fail('Snapshot identity mismatch');
  if (manifest.launcherSha256 !== hash(fs.readFileSync(SELF))) fail('Launcher changed: prepare a fresh snapshot');
  if (manifest.stagingSha256 !== hash(safeRead(SOURCE, 'scripts/source-snapshot.mjs'))) fail('Staging helper changed: prepare a fresh snapshot');
  if (manifest.node !== fs.realpathSync(process.execPath)) fail('Node binary changed');
  if (fs.existsSync(path.join(root, 'build-started.json'))) fail('Snapshot is single use: prepare a fresh snapshot');
  inspectDependencyLinks();
  const current = inventory(); inspectImports(current);
  if (current.size !== manifest.copied.length) fail('Source inventory changed: prepare again');
  for (const file of manifest.copied) {
    if (!current.has(file.relative) || hash(current.get(file.relative)) !== file.sha256 || hash(safeRead(manifest.app, file.relative)) !== file.sha256) fail(`Snapshot/source changed: ${file.relative}`);
  }
  for (const file of manifest.generated) if (hash(safeRead(root, file.relative)) !== file.sha256) fail(`Generated safety input changed: ${file.relative}`);
  if (manifest.dependencies !== path.join(SOURCE, 'node_modules') || fs.realpathSync(path.join(manifest.app, 'node_modules')) !== manifest.dependencies) fail('Dependency link changed');
  if (manifest.nextCli !== fs.realpathSync(require.resolve('next/dist/bin/next'))) fail('Next CLI changed');
  const allowed = new Set(['manifest.json', ...manifest.generated.map(f => f.relative), ...manifest.copied.map(f => `app-source/${f.relative}`)]);
  function walk(relative = '') {
    for (const e of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${e.name}` : e.name;
      if (name === 'app-source/node_modules' && e.isSymbolicLink()) continue;
      if (e.isSymbolicLink()) fail(`Unexpected snapshot symlink: ${name}`);
      if (e.isDirectory()) walk(name);
      else if (!allowed.has(name)) fail(`Unexpected snapshot file: ${name}`);
    }
  }
  walk();
  return manifest;
}
async function build(root, rehearsal) {
  const m = validateSnapshot(root);
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) fail('Required macOS sandbox unavailable; no fallback');
  if (freeBytes(m.root) < LIMIT.minFreeBytes) fail('Insufficient free space');
  const started = Date.now();
  writeNew(m.root, 'build-started.json', JSON.stringify({ started: new Date().toISOString(), rehearsal, productionGate: false }));
  const log = fs.openSync(path.join(m.root, 'build.log'), 'wx', 0o600);
  const child = spawn('/usr/bin/sandbox-exec', ['-f', path.join(m.root, 'build.sb'), m.node, m.nextCli, 'build', '--webpack'], {
    cwd: m.app, env: cleanEnv(m.root, rehearsal), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logBytes = 0, reason = null, hardKill;
  function stop(why) {
    if (reason) return;
    reason = why;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    hardKill = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000);
  }
  function capture(chunk) {
    const room = Math.max(0, LIMIT.logBytes - logBytes);
    if (room) fs.writeSync(log, chunk.subarray(0, room));
    logBytes += chunk.length;
    if (logBytes > LIMIT.logBytes) stop('log-size-limit');
  }
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const timer = setInterval(() => {
    try {
      if (Date.now() - started >= LIMIT.wallMs) stop('wall-time-limit');
      else if (freeBytes(m.root) < LIMIT.minFreeBytes) stop('free-space-limit');
      else if (treeSize(m.root) > LIMIT.outputBytes) stop('output-size-limit');
    } catch (e) { stop(`budget-check-failed: ${e.message}`); }
  }, LIMIT.pollMs);
  const interrupt = () => stop('interrupted');
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const result = await new Promise(resolve => {
    child.once('error', error => { reason = `spawn-error: ${error.message}`; resolve({ code: null, signal: null }); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearInterval(timer); clearTimeout(hardKill);
  // Terminate any orphaned worker in this owned process group, including on success.
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  fs.closeSync(log);
  const report = { ...result, reason, elapsedMs: Date.now() - started, logBytes,
    rehearsal, nodeVersion: process.version, productionGate: false,
    scope: rehearsal ? 'offline source-compilation rehearsal, synthetic font CSS' : 'offline full-app source build, fonts unmodified',
    log: path.join(m.root, 'build.log') };
  writeNew(m.root, 'result.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = result.code === 0 && !reason ? 0 : 1;
}
function selfTest() {
  for (const p of ['../secret', '/tmp/file', '.env.local', 'app/../data/x', 'app//x']) assert.throws(() => cleanRelative(p));
  assert.equal(cleanRelative('lib/schematic-skin.svg'), 'lib/schematic-skin.svg');
  const env = cleanEnv('/owned');
  assert.equal(env.HOME, '/owned/home');
  assert.equal(env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES, undefined);
  assert.equal(cleanEnv('/owned', true).NEXT_FONT_GOOGLE_MOCKED_RESPONSES, '/owned/font-rehearsal.cjs');
  for (const key of ['AWS_PROFILE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HTTP_PROXY', 'FL_PASSWORD', 'VERCEL']) assert.equal(env[key], undefined);
  assert.match(sandbox('/owned', '/deps', '/node'), /\(deny network\*\)/);
  assert.throws(() => validateSnapshot(SOURCE));
  console.log('Safety self-tests passed; no application execution, snapshot or build.');
}
async function main() {
  const args = process.argv.slice(2);
  if (fileURLToPath(import.meta.url) !== SELF) fail('Run the reviewed launcher from its canonical source path');
  if (args.length === 1 && args[0] === '--self-test') return selfTest();
  if (args.length === 1 && ['--check', '--prepare'].includes(args[0])) {
    const files = inventory(), imports = inspectImports(files);
    if (args[0] === '--check') console.log(JSON.stringify({ mode: 'check-only', files: files.size,
      bytes: [...files.values()].reduce((n, b) => n + b.length, 0), imports, excluded: EXCLUDED,
      limits: LIMIT, node: process.version, buildStarted: false }, null, 2));
    else { const m = prepare(files, imports); console.log(JSON.stringify({ root: m.root, manifest: path.join(m.root, 'manifest.json'), files: m.copied.length, buildStarted: false }, null, 2)); }
    return;
  }
  if (args[0] === '--build' && args[1] && (args.length === 2 || (args.length === 3 && args[2] === '--offline-rehearsal'))) return build(args[1], args[2] === '--offline-rehearsal');
  fail('Usage: --check | --prepare | --self-test | --build <owned-snapshot> [--offline-rehearsal]. No default execution.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
