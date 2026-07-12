/**
 * Chip-scale electronics module — the product engine emits a tscircuit board
 * (code-defined electronics) for the product; the tscircuit runner autoroutes it
 * in-process and returns the REAL board size + routing result + an SVG. This is
 * the chip-down path that produces an earbud-scale board the big flroute pipeline
 * can't — and it's honest: a board only counts as routed with traces AND zero
 * errors, and the real dimensions flow into the mechanical fit-check / redesign
 * loop (so the fit can actually close).
 *
 * Generic: the product engine directs the board (code = data); the runner just
 * executes whatever it emits.
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
You are the chip-scale electronics specialist. Emit a tscircuit board (code-
defined PCB) that realizes the product's electronics at the SMALLEST honest size,
using chip-scale packages. Output ONLY tscircuit code — a default-exported React
component — no prose, no markdown fences.

RULES (critical — the autorouter fails if violated):
- <board autorouter="auto"> with NO width/height (it auto-fits).
- Components: <chip name="U1" footprint="qfn32" pcbX={..} pcbY={..} />, plus
  <capacitor .. footprint="0402"/> and <resistor .. footprint="0402"/>.
  Use small footprints: qfn8/qfn16/qfn24/qfn32 for ICs, 0201/0402 for passives.
- PLACEMENT MUST NOT OVERLAP courtyards. Space ICs at least ~8mm apart; keep
  passives ≥2mm from any IC. Lay parts on a spread grid, not stacked.
- Connect with <trace from=".U1 > .pinN" to=".C1 > .pin1" />. Pin numbers MUST
  exist on the footprint (qfn32 -> pins 1..32, qfn8 -> 1..8, passives -> pin1/pin2).
- Include the real functional blocks for THIS product (e.g. a BLE audio SoC, PMIC/
  charger, MEMS mic(s), driver amp) as chips, plus a handful of decoupling parts.
- 6-12 components, ~6-14 traces. Keep it valid and routable.

Example shape:
export default () => (
  <board autorouter="auto">
    <chip name="U1" footprint="qfn32" pcbX={0} pcbY={0} />
    <chip name="U2" footprint="qfn16" pcbX={-10} pcbY={0} />
    <capacitor name="C1" capacitance="100nF" footprint="0402" pcbX={5} pcbY={-8} />
    <trace from=".U1 > .pin1" to=".C1 > .pin1" />
    <trace from=".U1 > .pin5" to=".U2 > .pin1" />
  </board>
)`

async function emitCode(userMsg: string, override?: LLMOverride): Promise<string> {
  const antKey = process.env.ANTHROPIC_API_KEY
  const opts = override?.apiKey
    ? override
    : antKey
      ? { apiKey: antKey, provider: 'anthropic' as const, model: 'claude-sonnet-5' }
      : { model: 'claude-sonnet-5' }
  const { text } = await callLLMText(SYSTEM, userMsg, opts)
  let code = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const fence = code.match(/```(?:tsx|jsx|ts|js)?\s*\n([\s\S]*?)```/)
  if (fence) code = fence[1].trim()
  return code
}

function runBoard(code: string, svgPath: string): Promise<any> {
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
    py.stdin.write(JSON.stringify({ code, svgPath }))
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
      `Emit the chip-scale tscircuit board.`

    const override = overrideFromHeaders(req.headers)
    let code = await emitCode(userMsg, override)
    const dir = path.join(process.cwd(), 'public', 'runs', runId, 'electronics')
    await fs.mkdir(dir, { recursive: true })
    const svgPath = path.join(dir, 'chipscale.svg')
    let result = await runBoard(code, svgPath)

    // one repair pass: if parts overlap (the autorouter's main failure mode),
    // feed the error back and ask for more spacing.
    const totalErrs = (r: any) => Object.values(r?.errors ?? {}).reduce((a: number, b: any) => a + b, 0) as number
    if (!result.error && totalErrs(result) > 0 && result.routedTraces > 0) {
      const fixMsg =
        `${userMsg}\n\nYour previous board had ${totalErrs(result)} placement/DRC errors ` +
        `(${Object.keys(result.errors).join(', ')}). Here is the code:\n${code}\n\n` +
        `Emit a CORRECTED version with MORE spacing between the overlapping parts (increase the ` +
        `pcbX/pcbY gaps so no courtyards touch). Keep every component and trace. Output ONLY the code.`
      const code2 = await emitCode(fixMsg, override)
      const result2 = await runBoard(code2, svgPath)
      if (!result2.error && totalErrs(result2) < totalErrs(result)) { code = code2; result = result2 }
    }

    if (result?.error) return Response.json({ ok: false, error: result.error, code })

    // persist the chip-scale board dims so mechanical fit-check / redesign prefer it
    if (result.boardMm) {
      await fs.writeFile(path.join(dir, 'chipscale-board.json'),
        JSON.stringify({ boardMm: result.boardMm, areaMm2: result.areaMm2, components: result.components, routedTraces: result.routedTraces }))
    }

    return Response.json({
      ok: !!result.ok,
      boardMm: result.boardMm,
      areaMm2: result.areaMm2,
      components: result.components,
      routedTraces: result.routedTraces,
      errors: result.errors ?? {},
      svgUrl: result.svg ? `/runs/${runId}/electronics/chipscale.svg?t=${Date.now()}` : null,
      code,
    })
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 502 })
  }
}
