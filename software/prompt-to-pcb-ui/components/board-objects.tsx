'use client'

/**
 * Objects + Inspect (the Flux right-column analog), evidence-honest.
 * Components come from the run's REAL BOM (ref groups, part, package, LCSC,
 * price, sourcing status); nets are summarised from real routing data (total +
 * the open / zone-served nets we actually track). No invented marketplace stats
 * (uses/stars/authors) — we don't have a shared library, so we don't fake one.
 */
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import type { RealBoard } from '@/lib/real-board'
import { Cpu, Search } from 'lucide-react'

// pull a package/footprint hint out of a BOM part string ("Resistor 0402",
// "QFN-56", "SOT-23", "USB-C") — display only, best-effort
function pkgOf(part: string): string {
  const m = part.match(/\b(0201|0402|0603|0805|1206|QFN-?\d+|SOT-?\d+|SOIC-?\d*|TSSOP-?\d*|DFN-?\d*|LGA-?\d*|BGA|WLCSP|USB-?C|SMA|TO-?\d+)\b/i)
  return m ? m[1].toUpperCase() : ''
}

export function BoardObjects({ real }: { real: RealBoard | null }) {
  const [sel, setSel] = useState<number | null>(null)
  const [q, setQ] = useState('')

  const bom = real?.bom ?? []
  const b: any = real?.board ?? {}
  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return bom
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => !ql || `${l.ref} ${l.part} ${l.lcsc}`.toLowerCase().includes(ql))
  }, [bom, q])

  if (!real) return <p className="p-3 text-xs text-muted-foreground">No board loaded — pick a routed run.</p>

  const line: any = sel != null ? bom[sel] : null
  const refs = line ? String(line.ref).split(/,\s*/).filter(Boolean) : []

  return (
    <div className="flex h-full flex-col text-xs">
      {/* nets summary (only what we really track) */}
      <div className="border-b border-border px-3 py-2">
        <div className="mb-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">nets</div>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px]">
          <span>{b.netsRouted ?? 0}/{b.netsTotal ?? 0} routed</span>
          {(b.unroutedNets?.length ?? 0) > 0 && <span className="text-destructive">{b.unroutedNets.length} open</span>}
          {(b.zoneServedNets?.length ?? 0) > 0 && <span className="text-amber-500">{b.zoneServedNets.length} zone-served</span>}
        </div>
        {(b.unroutedNets?.length ?? 0) > 0 && (
          <div className="mt-0.5 truncate font-mono text-[9px] text-destructive/80">open: {b.unroutedNets.slice(0, 8).join(', ')}</div>
        )}
      </div>

      {/* component list (from BOM) */}
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Search className="size-3 text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ref, part, LCSC…"
          className="w-full bg-transparent text-[11px] outline-none placeholder:text-muted-foreground" />
        <span className="font-mono text-[9px] text-muted-foreground">{bom.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && <p className="px-3 py-2 text-muted-foreground">No components.</p>}
        {rows.map(({ l, i }) => {
          const pkg = pkgOf((l as any).part)
          return (
            <button key={i} type="button" onClick={() => setSel(i)}
              className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left',
                sel === i ? 'bg-secondary' : 'hover:bg-secondary/40')}>
              <Cpu className="size-3 shrink-0 text-muted-foreground" />
              <span className="w-20 shrink-0 truncate font-mono text-[10px]">{(l as any).ref}</span>
              <span className="min-w-0 flex-1 truncate text-[11px]">{(l as any).part}</span>
              {pkg && <span className="shrink-0 rounded-sm border border-border px-1 font-mono text-[8px] text-muted-foreground">{pkg}</span>}
              {(l as any).sourcingStatus === 'generic' && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" title="generic part — needs a specific MPN" />}
            </button>
          )
        })}
      </div>

      {/* inspector */}
      {line && (
        <div className="border-t border-border bg-card/40 p-3">
          <div className="mb-1.5 flex items-center gap-2">
            <Cpu className="size-4 text-primary" />
            <span className="text-[13px] font-semibold">{line.part}</span>
            {pkgOf(line.part) && <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">{pkgOf(line.part)}</span>}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
            <Row k="Refs" v={`${refs.length} · ${refs.join(', ')}`} />
            <Row k="Qty" v={String(line.qty)} />
            <Row k="LCSC" v={line.lcsc || '—'} />
            <Row k="Unit" v={`$${Number(line.unitPrice ?? 0).toFixed(3)}`} />
            <Row k="Line total" v={`$${Number(line.lineTotal ?? 0).toFixed(2)}`} />
            <Row k="Type" v={line.lineType ?? '—'} />
          </div>
          <div className={cn('mt-2 rounded-sm px-2 py-1 font-mono text-[9px]',
            line.sourcingStatus === 'generic'
              ? 'bg-amber-500/10 text-amber-500'
              : 'bg-emerald-500/10 text-emerald-500')}>
            sourcing: {line.sourcingStatus ?? 'unknown'}
            {line.sourcingStatus === 'generic' ? ' — placeholder MPN; needs a specific part before order' : ' — specific part'}
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[8px] uppercase tracking-wide text-muted-foreground">{k}</div>
      <div className="truncate">{v}</div>
    </div>
  )
}
