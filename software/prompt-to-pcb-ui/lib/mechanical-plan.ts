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

// ---------------------------------------------------------------------------
// Cavity selection + honest fit evaluation (pure; unit-testable; no imports so
// scripts/replay-cavity.mjs can load this file under Node's type stripping).
//
// Why this exists: the old picker took "the largest pocket ≥ ½ max depth below
// the base top". On real runs that chose a ⌀6 mount-hole pocket for a 30×24
// board (bare PCB assembly, no cavity at all) and a 34×22 display WINDOW over
// the round board cavity of a puck. The fit test then failed against the wrong
// pocket, and nothing was persisted to diagnose it. The selection below is
// tiered, records every candidate + why it was rejected, and returns
// null/'unknown' rather than failing when no board cavity can be identified.
// ---------------------------------------------------------------------------

export type FitShape = { kind: 'circle'; d: number } | { kind: 'rect'; w: number; h: number }
export type CavitySource = 'named' | 'encloses_pcb' | 'largest_qualifying' | 'none'
export type FitVerdict = 'fits' | 'does_not_fit' | 'unknown'

export interface CavityCandidate {
  op: string
  sketch: string
  profileKind: string
  shape: FitShape | null // null for ring / degenerate profiles
  cx: number
  cy: number
  depth: number
  offset: number
  /** why this pocket was NOT chosen (absent on the chosen one) */
  rejected?: string
}

export interface CavitySelection {
  shape: FitShape | null
  depth: number | null
  op: string | null
  sketch: string | null
  source: CavitySource
  /** every pocket examined, with the rejection reason for the losers */
  candidates: CavityCandidate[]
  /** the base shell top (z) used to drop lid pockets; Infinity when no extrude */
  baseTop: number
}

/** minimum pocket depth that can hold a PCB (1.6 mm board) — shallower pockets
 *  (pad recesses, score lines, bezel steps) are styling, never the cavity */
const MIN_CAVITY_DEPTH = 1.5
/** a round pocket narrower than this is a hole/boss pilot, not a board cavity */
const MIN_ROUND_CAVITY_D = 15
/** names that mark a pocket as explicitly NOT the board cavity (tiers b/c) */
const NON_CAVITY_NAME = /hole|screw|window|vent|louv|slot|groove|lip|channel|radome|\bled|led\b|diffus|pad|foot|grip|slip|btn|button|bezel|\bstep|seat|logo|score|text|label/i
/** names a tier-(a) match must NOT carry — a batteryCavity / lidCavity is not the board cavity */
const NAMED_CAVITY_EXCLUDE = /battery|batt|antenna|speaker|lid|cap\b|led|light|diffus|lens|window/i
const NAMED_CAVITY_EXACT = /^(inner|pcb|board|main)?[-_ ]?cavity$/i

const isFinitePos = (v: unknown): v is number => typeof v === 'number' && isFinite(v) && v > 0

export function profileToShape(p: MechProfile | undefined | null): FitShape | null {
  if (!p) return null
  if (p.kind === 'circle') return isFinitePos(p.d) ? { kind: 'circle', d: p.d } : null
  if (p.kind === 'ring') return null
  return isFinitePos(p.w) && isFinitePos(p.h) ? { kind: 'rect', w: p.w, h: p.h } : null
}

export const shapeArea = (s: FitShape | null): number =>
  !s ? 0 : s.kind === 'circle' ? (Math.PI * s.d * s.d) / 4 : s.w * s.h

export const shapeStr = (s: FitShape): string =>
  s.kind === 'circle' ? `⌀${round1(s.d)}` : `${round1(s.w)}×${round1(s.h)}`

export const shapeDims = (s: FitShape): { w: number; h: number } =>
  s.kind === 'circle' ? { w: Math.round(s.d), h: Math.round(s.d) } : { w: Math.round(s.w), h: Math.round(s.h) }

const round1 = (n: number) => Math.round(n * 10) / 10

/** inner fits inside outer (+slack), both centred, shape-aware: circle-in-circle
 *  by diameter, rect-in-circle by the DIAGONAL, circle-in-rect by the min side
 *  (a round board must clear the cavity's NARROW dimension). */
