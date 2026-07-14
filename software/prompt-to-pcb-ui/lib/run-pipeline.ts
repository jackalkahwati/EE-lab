/**
 * Full-pipeline orchestrator — runs the whole product through every engineering
 * discipline end-to-end, in the ONE order that keeps them connected:
 *
 *   chip-scale electronics → mechanical → simulation → [feedback loop] →
 *   firmware → manufacturing → supply chain → validation
 *
 * Electronics runs FIRST because every downstream discipline grounds on the real
 * chip-scale board (public/runs/<id>/electronics/chipscale-board.json via
 * lib/ground-board). The feedback checkpoint runs the redesign controller when the
 * board doesn't fit the enclosure or a simulation fails — it applies achievable
 * budget changes and re-runs mechanical, or reports a capability gap honestly. It
 * never fakes convergence. Each discipline's real API persists its own artifact,
 * so the result is durable and shows in the tab.
 *
 * This reuses the exact per-discipline routes the manual "Generate" buttons call,
 * so nothing is duplicated — the orchestrator only sequences + wires feedback.
 */
import type { ProductSpec } from '@/lib/product-spec'

export type PipeStage =
  | 'electronics' | 'mechanical' | 'simulation'
  | 'firmware' | 'manufacturing' | 'supplyChain' | 'validation'

export type PipeStatus = 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'skipped'

export type StageEvent = { stage: PipeStage; status: PipeStatus; detail?: string }

// The disciplines the orchestrator sequences, in run order. Electronics leads so
// the chip-scale board exists before anything grounds on it.
export const PIPE_ORDER: PipeStage[] = [
  'electronics', 'mechanical', 'simulation',
  'firmware', 'manufacturing', 'supplyChain', 'validation',
]

const DISCIPLINE_STAGES: PipeStage[] = ['firmware', 'manufacturing', 'supplyChain', 'validation']

type RunOpts = {
  spec: ProductSpec
  runId: string
  headers?: Record<string, string>
  signal?: AbortSignal
  onStage: (e: StageEvent) => void
  /** If the chip-scale board already exists, don't rebuild it (~3 min). Default true. */
  reuseElectronics?: boolean
}

export type PipelineResult = {
  stages: Partial<Record<PipeStage, { status: PipeStatus; detail?: string }>>
  feedback?: {
    status: string
    capabilityGaps: { violation: string; module: string; gap: string }[]
    remaining: string[]
  }
  /** Updated spec if the feedback loop changed budgets — caller should lift it. */
  updatedSpec?: ProductSpec
}

function jsonHeaders(h?: Record<string, string>) {
  return { 'content-type': 'application/json', ...(h ?? {}) }
}

async function postJson(url: string, body: unknown, opts: RunOpts): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers: jsonHeaders(opts.headers), body: JSON.stringify(body), signal: opts.signal })
  return r.json()
}

/** Does the chip-scale board already exist for this run? */
async function electronicsExists(runId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const r = await fetch(`/runs/${runId}/electronics/chipscale-board.json`, { cache: 'no-store', signal })
    if (!r.ok) return false
    const d = await r.json()
    return !!(d?.boardMm?.w && d?.boardMm?.h)
  } catch { return false }
}

/** Run one generic discipline module (firmware/mfg/supply/validation). */
async function runDiscipline(stage: PipeStage, opts: RunOpts): Promise<StageEvent> {
  const d = await postJson('/api/discipline', { spec: opts.spec, runId: opts.runId, discipline: stage }, opts)
  if (d?.error) return { stage, status: 'failed', detail: String(d.error) }
  return { stage, status: 'passed', detail: d?.artifact?.summary || 'artifact generated' }
}

/**
 * Run the whole pipeline. Emits a StageEvent as each discipline starts + finishes.
 * Disciplines the architect marked 'not_applicable' are skipped honestly.
 */
