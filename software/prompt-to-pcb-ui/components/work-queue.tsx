'use client'

/**
 * Work queue (Phase 3) — the honest flags the pipeline produced, as an
 * actionable list. Every item traces to a real artifact field; "resolve"
 * seeds the chat with a focused prompt so the fix flows through the normal
 * engineering path (edit router → targeted re-run), never a side channel.
 */
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { ListTodo, ArrowRight, RefreshCw } from 'lucide-react'

type WorkItem = {
  id: string
  area: string
  text: string
  severity: 'blocking' | 'advisory'
  source: string
}

export function WorkQueue({ runId, onResolve }: {
  runId?: string
  /** Seed the chat input with a focused resolution prompt. */
  onResolve?: (prompt: string) => void
}) {
  const [items, setItems] = useState<WorkItem[] | null>(null)
  const [busy, setBusy] = useState(false)

  const load = (id: string) => {
    setBusy(true)
    fetch(`/api/runs/work-items?run=${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setItems(Array.isArray(d?.items) ? d.items : []))
      .catch(() => setItems([]))
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    setItems(null)
    if (runId) load(runId)
  }, [runId])

  if (!runId || items === null) return null

  const blocking = items.filter((i) => i.severity === 'blocking')
  const advisory = items.filter((i) => i.severity === 'advisory')

  return (
    <div className="border-t border-border px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <ListTodo className="size-3 text-muted-foreground" />
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
          work queue · {items.length}
        </span>
        {blocking.length > 0 && (
          <span className="rounded-full bg-destructive/15 px-1.5 font-mono text-[9px] text-destructive">
            {blocking.length} blocking
          </span>
        )}
        <button type="button" title="re-harvest" onClick={() => load(runId)} disabled={busy}
          className="ml-auto rounded-sm border border-border p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50">
          <RefreshCw className={cn('size-3', busy && 'animate-spin')} />
        </button>
      </div>
      {items.length === 0 && (
        <p className="px-1.5 text-[10.5px] text-muted-foreground">
          No open items — every flag the pipeline raised has been resolved.
        </p>
      )}
      <div className="space-y-1">
        {[...blocking, ...advisory].slice(0, 12).map((it) => (
          <div key={it.id} className={cn('group rounded-sm border px-2 py-1.5',
            it.severity === 'blocking' ? 'border-destructive/30 bg-destructive/5' : 'border-border bg-card/40')}>
            <div className="flex items-start gap-1.5">
              <span className={cn('mt-0.5 shrink-0 font-mono text-[8px] uppercase',
                it.severity === 'blocking' ? 'text-destructive' : 'text-muted-foreground')}>
                {it.area}
              </span>
              <span className="min-w-0 flex-1 text-[11px] leading-snug text-foreground">{it.text}</span>
              {onResolve && (
                <button
                  type="button"
                  title="resolve in chat"
                  onClick={() => onResolve(`Resolve this open item on the current design: ${it.text}`)}
                  className="shrink-0 rounded-sm border border-border p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
                >
                  <ArrowRight className="size-3" />
                </button>
              )}
            </div>
            <div className="mt-0.5 truncate pl-0 font-mono text-[8.5px] text-muted-foreground/70">{it.source}</div>
          </div>
        ))}
        {items.length > 12 && (
          <div className="px-1.5 text-[10px] text-muted-foreground">+ {items.length - 12} more</div>
        )}
      </div>
    </div>
  )
}