export function shapeContains(outer: FitShape, inner: FitShape, slack: number): boolean {
  if (outer.kind === 'circle') {
    const D = outer.d + slack
    return inner.kind === 'circle' ? inner.d <= D : Math.hypot(inner.w, inner.h) <= D
  }
  const W = outer.w + slack, H = outer.h + slack
  return inner.kind === 'circle' ? inner.d <= Math.min(W, H) : inner.w <= W && inner.h <= H
}

/** position-aware: does the pocket (centre pcx,pcy) enclose the PCB component
 *  footprint (centre bcx,bcy)? Used for tier (b), where the plan's own PCB op
 *  tells us where the board sits. */
function pocketEnclosesFootprint(
  pocket: FitShape, pcx: number, pcy: number,
  pcb: FitShape, bcx: number, bcy: number,
): boolean {
  const dx = bcx - pcx, dy = bcy - pcy
  if (pocket.kind === 'circle') {
    const R = pocket.d / 2
    if (pcb.kind === 'circle') return Math.hypot(dx, dy) + pcb.d / 2 <= R + 1e-6
    const hw = pcb.w / 2, hh = pcb.h / 2
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].every(([x, y]) => Math.hypot(dx + x, dy + y) <= R + 1e-6)
  }
  const hw = pocket.w / 2, hh = pocket.h / 2
  if (pcb.kind === 'circle') {
    const r = pcb.d / 2
    return Math.abs(dx) + r <= hw + 1e-6 && Math.abs(dy) + r <= hh + 1e-6
  }
  return Math.abs(dx) + pcb.w / 2 <= hw + 1e-6 && Math.abs(dy) + pcb.h / 2 <= hh + 1e-6
}

export function pcbShapeFromComponent(plan: MechPlan): { shape: FitShape; cx: number; cy: number } | null {
  const op = plan.operations.find((o) => o.op === 'component' && o.kind === 'pcb')
  if (!op || op.op !== 'component') return null
  if (!isFinitePos(op.w) || !isFinitePos(op.h)) return null
  return {
    shape: op.shape === 'cyl' ? { kind: 'circle', d: op.w } : { kind: 'rect', w: op.w, h: op.h },
    cx: op.cx, cy: op.cy,
  }
}

/**
 * Pick the pocket that is the BOARD CAVITY. Tiers, in order:
 *  (a) 'named'              — pocket/sketch named cavity | innerCavity | pcbCavity …
 *                              (exact names rank above partial; batteryCavity etc. excluded)
 *  (b) 'encloses_pcb'       — a base-shell pocket that geometrically encloses the
 *                              plan's own `component kind=pcb` footprint (position-aware)
 *  (c) 'largest_qualifying' — the largest base-shell pocket whose dims exceed the
 *                              real PCB by `margin`, excluding holes/windows/vents
 *                              by name, shallow pockets, and round pockets < 15 mm
 *  else 'none'              — shape null; the caller reports verdict 'unknown'.
 * `pcb` is the REAL board (ground truth) used for tier (c); tier (b) uses the
 * plan's PCB component because that carries a position.
 */
