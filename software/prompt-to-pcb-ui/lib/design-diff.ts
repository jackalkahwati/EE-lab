/**
 * Design diff — structured delta between two runs, computed purely from
 * artifacts both runs already persist. Nothing is inferred by an LLM; every
 * line of a diff traces to a real file. Missing artifacts produce an honest
 * `available: false` section, never a fabricated "no change".
 */
import fs from 'node:fs'
import path from 'node:path'

export type FieldDelta = { label: string; from: unknown; to: unknown }
export type BomDelta = {
  added: { ref: string; part: string }[]
  removed: { ref: string; part: string }[]
  changed: { ref: string; from: string; to: string }[]
}
export type DiffSection<T> = { available: boolean; note?: string; delta: T }

export type DesignDiff = {
  from: string
  to: string
  board: DiffSection<FieldDelta[]>
  bom: DiffSection<BomDelta>
  enclosure: DiffSection<FieldDelta[]>
  budgets: DiffSection<FieldDelta[]>
  simulation: DiffSection<FieldDelta[]>
}

function readJson(runId: string, rel: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'public', 'runs', runId, rel), 'utf8'))
  } catch {
    return null
  }
}

function field(label: string, from: unknown, to: unknown, out: FieldDelta[]) {
  const norm = (v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v ?? null)
  const a = norm(from), b = norm(to)
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ label, from: a, to: b })
}

function boardDiff(a: any, b: any): DiffSection<FieldDelta[]> {
  if (!a?.boardMm || !b?.boardMm) {
    return { available: false, note: 'chip-scale board missing on one side', delta: [] }
  }
  const d: FieldDelta[] = []
  field('width mm', a.boardMm.w, b.boardMm.w, d)
  field('height mm', a.boardMm.h, b.boardMm.h, d)
  field('shape', a.boardShape ?? 'rect', b.boardShape ?? 'rect', d)
  field('layers', a.layers, b.layers, d)
  field('components', a.components, b.components, d)
  field('routed traces', a.routedTraces, b.routedTraces, d)
  field('DRC errors', a.drc?.errors, b.drc?.errors, d)
  field('unrouted nets', a.drcRepair?.unrouted, b.drcRepair?.unrouted, d)
  return { available: true, delta: d }
}

/** Component map from the chip-scale board artifact (ref → part/footprint). */
function partsOf(board: any): Map<string, string> {
  const m = new Map<string, string>()
  for (const c of board?.parts ?? []) {
    const ref = String(c.name ?? c.ref ?? '')
    if (ref) m.set(ref, String(c.part ?? c.footprint ?? c.kind ?? 'unknown'))
  }
  return m
}

function bomDiff(runA: string, runB: string, boardA: any, boardB: any): DiffSection<BomDelta> {
  // The SHIPPED board's part list (chip-scale) is the ref set — data/bom.json
  // describes the vestigial variant board (same shipped-board principle as
  // the Programs evidence). bom.json only ENRICHES labels with real part
  // names where refs line up.
  const names = (runId: string): Map<string, string> => {
    const m = new Map<string, string>()
    const bom = readJson(runId, 'data/bom.json')
    for (const r of Array.isArray(bom) ? bom : bom?.rows ?? bom?.lines ?? []) {
      // bom.json rows may carry comma-separated refs ("FID1, FID2") — expand
      for (const ref of String(r.ref ?? r.refs ?? '').split(',').map((x: string) => x.trim()).filter(Boolean)) {
        m.set(ref, String(r.part ?? r.mpn ?? r.value ?? 'unknown'))
      }
    }
    return m
  }
  // Value = part name + footprint, so a swap of EITHER shows as a change
  // (a bom.json name alone would mask a footprint change on the shipped board).
  const enrich = (base: Map<string, string>, lbl: Map<string, string>) => {
    const out = new Map<string, string>()
    for (const [ref, v] of base) out.set(ref, lbl.has(ref) ? `${lbl.get(ref)} (${v})` : v)
    return out
  }
  const a = enrich(partsOf(boardA), names(runA))
  const b = enrich(partsOf(boardB), names(runB))
  if (a.size === 0 && b.size === 0) {
    return { available: false, note: 'no BOM/part list on either side', delta: { added: [], removed: [], changed: [] } }
  }
  const delta: BomDelta = { added: [], removed: [], changed: [] }
  for (const [ref, part] of b) {
    if (!a.has(ref)) delta.added.push({ ref, part })
    else if (a.get(ref) !== part) delta.changed.push({ ref, from: a.get(ref)!, to: part })
  }
  for (const [ref, part] of a) {
    if (!b.has(ref)) delta.removed.push({ ref, part })
  }
  return { available: true, delta }
}

