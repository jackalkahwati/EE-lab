'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  SEED_RUNS,
  STAGE_DEFS,
  STAGE_PREFIX,
  type Run,
  type StageId,
  type StageState,
} from '@/lib/firstlight'
import { loadRealBoard, REAL_RUN_ID, type RealBoard } from '@/lib/real-board'
import { RunHistory } from '@/components/run-history'
import { PromptComposer } from '@/components/prompt-composer'
import { PipelineTracker } from '@/components/pipeline-tracker'
import { BoardCanvas } from '@/components/board-canvas'
import { CodeViewer } from '@/components/code-viewer'
import { BomTable } from '@/components/bom-table'
import { GatesLogs } from '@/components/gates-logs'
import { MetricsRail } from '@/components/metrics-rail'

const TABS = ['Board', 'Schematic / Code', 'BOM', 'Gates & Logs'] as const
type Tab = (typeof TABS)[number]

interface PipelineEvent {
  type: 'stage' | 'log' | 'done' | 'error'
  id?: StageId
  state?: StageState
  failReason?: string
  stage?: StageId
  text?: string
  level?: 'info' | 'ok' | 'warn' | 'err'
  status?: 'PASSED' | 'GATE FAILED'
  message?: string
}

export default function FirstLightPage() {
  const [runs, setRuns] = useState<Run[]>([SEED_RUNS[1], SEED_RUNS[0]])
  const [selectedId, setSelectedId] = useState(SEED_RUNS[0].id)
  const [collapsed, setCollapsed] = useState(false)
  const [tab, setTab] = useState<Tab>('Board')
  const [liveRunId, setLiveRunId] = useState<string | null>(null)
  const [liveElapsed, setLiveElapsed] = useState<Record<string, number>>({})
  const [realBoard, setRealBoard] = useState<RealBoard | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const stageStartRef = useRef<Record<string, number>>({})
  const currentStageRef = useRef<string | null>(null)

  // load the real board (synced from KiCad by scripts/sync-board.sh)
  useEffect(() => {
    let cancelled = false
    loadRealBoard().then((data) => {
      if (!data || cancelled) return
      setRealBoard(data)
      setRuns((prev) =>
        prev.some((r) => r.id === REAL_RUN_ID) ? prev : [data.run, ...prev],
      )
      setSelectedId(REAL_RUN_ID)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const selectedRun = runs.find((r) => r.id === selectedId) ?? runs[0]
  const isReal = selectedRun.real === true && realBoard !== null

  /** REAL pipeline: placement → routing → validation via /api/pipeline/run */
  const handleGenerate = useCallback(
    (prompt: string) => {
      const id = `run-${Date.now()}`
      const base: Run = {
        id,
        name: `FL-1 pipeline run ${new Date().toTimeString().slice(0, 5)}`,
        timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
        status: 'RUNNING',
        prompt,
        stages: STAGE_DEFS.map((d) => ({
          id: d.id,
          state: 'pending' as StageState,
          elapsedMs: 0,
        })),
        metrics: {
          netsRouted: 0,
          netsTotal: realBoard?.board.netsTotal ?? 174,
          copperDefects: 0,
          hpwl: 0,
          hpwlHistory: realBoard ? [realBoard.board.hpwlMm] : [],
          components: realBoard?.board.components ?? 172,
          bomLines: 29,
          boardSize: realBoard
            ? `${Math.round(realBoard.board.boardSize.wMm)} × ${Math.round(realBoard.board.boardSize.hMm)} mm`
            : '200 × 175 mm',
          layers: realBoard?.board.layers ?? 4,
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
      setRuns((prev) => [base, ...prev])
      setSelectedId(id)
      setLiveRunId(id)
      setTab('Gates & Logs')

      const update = (fn: (r: Run) => Run) =>
        setRuns((prev) => prev.map((r) => (r.id === id ? fn(r) : r)))

      const es = new EventSource('/api/pipeline/run')
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
        } else if (ev.type === 'done') {
          es.close()
          esRef.current = null
          setLiveRunId(null)
          setLiveElapsed({})
          update((r) => ({ ...r, status: ev.status ?? 'GATE FAILED' }))
          // refresh real artifacts synced by the run, attach to this run
          loadRealBoard().then((data) => {
            if (!data) return
            setRealBoard(data)
            setRuns((prev) =>
              prev.map((r) => {
                if (r.id === id)
                  return { ...r, real: true, metrics: data.run.metrics }
                if (r.id === REAL_RUN_ID) return data.run
                return r
              }),
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
                    text: 'pipeline stream lost — the runner needs the local dev server with KiCad + flroute installed',
                    level: 'err',
                  },
                ],
              }
            : r,
        )
      }
    },
    [realBoard],
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

  return (
    <main className="flex h-dvh overflow-hidden bg-background text-foreground">
      <RunHistory
        runs={runs}
        selectedId={selectedId}
        onSelect={setSelectedId}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((v) => !v)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-baseline gap-3">
            <h1 className="text-sm font-semibold tracking-tight text-foreground">
              FirstLight
            </h1>
            <span className="font-mono text-[10px] tracking-wide text-muted-foreground">
              {'PROMPT → PCBA · 4 STAGES · HARD GATES'}
            </span>
          </div>
          <span className="font-mono text-[10px] text-muted-foreground">
            {selectedRun.name} · {selectedRun.timestamp}
          </span>
        </header>

        <div className="flex flex-col gap-3 border-b border-border p-3">
          <PromptComposer
            onGenerate={handleGenerate}
            disabled={liveRunId !== null}
          />
          <PipelineTracker run={selectedRun} liveElapsed={liveElapsed} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div
            role="tablist"
            aria-label="Run viewport"
            className="flex border-b border-border"
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
          </div>
          <div className="min-h-0 flex-1">
            {tab === 'Board' && (
              <BoardCanvas
                run={selectedRun}
                realBoard={isReal ? realBoard?.board : null}
              />
            )}
            {tab === 'Schematic / Code' && (
              <CodeViewer
                key={isReal ? 'real' : 'seed'}
                files={isReal ? realBoard?.ato : null}
              />
            )}
            {tab === 'BOM' && <BomTable lines={isReal ? realBoard?.bom : null} />}
            {tab === 'Gates & Logs' && (
              <GatesLogs
                run={selectedRun}
                reports={isReal ? realBoard?.reports : null}
              />
            )}
          </div>
        </div>
      </div>

      <MetricsRail run={selectedRun} />
    </main>
  )
}
