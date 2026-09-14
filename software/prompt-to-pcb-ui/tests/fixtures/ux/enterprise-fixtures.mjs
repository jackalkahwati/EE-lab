// Synthetic-only response contracts. No imports, I/O, provider calls, or real credentials.
// This is a bounded UI simulation, NOT an alternative enterprise implementation.
export const enterpriseScenarios = Object.freeze([
  'enterprise-populated', 'enterprise-empty', 'enterprise-error', 'enterprise-auth',
  'enterprise-membership', 'enterprise-retry', 'enterprise-actions', 'enterprise-action-error',
  'provider-empty', 'provider-saved', 'provider-error', 'provider-auth', 'provider-retry',
  'provider-save-error', 'provider-delete-error',
]);
export const syntheticCredentials = Object.freeze({
  providerKey: 'ux-synthetic-provider-key-0000',
  apiKey: 'ux-synthetic-api-key-0000',
  webhookSecret: 'ux-synthetic-webhook-secret-0000',
  ssoSecret: 'ux-synthetic-sso-secret-0000',
  scimToken: 'ux-synthetic-scim-token-0000',
});
export const catalogFixturePath = '/runs/fl1-backplane-v1/data/compose-package-capability-registry.json';
const ORIGIN = 'http://127.0.0.1:4510';
const AT = '2026-09-13T12:00:00.000Z';
const ACTOR = 'preview@example.invalid';
const MEMBER = 'synthetic-member@example.invalid';
const MAX_BODY = 8192;
const MAX_ACTIONS = 32;
const scenarios = new Set(enterpriseScenarios);
const providers = new Set(['anthropic', 'openai', 'gemini', 'nemotron']);
const json = (data, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store', 'X-UI-Preview': 'synthetic-only' },
});
const deny = (error = 'Explicit synthetic scenario and allowlisted action required') => json({ error, blocked: true, preview: true }, 403);
const invalid = error => json({ error }, 422);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const roles = ['org_admin', 'workspace_admin', 'program_manager', 'electrical_engineer', 'reviewer', 'procurement', 'technician', 'viewer', 'finance_viewer', 'security_auditor'];
const permissions = ['create_workspace', 'manage_members', 'create_program', 'edit_program', 'create_board', 'run_architecture', 'run_board_synthesis', 'run_routing', 'generate_package', 'request_approval', 'approve_architecture', 'approve_bom', 'approve_package_release', 'approve_quote', 'approve_order', 'upload_physical_evidence', 'accept_physical_evidence', 'mark_validation_passed', 'view_costs', 'adjust_credits', 'export_evidence_pack', 'manage_security_settings'];
const rolePermissions = {
  org_admin: permissions,
  workspace_admin: ['create_workspace', 'manage_members', 'create_program', 'edit_program', 'create_board', 'request_approval', 'view_costs', 'export_evidence_pack'],
  program_manager: ['create_program', 'edit_program', 'create_board', 'run_architecture', 'request_approval', 'view_costs', 'export_evidence_pack'],
  electrical_engineer: ['create_board', 'run_architecture', 'run_board_synthesis', 'run_routing', 'generate_package', 'request_approval', 'upload_physical_evidence', 'accept_physical_evidence', 'export_evidence_pack'],
  reviewer: ['approve_architecture', 'approve_bom', 'approve_package_release', 'accept_physical_evidence', 'mark_validation_passed', 'export_evidence_pack'],
  procurement: ['approve_quote', 'approve_order', 'view_costs', 'export_evidence_pack'],
  technician: ['upload_physical_evidence', 'export_evidence_pack'], viewer: [],
  finance_viewer: ['view_costs'], security_auditor: ['export_evidence_pack'],
};

