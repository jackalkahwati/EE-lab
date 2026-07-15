/**
 * Chip-scale electronics module — the product engine lists a MINIMAL, highly-
 * integrated part set + connections; the tscircuit runner places them
 * DETERMINISTICALLY (double-sided shelf-pack — no LLM placement) and autoroutes
 * in-process. This reliably yields an earbud-scale board the big flroute pipeline
 * can't, and its real dimensions flow into the mechanical fit-check / redesign
 * loop so the fit can actually close. Honest: routed only with traces AND zero
 * errors; the real size is never faked.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { callLLMText, overrideFromHeaders, type LLMOverride } from '@/lib/llm'
import { MODEL } from '@/lib/model-tiers'
import type { ProductSpec } from '@/lib/product-spec'
import { normalizeIdBrief } from '@/lib/id-brief'

export const dynamic = 'force-dynamic'
// A realistic multi-sensor chip-scale board (~14 parts) takes ~3.5 min through the
// full ladder (net-aware placement runs several freerouting JVM passes, then the
// redesign loop runs more). The old 200s cap + 150s runner timeout below cut a
// real board off mid-route, so the UI showed a timeout instead of the (honest)
// DRC result. Give the runner room to finish; the runner still enforces its own
// hard wall so it can't hang forever. The design↔routing OUTER loop can run a
// second (re-planned) board when the first hits a density limit, so the cap
// covers two builds — the runner timeouts (285s + 220s) still bound each one.
export const maxDuration = 600

const RUN_ID = /^run-[A-Za-z0-9._-]{1,128}$/

const SYSTEM = `detailed thinking off.
You are the chip-scale electronics engineer. Design a PRODUCTION-REALISTIC board
for WHATEVER product is described — a real functional netlist, not a toy. First
decide what this product actually is and does, then build the board it needs.
Do not assume it is any particular kind of device; derive the parts from the
product's real function.

Output ONLY one JSON object, no prose, no fences:
{"parts":[{"name":"U1","footprint":"qfn32","kind":"chip"},{"name":"IC2","footprint":"qfn6","kind":"chip"},{"name":"C1","footprint":"0402","kind":"capacitor","lcsc":"C1525"}],
 "nets":[["U1.1","C1.1"],["U1.13","IC2.1"]],
 "gnd":["U1.16","IC2.3","C1.2"]}

METHOD — build the real functional set (10-16 parts) for THIS product:
1. U1 = the main IC for the job: the MCU / SoC / ASIC / controller this product
   needs (qfn24/qfn32/qfn48). Pick it from the product's actual function.
2. Peripherals the product genuinely requires — sensors, a wireless radio,
   mic/speaker, motor/LED driver, power converter, memory, connector, etc. Add
   ONLY the ones this product needs; a wired sensor board and a wireless wearable
   have very different part sets. Use qfn6/qfn8/qfn16 for small ICs.
3. Decoupling: ONE 100nF (0402) capacitor per IC power pin/rail, plus one bulk
   1uF/10uF. Each cap sits on its own power net.
4. If (and only if) the product is WIRELESS: an ANT1 chip antenna (footprint
   "0402") fed through a matching L and C from the radio's RF pin.
5. If battery-powered: the charge/power path parts. A status LED (0402) + series
   resistor if it has one.

NETS — every real signal + power connection (12-22 nets) as ["COMP.PIN","COMP.PIN"]:
- Power rails: each IC power pin -> its decoupling cap (shared rails linked).
- Function buses: the real interface between U1 and each peripheral — I2C/SPI/
  UART/I2S/PDM/GPIO as appropriate to that peripheral (clock + data lines).
- RF chain (wireless only): radio RF pin -> matching L -> matching C -> ANT1.
- Control: reset, enables, charge sense, indicator, as the design needs.

RULES:
- footprints: qfn6/qfn8/qfn16/qfn24/qfn32/qfn48 for ICs; 0402 for passives.
- kind is "chip" | "capacitor" | "resistor".
- OPTIONAL "lcsc": a REAL LCSC part number for a component if you know one
  (e.g. "C1525" = 100nF 0402, "C25804" = 10k 0402). OMIT if unsure. Do NOT invent ids.
- nets connect pins as "COMPONENT.PIN"; pin numbers MUST exist (qfnN -> 1..N,
  passive -> 1 and 2). Two-point nets only (["A.p","B.p"]); split a shared rail into
  multiple two-point nets.
- "gnd": list EVERY ground pin as "COMPONENT.PIN" (IC GND/VSS pins, each
  peripheral's ground, the ground side of every decoupling cap, antenna ground if
  present). These are NOT in "nets" — the platform lays a real ground PLANE and
  bonds them to it (that's how a board handles ground, not point-to-point traces).
  Signals + power go in "nets", every ground pin goes in "gnd".
- Be COMPLETE for THIS product: real decoupling, the real function buses, an RF
  chain only if wireless, and a full ground net. The runner places + routes signals
  and pours the ground plane; you list the parts, the signal/power connections, and
  the ground pins.`

/**
 * Two tiers, because these are two different jobs:
 *  - DESIGN_MODEL: the FIRST call, which is the actual design decision (part set +
 *    topology). Raising this tier is what buys board quality — on Opus this call
 *    produced correct USB-C CC1/CC2 sink pulldowns, a 74LVC1T45 level shifter for the
 *    LED ring, and RF keep-out under the radar; Sonnet did not.
 *  - REPLAN_MODEL: the density re-plan rounds, which only coarsen/shed an ALREADY-decided
 *    design so it routes clean. Kept cheap so re-plan rounds can never multiply the design
 *    tier's cost across iterations.
 *
 * HONEST CAVEAT on the latency of the design tier: an all-Opus run appeared to take ~11min
 * vs a ~117s Sonnet baseline, but that comparison does NOT hold up. Two proposed mechanisms
 * (this re-plan loop multiplying, and the 300s CLI timeout) were both investigated and both
 * were FALSE — no re-plan round ever ran, and no claude process belonged to the app. The
 * apparent slowdown was partly a measurement error (watching the wrong run directory). So
 * the design tier's real cost is UNMEASURED, not "too slow". Default stays fast (see
 * lib/model-tiers.ts) until one clean end-to-end run gives a real number.
 */
