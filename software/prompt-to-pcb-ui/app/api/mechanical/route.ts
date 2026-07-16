/**
 * Mechanical module — product-engine-directed CAD. The product engine turns the
 * product spec + the REAL built board's footprint into a generic mechanical
 * build plan (lib/mechanical-plan), and the Onshape executor
 * (tools/onshape/render_plan.py) renders it into real geometry and exports STEP
 * + a shaded preview. No baked-in enclosure recipe — the plan (data) decides the
 * form; the same executor would build a bracket or a potting box.
 *
 * Honest: 'built' only when a real STEP is produced; it's advisory CAD (a first-
 * pass parametric part, not tolerance/fit-validated). Per-op failures are
 * reported, never hidden.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { callLLMText, type LLMOverride } from '@/lib/llm'
import { overrideForRequest } from '@/lib/byok'
import { MODEL } from '@/lib/model-tiers'
import { MECH_PLAN_SCHEMA, normalizeMechPlan, type MechPlan } from '@/lib/mechanical-plan'
import { normalizeIdBrief, idBriefSummary, type IdBrief } from '@/lib/id-brief'
import { FIDELITY_ENABLED, FIDELITY_ROUNDS, FIDELITY_THRESHOLD, critiqueBlock, judgeSystem, judgeUser, normalizeVerdict, type FidelityReport } from '@/lib/mech-fidelity'
import { pinsPromptFor } from '@/lib/design-state'
import type { ProductSpec } from '@/lib/product-spec'

export const dynamic = 'force-dynamic'
// Budget arithmetic — the outer wall must COMPOSE with the inner walls, worst case:
//   plan LLM:        2 attempts × 120s fetch wall (lib/llm LLM_TIMEOUT_MS) = 240s
//   Onshape executor: 280s spawn wall (renderPlan below)                   = 280s
//   ------------------------------------------------------------------- = 520s
// + file I/O and response margin ⇒ 600. The old 300 was smaller than ONE
// worst-case pass, so the platform could kill the route mid-render. (The dev-only
// Claude CLI path has its own 300s wall per attempt, but maxDuration is a
// serverless limit that does not apply to a local dev server.)
export const maxDuration = 600

const RUN_ID = /^run-[A-Za-z0-9._-]{1,128}$/

/** Engineer change request scoped to this stage (Phase 3 targeted edits). */
async function changeRequestBlock(runId: string, stage: string): Promise<string> {
  try {
    const cr = JSON.parse(await fs.readFile(
      path.join(process.cwd(), 'public', 'runs', runId, 'data', 'change-request.json'), 'utf8'))
    if (Array.isArray(cr.areas) && cr.areas.includes(stage) && cr.message) {
      return `\n\nENGINEER CHANGE REQUEST (this revision — apply it): ${String(cr.message).slice(0, 400)}`
    }
  } catch { /* no change request — normal build */ }
  return ''
}

