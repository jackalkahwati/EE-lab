import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import crypto from 'node:crypto'
import ts from 'typescript'

// Pure source/catalog fixtures. No provider, native tool, private run store,
// dependency installation or writes. The catalog's footprint source is pinned
// evidence, not a generated board or a substitute for a model proposal.
const root = new URL('../', import.meta.url)
const catalog = JSON.parse(fs.readFileSync(new URL('lib/astra-catalog.json', root), 'utf8'))
const source = fs.readFileSync(new URL('lib/astra-local-parts.ts', root), 'utf8')
const exports = {}
const readiness = { status: { ready: false, reason: 'Fixture qualification manifest is missing; native containment remains unverified.' }, error: null, calls: 0 }
class AstraError extends Error {
  constructor(category, message) { super(message); this.category = category }
}
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText, { exports, structuredClone, require: name => {
  if (name === '@/lib/astra-execution') return { AstraError }
  if (name === './astra-catalog.json') return catalog
  if (name === './astra-readiness') return { readAstraReadiness: async () => {
    readiness.calls++
    if (readiness.error) throw readiness.error
    return readiness.status
  } }
  throw Error(`Unmocked dependency ${name}`)
} })
const { validateAstraLocalNetlist: validate, validateAstraDecouplerPlacement: validatePlacement } = exports
const plain = value => JSON.parse(JSON.stringify(value))
const rejected = value => assert.throws(() => validate(value), e => e.category === 'policy')
function proposal() {
  return {
    parts: Object.entries(catalog.parts).map(([name, part]) => {
      const asset = catalog.assets[part.catalogId]
      return { name, kind: part.kind, mpn: part.mpn, value: part.value,
        footprint: `${asset.footprint.libraryPath.split('/').at(-1).replace(/\.pretty$/, '')}:${asset.footprint.name}` }
    }),
    nets: catalog.contract.canonicalNets.filter(n => n.name !== 'GND').flatMap(n => n.pins.slice(1).map((pin, i) => [n.pins[i], pin])),
    gnd: [...catalog.contract.canonicalNets.find(n => n.name === 'GND').pins],
  }
}

test('reviewed catalog never unblocks preflight without native capability proof', async () => {
  assert.equal(readiness.calls, 0, 'catalog import never reads or mints readiness')
  await assert.rejects(exports.preflightAstraElectronics(), e => e.category === 'policy' && e.message === readiness.status.reason)
  assert.equal(readiness.calls, 1)
  assert.match(exports.ASTRA_ELECTRONICS_BLOCKER, /containment/)
  assert.match(exports.ASTRA_ELECTRONICS_BLOCKER, /unverified/)
  assert.ok(Object.isFrozen(exports.ASTRA_CATALOG.assets.bme280.models[0].offsetMm))
  assert.equal(exports.ASTRA_CATALOG_ID, 'bme280-3v3-i2c-0x76-v1')
})

test('read-only preflight consults current readiness each call and propagates verification failure', async () => {
  const before = readiness.status
  const initialCalls = readiness.calls
  try {
    readiness.status = { ready: true, reason: 'Unit fixture only; not runtime qualification.' }
    assert.equal(await exports.preflightAstraElectronics(), undefined)
    readiness.status = { ready: false, reason: 'Fixture evidence became stale.' }
    await assert.rejects(exports.preflightAstraElectronics(), e => e.category === 'policy' && e.message === readiness.status.reason)
    const error = new Error('Fixture readiness verification failed')
    readiness.error = error
    await assert.rejects(exports.preflightAstraElectronics(), e => e === error)
    assert.equal(readiness.calls, initialCalls + 3, 'no memoized pass or automatic qualification fallback')
  } finally { readiness.status = before; readiness.error = null }
})

