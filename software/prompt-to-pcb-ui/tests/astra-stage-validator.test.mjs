import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { IMAGE, JOB_ROOT } from '../scripts/astra-linux-drc.mjs';
import { expectedFootprintTable, validateProjectPolicy } from '../scripts/astra-linux-runtime.mjs';

// Fixtures are source-shaped only. Filesystem is remapped to new owned scratch;
// asset reads and core authorization are explicit mocks. No real staging/runtime.
const moduleUrl = new URL('../scripts/astra-stage-validator.mjs', import.meta.url);
const source = await fs.readFile(moduleUrl, 'utf8');
const reviewed = JSON.parse(await fs.readFile(new URL('../lib/astra-catalog.json', moduleUrl), 'utf8'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const project = () => ({ board: { design_settings: { drc_exclusions: [], rule_severities: Object.fromEntries(['missing_courtyard', 'track_not_centered_on_via', 'tuning_profile_track_geometries', 'footprint_filters_mismatch', 'footprint_type_mismatch'].map(key => [key, 'error'])), rules: { min_resolved_spokes: 2, min_clearance: 0.15, min_track_width: 0.15, min_via_diameter: 0.6, min_through_hole_diameter: 0.3, min_via_annular_width: 0.15, min_hole_clearance: 0.25, min_hole_to_hole: 0.25, min_copper_edge_clearance: 0.5 } } } });
async function fixture(t, options = {}) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'astra-stage-unit-')));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const id = options.app ? 'job-AbC123' : options.sourceId ?? 'astra-corridor-Fixture1';
  const launchRoot = `${JOB_ROOT}/astra-app-owned-ABC123`, appRoot = `${launchRoot}/app-source`, nativeRoot = `${appRoot}/.astra-home/native-jobs`;
  const sourceDir = options.app ? `${nativeRoot}/${id}` : `${JOB_ROOT}/${id}`, jobId = 'astra-linux-job-' + 'a'.repeat(32);
  const catalogPath = fileURLToPath(new URL('../lib/astra-catalog.json', moduleUrl));
  const mapped = file => {
    if (file === JOB_ROOT) return scratch;
    if (file.startsWith(JOB_ROOT + '/')) return path.join(scratch, file.slice(JOB_ROOT.length + 1));
    if (file === catalogPath) return path.join(scratch, 'catalog.json');
    throw Error(`Forbidden filesystem access ${file}`);
  };
  const io = {};
  let writes = 0;
  for (const method of ['lstat', 'open', 'mkdir', 'chmod']) io[method] = (file, ...args) => fs[method](mapped(file), ...args);
  io.writeFile = async (file, ...args) => { writes++; if (options.failCopy && file.endsWith('/input/final-board.kicad_pcb')) throw Error('fixture copy failure'); return fs.writeFile(mapped(file), ...args); };
  io.realpath = async file => { const actual = await fs.realpath(mapped(file)); return actual === mapped(file) ? file : actual; };
  io.statfs = async file => { assert.ok(file === '/' || file === JOB_ROOT); return { bavail: options.lowSpace ? 1024 : 20 * 1024 ** 3, bsize: 1 }; };
  const catalog = structuredClone(reviewed), assets = new Map();
  for (const part of Object.values(catalog.assets)) for (const asset of [part.footprint, ...part.models]) {
    const value = Buffer.from('fixture:' + asset.path); asset.sha256 = sha(value); assets.set(asset.path, value);
  }
  if (options.app) {
    for (const dir of [launchRoot, appRoot, `${appRoot}/.astra-home`, nativeRoot]) await fs.mkdir(mapped(dir), { mode: 0o700 });
    await fs.writeFile(mapped(`${appRoot}/.astra-workspace.json`), JSON.stringify({ version: 1, root: appRoot, purpose: 'isolated-astra-beta' }), { mode: 0o600 });
  }
  await fs.mkdir(mapped(sourceDir), { mode: 0o700 });
  const input = Buffer.from(JSON.stringify({ catalog: catalog.assets }));
  const table = Buffer.from(expectedFootprintTable(catalog));
  const pcb = Buffer.from('explicit fixture board');
  const pro = Buffer.from(JSON.stringify(project()));
  const grounds = catalog.contract.canonicalNets.find(net => net.name === 'GND').pins;
  const evidence = { version: 1, stage: 'finished', routeAttempts: 1, identityPreserved: true, boardSha256: sha(pcb), inputSha256: sha(input), projectSha256: sha(pro), tableSha256: sha(table), connectivity: { available: true, unrouted: 0 }, groundConnectivity: { available: true, anchor: 'J1.2', method: 'native-effective-shape-polygon-components-v1', reachedPads: grounds, unreachedPads: [], padComponents: [grounds] } };
  const files = { 'native-input.json': input, 'native-evidence.json': Buffer.from(JSON.stringify(evidence)), 'final-board.kicad_pcb': pcb, 'final-board.kicad_pro': pro, 'fp-lib-table': table };
  for (const [name, value] of Object.entries(files)) await fs.writeFile(mapped(`${sourceDir}/${name}`), value, { mode: 0o600 });
  await fs.writeFile(mapped(catalogPath), JSON.stringify(catalog));
  const calls = { authorize: 0, assets: 0 };
  const exports = {};
  const deps = { 'node:fs/promises': io, 'node:fs': { constants }, 'node:path': path, 'node:crypto': { ...crypto, randomUUID: () => 'a'.repeat(32) }, 'node:url': { fileURLToPath },
    './astra-linux-drc.mjs': { IMAGE, JOB_ROOT, readReviewedAsset: async (file, expected) => { calls.assets++; assert.equal(sha(assets.get(file)), expected); return assets.get(file); } },
    './astra-linux-runtime.mjs': { expectedFootprintTable, validateProjectPolicy, authorizeStagedDrcJob: async value => { calls.authorize++; assert.equal(value, jobId); if (options.failAuthorization) throw Error('fixture authorization failure'); return Object.freeze({}); } },
  };
  vm.runInNewContext(ts.transpileModule(source.replaceAll('import.meta.url', JSON.stringify(moduleUrl.href)), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
    { exports, require: name => { if (!(name in deps)) throw Error(`Forbidden runtime dependency ${name}`); return deps[name]; }, Buffer, URL, process: { getuid: () => process.getuid() } });
  return { api: exports, id, jobId, sourceDir, launchRoot, appRoot, nativeRoot, mapped, boardSha: sha(pcb), calls, writes: () => writes, files, evidence, catalog };
}

