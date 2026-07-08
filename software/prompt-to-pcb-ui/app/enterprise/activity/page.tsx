'use client'

/**
 * Activity feed — the org event stream (notifications), synthesized from the
 * audited action tail plus run outcomes. A recognizable "what just happened"
 * timeline; every item traces to a real audited action or a real run.
 */
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

type Any = Record<string, any>

export default function ActivityPage() {
  const [db, setDb] = useState<Any | null>(null)
  useEffect(() => {
    fetch('/api/enterprise', { cache: 'no-store' }).then((r) => r.json()).then(setDb).catch(() => {})
  }, [])

  const events = useMemo(() => {
    if (!db) return []
    const boards: Any[] = db.boards ?? []
    const bn = (id: string) => boards.find((b) => b.board_id === id)?.name ?? id
    const ev: { at: string; kind: string; tone: string; text: string }[] = []
    for (const a of db.audit_tail ?? []) {
      const denied = String(a.action).startsWith('DENIED')
      ev.push({ at: a.at, kind: denied ? 'denied' : 'audit', tone: denied ? 'red' : 'muted',
        text: `${a.actor} · ${a.action}${a.scope?.board_id ? ` · ${bn(a.scope.board_id)}` : ''}` })
    }
    for (const r of db.runs ?? []) {
      const ok = r.readiness_state === 'routed_in_sandbox'
      ev.push({ at: r.created_at, kind: 'run', tone: ok ? 'emerald' : 'amber',
        text: `run ${bn(r.board_id)} · ${r.route_evidence_state} · drc ${r.drc_state}` })
    }
    return ev.filter((e) => e.at).sort((a, b) => String(b.at).localeCompare(String(a.at)))
  }, [db])

  if (!db) return <div className="p-6 text-xs text-muted-foreground">Loading activity…</div>
  if (db.error) return <div className="p-6 text-xs text-muted-foreground">Sign in required.</div>

  const TONE: Record<string, string> = {
    emerald: 'text-emerald-500', amber: 'text-amber-500',
    red: 'text-destructive', muted: 'text-muted-foreground',
  }
  const DOT: Record<string, string> = {
    emerald: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-destructive', muted: 'bg-muted-foreground/40',
  }

  return (
    <div className="min-h-screen bg-background p-4 text-xs text-foreground">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-base font-semibold">Activity</h1>
        <span className="text-muted-foreground">{events.length} recent event(s)</span>
      </div>

      <div className="rounded-md border border-border">
        <div className="max-h-[34rem] divide-y divide-border overflow-y-auto">
          {events.length === 0 && <p className="px-3 py-3 text-muted-foreground">No recent activity.</p>}
          {events.map((e, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-1.5">
              <span className={cn('size-1.5 shrink-0 rounded-full', DOT[e.tone])} />
              <span className="w-14 shrink-0 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">{e.kind}</span>
              <span className={cn('min-w-0 flex-1 truncate text-[11px]', e.tone === 'red' ? TONE.red : 'text-foreground')}>{e.text}</span>
              <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
                {String(e.at).slice(0, 16).replace('T', ' ')}
              </span>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 text-[9px] text-muted-foreground">
        Every item traces to a real audited action or a real pipeline run —
        no synthetic notifications.
      </p>
    </div>
  )
}
