'use client'

/**
 * Compose — the three-pane design tool (Flux-informed). This is the product's
 * primary workspace; it superseded the older tabbed /compose page (deprecated
 * 2026-07-09, the /compose2 preview promoted in its place).
 *   LEFT   conversation: interview → build a new board, or revise the one on
 *          screen; thread switcher + live step feed
 *   CENTER the board as the hero: 3D by default, 2D/layers/schematic a toggle
 *   RIGHT  the journey collapsed to a vertical phase rail + phase panel
 * Backed by the real panels + loadRealBoard + /api/runs.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { acknowledgeStartDraft, readStartDraft, sessionDraftStorage } from '@/lib/start-draft'
import { loadRealBoard, type RealBoard } from '@/lib/real-board'
import { ComposeChat } from '@/components/compose-chat'
import { BoardCanvas } from '@/components/board-canvas'
import { Board3D } from '@/components/board-3d'
import { CodeViewer } from '@/components/code-viewer'
import { BomWorkspace } from '@/components/bom-workspace'
import { BoardChecks } from '@/components/board-checks'
import { BoardSchematic } from '@/components/board-schematic'
import { ProcurementPanel } from '@/components/procurement-panel'
import { RecoveryPanel } from '@/components/recovery-panel'
import { ConstraintsPanel } from '@/components/constraints-panel'
import { AssemblyPanel } from '@/components/assembly-panel'
import { PinoutPanel } from '@/components/pinout-panel'
import { IngestPanel } from '@/components/ingest-panel'
import { PatternsPanel } from '@/components/patterns-panel'
import { AdvancedRoutingPanel } from '@/components/advanced-routing-panel'
import { FL1ValidationView } from '@/components/fl1-validation-view'
import { FL1Loop } from '@/components/fl1-loop'
import { ErrorBoundary } from '@/components/error-boundary'
import { ReviewPanel } from '@/components/review-panel'
import { RunOverview } from '@/components/run-overview'
import { WorkspacePanes } from '@/components/workspace-panes'
import { INITIAL_WORKSPACE_SESSION, rememberWorkspaceSession, promoteWorkspaceSession, pipelineSignature, workspaceBoardStatus, workspaceInitialPipeline, workspaceProgress, readWorkspaceTiming, workspacePipelineState, interruptWorkspacePipeline, workspaceStageLabel, workspaceRunId, workspaceOnshapeUrl, workspaceImportFileError, workspaceImportedMetadata, type WorkspacePipeline, type WorkspaceHistory, type WorkspaceSurface } from '@/lib/workspace-state'
import type { BoardFacts } from '@/lib/verdict'
import { RunTimeline } from '@/components/run-timeline'
import { RevisionRail } from '@/components/revision-rail'
import { WorkQueue } from '@/components/work-queue'
import { CommentsPanel } from '@/components/comments-panel'
import { ArtifactExplorer, FilePreview } from '@/components/artifact-explorer'
import { FL1ReadinessPanel } from '@/components/fl1-readiness-panel'
import { BoardObjects } from '@/components/board-objects'
import { ReviewsPill } from '@/components/board-reviews'
import { IdStage } from '@/components/id-stage'
import { IdBriefPanel } from '@/components/id-brief-panel'
import { ExploreStage } from '@/components/explore-stage'
import { MechanicalStage } from '@/components/mechanical-stage'
import { SimulationStage } from '@/components/simulation-stage'
import { DisciplineStage } from '@/components/discipline-stage'
import { ChipScaleStage } from '@/components/chipscale-stage'
import { AstraNativeStage } from '@/components/astra-native-stage'
import { useAstraAvailability } from '@/components/astra-beta-status'
import { astraArtifactUrl, buildAstraRunView } from '@/lib/astra-run-view'
import { TerminalPanel, type TerminalTab } from '@/components/terminal-panel'
import { StatusBar } from '@/components/status-bar'
import { logLine, useProblemCount } from '@/lib/terminal-log'
import { LLMSettings, llmHeaders, LLM_PROVIDERS } from '@/components/llm-settings'
import { beginManualTiming, runFullPipeline, PIPE_ORDER, type PipeStatus } from '@/lib/run-pipeline'
import type { IdBrief } from '@/lib/id-brief'
import type { ProductSpec } from '@/lib/product-spec'
import {
  Activity, BookOpen, Box, ClipboardCheck, Code, Cpu, Eye, Factory, FolderTree, Gauge, History, LayoutDashboard, ListTree, Maximize2,
  MessagesSquare, Package, Palette, Plus, Receipt, ScrollText, ShieldCheck, Sparkles, Truck, Upload, Wrench, X,
} from 'lucide-react'

type Run = any
type Tab = string

// a closable document in the CENTER tab strip: a file from the left tree or
// one of the VIEWS panels opened on demand (stages stay pinned)
type DocTab = {
  id: string
  kind: 'file' | 'panel'
  label: string
  file?: { name: string; path: string; size?: number }
  panel?: Tab
}

// PRIMARY inspector destinations: the four surfaces that map to the user's
// linear job — see it, fix what's flagged, order it, validate it. Each Review /
// Order / Validate destination MERGES several underlying panels (rendered
// stacked with section headers in panelBody). Everything else is demoted to
// ADVANCED_VIEWS, reachable from the "More" affordance at the bottom of the rail
// and from the center "+" add-panel menu — regrouped, never removed.
const VIEWS: { tab: Tab; label: string; Icon: any }[] = [
  { tab: 'Overview', label: 'Overview', Icon: LayoutDashboard },
  { tab: 'Review', label: 'Review', Icon: ClipboardCheck },
  { tab: 'Order', label: 'Ship', Icon: Package },
]

// Demoted-but-kept destinations. Every one of these is still a valid `tab`
// value with its own panelBody case; they just live behind the rail's "More"
// disclosure instead of cluttering the primary rail. The granular Checks / BOM /
// Assembly / FL-1 / FL-1 Ready / Recovery panels also appear inside their merged
// primary destination, so nothing is orphaned.
const ADVANCED_VIEWS: { tab: Tab; label: string; Icon: any }[] = [
  // 'Validate' merged INTO Ship (its panels render there); the value stays
  // valid so old deep links and the "+" menu keep resolving.
  { tab: 'Validate', label: 'Validation only', Icon: ShieldCheck },
  { tab: 'Objects', label: 'Objects', Icon: ListTree },
  { tab: 'Artifacts', label: 'Files', Icon: ScrollText },
  { tab: 'Constraints', label: 'Constraints', Icon: Box },
  { tab: 'Pinout', label: 'Pinout', Icon: Cpu },
  { tab: 'Advanced', label: 'Routing', Icon: Activity },
  { tab: 'Patterns', label: 'Patterns', Icon: BookOpen },
  { tab: 'Ingest', label: 'Import', Icon: Upload },
  { tab: 'Code', label: 'Code', Icon: Code },
  { tab: 'Checks', label: 'Checks', Icon: ClipboardCheck },
  { tab: 'BOM', label: 'BOM', Icon: Receipt },
  { tab: 'Assembly', label: 'Assembly', Icon: Wrench },
  { tab: 'FL-1', label: 'FL-1', Icon: Gauge },
  { tab: 'FL-1 Ready', label: 'Ready', Icon: Gauge },
  { tab: 'Recovery', label: 'Recovery', Icon: Eye },
]

// combined lookup for header labels (primary + advanced)
const ALL_VIEWS = [...VIEWS, ...ADVANCED_VIEWS]

/** Section header + body for a merged inspector destination (Review / Order /
 * Validate stack several panels under labelled sub-sections). */
function PanelSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border last:border-b-0">
      <div className="border-b border-border bg-card/50 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </section>
  )
}

// Pipeline stages the middle+right panes follow. Electronics + Industrial Design
// are live; Mechanical (CAD) and Simulation are declared honestly as not-yet-built.
const STAGES = [
  { key: 'explore', label: 'Explore', Icon: Sparkles, built: true },
  { key: 'electronics', label: 'Electronics', Icon: Cpu, built: true },
  { key: 'id', label: 'Design', Icon: Palette, built: true },
  { key: 'mechanical', label: 'Mechanical', Icon: Box, built: true },
  { key: 'simulation', label: 'Simulation', Icon: Gauge, built: true },
  { key: 'firmware', label: 'Firmware', Icon: Code, built: true },
  { key: 'manufacturing', label: 'Mfg', Icon: Factory, built: true },
  { key: 'supplyChain', label: 'Supply', Icon: Truck, built: true },
  { key: 'validation', label: 'Validation', Icon: ShieldCheck, built: true },
] as const
type Stage = (typeof STAGES)[number]['key']

/** Thread-row state dot — the same colours the status bar uses. */
function runDot(status: string | undefined): string {
  if (status === 'PASSED') return 'bg-emerald-400'
  if (status === 'GATE FAILED') return 'bg-red-400'
  if (status === 'RUNNING') return 'bg-primary animate-pulse'
  return 'bg-muted-foreground/40'
}

