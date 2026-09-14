import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Explicit schema-shaped unit fixtures, not native-run receipts or user artifacts.
// Only this source module is read; no runtime, native, network, or run-store I/O.
const source = fs.readFileSync(new URL('../lib/astra-drc.ts', import.meta.url), 'utf8')
const exports = {}
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: name => { throw Error(`Unexpected runtime dependency ${name}`) } })
const { parseAstraDrcReport, ASTRA_DRC_SCHEMA } = exports
const context = { engineVersion: '10.0.5', source: 'final-board.kicad_pcb', schematicParity: 'not-run' }
const report = (overrides = {}) => ({
  $schema: ASTRA_DRC_SCHEMA, source: 'final-board.kicad_pcb', date: '2026-09-13T11:42:08', kicad_version: '10.0.5',
  violations: [], unconnected_items: [], schematic_parity: [], coordinate_units: 'mm',
  included_severities: ['error', 'warning', 'exclusion'], ignored_checks: [], ...overrides,
})
const item = (overrides = {}) => ({ uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', description: 'Fixture pad', pos: { x: 2.3, y: -4.1 }, ...overrides })
const violation = (overrides = {}) => ({ type: 'clearance', description: 'Fixture clearance', severity: 'error', items: [item()], ...overrides })
const parse = value => parseAstraDrcReport(value, context)
const plain = value => JSON.parse(JSON.stringify(value))

test('complete full-severity report establishes native checks only, parity remains not-run', () => {
  const result = parse(report())
  assert.equal(result.available, true)
  assert.equal(result.errors, 0)
  assert.equal(result.warnings, 0)
  assert.equal(result.unrouted, 0)
  assert.equal(result.checksComplete, true)
  assert.equal(result.passed, true)
  assert.equal(result.schematicParity, 'not-run')
  assert.deepEqual(plain(result.provenance), { schema: ASTRA_DRC_SCHEMA, engineVersion: '10.0.5', source: 'final-board.kicad_pcb', date: '2026-09-13T11:42:08', coordinateUnits: 'mm' })
})

test('absent and incomplete reports never become successful empty-array counts', () => {
  for (const value of [null, [], {}, { violations: [], unconnected_items: [] }]) assert.throws(() => parse(value))
  for (const key of Object.keys(report())) {
    const value = report(); delete value[key]
    assert.throws(() => parse(value), key)
  }
  assert.throws(() => parse(report({ invented: true })))
})

test('schema revision and generating-engine version are distinct exact identities', () => {
  for (const overrides of [{ $schema: 'https://schemas.kicad.org/drc.v2.json' }, { $schema: 'drc.v1' }, { kicad_version: '10.0.1' }, { kicad_version: '10.0.5+fixture' }, { source: '/private/final-board.kicad_pcb' }, { source: 'other.kicad_pcb' }, { version: 1 }, { type: 'drc' }]) assert.throws(() => parse(report(overrides)))
  for (const overrides of [{ engineVersion: '10.0.1' }, { source: 'other.kicad_pcb' }, { schematicParity: 'passed' }]) assert.throws(() => parseAstraDrcReport(report(), { ...context, ...overrides }))
})

test('date follows actual local ISOCombined output, never fabricated UTC or invalid calendar dates', () => {
  for (const date of ['bad', '', '2026-09-13', '2026-02-30T12:00:00', '2026-09-13T25:00:00', '2026-09-13T11:42:08Z', 123]) assert.throws(() => parse(report({ date })))
  assert.equal(parse(report({ date: '2024-02-29T00:00:00' })).provenance.date, '2024-02-29T00:00:00')
  for (const coordinate_units of ['in', 'mils', 'unknown', null]) assert.throws(() => parse(report({ coordinate_units })))
})

test('full severity coverage required, including excluded findings', () => {
  for (const included_severities of [[], ['error'], ['error', 'warning'], ['error', 'error', 'warning'], ['error', 'warning', 'exclusion', 'ignore'], null]) assert.throws(() => parse(report({ included_severities })))
  assert.equal(parse(report({ included_severities: ['exclusion', 'warning', 'error'] })).passed, true)
})

test('all sections require complete typed violations and native affected-item fields', () => {
  const malformed = [null, {}, violation({ severity: 'exclusion' }), violation({ severity: 'ignore' }), violation({ type: '' }), violation({ description: 2 }), violation({ items: null }), violation({ excluded: 'true' }), violation({ comment: 2 }), violation({ extra: true }), violation({ items: [item({ uuid: 'bad' })] }), violation({ items: [item({ description: null })] }), violation({ items: [item({ pos: { x: 0 } })] }), violation({ items: [item({ pos: { x: NaN, y: 0 } })] }), violation({ items: [item({ pos: { x: 0, y: Infinity } })] }), violation({ items: [item({ pos: { x: 0, y: 0, z: 0 } })] }), violation({ items: [item({ extra: true })] })]
  for (const section of ['violations', 'unconnected_items', 'schematic_parity']) {
    for (const entry of malformed) assert.throws(() => parse(report({ [section]: [entry] })), section)
    assert.throws(() => parse(report({ [section]: {} })))
  }
  // Upstream may report a finding without a mapped affected EDA_ITEM.
  assert.equal(parse(report({ violations: [violation({ items: [] })] })).errors, 1)
})

test('connectivity findings remain separate from DRC errors, with no double counting', () => {
  const result = parse(report({ violations: [violation(), violation({ severity: 'warning' })], unconnected_items: [violation({ type: 'unconnected_items' }), violation({ type: 'unconnected_items', severity: 'warning' })] }))
  assert.equal(result.errors, 1)
  assert.equal(result.warnings, 1)
  assert.equal(result.unrouted, 2)
  assert.equal(result.passed, false)
  assert.deepEqual(plain(result.rawCounts), { violations: { total: 2, errors: 1, warnings: 1, excluded: 0 }, unconnected_items: { total: 2, errors: 1, warnings: 1, excluded: 0 }, schematic_parity: { total: 0, errors: 0, warnings: 0, excluded: 0 } })
})

test('excluded findings retain original severity and prevent completeness, never waive defects', () => {
  const result = parse(report({ violations: [violation({ excluded: true, comment: 'fixture exclusion' }), violation({ severity: 'warning', excluded: true })], unconnected_items: [violation({ type: 'unconnected_items', excluded: true })] }))
  assert.equal(result.errors, 1)
  assert.equal(result.warnings, 1)
  assert.equal(result.unrouted, 1)
  assert.equal(result.checksComplete, false)
  assert.equal(result.passed, false)
  assert.deepEqual(plain(result.excludedCounts), { violations: 2, unconnected_items: 1, schematic_parity: 0, total: 3 })
  const warning = parse(report({ violations: [violation({ severity: 'warning', excluded: true })] }))
  assert.equal(warning.errors, 0)
  assert.equal(warning.checksComplete, false)
  assert.equal(warning.passed, false)
})

test('ignored checks prevent pass without changing observed defect counts', () => {
  const ignored_checks = [{ key: 'clearance', description: 'Fixture ignored clearance check' }]
  const result = parse(report({ ignored_checks }))
  assert.equal(result.errors, 0)
  assert.equal(result.unrouted, 0)
  assert.equal(result.checksComplete, false)
  assert.equal(result.passed, false)
  assert.deepEqual(plain(result.ignoredChecks), ignored_checks)
  for (const ignored_checks of [null, [null], [{}], [{ key: 'x' }], [{ key: '', description: 'x' }], [{ key: 'x', description: 1 }]]) assert.throws(() => parse(report({ ignored_checks })))
})

test('unexpected parity evidence blocks completeness without falsely claiming parity ran or passed', () => {
  const result = parse(report({ schematic_parity: [violation({ type: 'missing_footprint' })] }))
  assert.equal(result.schematicParity, 'not-run')
  assert.equal(result.rawCounts.schematic_parity.errors, 1)
  assert.equal(result.errors, 0)
  assert.equal(result.checksComplete, false)
  assert.equal(result.passed, false)
})

test('ordinary warnings are retained but not converted into copper errors', () => {
  const result = parse(report({ violations: [violation({ severity: 'warning' })] }))
  assert.equal(result.errors, 0)
  assert.equal(result.warnings, 1)
  assert.equal(result.checksComplete, true)
  assert.equal(result.passed, true)
})