const DESIGN_MODEL = MODEL.design
const REPLAN_MODEL = MODEL.replan

async function emitPartsNets(userMsg: string, override?: LLMOverride, model: string = DESIGN_MODEL): Promise<{ parts: any[]; nets: any[]; gnd: string[]; note?: string; droppedCapabilities?: string[] }> {
  const antKey = process.env.ANTHROPIC_API_KEY
  // Compose, don't switch: tier default first, caller override spread LAST — so
  // a BYOK caller (provider+apiKey, no model) keeps this stage's model tier,
  // while an explicit caller model still wins over the tier.
  const opts: LLMOverride = {
    ...(antKey ? { apiKey: antKey, provider: 'anthropic' as const } : {}),
    model,
    ...override,
  }
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text } = await callLLMText(SYSTEM, attempt === 0 ? userMsg : userMsg + '\n\nReply with ONLY the JSON object.', opts)
      const o = JSON.parse(firstJson(text))
      if (Array.isArray(o.parts) && o.parts.length) return {
        parts: o.parts, nets: Array.isArray(o.nets) ? o.nets : [], gnd: Array.isArray(o.gnd) ? o.gnd.map(String) : [],
        note: typeof o.note === 'string' ? o.note : undefined,
        droppedCapabilities: Array.isArray(o.droppedCapabilities) ? o.droppedCapabilities.map(String).filter(Boolean) : undefined,
      }
    } catch (e) { lastErr = e }
  }
  throw lastErr ?? new Error('parts model failed')
}

function firstJson(text: string): string {
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const i = t.indexOf('{')
  if (i < 0) throw new Error('no json')
  let depth = 0, inStr = false, esc = false
  for (let k = i; k < t.length; k++) {
    const ch = t[k]
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false }
    else if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return t.slice(i, k + 1) }
  }
  throw new Error('unbalanced json')
}

/** Pull a REAL KiCad footprint for an LCSC part via easyeda2kicad; null on any
 *  failure (invalid id / no network) so the runner falls back to a generic one.
 *  Per-id promise cache: parallel re-plan candidates can ask for the SAME id at
 *  the same time, and two easyeda2kicad runs would race on the same /tmp output
 *  (the same hazard the per-candidate de-dupe already guards against) — so each
 *  id is fetched once per process and everyone shares the result. */
