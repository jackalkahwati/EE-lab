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
import { callLLMText, overrideFromHeaders, type LLMOverride } from '@/lib/llm'
import { MECH_PLAN_SCHEMA, normalizeMechPlan, type MechPlan } from '@/lib/mechanical-plan'
import type { ProductSpec } from '@/lib/product-spec'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const RUN_ID = /^run-[A-Za-z0-9._-]{1,128}$/

const SYSTEM = `detailed thinking off.
You are the mechanical specialist for an autonomous product-engineering platform.
Given a PRODUCT and the REAL built PCB footprint, emit a parametric build plan
that wraps/serves the product mechanically (an enclosure, in-ear shell, bracket,
potting box — whatever the product needs). GENERAL across categories; never
assume a domain.

The plan is an ordered list of ops in mm, XY = base plane, +Z up. Build a base
body sized to the board + walls, hollow an inner cavity for the board (leave a
floor = wall thickness), add mounting standoffs, and any needed port cutouts.
Keep it manufacturable and realistic for the given size budget. Reference the
real board dimensions given below so the cavity actually fits the board.

Output ONLY one JSON object, no prose, no markdown fences, EXACTLY this shape:
${MECH_PLAN_SCHEMA}`

async function callLLM(userMsg: string, override?: LLMOverride): Promise<MechPlan> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const antKey = process.env.ANTHROPIC_API_KEY
      const opts = override?.apiKey
        ? override
        : antKey
          ? { apiKey: antKey, provider: 'anthropic' as const, model: 'claude-sonnet-5' }
          : { model: 'claude-sonnet-5' }
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
    const py = spawn('python3', [script, outDir, name], { timeout: 280_000 })
    let out = '', err = ''
    py.stdout.on('data', (d) => (out += d))
    py.stderr.on('data', (d) => (err += d))
    py.on('error', reject)
    py.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop() || '{}')) }
      catch { reject(new Error('executor produced no JSON: ' + (err || out).slice(0, 300))) }
    })
    py.stdin.write(JSON.stringify(plan))
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
    let board: { wMm?: number; hMm?: number; layers?: number } = {}
    try {
      const cs = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'electronics', 'chipscale-board.json'), 'utf8'))
      if (cs?.boardMm?.w && cs?.boardMm?.h) board = { wMm: cs.boardMm.w, hMm: cs.boardMm.h }
    } catch { /* no chip-scale board */ }
    if (!board.wMm) {
      try {
        const bj = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'data', 'board.json'), 'utf8'))
        board = { wMm: bj?.boardSize?.wMm, hMm: bj?.boardSize?.hMm, layers: bj?.layers }
      } catch { /* no board yet — plan from budgets only */ }
    }

    const b = spec.budgets ?? {}
    const userMsg =
      `PRODUCT: ${spec.product}\n${spec.description || ''}\n` +
      `philosophy: ${spec.philosophy || '-'}\n` +
      `size budget: ${JSON.stringify(b.sizeMm ?? {})}\n` +
      (board.wMm && board.hMm
        ? `REAL built board footprint: ${Math.round(board.wMm)} x ${Math.round(board.hMm)} mm, ${board.layers ?? '?'}-layer. Size the cavity to fit THIS board plus clearance + walls.\n`
        : `No built board yet — size from the budget.\n`) +
      `Emit the mechanical build plan.`

    const plan = await callLLM(userMsg, overrideFromHeaders(req.headers))

    // Honest fit check: does the real PCB fit the enclosure cavity? (a violation
    // the redesign loop consumes — never silently shrink the board to fake a fit)
    const baseSketch = plan.operations.find((o) => o.op === 'sketch') as { profile?: { w?: number; h?: number } } | undefined
    const pcbOp = plan.operations.find((o) => o.op === 'component' && (o as { kind?: string }).kind === 'pcb') as { w?: number; h?: number } | undefined
    const enc = baseSketch?.profile?.w && baseSketch.profile.h ? { w: baseSketch.profile.w, h: baseSketch.profile.h } : null
    const pcb = pcbOp?.w && pcbOp.h ? { w: pcbOp.w, h: pcbOp.h } : (board.wMm && board.hMm ? { w: board.wMm, h: board.hMm } : null)
    const wall = 1.5
    const fitCheck = enc && pcb
      ? {
          fits: pcb.w <= enc.w - 2 * wall + 0.5 && pcb.h <= enc.h - 2 * wall + 0.5,
          enclosureMm: { w: Math.round(enc.w), h: Math.round(enc.h) },
          pcbMm: { w: Math.round(pcb.w), h: Math.round(pcb.h) },
        }
      : null

    const outDir = path.join(process.cwd(), 'public', 'runs', runId, 'mechanical')
    const result = await renderPlan(plan, outDir, spec.product)

    if (!result?.ok) {
      return Response.json({ ok: false, error: result?.error || 'executor failed', opsFailed: result?.opsFailed ?? [], plan })
    }
    const base = `/runs/${runId}/mechanical`
    const payload = {
      ok: true,
      part: result.part,
      previewUrl: result.previewPath ? `${base}/enclosure.png?t=${Date.now()}` : null,
      stepUrl: result.stepPath ? `${base}/enclosure.step` : null,
      onshapeUrl: result.onshapeUrl,
      opsRendered: result.opsRendered ?? [],
      opsFailed: result.opsFailed ?? [],
      fitCheck,
      plan,
    }

    // Persist a summary (incl. the real fitCheck) so the stage loads on mount and
    // the feedback controller can consume the actual fit result, not a recomputed
    // one. The STEP/PNG are already written to this dir by renderPlan.
    try {
      await fs.writeFile(path.join(outDir, 'mechanical.json'),
        JSON.stringify({ part: payload.part, previewUrl: payload.previewUrl, stepUrl: payload.stepUrl, onshapeUrl: payload.onshapeUrl, opsRendered: payload.opsRendered, opsFailed: payload.opsFailed, fitCheck }))
    } catch { /* best effort */ }

    return Response.json(payload)
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 502 })
  }
}
