/**
 * Mechanical build plan — the GENERIC, product-engine-directed contract for the
 * mechanical module. The product engine (LLM) decides WHAT to build (an in-ear
 * shell, a bracket, a potting box, a plate) and emits an ordered list of
 * parametric CAD operations in a small, safe vocabulary. A thin executor renders
 * that plan into real Onshape geometry and exports STEP — it never bakes in a
 * fixed "enclosure recipe". Specialization lives in this plan (data), not code.
 *
 * Coordinates are millimetres, in a right-handed frame: the XY plane is the base
 * (Top) plane, +Z is up (height/thickness). Sketch profiles are centred at
 * (cx, cy) unless noted. See tools/onshape/features.py for the renderer.
 *
 * KERNEL SEAM (kept open, integration deferred): this plan is the kernel-agnostic
 * contract. The Onshape/Parasolid executor (app/api/mechanical/route.ts) is ONE
 * consumer. A second executor — build123d/OCCT for owned B-rep, or PicoGK for
 * field/lattice interiors — is a clean addition: it consumes the SAME MechPlan
 * and emits STEP/mesh, no plan changes. Deferred on purpose (Experiments A/B:
 * B-rep with clamped fillets already covers the current prismatic vertical; add
 * a field backend only when a part needs a lattice or conformal channel). The
 * fillet clamp below is exactly the discipline that makes an OCCT executor viable
 * (12%→96% success), so the seam is ready when the need is real.
 */

export type MechProfile =
  | { kind: 'roundedRect'; cx: number; cy: number; w: number; h: number; r?: number }
  | { kind: 'rect'; cx: number; cy: number; w: number; h: number }
  | { kind: 'circle'; cx: number; cy: number; d: number }
  // annulus (two concentric circles) — pocket it for grooves/channels/registration
  // steps, extrude it for raised rims. Rendered with filterInnerLoops so only the
  // ring of material between dInner and dOuter is touched.
  | { kind: 'ring'; cx: number; cy: number; dOuter: number; dInner: number }

/** One parametric operation. Generic across product categories. */
export type MechOp =
  | { op: 'sketch'; name: string; plane?: 'top' | 'front' | 'right'; profile: MechProfile }
  | { op: 'extrude'; name: string; sketch: string; depth: number; offset?: number; merge?: boolean }
  | { op: 'pocket'; name: string; sketch: string; depth: number; offset?: number } // material removal
  | { op: 'standoff'; name: string; x: number; y: number; height: number; od: number; holeDia?: number; baseZ?: number }
  // offsetMm (side faces only): start the cut offsetMm from the centre datum
  // plane so it pierces ONE wall ([offsetMm, offsetMm+depth] toward +Y for
  // 'front'); without it the cut is symmetric about the centre plane.
  | { op: 'cutout'; name: string; face: 'top' | 'front' | 'right'; cx: number; cy: number; w: number; h: number; depth: number; offsetMm?: number }
  // round an outer edge of a previously extruded body (real Onshape fillet).
  // body = the 'extrude' op name (defaults to the first extrude, the main shell)
  | { op: 'fillet'; name: string; body?: string; radiusMm: number; scope?: 'outer-top' | 'outer-bottom' | 'all-outer' }
  // a representative internal component (PCB, battery, antenna, speaker…) placed
  // in the cavity as its own body, so the packaging is visible and fit is honest
  | { op: 'component'; name: string; kind: 'pcb' | 'battery' | 'antenna' | 'speaker' | 'generic'; shape?: 'box' | 'cyl'; cx: number; cy: number; cz: number; w: number; h: number; thickness: number }

export interface MechPlan {
  part: string // name of the part being built
  units: 'mm'
  operations: MechOp[]
  notes?: string // one line: what this mechanical piece is / how it serves the product
  // honest record of automatic corrections (e.g. fillet radii clamped to a
  // locally-valid size). Empty/absent when the plan needed no correction.
  adjustments?: string[]
}

const num = (v: unknown, d = 0): number => (typeof v === 'number' && isFinite(v) ? v : d)

/**
 * Clamp fillet radii to a locally-valid size. A round bigger than the wall it
 * sits on is what makes a kernel fail (all-or-nothing "command not done" in
 * OCCT; benchmarked at only 12% success under blind radii, 96% when clamped —
 * Experiment A). Clamping here, in the kernel-agnostic plan, fixes it for the
 * current Onshape executor AND any future kernel, and it is good manufacturing
 * practice regardless. Radii are only ever reduced, never grown.
 */
