import assert from 'node:assert/strict'
import test from 'node:test'

const { composeSubsystems, verifyComposition, splitForGeneration } = await import(
  `../lib/subsystem-compose.mjs?test=${Date.now()}`
)

const errs = (r) => r.problems.filter((p) => p.severity === 'error')
const codes = (r) => r.problems.map((p) => p.code)

const power = () => ({
  name: 'power',
  purpose: 'USB-C 5V in, 3V3 out',
  parts: [
    { name: 'J1', kind: 'connector', footprint: 'header_1x2' },
    { name: 'U1', kind: 'chip', footprint: 'sot23-5', mpn: 'AP2112K-3.3' },
    { name: 'C1', kind: 'cap', footprint: '0402' },
  ],
  nets: [['J1.1', 'U1.1'], ['U1.5', 'C1.1']],
  gnd: ['J1.2', 'U1.2', 'C1.2'],
  provides: [{ signal: '3V3', net: 'U1.5' }],
})

const mcu = () => ({
  name: 'mcu',
  purpose: 'RP2040',
  parts: [
    { name: 'U1', kind: 'chip', footprint: 'qfn56', mpn: 'RP2040' },
    { name: 'C1', kind: 'cap', footprint: '0402' },
  ],
  nets: [['U1.1', 'C1.1']],
  gnd: ['U1.28', 'C1.2'],
  requires: [{ signal: '3V3', net: 'U1.44' }],
})

test('two subsystems compose into a valid runner netlist', () => {
  const r = composeSubsystems([power(), mcu()])
  assert.deepEqual(errs(r), [], `unexpected errors: ${JSON.stringify(errs(r))}`)

  // Both subsystems have a U1 and a C1; namespacing must keep them distinct.
  const names = r.parts.map((p) => p.name)
  assert.equal(new Set(names).size, names.length, 'part names must be unique after composition')
  assert.ok(names.includes('POW_U1') && names.includes('MCU_U1'), names.join(','))

  // Shape must be exactly what run_board.mjs consumes.
  for (const p of r.parts) {
    assert.equal(typeof p.name, 'string')
    assert.equal(typeof p.footprint, 'string')
  }
  for (const n of r.nets) {
    assert.equal(n.length, 2)
    assert.match(n[0], /^[A-Z0-9]+_[A-Za-z0-9]+\.\w+$/)
  }
  assert.ok(r.gnd.every((g) => /^[A-Z0-9]+_/.test(g)))

  // The interface actually became a connection.
  assert.equal(r.interfaces.length, 1)
  assert.equal(r.interfaces[0].signal, '3V3')
  assert.deepEqual(r.interfaces[0].to, ['mcu'])
  assert.ok(
    r.nets.some(([a, b]) => (a === 'POW_U1.5' && b === 'MCU_U1.44') || (a === 'MCU_U1.44' && b === 'POW_U1.5')),
    'the 3V3 interface must appear as a real net',
  )
})

test('a rail provided once and required three times joins to every consumer', () => {
  const consumer = (name, pin) => ({
    name,
    parts: [{ name: 'U1', kind: 'chip', footprint: 'sot23-5' }],
    nets: [],
    requires: [{ signal: '3V3', net: `U1.${pin}` }],
  })
  const r = composeSubsystems([power(), consumer('mcu', 1), consumer('sensing', 2), consumer('radio', 3)])
  assert.deepEqual(errs(r), [])
  assert.equal(r.interfaces[0].to.length, 3)
  // POW_U1.5 also carries power's OWN internal net to its output cap, so the
  // rail appears 3 (interfaces) + 1 (internal) times.
  const railNets = r.nets.filter(([a, b]) => a === 'POW_U1.5' || b === 'POW_U1.5')
  assert.equal(railNets.length, 4, 'three consumers plus power\'s own output cap')
  const toConsumers = railNets.filter(([a, b]) => [a, b].some((e) => /^(MCU|SEN|RAD)_/.test(e)))
  assert.equal(toConsumers.length, 3, 'one interface net per consumer')
})

