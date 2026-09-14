/**
 * KiCad 10.0.5 JSON DRC contract, not a generic array-counting success detector.
 * Version-pinned upstream sources (report schema v1 != engine version 10.0.5):
 * https://github.com/KiCad/kicad-source-mirror/blob/10.0.5/include/rc_json_schema.h
 * https://github.com/KiCad/kicad-source-mirror/blob/10.0.5/resources/schemas/drc.v1.json
 * https://github.com/KiCad/kicad-source-mirror/blob/10.0.5/pcbnew/drc/drc_report.cpp
 * https://github.com/KiCad/kicad-source-mirror/blob/10.0.5/pcbnew/pcb_marker.cpp
 * https://github.com/KiCad/kicad-source-mirror/blob/10.0.5/kicad/cli/command_pcb_drc.cpp
 * https://github.com/KiCad/kicad-source-mirror/blob/10.0.5/common/string_utils.cpp
 *
 * Required invocation: pcb drc --format json --units mm --severity-all
 * No --schematic-parity: this workflow has no source schematic to check.
 * A valid report is still not cryptographic provenance. The caller must bind its
 * bytes to the checked tool invocation and the unchanged final board hash.
 */
export const ASTRA_DRC_SCHEMA = 'https://schemas.kicad.org/drc.v1.json'
export type AstraDrcContext = {
  engineVersion: '10.0.5'
  source: 'final-board.kicad_pcb'
  schematicParity: 'not-run'
}
export type AstraDrcCounts = { total: number; errors: number; warnings: number; excluded: number }
export interface AstraDrcEvidence {
  available: true
  /** DRC section only. Connectivity and parity are separate upstream providers. */
  errors: number
  warnings: number
  unrouted: number
  schematicParity: 'not-run'
  rawCounts: { violations: AstraDrcCounts; unconnected_items: AstraDrcCounts; schematic_parity: AstraDrcCounts }
  excludedCounts: { violations: number; unconnected_items: number; schematic_parity: number; total: number }
  ignoredChecks: { key: string; description: string }[]
  includedSeverities: ('error' | 'warning' | 'exclusion')[]
  checksComplete: boolean
  /** This native-report gate says nothing about schematic parity or function. */
  passed: boolean
  provenance: { schema: string; engineVersion: '10.0.5'; source: 'final-board.kicad_pcb'; date: string; coordinateUnits: 'mm' }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Native DRC report is invalid: ${message}`)
}
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value)

function reportDate(value: unknown): value is string {
  // GetISO8601CurrentDateTime uses wxDateTime::FormatISOCombined('T'), a
  // timezone-less local timestamp. Preserve it; never fabricate a UTC suffix.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) return false
  const ms = Date.parse(`${value}Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value
}

function section(value: unknown, label: string): AstraDrcCounts {
  requireEvidence(Array.isArray(value), `${label} must be present as an array.`)
  const counts: AstraDrcCounts = { total: value.length, errors: 0, warnings: 0, excluded: 0 }
  for (const entry of value) {
    requireEvidence(object(entry) && exactKeys(entry, ['type', 'description', 'severity', 'items'], ['excluded', 'comment']), `${label} entry fields.`)
    requireEvidence(typeof entry.type === 'string' && entry.type.length > 0 && typeof entry.description === 'string', `${label} entry description/type.`)
    requireEvidence(entry.severity === 'error' || entry.severity === 'warning', `${label} entry severity.`)
    requireEvidence(!Object.hasOwn(entry, 'excluded') || typeof entry.excluded === 'boolean', `${label} exclusion flag.`)
    requireEvidence(!Object.hasOwn(entry, 'comment') || typeof entry.comment === 'string', `${label} exclusion comment.`)
    requireEvidence(Array.isArray(entry.items), `${label} affected items.`)
    for (const item of entry.items) {
      requireEvidence(object(item) && exactKeys(item, ['uuid', 'description', 'pos']) && uuid(item.uuid) && typeof item.description === 'string', `${label} affected item identity.`)
      requireEvidence(object(item.pos) && exactKeys(item.pos, ['x', 'y']) && finite(item.pos.x) && finite(item.pos.y), `${label} affected item coordinates.`)
    }
    // Exclusions retain their original severity. They are never waived here.
    if (entry.severity === 'error') counts.errors++
    else counts.warnings++
    if (entry.excluded === true) counts.excluded++
  }
  return counts
}

export function parseAstraDrcReport(value: unknown, expected: AstraDrcContext): AstraDrcEvidence {
  requireEvidence(expected?.engineVersion === '10.0.5' && expected.source === 'final-board.kicad_pcb' && expected.schematicParity === 'not-run', 'unqualified engine/source/schematic context.')
  const keys = ['$schema', 'source', 'date', 'kicad_version', 'violations', 'unconnected_items', 'schematic_parity', 'coordinate_units', 'included_severities', 'ignored_checks']
  requireEvidence(object(value) && exactKeys(value, keys), 'all exact serializer fields are required.')
  requireEvidence(value.$schema === ASTRA_DRC_SCHEMA && value.kicad_version === expected.engineVersion && value.source === expected.source, 'schema, engine or board identity mismatch.')
  requireEvidence(reportDate(value.date), 'generation timestamp.')
  requireEvidence(value.coordinate_units === 'mm', 'expected millimetre coordinates.')
  const includedSeverities = value.included_severities
  requireEvidence(Array.isArray(includedSeverities) && includedSeverities.length === 3
    && ['error', 'warning', 'exclusion'].every(severity => includedSeverities.includes(severity)), 'full --severity-all coverage is required.')
  const rawCounts = {
    violations: section(value.violations, 'violations'),
    unconnected_items: section(value.unconnected_items, 'unconnected_items'),
    schematic_parity: section(value.schematic_parity, 'schematic_parity'),
  }
  requireEvidence(Array.isArray(value.ignored_checks), 'ignored_checks must be present as an array.')
  const ignoredChecks = value.ignored_checks.map(item => {
    requireEvidence(object(item) && exactKeys(item, ['key', 'description']) && typeof item.key === 'string' && item.key.length > 0 && typeof item.description === 'string', 'ignored check entry.')
    return { key: item.key, description: item.description }
  })
  const excludedCounts = {
    violations: rawCounts.violations.excluded,
    unconnected_items: rawCounts.unconnected_items.excluded,
    schematic_parity: rawCounts.schematic_parity.excluded,
    total: rawCounts.violations.excluded + rawCounts.unconnected_items.excluded + rawCounts.schematic_parity.excluded,
  }
  const checksComplete = ignoredChecks.length === 0 && excludedCounts.total === 0 && rawCounts.schematic_parity.total === 0
  return {
    available: true, errors: rawCounts.violations.errors, warnings: rawCounts.violations.warnings,
    unrouted: rawCounts.unconnected_items.total, schematicParity: 'not-run', rawCounts, excludedCounts, ignoredChecks,
    includedSeverities: [...includedSeverities] as AstraDrcEvidence['includedSeverities'],
    checksComplete, passed: checksComplete && rawCounts.violations.errors === 0 && rawCounts.unconnected_items.total === 0,
    provenance: { schema: ASTRA_DRC_SCHEMA, engineVersion: expected.engineVersion, source: expected.source, date: value.date, coordinateUnits: 'mm' },
  }
}
