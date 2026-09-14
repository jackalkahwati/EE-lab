import test from 'node:test';
import assert from 'node:assert/strict';
import { pipelineRequest, pipelineSpec, pipelineScenarios, pipelineFixtureState, resetPipelineFixtures } from './pipeline-fixtures.mjs';
import { artifactRequest } from './artifacts.mjs';
import { runFullPipeline } from '../../../lib/run-pipeline.ts';
import { interruptWorkspacePipeline } from '../../../lib/workspace-state.ts';
const origin = 'http://127.0.0.1:4510';
const make = (path, data, options = {}) => new Request(origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', origin }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), ...options });
const data = () => ({ runId: 'ux-model-a', spec: pipelineSpec() });

test('pipeline fixture has exact finite scenarios, paths, origins and payloads', async () => {
  resetPipelineFixtures();
  assert.deepEqual(pipelineScenarios, ['pipeline-success', 'pipeline-error']);
  assert.equal(await pipelineRequest(make('/api/mechanical', data()), 'empty'), null);
  assert.equal(await pipelineRequest(make('/api/real-handler', data()), 'pipeline-success'), null);
  for (const request of [
    make('/api/mechanical'), make('/api/mechanical?extra=1', data()),
    make('/api/mechanical', { ...data(), runId: 'private-sentinel' }),
    make('/api/mechanical', { ...data(), extra: true }),
    make('/api/mechanical', { ...data(), keepCapabilities: true }),
    make('/api/simulate', { ...data(), keepCapabilities: false }),
    make('/api/mechanical', { ...data(), spec: { ...pipelineSpec(), product: 'Private sentinel' } }),
    make('/api/mechanical', data(), { headers: { origin: 'https://foreign.invalid', 'content-type': 'application/json' } }),
    make('/api/mechanical', undefined, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid' }),
    make('/api/mechanical', undefined, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...data(), overflow: 'x'.repeat(32769) }) }),
  ]) assert.equal((await pipelineRequest(request, 'pipeline-success')).status, 403);
  assert.equal(pipelineFixtureState('pipeline-success', 'ux-model-a').actions, 0);
});

test('stage currency reads require exact bounded queries and never claim reuse', async () => {
  resetPipelineFixtures();
  for (const id of ['ux-model-a', 'ux-model-b']) for (const stage of ['mechanical', 'simulation']) {
    const response = await pipelineRequest(make(`/api/runs/stage-hash?run=${id}&stage=${stage}`), 'pipeline-success');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enabled: false, current: false, reason: 'Synthetic fixture: no reusable engineering verification' });
  }
  for (const query of ['', '?run=private&stage=mechanical', '?run=ux-model-a&stage=electronics', '?run=ux-model-a', '?run=ux-model-a&stage=mechanical&extra=1', '?run=ux-model-a&run=ux-model-a&stage=mechanical', '?run=ux-model-a&stage=mechanical&stage=simulation']) {
    assert.equal((await pipelineRequest(make('/api/runs/stage-hash' + query), 'pipeline-success')).status, 403);
  }
  assert.equal(pipelineFixtureState('pipeline-success', 'ux-model-a').actions, 0);
});

test('completion bridges accept only run ID and share the sixteen action cap without creating products', async () => {
  resetPipelineFixtures();
  const scenario = 'pipeline-success', runId = 'ux-model-a';
  for (const route of ['/api/programs/sync', '/api/runs/work-items']) {
    for (const payload of [{ runId, extra: true }, { runId: 'private' }, {}]) assert.equal((await pipelineRequest(make(route, payload), scenario)).status, 403);
    assert.equal((await pipelineRequest(make(route + '?extra=1', { runId }), scenario)).status, 403);
    assert.equal((await pipelineRequest(make(route, { runId }), 'empty')), null);
  }
  const sync = await pipelineRequest(make('/api/programs/sync', { runId }), scenario);
  assert.equal(sync.status, 200);
  assert.deepEqual(await sync.json(), { synced: false, reason: 'Synthetic UI fixture; no enterprise product or board created' });
  const queue = await pipelineRequest(make('/api/runs/work-items', { runId }), scenario);
  assert.equal(queue.status, 200);
  assert.deepEqual(await queue.json(), { runId, items: [] }); // Not a verification verdict.
  for (let i = 0; i < 14; i++) assert.equal((await pipelineRequest(make('/api/runs/stage-hash', { runId, stage: 'mechanical', status: 'failed' }), scenario)).status, 200);
  for (const route of ['/api/programs/sync', '/api/runs/work-items']) assert.equal((await pipelineRequest(make(route, { runId }), scenario)).status, 429);
  assert.equal(pipelineFixtureState(scenario, runId).actions, 16);
});