/** One file-picker row for the import panel (hoisted so it doesn't remount). */
function FilePickRow({ label, hint, accept, file, onPick }: {
  label: string; hint: string; accept: string; file: File | null; onPick: (f: File | null) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 border border-border bg-background px-3 py-2 text-left hover:border-primary/60">
      <span className="min-w-0">
        <span className="block text-xs font-medium text-foreground">{label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{file ? file.name : hint}</span>
      </span>
      {file
        ? <X className="size-3.5 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={(e) => { e.preventDefault(); onPick(null) }} />
        : <Upload className="size-3.5 shrink-0 text-muted-foreground" />}
      <input type="file" aria-label={label} accept={accept} className="sr-only"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
    </label>
  )
}

/**
 * Start a product from an EXISTING design instead of a prompt: upload a PCBA
 * (.kicad_pcb) and/or a CAD assembly (.step). POSTs to the session route
 * /api/pipeline/import (same honest-verification core as the CLI/API); on
 * success it hands the created run back so the workspace opens it.
 */
function ImportDesignPanel({ onImported, onBusyChange, canStart }: { onImported: (r: any) => void; onBusyChange?: (busy: boolean) => void; canStart?: () => boolean }) {
  const [pcb, setPcb] = useState<File | null>(null)
  const [step, setStep] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [onshapeUrl, setOnshapeUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [err, setErr] = useState<string | null>(null)

  const submitOnshape = async () => {
    const url = onshapeUrl.trim()
    if (!workspaceOnshapeUrl(url)) { setErr('Paste an Onshape assembly URL (…/documents/…/w/…/e/…)'); return }
    if (busyRef.current || (canStart && !canStart())) { setErr('Finish or stop the current conversation operation before importing.'); return }
    busyRef.current = true
    setBusy(true); onBusyChange?.(true); setErr(null)
    try {
      const r = await fetch('/api/pipeline/import-onshape', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, name: name.trim() || undefined }),
      })
      const d = await r.json().catch(() => null)
      if (!r.ok) { setErr(d?.error || `Onshape import failed (HTTP ${r.status})`); return }
      if (!workspaceRunId(d?.runId)) { setErr('Import response did not include a valid run ID. Your inputs are unchanged.'); return }
      onImported(d)
    } catch (e: any) {
      setErr(e?.message || 'Onshape import failed')
    } finally { busyRef.current = false; setBusy(false); onBusyChange?.(false) }
  }

  const submit = async () => {
    if (!pcb && !step) { setErr('Choose a .kicad_pcb and/or a .step file first.'); return }
    const fileError = workspaceImportFileError(pcb, 'pcb') ?? workspaceImportFileError(step, 'step')
    if (fileError) { setErr(fileError); return }
    if (busyRef.current || (canStart && !canStart())) { setErr('Finish or stop the current conversation operation before importing.'); return }
    busyRef.current = true
    setBusy(true); onBusyChange?.(true); setErr(null)
    try {
      const fd = new FormData()
      if (pcb) fd.append('pcb', pcb)
      if (step) fd.append('step', step)
      if (name.trim()) fd.append('name', name.trim())
      const r = await fetch('/api/pipeline/import', { method: 'POST', body: fd })
      const d = await r.json().catch(() => null)
      if (!r.ok) { setErr(d?.error || `Import failed (HTTP ${r.status})`); return }
      if (!workspaceRunId(d?.runId)) { setErr('Import response did not include a valid run ID. Your inputs are unchanged.'); return }
      onImported(d)
    } catch (e: any) {
      setErr(e?.message || 'Import failed')
    } finally { busyRef.current = false; setBusy(false); onBusyChange?.(false) }
  }

  return (
    <div className="w-full max-w-sm border border-border bg-card p-4 text-left">
      <div className="mb-1 flex items-center gap-2">
        <Package className="size-4 text-primary" />
        <span className="text-sm font-medium text-foreground">Start from an existing design</span>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        Upload a PCBA and/or a CAD assembly to seed a product. Board check results are
        reported separately from import success. Imported STEP geometry is retained for
        download; rendered preview and fit verification may be unavailable.
      </p>
      <div className="flex flex-col gap-2">
        <FilePickRow label="PCBA" hint="choose a .kicad_pcb" accept=".kicad_pcb" file={pcb}
          onPick={(f) => { setErr(null); setPcb(f) }} />
        <FilePickRow label="CAD assembly" hint="choose a .step / .stp" accept=".step,.stp,.STEP,.STP" file={step}
          onPick={(f) => { setErr(null); setStep(f) }} />
        <input aria-label="Imported design name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)"
          className="border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none" />
        <button type="button" onClick={submit} disabled={busy || (!pcb && !step)}
          className="mt-1 flex items-center justify-center gap-2 bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50">
          <Upload className="size-3.5" />
          {busy ? 'Importing…' : 'Import design'}
        </button>
      </div>

      <div className="my-3 flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span className="h-px flex-1 bg-border" />or import live from Onshape<span className="h-px flex-1 bg-border" />
      </div>
      <div className="flex flex-col gap-2">
        <input aria-label="Onshape assembly URL" value={onshapeUrl} onChange={(e) => { setErr(null); setOnshapeUrl(e.target.value) }}
          placeholder="Onshape assembly URL"
          className="border border-border bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none" />
        <button type="button" onClick={submitOnshape} disabled={busy || !onshapeUrl.trim()}
          className="flex items-center justify-center gap-2 border border-primary px-3 py-2 text-xs font-medium text-primary disabled:opacity-50">
          <Package className="size-3.5" />
          {busy ? 'Importing…' : 'Import from Onshape'}
        </button>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Pulls the live parametric model: per-part materials, mass, and bounding boxes, plus a
          clash + thermal analysis — not just the STEP geometry.
        </p>
      </div>

      {err && <p className="mt-2 text-[11px] text-red-500">{err}</p>}
    </div>
  )
}

