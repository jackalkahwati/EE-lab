import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parseAstraDrcReport } from '../lib/astra-drc.ts';
import { IMAGE, JOB_ROOT, assertHashes, createArgs, confirmOwnedContainerAbsent } from '../scripts/astra-linux-drc.mjs';

// Source only plus newly-created scratch. Docker/process/native interfaces are
// replaced in the VM; no runtime dependency can invoke the actual Docker CLI.
const moduleUrl = new URL('../scripts/astra-linux-runtime.mjs', import.meta.url);
const source = await fs.readFile(moduleUrl, 'utf8');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ASSETS = '/Applications/KiCad/KiCad.app/Contents/SharedSupport';
const VM_PATH = '/Users/jackal-kahwati/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw';
const reviewedCatalog = JSON.parse(await fs.readFile(new URL('../lib/astra-catalog.json', import.meta.url), 'utf8'));
const GROUND = reviewedCatalog.contract.canonicalNets.find(net => net.name === 'GND').pins;
const projectPolicy = () => ({ board: { design_settings: { drc_exclusions: [], rule_severities: Object.fromEntries(['missing_courtyard', 'track_not_centered_on_via', 'tuning_profile_track_geometries', 'footprint_filters_mismatch', 'footprint_type_mismatch'].map(key => [key, 'error'])), rules: { min_resolved_spokes: 2, min_clearance: 0.15, min_track_width: 0.15, min_via_diameter: 0.6, min_through_hole_diameter: 0.3, min_via_annular_width: 0.15, min_hole_clearance: 0.25, min_hole_to_hole: 0.25, min_copper_edge_clearance: 0.5 } } } });
const goodReport = () => ({ $schema: 'https://schemas.kicad.org/drc.v1.json', source: 'final-board.kicad_pcb', date: '2026-09-13T12:00:00', kicad_version: '10.0.5', violations: [], unconnected_items: [], schematic_parity: [], coordinate_units: 'mm', included_severities: ['error', 'warning', 'exclusion'], ignored_checks: [] });