test('unsatisfied require is an error naming the signal', () => {
  const r = composeSubsystems([mcu()])
  const e = errs(r).find((p) => p.code === 'unsatisfied_require')
  assert.ok(e, codes(r).join(','))
  assert.equal(e.signal, '3V3')
  assert.equal(e.subsystem, 'mcu')
})

test('two providers of the same signal is an error, not a silent merge', () => {
  const a = power()
  const b = { ...power(), name: 'power-b' }
  const r = composeSubsystems([a, b, mcu()])
  assert.ok(codes(r).includes('duplicate_provide'), codes(r).join(','))
})

test('a provide nobody consumes warns, and can be escalated', () => {
  const r = composeSubsystems([power()])
  assert.ok(r.problems.some((p) => p.code === 'unused_provide' && p.severity === 'warning'))
  const strict = composeSubsystems([power()], { requireEveryProvideUsed: true })
  assert.ok(strict.problems.some((p) => p.code === 'unused_provide' && p.severity === 'error'))
})

test('nets and ports referencing a missing part are errors', () => {
  const bad = {
    name: 'bad',
    parts: [{ name: 'U1', footprint: 'qfn8' }],
    nets: [['U1.1', 'R9.2']],
    provides: [{ signal: 'X', net: 'Q7.1' }],
  }
  const r = composeSubsystems([bad])
  const unknown = r.problems.filter((p) => p.code === 'unknown_ref')
  assert.equal(unknown.length, 2, JSON.stringify(r.problems))
  assert.ok(unknown.some((p) => p.ref === 'R9'))
  assert.ok(unknown.some((p) => p.ref === 'Q7'))
})

test('duplicate part within one subsystem is an error', () => {
  const r = composeSubsystems([
    { name: 'dup', parts: [{ name: 'U1', footprint: 'qfn8' }, { name: 'U1', footprint: 'qfn8' }], nets: [] },
  ])
  assert.ok(codes(r).includes('duplicate_part'), codes(r).join(','))
})

test('subsystems whose names share a prefix still get distinct namespaces', () => {
  const mk = (name) => ({ name, parts: [{ name: 'U1', footprint: 'qfn8' }], nets: [] })
  const r = composeSubsystems([mk('power'), mk('powertrain'), mk('power-aux')])
  const names = r.parts.map((p) => p.name)
  assert.equal(new Set(names).size, 3, names.join(','))
  assert.ok(!codes(r).includes('prefix_collision'))
})

test('an unconnected part is flagged as an orphan', () => {
  const r = composeSubsystems([
    { name: 'x', parts: [{ name: 'U1', footprint: 'qfn8' }, { name: 'R1', footprint: '0402' }], nets: [['U1.1', 'U1.2']] },
  ])
  assert.ok(r.problems.some((p) => p.code === 'orphan_part' && p.ref === 'X_R1'), JSON.stringify(r.problems))
})

test('composition is deterministic', () => {
  const a = composeSubsystems([power(), mcu()])
  const b = composeSubsystems([power(), mcu()])
  assert.deepEqual(a, b)
})

test('empty input is reported, never thrown', () => {
  const r = composeSubsystems([])
  assert.ok(codes(r).includes('no_subsystems'))
  assert.deepEqual(r.parts, [])
  // Malformed input must also not throw.
  assert.doesNotThrow(() => composeSubsystems(null))
  assert.doesNotThrow(() => composeSubsystems([{ name: 'x', parts: [{}], nets: [['bad']] }]))
})

