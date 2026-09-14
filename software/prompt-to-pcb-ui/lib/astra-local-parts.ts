import { AstraError } from '@/lib/astra-execution'
import catalog from './astra-catalog.json'

/** Reviewed electrical intent and exact asset bytes are not native qualification.
 * No provider output, registry entry or supplier search can extend this catalog.
 */
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}
export const ASTRA_CATALOG = freezeDeep(catalog)
export const ASTRA_CATALOG_ID = catalog.id
export type AstraCatalogId = keyof typeof catalog.assets
export type AstraPartReference = keyof typeof catalog.parts
export type AstraNetName = '3V3' | 'GND' | 'SDA' | 'SCL'
export type AstraCanonicalNet = { name: AstraNetName; pins: string[] }
type PartKind = 'chip' | 'capacitor' | 'resistor' | 'connector'
export type AstraValidatedPart = {
  name: string
  catalogId: AstraCatalogId
  footprint: string
  kind: PartKind
  /** Empty for generic engineering specifications: never a fabricated supplier MPN. */
  mpn: string
  value: string
  /** Exact reviewed source retained for interface compatibility, not reconstruction. */
  kicadMod: string
}
export type AstraValidatedNetlist = {
  parts: AstraValidatedPart[]
  /** Original validated proposal edges, not a substituted reference circuit. */
  nets: string[][]
  gnd: string[]
  canonicalNets: AstraCanonicalNet[]
  catalogId: string
  layoutConstraints: typeof catalog.contract.layoutConstraints
}

export const ASTRA_ELECTRONICS_BLOCKERS = Object.freeze([
  'The reviewed BME280 electrical catalog does not establish native runner readiness: exact pad rotation/shape and model transforms after load, route, export and reload remain unverified.',
  'Native executable pinning, descendant filesystem/network containment, final DRC/connectivity measurements and artifact publication must pass the audited native capability preflight before inference.',
])
export const ASTRA_ELECTRONICS_BLOCKER = `Astra electronics blocked before inference: ${ASTRA_ELECTRONICS_BLOCKERS.join(' ')}`

/** Read-only qualification check. Dynamic import avoids a catalog/verifier cycle;
 * no environment/client override, probe or automatic qualification is allowed.
 */
export async function preflightAstraElectronics(): Promise<void> {
  const { readAstraReadiness } = await import('./astra-readiness')
  const status = await readAstraReadiness()
  if (!status.ready) throw new AstraError('policy', status.reason)
}

const references = Object.keys(catalog.parts) as AstraPartReference[]
function assetFor(ref: AstraPartReference) {
  return catalog.assets[catalog.parts[ref].catalogId as AstraCatalogId]
}
function footprintFor(ref: AstraPartReference) {
  const { libraryPath, name } = assetFor(ref).footprint
  return `${libraryPath.split('/').at(-1)!.replace(/\.pretty$/, '')}:${name}`
}

