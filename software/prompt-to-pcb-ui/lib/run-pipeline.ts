/**
 * Full-pipeline orchestrator — runs the whole product through every engineering
 * discipline end-to-end, in the order that keeps them connected:
 *
 *   chip-scale electronics → ┬→ mechanical → simulation → [feedback loop]
 *                            └→ firmware ∥ manufacturing ∥ supply chain ∥ validation
 *
 * The two branches after electronics are independent, so they run concurrently;
 * only the ordering INSIDE the mechanical branch is load-bearing (the feedback
 * loop reads the fit result + the sim FAILs).
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
  /** Absolute origin for API calls (e.g. http://127.0.0.1:4500) — REQUIRED when
   *  running server-side (Node fetch rejects relative URLs); '' in the browser. */
  baseUrl?: string
  headers?: Record<string, string>
  signal?: AbortSignal
  onStage: (e: StageEvent) => void
  /** If the chip-scale board already exists, don't rebuild it (~3 min). Default true. */
  reuseElectronics?: boolean
  /** Incremental mode (Phase 2): skip any stage whose recorded inputs hash is
   *  unchanged since it last PASSED. The server decides currency
   *  (/api/runs/stage-hash, gated on FL_INCREMENTAL=1) — with the flag off the
   *  endpoint always answers not-current and behavior is identical to today. */
  dirtyOnly?: boolean
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
  const r = await fetch(`${opts.baseUrl ?? ''}${url}`, { method: 'POST', headers: jsonHeaders(opts.headers), body: JSON.stringify(body), signal: opts.signal })
  return r.json()
}

/** dirtyOnly: ask the server whether a stage's artifact is current. Fail open
 *  (re-run) on any error — skipping must never rest on a guess. */
async function stageIsCurrent(stage: PipeStage, opts: RunOpts): Promise<string | null> {
  if (!opts.dirtyOnly) return null
  try {
    const r = await fetch(
      `${opts.baseUrl ?? ''}/api/runs/stage-hash?run=${encodeURIComponent(opts.runId)}&stage=${stage}`,
      { headers: opts.headers, cache: 'no-store', signal: opts.signal })
    const d = await r.json()
    return d?.current ? String(d.reason ?? 'inputs unchanged') : null
  } catch { return null }
}

/** Record a terminal stage build's inputs hash (server recomputes from disk). */
function recordStageHash(stage: PipeStage, status: PipeStatus, opts: RunOpts) {
  if (status !== 'passed' && status !== 'failed') return
  fetch(`${opts.baseUrl ?? ''}/api/runs/stage-hash`, {
    method: 'POST', headers: jsonHeaders(opts.headers),
    body: JSON.stringify({ runId: opts.runId, stage, status }), keepalive: true,
  }).catch(() => { /* telemetry-grade: never blocks the pipeline */ })
}

/** The persisted chip-scale board for this run (chipscale-board.json), or null. */
async function existingBoard(runId: string, opts: RunOpts): Promise<any | null> {
  try {
    const r = await fetch(`${opts.baseUrl ?? ''}/runs/${runId}/electronics/chipscale-board.json`, { cache: 'no-store', headers: opts.headers, signal: opts.signal })
    if (!r.ok) return null
    const d = await r.json()
    return d?.boardMm?.w && d?.boardMm?.h ? d : null
  } catch { return null }
}

/**
 * Honest electronics verdict: a board only counts as PASSED when the runner
 * says ok AND the real (KiCad) DRC found zero errors AND no nets were left
 * unrouted. A board that exists but is dirty stays persisted + viewable in the
 * Electronics tab — it just must not wear a green check. Works on both the
 * /api/electronics-cs response (has `ok`) and the persisted chipscale-board.json
 * (no `ok` field — derived from drc + drcRepair).
 */
