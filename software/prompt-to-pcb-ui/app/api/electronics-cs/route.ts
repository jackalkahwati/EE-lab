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
export const maxDuration = 200

const RUN_ID = /^run-[A-Za-z0-9._-]{1,128}$/

const SYSTEM = `detailed thinking off.
You are the chip-scale electronics engineer. Design a PRODUCTION-REALISTIC board
for this product — a real functional netlist, not a toy. Use a single highly-
integrated SoC (audio/BLE + PMIC/charger/DSP) and add the parts a real board needs.

Output ONLY one JSON object, no prose, no fences:
{"parts":[{"name":"U1","footprint":"qfn32","kind":"chip"},{"name":"MIC1","footprint":"qfn6","kind":"chip"},{"name":"C1","footprint":"0402","kind":"capacitor","lcsc":"C1525"}],
 "nets":[["U1.1","C1.1"],["U1.13","MIC1.1"]],
 "gnd":["U1.16","MIC1.3","C1.2"]}

PARTS — include the real functional set (10-16 parts):
- U1: the main SoC (qfn32/qfn48).
- 1-2 MEMS mics (qfn6); a speaker driver/amp if not integrated.
- ANT1 chip antenna (footprint "0402") + an antenna-matching L and C.
- Decoupling: ONE 100nF (0402) capacitor per SoC power pin/rail, plus one bulk
  1uF/10uF. Each cap sits on its own power net.
- Charge path parts + a status LED (0402) with series resistor.

NETS — every real signal + power connection (12-22 nets) as ["COMP.PIN","COMP.PIN"]:
- Power rails: each SoC power pin -> its decoupling cap (and shared rails linked).
- Audio: I2S/PDM buses -> the mic(s) and the speaker/driver (clock + data lines).
- RF: SoC RF pin -> matching L -> matching C -> ANT1.
- Charging + control: charge sense, status LED, reset if separate.

RULES:
- footprints: qfn6/qfn8/qfn16/qfn24/qfn32/qfn48 for ICs; 0402 for passives.
- kind is "chip" | "capacitor" | "resistor".
- OPTIONAL "lcsc": a REAL LCSC part number for a component if you know one
  (e.g. "C1525" = 100nF 0402, "C25804" = 10k 0402). OMIT if unsure. Do NOT invent ids.
- nets connect pins as "COMPONENT.PIN"; pin numbers MUST exist (qfnN -> 1..N,
  passive -> 1 and 2). Two-point nets only (["A.p","B.p"]); split a shared rail into
  multiple two-point nets.
- "gnd": list EVERY ground pin as "COMPONENT.PIN" (SoC GND/VSS pins, mic grounds,
  the ground side of each decoupling cap, antenna ground). These are NOT in "nets" —
  the platform lays a real ground PLANE and bonds them to it (that's how a board
  handles ground, not point-to-point traces). This is what makes the netlist
  production-realistic: signals + power in "nets", every ground in "gnd".
- Be COMPLETE: real decoupling, real audio buses, real RF chain, and a full ground
  net. The runner places + routes signals and pours the ground plane; you list the
  parts, the signal/power connections, and the ground pins.`

async function emitPartsNets(userMsg: string, override?: LLMOverride): Promise<{ parts: any[]; nets: any[]; gnd: string[] }> {
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
      if (Array.isArray(o.parts) && o.parts.length) return { parts: o.parts, nets: Array.isArray(o.nets) ? o.nets : [], gnd: Array.isArray(o.gnd) ? o.gnd.map(String) : [] }
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

function runBoard(payload: object, svgPath: string): Promise<any> {
  const script = path.join(process.cwd(), '..', '..', 'tools', 'tscircuit', 'run_board.mjs')
  return new Promise((resolve, reject) => {
    const py = spawn('node', [script], { timeout: 150_000 })
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

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const spec = body.spec as ProductSpec | undefined
    const runId = typeof body.runId === 'string' ? body.runId : undefined
    if (!spec?.product) return Response.json({ error: 'missing product spec' }, { status: 400 })
    if (!runId || !RUN_ID.test(runId)) return Response.json({ error: 'missing/invalid runId' }, { status: 400 })

    const b = spec.budgets ?? {}
    const elec = spec.disciplines?.electronics
    const userMsg =
      `PRODUCT: ${spec.product}\n${spec.description || ''}\n` +
      `size budget: ${JSON.stringify(b.sizeMm ?? {})}\n` +
      `electronics: ${elec?.summary || elec?.boardIntent || '-'}\n` +
      `List the minimal chip-scale part set + nets.`

    const { parts, nets, gnd } = await emitPartsNets(userMsg, overrideFromHeaders(req.headers))

    // pull REAL LCSC footprints for any part the engine tagged with a valid id;
    // attach as part.kicadMod so the runner uses the true pad geometry + size.
    // Fetch each distinct id ONCE (duplicate ids — e.g. two identical caps —
    // would otherwise race two subprocesses on the same /tmp file).
    const ids = [...new Set(parts.map((p: any) => (p?.lcsc ? String(p.lcsc) : '')).filter(Boolean))]
    const mods = new Map<string, string>()
    await Promise.all(ids.map(async (id) => { const m = await fetchFootprint(id); if (m) mods.set(id, m) }))
    let realFootprints = 0
    for (const p of parts as any[]) {
      const m = p?.lcsc ? mods.get(String(p.lcsc)) : undefined
      if (m) { p.kicadMod = m; realFootprints++ }
    }

    const dir = path.join(process.cwd(), 'public', 'runs', runId, 'electronics')
    await fs.mkdir(dir, { recursive: true })
    const svgPath = path.join(dir, 'chipscale.svg')
    const result = await runBoard({ parts, nets, gnd }, svgPath)

    if (result?.error) return Response.json({ ok: false, error: result.error })

    if (result.boardMm) {
      await fs.writeFile(path.join(dir, 'chipscale-board.json'),
        JSON.stringify({ boardMm: result.boardMm, areaMm2: result.areaMm2, components: result.components, routedTraces: result.routedTraces, realFootprints, drc: result.drc ?? null, drcRepair: result.drcRepair ?? null }))
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
      realFootprints,
      svgUrl: result.svg ? `/runs/${runId}/electronics/chipscale.svg?t=${Date.now()}` : null,
      code: result.code,
    })
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 502 })
  }
}