const fpCache = new Map<string, Promise<string | null>>()
function fetchFootprint(lcsc: string): Promise<string | null> {
  const cached = fpCache.get(lcsc)
  if (cached) return cached
  const p = fetchFootprintUncached(lcsc)
  fpCache.set(lcsc, p)
  // a failed fetch is not cached forever — a later build may have network back
  p.then((m) => { if (m === null) fpCache.delete(lcsc) }).catch(() => fpCache.delete(lcsc))
  return p
}
function fetchFootprintUncached(lcsc: string): Promise<string | null> {
  if (!/^C\d{2,10}$/.test(lcsc)) return Promise.resolve(null)
  const base = path.join('/tmp', `fl_fp_${lcsc}`)
  return new Promise((resolve) => {
    const py = spawn('python3', ['-m', 'easyeda2kicad', '--footprint', '--overwrite', `--lcsc_id=${lcsc}`, `--output=${base}`], { timeout: 30_000 })
    py.on('error', () => resolve(null))
    py.on('close', async () => {
      try {
        const dir = `${base}.pretty`
        const files = await fs.readdir(dir)
        const mod = files.find((f) => f.endsWith('.kicad_mod'))
        resolve(mod ? await fs.readFile(path.join(dir, mod), 'utf8') : null)
      } catch { resolve(null) }
    })
  })
}

const PLANNER_DIR = path.join(process.cwd(), '..', '..', 'hardware', 'planner')
const exists = (p: string) => fs.access(p).then(() => true).catch(() => false)

/** MERGER: export the planner's real design (final_design + intent) as a
 *  run_board {parts, nets, gnd} netlist via synth.py's bridge. Returns null on
 *  any failure so the caller falls back to the LLM part-set. */
function plannerNetlist(designPath: string): Promise<{ parts: any[]; nets: any[]; gnd: string[] } | null> {
  return new Promise((resolve) => {
    const py = spawn('python3', [path.join(PLANNER_DIR, 'synth.py'), '--netlist', designPath], { cwd: PLANNER_DIR, timeout: 90_000 })
    let out = ''
    py.stdout.on('data', (d) => (out += d))
    py.on('error', () => resolve(null))
    py.on('close', () => {
      try {
        const nl = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || 'null')
        resolve(nl && Array.isArray(nl.parts) && nl.parts.length && Array.isArray(nl.nets) ? nl : null)
      } catch { resolve(null) }
    })
  })
}

function runBoard(payload: object, svgPath: string, timeoutMs = 285_000, signal?: AbortSignal): Promise<any> {
  const script = path.join(process.cwd(), '..', '..', 'tools', 'tscircuit', 'run_board.mjs')
  return new Promise((resolve, reject) => {
    // process.execPath, not 'node': run_board.mjs is an EXTERNAL tool (two dirs
    // up, outside the Next root) that we shell out to, never import. A literal
    // 'node' first arg makes Turbopack's build-time tracer treat args[0] as a
    // module to resolve and bundle, which fails the build (it partially
    // evaluates process.cwd() away to "/../tools/.../run_board.mjs"). Spawning
    // the running server's own interpreter is also strictly more correct: it
    // can't pick up a different node off PATH (systemd's PATH is minimal).
    // `signal` lets a caller abort mid-route (the pipeline route's early build
    // wires its cancel path here, so a cancelled EDA run can't leave an
    // orphaned router writing into the run dir).
    const t0 = Date.now()
    const py = spawn(process.execPath, [script], { timeout: timeoutMs, signal })
    let out = '', err = ''
    py.stdout.on('data', (d) => (out += d))
    py.stderr.on('data', (d) => (err += d))
    py.on('error', reject)
    py.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop() || '{}')) }
      catch {
        // Distinguish the spawn-timeout kill (SIGTERM at the wall → truncated/no
        // JSON) from a genuinely bad runner output, so the UI shows the real cause.
        const elapsed = Date.now() - t0
        if (py.killed && elapsed >= timeoutMs - 1_000)
          return reject(new Error(`runner timed out after ${Math.round(elapsed / 1000)}s (wall ${Math.round(timeoutMs / 1000)}s)`))
        reject(new Error('runner produced no JSON: ' + (err || out).slice(0, 300)))
      }
    })
    py.stdin.write(JSON.stringify({ ...payload, svgPath }))
    py.stdin.end()
  })
}

// ---- design↔routing OUTER loop ----------------------------------------------
// Re-plan when the first board hits a real density limit. `FL_DENSITY_REPLAN=0`
// disables it; the threshold keeps a couple of DRC nits from paying for a full
// re-plan (only a genuine density limit is worth re-opening the design).
const DENSITY_REPLAN = process.env.FL_DENSITY_REPLAN !== '0'
const REPLAN_MIN_ERRORS = 6

/** A board that ROUTED but is well over the DRC budget — the design is too dense,
 *  not a routing nit. This is the signal to re-open the part set. */
function densityFailed(result: any): boolean {
  return !!result?.boardMm && !result.ok && (result?.drc?.errors ?? 0) >= REPLAN_MIN_ERRORS
}

/** Which board to keep: a clean route always wins; else fewer DRC errors; a tie
 *  keeps the original (`a`) so a re-plan must be strictly better to be adopted. */
