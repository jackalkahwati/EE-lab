'use client'

/**
 * Checks — the gate reports (placement / routing / DRC) as a single column of
 * cards, uniform with the other right-drawer panels (no internal run-list
 * sidebar). Read-only, straight from the run's real GateReport artifacts.
 */
import { cn } from '@/lib/utils'
import type { RealBoard } from '@/lib/real-board'
import { Check, X } from 'lucide-react'

export function BoardChecks({ real }: { real: RealBoard | null }) {
  const reports: any[] = real?.reports ?? []
  if (!reports.length) return <p className="p-3 text-xs text-muted-foreground">No checks — pick a routed run.</p>

  return (
    <div className="space-y-3 p-3 text-xs">
      {reports.map((r, i) => {
        const checks: any[] = r.checks ?? []
        const pass = checks.every((c) => c.pass)
        return (
          <div key={i} className="rounded-md border border-border">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{r.file}</span>
              <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[9px]',
                pass ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                  : 'border-destructive/40 bg-destructive/10 text-destructive')}>
                {pass ? 'PASS' : 'FAIL'}
              </span>
            </div>
            <div className="divide-y divide-border/60">
              {checks.map((c, j) => (
                <div key={j} className="flex items-start gap-2 px-3 py-1.5">
                  {c.pass
                    ? <Check className="mt-0.5 size-3 shrink-0 text-emerald-500" />
                    : <X className="mt-0.5 size-3 shrink-0 text-destructive" />}
                  <span className="min-w-0 flex-1">
                    <span className="text-[11px] text-muted-foreground">{c.rule}</span>
                    <span className={cn('ml-1 font-mono text-[11px]', c.pass ? 'text-emerald-500' : 'text-destructive')}>
                      {c.pass ? 'PASS' : 'FAIL'}, {c.measured}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
