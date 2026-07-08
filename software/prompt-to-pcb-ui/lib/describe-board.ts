/**
 * Synthesizes a SHORT "what is this board" line from a run's real artifacts —
 * compose blocks, known parts, board class — so a user can tell boards apart
 * at a glance. One sentence, the top few defining functions only, never a
 * component inventory. Deterministic and honest: every phrase traces to a
 * block or part that is actually on the board.
 */

// block kind → short function phrase, prio = how defining (lower = more)
const BLOCK_CLAUSES: [RegExp, string, number][] = [
  [/relay probe matrix|^relay$/, 'relay-matrix signal switching', 10],
  [/stepper|^motors$/, 'stepper motor drive', 12],
  [/current sense/, 'current measurement', 20],
  [/dut monitor/, 'DUT power-rail monitoring', 21],
  [/^imu|6-axis imu/, '6-axis motion sensing', 22],
  [/bme280|environmental|barometric|temp(erature)? sensor|i2c sensor/,
    'environmental sensing (temp / humidity / pressure)', 23],
  [/cal (reference|ref)\b/, 'a precision calibration reference', 30],
  [/cal ladder/, 'a calibration resistor ladder', 31],
  [/can bus/, 'CAN comms', 40],
  [/fl1 bus/, 'the FL-1 instrument bus', 41],
  [/uart bridge/, 'UART bridging', 42],
  [/lora/, 'a LoRa radio link', 43],
  [/gnss/, 'GNSS positioning', 44],
  [/^spi$/, 'an SPI bus', 46],
  [/gpio (bank|breakout)/, 'GPIO breakout', 50],
  [/i2c expander|pcf8574/, 'I2C GPIO expansion', 51],
  [/board id/, 'EEPROM board ID', 60],
]

// known part → short phrase; enriches blocks and covers synth-mode runs
const PART_CLAUSES: [RegExp, string, number][] = [
  [/relay|G5V/i, 'relay-matrix signal switching', 10],
  [/ADS1115/i, '16-bit ADC voltage measurement', 20],
  [/INA2(19|26)/i, 'current/power monitoring', 20],
  [/BME280/i, 'environmental sensing (temp / humidity / pressure)', 23],
  [/DS3231/i, 'battery-backable RTC timekeeping', 25],
  [/REF30\d\d/i, 'a precision voltage reference', 30],
  [/MCP2515|TJA10|SN65HVD/i, 'CAN comms', 40],
  [/SX12\d\d|RFM9/i, 'a LoRa radio link', 43],
  [/NEO-|ZOE-/i, 'GNSS positioning', 44],
  [/TXB0\d\d\d/i, 'logic level translation', 45],
  [/PCF8574/i, 'I2C GPIO expansion', 51],
  [/24LC\d\d/i, 'EEPROM board ID', 60],
]

// class/prompt-derived one-liners for passive/synth boards with no blocks
const CLASS_SENTENCES: [RegExp, string][] = [
  [/backplane/i, 'Passive backplane — distributes power and bus signals across its card slots.'],
  [/connector breakout|breakout board/i, 'Passive connector breakout to 2.54 mm headers and test points.'],
  [/power entry/i, 'Bench power-entry board — brings supply power in through a header.'],
]

const MAX_CLAUSES = 3

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/** last-run.json → one short glanceable line: what this board is for */
export function describeBoard(lr: any): string | null {
  if (!lr) return null
  const blocks: string[] = (lr.composeSpec?.blocks ?? []).map((b: string) => b.toLowerCase())
  const partsLine: string =
    lr.designSummary?.match(/^\s*parts\s*:\s*(.+)$/m)?.[1] ?? ''
  const klass = `${lr.composeSpec?.boardClass ?? ''} ${lr.prompt ?? ''}`

  // controller
  let mcu: string | null = null
  if (blocks.some((b) => /bare rp2040|chip-down/.test(b))) mcu = 'a chip-down bare RP2040'
  else if (/Raspberry Pi Pico/i.test(partsLine)) mcu = 'a Pico (RP2040)'

  // collect function phrases from blocks, then known parts (dedup by text
  // and by prio slot so a part never restates what a block already said)
  const clauses = new Map<string, number>()
  for (const b of blocks)
    for (const [re, text, prio] of BLOCK_CLAUSES)
      if (re.test(b)) { clauses.set(text, prio); break }
  for (const part of partsLine.split(';').map((p) => p.trim()).filter(Boolean))
    for (const [re, text, prio] of PART_CLAUSES)
      if (re.test(part)) {
        if (!clauses.has(text) && ![...clauses.values()].includes(prio))
          clauses.set(text, prio)
        break
      }

  // chip-down benchmark boards name their device-under-bring-up in the class
  const cd = klass.match(/chip-down(?:\s+benchmark)?\s*:\s*([A-Za-z0-9-]+)/i)
  if (cd) return `Chip-down bring-up benchmark for the ${cd[1]}.`

  if (clauses.size === 0) {
    for (const [re, sentence] of CLASS_SENTENCES) if (re.test(klass)) return sentence
    if (!mcu) return null
    return `Controller board on ${mcu}.`
  }

  // the few most defining functions only — this is a glance line, not a spec
  const top = [...clauses.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, MAX_CLAUSES)
    .map(([text]) => text)
  const fl1 = blocks.some((b) => /fl1/.test(b)) || /^fl1-/i.test(lr.composeSpec?.boardClass ?? '')

  const body = `${joinList(top)}${mcu ? ` on ${mcu}` : ''}.`
  if (fl1) return `FL-1 test-station board: ${body}`
  return body.charAt(0).toUpperCase() + body.slice(1)
}
