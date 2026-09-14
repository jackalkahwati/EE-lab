import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureRequest, buildStream } from './fixture-router.mjs';
import { artifactRequest, fixtureTree, buildRuns, fixtureRunId } from './artifacts.mjs';

// In-process synthetic modules only. No server, browser, private run store or providers.
const origin = 'http://127.0.0.1:4510';
const onshape = 'https://cad.onshape.com/documents/synthetic/w/preview/e/assembly';
const marker = 'SYNTHETIC UI FIXTURE\nHand-authored import demonstration, not a KiCad board.\n';
const request = (path, options = {}, scenario = 'empty') => new Request(origin + path, {
  ...options, headers: { origin, 'x-ux-scenario': scenario, ...options.headers },
});
const read = path => fixtureRequest(request(path));
const ok = async response => {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
};
const fileBody = (name = 'synthetic-board.kicad_pcb', content = marker) => {
  const body = new FormData();
  body.append('pcb', new Blob([content], { type: 'application/octet-stream' }), name);
  body.append('name', 'Synthetic imported design');
  return body;
};
const importFile = async (scenario, body = fileBody()) => {
  // Materialize the tiny fixture multipart body before testing early denials.
  // Node's FormData encoder otherwise keeps producing an unread request stream.
  const encoded = request('/api/pipeline/import', { method: 'POST', body }, scenario);
  const bytes = await encoded.arrayBuffer();
  return fixtureRequest(request('/api/pipeline/import', { method: 'POST', headers: Object.fromEntries(encoded.headers), body: bytes }, scenario));
};
const importOnshape = (scenario, url = onshape) => fixtureRequest(request('/api/pipeline/import-onshape', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, name: 'Synthetic imported design' }),
}, scenario));
const leaves = nodes => nodes.flatMap(node => node.dir ? leaves(node.children) : [node]);

test('Files tree binds identity, counts recursive leaves, and serves all preview types', async () => {
  for (const id of ['ux-completed', 'ux-partial']) {
    const tree = await ok(await read(`/api/runs/files?run=${id}`));
    assert.equal(tree.runId, id);
    assert.deepEqual(tree, fixtureTree(id));
    const files = leaves(tree.tree);
    assert.equal(tree.files, files.length);
    assert.deepEqual(files.map(file => file.path).sort(), ['README.md', 'notes.txt', 'data/board.json', 'data/parts.csv', 'fabrication.zip', 'board/render-top.png'].sort());
    for (const file of files) {
      assert.equal(file.dir, false);
      assert.ok(Number.isSafeInteger(file.size) && file.size >= 0);
      assert.equal(file.name, file.path.split('/').at(-1));
      const response = artifactRequest(request(`/runs/${id}/${file.path}`));
      assert.equal(response.status, 200, file.path);
      assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
      const head = artifactRequest(request(`/runs/${id}/${file.path}`, { method: 'HEAD' }));
      assert.equal(head.status, response.status);
      assert.equal(head.headers.get('content-type'), response.headers.get('content-type'));
      assert.equal(await head.text(), '');
    }
    assert.match(await artifactRequest(request(`/runs/${id}/README.md`)).text(), new RegExp(`# Synthetic design ${id}`));
    assert.equal(await artifactRequest(request(`/runs/${id}/notes.txt`)).text(), `Synthetic notes belonging only to ${id}.`);
    assert.match(await artifactRequest(request(`/runs/${id}/data/parts.csv`)).text(), /Reference,Description\nU1,Synthetic sensor/);
    const board = await artifactRequest(request(`/runs/${id}/data/board.json`)).json();
    assert.equal(board.components, id === 'ux-partial' ? 12 : 8);
    const image = artifactRequest(request(`/runs/${id}/board/render-top.png`));
    assert.equal(image.headers.get('content-type'), 'image/svg+xml');
    assert.match(await image.text(), /SYNTHETIC BOARD/);
    const binary = artifactRequest(request(`/runs/${id}/fabrication.zip`));
    assert.equal(binary.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual([...new Uint8Array(await binary.arrayBuffer())], [80, 75, 5, 6]);
  }
});

test('unknown and private-looking IDs never authorize tree or artifact reads', async () => {
  // Invented sentinels, not IDs discovered from any private run store.
  for (const id of ['', 'private-run-sentinel', 'ux-completed-extra', `run-${crypto.randomUUID()}`, '../private', 'ux-completed/../../private']) {
    assert.equal(fixtureRunId(id), false);
    assert.equal(fixtureTree(id), null);
    assert.equal((await read(`/api/runs/files?run=${encodeURIComponent(id)}`)).status, 403);
    assert.equal(artifactRequest(request(`/runs/${encodeURIComponent(id)}/README.md`)).status, 404);
  }
  for (const path of ['/api/runs/files', '/api/runs/files?run=ux-completed&private=1']) assert.equal((await read(path)).status, 403);
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) assert.equal((await fixtureRequest(request('/api/runs/files?run=ux-completed', { method }))).status, 403);
  assert.equal((await fixtureRequest(request('/api/runs/files?run=ux-completed', { headers: { origin: 'https://foreign.invalid' } }))).status, 403);
  assert.equal(artifactRequest(request('/runs/ux-completed/private.txt')).status, 404);
});

