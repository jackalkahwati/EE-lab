// No filesystem, subprocess, credentials, or backend imports. All data is synthetic.
import { syntheticRun, rememberBuild, rememberImport, buildRuns, fixtureSpec, fixtureTree } from './artifacts.mjs';
import { enterpriseRequest } from './enterprise-fixtures.mjs';
import { pipelineRequest, pipelineScenarios } from './pipeline-fixtures.mjs';
import { createModelGlb, MODEL_GLB_CONTENT_TYPE } from './model-glb.mjs';
const buildScenarios = new Set(['build-success', 'build-error', 'build-malformed', 'build-disconnect']);
export function buildStream(request, scenario, delay = 1800) {
  const id = new URL(request.url).searchParams.get('runId');
  if (!buildScenarios.has(scenario) || !/^run-[a-f0-9-]{36}$/.test(id || '')) return Response.json({ error: 'Explicit synthetic build scenario and UUID required', blocked: true }, { status: 403 });
  // Idempotent on browser reconnect. This map is bounded and lives only in this process.
  if (buildRuns().some(run => run.id === id)) return Response.json({ error: 'Synthetic run already exists; reconnect cannot restart it', blocked: true }, { status: 409 });
  rememberBuild(id, 'running');
  let timer;
  let done = false;
  let detach = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const events = [
        { type: 'stage', id: 'design', state: 'running' },
        { type: 'log', stage: 'design', text: 'Synthetic stream. No tools or providers execute.', level: 'info' },
        { type: 'stage', id: 'design', state: 'passed' },
        { type: 'stage', id: 'placement', state: 'running' },
        scenario === 'build-error' ? { type: 'error', text: 'Synthetic build failure for callback and recovery testing.' } : { type: 'done', runDir: `/runs/${id}` },
      ];
      let index = 0;
      const close = () => { if (!done) { done = true; clearTimeout(timer); detach(); controller.close(); } };
      const aborted = () => { close(); };
      request.signal.addEventListener('abort', aborted, { once: true });
      detach = () => request.signal.removeEventListener('abort', aborted);
      const emit = () => {
        if (done) return;
        const event = events[index++];
        if (index === events.length && ['build-malformed', 'build-disconnect'].includes(scenario)) {
          // Observation ends without evidence of the hypothetical server outcome.
          if (scenario === 'build-malformed') controller.enqueue(new TextEncoder().encode('data: {invalid fixture update\n\n'));
          close(); return;
        }
        if (event.type === 'done' || event.type === 'error') rememberBuild(id, event.type === 'done' ? 'passed' : 'failed');
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        if (index === events.length) close();
        else timer = setTimeout(emit, delay);
      };
      if (request.signal.aborted) aborted(); else emit();
    },
    cancel() { done = true; clearTimeout(timer); detach(); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-UI-Preview': 'synthetic-only' } });
}
export const fixtureUser = {
  id: 'ux-preview-user', email: 'preview@example.invalid', name: 'Preview user',
  plan: 'pro', credits: 100, monthlyCredits: 100,
};
const json = (data, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store', 'X-UI-Preview': 'synthetic-only' },
});
async function boundedBody(request, limit = 32768) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export async function fixtureRequest(request) {
  const url = new URL(request.url);
  const route = url.pathname;
  const method = request.method;
  const origin = request.headers.get('origin');
  // Next can rewrite request.url's host internally; the browser origin is fixed.
  // The preloaded HTTP guard separately validates the incoming Host header.
  if (origin && origin !== 'http://127.0.0.1:4510') return json({ error: 'Preview blocks cross-origin requests', blocked: true }, 403);
  const scenario = request.headers.get('x-ux-scenario') || url.searchParams.get('uxScenario') || 'empty';
  const pipelineResponse = await pipelineRequest(request, scenario);
  if (pipelineResponse) return pipelineResponse;
  if (method === 'GET' && route === '/api/board3d' && ['model-a', 'model-b', ...pipelineScenarios].includes(scenario)
      && url.searchParams.getAll('base').length === 1 && [...url.searchParams.keys()].every(key => key === 'base')) {
    const base = url.searchParams.get('base');
    if (!['/runs/ux-model-a/board', '/runs/ux-model-b/board'].includes(base)) return json({ error: 'Only explicit synthetic model bases are available', blocked: true }, 403);
    return new Response(createModelGlb(base.includes('model-b') ? 'B' : 'A'), { headers: { 'Content-Type': MODEL_GLB_CONTENT_TYPE, 'Cache-Control': 'no-store', 'X-UI-Preview': 'synthetic-only' } });
  }
  if (method === 'GET' && route === '/api/pipeline/run') return buildStream(request, scenario);
  if (method === 'GET' && route === '/api/astra' && !url.search) {
    if (scenario === 'astra-blocked') return json({ enabled: true, transport: 'astra-beta', model: 'gpt-6-astra', billing: 'Bedrock', scope: 'electronics-only', ready: false, blockers: ['Synthetic preflight blocker: native footprint/model verification is unavailable. No inference was called.'] });
    if (scenario === 'astra-status-error') return json({ error: 'Synthetic Astra status unavailable.' }, 503);
    return json({ enabled: false });
  }
  if (method === 'GET' && route === '/api/auth/me') return json({
    user: fixtureUser,
    packs: [],
    models: [{ id: 'preview', label: 'Offline fixture', blurb: 'No model is called', minPlan: 'free', creditMult: 0, allowed: true }],
  });
  if (method === 'GET' && route === '/api/runs/files' && [...url.searchParams.keys()].every(key => key === 'run')) {
    const tree = fixtureTree(url.searchParams.get('run') || '');
    return tree ? json(tree) : json({ error: 'Only known synthetic run files are available', blocked: true }, 403);
  }
  if (method === 'GET' && route === '/api/runs' && !url.search) {
    if (scenario === 'network-error') return json({ error: 'Synthetic network failure', preview: true }, 503);
    const run = syntheticRun(scenario);
    const staticRuns = (scenario.startsWith('model-') || pipelineScenarios.includes(scenario)) ? [syntheticRun('model-a'), syntheticRun('model-b')] : run ? [run, syntheticRun(scenario === 'partial' ? 'completed' : 'partial')] : buildScenarios.has(scenario) ? [syntheticRun('completed'), syntheticRun('partial')] : [];
    return json({ runs: [...buildRuns(), ...staticRuns] });
  }
  if (method === 'POST' && ['import-success', 'import-error', 'import-malformed'].includes(scenario) && ['/api/pipeline/import', '/api/pipeline/import-onshape'].includes(route)) {
    const bytes = await boundedBody(request);
    if (!bytes) return json({ error: 'Synthetic imports are limited to 32 KiB', blocked: true }, 413);
    if (scenario === 'import-error') return json({ error: 'Synthetic import rejected. Keep your input and retry.' }, 422);
    if (scenario === 'import-malformed') return json({ ok: true });
    let pcb = false;
    let step = route.endsWith('import-onshape');
    if (route.endsWith('import-onshape')) {
      let body;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json({ error: 'Invalid fixture JSON' }, 400); }
      if (body.url !== 'https://cad.onshape.com/documents/synthetic/w/preview/e/assembly') return json({ error: 'Only the explicit synthetic Onshape URL is accepted', blocked: true }, 403);
    } else {
      let form;
      try { form = await new Response(bytes, { headers: { 'content-type': request.headers.get('content-type') || '' } }).formData(); } catch { return json({ error: 'Invalid fixture form' }, 400); }
      const files = ['pcb', 'step'].map(key => form.get(key)).filter(Boolean);
      if (!files.length || files.some(file => typeof file === 'string' || !file.name.startsWith('synthetic-'))) return json({ error: 'Only hand-authored synthetic fixture files are accepted', blocked: true }, 403);
      for (const file of files) if (!(await file.text()).startsWith('SYNTHETIC UI FIXTURE')) return json({ error: 'Synthetic fixture marker required', blocked: true }, 403);
      pcb = !!form.get('pcb');
      step = !!form.get('step');
    }
    const runId = `run-${crypto.randomUUID()}`;
    rememberImport(runId, { pcb, step });
    return json({ runId, name: 'Synthetic imported design', imported: { pcb, step }, preview: true });
  }
  if (method === 'POST' && ['/api/auth/login', '/api/auth/signup'].includes(route)) return json({ error: 'Offline preview does not sign in. Use synthetic credentials only.' }, 401);
  if (method === 'GET' && route === '/api/account/llm-key' && !/^(enterprise|provider)-/.test(scenario)) return json({ key: null });
  const enterpriseResponse = await enterpriseRequest(request, scenario);
  if (enterpriseResponse) return enterpriseResponse;
  if (method === 'GET' && route === '/api/ux-preview/status') return json({ preview: true, scenario: 'empty', providers: false, tools: false });
  if (method === 'POST' && ['/api/interview', '/api/architect', '/api/industrial-design'].includes(route) && scenario === 'network-error') return json({ error: 'Synthetic network failure. Your draft can be retried.' }, 503);
  if (method === 'POST' && buildScenarios.has(scenario) && ['/api/architect', '/api/interview'].includes(route)) {
    const bytes = await boundedBody(request);
    if (!bytes) return json({ error: 'Fixture request too large' }, 413);
    const text = new TextDecoder().decode(bytes);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'Invalid fixture JSON' }, 400); }
    if (route === '/api/architect') {
      const finish = Array.isArray(body.answers) && body.answers.some(answer => /^finish$/i.test(String(answer.answer || '').trim()));
      if (finish) return json({ type: 'spec', spec: fixtureSpec() });
      return json({ type: 'question', product: 'Synthetic fixture sensor', question: 'Offline preview: reply finish to explicitly launch a synthetic build. No provider or tool will run.' });
    }
    if (body.force === true) return json({ type: 'spec', boardClass: 'Synthetic fixture board', blocks: ['Power', 'Sensor'], layers: 2, summary: 'Offline demonstration', request: 'Synthetic preview sensor board' });
  }
  if (method === 'POST' && ['/api/interview', '/api/architect', '/api/industrial-design'].includes(route)) return json({
    type: 'question', boardClass: 'Synthetic preview board',
    question: 'This is an offline interview fixture. What supply voltage should this demonstration board use?',
    hints: ['3.3 V', '5 V', '12 V'],
  });
  return json({ error: `UI preview blocked ${method} ${route}. No real handler exists here.`, preview: true, blocked: true }, 403);
}
