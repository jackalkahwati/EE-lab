#!/usr/bin/env node
// Launch-owned qualification controller. Not an HTTP handler or a general Docker API.
// Acquisition is deliberately separate; this operation never pulls or changes Docker settings.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
// Direct TypeScript import requires Node >=22.18 (native type stripping) or Node25.
// The qualification controller is not part of the product's HTTP runtime.
import { parseAstraDrcReport } from '../lib/astra-drc.ts';

export const IMAGE = 'kicad/kicad@sha256:fdcfa0e8d41f640d16edfb28e027fe8862ab31af9e45dcacbc662cec5c916e4c';
export const JOB_ROOT = '/Volumes/T9 Backup/compose-ux-tmp-bQ4c59';
const SOURCE = `${JOB_ROOT}/astra-native-test-2lDgqB`;
const ASSETS = '/Applications/KiCad/KiCad.app/Contents/SharedSupport';
const SOCKET = 'unix:///Users/jackal-kahwati/.docker/run/docker.sock';
const DOCKER = '/usr/local/bin/docker';
const GiB = 1024 ** 3;
const BOARD_HASH = '2af2284839fef3914d9ac5416d67c46af4323b9c28b9f6c438ce4683864fcafc';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
export function jobPath(jobId) {
  if (!/^astra-linux-drc-[a-z0-9]{8,32}$/.test(jobId)) fail('Invalid authorized qualification job ID');
  return path.join(JOB_ROOT, jobId);
}
async function regular(file) {
  const st = await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid()) fail(`Not an owned regular file: ${file}`);
  if (await fs.realpath(file) !== file) fail(`Symlink ancestor: ${file}`);
  return st;
}
async function ownedDirectory(dir) {
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o022)) fail(`Not a private owned directory: ${dir}`);
  if (await fs.realpath(dir) !== dir) fail(`Symlink ancestor: ${dir}`);
}
const REPORT_LIMIT = 4 * 1024 ** 2;
/** Read the fixed container output without following links or allocating unbounded data. */
export async function readQualificationReport(dir, io = fs) {
  const dirs = [dir, path.join(dir, 'output')];
  const snapshots = [];
  for (const directory of dirs) {
    const st = await io.lstat(directory);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || await io.realpath(directory) !== directory) fail('Unowned or linked report directory');
    snapshots.push(st);
  }
  const file = path.join(dirs[1], 'drc.json');
  const handle = await io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await handle.stat();
    // Docker Desktop may map UID 65532 to a host UID. File ownership is not
    // assumed; the fixed new host-owned directory and exact open FD are checked.
    if (!st.isFile() || st.nlink !== 1 || st.size <= 0 || st.size > REPORT_LIMIT) fail('Invalid bounded native report file');
    const verify = async () => {
      for (let i = 0; i < dirs.length; i++) {
        const current = await io.lstat(dirs[i]);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== snapshots[i].dev || current.ino !== snapshots[i].ino || await io.realpath(dirs[i]) !== dirs[i]) fail('Report directory changed');
      }
      const current = await io.lstat(file), after = await handle.stat();
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== st.dev || current.ino !== st.ino
        || after.nlink !== 1 || after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) fail('Native report changed during read');
    };
    await verify();
    const bytes = Buffer.alloc(st.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== st.size) fail('Native report size changed during read');
    await verify();
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
export function validateKnownBadReport(report) {
  const parsed = parseAstraDrcReport(report, { engineVersion: '10.0.5', source: 'final-board.kicad_pcb', schematicParity: 'not-run' });
  if (!parsed.checksComplete || parsed.unrouted !== 4 || parsed.rawCounts.schematic_parity.total || parsed.passed) fail('Known-bad native report qualification failed');
  if (report.unconnected_items.some(x => x.severity !== 'error' || x.type !== 'unconnected_items' || x.items.length < 2)) fail('Incomplete known-bad endpoints');
  return parsed;
}
async function json(file) { await regular(file); return JSON.parse(await fs.readFile(file, 'utf8')); }
async function writeJson(file, value) { await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
async function walk(dir) {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { await ownedDirectory(p); result.push(...await walk(p)); }
    else { await regular(p); result.push(p); }
  }
  return result.sort();
}
export async function hashTree(dir) {
  const result = {};
  for (const file of await walk(dir)) result[path.relative(dir, file)] = sha(await fs.readFile(file));
  return result;
}
export function assertHashes(actual, expected) {
  const keys = Object.keys(actual).sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(expected).sort()) || keys.some(k => actual[k] !== expected[k])) fail('Qualification input hashes changed');
}
// Internal launch-controller transport. Never expose this adapter to an HTTP caller.
export function runAstraDrcDockerCommand(args, { timeoutMs = 15000, signal } = {}) {
  return new Promise((resolve, reject) => {
    // Do not inherit Docker context, cloud credentials, proxy variables, or host display.
    const child = spawn(DOCKER, ['--host', SOCKET, ...args], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/var/empty' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', reason = null;
    const stop = why => { reason ||= why; child.kill('SIGKILL'); };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', b => { stdout += b; if (stdout.length > 4 * 1024 ** 2) stop('stdout bound'); });
    child.stderr.on('data', b => { stderr += b; if (stderr.length > 4 * 1024 ** 2) stop('stderr bound'); });
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolve({ code, signal: exitSignal, reason, stdout, stderr });
    });
  });
}
const command = runAstraDrcDockerCommand;
async function checked(args) {
  const result = await command(args);
  if (result.code !== 0) fail(`Docker ${args[0]} failed: ${result.reason || result.stderr.trim()}`);
  return result.stdout;
}

