// Offline launch-owned staging only. Never an HTTP handler, request-path adapter,
// native builder, or Docker operation. Sources are direct qualification jobs or
// jobs beneath one opaque, launch-initialized app HOME scope.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { IMAGE, JOB_ROOT, readReviewedAsset } from './astra-linux-drc.mjs';
import { authorizeStagedDrcJob, expectedFootprintTable, validateProjectPolicy } from './astra-linux-runtime.mjs';

const ASSETS = '/Applications/KiCad/KiCad.app/Contents/SharedSupport';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const canonical = value => JSON.stringify(value, function (_key, item) { return object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item; });
async function ownedDirectory(dir) {
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o022) || await fs.realpath(dir) !== dir) fail('Source is not a canonical owned directory');
  return { dev: st.dev, ino: st.ino };
}
async function readSource(file, limit) {
  if (await fs.realpath(file) !== file) fail('Source links are not permitted');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o022) || stat.size <= 0 || stat.size > limit) fail('Source is not an owned bounded regular file');
    const result = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < result.length) { const read = await handle.read(result, length, result.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    const current = await fs.lstat(file), after = await handle.stat();
    if (length !== stat.size || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail('Source changed during staging read');
    return result.subarray(0, length);
  } finally { await handle.close(); }
}
async function mkdir(dir, mode) {
  await fs.mkdir(dir, { mode });
  await fs.chmod(dir, mode); // Only directories exclusively created by this invocation.
}
async function write(file, value, mode) { await fs.writeFile(file, value, { flag: 'wx', mode }); await fs.chmod(file, mode); }
function ground(value, catalog) {
  const pins = catalog.contract?.canonicalNets?.find(net => net.name === 'GND')?.pins;
  if (!Array.isArray(pins) || pins.length !== 6 || new Set(pins).size !== 6 || !pins.includes('J1.2')) fail('Reviewed ground contract unavailable');
  if (!object(value) || value.available !== true || value.anchor !== 'J1.2' || value.method !== 'native-effective-shape-polygon-components-v1' || !Array.isArray(value.reachedPads) || !Array.isArray(value.unreachedPads) || !Array.isArray(value.padComponents) || value.padComponents.some(group => !Array.isArray(group) || !group.length)) fail('Native ground measurements are missing');
  const flat = value.padComponents.flat();
  if (flat.length !== 6 || new Set(flat).size !== 6 || canonical([...flat].sort()) !== canonical([...pins].sort())) fail('Native ground partition differs from catalog');
  const anchor = value.padComponents.find(group => group.includes('J1.2'));
  if (canonical([...value.reachedPads].sort()) !== canonical([...anchor].sort()) || canonical([...value.unreachedPads].sort()) !== canonical(pins.filter(pin => !anchor.includes(pin)).sort())) fail('Native ground anchor evidence is inconsistent');
}

const appScopes = new WeakMap();
async function inspectAppScope(launchRoot) {
  if (typeof launchRoot !== 'string' || path.dirname(launchRoot) !== JOB_ROOT || !/^astra-app-owned-[A-Za-z0-9]{6}$/.test(path.basename(launchRoot))) fail('Invalid launcher scope root');
  const app = path.join(launchRoot, 'app-source'), home = path.join(app, '.astra-home'), nativeRoot = path.join(home, 'native-jobs');
  const identities = [];
  await ownedDirectory(JOB_ROOT);
  for (const dir of [launchRoot, app, home, nativeRoot]) {
    identities.push(await ownedDirectory(dir));
    if ((await fs.lstat(dir)).mode & 0o077) fail('App scope directories must be private');
  }
  const marker = await readSource(path.join(app, '.astra-workspace.json'), 4096);
  if ((await fs.lstat(path.join(app, '.astra-workspace.json'))).mode & 0o077) fail('App scope marker must be private');
  if (canonical(JSON.parse(marker)) !== canonical({ version: 1, root: app, purpose: 'isolated-astra-beta' })) fail('Invalid isolated app scope marker');
  return { launchRoot, nativeRoot, identities, markerSha256: sha(marker) };
}
// Initialization is a trusted launcher action, never a root/environment selected
// by a web request. Opaque scope identity is required on every app staging call.
export async function createAppNativeValidationScope(launchRoot) {
  const state = await inspectAppScope(launchRoot);
  const scope = Object.freeze({}); appScopes.set(scope, state); return scope;
}
export async function stageAppNativeValidation(scope, sourceJobId, expectedBoardSha256) {
  const saved = appScopes.get(scope);
  if (!saved) fail('Missing launcher app scope');
  if (typeof sourceJobId !== 'string' || !/^job-[A-Za-z0-9]{6}$/.test(sourceJobId)) fail('Invalid app native job ID');
  const verifyScope = async () => { if (canonical(await inspectAppScope(saved.launchRoot)) !== canonical(saved)) fail('App native scope changed'); };
  await verifyScope();
  return stageSourceValidation(saved.nativeRoot, sourceJobId, expectedBoardSha256, verifyScope);
}
export async function stageNativeValidation(sourceJobId, expectedBoardSha256) {
  if (typeof sourceJobId !== 'string' || !/^(?:astra-corridor|astra-native-test|astra-reserved-prepare)-[A-Za-z0-9]{6,64}$/.test(sourceJobId)) fail('Invalid fixed-root native source ID');
  return stageSourceValidation(JOB_ROOT, sourceJobId, expectedBoardSha256);
}
async function stageSourceValidation(sourceRoot, sourceJobId, expectedBoardSha256, verifyScope = async () => {}) {
  if (typeof expectedBoardSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedBoardSha256)) fail('An explicit native board SHA-256 is required');
  await ownedDirectory(JOB_ROOT);
  async function reserve(required = 0) {
    for (const mount of ['/', JOB_ROOT]) {
      const stat = await fs.statfs(mount);
      if (stat.bavail * stat.bsize < 2 * 1024 ** 3 + required) fail('Staging storage reserve is unavailable');
    }
  }
  await reserve();
  const source = path.join(sourceRoot, sourceJobId), identity = await ownedDirectory(source);
  if (sourceRoot !== JOB_ROOT && ((await fs.lstat(source)).mode & 0o077)) fail('App native job must be private');
  const data = {};
  const limits = { 'native-input.json': 1024 * 1024, 'native-evidence.json': 2 * 1024 * 1024, 'final-board.kicad_pcb': 16 * 1024 * 1024, 'final-board.kicad_pro': 1024 * 1024, 'fp-lib-table': 64 * 1024 };
  for (const [name, limit] of Object.entries(limits)) data[name] = await readSource(path.join(source, name), limit);
  try { data['final-board.kicad_dru'] = await readSource(path.join(source, 'final-board.kicad_dru'), 256 * 1024); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const catalogPath = fileURLToPath(new URL('../lib/astra-catalog.json', import.meta.url));
  const catalogBytes = await readSource(catalogPath, 1024 * 1024), catalog = JSON.parse(catalogBytes);
  const input = JSON.parse(data['native-input.json']), evidence = JSON.parse(data['native-evidence.json']);
  if (sha(data['final-board.kicad_pcb']) !== expectedBoardSha256 || evidence.boardSha256 !== expectedBoardSha256 || evidence.inputSha256 !== sha(data['native-input.json']) || evidence.projectSha256 !== sha(data['final-board.kicad_pro']) || evidence.tableSha256 !== sha(data['fp-lib-table']) || evidence.version !== 1 || evidence.stage !== 'finished' || evidence.routeAttempts !== 1 || evidence.identityPreserved !== true) fail('Native artifact identity hashes do not agree');
  if (canonical(input.catalog) !== canonical(catalog.assets) || Object.keys(catalog.assets).length !== 4) fail('Native catalog is not the reviewed four-part catalog');
  validateProjectPolicy(JSON.parse(data['final-board.kicad_pro']));
  if (data['fp-lib-table'].toString('utf8') !== expectedFootprintTable(catalog)) fail('Native library table differs from exact reviewed mapping');
  if (!object(evidence.connectivity) || evidence.connectivity.available !== true || !Number.isSafeInteger(evidence.connectivity.unrouted) || evidence.connectivity.unrouted < 0) fail('Native connectivity evidence is missing');
  ground(evidence.groundConnectivity, catalog);
  if (canonical(await ownedDirectory(source)) !== canonical(identity)) fail('Source directory changed');
  const assetBytes = {};
  for (const part of Object.values(catalog.assets)) for (const asset of [part.footprint, ...part.models]) {
    if (!asset.path.startsWith(ASSETS + '/') || asset.path.includes('/../')) fail('Unreviewed asset path');
    const relative = path.relative(ASSETS, asset.path);
    if (Object.hasOwn(assetBytes, relative)) fail('Duplicate reviewed asset path');
    assetBytes[relative] = await readReviewedAsset(asset.path, asset.sha256);
  }
  await reserve([...Object.values(data), ...Object.values(assetBytes)].reduce((total, value) => total + value.length, 0) + 1024 * 1024);
  const jobId = `astra-linux-job-${crypto.randomUUID().replaceAll('-', '').toLowerCase()}`;
  const target = path.join(JOB_ROOT, jobId);
  await fs.mkdir(target, { mode: 0o700 }); // Exclusive target; failure cannot replace an old job.
  try {
    await fs.chmod(target, 0o700);
    for (const name of ['input', 'assets']) await mkdir(path.join(target, name), 0o755);
    await mkdir(path.join(target, 'output'), 0o777);
    const inputHashes = {}, assetHashes = {};
    for (const [name, value] of Object.entries(data)) {
      const metadata = name === 'native-input.json' || name === 'native-evidence.json';
      await write(path.join(target, metadata ? name : `input/${name}`), value, metadata ? 0o600 : 0o444);
      if (!metadata) inputHashes[name] = sha(value);
    }
    const createdDirs = new Set();
    for (const [relative, value] of Object.entries(assetBytes)) {
      const parts = relative.split('/'); let base = path.join(target, 'assets');
      for (const segment of parts.slice(0, -1)) { base = path.join(base, segment); if (!createdDirs.has(base)) { await mkdir(base, 0o755); createdDirs.add(base); } }
      await write(path.join(target, 'assets', relative), value, 0o444); assetHashes[relative] = sha(value);
    }
    // No source may change silently while the copies are staged; never repair it.
    if (canonical(await ownedDirectory(source)) !== canonical(identity)) fail('Source directory changed during copy');
    for (const [name, value] of Object.entries(data)) if (sha(await readSource(path.join(source, name), limits[name] ?? 256 * 1024)) !== sha(value)) fail('Source artifact changed during copy');
    if (sha(await readSource(catalogPath, 1024 * 1024)) !== sha(catalogBytes)) fail('Reviewed catalog changed during copy');
    await verifyScope();
    const authorization = { schema: 'astra-linux-job/v1', jobId, image: IMAGE, boardSha256: expectedBoardSha256,
      nativeInputSha256: sha(data['native-input.json']), nativeEvidenceSha256: sha(data['native-evidence.json']), catalogSha256: sha(catalogBytes), inputHashes, assetHashes,
      policy: { schematicParity: 'not-run', includedSeverities: ['error', 'warning', 'exclusion'], ignoredChecksAllowed: false, excludedAllowed: false } };
    const authorizationBytes = JSON.stringify(authorization, null, 2) + '\n';
    await write(path.join(target, 'authorization.json'), authorizationBytes, 0o600);
    // Authorize only; this function never consumes a capability or executes work.
    await authorizeStagedDrcJob(jobId);
    return { jobId, boardSha256: expectedBoardSha256, authorizationSha256: sha(authorizationBytes), sourceJobId };
  } catch (error) { error.jobId = jobId; error.message = `Staging failed; partial owned job ${jobId} retained: ${error.message}`; throw error; }
}