function seed(empty = false) {
  const db = {
    organizations: [], workspaces: [], programs: [], boards: [], runs: [], evidence: [],
    approvals: [], usage: [], pilots: [], quotes: [], fl1_assets: [], validation_sessions: [],
    members: [], audit_tail: [], audit_chain: { ok: true, count: 0 },
    rbac: { roles, permissions, role_permissions: rolePermissions },
  };
  if (empty) return structuredClone(db);
  db.organizations = [{ org_id: 'ux-org', name: 'Synthetic Preview Organization', plan: 'enterprise', credit_allocation: 100,
    security_settings: { demo: true, auth: 'synthetic session' }, usage_limits: { monthly_runs: 20 },
    policies: { default_evidence_policy: 'review_required', default_approval_policy: 'small_internal_board' },
    integrations: { eda_connectors: [{ name: 'Synthetic KiCad connector', status: 'native', io: 'Synthetic UI metadata only', kind: 'offline fixture' }], api_keys: [], webhooks: [], sso: { status: 'not_configured', scim: { enabled: false } } } }];
  db.workspaces = [{ workspace_id: 'ux-workspace', org_id: 'ux-org', name: 'Synthetic Lab' }];
  db.programs = [{ program_id: 'ux-program', workspace_id: 'ux-workspace', name: 'Synthetic Sensor Program', status: 'review_required', owner: ACTOR,
    objective: 'Synthetic UI review only; no hardware, provider or orders.', board_list: ['ux-board-review', 'ux-board-routed', 'ux-board-blocked'],
    budget: { credits_allocated: 100, credits_consumed: 85 }, blocked_claims: [] }];
  db.boards = [
    ['ux-board-review', 'Synthetic Review Board', 'package_ready_with_review'],
    ['ux-board-routed', 'Synthetic Routed Board', 'routed_in_sandbox'],
    ['ux-board-blocked', 'Synthetic Blocked Board', 'blocked'],
  ].map(([board_id, name, readiness]) => ({ board_id, name, readiness, program_id: 'ux-program', board_class: 'synthetic sensor', created_at: AT,
    current_design_state: 'architecture_only', architecture_summary: 'Synthetic metadata', latest_run_id: board_id === 'ux-board-review' ? 'ux-run' : null,
    blocked_claims: readiness === 'blocked' ? ['Synthetic routing constraint requires review'] : [], review_required_items: ['Synthetic fixture, not physical evidence'],
    physical_evidence_state: 'none', production_readiness_state: 'not_ready', tags: ['synthetic'], risks: [] }));
  db.runs = [{ run_id: 'ux-run', board_id: 'ux-board-review', created_at: AT, source_run_dir: null,
    readiness_state: 'routed_in_sandbox', route_evidence_state: 'routed_in_sandbox', drc_state: 'drc_clean', erc_state: 'passed', external_eda_state: 'advisory',
    validation_artifacts: [], artifacts: [], blocked_claims: [], review_required_items: [] }];
  db.approvals = [{ approval_id: 'ux-approval', approval_type: 'board_review_approval', scope: { board_id: 'ux-board-review' }, requested_by: ACTOR,
    approver: null, status: 'requested', evidence_snapshot: [], blocked_claims_snapshot: [], timestamp: AT, history: [{ status: 'requested', by: ACTOR, at: AT }] }];
  db.quotes = [{ quote_id: 'ux-quote', board_id: 'ux-board-review', state: 'quote_packet_ready', packet: { schema: 'quote-packet/v1', synthetic: true },
    fab_vendor: { name: null, note: 'Synthetic placeholder. No vendor contacted.' }, fab_attach: null, manual_entries: [], history: [{ state: 'quote_packet_ready', at: AT }] }];
  db.fl1_assets = [{ asset_id: 'ux-asset', org_id: 'ux-org', serial_placeholder: 'SYNTHETIC-FL1-0000', location_placeholder: 'Offline preview', status: 'registered', calibration_state: 'uncalibrated_placeholder' }];
  db.validation_sessions = [{ session_id: 'ux-session', board_id: 'ux-board-review', asset_id: 'ux-asset', status: 'planned', operator: ACTOR,
    validation_plan: 'synthetic metadata only', evidence_ids: [], measurements: [], failures: [], review_state: 'not_reviewed' }];
  db.usage = [{ usage_id: 'ux-usage', program_id: 'ux-program', board_id: 'ux-board-review', user: ACTOR, credits: 85, usage_type: 'synthetic_preview', timestamp: AT }];
  db.members = [{ actor: ACTOR, role: 'org_admin', workspace_id: null, granted_by: ACTOR, at: AT }];
  db.audit_tail = [
    { actor: ACTOR, action: 'request_approval', scope: { board_id: 'ux-board-review' }, note: 'Synthetic review requested', at: AT },
    { actor: MEMBER, action: 'DENIED:advance_quote', scope: { board_id: 'ux-board-review' }, note: 'Synthetic permission denial', at: AT },
  ];
  db.audit_chain.count = db.audit_tail.length;
  return structuredClone(db);
}