const SYSTEM = `detailed thinking off.
You are the mechanical specialist for an autonomous product-engineering platform.
Given a PRODUCT and the REAL built PCB footprint, emit a parametric build plan
that wraps/serves the product mechanically (an enclosure, in-ear shell, bracket,
potting box — whatever the product needs). GENERAL across categories; never
assume a domain.

The plan is an ordered list of ops in mm, XY = base plane, +Z up.

WHEN AN INDUSTRIAL DESIGN BRIEF IS PROVIDED (below): the outer body MUST realize
the ID's formFactor and OUTER envelope — this is a hard form constraint, NOT a
plain box. Size the base body/sketch to the ID outer envelope (x,y in the base
plane, z the extrude height), and realize the ID's keyFeatures and controls as
REAL geometry using the op vocabulary: 'cutout' ops for side vents and any
display / e-ink / lens window, standoffs or a boss for mounting features, and a
front-plane / angled fascia sketch when the form calls for one. In THIS case the
board footprint is the INTERNAL fit requirement only — the inner cavity floor
the board must sit within — it does NOT set the outer form. Leave a cavity floor
= wall thickness and ensure the cavity clears the board plus clearance.

WHEN NO ID BRIEF IS PROVIDED (fallback): build a base body sized to the board +
walls, hollow an inner cavity for the board (leave a floor = wall thickness), add
mounting standoffs, and any needed port cutouts.

GEOMETRY RULES (always, non-negotiable):
- Profile kind "circle" ({ "kind": "circle", "cx", "cy", "d" }) is valid for ANY
  sketch. For a round/puck/cylindrical form use a circular sketch + extrude for
  the outer body and a circular sketch + pocket for the cavity. NEVER pocket a
  rectangular cavity into a round shell — its corners cut the wall open.
- Containment: board + clearance ≤ cavity, and cavity + 2×wall ≤ outer body.
  The board must sit fully INSIDE the shell; a plan where the board or cavity
  pokes through the wall is INVALID.
- FASTENING: the board must be mechanically retained, never loose. When board
  mounting holes are given below, emit ONE 'standoff' op per hole at EXACTLY the
  same board-centered (x, y) — a screw boss with a holeDia pilot, or a snap post
  when the ID calls for snap-fit. Place the board centered at the origin so
  board-centered hole coordinates ARE plan coordinates, and set the PCB
  component's cz to the standoff top so it seats on the bosses, not in the floor.

REFINEMENT (non-negotiable for enclosures — the part must read as a finished
product, not an extruded blank with a pocket). When the part is an enclosure
(not a bracket / plate / fixture), design a TWO-SHELL assembly plus the
finishing features below, all with the existing op vocabulary:
- OP ORDER: the FIRST sketch+extrude pair is the BASE shell (the shell that
  holds the board); then its cavity pocket, standoffs and wall cutouts; THEN
  the lid/top shell as its own 'extrude' with "offset" = base height + 4 (the
  lid is modelled floating 4 mm above the base so both shells are visible —
  state the closed overall height in "notes").
- Profile kind "ring" { "kind": "ring", "cx", "cy", "dOuter", "dInner" } is an
  annulus. Use it with 'pocket' for grooves, channels and registration steps —
  never a full-disc pocket where a ring of material must be removed.
- REGISTRATION LIP at the parting line: ring-pocket the outer step off the base
  rim — dOuter = outer dia + 2 (overshoot past the wall so the cut boundary is
  not coincident with the outer face), dInner = outer dia − wall, offset = base
  height − 1.2, depth 1.3 — leaving an inner lip standing proud. Cut the
  matching ring groove into the lid underside (offset = lid start z, depth 1.4,
  0.2 mm clearance per side on the lip).
- LED / LIGHT-DIFFUSER CHANNEL when the ID calls for a light ring: ring pocket
  ~2 wide × 1.5 deep at the ID's light location (lid top face or base rim).
- RF WINDOW / RADOME: when the product carries a radar or RF sensor, thin the
  lid over its field of view — a shallow circle pocket on the lid underside
  (offset = lid start z) leaving ~1.0 mm of lid above it.
- PORT CUTOUTS (USB-C, jacks, buttons): 'cutout' with face "front" and
  "offsetMm" = (inner cavity radius, or half the cavity width) − 1, so the cut
  spans [offsetMm, offsetMm+depth] and pierces ONE wall; depth = wall + 1;
  cx = lateral position (0 = centred); cy = the connector's REAL height above
  the base plane: floor + standoff height + board thickness + half the
  connector height (USB-C ≈ floor + standoff + 1.6 + 1.7; opening ≈ 10 × 4).
  WITHOUT "offsetMm" a side cutout cuts symmetrically about the CENTRE plane —
  it misses both walls or pierces both. ALWAYS set "offsetMm" on side cutouts.
- 'fillet' op { "op": "fillet", "body": <extrude op name>, "radiusMm",
  "scope": "outer-top" | "outer-bottom" | "all-outer" }: round the lid's
  outer-top edge (1–2 mm) and the base's outer-bottom edge (~0.8 mm). Place
  fillet ops AFTER all pockets/cutouts that touch that body.
- NON-SLIP PAD RECESS: a shallow circle pocket into the base underside (no
  offset, depth 0.5, dia = outer − 6) for a rubber pad; make the floor ≥ 2.0
  whenever you add it.
- Vent slots only when the ID or thermal needs call for them.
DEFAULT DIMS (adapt to the ID, keep proportions sane): wall 2.0, floor 2.0,
lip 0.8 wide × 1.2 high, lid ≥ 2.5 thick, radome thinned to 1.0, LED channel
2.0 wide × 1.5 deep, fillet 1.5. Rings/grooves must leave ≥ 0.6 mm of material
on each side of the cut.

Keep it manufacturable and realistic for the given size budget. Reference the
real board dimensions given below so the cavity actually fits the board.

Output ONLY one JSON object, no prose, no markdown fences, EXACTLY this shape:
${MECH_PLAN_SCHEMA}`

async function callLLM(userMsg: string, override?: LLMOverride): Promise<MechPlan> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const antKey = process.env.ANTHROPIC_API_KEY
      // Compose, don't switch: tier default first, caller override spread LAST —
      // a BYOK caller (provider+apiKey, no model) keeps the design tier, while
      // an explicit caller model still wins over it.
      const opts: LLMOverride = {
        ...(antKey ? { apiKey: antKey, provider: 'anthropic' as const } : {}),
        model: MODEL.design,
        ...override,
      }
      const { text } = await callLLMText(
        SYSTEM,
        attempt === 0 ? userMsg : userMsg + '\n\nYOUR PREVIOUS REPLY WAS NOT VALID JSON. Reply with ONLY the JSON object.',
        opts,
      )
      return normalizeMechPlan(JSON.parse(firstJsonObject(text)))
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('mechanical model failed')
}