export function astraLocalPartsPrompt(): string {
  return [
    'Design ONLY the reviewed externally powered 3.3V BME280 I2C breakout. Return ONLY a JSON object with parts, nets and gnd. Do not add or substitute parts or invent MPNs.',
    'parts must contain every listed reference exactly once, with exactly name, footprint, kind, mpn and value. Empty mpn means a generic engineering specification, not a sourced or qualified part. Copy each value exactly.',
    'nets is an array of two-endpoint connection edges using reference.numericPad IDs. gnd is an array of ground endpoints joined together. Edges may form chains; their connected components must equal the required nets. Include all 20 pins exactly once in the resulting four canonical nets. Never join different required nets.',
    'CSB U1.2 is directly strapped to 3V3/VDDIO, SDO U1.5 directly to GND for 7-bit address 0x76. J1 pins 1,2,3,4 are 3V3,GND,SDA,SCL. No 5V, regulator, battery, MCU, level shifter or SPI.',
    'Do not return code, lcsc, kicadMod, model paths, placement, source_part or classifier fields. Required layout constraints will be measured by the native runner; they are not a schematic pass.',
    JSON.stringify({
      parts: references.map((name) => {
        const part = catalog.parts[name]
        return { name, footprint: footprintFor(name), kind: part.kind, mpn: part.mpn, value: part.value }
      }),
      specifications: Object.fromEntries(references.map((name) => [name, catalog.parts[name].specification])),
      contract: catalog.contract,
    }),
  ].join('\n')
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
function reject(message: string): never { throw new AstraError('policy', `Astra local netlist rejected: ${message}`) }
function fields(value: Record<string, unknown>, required: string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === required.length && required.every((key) => Object.hasOwn(value, key))
}

/** Validate the complete electrical graph, not merely pin membership. Union the
 * proposal's edges and ground set, then compare every component to the reviewed
 * pin partition. This rejects shorted rails/signals, floating supplies, missing
 * decouplers/pullups, swapped header pins and incorrect CSB/SDO straps.
 */
export function validateAstraLocalNetlist(value: unknown): AstraValidatedNetlist {
  if (!object(value) || !fields(value, ['parts', 'nets', 'gnd'])) reject('unexpected or missing board fields')
  const { parts, nets, gnd } = value
  if (!Array.isArray(parts) || parts.length !== references.length) reject('requires exactly one BME280, one four-pin header, two 100nF capacitors and two 4.7k pull-ups')
  if (!Array.isArray(nets) || nets.length < 1 || nets.length > 32) reject('requires 1 to 32 two-pin connection edges')
  if (!Array.isArray(gnd) || gnd.length < 1 || gnd.length > 6) reject('requires a bounded ground net')
  const names = new Set<string>()
  const pins = new Set<string>()
  const mapped = parts.map((part: unknown): AstraValidatedPart => {
    if (!object(part) || !fields(part, ['name', 'footprint', 'kind', 'mpn', 'value'])) reject('unexpected or missing part fields')
    if (typeof part.name !== 'string' || names.has(part.name) || !Object.hasOwn(catalog.parts, part.name)) reject('invalid, duplicate or unsupported reference')
    const ref = part.name as AstraPartReference
    const approved = catalog.parts[ref]
    if (part.footprint !== footprintFor(ref) || part.kind !== approved.kind || part.mpn !== approved.mpn || part.value !== approved.value) reject('part identity, value or footprint does not match the reviewed catalog')
    names.add(ref)
    const asset = assetFor(ref)
    for (const pin of asset.padNumbers) pins.add(`${ref}.${pin}`)
    return { name: ref, catalogId: approved.catalogId as AstraCatalogId, footprint: footprintFor(ref), kind: approved.kind as PartKind, mpn: approved.mpn, value: approved.value, kicadMod: asset.footprint.source }
  })
  if (references.some((ref) => !names.has(ref))) reject('missing required part')
  const endpoint = (pin: unknown): string => {
    if (typeof pin !== 'string' || !pins.has(pin)) reject('unknown or unsafe pin ID')
    return pin
  }
  const ground = gnd.map(endpoint)
  if (new Set(ground).size !== ground.length) reject('duplicate ground pin')
  const parent = new Map([...pins].map((pin) => [pin, pin]))
  const root = (pin: string): string => {
    let current = pin
    while (parent.get(current) !== current) current = parent.get(current)!
    return current
  }
  const union = (a: string, b: string) => { parent.set(root(b), root(a)) }
  for (const pin of ground.slice(1)) union(ground[0], pin)
  const seen = new Set<string>()
  const connections = nets.map((net: unknown): string[] => {
    if (!Array.isArray(net) || net.length !== 2) reject('edges must have exactly two endpoints')
    const pair = net.map(endpoint)
    if (pair[0] === pair[1]) reject('self connection')
    const key = [...pair].sort().join(':')
    if (seen.has(key)) reject('duplicate connection')
    seen.add(key)
    union(pair[0], pair[1])
    return pair
  })
  const components = new Map<string, string[]>()
  for (const pin of pins) {
    const key = root(pin)
    const group = components.get(key) ?? []
    group.push(pin)
    components.set(key, group)
  }
  if (components.size !== catalog.contract.canonicalNets.length) reject('missing required connection, floating pin or short between required nets')
  const canonicalNets = catalog.contract.canonicalNets.map((expected): AstraCanonicalNet => {
    const actual = [...components.get(root(expected.pins[0]))!].sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected.pins)) reject(`incorrect ${expected.name} topology or rail/signal short`)
    if (expected.name === 'GND' && ground.some((pin) => !actual.includes(pin))) reject('ground list contains a non-ground pin')
    return { name: expected.name as AstraNetName, pins: actual }
  })
  return {
    parts: mapped, nets: connections, gnd: ground, canonicalNets,
    catalogId: ASTRA_CATALOG_ID,
    layoutConstraints: structuredClone(catalog.contract.layoutConstraints),
  }
}

/** Pure helper for measured final-board pad locations. Native validation must
 * supply actual pad centers/layers after routing, never merely planned poses.
 * This is a geometric layout check, not a trace-length or decoupling simulation.
 */
export function validateAstraDecouplerPlacement(value: unknown): void {
  if (!object(value)) reject('missing measured pad positions')
  const position = (pin: string) => {
    const p = value[pin]
    if (!object(p) || typeof p.xMm !== 'number' || !Number.isFinite(p.xMm) || typeof p.yMm !== 'number' || !Number.isFinite(p.yMm) || p.layer !== 'F.Cu') reject(`missing or invalid front-layer pad measurement for ${pin}`)
    return { xMm: p.xMm, yMm: p.yMm }
  }
  for (const constraint of catalog.contract.layoutConstraints.decouplers) {
    const cap = position(constraint.supplyPin)
    const sensor = position(constraint.sensorSupplyPin)
    position(constraint.groundPin)
    if (Math.hypot(cap.xMm - sensor.xMm, cap.yMm - sensor.yMm) > constraint.maxPadDistanceMm) reject(`${constraint.capacitor} exceeds the ${constraint.maxPadDistanceMm}mm supply-pad placement limit`)
  }
}
