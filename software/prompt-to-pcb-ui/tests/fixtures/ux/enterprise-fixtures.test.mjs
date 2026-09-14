import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { enterpriseRequest, enterpriseScenarios, resetEnterpriseFixtures, syntheticCredentials, catalogFixturePath } from './enterprise-fixtures.mjs';

const origin = 'http://127.0.0.1:4510';
const actor = 'preview@example.invalid';
const member = 'synthetic-member@example.invalid';
const request = (path = '/api/enterprise', method = 'GET', body, headers = {}) => new Request(origin + path, {
  method, headers: { origin, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const read = (scenario = 'enterprise-actions', headers = {}) => enterpriseRequest(request('/api/enterprise', 'GET', undefined, headers), scenario);
const action = (name, params, scenario = 'enterprise-actions') => enterpriseRequest(request('/api/enterprise', 'POST', { action: name, params }), scenario);
const key = (method = 'GET', body, scenario = 'provider-empty', headers = {}) => enterpriseRequest(request('/api/account/llm-key', method, body, headers), scenario);
const ok = async response => { assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
beforeEach(() => resetEnterpriseFixtures());

test('exact finite scenarios and owned namespaces fail closed', async () => {
  assert.equal(new Set(enterpriseScenarios).size, enterpriseScenarios.length);
  assert.ok(Object.isFrozen(enterpriseScenarios));
  for (const scenario of ['', undefined, 'empty', 'enterprise', 'enterprise-actions-extra', 'provider-empty-extra']) {
    assert.equal((await read(scenario)).status, scenario === undefined ? 200 : 403);
  }
  assert.equal((await enterpriseRequest(request(), undefined)).status, 403);
  for (const path of ['/api/enterprise/unknown', '/api/enterprise/evidence-pack?board_id=ux-board-review', '/api/account/llm-key/unknown']) {
    const response = await enterpriseRequest(request(path), 'enterprise-actions');
    assert.equal(response.status, 403); assert.equal((await response.json()).blocked, true);
  }
  for (const path of ['/api/runs', '/api/auth/me', '/api/evidence-upload', '/api/cad-export', '/api/enterprises', '/compose']) {
    assert.equal(await enterpriseRequest(request(path), 'enterprise-actions'), null);
  }
  assert.equal((await enterpriseRequest(request('/api/enterprise?private=1'), 'enterprise-populated')).status, 403);
  assert.equal((await enterpriseRequest(request('/api/enterprise', 'GET', undefined, { origin: 'https://example.invalid' }), 'enterprise-populated')).status, 403);
  for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) assert.equal((await enterpriseRequest(request('/api/enterprise', method), 'enterprise-actions')).status, 403);
});

test('populated and empty GET contracts include all arrays and honest physical state', async () => {
  const response = await read('enterprise-populated');
  assert.equal(response.headers.get('x-ui-preview'), 'synthetic-only');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const populated = await ok(response);
  const empty = await ok(await read('enterprise-empty'));
  for (const name of ['organizations', 'workspaces', 'programs', 'boards', 'runs', 'evidence', 'approvals', 'usage', 'pilots', 'quotes', 'fl1_assets', 'validation_sessions', 'members', 'audit_tail']) {
    assert.ok(Array.isArray(populated[name]), name); assert.deepEqual(empty[name], [], name);
  }
  assert.equal(populated.organizations[0].security_settings.demo, true);
  assert.equal(populated.programs[0].board_list.length, populated.boards.length);
  assert.equal(populated.rbac.roles.length, 10);
  assert.equal(populated.rbac.permissions.length, 22);
  assert.deepEqual(populated.rbac.role_permissions.viewer, []);
  assert.equal(populated.audit_chain.ok, true);
  assert.ok(populated.boards.every(board => board.physical_evidence_state === 'none' && board.production_readiness_state !== 'production_ready'));
  assert.ok(populated.runs.every(run => run.source_run_dir === null));
  assert.deepEqual(populated.evidence, []);
  populated.boards[0].name = 'consumer mutation';
  assert.equal((await ok(await read('enterprise-populated'))).boards[0].name, 'Synthetic Review Board');
});

test('auth, membership, errors and explicit retry keep distinct HTTP contracts', async () => {
  for (const [scenario, status, message] of [
    ['enterprise-auth', 401, /sign in required/], ['enterprise-membership', 403, /membership required/], ['enterprise-error', 503, /Synthetic service unavailable/],
  ]) {
    const response = await read(scenario); assert.equal(response.status, status); assert.match((await response.json()).error, message);
  }
  for (let n = 0; n < 3; n++) assert.equal((await read('enterprise-retry')).status, 503);
  assert.equal((await read('enterprise-retry', { 'x-ux-retry': 'true' })).status, 503);
  assert.equal((await read('enterprise-retry', { 'x-ux-retry': '1' })).status, 200);
  assert.equal((await read('enterprise-error', { 'x-ux-retry': '1' })).status, 503);
});

test('catalog responds only at the exact synthetic path with evidence states', async () => {
  const data = await ok(await enterpriseRequest(request(catalogFixturePath), 'enterprise-populated'));
  assert.equal(data.synthetic, true);
  assert.deepEqual(data.entries.map(entry => entry.evidence_state), ['routed_in_sandbox', 'architecture_only', 'blocked']);
  assert.ok(data.entries.every(entry => entry.run_evidence.length === 0));
  assert.deepEqual((await ok(await enterpriseRequest(request(catalogFixturePath), 'enterprise-empty'))).entries, []);
  assert.equal((await enterpriseRequest(request(catalogFixturePath, 'POST', {}), 'enterprise-actions')).status, 403);
  assert.equal((await enterpriseRequest(request(catalogFixturePath), 'enterprise-error')).status, 503);
});

test('writes require exact action scenario and parameter allowlist', async () => {
  const before = await ok(await read());
  for (const scenario of ['enterprise-populated', 'enterprise-empty', 'provider-empty']) {
    assert.equal((await action('set_member_role', { actor_name: member, role: 'viewer' }, scenario)).status, 403);
  }
  for (const name of ['unknown', '__proto__', 'constructor', 'review_evidence', 'add_evidence', 'set_readiness', 'attach_run']) {
    assert.equal((await action(name, {})).status, 403);
  }
  assert.equal((await action('set_member_role', { actor_name: member, role: 'viewer', actor: 'dev-admin' })).status, 403);
  const denial = await action('set_member_role', { actor_name: member, role: 'viewer' }, 'enterprise-action-error');
  assert.equal(denial.status, 403); assert.match((await denial.json()).detail, /no write permission/);
  assert.deepEqual(await ok(await read()), before);
});

test('malformed and oversized bodies return bounded errors without mutation', async () => {
  for (const raw of ['{', 'null', '[]', 'false']) {
    const response = await enterpriseRequest(new Request(origin + '/api/enterprise', { method: 'POST', body: raw }), 'enterprise-actions');
    assert.equal(response.status, 400);
  }
  assert.equal((await action('set_member_role', null)).status, 403);
  for (const invalidAction of [null, {}, [], ['set_member_role'], 1]) {
    assert.equal((await action(invalidAction, {})).status, 403);
  }
  assert.equal((await action('set_member_role', { actor_name: 'x'.repeat(9000) })).status, 413);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8193)); controller.close(); } });
  const response = await enterpriseRequest(new Request(origin + '/api/enterprise', { method: 'POST', duplex: 'half', body: stream }), 'enterprise-actions');
  assert.equal(response.status, 413);
  assert.equal((await ok(await read())).members.length, 1);
});

