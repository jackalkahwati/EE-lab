import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs, cleanEnv, sandboxProfile, inspectAdapter, withValidatorController, loadQualificationModule, qualificationInventory, verifyAndPublishQualification, VALIDATOR_SCRIPTS, NATIVE_SCRIPTS } from '../scripts/astra-local.mjs';
import { cleanRelative, safeRead, writeNew, hash, inventory, SOURCE } from '../scripts/source-snapshot.mjs';

const adapterArgs = ['--cli', '/approved/native', '--cli-sha256', 'a'.repeat(64)];
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = relative => fs.readFileSync(path.join(source, relative), 'utf8');
const snapshot = { root: '/owned', app: '/owned/app-source', node: '/runtime/bin/node', dependencies: '/deps/node_modules',
  testEmail: 'astra-operator@example.test', native: { pins: { tools: { sandbox: { path: '/usr/bin/sandbox-exec' }, python: { path: '/p/python' } },
    assetRoots: ['/p/assets'], runtimeRoots: ['/p/runtime'], runtimeFiles: ['/'], runtimeDirectoryData: ['/Applications/KiCad/KiCad.app'], machServices: [] } } };
const secrets = { authSecret: 'a'.repeat(64), password: 'private-password-never-forwarded' };

test('launcher has no inferred mode, identity, port, adapter or manifest', () => {
  for (const args of [[], ['--check'], ['--prepare'], ['--serve'], ['--serve', '/owned'], ['--serve', '/owned', '--port', '80'],
    ['--serve', '/owned', '--port', '65536'], ['--serve', '/owned', '--port', '03000'], ['--check', '--native-manifest', '/pins', '--force'],
    ['--prepare', '--native-manifest', '/pins', '--test-email', 'real@gmail.com'], ['--serve', '/owned', '--port', '3100', '--port', '3101']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.deepEqual(parseArgs(['--prepare', '--native-manifest', '/pins', '--test-email', 'astra@example.test']), {
    mode: 'prepare', 'native-manifest': '/pins', 'test-email': 'astra@example.test',
  });
  assert.deepEqual(parseArgs(['--serve', '/owned', '--port', '3100']), { mode: 'serve', snapshot: '/owned', port: 3100 });
  assert.deepEqual(parseArgs(['--build', '/owned']), { mode: 'build', snapshot: '/owned' });
});
test('qualification seal requires explicit owned snapshot, bundle ID and port only', () => {
  assert.deepEqual(parseArgs(['--seal-qualification', '/owned', '--bundle-id', 'native-backend-test', '--port', '4511']), {
    mode: 'seal-qualification', snapshot: '/owned', 'bundle-id': 'native-backend-test', port: 4511,
  });
  for (const args of [['--seal-qualification'], ['--seal-qualification', '/owned', '--bundle-id', '../bad', '--port', '4511'],
    ['--seal-qualification', '/owned', '--bundle-id', 'native-backend-test'],
    ['--seal-qualification', '/owned', '--bundle-id', 'native-backend-test', '--port', '4511', '--force', 'true']]) assert.throws(() => parseArgs(args));
});
test('qualification loader executes real staged graph but refuses external imports or process calls', async () => {
  const api = loadQualificationModule({ app: source, testEmail: 'astra@example.test' }, 4511);
  assert.equal(typeof api.verifyAstraQualification, 'function');
  assert.equal(typeof api.publishAstraReadiness, 'function');
  assert.ok(Object.keys(api.ASTRA_QUALIFICATION_FILES).length > 30);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'astra-qualification-loader-')));
  try {
    fs.mkdirSync(path.join(root, 'lib'));
    for (const text of ["import fs from 'node:net'; export const bad=fs;", "import x from '../../outside'; export const bad=x;", "import {spawn} from 'node:child_process'; spawn('/bin/echo',[]);"]) {
      fs.writeFileSync(path.join(root, 'lib/astra-readiness.ts'), text);
      assert.throws(() => loadQualificationModule({ app: root }, 4511));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('actual staged publisher handles host filesystem ENOENT on first synthetic receipt', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'astra-publish-realm-')));
  try {
    fs.mkdirSync(path.join(root, 'lib')); fs.mkdirSync(path.join(root, '.astra-home'), { mode: 0o700 });
    const modules = ['astra-readiness', 'astra-beta', 'astra-origin', 'auth', 'astra-execution', 'astra-local-parts',
      'astra-validator-evidence', 'astra-validator-containment', 'astra-drc', 'astra-ground-evidence', 'astra-project-policy', 'astra-export-evidence'];
    for (const name of modules) fs.copyFileSync(path.join(source, `lib/${name}.ts`), path.join(root, `lib/${name}.ts`));
    for (const name of ['astra-catalog.json', 'astra-native-pins.json']) fs.copyFileSync(path.join(source, 'lib', name), path.join(root, 'lib', name));
    const require = createRequire(path.join(source, 'package.json')), ts = require('typescript');
    const original = read('lib/astra-readiness.ts');
    const tree = ts.createSourceFile('astra-readiness.ts', original, ts.ScriptTarget.Latest, true);
    const verify = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'verify');
    assert.ok(verify?.body);
    // Only the expensive evidence verifier is a synthetic fixture. Keep the
    // ACTUAL staged publisher, file reader, Error checks and atomic rename intact.
    // This temp receipt cannot qualify a real workspace and is deleted below.
    const state = { bundleRoot: path.join(root, '.astra-home/qualifications/synthetic-test'), indexHash: 'a'.repeat(64),
      qualifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000).toISOString(), warnings: 0, root, home: path.join(root, '.astra-home') };
    const fixture = original.slice(0, verify.body.pos) + `{ return ${JSON.stringify(state)} }` + original.slice(verify.body.end);
    fs.writeFileSync(path.join(root, 'lib/astra-readiness.ts'), fixture);
    const api = loadQualificationModule({ app: root }, 4511);
    const destination = path.join(root, '.astra-home/astra-readiness.json');
    assert.equal(fs.existsSync(destination), false);
    await api.publishAstraReadiness(await api.verifyAstraQualification(state.bundleRoot));
    const receipt = JSON.parse(fs.readFileSync(destination, 'utf8'));
    assert.equal(receipt.root, root); assert.equal(receipt.bundleRoot, state.bundleRoot);
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(destination)), ['astra-readiness.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('qualification module timeout covers synchronous initialization, not just wrapper creation', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'astra-module-timeout-')));
  try {
    fs.mkdirSync(path.join(root, 'lib')); fs.writeFileSync(path.join(root, 'lib/astra-readiness.ts'), 'while (true) {}');
    assert.throws(() => loadQualificationModule({ app: root }, 4511), /Script execution timed out/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('qualification inventory accepts only exact private bounded bundle and receipt files', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'astra-qualification-inventory-'))), app = path.join(root, 'app');
  fs.mkdirSync(app, { mode: 0o700 });
  const id = 'native-backend-test', rel = `.astra-home/qualifications/${id}`;
  try {
    writeNew(app, `${rel}/board.json`, '{}'); writeNew(app, `${rel}/qualification.json`, '{}');
    const api = { ASTRA_QUALIFICATION_FILES: { 'board.json': 4 } }, m = { app };
    const q = qualificationInventory(m, api, id); assert.equal(Object.keys(q.records).length, 2);
    writeNew(app, `${rel}/extra.json`, '{}'); assert.throws(() => qualificationInventory(m, api, id)); fs.unlinkSync(path.join(app, rel, 'extra.json'));
    fs.chmodSync(path.join(app, rel, 'board.json'), 0o644); assert.throws(() => qualificationInventory(m, api, id)); fs.chmodSync(path.join(app, rel, 'board.json'), 0o600);
    fs.writeFileSync(path.join(app, rel, 'board.json'), 'oversized'); assert.throws(() => qualificationInventory(m, api, id)); fs.writeFileSync(path.join(app, rel, 'board.json'), '{}');
    writeNew(app, '.astra-home/astra-readiness.json', '{}'); assert.equal(Object.keys(qualificationInventory(m, api, id, true).records).length, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('qualification allows exact KiCad underscore extensions but rejects unknown files and traversal', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'astra-kicad-inventory-')));
  const id = 'native-backend-test', rel = `.astra-home/qualifications/${id}`;
  try {
    for (const name of ['final-board.kicad_pcb', 'final-board.kicad_pro', 'qualification.json']) writeNew(root, `${rel}/${name}`, '{}');
    const api = { ASTRA_QUALIFICATION_FILES: { 'final-board.kicad_pcb': 64, 'final-board.kicad_pro': 64 } };
    assert.equal(Object.keys(qualificationInventory({ app: root }, api, id).records).length, 3);
    writeNew(root, `${rel}/unknown_file.json`, '{}');
    assert.throws(() => qualificationInventory({ app: root }, api, id), /exact reviewed inventory/);
    fs.unlinkSync(path.join(root, rel, 'unknown_file.json'));
    assert.throws(() => qualificationInventory({ app: root }, api, '../native-backend-test'), /Invalid qualification bundle ID/);
    assert.throws(() => qualificationInventory({ app: root }, { ASTRA_QUALIFICATION_FILES: { '../outside_file': 64 } }, id));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('qualification verification failure cannot publish and changed bundle cannot seal', async () => {
  const calls = [], capability = Object.freeze({}), records = { 'board.json': { sha256: 'a'.repeat(64), bytes: 5 } };
  const api = { verifyAstraQualification: async () => { calls.push('verify'); return capability; },
    publishAstraReadiness: async cap => { assert.equal(cap, capability); calls.push('publish'); },
    readAstraReadiness: async () => { calls.push('read'); return { ready: true }; } };
  await assert.rejects(verifyAndPublishQualification({ ...api, verifyAstraQualification: async () => { throw new Error('bad evidence'); } }, '/bundle', records, () => assert.fail('never inspect')));
  assert.deepEqual(calls, []);
  await assert.rejects(verifyAndPublishQualification(api, '/bundle', records, () => ({ records: { 'board.json': { sha256: 'b'.repeat(64), bytes: 5 } } })), /changed during publication/);
  assert.deepEqual(calls, ['verify', 'publish', 'read']);
  const result = await verifyAndPublishQualification(api, '/bundle', records, () => ({ records }));
  assert.equal(result.status.ready, true);
  const script = read('scripts/astra-local.mjs');
  assert.ok(script.indexOf("fail('Qualification seal file drift')") < script.indexOf('export async function launch(options)'));
  const launch = script.slice(script.indexOf('export async function launch(options)'));
  assert.ok(launch.indexOf('validateSnapshot(options.snapshot)') < launch.indexOf('withValidatorController('));
  assert.ok(launch.indexOf('qualification.api.readAstraReadiness()') < launch.indexOf('withValidatorController('));
  assert.match(script, /Source drift:/);
});
test('adapter argument only admits an explicit separate credential-free loopback origin', () => {
  for (const value of ['https://127.0.0.1:8800', 'http://localhost:8800', 'http://0.0.0.0:8800', 'http://example.com:8800',
    'http://user:pass@127.0.0.1:8800', 'http://127.0.0.1:8800/path', 'http://127.0.0.1:8800?key=secret', 'http://127.0.0.1:3100']) {
    assert.throws(() => parseArgs(['--serve', '/owned', '--port', '3100', '--proxy-url', value, ...adapterArgs]));
  }
  assert.throws(() => parseArgs(['--serve', '/owned', '--port', '3100', '--proxy-url', 'http://127.0.0.1:8800']));
  assert.equal(parseArgs(['--serve', '/owned', '--port', '3100', '--proxy-url', 'http://127.0.0.1:8800/', ...adapterArgs])['proxy-url'], 'http://127.0.0.1:8800');
});
test('adapter inspection is read-only and rejects wrappers, drift and symlinks', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'astra-adapter-unit-')));
  try {
    const file = path.join(root, 'native');
    const bytes = Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from('mock native header, never executed')]);
    fs.writeFileSync(file, bytes, { mode: 0o700 });
    assert.deepEqual(inspectAdapter(file, hash(bytes)), { cli: file, sha256: hash(bytes) });
    assert.throws(() => inspectAdapter(file, 'b'.repeat(64)));
    const wrapper = path.join(root, 'wrapper'); fs.writeFileSync(wrapper, '#!/bin/sh\nexit 0', { mode: 0o700 });
    assert.throws(() => inspectAdapter(wrapper, hash(fs.readFileSync(wrapper))));
    fs.symlinkSync(file, path.join(root, 'alias'));
    assert.throws(() => inspectAdapter(path.join(root, 'alias'), hash(bytes)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('clean environment cannot copy ambient accounts, secrets, providers or font mocks', () => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'must-not-inherit';
  try {
    const env = cleanEnv(snapshot, { mode: 'serve', port: 3100 }, secrets);
    assert.equal(env.HOME, '/owned/app-source/.astra-home');
    assert.equal(env.FL_ASTRA_ORIGIN, 'http://127.0.0.1:3100');
    assert.equal(env.FL_ADMIN_EMAILS, snapshot.testEmail);
    assert.equal(env.AUTH_SECRET, secrets.authSecret);
    assert.equal(env.WATCHPACK_POLLING, '1000');
    assert.equal(cleanEnv(snapshot, { mode: 'build' }, secrets).WATCHPACK_POLLING, undefined);
    assert.equal(env.OPENSSL_CONF, '/dev/null');
    assert.equal(env.OPENSSL_CONF_INCLUDE, undefined);
    assert.equal(env.OPENSSL_MODULES, undefined);
    assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_PROFILE', 'HTTP_PROXY', 'FL_PASSWORD', 'FL_ASTRA_CLI', 'FL_ASTRA_PROXY_URL', 'NEXT_FONT_GOOGLE_MOCKED_RESPONSES', 'VERCEL']) assert.equal(env[key], undefined, key);
    assert.equal(JSON.stringify(env).includes(secrets.password), false);
    assert.equal(cleanEnv(snapshot, { mode: 'build' }, secrets).FL_ASTRA_ORIGIN, undefined);
    assert.throws(() => cleanEnv(snapshot, { port: 3100 }, { authSecret: 'static-dev-secret' }));
  } finally { if (original === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = original; }
});
test('outer sandbox denies by default and admits only selected loopback endpoints', () => {
  const offline = sandboxProfile(snapshot, { mode: 'build' });
  assert.match(offline, /\(deny default\)/);
  assert.doesNotMatch(offline, /allow network/);
  const local = sandboxProfile(snapshot, { mode: 'serve', port: 3100, proxyUrl: 'http://127.0.0.1:8800' });
  assert.match(local, /network-bind network-inbound \(local ip "localhost:3100"\)/);
  assert.match(local, /network-outbound \(remote ip "localhost:3100"\) \(remote ip "localhost:8800"\)/);
  assert.doesNotMatch(local, /\(subpath "\/Users\/|\(allow network\*|0\.0\.0\.0|mach\*|ipc-posix\*|\(subpath "\/private\/var\/db"\)|\(subpath "\/dev"\)|\(subpath "\/runtime"\)/);
  assert.match(local, /file-write\* \(subpath "\/owned"\) \(literal "\/dev\/null"\)/);
  assert.match(local, /\(literal "\/opt\/homebrew\/opt\/llhttp\/lib\/libllhttp\.9\.3\.dylib"\)/);
  assert.doesNotMatch(local, /\(subpath "\/opt\/homebrew/);
  assert.match(local, /\(allow file-read-data[^\n]+\(literal "\/Applications\/KiCad\/KiCad\.app"\)/);
  assert.doesNotMatch(local, /\(subpath "\/Applications\/KiCad\/KiCad\.app"\)/);
  assert.match(read('scripts/astra-local.mjs'), /fs\.realpathSync\(directory\) !== directory \|\| !st\.isDirectory\(\) \|\| st\.isSymbolicLink\(\)/);
  assert.match(read('scripts/astra-local.mjs'), /fs\.realpathSync\(alias\) !== canonical/);
  assert.match(read('scripts/astra-local.mjs'), /fs\.readlinkSync\(link\) !== target/);
  assert.match(read('scripts/astra-local.mjs'), /st\.ino !== pin\.ino/);
  assert.match(local, /allow file-read-data \(literal "\/opt\/homebrew\/Cellar\/llhttp\/9\.3\.1\/lib"\)/);
  assert.match(local, /literal "\/opt\/homebrew\/Cellar\/llhttp\/9\.3\.1\/lib\/libllhttp\.9\.3\.dylib"/);
});
test('validator token exists only in serve env and socket permission is an exact external endpoint', () => {
  const validator = { socketPath: '/private/tmp/astra-v-ABC123/control.sock', authSecret: 'f'.repeat(64) };
  const env = cleanEnv(snapshot, { mode: 'serve', port: 3100, validator }, secrets);
  assert.equal(env.ASTRA_VALIDATOR_SOCKET, validator.socketPath);
  assert.equal(env.ASTRA_VALIDATOR_SECRET, validator.authSecret);
  const buildEnv = cleanEnv(snapshot, { mode: 'build', validator }, secrets);
  assert.equal(buildEnv.ASTRA_VALIDATOR_SOCKET, undefined); assert.equal(buildEnv.ASTRA_VALIDATOR_SECRET, undefined);
  const profile = sandboxProfile(snapshot, { mode: 'serve', port: 3100, validator });
  assert.match(profile, /\(allow network-outbound \(remote unix-socket \(literal "\/private\/tmp\/astra-v-ABC123\/control\.sock"\)\)\)/);
  assert.doesNotMatch(profile, /docker|\.docker|\(subpath "\/private\/tmp|f{64}/i);
  assert.doesNotMatch(sandboxProfile(snapshot, { mode: 'build', validator }), /unix-socket|astra-v-ABC123/);
});
test('validator lifecycle starts once only on serve, passes wrapper root and awaits verified close', async () => {
  const calls = []; let closeDone = false;
  const controller = { close: async () => { calls.push('close'); await Promise.resolve(); closeDone = true; return { cleanupConfirmed: true }; } };
  const options = { mode: 'serve', manifest: snapshot, start: async o => { assert.deepEqual(o, { launchRoot: snapshot.root }); calls.push('start'); return controller; },
    inspect: (m, c) => { assert.equal(m, snapshot); assert.equal(c, controller); calls.push('inspect'); },
    run: async c => { assert.equal(c, controller); calls.push('run'); return { code: 0 }; } };
  const outcome = await withValidatorController(options);
  assert.deepEqual(calls, ['start', 'inspect', 'run', 'close']); assert.equal(closeDone, true);
  assert.equal(outcome.cleanupConfirmed, true); assert.deepEqual(outcome.result, { code: 0 });
  calls.length = 0;
  await withValidatorController({ ...options, mode: 'build', run: async c => { assert.equal(c, undefined); calls.push('build'); } });
  assert.deepEqual(calls, ['build']);
});
test('validator lifecycle fails closed on invalid endpoint, app failure, unknown cleanup and startup abort', async () => {
  for (const failure of ['inspect', 'run', 'cleanup-false', 'cleanup-throws', 'abort']) {
    let runs = 0, closes = 0; const abort = new AbortController(); if (failure === 'abort') abort.abort();
    const result = await withValidatorController({ mode: 'serve', manifest: snapshot, signal: abort.signal,
      start: async () => ({ close: async () => { closes++; if (failure === 'cleanup-throws') throw new Error('private details'); return { cleanupConfirmed: failure !== 'cleanup-false' }; } }),
      inspect: () => { if (failure === 'inspect') throw new Error('private endpoint'); },
      run: async () => { runs++; if (failure === 'run') throw new Error('private process detail'); return { code: 0 }; } });
    assert.equal(closes, 1); assert.equal(runs, ['inspect', 'abort'].includes(failure) ? 0 : 1);
    assert.equal(result.cleanupConfirmed, !['cleanup-false', 'cleanup-throws'].includes(failure));
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
  const failedStart = await withValidatorController({ mode: 'serve', manifest: snapshot, start: async () => { throw new Error('secret'); }, run: async () => assert.fail('never run') });
  assert.equal(failedStart.failed, true); assert.equal(failedStart.cleanupConfirmed, false);
});
test('safe staging rejects traversal, symlinks, oversized files and overwrite', () => {
  for (const relative of ['../data/users.json', '.env', '/etc/passwd', 'a//b', 'app/../x', 'a\\b']) assert.throws(() => cleanRelative(relative));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'astra-launcher-unit-')));
  try {
    writeNew(root, 'app/file.ts', 'export const safe = true');
    assert.equal(safeRead(root, 'app/file.ts').toString(), 'export const safe = true');
    assert.throws(() => safeRead(root, 'app/file.ts', 1));
    assert.throws(() => writeNew(root, 'app/file.ts', 'overwrite'));
    fs.symlinkSync(path.join(root, 'app/file.ts'), path.join(root, 'link.ts'));
    assert.throws(() => safeRead(root, 'link.ts'));
    fs.symlinkSync(path.join(root, 'app'), path.join(root, 'linked'));
    assert.throws(() => writeNew(root, 'linked/new.ts', 'bad'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('source inventory extras are exact files, not broad tree copies', () => {
  assert.deepEqual(NATIVE_SCRIPTS, { native: 'scripts/astra-native.py', probe: 'scripts/astra-sandbox-probe.py' });
  assert.deepEqual(VALIDATOR_SCRIPTS, ['scripts/astra-validator-controller.mjs', 'scripts/astra-stage-validator.mjs', 'scripts/astra-linux-runtime.mjs', 'scripts/astra-linux-drc.mjs']);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'astra-inventory-unit-')));
  try {
    for (const dir of ['app', 'components', 'lib', 'scripts', 'public', 'data']) fs.mkdirSync(path.join(root, dir));
    for (const file of ['package.json', 'pnpm-lock.yaml', 'next.config.mjs', 'postcss.config.mjs', 'tsconfig.json', 'proxy.ts', 'instrumentation.ts']) writeNew(root, file, '{}');
    writeNew(root, 'app/page.tsx', 'real source'); writeNew(root, 'scripts/astra-native.py', '# exact script');
    writeNew(root, 'scripts/private.py', 'excluded'); writeNew(root, 'data/users.json', 'production users'); writeNew(root, 'public/secret.json', 'excluded');
    const files = inventory({ source: root, extraFiles: ['scripts/astra-native.py'] });
    assert.equal(files.has('scripts/astra-native.py'), true);
    for (const file of ['scripts/private.py', 'data/users.json', 'public/secret.json']) assert.equal(files.has(file), false);
    assert.throws(() => inventory({ source: root, extraFiles: ['scripts'] }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('beta uses actual system fonts, preserves ordinary Google fonts, skips bootstrap telemetry', () => {
  assert.match(read('lib/app-fonts.ts'), /from 'next\/font\/google'/);
  assert.match(read('lib/app-fonts-system.ts'), /system-ui/);
  assert.doesNotMatch(read('lib/app-fonts-system.ts'), /next\/font|fetch\(/);
  const config = read('next.config.mjs');
  assert.match(config, /FL_ASTRA_BETA === '1'/);
  assert.match(config, /alias\['firstlight-app-fonts\$'\]/);
  assert.match(read('instrumentation.ts'), /if \(process.env.FL_ASTRA_BETA === '1'\) return/);
  assert.match(read('app/layout.tsx'), /FL_ASTRA_BETA !== '1'.*PrivateAnalytics/);
});
test('real webpack resolver selects beta system module before Next tsconfig plugin', async () => {
  const require = createRequire(path.join(source, 'package.json'));
  const bundled = require('next/dist/compiled/webpack/webpack');
  const { JsConfigPathsPlugin } = require('next/dist/build/webpack/plugins/jsconfig-paths-plugin');
  const old = process.env.FL_ASTRA_BETA;
  try {
    for (const beta of [false, true]) {
      process.env.FL_ASTRA_BETA = beta ? '1' : '0';
      const { default: config } = await import(`${pathToFileURL(path.join(source, 'next.config.mjs')).href}?font-test=${beta}`);
      const compiler = bundled.webpack({ mode: 'none', context: source });
      const modified = config.webpack({ resolve: { alias: {} } });
      const resolver = compiler.resolverFactory.get('normal', { alias: modified.resolve.alias, extensions: ['.ts', '.tsx', '.js'],
        plugins: [new JsConfigPathsPlugin({ '@/*': ['./*'] }, { baseUrl: source, isImplicit: true })] });
      const resolved = await new Promise((resolve, reject) => resolver.resolve({}, path.join(source, 'app'), 'firstlight-app-fonts', {}, (error, file) => error ? reject(error) : resolve(file)));
      assert.equal(resolved, path.join(source, beta ? 'lib/app-fonts-system.ts' : 'lib/app-fonts.ts'));
      if (beta) assert.doesNotMatch(fs.readFileSync(resolved, 'utf8'), /next\/font\/google|fetch\(/);
      await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
    }
  } finally { if (old === undefined) delete process.env.FL_ASTRA_BETA; else process.env.FL_ASTRA_BETA = old; }
});
test('launcher stages the actual handlers and creates only a fresh isolated identity', () => {
  const script = read('scripts/astra-local.mjs');
  assert.match(script, /process\.chdir\(app\);[\s\S]*import\(pathToFileURL\(path\.join\(app, 'lib\/auth\.ts'\)\)/);
  assert.match(script, /createUser\(secrets\.email, secrets\.password\)/);
  assert.match(script, /randomBytes\(32\)/);
  assert.match(script, /'dev', '--webpack', '--hostname', '127\.0\.0\.1'/);
  assert.match(script, /'build', '--webpack'/);
  assert.doesNotMatch(script, /ux-preview|FONT_MOCK|NEXT_FONT_GOOGLE_MOCKED_RESPONSES|npm install|pnpm install/);
  assert.equal(hash('stable'), hash('stable'));
  assert.equal(SOURCE, source);
});
