// Fixed launch-owned DRC execution only. Not an HTTP handler or Docker gateway.
// Node >=22.18 is required for the shared TypeScript evidence parser.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseAstraDrcReport } from '../lib/astra-drc.ts';
import { IMAGE, JOB_ROOT, createArgs, assertHashes, readQualificationReport, confirmOwnedContainerAbsent, runAstraDrcDockerCommand } from './astra-linux-drc.mjs';

const ASSETS = '/Applications/KiCad/KiCad.app/Contents/SharedSupport';
const VM = '/Users/jackal-kahwati/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw';
const LABEL = 'known-bad-drc-qualification'; // Same fixed sandbox profile; receipt distinguishes operation.
const capabilities = new WeakMap();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const canonical = x => JSON.stringify(x, function (_key, value) { return object(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value; });
const fail = message => { throw new Error(message); };
const POLICY = { schematicParity: 'not-run', includedSeverities: ['error', 'warning', 'exclusion'], ignoredChecksAllowed: false, excludedAllowed: false };
function jobPath(id) {
  if (typeof id !== 'string' || !/^astra-linux-job-[a-z0-9]{8,32}$/.test(id)) fail('Invalid launch-owned DRC job ID');
  return path.join(JOB_ROOT, id);
}
async function directory(dir, output = false) {
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (!output && (st.mode & 0o022)) || await fs.realpath(dir) !== dir) fail('Unowned or linked launch directory');
  return { dev: st.dev, ino: st.ino };
}
async function bytes(file, limit, privateFile = false) {
  if (await fs.realpath(file) !== file) fail('Linked launch file');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() || st.size <= 0 || st.size > limit || (st.mode & (privateFile ? 0o077 : 0o022))) fail('Invalid launch file ownership/size/mode');
    const result = Buffer.alloc(st.size + 1); let length = 0;
    while (length < result.length) { const read = await handle.read(result, length, result.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat(), current = await fs.lstat(file);
    if (length !== st.size || current.isSymbolicLink() || current.dev !== st.dev || current.ino !== st.ino || current.nlink !== 1 || after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) fail('Launch file changed during read');
    return result.subarray(0, length);
  } finally { await handle.close(); }
}
async function tree(dir, depth = 0) {
  if (depth > 5) fail('Staged input depth exceeded');
  await directory(dir);
  if (((await fs.lstat(dir)).mode & 0o7777) !== 0o755) fail('Container input directories must have exact mode 0755');
  const entries = await fs.readdir(dir, { withFileTypes: true });
  if (entries.length > 32) fail('Staged input entry bound exceeded');
  const result = {};
  for (const entry of entries) {
    if (entry.isDirectory()) { const sub = await tree(path.join(dir, entry.name), depth + 1); for (const [name, hash] of Object.entries(sub)) result[`${entry.name}/${name}`] = hash; }
    else {
      const file = path.join(dir, entry.name);
      if (((await fs.lstat(file)).mode & 0o7777) !== 0o444) fail('Container input files must have exact mode 0444');
      result[entry.name] = sha(await bytes(file, 64 * 1024 ** 2));
    }
  }
  return result;
}
export function expectedFootprintTable(catalog) {
  const libraries = [...new Set(Object.values(catalog.assets).map(asset => asset.footprint.libraryPath))].sort();
  if (libraries.length !== 4 || libraries.some(p => !p.startsWith(ASSETS + '/footprints/') || !/^[A-Za-z0-9_.]+\.pretty$/.test(path.basename(p)))) fail('Unreviewed library table paths');
  return '(fp_lib_table\n  (version 7)\n' + libraries.map(p => `  (lib (name ${JSON.stringify(path.basename(p, '.pretty'))})(type KiCad)(uri ${JSON.stringify(p)})(options "")(descr ""))\n`).join('') + ')\n';
}
// Defensive launch-controller mirror; parity tests bind it to the server validator.
export function validateProjectPolicy(value) {
  const settings = value?.board?.design_settings;
  const required = ['missing_courtyard', 'track_not_centered_on_via', 'tuning_profile_track_geometries', 'footprint_filters_mismatch', 'footprint_type_mismatch'];
  if (!object(settings) || !object(settings.rule_severities) || !object(settings.rules) || !Array.isArray(settings.drc_exclusions) || settings.drc_exclusions.length || settings.rules.min_resolved_spokes !== 2
    || required.some(key => settings.rule_severities[key] !== 'error') || Object.values(settings.rule_severities).some(value => value !== 'error' && value !== 'warning')) fail('Incomplete or weakened native project policy');
  for (const [key, expected] of Object.entries({ min_clearance: 0.15, min_track_width: 0.15, min_via_diameter: 0.6, min_through_hole_diameter: 0.3, min_via_annular_width: 0.15, min_hole_clearance: 0.25, min_hole_to_hole: 0.25, min_copper_edge_clearance: 0.5 })) {
    if (settings.rules[key] !== expected) fail('Incomplete or weakened native project policy');
  }
}
function groundEvidence(value, catalog) {
  const pins = catalog.contract?.canonicalNets?.find(net => net.name === 'GND')?.pins;
  if (!Array.isArray(pins) || pins.length !== 6 || pins.some(pin => typeof pin !== 'string') || new Set(pins).size !== 6 || !pins.includes('J1.2')) fail('Reviewed catalog ground contract unavailable');
  const GROUND = [...pins].sort();
  if (!object(value) || value.available !== true || value.anchor !== 'J1.2' || value.method !== 'native-effective-shape-polygon-components-v1' || !Array.isArray(value.reachedPads) || !Array.isArray(value.unreachedPads) || !Array.isArray(value.padComponents)) fail('Missing measured native ground evidence');
  const flat = value.padComponents.flat();
  if (value.padComponents.some(group => !Array.isArray(group) || !group.length) || flat.length !== 6 || new Set(flat).size !== 6 || canonical([...flat].sort()) !== canonical(GROUND)) fail('Invalid six-pad ground partition');
  const anchor = value.padComponents.find(group => group.includes('J1.2'));
  if (canonical([...value.reachedPads].sort()) !== canonical([...anchor].sort()) || canonical([...value.unreachedPads].sort()) !== canonical(GROUND.filter(pin => !anchor.includes(pin)))) fail('Ground reachability does not match anchor partition');
  return value.unreachedPads.length === 0;
}
async function inspectStaged(id) {
  const dir = jobPath(id);
  await directory(JOB_ROOT); const identity = await directory(dir);
  const authBytes = await bytes(`${dir}/authorization.json`, 256 * 1024, true), auth = JSON.parse(authBytes);
  const required = ['schema', 'jobId', 'image', 'boardSha256', 'nativeInputSha256', 'nativeEvidenceSha256', 'catalogSha256', 'inputHashes', 'assetHashes', 'policy'];
  if (!object(auth) || required.some(key => !Object.hasOwn(auth, key)) || Object.keys(auth).some(key => !required.includes(key)) || auth.schema !== 'astra-linux-job/v1' || auth.jobId !== id || auth.image !== IMAGE || canonical(auth.policy) !== canonical(POLICY)) fail('Invalid fixed launch authorization');
  for (const key of ['boardSha256', 'nativeInputSha256', 'nativeEvidenceSha256', 'catalogSha256']) if (!digest(auth[key])) fail('Invalid authorization digest');
  const catalogBytes = await bytes(fileURLToPath(new URL('../lib/astra-catalog.json', import.meta.url)), 1024 * 1024);
  if (sha(catalogBytes) !== auth.catalogSha256) fail('Reviewed catalog changed');
  const catalog = JSON.parse(catalogBytes);
  const nativeBytes = await bytes(`${dir}/native-input.json`, 1024 * 1024), evidenceBytes = await bytes(`${dir}/native-evidence.json`, 2 * 1024 * 1024);
  if (sha(nativeBytes) !== auth.nativeInputSha256 || sha(evidenceBytes) !== auth.nativeEvidenceSha256) fail('Native evidence hashes changed');
  const native = JSON.parse(nativeBytes), evidence = JSON.parse(evidenceBytes);
  if (canonical(native.catalog) !== canonical(catalog.assets) || evidence.version !== 1 || evidence.stage !== 'finished' || evidence.routeAttempts !== 1 || evidence.identityPreserved !== true || evidence.inputSha256 !== auth.nativeInputSha256 || evidence.boardSha256 !== auth.boardSha256) fail('Native identity/catalog binding failed');
  if (!object(evidence.connectivity) || evidence.connectivity.available !== true || !Number.isSafeInteger(evidence.connectivity.unrouted) || evidence.connectivity.unrouted < 0) fail('Native connectivity is unavailable');
  const groundPassed = groundEvidence(evidence.groundConnectivity, catalog);
  const inputHashes = await tree(`${dir}/input`), assetHashes = await tree(`${dir}/assets`);
  if (!object(auth.inputHashes) || !object(auth.assetHashes)) fail('Missing exact staged hash tables');
  assertHashes(inputHashes, auth.inputHashes); assertHashes(assetHashes, auth.assetHashes);
  const allowedInputs = ['final-board.kicad_pcb', 'final-board.kicad_pro', 'fp-lib-table', 'final-board.kicad_dru'];
  if (allowedInputs.slice(0, 3).some(name => !Object.hasOwn(inputHashes, name)) || Object.keys(inputHashes).some(name => !allowedInputs.includes(name)) || inputHashes['final-board.kicad_pcb'] !== auth.boardSha256) fail('Unexpected/missing staged board/project/table inputs');
  if (evidence.projectSha256 !== inputHashes['final-board.kicad_pro']) fail('Native project hash does not match DRC settings');
  validateProjectPolicy(JSON.parse(await bytes(`${dir}/input/final-board.kicad_pro`, 1024 * 1024)));
  if (evidence.tableSha256 !== inputHashes['fp-lib-table']) fail('Native table hash does not match staged table');
  if ((await bytes(`${dir}/input/fp-lib-table`, 64 * 1024)).toString('utf8') !== expectedFootprintTable(catalog)) fail('Footprint library table is not the exact reviewed mapping');
  const expectedAssets = {};
  for (const asset of Object.values(catalog.assets)) for (const file of [asset.footprint, ...asset.models]) {
    if (!file.path.startsWith(ASSETS + '/') || file.path.includes('/../') || !digest(file.sha256)) fail('Unreviewed asset mapping');
    expectedAssets[path.relative(ASSETS, file.path)] = file.sha256;
  }
  assertHashes(assetHashes, expectedAssets);
  await directory(`${dir}/output`, true);
  if (((await fs.lstat(`${dir}/output`)).mode & 0o7777) !== 0o777) fail('Container output directory must have exact mode 0777');
  if ((await fs.readdir(`${dir}/output`)).length) fail('Output populated; job is never resumed');
  return { id, dir, identity, auth, authHash: sha(authBytes), evidence, groundPassed };
}
export async function authorizeStagedDrcJob(jobId) {
  const state = await inspectStaged(jobId);
  const capability = Object.freeze({}); capabilities.set(capability, state); return capability;
}
async function checked(args) {
  const result = await runAstraDrcDockerCommand(args);
  if (result.code !== 0 || result.reason || result.signal) fail(`Docker operation failed: ${args[0]}`);
  return result.stdout;
}
async function persist(file, value) { await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }

