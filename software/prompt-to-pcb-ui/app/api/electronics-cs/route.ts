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
You are the chip-scale electronics specialist. List the MINIMAL, highly-integrated
part set + connections for this product's board. Assume high integration: prefer a
single audio/BLE SoC that already integrates the PMIC/charger/DSP; add ONLY what is
truly separate (1-2 MEMS mics, a driver amp if not integrated) plus a few 0201
decoupling parts. Fewer parts = smaller board.

Output ONLY one JSON object, no prose, no fences:
{"parts":[{"name":"U1","footprint":"qfn32","kind":"chip"},{"name":"MIC1","footprint":"qfn6","kind":"chip"},{"name":"C1","footprint":"0201","kind":"capacitor","lcsc":"C1525"}],
 "nets":[["U1.1","C1.1"],["U1.13","MIC1.1"]]}
RULES:
- footprints: qfn6/qfn8/qfn16/qfn24/qfn32 for ICs; 0201 or 0402 for passives.
- kind is "chip" | "capacitor" | "resistor".
- OPTIONAL "lcsc": if you know a REAL LCSC part number for a component, include it
  (e.g. "C1525" = 100nF 0402, "C25804" = 10k 0402) — the platform pulls the real
  footprint. OMIT it if unsure; a generic footprint is used. Do NOT invent LCSC ids.
- nets connect pins as "COMPONENT.PIN" (e.g. "U1.5" = U1 pin 5). Pin numbers MUST
  exist on the footprint (qfn32 -> 1..32, qfn6 -> 1..6, passives -> 1 and 2).
- 4-7 parts, 4-8 nets — maximize integration (one SoC does most of it), keep it
  minimal so it packs tiny. The runner computes placement + routing — you only
  list parts + connections.`

async function emitPartsNets(userMsg: string, override?: LLMOverride): Promise<{ parts: any[]; nets: any[] }> {
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
      if (Array.isArray(o.parts) && o.parts.length) return { parts: o.parts, nets: Array.isArray(o.nets) ? o.nets : [] }
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

    const { parts, nets } = await emitPartsNets(userMsg, overrideFromHeaders(req.headers))

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
    const result = await runBoard({ parts, nets }, svgPath)

    if (result?.error) return Response.json({ ok: false, error: result.error })

    if (result.boardMm) {
      await fs.writeFile(path.join(dir, 'chipscale-board.json'),
        JSON.stringify({ boardMm: result.boardMm, areaMm2: result.areaMm2, components: result.components, routedTraces: result.routedTraces, realFootprints, drc: result.drc ?? null }))
    }

    return Response.json({
      ok: !!result.ok,
      boardMm: result.boardMm,
      areaMm2: result.areaMm2,
      components: result.components,
      routedTraces: result.routedTraces,
      errors: result.errors ?? {},
      drc: result.drc ?? null,
      realFootprints,
      svgUrl: result.svg ? `/runs/${runId}/electronics/chipscale.svg?t=${Date.now()}` : null,
      code: result.code,
    })
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 502 })
  }
}