test('exact asset sources, pad numbers, geometry and model transforms are pinned', () => {
  const expected = {
    bme280: ['14464b7a437e7efb0fa9947b89a7d3825242f3ed82d649fe2ca45fad5d3dda86', '52ce10ea1a6ad1544c3399c9b5fe10717df6e95598d13bdee97aa508af643ef0'],
    'cap-100nf-0402': ['0403382fc4583ed510b461b1fa4a36dfaec6f4c0d9b1a67e6b0027837a54e1b5', '03e44c4b2b727b8d4b6b1fd598cbd12dd5e614f1dfeefa96a92a07e3a3b312a2'],
    'res-4k7-0402': ['e05c7605248c220836f642ed1f526133edf0374acdfd5bb2631e58b4e377acfb', '91507e5af4251cb4ef38e04889c9b98da29904432bd83786bba13ae9b605eacb'],
    'header-1x04': ['571d2d16b49795f8f9a91f96cc83fd2adf49890cd66c377189c44204ebd03c29', 'a74079b8d06bda78847623b39ee1855ffd1d9a8c1e896b349e4f1dc2056d44d9'],
  }
  for (const [id, asset] of Object.entries(catalog.assets)) {
    assert.equal(asset.catalogId, id)
    assert.equal(asset.footprint.sha256, expected[id][0])
    assert.equal(crypto.createHash('sha256').update(asset.footprint.source).digest('hex'), asset.footprint.sha256)
    assert.equal(Buffer.byteLength(asset.footprint.source), asset.footprint.bytes)
    assert.equal(asset.models[0].sha256, expected[id][1])
    assert.equal(asset.models.length, 1)
    assert.ok(asset.models[0].bytes > 0)
    assert.ok(asset.footprint.source.includes(`(model "${asset.models[0].sourceReference}"`))
    assert.ok(asset.models[0].sourceReference.startsWith('${KICAD10_3DMODEL_DIR}/'))
    assert.deepEqual(asset.padNumbers, asset.pads.map(p => p.number))
    assert.deepEqual(asset.models[0].scale, [1, 1, 1])
    assert.deepEqual(asset.models[0].rotationDeg, [0, 0, 0])
    assert.equal(asset.footprint.path, `${asset.footprint.libraryPath}/${asset.footprint.name}.kicad_mod`)
    for (const p of asset.pads) assert.ok(asset.footprint.source.includes(`(pad "${p.number}" ${p.type} ${p.shape}`))
  }
  assert.deepEqual(catalog.assets.bme280.padNumbers, ['1','2','3','4','5','6','7','8'])
  assert.ok(catalog.assets.bme280.pads.every(p => p.rotationDeg === 90 && p.shape === 'rect'))
  assert.deepEqual(catalog.assets.bme280.pads[0].atMm, [-0.975, -1.025])
  assert.deepEqual(catalog.assets.bme280.models[0].offsetMm, [0.01500000025, -0.03500000059, 0])
  for (const id of ['cap-100nf-0402', 'res-4k7-0402']) {
    assert.ok(catalog.assets[id].pads.every(p => p.shape === 'roundrect' && p.roundrectRatio === 0.25))
    assert.deepEqual(catalog.assets[id].models[0].offsetMm, [0, 0, 0])
  }
  const header = catalog.assets['header-1x04'].pads
  assert.deepEqual(header.map(p => p.shape), ['rect', 'circle', 'circle', 'circle'])
  assert.deepEqual(header.map(p => p.atMm), [[0,0],[0,2.54],[0,5.08],[0,7.62]])
  assert.ok(header.every(p => p.drillMm === 1 && p.type === 'thru_hole'))
})