export function electronicsVerdict(d: any): { clean: boolean; detail: string } {
  const w = Math.round(d.boardMm.w), h = Math.round(d.boardMm.h)
  const errs = typeof d?.drc?.errors === 'number' ? d.drc.errors : null
  const unrouted = typeof d?.drcRepair?.unrouted === 'number' ? d.drcRepair.unrouted : 0
  const okKnown = typeof d?.ok === 'boolean'
  const clean = (okKnown ? d.ok === true : d?.drc?.available === true)
    && (errs ?? 1) === 0 && unrouted === 0
  if (clean) return { clean, detail: `chip-scale board ${w}×${h}mm · routed clean, 0 DRC errors` }
  const bits: string[] = []
  if (errs != null && errs > 0) {
    const shorts = d?.drc?.errorTypes?.shorting_items
    bits.push(`${errs} DRC error(s)${shorts ? ` incl. ${shorts} short(s)` : ''}`)
  }
  if (unrouted > 0) bits.push(`${unrouted} net(s) unrouted`)
  if (d?.drcRepair?.converged === false) bits.push('not converged')
  for (const v of d?.pinViolations ?? []) bits.push(String(v)) // Phase 2: violated pins fail loudly
  if (!bits.length) bits.push(errs == null ? 'no real DRC report' : 'runner reported not ok')
  return { clean, detail: `board ${w}×${h}mm built but NOT clean: ${bits.join(', ')} — see Electronics tab` }
}

/**
 * Run one generic discipline module (firmware/mfg/supply/validation).
 * `spec` is passed EXPLICITLY (not read off `opts`) — the redesign loop can
 * produce a converged spec that differs from the one the pipeline was called
 * with, and these docs must describe whichever design is current.
 */
async function runDiscipline(stage: PipeStage, spec: ProductSpec, opts: RunOpts): Promise<StageEvent> {
  const d = await postJson('/api/discipline', { spec, runId: opts.runId, discipline: stage }, opts)
  if (d?.error) return { stage, status: 'failed', detail: String(d.error) }
  return { stage, status: 'passed', detail: d?.artifact?.summary || 'artifact generated' }
}

/** Order-insensitive deep compare, used to tell a real budget change from a re-serialized identical one. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  const ka = Object.keys(a as object), kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) &&
    deepEqual((a as any)[k], (b as any)[k]))
}

/** One attempt at one stage, as wall-clock. A stage re-run (the feedback loop
 *  re-runs mechanical/simulation, and the fork reconciliation re-runs the four
 *  docs) pushes a SECOND entry rather than overwriting the first — the record is
 *  a timeline of attempts, not a map, so nothing is lost. */
export type StageTiming = {
  stage: PipeStage
  startedAt: string
  endedAt?: string
  ms?: number
  status: PipeStatus
  detail?: string
  /** true when the run ended (abort/throw) while this attempt was still running. */
  unfinished?: boolean
}

export type RunTiming = {
  runId: string
  startedAt: string
  finishedAt?: string
  totalMs?: number
  stages: StageTiming[]
}

/**
 * Best-effort wall-clock recorder for the run, persisted to
 * public/runs/<id>/timing.json via /api/runs/timing.
 *
 * Why it exists: per-stage duration was previously only observable in the dev
 * server's stdout, which is orphaned as soon as the server is relaunched — so
 * timing got inferred from filesystem artifacts and the wrong run was watched.
 * This makes the measurement durable and run-scoped instead.
 *
 * It records REAL start/end per attempt, so the two concurrent branches
 * (physical vs. the four docs) show their true OVERLAP — nothing here assumes
 * the stages are sequential. The record is built in memory and posted as a whole
 * snapshot, so the concurrent writers can't clobber each other's entries.
 *
 * Every path is swallowed: telemetry must never break or stall the pipeline.
 */
type RunTimer = ReturnType<typeof createTimer>