export function selectCavity(plan: MechPlan, pcb: FitShape | null, margin = 1.0): CavitySelection {
  const ops = plan.operations
  const sketches = new Map<string, MechProfile>()
  for (const o of ops) if (o.op === 'sketch') sketches.set(o.name, o.profile)

  // base shell top: the tallest extrude that starts at the base plane. The lid
  // is modelled floating at base+4 and so self-excludes; a short skirt extruded
  // first (real run e5631ea3: skirtBody before body) no longer masks the shell.
  let baseTop = -Infinity
  for (const o of ops) {
    if (o.op !== 'extrude') continue
    const off = o.offset ?? 0
    if (off <= 0.01 && isFinitePos(o.depth)) baseTop = Math.max(baseTop, off + o.depth)
  }
  if (!isFinite(baseTop)) baseTop = Infinity

  const candidates: CavityCandidate[] = []
  for (const o of ops) {
    if (o.op !== 'pocket') continue
    const prof = sketches.get(o.sketch)
    const shape = profileToShape(prof)
    candidates.push({
      op: o.name, sketch: o.sketch, profileKind: prof?.kind ?? 'missing', shape,
      cx: prof ? prof.cx : 0, cy: prof ? prof.cy : 0,
      depth: o.depth ?? 0, offset: o.offset ?? 0,
    })
  }
  const done = (chosen: CavityCandidate | null, source: CavitySource): CavitySelection => ({
    shape: chosen?.shape ?? null,
    depth: chosen ? chosen.depth : null,
    op: chosen?.op ?? null,
    sketch: chosen?.sketch ?? null,
    source,
    candidates,
    baseTop,
  })

  const name = (c: CavityCandidate) => `${c.op} ${c.sketch}`
  const usable = candidates.filter((c) => {
    if (!c.shape) { c.rejected = `${c.profileKind} profile — not a containable shape`; return false }
    return true
  })

  // (a) named — an EXACT cavity name always counts; a partial match ('cavityFloor')
  // counts only when the name carries no feature word, so 'cavityVent' /
  // 'cavityDrainSlot' can never become "the cavity" and fail the board against it
  const exact = (c: CavityCandidate) => NAMED_CAVITY_EXACT.test(c.op) || NAMED_CAVITY_EXACT.test(c.sketch) ? 1 : 0
  const named = usable.filter((c) =>
    !NAMED_CAVITY_EXCLUDE.test(name(c)) && (exact(c) || (/cavity/i.test(name(c)) && !NON_CAVITY_NAME.test(name(c)))))
  if (named.length) {
    named.sort((x, y) => exact(y) - exact(x) || y.depth - x.depth || shapeArea(y.shape) - shapeArea(x.shape))
    const win = named[0]
    for (const c of usable) if (c !== win) c.rejected = named.includes(c) ? 'named cavity, but a better-ranked named cavity exists' : `a named cavity ('${win.op}') takes precedence`
    return done(win, 'named')
  }

  // shared filters for (b)/(c): base shell only, deep enough, not typed as a feature
  const inBase = usable.filter((c) => {
    if (c.offset >= baseTop - 0.01) { c.rejected = `starts at z=${c.offset} ≥ base top ${round1(baseTop)} (lid pocket)`; return false }
    if (c.depth < MIN_CAVITY_DEPTH) { c.rejected = `depth ${c.depth} mm < ${MIN_CAVITY_DEPTH} mm (too shallow for a board)`; return false }
    const m = name(c).match(NON_CAVITY_NAME)
    if (m) { c.rejected = `name marks it as a '${m[0].toLowerCase()}' feature, not a cavity`; return false }
    if (c.shape!.kind === 'circle' && c.shape!.d < MIN_ROUND_CAVITY_D) { c.rejected = `round pocket ⌀${round1(c.shape!.d)} < ${MIN_ROUND_CAVITY_D} mm (a hole, not a cavity)`; return false }
    return true
  })

  // (b) encloses the plan's PCB component footprint
  const comp = pcbShapeFromComponent(plan)
  if (comp) {
    const enclosing = inBase.filter((c) => pocketEnclosesFootprint(c.shape!, c.cx, c.cy, comp.shape, comp.cx, comp.cy))
    if (enclosing.length) {
      enclosing.sort((x, y) => y.depth - x.depth || shapeArea(y.shape) - shapeArea(x.shape))
      const win = enclosing[0]
      for (const c of inBase) if (c !== win) c.rejected = enclosing.includes(c) ? `encloses the PCB op but '${win.op}' is deeper/larger` : `does not enclose the PCB op footprint ${shapeStr(comp.shape)} at (${comp.cx}, ${comp.cy})`
      return done(win, 'encloses_pcb')
    }
    for (const c of inBase) c.rejected = `does not enclose the PCB op footprint ${shapeStr(comp.shape)} at (${comp.cx}, ${comp.cy})`
  }

  // (c) largest pocket that exceeds the real PCB by the margin in both dims
  if (pcb) {
    const grown: FitShape = pcb.kind === 'circle' ? { kind: 'circle', d: pcb.d + margin } : { kind: 'rect', w: pcb.w + margin, h: pcb.h + margin }
    const qualifying = inBase.filter((c) => shapeContains(c.shape!, grown, 0))
    if (qualifying.length) {
      qualifying.sort((x, y) => shapeArea(y.shape) - shapeArea(x.shape))
      const win = qualifying[0]
      for (const c of inBase) if (c !== win) c.rejected = qualifying.includes(c) ? `qualifies but '${win.op}' is larger` : `${shapeStr(c.shape!)} does not exceed PCB ${shapeStr(pcb)} + ${margin} mm margin`
      return done(win, 'largest_qualifying')
    }
    for (const c of inBase) c.rejected = `${shapeStr(c.shape!)} does not exceed PCB ${shapeStr(pcb)} + ${margin} mm margin`
  } else {
    for (const c of inBase) c.rejected = 'no PCB dimensions to qualify against'
  }
  return done(null, 'none')
}