/** Absence is two independent successful observations, never a generic Docker error. */
export async function confirmOwnedContainerAbsent(target, inspect, run = command) {
  const isId = /^[a-f0-9]{64}$/.test(target);
  const isName = /^astra-drc-[a-z0-9]{8,32}-[a-f0-9]{16}$/.test(target);
  if (!isId && !isName) fail('Invalid owned container absence target');
  const stdout = inspect.stdout?.trim();
  const expected = new RegExp(`^(?:error:|error response from daemon:) no such (?:object|container): ${target}$`, 'i');
  if (!Number.isInteger(inspect.code) || inspect.code === 0 || inspect.reason || inspect.signal
    || (stdout !== '' && stdout !== '[]') || !expected.test(inspect.stderr?.trim() || '')) {
    return { confirmedAbsent: false, inspect };
  }
  // IDs are full length, so the Docker id filter cannot alias a prefix. For a
  // create timeout with no returned ID, use only the exact random owned name.
  const filter = isId ? `id=${target}` : `name=^/${target}$`;
  const ps = await run(['ps', '--all', '--no-trunc', '--filter', filter, '--format', '{{.ID}}']);
  const confirmedAbsent = ps.code === 0 && !ps.reason && !ps.signal && ps.stdout?.trim() === '' && ps.stderr?.trim() === '';
  return { confirmedAbsent, inspect, ps };
}

async function requireAcquisition(dir) {
  const result = await json(`${dir}/acquisition.json`);
  const metadata = await json(`${dir}/registry-metadata.json`);
  if (result.exit_code !== 0 || result.stop_reason || metadata.image !== IMAGE || metadata.architecture !== 'amd64' || metadata.os !== 'linux' || metadata.compressed_layer_bytes !== 808183492) fail('Pinned image acquisition is not qualified');
}

const CATALOG_IDS = ['bme280', 'cap-100nf-0402', 'res-4k7-0402', 'header-1x04'];
export function validateInputCatalog(inputBytes, native, evidence, reviewed) {
  if (evidence.inputSha256 !== sha(inputBytes) || evidence.boardSha256 !== BOARD_HASH || evidence.connectivity?.unrouted !== 4) fail('Known-bad input/evidence binding mismatch');
  const actualIds = Object.keys(native.catalog || {}).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify([...CATALOG_IDS].sort())) fail('Unexpected native catalog IDs');
  for (const id of CATALOG_IDS) {
    const actual = native.catalog[id], expected = reviewed.assets?.[id];
    if (!actual || !expected || actual.footprint?.path !== expected.footprint.path || actual.footprint?.sha256 !== expected.footprint.sha256
      || actual.footprint?.libraryPath !== expected.footprint.libraryPath || actual.footprint?.name !== expected.footprint.name
      || !Array.isArray(actual.models) || actual.models.length !== expected.models.length) fail('Native catalog differs from reviewed assets');
    for (let i = 0; i < actual.models.length; i++) {
      for (const key of ['path', 'sha256', 'sourceReference', 'offsetMm', 'scale', 'rotationDeg']) {
        if (JSON.stringify(actual.models[i]?.[key]) !== JSON.stringify(expected.models[i][key])) fail('Native model differs from reviewed assets');
      }
    }
  }
}
export async function readReviewedAsset(file, expected, io = fs) {
  if (!file.startsWith(ASSETS + '/') || file.includes('/../') || !/^[a-f0-9]{64}$/.test(expected)) fail('Unapproved asset path/hash');
  const st = await io.lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || ![0, process.getuid()].includes(st.uid) || (st.mode & 0o022)
    || st.size <= 0 || st.size > 64 * 1024 ** 2 || await io.realpath(file) !== file) fail('Untrusted reviewed asset');
  const handle = await io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino || opened.size !== st.size || opened.nlink !== 1) fail('Reviewed asset changed');
    const bytes = Buffer.alloc(st.size + 1); let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await io.lstat(file);
    if (length !== st.size || after.isSymbolicLink() || after.dev !== st.dev || after.ino !== st.ino || after.nlink !== 1 || sha(bytes.subarray(0, length)) !== expected) fail('Reviewed source hash mismatch');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

