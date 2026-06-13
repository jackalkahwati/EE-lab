'use client'

import { cn } from '@/lib/utils'
import {
  STAGE_DEFS,
  formatElapsed,
  type Run,
  type StageStatus,
} from '@/lib/firstlight'
import { Check, X, Lock, Loader2 } from 'lucide-react'

function StageIcon({ stage }: { stage: StageStatus }) {
  switch (stage.state) {
    case 'passed':
      return (
        <span className="flex size-5 items-center justify-center rounded-full bg-success/15 text-success">
          <Check className="size-3" strokeWidth={3} />
        </span>
      )
    case 'failed':
      return (
        <span className="flex size-5 items-center justify-center rounded-full bg-destructive/15 text-destructive">
          <X className="size-3" strokeWidth={3} />
        </span>
      )
    case 'running':
      return (
        <span className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Loader2 className="size-3 animate-spin" strokeWidth={3} />
        </span>
      )
    case 'blocked':
      return (
        <span
          className="flex size-5 items-center justify-center rounded-full bg-secondary text-muted-foreground"
          title="blocked by gate"
        >
          <Lock className="size-2.5" />
        </span>
      )
    default:
      return (
        <span className="flex size-5 items-center justify-center rounded-full border border-border text-muted-foreground" />
      )
  }
}

export function PipelineTracker({
  run,
  liveElapsed,
}: {
  run: Run
  liveElapsed: Partial<Record<string, number>>
}) {
  return (
    <div className="grid grid-cols-4 gap-px overflow-hidden rounded-sm border border-border bg-border">
      {STAGE_DEFS.map((def, i) => {
        const stage = run.stages[i]
        const isDim = stage.state === 'pending' || stage.state === 'blocked'
        const elapsed =
          stage.state === 'running'
            ? (liveElapsed[def.id] ?? 0)
            : stage.elapsedMs

        return (
          <div
            key={def.id}
            className={cn(
              'flex flex-col gap-2 bg-card p-3',
              isDim && 'opacity-50',
              stage.state === 'failed' && 'bg-destructive/5',
            )}
            title={stage.state === 'blocked' ? 'blocked by gate' : undefined}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <StageIcon stage={stage} />
                <div className="flex flex-col">
                  <span className="text-xs font-semibold leading-tight text-foreground">
                    {i + 1}. {def.label}
                  </span>
                  <span className="font-mono text-[10px] leading-tight text-muted-foreground">
                    {def.tool}
                  </span>
                </div>
              </div>
              {(stage.state === 'running' ||
                stage.state === 'passed' ||
                stage.state === 'failed') &&
                elapsed > 0 && (
                  <span
                    className={cn(
                      'font-mono text-[10px] tabular-nums',
                      stage.state === 'running'
                        ? 'text-primary stage-pulse'
                        : 'text-muted-foreground',
                    )}
                  >
                    {formatElapsed(elapsed)}
                  </span>
                )}
            </div>

            <div className="flex flex-wrap gap-1">
              {def.substeps.map((sub) => (
                <span
                  key={sub}
                  className="rounded-sm border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground"
                >
                  {sub}
                </span>
              ))}
            </div>

            <div className="mt-auto">
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] leading-none tracking-wide',
                  stage.state === 'passed' &&
                    'border-success/40 bg-success/10 text-success',
                  stage.state === 'failed' &&
                    'border-destructive/40 bg-destructive/10 text-destructive',
                  stage.state === 'running' &&
                    'border-primary/40 bg-primary/10 text-primary stage-pulse',
                  isDim && 'border-border bg-secondary text-muted-foreground',
                )}
              >
                GATE: {def.gate}
                {stage.state === 'passed' && ' ✓'}
              </span>
              {stage.state === 'failed' && stage.failReason && (
                <p className="mt-1.5 font-mono text-[10px] leading-snug text-destructive">
                  {stage.failReason}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
