'use client'

/**
 * Budgets & alerts — per-program credit budgets vs consumption, threshold
 * alerts, and cost allocation by board tag. Credits only; fab dollars remain
 * $0 until real orders exist (see Cost & Usage). No spend is implied.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { EnterpriseNav } from '@/components/enterprise-nav'

type Any = Record<string, any>
const WARN = 0.8

export default function BudgetsPage() {
  const [db, setDb] = useState<Any | null>(null)
  useEffect(() => {
    fetch('/api/enterprise', { cache: 'no-store' }).then((r) => r.json()).then(setDb).catch(() => {})
  }, [])
  if (!db) return <div className="p-6 text-xs text-muted-foreground">Loading budgets…</div>
  if (db.error) return <div className="p-6 text-xs text-muted-foreground">Sign in required.</div>

  const programs: Any[] = db.programs ?? []
  const boards: Any[] = db.boards ?? []
  const usage: Any[] = db.usage ?? []

  const progRows = programs.map((p) => {
    const alloc = p.budget?.credits_allocated ?? 0
    const used = p.budget?.credits_consumed ?? 0
    const pct = alloc ? used / alloc : 0
    return { p, alloc, used, pct, state: pct >= 1 ? 'over' : pct >= WARN ? 'warn' : 'ok' }
  })

  // cost allocation by board tag
  const usageByBoard = usage.reduce((m: Record<string, number>, u) => {
    if (u.board_id) m[u.board_id] = (m[u.board_id] || 0) + u.credits; return m
  }, {})
  const byTag: Record<string, number> = {}
  boards.forEach((b) => {
    const c = usageByBoard[b.board_id] || 0
    ;(b.tags ?? ['untagged']).forEach((t: string) => { byTag[t] = (byTag[t] || 0) + c })
  })
  const tagMax = Math.max(1, ...Object.values(byTag))

  const TONE: Record<string, string> = { over: 'text-destructive', warn: 'text-amber-500', ok: 'text-emerald-500' }
  const BAR: Record<string, string> = { over: 'bg-destructive', warn: 'bg-amber-500', ok: 'bg-primary' }

  return (
    <div className="min-h-screen bg-background p-4 text-xs text-foreground">
      <div className="mb-3 flex items-center gap-3">
        <Link href="/enterprise" className="text-muted-foreground hover:text-foreground">← Programs</Link>
        <h1 className="text-base font-semibold">Budgets &amp; alerts</h1>
      </div>
      <EnterpriseNav />

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="rounded-md border border-border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-semibold">Program budgets (credits)</span>
            <span className="ml-auto font-mono text-[9px] text-muted-foreground">alert at {WARN * 100}% of allocation</span>
          </div>
          <div className="divide-y divide-border">
            {progRows.map(({ p, alloc, used, pct, state }) => (
              <div key={p.program_id} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{p.name}</span>
                  {state !== 'ok' && (
                    <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[9px]',
                      state === 'over' ? 'border-destructive/40 bg-destructive/10 text-destructive'
                        : 'border-amber-500/40 bg-amber-500/10 text-amber-500')}>
                      {state === 'over' ? 'OVER BUDGET' : 'nearing limit'}
                    </span>
                  )}
                  <span className={cn('shrink-0 font-mono text-[11px] tabular-nums', TONE[state])}>
                    {used}/{alloc}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className={cn('h-full rounded-full', BAR[state])} style={{ width: `${Math.min(100, pct * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-semibold">Cost allocation by tag</div>
          <div className="space-y-1.5 p-3">
            {Object.entries(byTag).sort((a, b) => b[1] - a[1]).map(([t, c]) => (
              <div key={t}>
                <div className="flex items-center justify-between text-[10px]">
                  <span className="font-mono text-muted-foreground">{t}</span>
                  <span className="font-mono">{c} cr</span>
                </div>
                <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary/70" style={{ width: `${(c / tagMax) * 100}%` }} />
                </div>
              </div>
            ))}
            {!Object.keys(byTag).length && <p className="text-muted-foreground">No tagged usage.</p>}
          </div>
          <p className="border-t border-border px-3 py-2 text-[9px] text-muted-foreground">
            Tags are set per board; credits are attributed to every tag on the
            consuming board. Fab dollars: $0 (nothing ordered).
          </p>
        </div>
      </div>
    </div>
  )
}
