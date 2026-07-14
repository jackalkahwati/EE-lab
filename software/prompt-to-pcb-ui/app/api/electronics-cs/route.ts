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
import type { ProductSpec } from '@/lib/product-spec'

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

async function emitPartsNets(userMsg: string, override?: LLMOverride): Promise<{ parts: any[]; nets: any[]; gnd: string[]; note?: string }> {
  const antKey = process.env.ANTHROPIC_API_KEY
  const opts = override?.apiKey
    ? override
    : antKey
      ? { apiKey: antKey, provider: 'anthropic' as const, model: 'claude-sonnet-5' }
      : { model: 'claude-sonnet-5' }
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text } = await callLLMText(SYSTEM, attempt === 0 ? userMsg : userMsg + '\n\nReply with ONLY the JSON object.', opts)
      const o = JSON.parse(firstJson(text))
      if (Array.isArray(o.parts) && o.parts.length) return { parts: o.parts, nets: Array.isArray(o.nets) ? o.nets : [], gnd: Array.isArray(o.gnd) ? o.gnd.map(String) : [], note: typeof o.note === 'string' ? o.note : undefined }
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

function runBoard(payload: object, svgPath: string, timeoutMs = 285_000): Promise<any> {
  const script = path.join(process.cwd(), '..', '..', 'tools', 'tscircuit', 'run_board.mjs')
  return new Promise((resolve, reject) => {
    const py = spawn('node', [script], { timeout: timeoutMs })
    let out = '', err = ''
    py.stdout.on('data', (d) => (out += d))
    py.stderr.on('data', (d) => (err += d))
    py.on('error', reject)
    py.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop() || '{}')) }
      catch { reject(new Error('runner produced no JSON: ' + (err || out).slice(0, 300))) }
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

