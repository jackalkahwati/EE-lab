'use client'

import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import type { Run } from '@/lib/firstlight'
import { PanelLeftClose, PanelLeftOpen, CircuitBoard, GitBranch, X, Search } from 'lucide-react'
import { ProfileMenu } from '@/components/profile-menu'

type StatusFilter = 'ALL' | 'PASSED' | 'GATE FAILED' | 'RUNNING'
type SortKey = 'newest' | 'oldest' | 'name' | 'status'

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'PASSED', label: 'Pass' },
  { key: 'GATE FAILED', label: 'Fail' },
  { key: 'RUNNING', label: 'Live' },
]

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
  onDelete,
  collapsed,
  onToggleCollapsed,
}: {
  runs: Run[]
  selectedId: string
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  collapsed: boolean
  onToggleCollapsed: () => void
}) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL')
  const [sort, setSort] = useState<SortKey>('newest')

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = runs.filter((r) => {
      if (statusFilter !== 'ALL' && r.status !== statusFilter) return false
      if (!q) return true
      return (
        r.name.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        (r.prompt ?? '').toLowerCase().includes(q)
      )
    })
    // incoming order is newest-first from the API; derive the rest from it
    if (sort === 'oldest') list = [...list].reverse()
    else if (sort === 'name')
      list = [...list].sort((a, b) => a.name.localeCompare(b.name))
    else if (sort === 'status')
      list = [...list].sort(
        (a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name),
      )
    return list
  }, [runs, query, statusFilter, sort])

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
            {visible.length === runs.length
              ? runs.length
              : `${visible.length}/${runs.length}`}
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
      <div className="flex flex-col gap-1.5 border-b border-border px-2 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search runs…"
            className="w-full rounded-sm border border-border bg-background py-1 pl-6 pr-2 text-[11px] text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none"
            aria-label="Search runs by name or id"
          />
        </div>
        <div className="flex items-center gap-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setStatusFilter(f.key)}
              className={cn(
                'rounded-sm border px-1.5 py-0.5 font-mono text-[9px] leading-none transition-colors',
                statusFilter === f.key
                  ? f.key === 'GATE FAILED'
                    ? 'border-destructive/40 bg-destructive/10 text-destructive'
                    : f.key === 'PASSED'
                      ? 'border-success/40 bg-success/10 text-success'
                      : 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
              aria-pressed={statusFilter === f.key}
            >
              {f.label}
            </button>
          ))}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="ml-auto rounded-sm border border-border bg-background px-1 py-0.5 font-mono text-[9px] text-muted-foreground focus:border-primary/50 focus:outline-none"
            aria-label="Sort runs"
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="name">Name</option>
            <option value="status">Status</option>
          </select>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2" aria-label="Run history">
        <ul className="flex flex-col gap-1">
          {visible.length === 0 && (
            <li className="px-2 py-4 text-center text-[11px] text-muted-foreground">
              No runs match{query ? ` “${query}”` : ''}.
            </li>
          )}
          {visible.map((run) => (
            <li key={run.id} className="group">
              <div
                role="button"
                tabIndex={0}
                onClick={() => onSelect(run.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onSelect(run.id)
                }}
                className={cn(
                  'flex w-full cursor-pointer flex-col gap-1.5 rounded-sm border px-2.5 py-2 text-left transition-colors',
                  run.id === selectedId
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-transparent hover:border-border hover:bg-secondary',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1 truncate text-xs font-medium text-foreground">
                    {run.parentId && (
                      <GitBranch
                        className="size-3 shrink-0 text-primary"
                        aria-label="Revision of an earlier run"
                      />
                    )}
                    <span className="truncate" title={run.revNote ?? undefined}>
                      {run.name}
                    </span>
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <StatusPill status={run.status} />
                    {run.status !== 'RUNNING' && runs.length > 1 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onDelete(run.id)
                        }}
                        className="rounded-sm p-0.5 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                        aria-label={`Delete ${run.name}`}
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </div>
                </div>
                <span className="font-mono text-[10px] text-muted-foreground" title={run.id}>
                  {run.timestamp}
                </span>
                <MiniProgress run={run} />
              </div>
            </li>
          ))}
        </ul>
      </nav>
      <div className="border-t border-border px-2 py-2">
        <ProfileMenu variant="sidebar" />
      </div>
    </aside>
  )
}
