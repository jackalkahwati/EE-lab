'use client'

/**
 * Compose 2 — three-pane layout PREVIEW (Flux-informed), shadow-built beside the
 * working /compose so the layout can be dialed in with zero risk.
 *   LEFT   conversation: thread switcher + prompt + live step feed
 *   CENTER the board as the hero: 3D by default, 2D/layers a toggle
 *   RIGHT  the journey collapsed to a vertical phase rail + phase panel
 * Reuses the real panels + loadRealBoard + /api/runs. New-board CREATION still
 * lives in /compose for now (heaviest state); this is for layout, on real runs.
 */
import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { loadRealBoard, type RealBoard } from '@/lib/real-board'
import { PromptComposer } from '@/components/prompt-composer'
import { PipelineTracker } from '@/components/pipeline-tracker'
import { BoardCanvas } from '@/components/board-canvas'
import { Board3D } from '@/components/board-3d'
import { CodeViewer } from '@/components/code-viewer'
import { BomTable } from '@/components/bom-table'
import { GatesLogs } from '@/components/gates-logs'
import { OrderPanel } from '@/components/order-panel'
import { RecoveryPanel } from '@/components/recovery-panel'
import { ConstraintsPanel } from '@/components/constraints-panel'
import { AssemblyPanel } from '@/components/assembly-panel'
import { PinoutPanel } from '@/components/pinout-panel'
import { IngestPanel } from '@/components/ingest-panel'
import { PatternsPanel } from '@/components/patterns-panel'
import { AdvancedRoutingPanel } from '@/components/advanced-routing-panel'
import { FL1ValidationView } from '@/components/fl1-validation-view'
import { ErrorBoundary } from '@/components/error-boundary'
import { ReviewPanel } from '@/components/review-panel'
import { RunOverview } from '@/components/run-overview'
import { ArtifactExplorer } from '@/components/artifact-explorer'
import { FL1ReadinessPanel } from '@/components/fl1-readiness-panel'
import {
  Boxes, CircuitBoard, ClipboardCheck, FileCode2, LayoutDashboard,
  Receipt, ScrollText, Wrench,
} from 'lucide-react'

type Run = any
type Tab = string

// journey phases → panels (Board lives in the center hero, not here)
const PHASES: { key: string; label: string; Icon: any; views: Tab[] }[] = [
  { key: 'Overview', label: 'Overview', Icon: LayoutDashboard, views: ['Overview'] },
  { key: 'Design', label: 'Design', Icon: FileCode2, views: ['Code', 'Pinout', 'Constraints', 'Advanced'] },
  { key: 'Review', label: 'Review', Icon: ClipboardCheck, views: ['Checks', 'Review'] },
  { key: 'Quote', label: 'Quote', Icon: Receipt, views: ['Order'] },
  { key: 'Build', label: 'Build', Icon: Wrench, views: ['BOM', 'Assembly'] },
  { key: 'Validate', label: 'Validate', Icon: CircuitBoard, views: ['FL-1', 'Recovery'] },
  { key: 'Learn', label: 'Learn', Icon: Boxes, views: ['Ingest', 'Patterns', 'FL-1 Ready'] },
  { key: 'Artifacts', label: 'Artifacts', Icon: ScrollText, views: ['Artifacts'] },
]

