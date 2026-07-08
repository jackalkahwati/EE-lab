'use client'

/**
 * Audit log — the CloudTrail analog. Searchable, filterable view of the
 * tamper-evident (hash-chained) audit trail. DENIED actions are flagged; the
 * chain-verification status is shown so a viewer knows the log is intact.
 */
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

type Any = Record<string, any>

export default function AuditPage() {
  const [db, setDb] = useState<Any | null>(null)
  const [q, setQ] = useState('')
  const [deniedOnly, setDeniedOnly] = useState(false)
  useEffect(() => {
    fetch('/api/enterprise', { cache: 'no-store' }).then((r) => r.json()).then(setDb).catch(() => {})
  }, [])

  const rows = useMemo(() => {
    const tail: Any[] = db?.audit_tail ?? []
    const ql = q.trim().toLowerCase()
    return [...tail].reverse().filter((a) => {
      if (deniedOnly && !String(a.action).startsWith('DENIED')) return false
      if (!ql) return true
      return [a.actor, a.action, JSON.stringify(a.scope), a.note]
        .some((v) => String(v ?? '').toLowerCase().includes(ql))
    })
  }, [db, q, deniedOnly])

  if (!db) return <div className="p-6 text-xs text-muted-foreground">Loading audit log…</div>
  if (db.error) return <div className="p-6 text-xs text-muted-foreground">Sign in required.</div>

  const chainOk = db.audit_chain?.ok
  const denied = (db.audit_tail ?? []).filter((a: Any) => String(a.action).startsWith('DENIED')).length

  return (
    <div className="min-h-screen bg-background p-4 text-xs text-foreground">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-base font-semibold">Audit log</h1>
        <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[10px]',
          chainOk ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
            : 'border-destructive/40 bg-destructive/10 text-destructive')}>
          chain {chainOk ? 'verified' : 'BROKEN'}
        </span>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search actor / action / scope…"
          className="w-72 rounded-sm border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary/50"
        />
        <button
          type="button"
          onClick={() => setDeniedOnly((v) => !v)}
          className={cn('rounded-sm border px-2 py-1 font-mono text-[10px]',
            deniedOnly ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-border text-muted-foreground hover:text-foreground')}>
          DENIED only ({denied})
        </button>
        <span className="ml-auto font-mono text-[9px] text-muted-foreground">
          showing {rows.length} of last {(db.audit_tail ?? []).length} audited actions
        </span>
      </div>

      <div className="rounded-md border border-border">
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 border-b border-border px-3 py-1.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
          <span>action</span><span>scope / note</span><span className="text-right">actor · time</span>
        </div>
        <div className="max-h-[32rem] divide-y divide-border overflow-y-auto">
          {rows.length === 0 && <p className="px-3 py-3 text-muted-foreground">No matching audit entries.</p>}
          {rows.map((a, i) => {
            const isDenied = String(a.action).startsWith('DENIED')
            return (
              <div key={i} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 px-3 py-1.5">
                <span className={cn('w-48 shrink-0 truncate font-mono text-[10px]', isDenied ? 'text-destructive' : 'text-foreground')}>
                  {a.action}
                </span>
                <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                  {a.note ?? (a.scope ? Object.entries(a.scope).map(([k, v]) => `${k}=${v}`).join(' ') : '')}
                </span>
                <span className="shrink-0 text-right font-mono text-[9px] text-muted-foreground">
                  {a.actor} · {String(a.at ?? '').slice(0, 16).replace('T', ' ')}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      <p className="mt-2 text-[9px] text-muted-foreground">
        Entries are hash-chained: any edit or deletion breaks verification. API
        returns the most recent 50; full export is available to security_auditor.
      </p>
    </div>
  )
}
