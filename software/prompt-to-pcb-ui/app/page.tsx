'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  STAGE_DEFS,
  STAGE_PREFIX,
  type Run,
  type StageId,
  type StageState,
} from '@/lib/firstlight'
import { loadRealBoard, type RealBoard } from '@/lib/real-board'
import { RunHistory } from '@/components/run-history'
import { PromptComposer } from '@/components/prompt-composer'
import { PipelineTracker } from '@/components/pipeline-tracker'
import { BoardCanvas } from '@/components/board-canvas'
import { CodeViewer } from '@/components/code-viewer'
import { BomTable } from '@/components/bom-table'
import { GatesLogs } from '@/components/gates-logs'
import { MetricsRail } from '@/components/metrics-rail'
import { OrderPanel } from '@/components/order-panel'
import { RecoveryPanel } from '@/components/recovery-panel'
import { FL1ValidationView } from '@/components/fl1-validation-view'
import { BuildStatus } from '@/components/build-status'
import { ErrorBoundary } from '@/components/error-boundary'
import { InterviewPanel } from '@/components/interview-panel'
import { WelcomeHero } from '@/components/welcome-hero'
import { ReviewPanel } from '@/components/review-panel'
import { ReviseDialog } from '@/components/revise-dialog'
import { FL1Loop } from '@/components/fl1-loop'

const TABS = ['Board', 'Code', 'BOM', 'Checks', 'Recovery', 'Review', 'FL-1', 'Order'] as const
type Tab = (typeof TABS)[number]

interface PipelineEvent {
  type: 'stage' | 'log' | 'design' | 'done' | 'error'
  id?: StageId
  state?: StageState
  failReason?: string
  stage?: StageId
  text?: string
  level?: 'info' | 'ok' | 'warn' | 'err'
  status?: 'PASSED' | 'GATE FAILED'
  message?: string
  spec?: Record<string, unknown>
  fabZip?: string
  fwZip?: string
  runDir?: string
}

