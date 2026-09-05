import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cwd = process.cwd()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-graph-'))
process.chdir(tmp)
const { stageInputsHash } = await import(`${cwd}/lib/design-graph.ts?t=${Date.now()}`)
process.on('exit', () => { process.chdir(cwd); fs.rmSync(tmp, { recursive: true, force: true }) })

const RUN = 'run-identity-test'
const dir = path.join(tmp, 'public', 'runs', RUN)
const write = (rel, obj) => {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj))
}
const board = (parts, nets) => {
  write('electronics/chipscale-board.json', {
    boardMm: { w: 24, h: 24 }, boardShape: { type: 'rect' }, layers: 4,
    parts, mountingHoles: [], drc: { errors: 0 }, drcRepair: { unrouted: 0 },
  })
  write('data/chipscale-spec.json', { parts, nets, gnd: ['U1.10'] })
  write('product-spec.json', { disciplines: {}, budgets: {} })
}
const mechHash = () => stageInputsHash('mechanical', RUN)

test('swapping the MCU for a different chip in the SAME package changes identity', () => {
  const nets = [['U1.1', 'U2.1']]
  board([{ name: 'U1', footprint: 'qfn48', mpn: 'STM32F103C8T6' }], nets)
  const before = mechHash()
  board([{ name: 'U1', footprint: 'qfn48', mpn: 'STM32L071KBU6' }], nets)
  assert.notEqual(mechHash(), before, 'a different chip in the same footprint must not read as unchanged')
})

test('rewiring the same parts changes identity', () => {
  const parts = [{ name: 'U1', footprint: 'qfn48', mpn: 'STM32L071KBU6' }, { name: 'U2', footprint: 'qfn8', mpn: 'BME280' }]
  board(parts, [['U1.1', 'U2.1']])
  const before = mechHash()
  board(parts, [['U1.2', 'U2.1']])
  assert.notEqual(mechHash(), before, 'a board rewired into a different circuit must not read as unchanged')
})

test('an unchanged board keeps its identity — reuse still works', () => {
  const parts = [{ name: 'U1', footprint: 'qfn48', mpn: 'STM32L071KBU6' }]
  const nets = [['U1.1', 'U1.2']]
  board(parts, nets)
  const a = mechHash()
  board(parts, nets)
  assert.equal(mechHash(), a)
})

test('net ORDER is not a change — only the connections are', () => {
  const parts = [{ name: 'U1', footprint: 'qfn48' }, { name: 'U2', footprint: 'qfn8' }]
  board(parts, [['U1.1', 'U2.1'], ['U1.2', 'U2.2']])
  const a = mechHash()
  board(parts, [['U1.2', 'U2.2'], ['U2.1', 'U1.1']])
  assert.equal(mechHash(), a, 'reordering or flipping a net must not read as a redesign')
})

test('the enclosure is hashed by CONTENT, not byte count', () => {
  const parts = [{ name: 'U1', footprint: 'qfn48' }]
  board(parts, [['U1.1', 'U1.2']])
  write('mechanical/enclosure.step', 'ISO-10303-21;\nSHAPE-A-AAAAAAAAAA;\nEND-ISO-10303-21;')
  const a = stageInputsHash('simulation', RUN)
  // same LENGTH, different geometry — the old length hash could not tell these apart
  write('mechanical/enclosure.step', 'ISO-10303-21;\nSHAPE-B-BBBBBBBBBB;\nEND-ISO-10303-21;')
  const b = stageInputsHash('simulation', RUN)
  assert.notEqual(a, b, 'a redesigned enclosure of the same byte count must not read as unchanged')
})