// Stage only the already approved bad board and the four exact catalog assets.
// No repository, home, run-store, native executable, or script is mounted.
export async function stageKnownBad(jobId) {
  const dir = jobPath(jobId); await ownedDirectory(dir); await requireAcquisition(dir);
  const input = path.join(dir, 'input'), assets = path.join(dir, 'assets');
  await regular(`${SOURCE}/native-input.json`);
  const nativeInputBytes = await fs.readFile(`${SOURCE}/native-input.json`);
  const native = JSON.parse(nativeInputBytes);
  const evidence = await json(`${SOURCE}/native-evidence.json`);
  const reviewed = await json(fileURLToPath(new URL('../lib/astra-catalog.json', import.meta.url)));
  validateInputCatalog(nativeInputBytes, native, evidence, reviewed);
  await fs.mkdir(input, { mode: 0o755 }); await fs.mkdir(assets, { mode: 0o755 });
  await fs.mkdir(path.join(dir, 'output'), { mode: 0o777 });
  await fs.chmod(path.join(dir, 'output'), 0o777); // Dedicated writable bind for numeric nonroot UID.
  const sources = { [`${SOURCE}/native-input.json`]: sha(nativeInputBytes) };
  async function copy(source, dest, expected, bundled = false) {
    const bytes = bundled ? await readReviewedAsset(source, expected) : await (async () => { await regular(source); return fs.readFile(source); })();
    if (expected && sha(bytes) !== expected) fail(`Reviewed source hash mismatch: ${source}`);
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o755 });
    await fs.writeFile(dest, bytes, { flag: 'wx', mode: 0o444 });
    sources[source] = sha(bytes);
  }
  await copy(`${SOURCE}/final-board.kicad_pcb`, `${input}/final-board.kicad_pcb`, BOARD_HASH);
  await copy(`${SOURCE}/final-board.kicad_pro`, `${input}/final-board.kicad_pro`);
  const absent = [];
  for (const name of ['final-board.kicad_dru', 'fp-lib-table', 'sym-lib-table']) {
    try { await fs.lstat(`${SOURCE}/${name}`); }
    catch (e) { if (e.code === 'ENOENT') { absent.push(name); continue; } throw e; }
    await copy(`${SOURCE}/${name}`, `${input}/${name}`);
  }
  for (const part of Object.values(native.catalog)) {
    for (const asset of [part.footprint, ...part.models]) {
      if (!asset.path.startsWith(ASSETS + '/') || asset.path.includes('/../')) fail('Unapproved asset path');
      await copy(asset.path, path.join(assets, path.relative(ASSETS, asset.path)), asset.sha256, true);
    }
  }
  const authorization = { schema: 'astra-linux-drc-qualification/v1', jobId, image: IMAGE,
    boardSha256: BOARD_HASH, expectedUnconnected: 4, sources,
    inputHashes: await hashTree(input), assetHashes: await hashTree(assets), absent,
    sourceInputSha256: sha(nativeInputBytes),
    reviewedCatalogSha256: sha(await fs.readFile(fileURLToPath(new URL('../lib/astra-catalog.json', import.meta.url)))),
    libraryResolution: { status: 'unverified', projectFootprintTable: absent.includes('fp-lib-table') ? 'absent' : 'copied', reason: 'Exact assets are staged; library-table resolution in the different engine is not inferred.' },
    schematicParity: { status: 'not-run', reason: 'No corresponding schematic' },
    nativeConnectivity: evidence.connectivity,
    sourceEvidenceSha256: sha(await fs.readFile(`${SOURCE}/native-evidence.json`)),
  };
  await writeJson(path.join(dir, 'authorization.json'), authorization);
  return authorization;
}

