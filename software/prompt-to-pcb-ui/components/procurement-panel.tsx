'use client'

/**
 * Procurement — fab-house quote comparison (estimates) + real sourced components
 * + sourcing auto-substitution. Honest: fab prices are ESTIMATES from published
 * pricing (not live API quotes); the Components table shows the REAL distributor
 * data captured when the BOM was sourced (MPN / stock / unit price), and "Refresh
 * live" re-queries the Nexar (Octopart) API for fresh numbers — but only when a
 * distributor key is configured, otherwise it says so instead of faking. Nothing
 * is auto-ordered — the operator picks a fab and confirms substitutions.
 */
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import type { RealBoard } from '@/lib/real-board'
import { quoteAll } from '@/lib/fab-quotes'
import { resolveSourcing } from '@/lib/part-substitutes'
import { ExternalLink, Download, RefreshCw } from 'lucide-react'

type Live = {
  found?: boolean
  stock?: number
  priceUsd?: number | null
  seller?: string | null
  manufacturer?: string
  alternates?: string[]
  error?: string
}

export function ProcurementPanel({ real, runDir }: { real: RealBoard | null; runDir: string | null }) {
  const [qty, setQty] = useState(5)
  const [live, setLive] = useState<Record<string, Live>>({})
  const [liveState, setLiveState] = useState<'idle' | 'loading' | 'unconfigured' | 'done' | 'error'>('idle')
  const [liveNote, setLiveNote] = useState('')

  const b: any = real?.board ?? {}
  const wMm = b.boardSize?.wMm ?? 0
  const hMm = b.boardSize?.hMm ?? 0
  const layers = b.layers ?? 2

  const quotes = useMemo(
    () => (wMm && hMm ? quoteAll(wMm, hMm, layers, qty) : []),
    [wMm, hMm, layers, qty])
  const sourcing = useMemo(() => resolveSourcing(real?.bom ?? []), [real?.bom])
  const needs = sourcing.filter((s) => !s.ok)

  // real components with a captured distributor MPN (these can be live-refreshed)
  const sourced = useMemo(
    () => (real?.bom ?? []).filter((l: any) => l.sourcedMpn),
    [real?.bom])
  const packUrl = runDir ? `/api/cad-export?run=${encodeURIComponent(runDir)}&format=pack` : ''

  async function refreshLive() {
    const mpns = [...new Set(sourced.map((l: any) => l.sourcedMpn).filter(Boolean))]
    if (!mpns.length) return
    setLiveState('loading'); setLiveNote('')
    try {
      const res = await fetch('/api/component-lookup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mpns }),
      })
      const j = await res.json()
      if (j.configured === false) { setLiveState('unconfigured'); setLiveNote(j.note ?? ''); return }
      if (!Array.isArray(j.results)) { setLiveState('error'); setLiveNote(j.detail ?? j.error ?? 'lookup failed'); return }
      const map: Record<string, Live> = {}
      for (const r of j.results) if (r?.mpn) map[r.mpn] = r
      setLive(map); setLiveState('done')
    } catch (e: any) {
      setLiveState('error'); setLiveNote(String(e?.message ?? e).slice(0, 120))
    }
  }

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

      {/* real sourced components + live refresh */}
      {sourced.length > 0 && (
        <div className="border-b border-border">
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="text-xs font-semibold">Components</span>
            <span className="font-mono text-[9px] text-muted-foreground">
              {sourced.length} sourced {liveState === 'done' ? '· live' : '· as captured'}
            </span>
            <button onClick={refreshLive} disabled={liveState === 'loading'}
              className="ml-auto flex items-center gap-1 rounded-sm border border-border px-2 py-0.5 text-[10px] hover:bg-muted disabled:opacity-50">
              <RefreshCw className={cn('size-3', liveState === 'loading' && 'animate-spin')} /> Refresh live
            </button>
          </div>
          <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 border-b border-border px-3 py-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
            <span>ref</span><span>mpn</span><span className="text-right">stock</span><span className="text-right">unit</span>
          </div>
          <div className="divide-y divide-border">
            {sourced.map((l: any, i: number) => {
              const lv = live[l.sourcedMpn]
              const isLive = liveState === 'done' && lv?.found
              const stock = isLive ? lv!.stock : l.stock
              const price = isLive ? lv!.priceUsd : l.unitPrice
              return (
                <div key={i} className="grid grid-cols-[auto_1fr_auto_auto] items-baseline gap-x-3 px-3 py-1.5">
                  <span className="font-mono text-[10px] text-muted-foreground">{String(l.ref).split(/[,…]/)[0]}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-[11px]">{l.sourcedMpn}
                      {isLive && <span className="ml-1 rounded-sm bg-emerald-500/15 px-1 font-mono text-[8px] text-emerald-500">live</span>}
                    </span>
                    <span className="block truncate text-[9px] text-muted-foreground">{l.part}
                      {isLive && lv?.seller ? ` · ${lv.seller}` : l.lcsc && l.lcsc !== '—' ? ` · LCSC ${l.lcsc}` : ''}</span>
                    {isLive && lv?.alternates?.length ? (
                      <span className="block truncate text-[9px] text-sky-400">alt: {lv.alternates.join(', ')}</span>
                    ) : null}
                  </span>
                  <span className={cn('text-right font-mono text-[11px] tabular-nums',
                    (stock ?? 0) > 0 ? 'text-emerald-500' : 'text-muted-foreground')}>
                    {stock != null ? Number(stock).toLocaleString() : '—'}
                  </span>
                  <span className="text-right font-mono text-[11px] tabular-nums">
                    {price != null ? `$${Number(price).toFixed(price < 1 ? 3 : 2)}` : '—'}
                  </span>
                </div>
              )
            })}
          </div>
          <p className="px-3 py-1.5 font-mono text-[9px] text-muted-foreground">
            {liveState === 'unconfigured'
              ? <span className="text-amber-500">{liveNote || 'live lookup not configured — add a Nexar key in .env.local'}</span>
              : liveState === 'error'
              ? <span className="text-red-400">live lookup failed: {liveNote}</span>
              : liveState === 'done'
              ? 'live stock + pricing from Nexar (Octopart). Nothing ordered.'
              : 'stock + price as captured when the BOM was sourced — Refresh live for current numbers.'}
          </p>
        </div>
      )}

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