test('launch scope maps only exact app HOME native IDs through the shared stager', async t => {
  const f = await fixture(t, { app: true });
  const scope = await f.api.createAppNativeValidationScope(f.launchRoot);
  assert.equal(Object.keys(scope).length, 0);
  const result = await f.api.stageAppNativeValidation(scope, f.id, f.boardSha);
  assert.equal(result.sourceJobId, f.id); assert.equal(result.boardSha256, f.boardSha);
  assert.deepEqual(await fs.readFile(f.mapped(`${JOB_ROOT}/${f.jobId}/input/final-board.kicad_pcb`)), f.files['final-board.kicad_pcb']);
  assert.equal(f.calls.authorize, 1);
});

test('app scope rejects forged capabilities, outside roots, linked HOME and weakened marker', async t => {
  const f = await fixture(t, { app: true });
  await assert.rejects(f.api.stageAppNativeValidation({}, f.id, f.boardSha), /scope/);
  for (const root of ['/tmp/arbitrary', `${f.launchRoot}/..`, `${JOB_ROOT}/astra-app-owned-abc`]) await assert.rejects(f.api.createAppNativeValidationScope(root), /root/);
  for (const id of ['../job-AbC123', `${f.nativeRoot}/${f.id}`, 'job-AbC123/other', ['job-AbC123'], 'astra-native-test-AbC123']) {
    const scope = await f.api.createAppNativeValidationScope(f.launchRoot);
    await assert.rejects(f.api.stageAppNativeValidation(scope, id, f.boardSha), /ID/);
  }
  await fs.writeFile(f.mapped(`${f.appRoot}/.astra-workspace.json`), JSON.stringify({ version: 1, root: '/tmp/other', purpose: 'isolated-astra-beta' }));
  await assert.rejects(f.api.createAppNativeValidationScope(f.launchRoot), /marker/);
  const g = await fixture(t, { app: true });
  await fs.rename(g.mapped(g.nativeRoot), g.mapped(g.nativeRoot) + '.real');
  await fs.symlink(g.mapped(g.nativeRoot) + '.real', g.mapped(g.nativeRoot));
  await assert.rejects(g.api.createAppNativeValidationScope(g.launchRoot), /directory/);
  assert.equal(f.writes(), 0); assert.equal(g.writes(), 0);
});