export function createArgs(dir, name) {
  const base = path.basename(dir);
  if (!/^astra-linux-(?:drc|job)-[a-z0-9]{8,32}$/.test(base) || path.join(JOB_ROOT, base) !== dir || !/^astra-drc-[a-z0-9]{8,32}-[a-f0-9]{16}$/.test(name)) fail('Invalid fixed-operation container request');
  // Every image, command, mount destination, environment value and resource limit is fixed here.
  return ['create', '--name', name, '--label', 'astra.operation=known-bad-drc-qualification',
    '--pull=never', '--platform', 'linux/amd64', '--network', 'none', '--read-only',
    '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--cpus', '2', '--memory', '2g', '--memory-swap', '2g', '--pids-limit', '128',
    '--ulimit', 'core=0:0', '--ulimit', 'fsize=33554432:33554432',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=134217728,mode=1777',
    '--shm-size', '16m', '--log-driver', 'none',
    '--mount', `type=bind,source=${dir}/input,target=/input,readonly`,
    '--mount', `type=bind,source=${dir}/assets,target=${ASSETS},readonly`,
    '--mount', `type=bind,source=${dir}/output,target=/output`,
    '--workdir', '/input', '--env', 'HOME=/tmp/home', '--env', 'XDG_CONFIG_HOME=/tmp/home/.config',
    '--env', 'XDG_CACHE_HOME=/tmp/home/.cache', '--env', 'KICAD10_3DMODEL_DIR=' + ASSETS + '/3dmodels',
    '--env', 'KICAD10_FOOTPRINT_DIR=' + ASSETS + '/footprints',
    '--entrypoint', '/bin/sh', IMAGE, '-c',
    'set -eu; mkdir -p /tmp/home/.config /tmp/home/.cache; id; uname -m; command -v kicad-cli; sha256sum "$(command -v kicad-cli)"; kicad-cli --version; exec kicad-cli pcb drc --format json --units mm --severity-all --output /output/drc.json /input/final-board.kicad_pcb'];
}

async function validateAuthorization(jobId) {
  const dir = jobPath(jobId); await ownedDirectory(dir); await requireAcquisition(dir);
  await ownedDirectory(`${dir}/input`); await ownedDirectory(`${dir}/assets`);
  const auth = await json(`${dir}/authorization.json`);
  if (auth.schema !== 'astra-linux-drc-qualification/v1' || auth.jobId !== jobId || auth.image !== IMAGE || auth.boardSha256 !== BOARD_HASH || auth.expectedUnconnected !== 4) fail('Invalid launch-owned authorization');
  assertHashes(await hashTree(`${dir}/input`), auth.inputHashes);
  assertHashes(await hashTree(`${dir}/assets`), auth.assetHashes);
  if (auth.inputHashes['final-board.kicad_pcb'] !== BOARD_HASH) fail('Not the approved known-bad board');
  const outputStat = await fs.lstat(`${dir}/output`);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink() || outputStat.uid !== process.getuid() || await fs.realpath(`${dir}/output`) !== `${dir}/output`) fail('Unowned output directory');
  if ((await fs.readdir(`${dir}/output`)).length) fail('Output already populated; never retry automatically');
  return { dir, auth };
}