function clampFillets(ops: MechOp[], adjustments: string[]): MechOp[] {
  // wall thickness = the shell wall the outer edge sits on. Best proxy is the
  // smallest positive pocket offset (the innerCavity wall); fall back to the
  // thinnest extrude, then a conservative default.
  const pocketWalls = ops.filter((o) => o.op === 'pocket' && typeof (o as any).offset === 'number' && (o as any).offset > 0)
    .map((o) => (o as any).offset as number)
  const extrudeDepths = ops.filter((o) => o.op === 'extrude').map((o) => (o as any).depth as number).filter((d) => d > 0)
  const minWall = pocketWalls.length ? Math.min(...pocketWalls)
    : extrudeDepths.length ? Math.min(...extrudeDepths) * 0.5
    : 2.0
  const maxSafe = Math.max(0.3, 0.45 * minWall) // never below 0.3mm; ~half the wall
  return ops.map((o) => {
    if (o.op !== 'fillet') return o
    if (o.radiusMm > maxSafe) {
      adjustments.push(
        `fillet '${o.name}' radius ${o.radiusMm}mm → ${round2(maxSafe)}mm (clamped to ≤0.45×wall ${round2(minWall)}mm so the round is manufacturable and the kernel does not fail)`,
      )
      return { ...o, radiusMm: round2(maxSafe) }
    }
    return o
  })
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Validate + coerce an LLM-produced plan; drop malformed ops so the executor
 *  never sees a broken operation. */
export function normalizeMechPlan(raw: Partial<MechPlan> | undefined): MechPlan {
  const s = (raw ?? {}) as MechPlan
  const coerced: MechOp[] = Array.isArray(s.operations)
    ? (s.operations.map(coerceOp).filter(Boolean) as MechOp[])
    : []
  const adjustments: string[] = []
  const ops = clampFillets(coerced, adjustments)
  return {
    part: s.part || 'Part',
    units: 'mm',
    operations: ops,
    notes: typeof s.notes === 'string' ? s.notes : undefined,
    adjustments: adjustments.length ? adjustments : undefined,
  }
}

function coerceProfile(p: any): MechProfile | null {
  if (!p || typeof p !== 'object') return null
  if (p.kind === 'circle') return { kind: 'circle', cx: num(p.cx), cy: num(p.cy), d: num(p.d) }
  if (p.kind === 'ring') {
    const dOuter = num(p.dOuter), dInner = num(p.dInner)
    // a degenerate ring (inner ≥ outer, or non-positive) is meaningless — drop
    // the op so the executor never cuts a full disc where a channel was meant
    if (!(dOuter > 0 && dInner > 0 && dInner < dOuter)) return null
    return { kind: 'ring', cx: num(p.cx), cy: num(p.cy), dOuter, dInner }
  }
  if (p.kind === 'rect') return { kind: 'rect', cx: num(p.cx), cy: num(p.cy), w: num(p.w), h: num(p.h) }
  // default to rounded rect
  return { kind: 'roundedRect', cx: num(p.cx), cy: num(p.cy), w: num(p.w), h: num(p.h), r: num(p.r, 0) }
}

function coerceOp(o: any): MechOp | null {
  if (!o || typeof o !== 'object' || typeof o.op !== 'string') return null
  const name = typeof o.name === 'string' ? o.name : o.op
  switch (o.op) {
    case 'sketch': {
      const profile = coerceProfile(o.profile)
      if (!profile) return null
      return { op: 'sketch', name, plane: o.plane === 'front' || o.plane === 'right' ? o.plane : 'top', profile }
    }
    case 'extrude':
      if (typeof o.sketch !== 'string') return null
      return { op: 'extrude', name, sketch: o.sketch, depth: num(o.depth), offset: o.offset != null ? num(o.offset) : undefined, merge: !!o.merge }
    case 'pocket':
      if (typeof o.sketch !== 'string') return null
      return { op: 'pocket', name, sketch: o.sketch, depth: num(o.depth), offset: o.offset != null ? num(o.offset) : undefined }
    case 'standoff':
      return { op: 'standoff', name, x: num(o.x), y: num(o.y), height: num(o.height), od: num(o.od), holeDia: o.holeDia != null ? num(o.holeDia) : undefined, baseZ: o.baseZ != null ? num(o.baseZ) : undefined }
    case 'cutout':
      return { op: 'cutout', name, face: o.face === 'front' || o.face === 'right' ? o.face : 'top', cx: num(o.cx), cy: num(o.cy), w: num(o.w), h: num(o.h), depth: num(o.depth), offsetMm: o.offsetMm != null ? num(o.offsetMm) : undefined }
    case 'fillet': {
      const radiusMm = num(o.radiusMm)
      if (!(radiusMm > 0)) return null
      const scopes = ['outer-top', 'outer-bottom', 'all-outer']
      return { op: 'fillet', name, body: typeof o.body === 'string' ? o.body : undefined, radiusMm, scope: scopes.includes(o.scope) ? o.scope : 'outer-top' }
    }
    case 'component': {
      const kinds = ['pcb', 'battery', 'antenna', 'speaker', 'generic']
      return { op: 'component', name, kind: kinds.includes(o.kind) ? o.kind : 'generic', shape: o.shape === 'cyl' ? 'cyl' : 'box', cx: num(o.cx), cy: num(o.cy), cz: num(o.cz), w: num(o.w), h: num(o.h), thickness: num(o.thickness, 1) }
    }
    default:
      return null
  }
}

/** The JSON contract the product engine must emit (embedded in its prompt). */
export const MECH_PLAN_SCHEMA = `{
  "part": "<name, e.g. 'In-ear shell' | 'Mounting bracket'>",
  "units": "mm",
  "notes": "<one line: what this piece is and how it serves the product>",
  "operations": [
    { "op": "sketch",   "name": "baseOutline", "plane": "top", "profile": { "kind": "roundedRect", "cx": 0, "cy": 0, "w": <board w + walls>, "h": <board h + walls>, "r": <corner radius> } },
    { "op": "extrude",  "name": "body", "sketch": "baseOutline", "depth": <outer height> },
    { "op": "sketch",   "name": "cavity", "plane": "top", "profile": { "kind": "roundedRect", "cx": 0, "cy": 0, "w": <board w + clearance>, "h": <board h + clearance>, "r": <r> } },
    { "op": "pocket",   "name": "innerCavity", "sketch": "cavity", "depth": <cavity depth>, "offset": <wall thickness> },
    { "op": "standoff", "name": "mount1", "x": <x>, "y": <y>, "height": <standoff h>, "od": <boss dia>, "holeDia": <screw dia>, "baseZ": <wall thickness> },
    { "op": "cutout",   "name": "usbPort", "face": "front", "cx": <x>, "cy": <z of connector centre>, "w": <port w>, "h": <port h>, "depth": <wall + 1>, "offsetMm": <inner wall distance - 1, so the cut pierces ONE wall> },
    { "op": "sketch",   "name": "ledChannel", "plane": "top", "profile": { "kind": "ring", "cx": 0, "cy": 0, "dOuter": <n>, "dInner": <n> } },
    { "op": "pocket",   "name": "ledChannelCut", "sketch": "ledChannel", "depth": <channel depth>, "offset": <z where the channel starts> },
    { "op": "fillet",   "name": "lidRound", "body": "<name of the extrude op to round>", "radiusMm": 1.5, "scope": "outer-top" },
    { "op": "component", "name": "PCB", "kind": "pcb", "shape": "box", "cx": 0, "cy": 0, "cz": <wall thickness>, "w": <REAL board width>, "h": <REAL board height>, "thickness": 1.6 },
    { "op": "component", "name": "battery", "kind": "battery", "shape": "box", "cx": <x>, "cy": <y>, "cz": <above PCB>, "w": <batt w>, "h": <batt h>, "thickness": <batt t> },
    { "op": "component", "name": "antenna", "kind": "antenna", "shape": "box", "cx": <x>, "cy": <y>, "cz": <z>, "w": <ant w>, "h": <ant h>, "thickness": 0.5 }
  ]
}
ALWAYS include "component" ops for the real PCB (use its ACTUAL given dimensions, not a shrunk guess), the battery, and the antenna, placed in the cavity — so the packaging is visible and any fit problem is honest. If the real PCB is larger than the cavity, still place it at its true size; do NOT shrink it to fake a fit.`
