import { AstraError } from './astra-execution'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Independently validate the ground partition; an island count is not a pad count. */
export function astraGroundConnected(value: unknown): boolean {
  const required = ['C1.2', 'C2.2', 'J1.2', 'U1.1', 'U1.5', 'U1.7']
  const invalid = () => new AstraError('output', 'Anchored native ground evidence is incomplete.')
  if (!record(value) || value.available !== true || value.anchor !== 'J1.2'
    || value.method !== 'native-effective-shape-polygon-components-v1'
    || !Array.isArray(value.reachedPads) || !Array.isArray(value.unreachedPads) || !Array.isArray(value.padComponents)) throw invalid()
  const partition: string[][] = []
  const seen = new Set<string>()
  for (const group of value.padComponents) {
    if (!Array.isArray(group) || group.length === 0) throw invalid()
    for (const pad of group) {
      if (typeof pad !== 'string' || !required.includes(pad) || seen.has(pad)) throw invalid()
      seen.add(pad)
    }
    partition.push(group)
  }
  if (seen.size !== required.length) throw invalid()
  const anchor = partition.find(group => group.includes('J1.2'))!
  const complement = required.filter(pad => !anchor.includes(pad))
  const matches = (actual: unknown[], expected: string[]) => actual.length === expected.length
    && new Set(actual).size === actual.length && actual.every(pad => typeof pad === 'string' && expected.includes(pad))
  if (!matches(value.reachedPads, anchor) || !matches(value.unreachedPads, complement)) throw invalid()
  return complement.length === 0
}
