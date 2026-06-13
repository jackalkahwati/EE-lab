'use client'

import { cn } from '@/lib/utils'
import type { Run } from '@/lib/firstlight'
import { PanelLeftClose, PanelLeftOpen, CircuitBoard } from 'lucide-react'

function StatusPill({ status }: { status: Run['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] leading-none tracking-wide',
        status === 'RUNNING' &&
          'border-primary/40 bg-primary/10 text-primary stage-pulse',
        status === 'PASSED' &&
          'border-success/40 bg-success/10 text-success',
        status === 'GATE FAILED' &&
          'border-destructive/40 bg-destructive/10 text-destructive',
      )}
    >
      {status}
    </span>
  )
}

function MiniProgress({ run }: { run: Run }) {
  return (
    <div className="flex gap-0.5" aria-hidden="true">
      {run.stages.map((s) => (
        <span
          key={s.id}
          className={cn(
            'h-1 flex-1 rounded-[1px]',
            s.state === 'passed' && 'bg-success',
            s.state === 'failed' && 'bg-destructive',
            s.state === 'running' && 'bg-primary stage-pulse',
            (s.state === 'pending' || s.state === 'blocked') && 'bg-border',
          )}
        />
      ))}
    </div>
  )
}

export function RunHistory({
  runs,
  selectedId,
  onSelect,
  collapsed,
  onToggleCollapsed,
}: {
  runs: Run[]
  selectedId: string
  onSelect: (id: string) => void
  collapsed: boolean
  onToggleCollapsed: () => void
}) {
  if (collapsed) {
    return (
      <aside className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-card py-3">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="rounded-sm p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label="Expand run history"
        >
          <PanelLeftOpen className="size-4" />
        </button>
      </aside>
    )
  }

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <CircuitBoard className="size-4 text-primary" />
          <span className="text-xs font-semibold tracking-wide text-foreground">
            RUNS
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {runs.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="rounded-sm p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label="Collapse run history"
        >
          <PanelLeftClose className="size-4" />
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto p-2" aria-label="Run history">
        <ul className="flex flex-col gap-1">
          {runs.map((run) => (
            <li key={run.id}>
              <button
                type="button"
                onClick={() => onSelect(run.id)}
                className={cn(
                  'flex w-full flex-col gap-1.5 rounded-sm border px-2.5 py-2 text-left transition-colors',
                  run.id === selectedId
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-transparent hover:border-border hover:bg-secondary',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-foreground">
                    {run.name}
                  </span>
                  <StatusPill status={run.status} />
                </div>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {run.timestamp}
                </span>
                <MiniProgress run={run} />
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="border-t border-border px-3 py-2">
        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
          firstlight v0.4.1 · gates enforced
        </p>
      </div>
    </aside>
  )
}
