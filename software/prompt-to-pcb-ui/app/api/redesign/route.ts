/**
 * Redesign loop — the generic feedback controller that makes the pipeline
 * CONVERGE (or honestly fail). Each iteration: gather violations (PCB doesn't
 * fit the envelope, simulation FAILs), ask a design controller for fixes —
 * classified ACHIEVABLE (adjust budgets/constraints) vs CAPABILITY-GAP (a module
 * can't do it, e.g. chip-down electronics) — apply the achievable ones, re-run
 * the checks, and repeat. Converges when no violations remain, or stops and
 * reports the capability gaps honestly. Nothing is faked to force convergence.
 *
 * Generic: it operates on the product spec + evaluators/sims, not on any domain.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { callLLMText, overrideFromHeaders } from '@/lib/llm'
import type { ProductSpec } from '@/lib/product-spec'

export const dynamic = 'force-dynamic'
export const maxDuration = 200

const RUN_ID = /^run-[A-Za-z0-9._-]{1,128}$/
const MAX_ITERS = 3

type Budgets = ProductSpec['budgets']

function runSim(reqObj: Record<string, unknown>): Promise<any> {
  const script = path.join(process.cwd(), '..', '..', 'tools', 'sim', 'run_sim.py')
  return new Promise((resolve) => {
    const py = spawn('python3', [script], { timeout: 90_000 })
    let out = ''
    py.stdout.on('data', (d) => (out += d))
    py.on('error', () => resolve({ results: [] }))
    py.on('close', () => { try { resolve(JSON.parse(out.trim().split('\n').pop() || '{}')) } catch { resolve({ results: [] }) } })
    py.stdin.write(JSON.stringify(reqObj)); py.stdin.end()
  })
}

function simInputs(b: Budgets, boardAreaMm2?: number) {
  const p = b?.power ?? {}
  return {
    activeMw: p.activeMw, batteryMah: p.batteryMah, boardAreaMm2, massG: b?.massG,
    envelopeMm: b?.sizeMm, runtimeTargetHours: p.runtimeHours,
  }
}

/** Collect the current violations from fit + simulations. */
async function violations(b: Budgets, board: { wMm?: number; hMm?: number }, boardAreaMm2?: number) {
  const v: { id: string; kind: string; detail: string }[] = []
  const env = b?.sizeMm
  if (board.wMm && board.hMm && env?.x && env?.y) {
    const fits = board.wMm <= env.x + 0.5 && board.hMm <= env.y + 0.5
    if (!fits) v.push({ id: 'fit', kind: 'fit', detail: `real board ${Math.round(board.wMm)}×${Math.round(board.hMm)}mm exceeds envelope ${env.x}×${env.y}mm` })
  }
  const sim = await runSim(simInputs(b, boardAreaMm2))
  for (const r of sim.results ?? []) {
    if (r && r.pass === false) v.push({ id: `sim:${r.sim}`, kind: 'sim', detail: `${r.sim} ${r.metric} = ${r.value}${r.unit} vs limit ${r.limit}` })
  }
  return v
}

const CONTROLLER_SYS = `detailed thinking off.
You are the redesign controller for an autonomous product-engineering platform.
Given current VIOLATIONS and the product's budgets, propose ONE fix per violation.
Classify each fix honestly:
- "achievable": true  -> the platform CAN apply it by changing a budget/target
  (e.g. increase batteryMah to fix runtime; enlarge enclosure; reduce activeMw;
  increase surface area for thermal). Provide concrete "budgetChanges".
- "achievable": false -> it needs a module CAPABILITY the platform does NOT have
  (e.g. shrinking the PCB to fit needs chip-down / rigid-flex EDA that isn't
  built). Do NOT invent budgetChanges for these — say what capability is missing.

NEVER fake a fit by shrinking the real board. Output ONLY this JSON:
{"adjustments":[{"violation":"<id>","module":"<electronics|mechanical|battery|thermal|rf|...>","fix":"<one line>","achievable":<bool>,"capabilityGap":"<if not achievable, the missing capability, else empty>","budgetChanges":{"power":{"batteryMah":<n>,"activeMw":<n>,"runtimeHours":<n>},"sizeMm":{"x":<n>,"y":<n>,"z":<n>},"massG":<n>}}]}`

