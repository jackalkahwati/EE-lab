'use client'

/**
 * BOM workspace (Phase 4) — the BOM as a place work happens, not a printout.
 * Per line: live distributor stock/price/lead when a sourcing provider is
 * configured (honestly gated otherwise), risk chips from the line's own
 * sourcing status, a PIN action that locks the part on the product, and a
 * resolve flow for unspecified lines that seeds the chat → edit router.
 */
import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import type { BomLine } from '@/lib/firstlight'
import { Search, Download, Pin as PinIcon, ArrowRight, Loader2 } from 'lucide-react'

type Quote = {
  available: boolean
  reason?: string
  offers?: { distributor: string; stock: number | null; priceBreaks: { qty: number; usd: number }[]; leadDays: number | null; url?: string }[]
}

const UNSPECIFIED_RX = /generic|unknown|unspecified|assembly fiducial|—/i

export function BomWorkspace({ lines, runId, onResolve }: {
  lines?: BomLine[] | null
  runId?: string
  onResolve?: (prompt: string) => void
}) {
  const data = useMemo(() => lines ?? [], [lines])
  const [query, setQuery] = useState('')
  const [gated, setGated] = useState<string | null>(null)
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [pinBusy, setPinBusy] = useState<string | null>(null)
  const [pinned, setPinned] = useState<Record<string, boolean>>({})

  // One probe decides gated-vs-live; live mode then quotes the real part lines.
  useEffect(() => {
    if (!data.length) return
    let off = false
    const parts = data
      .filter((l) => l.part && !UNSPECIFIED_RX.test(l.part) && !UNSPECIFIED_RX.test(l.ref))
      .map((l) => l.part)
    const probe = parts[0] ?? 'RP2040'
    fetch(`/api/sourcing?mpn=${encodeURIComponent(probe)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then(async (d) => {
        if (off || !d) return
        if (!d.provider) { setGated(d.quote?.reason ?? 'live sourcing gated'); return }
        setGated(null)
        const next: Record<string, Quote> = { [probe]: d.quote }
        for (const mpn of [...new Set(parts)].slice(0, 8)) {
          if (mpn === probe) continue
          try {
            const q = await fetch(`/api/sourcing?mpn=${encodeURIComponent(mpn)}`, { cache: 'no-store' }).then((x) => x.json())
            next[mpn] = q.quote
          } catch { /* row shows no quote */ }
          if (off) return
        }
        setQuotes(next)
      })
      .catch(() => {})
    return () => { off = true }
  }, [data])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return data
    return data.filter((l) =>
      l.ref.toLowerCase().includes(q) || l.part.toLowerCase().includes(q) || l.lcsc.toLowerCase().includes(q))
  }, [query, data])

  async function pinLine(l: BomLine) {
    if (!runId) return
    setPinBusy(l.ref)
    try {
      const r = await fetch('/api/sourcing', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId, ref: l.ref.split(',')[0].trim(), mpn: l.part }),
      })
      const d = await r.json()
      if (d.ok) setPinned((p) => ({ ...p, [l.ref]: true }))
    } catch { /* stays unpinned */ }
    setPinBusy(null)
  }

  const exportCsv = () => {
    const header = 'Ref,Part,LCSC,Qty,Unit Price,Line Type'
    const rows = data.map((l) => `"${l.ref}","${l.part}",${l.lcsc},${l.qty},${l.unitPrice},${l.lineType}`)
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'bom.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const quoteCell = (l: BomLine) => {
    if (UNSPECIFIED_RX.test(l.part)) return null
    const q = quotes[l.part]
    if (gated) return <span className="font-mono text-[9px] text-muted-foreground">gated</span>
    if (!q) return <Loader2 className="size-3 animate-spin text-muted-foreground/50" />
    if (!q.available) return <span className="font-mono text-[9px] text-muted-foreground" title={q.reason}>no quote</span>
    const o = q.offers?.[0]
    if (!o) return null
    const p1 = o.priceBreaks?.[0]
    return (
      <span className="font-mono text-[10px] text-foreground">
        {o.stock != null ? `${o.stock.toLocaleString()} in stock` : 'stock ?'}
        {p1 ? ` · $${p1.usd}` : ''}
        {o.leadDays ? ` · ${o.leadDays}d` : ''}
      </span>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="filter refs / parts…"
            className="w-full rounded-md border border-border bg-background py-1 pl-7 pr-2 text-[12px] outline-none focus:border-primary/50" />
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">{data.length} lines</span>
        <button type="button" onClick={exportCsv}
          className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
          <Download className="size-3" /> CSV
        </button>
      </div>

      {gated && (
        <div className="border-b border-border bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          {gated}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.map((l) => {
          const unspec = UNSPECIFIED_RX.test(l.part)
          return (
            <div key={l.ref + l.part} className={cn('group flex items-center gap-3 border-b border-border/60 px-3 py-1.5',
              unspec && l.lineType !== 'buyer-furnished' && 'bg-amber-500/5')}>
              <span className="w-20 shrink-0 truncate font-mono text-[11px] text-muted-foreground">{l.ref}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{l.part}</span>
              <span className="hidden shrink-0 sm:block">{quoteCell(l)}</span>
              <span className="w-8 shrink-0 text-right font-mono text-[11px] text-muted-foreground">×{l.qty}</span>
              <span className="w-14 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                {l.unitPrice ? `$${l.unitPrice.toFixed(2)}` : '—'}
              </span>
              <span className="flex w-20 shrink-0 items-center justify-end gap-1">
                {unspec && l.lineType !== 'buyer-furnished' ? (
                  onResolve && (
                    <button type="button" title="resolve in chat"
                      onClick={() => onResolve(`Specify a real part for BOM line ${l.ref} (currently "${l.part}").`)}
                      className="flex items-center gap-0.5 rounded-sm border border-amber-500/40 px-1.5 py-0.5 font-mono text-[9px] text-amber-700 opacity-0 group-hover:opacity-100 dark:text-amber-400">
                      resolve <ArrowRight className="size-2.5" />
                    </button>
                  )
                ) : (
                  runId && (
                    pinned[l.ref] ? (
                      <span className="font-mono text-[9px] uppercase text-primary">pinned</span>
                    ) : (
                      <button type="button" title="pin this part (locks it for every regeneration)"
                        onClick={() => void pinLine(l)} disabled={pinBusy === l.ref}
                        className="rounded-sm border border-border p-0.5 text-muted-foreground opacity-0 hover:text-primary group-hover:opacity-100 disabled:opacity-50">
                        {pinBusy === l.ref ? <Loader2 className="size-3 animate-spin" /> : <PinIcon className="size-3" />}
                      </button>
                    )
                  )
                )}
              </span>
            </div>
          )
        })}
        {!filtered.length && (
          <div className="p-6 text-center text-sm text-muted-foreground">no BOM lines{query ? ' match' : ' yet — build a board first'}</div>
        )}
      </div>
    </div>
  )
}
