'use client'

/**
 * Compact pipeline strip: six steps, one line. Icon + name (+ elapsed while
 * running); tool and gate detail live in the tooltip instead of on screen.
 * A failed step shows its reason, the only text that earns space.
 */

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
        <span className="flex size-4 items-center justify-center rounded-full bg-success/15 text-success">
          <Check className="size-2.5" strokeWidth={3} />
        </span>
      )
    case 'failed':
      return (
        <span className="flex size-4 items-center justify-center rounded-full bg-destructive/15 text-destructive">
          <X className="size-2.5" strokeWidth={3} />
        </span>
      )
    case 'running':
      return (
        <span className="flex size-4 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Loader2 className="size-2.5 animate-spin" strokeWidth={3} />
        </span>
      )
    case 'blocked':
      return (
        <span className="flex size-4 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          <Lock className="size-2" />
        </span>
      )
    default:
      return (
        <span className="flex size-4 items-center justify-center rounded-full border border-border" />
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
  const failed = run.stages.find((s) => s.state === 'failed' && s.failReason)

  return (
    <div>
      <div className="flex items-center gap-1 overflow-x-auto rounded-sm border border-border bg-card px-3 py-2">
        {STAGE_DEFS.map((def, i) => {
          const stage = run.stages[i] ?? {
            id: def.id,
            state: 'pending' as const,
            elapsedMs: 0,
          }
          const isDim = stage.state === 'pending' || stage.state === 'blocked'
          const elapsed =
            stage.state === 'running' ? (liveElapsed[def.id] ?? 0) : stage.elapsedMs

          return (
            <div key={def.id} className="flex items-center">
              <div
                className={cn('flex items-center gap-1.5 px-1.5', isDim && 'opacity-45')}
                title={`${def.label}, ${def.tool} · gate: ${def.gate}${
                  stage.state === 'blocked' ? ' (blocked)' : ''
                }`}
              >
                <StageIcon stage={stage} />
                <span
                  className={cn(
                    'text-xs font-medium',
                    stage.state === 'failed' ? 'text-destructive' : 'text-foreground',
                  )}
                >
                  {def.label}
                </span>
                {stage.state === 'running' && elapsed > 0 && (
                  <span className="font-mono text-[10px] tabular-nums text-primary stage-pulse">
                    {formatElapsed(elapsed)}
                  </span>
                )}
              </div>
              {i < STAGE_DEFS.length - 1 && (
                <span className="mx-0.5 h-px w-3 shrink-0 bg-border" aria-hidden="true" />
              )}
            </div>
          )
        })}
      </div>
      {failed?.failReason && (
        <p className="mt-1.5 px-1 font-mono text-[10px] leading-snug text-destructive">
          {failed.failReason}
        </p>
      )}
    </div>
  )
}