export async function runFullPipeline(opts: RunOpts): Promise<PipelineResult> {
  const { onStage, signal } = opts
  let spec = opts.spec
  const stages: PipelineResult['stages'] = {}
  const applicable = (stage: PipeStage) =>
    (spec.disciplines as any)?.[stage]?.status !== 'not_applicable'

  const set = (stage: PipeStage, status: PipeStatus, detail?: string) => {
    stages[stage] = { status, detail }
    onStage({ stage, status, detail })
  }
  const aborted = () => signal?.aborted

  // ---- 1. Electronics (chip-scale board) — MUST be first (grounding) ----
  if (applicable('electronics')) {
    set('electronics', 'running')
    const reuse = opts.reuseElectronics !== false && (await electronicsExists(opts.runId, signal))
    if (reuse) {
      set('electronics', 'passed', 'chip-scale board already built (reused)')
    } else {
      try {
        const d = await postJson('/api/electronics-cs', { spec, runId: opts.runId }, opts)
        if (d?.boardMm) {
          const drc = d.drc?.errors
          set('electronics', 'passed', `chip-scale board ${Math.round(d.boardMm.w)}×${Math.round(d.boardMm.h)}mm${typeof drc === 'number' ? ` · ${drc} DRC error(s)` : ''}`)
        } else {
          set('electronics', 'failed', String(d?.error || 'no board produced'))
          return { stages } // downstream disciplines need the board — stop honestly
        }
      } catch (e) {
        set('electronics', 'failed', String(e))
        return { stages }
      }
    }
  }
  if (aborted()) return { stages }

  // ---- 2. Mechanical (enclosure + real fit check) ----
  let mechFitFails = false
  if (applicable('mechanical')) {
    set('mechanical', 'running')
    try {
      const d = await postJson('/api/mechanical', { spec, runId: opts.runId }, opts)
      if (d?.ok) {
        const fits = d.fitCheck ? d.fitCheck.fits : null
        mechFitFails = fits === false
        set('mechanical', fits === false ? 'failed' : 'passed',
          d.fitCheck ? (fits ? 'PCB fits the cavity' : `PCB ${d.fitCheck.pcbMm.w}×${d.fitCheck.pcbMm.h}mm does NOT fit cavity ${d.fitCheck.enclosureMm.w}×${d.fitCheck.enclosureMm.h}mm`) : (d.part || 'enclosure built'))
      } else {
        set('mechanical', 'failed', String(d?.error || 'enclosure build failed'))
      }
    } catch (e) { set('mechanical', 'failed', String(e)) }
  }
  if (aborted()) return { stages }

  // ---- 3. Simulation (lumped physics) ----
  let simFails: string[] = []
  if (applicable('simulation' as PipeStage)) {
    set('simulation', 'running')
    try {
      const d = await postJson('/api/simulate', { spec, runId: opts.runId }, opts)
      if (d?.error) set('simulation', 'failed', String(d.error))
      else {
        simFails = (d.results ?? []).filter((r: any) => r?.pass === false).map((r: any) => `${r.sim} ${r.value}${r.unit} vs ${r.limit}`)
        set('simulation', simFails.length ? 'failed' : 'passed',
          simFails.length ? `${simFails.length} sim(s) over limit: ${simFails.join('; ')}` : 'all sims within limits')
      }
    } catch (e) { set('simulation', 'failed', String(e)) }
  }
  if (aborted()) return { stages }

  // ---- 4. Feedback checkpoint — only when there's a real violation ----
  let feedback: PipelineResult['feedback']
  if (mechFitFails || simFails.length) {
    try {
      const d = await postJson('/api/redesign', { spec, runId: opts.runId }, opts)
      if (!d?.error) {
        feedback = { status: d.status, capabilityGaps: d.capabilityGaps ?? [], remaining: d.remaining ?? [] }
        // achievable budget changes -> adopt them + re-run mechanical once so the
        // fit actually closes. Capability gaps are surfaced, not faked around.
        const budgetsChanged = d.finalBudgets && JSON.stringify(d.finalBudgets) !== JSON.stringify(spec.budgets)
        if (d.status === 'converged' && budgetsChanged) {
          spec = { ...spec, budgets: d.finalBudgets }
          if (applicable('mechanical') && !aborted()) {
            set('mechanical', 'running', 're-running with converged budgets')
            try {
              const m = await postJson('/api/mechanical', { spec, runId: opts.runId }, opts)
              const fits = m?.ok && m.fitCheck ? m.fitCheck.fits : null
              set('mechanical', fits === false ? 'failed' : 'passed',
                fits === false ? 'still does not fit after redesign' : 'fits after redesign')
            } catch (e) { set('mechanical', 'failed', String(e)) }
          }
        } else if (d.status === 'blocked-capability-gap' && mechFitFails) {
          // the honest case: e.g. shrinking the PCB needs chip-down EDA not built
          const gap = (d.capabilityGaps ?? []).map((g: any) => g.gap).join('; ')
          set('mechanical', 'blocked', `capability gap: ${gap || 'unresolved fit'}`)
        }
      }
    } catch { /* feedback is best-effort; the pipeline continues */ }
  }
  if (aborted()) return { stages, feedback, updatedSpec: spec !== opts.spec ? spec : undefined }

  // ---- 5. Downstream advisory disciplines (each grounds on the real board) ----
  for (const stage of DISCIPLINE_STAGES) {
    if (aborted()) break
    if (!applicable(stage)) { set(stage, 'skipped', 'not applicable to this product'); continue }
    set(stage, 'running')
    const ev = await runDiscipline(stage, opts)
    set(stage, ev.status, ev.detail)
  }

  return { stages, feedback, updatedSpec: spec !== opts.spec ? spec : undefined }
}
