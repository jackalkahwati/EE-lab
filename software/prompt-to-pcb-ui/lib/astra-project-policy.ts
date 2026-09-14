import { AstraError } from './astra-execution'
import { ASTRA_CATALOG } from './astra-local-parts'

const requiredChecks = ['missing_courtyard', 'track_not_centered_on_via', 'tuning_profile_track_geometries', 'footprint_filters_mismatch', 'footprint_type_mismatch']
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Verify persisted policy after the native process has exited; never repair it here. */
export function validateAstraProjectPolicy(value: unknown): void {
  const fail = () => { throw new AstraError('output', 'Persisted native project check policy is incomplete or weakened.') }
  if (!object(value) || !object(value.board) || !object(value.board.design_settings)) return fail()
  const settings = value.board.design_settings
  if (!object(settings.rule_severities) || !object(settings.rules)
    || !Array.isArray(settings.drc_exclusions) || settings.drc_exclusions.length !== 0
    || settings.rules.min_resolved_spokes !== 2) return fail()
  const severities = settings.rule_severities
  if (requiredChecks.some(key => severities[key] !== 'error')
    || Object.values(severities).some(value => value !== 'error' && value !== 'warning')) return fail()
  const rules = settings.rules
  for (const [key, expected] of Object.entries({ min_clearance: 0.15, min_track_width: 0.15, min_via_diameter: 0.6,
    min_through_hole_diameter: 0.3, min_via_annular_width: 0.15, min_hole_clearance: 0.25,
    min_hole_to_hole: 0.25, min_copper_edge_clearance: 0.5 })) {
    if (rules[key] !== expected) return fail()
  }
}

export function expectedAstraFootprintTable(): string {
  const libraries = new Map<string, string>()
  for (const asset of Object.values(ASTRA_CATALOG.assets)) {
    const directory = asset.footprint.libraryPath
    const name = directory.split('/').at(-1)!.replace(/\.pretty$/, '')
    if (libraries.has(name) && libraries.get(name) !== directory) throw new AstraError('policy', 'Conflicting reviewed footprint libraries.')
    libraries.set(name, directory)
  }
  const rows = [...libraries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, directory]) => `  (lib (name ${JSON.stringify(name)})(type KiCad)(uri ${JSON.stringify(directory)})(options "")(descr ""))\n`).join('')
  return `(fp_lib_table\n  (version 7)\n${rows})\n`
}