// Fixed scenario keys only; 32 successful mutations per scenario; no eviction that
// silently resets user-visible state. Fresh preview process or explicit test reset.
const state = new Map();
export function resetEnterpriseFixtures() { state.clear(); }
function stateFor(scenario) {
  if (!state.has(scenario)) state.set(scenario, {
    db: seed(scenario === 'enterprise-empty'), actions: 0,
    key: ['provider-saved', 'provider-delete-error'].includes(scenario)
      ? { provider: 'anthropic', last4: '0000', addedAt: AT } : null,
  });
  return state.get(scenario);
}

async function readBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY) return { response: json({ error: 'Fixture request too large' }, 413) };
  const reader = request.body?.getReader();
  if (!reader) return { response: json({ error: 'invalid JSON body' }, 400) };
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); return { response: json({ error: 'Fixture request too large' }, 413) }; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    return object(body) ? { body } : { response: json({ error: 'JSON object required' }, 400) };
  } catch { return { response: json({ error: 'invalid JSON body' }, 400) }; }
  finally { reader.releaseLock(); }
}

const actionFields = {
  request_approval: ['approval_type', 'scope', 'requested_by'], decide_approval: ['approval_id', 'decision', 'approver'],
  set_member_role: ['actor_name', 'role'], remove_member: ['actor_name'],
  generate_quote_packet: ['board_id'], advance_quote: ['board_id', 'to'],
  register_fl1_asset: ['org_id'], plan_validation_session: ['asset_id', 'board_id', 'operator'], advance_session: ['session_id', 'to'],
  create_api_key: ['name', 'scope'], revoke_api_key: ['id'], create_webhook: ['url', 'events'], delete_webhook: ['id'],
  configure_sso: ['provider', 'issuer', 'client_id', 'client_secret', 'scim_enabled'], disable_sso: [],
};
const events = ['approval.requested', 'approval.decided', 'quote.advanced', 'evidence.added', 'evidence.reviewed'];
function actionResult(db, action, p, sequence) {
  const id = kind => `ux-${kind}-${sequence}`;
  const board = () => db.boards.find(b => b.board_id === p.board_id);
  const ig = db.organizations[0].integrations;
  switch (action) {
    case 'set_member_role': {
      if (p.actor_name !== MEMBER) return { error: 'Only synthetic-member@example.invalid may be changed' };
      if (!roles.includes(p.role)) return { error: 'unknown role' };
      const member = db.members.find(m => m.actor === p.actor_name);
      if (member) member.role = p.role;
      else db.members.push({ actor: MEMBER, role: p.role, workspace_id: null, granted_by: ACTOR, at: AT });
      return { ok: true, actor_name: MEMBER, role: p.role };
    }
    case 'remove_member': {
      if (p.actor_name !== MEMBER || !db.members.some(m => m.actor === MEMBER)) return { error: 'no such synthetic member' };
      db.members = db.members.filter(m => m.actor !== MEMBER);
      return { ok: true, removed: MEMBER };
    }
    case 'request_approval': {
      if (p.approval_type !== 'board_review_approval' || p.requested_by !== ACTOR || !exact(p.scope, ['board_id']) || !db.boards.some(b => b.board_id === p.scope.board_id)) return { error: 'Synthetic board review scope and requester required' };
      if (db.approvals.some(a => a.status === 'requested' && a.scope.board_id === p.scope.board_id)) return { error: 'Synthetic review already requested' };
      const approval = { approval_id: id('approval'), approval_type: p.approval_type, scope: p.scope, requested_by: ACTOR, approver: null, status: 'requested',
        evidence_snapshot: [], blocked_claims_snapshot: [], timestamp: AT, history: [{ status: 'requested', by: ACTOR, at: AT }] };
      db.approvals.push(approval); return approval;
    }
    case 'decide_approval': {
      const approval = db.approvals.find(a => a.approval_id === p.approval_id);
      if (!approval) return { error: 'no such approval' };
      if (approval.status !== 'requested') return { error: `approval is ${approval.status}; only requested approvals can be decided (history is immutable)` };
      if (!['approved', 'rejected'].includes(p.decision) || p.approver !== ACTOR) return { error: 'Synthetic named approver and approved|rejected decision required' };
      approval.status = p.decision; approval.approver = ACTOR;
      approval.history.push({ status: p.decision, by: ACTOR, at: AT }); return approval;
    }
    case 'generate_quote_packet':
      if (!board()) return { error: 'no such board' };
      // No source run directory is fabricated. The actual server refuses this case.
      return { error: 'no attached run — package_not_ready' };
    case 'advance_quote': {
      const quote = db.quotes.find(q => q.board_id === p.board_id);
      if (!quote) return { error: 'no quote workflow for board' };
      if (quote.state === 'quote_approval_requested' && p.to === 'approved_for_quote') return { error: 'approved_for_quote requires an approved approved_for_quote approval record — it cannot be inferred or automated' };
      if (quote.state !== 'quote_packet_ready' || p.to !== 'quote_approval_requested') return { error: `illegal transition ${quote.state} -> ${String(p.to).slice(0, 80)}` };
      quote.state = p.to; quote.history.push({ state: p.to, at: AT, note: '' }); return quote;
    }
    case 'register_fl1_asset': {
      if (p.org_id !== 'ux-org') return { error: 'synthetic organization required' };
      const asset = { asset_id: id('asset'), org_id: p.org_id, serial_placeholder: 'FL1-XXXX', location_placeholder: 'customer lab', status: 'registered',
        software_term: { months: 12, started_at: AT }, service_notes: [], calibration_state: 'uncalibrated_placeholder' };
      db.fl1_assets.push(asset); return asset;
    }
    case 'plan_validation_session': {
      if (!db.fl1_assets.some(a => a.asset_id === p.asset_id) || !board() || p.operator !== ACTOR) return { error: 'Synthetic asset, board and operator required' };
      const session = { session_id: id('session'), asset_id: p.asset_id, board_id: p.board_id, operator: ACTOR, status: 'blocked',
        blocked_reason: 'no validation plan — generate fl1-testplan.json first', validation_plan: null, evidence_ids: [], measurements: [], failures: [], review_state: 'not_reviewed' };
      db.validation_sessions.push(session); return session;
    }
    case 'advance_session': {
      const session = db.validation_sessions.find(s => s.session_id === p.session_id);
      if (!session) return { error: 'no such session' };
      if (session.status === 'completed_pending_review' && p.to === 'accepted') return { error: 'session acceptance requires at least one REVIEWED (accepted) evidence item — a completed session never implies pass' };
      const next = { planned: ['ready'], ready: ['running'], running: ['completed_pending_review'], completed_pending_review: ['rejected'] };
      if (!next[session.status]?.includes(p.to)) return { error: 'illegal session transition' };
      session.status = p.to;
      if (p.to === 'running') session.start_time = AT;
      if (p.to === 'completed_pending_review') session.end_time = AT;
      if (p.to === 'rejected') session.review_state = 'reviewed_rejected';
      return session;
    }
    case 'create_api_key': {
      if (p.name !== 'Synthetic preview key' || !['read', 'read_write'].includes(p.scope)) return { error: 'Use Synthetic preview key and read|read_write scope' };
      const key = { id: id('key'), name: p.name, scope: p.scope, masked: 'ux-synthetic-…0000', created_at: AT, created_by: ACTOR, last_used: null, revoked: false };
      ig.api_keys.push(key); return { ...key, plaintext: syntheticCredentials.apiKey };
    }
    case 'revoke_api_key': {
      const key = ig.api_keys.find(k => k.id === p.id);
      if (!key) return { error: 'no such key' };
      key.revoked = true; return { ok: true, id: p.id };
    }
    case 'create_webhook': {
      if (p.url !== 'https://hooks.example.invalid/preview' || !Array.isArray(p.events) || !p.events.length || p.events.length > events.length || !p.events.every(event => events.includes(event))) return { error: 'Synthetic example.invalid webhook and valid events required' };
      const webhook = { id: id('webhook'), url: p.url, events: [...new Set(p.events)], active: true, created_at: AT, last_delivery: null };
      ig.webhooks.push(webhook); return { id: webhook.id, url: webhook.url, events: webhook.events, secret: syntheticCredentials.webhookSecret };
    }
    case 'delete_webhook': {
      if (!ig.webhooks.some(w => w.id === p.id)) return { error: 'no such webhook' };
      ig.webhooks = ig.webhooks.filter(w => w.id !== p.id); return { ok: true, id: p.id };
    }
    case 'configure_sso': {
      if (p.provider !== 'oidc' || p.issuer !== 'https://idp.example.invalid' || p.client_id !== 'ux-synthetic-client' || p.client_secret !== syntheticCredentials.ssoSecret || typeof p.scim_enabled !== 'boolean') return { error: 'Exact synthetic OIDC credentials required' };
      ig.sso = { status: 'configured', provider: 'oidc', enforcement: 'not_active', oidc: { issuer: p.issuer, client_id: p.client_id, client_secret: '••••' },
        scim: { enabled: p.scim_enabled, ...(p.scim_enabled ? { token_masked: 'ux-synthetic-…0000' } : {}) } };
      return { ...ig.sso, ...(p.scim_enabled ? { scim_token: syntheticCredentials.scimToken } : {}) };
    }
    case 'disable_sso': ig.sso = { status: 'disabled', enforcement: 'not_active', scim: { enabled: false } }; return ig.sso;
    default: return { error: 'Fixture action not implemented' };
  }
}