function createTimer(runId: string, baseUrl?: string, headers?: Record<string, string>) {
  const t0 = Date.now()
  const startedAt = new Date(t0).toISOString()
  const stages: StageTiming[] = []
  const open = new Map<PipeStage, { entry: StageTiming; at: number }>()
  let finishedAt: string | undefined
  let totalMs: number | undefined

  // Writes are coalesced and strictly serialized: at most one POST is in flight,
  // and a write requested while one is running just re-runs the loop with the
  // fresher snapshot. That keeps the persisted document monotonic (a late write
  // can never land a staler snapshot than an earlier one) and bounds the traffic
  // when four disciplines report at once.
  let inFlight: Promise<void> | null = null
  let again = false

  const snapshot = (): RunTiming => ({ runId, startedAt, finishedAt, totalMs, stages: stages.map((s) => ({ ...s })) })

  const write = (): Promise<void> => {
    if (inFlight) { again = true; return inFlight }
    inFlight = (async () => {
      do {
        again = false
        try {
          // No AbortSignal here on purpose: when the user stops the run we still
          // want the final timing to land. keepalive lets it survive a navigation.
          await fetch(`${baseUrl ?? ''}/api/runs/timing`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(headers ?? {}) },
            body: JSON.stringify(snapshot()),
            keepalive: true,
          })
        } catch { /* telemetry is best-effort — never surface a write failure */ }
      } while (again)
      inFlight = null
    })()
    return inFlight
  }

  /** Mirror of a set() call: 'running' opens an attempt, any other status closes it. */
  const stage = (s: PipeStage, status: PipeStatus, detail?: string) => {
    const now = Date.now()
    const iso = new Date(now).toISOString()
    if (status === 'running') {
      const prev = open.get(s)
      // defensive: a 'running' with no terminal in between shouldn't happen, but
      // if it ever does, close the old attempt rather than leak it.
      if (prev) { prev.entry.endedAt = iso; prev.entry.ms = now - prev.at; prev.entry.unfinished = true }
      const entry: StageTiming = { stage: s, startedAt: iso, status, detail }
      stages.push(entry)
      open.set(s, { entry, at: now })
    } else {
      const cur = open.get(s)
      if (cur) {
        cur.entry.endedAt = iso
        cur.entry.ms = now - cur.at
        cur.entry.status = status
        cur.entry.detail = detail
        open.delete(s)
      } else {
        // a terminal with no 'running' before it (e.g. a 'skipped' discipline) —
        // record it as a zero-duration mark so the stage still appears.
        stages.push({ stage: s, startedAt: iso, endedAt: iso, ms: 0, status, detail })
      }
    }
    void write()
  }

  /** Close the record and flush it. Safe to call on ANY exit — pass, fail, abort, throw. */
  const finish = async () => {
    const now = Date.now()
    const iso = new Date(now).toISOString()
    // Stages still open here never reported a terminal status (the run aborted or
    // threw mid-stage). Keep their status as-is and mark them unfinished rather
    // than invent an outcome — the elapsed time is still worth recording.
    for (const { entry, at } of open.values()) {
      entry.endedAt = iso
      entry.ms = now - at
      entry.unfinished = true
    }
    open.clear()
    finishedAt = iso
    totalMs = now - t0
    try { await write() } catch { /* best-effort */ }
  }

  return { stage, finish }
}

/**
 * Run the whole pipeline. Emits a StageEvent as each discipline starts + finishes.
 * Disciplines the architect marked 'not_applicable' are skipped honestly.
 *
 * Thin wrapper over the stage sequencer purely so per-stage timing is flushed to
 * disk on EVERY exit path — happy path, early return, abort, or throw — via
 * finally. The sequencer's behaviour is untouched.
 */
export async function runFullPipeline(opts: RunOpts): Promise<PipelineResult> {
  const timer = createTimer(opts.runId, opts.baseUrl, opts.headers)
  try {
    return await runPipelineStages(opts, timer)
  } finally {
    await timer.finish()
  }
}