export default function FirstLightPage() {
  const [runs, setRuns] = useState<Run[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [tab, setTab] = useState<Tab>('Board')
  const [liveRunId, setLiveRunId] = useState<string | null>(null)
  const [liveElapsed, setLiveElapsed] = useState<Record<string, number>>({})
  const [realBoard, setRealBoard] = useState<RealBoard | null>(null)
  const [designSpec, setDesignSpec] = useState<Record<string, unknown> | null>(null)
  const [fabZip, setFabZip] = useState<string | null>(null)
  const [fwZip, setFwZip] = useState<string | null>(null)
  const [interviewRequest, setInterviewRequest] = useState<string | null>(null)
  const [showWelcome, setShowWelcome] = useState(false)
  const [reviseRequest, setReviseRequest] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const stageStartRef = useRef<Record<string, number>>({})
  const currentStageRef = useRef<string | null>(null)

  // restore persisted runs on mount (client-only, avoids hydration mismatch).
  // Only restore runs WITHOUT a runDir: disk-backed runs (those with a runDir)
  // are authoritative from /api/runs below, restoring them from localStorage is
  // exactly what resurrected stale runs pointing at deleted snapshot dirs, which
  // then rendered the wrong (shared-fallback) board under their unique id.
  useEffect(() => {
    // deep link from the marketing site: /?prompt=<board description>
    const qp = new URLSearchParams(window.location.search)
    const deepPrompt = qp.get('prompt')
    if (deepPrompt) {
      window.history.replaceState({}, '', '/')
      localStorage.setItem('fl-welcomed', '1')
      setInterviewRequest(deepPrompt)
    } else if (localStorage.getItem('fl-welcomed') !== '1') setShowWelcome(true)
    try {
      const saved = JSON.parse(localStorage.getItem('fl-runs') || 'null')
      if (Array.isArray(saved) && saved.length) {
        const transient = saved.filter(
          (r: Run) => !r.runDir && /^run-\d{13}-\w+$/.test(r.id),
        )
        if (transient.length)
          setRuns(
            transient.map((r: Run) =>
              r.status === 'RUNNING' ? { ...r, status: 'GATE FAILED' } : r,
            ),
          )
      }
    } catch {
      /* ignore corrupt storage */
    }
  }, [])

  // disk is the source of truth for real runs: load every run that actually has
  // a snapshot on disk (public/runs/<id>), each with its OWN id + board. Drop any
  // prior run whose dir no longer exists so a unique id can never show a board
  // that isn't its own.
  useEffect(() => {
    let cancelled = false
    fetch('/api/runs')
      .then((r) => (r.ok ? r.json() : { runs: [] }))
      .then(({ runs: disk }: { runs: Run[] }) => {
        if (cancelled || !Array.isArray(disk)) return
        const ids = new Set(disk.map((r) => r.id))
        setRuns((prev) => [
          ...disk,
          ...prev.filter((r) => !r.runDir && !ids.has(r.id)),
        ])
        if (disk.length > 0) setSelectedId(disk[0].id)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // persist runs (skip while a run is live, its partial state is transient)
  useEffect(() => {
    if (liveRunId) return
    try {
      localStorage.setItem('fl-runs', JSON.stringify(runs.slice(0, 30)))
    } catch {
      /* ignore quota / private mode */
    }
  }, [runs, liveRunId])


  const selectedRun = runs.find((r) => r.id === selectedId) ?? runs[0]

  const selectedRunDir = selectedRun?.runDir
  const selectedReal = selectedRun?.real
  // Single source of truth: only treat the loaded board as the selected run's
  // when it was loaded from THIS run's snapshot. Until the new run's snapshot
  // finishes loading, `real` is null, so we never render one run's board, BOM,
  // metrics or artifacts under a different run.
  const real =
    realBoard && realBoard.base === (selectedRunDir ?? '') ? realBoard : null
  const isReal = selectedRun?.real === true && real !== null
  // images for the selected run come from ITS snapshot, not the shared latest
  const boardBase = selectedRunDir ? `${selectedRunDir}/board` : '/board'

  // when the user switches to a real run, load THAT run's own artifact snapshot
  // so the board view / metrics reflect the selected run (not the latest one)
  useEffect(() => {
    if (!selectedReal) return
    let cancelled = false
    loadRealBoard(selectedRunDir ?? '').then((data) => {
      if (data && !cancelled) setRealBoard(data)
    })
    return () => {
      cancelled = true
    }
  }, [selectedId, selectedReal, selectedRunDir])

  /** REAL pipeline: placement → routing → validation via /api/pipeline/run */
  const handleGenerate = useCallback(
    (
      prompt: string,
      compose?: { blocks: string[]; boardClass: string },
      rev?: { parentId: string; revNote: string },
    ) => {
      // unique per run: timestamp + random suffix so two runs started in the same
      // millisecond can never collide on an id (and thus never share a run dir).
      const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const base: Run = {
        id,
        name: compose
          ? `${compose.boardClass} ${new Date().toTimeString().slice(0, 5)}`
          : `FL-1 pipeline run ${new Date().toTimeString().slice(0, 5)}`,
        parentId: rev?.parentId,
        revNote: rev?.revNote,
        timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
        status: 'RUNNING',
        prompt,
        stages: STAGE_DEFS.map((d) => ({
          id: d.id,
          state: 'pending' as StageState,
          elapsedMs: 0,
        })),
        // a brand-new run starts with neutral metrics, never seeded from the
        // previously selected board. Its real numbers arrive from its OWN
        // snapshot when the pipeline finishes (metrics: data.run.metrics).
        metrics: {
          netsRouted: 0,
          netsTotal: 0,
          copperDefects: 0,
          hpwl: 0,
          hpwlHistory: [],
          components: 0,
          bomLines: 0,
          boardSize: ', ',
          layers: 0,
          routeTimeSec: 0,
        },
        logs: [
          {
            stage: 'design',
            prefix: 'run',
            text: 'REAL run: placement → flroute → KiCad DRC on an isolated board copy',
          },
        ],
      }
      stageStartRef.current = {}
      currentStageRef.current = null
      setDesignSpec(null)
      setFabZip(null)
      setFwZip(null)
      setRuns((prev) => [base, ...prev])
      setSelectedId(id)
      setLiveRunId(id)
      setTab('Gates & Logs')

      const update = (fn: (r: Run) => Run) =>
        setRuns((prev) => prev.map((r) => (r.id === id ? fn(r) : r)))

      let url = `/api/pipeline/run?prompt=${encodeURIComponent(prompt)}&runId=${encodeURIComponent(id)}`
      if (rev) {
        url += `&parent=${encodeURIComponent(rev.parentId)}&revNote=${encodeURIComponent(rev.revNote)}`
      }
      if (compose) {
        const json = JSON.stringify({
          blocks: compose.blocks,
          boardClass: compose.boardClass,
        })
        // UTF-8-safe base64: btoa() only accepts Latin1, but interview-generated
        // specs can contain non-ASCII (µ, ×, em-dash, curly quotes). Encode the
        // UTF-8 bytes; the server decodes base64 -> utf8 to match.
        const payload = btoa(
          encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, (_, h) =>
            String.fromCharCode(parseInt(h, 16)),
          ),
        )
        url += `&compose=1&spec=${encodeURIComponent(payload)}`
      }
      const es = new EventSource(url)
      esRef.current = es

      es.onmessage = (e) => {
        const ev = JSON.parse(e.data) as PipelineEvent
        if (ev.type === 'log' && ev.stage && ev.text) {
          const { stage, text, level } = ev
          update((r) => ({
            ...r,
            logs: [
              ...r.logs,
              { stage, prefix: STAGE_PREFIX[stage] ?? stage, text, level },
            ],
          }))
        } else if (ev.type === 'stage' && ev.id) {
          if (ev.state === 'running') {
            stageStartRef.current[ev.id] = Date.now()
            currentStageRef.current = ev.id
          } else if (currentStageRef.current === ev.id) {
            currentStageRef.current = null
          }
          update((r) => ({
            ...r,
            stages: r.stages.map((s) =>
              s.id === ev.id
                ? {
                    ...s,
                    state: ev.state as StageState,
                    failReason: ev.failReason,
                    elapsedMs:
                      ev.state === 'running'
                        ? 0
                        : Date.now() - (stageStartRef.current[ev.id!] ?? Date.now()),
                  }
                : s,
            ),
          }))
        } else if (ev.type === 'design') {
          if (ev.spec) setDesignSpec(ev.spec)
        } else if (ev.type === 'done') {
          es.close()
          esRef.current = null
          setLiveRunId(null)
          setLiveElapsed({})
          setFabZip(ev.fabZip ?? null)
          setFwZip(ev.fwZip ?? null)
          update((r) => ({ ...r, status: ev.status ?? 'GATE FAILED' }))
          // load THIS run's own artifact snapshot (/runs/<id>) so every run keeps
          // its own board instead of all runs sharing the latest public/board
          loadRealBoard(ev.runDir ?? '').then((data) => {
            if (!data) return
            setRealBoard(data)
            setRuns((prev) =>
              prev.map((r) =>
                r.id === id
                  ? { ...r, real: true, runDir: ev.runDir, metrics: data.run.metrics }
                  : r,
              ),
            )
          })
        } else if (ev.type === 'error') {
          update((r) => ({
            ...r,
            logs: [
              ...r.logs,
              {
                stage: 'validation',
                prefix: 'err',
                text: ev.message ?? 'unknown pipeline error',
                level: 'err',
              },
            ],
          }))
        }
      }

      es.onerror = () => {
        if (esRef.current !== es) return
        es.close()
        esRef.current = null
        setLiveRunId(null)
        setLiveElapsed({})
        update((r) =>
          r.status === 'RUNNING'
            ? {
                ...r,
                status: 'GATE FAILED',
                logs: [
                  ...r.logs,
                  {
                    stage: 'design',
                    prefix: 'err',
                    text: 'pipeline stream lost, the runner needs the local dev server with KiCad + flroute installed',
                    level: 'err',
                  },
                ],
              }
            : r,
        )
      }
    },
    [],
  )

  const handleDelete = useCallback(
    (id: string) => {
      if (id === liveRunId) return // never delete a live run
      setRuns((prev) => {
        if (prev.length <= 1) return prev // always keep at least one run
        const next = prev.filter((r) => r.id !== id)
        if (id === selectedId && next.length) setSelectedId(next[0].id)
        return next
      })
    },
    [liveRunId, selectedId],
  )

  // tick the elapsed timer for whichever stage is running
  useEffect(() => {
    if (!liveRunId) return
    const interval = setInterval(() => {
      const stage = currentStageRef.current
      if (stage) {
        const start = stageStartRef.current[stage]
        if (start) setLiveElapsed({ [stage]: Date.now() - start })
      }
    }, 250)
    return () => clearInterval(interval)
  }, [liveRunId])

  // close the stream if the page unmounts mid-run
  useEffect(() => () => esRef.current?.close(), [])

  if (!selectedRun) {
    return (
      <main className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
        Loading your workspace…
      </main>
    )
  }
  return (
    <main className="relative flex h-dvh overflow-hidden bg-background text-foreground">
      <RunHistory
        runs={runs}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onDelete={handleDelete}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((v) => !v)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-baseline gap-3">
            <h1 className="text-sm font-semibold tracking-tight text-foreground">
              FirstLight
            </h1>
            <button
              type="button"
              onClick={() => setShowWelcome(true)}
              className="text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              How it works
            </button>
            {selectedRun.runDir && liveRunId === null && (
              <button
                type="button"
                onClick={() => setReviseRequest('')}
                className="rounded-sm border border-primary/50 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10"
              >
                Revise board
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            {fabZip && (
              <a
                href={fabZip}
                download
                className="rounded border border-primary px-2 py-1 font-mono text-[10px] font-medium text-primary hover:bg-primary hover:text-primary-foreground"
              >
                ↓ Fab package (.zip)
              </a>
            )}
            {fwZip && (
              <a
                href={fwZip}
                download
                className="rounded border border-primary px-2 py-1 font-mono text-[10px] font-medium text-primary hover:bg-primary hover:text-primary-foreground"
              >
                ↓ Firmware (.zip)
              </a>
            )}
          </div>
        </header>

        <div className="flex flex-col gap-3 border-b border-border p-3">
          <PromptComposer
            onInterview={(p) => setInterviewRequest(p || 'design a custom board')}
            disabled={liveRunId !== null}
          />
          <PipelineTracker run={selectedRun} liveElapsed={liveElapsed} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div
            role="tablist"
            aria-label="Run viewport"
            className="flex items-center border-b border-border"
          >
            {TABS.map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  'border-b-2 px-4 py-2 text-xs font-medium transition-colors',
                  tab === t
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t}
              </button>
            ))}
            {selectedRun.runDir && (
              <div className="ml-auto pr-3">
                <BuildStatus runId={selectedRun.id} status={selectedRun.status} />
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1">
            <ErrorBoundary key={tab} label={`The ${tab} panel`}>
            {tab === 'Board' && (
              <BoardCanvas
                key={selectedRun.id}
                run={selectedRun}
                realBoard={isReal ? real?.board : null}
                basePath={boardBase}
              />
            )}
            {tab === 'Code' && (
              <CodeViewer
                key={isReal ? 'real' : 'seed'}
                files={isReal ? real?.ato : null}
              />
            )}
            {tab === 'BOM' && <BomTable lines={isReal ? real?.bom : null} />}
            {tab === 'Checks' && (
              <GatesLogs
                run={selectedRun}
                reports={isReal ? real?.reports : null}
                runDir={selectedRunDir}
                onRefresh={() => {
                  // a repair rewrote this run's artifacts, reload its board and
                  // refresh statuses/metrics from disk without changing selection
                  loadRealBoard(selectedRunDir ?? '').then((d) => d && setRealBoard(d))
                  fetch('/api/runs')
                    .then((r) => (r.ok ? r.json() : { runs: [] }))
                    .then(({ runs: disk }: { runs: Run[] }) => {
                      if (!Array.isArray(disk)) return
                      setRuns((prev) =>
                        prev.map((r) => {
                          const u = disk.find((d) => d.id === r.id)
                          return u ? { ...r, status: u.status, metrics: u.metrics } : r
                        }),
                      )
                    })
                    .catch(() => {})
                }}
              />
            )}
            {tab === 'Recovery' && (
              <RecoveryPanel runId={selectedRun.runDir ? selectedRun.id : null} />
            )}
            {tab === 'Review' && (
              <ReviewPanel runId={selectedRun.runDir ? selectedRun.id : null} />
            )}
            {tab === 'FL-1' && (
              <div className="flex h-full flex-col overflow-y-auto">
                <FL1ValidationView runId={selectedRun.runDir ? selectedRun.id : null} />
                <div className="border-t border-border">
                  <FL1Loop
                    runId={selectedRun.runDir ? selectedRun.id : null}
                    onRevise={(eco) => setReviseRequest(eco)}
                  />
                </div>
              </div>
            )}
            {tab === 'Order' && (
              <OrderPanel
                boardW={(isReal ? real?.board.boardSize.wMm : null) ?? 200}
                boardH={(isReal ? real?.board.boardSize.hMm : null) ?? 146}
                layers={
                  (isReal ? real?.board.layers : null) ?? selectedRun.metrics.layers
                }
                components={
                  (isReal ? real?.board.components : null) ??
                  selectedRun.metrics.components
                }
                bomTotal={
                  (isReal ? real?.board.bomTotal : null) ??
                  (isReal ? real?.bom : null)?.reduce(
                    (s, l) => s + (l.lineTotal ?? l.unitPrice * l.qty),
                    0,
                  ) ??
                  55
                }
                fabZip={fabZip}
              />
            )}
            </ErrorBoundary>
          </div>
        </div>
      </div>

      <MetricsRail
        run={isReal && real ? { ...selectedRun, metrics: real.run.metrics } : selectedRun}
      />

      {reviseRequest !== null && selectedRun.runDir && (
        <ReviseDialog
          runId={selectedRun.id}
          runName={selectedRun.name}
          currentBlocks={null}
          initialRequest={reviseRequest || undefined}
          onLaunch={(prompt, compose, rev) => {
            setReviseRequest(null)
            handleGenerate(prompt, compose, rev)
          }}
          onClose={() => setReviseRequest(null)}
        />
      )}

      {showWelcome && !interviewRequest && (
        <WelcomeHero
          onStart={(p) => {
            localStorage.setItem('fl-welcomed', '1')
            setShowWelcome(false)
            setInterviewRequest(p || 'design a custom board')
          }}
          onExplore={() => {
            localStorage.setItem('fl-welcomed', '1')
            setShowWelcome(false)
          }}
        />
      )}

      {interviewRequest && (
        <InterviewPanel
          request={interviewRequest}
          onGenerate={handleGenerate}
          onClose={() => setInterviewRequest(null)}
        />
      )}
    </main>
  )
}
