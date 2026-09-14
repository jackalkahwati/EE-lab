import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fixtureRequest } from './fixture-router.mjs';
const require = createRequire(import.meta.url);
// Importing the request policy must not launch Chrome or probe a server.
const { allowed } = require('../../../scripts/ux-astra-check.cjs');
const origin = 'http://127.0.0.1:4510';
const scenarios = ['empty', 'astra-blocked', 'astra-status-error'];
const blocker = 'Synthetic preflight blocker: native footprint/model verification is unavailable. No inference was called.';
const request = (path = '/api/astra', scenario, method = 'GET', headers = {}) => new Request(origin + path, {
  method, headers: { origin, ...(scenario ? { 'x-ux-scenario': scenario } : {}), ...headers },
});
async function denied(value) {
  const response = await fixtureRequest(value);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
  assert.equal((await response.json()).blocked, true);
}

test('Astra fixture defaults to exactly enabled:false with no provider readiness claim', async () => {
  for (const scenario of [undefined, 'empty', 'completed', 'unknown-sentinel']) {
    const response = await fixtureRequest(request('/api/astra', scenario));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { enabled: false });
  }
});

test('Astra blocked fixture declares exact synthetic scope, billing and native blocker', async () => {
  const response = await fixtureRequest(request('/api/astra', 'astra-blocked'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
  assert.deepEqual(await response.json(), {
    enabled: true, transport: 'astra-beta', model: 'gpt-6-astra', billing: 'Bedrock',
    scope: 'electronics-only', ready: false, blockers: [blocker],
  });
});

test('Astra unavailable fixture stays unavailable on read-only retries', async () => {
  for (let i = 0; i < 2; i++) {
    const response = await fixtureRequest(request('/api/astra', 'astra-status-error'));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
    assert.deepEqual(await response.json(), { error: 'Synthetic Astra status unavailable.' });
  }
});

test('Astra fixture accepts only exact query-free GET and blocks every Astra mutation', async () => {
  for (const scenario of scenarios) {
    for (const path of ['/api/astra?extra=1', '/api/astra?scenario=astra-blocked', '/api/astra?uxScenario=astra-blocked', '/api/astra?_rsc=abc', '/api/astra?extra=1&extra=2', '/api/astra/', '/api/astra/workflows', '/api/astra/workflows/synthetic/status', '/api/astra/workflows/synthetic/cancel']) {
      await denied(request(path, scenario));
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      for (const path of ['/api/astra', '/api/astra?extra=1', '/api/astra/workflows', '/api/astra/workflows/synthetic/cancel']) {
        await denied(request(path, scenario, method));
      }
    }
  }
  // A failed write never creates a workflow or changes the next status read.
  const response = await fixtureRequest(request('/api/astra'));
  assert.deepEqual(await response.json(), { enabled: false });
});

test('Astra fixture rejects foreign browser Origin headers before scenario selection', async () => {
  // fixtureRequest intentionally uses Origin: Next can rewrite its internal URL
  // host. The preview HTTP guard and browser harness separately pin target host.
  for (const scenario of scenarios) for (const foreign of ['https://foreign.invalid', 'http://localhost:4510', 'http://127.0.0.1:4511', 'null']) {
    for (const method of ['GET', 'POST']) await denied(request('/api/astra', scenario, method, { origin: foreign }));
  }
});

test('Astra browser policy allows only exact localhost GET reads and finite Compose scenarios', () => {
  for (const path of ['/api/auth/me', '/api/admin/me', '/api/runs', '/api/account/llm-key', '/api/astra']) {
    assert.equal(allowed(origin + path, 'GET'), true);
    assert.equal(allowed(origin + path + '?extra=1', 'GET'), false);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal(allowed(origin + path, method), false);
  }
  for (const path of ['/compose', '/compose?_rsc=abc_123', ...scenarios.flatMap(scenario => [`/compose?scenario=${scenario}`, `/compose?scenario=${scenario}&_rsc=abc_123`]), '/_next/static/chunks/app.js', '/favicon.ico', '/icon.svg']) {
    assert.equal(allowed(origin + path, 'GET'), true, path);
    assert.equal(allowed(origin + path, 'POST'), false, path);
  }
  for (const path of ['/compose?scenario=build-success', '/compose?scenario=', '/compose?scenario=empty&scenario=astra-blocked', '/compose?_rsc=one&_rsc=two', '/compose?extra=1', '/api/astra/workflows', '/api/pipeline/run?runId=synthetic', '/api/interview', '/api/architect', '/api/electronics-cs', '/__nextjs_original-stack-frames', '/api/ux-preview/status', '/api/ux-preview/snapshot', '/runs/private/board.kicad_pcb']) {
    assert.equal(allowed(origin + path, 'GET'), false, path);
    assert.equal(allowed(origin + path, 'POST'), false, path);
  }
  for (const url of ['https://foreign.invalid/api/astra', 'http://localhost:4510/api/astra', 'http://127.0.0.1:4511/api/astra', 'https://127.0.0.1:4510/api/astra', 'http://user:pass@127.0.0.1:4510/api/astra', 'not-a-url']) {
    assert.equal(allowed(url, 'GET'), false, url);
  }
});