/** One full board candidate: part-set engine → real footprints → routed board. */
async function buildCandidate(userMsg: string, req: Request, dir: string, svgName: string, timeoutMs: number) {
  const { parts, nets, gnd, note } = await emitPartsNets(userMsg, overrideFromHeaders(req.headers))
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
  const result = await runBoard({ parts, nets, gnd }, path.join(dir, svgName), timeoutMs)
  return { parts, nets, gnd, note, realFootprints, result, svgName }
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const spec = body.spec as ProductSpec | undefined
    const runId = typeof body.runId === 'string' ? body.runId : undefined
    if (!spec?.product) return Response.json({ error: 'missing product spec' }, { status: 400 })
    if (!runId || !RUN_ID.test(runId)) return Response.json({ error: 'missing/invalid runId' }, { status: 400 })

    const b = spec.budgets ?? {}
    const elec = spec.disciplines?.electronics
    const baseMsg =
      `PRODUCT: ${spec.product}\n${spec.description || ''}\n` +
      `size budget: ${JSON.stringify(b.sizeMm ?? {})}\n` +
      `electronics: ${elec?.summary || elec?.boardIntent || '-'}\n` +
      `List the minimal chip-scale part set + nets.`

    const dir = path.join(process.cwd(), 'public', 'runs', runId, 'electronics')
    await fs.mkdir(dir, { recursive: true })

    // FIRST PASS — design the part set, route it.
    let cand = await buildCandidate(baseMsg, req, dir, 'chipscale.svg', 285_000)
    let designConvergence: any = null

    // OUTER LOOP (design↔routing): the routing layer already loosens placement to
    // relieve density (run_board's gap ladder). When even that can't route clean
    // — the board is over its DRC budget — the density is a DESIGN problem, not a
    // layout one. Feed the failure back to the part-set engine and ask for a
    // simpler/coarser design (coarser packages, integrated functions, fewer
    // non-essential parts), then re-route. Keep whichever board is genuinely
    // better and report exactly what the re-plan changed (computed from the part
    // sets, not the model's say-so). One bounded iteration so it can't run away.
    if (DENSITY_REPLAN && densityFailed(cand.result)) {
      const r0 = cand.result
      const hist = Object.entries(fpHistogram(cand.parts)).map(([k, v]) => `${v}×${k}`).join(', ')
      const feedback =
        `\n\nRE-PLAN — this part set did NOT route clean at chip-scale:\n` +
        `${cand.parts.length} parts (${hist}) → ${r0.boardMm?.w}×${r0.boardMm?.h}mm with ${r0.drc?.errors} DRC error(s), ` +
        `mostly hole_clearance (fine-pitch packages packed too tight to route at this size).\n` +
        `Re-design it SIMPLER so it can route clean:\n` +
        `- prefer a COARSER package where the function allows (a wider-pitch/larger IC over a fine-pitch qfn);\n` +
        `- INTEGRATE functions into fewer ICs where a real combined part exists;\n` +
        `- DROP a non-essential peripheral (keep the product's core function; shed nice-to-haves);\n` +
        `- fewer discrete parts overall.\n` +
        `Keep it a REAL functional board for THIS product. Add a "note" field naming what you simplified and why.`
      // Best-effort: a failed/timed-out re-plan build must NEVER discard the good
      // first board — fall back to it and report the re-plan didn't complete.
      let cand2: Awaited<ReturnType<typeof buildCandidate>> | null = null
      let replanError: string | null = null
      try { cand2 = await buildCandidate(baseMsg + feedback, req, dir, 'chipscale-replan.svg', 220_000) }
      catch (e) { replanError = String(e) }

      const winner = cand2 ? betterResult(cand.result, cand2.result) : 'a'
      designConvergence = {
        triggered: true,
        reason: `first pass routed ${r0.boardMm?.w}×${r0.boardMm?.h}mm but held ${r0.drc?.errors} DRC error(s) — over the density budget`,
        change: cand2 ? describeDesignChange(cand.parts, cand2.parts) : 'the re-plan build did not complete',
        note: cand2?.note ?? null,
        replanError,
        before: { parts: cand.parts.length, drc: r0.drc?.errors ?? null, ok: !!r0.ok },
        after: cand2 ? { parts: cand2.parts.length, drc: cand2.result?.drc?.errors ?? null, ok: !!cand2.result?.ok } : null,
        kept: winner === 'b' ? 'replanned' : 'original',
      }
      if (winner === 'b' && cand2) {
        cand = cand2
        // promote the re-planned board's SVGs to the canonical names the UI reads
        for (const [from, to] of [['chipscale-replan.svg', 'chipscale.svg'], ['chipscale-replan-schematic.svg', 'chipscale-schematic.svg']]) {
          try { await fs.copyFile(path.join(dir, from), path.join(dir, to)) } catch { /* svg optional */ }
        }
      }
    }

    const { parts, result, realFootprints } = cand
    if (result?.error) return Response.json({ ok: false, error: result.error })

    // fold the outer-loop outcome into drcRepair so the existing UI (which renders
    // drcRepair.fixes) shows the re-plan honestly, and keep the structured object.
    if (designConvergence && result.drcRepair) {
      result.drcRepair.designConvergence = designConvergence
      const dc = designConvergence
      const tail = dc.replanError
        ? `re-plan build did not complete (${String(dc.replanError).slice(0, 80)}); kept the original`
        : dc.kept === 'replanned'
          ? `re-planned the part set (${dc.change}) → ${dc.after?.drc} vs ${dc.before.drc} DRC error(s)`
          : `kept the original — the re-plan (${dc.change}) was no better (${dc.after?.drc} vs ${dc.before.drc} DRC error(s))`
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
      await fs.writeFile(path.join(dir, 'chipscale-board.json'),
        JSON.stringify({ boardMm: result.boardMm, areaMm2: result.areaMm2, components: result.components, routedTraces: result.routedTraces, realFootprints, parts: partList, drc: result.drc ?? null, drcRepair: result.drcRepair ?? null, designConvergence }))
      // the routed .kicad_pcb for the 3D render (the real chip-down board)
      if (result.kicadPcb) await fs.writeFile(path.join(dir, 'chipscale.kicad_pcb'), result.kicadPcb)
    }

    return Response.json({
      ok: !!result.ok,
      boardMm: result.boardMm,
      areaMm2: result.areaMm2,
      components: result.components,
      routedTraces: result.routedTraces,
      errors: result.errors ?? {},
      drc: result.drc ?? null,
      drcRepair: result.drcRepair ?? null,
      designConvergence,
      realFootprints,
      svgUrl: result.svg ? `/runs/${runId}/electronics/chipscale.svg?t=${Date.now()}` : null,
      code: result.code,
    })
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 502 })
  }
}