test('successful file and Onshape imports register only fresh synthetic run identities', async () => {
  const ids = [];
  for (const response of [await importFile('import-success'), await importOnshape('import-success')]) {
    const result = await ok(response);
    assert.equal(result.preview, true);
    assert.match(result.runId, /^run-[a-f0-9-]{36}$/);
    assert.equal(result.name, 'Synthetic imported design');
    assert.equal(fixtureRunId(result.runId), true);
    const tree = await ok(await read(`/api/runs/files?run=${result.runId}`));
    assert.equal(tree.runId, result.runId);
    const base = `/runs/${result.runId}`;
    assert.equal(artifactRequest(request(`${base}/data/board.json`)).status, 200);
    assert.equal(artifactRequest(request(`${base}/timing.json`)).status, 404, 'Imports never invent a passed attempt');
    assert.equal(artifactRequest(request(`${base}/data/drc.json`)).status, 404);
    assert.equal(artifactRequest(request(`${base}/board/render-top.png`)).status, 404);
    const spec = await artifactRequest(request(`${base}/product-spec.json`)).json();
    assert.equal(spec.source, 'import'); assert.equal(spec.imported, true);
    const artifact = result.imported.pcb ? 'electronics/chipscale-board.json' : 'mechanical/mechanical.json';
    const saved = await artifactRequest(request(`${base}/${artifact}`)).json();
    assert.equal(saved.imported, true);
    assert.equal(saved.manualImport.kind, result.imported.pcb ? 'pcb' : 'step');
    if (result.imported.pcb) { assert.deepEqual(saved.boardMm, [40, 30]); assert.equal(saved.drc, null); }
    else { assert.equal(saved.part, undefined); assert.equal(saved.fitCheck, null); }
    assert.equal(tree.files, leaves(tree.tree).length);
    for (const file of leaves(tree.tree)) assert.equal(artifactRequest(request(`${base}/${file.path}`)).status, 200);
    ids.push(result.runId);
  }
  assert.notEqual(ids[0], ids[1]);
});

test('import errors and malformed success lack run IDs and do not register runs', async () => {
  for (const perform of [importFile, importOnshape]) {
    for (const scenario of ['import-error', 'import-malformed']) {
      const before = buildRuns().map(run => run.id);
      const response = await perform(scenario);
      assert.equal(response.status, scenario === 'import-error' ? 422 : 200);
      const body = await response.json();
      assert.equal(body.runId, undefined);
      if (scenario === 'import-error') assert.match(body.error, /Synthetic import rejected.*Keep your input/);
      else assert.deepEqual(body, { ok: true });
      assert.deepEqual(buildRuns().map(run => run.id), before);
    }
  }
});

