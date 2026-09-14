import type { ProductSpec } from './product-spec'

/** Browser-safe, explicit user choice. This is a requirements template, not a
 * reference board, a generated specification or a replacement model proposal.
 * Never replace an arbitrary draft with this request without user selection.
 */
export const ASTRA_DESIGN_TEMPLATE = Object.freeze({
  id: 'bme280-3v3-i2c-0x76-v1',
  title: 'BME280 3.3V I2C breakout',
  prompt: 'Design a 24mm by 18mm, two-layer BME280 I2C breakout powered by an external regulated 3.3V supply. Use exactly one BME280, one four-pin 2.54mm vertical header, two 100nF 0402 X7R decoupling capacitors and two 4.7k ohm 0402 pull-up resistors. Header pins 1, 2, 3 and 4 are 3V3, GND, SDA and SCL. Connect both sensor supplies and CSB directly to 3V3, SDO directly to GND for I2C address 0x76, one capacitor from each sensor supply to GND, and one pull-up from each I2C signal to 3V3. Keep each decoupler supply pad within 2mm of its corresponding sensor supply pad on the front layer. Use a 3.3V-compatible external host at no more than 100kHz with external bus capacitance no more than 100pF. Do not add a regulator, battery, MCU, level shifter, other components, enclosure or firmware. This request covers electronics only; mechanical, simulation, firmware, sourcing, manufacturing and physical validation are not run.',
  board: Object.freeze({ widthMm: 24, heightMm: 18, layers: 2 }),
  supply: Object.freeze({ source: 'external', nominalV: 3.3, minimumV: 3.135, maximumV: 3.465 }),
  interface: 'I2C',
  address: '0x76',
  electricalContract: Object.freeze({
    templateId: 'bme280-3v3-i2c-0x76-v1',
    sensor: 'BME280', sensorCount: 1,
    supply: Object.freeze({ source: 'external', nominalV: 3.3 }),
    interface: 'I2C', address: '0x76',
    headerPins: Object.freeze(['3V3', 'GND', 'SDA', 'SCL']),
    headerPitchMm: 2.54,
    capacitors: Object.freeze({ count: 2, valueNf: 100, package: '0402', dielectric: 'X7R' }),
    pullups: Object.freeze({ count: 2, resistanceOhm: 4700, package: '0402' }),
    csb: '3V3', sdo: 'GND', vdd: '3V3', vddio: '3V3',
    clockHzMax: 100000, externalBusCapacitancePfMax: 100,
    maxDecouplerPadDistanceMm: 2,
  }),
  headerPins: Object.freeze(['3V3', 'GND', 'SDA', 'SCL']),
  keyBlocks: Object.freeze([
    'BME280 x1',
    'External regulated 3.3V; VDD/VDDIO/CSB=3V3; SDO=GND',
    'I2C 0x76; maximum 100kHz; external bus maximum 100pF',
    '4-pin 2.54mm vertical header: 1=3V3, 2=GND, 3=SDA, 4=SCL',
    '100nF 0402 X7R decouplers x2; one per sensor supply; maximum 2mm pad distance',
    '4.7k ohm 0402 pull-ups x2; SDA/SCL to 3V3',
  ]),
  notRun: Object.freeze(['mechanical', 'simulation', 'firmware', 'manufacturing', 'supplyChain', 'validation']),
  notice: 'Only this reviewed breakout is supported. Selecting it starts a new explicit request; it does not convert or satisfy a different draft. Astra authors the specification and proposed netlist. Native checks remain required; this is not manufacturing or hardware qualification.',
})

export class AstraDesignContractError extends Error {
  readonly category = 'policy'
  constructor(message: string) {
    super(`Astra design scope rejected: ${message}`)
    this.name = 'AstraDesignContractError'
  }
}
function reject(message: string): never { throw new AstraDesignContractError(message) }
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) reject('unexpected or missing fields')
}
function text(value: unknown, label: string, maximum = 1000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) reject(`invalid ${label}`)
}
function exactSize(value: unknown): void {
  if (!object(value)) reject('requires explicit 24mm by 18mm board dimensions')
  keys(value, ['x', 'y'])
  if (value.x !== ASTRA_DESIGN_TEMPLATE.board.widthMm || value.y !== ASTRA_DESIGN_TEMPLATE.board.heightMm) reject('only the selected 24mm by 18mm board dimensions are supported')
}

export type AstraArchitectRequest = {
  templateId: typeof ASTRA_DESIGN_TEMPLATE.id
  request: string
  answers: []
}

/** Validate BEFORE architect inference. Exact selected text is deliberate: a
 * templateId accompanying a different arbitrary intent does not grant consent
 * to convert that intent. No semantic regex classification or silent defaults.
 */
export function validateAstraArchitectRequest(value: unknown): AstraArchitectRequest {
  if (!object(value)) reject('select the BME280 template explicitly')
  keys(value, ['templateId', 'request', 'answers'])
  if (value.templateId !== ASTRA_DESIGN_TEMPLATE.id || value.request !== ASTRA_DESIGN_TEMPLATE.prompt) reject('select the supported BME280 template; arbitrary requests are not converted')
  if (!Array.isArray(value.answers) || value.answers.length !== 0) reject('the fixed template does not accept free-form interview answers')
  return { templateId: ASTRA_DESIGN_TEMPLATE.id, request: value.request, answers: [] }
}