test('IAM uses actor_name contracts, refresh reflects changes and audit, scenarios stay isolated', async () => {
  const params = { actor_name: member, role: 'reviewer' };
  const added = await ok(await action('set_member_role', params));
  assert.equal(added.ok, true); assert.deepEqual(added.result, { ok: true, actor_name: member, role: 'reviewer' });
  await ok(await action('set_member_role', { ...params, role: 'viewer' }));
  let db = await ok(await read());
  assert.equal(db.members.length, 2); assert.equal(db.members[1].role, 'viewer');
  assert.equal(db.audit_tail.at(-1).action, 'set_member_role');
  assert.equal(db.audit_tail.at(-1).actor, actor);
  assert.equal((await ok(await read('enterprise-populated'))).members.length, 1);
  assert.equal((await action('set_member_role', { actor_name: 'real@example.com', role: 'viewer' })).status, 422);
  assert.equal((await action('remove_member', { actor_name: actor })).status, 422);
  await ok(await action('remove_member', { actor_name: member }));
  db = await ok(await read()); assert.equal(db.members.length, 1);
});

test('approval decision history is immutable and board readiness never advances', async () => {
  const requested = await ok(await action('request_approval', { approval_type: 'board_review_approval', scope: { board_id: 'ux-board-routed' }, requested_by: actor }));
  assert.equal(requested.result.status, 'requested');
  const decision = { approval_id: requested.result.approval_id, decision: 'approved', approver: actor };
  const result = await ok(await action('decide_approval', decision));
  assert.equal(result.result.history.length, 2);
  assert.equal(result.result.status, 'approved');
  const repeat = await action('decide_approval', { ...decision, decision: 'rejected' });
  assert.equal(repeat.status, 422); assert.match((await repeat.json()).error, /immutable/);
  assert.equal((await ok(await read())).boards.find(board => board.board_id === 'ux-board-routed').readiness, 'routed_in_sandbox');
});