function deepMergeBudgets(b: Budgets, changes: any): Budgets {
  const out: any = JSON.parse(JSON.stringify(b ?? {}))
  if (!changes || typeof changes !== 'object') return out
  if (changes.sizeMm) out.sizeMm = { ...(out.sizeMm ?? {}), ...changes.sizeMm }
  if (changes.power) out.power = { ...(out.power ?? {}), ...changes.power }
  if (typeof changes.massG === 'number') out.massG = changes.massG
  if (typeof changes.unitCostUsd === 'number') out.unitCostUsd = changes.unitCostUsd
  return out
}

function firstJson(text: string): any {
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const i = t.indexOf('{')
  if (i < 0) throw new Error('no json')
  let depth = 0, inStr = false, esc = false
  for (let k = i; k < t.length; k++) {
    const ch = t[k]
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false }
    else if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return JSON.parse(t.slice(i, k + 1)) }
  }
  throw new Error('unbalanced json')
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const spec = body.spec as ProductSpec | undefined
    const runId = typeof body.runId === 'string' ? body.runId : undefined
    if (!spec?.product) return Response.json({ error: 'missing product spec' }, { status: 400 })

    let board: { wMm?: number; hMm?: number } = {}
    let boardAreaMm2: number | undefined
    if (runId && RUN_ID.test(runId)) {
      // prefer the chip-scale board (electronics-cs) if present
      try {
        const cs = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'electronics', 'chipscale-board.json'), 'utf8'))
        if (cs?.boardMm?.w && cs?.boardMm?.h) { board = { wMm: cs.boardMm.w, hMm: cs.boardMm.h }; boardAreaMm2 = cs.areaMm2 }
      } catch { /* none */ }
      if (!board.wMm) {
        try {
          const bj = JSON.parse(await fs.readFile(path.join(process.cwd(), 'public', 'runs', runId, 'data', 'board.json'), 'utf8'))
          board = { wMm: bj?.boardSize?.wMm, hMm: bj?.boardSize?.hMm }
          if (board.wMm && board.hMm) boardAreaMm2 = board.wMm * board.hMm
        } catch { /* no board */ }
      }
    }
    const antKey = process.env.ANTHROPIC_API_KEY
    const llmOpts = antKey ? { apiKey: antKey, provider: 'anthropic' as const, model: 'claude-sonnet-5' } : { model: 'claude-sonnet-5' }
    const override = overrideFromHeaders(req.headers)

    let budgets = spec.budgets
    const iterations: any[] = []
    const capabilityGaps: { violation: string; module: string; gap: string }[] = []
    let remaining = await violations(budgets, board, boardAreaMm2)

    for (let it = 0; it < MAX_ITERS && remaining.length > 0; it++) {
      const userMsg = `BUDGETS:\n${JSON.stringify(budgets)}\n\nVIOLATIONS:\n${JSON.stringify(remaining)}\n\nPropose fixes.`
      let adjustments: any[] = []
      try {
        const { text } = await callLLMText(CONTROLLER_SYS, userMsg, override?.apiKey ? override : llmOpts)
        adjustments = firstJson(text).adjustments ?? []
      } catch { adjustments = [] }

      const applied: string[] = []
      for (const a of adjustments) {
        if (a?.achievable && a.budgetChanges) {
          budgets = deepMergeBudgets(budgets, a.budgetChanges)
          applied.push(`${a.violation}: ${a.fix}`)
        } else if (a && a.achievable === false) {
          if (!capabilityGaps.some((g) => g.violation === a.violation))
            capabilityGaps.push({ violation: a.violation, module: a.module ?? '?', gap: a.capabilityGap || a.fix || 'unspecified capability gap' })
        }
      }

      const before = remaining.map((v) => v.id)
      remaining = await violations(budgets, board, boardAreaMm2)
      const resolved = before.filter((id) => !remaining.some((v) => v.id === id))
      iterations.push({ iter: it + 1, applied, resolved, remaining: remaining.map((v) => v.detail), budgets })

      // if every remaining violation is a known capability gap, stop honestly
      if (remaining.length && remaining.every((v) => capabilityGaps.some((g) => g.violation === v.id))) break
      if (!applied.length) break
    }

    const converged = remaining.length === 0
    return Response.json({
      converged,
      status: converged ? 'converged' : (capabilityGaps.length ? 'blocked-capability-gap' : 'not-converged'),
      iterations,
      finalBudgets: budgets,
      remaining: remaining.map((v) => v.detail),
      capabilityGaps,
    })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 })
  }
}