test('import success rejects nonfixture payloads, off-scenario calls and oversize input', async () => {
  const before = buildRuns().map(run => run.id);
  for (const body of [fileBody('private-sentinel.kicad_pcb'), fileBody('synthetic-board.kicad_pcb', 'not a fixture'), new FormData()]) {
    assert.equal((await importFile('import-success', body)).status, 403);
  }
  for (const url of ['https://cad.onshape.com/documents/private-sentinel/w/preview/e/assembly', `${onshape}?extra=1`, 'https://foreign.invalid/documents/synthetic/w/preview/e/assembly']) {
    assert.equal((await importOnshape('import-success', url)).status, 403);
  }
  for (const scenario of ['empty', 'completed', 'import-success-extra']) {
    assert.equal((await importFile(scenario)).status, 403);
    assert.equal((await importOnshape(scenario)).status, 403);
  }
  assert.equal((await importFile('import-success', fileBody('synthetic-board.kicad_pcb', marker + 'x'.repeat(32769)))).status, 413);
  assert.deepEqual(buildRuns().map(run => run.id), before);
});

test('malformed SSE and server disconnect end observation without asserting server failure', async () => {
  for (const scenario of ['build-malformed', 'build-disconnect']) {
    const id = `run-${crypto.randomUUID()}`;
    const req = request(`/api/pipeline/run?runId=${id}`);
    const response = buildStream(req, scenario, 2);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
    const frames = (await response.text()).trim().split('\n\n').map(frame => frame.slice(6));
    const valid = frames.slice(0, 4).map(frame => JSON.parse(frame));
    assert.deepEqual(valid.map(event => event.type), ['stage', 'log', 'stage', 'stage']);
    assert.deepEqual(valid.at(-1), { type: 'stage', id: 'placement', state: 'running' });
    assert.equal(valid.some(event => ['done', 'error'].includes(event.type)), false);
    assert.equal(frames.length, scenario === 'build-malformed' ? 5 : 4);
    if (scenario === 'build-malformed') assert.throws(() => JSON.parse(frames[4]), SyntaxError);
    const run = buildRuns().find(run => run.id === id);
    const timing = await artifactRequest(request(`/runs/${id}/timing.json`)).json();
    assert.equal(timing.finishedAt, undefined);
    assert.equal(timing.stages[0].status, 'running');
    assert.ok(timing.stages.every(stage => stage.unfinished && stage.status !== 'passed'));
    assert.equal(run.status, 'RUNNING', 'The fixture must not invent a terminal server result');
    assert.equal(run.failure, undefined);
    assert.equal(buildStream(req, scenario, 2).status, 409, 'Reconnect must not restart this synthetic build');
  }
});

test('explicit success/error remain distinct from aborting synthetic observation', async () => {
  for (const scenario of ['build-success', 'build-error']) {
    const id = `run-${crypto.randomUUID()}`;
    const response = buildStream(request(`/api/pipeline/run?runId=${id}`), scenario, 2);
    const events = (await response.text()).trim().split('\n\n').map(frame => JSON.parse(frame.slice(6)));
    assert.equal(events.length, 5);
    assert.equal(events.at(-1).type, scenario === 'build-success' ? 'done' : 'error');
    assert.equal(buildRuns().find(run => run.id === id).status, scenario === 'build-success' ? 'PASSED' : 'GATE FAILED');
  }
  const id = `run-${crypto.randomUUID()}`;
  const controller = new AbortController();
  const response = buildStream(request(`/api/pipeline/run?runId=${id}`, { signal: controller.signal }), 'build-success', 1000);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  controller.abort();
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
  assert.equal(buildRuns().find(run => run.id === id).status, 'RUNNING');
});