export default function Compose2Page() {
  const [runs, setRuns] = useState<Run[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [realBoard, setRealBoard] = useState<RealBoard | null>(null)
  const [phase, setPhase] = useState('Overview')
  const [tab, setTab] = useState<Tab>('Overview')
  const [view3d, setView3d] = useState(true)
  const [note, setNote] = useState<string | null>(null)

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

  if (!selectedRun) {
    return (
      <main className="flex h-[calc(100dvh-2.75rem)] items-center justify-center bg-background text-sm text-muted-foreground">
        No runs yet — design a board in <a href="/compose" className="ml-1 text-primary underline">Compose</a>.
      </main>
    )
  }

  const real = realBoard && realBoard.base === (selectedRunDir ?? '') ? realBoard : null
  const isReal = selectedRun?.real === true && real !== null
  const boardBase = selectedRunDir ? `${selectedRunDir}/board` : '/board'
  const m = selectedRun.metrics ?? {}

  const selectPhase = (p: typeof PHASES[number]) => {
    setPhase(p.key)
    setTab(p.views[0])
  }

  return (
    <main className="flex h-[calc(100dvh-2.75rem)] overflow-hidden bg-background text-foreground">
      {/* LEFT — conversation */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-xs font-semibold">Conversation</span>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="ml-auto max-w-[9rem] rounded-sm border border-border bg-secondary px-1.5 py-1 text-[11px]">
            {runs.map((r) => (
              <option key={r.id} value={r.id}>{r.title ?? r.id}</option>
            ))}
          </select>
        </div>
        <div className="border-b border-border p-3">
          <PromptComposer
            onInterview={() => setNote('New-board creation is in Compose (classic) for now — this preview is for dialing in the layout on existing runs.')}
            disabled={false}
          />
          {note && <p className="mt-2 text-[10px] text-amber-500">{note}</p>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mb-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">agent steps</div>
          <PipelineTracker run={selectedRun} liveElapsed={{}} />
        </div>
      </aside>

      {/* CENTER — the board as hero */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">{selectedRun.title ?? selectedRun.id}</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {m.nets ? `nets ${m.nets}` : ''} {m.layers ? `· ${m.layers}-layer` : ''} {m.components ? `· ${m.components} parts` : ''}
          </span>
          <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[9px]',
            selectedRun.status === 'PASSED'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-500')}>
            {selectedRun.status}
          </span>
          <div className="ml-auto flex overflow-hidden rounded-sm border border-border">
            {(['3D', '2D'] as const).map((v) => (
              <button key={v} type="button" onClick={() => setView3d(v === '3D')}
                className={cn('px-2.5 py-0.5 text-[11px]',
                  (view3d ? '3D' : '2D') === v ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {v}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <ErrorBoundary>
            {view3d ? (
              <Board3D basePath={boardBase} fallback={
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">no 3D model for this run</div>} />
            ) : (
              <BoardCanvas key={selectedRun.id} run={selectedRun}
                realBoard={isReal ? real?.board : null} basePath={boardBase} />
            )}
          </ErrorBoundary>
        </div>
      </section>

      {/* RIGHT — journey spine + phase panel */}
      <section className="flex w-[30rem] shrink-0 border-l border-border">
        <nav className="flex w-14 shrink-0 flex-col gap-0.5 border-r border-border bg-card/30 py-2">
          {PHASES.map((p) => {
            const on = phase === p.key
            return (
              <button key={p.key} type="button" onClick={() => selectPhase(p)} title={p.label}
                className={cn('mx-1.5 flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[8px]',
                  on ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground')}>
                <p.Icon className={cn('size-4', on && 'text-primary')} />
                <span className="leading-none">{p.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          {(PHASES.find((p) => p.key === phase)?.views.length ?? 0) > 1 && (
            <div className="flex gap-1 border-b border-border px-2 py-1.5">
              {PHASES.find((p) => p.key === phase)?.views.map((t) => (
                <button key={t} type="button" onClick={() => setTab(t)}
                  className={cn('rounded-sm px-2 py-0.5 text-[11px]',
                    tab === t ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  {t}
                </button>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ErrorBoundary>
              {tab === 'Overview' && <RunOverview runId={selectedRun.runDir ? selectedRun.id : null} run={selectedRun} />}
              {tab === 'Artifacts' && <ArtifactExplorer runId={selectedRun.runDir ? selectedRun.id : null} />}
              {tab === 'Code' && <CodeViewer key={isReal ? 'real' : 'seed'} files={isReal ? real?.ato : null} />}
              {tab === 'BOM' && <BomTable lines={isReal ? real?.bom : null} />}
              {tab === 'Checks' && (
                <GatesLogs run={selectedRun} reports={isReal ? real?.reports : null} runDir={selectedRunDir}
                  onRefresh={() => loadRealBoard(selectedRunDir ?? '').then((d) => d && setRealBoard(d))} />
              )}
              {tab === 'Constraints' && <ConstraintsPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
              {tab === 'Pinout' && <PinoutPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
              {tab === 'Advanced' && <AdvancedRoutingPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
              {tab === 'Ingest' && <IngestPanel />}
              {tab === 'Patterns' && <PatternsPanel />}
              {tab === 'FL-1 Ready' && <FL1ReadinessPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
              {tab === 'Recovery' && <RecoveryPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
              {tab === 'Assembly' && <AssemblyPanel runId={selectedRun.runDir ? selectedRun.id : null} fabZip={null} />}
              {tab === 'Review' && <ReviewPanel runId={selectedRun.runDir ? selectedRun.id : null} />}
              {tab === 'FL-1' && <FL1ValidationView runId={selectedRun.runDir ? selectedRun.id : null} />}
              {tab === 'Order' && (
                <OrderPanel
                  boardW={(isReal ? real?.board.boardSize.wMm : null) ?? 200}
                  boardH={(isReal ? real?.board.boardSize.hMm : null) ?? 146}
                  layers={(isReal ? real?.board.layers : null) ?? m.layers}
                  components={(isReal ? real?.board.components : null) ?? m.components}
                  bomTotal={(isReal ? real?.board.bomTotal : null)
                    ?? (isReal ? real?.bom : null)?.reduce((s, l) => s + (l.lineTotal ?? l.unitPrice * l.qty), 0) ?? 55}
                  fabZip={null} />
              )}
            </ErrorBoundary>
          </div>
        </div>
      </section>
    </main>
  )
}
