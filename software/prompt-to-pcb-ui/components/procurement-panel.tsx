'use client'

/**
 * Procurement — fab-house quote comparison (estimates) + sourcing
 * auto-substitution. Honest: fab prices are ESTIMATES from published pricing
 * (not live API quotes); substitutions are real parts / standard series or an
 * explicit "needs review". Nothing is auto-ordered — the operator picks a fab
 * (opens its real quote page) and confirms substitutions.
 */
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import type { RealBoard } from '@/lib/real-board'
import { quoteAll } from '@/lib/fab-quotes'
import { resolveSourcing } from '@/lib/part-substitutes'
import { ExternalLink, Download } from 'lucide-react'

export function ProcurementPanel({ real, runDir }: { real: RealBoard | null; runDir: string | null }) {
  const [qty, setQty] = useState(5)
  const b: any = real?.board ?? {}
  const wMm = b.boardSize?.wMm ?? 0
  const hMm = b.boardSize?.hMm ?? 0
  const layers = b.layers ?? 2

  const quotes = useMemo(
    () => (wMm && hMm ? quoteAll(wMm, hMm, layers, qty) : []),
    [wMm, hMm, layers, qty])
  const sourcing = useMemo(() => resolveSourcing(real?.bom ?? []), [real?.bom])
  const needs = sourcing.filter((s) => !s.ok)
  const packUrl = runDir ? `/api/cad-export?run=${encodeURIComponent(runDir)}&format=pack` : ''

  if (!real) return <p className="p-3 text-xs text-muted-foreground">No board loaded — pick a routed run.</p>

  const CONF: Record<string, string> = {
    'drop-in': 'text-emerald-500', series: 'text-sky-400', review: 'text-amber-500',
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto text-xs">
      {/* fab quote comparison */}
      <div className="border-b border-border">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="text-xs font-semibold">Fab quotes</span>
          <span className="font-mono text-[9px] text-muted-foreground">
            {wMm ? `${wMm}×${hMm}mm · ${layers}-layer` : 'no board size'}
          </span>
          <label className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
            qty
            <select value={qty} onChange={(e) => setQty(+e.target.value)}
              className="rounded-sm border border-border bg-background px-1 py-0.5 text-[11px]">
              {[5, 10, 25, 50, 100, 250].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          {packUrl && (
            <a href={packUrl}
              className="flex items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/20">
              <Download className="size-3" /> fab packet
            </a>
          )}
        </div>
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 border-b border-border px-3 py-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
          <span>fab</span><span className="text-right">est.</span><span className="text-right">lead</span><span className="text-right">quote</span>
        </div>
        <div className="divide-y divide-border">
          {quotes.length === 0 && <p className="px-3 py-2 text-muted-foreground">Board size unknown — can't estimate.</p>}
          {quotes.map((q, i) => (
            <div key={q.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 px-3 py-1.5">
              <span className="min-w-0">
                <span className="text-[11px] font-medium">{q.name}</span>
                <span className="ml-1.5 rounded-sm border border-border px-1 font-mono text-[8px] text-muted-foreground">{q.region}</span>
                {i === 0 && <span className="ml-1 rounded-sm bg-emerald-500/15 px-1 font-mono text-[8px] text-emerald-500">cheapest</span>}
                <span className="block truncate text-[9px] text-muted-foreground">{q.note} · min {q.minQty}</span>
              </span>
              <span className="text-right font-mono text-[11px] tabular-nums">~${q.estUsd.toFixed(2)}</span>
              <span className="text-right font-mono text-[10px] text-muted-foreground">{q.leadDays}d</span>
              <a href={q.url} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-end gap-0.5 text-[10px] text-primary hover:underline">
                open <ExternalLink className="size-2.5" />
              </a>
            </div>
          ))}
        </div>
        <p className="px-3 py-1.5 font-mono text-[9px] text-amber-500">
          estimates from published pricing — get a binding quote on the fab's site. Compose never auto-orders.
        </p>
      </div>

      {/* sourcing substitution */}
      <div>
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="text-xs font-semibold">Sourcing</span>
          <span className="font-mono text-[9px] text-muted-foreground">
            {sourcing.length - needs.length} in-stock · {needs.length} need a part
          </span>
        </div>
        <div className="divide-y divide-border">
          {needs.length === 0 && <p className="px-3 py-2 text-emerald-500">All BOM lines resolve to in-stock parts.</p>}
          {needs.map((s, i) => (
            <div key={i} className="px-3 py-1.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px]">{s.ref}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{s.part}</span>
                <span className={cn('shrink-0 font-mono text-[8px] uppercase', CONF[s.confidence ?? 'review'])}>{s.confidence}</span>
              </div>
              <div className="mt-0.5 text-[10px] text-foreground">
                → <span className={CONF[s.confidence ?? 'review']}>{s.suggest}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="px-3 py-1.5 font-mono text-[9px] text-muted-foreground">
          suggestions are real parts / standard series; a human confirms before order — never auto-swapped.
        </p>
      </div>
    </div>
  )
}