async function runPipelineStages(opts: RunOpts, timer: RunTimer): Promise<PipelineResult> {
  const { onStage, signal } = opts
  let spec = opts.spec
  const stages: PipelineResult['stages'] = {}
  const applicable = (stage: PipeStage) =>
    (spec.disciplines as any)?.[stage]?.status !== 'not_applicable'

  const set = (stage: PipeStage, status: PipeStatus, detail?: string) => {
    stages[stage] = { status, detail }
    // every stage transition already funnels through here, so this is the one
    // place timing has to hook. Guarded: a telemetry fault must never take the
    // pipeline down with it.
    try { timer.stage(stage, status, detail) } catch { /* best-effort */ }
    // Phase 2: terminal statuses record the stage's inputs hash server-side so
    // a later dirtyOnly run can prove the artifact is still current.
    try { recordStageHash(stage, status, opts) } catch { /* best-effort */ }
    onStage({ stage, status, detail })
  }
  const aborted = () => signal?.aborted
  // A user Stop lands here as an AbortError thrown out of fetch. That is not a
  // failure of the stage — report it as 'skipped: stopped by user', never as
  // 'failed' wearing exception text.
  const setCaught = (stage: PipeStage, e: unknown) =>
    aborted() ? set(stage, 'skipped', 'stopped by user') : set(stage, 'failed', String(e))

  // ---- 1. Electronics (chip-scale board) — MUST be first (grounding) ----
  if (applicable('electronics')) {
    set('electronics', 'running')
    const prevRaw = opts.reuseElectronics !== false ? await existingBoard(opts.runId, opts) : null
    // Reuse ONLY a CLEAN persisted board — that one is genuinely done, so the
    // ~3-min re-route would be pure waste. A DIRTY persisted board must NOT short-
    // circuit the stage: re-running electronics is exactly what gives the density-
    // relief GROW (and any router improvement) a chance to fix it. Reusing a dirty
    // board just re-reports the same failure every time, so a rebuild could never
    // converge — overcrowding would never trigger the grow. A dirty board therefore
    // falls through to a real re-route.
    const prev = prevRaw && electronicsVerdict(prevRaw).clean ? prevRaw : null
    if (prev) {
      const v = electronicsVerdict(prev)
      set('electronics', v.clean ? 'passed' : 'failed', `${v.detail} (reused)`)
    } else {
      try {
        const d = await postJson('/api/electronics-cs', { spec, runId: opts.runId }, opts)
        if (d?.boardMm) {
          // Gate on the honest verdict, not mere board existence: 'passed' only
          // when ok AND zero DRC errors. A dirty board is 'failed' with the real
          // numbers up front, but the pipeline CONTINUES — the board is persisted
          // and viewable, downstream artifacts ground on it and are labeled with
          // its DRC state; only the green check is withheld.
          const v = electronicsVerdict(d)
          // AUTO-PARTITION: a board that grew + escalated layers and STILL can't
          // route clean is too dense for one board. Compute the split — partition
          // the netlist along the analog/digital seam, synthesize a board-to-board
          // connector, and gate-verify each half — and surface it as an artifact +
          // recommendation. (Building both halves end-to-end as a 2-board kit needs
          // multi-board run support; this makes the verified split automatic.)
          if (!v.clean) {
            let partNote = ''
            try {
              const pp = await postJson('/api/partition', { runId: opts.runId }, opts) as { split?: string; flex?: { process?: string; rigidFlex?: { flexConductors?: number } } } | null
              if (pp?.split) {
                partNote = ` · auto-partition: split into ${pp.split}`
                const fx = pp.flex?.process
                if (fx === 'rigid_flex' || fx === 'flex') {
                  partNote += ` · recommend RIGID-FLEX (one foldable part, ${pp.flex?.rigidFlex?.flexConductors ?? '?'}-conductor flex ribbon replaces the connectors+cable)`
                }
              }
            } catch { /* partition unavailable — the single-board verdict stands */ }
            set('electronics', 'failed', `${v.detail}${partNote}`)
          } else {
            set('electronics', 'passed', v.detail)
          }
        } else {
          set('electronics', 'failed', String(d?.error || 'no board produced'))
          return { stages } // no board at all — downstream has nothing to ground on, stop honestly
        }
      } catch (e) {
        setCaught('electronics', e)
        return { stages }
      }
    }
  }
  if (aborted()) return { stages }

  // Everything below grounds on the board electronics just built, and splits into
  // two branches that DON'T depend on each other:
  //
  //   A. mechanical → simulation → feedback (internally sequential — redesign
  //      consumes the mechanical fit result + the sim FAILs, so it can't move).
  //   B. the four advisory disciplines (they only need `spec` + the built board).
  //
  // They used to run A-then-B, so B's ~2-min tail sat behind A's ~1-min chain for
  // no reason. Running them concurrently hides the shorter branch entirely. The
  // two branches touch disjoint `stages` keys, so the shared status map + onStage
  // reporting stay correct with both writing at once.
  let mechFitFails = false
  let simFails: string[] = []
  let simGaps: string[] = []
  let feedback: PipelineResult['feedback']

  // ---- Branch A: mechanical → simulation → feedback checkpoint ----
  const physicalBranch = async () => {
    // ---- 2. Mechanical (enclosure + real fit check) ----
    if (applicable('mechanical')) {
      const cur = await stageIsCurrent('mechanical', opts)
      if (cur) {
        set('mechanical', 'passed', `current — ${cur}`)
      } else {
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
      } catch (e) { setCaught('mechanical', e) }
      }
    }
    if (aborted()) return

    // ---- 3. Simulation (lumped physics) ----
    if (applicable('simulation' as PipeStage)) {
      const cur = await stageIsCurrent('simulation', opts)
      if (cur) {
        set('simulation', 'passed', `current — ${cur}`)
      } else {
      set('simulation', 'running')
      try {
        const d = await postJson('/api/simulate', { spec, runId: opts.runId }, opts)
        if (d?.error) set('simulation', 'failed', String(d.error))
        else {
          // Combine raw solver fails with the ROUTER's application-aware verdicts.
          // The router catches fails the raw pass-flag misses (e.g. a 92°C "pass"
          // at the solver's 22°C ambient is a FAIL at the product's 55°C ambient),
          // keyed by analysis so the richer judged description wins.
          const byKind = new Map<string, string>()
          for (const r of (d.results ?? []) as any[])
            if (r?.pass === false) byKind.set(r.sim, `${r.sim} ${r.value}${r.unit} vs ${r.limit}`)
          for (const a of (d.assessment?.assessments ?? []) as any[])
            if (a.verdict === 'fail') byKind.set(a.kind, `${a.kind}: ${a.detail}`)
          simFails = [...byKind.values()]
          // required analyses that could not run — surfaced, never a silent pass
          simGaps = (d.assessment?.gaps ?? []) as string[]
          set('simulation', simFails.length ? 'failed' : 'passed',
            simFails.length ? `${simFails.length} sim(s) fail the application requirement: ${simFails.join('; ')}`
              : (simGaps.length ? `within limits (but ${simGaps.length} required check(s) could not run)` : 'all sims meet application requirements'))
        }
      } catch (e) { setCaught('simulation', e) }
      }
    }
    if (aborted()) return

    // ---- 4. Feedback checkpoint — only when there's a real violation ----
    if (mechFitFails || simFails.length) {
      try {
        const d = await postJson('/api/redesign', { spec, runId: opts.runId }, opts)
        if (!d?.error) {
          feedback = { status: d.status, capabilityGaps: d.capabilityGaps ?? [], remaining: [...(d.remaining ?? []), ...simGaps] }
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
              } catch (e) { setCaught('mechanical', e) }
            }
            // The redesign closed the sim FAILs by changing budgets — re-run the sim
            // with the converged budgets so the tab shows the post-redesign result,
            // not the stale FAIL. (Same fetch/stage-update pattern as stage 3.)
            if (applicable('simulation' as PipeStage) && !aborted()) {
              set('simulation', 'running', 're-running with converged budgets')
              try {
                const s = await postJson('/api/simulate', { spec, runId: opts.runId }, opts)
                if (s?.error) set('simulation', 'failed', String(s.error))
                else {
                  const fails = (s.results ?? []).filter((r: any) => r?.pass === false).map((r: any) => `${r.sim} ${r.value}${r.unit} vs ${r.limit}`)
                  set('simulation', fails.length ? 'failed' : 'passed',
                    fails.length ? `${fails.length} sim(s) still over limit: ${fails.join('; ')}` : 'all sims within limits after redesign')
                }
              } catch (e) { setCaught('simulation', e) }
            }
          } else if (d.status === 'blocked-capability-gap' && mechFitFails) {
            // the honest case: e.g. shrinking the PCB needs chip-down EDA not built
            const gap = (d.capabilityGaps ?? []).map((g: any) => g.gap).join('; ')
            set('mechanical', 'blocked', `capability gap: ${gap || 'unresolved fit'}`)
          }
        }
      } catch { /* feedback is best-effort; the pipeline continues */ }
    }
  }

  // ---- Branch B: downstream advisory disciplines (each grounds on the real board) ----
  // These are INDEPENDENT — firmware, manufacturing, supply chain and validation
  // each read the already-built board and don't depend on one another — so they
  // run CONCURRENTLY instead of sequentially. That collapses the slow tail of the
  // run (four ~1-min LLM calls back-to-back) into roughly one call's time; each
  // reports its own status the moment it lands.
  //
  // Speed/correctness tradeoff: these docs start BEFORE the feedback loop has run,
  // so they are necessarily written against the pre-redesign spec. That's fine in
  // the common case (redesign changes nothing, or never fires) and it's what buys
  // the concurrency. When redesign DOES converge on different budgets, the docs
  // below describe a superseded design — so they get re-run against the converged
  // spec after the fork joins (see the reconciliation step). We pay that cost only
  // when it actually matters.
  //
  // A re-run FAILURE is reported as `failed`, not as a caveated `passed`. The
  // first-pass artifact still sits on disk, but it describes the pre-redesign
  // design and no longer matches the board we built — a stale doc wearing a green
  // check is the one failure mode this product must never ship. `failed` is also
  // what stops compose/page.tsx from marking the discipline "built".
  const staleAfterRerun = (stage: PipeStage, cause?: string) =>
    set(stage, 'failed', `STALE — re-run against the converged budgets failed (${cause ?? 'unknown error'}). The artifact on disk describes the PRE-REDESIGN design and no longer matches the built board; regenerate this discipline before using it.`)

  const disciplineBranch = async (specNow: ProductSpec, isRerun: boolean, note?: string) => {
    await Promise.all(DISCIPLINE_STAGES.map(async (stage) => {
      if (aborted()) return
      if (!applicable(stage)) { set(stage, 'skipped', 'not applicable to this product'); return }
      if (!isRerun) {
        const cur = await stageIsCurrent(stage, opts)
        if (cur) { set(stage, 'passed', `current — ${cur}`); return }
      }
      set(stage, 'running', note)
      try {
        const ev = await runDiscipline(stage, specNow, opts)
        // First-pass behaviour is unchanged; only a failed RE-run is marked stale.
        if (ev.status === 'failed' && isRerun) staleAfterRerun(stage, ev.detail)
        else set(stage, ev.status, ev.detail)
      } catch (e) {
        if (aborted()) set(stage, 'skipped', 'stopped by user') // user Stop, not a failure (and not stale)
        else if (isRerun) staleAfterRerun(stage, String(e))
        else set(stage, 'failed', String(e))
      }
    }))
  }

  await Promise.all([physicalBranch(), disciplineBranch(spec, false)])

  // ---- 5. Reconcile the fork ----
  // Branch B raced Branch A, so it grounded on `opts.spec`. If the feedback loop
  // converged on genuinely different budgets, those four docs now describe a design
  // we superseded — re-run them against the converged spec. Deep compare (not
  // reference equality) so a re-serialized identical budgets object costs nothing.
  const convergedBudgetsDiffer = !deepEqual(opts.spec.budgets, spec.budgets)
  if (convergedBudgetsDiffer && !aborted()) {
    await disciplineBranch(spec, true, 're-running with converged budgets')
  }

  // Stage A (orchestrator roadmap): assemble the shared product state from
  // everything this run persisted. Best-effort — assembly is read-only and
  // must never affect the run result.
  try {
    await fetch(
      `${opts.baseUrl ?? ''}/api/runs/product-state?run=${encodeURIComponent(opts.runId)}`,
      { headers: opts.headers, signal: opts.signal },
    )
  } catch { /* state assembly is evidence, not a gate */ }

  return { stages, feedback, updatedSpec: convergedBudgetsDiffer ? spec : undefined }
}
