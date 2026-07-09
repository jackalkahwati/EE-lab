/**
 * Curated pin-name maps for well-known ICs, so the schematic's generic boxes
 * show functional pin names (SDA, SCL, VDD…) instead of bare pin numbers.
 * HONESTY: only chips whose pinout is standard + certain are mapped (from their
 * datasheets); anything unrecognized keeps its real pin number. No guessing.
 */
type PinMap = Record<string, string>

// part-name pattern → { pinNumber: functionalName }
const MAPS: { re: RegExp; pins: PinMap }[] = [
  // 74HC595 shift register (16-pin)
  { re: /74HC595|74HCT595/i, pins: {
    1: 'Q1', 2: 'Q2', 3: 'Q3', 4: 'Q4', 5: 'Q5', 6: 'Q6', 7: 'Q7', 8: 'GND',
    9: 'Q7S', 10: '~MR', 11: 'SHCP', 12: 'STCP', 13: '~OE', 14: 'DS', 15: 'Q0', 16: 'VCC' } },
  // ADS1115 / ADS1015 16-bit ADC (VSSOP-10)
  { re: /ADS111[05]/i, pins: {
    1: 'ADDR', 2: 'ALRT', 3: 'GND', 4: 'SCL', 5: 'SDA', 6: 'VDD', 7: 'A0', 8: 'A1', 9: 'A2', 10: 'A3' } },
  // 24LCxx / 24AAxx / 24Cxx I²C EEPROM (SOIC-8)
  { re: /24[LA][CA]\d|24C\d/i, pins: {
    1: 'A0', 2: 'A1', 3: 'A2', 4: 'VSS', 5: 'SDA', 6: 'SCL', 7: 'WP', 8: 'VCC' } },
  // ULN2803A Darlington array (18-pin)
  { re: /ULN280[13]/i, pins: {
    1: 'I1', 2: 'I2', 3: 'I3', 4: 'I4', 5: 'I5', 6: 'I6', 7: 'I7', 8: 'I8', 9: 'GND', 10: 'COM',
    11: 'O8', 12: 'O7', 13: 'O6', 14: 'O5', 15: 'O4', 16: 'O3', 17: 'O2', 18: 'O1' } },
  // REF30xx series voltage reference (SOT-23-3)
  { re: /REF30\d\d/i, pins: { 1: 'IN', 2: 'GND', 3: 'OUT' } },
  // W25Qxx SPI flash (SOIC-8)
  { re: /W25Q\d+/i, pins: {
    1: '~CS', 2: 'DO', 3: '~WP', 4: 'GND', 5: 'DI', 6: 'CLK', 7: '~HOLD', 8: 'VCC' } },
  // AD8418 current-sense amp (SOIC-8)
  { re: /AD8418/i, pins: {
    1: '-IN', 2: 'GND', 3: '+IN', 4: 'V-', 5: 'REF2', 6: 'OUT', 7: 'REF1', 8: 'V+' } },
]

/** returns the functional name for a pin, or the number if the chip isn't mapped */
export function pinName(partName: string, pinNum: string): string {
  if (!partName || !pinNum) return pinNum
  const m = MAPS.find((x) => x.re.test(partName))
  return (m && m.pins[pinNum]) || pinNum
}