test('simulation persists only its completed synthetic response with isolated GET and HEAD reads', async () => {
  resetPipelineFixtures();
  const scenario = 'pipeline-success', path = '/runs/ux-model-a/disciplines/simulation.json';
  assert.equal((await pipelineRequest(make(path), scenario)).status, 404);
  assert.equal((await pipelineRequest(make(path, undefined, { method: 'HEAD' }), scenario)).status, 404);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(pipelineRequest(make('/api/simulate', data(), { signal: controller.signal }), scenario), { name: 'AbortError' });
  assert.equal((await pipelineRequest(make(path), scenario)).status, 404);
  const pending = pipelineRequest(make('/api/simulate', data()), scenario);
  assert.equal((await pipelineRequest(make(path), scenario)).status, 404);
  const response = await pending;
  assert.deepEqual(await (await pipelineRequest(make(path), scenario)).json(), await response.json());
  const head = await pipelineRequest(make(path, undefined, { method: 'HEAD' }), scenario);
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await pipelineRequest(make(path), 'pipeline-error')).status, 404);
  assert.equal((await pipelineRequest(make(path.replace('ux-model-a', 'ux-model-b')), scenario)).status, 404);
  assert.equal((await pipelineRequest(make(path + '?extra=1'), scenario)).status, 403);
  assert.equal((await pipelineRequest(make(path, {}), scenario)).status, 403);
});

test('successful synthetic APIs never manufacture DRC, fit or simulation evidence', async () => {
  resetPipelineFixtures();
  for (const path of ['/api/electronics-cs', '/api/mechanical', '/api/simulate']) {
    const response = await pipelineRequest(make(path, data()), 'pipeline-success');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
    const value = await response.json();
    if (path.endsWith('electronics-cs')) assert.equal(value.drc.available, false);
    if (path.endsWith('mechanical')) { assert.equal(value.fitCheck, null); assert.equal(value.stepUrl, null); assert.match(value.part, /not an enclosure design/); }
    if (path.endsWith('simulate')) { assert.deepEqual(value.results, []); assert.match(value.assessment.gaps[0], /No physical analysis executed/); }
  }
  const error = await pipelineRequest(make('/api/mechanical', data()), 'pipeline-error');
  assert.equal(error.status, 422); assert.match((await error.json()).error, /Synthetic.*rejected/);
});

test('timing preserves exact unfinished attempts and missing timing stays unavailable', async () => {
  resetPipelineFixtures();
  const url = '/runs/ux-model-a/timing.json';
  assert.equal((await pipelineRequest(make(url), 'pipeline-success')).status, 404);
  const timing = { runId: 'ux-model-a', startedAt: '2026-09-13T00:00:00Z', finishedAt: '2026-09-13T00:00:01Z', totalMs: 1000, stages: [{ stage: 'mechanical', status: 'running', startedAt: '2026-09-13T00:00:00Z', unfinished: true }] };
  assert.equal((await pipelineRequest(make('/api/runs/timing', timing), 'pipeline-success')).status, 200);
  assert.deepEqual(await (await pipelineRequest(make(url), 'pipeline-success')).json(), timing);
  const invalid = { ...timing, stages: [{ ...timing.stages[0], status: 'guaranteed' }] };
  assert.equal((await pipelineRequest(make('/api/runs/timing', invalid), 'pipeline-success')).status, 403);
  assert.deepEqual(await (await pipelineRequest(make(url), 'pipeline-success')).json(), timing);
});

test('manual prerequisite reads and durable failure do not rewrite an earlier history response', async () => {
  resetPipelineFixtures();
  const scenario = 'pipeline-error', runId = 'ux-model-b', path = `/runs/${runId}/timing.json`;
  const initialHistory = await pipelineRequest(make(path), scenario);
  assert.equal(initialHistory.status, 404);
  assert.equal((await pipelineRequest(make(path), scenario)).status, 404);
  const startedAt = '2026-09-13T00:00:00Z';
  const running = { runId, startedAt, stages: [{ stage: 'mechanical', status: 'running', startedAt, unfinished: true }] };
  assert.equal((await pipelineRequest(make('/api/runs/timing', running), scenario)).status, 200);
  assert.deepEqual(await (await pipelineRequest(make(path), scenario)).json(), running);
  const generation = await pipelineRequest(make('/api/mechanical', { runId, spec: pipelineSpec() }), scenario);
  assert.equal(generation.status, 422);
  assert.equal(initialHistory.status, 404);
  assert.match((await initialHistory.json()).error, /No synthetic timing recorded/);
  const failed = { ...running, finishedAt: '2026-09-13T00:00:01Z', totalMs: 1000, stages: [{ stage: 'mechanical', status: 'failed', startedAt, endedAt: '2026-09-13T00:00:01Z', ms: 1000, unfinished: false, detail: 'Synthetic enclosure request rejected. No native work executed.' }] };
  assert.equal((await pipelineRequest(make('/api/runs/timing', failed), scenario)).status, 200);
  assert.deepEqual(await (await pipelineRequest(make(path), scenario)).json(), failed);
  assert.equal(pipelineFixtureState(scenario, runId).actions, 3);
  const unknown = { ...failed, stages: [{ ...failed.stages[0], status: 'unknown' }] };
  assert.equal((await pipelineRequest(make('/api/runs/timing', unknown), scenario)).status, 403);
  assert.equal(pipelineFixtureState(scenario, runId).actions, 3);
});

