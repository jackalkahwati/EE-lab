import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

// Browser-safe source module only; no providers, native builds or run stores.
const source = fs.readFileSync(new URL('../lib/astra-design-contract.ts', import.meta.url), 'utf8')
const exports = {}
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText, { exports, structuredClone, require: name => { throw Error(`Unexpected runtime import ${name}`) } })
const { ASTRA_DESIGN_TEMPLATE: template, ASTRA_ARCHITECT_SYSTEM: system, validateAstraArchitectRequest: request, validateAstraSpecification: validate } = exports
const clone = value => JSON.parse(JSON.stringify(value))
function validRequest() { return { templateId: template.id, request: template.prompt, answers: [] } }
function specification() {
  return {
    product: 'Model-authored breakout name', description: 'External host environmental sensor breakout.',
    budgets: {}, disciplines: {
      electronics: { status: 'defined', summary: 'BME280 sensor and I2C interface.', boardIntent: 'A compact externally powered sensor breakout.', maxBoardMm: { x: 24, y: 18 }, layers: 2, contract: clone(template.electricalContract) },
      ...Object.fromEntries(['mechanical', 'firmware', 'manufacturing', 'supplyChain', 'validation'].map(name => [name, { status: 'not_applicable', summary: 'Not requested; not run.', requirements: [] }])),
    },
  }
}
const rejected = value => assert.throws(() => validate(value, template.id), error => error.category === 'policy')

test('explicit fixed template request is accepted without inventing spec or netlist', () => {
  assert.deepEqual(clone(request(validRequest())), validRequest())
  assert.equal(template.id, 'bme280-3v3-i2c-0x76-v1')
  assert.deepEqual(clone(template.board), { widthMm: 24, heightMm: 18, layers: 2 })
  assert.ok(Object.isFrozen(template.electricalContract.supply))
  assert.ok(Object.isFrozen(template.electricalContract.headerPins))
  assert.match(template.notice, /does not convert/)
  assert.match(template.prompt, /24mm by 18mm/)
  assert.match(template.prompt, /0x76/)
})

test('arbitrary draft with matching template ID never becomes the template silently', () => {
  for (const mutate of [
    x => { x.request = 'Build a battery powered drone' },
    x => { x.request += ' Add WiFi.' }, x => { x.request = x.request.replace('3.3V', '5V') },
    x => { delete x.templateId }, x => { x.templateId = 'other' },
    x => { x.answers = [{ answer: 'Add a battery' }] }, x => { delete x.answers },
    x => { x.idBrief = {} }, x => { x.force = true }, x => { x.request = null },
  ]) {
    const value = validRequest(); mutate(value)
    assert.throws(() => request(value), error => error.category === 'policy')
  }
  for (const value of [null, [], {}, 1, 'BME280']) assert.throws(() => request(value), error => error.category === 'policy')
})

test('raw model spec is preserved and cloned; prose is authored rather than exact canned text', () => {
  const original = specification()
  const result = validate(original, template.id)
  assert.deepEqual(clone(result), original)
  result.product = 'Mutation'
  result.disciplines.electronics.contract.supply.nominalV = 5
  assert.equal(original.product, 'Model-authored breakout name')
  assert.equal(original.disciplines.electronics.contract.supply.nominalV, 3.3)
  original.budgets = { sizeMm: { x: 24, y: 18 } }
  original.openQuestions = []
  original.disciplines.electronics.keyBlocks = ['Sensor', 'External host interface']
  assert.deepEqual(clone(validate(original, template.id)), original)
  assert.throws(() => validate(original, undefined), error => error.category === 'policy')
  assert.throws(() => validate(original, 'other'), error => error.category === 'policy')
})

test('every missing, extra or changed machine contract field is rejected without normalization', () => {
  function paths(value, prefix = []) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value).flatMap(([key, item]) => paths(item, [...prefix, key]))
    return [prefix]
  }
  for (const path of paths(template.electricalContract)) {
    for (const mode of ['missing', 'changed']) {
      const value = specification()
      let parent = value.disciplines.electronics.contract
      for (const key of path.slice(0, -1)) parent = parent[key]
      const key = path.at(-1)
      if (mode === 'missing') delete parent[key]
      else parent[key] = typeof parent[key] === 'number' ? parent[key] + 1 : 'unsupported'
      rejected(value)
    }
  }
  const extra = specification(); extra.disciplines.electronics.contract.power = 'battery'; rejected(extra)
  const nested = specification(); nested.disciplines.electronics.contract.supply.batteryMah = 100; rejected(nested)
  const swapped = specification(); swapped.disciplines.electronics.contract.headerPins.reverse(); rejected(swapped)
  const numericString = specification(); numericString.disciplines.electronics.contract.supply.nominalV = '3.3'; rejected(numericString)
})

test('missing and unsupported scopes, dimensions, budgets and statuses are rejected', () => {
  for (const mutate of [
    s => { delete s.disciplines }, s => { delete s.disciplines.electronics },
    s => { delete s.disciplines.mechanical }, s => { delete s.disciplines.electronics.contract },
    s => { s.disciplines.electronics.layers = 4 }, s => { s.disciplines.electronics.layers = '2' },
    s => { s.disciplines.electronics.maxBoardMm.x = 18 }, s => { delete s.disciplines.electronics.maxBoardMm.y },
    s => { s.disciplines.electronics.maxBoardMm.z = 1.6 }, s => { s.budgets = { sizeMm: { x: 10, y: 10 } } },
    s => { s.budgets.power = { batteryMah: 500 } }, s => { s.budgets.reliability = 'certified' },
    s => { s.budgets.unitCostUsd = 1 }, s => { s.budgets.volumeUnits = 1000 },
    s => { s.disciplines.electronics.status = 'built' }, s => { s.disciplines.electronics.status = 'not_applicable' },
    s => { s.disciplines.firmware.status = 'defined' }, s => { s.disciplines.validation.status = 'built' },
    s => { s.disciplines.supplyChain.requirements = ['Buy components'] },
    s => { s.disciplines.mechanical.enclosureKind = 'box' }, s => { s.disciplines.simulation = { status: 'defined' } },
    s => { s.openQuestions = ['What battery?'] }, s => { s.extra = 'ignored?' },
    s => { s.product = '' }, s => { s.description = [] }, s => { s.disciplines.electronics.summary = 'x'.repeat(1001) },
    s => { s.disciplines.electronics.boardIntent = null }, s => { s.disciplines.electronics.keyBlocks = [false] },
    s => { s.disciplines.electronics.keyBlocks = Array(7).fill('block') },
  ]) { const value = specification(); mutate(value); rejected(value) }
})

test('architect instructions explicitly require raw machine contract and no repair/defaults', () => {
  assert.match(system, /"enough":true/)
  assert.match(system, /contract copied exactly from template.electricalContract/)
  assert.match(system, /Do not reinterpret other products/)
  assert.match(system, /No costs, battery, runtime/)
  assert.match(system, /not electrical authority/)
  assert.match(system, /not_applicable/)
  assert.equal(system.includes('/Applications/'), false)
})
