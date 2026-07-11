/**
 * Product Spec — the contract the Product Architect produces and every
 * engineering specialist consumes. A product intent ("invisible AI earbud,
 * sub-$40 BOM, all-day battery") decomposes into product-level budgets plus a
 * per-discipline requirement block.
 *
 * Electronics is the one discipline with a real specialist today (Compose): its
 * `boardIntent` feeds the existing board interview. Every other discipline is
 * DECLARED honestly — its requirements are written, but `status` says plainly
 * whether a specialist has built it. No discipline is ever shown as "built"
 * unless a specialist actually produced a gated result. That honesty is the
 * point: the Architect coordinates real work, it does not fabricate subsystems.
 */

export type DisciplineStatus =
  | 'defined' // requirements written; no specialist has built it yet
  | 'building' // a specialist is running now
  | 'built' // a specialist produced a real, gated result
  | 'not_applicable' // this product does not need this discipline

export const DISCIPLINES = [
  'electronics',
  'mechanical',
  'firmware',
  'manufacturing',
  'supplyChain',
  'validation',
] as const
export type Discipline = (typeof DISCIPLINES)[number]

export const DISCIPLINE_LABELS: Record<Discipline, string> = {
  electronics: 'Electronics',
  mechanical: 'Mechanical',
  firmware: 'Firmware',
  manufacturing: 'Manufacturing',
  supplyChain: 'Supply chain',
  validation: 'Validation (FL-1)',
}

export interface Budgets {
  unitCostUsd?: number // target build/BOM cost per unit
  sizeMm?: { x?: number; y?: number; z?: number } // max product envelope
  massG?: number // target mass
  power?: {
    activeMw?: number
    sleepUw?: number
    batteryMah?: number
    runtimeHours?: number
  }
  reliability?: string // "consumer 2yr" | "industrial IP54" | ...
  volumeUnits?: number // annual volume target (drives DFM / cost)
}

/** Electronics requirement — shaped to hand straight to the board interview. */
export interface ElectronicsReq {
  status: DisciplineStatus
  summary: string
  boardIntent: string // natural-language board request -> /api/interview
  keyBlocks?: string[] // functional blocks the product implies
  maxBoardMm?: { x?: number; y?: number }
  layers?: number
}

/** A declared, not-yet-built discipline. */
export interface DisciplineReq {
  status: DisciplineStatus
  summary: string
  requirements?: string[] // what this specialist must deliver
}

export interface ProductSpec {
  product: string // short product name
  description: string // one line: what it is
  audience?: string // who it is for
  philosophy?: string // the point of view (minimal / invisible / ambient / ...)
  budgets: Budgets
  disciplines: {
    electronics: ElectronicsReq
    mechanical: DisciplineReq & { enclosureKind?: string }
    firmware: DisciplineReq
    manufacturing: DisciplineReq
    supplyChain: DisciplineReq
    validation: DisciplineReq
  }
  openQuestions?: string[]
}

/** The board request the electronics specialist (Compose) should build. */
export function boardIntentOf(spec: ProductSpec): string {
  const e = spec?.disciplines?.electronics
  return (e?.boardIntent || spec?.description || spec?.product || '').trim()
}

/** Discipline status rows for honest UI rendering. */
export function disciplineRows(
  spec: ProductSpec,
): { discipline: Discipline; label: string; status: DisciplineStatus; summary: string }[] {
  const d = spec?.disciplines ?? ({} as ProductSpec['disciplines'])
  return DISCIPLINES.map((k) => ({
    discipline: k,
    label: DISCIPLINE_LABELS[k],
    status: (d as Record<string, DisciplineReq>)[k]?.status ?? 'defined',
    summary: (d as Record<string, DisciplineReq>)[k]?.summary ?? '',
  }))
}

/**
 * Normalize an LLM-produced spec: guarantee every discipline block exists with a
 * status, so downstream code and the UI never see a missing field. Only
 * electronics may later flip to 'built' (when Compose runs); the rest stay
 * 'defined' unless the model marked them 'not_applicable'.
 */
export function normalizeSpec(raw: Partial<ProductSpec> | undefined): ProductSpec {
  const s = (raw ?? {}) as ProductSpec
  const d = (s.disciplines ?? {}) as Partial<ProductSpec['disciplines']>
  const req = (r: Partial<DisciplineReq> | undefined): DisciplineReq => ({
    status: r?.status ?? 'defined',
    summary: r?.summary ?? '',
    requirements: Array.isArray(r?.requirements) ? r!.requirements : [],
  })
  return {
    product: s.product || 'Untitled product',
    description: s.description || '',
    audience: s.audience,
    philosophy: s.philosophy,
    budgets: s.budgets ?? {},
    disciplines: {
      electronics: {
        status: d.electronics?.status ?? 'defined',
        summary: d.electronics?.summary ?? '',
        boardIntent: d.electronics?.boardIntent || s.description || '',
        keyBlocks: Array.isArray(d.electronics?.keyBlocks) ? d.electronics!.keyBlocks : [],
        maxBoardMm: d.electronics?.maxBoardMm,
        layers: d.electronics?.layers,
      },
      mechanical: { ...req(d.mechanical), enclosureKind: d.mechanical?.enclosureKind },
      firmware: req(d.firmware),
      manufacturing: req(d.manufacturing),
      supplyChain: req(d.supplyChain),
      validation: req(d.validation),
    },
    openQuestions: Array.isArray(s.openQuestions) ? s.openQuestions : [],
  }
}

/** The exact JSON contract the Architect LLM must emit (embedded in its prompt). */
export const PRODUCT_SPEC_SCHEMA = `{
  "product": "<short name>",
  "description": "<one sentence: what it is>",
  "audience": "<who it is for>",
  "philosophy": "<the point of view: minimal | invisible | ambient | rugged | ...>",
  "budgets": {
    "unitCostUsd": <number or omit>,
    "sizeMm": { "x": <n>, "y": <n>, "z": <n> },
    "massG": <number or omit>,
    "power": { "activeMw": <n>, "sleepUw": <n>, "batteryMah": <n>, "runtimeHours": <n> },
    "reliability": "<e.g. consumer 2yr>",
    "volumeUnits": <annual volume or omit>
  },
  "disciplines": {
    "electronics": {
      "status": "defined",
      "summary": "<what the board must do>",
      "boardIntent": "<a concrete, buildable board request the electronics team will build, e.g. 'BLE SoC + MEMS mic + Li-ion charger + status LED, 12x12mm 4-layer'>",
      "keyBlocks": ["<block>", "..."],
      "maxBoardMm": { "x": <n>, "y": <n> },
      "layers": <2|4|8 or omit>
    },
    "mechanical":    { "status": "defined", "enclosureKind": "<earbud-shell | handheld | enclosure | potting | none>", "summary": "<what mechanical must build>", "requirements": ["..."] },
    "firmware":      { "status": "defined", "summary": "...", "requirements": ["..."] },
    "manufacturing": { "status": "defined", "summary": "...", "requirements": ["..."] },
    "supplyChain":   { "status": "defined", "summary": "...", "requirements": ["..."] },
    "validation":    { "status": "defined", "summary": "...", "requirements": ["..."] }
  },
  "openQuestions": ["<unresolved product decisions>", "..."]
}`
