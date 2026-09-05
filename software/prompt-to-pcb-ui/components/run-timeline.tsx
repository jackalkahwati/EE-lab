'use client'

/**
 * The pipeline, as the navigation.
 *
 * Compose is a build system wearing an IDE's clothes. The stages were a
 * horizontal tab strip — nine destinations plus an overflow menu, in a pane
 * that needed 736px inside 392px, so Mfg, Supply, Validation and More sat past
 * the edge behind an invisible scroll. Worse than the clipping: a tab strip is
 * a set of unrelated places, and these are not. They are an ordered pipeline
 * where each stage grounds on the one before it, and every stage has a state.
 *
 * Drawn vertically, the order and the state ARE the information: you can see
 * where the run got to and where it stopped, which is the question someone
 * watching a build actually has. Nothing is hidden, because a vertical list has
 * room the strip did not.
 *
 * This is navigation only. Clicking a stage selects it; the stage views
 * themselves are unchanged.
 */

import { cn } from '@/lib/utils'
import { Check, X, Loader2, Circle, MinusCircle, Lock } from 'lucide-react'

export type TimelineState = 'passed' | 'failed' | 'running' | 'blocked' | 'skipped' | 'pending'

export interface TimelineStage {
  key: string
  label: string
  Icon: any
  /** pipeline state for this stage, when the orchestrator has reported one */
  state?: TimelineState
  /** the orchestrator's own words — the measurement, not a restatement */
  detail?: string
  /** finished while the user was looking elsewhere */
  badged?: 'passed' | 'failed'
  /** prerequisites unmet — describe a product first */
  locked?: boolean
  /** advisory fidelity: real output, lower confidence */
  advisory?: boolean
}

function Dot({ state, locked }: { state?: TimelineState; locked?: boolean }) {
  if (locked) return <Lock className="size-3 text-muted-foreground/40" />
  if (state === 'running') return <Loader2 className="size-3.5 animate-spin text-primary" />
  if (state === 'passed') return <Check className="size-3.5 text-emerald-500" />
  if (state === 'failed') return <X className="size-3.5 text-destructive" />
  if (state === 'blocked') return <MinusCircle className="size-3.5 text-amber-500" />
  if (state === 'skipped') return <MinusCircle className="size-3 text-muted-foreground/40" />
  return <Circle className="size-2.5 text-muted-foreground/30" />
}

export function RunTimeline({
  stages, active, onSelect, className,
}: {
  stages: TimelineStage[]
  active: string
  onSelect: (key: string) => void
  className?: string
}) {
  return (
    <nav
      aria-label="Pipeline stages"
      className={cn('flex shrink-0 flex-col overflow-y-auto border-r border-border bg-card/40 py-1', className)}
    >
      {stages.map((s, i) => {
        const on = s.key === active
        const last = i === stages.length - 1
        return (
          <button
            key={s.key}
            type="button"
            disabled={s.locked}
            onClick={() => onSelect(s.key)}
            aria-current={on ? 'step' : undefined}
            title={s.locked ? `${s.label} — describe a product first` : s.detail || s.label}
            className={cn(
              'relative flex w-full items-start gap-2 px-2.5 py-1.5 text-left',
              on ? 'bg-background' : 'hover:bg-accent/40',
              s.locked && 'cursor-not-allowed opacity-45',
            )}
          >
            {/* the spine: what makes this a sequence rather than a menu */}
            <span aria-hidden className="relative flex w-4 shrink-0 justify-center pt-0.5">
              {!last && (
                <span className="absolute left-1/2 top-4 h-[calc(100%+0.375rem)] w-px -translate-x-1/2 bg-border" />
              )}
              <span className="relative z-10 grid size-4 place-items-center rounded-full bg-card">
                <Dot state={s.state} locked={s.locked} />
              </span>
            </span>

            {on && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}

            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <s.Icon className={cn('size-3.5 shrink-0', on ? 'text-primary' : 'text-muted-foreground')} />
                <span className={cn('min-w-0 truncate text-[11.5px]', on ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                  {s.label}
                </span>
                {s.badged && (
                  <span
                    aria-hidden
                    className={cn('size-1.5 shrink-0 rounded-full', s.badged === 'failed' ? 'bg-red-500' : 'bg-primary')}
                  />
                )}
                {s.advisory && (
                  /* a dot, not a word: the label is the information and the
                     badge was eating it ("Mechan… ADV", "Simulati… ADV") */
                  <span
                    aria-label="advisory fidelity"
                    title="advisory fidelity — real output, lower confidence"
                    className="ml-auto size-1 shrink-0 rounded-full bg-muted-foreground/50"
                  />
                )}
              </span>
              {/* The stage's own reported measurement. A build system's
                  navigation should tell you what happened without a click. */}
              {s.detail && (
                <span className="min-w-0 truncate pl-5 font-mono text-[9.5px] leading-tight text-muted-foreground/80">
                  {s.detail}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