test('quote packet and approval gates do not fabricate artifacts or orders', async () => {
  const generated = await action('generate_quote_packet', { board_id: 'ux-board-routed' });
  assert.equal(generated.status, 422); assert.match((await generated.json()).error, /no attached run/);
  const advanced = await ok(await action('advance_quote', { board_id: 'ux-board-review', to: 'quote_approval_requested' }));
  assert.equal(advanced.result.state, 'quote_approval_requested');
  const gated = await action('advance_quote', { board_id: 'ux-board-review', to: 'approved_for_quote' });
  assert.equal(gated.status, 422); assert.match((await gated.json()).error, /requires an approved/);
  const db = await ok(await read());
  assert.equal(db.quotes[0].state, 'quote_approval_requested'); assert.deepEqual(db.quotes[0].manual_entries, []);
});

test('validation lifecycle requires reviewed evidence and preserves empty physical ledger', async () => {
  await ok(await action('register_fl1_asset', { org_id: 'ux-org' }));
  const planned = await ok(await action('plan_validation_session', { asset_id: 'ux-asset', board_id: 'ux-board-routed', operator: actor }));
  assert.equal(planned.result.status, 'blocked'); assert.match(planned.result.blocked_reason, /no validation plan/);
  for (const to of ['ready', 'running', 'completed_pending_review']) await ok(await action('advance_session', { session_id: 'ux-session', to }));
  const accepted = await action('advance_session', { session_id: 'ux-session', to: 'accepted' });
  assert.equal(accepted.status, 422); assert.match((await accepted.json()).error, /REVIEWED/);
  const db = await ok(await read()); assert.equal(db.validation_sessions[0].status, 'completed_pending_review'); assert.deepEqual(db.evidence, []);
});

test('integration actions expose synthetic secrets once and never retain plaintext in GET', async () => {
  assert.equal((await action('create_api_key', { name: 'real key', scope: 'read' })).status, 422);
  const created = await ok(await action('create_api_key', { name: 'Synthetic preview key', scope: 'read' }));
  assert.equal(created.result.plaintext, syntheticCredentials.apiKey);
  const webhook = await ok(await action('create_webhook', { url: 'https://hooks.example.invalid/preview', events: ['approval.requested'] }));
  assert.equal(webhook.result.secret, syntheticCredentials.webhookSecret);
  assert.equal((await action('create_webhook', { url: 'https://example.com', events: ['approval.requested'] })).status, 422);
  const sso = await ok(await action('configure_sso', { provider: 'oidc', issuer: 'https://idp.example.invalid', client_id: 'ux-synthetic-client', client_secret: syntheticCredentials.ssoSecret, scim_enabled: true }));
  assert.equal(sso.result.scim_token, syntheticCredentials.scimToken);
  const db = await ok(await read());
  const text = JSON.stringify(db);
  for (const secret of Object.values(syntheticCredentials)) assert.equal(text.includes(secret), false);
  assert.equal(db.organizations[0].integrations.webhooks[0].last_delivery, null);
  assert.equal(db.organizations[0].integrations.sso.enforcement, 'not_active');
  await ok(await action('revoke_api_key', { id: created.result.id }));
  await ok(await action('delete_webhook', { id: webhook.result.id }));
  await ok(await action('disable_sso', {}));
  const final = (await ok(await read())).organizations[0].integrations;
  assert.equal(final.api_keys[0].revoked, true); assert.deepEqual(final.webhooks, []); assert.equal(final.sso.status, 'disabled');
});