test('manufacturer evidence is separate from generic passive requirements', () => {
  assert.equal(catalog.parts.U1.mpn, 'BME280')
  assert.deepEqual(catalog.parts.U1.specification.pinFunctions, { 1:'GND',2:'CSB',3:'SDI/SDA',4:'SCK/SCL',5:'SDO',6:'VDDIO',7:'GND',8:'VDD' })
  assert.match(catalog.provenance.manufacturerDocument.url, /^https:\/\/www\.bosch-sensortec\.com\//)
  assert.match(catalog.provenance.manufacturerDocument.sha256, /^[a-f0-9]{64}$/)
  for (const ref of ['J1','C1','C2','R1','R2']) {
    assert.equal(catalog.parts[ref].mpn, '')
    assert.match(catalog.parts[ref].specification.qualification, /no supplier MPN/)
  }
  for (const ref of ['C1','C2']) {
    assert.equal(catalog.parts[ref].specification.capacitanceF, 1e-7)
    assert.equal(catalog.parts[ref].specification.minimumVoltageRatingV, 10)
    assert.equal(catalog.parts[ref].specification.dielectric, 'X7R')
  }
  for (const ref of ['R1','R2']) {
    assert.equal(catalog.parts[ref].specification.resistanceOhm, 4700)
    assert.equal(catalog.parts[ref].specification.minimumPowerRatingW, 0.0625)
  }
})

test('valid proposal edges survive; canonical nets union chains deterministically', () => {
  const input = proposal()
  const result = validate(input)
  assert.deepEqual(plain(result.canonicalNets), catalog.contract.canonicalNets)
  assert.deepEqual(plain(result.nets), input.nets)
  assert.deepEqual(plain(result.gnd), input.gnd)
  assert.equal(result.parts.length, 6)
  assert.equal(result.canonicalNets.flatMap(n => n.pins).length, 20)
  for (const part of result.parts) {
    assert.equal(part.kicadMod, catalog.assets[part.catalogId].footprint.source)
    assert.equal(part.mpn, catalog.parts[part.name].mpn)
  }
  const reordered = proposal()
  reordered.parts.reverse()
  reordered.nets.reverse().forEach(pair => pair.reverse())
  reordered.gnd.reverse()
  assert.deepEqual(plain(validate(reordered).canonicalNets), catalog.contract.canonicalNets)
  result.parts[0].value = 'mutation'
  result.layoutConstraints.decouplers[0].maxPadDistanceMm = 999
  assert.equal(validate(input).parts[0].value, 'BME280')
  assert.equal(validate(input).layoutConstraints.decouplers[0].maxPadDistanceMm, 2)
})

test('ground edges may join the ground list; redundant nonduplicate within-net edges are valid', () => {
  const input = proposal()
  const ground = input.gnd.splice(1)
  input.nets.push(...ground.map(pin => [input.gnd[0], pin]), ['J1.1', 'U1.8'])
  assert.deepEqual(plain(validate(input).canonicalNets), catalog.contract.canonicalNets)
})

test('every omitted connection and ground endpoint is detected', () => {
  const input = proposal()
  for (let i = 0; i < input.nets.length; i++) {
    const value = proposal(); value.nets.splice(i, 1); rejected(value)
  }
  for (let i = 0; i < input.gnd.length; i++) {
    const value = proposal(); value.gnd.splice(i, 1); rejected(value)
  }
})

test('all pairwise cross-net shorts are rejected, including rails and ground', () => {
  const nets = catalog.contract.canonicalNets
  for (let i = 0; i < nets.length; i++) for (let j = i + 1; j < nets.length; j++) {
    for (const a of nets[i].pins) for (const b of nets[j].pins) {
      const value = proposal(); value.nets.push([a,b]); rejected(value)
    }
  }
})

test('swapped header lines and CSB/SDO strapping are rejected even with four complete nets', () => {
  for (const [a,b] of [['J1.3','J1.4'],['U1.2','U1.5'],['U1.6','U1.7'],['R1.1','R1.2'],['C1.1','C1.2']]) {
    const swap = pin => pin === a ? b : pin === b ? a : pin
    const input = proposal()
    input.nets = input.nets.map(pair => pair.map(swap)); input.gnd = input.gnd.map(swap)
    rejected(input)
  }
  const input = proposal(); input.gnd = ['J1.1']
  const ground = catalog.contract.canonicalNets.find(n => n.name === 'GND').pins
  input.nets.push(...ground.slice(1).map(pin => [ground[0],pin]))
  rejected(input)
})

test('part count, identity, value, pad IDs, unsafe fields and edge shape fail closed', () => {
  for (const mutate of [
    v => v.parts.pop(), v => v.parts.push({...v.parts[0],name:'U2'}),
    v => {v.parts[1] = {...v.parts[0]}},
    v => {v.parts[0].mpn = 'BMP280'}, v => {v.parts[0].name = '__proto__'},
    v => {v.parts[0].name = 'U1\" />'}, v => {v.parts[0].footprint = 'Package_LGA:other'},
    v => {v.parts[2].value = '10uF'}, v => {v.parts[4].value = '4.7'},
    v => {v.parts[2].mpn = 'UNQUALIFIED-SUPPLIER-MPN'},
    v => {v.parts[0].kind = 'connector'}, v => {delete v.parts[0].value},
    v => {v.parts[0].lcsc = 'C1234'}, v => {v.parts[0].kicadMod = '(pad)'},
    v => {v.parts[0].source_part = 'BME280'}, v => {v.parts[0].model = '/private/model.step'},
    v => {v.code = 'fetch()'}, v => {v.placement = []}, v => {v.canonicalNets = []},
    v => {v.nets[0][0] = 'U1.9'}, v => {v.nets[0][0] = 'U1.GND'},
    v => {v.nets[0][0] = 'U1.01'}, v => {v.nets[0][0] = '../U1.1'},
    v => {v.nets[0][0] = 'constructor'}, v => {v.nets[0][0] = null},
    v => {v.nets[0] = ['U1.1','U1.1']}, v => {v.nets[0].push('U1.1')},
    v => {v.nets[0] = 'U1.1'}, v => {v.nets.push([...v.nets[0]].reverse())},
    v => {v.gnd.push(v.gnd[0])}, v => {v.gnd=[]}, v => {v.nets=[]},
    v => {v.nets=Array(33).fill(v.nets[0])},
  ]) { const value = proposal(); mutate(value); rejected(value) }
  for (const value of [null, undefined, [], {}, 'board']) rejected(value)
})

test('prompt exposes only approved part fields and honest engineering specs', () => {
  const prompt = exports.astraLocalPartsPrompt()
  assert.match(prompt, /0x76/)
  assert.match(prompt, /100nF/)
  assert.match(prompt, /4\.7k/)
  assert.match(prompt, /No 5V/)
  const payload = JSON.parse(prompt.split('\n').at(-1))
  assert.deepEqual(payload.parts, proposal().parts)
  assert.equal(prompt.includes('/Applications/'), false)
  assert.equal(prompt.includes('(footprint '), false)
})

function measuredPads() {
  return { 'C1.1': {xMm:0,yMm:0,layer:'F.Cu'},'C1.2': {xMm:0,yMm:0.96,layer:'F.Cu'},'U1.8': {xMm:1,yMm:0,layer:'F.Cu'},
    'C2.1': {xMm:3,yMm:0,layer:'F.Cu'},'C2.2': {xMm:3,yMm:0.96,layer:'F.Cu'},'U1.6': {xMm:4,yMm:0,layer:'F.Cu'} }
}
test('layout helper requires measured front-layer supply and ground pads within 2mm', () => {
  validatePlacement(measuredPads())
  const boundary = measuredPads(); boundary['U1.8'].xMm=2; validatePlacement(boundary)
  for (const mutate of [
    p => {p['U1.8'].xMm=2.001}, p => {p['U1.6'].xMm=6},
    p => {delete p['C1.1']}, p => {delete p['C2.2']},
    p => {p['C1.1'].layer='B.Cu'}, p => {p['U1.6'].xMm=NaN},
    p => {p['C2.1'].yMm=Infinity}, p => {p['C2.1'].xMm='3'},
  ]) {
    const pads = measuredPads(); mutate(pads)
    assert.throws(() => validatePlacement(pads), e => e.category === 'policy')
  }
  assert.throws(() => validatePlacement(null), e => e.category === 'policy')
})