function betterResult(a: any, b: any): 'a' | 'b' {
  if (a?.ok && !b?.ok) return 'a'
  if (b?.ok && !a?.ok) return 'b'
  const ea = a?.drc?.errors ?? Infinity, eb = b?.drc?.errors ?? Infinity
  return eb < ea ? 'b' : 'a'
}

function fpHistogram(parts: any[]): Record<string, number> {
  const h: Record<string, number> = {}
  for (const p of parts) { const f = String(p?.footprint || p?.kind || '?'); h[f] = (h[f] || 0) + 1 }
  return h
}

/** What the re-plan actually changed, computed from the two part sets (ground
 *  truth) — not the model's self-report. */
function describeDesignChange(before: any[], after: any[]): string {
  const hb = fpHistogram(before), ha = fpHistogram(after)
  const bits: string[] = []
  if (after.length !== before.length) bits.push(`${before.length}→${after.length} parts`)
  const keys = [...new Set([...Object.keys(hb), ...Object.keys(ha)])].sort()
  const removed = keys.filter((k) => (ha[k] || 0) < (hb[k] || 0)).map((k) => `${(hb[k] || 0) - (ha[k] || 0)}×${k}`)
  const added = keys.filter((k) => (ha[k] || 0) > (hb[k] || 0)).map((k) => `${(ha[k] || 0) - (hb[k] || 0)}×${k}`)
  if (removed.length) bits.push(`−[${removed.join(', ')}]`)
  if (added.length) bits.push(`+[${added.join(', ')}]`)
  return bits.join('; ') || 'no net change in the part set'
}

// Board shape + mounting provisions requested from the runner (derived from the
// run's ID brief — see POST). Passed verbatim into every run_board invocation.
type BoardOpts = {
  boardShape: { type: 'rect' } | { type: 'circle'; marginMm?: number }
  mountingHoles: { count: number; holeDiaMm: number }
}

/** One full board candidate: part-set engine → real footprints → routed board. */
async function buildCandidate(userMsg: string, req: Request, dir: string, svgName: string, timeoutMs: number, boardOpts: BoardOpts, model?: string) {
  const { parts, nets, gnd, note, droppedCapabilities } = await emitPartsNets(userMsg, overrideFromHeaders(req.headers), model)
  // pull REAL LCSC footprints for any part the engine tagged with a valid id;
  // attach as part.kicadMod so the runner uses the true pad geometry + size.
  // Fetch each distinct id ONCE (duplicate ids would race on the same /tmp file).
  const ids = [...new Set(parts.map((p: any) => (p?.lcsc ? String(p.lcsc) : '')).filter(Boolean))]
  const mods = new Map<string, string>()
  await Promise.all(ids.map(async (id) => { const m = await fetchFootprint(id); if (m) mods.set(id, m) }))
  let realFootprints = 0
  for (const p of parts as any[]) {
    const m = p?.lcsc ? mods.get(String(p.lcsc)) : undefined
    if (m) { p.kicadMod = m; realFootprints++ }
  }
  const result = await runBoard({ parts, nets, gnd, ...boardOpts }, path.join(dir, svgName), timeoutMs, req.signal ?? undefined)
  return { parts, nets, gnd, note, droppedCapabilities, realFootprints, result, svgName }
}

// ---- in-flight lock ----------------------------------------------------------
// One chip-scale build per run at a time. The pipeline route (plan mode) kicks
// the build EARLY — concurrent with the variant routing — and the client's
// full-pipeline electronics stage may POST for the same runId while that build
// is still routing (its persisted-board reuse check ran too soon to see it).
// A second caller JOINS the in-flight build's result instead of double-building
// into the same run dir. Entries are removed on settle; after that the persisted
// chipscale-board.json reuse path (run-pipeline existingBoard) takes over.
type CsInflight = { plannerOnly: boolean; promise: Promise<any> }
const csGlobal = globalThis as unknown as { __csInflight?: Map<string, CsInflight> }