async function fixture(t, options = {}) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'astra-runtime-unit-')));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const jobId = 'astra-linux-job-fixture1234', dir = `${JOB_ROOT}/${jobId}`;
  const catalogPath = fileURLToPath(new URL('../lib/astra-catalog.json', moduleUrl));
  const ownSource = fileURLToPath(moduleUrl);
  const mapped = p => {
    if (p === JOB_ROOT) return scratch;
    if (p.startsWith(JOB_ROOT + '/')) return path.join(scratch, p.slice(JOB_ROOT.length + 1));
    if (p === catalogPath) return path.join(scratch, 'catalog.json');
    if (p === ownSource) return path.join(scratch, 'runtime-source.mjs');
    throw Error(`Unexpected filesystem access ${p}`);
  };
  const io = {};
  for (const method of ['lstat', 'open', 'readdir', 'readFile', 'writeFile']) io[method] = (p, ...args) => fs[method](mapped(p), ...args);
  io.realpath = async p => {
    if (p === VM_PATH) return '/Volumes/T9 Backup/test-owned-vm';
    const real = await fs.realpath(mapped(p));
    return real === mapped(p) ? p : real;
  };
  io.stat = async p => { assert.equal(p, '/Volumes/T9 Backup/test-owned-vm'); return { blocks: 1024 }; };
  io.statfs = async p => { assert.ok(['/', '/Volumes/T9 Backup/test-owned-vm', dir].includes(p)); return { bavail: options.lowSpace ? 1 : 20 * 1024 ** 3, bsize: 1 }; };
  const calls = []; let name, created = false, removed = false;
  const imageId = 'sha256:' + 'b'.repeat(64), containerId = 'c'.repeat(64);
  const docker = async (args, config = {}) => {
    calls.push([...args]);
    const result = value => ({ code: 0, reason: null, signal: null, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
    if (args[0] === 'info') return result({ ID: 'fixture', Name: 'docker-desktop', OSType: 'linux', Architecture: 'aarch64', ServerVersion: '29.fixture' });
    if (args[0] === 'image') return result([{ Architecture: 'amd64', Os: 'linux', RepoDigests: [options.wrongImage ? 'wrong' : IMAGE], Config: { Entrypoint: [] }, Id: imageId }]);
    if (args[0] === 'create') { name = args[args.indexOf('--name') + 1]; created = true; if (options.createTimeout) return { code: null, reason: 'timeout', stdout: '', stderr: '' }; return result(containerId); }
    if (args[0] === 'inspect') {
      assert.ok([containerId, name].includes(args[1]));
      if (!created || removed) return { code: 1, reason: null, signal: null, stdout: '[]', stderr: `error: no such object: ${args[1]}` };
      return result([{ Id: containerId, Name: '/' + name, Image: options.wrongContainer ? 'wrong' : imageId, Config: { Labels: { 'astra.operation': 'known-bad-drc-qualification' } }, HostConfig: {}, Mounts: [], State: { Running: false, OOMKilled: false, ExitCode: 0 } }]);
    }
    if (args[0] === 'start') {
      assert.equal(args[2], containerId); assert.equal(config.timeoutMs, 120000);
      if (options.cancel) { options.cancel.abort('fixture cancellation'); return { code: null, reason: 'cancelled', signal: 'SIGKILL', stdout: '', stderr: '' }; }
      if (options.mutateInput) { const file = mapped(`${dir}/input/final-board.kicad_pcb`); await fs.chmod(file, 0o644); await fs.writeFile(file, 'mutated'); await fs.chmod(file, 0o444); }
      await fs.writeFile(mapped(`${dir}/output/drc.json`), JSON.stringify(options.report ?? goodReport()));
      return result('fixture native diagnostics');
    }
    if (args[0] === 'rm') { assert.deepEqual([...args], ['rm', '--force', containerId]); if (options.cleanupFailure) return { code: 1, stdout: '', stderr: 'permission denied' }; removed = true; return result(containerId); }
    if (args[0] === 'ps') { assert.ok(args.includes(`id=${containerId}`) || args.includes(`name=^/${name}$`)); return result(removed || !created ? '' : containerId); }
    throw Error(`Unmocked Docker operation ${args[0]}`);
  };
  const exports = {};
  const dependencies = {
    'node:fs/promises': io, 'node:fs': { constants }, 'node:path': path, 'node:crypto': crypto, 'node:url': { fileURLToPath },
    '../lib/astra-drc.ts': { parseAstraDrcReport },
    './astra-linux-drc.mjs': { IMAGE, JOB_ROOT, createArgs, assertHashes,
      readQualificationReport: async p => { assert.equal(p, dir); return fs.readFile(mapped(`${dir}/output/drc.json`)); },
      confirmOwnedContainerAbsent: (target, inspect) => confirmOwnedContainerAbsent(target, inspect, docker), runAstraDrcDockerCommand: docker },
  };
  const compiled = ts.transpileModule(source.replaceAll('import.meta.url', JSON.stringify(moduleUrl.href)), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  vm.runInNewContext(compiled, { exports, require: name => { if (!(name in dependencies)) throw Error(`Unexpected dependency ${name}`); return dependencies[name]; }, Buffer, URL, process: { getuid: () => process.getuid() }, AbortController, setInterval, clearInterval });
  await fs.mkdir(mapped(dir), { mode: 0o700 });
  for (const sub of ['input', 'assets', 'output']) { const file = mapped(`${dir}/${sub}`); const mode = sub === 'output' ? 0o777 : 0o755; await fs.mkdir(file, { mode }); await fs.chmod(file, mode); }
  const catalog = { assets: {}, contract: { canonicalNets: [{ name: 'GND', pins: options.reverseGroundOrder ? [...GROUND].reverse() : GROUND }] } };
  const assetHashes = {};
  for (const [id, library] of [['bme280', 'Package_LGA'], ['cap-100nf-0402', 'Capacitor_SMD'], ['res-4k7-0402', 'Resistor_SMD'], ['header-1x04', 'Connector_PinHeader_2.54mm']]) {
    const footprint = { libraryPath: `${ASSETS}/footprints/${library}.pretty`, name: id, path: `${ASSETS}/footprints/${library}.pretty/${id}.kicad_mod`, sha256: sha(id) };
    const model = { path: `${ASSETS}/3dmodels/${library}.3dshapes/${id}.step`, sha256: sha(id + '-model'), offsetMm: [0, 0, 0], scale: [1, 1, 1], rotationDeg: [0, 0, 0], sourceReference: 'fixture' };
    catalog.assets[id] = { footprint, models: [model] };
    for (const [asset, text] of [[footprint, id], [model, id + '-model']]) { const rel = path.relative(ASSETS, asset.path); const file = mapped(`${dir}/assets/${rel}`); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text, { mode: 0o444 }); assetHashes[rel] = asset.sha256; }
  }
  const catalogBytes = Buffer.from(JSON.stringify(catalog)), nativeBytes = Buffer.from(JSON.stringify({ catalog: catalog.assets }));
  const evidence = { version: 1, stage: 'finished', routeAttempts: 1, identityPreserved: true, inputSha256: sha(nativeBytes), boardSha256: sha('fixture board'), projectSha256: sha(JSON.stringify(projectPolicy())), tableSha256: sha(exports.expectedFootprintTable(catalog)), connectivity: { available: true, unrouted: options.nativeUnrouted ?? 0 }, groundConnectivity: { available: true, anchor: 'J1.2', method: 'native-effective-shape-polygon-components-v1', reachedPads: GROUND, unreachedPads: [], padComponents: [GROUND] } };
  if (options.groundDisconnected) evidence.groundConnectivity = { ...evidence.groundConnectivity, reachedPads: ['J1.2'], unreachedPads: GROUND.filter(p => p !== 'J1.2'), padComponents: [['J1.2'], GROUND.filter(p => p !== 'J1.2')] };
  const evidenceBytes = Buffer.from(JSON.stringify(evidence));
  const inputFiles = { 'final-board.kicad_pcb': 'fixture board', 'final-board.kicad_pro': JSON.stringify(projectPolicy()), 'fp-lib-table': exports.expectedFootprintTable(catalog) };
  for (const [name, value] of Object.entries(inputFiles)) await fs.writeFile(mapped(`${dir}/input/${name}`), value, { mode: 0o444 });
  await fs.writeFile(mapped(catalogPath), catalogBytes); await fs.writeFile(mapped(ownSource), source);
  await fs.writeFile(mapped(`${dir}/native-input.json`), nativeBytes); await fs.writeFile(mapped(`${dir}/native-evidence.json`), evidenceBytes);
  const auth = { schema: 'astra-linux-job/v1', jobId, image: IMAGE, boardSha256: evidence.boardSha256, nativeInputSha256: sha(nativeBytes), nativeEvidenceSha256: sha(evidenceBytes), catalogSha256: sha(catalogBytes), inputHashes: Object.fromEntries(Object.entries(inputFiles).map(([k, v]) => [k, sha(v)])), assetHashes, policy: { schematicParity: 'not-run', includedSeverities: ['error', 'warning', 'exclusion'], ignoredChecksAllowed: false, excludedAllowed: false } };
  const writeAuth = () => fs.writeFile(mapped(`${dir}/authorization.json`), JSON.stringify(auth), { mode: 0o600 }); await writeAuth();
  return { api: exports, calls, dir, jobId, auth, writeAuth, mapped, removed: () => removed };
}

test('table bytes and project-policy validation match authoritative parent source; grounds come from actual catalog', async t => {
  const f = await fixture(t);
  const policySource = await fs.readFile(new URL('../lib/astra-project-policy.ts', import.meta.url), 'utf8');
  const parent = {};
  class AstraError extends Error {}
  vm.runInNewContext(ts.transpileModule(policySource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: parent, require: name => {
    if (name === './astra-execution') return { AstraError };
    if (name === './astra-local-parts') return { ASTRA_CATALOG: reviewedCatalog };
    throw Error('Unexpected parent policy dependency');
  } });
  assert.equal(f.api.expectedFootprintTable(reviewedCatalog), parent.expectedAstraFootprintTable());
  assert.ok(GROUND.includes('U1.7')); assert.ok(!GROUND.includes('U1.6'));
  const samples = [projectPolicy(), {}, null];
  for (const change of [p => { p.board.design_settings.drc_exclusions = ['excluded']; }, p => { p.board.design_settings.rules.min_resolved_spokes = 1; }, p => { p.board.design_settings.rule_severities.missing_courtyard = 'ignore'; }, p => { p.board.design_settings.rules.min_clearance = 0.01; }]) {
    const p = projectPolicy(); change(p); samples.push(p);
  }
  for (const p of samples) {
    let a = false, b = false;
    try { f.api.validateProjectPolicy(p); a = true; } catch {}
    try { parent.validateAstraProjectPolicy(p); b = true; } catch {}
    assert.equal(a, b);
  }
});

test('native table hash and project settings cannot be weakened even with matching authorization hashes', async t => {
  for (const kind of ['table', 'project', 'ground']) {
    const f = await fixture(t);
    const file = f.mapped(`${f.dir}/native-evidence.json`);
    const evidence = JSON.parse(await fs.readFile(file, 'utf8'));
    if (kind === 'table') delete evidence.tableSha256;
    if (kind === 'project') {
      const project = projectPolicy(); project.board.design_settings.rule_severities.missing_courtyard = 'ignore';
      const content = JSON.stringify(project); const file = f.mapped(`${f.dir}/input/final-board.kicad_pro`); await fs.chmod(file, 0o644); await fs.writeFile(file, content); await fs.chmod(file, 0o444);
      f.auth.inputHashes['final-board.kicad_pro'] = sha(content); evidence.projectSha256 = sha(content);
    }
    if (kind === 'ground') {
      evidence.groundConnectivity.reachedPads = GROUND.map(p => p === 'U1.7' ? 'U1.6' : p);
      evidence.groundConnectivity.padComponents = [evidence.groundConnectivity.reachedPads];
    }
    const content = JSON.stringify(evidence); await fs.writeFile(file, content); f.auth.nativeEvidenceSha256 = sha(content); await f.writeAuth();
    await assert.rejects(f.api.authorizeStagedDrcJob(f.jobId)); assert.equal(f.calls.length, 0);
  }
});

test('fixed UID readability and traversal are validated without repairing staged permissions', async t => {
  for (const [relative, mode] of [['input', 0o700], ['assets', 0o750], ['assets/footprints', 0o700], ['input/final-board.kicad_pcb', 0o400], ['input/final-board.kicad_pro', 0o644], ['assets/3dmodels/Package_LGA.3dshapes/bme280.step', 0o440], ['output', 0o755]]) {
    const f = await fixture(t), file = f.mapped(`${f.dir}/${relative}`);
    await fs.chmod(file, mode);
    await assert.rejects(f.api.authorizeStagedDrcJob(f.jobId), /exact mode/);
    assert.equal((await fs.lstat(file)).mode & 0o7777, mode);
    assert.equal(f.calls.length, 0);
  }
});

test('catalog ground ordering does not change validated six-pad partition', async t => {
  for (const groundDisconnected of [false, true]) {
    const f = await fixture(t, { reverseGroundOrder: true, groundDisconnected });
    const result = await f.api.runValidatedDrcJob({ capability: await f.api.authorizeStagedDrcJob(f.jobId) });
    assert.equal(result.executionComplete, true);
    assert.equal(result.boardPassed, !groundDisconnected);
  }
});

test('fixed-root authorization rejects caller paths, forged capability and changed hashes before Docker', async t => {
  const f = await fixture(t);
  for (const id of ['../private', '/tmp/job', 'astra-linux-job-abc', 'astra-linux-drc-fixture1234']) await assert.rejects(f.api.authorizeStagedDrcJob(id));
  await assert.rejects(f.api.runValidatedDrcJob({ capability: {} }), /capability/);
  f.auth.inputHashes['final-board.kicad_pcb'] = '0'.repeat(64); await f.writeAuth();
  await assert.rejects(f.api.authorizeStagedDrcJob(f.jobId), /hashes changed/);
  assert.equal(f.calls.length, 0);
});

test('capability is opaque single-use and clean measured board requires exact job completion', async t => {
  const f = await fixture(t), capability = await f.api.authorizeStagedDrcJob(f.jobId);
  assert.deepEqual(Object.keys(capability), []);
  const receipt = await f.api.runValidatedDrcJob({ capability });
  assert.equal(receipt.executionComplete, true); assert.equal(receipt.checksComplete, true); assert.equal(receipt.boardPassed, true);
  assert.equal(receipt.inputsUnchanged, true); assert.equal(receipt.cleanup.confirmedAbsent, true); assert.equal(f.removed(), true);
  await assert.rejects(f.api.runValidatedDrcJob({ capability }), /consumed/);
  assert.equal(f.calls.filter(args => args[0] === 'start').length, 1);
  const saved = JSON.parse(await fs.readFile(f.mapped(`${f.dir}/runtime-receipt.json`), 'utf8'));
  assert.equal(saved.reportSha256, receipt.reportSha256);
});

test('ignored findings are preserved separately from execution and prevent approval', async t => {
  const report = goodReport(); report.ignored_checks = [{ key: 'clearance', description: 'Fixture ignored check' }];
  const f = await fixture(t, { report });
  const result = await f.api.runValidatedDrcJob({ capability: await f.api.authorizeStagedDrcJob(f.jobId) });
  assert.equal(result.executionComplete, true); assert.equal(result.checksComplete, false); assert.equal(result.boardPassed, false);
  assert.equal(result.findings.ignoredChecks.length, 1); assert.equal(result.cleanup.confirmedAbsent, true);
});

test('native connectivity or disconnected measured ground defeats otherwise clean report', async t => {
  for (const options of [{ nativeUnrouted: 1 }, { groundDisconnected: true }]) {
    const f = await fixture(t, options); const result = await f.api.runValidatedDrcJob({ capability: await f.api.authorizeStagedDrcJob(f.jobId) });
    assert.equal(result.executionComplete, true); assert.equal(result.checksComplete, true); assert.equal(result.boardPassed, false);
  }
});

test('missing/full-table mismatch cannot resolve against an unreviewed image library', async t => {
  const f = await fixture(t);
  const table = f.mapped(`${f.dir}/input/fp-lib-table`); await fs.chmod(table, 0o644); await fs.writeFile(table, '(fp_lib_table)'); await fs.chmod(table, 0o444);
  f.auth.inputHashes['fp-lib-table'] = sha('(fp_lib_table)'); await f.writeAuth();
  await assert.rejects(f.api.authorizeStagedDrcJob(f.jobId), /table hash|exact reviewed mapping/);
  assert.equal(f.calls.length, 0);
});

test('authorization changed after issuance and wrong image never start a container', async t => {
  const f = await fixture(t), capability = await f.api.authorizeStagedDrcJob(f.jobId);
  f.auth.policy.excludedAllowed = true; await f.writeAuth();
  await assert.rejects(f.api.runValidatedDrcJob({ capability })); assert.equal(f.calls.length, 0);
  const g = await fixture(t, { wrongImage: true });
  const result = await g.api.runValidatedDrcJob({ capability: await g.api.authorizeStagedDrcJob(g.jobId) });
  assert.equal(result.boardPassed, false); assert.match(result.failure, /image identity/); assert.ok(g.calls.every(args => args[0] !== 'create'));
});

test('cancellation removes exact owned container and does not pass', async t => {
  const cancel = new AbortController(), f = await fixture(t, { cancel });
  const result = await f.api.runValidatedDrcJob({ capability: await f.api.authorizeStagedDrcJob(f.jobId), signal: cancel.signal });
  assert.equal(result.cancelled, true); assert.equal(result.boardPassed, false); assert.equal(result.executionComplete, false);
  assert.equal(result.cleanup.confirmedAbsent, true); assert.equal(f.removed(), true);
});

test('timed-out create still cleans the uniquely named operation', async t => {
  const f = await fixture(t, { createTimeout: true });
  const result = await f.api.runValidatedDrcJob({ capability: await f.api.authorizeStagedDrcJob(f.jobId) });
  assert.equal(result.boardPassed, false); assert.equal(result.cleanup.confirmedAbsent, true); assert.equal(f.removed(), true);
  assert.ok(f.calls.every(args => args[0] !== 'start'));
});

test('storage hold prevents create; cleanup or post-run mutation invalidates board approval', async t => {
  for (const options of [{ lowSpace: true }, { cleanupFailure: true }, { mutateInput: true }]) {
    const f = await fixture(t, options), result = await f.api.runValidatedDrcJob({ capability: await f.api.authorizeStagedDrcJob(f.jobId) });
    assert.equal(result.boardPassed, false);
    if (options.lowSpace) assert.ok(f.calls.every(args => args[0] !== 'create'));
    if (options.cleanupFailure) assert.match(result.cleanupFailure, /cleanup/);
    if (options.mutateInput) assert.equal(result.inputsUnchanged, false);
  }
});