test('accepted POST budget is atomic and bounded at sixteen per scenario/run', async () => {
  resetPipelineFixtures();
  const payload = { runId: 'ux-model-a', stage: 'mechanical', status: 'passed' };
  const responses = await Promise.all(Array.from({ length: 18 }, () => pipelineRequest(make('/api/runs/stage-hash', payload), 'pipeline-success')));
  assert.equal(responses.filter(r => r.status === 200).length, 16);
  assert.equal(responses.filter(r => r.status === 429).length, 2);
  assert.equal(pipelineFixtureState('pipeline-success', 'ux-model-a').actions, 16);
  assert.equal(pipelineFixtureState('pipeline-error', 'ux-model-a').actions, 0);
});

async function withPipeline(scenario, callback) {
  resetPipelineFixtures();
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, options) => {
    const request = new Request(new URL(input, origin), options);
    const response = await pipelineRequest(request, scenario) ?? artifactRequest(request);
    requests.push({ path: new URL(request.url).pathname, status: response.status, method: request.method });
    return response;
  };
  try { await callback(requests); } finally { globalThis.fetch = original; }
}

test('actual sequencer enters downstream stages yet retains unverified/failure verdicts', async () => {
  await withPipeline('pipeline-success', async requests => {
    const events = [];
    const result = await runFullPipeline({ spec: pipelineSpec(), runId: 'ux-model-a', dirtyOnly: true, onStage: event => events.push(event) });
    assert.equal(result.stages.electronics.status, 'failed');
    assert.match(result.stages.electronics.detail, /UNVERIFIED/);
    assert.equal(result.stages.mechanical.status, 'passed');
    assert.match(result.stages.mechanical.detail, /fit check not run/);
    assert.equal(result.stages.simulation.status, 'failed');
    assert.match(result.stages.simulation.detail, /could not run/);
    for (const stage of ['firmware', 'manufacturing', 'supplyChain', 'validation']) assert.equal(result.stages[stage].status, 'skipped');
    for (const stage of ['electronics', 'mechanical', 'simulation']) assert.ok(events.some(e => e.stage === stage && e.status === 'running'));
    assert.equal(requests.filter(r => r.path === '/api/runs/stage-hash' && r.method === 'GET' && r.status === 200).length, 2);
    // Compose performs these completion effects outside runFullPipeline.
    for (const route of ['/api/programs/sync', '/api/runs/work-items']) {
      const response = await globalThis.fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'ux-model-a' }) });
      assert.equal(response.status, 200);
    }
    assert.equal(requests.filter(r => r.status === 429).length, 0);
    assert.ok(pipelineFixtureState('pipeline-success', 'ux-model-a').actions <= 16);
    assert.ok(pipelineFixtureState('pipeline-success', 'ux-model-a').timing.finishedAt);
  });
});

test('stopping actual sequencing leaves client outcome unknown and submits no next physical stage', async () => {
  await withPipeline('pipeline-success', async requests => {
    const controller = new AbortController();
    let live = {};
    await runFullPipeline({ spec: pipelineSpec(), runId: 'ux-model-a', signal: controller.signal, onStage: event => {
      // Matches the workspace's no-late-callback guard once observation stops.
      if (controller.signal.aborted) return;
      live = { ...live, [event.stage]: { status: event.status, detail: event.detail } };
      if (event.stage === 'mechanical' && event.status === 'running') {
        controller.abort();
        live = interruptWorkspacePipeline(live);
      }
    } });
    assert.equal(live.mechanical.status, 'unknown');
    assert.match(live.mechanical.detail, /Server outcome is unknown/);
    assert.equal(requests.filter(r => r.path === '/api/simulate').length, 0);
    assert.equal(requests.filter(r => r.status === 429).length, 0);
    assert.ok(pipelineFixtureState('pipeline-success', 'ux-model-a').timing.finishedAt);
  });
});