function enclosureDiff(runA: string, runB: string): DiffSection<FieldDelta[]> {
  const a = readJson(runA, 'mechanical/mechanical.json')
  const b = readJson(runB, 'mechanical/mechanical.json')
  if (!a || !b) {
    return { available: false, note: 'enclosure not built on one side', delta: [] }
  }
  const d: FieldDelta[] = []
  field('enclosure w mm', a.fitCheck?.enclosureMm?.w, b.fitCheck?.enclosureMm?.w, d)
  field('enclosure h mm', a.fitCheck?.enclosureMm?.h, b.fitCheck?.enclosureMm?.h, d)
  field('PCB fits', a.fitCheck?.fits, b.fitCheck?.fits, d)
  field('mounting aligned', a.mountingAligned, b.mountingAligned, d)
  field('features', (a.features ?? []).join(', '), (b.features ?? []).join(', '), d)
  field('fastening', a.fastening?.mode, b.fastening?.mode, d)
  return { available: true, delta: d }
}

function budgetsDiff(runA: string, runB: string): DiffSection<FieldDelta[]> {
  const a = readJson(runA, 'product-spec.json')
  const b = readJson(runB, 'product-spec.json')
  if (!a || !b) return { available: false, note: 'product spec missing on one side', delta: [] }
  const d: FieldDelta[] = []
  const ba = a.budgets ?? {}, bb = b.budgets ?? {}
  field('unit cost $', ba.unitCostUsd, bb.unitCostUsd, d)
  field('size x mm', ba.sizeMm?.x, bb.sizeMm?.x, d)
  field('size y mm', ba.sizeMm?.y, bb.sizeMm?.y, d)
  field('size z mm', ba.sizeMm?.z, bb.sizeMm?.z, d)
  field('mass g', ba.massG, bb.massG, d)
  field('active mW', ba.power?.activeMw, bb.power?.activeMw, d)
  field('battery mAh', ba.power?.batteryMah, bb.power?.batteryMah, d)
  field('volume units/yr', ba.volumeUnits, bb.volumeUnits, d)
  return { available: true, delta: d }
}

function simDiff(runA: string, runB: string): DiffSection<FieldDelta[]> {
  const a = readJson(runA, 'disciplines/simulation.json')
  const b = readJson(runB, 'disciplines/simulation.json')
  if (!a?.results || !b?.results) {
    return { available: false, note: 'simulation not run on one side', delta: [] }
  }
  const key = (r: any) => `${r.sim} ${r.metric ?? ''}`.trim()
  const byKey = (rs: any[]) => new Map(rs.filter((r) => !r.error).map((r) => [key(r), r]))
  const ma = byKey(a.results), mb = byKey(b.results)
  const d: FieldDelta[] = []
  for (const [k, rb] of mb) {
    const ra = ma.get(k)
    if (!ra) field(k, null, `${rb.value} ${rb.unit ?? ''}`.trim(), d)
    else if (ra.value !== rb.value || ra.pass !== rb.pass) {
      field(k, `${ra.value} ${ra.unit ?? ''}${ra.pass === false ? ' FAIL' : ''}`.trim(),
        `${rb.value} ${rb.unit ?? ''}${rb.pass === false ? ' FAIL' : ''}`.trim(), d)
    }
  }
  for (const [k, ra] of ma) {
    if (!mb.has(k)) field(k, `${ra.value} ${ra.unit ?? ''}`.trim(), null, d)
  }
  return { available: true, delta: d }
}

export function designDiff(fromRun: string, toRun: string): DesignDiff {
  const boardA = readJson(fromRun, 'electronics/chipscale-board.json')
  const boardB = readJson(toRun, 'electronics/chipscale-board.json')
  return {
    from: fromRun,
    to: toRun,
    board: boardDiff(boardA, boardB),
    bom: bomDiff(fromRun, toRun, boardA, boardB),
    enclosure: enclosureDiff(fromRun, toRun),
    budgets: budgetsDiff(fromRun, toRun),
    simulation: simDiff(fromRun, toRun),
  }
}
