// The firmware generator is family-independent: one crate layout for every MCU
// family, with the family adapter (scripts/fw_families.py) supplying the target,
// HAL, memory map and board bring-up. These tests pin the adapter contract and
// the pipeline's use of the generator's `FIRMWARE: family=… target=…` line.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = path.join(here, '..')

function py(code) {
  const r = spawnSync('python3', ['-c', code], { cwd: path.join(app, 'scripts'), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout.trim().split('\n').pop())
}

const STM = [
  { role: 'I2C_SDA', pad: '43', cap: 'i2c_sda' }, { role: 'I2C_SCL', pad: '42', cap: 'i2c_scl' },
  { role: 'SPI_SCK', pad: '26', cap: 'spi_sck' }, { role: 'SPI_MOSI', pad: '28', cap: 'spi_mosi' },
  { role: 'SPI_MISO', pad: '27', cap: 'spi_miso' }, { role: 'U4_I1', pad: '17', cap: 'gpio' },
]
const RP = [
  { role: 'I2C_SDA', pad: '11', cap: 'i2c_sda' }, { role: 'I2C_SCL', pad: '12', cap: 'i2c_scl' },
  { role: 'SPI_SCK', pad: '4', cap: 'spi_sck' }, { role: 'SPI_MOSI', pad: '5', cap: 'spi_mosi' },
  { role: 'SPI_MISO', pad: '6', cap: 'spi_miso' }, { role: 'W25Q_CS', pad: '7', cap: 'spi_cs' },
]

test('family tags resolve case-insensitively and unknown families do not', () => {
  const r = py(`import json, fw_families as f
print(json.dumps([f.resolve_family(t) for t in ("STM32F1","stm32f1","rp2040","RP2040","esp32c3","cm4",None)]))`)
  assert.deepEqual(r, ['stm32f1', 'stm32f1', 'rp2040', 'rp2040', null, null, null])
})

test('STM32F1 pads name to real port pins and land on I2C1 / SPI2', () => {
  const r = py(`import json, fw_families as f
n = f.name_pins("stm32f1", json.loads('${JSON.stringify(STM)}'))
p = f.plan_buses("stm32f1", n)
print(json.dumps({"names": {x["role"]: x["name"] for x in n}, "i2c": p["i2c"]["inst"], "spi": p["spi"]["inst"], "outs": [o["field"] for o in p["outs"]]}))`)
  assert.equal(r.names.I2C_SDA, 'PB7')
  assert.equal(r.names.I2C_SCL, 'PB6')
  assert.equal(r.names.SPI_SCK, 'PB13')
  assert.equal(r.i2c, 'I2C1')
  assert.equal(r.spi, 'SPI2')
  assert.deepEqual(r.outs, ['u4_i1'])
})

test('RP2040 Pico pads name to GP numbers and land on I2C0 / SPI0; CS is an output', () => {
  const r = py(`import json, fw_families as f
n = f.name_pins("rp2040", json.loads('${JSON.stringify(RP)}'))
p = f.plan_buses("rp2040", n)
print(json.dumps({"sda": p["i2c"]["sda"], "i2c": p["i2c"]["inst"], "spi": p["spi"]["inst"], "outs": [o["field"] for o in p["outs"]]}))`)
  assert.equal(r.sda, 'GP8')
  assert.equal(r.i2c, 'I2C0')
  assert.equal(r.spi, 'SPI0')
  assert.deepEqual(r.outs, ['w25q_cs'])
})

test('an allocation with no real bus instance is refused, never guessed', () => {
  const r = py(`import json, fw_families as f
try:
    f.plan_buses("stm32f1", [{"role":"I2C_SDA","pad":"43","cap":"i2c_sda","name":"PB7"},{"role":"I2C_SCL","pad":"21","cap":"i2c_scl","name":"PB10"}])
    print(json.dumps("planned"))
except f.FamilyError as e:
    print(json.dumps(str(e)))`)
  assert.match(r, /no STM32F1 I2C instance/)
})

test('every family row carries a target, HAL, memory map and a board emitter', () => {
  const r = py(`import json, fw_families as f
out = {}
for k in f.FAMILIES:
    files = f.crate_files(k)
    out[k] = {"target": f.FAMILIES[k]["target"], "cfg": files[".cargo/config.toml"], "mem": files["memory.x"],
              "cargo": files["Cargo.toml"], "board": k in f._BOARD, "build": "memory.x" in files["build.rs"]}
print(json.dumps(out))`)
  assert.equal(r.stm32f1.target, 'thumbv7m-none-eabi')
  assert.equal(r.rp2040.target, 'thumbv6m-none-eabi')
  for (const k of Object.keys(r)) {
    assert.ok(r[k].board, `${k} has a board.rs emitter`)
    assert.ok(r[k].build, `${k} ships build.rs for memory.x`)
    assert.match(r[k].cfg, /link-arg=-Tlink\.x/)
    assert.match(r[k].mem, /FLASH : ORIGIN/)
    assert.match(r[k].cargo, /cortex-m-rt/)
    assert.match(r[k].cargo, /embedded-hal-bus/)
  }
  assert.match(r.rp2040.mem, /\.boot2/)
})

test('board.rs for each family is emitted from the same plan shape', () => {
  const r = py(`import json, fw_families as f
s = f.emit_board("stm32f1", "STM32F103C8T6", f.plan_buses("stm32f1", f.name_pins("stm32f1", json.loads('${JSON.stringify(STM)}'))))
p = f.emit_board("rp2040", "RP2040", f.plan_buses("rp2040", f.name_pins("rp2040", json.loads('${JSON.stringify(RP)}'))))
print(json.dumps({"stm": s, "rp": p}))`)
  assert.match(r.stm, /I2c::new\(dp\.I2C1, \(gpiob\.pb6, gpiob\.pb7\)/)
  assert.match(r.stm, /dp\.SPI2\.spi\(\(Some\(gpiob\.pb13\), Some\(gpiob\.pb14\), Some\(gpiob\.pb15\)\)/)
  assert.match(r.stm, /pub fn init\(\) -> Board/)
  assert.match(r.rp, /I2C::i2c0\(p\.I2C0, pins\.gpio8\.reconfigure\(\), pins\.gpio9\.reconfigure\(\)/)
  assert.match(r.rp, /BOOT|XOSC_CRYSTAL_FREQ/)
  assert.match(r.rp, /pub fn init\(\) -> Board/)
})

test('the pipeline takes family/target from the generator and gates on a linked ELF', () => {
  const src = fs.readFileSync(path.join(app, 'app/api/pipeline/run/route.ts'), 'utf8')
  assert.match(src, /FIRMWARE: family=\(\\S\+\) target=\(\\S\+\) hal=\(\\S\+\)/)
  assert.doesNotMatch(src, /fwTargetLabel = 'thumbv6m-none-eabi \(RP2040\)'/)
  assert.match(src, /CARGO_TARGET_DIR: fwTargetDir/)
  assert.match(src, /fwElfSize < 1024/)
  assert.match(src, /'firmware\.elf'/)
  assert.match(src, /FIRMWARE: NOT WIRED/)
})