export type AstraSpecification = ProductSpec & {
  disciplines: ProductSpec['disciplines'] & {
    electronics: ProductSpec['disciplines']['electronics'] & { contract: typeof ASTRA_DESIGN_TEMPLATE.electricalContract }
  }
}

function exactContract(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => exactContract(actual[i], item))
  if (object(expected)) return object(actual) && Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([key, item]) => Object.hasOwn(actual, key) && exactContract(actual[key], item))
  return actual === expected
}

/** Validate RAW model output before normalization/storage, and revalidate the
 * stored result before electronics inference. ProductSpec's beta extension
 * carries machine-checked electrical requirements. Narrative labels are bounded
 * display text only; they never add capabilities or relax this scope. The model
 * still supplies the spec and subsequent netlist; this function does not invent
 * either, coerce values, fill omitted disciplines or repair unsupported outputs.
 */
export function validateAstraSpecification(value: unknown, selectedTemplateId: unknown): AstraSpecification {
  if (selectedTemplateId !== ASTRA_DESIGN_TEMPLATE.id) reject('workflow has no supported explicitly selected template')
  if (!object(value)) reject('requires a model-authored specification')
  keys(value, ['product', 'description', 'budgets', 'disciplines'], ['openQuestions'])
  text(value.product, 'product name', 120)
  text(value.description, 'description')
  if (!object(value.budgets)) reject('invalid budgets')
  keys(value.budgets, [], ['sizeMm'])
  if (Object.hasOwn(value.budgets, 'sizeMm')) exactSize(value.budgets.sizeMm)
  if (Object.hasOwn(value, 'openQuestions') && (!Array.isArray(value.openQuestions) || value.openQuestions.length)) reject('unresolved questions are unsupported by the fixed template')
  if (!object(value.disciplines)) reject('missing discipline scopes')
  const otherDisciplines = ['mechanical', 'firmware', 'manufacturing', 'supplyChain', 'validation'] as const
  keys(value.disciplines, ['electronics', ...otherDisciplines])
  const electronics = value.disciplines.electronics
  if (!object(electronics)) reject('missing electronics requirements')
  keys(electronics, ['status', 'summary', 'boardIntent', 'maxBoardMm', 'layers', 'contract'], ['keyBlocks'])
  text(electronics.summary, 'electronics summary')
  text(electronics.boardIntent, 'board intent', 2500)
  if (electronics.status !== 'defined') reject('electronics must be defined, not built or skipped')
  if (!exactContract(electronics.contract, ASTRA_DESIGN_TEMPLATE.electricalContract)) reject('electrical contract, rails, address or component requirements contradict the template')
  if (electronics.layers !== ASTRA_DESIGN_TEMPLATE.board.layers) reject('this native template starts at exactly two layers')
  exactSize(electronics.maxBoardMm)
  if (Object.hasOwn(electronics, 'keyBlocks')) {
    if (!Array.isArray(electronics.keyBlocks) || electronics.keyBlocks.length > 6) reject('invalid display block labels')
    for (const block of electronics.keyBlocks) text(block, 'display block label', 240)
  }
  for (const name of otherDisciplines) {
    const discipline = value.disciplines[name]
    if (!object(discipline)) reject(`missing ${name} scope`)
    keys(discipline, ['status', 'summary', 'requirements'])
    text(discipline.summary, `${name} summary`)
    if (discipline.status !== 'not_applicable' || !Array.isArray(discipline.requirements) || discipline.requirements.length) reject(`${name} deliverables are outside the electronics-only request; no physical validation or sourcing is performed`)
  }
  // All returned fields have been checked, no untrusted extras survive. Clone to
  // prevent the original proposal object from changing the stored requirement.
  return structuredClone(value) as unknown as AstraSpecification
}

/** Additional beta architect instructions, not a prewritten output spec.
 * Generic ProductSpec prompts include battery/DFM/other scopes; beta callers must
 * use this narrower schema and must not call normalizeSpec before validation.
 */
export function astraSpecificationPrompt(): string {
  return [
    'The user explicitly selected the fixed BME280 requirements template below. Do not reinterpret other products, ask clarification questions, add scopes, normalize missing fields or propose substitutes.',
    'Return ONLY {"enough":true,"spec":<your ProductSpec>}. Author product, description, electronics summary and boardIntent as short factual descriptions of this template. These narrative fields are descriptive, not electrical authority. No qualification or completed-test claims.',
    'spec must have exactly product, description, budgets, disciplines and optionally openQuestions:[]. budgets must be {} or {"sizeMm":{"x":24,"y":18}}. No costs, battery, runtime, enclosure, reliability, manufacturing or sourcing promises.',
    'disciplines must contain exactly electronics, mechanical, firmware, manufacturing, supplyChain, validation. electronics must contain status:"defined", summary, boardIntent, maxBoardMm:{"x":24,"y":18}, layers:2, and contract copied exactly from template.electricalContract. Optional keyBlocks is at most six short display labels. No other electronics fields. The structured contract is authoritative; do not omit or alter its rails, address, component values or counts.',
    'Each other discipline must contain exactly status:"not_applicable", summary:"Not requested in the electronics-only template; not run.", requirements:[]. These statuses describe request scope, not completed work. Native DRC/connectivity is separate from physical validation.',
    JSON.stringify(ASTRA_DESIGN_TEMPLATE),
  ].join('\n')
}

export const ASTRA_ARCHITECT_SYSTEM = astraSpecificationPrompt()
