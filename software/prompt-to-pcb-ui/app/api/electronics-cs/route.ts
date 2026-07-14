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
 *  failure (invalid id / no network) so the runner falls back to a generic one. */
function fetchFootprint(lcsc: string): Promise<string | null> {
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

function runBoard(payload: object, svgPath: string, timeoutMs = 285_000): Promise<any> {
  const script = path.join(process.cwd(), '..', '..', 'tools', 'tscircuit', 'run_board.mjs')
  return new Promise((resolve, reject) => {
    // process.execPath, not 'node': run_board.mjs is an EXTERNAL tool (two dirs
    // up, outside the Next root) that we shell out to, never import. A literal
    // 'node' first arg makes Turbopack's build-time tracer treat args[0] as a
    // module to resolve and bundle, which fails the build (it partially
    // evaluates process.cwd() away to "/../tools/.../run_board.mjs"). Spawning
    // the running server's own interpreter is also strictly more correct: it
    // can't pick up a different node off PATH (systemd's PATH is minimal).
    const t0 = Date.now()
    const py = spawn(process.execPath, [script], { timeout: timeoutMs })
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
  const result = await runBoard({ parts, nets, gnd, ...boardOpts }, path.join(dir, svgName), timeoutMs)
  return { parts, nets, gnd, note, droppedCapabilities, realFootprints, result, svgName }
}

export async function POST(req: Request) {
  // Time origin for ALL budget accounting in this route — set at ENTRY so the
  // first candidate build (LLM + up to 285s route) counts against the budget
  // too, not just the re-plan loop. maxDuration=600 covers the whole route.
  const routeStart = Date.now()
  try {
    const body = await req.json()
    const spec = body.spec as ProductSpec | undefined
    const runId = typeof body.runId === 'string' ? body.runId : undefined
    if (!spec?.product) return Response.json({ error: 'missing product spec' }, { status: 400 })
    if (!runId || !RUN_ID.test(runId)) return Response.json({ error: 'missing/invalid runId' }, { status: 400 })

    const b = spec.budgets ?? {}
    const elec = spec.disciplines?.electronics
    // Stage D: when the user chooses to KEEP a capability the density re-plan would
    // otherwise drop, rebuild with completeness prioritized over compactness and
    // skip the density re-plan (a bigger board is the accepted tradeoff).
    const keepCapabilities = body.keepCapabilities === true
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

    // BOARD SHAPE + MOUNTING PROVISIONS — derived from the run's ID brief (same
    // loader as the mechanical route). A round/puck/disc/cylindrical form factor
    // gets a CIRCULAR board so it fits the round enclosure; anything else stays
    // rect. EVERY board carries NPTH screw holes (M2 clearance = 2.2mm): 3 on a
    // bolt circle for round boards, 4 corner holes for rect — so the mechanical
    // stage has something real to bolt to. The runner places them collision-free
    // and re-runs real DRC with them in the board.
    let idText = ''
    try {
      const brief = normalizeIdBrief(JSON.parse(
        await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'disciplines', 'id-brief.json'), 'utf8')))
      idText = [brief.formFactor, ...(brief.keyFeatures ?? []), ...(brief.constraints ?? [])].filter(Boolean).join(' ')
    } catch { /* no ID brief — default rect */ }
    const roundForm = /\b(round|circular|puck|disc|disk|coin|cylind\w*)\b/i.test(idText)
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
        const result = await runBoard({ parts: nl.parts, nets: nl.nets, gnd: nl.gnd, ...boardOpts }, path.join(dir, 'chipscale.svg'), 285_000)
        cand = { parts: nl.parts, nets: nl.nets, gnd: nl.gnd, note: undefined, droppedCapabilities: undefined, realFootprints: 0, result, svgName: 'chipscale.svg' }
        boardSource = 'planner-merged'
      }
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
      const MAX_REPLANS = 3
      const iterations: any[] = []
      const droppedCaps: string[] = [] // capabilities shed across the KEPT re-plan path (Stage D)
      let best = cand // the best candidate across all iterations (starts as the first pass)

      // Keep re-planning simpler while the best board is still over the density
      // budget — each round feeds the CURRENT best board's failure back and asks
      // for a further simplification, escalating how aggressive the cut is. Stop
      // on a clean route, on no improvement, when the re-plan budget/iterations
      // run out, or when a build fails (fall back to the best so far).
      let round = 0
      while (round < MAX_REPLANS && densityFailed(best.result)) {
        const elapsed = Date.now() - routeStart
        const estNext = iterations.length ? (iterations[iterations.length - 1].ms ?? 180_000) : 190_000
        if (elapsed + estNext > OUTER_BUDGET_MS) { iterations.push({ round: round + 1, skipped: 'time budget', elapsedMs: elapsed }); break }
        round++

        const rb = best.result
        const hist = Object.entries(fpHistogram(best.parts)).map(([k, v]) => `${v}×${k}`).join(', ')
        const escalate = round === 1
          ? `Re-design it SIMPLER so it can route clean:`
          : `This is re-plan #${round}; the previous simplification still did NOT route clean. Cut HARDER — strip to the product's ESSENTIAL core function only:`
        const feedback =
          `\n\nRE-PLAN — this part set did NOT route clean at chip-scale:\n` +
          `${best.parts.length} parts (${hist}) → ${rb.boardMm?.w}×${rb.boardMm?.h}mm with ${rb.drc?.errors} DRC error(s), ` +
          `mostly hole_clearance (fine-pitch packages packed too tight to route at this size).\n` +
          `${escalate}\n` +
          `- prefer a COARSER package where the function allows (a wider-pitch/larger IC over a fine-pitch qfn);\n` +
          `- INTEGRATE functions into fewer ICs where a real combined part exists;\n` +
          `- DROP a non-essential peripheral (keep the product's core function; shed nice-to-haves);\n` +
          `- fewer discrete parts overall.\n` +
          `Keep it a REAL functional board for THIS product. Add a "note" field naming what you simplified and why, ` +
          `and a "droppedCapabilities" field: a list of any product CAPABILITIES you removed to fit ` +
          `(e.g. "data logging (SPI flash)", "battery charging"), or [] if you only coarsened/consolidated packages.`

        const tA = Date.now()
        let next: Awaited<ReturnType<typeof buildCandidate>> | null = null
        let replanError: string | null = null
        // re-plans are mechanical simplification of an already-decided design → cheaper model
        try { next = await buildCandidate(baseMsg + feedback, req, dir, `chipscale-replan${round}.svg`, 220_000, boardOpts, REPLAN_MODEL) }
        catch (e) { replanError = String(e) }
        const ms = Date.now() - tA

        if (!next) { iterations.push({ round, replanError, ms }); break } // build failed — keep best so far
        const improved = betterResult(best.result, next.result) === 'b'
        iterations.push({
          round, change: describeDesignChange(best.parts, next.parts), note: next.note ?? null,
          droppedCapabilities: next.droppedCapabilities ?? [],
          parts: next.parts.length, drc: next.result?.drc?.errors ?? null, ok: !!next.result?.ok,
          kept: improved, ms,
        })
        if (!improved) break // this re-plan was no better than the current best — stop
        for (const c of (next.droppedCapabilities ?? [])) if (!droppedCaps.includes(c)) droppedCaps.push(c) // shed on the kept path
        best = next
        if (best.result?.ok) break // clean route — genuinely converged
      }

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
    if (result?.error) return Response.json({ ok: false, error: result.error })

    // fold the outer-loop outcome into drcRepair so the existing UI (which renders
    // drcRepair.fixes) shows the re-plan honestly, and keep the structured object.
    if (designConvergence && result.drcRepair) {
      result.drcRepair.designConvergence = designConvergence
      const dc = designConvergence
      const tail = dc.kept === 'replanned'
        ? `re-planned the design ${dc.replans}× (${dc.change}) → ${dc.after?.drc} vs ${dc.before.drc} DRC error(s)${dc.converged ? ', routes clean' : ''}`
        : `kept the original — ${dc.replans} re-plan attempt(s) were no better`
      result.drcRepair.fixes = [
        ...(result.drcRepair.fixes ?? []),
        `design↔routing outer loop: ${dc.reason} → ${tail}`,
      ]
    }

    if (result.boardMm) {
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

    return Response.json({
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
    })
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 502 })
  }
}