export default function Compose2Page() {
  const [runs, setRuns] = useState<Run[]>([])
  const [selectedId, setSelectedId] = useState('')
  const astraMode = useAstraAvailability()
  const selectedNative = runs.some((run) => run.id === selectedId && run.transport === 'astra-beta')
  const nativeMode = astraMode.beta || selectedNative
  // Until mode is known, do not mount or read a legacy exporter-backed surface.
  const legacyMode = astraMode.availability.state === 'loaded' && !astraMode.availability.status.enabled && !selectedNative
  const [sessionKey, setSessionKey] = useState(INITIAL_WORKSPACE_SESSION)
  const sessionKeyRef = useRef(INITIAL_WORKSPACE_SESSION)
  const runSessionsRef = useRef(new Map<string, string>())
  const sessionContextsRef = useRef(new Map<string, { productSpec: ProductSpec | null; idBrief: IdBrief | null; builtDisc: Record<string, boolean> }>())
  const [draftSessions, setDraftSessions] = useState([INITIAL_WORKSPACE_SESSION])
  const chatBusyRef = useRef(false)
  const importBusyRef = useRef(false)
  const [importBusy, setImportBusy] = useState(false)
  const [busyMessage, setBusyMessage] = useState('')
  const [surface, setSurface] = useState<WorkspaceSurface>('preview')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [followBuild, setFollowBuild] = useState(false)
  const [boardFacts, setBoardFacts] = useState<{ runId: string; facts: BoardFacts } | null>(null)
  const [artifactRevision, setArtifactRevision] = useState(0)
  const [boardGenerating, setBoardGenerating] = useState(false)
  const boardBusyRef = useRef(false)
  const manualOwnerRef = useRef<{ token: symbol; runId: string; stage: Stage } | null>(null)
  const [manualStage, setManualStage] = useState<Stage | null>(null)
  const [stageRefreshRevision, setStageRefreshRevision] = useState(0)
  const pageAliveRef = useRef(true)
  const selectionEpochRef = useRef(0)
  const onBusyChange = (busy: boolean) => { chatBusyRef.current = busy; if (!busy) setBusyMessage('') }
  const [realBoard, setRealBoard] = useState<RealBoard | null>(null)
  const [boardReadError, setBoardReadError] = useState('')
  const [tab, setTab] = useState<Tab>('Overview')
  const [view, setView] = useState<'3d' | 'layout' | 'schematic'>('3d')
  // which pipeline stage the middle+right panes show; auto-advances as the
  // pipeline runs (board builds -> Electronics; ID finishes -> Industrial Design)
  const [stage, setStage] = useState<Stage>('electronics')
  const [idBrief, setIdBrief] = useState<IdBrief | null>(null)
  // MUST be cleared by every path that starts a fresh design. The pipeline
  // reads productSpecRef, not the prompt, so a stale spec silently rebuilds the
  // PREVIOUS product: asking for a TMP102 breakout after an RS485 board built
  // the RS485 board again. selectThreadFromList always cleared it; the two
  // "New design" handlers did not.
  const [productSpec, setProductSpec] = useState<ProductSpec | null>(null)
  const [specResolvedRun, setSpecResolvedRun] = useState('')
  const [retainedImportRun, setRetainedImportRun] = useState('')
  const [specReadError, setSpecReadError] = useState('')
  const [specReadRevision, setSpecReadRevision] = useState(0)
  const importedRunsRef = useRef(new Set<string>())
  // Which discipline modules have been built this session (their tab produced a
  // real artifact). Drives the left-panel checkboxes so a built discipline shows
  // complete, not "module not built yet". Reset when the thread/design changes.
  const [builtDisc, setBuiltDisc] = useState<Record<string, boolean>>({})
  // Full-pipeline orchestration: live per-discipline status (pending/running/
  // passed/failed/blocked/skipped) as the sequencer runs every discipline
  // end-to-end, plus a run flag + abort handle. `pipeStarted` guards auto-start to
  // once per run so re-renders don't re-fire the multi-minute pipeline.
  //
  // Status is keyed BY RUN ID (not session-global): the multi-minute pipeline can
  // finish long after the user has switched threads, so every status update lands
  // in its own run's map entry and the UI only ever renders the entry for the run
  // currently selected — run A's pipeline can no longer narrate over run B.
  const [pipeStatusByRun, setPipeStatusByRun] = useState<Record<string, WorkspacePipeline>>({})
  const [timingHistory, setTimingHistory] = useState<WorkspaceHistory | null>(null)
  const [historyRevision, setHistoryRevision] = useState(0)
  // Initial board observation is local state, never inferred from a saved RUNNING label.
  const [initialPipelineByRun, setInitialPipelineByRun] = useState<Record<string, WorkspacePipeline>>({})
  // runId of the pipeline currently in flight (null when idle)
  const [pipelineRunId, setPipelineRunId] = useState<string | null>(null)
  // bottom Terminal panel + status bar
  const [termCollapsed, setTermCollapsed] = useState(true)
  const [termTab, setTermTab] = useState<TerminalTab>('terminal')
  const problemCount = useProblemCount()
  // wall-clock start of the in-flight pipeline (drives the status-bar elapsed)
  const [pipeStartedAt, setPipeStartedAt] = useState<number | null>(null)
  // model tier shown in the status bar — plain strings, resolved client-side from
  // the same localStorage llmHeaders() reads (never import server code here)
  const [llmTiers, setLlmTiers] = useState<string[]>([])
  const [pipeFeedbackByRun, setPipeFeedbackByRun] = useState<Record<string, { status: string; capabilityGaps: { gap: string }[]; remaining: string[] }>>({})
  const pipeAbort = useRef<AbortController | null>(null)
  const pipeStarted = useRef<Set<string>>(new Set())
  const canChangeSelection = () => {
    if (!chatBusyRef.current && !importBusyRef.current && !boardBusyRef.current && !pipeAbort.current) return true
    setBusyMessage('Finish or stop the current operation before switching designs. You can still browse stages, files and details.')
    return false
  }
  // The pipeline's completion callbacks must read the selection AT FIRE TIME, not
  // the selection captured when the pipeline started (a stale closure): keep the
  // current selectedId in a ref for those async gates.
  const selectedIdRef = useRef(selectedId)
  // Latest product spec in a ref, so the async onProductBuilt callback (which may
  // hold a stale closure from when the build started) always runs the pipeline
  // with the current spec, not a null captured before the spec was lifted.
  const productSpecRef = useRef<ProductSpec | null>(null)
  // "+New" clears the stage to a blank slate (no board) while the chat stays
  // active; the board reappears when the new design finishes building.
  const [newDesign, setNewDesign] = useState(false)
  // ids this session started. They may not exist on disk (a build that failed
  // before writing a board), and must not be dropped by a runs refresh.
  const localRunsRef = useRef<Set<string>>(new Set())
  // true once /api/runs has answered — see the URL-sync effect below
  const [runsLoaded, setRunsLoaded] = useState(false)
  // an FL-1 loop ECO gets dropped into the chat as a revision (single-pane flow)
  const [revisePrefill, setRevisePrefill] = useState('')
  const handoffIdRef = useRef<string | null>(null)
  const handoffSeenRef = useRef(false)
  const onPrefillConsumed = () => {
    const id = handoffIdRef.current
    if (id) { acknowledgeStartDraft(sessionDraftStorage(), id); handoffIdRef.current = null }
    setRevisePrefill('')
  }
  const stageRef = useRef<HTMLDivElement>(null)
  const toggleFullscreen = () => {
    const el = stageRef.current
    if (!el) return
    if (document.fullscreenElement) document.exitFullscreen()
    else el.requestFullscreen?.()
  }

  /**
   * Runs this session STARTED are kept even when /api/runs cannot see them.
   *
   * A failed build writes no board, so the disk listing omits it — and a plain
   * setRuns(disk) deleted the entry, taking `selectedRun` with it and dropping
   * the page back to the blank slate a moment after the failure was reported.
   * Local entries merge over the disk listing until the disk has a real one.
   */
  const mergeRuns = (disk: Run[]) =>
    setRuns((prev: Run[]) => {
      const onDisk = new Set(disk.map((r) => r.id))
      const localOnly = prev.filter((r) => localRunsRef.current.has(r.id) && !onDisk.has(r.id))
      return [...localOnly, ...disk]
    })
  const refreshRuns = () =>
    fetch('/api/runs').then((r) => (r.ok ? r.json() : { runs: [] }))
      .then(({ runs: disk }: { runs: Run[] }) => { if (Array.isArray(disk)) mergeRuns(disk); return disk })
      .catch(() => [])
  const readSavedBoard = async (runDir: string, id: string, epoch: number) => {
    if (!legacyMode) return null
    const unavailable = () => {
      if (pageAliveRef.current && selectedIdRef.current === id && selectionEpochRef.current === epoch) {
        setBoardReadError('This run is saved, but some board preview metadata could not be read. Import or generation is not being retried.')
      }
    }
    try { return await loadRealBoard(runDir, unavailable) } catch {
      unavailable()
      return null
    }
  }
  const onRunComplete = async (runDir: string, id: string, metadataRequired = false) => {
    const origin = sessionKey
    if (sessionKeyRef.current !== origin) return
    if (metadataRequired) importedRunsRef.current.add(id)
    promoteWorkspaceSession(runSessionsRef.current, id, origin)
    selectedIdRef.current = id
    setSelectedId(id)
    setNewDesign(false)
    setDraftSessions((drafts) => drafts.filter((key) => key !== origin))
    localRunsRef.current.add(id)
    setInitialPipelineByRun((previous) => { const next = { ...previous }; delete next[id]; return next })
    setTimingHistory(null); setHistoryRevision((revision) => revision + 1)
    setRuns((prev: Run[]) => {
      const entry = nativeMode
        ? buildAstraRunView({ runId: id, spec: productSpecRef.current })
        : { id, runDir, real: true, status: 'REVIEW REQUIRED', name: productSpecRef.current?.product || id }
      return prev.some((run) => run.id === id)
        ? prev.map((run) => run.id === id ? { ...run, ...entry, failure: undefined } : run)
        : [entry, ...prev]
    })
    const epoch = selectionEpochRef.current
    setArtifactRevision((revision) => revision + 1)
    await refreshRuns()
    if (!legacyMode || sessionKeyRef.current !== origin || selectedIdRef.current !== id || selectionEpochRef.current !== epoch) return
    const board = await readSavedBoard(runDir, id, epoch)
    if (sessionKeyRef.current === origin && selectedIdRef.current === id && selectionEpochRef.current === epoch) setRealBoard(board)
  }
  const handleImported = async (result: any) => {
    const origin = sessionKey
    const runId = result?.runId
    if (!legacyMode || !runId || sessionKeyRef.current !== origin || chatBusyRef.current) return
    promoteWorkspaceSession(runSessionsRef.current, runId, origin)
    localRunsRef.current.add(runId)
    importedRunsRef.current.add(runId)
    const runDir = `/runs/${runId}`
    selectedIdRef.current = runId
    setSelectedId(runId)
    setNewDesign(false)
    productSpecRef.current = null
    setProductSpec(null); setRetainedImportRun(''); setSpecResolvedRun(''); setBuiltDisc({}); setIdBrief(null); setBoardFacts(null)
    setRealBoard(null)
    setRuns((prev: Run[]) => prev.some((run) => run.id === runId) ? prev : [{ id: runId, runDir, real: true, name: result.name || runId }, ...prev])
    setStage(result?.imported?.pcb ? 'electronics' : 'mechanical')
    setSurface('preview')
    const epoch = selectionEpochRef.current
    const board = await readSavedBoard(runDir, runId, epoch)
    if (sessionKeyRef.current === origin && selectedIdRef.current === runId && selectionEpochRef.current === epoch) setRealBoard(board)
    refreshRuns()
  }
  const onIdBrief = (brief: IdBrief | null) => {
    if (sessionKeyRef.current === sessionKey) setIdBrief(brief)
  }
  const onProductSpec = (spec: ProductSpec | null) => {
    if (sessionKeyRef.current !== sessionKey) return
    productSpecRef.current = spec
    setProductSpec(spec)
    if (!spec) { setRetainedImportRun(''); setSpecResolvedRun(''); setSpecReadRevision((revision) => revision + 1); setBuiltDisc({}); setIdBrief(null); setBoardFacts(null); setRealBoard(null) }
  }

  // resizable panes (drag the dividers); persisted per browser
  // left-pane mode: chat (conversation), threads (design list), files (run tree)
  const [leftView, setLeftView] = useState<'chat' | 'threads' | 'files'>('chat')
  // CENTER tab strip: pinned stage tabs + closable doc tabs (files/panels).
  // activeDoc null = the pinned stage view is showing.
  const [docTabs, setDocTabs] = useState<DocTab[]>([])
  const [activeDoc, setActiveDoc] = useState<string | null>(null)
  // right-pane rail "More" (Advanced destinations) + center-strip "More" (advisory stages)
  // badge-don't-steal-focus: a stage finishing while not visible gets a dot
  const [badged, setBadged] = useState<Record<string, 'passed' | 'failed'>>({})
  const prevPipeRef = useRef<Record<string, string>>({})
  const openFileTab = (f: { name: string; path: string; size?: number }) => {
    const id = `file:${f.path}`
    setDocTabs((ts) => (ts.some((d) => d.id === id) ? ts : [...ts, { id, kind: 'file' as const, label: f.name, file: f }]))
    setActiveDoc(id); setFollowBuild(false); setSurface('preview')
  }
  const openPanelTab = (tb: Tab, label: string) => {
    const id = `panel:${tb}`
    setDocTabs((ts) => (ts.some((d) => d.id === id) ? ts : [...ts, { id, kind: 'panel' as const, label, panel: tb }]))
    setActiveDoc(id)
  }
  const closeDoc = (id: string) => {
    const i = docTabs.findIndex((d) => d.id === id)
    const n = docTabs.filter((d) => d.id !== id)
    setDocTabs(n)
    if (activeDoc === id) setActiveDoc(n[Math.min(i, n.length - 1)]?.id ?? null)
  }
  useEffect(() => {
    try {
      setTermCollapsed(localStorage.getItem('c2-termCollapsed') !== '0')
      const provider = localStorage.getItem('fl-llm-provider') ?? ''
      setLlmTiers([LLM_PROVIDERS.find((item) => item.id === provider)?.label ?? 'Platform default'])
    } catch { setLlmTiers(['Platform default']) }
  }, [])
  const toggleTerm = () => setTermCollapsed((collapsed) => {
    try { localStorage.setItem('c2-termCollapsed', collapsed ? '0' : '1') } catch { /* optional */ }
    return !collapsed
  })

  const saveCurrentSession = () => rememberWorkspaceSession(sessionContextsRef.current, sessionKeyRef.current, { productSpec: productSpecRef.current, idBrief, builtDisc })
  const changeSession = (key: string, id: string, preserveBrowsing = false) => {
    if (key === sessionKeyRef.current && id === selectedIdRef.current) { if (!preserveBrowsing) setLeftView('chat'); return }
    if (!canChangeSelection()) return
    saveCurrentSession()
    selectionEpochRef.current += 1
    sessionKeyRef.current = key
    selectedIdRef.current = id
    setSessionKey(key); setSelectedId(id); setNewDesign(!id)
    const context = sessionContextsRef.current.get(key)
    productSpecRef.current = context?.productSpec ?? null
    setProductSpec(context?.productSpec ?? null); setIdBrief(context?.idBrief ?? null); setBuiltDisc(context?.builtDisc ?? {})
    setRetainedImportRun(''); setRealBoard(null); setBoardFacts(null); setBoardGenerating(false); setRevisePrefill(''); setStage('electronics')
    if (!preserveBrowsing) setLeftView('chat')
    setDocTabs([]); setActiveDoc(null); setBadged({}); setFollowBuild(false)
    prevPipeRef.current = {}
    setBusyMessage('')
  }
  const selectThreadFromList = (id: string, preserveBrowsing = false) => {
    if (!canChangeSelection()) return
    // A removed ancestor alias needs a new identity even if the live revision
    // originally started in that ancestor's saved-run conversation.
    const key = runSessionsRef.current.get(id) ?? `run:${id}:${crypto.randomUUID()}`
    runSessionsRef.current.set(id, key)
    changeSession(key, id, preserveBrowsing)
  }
  const newSession = () => {
    if (!canChangeSelection()) return
    const key = `draft:${crypto.randomUUID()}`
    setDraftSessions((drafts) => [...drafts, key].slice(-8))
    changeSession(key, '')
    setSurface('conversation')
  }
  const revise = (prompt: string) => {
    if (!canChangeSelection()) return
    setRevisePrefill(prompt); setLeftView('chat'); setSurface('conversation')
  }
  const showInspector = (next: Tab) => { setTab(next); setInspectorOpen(true); setSurface('details') }

  // /compose is authenticated by the proxy. Peek first, then acknowledge only
  // when ComposeChat has setTyped + focused. The ref survives StrictMode's
  // effect replay and keeps a late run-list response from restoring an old run.
  useEffect(() => {
    if (handoffSeenRef.current) return
    const draft = readStartDraft(sessionDraftStorage())
    if (!draft) return
    handoffIdRef.current = draft.id
    handoffSeenRef.current = true
    selectedIdRef.current = ''
    productSpecRef.current = null
    setSelectedId(''); setNewDesign(true); setRealBoard(null)
    setProductSpec(null); setIdBrief(null); setBuiltDisc({})
    setStage('electronics'); setLeftView('chat'); setSurface('conversation'); setDocTabs([])
    setActiveDoc(null); setBadged({})
    setRevisePrefill(draft.prompt)
  }, [])

  // URL restoration is a delayed user selection. Read the latest canonical
  // handler without restarting the run-list request whenever a draft changes.
  const selectThreadRef = useRef(selectThreadFromList)
  useLayoutEffect(() => { selectThreadRef.current = selectThreadFromList })

  // load real runs from disk (same source as /compose)
  useEffect(() => {
    let cancelled = false
    fetch('/api/runs').then((r) => (r.ok ? r.json() : { runs: [] }))
      .then(({ runs: disk }: { runs: Run[] }) => {
        if (cancelled) return
        if (Array.isArray(disk) && disk.length) {
          mergeRuns(disk)
          // Do NOT auto-select the last run on load — a fresh page open starts on a
          // blank slate (the "describe a product" prompt), not the previous board.
          // Past runs stay available via the ☰ menu.
          //
          // ...UNLESS the URL names one. /compose?run=<id> was silently ignored,
          // so a run's URL could not be bookmarked, shared or reloaded back into.
          const want = new URLSearchParams(window.location.search).get('run')
          if (!handoffIdRef.current && want && !handoffSeenRef.current && disk.some((r: Run) => r.id === want) && selectionEpochRef.current === 0) {
            selectThreadRef.current(want, true)
          }
        }
      }).catch(() => {})
      .finally(() => { if (!cancelled) setRunsLoaded(true) })
    return () => { cancelled = true }
  }, [])

  // Keep the URL pointing at the visible run, so reload/back/bookmark all land
  // where the user is. replaceState, not push: switching threads is not a
  // navigation the back button should have to walk through.
  //
  // Gated on runsLoaded: on mount selectedId is still empty, so writing the URL
  // then strips the ?run= we are about to read, and the deep link would
  // erase itself before it could be applied.
  useEffect(() => {
    if (!runsLoaded) return
    const url = new URL(window.location.href)
    if (selectedId && !newDesign) url.searchParams.set('run', selectedId)
    else url.searchParams.delete('run')
    if (url.toString() !== window.location.href) window.history.replaceState(null, '', url)
  }, [runsLoaded, selectedId, newDesign])

  // No runs[0] fallback: with no explicit selection (fresh load) selectedRun is
  // undefined → the stage renders its blank/new-design slate, not the last board.
  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedId), [runs, selectedId])
  /** The selected run, when it exists ONLY because we started it and it failed
   *  (nothing on disk). Drives the failure state the panels show. */
  const failedRun = useMemo(() => {
    const r = runs.find((x) => x.id === selectedId) as (Run & { failure?: string }) | undefined
    return r?.failure ? r : null
  }, [runs, selectedId])
  const selectedRunDir = selectedRun?.runDir
  const selectedReal = selectedRun?.real

  useEffect(() => { productSpecRef.current = productSpec }, [productSpec])

  // What the UI renders: the SELECTED run's pipeline state. A pipeline running
  // for a different run keeps streaming into its own map entry silently.
  const { pipeline: pipeStatus, historyState } = useMemo(() => workspacePipelineState(
    selectedId, pipeStatusByRun[selectedId] ?? initialPipelineByRun[selectedId], timingHistory,
  ), [selectedId, pipeStatusByRun, initialPipelineByRun, timingHistory])
  const pipeFeedback = selectedId ? (pipeFeedbackByRun[selectedId] ?? null) : null
  const pipeRunning = !!pipelineRunId && pipelineRunId === selectedId
  const metadataReady = !selectedRun?.real || !!productSpec || specResolvedRun === selectedId
  const metadataReadyRef = useRef(metadataReady)
  metadataReadyRef.current = metadataReady
  const liveRunning = boardGenerating || pipeRunning || Object.values(initialPipelineByRun[selectedId] ?? {}).some((value) => value.status === 'running')

  // The operation belongs to the workspace, not to the currently visible panel.
  // The paired callbacks capture one token, so an obsolete view cannot release a
  // newer operation or restore a previous attempt's success evidence.
  const generationProps = (discipline: Stage) => {
    const token = Symbol(discipline)
    const runId = selectedId
    let finishTiming: Awaited<ReturnType<typeof beginManualTiming>> | undefined
    return {
      generationDisabled: !legacyMode || pipeRunning || boardGenerating || importBusy || chatBusyRef.current || !metadataReady,
      onBuildStart: async () => {
        if (!legacyMode || !pageAliveRef.current || !metadataReadyRef.current || selectedIdRef.current !== runId || !runId
          || boardBusyRef.current || pipeAbort.current || chatBusyRef.current || importBusyRef.current) return false
        manualOwnerRef.current = { token, runId, stage: discipline }
        boardBusyRef.current = true
        setBoardGenerating(true); setManualStage(discipline)
        setPipeStatusByRun((previous) => ({ ...previous, [runId]: {
          ...(previous[runId] ?? pipeStatus),
          [discipline]: { status: 'running', detail: 'Explicit manual attempt in progress.' },
        } }))
        try {
          finishTiming = await beginManualTiming(runId, discipline)
          if (!pageAliveRef.current || manualOwnerRef.current?.token !== token) {
            await finishTiming({ status: 'unknown', detail: 'View closed before generation submission; no new work was submitted.' })
            return false
          }
          if (discipline === 'electronics') { setBoardFacts(null); setRealBoard(null) }
          return true
        } catch {
          if (pageAliveRef.current && manualOwnerRef.current?.token === token) {
            manualOwnerRef.current = null; boardBusyRef.current = false
            setBoardGenerating(false); setManualStage(null)
            setBusyMessage('Could not preserve attempt history. Generation was not started. Retry history before trying again.')
            setPipeStatusByRun((previous) => ({ ...previous, [runId]: { ...previous[runId], [discipline]: { status: 'unknown', detail: 'History could not be saved. This manual generation was not submitted.' } } }))
          }
          return false
        }
      },
      onBuildSettled: async (result: { status: 'passed' | 'failed' | 'unknown'; detail?: string; artifactAvailable?: boolean }) => {
        let persistenceError = false
        try { await finishTiming?.(result) } catch { persistenceError = true }
        if (!pageAliveRef.current || manualOwnerRef.current?.token !== token) return
        if (persistenceError) result = { ...result, status: 'unknown', detail: 'Attempt history could not be saved. Reload will show an unfinished attempt; inspect artifacts before restarting.' }
        manualOwnerRef.current = null
        boardBusyRef.current = false
        setBoardGenerating(false); setManualStage(null); setBusyMessage(persistenceError ? 'Attempt history could not be saved. Outcome remains unknown.' : '')
        setPipeStatusByRun((previous) => ({ ...previous, [runId]: {
          ...previous[runId], [discipline]: { status: result.status, detail: result.detail
            || (result.status === 'unknown' ? 'Server outcome unknown. Inspect saved artifacts before restarting.' : 'Manual attempt settled. Artifact availability is separate from engineering approval.') },
        } }))
        if (selectedIdRef.current === runId) {
          setArtifactRevision((revision) => revision + 1)
          if (result.artifactAvailable) setBuiltDisc((previous) => ({ ...previous, [discipline]: true }))
        }
      },
    }
  }

  // Independent of product/spec caches. Abort on selection/retry and check both
  // identity and epoch so late A → B → A reads cannot restore an old snapshot.
  useEffect(() => {
    setTimingHistory(null)
    if (!legacyMode || !selectedId) return
    const controller = new AbortController()
    const id = selectedId
    const epoch = selectionEpochRef.current
    void readWorkspaceTiming(id, controller.signal).then((history) => {
      if (history && !controller.signal.aborted && selectedIdRef.current === id && selectionEpochRef.current === epoch) setTimingHistory(history)
    })
    return () => controller.abort()
  }, [selectedId, historyRevision, legacyMode])

  useEffect(() => {
    // a stage transitioning to passed/failed while NOT the visible view gets a
    // badge; focusing its tab clears it (see the stage tab onClick)
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries(pipeStatus ?? {})) next[k] = (v as { status?: string })?.status ?? ''
    const prev = prevPipeRef.current
    prevPipeRef.current = next
    const hits = Object.entries(next).filter(([k, st]) =>
      st !== prev[k] && (st === 'passed' || st === 'failed') && !(activeDoc === null && stage === k && !pipeRunning))
    if (hits.length) setBadged((b) => ({ ...b, ...Object.fromEntries(hits) }) as Record<string, 'passed' | 'failed'>)
  }, [pipeStatus, activeDoc, stage, pipeRunning])

  // Client navigation must stop future scheduling too; beforeunload only covers
  // document navigation. Already-submitted server work may continue.
  useEffect(() => {
    pageAliveRef.current = true
    return () => {
      pageAliveRef.current = false
      pipeAbort.current?.abort()
      pipeAbort.current = null
      manualOwnerRef.current = null
      boardBusyRef.current = false
    }
  }, [])

  // A tab close would silently kill the multi-minute pipeline — ask first while
  // ANY run's pipeline is in flight (not just the selected one).
  useEffect(() => {
    if (!pipelineRunId) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [pipelineRunId])

  // Restore a SAVED run's product state from disk when it's selected from the
  // menu. onSelectThread clears productSpec/builtDisc for an immediate reset;
  // this re-hydrates them from the run's persisted artifacts (product-spec.json,
  // id-brief.json, and which disciplines/*.json exist) so the discipline tabs
  // re-enable and show their built content instead of a disabled "not built"
  // state. Guarded on productSpecRef so a FRESH build (spec already in memory,
  // disciplines still streaming to disk) is never clobbered by partial disk state.
  useEffect(() => {
    const id = selectedRun?.id
    if ((!legacyMode && !nativeMode) || newDesign || !selectedRun?.real || !id || productSpecRef.current) return
    let off = false
    const j = (p: string) => fetch(p, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    const head = (p: string) => fetch(p, { method: 'HEAD', cache: 'no-store' }).then((r) => r.ok).catch(() => false)
    setSpecReadError('')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    void fetch(nativeMode ? astraArtifactUrl(id, 'product-spec.json') : `/runs/${id}/product-spec.json`, { cache: 'no-store', signal: controller.signal, redirect: 'error' }).then(async (response) => {
      const value = response.ok ? await response.json() : null
      if (off || selectedIdRef.current !== id) return
      if (value && typeof value.product === 'string' && value.product.trim() && value.disciplines && typeof value.disciplines === 'object' && !Array.isArray(value.disciplines)) {
        if (!productSpecRef.current) { productSpecRef.current = value; setProductSpec(value) }
        setSpecResolvedRun(id)
      } else if (workspaceImportedMetadata(value)) {
        setRetainedImportRun(id)
        setSpecReadError('')
      } else if (response.status === 404 && !importedRunsRef.current.has(id)) setSpecResolvedRun(id)
      else setSpecReadError('Saved design metadata could not be read. No export or generation was started.')
    }).catch(() => { if (!off && selectedIdRef.current === id) setSpecReadError('Saved design metadata could not be read. No export or generation was started.') })
      .finally(() => clearTimeout(timeout))
    if (nativeMode) return () => { off = true; clearTimeout(timeout); controller.abort() }
    j(`/runs/${id}/disciplines/id-brief.json`).then((b) => { if (!off && selectedIdRef.current === id && b?.product) setIdBrief(b) })
    const probes: [string, string][] = [
      ['electronics', `/runs/${id}/electronics/chipscale-board.json`],
      ['mechanical', `/runs/${id}/mechanical/mechanical.json`],
      ['simulation', `/runs/${id}/disciplines/simulation.json`],
      ['firmware', `/runs/${id}/disciplines/firmware.json`],
      ['manufacturing', `/runs/${id}/disciplines/manufacturing.json`],
      ['supplyChain', `/runs/${id}/disciplines/supplyChain.json`],
      ['validation', `/runs/${id}/disciplines/validation.json`],
    ]
    Promise.all(probes.map(([k, p]) => head(p).then((ok) => (ok ? k : null)))).then((found) => {
      if (!off && selectedIdRef.current === id) setBuiltDisc(Object.fromEntries(found.filter(Boolean).map((k) => [k as string, true])))
    })
    return () => { off = true; clearTimeout(timeout); controller.abort() }
  }, [selectedRun?.id, selectedRun?.real, newDesign, specReadRevision, legacyMode, nativeMode])

  // Run the WHOLE pipeline end-to-end: chip-scale electronics -> mechanical ->
  // simulation -> feedback loop -> firmware -> mfg -> supply -> validation. Reuses
  // each discipline's real API (the same the manual buttons call); the sequencer
  // just orders them so each grounds on the real board, and wires the feedback
  // loop. Live status streams into the disciplines panel via pipeStatus.
  /**
   * A build has BEGUN. Register the run immediately, with a placeholder entry if
   * /api/runs cannot see it yet (it cannot — nothing is on disk).
   *
   * Without this the page learned about a run only when it COMPLETED, so a run
   * that started and failed left `selectedRun` undefined and the whole page fell
   * through to `if (!selectedRun)` — the fresh-install slate. The result was
   * three contradictory empty states at once over a design that had just failed:
   * "Describe a board on the left to design your first one" in the centre,
   * "No run yet — panels populate as the build runs" in the right rail, and
   * "no run" in the status bar, while the left panel showed the product and
   * "Electronics FAILED". The failure was also unreachable afterwards: the
   * thread was never registered, so it did not appear in the run list either.
   */
  const onRunStart = (runId: string) => {
    if (sessionKeyRef.current !== sessionKey) return
    promoteWorkspaceSession(runSessionsRef.current, runId, sessionKey)
    selectedIdRef.current = runId
    setDraftSessions((drafts) => drafts.filter((key) => key !== sessionKey))
    localRunsRef.current.add(runId)
    if (legacyMode) setInitialPipelineByRun((previous) => ({ ...previous, [runId]: workspaceInitialPipeline('RUNNING') }))
    setSelectedId(runId)
    setNewDesign(false)
    setRuns((prev: Run[]) => (prev.some((r) => r.id === runId) ? prev : [
      nativeMode ? buildAstraRunView({ runId, spec: productSpecRef.current }) : {
        id: runId,
        name: productSpecRef.current?.product || 'building…',
        timestamp: new Date().toISOString().replace('T', ' ').slice(0, 16),
        status: 'RUNNING',
        prompt: productSpecRef.current?.product || '',
        real: false,
        runDir: `/runs/${runId}`,
        stages: [],
        metrics: {},
        logs: [],
      } as unknown as Run,
      ...prev,
    ]))
  }

  /** A started run ended badly. Keep it, and record WHY on the run itself. */
  const onRunFailed = (runId: string, detail: string, outcome: 'failed' | 'disconnected' = 'failed', scope: 'initial' | 'targeted' = 'initial') => {
    localRunsRef.current.add(runId)
    if (nativeMode) {
      setRuns((previous: Run[]) => previous.map(run => run.id === runId ? { ...run, status: 'UNKNOWN', failure: detail } : run))
      setArtifactRevision((revision) => revision + 1)
      void refreshRuns()
      return
    }
    const connectionLost = outcome === 'disconnected'
    const failure = connectionLost ? `${detail} The server may still be working; inspect saved artifacts before starting another build.` : detail
    if (scope === 'targeted') {
      setInitialPipelineByRun((previous) => { const next = { ...previous }; delete next[runId]; return next })
      setPipeStatusByRun((previous) => { const next = { ...previous }; delete next[runId]; return next })
      setTimingHistory(null); setHistoryRevision((revision) => revision + 1)
    } else setInitialPipelineByRun((previous) => ({ ...previous, [runId]: workspaceInitialPipeline(connectionLost ? 'NEEDS ATTENTION' : 'GATE FAILED', failure) }))
    setRuns((prev: Run[]) => prev.map((r) => (r.id === runId
      ? ({ ...r, status: connectionLost ? 'NEEDS ATTENTION' : 'GATE FAILED', failure } as unknown as Run)
      : r)))
    logLine({ source: 'pipeline', level: connectionLost ? 'warn' : 'error', text: `${connectionLost ? 'run updates disconnected' : 'run failed'} — ${detail}`, runId })
  }

  const runPipeline = async (runIdArg?: string) => {
    const runId = runIdArg || selectedRun?.id
    const spec = productSpecRef.current
    if (!legacyMode || !pageAliveRef.current || !spec || !runId || pipeAbort.current || boardBusyRef.current || importBusyRef.current || (!runIdArg && chatBusyRef.current)) return
    const ac = new AbortController()
    pipeAbort.current = ac
    setPipelineRunId(runId)
    setPipeStartedAt(Date.now())
    setPipeFeedbackByRun((prev) => { const next = { ...prev }; delete next[runId]; return next })
    setPipeStatusByRun((prev) => ({
      ...prev,
      [runId]: Object.fromEntries(PIPE_ORDER.map((s) => [s, { status: 'pending' as PipeStatus }])),
    }))
    try {
      const res = await runFullPipeline({
        spec, runId, headers: llmHeaders(), signal: ac.signal,
        // Phase 2: skip stages whose inputs are provably unchanged. The server
        // decides currency (FL_INCREMENTAL gate) — with the flag off this is a
        // no-op and every stage runs exactly as before.
        dirtyOnly: true,
        // every status update lands in THIS run's entry only — never the
        // session-global view — so switching threads mid-run can't cross-narrate.
        // Each transition also lands in the bottom Terminal panel's log bus.
        onStage: (e) => {
          if (ac.signal.aborted || !pageAliveRef.current) return
          logLine({
            source: 'pipeline',
            level: e.status === 'failed' ? 'error' : e.status === 'blocked' ? 'warn'
              : e.status === 'passed' ? 'ok' : 'info',
            text: `${e.stage} → ${e.status}${e.detail ? ` — ${e.detail}` : ''}`,
            runId,
          })
          setPipeStatusByRun((prev) => ({
            ...prev,
            [runId]: { ...prev[runId], [e.stage]: { status: e.status, detail: e.detail } },
          }))
        },
      })
      if (ac.signal.aborted || !pageAliveRef.current) return
      if (res.feedback) setPipeFeedbackByRun((prev) => ({ ...prev, [runId]: res.feedback! }))
      // Portfolio bridge: a completed run becomes an enterprise Programs board
      // (fire-and-forget; the sync is idempotent and reads only real artifacts).
      fetch('/api/programs/sync', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId }), keepalive: true,
      }).catch(() => {})
      // Phase 3: harvest the honest flags into the work queue.
      fetch('/api/runs/work-items', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId }), keepalive: true,
      }).catch(() => {})
      // Completion writes touch SELECTED-run state (productSpec, builtDisc), so
      // they only apply when this pipeline's run is the one on screen at fire
      // time. If the user switched away, the artifacts are on disk — reselecting
      // the run rehydrates them (see the restore effect above).
      if (selectedIdRef.current === runId) {
        if (res.updatedSpec) { productSpecRef.current = res.updatedSpec; setProductSpec(res.updatedSpec) }
        setBuiltDisc((prev) => {
          const next = { ...prev }
          for (const [k, v] of Object.entries(res.stages)) if (v?.status === 'passed') next[k] = true
          return next
        })
      }
    } catch {
      if (!pageAliveRef.current || pipeAbort.current !== ac) return
      setPipeStatusByRun((previous) => ({ ...previous, [runId]: interruptWorkspacePipeline(previous[runId] ?? {}) }))
    } finally {
      if (!pageAliveRef.current || pipeAbort.current !== ac) return
      setStageRefreshRevision((revision) => revision + 1)
      // Even an unexpected sequencer exit cannot leave a confirmed live spinner.
      setPipeStatusByRun((previous) => ({ ...previous, [runId]: interruptWorkspacePipeline(previous[runId] ?? {}) }))
      setPipelineRunId(null); setPipeStartedAt(null); pipeAbort.current = null
    }
  }
  const stopPipeline = () => {
    pipeAbort.current?.abort()
    if (pipelineRunId) setPipeStatusByRun((previous) => ({ ...previous, [pipelineRunId]: interruptWorkspacePipeline(previous[pipelineRunId] ?? {}) }))
    setPipelineRunId(null); setPipeStartedAt(null)
  }

  // Auto-start the full pipeline the moment a PRODUCT's board finishes building.
  // compose-chat calls this with the exact runId it just built (from the build's
  // 'done' event), so the pipeline always runs on the right run — no race with the
  // previously-selected run. Fires regardless of whether the flroute reference
  // board gate-failed (the chip-scale board the pipeline builds is what matters).
  // `pipeStarted` guards to once per run.
  const onProductBuilt = (runId: string) => {
    if (!legacyMode || !runId || selectedIdRef.current !== runId || sessionKeyRef.current !== sessionKey || pipeStarted.current.has(runId)) return
    pipeStarted.current.add(runId)
    runPipeline(runId)
  }

  // load the selected run's own snapshot
  useEffect(() => {
    setBoardReadError('')
    if (!legacyMode || !selectedReal) { setRealBoard(null); return }
    let cancelled = false
    setRealBoard(null)
    const id = selectedId
    const epoch = selectionEpochRef.current
    readSavedBoard(selectedRunDir ?? '', id, epoch).then((d) => { if (!cancelled && selectedIdRef.current === id && selectionEpochRef.current === epoch) setRealBoard(d) })
    return () => { cancelled = true }
  }, [selectedId, selectedReal, selectedRunDir, artifactRevision, legacyMode])

  const real = realBoard && realBoard.base === (selectedRunDir ?? '') ? realBoard : null
  const isReal = selectedRun?.real === true && real !== null

  const refreshKey = `${selectedId}:${artifactRevision}:${pipelineSignature(pipeStatus)}`
  useEffect(() => {
    setBoardFacts(null)
    if (!legacyMode || !selectedId || boardGenerating) return
    const controller = new AbortController()
    const id = selectedId
    fetch(`/runs/${id}/electronics/chipscale-board.json`, { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((facts) => { if (!controller.signal.aborted && selectedIdRef.current === id && facts) setBoardFacts({ runId: id, facts }) })
      .catch(() => {})
    return () => controller.abort()
  }, [selectedId, selectedReal, refreshKey, boardGenerating, legacyMode])
  const boardStatus = legacyMode
    ? workspaceBoardStatus(boardFacts?.runId === selectedId ? boardFacts.facts : null, !!selectedRun, liveRunning, failedRun?.failure)
    : { label: nativeMode ? 'Native electronics only · inspect saved evidence' : 'Verifying workspace mode', detail: 'No legacy board or manufacturing approval is inferred.', action: null }
  const progress = workspaceProgress(legacyMode ? pipeStatus : {}, legacyMode && liveRunning, historyState)

  // RIGHT — the active stage's detailed results. One shared block for BOTH
  // layout branches (blank slate + full workspace): resize handle + icon rail
  // (VIEWS) + detail area. Every panel is behind the newDesign/!selectedRun
  // guard, so with no run selected the rail renders a clean empty state.
  // one panel switch shared by the RIGHT rail and CENTER doc tabs — same
  // components, same guards, two hosts
  const panelBody = (tb: Tab) => !legacyMode ? (
    <div className="space-y-3 p-4 text-sm"><p>{nativeMode ? 'Native electronics evidence is available in Preview under Native checks and Files.' : 'Workspace mode has not been verified. Legacy panels are not loaded.'}</p><p className="text-xs text-muted-foreground">Mechanical, thermal, firmware, manufacturing, supply and system validation are not run in the electronics-only beta. No shipping approval is inferred.</p><button type="button" className="workspace-control" onClick={() => setSurface('preview')}>Open native preview</button></div>
  ) : (
    <>
                  {(newDesign || !selectedRun) ? (
                    /* A run that FAILED is not an absence of a run. It used to
                       land here and read "No run yet" — the same words a user
                       sees before they have ever pressed anything — while the
                       left panel showed the failure. Say what happened. */
                    failedRun ? (
                      <div className="flex h-full flex-col items-start gap-2 p-5 text-xs">
                        <span className="inline-flex items-center gap-1.5 rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-destructive">
                          run failed
                        </span>
                        <p className="text-[13px] leading-relaxed text-foreground">{failedRun.failure}</p>
                        <p className="text-muted-foreground">
                          Nothing was written for this run, so there are no artifacts to show. The
                          Terminal below has the full log. Revise the description on the left, or
                          start a new design.
                        </p>
                        <span className="font-mono text-[10px] text-muted-foreground/70">{failedRun.id}</span>
                      </div>
                    ) : (
                    <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
                      {!selectedRun
                        ? 'No run yet — panels populate as the build runs.'
                        : 'No board yet — the overview appears once your new design builds.'}
                    </div>
                    )
                  ) : (
                    <>
                      {tb === 'Overview' && (
                        <>
                          <RunOverview runId={selectedRun.runDir ? selectedRun.id : null} run={selectedRun} refreshKey={refreshKey} />
                          <RevisionRail
                            runId={selectedRun.runDir ? selectedRun.id : undefined}
                            onSelectRun={selectThreadFromList}
                          />
                          <WorkQueue
                            runId={selectedRun.runDir ? selectedRun.id : undefined}
                            onResolve={revise}
                          />
                          <CommentsPanel runId={selectedRun.runDir ? selectedRun.id : undefined} />
                        </>
                      )}
                      {tb === 'Objects' && <BoardObjects real={real} />}
                      {tb === 'Artifacts' && <ArtifactExplorer revision={artifactRevision} runId={selectedRun.runDir ? selectedRun.id : null} />}
                      {tb === 'Code' && <CodeViewer key={isReal ? 'real' : 'seed'} files={isReal ? real?.ato : null} />}
                      {tb === 'BOM' && (
                        <BomWorkspace
                          lines={isReal ? real?.bom : null}
                          runId={selectedRun.runDir ? selectedRun.id : undefined}
                          onResolve={revise}
                        />
                      )}
                      {tb === 'Checks' && <BoardChecks real={real} />}
                      {tb === 'Constraints' && <ConstraintsPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
                      {tb === 'Pinout' && <PinoutPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
                      {tb === 'Advanced' && <AdvancedRoutingPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
                      {tb === 'Ingest' && <IngestPanel />}
                      {tb === 'Patterns' && <PatternsPanel />}
                      {tb === 'FL-1 Ready' && <FL1ReadinessPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
                      {tb === 'Recovery' && <RecoveryPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
                      {tb === 'Assembly' && <AssemblyPanel runId={selectedRun.runDir ? selectedRun.id : null} fabZip={null} />}
                      {tb === 'FL-1' && (
                        <div className="flex h-full flex-col">
                          <FL1ValidationView runId={selectedRun.runDir ? selectedRun.id : null} />
                          <div className="border-t border-border">
                            <FL1Loop
                              runId={selectedRun.runDir ? selectedRun.id : null}
                              onRevise={revise}
                            />
                          </div>
                        </div>
                      )}
                      {/* MERGED "what needs my attention": DRC checks + review threads + recovery */}
                      {tb === 'Review' && (
                        <>
                          <PanelSection label="Checks"><BoardChecks real={real} /></PanelSection>
                          <PanelSection label="Review"><ReviewPanel runId={selectedRun.runDir ? selectedRun.id : null} /></PanelSection>
                          <PanelSection label="Recovery"><RecoveryPanel runId={selectedRun.runDir ? selectedRun.id : null} /></PanelSection>
                        </>
                      )}
                      {/* SHIP — everything between "the board is done" and "it
                          is on its way": what it costs, who assembles it, and
                          how you prove it works. Order and Validate were two
                          rail destinations answering one question, so they are
                          one destination. 'Validate' remains a valid tab (old
                          deep links, the "+" menu) and renders the FL-1 half
                          alone. */}
                      {tb === 'Order' && (
                        <>
                          <PanelSection label="BOM">
                            <BomWorkspace
                              lines={isReal ? real?.bom : null}
                              runId={selectedRun.runDir ? selectedRun.id : undefined}
                              onResolve={revise}
                            />
                          </PanelSection>
                          <PanelSection label="Assembly"><AssemblyPanel runId={selectedRun.runDir ? selectedRun.id : null} fabZip={null} /></PanelSection>
                          <PanelSection label="Procurement · Quote"><ProcurementPanel real={real} runDir={selectedRunDir ?? null} /></PanelSection>
                        </>
                      )}
                      {(tb === 'Order' || tb === 'Validate') && (
                        <>
                          <PanelSection label="FL-1 Validation">
                            <div className="flex flex-col">
                              <FL1ValidationView runId={selectedRun.runDir ? selectedRun.id : null} />
                              <div className="border-t border-border">
                                <FL1Loop
                                  runId={selectedRun.runDir ? selectedRun.id : null}
                                  onRevise={revise}
                                />
                              </div>
                            </div>
                          </PanelSection>
                          <PanelSection label="FL-1 Readiness"><FL1ReadinessPanel runId={selectedRun.runDir ? selectedRun.id : null} /></PanelSection>
                        </>
                      )}
                    </>
                  )}

    </>
  )

  const activeDocTab = docTabs.find((d) => d.id === activeDoc) ?? null

  const rightPane = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
        <label className="min-w-0 flex-1 text-xs">
          <span className="sr-only">Details panel</span>
          <select aria-label="Details panel" value={tab} onChange={(event) => setTab(event.target.value)} className="workspace-control w-full">
            {ALL_VIEWS.map((item) => <option key={item.tab} value={item.tab}>{item.label}</option>)}
          </select>
        </label>
        <button type="button" aria-label="Close details" className="workspace-control" onClick={() => { setInspectorOpen(false); setSurface('preview') }}><X className="size-4" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {legacyMode && stage === 'id' && idBrief && <details className="border-b border-border p-2 text-xs"><summary>Industrial design brief</summary><IdBriefPanel brief={idBrief} /></details>}
        <ErrorBoundary key={`${selectedId}:${tab}`}>{panelBody(tab)}</ErrorBoundary>
      </div>
    </div>
  )

  const leftIcons = (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
      {([['chat', MessagesSquare, 'Chat'], ['threads', History, 'Threads'], ['files', FolderTree, 'Files']] as const).map(([v, Icon, label]) => (
        <button
          key={v}
          aria-pressed={leftView === v}
          onClick={() => setLeftView(v)}
          title={label}
          className={cn(
            'relative flex h-7 items-center gap-1.5 rounded px-2 text-[11px]',
            leftView === v ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50',
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
          {leftView === v && <span aria-hidden className="absolute inset-x-1 bottom-0 h-0.5 rounded bg-primary" />}
        </button>
      ))}
      <div className="ml-auto shrink-0"><LLMSettings /></div>
    </div>
  )
  const threadsPane = (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        onClick={newSession}
        className="mx-2 mt-2 flex items-center gap-1.5 rounded border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/50"
      >
        <Plus className="h-3.5 w-3.5" /> New design
      </button>
      <div className="min-h-0 flex-1 overflow-auto py-1.5">
        {draftSessions.filter((key) => !Array.from(runSessionsRef.current.values()).includes(key)).map((key, index) => (
          <button key={key} type="button" onClick={() => changeSession(key, '')} className="flex w-full px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent" aria-current={sessionKey === key && !selectedId ? 'page' : undefined}>
            Unsaved draft {index + 1}
          </button>
        ))}
        {runs.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">No designs yet.</div>}
        {/* Every row used to be one truncated title and nothing else, so twenty
            designs read as twenty identical lines. status + timestamp already
            ride along on the Run object — showing them is free. */}
        {runs.map((r: Run) => (
          <button
            key={r.id}
            onClick={() => selectThreadFromList(r.id)}
            title={`${r.name || r.id}${r.status ? ` — ${r.status}` : ''}${r.timestamp ? ` · ${r.timestamp}` : ''}`}
            className={cn(
              'relative flex w-full flex-col gap-0.5 px-3 py-1.5 text-left text-xs hover:bg-accent/50',
              r.id === selectedId && !newDesign ? 'bg-accent text-foreground' : 'text-muted-foreground',
            )}
          >
            {r.id === selectedId && !newDesign && <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 bg-primary" />}
            <span className="flex w-full min-w-0 items-center gap-1.5">
              <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', runDot(r.status))} />
              <span className="min-w-0 flex-1 truncate">{r.name || r.id}</span>
            </span>
            {(r.status || r.timestamp) && (
              <span className="flex w-full min-w-0 items-center gap-1.5 pl-3 font-mono text-[10px] text-muted-foreground/70">
                {r.status && <span className="shrink-0 uppercase tracking-wide">{r.status}</span>}
                {r.status && r.timestamp && <span aria-hidden>·</span>}
                {r.timestamp && <span className="min-w-0 truncate">{r.timestamp}</span>}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
  const filesPane = (
    <div className="flex min-h-0 flex-1 flex-col">
      {legacyMode ? <ArtifactExplorer revision={artifactRevision} runId={selectedRun?.runDir ? selectedRun.id : null} compact onOpen={openFileTab} /> : <div className="p-4 text-xs"><p>Native downloads are limited to verified manifest files.</p><button type="button" className="workspace-control mt-3" onClick={() => setSurface('preview')}>Open Preview, then Files</button></div>}
    </div>
  )

  const boardBase = selectedRunDir ? `${selectedRunDir}/board` : '/board'
  // The run has a bespoke chip-scale board — point Layout + Schematic at ITS
  // artwork (the flroute reference schematic/layout still shows a Pico otherwise).
  const hasChip = real?.board?.source === 'chip-scale chip-down board'
  const chipPcbSvg = selectedRun ? `/runs/${selectedRun.id}/electronics/chipscale.svg` : ''
  const chipSchemSvg = selectedRun ? `/runs/${selectedRun.id}/electronics/chipscale-schematic.svg` : ''

  // Center strip: keep the stages that produce real primary output inline; demote
  // the advisory-fidelity ones (mechanical CAD + simulation — honestly first-pass,
  // not fit/tolerance-validated) into a "More" overflow so the default strip is the
  // linear happy path. Every stage stays fully functional and switchable; the
  // availability/lock logic is shared so both hosts behave identically.
  const ADVISORY_STAGES: Stage[] = ['mechanical', 'simulation']
  const stageMeta = (key: Stage) => {
    const needsSpec = ['explore', 'firmware', 'manufacturing', 'supplyChain', 'validation'].includes(key)
    const avail = needsSpec ? (!!productSpec || !!selectedRun) : key === 'electronics' ? (!!selectedRun || !!productSpec) : key === 'id' ? (!!productSpec || !!idBrief || !!selectedRun) : true
    const locked = !avail && (needsSpec || key === 'electronics' || key === 'id')
    return { needsSpec, avail, locked }
  }
  const clearBadge = (key: string) => setBadged((b) => { if (!(key in b)) return b; const n = { ...b }; delete n[key]; return n })

  const conversation = <>
    {leftIcons}
    {leftView === 'threads' && threadsPane}
    {leftView === 'files' && filesPane}
    {!metadataReady && selectedRun?.real && <div role={specReadError ? 'alert' : 'status'} className="p-3 text-xs text-muted-foreground">{retainedImportRun === selectedId ? 'Imported files are available for inspection. Generation and chat revisions require a complete product specification; this import only contains retained-file metadata.' : specReadError || 'Loading saved design metadata. Sending is paused until the correct revision is available.'}{specReadError && <button type="button" className="workspace-control mt-2" onClick={() => setSpecReadRevision((revision) => revision + 1)}>Retry metadata</button>}</div>}
    {/* One shell and one mounted chat: utility panes never reset the interview. */}
    <div hidden={leftView !== 'chat'} inert={importBusy || boardGenerating} className="flex min-h-0 flex-1 flex-col">
      <ComposeChat
        sessionKey={sessionKey} onBusyChange={onBusyChange}
        generationDisabled={boardGenerating || importBusy || !metadataReady || !!astraMode.generationBlocker || (selectedNative && !astraMode.beta)} canStartGeneration={() => !boardBusyRef.current && !importBusyRef.current && metadataReadyRef.current && !astraMode.generationBlocker && (!selectedNative || astraMode.beta)}
        onRetryMetadata={() => setSpecReadRevision((revision) => revision + 1)}
        onArtifactsChanged={(id) => { if (selectedIdRef.current === id) { setArtifactRevision((revision) => revision + 1); setStageRefreshRevision((revision) => revision + 1); setTimingHistory(null); setHistoryRevision((revision) => revision + 1); if (nativeMode) void refreshRuns() } }}
        threads={runs.map((run) => ({ id: run.id, label: run.name || run.id }))}
        activeId={selectedId}
        activeRunId={!newDesign && selectedRun?.real ? selectedRun.id : undefined}
        activeName={selectedRun?.name} newDesign={!selectedRun || newDesign}
        revisePrefill={revisePrefill} onPrefillConsumed={onPrefillConsumed}
        onSelectThread={selectThreadFromList} onNew={newSession}
        builtDisciplines={legacyMode ? builtDisc : {}} pipelineStatus={legacyMode ? pipeStatus : {}} pipelineRunning={legacyMode && pipeRunning} pipelineHistoryState={legacyMode ? historyState : 'unavailable'}
        pipelineFeedback={legacyMode ? pipeFeedback : null} onRunPipeline={legacyMode ? () => runPipeline() : undefined} onStopPipeline={legacyMode ? stopPipeline : undefined}
        onProductBuilt={onProductBuilt} onRunComplete={onRunComplete} onRunStart={onRunStart} onRunFailed={onRunFailed}
        onIdBrief={onIdBrief} onProductSpec={onProductSpec} productSpec={productSpec}
        onRename={async (id, name) => {
          if (!legacyMode) return
          await fetch('/api/runs/rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, name }) }).catch(() => {})
          await refreshRuns()
        }}
      />
    </div>
  </>
  const preview = !legacyMode ? (
    nativeMode && selectedId ? <ErrorBoundary key={`native:${selectedId}`}><AstraNativeStage runId={selectedId} refreshKey={`${artifactRevision}:${stageRefreshRevision}:${historyRevision}`} /></ErrorBoundary>
      : <div className="workspace-start"><div className="workspace-start-copy"><h2>{nativeMode ? 'Select the supported BME280 breakout' : 'Verifying workspace mode'}</h2><p>{nativeMode ? 'Review the fixed requirements in Conversation, select the template, then explicitly generate it. Unrelated drafts are preserved and are not submitted. Saved native artifacts appear here. Other disciplines are not run.' : 'No board reader or exporter is loaded until the current mode is known.'}</p>{astraMode.availability.state === 'error' && <button type="button" className="workspace-control" onClick={astraMode.retryStatus}>Retry workspace status</button>}<button type="button" className="workspace-control" onClick={() => { setLeftView('chat'); setSurface('conversation') }}>Open conversation</button></div></div>
  ) : <>
    {selectedRun && <RunTimeline active={activeDoc ? '' : stage} historyState={historyState}
      onSelect={(key) => { setStage(key as Stage); setActiveDoc(null); setFollowBuild(false); clearBadge(key) }}
      stages={STAGES.map((item) => ({ ...item, state: pipeStatus[item.key]?.status, detail: pipeStatus[item.key]?.detail, badged: badged[item.key], locked: stageMeta(item.key).locked, advisory: ADVISORY_STAGES.includes(item.key) }))} />}
    {selectedRun && <div className="workspace-progress">
      <div className="workspace-progress-summary"><span className="text-foreground" role="status">{progress.label}</span>
        {progress.total > 0 && <span> · {progress.passed} passed{progress.running > 0 ? ` · ${progress.running} running` : ''}{progress.failed > 0 ? ` · ${progress.failed} failed` : ''}{progress.blocked > 0 ? ` · ${progress.blocked} blocked` : ''}{progress.pending > 0 ? ` · ${progress.pending} pending` : ''}{progress.skipped > 0 ? ` · ${progress.skipped} skipped` : ''}{progress.unknown > 0 ? ` · ${progress.unknown} unknown` : ''}</span>}
      </div>
      {progress.total > 0 && <button type="button" className="workspace-control" aria-pressed={followBuild} onClick={() => setFollowBuild(!followBuild)}>{followBuild ? 'Back to preview' : 'Follow build'}</button>}
      {(historyState === 'unavailable' || busyMessage.includes('history')) && <button type="button" className="workspace-control" onClick={() => { setTimingHistory(null); setHistoryRevision((revision) => revision + 1) }}>Retry history</button>}
      {pipeRunning && <button type="button" className="workspace-control" title="Stop observing and scheduling stages. Server work already submitted may continue." onClick={stopPipeline}>Stop updates</button>}
    </div>}
    {boardReadError && <div role="alert" className="border-b border-border p-3 text-xs">{boardReadError}<button type="button" className="workspace-control mt-2" onClick={() => setArtifactRevision((revision) => revision + 1)}>Retry board metadata</button></div>}
    {failedRun && <div role="status" className="border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-xs"><p>{failedRun.failure}</p><button type="button" className="mt-2 underline underline-offset-2" onClick={() => { setLeftView('chat'); setSurface('conversation') }}>Open conversation to recover</button></div>}
    {selectedRun && <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border p-1.5">
      {docTabs.map((doc) => <div key={doc.id} className={cn('flex items-center rounded border border-border text-xs', activeDoc === doc.id && 'bg-accent')}>
        <button type="button" className="px-2 py-1.5" onClick={() => { setActiveDoc(doc.id); setFollowBuild(false) }}>{doc.label}</button>
        <button type="button" className="p-1.5" aria-label={`Close ${doc.label}`} onClick={() => closeDoc(doc.id)}><X className="size-3" /></button>
      </div>)}
      {activeDoc && <button type="button" className="workspace-control" onClick={() => setActiveDoc(null)}>Back to stage</button>}
      <select aria-label="Open panel as document" value="" className="workspace-control ml-auto max-w-full" onChange={(event) => {
        const item = ALL_VIEWS.find((view) => view.tab === event.target.value)
        if (item) { openPanelTab(item.tab, item.label); setFollowBuild(false) }
      }}><option value="">Open panel…</option>{ALL_VIEWS.map((item) => <option key={item.tab} value={item.tab}>{item.label}</option>)}</select>
    </div>}
    {!selectedRun ? <div className="workspace-start">
      <div className="workspace-start-copy">
        <span className="text-xs text-primary">From intent to inspectable engineering</span>
        <h2>What do you want to build?</h2>
        <p>Describe the product in Conversation. Include the job it should do, power source and any size or part constraints. Review the plan before starting a build.</p>
        <div className="workspace-examples">
          {['A USB-C temperature logger', 'A solar-powered soil sensor', 'A compact motor controller'].map((example) => <button type="button" key={example} onClick={() => revise(example)}>{example}</button>)}
        </div>
        <p className="mt-2 text-[11px]">Examples only fill the conversation. Nothing runs until you submit.</p>
        <button type="button" className="workspace-control mt-4" onClick={() => { setLeftView('chat'); setSurface('conversation') }}>Open conversation</button>
      </div>
      <ImportDesignPanel key={sessionKey} onImported={handleImported} onBusyChange={(busy) => { importBusyRef.current = busy; setImportBusy(busy) }} canStart={() => !chatBusyRef.current && !boardBusyRef.current && !pipeAbort.current && !importBusyRef.current} />
    </div> : followBuild ? <section aria-label="Build progress" className="min-h-0 flex-1 overflow-auto p-4">
      <h2 className="text-sm font-medium">{progress.label}</h2>
      {!liveRunning && <p className="mt-2 text-xs text-muted-foreground">Saved artifacts remain available. This view does not confirm that server work is running or cancelled.</p>}
      <ul className="mt-4 space-y-3">{STAGES.filter((item) => item.key in pipeStatus).map((item) => <li key={item.key} className="text-xs">
        <span className="font-medium">{item.label} · {workspaceStageLabel(pipeStatus[item.key]?.status, historyState)}</span>
        {pipeStatus[item.key]?.detail && <p className="mt-1 text-muted-foreground">{pipeStatus[item.key].detail}</p>}
      </li>)}</ul>
    </section> : activeDocTab ? (
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeDocTab.kind === 'file' && selectedRun?.runDir ? <FilePreview revision={artifactRevision} key={`${selectedId}:${activeDocTab.id}:${artifactRevision}`} runId={selectedRun.id} file={activeDocTab.file!} />
          : activeDocTab.kind === 'panel' ? <div className="h-full overflow-y-auto"><ErrorBoundary key={`${selectedId}:${activeDocTab.id}`}>{panelBody(activeDocTab.panel!)}</ErrorBoundary></div> : null}
      </div>
    ) : null}
    <div hidden={!selectedRun || followBuild || !!activeDocTab} inert={!selectedRun || followBuild || !!activeDocTab} className="min-h-0 flex-1 flex flex-col">
    {selectedRun && (failedRun && !manualStage && !isReal && !boardFacts && stage === 'electronics' ? (
      <div className="workspace-waiting"><h2 className="font-medium">No board artifact is available</h2><p>Saved files and diagnostics remain accessible. Review the reported issue in Conversation before starting another build.</p><button type="button" className="workspace-control" onClick={() => { setTermTab('problems'); if (termCollapsed) toggleTerm() }}>View problems</button></div>
    ) : pipeRunning && !builtDisc[stage] && pipeStatus[stage]?.status !== 'passed' && !(stage === 'electronics' && boardFacts?.runId === selectedId) && !(stage === 'id' && idBrief) ? (
      <div className="workspace-waiting"><h2 className="font-medium">{STAGES.find((item) => item.key === stage)?.label} output is not available yet</h2><p>The build is still working. You can inspect available stages or open Files without interrupting it.</p><button type="button" className="workspace-control" onClick={() => { setLeftView('files'); setSurface('conversation') }}>Browse files</button></div>
    ) : <>
        {stage === 'explore' && (
              <ErrorBoundary><ExploreStage spec={productSpec} runId={selectedRun?.id} /></ErrorBoundary>
            )}
            {(stage === 'electronics' || manualStage === 'electronics') && <div hidden={stage !== 'electronics'} inert={stage !== 'electronics'} className="min-h-0 flex-1 flex flex-col">{
              // For a bespoke prompt (productSpec set) the real electronics is
              // the chip-scale synthesized bare-chip board, not the fixed RP2040
              // reference board — so lead with it. The reference board still
              // shows for the canned demo run (no productSpec).
              productSpec || retainedImportRun === selectedId ? (
                <ErrorBoundary><ChipScaleStage key={`${selectedId}:${stageRefreshRevision}`} {...generationProps('electronics')} spec={productSpec} runId={selectedRun?.id} asElectronics /></ErrorBoundary>
              ) : selectedRun?.real && specResolvedRun !== selectedId ? (
                <div role={specReadError ? "alert" : "status"} className="workspace-waiting">{specReadError || 'Loading saved design metadata before opening its artifacts…'}{specReadError && <button type="button" className="workspace-control" onClick={() => setSpecReadRevision((revision) => revision + 1)}>Retry metadata</button>}</div>
              ) : (
              <>
                <div className="flex items-center gap-3 border-b border-border px-3 py-2">
                  <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
                    {!newDesign && isReal && tab !== 'Overview' && <ReviewsPill real={real} />}
                    {!newDesign && isReal && real?.board?.bomTotal ? (
                      <span className="shrink-0 border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                        title="component BOM estimate — not fab, not a quote">
                        ~${Number(real.board.bomTotal).toFixed(2)} BOM
                      </span>
                    ) : null}
                    <button type="button" onClick={() => showInspector('Patterns')}
                      className="flex shrink-0 items-center gap-1 border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                      title="reusable patterns & ingested knowledge">
                      <BookOpen className="size-3" /> Knowledge
                    </button>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="flex overflow-hidden border border-border">
                      {([['3d', '3D'], ['layout', 'Layout'], ['schematic', 'Schematic']] as const).map(([v, label]) => (
                        <button key={v} type="button" onClick={() => setView(v)}
                          className={cn('px-2.5 py-0.5 text-[11px]',
                            view === v ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                          {label}
                        </button>
                      ))}
                    </div>
                    <button type="button" onClick={toggleFullscreen} title="fullscreen board"
                      className="border border-border p-1 text-muted-foreground hover:text-foreground">
                      <Maximize2 className="size-3.5" />
                    </button>
                  </div>
                </div>
                <div ref={stageRef} className="min-h-0 flex-1 bg-background">
                  <ErrorBoundary>
                    <>
                        {view === '3d' && (
                          <Board3D basePath={boardBase} fallback={
                            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">no 3D model for this run</div>} />
                        )}
                        {view === 'layout' && (
                          hasChip
                            ? <div className="flex h-full items-center justify-center overflow-auto bg-white p-4">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={`${chipPcbSvg}?t=${selectedRun?.id}`} alt="chip-scale PCB layout" className="max-h-full w-auto" />
                              </div>
                            : <BoardCanvas key={selectedRun?.id} run={selectedRun}
                                realBoard={isReal ? real?.board : null} basePath={boardBase} />
                        )}
                        {view === 'schematic' && (
                          hasChip
                            ? <div className="flex h-full items-center justify-center overflow-auto bg-white p-4">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={`${chipSchemSvg}?t=${selectedRun?.id}`} alt="chip-scale schematic" className="max-h-full w-auto" />
                              </div>
                            : <BoardSchematic runDir={selectedRunDir ?? null} />
                        )}
                      </>
                  </ErrorBoundary>
                </div>
              </>
              )
            }</div>}
            {(stage === 'id' || manualStage === 'id') && <div hidden={stage !== 'id'} inert={stage !== 'id'} className="min-h-0 flex-1 flex flex-col">
              <ErrorBoundary>
                <IdStage key={`${selectedId}:${stageRefreshRevision}`} {...generationProps('id')} spec={productSpec} runId={selectedRun?.id} brief={idBrief} onBrief={(brief) => { if (selectedIdRef.current === selectedId) setIdBrief(brief) }} boardMm={isReal ? real?.board?.boardSize : undefined} />
              </ErrorBoundary>
            </div>}
            {(stage === 'mechanical' || manualStage === 'mechanical') && <div hidden={stage !== 'mechanical'} inert={stage !== 'mechanical'} className="min-h-0 flex-1 flex flex-col">
              <ErrorBoundary><MechanicalStage key={`${selectedId}:${stageRefreshRevision}`} {...generationProps('mechanical')} spec={productSpec} runId={selectedRun?.id} /></ErrorBoundary>
            </div>}
            {(stage === 'simulation' || manualStage === 'simulation') && <div hidden={stage !== 'simulation'} inert={stage !== 'simulation'} className="min-h-0 flex-1 flex flex-col">
              <ErrorBoundary><SimulationStage key={`${selectedId}:${stageRefreshRevision}`} {...generationProps('simulation')} spec={productSpec} runId={selectedRun?.id} /></ErrorBoundary>
            </div>}
            {(['firmware', 'manufacturing', 'supplyChain', 'validation'] as const).map((discipline) => (stage === discipline || manualStage === discipline) && <div key={discipline} hidden={stage !== discipline} inert={stage !== discipline} className="min-h-0 flex-1 flex flex-col">
              <ErrorBoundary><DisciplineStage key={`${selectedId}:${discipline}:${stageRefreshRevision}`} {...generationProps(discipline)} discipline={discipline} spec={productSpec} runId={selectedRun?.id} /></ErrorBoundary>
            </div>)}
    </>)}
    </div>
  </>

  return <main className="compose-workspace bg-background text-foreground">
    <a className="workspace-skip" href="#workspace-preview" onClick={() => setSurface('preview')}>Skip to design preview</a>
    <header className="workspace-header">
      <div className="workspace-header-title"><h1>{selectedRun?.name || productSpec?.product || 'New design'}</h1><p className="workspace-header-status" title={boardStatus.detail}>{boardStatus.label}</p></div>
      <button type="button" className="workspace-control" onClick={newSession}><Plus className="mr-1 inline size-3.5" />New design</button>
      {boardStatus.action && <button type="button" className="workspace-control workspace-primary" onClick={() => showInspector(boardStatus.action === 'Review manufacturing' ? 'Order' : 'Review')}>{boardStatus.action}</button>}
    </header>
    {(busyMessage || importBusy) && <div role="status" className="border-b border-border px-4 py-2 text-xs text-primary">{busyMessage || 'Import in progress. Conversation resumes when the import finishes.'}</div>}
    <WorkspacePanes conversation={conversation} preview={preview} details={rightPane} surface={surface} onSurfaceChange={setSurface} inspectorOpen={inspectorOpen} onInspectorChange={setInspectorOpen} />
    <TerminalPanel collapsed={termCollapsed} onToggle={toggleTerm} tab={termTab} onTabChange={setTermTab} />
    {legacyMode ? <StatusBar runId={selectedId || null} runName={selectedRun?.name ?? null} pipeline={pipeStatus} running={liveRunning} historyState={historyState}
      tiers={llmTiers} problemCount={problemCount} onProblemsClick={() => { setTermTab('problems'); if (termCollapsed) toggleTerm() }} startedAt={pipeRunning ? pipeStartedAt : null} />
      : <footer className="border-t border-border px-4 py-2 text-xs text-muted-foreground">{nativeMode ? 'Astra beta · electronics only · saved checks are authoritative' : 'Workspace mode unverified'}{selectedId ? ` · ${selectedId}` : ''}</footer>}
  </main>
}
