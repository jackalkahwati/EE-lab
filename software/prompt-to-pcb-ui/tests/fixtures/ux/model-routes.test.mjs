import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactRequest } from './artifacts.mjs';
import { fixtureRequest } from './fixture-router.mjs';
import { pipelineRequest, pipelineSpec } from './pipeline-fixtures.mjs';

const origin = 'http://127.0.0.1:4510';
test('saved mechanical viewer fixtures expose only embedded synthetic geometry', async () => {
  for (const id of ['ux-model-a', 'ux-model-b']) {
    const saved = await artifactRequest(new Request(`${origin}/runs/${id}/mechanical/mechanical.json`)).json();
    assert.match(saved.part, /Synthetic.*not an enclosure design/);
    assert.equal(saved.fitCheck, null);
    assert.equal(saved.stepUrl, null);
    assert.equal(saved.gltfUrl, `/runs/${id}/mechanical/enclosure.glb`);
    const response = artifactRequest(new Request(origin + saved.gltfUrl));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'model/gltf-binary');
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x46546c67);
    assert.equal(artifactRequest(new Request(`${origin}/runs/${id}/mechanical/enclosure.step`)).status, 404);
    assert.equal(artifactRequest(new Request(origin + saved.gltfUrl, { method: 'POST' })).status, 404);
  }
  for (const id of ['ux-completed', 'ux-model-c', 'private-sentinel']) {
    assert.equal(artifactRequest(new Request(`${origin}/runs/${id}/mechanical/enclosure.glb`)).status, 404);
  }
});

test('model export fixture denies default, private, extra-query and mutating requests', async () => {
  const make = (query, scenario = 'model-a', method = 'GET') => new Request(`${origin}/api/board3d${query}`, { method, headers: { 'x-ux-scenario': scenario, origin } });
  for (const request of [make(''), make('?base=/runs/private-sentinel/board'), make('?base=/runs/ux-model-a/board&extra=1'), make('?base=/runs/ux-model-a/board', 'empty'), make('?base=/runs/ux-model-a/board', 'model-a', 'POST')]) {
    assert.equal((await fixtureRequest(request)).status, 403);
  }
  const response = await fixtureRequest(make('?base=/runs/ux-model-a/board'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
});

test('downstream scenarios delegate only bounded synthetic contracts', async () => {
  for (const scenario of ['pipeline-success', 'pipeline-error']) {
    const make = (path, method = 'GET', data) => new Request(origin + path, { method, headers: { 'x-ux-scenario': scenario, origin, 'content-type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const runs = await (await fixtureRequest(make('/api/runs'))).json();
    assert.deepEqual(runs.runs.map(run => run.id), ['ux-model-a', 'ux-model-b']);
    assert.equal((await fixtureRequest(make('/api/board3d?base=/runs/ux-model-a/board'))).status, 200);
    assert.equal((await fixtureRequest(make('/api/board3d?base=/runs/private-sentinel/board'))).status, 403);
    const result = await fixtureRequest(make('/api/electronics-cs', 'POST', { runId: 'ux-model-a', spec: pipelineSpec() }));
    assert.equal(result.status, 200);
    assert.equal((await result.json()).drc.available, false);
    assert.equal((await fixtureRequest(make('/api/electronics-cs', 'POST', { runId: 'private-sentinel', spec: pipelineSpec() }))).status, 403);
    const spec = await pipelineRequest(make('/runs/ux-model-a/product-spec.json'), scenario);
    assert.deepEqual(await spec.json(), pipelineSpec());
    assert.equal((await pipelineRequest(make('/runs/ux-model-a/timing.json'), scenario)).status, 404);
    assert.equal(await pipelineRequest(make('/runs/private-sentinel/product-spec.json'), scenario), null);
  }
});
