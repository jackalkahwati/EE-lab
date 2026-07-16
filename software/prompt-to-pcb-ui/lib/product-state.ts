/**
 * Product state — the shared system model (orchestrator roadmap, Stage A).
 * One JSON per run unifying what every stage already persists, each section
 * carrying presence + content hash + validation status. The DEPENDENCY graph
 * is DECLARED data (auditable, no inference): field -> what a change affects.
 * Stage B (scorecard) reads sections; Stage C (propagation) walks the graph.
 * This module is pure and client-safe — all fs work lives in the API route.
 */

export type SectionStatus = 'passed' | 'failed' | 'warnings' | 'unverified' | 'absent'

export interface StateSection {
  present: boolean
  /** sha1 of the artifact file(s) — change detection for Stage C */
  hash?: string
  status: SectionStatus
  /** tiny extract for the scorecard — NEVER the whole artifact */
  summary?: Record<string, unknown>
  paths: string[]
}

export interface ProductState {
  runId: string
  assembledAt: string
  sections: Record<string, StateSection>
  graph: typeof DEPENDENCY_EDGES
}

/**
 * The constraint/dependency graph, declared: a change to KEY invalidates each
 * listed dependent (section names or other keys — the walk is transitive).
 * Deliberately coarse in Stage A; Stage C refines granularity as it needs.
 */
export const DEPENDENCY_EDGES: Record<string, string[]> = {
  'spec.budgets': ['electronics', 'power'],
  'spec.product': ['id.brief', 'electronics'],
  'electronics.board': ['mechanical', 'id.scaffold', 'simulation', 'firmware'],
  'electronics.bom': ['supplyChain', 'manufacturing', 'cost', 'power'],
  'electronics.mcu': ['firmware', 'power'],
  power: ['electronics.board'],
  'id.brief': ['id.render', 'mechanical'],
  'id.envelope': ['mechanical'],
  'mechanical.enclosure': ['manufacturing', 'simulation'],
  simulation: ['validation'],
}

/** Transitive closure of what a change to `field` affects (BFS, cycle-safe). */
export function affectedBy(field: string, edges: Record<string, string[]> = DEPENDENCY_EDGES): string[] {
  const seen = new Set<string>()
  const queue = [field]
  const enqueued = new Set<string>([field])
  while (queue.length) {
    const f = queue.shift() as string
    for (const dep of edges[f] ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep)
        if (!enqueued.has(dep)) {
          enqueued.add(dep)
          queue.push(dep)
        }
      }
    }
  }
  seen.delete(field)
  return [...seen].sort()
}

/** Section name -> the run-relative artifact files it is assembled from. */
export const SECTION_SOURCES: Record<string, string[]> = {
  spec: ['product-spec.json'],
  'id.brief': ['disciplines/id-brief.json'],
  'id.render': ['id/render.json', 'id/consistency.json'],
  electronics: [
    'data/design.json',
    'data/design-tree.json',
    'data/verification.json',
    'data/devices.json',
    'data/drc.json',
    'data/substitutions.json',
    'electronics/chipscale-board.json',
  ],
  bom: ['data/bom.json'],
  power: ['data/power-budget.json'],
  mechanical: ['mechanical/mechanical.json', 'disciplines/mech-fidelity.json'],
  simulation: ['disciplines/simulation.json'],
  firmware: ['disciplines/firmware.json'],
  manufacturing: ['disciplines/manufacturing.json'],
  supplyChain: ['disciplines/supplyChain.json'],
  validation: ['disciplines/validation.json'],
  timing: ['timing.json'],
  stageHashes: ['stage-hashes.json'],
}