export async function POST(req: Request) {
  // Time origin for ALL budget accounting in this route — set at ENTRY so the
  // first candidate build (LLM + up to 285s route) counts against the budget
  // too, not just the re-plan loop. maxDuration=600 covers the whole route.
  const routeStart = Date.now()
  let body: any
  try { body = await req.json() } catch { return Response.json({ error: 'bad json body' }, { status: 400 }) }
  const spec = body.spec as ProductSpec | undefined
  const runId = typeof body.runId === 'string' ? body.runId : undefined
  if (!spec?.product) return Response.json({ error: 'missing product spec' }, { status: 400 })
  if (!runId || !RUN_ID.test(runId)) return Response.json({ error: 'missing/invalid runId' }, { status: 400 })
  const keepCapabilities = body.keepCapabilities === true
  // plannerOnly: the pipeline route's EARLY server-side kick. It only carries a
  // minimal spec (product name + prompt), so if the planner netlist bridge fails
  // it must NOT fall back to the LLM part-set — the client's later call, which
  // has the architect's full product spec, keeps that fallback.
  const plannerOnly = body.plannerOnly === true

  const inflight = (csGlobal.__csInflight ??= new Map<string, CsInflight>())
  // A keep-capabilities rebuild is a deliberate user rebuild — never joined to
  // an in-flight default build (it would return the wrong tradeoff).
  const existing = !keepCapabilities ? inflight.get(runId) : undefined
  if (existing) {
    try {
      const r = await existing.promise
      // Join the in-flight result — unless it was a planner-only attempt that
      // produced no board; then this (full-spec) caller builds fresh below so
      // the LLM fallback still exists.
      if (r && (r.boardMm || !existing.plannerOnly)) return Response.json(r)
    } catch (e) {
      if (!existing.plannerOnly) return Response.json({ ok: false, error: String(e) }, { status: 502 })
      // early planner-only build threw (e.g. aborted) — fall through, build fresh
    }
  }

  const promise = buildChipScale(spec, runId, { keepCapabilities, plannerOnly }, req, routeStart)
  const entry: CsInflight = { plannerOnly, promise }
  inflight.set(runId, entry)
  try {
    return Response.json(await promise)
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 502 })
  } finally {
    if (inflight.get(runId) === entry) inflight.delete(runId)
  }
}

/** The whole build (part set → route → density re-plan → persist), returning the
 *  response payload. Extracted from POST so concurrent callers can share ONE
 *  build via the in-flight lock above. */
