/**
 * Discipline artifact — the GENERIC contract for the non-electronics specialist
 * modules (firmware, manufacturing, supply chain, validation). Each is a
 * SEPARATE module/stage, but all share this one mechanism: the product engine
 * emits a structured artifact (titled sections of items) grounded in the real
 * spec + built board, at an honest fidelity. Specialization lives in the
 * per-discipline guidance (data), not in code.
 *
 * These are GENERATED advisory artifacts (architecture / plan / estimate), not
 * compiled/validated/live-sourced deliverables — the fidelity says so.
 */

export interface DisciplineSection {
  title: string
  items: string[]
}

export interface DisciplineArtifact {
  discipline: string
  title: string
  summary: string
  fidelity: string // e.g. "generated architecture" | "generated plan" | "estimated (not live supplier data)"
  sections: DisciplineSection[]
}

/** Modules that use this generic mechanism, with their per-discipline guidance
 *  and honest fidelity label. */
export const DISCIPLINE_MODULES: Record<
  string,
  { label: string; fidelity: string; guidance: string }
> = {
  firmware: {
    label: 'Firmware',
    fidelity: 'generated architecture',
    guidance:
      'Firmware ARCHITECTURE grounded in the board\'s real components: a peripheral/driver map (MCU/SoC, sensors, radio, PMIC), the task/RTOS structure, the power-state machine (sleep/wake/active budgets), the connectivity stack (e.g. BLE GATT services), OTA/update strategy, and build targets. This is an architecture, NOT compiled or validated firmware.',
  },
  manufacturing: {
    label: 'Manufacturing',
    fidelity: 'generated plan',
    guidance:
      'Manufacturing PACKAGE for this board: SMT/reflow process flow, panelization + fiducials, DFM checks specific to the layer count / component count / size, test strategy (ICT / flying-probe / functional test), NPI stages (EVT/DVT/PVT), and the main yield + cost drivers. A plan, not a validated MPI.',
  },
  supplyChain: {
    label: 'Supply chain',
    fidelity: 'estimated (not live supplier data)',
    guidance:
      'Supply-chain SOURCING grounded in the real BOM: the critical/long-lead components, single-source risks and recommended second sources / alternates, rough lead-time + availability posture, and cost drivers at the target volume. Estimates from engineering judgment — NOT live distributor/supplier data. Flag where a live parts API would be needed.',
  },
  validation: {
    label: 'Validation',
    fidelity: 'generated plan',
    guidance:
      'Validation / TEST PLAN: a requirement-to-test matrix derived from the product spec + the simulation results, DVT/PVT test stages, environmental + reliability tests (drop, ingress/IP, thermal cycle, battery cycle life, RF/OTA), acceptance criteria, and sample sizes. A plan, not executed test results.',
  },
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])

export function normalizeDisciplineArtifact(
  raw: Partial<DisciplineArtifact> | undefined,
  discipline: string,
): DisciplineArtifact {
  const s = (raw ?? {}) as DisciplineArtifact
  const mod = DISCIPLINE_MODULES[discipline]
  const sections: DisciplineSection[] = Array.isArray(s.sections)
    ? s.sections
        .filter((x) => x && typeof x.title === 'string')
        .map((x) => ({ title: x.title, items: list(x.items) }))
        .filter((x) => x.items.length > 0)
    : []
  return {
    discipline,
    title: s.title || mod?.label || discipline,
    summary: s.summary || '',
    fidelity: s.fidelity || mod?.fidelity || 'generated',
    sections,
  }
}

/** The JSON contract the product engine emits for a discipline artifact. */
export const DISCIPLINE_ARTIFACT_SCHEMA = `{
  "title": "<short title>",
  "summary": "<one or two sentences>",
  "fidelity": "<the honest fidelity label>",
  "sections": [
    { "title": "<section name>", "items": ["<concrete point>", "..."] }
  ]
}`
