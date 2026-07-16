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
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { loadRealBoard, type RealBoard } from '@/lib/real-board'
import { ComposeChat } from '@/components/compose-chat'
import { BoardCanvas } from '@/components/board-canvas'
import { Board3D } from '@/components/board-3d'
import { CodeViewer } from '@/components/code-viewer'
import { BomTable } from '@/components/bom-table'
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
import { RevisionRail } from '@/components/revision-rail'
import { WorkQueue } from '@/components/work-queue'
import { CommentsPanel } from '@/components/comments-panel'
import { ArtifactExplorer, FilePreview } from '@/components/artifact-explorer'
import { FL1ReadinessPanel } from '@/components/fl1-readiness-panel'
import { BoardObjects } from '@/components/board-objects'
import { ReviewsPill } from '@/components/board-reviews'
import { IdStageView } from '@/components/id-stage-view'
import { IdStage } from '@/components/id-stage'
import { IdBriefPanel } from '@/components/id-brief-panel'
import { ExploreStage } from '@/components/explore-stage'
import { MechanicalStage } from '@/components/mechanical-stage'
import { SimulationStage } from '@/components/simulation-stage'
import { DisciplineStage } from '@/components/discipline-stage'
import { ChipScaleStage } from '@/components/chipscale-stage'
import { PipelineLoader } from '@/components/pipeline-loader'
import { TerminalPanel, type TerminalTab } from '@/components/terminal-panel'
import { StatusBar } from '@/components/status-bar'
import { logLine, useProblemCount } from '@/lib/terminal-log'
import { llmHeaders, LLM_PROVIDERS } from '@/components/llm-settings'
import { runFullPipeline, PIPE_ORDER, type PipeStatus } from '@/lib/run-pipeline'
import type { IdBrief } from '@/lib/id-brief'
import type { ProductSpec } from '@/lib/product-spec'
import {
  Activity, BookOpen, Box, ClipboardCheck, Code, Cpu, Eye, Factory, FolderTree, Gauge, History, LayoutDashboard, ListTree, Maximize2,
  MessagesSquare, Package, Palette, Plus, Receipt, ScrollText, ShieldCheck, Sparkles, Truck, Wrench, X,
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

// flat view list: one icon → one panel (Board lives in the center hero).
// Two columns only — icons left, content right, no sub-tabs.
const VIEWS: { tab: Tab; label: string; Icon: any }[] = [
  { tab: 'Overview', label: 'Overview', Icon: LayoutDashboard },
  { tab: 'Objects', label: 'Objects', Icon: ListTree },
  { tab: 'Checks', label: 'Checks', Icon: ClipboardCheck },
  { tab: 'Review', label: 'Review', Icon: Eye },
  { tab: 'Order', label: 'Quote', Icon: Receipt },
  { tab: 'BOM', label: 'BOM', Icon: Package },
  { tab: 'Assembly', label: 'Assembly', Icon: Wrench },
  { tab: 'FL-1', label: 'FL-1', Icon: Activity },
  { tab: 'FL-1 Ready', label: 'Ready', Icon: Gauge },
  { tab: 'Artifacts', label: 'Files', Icon: ScrollText },
]

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

/** Honest placeholder for a stage whose specialist module isn't built yet. */
function StagePlaceholder({ title, Icon }: { title: string; Icon: any }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
      <Icon className="size-9 opacity-25" />
      <span className="text-sm font-medium text-foreground">{title}</span>
      <span className="max-w-xs text-xs">This module isn&apos;t built yet. When it is, its output will appear here in the pipeline — nothing is faked.</span>
    </div>
  )
}

