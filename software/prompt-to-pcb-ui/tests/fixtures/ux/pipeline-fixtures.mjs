// Hand-authored, bounded in-memory contracts. No filesystem, native tools or providers.
export const pipelineScenarios = Object.freeze(['pipeline-success', 'pipeline-error']);
const ids = new Set(['ux-model-a', 'ux-model-b']);
const stages = new Set(['electronics', 'mechanical', 'simulation', 'firmware', 'manufacturing', 'supplyChain', 'validation']);
const statuses = new Set(['pending', 'running', 'passed', 'failed', 'blocked', 'skipped']);
const stateKey = Symbol.for('firstlight.ux-preview.pipeline');
const stores = globalThis[stateKey] ??= new Map();
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-UI-Preview': 'synthetic-only' } });
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value; }
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const duration = value => value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
export function pipelineSpec() {
  const inactive = { status: 'not_applicable', summary: 'Outside synthetic downstream fixture', requirements: [] };
  return { product: 'Synthetic downstream demonstration', description: 'UI contracts only. No engineering verification or native tools.', budgets: { sizeMm: { x: 48, y: 32 } }, disciplines: {
    electronics: { status: 'defined', summary: 'Synthetic electronics', boardIntent: 'Synthetic downstream board', keyBlocks: ['Synthetic block'], layers: 2 },
    mechanical: { status: 'defined', summary: 'Synthetic viewer geometry only', requirements: [] },
    simulation: { status: 'defined', summary: 'Synthetic unavailable solver', requirements: [] },
    firmware: inactive, manufacturing: inactive, supplyChain: inactive, validation: inactive,
  }, openQuestions: [] };
}
function store(scenario, id) {
  const key = `${scenario}:${id}`;
  if (!stores.has(key)) stores.set(key, { actions: 0, timing: null, simulation: null });
  return stores.get(key);
}
export function resetPipelineFixtures() { stores.clear(); }
export function pipelineFixtureState(scenario, id) { return structuredClone(store(scenario, id)); }
async function body(request) {
  const reader = request.body?.getReader(); if (!reader) return null;
  const parts = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 32768) { await reader.cancel(); return null; }
      parts.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}
