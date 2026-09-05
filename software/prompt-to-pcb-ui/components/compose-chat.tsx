'use client'

/**
 * Compose chat — Flux-style conversational panel over the REAL Compose flow:
 *   interview (/api/interview clarifying Q&A)  →  Start  →  live pipeline
 *   (/api/pipeline/run EventSource: design → placement → routing → validation →
 *   ERC → firmware) narrated as a live agent step feed.
 * Threads = runs; "New" starts a fresh interview. Everything shown reflects a
 * real endpoint — the step feed narrates the actual stages/logs, nothing faked.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { llmHeaders, selectedModelId } from '@/components/llm-settings'
import { ModelSelector } from '@/components/model-selector'
import { STAGE_DEFS, STAGE_PREFIX, type StageId, type StageState } from '@/lib/firstlight'
import { Plus, Menu, Loader2, Check, X, Circle, Square, Pencil, AlertTriangle, Minus, Play } from 'lucide-react'
import { boardIntentOf, disciplineRows, type ProductSpec } from '@/lib/product-spec'
import { idBriefSummary, type IdBrief } from '@/lib/id-brief'
import { loadRealBoard } from '@/lib/real-board'
import { logLine } from '@/lib/terminal-log'
import type { PipeStatus } from '@/lib/run-pipeline'

/** Real board footprint handed to Industrial Design so its envelope contains
 *  the achievable geometry (the board is built first, then ID wraps it). */
type GroundBoard = { wMm: number; hMm: number; layers?: number; components?: number }

type Answer = { question: string; answer: string }
type Question = { type: 'question'; question: string; boardClass?: string; hints?: string[] }
// Honest build substitution: a requested part the block library can't build and
// what the builder used instead (e.g. STM32L0 → RP2040). Surfaced so the plan
// never silently promises a part the board doesn't have.
type Substitution = { requested: string; built: string; note: string }
type Spec = { type: 'spec'; boardClass: string; blocks: string[]; summary: string; request: string; layers?: number; substitutions?: Substitution[] }
type Ev = { type: string; id?: StageId; state?: StageState; stage?: StageId; text?: string
  level?: string; spec?: any; runDir?: string; status?: string }
// 'id' = Industrial Design brief (the first stage: form/ergonomics/CMF/envelope).
// 'architect' = product-level decomposition dialogue (one tier below ID). The
// rest are the board build phases.
type Phase = 'idle' | 'id' | 'architect' | 'interview' | 'ready' | 'revReady' | 'building' | 'done' | 'error'

/** Compact one-line summary of the product budgets, for the plan header. */
function budgetLine(ps: ProductSpec): string {
  const b = ps.budgets ?? {}
  const parts: string[] = []
  if (b.unitCostUsd != null) parts.push(`$${b.unitCostUsd} target`)
  if (b.sizeMm?.x) parts.push(`${b.sizeMm.x}×${b.sizeMm.y ?? '?'}×${b.sizeMm.z ?? '?'} mm`)
  if (b.massG != null) parts.push(`${b.massG} g`)
  if (b.power?.batteryMah) parts.push(`${b.power.batteryMah} mAh${b.power.runtimeHours ? ` / ${b.power.runtimeHours} h` : ''}`)
  if (b.volumeUnits) parts.push(`${b.volumeUnits.toLocaleString()} units/yr`)
  return parts.join(' · ')
}

// UTF-8-safe base64 (spec can contain µ, ×, em-dash…) — matches the compose page
function b64(json: string) {
  return btoa(encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16))))
}