function firstJsonObject(text: string): string {
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  let idx = t.indexOf('{')
  let n = 0
  while (idx >= 0 && n < 60) {
    let depth = 0, inStr = false, esc = false
    for (let i = idx; i < t.length; i++) {
      const ch = t[i]
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false }
      else if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) {
        const cand = t.slice(idx, i + 1)
        try { const o = JSON.parse(cand); if (o && typeof o === 'object' && ('operations' in o || 'part' in o)) return cand } catch { /* next */ }
        break
      } }
    }
    idx = t.indexOf('{', idx + 1); n++
  }
  throw new Error('no valid mechanical-plan JSON in model reply')
}

/** Run the Onshape executor, feeding the plan on stdin. */
function renderPlan(plan: MechPlan, outDir: string, name: string): Promise<any> {
  const script = path.join(process.cwd(), '..', '..', 'tools', 'onshape', 'render_plan.py')
  return new Promise((resolve, reject) => {
    const TIMEOUT_MS = 280_000
    const t0 = Date.now()
    const py = spawn(process.env.FL_PYTHON || 'python3', [script, outDir, name], { timeout: TIMEOUT_MS })
    let out = '', err = ''
    py.stdout.on('data', (d) => (out += d))
    py.stderr.on('data', (d) => (err += d))
    py.on('error', reject)
    py.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop() || '{}')) }
      catch {
        // Distinguish the spawn-timeout kill (SIGTERM at the wall → truncated/no
        // JSON) from genuinely bad executor output, so the error names the cause.
        const elapsed = Date.now() - t0
        if (py.killed && elapsed >= TIMEOUT_MS - 1_000)
          return reject(new Error(`executor timed out after ${Math.round(elapsed / 1000)}s (wall ${Math.round(TIMEOUT_MS / 1000)}s)`))
        reject(new Error('executor produced no JSON: ' + (err || out).slice(0, 300)))
      }
    })
    py.stdin.write(JSON.stringify(plan))
    py.stdin.end()
  })
}

/** Run the vision judge; resolves to a report entry or an unavailable marker
 *  ({ ok: false }) — never rejects, so the honest-degradation path can record
 *  "unverified" and let the stage ship. */
