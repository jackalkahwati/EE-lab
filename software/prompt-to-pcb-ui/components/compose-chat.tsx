'use client'

/**
 * Compose chat — Flux-style conversational panel over the REAL Compose flow:
 *   interview (/api/interview clarifying Q&A)  →  Start  →  live pipeline
 *   (/api/pipeline/run EventSource: design → placement → routing → validation →
 *   ERC → firmware) narrated as a live agent step feed.
 * Threads = runs; "New" starts a fresh interview. Everything shown reflects a
 * real endpoint — the step feed narrates the actual stages/logs, nothing faked.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Menu as ThreadMenu } from '@base-ui/react/menu'
import { archiveComposeTurns, canSubmitCompose, createComposeOperations, createComposeSessionCache, settleComposeStages, type ComposeHistorySection, type ComposeOperation } from '@/lib/compose-session'
import { cn } from '@/lib/utils'
import { llmHeaders, selectedModelId } from '@/components/llm-settings'
import { ModelSelector } from '@/components/model-selector'
import { AstraBetaStatus, readAstraPreferenceBlocker, useAstraAvailability } from '@/components/astra-beta-status'
import { astraBuildUrl, astraGenerationBlocker, astraTemplateRequest, astraWorkflowHeaders, beginAstraWorkflow, cancelAstraWorkflow } from '@/lib/astra-client'
import { ASTRA_DESIGN_TEMPLATE } from '@/lib/astra-design-contract'
import { STAGE_DEFS, STAGE_PREFIX, type StageId, type StageState } from '@/lib/firstlight'
import { Plus, Menu, Loader2, Check, X, Circle, Square, Pencil, AlertTriangle, Minus, Play } from 'lucide-react'
import { boardIntentOf, disciplineRows, type ProductSpec } from '@/lib/product-spec'
import { idBriefSummary, type IdBrief } from '@/lib/id-brief'
import { loadRealBoard } from '@/lib/real-board'
import { logLine } from '@/lib/terminal-log'
import { workspaceStageLabel, type WorkspacePipeline, type WorkspaceHistoryState } from '@/lib/workspace-state'

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
  level?: string; spec?: any; runDir?: string; status?: string; message?: string; scope?: string }
// 'id' = Industrial Design brief (the first stage: form/ergonomics/CMF/envelope).
// 'architect' = product-level decomposition dialogue (one tier below ID). The
// rest are the board build phases.
type ChatStageState = StageState | 'disconnected' | 'unreported'
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

type ComposeChatProps = {
  /** Identity of the conversation, NOT its run. Keep stable on draft promotion. */
  sessionKey?: string
  onBusyChange?: (busy: boolean) => void
  threads: { id: string; label: string }[]
  activeId: string
  activeRunId?: string   // the real run currently on screen (revisable)
  activeName?: string    // its display name, for the revision context line
  newDesign?: boolean
  revisePrefill?: string // text to drop into the input (e.g. an FL-1 ECO) as a revision
  onSelectThread: (id: string) => void
  onNew: () => void
  onRunComplete: (runDir: string, id: string, metadataRequired?: boolean) => void
  onArtifactsChanged?: (id: string) => void
  onRetryMetadata?: () => void
  /** Fired the moment a build BEGINS, before anything exists on disk. The page
   *  only ever heard about a run when it COMPLETED, so a build that started and
   *  failed left the page believing no run existed at all — and it rendered the
   *  fresh-install blank slate over a design that had just failed. */
  onRunStart?: (runId: string) => void
  /** A started run has ended badly. The page keeps the run — with its error —
   *  instead of letting it evaporate back into the blank slate. */
  onRunFailed?: (runId: string, detail: string, outcome?: 'failed' | 'disconnected', scope?: 'initial' | 'targeted') => void
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
  // Shared live or restored attempt evidence. Artifact availability is separate.
  pipelineStatus?: WorkspacePipeline
  pipelineHistoryState?: WorkspaceHistoryState
  pipelineRunning?: boolean
  generationDisabled?: boolean
  canStartGeneration?: () => boolean
  pipelineFeedback?: { status: string; capabilityGaps: { gap: string }[]; remaining: string[] } | null
  onRunPipeline?: () => void
  onStopPipeline?: () => void
  onProductBuilt?: (runId: string) => void // a product's board finished building — start its pipeline
}

type Retry =
  | { kind: 'architect'; req: string; answers: Answer[]; brief?: IdBrief }
  | { kind: 'interview'; req: string; answers: Answer[] }
  | { kind: 'id'; req: string; answers: Answer[]; ground: GroundBoard | null; runId?: string | null }
  | { kind: 'dispatch'; spec: ProductSpec }
  | { kind: 'revise'; req: string; runId: string }
  | { kind: 'route'; req: string }
  | { kind: 'targeted' }
  | { kind: 'metadata' }
  | { kind: 'build'; spec: Spec; req: string; opts?: BuildOptions; parent?: string | null }
  | { kind: 'revision-build' }
type BuildOptions = { thenId?: boolean; plan?: boolean; intent?: string }
type SessionSnapshot = {
  phase: Phase; boardBuilt: boolean; request: string; answers: Answer[]; current: Question | null
  spec: Spec | null; idBrief: IdBrief | null; groundBoard: GroundBoard | null; productSpec: ProductSpec | null
  idRunId: string | null; substitutions: Substitution[]
  revSpec: { blocks: string[]; boardClass: string; note: string; request: string } | null
  typed: string; err: string | null; stages: Record<string, ChatStageState>
  logs: { stage: string; text: string; level?: string }[]
  editPlan: { message: string; scope: string[]; note: string; estimate: string } | null
  retry: Retry | null; reviseParent: string | null; history: ComposeHistorySection[]
  astraWorkflowId: string | null; astraTerminal: boolean; astraDetail: string | null; astraCancelRequested: boolean
}

export function ComposeChat(props: ComposeChatProps) {
  const [cache] = useState(() => createComposeSessionCache<SessionSnapshot>())
  const [legacyNew, setLegacyNew] = useState(0)
  const key = props.sessionKey ?? `legacy:${legacyNew}`
  return <ComposeSession key={key} {...props} initial={cache.get(key)}
    saveSnapshot={(snapshot) => cache.set(key, snapshot)}
    onNew={() => { if (!props.sessionKey) setLegacyNew((n) => n + 1); props.onNew() }} />
}