export default function Compose2Page() {
  const [runs, setRuns] = useState<Run[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [realBoard, setRealBoard] = useState<RealBoard | null>(null)
  const [tab, setTab] = useState<Tab>('Overview')
  const [view, setView] = useState<'3d' | 'layout' | 'schematic'>('3d')
  // which pipeline stage the middle+right panes show; auto-advances as the
  // pipeline runs (board builds -> Electronics; ID finishes -> Industrial Design)
  const [stage, setStage] = useState<Stage>('electronics')
  const [idBrief, setIdBrief] = useState<IdBrief | null>(null)
  const [productSpec, setProductSpec] = useState<ProductSpec | null>(null)
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
  const [pipeStatusByRun, setPipeStatusByRun] = useState<Record<string, Record<string, { status: PipeStatus; detail?: string }>>>({})
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
  // an FL-1 loop ECO gets dropped into the chat as a revision (single-pane flow)
  const [revisePrefill, setRevisePrefill] = useState('')
  const stageRef = useRef<HTMLDivElement>(null)
  const toggleFullscreen = () => {
    const el = stageRef.current
    if (!el) return
    if (document.fullscreenElement) document.exitFullscreen()
    else el.requestFullscreen?.()
  }

  const refreshRuns = () =>
    fetch('/api/runs').then((r) => (r.ok ? r.json() : { runs: [] }))
      .then(({ runs: disk }: { runs: Run[] }) => { if (Array.isArray(disk)) setRuns(disk); return disk })
      .catch(() => [])
  const onRunComplete = async (runDir: string, id: string) => {
    const disk = await refreshRuns()
    // ALWAYS select the just-built run. It definitely exists (we hold its
    // runDir), but /api/runs is eventually consistent — a freshly-built run can
    // be missing from that list for a beat. The old code guarded setSelectedId
    // on the run appearing in that list, so on the race it silently kept the
    // PREVIOUS run selected, and every discipline tab then fetched the wrong
    // run's artifacts and 404'd (showing an empty "Generate" state though the
    // pipeline had built everything). If the list missed it, inject a minimal
    // entry so selectedRun resolves to it instead of falling back to runs[0].
    if (!(Array.isArray(disk) && disk.find((r: Run) => r.id === id))) {
      setRuns((prev: Run[]) =>
        prev.some((r) => r.id === id) ? prev : [{ id, runDir, real: true, name: id }, ...prev])
    }
    setSelectedId(id)
    const d = await loadRealBoard(runDir); if (d) setRealBoard(d)
    setNewDesign(false) // the freshly-built board now takes the stage
    setStage('electronics') // show the real board first; ID advances the stage after
  }
  // the chat lifts up the ID brief when Industrial Design finishes; advancing to
  // that stage so the form (wrapping the real board) is what's on screen.
  const onIdBrief = (b: IdBrief | null) => {
    setIdBrief(b)
    setStage(b ? 'id' : 'electronics')
  }

  // resizable panes (drag the dividers); persisted per browser
  const [leftW, setLeftW] = useState(288)
  // left-pane mode: chat (conversation), threads (design list), files (run tree)
  const [leftView, setLeftView] = useState<'chat' | 'threads' | 'files'>('chat')
  // CENTER tab strip: pinned stage tabs + closable doc tabs (files/panels).
  // activeDoc null = the pinned stage view is showing.
  const [docTabs, setDocTabs] = useState<DocTab[]>([])
  const [activeDoc, setActiveDoc] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  // badge-don't-steal-focus: a stage finishing while not visible gets a dot
  const [badged, setBadged] = useState<Record<string, 'passed' | 'failed'>>({})
  const prevPipeRef = useRef<Record<string, string>>({})
  const openFileTab = (f: { name: string; path: string; size?: number }) => {
    const id = `file:${f.path}`
    setDocTabs((ts) => (ts.some((d) => d.id === id) ? ts : [...ts, { id, kind: 'file' as const, label: f.name, file: f }]))
    setActiveDoc(id)
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
  const [rightW, setRightW] = useState(480)
  const dragRef = useRef<null | 'left' | 'right'>(null)
  // mirrors dragRef as state so the active Handle can stay highlighted while the
  // pointer travels beyond it mid-drag
  const [dragging, setDragging] = useState<null | 'left' | 'right'>(null)

  useEffect(() => {
    const l = Number(localStorage.getItem('c2-leftW'))
    const r = Number(localStorage.getItem('c2-rightW'))
    if (l >= 200) setLeftW(l)
    if (r >= 280) setRightW(r)
    setTermCollapsed(localStorage.getItem('c2-termCollapsed') !== '0') // default collapsed
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      if (dragRef.current === 'left') setLeftW(Math.min(600, Math.max(200, e.clientX)))
      else setRightW(Math.min(760, Math.max(280, window.innerWidth - e.clientX)))
    }
    const onUp = () => {
      if (!dragRef.current) return
      dragRef.current = null
      setDragging(null)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // persist current widths
      setLeftW((w) => { localStorage.setItem('c2-leftW', String(w)); return w })
      setRightW((w) => { localStorage.setItem('c2-rightW', String(w)); return w })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // Terminal panel collapse toggle, persisted alongside the pane widths
  const toggleTerm = () => setTermCollapsed((c) => {
    localStorage.setItem('c2-termCollapsed', c ? '0' : '1') // '0' = open
    return !c
  })

  // model tier for the status bar (client-only read of the llm-settings storage)
  useEffect(() => {
    const id = localStorage.getItem('fl-llm-provider') ?? ''
    setLlmTiers([LLM_PROVIDERS.find((p) => p.id === id)?.label ?? 'Platform default'])
  }, [])

  const startDrag = (which: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = which
    setDragging(which)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }
  // Divider between panes: a 5px grab area (negative margins keep the layout at
  // 1px — the pane's own border-border edge stays the visible line) that lights
  // up amber on hover/drag, matching the terminal panel's drag edge.
  const Handle = ({ which }: { which: 'left' | 'right' }) => (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={startDrag(which)}
      onDoubleClick={() => which === 'left' ? setLeftW(288) : setRightW(480)}
      title="drag to resize · double-click to reset"
      className={cn(
        'relative z-10 -mx-0.5 w-[5px] shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-primary/40',
        dragging === which && 'bg-primary/40',
      )}
    />
  )

  // load real runs from disk (same source as /compose)
  useEffect(() => {
    fetch('/api/runs').then((r) => (r.ok ? r.json() : { runs: [] }))
      .then(({ runs: disk }: { runs: Run[] }) => {
        if (Array.isArray(disk) && disk.length) {
          setRuns(disk)
          // Do NOT auto-select the last run on load — a fresh page open starts on a
          // blank slate (the "describe a product" prompt), not the previous board.
          // Past runs stay available via the ☰ menu.
        }
      }).catch(() => {})
  }, [])

  // No runs[0] fallback: with no explicit selection (fresh load) selectedRun is
  // undefined → the stage renders its blank/new-design slate, not the last board.
  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedId), [runs, selectedId])
  const selectedRunDir = selectedRun?.runDir
  const selectedReal = selectedRun?.real

  useEffect(() => { productSpecRef.current = productSpec }, [productSpec])
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])

  // What the UI renders: the SELECTED run's pipeline state. A pipeline running
  // for a different run keeps streaming into its own map entry silently.
  const pipeStatus = selectedId ? (pipeStatusByRun[selectedId] ?? {}) : {}
  const pipeFeedback = selectedId ? (pipeFeedbackByRun[selectedId] ?? null) : null
  const pipeRunning = !!pipelineRunId && pipelineRunId === selectedId

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
    if (newDesign || !selectedRun?.real || !id || productSpecRef.current) return
    let off = false
    const j = (p: string) => fetch(p, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    const head = (p: string) => fetch(p, { method: 'HEAD', cache: 'no-store' }).then((r) => r.ok).catch(() => false)
    j(`/runs/${id}/product-spec.json`).then((s) => { if (!off && s?.product) setProductSpec(s) })
    j(`/runs/${id}/disciplines/id-brief.json`).then((b) => { if (!off && b?.product) setIdBrief(b) })
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
      if (!off) setBuiltDisc(Object.fromEntries(found.filter(Boolean).map((k) => [k as string, true])))
    })
    return () => { off = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRun?.id, selectedRun?.real, newDesign])

  // Run the WHOLE pipeline end-to-end: chip-scale electronics -> mechanical ->
  // simulation -> feedback loop -> firmware -> mfg -> supply -> validation. Reuses
  // each discipline's real API (the same the manual buttons call); the sequencer
  // just orders them so each grounds on the real board, and wires the feedback
  // loop. Live status streams into the disciplines panel via pipeStatus.
  const runPipeline = async (runIdArg?: string) => {
    const runId = runIdArg || selectedRun?.id
    const spec = productSpecRef.current
    if (!spec || !runId || pipeAbort.current) return
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
        if (res.updatedSpec) setProductSpec(res.updatedSpec)
        setBuiltDisc((prev) => {
          const next = { ...prev }
          for (const [k, v] of Object.entries(res.stages)) if (v?.status === 'passed') next[k] = true
          return next
        })
      }
    } catch { /* aborted or fatal — status already reflects where it stopped */ }
    finally { setPipelineRunId(null); setPipeStartedAt(null); pipeAbort.current = null }
  }
  const stopPipeline = () => { pipeAbort.current?.abort(); setPipelineRunId(null); setPipeStartedAt(null) }

  // Auto-start the full pipeline the moment a PRODUCT's board finishes building.
  // compose-chat calls this with the exact runId it just built (from the build's
  // 'done' event), so the pipeline always runs on the right run — no race with the
  // previously-selected run. Fires regardless of whether the flroute reference
  // board gate-failed (the chip-scale board the pipeline builds is what matters).
  // `pipeStarted` guards to once per run.
  const onProductBuilt = (runId: string) => {
    if (!runId || pipeStarted.current.has(runId)) return
    pipeStarted.current.add(runId)
    runPipeline(runId)
  }

  // load the selected run's own snapshot
  useEffect(() => {
    if (!selectedReal) { setRealBoard(null); return }
    let cancelled = false
    loadRealBoard(selectedRunDir ?? '').then((d) => { if (!cancelled) setRealBoard(d) })
    return () => { cancelled = true }
  }, [selectedReal, selectedRunDir])

  const real = realBoard && realBoard.base === (selectedRunDir ?? '') ? realBoard : null
  const isReal = selectedRun?.real === true && real !== null

  // RIGHT — the active stage's detailed results. One shared block for BOTH
  // layout branches (blank slate + full workspace): resize handle + icon rail
  // (VIEWS) + detail area. Every panel is behind the newDesign/!selectedRun
  // guard, so with no run selected the rail renders a clean empty state.
  // one panel switch shared by the RIGHT rail and CENTER doc tabs — same
  // components, same guards, two hosts
  const panelBody = (tb: Tab) => (
    <>
                  {(newDesign || !selectedRun) ? (
                    <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
                      {!selectedRun
                        ? 'No run yet — panels populate as the build runs.'
                        : 'No board yet — the overview appears once your new design builds.'}
                    </div>
                  ) : (
                    <>
                      {tb === 'Overview' && (
                        <>
                          <RunOverview runId={selectedRun.runDir ? selectedRun.id : null} run={selectedRun} />
                          <RevisionRail
                            runId={selectedRun.runDir ? selectedRun.id : undefined}
                            onSelectRun={(rid) => { setSelectedId(rid); setNewDesign(false); setIdBrief(null); setProductSpec(null); setStage('electronics'); setBuiltDisc({}) }}
                          />
                          <WorkQueue
                            runId={selectedRun.runDir ? selectedRun.id : undefined}
                            onResolve={(prompt) => setRevisePrefill(prompt)}
                          />
                          <CommentsPanel runId={selectedRun.runDir ? selectedRun.id : undefined} />
                        </>
                      )}
                      {tb === 'Objects' && <BoardObjects real={real} />}
                      {tb === 'Artifacts' && <ArtifactExplorer runId={selectedRun.runDir ? selectedRun.id : null} />}
                      {tb === 'Code' && <CodeViewer key={isReal ? 'real' : 'seed'} files={isReal ? real?.ato : null} />}
                      {tb === 'BOM' && (
                        <BomWorkspace
                          lines={isReal ? real?.bom : null}
                          runId={selectedRun.runDir ? selectedRun.id : undefined}
                          onResolve={(prompt) => setRevisePrefill(prompt)}
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
                      {tb === 'Review' && <ReviewPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
                      {tb === 'FL-1' && (
                        <div className="flex h-full flex-col">
                          <FL1ValidationView runId={selectedRun.runDir ? selectedRun.id : null} />
                          <div className="border-t border-border">
                            <FL1Loop
                              runId={selectedRun.runDir ? selectedRun.id : null}
                              onRevise={(eco) => setRevisePrefill(eco)}
                            />
                          </div>
                        </div>
                      )}
                      {tb === 'Order' && <ProcurementPanel real={real} runDir={selectedRunDir ?? null} />}
                    </>
                  )}

    </>
  )

  const activeDocTab = docTabs.find((d) => d.id === activeDoc) ?? null

  const rightPane = (
    <>
      <Handle which="right" />
      <section style={{ width: rightW }} className="flex shrink-0 border-l border-border">
        {stage === 'electronics' ? (
          <>
            <nav className="flex w-12 shrink-0 flex-col overflow-y-auto border-r border-border bg-card/30 py-1">
              {VIEWS.map((v) => {
                const on = tab === v.tab
                return (
                  <button key={v.tab} type="button" onClick={() => setTab(v.tab)} title={v.label}
                    className={cn('relative flex w-full flex-col items-center gap-0.5 px-0.5 py-2 text-[8px]',
                      on ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                    {/* VS Code-style active indicator: 2px amber left edge, no pill */}
                    {on && <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 bg-primary" />}
                    <v.Icon className={cn('size-4', on && 'text-primary')} />
                    <span className="leading-none">{v.label}</span>
                  </button>
                )
              })}
            </nav>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-7 shrink-0 items-center border-b border-border bg-card/50 px-2.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {VIEWS.find((v) => v.tab === tab)?.label ?? tab}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <ErrorBoundary>
                  {panelBody(tab)}
                </ErrorBoundary>
              </div>
            </div>
          </>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-7 shrink-0 items-center border-b border-border bg-card/50 px-2.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {STAGES.find((s) => s.key === stage)?.label ?? stage}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
            <ErrorBoundary>
              {['firmware', 'manufacturing', 'supplyChain', 'validation'].includes(stage) ? (
                <div className="flex h-full flex-col gap-3 p-4 text-[12px] text-muted-foreground">
                  <div className="font-mono text-[9px] uppercase tracking-wide">specialist module</div>
                  <p>A <span className="text-foreground">separate module</span> built on the shared generic engine: the product engine emits a structured artifact grounded in the spec + real board.</p>
                  <p>Fidelity is honest — <span className="text-amber-600 dark:text-amber-400">generated / advisory</span>, not validated, compiled, or live-sourced. Each artifact carries its own fidelity label.</p>
                </div>
              ) : stage === 'explore' ? (
                <div className="flex h-full flex-col gap-3 p-4 text-[12px] text-muted-foreground">
                  <div className="font-mono text-[9px] uppercase tracking-wide">design-of-N</div>
                  <p>The product engine turns your spec into a <span className="text-foreground">design problem</span> (variables · objectives · constraints), then the optimizer generates candidates, scores them, and picks the best off the Pareto frontier.</p>
                  <p>Objectives with a real evaluator (cost, size, battery) are scored analytically. Objectives without one (audio, antenna, thermal…) are carried as <span className="text-amber-600 dark:text-amber-400">honest gaps</span> until their evaluator plugin lands — never faked.</p>
                  <p>The selected design is what the discipline modules then build.</p>
                </div>
              ) : stage === 'id'
                ? (idBrief ? <IdBriefPanel brief={idBrief} /> : <StagePlaceholder title="Industrial Design" Icon={Palette} />)
                : stage === 'mechanical'
                  ? (
                    <div className="flex h-full flex-col gap-3 p-4 text-[12px] text-muted-foreground">
                      <div className="font-mono text-[9px] uppercase tracking-wide">mechanical · CAD</div>
                      <p>The product engine emits a <span className="text-foreground">mechanical build plan</span> (sketch · extrude · pocket · standoff · cutout) sized to the real board. A thin executor renders it in <span className="text-foreground">Onshape</span> and exports a real <span className="text-foreground">STEP</span> file.</p>
                      <p>No fixed enclosure recipe — the plan (data) decides the form, so the same executor builds a shell, a bracket, or a potting box.</p>
                      <p>Advisory CAD: a first-pass parametric part, <span className="text-amber-600 dark:text-amber-400">not tolerance/fit-validated</span>. Per-op failures are reported, never hidden.</p>
                    </div>
                  )
                  : (
                    <div className="flex h-full flex-col gap-3 p-4 text-[12px] text-muted-foreground">
                      <div className="font-mono text-[9px] uppercase tracking-wide">simulation · physics</div>
                      <p><span className="text-foreground">thermal</span> and <span className="text-foreground">drop</span> are real finite-element solves via <span className="text-foreground">scikit-fem</span> — a 2D FEM heat-conduction field and a Kirchhoff-plate modal FEM. Acoustics (sealed-box), RF (link budget) and battery (energy) are analytic. Each result is labeled by <span className="text-foreground">fidelity</span> and the tool that produced it.</p>
                      <p>3D FEA is LIVE — <span className="text-amber-600 dark:text-amber-400">gmsh + CalculiX</span> solve the board and the real enclosure STEP. Still install-gated: <span className="text-amber-600 dark:text-amber-400">Elmer · openEMS · OpenFOAM</span>.</p>
                      <p>The runner only reports metrics it can compute — nothing faked.</p>
                    </div>
                  )}
            </ErrorBoundary>
            </div>
          </div>
        )}
      </section>
    </>
  )

  // Blank slate: shown on a fresh load (no run selected) and on a zero-run
  // install. The conversation pane (resizable, like the workspace) + empty
  // center + the same right rail in its empty state — describing a board builds
  // one; the panels populate once it finishes. Past runs stay reachable from
  // ---- left pane: icon bar + the three views (chat / threads / files) ------
  const selectThreadFromList = (id: string) => {
    setSelectedId(id); setNewDesign(false); setIdBrief(null); setProductSpec(null)
    setStage('electronics'); setBuiltDisc({}); setLeftView('chat')
    setDocTabs([]); setActiveDoc(null); setBadged({})
  }
  const leftIcons = (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
      {([['chat', MessagesSquare, 'Chat'], ['threads', History, 'Threads'], ['files', FolderTree, 'Files']] as const).map(([v, Icon, label]) => (
        <button
          key={v}
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
    </div>
  )
  const threadsPane = (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        onClick={() => { setNewDesign(true); setBuiltDisc({}); setLeftView('chat') }}
        className="mx-2 mt-2 flex items-center gap-1.5 rounded border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/50"
      >
        <Plus className="h-3.5 w-3.5" /> New design
      </button>
      <div className="min-h-0 flex-1 overflow-auto py-1.5">
        {runs.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">No designs yet.</div>}
        {runs.map((r: Run) => (
          <button
            key={r.id}
            onClick={() => selectThreadFromList(r.id)}
            className={cn(
              'relative flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/50',
              r.id === selectedId && !newDesign ? 'bg-accent text-foreground' : 'text-muted-foreground',
            )}
          >
            {r.id === selectedId && !newDesign && <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 bg-primary" />}
            <span className="truncate">{r.name || r.id}</span>
          </button>
        ))}
      </div>
    </div>
  )
  const filesPane = (
    <div className="flex min-h-0 flex-1 flex-col">
      <ArtifactExplorer runId={selectedRun?.runDir ? selectedRun.id : null} compact onOpen={openFileTab} />
    </div>
  )

  // the ☰ menu (real threads + select handler), so this is a clean start, not a
  // dead end.
  if (!selectedRun) {
    return (
      <main className="flex h-[calc(100dvh-2.25rem)] flex-col overflow-hidden bg-background text-foreground">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <aside style={{ width: leftW }} className="flex shrink-0 flex-col border-r border-border">
            {leftIcons}
            {leftView === 'threads' && threadsPane}
            {leftView === 'files' && filesPane}
            {leftView === 'chat' && <ComposeChat
              threads={runs.map((r) => ({ id: r.id, label: r.name || r.id }))}
              activeId=""
              newDesign
              onSelectThread={(id) => { setSelectedId(id); setNewDesign(false); setIdBrief(null); setProductSpec(null); setStage('electronics'); setBuiltDisc({}) }}
              onNew={() => {}}
              onRunComplete={onRunComplete}
              onIdBrief={onIdBrief}
              onProductSpec={setProductSpec}
              productSpec={productSpec}
              onProductBuilt={onProductBuilt}
            />}
          </aside>
          <Handle which="left" />
          <div className="flex min-w-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Describe a board on the left to design your first one.
          </div>
          {rightPane}
        </div>

        <TerminalPanel
          collapsed={termCollapsed}
          onToggle={toggleTerm}
          tab={termTab}
          onTabChange={setTermTab}
        />
        <StatusBar
          runId={pipelineRunId ?? (selectedId || null)}
          pipeline={pipelineRunId ? pipeStatusByRun[pipelineRunId] : pipeStatus}
          running={!!pipelineRunId}
          tiers={llmTiers}
          problemCount={problemCount}
          onProblemsClick={() => { setTermTab('problems'); if (termCollapsed) toggleTerm() }}
          startedAt={pipeStartedAt}
        />
      </main>
    )
  }

  const boardBase = selectedRunDir ? `${selectedRunDir}/board` : '/board'
  // The run has a bespoke chip-scale board — point Layout + Schematic at ITS
  // artwork (the flroute reference schematic/layout still shows a Pico otherwise).
  const hasChip = real?.board?.source === 'chip-scale chip-down board'
  const chipPcbSvg = selectedRun ? `/runs/${selectedRun.id}/electronics/chipscale.svg` : ''
  const chipSchemSvg = selectedRun ? `/runs/${selectedRun.id}/electronics/chipscale-schematic.svg` : ''

  return (
    <main className="flex h-[calc(100dvh-2.25rem)] flex-col overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* LEFT — conversation (real interview + live agent step feed) */}
      <aside style={{ width: leftW }} className="flex shrink-0 flex-col border-r border-border">
        {leftIcons}
        {leftView === 'threads' && threadsPane}
        {leftView === 'files' && filesPane}
        {leftView === 'chat' && <ComposeChat
          threads={runs.map((r) => ({ id: r.id, label: r.name || r.id }))}
          activeId={selectedId}
          activeRunId={!newDesign && selectedRun?.real ? selectedRun.id : undefined}
          activeName={selectedRun?.name}
          newDesign={newDesign}
          revisePrefill={revisePrefill}
          onPrefillConsumed={() => setRevisePrefill('')}
          onSelectThread={(id) => { setSelectedId(id); setNewDesign(false); setIdBrief(null); setProductSpec(null); setStage('electronics'); setBuiltDisc({}) }}
          onNew={() => { setNewDesign(true); setBuiltDisc({}) }}
          builtDisciplines={builtDisc}
          pipelineStatus={pipeStatus}
          pipelineRunning={pipeRunning}
          pipelineFeedback={pipeFeedback}
          onRunPipeline={() => runPipeline()}
          onStopPipeline={stopPipeline}
          onProductBuilt={onProductBuilt}
          onRunComplete={onRunComplete}
          onIdBrief={onIdBrief}
          onProductSpec={setProductSpec}
          productSpec={productSpec}
          onRename={async (id, name) => {
            await fetch('/api/runs/rename', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id, name }),
            }).catch(() => {})
            await refreshRuns()
          }}
        />}
      </aside>

      <Handle which="left" />

      {/* CENTER — stage bar over the middle pane ONLY, then the active stage's
          visualization. The right pane is a full-height sibling (like the left).
          A file opened from the left Files tree takes over this pane (IDE
          editor style) until closed. */}
      <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden">

        {/* stage bar — editor-style tab strip scoped to the middle pane: each tab
            carries its own bottom border; the ACTIVE tab drops it (bg-background)
            so it reads connected to the content below, with a 1px amber top edge */}
        <div className="flex h-9 shrink-0 items-stretch overflow-x-auto bg-card/40">
          {STAGES.map((s) => {
            const needsSpec = ['explore', 'firmware', 'manufacturing', 'supplyChain', 'validation'].includes(s.key)
            // Design (id) is now one-click like the other disciplines: reachable as
            // soon as there's a product spec, so its Generate button is accessible.
            const avail = needsSpec ? !!productSpec : s.key === 'electronics' ? (!!selectedRun || !!productSpec) : s.key === 'id' ? (!!productSpec || !!idBrief || !!selectedRun) : true
            const locked = !avail && (needsSpec || s.key === 'electronics' || s.key === 'id')
            const on = stage === s.key
            return (
              <button key={s.key} type="button" disabled={locked}
                onClick={() => { setStage(s.key); setActiveDoc(null); setBadged((b) => { if (!(s.key in b)) return b; const n = { ...b }; delete n[s.key]; return n }) }}
                title={s.key === 'id' && !idBrief && !productSpec ? 'describe a product first' : s.key === 'explore' && !productSpec ? 'describe a product first' : s.label}
                className={cn('relative flex shrink-0 items-center gap-1.5 border-b border-r border-border px-3 text-[11.5px]',
                  on ? 'border-b-transparent bg-background font-medium text-foreground'
                    : 'bg-card/40 text-muted-foreground hover:text-foreground',
                  locked && 'cursor-not-allowed opacity-40 hover:text-muted-foreground')}>
                {on && !activeDoc && <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-primary" />}
                {badged[s.key] && <span aria-hidden className={cn('absolute right-1 top-1 h-1.5 w-1.5 rounded-full', badged[s.key] === 'failed' ? 'bg-red-500' : 'bg-primary')} />}
                <s.Icon className={cn('size-3.5 shrink-0', on && 'text-primary')} />
                {s.label}
                {!s.built && <span className="bg-muted px-1 text-[8px] uppercase tracking-wide text-muted-foreground">soon</span>}
              </button>
            )
          })}
          {/* filler completes the tab strip's bottom border after the last tab */}
          {docTabs.map((d) => {
            const on = activeDoc === d.id
            return (
              <div key={d.id} className={cn('relative flex shrink-0 items-stretch border-b border-r border-border', on ? 'border-b-transparent bg-background' : 'bg-card/40')}>
                {on && <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-primary" />}
                <button type="button" onClick={() => setActiveDoc(d.id)} title={d.kind === 'file' ? d.file?.path : d.label}
                  className={cn('flex items-center gap-1.5 pl-3 pr-1 text-[11.5px]', on ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  {d.label}
                </button>
                <button type="button" onClick={() => closeDoc(d.id)}
                  className="flex items-center pl-0.5 pr-2 text-muted-foreground hover:text-foreground" title="Close">
                  <X className="h-3 w-3" />
                </button>
              </div>
            )
          })}
          <div className="relative flex shrink-0 items-center border-b border-border px-1">
            <button type="button" onClick={() => setAddOpen((o) => !o)} title="Open a panel as a tab"
              className="rounded p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground">
              <Plus className="h-3.5 w-3.5" />
            </button>
            {addOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 w-40 rounded-md border border-border bg-card py-1 shadow-lg">
                {VIEWS.map((v) => (
                  <button key={v.tab} type="button"
                    onClick={() => { openPanelTab(v.tab, v.label); setAddOpen(false) }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] text-muted-foreground hover:bg-accent/50 hover:text-foreground">
                    <v.Icon className="h-3.5 w-3.5" /> {v.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div aria-hidden className="min-w-4 flex-1 border-b border-border" />
        </div>

        {/* active stage visualization (middle pane only). While the full pipeline
            runs end-to-end, the middle pane shows the live pipeline loader (real
            per-discipline progress) instead of the active stage. */}
        {pipeRunning ? (
          <PipelineLoader status={pipeStatus} />
        ) : activeDocTab ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            {activeDocTab.kind === 'file' && selectedRun?.runDir ? (
              <FilePreview key={activeDocTab.id} runId={selectedRun.id} file={activeDocTab.file!} />
            ) : activeDocTab.kind === 'panel' ? (
              <div className="h-full overflow-y-auto"><ErrorBoundary>{panelBody(activeDocTab.panel!)}</ErrorBoundary></div>
            ) : null}
          </div>
        ) : (
        <>
        {stage === 'explore' && (
              <ErrorBoundary><ExploreStage spec={productSpec} runId={selectedRun?.id} /></ErrorBoundary>
            )}
            {stage === 'electronics' && (
              // For a bespoke prompt (productSpec set) the real electronics is
              // the chip-scale synthesized bare-chip board, not the fixed RP2040
              // reference board — so lead with it. The reference board still
              // shows for the canned demo run (no productSpec).
              productSpec ? (
                <ErrorBoundary><ChipScaleStage spec={productSpec} runId={selectedRun?.id} asElectronics /></ErrorBoundary>
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
                    <button type="button" onClick={() => setTab('Patterns')}
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
                    {newDesign ? (
                      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                        <Cpu className="size-9 opacity-25" />
                        <span className="text-xs">New design — describe a board on the left to begin.</span>
                      </div>
                    ) : (
                      <>
                        {view === '3d' && (
                          <Board3D basePath={boardBase} fallback={
                            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">no 3D model for this run</div>} />
                        )}
                        {view === 'layout' && (
                          hasChip
                            ? <div className="flex h-full items-center justify-center overflow-auto bg-white p-4">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={`${chipPcbSvg}?t=${selectedRun.id}`} alt="chip-scale PCB layout" className="max-h-full w-auto" />
                              </div>
                            : <BoardCanvas key={selectedRun.id} run={selectedRun}
                                realBoard={isReal ? real?.board : null} basePath={boardBase} />
                        )}
                        {view === 'schematic' && (
                          hasChip
                            ? <div className="flex h-full items-center justify-center overflow-auto bg-white p-4">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={`${chipSchemSvg}?t=${selectedRun.id}`} alt="chip-scale schematic" className="max-h-full w-auto" />
                              </div>
                            : <BoardSchematic runDir={selectedRunDir ?? null} />
                        )}
                      </>
                    )}
                  </ErrorBoundary>
                </div>
              </>
              )
            )}
            {stage === 'id' && (
              <ErrorBoundary>
                <IdStage spec={productSpec} runId={selectedRun?.id} brief={idBrief} onBrief={setIdBrief} boardMm={isReal ? real?.board?.boardSize : undefined} />
              </ErrorBoundary>
            )}
            {stage === 'mechanical' && (
              <ErrorBoundary><MechanicalStage spec={productSpec} runId={selectedRun?.id} onBuilt={() => setBuiltDisc((b) => ({ ...b, mechanical: true }))} /></ErrorBoundary>
            )}
            {stage === 'simulation' && (
              <ErrorBoundary><SimulationStage spec={productSpec} runId={selectedRun?.id} onBuilt={() => setBuiltDisc((b) => ({ ...b, simulation: true }))} /></ErrorBoundary>
            )}
            {(stage === 'firmware' || stage === 'manufacturing' || stage === 'supplyChain' || stage === 'validation') && (
              <ErrorBoundary><DisciplineStage discipline={stage} spec={productSpec} runId={selectedRun?.id} onBuilt={() => setBuiltDisc((b) => ({ ...b, [stage]: true }))} /></ErrorBoundary>
            )}
        </>
        )}
          </section>

          {rightPane}
      </div>

      {/* bottom Terminal panel + status bar — full width, below the 3-pane row */}
      <TerminalPanel
        collapsed={termCollapsed}
        onToggle={toggleTerm}
        tab={termTab}
        onTabChange={setTermTab}
      />
      <StatusBar
        runId={pipelineRunId ?? (selectedId || null)}
        pipeline={pipelineRunId ? pipeStatusByRun[pipelineRunId] : pipeStatus}
        running={!!pipelineRunId}
        tiers={llmTiers}
        problemCount={problemCount}
        onProblemsClick={() => { setTermTab('problems'); if (termCollapsed) toggleTerm() }}
        startedAt={pipeStartedAt}
      />
    </main>
  )
}