test('a realistic 4-subsystem board composes with no dangling interface', () => {
  const cap = (n) => ({ name: `C${n}`, kind: 'cap', footprint: '0402' })
  const sensing = {
    name: 'sensing',
    parts: [{ name: 'U1', kind: 'chip', footprint: 'qfn24' }, ...[1, 2, 3, 4].map(cap)],
    nets: [['U1.1', 'C1.1'], ['U1.2', 'C2.1'], ['U1.3', 'C3.1'], ['U1.4', 'C4.1']],
    gnd: ['U1.12', 'C1.2', 'C2.2', 'C3.2', 'C4.2'],
    requires: [{ signal: '3V3', net: 'U1.5' }, { signal: 'I2C_SDA', net: 'U1.6' }, { signal: 'I2C_SCL', net: 'U1.7' }],
  }
  const conn = {
    name: 'connectivity',
    parts: [{ name: 'U1', kind: 'chip', footprint: 'qfn32' }, { name: 'J1', kind: 'connector', footprint: 'header_1x8' }, ...[1, 2].map(cap)],
    nets: [['U1.1', 'C1.1'], ['U1.2', 'C2.1'], ['U1.10', 'J1.1']],
    gnd: ['U1.16', 'J1.8', 'C1.2', 'C2.2'],
    requires: [{ signal: '3V3', net: 'U1.4' }, { signal: 'UART_TX', net: 'U1.8' }],
  }
  const bigMcu = {
    ...mcu(),
    parts: [...mcu().parts, ...[2, 3, 4, 5, 6].map(cap)],
    nets: [...mcu().nets, ['U1.2', 'C2.1'], ['U1.3', 'C3.1'], ['U1.4', 'C4.1'], ['U1.5', 'C5.1'], ['U1.6', 'C6.1']],
    gnd: [...mcu().gnd, 'C2.2', 'C3.2', 'C4.2', 'C5.2', 'C6.2'],
    provides: [
      { signal: 'I2C_SDA', net: 'U1.20' },
      { signal: 'I2C_SCL', net: 'U1.21' },
      { signal: 'UART_TX', net: 'U1.22' },
    ],
  }
  const r = composeSubsystems([power(), bigMcu, sensing, conn])

  assert.deepEqual(errs(r), [], JSON.stringify(errs(r)))
  assert.equal(r.stats.subsystems, 4)
  // power 3 + mcu 7 + sensing 5 + connectivity 4
  assert.equal(r.parts.length, 19, `expected the full part set, got ${r.parts.length}`)
  // Every declared interface reaches at least one consumer.
  for (const iface of r.interfaces) {
    assert.ok(iface.to.length > 0, `${iface.signal} reaches nobody`)
  }
  // 3V3 fans out to three consumers; each bus signal to one.
  const byName = Object.fromEntries(r.interfaces.map((i) => [i.signal, i]))
  assert.equal(byName['3V3'].to.length, 3)
  assert.equal(byName['I2C_SDA'].to.length, 1)
  // Revalidation of the composed artifact finds nothing new.
  assert.deepEqual(verifyComposition(r).filter((p) => p.severity === 'error'), [])
  // Part names unique across the whole board.
  const names = r.parts.map((p) => p.name)
  assert.equal(new Set(names).size, names.length)
})

test('splitForGeneration produces a self-contained brief per subsystem', () => {
  const briefs = splitForGeneration({
    subsystems: [
      { name: 'power', purpose: '5V to 3V3', provides: [{ signal: '3V3', net: 'U1.5' }] },
      { name: 'mcu', purpose: 'RP2040', requires: [{ signal: '3V3', net: 'U1.44' }], provides: [{ signal: 'I2C_SDA', net: 'U1.20' }] },
    ],
  })
  assert.equal(briefs.length, 2)
  assert.deepEqual(briefs[0].mustProvide, ['3V3'])
  assert.deepEqual(briefs[1].mayRequire, ['3V3'])
  assert.match(briefs[1].contract, /Design ONLY the "mcu" subsystem/)
  assert.match(briefs[1].contract, /3V3/)
  assert.deepEqual(splitForGeneration(null), [])
})