test('scope identities and private permissions are rechecked before reading source artifacts', async t => {
  for (const change of ['marker', 'root-mode', 'root-identity', 'job-mode']) {
    const f = await fixture(t, { app: true }), scope = await f.api.createAppNativeValidationScope(f.launchRoot);
    if (change === 'marker') await fs.writeFile(f.mapped(`${f.appRoot}/.astra-workspace.json`), '{}');
    if (change === 'root-mode') await fs.chmod(f.mapped(f.nativeRoot), 0o755);
    if (change === 'root-identity') { await fs.rename(f.mapped(f.nativeRoot), f.mapped(f.nativeRoot) + '.old'); await fs.mkdir(f.mapped(f.nativeRoot), { mode: 0o700 }); }
    if (change === 'job-mode') await fs.chmod(f.mapped(f.sourceDir), 0o755);
    await assert.rejects(f.api.stageAppNativeValidation(scope, f.id, f.boardSha));
    assert.equal(f.writes(), 0); assert.equal(f.calls.assets, 0);
  }
});

test('stager creates only exact copies/permissions/authorization and never claims board success', async t => {
  const f = await fixture(t), result = await f.api.stageNativeValidation(f.id, f.boardSha);
  assert.equal(result.jobId, f.jobId); assert.equal(result.boardSha256, f.boardSha); assert.equal(result.boardPassed, undefined);
  const target = `${JOB_ROOT}/${f.jobId}`;
  assert.equal((await fs.lstat(f.mapped(target))).mode & 0o777, 0o700);
  for (const name of ['input', 'assets']) assert.equal((await fs.lstat(f.mapped(`${target}/${name}`))).mode & 0o777, 0o755);
  assert.equal((await fs.lstat(f.mapped(`${target}/output`))).mode & 0o777, 0o777);
  for (const name of ['final-board.kicad_pcb', 'final-board.kicad_pro', 'fp-lib-table']) {
    assert.equal((await fs.lstat(f.mapped(`${target}/input/${name}`))).mode & 0o777, 0o444);
    assert.deepEqual(await fs.readFile(f.mapped(`${target}/input/${name}`)), f.files[name]);
  }
  assert.equal((await fs.lstat(f.mapped(`${target}/authorization.json`))).mode & 0o777, 0o600);
  assert.equal((await fs.lstat(f.mapped(`${target}/native-input.json`))).mode & 0o777, 0o600);
  const authBytes = await fs.readFile(f.mapped(`${target}/authorization.json`)), auth = JSON.parse(authBytes);
  assert.equal(sha(authBytes), result.authorizationSha256); assert.equal(Object.keys(auth.assetHashes).length, 8);
  assert.equal(auth.policy.ignoredChecksAllowed, false); assert.equal(auth.policy.excludedAllowed, false);
  assert.equal(f.calls.authorize, 1); assert.equal(f.calls.assets, 8);
  await assert.rejects(f.api.stageNativeValidation(f.id, f.boardSha), /EEXIST/);
});

test('reserved-prepare source prefix uses the same fixed-root and native-evidence checks', async t => {
  const f = await fixture(t, { sourceId: 'astra-reserved-prepare-Fixture1' });
  const result = await f.api.stageNativeValidation(f.id, f.boardSha);
  assert.equal(result.sourceJobId, f.id); assert.equal(result.boardPassed, undefined); assert.equal(f.calls.authorize, 1);
  const g = await fixture(t, { sourceId: 'astra-reserved-prepare-Fixture2' });
  for (const id of ['astra-reserved-prepare-../Fixture2', 'astra-reserved-prepare-Fixture2/other', 'astra-reserved-prepare-%2e%2e', 'astra-reserved-prepare-Fixture2?run=other', '/tmp/astra-reserved-prepare-Fixture2', 'astra-reserved-prepare-abc']) {
    await assert.rejects(g.api.stageNativeValidation(id, g.boardSha), /fixed-root native source ID/);
  }
  g.evidence.boardSha256 = '0'.repeat(64);
  await fs.writeFile(g.mapped(`${g.sourceDir}/native-evidence.json`), JSON.stringify(g.evidence));
  await assert.rejects(g.api.stageNativeValidation(g.id, g.boardSha), /hashes/);
  assert.equal(g.writes(), 0); assert.equal(g.calls.authorize, 0);
});

