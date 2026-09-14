import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fixtureRequest, buildStream } from './fixture-router.mjs';
import { artifactRequest } from './artifacts.mjs';

const request = (path, method = 'GET', headers = {}) => new Request(`http://127.0.0.1:4510${path}`, { method, headers });
test('auth matches real user/models/packs envelope using synthetic identity', async () => {
  const auth = await (await fixtureRequest(request('/api/auth/me'))).json();
  assert.equal(auth.user.email, 'preview@example.invalid');
  assert.equal(auth.user.plan, 'pro');
  assert.ok(Array.isArray(auth.models)); assert.ok(Array.isArray(auth.packs));
});
test('unknown, mutation-bearing GETs and mutations fail closed', async () => {
  for (const path of ['/api/pipeline/run', '/api/product-state', '/api/scorecard', '/api/board3d', '/api/cad-export', '/api/sourcing', '/api/runs?rebuild=1', '/api/not-real']) {
    assert.equal((await fixtureRequest(request(path))).status, 403, path);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal((await fixtureRequest(request('/api/runs', method))).status, 403);
});
test('default is empty and scenario data never uses nonfixture run IDs', async () => {
  assert.deepEqual(await (await fixtureRequest(request('/api/runs'))).json(), { runs: [] });
  const data = await (await fixtureRequest(request('/api/runs', 'GET', { 'x-ux-scenario': 'completed' }))).json();
  assert.equal(data.runs[0].runDir, '/runs/ux-completed');
  assert.equal((await fixtureRequest(request('/api/runs', 'GET', { origin: 'https://foreign.invalid' }))).status, 403);
});
test('browser origin remains exact when Next rewrites the internal request URL', async () => {
  for (const origin of ['http://127.0.0.1:4510', 'https://foreign.invalid', 'http://localhost:4510', 'null']) {
    const req = new Request('http://localhost:4510/api/architect', { method: 'POST', headers: { origin } });
    const response = await fixtureRequest(req);
    assert.equal(response.status, origin === 'http://127.0.0.1:4510' ? 200 : 403);
  }
});
test('only explicit synthetic artifact names are served; HEAD agrees', async () => {
  for (const method of ['GET', 'HEAD']) {
    assert.equal(artifactRequest(request('/runs/ux-completed/data/board.json', method)).status, 200);
    assert.equal(artifactRequest(request('/runs/ux-missing/data/board.json', method)).status, 404);
    assert.equal(artifactRequest(request('/runs/real-run/data/board.json', method)).status, 404);
  }
  assert.equal(artifactRequest(request('/runs/ux-completed/product-state.json')).status, 404);
  assert.match(await artifactRequest(request('/runs/ux-completed/board/render-top.png')).text(), /SYNTHETIC/);
});
test('raw DRC and distinct luminance masks match viewer contracts', async () => {
  const drc = await artifactRequest(request('/runs/ux-completed/data/drc.json')).json();
  const summary = await artifactRequest(request('/runs/ux-completed/data/board.json')).json();
  assert.ok(Array.isArray(drc.violations));
  assert.equal(typeof summary.drc.violations, 'number');
  const top = await artifactRequest(request('/runs/ux-completed/board/F.Cu.svg')).text();
  const bottom = await artifactRequest(request('/runs/ux-completed/board/B.Cu.svg')).text();
  assert.notEqual(top, bottom);
  assert.match(top, /fill="none" stroke="white"/);
  assert.match(top, /viewBox="0 0 960 640"/);
  assert.doesNotMatch(top, /SYNTHETIC BOARD|fill="#/);
});
test('architect requires explicit finish and force interview returns real spec shape', async () => {
  const post = (path, body) => fixtureRequest(new Request(`http://127.0.0.1:4510${path}`, { method: 'POST', headers: { 'x-ux-scenario': 'build-success' }, body: JSON.stringify(body) }));
  assert.equal((await (await post('/api/architect', { request: 'Sensor', answers: [] })).json()).type, 'question');
  const spec = await (await post('/api/architect', { answers: [{ answer: 'finish' }] })).json();
  assert.equal(spec.type, 'spec'); assert.equal(spec.spec.disciplines.electronics.status, 'defined');
  assert.equal((await (await post('/api/interview', { force: true })).json()).type, 'spec');
});
test('synthetic SSE success and error have delayed events, registered artifacts, and no reconnect replay', async () => {
  for (const scenario of ['build-success', 'build-error']) {
    const id = `run-${crypto.randomUUID()}`;
    const req = request(`/api/pipeline/run?runId=${id}`);
    const response = buildStream(req, scenario, 2);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const events = (await response.text()).trim().split('\n\n').map(line => JSON.parse(line.slice(6)));
    assert.equal(events.length, 5);
    assert.equal(events.at(-1).type, scenario === 'build-success' ? 'done' : 'error');
    assert.equal(artifactRequest(request(`/runs/${id}/data/board.json`)).status, 200);
    assert.equal(buildStream(req, scenario, 2).status, 409);
  }
  assert.equal(buildStream(request('/api/pipeline/run?runId=real-store'), 'build-success').status, 403);
});
test('preloaded HTTP boundary blocks devtools, image optimizer, cross-host, and non-HMR upgrades', () => {
  class Server { emit() { return 'forwarded'; } }
  vm.runInNewContext(fs.readFileSync(new URL('./server-guard.cjs', import.meta.url), 'utf8'), { require: () => ({ Server }), URL });
  const server = new Server();
  function run(path, headers = {}, upgrade = false) {
    let blocked = false;
    server.emit(upgrade ? 'upgrade' : 'request', { url: path, headers: { host: '127.0.0.1:4510', ...headers } }, { writeHead() { blocked = true; }, end() {}, destroy() { blocked = true; } });
    return blocked;
  }
  for (const p of ['/__nextjs_launch-editor?file=/etc/hosts', '/__nextjs_original-stack-frames', '/_next/image?url=https://foreign.invalid', '/data/board.json', '/.env']) assert.equal(run(p), true, p);
  assert.equal(run('/compose'), false);
  for (const p of ['/start', '/enterprise', '/enterprise/catalog', '/enterprise/iam', '/enterprise/validation']) assert.equal(run(p), false, p);
  for (const p of ['/enterprise/unknown', '/enterprise/iam/export', '/enterprise/%2e%2e/secret']) assert.equal(run(p), true, p);
  assert.equal(run('/api/auth/me'), false);
  assert.equal(run('/compose', { host: 'foreign.invalid:4510' }), true);
  assert.equal(run('/api/runs', { origin: 'https://foreign.invalid' }), true);
  assert.equal(run('/_next/webpack-hmr', {}, true), false);
  assert.equal(run('/shell', {}, true), true);
});
