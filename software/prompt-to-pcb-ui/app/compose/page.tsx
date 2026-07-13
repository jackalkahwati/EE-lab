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
import { ArtifactExplorer } from '@/components/artifact-explorer'
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
import type { IdBrief } from '@/lib/id-brief'
import type { ProductSpec } from '@/lib/product-spec'
import {
  Activity, BookOpen, Box, ClipboardCheck, Code, Cpu, Eye, Factory, Gauge, LayoutDashboard, ListTree, Maximize2,
  Package, Palette, Receipt, ScrollText, ShieldCheck, Sparkles, Truck, Wrench,
} from 'lucide-react'

type Run = any
type Tab = string

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
  { tab: 'Artifacts', label: 'Artifacts', Icon: ScrollText },
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
    if (Array.isArray(disk) && disk.find((r: Run) => r.id === id)) setSelectedId(id)
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
  const [rightW, setRightW] = useState(480)
  const dragRef = useRef<null | 'left' | 'right'>(null)

  useEffect(() => {
    const l = Number(localStorage.getItem('c2-leftW'))
    const r = Number(localStorage.getItem('c2-rightW'))
    if (l >= 200) setLeftW(l)
    if (r >= 280) setRightW(r)
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      if (dragRef.current === 'left') setLeftW(Math.min(600, Math.max(200, e.clientX)))
      else setRightW(Math.min(760, Math.max(280, window.innerWidth - e.clientX)))
    }
    const onUp = () => {
      if (!dragRef.current) return
      dragRef.current = null
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

  const startDrag = (which: 'left' | 'right') => (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = which
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }
  const Handle = ({ which }: { which: 'left' | 'right' }) => (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={startDrag(which)}
      onDoubleClick={() => which === 'left' ? setLeftW(288) : setRightW(480)}
      title="drag to resize · double-click to reset"
      className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/60"
    />
  )

  // load real runs from disk (same source as /compose)
  useEffect(() => {
    fetch('/api/runs').then((r) => (r.ok ? r.json() : { runs: [] }))
      .then(({ runs: disk }: { runs: Run[] }) => {
        if (Array.isArray(disk) && disk.length) {
          setRuns(disk)
          setSelectedId((cur) => cur || disk.find((r) => r.real)?.id || disk[0].id)
        }
      }).catch(() => {})
  }, [])

  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedId) ?? runs[0], [runs, selectedId])
  const selectedRunDir = selectedRun?.runDir
  const selectedReal = selectedRun?.real

  // load the selected run's own snapshot
  useEffect(() => {
    if (!selectedReal) { setRealBoard(null); return }
    let cancelled = false
    loadRealBoard(selectedRunDir ?? '').then((d) => { if (!cancelled) setRealBoard(d) })
    return () => { cancelled = true }
  }, [selectedReal, selectedRunDir])

  // Zero-run install (fresh state): no board to show yet, so render just the
  // conversation pane — describing a board there builds the first one, and the
  // full three-pane layout takes over once it finishes.
  if (!selectedRun) {
    return (
      <main className="flex h-[calc(100dvh-2.75rem)] bg-background text-foreground">
        <aside className="flex w-96 shrink-0 flex-col border-r border-border">
          <ComposeChat
            threads={[]}
            activeId=""
            newDesign
            onSelectThread={() => {}}
            onNew={() => {}}
            onRunComplete={onRunComplete}
            onIdBrief={onIdBrief}
            onProductSpec={setProductSpec}
          />
        </aside>
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          Describe a board on the left to design your first one.
        </div>
      </main>
    )
  }

  const real = realBoard && realBoard.base === (selectedRunDir ?? '') ? realBoard : null
  const isReal = selectedRun?.real === true && real !== null
  const boardBase = selectedRunDir ? `${selectedRunDir}/board` : '/board'

  return (
    <main className="flex h-[calc(100dvh-2.75rem)] overflow-hidden bg-background text-foreground">
      {/* LEFT — conversation (real interview + live agent step feed) */}
      <aside style={{ width: leftW }} className="flex shrink-0 flex-col border-r border-border">
        <ComposeChat
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
          onRunComplete={onRunComplete}
          onIdBrief={onIdBrief}
          onProductSpec={setProductSpec}
          onRename={async (id, name) => {
            await fetch('/api/runs/rename', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id, name }),
            }).catch(() => {})
            await refreshRuns()
          }}
        />
      </aside>

      <Handle which="left" />

      {/* CENTER — stage bar over the middle pane ONLY, then the active stage's
          visualization. The right pane is a full-height sibling (like the left). */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* stage bar — scoped to the middle pane */}
        <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-2 py-1.5">
          {STAGES.map((s) => {
            const needsSpec = ['explore', 'firmware', 'manufacturing', 'supplyChain', 'validation'].includes(s.key)
            // Design (id) is now one-click like the other disciplines: reachable as
            // soon as there's a product spec, so its Generate button is accessible.
            const avail = needsSpec ? !!productSpec : s.key === 'electronics' ? (!!selectedRun || !!productSpec) : s.key === 'id' ? (!!productSpec || !!idBrief) : true
            const locked = !avail && (needsSpec || s.key === 'electronics' || s.key === 'id')
            const on = stage === s.key
            return (
              <button key={s.key} type="button" disabled={locked}
                onClick={() => setStage(s.key)}
                title={s.key === 'id' && !idBrief && !productSpec ? 'describe a product first' : s.key === 'explore' && !productSpec ? 'describe a product first' : s.label}
                className={cn('flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px]',
                  on ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                  locked && 'cursor-not-allowed opacity-40 hover:text-muted-foreground')}>
                <s.Icon className={cn('size-3.5 shrink-0', on && 'text-primary')} />
                {s.label}
                {!s.built && <span className="rounded-sm bg-muted px-1 text-[8px] uppercase tracking-wide text-muted-foreground">soon</span>}
              </button>
            )
          })}
        </div>

        {/* active stage visualization (middle pane only) */}
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
                      <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                        title="component BOM estimate — not fab, not a quote">
                        ~${Number(real.board.bomTotal).toFixed(2)} BOM
                      </span>
                    ) : null}
                    <button type="button" onClick={() => setTab('Patterns')}
                      className="flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                      title="reusable patterns & ingested knowledge">
                      <BookOpen className="size-3" /> Knowledge
                    </button>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="flex overflow-hidden rounded-sm border border-border">
                      {([['3d', '3D'], ['layout', 'Layout'], ['schematic', 'Schematic']] as const).map(([v, label]) => (
                        <button key={v} type="button" onClick={() => setView(v)}
                          className={cn('px-2.5 py-0.5 text-[11px]',
                            view === v ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                          {label}
                        </button>
                      ))}
                    </div>
                    <button type="button" onClick={toggleFullscreen} title="fullscreen board"
                      className="rounded-sm border border-border p-1 text-muted-foreground hover:text-foreground">
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
                          <BoardCanvas key={selectedRun.id} run={selectedRun}
                            realBoard={isReal ? real?.board : null} basePath={boardBase} />
                        )}
                        {view === 'schematic' && <BoardSchematic runDir={selectedRunDir ?? null} />}
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
          </section>

          <Handle which="right" />

          {/* RIGHT — the active stage's detailed results */}
          <section style={{ width: rightW }} className="flex shrink-0 border-l border-border">
            {stage === 'electronics' && !productSpec ? (
              <>
                <nav className="flex w-16 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-card/30 py-2">
                  {VIEWS.map((v) => {
                    const on = tab === v.tab
                    return (
                      <button key={v.tab} type="button" onClick={() => setTab(v.tab)} title={v.label}
                        className={cn('mx-1.5 flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[8px]',
                          on ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground')}>
                        <v.Icon className={cn('size-4', on && 'text-primary')} />
                        <span className="leading-none">{v.label}</span>
                      </button>
                    )
                  })}
                </nav>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <ErrorBoundary>
                      {newDesign ? (
                        <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
                          No board yet — the overview appears once your new design builds.
                        </div>
                      ) : (
                        <>
                          {tab === 'Overview' && <RunOverview runId={selectedRun.runDir ? selectedRun.id : null} run={selectedRun} />}
                          {tab === 'Objects' && <BoardObjects real={real} />}
                          {tab === 'Artifacts' && <ArtifactExplorer runId={selectedRun.runDir ? selectedRun.id : null} />}
                          {tab === 'Code' && <CodeViewer key={isReal ? 'real' : 'seed'} files={isReal ? real?.ato : null} />}
                          {tab === 'BOM' && <BomTable lines={isReal ? real?.bom : null} />}
                          {tab === 'Checks' && <BoardChecks real={real} />}
                          {tab === 'Constraints' && <ConstraintsPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
                          {tab === 'Pinout' && <PinoutPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
                          {tab === 'Advanced' && <AdvancedRoutingPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
                          {tab === 'Ingest' && <IngestPanel />}
                          {tab === 'Patterns' && <PatternsPanel />}
                          {tab === 'FL-1 Ready' && <FL1ReadinessPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
                          {tab === 'Recovery' && <RecoveryPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
                          {tab === 'Assembly' && <AssemblyPanel runId={selectedRun.runDir ? selectedRun.id : null} fabZip={null} />}
                          {tab === 'Review' && <ReviewPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
                          {tab === 'FL-1' && (
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
                          {tab === 'Order' && <ProcurementPanel real={real} runDir={selectedRunDir ?? null} />}
                        </>
                      )}
                    </ErrorBoundary>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex min-w-0 flex-1 flex-col">
                <ErrorBoundary>
                  {['firmware', 'manufacturing', 'supplyChain', 'validation'].includes(stage) ? (
                    <div className="flex h-full flex-col gap-3 p-4 text-[12px] text-muted-foreground">
                      <div className="font-mono text-[9px] uppercase tracking-wide">specialist module</div>
                      <p>A <span className="text-foreground">separate module</span> built on the shared generic engine: the product engine emits a structured artifact grounded in the spec + real board.</p>
                      <p>Fidelity is honest — <span className="text-amber-600 dark:text-amber-400">generated / advisory</span>, not validated, compiled, or live-sourced. Each artifact carries its own fidelity label.</p>
                    </div>
                  ) : stage === 'electronics' && productSpec ? (
                    <div className="flex h-full flex-col gap-3 p-4 text-[12px] text-muted-foreground">
                      <div className="font-mono text-[9px] uppercase tracking-wide">electronics · bespoke chip-down board</div>
                      <p>The real electronics for this product: the engine picks a minimal, highly-integrated part set (bare SoC + passives), and it's placed (net-aware) + routed (freerouting) into a <span className="text-foreground">true chip-scale board</span> — not the fixed RP2040 reference board.</p>
                      <p>Every board is checked with <span className="text-foreground">real KiCad DRC</span> against a real fab process, and the redesign loop iterates until it converges or honestly reports what's left.</p>
                      <p>Honest: generic footprints where no LCSC part is resolved, not yet WLCSP/rigid-flex — a real step toward the earbud, <span className="text-amber-600 dark:text-amber-400">not EVT silicon</span>.</p>
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
                          <p>Real lumped-physics simulations via <span className="text-foreground">numpy/scipy</span> — thermal (transient RC), drop (impulse), acoustics (sealed-box), RF (link budget), battery (energy). Each result is labeled by <span className="text-foreground">fidelity</span> and the tool that produced it.</p>
                          <p>These are lumped/analytic, <span className="text-amber-600 dark:text-amber-400">not 3D FEA/FDTD</span>. High-fidelity solvers (Elmer · CalculiX · openEMS · OpenFOAM; gmsh present) are the install-gated upgrade.</p>
                          <p>The runner only reports metrics it can compute — nothing faked.</p>
                        </div>
                      )}
                </ErrorBoundary>
              </div>
            )}
          </section>
    </main>
  )
}