test('invalid IDs/hash and low resource reserve reject without staging', async t => {
  const f = await fixture(t);
  for (const id of ['/private/job', '../job', 'run-private', 'astra-corridor-../x', 'astra-linux-job-abc']) await assert.rejects(f.api.stageNativeValidation(id, f.boardSha));
  await assert.rejects(f.api.stageNativeValidation(f.id, 'bad'));
  assert.equal(f.writes(), 0);
  const low = await fixture(t, { lowSpace: true }); await assert.rejects(low.api.stageNativeValidation(low.id, low.boardSha), /reserve/);
  assert.equal(low.writes(), 0); assert.equal(low.calls.assets, 0);
});

test('native input/evidence/project/table hashes are checked before destination creation', async t => {
  for (const field of ['inputSha256', 'projectSha256', 'tableSha256', 'boardSha256']) {
    const f = await fixture(t); f.evidence[field] = '0'.repeat(64);
    await fs.writeFile(f.mapped(`${f.sourceDir}/native-evidence.json`), JSON.stringify(f.evidence));
    await assert.rejects(f.api.stageNativeValidation(f.id, f.boardSha), /hashes/);
    assert.equal(f.writes(), 0); assert.equal(f.calls.assets, 0);
  }
});

test('canonical directory and no-follow bounded source readers reject links and oversized inputs', async t => {
  const f = await fixture(t), pcb = f.mapped(`${f.sourceDir}/final-board.kicad_pcb`);
  await fs.rename(pcb, pcb + '.real'); await fs.symlink(pcb + '.real', pcb);
  await assert.rejects(f.api.stageNativeValidation(f.id, f.boardSha), /links/); assert.equal(f.writes(), 0);
  const g = await fixture(t), input = await fs.open(g.mapped(`${g.sourceDir}/native-input.json`), 'r+'); await input.truncate(1024 * 1024 + 1); await input.close();
  await assert.rejects(g.api.stageNativeValidation(g.id, g.boardSha), /bounded/); assert.equal(g.writes(), 0);
});

test('project policy and catalog ground mistakes cannot be made valid by rehashing evidence', async t => {
  for (const kind of ['project', 'ground', 'catalog']) {
    const f = await fixture(t);
    if (kind === 'project') {
      const p = project(); p.board.design_settings.rule_severities.missing_courtyard = 'ignore'; const value = JSON.stringify(p);
      await fs.writeFile(f.mapped(`${f.sourceDir}/final-board.kicad_pro`), value); f.evidence.projectSha256 = sha(value);
    } else if (kind === 'ground') {
      const pins = f.evidence.groundConnectivity.reachedPads.map(pin => pin === 'U1.7' ? 'U1.6' : pin); f.evidence.groundConnectivity.reachedPads = pins; f.evidence.groundConnectivity.padComponents = [pins];
    } else {
      const input = JSON.parse(f.files['native-input.json']); input.catalog.bme280.footprint.sha256 = '0'.repeat(64); const value = JSON.stringify(input);
      await fs.writeFile(f.mapped(`${f.sourceDir}/native-input.json`), value); f.evidence.inputSha256 = sha(value);
    }
    await fs.writeFile(f.mapped(`${f.sourceDir}/native-evidence.json`), JSON.stringify(f.evidence));
    await assert.rejects(f.api.stageNativeValidation(f.id, f.boardSha)); assert.equal(f.writes(), 0);
  }
});

test('allocated staging failures retain their exact partial job without deleting source or old receipt', async t => {
  for (const options of [{ failCopy: true }, { failAuthorization: true }]) {
    const f = await fixture(t, options);
    const receipt = f.mapped(`${f.sourceDir}/original-receipt.json`); await fs.writeFile(receipt, 'retained-original');
    await assert.rejects(f.api.stageNativeValidation(f.id, f.boardSha), error => error.jobId === f.jobId && /partial owned job/.test(error.message));
    assert.ok((await fs.lstat(f.mapped(`${JOB_ROOT}/${f.jobId}`))).isDirectory());
    assert.equal(await fs.readFile(receipt, 'utf8'), 'retained-original');
    assert.deepEqual(await fs.readFile(f.mapped(`${f.sourceDir}/final-board.kicad_pcb`)), f.files['final-board.kicad_pcb']);
  }
});