function ComposeSession({ threads, activeId, activeRunId, activeName, newDesign, revisePrefill, onSelectThread, onNew, onRunComplete, onArtifactsChanged, onRetryMetadata, onRunStart, onRunFailed, onRename, onPrefillConsumed, onIdBrief, onProductSpec, productSpec: productSpecProp, builtDisciplines, pipelineStatus, pipelineHistoryState = 'none', pipelineRunning, generationDisabled, canStartGeneration, pipelineFeedback, onRunPipeline, onStopPipeline, onProductBuilt, onBusyChange, initial, saveSnapshot }: ComposeChatProps & {
  initial?: SessionSnapshot
  saveSnapshot: (snapshot: SessionSnapshot) => void
}) {
  const [phase, setPhase] = useState<Phase>(initial?.phase ?? 'idle')
  // The electronics board actually built (a runDir exists). Kept separate from
  // `phase` so a later Industrial-Design/connection error can't retroactively
  // show "Electronics FAILED" on a board that really built.
  const [boardBuilt, setBoardBuilt] = useState(initial?.boardBuilt ?? false)
  const [request, setRequest] = useState(initial?.request ?? '')
  const [answers, setAnswers] = useState<Answer[]>(initial?.answers ?? [])
  const [history, setHistory] = useState<ComposeHistorySection[]>(initial?.history ?? [])
  const [current, setCurrent] = useState<Question | null>(initial?.current ?? null)
  const [spec, setSpec] = useState<Spec | null>(initial?.spec ?? null)
  const [idBrief, setIdBrief] = useState<IdBrief | null>(initial?.idBrief ?? null)
  const [groundBoard, setGroundBoard] = useState<GroundBoard | null>(initial?.groundBoard ?? null)
  const [productSpec, setProductSpec] = useState<ProductSpec | null>(initial?.productSpec ?? null)
  // the runId whose board grounds the in-flight Industrial Design interview, so
  // every /api/industrial-design turn persists the brief to THAT run on disk
  // (otherwise the live session's brief is never saved and the Design tab later
  // regenerates a different one)
  const [idRunId, setIdRunId] = useState<string | null>(initial?.idRunId ?? null)
  // honest build substitutions from the electronics hand-off (RP2040-only block
  // library etc.), shown in the disciplines panel so the plan never silently
  // promises a part the built board doesn't have.
  const [substitutions, setSubstitutions] = useState<Substitution[]>(initial?.substitutions ?? [])
  const [revSpec, setRevSpec] = useState<{ blocks: string[]; boardClass: string; note: string; request: string } | null>(initial?.revSpec ?? null)
  const [typed, setTyped] = useState(initial?.typed ?? '')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(initial?.err ?? null)
  const [stages, setStages] = useState<Record<string, ChatStageState>>(initial?.stages ?? {})
  const [logs, setLogs] = useState<{ stage: string; text: string; level?: string }[]>(initial?.logs ?? [])
  const [threadsOpen, setThreadsOpen] = useState(false)
  const esRef = useRef<EventSource | null>(null)
  const observedRunRef = useRef<string | null>(null)
  // Product-revision lineage: reviseProduct sets this to the run being revised;
  // buildBoard threads it as &parent= so the run report records ancestry (the
  // legacy startRev path already does this) and Phase-1 tracking can group
  // revisions into one product. Cleared once consumed or on reset/new design.
  const reviseParentRef = useRef<string | null>(initial?.reviseParent ?? null)
  // Phase 3 edit router: a revise message is classified first; downstream-scoped
  // changes offer a TARGETED fork+rebuild (unchanged stages skip as current)
  // with the full architect redesign as the explicit alternative.
  const [editPlan, setEditPlan] = useState<{ message: string; scope: string[]; note: string; estimate: string } | null>(initial?.editPlan ?? null)
  const [editBusy, setEditBusy] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const [retry, setRetry] = useState<Retry | null>(initial?.retry ?? null)
  const astra = useAstraAvailability()
  // Separate selection never replaces an unrelated draft or submits on mount.
  const [astraTemplateId, setAstraTemplateId] = useState<string | null>(null)
  const [astraWorkflowId, setAstraWorkflowId] = useState<string | null>(initial?.astraWorkflowId ?? null)
  const astraWorkflowRef = useRef(astraWorkflowId)
  const [astraTerminal, setAstraTerminal] = useState(initial?.astraTerminal ?? false)
  const astraTerminalRef = useRef(astraTerminal)
  const [astraDetail, setAstraDetail] = useState<string | null>(initial?.astraDetail ?? null)
  const [astraCancelling, setAstraCancelling] = useState(false)
  const astraCancelPending = useRef(false)
  const astraCancelRequested = useRef(initial?.astraCancelRequested ?? false)
  const astraRequestOperation = useRef<ComposeOperation | null>(null)
  const beta = astra.beta || !!astraWorkflowId
  const generationBlocker = astra.generationBlocker || (beta && !newDesign && !!activeRunId && (phase === 'idle' || phase === 'done') ? 'Astra beta does not revise restored runs. Choose New for an electronics-only request.' : null)
  const [operationBusy, setOperationBusy] = useState(false)
  const [liveUpdates, setLiveUpdates] = useState(false)
  const retryingRef = useRef(false)
  const latest = useRef({ onBusyChange, pipelineRunning, generationDisabled, canStartGeneration, onRunComplete, onArtifactsChanged, onRetryMetadata, onRunStart, onRunFailed, onProductBuilt, onIdBrief, onProductSpec })
  useLayoutEffect(() => { latest.current = { onBusyChange, pipelineRunning, generationDisabled, canStartGeneration, onRunComplete, onArtifactsChanged, onRetryMetadata, onRunStart, onRunFailed, onProductBuilt, onIdBrief, onProductSpec } })
  const [operations] = useState(() => createComposeOperations((value) => {
    setOperationBusy(value)
    latest.current.onBusyChange?.(value || !!latest.current.pipelineRunning)
  }))
  const streamOperation = useRef<ComposeOperation | null>(null)
  const pollCleanup = useRef<(() => void) | null>(null)
  const busy = operationBusy || loading || editBusy || astraCancelling || !!pipelineRunning || !!generationDisabled
  const isBusy = () => operations.busy || astraCancelPending.current || !!latest.current.pipelineRunning || !!latest.current.generationDisabled || latest.current.canStartGeneration?.() === false
  function allowGeneration() {
    const blocker = astraGenerationBlocker(astra.availability, beta ? readAstraPreferenceBlocker() : null)
      || generationBlocker || (beta && astraCancelRequested.current ? 'This workflow was cancelled. Start a new design explicitly.' : null)
    if (blocker) { setErr(blocker); astra.refreshPreferences(); return false }
    return true
  }
  function generationHeaders() {
    if (!beta) return { 'content-type': 'application/json', ...llmHeaders() }
    const blocker = readAstraPreferenceBlocker()
    if (blocker) throw new Error(blocker)
    return astraWorkflowHeaders(astraWorkflowRef.current ?? '')
  }
  useLayoutEffect(() => {
    operations.activate()
    return () => {
      esRef.current?.close()
      pollCleanup.current?.()
      operations.dispose()
    }
  }, [operations])
  useLayoutEffect(() => {
    latest.current.onBusyChange?.(operations.busy || !!pipelineRunning)
  }, [operations, pipelineRunning])
  useLayoutEffect(() => {
    saveSnapshot({ phase: phase === 'building' ? 'error' : phase, boardBuilt, request, answers, current,
      spec, idBrief, groundBoard, productSpec, idRunId, substitutions, revSpec, typed,
      err: phase === 'building' ? 'Live updates were disconnected. The server may still be working; inspect the run before starting another build.' : err,
      stages: phase === 'building' ? settleComposeStages(stages, 'disconnected') : stages,
      logs, editPlan, retry, history, reviseParent: reviseParentRef.current,
      astraWorkflowId, astraTerminal, astraDetail, astraCancelRequested: astraCancelRequested.current })
  })

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })
  }, [answers, current, spec, logs, phase])
  // lift the ID brief to the workspace so the center/right panes can show the
  // Industrial Design stage. Keyed on the brief only, so a parent re-render
  // passing a fresh callback cannot loop.
  useEffect(() => { if (idBrief) latest.current.onIdBrief?.(idBrief) }, [idBrief])
  useEffect(() => { if (productSpec) latest.current.onProductSpec?.(productSpec) }, [productSpec])

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

  async function ask(req: string, acc: Answer[]) {
    if (!allowGeneration()) return
    const op = operations.begin()
    if (beta) astraRequestOperation.current = op
    const submitted = retryingRef.current ? undefined : typed
    setLoading(true); setErr(null); setRetry(null)
    try {
      const r = await fetch('/api/interview', {
        signal: op.signal,
        method: 'POST', headers: generationHeaders(),
        body: JSON.stringify({ request: req, answers: acc }),
      })
      const data = await r.json()
      if (!op.current()) return
      if (beta && astraCancelRequested.current) return
      if (!r.ok || data.error) throw new Error(data.error ?? 'Interview request failed')
      acceptInput(submitted)
      setAnswers(acc)
      if (data.type === 'spec') { setCurrent(null); setSpec(data as Spec); setPhase('ready') }
      else { setCurrent(data as Question); setPhase('interview') }
    } catch (e) {
      if (op.current() && !astraCancelRequested.current) { setErr(String(e)); setRetry(beta ? null : { kind: 'interview', req, answers: acc }); setPhase('error') }
    } finally { if (op.current()) setLoading(false); op.finish() }
  }

  function reset() {
    if (isBusy()) return
    onNew()
  }

  function acceptInput(submitted: string | undefined) {
    if (submitted !== undefined) setTyped((value) => value === submitted ? '' : value)
  }

  // With a built board on screen (not a fresh +New), a chat message REVISES it.
  const reviseMode = !newDesign && !!activeRunId && (phase === 'idle' || phase === 'done')

  // The product spec this chat operates on: the chat-local one from the live
  // session when present, else the page's rehydrated spec for a restored run.
  const prodSpec = productSpec ?? productSpecProp ?? null

  async function revise(req: string, runId: string) {
    const op = operations.begin()
    const submitted = retryingRef.current ? undefined : typed
    setLoading(true); setErr(null); setRetry(null)
    try {
      const r = await fetch('/api/revise', {
        signal: op.signal,
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ runId, request: req }),
      })
      const d = await r.json()
      if (!op.current()) return
      if (!r.ok || d.error) throw new Error(d.error ?? 'Revision request failed')
      if (d.changed === false) { setErr(d.note || 'No block-level change needed for this request.'); setPhase('idle') }
      else {
        // /api/revise returns the descriptive name as `boardClass` (camelCase);
        // reading `board_class` here silently dropped it, so the run stored an
        // empty boardClass and fell back to the raw request text as its name.
        acceptInput(submitted)
        setRevSpec({ blocks: d.blocks ?? [], boardClass: d.boardClass ?? '', note: d.note ?? '', request: req })
        setPhase('revReady')
      }
    } catch (e) {
      if (op.current()) { setErr(String(e)); setRetry({ kind: 'revise', req, runId }); setPhase('idle') }
    } finally { if (op.current()) setLoading(false); op.finish() }
  }

  function submit() {
    if (beta) {
      if (isBusy() || editPlan || phase !== 'idle' || reviseMode || !allowGeneration()) return
      if (astraTemplateId !== ASTRA_DESIGN_TEMPLATE.id) { setErr('Select the BME280 template explicitly. Other drafts are not submitted in this beta.'); return }
      setRequest(ASTRA_DESIGN_TEMPLATE.prompt)
      void askArchitect(ASTRA_DESIGN_TEMPLATE.prompt, [])
      return
    }
    const v = typed.trim()
    if (!v || isBusy() || editPlan || !canSubmitCompose(phase, reviseMode, !!current) || !allowGeneration()) return
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
      askIndustrialDesign(request, next, groundBoard, idRunId ?? activeRunId)
    }
    else if (phase === 'architect' && current) {
      const next = [...answers, { question: current.question, answer: v }]
      askArchitect(request, next)
    }
    else if (phase === 'interview' && current) {
      const next = [...answers, { question: current.question, answer: v }]
      ask(request, next)
    }
  }

  function startRev() {
    if (beta || !revSpec || !activeRunId || isBusy() || !allowGeneration()) return
    setErr(null); setRetry({ kind: 'revision-build' })
    setPhase('building'); setBoardBuilt(false); setStages({}); setLogs([])
    const id = `run-${crypto.randomUUID()}`
    const payload = b64(JSON.stringify({ blocks: revSpec.blocks, boardClass: revSpec.boardClass }))
    const mdl = selectedModelId() ? `&model=${encodeURIComponent(selectedModelId())}` : ''
    const url = `/api/pipeline/run?prompt=${encodeURIComponent(revSpec.request)}`
      + `&runId=${encodeURIComponent(id)}&compose=1&spec=${encodeURIComponent(payload)}`
      + `&parent=${encodeURIComponent(activeRunId)}&revNote=${encodeURIComponent(revSpec.note || revSpec.request)}${mdl}`
    const es = openBuildStream(url, id); esRef.current = es
    if (!es) return
    const op = streamOperation.current!
    es.onmessage = (e) => {
      if (!op.current()) return
      let ev: Ev
      try { ev = JSON.parse(e.data) as Ev } catch { failBuild(es, op, id, 'Invalid build update; the server may still be working.', 'disconnected'); return }
      if (ev.type === 'stage' && ev.id) setStages((s) => ({ ...s, [ev.id!]: ev.state as StageState }))
      else if (ev.type === 'log' && ev.stage && ev.text) {
        logLine({ source: 'build', level: ev.level === 'err' ? 'error' : 'info',
          text: `${ev.stage}: ${ev.text}`, runId: id })
        setLogs((l) => [...l.slice(-60), { stage: ev.stage!, text: ev.text!, level: ev.level }])
      }
      else if (ev.type === 'done') {
        es.close(); esRef.current = null; setLiveUpdates(false); setPhase('done'); setRetry(null)
        setStages((previous) => settleComposeStages(previous, 'unreported'))
        if (ev.runDir) { setBoardBuilt(true); latest.current.onRunComplete(ev.runDir, id) }
        op.finish()
      }
      else if (ev.type === 'error') failBuild(es, op, id, ev.text ?? ev.message ?? 'pipeline error')
    }
    es.onerror = () => { if (op.current()) failBuild(es, op, id, 'Connection lost before the build finished. The server may still be working; inspect this run before retrying.', 'disconnected') }
  }

  /** Launch the real board pipeline for a finalized board spec + prompt. Used by
   *  both the manual "Yes, build it" path and the Architect's auto electronics
   *  hand-off, so the two flows share one build code path. */
  function buildBoard(bspec: { blocks: string[]; boardClass: string; layers?: number }, req: string, opts?: BuildOptions) {
    if (!allowGeneration()) { setPhase('error'); return }
    if (beta && (!astraWorkflowRef.current || astraTerminalRef.current)) { setErr('Start a new Astra workflow with an explicit request.'); setPhase('error'); return }
    setErr(null)
    setPhase('building'); setBoardBuilt(false); setStages({}); setLogs([])
    const id = `run-${crypto.randomUUID()}`
    // Stage 0: product builds go through the planner (plan=1) — real parts + the
    // requested MCU family via synth. The route runs planner.run(prompt) itself,
    // so no block spec is sent. Legacy/revise flows keep the compose block path.
    const parent = reviseParentRef.current
    reviseParentRef.current = null
    setRetry(beta ? null : { kind: 'build', spec: { ...bspec, type: 'spec', summary: '', request: req }, req, opts, parent })
    const lineage = parent ? `&parent=${encodeURIComponent(parent)}&revNote=${encodeURIComponent(req.slice(0, 200))}` : ''
    const mdl = selectedModelId() ? `&model=${encodeURIComponent(selectedModelId())}` : ''
    const base = `/api/pipeline/run?prompt=${encodeURIComponent(req)}&runId=${encodeURIComponent(id)}${lineage}${mdl}`
    const payload = b64(JSON.stringify({ blocks: bspec.blocks, boardClass: bspec.boardClass, ...(bspec.layers ? { layers: bspec.layers } : {}) }))
    const url = beta ? astraBuildUrl(id, astraWorkflowRef.current!) : opts?.plan
      ? `${base}&plan=1`
      : `${base}&compose=1&spec=${encodeURIComponent(payload)}`
    const es = openBuildStream(url, id); esRef.current = es
    if (!es) return
    const op = streamOperation.current!
    es.onmessage = (e) => {
      if (!op.current()) return
      let ev: Ev
      try { ev = JSON.parse(e.data) as Ev } catch { failBuild(es, op, id, 'Invalid build update; the server may still be working.', 'disconnected'); return }
      if (ev.type === 'stage' && ev.id) setStages((s) => ({ ...s, [ev.id!]: ev.state as StageState }))
      else if (ev.type === 'log' && ev.stage && ev.text) {
        logLine({ source: 'build', level: ev.level === 'err' ? 'error' : 'info',
          text: `${ev.stage}: ${ev.text}`, runId: id })
        setLogs((l) => [...l.slice(-60), { stage: ev.stage!, text: ev.text!, level: ev.level }])
      }
      else if (ev.type === 'done') {
        es.close(); esRef.current = null; setLiveUpdates(false); setPhase('done'); setRetry(null)
        setStages((previous) => settleComposeStages(previous, 'unreported'))
        if (beta) {
          astraTerminalRef.current = true; setAstraTerminal(true)
          const passed = ev.scope === 'electronics-only' && ev.status === 'PASSED'
          const detail = ev.scope !== 'electronics-only' || !['PASSED', 'GATE FAILED'].includes(ev.status ?? '')
            ? 'Astra returned an unrecognized terminal result. Inspect this run before starting another workflow.'
            : `Electronics-only: ${ev.status}. Other disciplines were not run.`
          setAstraDetail(detail)
          if (ev.runDir) { setBoardBuilt(true); latest.current.onRunComplete(ev.runDir, id) }
          if (!passed) { setErr(detail); setPhase('error'); latest.current.onRunFailed?.(id, detail) }
        } else if (ev.runDir) { setBoardBuilt(true); latest.current.onRunComplete(ev.runDir, id) }
        // product flow: once the real board exists, wrap it with Industrial Design
        // AND kick off the full pipeline for THIS exact run. Signalling the runId
        // here (not via a page effect on selectedRun) avoids a race where the page
        // would fire the pipeline on the previously-selected run.
        if (!beta && opts?.thenId && ev.runDir && op.current()) {
          void startIdFromBoard(ev.runDir, id, opts.intent || req)
          latest.current.onProductBuilt?.(id)
        }
        op.finish()
      } else if (ev.type === 'error') failBuild(es, op, id, ev.text ?? ev.message ?? 'pipeline error')
    }
    es.onerror = () => { if (op.current()) failBuild(es, op, id, 'Connection lost before the build finished. The server may still be working; inspect this run before retrying.', 'disconnected') }
  }

  function start() {
    if (spec && !isBusy()) buildBoard(spec, request)
  }

  /** Product Architect: decompose a product intent into disciplines, then invoke
   *  the specialist modules the decomposition marks as needed. Today only the
   *  electronics module is live — it auto-builds a real board from the electronics
   *  block's boardIntent. Every other required discipline shows honestly as
   *  pending (module not built yet); not_applicable ones are skipped. No toggle:
   *  the decomposition itself decides what runs. */
  async function dispatchProduct(ps: ProductSpec) {
    setProductSpec(ps)
    if (beta) {
      // Architect already persisted the native specification for this workflow.
      // No legacy interview, planner, ID or discipline continuation is permitted.
      buildBoard({ blocks: [], boardClass: ps.product }, boardIntentOf(ps))
      return
    }
    const elec = ps.disciplines?.electronics
    if (elec?.status !== 'defined') {
      // this product does not need electronics (e.g. a passive enclosure) — no
      // live module to invoke yet, so just show the decomposition.
      setPhase('done')
      return
    }
    // invoke electronics: its boardIntent -> a finalized board spec (force, no
    // second round of questions) -> the real build pipeline.
    const op = operations.begin()
    setPhase('building'); setStages({}); setLogs([]); setLoading(true); setErr(null); setRetry(null)
    try {
      const r = await fetch('/api/interview', {
        signal: op.signal,
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ request: boardIntentOf(ps), answers: [], force: true }),
      })
      const bs = await r.json()
      if (!op.current()) return
      if (!r.ok || bs.error) throw new Error(bs.error ?? 'Electronics handoff failed')
      if (bs.type !== 'spec') throw new Error('electronics module could not finalize a board')
      // honest substitutions (e.g. requested STM32L0 → built RP2040): show them on
      // the plan instead of silently building a different part than promised.
      setSubstitutions(Array.isArray(bs.substitutions) ? bs.substitutions : [])
      // build the real board first; Industrial Design wraps it once it exists.
      // Stage 0: go through the planner (plan=1) so the board is real parts + the
      // requested MCU family (STM32/ESP32/nRF…) via synth, not RP2040 blocks.
      buildBoard(bs as Spec, boardIntentOf(ps), { thenId: true, plan: true, intent: ps.description || boardIntentOf(ps) || ps.product })
    } catch (e) {
      if (op.current()) { setErr(String(e)); setRetry({ kind: 'dispatch', spec: ps }); setPhase('error') }
    } finally { if (op.current()) setLoading(false); op.finish() }
  }

  /** Industrial Design: runs AFTER the electronics board is built, grounded in
   *  its real footprint (ground). A clarifying interview about form, ergonomics,
   *  CMF, and envelope; the finalized brief wraps the achievable geometry. The
   *  board is already on screen, so a finished brief returns to the 'done' state. */
  async function askIndustrialDesign(req: string, acc: Answer[], ground: GroundBoard | null, runId?: string | null) {
    if (beta || !allowGeneration()) return
    const op = operations.begin()
    const submitted = retryingRef.current ? undefined : typed
    setLoading(true); setErr(null); setRetry(null)
    try {
      // runId makes the route ground on + PERSIST the brief to that run
      // (disciplines/id-brief.json), so the brief that drove the live session is
      // the one the Design tab shows later — not a freshly regenerated one.
      const r = await fetch('/api/industrial-design', {
        signal: op.signal,
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ request: req, answers: acc, realBoard: ground ?? undefined, runId: runId ?? undefined }),
      })
      const d = await r.json()
      if (!op.current()) return
      if (!r.ok || d.error) throw new Error(d.error ?? 'Industrial Design request failed')
      acceptInput(submitted)
      setAnswers(acc)
      if (d.type === 'brief') {
        setIdBrief(d.brief as IdBrief)
        setHistory((previous) => archiveComposeTurns(previous, 'Industrial Design', acc))
        setCurrent(null); setAnswers([]); setPhase('done')
      } else {
        setCurrent({ type: 'question', question: d.question, boardClass: d.product } as Question)
        setPhase('id')
      }
    } catch (e) {
      if (op.current()) { setErr(String(e)); setRetry({ kind: 'id', req, answers: acc, ground, runId }); setPhase('error') }
    } finally { if (op.current()) setLoading(false); op.finish() }
  }

  /** After the electronics board finishes, kick off Industrial Design grounded in
   *  its real footprint so the form wraps what was actually built. */
  async function startIdFromBoard(runDir: string, runId: string, intent: string) {
    // This read does not accept AbortSignal; the fence still rejects its result.
    const op = operations.begin()
    setLoading(true)
    try {
      const rb = await loadRealBoard(runDir).catch(() => null)
      if (!op.current()) return
      const ground: GroundBoard | null = rb
        ? { wMm: rb.board.boardSize.wMm, hMm: rb.board.boardSize.hMm, layers: rb.board.layers, components: rb.board.components }
        : null
      setGroundBoard(ground)
      setIdRunId(runId)
      setAnswers([]); setCurrent(null)
      if (!intent.trim()) { setPhase('done'); return }
      await askIndustrialDesign(intent, [], ground, runId)
    } finally { if (op.current()) setLoading(false); op.finish() }
  }

  /** Product-tier interview: same shape as the board interview, one level up.
   *  An optional Industrial Design brief can ride along as a constraint (used by
   *  the feedback loop; the first pass runs unconstrained, form comes after). */
  async function askArchitect(req: string, acc: Answer[], brief?: IdBrief) {
    if (!allowGeneration()) return
    let betaRequest: ReturnType<typeof astraTemplateRequest> | null = null
    if (beta) {
      try { betaRequest = astraTemplateRequest(astraTemplateId, req) }
      catch (reason) { setErr(reason instanceof Error ? reason.message : 'Select the supported template.'); return }
      if (acc.length || brief) { setErr('This fixed template does not accept additional interview answers or design briefs.'); return }
    }
    const op = operations.begin()
    if (beta) astraRequestOperation.current = op
    const submitted = beta || retryingRef.current ? undefined : typed
    setLoading(true); setErr(null); setRetry(null)
    try {
      // Only this explicit input path begins a workflow; mounting/status never does.
      if (beta && !astraWorkflowRef.current) {
        const workflowId = await beginAstraWorkflow(fetch, op.signal)
        if (!op.current()) return
        astraWorkflowRef.current = workflowId; setAstraWorkflowId(workflowId)
        astraTerminalRef.current = false; setAstraTerminal(false); setAstraDetail(null)
      }
      if (beta && astraCancelRequested.current) return
      const r = await fetch('/api/architect', {
        signal: op.signal,
        method: 'POST', headers: generationHeaders(),
        body: JSON.stringify(betaRequest ?? { request: req, answers: acc, idBrief: brief ?? idBrief ?? undefined }),
      })
      const d = await r.json()
      if (!op.current()) return
      if (beta && astraCancelRequested.current) return
      if (!r.ok || d.error) throw new Error(d.error ?? 'Product Architect request failed')
      acceptInput(submitted)
      setAnswers(acc)
      if (d.type === 'spec') {
        // Archive the accepted turns here, not in the later SSE closure, which
        // may still capture pre-interview answers. ID starts a new protocol.
        setHistory((previous) => archiveComposeTurns(previous, 'Product Architect', acc))
        setAnswers([]); setCurrent(null); await dispatchProduct(d.spec as ProductSpec)
      }
      else if (beta) throw new Error('The fixed template did not return a specification. No free-form interview or board build was started.')
      else { setCurrent({ type: 'question', question: d.question, boardClass: d.product } as Question); setPhase('architect') }
    } catch (e) {
      if (op.current() && !astraCancelRequested.current) { setErr(String(e)); setRetry(beta ? null : { kind: 'architect', req, answers: acc, brief }); setPhase('error') }
    } finally { if (op.current()) setLoading(false); op.finish() }
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
    const op = operations.begin()
    const submitted = retryingRef.current ? undefined : typed
    setEditBusy(true); setErr(null); setRetry(null)
    try {
      const r = await fetch('/api/runs/targeted', {
        signal: op.signal,
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ runId: activeRunId, message: req, dryRun: true }),
      })
      const d = await r.json()
      if (!op.current()) return
      if (!r.ok || d?.error) throw new Error(d?.error ?? 'Change classification failed')
      if (d?.targetable) {
        acceptInput(submitted)
        setEditPlan({ message: req, scope: d.scope ?? [], note: d.note ?? req, estimate: d.estimate ?? '' })
        return
      }
      // A successful classification can choose the existing full product path.
      // A failed request must not silently launch a different paid operation.
      reviseProduct(req)
    } catch (e) {
      if (op.current()) { setErr(String(e)); setRetry({ kind: 'route', req }) }
    } finally { if (op.current()) setEditBusy(false); op.finish() }
  }

  async function runTargeted() {
    if (beta || !allowGeneration()) return
    if (!editPlan || !activeRunId || isBusy()) return
    const op = operations.begin()
    let observing = false
    setEditBusy(true); setErr(null); setRetry(null)
    try {
      const r = await fetch('/api/runs/targeted', {
        signal: op.signal,
        method: 'POST', headers: { 'content-type': 'application/json', ...llmHeaders() },
        body: JSON.stringify({ runId: activeRunId, message: editPlan.message }),
      })
      const d = await r.json()
      if (!op.current()) return
      if (!r.ok || typeof d?.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(d.runId)) throw new Error(d?.error ?? 'targeted edit failed')
      logLine({ source: 'pipeline', level: 'info', text: `targeted revision started: ${d.note} → re-runs ${(d.scope ?? []).join(', ')}`, runId: d.runId })
      setEditPlan(null); setPhase('building')
      // A targeted fork owns a patched persisted spec. Never keep the ancestor's
      // chat-local copy as precedence over the newly selected run's state.
      setProductSpec(null)
      latest.current.onProductSpec?.(null)
      latest.current.onRunComplete(`/runs/${d.runId}`, d.runId, true)
      const adoptForkSpec = async () => {
        const signal = AbortSignal.any([op.signal, AbortSignal.timeout(10000)])
        const response = await fetch(`/runs/${encodeURIComponent(d.runId)}/product-spec.json`, { cache: 'no-store', signal })
        if (!response.ok) throw new Error('The revised product specification is unavailable.')
        const next: unknown = await response.json()
        signal.throwIfAborted()
        if (!next || typeof next !== 'object' || !('product' in next) || typeof next.product !== 'string' || !('disciplines' in next) || !next.disciplines || typeof next.disciplines !== 'object' || Array.isArray(next.disciplines)) throw new Error('The revised product specification is invalid.')
        if (op.current()) {
          setProductSpec(next as ProductSpec)
          latest.current.onProductSpec?.(next as ProductSpec)
        }
      }
      try { await adoptForkSpec() } catch { if (op.current()) setErr('The revised specification is not available yet. Waiting for this revision; no new job has been submitted.') }
      if (!op.current()) return
      observing = true
      observedRunRef.current = d.runId
      setLiveUpdates(true)
      let timer: ReturnType<typeof setTimeout>
      const deadline = Date.now() + 15 * 60_000
      const cleanup = () => { clearTimeout(timer); op.finish() }
      pollCleanup.current = cleanup
      const poll = async () => {
        if (!op.current()) return
        try {
          const j = await fetch(`/runs/${d.runId}/v1-job.json`, { cache: 'no-store', signal: AbortSignal.any([op.signal, AbortSignal.timeout(10000)]) }).then((x) => (x.ok ? x.json() : null))
          if (!op.current()) return
          if (j && (j.status === 'complete' || j.status === 'failed')) {
            // The job is terminal even if its metadata read fails. Never poll
            // the paid job again merely to recover a read-only specification.
            latest.current.onArtifactsChanged?.(d.runId)
            if (j.status === 'failed') { setErr(j.error || 'Targeted revision failed'); latest.current.onRunFailed?.(d.runId, j.error || 'Targeted revision failed', 'failed', 'targeted') }
            {
              setProductSpec(null); latest.current.onProductSpec?.(null)
              try {
                await adoptForkSpec()
                if (!op.current()) return
                if (j.status === 'complete') { latest.current.onRunComplete(`/runs/${d.runId}`, d.runId, true); setErr(null) }
              } catch {
                if (!op.current()) return
                setErr('Revision finished, but its saved specification could not be read. Retry metadata; this does not generate anything.')
                setRetry({ kind: 'metadata' })
              }
            }
            if (!op.current()) return
            setLiveUpdates(false); setPhase(j.status === 'complete' ? 'done' : 'idle')
            logLine({ source: 'pipeline', level: j.status === 'complete' ? 'ok' : 'error',
              text: `targeted revision ${j.status}${j.error ? ` — ${j.error}` : ''}`, runId: d.runId })
            cleanup(); pollCleanup.current = null
            return
          }
        } catch { /* Read-only observation can retry; the paid action never does. */ }
        if (!op.current()) return
        if (Date.now() >= deadline) {
          const detail = 'Stopped waiting for targeted revision updates. The server may still be working; inspect the run before retrying.'
          setLiveUpdates(false); setPhase('error'); setErr(detail)
          latest.current.onRunFailed?.(d.runId, detail, 'disconnected', 'targeted')
          cleanup(); pollCleanup.current = null
        } else timer = setTimeout(poll, 5000)
      }
      timer = setTimeout(poll, 5000)
    } catch (e) {
      if (op.current()) { setErr(`${String(e)}. The request may have reached the server; check your runs before retrying.`); setRetry({ kind: 'targeted' }) }
    } finally {
      if (op.current()) setEditBusy(false)
      if (!observing) op.finish()
    }
  }

  function reviseProduct(req: string) {
    if (beta || !prodSpec || !allowGeneration()) return
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

  /**
   * Open a build stream, and tell the page the run EXISTS before it does.
   *
   * There are two build paths and only one of them reported. The plan-mode
   * path — what a NEW design actually uses — opened its EventSource directly,
   * so the page never learned the run existed and rendered the fresh-install
   * slate over a design showing "Electronics FAILED": "No run yet" in the
   * rail, "Describe a board on the left" in the centre, "no run" in the status
   * bar. That is the precise bug step 2 was meant to fix, still reachable
   * through the path step 2 missed.
   *
   * Never call `new EventSource` for a build directly. Both paths go through
   * here so they cannot diverge again.
   */
  function openBuildStream(url: string, id: string): EventSource | null {
    const op = operations.begin()
    streamOperation.current = op
    observedRunRef.current = id
    setLiveUpdates(true)
    latest.current.onRunStart?.(id)
    try { return new EventSource(url) }
    catch (e) {
      setLiveUpdates(false); setErr(String(e)); setPhase('error'); latest.current.onRunFailed?.(id, String(e), 'disconnected'); op.finish()
      return null
    }
  }

  function failBuild(es: EventSource, op: ComposeOperation, id: string, detail: string, outcome: 'failed' | 'disconnected' = 'failed') {
    if (!op.current()) return
    es.close(); esRef.current = null; setLiveUpdates(false)
    setStages((previous) => settleComposeStages(previous, outcome))
    setErr(detail); setPhase('error')
    latest.current.onRunFailed?.(id, detail, outcome)
    op.finish()
  }

  async function cancelAstra() {
    const workflowId = astraWorkflowRef.current
    if (!workflowId || astraTerminalRef.current || astraCancelPending.current) return
    astraCancelPending.current = true; astraCancelRequested.current = true
    setAstraCancelling(true); setRetry(null)
    const op = operations.begin()
    try {
      const detail = await cancelAstraWorkflow(fetch, workflowId, op.signal)
      if (!op.current() || astraWorkflowRef.current !== workflowId) return
      // A terminal SSE may win this race; keep its run evidence and outcome.
      if (!astraTerminalRef.current) {
        astraTerminalRef.current = true; setAstraTerminal(true)
        esRef.current?.close(); esRef.current = null; setLiveUpdates(false)
        streamOperation.current?.finish(); streamOperation.current = null
        astraRequestOperation.current?.finish(); astraRequestOperation.current = null
        setLoading(false); setPhase('error')
        setStages((previous) => settleComposeStages(previous, 'disconnected'))
        setErr('Workflow cancellation acknowledged. Start a new design only when you choose to. In-flight provider work may still incur charges.')
        if (observedRunRef.current) latest.current.onRunFailed?.(observedRunRef.current, detail, 'disconnected')
      }
      setAstraDetail(`${detail} In-flight provider work may still incur charges.`)
    } catch (reason) {
      if (op.current()) setAstraDetail(`${String(reason)} Cancellation is not confirmed; inspect the run or request cancellation again. In-flight provider work may still incur charges.`)
    } finally {
      if (op.current()) { astraCancelPending.current = false; setAstraCancelling(false) }
      op.finish()
    }
  }

  function stop() {
    if (!liveUpdates) return
    const detail = 'Live updates disconnected. This does not cancel server execution. The server may still be working; inspect the run before starting another build.'
    if (observedRunRef.current) latest.current.onRunFailed?.(observedRunRef.current, detail, 'disconnected')
    esRef.current?.close(); esRef.current = null; setLiveUpdates(false)
    pollCleanup.current?.(); pollCleanup.current = null
    streamOperation.current?.finish(); streamOperation.current = null
    setStages((previous) => settleComposeStages(previous, 'disconnected'))
    setPhase('error')
    setErr(detail)
  }

  const retryLabel = retry?.kind === 'metadata' ? 'Retry saved metadata' : retry?.kind === 'id' ? 'Retry Industrial Design'
    : retry?.kind === 'build' || retry?.kind === 'revision-build' ? 'Start a new build'
      : retry?.kind === 'dispatch' ? 'Retry electronics handoff'
        : retry?.kind === 'targeted' ? 'Retry targeted revision'
          : retry?.kind === 'route' ? 'Retry change classification'
            : retry?.kind === 'revise' ? 'Retry revision plan' : 'Retry this interview step'

  function retryFailed() {
    if (!retry || (retry.kind === 'metadata' ? operations.busy : isBusy() || beta || !allowGeneration())) return
    // Descriptors are data, not closures retained from a previous selection.
    const action = retry
    retryingRef.current = true
    try { switch (action.kind) {
      case 'architect': void askArchitect(action.req, action.answers, action.brief); break
      case 'interview': void ask(action.req, action.answers); break
      case 'id': void askIndustrialDesign(action.req, action.answers, action.ground, action.runId); break
      case 'dispatch': void dispatchProduct(action.spec); break
      case 'revise': void revise(action.req, action.runId); break
      case 'route': void routeEdit(action.req); break
      case 'targeted': void runTargeted(); break
      case 'metadata': latest.current.onRetryMetadata?.(); setRetry(null); setErr(null); break
      case 'build': reviseParentRef.current = action.parent ?? null; buildBoard(action.spec, action.req, action.opts); break
      case 'revision-build': startRev(); break
    } } finally { retryingRef.current = false }
  }

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

  const StageIcon = ({ st }: { st: ChatStageState | undefined }) =>
    st === 'passed' ? <Check className="size-3.5 text-emerald-500" />
      : st === 'disconnected' ? <Circle className="size-3.5 text-amber-500" />
      : st === 'failed' || st === 'blocked' ? <X className="size-3.5 text-destructive" />
        : st === 'running' ? <Loader2 className="size-3.5 animate-spin text-primary" />
          : <Circle className="size-3 text-muted-foreground/40" />

  return (
    <div className="flex h-full flex-col">
      {/* threads header — 28px IDE sidebar section bar (matches the terminal
          panel header): uppercase mono title + integrated ☰ / rename / New */}
      <ThreadMenu.Root open={threadsOpen} onOpenChange={setThreadsOpen}>
      <div className="relative flex h-9 shrink-0 items-center border-b border-border bg-card/50">
        {editing ? (
          <input autoFocus aria-label="Design name" value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveName(); else if (e.key === 'Escape') setEditing(false) }}
            onBlur={saveName}
            className="mx-1.5 min-w-0 flex-1 border border-primary/50 bg-background px-1.5 py-0.5 font-mono text-[10px] outline-none" />
        ) : (
          <ThreadMenu.Trigger disabled={busy} aria-label="Switch design conversation"
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left hover:bg-secondary/50">
            <Menu className="size-3.5 shrink-0 text-muted-foreground" />
            <span className={cn('min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-wider',
              newDesign ? 'italic text-muted-foreground' : 'text-foreground')}>{activeLabel}</span>
            {/* bare count read like a token/version number — say what it counts */}
            <span className="shrink-0 font-mono text-[9px] text-muted-foreground"
              title={`${threads.length} saved design${threads.length === 1 ? '' : 's'}`}>
              {threads.length} designs
            </span>
          </ThreadMenu.Trigger>
        )}
        {!editing && canRename && (
          <button type="button" title="Rename board" aria-label="Rename board" disabled={busy}
            onClick={() => { setEditValue(activeLabel); setEditing(true) }}
            className="flex h-full shrink-0 items-center px-1.5 text-muted-foreground hover:text-foreground">
            <Pencil className="size-3" />
          </button>
        )}
        <button type="button" onClick={reset} disabled={busy} title={busy ? 'Wait for the current operation before starting a new design' : 'New design'}
          className="flex h-full shrink-0 items-center gap-1 border-l border-border px-2 font-mono text-[10px] uppercase tracking-wider text-primary hover:bg-primary/10">
          <Plus className="size-3" /> New
        </button>

        <ThreadMenu.Portal>
          <ThreadMenu.Positioner sideOffset={4} align="start" className="z-50">
            <ThreadMenu.Popup aria-label="Design conversations" className="max-h-80 w-64 overflow-y-auto rounded-md border border-border bg-card p-1 shadow-xl outline-none">
              <ThreadMenu.Group>
                <ThreadMenu.GroupLabel className="px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">Threads</ThreadMenu.GroupLabel>
                {threads.length === 0 && <p className="px-2 py-2 text-[11px] text-muted-foreground">No threads yet. Start one with New.</p>}
                {threads.map((t) => (
                  <ThreadMenu.Item key={t.id} disabled={busy}
                    onClick={() => { if (!isBusy()) { onSelectThread(t.id); setThreadsOpen(false) } }}
                    className={cn('flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-2 text-left text-[12px] outline-none data-[highlighted]:bg-secondary data-[disabled]:opacity-40',
                      t.id === activeId ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground')}>
                    <span className="min-w-0 flex-1 truncate">{t.label}</span>
                    {t.id === activeId && <Check aria-label="Current design" className="size-3 shrink-0 text-primary" />}
                  </ThreadMenu.Item>
                ))}
              </ThreadMenu.Group>
            </ThreadMenu.Popup>
          </ThreadMenu.Positioner>
        </ThreadMenu.Portal>
      </div>
      </ThreadMenu.Root>

      <AstraBetaStatus availability={astra.availability} preferenceBlocker={astra.preferenceBlocker}
        retryStatus={astra.retryStatus} workflowId={astraWorkflowId} cancelling={astraCancelling}
        terminal={astraTerminal} detail={astraDetail} onCancel={() => void cancelAstra()} />
      {beta && phase === 'idle' && !reviseMode && <section aria-label="Supported native design template" className="shrink-0 border-b border-border p-3 text-xs">
        <h3 className="font-medium">{ASTRA_DESIGN_TEMPLATE.title}</h3>
        <p className="mt-1">24 × 18 mm · two layers · external regulated 3.3V · I2C address 0x76</p>
        <p className="mt-2 text-muted-foreground">{ASTRA_DESIGN_TEMPLATE.notice}</p>
        <details className="mt-2"><summary className="cursor-pointer">Review the exact request sent to Astra</summary><p className="mt-2 whitespace-pre-wrap leading-relaxed">{ASTRA_DESIGN_TEMPLATE.prompt}</p></details>
        <button type="button" disabled={busy || !!generationBlocker} aria-pressed={astraTemplateId === ASTRA_DESIGN_TEMPLATE.id}
          onClick={() => { setAstraTemplateId(value => value === ASTRA_DESIGN_TEMPLATE.id ? null : ASTRA_DESIGN_TEMPLATE.id); setErr(null) }}
          className="mt-3 rounded border border-border px-2 py-1 disabled:opacity-40">{astraTemplateId === ASTRA_DESIGN_TEMPLATE.id ? 'Template selected (click to deselect)' : 'Select this template'}</button>
        <p className="mt-2 text-muted-foreground">Selection does not submit or change your draft. Press Generate this BME280 breakout below to start.</p>
      </section>}

      {/* thread body */}
      <div ref={bodyRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-2.5 text-sm">
        {phase === 'idle' && !reviseMode && (
          <p className="text-muted-foreground">
            {beta ? <>This beta supports only the explicit BME280 breakout template below. Other requests are not converted. Industrial design and other disciplines are not run.</>
              : <>Describe a product or a board. I&apos;ll decompose it into engineering
                disciplines, build the real board first, then wrap it in an industrial
                design (form, ergonomics, CMF, envelope) grounded in what we actually built.</>}
            <span className="mt-1 block text-[11px]">e.g. &ldquo;invisible AI earbud, sub-$40 BOM, all-day battery&rdquo; · &ldquo;8-probe relay test matrix, RP2040, 24V&rdquo;</span>
          </p>
        )}
        {phase === 'idle' && reviseMode && (
          <p className="text-muted-foreground">
            Describe a change to revise <span className="font-medium text-foreground">{activeName || 'this board'}</span> into a new revision, or click <span className="font-medium">New</span> for a fresh board.
            <span className="mt-1 block text-[11px]">e.g. &ldquo;swap the RP2040 for an STM32&rdquo; · &ldquo;add a pressure sensor&rdquo; · &ldquo;drop the CAN transceiver&rdquo;</span>
          </p>
        )}

        {/* Archived turns are display-only; never sent as ID interview answers. */}
        {history.map((section, index) => (
          <section key={index} aria-label={`${section.label} conversation`} className="space-y-1.5">
            <h3 className="border-b border-border pb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{section.label}</h3>
            {section.turns.map((a, i) => (
              <div key={i} className="space-y-1.5">
                <div className="rounded-lg rounded-tl-sm bg-secondary/60 px-3 py-2 text-[13px]">{a.question}</div>
                <div className="ml-8 rounded-lg rounded-tr-sm bg-primary/15 px-3 py-2 text-[13px] text-foreground">{a.answer}</div>
              </div>
            ))}
          </section>
        ))}
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
        {err && <div id="compose-chat-error" role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {boardBuilt && <p className="font-medium">{beta ? 'Board artifacts are available for inspection. Check the electronics result below.' : 'The board is available. A later step needs attention.'}</p>}
          <p>{err}</p>
          {retry && (!beta || retry.kind === 'metadata') && <>
            <p className="text-[11px] text-muted-foreground">{retry.kind === 'metadata' ? 'Retry only reads the saved specification. It does not generate anything.' : <>Retry runs only this step. It may use model credits{['build', 'revision-build', 'dispatch', 'targeted'].includes(retry.kind) ? ' and start a new build' : ''}. It will not run until you choose it.</>}</p>
            <button type="button" disabled={retry.kind === 'metadata' ? operations.busy : busy} onClick={retryFailed} className="rounded border border-destructive/40 px-2 py-1 font-medium disabled:opacity-40">{retryLabel}</button>
          </>}
        </div>}

        {/* plan ready */}
        {phase === 'ready' && spec && (
          <div className="space-y-2">
            <div className="rounded-lg rounded-tl-sm bg-secondary/60 px-3 py-2 text-[13px]">
              I&apos;ve got a plan ready{spec.boardClass ? ` for a ${spec.boardClass}` : ''}. {spec.summary}
              {spec.blocks?.length ? <span className="mt-1 block font-mono text-[10px] text-muted-foreground">blocks: {spec.blocks.join(' · ')}</span> : null}
            </div>
            <button type="button" onClick={start} disabled={busy || !!generationBlocker}
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
              <button type="button" onClick={startRev} disabled={busy || beta || !!generationBlocker}
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
                {!beta && (onRunPipeline || onStopPipeline) && (
                  pipelineRunning ? (
                    <button type="button" onClick={onStopPipeline}
                      className="ml-auto flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground hover:text-foreground">
                      <Square className="size-2.5" /> stop pipeline
                    </button>
                  ) : (
                    <button type="button" onClick={() => { if (!isBusy() && allowGeneration()) onRunPipeline?.() }} disabled={!activeRunId || busy || !!generationBlocker}
                      className="ml-auto flex items-center gap-1 rounded-sm bg-primary px-1.5 py-0.5 text-[9px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
                      <Play className="size-2.5" /> run full pipeline
                    </button>
                  )
                )}
              </div>
              {disciplineRows(prodSpec)
                .filter((r) => r.status !== 'not_applicable')
                .map((r) => {
                  const pipe = pipelineStatus?.[r.discipline]?.status
                  const pipeDetail = pipelineStatus?.[r.discipline]?.detail
                  const st = pipe === 'passed' ? 'built' : pipe === 'running' ? 'building' : pipe
                  const available = builtDisciplines?.[r.discipline] || (r.discipline === 'electronics' && boardBuilt)
                  const label = workspaceStageLabel(pipe, pipelineHistoryState)
                  const icon =
                    st === 'built' ? <Check className="size-3.5 text-emerald-500" />
                      : st === 'failed' ? <X className="size-3.5 text-destructive" />
                        : st === 'blocked' ? <AlertTriangle className="size-3.5 text-amber-500" />
                          : st === 'skipped' ? <Minus className="size-3 text-muted-foreground/40" />
                            : st === 'building' ? <Loader2 className="size-3.5 animate-spin text-primary" />
                              : <Circle className="size-3 text-muted-foreground/40" />
                  return (
                    <div key={r.discipline} className="flex items-start gap-2">
                      <span className="mt-0.5 shrink-0">{icon}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12px] text-foreground">{r.label}</span>
                          <span className={cn('font-mono text-[9px] uppercase tracking-wide',
                            st === 'failed' ? 'text-destructive' : st === 'blocked' ? 'text-amber-500' : 'text-muted-foreground')}>
                            {beta && r.discipline !== 'electronics' ? 'Not run in Astra beta' : <>{label}{available ? ' · artifact available' : ''}</>}
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
        {(building || Object.keys(stages).length > 0) && (
          <div className="space-y-1.5 rounded-md border border-border p-2.5">
            {STAGE_DEFS.map((d) => {
              const st = stages[d.id]
              const stageLogs = logs.filter((l) => l.stage === d.id).slice(-4)
              return (
                <div key={d.id}>
                  <div className="flex items-center gap-2">
                    <StageIcon st={st} />
                    <span className={cn('text-[13px]', st === 'running' ? 'font-medium text-foreground' : st ? 'text-foreground' : 'text-muted-foreground/60')}>{d.label}</span>
                    {st === 'disconnected' && <span className="text-[10px] text-amber-500">Updates disconnected</span>}
                    {st === 'unreported' && <span className="text-[10px] text-amber-500">Result not reported</span>}
                    {st === 'failed' && <span className="text-[10px] text-destructive">Failed</span>}
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
          {liveUpdates && <button type="button" onClick={stop}
            className="ml-auto flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
            <Square className="size-2.5" /> Disconnect updates
          </button>}
        </div>
      )}

      {/* Phase 3: targeted-edit preview — the cmd-K confirm. Shows exactly what
          will re-run before anything is spent; full redesign stays one click away. */}
      {!beta && editPlan && (
        <div className="mx-2 mb-1 rounded-md border border-primary/40 bg-primary/5 p-2.5">
          <div className="text-[11.5px] text-foreground">{editPlan.note}</div>
          <div className="mt-1 font-mono text-[10px] text-muted-foreground">
            will re-run: {editPlan.scope.join(', ')} · est {editPlan.estimate} · everything else stays current
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={runTargeted} disabled={busy}
              className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {editBusy ? 'starting…' : 'Targeted revision'}
            </button>
            <button type="button" disabled={busy}
              onClick={() => { if (isBusy()) return; const m = editPlan.message; setEditPlan(null); reviseProduct(m) }}
              className="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50">
              Full redesign instead
            </button>
            <button type="button" disabled={busy} onClick={() => setEditPlan(null)}
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
      <div className="shrink-0 border-t border-border p-2" onChange={astra.refreshPreferences} onFocus={astra.refreshPreferences}>
        {generationBlocker && <p id="compose-generation-blocker" className="mb-1 text-[11px] text-muted-foreground">{generationBlocker}</p>}
        {beta && <p id="compose-template-note" className="mb-2 text-[11px] text-muted-foreground">{typed ? 'Your draft is preserved below and will not be sent for this template.' : 'Free-form requests are unavailable in this beta. Select the supported template above.'}</p>}
        <div className="flex flex-col gap-1.5 border border-border bg-background p-2 focus-within:border-primary/50">
          <textarea
            ref={taRef}
            aria-label={current ? 'Answer the design question' : reviseMode ? 'Describe a design revision' : 'Describe your product or board'}
            aria-describedby={err ? 'compose-chat-error' : generationBlocker ? 'compose-generation-blocker' : beta ? 'compose-template-note' : undefined}
            readOnly={beta}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (!beta && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
            disabled={busy || phase === 'ready' || phase === 'revReady'}
            rows={3}
            placeholder={phase === 'ready' ? 'press “Yes, build it” above'
              : phase === 'revReady' ? 'press “Build revision” above'
                : phase === 'id' || phase === 'architect' || phase === 'interview' ? 'type your answer…'
                  : reviseMode ? 'Describe a change to revise this board…'
                    : phase === 'idle' ? 'Describe a product or a board…' : 'start a new thread with + New'}
            className="max-h-40 min-h-[60px] w-full resize-none overflow-y-auto bg-transparent text-[12px] leading-5 outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />
          <div className={cn('flex gap-2', beta ? 'min-w-0 flex-col items-stretch' : 'items-center justify-between')}>
            <ModelSelector />
            <button type="button" onClick={submit} disabled={(beta ? astraTemplateId !== ASTRA_DESIGN_TEMPLATE.id || phase !== 'idle' || reviseMode : !typed.trim()) || busy || !!generationBlocker || !!editPlan || !canSubmitCompose(phase, reviseMode, !!current)}
              className={cn('rounded-md bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40', beta ? 'w-full min-w-0 whitespace-normal' : 'shrink-0')}>
              {beta ? 'Generate this BME280 breakout' : 'Send ↵'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