export async function runValidatedDrcJob({ capability, signal }) {
  const saved = capabilities.get(capability);
  if (!saved) fail('Missing or consumed launch-owned capability');
  capabilities.delete(capability);
  const state = await inspectStaged(saved.id);
  if (state.authHash !== saved.authHash || canonical(state.identity) !== canonical(saved.identity)) fail('Authorization changed after capability issuance');
  const { dir, auth, evidence } = state;
  await persist(`${dir}/runtime-start.json`, { jobId: state.id, startedAt: new Date().toISOString() });
  const receipt = { schema: 'astra-linux-job-runtime/v1', jobId: state.id, image: IMAGE, startedAt: new Date().toISOString(),
    authorizationSha256: state.authHash, controllerSha256: sha(await fs.readFile(fileURLToPath(import.meta.url))),
    boardSha256: auth.boardSha256, nativeInputSha256: auth.nativeInputSha256, nativeEvidenceSha256: auth.nativeEvidenceSha256,
    catalogSha256: auth.catalogSha256, schematicParity: 'not-run', nativeConnectivity: evidence.connectivity,
    groundConnectivity: evidence.groundConnectivity, executionComplete: false, checksComplete: false, boardPassed: false };
  const name = `astra-drc-${state.id.slice('astra-linux-job-'.length)}-${crypto.randomBytes(8).toString('hex')}`;
  const aborter = new AbortController(); const abort = () => aborter.abort(signal?.reason || 'cancelled');
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  let id, created = false, monitor, sampling = Promise.resolve();
  try {
    if (aborter.signal.aborted) fail('Cancelled before execution');
    const engine = JSON.parse(await checked(['info', '--format', '{{json .}}']));
    if (engine.Name !== 'docker-desktop' || engine.OSType !== 'linux' || engine.Architecture !== 'aarch64') fail('Unexpected local Docker engine');
    receipt.engine = { ID: engine.ID, Name: engine.Name, ServerVersion: engine.ServerVersion, OSType: engine.OSType, Architecture: engine.Architecture };
    const image = JSON.parse(await checked(['image', 'inspect', IMAGE]))[0];
    if (image.Architecture !== 'amd64' || image.Os !== 'linux' || !image.RepoDigests?.includes(IMAGE) || image.Config.Entrypoint?.length || !/^sha256:[a-f0-9]{64}$/.test(image.Id)) fail('Pinned image identity mismatch');
    receipt.imageId = image.Id;
    const vm = await fs.realpath(VM); if (!vm.startsWith('/Volumes/T9 Backup/')) fail('Docker storage is not on approved external volume');
    const baseline = (await fs.stat(vm)).blocks * 512; receipt.storage = { vm, baselineAllocatedBytes: baseline, samples: [] };
    const sample = async () => {
      const free = {};
      for (const p of ['/', vm, dir]) { const st = await fs.statfs(p); free[p] = st.bavail * st.bsize; }
      const allocated = (await fs.stat(vm)).blocks * 512; let outputBytes = 0;
      for (const entry of await fs.readdir(`${dir}/output`, { withFileTypes: true })) {
        if (!entry.isFile()) fail('Unexpected native output entry');
        const st = await fs.lstat(`${dir}/output/${entry.name}`); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail('Linked native output'); outputBytes += st.size;
      }
      receipt.storage.samples.push({ at: new Date().toISOString(), free, allocated, outputBytes });
      if (Math.min(...Object.values(free)) < 2 * 1024 ** 3 || allocated - baseline >= 4 * 1024 ** 3 || outputBytes > 64 * 1024 ** 2) fail('Runtime storage bound reached');
    };
    await sample(); if (aborter.signal.aborted) fail('Cancelled before container creation');
    const args = createArgs(dir, name); receipt.createArgs = args; created = true;
    id = (await checked(args)).trim(); if (!/^[a-f0-9]{64}$/.test(id)) fail('Missing owned container ID');
    const inspect = JSON.parse(await checked(['inspect', id]))[0];
    if (inspect.Config.Labels?.['astra.operation'] !== LABEL || inspect.Name !== '/' + name || inspect.Image !== image.Id) fail('Container identity mismatch');
    receipt.container = { id, image: inspect.Image, hostConfig: inspect.HostConfig, mounts: inspect.Mounts };
    if (aborter.signal.aborted) fail('Cancelled before container start');
    let busy = false;
    monitor = setInterval(() => { if (busy) return; busy = true; sampling = sample().catch(error => { receipt.storageFailure = error.message; aborter.abort(error); }).finally(() => { busy = false; }); }, 250);
    receipt.process = await runAstraDrcDockerCommand(['start', '--attach', id], { timeoutMs: 120000, signal: aborter.signal });
    clearInterval(monitor); await sampling;
    receipt.finalState = JSON.parse(await checked(['inspect', id]))[0].State;
    await fs.writeFile(`${dir}/stdout.log`, receipt.process.stdout, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(`${dir}/stderr.log`, receipt.process.stderr, { flag: 'wx', mode: 0o600 });
    delete receipt.process.stdout; delete receipt.process.stderr;
    if (receipt.process.reason || receipt.process.signal || receipt.process.code !== 0 || receipt.finalState.Running || receipt.finalState.OOMKilled || receipt.finalState.ExitCode !== 0 || aborter.signal.aborted) fail('Native CLI did not exit normally');
    const reportBytes = await readQualificationReport(dir); receipt.reportSha256 = sha(reportBytes);
    const parsed = parseAstraDrcReport(JSON.parse(reportBytes), { engineVersion: '10.0.5', source: 'final-board.kicad_pcb', schematicParity: 'not-run' });
    receipt.executionComplete = true; receipt.findings = parsed; receipt.checksComplete = parsed.checksComplete;
    receipt.boardPassed = parsed.passed && evidence.connectivity.unrouted === 0 && state.groundPassed;
  } catch (error) { receipt.failure = error.message; receipt.boardPassed = false; }
  finally {
    clearInterval(monitor); await sampling; signal?.removeEventListener('abort', abort);
    if (created) {
      try {
        const found = await runAstraDrcDockerCommand(['inspect', id || name]);
        if (found.code === 0) {
          const container = JSON.parse(found.stdout)[0];
          if (container.Config.Labels?.['astra.operation'] !== LABEL || container.Name !== '/' + name || (id && container.Id !== id)) fail('Cleanup ownership mismatch');
          id = container.Id;
          receipt.cleanup = await runAstraDrcDockerCommand(['rm', '--force', id]);
          receipt.cleanup.absence = await confirmOwnedContainerAbsent(id, await runAstraDrcDockerCommand(['inspect', id]));
          receipt.cleanup.confirmedAbsent = receipt.cleanup.code === 0 && receipt.cleanup.absence.confirmedAbsent;
          if (!receipt.cleanup.confirmedAbsent) fail('Owned cleanup not confirmed');
        } else {
          const absence = await confirmOwnedContainerAbsent(id || name, found);
          receipt.cleanup = { confirmedAbsent: absence.confirmedAbsent, absence };
          if (!absence.confirmedAbsent) fail('Owned container state unknown');
        }
      } catch (error) { receipt.cleanupFailure = error.message; receipt.boardPassed = false; }
    }
    try {
      if (canonical(await directory(dir)) !== canonical(state.identity)) fail('Launch directory changed during execution');
      assertHashes(await tree(`${dir}/input`), auth.inputHashes); assertHashes(await tree(`${dir}/assets`), auth.assetHashes);
      if (sha(await bytes(`${dir}/authorization.json`, 256 * 1024, true)) !== state.authHash || sha(await bytes(`${dir}/native-input.json`, 1024 * 1024)) !== auth.nativeInputSha256 || sha(await bytes(`${dir}/native-evidence.json`, 2 * 1024 * 1024)) !== auth.nativeEvidenceSha256
        || sha(await bytes(fileURLToPath(new URL('../lib/astra-catalog.json', import.meta.url)), 1024 * 1024)) !== auth.catalogSha256) fail('Metadata changed during execution');
      receipt.inputsUnchanged = true;
    } catch (error) { receipt.inputsUnchanged = false; receipt.integrityFailure = error.message; receipt.boardPassed = false; }
    if (aborter.signal.aborted) { receipt.cancelled = true; receipt.boardPassed = false; }
    receipt.finishedAt = new Date().toISOString(); await persist(`${dir}/runtime-receipt.json`, receipt);
  }
  return receipt;
}