export interface FitEvaluation {
  verdict: FitVerdict
  /** true ONLY on 'fits', false ONLY on 'does_not_fit', NULL on 'unknown'.
   *  'unknown' used to report true, so an enclosure whose board cavity could
   *  not be identified sealed a VERIFIED fit into the evidence record and
   *  printed "PCB 24x24mm fits the cavity" in the pipeline detail. The fit was
   *  never checked. Null is the third state that was missing. */
  fits: boolean | null
  problems: string[]
}

/** shortfall text: "short by 2 mm in X, 4 mm in Y" / diagonal / narrow-side */
function shortfall(cavity: FitShape, pcb: FitShape, slack: number): string {
  if (cavity.kind === 'circle') {
    const D = cavity.d + slack
    const need = pcb.kind === 'circle' ? pcb.d : Math.hypot(pcb.w, pcb.h)
    return pcb.kind === 'circle'
      ? `⌀${round1(pcb.d)} exceeds ⌀${round1(cavity.d)} by ${round1(need - D)} mm`
      : `diagonal ${round1(need)} mm exceeds ⌀${round1(cavity.d)} by ${round1(need - D)} mm`
  }
  const W = cavity.w + slack, H = cavity.h + slack
  if (pcb.kind === 'circle') {
    const narrow = Math.min(W, H)
    return `⌀${round1(pcb.d)} exceeds the cavity's narrow side ${round1(Math.min(cavity.w, cavity.h))} mm by ${round1(pcb.d - narrow)} mm`
  }
  const parts: string[] = []
  if (pcb.w > W) parts.push(`${round1(pcb.w - W)} mm in X`)
  if (pcb.h > H) parts.push(`${round1(pcb.h - H)} mm in Y`)
  return `short by ${parts.join(', ')}`
}

/**
 * Honest fit verdict. `cavity` null ⇒ 'unknown' with `fits: null` — the fit was
 * NOT verified, which is neither a pass nor a failure; the outer-body checks
 * still run and can fail independently (board + 2 walls > outer ⇒
 * 'does_not_fit').
 */
export function evaluateFit(args: {
  pcb: FitShape
  cavity: FitShape | null
  outer: FitShape | null
  wall: number
  slack: number
  cavitySelection?: CavitySelection
}): FitEvaluation {
  const { pcb, cavity, outer, wall, slack } = args
  const problems: string[] = []
  let bad = false
  if (cavity && !shapeContains(cavity, pcb, slack)) {
    bad = true
    problems.push(`PCB ${shapeStr(pcb)} mm does not fit cavity ${shapeStr(cavity)} mm (${shortfall(cavity, pcb, slack)})`)
  }
  const shrink = (s: FitShape, by: number): FitShape =>
    s.kind === 'circle' ? { kind: 'circle', d: s.d - 2 * by } : { kind: 'rect', w: s.w - 2 * by, h: s.h - 2 * by }
  if (outer && !shapeContains(shrink(outer, wall), pcb, slack)) {
    bad = true
    problems.push(`PCB ${shapeStr(pcb)} mm + 2×${wall} mm walls exceed the outer body ${shapeStr(outer)} mm — the board would poke through the shell`)
  }
  if (outer && cavity && !shapeContains(shrink(outer, wall), cavity, slack)) {
    bad = true
    problems.push(`cavity ${shapeStr(cavity)} mm breaches the outer body ${shapeStr(outer)} mm wall (pocket punches through the shell)`)
  }
  if (bad) return { verdict: 'does_not_fit', fits: false, problems }
  if (!cavity) {
    const sel = args.cavitySelection
    const n = sel?.candidates.length ?? 0
    const why = sel
      ? sel.candidates.slice(0, 6).map((c) => `${c.op}: ${c.rejected ?? 'n/a'}`).join('; ')
      : ''
    problems.push(
      `no board cavity identified in the plan (${n} pocket${n === 1 ? '' : 's'} examined${why ? ' — ' + why : ''}) — PCB fit NOT verified`,
    )
    // NOT true: nothing verified this fit. See the FitEvaluation doc above.
    return { verdict: 'unknown', fits: null, problems }
  }
  return { verdict: 'fits', fits: true, problems }
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
