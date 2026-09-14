import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Only source is read. Every artifact is hand-authored and fetch is intercepted;
// no run store, environment, native tools, provider, browser or network is used.
const source = readFileSync(new URL('../lib/real-board.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText
const base = '/runs/synthetic-import'
function analyzed() {
  return {
    source: 'synthetic.kicad_pcb', boardSize: { wMm: 40, hMm: 30 }, layers: 2,
    components: 2, netsTotal: 3, netsRouted: 3, unroutedNets: [], zoneServedNets: [],
    tracks: 4, vias: 1, hpwlMm: 12.5,
    placement: { overlaps: 0, overlapPairs: [], offBoard: [] },
    drc: { violations: 0, violationSummaries: [], unconnectedItems: 0, kicadVersion: 'synthetic', date: '2026-09-13' },
  }
}
function loader(records, root = base) {
  const requests = []
  const exports = {}
  vm.runInNewContext(code, { exports, AbortSignal, fetch: async url => {
    requests.push(url)
    assert.ok(url.startsWith(`${root}/`), `Unexpected snapshot: ${url}`)
    const value = records[url.slice(root.length + 1)]
    if (value instanceof Error) throw value
    return { ok: value !== undefined, status: value === undefined ? 404 : 200, json: async () => {
      if (value === 'invalid-json') throw new SyntaxError('Invalid JSON')
      return structuredClone(value)
    } }
  } })
  return { load: () => exports.loadRealBoard(root), requests }
}

for (const analysisError of [undefined, 'Board analysis is not available on this deployment.', 'Could not read this board file']) {
  test(`sparse PCB import returns unavailable reports, not invented metrics (${analysisError ?? 'no error field'})`, async () => {
    const board = { source: 'manual-import', imported: true, ...(analysisError ? { analysisError } : {}) }
    const read = loader({
      'data/board.json': board,
      'electronics/chipscale-board.json': {
        boardMm: [40, 30], components: 1, netsTotal: null, netsRouted: null, drc: null,
        boardSource: 'manual-import', imported: true, manualImport: { kind: 'pcb', at: '2026-09-13T12:00:00Z' },
      },
    })
    assert.equal(await read.load(), null)
    assert.deepEqual(read.requests, [`${base}/data/board.json`])
    assert.equal(board.placement, undefined)
  })
}

test('STEP-only actual writer and sparse combined-import fixture do not require board reports', async () => {
  const mechanical = { source: 'manual-import', imported: true, fitCheck: null, manualImport: { kind: 'step', at: '2026-09-13T12:00:00Z' } }
  assert.equal(await loader({ 'mechanical/mechanical.json': mechanical }).load(), null)
  assert.equal(await loader({ 'data/board.json': { source: 'manual-import', imported: true, analysisError: 'Synthetic fixture: native analysis not executed.' }, 'mechanical/mechanical.json': mechanical }).load(), null)
})

test('even an analyzed import cannot acquire FL-1 design, firmware or routing-history passes', async () => {
  for (const marker of [{ imported: true }, { source: 'manual-import' }, { analysisError: 'Analysis failed' }]) {
    assert.equal(await loader({ 'data/board.json': { ...analyzed(), ...marker } }).load(), null)
  }
})

test('malformed or incomplete analysis is unavailable and never throws', async () => {
  for (const board of [null, [], true, 12, 'wrong', {}, { source: 'board' },
    ...[undefined, null, [], {}, { overlaps: 0, offBoard: 'bad', overlapPairs: [] }].map(placement => ({ ...analyzed(), placement })),
    { ...analyzed(), drc: { violations: 0 } },
    { ...analyzed(), drc: { ...analyzed().drc, violationSummaries: [null] } },
    { ...analyzed(), boardSize: [40, 30] },
    { ...analyzed(), source: 1 }, { ...analyzed(), netsRouted: 4 },
    { ...analyzed(), tracks: -1 }, { ...analyzed(), hpwlMm: Infinity },
    { ...analyzed(), unroutedNets: [null] }, { ...analyzed(), layers: 0 },
  ]) assert.equal(await loader({ 'data/board.json': board }).load(), null)
})

test('missing, failed and invalid JSON reads return unavailable', async () => {
  for (const value of [undefined, new Error('Offline'), 'invalid-json']) {
    assert.equal(await loader({ 'data/board.json': value }).load(), null)
  }
})

test('complete ordinary analysis keeps actual dimensions, reports, metrics and base identity', async () => {
  const board = analyzed()
  const bom = [{ ref: 'R1', part: 'Synthetic resistor', lcsc: '', qty: 1, unitPrice: 0, lineType: 'buyer-furnished' }]
  const ato = [{ name: 'main.ato', content: '# synthetic' }]
  const result = await loader({ 'data/board.json': board, 'data/bom.json': bom, 'data/ato.json': ato }).load()
  assert.equal(result.base, base)
  assert.deepEqual(result.board, board)
  assert.deepEqual(result.bom, bom)
  assert.deepEqual(result.ato, ato)
  assert.equal(result.run.status, 'PASSED')
  assert.equal(result.run.metrics.boardSize, '40 × 30 mm')
  assert.equal(result.run.metrics.hpwl, 12.5)
  assert.equal(result.reports.length, 3)
  assert.ok(result.reports.every(report => report.checks.every(check => check.pass)))
})

test('measured placement and DRC failures remain failed', async () => {
  const board = analyzed()
  board.placement = { overlaps: 1, overlapPairs: ['R1/R2'], offBoard: ['R2'] }
  board.drc = { ...board.drc, violations: 2, unconnectedItems: 1, violationSummaries: [{ type: 'shorting_items', description: 'Synthetic short' }] }
  const result = await loader({ 'data/board.json': board }).load()
  assert.equal(result.run.status, 'GATE FAILED')
  assert.equal(result.reports[0].checks[0].pass, false)
  assert.equal(result.reports[2].checks[0].pass, false)
  assert.equal(result.reports[2].checks[1].pass, false)
  assert.match(result.reports[2].checks[0].measured, /2: shorting_items/)
})

test('optional malformed BOM and source files do not leak invalid payloads to panels', async () => {
  for (const value of [{ error: 'not available' }, [null], [1], [{}]]) {
    const result = await loader({ 'data/board.json': analyzed(), 'data/bom.json': value, 'data/ato.json': value }).load()
    assert.equal(result.bom, null)
    assert.equal(result.ato, null)
  }
})

test('sparse and malformed chip metadata cannot invent a clean shipped-board report', async () => {
  for (const chip of [null, [], { drc: { available: true } },
    { drc: { available: 'yes', errors: 0, errorTypes: {} } },
    { drc: { available: true, errors: -1, errorTypes: {} } },
    { drc: { available: true, errors: 0, errorTypes: { unconnected_items: 'bad' } } },
    { imported: true, boardMm: [40, 30], components: null, drc: null },
  ]) {
    const result = await loader({ 'data/board.json': analyzed(), 'electronics/chipscale-board.json': chip }).load()
    assert.equal(result.reports.length, 3)
    assert.equal(result.board.source, 'synthetic.kicad_pcb')
  }
})

test('valid chip analysis retains independent measured failures and dimensions', async () => {
  const result = await loader({ 'data/board.json': analyzed(), 'electronics/chipscale-board.json': {
    boardMm: { w: 24, h: 16 }, components: 4,
    drc: { available: true, errors: 2, errorTypes: { unconnected_items: 2 }, ruleProfile: 'synthetic profile' },
  } }).load()
  assert.equal(result.board.boardSize.wMm, 24)
  assert.equal(result.board.components, 4)
  assert.equal(result.reports.length, 4)
  assert.equal(result.reports[0].checks[0].pass, false)
  assert.equal(result.reports[0].checks[1].pass, false)
})

test('invalid chip dimensions do not replace validated board measurements', async () => {
  for (const boardMm of [{ w: '24', h: 16 }, { w: Infinity, h: 16 }, { w: -1, h: 16 }, [24, 16]]) {
    const result = await loader({ 'data/board.json': analyzed(), 'electronics/chipscale-board.json': { boardMm, components: 'bad' } }).load()
    assert.equal(result.board.boardSize.wMm, 40)
    assert.equal(result.board.components, 2)
  }
})

test('shared latest loading does not request another snapshot or chip artifact', async () => {
  const read = loader({ 'data/board.json': analyzed() }, '')
  assert.equal((await read.load()).base, '')
  assert.deepEqual(read.requests, ['/data/board.json', '/data/bom.json', '/data/ato.json'])
})

test('read errors report HTTP, network and invalid JSON without confusing absent or sparse imports', async () => {
  for (const kind of ['http', 'network', 'json', 'absent', 'sparse', 'import']) {
    let errors = 0
    const exports = {}
    vm.runInNewContext(code, { exports, AbortSignal, fetch: async (url, options) => {
      assert.ok(options.signal instanceof AbortSignal)
      assert.equal(options.cache, 'no-store')
      if (kind === 'network') throw Error('offline')
      return { ok: !['http', 'absent'].includes(kind), status: kind === 'http' ? 500 : kind === 'absent' ? 404 : 200,
        json: async () => { if (kind === 'json') throw SyntaxError('bad JSON'); return kind === 'import' ? { imported: true, source: 'manual-import' } : {} },
      }
    } })
    assert.equal(await exports.loadRealBoard(base, () => { errors++ }), null)
    assert.equal(errors, ['http', 'network', 'json'].includes(kind) ? 1 : 0, kind)
  }
})