function runJudge(images: string[], system: string, user: string): Promise<{ ok: boolean; provider?: string; verdict?: unknown; errors?: string[] }> {
  const script = path.join(process.cwd(), 'scripts', 'vision_judge.py')
  return new Promise((resolve) => {
    const py = spawn(process.env.FL_PYTHON || 'python3', [script], { timeout: 320_000 })
    let out = ''
    py.stdout.on('data', (d) => (out += d))
    py.on('error', () => resolve({ ok: false, errors: ['spawn failed'] }))
    py.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop() || '{}')) }
      catch { resolve({ ok: false, errors: ['judge produced no JSON'] }) }
    })
    py.stdin.write(JSON.stringify({ system, user, images }))
    py.stdin.end()
  })
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const spec = body.spec as ProductSpec | undefined
    const runId = typeof body.runId === 'string' ? body.runId : undefined
    if (!spec?.product) return Response.json({ error: 'missing product spec' }, { status: 400 })
    if (!runId || !RUN_ID.test(runId)) return Response.json({ error: 'missing/invalid runId' }, { status: 400 })

    // ground the plan in the REAL built board footprint — prefer the chip-scale
    // board (electronics-cs) if it exists, else the flroute board.json
    type MountingHole = { x: number; y: number; diaMm: number }
    let board: {
      wMm?: number; hMm?: number; layers?: number
      shape?: 'circle' | 'rect'; diaMm?: number; mountingHoles?: MountingHole[]
      usbRef?: string
    } = {}
    try {
      const cs = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'electronics', 'chipscale-board.json'), 'utf8'))
      if (cs?.boardMm?.w && cs?.boardMm?.h) board = { wMm: cs.boardMm.w, hMm: cs.boardMm.h }
      // Real board GEOMETRY (newer runs): outline shape + mounting holes in
      // board-centered mm. Older runs lack these fields — tolerate absence.
      const bs = cs?.boardShape
      if (bs?.type === 'circle' && typeof bs.diameterMm === 'number' && isFinite(bs.diameterMm) && bs.diameterMm > 0) {
        board.shape = 'circle'
        board.diaMm = bs.diameterMm
        if (!board.wMm) { board.wMm = bs.diameterMm; board.hMm = bs.diameterMm }
      } else if (bs?.type === 'rect') {
        board.shape = 'rect'
      }
      const holes = (Array.isArray(cs?.mountingHoles) ? cs.mountingHoles : [])
        .filter((h: any) => typeof h?.x === 'number' && isFinite(h.x) && typeof h?.y === 'number' && isFinite(h.y))
        .map((h: any): MountingHole => ({ x: h.x, y: h.y, diaMm: typeof h.diaMm === 'number' && isFinite(h.diaMm) && h.diaMm > 0 ? h.diaMm : 2 }))
      if (holes.length) board.mountingHoles = holes
      // real connector presence (no x/y in the parts list — position is
      // edge-centred by convention, but the HEIGHT and the existence of the
      // port cutout are grounded in the actual BOM)
      const usb = (Array.isArray(cs?.parts) ? cs.parts : [])
        .find((p: any) => /usb/i.test(`${p?.name ?? ''} ${p?.footprint ?? ''} ${p?.kind ?? ''}`))
      if (usb?.name) board.usbRef = String(usb.name)
    } catch { /* no chip-scale board */ }
    if (!board.wMm) {
      try {
        const bj = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'data', 'board.json'), 'utf8'))
        board = { ...board, wMm: bj?.boardSize?.wMm, hMm: bj?.boardSize?.hMm, layers: bj?.layers }
      } catch { /* no board yet — plan from budgets only */ }
    }

    // load the persisted ID brief so the enclosure FOLLOWS the industrial-design
    // form (outer envelope + keyFeatures/controls), not just a box from the board
    let idBrief: IdBrief | null = null
    try {
      const raw = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'disciplines', 'id-brief.json'), 'utf8'))
      idBrief = normalizeIdBrief(raw)
    } catch { /* no ID brief — fall back to box-from-board */ }

    const b = spec.budgets ?? {}
    let idBlock = ''
    if (idBrief) {
      const env = idBrief.envelopeMm
      const envLine =
        env.x || env.y || env.z
          ? `OUTER envelope (drives the outer body size): ${[env.x, env.y, env.z].map((v) => (v != null ? `${v}` : '?')).join(' × ')} mm (x × y × z).\n`
          : ''
      idBlock =
        `\nINDUSTRIAL DESIGN BRIEF (HARD form constraint — the enclosure MUST realize THIS form, not a plain box):\n` +
        idBriefSummary(idBrief) + '\n' +
        envLine +
        `Realize the ID formFactor, keyFeatures, and controls as real geometry (cutouts for vents/windows, standoffs/boss for mounting, angled fascia sketch if the form calls for one). The board footprint below is the INTERNAL fit/cavity requirement, NOT the outer form.\n`
    }
    // Fastening style follows the ID brief (CMF / keyFeatures / constraints):
    // snap-fit only when the ID actually says so; default is screws.
    const idText = idBrief
      ? [idBrief.formFactor, idBrief.ergonomics, idBrief.cmf.material, idBrief.cmf.finish, idBrief.aesthetic,
         ...(idBrief.keyFeatures ?? []), ...(idBrief.constraints ?? []), idBrief.rationale ?? '']
          .filter(Boolean).join(' ').toLowerCase()
      : ''
    const snapFit = /snap[\s-]?fit|snap[\s-]?together|snaps? (in|into|onto|closed|shut)/.test(idText)

    // HARD board-geometry constraints from the real built board (shape + holes).
    // Injected only when the newer chipscale-board.json fields exist.
    const wall = 1.5
    const clearance = 1.0
    let boardGeomBlock = ''
    if (board.shape || board.mountingHoles?.length) {
      const lines: string[] = []
      if (board.shape === 'circle' && board.diaMm) {
        const d = board.diaMm
        lines.push(
          `- The REAL board is CIRCULAR, diameter ${d} mm. The inner cavity MUST be a CIRCULAR pocket: a 'sketch' op with profile {"kind":"circle","cx":0,"cy":0,"d":${(d + clearance).toFixed(1)}} (board + ${clearance} mm clearance) and a 'pocket' op. NOT a rectangle — a rectangular pocket would cut through the round wall.`,
          `- The OUTER body must fully contain the board: outer diameter ≥ ${(d + clearance + 2 * wall).toFixed(1)} mm (board ${d} + ${clearance} clearance + 2×${wall} mm wall). NON-NEGOTIABLE check before you answer: board + clearance ≤ cavity AND cavity + 2×wall ≤ outer.`,
          `- Represent the PCB as a 'component' op with kind "pcb", shape "cyl", w = ${d} (its TRUE diameter, never shrunk), cz = standoff top height.`,
        )
      } else if (board.wMm && board.hMm) {
        lines.push(
          `- The REAL board is RECTANGULAR, ${board.wMm} × ${board.hMm} mm (diagonal ${Math.hypot(board.wMm, board.hMm).toFixed(1)} mm). NON-NEGOTIABLE: cavity ≥ board + ${clearance} mm clearance, outer ≥ cavity + 2×${wall} mm wall. If the outer form is round, the CAVITY must still contain the board's full DIAGONAL — otherwise the board cannot physically fit.`,
        )
      }
      if (board.mountingHoles?.length) {
        const hl = board.mountingHoles.map((h) => `(${h.x}, ${h.y}) dia ${h.diaMm}`).join(', ')
        if (snapFit) {
          lines.push(
            `- FASTENING (required — the ID brief calls for SNAP-FIT assembly): the board has ${board.mountingHoles.length} mounting hole(s) at board-centered (x, y) mm: ${hl}. For EACH hole emit a 'standoff' op at EXACTLY that (x, y) as a snap post: od 0.2 mm under the hole dia so the board presses over it, NO holeDia, baseZ = floor thickness, height = seating height + board thickness. State in the plan "notes" that snap posts are rendered as plain press posts (cantilever hooks are not renderable).`,
          )
        } else {
          lines.push(
            `- FASTENING (required — screw bosses): the board has ${board.mountingHoles.length} mounting hole(s) at board-centered (x, y) mm: ${hl}. For EACH hole emit a 'standoff' op at EXACTLY that same (x, y): holeDia 1.7 (pilot for an M2 self-tapping screw), od 4 to 5, baseZ = floor thickness, height = floor-to-board seating height. The board screws down onto these bosses.`,
          )
        }
      } else {
        lines.push(`- The board reports no mounting holes: still support it on ≥3 standoffs under its edge (no screw pilots), so it cannot rattle.`)
      }
      if (board.usbRef) {
        lines.push(
          `- The built board carries a USB connector (${board.usbRef}). Emit a REAL port cutout: 'cutout' face "front", "offsetMm" = inner cavity ${board.shape === 'circle' ? 'radius' : 'half-width'} − 1, depth = wall + 1, cx = 0 (edge-centred — the parts list gives no lateral position), cy = floor + standoff height + 1.6 (board) + 1.7 (half a USB-C shell), w ≈ 10, h ≈ 4.`,
        )
      }
      boardGeomBlock =
        `\nBOARD GEOMETRY & FASTENING (HARD constraints from the real built board — these override any conflicting styling):\n` +
        lines.join('\n') + '\n'
    }

    const userMsg =
      `PRODUCT: ${spec.product}\n${spec.description || ''}\n` +
      `philosophy: ${spec.philosophy || '-'}\n` +
      `size budget: ${JSON.stringify(b.sizeMm ?? {})}\n` +
      idBlock +
      boardGeomBlock +
      (board.wMm && board.hMm
        ? `REAL built board footprint: ${board.shape === 'circle' && board.diaMm ? `CIRCULAR, diameter ${Math.round(board.diaMm)} mm` : `${Math.round(board.wMm)} x ${Math.round(board.hMm)} mm`}, ${board.layers ?? '?'}-layer. ${idBrief ? 'This is the INTERNAL cavity requirement — the inner cavity must fit THIS board plus clearance; the OUTER body follows the ID envelope above.' : 'Size the cavity to fit THIS board plus clearance + walls.'}\n`
        : `No built board yet — size from the budget${idBrief ? ' and the ID envelope' : ''}.\n`) +
      `Emit the mechanical build plan.` +
      // Phase 2: engineer-locked mechanical decisions are HARD plan inputs.
      pinsPromptFor(runId, ['mechanical']) +
      // Phase 3: a targeted edit rides in as an explicit engineer instruction.
      (await changeRequestBlock(runId, 'mechanical'))

    const override = overrideForRequest(req)

    const outDir = path.join(process.cwd(), 'public', 'runs', runId, 'mechanical')
    // argv hygiene: spec.product is LLM/user-authored free text passed to the
    // executor as a CLI argument — reduce it to a safe slug: no path separators
    // or control chars, no '..' hops, no leading '-' that could parse as a flag.
    const safeName = (spec.product || '')
      .replace(/[^A-Za-z0-9 ._-]+/g, '_')
      .replace(/\.{2,}/g, '.')
      .replace(/^[-. ]+/, '')
      .trim()
      .slice(0, 64) || 'part'

    // ID-fidelity loop: render the plan, judge the REAL rendered views against
    // the ID brief (+ concept sheet when it exists), and revise the plan from
    // the judge's specific violations. Honest degradation: no judge / no brief
    // → the stage still ships, fidelity recorded "unverified" with the reason.
    const fidelity: FidelityReport = { state: 'unverified', threshold: FIDELITY_THRESHOLD, rounds: [] }
    let plan = await callLLM(userMsg, override)
    let result = await renderPlan(plan, outDir, safeName)

    if (FIDELITY_ENABLED && idBrief) {
      for (let round = 0; round <= FIDELITY_ROUNDS; round++) {
        const viewNames = ['front', 'top', 'right', 'iso'].filter((v) => result?.viewPaths?.[v])
        const images = viewNames.map((v) => result.viewPaths[v] as string)
        // concept sheet last, when the ID render exists (render.json pointer)
        let hasSheet = false
        try {
          const meta = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'id', 'render.json'), 'utf8'))
          const sheet = path.join(process.cwd(), 'public', String(meta.url).split('?')[0])
          await fs.access(sheet)
          images.push(sheet); hasSheet = true
        } catch { /* no concept sheet — brief-text judging */ }
        if (!images.length) { fidelity.reason = 'no CAD views rendered'; break }

        const res = await runJudge(images, judgeSystem(), judgeUser(idBrief, viewNames, hasSheet))
        if (!res.ok) { fidelity.reason = (res.errors ?? []).join(' | ') || 'judge unavailable'; break }
        const verdict = normalizeVerdict(res.verdict)
        fidelity.rounds.push({ round, provider: res.provider ?? '?', verdict })

        if (verdict.adheres || verdict.score >= FIDELITY_THRESHOLD) { fidelity.state = 'verified'; break }
        if (round === FIDELITY_ROUNDS) { fidelity.state = 'failed-threshold'; break }
        // revise: same grounded prompt + the judge's concrete fixes. A failed
        // revise round (LLM timeout, executor fault) must NOT sink the stage —
        // we already hold a real render + this round's verdict; keep them,
        // record the failure, ship (measured live: a claude-CLI 300s timeout
        // here used to 500 the whole route after 15 minutes of good work).
        try {
          plan = await callLLM(userMsg + critiqueBlock(round + 1, verdict), override)
          result = await renderPlan(plan, outDir, safeName)
        } catch (e) {
          fidelity.state = 'failed-threshold'
          fidelity.reason = `revise round ${round + 1} failed: ${String(e).slice(0, 200)}`
          break
        }
      }
    } else if (FIDELITY_ENABLED && !idBrief) {
      fidelity.reason = 'no ID brief for this run'
    } else {
      fidelity.reason = 'disabled (FL_MECH_FIDELITY=0)'
    }

    try {
      const dDir = path.join(process.cwd(), 'public', 'runs', runId, 'disciplines')
      await fs.mkdir(dDir, { recursive: true })
      await fs.writeFile(path.join(dDir, 'mech-fidelity.json'), JSON.stringify(fidelity, null, 1))
    } catch { /* fidelity file is evidence, not a gate on the response */ }

    // Honest fit check: does the real PCB fit the enclosure cavity? (a violation
    // the redesign loop consumes — never silently shrink the board to fake a fit)
    // Shape-aware: the REAL board (circle or rect) is compared against the plan's
    // actual cavity pocket (circle-in-circle, rect-in-circle via the diagonal),
    // and the cavity against the outer body — a rect cavity whose corners breach
    // a round shell (the punched-through render) FAILS here, never ships as fits.
    type Prof = { kind?: string; w?: number; h?: number; d?: number }
    type Shape = { kind: 'circle'; d: number } | { kind: 'rect'; w: number; h: number }
    const sketchProf = (name?: string): Prof | null => {
      if (!name) return null
      const s = plan.operations.find((o) => o.op === 'sketch' && o.name === name) as { profile?: Prof } | undefined
      return s?.profile ?? null
    }
    const asShape = (p: Prof | null): Shape | null => {
      if (!p) return null
      if (p.kind === 'circle') return p.d && p.d > 0 ? { kind: 'circle', d: p.d } : null
      return p.w && p.h ? { kind: 'rect', w: p.w, h: p.h } : null
    }
    const shrink = (s: Shape, by: number): Shape =>
      s.kind === 'circle' ? { kind: 'circle', d: s.d - 2 * by } : { kind: 'rect', w: s.w - 2 * by, h: s.h - 2 * by }
    /** inner fits inside outer (+slack), shape-aware: circle-in-circle by diameter,
     *  rect-in-circle by the DIAGONAL, circle-in-rect by the min side. */
    const contains = (outer: Shape, inner: Shape, slack: number): boolean => {
      if (outer.kind === 'circle') {
        const D = outer.d + slack
        return inner.kind === 'circle' ? inner.d <= D : Math.hypot(inner.w, inner.h) <= D
      }
      const W = outer.w + slack, H = outer.h + slack
      return inner.kind === 'circle' ? inner.d <= Math.min(W, H) : inner.w <= W && inner.h <= H
    }
    const dimsOf = (s: Shape) =>
      s.kind === 'circle' ? { w: Math.round(s.d), h: Math.round(s.d) } : { w: Math.round(s.w), h: Math.round(s.h) }
    const shapeStr = (s: Shape) => (s.kind === 'circle' ? `⌀${Math.round(s.d)}` : `${Math.round(s.w)}×${Math.round(s.h)}`)

    // outer = sketch of the first additive extrude (else first sketch) — by
    // contract the FIRST extrude is the BASE shell, the one that holds the board
    const firstExtrude = plan.operations.find((o) => o.op === 'extrude') as { sketch?: string; depth?: number; offset?: number } | undefined
    const firstSketch = plan.operations.find((o) => o.op === 'sketch') as { profile?: Prof } | undefined
    const outer = asShape(sketchProf(firstExtrude?.sketch) ?? firstSketch?.profile ?? null)
    const areaOf = (s: Shape | null) => (!s ? 0 : s.kind === 'circle' ? (Math.PI * s.d * s.d) / 4 : s.w * s.h)
    // cavity = the BASE shell's board pocket. Two-shell aware: lid pockets
    // (grooves / radome thin-zones start at or above the base top) are styling,
    // not the board cavity; nor is a shallow base pad recess — so restrict to
    // pockets starting below the base top, keep only meaningfully deep ones
    // (≥ half the deepest), then take the largest. Ring pockets (channels)
    // yield no containable shape and drop out naturally in asShape.
    const baseTop = firstExtrude ? (firstExtrude.offset ?? 0) + (firstExtrude.depth ?? 0) : Infinity
    const basePockets = (plan.operations.filter((o) => o.op === 'pocket') as { sketch?: string; depth?: number; offset?: number }[])
      .filter((p) => (p.offset ?? 0) < baseTop - 0.01)
      .map((p) => ({ shape: asShape(sketchProf(p.sketch)), depth: p.depth ?? 0 }))
      .filter((p): p is { shape: Shape; depth: number } => !!p.shape)
    const maxPocketDepth = basePockets.reduce((m, p) => Math.max(m, p.depth), 0)
    const cavity = basePockets
      .filter((p) => p.depth >= maxPocketDepth * 0.5)
      .sort((a, b) => areaOf(b.shape) - areaOf(a.shape))[0]?.shape ?? null
    // the REAL board is ground truth; the plan's pcb component is only a fallback
    const pcbOp = plan.operations.find((o) => o.op === 'component' && (o as { kind?: string }).kind === 'pcb') as { w?: number; h?: number; shape?: string } | undefined
    const pcb: Shape | null =
      board.shape === 'circle' && board.diaMm ? { kind: 'circle', d: board.diaMm }
      : board.wMm && board.hMm ? { kind: 'rect', w: board.wMm, h: board.hMm }
      : pcbOp?.w && pcbOp.h ? (pcbOp.shape === 'cyl' ? { kind: 'circle', d: pcbOp.w } : { kind: 'rect', w: pcbOp.w, h: pcbOp.h })
      : null

    const SLACK = 0.5
    const problems: string[] = []
    let mountingAligned: boolean | 'not-applicable' = 'not-applicable'
    if (board.mountingHoles?.length) {
      const standoffs = plan.operations.filter((o) => o.op === 'standoff') as { x: number; y: number }[]
      mountingAligned = board.mountingHoles.every((h) =>
        standoffs.some((s) => Math.abs(s.x - h.x) <= 0.5 && Math.abs(s.y - h.y) <= 0.5))
      if (!mountingAligned)
        problems.push(`standoffs do not match the board's mounting holes (need one within ±0.5 mm of each of: ${board.mountingHoles.map((h) => `(${h.x}, ${h.y})`).join(', ')})`)
    }
    let fitCheck: {
      fits: boolean
      boardShape: 'circle' | 'rect'
      enclosureMm: { w: number; h: number }
      cavityMm: { w: number; h: number } | null
      pcbMm: { w: number; h: number }
      mountingAligned: boolean | 'not-applicable'
      problems: string[]
    } | null = null
    if (pcb && (cavity || outer)) {
      let fits = true
      if (cavity && !contains(cavity, pcb, SLACK)) {
        fits = false
        problems.push(`board ${shapeStr(pcb)} mm does not fit the cavity pocket ${shapeStr(cavity)} mm${cavity.kind === 'circle' && pcb.kind === 'rect' ? ' (diagonal check)' : ''}`)
      }
      if (outer && !contains(shrink(outer, wall), pcb, SLACK)) {
        fits = false
        problems.push(`board ${shapeStr(pcb)} mm + 2×${wall} mm walls exceed the outer body ${shapeStr(outer)} mm — the board would poke through the shell`)
      }
      if (outer && cavity && !contains(shrink(outer, wall), cavity, SLACK)) {
        fits = false
        problems.push(`cavity ${shapeStr(cavity)} mm breaches the outer body ${shapeStr(outer)} mm wall (pocket punches through the shell)`)
      }
      fitCheck = {
        fits,
        boardShape: pcb.kind,
        enclosureMm: dimsOf(outer ?? cavity!),
        cavityMm: cavity ? dimsOf(cavity) : null,
        pcbMm: dimsOf(pcb),
        mountingAligned,
        problems,
      }
    }

    if (!result?.ok) {
      return Response.json({ ok: false, error: result?.error || 'executor failed', opsFailed: result?.opsFailed ?? [], plan, fidelity })
    }
    const base = `/runs/${runId}/mechanical`
    // HONEST refinement inventory: a feature is listed only when its op(s)
    // actually rendered in Onshape (opsRendered), never from plan intent alone.
    const renderedOps = new Set<string>((result.opsRendered ?? []) as string[])
    const features: string[] = []
    {
      const extrudeOps = plan.operations.filter((o) => o.op === 'extrude') as { name: string; offset?: number }[]
      if (extrudeOps.some((e, i) => i > 0 && renderedOps.has(e.name) && (e.offset ?? 0) >= baseTop - 0.1))
        features.push('two-shell')
      const pocketOps = plan.operations.filter((o) => o.op === 'pocket') as { name: string; sketch?: string; depth?: number; offset?: number }[]
      for (const p of pocketOps) {
        if (!renderedOps.has(p.name)) continue
        const prof = sketchProf(p.sketch)
        const nm = p.name.toLowerCase()
        if (prof?.kind === 'ring')
          features.push(/led|light|diffus/.test(nm) ? 'led-channel' : /lip|regist|groove|step|seat/.test(nm) ? 'registration-lip' : 'ring-channel')
        else if (/radome|radar|rf[-_ ]?window|antenna[-_ ]?window/.test(nm)) features.push('radome-zone')
        else if ((p.depth ?? 0) <= 1 && (p.offset ?? 0) <= 0.01 && /pad|foot|grip|slip|recess/.test(nm)) features.push('base-pad-recess')
      }
      const cutoutOps = plan.operations.filter((o) => o.op === 'cutout') as { name: string; face?: string }[]
      for (const cu of cutoutOps) {
        if (!renderedOps.has(cu.name)) continue
        const nm = cu.name.toLowerCase()
        if (/usb/.test(nm)) features.push('usbc-cutout')
        else if (/vent|louv/.test(nm)) features.push('vents')
        else if (cu.face !== 'top') features.push('side-cutout')
      }
      if ((plan.operations.filter((o) => o.op === 'fillet') as { name: string }[]).some((f) => renderedOps.has(f.name)))
        features.push('edge-fillets')
    }
    const featureList = [...new Set(features)]
    // Honest fastening report: snap-fit intent is followed, but the executor can
    // only render plain posts (no cantilever hooks) — say so, never pretend.
    const fastening = board.mountingHoles?.length
      ? {
          mode: snapFit ? ('snap-fit' as const) : ('screws' as const),
          note: snapFit
            ? 'ID brief calls for snap-fit; rendered as plain press posts at the mounting holes — cantilever snap hooks are beyond the executor, verify engagement manually'
            : 'M2 self-tapping screws into 1.7 mm pilot bosses at the board mounting holes',
        }
      : null
    const payload = {
      ok: true,
      part: result.part,
      previewUrl: result.previewPath ? `${base}/enclosure.png?t=${Date.now()}` : null,
      stepUrl: result.stepPath ? `${base}/enclosure.step` : null,
      gltfUrl: result.gltfPath ? `${base}/enclosure.glb?t=${Date.now()}` : null,
      onshapeUrl: result.onshapeUrl,
      opsRendered: result.opsRendered ?? [],
      opsFailed: result.opsFailed ?? [],
      fitCheck,
      mountingAligned,
      fastening,
      features: featureList,
      fidelity,
      plan,
    }

    // Persist a summary (incl. the real fitCheck) so the stage loads on mount and
    // the feedback controller can consume the actual fit result, not a recomputed
    // one. The STEP/PNG are already written to this dir by renderPlan.
    try {
      await fs.writeFile(path.join(outDir, 'mechanical.json'),
        JSON.stringify({ part: payload.part, previewUrl: payload.previewUrl, stepUrl: payload.stepUrl, gltfUrl: payload.gltfUrl, onshapeUrl: payload.onshapeUrl, opsRendered: payload.opsRendered, opsFailed: payload.opsFailed, fitCheck, mountingAligned, fastening, features: featureList }))
    } catch { /* best effort */ }

    return Response.json(payload)
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