export function ComposeChat({ threads, activeId, activeRunId, activeName, newDesign, revisePrefill, onSelectThread, onNew, onRunComplete, onRename, onPrefillConsumed, onIdBrief, onProductSpec, productSpec: productSpecProp, builtDisciplines, pipelineStatus, pipelineRunning, pipelineFeedback, onRunPipeline, onStopPipeline, onProductBuilt }: {
  threads: { id: string; label: string }[]
  activeId: string
  activeRunId?: string   // the real run currently on screen (revisable)
  activeName?: string    // its display name, for the revision context line
  newDesign?: boolean
  revisePrefill?: string // text to drop into the input (e.g. an FL-1 ECO) as a revision
  onSelectThread: (id: string) => void
  onNew: () => void
  onRunComplete: (runDir: string, id: string) => void
  onRename?: (id: string, name: string) => void
  onPrefillConsumed?: () => void
  onIdBrief?: (brief: IdBrief | null) => void // lift the ID brief to the workspace panes
  onProductSpec?: (spec: ProductSpec | null) => void // lift the spec for the Explore stage
  // The page's product spec (rehydrated from disk for a restored run). Chat-local
  // spec wins during a live session; for a run selected after a reload the chat
  // never built a local spec, so this prop keeps the product paths alive: the
  // disciplines panel renders, and a chat message revises the PRODUCT through the
  // architect instead of falling to the destructive legacy /api/revise block-ECO.
  productSpec?: ProductSpec | null
  builtDisciplines?: Record<string, boolean> // discipline modules built this session (their tab produced an artifact)
  // full-pipeline orchestration (lifted from the page): live per-discipline status,
  // the run flag, the feedback-loop outcome, and run/stop controls. Status uses
  // the orchestrator's real PipeStatus union — no shadow string type.
  pipelineStatus?: Record<string, { status: PipeStatus; detail?: string }>
  pipelineRunning?: boolean
  pipelineFeedback?: { status: string; capabilityGaps: { gap: string }[]; remaining: string[] } | null
  onRunPipeline?: () => void
  onStopPipeline?: () => void
  onProductBuilt?: (runId: string) => void // a product's board finished building — start its pipeline
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  // The electronics board actually built (a runDir exists). Kept separate from
  // `phase` so a later Industrial-Design/connection error can't retroactively
  // show "Electronics FAILED" on a board that really built.
  const [boardBuilt, setBoardBuilt] = useState(false)
  const [request, setRequest] = useState('')
  const [answers, setAnswers] = useState<Answer[]>([])
  const [current, setCurrent] = useState<Question | null>(null)
  const [spec, setSpec] = useState<Spec | null>(null)
  const [idBrief, setIdBrief] = useState<IdBrief | null>(null)
  const [groundBoard, setGroundBoard] = useState<GroundBoard | null>(null)
  const [productSpec, setProductSpec] = useState<ProductSpec | null>(null)
  // the runId whose board grounds the in-flight Industrial Design interview, so
  // every /api/industrial-design turn persists the brief to THAT run on disk
  // (otherwise the live session's brief is never saved and the Design tab later
  // regenerates a different one)
  const [idRunId, setIdRunId] = useState<string | null>(null)
  // honest build substitutions from the electronics hand-off (RP2040-only block
  // library etc.), shown in the disciplines panel so the plan never silently
  // promises a part the built board doesn't have.
  const [substitutions, setSubstitutions] = useState<Substitution[]>([])
  const [revSpec, setRevSpec] = useState<{ blocks: string[]; boardClass: string; note: string; request: string } | null>(null)
  const [typed, setTyped] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [stages, setStages] = useState<Record<string, StageState>>({})
  const [logs, setLogs] = useState<{ stage: string; text: string; level?: string }[]>([])
  const [threadsOpen, setThreadsOpen] = useState(false)
  const esRef = useRef<EventSource | null>(null)
  // Product-revision lineage: reviseProduct sets this to the run being revised;
  // buildBoard threads it as &parent= so the run report records ancestry (the
  // legacy startRev path already does this) and Phase-1 tracking can group
  // revisions into one product. Cleared once consumed or on reset/new design.
  const reviseParentRef = useRef<string | null>(null)
  // Phase 3 edit router: a revise message is classified first; downstream-scoped
  // changes offer a TARGETED fork+rebuild (unchanged stages skip as current)
  // with the full architect redesign as the explicit alternative.
  const [editPlan, setEditPlan] = useState<{ message: string; scope: string[]; note: string; estimate: string } | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
  }, [answers, current, spec, logs, phase])
  useEffect(() => () => { esRef.current?.close() }, [])
  // lift the ID brief to the workspace so the center/right panes can show the
  // Industrial Design stage. Keyed on the brief only, so a parent re-render
  // passing a fresh callback cannot loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onIdBrief?.(idBrief) }, [idBrief])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onProductSpec?.(productSpec) }, [productSpec])

  // An FL-1 ECO (or any external revision text) drops straight into the input,
  // pre-filled for review; the user edits if needed and presses Send to revise.
  useEffect(() => {
    if (!revisePrefill) return
    setTyped(revisePrefill)
    taRef.current?.focus()
    onPrefillConsumed?.()
  }, [revisePrefill, onPrefillConsumed])

  // auto-grow the composer with its content: starts at 3 rows (min-height in
  // CSS), grows to ~8 rows (160px), then scrolls internally.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
  }, [typed])

  const ask = useCallback(async (req: string, acc: Answer[]) => {
    setLoading(true); setErr(null)
    try {
      const r = await fetch('/api/interview', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ request: req, answers: acc }),
      })
      const data = await r.json()
      if (data.error) throw new Error(data.error)
      if (data.type === 'spec') { setSpec(data as Spec); setPhase('ready') }
      else { setCurrent(data as Question); setPhase('interview') }
    } catch (e) { setErr(String(e)); setPhase('error') } finally { setLoading(false) }
  }, [])

  function reset() {
    reviseParentRef.current = null
    esRef.current?.close(); esRef.current = null
    setPhase('idle'); setBoardBuilt(false); setRequest(''); setAnswers([]); setCurrent(null); setSpec(null)
    setIdBrief(null); setGroundBoard(null); setProductSpec(null); setIdRunId(null); setRevSpec(null); setTyped(''); setErr(null); setStages({}); setLogs([]); onNew()
  }

  // With a built board on screen (not a fresh +New), a chat message REVISES it.
  const reviseMode = !newDesign && !!activeRunId && (phase === 'idle' || phase === 'done')

  // The product spec this chat operates on: the chat-local one from the live
  // session when present, else the page's rehydrated spec for a restored run.
  const prodSpec = productSpec ?? productSpecProp ?? null

  const revise = useCallback(async (req: string, runId: string) => {
    setLoading(true); setErr(null)
    try {
      const r = await fetch('/api/revise', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ runId, request: req }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      if (d.changed === false) { setErr(d.note || 'No block-level change needed for this request.'); setPhase('idle') }
      else {
        // /api/revise returns the descriptive name as `boardClass` (camelCase);
        // reading `board_class` here silently dropped it, so the run stored an
        // empty boardClass and fell back to the raw request text as its name.
        setRevSpec({ blocks: d.blocks ?? [], boardClass: d.boardClass ?? '', note: d.note ?? '', request: req })
        setPhase('revReady')
      }
    } catch (e) { setErr(String(e)); setPhase('idle') } finally { setLoading(false) }
  }, [])

  function submit() {
    const v = typed.trim(); if (!v) return
    setTyped('')
    // A product is on screen (productSpec set) → a change request revises the
    // PRODUCT through the architect, so it rebuilds through the chip-scale board
    // + disciplines. Without this the message fell to the flroute block-ECO
    // (/api/revise) below, which never sets productSpec, so a revised design
    // silently reverted to the flroute (Pico) reference board with ChipScaleStage
    // and every discipline dark. Legacy flroute-only runs (no productSpec) keep
    // the block-level ECO path.
    if (reviseMode && prodSpec) { setRequest(v); void routeEdit(v) }
    else if (reviseMode && activeRunId) { setRequest(v); revise(v, activeRunId) }
    // Every fresh design enters through the Product Architect, which decides which
    // discipline modules to invoke and builds the real board FIRST. Industrial
    // Design runs AFTER, grounded in that real board (form wraps achievable
    // geometry — no promising a form the electronics can't fit). No toggle.
    else if (phase === 'idle') { setRequest(v); askArchitect(v, []) }
    else if (phase === 'id' && current) {
      const next = [...answers, { question: current.question, answer: v }]
      setAnswers(next); setCurrent(null); askIndustrialDesign(request, next, groundBoard, idRunId ?? activeRunId)
    }
    else if (phase === 'architect' && current) {
      const next = [...answers, { question: current.question, answer: v }]
      setAnswers(next); setCurrent(null); askArchitect(request, next)
    }
    else if (phase === 'interview' && current) {
      const next = [...answers, { question: current.question, answer: v }]
      setAnswers(next); setCurrent(null); ask(request, next)
    }
  }

  function startRev() {
    if (!revSpec || !activeRunId) return
    setPhase('building'); setStages({}); setLogs([])
    const id = `run-${crypto.randomUUID()}`
    const payload = b64(JSON.stringify({ blocks: revSpec.blocks, boardClass: revSpec.boardClass }))
    const mdl = selectedModelId() ? `&model=${encodeURIComponent(selectedModelId())}` : ''
    const url = `/api/pipeline/run?prompt=${encodeURIComponent(revSpec.request)}`
      + `&runId=${encodeURIComponent(id)}&compose=1&spec=${encodeURIComponent(payload)}`
      + `&parent=${encodeURIComponent(activeRunId)}&revNote=${encodeURIComponent(revSpec.note || revSpec.request)}${mdl}`
    const es = new EventSource(url); esRef.current = es
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as Ev
      if (ev.type === 'stage' && ev.id) setStages((s) => ({ ...s, [ev.id!]: ev.state as StageState }))
      else if (ev.type === 'log' && ev.stage && ev.text) {
        logLine({ source: 'build', level: ev.level === 'err' ? 'error' : 'info',
          text: `${ev.stage}: ${ev.text}`, runId: id })
        setLogs((l) => [...l.slice(-60), { stage: ev.stage!, text: ev.text!, level: ev.level }])
      }
      else if (ev.type === 'done') { es.close(); esRef.current = null; setPhase('done'); if (ev.runDir) onRunComplete(ev.runDir, id) }
      else if (ev.type === 'error') { es.close(); esRef.current = null; setErr(ev.text ?? 'pipeline error'); setPhase('error') }
    }
    es.onerror = () => { es.close(); esRef.current = null; setErr('connection lost'); setPhase('error') }
  }

  /** Launch the real board pipeline for a finalized board spec + prompt. Used by
   *  both the manual "Yes, build it" path and the Architect's auto electronics
   *  hand-off, so the two flows share one build code path. */
  function buildBoard(bspec: { blocks: string[]; boardClass: string; layers?: number }, req: string, opts?: { thenId?: boolean; plan?: boolean }) {
    setPhase('building'); setBoardBuilt(false); setStages({}); setLogs([])
    const id = `run-${crypto.randomUUID()}`
    // Stage 0: product builds go through the planner (plan=1) — real parts + the
    // requested MCU family via synth. The route runs planner.run(prompt) itself,
    // so no block spec is sent. Legacy/revise flows keep the compose block path.
    const parent = reviseParentRef.current
    reviseParentRef.current = null
    const lineage = parent ? `&parent=${encodeURIComponent(parent)}&revNote=${encodeURIComponent(req.slice(0, 200))}` : ''
    const mdl = selectedModelId() ? `&model=${encodeURIComponent(selectedModelId())}` : ''
    const base = `/api/pipeline/run?prompt=${encodeURIComponent(req)}&runId=${encodeURIComponent(id)}${lineage}${mdl}`
    const payload = b64(JSON.stringify({ blocks: bspec.blocks, boardClass: bspec.boardClass, ...(bspec.layers ? { layers: bspec.layers } : {}) }))
    const url = opts?.plan
      ? `${base}&plan=1`
      : `${base}&compose=1&spec=${encodeURIComponent(payload)}`
    const es = new EventSource(url); esRef.current = es
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as Ev
      if (ev.type === 'stage' && ev.id) setStages((s) => ({ ...s, [ev.id!]: ev.state as StageState }))
      else if (ev.type === 'log' && ev.stage && ev.text) {
        logLine({ source: 'build', level: ev.level === 'err' ? 'error' : 'info',
          text: `${ev.stage}: ${ev.text}`, runId: id })
        setLogs((l) => [...l.slice(-60), { stage: ev.stage!, text: ev.text!, level: ev.level }])
      }
      else if (ev.type === 'done') {
        es.close(); esRef.current = null; setPhase('done')
        if (ev.runDir) { setBoardBuilt(true); onRunComplete(ev.runDir, id) }
        // product flow: once the real board exists, wrap it with Industrial Design
        // AND kick off the full pipeline for THIS exact run. Signalling the runId
        // here (not via a page effect on selectedRun) avoids a race where the page
        // would fire the pipeline on the previously-selected run.
        if (opts?.thenId && ev.runDir) { startIdFromBoard(ev.runDir, id); onProductBuilt?.(id) }
      } else if (ev.type === 'error') { es.close(); esRef.current = null; setErr(ev.text ?? 'pipeline error'); setPhase('error') }
    }
    es.onerror = () => { es.close(); esRef.current = null; setErr('connection lost'); setPhase('error') }
  }

  function start() {
    if (spec) buildBoard(spec, request)
  }

  /** Product Architect: decompose a product intent into disciplines, then invoke
   *  the specialist modules the decomposition marks as needed. Today only the
   *  electronics module is live — it auto-builds a real board from the electronics
   *  block's boardIntent. Every other required discipline shows honestly as
   *  pending (module not built yet); not_applicable ones are skipped. No toggle:
   *  the decomposition itself decides what runs. */
  async function dispatchProduct(ps: ProductSpec) {
    setProductSpec(ps)
    const elec = ps.disciplines?.electronics
    if (elec?.status !== 'defined') {
      // this product does not need electronics (e.g. a passive enclosure) — no
      // live module to invoke yet, so just show the decomposition.
      setPhase('done')
      return
    }
    // invoke electronics: its boardIntent -> a finalized board spec (force, no
    // second round of questions) -> the real build pipeline.
    setPhase('building'); setStages({}); setLogs([]); setLoading(true); setErr(null)
    try {
      const r = await fetch('/api/interview', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ request: boardIntentOf(ps), answers: [], force: true }),
      })
      const bs = await r.json()
      if (bs.error) throw new Error(bs.error)
      if (bs.type !== 'spec') throw new Error('electronics module could not finalize a board')
      // honest substitutions (e.g. requested STM32L0 → built RP2040): show them on
      // the plan instead of silently building a different part than promised.
      setSubstitutions(Array.isArray(bs.substitutions) ? bs.substitutions : [])
      // build the real board first; Industrial Design wraps it once it exists.
      // Stage 0: go through the planner (plan=1) so the board is real parts + the
      // requested MCU family (STM32/ESP32/nRF…) via synth, not RP2040 blocks.
      buildBoard(bs as Spec, boardIntentOf(ps), { thenId: true, plan: true })
    } catch (e) { setErr(String(e)); setPhase('error') } finally { setLoading(false) }
  }

  /** Industrial Design: runs AFTER the electronics board is built, grounded in
   *  its real footprint (ground). A clarifying interview about form, ergonomics,
   *  CMF, and envelope; the finalized brief wraps the achievable geometry. The
   *  board is already on screen, so a finished brief returns to the 'done' state. */
  async function askIndustrialDesign(req: string, acc: Answer[], ground: GroundBoard | null, runId?: string | null) {
    setLoading(true); setErr(null)
    try {
      // runId makes the route ground on + PERSIST the brief to that run
      // (disciplines/id-brief.json), so the brief that drove the live session is
      // the one the Design tab shows later — not a freshly regenerated one.
      const r = await fetch('/api/industrial-design', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ request: req, answers: acc, realBoard: ground ?? undefined, runId: runId ?? undefined }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      if (d.type === 'brief') {
        setIdBrief(d.brief as IdBrief)
        setCurrent(null); setAnswers([]); setPhase('done')
      } else {
        setCurrent({ type: 'question', question: d.question, boardClass: d.product } as Question)
        setPhase('id')
      }
    } catch (e) { setErr(String(e)); setPhase('error') } finally { setLoading(false) }
  }

  /** After the electronics board finishes, kick off Industrial Design grounded in
   *  its real footprint so the form wraps what was actually built. */
  async function startIdFromBoard(runDir: string, runId: string) {
    const rb = await loadRealBoard(runDir).catch(() => null)
    const ground: GroundBoard | null = rb
      ? { wMm: rb.board.boardSize.wMm, hMm: rb.board.boardSize.hMm, layers: rb.board.layers, components: rb.board.components }
      : null
    setGroundBoard(ground)
    setIdRunId(runId) // later interview turns keep persisting the brief to this run
    setAnswers([]); setCurrent(null)
    // Use a resilient intent: the raw prompt if present, else the product spec's
    // board intent / product name. An empty request here made industrial-design
    // 400 ("empty product intent"), which flipped the whole run to error and
    // showed "Electronics FAILED" even though the board built — and blocked the
    // flow from reaching Industrial Design / Mechanical.
    const intent = request.trim() || (prodSpec ? boardIntentOf(prodSpec) : '') || prodSpec?.product || ''
    if (!intent) { setPhase('done'); return }
    await askIndustrialDesign(intent, [], ground, runId)
  }

  /** Product-tier interview: same shape as the board interview, one level up.
   *  An optional Industrial Design brief can ride along as a constraint (used by
   *  the feedback loop; the first pass runs unconstrained, form comes after). */
  async function askArchitect(req: string, acc: Answer[], brief?: IdBrief) {
    setLoading(true); setErr(null)
    try {
      const r = await fetch('/api/architect', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ request: req, answers: acc, idBrief: brief ?? idBrief ?? undefined }),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      if (d.type === 'spec') { await dispatchProduct(d.spec as ProductSpec) }
      else { setCurrent({ type: 'question', question: d.question, boardClass: d.product } as Question); setPhase('architect') }
    } catch (e) { setErr(String(e)); setPhase('error') } finally { setLoading(false) }
  }

  /** Revise a PRODUCT that's already on screen: layer the change request onto the
   *  current product spec and re-enter the Product Architect, so the revision goes
   *  back through the SAME pipeline that built it — flroute board → chip-scale board
   *  → disciplines — instead of the flroute-only block ECO. The architect decides
   *  whether the change is an incremental edit or (as the LLM already detects) a
   *  genuinely different product, and rebuilds accordingly. A fresh interview may
   *  run; that's honest for a product-level change. */
  /** Phase 3: classify the change; narrow scopes offer a targeted re-run. */
  async function routeEdit(req: string) {
    if (!activeRunId) { reviseProduct(req); return }
    setEditBusy(true)
    try {
      const r = await fetch('/api/runs/targeted', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ runId: activeRunId, message: req, dryRun: true }),
      })
      const d = await r.json()
      if (r.ok && d?.targetable) {
        setEditPlan({ message: req, scope: d.scope ?? [], note: d.note ?? req, estimate: d.estimate ?? '' })
        setEditBusy(false)
        return
      }
    } catch { /* classification is best-effort — full path below */ }
    setEditBusy(false)
    reviseProduct(req)
  }

  async function runTargeted() {
    if (!editPlan || !activeRunId) return
    setEditBusy(true)
    try {
      const r = await fetch('/api/runs/targeted', {
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ runId: activeRunId, message: editPlan.message }),
      })
      const d = await r.json()
      if (!r.ok || !d?.runId) throw new Error(d?.error ?? 'targeted edit failed')
      logLine({ source: 'pipeline', level: 'info', text: `targeted revision started: ${d.note} → re-runs ${(d.scope ?? []).join(', ')}`, runId: d.runId })
      setEditPlan(null)
      // select the fork; its server-side job persists progress to v1-job.json
      onRunComplete(d.runId, d.runId)
      // surface completion honestly in the terminal panel
      const poll = setInterval(async () => {
        try {
          const j = await fetch(`/runs/${d.runId}/v1-job.json`, { cache: 'no-store' }).then((x) => (x.ok ? x.json() : null))
          if (j && (j.status === 'complete' || j.status === 'failed')) {
            clearInterval(poll)
            logLine({ source: 'pipeline', level: j.status === 'complete' ? 'ok' : 'error',
              text: `targeted revision ${j.status}${j.error ? ` — ${j.error}` : ''} (reselect the run to refresh panels)`, runId: d.runId })
          }
        } catch { /* poll is best-effort */ }
      }, 5000)
      setTimeout(() => clearInterval(poll), 15 * 60_000)
    } catch (e) {
      setErr(String(e))
    } finally { setEditBusy(false) }
  }

  function reviseProduct(req: string) {
    if (!prodSpec) return
    reviseParentRef.current = activeRunId || null
    const intent = boardIntentOf(prodSpec)
    const combined =
      `Current product: ${prodSpec.product}.` +
      (prodSpec.description ? ` ${prodSpec.description}` : '') +
      (intent ? ` Electronics so far: ${intent}.` : '') +
      `\n\nRequested change: ${req}`
    setAnswers([]); setCurrent(null)
    askArchitect(combined, [])
  }

  function stop() { esRef.current?.close(); esRef.current = null; setPhase('done') }

  // A brand-new design has no board yet, so show no run name until it builds.
  const activeLabel = newDesign
    ? 'New design'
    : threads.find((t) => t.id === activeId)?.label ?? 'thread'

  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const canRename = !newDesign && !!activeId && !!onRename
  function saveName() {
    const v = editValue.trim()
    if (v && v !== activeLabel && onRename && activeId) onRename(activeId, v)
    setEditing(false)
  }
  const building = phase === 'building'

  const StageIcon = ({ st }: { st: StageState | undefined }) =>
    st === 'passed' ? <Check className="size-3.5 text-emerald-500" />
      : st === 'failed' || st === 'blocked' ? <X className="size-3.5 text-destructive" />
        : st === 'running' ? <Loader2 className="size-3.5 animate-spin text-primary" />
          : <Circle className="size-3 text-muted-foreground/40" />

  return (
    <div className="flex h-full flex-col">
      {/* threads header — 28px IDE sidebar section bar (matches the terminal
          panel header): uppercase mono title + integrated ☰ / rename / New */}
      <div className="relative flex h-7 shrink-0 items-center border-b border-border bg-card/50">
        {editing ? (
          <input autoFocus value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveName(); else if (e.key === 'Escape') setEditing(false) }}
            onBlur={saveName}
            className="mx-1.5 min-w-0 flex-1 border border-primary/50 bg-background px-1.5 py-0.5 font-mono text-[10px] outline-none" />
        ) : (
          <button type="button" onClick={() => setThreadsOpen((v) => !v)}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left hover:bg-secondary/50">
            <Menu className="size-3.5 shrink-0 text-muted-foreground" />
            <span className={cn('min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-wider',
              newDesign ? 'italic text-muted-foreground' : 'text-foreground')}>{activeLabel}</span>
            {/* bare count read like a token/version number — say what it counts */}
            <span className="shrink-0 font-mono text-[9px] text-muted-foreground"
              title={`${threads.length} saved design${threads.length === 1 ? '' : 's'}`}>
              {threads.length} designs
            </span>
          </button>
        )}
        {!editing && canRename && (
          <button type="button" title="rename board"
            onClick={() => { setEditValue(activeLabel); setEditing(true) }}
            className="flex h-full shrink-0 items-center px-1.5 text-muted-foreground hover:text-foreground">
            <Pencil className="size-3" />
          </button>
        )}
        <button type="button" onClick={reset}
          className="flex h-full shrink-0 items-center gap-1 border-l border-border px-2 font-mono text-[10px] uppercase tracking-wider text-primary hover:bg-primary/10">
          <Plus className="size-3" /> New
        </button>

        {threadsOpen && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setThreadsOpen(false)} />
            <div className="absolute left-2 top-full z-30 mt-1 max-h-80 w-64 overflow-y-auto border border-border bg-card p-1 shadow-xl">
              <div className="px-2 py-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">Threads</div>
              {threads.length === 0 && <p className="px-2 py-2 text-[11px] text-muted-foreground">No threads yet — start one with New.</p>}
              {threads.map((t) => (
                <button key={t.id} type="button"
                  onClick={() => { onSelectThread(t.id); setThreadsOpen(false) }}
                  className={cn('flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[11px]',
                    t.id === activeId ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground')}>
                  <span className="min-w-0 flex-1 truncate">{t.label}</span>
                  {t.id === activeId && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* thread body */}
      <div ref={bodyRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-2.5 text-sm">
        {phase === 'idle' && !reviseMode && (
          <p className="text-muted-foreground">
            Describe a product or a board. I&apos;ll decompose it into engineering
            disciplines, build the real board first, then wrap it in an industrial
            design (form, ergonomics, CMF, envelope) grounded in what we actually built.
            <span className="mt-1 block text-[11px]">e.g. &ldquo;invisible AI earbud, sub-$40 BOM, all-day battery&rdquo; · &ldquo;8-probe relay test matrix, RP2040, 24V&rdquo;</span>
          </p>
        )}
        {phase === 'idle' && reviseMode && (
          <p className="text-muted-foreground">
            Describe a change to revise <span className="font-medium text-foreground">{activeName || 'this board'}</span> into a new revision, or click <span className="font-medium">New</span> for a fresh board.
            <span className="mt-1 block text-[11px]">e.g. &ldquo;swap the RP2040 for an STM32&rdquo; · &ldquo;add a pressure sensor&rdquo; · &ldquo;drop the CAN transceiver&rdquo;</span>
          </p>
        )}

        {/* interview turns */}
        {answers.map((a, i) => (
          <div key={i} className="space-y-1.5">
            <div className="rounded-lg rounded-tl-sm bg-secondary/60 px-3 py-2 text-[13px]">{a.question}</div>
            <div className="ml-8 rounded-lg rounded-tr-sm bg-primary/15 px-3 py-2 text-[13px] text-foreground">{a.answer}</div>
          </div>
        ))}
        {current && (
          <div className="rounded-lg rounded-tl-sm bg-secondary/60 px-3 py-2 text-[13px]">
            {current.boardClass && (
              <span className="mb-1 mr-2 inline-block rounded-sm border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary">{current.boardClass}</span>
            )}
            {current.question}
          </div>
        )}
        {loading && <div className="flex items-center gap-2 text-[12px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> thinking…</div>}
        {err && !boardBuilt && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{err}</div>}

        {/* plan ready */}
        {phase === 'ready' && spec && (
          <div className="space-y-2">
            <div className="rounded-lg rounded-tl-sm bg-secondary/60 px-3 py-2 text-[13px]">
              I&apos;ve got a plan ready{spec.boardClass ? ` for a ${spec.boardClass}` : ''}. {spec.summary}
              {spec.blocks?.length ? <span className="mt-1 block font-mono text-[10px] text-muted-foreground">blocks: {spec.blocks.join(' · ')}</span> : null}
            </div>
            <button type="button" onClick={start}
              className="ml-8 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
              Yes, build it →
            </button>
          </div>
        )}

        {/* revision plan ready */}
        {phase === 'revReady' && revSpec && (
          <div className="space-y-2">
            <div className="ml-8 rounded-lg rounded-tr-sm bg-primary/15 px-3 py-2 text-[13px] text-foreground">{revSpec.request}</div>
            <div className="rounded-lg rounded-tl-sm bg-secondary/60 px-3 py-2 text-[13px]">
              Revision of <span className="font-medium">{activeName || 'the board'}</span>: {revSpec.note}
              {revSpec.blocks?.length ? <span className="mt-1 block font-mono text-[10px] text-muted-foreground">new blocks: {revSpec.blocks.join(' · ')}</span> : null}
            </div>
            <div className="ml-8 flex gap-2">
              <button type="button" onClick={startRev}
                className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90">
                Build revision →
              </button>
              <button type="button" onClick={() => { setRevSpec(null); setPhase('done') }}
                className="rounded-md border border-border px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground">
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* industrial design brief — the form the pipeline is building to */}
        {idBrief && (
          <div className="space-y-1.5 rounded-md border border-border p-2.5">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">industrial design</span>
              <Check className="size-3 text-emerald-500" />
            </div>
            <div className="text-[13px] font-semibold text-foreground">{idBrief.product}</div>
            {idBriefSummary(idBrief) && (
              <pre className="whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-muted-foreground">{idBriefSummary(idBrief)}</pre>
            )}
            {idBrief.rationale && <div className="text-[11px] italic text-muted-foreground">{idBrief.rationale}</div>}
          </div>
        )}

        {/* product decomposition — which disciplines the Architect routed to.
            Renders from prodSpec so a restored run (spec rehydrated by the page)
            gets its panel + "run full pipeline" button back, not just live builds. */}
        {prodSpec && (
          <div className="space-y-2 rounded-md border border-border p-2.5">
            <div>
              <div className="text-[13px] font-semibold text-foreground">{prodSpec.product}</div>
              {prodSpec.description && (
                <div className="text-[11px] text-muted-foreground">{prodSpec.description}</div>
              )}
              {budgetLine(prodSpec) && (
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{budgetLine(prodSpec)}</div>
              )}
            </div>
            {/* Honest substitutions: what the RP2040-only block library actually
                built vs. what the plan named, so the disciplines below never
                silently promise a part the board doesn't have. */}
            {substitutions.length > 0 && (
              <div className="space-y-1 rounded-sm border border-amber-500/30 bg-amber-500/5 p-2">
                <div className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wide text-amber-500/90">
                  <AlertTriangle className="size-3" /> built with substitutions
                </div>
                {substitutions.map((s, i) => (
                  <div key={i} className="text-[10px] leading-snug text-muted-foreground">
                    <span className="text-foreground">{s.requested}</span>
                    {' → '}
                    <span className="text-foreground">{s.built}</span>
                    <span className="text-muted-foreground"> — {s.note}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-1.5 border-t border-border pt-1.5">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">disciplines</span>
                {/* Run the WHOLE pipeline end-to-end (or stop it). Auto-runs once
                    after Industrial Design; this re-runs it on demand. */}
                {(onRunPipeline || onStopPipeline) && (
                  pipelineRunning ? (
                    <button type="button" onClick={onStopPipeline}
                      className="ml-auto flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:text-foreground">
                      <Square className="size-2.5" /> stop pipeline
                    </button>
                  ) : (
                    <button type="button" onClick={onRunPipeline} disabled={!activeRunId}
                      className="ml-auto flex items-center gap-1 rounded-sm bg-primary px-1.5 py-0.5 text-[9px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
                      <Play className="size-2.5" /> run full pipeline
                    </button>
                  )
                )}
              </div>
              {disciplineRows(prodSpec)
                .filter((r) => r.status !== 'not_applicable')
                .map((r) => {
                  const isElec = r.discipline === 'electronics'
                  // The full-pipeline orchestrator's live status wins when present;
                  // else fall back to the per-tab built flag / electronics phase.
                  const pipe = pipelineStatus?.[r.discipline]?.status
                  const pipeDetail = pipelineStatus?.[r.discipline]?.detail
                  const st = pipe
                    ? (pipe === 'passed' ? 'built' : pipe === 'running' ? 'building' : pipe)
                    : isElec
                      ? phase === 'building'
                        ? 'building'
                        : builtDisciplines?.electronics // real chip-scale evidence (electronics/chipscale-board.json on disk)
                          ? 'built'
                          : boardBuilt
                            // The EDA/variant reference board built, but the CHIP-SCALE
                            // electronics (what this row reports) hasn't run yet — a
                            // distinct honest state, never 'built'. Also never 'failed'
                            // for a later ID/connection error: the board really exists.
                            ? 'board ready'
                            : phase === 'error'
                              ? 'failed'
                              // restored run (spec from the page, no live build in
                              // flight) or 'done' without a board: NOT built — no
                              // green check without chip-scale evidence, no spinner
                              : 'pending'
                      : builtDisciplines?.[r.discipline] // its tab produced a real artifact
                        ? 'built'
                        : 'pending'
                  const icon =
                    st === 'built' ? <Check className="size-3.5 text-emerald-500" />
                      : st === 'failed' ? <X className="size-3.5 text-destructive" />
                        : st === 'blocked' ? <AlertTriangle className="size-3.5 text-amber-500" />
                          : st === 'skipped' ? <Minus className="size-3 text-muted-foreground/40" />
                            : st === 'building' ? <Loader2 className="size-3.5 animate-spin text-primary" />
                              : st === 'board ready' ? <Circle className="size-3 text-sky-400" />
                                : <Circle className="size-3 text-muted-foreground/40" />
                  return (
                    <div key={r.discipline} className="flex items-start gap-2">
                      <span className="mt-0.5 shrink-0">{icon}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12px] text-foreground">{r.label}</span>
                          <span className={cn('font-mono text-[9px] uppercase tracking-wide',
                            st === 'failed' ? 'text-destructive' : st === 'blocked' ? 'text-amber-500' : 'text-muted-foreground')}>
                            {st === 'pending' ? 'module not built yet'
                              : st === 'board ready' ? 'board ready · chip-scale pending' : st}
                          </span>
                        </div>
                        {/* live detail from the orchestrator (fit result, DRC count,
                            sim outcome), else the static discipline summary */}
                        {(pipeDetail || r.summary) && (
                          <div className="text-[10px] text-muted-foreground">{pipeDetail || r.summary}</div>
                        )}
                      </div>
                    </div>
                  )
                })}
              {/* feedback-loop outcome — honest: converged, or capability gaps */}
              {pipelineFeedback && (
                <div className={cn('mt-1 rounded-sm border px-2 py-1.5 text-[10px]',
                  pipelineFeedback.status === 'converged'
                    ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400'
                    : 'border-amber-500/40 bg-amber-500/5 text-amber-600 dark:text-amber-400')}>
                  <div className="font-medium">feedback loop: {pipelineFeedback.status}</div>
                  {pipelineFeedback.capabilityGaps?.length > 0 && (
                    <div className="mt-0.5 text-muted-foreground">
                      capability gaps (reported, not faked): {pipelineFeedback.capabilityGaps.map((g) => g.gap).join('; ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* live agent step feed */}
        {(building || phase === 'done') && (
          <div className="space-y-1.5 rounded-md border border-border p-2.5">
            {STAGE_DEFS.map((d) => {
              const st = stages[d.id]
              const stageLogs = logs.filter((l) => l.stage === d.id).slice(-4)
              return (
                <div key={d.id}>
                  <div className="flex items-center gap-2">
                    <StageIcon st={st} />
                    <span className={cn('text-[13px]', st === 'running' ? 'font-medium text-foreground' : st ? 'text-foreground' : 'text-muted-foreground/60')}>{d.label}</span>
                  </div>
                  {stageLogs.length > 0 && (
                    <div className="ml-5 mt-0.5 space-y-0.5">
                      {stageLogs.map((l, i) => (
                        <div key={i} className={cn('font-mono text-[10px]', l.level === 'err' ? 'text-destructive' : 'text-muted-foreground')}>
                          {STAGE_PREFIX[l.stage as StageId] ?? l.stage}: {l.text}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* working bar */}
      {building && (
        <div className="flex items-center gap-2 border-t border-border bg-primary/[0.06] px-3 py-2">
          <Loader2 className="size-3.5 animate-spin text-primary" />
          <span className="text-[12px] font-medium text-primary">Compose is working…</span>
          <button type="button" onClick={stop}
            className="ml-auto flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
            <Square className="size-2.5" /> Stop
          </button>
        </div>
      )}

      {/* Phase 3: targeted-edit preview — the cmd-K confirm. Shows exactly what
          will re-run before anything is spent; full redesign stays one click away. */}
      {editPlan && (
        <div className="mx-2 mb-1 rounded-md border border-primary/40 bg-primary/5 p-2.5">
          <div className="text-[11.5px] text-foreground">{editPlan.note}</div>
          <div className="mt-1 font-mono text-[10px] text-muted-foreground">
            will re-run: {editPlan.scope.join(', ')} · est {editPlan.estimate} · everything else stays current
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={runTargeted} disabled={editBusy}
              className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {editBusy ? 'starting…' : 'Targeted revision'}
            </button>
            <button type="button" disabled={editBusy}
              onClick={() => { const m = editPlan.message; setEditPlan(null); reviseProduct(m) }}
              className="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50">
              Full redesign instead
            </button>
            <button type="button" onClick={() => setEditPlan(null)}
              className="ml-auto text-[11px] text-muted-foreground hover:text-foreground">cancel</button>
          </div>
        </div>
      )}
      {editBusy && !editPlan && (
        <div className="mx-2 mb-1 flex items-center gap-2 px-1 font-mono text-[10px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> routing the change…
        </div>
      )}

      {/* input — shrink-0 is load-bearing. Without it the composer is a
          shrinkable flex child, so a tall thread body (product card +
          disciplines) squeezed it until the Send button was clipped under the
          terminal panel and unclickable: the textarea still accepted text and
          Enter still submitted, so it read as "the button does nothing". The
          scrollable thread body above absorbs the squeeze instead. */}
      <div className="shrink-0 border-t border-border p-2">
        <div className="flex flex-col gap-1.5 border border-border bg-background p-2 focus-within:border-primary/50">
          <textarea
            ref={taRef}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
            disabled={building || loading || phase === 'ready' || phase === 'revReady'}
            rows={3}
            placeholder={phase === 'ready' ? 'press “Yes, build it” above'
              : phase === 'revReady' ? 'press “Build revision” above'
                : phase === 'id' || phase === 'architect' || phase === 'interview' ? 'type your answer…'
                  : reviseMode ? 'Describe a change to revise this board…'
                    : phase === 'idle' ? 'Describe a product or a board…' : 'start a new thread with + New'}
            className="max-h-40 min-h-[60px] w-full resize-none overflow-y-auto bg-transparent text-[12px] leading-5 outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />
          <div className="flex items-center justify-between gap-2">
            <ModelSelector />
            <button type="button" onClick={submit} disabled={!typed.trim() || building || loading || phase === 'ready' || phase === 'revReady'}
              className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
              Send ↵
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
