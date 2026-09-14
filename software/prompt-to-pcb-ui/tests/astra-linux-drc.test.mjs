import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseAstraDrcReport } from '../lib/astra-drc.ts';
import { IMAGE, JOB_ROOT, jobPath, createArgs, assertHashes, hashTree, readQualificationReport, validateKnownBadReport, validateInputCatalog, readReviewedAsset, confirmOwnedContainerAbsent } from '../scripts/astra-linux-drc.mjs';

const job = 'astra-linux-drc-1234abcd';
const name = 'astra-drc-1234abcd-0123456789abcdef';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function reportFixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'astra-drc-report-test-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'output'));
  return { dir, file: path.join(dir, 'output/drc.json') };
}
const endpoint = uuid => ({ uuid, description: 'Explicit fixture endpoint', pos: { x: 1, y: 2 } });
function knownBad() {
  return { $schema: 'https://schemas.kicad.org/drc.v1.json', source: 'final-board.kicad_pcb', date: '2026-09-13T10:00:00', kicad_version: '10.0.5', coordinate_units: 'mm',
    included_severities: ['error', 'warning', 'exclusion'], ignored_checks: [], violations: [], schematic_parity: [],
    unconnected_items: Array.from({ length: 4 }, () => ({ type: 'unconnected_items', description: 'Explicit fixture connection', severity: 'error', items: [endpoint('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), endpoint('bbbbbbbb-cccc-dddd-eeee-ffffffffffff')] })) };
}

test('report reader permits only bounded regular fixed output and rejects links', async t => {
  const { dir, file } = await reportFixture(t);
  const content = JSON.stringify(knownBad());
  await fs.writeFile(file, content);
  assert.equal((await readQualificationReport(dir)).toString(), content);
  await fs.unlink(file);
  const elsewhere = path.join(dir, 'private-fixture.json');
  await fs.writeFile(elsewhere, content);
  await fs.symlink(elsewhere, file);
  await assert.rejects(readQualificationReport(dir));
  await fs.unlink(file);
  await fs.link(elsewhere, file);
  await assert.rejects(readQualificationReport(dir), /bounded native report/);
  await fs.unlink(file);
  await fs.writeFile(file, '');
  await assert.rejects(readQualificationReport(dir), /bounded native report/);
  const fd = await fs.open(file, 'r+'); await fd.truncate(4 * 1024 ** 2 + 1); await fd.close();
  await assert.rejects(readQualificationReport(dir), /bounded native report/);
});

test('report read detects replacement after FD open and during the bounded read', async t => {
  for (const phase of ['open', 'read']) {
    const { dir, file } = await reportFixture(t);
    await fs.writeFile(file, JSON.stringify(knownBad()));
    let replaced = false;
    const replace = async () => { if (!replaced) { replaced = true; await fs.rename(file, file + '.old'); await fs.writeFile(file, '{}'); } };
    const io = { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      if (phase === 'open') await replace();
      return { stat: () => handle.stat(), close: () => handle.close(), read: async (...readArgs) => { const result = await handle.read(...readArgs); if (phase === 'read') await replace(); return result; } };
    } };
    await assert.rejects(readQualificationReport(dir, io), /changed/);
  }
});

test('report reader rejects output-directory symlinks and accepts mapped container file UID', async t => {
  const { dir, file } = await reportFixture(t);
  await fs.writeFile(file, JSON.stringify(knownBad()));
  const io = { ...fs, open: async (...args) => { const handle = await fs.open(...args); return {
    stat: async () => { const st = await handle.stat(); st.uid = 65532; return st; },
    read: (...readArgs) => handle.read(...readArgs), close: () => handle.close(),
  }; } };
  assert.ok((await readQualificationReport(dir, io)).length > 0);
  await fs.rename(path.join(dir, 'output'), path.join(dir, 'other'));
  await fs.symlink(path.join(dir, 'other'), path.join(dir, 'output'));
  await assert.rejects(readQualificationReport(dir), /linked report directory/);
});

test('known-bad qualification requires exact strict report and four complete error endpoints', () => {
  assert.equal(validateKnownBadReport(knownBad()).unrouted, 4);
  for (const change of [r => { r.$schema = 'wrong'; }, r => { r.included_severities = ['warning']; }, r => { r.unconnected_items.pop(); }, r => { r.unconnected_items[0].items.pop(); }, r => { r.unconnected_items[0].items[0].uuid = 'bad'; }, r => { r.unconnected_items[0].severity = 'warning'; }, r => { r.ignored_checks.push({ key: 'clearance', description: 'fixture ignored' }); }, r => { r.unconnected_items[0].excluded = true; }, r => { r.violations.push({ ...r.unconnected_items[0], severity: 'warning', excluded: true }); }]) {
    const r = knownBad(); change(r); assert.throws(() => validateKnownBadReport(r));
  }
});

test('qualification persists parsed ignored findings before rejection without claiming runtime qualification', async () => {
  // Exercise the exact source-owned acceptance block, without any Docker, FS
  // lifecycle, private report, or receipt access. This is a unit fixture only.
  const source = await fs.readFile(new URL('../scripts/astra-linux-drc.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('    const parsed = parseAstraDrcReport(report,');
  const end = source.indexOf('\n  } finally {', start);
  assert.ok(start >= 0 && end > start);
  const acceptanceAndCatch = source.slice(start, end);
  assert.match(acceptanceAndCatch, /receipt\.findings[\s\S]*validateKnownBadReport\(report\)/);
  const execute = new Function('report', 'receipt', 'parseAstraDrcReport', 'validateKnownBadReport', `try {\n${acceptanceAndCatch}\n}`);
  const report = knownBad();
  report.ignored_checks = [{ key: 'clearance', description: 'Explicit fixture ignored check' }];
  const receipt = {};
  execute(report, receipt, parseAstraDrcReport, validateKnownBadReport);
  assert.equal(receipt.executionComplete, true);
  assert.equal(receipt.runtimeQualified, false);
  assert.equal(receipt.boardPassed, false);
  assert.equal(receipt.findings.unconnected, 4);
  assert.equal(receipt.findings.checksComplete, false);
  assert.deepEqual(receipt.findings.ignoredChecks, report.ignored_checks);
  assert.match(receipt.failure, /Known-bad native report qualification failed/);
  const accepted = {};
  execute(knownBad(), accepted, parseAstraDrcReport, validateKnownBadReport);
  assert.equal(accepted.executionComplete, true);
  assert.equal(accepted.runtimeQualified, true);
  assert.equal(accepted.boardPassed, false);
});

test('native input is hash-bound to evidence and exact reviewed four catalog assets', async () => {
  // Read repository source catalog only, never original native input/run artifacts.
  const reviewed = JSON.parse(await fs.readFile(new URL('../lib/astra-catalog.json', import.meta.url), 'utf8'));
  const native = { catalog: structuredClone(reviewed.assets) };
  const bytes = Buffer.from(JSON.stringify(native));
  const evidence = { inputSha256: sha(bytes), boardSha256: '2af2284839fef3914d9ac5416d67c46af4323b9c28b9f6c438ce4683864fcafc', connectivity: { unrouted: 4 } };
  assert.doesNotThrow(() => validateInputCatalog(bytes, native, evidence, reviewed));
  assert.throws(() => validateInputCatalog(Buffer.from('{}'), native, evidence, reviewed), /binding/);
  for (const modify of [v => { delete v.catalog.bme280; }, v => { v.catalog.extra = v.catalog.bme280; }, v => { v.catalog.bme280.footprint.sha256 = '0'.repeat(64); }, v => { v.catalog.bme280.models[0].offsetMm = [3, 2, 1]; }]) {
    const changed = structuredClone(native); modify(changed); const changedBytes = Buffer.from(JSON.stringify(changed));
    assert.throws(() => validateInputCatalog(changedBytes, changed, { ...evidence, inputSha256: sha(changedBytes) }, reviewed));
  }
});

test('bundled asset reader allows root-owned pinned bytes but rejects writable or mismatched assets', async t => {
  const { dir } = await reportFixture(t);
  const local = path.join(dir, 'fixture-asset'); const bytes = Buffer.from('explicit fixture model');
  await fs.writeFile(local, bytes, { mode: 0o644 });
  const pretend = '/Applications/KiCad/KiCad.app/Contents/SharedSupport/3dmodels/fixture.step';
  const io = owner => ({
    lstat: async file => { assert.equal(file, pretend); const st = await fs.lstat(local); st.uid = owner; return st; },
    realpath: async file => { assert.equal(file, pretend); return pretend; },
    open: async (file, flags) => { assert.equal(file, pretend); return fs.open(local, flags); },
  });
  assert.deepEqual(await readReviewedAsset(pretend, sha(bytes), io(0)), bytes);
  await assert.rejects(readReviewedAsset(pretend, '0'.repeat(64), io(0)), /hash mismatch/);
  await assert.rejects(readReviewedAsset(pretend, sha(bytes), io(65531)), /Untrusted/);
  await fs.chmod(local, 0o666);
  await assert.rejects(readReviewedAsset(pretend, sha(bytes), io(0)), /Untrusted/);
});

test('Docker29 lowercase exact-target absence requires independently empty full-ID listing', async () => {
  const id = 'a'.repeat(64);
  const absent = stderr => ({ code: 1, signal: null, reason: null, stdout: '[]\n', stderr });
  for (const text of [`error: no such object: ${id}\n`, `Error: No such object: ${id}`, `Error response from daemon: No such container: ${id}`]) {
    const calls = [];
    const result = await confirmOwnedContainerAbsent(id, absent(text), async args => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; });
    assert.equal(result.confirmedAbsent, true);
    assert.deepEqual(calls, [['ps', '--all', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}']]);
  }
  const calls = [];
  assert.equal((await confirmOwnedContainerAbsent(name, absent(`error: no such object: ${name}`), async args => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; })).confirmedAbsent, true);
  assert.equal(calls[0][4], `name=^/${name}$`);
});

test('Docker permission, daemon, wrong-target and incomplete observations never confirm absence', async () => {
  const id = 'a'.repeat(64), expected = `error: no such object: ${id}`;
  const base = { code: 1, signal: null, reason: null, stdout: '[]', stderr: expected };
  for (const change of [
    { stderr: 'permission denied' }, { stderr: 'Cannot connect to the Docker daemon' },
    { stderr: 'error: no such object: ' + 'b'.repeat(64) }, { stderr: expected + '\npermission denied' },
    { code: 0 }, { code: null }, { reason: 'timeout' }, { signal: 'SIGKILL' }, { stdout: '[{"Id":"present"}]' },
  ]) {
    let calls = 0;
    const result = await confirmOwnedContainerAbsent(id, { ...base, ...change }, async () => { calls++; throw Error('must not list after ambiguous inspect'); });
    assert.equal(result.confirmedAbsent, false); assert.equal(calls, 0);
  }
  for (const ps of [{ code: 0, stdout: id + '\n', stderr: '' }, { code: 1, stdout: '', stderr: 'permission denied' }, { code: 0, stdout: '', stderr: 'daemon warning' }, { code: null, reason: 'timeout', stdout: '', stderr: '' }]) {
    assert.equal((await confirmOwnedContainerAbsent(id, base, async () => ps)).confirmedAbsent, false);
  }
  await assert.rejects(confirmOwnedContainerAbsent('all-containers', base), /Invalid owned/);
});

test('qualification IDs cannot select arbitrary directories', () => {
  assert.equal(jobPath(job), `${JOB_ROOT}/${job}`);
  for (const id of ['../private', '/tmp/x', 'astra-linux-drc-../x', 'astra-linux-drc-a,b', 'astra-linux-drc-a\nb', 'astra-linux-drc-ABCDEF12', '', null]) {
    assert.throws(() => jobPath(id), /Invalid authorized/);
  }
});

test('command is one pinned CLI operation with explicit severity and no parity claim', () => {
  const args = createArgs(jobPath(job), name);
  assert.equal(args.filter(x => x === IMAGE).length, 1);
  assert.ok(args.includes('--pull=never'));
  assert.equal(args[args.indexOf('--platform') + 1], 'linux/amd64');
  assert.match(args.at(-1), /exec kicad-cli pcb drc --format json --units mm --severity-all --output \/output\/drc.json \/input\/final-board.kicad_pcb$/);
  assert.doesNotMatch(args.at(-1), /--schematic-parity|apt|pip|xvfb|curl|wget/i);
  assert.throws(() => createArgs('/Users/jackal-kahwati', name), /Invalid/);
  assert.throws(() => createArgs(jobPath(job), 'unrelated-container'), /Invalid/);
});

test('container restrictions, fixed mounts and resource ceilings cannot be supplied by caller', () => {
  const args = createArgs(jobPath(job), name);
  const flag = x => args[args.indexOf(x) + 1];
  assert.equal(flag('--network'), 'none');
  assert.ok(args.includes('--read-only'));
  assert.equal(flag('--user'), '65532:65532');
  assert.equal(flag('--cap-drop'), 'ALL');
  assert.equal(flag('--security-opt'), 'no-new-privileges=true');
  assert.equal(flag('--cpus'), '2');
  assert.equal(flag('--memory'), '2g');
  assert.equal(flag('--memory-swap'), '2g');
  assert.equal(flag('--pids-limit'), '128');
  assert.equal(flag('--log-driver'), 'none');
  assert.match(flag('--tmpfs'), /size=134217728/);
  const mounts = args.flatMap((v, i) => v === '--mount' ? [args[i + 1]] : []);
  assert.equal(mounts.length, 3);
  assert.equal(mounts.filter(x => x.endsWith(',readonly')).length, 2);
  assert.ok(mounts.every(x => x.startsWith(`type=bind,source=${jobPath(job)}/`)));
  assert.doesNotMatch(mounts.join('\n'), /\.sock|\/Users\/|\/home\/|\/runs\/|EE-lab/);
  assert.ok(!args.some(x => ['--privileged', '--device', '--volume', '-v', '--publish'].includes(x)));
  assert.doesNotMatch(args.join('\n'), /DISPLAY=|DOCKER_HOST=|AWS_|ANTHROPIC_|OPENAI_/);
});

test('hash binding rejects missing, added and changed inputs, independent of key order', () => {
  assert.doesNotThrow(() => assertHashes({ b: '2', a: '1' }, { a: '1', b: '2' }));
  assert.throws(() => assertHashes({ a: '1' }, { a: '1', b: '2' }), /hashes changed/);
  assert.throws(() => assertHashes({ a: '1', b: '2' }, { a: '1' }), /hashes changed/);
  assert.throws(() => assertHashes({ a: '2' }, { a: '1' }), /hashes changed/);
});

test('input walk hashes bytes and rejects symlinks and hardlinks', async () => {
  const root = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(root, 'astra-drc-guard-test-'));
  try {
    await fs.writeFile(path.join(dir, 'board'), 'original');
    const before = await hashTree(dir);
    await fs.writeFile(path.join(dir, 'board'), 'changed');
    assert.throws(() => assertHashes(before, { ...before, board: 'not-the-hash' }), /hashes changed/);
    assert.notDeepEqual(before, await hashTree(dir));
    await fs.symlink(path.join(dir, 'board'), path.join(dir, 'alias'));
    await assert.rejects(hashTree(dir), /owned regular/);
    await fs.unlink(path.join(dir, 'alias'));
    await fs.link(path.join(dir, 'board'), path.join(dir, 'hardlink'));
    await assert.rejects(hashTree(dir), /owned regular/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