/** Return null ONLY outside the owned namespace. Never falls through to real handlers. */
export async function enterpriseRequest(request, scenario) {
  const url = new URL(request.url);
  const route = url.pathname;
  const enterprise = route === '/api/enterprise' || route.startsWith('/api/enterprise/');
  const provider = route === '/api/account/llm-key' || route.startsWith('/api/account/llm-key/');
  if (!enterprise && !provider && route !== catalogFixturePath) return null;
  if (request.headers.get('origin') && request.headers.get('origin') !== ORIGIN) return deny('Preview blocks cross-origin requests');
  // Incoming Host and outbound network are separately guarded by the launcher.
  if (!scenarios.has(scenario) || url.search || url.username || url.password) return deny();
  if (route !== '/api/enterprise' && route !== '/api/account/llm-key' && route !== catalogFixturePath) return deny('No downloads or child handlers in this fixture');
  if (['enterprise-auth', 'provider-auth'].includes(scenario)) return json({ error: 'sign in required' }, 401);
  if (enterprise && scenario === 'enterprise-membership') return json({ error: 'enterprise membership required' }, 403);
  const retry = request.headers.get('x-ux-retry') === '1';
  if (request.method === 'GET' && (['enterprise-error', 'provider-error'].includes(scenario) || (['enterprise-retry', 'provider-retry'].includes(scenario) && !retry))) return json({ error: 'Synthetic service unavailable. Try again.' }, 503);
  if (route === catalogFixturePath) {
    if (request.method !== 'GET' || !scenario.startsWith('enterprise-')) return deny();
    return json({ schema: 'compose-package-capability-registry/v1', synthetic: true, entries: scenario === 'enterprise-empty' ? [] : [
      { family: 'Synthetic QFN sensor', tier: 1, evidence_state: 'routed_in_sandbox', run_evidence: [] },
      { family: 'Synthetic BGA controller', tier: 2, evidence_state: 'architecture_only', run_evidence: [] },
      { family: 'Synthetic advanced package', tier: 3, evidence_state: 'blocked', run_evidence: [] },
    ] });
  }
  const s = stateFor(scenario);
  if (provider) {
    if (request.method === 'GET') return json({ key: s.key });
    if (!scenario.startsWith('provider-')) return deny();
    if (!['PUT', 'DELETE'].includes(request.method)) return deny();
    if (s.actions >= MAX_ACTIONS) return json({ error: 'Synthetic action limit reached; restart preview' }, 429);
    if (request.method === 'DELETE') {
      if (['provider-delete-error', 'provider-error'].includes(scenario)) return json({ error: 'Synthetic remove failed. Account key is unchanged.' }, 503);
      s.key = null; s.actions++; return json({ ok: true });
    }
    const parsed = await readBody(request);
    if (parsed.response) return parsed.response;
    const body = parsed.body;
    if (!exact(body, ['provider', 'key']) || body.key !== syntheticCredentials.providerKey) return deny('Only the exact exported synthetic provider credential is accepted');
    if (!providers.has(body.provider ?? 'anthropic')) return json({ error: 'unsupported provider' }, 400);
    if (['provider-save-error', 'provider-error'].includes(scenario)) return json({ error: 'Synthetic save failed. Your input is unchanged.' }, 503);
    // Recheck after body streaming: concurrent PUTs must share the same bound.
    if (s.actions >= MAX_ACTIONS) return json({ error: 'Synthetic action limit reached; restart preview' }, 429);
    s.key = { provider: body.provider ?? 'anthropic', last4: '0000', addedAt: AT };
    s.actions++; return json({ ok: true, key: s.key });
  }
  if (!scenario.startsWith('enterprise-')) return deny();
  if (request.method === 'GET') return json(s.db);
  if (request.method !== 'POST' || !['enterprise-actions', 'enterprise-action-error'].includes(scenario)) return deny();
  const parsed = await readBody(request);
  if (parsed.response) return parsed.response;
  const { action, params } = parsed.body;
  if (!exact(parsed.body, ['action', 'params']) || typeof action !== 'string' || !Object.hasOwn(actionFields, action) || !exact(params, actionFields[action])) return deny('Unknown action or unexpected action parameters');
  if (scenario === 'enterprise-action-error') return json({ error: 'permission denied', detail: 'Synthetic viewer has no write permission' }, 403);
  if (s.actions >= MAX_ACTIONS) return json({ error: 'Synthetic action limit reached; restart preview' }, 429);
  // Transactional copy: rejected contracts cannot partially mutate fixture state.
  const next = structuredClone(s.db);
  const result = actionResult(next, action, params, s.actions + 1);
  if (result.error) return invalid(result.error);
  next.audit_tail.push({ actor: ACTOR, action, scope: { synthetic: true }, note: 'Synthetic in-memory action only', at: AT });
  next.audit_tail = next.audit_tail.slice(-50);
  next.audit_chain.count = next.audit_tail.length;
  s.db = next; s.actions++;
  return json({ ok: true, result });
}
