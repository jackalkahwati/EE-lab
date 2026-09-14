'use client'

/**
 * Work queue (Phase 3) — the honest flags the pipeline produced, as an
 * actionable list. Every item traces to a real artifact field; "resolve"
 * seeds the chat with a focused prompt so the fix flows through the normal
 * engineering path (edit router → targeted re-run), never a side channel.
 */
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { ListTodo, ArrowRight, RefreshCw } from 'lucide-react'

type WorkItem = {
  id: string
  area: string
  text: string
  severity: 'blocking' | 'advisory'
  source: string
}

type Props = {
  runId?: string
  /** Seed the chat input with a focused resolution prompt. */
  onResolve?: (prompt: string) => void
}

type QueueState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: WorkItem[] }

function validItems(data: unknown): data is { items: WorkItem[] } {
  if (!data || typeof data !== 'object' || !('items' in data) || !Array.isArray(data.items)) return false
  return data.items.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false
    return 'id' in item && typeof item.id === 'string'
      && 'area' in item && typeof item.area === 'string'
      && 'text' in item && typeof item.text === 'string'
      && 'source' in item && typeof item.source === 'string'
      && 'severity' in item && (item.severity === 'blocking' || item.severity === 'advisory')
  })
}

export function WorkQueue(props: Props) {
  return props.runId ? <RunWorkQueue key={props.runId} {...props} runId={props.runId} /> : null
}

function RunWorkQueue({ runId, onResolve }: Props & { runId: string }) {
  const [state, setState] = useState<QueueState>({ status: 'loading' })
  const [retry, setRetry] = useState(0)
  const loading = useRef(true)

  useEffect(() => {
    let current = true
    const controller = new AbortController()
    loading.current = true
    setState({ status: 'loading' })
    // One read per attempt, with a deadline and no automatic retry loop.
    const timeout = setTimeout(() => {
      if (!current) return
      current = false
      controller.abort()
      loading.current = false
      setState({ status: 'error', message: 'Loading the work queue timed out. Retry when ready.' })
    }, 15_000)
    fetch(`/api/runs/work-items?run=${encodeURIComponent(runId)}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Could not load work queue (${response.status}).`)
        const data: unknown = await response.json()
        if (!validItems(data)) throw new Error('The work queue response is invalid.')
        return data.items
      })
      .then(items => {
        if (current) setState({ status: 'ready', items })
      })
      .catch((error: unknown) => {
        if (current) setState({ status: 'error', message: error instanceof Error ? error.message : 'Could not load work queue.' })
      })
      .finally(() => {
        clearTimeout(timeout)
        if (current) loading.current = false
      })
    return () => { current = false; clearTimeout(timeout); controller.abort() }
  }, [runId, retry])

  const refresh = () => {
    if (loading.current) return
    loading.current = true
    setState({ status: 'loading' })
    setRetry(value => value + 1)
  }
  const busy = state.status === 'loading'
  const items = state.status === 'ready' ? state.items : []
  const blocking = items.filter((i) => i.severity === 'blocking')
  const advisory = items.filter((i) => i.severity === 'advisory')

  return (
    <div className="border-t border-border px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <ListTodo className="size-3 text-muted-foreground" />
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
          work queue{state.status === 'ready' ? ` · ${items.length}` : ''}
        </span>
        {blocking.length > 0 && (
          <span className="rounded-full bg-destructive/15 px-1.5 font-mono text-[9px] text-destructive">
            {blocking.length} blocking
          </span>
        )}
        <button type="button" title={state.status === 'error' ? 'Retry loading work queue' : 'Refresh work queue'}
          aria-label={state.status === 'error' ? 'Retry loading work queue' : 'Refresh work queue'} onClick={refresh} disabled={busy}
          className="ml-auto rounded-sm border border-border p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50">
          <RefreshCw className={cn('size-3', busy && 'animate-spin')} />
        </button>
      </div>
      {busy && <p role="status" className="px-1.5 text-[10.5px] text-muted-foreground">Loading work queue…</p>}
      {state.status === 'error' && <p role="alert" className="px-1.5 text-[10.5px] text-destructive">{state.message} Work queue unavailable; open items are unknown.</p>}
      {state.status === 'ready' && items.length === 0 && (
        <p role="status" className="px-1.5 text-[10.5px] text-muted-foreground">
          No items reported by the work queue. Coverage is incomplete; this does not mean every engineering flag is resolved. Review the run artifacts for other gaps.
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
