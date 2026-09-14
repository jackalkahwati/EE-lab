// Hand-authored illustration and numbers, never copied from a run store.
import { createModelGlb, MODEL_GLB_CONTENT_TYPE } from './model-glb.mjs';
export const board = {
  source: 'SYNTHETIC-UI-FIXTURE.kicad_pcb', boardSize: { wMm: 48, hMm: 32 }, layers: 2,
  components: 8, netsTotal: 6, netsRouted: 5, unroutedNets: ['DEMO_SIGNAL'], zoneServedNets: [],
  tracks: 12, vias: 3, hpwlMm: 100,
  placement: { overlaps: 0, overlapPairs: [], offBoard: [] },
  drc: { violations: 1, violationSummaries: [{ type: 'synthetic', description: 'Illustration only; no engineering verification performed.' }], unconnectedItems: 1, kicadVersion: 'not executed', date: '2026-09-13' },
};
export function illustration(side = 'top') {
  const bottom = side === 'bottom';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640"><rect width="960" height="640" fill="#101214"/><g transform="translate(160 120)"><rect width="640" height="400" rx="22" fill="${bottom ? '#1d413b' : '#1a4b3c'}" stroke="#89b5a5" stroke-width="3"/><g fill="#121719" stroke="#bfa674" stroke-width="7"><circle cx="28" cy="28" r="12"/><circle cx="612" cy="28" r="12"/><circle cx="28" cy="372" r="12"/><circle cx="612" cy="372" r="12"/></g><g fill="none" stroke="#bfa674" stroke-width="5"><path d="M100 120H230V230H440V310H550"/><path d="M100 280H160V180H420V100H540"/><path d="M290 80V300H390"/></g>${bottom ? '' : '<rect x="235" y="130" width="150" height="140" rx="8" fill="#202528" stroke="#aaa"/><rect x="485" y="130" width="110" height="110" fill="#9ca3a7"/><rect x="70" y="180" width="90" height="65" fill="#252b2d"/>'}<g fill="#d4caa5" font-family="monospace" font-size="20"><text x="65" y="345">SYNTHETIC BOARD · ${bottom ? 'BOTTOM' : 'TOP'}</text><text x="65" y="375" font-size="14">UI illustration, not a validated design</text></g></g></svg>`;
}
// Luminance masks need white geometry, not the colored photo illustration.
export function layerIllustration(layer) {
  const geometry = {
    'F.Cu': '<path d="M100 120H230V230H440V310H550"/><path d="M290 80V300H390"/>',
    'B.Cu': '<path d="M100 280H160V180H420V100H540"/>',
    'In1.Cu': '<path d="M90 90H550V310H90Z"/>',
    'In2.Cu': '<path d="M140 80V320M320 80V320M500 80V320"/>',
    'F.SilkS': '<rect x="225" y="120" width="170" height="160"/><rect x="475" y="120" width="130" height="130"/>',
    'Edge.Cuts': '<rect width="640" height="400" rx="22"/>',
  }[layer];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640"><g transform="translate(160 120)" fill="none" stroke="white" stroke-width="6">${geometry ?? ''}</g></svg>`;
}
const fixtureStateKey = Symbol.for('firstlight.ux-preview.synthetic-runs');
const liveRuns = globalThis[fixtureStateKey] ??= new Map();
export function rememberBuild(id, state) {
  const run = { ...syntheticRun(state === 'passed' ? 'completed' : state === 'failed' ? 'partial' : 'building'), id, runDir: `/runs/${id}`, name: `Synthetic live ${state} board` };
  liveRuns.set(id, run);
  while (liveRuns.size > 20) liveRuns.delete(liveRuns.keys().next().value);
  return run;
}
export function rememberImport(id, imported) {
  const run = rememberBuild(id, 'running');
  Object.assign(run, { name: 'Synthetic imported design', status: 'IMPORTED', stages: [], imported });
  return run;
}
export function buildRuns() { return [...liveRuns.values()]; }
export function fixtureSpec(name = 'Synthetic fixture sensor') {
  const inactive = { status: 'not_applicable', summary: 'Outside this offline fixture', requirements: [] };
  return { product: name, description: 'Explicit offline build demonstration. No tools execute.', budgets: { sizeMm: { x: 48, y: 32 } }, disciplines: {
    electronics: { status: 'defined', summary: 'Synthetic electronics', boardIntent: 'Synthetic preview sensor board', keyBlocks: ['Power', 'Sensor'], layers: 2 },
    mechanical: inactive, firmware: inactive, manufacturing: inactive, supplyChain: inactive, validation: inactive,
  }, openQuestions: [] };
}
const supported = new Set(['completed', 'partial', 'building', 'missing', 'model-a', 'model-b']);
export const fixtureRunId = id => /^ux-(completed|partial|building|missing|model-a|model-b)$/.test(id) || liveRuns.has(id);
export function fixtureTiming(id) {
  const at = '2026-09-13T12:00:00Z';
  const stages = ['electronics', 'mechanical', 'simulation', 'firmware', 'manufacturing', 'supplyChain', 'validation'];
  const running = id === 'ux-building' || liveRuns.get(id)?.status === 'RUNNING';
  const failed = id === 'ux-partial' || liveRuns.get(id)?.status === 'GATE FAILED';
  return { runId: id, startedAt: at, ...(!running ? { finishedAt: '2026-09-13T12:01:00Z', totalMs: 60000 } : {}), stages: stages.map((stage, index) => ({
    stage, startedAt: at,
    status: running ? (index === 0 ? 'running' : 'pending') : failed && index === 1 ? 'failed' : index === 0 ? 'passed' : 'skipped',
    ...(running ? { unfinished: true } : { endedAt: '2026-09-13T12:01:00Z', ms: 1000 }),
    detail: 'Synthetic recorded attempt. No engineering verification performed.',
  })) };
}
export function fixtureTree(id) {
  if (!fixtureRunId(id)) return null;
  const leaf = (path, size = 128) => ({ name: path.split('/').at(-1), path, dir: false, size });
  const imported = liveRuns.get(id)?.imported;
  if (imported) {
    const tree = [leaf('README.md'), leaf('notes.txt'),
      { name: 'data', path: 'data', dir: true, children: [leaf('data/board.json')] },
      ...(imported.pcb ? [leaf('variant.kicad_pcb')] : []),
      ...(imported.step ? [{ name: 'mechanical', path: 'mechanical', dir: true, children: [leaf('mechanical/enclosure.step')] }] : []),
    ];
    return { runId: id, files: 3 + Number(imported.pcb) + Number(imported.step), tree };
  }
  return { runId: id, files: 6, tree: [
    leaf('README.md'), leaf('notes.txt'), leaf('fabrication.zip', 4),
    { name: 'data', path: 'data', dir: true, children: [leaf('data/board.json', 900), leaf('data/parts.csv')] },
    { name: 'board', path: 'board', dir: true, children: [leaf('board/render-top.png', 2048)] },
  ] };
}
export function syntheticRun(scenario) {
  if (!supported.has(scenario)) return null;
  const id = `ux-${scenario}`;
  return {
    id, name: `Synthetic ${scenario} board`, timestamp: '2026-09-13T12:00:00Z',
    status: scenario === 'building' ? 'RUNNING' : scenario === 'completed' ? 'PASSED' : 'GATE FAILED',
    prompt: 'Synthetic preview fixture. Not a manufactured or validated board.', real: true, runDir: `/runs/${id}`,
    ...(scenario === 'partial' ? { failure: 'Synthetic downstream failure. Previously generated illustration remains available.' } : {}),
    stages: ['design', 'placement', 'routing', 'validation', 'firmware'].map((id, i) => ({ id, state: scenario === 'building' ? i === 0 ? 'passed' : i === 1 ? 'running' : 'pending' : scenario === 'completed' ? 'passed' : i < 2 ? 'passed' : 'failed', elapsedMs: 0 })),
    metrics: { netsRouted: 5, netsTotal: 6, copperDefects: 1, hpwl: 100, hpwlHistory: [100], components: 8, bomLines: 0, boardSize: '48 × 32 mm', layers: 2, routeTimeSec: 0 },
    logs: [{ stage: 'design', prefix: 'preview', text: 'Synthetic snapshot only. No tools executed.', level: 'info' }],
  };
}
export function artifactRequest(request) {
  const url = new URL(request.url);
  const match = /^\/runs\/(ux-(?:completed|partial|building|missing|model-a|model-b)|run-[a-f0-9-]{36})\/(.+)$/.exec(url.pathname);
  const headers = { 'Cache-Control': 'no-store', 'X-UI-Preview': 'synthetic-only' };
  const id = match?.[1];
  if (!['GET', 'HEAD'].includes(request.method) || !match || id === 'ux-missing' || (id.startsWith('run-') && !liveRuns.has(id))) return Response.json({ error: 'Preview artifact unavailable', preview: true }, { status: 404, headers });
  const artifact = match[2];
  const imported = liveRuns.get(id)?.imported;
  if (imported) {
    const at = '2026-09-13T12:00:00Z';
    const records = {
      'product-spec.json': { product: 'Synthetic imported design', source: 'import', imported: true, createdAt: at },
      'data/board.json': { source: 'manual-import', imported: true, analysisError: 'Synthetic fixture: native analysis not executed.' },
      ...(imported.pcb ? { 'electronics/chipscale-board.json': { boardMm: [40, 30], components: 1, netsTotal: null, netsRouted: null, drc: null, boardSource: 'manual-import', imported: true, manualImport: { kind: 'pcb', at } } } : {}),
      ...(imported.step ? { 'mechanical/mechanical.json': { source: 'manual-import', imported: true, fitCheck: null, manualImport: { kind: 'step', at } } } : {}),
    };
    if (Object.hasOwn(records, artifact)) return new Response(request.method === 'HEAD' ? null : JSON.stringify(records[artifact]), { headers: { ...headers, 'Content-Type': 'application/json' } });
    if ((imported.pcb && artifact === 'variant.kicad_pcb') || (imported.step && artifact === 'mechanical/enclosure.step')) return new Response(request.method === 'HEAD' ? null : 'SYNTHETIC UI FIXTURE\nNot a native design file.', { headers: { ...headers, 'Content-Type': 'application/octet-stream' } });
    // Imported artifacts do not fabricate timing, DRC or generated render evidence.
    if (artifact !== 'README.md' && artifact !== 'notes.txt') return Response.json({ error: 'Preview import artifact unavailable', preview: true }, { status: 404, headers });
  }
  if (id.startsWith('ux-model-') && artifact === 'mechanical/enclosure.glb') return new Response(request.method === 'HEAD' ? null : createModelGlb(id === 'ux-model-b' ? 'B' : 'A'), { headers: { ...headers, 'Content-Type': MODEL_GLB_CONTENT_TYPE } });
  const textFiles = {
    'README.md': `# Synthetic design ${id}\n\nThis hand-authored fixture is not a validated board.\n\n- Preview files safely\n- No private artifacts\n`,
    'notes.txt': `Synthetic notes belonging only to ${id}.`,
    'data/parts.csv': 'Reference,Description\nU1,Synthetic sensor\nR1,Synthetic resistor\n',
  };
  if (Object.hasOwn(textFiles, artifact)) return new Response(request.method === 'HEAD' ? null : textFiles[artifact], { headers: { ...headers, 'Content-Type': 'text/plain' } });
  if (artifact === 'fabrication.zip') return new Response(request.method === 'HEAD' ? null : new Uint8Array([80, 75, 5, 6]), { headers: { ...headers, 'Content-Type': 'application/octet-stream' } });
  if (/^board\/render-(top|bottom)\.png$/.test(artifact)) {
    return new Response(request.method === 'HEAD' ? null : illustration(artifact.includes('bottom') ? 'bottom' : 'top'), { headers: { ...headers, 'Content-Type': 'image/svg+xml' } });
  }
  const layer = /^board\/(F\.Cu|B\.Cu|In1\.Cu|In2\.Cu|F\.SilkS|Edge\.Cuts)\.svg$/.exec(artifact);
  if (layer) return new Response(request.method === 'HEAD' ? null : layerIllustration(layer[1]), { headers: { ...headers, 'Content-Type': 'image/svg+xml' } });
  const fixtureBoard = id.startsWith('ux-model-') ? { ...board, boardSize: { wMm: id === 'ux-model-b' ? 50 : 40, hMm: 30 }, components: 1 }
    : id === 'ux-partial' ? { ...board, boardSize: { wMm: 62, hMm: 24 }, components: 12 } : board;
  if (artifact === 'electronics/chipscale.svg' && id.startsWith('ux-model-')) return new Response(request.method === 'HEAD' ? null : illustration(), { headers: { ...headers, 'Content-Type': 'image/svg+xml' } });
  const known = { 'timing.json': fixtureTiming(id),
    ...(id.startsWith('ux-model-') ? { 'mechanical/mechanical.json': {
      ok: true, part: 'Synthetic viewer geometry, not an enclosure design', gltfUrl: `/runs/${id}/mechanical/enclosure.glb`, stepUrl: null, fitCheck: null,
    }, 'electronics/chipscale-board.json': {
      ok: true, boardMm: { w: fixtureBoard.boardSize.wMm, h: fixtureBoard.boardSize.hMm }, components: fixtureBoard.components,
      routedTraces: 12, errors: {}, drc: { available: false, reason: 'Synthetic UI geometry only; native tools were not executed.' },
    } } : {}),
    'data/board.json': fixtureBoard, 'data/bom.json': [], 'data/ato.json': [],
    'data/drc.json': { violations: fixtureBoard.drc.violationSummaries.map(item => ({ ...item, severity: 'error' })), unconnected_items: [{ description: 'Synthetic open connection' }] },
    'product-spec.json': fixtureSpec(id === 'ux-partial' ? 'Synthetic isolation board B' : 'Synthetic isolation board A') };

  if (Object.hasOwn(known, artifact)) return new Response(request.method === 'HEAD' ? null : JSON.stringify(known[artifact]), { headers: { ...headers, 'Content-Type': 'application/json' } });
  return Response.json({ error: 'Preview artifact unavailable', preview: true }, { status: 404, headers });
}