async function buildChipScale(
  spec: ProductSpec,
  runId: string,
  flags: { keepCapabilities: boolean; plannerOnly: boolean },
  req: Request,
  routeStart: number,
): Promise<any> {
  const { keepCapabilities, plannerOnly } = flags
  {
    const b = spec.budgets ?? {}
    const elec = spec.disciplines?.electronics
    // Stage D (keepCapabilities): when the user chooses to KEEP a capability the
    // density re-plan would otherwise drop, rebuild with completeness prioritized
    // over compactness and skip the density re-plan (a bigger board is the
    // accepted tradeoff).
    const baseMsg =
      `PRODUCT: ${spec.product}\n${spec.description || ''}\n` +
      `size budget: ${JSON.stringify(b.sizeMm ?? {})}\n` +
      `electronics: ${elec?.summary || elec?.boardIntent || '-'}\n` +
      (keepCapabilities
        ? `IMPORTANT: include EVERY capability this product needs — do NOT drop any peripheral to save space. A LARGER board is acceptable; completeness beats compactness here.\n`
        : '') +
      `List the minimal chip-scale part set + nets.`

    const dir = path.join(process.cwd(), 'public', 'runs', runId, 'electronics')
    await fs.mkdir(dir, { recursive: true })

    // BOARD SHAPE + MOUNTING PROVISIONS — a round/puck/disc/cylindrical form
    // factor gets a CIRCULAR board so it fits the round enclosure; anything else
    // stays rect. EVERY board carries NPTH screw holes (M2 clearance = 2.2mm): 3
    // on a bolt circle for round boards, 4 corner holes for rect — so the
    // mechanical stage has something real to bolt to. The runner places them
    // collision-free and re-runs real DRC with them in the board.
    //
    // Shape sources, in order: the ID brief when it exists, PLUS the product
    // spec's own text. The spec text is load-bearing, not a nicety: the EARLY
    // overlap build (kicked the moment ucs_design.json persists) runs BEFORE the
    // ID brief is generated, so brief-only derivation silently produced rect
    // boards for round products (measured on run-e93c6e0d: "round matte puck"
    // spec → rect board). The spec is always available at overlap time.
    let idText = ''
    try {
      const brief = normalizeIdBrief(JSON.parse(
        await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'disciplines', 'id-brief.json'), 'utf8')))
      idText = [brief.formFactor, ...(brief.keyFeatures ?? []), ...(brief.constraints ?? [])].filter(Boolean).join(' ')
    } catch { /* no ID brief yet (early-overlap build) — spec text below still applies */ }
    const specText = [spec?.product, spec?.description, spec?.philosophy].filter(Boolean).join(' ')
    const roundForm = /\b(round|circular|puck|disc|disk|coin|cylind\w*)\b/i.test(`${idText} ${specText}`)
    const boardOpts: BoardOpts = {
      boardShape: roundForm ? { type: 'circle' } : { type: 'rect' },
      mountingHoles: { count: roundForm ? 3 : 4, holeDiaMm: 2.2 },
    }

    // MERGER (Stage E): if the planner produced a real UCS design for this run,
    // build the chip-scale board from THAT — its real parts, MCU pin allocation
    // and bus connectivity, exported to a netlist by synth's bridge — so the board
    // the user sees comes from the SAME design as the plan, not a separate LLM
    // part-set guess. Falls back to emitPartsNets when there's no planner design
    // (or the bridge yields nothing). Skipped for a keep-capabilities rebuild.
    let cand: Awaited<ReturnType<typeof buildCandidate>> | undefined
    let boardSource: 'planner-merged' | 'llm' = 'llm'
    const plannerDesignPath = path.join(process.cwd(), 'public', 'runs', runId, 'data', 'ucs_design.json')
    if (!keepCapabilities && await exists(plannerDesignPath)) {
      const nl = await plannerNetlist(plannerDesignPath)
      if (nl?.parts?.length) {
        const result = await runBoard({ parts: nl.parts, nets: nl.nets, gnd: nl.gnd, ...boardOpts }, path.join(dir, 'chipscale.svg'), 285_000, req.signal ?? undefined)
        cand = { parts: nl.parts, nets: nl.nets, gnd: nl.gnd, note: undefined, droppedCapabilities: undefined, realFootprints: 0, result, svgName: 'chipscale.svg' }
        boardSource = 'planner-merged'
      }
    }
    // plannerOnly (the pipeline route's early kick): if the bridge yielded no
    // board, STOP here rather than falling back to the LLM part-set — this call's
    // minimal spec lacks the architect's product context, so the fallback belongs
    // to the client's later full-spec call (which the in-flight lock lets through).
    if (!cand && plannerOnly) {
      return { ok: false, error: 'planner netlist unavailable — early planner-only build skipped the LLM fallback', boardSource: 'llm' }
    }
    // FIRST PASS (fallback) — LLM part set, routed.
    if (!cand) cand = await buildCandidate(baseMsg, req, dir, 'chipscale.svg', 285_000, boardOpts)
    let designConvergence: any = null

    // OUTER LOOP (design↔routing): the routing layer already loosens placement to
    // relieve density (run_board's gap ladder). When even that can't route clean
    // — the board is over its DRC budget — the density is a DESIGN problem, not a
    // layout one. Feed the failure back to the part-set engine and ask for a
    // simpler/coarser design (coarser packages, integrated functions, fewer
    // non-essential parts), then re-route. Keep whichever board is genuinely
    // better and report exactly what the re-plan changed (computed from the part
    // sets, not the model's say-so). One bounded iteration so it can't run away.
    if (DENSITY_REPLAN && !keepCapabilities && boardSource === 'llm' && densityFailed(cand.result)) {
      const first = cand.result
      // Budget arithmetic: measured from ROUTE ENTRY (routeStart above), so the
      // first pass's real cost (LLM emit + up to 285s route) is already counted.
      // 520s total leaves ≥80s of maxDuration=600 for SVG promotion, persistence
      // and the response. The old origin (set HERE, after the first build) let
      // first-pass time + 520s of re-planning stack past the 600s wall.
      const OUTER_BUDGET_MS = 520_000
      const MAX_REPLANS = 3 // also the concurrency cap — one candidate per rung
      const iterations: any[] = []
      let best = cand // the best candidate across all rungs (starts as the first pass)

      // PARALLEL re-plan ladder. The old loop chained up to 3 sequential ~3-min
      // rounds, each informed by the PREVIOUS round's failure. Density failures
      // share one root cause (too many fine-pitch parts for the area), so the
      // escalation ladder is now written UP-FRONT from the FIRST failure and all
      // candidates build CONCURRENTLY — wall cost ≈ one round instead of three.
      // HONEST TRADEOFF: rungs 2-3 are pre-escalated ("assume a lighter cut won't
      // be enough") rather than adaptively fed the prior rung's outcome; we trade
      // that feedback for time. Selection is unchanged (betterResult, clean route
      // wins, ties keep the incumbent) and every candidate's outcome is reported
      // in `iterations` ordered by rung, exactly as before.
      const hist = Object.entries(fpHistogram(cand.parts)).map(([k, v]) => `${v}×${k}`).join(', ')
      const failLine =
        `\n\nRE-PLAN — this part set did NOT route clean at chip-scale:\n` +
        `${cand.parts.length} parts (${hist}) → ${first.boardMm?.w}×${first.boardMm?.h}mm with ${first.drc?.errors} DRC error(s), ` +
        `mostly hole_clearance (fine-pitch packages packed too tight to route at this size).\n`
      const escalations = [
        `Re-design it SIMPLER so it can route clean:`,
        `Assume a LIGHT simplification will NOT be enough for this failure. Cut HARDER — ` +
          `integrate functions into fewer ICs and drop secondary peripherals:`,
        `Assume moderate cuts will NOT be enough for this failure. Strip to the product's ` +
          `ESSENTIAL core function only — the minimum part set that is still a REAL functional board:`,
      ]
      const commonAsk =
        `\n- prefer a COARSER package where the function allows (a wider-pitch/larger IC over a fine-pitch qfn);\n` +
        `- INTEGRATE functions into fewer ICs where a real combined part exists;\n` +
        `- DROP a non-essential peripheral (keep the product's core function; shed nice-to-haves);\n` +
        `- fewer discrete parts overall.\n` +
        `Keep it a REAL functional board for THIS product. Add a "note" field naming what you simplified and why, ` +
        `and a "droppedCapabilities" field: a list of any product CAPABILITIES you removed to fit ` +
        `(e.g. "data logging (SPI flash)", "battery charging"), or [] if you only coarsened/consolidated packages.`

      // Time budget still applies, measured from route entry: the batch's wall
      // cost is ≈ one candidate (LLM emit + 220s route wall), so one up-front
      // check replaces the per-round check.
      let round = 0
      const elapsed = Date.now() - routeStart
      if (elapsed + 190_000 > OUTER_BUDGET_MS) {
        iterations.push({ round: 1, skipped: 'time budget', elapsedMs: elapsed })
      } else {
        round = MAX_REPLANS
        // re-plans are mechanical simplification of an already-decided design → cheaper model
        const settled = await Promise.all(escalations.map(async (escalate, i) => {
          const rung = i + 1
          const tA = Date.now()
          try {
            const c = await buildCandidate(
              baseMsg + failLine + escalate + commonAsk,
              req, dir, `chipscale-replan${rung}.svg`, 220_000, boardOpts, REPLAN_MODEL)
            return { rung, cand: c, ms: Date.now() - tA, error: null as string | null }
          } catch (e) {
            return { rung, cand: null as Awaited<ReturnType<typeof buildCandidate>> | null, ms: Date.now() - tA, error: String(e) }
          }
        }))
        // Fold in rung order so `kept` keeps its old meaning (adopted over the
        // best seen so far). All candidates derive from the FIRST design, so
        // per-candidate `change` is computed against the first-pass part set.
        for (const s of settled) {
          if (!s.cand) { iterations.push({ round: s.rung, replanError: s.error, ms: s.ms }); continue }
          const improved = betterResult(best.result, s.cand.result) === 'b'
          iterations.push({
            round: s.rung, change: describeDesignChange(cand.parts, s.cand.parts), note: s.cand.note ?? null,
            droppedCapabilities: s.cand.droppedCapabilities ?? [],
            parts: s.cand.parts.length, drc: s.cand.result?.drc?.errors ?? null, ok: !!s.cand.result?.ok,
            kept: improved, ms: s.ms,
          })
          if (improved) best = s.cand
        }
      }
      // Capabilities shed by the ADOPTED candidate (Stage D). Candidates are
      // independent simplifications of the first design, so the winner's own
      // droppedCapabilities IS the shed set — no cross-candidate union.
      const droppedCaps = best !== cand ? [...new Set(best.droppedCapabilities ?? [])] : []

      // promote the winning board's SVGs to the canonical names the UI reads.
      // A failed promotion is NOT silent: the stats below describe the re-planned
      // board, so if chipscale.svg still shows the first-pass board the response
      // must say so (svgStale) instead of letting image and numbers desync.
      let svgStale = false
      const svgStaleNotes: string[] = []
      if (best !== cand) {
        for (const [from, to] of [[best.svgName, 'chipscale.svg'], [best.svgName.replace(/\.svg$/, '-schematic.svg'), 'chipscale-schematic.svg']]) {
          try { await fs.copyFile(path.join(dir, from), path.join(dir, to)) }
          catch (e) {
            svgStale = true
            svgStaleNotes.push(`${to} still shows the FIRST-PASS board (copy of ${from} failed: ${String(e).slice(0, 120)})`)
          }
        }
      }

      designConvergence = {
        svgStale,
        ...(svgStale ? { svgStaleNote: svgStaleNotes.join('; ') } : {}),
        triggered: true,
        reason: `first pass routed ${first.boardMm?.w}×${first.boardMm?.h}mm but held ${first.drc?.errors} DRC error(s) — over the density budget`,
        replans: round,
        converged: !!best.result?.ok,
        iterations,
        // Stage D: capabilities the kept re-plan path shed to fit — the user can
        // rebuild keeping them (a larger board). Only counts if the re-plan was
        // actually adopted; a rejected re-plan drops nothing.
        droppedCapabilities: best !== cand ? droppedCaps : [],
        change: best !== cand ? describeDesignChange(cand.parts, best.parts) : 'no re-plan improved on the first board',
        note: best !== cand ? best.note ?? null : null,
        before: { parts: cand.parts.length, drc: first.drc?.errors ?? null, ok: !!first.ok },
        after: { parts: best.parts.length, drc: best.result?.drc?.errors ?? null, ok: !!best.result?.ok },
        kept: best !== cand ? 'replanned' : 'original',
      }
      cand = best
    }

    const { parts, result, realFootprints } = cand
    if (result?.error) return { ok: false, error: result.error }

    // fold the outer-loop outcome into drcRepair so the existing UI (which renders
    // drcRepair.fixes) shows the re-plan honestly, and keep the structured object.
    if (designConvergence && result.drcRepair) {
      result.drcRepair.designConvergence = designConvergence
      const dc = designConvergence
      const tail = dc.kept === 'replanned'
        ? `re-planned the design (${dc.replans} parallel candidate(s); ${dc.change}) → ${dc.after?.drc} vs ${dc.before.drc} DRC error(s)${dc.converged ? ', routes clean' : ''}`
        : `kept the original — ${dc.replans} parallel re-plan candidate(s) were no better`
      result.drcRepair.fixes = [
        ...(result.drcRepair.fixes ?? []),
        `design↔routing outer loop: ${dc.reason} → ${tail}`,
      ]
    }

    if (result.boardMm && !req.signal?.aborted) {
      // (Persist is skipped on an aborted request — a cancelled run must not get
      // a board written under it after the caller walked away.)
      // Persist the part set too, so downstream disciplines (supply chain BOM,
      // manufacturing, validation) can ground on the REAL chip-scale parts (the
      // BLE SoC + mics + PMIC), not the flroute reference board's placeholder BOM.
      const partList = parts.map((p: any) => ({ name: p.name, footprint: p.footprint, kind: p.kind, lcsc: p.lcsc ?? null }))
      // CONTRACT with the MECHANICAL stage (read from chipscale-board.json):
      //   boardShape: {type:'rect'} | {type:'circle', diameterMm, boltCircleDiaMm?}
      //     — the REAL as-built outline the runner exported to Edge.Cuts (for a
      //     circle, boardMm.w = boardMm.h = the real diameter, grown if needed
      //     to clear all courtyards; never the requested nominal).
      //   mountingHoles: [{x, y, diaMm}] — non-plated screw holes actually
      //     drilled in the .kicad_pcb, in BOARD-CENTERED mm (+x right, +y up).
      //     The enclosure should put its bosses/standoffs exactly there.
      await fs.writeFile(path.join(dir, 'chipscale-board.json'),
        JSON.stringify({ boardMm: result.boardMm, areaMm2: result.areaMm2, components: result.components, routedTraces: result.routedTraces, realFootprints, parts: partList, boardShape: result.boardShape ?? null, mountingHoles: result.mountingHoles ?? [], drc: result.drc ?? null, drcRepair: result.drcRepair ?? null, designConvergence, boardSource }))
      // the routed .kicad_pcb for the 3D render (the real chip-down board)
      if (result.kicadPcb) await fs.writeFile(path.join(dir, 'chipscale.kicad_pcb'), result.kicadPcb)
    }

    return {
      ok: !!result.ok,
      boardMm: result.boardMm,
      areaMm2: result.areaMm2,
      boardShape: result.boardShape ?? null,
      mountingHoles: result.mountingHoles ?? [],
      components: result.components,
      routedTraces: result.routedTraces,
      errors: result.errors ?? {},
      drc: result.drc ?? null,
      drcRepair: result.drcRepair ?? null,
      designConvergence,
      boardSource,
      realFootprints,
      svgUrl: result.svg ? `/runs/${runId}/electronics/chipscale.svg?t=${Date.now()}` : null,
      // true when a re-planned board won but its SVG could not be promoted to
      // chipscale.svg — the image then shows the first-pass board while the
      // stats describe the re-plan (see designConvergence.svgStaleNote).
      svgStale: !!designConvergence?.svgStale,
      code: result.code,
    }
  }
}