function validTiming(value) {
  return keys(value, ['runId', 'startedAt', 'finishedAt', 'totalMs', 'stages']) && timestamp(value.startedAt)
    && (value.finishedAt === undefined || (timestamp(value.finishedAt) && Date.parse(value.finishedAt) >= Date.parse(value.startedAt)))
    && duration(value.totalMs) && Array.isArray(value.stages) && value.stages.length <= 16 && value.stages.every(s =>
      keys(s, ['stage', 'status', 'detail', 'startedAt', 'endedAt', 'ms', 'unfinished']) && stages.has(s.stage) && statuses.has(s.status)
      && timestamp(s.startedAt) && (s.endedAt === undefined || (timestamp(s.endedAt) && Date.parse(s.endedAt) >= Date.parse(s.startedAt)))
      && duration(s.ms) && (s.detail === undefined || (typeof s.detail === 'string' && s.detail.length <= 2048))
      && (s.unfinished === undefined || typeof s.unfinished === 'boolean'));
}
async function delay(ms, signal) {
  if (signal?.aborted) throw new DOMException('Observation aborted; synthetic server outcome unknown', 'AbortError');
  await new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Observation aborted; synthetic server outcome unknown', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export async function pipelineRequest(request, scenario) {
  if (!pipelineScenarios.includes(scenario)) return null;
  const url = new URL(request.url);
  const artifact = /^\/runs\/(ux-model-[ab])\/(product-spec|timing|disciplines\/simulation)\.json$/.exec(url.pathname);
  const routes = ['/api/electronics-cs', '/api/mechanical', '/api/simulate', '/api/runs/timing', '/api/runs/stage-hash', '/api/programs/sync', '/api/runs/work-items'];
  if (!artifact && !routes.includes(url.pathname)) return null;
  if (request.headers.get('origin') && request.headers.get('origin') !== 'http://127.0.0.1:4510') return json({ error: 'Foreign origin denied', blocked: true }, 403);
  if (url.pathname === '/api/runs/stage-hash' && request.method === 'GET') {
    const query = url.searchParams;
    if (query.size !== 2 || query.getAll('run').length !== 1 || query.getAll('stage').length !== 1
      || !ids.has(query.get('run')) || !['mechanical', 'simulation'].includes(query.get('stage'))) return json({ error: 'Unexpected stage currency query', blocked: true }, 403);
    return json({ enabled: false, current: false, reason: 'Synthetic fixture: no reusable engineering verification' });
  }
  if (url.search) return json({ error: 'Unexpected fixture query', blocked: true }, 403);
  if (artifact) {
    if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Read-only artifact', blocked: true }, 403);
    const value = artifact[2] === 'product-spec' ? pipelineSpec() : store(scenario, artifact[1])[artifact[2] === 'timing' ? 'timing' : 'simulation'];
    if (!value) {
      if (request.method === 'HEAD') return new Response(null, { status: 404, headers: { 'X-UI-Preview': 'synthetic-only', 'Cache-Control': 'no-store' } });
      return json({ error: `No synthetic ${artifact[2] === 'timing' ? 'timing' : 'simulation'} recorded` }, 404);
    }
    if (request.method === 'HEAD') return new Response(null, { headers: { 'Content-Type': 'application/json', 'X-UI-Preview': 'synthetic-only', 'Cache-Control': 'no-store' } });
    return json(value);
  }
  if (request.method !== 'POST' || !request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Explicit JSON POST required', blocked: true }, 403);
  const data = await body(request);
  if (!record(data) || !ids.has(data.runId)) return json({ error: 'Bounded synthetic run payload required', blocked: true }, 403);
  const completion = ['/api/programs/sync', '/api/runs/work-items'].includes(url.pathname);
  const telemetry = url.pathname.startsWith('/api/runs/');
  const valid = completion ? keys(data, ['runId']) : url.pathname === '/api/runs/timing' ? validTiming(data)
    : url.pathname === '/api/runs/stage-hash' ? keys(data, ['runId', 'stage', 'status']) && stages.has(data.stage) && ['passed', 'failed'].includes(data.status)
      : keys(data, url.pathname === '/api/electronics-cs' ? ['runId', 'spec', 'keepCapabilities'] : ['runId', 'spec']) && equal(data.spec, pipelineSpec()) && (data.keepCapabilities === undefined || typeof data.keepCapabilities === 'boolean');
  if (!valid) return json({ error: 'Unexpected synthetic request contract', blocked: true }, 403);
  const state = store(scenario, data.runId);
  if (state.actions >= 16) return json({ error: 'Synthetic action limit reached (16)', blocked: true }, 429);
  state.actions++;
  if (url.pathname === '/api/runs/timing') {
    // A delayed fixture response exercises the actual recorder's coalescing.
    state.timing = structuredClone(data);
    await delay(150, request.signal);
    return json({ ok: true, synthetic: true });
  }
  if (url.pathname === '/api/programs/sync') return json({ synced: false, reason: 'Synthetic UI fixture; no enterprise product or board created' });
  // The real harvester does not currently enumerate unavailable DRC/assessment gaps.
  // An empty queue is NOT evidence that those checks passed or were resolved.
  if (url.pathname === '/api/runs/work-items') return json({ runId: data.runId, items: [] });
  if (telemetry) return json({ ok: true, synthetic: true, current: false });
  await delay(350, request.signal);
  if (scenario === 'pipeline-error' && url.pathname === '/api/mechanical') return json({ error: 'Synthetic enclosure request rejected. No native work executed.' }, 422);
  if (url.pathname === '/api/electronics-cs') return json({ ok: true, boardMm: { w: data.runId === 'ux-model-a' ? 40 : 50, h: 30 }, components: 1, routedTraces: 0, errors: {}, drc: { available: false, reason: 'Synthetic UI contract; DRC was not executed.' } });
  if (url.pathname === '/api/mechanical') return json({ ok: true, part: 'Synthetic viewer geometry, not an enclosure design', gltfUrl: `/runs/${data.runId}/mechanical/enclosure.glb`, stepUrl: null, fitCheck: null });
  const simulation = { results: [], assessment: { assessments: [], gaps: ['Synthetic solver unavailable. No physical analysis executed.'] } };
  state.simulation = structuredClone(simulation);
  return json(simulation);
}
