'use client'

/**
 * Status bar — a 24px Cursor-style strip under the Compose workspace.
 *   LEFT   short run id · pipeline state (running stage / passed-failed-blocked
 *          counts, dot colors matching pipeline-loader)
 *   RIGHT  model tiers in play (plain strings — no server imports) · problems
 *          badge (click focuses the Terminal panel's PROBLEMS tab via callback)
 *          · elapsed clock for the active run
 *
 * Entirely prop-driven: no fetching, no store reads — the page owns the data.
 * Only the elapsed clock ticks internally (from the startedAt prop).
 */
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { PipeStatus } from '@/lib/run-pipeline'
import { AlertCircle, CheckCircle2, Timer } from 'lucide-react'

type StageMap = Record<string, { status: PipeStatus; detail?: string }>

/** run-3f2a91b4-… → 3f2a91b4 */
function shortRunId(id: string): string {
  return id.replace(/^run-/, '').slice(0, 8)
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`
}

export function StatusBar({ runId, runName, pipeline, running, tiers, problemCount, onProblemsClick, startedAt }: {
  /** the run on screen (or in flight) — shown shortened */
  runId?: string | null
  /** the board's name, so the bar reads "Desk Air Quality Monitor · dc5d77ab"
   *  rather than an eight-character id nobody can place */
  runName?: string | null
  /** the selected run's per-stage pipeline status map (pipeStatusByRun entry) */
  pipeline?: StageMap | null
  /** true while the full pipeline is in flight for this run */
  running?: boolean
  /** model tiers in play — plain display strings, resolved by the caller */
  tiers?: string[]
  /** warn+error line count from the terminal log */
  problemCount?: number
  /** focus the Terminal panel's PROBLEMS tab */
  onProblemsClick?: () => void
  /** epoch ms the active run started; drives the elapsed clock (null = hidden) */
  startedAt?: number | null
}) {
  // internal 1s tick for the elapsed clock — display only, prop-driven input
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt == null) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [startedAt])

  const stages = Object.values(pipeline ?? {})
  const counts = {
    running: stages.filter((s) => s.status === 'running').length,
    passed: stages.filter((s) => s.status === 'passed').length,
    failed: stages.filter((s) => s.status === 'failed').length,
    blocked: stages.filter((s) => s.status === 'blocked').length,
    total: stages.length,
  }
  const done = stages.length > 0 && !running && counts.running === 0
  const allClean = done && counts.failed === 0 && counts.blocked === 0

  // overall state dot — colors consistent with pipeline-loader's dotColor()
  const dot = running || counts.running > 0
    ? 'bg-primary animate-pulse'
    : counts.failed > 0 ? 'bg-red-400'
      : counts.blocked > 0 ? 'bg-amber-400'
        : allClean ? 'bg-emerald-400'
          : 'bg-muted-foreground/40'

  const problems = problemCount ?? 0

  const Dot = ({ className }: { className: string }) => (
    <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', className)} />
  )

  return (
    <div className="flex h-6 w-full shrink-0 items-center gap-3 overflow-hidden border-t border-border bg-card/50 px-2 font-mono text-[10px] text-muted-foreground">
      {/* LEFT — run + pipeline state */}
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex items-center gap-1.5">
          <Dot className={dot} />
          {runId ? (
            <span className="flex min-w-0 items-center gap-1.5" title={runName ? `${runName} · ${runId}` : runId}>
              {runName && <span className="max-w-[22ch] truncate font-sans text-foreground/90">{runName}</span>}
              <span className="text-foreground/60">{shortRunId(runId)}</span>
            </span>
          ) : <span>no run</span>}
        </span>
        {counts.total > 0 && (
          <span className="flex items-center gap-2 tabular-nums">
            {running || counts.running > 0 ? (
              <span className="text-foreground/70">
                pipeline running · {counts.passed + counts.failed + counts.blocked}/{counts.total}
              </span>
            ) : (
              <span>{allClean ? 'pipeline done' : 'pipeline stopped'}</span>
            )}
            <span className="flex items-center gap-1"><Dot className="bg-emerald-400" />{counts.passed}</span>
            {counts.failed > 0 && <span className="flex items-center gap-1"><Dot className="bg-red-400" />{counts.failed}</span>}
            {counts.blocked > 0 && <span className="flex items-center gap-1"><Dot className="bg-amber-400" />{counts.blocked}</span>}
          </span>
        )}
      </div>

      {/* RIGHT — tiers · problems · elapsed */}
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {tiers && tiers.length > 0 && (
          <span className="hidden items-center gap-1 sm:flex" title="model tiers in play">
            {tiers.map((t, i) => (
              <span key={i} className="border border-border px-1 py-px text-[9px] uppercase tracking-wide">{t}</span>
            ))}
          </span>
        )}
        <button type="button" onClick={onProblemsClick} title="open problems"
          className={cn('flex items-center gap-1 tabular-nums hover:text-foreground',
            problems > 0 ? 'text-amber-400' : 'text-muted-foreground')}>
          {problems > 0 ? <AlertCircle className="size-3" /> : <CheckCircle2 className="size-3" />}
          {problems}
        </button>
        {startedAt != null && (
          <span className="flex items-center gap-1 tabular-nums text-foreground/70" title="elapsed for the active run">
            <Timer className="size-3" />
            {fmtElapsed(now - startedAt)}
          </span>
        )}
      </div>
    </div>
  )
}
