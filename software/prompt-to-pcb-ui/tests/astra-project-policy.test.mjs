import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Source and catalog JSON only; no runtime filesystem, native execution or network.
const catalog = JSON.parse(readFileSync(new URL('../lib/astra-catalog.json', import.meta.url), 'utf8'))
const compiled = ts.transpileModule(readFileSync(new URL('../lib/astra-project-policy.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText
class AstraError extends Error {
  constructor(category, message) { super(message); this.category = category }
}
const category = name => error => error?.category === name
const checks = ['missing_courtyard', 'track_not_centered_on_via', 'tuning_profile_track_geometries', 'footprint_filters_mismatch', 'footprint_type_mismatch']
const limits = { min_clearance: 0.15, min_track_width: 0.15, min_via_diameter: 0.6, min_through_hole_diameter: 0.3, min_via_annular_width: 0.15, min_hole_clearance: 0.25, min_hole_to_hole: 0.25, min_copper_edge_clearance: 0.5 }
const project = () => ({ board: { design_settings: {
  rule_severities: Object.fromEntries(checks.map(name => [name, 'error'])),
  rules: { ...limits, min_resolved_spokes: 2 }, drc_exclusions: [],
} } })
function fixture(assets = catalog.assets) {
  const dependencies = { './astra-execution': { AstraError }, './astra-local-parts': { ASTRA_CATALOG: { assets } } }
  const loaded = { exports: {} }
  const require = name => { assert.ok(Object.hasOwn(dependencies, name), `Unmocked dependency ${name}`); return dependencies[name] }
  const context = vm.createContext({ Error })
  vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename: 'lib/astra-project-policy.ts' })(require, loaded, loaded.exports)
  return loaded.exports
}

test('project policy accepts exact fabrication limits and enabled checks without repairing input', () => {
  const { validateAstraProjectPolicy } = fixture()
  const value = project()
  value.board.design_settings.rule_severities.extra_check = 'warning'
  const before = JSON.stringify(value)
  assert.equal(validateAstraProjectPolicy(value), undefined)
  assert.equal(JSON.stringify(value), before)
})

test('project policy rejects malformed structure, exclusions and absent mandatory fields', () => {
  const { validateAstraProjectPolicy } = fixture()
  for (const value of [null, [], {}, { board: null }, { board: [] }, { board: {} }, { board: { design_settings: [] } }]) {
    assert.throws(() => validateAstraProjectPolicy(value), category('output'))
  }
  for (const key of ['rule_severities', 'rules', 'drc_exclusions']) {
    const value = project()
    delete value.board.design_settings[key]
    assert.throws(() => validateAstraProjectPolicy(value), category('output'))
    for (const malformed of [null, false, '0']) {
      const value = project()
      value.board.design_settings[key] = malformed
      assert.throws(() => validateAstraProjectPolicy(value), category('output'))
    }
  }
  for (const exclusions of [['suppressed'], [null], {}, 0]) {
    const value = project()
    value.board.design_settings.drc_exclusions = exclusions
    assert.throws(() => validateAstraProjectPolicy(value), category('output'))
  }
})

test('all five required checks must remain errors and no additional rule may be ignored', () => {
  const { validateAstraProjectPolicy } = fixture()
  for (const key of checks) {
    for (const severity of [undefined, 'warning', 'ignore', 'exclusion', 'ERROR', false, 0, null, ['error']]) {
      const value = project()
      if (severity === undefined) delete value.board.design_settings.rule_severities[key]
      else value.board.design_settings.rule_severities[key] = severity
      assert.throws(() => validateAstraProjectPolicy(value), category('output'), key)
    }
  }
  for (const severity of ['ignore', 'exclusion', null, 0, ['warning']]) {
    const value = project()
    value.board.design_settings.rule_severities.additional_check = severity
    assert.throws(() => validateAstraProjectPolicy(value), category('output'))
  }
})

test('every fabrication limit and two resolved spokes are exact, finite numeric requirements', () => {
  const { validateAstraProjectPolicy } = fixture()
  for (const [key, expected] of Object.entries({ ...limits, min_resolved_spokes: 2 })) {
    for (const invalid of [undefined, 0, -1, expected / 2, expected * 2, String(expected), null, false, Infinity, NaN]) {
      const value = project()
      if (invalid === undefined) delete value.board.design_settings.rules[key]
      else value.board.design_settings.rules[key] = invalid
      assert.throws(() => validateAstraProjectPolicy(value), category('output'), `${key}: ${String(invalid)}`)
    }
  }
})

test('reviewed footprint table is exact sorted deduplicated KiCad v7 with pinned catalog URIs', () => {
  const table = fixture().expectedAstraFootprintTable()
  const libraries = [...new Set(Object.values(catalog.assets).map(asset => asset.footprint.libraryPath))]
    .map(directory => [directory.split('/').at(-1).replace(/\.pretty$/, ''), directory])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const expected = `(fp_lib_table\n  (version 7)\n${libraries.map(([name, directory]) => `  (lib (name ${JSON.stringify(name)})(type KiCad)(uri ${JSON.stringify(directory)})(options "")(descr ""))\n`).join('')})\n`
  assert.equal(table, expected)
  assert.equal((table.match(/\(lib \(name /g) || []).length, libraries.length)
  assert.equal(table.includes('https://'), false)
  assert.equal(table.includes('${'), false)
})

test('footprint table escapes literal paths, sorts names and refuses same-name URI conflicts', () => {
  const asset = libraryPath => ({ footprint: { libraryPath } })
  const assets = { z: asset('/reviewed/Z.pretty'), a: asset('/reviewed/A.pretty'), duplicate: asset('/reviewed/A.pretty') }
  const table = fixture(assets).expectedAstraFootprintTable()
  assert.ok(table.indexOf('(name "A")') < table.indexOf('(name "Z")'))
  assert.equal((table.match(/\(name "A"\)/g) || []).length, 1)
  const escaped = fixture({ quoted: asset('/reviewed/a"b.pretty') }).expectedAstraFootprintTable()
  assert.ok(escaped.includes('(uri "/reviewed/a\\"b.pretty")'))
  assert.throws(() => fixture({ a: asset('/reviewed/A.pretty'), b: asset('/unreviewed/A.pretty') }).expectedAstraFootprintTable(), category('policy'))
})