export async function runQualification(jobId, { signal } = {}) {
  const { dir, auth } = await validateAuthorization(jobId);
  // Atomic launch marker: this job cannot be started twice or retried after failure.
  await writeJson(`${dir}/runtime-start.json`, { jobId, startedAt: new Date().toISOString() });
  const receipt = { schema: 'astra-linux-drc-runtime/v1', jobId, image: IMAGE, startedAt: new Date().toISOString(),
    controllerSha256: sha(await fs.readFile(fileURLToPath(import.meta.url))),
    authorizationSha256: sha(await fs.readFile(`${dir}/authorization.json`)),
    schematicParity: auth.schematicParity, libraryResolution: auth.libraryResolution,
    sourceInputSha256: auth.sourceInputSha256, reviewedCatalogSha256: auth.reviewedCatalogSha256,
    nativeConnectivity: auth.nativeConnectivity, boardSha256: BOARD_HASH };
  const name = `astra-drc-${jobId.slice('astra-linux-drc-'.length)}-${crypto.randomBytes(8).toString('hex')}`;
  let id, created = false, monitor, monitorBusy = false, started = false;
  const aborter = new AbortController();
  const abort = () => aborter.abort(signal?.reason || 'cancelled');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const engine = JSON.parse(await checked(['info', '--format', '{{json .}}']));
    if (engine.Name !== 'docker-desktop' || engine.OSType !== 'linux' || engine.Architecture !== 'aarch64') fail('Unexpected local Docker engine');
    receipt.engine = Object.fromEntries(['ID', 'Name', 'ServerVersion', 'OSType', 'Architecture', 'DockerRootDir'].map(k => [k, engine[k]]));
    const image = JSON.parse(await checked(['image', 'inspect', IMAGE]))[0];
    if (image.Architecture !== 'amd64' || image.Os !== 'linux' || !image.RepoDigests.includes(IMAGE) || image.Config.Entrypoint?.length) fail('Pinned image metadata mismatch');
    receipt.imageInspection = { id: image.Id, architecture: image.Architecture, os: image.Os, size: image.Size, entrypoint: image.Config.Entrypoint, cmd: image.Config.Cmd };
    const vm = await fs.realpath('/Users/jackal-kahwati/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw');
    if (!vm.startsWith('/Volumes/T9 Backup/')) fail('Unqualified Docker VM storage location');
    const baseline = (await fs.stat(vm)).blocks * 512;
    receipt.storage = { vm, baselineAllocatedBytes: baseline, samples: [] };
    async function sample() {
      const free = {};
      for (const p of ['/', vm, dir]) { const s = await fs.statfs(p); free[p] = s.bavail * s.bsize; }
      const allocated = (await fs.stat(vm)).blocks * 512;
      let outputBytes = 0;
      for (const entry of await fs.readdir(`${dir}/output`, { withFileTypes: true })) {
        if (!entry.isFile()) fail('Unexpected output entry');
        outputBytes += (await fs.lstat(`${dir}/output/${entry.name}`)).size;
      }
      receipt.storage.samples.push({ at: new Date().toISOString(), free, allocated, outputBytes });
      if (Math.min(...Object.values(free)) < 2 * GiB || allocated - baseline >= 4 * GiB || outputBytes > 64 * 1024 ** 2) fail('Runtime storage bound reached');
    }
    await sample();
    if (aborter.signal.aborted) fail('Cancelled before container creation');
    const args = createArgs(dir, name); receipt.createArgs = args;
    created = true; // A timed-out client may still have created the uniquely named container.
    id = (await checked(args)).trim();
    if (!/^[a-f0-9]{64}$/.test(id)) fail('Missing owned container ID');
    const inspect = JSON.parse(await checked(['inspect', id]))[0];
    receipt.container = { id, hostConfig: inspect.HostConfig, mounts: inspect.Mounts,
      user: inspect.Config.User, image: inspect.Image, command: inspect.Config.Cmd };
    if (inspect.Config.Labels['astra.operation'] !== 'known-bad-drc-qualification' || inspect.Name !== '/' + name || inspect.Image !== image.Id) fail('Container identity mismatch');
    monitor = setInterval(async () => {
      if (monitorBusy) return; monitorBusy = true;
      try { await sample(); } catch (e) { receipt.storageFailure = e.message; aborter.abort(e); }
      finally { monitorBusy = false; }
    }, 250);
    started = true;
    receipt.process = await command(['start', '--attach', id], { timeoutMs: 120000, signal: aborter.signal });
    clearInterval(monitor);
    receipt.finalState = JSON.parse(await checked(['inspect', id]))[0].State;
    await fs.writeFile(`${dir}/stdout.log`, receipt.process.stdout, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(`${dir}/stderr.log`, receipt.process.stderr, { flag: 'wx', mode: 0o600 });
    delete receipt.process.stdout; delete receipt.process.stderr;
    if (receipt.process.reason || receipt.process.code !== 0 || receipt.finalState.Running || receipt.finalState.OOMKilled || receipt.finalState.ExitCode !== 0 || aborter.signal.aborted) fail('Native CLI did not exit normally');
    const bytes = await readQualificationReport(dir); receipt.reportSha256 = sha(bytes);
    const report = JSON.parse(bytes);
    const parsed = parseAstraDrcReport(report, { engineVersion: '10.0.5', source: 'final-board.kicad_pcb', schematicParity: 'not-run' });
    receipt.executionComplete = true;
    receipt.findings = { violations: parsed.rawCounts.violations.total, unconnected: parsed.unrouted,
      includedSeverities: parsed.includedSeverities, ignoredChecks: parsed.ignoredChecks,
      excludedCounts: parsed.excludedCounts, rawCounts: parsed.rawCounts, checksComplete: parsed.checksComplete,
      provenance: parsed.provenance };
    receipt.boardPassed = false;
    validateKnownBadReport(report);
    receipt.runtimeQualified = true;
  } catch (e) {
    receipt.runtimeQualified = false; receipt.failure = e.message;
  } finally {
    clearInterval(monitor); signal?.removeEventListener('abort', abort);
    if (created) {
      // Never kill just the client: resolve and remove only this operation's exact owned container.
      try {
        const found = await command(['inspect', id || name]);
        if (found.code === 0) {
          const c = JSON.parse(found.stdout)[0];
          if (c.Config.Labels['astra.operation'] !== 'known-bad-drc-qualification' || c.Name !== '/' + name || (id && c.Id !== id)) fail('Cleanup ownership mismatch');
          id = c.Id;
          receipt.cleanup = await command(['rm', '--force', id]);
          const check = await command(['inspect', id]);
          receipt.cleanup.absence = await confirmOwnedContainerAbsent(id, check);
          receipt.cleanup.confirmedAbsent = receipt.cleanup.absence.confirmedAbsent;
          if (receipt.cleanup.code !== 0 || !receipt.cleanup.confirmedAbsent) fail('Owned container cleanup not confirmed');
        } else {
          const absence = await confirmOwnedContainerAbsent(id || name, found);
          receipt.cleanup = { alreadyAbsent: true, confirmedAbsent: absence.confirmedAbsent, absence };
          if (!absence.confirmedAbsent) fail('Cannot determine owned container state');
        }
      } catch (e) { receipt.cleanupFailure = e.message; receipt.runtimeQualified = false; }
    }
    try {
      assertHashes(await hashTree(`${dir}/input`), auth.inputHashes);
      assertHashes(await hashTree(`${dir}/assets`), auth.assetHashes);
      for (const [source, expected] of Object.entries(auth.sources)) {
        if (source.startsWith(ASSETS + '/')) await readReviewedAsset(source, expected);
        else { await regular(source); if (sha(await fs.readFile(source)) !== expected) fail('Original input changed'); }
      }
      receipt.inputsUnchanged = true;
    } catch (e) { receipt.inputsUnchanged = false; receipt.runtimeQualified = false; receipt.integrityFailure = e.message; }
    receipt.finishedAt = new Date().toISOString(); receipt.started = started;
    await writeJson(`${dir}/runtime-receipt.json`, receipt);
  }
  return receipt;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [operation, jobId, ...extra] = process.argv.slice(2);
  if (!['stage-known-bad', 'qualify-known-bad'].includes(operation) || !jobId || extra.length) throw new Error('Usage: astra-linux-drc.mjs stage-known-bad|qualify-known-bad <authorized-job-id>');
  const aborter = new AbortController();
  process.once('SIGINT', () => aborter.abort('SIGINT')); process.once('SIGTERM', () => aborter.abort('SIGTERM'));
  if (operation === 'stage-known-bad') { await stageKnownBad(jobId); console.log('Known-bad inputs staged and hashed'); }
  else {
    const receipt = await runQualification(jobId, { signal: aborter.signal });
    console.log(JSON.stringify({ runtimeQualified: receipt.runtimeQualified, boardPassed: receipt.boardPassed,
      failure: receipt.failure, findings: receipt.findings, inputsUnchanged: receipt.inputsUnchanged,
      receiptPath: `${jobPath(jobId)}/runtime-receipt.json` }, null, 2));
    if (!receipt.runtimeQualified) process.exitCode = 1;
  }
}