test('provider GET/PUT/DELETE exactly mirror redacted account-key response shape', async () => {
  assert.deepEqual(await ok(await key()), { key: null });
  const params = { provider: 'openai', key: syntheticCredentials.providerKey };
  const saved = await ok(await key('PUT', params));
  assert.equal(saved.ok, true); assert.deepEqual(Object.keys(saved.key).sort(), ['addedAt', 'last4', 'provider']);
  assert.equal(saved.key.provider, 'openai'); assert.equal(saved.key.last4, '0000');
  assert.deepEqual(await ok(await key()), { key: saved.key });
  assert.equal(JSON.stringify(await ok(await key())).includes(syntheticCredentials.providerKey), false);
  assert.deepEqual(await ok(await key('DELETE')), { ok: true });
  assert.deepEqual(await ok(await key()), { key: null });
  assert.equal((await key('POST', params)).status, 403);
  assert.equal((await key('PUT', params, 'enterprise-populated')).status, 403);
});

test('provider rejects all nonfixture credentials and unexpected properties', async () => {
  for (const value of ['', 'sk-not-a-real-key', 'ux-synthetic-provider-key-0001', null, 7]) {
    assert.equal((await key('PUT', { provider: 'openai', key: value })).status, 403);
  }
  assert.equal((await key('PUT', { provider: 'unknown', key: syntheticCredentials.providerKey })).status, 400);
  assert.equal((await key('PUT', { provider: 'openai', key: syntheticCredentials.providerKey, token: 'unexpected' })).status, 403);
  assert.deepEqual(await ok(await key()), { key: null });
});

test('provider auth/error/retry and failed writes never masquerade as missing keys or success', async () => {
  assert.equal((await key('GET', undefined, 'provider-auth')).status, 401);
  assert.equal((await key('GET', undefined, 'provider-error')).status, 503);
  assert.equal((await key('GET', undefined, 'provider-retry')).status, 503);
  assert.deepEqual(await ok(await key('GET', undefined, 'provider-retry', { 'x-ux-retry': '1' })), { key: null });
  assert.equal((await key('PUT', { provider: 'anthropic', key: syntheticCredentials.providerKey }, 'provider-save-error')).status, 503);
  assert.deepEqual(await ok(await key('GET', undefined, 'provider-save-error')), { key: null });
  const before = await ok(await key('GET', undefined, 'provider-delete-error'));
  assert.equal(before.key.last4, '0000');
  assert.equal((await key('DELETE', undefined, 'provider-delete-error')).status, 503);
  assert.deepEqual(await ok(await key('GET', undefined, 'provider-delete-error')), before);
});

test('concurrent provider PUTs cannot exceed the shared action budget', async () => {
  const responses = await Promise.all(Array.from({ length: 40 }, () => key('PUT', { provider: 'anthropic', key: syntheticCredentials.providerKey })));
  assert.equal(responses.filter(response => response.status === 200).length, 32);
  assert.equal(responses.filter(response => response.status === 429).length, 8);
});

test('fixed successful action budget bounds arrays and reset restores state', async () => {
  for (let i = 0; i < 32; i++) await ok(await action('register_fl1_asset', { org_id: 'ux-org' }));
  assert.equal((await action('register_fl1_asset', { org_id: 'ux-org' })).status, 429);
  const db = await ok(await read()); assert.equal(db.fl1_assets.length, 33); assert.equal(db.audit_tail.length, 34);
  for (let i = 0; i < 32; i++) await ok(await key('DELETE'));
  assert.equal((await key('DELETE')).status, 429);
  resetEnterpriseFixtures();
  assert.equal((await ok(await read())).fl1_assets.length, 1);
  assert.equal((await key('DELETE')).status, 200);
});
